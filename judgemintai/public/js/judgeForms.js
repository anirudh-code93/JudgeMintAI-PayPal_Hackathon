import { el } from './util.js';

// Reusable form parts for Judge mode: rules, criteria, entry import, prizes and a confirmation dialog.
// Every part returns { node, read() }: read() gives back what the organiser typed, in the shape the server expects.

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

export function field(label, control, hint) {
  if (!control.id) control.id = nextId('f');
  const hintId = hint ? `${control.id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return el('div', { class: 'field' }, el('label', { for: control.id }, label), control, hint ? el('p', { class: 'hint', id: hintId }, hint) : null);
}

export const textInput = (props = {}) => el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...props });
export const area = (props = {}) => el('textarea', { rows: 4, spellcheck: 'false', ...props });

export function check(label, checked, hint) {
  const box = el('input', { type: 'checkbox', checked: Boolean(checked) });
  return { box, node: el('label', { class: 'check' }, box, el('span', {}, label, hint ? el('small', {}, hint) : null)) };
}

function select(options, value) {
  return el('select', {}, options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));
}

const lines = (text) => String(text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
const names = (text) => String(text || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- rules
export function rulesFields(rules = {}) {
  const tech = textInput({ value: (rules.requiredTech || []).map((t) => t.name).join(', '), placeholder: 'Stripe, Twilio', maxlength: 200 });
  const mode = select([['any', 'at least one of them'], ['all', 'all of them']], rules.techMode === 'all' ? 'all' : 'any');
  const theme = textInput({ value: rules.theme || '', placeholder: 'For example: tools that help small shops and communities', maxlength: 300 });
  const sandbox = check('Entries must use the technology in test or sandbox mode', rules.requireSandbox);
  const ai = check('Entries must meaningfully use AI', rules.requireAi);
  const licence = check('Public repository with a visible open-source licence', rules.requireLicense ?? true);
  const video = check('A public demo video is required', rules.requireVideo);
  const minutes = el('input', { type: 'number', min: 0.5, max: 60, step: 0.5, value: Math.round(((rules.videoMaxSeconds || 180) / 60) * 10) / 10, 'aria-label': 'Longest allowed video, in minutes' });
  const demo = check('A hosted demo or complete run instructions', rules.requireDemoOrRunSteps ?? true);
  const from = el('input', { type: 'date', value: rules.windowStart || '' });
  const to = el('input', { type: 'date', value: rules.windowEnd || '' });
  const sponsors = textInput({ value: Array.isArray(rules.sponsors) ? rules.sponsors.map((s) => s.name).join(', ') : '', placeholder: 'Acme Cloud, Example DB', maxlength: 400 });
  const custom = area({ rows: 3, value: '', maxlength: 2400, placeholder: 'One rule per line, for example:\nEntries must not use paid APIs\nTeams have at most four members' });
  custom.value = (rules.customRules || []).join('\n');

  const node = el('div', { class: 'rules' },
    field('Theme (optional)', theme, 'What the event is about. Unless you edit the criteria yourself, entries are also scored on how well they fit it.'),
    el('div', { class: 'row2' },
      field('Technology or APIs entries must use', tech, 'Names only. Well-known ones (Stripe, Twilio, OpenAI, Google Maps, …) are recognised in the code automatically. Leave empty if there is none.'),
      field('Entries must use', mode)),
    el('div', { class: 'checks' }, sandbox.node, ai.node, licence.node, demo.node),
    el('div', { class: 'checks checks--video' }, video.node, el('label', { class: 'inline' }, 'at most ', minutes, ' minutes')),
    el('div', { class: 'row2' },
      field('Work must happen from', from, 'Optional. Entries with all their commits before this date are flagged.'),
      field('until', to)),
    field('Sponsor tools to look for (optional)', sponsors, 'The audit checks which of these an entry really wires in, and ignores name-dropping.'),
    field('Other rules (optional)', custom, 'An AI model reads each entry against these rules. Without an AI key they are listed for a judge to check by hand.'));

  return {
    node,
    read: () => ({
      theme: theme.value.trim(),
      requiredTech: names(tech.value),
      techMode: mode.value,
      requireSandbox: sandbox.box.checked,
      requireAi: ai.box.checked,
      requireLicense: licence.box.checked,
      requireVideo: video.box.checked,
      videoMaxSeconds: Math.round((Number(minutes.value) || 3) * 60),
      requireDemoOrRunSteps: demo.box.checked,
      windowStart: from.value,
      windowEnd: to.value,
      sponsors: names(sponsors.value),
      customRules: lines(custom.value),
    }),
  };
}

// ---------------------------------------------------------------- criteria
export function criteriaEditor(criteria, { disabled = false } = {}) {
  const tbody = el('tbody');
  const total = el('p', { class: 'hint', role: 'status' });
  const MAX = 12;
  let add;

  const refresh = () => {
    const rows = [...tbody.children];
    const sum = rows.reduce((s, tr) => s + (Number(tr.querySelector('.crit-w').value) || 0), 0);
    for (const tr of rows) {
      const w = Number(tr.querySelector('.crit-w').value) || 0;
      tr.querySelector('.crit-share').textContent = sum ? `${Math.round((100 * w) / sum)}%` : '–';
    }
    total.textContent = `${rows.length} ${rows.length === 1 ? 'criterion' : 'criteria'}. Only the proportions between the weights matter.`;
    if (add) add.disabled = disabled || rows.length >= MAX;
  };

  const row = (c = {}) => {
    const name = textInput({ class: 'crit-n', value: c.name || '', maxlength: 40, 'aria-label': 'Criterion name', placeholder: 'Name', disabled });
    const weight = el('input', { class: 'crit-w', type: 'number', min: 0, max: 100, step: 1, value: c.weight ?? 10, 'aria-label': 'Weight', disabled });
    const desc = textInput({ class: 'crit-d', value: c.description || '', maxlength: 200, 'aria-label': 'What the judges look for', placeholder: 'What the judges look for', disabled });
    const share = el('span', { class: 'crit-share muted', 'aria-hidden': 'true' });
    const remove = el('button', { type: 'button', class: 'btn btn--quiet btn--small', disabled }, 'Remove');
    const tr = el('tr', { 'data-id': c.id || '' }, el('td', { 'data-label': 'Criterion' }, name), el('td', { 'data-label': 'Weight' }, weight), el('td', { 'data-label': 'Share' }, share),
      el('td', { 'data-label': 'What the judges look for' }, desc), el('td', {}, remove));
    weight.addEventListener('input', refresh);
    remove.addEventListener('click', () => { tr.remove(); refresh(); });
    return tr;
  };
  for (const c of criteria) tbody.append(row(c));

  add = el('button', { type: 'button', class: 'btn btn--quiet btn--small', disabled }, 'Add a criterion');
  add.addEventListener('click', () => { const tr = row({ weight: 10 }); tbody.append(tr); refresh(); tr.querySelector('.crit-n').focus(); });
  refresh();

  const th = (t) => el('th', { scope: 'col' }, t);
  const node = el('div', { class: 'criteria' },
    el('table', { class: 'crit' }, el('thead', {}, el('tr', {}, th('Criterion'), th('Weight'), th('Share'), th('What the judges look for'), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Remove')))), tbody),
    el('div', { class: 'crit-foot' }, add, total));

  return {
    node,
    read: () => [...tbody.children].map((tr) => ({
      id: tr.dataset.id || undefined,
      name: tr.querySelector('.crit-n').value.trim(),
      description: tr.querySelector('.crit-d').value.trim(),
      weight: Number(tr.querySelector('.crit-w').value) || 0,
    })).filter((c) => c.name),
  };
}

// ---------------------------------------------------------------- import
const SOURCES = [
  ['text', 'Paste a list'],
  ['csv', 'CSV file'],
  ['json', 'JSON'],
  ['github', 'GitHub'],
];

export function importFields() {
  let kind = 'text';
  const text = area({ rows: 6, maxlength: 400000, placeholder: 'Alpha Pay | https://github.com/owner/alpha | https://alpha.onrender.com | https://youtu.be/… | winner@example.com\nhttps://github.com/owner/beta\n\nOne entry per line. Only the repository link is needed.' });
  const csv = area({ rows: 6, maxlength: 1_000_000, placeholder: 'Paste the CSV here, or choose the exported file above. Devpost exports work as they are.' });
  const file = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Choose a CSV file' });
  const fileNote = el('p', { class: 'hint', role: 'status' }, 'The file is read in your browser and sent to this server only when you press the button below.');
  const json = area({ rows: 6, maxlength: 1_000_000, placeholder: '[{ "name": "Alpha Pay", "repo": "https://github.com/owner/alpha", "description": "…", "email": "a@example.com" }]' });
  const owner = textInput({ maxlength: 39, placeholder: 'my-hackathon-org' });
  const topic = textInput({ maxlength: 50, placeholder: 'my-hackathon-2026' });

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 900_000) { fileNote.textContent = 'That file is over 900 KB, which is more than this server accepts. Split it or remove the long text columns.'; return; }
    csv.value = await f.text();
    fileNote.textContent = `Loaded ${f.name}. Check it below, then import.`;
  });

  const panes = {
    text: el('div', {}, field('Entries', text, 'Each line: name | repository | demo | video | PayPal email, in any order. A line with only a repository link works too.')),
    csv: el('div', {}, field('CSV file', file), csv, fileNote),
    json: el('div', {}, field('JSON list of entries', json, 'A list (or {"projects": [...]}) of objects with name, repo, demo, video, description, tools and email.')),
    github: el('div', { class: 'row2' },
      field('Every public repository of this user or organisation', owner, 'Forks are skipped. Each repository becomes one entry.'),
      field('or every repository with this topic', topic, 'Use either one. Topics are lowercase words with dashes.')),
  };

  const buttons = SOURCES.map(([k, label]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(k === kind) }, label);
    b.addEventListener('click', () => select_(k));
    return [k, b];
  });
  const paneHost = el('div', { class: 'importpane' }, panes[kind]);
  function select_(k) {
    kind = k;
    for (const [key, b] of buttons) b.setAttribute('aria-pressed', String(key === k));
    paneHost.replaceChildren(panes[k]);
  }

  const node = el('div', { class: 'import' },
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Where the entries come from' }, buttons.map(([, b]) => b)),
    paneHost);

  return {
    node,
    /** The `import` object the server takes, or null when nothing was entered. */
    read() {
      if (kind === 'text') return text.value.trim() ? { text: text.value } : null;
      if (kind === 'csv') return csv.value.trim() ? { csv: csv.value } : null;
      if (kind === 'json') return json.value.trim() ? { json: json.value } : null;
      if (owner.value.trim()) return { github: { owner: owner.value.trim() } };
      if (topic.value.trim()) return { github: { topic: topic.value.trim() } };
      return null;
    },
    clear() { text.value = ''; csv.value = ''; json.value = ''; owner.value = ''; topic.value = ''; file.value = ''; },
  };
}

// ---------------------------------------------------------------- prizes
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'SGD'];

export function prizeEditor(prizes, { entries = [], disabled = false } = {}) {
  const list = el('div', { class: 'prize-rows' });
  const MAX = 10;
  let add;

  const refresh = () => { if (add) add.disabled = disabled || list.children.length >= MAX; };

  const row = (z = {}) => {
    const label = textInput({ value: z.label || '', maxlength: 60, placeholder: 'First prize', 'aria-label': 'Prize name', disabled });
    const amount = el('input', { type: 'number', min: 0, step: '0.01', value: z.amount ?? '', placeholder: '100', 'aria-label': 'Amount', disabled });
    const cur = select(CURRENCIES.map((c) => [c, c]), z.currency || 'USD');
    cur.setAttribute('aria-label', 'Currency');
    if (disabled) cur.disabled = true;
    const place = el('input', { type: 'number', min: 1, max: 50, step: 1, value: z.place ?? '', placeholder: '1', 'aria-label': 'Place that wins it', disabled });
    const who = entries.length
      ? select([['', 'Whoever ranks at that place'], ...entries.map((e) => [e.id, `Always ${e.name}`])], z.place ? '' : (z.projectId || ''))
      : null;
    if (who) { who.setAttribute('aria-label', 'Give this prize to a specific entry'); if (disabled) who.disabled = true; }
    const remove = el('button', { type: 'button', class: 'btn btn--quiet btn--small', disabled }, 'Remove');
    const r = el('div', { class: 'prize-row', 'data-id': z.id || '' },
      el('div', { class: 'prize-row__main' }, label, amount, cur, el('label', { class: 'inline' }, 'Place', place), remove),
      who ? el('div', { class: 'prize-row__who' }, who) : null);
    remove.addEventListener('click', () => { r.remove(); refresh(); });
    r._read = () => {
      const specific = who?.value || '';
      return {
        id: r.dataset.id || undefined, label: label.value.trim(), amount: amount.value, currency: cur.value,
        place: specific ? null : (Number(place.value) || undefined), projectId: specific || undefined,
      };
    };
    return r;
  };
  for (const z of prizes) list.append(row(z));

  add = el('button', { type: 'button', class: 'btn btn--quiet btn--small', disabled }, 'Add a prize');
  add.addEventListener('click', () => { list.append(row({ label: `Prize ${list.children.length + 1}`, place: list.children.length + 1 })); refresh(); });
  refresh();

  return {
    node: el('div', { class: 'prizes-edit' }, list, el('div', { class: 'crit-foot' }, add)),
    /** Rows with an amount are prizes; empty rows are ignored. */
    read: () => [...list.children].map((r) => r._read()).filter((z) => String(z.amount).trim() !== ''),
  };
}

// ---------------------------------------------------------------- dialog
/**
 * Ask the organiser to confirm something that matters. `body` is a DOM node shown in the dialog.
 * Resolves true only when the confirm button is pressed.
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    if (typeof HTMLDialogElement === 'undefined' || typeof document.createElement('dialog').showModal !== 'function') {
      resolve(window.confirm(`${title}\n\n${body.textContent}`));
      return;
    }
    const dlg = el('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' },
      el('form', { method: 'dialog' },
        el('h2', { id: 'dlg-title' }, title),
        el('div', { class: 'dialog__body' }, body),
        el('div', { class: 'dialog__actions' },
          el('button', { class: 'btn btn--quiet', value: 'cancel', formnovalidate: true }, cancelLabel),
          el('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, value: 'ok', autofocus: true }, confirmLabel))));
    dlg.addEventListener('close', () => { const ok = dlg.returnValue === 'ok'; dlg.remove(); resolve(ok); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
