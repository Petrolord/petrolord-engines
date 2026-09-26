// Gridding with splines in tension (Mapping & Surface Studio T1 finding
// MAP-T1-008, 2026-09-26).
//
// The thin-plate spline the Studio already grids with IS the continuous
// minimum-curvature surface: Sandwell (1987), "Biharmonic spline
// interpolation of GEOS-3 and SEASAT altimeter data", Geophysical
// Research Letters 14(2), shows Briggs' minimum-curvature grid is the
// discretisation of the biharmonic Green's function r^2 ln r. What a
// Petrel, Surfer or Kingdom user reaches for beyond it is TENSION (stop
// the surface overshooting between close wells and running away beyond
// them) and SMOOTHING (do not force the surface through every noisy
// value). Both come from the Green's function of the spline in tension,
//
//   (1 - T) del^4 z - T del^2 z = sum_i w_i delta(x - x_i),
//
// which in two dimensions is, up to constants,
//
//   g(r) = K0(p r) + ln(p r)                    p > 0
//
// (Wessel & Bercovici 1998, "Interpolation with splines in tension: a
// Green's function approach", Mathematical Geology 30(1); Mitasova &
// Mitas 1993, "Interpolation by regularized spline with tension",
// Mathematical Geology 25(6)). g is finite at r = 0 (ln 2 - gamma),
// behaves like the biharmonic r^2 ln r for p r << 1 and like the
// membrane ln r for p r >> 1: tension flattens the surface over
// distances beyond 1/p. The interpolant is
//
//   z(x) = a0 + ax x + ay y + sum_i w_i g(|x - x_i|),
//   sum w_i = sum w_i x_i = sum w_i y_i = 0,
//
// so a plane through the data is reproduced EXACTLY at any tension (it
// lives in the affine part, every w_i = 0). Smoothing adds s to the
// diagonal of the Green matrix (the smoothing-spline form: the fit may
// miss datum i by s * w_i). Tension T in [0, 1) is mapped to
// p = (T / (1 - T)) / L with L the median nearest-neighbour spacing of
// the control points, so T = 0.5 flattens beyond about one well
// spacing; T = 0 is the thin-plate spline itself (gridding.js fitTps).
//
// g is evaluated by its ascending series for p r <= 2 (no cancellation,
// so low tension keeps full precision) and by K0's asymptotic polynomial
// plus ln above. Grid evaluation reads g from a 4,096-interval table over the range of
// distances the grid can see (linear interpolation, relative error below
// 1e-6 of the table's span), so gridding costs what TPS costs. Pure math,
// worker-safe, no I/O. Validated against
// tools/validation/mapping/oracle_tension.py, which evaluates K0 by
// numerical integration and solves the system by its own elimination.

import { NULL_VALUE } from './numeric';
import { gridXY } from './gridmath';
import { convexHull, insideHull, decimateControls, fitTps } from './gridding';

const NULL_F32 = Math.fround(NULL_VALUE);
const EULER_GAMMA = 0.5772156649015329;

/** Modified Bessel function I0 (Abramowitz & Stegun 9.8.1, |x| <= 3.75). */
function besselI0Small(x) {
  const t = (x / 3.75) ** 2;
  return 1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))));
}

/**
 * Modified Bessel function of the second kind, order 0, x > 0
 * (Abramowitz & Stegun 9.8.5 for x <= 2, 9.8.6 for x > 2; |error| < 1e-7
 * absolute below 2 and 1e-7 relative to sqrt(x) e^x K0 above).
 */
export function besselK0(x) {
  if (!(x > 0)) throw new Error('K0 needs a positive argument.');
  if (x <= 2) {
    const t = (x / 2) ** 2;
    return -Math.log(x / 2) * besselI0Small(x)
      + (-0.57721566 + t * (0.42278420 + t * (0.23069756 + t * (0.03488590 + t * (0.00262698 + t * (0.00010750 + t * 0.0000074))))));
  }
  const t = 2 / x;
  return (Math.exp(-x) / Math.sqrt(x))
    * (1.25331414 + t * (-0.07832358 + t * (0.02189568 + t * (-0.01062446 + t * (0.00587872 + t * (-0.00251540 + t * 0.00053208))))));
}

/**
 * K0(x) + ln x for 0 <= x <= 2 from the ascending series with no
 * cancellation. With I0(x) = sum_k (x^2/4)^k / (k!)^2 and
 * K0(x) = -(ln(x/2) + gamma) I0(x) + sum_{k>=1} (x^2/4)^k / (k!)^2 H_k
 * (Abramowitz & Stegun 9.6.13, H_k the harmonic numbers),
 *   K0(x) + ln x = ln 2 - gamma + sum_{k>=1} (x^2/4)^k / (k!)^2 (H_k - ln(x/2) - gamma).
 * Every term is positive for x <= 2, so the spline's shape, which lives
 * in the O(x^2 ln x) part at low tension, keeps full precision (a K0
 * polynomial fit with 1e-7 absolute error would swamp it).
 */
