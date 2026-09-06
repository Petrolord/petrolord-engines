// Ordinary kriging for surface gridding (Mapping & Surface Studio MS5,
// 2026-09-06). Sits beside the thin-plate spline in gridding.js with
// the same grid convention (z[row * nx + col], row 0 = south, NULL_VALUE
// outside the mask) and the same return shape, plus the kriging
// variance per node so the map can show where the surface is guessed.
//
// Variogram gamma(h) = nugget + (sill - nugget) * (1 - corr(h)) with
//   spherical    corr = 1 - 1.5 u + 0.5 u^3 (u = h / range, 0 past range)
//   exponential  corr = exp(-3 h / range)          (practical range)
//   gaussian     corr = exp(-3 h^2 / range^2)      (practical range)
// Covariance C(h) = sill - gamma(h), C(0) = sill. The forms match the
// simple-kriging kernel in engines/earthmodeling/properties.js.
//
// Ordinary kriging solves [[C, 1], [1^T, 0]] [w; mu] = [c0; 1] so the
// weights sum to one and no mean is needed. With up to `neighbours`
// control points the system is factorised once and reused for every
// node; larger sets krige from the nearest `neighbours` points per node
// (moving neighbourhood), which keeps a 700-point set tractable.
//
// `detrend` fits a least-squares plane first and kriges the residuals
// (ordinary kriging alone reproduces a constant, not a dipping plane;
// with the trend removed a plane through the data comes back exactly).
//
// Validated against tools/validation/mapping/oracle_kriging.py
// (independent stdlib Python) through test-data/mapping/goldens/
// kriging_cases.json. Pure math, worker-safe, no I/O.

import { NULL_VALUE } from './numeric';
import { convexHull, decimateControls, insideHull } from './gridding';

const NULL_F32 = Math.fround(NULL_VALUE);

export const VARIOGRAM_MODELS = Object.freeze(['spherical', 'exponential', 'gaussian']);

/** Validate variogram parameters; returns a normalised copy. */
export function variogramParams(p = {}) {
  const model = p.model || 'spherical';
  const range = Number(p.range);
  const sill = Number(p.sill);
  const nugget = Number(p.nugget ?? 0);
  if (!VARIOGRAM_MODELS.includes(model)) throw new Error(`Unknown variogram model "${model}". Use spherical, exponential or gaussian.`);
  if (!(range > 0) || !Number.isFinite(range)) throw new Error('Kriging needs a variogram range greater than zero.');
  if (!(sill > 0) || !Number.isFinite(sill)) throw new Error('Kriging needs a variogram sill greater than zero.');
  if (!(nugget >= 0) || nugget >= sill) throw new Error('Kriging needs a nugget of at least zero and below the sill.');
  return { model, range, sill, nugget };
}

/** Correlation 1 at h = 0 falling to 0 at (or past) the range. */
export function variogramCorrelation(h, model, range) {
  if (h <= 0) return 1;
  if (model === 'spherical') {
    if (h >= range) return 0;
    const u = h / range;
    return 1 - (1.5 * u - 0.5 * u * u * u);
  }
  if (model === 'exponential') return Math.exp((-3 * h) / range);
  if (model === 'gaussian') return Math.exp((-3 * h * h) / (range * range));
  throw new Error(`Unknown variogram model "${model}".`);
}

/** Semivariance gamma(h) of a model. */
export function variogramModel(h, params) {
  const { model, range, sill, nugget } = variogramParams(params);
  if (h <= 0) return 0;
  return nugget + (sill - nugget) * (1 - variogramCorrelation(h, model, range));
}

/** Covariance C(h) = sill - gamma(h). */
export function variogramCovariance(h, params) {
  const { model, range, sill, nugget } = variogramParams(params);
  if (h <= 0) return sill;
  return (sill - nugget) * variogramCorrelation(h, model, range);
}

/**
 * Omnidirectional experimental semivariogram. Bin k (1..nLags) holds
 * the pairs with (k - 0.5) lag <= h < (k + 0.5) lag; `h` is the mean
 * pair distance in the bin, `lagCentre` is k * lag. Empty bins are
 * omitted.
 * @param {{x:number,y:number,z:number}[]} points
 * @param {{lag:number, nLags?:number, maxDist?:number}} opts
 * @returns {{h:number, gamma:number, pairs:number, lagCentre:number}[]}
 */
