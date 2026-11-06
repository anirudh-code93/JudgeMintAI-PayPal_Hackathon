import { cfg } from './config.js';

// Sponsor integrations. Both are optional and fail soft: an audit never fails because a webhook is down.

/** Zapier: fire a "Catch Hook" trigger so organisers can route results to Slack, Sheets, email, Notion... */
export async function notifyZapier(event, payload) {
  const url = cfg().zapierUrl;
  if (!url) return { sent: false, reason: 'ZAPIER_WEBHOOK_URL not set' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, at: new Date().toISOString(), ...payload }),
      signal: AbortSignal.timeout(10000),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

/**
 * Elastic: when the judges finalise a competition, index one document per entry (rank, scores, flags, the reason for the rank)
 * so organisers can search and aggregate the whole field. One bulk request, never an email address, and it fails soft.
 * docs = [{ id, doc }]
 */
export async function indexEntriesInElastic(docs) {
  const { elastic } = cfg();
  if (!elastic.url || !elastic.apiKey) return { indexed: 0, reason: 'ELASTIC_URL / ELASTIC_API_KEY not set' };
  if (!docs.length) return { indexed: 0, reason: 'no entries' };
  try {
    const body = docs.map((d) => `${JSON.stringify({ index: { _index: elastic.entriesIndex, _id: d.id } })}\n${JSON.stringify(d.doc)}\n`).join('');
    const res = await fetch(`${elastic.url}/_bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson', Authorization: `ApiKey ${elastic.apiKey}` },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const out = await res.json().catch(() => ({}));
    return { indexed: res.ok && !out.errors ? docs.length : 0, status: res.status };
  } catch (err) {
    return { indexed: 0, reason: err.message };
  }
}

/** Elastic: index each finished audit so organisers can search/aggregate across hundreds of submissions. */
export async function indexInElastic(audit) {
  const { elastic } = cfg();
  if (!elastic.url || !elastic.apiKey) return { indexed: false, reason: 'ELASTIC_URL / ELASTIC_API_KEY not set' };
  try {
    const doc = {
      '@timestamp': new Date().toISOString(),
      auditId: audit.id,
      repo: audit.input.repoUrl,
      projectName: audit.input.projectName,
      overallScore: audit.report?.overallScore,
      verdict: audit.report?.verdict,
      agentScores: Object.fromEntries((audit.report?.agents || []).map((a) => [a.id, a.score])),
      sponsorToolsDetected: audit.report?.sponsorTools?.detected || [],
      criticalFindings: (audit.report?.findings || []).filter((f) => f.severity === 'critical').length,
      certified: Boolean(audit.certificate),
    };
    const res = await fetch(`${elastic.url}/${encodeURIComponent(elastic.index)}/_doc/${audit.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${elastic.apiKey}` },
      body: JSON.stringify(doc),
      signal: AbortSignal.timeout(10000),
    });
    return { indexed: res.ok, status: res.status };
  } catch (err) {
    return { indexed: false, reason: err.message };
  }
}
