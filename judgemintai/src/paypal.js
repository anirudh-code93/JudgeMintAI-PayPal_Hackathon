import crypto from 'node:crypto';
import { cfg } from './config.js';
import { callToolkit, toolkitMode, ToolkitError } from './paypalToolkit.js';

// PayPal Orders v2 (SANDBOX). All money movement happens server-side: the browser only
// renders PayPal's buttons and tells us which order the buyer approved.
//
// Two routes lead to the same PayPal sandbox:
//   1. PayPal AI Toolkit: our server talks MCP to the official @paypal/mcp server, which calls PayPal (create_order, pay_order).
//   2. Direct REST: our server calls api-m.sandbox.paypal.com itself. This is also the safety net in "auto" mode.
// Whichever route moved the money, OUR server decides whether a payment counts: after a toolkit capture it reads the
// order back from PayPal with its own credentials, and server.js checks the amount before a certificate is signed.

let tokenCache = { token: '', expiresAt: 0 };

export function paypalConfigured() {
  const { paypal } = cfg();
  return Boolean(paypal.clientId && paypal.clientSecret);
}

async function accessToken(minTtlMs = 60_000) {
  const { paypal } = cfg();
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - minTtlMs) return tokenCache.token;
  const basic = Buffer.from(`${paypal.clientId}:${paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are SANDBOX credentials.`);
  const body = await res.json();
  tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 300) * 1000 };
  return tokenCache.token;
}

/** A sandbox token with plenty of life left. The toolkit server keeps the token it was started with, so it gets a fresh one. */
export async function accessTokenInfo() {
  const token = await accessToken(20 * 60_000);
  return { token, expiresAt: tokenCache.expiresAt };
}

async function call(method, path, body, requestId) {
  const { paypal } = cfg();
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // makes retries idempotent
  const res = await fetch(`${paypal.apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const issue = data?.details?.[0]?.issue || data?.name || res.status;
    const err = new Error(`PayPal ${method} ${path} failed: ${issue}`);
    err.paypal = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** The same authenticated PayPal call the Orders code uses, for other PayPal REST APIs (prize payouts use it). */
export { call as paypalCall };

export function certificateAmount() {
  const { paypal } = cfg();
  return { value: Number(paypal.price).toFixed(2), currency: paypal.currency };
}

function checkOrderId(orderId) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(orderId)) throw new Error('Invalid PayPal order id');
}

// In "auto" mode a toolkit problem must never cost us a sale, so we log it once and use the direct API instead.
// PayPal itself saying no (for example a declined card) is NOT retried: the direct API would say the same.
let lastFallbackNote = '';
async function viaToolkitOrRest(toolkitRoute, restRoute) {
  const mode = toolkitMode();
  if (mode === 'rest') return { data: await restRoute(), via: 'rest' };
  try {
    return { data: await toolkitRoute(), via: 'toolkit' };
  } catch (err) {
    if (mode === 'toolkit' || (err instanceof ToolkitError && err.kind === 'paypal')) throw err;
    if (err.message !== lastFallbackNote) {
      lastFallbackNote = err.message;
      console.warn(`[paypal] PayPal AI Toolkit not used, falling back to the direct Orders API: ${err.message}`);
    }
    return { data: await restRoute(), via: 'rest' };
  }
}

// ---- create ------------------------------------------------------------------------------------------------------

function restCreate(audit) {
  const { value, currency } = certificateAmount();
  return call(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: audit.id,
          description: `JudgeMintAI Verified certificate for ${audit.input.repoUrl}`.slice(0, 120),
          custom_id: audit.id,
          amount: { currency_code: currency, value },
        },
      ],
    },
    `jm-create-${audit.id}`,
  );
}

async function toolkitCreate(audit) {
  const { value, currency } = certificateAmount();
  const price = Number(value);
  const back = `${cfg().publicUrl}/a/${audit.id}`;
  // The toolkit's create_order tool cannot tag an order with our audit id, so the order id is stored on the audit instead.
  const order = await callToolkit('create_order', {
    currencyCode: currency,
    items: [{
      name: 'JudgeMintAI audit certificate',
      description: `Verified certificate for ${audit.input.repoUrl}`.slice(0, 120),
      quantity: 1,
      itemCost: price,
      taxPercent: 0,
      itemTotal: price,
    }],
    returnUrl: back,
    cancelUrl: back,
  }, accessTokenInfo);
  if (!order || typeof order !== 'object' || typeof order.id !== 'string') throw new ToolkitError('create_order returned no order id', 'tool');
  return order;
}

/** Create the PayPal order for an audit's certificate. Resolves to { id, status, via }. */
export async function createCertificateOrder(audit) {
  const { data, via } = await viaToolkitOrRest(() => toolkitCreate(audit), () => restCreate(audit));
  checkOrderId(String(data.id));
  return { id: data.id, status: data.status, via };
}

// ---- capture -----------------------------------------------------------------------------------------------------

export function getOrder(orderId) {
  checkOrderId(orderId);
  return call('GET', `/v2/checkout/orders/${orderId}`);
}

async function restCapture(orderId) {
  try {
    return await call('POST', `/v2/checkout/orders/${orderId}/capture`, null, `jm-capture-${orderId}`);
  } catch (err) {
    // An earlier attempt (for example one that went through the toolkit) may already have captured it. Read the result back.
    if (err.paypal?.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED') return getOrder(orderId);
    throw err;
  }
}

async function toolkitCapture(orderId) {
  try {
    const out = await callToolkit('pay_order', { id: orderId }, accessTokenInfo);
    const reported = out?.status === 'success' || out?.status === 'COMPLETED' || out?.response?.status === 'COMPLETED';
    if (!reported) throw new ToolkitError('pay_order did not report a completed capture', 'tool');
  } catch (err) {
    // "Already captured" means an earlier attempt worked; the read-back below confirms it.
    if (!(err instanceof ToolkitError && err.kind === 'paypal' && /ORDER_ALREADY_CAPTURED/.test(err.message))) throw err;
  }
  // Trust but verify: never issue a certificate on the toolkit's word alone. Read the order from PayPal ourselves.
  const order = await getOrder(orderId);
  if (order.status !== 'COMPLETED') throw new ToolkitError(`the toolkit reported success, but PayPal says the order is ${order.status}`, 'tool');
  return order;
}

/** Capture an approved order. Resolves to { order, via } where order is PayPal's own record of the finished payment. */
export async function captureOrder(orderId) {
  checkOrderId(orderId);
  const { data, via } = await viaToolkitOrRest(() => toolkitCapture(orderId), () => restCapture(orderId));
  return { order: data, via };
}

export function newRequestId() {
  return crypto.randomUUID();
}
