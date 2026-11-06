import { makeAgent, sourceEntries, docEntries, grep, fmtHit, redact, isTest } from './util.js';

// Secret formats we refuse to see in a public repo. Evidence is always redacted.
const SECRET_PATTERNS = [
  { name: 'PayPal client secret', re: /(client[_-]?secret|paypal[_-]?secret)\s*[:=]\s*['"]([A-Za-z0-9_-]{30,})['"]/i, group: 2 },
  { name: 'OpenAI-style API key', re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/, group: 1 },
  { name: 'Anthropic API key', re: /\b(sk-ant-[A-Za-z0-9_-]{30,})\b/, group: 1 },
  { name: 'Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/, group: 1 },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/, group: 1 },
  { name: 'AWS access key', re: /\b(AKIA[0-9A-Z]{16})\b/, group: 1 },
  { name: 'Slack token', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/, group: 1 },
  { name: 'Private key block', re: /(-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)/, group: 1 },
];
const PLACEHOLDER = /^(your|xxx|placeholder|changeme|example|replace|insert|test|dummy|<)/i;

export function findSecrets(repo) {
  const found = [];
  for (const [path, text] of sourceEntries(repo)) {
    if (/\.env\.(example|sample|template)$/i.test(path)) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const p of SECRET_PATTERNS) {
        const m = line.match(p.re);
        if (!m) continue;
        const value = m[p.group];
        if (PLACEHOLDER.test(value) || /YOUR_|EXAMPLE|xxxx/i.test(value)) continue;
        found.push({ path, line: i + 1, kind: p.name, preview: redact(value) });
      }
    });
  }
  for (const p of repo.treePaths || []) {
    if (/(^|\/)\.env(\.[a-z]+)?$/i.test(p) && !/\.(example|sample|template)$/i.test(p)) {
      found.push({ path: p, line: 0, kind: 'Committed .env file', preview: '(file present in repository)' });
    }
  }
  return found;
}

