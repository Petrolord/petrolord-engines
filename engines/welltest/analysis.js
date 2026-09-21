/**
 * Straight-line (specialized-plot) well test analyses, oilfield units.
 *
 * Semilog radial flow (slightly compressible liquid, infinite-acting):
 *   m = 162.6 q B mu / (k h)                     psi per log10 cycle
 *   MDH drawdown skin:
 *     s = 1.1513 [ (pi - p1hr)/m - log10( k / (phi mu ct rw^2) ) + 3.2275 ]
 *   Horner buildup: pws vs log10((tp+dt)/dt), p* at unit Horner ratio,
 *     s = 1.1513 [ (p1hr - pwf@shutin)/m - log10( k / (phi mu ct rw^2) ) + 3.2275 ]
 *   (p1hr read on the straight line at t or dt = 1 hr.)
 *
 * Radius of investigation: ri = sqrt( k t / (948 phi mu ct) )  ft
 * Skin pressure drop:      dP_skin = 141.2 q B mu s / (k h)    psi
 * Flow efficiency:         FE = (pAvg - pwf - dP_skin) / (pAvg - pwf)
 * Pseudo-steady state Cartesian slope:
 *   m* = 0.23396 q B / (ct Vp)  psi/hr  ->  Vp = 0.23396 q B / (ct m*)  ft^3
 *
 * All fits report r2 and the slope standard error so the UI can show fit
 * quality alongside the reservoir answers.
 */

import { OILFIELD } from './models/modelCatalog.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Ordinary least squares with standard errors. */
export const linearFit = (xs, ys) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
    syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ssr = 0;
  for (let i = 0; i < n; i += 1) {
    const r = ys[i] - (intercept + slope * xs[i]);
    ssr += r * r;
  }
  const sst = syy - (sy * sy) / n;
  const r2 = sst > 0 ? 1 - ssr / sst : 1;
  const sigma2 = n > 2 ? ssr / (n - 2) : 0;
  const seSlope = Math.sqrt((sigma2 * n) / denom);
  return { slope, intercept, r2, seSlope, n };
};

const skinFromSemilog = ({ dp1hr, m, k, phi, mu, ct, rw }) =>
  1.1513 * (dp1hr / m - Math.log10(k / (phi * mu * ct * rw * rw)) + 3.2275);

/**
 * MDH semilog drawdown analysis on the selected radial-flow window.
 * @param {Array<{t:number, pwf:number}>} points flowing pressures, t in hours
 * @returns { m, k, kh, p1hr, skin, r2, n } or null
 */
export const mdhAnalysis = ({ points, pi, q, B, mu, h, phi, ct, rw }) => {
  const usable = (points || []).filter((p) => num(p.t, NaN) > 0 && Number.isFinite(num(p.pwf, NaN)));
  const fit = linearFit(usable.map((p) => Math.log10(p.t)), usable.map((p) => p.pwf));
  if (!fit) return null;
  const m = Math.abs(fit.slope);
  if (!(m > 0)) return null;
  const k = (OILFIELD.SEMILOG_SLOPE * q * B * mu) / (m * h);
  const p1hr = fit.intercept; // line value at log10(t) = 0
  const skin = skinFromSemilog({ dp1hr: num(pi) - p1hr, m, k, phi, mu, ct, rw });
  return { m, k, kh: k * h, p1hr, skin, r2: fit.r2, n: fit.n };
};

/**
 * Horner buildup analysis on the selected radial-flow window.
 * @param {Array<{dt:number, pws:number}>} points shut-in pressures, dt hours
 * @param {number} tp producing time, hours
 * @param {number} pwfShutIn flowing pressure at the instant of shut-in
 * @returns { m, k, kh, pStar, p1hr, skin, r2, n } or null
 */
export const hornerAnalysis = ({ points, tp, pwfShutIn, q, B, mu, h, phi, ct, rw }) => {
  const tpv = num(tp, NaN);
  if (!(tpv > 0)) return null;
  const usable = (points || []).filter((p) => num(p.dt, NaN) > 0 && Number.isFinite(num(p.pws, NaN)));
  const fit = linearFit(
    usable.map((p) => Math.log10((tpv + p.dt) / p.dt)),
    usable.map((p) => p.pws)
  );
  if (!fit) return null;
  const m = Math.abs(fit.slope); // pws falls as Horner ratio grows
  if (!(m > 0)) return null;
  const k = (OILFIELD.SEMILOG_SLOPE * q * B * mu) / (m * h);
  const pStar = fit.intercept; // extrapolation to unit Horner ratio
  const p1hr = fit.intercept + fit.slope * Math.log10(tpv + 1); // line at dt = 1 hr
  const skin = skinFromSemilog({ dp1hr: p1hr - num(pwfShutIn), m, k, phi, mu, ct, rw });
  return { m, k, kh: k * h, pStar, p1hr, skin, r2: fit.r2, n: fit.n };
};

