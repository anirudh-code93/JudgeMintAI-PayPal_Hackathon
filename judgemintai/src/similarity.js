import crypto from 'node:crypto';
import { sourceEntries, docEntries, isTest } from './agents/util.js';

// Duplicate and copy detection ACROSS the entries of one competition.
//
// Every entry gets a small fingerprint when it is evaluated:
//   - one hash per source file (exact copies of whole files, ignoring formatting and comments' whitespace)
//   - a sampled "shingle" sketch of all its code (hashes of every 6 consecutive identifiers, kept when hash % mod == 0)
//   - the same kind of sketch for its description and README text
//   - the repository, video and demo addresses, and the fork parent
// Fingerprints are compared pair by pair. Nothing is ever fetched twice and no source code is stored in the competition.

const BOILERPLATE = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|\.gitignore|\.gitattributes|\.eslintrc[^/]*|\.prettierrc[^/]*|tsconfig[^/]*\.json|jsconfig\.json|vite\.config\.[a-z]+|next\.config\.[a-z]+|postcss\.config\.[a-z]+|tailwind\.config\.[a-z]+|webpack\.config\.[a-z]+|babel\.config\.[a-z]+|license[^/]*|\.env\.example|requirements\.txt|setup\.py|dockerfile|docker-compose\.ya?ml|render\.ya?ml|vercel\.json|netlify\.toml|manifest\.json|robots\.txt|index\.css|app\.css)$/i;

const SHINGLE = 6; // identifiers per code shingle
const TEXT_SHINGLE = 4; // words per text shingle
const MAX_HASHES = 3000;

const idTokens = (text) => String(text).toLowerCase().match(/[a-z_$][a-z0-9_$]*|\d+/g) || [];
// const, let and var mean the same here, so switching between them does not hide a copy
const DECLARATION = new Set(['const', 'let', 'var']);
const codeTokens = (text) => idTokens(text).map((t) => (DECLARATION.has(t) ? 'var' : t));
const wordTokens = (text) => String(text).toLowerCase().match(/[a-z]{3,}/g) || [];

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function shingleHashes(tokens, size) {
  const out = new Set();
  for (let i = 0; i + size <= tokens.length; i++) out.add(fnv(tokens.slice(i, i + size).join(' ')));
  return out;
}

/** Sample the hash space (keep h % mod == 0); the modulus doubles until the sketch is small enough. */
function sketch(hashes, startMod) {
  let mod = startMod;
  let kept = [...hashes].filter((h) => h % mod === 0);
  while (kept.length > MAX_HASHES) { mod *= 2; kept = kept.filter((h) => h % mod === 0); }
  return { mod, hex: kept.map((h) => h.toString(16).padStart(8, '0')).join(''), count: kept.length };
}

const decode = (hex) => { const out = []; for (let i = 0; i + 8 <= hex.length; i += 8) out.push(parseInt(hex.slice(i, i + 8), 16)); return out; };

const normUrl = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return ''; } };

/** Build the fingerprint of one evaluated entry from the evidence the auditor collected. */
export function makeFingerprint(ctx) {
  const { repo, input, evidence } = ctx;
  const fp = {
    repoKey: repo.found ? repo.meta.fullName.toLowerCase() : normUrl(input.repoUrl),
    demoKey: normUrl(input.demoUrl),
    videoId: evidence.video?.id || '',
    parent: repo.found ? (repo.meta.parentFullName || '').toLowerCase() : '',
    createdAt: repo.found ? repo.meta.createdAt || '' : '',
    files: [],
    code: { mod: 8, hex: '', count: 0 },
    text: { mod: 1, hex: '', count: 0 },
    tokens: 0,
  };
  if (repo.found) {
    const code = sourceEntries(repo).filter(([p]) => !isTest(p) && !BOILERPLATE.test(p));
    const all = [];
    for (const [p, t] of code) {
      const tok = codeTokens(t);
      for (const x of tok) all.push(x); // a loop, because spreading a very large array into push() can overflow the stack
      if (tok.length >= 80) fp.files.push([p, crypto.createHash('sha1').update(tok.join(' ')).digest('hex').slice(0, 16), tok.length]);
    }
    fp.tokens = all.length;
    fp.code = sketch(shingleHashes(all, SHINGLE), 8);
    const prose = [input.description || '', ...docEntries(repo).filter(([p]) => /^readme/i.test(p)).map(([, t]) => t)].join(' ');
    fp.text = sketch(shingleHashes(wordTokens(prose), TEXT_SHINGLE), 1);
  } else {
    fp.text = sketch(shingleHashes(wordTokens(input.description || ''), TEXT_SHINGLE), 1);
  }
  return fp;
}

function overlap(a, b, common) {
  const mod = Math.max(a.mod, b.mod);
  const A = new Set(decode(a.hex).filter((h) => h % mod === 0 && !common.has(h)));
  const B = new Set(decode(b.hex).filter((h) => h % mod === 0 && !common.has(h)));
  let shared = 0;
  for (const h of A) if (B.has(h)) shared++;
  const smaller = Math.min(A.size, B.size);
  return { shared, a: A.size, b: B.size, jaccard: A.size + B.size - shared ? shared / (A.size + B.size - shared) : 0, containment: smaller ? shared / smaller : 0, smaller };
}

