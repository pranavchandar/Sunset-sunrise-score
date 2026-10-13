// Runs the GitHub storage backend against a small in-process fake of the GitHub contents API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGitHub } from './fake-github.js';
import { githubStorage } from '../storage.js';

const fake = fakeGitHub();
const gh = fake.server;

let ghBase, appServer, appBase, appModule;
before(async () => {
  await new Promise((r) => gh.listen(0, r));
  ghBase = `http://127.0.0.1:${gh.address().port}`;
  Object.assign(process.env, { GITHUB_TOKEN: 't0ken', GITHUB_REPO: 'me/sky', GITHUB_BRANCH: 'sky-data', GITHUB_API: ghBase, ADMIN_TOKEN: 'adm' });
  appModule = await import('../server.js');
});
after(() => { appServer?.close(); gh.close(); });

async function startApp() {
  appServer?.close();
  await appModule.load();
  appServer = appModule.createServer();
  await new Promise((r) => appServer.listen(0, r));
  appBase = `http://127.0.0.1:${appServer.address().port}`;
}

const rating = (n, over = {}) => ({
  eventId: `12.96,80.24:sunset:2026-10-${10 + n}`, clientId: `c${n}`, type: 'sunset', eventTime: Date.now(), rating: 4,
  location: { name: 'Perungudi', lat: 12.96, lon: 80.24 }, predicted: { score: 70, label: 'Great', factors: {} }, metrics: {}, ...over,
});
const post = (b) => fetch(`${appBase}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const admin = (p, init = {}) => fetch(`${appBase}${p}`, { ...init, headers: { Authorization: 'Bearer adm', 'Content-Type': 'application/json' } });

test('creates the data branch and commits each rating there', async () => {
  await startApp();
  assert.equal(fake.branches['sky-data'], 'c0');
  assert.equal((await post(rating(1))).status, 201);
  assert.equal(fake.commits.at(-1), 'Rating: sunset 4★ at Perungudi');
  assert.equal(JSON.parse(fake.files['sky-data:data/feedback.json'].text).length, 1);
  assert.equal(fake.files['main:data/feedback.json'], undefined);
  const health = await (await fetch(`${appBase}/api/health`)).json();
  assert.deepEqual(health, { ok: true, storage: 'github', storageOk: true, ratings: 1 });
});

test('a burst of ratings is merged into fewer commits and nothing is lost', async () => {
  const before = fake.commits.length;
  const results = await Promise.all([2, 3, 4, 5, 6].map((n) => post(rating(n))));
  assert.ok(results.every((r) => r.status === 201));
  assert.ok(fake.commits.length - before < 5, `${fake.commits.length - before} commits`);
  assert.equal(JSON.parse(fake.files['sky-data:data/feedback.json'].text).length, 6);
});

test('ratings and tuned weights survive a restart (large file read via raw)', async () => {
  const w = { canvas: 30, horizon: 35, low: 15, aod: 10, moisture: 10 };
  assert.equal((await admin('/api/admin/config', { method: 'PUT', body: JSON.stringify({ weights: w, version: 'tuned-x' }) })).status, 200);
  await startApp(); // fresh load from "GitHub"
  const { items, storage } = await (await admin('/api/admin/feedback')).json();
  assert.equal(items.length, 6);
  assert.equal(storage, 'GitHub me/sky@sky-data');
  assert.deepEqual((await (await fetch(`${appBase}/api/config`)).json()).weights, w);
  // Still writable after restart (sha re-read on load).
  assert.equal((await post(rating(7))).status, 201);
});

test('recovers when the file was edited elsewhere (stale sha)', async () => {
  const f = fake.files['sky-data:data/feedback.json'];
  f.sha = 'changed-by-someone-else';
  assert.equal((await post(rating(8))).status, 201);
  assert.equal(JSON.parse(fake.files['sky-data:data/feedback.json'].text).length, 8);
});

test('a failed save answers 503 so the browser keeps the rating and retries', async () => {
  fake.failNextPut = 1;
  assert.equal((await post(rating(9))).status, 503);
  assert.equal((await post(rating(9))).status, 200); // retry of the same rating is accepted (dedupe → update)
  assert.equal(JSON.parse(fake.files['sky-data:data/feedback.json'].text).length, 9);
});

test('refuses to use the deploy branch for data', async () => {
  const s = githubStorage({ token: 't0ken', repo: 'me/sky', branch: 'main', api: ghBase });
  await assert.rejects(s.init(), /separate data branch/);
  assert.throws(() => githubStorage({ token: 'x', repo: 'not a repo' }), /owner\/name/);
});
