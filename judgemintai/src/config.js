import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader (no dependencies). Real environment variables always win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const strip = (u) => String(u).replace(/\/+$/, '');

// Read at call time so tests (and hosting dashboards) can change env vars freely.
export function cfg() {
  const e = process.env;
  return {
    root: ROOT,
    port: Number(e.PORT || 3000),
    dataDir: e.DATA_DIR || path.join(ROOT, 'data'),
    rateLimitPerHour: Number(e.AUDIT_RATE_LIMIT_PER_HOUR || 20),
    allowPrivateUrls: e.ALLOW_PRIVATE_URLS === 'true', // only for local tests
    llm: {
      apiKey: e.LLM_API_KEY || '',
      baseUrl: strip(e.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'),
      model: e.LLM_MODEL || 'gemini-2.5-flash',
      retryMs: Math.max(0, Number(e.LLM_RETRY_MS ?? 6000)), // base wait before retrying a "too many requests" answer
      // Model calls per minute. Free tiers are strict, so Gemini's endpoint defaults to 10; set LLM_RPM=0 for no limit.
      rpm: e.LLM_RPM !== undefined && e.LLM_RPM !== '' ? Math.max(0, Number(e.LLM_RPM) || 0) : (/generativelanguage\.googleapis\.com/.test(e.LLM_BASE_URL || 'generativelanguage.googleapis.com') ? 10 : 0),
    },
    // Judge mode: organise a whole competition, rank every entry and pay the prizes.
    organizerKey: e.ORGANIZER_KEY || '',
    competitions: {
      maxProjectsDefault: Math.max(1, Number(e.MAX_PROJECTS_DEFAULT || 10)),
      maxProjectsHard: Math.max(1, Number(e.MAX_PROJECTS_HARD || 50)), // protects a small server; raise it on a bigger one
      concurrency: Math.max(1, Math.min(4, Number(e.EVAL_CONCURRENCY || 2))),
      maxPayout: Number(e.MAX_PAYOUT_PER_PRIZE || 5000),
      allowLivePayouts: e.ALLOW_LIVE_PAYOUTS === 'true', // payouts are sandbox only unless this is set on purpose
    },
    github: {
      token: e.GITHUB_TOKEN || '',
      apiBase: strip(e.GITHUB_API_BASE || 'https://api.github.com'),
      rawBase: strip(e.GITHUB_RAW_BASE || 'https://raw.githubusercontent.com'),
    },
    youtubeOembedBase: strip(e.YOUTUBE_OEMBED_BASE || 'https://www.youtube.com/oembed'),
    youtube: {
      // Optional: lets the Legal agent verify the video is PUBLIC and UNDER 3 MINUTES automatically.
      apiKey: e.YOUTUBE_API_KEY || '',
      apiBase: strip(e.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3'),
    },
    paypal: {
      clientId: e.PAYPAL_CLIENT_ID || '',
      clientSecret: e.PAYPAL_CLIENT_SECRET || '',
      // Always the SANDBOX host unless overridden (the override exists for automated tests).
      apiBase: strip(e.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com'),
      price: e.CERT_PRICE_USD || '2.00',
      currency: 'USD',
      // How orders reach PayPal: "auto" = PayPal AI Toolkit first with the direct Orders API as a safety net,
      // "toolkit" = toolkit only, "rest" = direct Orders API only.
      via: ['auto', 'toolkit', 'rest'].includes(String(e.PAYPAL_VIA || '').trim().toLowerCase()) ? String(e.PAYPAL_VIA).trim().toLowerCase() : 'auto',
      toolkit: {
        // Advanced and for tests: run a different MCP server instead of "npx -y @paypal/mcp". ARGS is a JSON array.
        command: e.PAYPAL_MCP_COMMAND || '',
        args: e.PAYPAL_MCP_ARGS || '',
        startMs: Number(e.PAYPAL_TOOLKIT_START_MS || 120000), // the very first start downloads the package from npm
        waitMs: Number(e.PAYPAL_TOOLKIT_WAIT_MS || 6000), // a payment never waits longer than this for the toolkit
        callMs: Number(e.PAYPAL_TOOLKIT_CALL_MS || 30000), // longest a single toolkit call (create or capture) may take
      },
    },
    // Where buyers come back to after PayPal (sent to PayPal as the return and cancel address).
    publicUrl: strip(e.PUBLIC_URL || e.RENDER_EXTERNAL_URL || `http://localhost:${Number(e.PORT || 3000)}`),
    certSecret: e.CERT_SECRET || '',
    zapierUrl: e.ZAPIER_WEBHOOK_URL || '',
    elastic: {
      url: e.ELASTIC_URL ? strip(e.ELASTIC_URL) : '',
      apiKey: e.ELASTIC_API_KEY || '',
      index: e.ELASTIC_INDEX || 'judgemint-audits', // single-entry audits
      entriesIndex: e.ELASTIC_ENTRIES_INDEX || 'judgemint-entries', // the entries of a finalised competition
    },
  };
}
