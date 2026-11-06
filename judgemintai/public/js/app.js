import { el, api, AGENT_LABEL, verdictInfo, scoreBand, fmtDate, timeAgo, remember, safeHttpUrl, statusChip, severityText } from './util.js';
import { sealSVG } from './seal.js';
import { mountFindings } from './grid.js';
import { mountCheckout, certificateEl } from './pay.js';
import { initJudge, routeJudge } from './judge.js';

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const views = { intake: $('#view-intake'), progress: $('#view-progress'), report: $('#view-report'), verify: $('#view-verify'), judge: $('#view-judge') };
const state = { config: null, token: 0, prefill: null };

const EXAMPLE = {
  repoUrl: 'https://github.com/paypal/agent-toolkit',
  projectName: 'PayPal Agent Toolkit (public example)',
  demoUrl: '',
  videoUrl: '',
  description: 'Example only. The PayPal Agent Toolkit lets AI agents call PayPal APIs through function calling and the Model Context Protocol, covering orders, invoices and payments in the sandbox.',
  toolsUsed: 'Model Context Protocol: connects AI agents to PayPal APIs. TypeScript SDK: the toolkit itself.',
  hackathonStart: '',
};

// ---------------------------------------------------------------- routing
function show(name, title) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  document.title = title ? `${title} | JudgeMintAI` : 'JudgeMintAI';
  window.scrollTo({ top: 0 });
  $('#main').focus({ preventScroll: true });
  const current = { intake: '#nav-audit', verify: '#nav-verify', judge: '#nav-judge' }[name];
  for (const a of document.querySelectorAll('.nav a')) a.removeAttribute('aria-current');
  if (current) $(current)?.setAttribute('aria-current', 'page');
}

function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}

document.addEventListener('click', (e) => {
  const link = e.target.closest?.('a[data-link]');
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', route);

function route() {
  const token = ++state.token;
  let m;
  if ((m = location.pathname.match(/^\/a\/([a-f0-9]{12})$/))) return showAudit(m[1], token);
  if ((m = location.pathname.match(/^\/verify(?:\/(JM-[A-Fa-f0-9]{12}))?$/))) return showVerify(m[1]?.toUpperCase(), token);
  if (/^\/(competitions|c)(\/|$)/.test(location.pathname)) return routeJudge(location.pathname, token);
  return showIntake();
}

// ---------------------------------------------------------------- footer
function renderFooterStatus() {
  const c = state.config;
  const ul = $('#foot-status');
  ul.replaceChildren();
  if (!c) { ul.append(el('li', {}, 'Server status unavailable')); return; }
  const lines = [
    c.llm.enabled ? `AI head judge: ${c.llm.model}` : 'AI head judge: off, rules only',
    c.paypal.enabled ? 'PayPal sandbox: connected' : 'PayPal sandbox: not set up',
    c.paypal.enabled ? toolkitLine(c.paypal.toolkit) : null,
    `Zapier: ${c.integrations.zapier ? 'on' : 'off'}`,
    `Elastic: ${c.integrations.elastic ? 'on' : 'off'}`,
  ];
  ul.append(...lines.filter(Boolean).map((text) => el('li', {}, text)));
}

// The PayPal AI Toolkit is PayPal's MCP server. The server starts it in the background and falls back to PayPal's Orders API if it cannot run.
function toolkitLine(t) {
  if (!t || t.mode === 'rest') return 'PayPal AI Toolkit: off, using the Orders API';
  const used = (t.calls?.create_order || 0) + (t.calls?.pay_order || 0);
  if (t.state === 'ready') return `PayPal AI Toolkit: ready${used ? `, ${used} ${used === 1 ? 'call' : 'calls'} so far` : ''}`;
  if (t.state === 'starting') return 'PayPal AI Toolkit: starting up';
  if (t.state === 'unavailable') return t.mode === 'toolkit' ? 'PayPal AI Toolkit: unavailable' : 'PayPal AI Toolkit: unavailable, using the Orders API';
  return 'PayPal AI Toolkit: starts with the first payment';
}

// The toolkit may still have been starting when the page loaded, so the status is read again when a payment panel opens.
async function refreshConfig() {
  try {
    state.config = await api('/api/config');
    renderFooterStatus();
  } catch { /* keep showing the last known status */ }
  return state.config;
}

// ---------------------------------------------------------------- intake
const form = $('#audit-form');

function setFormError(message) {
  const p = $('#form-error');
  p.textContent = message || '';
  p.hidden = !message;
}

function fillForm(values) {
  for (const [name, value] of Object.entries(values || {})) {
    const input = form.elements[name];
    if (input) input.value = value ?? '';
  }
}

function wireIntake() {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError('');
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.repoUrl?.trim()) {
      setFormError('Add your repository URL. It is the only required field.');
      $('#f-repo').focus();
      return;
    }
    const button = $('#run-audit');
    button.disabled = true;
    button.textContent = 'Starting the audit';
    try {
      const { id } = await api('/api/audits', { method: 'POST', body: data });
      remember('jm:lastInput', data);
      navigate(`/a/${id}`);
    } catch (err) {
      setFormError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Run audit';
    }
  });
  $('#fill-example').addEventListener('click', () => { fillForm(EXAMPLE); setFormError(''); $('#f-repo').focus(); });
}

