// Pure scoring: forecast numbers in, score + game-style breakdown out.
// No DOM, no fetch — runs the same in the browser and under `node --test`.

import { DEFAULT_CONFIG } from './config.js';
import { compassWord } from './geo.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x, fallback = 0) => (Number.isFinite(x) ? x : fallback);

export function canvasFactor(hm, cfg = DEFAULT_CONFIG) {
  const { rampUpTo, plateauTo } = cfg.canvas;
  if (hm <= 0) return 0;
  if (hm < rampUpTo) return hm / rampUpTo;
  if (hm <= plateauTo) return 1;
  return clamp((100 - hm) / (100 - plateauTo), 0, 1);
}

// Weighted (low + 0.5·mid) at the horizon sample points, capped at 100.
export function horizonCloud(samples, cfg = DEFAULT_CONFIG) {
  if (!samples || !samples.length) return null;
  const { sampleWeights, midFactor } = cfg.horizon;
  let sum = 0, wsum = 0;
  samples.forEach((s, i) => {
    if (!s || !Number.isFinite(s.low)) return;
    const w = sampleWeights[i] ?? sampleWeights[sampleWeights.length - 1];
    sum += w * (s.low + midFactor * num(s.mid));
    wsum += w;
  });
  return wsum ? Math.min(100, sum / wsum) : null;
}

export function horizonFactor(hz, cfg = DEFAULT_CONFIG) {
  return Math.pow(clamp(1 - hz / 100, 0, 1), cfg.horizon.exponent);
}

export function aodFactor(aod, cfg = DEFAULT_CONFIG) {
  const a = cfg.aod;
  if (!Number.isFinite(aod)) return a.unknownScore;
  if (aod < a.clean) return a.cleanScore;
  if (aod <= a.sweetMax) return 1;
  if (aod <= a.hazyMax) return 1 - ((aod - a.sweetMax) / (a.hazyMax - a.sweetMax)) * (1 - a.hazyFloor);
  return a.heavyScore;
}

export function moistureFactor(rh, visibilityM, cfg = DEFAULT_CONFIG) {
  const m = cfg.moisture;
  let v = 1;
  if (Number.isFinite(rh) && rh > m.rhLimit) v -= m.penalty;
  if (Number.isFinite(visibilityM) && visibilityM < m.visLimitM) v -= m.penalty;
  return Math.max(0, v);
}

export function labelFor(score, cfg = DEFAULT_CONFIG) {
  return cfg.labels.find((l) => score >= l.min) ?? cfg.labels[cfg.labels.length - 1];
}

/**
 * @param {object} x
 *   high, mid, low, total      cloud cover % overhead at the peak hour
 *   horizon                    [{low, mid}] at 50/100/200 km toward the sun
 *   aod, pm25, rh, visibility  air & moisture (visibility in m)
 *   precip                     mm at the peak hour
 *   rain12h                    mm in the 12 h before the peak hour
 *   pressureTrend              hPa change over the previous 3 h
 *   elevationM                 observer altitude (optional)
 *   bearing, type              sun azimuth and 'sunrise' | 'sunset' (for wording)
 */
