import { el, fmtDate } from './util.js';
import { japi, getKey, downloadFile } from './judgeApi.js';
import { mountBoard } from './board.js';
import { field, check, rulesFields, criteriaEditor, importFields, prizeEditor, confirmDialog } from './judgeForms.js';
import {
  app, sleep, stale, setPage, showSignIn, showFailure, judgeBar, messageArea, makeRunner, importMessage,
  COMP_STATUS, PRIZE_STATUS, shortRepo, money, ordinal, num, kv, pill, flagsOf,
} from './judgeUi.js';

// The competition dashboard: progress, leaderboard, prizes, entries, rules and the decision log.

let pending = null; // a message to show once on the next dashboard, for example the result of the first import
export const setPendingMessage = (m) => { pending = m; };

export async function showCompetition(id, token) {
  app.show('judge', 'Competition');
  if (!getKey()) return showSignIn('');
  setPage(el('div', { class: 'wrap' }, el('p', { class: 'muted jloading' }, 'Loading the competition')));
  let view;
  try { view = (await japi(`/api/competitions/${id}`)).competition; } catch (err) { return showFailure(err, token); }
  if (stale(token)) return;
  app.show('judge', view.name);
  await app.refreshConfig(); // payout status
  if (stale(token)) return;
  const dash = buildDashboard(view, token);
  setPage(dash.node);
  dash.start();
}

const clampWeight = (pct) => Math.max(0, Math.min(50, Number(pct) || 0)) / 100;

function btn(label, kind, handler, extra = '') {
  const b = el('button', { type: 'button', class: `btn btn--${kind}${extra ? ` ${extra}` : ''}` }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await handler(); } finally { b.disabled = false; }
  });
  return b;
}

function section(id, title, lede, ...body) {
  return el('section', { class: 'wrap block', 'aria-labelledby': id },
    el('h2', { id }, title), lede ? el('p', { class: 'block__lede' }, lede) : null, ...body);
}

