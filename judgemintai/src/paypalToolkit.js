import { McpClient } from './mcp.js';
import { cfg } from './config.js';

// PayPal AI Toolkit (the Agent Toolkit's MCP server, npm package @paypal/mcp), used by the RUNNING app.
//
// The official server is started as a child process. JudgeMintAI then asks it to run two PayPal tools:
//   create_order   when the buyer clicks the PayPal button
//   pay_order      when the buyer has approved and the order must be captured
// Setting PAYPAL_VIA in .env chooses the route:
//   auto     toolkit first, direct Orders API as the safety net (default)
//   toolkit  toolkit only, no safety net (best for a demo video)
//   rest     direct Orders API only (needs no npm download)

// Least privilege: the app only creates and captures orders. If this CLI flag is ever rejected we retry with "all".
const NARROW_TOOLS = 'orders.create,orders.capture';
const REQUIRED_TOOLS = ['create_order', 'pay_order'];
const TOKEN_MARGIN_MS = 10 * 60_000; // restart the server with a fresh token before the old one can expire
const COOLDOWN_MS = 60_000; // after a failed start, use the direct API for a minute before trying again

// The third-party server only ever receives what it needs. Our own secrets never reach its environment.
const SECRET_NAME = /(SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|WEBHOOK|PRIVATE|CREDENTIAL)/i;
const AUTH_FAILURE = /AUTHENTICATION_FAILURE|invalid[_ ]token|unauthori[sz]ed|\b401\b|token (has )?expired/i;
const PAYPAL_REFUSAL = /"issue"\s*:|"debug_id"|UNPROCESSABLE_ENTITY|ORDER_NOT_APPROVED|ORDER_ALREADY_CAPTURED|INSTRUMENT_DECLINED|RESOURCE_NOT_FOUND|INVALID_RESOURCE_ID|PAYER_ACTION_REQUIRED/;

/**
 * kind says what went wrong, and therefore what the caller should do:
 *   unavailable  the toolkit could not be used (not started, crashed, too slow)  -> use the direct API
 *   auth         PayPal rejected the toolkit's access token                      -> use the direct API
 *   tool         the toolkit answered something we cannot use                    -> use the direct API
 *   paypal       PayPal itself said no (declined, not approved ...)              -> report it, do not retry
 */
export class ToolkitError extends Error {
  constructor(message, kind = 'unavailable') {
    super(message);
    this.name = 'ToolkitError';
    this.kind = kind;
  }
}

const S = {
  client: null,
  state: 'idle', // idle | starting | ready | unavailable
  starting: null,
  generation: 0, // bumped by closeToolkit() so a start that was running at that moment is thrown away
  waitSpent: false, // a buyer already waited for the start that is running now
  tokenExpiresAt: 0,
  retryAfter: 0,
  lastError: '',
  tools: [],
  calls: { create_order: 0, pay_order: 0 }, // successful calls, shown in the footer
};

export function toolkitMode() {
  return cfg().paypal.via;
}

/** Safe to send to the browser: no secrets, just the state of the toolkit. */
export function toolkitStatus() {
  const mode = toolkitMode();
  return {
    mode,
    state: mode === 'rest' ? 'off' : S.state,
    package: '@paypal/mcp',
    tools: S.state === 'ready' ? S.tools.filter((t) => REQUIRED_TOOLS.includes(t)) : [],
    calls: { ...S.calls },
    error: S.state === 'unavailable' ? S.lastError.replace(/[A-Za-z0-9._~+/=-]{40,}/g, '[removed]').slice(0, 200) : '', // this endpoint is public: never show anything token-like
  };
}

function launchSpec(toolsArg) {
  const { toolkit } = cfg().paypal;
  if (toolkit.command) {
    // Advanced use and automated tests: run another MCP server instead of "npx -y @paypal/mcp".
    // An argument containing {tools} is filled in with the tool list, exactly like the real --tools flag.
    let args = [];
    try { args = JSON.parse(toolkit.args || '[]'); } catch { /* not JSON: no arguments */ }
    return { command: toolkit.command, args: (Array.isArray(args) ? args : []).map((a) => String(a).replace('{tools}', toolsArg)), shell: false };
  }
  return { command: 'npx', args: ['-y', '@paypal/mcp', `--tools=${toolsArg}`], shell: process.platform === 'win32' };
}

