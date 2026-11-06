import { el, fmtDate, safeHttpUrl } from './util.js';
import { japi, getKey } from './judgeApi.js';
import { field, textInput, area, confirmDialog } from './judgeForms.js';
import {
  app, sleep, stale, setPage, showSignIn, showFailure, judgeBar, messageArea, makeRunner,
  PROJECT_STATUS, shortRepo, num, kv, pill, flagsOf,
} from './judgeUi.js';

// One entry: why it ranks where it does, every score with its source, the evidence, copies, and the judges' controls.

export async function showEntry(cid, pid, token) {
  app.show('judge', 'Entry');
  if (!getKey()) return showSignIn('');
  setPage(el('div', { class: 'wrap' }, el('p', { class: 'muted jloading' }, 'Loading the entry')));
  let view;
  try { view = (await japi(`/api/competitions/${cid}`)).competition; } catch (err) { return showFailure(err, token); }
  if (stale(token)) return;
  const p = view.projects.find((x) => x.id === pid);
  if (!p) return showFailure(Object.assign(new Error('That entry is not in this competition.'), { status: 404 }), token);
  app.show('judge', p.name);
  const page = buildEntry(view, pid, token);
  setPage(page.node);
  page.start();
}

function btn(label, kind, handler, extra = '') {
  const b = el('button', { type: 'button', class: `btn btn--${kind}${extra ? ` ${extra}` : ''}` }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await handler(); } finally { b.disabled = false; }
  });
  return b;
}

const block = (id, title, lede, ...body) => el('section', { class: 'block', 'aria-labelledby': id },
  el('h2', { id }, title), lede ? el('p', { class: 'block__lede' }, lede) : null, ...body);

const DUP_KIND = { code: 'Matching code', fork: 'Fork', repo: 'Same repository', text: 'Matching description or README', video: 'Same video', demo: 'Same demo' };
const DUP_ROLE = {
  copy: 'This entry looks like the copy, because its repository is newer.',
  original: 'This entry looks like the original, because its repository is older.',
  unknown: 'There is no clear way to tell which one came first.',
};
const RULE = { pass: ['pass', 'Meets it'], fail: ['fail', 'Breaks it'], warn: ['warn', 'Not sure'], unknown: ['na', 'Needs a human check'] };

function scoreBar(score10) {
  return el('div', { class: 'score' },
    el('span', { class: 'bar bar--neutral', role: 'img', 'aria-label': `${num(score10)} out of 10` }, el('span', { class: 'bar__fill', style: `width:${Math.max(0, Math.min(100, score10 * 10))}%` })),
    el('span', { class: 'score__num' }, num(score10)));
}

function sourceBadge(c) {
  if (c.source === 'ai') return el('span', { class: 'tag tag--ai' }, 'Judged by AI');
  const how = c.confidence === 'none' ? 'needs a judge' : `${c.confidence} confidence`;
  return el('span', { class: 'tag tag--est' }, `Estimate, ${how}`);
}