export function experimentalVariogram(points, { lag, nLags = 12, maxDist = null } = {}) {
  if (!(lag > 0)) throw new Error('The experimental variogram needs a lag distance greater than zero.');
  const pts = cleanPoints(points);
  if (pts.length < 2) throw new Error('The experimental variogram needs at least two control points.');
  const limit = maxDist ?? (nLags + 0.5) * lag;
  const sumSq = new Float64Array(nLags + 1);
  const sumH = new Float64Array(nLags + 1);
  const count = new Uint32Array(nLags + 1);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const h = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (h <= 0 || h >= limit) continue;
      const k = Math.floor(h / lag + 0.5);
      if (k < 1 || k > nLags) continue;
      const d = pts[i].z - pts[j].z;
      sumSq[k] += d * d;
      sumH[k] += h;
      count[k] += 1;
    }
  }
  const out = [];
  for (let k = 1; k <= nLags; k++) {
    if (!count[k]) continue;
    out.push({ h: sumH[k] / count[k], gamma: sumSq[k] / (2 * count[k]), pairs: count[k], lagCentre: k * lag });
  }
  return out;
}

const weightedRmse = (exp, params) => {
  let s = 0; let w = 0;
  for (const b of exp) {
    const e = variogramModel(b.h, params) - b.gamma;
    s += b.pairs * e * e;
    w += b.pairs;
  }
  return Math.sqrt(s / w);
};

const goldenMin = (f, lo, hi, iters = 40) => {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo; let b = hi;
  let c = b - g * (b - a); let d = a + g * (b - a);
  let fc = f(c); let fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return fc < fd ? c : d;
};

/**
 * Fit range and sill of a model to an experimental variogram by
 * pair-weighted least squares (grid search, then alternating
 * golden-section refinement). Nugget is fixed unless `fitNugget`.
 * Deterministic.
 * @returns {{model, range, sill, nugget, rmse}}
 */
export function fitVariogram(exp, { model = 'spherical', nugget = 0, fitNugget = false } = {}) {
  if (!VARIOGRAM_MODELS.includes(model)) throw new Error(`Unknown variogram model "${model}". Use spherical, exponential or gaussian.`);
  const bins = (exp || []).filter((b) => b && b.pairs > 0 && Number.isFinite(b.h) && Number.isFinite(b.gamma));
  if (bins.length < 2) throw new Error('Fitting a variogram needs at least two occupied lag bins.');
  const hMax = Math.max(...bins.map((b) => b.h));
  const hMin = Math.min(...bins.map((b) => b.h));
  const gMax = Math.max(...bins.map((b) => b.gamma));
  if (!(gMax > 0)) throw new Error('Every experimental semivariance is zero; the data carry no spatial variation to fit.');
  const rLo = hMin * 0.5; const rHi = hMax * 3;
  const sLo = gMax * 0.05; const sHi = gMax * 2.5;
  const nLo = 0; const nHi = gMax * 0.95;
  const cost = (r, s, n) => (n >= s ? Infinity : weightedRmse(bins, { model, range: r, sill: s, nugget: n }));
  let best = { range: rLo, sill: sHi, nugget, rmse: Infinity };
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const r = rLo + (rHi - rLo) * (i / N);
    for (let j = 0; j <= N; j++) {
      const s = sLo + (sHi - sLo) * (j / N);
      const ng = fitNugget ? Math.min(nugget, s * 0.9) : nugget;
      const c = cost(r, s, ng);
      if (c < best.rmse) best = { range: r, sill: s, nugget: ng, rmse: c };
    }
  }
  for (let pass = 0; pass < 10; pass++) {
    best.range = goldenMin((r) => cost(r, best.sill, best.nugget), rLo, rHi);
    best.sill = goldenMin((s) => cost(best.range, s, best.nugget), sLo, sHi);
    if (fitNugget) best.nugget = goldenMin((n) => cost(best.range, best.sill, n), nLo, Math.min(nHi, best.sill * 0.95));
    best.rmse = cost(best.range, best.sill, best.nugget);
  }
  return { model, ...best };
}

function cleanPoints(raw) {
  return (raw || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)
    && Number.isFinite(p.z) && Math.abs(p.z) < 1.0e29);
}