function greenSeries(x) {
  const q = (x * x) / 4;
  const lg = Math.log(x / 2) + EULER_GAMMA;
  let sum = Math.log(2) - EULER_GAMMA;
  let term = 1; let H = 0;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    H += 1 / k;
    const add = term * (H - lg);
    sum += add;
    if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
  }
  return sum;
}

/** Green's function of the spline in tension, g = K0(pr) + ln(pr), finite at r = 0. */
export function tensionGreen(r, p) {
  const x = p * r;
  if (x <= 0) return Math.log(2) - EULER_GAMMA;
  if (x <= 2) return greenSeries(x);
  return besselK0(x) + Math.log(x);
}

/** Median nearest-neighbour spacing of the points (world units). */
export function medianSpacing(points) {
  const d = [];
  for (let i = 0; i < points.length; i++) {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const h = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (h > 0 && h < best) best = h;
    }
    if (Number.isFinite(best)) d.push(best);
  }
  if (!d.length) return 1;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/** Tension parameter p (1 / length) for T in [0, 1) and spacing L. */
export function tensionP(tension, spacing) {
  if (!(tension >= 0 && tension < 1)) throw new Error('Tension must be at least 0 and below 1.');
  if (!(spacing > 0)) throw new Error('The control spacing must be greater than zero.');
  return tension / (1 - tension) / spacing;
}

function solveDense(A, b, n) {
  for (let col = 0; col < n; col++) {
    let piv = col; let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) { const v = Math.abs(A[r * n + col]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-12) throw new Error('Gridding system is singular: control points may be collinear or duplicated.');
    if (piv !== col) {
      for (let c = col; c < n; c++) { const t = A[col * n + c]; A[col * n + c] = A[piv * n + c]; A[piv * n + c] = t; }
      const t = b[col]; b[col] = b[piv]; b[piv] = t;
    }
    const inv = 1 / A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * b[c];
    b[r] = s / A[r * n + r];
  }
  return b;
}

/**
 * Fit a spline in tension through (or, with smoothing, near) the points.
 * @param {{x,y,z}[]} points at least 3, not collinear
 * @param {{tension?:number, smoothing?:number, spacing?:number}} [opts]
 *   smoothing >= 0 is added to the Green matrix diagonal; spacing
 *   overrides the median nearest-neighbour spacing used for p
 * @returns {{evaluate:(x:number,y:number)=>number, p:number, weights:Float64Array,
 *   affine:number[], centre:{x:number,y:number}, green:(r:number)=>number}}
 *   With tension 0 the thin-plate spline is returned unchanged.
 */
