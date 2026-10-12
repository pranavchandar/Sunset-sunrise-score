import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { summarize, suggestWeights, calibration, ratingToScore, COMPONENTS } from './stats.js';
import { STAT_INFO } from './scoring.js';
import * as store from './store.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const theme = store.get('theme', null);
if (theme) document.documentElement.dataset.theme = theme;

let token = sessionStorage.getItem('skyscore:admin') || '';
let items = [];
let tuned = null;
let suggestion = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  if (res.status === 401) { signOut('That token was not accepted.'); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res;
}

function signOut(msg = '') {
  token = '';
  try { sessionStorage.removeItem('skyscore:admin'); } catch { /* ignore */ }
  $('#dash').hidden = true;
  $('#logoutBtn').hidden = true;
  $('#loginForm').hidden = false;
  $('#loginErr').textContent = msg;
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('#tokenInput').value.trim();
  try { sessionStorage.setItem('skyscore:admin', token); } catch { /* ignore */ }
  refresh();
});
$('#logoutBtn').addEventListener('click', () => signOut());

async function refresh() {
  if (!token) { signOut(); return; }
  try {
    const data = await (await api('api/admin/feedback')).json();
    items = data.items.sort((a, b) => b.receivedAt - a.receivedAt);
    tuned = data.config;
    $('#loginForm').hidden = true;
    $('#dash').hidden = false;
    $('#logoutBtn').hidden = false;
    render();
  } catch (e) {
    if (e.message !== 'unauthorized') { $('#loginForm').hidden = false; $('#loginErr').textContent = `Could not load: ${e.message}`; }
  }
}

const currentConfig = () => mergeConfig(DEFAULT_CONFIG, tuned);

function render() {
  renderKpis();
  renderScatter();
  renderBars();
  renderCalibration();
  renderWeights();
  renderTable();
}

function renderKpis() {
  const s = summarize(items);
  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  const cards = [
    ['Ratings', s.n || 0, `${new Set(items.map((i) => i.clientId)).size} people`],
    ['Hit rate', pct(s.hitRate), 'within one star'],
    ['Mean abs. error', s.n ? s.mae.toFixed(1) : '—', 'points (1★ = 25)'],
    ['Bias', s.n ? `${s.bias > 0 ? '+' : ''}${s.bias.toFixed(1)}` : '—', s.n ? (s.bias > 0 ? 'we over-predict' : 'we under-predict') : ''],
    ['Correlation', s.r === null || s.r === undefined ? '—' : s.r.toFixed(2), 'predicted vs. rated'],
    ['Avg rating', s.n ? `${s.meanRating.toFixed(1)}★` : '—', ''],
  ];
  $('#kpis').innerHTML = cards.map(([k, v, sub]) => `<div class="kpi"><small>${k}</small><b>${v}</b><span>${sub}</span></div>`).join('');
}

// ---------- charts (inline SVG, single series → no legend; hover tooltips) ----------

const tip = $('#tooltip');
function showTip(html, evt) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: w, innerHeight: h } = window;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > w - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > h - 8) y = evt.clientY - r.height - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