/**
 * Average the z of control points sharing a location (within `eps`),
 * which would otherwise make the kriging system singular.
 * @returns {{points: Array, merged: number}}
 */
export function mergeDuplicates(points, eps = 1e-6) {
  const out = [];
  let merged = 0;
  for (const p of points) {
    const hit = out.find((q) => Math.abs(q.x - p.x) <= eps && Math.abs(q.y - p.y) <= eps);
    if (hit) {
      hit.sum += p.z; hit.n += 1; hit.z = hit.sum / hit.n; merged += 1;
    } else {
      out.push({ ...p, sum: p.z, n: 1 });
    }
  }
  return { points: out.map(({ sum, n, ...rest }) => rest), merged };
}

/** LU factorisation with partial pivoting (in place, row-major). */
function luFactor(A, n) {
  const piv = new Int32Array(n);
  for (let col = 0; col < n; col++) {
    let p = col; let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) { best = v; p = r; }
    }
    if (best < 1e-12) throw new Error('The kriging system is singular. Control points may share a location or the variogram range may be far too short.');
    piv[col] = p;
    if (p !== col) {
      for (let c = 0; c < n; c++) { const t = A[col * n + c]; A[col * n + c] = A[p * n + c]; A[p * n + c] = t; }
    }
    const inv = 1 / A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] * inv;
      A[r * n + col] = f;
      if (f === 0) continue;
      for (let c = col + 1; c < n; c++) A[r * n + c] -= f * A[col * n + c];
    }
  }
  return piv;
}

function luSolve(LU, piv, n, b) {
  for (let i = 0; i < n; i++) {
    const p = piv[i];
    if (p !== i) { const t = b[i]; b[i] = b[p]; b[p] = t; }
    for (let c = 0; c < i; c++) b[i] -= LU[i * n + c] * b[c];
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let c = i + 1; c < n; c++) b[i] -= LU[i * n + c] * b[c];
    b[i] /= LU[i * n + i];
  }
  return b;
}

/** Build the ordinary-kriging system for a point set; returns a solver. */
function okSystem(pts, params) {
  const n = pts.length;
  const m = n + 1;
  const A = new Float64Array(m * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      A[i * m + j] = variogramCovariance(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y), params);
    }
    A[i * m + n] = 1;
    A[n * m + i] = 1;
  }
  A[n * m + n] = 0;
  const piv = luFactor(A, m);
  const rhs = new Float64Array(m);
  return (x, y) => {
    for (let i = 0; i < n; i++) rhs[i] = variogramCovariance(Math.hypot(pts[i].x - x, pts[i].y - y), params);
    rhs[n] = 1;
    const w = luSolve(A, piv, m, rhs);
    let v = 0; let s = 0;
    for (let i = 0; i < n; i++) { v += w[i] * pts[i].z; s += w[i] * rhs[i]; }
    // rhs was overwritten by the solve, so recompute the covariance sum
    s = 0;
    for (let i = 0; i < n; i++) s += w[i] * variogramCovariance(Math.hypot(pts[i].x - x, pts[i].y - y), params);
    const variance = params.sill - s - w[n];
    return { value: v, variance: Math.max(0, variance), weights: Array.from(w.subarray(0, n)), mu: w[n] };
  };
}

/**
 * Ordinary-kriging predictions (double precision) at target points.
 * @param {{x,y,z}[]} points control points (duplicates averaged)
 * @param {[number,number][]} targets
 * @param {{model,range,sill,nugget?, neighbours?}} params
 * @returns {{values:number[], variances:number[], weights:number[][], merged:number}}
 */
export function krigePoints(points, targets, params) {
  const vp = variogramParams(params);
  const neighbours = Math.max(1, Math.floor(params.neighbours ?? 24));
  const { points: raw, merged } = mergeDuplicates(cleanPoints(points));
  if (raw.length < 2) throw new Error('Kriging needs at least two control points at distinct locations.');
  const detrend = Boolean(params.detrend);
  const plane = detrend ? fitPlane(raw) : null;
  const pts = detrend ? raw.map((p) => ({ ...p, z: p.z - planeAt(plane, p.x, p.y) })) : raw;
  const values = []; const variances = []; const weights = [];
  const solveGlobal = pts.length <= neighbours ? okSystem(pts, vp) : null;
  for (const [x, y] of targets) {
    const r = solveGlobal ? solveGlobal(x, y) : okSystem(nearest(pts, x, y, neighbours), vp)(x, y);
    values.push(r.value + (plane ? planeAt(plane, x, y) : 0));
    variances.push(r.variance);
    weights.push(r.weights);
  }
  return { values, variances, weights, merged, plane, neighbourhood: solveGlobal ? 'global' : 'moving' };
}

