// The full elastic set and a locally calibrated shear regression (QI
// programme Q1, Milestone A2).
//
//   Moduli:  K = rho (Vp^2 - 4/3 Vs^2),  mu = rho Vs^2,  lambda = K - 2/3 mu
//   LMR (Goodway, Chen and Downton 1997):
//            lambda rho = AI^2 - 2 SI^2,  mu rho = SI^2
//   EI (Connolly 1999), normalised (Whitcombe 2002):
//            EI(theta) = a0 r0 (a/a0)^(1 + tan^2 t) (b/b0)^(-8K sin^2 t) (r/r0)^(1 - 4K sin^2 t)
//   EEI (Whitcombe, Connolly, Reagan and Redshaw 2002):
//            EEI(chi) = a0 r0 (a/a0)^p (b/b0)^q (r/r0)^r
//            p = cos chi + sin chi, q = -8K sin chi, r = cos chi - 4K sin chi
//   with K the (constant) mean of (Vs/Vp)^2. Its log reflectivity is exactly
//   A cos chi + B sin chi for the two-term intercept and gradient with that K.
//
// Shear regression: ordinary least squares of Vs on Vp (linear or quadratic)
// fitted to the wells' measured shear in one interval or lithology, with the
// standard prediction interval
//   Vs0 +/- t(n - p, (1 + level) / 2) s sqrt(1 + x0' (X'X)^-1 x0),
// so predicted shear carries its own uncertainty into modelling.
//
// SI throughout (m/s, kg/m3, Pa). Pure; unphysical inputs give NaN per sample
// in the curve functions and THROW in the fitting functions.

import { studentTUpperQuantile } from '../dataai/quality.js';

const pos = (...xs) => xs.every((x) => Number.isFinite(x) && x > 0);
const rad = (d) => (d * Math.PI) / 180;

/** Every elastic quantity at one sample; NaN where Vs >= Vp or a value is missing. */
export function elasticPoint(vp, vs, rho) {
  if (!pos(vp, vs, rho) || vs >= vp) {
    return { ai: NaN, si: NaN, vpvs: NaN, pr: NaN, k: NaN, mu: NaN, lambda: NaN, lambdaRho: NaN, muRho: NaN };
  }
  const ai = vp * rho;
  const si = vs * rho;
  const mu = rho * vs * vs;
  const k = rho * (vp * vp - (4 / 3) * vs * vs);
  const a = vp * vp;
  const b = vs * vs;
  return {
    ai,
    si,
    vpvs: vp / vs,
    pr: (a - 2 * b) / (2 * (a - b)),
    k,
    mu,
    lambda: k - (2 / 3) * mu,
    lambdaRho: ai * ai - 2 * si * si,
    muRho: si * si,
  };
}

const KEYS = ['ai', 'si', 'vpvs', 'pr', 'k', 'mu', 'lambda', 'lambdaRho', 'muRho'];

/** The elastic set as curves (Float64Array each) from Vp, Vs and density logs. */
export function elasticCurves({ vp, vs, rho }) {
  const n = vp?.length ?? 0;
  if (vs?.length !== n || rho?.length !== n) throw new Error('Vp, Vs and density must have the same length.');
  const out = Object.fromEntries(KEYS.map((k) => [k, new Float64Array(n)]));
  for (let i = 0; i < n; i++) {
    const e = elasticPoint(vp[i], vs[i], rho[i]);
    for (const k of KEYS) out[k][i] = e[k];
  }
  return out;
}

/**
 * The constant K = mean of (Vs/Vp)^2 over the samples given (indices, or all),
 * the value EI and EEI hold fixed (Whitcombe et al. 2002 use the interval mean).
 */
export function meanK({ vp, vs }, indices = null) {
  let s = 0;
  let n = 0;
  const idx = indices ?? Array.from({ length: vp.length }, (_, i) => i);
  for (const i of idx) {
    if (pos(vp[i], vs[i]) && vs[i] < vp[i]) { s += (vs[i] / vp[i]) ** 2; n++; }
  }
  if (!n) throw new Error('No sample has both Vp and Vs to set K.');
  return s / n;
}

/** Reference values (a0, b0, r0): the means over the samples, so the impedances keep AI units. */
export function referenceValues({ vp, vs, rho }, indices = null) {
  let a = 0; let b = 0; let r = 0; let n = 0;
  const idx = indices ?? Array.from({ length: vp.length }, (_, i) => i);
  for (const i of idx) {
    if (pos(vp[i], vs[i], rho[i]) && vs[i] < vp[i]) { a += vp[i]; b += vs[i]; r += rho[i]; n++; }
  }
  if (!n) throw new Error('No sample has Vp, Vs and density together.');
  return { vp0: a / n, vs0: b / n, rho0: r / n };
}

function checkRef(K, ref) {
  if (!(K > 0 && K < 1)) throw new Error('K, the mean (Vs/Vp)^2, must be between 0 and 1.');
  if (!pos(ref?.vp0, ref?.vs0, ref?.rho0)) throw new Error('Reference Vp, Vs and density must be positive.');
}

/** EEI(chi) at one sample (chi in degrees, -90 to 90). */
export function eeiPoint(vp, vs, rho, chiDeg, { K, ref }) {
  checkRef(K, ref);
  if (!(chiDeg >= -90 && chiDeg <= 90)) throw new Error('chi must be between -90 and 90 degrees.');
  if (!pos(vp, vs, rho)) return NaN;
  const c = Math.cos(rad(chiDeg));
  const s = Math.sin(rad(chiDeg));
  const p = c + s;
  const q = -8 * K * s;
  const r = c - 4 * K * s;
  return ref.vp0 * ref.rho0 * (vp / ref.vp0) ** p * (vs / ref.vs0) ** q * (rho / ref.rho0) ** r;
}

