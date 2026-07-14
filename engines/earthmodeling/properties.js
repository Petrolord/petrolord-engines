// Property population (Earth Modeling G8.1): per-zone, per-block
// population of NTG / porosity / Sw grids from well control values.
// Methods (plan decision 5): constant (weighted mean), trend
// (least-squares plane), simple kriging (spherical / exponential,
// honor-the-data covariance C(0)=sill, C(h>0)=(sill−nugget)·corr(h) —
// exact at data points). Fallback ladder krige → trend → constant is
// explicit and recorded, never silent. Pure functions, no I/O;
// oracle-validated (Isaaks & Srivastava ch. 12/16 conventions).

import { NULL_VALUE } from '../../lib/gridding/numeric';

/** Gaussian elimination with partial pivoting (n is tiny — wells). */
export function solveDense(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-14) throw new Error('Singular system.');
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return x;
}

/** Weighted arithmetic mean; throws on empty input / zero weight. */
export function weightedMean(values, weights) {
  if (!values.length) throw new Error('No control values.');
  const wts = weights || values.map(() => 1);
  let sw = 0;
  let sv = 0;
  for (let i = 0; i < values.length; i++) {
    sw += wts[i];
    sv += values[i] * wts[i];
  }
  if (!(sw > 0)) throw new Error('Non-positive total weight.');
  return sv / sw;
}

/**
 * Least-squares plane v = a + b·x + c·y via normal equations.
 * Throws on < 3 points or a degenerate (collinear) configuration.
 * @param {Array<{x,y,v}>} points
 * @returns {[number, number, number]} [a, b, c]
 */
export function planeFit(points) {
  if (points.length < 3) throw new Error('Trend fit needs at least 3 wells.');
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  let sv = 0; let sxv = 0; let syv = 0;
  for (const p of points) {
    sx += p.x; sy += p.y;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sv += p.v; sxv += p.x * p.v; syv += p.y * p.v;
  }
  const n = points.length;
  return solveDense(
    [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]],
    [sv, sxv, syv],
  );
}

/** Variogram correlation (1 at h=0, 0 beyond range for spherical). */
export function correlation(h, model, range) {
  if (h <= 0) return 1;
  if (model === 'spherical') {
    if (h >= range) return 0;
    const u = h / range;
    return 1 - (1.5 * u - 0.5 * u ** 3);
  }
  if (model === 'exponential') return Math.exp((-3 * h) / range);
  throw new Error(`Unknown variogram model "${model}".`);
}

/** Honor-the-data covariance: C(0)=sill; C(h>0)=(sill−nugget)·corr(h). */
export function cov(h, model, range, sill, nugget) {
  if (h <= 0) return sill;
  return (sill - nugget) * correlation(h, model, range);
}

/**
 * Simple kriging predictions at targets.
 * @param {Array<{x,y,v}>} points
 * @param {number|null} mean known mean (null ⇒ arithmetic data mean)
 * @param {{model,range,sill,nugget}} params
 * @param {Array<[number,number]>} targets
 */
export function simpleKrige(points, mean, params, targets) {
  const { model, range, sill, nugget } = params;
  if (!points.length) throw new Error('Kriging needs at least one well.');
  if (!(range > 0) || !(sill > 0) || nugget < 0 || nugget >= sill) {
    throw new Error('Kriging needs range > 0, sill > 0, 0 ≤ nugget < sill.');
  }
  const mu = mean ?? weightedMean(points.map((p) => p.v));
  const n = points.length;
  const A = points.map((pi) => points.map((pj) =>
    cov(Math.hypot(pi.x - pj.x, pi.y - pj.y), model, range, sill, nugget)));
  const resid = points.map((p) => p.v - mu);
  return targets.map(([tx, ty]) => {
    const c0 = points.map((p) => cov(Math.hypot(p.x - tx, p.y - ty), model, range, sill, nugget));
    const w = solveDense(A, c0);
    let s = mu;
    for (let i = 0; i < n; i++) s += w[i] * resid[i];
    return s;
  });
}

