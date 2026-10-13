import { DEFAULT_CONFIG, DEFAULT_LOCATION, mergeConfig } from './config.js';
import { loadForecast, geocode, clearCache } from './data.js';
import { STAT_INFO } from './scoring.js';
import { compassName } from './geo.js';
import * as store from './store.js';

const $ = (s, el = document) => el.querySelector(s);
const MIN = 60000, HOUR = 3600000;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  loc: store.get('location', DEFAULT_LOCATION),
  vantage: store.get('vantage', 0),
  config: DEFAULT_CONFIG,
  data: null,
  focusId: null,
  heading: null,
  prevSeen: store.get('seen', {}),
};

// ---------------------------------------------------------------- utils

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tz = () => state.data?.timezone || state.loc.timezone || undefined;
const fmtTime = (ms) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz() }).format(ms);
function fmtRange(a, b) {
  const f = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz() });
  return f.formatRange ? f.formatRange(a, b) : `${f.format(a)}–${f.format(b)}`;
}
const dateKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(ms);

function dayLabel(ms) {
  const k = dateKey(ms);
  if (k === dateKey(Date.now())) return 'Today';
  if (k === dateKey(Date.now() + 86400000)) return 'Tomorrow';
  if (k === dateKey(Date.now() - 86400000)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: tz() }).format(ms);
}

function duration(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const typeName = (t) => (t === 'sunrise' ? 'Sunrise' : 'Sunset');
const fmt = (v, digits = 0, unit = '') => (Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—');

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

const ICON = {
  sunrise: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 4v5M9.5 6.5 12 4l2.5 2.5M4.9 11.9l1.4 1.4M19.1 11.9l-1.4 1.4"/></svg>',
  sunset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 4v5M9.5 6.5 12 9l2.5-2.5M4.9 11.9l1.4 1.4M19.1 11.9l-1.4 1.4"/></svg>',
  canvas: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15a4 4 0 0 1 .5-8 5 5 0 0 1 9.4 1.5A3.5 3.5 0 0 1 17 15Z"/><path d="M5 19h14"/></svg>',
  horizon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 16h20"/><circle cx="12" cy="16" r="4"/><path d="M12 6v2M5 9l1.5 1.5M19 9l-1.5 1.5"/></svg>',
  low: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 7.7 8 9 4.6-1.3 8-4.5 8-9V6Z"/></svg>',
  aod: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/></svg>',
  moisture: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 14v5h14v-5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4Z"/><path d="M10 21h4"/></svg>',
};

// ---------------------------------------------------------------- theme

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('theme', null));
$('#themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
});

// ---------------------------------------------------------------- sky backdrop

function paintSky(ev) {
  const root = document.documentElement.style;
  const s = ev ? ev.result.score : 30;
  const set = !ev || ev.type === 'sunset';
  // Hues: zenith → mid-sky → horizon. Saturation follows the score.
  const [h1, h2, h3] = set ? [255, 330, 28] : [210, 335, 42];
  root.setProperty('--sky-h1', h1);
  root.setProperty('--sky-h2', h2);
  root.setProperty('--sky-h3', h3);
  root.setProperty('--sky-sat', `${Math.round(12 + s * 0.78)}%`);
  root.setProperty('--sun-glow', (0.25 + s / 130).toFixed(2));
}

// ---------------------------------------------------------------- data

async function fetchTunedConfig() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('api/config', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } // static hosting: no API, defaults apply
}

function upcomingEvents() {
  const now = Date.now();
  return state.data.events.filter((e) => e.peak[1] > now).slice(0, 6);
}

function recentEvents() {
  const now = Date.now();
  return state.data.events.filter((e) => e.peak[0] <= now && e.T > now - 36 * HOUR).reverse();
}

const focused = () => state.data.events.find((e) => e.id === state.focusId) || upcomingEvents()[0];

async function load({ fresh = false } = {}) {
  if (fresh) clearCache();
  const hero = $('#hero');
  hero.setAttribute('aria-busy', 'true');
  if (!state.data) hero.innerHTML = '<div class="skeleton hero-skel"></div>';
  $('#locName').textContent = state.loc.name;
  $('#refreshBtn').classList.add('spin');
  try {
    state.data = await loadForecast(state.loc, {
      config: state.config,
      observerHeightM: Number(state.vantage) || 0,
      gpsAltitude: state.loc.gpsAltitude,
    });
    if (!state.data.events.length) throw new Error('No sunrise or sunset in the forecast range');
    const up = upcomingEvents();
    if (!up.some((e) => e.id === state.focusId)) state.focusId = up[0]?.id ?? null;
    store.set('predictions', store.get('predictions', 0) + 1);
    render();
    rememberScores();
    logHorizonPoints();
  } catch (err) {
    console.error(err);
    hero.innerHTML = `<div class="card error">
      <p class="h2">Couldn't reach the sky models</p>
      <p class="muted small">${esc(err.message || err)}</p>
      <button class="btn btn-primary" type="button" id="retryBtn">Try again</button></div>`;
    $('#retryBtn').addEventListener('click', () => load({ fresh: true }));
  } finally {
    hero.setAttribute('aria-busy', 'false');
    $('#refreshBtn').classList.remove('spin');
  }
}

