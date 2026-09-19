/**
 * Occupational and process safety statistics (HSE H1).
 *
 * Pure functions, no I/O. Every rate is
 *
 *     rate = count x base / exposureHours
 *
 * and the base is ALWAYS supplied by the caller, because the same three
 * letters mean different numbers in different rulebooks: an OSHA/BLS
 * TRIR is per 200,000 hours (100 full-time workers x 40 h x 50 weeks,
 * BLS "How to compute a firm's incidence rate"), an IOGP TRIR or LTIR is
 * per 1,000,000 hours, and a FAR is per 100,000,000 hours (IOGP Safety
 * performance indicators, definitions box). A default base would silently
 * turn one into the other, so a missing base is refused by name.
 *
 * Every function returns either a result object carrying `basis` (the
 * base, the formula and the standard it follows) or `{ error, field }`,
 * where `field` names the offending input. No function returns a
 * non-finite number without saying why.
 *
 * What is in:
 *   incidenceRate, fatalAccidentRate, severityRate, pseRate  single rates
 *   pooledRate, rollingRate                     sum-then-divide aggregation
 *   rateConfidenceInterval                      Garwood exact Poisson CI
 *   compareRates                                conditional exact test
 *   uChart                                      Shewhart u-chart, varying
 *                                               exposure
 *   logGamma, regularizedGammaP/Q,
 *   chiSquareQuantile, chiSquareQuantileUpper   the special functions the
 *                                               interval needs
 *
 * What is NOT in, and why: API RP 754 tier CLASSIFICATION. The threshold
 * quantity tables are licensed content; `pseRate` takes the tier as an
 * input and only does the arithmetic API publishes openly (API Guide to
 * Reporting Process Safety Events, section 3.3).
 *
 * Validation: tools/validation/hse/oracle_safetystats.py recomputes every
 * golden with scipy, independently of this file; the findings, sources
 * and the negative control are in tools/validation/hse/FINDINGS-safetystats.md.
 */

/** Named bases, hours. */
export const RATE_BASES = Object.freeze({
  OSHA_200K: 200000,
  IOGP_1M: 1000000,
  FAR_100M: 100000000,
});

const BASE_LABELS = new Map([
  [200000, 'per 200,000 hours (OSHA/BLS: 100 full-time workers, 40 h x 50 weeks)'],
  [1000000, 'per 1,000,000 hours (IOGP)'],
  [100000000, 'per 100,000,000 hours (FAR, IOGP)'],
]);

const baseLabel = (base) => BASE_LABELS.get(base) || `per ${base} hours`;

/* ------------------------------------------------------------------ */
/* Input checks. Each returns an error object naming the field, or null. */

const refuse = (field, message) => ({ error: `${field} ${message}`, field });

const checkCount = (field, v) => {
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    return refuse(field, 'must be a whole number, zero or more: an event count is not a fraction');
  }
  return null;
};

const checkHours = (field, v) => {
  if (!Number.isFinite(v) || !(v > 0)) {
    return refuse(field, 'must be a finite number of hours above zero: a rate over no exposure is undefined');
  }
  return null;
};

const checkBase = (field, v) => {
  if (v === undefined || v === null) {
    return refuse(field, 'is required: name the base (200,000 for OSHA/BLS, 1,000,000 for IOGP, 100,000,000 for FAR); there is no default');
  }
  if (!Number.isFinite(v) || !(v > 0)) return refuse(field, 'must be a finite number of hours above zero');
  return null;
};

const checkConfidence = (field, v) => {
  if (!Number.isFinite(v) || !(v > 0) || !(v < 1)) {
    return refuse(field, 'must be a fraction strictly between 0 and 1, for example 0.95');
  }
  return null;
};

const firstError = (...checks) => checks.find((c) => c !== null) || null;

/* ------------------------------------------------------------------ */
/* Single rates. */

/**
 * Incidence (frequency) rate: count x base / exposureHours.
 * BLS: (7 x 200,000) / 400,000 = 3.5. Works for any case class (all
 * recordables, DART, lost time); the class is the caller's count.
 */
