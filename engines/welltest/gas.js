/**
 * Real-gas well testing (WT4): pseudo-pressure, pseudo-time and gas
 * deliverability. Oilfield units: p psia, T degR, q Mscf/D, mu cp, m(p)
 * psi^2/cp.
 *
 * Pseudo-pressure (Al-Hussainy, Ramey & Crawford, 1966):
 *   m(p) = 2 int_0^p  p' / (mu(p') z(p')) dp'
 * computed by trapezoid on a PVT table. Radial gas flow then obeys the
 * liquid equations with p -> m(p) and the Darcy coefficient
 *   1422 q T / (k h)      (vs 141.2 q B mu for liquid)
 * so the semilog slope is m_g = 1637 q T / (k h) psi^2/cp per log cycle.
 *
 * The liquid straight-line machinery in analysis.js is reused through an
 * exact equivalence: feeding it m(p) values as pressures with an
 * equivalent FVF  B_eq = 1637 T / (162.6 mu_i)  makes its
 * 162.6 q B mu / (m h) permeability and its skin formula (which uses
 * phi mu_i ct_i rw^2) the correct gas expressions evaluated at initial
 * conditions.
 *
 * Deliverability (Rawlins-Schellhardt and Houpeurt/LIT):
 *   back-pressure:  q = C (pr^2 - pwf^2)^n     n in [0.5, 1]
 *   LIT:            delta = a q + b q^2        delta = pr^2-pwf^2 or dm(p)
 * with AOF the rate at pwf = base pressure (14.7 psia by default).
 *
 * Gas PVT defaults use the same correlations as the Fluid Systems Studio
 * (Papay z-factor, Lee-Gonzalez-Eakin viscosity, Sutton pseudo-criticals).
 * They are restated here rather than imported because the welltest package
 * stays importable by the plain-node validation harness (explicit .js
 * imports only); a jest test pins them numerically identical to the
 * fluidStudioCalculations exports. A user/laboratory (p, mu, z) table
 * takes precedence when supplied.
 */

import { linearFit, mdhAnalysis, hornerAnalysis } from './analysis.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export const GAS = {
  PD_FACTOR: 1422, // m(p) Darcy coefficient, psi^2/cp per (Mscf/D)/(md ft)
  SEMILOG_SLOPE: 1637, // m_g = 1637 q T / (k h) psi^2/cp per log cycle
  BASE_PRESSURE: 14.7, // psia, AOF reference
};

/** Sutton (1985) gas pseudo-critical properties from gas gravity. */
const suttonPseudoCriticals = (gasGravity) => ({
  ppc: 756.8 - 131.0 * gasGravity - 3.6 * gasGravity * gasGravity, // psia
  tpc: 169.2 + 349.5 * gasGravity - 74.0 * gasGravity * gasGravity, // degR
});

/** Gas Z-factor via the Papay correlation (fluidStudioCalculations twin). */
export const gasZFactor = (p, tempF, gasGravity) => {
  const { ppc, tpc } = suttonPseudoCriticals(gasGravity);
  const ppr = p / ppc;
  const tpr = (tempF + 460) / tpc;
  if (!(tpr > 0)) return 0.9;
  const z =
    1 -
    (3.52 * ppr) / Math.pow(10, 0.9813 * tpr) +
    (0.274 * ppr * ppr) / Math.pow(10, 0.8157 * tpr);
  return Math.min(Math.max(z, 0.25), 1.15);
};

/** Gas viscosity via Lee-Gonzalez-Eakin (fluidStudioCalculations twin), cp. */
export const gasViscosity = (p, tempF, gasGravity, z) => {
  const tR = tempF + 460;
  const M = 28.97 * gasGravity;
  const K = ((9.4 + 0.02 * M) * Math.pow(tR, 1.5)) / (209 + 19 * M + tR);
  const X = 3.5 + 986 / tR + 0.01 * M;
  const Y = 2.4 - 0.2 * X;
  const rhoG = (1.4935e-3 * p * M) / (z * tR); // g/cm^3
  return 1e-4 * K * Math.exp(X * Math.pow(rhoG, Y));
};

/**
 * Gas PVT table on a pressure grid. Correlation-based unless `table`
 * ([{p, mu, z}], ascending p) is supplied, in which case it is cleaned,
 * sorted and used as given (laboratory data wins over correlations).
 * @returns [{p, z, mu}] starting at p = 0
 */
export const buildGasPvtTable = ({ gasGravity, tempF, pMax = 10000, points = 60, table = null }) => {
  if (Array.isArray(table) && table.length >= 3) {
    const rows = table
      .map((r) => ({ p: num(r.p, NaN), mu: num(r.mu, NaN), z: num(r.z, NaN) }))
      .filter((r) => r.p >= 0 && r.mu > 0 && r.z > 0)
      .sort((a, b) => a.p - b.p);
    if (rows.length >= 3) return rows[0].p === 0 ? rows : [{ ...rows[0], p: 0 }, ...rows];
  }
  const n = Math.max(points, 10);
  const rows = [];
  for (let i = 0; i <= n; i += 1) {
    const p = (pMax * i) / n;
    const z = p > 0 ? gasZFactor(p, tempF, gasGravity) : 1;
    const mu = gasViscosity(Math.max(p, 1e-6), tempF, gasGravity, z);
    rows.push({ p, z, mu });
  }
  return rows;
};