export async function runTechnicalAgent(ctx) {
  const a = makeAgent('technical', 'Technical Validity Agent', 'Does the project exist, build and run, and was it really built during the hackathon?');
  const { repo, input, evidence } = ctx;

  if (!repo.found) {
    a.add({
      id: 'reachable', title: 'Repository is reachable', weight: 100, status: 'fail', severity: 'critical',
      detail: repo.reason, fix: 'Publish the repository (Settings → Danger Zone → Change visibility → Public) and re-run the audit.',
    });
    return a.result();
  }

  const m = repo.meta;
  const files = Object.keys(repo.files);
  const src = sourceEntries(repo);
  const docs = docEntries(repo);
  const tree = repo.treePaths;

  a.add({ id: 'reachable', title: 'Repository is reachable and public', weight: 10, status: m.isPrivate ? 'fail' : 'pass', severity: 'critical', detail: `${m.fullName} (default branch "${m.defaultBranch}")`, fix: 'Make the repository public.' });

  const codeFiles = tree.filter((p) => /\.(js|jsx|ts|tsx|mjs|py|java|kt|go|rb|php|cs|rs|swift|vue|svelte)$/i.test(p) && !/node_modules|vendor|dist\//.test(p));
  a.add({
    id: 'substance', title: 'Contains real source code', weight: 10,
    status: codeFiles.length >= 3 ? 'pass' : codeFiles.length >= 1 ? 'warn' : 'fail', severity: 'critical',
    detail: `${codeFiles.length} source files found in the repository tree (${tree.length} files total).`,
    fix: 'Commit your actual project source, not only docs or a prototype export.',
    evidence: codeFiles.slice(0, 3),
  });

  const readmePath = tree.find((p) => /^readme(\.md|\.txt|\.rst)?$/i.test(p));
  const readme = readmePath ? (repo.files[readmePath] || '') : '';
  a.add({
    id: 'readme', title: 'README explains the project', weight: 8,
    status: readme.length >= 600 ? 'pass' : readme.length >= 150 ? 'warn' : 'fail', severity: 'high',
    detail: readmePath ? `${readmePath} has ${readme.length} characters.` : 'No README at the repository root.',
    fix: 'Add a README with: what it does, architecture, tech stack, how AI and PayPal are used.',
  });

  const runWords = /(npm (install|i|run|start|ci)|yarn( install| start)?|pnpm (install|dev|start)|pip install|python3? |uvicorn|flask run|docker( |-)compose|docker run|mvn |gradle|go run|cargo run|bun (install|run)|getting started|installation|how to run|quick ?start)/i;
  a.add({
    id: 'runnable-docs', title: 'Setup & run instructions exist', weight: 12,
    status: runWords.test(readme) ? 'pass' : (input.demoUrl ? 'warn' : 'fail'), severity: 'high',
    detail: runWords.test(readme)
      ? 'README contains install/run commands.'
      : 'Judges must be able to run the project: provide clear run instructions or a hosted demo URL.',
    fix: 'Add a "Run locally" section: prerequisites, npm install, .env setup, npm start, and how to reach the app.',
  });

  a.add({
    id: 'env-docs', title: 'Required credentials are documented', weight: 4,
    status: /(\.env|environment variable|api[_ -]?key|client[_ -]?id|credentials)/i.test(readme) || tree.some((p) => /\.env\.(example|sample)$/i.test(p)) ? 'pass' : 'warn',
    severity: 'low',
    detail: 'Judges need to know which keys (e.g. PayPal sandbox client id/secret) to supply.',
    fix: 'Commit a .env.example listing every variable, with no real values.',
  });

  // Dependency manifest + entry point
  const pkgPath = tree.find((p) => /(^|\/)package\.json$/.test(p) && !/node_modules/.test(p));
  let manifest = null;
  if (pkgPath && repo.files[pkgPath]) { try { manifest = JSON.parse(repo.files[pkgPath]); } catch {} }
  const otherManifest = tree.find((p) => /(^|\/)(requirements\.txt|pyproject\.toml|pom\.xml|go\.mod|Gemfile|composer\.json|build\.gradle|Cargo\.toml)$/.test(p));
  const hasStart = manifest && (manifest.scripts?.start || manifest.scripts?.dev || manifest.main);
  a.add({
    id: 'manifest', title: 'Dependency manifest and entry point', weight: 10,
    status: hasStart || (otherManifest && !pkgPath) ? 'pass' : (pkgPath || otherManifest) ? 'warn' : 'fail', severity: 'high',
    detail: pkgPath
      ? `${pkgPath}: ${hasStart ? 'has a start/dev script or main entry.' : 'no "start"/"dev" script or "main" field.'}`
      : otherManifest ? `${otherManifest} found.` : 'No package.json / requirements.txt / pom.xml etc. found.',
    fix: 'Add a package.json (or equivalent) with a "start" script so `npm install && npm start` works.',
  });

  // Commit history
  const commits = repo.commits;
  const times = commits.map((c) => Date.parse(c.date)).filter(Number.isFinite);
  const spanHours = times.length ? (Math.max(...times) - Math.min(...times)) / 3.6e6 : 0;
  a.add({
    id: 'history', title: 'Commit history shows real development', weight: 10,
    status: commits.length >= 5 && spanHours >= 2 ? 'pass' : commits.length >= 2 ? 'warn' : 'fail', severity: 'medium',
    detail: `${commits.length}${commits.length >= 100 ? '+' : ''} commits spanning ~${Math.round(spanHours)} hours. ${commits.length < 3 ? 'Looks like a one-shot upload.' : ''}`.trim(),
    fix: 'Commit as you build. A single "initial commit" makes it hard to show meaningful progress.',
    evidence: commits.slice(0, 3).map((c) => `${c.sha} ${c.date?.slice(0, 10)} ${c.message}`),
  });

  // Hackathon window: the submitter's own start date, or the event's dates from its rules
  const startDay = input.hackathonStart || ctx.rules?.windowStart || '';
  const endDay = ctx.rules?.windowEnd || '';
  if (startDay) {
    const start = Date.parse(startDay);
    const end = endDay ? Date.parse(endDay) + 864e5 : Infinity; // the end day itself still counts
    const during = times.filter((t) => t >= start && t < end).length;
    const late = times.filter((t) => t >= end).length;
    a.add({
      id: 'window', title: 'Meaningful progress during the hackathon', weight: 10,
      status: during >= 3 ? (late ? 'warn' : 'pass') : during >= 1 ? 'warn' : 'fail', severity: 'high',
      detail: `${during} of ${times.length} recent commits were made ${endDay ? `between ${startDay} and ${endDay}` : `after ${startDay}`}.${late ? ` ${late} commit(s) came after the deadline and do not count.` : ''}`,
      fix: 'Existing projects are allowed, but you must show meaningful new work during the hackathon period.',
    });
  } else {
    a.add({ id: 'window', title: 'Meaningful progress during the hackathon', weight: 10, status: 'na', detail: 'No hackathon start date supplied; skipped.' });
  }

  if (m.fork) a.add({ id: 'fork', title: 'Repository is original work', weight: 4, status: 'warn', severity: 'medium', detail: 'This repository is a fork. Make sure substantial original work was added.', fix: 'Explain in the README what you added on top of the upstream project.' });
  if (m.archived) a.add({ id: 'archived', title: 'Repository is active', weight: 2, status: 'warn', severity: 'low', detail: 'Repository is archived (read-only).', fix: 'Unarchive so judges see it as a live project.' });

  const tests = tree.filter((p) => isTest(p) && /\.(test|spec)\.|tests?\//i.test(p));
  a.add({
    id: 'tests', title: 'Automated tests present', weight: 4,
    status: tests.length ? 'pass' : 'warn', severity: 'low',
    detail: tests.length ? `${tests.length} test file(s).` : 'No tests detected. Not required, but strengthens execution scores.',
    fix: 'Add at least a smoke test (e.g. node:test) for the core flow.',
    evidence: tests.slice(0, 3),
  });

  // Secrets
  const secrets = findSecrets(repo);
  a.add({
    id: 'secrets', title: 'No credentials committed to the repository', weight: 15,
    status: secrets.length ? 'fail' : 'pass', severity: 'critical',
    detail: secrets.length
      ? `${secrets.length} possible secret(s): ${[...new Set(secrets.map((s) => s.kind))].join(', ')}. Rotate them immediately — they are public.`
      : `Scanned ${files.length} files; no key patterns found.`,
    fix: 'Revoke/rotate the exposed keys, remove them from git history, and load secrets from environment variables.',
    evidence: secrets.slice(0, 3).map((s) => `${s.path}${s.line ? ':' + s.line : ''}  ${s.kind}  ${s.preview}`),
  });

  // Demo availability
  if (input.demoUrl) {
    const d = evidence.demo;
    if (d?.ok) a.add({ id: 'demo', title: 'Hosted demo is reachable', weight: 10, status: 'pass', detail: `${d.finalUrl} responded HTTP ${d.status}.` });
    else if (d?.timeout) a.add({ id: 'demo', title: 'Hosted demo is reachable', weight: 10, status: 'warn', severity: 'medium', detail: 'No response within the time limit (free hosting may be asleep).', fix: 'Wake the service before judging and mention cold-start time in the README.' });
    else a.add({ id: 'demo', title: 'Hosted demo is reachable', weight: 10, status: 'fail', severity: 'high', detail: d?.error || `Demo returned HTTP ${d?.status}.`, fix: 'Fix the deployment or provide complete local run instructions.' });
  } else {
    a.add({ id: 'demo', title: 'Hosted demo is reachable', weight: 10, status: 'na', detail: 'No demo URL supplied; judged on local run instructions instead.' });
  }

  return a.result({
    stats: {
      files: tree.length, scannedFiles: files.length, commits: commits.length,
      languages: repo.languages, sourceFiles: codeFiles.length, docFiles: docs.length, codeScanned: src.length,
    },
  });
}
