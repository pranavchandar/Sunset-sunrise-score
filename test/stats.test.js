import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, suggestWeights, pearson, calibration, ratingToScore } from '../public/js/stats.js';
import { DEFAULT_CONFIG } from '../public/js/config.js';

const make = (factors, rating, score = 50) => ({ rating, predicted: { score, factors } });

test('summary metrics', () => {
  const s = summarize([make({}, 5, 100), make({}, 1, 0), make({}, 3, 75)]);
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.mae - 25 / 3) < 1e-9);
  assert.equal(s.hitRate, 1);
  assert.ok(s.r > 0.9);
  assert.equal(summarize([]).n, 0);
  assert.equal(ratingToScore(3), 50);
  assert.equal(pearson([1, 2], [1, 2]), null);
});

test('suggestWeights needs enough samples', () => {
  const r = suggestWeights([make({ canvas: 1, horizon: 1, low: 1, aod: 1, moisture: 1 }, 5)], DEFAULT_CONFIG.weights);
  assert.equal(r.ok, false);
});

test('suggestWeights shifts weight toward the factor that explains ratings', () => {
  // Ratings driven entirely by the horizon factor.
  const items = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 200; i++) {
    const f = { canvas: rnd(), horizon: rnd(), low: rnd(), aod: rnd(), moisture: rnd() };
    const stars = Math.max(1, Math.min(5, Math.round(1 + 4 * f.horizon)));
    items.push(make(f, stars));
  }
  const r = suggestWeights(items, DEFAULT_CONFIG.weights);
  assert.ok(r.ok);
  const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 0.5);
  assert.ok(r.weights.horizon > DEFAULT_CONFIG.weights.horizon, JSON.stringify(r.weights));
  assert.ok(r.weights.horizon === Math.max(...Object.values(r.weights)));
  assert.ok(r.maeAfter < r.maeBefore);
});

test('calibration buckets by label', () => {
  const c = calibration([make({}, 5, 90), make({}, 4, 85), make({}, 1, 10)], DEFAULT_CONFIG.labels);
  assert.deepEqual(c.map((x) => x.label), ['Poor', 'Fair', 'Good', 'Great', 'Epic']);
  assert.equal(c[4].n, 2);
  assert.equal(c[4].avgStars, 4.5);
  assert.equal(c[0].avgStars, 1);
  assert.equal(c[1].avgStars, null);
});
