// Local stand-ins for GitHub, the PayPal sandbox, YouTube oEmbed and a demo site.
// They let the whole product be tested offline and deterministically (`npm test`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Read a directory into { 'relative/path': 'text' }, skipping junk. */
export function walk(dir, base = dir, out = {}) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'data', '.git', '.env', 'dist'].includes(name) || name.endsWith('.zip')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

export function commitsOver(days, count) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    sha: (i + 1).toString(16).padStart(40, 'a'),
    commit: {
      author: { date: new Date(now - (days * 864e5 * i) / count).toISOString(), name: 'dev' },
      message: `commit ${count - i}`,
    },
  }));
}

export async function startFakes({ repos = {}, orgs = {}, topics = {} } = {}) {
  const orders = new Map();
  const payouts = new Map(); // sender_batch_id -> batch
  const payoutsById = new Map();
  let seq = 0;
  let pseq = 0;
  let baseRef = '';
  const baseUrl = () => baseRef; // the fake server's own address, known once it is listening
  const state = {
    declineNext: false, calls: [], captureAmountOverride: null,
    // prize payouts: 'ok' | 'insufficient' | 'server-error' | 'created-then-500' | 'forbidden'
    payoutMode: 'ok', payoutBodies: [],
    // the AI model: a function (system, user) => string | { status } | null (null = the default friendly answer)
    llmHandler: null, llmCalls: [], llm429Left: 0,
    zaps: [],
    elastic: [], // bulk requests received: { auth, type, lines }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const readJson = async () => {
      let s = '';
      for await (const c of req) s += c;
      try { return s ? JSON.parse(s) : {}; } catch { return {}; }
    };
    state.calls.push(`${req.method} ${url.pathname}`);

    // ---- GitHub API: listings of an organisation / user / topic ----
    const listing = (names) => names.map((full) => ({ name: full.split('/')[1], full_name: full, html_url: `https://github.com/${full}`, description: repos[full]?.description || '', fork: Boolean(repos[full]?.fork), private: false }));
    let m = url.pathname.match(/^\/gh\/(orgs|users)\/([^/]+)\/repos$/);
    if (m) return orgs[m[2]] ? send(200, listing(orgs[m[2]])) : send(404, { message: 'Not Found' });
    if (url.pathname === '/gh/search/repositories') {
      const t = (url.searchParams.get('q') || '').replace(/^topic:/, '');
      return send(200, { items: listing(topics[t] || []) });
    }

    // ---- GitHub API ----
    m = url.pathname.match(/^\/gh\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const repo = repos[`${m[1]}/${m[2]}`];
      if (!repo) return send(404, { message: 'Not Found' });
      const sub = m[3] || '';
      if (sub === '') {
        return send(200, {
          full_name: `${m[1]}/${m[2]}`, description: repo.description || '', private: Boolean(repo.private), fork: Boolean(repo.fork),
          archived: false, default_branch: 'main', created_at: repo.createdAt || '2026-10-01T00:00:00Z', pushed_at: new Date().toISOString(),
          stargazers_count: repo.stars ?? 1, size: 100, topics: repo.topics || [], license: repo.license ? { spdx_id: repo.license, name: repo.license } : null,
          parent: repo.parent ? { full_name: repo.parent } : undefined,
        });
      }
      if (sub.startsWith('git/trees/')) {
        return send(200, { tree: Object.entries(repo.files).map(([p, t]) => ({ path: p, type: 'blob', size: t.length })) });
      }
      if (sub === 'commits') return send(200, repo.commits || []);
      if (sub === 'license') return repo.license ? send(200, { license: { spdx_id: repo.license, name: repo.license } }) : send(404, { message: 'Not Found' });
      if (sub === 'languages') return send(200, repo.languages || { JavaScript: 1000 });
      return send(404, {});
    }
    // ---- raw file contents ----
    m = url.pathname.match(/^\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      const repo = repos[`${m[1]}/${m[2]}`];
      const text = repo?.files[decodeURIComponent(m[4])];
      return text == null ? send(404, 'nope', 'text/plain') : send(200, text, 'text/plain');
    }

    // ---- PayPal sandbox (Orders v2 contract) ----
    if (url.pathname === '/pp/v1/oauth2/token' && req.method === 'POST') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Basic ') || Buffer.from(auth.slice(6), 'base64').toString() !== 'test-id:test-secret') return send(401, { error: 'invalid_client' });
      return send(200, { access_token: 'sandbox-token', expires_in: 3600, token_type: 'Bearer' });
    }
    // ---- PayPal Payouts (POST creates a batch, GET reads it) ----
    if (url.pathname.startsWith('/pp/v1/payments/payouts')) {
      if (req.headers.authorization !== 'Bearer sandbox-token') return send(401, { name: 'AUTHENTICATION_FAILURE' });
      const batchView = (b) => ({
        batch_header: { payout_batch_id: b.id, batch_status: b.status, sender_batch_header: b.header },
        items: [{ payout_item_id: `ITEM${b.id}`, transaction_status: b.itemStatus, payout_item: b.item, ...(b.itemStatus === 'FAILED' ? { errors: { name: 'INSUFFICIENT_FUNDS', message: 'Sender has insufficient funds' } } : {}) }],
      });
      if (req.method === 'POST') {
        const body = await readJson();
        state.payoutBodies.push(body);
        const header = body.sender_batch_header || {};
        if (state.payoutMode === 'forbidden') return send(403, { name: 'NOT_AUTHORIZED', message: 'Authorization failed due to insufficient permissions.' });
        if (!header.sender_batch_id || !Array.isArray(body.items) || !body.items.length || !body.items[0].receiver || !body.items[0].amount?.value) {
          return send(400, { name: 'VALIDATION_ERROR', message: 'Invalid request - see details', details: [{ issue: 'MISSING_FIELD' }] });
        }
        const existing = payouts.get(header.sender_batch_id);
        if (existing) {
          return send(400, {
            name: 'USER_BUSINESS_ERROR', message: `Batch with given sender_batch_id already exists. sender_batch_id: ${header.sender_batch_id}`,
            links: [{ href: `${baseUrl()}/pp/v1/payments/payouts/${existing.id}`, rel: 'self', method: 'GET' }],
          });
        }
        if (state.payoutMode === 'insufficient') return send(400, { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds. Please add funds and retry.' });
        if (state.payoutMode === 'server-error') return send(500, { name: 'INTERNAL_SERVICE_ERROR', message: 'An internal service error has occurred.' });
        const b = { id: `PAYOUT${String(++pseq).padStart(5, '0')}`, status: 'PENDING', itemStatus: 'PENDING', header, item: body.items[0] };
        payouts.set(header.sender_batch_id, b);
        payoutsById.set(b.id, b);
        if (state.payoutMode === 'created-then-500') return send(500, { name: 'INTERNAL_SERVICE_ERROR', message: 'An internal service error has occurred.' });
        return send(201, { batch_header: { payout_batch_id: b.id, batch_status: 'PENDING', sender_batch_header: header }, links: [] });
      }
      m = url.pathname.match(/^\/pp\/v1\/payments\/payouts\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const b = payoutsById.get(m[1]);
        return b ? send(200, batchView(b)) : send(404, { name: 'RESOURCE_NOT_FOUND', message: 'Requested resource ID was not found.' });
      }
    }
    if (url.pathname.startsWith('/pp/v2/')) {
      if (req.headers.authorization !== 'Bearer sandbox-token') return send(401, { name: 'AUTHENTICATION_FAILURE' });
      if (url.pathname === '/pp/v2/checkout/orders' && req.method === 'POST') {
        const body = await readJson();
        const id = `5O1901${String(++seq).padStart(5, '0')}TN364715T`;
        orders.set(id, { body, approved: false, status: 'CREATED', capture: null });
        // Like the real API: an order created with a payment_source waits for the payer.
        return send(201, { id, status: body.payment_source?.paypal ? 'PAYER_ACTION_REQUIRED' : 'CREATED', links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
      }
      // What PayPal reports about an order. Without a reference_id the real API says "default".
      const view = (id, o) => {
        const unit = o.body.purchase_units[0];
        const out = { id, status: o.status === 'COMPLETED' ? 'COMPLETED' : o.approved ? 'APPROVED' : 'CREATED', purchase_units: [{ reference_id: unit.reference_id || 'default', amount: unit.amount }] };
        if (unit.custom_id) out.purchase_units[0].custom_id = unit.custom_id;
        if (o.capture) out.purchase_units[0].payments = { captures: [o.capture] };
        return out;
      };
      m = url.pathname.match(/^\/pp\/v2\/checkout\/orders\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const o = orders.get(m[1]);
        if (!o) return send(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
        return send(200, view(m[1], o));
      }
      m = url.pathname.match(/^\/pp\/v2\/checkout\/orders\/([^/]+)\/capture$/);
      if (m && req.method === 'POST') {
        const o = orders.get(m[1]);
        if (!o) return send(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
        if (o.status === 'COMPLETED') return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
        if (state.declineNext) { state.declineNext = false; return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }); }
        if (!o.approved) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
        const unit = o.body.purchase_units[0];
        o.status = 'COMPLETED';
        o.capture = { id: `CAP${seq}`, status: 'COMPLETED', custom_id: unit.custom_id, amount: { currency_code: unit.amount.currency_code, value: state.captureAmountOverride || unit.amount.value } };
        return send(201, view(m[1], o));
      }
    }

    // ---- the AI model (OpenAI-compatible chat endpoint) ----
    if (url.pathname === '/llm/chat/completions' && req.method === 'POST') {
      const body = await readJson();
      const system = body.messages?.[0]?.content || '';
      const user = body.messages?.[1]?.content || '';
      state.llmCalls.push({ system, user });
      if (state.llm429Left > 0) { state.llm429Left--; res.writeHead(429, { 'Retry-After': '0' }); return res.end('{}'); }
      let out = state.llmHandler ? state.llmHandler(system, user) : null;
      if (out && typeof out === 'object' && out.status) { res.writeHead(out.status); return res.end('{}'); }
      if (out == null) {
        // default: a friendly judge who gives every criterion in the prompt a 6
        const ids = [...user.matchAll(/^- ([a-z0-9-]+): /gm)].map((x) => x[1]);
        out = JSON.stringify({
          scores: Object.fromEntries(ids.map((id) => [id, { score: 6, reason: `Solid ${id}.` }])),
          summary: 'A solid entry with a clear purpose.', strengths: ['Clear purpose'], weaknesses: ['Few tests'], flags: [], rule_checks: [],
        });
      }
      return send(200, { choices: [{ message: { content: typeof out === 'string' ? out : JSON.stringify(out) } }] });
    }

    // ---- Zapier "Catch Hook" ----
    if (url.pathname === '/zap' && req.method === 'POST') {
      state.zaps.push(await readJson());
      return send(200, { status: 'success' });
    }

    // ---- Elasticsearch bulk API (newline-delimited JSON: an action line, then a document line) ----
    if (url.pathname === '/elastic/_bulk' && req.method === 'POST') {
      let s = '';
      for await (const c of req) s += c;
      state.elastic.push({ auth: req.headers.authorization, type: req.headers['content-type'], lines: s.split('\n').filter(Boolean).map((l) => JSON.parse(l)) });
      return send(200, { errors: false, items: [] });
    }

    // ---- YouTube oEmbed ----
    if (url.pathname === '/yt/oembed') {
      const v = new URL(url.searchParams.get('url')).searchParams.get('v');
      if (v === 'goodvid0001') return send(200, { title: 'JudgeMintAI demo walkthrough', author_name: 'Team JudgeMint' });
      if (v === 'missingvid1') return send(404, 'Not Found', 'text/plain');
      return send(401, 'Unauthorized', 'text/plain');
    }

    // ---- demo site ----
    if (url.pathname === '/demo') {
      return send(200, '<html><head><script src="https://www.paypal.com/sdk/js?client-id=abc"></script></head><body>demo</body></html>', 'text/html');
    }
    return send(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  baseRef = base;
  return {
    base, state,
    // the payout PayPal would report later: 'SUCCESS' | 'UNCLAIMED' | 'FAILED' | 'ONHOLD'
    advancePayout: (id, itemStatus) => { const b = payoutsById.get(id); if (b) { b.itemStatus = itemStatus; b.status = itemStatus === 'FAILED' ? 'DENIED' : 'SUCCESS'; } },
    payoutCount: () => payouts.size,
    approve: (id) => { const o = orders.get(id); if (o) o.approved = true; },
    order: (id) => orders.get(id),
    close: () => new Promise((r) => server.close(r)),
  };
}
