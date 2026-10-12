// localStorage helpers (every access wrapped — private mode and blocked storage
// must never break the page) plus the "Sky Scout" player profile.

const PREFIX = 'skyscore:';

export function get(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function set(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function clientId() {
  let id = get('clientId', null);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    set('clientId', id);
  }
  return id;
}

// ---------- Sky Scout profile ----------

export const XP_PER_LEVEL = 60;

export const BADGES = [
  { id: 'first', name: 'First Light', desc: 'Rate your first sky' },
  { id: 'early', name: 'Early Bird', desc: 'Rate a sunrise' },
  { id: 'dusk', name: 'Dusk Patrol', desc: 'Rate 5 sunsets' },
  { id: 'storm', name: 'Storm Chaser', desc: 'Rate a sky after a clearing storm' },
  { id: 'oracle', name: 'Oracle', desc: '3 forecasts confirmed within a star' },
  { id: 'nomad', name: 'Nomad', desc: 'Rate skies in 2 places' },
  { id: 'streak', name: 'Sky Streak', desc: 'Rate on 3 days in a row' },
];

const TITLES = ['Cloud Spotter', 'Horizon Scout', 'Golden Hunter', 'Afterglow Ranger', 'Sky Oracle', 'Firmament Legend'];

export function profile() {
  const p = get('profile', null) || { xp: 0, ratings: [], badges: [] };
  const level = Math.floor(p.xp / XP_PER_LEVEL) + 1;
  return {
    ...p,
    level,
    title: TITLES[Math.min(TITLES.length - 1, Math.floor((level - 1) / 2))],
    progress: (p.xp % XP_PER_LEVEL) / XP_PER_LEVEL,
    toNext: XP_PER_LEVEL - (p.xp % XP_PER_LEVEL),
  };
}

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function streakOf(days) {
  const set = new Set(days);
  let best = 0;
  for (const d of set) {
    let n = 1;
    let t = Date.parse(d);
    while (set.has(dayKey(t - 86400000))) { n++; t -= 86400000; }
    best = Math.max(best, n);
  }
  return best;
}

/** Record a rating locally; returns { gained, newBadges, levelUp }. */
export function recordRating({ eventId, type, rating, predictedScore, hadClearing, place, tags, note }) {
  const p = get('profile', null) || { xp: 0, ratings: [], badges: [] };
  const already = p.ratings.find((r) => r.eventId === eventId);
  const levelBefore = Math.floor(p.xp / XP_PER_LEVEL) + 1;
  let gained = 0;
  if (!already) {
    gained = 20 + (tags && tags.length ? 5 : 0) + (note ? 5 : 0);
    p.xp += gained;
    p.ratings.push({ eventId, type, rating, predictedScore, hadClearing: !!hadClearing, place, t: Date.now() });
  } else {
    Object.assign(already, { rating, predictedScore });
  }
  p.ratings = p.ratings.slice(-500);

  const R = p.ratings;
  const earned = new Set(p.badges);
  const check = {
    first: R.length >= 1,
    early: R.some((r) => r.type === 'sunrise'),
    dusk: R.filter((r) => r.type === 'sunset').length >= 5,
    storm: R.some((r) => r.hadClearing),
    oracle: R.filter((r) => Number.isFinite(r.predictedScore) && Math.abs(r.predictedScore - (r.rating - 1) * 25) <= 25).length >= 3,
    nomad: new Set(R.map((r) => r.place)).size >= 2,
    streak: streakOf(R.map((r) => dayKey(r.t))) >= 3,
  };
  const newBadges = BADGES.filter((b) => check[b.id] && !earned.has(b.id));
  for (const b of newBadges) { p.badges.push(b.id); p.xp += 15; gained += 15; }
  set('profile', p);
  return { gained, newBadges, levelUp: Math.floor(p.xp / XP_PER_LEVEL) + 1 > levelBefore };
}

export function ratingFor(eventId) {
  const p = get('profile', null);
  return p ? p.ratings.find((r) => r.eventId === eventId) : undefined;
}