const HOUR = 3600e3;

/** Compare two fingerprints. Returns null when they have nothing in common worth a judge's attention. */
export function compareFingerprints(a, b, common = new Set()) {
  const hits = [];
  let similarity = 0;

  const code = overlap(a.code, b.code, common);
  const codeSim = code.smaller >= 25 ? Math.max(code.jaccard, 0.8 * code.containment) : 0;
  const bFiles = new Map(b.files.map(([p, h, n]) => [h, [p, n]]));
  const sharedFiles = a.files.filter(([, h]) => bFiles.has(h)).map(([p, h, n]) => ({ a: p, b: bFiles.get(h)[0], tokens: n }));
  const sharedTokens = sharedFiles.reduce((s, f) => s + f.tokens, 0);
  const fileRatio = Math.min(a.tokens, b.tokens) ? sharedTokens / Math.min(a.tokens, b.tokens) : 0;
  const text = overlap(a.text, b.text, new Set());
  const textSim = text.smaller >= 30 ? text.containment : 0;

  if (a.repoKey && a.repoKey === b.repoKey) { hits.push({ kind: 'repo', severity: 'high', note: 'Both entries point to the same repository.' }); similarity = 1; }
  const forkOf = (x, y) => x.parent && x.parent === y.repoKey;
  if (forkOf(a, b) || forkOf(b, a)) { hits.push({ kind: 'fork', severity: 'high', note: `${forkOf(a, b) ? 'The first' : 'The second'} repository is a fork of the other entry.` }); similarity = Math.max(similarity, 0.9); }
  if (codeSim >= 0.6 || (sharedFiles.length >= 3 && fileRatio >= 0.35)) {
    hits.push({ kind: 'code', severity: 'high', note: `About ${Math.round(Math.max(codeSim, fileRatio) * 100)}% of the code matches${sharedFiles.length ? `, including ${sharedFiles.length} identical file(s)` : ''}.` });
    similarity = Math.max(similarity, codeSim, fileRatio);
  } else if (codeSim >= 0.35 || (sharedFiles.length >= 1 && fileRatio >= 0.2)) {
    hits.push({ kind: 'code', severity: 'medium', note: `A large part of the code looks alike (about ${Math.round(Math.max(codeSim, fileRatio) * 100)}%).` });
    similarity = Math.max(similarity, codeSim, fileRatio);
  }
  if (textSim >= 0.6) {
    hits.push({ kind: 'text', severity: textSim >= 0.8 ? 'high' : 'medium', note: `The description and README share about ${Math.round(textSim * 100)}% of their wording.` });
    similarity = Math.max(similarity, textSim * 0.8);
  }
  if (a.videoId && a.videoId === b.videoId) { hits.push({ kind: 'video', severity: 'medium', note: 'Both entries link the same demo video.' }); similarity = Math.max(similarity, 0.5); }
  if (a.demoKey && a.demoKey === b.demoKey) { hits.push({ kind: 'demo', severity: 'medium', note: 'Both entries link the same hosted demo.' }); similarity = Math.max(similarity, 0.5); }
  if (!hits.length) return null;

  // Who copied whom? Only said when the repositories were created clearly apart, or one is a fork of the other.
  let copy = null;
  if (forkOf(a, b)) copy = 'a'; else if (forkOf(b, a)) copy = 'b';
  else {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) >= HOUR) copy = ta > tb ? 'a' : 'b';
  }
  return { hits, similarity: Math.round(similarity * 100) / 100, sharedFiles: sharedFiles.slice(0, 6), copy };
}

/**
 * Compare every pair of evaluated entries. Writes `duplicates` onto each project:
 * [{ otherId, otherName, kind, severity, similarity, role: 'copy' | 'original' | 'unknown', note, sharedFiles }]
 * Code that appears in most entries (starter templates) is ignored once there are 5 or more entries.
 */
export function findDuplicates(projects) {
  const live = projects.filter((p) => p.status === 'done' && p.fingerprint);
  for (const p of projects) p.duplicates = [];

  const common = new Set();
  if (live.length >= 5) {
    const df = new Map();
    for (const p of live) for (const h of new Set(decode(p.fingerprint.code.hex))) df.set(h, (df.get(h) || 0) + 1);
    for (const [h, n] of df) if (n / live.length > 0.6) common.add(h);
  }

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i];
      const B = live[j];
      const r = compareFingerprints(A.fingerprint, B.fingerprint, common);
      if (!r) continue;
      for (const h of r.hits) {
        const roleA = r.copy === 'a' && ['code', 'fork'].includes(h.kind) ? 'copy' : r.copy === 'b' && ['code', 'fork'].includes(h.kind) ? 'original' : 'unknown';
        const roleB = roleA === 'copy' ? 'original' : roleA === 'original' ? 'copy' : 'unknown';
        const base = { kind: h.kind, severity: h.severity, similarity: r.similarity, note: h.note, sharedFiles: r.sharedFiles };
        A.duplicates.push({ ...base, otherId: B.id, otherName: B.name, role: roleA });
        B.duplicates.push({ ...base, otherId: A.id, otherName: A.name, role: roleB });
      }
    }
  }
  return projects;
}
