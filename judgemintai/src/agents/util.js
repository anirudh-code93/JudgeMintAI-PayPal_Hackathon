// Shared helpers for all audit agents.
// Every agent produces a list of CHECKS. A check has a weight and a status:
//   pass = full credit, warn = half credit, fail = no credit, na = not applicable (excluded from the score).
// Scores are therefore explainable: judges can see exactly which check cost points and why.

export const isDoc = (p) => /\.(md|markdown|txt|rst)$/i.test(p);
export const isCode = (p) => /\.(js|jsx|ts|tsx|mjs|cjs|py|java|kt|go|rb|php|cs|rs|swift|vue|svelte|html|sh)$/i.test(p);
export const isTest = (p) => /(^|\/)(tests?|__tests__|spec|e2e|examples?|samples?|scripts?)\/|\.(test|spec)\.[a-z]+$/i.test(p);

/** Files that are executable code or configuration (everything except prose docs). */
export function sourceEntries(repo) {
  return Object.entries(repo.files || {}).filter(([p]) => !isDoc(p));
}

export function docEntries(repo) {
  return Object.entries(repo.files || {}).filter(([p]) => isDoc(p));
}

/** Find lines matching a (non-global) regex. Returns [{path, line, text}]. */
export function grep(entries, re, { limit = 5, filter } = {}) {
  const hits = [];
  for (const [path, text] of entries) {
    if (filter && !filter(path)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 140) });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

/** Paths of files whose full text matches the regex. */
export function filesMatching(entries, re, filter) {
  return entries.filter(([p, t]) => (!filter || filter(p)) && re.test(t)).map(([p]) => p);
}

export const fmtHit = (h) => `${h.path}:${h.line}  ${h.text}`;

/** Never echo a secret back in a (public) report. */
export function redact(s) {
  const str = String(s);
  return str.length <= 8 ? '****' : `${str.slice(0, 4)}…(${str.length} chars, redacted)`;
}

export function scoreChecks(checks) {
  let got = 0;
  let total = 0;
  for (const c of checks) {
    if (c.status === 'na') continue;
    total += c.weight;
    got += c.status === 'pass' ? c.weight : c.status === 'warn' ? c.weight * 0.5 : 0;
  }
  return total === 0 ? null : Math.round((got / total) * 100);
}

export function makeAgent(id, name, blurb) {
  const checks = [];
  return {
    add({ id: cid, title, weight = 5, status, severity = 'medium', detail = '', fix = '', evidence = [] }) {
      checks.push({
        agent: id,
        id: `${id}.${cid}`,
        title,
        weight,
        status,
        // passing checks are never "findings" of concern
        severity: status === 'pass' ? 'info' : status === 'na' ? 'info' : severity,
        detail,
        fix: status === 'pass' ? '' : fix,
        evidence: evidence.slice(0, 3),
      });
    },
    result(extra = {}) {
      const score = scoreChecks(checks);
      const failed = checks.filter((c) => c.status === 'fail').length;
      const warned = checks.filter((c) => c.status === 'warn').length;
      return {
        id,
        name,
        blurb,
        score,
        summary: score === null
          ? 'Nothing could be evaluated.'
          : `${checks.filter((c) => c.status === 'pass').length} passed, ${warned} ${warned === 1 ? 'warning' : 'warnings'}, ${failed} failed.`,
        checks,
        ...extra,
      };
    },
  };
}

export function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?]+)/);
        if (m) id = m[2];
      }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
