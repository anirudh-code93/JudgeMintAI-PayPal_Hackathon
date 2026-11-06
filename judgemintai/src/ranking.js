import { heuristicScores } from './scoring.js';

// Ranking is a pure function of the competition's saved state, so what judges see can never drift from what was stored.
//
//   criterion score = AI score (or the heuristic estimate) + the judges' adjustment, kept between 0 and 10
//   merit           = weighted mean of the criterion scores, 0-100
//   compliance      = the audit score, 0-100 (code is real, rules followed)
//   final           = (1 - c) * merit + c * compliance          (c = the event's complianceWeight, 0.2 by default)
//   not ranked      = failed audit, copied code, disqualified by a judge, or could not be evaluated (a judge can reinstate)

const clamp = (x, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, x));
const r1 = (x) => Math.round(x * 10) / 10;
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`;

/** Why an entry cannot be ranked (empty list = eligible). `reinstated` judges override automatic reasons, never a judge's own disqualification. */
function ineligibleReasons(p) {
  const reasons = [];
  if (p.judge?.disqualified) return [`Disqualified by ${p.judge.by || 'a judge'}${p.judge.reason ? `: ${p.judge.reason}` : ''}.`];
  if (p.status === 'error' || p.status === 'interrupted' || p.status === 'cancelled') reasons.push(`Could not be evaluated (${p.error || p.status}).`);
  else if (p.status !== 'done') reasons.push('Not evaluated yet.');
  if (p.status === 'done') {
    if (p.facts?.verdict === 'FAIL') reasons.push(`The audit verdict is FAIL (${p.facts.auditScore}/100)${p.facts.failedCritical?.length ? `: ${p.facts.failedCritical.slice(0, 2).join('; ')}` : ''}.`);
    for (const d of p.duplicates || []) {
      if (d.severity === 'high' && d.role === 'copy' && ['code', 'fork'].includes(d.kind)) reasons.push(`Looks copied from "${d.otherName}": ${d.note}`);
    }
  }
  if (p.judge?.reinstated && p.status === 'done') return [];
  return reasons;
}

export function computeRanking(comp) {
  const crit = comp.criteria;
  const wSum = crit.reduce((s, c) => s + c.weight, 0) || 1;
  const cw = comp.rules.complianceWeight ?? 0.2;

  const rows = comp.projects.map((p) => {
    const maxSim = Math.max(0, ...(p.duplicates || []).filter((d) => ['code', 'text', 'fork', 'repo'].includes(d.kind)).map((d) => d.similarity || 0));
    const est = p.status === 'done' ? heuristicScores(p, crit, comp.rules, { maxSimilarity: maxSim }) : {};
    const injected = p.facts?.injection; // an entry that tries to steer AI judges does not get AI-written scores
    const criteria = crit.map((c) => {
      const ai = p.llm?.ok && !injected ? p.llm.scores?.[c.id] : null;
      const base = ai || est[c.id] || { score: 0, reason: 'Not evaluated yet.', confidence: 'none' };
      const adj = p.judge?.adjustments?.[c.id];
      const score = r1(clamp(base.score + (adj?.delta || 0)));
      return {
        id: c.id, name: c.name, weight: c.weight, base: base.score, score, delta: adj?.delta || 0, note: adj?.note || '',
        reason: base.reason, confidence: base.confidence, source: ai ? 'ai' : 'estimate',
      };
    });
    const merit = p.status === 'done' ? r1(10 * criteria.reduce((s, c) => s + c.weight * c.score, 0) / wSum) : 0;
    const compliance = p.status === 'done' ? p.facts?.auditScore ?? 0 : 0;
    const reasons = ineligibleReasons(p);
    return {
      id: p.id, name: p.name, criteria, merit, compliance, final: r1((1 - cw) * merit + cw * compliance),
      eligible: reasons.length === 0, reasons, rank: null, computedRank: null, why: '',
      complexity: criteria.find((c) => c.id === 'complexity')?.score ?? 0,
    };
  });

  // computed order: final score, then compliance, then technical complexity, then name (so ties are never random)
  const eligible = rows.filter((r) => r.eligible)
    .sort((a, b) => (b.final - a.final) || (b.compliance - a.compliance) || (b.complexity - a.complexity) || a.name.localeCompare(b.name));
  eligible.forEach((r, i) => { r.computedRank = i + 1; });

  // the judges' manual order wins for the entries it lists; anything it does not list follows in computed order
  let ordered = eligible;
  if (Array.isArray(comp.order) && comp.order.length) {
    const byId = new Map(eligible.map((r) => [r.id, r]));
    const listed = comp.order.map((id) => byId.get(id)).filter(Boolean);
    const rest = eligible.filter((r) => !comp.order.includes(r.id));
    ordered = [...listed, ...rest];
  }
  ordered.forEach((r, i) => { r.rank = i + 1; });

  // plain-words explanation of every rank, built from the numbers (never from model prose)
  for (const [i, r] of ordered.entries()) {
    const best = [...r.criteria].sort((a, b) => b.score - a.score)[0];
    const worst = [...r.criteria].sort((a, b) => a.score - b.score)[0];
    const parts = [`Ranked ${ordinal(r.rank)} of ${ordered.length} with ${r.final} points (merit ${r.merit}, audit ${r.compliance}, audit counts ${Math.round(cw * 100)}%).`];
    if (best && worst && best.id !== worst.id) parts.push(`Strongest: ${best.name} ${best.score}/10. Weakest: ${worst.name} ${worst.score}/10.`);
    const above = ordered[i - 1];
    if (above && above.final > r.final) {
      const gaps = r.criteria.map((c) => ({ c, d: (above.criteria.find((x) => x.id === c.id)?.score ?? 0) - c.score })).filter((x) => x.d >= 1).sort((a, b) => b.d - a.d).slice(0, 2);
      parts.push(`Behind ${ordinal(above.rank)} place "${above.name}" by ${r1(above.final - r.final)} points${gaps.length ? `, mainly on ${gaps.map((g) => `${g.c.name} (${r1(-g.d)})`).join(' and ')}` : ''}.`);
    }
    if (r.computedRank !== r.rank) parts.push(`The computed order had it ${ordinal(r.computedRank)}; the judges moved it.`);
    const adjusted = r.criteria.filter((c) => c.delta);
    if (adjusted.length) parts.push(`Judges adjusted ${adjusted.map((c) => `${c.name} ${c.delta > 0 ? '+' : ''}${c.delta}`).join(', ')}.`);
    r.why = parts.join(' ');
  }
  for (const r of rows.filter((x) => !x.eligible)) r.why = `Not ranked. ${r.reasons.join(' ')}`;

  return { rows, order: ordered.map((r) => r.id), eligibleCount: ordered.length };
}
