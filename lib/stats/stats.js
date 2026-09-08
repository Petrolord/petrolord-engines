// Canonical Monte Carlo sampling primitives and descriptive statistics for
// @petrolord/engines (lib/stats, economics extraction EC0, 2026-09-08).
//
// VENDORED 1:1 from the Suite's src/lib/monteCarlo.js, which is itself the
// sanctioned Monte Carlo implementation (extracted from ReservoirCalc Pro's
// MonteCarloEngine per the Suite's CLAUDE.md / ReservoirEngineering-Module.md
// section 5). The one edit is the dependency: the Suite file imports
// simple-statistics (an npm runtime dependency this package does not carry),
// so the six functions it used are vendored below as `ss`, transcribed from
// simple-statistics 7.8.8 so that every result is BIT-IDENTICAL to the Suite:
// Kahan-compensated `sum`, POPULATION variance and standard deviation
// (divide by n, the documented gotcha), Bessel-corrected sample covariance
// and correlation, and the quantile rule that averages the two middle
// values only when n*p is an integer on an even-length array. The
// anti-drift gate in __tests__/stats.test.js pins those against values
// computed by the real simple-statistics in the Suite.
//
// Every random draw goes through an injectable `rng` (defaults to
// Math.random) so tests can run seeded and reproducible.

// ---- simple-statistics 7.8.8 subset, vendored -------------------------------
function ssSum(x) {
  if (x.length === 0) return 0;
  let sum = x[0];
  let correction = 0;
  let transition;
  if (typeof sum !== 'number') return Number.NaN;
  for (let i = 1; i < x.length; i++) {
    if (typeof x[i] !== 'number') return Number.NaN;
    transition = sum + x[i];
    if (Math.abs(sum) >= Math.abs(x[i])) correction += sum - transition + x[i];
    else correction += x[i] - transition + sum;
    sum = transition;
  }
  return sum + correction;
}
function ssMean(x) {
  if (x.length === 0) throw new Error('mean requires at least one data point');
  return ssSum(x) / x.length;
}
function ssSumNthPowerDeviations(x, n) {
  const meanValue = ssMean(x);
  let sum = 0;
  if (n === 2) {
    for (let i = 0; i < x.length; i++) { const t = x[i] - meanValue; sum += t * t; }
  } else {
    for (let i = 0; i < x.length; i++) sum += Math.pow(x[i] - meanValue, n);
  }
  return sum;
}
function ssVariance(x) {
  if (x.length === 0) throw new Error('variance requires at least one data point');
  return ssSumNthPowerDeviations(x, 2) / x.length;
}
function ssStandardDeviation(x) {
  if (x.length === 1) return 0;
  return Math.sqrt(ssVariance(x));
}
function ssSampleVariance(x) {
  if (x.length < 2) throw new Error('sampleVariance requires at least two data points');
  return ssSumNthPowerDeviations(x, 2) / (x.length - 1);
}
function ssSampleStandardDeviation(x) { return Math.sqrt(ssSampleVariance(x)); }
function ssSampleCovariance(x, y) {
  if (x.length !== y.length) throw new Error('sampleCovariance requires samples with equal lengths');
  if (x.length < 2) throw new Error('sampleCovariance requires at least two data points in each sample');
  const xmean = ssMean(x);
  const ymean = ssMean(y);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += (x[i] - xmean) * (y[i] - ymean);
  return sum / (x.length - 1);
}
function ssSampleCorrelation(x, y) {
  return ssSampleCovariance(x, y) / ssSampleStandardDeviation(x) / ssSampleStandardDeviation(y);
}
function ssQuantileSorted(x, p) {
  const idx = x.length * p;
  if (x.length === 0) throw new Error('quantile requires at least one data point.');
  if (p < 0 || p > 1) throw new Error('quantiles must be between 0 and 1');
  if (p === 1) return x[x.length - 1];
  if (p === 0) return x[0];
  if (idx % 1 !== 0) return x[Math.ceil(idx) - 1];
  if (x.length % 2 === 0) return (x[idx - 1] + x[idx]) / 2;
  return x[idx];
}
// simple-statistics selects with quickselect; a full sort places every
// element where quickselect would, so the values read out are identical.
function ssQuantile(x, p) {
  const copy = x.slice().sort((a, b) => a - b);
  if (Array.isArray(p)) return p.map((q) => ssQuantileSorted(copy, q));
  return ssQuantileSorted(copy, p);
}
function ssMedian(x) { return +ssQuantile(x, 0.5); }

