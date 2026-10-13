// Fetches Open-Meteo forecast + air quality and turns them into scored events.

import { destinationPoint } from './geo.js';
import { sunPosition, lightPhases } from './sun.js';
import { scoreEvent } from './scoring.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

const HOURLY = 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,cloud_cover,relative_humidity_2m,visibility,precipitation,pressure_msl,cape';
const MIN = 60000;
const HOUR = 3600000;

// Short in-memory cache so toggling between saved spots is instant.
// A full page refresh always fetches a fresh prediction.
const memo = new Map();
const MEMO_MS = 10 * MIN;

async function getJSON(url, { signal } = {}) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.t < MEMO_MS) return hit.data;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try { reason = (await res.json()).reason || reason; } catch { /* not JSON */ }
    throw new Error(reason);
  }
  const data = await res.json();
  memo.set(url, { t: Date.now(), data });
  return data;
}

export function clearCache() { memo.clear(); }

export async function geocode(name, signal) {
  const url = `${GEOCODE}?name=${encodeURIComponent(name)}&count=8&language=en&format=json`;
  const data = await getJSON(url, { signal });
  return (data.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    country: r.country,
    lat: r.latitude,
    lon: r.longitude,
    elevation: r.elevation,
    timezone: r.timezone,
  }));
}

// Open-Meteo local time strings ("2026-10-12T18:00") → epoch ms using the response's UTC offset.
const toMs = (local, offsetSec) => Date.parse(`${local.length === 10 ? `${local}T00:00` : local}:00Z`) - offsetSec * 1000;

function hourlyIndex(times, offsetSec) {
  const ms = times.map((t) => toMs(t, offsetSec));
  return {
    ms,
    nearest(target) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < ms.length; i++) {
        const d = Math.abs(ms[i] - target);
        if (d < bestD) { bestD = d; best = i; }
      }
      return bestD <= HOUR ? best : -1;
    },
  };
}

const at = (arr, i) => (arr && i >= 0 && i < arr.length && arr[i] !== null ? arr[i] : undefined);

/**
 * Load everything for a location and score every sunrise/sunset in range.
 * @param {{lat:number, lon:number}} loc
 * @param {{config, observerHeightM?:number, gpsAltitude?:number}} opts
 */