function buildEntry(initial, pid, token) {
  let view = initial;
  const cid = view.id;
  const msg = messageArea();
  const headHost = el('div');
  const bodyHost = el('div', { class: 'wrap' });
  const run = makeRunner(msg, (next) => apply(next));
  const api = (path, method = 'POST', body = {}) => japi(`/api/competitions/${cid}${path}`, { method, body });
  const me = () => view.projects.find((x) => x.id === pid);
  let polling = false;

  function apply(next) {
    view = next;
    if (!me()) { app.navigate(`/c/${cid}`); return; }
    render();
    poll();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      while (['queued', 'running'].includes(me()?.status) && !stale(token)) {
        await sleep(1500);
        if (stale(token)) break;
        try { apply((await japi(`/api/competitions/${cid}`)).competition); } catch (err) {
          if (err.auth) { showSignIn(err.message); return; }
          await sleep(2500);
        }
      }
    } finally { polling = false; }
  }

  // ------------------------------------------------------------ head
  function renderHead() {
    const p = me();
    const ranked = p.rank != null;
    const links = [
      [safeHttpUrl(p.repoUrl), shortRepo(p.repoUrl)],
      [safeHttpUrl(p.demoUrl), 'Demo'],
      [safeHttpUrl(p.videoUrl), 'Video'],
    ].filter(([href]) => href).map(([href, text]) => el('li', {}, el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)));
    if (p.auditId) links.push(el('li', {}, el('a', { href: `/a/${p.auditId}`, 'data-link': '' }, 'Full audit report')));
    const flags = flagsOf(p);
    headHost.replaceChildren(el('header', { class: 'wrap jhead jhead--entry' },
      el('div', { class: 'jhead__main' },
        el('p', { class: 'eyebrow' }, el('span', { class: `status status--${p.status === 'done' ? 'ready' : p.status}` }, PROJECT_STATUS[p.status] || p.status)),
        el('h1', { class: 'jtitle' }, p.name),
        el('ul', { class: 'meta' }, links),
        p.status === 'done' ? el('p', { class: 'jstatus' }, `Final score ${num(p.final)} out of 100. Merit ${num(p.merit)}, audit ${p.facts?.auditScore ?? '–'}.`) : null,
        flags.length ? el('ul', { class: 'flags' }, flags.map((f) => el('li', { class: `flag flag--${f.tone}` }, f.text))) : null),
      ranked
        ? el('div', { class: 'rankstamp', role: 'img', 'aria-label': `Rank ${p.rank} of ${view.order.length}` }, el('span', { class: 'rankstamp__label' }, 'Rank'), el('span', { class: 'rankstamp__no' }, String(p.rank)), el('span', { class: 'rankstamp__of' }, `of ${view.order.length}`))
        : el('div', { class: 'rankstamp rankstamp--none', role: 'img', 'aria-label': 'Not ranked' }, el('span', { class: 'rankstamp__no' }, '–'), el('span', { class: 'rankstamp__label' }, 'Not ranked'))));
  }

  // ------------------------------------------------------------ sections
  function whySection(p) {
    const ai = p.ai;
    const list = (title, items) => (items?.length ? el('div', {}, el('h3', {}, title), el('ul', {}, items.map((t) => el('li', {}, t)))) : null);
    const columns = ai ? [list('Strengths', ai.strengths), list('Weaknesses', ai.weaknesses), list('Points for the judges', ai.flags)].filter(Boolean) : [];
    return block('why-title', 'Why this rank', null,
      el('p', { class: 'why' }, p.why),
      p.summary ? el('p', {}, p.summary) : null,
      ai ? el('p', { class: 'hint' }, `Written by ${ai.model} from the pitch, the start of the README and the audit’s facts. The model never sees the source code.`) : null,
      p.aiError ? el('p', { class: 'hint' }, `The AI model could not score this entry (${p.aiError}), so the scores below are estimates. Review them before you rely on them.`) : null,
      columns.length ? el('div', { class: 'judge' }, columns) : null);
  }

  function scoresSection(p) {
    const finalised = Boolean(view.finalisedAt);
    const total = p.criteria.reduce((s, c) => s + c.weight, 0) || 1;
    const inputs = new Map();
    const rows = p.criteria.map((c) => {
      const input = el('input', { type: 'number', min: -5, max: 5, step: 0.5, value: c.delta || 0, disabled: finalised, 'aria-label': `Adjustment for ${c.name}, between minus 5 and plus 5` });
      inputs.set(c.id, input);
      const adj = p.judge?.adjustments?.[c.id];
      return el('tr', {},
        el('th', { scope: 'row' }, c.name, el('small', {}, `${Math.round((100 * c.weight) / total)}% of the merit score`)),
        el('td', { 'data-label': 'Score' }, scoreBar(c.score), c.delta ? el('p', { class: 'muted adjmath' }, `${num(c.base)} ${c.delta > 0 ? '+' : '−'} ${Math.abs(c.delta)} by judges`) : null),
        el('td', { 'data-label': 'Source' }, sourceBadge(c)),
        el('td', { 'data-label': 'Reason' }, c.reason, adj?.note ? el('p', { class: 'adjnote' }, `Note from ${adj.by || 'a judge'}: ${adj.note}`) : null),
        el('td', { 'data-label': 'Adjust' }, input));
    });
    const note = textInput({ maxlength: 200, placeholder: 'Why? (optional, kept in the decision log)', 'aria-label': 'Reason for the adjustment', disabled: finalised });
    const save = btn('Save adjustments', 'primary', async () => {
      const adjustments = {};
      for (const c of p.criteria) {
        const raw = Number(inputs.get(c.id).value);
        if (!Number.isFinite(raw)) continue;
        const delta = Math.max(-5, Math.min(5, Math.round(raw * 2) / 2));
        if (delta !== (c.delta || 0)) adjustments[c.id] = { delta, note: note.value.trim() };
      }
      if (!Object.keys(adjustments).length) { msg.set({ tone: 'warn', lines: ['No adjustment was changed.'] }); return; }
      await run(() => api(`/projects/${pid}/judge`, 'POST', { adjustments }), { done: 'Saved. The ranking follows the new scores.' });
    });
    const th = (t) => el('th', { scope: 'col' }, t);
    return block('scores-title', 'Scores', 'Each criterion is scored from 0 to 10. A judge can move any score by up to 5 points in half-point steps. The original score stays visible, and every change is written to the decision log.',
      el('table', { class: 'rubric scores' },
        el('thead', {}, el('tr', {}, th('Criterion'), th('Score'), th('Source'), th('Reason'), th('Adjust (−5 to +5)'))),
        el('tbody', {}, rows)),
      finalised ? el('p', { class: 'hint' }, 'The judgement is final, so scores are locked.') : el('div', { class: 'adjbar' }, note, save));
  }

  function rulesSection(p) {
    const f = p.facts || {};
    const items = [];
    for (const t of f.failedCritical || []) items.push(el('li', {}, pill('fail', 'Critical'), t));
    for (const t of f.failedHigh || []) items.push(el('li', {}, pill('fail', 'High'), t));
    const custom = (p.ruleChecks || []).map((r) => {
      const [tone, label] = RULE[r.status] || RULE.unknown;
      return el('li', {}, pill(tone, label), el('span', {}, r.rule, r.reason && r.status !== 'unknown' ? el('small', {}, r.reason) : null));
    });
    return block('rules-title', 'Checks against the rules', 'The audit checks each entry against the rules of this event. These are the checks that failed, then your own rules.',
      items.length ? el('ul', { class: 'checklist' }, items) : el('p', {}, p.status === 'done' ? 'No critical or high-severity audit check failed.' : 'Not evaluated yet.'),
      custom.length ? el('div', {}, el('h3', {}, 'Your own rules'), el('ul', { class: 'checklist' }, custom)) : null,
      el('details', { class: 'fold' }, el('summary', {}, 'All the rules of this event'), el('ul', { class: 'plainlist' }, view.rulesText.map((t) => el('li', {}, t)))),
      p.auditId ? el('p', {}, el('a', { href: `/a/${p.auditId}`, 'data-link': '' }, 'Open the full audit report with every check and its evidence')) : null);
  }

  function dupSection(p) {
    const dups = p.duplicates || [];
    const cards = dups.map((d) => el('li', { class: `dup dup--${d.severity}` },
      el('p', { class: 'dup__top' }, el('strong', {}, DUP_KIND[d.kind] || d.kind), ' with ', el('a', { href: `/c/${cid}/p/${d.otherId}`, 'data-link': '' }, d.otherName), pill(d.severity === 'high' ? 'fail' : 'warn', `${d.severity} severity`)),
      el('p', {}, d.note),
      ['code', 'fork'].includes(d.kind) ? el('p', { class: 'muted' }, DUP_ROLE[d.role] || DUP_ROLE.unknown) : null,
      ['code', 'fork'].includes(d.kind) && d.sharedFiles?.length ? el('p', { class: 'muted' }, `Identical files: ${d.sharedFiles.map((s) => s.a).join(', ')}`) : null));
    return block('dup-title', 'Copies and duplicates', 'Compared with every other entry in this competition, by code, wording, video and demo links. It cannot see code copied from outside this competition. Entries with high-severity copied code are left out of the ranking unless a judge reinstates them.',
      cards.length ? el('ul', { class: 'dups' }, cards) : el('p', {}, p.status === 'done' ? 'No copies or duplicates were found among the entries.' : 'Not evaluated yet.'));
  }

  function factsSection(p) {
    const f = p.facts;
    if (!f) return null;
    const r = f.repo || {};
    const list = (a) => (a && a.length ? a.join(', ') : 'none found');
    const rows = [
      kv('Audit', `${f.auditScore} out of 100, verdict ${f.verdict}`),
      r.fullName ? kv('Repository', `${r.fullName}${r.license ? `, licence ${r.license}` : ', no licence found'}${r.stars ? `, ${r.stars} ${r.stars === 1 ? 'star' : 'stars'}` : ''}`) : kv('Repository', 'Could not be read'),
      r.loc ? kv('Code', `about ${r.loc.toLocaleString('en-US')} lines in ${r.sourceFiles} source ${r.sourceFiles === 1 ? 'file' : 'files'} (${list(r.languages)}); ${r.testFiles ? `${r.testFiles} test ${r.testFiles === 1 ? 'file' : 'files'}` : 'no test files'}`) : null,
      r.commits != null ? kv('Activity', `${r.commits} commits by ${r.authors} ${r.authors === 1 ? 'person' : 'people'}${r.createdAt ? `; created ${fmtDate(r.createdAt)}` : ''}`) : null,
      kv('Demo', f.demoOk ? 'The hosted demo responds' : 'No working demo link'),
      kv('Video', f.video ? 'A valid video link was given' : 'No valid video link'),
      kv('AI used', list(f.aiProviders)),
      f.operations?.length ? kv('Payment operations', f.operations.join(', ')) : null,
      f.sponsors?.length ? kv('Sponsor tools wired in', f.sponsors.join(', ')) : null,
      f.hosts?.length ? kv('Other services called', f.hosts.slice(0, 8).join(', ')) : null,
    ].filter(Boolean);
    return block('facts-title', 'What the audit measured', 'Facts taken from the repository, the demo and the video. The scores above are built on these.', el('dl', { class: 'facts' }, rows));
  }

  function decisionSection(p) {
    const finalised = Boolean(view.finalisedAt);
    const j = p.judge || {};
    const comment = area({ rows: 3, maxlength: 1000, value: '', placeholder: 'Your notes on this entry for the other judges.', disabled: finalised });
    comment.value = j.comment || '';
    const reason = textInput({ maxlength: 200, placeholder: 'Reason (optional)', 'aria-label': 'Reason for disqualifying', disabled: finalised });
    const email = el('input', { type: 'email', value: p.payoutEmail || '', placeholder: 'winner@example.com', autocomplete: 'off' });

    const parts = [];
    parts.push(el('div', { class: 'decision' },
      el('h3', {}, 'Notes'),
      field('Comment', comment),
      btn('Save comment', 'quiet', () => run(() => api(`/projects/${pid}/judge`, 'POST', { comment: comment.value }), { done: 'Saved your comment.' }))));

    if (!finalised) {
      const stateBox = [];
      if (j.disqualified) stateBox.push(el('p', { class: 'alert' }, `Disqualified by ${j.by || 'a judge'}${j.reason ? `: ${j.reason}` : ''}.`));
      else if (!p.eligible && p.status === 'done') stateBox.push(el('div', { class: 'notice notice--warn' }, el('div', {}, el('p', {}, 'This entry is not ranked:'), el('ul', {}, p.reasons.map((t) => el('li', {}, t))))));
      else if (j.reinstated) stateBox.push(el('p', { class: 'hint' }, 'A judge reinstated this entry, overruling the automatic flags.'));
      const actions = [];
      if (j.disqualified || (!p.eligible && p.status === 'done')) {
        actions.push(btn(j.disqualified ? 'Reinstate this entry' : 'Rank it anyway (reinstate)', 'quiet', async () => {
          const body = el('div', {}, el('p', {}, 'The entry joins the ranking with its scores, and the decision is written to the log under your name.'));
          if (await confirmDialog({ title: `Reinstate ${p.name}?`, body, confirmLabel: 'Reinstate' })) await run(() => api(`/projects/${pid}/judge`, 'POST', { reinstate: true }), { done: 'Reinstated. The ranking has been updated.' });
        }));
      }
      if (!j.disqualified) {
        actions.push(el('div', { class: 'disq' }, reason, btn('Disqualify this entry', 'danger-quiet', async () => {
          const body = el('div', {}, el('p', {}, 'The entry is taken out of the ranking. You can reinstate it later, and the decision is written to the log under your name.'));
          if (await confirmDialog({ title: `Disqualify ${p.name}?`, body, confirmLabel: 'Disqualify', danger: true })) await run(() => api(`/projects/${pid}/judge`, 'POST', { disqualify: true, reason: reason.value }), { done: 'Disqualified. The ranking has been updated.' });
        })));
      }
      parts.push(el('div', { class: 'decision' }, el('h3', {}, 'Ranking decision'), ...stateBox, el('div', { class: 'decision__row' }, actions)));
    }

    parts.push(el('div', { class: 'decision' },
      el('h3', {}, 'Prize payment'),
      field('PayPal email of the winner', email, 'Prizes are sent to this address through PayPal. Entries imported without an email can get one here.'),
      btn('Save email', 'quiet', () => run(() => japi(`/api/competitions/${cid}/projects/${pid}`, { method: 'PATCH', body: { payoutEmail: email.value.trim() } }), { done: 'Saved the PayPal email.' }))));

    if (!finalised) {
      parts.push(el('div', { class: 'decision' },
        el('h3', {}, 'Entry'),
        el('div', { class: 'decision__row' },
          btn('Evaluate this entry again', 'quiet', () => run(() => api('/evaluate', 'POST', { projectIds: [pid] }), { done: 'Started evaluating this entry.' })),
          btn('Remove from the competition', 'danger-quiet', async () => {
            const body = el('div', {}, el('p', {}, `“${p.name}” is removed from the competition together with its scores and your notes. This cannot be undone.`));
            if (!(await confirmDialog({ title: 'Remove this entry?', body, confirmLabel: 'Remove it', danger: true }))) return;
            const res = await run(() => japi(`/api/competitions/${cid}/projects/${pid}`, { method: 'DELETE' }));
            if (res) app.navigate(`/c/${cid}`);
          }))));
    }
    return block('decision-title', 'The judges’ decision', finalised ? 'The judgement is final. Reopen it from the competition page to change a score or the ranking.' : 'Judges have the final say. Everything you change here is recorded in the decision log with your name.', ...parts);
  }

  function pager() {
    const p = me();
    if (p.rank == null) return null;
    const at = view.order.indexOf(pid);
    const named = (id) => view.projects.find((x) => x.id === id);
    const prev = at > 0 ? named(view.order[at - 1]) : null;
    const next = at < view.order.length - 1 ? named(view.order[at + 1]) : null;
    return el('nav', { class: 'pager', 'aria-label': 'Neighbouring entries' },
      prev ? el('a', { href: `/c/${cid}/p/${prev.id}`, 'data-link': '' }, `← ${prev.rank}. ${prev.name}`) : el('span', {}),
      next ? el('a', { href: `/c/${cid}/p/${next.id}`, 'data-link': '' }, `${next.rank}. ${next.name} →`) : el('span', {}));
  }

  function render() {
    const p = me();
    renderHead();
    const parts = [];
    if (p.status === 'done') {
      parts.push(whySection(p), scoresSection(p), rulesSection(p), dupSection(p), factsSection(p));
    } else if (p.status === 'queued' || p.status === 'running') {
      parts.push(block('wait-title', 'Evaluation in progress', null, el('p', { role: 'status' }, p.status === 'queued' ? 'This entry is waiting in the queue. The page updates by itself.' : 'The agents are reading the repository, opening the demo and scoring the entry. The page updates by itself.')));
    } else {
      parts.push(block('wait-title', 'Not evaluated', null,
        el('p', { class: p.error ? 'alert' : '' }, p.error || 'This entry has not been evaluated yet.'),
        view.finalisedAt ? null : btn('Evaluate this entry', 'primary', () => run(() => api('/evaluate', 'POST', { projectIds: [pid] }), { done: 'Started evaluating this entry.' }))));
    }
    parts.push(decisionSection(p));
    bodyHost.replaceChildren(...parts.filter(Boolean), pager() || '');
  }

  const node = el('div', { class: 'jdash jentry' },
    el('div', { class: 'wrap jbody jbody--top' },
      el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '/competitions', 'data-link': '' }, 'Competitions'), ' › ', el('a', { href: `/c/${cid}`, 'data-link': '' }, view.name), ' › ', me().name),
      judgeBar()),
    headHost,
    el('div', { class: 'wrap' }, msg.node),
    bodyHost);

  return { node, start() { render(); poll(); } };
}