/**
 * Multi-rate (Odeh-Jones) superposition semilog analysis. For a step-rate
 * history the rate-normalized drawdown obeys a straight line in the
 * superposition time function:
 *   (pi - pwf(t)) / qn = m' X(t) + b'
 *   X(t) = sum_j (qj - q(j-1))/qn * log10(t - t(j-1))    over steps before t
 *   m' = 162.6 B mu / (k h)  (slope per unit rate)
 *   s  = 1.1513 [ b'/m' - log10( k / (phi mu ct rw^2) ) + 3.2275 ]
 * qn is the rate of the period containing each point; shut-in points are
 * excluded (that is Horner's job).
 *
 * @param {Array<{t:number, pwf:number}>} points flowing pressures, hours/psi
 * @param {Array<{start:number, q:number}>} steps from rateStepsFromHistory
 * @returns { k, kh, skin, mPrime, r2, n } or null
 */
export const multiRateSemilogAnalysis = ({ points, steps, pi, B, mu, h, phi, ct, rw }) => {
  const piv = num(pi, NaN);
  if (!Number.isFinite(piv) || !Array.isArray(steps) || !steps.length) return null;
  const xs = [];
  const ys = [];
  for (const point of points || []) {
    const t = num(point.t, NaN);
    const pwf = num(point.pwf, NaN);
    if (!(t > 0) || !Number.isFinite(pwf)) continue;
    let qn = 0;
    for (const step of steps) {
      if (step.start < t) qn = step.q;
      else break;
    }
    if (!(qn !== 0)) continue; // shut-in period
    let x = 0;
    let prevQ = 0;
    let valid = true;
    for (const step of steps) {
      if (step.start >= t) break;
      const dq = step.q - prevQ;
      prevQ = step.q;
      if (dq === 0) continue;
      const dt = t - step.start;
      if (!(dt > 0)) { valid = false; break; }
      x += (dq / qn) * Math.log10(dt);
    }
    if (!valid) continue;
    xs.push(x);
    ys.push((piv - pwf) / qn);
  }
  const fit = linearFit(xs, ys);
  if (!fit) return null;
  const mPrime = fit.slope;
  if (!(mPrime > 0)) return null;
  const k = (OILFIELD.SEMILOG_SLOPE * B * mu) / (mPrime * h);
  const skin = 1.1513 * (fit.intercept / mPrime - Math.log10(k / (phi * mu * ct * rw * rw)) + 3.2275);
  return { k, kh: k * h, skin, mPrime, r2: fit.r2, n: fit.n };
};

/** Radius of investigation in ft at elapsed time tHours. */
export const radiusOfInvestigation = ({ k, tHours, phi, mu, ct }) => {
  const arg = (k * tHours) / (OILFIELD.RINV_948 * phi * mu * ct);
  return arg > 0 ? Math.sqrt(arg) : NaN;
};

/** Pressure drop across the skin zone, psi. */
export const skinPressureDrop = ({ q, B, mu, k, h, skin }) =>
  (OILFIELD.PD_FACTOR * q * B * mu * skin) / (k * h);

/** Flow efficiency (fraction of ideal drawdown). */
export const flowEfficiency = ({ pAvg, pwf, dpSkin }) => {
  const total = num(pAvg) - num(pwf);
  if (!(Math.abs(total) > 0)) return NaN;
  return (total - num(dpSkin)) / total;
};

/**
 * Cartesian pseudo-steady-state analysis: pwf vs t straight line.
 * @returns { mStar, poreVolumeFt3, poreVolumeMMbbl, r2, n } or null
 */
export const cartesianPssAnalysis = ({ points, q, B, ct }) => {
  const usable = (points || []).filter(
    (p) => Number.isFinite(num(p.t, NaN)) && Number.isFinite(num(p.pwf, NaN))
  );
  const fit = linearFit(usable.map((p) => p.t), usable.map((p) => p.pwf));
  if (!fit) return null;
  const mStar = Math.abs(fit.slope);
  if (!(mStar > 0)) return null;
  const poreVolumeFt3 = (OILFIELD.PSS_CARTESIAN * q * B) / (ct * mStar);
  return {
    mStar,
    poreVolumeFt3,
    poreVolumeMMbbl: poreVolumeFt3 / OILFIELD.CUBIC_FT_PER_BBL / 1e6,
    r2: fit.r2,
    n: fit.n,
  };
};

/**
 * sqrt(time) linear-flow fit (fracture linear flow). WT1 reports the slope
 * and fit quality; fracture half-length interpretation arrives with the
 * fracture models in WT3.
 * @returns { slope, intercept, r2, n } or null
 */
export const sqrtTimeAnalysis = ({ points }) => {
  const usable = (points || []).filter(
    (p) => num(p.t, NaN) >= 0 && Number.isFinite(num(p.dp, NaN))
  );
  const fit = linearFit(usable.map((p) => Math.sqrt(p.t)), usable.map((p) => p.dp));
  if (!fit) return null;
  return { slope: fit.slope, intercept: fit.intercept, r2: fit.r2, n: fit.n };
};
