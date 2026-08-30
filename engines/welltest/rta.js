/**
 * Rate transient analysis engines (WT9): production data (daily rate and
 * flowing pressure) instead of a shut-in transient.
 *
 * Conventions: time in DAYS (production-data convention; the PTA side of the
 * studio stays in hours), q in STB/D (oil) or Mscf/D (gas), pressures psia.
 * Oil analyses run on pressure; gas analyses run on pseudo-pressure m(p)
 * with material-balance pseudo-time.
 *
 * Material-balance time (McCray/Blasingame): te = Q(t)/q(t), the exact
 * superposition time of boundary-dominated flow. During BDF,
 *
 *   dp/q = te / (N ct) + 1/J          (liquid, exact from PSS + MB)
 *
 * so the flowing material balance is a straight line of the rate-normalized
 * drawdown against te: N = 1/(slope ct), J = 1/intercept. For an
 * exponential (constant-pwf) decline the identity is exact at every point,
 * which is the harness gate. Gas replaces dp with dm(p), and te with
 * material-balance pseudo-time
 *
 *   tca = (mu ct)_i / q(t) * int_0^t q / (mu(pbar) ct(pbar)) dtau
 *
 * where pbar(t) comes from the gas material balance p/z = (p/z)_i (1 - Gp/G)
 * inverted on the PVT table; G enters its own definition, so the analysis
 * iterates G -> pbar -> tca -> G until stable (Mattar-Anderson dynamic
 * material balance). From dm/dGp = -2(p/z)_i/(G mu(pbar) cg(pbar)) the BDF
 * line dm/q vs tca has slope 2 (p/z)_i / (G mu_i ct_i), so
 * G = 2 (p/z)_i / (slope mu_i ct_i).
 *
 * Transient linear flow (Wattenbarger): before boundaries, a fractured well
 * shows dp/q linear in sqrt(t) with slope
 *
 *   mL = 4.064 B sqrt(mu / (k phi ct)) / (h xf)   [psi/(STB/D)/sqrt(hr)]
 *
 * so the sqrt-time regression yields the product xf sqrt(k).
 */

const num = (v, fallback = NaN) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const lsqLine = (xs, ys) => {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
  return { slope, intercept, r2, n };
};

/**
 * Clean and sort production rows. Time in days from the start of production.
 * @param {Array<{t, q, pwf}>} rows strings or numbers
 * @returns [{t, q, pwf}] with t > 0, q > 0, finite pwf, ascending t
 */
export const prepareProductionRows = (rows) =>
  (rows || [])
    .map((r) => ({ t: num(r.t), q: num(r.q), pwf: num(r.pwf) }))
    .filter((r) => r.t > 0 && r.q > 0 && Number.isFinite(r.pwf))
    .sort((a, b) => a.t - b.t);

/**
 * Cumulative production by trapezoid (rate assumed to start at q(t1) from
 * t = 0) and material-balance time te = Q/q, days.
 * @returns [{t, q, pwf, Q, te}]
 */
export const materialBalanceTime = (rows) => {
  const out = [];
  let acc = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const prev = i === 0 ? { t: 0, q: rows[0].q } : rows[i - 1];
    acc += ((prev.q + rows[i].q) / 2) * (rows[i].t - prev.t);
    out.push({ ...rows[i], Q: acc, te: acc / rows[i].q });
  }
  return out;
};

/**
 * Rate-normalized drawdown series for the RTA log-log diagnostic:
 * y = (pa(pi) - pa(pwf)) / q against x = te (days). pa is identity for oil
 * and m(p) for gas.
 * @returns [{x, y, t}] positive points, ascending x
 */
export const rateNormalizedSeries = (rowsTe, { pi, paOf = (v) => v }) => {
  const paI = paOf(pi);
  return rowsTe
    .map((r) => ({ x: r.te, y: (paI - paOf(r.pwf)) / r.q, t: r.t }))
    .filter((r) => r.x > 0 && r.y > 0)
    .sort((a, b) => a.x - b.x);
};

/**
 * Oil flowing material balance: regress dp/q against te.
 * @returns { N (STB), J (STB/D/psi), slope, intercept, r2, n, line } or null
 */
export const flowingMaterialBalanceOil = ({ rowsTe, pi, ct }) => {
  if (!(pi > 0) || !(ct > 0)) return null;
  const pts = rowsTe.filter((r) => r.te > 0 && pi - r.pwf > 0);
  if (pts.length < 3) return null;
  const fit = lsqLine(pts.map((r) => r.te), pts.map((r) => (pi - r.pwf) / r.q));
  if (!fit || !(fit.slope > 0) || !(fit.intercept > 0)) return null;
  return {
    ...fit,
    N: 1 / (fit.slope * ct),
    J: 1 / fit.intercept,
    line: pts.map((r) => ({ x: r.te, y: fit.intercept + fit.slope * r.te })),
  };
};

