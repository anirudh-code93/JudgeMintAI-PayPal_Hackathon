// Tests for the PayPal AI Toolkit route (MCP). The real server (npx @paypal/mcp) needs the internet, so these tests
// start test-support/fake-mcp-server.mjs instead. It speaks the same protocol and calls the local sandbox stand-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakes, walk, commitsOver } from './fakes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_MCP = path.join(ROOT, 'test-support', 'fake-mcp-server.mjs'); // outside test/, because Node's test runner would execute every file inside test/
let fakes;
let app;
let base;
let dataDir;
let logFile;
let toolkit;
let paypal;

before(async () => {
  fakes = await startFakes({ repos: { 'jm/self': { description: 'JudgeMintAI', license: 'MIT', files: walk(ROOT), commits: commitsOver(8, 12) } } });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-toolkit-'));
  logFile = path.join(dataDir, 'mcp-log.jsonl');
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    GITHUB_API_BASE: `${fakes.base}/gh`,
    GITHUB_RAW_BASE: `${fakes.base}/raw`,
    PAYPAL_API_BASE: `${fakes.base}/pp`,
    YOUTUBE_OEMBED_BASE: `${fakes.base}/yt/oembed`,
    PAYPAL_CLIENT_ID: 'test-id',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    CERT_SECRET: 'unit-test-secret',
    GITHUB_TOKEN: 'test-gh-token', // present on purpose: the toolkit process must NOT receive it
    LLM_API_KEY: '',
    ALLOW_PRIVATE_URLS: 'true',
    AUDIT_RATE_LIMIT_PER_HOUR: '1000',
    PUBLIC_URL: 'https://judgemint.example',
    FAKE_MCP_PP_BASE: `${fakes.base}/pp`,
    FAKE_MCP_LOG: logFile,
  });
  toolkit = await import('../src/paypalToolkit.js');
  paypal = await import('../src/paypal.js');
  const { createServer } = await import('../server.js');
  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  toolkit.closeToolkit();
  const { flushNow } = await import('../src/store.js');
  flushNow();
  await new Promise((r) => app.close(r));
  await fakes.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// A fresh situation for each test: stop any running toolkit, clear the logs, pick a mode and a behaviour.
function scenario(env = {}) {
  toolkit.closeToolkit();
  fs.rmSync(logFile, { force: true });
  fakes.state.calls.length = 0;
  const defaults = {
    PAYPAL_VIA: 'toolkit',
    FAKE_MCP_MODE: 'ok',
    FAKE_MCP_ERRORS: '',
    FAKE_MCP_DELAY_MS: '',
    PAYPAL_MCP_COMMAND: process.execPath,
    PAYPAL_MCP_ARGS: JSON.stringify([FAKE_MCP, '--tools={tools}']),
    PAYPAL_TOOLKIT_WAIT_MS: '8000',
    PAYPAL_TOOLKIT_CALL_MS: '5000',
  };
  for (const [name, value] of Object.entries({ ...defaults, ...env })) process.env[name] = value;
}

const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const captureCalls = () => fakes.state.calls.filter((c) => c.endsWith('/capture')).length;