/**
 * Pseudo-pressure transform from a PVT table (trapezoid on 2p/(mu z)).
 * @returns { table: [{p, z, mu, m}], mOfP(p), pOfM(m), cgOf(p) }
 */
export const makePseudoPressure = (pvtRows) => {
  const rows = (pvtRows || []).filter((r) => r.p >= 0 && r.mu > 0 && r.z > 0);
  if (rows.length < 3) return null;
  const f = rows.map((r) => (2 * r.p) / (r.mu * r.z));
  const table = rows.map((r, i) => {
    if (i === 0) return { ...r, m: 0 };
    return null; // filled below
  });
  let acc = 0;
  for (let i = 1; i < rows.length; i += 1) {
    acc += ((f[i - 1] + f[i]) / 2) * (rows[i].p - rows[i - 1].p);
    table[i] = { ...rows[i], m: acc };
  }

  const interp = (xs, ys, x) => {
    if (!(x >= xs[0])) return ys[0];
    if (x >= xs[xs.length - 1]) {
      // linear extrapolation on the last segment
      const i = xs.length - 1;
      const slope = (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i] + slope * (x - xs[i]);
    }
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const w = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + w * (ys[hi] - ys[lo]);
  };

  const ps = table.map((r) => r.p);
  const ms = table.map((r) => r.m);
  const zs = table.map((r) => r.z);
  const mus = table.map((r) => r.mu);

  /** Isothermal gas compressibility 1/p - (dz/dp)/z from the z table. */
  const cgOf = (p) => {
    const pv = num(p, NaN);
    if (!(pv > 0)) return NaN;
    const dp = Math.max(pv * 0.01, 1);
    const z0 = interp(ps, zs, pv);
    const dzdp = (interp(ps, zs, pv + dp) - interp(ps, zs, Math.max(pv - dp, 0))) /
      (dp + Math.min(dp, pv));
    return 1 / pv - dzdp / z0;
  };

  return {
    table,
    mOfP: (p) => interp(ps, ms, num(p, NaN)),
    pOfM: (m) => interp(ms, ps, num(m, NaN)),
    muOf: (p) => interp(ps, mus, num(p, NaN)),
    zOf: (p) => interp(ps, zs, num(p, NaN)),
    cgOf,
  };
};

/**
 * Normalized pseudo-time (Agarwal): ta(t) = (mu ct)_i int_0^t dt'/(mu ct)(p(t'))
 * over a pressure history [{t, p}]. muCtOf(p) returns mu(p)*ct(p).
 * @returns [{t, ta}]
 */
export const normalizedPseudoTime = (history, { muCtOf, muCtInitial }) => {
  const rows = (history || [])
    .map((r) => ({ t: num(r.t, NaN), p: num(r.p, NaN) }))
    .filter((r) => Number.isFinite(r.t) && r.t >= 0 && Number.isFinite(r.p))
    .sort((a, b) => a.t - b.t);
  if (rows.length < 2 || typeof muCtOf !== 'function' || !(muCtInitial > 0)) return [];
  const out = [{ t: rows[0].t, ta: rows[0].t }];
  let acc = rows[0].t; // before the record starts, properties are ~initial
  for (let i = 1; i < rows.length; i += 1) {
    const g0 = muCtInitial / Math.max(muCtOf(rows[i - 1].p), 1e-30);
    const g1 = muCtInitial / Math.max(muCtOf(rows[i].p), 1e-30);
    acc += ((g0 + g1) / 2) * (rows[i].t - rows[i - 1].t);
    out.push({ t: rows[i].t, ta: acc });
  }
  return out;
};

/**
 * Equivalent-liquid adapter: reservoir object that makes the liquid
 * machinery produce gas answers in m(p) space (see file header).
 * muI/ctI are evaluated at initial pressure.
 */
export const gasEquivalentReservoir = ({ phi, rw, h, qg, tempR, muI, ctI }) => ({
  phi,
  rw,
  h,
  q: qg,
  mu: muI,
  ct: ctI,
  B: (GAS.SEMILOG_SLOPE * tempR) / (162.6 * muI),
});

/**
 * Gas MDH (drawdown) in pseudo-pressure space.
 * points: [{t, pwf}] psia; returns { k, kh, skin, m, r2, n } with m in
 * psi^2/cp per cycle. Skin here is the apparent skin s' = s + D qg.
 */