export const ss = {
  sum: ssSum,
  mean: ssMean,
  variance: ssVariance,
  standardDeviation: ssStandardDeviation,
  sampleVariance: ssSampleVariance,
  sampleStandardDeviation: ssSampleStandardDeviation,
  sampleCovariance: ssSampleCovariance,
  sampleCorrelation: ssSampleCorrelation,
  quantile: ssQuantile,
  quantileSorted: ssQuantileSorted,
  median: ssMedian,
};
export const quantile = ssQuantile;
export const mean = ssMean;
export const median = ssMedian;
export const standardDeviation = ssStandardDeviation;

// ---- src/lib/monteCarlo.js, verbatim from here --------------------------------
// Distribution types that carry genuine uncertainty (a "constant" does not).
export const SPREAD_TYPES = new Set(['triangular', 'normal', 'lognormal', 'uniform']);

// Lightweight Cholesky decomposition (lower triangular). Clamps the diagonal
// at 0 so a slightly non-positive-definite correlation matrix degrades
// gracefully instead of producing NaNs.
export function cholesky(matrix) {
  const n = matrix.length;
  const L = Array(n).fill(0).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(matrix[i][i] - sum, 0));
      } else {
        L[i][j] = L[j][j] === 0 ? 0 : (1.0 / L[j][j]) * (matrix[i][j] - sum);
      }
    }
  }
  return L;
}

// Box-Muller standard normal.
export function randomNormal(rng = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Error function — Abramowitz & Stegun 7.1.26 (max abs error 1.5e-7).
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-ax * ax);
  return sign * y;
}