function renderScatter() {
  const W = 560, H = 300, m = { l: 44, r: 14, t: 10, b: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = (v) => m.l + (v / 100) * iw;
  const y = (stars) => m.t + ih - ((stars - 0.5) / 5) * ih;
  const rows = items.filter((f) => Number.isFinite(f.predicted?.score));
  // Deterministic jitter so stacked ratings stay visible.
  const jitter = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0; return ((h % 1000) / 1000 - 0.5) * 0.36; };
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of predicted score against star rating, ${rows.length} ratings">`;
  for (let s = 1; s <= 5; s++) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(s)}" y2="${y(s)}"/><text class="axis-label" x="${m.l - 8}" y="${y(s) + 4}" text-anchor="end">${s}★</text>`;
  for (let v = 0; v <= 100; v += 25) svg += `<text class="axis-label" x="${x(v)}" y="${H - m.b + 16}" text-anchor="middle">${v}</text>`;
  svg += `<text class="axis-title" x="${m.l + iw / 2}" y="${H - 4}" text-anchor="middle">Predicted score</text>`;
  // Perfect forecast: score 0 ↔ 1★, 100 ↔ 5★.
  svg += `<line class="ref" x1="${x(0)}" y1="${y(1)}" x2="${x(100)}" y2="${y(5)}"/>`;
  if (!rows.length) svg += `<text class="empty" x="${m.l + iw / 2}" y="${m.t + ih / 2}">No ratings yet</text>`;
  rows.forEach((f, i) => {
    const cx = x(f.predicted.score), cy = y(f.rating + jitter(f.id));
    svg += `<circle class="pt-hit" data-i="${i}" cx="${cx}" cy="${cy}" r="11"/><circle class="pt" cx="${cx}" cy="${cy}" r="5"/>`;
  });
  svg += '</svg>';
  const el = $('#scatter');
  el.innerHTML = svg;
  el.onmousemove = (e) => {
    const t = e.target.closest('.pt-hit');
    if (!t) return hideTip();
    const f = rows[Number(t.dataset.i)];
    showTip(`<b>${esc(f.location.name)}</b> · ${f.type}<br>${new Date(f.eventTime || f.receivedAt).toLocaleString()}<br>Predicted <b>${f.predicted.score}</b> (${esc(f.predicted.label)}) · rated <b>${f.rating}★</b>${f.note ? `<br><i>${esc(f.note)}</i>` : ''}`, e);
  };
  el.onmouseleave = hideTip;
}

function renderBars() {
  const W = 360, H = 300, m = { l: 14, r: 14, t: 22, b: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const counts = [1, 2, 3, 4, 5].map((s) => items.filter((f) => f.rating === s).length);
  const max = Math.max(1, ...counts);
  const band = iw / 5, bw = Math.min(24, band * 0.6), r = 4;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ratings by stars: ${counts.map((c, i) => `${i + 1} star ${c}`).join(', ')}">`;
  svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
  counts.forEach((c, i) => {
    const cx = m.l + band * i + band / 2;
    const h = (c / max) * ih;
    const x0 = cx - bw / 2, y0 = m.t + ih - h;
    // Rounded data end, square at the baseline.
    if (h > 0) {
      const rr = Math.min(r, h);
      svg += `<path class="bar" d="M${x0},${m.t + ih} V${y0 + rr} Q${x0},${y0} ${x0 + rr},${y0} H${x0 + bw - rr} Q${x0 + bw},${y0} ${x0 + bw},${y0 + rr} V${m.t + ih} Z"/>`;
    }
    svg += `<text class="bar-val" x="${cx}" y="${y0 - 6}">${c}</text>`;
    svg += `<text class="axis-label" x="${cx}" y="${H - m.b + 18}" text-anchor="middle">${i + 1}★</text>`;
    svg += `<rect class="bar-hit" data-i="${i}" x="${cx - band / 2}" y="${m.t}" width="${band}" height="${ih}"/>`;
  });
  svg += '</svg>';
  const el = $('#bars');
  el.innerHTML = svg;
  el.onmousemove = (e) => {
    const t = e.target.closest('.bar-hit');
    if (!t) return hideTip();
    const i = Number(t.dataset.i);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    showTip(`<b>${i + 1}★</b>: ${counts[i]} rating${counts[i] === 1 ? '' : 's'} (${Math.round((counts[i] / total) * 100)}%)`, e);
  };
  el.onmouseleave = hideTip;
}

function renderCalibration() {
  const rows = calibration(items, DEFAULT_CONFIG.labels);
  const expected = { Poor: '1–2★', Fair: '2–3★', Good: '3★', Great: '3–4★', Epic: '4–5★' };
  $('#calib').innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Predicted label</th><th>Expected</th><th class="num">Ratings</th><th class="num">Avg stars</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.label}</td><td class="muted">${expected[r.label]}</td><td class="num">${r.n}</td><td class="num">${r.avgStars === null ? '—' : `${r.avgStars.toFixed(2)}★`}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function renderWeights() {
  const cfg = currentConfig();
  suggestion = suggestWeights(items, cfg.weights);
  $('#weightsVersion').textContent = tuned ? `Live: ${tuned.version}` : 'Live: default weights';
  const rows = COMPONENTS.map((k) => {
    const cur = cfg.weights[k];
    const sug = suggestion.ok ? suggestion.weights[k] : null;
    const d = sug === null ? null : sug - cur;
    return `<tr><td>${STAT_INFO[k].name}</td><td class="num">${cur.toFixed(1)}</td><td class="num">${sug === null ? '—' : sug.toFixed(1)}</td>
      <td class="num ${d > 0.5 ? 'delta-up' : d < -0.5 ? 'delta-down' : ''}">${d === null ? '' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`}</td></tr>`;
  }).join('');
  const note = suggestion.ok
    ? `<p class="muted small">Fit on ${suggestion.n} ratings. Mean error of the base score: ${suggestion.maeBefore.toFixed(1)} → ${suggestion.maeAfter.toFixed(1)} points (in-sample).</p>`
    : `<p class="muted small">Need at least ${suggestion.needed ?? 15} ratings with full component data to suggest weights (have ${suggestion.n}).</p>`;
  $('#weights').innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Component</th><th class="num">Current</th><th class="num">Suggested</th><th class="num">Change</th></tr></thead><tbody>${rows}</tbody></table></div>${note}`;
  $('#applyBtn').disabled = !suggestion.ok;
}

$('#applyBtn').addEventListener('click', async () => {
  if (!suggestion?.ok) return;
  if (!confirm('Apply these weights to live predictions for everyone?')) return;
  try {
    const res = await api('api/admin/config', { method: 'PUT', body: JSON.stringify({ weights: suggestion.weights, version: `tuned-${new Date().toISOString().slice(0, 10)}-n${suggestion.n}` }) });
    tuned = await res.json();
    renderWeights();
    toast('New weights are live');
  } catch (e) { if (e.message !== 'unauthorized') toast(`Failed: ${e.message}`); }
});

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Reset to the default weights?')) return;
  try {
    await api('api/admin/config', { method: 'DELETE' });
    tuned = null;
    renderWeights();
    toast('Back to default weights');
  } catch (e) { if (e.message !== 'unauthorized') toast(`Failed: ${e.message}`); }
});

