// Geodesy helpers: great-circle destination point and compass names.

const R_KM = 6371.0088;
const rad = Math.PI / 180;
const deg = 180 / Math.PI;

export function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const d = distanceKm / R_KM;
  const b = bearingDeg * rad;
  const p1 = lat * rad;
  const l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * deg, lon: ((l2 * deg + 540) % 360) - 180 };
}

export function initialBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * deg + 360) % 360;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassName(bearingDeg) {
  return POINTS[Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16];
}

const WORDS = { N: 'north', E: 'east', S: 'south', W: 'west' };
// "ESE" → "east" (for prose like "low clouds toward the east").
export function compassWord(bearingDeg) {
  const name = compassName(bearingDeg);
  if (name.length === 1) return WORDS[name];
  if (name.length === 2) return `${WORDS[name[0]]}${WORDS[name[1]]}`;
  return WORDS[name[0]];
}