/**
 * Populate a property grid on the model spec with one method,
 * restricted to nodes whose block label matches (labels null ⇒ all
 * nodes). Throws when the method cannot run — the fallback ladder is
 * populateZoneProperty's job.
 * @param {{x0,y0,dx,dy,nx,ny}} spec
 * @param {'constant'|'trend'|'krige'} method
 * @param {Array<{x,y,v,w?}>} points
 * @param {{mean?,model?,range?,sill?,nugget?}} params kriging only
 * @param {{labels?: Int32Array, block?: number}} scope
 * @returns {Float64Array}
 */
export function populate(spec, method, points, params = {}, scope = {}) {
  if (!points.length) throw new Error('No control points.');
  const { labels = null, block = 0 } = scope;
  let fn;
  if (method === 'constant') {
    const val = weightedMean(points.map((p) => p.v), points.map((p) => p.w ?? 1));
    fn = () => val;
  } else if (method === 'trend') {
    const [a, b, c] = planeFit(points);
    fn = (x, y) => a + b * x + c * y;
  } else if (method === 'krige') {
    fn = (x, y) => simpleKrige(points, params.mean ?? null, params, [[x, y]])[0];
  } else {
    throw new Error(`Unknown population method "${method}".`);
  }
  const out = new Float64Array(spec.nx * spec.ny);
  for (let r = 0; r < spec.ny; r++) {
    const y = spec.y0 + r * spec.dy;
    for (let c = 0; c < spec.nx; c++) {
      const j = r * spec.nx + c;
      if (labels && labels[j] !== block) {
        out[j] = NULL_VALUE;
        continue;
      }
      out[j] = fn(spec.x0 + c * spec.dx, y);
    }
  }
  return out;
}

/**
 * Populate one property across ALL blocks with the explicit fallback
 * ladder (krige → trend → constant); blocks with no wells fall back to
 * the all-well constant. Every fallback is recorded in provenance.
 * @param {{x0,y0,dx,dy,nx,ny}} spec
 * @param {Int32Array|null} labels block labels (null ⇒ single block 0)
 * @param {Object<number, Array<{x,y,v,w?}>>} pointsByBlock
 * @param {Array<{x,y,v,w?}>} allPoints
 * @param {'constant'|'trend'|'krige'} method requested method
 * @param {object} params kriging params
 * @returns {{z: Float64Array, provenance: Array<{block, methodUsed, wells, fellBack}>}}
 */
export function populateZoneProperty(spec, labels, pointsByBlock, allPoints, method, params = {}) {
  const blocks = labels ? [...new Set(labels)].sort((a, b) => a - b) : [0];
  const z = new Float64Array(spec.nx * spec.ny).fill(NULL_VALUE);
  const provenance = [];
  const LADDER = { krige: ['krige', 'trend', 'constant'], trend: ['trend', 'constant'], constant: ['constant'] };
  const ladder = LADDER[method];
  if (!ladder) throw new Error(`Unknown population method "${method}".`);
  for (const block of blocks) {
    let pts = pointsByBlock[block] || [];
    let usedAllWells = false;
    if (!pts.length) {
      pts = allPoints;
      usedAllWells = true;
    }
    if (!pts.length) {
      provenance.push({ block, methodUsed: 'none', wells: 0, fellBack: true });
      continue;
    }
    let used = null;
    let grid = null;
    for (const m of usedAllWells ? ['constant'] : ladder) {
      try {
        grid = populate(spec, m, pts, params, { labels, block });
        used = m;
        break;
      } catch {
        // fall through the ladder
      }
    }
    if (!grid) {
      provenance.push({ block, methodUsed: 'none', wells: pts.length, fellBack: true });
      continue;
    }
    for (let j = 0; j < z.length; j++) {
      if ((labels ? labels[j] : 0) === block) z[j] = grid[j];
    }
    provenance.push({
      block,
      methodUsed: used,
      wells: pts.length,
      fellBack: usedAllWells || used !== method,
    });
  }
  return { z, provenance };
}
