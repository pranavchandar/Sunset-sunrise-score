import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvent, canvasFactor, aodFactor, horizonCloud, moistureFactor, labelFor } from '../public/js/scoring.js';
import { DEFAULT_CONFIG, mergeConfig } from '../public/js/config.js';

const clearHorizon = [{ low: 0, mid: 0 }, { low: 0, mid: 0 }, { low: 0, mid: 0 }];
const base = { high: 0, mid: 0, low: 0, total: 0, horizon: clearHorizon, aod: 0.2, rh: 60, visibility: 20000, precip: 0, rain12h: 0, pressureTrend: 0 };

test('clear sky scores 35 or below', () => {
  const r = scoreEvent(base);
  assert.ok(r.score <= 35, `got ${r.score}`);
  assert.ok(r.modifiers.some((m) => m.id === 'clearsky'));
});

test('overcast scores 15 or below', () => {
  const r = scoreEvent({ ...base, high: 100, mid: 100, low: 100, total: 100, horizon: [{ low: 100, mid: 100 }, { low: 100, mid: 100 }, { low: 100, mid: 100 }] });
  assert.ok(r.score <= 15, `got ${r.score}`);
});

test('overcast high cloud alone (clear low, clear horizon) is still capped', () => {
  const r = scoreEvent({ ...base, high: 100, total: 98 });
  assert.ok(r.score <= 15, `got ${r.score}`);
});

test('50% high cloud, clear horizon, AOD 0.2 scores 75 or above', () => {
  const r = scoreEvent({ ...base, high: 50, total: 50 });
  assert.ok(r.score >= 75, `got ${r.score}`);
  assert.equal(r.rank, 'S');
});

test('50% high cloud but 80% low cloud on the horizon scores below 45', () => {
  const blocked = [{ low: 80, mid: 0 }, { low: 80, mid: 0 }, { low: 80, mid: 0 }];
  const r = scoreEvent({ ...base, high: 50, total: 50, horizon: blocked });
  assert.ok(r.score < 45, `got ${r.score}`);
  assert.equal(r.nemesis, 'horizon');
});

test('rain at peak multiplies by 0.3', () => {
  const dry = scoreEvent({ ...base, high: 50, total: 60 });
  const wet = scoreEvent({ ...base, high: 50, total: 60, precip: 2 });
  assert.equal(wet.score, Math.round(dry.base * 0.3));
});

test('clearing storm adds 10', () => {
  const plain = scoreEvent({ ...base, high: 40, total: 50, aod: 0.9, rh: 90 });
  const clearing = scoreEvent({ ...base, high: 40, total: 50, aod: 0.9, rh: 90, rain12h: 4, pressureTrend: 1.2 });
  assert.equal(clearing.score - plain.score, 10);
  assert.ok(clearing.reasons.some((r) => /Rain clearing/.test(r.text)));
});

test('no clearing bonus when pressure is falling', () => {
  const r = scoreEvent({ ...base, high: 40, total: 50, rain12h: 4, pressureTrend: -0.5 });
  assert.ok(!r.modifiers.some((m) => m.id === 'clearing'));
});

test('elevation buff only above threshold and bounded', () => {
  const lowView = scoreEvent({ ...base, high: 40, total: 50, aod: 0.9, rh: 90, elevationM: 20 });
  const hill = scoreEvent({ ...base, high: 40, total: 50, aod: 0.9, rh: 90, elevationM: 5000 });
  assert.ok(!lowView.modifiers.some((m) => m.id === 'elevation'));
  assert.equal(hill.score - lowView.score, DEFAULT_CONFIG.modifiers.elevationMaxBonus);
});

test('score is always 0–100 and integer', () => {
  for (let i = 0; i < 500; i++) {
    const rnd = () => Math.random() * 100;
    const r = scoreEvent({ high: rnd(), mid: rnd(), low: rnd(), total: rnd(), horizon: [{ low: rnd(), mid: rnd() }], aod: Math.random(), rh: rnd(), visibility: Math.random() * 30000, precip: Math.random() * 2, rain12h: Math.random() * 10, pressureTrend: Math.random() * 4 - 2, elevationM: Math.random() * 3000 });
    assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100);
    assert.ok(r.reasons.length >= 2 && r.reasons.length <= 4);
  }
});

test('component curves', () => {
  assert.equal(canvasFactor(0), 0);
  assert.equal(canvasFactor(15), 0.5);
  assert.equal(canvasFactor(50), 1);
  assert.equal(canvasFactor(100), 0);
  assert.equal(aodFactor(0.05), 0.8);
  assert.equal(aodFactor(0.2), 1);
  assert.ok(Math.abs(aodFactor(0.45) - 0.65) < 1e-9);
  assert.equal(aodFactor(0.9), 0.1);
  assert.equal(moistureFactor(90, 3000), 0);
  assert.equal(moistureFactor(90, 10000), 0.5);
  assert.ok(Math.abs(horizonCloud([{ low: 100, mid: 0 }, { low: 0, mid: 0 }, { low: 0, mid: 0 }]) - 40) < 1e-9);
  assert.equal(horizonCloud([{ low: 100, mid: 100 }]), 100);
});

test('labels', () => {
  assert.equal(labelFor(10).label, 'Poor');
  assert.equal(labelFor(30).label, 'Fair');
  assert.equal(labelFor(50).label, 'Good');
  assert.equal(labelFor(70).label, 'Great');
  assert.equal(labelFor(90).label, 'Epic');
});

test('mergeConfig keeps a 100-point scale and ignores junk', () => {
  const c = mergeConfig(DEFAULT_CONFIG, { weights: { canvas: 70, horizon: 60, low: 30, aod: 20, moisture: 20, evil: 9 }, version: 'tuned-1' });
  const sum = Object.values(c.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9);
  assert.equal(c.weights.canvas, 35);
  assert.equal(c.version, 'tuned-1');
  assert.equal(c.weights.evil, undefined);
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, null).weights, DEFAULT_CONFIG.weights);
});
