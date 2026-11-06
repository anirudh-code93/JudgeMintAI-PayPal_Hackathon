import { validateInput } from './auditor.js';
import { listGithubRepos } from './github.js';

// Turn whatever an organiser has (pasted links, an export from Devpost or a form, a JSON list, a GitHub organisation)
// into a clean list of entries. Nothing here fetches the repositories themselves; evaluation does that later.

const EMAIL = /[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']{2,}/;
export const isEmail = (s) => typeof s === 'string' && s.length <= 127 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

const REPO_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com'];

export function classifyUrl(u) {
  let x;
  try { x = new URL(u); } catch { return null; }
  if (!['http:', 'https:'].includes(x.protocol)) return null;
  const host = x.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const parts = x.pathname.split('/').filter(Boolean);
  if (REPO_HOSTS.includes(host)) return parts.length >= 2 ? 'repo' : 'other';
  if (VIDEO_HOSTS.includes(host)) return 'video';
  if (host === 'devpost.com' || host.endsWith('.devpost.com')) return 'ignore'; // the project page on the contest site, not the project
  return 'demo';
}

export function extractUrls(text) {
  return [...String(text ?? '').matchAll(/https?:\/\/[^\s,;<>"')\]]+/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
}

/** Pick the repo, demo and video link out of any pile of links. */
function sortLinks(urls) {
  const out = { repoUrl: '', demoUrl: '', videoUrl: '' };
  for (const u of urls) {
    const kind = classifyUrl(u);
    if (kind === 'repo' && !out.repoUrl) out.repoUrl = u;
    else if (kind === 'video' && !out.videoUrl) out.videoUrl = u;
    else if (kind === 'demo' && !out.demoUrl) out.demoUrl = u;
  }
  return out;
}

// ---- pasted text: one entry per line ----------------------------------------------------------------------------------
export function parseLines(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const links = sortLinks(extractUrls(line));
    const email = (line.match(EMAIL) || [''])[0];
    // what is left of the line once links, emails and separators are removed is taken as the project name
    const left = line.replace(/https?:\/\/\S+/gi, ' ').replace(EMAIL, ' ').replace(/[|,;\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    rows.push({ name: left.length && left.length <= 80 ? left : '', ...links, payoutEmail: email, _row: line.slice(0, 80) });
  }
  return rows;
}

// ---- CSV -----------------------------------------------------------------------------------------------------------------
export function parseCsvText(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => { let n = 0; let q = false; for (const c of first) { if (c === '"') q = !q; else if (c === ch && !q) n++; } return n; };
  const delim = [',', ';', '\t'].map((d) => [d, count(d)]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const COLS = {
  name: ['projectname', 'projecttitle', 'title', 'name', 'project', 'submissiontitle', 'entryname'],
  repo: ['repo', 'repository', 'repourl', 'repositoryurl', 'github', 'githuburl', 'githubrepo', 'githublink', 'coderepository', 'coderepositoryurl', 'codeurl', 'sourcecode', 'sourcecodeurl', 'gitrepo', 'repolink'],
  demo: ['demo', 'demourl', 'demolink', 'liveurl', 'livedemo', 'livedemourl', 'website', 'websiteurl', 'projecturl', 'appurl', 'url', 'link', 'hosteddemo', 'deployedurl'],
  video: ['video', 'videourl', 'videolink', 'demovideo', 'demovideourl', 'youtube', 'youtubeurl', 'youtubelink', 'pitchvideo'],
  description: ['description', 'projectdescription', 'shortdescription', 'tagline', 'elevatorpitch', 'about', 'aboutproject', 'summary', 'whatitdoes', 'pitch', 'details'],
  toolsUsed: ['tools', 'toolsused', 'builtwith', 'technologies', 'technologiesused', 'tech', 'techstack', 'stack', 'toolsandmodels'],
  links: ['tryitoutlinks', 'tryitout', 'links', 'otherlinks', 'projectlinks', 'submissionurl'],
  payoutEmail: ['email', 'payoutemail', 'paypalemail', 'contactemail', 'submitteremail', 'emailaddress', 'teamemail'],
  team: ['team', 'teamname', 'members', 'teammembers', 'submitter', 'author', 'submittedby', 'submittername'],
};
const keyOf = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function fieldFor(header) {
  const k = keyOf(header);
  return Object.entries(COLS).find(([, names]) => names.includes(k))?.[0] || null;
}

/** Rows of cells (first row = headers) or a list of objects, mapped to entries. */
function mapRecords(records) {
  return records.map((rec, i) => {
    const e = { _row: `row ${i + 1}` };
    const links = [];
    for (const [header, value] of Object.entries(rec)) {
      const v = Array.isArray(value) ? value.join(' ') : String(value ?? '').trim();
      if (!v) continue;
      const field = fieldFor(header);
      if (field === 'repo' || field === 'demo' || field === 'video' || field === 'links') links.push(...extractUrls(v));
      else if (field) e[field] = e[field] ? `${e[field]} ${v}` : v;
      else if (/^https?:\/\//i.test(v)) links.push(...extractUrls(v)); // an unlabelled column that holds a link
    }
    return { ...e, ...sortLinks(links) };
  });
}

export function parseCsv(text) {
  const table = parseCsvText(text);
  if (!table.length) return [];
  const header = table[0];
  const looksLikeData = header.some((c) => /^https?:\/\//i.test(String(c).trim()));
  if (looksLikeData) return parseLines(table.map((r) => r.join(' ')).join('\n')); // no header row: treat as plain lines
  return mapRecords(table.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))));
}

export function parseJson(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { throw new Error('The JSON could not be read. Check the brackets and quotes.'); } }
  const list = Array.isArray(v) ? v : Array.isArray(v?.projects) ? v.projects : null;
  if (!list) throw new Error('The JSON must be a list of projects, or { "projects": [...] }.');
  return mapRecords(list.filter((x) => x && typeof x === 'object'));
}

/**
 * Collect entries from one or more sources: { text, csv, json, github: { owner | topic } }.
 * Returns { entries, notes } where notes explains anything that could not be read.
 */
export async function collectEntries(body = {}, { limit = 50 } = {}) {
  const entries = [];
  const notes = [];
  if (body.text) entries.push(...parseLines(body.text));
  if (body.csv) entries.push(...parseCsv(body.csv));
  if (body.json) entries.push(...parseJson(body.json));
  if (body.github && (body.github.owner || body.github.topic)) {
    const owner = String(body.github.owner || '').trim().replace(/^@/, '');
    const topic = String(body.github.topic || '').trim().toLowerCase();
    if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw new Error('That does not look like a GitHub user or organisation name.');
    if (topic && !/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic)) throw new Error('A GitHub topic uses lowercase letters, numbers and dashes.');
    const repos = await listGithubRepos({ owner, topic, limit });
    if (!repos.length) notes.push('GitHub returned no public repositories for that organisation or topic.');
    for (const r of repos) entries.push({ name: r.name, repoUrl: r.repoUrl, description: r.description, _row: r.repoUrl });
  }
  return { entries, notes };
}

/**
 * Validate the entries and keep at most `room` of them.
 * Returns { projects, skipped: [{ row, reason }], overflow }.
 */
export function cleanEntries(entries, room) {
  const projects = [];
  const skipped = [];
  let overflow = 0;
  for (const e of entries) {
    const { ok, errors, input } = validateInput({
      projectName: e.name, repoUrl: e.repoUrl, demoUrl: e.demoUrl, videoUrl: e.videoUrl, description: e.description, toolsUsed: e.toolsUsed,
    });
    if (!e.repoUrl) { skipped.push({ row: e._row || e.name || '?', reason: 'No repository link (GitHub, GitLab or Bitbucket) was found.' }); continue; }
    if (!ok) { skipped.push({ row: e._row || e.repoUrl, reason: errors.join(' ') }); continue; }
    const email = String(e.payoutEmail || '').trim();
    if (projects.length >= room) { overflow++; continue; }
    projects.push({
      name: input.projectName, repoUrl: input.repoUrl, demoUrl: input.demoUrl, videoUrl: input.videoUrl,
      description: input.description, toolsUsed: input.toolsUsed,
      payoutEmail: isEmail(email) ? email : '', team: String(e.team || '').trim().slice(0, 120),
    });
  }
  return { projects, skipped, overflow };
}