const th = (text) => el('th', { scope: 'col' }, text);

async function renderRecent() {
  const host = $('#recent-body');
  try {
    const { audits } = await api('/api/audits');
    if (!audits.length) {
      host.replaceChildren(el('p', { class: 'muted' }, 'No audits yet. Run one above and it will appear here.'));
      return;
    }
    host.replaceChildren(el('table', { class: 'recent' },
      el('thead', {}, el('tr', {}, th('Project'), th('Score'), th('Verdict'), th('When'))),
      el('tbody', {}, audits.map((a) => {
        const v = a.verdict ? verdictInfo(a.verdict) : null;
        return el('tr', {},
          el('td', { 'data-label': 'Project' }, el('a', { href: `/a/${a.id}`, 'data-link': '' }, a.projectName || a.repoUrl)),
          el('td', { 'data-label': 'Score' }, a.score == null ? '' : el('span', { class: 'recent__score' }, String(a.score))),
          el('td', { 'data-label': 'Verdict' }, v ? el('span', { class: `verdict-tag verdict-tag--${v.key}` }, v.label, a.certified ? ' (certified)' : '') : (a.status === 'error' ? 'Failed' : 'Running')),
          el('td', { 'data-label': 'When' }, timeAgo(a.createdAt)));
      }))));
  } catch (err) {
    host.replaceChildren(el('p', { class: 'muted' }, err.message));
  }
}

function showIntake() {
  show('intake');
  setFormError('');
  if (state.prefill) { fillForm(state.prefill); state.prefill = null; }
  renderRecent();
  if (location.hash === '#recent') $('#recent').scrollIntoView();
}

// ---------------------------------------------------------------- progress
const STEP_HINT = {
  collector: 'Reads the repo, opens the demo and looks up the video',
  technical: 'Build and run docs, commit history, leaked keys',
  paypal: 'Real sandbox calls, payment flow, credentials',
  ai: 'Model calls, prompts, agent design',
  legal: 'Licence, video rules, fair play',
  submission: 'The items the rules ask you to hand in',
  sponsors: 'Sponsor tools and the claims about them',
  judge: 'Combines everything into one verdict',
};

const stateText = (s) => (s.status === 'queued' ? 'Waiting' : s.status === 'running' ? 'Working' : s.status === 'done' ? (s.score != null ? `Done, ${s.score}` : 'Done') : 'Failed');

