import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'skyscore-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_TOKEN = 'test-token';
const { createServer, load } = await import('../server.js');

let server, base;
before(async () => {
  await load();
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const rating = (over = {}) => ({
  eventId: '12.96,80.24:sunset:2026-10-12', clientId: 'c1', type: 'sunset', eventTime: Date.now(), rating: 4,
  tags: ['fiery', 'bogus'], note: '=cmd()', location: { name: 'Perungudi', lat: 12.96, lon: 80.24 },
  predicted: { score: 72, label: 'Great', base: 70, factors: { canvas: 1, horizon: 0.8, low: 1, aod: 0.6, moisture: 1 }, modifiers: ['clearing'] },
  metrics: { high: 40, aod: 0.45, evil: 'x' }, ...over,
});
const post = (body) => fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const admin = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', ...(init.headers || {}) } });

test('serves the app', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>/);
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 403);
});

test('records, dedupes and exports ratings', async () => {
  assert.equal((await post(rating())).status, 201);
  assert.equal((await post(rating({ rating: 5 }))).status, 200); // same client+event → replaced
  assert.equal((await post(rating({ clientId: 'c2' }))).status, 201);
  assert.equal((await post(rating({ rating: 9 }))).status, 400);
  assert.equal((await post({ nope: 1 })).status, 400);

  assert.equal((await fetch(`${base}/api/admin/feedback`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/feedback`, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
  const { items } = await (await admin('/api/admin/feedback')).json();
  assert.equal(items.length, 2);
  const mine = items.find((i) => i.clientId === 'c1');
  assert.equal(mine.rating, 5);
  assert.deepEqual(mine.tags, ['fiery']);
  assert.equal(mine.metrics.evil, undefined);

  const csv = await (await admin('/api/admin/export.csv')).text();
  assert.match(csv.split('\n')[0], /^id,receivedAt,eventId/);
  assert.match(csv, /'=cmd\(\)/);

  assert.equal((await admin(`/api/admin/feedback/${mine.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await admin('/api/admin/feedback')).json()).items.length, 1);
});

test('tuned config round trip', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), {});
  assert.equal((await admin('/api/admin/config', { method: 'PUT', body: JSON.stringify({ weights: { canvas: 30 } }) })).status, 400);
  const w = { canvas: 30, horizon: 35, low: 15, aod: 10, moisture: 10 };
  assert.equal((await admin('/api/admin/config', { method: 'PUT', body: JSON.stringify({ weights: w, version: 'tuned-test' }) })).status, 200);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(cfg.weights, w);
  assert.equal(cfg.version, 'tuned-test');
  await admin('/api/admin/config', { method: 'DELETE' });
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), {});
});