export async function loadForecast(loc, { config, observerHeightM = 0, gpsAltitude, signal } = {}) {
  const ll = `latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}`;
  const [wx, air] = await Promise.all([
    getJSON(`${FORECAST}?${ll}&hourly=${HOURLY}&daily=sunrise,sunset&timezone=auto&forecast_days=4&past_days=1`, { signal }),
    getJSON(`${AIR}?${ll}&hourly=aerosol_optical_depth,pm2_5,dust&timezone=auto&forecast_days=4&past_days=1`, { signal })
      .catch((e) => ({ error: e.message })), // air quality is optional
  ]);

  const off = wx.utc_offset_seconds || 0;
  const H = hourlyIndex(wx.hourly.time, off);
  const A = air && air.hourly ? hourlyIndex(air.hourly.time, air.utc_offset_seconds || 0) : null;

  // Raw sunrise/sunset list.
  const raw = [];
  wx.daily.time.forEach((day, i) => {
    for (const type of ['sunrise', 'sunset']) {
      const s = wx.daily[type][i];
      if (s) raw.push({ type, day, T: toMs(s, off) });
    }
  });
  raw.sort((a, b) => a.T - b.T);

  // Sample points toward the sun (horizon + sunward canvas) and away from it
  // (clouds that catch the glow). Sunrise/sunset azimuths drift < 2° over 4 days
  // (~7 km at 200 km — under a grid cell), so one set per event type keeps it
  // to a single batched request.
  const firstOf = (type) => raw.find((e) => e.type === type);
  const azimuths = {};
  for (const type of ['sunrise', 'sunset']) {
    const e = firstOf(type);
    if (e) azimuths[type] = sunPosition(e.T, loc.lat, loc.lon).azimuth;
  }
  const points = [];
  for (const [type, az] of Object.entries(azimuths)) {
    config.horizon.distancesKm.forEach((km) => points.push({ type, kind: 'sun', km, ...destinationPoint(loc.lat, loc.lon, az, km) }));
    config.canvasSources.antiDistancesKm.forEach((km) => points.push({ type, kind: 'anti', km, ...destinationPoint(loc.lat, loc.lon, (az + 180) % 360, km) }));
  }
  let horizonData = null;
  let horizonError = null;
  if (points.length) {
    try {
      const lats = points.map((p) => p.lat.toFixed(4)).join(',');
      const lons = points.map((p) => p.lon.toFixed(4)).join(',');
      const res = await getJSON(`${FORECAST}?latitude=${lats}&longitude=${lons}&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high&timezone=auto&forecast_days=4&past_days=1`, { signal });
      horizonData = Array.isArray(res) ? res : [res];
    } catch (e) {
      horizonError = e.message;
    }
  }
  points.forEach((p, i) => {
    const d = horizonData && horizonData[i];
    p.hours = d ? hourlyIndex(d.hourly.time, d.utc_offset_seconds || 0) : null;
    p.hourly = d ? d.hourly : null;
  });

  const terrain = Number.isFinite(wx.elevation) ? wx.elevation : null;
  const groundM = Number.isFinite(gpsAltitude) ? gpsAltitude : terrain;
  const elevationM = Number.isFinite(groundM) ? groundM + observerHeightM : (observerHeightM || undefined);

  const h = wx.hourly;
  const events = [];
  for (const e of raw) {
    const peakCenter = e.T + (e.type === 'sunset' ? 1 : -1) * config.peak.centerOffsetMin * MIN;
    const i = H.nearest(peakCenter);
    if (i < 0) continue;
    const bearing = sunPosition(e.T, loc.lat, loc.lon).azimuth;

    let rain12h = 0, have12 = 0;
    for (let k = Math.max(0, i - 12); k < i; k++) {
      if (Number.isFinite(h.precipitation[k])) { rain12h += h.precipitation[k]; have12++; }
    }
    const pressureTrend = i >= 3 && Number.isFinite(h.pressure_msl[i]) && Number.isFinite(h.pressure_msl[i - 3])
      ? h.pressure_msl[i] - h.pressure_msl[i - 3] : undefined;

    const ai = A ? A.nearest(H.ms[i]) : -1;
    const sampleAt = (kind) => points.filter((p) => p.type === e.type && p.kind === kind).map((p) => {
      if (!p.hours) return null;
      const j = p.hours.nearest(H.ms[i]);
      return { km: p.km, lat: p.lat, lon: p.lon, low: at(p.hourly.cloud_cover_low, j), mid: at(p.hourly.cloud_cover_mid, j), high: at(p.hourly.cloud_cover_high, j) };
    });
    const samples = sampleAt('sun');
    const antiSamples = sampleAt('anti');
    const horizon = samples.every((s) => s && Number.isFinite(s.low)) ? samples : null;
    const anti = antiSamples.every((s) => s && Number.isFinite(s.low)) ? antiSamples : null;

    const inputs = {
      type: e.type,
      bearing,
      high: at(h.cloud_cover_high, i),
      mid: at(h.cloud_cover_mid, i),
      low: at(h.cloud_cover_low, i),
      total: at(h.cloud_cover, i),
      rh: at(h.relative_humidity_2m, i),
      visibility: at(h.visibility, i),
      precip: at(h.precipitation, i) ?? 0,
      rain12h: have12 ? rain12h : undefined,
      pressureTrend,
      aod: A ? at(air.hourly.aerosol_optical_depth, ai) : undefined,
      pm25: A ? at(air.hourly.pm2_5, ai) : undefined,
      dust: A ? at(air.hourly.dust, ai) : undefined,
      horizon,
      anti,
      cape: at(h.cape, i),
      elevationM,
    };
    const [p0, p1] = config.peak[e.type];
    events.push({
      id: `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}:${e.type}:${e.day}`,
      type: e.type,
      day: e.day,
      T: e.T,
      peak: [e.T + p0 * MIN, e.T + p1 * MIN],
      hourMs: H.ms[i],
      bearing,
      inputs,
      samples,
      antiSamples,
      phases: lightPhases(e.type, e.T, loc.lat, loc.lon, Math.max(0, elevationM ?? 0)),
      result: scoreEvent(inputs, config),
    });
  }

  return {
    events,
    timezone: wx.timezone || loc.timezone,
    terrainElevation: terrain,
    elevationM,
    fetchedAt: Date.now(),
    airError: air && air.error ? air.error : null,
    horizonError,
    points,
  };
}
