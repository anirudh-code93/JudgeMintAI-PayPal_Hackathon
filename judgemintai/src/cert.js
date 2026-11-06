import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

// The signing secret comes from CERT_SECRET, or is generated once and kept in ./data/.cert_secret
function secret() {
  const c = cfg();
  if (c.certSecret) return c.certSecret;
  const f = path.join(c.dataDir, '.cert_secret');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    fs.mkdirSync(c.dataDir, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

function payloadString(p) {
  return [p.auditId, p.repo, p.score, p.verdict, p.issuedAt, p.paypalOrderId].join('|');
}

export function signCertificate({ auditId, repo, score, verdict, paypalOrderId }) {
  const issuedAt = new Date().toISOString();
  const payload = { auditId, repo, score, verdict, issuedAt, paypalOrderId };
  const signature = crypto.createHmac('sha256', secret()).update(payloadString(payload)).digest('hex');
  return { ...payload, signature, serial: `JM-${signature.slice(0, 12).toUpperCase()}` };
}

export function verifyCertificate(cert) {
  if (!cert?.signature) return false;
  const expected = crypto.createHmac('sha256', secret()).update(payloadString(cert)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(cert.signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