// Remember what we predicted, to show "▲ 6 since your last look" next time.
function rememberScores() {
  const seen = store.get('seen', {});
  const now = Date.now();
  for (const e of state.data.events) seen[e.id] = { s: e.result.score, t: now };
  for (const [k, v] of Object.entries(seen)) if (now - v.t > 5 * 86400000) delete seen[k];
  store.set('seen', seen);
}

function logHorizonPoints() {
  const pts = state.data.points.map((p) => `${p.type} ${p.kind === 'anti' ? 'opposite' : 'toward sun'} ${p.km} km → ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`);
  console.info('[sky-score] sample points\n' + pts.join('\n'));
}

// ---------------------------------------------------------------- render

function render() {
  const ev = focused();
  $('#today').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz() }).format(Date.now())
    + (state.loc.region ? ` · ${state.loc.region}` : '');
  paintSky(ev);
  renderHero(ev);
  renderStats(ev);
  renderList();
  renderRateList();
  renderScout();
  renderFooter();
}

function confidence(ev) {
  const lead = (ev.T - Date.now()) / HOUR;
  if (lead <= 24) return { bars: 3, text: 'High confidence' };
  if (lead <= 48) return { bars: 2, text: 'Medium confidence' };
  return { bars: 1, text: 'Low confidence' };
}

const signal = (c) => `<span class="signal" title="${c.text}" aria-label="${c.text}">${[1, 2, 3].map((i) => `<i class="${i <= c.bars ? 'on' : ''}"></i>`).join('')}</span>`;

function countdown(ev) {
  const now = Date.now();
  if (now < ev.peak[0]) return `Peak color in <b>${duration(ev.peak[0] - now)}</b>`;
  if (now <= ev.peak[1]) return `<b>Happening now</b> — look ${compassName(ev.bearing)}!`;
  return 'Done for today';
}

function trend(ev) {
  const prev = state.prevSeen[ev.id];
  if (!prev || Date.now() - prev.t < MIN) return '';
  const d = ev.result.score - prev.s;
  const ago = duration(Date.now() - prev.t);
  if (d === 0) return `<span class="trend">Unchanged since your last look (${ago} ago)</span>`;
  return `<span class="trend ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)} since your last look (${ago} ago)</span>`;
}

function dial(score, label) {
  const r = 52, c = 2 * Math.PI * r;
  return `<div class="dial" role="img" aria-label="Score ${score} out of 100, ${label}">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <defs><linearGradient id="dialGrad" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="var(--warm-1)"/><stop offset=".55" stop-color="var(--warm-2)"/><stop offset="1" stop-color="var(--warm-3)"/>
      </linearGradient></defs>
      <circle cx="60" cy="60" r="${r}" class="dial-track"/>
      <circle cx="60" cy="60" r="${r}" class="dial-arc" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - score / 100)}"/>
    </svg>
    <div class="dial-num"><span class="count" data-to="${score}">${reduceMotion ? score : 0}</span><small>${esc(label)}</small></div>
  </div>`;
}

function animateDial(root) {
  const arc = $('.dial-arc', root);
  const num = $('.count', root);
  if (!arc) return;
  const to = Number(num.dataset.to);
  requestAnimationFrame(() => { arc.style.strokeDashoffset = arc.dataset.target; });
  if (reduceMotion) return;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 1100);
    num.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function compass(ev) {
  const rot = state.heading === null ? ev.bearing : ev.bearing - state.heading;
  const live = state.heading !== null;
  return `<div class="compass" aria-label="Face ${compassName(ev.bearing)}, ${Math.round(ev.bearing)} degrees">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="29" class="compass-ring"/>
      ${live ? '' : '<text x="32" y="11" class="compass-n">N</text>'}
      <g class="compass-needle" style="transform: rotate(${rot}deg)"><path d="M32 9 39 34H25Z"/><circle cx="32" cy="32" r="3"/></g>
    </svg>
    <div><div class="compass-dir">Face ${compassName(ev.bearing)}</div>
    <div class="muted small">${Math.round(ev.bearing)}° ${live ? '· turn until the arrow points up' : 'from north'}</div></div>
  </div>`;
}

