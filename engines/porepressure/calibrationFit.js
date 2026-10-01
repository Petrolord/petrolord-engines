// Calibration that calibrates (Pore Pressure Studio U2-006 and U2-007):
// method parameters fitted to measured pore pressures (RFT/MDT, kicks).
//
//   fitEatonExponent: the Eaton n that minimises the squared pore pressure
//     misfit over the measured points, S - (S - Ph) r^n against PP_meas,
//     where r is the sonic (dt_n/dt) or resistivity (R/R_n) ratio. One
//     parameter, bounded; a coarse scan then golden-section refinement, so
//     a misfit with two dips cannot trap it in the wrong one.
//   fitBowersLoading: Bowers' virgin curve V = V_ml + A sigma'^B is linear in
//     log space, ln(V - V_ml) = ln A + B ln sigma', so A and B follow from
//     exact least squares on the measured effective stresses (S - PP_meas).
//   fitBowersU: the unloading exponent U for a given sigma_max, by the same
//     bounded one-parameter search on the pore pressure misfit.
//
// Every function returns the misfit it reached so the caller can show it.

import { eaton } from './eaton';
import { bowersSigmaUnloading } from './bowers';
import { M_PER_FT, PA_PER_PSI } from './constants';

const PHI = (Math.sqrt(5) - 1) / 2;

/** Minimise f on [lo, hi]: a scan of `scan` points, then golden section around the best. */
export function minimise1d(f, lo, hi, { scan = 121, tol = 1e-12, maxIter = 300 } = {}) {
  if (!(hi > lo)) throw new Error('Need lo < hi.');
  let best = lo; let fBest = Infinity;
  const h = (hi - lo) / (scan - 1);
  for (let i = 0; i < scan; i++) {
    const x = lo + i * h;
    const v = f(x);
    if (v < fBest) { fBest = v; best = x; }
  }
  let a = Math.max(lo, best - h); let b = Math.min(hi, best + h);
  let c = b - PHI * (b - a); let d = a + PHI * (b - a);
  let fc = f(c); let fd = f(d);
  for (let k = 0; k < maxIter && (b - a) > tol * Math.max(1, Math.abs(c)); k++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - PHI * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + PHI * (b - a); fd = f(d); }
  }
  const x = fc < fd ? c : d;
  const fx = Math.min(fc, fd);
  return fx <= fBest ? { x, f: fx } : { x: best, f: fBest };
}

function checkPoints(pts, keys) {
  if (!Array.isArray(pts) || pts.length < 1) throw new Error('Need at least one calibration point.');
  pts.forEach((p, i) => {
    for (const k of keys) if (!Number.isFinite(p?.[k])) throw new Error(`Calibration point ${i} has no ${k}.`);
  });
}

const rmsOf = (res) => Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);

/**
 * @param {{S: number, Ph: number, ratio: number, ppMeasured: number}[]} points Pa
 * @param {{nMin?: number, nMax?: number}} [bounds]
 * @returns {{n: number, rmsPa: number, residualsPa: number[], atBound: boolean}}
 */
export function fitEatonExponent(points, { nMin = 0.2, nMax = 6 } = {}) {
  checkPoints(points, ['S', 'Ph', 'ratio', 'ppMeasured']);
  points.forEach((p, i) => { if (!(p.ratio > 0)) throw new Error(`Calibration point ${i} has no positive ratio.`); });
  const sse = (n) => points.reduce((a, p) => a + (p.ppMeasured - eaton(p.S, p.Ph, p.ratio, n)) ** 2, 0);
  const { x: n } = minimise1d(sse, nMin, nMax);
  const residualsPa = points.map((p) => p.ppMeasured - eaton(p.S, p.Ph, p.ratio, n));
  const span = nMax - nMin;
  return { n, rmsPa: rmsOf(residualsPa), residualsPa, atBound: n - nMin < 1e-6 * span || nMax - n < 1e-6 * span };
}

/**
 * @param {{vMs: number, S: number, ppMeasured: number}[]} points
 * @returns {{A: number, B: number, rmsPa: number, residualsPa: number[], used: number}}
 *   A and B in Bowers' published ft/s and psi domain
 */
export function fitBowersLoading(points, vMlFts = 5000.0) {
  checkPoints(points, ['vMs', 'S', 'ppMeasured']);
  const xs = []; const ys = [];
  for (const p of points) {
    const sigmaPsi = (p.S - p.ppMeasured) / PA_PER_PSI;
    const dv = p.vMs / M_PER_FT - vMlFts;
    if (sigmaPsi > 0 && dv > 0) { xs.push(Math.log(sigmaPsi)); ys.push(Math.log(dv)); }
  }
  if (xs.length < 2) throw new Error('Bowers A and B need two points with positive effective stress and velocity above the mudline velocity.');
  const n = xs.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) throw new Error('The points share one effective stress, so B cannot be fitted.');
  const B = (n * sxy - sx * sy) / denom;
  const A = Math.exp((sy - B * sx) / n);
  if (!(A > 0) || !(B > 0)) throw new Error('The points give a non-positive Bowers A or B.');
  const residualsPa = points.map((p) => {
    const vFts = p.vMs / M_PER_FT;
    if (!(vFts > vMlFts)) return NaN;
    const sigma = ((vFts - vMlFts) / A) ** (1 / B) * PA_PER_PSI;
    return p.ppMeasured - (p.S - sigma);
  });
  const ok = residualsPa.filter(Number.isFinite);
  return { A, B, rmsPa: ok.length ? rmsOf(ok) : NaN, residualsPa, used: n };
}

/**
 * @param {{vMs: number, S: number, ppMeasured: number}[]} points
 * @param {{A: number, B: number, sigmaMaxPa: number, vMlFts?: number, uMin?: number, uMax?: number}} p
 * @returns {{U: number, rmsPa: number, residualsPa: number[], atBound: boolean}}
 */
export function fitBowersU(points, { A, B, sigmaMaxPa, vMlFts = 5000.0, uMin = 1, uMax = 12 }) {
  checkPoints(points, ['vMs', 'S', 'ppMeasured']);
  const pp = (p, U) => p.S - bowersSigmaUnloading(p.vMs, sigmaMaxPa, A, B, U, vMlFts);
  const sse = (U) => points.reduce((a, p) => a + (p.ppMeasured - pp(p, U)) ** 2, 0);
  const { x: U } = minimise1d(sse, uMin, uMax);
  const residualsPa = points.map((p) => p.ppMeasured - pp(p, U));
  const span = uMax - uMin;
  return { U, rmsPa: rmsOf(residualsPa), residualsPa, atBound: U - uMin < 1e-6 * span || uMax - U < 1e-6 * span };
}
