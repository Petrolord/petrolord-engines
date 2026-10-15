// Low-frequency model options (QI upgrade P2.8, 2026-10-15), beside the
// horizon-guided inverse-distance model of qi/lfm.js (unchanged):
//  - ordinary kriging of the wells (a variogram in map distance) in place of
//    inverse distance;
//  - faults in the framework: a well whose straight line to the trace
//    crosses a fault trace (a map polyline) gives that trace no weight, so a
//    model never averages across a fault (all wells blocked: the trace falls
//    back to every well, and says so);
//  - a velocity trend: the seismic velocity volume (interval velocity, or RMS
//    velocity taken to interval by Dix) mapped to ln(AI) by a straight line in
//    ln(V) calibrated at the wells (ln AI = a + b ln V; Gardner's density
//    rho = c V^0.25 gives b = 1.25), the wells' residuals from that trend
//    interpolated between them and added back. Away from the wells the model
//    follows the velocity; at a well it returns the well;
//  - every option is a named scenario, so alternatives are compared at the
//    blind wells.
// Pure, float64. Oracle: tools/validation/qi/oracle_lfm_models.py.

import { covarianceFn } from '../../lib/gridding/kriging.js';
import { mapToWellTime, sampleAt } from './lfm.js';

const fin = Number.isFinite;

export const LFM_METHODS = Object.freeze([
  { key: 'idw', label: 'Inverse distance' },
  { key: 'kriging', label: 'Kriging' },
]);

/** Do segments ab and cd cross (touching at an end counts)? */
export function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const on = (p, q, r) => Math.min(p.x, r.x) - 1e-9 <= q.x && q.x <= Math.max(p.x, r.x) + 1e-9 && Math.min(p.y, r.y) - 1e-9 <= q.y && q.y <= Math.max(p.y, r.y) + 1e-9;
  const d1 = o(c, d, a); const d2 = o(c, d, b); const d3 = o(a, b, c); const d4 = o(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (Math.abs(d1) < 1e-12 && on(c, a, d)) return true;
  if (Math.abs(d2) < 1e-12 && on(c, b, d)) return true;
  if (Math.abs(d3) < 1e-12 && on(a, c, b)) return true;
  if (Math.abs(d4) < 1e-12 && on(a, d, b)) return true;
  return false;
}

/** Is the straight line from p to q cut by any fault polyline ([{x, y}, ...])? */
export function blockedBy(barriers, p, q) {
  for (const line of barriers || []) {
    for (let i = 1; i < line.length; i++) if (segmentsCross(p, q, line[i - 1], line[i])) return true;
  }
  return false;
}

/**
 * Ordinary-kriging weights of control points at a target: they sum to one;
 * at a control point the weight is one there. The (n + 1) system is solved
 * by Gaussian elimination with partial pivoting.
 * @param {Array<{x, y}>} pts
 * @param {{x, y}} at
 * @param {{model, range, sill, nugget?}} variogram (the kriging library's parameters)
 * @returns {Float64Array}
 */
export function okWeights(pts, at, variogram) {
  const n = pts.length;
  if (n === 1) return Float64Array.of(1);
  for (let i = 0; i < n; i++) if (Math.hypot(pts[i].x - at.x, pts[i].y - at.y) < 1e-6) { const w = new Float64Array(n); w[i] = 1; return w; }
  const C = covarianceFn(variogram);
  const m = n + 1;
  const A = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = C(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    A[i][n] = 1; A[n][i] = 1;
    A[i][m] = C(Math.hypot(pts[i].x - at.x, pts[i].y - at.y));
  }
  A[n][n] = 0; A[n][m] = 1;
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (!(Math.abs(A[p][c]) > 1e-14)) throw new Error('The kriging system is singular: two wells sit at one place, or the range is too short.');
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f) for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  return Float64Array.from({ length: n }, (_, i) => A[i][m] / A[i][i]);
}

/**
 * The weights of the wells at one trace position.
 * @param {Array<{name, x, y}>} wells
 * @param {{x, y}} at
 * @param {{method?: 'idw'|'kriging', power?, variogram?, barriers?, exclude?}} o
 * @returns {{wells: Array, weights: Float64Array, blocked: string[], fallback: boolean}} kriging weights sum to one; inverse-distance weights are 1 / d^power, unnormalised
 */
export function lfmWeights(wells, at, { method = 'idw', power = 2, variogram = null, barriers = [], exclude } = {}) {
  const pool = wells.filter((w) => w.name !== exclude);
  if (!pool.length) throw new Error('The low-frequency model needs at least one well.');
  const open = barriers?.length ? pool.filter((w) => !blockedBy(barriers, w, at)) : pool;
  const blocked = pool.filter((w) => !open.includes(w)).map((w) => w.name);
  const used = open.length ? open : pool;
  let weights;
  if (method === 'kriging') {
    if (!variogram) throw new Error('Kriging needs a variogram (model, range and sill).');
    weights = okWeights(used, at, variogram);
  } else {
    // left unnormalised (the model divides by their sum per sample), so the
    // default options give lfm.js lfmTrace bit for bit
    const raw = used.map((w) => { const d = Math.hypot(w.x - at.x, w.y - at.y); return d < 1e-6 ? Infinity : 1 / d ** power; });
    const exact = raw.findIndex((v) => v === Infinity);
    weights = Float64Array.from(raw, (v, i) => (exact >= 0 ? (i === exact ? 1 : 0) : v));
  }
  return { wells: used, weights, blocked, fallback: !open.length };
}