function buildDashboard(initial, token) {
  let view = initial;
  const id = view.id;
  const msg = messageArea();
  const headHost = el('div');
  const warnHost = el('div', { class: 'wrap' });
  const boardLede = el('p', { class: 'block__lede' });
  const boardHost = el('div', { class: 'gridhost' });
  const orderHost = el('div');
  const count = el('p', { class: 'toolbar__count', role: 'status' });
  const quick = el('input', { type: 'search', placeholder: 'Filter entries', 'aria-label': 'Filter entries' });
  const prizesHost = el('div');
  const addHost = el('div');
  const settingsHost = el('div');
  const logHost = el('div');
  let formsKey = '';
  let lastKey = '';
  let polling = false;

  // ------------------------------------------------------------ actions
  const run = makeRunner(msg, (next) => apply(next));

  const api = (path, method = 'POST', body = {}) => japi(`/api/competitions/${id}${path}`, { method, body });

  function apply(next) {
    const key = `${next.updatedAt}|${next.status}|${JSON.stringify(next.counts)}`;
    view = next;
    if (key !== lastKey) { lastKey = key; render(); }
    poll();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      while (view.status === 'evaluating' && !stale(token)) {
        await sleep(1500);
        if (stale(token)) break;
        try { apply((await japi(`/api/competitions/${id}`)).competition); } catch (err) {
          if (err.auth) { showSignIn(err.message); return; }
          await sleep(2500); // the server may be busy: keep trying
        }
      }
    } finally { polling = false; }
  }

  const todoCount = () => view.projects.filter((p) => !['done', 'queued', 'running'].includes(p.status)).length;

  async function evaluateAll() {
    const n = view.projects.length;
    const body = el('div', {}, el('p', {}, `All ${n} ${n === 1 ? 'entry' : 'entries'} will be audited and scored again, which replaces their current scores. Adjustments and decisions the judges made are kept.`));
    if (!(await confirmDialog({ title: 'Evaluate everything again?', body, confirmLabel: 'Evaluate again' }))) return;
    await run(() => api('/evaluate', 'POST', { all: true }), { done: (r) => `Started evaluating ${r.started} ${r.started === 1 ? 'entry' : 'entries'}.` });
  }

  async function finalise() {
    const top = view.order.slice(0, 5).map((pid, i) => {
      const p = view.projects.find((x) => x.id === pid);
      return el('li', {}, `${ordinal(i + 1)}: ${p.name} (${num(p.final)} points)`);
    });
    const skipped = view.projects.length - view.eligibleCount;
    const body = el('div', {},
      el('p', {}, 'This locks the order exactly as shown here and gives each prize to the entry that holds its place. You can reopen the judgement until the first payment starts.'),
      el('ol', { class: 'plainlist' }, top),
      skipped ? el('p', { class: 'hint' }, `${skipped} ${skipped === 1 ? 'entry is' : 'entries are'} not ranked and cannot win a prize.`) : null);
    if (!(await confirmDialog({ title: 'Finalise the judgement?', body, confirmLabel: 'Finalise' }))) return;
    await run(() => api('/finalise'), { done: 'The judgement is final. Prizes can be paid now.' });
  }

  async function reopen() {
    const body = el('div', {}, el('p', {}, 'The order and the prize winners become editable again. No payment has started, so nothing has been sent.'));
    if (!(await confirmDialog({ title: 'Reopen the judgement?', body, confirmLabel: 'Reopen' }))) return;
    await run(() => api('/reopen'), { done: 'Reopened. You can change scores and the order again.' });
  }

  async function move(pid, dir) {
    const order = [...view.order];
    const i = order.indexOf(pid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await run(() => api('/order', 'POST', { order, note: 'moved with the arrows on the leaderboard' }));
  }

  const computedOrder = () => view.projects.filter((p) => p.rank != null).sort((a, b) => a.computedRank - b.computedRank).map((p) => p.id);

  async function exportCsv() {
    try { await downloadFile(`/api/competitions/${id}/export.csv`, `judgemint-${id}.csv`); } catch (err) {
      if (err.auth) return showSignIn(err.message);
      msg.set({ tone: 'error', lines: [err.message] });
    }
  }

  async function pay(z) {
    const mode = app.config()?.competitions?.payouts || {};
    const body = el('div', {},
      el('p', {}, mode.live ? 'This sends REAL money from the live PayPal account.' : 'This sends test money from your PayPal sandbox account. No real money moves.'),
      el('dl', { class: 'kv' }, kv('Prize', z.label), kv('Amount', money(z.amount, z.currency)), kv('Winner', `${z.recipientName} (rank ${z.recipientRank})`), kv('PayPal email', z.recipientEmail)),
      el('p', { class: 'hint' }, 'Each payment has a fixed reference. PayPal ignores a repeat of it, so a double click or a retry cannot pay twice.'));
    const ok = await confirmDialog({ title: `Pay ${money(z.amount, z.currency)} to ${z.recipientName}?`, body, confirmLabel: `Send ${money(z.amount, z.currency)}`, danger: Boolean(mode.live) });
    if (!ok) return;
    await run(() => api(`/prizes/${z.id}/pay`, 'POST', { confirm: true, expected: { amount: z.amount, currency: z.currency, email: z.recipientEmail, projectId: z.recipientId } }), { done: (r) => payMessage(r.prize) });
  }

  function payMessage(z) {
    const [, label] = PRIZE_STATUS[z.status] || ['na', z.status];
    const bad = z.status === 'failed' || z.status === 'unknown';
    return { tone: bad ? 'error' : 'ok', lines: [`${z.label}: ${label}.`, ...(z.error ? [z.error] : [])] };
  }

  // ------------------------------------------------------------ head
  function renderHead() {
    const counts = view.counts || {};
    const total = view.projects.length;
    const done = counts.done || 0;
    const evaluating = view.status === 'evaluating';
    const finalised = Boolean(view.finalisedAt);
    const started = view.prizes.some((z) => z.status !== 'unpaid' && z.status !== 'failed');
    const todo = todoCount();

    const statusLine = finalised ? `Finalised by ${view.finalisedBy || 'a judge'} on ${fmtDate(view.finalisedAt)}. The order is locked.`
      : evaluating ? `Evaluating: ${done} of ${total} entries done.`
        : view.status === 'draft' ? 'No entries yet. Add some below.'
          : `${done} of ${total} ${total === 1 ? 'entry' : 'entries'} evaluated, ${view.eligibleCount} can be ranked.`;

    const buttons = [];
    if (!finalised && !evaluating && todo > 0) buttons.push(btn(`Evaluate ${todo} ${todo === 1 ? 'entry' : 'entries'}`, 'primary', () => run(() => api('/evaluate', 'POST', {}), { done: (r) => `Started evaluating ${r.started} ${r.started === 1 ? 'entry' : 'entries'}.` })));
    if (evaluating) buttons.push(btn('Cancel evaluation', 'quiet', () => run(() => api('/cancel'), { done: 'Evaluation cancelled. Entries already done keep their scores.' })));
    if (!finalised && !evaluating && done > 0) buttons.push(btn('Evaluate everything again', 'quiet', evaluateAll));
    if (!finalised && !evaluating && view.eligibleCount > 0) buttons.push(btn('Finalise the judgement', todo > 0 ? 'quiet' : 'primary', finalise));
    if (finalised && !started) buttons.push(btn('Reopen the judgement', 'quiet', reopen));
    buttons.push(btn('Export CSV', 'quiet', exportCsv));

    const pct = total ? Math.round((100 * done) / total) : 0;
    const progress = evaluating
      ? el('div', { class: 'bar bar--pass jprogress', role: 'progressbar', 'aria-label': 'Evaluation progress', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done },
        el('span', { class: 'bar__fill', style: `width:${Math.max(4, pct)}%` }))
      : null;

    const tile = (label, value) => el('div', { class: 'stat' }, el('dt', {}, label), el('dd', {}, String(value)));
    headHost.replaceChildren(el('header', { class: 'wrap jhead jhead--dash' },
      el('div', { class: 'jhead__main' },
        el('p', { class: 'eyebrow' }, el('span', { class: `status status--${view.status}` }, COMP_STATUS[view.status] || view.status)),
        el('h1', { class: 'jtitle' }, view.name),
        el('p', { class: 'jstatus', role: 'status' }, statusLine),
        progress,
        el('div', { class: 'jactions' }, buttons)),
      el('dl', { class: 'stats' }, tile('Entries', `${total}/${view.maxProjects}`), tile('Ranked', view.eligibleCount), tile('Prizes', view.prizes.length))));
  }

  // ------------------------------------------------------------ board
  let board = null; // mounted in start(), after the page is in the document, so AG Grid can measure its width
  quick.addEventListener('input', () => { board.setQuick(quick.value); updateCount(); });
  const updateCount = () => { if (board) count.textContent = `Showing ${board.count()} of ${board.total()} entries`; };

  function renderBoard() {
    const cw = Math.round((view.rules.complianceWeight ?? 0.2) * 100);
    boardLede.textContent = `Final score = ${100 - cw}% merit (the weighted criteria, 0 to 100) + ${cw}% audit score. Entries that fail the audit, look copied or are disqualified are not ranked unless a judge reinstates them. Open an entry to read the evidence and adjust its scores.`;
    const ranked = view.order.length;
    const rows = view.projects.map((p) => ({
      id: p.id, name: p.name, repo: shortRepo(p.repoUrl), href: `/c/${id}/p/${p.id}`,
      rank: p.rank, final: p.final, merit: p.merit, audit: p.facts?.auditScore ?? null,
      flags: flagsOf(p), why: p.status === 'queued' ? 'Waiting to be evaluated.' : p.status === 'running' ? 'Being evaluated now.' : p.why || 'Not evaluated yet.',
      first: p.rank === 1, last: p.rank === ranked,
    }));
    const canReorder = !view.finalisedAt && ranked > 1;
    board.update(rows, { canReorder });
    updateCount();
    setTimeout(updateCount, 80);

    orderHost.replaceChildren();
    if (view.manualOrder) {
      const back = btn('Go back to the computed order', 'quiet', () => run(() => api('/order', 'POST', { order: computedOrder(), note: 'went back to the computed order' }), { done: 'Back to the computed order.' }), 'btn--small');
      orderHost.append(el('div', { class: 'notice notice--warn' }, el('p', {}, 'The judges moved entries by hand, so this order differs from the computed one.'), back));
    } else if (canReorder) {
      orderHost.append(el('p', { class: 'hint' }, 'Judges have the final say: use the arrows in the Order column to move an entry up or down.'));
    }
  }

  function renderWarnings() {
    warnHost.replaceChildren(...view.warnings.map((w) => el('div', { class: 'notice notice--warn', role: 'status' }, el('p', {}, w))));
  }

  // ------------------------------------------------------------ prizes
  function emailForm(z) {
    const input = el('input', { type: 'email', value: z.recipientEmail || '', placeholder: 'winner@example.com', autocomplete: 'off', 'aria-label': `PayPal email for ${z.recipientName}` });
    const form = el('form', { class: 'emailform' }, input, el('button', { class: 'btn btn--quiet btn--small', type: 'submit' }, 'Save email'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      run(() => japi(`/api/competitions/${id}/projects/${z.recipientId}`, { method: 'PATCH', body: { payoutEmail: input.value.trim() } }), { done: 'Saved the PayPal email.' });
    });
    return form;
  }

  function prizeCard(z) {
    const [tone, label] = PRIZE_STATUS[z.status] || ['na', z.status];
    const finalised = Boolean(view.finalisedAt);
    const who = z.recipientId
      ? el('p', { class: 'prize__who' }, el('a', { href: `/c/${id}/p/${z.recipientId}`, 'data-link': '' }, z.recipientName), z.recipientRank ? ` (rank ${z.recipientRank})` : '', finalised ? '' : ' if the order stays as it is')
      : el('p', { class: 'muted prize__who' }, finalised ? 'No entry holds this place.' : z.place ? `Goes to whoever finishes ${ordinal(z.place)}.` : 'Not given to anyone yet.');
    const editable = z.recipientId && ['unpaid', 'failed', 'unknown'].includes(z.status);
    const actions = [];
    if (!z.blocked) actions.push(btn(`Pay ${money(z.amount, z.currency)} with PayPal`, 'primary', () => pay(z)));
    else if (z.status === 'unpaid' || z.status === 'failed') actions.push(el('p', { class: 'hint prize__blocked' }, z.blocked));
    if (z.batchId && z.status !== 'paid') actions.push(btn('Check with PayPal', 'quiet', () => run(() => api(`/prizes/${z.id}/refresh`), { done: (r) => payMessage(r.prize) })));
    if (z.batchId && z.status === 'paid') actions.push(btn('Check with PayPal', 'quiet', () => run(() => api(`/prizes/${z.id}/refresh`), { done: (r) => payMessage(r.prize) }), 'btn--small'));
    return el('li', { class: `prize prize--${z.status}` },
      el('div', { class: 'prize__top' },
        el('div', {}, el('p', { class: 'prize__label' }, z.label), el('p', { class: 'prize__amount' }, money(z.amount, z.currency))),
        pill(tone, label)),
      who,
      editable ? emailForm(z) : (z.recipientEmail ? el('p', { class: 'muted prize__email' }, z.recipientEmail) : null),
      z.error ? el('p', { class: 'prize__error' }, z.error) : null,
      z.batchId ? el('p', { class: 'muted prize__ref' }, `PayPal payout ${z.batchId}${z.itemStatus ? `, item status ${z.itemStatus}` : ''}`) : null,
      actions.length ? el('div', { class: 'prize__actions' }, actions) : null);
  }

  function renderPrizes() {
    const mode = app.config()?.competitions?.payouts || {};
    const parts = [];
    if (!view.prizes.length) {
      parts.push(el('p', { class: 'block__lede' }, 'No prizes are set. Add them under “Rules, criteria and prizes” below if you want to pay the winners through PayPal from here.'));
    } else {
      let note;
      if (!mode.ready) note = el('div', { class: 'notice notice--warn' }, el('p', {}, 'PayPal keys are not set on this server, so payments are switched off. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to the .env file and restart.'));
      else if (mode.live && !mode.allowed) note = el('div', { class: 'notice notice--warn' }, el('p', {}, 'This server points at LIVE PayPal and real-money payouts are switched off (ALLOW_LIVE_PAYOUTS).'));
      else if (mode.live) note = el('div', { class: 'notice notice--error' }, el('p', {}, 'This server uses LIVE PayPal. Payments move real money.'));
      else note = el('p', { class: 'hint prizes__note' }, 'Payments go through PayPal’s Payouts API in the sandbox, so no real money moves. Pay with the button on each prize once the judgement is final.');
      parts.push(note, el('ul', { class: 'prizes' }, view.prizes.map(prizeCard)));
    }
    prizesHost.replaceChildren(...parts);
  }

  // ------------------------------------------------------------ forms (rebuilt only when their data changes, so typing is never interrupted)
  function renderAdd() {
    if (view.finalisedAt) {
      addHost.replaceChildren(el('p', { class: 'block__lede' }, 'The judgement is final, so entries cannot be added. Reopen it first.'));
      return;
    }
    const room = view.maxProjects - view.projects.length;
    const importer = importFields();
    const start = check('Start evaluating the new entries right away', true);
    const go = btn('Add entries', 'primary', async () => {
      const imp = importer.read();
      if (!imp) { msg.set({ tone: 'warn', lines: ['Enter or choose some entries first.'] }); return; }
      await run(() => api('/projects', 'POST', { ...imp, start: start.box.checked }), { done: (r) => importMessage(r.imported) });
    });
    addHost.replaceChildren(
      el('p', { class: 'block__lede' }, room > 0 ? `There is room for ${room} more ${room === 1 ? 'entry' : 'entries'}. Entries that are already in the competition are skipped.` : `The limit of ${view.maxProjects} entries is reached. Raise it under “Rules, criteria and prizes”, then add more.`),
      importer.node, el('div', { class: 'checks' }, start.node), el('div', { class: 'slip__actions' }, go));
  }

  function renderSettings() {
    const finalised = Boolean(view.finalisedAt);
    const generic = view.rules.preset === 'generic';
    const rulesEd = generic ? rulesFields(view.rules) : null;
    const critEd = criteriaEditor(view.criteria, { disabled: finalised });
    const limit = el('input', { id: 's-limit', type: 'number', min: Math.max(1, view.projects.length), max: view.limits.hard, step: 1, value: view.maxProjects });
    const audit = el('input', { id: 's-audit', type: 'number', min: 0, max: 50, step: 5, value: Math.round((view.rules.complianceWeight ?? 0.2) * 100) });
    const prizeEd = prizeEditor(view.prizes, { entries: view.projects.map((p) => ({ id: p.id, name: p.name })), disabled: finalised });
    const base = {
      rules: rulesEd ? JSON.stringify(rulesEd.read()) : '', criteria: JSON.stringify(critEd.read()), limit: String(limit.value), audit: String(audit.value), prizes: JSON.stringify(prizeEd.read()),
    };

    const save = btn('Save changes', 'primary', async () => {
      const body = {};
      let scoring = false;
      const r = rulesEd ? rulesEd.read() : null;
      if ((r && JSON.stringify(r) !== base.rules) || audit.value !== base.audit) { body.rules = { ...(r || {}), complianceWeight: clampWeight(audit.value) }; scoring = true; }
      const c = critEd.read();
      if (JSON.stringify(c) !== base.criteria) {
        if (!c.some((x) => x.weight > 0)) { msg.set({ tone: 'error', lines: ['Give at least one criterion a weight above zero.'] }); return; }
        body.criteria = c;
        scoring = true;
      }
      if (limit.value !== base.limit) body.maxProjects = Number(limit.value);
      const pz = prizeEd.read();
      if (JSON.stringify(pz) !== base.prizes) body.prizes = pz;
      if (!Object.keys(body).length) { msg.set({ tone: 'warn', lines: ['Nothing was changed.'] }); return; }
      await run(() => api('', 'PATCH', body), {
        done: () => ({ tone: 'ok', lines: ['Saved.', ...(scoring ? ['Rules and criteria change the scores, so evaluate the entries again to apply them. The ranking already follows the new weights.'] : [])] }),
      });
    });

    const remove = btn('Delete this competition', 'quiet', async () => {
      const body = el('div', {}, el('p', {}, `“${view.name}” and all its scores, decisions and entries will be deleted. This cannot be undone.`));
      if (!(await confirmDialog({ title: 'Delete the competition?', body, confirmLabel: 'Delete it', danger: true }))) return;
      try { await japi(`/api/competitions/${id}`, { method: 'DELETE' }); app.navigate('/competitions'); } catch (err) {
        if (err.auth) return showSignIn(err.message);
        msg.set({ tone: 'error', lines: [err.message] });
      }
    }, 'btn--danger-quiet');
    const started = view.prizes.some((z) => z.status !== 'unpaid');

    // replaceChildren() would print a null argument as the word "null", so empty slots are filtered out first
    settingsHost.replaceChildren(...[
      finalised ? el('p', { class: 'block__lede' }, 'The judgement is final, so these settings are locked. Reopen the judgement to change them.') : null,
      el('fieldset', { class: 'group', disabled: finalised },
        el('legend', {}, 'Rules entries are held to'),
        rulesEd ? rulesEd.node : el('div', {}, el('p', { class: 'block__lede' }, 'These are the fixed rules of the PayPal hackathon.'), el('ul', { class: 'plainlist' }, view.rulesText.map((t) => el('li', {}, t))))),
      el('fieldset', { class: 'group', disabled: finalised },
        el('legend', {}, 'How entries are ranked'),
        critEd.node,
        el('div', { class: 'row2' },
          field('How much the audit counts (%)', audit, 'Up to 50. The rest of the final score comes from the criteria.'),
          field('Most entries to evaluate', limit, `This server allows up to ${view.limits.hard}.`))),
      el('fieldset', { class: 'group', disabled: finalised },
        el('legend', {}, 'Prizes'),
        prizeEd.node),
      el('div', { class: 'slip__actions' }, finalised ? null : save, started ? null : remove),
    ].filter(Boolean));
  }

  function renderLog() {
    logHost.replaceChildren(view.decisions.length
      ? el('ol', { class: 'logl' }, view.decisions.map((d) => el('li', {}, el('time', { datetime: d.at }, fmtDate(d.at)), el('strong', {}, d.by), el('span', {}, d.detail))))
      : el('p', { class: 'muted' }, 'Nothing has happened yet.'));
  }

  function render() {
    renderHead();
    renderWarnings();
    renderBoard();
    renderPrizes();
    renderLog();
    const key = JSON.stringify([Boolean(view.finalisedAt), view.projects.map((p) => p.id), view.maxProjects, view.rules, view.criteria, view.prizes.map((z) => [z.id, z.label, z.amount, z.currency, z.place, z.projectId, z.status === 'unpaid'])]);
    if (key !== formsKey) { formsKey = key; renderAdd(); renderSettings(); }
  }

  const node = el('div', { class: 'jdash' },
    el('div', { class: 'wrap jbody jbody--top' },
      el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '/competitions', 'data-link': '' }, 'Competitions'), ' › ', view.name),
      judgeBar()),
    headHost,
    el('div', { class: 'wrap' }, msg.node),
    warnHost,
    el('section', { class: 'wrap block', 'aria-labelledby': 'board-title' },
      el('h2', { id: 'board-title' }, 'Leaderboard'),
      boardLede,
      el('div', { class: 'toolbar' }, quick, count),
      orderHost,
      boardHost),
    section('prizes-title', 'Prizes', null, prizesHost),
    section('add-title', 'Add entries', null, addHost),
    section('settings-title', 'Rules, criteria and prizes', 'Everything the event is judged on. Changes apply to the next evaluation.', settingsHost),
    section('log-title', 'Decision log', 'Every change to the scores, order, entries and prizes, with who made it.', logHost));

  return {
    node,
    start() {
      board = mountBoard(boardHost, { onMove: move });
      lastKey = `${view.updatedAt}|${view.status}|${JSON.stringify(view.counts)}`;
      render();
      if (pending) { msg.set(pending); pending = null; }
      poll();
    },
  };
}