export const incidenceRate = ({ count, exposureHours, base } = {}) => {
  const bad = firstError(checkCount('count', count), checkHours('exposureHours', exposureHours), checkBase('base', base));
  if (bad) return bad;
  return {
    rate: (count * base) / exposureHours,
    count,
    exposureHours,
    basis: { base, baseLabel: baseLabel(base), formula: 'count x base / exposureHours' },
  };
};

/** Fatal accident rate: fatalities per 100,000,000 hours (IOGP). */
export const fatalAccidentRate = ({ fatalities, exposureHours } = {}) => {
  const bad = firstError(checkCount('fatalities', fatalities), checkHours('exposureHours', exposureHours));
  if (bad) return bad;
  const base = RATE_BASES.FAR_100M;
  return {
    rate: (fatalities * base) / exposureHours,
    fatalities,
    exposureHours,
    basis: { base, baseLabel: baseLabel(base), formula: 'fatalities x 100,000,000 / exposureHours', standard: 'IOGP safety performance indicators, FAR' },
  };
};

/**
 * Severity rate: days lost x base / exposureHours. There is no single
 * standard base here (the OSHA-style convention uses 200,000; ANSI
 * Z16.1 used 1,000,000 and added scheduled time charges for fatalities
 * and permanent disabilities, which this function does NOT add). IOGP's
 * "LWDC severity" is a different quantity, days per case, not per hour.
 * So the base is required and the days are whatever the caller counts.
 */
export const severityRate = ({ daysLost, exposureHours, base } = {}) => {
  let bad = null;
  if (!Number.isFinite(daysLost) || daysLost < 0) bad = refuse('daysLost', 'must be a finite number of days, zero or more');
  bad = bad || firstError(checkHours('exposureHours', exposureHours), checkBase('base', base));
  if (bad) return bad;
  return {
    rate: (daysLost * base) / exposureHours,
    daysLost,
    exposureHours,
    basis: {
      base,
      baseLabel: baseLabel(base),
      formula: 'daysLost x base / exposureHours',
      note: 'no ANSI Z16.1 time charges are added; days are as counted by the caller',
    },
  };
};

/**
 * API RP 754 process safety event rate, as published in the API Guide to
 * Reporting Process Safety Events (2022) section 3.3:
 *   Tier n PSE Rate = (Total Tier n PSE Count / Total Work Hours) x 200,000
 * or x 1,000,000, the choice "consistent with the basis for calculating
 * the Company's occupational injury rate". Only those two bases are
 * permitted. The tier is an INPUT: classification needs API 754's
 * threshold quantity tables, which are not reproduced here.
 */
export const pseRate = ({ tier, pseCount, exposureHours, base } = {}) => {
  if (tier !== 1 && tier !== 2) return refuse('tier', 'must be 1 or 2: classify the events against API RP 754 before rating them');
  const bad = firstError(checkCount('pseCount', pseCount), checkHours('exposureHours', exposureHours), checkBase('base', base));
  if (bad) return bad;
  if (base !== RATE_BASES.OSHA_200K && base !== RATE_BASES.IOGP_1M) {
    return refuse('base', 'must be 200,000 or 1,000,000 for an API RP 754 PSE rate');
  }
  return {
    rate: (pseCount * base) / exposureHours,
    tier,
    pseCount,
    exposureHours,
    basis: { base, baseLabel: baseLabel(base), formula: `Tier ${tier} PSE count x base / total work hours`, standard: 'API RP 754, API Guide to Reporting Process Safety Events section 3.3' },
  };
};

/* ------------------------------------------------------------------ */
/* Aggregation: sum the counts, sum the hours, then divide. */

const checkSeries = (counts, hours) => {
  if (!Array.isArray(counts) || counts.length === 0) return refuse('counts', 'must be a non-empty array of event counts');
  if (!Array.isArray(hours) || hours.length !== counts.length) {
    return refuse('exposureHours', 'must be an array the same length as counts');
  }
  for (let i = 0; i < counts.length; i += 1) {
    const c = checkCount(`counts[${i}]`, counts[i]);
    if (c) return c;
    if (!Number.isFinite(hours[i]) || hours[i] < 0) {
      return refuse(`exposureHours[${i}]`, 'must be a finite number of hours, zero or more');
    }
    if (hours[i] === 0 && counts[i] > 0) {
      return refuse(`exposureHours[${i}]`, 'is zero but counts has events in that period: an event needs someone at work');
    }
  }
  return null;
};

