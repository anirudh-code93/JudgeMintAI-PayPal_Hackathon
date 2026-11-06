import { makeAgent, sourceEntries, docEntries } from './util.js';
import { anyOf } from '../rules.js';

// Hackathon sponsor tools.
// A tool only counts as USED when the repository shows real wiring: a dependency, an import or script tag,
// one of its hostnames inside a URL, its config file, or its environment variables.
// Merely writing the sponsor's name (README, comment, string) never counts, so name-dropping cannot earn credit.
export const SPONSORS = [
  { name: 'AG Grid', claim: /\bag[- ]?grid\b/i, pkg: [/^@?ag-grid(-|\/)/], url: /(?:jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|ag-grid\.com)[^\s'"]*ag-grid/i, api: /\bagGrid\.createGrid\s*\(|\bnew\s+agGrid\.Grid\s*\(/ },
  { name: 'APIMatic', claim: /\bapimatic\b/i, pkg: [/^@apimatic\//, /^apimatic/], url: /apimatic\.io/i, file: /(^|\/)(\.apimatic|apimatic[^/]*\.json)$/i, env: /\bAPIMATIC_[A-Z_]+\b/ },
  { name: 'Astropods', claim: /\bastropods?\b/i, pkg: [/^@astropods\//, /^astropods/], url: /astropods\.[a-z]+/i, file: /(^|\/)astropods[^/]*$/i, env: /\bASTROPODS_[A-Z_]+\b/ },
  { name: 'Bryntum', claim: /\bbryntum\b/i, pkg: [/^@bryntum\//], url: /bryntum\.com/i },
  { name: 'Channel3', claim: /\bchannel3\b/i, pkg: [/^@channel3\//, /^channel3/], url: /channel3\.[a-z]+/i, env: /\bCHANNEL3_[A-Z_]+\b/ },
  { name: 'Elastic', claim: /\belastic(search)?\b/i, pkg: [/^@elastic\//, /^elasticsearch$/, /^elastic-/], url: /\.elastic(?:-cloud)?\.co\b|elastic-cloud\.com/i, env: /\bELASTIC(?:SEARCH)?_(?:URL|API_KEY|CLOUD_ID|HOST|NODE)\b/ },
  { name: 'KERNEL', claim: /\bkernel\b/i, pkg: [/^@onkernel\//, /^onkernel/], url: /onkernel\.com|kernel\.sh/i, env: /\bKERNEL_API_KEY\b/ },
  { name: 'Postman', claim: /\bpostman\b/i, pkg: [/^newman$/, /^postman-/], url: /getpostman\.com|postman\.co\b/i, file: /\.postman_(collection|environment)\.json$|(^|\/)postman\//i },
  { name: 'Render', claim: /\brender(\.com)?\b/i, url: /onrender\.com|api\.render\.com/i, file: /(^|\/)render\.ya?ml$/i, env: /\bRENDER_(?:EXTERNAL_URL|EXTERNAL_HOSTNAME|SERVICE_ID|SERVICE_NAME|GIT_COMMIT)\b/ },
  { name: 'Zapier', claim: /\bzapier\b/i, pkg: [/^zapier-/, /^@zapier\//], url: /hooks\.zapier\.com|zapier\.com\/hooks/i, env: /\bZAPIER_[A-Z_]+\b/ },
];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An organiser-defined sponsor ({ name, keywords }) gets the same kinds of evidence rules as the built-in ones. */
function customSponsor(s) {
  const slugs = [...new Set(s.keywords.map((k) => k.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((k) => k.length >= 3))];
  const alt = slugs.map(escRe).join('|');
  return {
    name: s.name,
    claim: anyOf(s.keywords),
    pkg: alt ? [new RegExp(`^@?(?:${alt})(?:[-_/.]|$)`, 'i')] : [],
    url: alt ? new RegExp(`https?://[^/\\s]*(?:${alt})[^/\\s]*\\.[a-z]{2,}`, 'i') : null,
    env: alt ? new RegExp(`\\b(?:${slugs.map((k) => escRe(k.toUpperCase())).join('|')})_[A-Z_]+\\b`) : null,
  };
}

/** Every package the repo depends on or imports, with where it was found. */
export function collectPackages(repo) {
  const names = new Map();
  for (const [p, t] of Object.entries(repo.files)) {
    if (/(^|\/)package\.json$/.test(p)) {
      try {
        const j = JSON.parse(t);
        for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const n of Object.keys(j[k] || {})) names.set(n, `${p} (${k})`);
        }
      } catch { /* malformed manifest */ }
    } else if (/(^|\/)requirements[^/]*\.txt$/.test(p)) {
      for (const line of t.split('\n')) {
        const m = !line.trim().startsWith('#') && line.match(/^\s*([A-Za-z0-9_.-]+)/);
        if (m) names.set(m[1].toLowerCase(), p);
      }
    } else if (/(^|\/)pyproject\.toml$/.test(p)) {
      for (const m of t.matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[<>=!~;[\s]|["'])/g)) names.set(m[1].toLowerCase(), p);
    }
  }
  for (const [p, t] of sourceEntries(repo)) {
    if (/\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|html)$/i.test(p)) {
      for (const m of t.matchAll(/(?:\bfrom|\bimport|\brequire\()\s*['"]([^'"\n]+)['"]/g)) names.set(m[1], `${p} (import)`);
    } else if (/\.py$/i.test(p)) {
      for (const m of t.matchAll(/^\s*(?:from|import)\s+([A-Za-z0-9_]+)/gm)) names.set(m[1].toLowerCase(), `${p} (import)`);
    }
  }
  return names;
}

function findUrl(src, re) {
  for (const [p, t] of src) {
    for (const m of t.matchAll(/https?:\/\/[^\s'"`)<>\\]+/g)) {
      if (re.test(m[0])) return `${p}  ${m[0].slice(0, 90)}`;
    }
  }
  return null;
}

function findLine(src, re) {
  for (const [p, t] of src) {
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return `${p}:${i + 1}  ${lines[i].trim().slice(0, 100)}`;
  }
  return null;
}

export async function runSponsorsAgent(ctx) {
  const a = makeAgent('sponsors', 'Sponsor Tools Agent', 'Which sponsor tools are really wired into the code, and does every claim have code behind it?');
  const { repo, input } = ctx;
  const detected = [];
  const claimedUnverified = [];
  const opportunities = [];
  const rows = [];

  if (!repo.found) {
    a.add({ id: 'source', title: 'Source code available to inspect', weight: 100, status: 'fail', severity: 'high', detail: repo.reason, fix: 'Make the repository public so sponsor-tool usage can be verified.' });
    return a.result({ detected, claimed: [], rows });
  }

  const src = sourceEntries(repo);
  const docs = docEntries(repo);
  const packages = collectPackages(repo);
  const demoHost = (() => { try { return new URL(input.demoUrl).hostname; } catch { return ''; } })();
  // The PayPal hackathon uses the built-in list of ten sponsors; any other event can name its own.
  const list = Array.isArray(ctx.rules?.sponsors) ? ctx.rules.sponsors.map(customSponsor) : SPONSORS;

  for (const s of list) {
    const claimedInTools = s.claim.test(input.toolsUsed || '');
    const brandRe = new RegExp(`\\b${s.name.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const claimed = claimedInTools || brandRe.test(input.description || '');

    const evidence = [];
    if (s.pkg) {
      for (const [name, where] of packages) {
        if (s.pkg.some((re) => re.test(name))) { evidence.push(`package ${name}  ${where}`); break; }
      }
    }
    if (s.url) { const u = findUrl(src, s.url); if (u) evidence.push(`url ${u}`); }
    if (s.api) { const l = findLine(src, s.api); if (l) evidence.push(`call ${l}`); }
    if (s.env) { const l = findLine(src, s.env); if (l) evidence.push(`env ${l}`); }
    if (s.file) { const f = repo.treePaths.find((p) => s.file.test(p)); if (f) evidence.push(`file ${f}`); }
    if (s.name === 'Render' && /onrender\.com$/i.test(demoHost)) evidence.push(`demo hosted at ${demoHost}`);

    const found = evidence.length > 0;
    if (found) detected.push(s.name);
    if (claimed && !found) claimedUnverified.push(s.name);
    if (found && !claimed) opportunities.push(s.name);
    rows.push({ name: s.name, claimed: Boolean(claimed), detected: found, evidence: evidence.slice(0, 2) });
  }

  const docMentionOnly = list.filter((s) => claimedUnverified.includes(s.name) && docs.some(([, t]) => s.claim.test(t))).map((s) => s.name);

  a.add({
    id: 'usage', title: 'Sponsor tools are wired into the code (extra-prize eligibility)', weight: 60,
    status: detected.length >= 3 ? 'pass' : detected.length >= 1 ? 'warn' : 'fail', severity: 'low',
    detail: detected.length ? `Found real wiring for: ${detected.join(', ')}.` : 'No sponsor tools found in the code. Using sponsor tools can unlock additional prizes.',
    fix: 'Add sponsor tools with real functionality, such as AG Grid for a table, Render for hosting, a Zapier webhook, Elastic for search, or a Postman collection.',
    evidence: rows.filter((r) => r.detected).slice(0, 3).map((r) => `${r.name}: ${r.evidence[0] || ''}`),
  });

  a.add({
    id: 'claims', title: 'Claimed sponsor tools have code behind them', weight: 40,
    status: claimedUnverified.length === 0 ? 'pass' : 'fail', severity: 'medium',
    detail: claimedUnverified.length
      ? `Claimed, but nothing in the code uses them: ${claimedUnverified.join(', ')}${docMentionOnly.length ? ` (mentioned in docs only: ${docMentionOnly.join(', ')})` : ''}. Unbacked claims cost credibility.`
      : 'Every claimed sponsor tool is backed by code in the repository.',
    fix: 'Either integrate the tool for real or remove the claim.',
  });

  const verified = detected.filter((n) => !claimedUnverified.includes(n)).length;
  const prizeReadiness = Math.max(0, Math.min(100, verified * 25 - claimedUnverified.length * 15));
  const res = a.result({ detected, claimedUnverified, opportunities, rows, prizeReadiness });
  // For this agent the headline number is prize readiness, not a rules score.
  res.score = prizeReadiness;
  res.summary = `${detected.length} sponsor tool${detected.length === 1 ? '' : 's'} wired in${claimedUnverified.length ? `, ${claimedUnverified.length} claim${claimedUnverified.length === 1 ? '' : 's'} without code` : ''}.`;
  return res;
}
