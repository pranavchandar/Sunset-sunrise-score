import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destinationPoint, compassName, initialBearing } from '../public/js/geo.js';
import { sunPosition, timeAtAltitude, lightPhases } from '../public/js/sun.js';

const LAT = 12.96, LON = 80.24;

test('destination point lies on the requested bearing and distance', () => {
  for (const b of [0, 97, 180, 263]) {
    const p = destinationPoint(LAT, LON, b, 100);
    assert.ok(Math.abs(initialBearing(LAT, LON, p.lat, p.lon) - b) < 0.01);
  }
  const north = destinationPoint(0, 0, 0, 111.195);
  assert.ok(Math.abs(north.lat - 1) < 0.001 && Math.abs(north.lon) < 1e-9);
});

test('compass names', () => {
  assert.equal(compassName(0), 'N');
  assert.equal(compassName(112.5), 'ESE');
  assert.equal(compassName(247.5), 'WSW');
  assert.equal(compassName(359), 'N');
});

test('Chennai in October: sunrise toward ESE (south of east), sunset toward WSW', () => {
  // 12 Oct 2026. Sunrise ≈ 06:00 IST (00:30Z), sunset ≈ 17:55 IST (12:25Z).
  const day = Date.UTC(2026, 9, 12);
  const rise = timeAtAltitude(LAT, LON, day - 3 * 3600e3, day + 4 * 3600e3, -0.833);
  const set = timeAtAltitude(LAT, LON, day + 9 * 3600e3, day + 15 * 3600e3, -0.833);
  const riseIst = new Date(rise + 5.5 * 3600e3);
  const setIst = new Date(set + 5.5 * 3600e3);
  const minutes = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
  assert.ok(Math.abs(minutes(riseIst) - 6 * 60) < 20, `sunrise ${riseIst.toISOString()}`);
  assert.ok(Math.abs(minutes(setIst) - (17 * 60 + 55)) < 20, `sunset ${setIst.toISOString()}`);
  console.log('sunrise IST', riseIst.toISOString().slice(11, 16), 'sunset IST', setIst.toISOString().slice(11, 16));

  const azRise = sunPosition(rise, LAT, LON).azimuth;
  const azSet = sunPosition(set, LAT, LON).azimuth;
  assert.ok(azRise > 90 && azRise < 112.5, `sunrise az ${azRise}`);
  assert.ok(azSet > 247.5 && azSet < 270, `sunset az ${azSet}`);

  // Horizon sample points: east of the site at sunrise, west at sunset, and south of it in both.
  for (const km of [50, 100, 200]) {
    const pr = destinationPoint(LAT, LON, azRise, km);
    const ps = destinationPoint(LAT, LON, azSet, km);
    console.log(`${km} km  sunrise az ${azRise.toFixed(1)}° → ${pr.lat.toFixed(3)},${pr.lon.toFixed(3)}  sunset az ${azSet.toFixed(1)}° → ${ps.lat.toFixed(3)},${ps.lon.toFixed(3)}`);
    assert.ok(pr.lon > LON && pr.lat < LAT);
    assert.ok(ps.lon < LON && ps.lat < LAT);
  }
});

test('light phases: golden hour brackets sunset, blue hour follows it', () => {
  const day = Date.UTC(2026, 9, 12);
  const set = timeAtAltitude(LAT, LON, day + 9 * 3600e3, day + 15 * 3600e3, -0.833);
  const p = lightPhases('sunset', set, LAT, LON, 100);
  assert.ok(p.golden[0] < set && p.golden[1] > set);
  assert.ok(p.blue[0] >= p.golden[1] - 1000);
  assert.ok(p.extraMinutes > 0.5 && p.extraMinutes < 3, `extra ${p.extraMinutes}`);
});