function childEnv(token) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_NAME.test(name) || name === 'PAYPAL_CLIENT_ID' || name === 'ELASTIC_URL') continue;
    env[name] = value;
  }
  env.PAYPAL_ACCESS_TOKEN = token; // short-lived SANDBOX token, minted by our own server
  env.PAYPAL_ENVIRONMENT = 'SANDBOX';
  return env;
}

// Plain-English version of the usual reasons the toolkit cannot start (the raw text stays in the server log).
function explain(message) {
  if (/ENOENT[^\n]*npx|npx[^\n]*(not found|not recognized)/i.test(message)) return 'npx was not found. Is Node.js installed?';
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|npm (error|ERR!) network|proxy/i.test(message)) return 'npm could not download @paypal/mcp. Is this computer online, or is a proxy needed?';
  return message;
}

function worthRetryingWithAllTools(err) {
  if (err.code === 'TOOLS_MISSING') return true;
  if (err.kind !== 'exit') return false; // a timeout or a missing npx would just fail again
  return !/ENOTFOUND|ETIMEDOUT|ECONN|EAI_AGAIN|E404|registry|network/i.test(err.message); // a quick exit usually means a bad argument
}

async function startOnce(getToken, toolsArg, onUnexpectedExit) {
  const { token, expiresAt } = await getToken();
  const spec = launchSpec(toolsArg);
  const client = new McpClient({ command: spec.command, args: spec.args, shell: spec.shell, env: childEnv(token), onExit: (err) => onUnexpectedExit(client, err) });
  S.client = client; // remembered right away so closeToolkit() can stop a server that is still starting
  try {
    await client.start({ timeoutMs: cfg().paypal.toolkit.startMs });
    const names = (await client.listTools()).map((t) => t.name);
    const missing = REQUIRED_TOOLS.filter((n) => !names.includes(n));
    if (missing.length) {
      const err = new Error(`the MCP server did not offer the tools ${missing.join(' and ')}`);
      err.code = 'TOOLS_MISSING';
      throw err;
    }
    return { client, names, expiresAt };
  } catch (err) {
    client.close();
    if (S.client === client) S.client = null;
    throw err;
  }
}

async function startToolkit(getToken, onUnexpectedExit) {
  const { command, args } = cfg().paypal.toolkit;
  const attempts = command && !args.includes('{tools}') ? ['custom'] : [NARROW_TOOLS, 'all'];
  let last;
  for (const toolsArg of attempts) {
    try {
      return await startOnce(getToken, toolsArg, onUnexpectedExit);
    } catch (err) {
      last = err;
      if (!worthRetryingWithAllTools(err)) break;
    }
  }
  throw last;
}

function stopClient() {
  const c = S.client;
  S.client = null;
  if (c) c.close();
}

function ensureStarted(getToken) {
  if (S.state === 'ready' && S.client && Date.now() < S.tokenExpiresAt - TOKEN_MARGIN_MS) return Promise.resolve(S.client);
  if (S.starting) return S.starting;
  if (Date.now() < S.retryAfter) return Promise.reject(new ToolkitError(S.lastError || 'the toolkit failed to start a moment ago', 'unavailable'));
  if (S.state === 'ready') stopClient(); // the token is about to expire: replace the server with one that has a fresh token

  const generation = S.generation;
  const onUnexpectedExit = (client, err) => {
    if (S.client !== client || S.state !== 'ready') return; // a failure while starting is handled by the start itself
    S.client = null;
    S.state = 'unavailable';
    S.lastError = explain(err.message);
    S.retryAfter = Date.now() + 10_000;
  };
  S.state = 'starting';
  S.waitSpent = false;
  S.starting = startToolkit(getToken, onUnexpectedExit)
    .then((started) => {
      if (generation !== S.generation) {
        started.client.close();
        throw new ToolkitError('the toolkit was shut down while it was starting', 'unavailable');
      }
      S.client = started.client;
      S.state = 'ready';
      S.tools = started.names;
      S.tokenExpiresAt = started.expiresAt;
      S.lastError = '';
      return started.client;
    })
    .catch((err) => {
      if (generation === S.generation) {
        S.state = 'unavailable';
        S.lastError = explain(err.message);
        S.retryAfter = Date.now() + COOLDOWN_MS;
      }
      throw err instanceof ToolkitError ? err : new ToolkitError(err.message, 'unavailable');
    })
    .finally(() => { if (generation === S.generation) S.starting = null; });
  S.starting.catch(() => {}); // nobody may be waiting for this start: never let it become an unhandled rejection
  return S.starting;
}