function renderTable() {
  const type = $('#typeFilter').value;
  const rows = items.filter((f) => !type || f.type === type);
  $('#table').innerHTML = `<thead><tr><th>When</th><th>Place</th><th>Event</th><th class="num">Predicted</th><th>Rating</th><th class="num">Error</th><th>Tags / note</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((f) => {
      const err = Number.isFinite(f.predicted.score) ? f.predicted.score - ratingToScore(f.rating) : null;
      return `<tr>
        <td>${new Date(f.receivedAt).toLocaleString()}</td>
        <td>${esc(f.location.name)}<div class="muted small">${f.location.lat?.toFixed(2) ?? ''}, ${f.location.lon?.toFixed(2) ?? ''}</div></td>
        <td>${f.type}<div class="muted small">${f.eventTime ? new Date(f.eventTime).toLocaleString() : ''}</div></td>
        <td class="num">${f.predicted.score ?? '—'}<div class="muted small">${esc(f.predicted.label || '')}</div></td>
        <td class="stars-cell" aria-label="${f.rating} stars">${'★'.repeat(f.rating)}</td>
        <td class="num">${err === null ? '—' : `${err > 0 ? '+' : ''}${Math.round(err)}`}</td>
        <td class="note">${esc(f.tags.join(', '))}${f.note ? `<div>${esc(f.note)}</div>` : ''}</td>
        <td><button class="btn del" type="button" data-del="${esc(f.id)}">Delete</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="8" class="muted">No ratings yet. They appear here as people rate skies on the main page.</td></tr>'}</tbody>`;
}

$('#typeFilter').addEventListener('change', renderTable);
$('#table').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm('Delete this rating?')) return;
  try {
    await api(`api/admin/feedback/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
    items = items.filter((f) => f.id !== b.dataset.del);
    render();
  } catch (err) { if (err.message !== 'unauthorized') toast(`Failed: ${err.message}`); }
});

async function download(path, filename, type) {
  try {
    const blob = path ? await (await api(path)).blob() : new Blob([JSON.stringify(items, null, 2)], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { if (e.message !== 'unauthorized') toast(`Export failed: ${e.message}`); }
}
$('#csvBtn').addEventListener('click', () => download('api/admin/export.csv', 'sky-feedback.csv'));
$('#jsonBtn').addEventListener('click', () => download(null, 'sky-feedback.json', 'application/json'));

refresh();
