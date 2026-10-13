// Minimal in-process fake of the GitHub REST endpoints storage.js uses.
import http from 'node:http';
import crypto from 'node:crypto';

export function fakeGitHub() {
  const fake = { branches: { main: 'c0' }, files: {}, commits: [], failNextPut: 0, readOnly: false };
  const blobSha = (text) => crypto.createHash('sha1').update(text).digest('hex');

  fake.server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const url = new URL(req.url, 'http://x');
    const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.headers.authorization !== 'Bearer t0ken') return reply(401, { message: 'Bad credentials' });
    if (fake.readOnly && req.method !== 'GET') return reply(403, { message: 'Resource not accessible by personal access token' });
    const m = url.pathname.match(/^\/repos\/me\/sky(.*)$/);
    if (!m) return reply(404, { message: 'Not Found' });
    const p = m[1];
    if (p === '' && req.method === 'GET') return reply(200, { default_branch: 'main' });
    let b;
    if ((b = p.match(/^\/branches\/(.+)$/))) return fake.branches[b[1]] ? reply(200, { name: b[1] }) : reply(404, { message: 'Branch not found' });
    if ((b = p.match(/^\/git\/ref\/heads\/(.+)$/))) return reply(200, { object: { sha: fake.branches[b[1]] } });
    if (p === '/git/refs' && req.method === 'POST') { fake.branches[body.ref.replace('refs/heads/', '')] = body.sha; return reply(201, {}); }
    if ((b = p.match(/^\/contents\/(.+)$/))) {
      const key = b[1];
      if (req.method === 'GET') {
        const branch = url.searchParams.get('ref');
        const f = fake.files[`${branch}:${key}`];
        if (!f) return reply(404, { message: 'Not Found' });
        if (req.headers.accept === 'application/vnd.github.raw') { res.writeHead(200); return res.end(f.text); }
        const big = f.text.length > 200; // pretend 200 bytes is GitHub's 1 MB inline limit
        return reply(200, { sha: f.sha, encoding: big ? 'none' : 'base64', content: big ? '' : Buffer.from(f.text).toString('base64') });
      }
      if (req.method === 'PUT') {
        if (!fake.branches[body.branch]) return reply(404, { message: 'Branch not found' });
        const id = `${body.branch}:${key}`;
        const cur = fake.files[id];
        if (fake.failNextPut) { fake.failNextPut--; return reply(500, { message: 'boom' }); }
        if (cur && cur.sha !== body.sha) return reply(409, { message: 'sha mismatch' });
        if (!cur && body.sha) return reply(422, { message: 'sha given for new file' });
        const text = Buffer.from(body.content, 'base64').toString('utf8');
        fake.files[id] = { text, sha: blobSha(text + Math.random()) };
        fake.commits.push(body.message);
        return reply(cur ? 200 : 201, { content: { sha: fake.files[id].sha } });
      }
    }
    return reply(404, { message: 'Not Found' });
  });
  return fake;
}