function renderHero(ev) {
  const hero = $('#hero');
  if (!ev) { hero.innerHTML = '<div class="card">No upcoming events in range.</div>'; return; }
  const r = ev.result;
  const next = upcomingEvents()[0];
  const ph = ev.phases;
  const c = confidence(ev);
  const showCompassBtn = 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches;
  hero.innerHTML = `
    <article class="card hero-card rank-${r.rank}">
      <div class="hero-top">
        <span class="pill">${ev.id === next?.id ? 'Next up' : 'Selected'}</span>
        <span class="hero-type">${ICON[ev.type]} ${typeName(ev.type)} · ${dayLabel(ev.T)} ${fmtTime(ev.T)}</span>
        ${signal(c)}
      </div>
      <div class="hero-main">
        ${dial(r.score, r.label)}
        <div class="hero-side">
          <div class="rank-badge" title="Sky rank">${r.rank}<small>rank</small></div>
          <p class="peak">Peak color<br><b>${fmtRange(ev.peak[0], ev.peak[1])}</b></p>
          <p class="small" id="countdown">${countdown(ev)}</p>
          ${trend(ev)}
        </div>
      </div>
      <ul class="reasons">${r.reasons.map((x) => `<li class="${x.tone}">${esc(x.text)}</li>`).join('')}</ul>
      <div class="hero-grid">
        ${compass(ev)}
        <div class="phases small">
          ${ph.golden ? `<div><span class="dot gold"></span>Golden hour <b>${fmtRange(ph.golden[0], ph.golden[1])}</b></div>` : ''}
          ${ph.blue ? `<div><span class="dot blue"></span>Blue hour <b>${fmtRange(ph.blue[0], ph.blue[1])}</b></div>` : ''}
          ${ph.extraMinutes >= 0.5 ? `<div class="muted">From ${Math.round(state.data.elevationM)} m you ${ev.type === 'sunset' ? 'keep' : 'get'} the sun ~${ph.extraMinutes.toFixed(1)} min ${ev.type === 'sunset' ? 'longer' : 'earlier'}</div>` : ''}
        </div>
      </div>
      <div class="actions">
        <button class="btn" type="button" data-act="ics">${ICON.cal} Calendar</button>
        <button class="btn" type="button" data-act="share">${ICON.share} Share</button>
        ${'Notification' in window && Date.now() < ev.peak[0] - 20 * MIN ? `<button class="btn" type="button" data-act="remind">${ICON.bell} Remind me</button>` : ''}
        ${showCompassBtn ? '<button class="btn" type="button" data-act="compass">Live compass</button>' : ''}
      </div>
    </article>`;
  animateDial(hero);
  hero.querySelector('.actions').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'ics') downloadICS(ev);
    if (act === 'share') share(ev);
    if (act === 'remind') remind(ev);
    if (act === 'compass') startCompass();
  });
}

// ---------- the game panel: Sky Stats ----------

function statInputText(key, ev) {
  const x = ev.inputs, r = ev.result;
  switch (key) {
    case 'canvas': {
      const c = r.canvas;
      const part = (label, v, key) => (v === null || v === undefined ? null : `${c.best === key ? '★ ' : ''}${label} ${Math.round(v)}%`);
      return [part('overhead', c.overhead, 'overhead'), part(`toward ${compassName(ev.bearing)}`, c.sunward, 'sunward'),
        part(`opposite ${compassName((ev.bearing + 180) % 360)}`, c.anti, 'anti')].filter(Boolean).join(' · ');
    }
    case 'horizon': return `${Math.round(r.HZ)}% cloud ${compassName(ev.bearing)}${r.components.horizon.estimated ? ' (est.)' : ''}`;
    case 'low': return `${fmt(x.low)}% low cloud`;
    case 'aod': return Number.isFinite(x.aod) ? `AOD ${x.aod.toFixed(2)}` : 'AOD n/a';
    case 'moisture': return `${fmt(x.rh)}% RH · ${Number.isFinite(x.visibility) ? (x.visibility / 1000).toFixed(0) : '—'} km vis`;
    default: return '';
  }
}

function statRow(key, ev) {
  const c = ev.result.components[key];
  const info = STAT_INFO[key];
  const level = Math.round(c.factor * 10);
  const gated = key === 'canvas' && c.gate < 0.95;
  return `<div class="stat" title="${esc(info.hint)}">
    <div class="stat-icon">${ICON[key]}</div>
    <div class="stat-body">
      <div class="stat-head"><span class="stat-name">${info.name}</span><span class="stat-lv">LV ${level}</span></div>
      <div class="seg" role="meter" aria-label="${info.name}" aria-valuemin="0" aria-valuemax="10" aria-valuenow="${level}">
        ${Array.from({ length: 10 }, (_, i) => `<i class="${i < level ? 'on' : ''}" style="--i:${i}"></i>`).join('')}
      </div>
      <div class="stat-sub muted small">${esc(statInputText(key, ev))}${gated ? ` · only ${Math.round(c.gate * 100)}% of light gets through` : ''}</div>
    </div>
    <div class="stat-pts"><b>+${Math.round(c.points)}</b><small>/${Math.round(c.max)}</small></div>
  </div>`;
}

function modChip(m) {
  return `<li class="mod ${m.kind}" title="${esc(m.detail)}"><b>${esc(m.name)}</b><span>${esc(m.effect)}</span><small>${esc(m.detail)}</small></li>`;
}

function tipFor(ev) {
  const s = ev.result.score;
  const rise = ev.type === 'sunrise';
  const best = ev.result.canvas.best;
  if (s >= 45 && best === 'anti') return `Turn your back to the ${rise ? 'sunrise' : 'sunset'}: the clouds in the ${compassName((ev.bearing + 180) % 360)} should glow gold and pink. Expose for the bright cloud tops.`;
  if (s >= 45 && best === 'sunward') return `Keep the ${compassName(ev.bearing)} horizon in frame. The color gathers in the clouds near the sun, so a zoomed-in shot of that band works well.`;
  if (s >= 65) return rise
    ? 'Arrive 30 min early: the best color comes before the sun clears the horizon. Shoot wide to catch the lit cloud overhead.'
    : "Don't leave at sunset. The afterglow often peaks 10–20 min later. Shoot wide and underexpose about 1 stop to keep the reds.";
  if (s >= 45) return 'Watch for gaps where light leaks under the clouds. A silhouette in the foreground makes a decent sky pop.';
  if (s >= 25) return `Expect soft pastels. Turn around too: the pink "Belt of Venus" glows opposite the ${rise ? 'sunrise' : 'sunset'}.`;
  return 'Probably one to skip. If you go anyway, look for sunbeams (crepuscular rays) through any gaps.';
}

