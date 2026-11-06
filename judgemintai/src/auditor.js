import crypto from 'node:crypto';
import { cfg } from './config.js';
import { fetchRepoBundle } from './github.js';
import { probeUrl } from './netsafe.js';
import { parseYouTubeId } from './agents/util.js';
import { runTechnicalAgent } from './agents/technical.js';
import { runPaypalAgent } from './agents/paypalAgent.js';
import { runAiAgent } from './agents/aiAgent.js';
import { runLegalAgent } from './agents/legalAgent.js';
import { runSubmissionAgent } from './agents/submissionAgent.js';
import { runSponsorsAgent } from './agents/sponsorsAgent.js';
import { runRequiredTechAgent } from './agents/requiredTechAgent.js';
import { runJudge } from './agents/judge.js';
import { saveAudit } from './store.js';
import { notifyZapier, indexInElastic } from './integrations.js';
import { normalizeRules, defaultRules, agentIds } from './rules.js';

// Which agents run is decided by the event's rules (see rules.js). The PayPal hackathon rules give the original six.
const AGENT_NAMES = {
  technical: 'Technical Validity Agent',
  paypal: 'PayPal Integration Agent',
  apis: 'Required Technology Agent',
  ai: 'AI Usage Agent',
  legal: 'Legal & Compliance Agent',
  submission: 'Submission Completeness Agent',
  sponsors: 'Sponsor Tools Agent',
};
const RUNNERS = {
  technical: runTechnicalAgent,
  paypal: runPaypalAgent,
  apis: runRequiredTechAgent,
  ai: runAiAgent,
  legal: runLegalAgent,
  submission: runSubmissionAgent,
  sponsors: runSponsorsAgent,
};

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

export function validateInput(body = {}) {
  const errors = [];
  const input = {
    projectName: clean(body.projectName, 80),
    repoUrl: clean(body.repoUrl, 300),
    demoUrl: clean(body.demoUrl, 300),
    videoUrl: clean(body.videoUrl, 300),
    description: clean(body.description, 4000),
    toolsUsed: clean(body.toolsUsed, 2000),
    hackathonStart: clean(body.hackathonStart, 10),
  };
  const isHttp = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };
  if (!input.repoUrl || !isHttp(input.repoUrl)) errors.push('repoUrl must be a full https:// link to your public repository.');
  if (input.demoUrl && !isHttp(input.demoUrl)) errors.push('demoUrl must be a valid http(s) link.');
  if (input.videoUrl && !isHttp(input.videoUrl)) errors.push('videoUrl must be a valid http(s) link.');
  if (input.hackathonStart && !/^\d{4}-\d{2}-\d{2}$/.test(input.hackathonStart)) errors.push('hackathonStart must look like 2026-10-01.');
  if (!input.projectName && input.repoUrl) {
    try { input.projectName = new URL(input.repoUrl).pathname.split('/').filter(Boolean).slice(0, 2).join('/'); } catch {}
  }
  return { ok: errors.length === 0, errors, input };
}

/** extra: fields stored on the audit as they are, e.g. { competitionId } so competition audits stay out of the public "recent" list. */
export function createAudit(input, rules = null, extra = {}) {
  const r = rules ? normalizeRules(rules, rules.preset) : defaultRules();
  const steps = [['collector', 'Evidence Collector'], ...agentIds(r).map((id) => [id, AGENT_NAMES[id]]), ['judge', 'Head Judge']];
  const audit = {
    id: crypto.randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString(),
    status: 'queued',
    input,
    rules: r,
    ...extra,
    progress: steps.map(([id, name]) => ({ id, name, status: 'queued', score: null })),
    evidence: null,
    report: null,
    certificate: null,
    payment: null,
    integrations: {},
    error: null,
  };
  saveAudit(audit);
  return audit;
}

async function collectDemo(url) {
  if (!url) return null;
  try {
    return await probeUrl(url, { timeoutMs: 25000 });
  } catch (err) {
    return { ok: false, timeout: err.name === 'TimeoutError' || err.name === 'AbortError', error: err.message };
  }
}

function parseIsoDuration(s) {
  const m = String(s || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, mi, se] = m.map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + se;
}

