import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

// Minimal JSON-file store: fine for a hackathon demo, trivially swappable for a DB later.
let cache = null;
let writeTimer = null;

function file() {
  return path.join(cfg().dataDir, 'audits.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = {};
  }
  // An audit that was mid-flight when the server stopped can never finish: say so instead of spinning forever.
  for (const a of Object.values(cache)) {
    if (a.status === 'queued' || a.status === 'running') {
      a.status = 'error';
      a.error = 'The server restarted while this audit was running. Run it again.';
      for (const s of a.progress || []) if (s.status === 'queued' || s.status === 'running') s.status = 'error';
    }
  }
  return cache;
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(cfg().dataDir, { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
    } catch (err) {
      console.error('Could not persist audits:', err.message);
    }
  }, 150);
}

export function saveAudit(audit) {
  load()[audit.id] = audit;
  persist();
  return audit;
}

export function getAudit(id) {
  return load()[id] || null;
}

export function listAudits(limit = 25) {
  return Object.values(load())
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);
}

export function flushNow() {
  clearTimeout(writeTimer);
  if (!cache) return;
  fs.mkdirSync(cfg().dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

export function _resetForTests() {
  cache = null;
}