async function api(p, opts = {}) {
  const res = await fetch(base + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function runAudit(body) {
  const r = await api('/api/audits', { method: 'POST', body });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  for (let i = 0; i < 100; i++) {
    const a = await api(`/api/audits/${r.body.id}`);
    if (a.body.status === 'complete' || a.body.status === 'error') return a.body;
    await new Promise((s) => setTimeout(s, 100));
  }
  throw new Error('audit timed out');
}

const GOOD_INPUT = () => ({
  projectName: 'JudgeMintAI',
  repoUrl: 'https://github.com/jm/self',
  demoUrl: `${fakes.base}/demo`,
  videoUrl: 'https://www.youtube.com/watch?v=goodvid0001',
  description: 'JudgeMintAI audits hackathon submissions with five AI agents. It verifies the PayPal sandbox integration is real, checks the licence, video and rules, and lets the PayPal sandbox sell a signed verification certificate. '.repeat(2),
  toolsUsed: 'AG Grid, Render, Zapier, Elastic, Postman, PayPal Orders v2 sandbox',
  hackathonStart: '2026-10-01',
});

const create = (id) => api(`/api/audits/${id}/pay/create`, { method: 'POST' });
const capture = (id, orderId) => api(`/api/audits/${id}/pay/capture`, { method: 'POST', body: { orderId } });
const paymentOf = async (id) => (await api(`/api/audits/${id}`)).body.payment;

test('toolkit route: create_order and pay_order run in the MCP server, our server verifies, the certificate is issued', async () => {
  scenario();
  const a = await runAudit(GOOD_INPUT());
  const created = await create(a.id);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const orderId = created.body.orderId;

  // how the MCP server was started: least-privilege tools, sandbox only, and none of our secrets
  const entries = readLog();
  const started = entries.find((e) => e.event === 'start');
  assert.equal(started.toolsArg, 'orders.create,orders.capture');
  assert.deepEqual(started.offered, ['create_order', 'pay_order']);
  assert.equal(started.tokenIsSandboxToken, true);
  assert.equal(started.paypalEnvironment, 'SANDBOX');
  for (const name of ['PAYPAL_CLIENT_SECRET', 'CERT_SECRET', 'LLM_API_KEY', 'GITHUB_TOKEN']) {
    assert.ok(!started.envNames.includes(name), `${name} must not reach the toolkit process`);
  }

  // what we asked it to do
  const call = entries.find((e) => e.event === 'call' && e.tool === 'create_order');
  assert.equal(call.args.currencyCode, 'USD');
  assert.equal(call.args.items.length, 1);
  assert.equal(call.args.items[0].itemTotal, 2);
  assert.equal(call.args.returnUrl, `https://judgemint.example/a/${a.id}`);
  const placed = fakes.order(orderId).body;
  assert.equal(placed.purchase_units[0].custom_id, undefined, 'the toolkit cannot tag orders, so the order id is stored on the audit instead');
  assert.ok(placed.payment_source.paypal.experience_context.return_url);
  assert.equal((await paymentOf(a.id)).via.create, 'toolkit');

  // capture before the buyer approved: refused (toolkit-only mode has no safety net)
  const early = await capture(a.id, orderId);
  assert.equal(early.status, 502);
  assert.match(early.body.error, /pay_order failed: Failed to capture order/);

  // approve, then capture
  fakes.approve(orderId);
  const done = await capture(a.id, orderId);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.body.certificate.serial, /^JM-[A-F0-9]{12}$/);
  assert.deepEqual((await paymentOf(a.id)).via, { create: 'toolkit', capture: 'toolkit' });
  assert.ok(fakes.state.calls.includes(`GET /pp/v2/checkout/orders/${orderId}`), 'our server reads the finished order back from PayPal itself');
  assert.equal((await api(`/api/certificates/${done.body.certificate.serial}`)).body.valid, true);

  // what the browser may learn about the toolkit
  const status = (await api('/api/config')).body.paypal.toolkit;
  assert.equal(status.mode, 'toolkit');
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.tools, ['create_order', 'pay_order']);
  assert.ok(status.calls.create_order >= 1 && status.calls.pay_order >= 1);
  assert.ok(!JSON.stringify(status).includes('sandbox-token'));
});

test('auto mode: a vague toolkit error is retried on the direct API, a clear PayPal refusal is not', async () => {
  // The real server only says "Failed to capture order", so the direct API is asked and explains the real reason.
  scenario({ PAYPAL_VIA: 'auto' });
  let a = await runAudit(GOOD_INPUT());
  let created = await create(a.id);
  fakes.state.calls.length = 0;
  let early = await capture(a.id, created.body.orderId);
  assert.equal(early.status, 502);
  assert.match(early.body.error, /ORDER_NOT_APPROVED/);
  assert.equal(captureCalls(), 2, 'one attempt through the toolkit, one on the direct API');

  // When PayPal's own reason already came back through the toolkit, asking again would be pointless.
  scenario({ PAYPAL_VIA: 'auto', FAKE_MCP_ERRORS: 'detailed' });
  a = await runAudit(GOOD_INPUT());
  created = await create(a.id);
  fakes.state.calls.length = 0;
  early = await capture(a.id, created.body.orderId);
  assert.equal(early.status, 502);
  assert.match(early.body.error, /ORDER_NOT_APPROVED/);
  assert.equal(captureCalls(), 1);
});

test('when the toolkit cannot start: auto mode uses the direct API, toolkit mode reports it', async () => {
  const missing = path.join(dataDir, 'no-such-program');
  scenario({ PAYPAL_VIA: 'auto', PAYPAL_MCP_COMMAND: missing });
  const a = await runAudit(GOOD_INPUT());
  const created = await create(a.id);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(fakes.order(created.body.orderId).body.purchase_units[0].custom_id, a.id, 'the direct route tags the order with the audit id');
  assert.equal((await paymentOf(a.id)).via.create, 'rest');
  const status = (await api('/api/config')).body.paypal.toolkit;
  assert.equal(status.state, 'unavailable');
  assert.match(status.error, /Could not start/);

  // the whole payment still works on the direct API
  fakes.approve(created.body.orderId);
  const done = await capture(a.id, created.body.orderId);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual((await paymentOf(a.id)).via, { create: 'rest', capture: 'rest' });

  // toolkit-only mode has no safety net and says why
  scenario({ PAYPAL_VIA: 'toolkit', PAYPAL_MCP_COMMAND: missing });
  const b = await runAudit(GOOD_INPUT());
  const strict = await create(b.id);
  assert.equal(strict.status, 502);
  assert.match(strict.body.error, /Could not start/);
});