function renderProgress(audit) {
  $('#progress-title').textContent = `Auditing ${audit.input.projectName || 'your submission'}`;
  $('#steps').replaceChildren(...audit.progress.map((s) => el('li', { 'data-state': s.status },
    el('span', { class: 'steps__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'steps__what' }, el('strong', {}, s.name), el('span', { class: 'steps__hint' }, STEP_HINT[s.id] || '')),
    el('span', { class: 'steps__state' }, stateText(s)))));
}

function showProgressMessage(message) {
  const p = $('#progress-error');
  p.textContent = message || '';
  p.hidden = !message;
}

async function showAudit(id, token) {
  show('progress', 'Auditing');
  showProgressMessage('');
  $('#steps').replaceChildren();
  $('#progress-title').textContent = 'Loading the audit';
  for (;;) {
    let audit;
    try {
      audit = await api(`/api/audits/${id}`);
    } catch (err) {
      if (token !== state.token) return;
      if (err.status === 404) {
        showProgressMessage('That audit does not exist. It may have been created on another server. Run a new audit from the home page.');
        return;
      }
      showProgressMessage(err.message);
      await sleep(2500);
      continue;
    }
    if (token !== state.token) return;
    if (audit.status === 'complete') return showReport(audit);
    if (audit.status === 'error') {
      renderProgress(audit);
      showProgressMessage(`The audit stopped: ${audit.error || 'unknown error'}. Check the repository URL and run it again.`);
      return;
    }
    showProgressMessage('');
    renderProgress(audit);
    await sleep(900);
  }
}

// ---------------------------------------------------------------- report
const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

function scorecard(audit) {
  const r = audit.report;
  const v = verdictInfo(r.verdict);
  const repoHref = safeHttpUrl(audit.input.repoUrl);
  const seal = sealSVG({ score: r.overallScore, verdictKey: v.key, word: v.word, size: 232 });
  seal.classList.add('seal--enter');

  const again = el('button', { class: 'btn btn--quiet', type: 'button' }, 'Audit again with changes');
  again.addEventListener('click', () => { state.prefill = audit.input; navigate('/'); });

  const copyNote = el('span', { class: 'copy-note', role: 'status' });
  const copy = el('button', { class: 'btn btn--quiet', type: 'button' }, 'Copy link to this report');
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(location.href).then(
      () => { copyNote.textContent = 'Link copied.'; },
      () => { copyNote.textContent = 'Copy failed. Copy the address from your browser bar.'; });
  });

  return el('header', { class: 'scorecard' },
    el('div', { class: 'scorecard__main' },
      el('h1', { class: 'scorecard__title' }, audit.input.projectName || 'Untitled project'),
      el('ul', { class: 'meta' },
        el('li', {}, repoHref ? el('a', { href: repoHref, target: '_blank', rel: 'noopener noreferrer' }, audit.input.repoUrl.replace(/^https?:\/\//, '')) : audit.input.repoUrl),
        el('li', {}, `Audited ${fmtDate(audit.completedAt || audit.createdAt)}`),
        el('li', {}, r.mode?.llm && r.mode.llm !== 'heuristic' ? `AI head judge: ${r.mode.llm}` : 'Rule-based checks only')),
      el('p', { class: `verdict verdict--${v.key}` }, v.label),
      el('p', { class: 'scorecard__reason' }, r.verdictReason),
      r.summary ? el('p', { class: 'scorecard__summary' }, r.summary) : null,
      el('div', { class: 'scorecard__actions' }, again, copy, copyNote)),
    el('div', { class: 'scorecard__seal' }, seal));
}

function scoreCell(score) {
  const band = scoreBand(score);
  return el('div', { class: 'score' },
    el('span', { class: `bar bar--${band}`, role: 'img', 'aria-label': `${score} out of 100` }, el('span', { class: 'bar__fill', style: `width:${clampPct(score)}%` })),
    el('span', { class: 'score__num' }, String(score)));
}

function rubricSection(r) {
  const scored = r.agents.filter((a) => a.weight > 0);
  return el('section', { class: 'block', 'aria-labelledby': 'rubric-title' },
    el('h2', { id: 'rubric-title' }, 'Score by agent'),
    el('p', { class: 'block__lede' }, 'The overall score is a weighted average. A critical failure sets the verdict to Fail, and a high-severity failure caps it at Needs review.'),
    el('table', { class: 'rubric' },
      el('thead', {}, el('tr', {}, th('Agent'), th('Weight'), th('Score'), th('Result'))),
      el('tbody', {}, scored.map((a) => el('tr', {},
        el('th', { scope: 'row' }, a.name, el('small', {}, a.blurb)),
        el('td', { 'data-label': 'Weight' }, `${a.weight}%`),
        el('td', { 'data-label': 'Score' }, a.score == null ? el('span', { class: 'muted' }, 'Not scored') : scoreCell(a.score)),
        el('td', { 'data-label': 'Result' }, a.summary))))));
}

function fixesSection(r) {
  return el('section', { 'aria-labelledby': 'fixes-title' },
    el('h2', { id: 'fixes-title' }, 'Fix these first'),
    el('p', { class: 'block__lede' }, 'Ordered by how much each fix helps your score and your chance of passing.'),
    r.topFixes.length
      ? el('ol', { class: 'fixes' }, r.topFixes.map((f) => el('li', {},
        el('div', {},
          el('p', { class: 'fixes__title' }, f.title),
          el('p', { class: 'fixes__tags' }, statusChip(f.status), el('span', { class: 'tag' }, `${severityText(f.severity)} severity`), el('span', { class: 'tag' }, `${AGENT_LABEL[f.agent] || f.agent} agent`)),
          el('p', { class: 'fixes__fix' }, f.fix)))))
      : el('p', {}, 'Nothing to fix. Every check passed or did not apply.'));
}

function sponsorsSection(r) {
  const s = r.sponsorTools || {};
  const rows = s.rows || [];
  const stateFor = (row) => {
    if (row.detected && row.claimed) return ['yes', 'Found in your code and in your submission'];
    if (row.detected) return ['yes', 'Found in your code, but not mentioned in your submission'];
    if (row.claimed) return ['claim', 'Mentioned in your submission, but no code uses it'];
    return ['open', 'Not used'];
  };
  return el('section', { 'aria-labelledby': 'sponsors-title' },
    el('h2', { id: 'sponsors-title' }, 'Sponsor tools'),
    el('p', { class: 'block__lede' }, `${(s.detected || []).length} of ${rows.length || 10} are wired into the repository. Only a dependency, import, hostname, config file or environment variable counts. Naming a tool does not.`),
    el('dl', { class: 'sponsors' }, rows.map((row) => {
      const [kind, text] = stateFor(row);
      return el('div', {}, el('dt', {}, row.name), el('dd', {}, el('span', { class: `mark mark--${kind}`, 'aria-hidden': 'true' }), text));
    })));
}

function judgeSection(r) {
  const j = r.aiJudge || { used: false };
  const node = el('section', { class: 'block', 'aria-labelledby': 'judge-title' }, el('h2', { id: 'judge-title' }, 'Head judge’s notes'));
  if (!j.used) {
    node.append(el('p', { class: 'block__lede' }, j.error
      ? `The AI head judge could not run (${j.error}). The scores in this report come from the rule-based checks.`
      : 'The AI head judge is off, so this report uses the rule-based checks only. Add LLM_API_KEY to your .env file to get written feedback and an innovation score.'));
    return node;
  }
  const list = (items) => el('ul', {}, (items || []).map((t) => el('li', {}, t)));
  node.append(
    el('p', { class: 'block__lede' }, `Written by ${j.model}. It can move the score by at most 5 points and can never lift a failing or manipulative submission.`),
    el('div', { class: 'judge' },
      el('div', {}, el('h3', {}, 'Innovation'), el('p', { class: 'judge__big' }, `${j.innovation} out of 10`),
        j.adjustment ? el('p', { class: 'muted' }, `Score adjustment ${j.adjustment > 0 ? '+' : ''}${j.adjustment}: ${j.adjustmentReason}`) : el('p', { class: 'muted' }, 'No score adjustment.')),
      el('div', {}, el('h3', {}, 'Strengths'), list(j.strengths)),
      el('div', {}, el('h3', {}, 'Risks'), list(j.risks))));
  return node;
}

function renderFinding(panel, row) {
  if (!row) {
    panel.replaceChildren(el('p', { class: 'finding__empty' }, 'Select a row to see the evidence and the fix.'));
    return;
  }
  panel.replaceChildren(
    el('h3', {}, row.title),
    el('p', { class: 'finding__tags' }, statusChip(row.status), el('span', { class: 'tag' }, `${severityText(row.severity)} severity`), el('span', { class: 'tag' }, `${AGENT_LABEL[row.agent] || row.agent} agent`)),
    el('p', {}, row.detail),
    row.fix ? el('p', {}, el('strong', {}, 'How to fix it: '), row.fix) : null,
    row.evidence?.length
      ? el('div', {}, el('p', { class: 'finding__label' }, 'Evidence'), el('ul', {}, row.evidence.map((line) => el('li', {}, el('code', {}, line)))))
      : null);
}

function checksSection(r) {
  const host = el('div', { class: 'gridhost' });
  const panel = el('aside', { class: 'finding', 'aria-live': 'polite', 'aria-label': 'Selected check' });
  renderFinding(panel, null);
  const count = el('p', { class: 'toolbar__count', role: 'status' });
  const search = el('input', { type: 'search', id: 'check-filter', placeholder: 'Filter checks', 'aria-label': 'Filter checks' });
  const bProblems = el('button', { type: 'button', 'aria-pressed': 'true' }, 'Problems only');
  const bAll = el('button', { type: 'button', 'aria-pressed': 'false' }, 'All checks');
  let grid = null;

  const updateCount = () => { if (grid) count.textContent = `Showing ${grid.count()} of ${grid.total()} checks`; };
  const setMode = (mode) => {
    grid.setMode(mode);
    bProblems.setAttribute('aria-pressed', String(mode === 'problems'));
    bAll.setAttribute('aria-pressed', String(mode === 'all'));
    updateCount();
  };
  bProblems.addEventListener('click', () => setMode('problems'));
  bAll.addEventListener('click', () => setMode('all'));
  search.addEventListener('input', () => { grid.setQuick(search.value); updateCount(); });

  const node = el('section', { class: 'block', 'aria-labelledby': 'checks-title' },
    el('h2', { id: 'checks-title' }, 'Every check'),
    el('p', { class: 'block__lede' }, 'Sort, filter and select a row to read the evidence. Problems come first.'),
    el('div', { class: 'toolbar' }, el('div', { class: 'seg', role: 'group', 'aria-label': 'Which checks to show' }, bProblems, bAll), search, count),
    host, panel);

  return {
    node,
    init() {
      grid = mountFindings(host, r.findings, { onSelect: (row) => renderFinding(panel, row) });
      updateCount();
      setTimeout(updateCount, 60);
      // when nothing fails, show everything so the table is never empty
      if (grid.problemCount() === 0) setMode('all');
    },
  };
}

function certificateBlock(cert, audit) {
  const note = el('span', { class: 'pay__status', role: 'status' });
  const print = el('button', { class: 'btn btn--primary', type: 'button' }, 'Print certificate');
  print.addEventListener('click', () => {
    document.documentElement.classList.add('print-cert');
    window.addEventListener('afterprint', () => document.documentElement.classList.remove('print-cert'), { once: true });
    window.print();
  });
  const copy = el('button', { class: 'btn btn--quiet', type: 'button' }, 'Copy verification link');
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(`${location.origin}/verify/${cert.serial}`).then(
      () => { note.textContent = 'Link copied.'; },
      () => { note.textContent = 'Copy failed. The link is printed on the certificate.'; });
  });
  return [certificateEl(cert, audit.input.projectName, audit.payment?.via), el('div', { class: 'pay__actions' }, print, copy, note)];
}

function paySection(audit) {
  const r = audit.report;
  const c = state.config;
  const body = el('div', { class: 'pay__body' });
  const node = el('section', { class: 'block pay', 'aria-labelledby': 'pay-title' }, el('h2', { id: 'pay-title' }, 'Mint a verification certificate'), body);
  let init = () => {};

  if (audit.certificate) {
    body.replaceChildren(...certificateBlock(audit.certificate, audit));
  } else if (r.verdict === 'FAIL') {
    body.append(el('p', { class: 'block__lede' }, 'Certificates go to submissions that do not fail. Fix the critical issues listed above, then audit again.'));
  } else if (!c?.paypal?.enabled) {
    body.append(el('p', { class: 'block__lede' }, 'PayPal’s sandbox is not set up on this server. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to the .env file and restart the server.'));
  } else {
    const checkout = el('div', { class: 'pay__checkout' });
    const viaToolkit = c.paypal.toolkit && c.paypal.toolkit.mode !== 'rest';
    body.append(
      el('p', { class: 'block__lede' }, `A signed certificate records this score and verdict, and anyone can check it on the verify page. It costs ${c.paypal.value} ${c.paypal.currency} in PayPal’s sandbox, so pay with a sandbox buyer account and no real money moves.`),
      checkout);
    if (viaToolkit) {
      body.append(el('p', { class: 'pay__status' }, 'Behind the button, this server creates and captures the order with the PayPal AI Toolkit (PayPal’s MCP server). If the toolkit is not running it uses PayPal’s Orders API instead, and it always checks the finished payment with PayPal before it signs a certificate.'));
    }
    init = () => {
      mountCheckout(checkout, {
        audit,
        config: c,
        onIssued: (cert, via) => {
          audit.certificate = cert;
          audit.payment = { ...audit.payment, via };
          body.replaceChildren(...certificateBlock(cert, audit));
          refreshConfig();
        },
      });
      refreshConfig();
    };
  }
  return { node, init };
}

function showReport(audit) {
  show('report', audit.input.projectName || 'Report');
  const r = audit.report;
  const checks = checksSection(r);
  const pay = paySection(audit);
  $('#report-root').replaceChildren(
    scorecard(audit),
    rubricSection(r),
    el('div', { class: 'block split' }, fixesSection(r), sponsorsSection(r)),
    judgeSection(r),
    checks.node,
    pay.node);
  checks.init();
  pay.init();
}

// ---------------------------------------------------------------- verify
function wireVerify() {
  $('#verify-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const serial = $('#v-serial').value.trim().toUpperCase();
    if (!/^JM-[A-F0-9]{12}$/.test(serial)) {
      $('#verify-result').replaceChildren(el('p', { class: 'alert', role: 'alert' }, 'A serial looks like JM-3F9A1C20B7D4. Check the certificate and try again.'));
      return;
    }
    navigate(`/verify/${serial}`);
  });
}

async function showVerify(serial, token) {
  show('verify', 'Verify a certificate');
  const out = $('#verify-result');
  out.replaceChildren();
  $('#v-serial').value = serial || '';
  if (!serial) return;
  out.replaceChildren(el('p', { class: 'muted' }, 'Checking the signature'));
  try {
    const res = await api(`/api/certificates/${serial}`);
    if (token !== state.token) return;
    out.replaceChildren(
      el('p', { class: `verify__verdict ${res.valid ? 'is-valid' : 'is-invalid'}`, role: 'status' },
        res.valid ? 'Valid. The signature matches, so the record has not been altered.' : 'Invalid. The signature does not match this record.'),
      certificateEl(res.certificate, res.projectName));
  } catch (err) {
    if (token !== state.token) return;
    out.replaceChildren(el('p', { class: 'alert', role: 'alert' }, err.status === 404 ? 'No certificate with that serial exists. Check the serial and try again.' : err.message));
  }
}

// ---------------------------------------------------------------- start
(async function boot() {
  try { state.config = await api('/api/config'); } catch { state.config = null; }
  renderFooterStatus();
  wireIntake();
  wireVerify();
  initJudge({ show, navigate, token: () => state.token, reroute: route, config: () => state.config, refreshConfig });
  route();
})();
