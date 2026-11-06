import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './src/config.js';
import { json, readBody, HttpError } from './src/http.js';
import { validateInput, createAudit, runAudit } from './src/auditor.js';
import { getAudit, listAudits, saveAudit } from './src/store.js';
import { llmEnabled } from './src/llm.js';
import { paypalConfigured, createCertificateOrder, captureOrder, certificateAmount, accessTokenInfo } from './src/paypal.js';
import { toolkitMode, toolkitStatus, warmUpToolkit, closeToolkit } from './src/paypalToolkit.js';
import { signCertificate, verifyCertificate } from './src/cert.js';
import { notifyZapier, indexInElastic } from './src/integrations.js';
import { handleCompetitionApi } from './src/competitionRoutes.js';
import { DEFAULT_CRITERIA } from './src/scoring.js';
import { payoutMode } from './src/payouts.js';
import { organizerKey } from './src/auth.js';

const PUBLIC_DIR = path.join(cfg().root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

// ---- tiny in-memory rate limiter + concurrency guard ----
const hits = new Map();
let running = 0;
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (arr.length >= cfg().rateLimitPerHour) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

function publicAudit(a) {
  return a; // audits hold no secrets by design (evidence is redacted); ids are unguessable
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/health') {
    return json(res, 200, { ok: true, service: 'JudgeMintAI', time: new Date().toISOString() });
  }

  if (method === 'GET' && p === '/api/config') {
    const c = cfg();
    return json(res, 200, {
      paypal: { enabled: paypalConfigured(), clientId: paypalConfigured() ? c.paypal.clientId : null, ...certificateAmount(), toolkit: toolkitStatus() },
      llm: { enabled: llmEnabled(), model: llmEnabled() ? c.llm.model : null },
      integrations: { zapier: Boolean(c.zapierUrl), elastic: Boolean(c.elastic.url && c.elastic.apiKey), youtubeApi: Boolean(c.youtube.apiKey), githubToken: Boolean(c.github.token) },
      competitions: {
        enabled: true,
        maxProjectsDefault: c.competitions.maxProjectsDefault,
        maxProjectsHard: c.competitions.maxProjectsHard,
        defaultCriteria: DEFAULT_CRITERIA,
        github: Boolean(c.github.token),
        payouts: { ready: payoutMode().ready, live: payoutMode().live, allowed: payoutMode().allowed },
      },
    });
  }

  // Judge mode: competitions, ranking, judging and prize payments (organiser key required inside)
  if (p === '/api/competitions' || p.startsWith('/api/competitions/') || p === '/api/organizer/check') {
    return handleCompetitionApi(req, res, url, clientIp(req));
  }

  if (method === 'GET' && p === '/api/audits') {
    // audits made for a competition belong to that competition and stay out of the public "recent" list
    const list = listAudits(200).filter((a) => !a.competitionId).slice(0, 25).map((a) => ({
      id: a.id, createdAt: a.createdAt, status: a.status, projectName: a.input.projectName, repoUrl: a.input.repoUrl,
      score: a.report?.overallScore ?? null, verdict: a.report?.verdict ?? null, certified: Boolean(a.certificate),
    }));
    return json(res, 200, { audits: list });
  }

  if (method === 'POST' && p === '/api/audits') {
    const ip = clientIp(req);
    if (rateLimited(ip)) throw new HttpError(429, `Rate limit reached (${cfg().rateLimitPerHour} audits/hour). Try again later.`);
    if (running >= 3) throw new HttpError(429, 'The auditor is busy right now. Please retry in a minute.');
    const body = await readBody(req);
    const { ok, errors, input } = validateInput(body);
    if (!ok) throw new HttpError(400, errors.join(' '));
    const audit = createAudit(input);
    running++;
    runAudit(audit).finally(() => { running--; });
    return json(res, 202, { id: audit.id });
  }

  const m = p.match(/^\/api\/audits\/([a-f0-9]{12})(?:\/(pay)\/(create|capture))?$/);
  if (m) {
    const audit = getAudit(m[1]);
    if (!audit) throw new HttpError(404, 'Audit not found');

    if (method === 'GET' && !m[2]) return json(res, 200, publicAudit(audit));

    if (method === 'POST' && m[2] === 'pay') {
      if (!paypalConfigured()) throw new HttpError(503, 'PayPal sandbox credentials are not configured on the server (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET).');
      if (audit.status !== 'complete') throw new HttpError(409, 'The audit is not finished yet.');
      if (audit.report.verdict === 'FAIL') throw new HttpError(409, 'Certificates are issued only to submissions that do not FAIL. Fix the critical issues and re-run the audit.');

      if (m[3] === 'create') {
        if (audit.certificate) throw new HttpError(409, 'A certificate was already issued for this audit.');
        const order = await createCertificateOrder(audit).catch((e) => { throw new HttpError(502, e.message); });
        audit.payment = { orderId: order.id, status: order.status, ...certificateAmount(), createdAt: new Date().toISOString(), via: { create: order.via } };
        saveAudit(audit);
        return json(res, 200, { orderId: order.id });
      }

      // capture
      const body = await readBody(req, 5_000);
      const orderId = String(body.orderId || '');
      if (!audit.payment || audit.payment.orderId !== orderId) throw new HttpError(400, 'This order does not belong to this audit.');
      if (audit.certificate) return json(res, 200, { certificate: audit.certificate, alreadyIssued: true, via: audit.payment?.via });

      const { order: cap, via } = await captureOrder(orderId).catch((e) => { throw new HttpError(502, `Payment could not be captured: ${e.message}`); });
      const unit = cap.purchase_units?.[0];
      const capture = unit?.payments?.captures?.[0];
      const expected = certificateAmount();
      // Orders made by our direct route carry the audit id. Orders made by the PayPal AI Toolkit cannot carry it (PayPal then
      // reports the placeholder reference "default"); those are tied to this audit by the order id we stored when we created them.
      const tags = [unit?.custom_id, capture?.custom_id, unit?.reference_id].filter((t) => t && t !== 'default');
      const valid =
        cap.id === orderId &&
        cap.status === 'COMPLETED' &&
        capture?.status === 'COMPLETED' &&
        capture?.amount?.value === expected.value &&
        capture?.amount?.currency_code === expected.currency &&
        tags.every((t) => t === audit.id);
      if (!valid) throw new HttpError(402, 'PayPal did not confirm a completed payment for the expected amount.');

      audit.payment = { ...audit.payment, status: 'COMPLETED', captureId: capture.id, capturedAt: new Date().toISOString(), via: { ...audit.payment.via, capture: via } };
      audit.certificate = signCertificate({
        auditId: audit.id, repo: audit.input.repoUrl, score: audit.report.overallScore,
        verdict: audit.report.verdict, paypalOrderId: orderId,
      });
      saveAudit(audit);
      // sponsor hooks: record, never block
      Promise.all([
        notifyZapier('certificate.issued', { auditId: audit.id, serial: audit.certificate.serial, project: audit.input.projectName, score: audit.certificate.score }),
        indexInElastic(audit),
      ]).catch(() => {});
      return json(res, 200, { certificate: audit.certificate, via: audit.payment.via });
    }
  }

  const c = p.match(/^\/api\/certificates\/(JM-[A-F0-9]{12})$/);
  if (method === 'GET' && c) {
    const audit = listAudits(100000).find((a) => a.certificate?.serial === c[1]);
    if (!audit) return json(res, 404, { valid: false, error: 'No such certificate' });
    return json(res, 200, { valid: verifyCertificate(audit.certificate), certificate: audit.certificate, projectName: audit.input.projectName });
  }

  throw new HttpError(404, 'Unknown API route');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA-style fallback for /a/<id> and /verify/<serial> deep links
      if (/^\/(a|verify|c|competitions)(\/|$)/.test(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    res.end(data);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  });
}

