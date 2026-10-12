// Zero-dependency server: serves the app from ./public and stores sky ratings.
//
//   POST   /api/feedback              public — record a rating (+ the prediction it rates)
//   GET    /api/config                public — tuned weights (if an admin applied any)
//   GET    /api/admin/feedback        admin  — all ratings
//   DELETE /api/admin/feedback/:id    admin  — remove one rating
//   GET    /api/admin/export.csv      admin  — flat CSV for training
//   PUT    /api/admin/config          admin  — save tuned weights
//   DELETE /api/admin/config          admin  — reset to defaults
//
//   GET    /api/health                public — liveness + which storage is in use
//
// Admin calls need `Authorization: Bearer $ADMIN_TOKEN`. If ADMIN_TOKEN is not
// set, a random token is generated and printed at startup.
//
// Storage (see storage.js): local files in DATA_DIR by default, or a data branch
// in a GitHub repo when GITHUB_TOKEN + GITHUB_REPO are set.

import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { storageFromEnv } from './storage.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const storage = storageFromEnv(process.env, path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(18).toString('base64url');
const MAX_BODY = 32 * 1024;
const MAX_ITEMS = 50000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.open-meteo.com https://air-quality-api.open-meteo.com https://geocoding-api.open-meteo.com",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

// ---------- state (in memory; every change is persisted before the API answers) ----------

let feedback = [];
let tunedConfig = null;

async function load() {
  await storage.init();
  feedback = (await storage.read('feedback')) || [];
  tunedConfig = await storage.read('config');
}

// Writes run one at a time. A write queued behind another for the same file
// is merged into it, so a burst of ratings costs one save (one commit on GitHub).
let writeChain = Promise.resolve();
const queued = new Map();
function persist(name, message) {
  if (queued.has(name)) return queued.get(name);
  const p = writeChain.then(() => {
    queued.delete(name);
    return storage.write(name, name === 'feedback' ? feedback : tunedConfig, message);
  });
  queued.set(name, p);
  writeChain = p.catch((e) => console.error(`save ${name} failed:`, e.message));
  return p;
}

// ---------- validation ----------

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const fin = (v, lo = -1e9, hi = 1e9) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const TAGS = new Set(['fiery', 'pastel', 'golden', 'pink', 'purple', 'grey', 'blocked', 'hazy', 'rainy', 'clear', 'better', 'worse']);
const METRIC_KEYS = ['high', 'mid', 'low', 'total', 'HZ', 'aod', 'pm25', 'dust', 'rh', 'visibility', 'precip', 'rain12h', 'pressureTrend', 'elevationM', 'bearing'];
const COMPONENT_KEYS = ['canvas', 'horizon', 'low', 'aod', 'moisture'];

function cleanFeedback(b) {
  if (!b || typeof b !== 'object') return null;
  const rating = fin(b.rating, 1, 5);
  if (!rating || !Number.isInteger(rating)) return null;
  const type = b.type === 'sunrise' || b.type === 'sunset' ? b.type : null;
  if (!type) return null;
  const eventId = str(b.eventId, 120);
  const clientId = str(b.clientId, 64);
  if (!eventId || !clientId) return null;

  const loc = b.location && typeof b.location === 'object' ? b.location : {};
  const pred = b.predicted && typeof b.predicted === 'object' ? b.predicted : {};
  const metrics = {};
  for (const k of METRIC_KEYS) { const v = fin(b.metrics?.[k]); if (v !== undefined) metrics[k] = v; }
  const factors = {};
  for (const k of COMPONENT_KEYS) { const v = fin(pred.factors?.[k], 0, 1); if (v !== undefined) factors[k] = v; }

  return {
    eventId, clientId, type,
    eventTime: fin(b.eventTime, 0, 1e14),
    rating,
    tags: Array.isArray(b.tags) ? [...new Set(b.tags.filter((t) => TAGS.has(t)))].slice(0, 6) : [],
    note: str(b.note, 500) || '',
    location: { name: str(loc.name, 120) || '', lat: fin(loc.lat, -90, 90), lon: fin(loc.lon, -180, 180) },
    predicted: {
      score: fin(pred.score, 0, 100),
      label: str(pred.label, 20),
      base: fin(pred.base, 0, 200),
      factors,
      modifiers: Array.isArray(pred.modifiers) ? pred.modifiers.filter((m) => typeof m === 'string').map((m) => m.slice(0, 20)).slice(0, 8) : [],
      configVersion: str(pred.configVersion, 40),
    },
    metrics,
    leadHours: fin(b.leadHours, -1000, 1000),
  };
}

function cleanConfig(b) {
  if (!b || typeof b !== 'object' || !b.weights) return null;
  const weights = {};
  for (const k of COMPONENT_KEYS) {
    const v = fin(b.weights[k], 0, 100);
    if (v === undefined) return null;
    weights[k] = Math.round(v * 10) / 10;
  }
  return { weights, version: str(b.version, 40) || `tuned-${new Date().toISOString().slice(0, 10)}`, savedAt: Date.now() };
}

