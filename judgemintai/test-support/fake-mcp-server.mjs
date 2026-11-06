// A stand-in for PayPal's MCP server (@paypal/mcp), used only by the automated tests (test/toolkit.test.js).
// It lives outside test/ on purpose: Node's test runner executes every file inside a folder called test.
//
// It speaks the real protocol (JSON-RPC lines over stdio), offers the same tool names and argument rules as the real
// create_order / get_order / pay_order tools, honours the --tools flag, and calls the local sandbox stand-in over HTTP
// with the access token it was started with, exactly as the real server calls PayPal.
//
// FAKE_MCP_MODE picks a behaviour: ok | reject-narrow | slow-start | lie | crash-after-capture | hang | wrong-amount | noisy
// FAKE_MCP_ERRORS=detailed makes pay_order errors carry PayPal's reason (the real server only says "Failed to capture order").
import fs from 'node:fs';
import readline from 'node:readline';

const BASE = process.env.FAKE_MCP_PP_BASE;
const TOKEN = process.env.PAYPAL_ACCESS_TOKEN;
const MODE = process.env.FAKE_MCP_MODE || 'ok';
const DETAILED = process.env.FAKE_MCP_ERRORS === 'detailed';
const LOG = process.env.FAKE_MCP_LOG;

const log = (entry) => { if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`); };

// ---- the --tools flag ----
const toolsArg = (process.argv.find((a) => a.startsWith('--tools=')) || '--tools=all').slice('--tools='.length);
const allowed = toolsArg === 'all' ? null : new Set(toolsArg.split(','));
if (MODE === 'reject-narrow' && allowed) {
  console.error(`Invalid tools argument "${toolsArg}": accepted values are all`);
  process.exit(1);
}
const PERMISSION = { create_order: 'orders.create', get_order: 'orders.get', pay_order: 'orders.capture' };
const offered = Object.keys(PERMISSION)
  .filter((name) => !allowed || allowed.has(PERMISSION[name]))
  .map((name) => ({ name, description: `${name} (test double)`, inputSchema: { type: 'object' } }));

log({
  event: 'start', argv: process.argv.slice(2), toolsArg, offered: offered.map((t) => t.name),
  envNames: Object.keys(process.env), paypalEnvironment: process.env.PAYPAL_ENVIRONMENT, tokenIsSandboxToken: TOKEN === 'sandbox-token',
});

// ---- argument rules of create_order (same shape as the real tool) ----
class InvalidParams extends Error {}
function checkCreateOrder(a) {
  const need = (ok, what) => { if (!ok) throw new InvalidParams(`Invalid arguments for tool create_order: ${what}`); };
  need(a.currencyCode === 'USD', 'currencyCode must be "USD"');
  need(Array.isArray(a.items) && a.items.length >= 1 && a.items.length <= 50, 'items must hold 1 to 50 line items');
  for (const i of a.items) {
    need(typeof i.name === 'string' && i.name.length > 0, 'item name is required');
    need(typeof i.quantity === 'number' && i.quantity >= 1, 'item quantity must be a number');
    need(typeof i.itemCost === 'number', 'item itemCost must be a number');
    need(typeof i.itemTotal === 'number', 'item itemTotal must be a number');
    need(i.taxPercent === undefined || typeof i.taxPercent === 'number', 'item taxPercent must be a number');
  }
  need(a.returnUrl === undefined || /^https?:\/\//.test(a.returnUrl), 'returnUrl must be a URL');
  need(a.cancelUrl === undefined || /^https?:\/\//.test(a.cancelUrl), 'cancelUrl must be a URL');
}

async function paypal(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
// Like the real server: a PayPal problem comes back as ordinary text holding an error object.
const paypalError = (message) => text({ error: { message, type: 'paypal_error' } });

async function createOrder(a) {
  checkCreateOrder(a);
  const items = a.items;
  const itemTotal = items.reduce((sum, i) => sum + i.itemTotal, 0);
  const total = (MODE === 'wrong-amount' ? 0.01 : itemTotal).toFixed(2);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: a.currencyCode,
        value: total,
        breakdown: { item_total: { currency_code: a.currencyCode, value: itemTotal.toFixed(2) } },
      },
      items: items.map((i) => ({ name: i.name, description: i.description, quantity: String(i.quantity), unit_amount: { currency_code: a.currencyCode, value: i.itemCost.toFixed(2) } })),
    }],
    // the real tool always sends these two addresses
    payment_source: { paypal: { experience_context: { return_url: a.returnUrl || 'https://example.com/returnUrl', cancel_url: a.cancelUrl || 'https://example.com/cancelUrl' } } },
  };
  const r = await paypal('POST', '/v2/checkout/orders', body);
  return r.ok ? text(r.data) : paypalError(`PayPal answered an error: ${JSON.stringify(r.data)}`);
}

async function payOrder(a) {
  if (MODE === 'lie') return text({ status: 'success', response: { id: a.id, status: 'COMPLETED' } }); // claims success, captures nothing
  if (MODE === 'hang') return new Promise(() => {}); // never answers
  const r = await paypal('POST', `/v2/checkout/orders/${a.id}/capture`, {});
  if (MODE === 'crash-after-capture') process.exit(1); // PayPal captured, but this server dies before it can say so
  if (!r.ok) return paypalError(DETAILED ? JSON.stringify(r.data) : 'Failed to capture order');
  return text({ status: 'success', response: r.data });
}

async function getOrder(a) {
  const r = await paypal('GET', `/v2/checkout/orders/${a.id}`);
  return r.ok ? text(r.data) : paypalError(`PayPal answered an error: ${JSON.stringify(r.data)}`);
}

async function handleCall(msg) {
  const { name, arguments: args = {} } = msg.params || {};
  log({ event: 'call', tool: name, args });
  if (!offered.some((t) => t.name === name)) return fail(msg.id, -32602, `Tool ${name} not found`);
  try {
    const result = name === 'create_order' ? await createOrder(args) : name === 'pay_order' ? await payOrder(args) : await getOrder(args);
    return reply(msg.id, result);
  } catch (err) {
    if (err instanceof InvalidParams) return fail(msg.id, -32602, err.message);
    return fail(msg.id, -32603, err.message);
  }
}

// "noisy": print a startup banner that is not protocol traffic, and ask the app a ping of our own.
if (MODE === 'noisy') process.stdout.write('PayPal MCP Server running on stdio\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0)); // the app closed our stdin: stop (the real server may linger, so the app also kills it)
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) {
    // an answer to something we asked
    if (msg.id === 'srv-ping') log({ event: 'ping-answered', ok: msg.result !== undefined });
    return;
  }
  if (msg.method === 'initialize') {
    if (MODE === 'slow-start') await new Promise((r) => setTimeout(r, Number(process.env.FAKE_MCP_DELAY_MS || 2500)));
    return reply(msg.id, { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'PayPal', version: 'test' } });
  }
  if (msg.method === 'notifications/initialized') {
    log({ event: 'initialized' });
    if (MODE === 'noisy') process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' })}\n`);
    return undefined;
  }
  if (msg.method === 'tools/list') return reply(msg.id, { tools: offered });
  if (msg.method === 'tools/call') return handleCall(msg);
  if (msg.method === 'ping') return reply(msg.id, {});
  if (msg.id !== undefined) return fail(msg.id, -32601, 'Method not found');
  return undefined;
});
