// Solar position (the same low-precision algorithm SunCalc uses, ~0.1° accuracy),
// returned as a compass bearing from north rather than SunCalc's south-based azimuth.

const rad = Math.PI / 180;
const deg = 180 / Math.PI;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = rad * 23.4397;

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;

function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  return {
    dec: Math.asin(Math.sin(OBLIQUITY) * Math.sin(L)),
    ra: Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L)),
  };
}

// → { azimuth: degrees clockwise from north, altitude: degrees above horizon }
export function sunPosition(ms, lat, lon) {
  const d = toDays(ms);
  const phi = rad * lat;
  const { dec, ra } = sunCoords(d);
  const H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra;
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  return { azimuth: (azSouth * deg + 180 + 360) % 360, altitude: alt * deg };
}

// Find when the sun crosses `targetAlt` (degrees) between two times, by bisection.
// Returns null if it does not cross in that span.
export function timeAtAltitude(lat, lon, startMs, endMs, targetAlt) {
  let a = startMs, b = endMs;
  let fa = sunPosition(a, lat, lon).altitude - targetAlt;
  const fb = sunPosition(b, lat, lon).altitude - targetAlt;
  if (fa * fb > 0) return null;
  for (let i = 0; i < 40 && b - a > 1000; i++) {
    const m = (a + b) / 2;
    const fm = sunPosition(m, lat, lon).altitude - targetAlt;
    if (fa * fm <= 0) b = m;
    else { a = m; fa = fm; }
  }
  return Math.round((a + b) / 2);
}

// Geometric dip of the sea-level horizon seen from height h metres (degrees).
export const horizonDip = (heightM) => (heightM > 0 ? 0.0293 * Math.sqrt(heightM) : 0);

// Light phases around a sunrise/sunset at time T (ms).
// Golden hour: sun between +6° and -4°. Blue hour: -4° to -6°.
export function lightPhases(type, T, lat, lon, observerHeightM = 0) {
  const H = 3600 * 1000;
  const dip = horizonDip(observerHeightM);
  // Altitude is monotonic over these spans: falling around sunset, rising around sunrise.
  const [a, b] = type === 'sunset' ? [T - 3 * H, T + 2 * H] : [T - 2 * H, T + 3 * H];
  const at = (alt) => timeAtAltitude(lat, lon, a, b, alt);
  const span = (x, y) => (x && y ? [Math.min(x, y), Math.max(x, y)] : null);
  const golden = span(at(6), at(-4));
  const blue = span(at(-4), at(-6));
  const seaLevel = at(-0.833);
  const fromHeight = at(-0.833 - dip);
  const extraMinutes = seaLevel && fromHeight ? Math.abs(fromHeight - seaLevel) / 60000 : 0;
  return { golden, blue, dipDeg: dip, extraMinutes };
}