function localNote(ev) {
  const near = Math.abs(state.loc.lat - DEFAULT_LOCATION.lat) < 0.5 && Math.abs(state.loc.lon - DEFAULT_LOCATION.lon) < 0.5;
  if (!near) return '';
  const month = new Date(ev.T).getUTCMonth();
  const monsoon = month >= 9 && month <= 11 ? ' Northeast monsoon season: watch for clearing-storm setups after rain.' : '';
  return ev.type === 'sunrise'
    ? `Chennai: the sun rises over the Bay of Bengal, so Besant Nagar or Thiruvanmiyur beach give a clean sea horizon.${monsoon}`
    : `Chennai: sunset is inland. A lakeside spot or a high rooftop clears the city haze line.${monsoon}`;
}

function radar(ev) {
  const S = 250, cx = S / 2, cy = S / 2, R = 86, maxKm = 200;
  const rad = Math.PI / 180;
  // Square-root radial scale: spreads the nearby points (30–100 km) without losing the 200 km ring.
  const rr = (km) => R * Math.sqrt(km / maxKm);
  const pos = (bearing, km) => [cx + rr(km) * Math.sin(bearing * rad), cy - rr(km) * Math.cos(bearing * rad)];
  const [sx, sy] = pos(ev.bearing, maxKm * 1.74);
  const [ex, ey] = pos(ev.bearing, maxKm);
  const cfg = state.config.horizon;
  const dots = (ev.samples || []).map((s, i) => {
    if (!s || !Number.isFinite(s.low)) return '';
    const hz = Math.min(100, s.low + cfg.midFactor * (s.mid || 0));
    const [x, y] = pos(ev.bearing, cfg.distancesKm[i]);
    return `<g><circle cx="${x}" cy="${y}" r="${7 + hz / 12}" class="radar-cloud" style="--o:${(0.15 + hz / 120).toFixed(2)}"><title>${cfg.distancesKm[i]} km: ${Math.round(hz)}% blocking cloud</title></circle>
      <text x="${x}" y="${y + 3.5}" class="radar-val">${Math.round(hz)}</text></g>`;
  }).join('');
  // Clouds opposite the sun that can catch the glow (max of low/mid).
  const anti = (ev.antiSamples || []).map((s, i) => {
    if (!s || !Number.isFinite(s.low)) return '';
    const v = Math.max(s.low, s.mid || 0);
    const km = state.config.canvasSources.antiDistancesKm[i];
    const [x, y] = pos((ev.bearing + 180) % 360, km);
    return `<g><circle cx="${x}" cy="${y}" r="${5 + v / 18}" class="radar-glow" style="--o:${(0.15 + v / 130).toFixed(2)}"><title>${km} km opposite the sun: ${Math.round(v)}% cloud to catch the glow</title></circle>
      <text x="${x}" y="${y + 3.5}" class="radar-val">${Math.round(v)}</text></g>`;
  }).join('');
  const [ax, ay] = pos((ev.bearing + 180) % 360, 80);
  const rings = [50, 100, 200].map((km) => `<circle cx="${cx}" cy="${cy}" r="${rr(km)}" class="radar-ring"/><text x="${cx + 3}" y="${cy - rr(km) + 10}" class="radar-km">${km}</text>`).join('');
  const cards = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([l, b]) => {
    // Skip the cardinal letter the sun would sit on.
    if (Math.abs(((ev.bearing - b + 540) % 360) - 180) < 14) return '';
    const [x, y] = pos(b, maxKm * 1.36);
    return `<text x="${x}" y="${y + 4}" class="radar-card">${l}</text>`;
  }).join('');
  return `<figure class="radar">
    <svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Sky scan: cloud blocking the light toward ${compassName(ev.bearing)} at 50, 100 and 200 km, and cloud to catch the glow opposite the sun">
      ${rings}${cards}
      <line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" class="radar-beam"/>
      <line x1="${cx}" y1="${cy}" x2="${ax}" y2="${ay}" class="radar-beam anti"/>
      ${dots}${anti}
      <circle cx="${cx}" cy="${cy}" r="${4 + ev.result.HM / 14}" class="radar-home"><title>Overhead canvas: ${Math.round(ev.result.HM)}% high/mid</title></circle>
      <circle cx="${sx}" cy="${sy}" r="9" class="radar-sun"/>
    </svg>
    <figcaption class="muted small">Grey: cloud blocking the light toward the sun (smaller is better). Gold: cloud opposite the sun that can catch the glow.</figcaption>
  </figure>`;
}

