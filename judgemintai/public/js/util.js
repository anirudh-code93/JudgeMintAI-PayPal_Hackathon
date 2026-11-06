// Small DOM + fetch helpers. All dynamic content goes through textContent (never innerHTML),
// because audit data contains text copied from other people's repositories.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, String(value));
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the JudgeMintAI server. Check that it is running and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const AGENT_LABEL = {
  technical: 'Technical',
  paypal: 'PayPal',
  apis: 'Required tech',
  ai: 'AI',
  legal: 'Legal',
  submission: 'Submission',
  sponsors: 'Sponsor tools',
};

export const VERDICT = {
  PASS: { key: 'pass', label: 'Pass', word: 'PASS' },
  'NEEDS REVIEW': { key: 'review', label: 'Needs review', word: 'REVIEW' },
  FAIL: { key: 'fail', label: 'Fail', word: 'FAIL' },
};

export function verdictInfo(verdict) {
  return VERDICT[verdict] || { key: 'review', label: String(verdict || 'Unknown'), word: '—' };
}

export function scoreBand(score) {
  if (score == null) return 'na';
  return score >= 80 ? 'pass' : score >= 60 ? 'review' : 'fail';
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
}

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// localStorage can throw (private windows, blocked storage), so it is only ever a convenience.
export function remember(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
export function recall(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function safeHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// Small inline icons. Shape (not only colour) tells pass / warn / fail apart.
const ICONS = {
  pass: 'M3.5 8.5l3 3 6-7',
  warn: 'M8 3.2v6M8 12.3v.2',
  fail: 'M4 4l8 8M12 4l-8 8',
  na: 'M4 8h8',
};
export function icon(kind) {
  return svg('svg', { class: 'icon', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: ICONS[kind] || ICONS.na, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

const STATUS_TEXT = { pass: 'Passed', warn: 'Warning', fail: 'Failed', na: 'Not checked' };
export function statusChip(status) {
  return el('span', { class: `chip chip--${status}` }, icon(status), STATUS_TEXT[status] || status);
}

const SEV_TEXT = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
export function severityText(sev) {
  return SEV_TEXT[sev] || sev;
}