/**
 * Pooled rate over periods or sites: sum(counts) x base / sum(hours).
 * This is how IOGP computes a five-year rolling average and how API 754
 * NOTE 2 aggregates facilities. A period with zero hours contributes
 * nothing. The mean of the per-period rates is returned beside it,
 * labelled, because it is a different number and the difference is a
 * lesson, not a rounding.
 */
export const pooledRate = ({ counts, exposureHours, base } = {}) => {
  const bad = checkSeries(counts, exposureHours) || checkBase('base', base);
  if (bad) return bad;
  const count = counts.reduce((a, b) => a + b, 0);
  const hours = exposureHours.reduce((a, b) => a + b, 0);
  if (!(hours > 0)) return refuse('exposureHours', 'sum to zero: a rate over no exposure is undefined');
  const periodRates = counts.map((c, i) => (exposureHours[i] > 0 ? (c * base) / exposureHours[i] : null));
  const rated = periodRates.filter((r) => r !== null);
  return {
    rate: (count * base) / hours,
    count,
    exposureHours: hours,
    periodRates,
    meanOfPeriodRates: rated.reduce((a, b) => a + b, 0) / rated.length,
    periodsWithoutHours: periodRates.length - rated.length,
    basis: {
      base,
      baseLabel: baseLabel(base),
      formula: 'sum(counts) x base / sum(exposureHours)',
      note: 'meanOfPeriodRates is the unweighted mean of the per-period rates over periods with hours; it is NOT the pooled rate',
    },
  };
};

/**
 * Rolling rate over a trailing window of periods (12 months is the usual
 * choice; IOGP uses five years). One entry per COMPLETE window, each
 * sum-then-divide, with the mean of the monthly rates beside it.
 */
export const rollingRate = ({ counts, exposureHours, base, windowPeriods } = {}) => {
  const bad = checkSeries(counts, exposureHours) || checkBase('base', base);
  if (bad) return bad;
  if (!Number.isInteger(windowPeriods) || windowPeriods < 1) {
    return refuse('windowPeriods', 'must be a whole number of periods, 1 or more (12 for a rolling 12-month rate)');
  }
  if (windowPeriods > counts.length) {
    return refuse('windowPeriods', 'is longer than the series: no complete window exists');
  }
  const windows = [];
  for (let end = windowPeriods - 1; end < counts.length; end += 1) {
    const start = end - windowPeriods + 1;
    const c = counts.slice(start, end + 1);
    const h = exposureHours.slice(start, end + 1);
    const count = c.reduce((a, b) => a + b, 0);
    const hours = h.reduce((a, b) => a + b, 0);
    const monthly = c.map((ci, i) => (h[i] > 0 ? (ci * base) / h[i] : null)).filter((r) => r !== null);
    windows.push({
      startIndex: start,
      endIndex: end,
      count,
      exposureHours: hours,
      rate: hours > 0 ? (count * base) / hours : null,
      meanOfPeriodRates: monthly.length > 0 ? monthly.reduce((a, b) => a + b, 0) / monthly.length : null,
      periodsWithoutHours: windowPeriods - monthly.length,
      reason: hours > 0 ? null : 'no hours in this window: the rate is undefined',
    });
  }
  return {
    windows,
    basis: {
      base,
      baseLabel: baseLabel(base),
      windowPeriods,
      formula: 'sum(counts in window) x base / sum(exposureHours in window)',
      note: 'meanOfPeriodRates is shown for comparison only; a period with no hours has no rate and is left out of that mean',
    },
  };
};

/* ------------------------------------------------------------------ */
/* Special functions. */

// Lanczos approximation, g = 7, n = 9 (Godfrey's coefficients).
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Gamma(x) for x > 0. */
export const logGamma = (x) => {
  if (!Number.isFinite(x) || !(x > 0)) return NaN;
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let s = LANCZOS[0];
  for (let i = 1; i < 9; i += 1) s += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(s);
};

