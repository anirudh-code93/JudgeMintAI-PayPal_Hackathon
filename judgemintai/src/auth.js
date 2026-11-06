import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { HttpError } from './http.js';

// Organiser access. Everything in Judge mode (competitions, rankings, judging, prize payments) needs the organiser key,
// sent as the X-Organizer-Key header. Set ORGANIZER_KEY yourself, or the server makes one on first start and keeps it in
// data/.organizer_key (it is printed in the console). Anyone holding the key can pay prizes, so treat it like a password.

let generated = { dir: '', key: '' };

export function organizerKey() {
  const set = cfg().organizerKey;
  if (set) return set;
  const dir = cfg().dataDir;
  if (generated.dir === dir && generated.key) return generated.key;
  const f = path.join(dir, '.organizer_key');
  let key = '';
  try { key = fs.readFileSync(f, 'utf8').trim(); } catch { /* first start */ }
  if (!key) {
    key = crypto.randomBytes(15).toString('base64url');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, `${key}\n`, { mode: 0o600 });
    } catch { /* read-only disk: the key then lasts until the server restarts */ }
  }
  generated = { dir, key };
  return key;
}

const same = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Too many wrong keys from one address in ten minutes: stop answering for a while (blocks guessing).
const failures = new Map();
const WINDOW = 10 * 60_000;
const MAX_FAILS = 10;

export function requireOrganizer(req, ip) {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < WINDOW);
  if (recent.length >= MAX_FAILS) throw new HttpError(429, 'Too many wrong organiser keys. Wait ten minutes and try again.');
  const given = String(req.headers['x-organizer-key'] || '');
  if (!given || !same(given, organizerKey())) {
    recent.push(now);
    failures.set(ip, recent);
    throw new HttpError(401, given ? 'That organiser key is not correct.' : 'This area needs the organiser key.');
  }
  failures.delete(ip);
}

export function _resetAuthForTests() { failures.clear(); generated = { dir: '', key: '' }; }
