// Where ratings and tuned weights live. Two backends, same interface:
//
//   read(name)                  → parsed JSON or null
//   write(name, value, message) → resolves once the data is durable
//
// File:   DATA_DIR/<name>.json on local disk (default; fine on a machine with a real disk).
// GitHub: <name>.json on a dedicated branch of a GitHub repo, through the REST API.
//         Survives restarts on hosts with throwaway disks (e.g. Render's free plan),
//         and every rating becomes a commit you can browse or revert.
//         Enabled when GITHUB_TOKEN and GITHUB_REPO are set.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export function fileStorage(dir) {
  const file = (name) => path.join(dir, `${name}.json`);
  return {
    kind: 'file',
    describe: `files in ${dir}`,
    async init() { await fs.mkdir(dir, { recursive: true }); },
    async read(name) {
      try { return JSON.parse(await fs.readFile(file(name), 'utf8')); } catch { return null; }
    },
    async write(name, value) {
      const tmp = `${file(name)}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value, null, 1));
      await fs.rename(tmp, file(name)); // atomic replace
    },
  };
}

export function githubStorage({ token, repo, branch = 'sky-data', api = 'https://api.github.com' }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPO must look like owner/name, got "${repo}"`);
  const shas = new Map(); // name → blob sha of the version we last read or wrote

  async function gh(method, url, body, accept = 'application/vnd.github+json') {
    const res = await fetch(`${api}/repos/${repo}${url}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sky-score',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || res.statusText;
      const hint = res.status === 401 ? ' (GITHUB_TOKEN is invalid or expired)'
        : res.status === 403 && method !== 'GET' ? ` (the token can read ${repo} but not write to it: give it Repository permissions → Contents → Read and write)`
        : '';
      throw Object.assign(new Error(`GitHub ${method} ${url}: ${res.status} ${msg}${hint}`), { status: res.status });
    }
    return accept.endsWith('raw') ? res.text() : res.json();
  }

  const filePath = (name) => `/contents/data/${name}.json`;

  async function fetchFile(name) {
    const meta = await gh('GET', `${filePath(name)}?ref=${encodeURIComponent(branch)}`);
    if (!meta) { shas.delete(name); return null; }
    shas.set(name, meta.sha);
    // The JSON response only inlines files up to 1 MB; larger ones need the raw media type.
    const text = meta.encoding === 'base64' && meta.content
      ? Buffer.from(meta.content, 'base64').toString('utf8')
      : await gh('GET', `${filePath(name)}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw');
    return JSON.parse(text);
  }

  return {
    kind: 'github',
    describe: `GitHub ${repo}@${branch}`,
    async init() {
      const info = await gh('GET', '');
      if (!info) throw new Error(`GitHub repo ${repo} not found, or the token can't see it`);
      // Each rating is a commit; on the deploy branch that would redeploy the app every time.
      if (info.default_branch === branch) throw new Error(`GITHUB_BRANCH must be a separate data branch, not "${branch}"`);
      if (await gh('GET', `/branches/${encodeURIComponent(branch)}`)) return;
      // First run: create the data branch from the default branch's head.
      const head = await gh('GET', `/git/ref/heads/${encodeURIComponent(info.default_branch)}`);
      await gh('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: head.object.sha });
    },
    read: fetchFile,
    async write(name, value, message = `Update ${name}`) {
      const content = Buffer.from(JSON.stringify(value)).toString('base64');
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await gh('PUT', filePath(name), { message, content, branch, ...(shas.has(name) ? { sha: shas.get(name) } : {}) });
          shas.set(name, res.content.sha);
          return;
        } catch (e) {
          // 409/422: our sha is stale (someone edited the file). Memory is the source of truth: refresh the sha and overwrite.
          if (attempt >= 2 || ![409, 422].includes(e.status)) throw e;
          const meta = await gh('GET', `${filePath(name)}?ref=${encodeURIComponent(branch)}`);
          if (meta) shas.set(name, meta.sha); else shas.delete(name);
        }
      }
    },
  };
}

export function storageFromEnv(env, defaultDir) {
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    return githubStorage({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || undefined, api: env.GITHUB_API || undefined });
  }
  return fileStorage(env.DATA_DIR || defaultDir);
}