export function scoreEvent(x, cfg = DEFAULT_CONFIG) {
  const W = cfg.weights;
  const high = num(x.high), mid = num(x.mid), low = num(x.low);
  const total = Number.isFinite(x.total) ? x.total : Math.max(high, mid, low);
  const HM = Math.max(high, mid);
  const HZ = horizonCloud(x.horizon, cfg);
  const hzKnown = HZ !== null;
  const hz = hzKnown ? HZ : low; // fall back to overhead low cloud if the horizon fetch failed

  const f = {
    canvas: canvasFactor(HM, cfg),
    horizon: horizonFactor(hz, cfg),
    low: clamp(1 - low / 100, 0, 1),
    aod: aodFactor(x.aod, cfg),
    moisture: moistureFactor(x.rh, x.visibility, cfg),
  };
  const gate = cfg.horizon.gatesCanvas ? f.horizon : 1;

  const components = {
    canvas: { factor: f.canvas, max: W.canvas, points: W.canvas * f.canvas * gate, gate, input: HM },
    horizon: { factor: f.horizon, max: W.horizon, points: W.horizon * f.horizon, input: hz, estimated: !hzKnown },
    low: { factor: f.low, max: W.low, points: W.low * f.low, input: low },
    aod: { factor: f.aod, max: W.aod, points: W.aod * f.aod, input: x.aod },
    moisture: { factor: f.moisture, max: W.moisture, points: W.moisture * f.moisture, input: { rh: x.rh, visibility: x.visibility } },
  };

  const base = Object.values(components).reduce((s, c) => s + c.points, 0);
  let score = base;
  const M = cfg.modifiers;
  const modifiers = [];

  const rainNow = num(x.precip) > M.rainAtEventMm;
  if (rainNow) {
    const before = score;
    score *= M.rainMultiplier;
    modifiers.push({ id: 'rain', kind: 'debuff', name: 'Rain Curse', effect: `×${M.rainMultiplier}`, delta: score - before, detail: `${num(x.precip).toFixed(1)} mm of rain forecast at peak time` });
  }

  if (num(x.rain12h) > M.clearingRain12hMm && num(x.precip) < 0.1 && num(x.pressureTrend) > 0) {
    score += M.clearingBonus;
    modifiers.push({ id: 'clearing', kind: 'buff', name: 'Clearing Storm', effect: `+${M.clearingBonus}`, delta: M.clearingBonus, detail: `${num(x.rain12h).toFixed(1)} mm rain earlier, pressure rising ${num(x.pressureTrend).toFixed(1)} hPa` });
  }

  if (Number.isFinite(x.elevationM) && x.elevationM > M.elevationMinM) {
    const t = clamp((x.elevationM - M.elevationMinM) / (M.elevationMaxM - M.elevationMinM), 0, 1);
    const bonus = Math.round(t * M.elevationMaxBonus * 10) / 10;
    if (bonus > 0) {
      score += bonus;
      modifiers.push({ id: 'elevation', kind: 'buff', name: 'High Ground', effect: `+${bonus}`, delta: bonus, detail: `Viewing from ${Math.round(x.elevationM)} m: a lower horizon and less haze to look through` });
    }
  }

  if (total > M.overcastTotal && score > M.overcastCap) {
    modifiers.push({ id: 'overcast', kind: 'cap', name: 'Overcast Lid', effect: `max ${M.overcastCap}`, delta: M.overcastCap - score, detail: `${Math.round(total)}% total cloud: no gaps for light` });
    score = M.overcastCap;
  }

  if (HM < M.clearSkyHM && low < M.clearSkyLow && score > M.clearSkyCap) {
    modifiers.push({ id: 'clearsky', kind: 'cap', name: 'Empty Canvas', effect: `max ${M.clearSkyCap}`, delta: M.clearSkyCap - score, detail: 'Clear sky: a soft gradient, but no clouds to set on fire' });
    score = M.clearSkyCap;
  }

  score = Math.round(clamp(score, 0, 100));
  const lab = labelFor(score, cfg);

  // Game summary: who carried the score, and what cost the most.
  // Points the canvas lost to the horizon gate are blamed on the horizon.
  const gateLoss = W.canvas * f.canvas * (1 - gate);
  const ranked = Object.entries(components).map(([k, c]) => ({
    key: k,
    points: c.points,
    lost: c.max - c.points + (k === 'horizon' ? gateLoss : k === 'canvas' ? -gateLoss : 0),
  }));
  const mvp = ranked.slice().sort((a, b) => b.points - a.points)[0];
  const nemesis = ranked.slice().sort((a, b) => b.lost - a.lost)[0];

  const result = {
    score, label: lab.label, rank: lab.rank, base: Math.round(base * 10) / 10,
    HM, HZ: hz, components, modifiers, mvp: mvp.key, nemesis: nemesis.lost > 2 ? nemesis.key : null,
    lost: Object.fromEntries(ranked.map((c) => [c.key, c.lost])),
  };
  result.reasons = explain(x, result, cfg);
  return result;
}