const EPS = 1e-16;
const TINY = 1e-300;

// P(a, x) by its series; accurate for x < a + 1.
const gammaSeries = (a, x) => {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let n = 0; n < 100000; n += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
};

// Q(a, x) by its continued fraction (modified Lentz); accurate for x >= a + 1.
const gammaContinuedFraction = (a, x) => {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 100000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
};

/** Regularised lower incomplete gamma P(a, x), a > 0, x >= 0. */
export const regularizedGammaP = (a, x) => {
  if (!(a > 0) || !Number.isFinite(a) || !(x >= 0)) return NaN;
  if (x === 0) return 0;
  if (x === Infinity) return 1;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
};

/** Regularised upper incomplete gamma Q(a, x) = 1 - P(a, x). */
export const regularizedGammaQ = (a, x) => {
  if (!(a > 0) || !Number.isFinite(a) || !(x >= 0)) return NaN;
  if (x === 0) return 1;
  if (x === Infinity) return 0;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
};

// Standard normal quantile (Acklam), relative error about 1e-9. Used only
// for the starting point of the gamma inversion, which Newton then polishes.
const normalQuantile = (p) => {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

/**
 * x such that P(a, x) = p, given BOTH p and q = 1 - p so that whichever
 * tail is smaller is solved directly (an upper quantile at q = 0.025 is
 * solved on Q, not on 1 - P, which would throw away digits). Start from
 * Wilson-Hilferty (or the small-shape power law), then safeguarded Halley
 * steps on the smaller tail inside a bracket that bisection keeps honest.
 */
const inverseGamma = (a, p, q) => {
  if (p === 0) return 0;
  if (q === 0) return Infinity;
  const useLower = p <= q;
  const target = useLower ? p : q;
  // g(x) is increasing in x in both branches; its derivative is the density.
  const g = (x) => (useLower ? regularizedGammaP(a, x) - p : q - regularizedGammaQ(a, x));
  const lga = logGamma(a);
  let x;
  if (a > 1) {
    const z = useLower ? normalQuantile(p) : -normalQuantile(q);
    const t = 1 / (9 * a);
    x = a * (1 - t + z * Math.sqrt(t)) ** 3;
    if (!(x > 0)) x = a * 1e-3;
  } else {
    const t = 1 - a * (0.253 + a * 0.12);
    x = p < t ? (p / t) ** (1 / a) : 1 - Math.log(1 - (p - t) / (1 - t));
    if (!(x > 0) || !Number.isFinite(x)) x = useLower ? (target * Math.exp(lga) * a) ** (1 / a) : a + 10;
  }
  // bracket
  let lo = 0;
  let hi = Math.max(2 * x, a + 1);
  while (g(hi) < 0) { lo = hi; hi *= 2; }
  if (!(x > lo && x < hi)) x = 0.5 * (lo + hi);
  for (let it = 0; it < 200; it += 1) {
    const f = g(x);
    if (f === 0) return x;
    if (f < 0) lo = x; else hi = x;
    const dens = Math.exp(-x + (a - 1) * Math.log(x) - lga);
    let next;
    if (dens > 0 && Number.isFinite(dens)) {
      const t = f / dens;
      const halley = t / (1 - 0.5 * Math.min(1, t * ((a - 1) / x - 1)));
      next = x - halley;
    }
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - x) <= 4 * Number.EPSILON * next) return next;
    x = next;
    if (hi - lo <= 4 * Number.EPSILON * hi) return x;
  }
  return x;
};

/** Chi-square quantile: x with P(chi2_df <= x) = p. */
export const chiSquareQuantile = (p, df) => {
  if (!(df > 0) || !Number.isFinite(df) || !(p >= 0) || !(p < 1)) return NaN;
  return 2 * inverseGamma(df / 2, p, 1 - p);
};

/** Upper chi-square quantile: x with P(chi2_df > x) = q. Precise for small q. */
export const chiSquareQuantileUpper = (q, df) => {
  if (!(df > 0) || !Number.isFinite(df) || !(q > 0) || !(q <= 1)) return NaN;
  return 2 * inverseGamma(df / 2, 1 - q, q);
};

