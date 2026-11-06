import { el, recall, remember } from './util.js';

// Judge mode talks to the server with the organiser key (the X-Organizer-Key header).
// The key lives in sessionStorage, so it is forgotten when the tab or browser closes. If storage is blocked it is kept in memory only.

const KEY = 'jm:organizerKey';
let memoryKey = '';

export function getKey() {
  try { return sessionStorage.getItem(KEY) || memoryKey; } catch { return memoryKey; }
}
export function setKey(value) {
  memoryKey = value || '';
  try { if (value) sessionStorage.setItem(KEY, value); else sessionStorage.removeItem(KEY); } catch { /* memory only */ }
}
export const getJudge = () => String(recall('jm:judge') || '');
export const setJudge = (name) => remember('jm:judge', String(name || '').trim().slice(0, 60));

export class AuthError extends Error {
  constructor(message) { super(message); this.auth = true; }
}

async function send(path, { method = 'GET', body } = {}) {
  const key = getKey();
  if (!key) throw new AuthError('Enter the organiser key to continue.');
  const judge = getJudge();
  const headers = { 'X-Organizer-Key': key };
  if (body) headers['Content-Type'] = 'application/json';
  if (judge && /^[\x20-\x7e]+$/.test(judge)) headers['X-Judge-Name'] = judge; // only plain ASCII may go in a header
  try {
    return await fetch(path, { method, headers, body: body ? JSON.stringify({ judge: judge || undefined, ...body }) : undefined });
  } catch {
    throw new Error('Could not reach the JudgeMintAI server. Check that it is running and try again.');
  }
}

async function failFrom(res) {
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401) { setKey(''); return new AuthError(data?.error || 'That organiser key was not accepted.'); }
  const err = new Error(data?.error || `Request failed (HTTP ${res.status}).`);
  err.status = res.status;
  return err;
}

export async function japi(path, opts = {}) {
  const res = await send(path, opts);
  if (!res.ok) throw await failFrom(res);
  try { return await res.json(); } catch { return {}; }
}

/** Download a file (the CSV export) with the key attached, which a plain link cannot do. */
export async function downloadFile(path, filename) {
  const res = await send(path);
  if (!res.ok) throw await failFrom(res);
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