export const gasMdhAnalysis = ({ points, pi, mOfP, ...gasRes }) => {
  if (typeof mOfP !== 'function') return null;
  const reservoir = gasEquivalentReservoir(gasRes);
  return mdhAnalysis({
    points: (points || []).map((p) => ({ t: p.t, pwf: mOfP(p.pwf) })),
    pi: Number.isFinite(num(pi, NaN)) ? mOfP(pi) : undefined,
    ...reservoir,
  });
};

/**
 * Gas Horner (buildup) in pseudo-pressure space. pStar is converted back
 * to pressure via pOfM (reported as pStarPressure).
 */
export const gasHornerAnalysis = ({ points, tp, pwfShutIn, mOfP, pOfM, ...gasRes }) => {
  if (typeof mOfP !== 'function') return null;
  const reservoir = gasEquivalentReservoir(gasRes);
  const result = hornerAnalysis({
    points: (points || []).map((p) => ({ dt: p.dt, pws: mOfP(p.pws) })),
    tp,
    pwfShutIn: mOfP(pwfShutIn),
    ...reservoir,
  });
  if (!result) return null;
  return {
    ...result,
    pStarPressure: typeof pOfM === 'function' ? pOfM(result.pStar) : NaN,
  };
};

/**
 * Rawlins-Schellhardt back-pressure fit: q = C delta^n by least squares
 * on log q vs log delta. points: [{q, delta}], delta > 0, q > 0.
 * @returns { n, C, r2, points, aof(deltaMax) }
 */
export const backPressureFit = (points) => {
  const rows = (points || [])
    .map((r) => ({ q: num(r.q, NaN), delta: num(r.delta, NaN) }))
    .filter((r) => r.q > 0 && r.delta > 0);
  if (rows.length < 2) return null;
  const fit = linearFit(rows.map((r) => Math.log10(r.delta)), rows.map((r) => Math.log10(r.q)));
  if (!fit) return null;
  const n = fit.slope;
  const C = Math.pow(10, fit.intercept);
  return {
    n,
    C,
    r2: fit.r2,
    nOutOfRange: n < 0.5 || n > 1.05,
    aof: (deltaMax) => (deltaMax > 0 ? C * Math.pow(deltaMax, n) : NaN),
  };
};

/**
 * Houpeurt / LIT fit: delta = a q + b q^2 by least squares on
 * delta/q = a + b q. points: [{q, delta}].
 * @returns { a, b, r2, aof(deltaMax) }
 */
export const litFit = (points) => {
  const rows = (points || [])
    .map((r) => ({ q: num(r.q, NaN), delta: num(r.delta, NaN) }))
    .filter((r) => r.q > 0 && r.delta > 0);
  if (rows.length < 2) return null;
  const fit = linearFit(rows.map((r) => r.q), rows.map((r) => r.delta / r.q));
  if (!fit) return null;
  const a = fit.intercept;
  const b = fit.slope;
  return {
    a,
    b,
    r2: fit.r2,
    aof: (deltaMax) => {
      if (!(deltaMax > 0)) return NaN;
      if (!(b > 0)) return a > 0 ? deltaMax / a : NaN;
      const disc = a * a + 4 * b * deltaMax;
      return (-a + Math.sqrt(disc)) / (2 * b);
    },
  };
};

/**
 * Full deliverability analysis of a flow-after-flow (or isochronal) test.
 * points: [{q Mscf/D, pwf psia}]; pr = average reservoir pressure, psia.
 * method 'pressure-squared' uses delta = pr^2 - pwf^2; 'pseudo-pressure'
 * uses delta = m(pr) - m(pwf) and needs mOfP.
 * @returns { method, backPressure: {n, C, aof}, lit: {a, b, aof}, deltaMax }
 */
export const deliverabilityAnalysis = ({ points, pr, method = 'pressure-squared', mOfP, baseP = GAS.BASE_PRESSURE }) => {
  const prv = num(pr, NaN);
  if (!(prv > 0)) return null;
  const usePseudo = method === 'pseudo-pressure' && typeof mOfP === 'function';
  const deltaOf = usePseudo
    ? (pwf) => mOfP(prv) - mOfP(pwf)
    : (pwf) => prv * prv - pwf * pwf;
  const rows = (points || [])
    .map((r) => ({ q: num(r.q, NaN), delta: deltaOf(num(r.pwf, NaN)) }))
    .filter((r) => r.q > 0 && r.delta > 0);
  if (rows.length < 2) return null;
  const deltaMax = deltaOf(baseP);
  const bp = backPressureFit(rows);
  const lit = litFit(rows);
  return {
    method: usePseudo ? 'pseudo-pressure' : 'pressure-squared',
    deltaMax,
    points: rows,
    backPressure: bp ? { n: bp.n, C: bp.C, r2: bp.r2, nOutOfRange: bp.nOutOfRange, aof: bp.aof(deltaMax) } : null,
    lit: lit ? { a: lit.a, b: lit.b, r2: lit.r2, aof: lit.aof(deltaMax) } : null,
  };
};