/** Least-squares plane z = a + b x + c y through the points. */
export function fitPlane(pts) {
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0; let sz = 0; let sxz = 0; let syz = 0;
  for (const p of pts) {
    sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sz += p.z; sxz += p.x * p.z; syz += p.y * p.z;
  }
  const n = pts.length;
  const A = new Float64Array([n, sx, sy, sx, sxx, sxy, sy, sxy, syy]);
  const b = new Float64Array([sz, sxz, syz]);
  try {
    const piv = luFactor(A, 3);
    const [a, bx, cy] = luSolve(A, piv, 3, b);
    return { a, b: bx, c: cy };
  } catch {
    // collinear points: fall back to the mean, no dip
    return { a: sz / n, b: 0, c: 0 };
  }
}

const planeAt = (pl, x, y) => pl.a + pl.b * x + pl.c * y;

function nearest(pts, x, y, k) {
  const d = pts.map((p, i) => ({ i, d2: (p.x - x) ** 2 + (p.y - y) ** 2 }));
  d.sort((a, b) => a.d2 - b.d2 || a.i - b.i);
  return d.slice(0, k).map((e) => pts[e.i]);
}

/**
 * Krige scattered points onto a spec. Same masking as gridSurface
 * (convex hull of the control points plus maxExtrapolation).
 * @returns {{z:Float32Array, variance:Float32Array, live, controlCount,
 *            dropped, merged, zMin, zMax, neighbourhood}}
 */
export function krigeSurface(rawPoints, spec, opts = {}) {
  const {
    maxControl = 700,
    maxExtrapolation = 2 * Math.max(spec.dx, spec.dy),
    neighbours = 24,
    detrend = false,
    onProgress,
  } = opts;
  const vp = variogramParams(opts);
  const clean = cleanPoints(rawPoints);
  const { points: dedup, merged } = mergeDuplicates(clean);
  const { points: kept, dropped } = decimateControls(dedup, maxControl);
  if (kept.length < 2) throw new Error('Kriging needs at least two control points at distinct locations.');
  const plane = detrend ? fitPlane(kept) : null;
  const points = plane ? kept.map((p) => ({ ...p, z: p.z - planeAt(plane, p.x, p.y) })) : kept;
  const hull = convexHull(points);
  const maxExtrap2 = maxExtrapolation * maxExtrapolation;
  const { nx, ny } = spec;
  const z = new Float32Array(nx * ny).fill(NULL_F32);
  const variance = new Float32Array(nx * ny).fill(NULL_F32);
  const global = points.length <= neighbours;
  const solveGlobal = global ? okSystem(points, vp) : null;
  let live = 0; let zMin = Infinity; let zMax = -Infinity;
  const total = nx * ny;
  for (let r = 0; r < ny; r++) {
    const y = spec.y0 + r * spec.dy;
    for (let c = 0; c < nx; c++) {
      const x = spec.x0 + c * spec.dx;
      if (!insideHull(hull, x, y)) continue;
      let near = false;
      for (let i = 0; i < points.length; i++) {
        const dx = x - points[i].x; const dy = y - points[i].y;
        if (dx * dx + dy * dy <= maxExtrap2) { near = true; break; }
      }
      if (!near) continue;
      const res = global ? solveGlobal(x, y) : okSystem(nearest(points, x, y, neighbours), vp)(x, y);
      z[r * nx + c] = res.value + (plane ? planeAt(plane, x, y) : 0);
      variance[r * nx + c] = res.variance;
      const vf = z[r * nx + c];
      if (vf < zMin) zMin = vf;
      if (vf > zMax) zMax = vf;
      live += 1;
    }
    if (onProgress && r % 8 === 0) onProgress(r * nx, total);
  }
  if (onProgress) onProgress(total, total);
  return {
    z, variance, live, controlCount: points.length, dropped, merged,
    zMin: live ? zMin : null, zMax: live ? zMax : null,
    neighbourhood: global ? 'global' : 'moving',
    variogram: vp,
    plane,
  };
}