export function fitTensionSpline(points, { tension = 0, smoothing = 0, spacing = null } = {}) {
  const n = points.length;
  if (n < 3) throw new Error('Gridding needs at least 3 control points.');
  if (!(smoothing >= 0)) throw new Error('Smoothing must be zero or more.');
  if (tension === 0 && smoothing === 0) {
    const tps = fitTps(points);
    return { evaluate: tps, p: 0, weights: null, affine: null, centre: null, green: null };
  }
  const L = spacing ?? medianSpacing(points);
  // centre the coordinates so the affine columns are well scaled
  let cx = 0; let cy = 0;
  for (const q of points) { cx += q.x; cy += q.y; }
  cx /= n; cy /= n;
  const p = tension > 0 ? tensionP(tension, L) : 0;
  // T = 0 with smoothing: the biharmonic kernel r^2 ln r (in units of L)
  const green = p > 0
    ? (r) => tensionGreen(r, p)
    : (r) => { const u = r / L; return u > 0 ? u * u * Math.log(u) : 0; };
  const m = n + 3;
  const A = new Float64Array(m * m);
  const b = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const xi = points[i].x - cx; const yi = points[i].y - cy;
    for (let j = 0; j < n; j++) {
      A[i * m + j] = green(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
    // smoothing-spline diagonal. r^2 ln r is conditionally positive
    // definite (order 2), so +s relaxes the fit; K0(pr) + ln(pr) enters
    // with the opposite sign (it is the NEGATIVE of a conditionally
    // positive definite kernel: Mitasova & Mitas write the same function
    // as -[E1 + ln + gamma] in their regularised form), so the diagonal
    // takes -s there. The gate asserts misfit grows monotonically with s.
    A[i * m + i] += p > 0 ? -smoothing : smoothing;
    A[i * m + n] = 1; A[i * m + n + 1] = xi / L; A[i * m + n + 2] = yi / L;
    A[n * m + i] = 1; A[(n + 1) * m + i] = xi / L; A[(n + 2) * m + i] = yi / L;
    b[i] = points[i].z;
  }
  const sol = solveDense(A, b, m);
  const w = sol.slice(0, n);
  const affine = [sol[n], sol[n + 1], sol[n + 2]];
  const px = points.map((q) => q.x); const py = points.map((q) => q.y);
  const evaluate = (x, y) => {
    let s = affine[0] + (affine[1] * (x - cx) + affine[2] * (y - cy)) / L;
    for (let i = 0; i < n; i++) s += w[i] * green(Math.hypot(x - px[i], y - py[i]));
    return s;
  };
  return { evaluate, p, weights: w, affine, centre: { x: cx, y: cy }, green, spacing: L, px, py };
}

/**
 * Grid points with a spline in tension; same masking, decimation and
 * return shape as gridSurface.
 * @param {{x,y,z}[]} rawPoints
 * @param {{x0,y0,dx,dy,nx,ny,rotation_deg?}} spec
 * @param {{tension?:number, smoothing?:number, mask?:'hull'|'none',
 *   maxExtrapolation?:number, maxControl?:number}} [opts]
 */
export function gridTensionSpline(rawPoints, spec, opts = {}) {
  const { tension = 0, smoothing = 0, mask = 'hull', maxExtrapolation = Infinity, maxControl = 700 } = opts;
  if (mask !== 'hull' && mask !== 'none') throw new Error(`Unknown gridding mask "${mask}" (expected hull or none).`);
  const clean = rawPoints.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Math.abs(q.z) < 1.0e29);
  const { points, dropped } = decimateControls(clean, maxControl);
  const fit = fitTensionSpline(points, { tension, smoothing });
  const { nx, ny } = spec;
  // the table spans every distance a node can have to a control point
  let evalAt = fit.evaluate;
  if (fit.green) {
    const corners = [gridXY(spec, 0, 0), gridXY(spec, 0, nx - 1), gridXY(spec, ny - 1, 0), gridXY(spec, ny - 1, nx - 1)];
    let rMax = 0;
    for (const q of points) for (const c of corners) rMax = Math.max(rMax, Math.hypot(q.x - c.x, q.y - c.y));
    for (const q of points) for (const o of points) rMax = Math.max(rMax, Math.hypot(q.x - o.x, q.y - o.y));
    // inline table read: the hot loop runs nodes x controls times
    const intervals = 4096;
    const span = rMax * 1.001 || 1;
    const h = span / intervals;
    const inv = 1 / h;
    const tab = new Float64Array(intervals + 2);
    for (let k = 0; k <= intervals + 1; k++) tab[k] = fit.green(k * h);
    const { weights: w, affine, centre, spacing: L } = fit;
    const px = Float64Array.from(fit.px); const py = Float64Array.from(fit.py);
    const nw = w.length;
    evalAt = (x, y) => {
      let s = affine[0] + (affine[1] * (x - centre.x) + affine[2] * (y - centre.y)) / L;
      for (let i = 0; i < nw; i++) {
        const dx = x - px[i]; const dy = y - py[i];
        const f = Math.sqrt(dx * dx + dy * dy) * inv;
        const k = f < intervals ? f | 0 : intervals;
        s += w[i] * (tab[k] + (f - k) * (tab[k + 1] - tab[k]));
      }
      return s;
    };
  }
  const hull = mask === 'hull' ? convexHull(points) : null;
  const maxE2 = maxExtrapolation * maxExtrapolation;
  const z = new Float32Array(nx * ny).fill(NULL_F32);
  let live = 0; let zMin = Infinity; let zMax = -Infinity;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const q = gridXY(spec, r, c);
      if (hull && !insideHull(hull, q.x, q.y)) continue;
      if (Number.isFinite(maxE2)) {
        let near = false;
        for (const o of points) { const dx = q.x - o.x; const dy = q.y - o.y; if (dx * dx + dy * dy <= maxE2) { near = true; break; } }
        if (!near) continue;
      }
      const i = r * nx + c;
      z[i] = evalAt(q.x, q.y);
      const v = z[i];
      if (v < zMin) zMin = v;
      if (v > zMax) zMax = v;
      live += 1;
    }
  }
  return { z, live, controlCount: points.length, dropped, zMin: live ? zMin : null, zMax: live ? zMax : null, p: fit.p };
}