/**
 * The low-frequency model at one trace with the options above. With the
 * default options (inverse distance, no barriers, no trend) it equals
 * qi/lfm.js lfmTrace.
 * @param {Array<{name, x, y, t0Ms, dtMs, values, horizons?, trend?}>} wells low-passed ln(AI); trend: the velocity trend in ln(AI) at the well, sampled as values
 * @param {{x, y, horizons?, trend?: ArrayLike<number>}} at trend: the velocity trend in ln(AI) at this trace, on the trace grid
 * @param {{t0Ms, dtMs, ns}} grid
 * @param {Object} [o] lfmWeights options
 * @returns {Float64Array}
 */
export function lfmTraceModel(wells, at, grid, o = {}) {
  const { wells: used, weights } = lfmWeights(wells, at, o);
  const withTrend = !!at.trend;
  if (withTrend && used.some((w) => !w.trend)) throw new Error('A velocity trend needs the trend at every well.');
  const out = new Float64Array(grid.ns).fill(NaN);
  for (let k = 0; k < grid.ns; k++) {
    const t = grid.t0Ms + k * grid.dtMs;
    let s = 0; let ws = 0;
    for (let j = 0; j < used.length; j++) {
      if (!weights[j]) continue;
      const w = used[j];
      const tw = mapToWellTime(t, at.horizons, w.horizons);
      let v = sampleAt(w.values, w.t0Ms, w.dtMs, tw);
      if (withTrend) v -= sampleAt(w.trend, w.t0Ms, w.dtMs, tw);
      if (!fin(v)) continue;
      s += weights[j] * v; ws += weights[j];
    }
    if (ws !== 0) out[k] = s / ws;
  }
  let first = -1;
  for (let k = 0; k < grid.ns; k++) if (fin(out[k])) { first = k; break; }
  if (first < 0) throw new Error('No well log covers this trace window.');
  for (let k = 0; k < first; k++) out[k] = out[first];
  for (let k = first + 1; k < grid.ns; k++) if (!fin(out[k])) out[k] = out[k - 1];
  if (withTrend) {
    // the residual added to the trend; where the trace has no trend the residual alone is no model
    for (let k = 0; k < grid.ns; k++) out[k] = fin(at.trend[k]) ? out[k] + at.trend[k] : NaN;
    let f = -1;
    for (let k = 0; k < grid.ns; k++) if (fin(out[k])) { f = k; break; }
    if (f < 0) throw new Error('The velocity trend has no value on this trace.');
    for (let k = 0; k < f; k++) out[k] = out[f];
    for (let k = f + 1; k < grid.ns; k++) if (!fin(out[k])) out[k] = out[k - 1];
  }
  return out;
}

/**
 * Interval velocity from an RMS velocity trace sampled every dtMs from 0
 * (Dix, sample by sample: Vint^2 = (V2^2 t2 - V1^2 t1) / (t2 - t1)). The
 * first sample keeps its RMS value; a sample with no real interval velocity
 * is NaN.
 */
export function intervalFromRms(vrms, dtMs) {
  const out = new Float64Array(vrms.length).fill(NaN);
  if (!vrms.length) return out;
  out[0] = fin(vrms[0]) ? vrms[0] : NaN;
  for (let i = 1; i < vrms.length; i++) {
    const a = vrms[i - 1]; const b = vrms[i];
    if (!fin(a) || !fin(b) || !(a > 0) || !(b > 0)) continue;
    const t1 = (i - 1) * dtMs; const t2 = i * dtMs;
    const num = b * b * t2 - a * a * t1;
    out[i] = num > 0 ? Math.sqrt(num / (t2 - t1)) : NaN;
  }
  return out;
}

/**
 * The calibration of ln(AI) to ln(V) at the wells, by least squares over
 * every sample where both are finite: ln AI = a + b ln V.
 * @param {Array<{lnAi: ArrayLike<number>, v: ArrayLike<number>}>} pairs
 * @returns {{a, b, r2, n, sd}}
 */
export function fitVelocityTrend(pairs) {
  let n = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0;
  for (const { lnAi, v } of pairs) {
    for (let i = 0; i < Math.min(lnAi.length, v.length); i++) {
      if (!fin(lnAi[i]) || !fin(v[i]) || !(v[i] > 0)) continue;
      const x = Math.log(v[i]); const y = lnAi[i];
      n += 1; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    }
  }
  if (n < 10) throw new Error('The wells overlap too little of the velocity volume to calibrate it (fewer than 10 samples).');
  const vx = sxx - (sx * sx) / n;
  if (!(vx > 0)) throw new Error('The velocity does not vary at the wells, so it cannot be calibrated to impedance.');
  const b = (sxy - (sx * sy) / n) / vx;
  const a = (sy - b * sx) / n;
  const vy = syy - (sy * sy) / n;
  const sse = Math.max(0, vy - b * (sxy - (sx * sy) / n));
  return { a, b, r2: vy > 0 ? 1 - sse / vy : 1, n, sd: n > 2 ? Math.sqrt(sse / (n - 2)) : 0 };
}

/** The velocity trend in ln(AI) on a velocity trace. */
export function velocityTrendLnAi(v, fit) {
  return Float64Array.from(v, (x) => (fin(x) && x > 0 ? fit.a + fit.b * Math.log(x) : NaN));
}