/** Normalised elastic impedance EI(theta) at one sample (theta in degrees, 0 to 60). */
export function eiPoint(vp, vs, rho, thetaDeg, { K, ref }) {
  checkRef(K, ref);
  if (!(thetaDeg >= 0 && thetaDeg <= 60)) throw new Error('The angle must be between 0 and 60 degrees.');
  if (!pos(vp, vs, rho)) return NaN;
  const s2 = Math.sin(rad(thetaDeg)) ** 2;
  const t2 = Math.tan(rad(thetaDeg)) ** 2;
  return ref.vp0 * ref.rho0 * (vp / ref.vp0) ** (1 + t2) * (vs / ref.vs0) ** (-8 * K * s2) * (rho / ref.rho0) ** (1 - 4 * K * s2);
}

/** EEI(chi) as a curve. */
export function eeiCurve({ vp, vs, rho }, chiDeg, opts) {
  const out = new Float64Array(vp.length);
  for (let i = 0; i < vp.length; i++) out[i] = eeiPoint(vp[i], vs[i], rho[i], chiDeg, opts);
  return out;
}

/** The chi whose EEI is proportional to a target property: the angle tan(chi) = B / A of its projection. */
export const chiFromSlope = (gradientOverIntercept) => (Math.atan(gradientOverIntercept) * 180) / Math.PI;

// --------------------------------------------------------------------------
// Locally calibrated shear regression with prediction intervals

const design = (vp, form) => (form === 'quadratic' ? [1, vp / 1000, (vp / 1000) ** 2] : [1, vp / 1000]);

function invert(m) {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-300) throw new Error('The regression is singular (Vp has no spread).');
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Fit Vs on Vp to measured shear. Vp in the design is in km/s so the normal
 * equations stay well conditioned; coefficients are reported for Vs in m/s
 * against Vp in km/s.
 * @param {{vp:number, vs:number}[]} samples measured pairs (m/s)
 * @param {{form?: 'linear'|'quadratic', label?: string}} [opts]
 * @returns {{form, coef:number[], n:number, dof:number, s:number, r2:number, xtxInv:number[][], vpRange:[number, number], label}}
 */
export function fitVsRegression(samples, { form = 'linear', label = null } = {}) {
  if (!['linear', 'quadratic'].includes(form)) throw new Error("form must be 'linear' or 'quadratic'.");
  const pts = (samples || []).filter((p) => pos(p.vp, p.vs) && p.vs < p.vp);
  const pcount = form === 'quadratic' ? 3 : 2;
  if (pts.length < pcount + 3) throw new Error(`Need at least ${pcount + 3} samples with measured Vp and Vs (got ${pts.length}).`);
  const xtx = Array.from({ length: pcount }, () => new Array(pcount).fill(0));
  const xty = new Array(pcount).fill(0);
  for (const p of pts) {
    const x = design(p.vp, form);
    for (let i = 0; i < pcount; i++) {
      xty[i] += x[i] * p.vs;
      for (let j = 0; j < pcount; j++) xtx[i][j] += x[i] * x[j];
    }
  }
  const xtxInv = invert(xtx);
  const coef = xtxInv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  let sse = 0;
  let mean = 0;
  for (const p of pts) mean += p.vs;
  mean /= pts.length;
  let sst = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    const x = design(p.vp, form);
    const f = x.reduce((s, v, j) => s + v * coef[j], 0);
    sse += (p.vs - f) ** 2;
    sst += (p.vs - mean) ** 2;
    lo = Math.min(lo, p.vp);
    hi = Math.max(hi, p.vp);
  }
  const dof = pts.length - pcount;
  return { form, coef, n: pts.length, dof, s: Math.sqrt(sse / dof), r2: sst > 0 ? 1 - sse / sst : NaN, xtxInv, vpRange: [lo, hi], label };
}

/**
 * Predicted Vs with its prediction interval at one Vp.
 * @returns {{vs:number, lo:number, hi:number, sigma:number, extrapolated:boolean}}
 *   sigma is the prediction standard error (s sqrt(1 + leverage)); extrapolated
 *   flags a Vp outside the calibration range
 */
export function predictVs(fit, vp, { level = 0.9 } = {}) {
  if (!(level > 0 && level < 1)) throw new Error('The interval level must be between 0 and 1.');
  if (!pos(vp)) return { vs: NaN, lo: NaN, hi: NaN, sigma: NaN, extrapolated: false };
  const x = design(vp, fit.form);
  const vs = x.reduce((s, v, j) => s + v * fit.coef[j], 0);
  let lev = 0;
  for (let i = 0; i < x.length; i++) for (let j = 0; j < x.length; j++) lev += x[i] * fit.xtxInv[i][j] * x[j];
  const sigma = fit.s * Math.sqrt(1 + lev);
  const t = studentTUpperQuantile((1 - level) / 2, fit.dof);
  return { vs, lo: vs - t * sigma, hi: vs + t * sigma, sigma, extrapolated: vp < fit.vpRange[0] || vp > fit.vpRange[1] };
}

/** Predicted Vs and its sigma curve for a whole Vp log. */
export function predictVsCurve(fit, vpCurve, opts = {}) {
  const n = vpCurve.length;
  const vs = new Float64Array(n);
  const sigma = new Float64Array(n);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  let extrapolated = 0;
  for (let i = 0; i < n; i++) {
    const r = predictVs(fit, vpCurve[i], opts);
    vs[i] = r.vs; sigma[i] = r.sigma; lo[i] = r.lo; hi[i] = r.hi;
    if (r.extrapolated) extrapolated++;
  }
  return { vs, sigma, lo, hi, extrapolated };
}