test('trust but verify: a toolkit that claims success without capturing cannot get a certificate issued', async () => {
  // toolkit-only: the claim is checked against PayPal and refused
  scenario({ PAYPAL_VIA: 'toolkit', FAKE_MCP_MODE: 'lie' });
  let a = await runAudit(GOOD_INPUT());
  let created = await create(a.id);
  fakes.approve(created.body.orderId);
  const refused = await capture(a.id, created.body.orderId);
  assert.equal(refused.status, 502);
  assert.match(refused.body.error, /reported success, but PayPal says the order is APPROVED/);
  assert.ok(!(await api(`/api/audits/${a.id}`)).body.certificate, 'no certificate without a confirmed payment');

  // auto: the direct API then captures for real
  scenario({ PAYPAL_VIA: 'auto', FAKE_MCP_MODE: 'lie' });
  a = await runAudit(GOOD_INPUT());
  created = await create(a.id);
  fakes.approve(created.body.orderId);
  const done = await capture(a.id, created.body.orderId);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual((await paymentOf(a.id)).via, { create: 'toolkit', capture: 'rest' });
});

test('an order for the wrong amount, even if the toolkit made it, never earns a certificate', async () => {
  scenario({ FAKE_MCP_MODE: 'wrong-amount' });
  const a = await runAudit(GOOD_INPUT());
  const created = await create(a.id);
  fakes.approve(created.body.orderId);
  const res = await capture(a.id, created.body.orderId);
  assert.equal(res.status, 402);
  assert.ok(!(await api(`/api/audits/${a.id}`)).body.certificate, 'no certificate without a confirmed payment');
});

test('if the toolkit dies after PayPal captured, the payment is recovered from PayPal, not lost or charged twice', async () => {
  scenario({ PAYPAL_VIA: 'auto', FAKE_MCP_MODE: 'crash-after-capture' });
  const a = await runAudit(GOOD_INPUT());
  const created = await create(a.id);
  assert.equal((await paymentOf(a.id)).via.create, 'toolkit');
  fakes.approve(created.body.orderId);
  fakes.state.calls.length = 0;
  const done = await capture(a.id, created.body.orderId);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(captureCalls(), 2, 'the first capture worked, the retry was told it was already captured');
  assert.deepEqual((await paymentOf(a.id)).via, { create: 'toolkit', capture: 'rest' });
  assert.notEqual(toolkit.toolkitStatus().state, 'ready', 'the dead server is replaced on a later call');
});

test('a toolkit call that never answers times out, and the direct API finishes the payment', async () => {
  scenario({ PAYPAL_VIA: 'auto', FAKE_MCP_MODE: 'hang', PAYPAL_TOOLKIT_CALL_MS: '700' });
  const a = await runAudit(GOOD_INPUT());
  const created = await create(a.id);
  fakes.approve(created.body.orderId);
  const t0 = Date.now();
  const done = await capture(a.id, created.body.orderId);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(Date.now() - t0 < 4000, 'a stuck toolkit must not stall the buyer');
  assert.equal((await paymentOf(a.id)).via.capture, 'rest');
});

test('a slow start never blocks a payment; once the toolkit is ready it is used', async () => {
  scenario({ PAYPAL_VIA: 'auto', FAKE_MCP_MODE: 'slow-start', FAKE_MCP_DELAY_MS: '1500', PAYPAL_TOOLKIT_WAIT_MS: '300' });
  toolkit.warmUpToolkit(paypal.accessTokenInfo); // what the server does at start-up
  const a = await runAudit(GOOD_INPUT());
  const t0 = Date.now();
  const first = await create(a.id);
  const firstMs = Date.now() - t0;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await paymentOf(a.id)).via.create, 'rest', 'the toolkit was still starting, so the direct API was used');
  assert.ok(firstMs >= 250, `the first buyer waited for the toolkit (${firstMs} ms)`);

  // the next payment during the same start does not wait again
  const t1 = Date.now();
  const again = await create(a.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(Date.now() - t1 < 250, `the second payment went straight to the direct API (${Date.now() - t1} ms)`);
  assert.equal(toolkit.toolkitStatus().state, 'starting', 'the toolkit was still starting during both payments');

  for (let i = 0; i < 40 && toolkit.toolkitStatus().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(toolkit.toolkitStatus().state, 'ready');
  const second = await create(a.id);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal((await paymentOf(a.id)).via.create, 'toolkit');
});

test('if the narrow --tools list is rejected, the toolkit is restarted with "all"', async () => {
  scenario({ FAKE_MCP_MODE: 'reject-narrow' });
  const a = await runAudit(GOOD_INPUT());
  const created = await create(a.id);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const started = readLog().filter((e) => e.event === 'start');
  assert.equal(started.length, 1);
  assert.equal(started[0].toolsArg, 'all');
  assert.deepEqual(toolkit.toolkitStatus().tools, ['create_order', 'pay_order'], 'only the two tools we use are reported');
});

test('the MCP client ignores banner noise on stdout and answers the server\'s own ping', async () => {
  scenario({ FAKE_MCP_MODE: 'noisy' });
  const a = await runAudit(GOOD_INPUT());
  const created = await create(a.id);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(readLog().some((e) => e.event === 'ping-answered' && e.ok), 'the ping was answered');
});