function rawMetrics(ev) {
  const x = ev.inputs, r = ev.result;
  const rows = [
    ['High cloud', fmt(x.high, 0, '%')], ['Mid cloud', fmt(x.mid, 0, '%')], ['Low cloud', fmt(x.low, 0, '%')], ['Total cloud', fmt(x.total, 0, '%')],
    ['Horizon cloud (HZ)', `${fmt(r.HZ, 0, '%')}${r.components.horizon.estimated ? ' est.' : ''}`],
    ['High/mid toward sun', fmt(r.canvas.sunward ?? NaN, 0, '%')], ['Cloud opposite sun', fmt(r.canvas.anti ?? NaN, 0, '%')],
    ['CAPE (cloud height)', fmt(x.cape, 0, ' J/kg')],
    ['AOD', fmt(x.aod, 2)], ['PM2.5', fmt(x.pm25, 0, ' µg/m³')], ['Dust', fmt(x.dust, 0, ' µg/m³')],
    ['Humidity', fmt(x.rh, 0, '%')], ['Visibility', Number.isFinite(x.visibility) ? `${(x.visibility / 1000).toFixed(1)} km` : '—'],
    ['Rain at peak', fmt(x.precip, 1, ' mm')], ['Rain, last 12 h', fmt(x.rain12h, 1, ' mm')], ['Pressure, 3 h trend', Number.isFinite(x.pressureTrend) ? `${x.pressureTrend > 0 ? '+' : ''}${x.pressureTrend.toFixed(1)} hPa` : '—'],
    ['Your altitude', Number.isFinite(x.elevationM) ? `${Math.round(x.elevationM)} m` : '—'],
    ['Model hour used', fmtTime(ev.hourMs)],
  ];
  return `<details class="raw"><summary>Raw metrics</summary><dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></details>`;
}

function renderStats(ev) {
  const el = $('#stats');
  if (!ev) { el.hidden = true; return; }
  el.hidden = false;
  const r = ev.result;
  const mods = r.modifiers;
  const keys = Object.keys(STAT_INFO);
  let running = r.base;
  const tally = [`<span class="t-step"><small>Stats</small><b>${Math.round(r.base)}</b></span>`];
  for (const m of mods) {
    running += m.delta;
    tally.push(`<span class="t-op ${m.kind}">${esc(m.effect)}</span><span class="t-step"><small>${esc(m.name)}</small><b>${Math.round(Math.max(0, running))}</b></span>`);
  }
  const mvp = STAT_INFO[r.mvp];
  const nem = r.nemesis && STAT_INFO[r.nemesis];
  const note = localNote(ev);
  el.innerHTML = `
    <div class="panel-head">
      <h2 class="h2">Why ${r.score}?</h2>
      <span class="muted small">${typeName(ev.type)} ${dayLabel(ev.T).toLowerCase()} · sky stats</span>
    </div>
    <div class="stats">${keys.map((k) => statRow(k, ev)).join('')}</div>
    ${mods.length ? `<ul class="mods" aria-label="Buffs and debuffs">${mods.map(modChip).join('')}</ul>` : '<p class="muted small no-mods">No buffs or debuffs this round.</p>'}
    <div class="tally" aria-label="Score tally">${tally.join('')}<span class="t-op">=</span><span class="t-step final"><small>${esc(r.label)}</small><b>${r.score}</b></span></div>
    <div class="duo">
      <div class="duo-card mvp"><small>MVP</small><b>${mvp.name}</b><span class="muted small">+${Math.round(r.components[r.mvp].points)} pts carried this sky</span></div>
      ${nem ? `<div class="duo-card nemesis"><small>Nemesis</small><b>${nem.name}</b><span class="muted small">cost ${Math.round(r.lost[r.nemesis])} pts</span></div>`
        : '<div class="duo-card mvp"><small>Nemesis</small><b>None</b><span class="muted small">Nothing held this sky back</span></div>'}
    </div>
    ${radar(ev)}
    <p class="tip"><b>Pro tip.</b> ${esc(tipFor(ev))}</p>
    ${note ? `<p class="tip local"><b>Local intel.</b> ${esc(note)}</p>` : ''}
    ${rawMetrics(ev)}`;
}

function renderList() {
  const list = $('#list');
  const ups = upcomingEvents();
  const next = ups[0];
  list.innerHTML = ups.map((e) => {
    const r = e.result;
    return `<button type="button" class="event ${e.id === state.focusId ? 'active' : ''} ${e.id === next.id ? 'next' : ''}" data-id="${esc(e.id)}" aria-pressed="${e.id === state.focusId}">
      <span class="ev-icon">${ICON[e.type]}</span>
      <span class="ev-main">
        <span class="ev-title">${typeName(e.type)} · ${dayLabel(e.T)}${e.id === next.id ? ' <span class="pill tiny">Next</span>' : ''}</span>
        <span class="ev-sub muted small">${fmtTime(e.T)} · peak ${fmtRange(e.peak[0], e.peak[1])}</span>
        <span class="ev-reason small">${esc(r.reasons[0]?.text || '')}</span>
      </span>
      <span class="ev-score rank-${r.rank}"><b>${r.score}</b><small>${r.label}</small></span>
    </button>`;
  }).join('');
}

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('.event');
  if (!b) return;
  state.focusId = b.dataset.id;
  render();
  $('#hero').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
});

