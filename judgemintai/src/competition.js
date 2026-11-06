import crypto from 'node:crypto';
import { cfg } from './config.js';
import { HttpError } from './http.js';
import { llmEnabled } from './llm.js';
import { normalizeRules, describeRules } from './rules.js';
import { validateInput, createAudit, runAudit } from './auditor.js';
import { makeFingerprint, findDuplicates } from './similarity.js';
import { collectEntries, cleanEntries, isEmail } from './intake.js';
import { DEFAULT_CRITERIA, themeCriterion, normalizeCriteria, deriveFacts, llmScoreProject } from './scoring.js';
import { computeRanking } from './ranking.js';
import { saveCompetition, getCompetition, listCompetitions } from './competitionStore.js';
import { notifyZapier, indexEntriesInElastic } from './integrations.js';

// A competition = the event's rules + criteria + entries + prizes + the judges' decisions.
// This module creates competitions, evaluates their entries through a small queue, records judging, and builds the views.

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const now = () => new Date().toISOString();
const newId = (bytes) => crypto.randomBytes(bytes).toString('hex');
const normRepo = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\.git$/i, '').replace(/\/+$/, '')}`.toLowerCase(); } catch { return String(u).toLowerCase(); } };

export const NOT_FOUND = () => new HttpError(404, 'Competition not found');
export function mustGet(id) {
  const c = getCompetition(id);
  if (!c) throw NOT_FOUND();
  return c;
}
export function mustProject(comp, pid) {
  const p = comp.projects.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, 'Entry not found in this competition');
  return p;
}
const open = (comp) => { if (comp.finalisedAt) throw new HttpError(409, 'This competition is finalised. Reopen it first (only possible before any prize is paid).'); };

export function log(comp, by, type, detail, projectId = null) {
  comp.decisions.push({ at: now(), by: clip(by, 60) || 'Organiser', type, detail: clip(detail, 400), projectId });
  if (comp.decisions.length > 500) comp.decisions.splice(0, comp.decisions.length - 500);
}

// ---- prizes -----------------------------------------------------------------------------------------------------------
export function toMoney(x) {
  const n = Number(String(x ?? '').replace(/[^0-9.]/g, ''));
  const max = cfg().competitions.maxPayout;
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'Every prize needs an amount above zero.');
  if (n > max) throw new HttpError(400, `A single prize cannot be above ${max} on this server (MAX_PAYOUT_PER_PRIZE).`);
  return n.toFixed(2);
}

function normalizePrizes(list, existing = []) {
  const src = Array.isArray(list) ? list.slice(0, 10) : [];
  return src.map((z, i) => {
    const old = existing.find((x) => x.id === z?.id);
    const currency = /^[A-Za-z]{3}$/.test(String(z?.currency || '')) ? String(z.currency).toUpperCase() : 'USD';
    const place = Number.isInteger(Number(z?.place)) && Number(z.place) >= 1 ? Math.min(50, Number(z.place)) : null;
    const projectId = z?.projectId ? clip(z.projectId, 16) : null;
    return {
      ...(old || { id: `z${i + 1}${newId(2)}`, status: 'unpaid', attempt: 1, batchId: '', batchStatus: '', itemStatus: '', paidAt: null, error: '' }),
      label: clip(z?.label, 60) || `Prize ${i + 1}`,
      amount: toMoney(z?.amount),
      currency,
      place: place || (projectId ? null : i + 1),
      projectId: old?.projectId ?? projectId,
    };
  });
}

// ---- create / update ---------------------------------------------------------------------------------------------------
export async function createCompetition(body = {}, by = 'Organiser') {
  const name = clip(body.name, 80);
  if (!name) throw new HttpError(400, 'Give the competition a name.');
  const rules = normalizeRules(body.rules || {}, body.preset || body.rules?.preset || 'generic');
  if (!rules.eventName) rules.eventName = name;
  const { maxProjectsDefault, maxProjectsHard } = cfg().competitions;
  const criteria = Array.isArray(body.criteria) && body.criteria.length
    ? normalizeCriteria(body.criteria)
    : normalizeCriteria([...DEFAULT_CRITERIA, ...(rules.theme ? [themeCriterion(rules.theme)] : [])]);
  const comp = {
    id: newId(6), name, createdAt: now(), updatedAt: now(),
    rules, criteria,
    maxProjects: clamp(Math.round(Number(body.maxProjects)) || maxProjectsDefault, 1, maxProjectsHard),
    prizes: normalizePrizes(body.prizes),
    projects: [], order: null, decisions: [], finalisedAt: null, finalisedBy: null, integrations: {},
  };
  log(comp, by, 'created', `Created "${name}" with ${rules.preset === 'paypal' ? 'the PayPal hackathon' : 'custom'} rules, limit ${comp.maxProjects} entries.`);
  saveCompetition(comp);
  const imp = body.import && typeof body.import === 'object' && (body.import.text || body.import.csv || body.import.json || body.import.github);
  const imported = imp ? await addProjects(comp, body.import, by) : null;
  return { comp, imported };
}

export function updateCompetition(comp, body = {}, by = 'Organiser') {
  open(comp);
  const changes = [];
  if (body.name !== undefined) { comp.name = clip(body.name, 80) || comp.name; changes.push('name'); }
  if (body.rules) {
    comp.rules = normalizeRules({ ...comp.rules, ...body.rules }, body.rules.preset || comp.rules.preset);
    changes.push('rules');
  }
  if (Array.isArray(body.criteria)) { comp.criteria = normalizeCriteria(body.criteria); changes.push('criteria'); }
  if (body.maxProjects !== undefined) {
    comp.maxProjects = clamp(Math.round(Number(body.maxProjects)) || comp.maxProjects, Math.max(1, comp.projects.length), cfg().competitions.maxProjectsHard);
    changes.push('limit');
  }
  if (Array.isArray(body.prizes)) {
    if (comp.prizes.some((z) => z.status !== 'unpaid')) throw new HttpError(409, 'A prize payment has already started, so the prize list can no longer change.');
    comp.prizes = normalizePrizes(body.prizes, comp.prizes);
    changes.push('prizes');
  }
  if (changes.includes('rules') || changes.includes('criteria')) {
    // rules and criteria shape the audit and the scores, so every evaluated entry needs a fresh run to follow them
    changes.push('(entries should be evaluated again)');
  }
  log(comp, by, 'updated', `Changed ${changes.join(', ') || 'nothing'}.`);
  return saveCompetition(comp);
}

export function updateProject(comp, pid, body = {}, by = 'Organiser') {
  const p = mustProject(comp, pid);
  if (body.payoutEmail !== undefined) {
    const e = String(body.payoutEmail).trim();
    if (e && !isEmail(e)) throw new HttpError(400, 'That does not look like an email address.');
    if (comp.prizes.some((z) => z.projectId === pid && z.status !== 'unpaid' && z.status !== 'failed')) throw new HttpError(409, 'A payment to this entry has already started; its email can no longer change.');
    p.payoutEmail = e;
    log(comp, by, 'email', `Set the payout email of "${p.name}".`, pid);
  }
  if (body.name !== undefined && clip(body.name, 80)) { p.name = clip(body.name, 80); log(comp, by, 'renamed', `Renamed an entry to "${p.name}".`, pid); }
  return saveCompetition(comp);
}

export function removeProject(comp, pid, by = 'Organiser') {
  open(comp);
  const p = mustProject(comp, pid);
  if (p.status === 'queued' || p.status === 'running') throw new HttpError(409, 'This entry is being evaluated. Cancel the evaluation first.');
  comp.projects = comp.projects.filter((x) => x.id !== pid);
  comp.order = comp.order?.filter((id) => id !== pid) || null;
  for (const z of comp.prizes) if (z.projectId === pid) z.projectId = null;
  findDuplicates(comp.projects);
  log(comp, by, 'removed', `Removed "${p.name}".`);
  return saveCompetition(comp);
}

// ---- entries -----------------------------------------------------------------------------------------------------------
export async function addProjects(comp, imp, by = 'Organiser') {
  open(comp);
  const room = Math.max(0, comp.maxProjects - comp.projects.length);
  let collected;
  try {
    collected = await collectEntries(imp, { limit: Math.min(100, Math.max(room, 1) + 25) });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  const seen = new Set(comp.projects.map((p) => `${normRepo(p.repoUrl)}|${p.name.toLowerCase()}`));
  const fresh = [];
  const skipped = [];
  for (const e of collected.entries) {
    const key = `${normRepo(e.repoUrl || '')}|${String(e.name || '').toLowerCase()}`;
    if (e.repoUrl && e.name && seen.has(key)) { skipped.push({ row: e._row || e.name, reason: 'Already in this competition.' }); continue; }
    fresh.push(e);
  }
  const cleaned = cleanEntries(fresh, room);
  skipped.push(...cleaned.skipped);
  for (const p of cleaned.projects) {
    comp.projects.push({
      id: newId(4), ...p, status: 'pending', error: '', auditId: null, facts: null, fingerprint: null, llm: null, duplicates: [],
      judge: { adjustments: {}, comment: '', disqualified: false, reinstated: false }, addedAt: now(),
    });
  }
  const notes = [...collected.notes];
  if (cleaned.overflow) notes.push(`${cleaned.overflow} more ${cleaned.overflow === 1 ? 'entry was' : 'entries were'} not added because the limit is ${comp.maxProjects}. Raise the limit (this server allows up to ${cfg().competitions.maxProjectsHard}) and import again.`);
  log(comp, by, 'import', `Added ${cleaned.projects.length} ${cleaned.projects.length === 1 ? 'entry' : 'entries'}${skipped.length ? `, skipped ${skipped.length}` : ''}.`);
  saveCompetition(comp);
  return { added: cleaned.projects.length, skipped: skipped.slice(0, 30), overflow: cleaned.overflow, notes, limit: comp.maxProjects };
}

// ---- evaluation queue ---------------------------------------------------------------------------------------------------
const queue = [];
let active = 0;
const idle = [];

/** Resolves when nothing is queued or running (used by tests and graceful shutdown). */
export function whenIdle() {
  return active === 0 && queue.length === 0 ? Promise.resolve() : new Promise((r) => idle.push(r));
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Evaluation took too long and was stopped.')), ms); })]).finally(() => clearTimeout(t));
}

async function evaluateOne(comp, p) {
  const { input } = validateInput({ projectName: p.name, repoUrl: p.repoUrl, demoUrl: p.demoUrl, videoUrl: p.videoUrl, description: p.description, toolsUsed: p.toolsUsed });
  const audit = createAudit(input, comp.rules, { competitionId: comp.id });
  let ctxRef = null;
  // lite: no extra model calls inside the audit; the scoring below makes ONE call per entry
  await runAudit(audit, { lite: true, skipHeadJudge: true, notify: false, onContext: (c) => { ctxRef = c; } });
  if (audit.status !== 'complete' || !ctxRef) throw new Error(audit.error || 'The audit did not finish.');
  const facts = deriveFacts(audit, ctxRef);
  const fingerprint = makeFingerprint(ctxRef);
  const llm = await llmScoreProject({ ...p, facts }, comp.criteria, comp.rules);
  return { audit, facts, fingerprint, llm };
}

async function runJob({ compId, projectId }) {
  const comp = getCompetition(compId);
  const p = comp?.projects.find((x) => x.id === projectId);
  if (!p || p.status !== 'queued') return;
  p.status = 'running';
  p.startedAt = now();
  saveCompetition(comp);
  try {
    const r = await withTimeout(evaluateOne(comp, p), cfg().competitions.timeoutMs ?? 240_000);
    if (p.status !== 'running') return; // cancelled or removed while it ran
    Object.assign(p, { status: 'done', error: '', auditId: r.audit.id, facts: r.facts, fingerprint: r.fingerprint, llm: r.llm, evaluatedAt: now() });
  } catch (err) {
    if (p.status !== 'running') return;
    p.status = 'error';
    p.error = clip(err.message, 300);
  }
  findDuplicates(comp.projects);
  saveCompetition(comp);
  const pending = comp.projects.some((x) => x.status === 'queued' || x.status === 'running');
  if (!pending) log(comp, 'JudgeMintAI', 'evaluated', `Evaluation finished: ${comp.projects.filter((x) => x.status === 'done').length} of ${comp.projects.length} entries evaluated.`);
  saveCompetition(comp);
}

function pump() {
  const max = cfg().competitions.concurrency;
  while (active < max && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job).catch((err) => console.error('evaluation job failed:', err)).finally(() => {
      active--;
      pump();
      if (active === 0 && queue.length === 0) while (idle.length) idle.shift()();
    });
  }
}

/** Queue entries for evaluation: the ones not done yet (default), the listed ids, or everything with all=true. */
export function startEvaluation(comp, { projectIds, all } = {}, by = 'Organiser') {
  open(comp);
  const redo = new Set(['pending', 'error', 'interrupted', 'cancelled']);
  const targets = comp.projects.filter((p) => (Array.isArray(projectIds) ? projectIds.includes(p.id) : all ? true : redo.has(p.status))
    && p.status !== 'queued' && p.status !== 'running');
  if (!targets.length) throw new HttpError(409, comp.projects.length ? 'Nothing to evaluate: every entry is already done or in progress.' : 'Add some entries first.');
  for (const p of targets) { p.status = 'queued'; p.error = ''; queue.push({ compId: comp.id, projectId: p.id }); }
  log(comp, by, 'evaluate', `Started evaluating ${targets.length} ${targets.length === 1 ? 'entry' : 'entries'}.`);
  saveCompetition(comp);
  pump();
  return targets.length;
}

export function cancelEvaluation(comp, by = 'Organiser') {
  let n = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].compId !== comp.id) continue;
    queue.splice(i, 1);
    n++;
  }
  for (const p of comp.projects) {
    if (p.status === 'queued') { p.status = 'cancelled'; p.error = 'Cancelled before it started.'; }
    else if (p.status === 'running') { p.status = 'cancelled'; p.error = 'Cancelled while running.'; n++; }
  }
  log(comp, by, 'cancel', `Cancelled evaluation (${n} entr${n === 1 ? 'y' : 'ies'}).`);
  saveCompetition(comp);
  return n;
}

// ---- judging -----------------------------------------------------------------------------------------------------------
export function judgeProject(comp, pid, body = {}) {
  open(comp);
  const p = mustProject(comp, pid);
  const by = clip(body.judge, 60) || 'Judge';
  const j = p.judge || (p.judge = { adjustments: {}, comment: '', disqualified: false, reinstated: false });
  const known = new Set(comp.criteria.map((c) => c.id));

  if (body.adjustments && typeof body.adjustments === 'object') {
    for (const [cid, v] of Object.entries(body.adjustments)) {
      if (!known.has(cid)) continue;
      const raw = typeof v === 'object' && v ? v.delta : v;
      const delta = clamp(Math.round(Number(raw) * 2) / 2, -5, 5);
      if (!Number.isFinite(delta) || delta === 0) { if (j.adjustments[cid]) log(comp, by, 'adjust', `Removed the adjustment of ${cid} for "${p.name}".`, pid); delete j.adjustments[cid]; continue; }
      const note = clip(typeof v === 'object' ? v.note : '', 200);
      j.adjustments[cid] = { delta, note, by, at: now() };
      log(comp, by, 'adjust', `${comp.criteria.find((c) => c.id === cid).name} ${delta > 0 ? '+' : ''}${delta} for "${p.name}"${note ? `: ${note}` : ''}`, pid);
    }
  }
  if (body.comment !== undefined) { j.comment = clip(body.comment, 1000); if (j.comment) log(comp, by, 'comment', `Commented on "${p.name}".`, pid); }
  if (body.disqualify === true) {
    j.disqualified = true; j.reinstated = false; j.reason = clip(body.reason, 200);
    log(comp, by, 'disqualify', `Disqualified "${p.name}"${j.reason ? `: ${j.reason}` : ''}.`, pid);
  }
  if (body.reinstate === true) {
    j.disqualified = false; j.reinstated = true; j.reason = '';
    log(comp, by, 'reinstate', `Reinstated "${p.name}".`, pid);
  }
  j.by = by;
  j.at = now();
  return saveCompetition(comp);
}

export function setOrder(comp, body = {}) {
  open(comp);
  const by = clip(body.judge, 60) || 'Judge';
  const ranking = computeRanking(comp);
  const order = Array.isArray(body.order) ? body.order.map(String) : null;
  if (!order) throw new HttpError(400, 'Send the new order as a list of entry ids.');
  const eligible = new Set(ranking.order);
  if (order.length !== eligible.size || new Set(order).size !== order.length || order.some((id) => !eligible.has(id))) {
    throw new HttpError(400, 'The order must list every ranked entry exactly once.');
  }
  const computed = computeRanking({ ...comp, order: null }).order;
  comp.order = order.every((id, i) => id === computed[i]) ? null : order;
  log(comp, by, 'order', comp.order ? `Set the final order by hand${body.note ? `: ${clip(body.note, 200)}` : ''}.` : 'Went back to the computed order.');
  return saveCompetition(comp);
}

export function finalise(comp, body = {}) {
  open(comp);
  const by = clip(body.judge, 60) || 'Judge';
  if (comp.projects.some((p) => p.status === 'queued' || p.status === 'running')) throw new HttpError(409, 'Evaluation is still running. Wait for it to finish or cancel it.');
  const ranking = computeRanking(comp);
  if (!ranking.eligibleCount) throw new HttpError(409, 'No entry can be ranked yet. Evaluate the entries first.');
  comp.order = [...ranking.order]; // the final order is frozen exactly as the judges saw it
  for (const z of comp.prizes) {
    if (z.place) z.projectId = ranking.order[z.place - 1] || null;
    z.assignedRank = z.projectId ? ranking.order.indexOf(z.projectId) + 1 : null;
  }
  comp.finalisedAt = now();
  comp.finalisedBy = by;
  const winners = ranking.order.slice(0, 3).map((id, i) => `${i + 1}. ${comp.projects.find((p) => p.id === id).name}`);
  log(comp, by, 'finalise', `Finalised the judgement. ${winners.join('; ')}`);
  saveCompetition(comp);
  notifyZapier('competition.finalised', {
    competitionId: comp.id, name: comp.name,
    ranking: ranking.order.map((id, i) => ({ rank: i + 1, name: comp.projects.find((p) => p.id === id).name, final: ranking.rows.find((r) => r.id === id).final })),
  }).catch(() => {});
  // One searchable document per entry, ranked or not (no email addresses). Re-finalising after a reopen simply overwrites them.
  indexEntriesInElastic(ranking.rows.map((r) => {
    const p = comp.projects.find((x) => x.id === r.id);
    return {
      id: `${comp.id}-${p.id}`,
      doc: {
        '@timestamp': comp.finalisedAt, competitionId: comp.id, competition: comp.name, projectId: p.id, name: p.name, repo: p.repoUrl,
        ranked: r.eligible, rank: r.eligible ? ranking.order.indexOf(r.id) + 1 : null,
        finalScore: r.final, merit: r.merit, auditScore: r.compliance, verdict: p.facts?.verdict || '',
        disqualified: Boolean(p.judge?.disqualified),
        copyFlags: [...new Set((p.duplicates || []).map((d) => d.kind))],
        criteria: Object.fromEntries(r.criteria.map((c) => [c.id, c.score])),
        why: r.why,
      },
    };
  })).catch(() => {});
  return comp;
}

export function reopen(comp, body = {}) {
  if (!comp.finalisedAt) throw new HttpError(409, 'This competition is not finalised.');
  if (comp.prizes.some((z) => z.status !== 'unpaid' && z.status !== 'failed')) throw new HttpError(409, 'A prize payment has already started, so the judgement can no longer be reopened.');
  const by = clip(body.judge, 60) || 'Judge';
  comp.finalisedAt = null;
  comp.finalisedBy = null;
  for (const z of comp.prizes) if (z.place) { z.projectId = null; z.assignedRank = null; }
  log(comp, by, 'reopen', 'Reopened the judgement.');
  return saveCompetition(comp);
}

// ---- views -------------------------------------------------------------------------------------------------------------
function statusOf(comp) {
  if (comp.finalisedAt) return 'finalised';
  if (comp.projects.some((p) => p.status === 'queued' || p.status === 'running')) return 'evaluating';
  return comp.projects.length ? 'ready' : 'draft';
}

function quickSummary(p) {
  const f = p.facts;
  if (!f) return '';
  const r = f.repo || {};
  const bits = [`Audit ${f.auditScore}/100 (${f.verdict}).`];
  if (r.loc) bits.push(`About ${r.loc.toLocaleString('en-US')} lines in ${(r.languages || []).join(', ') || 'unknown languages'}, ${r.commits} commits${r.testFiles ? ', with tests' : ''}.`);
  bits.push(f.demoOk ? 'The demo responds.' : 'No working demo link.');
  if (f.aiProviders?.length) bits.push(`AI: ${f.aiProviders.slice(0, 3).join(', ')}.`);
  if (p.description) bits.push(`Pitch: ${clip(p.description, 160)}${p.description.length > 160 ? '…' : ''}`);
  return bits.join(' ');
}

export function projectView(comp, p, row) {
  const ai = p.llm?.ok ? { model: p.llm.model, summary: p.llm.summary, strengths: p.llm.strengths, weaknesses: p.llm.weaknesses, flags: p.llm.flags } : null;
  return {
    id: p.id, name: p.name, repoUrl: p.repoUrl, demoUrl: p.demoUrl, videoUrl: p.videoUrl, description: p.description, toolsUsed: p.toolsUsed,
    payoutEmail: p.payoutEmail, team: p.team, status: p.status, error: p.error, auditId: p.auditId,
    facts: p.facts ? { ...p.facts, readmeExcerpt: undefined } : null,
    ai, aiError: p.llm && !p.llm.ok ? p.llm.error : null,
    summary: ai?.summary || quickSummary(p),
    ruleChecks: p.llm?.ok && p.llm.ruleChecks?.length ? p.llm.ruleChecks : comp.rules.customRules.map((r) => ({ rule: r, status: 'unknown', reason: 'Needs a human check.' })),
    duplicates: p.duplicates || [],
    judge: p.judge,
    criteria: row?.criteria || [], merit: row?.merit ?? 0, compliance: row?.compliance ?? 0, final: row?.final ?? 0,
    rank: row?.rank ?? null, computedRank: row?.computedRank ?? null, eligible: row?.eligible ?? false, reasons: row?.reasons || [], why: row?.why || '',
  };
}

/** payments: { ready: boolean } tells whether PayPal is configured, so each prize can say why it cannot be paid yet. */
export function competitionView(comp, payments = { ready: false }) {
  const ranking = computeRanking(comp);
  const rowOf = new Map(ranking.rows.map((r) => [r.id, r]));
  const projects = comp.projects.map((p) => projectView(comp, p, rowOf.get(p.id)));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const counts = comp.projects.reduce((o, p) => { o[p.status] = (o[p.status] || 0) + 1; return o; }, {});

  const prizes = comp.prizes.map((z) => {
    const rid = z.projectId || (z.place ? ranking.order[z.place - 1] : null) || null;
    const winner = rid ? byId.get(rid) : null;
    let blocked = '';
    if (!comp.finalisedAt) blocked = 'Finalise the judgement first.';
    else if (!winner) blocked = 'No entry holds this place.';
    else if (!winner.eligible) blocked = 'This entry is not ranked.';
    else if (!isEmail(winner.payoutEmail)) blocked = 'Add this entry\'s PayPal email first.';
    else if (!payments.ready) blocked = 'PayPal sandbox keys are not set on the server.';
    else if (!['unpaid', 'failed', 'unknown'].includes(z.status)) blocked = z.status === 'paid' ? 'Paid.' : 'A payment is already under way.';
    return { ...z, recipientId: rid, recipientName: winner?.name || '', recipientEmail: winner?.payoutEmail || '', recipientRank: winner?.rank ?? null, blocked };
  });

  const warnings = [];
  if (!cfg().github.token && comp.projects.length > 8) warnings.push('No GITHUB_TOKEN is set. GitHub then allows only 60 requests an hour, enough for about 10 entries. Add a free token to evaluate more.');
  if (!llmEnabled()) warnings.push('No AI key is set (LLM_API_KEY). Impact, creativity and similar scores are estimates from the audit and the wording, and judges should review them.');
  if (comp.projects.some((p) => p.status === 'done' && p.facts?.injection)) warnings.push('At least one entry contains text aimed at AI judges. Its scores were computed without the AI model; look at it closely.');

  return {
    id: comp.id, name: comp.name, createdAt: comp.createdAt, updatedAt: comp.updatedAt, status: statusOf(comp),
    rules: comp.rules, rulesText: describeRules(comp.rules), criteria: comp.criteria,
    maxProjects: comp.maxProjects, limits: { default: cfg().competitions.maxProjectsDefault, hard: cfg().competitions.maxProjectsHard },
    projects, order: ranking.order, eligibleCount: ranking.eligibleCount, counts, prizes, warnings,
    manualOrder: Boolean(comp.order) && !comp.finalisedAt,
    finalisedAt: comp.finalisedAt, finalisedBy: comp.finalisedBy,
    decisions: comp.decisions.slice(-150).reverse(),
    llm: llmEnabled(),
  };
}

export function competitionSummary(comp) {
  const done = comp.projects.filter((p) => p.status === 'done').length;
  return { id: comp.id, name: comp.name, status: statusOf(comp), createdAt: comp.createdAt, entries: comp.projects.length, evaluated: done, limit: comp.maxProjects, prizes: comp.prizes.length, finalisedAt: comp.finalisedAt };
}
export const allCompetitions = () => listCompetitions().map(competitionSummary);

// ---- CSV export ---------------------------------------------------------------------------------------------------------
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet must never run an entry's text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function exportCsv(comp) {
  const view = competitionView(comp, { ready: true });
  const head = ['rank', 'project', 'repository', 'final_score', 'merit', 'audit_score', 'verdict', 'ranked', 'why', ...comp.criteria.map((c) => c.name), 'prize', 'prize_amount', 'prize_status'];
  const prizeOf = new Map(view.prizes.filter((z) => z.recipientId).map((z) => [z.recipientId, z]));
  const lines = [head.map(cell).join(',')];
  const rows = [...view.projects].sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  for (const p of rows) {
    const z = prizeOf.get(p.id);
    lines.push([
      p.rank ?? '', p.name, p.repoUrl, p.final, p.merit, p.facts?.auditScore ?? '', p.facts?.verdict ?? p.status, p.eligible ? 'yes' : 'no', p.why,
      ...comp.criteria.map((c) => p.criteria.find((x) => x.id === c.id)?.score ?? ''),
      z?.label ?? '', z ? `${z.amount} ${z.currency}` : '', z?.status ?? '',
    ].map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export { getCompetition, saveCompetition };