/* ------------------------------------------------------------------ */
/* Exact Poisson interval. */

/**
 * Garwood (1936) exact Poisson interval for a count, scaled to a rate:
 *   lower = chi2(alpha/2; 2N) / 2       (0 when N = 0)
 *   upper = chi2(1 - alpha/2; 2N + 2) / 2
 * times base / exposureHours. Central: alpha/2 in each tail, so it is
 * conservative (coverage at least the nominal level).
 */
export const rateConfidenceInterval = ({ count, exposureHours, base, confidence } = {}) => {
  const bad = firstError(
    checkCount('count', count), checkHours('exposureHours', exposureHours),
    checkBase('base', base), checkConfidence('confidence', confidence),
  );
  if (bad) return bad;
  const alpha = 1 - confidence;
  // chi2(alpha/2; 2N)/2 is the Gamma(N) quantile; the upper limit is solved
  // on the upper tail at alpha/2 directly.
  const countLower = count === 0 ? 0 : chiSquareQuantile(alpha / 2, 2 * count) / 2;
  const countUpper = chiSquareQuantileUpper(alpha / 2, 2 * count + 2) / 2;
  const scale = base / exposureHours;
  return {
    rate: count * scale,
    lower: countLower * scale,
    upper: countUpper * scale,
    countLower,
    countUpper,
    count,
    exposureHours,
    confidence,
    basis: {
      base,
      baseLabel: baseLabel(base),
      method: 'Garwood (1936) exact Poisson interval, chi-square form: [chi2(alpha/2, 2N)/2, chi2(1-alpha/2, 2N+2)/2] x base / exposureHours',
    },
  };
};

/* ------------------------------------------------------------------ */
/* Comparison of two rates. */

const MAX_COMPARE_EVENTS = 1000000;

// log of each Binomial(n, .) coefficient, once per call
const logChoose = (n) => {
  const lgn = logGamma(n + 1);
  const out = new Float64Array(n + 1);
  for (let k = 0; k <= n; k += 1) out[k] = lgn - logGamma(k + 1) - logGamma(n - k + 1);
  return out;
};

const binomLowerTail = (lc, n, k, p) => {
  // P(X <= k), summed directly
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let s = 0;
  for (let j = 0; j <= k; j += 1) s += Math.exp(lc[j] + j * lp + (n - j) * lq);
  return Math.min(1, s);
};

const binomUpperTail = (lc, n, k, p) => {
  // P(X >= k), summed directly
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let s = 0;
  for (let j = k; j <= n; j += 1) s += Math.exp(lc[j] + j * lp + (n - j) * lq);
  return Math.min(1, s);
};

// root of an increasing (sign = +1) or decreasing (sign = -1) function of p on (0, 1)
const bisectP = (f, sign) => {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 2000; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    if (sign * f(mid) < 0) lo = mid; else hi = mid;
    if (hi - lo <= 2 * Number.EPSILON * lo) break;
  }
  return 0.5 * (lo + hi);
};

/**
 * Compare two Poisson rates by the conditional exact test (Przyborowski
 * and Wilenski 1940): given n = N1 + N2 events, N1 is Binomial(n, p0)
 * under equal rates, p0 = hours1 / (hours1 + hours2).
 *
 * Two-sided p-value: the CENTRAL convention, twice the smaller tail,
 * capped at 1. It is the test the Clopper-Pearson interval inverts, so
 * pValue < 1 - confidence exactly when the rate-ratio interval excludes 1
 * (Fay 2010, R Journal 2(1): 53-58, "central" versus the "minlike"
 * convention of R's binom.test, which can disagree with its own interval).
 *
 * Rate ratio = rate1 / rate2, with interval from the Clopper-Pearson
 * limits of the conditional proportion: RR = p / (1 - p) x hours2 / hours1.
 * The base cancels in a ratio, so none is taken.
 */
