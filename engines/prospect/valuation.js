// Prospect valuation (Risked Reserves Valuation senior test T1,
// 2026-09-26). Given a prospect's geological chance of success Pg and its
// success-case volumes as P90 / P50 / P10 (petroleum convention: P90 is
// the low case, exceeded with 90% probability), this module answers the
// questions an exploration committee asks after the geologist's risking:
//
//   - the success-case volume distribution: a lognormal fitted to P90 and
//     P10 (ln P10 - ln P90 = 2 z90 sigma, z90 = 1.2815515655446004), its
//     mean and any percentile; Swanson's rule (0.3 P90 + 0.4 P50 +
//     0.3 P10) alongside as the field check;
//   - the commercial chance: Pc = Pg x P(V >= MEFS), the chance the well
//     finds at least the minimum economic field size;
//   - the expected monetary value AFTER the exploration well:
//       EMV = Pg x [ u x E[V ; V >= MEFS] - D x P(V >= MEFS) ] - W
//     with u the NPV per barrel of a developed discovery ($/bbl), D the
//     development cost of a commercial discovery ($MM), W the exploration
//     well cost ($MM, spent in every outcome), volumes in MMbbl, and
//     E[V ; V >= m] = mean x Phi(sigma - z_m), z_m = (ln m - mu) / sigma,
//     the lognormal partial expectation;
//   - the break-even Pg at which EMV = 0;
//   - the risked expectation curve P(V >= x) = Pg x (1 - Phi(z_x));
//   - a portfolio of independent prospects: summed risked mean and EMV,
//     expected commercial discoveries, chance of at least one.
//
// Pure, closed form, no Monte Carlo. Validated against
// tools/validation/prospect/oracle_valuation.py.

export const Z90 = 1.2815515655446004;

/**
 * erfc to near machine precision: the Taylor series of erf for |x| <= 2.5
 * (about 40 terms; the largest term is ~e^6, so under 1e-13 is lost), a
 * Lentz continued fraction for erfc beyond. A polynomial fit with 1e-7
 * error was not enough: EMV multiplies a chance by hundreds of $MM.
 */