// Standard-normal CDF Φ(x).
export function normalCDF(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Triangular inverse CDF.
export function triInvCDF(u, a, c, b) {
  if (a === b) return a;
  if (u <= (c - a) / (b - a)) return a + Math.sqrt(u * (b - a) * (c - a));
  return b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

// Seeded pseudo-random generator (mulberry32). Returns a function with
// the same contract as Math.random, so it drops into any `rng` slot in
// this module. An economics result that cannot be reproduced cannot be
// defended in a review, so any app whose Monte Carlo output is shown to
// a decision maker should seed it.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fit a triangular distribution to three stated PERCENTILES.
 *
 * People quote P10, P50 and P90. A triangular distribution is defined by
 * its minimum, mode and maximum. Those are not the same thing, and
 * feeding percentiles straight in as min/mode/max is a real error: it
 * declares that nothing can fall below the stated P10 or above the
 * stated P90, when by construction twenty percent of outcomes should.
 * The tails vanish and every downside case is quietly understated.
 *
 * Solve it in the shape-then-scale form instead. Write the quantile
 * function of a triangular in normalised coordinates, where m = (c-a)/(b-a)
 * is the mode's position in the range:
 *
 *   x(u) = a + (b-a) * g(u, m),
 *   g(u, m) = sqrt(u*m)                 for u <= m
 *           = 1 - sqrt((1-u)(1-m))      for u >  m
 *
 * The mode position alone fixes the SHAPE, so the ratio
 * (p50-p10)/(p90-p10) depends on m and nothing else. That ratio is
 * monotone in m, so one bisection on m recovers the shape; the range and
 * the origin then follow in closed form from the P10 and P90.
 *
 * The reachable ratio runs from about 0.382 (mode at the minimum) to
 * about 0.618 (mode at the maximum). A median outside that band cannot be
 * represented by ANY triangular, so the fit is clamped and says so in
 * `exact`, rather than returning a shape that does not honour the inputs.
 *
 * @param {number} p10 tenth percentile
 * @param {number} p50 median
 * @param {number} p90 ninetieth percentile
 * @returns {{min:number, mode:number, max:number, exact:boolean, note:(string|null)}}
 */
export function fitTriangularToPercentiles(p10, p50, p90) {
  const lo = Number(p10);
  const mid = Number(p50);
  const hi = Number(p90);
  if (!Number.isFinite(lo) || !Number.isFinite(mid) || !Number.isFinite(hi)) {
    return { min: lo, mode: mid, max: hi, exact: false, note: 'non-numeric percentiles' };
  }
  if (!(hi > lo)) {
    // Degenerate: no spread was stated, so there is nothing to fit.
    return { min: lo, mode: mid, max: hi, exact: true, note: null };
  }

  const g = (u, m) => (u <= m ? Math.sqrt(u * m) : 1 - Math.sqrt((1 - u) * (1 - m)));
  const ratioAt = (m) => (g(0.5, m) - g(0.1, m)) / (g(0.9, m) - g(0.1, m));

  const target = (mid - lo) / (hi - lo);
  const rMin = ratioAt(0);
  const rMax = ratioAt(1);
  let exact = true;
  let note = null;
  let clamped = target;
  if (target <= rMin) {
    clamped = rMin;
    exact = false;
    note = 'the stated median sits too near the P10 for any triangular to pass through all three points; the fit uses the most left-skewed triangular there is (mode at the minimum)';
  } else if (target >= rMax) {
    clamped = rMax;
    exact = false;
    note = 'the stated median sits too near the P90 for any triangular to pass through all three points; the fit uses the most right-skewed triangular there is (mode at the maximum)';
  }

  // ratioAt is monotone increasing in m, so bisection is safe.
  let mLo = 0;
  let mHi = 1;
  for (let i = 0; i < 200; i += 1) {
    const m = (mLo + mHi) / 2;
    if (ratioAt(m) < clamped) mLo = m; else mHi = m;
  }
  const m = (mLo + mHi) / 2;

  const range = (hi - lo) / (g(0.9, m) - g(0.1, m));
  const min = lo - range * g(0.1, m);
  const max = min + range;
  const mode = min + m * range;
  return { min, mode, max, exact, note };
}

// Does this input carry real uncertainty (vs. a constant / degenerate range)?
export function isVariable(dist) {
  if (!dist || !SPREAD_TYPES.has(dist.type)) return false;
  if (dist.type === 'triangular' || dist.type === 'uniform') {
    return Number(dist.max) > Number(dist.min);
  }
  return Number(dist.stdDev) > 0; // normal / lognormal
}

// Deterministic representative value (used for non-varying params and fallbacks).
export function representativeValue(dist) {
  if (!dist) return undefined;
  switch (dist.type) {
    case 'triangular': return Number(dist.mode);
    case 'uniform': return (Number(dist.min) + Number(dist.max)) / 2;
    case 'normal':
    case 'lognormal': return Number(dist.mean);
    case 'constant': return parseFloat(dist.value);
    default: {
      const v = dist.value ?? dist.mode ?? dist.mean;
      return v == null ? undefined : Number(v);
    }
  }
}

// Map a correlated standard-normal variate x to a value from the marginal
// distribution (the Gaussian-copula transform). For normal/lognormal
// marginals x IS the standard-normal quantile, so no Φ⁻¹ is needed; for
// triangular/uniform we push x through Φ then the marginal inverse-CDF.
export function marginalValue(dist, x) {
  switch (dist.type) {
    case 'normal':
      return Number(dist.mean) + Number(dist.stdDev) * x;
    case 'lognormal': {
      const m = Number(dist.mean);
      const sd = Number(dist.stdDev);
      const m2 = m * m;
      const sd2 = sd * sd;
      const mu = Math.log(m2 / Math.sqrt(m2 + sd2));
      const sigma = Math.sqrt(Math.log(1 + sd2 / m2));
      return Math.exp(mu + sigma * x);
    }
    case 'triangular':
      return triInvCDF(normalCDF(x), Number(dist.min), Number(dist.mode), Number(dist.max));
    case 'uniform':
      return Number(dist.min) + normalCDF(x) * (Number(dist.max) - Number(dist.min));
    default:
      return representativeValue(dist);
  }
}

/**
 * Build a correlated sampler over named distributions.
 *
 *   createCorrelatedSampler({
 *     inputs,        // { key: dist } — dist per the marginal shapes above
 *     paramOrder,    // string[] — which keys may vary, in a stable order
 *     correlations,  // optional [{ a, b, rho }] between varying keys
 *     rng,           // optional uniform RNG (defaults to Math.random)
 *   })
 *
 * Returns { varKeys, sample } where varKeys is the subset of paramOrder with
 * genuine spread and sample() draws one realization:
 *   { values: { key: number }, truncated: string[] }
 * `truncated` lists normal/lognormal keys whose draw fell outside the
 * optional finite dist.min / dist.max truncation bounds (the caller decides
 * whether to reject the realization).
 */
export function createCorrelatedSampler({ inputs, paramOrder, correlations = [], rng = Math.random }) {
  const varKeys = paramOrder.filter((p) => isVariable(inputs[p]));
  const n = varKeys.length;

  const C = Array(n).fill(0).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) C[i][i] = 1.0;
  const setCorr = (a, b, rho) => {
    const ia = varKeys.indexOf(a);
    const ib = varKeys.indexOf(b);
    if (ia >= 0 && ib >= 0 && ia !== ib) {
      C[ia][ib] = rho;
      C[ib][ia] = rho;
    }
  };
  correlations.forEach(({ a, b, rho }) => {
    if (Number.isFinite(rho) && rho > -1 && rho < 1) setCorr(a, b, rho);
  });
  const L = cholesky(C);

  const sample = () => {
    const Z = Array.from({ length: n }, () => randomNormal(rng));
    const values = {};
    const truncated = [];
    for (let r = 0; r < n; r++) {
      let x = 0;
      for (let c = 0; c <= r; c++) x += L[r][c] * Z[c];
      const key = varKeys[r];
      const dist = inputs[key];
      const val = marginalValue(dist, x);
      if (dist.type === 'normal' || dist.type === 'lognormal') {
        const lo = Number(dist.min);
        const hi = Number(dist.max);
        if ((Number.isFinite(lo) && val < lo) || (Number.isFinite(hi) && val > hi)) {
          truncated.push(key);
        }
      }
      values[key] = val;
    }
    return { values, truncated };
  };

  return { varKeys, sample };
}

// Percentile summary with CDF points. Petroleum convention: P90 is the low
// case (10th percentile of the sorted values), P10 the high case.
export function basicStats(data) {
  if (!data || data.length === 0) return {};
  const validData = [...data].sort((a, b) => a - b);

  const getP = (p) => validData[Math.min(Math.floor(p * validData.length), validData.length - 1)];

  const cdfPoints = [];
  const step = Math.max(1, Math.floor(validData.length / 100));
  for (let i = 0; i < validData.length; i += step) {
    cdfPoints.push({ x: validData[i], y: (i / validData.length) * 100 });
  }
  cdfPoints.push({ x: validData[validData.length - 1], y: 100 });

  return {
    p90: getP(0.1),
    p50: getP(0.5),
    p10: getP(0.9),
    mean: ss.mean(validData),
    min: validData[0],
    max: validData[validData.length - 1],
    stdDev: ss.standardDeviation(validData),
    cdf: cdfPoints,
  };
}

// Ranks with average ranks for ties: [1, 2, 2, 3] -> [1, 2.5, 2.5, 4].
// (simple-statistics' sampleRankCorrelation does NOT average ties, which
// biases Spearman on tied data; this is the standard tie treatment.)
export function rankArray(values) {
  const n = values.length;
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[order[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

// Spearman rank correlation (Pearson on average ranks). Returns NaN when
// either series is constant.
export function spearman(x, y) {
  if (!x || !y || x.length !== y.length || x.length < 2) return NaN;
  const rx = rankArray(x);
  const ry = rankArray(y);
  if (ss.standardDeviation(rx) === 0 || ss.standardDeviation(ry) === 0) return NaN;
  return ss.sampleCorrelation(rx, ry);
}

/**
 * Rank-correlation sensitivity of an output against sampled inputs.
 *
 *   rankCorrelationSensitivity(inputsByKey, outputs)
 *     inputsByKey: { key: number[] } — one series per sampled parameter
 *     outputs:     number[]          — the target output, same length
 *
 * Returns [{ parameter, rho, contribution }] sorted by |rho| descending,
 * where contribution normalizes rho² across parameters to sum to 100.
 */
export function rankCorrelationSensitivity(inputsByKey, outputs) {
  if (!outputs || outputs.length < 2) return [];
  const entries = [];
  let totalRho2 = 0;
  Object.entries(inputsByKey).forEach(([parameter, series]) => {
    const rho = spearman(series, outputs);
    if (Number.isFinite(rho)) {
      entries.push({ parameter, rho });
      totalRho2 += rho * rho;
    }
  });
  if (totalRho2 === 0) return entries.map((e) => ({ ...e, contribution: 0 }));
  return entries
    .map((e) => ({ ...e, contribution: ((e.rho * e.rho) / totalRho2) * 100 }))
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
}

// Pearson variance decomposition over MC samples (ReservoirCalc Pro's
// original sensitivity measure; kept for its tornado display).
// samples: [{ targetVol, inputs: { key: value } }]
export function varianceDecomposition(samples) {
  if (!samples || samples.length === 0) return [];
  // Derive the parameter set from what was actually sampled, so structural runs
  // (owc/goc/grvFactor) and analytic runs (area/thickness) both decompose correctly.
  const parameters = Object.keys(samples[0].inputs || {});
  const results = [];

  const outputs = samples.map((s) => s.targetVol);
  const varOut = ss.variance(outputs);
  if (varOut === 0) return [];

  let totalR2 = 0;
  parameters.forEach((param) => {
    const inputs = samples.map((s) => s.inputs[param]);
    if (ss.standardDeviation(inputs) > 0) {
      const r = ss.sampleCorrelation(inputs, outputs);
      const r2 = r * r;
      totalR2 += r2;
      results.push({ parameter: param, r2, r });
    }
  });
  if (totalR2 === 0) return [];

  return results.map((r) => ({
    parameter: r.parameter,
    contribution: (r.r2 / totalR2) * 100,
    impactDirection: r.r > 0 ? 1 : -1,
  })).sort((a, b) => b.contribution - a.contribution);
}

// Conditional-swing tornado over MC samples: for each sampled input, the
// median output when that input sits in its bottom vs top `fraction` of
// draws. This is the classic symmetric tornado (bars spanning low→high
// around the overall P50), derived from the SAME realizations as the run —
// no re-simulation, so it honours correlations exactly as sampled.
// samples: [{ targetVol, inputs: { key: value } }]
// Returns [{ parameter, base, low, high, lowInputVol, highInputVol }] sorted
// by swing width (widest first). `low`/`high` are output volumes;
// lowInputVol/highInputVol record which INPUT end produced which output so
// callers can phrase direction (e.g. Sw low → volume high).
export function tornadoSwings(samples, fraction = 0.1) {
  if (!samples || samples.length < 30) return [];
  const outputs = samples.map((s) => s.targetVol);
  const base = ss.median(outputs);
  const parameters = Object.keys(samples[0].inputs || {});
  const n = samples.length;
  const k = Math.max(15, Math.floor(n * fraction));
  const swings = [];

  parameters.forEach((param) => {
    const vals = samples.map((s) => s.inputs[param]);
    if (!vals.every(Number.isFinite) || ss.standardDeviation(vals) === 0) return;
    const sorted = [...samples].sort((a, b) => a.inputs[param] - b.inputs[param]);
    const lowInputVol = ss.median(sorted.slice(0, k).map((s) => s.targetVol));
    const highInputVol = ss.median(sorted.slice(n - k).map((s) => s.targetVol));
    swings.push({
      parameter: param,
      base,
      low: Math.min(lowInputVol, highInputVol),
      high: Math.max(lowInputVol, highInputVol),
      lowInputVol,
      highInputVol,
    });
  });

  return swings.sort((a, b) => (b.high - b.low) - (a.high - a.low));
}
