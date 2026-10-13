// Every weight and threshold the scorer uses lives here so it can be tuned
// (by hand, or by the admin page's "apply suggested weights" from user feedback).

export const DEFAULT_LOCATION = {
  name: 'Perungudi, Chennai',
  country: 'India',
  lat: 12.96,
  lon: 80.24,
  timezone: 'Asia/Kolkata',
};

export const DEFAULT_CONFIG = {
  version: 'v1',

  // Component weights (points). They sum to 100.
  weights: {
    canvas: 35,   // high + mid cloud overhead
    horizon: 30,  // clear horizon toward the sun
    low: 15,      // low cloud overhead
    aod: 10,      // aerosol optical depth
    moisture: 10, // humidity + visibility
  },

  canvas: { rampUpTo: 30, plateauTo: 70 },        // % HM: 0 → 1 → 1 → 0 at 100

  // Clouds that can light up don't have to be overhead. The canvas is the best of:
  //   overhead     max(high, mid) above you
  //   sunward      max(high, mid) 50–100 km toward the sun (the brightest part of the sky)
  //   opposite     low/mid cloud 30–60 km away from the sun, catching the golden light
  //                side-on; taller (convective) clouds make a better glowing wall.
  canvasSources: {
    sunwardSampleWeights: [0.6, 0.4], // the first horizon samples: 50 and 100 km
    sunwardWeight: 0.6,     // a lit band near the sun: pretty, but less than a whole lit sky
    antiDistancesKm: [30, 60],
    antiSampleWeights: [0.6, 0.4],
    antiWeight: 0.4,        // flat or modest cloud opposite the sun
    antiVolumeBonus: 0.2,   // extra weight for towering cloud (CAPE)
    capeFull: 1000,         // J/kg at which the volume bonus is fully earned
  },
  horizon: {
    distancesKm: [50, 100, 200],
    sampleWeights: [0.4, 0.35, 0.25],
    midFactor: 0.5,   // HZ = low + 0.5·mid
    exponent: 1.5,
    // Sunlight has to pass the horizon before it can light the overhead canvas,
    // so canvas points are scaled by the horizon factor. Without this gate a
    // blocked horizon still scores "Great" just from overhead cirrus.
    gatesCanvas: true,
  },
  aod: { clean: 0.1, sweetMax: 0.3, hazyMax: 0.6, cleanScore: 0.8, hazyFloor: 0.3, heavyScore: 0.1, unknownScore: 0.7 },
  moisture: { rhLimit: 85, visLimitM: 5000, penalty: 0.5 },

  modifiers: {
    rainAtEventMm: 0.5,
    rainMultiplier: 0.3,
    clearingRain12hMm: 1,
    clearingBonus: 10,
    overcastTotal: 95,
    overcastCap: 15,
    // Canvas limit: with little low cloud overhead, the score can't exceed
    // 35 + 65 × canvas factor. No canvas anywhere → 35 (a plain gradient).
    clearSkyLow: 10,
    clearSkyCap: 35,
    // Observer altitude: a higher vantage sees a lower, longer-lit horizon and
    // looks over part of the boundary-layer haze. Small, linear buff.
    elevationMinM: 150,
    elevationMaxM: 1500,
    elevationMaxBonus: 6,
  },

  labels: [
    { min: 80, label: 'Epic', rank: 'S' },
    { min: 65, label: 'Great', rank: 'A' },
    { min: 45, label: 'Good', rank: 'B' },
    { min: 25, label: 'Fair', rank: 'C' },
    { min: 0, label: 'Poor', rank: 'D' },
  ],

  // Peak color window relative to the event time (minutes).
  peak: { sunset: [5, 20], sunrise: [-20, -5], centerOffsetMin: 10 },
};

// Merge tuned overrides (from /api/config) onto the defaults. Only known,
// numeric weights are accepted.
export function mergeConfig(base, overrides) {
  const cfg = structuredClone(base);
  if (overrides && typeof overrides === 'object' && overrides.weights) {
    for (const k of Object.keys(cfg.weights)) {
      const v = Number(overrides.weights[k]);
      if (Number.isFinite(v) && v >= 0 && v <= 100) cfg.weights[k] = v;
    }
    // Keep the scale at 100 points whatever was saved.
    const sum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
    if (sum > 0) for (const k of Object.keys(cfg.weights)) cfg.weights[k] = (cfg.weights[k] * 100) / sum;
    else cfg.weights = { ...base.weights };
    if (typeof overrides.version === 'string') cfg.version = overrides.version.slice(0, 40);
  }
  return cfg;
}