function renderRateList() {
  const recent = recentEvents();
  $('#rateBlock').hidden = !recent.length;
  $('#rateList').innerHTML = recent.map((e) => {
    const mine = store.ratingFor(e.id);
    return `<div class="rate-item">
      <span class="ev-icon">${ICON[e.type]}</span>
      <span class="ev-main"><span class="ev-title">${typeName(e.type)} · ${dayLabel(e.T)}</span>
      <span class="muted small">${fmtTime(e.T)} · we said ${e.result.score} (${e.result.label})</span></span>
      ${mine
        ? `<button class="btn rated" type="button" data-rate="${esc(e.id)}" aria-label="Your rating ${mine.rating} of 5. Change it">${'★'.repeat(mine.rating)}<span class="dim">${'★'.repeat(5 - mine.rating)}</span></button>`
        : `<button class="btn btn-primary" type="button" data-rate="${esc(e.id)}">Rate it</button>`}
    </div>`;
  }).join('');
}

$('#rateList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rate]');
  if (b) openRate(state.data.events.find((x) => x.id === b.dataset.rate));
});

function renderScout() {
  const p = store.profile();
  const earned = new Set(p.badges);
  $('#scout').innerHTML = `
    <div class="card scout">
      <div class="scout-head">
        <div class="lvl" aria-label="Level ${p.level}">${p.level}<small>LVL</small></div>
        <div class="scout-main">
          <div class="h3">${esc(p.title)}</div>
          <div class="xp" role="progressbar" aria-label="Experience" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.progress * 100)}"><i style="width:${(p.progress * 100).toFixed(1)}%"></i></div>
          <div class="muted small">${p.xp} XP · ${p.toNext} to next level · ${p.ratings.length} ${p.ratings.length === 1 ? 'sky' : 'skies'} rated</div>
        </div>
      </div>
      <ul class="badges">${store.BADGES.map((b) => `<li class="badge ${earned.has(b.id) ? 'got' : ''}" title="${esc(b.desc)}"><span class="badge-ico">${ICON.star}</span><span>${esc(b.name)}</span><small>${esc(b.desc)}</small></li>`).join('')}</ul>
    </div>`;
}

function renderFooter() {
  const { lat, lon } = state.loc;
  const inIndia = lat > 6 && lat < 37 && lon > 68 && lon < 98;
  const links = [
    [`https://www.windy.com/?clouds,${lat.toFixed(3)},${lon.toFixed(3)},8`, 'Windy cloud layers'],
    [`https://zoom.earth/maps/satellite/#view=${lat.toFixed(3)},${lon.toFixed(3)},8z`, 'Live satellite'],
    ...(inIndia ? [['https://www.mosdac.gov.in/', 'MOSDAC (INSAT-3D)'], ['https://mausam.imd.gov.in/chennai/', 'IMD Chennai']] : []),
  ];
  $('#links').innerHTML = `<span class="muted small">Check the sky yourself:</span> ${links.map(([u, t]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join('')}`;
  const d = state.data;
  const notes = [d.airError ? 'air-quality data unavailable' : '', d.horizonError ? 'horizon scan unavailable (using overhead low cloud)' : ''].filter(Boolean);
  $('#updated').innerHTML = `Updated ${esc(new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d.fetchedAt))}
    · prediction #${store.get('predictions', 1)} · weights ${esc(state.config.version)}${notes.length ? ` · ${esc(notes.join(', '))}` : ''}
    · <a href="admin">Admin</a>`;
}

// ---------------------------------------------------------------- hero actions

function downloadICS(ev) {
  const r = ev.result;
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = (s) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const summary = `${typeName(ev.type)} ${r.score}/100 (${r.label}) — face ${compassName(ev.bearing)}`;
  const desc = `${r.reasons.map((x) => `• ${x.text}`).join('\n')}\nPeak color ${fmtRange(ev.peak[0], ev.peak[1])}.`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sky Score//EN', 'BEGIN:VEVENT',
    `UID:${ev.id.replace(/[^\w.-]/g, '-')}@skyscore`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(ev.peak[0] - 15 * MIN)}`, `DTEND:${stamp(ev.peak[1] + 10 * MIN)}`,
    `SUMMARY:${text(summary)}`, `DESCRIPTION:${text(desc)}`, `LOCATION:${text(state.loc.name)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${text(summary)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${ev.type}-${ev.day}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function share(ev) {
  const r = ev.result;
  const text = `${typeName(ev.type)} ${dayLabel(ev.T).toLowerCase()} at ${state.loc.name}: ${r.score}/100 (${r.label}). Peak ${fmtRange(ev.peak[0], ev.peak[1])}, face ${compassName(ev.bearing)}. ${r.reasons[0]?.text || ''}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Sky Score', text, url: location.href });
    else { await navigator.clipboard.writeText(`${text} ${location.href}`); toast('Copied to clipboard'); }
  } catch (e) {
    if (e.name !== 'AbortError') toast('Sharing not available here');
  }
}

async function remind(ev) {
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications are blocked. Try the calendar button instead.'); return; }
  const at = ev.peak[0] - 20 * MIN;
  clearTimeout(remind.timer);
  remind.timer = setTimeout(() => {
    new Notification(`${typeName(ev.type)} in 20 min — ${ev.result.score}/100`, { body: `Face ${compassName(ev.bearing)}. ${ev.result.reasons[0]?.text || ''}`, icon: 'icon.svg' });
  }, at - Date.now());
  toast(`I'll ping you at ${fmtTime(at)} while this tab stays open.`, 4500);
}

async function startCompass() {
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error('denied');
    }
  } catch { toast('Compass permission denied'); return; }
  const onOrient = (e) => {
    const h = Number.isFinite(e.webkitCompassHeading) ? e.webkitCompassHeading : (e.absolute && Number.isFinite(e.alpha) ? 360 - e.alpha : null);
    if (h === null) return;
    const first = state.heading === null;
    state.heading = h;
    const needle = $('.compass-needle');
    const ev = focused();
    if (first || !needle) renderHero(ev);
    else needle.style.transform = `rotate(${ev.bearing - h}deg)`;
  };
  window.addEventListener('ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation', onOrient);
  toast('Hold your phone flat and turn until the arrow points up');
}

