import { cfg } from './config.js';

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|java|kt|go|rb|php|cs|rs|swift|vue|svelte|html|json|ya?ml|toml|md|txt|env|example|sh|gradle)$/i;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|vendor|venv|\.venv|__pycache__|coverage|\.git)\//;
const MAX_FILES = 60;
const MAX_FILE_BYTES = 120_000;

export function parseRepoUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { host, owner, repo, supported: host === 'github.com' || host === 'www.github.com' };
}

async function gh(path) {
  const { github } = cfg();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'JudgeMintAI' };
  if (github.token) headers.Authorization = `Bearer ${github.token}`;
  const res = await fetch(`${github.apiBase}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return { notFound: true };
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub API rate limit reached. Add a free GITHUB_TOKEN to .env and retry.');
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  return { data: await res.json() };
}

async function raw(owner, repo, branch, filePath) {
  const { github } = cfg();
  const url = `${github.rawBase}/${owner}/${repo}/${encodeURIComponent(branch)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, MAX_FILE_BYTES);
  } catch {
    return null;
  }
}

function priority(p) {
  const l = p.toLowerCase();
  if (/(^|\/)package\.json$|requirements\.txt$|pyproject\.toml$|pom\.xml$|go\.mod$|composer\.json$/.test(l)) return 0;
  if (/readme/.test(l)) return 1;
  if (/paypal|checkout|payment|billing|order/.test(l)) return 2;
  if (/(^|\/)(server|app|index|main|routes?|api)\.[a-z]+$/.test(l)) return 3;
  if (/\.env\.example$|\.env\.sample$/.test(l)) return 3;
  if (/(^|\/)(src|server|backend|api|lib|routes)\//.test(l)) return 4;
  return 5;
}

/**
 * List the public repositories of a GitHub user or organisation, or the repositories that carry a topic
 * (hackathons often ask entrants to tag their repo, or to publish it inside one organisation).
 */
export async function listGithubRepos({ owner, topic, limit = 50 }) {
  const per = Math.max(1, Math.min(100, limit));
  let items = [];
  if (topic) {
    const r = await gh(`/search/repositories?q=${encodeURIComponent(`topic:${topic}`)}&sort=updated&per_page=${per}`);
    items = r.data?.items || [];
  } else if (owner) {
    let r = await gh(`/orgs/${encodeURIComponent(owner)}/repos?per_page=${per}&sort=pushed&type=public`);
    if (r.notFound) r = await gh(`/users/${encodeURIComponent(owner)}/repos?per_page=${per}&sort=pushed&type=owner`);
    if (r.notFound) throw new Error(`GitHub user or organisation "${owner}" was not found.`);
    items = r.data || [];
  }
  return items.filter((x) => x && !x.private).slice(0, limit).map((x) => ({
    name: x.name, repoUrl: x.html_url, description: x.description || '', fork: Boolean(x.fork),
  }));
}

/**
 * Collect everything the agents need about a repository.
 * Returns { found:false } when the repo does not exist / is private (no token),
 * which is itself a (critical) finding for the Technical agent.
 */
export async function fetchRepoBundle(repoUrl) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return { found: false, reason: 'Repository URL is not a valid repo link (expected https://github.com/owner/repo).' };
  if (!parsed.supported) {
    return { found: false, unsupported: true, parsed, reason: `Only GitHub repositories can be deeply analysed right now (got ${parsed.host}).` };
  }
  const { owner, repo } = parsed;
  const meta = await gh(`/repos/${owner}/${repo}`);
  if (meta.notFound) return { found: false, parsed, reason: 'Repository was not found or is private. Hackathon rules require a PUBLIC repo.' };
  const m = meta.data;
  const branch = m.default_branch || 'main';

  const [treeRes, commitsRes, licenseRes, langRes] = await Promise.all([
    gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`).catch(() => ({})),
    gh(`/repos/${owner}/${repo}/commits?per_page=100`).catch(() => ({})),
    gh(`/repos/${owner}/${repo}/license`).catch(() => ({})),
    gh(`/repos/${owner}/${repo}/languages`).catch(() => ({})),
  ]);

  const tree = (treeRes.data?.tree || []).filter((n) => n.type === 'blob');
  const treePaths = tree.map((n) => n.path);
  const candidates = tree
    .filter((n) => !SKIP_DIR.test(n.path + '/') && CODE_EXT.test(n.path) && (n.size ?? 0) <= MAX_FILE_BYTES && !/package-lock\.json|yarn\.lock|pnpm-lock/.test(n.path))
    .sort((a, b) => priority(a.path) - priority(b.path))
    .slice(0, MAX_FILES);

  const files = {};
  // fetch in small batches so we stay polite to raw.githubusercontent.com
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i + 8);
    const texts = await Promise.all(batch.map((n) => raw(owner, repo, branch, n.path)));
    batch.forEach((n, j) => { if (texts[j] != null) files[n.path] = texts[j]; });
  }

  const commits = (commitsRes.data || []).map((c) => ({
    sha: c.sha?.slice(0, 7),
    date: c.commit?.author?.date,
    message: (c.commit?.message || '').split('\n')[0].slice(0, 120),
    author: c.commit?.author?.name,
  }));

  return {
    found: true,
    parsed,
    meta: {
      fullName: m.full_name,
      description: m.description || '',
      isPrivate: m.private,
      fork: m.fork,
      archived: m.archived,
      // For a fork GitHub names the repository it was forked from (used to spot entries copied from other entries).
      parentFullName: m.parent?.full_name || null,
      sourceFullName: m.source?.full_name || null,
      defaultBranch: branch,
      createdAt: m.created_at,
      pushedAt: m.pushed_at,
      stars: m.stargazers_count,
      size: m.size,
      topics: m.topics || [],
      licenseSpdx: licenseRes.data?.license?.spdx_id || m.license?.spdx_id || null,
      licenseName: licenseRes.data?.license?.name || m.license?.name || null,
    },
    languages: langRes.data || {},
    treePaths,
    files,
    commits,
  };
}