/**
 * Gas flowing material balance (dynamic material balance): iterate
 * G -> pbar(t) via p/z -> material-balance pseudo-time -> regression -> G.
 *
 * @param {object} args
 *   rowsTe: materialBalanceTime output (q Mscf/D, Q Mscf; te unused here)
 *   pi: initial pressure psia
 *   pvt: { mOfP, zOf, muOf, cgOf } from makePseudoPressure
 *   ctI: total compressibility at pi (1/psi)
 * @returns { G (Mscf), J (Mscf/D per psi2/cp), slope, intercept, r2,
 *            iterations, converged, tca: [...], line } or null
 */
export const flowingMaterialBalanceGas = ({ rowsTe, pi, pvt, ctI }) => {
  if (!(pi > 0) || !(ctI > 0) || !pvt) return null;
  const pts = rowsTe.filter((r) => r.q > 0 && r.pwf > 0 && r.pwf < pi);
  if (pts.length < 3) return null;
  const mI = pvt.mOfP(pi);
  const muCtI = pvt.muOf(pi) * ctI;
  const pOverZi = pi / pvt.zOf(pi);

  // invert p/z = target on [1, pi] by bisection (p/z monotone increasing)
  const pOfPz = (target) => {
    if (!(target > 0)) return NaN;
    let lo = 1;
    let hi = pi;
    for (let iter = 0; iter < 60; iter += 1) {
      const mid = (lo + hi) / 2;
      if (mid / pvt.zOf(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  let G = pts[pts.length - 1].Q * 5; // seed: 5x produced-to-date
  let result = null;
  let converged = false;
  let iterations = 0;
  for (let it = 0; it < 25; it += 1) {
    iterations = it + 1;
    // pbar(t) from MB with the current G, then the pseudo-time integral
    let integral = 0;
    let prevT = 0;
    // integrand q(t) (mu ct)_i / (mu ct)(pbar); at t = 0, pbar = pi so the
    // property ratio is 1 and the rate is taken as the first recorded rate
    let prevF = pts[0].q;
    const xs = [];
    const ys = [];
    const tcas = [];
    for (const r of pts) {
      const pbar = pOfPz(pOverZi * Math.max(1 - r.Q / G, 1e-6));
      const f = muCtI / Math.max(pvt.muOf(pbar) * pvt.cgOf(pbar), 1e-30);
      const fNow = r.q * f;
      integral += ((prevF + fNow) / 2) * (r.t - prevT);
      prevT = r.t;
      prevF = fNow;
      const tca = integral / r.q;
      tcas.push(tca);
      xs.push(tca);
      ys.push((mI - pvt.mOfP(r.pwf)) / r.q);
    }
    const fit = lsqLine(xs, ys);
    if (!fit || !(fit.slope > 0) || !(fit.intercept > 0)) return null;
    const gNew = (2 * pOverZi) / (fit.slope * pvt.muOf(pi) * ctI);
    result = {
      ...fit,
      G: gNew,
      J: 1 / fit.intercept,
      tca: tcas,
      line: xs.map((x) => ({ x, y: fit.intercept + fit.slope * x })),
    };
    if (Math.abs(gNew - G) / gNew < 1e-6) {
      converged = true;
      G = gNew;
      break;
    }
    G = gNew;
  }
  return { ...result, iterations, converged };
};

/**
 * Transient linear-flow analysis on rate-normalized drawdown vs sqrt(t):
 * slope -> xf sqrt(k) (Wattenbarger). Time window in days; the 4.064
 * constant is per sqrt(hour), so the slope converts by sqrt(24).
 *
 * @param {object} args
 *   rows: [{t (days), q, pwf}] inside the linear-flow window
 *   pi, B, mu, phi, ct, h: oilfield units (gas: equivalent B and mu_i,
 *     with paOf = m(p))
 *   paOf: analysis-space transform (identity for oil)
 * @returns { slope (per sqrt-day), xfSqrtK (ft sqrt-md), r2, n, line } or null
 */
export const transientLinearAnalysis = ({ rows, pi, B, mu, phi, ct, h, paOf = (v) => v }) => {
  if (!(pi > 0) || !(B > 0) || !(mu > 0) || !(phi > 0) || !(ct > 0) || !(h > 0)) return null;
  const paI = paOf(pi);
  const pts = (rows || [])
    .map((r) => ({ x: Math.sqrt(r.t), y: (paI - paOf(r.pwf)) / r.q }))
    .filter((r) => r.x > 0 && r.y > 0);
  if (pts.length < 3) return null;
  const fit = lsqLine(pts.map((r) => r.x), pts.map((r) => r.y));
  if (!fit || !(fit.slope > 0)) return null;
  const slopePerSqrtHr = fit.slope / Math.sqrt(24);
  const xfSqrtK = (4.064 * B * Math.sqrt(mu / (phi * ct))) / (h * slopePerSqrtHr);
  return {
    ...fit,
    xfSqrtK,
    line: pts.map((r) => ({ x: r.x, y: fit.intercept + fit.slope * r.x })),
  };
};