// ---------------------------------------------------------------- rating

const STAR_TEXT = ['', 'Dull or grey', 'A little color', 'Pretty nice', 'Vivid', 'Epic: sky on fire'];
const TAGS = [['fiery', 'Fiery reds'], ['golden', 'Golden'], ['pink', 'Pink'], ['purple', 'Purple'], ['pastel', 'Pastel'], ['grey', 'Grey'], ['blocked', 'Blocked by clouds'], ['hazy', 'Hazy'], ['rainy', 'Rainy'], ['clear', 'Clear, no clouds'], ['better', 'Better than predicted'], ['worse', 'Worse than predicted']];

let rating = { ev: null, stars: 0 };

function openRate(ev) {
  if (!ev) return;
  const prev = store.ratingFor(ev.id);
  rating = { ev, stars: prev?.rating || 0 };
  $('#rateTitle').textContent = `Rate ${dayLabel(ev.T).toLowerCase()}'s ${ev.type}`;
  $('#rateSub').textContent = `We predicted ${ev.result.score}/100 (${ev.result.label}). How vibrant was it really?`;
  $('#stars').innerHTML = '<legend class="sr-only">How vibrant was it?</legend>' + [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" class="star" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}: ${STAR_TEXT[n]}">${ICON.star}</button>`).join('');
  $('#tagChips').innerHTML = TAGS.map(([id, t]) => `<label class="chip"><input type="checkbox" value="${id}"><span>${t}</span></label>`).join('');
  $('#rateNote').value = '';
  paintStars();
  $('#rateDialog').showModal();
}

function paintStars() {
  document.querySelectorAll('#stars .star').forEach((b) => {
    const on = Number(b.dataset.n) <= rating.stars;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(Number(b.dataset.n) === rating.stars));
  });
  $('#starLabel').textContent = rating.stars ? STAR_TEXT[rating.stars] : 'Tap a star';
  $('#rateSubmit').disabled = !rating.stars;
}

$('#stars').addEventListener('click', (e) => {
  const b = e.target.closest('.star');
  if (!b) return;
  rating.stars = Number(b.dataset.n);
  paintStars();
});

$('#rateForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'submit' || !rating.stars) return;
  const ev = rating.ev;
  const tags = [...document.querySelectorAll('#tagChips input:checked')].map((i) => i.value);
  const note = $('#rateNote').value.trim();
  const r = ev.result;
  const payload = {
    eventId: ev.id,
    clientId: store.clientId(),
    type: ev.type,
    eventTime: ev.T,
    rating: rating.stars,
    tags,
    note,
    location: { name: state.loc.name, lat: state.loc.lat, lon: state.loc.lon },
    predicted: {
      score: r.score, label: r.label, base: r.base,
      factors: Object.fromEntries(Object.entries(r.components).map(([k, c]) => [k, c.factor])),
      modifiers: r.modifiers.map((m) => m.id),
      configVersion: state.config.version,
    },
    metrics: {
      high: ev.inputs.high, mid: ev.inputs.mid, low: ev.inputs.low, total: ev.inputs.total, HZ: r.HZ,
      aod: ev.inputs.aod, pm25: ev.inputs.pm25, dust: ev.inputs.dust, rh: ev.inputs.rh, visibility: ev.inputs.visibility,
      precip: ev.inputs.precip, rain12h: ev.inputs.rain12h, pressureTrend: ev.inputs.pressureTrend, elevationM: ev.inputs.elevationM, bearing: ev.bearing,
      sunwardHM: r.canvas.sunward ?? undefined, antiCloud: r.canvas.anti ?? undefined, cape: ev.inputs.cape,
    },
    leadHours: (ev.T - (state.data?.fetchedAt || Date.now())) / HOUR,
  };
  const sent = await sendFeedback(payload);
  const res = store.recordRating({
    eventId: ev.id, type: ev.type, rating: rating.stars, predictedScore: r.score,
    hadClearing: r.modifiers.some((m) => m.id === 'clearing'), place: `${state.loc.lat.toFixed(1)},${state.loc.lon.toFixed(1)}`, tags, note,
  });
  const bits = [sent ? 'Thanks! Rating saved.' : 'Saved offline. It will sync later.'];
  if (res.gained) bits.push(`+${res.gained} XP`);
  if (res.newBadges.length) bits.push(`Badge unlocked: ${res.newBadges.map((b) => b.name).join(', ')}`);
  if (res.levelUp) bits.push('Level up!');
  toast(bits.join(' · '), 4500);
  renderRateList();
  renderScout();
});

async function sendFeedback(payload) {
  try {
    const res = await fetch('api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) return true;
    // 404/405 = no feedback server (e.g. GitHub Pages): keep it in the outbox.
    if (res.status >= 400 && res.status < 500 && ![404, 405, 429].includes(res.status)) return false; // rejected: don't queue
  } catch { /* offline or static hosting */ }
  const box = store.get('outbox', []).filter((p) => !(p.eventId === payload.eventId && p.clientId === payload.clientId));
  box.push(payload);
  store.set('outbox', box.slice(-50));
  return false;
}

async function flushOutbox() {
  const box = store.get('outbox', []);
  if (!box.length) return;
  const left = [];
  for (const p of box) {
    try {
      const res = await fetch('api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      if (!res.ok && (res.status >= 500 || [404, 405, 429].includes(res.status))) left.push(p);
    } catch { left.push(p); }
  }
  store.set('outbox', left);
}

// ---------------------------------------------------------------- location

function setLocation(loc) {
  state.loc = loc;
  store.set('location', loc);
  state.focusId = null;
  state.heading = null;
  $('#locDialog').close();
  load();
}

function renderSaved() {
  const saved = store.get('saved', []);
  const here = saved.some((s) => s.lat === state.loc.lat && s.lon === state.loc.lon);
  $('#savedList').innerHTML = (here ? '' : `<li><button type="button" class="result add" data-save="1">${ICON.star} Save “${esc(state.loc.name)}”</button></li>`)
    + saved.map((s, i) => `<li class="saved-row"><button type="button" class="result" data-pick-saved="${i}"><b>${esc(s.name)}</b><span class="muted small">${esc(s.region || `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`)}</span></button>
      <button type="button" class="icon-btn" data-del="${i}" aria-label="Remove ${esc(s.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></li>`).join('');
}

$('#locBtn').addEventListener('click', () => {
  $('#searchInput').value = '';
  $('#searchResults').innerHTML = '';
  $('#vantageSelect').value = String(state.vantage);
  renderSaved();
  $('#locDialog').showModal();
  $('#searchInput').focus();
});

let searchResults = [];
let searchCtl = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(e.target.timer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#searchResults').innerHTML = ''; return; }
  e.target.timer = setTimeout(async () => {
    searchCtl?.abort();
    searchCtl = new AbortController();
    try {
      searchResults = await geocode(q, searchCtl.signal);
      $('#searchResults').innerHTML = searchResults.length
        ? searchResults.map((r, i) => `<li><button type="button" class="result" role="option" data-pick="${i}"><b>${esc(r.name)}</b><span class="muted small">${esc(r.region)}</span></button></li>`).join('')
        : '<li class="muted small pad">No places found</li>';
    } catch (err) {
      if (err.name !== 'AbortError') $('#searchResults').innerHTML = '<li class="muted small pad">Search failed. Check your connection.</li>';
    }
  }, 300);
});

