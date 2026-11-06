import { el, timeAgo } from './util.js';
import { japi, getKey } from './judgeApi.js';
import { field, textInput, check, rulesFields, criteriaEditor, importFields, prizeEditor } from './judgeForms.js';
import { app, stale, setPage, showSignIn, showFailure, judgeBar, importMessage, COMP_STATUS } from './judgeUi.js';
import { showCompetition, setPendingMessage } from './judgeDash.js';
import { showEntry } from './judgeEntry.js';

// Judge mode: the screens organisers and judges use to run a whole competition.
//   /competitions            all competitions
//   /competitions/new        create one
//   /c/<id>                  the leaderboard, prizes, rules and decision log
//   /c/<id>/p/<entry>        one entry: scores, evidence, adjustments, decision

export function initJudge({ show, navigate, token, reroute, config, refreshConfig }) {
  Object.assign(app, { show, navigate, token, reroute, config, refreshConfig, root: document.querySelector('#judge-root') });
}

export function routeJudge(pathname, token) {
  let m;
  if ((m = pathname.match(/^\/c\/([a-f0-9]{12})\/p\/([a-f0-9]{8})$/))) return showEntry(m[1], m[2], token);
  if ((m = pathname.match(/^\/c\/([a-f0-9]{12})$/))) return showCompetition(m[1], token);
  if (pathname === '/competitions/new') return showNew(token);
  return showList(token);
}

// ---------------------------------------------------------------- list
async function showList(token) {
  app.show('judge', 'Competitions');
  if (!getKey()) return showSignIn('');
  setPage(el('div', { class: 'wrap' }, el('p', { class: 'muted jloading' }, 'Loading competitions')));
  let competitions;
  try { ({ competitions } = await japi('/api/competitions')); } catch (err) { return showFailure(err, token); }
  if (stale(token)) return;

  const head = el('div', { class: 'wrap jhead' },
    el('div', {},
      el('h1', {}, 'Judge a whole competition'),
      el('p', { class: 'lede' }, 'Bring in every entry of a hackathon or contest. JudgeMintAI checks which are real, spots copies, scores each one on your criteria and explains every rank. You keep the final say, and you can pay the winners through PayPal.')),
    el('a', { class: 'btn btn--primary', href: '/competitions/new', 'data-link': '' }, 'New competition'));

  let body;
  if (!competitions.length) {
    body = el('div', { class: 'empty' },
      el('h2', {}, 'No competitions yet'),
      el('p', {}, 'Create one, paste or upload the list of entries, and press evaluate. A first run with three or four entries takes a minute or two.'),
      el('a', { class: 'btn btn--primary', href: '/competitions/new', 'data-link': '' }, 'Create your first competition'));
  } else {
    const th = (t) => el('th', { scope: 'col' }, t);
    body = el('table', { class: 'recent comps' },
      el('thead', {}, el('tr', {}, th('Competition'), th('Status'), th('Entries'), th('Prizes'), th('Created'))),
      el('tbody', {}, competitions.map((c) => el('tr', {},
        el('td', { 'data-label': 'Competition' }, el('a', { href: `/c/${c.id}`, 'data-link': '' }, c.name)),
        el('td', { 'data-label': 'Status' }, el('span', { class: `status status--${c.status}` }, COMP_STATUS[c.status] || c.status)),
        el('td', { 'data-label': 'Entries' }, c.entries ? `${c.evaluated} of ${c.entries} evaluated` : 'None yet'),
        el('td', { 'data-label': 'Prizes' }, c.prizes ? String(c.prizes) : 'None'),
        el('td', { 'data-label': 'Created' }, timeAgo(c.createdAt))))));
  }
  setPage(head, el('div', { class: 'wrap jbody' }, judgeBar(), body));
}

// ---------------------------------------------------------------- create
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sig = (list) => (list || []).map((c) => [c.name, Number(c.weight), c.description || '']);

