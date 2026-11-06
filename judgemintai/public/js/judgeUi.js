import { el, icon } from './util.js';
import { japi, setKey, getJudge, setJudge } from './judgeApi.js';
import { field } from './judgeForms.js';

// Shared pieces of the Judge mode screens: the hooks into the main app, sign-in, messages and small formatting helpers.

/** Filled in by initJudge(): { show, navigate, token, reroute, config, refreshConfig, root } */
export const app = { show: () => {}, navigate: () => {}, token: () => 0, reroute: () => {}, config: () => null, refreshConfig: async () => null, root: null };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const stale = (token) => token !== app.token();
export const setPage = (...nodes) => app.root.replaceChildren(...nodes.filter(Boolean));

// ---------------------------------------------------------------- sign-in and errors
export function showSignIn(message = '') {
  const key = el('input', { id: 'j-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the organiser key' });
  const name = el('input', { id: 'j-name', type: 'text', maxlength: 60, autocomplete: 'name', value: getJudge(), placeholder: 'For example: Ana Lopez' });
  const error = el('p', { class: 'alert', role: 'alert', hidden: !message }, message);
  const go = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Open Judge mode');
  const form = el('form', { class: 'slip signin', novalidate: '' },
    el('h2', {}, 'Organiser sign-in'),
    el('p', { class: 'slip__intro' }, 'Judge mode shows entry emails and can send prize money, so it needs the organiser key. The server prints the key when it starts and saves it in data/.organizer_key. You can choose your own with ORGANIZER_KEY in the .env file.'),
    error,
    field('Organiser key', key),
    field('Your name', name, 'Shown next to every decision you make in the log.'),
    el('div', { class: 'slip__actions' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = key.value.trim();
    if (!value) { error.textContent = 'Paste the organiser key first.'; error.hidden = false; key.focus(); return; }
    go.disabled = true;
    setKey(value);
    setJudge(name.value);
    try {
      await japi('/api/organizer/check', { method: 'POST', body: {} });
      app.reroute();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      go.disabled = false;
      key.focus();
    }
  });
  setPage(el('div', { class: 'wrap jcenter' }, form));
  key.focus({ preventScroll: true });
}

/** Show a failed load: the sign-in form when the key is missing or wrong, otherwise the message and a retry button. */
export function showFailure(err, token) {
  if (stale(token)) return;
  if (err.auth) return showSignIn(err.message);
  const again = el('button', { class: 'btn btn--quiet', type: 'button' }, 'Try again');
  again.addEventListener('click', () => app.reroute());
  setPage(el('div', { class: 'wrap narrow jcenter' },
    el('p', { class: 'alert', role: 'alert' }, err.status === 404 ? 'That competition or entry was not found. It may have been deleted.' : err.message),
    el('p', { class: 'jactions' }, el('a', { href: '/competitions', 'data-link': '', class: 'btn btn--quiet' }, 'All competitions'), again)));
}

export function judgeBar() {
  const name = el('input', { type: 'text', value: getJudge(), maxlength: 60, placeholder: 'Your name', autocomplete: 'name' });
  name.addEventListener('change', () => setJudge(name.value));
  const out = el('button', { type: 'button', class: 'btn btn--quiet btn--small' }, 'Sign out');
  out.addEventListener('click', () => { setKey(''); app.navigate('/competitions'); });
  return el('div', { class: 'judgebar' }, el('label', {}, 'Judging as', name), out);
}

// ---------------------------------------------------------------- messages
/** A message area. set({ tone: 'ok' | 'warn' | 'error', lines: [text] }) shows one; set(null) clears it. */
export function messageArea() {
  const host = el('div', { class: 'noticehost' });
  return {
    node: host,
    set(n) {
      if (!n) { host.replaceChildren(); return; }
      const close = el('button', { type: 'button', class: 'notice__x', 'aria-label': 'Dismiss this message' }, '×');
      close.addEventListener('click', () => host.replaceChildren());
      host.replaceChildren(el('div', { class: `notice notice--${n.tone || 'ok'}`, role: n.tone === 'error' ? 'alert' : 'status' },
        el('div', {}, n.lines.map((line) => el('p', {}, line))), close));
    },
  };
}

/**
 * Build the function every action goes through: it clears the message area, runs the request, hands the returned competition to
 * apply(), and shows `done` (a text, or a function returning { tone, lines } or a text) or the error.
 */
export function makeRunner(msg, apply) {
  return async function run(task, { done } = {}) {
    msg.set(null);
    try {
      const res = await task();
      if (res?.competition) apply(res.competition);
      if (done) {
        const m = typeof done === 'function' ? done(res) : done;
        if (m) msg.set(typeof m === 'string' ? { tone: 'ok', lines: [m] } : m);
      }
      return res;
    } catch (err) {
      if (err.auth) { showSignIn(err.message); return null; }
      msg.set({ tone: 'error', lines: [err.message] });
      msg.node.scrollIntoView?.({ block: 'nearest' });
      return null;
    }
  };
}

/** Turn the server's import report into a message. */
export function importMessage(imported) {
  if (!imported) return null;
  const lines = [`Added ${imported.added} ${imported.added === 1 ? 'entry' : 'entries'}.`];
  for (const n of imported.notes || []) lines.push(n);
  const skipped = imported.skipped || [];
  if (skipped.length) lines.push(`Skipped ${skipped.length}: ${skipped.slice(0, 4).map((s) => `${s.row} (${s.reason})`).join('; ')}${skipped.length > 4 ? '; …' : ''}`);
  return { tone: imported.added ? 'ok' : 'warn', lines };
}

// ---------------------------------------------------------------- words and formatting
export const COMP_STATUS = { draft: 'No entries yet', ready: 'Ready for judging', evaluating: 'Evaluating', finalised: 'Finalised' };
export const PROJECT_STATUS = {
  pending: 'Not evaluated', queued: 'Waiting', running: 'Evaluating', done: 'Evaluated', error: 'Could not be evaluated', interrupted: 'Interrupted', cancelled: 'Cancelled',
};
export const PRIZE_STATUS = {
  unpaid: ['na', 'Not paid yet'],
  sending: ['warn', 'Sending'],
  sent: ['warn', 'Sent, waiting for PayPal to confirm'],
  paid: ['pass', 'Paid'],
  unclaimed: ['warn', 'Sent, not claimed yet'],
  failed: ['fail', 'PayPal refused it'],
  unknown: ['fail', 'Not sure it went through'],
};

export const shortRepo = (url) => String(url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, '').replace(/\/+$/, '');
export const money = (amount, currency) => `${Number(amount).toFixed(2)} ${currency}`;
export const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`;
export const num = (x) => (x == null ? '–' : String(Math.round(Number(x) * 10) / 10));

export function kv(label, value) {
  return el('div', {}, el('dt', {}, label), el('dd', {}, value));
}

export function pill(tone, text) {
  return el('span', { class: `chip chip--${tone}` }, icon(tone), text);
}

/** Short warnings shown next to an entry in the leaderboard. tone: fail = keeps it from being ranked or breaks a rule, warn = look at it, info = status. */
export function flagsOf(p) {
  const out = [];
  const add = (tone, text) => out.push({ tone, text });
  if (p.judge?.disqualified) add('fail', 'Disqualified by judges');
  else if (p.judge?.reinstated && p.status === 'done') add('info', 'Reinstated by judges');
  if (p.status !== 'done') {
    add(['error', 'interrupted', 'cancelled'].includes(p.status) ? 'fail' : 'info', PROJECT_STATUS[p.status] || p.status);
    return out;
  }
  if (p.facts?.verdict === 'FAIL') add('fail', 'Audit failed');
  else if (p.facts?.verdict === 'NEEDS REVIEW') add('warn', 'Audit says needs review');
  if (p.facts?.injection) add('fail', 'Text aimed at AI judges');
  const seen = new Set();
  for (const d of p.duplicates || []) {
    const key = `${d.kind}|${d.otherId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (d.kind === 'repo') add('fail', `Same repository as ${d.otherName}`);
    else if (d.kind === 'fork') add(d.role === 'copy' ? 'fail' : 'warn', d.role === 'copy' ? `Fork of ${d.otherName}` : `Forked by ${d.otherName}`);
    else if (d.kind === 'code') add(d.severity === 'high' && d.role === 'copy' ? 'fail' : 'warn', d.role === 'copy' ? `Copied from ${d.otherName}` : d.role === 'original' ? `Copied by ${d.otherName}` : `Code matches ${d.otherName}`);
    else if (d.kind === 'text') add('warn', `Text matches ${d.otherName}`);
    else if (d.kind === 'video') add('warn', `Same video as ${d.otherName}`);
    else if (d.kind === 'demo') add('warn', `Same demo as ${d.otherName}`);
  }
  if ((p.ruleChecks || []).some((r) => r.status === 'fail')) add('fail', 'Breaks a custom rule');
  else if ((p.ruleChecks || []).some((r) => r.status === 'warn')) add('warn', 'Unsure about a custom rule');
  return out;
}
