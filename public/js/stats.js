// Feedback analytics for the admin page (pure functions, unit-tested).

export const COMPONENTS = ['canvas', 'horizon', 'low', 'aod', 'moisture'];

// 1★ → 0, 3★ → 50, 5★ → 100: puts ratings on the score's scale.
export const ratingToScore = (stars) => (stars - 1) * 25;

export function summarize(items) {
  const rows = items.filter((f) => Number.isFinite(f.predicted?.score) && Number.isFinite(f.rating));
  const n = rows.length;
  if (!n) return { n: 0 };
  const pred = rows.map((f) => f.predicted.score);
  const act = rows.map((f) => ratingToScore(f.rating));
  const err = pred.map((p, i) => p - act[i]);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mae = mean(err.map(Math.abs));
  const bias = mean(err);
  // "Hit": prediction within one star (25 points) of what people saw.
  const hitRate = err.filter((e) => Math.abs(e) <= 25).length / n;
  return { n, mae, bias, hitRate, r: pearson(pred, act), meanRating: mean(rows.map((f) => f.rating)) };
}

export function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Solve A·x = b (small dense system) by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Suggest component weights from ratings: ridge regression of the rating score
 * on the five component factors (0–1), shrunk toward the current weights,
 * negatives clipped, rescaled to 100 points. Needs `minSamples` ratings.
 */
export function suggestWeights(items, current, { minSamples = 15, lambda = 2 } = {}) {
  const rows = items.filter((f) => f.predicted && COMPONENTS.every((k) => Number.isFinite(f.predicted.factors?.[k])));
  if (rows.length < minSamples) return { ok: false, n: rows.length, needed: minSamples };

  const X = rows.map((f) => COMPONENTS.map((k) => f.predicted.factors[k]));
  const y = rows.map((f) => ratingToScore(f.rating));
  const prior = COMPONENTS.map((k) => current[k]);
  const p = COMPONENTS.length;
  // (XᵀX + λnI) w = Xᵀy + λn·prior   — ridge toward the current weights.
  const reg = lambda * rows.length * 0.05;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? reg : 0)));
  const b = Array.from({ length: p }, (_, i) => X.reduce((s, r, k) => s + r[i] * y[k], 0) + reg * prior[i]);
  const w = solve(A, b);
  if (!w) return { ok: false, n: rows.length, needed: minSamples, reason: 'singular' };

  const clipped = w.map((v) => Math.max(0, v));
  const sum = clipped.reduce((a, c) => a + c, 0);
  if (!sum) return { ok: false, n: rows.length, reason: 'degenerate' };
  const weights = Object.fromEntries(COMPONENTS.map((k, i) => [k, Math.round((clipped[i] * 1000) / sum) / 10]));

  // In-sample error of the base score with old vs new weights (modifiers ignored).
  const err = (wts) => rows.reduce((s, f, i) => s + Math.abs(COMPONENTS.reduce((t, k, j) => t + wts[j] * X[i][j], 0) - y[i]), 0) / rows.length;
  return { ok: true, n: rows.length, weights, maeBefore: err(prior), maeAfter: err(COMPONENTS.map((k) => weights[k])) };
}

// Mean rating score grouped by predicted label — the calibration table.
export function calibration(items, labels) {
  return labels.slice().reverse().map((l, i, arr) => {
    const hi = i + 1 < arr.length ? arr[i + 1].min : 101;
    const rows = items.filter((f) => f.predicted?.score >= l.min && f.predicted.score < hi);
    const avg = rows.length ? rows.reduce((s, f) => s + f.rating, 0) / rows.length : null;
    return { label: l.label, n: rows.length, avgStars: avg };
  });
}