async function showNew(token) {
  app.show('judge', 'New competition');
  if (!getKey()) return showSignIn('');
  const config = (await app.refreshConfig()) || {};
  if (stale(token)) return;
  const lim = config.competitions || {};
  const hard = lim.maxProjectsHard || 50;
  const defaults = lim.defaultCriteria || [];

  const err = el('p', { class: 'alert', role: 'alert', hidden: true });
  const fail = (text, focus) => { err.textContent = text; err.hidden = !text; err.scrollIntoView({ block: 'nearest' }); focus?.focus(); };

  const name = textInput({ id: 'n-name', maxlength: 80, placeholder: 'For example: Campus Hack 2026' });
  const any = el('input', { type: 'radio', name: 'preset', value: 'generic', checked: true });
  const pp = el('input', { type: 'radio', name: 'preset', value: 'paypal' });
  const presets = el('div', { class: 'presets', role: 'radiogroup', 'aria-label': 'Which rules to use' },
    el('label', { class: 'preset' }, any, el('span', {}, el('strong', {}, 'Any hackathon or competition'), el('small', {}, 'You choose the rules: which technology entries must use, AI, licence, video, dates and rules of your own.'))),
    el('label', { class: 'preset' }, pp, el('span', {}, el('strong', {}, 'The PayPal hackathon'), el('small', {}, 'Build What’s Next with PayPal and AI: a real PayPal sandbox integration, AI required, public licence, a video of at most 3 minutes, and the ten sponsor tools.'))));

  const rules = rulesFields({});
  const rulesBlock = el('fieldset', { class: 'group' }, el('legend', {}, 'Rules entries must follow'), rules.node);
  const ppNote = el('p', { class: 'block__lede', hidden: true }, 'The PayPal hackathon rules are fixed, so there is nothing to set here. Every entry is checked for a working PayPal sandbox payment flow, real AI use, a public repository with a licence, and a short public video.');
  const syncPreset = () => { rulesBlock.hidden = pp.checked; ppNote.hidden = !pp.checked; };
  any.addEventListener('change', syncPreset);
  pp.addEventListener('change', syncPreset);

  const criteria = criteriaEditor(defaults);
  const baseline = sig(defaults);
  const auditPct = el('input', { id: 'n-audit', type: 'number', min: 0, max: 50, step: 5, value: 20 });
  const limit = el('input', { id: 'n-limit', type: 'number', min: 1, max: hard, step: 1, value: Math.min(lim.maxProjectsDefault || 10, hard) });
  const importer = importFields();
  const start = check('Start evaluating as soon as the competition is created', true);
  const prizes = prizeEditor([{ label: 'First prize', place: 1, currency: 'USD' }]);

  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Create competition');
  const form = el('form', { class: 'jform', novalidate: '' },
    err,
    el('fieldset', { class: 'group' }, el('legend', {}, '1. The event'),
      field('Name', name), presets, ppNote, rulesBlock),
    el('fieldset', { class: 'group' }, el('legend', {}, '2. How entries are ranked'),
      el('p', { class: 'block__lede' }, 'Each entry is scored 0 to 10 on every criterion. The weights decide how much each one counts. Change, remove or add criteria to suit the event; judges can still adjust any score later.'),
      criteria.node,
      field('How much the audit counts (%)', auditPct, 'The audit checks that the entry is real and follows the rules. The rest of the final score comes from the criteria above. Up to 50.')),
    el('fieldset', { class: 'group' }, el('legend', {}, '3. The entries'),
      field('How many entries to evaluate at most', limit, `This server allows up to ${hard}. Entries over the limit are left out, and you can raise the limit later.`),
      importer.node,
      el('div', { class: 'checks' }, start.node)),
    el('fieldset', { class: 'group' }, el('legend', {}, '4. Prizes paid through PayPal (optional)'),
      el('p', { class: 'block__lede' }, 'A prize goes to whoever holds the place after the judges finalise the ranking. Leave the amount empty for a row you do not need. Payments run in the PayPal sandbox unless the server is set up for live PayPal.'),
      prizes.node),
    el('div', { class: 'slip__actions' }, submit, el('a', { class: 'btn btn--quiet', href: '/competitions', 'data-link': '' }, 'Cancel')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('');
    const nm = name.value.trim();
    if (!nm) return fail('Give the competition a name.', name);
    const body = { name: nm, preset: pp.checked ? 'paypal' : 'generic', maxProjects: Number(limit.value) || undefined };
    const weight = Math.max(0, Math.min(50, Number(auditPct.value) || 0)) / 100;
    body.rules = pp.checked ? { complianceWeight: weight } : { ...rules.read(), complianceWeight: weight };
    const crit = criteria.read();
    if (!crit.some((c) => c.weight > 0)) return fail('Give at least one criterion a weight above zero.');
    if (!same(sig(crit), baseline)) body.criteria = crit; // untouched criteria are left to the server, which adds "Fit to the theme" when you set a theme
    try { body.prizes = prizes.read(); } catch { /* ignore */ }
    const imp = importer.read();
    if (imp) body.import = imp;
    body.start = start.box.checked && Boolean(imp);
    submit.disabled = true;
    submit.textContent = imp ? 'Creating and importing' : 'Creating';
    try {
      const res = await japi('/api/competitions', { method: 'POST', body });
      setPendingMessage(importMessage(res.imported));
      app.navigate(`/c/${res.competition.id}`);
    } catch (e2) {
      if (e2.auth) return showSignIn(e2.message);
      fail(e2.message);
      submit.disabled = false;
      submit.textContent = 'Create competition';
    }
  });

  setPage(
    el('div', { class: 'wrap jhead' }, el('div', {}, el('h1', {}, 'New competition'), el('p', { class: 'lede' }, 'Tell JudgeMintAI what the event requires and how to rank. Everything here can be changed later, until you finalise the judgement.'))),
    el('div', { class: 'wrap jbody' }, judgeBar(), form));
  name.focus({ preventScroll: true });
}