/** Start the toolkit in the background (at server start-up) so the first payment does not wait for npm. Never throws. */
export function warmUpToolkit(getToken) {
  if (toolkitMode() === 'rest') return Promise.resolve(false);
  return ensureStarted(getToken).then(() => true, () => false);
}

/** Stop the toolkit. Used at shutdown and by the tests; the next call starts it again. */
export function closeToolkit() {
  S.generation += 1;
  stopClient();
  Object.assign(S, { state: 'idle', starting: null, waitSpent: false, retryAfter: 0, lastError: '', tools: [] });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new ToolkitError(message, 'unavailable')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// The most specific PayPal reason found in a piece of text.
function issueOf(body) {
  const quoted = body.match(/"issue"\s*:\s*"([A-Z_]+)"/);
  if (quoted) return quoted[1];
  for (const issue of ['ORDER_NOT_APPROVED', 'ORDER_ALREADY_CAPTURED', 'INSTRUMENT_DECLINED', 'INVALID_RESOURCE_ID', 'RESOURCE_NOT_FOUND', 'UNPROCESSABLE_ENTITY']) {
    if (body.includes(issue)) return issue;
  }
  const named = body.match(/"name"\s*:\s*"([A-Z_]+)"/);
  return named ? named[1] : body.slice(0, 120);
}

/** `body` is everything the toolkit said (used to decide what kind of problem it is); `readable` is its own short message, if it gave one. */
function failure(tool, body, readable) {
  const text = String(body || '').trim();
  const say = String(readable || text).trim();
  if (AUTH_FAILURE.test(text)) return new ToolkitError(`${tool}: PayPal rejected the access token that was given to the toolkit`, 'auth');
  if (PAYPAL_REFUSAL.test(text)) return new ToolkitError(`PayPal ${tool} failed: ${issueOf(say)}`, 'paypal');
  return new ToolkitError(`${tool} failed: ${say.slice(0, 160) || 'no details'}`, 'tool');
}

/**
 * Run one PayPal tool through the toolkit. Resolves to the tool's answer (parsed JSON when it is JSON).
 * Rejects with a ToolkitError whose `kind` tells the caller whether the direct API is worth trying.
 * `getToken` returns { token, expiresAt } for a SANDBOX access token.
 */
export async function callToolkit(tool, args, getToken) {
  let client;
  // A slow first start (npm is downloading the package) makes ONE buyer wait a few seconds. Later payments during the same
  // start go straight to the direct API instead of waiting again.
  const wait = S.state === 'starting' && S.waitSpent ? 0 : cfg().paypal.toolkit.waitMs;
  try {
    client = await withTimeout(ensureStarted(getToken), wait, 'the PayPal AI Toolkit is still starting up');
  } catch (err) {
    if (S.state === 'starting') S.waitSpent = true;
    throw err instanceof ToolkitError ? err : new ToolkitError(err.message, 'unavailable');
  }

  let res;
  try {
    res = await client.callTool(tool, args, { timeoutMs: cfg().paypal.toolkit.callMs });
  } catch (err) {
    if (err.kind === 'timeout' || err.kind === 'exit' || err.kind === 'closed') {
      // A silent or dead server is replaced on the next call.
      if (S.client === client) { stopClient(); S.state = 'idle'; S.retryAfter = Date.now() + 5_000; }
    }
    throw new ToolkitError(`${tool}: ${err.message}`, err.kind === 'rpc' ? 'tool' : 'unavailable');
  }

  const data = parseJson(res.text);
  const isObject = data && typeof data === 'object';
  // The toolkit reports PayPal errors either as an MCP error or as normal text such as {"error":{"message":...}}.
  let problem = null;
  if (res.isError) problem = res.text;
  else if (isObject && data.error) problem = res.text;
  else if (isObject && data.status === 'error') problem = JSON.stringify(data.response ?? data);
  else if (!data && AUTH_FAILURE.test(res.text)) problem = res.text;
  if (problem !== null) {
    const err = failure(tool, problem, isObject && data.error && typeof data.error === 'object' ? data.error.message : undefined);
    // A rejected token means this server was started with a stale one: replace it on the next call.
    if (err.kind === 'auth' && S.client === client) { stopClient(); S.state = 'idle'; S.retryAfter = 0; }
    throw err;
  }

  S.calls[tool] = (S.calls[tool] || 0) + 1;
  return data ?? res.text;
}
