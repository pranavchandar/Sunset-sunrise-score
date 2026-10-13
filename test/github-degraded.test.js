// A token that can read but not write (the Render deploy failure): the app must
// still start and serve predictions, explain the problem, and recover once fixed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGitHub } from './fake-github.js';

const fake = fakeGitHub();
fake.readOnly = true;
let app, base, mod;

before(async () => {
  await new Promise((r) => fake.server.listen(0, r));
  Object.assign(process.env, {
    GITHUB_TOKEN: 't0ken', GITHUB_REPO: 'me/sky', GITHUB_BRANCH: 'sky-data',
    GITHUB_API: `http://127.0.0.1:${fake.server.address().port}`, ADMIN_TOKEN: 'adm', STORAGE_RETRY_MS: '1',
  });
  mod = await import('../server.js');
  await mod.load(); // must not throw
  app = mod.createServer();
  await new Promise((r) => app.listen(0, r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => { app.close(); fake.server.close(); });

const post = () => fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  eventId: '12.96,80.24:sunset:2026-10-12', clientId: 'c1', type: 'sunset', rating: 3, location: { name: 'X' }, predicted: { score: 50, factors: {} }, metrics: {},
}) });

test('starts and serves the app even though storage is read-only', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.storageOk, false);
});

test('ratings get 503 (browser keeps them) and admin sees an actionable error', async () => {
  assert.equal((await post()).status, 503);
  const data = await (await fetch(`${base}/api/admin/feedback`, { headers: { Authorization: 'Bearer adm' } })).json();
  assert.match(data.storageError, /Contents → Read and write/);
  const put = await fetch(`${base}/api/admin/config`, { method: 'PUT', headers: { Authorization: 'Bearer adm' }, body: '{}' });
  assert.equal(put.status, 503);
});

test('recovers by itself once the token can write', async () => {
  fake.readOnly = false;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await post()).status, 201);
  assert.equal(fake.branches['sky-data'], 'c0');
  assert.equal(JSON.parse(fake.files['sky-data:data/feedback.json'].text).length, 1);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).storageOk, true);
});