async function collectVideo(url) {
  if (!url) return null;
  const id = parseYouTubeId(url);
  if (!id) return { valid: false };
  const out = { valid: true, id };
  const c = cfg();
  try {
    const res = await fetch(`${c.youtubeOembedBase}?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`, { signal: AbortSignal.timeout(8000) });
    out.oembed = { ok: res.ok, status: res.status };
    if (res.ok) {
      const j = await res.json();
      out.title = j.title;
      out.author = j.author_name;
    }
  } catch (err) {
    out.oembed = { ok: false, error: err.message };
  }
  if (c.youtube.apiKey) {
    try {
      const res = await fetch(`${c.youtube.apiBase}/videos?part=contentDetails,status&id=${id}&key=${encodeURIComponent(c.youtube.apiKey)}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        const item = j.items?.[0];
        out.api = item
          ? { found: true, privacy: item.status?.privacyStatus, durationSec: parseIsoDuration(item.contentDetails?.duration) }
          : { found: false };
      }
    } catch { /* optional enrichment only */ }
  }
  return out;
}

/**
 * opts (used by competitions): lite = skip optional extra model calls, skipHeadJudge = no LLM head judge,
 * notify = false keeps Zapier/Elastic quiet for every single project, onContext(ctx) hands the collected evidence to the caller.
 */
export async function runAudit(audit, opts = {}) {
  const rules = audit.rules || defaultRules();
  const step = (id) => audit.progress.find((s) => s.id === id);
  const update = (id, patch) => { Object.assign(step(id), patch); saveAudit(audit); };

  try {
    audit.status = 'running';
    update('collector', { status: 'running' });

    const [repo, demo, video] = await Promise.all([
      fetchRepoBundle(audit.input.repoUrl),
      collectDemo(audit.input.demoUrl),
      collectVideo(audit.input.videoUrl),
    ]);
    const ctx = { input: audit.input, repo, evidence: { demo, video }, rules, lite: Boolean(opts.lite) };
    opts.onContext?.(ctx);

    audit.evidence = {
      repo: repo.found
        ? {
            fullName: repo.meta.fullName, description: repo.meta.description, stars: repo.meta.stars,
            license: repo.meta.licenseSpdx, defaultBranch: repo.meta.defaultBranch, fork: repo.meta.fork,
            languages: repo.languages, commits: repo.commits.length, files: repo.treePaths.length,
            scannedFiles: Object.keys(repo.files).length, pushedAt: repo.meta.pushedAt,
          }
        : { found: false, reason: repo.reason },
      demo: demo ? { ok: demo.ok, status: demo.status, finalUrl: demo.finalUrl, error: demo.error } : null,
      video: video ? { valid: video.valid, title: video.title, author: video.author, durationSec: video.api?.durationSec, privacy: video.api?.privacy } : null,
    };
    update('collector', { status: 'done' });

    const results = await Promise.all(
      agentIds(rules).map(async (id) => {
        const fn = RUNNERS[id];
        update(id, { status: 'running' });
        try {
          const r = await fn(ctx);
          update(id, { status: 'done', score: r.score });
          return r;
        } catch (err) {
          update(id, { status: 'error' });
          const name = step(id).name;
          return { id, name, blurb: '', score: null, summary: `Agent error: ${err.message}`, checks: [] };
        }
      }),
    );

    update('judge', { status: 'running' });
    const sponsors = results.find((r) => r.id === 'sponsors');
    audit.report = await runJudge(ctx, results, {
      sponsors: sponsors
        ? { detected: sponsors.detected || [], claimedUnverified: sponsors.claimedUnverified || [], opportunities: sponsors.opportunities || [], rows: sponsors.rows || [], prizeReadiness: sponsors.prizeReadiness ?? 0 }
        : {},
      skipLlm: Boolean(opts.skipHeadJudge),
    });
    update('judge', { status: 'done', score: audit.report.overallScore });

    audit.status = 'complete';
    audit.completedAt = new Date().toISOString();
    saveAudit(audit);

    // Fire-and-record sponsor integrations (never block or fail the audit)
    if (opts.notify === false) return audit;
    const [zap, elastic] = await Promise.all([
      notifyZapier('audit.completed', {
        auditId: audit.id, project: audit.input.projectName, repo: audit.input.repoUrl,
        score: audit.report.overallScore, verdict: audit.report.verdict,
        topFix: audit.report.topFixes[0]?.fix || '',
      }),
      indexInElastic(audit),
    ]);
    audit.integrations = { zapier: zap, elastic };
    saveAudit(audit);
  } catch (err) {
    audit.status = 'error';
    audit.error = err.message;
    for (const s of audit.progress) if (s.status === 'running' || s.status === 'queued') s.status = 'error';
    saveAudit(audit);
  }
  return audit;
}