function erfc(x) {
  const ax = Math.abs(x);
  if (ax <= 2.5) {
    let term = ax; let sum = ax;
    for (let n = 1; n < 200; n++) {
      term *= -(ax * ax) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    const erf = (2 / Math.sqrt(Math.PI)) * sum;
    return x >= 0 ? 1 - erf : 1 + erf;
  }
  // erfc(ax) = exp(-ax^2)/sqrt(pi) * 1/(ax + 1/2/(ax + 1/(ax + 3/2/(ax + ...)))) via Lentz
  const tiny = 1e-300;
  let f = ax; let C = ax; let D = 0;
  for (let n = 1; n < 500; n++) {
    const an = n / 2;
    D = ax + an * D; D = D === 0 ? tiny : D; D = 1 / D;
    C = ax + an / C; C = C === 0 ? tiny : C;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  const v = Math.exp(-ax * ax) / (Math.sqrt(Math.PI) * f);
  return x >= 0 ? v : 2 - v;
}

/** Standard normal CDF. */
export function normCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Inverse standard normal (Acklam's algorithm, relative error < 1.2e-9). */
export function normInv(p) {
  if (!(p > 0 && p < 1)) throw new Error('A probability must be strictly between 0 and 1.');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425; const hi = 1 - lo;
  let q; let r;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Lognormal through P90 (low) and P10 (high).
 * @returns {{mu:number, sigma:number, mean:number, p50:number, percentile:(exceedance:number)=>number}}
 */
export function lognormalFromP90P10(p90, p10) {
  if (!(p90 > 0 && p10 > p90)) throw new Error('Volumes need 0 < P90 < P10 (P90 is the low case).');
  const sigma = (Math.log(p10) - Math.log(p90)) / (2 * Z90);
  const mu = (Math.log(p10) + Math.log(p90)) / 2;
  const mean = Math.exp(mu + (sigma * sigma) / 2);
  const percentile = (exceed) => Math.exp(mu + sigma * normInv(1 - exceed));
  return { mu, sigma, mean, p50: Math.exp(mu), percentile };
}

/** Swanson's mean: 0.3 P90 + 0.4 P50 + 0.3 P10. */
export const swansonMean = (p90, p50, p10) => 0.3 * p90 + 0.4 * p50 + 0.3 * p10;

/** P(V >= x) of a lognormal. */
export const exceedance = (ln, x) => (x > 0 ? 1 - normCdf((Math.log(x) - ln.mu) / ln.sigma) : 1);

/** E[V ; V >= m], the partial expectation above m. */
export const partialMeanAbove = (ln, m) => (m > 0 ? ln.mean * normCdf(ln.sigma - (Math.log(m) - ln.mu) / ln.sigma) : ln.mean);

/**
 * Value one prospect.
 * @param {{pg:number, p90:number, p50?:number, p10:number, mefs?:number,
 *   unitValue?:number, devCost?:number, wellCost?:number}} p volumes in MMbbl,
 *   unitValue in $/bbl of developed volume, costs in $MM
 */
export function valueProspect(p) {
  const pg = Number(p.pg);
  if (!(pg >= 0 && pg <= 1)) throw new Error('Pg must be between 0 and 1.');
  const ln = lognormalFromP90P10(Number(p.p90), Number(p.p10));
  const mefs = Number(p.mefs) || 0;
  const u = Number(p.unitValue) || 0;
  const D = Number(p.devCost) || 0;
  const W = Number(p.wellCost) || 0;
  const pComm = exceedance(ln, mefs);
  const partial = partialMeanAbove(ln, mefs);
  const pc = pg * pComm;
  const valueIfDiscovery = u * partial - D * pComm; // $MM, expectation over success cases
  const emv = pg * valueIfDiscovery - W;
  const breakEvenPg = valueIfDiscovery > 0 ? W / valueIfDiscovery : null;
  return {
    pg, pc, pCommercialGivenSuccess: pComm,
    successCase: { p90: Number(p.p90), p50: Number.isFinite(Number(p.p50)) && p.p50 !== undefined && p.p50 !== null && p.p50 !== '' ? Number(p.p50) : ln.p50, p10: Number(p.p10), mean: ln.mean, fittedP50: ln.p50, swansonMean: p.p50 != null && p.p50 !== '' ? swansonMean(Number(p.p90), Number(p.p50), Number(p.p10)) : null },
    riskedMean: pg * ln.mean,
    meanIfCommercial: pComm > 0 ? partial / pComm : null,
    npvIfCommercial: pComm > 0 ? u * (partial / pComm) - D : null,
    emv,
    breakEvenPg: breakEvenPg !== null && breakEvenPg <= 1 ? breakEvenPg : null,
    lognormal: { mu: ln.mu, sigma: ln.sigma },
  };
}

/** Risked expectation curve: [{volume, exceedance}] from x = low to high. */
export function expectationCurve(p, { points = 60 } = {}) {
  const ln = lognormalFromP90P10(Number(p.p90), Number(p.p10));
  const lo = ln.percentile(0.99);
  const hi = ln.percentile(0.01);
  const out = [];
  for (let k = 0; k < points; k++) {
    const x = lo * Math.exp((k / (points - 1)) * Math.log(hi / lo));
    out.push({ volume: x, exceedance: Number(p.pg) * exceedance(ln, x) });
  }
  return out;
}

/** Portfolio of independent prospects (from valueProspect results). */
export function valuePortfolio(valued) {
  const n = valued.length;
  return {
    count: n,
    riskedMean: valued.reduce((s, v) => s + v.riskedMean, 0),
    emv: valued.reduce((s, v) => s + v.emv, 0),
    expectedCommercial: valued.reduce((s, v) => s + v.pc, 0),
    pAtLeastOneCommercial: n ? 1 - valued.reduce((s, v) => s * (1 - v.pc), 1) : 0,
  };
}