// 2–4 plain-language reasons, most important first.
export function explain(x, r, cfg = DEFAULT_CONFIG) {
  const out = [];
  const dir = Number.isFinite(x.bearing) ? `toward the ${compassWord(x.bearing)}` : 'toward the sun';
  const HM = Math.round(r.HM), HZ = Math.round(r.HZ), low = Math.round(num(x.low));
  const push = (weight, text, tone) => out.push({ weight, text, tone });

  if (r.modifiers.some((m) => m.id === 'rain')) push(100, 'Rain at peak time will dampen the show', 'bad');
  if (r.modifiers.some((m) => m.id === 'overcast')) push(95, `Overcast (${Math.round(num(x.total))}%) — the sky is sealed`, 'bad');
  if (r.modifiers.some((m) => m.id === 'clearing')) push(90, 'Rain clearing earlier — washed air, a classic setup', 'good');

  if (HM >= cfg.canvas.rampUpTo && HM <= cfg.canvas.plateauTo) push(80, `Good amount of high/mid cloud to catch color (${HM}%)`, 'good');
  else if (HM > cfg.canvas.plateauTo) push(60, `Thick high/mid cloud (${HM}%) — may be too dense to glow`, 'meh');
  else if (HM >= 5) push(55, `Thin cloud canvas (${HM}%) — some color, not a full fire`, 'meh');
  else push(70, 'Almost no high or mid cloud — expect a clean gradient', 'meh');

  if (HZ >= 60) push(85, `Clouds ${dir} (${HZ}%) may block the light`, 'bad');
  else if (HZ >= 30) push(50, `Some cloud ${dir} (${HZ}%) could dim the light`, 'meh');
  else push(65, `Horizon ${dir} looks clear (${HZ}%) — light can get through`, 'good');

  if (low >= 50) push(75, `Lots of low cloud overhead (${low}%)`, 'bad');

  if (Number.isFinite(x.aod)) {
    if (x.aod > cfg.aod.sweetMax) push(x.aod > cfg.aod.hazyMax ? 72 : 45, `Hazy air (AOD ${x.aod.toFixed(2)}) will mute the colors`, 'bad');
    else if (x.aod >= cfg.aod.clean) push(40, `Light aerosols (AOD ${x.aod.toFixed(2)}) can deepen the reds`, 'good');
  }
  if (Number.isFinite(x.rh) && x.rh > cfg.moisture.rhLimit) push(42, `Humid air (${Math.round(x.rh)}% RH) softens the colors`, 'bad');
  if (Number.isFinite(x.visibility) && x.visibility < cfg.moisture.visLimitM) push(42, `Low visibility (${(x.visibility / 1000).toFixed(1)} km)`, 'bad');

  if (r.modifiers.some((m) => m.id === 'elevation')) push(30, 'Your altitude gives you a lower horizon and longer light', 'good');

  return out.sort((a, b) => b.weight - a.weight).slice(0, 4).map(({ text, tone }) => ({ text, tone }));
}

// Display metadata for each component — the "character stats".
export const STAT_INFO = {
  canvas: { name: 'Cloud Canvas', short: 'CNV', hint: 'High & mid clouds that catch the light. Best at 30–70%.' },
  horizon: { name: 'Light Path', short: 'PTH', hint: 'How clear the sky is 50–200 km toward the sun.' },
  low: { name: 'Open Sky', short: 'SKY', hint: 'Low cloud overhead blocks the show. Less is better.' },
  aod: { name: 'Air Clarity', short: 'AIR', hint: 'Aerosols: a little deepens reds; heavy haze dulls them.' },
  moisture: { name: 'Dry Air', short: 'DRY', hint: 'High humidity or poor visibility washes colors out.' },
};