// Start only when run directly (so tests can import createServer)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  const { port } = cfg();
  createServer().listen(port, () => {
    const c = cfg();
    const mode = toolkitMode();
    console.log(`\n  JudgeMintAI running → http://localhost:${port}`);
    console.log(`  AI mode:     ${llmEnabled() ? `LLM (${c.llm.model})` : 'heuristic (set LLM_API_KEY for the AI head judge)'}`);
    console.log(`  PayPal:      ${paypalConfigured() ? 'sandbox credentials loaded' : 'NOT configured (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)'}`);
    const toolkitLine = mode === 'rest' ? 'off, using the direct Orders API (PAYPAL_VIA=rest)'
      : !paypalConfigured() ? 'waits for your PayPal keys'
      : `on (${mode === 'toolkit' ? 'toolkit only' : 'the direct Orders API is the safety net'}), PayPal's MCP server starts in the background`;
    console.log(`  AI Toolkit:  ${toolkitLine}`);
    console.log(`  Zapier:      ${c.zapierUrl ? 'enabled' : 'off'}   Elastic: ${c.elastic.url ? 'enabled' : 'off'}`);
    const pm = payoutMode();
    console.log(`  Judge mode:  http://localhost:${port}/competitions   (up to ${c.competitions.maxProjectsHard} entries per competition)`);
    console.log(`  Organiser key: ${organizerKey()}   <- type this on the Competitions page. Set ORGANIZER_KEY to choose your own.`);
    console.log(`  Prize payouts: ${!pm.ready ? 'need your PayPal keys' : pm.live ? (pm.allowed ? 'LIVE PayPal (real money!)' : 'blocked: live PayPal without ALLOW_LIVE_PAYOUTS') : 'PayPal sandbox (no real money)'}   GitHub token: ${c.github.token ? 'set' : 'not set (60 requests/hour limit)'}\n`);

    // Start the PayPal AI Toolkit now so the first payment does not wait for it. The very first start downloads
    // @paypal/mcp from npm, which can take a minute. If it cannot start, payments use the direct Orders API.
    if (paypalConfigured() && mode !== 'rest') {
      warmUpToolkit(accessTokenInfo).then((ok) => {
        const t = toolkitStatus();
        console.log(ok ? `  PayPal AI Toolkit ready: ${t.tools.join(', ')}\n` : `  PayPal AI Toolkit could not start (${t.error || 'unknown reason'}). Payments will use the direct Orders API.\n`);
      });
    }
  });
  const shutDown = () => { closeToolkit(); process.exit(0); };
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);
  process.on('exit', closeToolkit);
}
