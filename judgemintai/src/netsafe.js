import dns from 'node:dns/promises';
import net from 'node:net';
import { cfg } from './config.js';

// Submitters give us URLs and our SERVER fetches them, so we must refuse private/local targets (SSRF).
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
  }
  return false;
}

export async function assertPublicUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (cfg().allowPrivateUrls) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('URL points to a private or local address');
  }
  return url;
}

// GET a URL with timeout, manual redirect handling (each hop re-checked) and a small body read.
export async function probeUrl(input, { timeoutMs = 8000, maxHops = 3 } = {}) {
  let current = input;
  for (let hop = 0; hop <= maxHops; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'JudgeMintAI/1.0 (hackathon submission audit)' },
    });
    const loc = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      current = new URL(loc, url).toString();
      try { await res.body?.cancel(); } catch {}
      continue;
    }
    let html = '';
    if ((res.headers.get('content-type') || '').includes('text/html')) {
      html = (await res.text()).slice(0, 20000);
    } else {
      try { await res.body?.cancel(); } catch {}
    }
    return { ok: res.status < 400, status: res.status, finalUrl: url.toString(), html };
  }
  throw new Error('Too many redirects');
}