// ---------- http helpers ----------

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Tiny fixed-window rate limit for the public write endpoint.
const hits = new Map();
function rateLimited(ip, limit = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > windowMs) { hits.set(ip, { t: now, n: 1 }); return false; }
  h.n++;
  return h.n > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 600000) hits.delete(k); }, 600000).unref();

const csvCell = (v) => {
  if (v === undefined || v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCSV(items) {
  const cols = [
    ['id', (f) => f.id], ['receivedAt', (f) => new Date(f.receivedAt).toISOString()], ['eventId', (f) => f.eventId], ['type', (f) => f.type],
    ['eventTime', (f) => (f.eventTime ? new Date(f.eventTime).toISOString() : '')], ['location', (f) => f.location.name],
    ['lat', (f) => f.location.lat], ['lon', (f) => f.location.lon], ['rating', (f) => f.rating], ['ratingScore', (f) => (f.rating - 1) * 25],
    ['predictedScore', (f) => f.predicted.score], ['label', (f) => f.predicted.label], ['base', (f) => f.predicted.base],
    ...COMPONENT_KEYS.map((k) => [`f_${k}`, (f) => f.predicted.factors[k]]),
    ['modifiers', (f) => f.predicted.modifiers.join('|')], ['configVersion', (f) => f.predicted.configVersion],
    ...METRIC_KEYS.map((k) => [k, (f) => f.metrics[k]]),
    ['leadHours', (f) => f.leadHours], ['tags', (f) => f.tags.join('|')], ['note', (f) => f.note], ['clientId', (f) => f.clientId],
  ];
  return [cols.map((c) => c[0]).join(','), ...items.map((f) => cols.map(([, get]) => csvCell(get(f))).join(','))].join('\n');
}

// ---------- routes ----------

async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/feedback' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many ratings, try later' });
    const item = cleanFeedback(await readBody(req));
    if (!item) return send(res, 400, { error: 'Invalid rating' });
    // One rating per person per event: a re-rate replaces the old one.
    const existing = feedback.findIndex((f) => f.clientId === item.clientId && f.eventId === item.eventId);
    const record = { id: existing >= 0 ? feedback[existing].id : crypto.randomUUID(), receivedAt: Date.now(), ...item };
    if (existing >= 0) feedback[existing] = record;
    else {
      if (feedback.length >= MAX_ITEMS) return send(res, 507, { error: 'Feedback store full' });
      feedback.push(record);
    }
    try {
      await persist('feedback', `Rating: ${record.type} ${record.rating}★ at ${record.location.name || 'unknown'}`.slice(0, 120));
    } catch {
      // Not durable yet: tell the client to keep it and retry (it re-sends; the dedupe makes that safe).
      return send(res, 503, { error: 'Could not save right now, will retry' });
    }
    return send(res, existing >= 0 ? 200 : 201, { ok: true, id: record.id, updated: existing >= 0, total: feedback.length });
  }

  if (p === '/api/config' && req.method === 'GET') return send(res, 200, tunedConfig || {});
  if (p === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, storage: storage.kind, ratings: feedback.length });

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin token required' });

    if (p === '/api/admin/feedback' && req.method === 'GET') return send(res, 200, { items: feedback, config: tunedConfig, storage: storage.describe });

    const del = /^\/api\/admin\/feedback\/([\w-]{1,64})$/.exec(p);
    if (del && req.method === 'DELETE') {
      const before = feedback.length;
      feedback = feedback.filter((f) => f.id !== del[1]);
      if (feedback.length === before) return send(res, 404, { error: 'Not found' });
      await persist('feedback', `Admin: delete rating ${del[1]}`);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/admin/export.csv' && req.method === 'GET') {
      return send(res, 200, toCSV(feedback), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sky-feedback.csv"' });
    }

    if (p === '/api/admin/config' && req.method === 'PUT') {
      const cfg = cleanConfig(await readBody(req));
      if (!cfg) return send(res, 400, { error: 'Need numeric weights for canvas, horizon, low, aod, moisture' });
      tunedConfig = cfg;
      await persist('config', `Admin: apply weights ${tunedConfig.version}`);
      return send(res, 200, tunedConfig);
    }
    if (p === '/api/admin/config' && req.method === 'DELETE') {
      tunedConfig = null;
      await persist('config', 'Admin: reset weights to defaults');
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' ) rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'geolocation=(self)',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
      if (!e.status) console.error(e);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await load();
  createServer().listen(PORT, () => {
    console.log(`Sky Score running on http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`Ratings stored in ${storage.describe}`);
    if (!process.env.ADMIN_TOKEN) console.log(`ADMIN_TOKEN not set — generated one for this run: ${ADMIN_TOKEN}`);
  });
}

export { load, cleanFeedback, toCSV };
