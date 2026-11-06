import { makeAgent, sourceEntries, docEntries, grep, fmtHit, isTest } from './util.js';
import { collectPackages } from './sponsorsAgent.js';
import { anyOf } from '../rules.js';

// Generic "does the entry really use the technology this event requires?" agent.
// It plays the role the PayPal agent plays for the PayPal hackathon, but for any API, SDK or service the organiser names.

const AI_CALL = /chat\.completions\.create|completions\.create|responses\.create|messages\.create|generateContent|generate_content|generateText|streamText|generateObject|chat\/completions|\/v1\/messages|\/v1\/responses|ChatOpenAI|ChatAnthropic|ollama\.(chat|generate)|askJson|callLLM|callModel/i;
// A line that talks to something: used when the organiser gave only a name, so a stray word is not mistaken for an integration.
const CALLISH = /\b(import|require|from|fetch|axios|curl|request|http|https|sdk|client|api[_-]?key|token|endpoint|\.get\(|\.post\()/i;

const slugOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tech';
const looseName = (n) => n.replace(/[^A-Za-z0-9]+/g, '[_-]?');

function pkgMatch(packages, wanted) {
  for (const [name, where] of packages) {
    const n = name.toLowerCase();
    if (wanted.some((p) => {
      const w = p.toLowerCase();
      return w.endsWith('/') ? n.startsWith(w) : n === w || n.startsWith(`${w}/`);
    })) return `package ${name}  ${where}`;
  }
  return null;
}

function gatherEvidence(tech, src, docs, packages) {
  const wordRe = anyOf(tech.keywords);
  const hostRe = tech.hosts.length ? anyOf(tech.hosts, { word: false }) : null;
  const pkg = tech.packages.length ? pkgMatch(packages, tech.packages) : null;
  const hostHits = hostRe ? grep(src, hostRe, { limit: 3 }) : [];
  const wordHits = wordRe ? grep(src, wordRe, { limit: 6 }) : [];
  const configured = tech.hosts.length > 0 || tech.packages.length > 0;
  // With only a name to go on, a line must also look like a call or an import to count as real use.
  const callish = !configured ? wordHits.filter((h) => CALLISH.test(h.text)) : [];
  const files = src
    .filter(([p, t]) => (wordRe && (wordRe.test(t) || wordRe.test(p))) || (hostRe && hostRe.test(t)))
    .map(([p]) => p);
  const real = Boolean(pkg) || hostHits.length > 0 || callish.length > 0;
  return {
    pkg, hostHits, wordHits, callish, files, real,
    inCode: real || wordHits.length > 0,
    docMentions: wordRe ? docs.filter(([, t]) => wordRe.test(t)).length : 0,
    strength: (pkg ? 3 : 0) + (hostHits.length ? 3 : 0) + (callish.length ? 2 : 0) + (wordHits.length ? 1 : 0),
  };
}

export async function runRequiredTechAgent(ctx) {
  const a = makeAgent('apis', 'Required Technology Agent', 'Does the entry really use the technology and APIs this event requires, in the right mode, and not just name them?');
  const { repo, rules } = ctx;
  const techs = rules.requiredTech;

  if (!repo.found) {
    a.add({ id: 'source', title: 'Source code available to inspect', weight: 100, status: 'fail', severity: 'critical', detail: repo.reason, fix: 'Make the repository public so the required technology can be verified.' });
    return a.result();
  }

  const src = sourceEntries(repo).filter(([p]) => !isTest(p));
  const docs = docEntries(repo);
  const packages = collectPackages(repo);
  const aiFiles = src.filter(([, t]) => AI_CALL.test(t)).map(([p]) => p);

  const found = techs.map((t) => ({ t, ev: gatherEvidence(t, src, docs, packages) }));
  const names = techs.map((t) => t.name);
  // "any of": only the best-matching technology is judged, so an entry is not punished for ignoring the others.
  const chosen = rules.techMode === 'any' && found.length > 1 ? [[...found].sort((x, y) => y.ev.strength - x.ev.strength)[0]] : found;
  const several = chosen.length > 1;

  for (const { t, ev } of chosen) {
    const slug = slugOf(t.name);
    const label = rules.techMode === 'any' && found.length > 1 && !ev.strength ? names.join(' or ') : t.name;
    const prefix = several ? `${t.name}: ` : '';

    a.add({
      id: `${slug}.in-code`, title: `${prefix}${label} appears in source code (not just the docs)`, weight: 10,
      status: ev.inCode ? 'pass' : 'fail', severity: 'critical',
      detail: ev.inCode
        ? `${ev.files.length} code/config file(s) reference ${label}.`
        : ev.docMentions ? `${label} is mentioned only in documentation. No integration code was found (technology-washing).` : `No reference to ${label} anywhere in the scanned code.`,
      fix: `Integrate ${label}'s API or SDK in the application code and describe it in the README.`,
      evidence: ev.files.slice(0, 3),
    });

    a.add({
      id: `${slug}.real-calls`, title: `${prefix}Really calls ${label}'s API or official SDK`, weight: 25,
      status: ev.real ? 'pass' : ev.wordHits.length ? 'warn' : 'fail', severity: ev.wordHits.length ? 'high' : 'critical',
      detail: ev.real
        ? `Found ${[ev.pkg && 'an SDK/package', ev.hostHits.length && 'API endpoint calls', ev.callish.length && 'calls or imports by name'].filter(Boolean).join(' and ')}.`
        : ev.wordHits.length ? `${label} is named in the code but no SDK, package or API host for it was found. The integration may be fake or use a client we do not know.` : `No ${label} SDK, import or API host was found. The integration may be fake.`,
      fix: `Call ${label}'s API or use its official SDK from the shipped application code.`,
      evidence: [ev.pkg, ...ev.hostHits.map(fmtHit), ...ev.callish.map(fmtHit)].filter(Boolean),
    });

    const up = t.name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
    const envRe = new RegExp(`process\\.env\\.[A-Z0-9_]*${up}|import\\.meta\\.env\\.[A-Z0-9_]*${up}|os\\.environ[^\\n]*${up}|getenv\\([^)]*${up}|ENV\\[['"][A-Z0-9_]*${up}`, 'i');
    const techSrc = src.filter(([p]) => ev.files.includes(p));
    const envUse = grep(techSrc, envRe, { limit: 2 });
    a.add({
      id: `${slug}.credentials`, title: `${prefix}Keys for ${label} come from environment variables`, weight: 8,
      status: !ev.real ? 'na' : envUse.length ? 'pass' : 'warn', severity: 'medium',
      detail: !ev.real ? 'No real integration to check.' : envUse.length ? 'Credentials are read from the environment.' : 'Could not confirm how credentials are supplied (fine for keyless public APIs).',
      fix: `Read the ${label} key from an environment variable and document it in .env.example.`,
      evidence: envUse.map(fmtHit),
    });

    const mockRe = new RegExp(`(mock|fake|dummy|stub|simulat\\w*)[_-]?${looseName(t.name)}|${looseName(t.name)}[_-]?(mock|fake|dummy|stub|simulat\\w*)\\b`, 'i');
    const mockHits = grep(techSrc, mockRe, { limit: 3 });
    a.add({
      id: `${slug}.not-mocked`, title: `${prefix}${label} responses are real, not faked`, weight: 10,
      status: !mockHits.length ? 'pass' : ev.real ? 'warn' : 'fail', severity: ev.real ? 'medium' : 'high',
      detail: !mockHits.length ? 'No mock, fake or simulated patterns found.' : ev.real ? 'Mock code exists alongside real calls. Confirm the demo uses the real path.' : `The ${label} flow looks simulated: mock patterns and no real calls.`,
      fix: 'Replace stubs with real calls; keep any mock behind a clearly named TEST-only flag.',
      evidence: mockHits.map(fmtHit),
    });

    if (rules.requireSandbox && t.sandboxHints.length) {
      const hintRe = anyOf(t.sandboxHints, { word: false });
      const hints = grep(techSrc, hintRe, { limit: 2 });
      a.add({
        id: `${slug}.sandbox`, title: `${prefix}Uses ${label} in test or sandbox mode`, weight: 10,
        status: !ev.real ? 'na' : hints.length ? 'pass' : 'warn', severity: 'high',
        detail: hints.length ? 'Test/sandbox settings detected.' : 'Could not tell whether test/sandbox mode is used. This event asks for it.',
        fix: `Use ${label}'s test or sandbox environment and switch to live only through an environment variable.`,
        evidence: hints.map(fmtHit),
      });
    }

    if (rules.requireAi) {
      const both = aiFiles.filter((p) => ev.files.includes(p));
      // Orchestrator files (server.js, app.js...) that import both a module named after the technology and an AI module wire them together.
      const importsTech = new RegExp(`(import|require)[^\\n]*['"][^'"]*${looseName(t.name)}[^'"]*['"]`, 'i');
      const importsAi = /(import|require)[^\n]*['"][^'"]*(llm|agent|openai|gemini|claude|anthropic|\bai\b)[^'"]*['"]/i;
      const wired = src.filter(([, tx]) => importsTech.test(tx) && importsAi.test(tx)).map(([p]) => p);
      const coupled = [...new Set([...both, ...wired])];
      a.add({
        id: `${slug}.ai-coupling`, title: `${prefix}AI and ${label} work together in one product flow`, weight: 15,
        status: coupled.length ? 'pass' : aiFiles.length && ev.files.length ? 'warn' : 'fail', severity: 'high',
        detail: coupled.length ? `AI and ${label} code are wired together in: ${coupled.slice(0, 3).join(', ')}.`
          : aiFiles.length && ev.files.length ? `AI and ${label} both exist but look like separate features. This event asks for both to be combined.` : `Missing either the AI side or the ${label} side of the combination.`,
        fix: `Let AI output drive a ${label} action, or ${label} data feed the AI, and document it.`,
        evidence: coupled.slice(0, 3),
      });
    }
  }

  return a.result({
    technologies: found.map(({ t, ev }) => ({ name: t.name, real: ev.real, inCode: ev.inCode, files: ev.files.slice(0, 5) })),
    mode: rules.techMode,
  });
}