$('#searchResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  const r = searchResults[Number(b.dataset.pick)];
  setLocation({ name: r.name, region: r.region, lat: r.lat, lon: r.lon, timezone: r.timezone });
});

$('#savedList').addEventListener('click', (e) => {
  const saved = store.get('saved', []);
  const pick = e.target.closest('[data-pick-saved]');
  const del = e.target.closest('[data-del]');
  if (e.target.closest('[data-save]')) {
    saved.push({ ...state.loc });
    store.set('saved', saved.slice(-20));
    renderSaved();
    toast('Spot saved');
  } else if (pick) {
    setLocation(saved[Number(pick.dataset.pickSaved)]);
  } else if (del) {
    saved.splice(Number(del.dataset.del), 1);
    store.set('saved', saved);
    renderSaved();
  }
});

$('#vantageSelect').addEventListener('change', (e) => {
  state.vantage = Number(e.target.value) || 0;
  store.set('vantage', state.vantage);
  load();
});

$('#gpsBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location is not available in this browser'); return; }
  const btn = $('#gpsBtn');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.disabled = false;
    const { latitude: lat, longitude: lon, altitude, altitudeAccuracy } = pos.coords;
    // Only trust GPS altitude when the device says it's reasonably accurate.
    const gpsAltitude = Number.isFinite(altitude) && (!Number.isFinite(altitudeAccuracy) || altitudeAccuracy < 50) ? altitude : undefined;
    setLocation({ name: 'My location', region: `${lat.toFixed(3)}°, ${lon.toFixed(3)}°${gpsAltitude !== undefined ? ` · ${Math.round(gpsAltitude)} m` : ''}`, lat, lon, gpsAltitude });
  }, (err) => {
    btn.disabled = false;
    toast(err.code === 1 ? 'Location permission denied. Search for a place instead.' : 'Could not get your location');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5 * MIN });
});

$('#refreshBtn').addEventListener('click', () => load({ fresh: true }));

// Keep the countdown honest while the page is open.
setInterval(() => {
  if (!state.data || document.hidden) return;
  const ev = focused();
  if (ev && ev.peak[1] > Date.now()) { const c = $('#countdown'); if (c) c.innerHTML = countdown(ev); return; }
  // The focused event just ended: move on to the next one.
  state.focusId = null;
  if (!document.querySelector('dialog[open]')) render();
}, 30000);

// ---------------------------------------------------------------- boot

(async function init() {
  state.config = mergeConfig(DEFAULT_CONFIG, await fetchTunedConfig());
  flushOutbox();
  load();
})();