export const compareRates = ({ count1, exposureHours1, count2, exposureHours2, confidence } = {}) => {
  const bad = firstError(
    checkCount('count1', count1), checkHours('exposureHours1', exposureHours1),
    checkCount('count2', count2), checkHours('exposureHours2', exposureHours2),
    checkConfidence('confidence', confidence),
  );
  if (bad) return bad;
  const n = count1 + count2;
  if (n === 0) return refuse('count1', 'and count2 are both zero: the conditional test has no events to condition on');
  if (n > MAX_COMPARE_EVENTS) return refuse('count1', `plus count2 exceeds ${MAX_COMPARE_EVENTS}: use a large-sample method`);
  const alpha = 1 - confidence;
  const p0 = exposureHours1 / (exposureHours1 + exposureHours2);
  const lc = logChoose(n);
  const lower = binomLowerTail(lc, n, count1, p0);
  const upper = binomUpperTail(lc, n, count1, p0);
  const pValue = Math.min(1, 2 * Math.min(lower, upper));
  const pLo = count1 === 0 ? 0 : bisectP((p) => binomUpperTail(lc, n, count1, p) - alpha / 2, 1);
  const pHi = count1 === n ? 1 : bisectP((p) => binomLowerTail(lc, n, count1, p) - alpha / 2, -1);
  const hoursRatio = exposureHours2 / exposureHours1;
  const toRatio = (p) => (p / (1 - p)) * hoursRatio;
  return {
    rateRatio: count2 === 0 ? null : (count1 / exposureHours1) / (count2 / exposureHours2),
    rateRatioLower: toRatio(pLo),
    rateRatioUpper: count1 === n ? null : toRatio(pHi),
    upperUnbounded: count1 === n,
    pValue,
    lowerTail: lower,
    upperTail: upper,
    expectedProportion: p0,
    confidence,
    reason: count2 === 0 ? 'count2 is zero: the rate ratio and its upper limit are unbounded' : null,
    basis: {
      method: 'conditional exact binomial test (Przyborowski and Wilenski 1940), central two-sided p-value (twice the smaller tail, capped at 1), Clopper-Pearson rate-ratio interval',
    },
  };
};

/* ------------------------------------------------------------------ */
/* u-chart. */

/**
 * Shewhart u-chart for event rates with varying exposure (Montgomery,
 * Introduction to Statistical Quality Control, the u chart with variable
 * sample size). Exposure units n_i = exposureHours_i / base, so u_i is
 * the period's rate on that base.
 *   centre  ubar = sum(counts) / sum(n_i)
 *   limits  ubar +/- 3 sqrt(ubar / n_i), the lower floored at 0
 * A point signals when it lies STRICTLY outside its limits.
 */
export const uChart = ({ counts, exposureHours, base } = {}) => {
  const bad = checkSeries(counts, exposureHours) || checkBase('base', base);
  if (bad) return bad;
  const zero = exposureHours.findIndex((h) => h === 0);
  if (zero >= 0) {
    return refuse(`exposureHours[${zero}]`, 'is zero: a u-chart point needs exposure; drop periods with no hours before charting');
  }
  const units = exposureHours.map((h) => h / base);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return refuse('counts', 'are all zero: the centre line is zero and every limit has zero width');
  const ubar = total / units.reduce((a, b) => a + b, 0);
  const points = counts.map((c, i) => {
    const u = c / units[i];
    const half = 3 * Math.sqrt(ubar / units[i]);
    const rawLcl = ubar - half;
    const lcl = Math.max(0, rawLcl);
    const ucl = ubar + half;
    let signal = null;
    if (u > ucl) signal = 'above';
    else if (u < lcl) signal = 'below';
    return {
      index: i, count: c, exposureHours: exposureHours[i], exposureUnits: units[i],
      u, lcl, ucl, lclFloored: rawLcl < 0, signal,
    };
  });
  return {
    centre: ubar,
    points,
    outOfControl: points.filter((p) => p.signal !== null).map((p) => p.index),
    basis: {
      base,
      baseLabel: baseLabel(base),
      method: 'u chart, variable sample size (Montgomery): ubar = sum(c) / sum(n), limits ubar +/- 3 sqrt(ubar / n_i), lower floored at 0',
    },
  };
};
