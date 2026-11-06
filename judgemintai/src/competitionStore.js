import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

// Competitions live in one JSON file next to the audits (fine for a demo; swap for a database when it grows).
// Entry emails (for prize payments) are stored here, so keep the data folder private.
let cache = null;
let timer = null;

const file = () => path.join(cfg().dataDir, 'competitions.json');

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { cache = {}; }
  // Work that was in flight when the server stopped cannot finish by itself: say so, so the organiser can re-run it.
  for (const c of Object.values(cache)) {
    for (const p of c.projects || []) {
      if (p.status === 'queued' || p.status === 'running') { p.status = 'interrupted'; p.error = 'The server restarted while this entry was being evaluated. Evaluate it again.'; }
    }
    for (const z of c.prizes || []) {
      if (z.status === 'sending') { z.status = 'unknown'; z.error = 'The server restarted while this payment was being sent. It is safe to try again: PayPal ignores a repeated request.'; }
    }
  }
  return cache;
}

function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(cfg().dataDir, { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
    } catch (err) {
      console.error('Could not persist competitions:', err.message);
    }
  }, 150);
}

export function saveCompetition(c) {
  c.updatedAt = new Date().toISOString();
  load()[c.id] = c;
  persist();
  return c;
}
export const getCompetition = (id) => load()[id] || null;
export const listCompetitions = () => Object.values(load()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
export function deleteCompetition(id) { delete load()[id]; persist(); }

export function flushCompetitions() {
  clearTimeout(timer);
  if (!cache) return;
  fs.mkdirSync(cfg().dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}
export function _resetCompetitionsForTests() { cache = null; }
