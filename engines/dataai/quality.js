/**
 * Oilfield data quality (Data & AI D1).
 *
 * Pure functions, no I/O. Inputs are plain arrays and objects. Every
 * function returns either a result object or `{ error, field }`, where
 * `field` names the input it refused; nothing returns NaN without saying
 * why. Every flag carries the `rule` that fired and a `reason` sentence,
 * and every result carries its intermediate values (centre, limits,
 * statistics) and a `basis` naming the convention, so a course can print
 * the working.
 *
 * Conventions, stated once (FINDINGS-quality.md has the sources):
 *   missing       null, undefined or NaN. +/-Infinity is NOT missing: it
 *                 is refused as invalid. Outlier tests skip missing values
 *                 and report flags at the ORIGINAL index. Control charts
 *                 refuse missing values (run completeness first).
 *   thresholds    every flag fires STRICTLY beyond its limit (|z| > 3,
 *                 |M| > 3.5, x < lower fence, CUSUM > h, ...). A value
 *                 exactly on a limit is not flagged.
 *   SD            z-scores use the SAMPLE standard deviation (n - 1), as
 *                 NIST/SEMATECH 1.3.5.17 defines the z-score; population
 *                 SD is an option. The largest possible |z| follows the
 *                 chosen SD: (n - 1) / sqrt(n) sample, sqrt(n - 1)
 *                 population.
 *   MAD           raw median absolute deviation, NIST 1.3.5.6. Modified z
 *                 uses 0.6745 (Iglewicz and Hoaglin, as printed in NIST
 *                 1.3.5.17); Hampel uses 1.4826 x MAD (petrophysics
 *                 conditioning semantics, imported).
 *   quantiles     Hyndman and Fan R6 (NIST 7.2.6.2 default, p(N+1)), R7
 *                 (1 + p(N - 1): Excel, R and numpy default) and R8. Tukey
 *                 fences default to R7.
 *   individuals   sigma = MRbar / d2, d2 = 1.128 (n = 2), MR chart upper
 *                 limit D4 x MRbar with D4 = 3.267 (NIST 6.3.2.1 table).
 *   EWMA          EWMA_0 = target; asymptotic limits by default (NIST
 *                 6.3.2.4), exact time-varying limits as an option.
 *   CUSUM         tabular, S_hi(0) = S_lo(0) = 0, NIST 6.3.2.3; k and h
 *                 in data units or in sigma units, `units` is required;
 *                 no reset after a signal (as the NIST table).
 *   Mahalanobis   classical mean and SAMPLE covariance (n - 1); cutoff the
 *                 chi-square (1 - alpha) quantile on p degrees of freedom,
 *                 alpha = 0.025 by default.
 *   Levenshtein   unit cost insert, delete and substitute.
 *   reasons       every figure in a reason string is printed as the
 *                 shortest round-trip decimal (ECMAScript Number to
 *                 String), so it parses back to exactly the numeric field
 *                 it quotes; every figure a reason quotes is also a
 *                 numeric field of the flag or the result.
 *
 * Reused, by import: lib/stats (mean, median, sample and population SD),
 * engines/petrophysics/conditioning.js (despikeHampel decides the Hampel
 * flags), engines/hse/safetyStats.js (chiSquareQuantile, logGamma),
 * lib/linalg/solveDense.js (the Mahalanobis solve).
 *
 * Validation: tools/validation/dataai/oracle_quality.py (stdlib python,
 * written from the published equations) writes
 * test-data/dataai/goldens/quality_cases.json; the NIST/SEMATECH worked
 * examples are published anchors in it. A second witness (numpy, scipy,
 * statsmodels) is pinned in test-data/dataai/pins/quality_pins.json by
 * tools/validation/dataai/pin_quality.py. Findings and the negative
 * control: tools/validation/dataai/FINDINGS-quality.md,
 * negcontrol_quality.sh.
 */

import { mean, median, ss } from '../../lib/stats/stats.js';
import { despikeHampel } from '../petrophysics/conditioning.js';
import { chiSquareQuantile, logGamma } from '../hse/safetyStats.js';
import { solveDense } from '../../lib/linalg/solveDense.js';

/* ------------------------------------------------------------------ */
/* Constants. */

/** Published constants, each with its source. */
export const CONSTANTS = Object.freeze({
  MODIFIED_Z_SCALE: 0.6745, // Iglewicz and Hoaglin (1993), NIST/SEMATECH 1.3.5.17
  MODIFIED_Z_THRESHOLD: 3.5, // same source: |M| > 3.5 labelled a potential outlier
  HAMPEL_MAD_SCALE: 1.4826, // engines/petrophysics/conditioning.js despikeHampel
  D2_N2: 1.128, // NIST/SEMATECH 6.3.2.2, d2 for n = 2
  D4_N2: 3.267, // NIST/SEMATECH 6.3.2.1 table, D4 for n = 2 (D3 = 0)
  TUKEY_K: 1.5, // Tukey inner fence multiplier
});

/**
 * Definitional limits only: bounds a value cannot cross by definition
 * (a fraction, a rate, a positive-scale measurement). They are NOT
 * plausibility ranges for a basin or a tool; the caller supplies those.
 * Each channel is keyed by unit; a different unit is refused, never
 * converted.
 */
export const DEFINITIONAL_LIMITS = Object.freeze({
  fraction: { 'v/v': { min: 0, max: 1, note: 'a fraction lies in [0, 1] (water cut, porosity, saturation, shale volume, net to gross)' } },
  rate: { any: { min: 0, max: Infinity, note: 'a produced or injected volume rate is not negative' } },
  cumulative: { any: { min: 0, max: Infinity, note: 'a cumulative volume is not negative' } },
  gammaRay: { gAPI: { min: 0, max: Infinity, note: 'API gamma ray units are counts on a non-negative scale' } },
  resistivity: { 'ohm.m': { min: 0, max: Infinity, minExclusive: true, note: 'resistivity is positive' } },
  bulkDensity: { 'g/cm3': { min: 0, max: Infinity, minExclusive: true, note: 'density is positive' } },
  sonic: { 'us/ft': { min: 0, max: Infinity, minExclusive: true, note: 'a slowness is positive' }, 'us/m': { min: 0, max: Infinity, minExclusive: true, note: 'a slowness is positive' } },
  caliper: { in: { min: 0, max: Infinity, minExclusive: true, note: 'a hole diameter is positive' }, mm: { min: 0, max: Infinity, minExclusive: true, note: 'a hole diameter is positive' } },
  absolutePressure: { psia: { min: 0, max: Infinity, note: 'an absolute pressure is not negative' }, kPa: { min: 0, max: Infinity, note: 'an absolute pressure is not negative' }, bara: { min: 0, max: Infinity, note: 'an absolute pressure is not negative' } },
  temperature: { degC: { min: -273.15, max: Infinity, note: 'no temperature is below absolute zero' }, degF: { min: -459.67, max: Infinity, note: 'no temperature is below absolute zero' }, K: { min: 0, max: Infinity, note: 'no temperature is below absolute zero' } },
});

/** The dimension names the Data Quality Studio reports, in display order. */
export const DIMENSIONS = Object.freeze(['completeness', 'validity', 'consistency', 'uniqueness', 'plausibility']);

/* ------------------------------------------------------------------ */
/* Helpers. */

const refuse = (field, message) => ({ error: `${field} ${message}`, field });

const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

/**
 * Number text for reason strings: the SHORTEST ROUND-TRIP decimal
 * (ECMAScript Number::toString), so every figure printed in a reason
 * parses back to exactly the number held in the result's fields. No
 * rounding to a number of significant figures: a cumulative of 1338506.2
 * prints as 1338506.2, and a computed statistic prints every digit its
 * float carries (the application rounds for display from the numeric
 * fields). Exponent form below 1e-6 and from 1e21 up, as ECMAScript.
 */
const fmt = (x) => {
  if (x === Infinity) return 'infinity';
  if (x === -Infinity) return 'minus infinity';
  return String(x);
};

const flag = (index, rule, reason, extra = {}) => ({ index, rule, reason, ...extra });

/** Checks an array of numbers that may carry missing values. */
const checkSeries = (field, values, { allowMissing = true, minPresent = 1 } = {}) => {
  if (!Array.isArray(values)) return refuse(field, 'must be an array of numbers');
  let present = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (isMissing(v)) {
      if (!allowMissing) return refuse(`${field}[${i}]`, 'is missing: a control chart needs a complete series, so fill or drop the gap first');
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return refuse(`${field}[${i}]`, 'must be a finite number or missing (null)');
    present += 1;
  }
  if (present < minPresent) return refuse(field, `must hold at least ${minPresent} present values`);
  return null;
};

const presentPairs = (values) => {
  const idx = [];
  const x = [];
  values.forEach((v, i) => { if (!isMissing(v)) { idx.push(i); x.push(v); } });
  return { idx, x };
};

const checkPositive = (field, v) => (Number.isFinite(v) && v > 0 ? null : refuse(field, 'must be a finite number above zero'));

/* ------------------------------------------------------------------ */
/* Completeness. */

/**
 * Null fraction and gap runs. A gap run is a maximal stretch of
 * consecutive missing values; each run is one flag.
 */
export const completeness = ({ values } = {}) => {
  if (!Array.isArray(values) || values.length === 0) return refuse('values', 'must be a non-empty array');
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!isMissing(v) && !(typeof v === 'number' && Number.isFinite(v))) return refuse(`values[${i}]`, 'must be a finite number or missing (null)');
  }
  const n = values.length;
  const gaps = [];
  let start = -1;
  for (let i = 0; i <= n; i += 1) {
    const miss = i < n && isMissing(values[i]);
    if (miss && start < 0) start = i;
    if (!miss && start >= 0) { gaps.push({ start, end: i - 1, length: i - start }); start = -1; }
  }
  const missing = gaps.reduce((a, g) => a + g.length, 0);
  return {
    n,
    missing,
    present: n - missing,
    nullFraction: missing / n,
    completeness: (n - missing) / n,
    gapRuns: gaps,
    longestGap: gaps.reduce((a, g) => Math.max(a, g.length), 0),
    flags: gaps.map((g) => flag(g.start, 'missing-run',
      g.length === 1 ? `sample ${g.start} is missing` : `samples ${g.start} to ${g.end} are missing (${g.length} in a row)`,
      { end: g.end, length: g.length })),
    basis: { missing: 'null, undefined or NaN', formula: 'completeness = present / n' },
  };
};

/**
 * Coverage of an interval [start, end] by an indexed channel. A step
 * between two consecutive PRESENT samples covers the index between them
 * when it is no longer than maxStep; a longer step is a hole. The stretch
 * before the first and after the last present sample is uncovered.
 */
export const coverage = ({ index, values, start, end, maxStep } = {}) => {
  if (!Array.isArray(index) || index.length === 0) return refuse('index', 'must be a non-empty array of numbers');
  if (!Array.isArray(values) || values.length !== index.length) return refuse('values', 'must be an array the same length as index');
  if (!Number.isFinite(start)) return refuse('start', 'must be a finite number');
  if (!Number.isFinite(end) || !(end > start)) return refuse('end', 'must be a finite number above start');
  const bad = checkPositive('maxStep', maxStep);
  if (bad) return bad;
  const pts = [];
  for (let i = 0; i < index.length; i += 1) {
    if (!Number.isFinite(index[i])) return refuse(`index[${i}]`, 'must be a finite number');
    if (i > 0 && !(index[i] > index[i - 1])) return refuse(`index[${i}]`, 'must be strictly increasing: sort and de-duplicate the index first (indexCheck finds the offenders)');
    if (!isMissing(values[i])) {
      if (!Number.isFinite(values[i])) return refuse(`values[${i}]`, 'must be a finite number or missing (null)');
      pts.push(index[i]);
    }
  }
  const covered = [];
  for (let j = 1; j < pts.length; j += 1) {
    if (pts[j] - pts[j - 1] <= maxStep) {
      const a = Math.max(pts[j - 1], start);
      const b = Math.min(pts[j], end);
      if (b > a) {
        const last = covered[covered.length - 1];
        if (last && last[1] === a) last[1] = b; else covered.push([a, b]);
      }
    }
  }
  const coveredLength = covered.reduce((s, [a, b]) => s + (b - a), 0);
  const holes = [];
  let cursor = start;
  covered.forEach(([a, b]) => { if (a > cursor) holes.push([cursor, a]); cursor = b; });
  if (end > cursor) holes.push([cursor, end]);
  return {
    coverage: coveredLength / (end - start),
    coveredLength,
    intervalLength: end - start,
    covered: covered.map(([a, b]) => ({ from: a, to: b })),
    uncovered: holes.map(([a, b]) => ({ from: a, to: b })),
    flags: holes.map(([a, b]) => flag(null, 'coverage-hole', `no data from ${fmt(a)} to ${fmt(b)}`, { from: a, to: b })),
    basis: { maxStep, rule: 'a step between consecutive present samples covers the index between them when it is at most maxStep' },
  };
};

/* ------------------------------------------------------------------ */
/* Validity. */

/**
 * Range rule. Limits come from the caller (min, max) or from
 * DEFINITIONAL_LIMITS by channel and unit. Inclusive bounds unless the
 * limit says minExclusive / maxExclusive.
 */
export const rangeCheck = ({ values, min, max, minExclusive = false, maxExclusive = false, channel, unit } = {}) => {
  const bad = checkSeries('values', values, { minPresent: 0 });
  if (bad) return bad;
  let lim;
  let source;
  if (channel !== undefined) {
    const set = DEFINITIONAL_LIMITS[channel];
    if (!set) return refuse('channel', `must be one of ${Object.keys(DEFINITIONAL_LIMITS).join(', ')}`);
    const units = Object.keys(set);
    const key = units.includes('any') ? 'any' : unit;
    if (!set[key]) return refuse('unit', `must be one of ${units.join(', ')} for channel ${channel}: units are never converted here`);
    lim = { minExclusive: false, maxExclusive: false, ...set[key] };
    source = `definitional limit for ${channel}${key === 'any' ? '' : ` in ${key}`}: ${set[key].note}`;
  } else {
    if (!Number.isFinite(min) && min !== -Infinity) return refuse('min', 'must be a number (or -Infinity for no lower bound) when no channel is named');
    if (!Number.isFinite(max) && max !== Infinity) return refuse('max', 'must be a number (or Infinity for no upper bound) when no channel is named');
    if (!(max >= min)) return refuse('max', 'must be at least min');
    lim = { min, max, minExclusive, maxExclusive };
    source = 'limits supplied by the caller';
  }
  const flags = [];
  let checked = 0;
  values.forEach((v, i) => {
    if (isMissing(v)) return;
    checked += 1;
    const low = lim.minExclusive ? v <= lim.min : v < lim.min;
    const high = lim.maxExclusive ? v >= lim.max : v > lim.max;
    if (low) flags.push(flag(i, 'below-minimum', `value ${fmt(v)} is below the minimum ${fmt(lim.min)}${lim.minExclusive ? ' (the minimum itself is not allowed)' : ''}`, { value: v, limit: lim.min }));
    else if (high) flags.push(flag(i, 'above-maximum', `value ${fmt(v)} is above the maximum ${fmt(lim.max)}${lim.maxExclusive ? ' (the maximum itself is not allowed)' : ''}`, { value: v, limit: lim.max }));
  });
  return {
    min: lim.min, max: lim.max, minExclusive: lim.minExclusive, maxExclusive: lim.maxExclusive,
    checked, failed: flags.length, flags,
    basis: { source, unit: unit ?? null },
  };
};

/**
 * Index checks for a depth or time index: missing entries, duplicates
 * (a value equal to ANY earlier value), reversals (a step against the
 * stated direction) and irregular steps (|step - expectedStep| >
 * stepTolerance, for steps in the right direction). expectedStep defaults
 * to the median of the steps in the stated direction.
 */
export const indexCheck = ({ index, direction = 'increasing', expectedStep, stepTolerance } = {}) => {
  if (!Array.isArray(index) || index.length < 2) return refuse('index', 'must be an array of at least two numbers');
  if (direction !== 'increasing' && direction !== 'decreasing') return refuse('direction', "must be 'increasing' or 'decreasing'");
  for (let i = 0; i < index.length; i += 1) {
    if (!isMissing(index[i]) && !Number.isFinite(index[i])) return refuse(`index[${i}]`, 'must be a finite number or missing (null)');
  }
  const sign = direction === 'increasing' ? 1 : -1;
  const flags = [];
  const seen = new Map();
  let prev = null; // last present index position
  const forwardSteps = [];
  const steps = [];
  index.forEach((v, i) => {
    if (isMissing(v)) { flags.push(flag(i, 'missing-index', `index entry ${i} is missing`)); return; }
    if (seen.has(v)) {
      flags.push(flag(i, 'duplicate-index', `index value ${fmt(v)} repeats entry ${seen.get(v)}`, { value: v, firstIndex: seen.get(v) }));
    } else seen.set(v, i);
    if (prev !== null) {
      const step = v - index[prev];
      steps.push({ i, prev, step });
      if (sign * step > 0) forwardSteps.push(Math.abs(step));
    }
    prev = i;
  });
  let expected = expectedStep;
  if (expected === undefined) {
    if (forwardSteps.length === 0) return refuse('index', `has no step in the ${direction} direction: nothing to infer an expected step from`);
    expected = median(forwardSteps);
  } else {
    const bad = checkPositive('expectedStep', expected);
    if (bad) return bad;
  }
  const tol = stepTolerance === undefined ? 1e-6 * expected : stepTolerance;
  if (!(Number.isFinite(tol) && tol >= 0)) return refuse('stepTolerance', 'must be a finite number, zero or more');
  steps.forEach(({ i, prev: p, step }) => {
    if (sign * step < 0) {
      flags.push(flag(i, 'reversal', `index goes from ${fmt(index[p])} to ${fmt(index[i])}, against the ${direction} direction`, { step, value: index[i], previous: index[p], previousIndex: p }));
    } else if (step !== 0 && Math.abs(Math.abs(step) - expected) > tol) {
      flags.push(flag(i, 'irregular-step', `step ${fmt(Math.abs(step))} from entry ${p} differs from the expected ${fmt(expected)} by more than ${fmt(tol)}`, { step: Math.abs(step), value: index[i], previous: index[p], previousIndex: p }));
    }
  });
  flags.sort((a, b) => a.index - b.index);
  const count = (r) => flags.filter((f) => f.rule === r).length;
  return {
    n: index.length,
    direction,
    expectedStep: expected,
    expectedStepSource: expectedStep === undefined ? 'median of the steps in the stated direction' : 'supplied by the caller',
    stepTolerance: tol,
    missing: count('missing-index'),
    duplicates: count('duplicate-index'),
    reversals: count('reversal'),
    irregularSteps: count('irregular-step'),
    monotonic: count('reversal') === 0 && count('duplicate-index') === 0,
    flags,
    basis: { duplicate: 'equal to any earlier value (exact)', stepTolerance: stepTolerance === undefined ? '1e-6 x expectedStep' : 'supplied by the caller' },
  };
};

/**
 * Rate rules: a negative rate, and a positive rate while the well is shut
 * in. Shut in means status[i] === 'shut-in' or hoursOn[i] === 0.
 */
export const rateCheck = ({ rates, hoursOn, status } = {}) => {
  const bad = checkSeries('rates', rates, { minPresent: 0 });
  if (bad) return bad;
  if (hoursOn !== undefined) {
    if (!Array.isArray(hoursOn) || hoursOn.length !== rates.length) return refuse('hoursOn', 'must be an array the same length as rates');
    for (let i = 0; i < hoursOn.length; i += 1) {
      if (!isMissing(hoursOn[i]) && !(Number.isFinite(hoursOn[i]) && hoursOn[i] >= 0)) return refuse(`hoursOn[${i}]`, 'must be a number of hours, zero or more, or missing');
    }
  }
  if (status !== undefined && (!Array.isArray(status) || status.length !== rates.length)) return refuse('status', 'must be an array the same length as rates');
  const flags = [];
  let checked = 0;
  rates.forEach((q, i) => {
    if (isMissing(q)) return;
    checked += 1;
    const shut = (status && status[i] === 'shut-in') || (hoursOn && hoursOn[i] === 0);
    if (q < 0) flags.push(flag(i, 'negative-rate', `rate ${fmt(q)} is negative`, { value: q }));
    else if (shut && q > 0) {
      const why = status && status[i] === 'shut-in' ? "status is 'shut-in'" : 'hours on is 0';
      flags.push(flag(i, 'rate-while-shut-in', `rate ${fmt(q)} is reported while the well is shut in (${why})`, { value: q }));
    }
  });
  return { checked, failed: flags.length, flags, basis: { shutIn: "status 'shut-in' or hoursOn 0" } };
};

/* ------------------------------------------------------------------ */
/* Consistency. */

/**
 * A cumulative must not decrease. Each value is compared with the last
 * PRESENT value before it; a drop larger than tolerance is flagged.
 */
export const cumulativeCheck = ({ cumulative, tolerance = 0 } = {}) => {
  const bad = checkSeries('cumulative', cumulative, { minPresent: 0 });
  if (bad) return bad;
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) return refuse('tolerance', 'must be a finite number, zero or more');
  const flags = [];
  let last = null;
  cumulative.forEach((v, i) => {
    if (isMissing(v)) return;
    if (last !== null && cumulative[last] - v > tolerance) {
      flags.push(flag(i, 'cumulative-decrease', `cumulative falls from ${fmt(cumulative[last])} at entry ${last} to ${fmt(v)}`, { drop: cumulative[last] - v, value: v, previous: cumulative[last], previousIndex: last }));
    }
    last = i;
  });
  return { failed: flags.length, flags, basis: { tolerance, rule: 'each present value is at least the previous present value minus tolerance' } };
};

/**
 * Water cut: within [0, 1], and, where oil and water rates are both
 * given with a positive liquid rate, equal to water / (oil + water)
 * within tolerance (a liquid-basis water cut).
 */
export const waterCutCheck = ({ waterCut, oil, water, tolerance = 1e-6 } = {}) => {
  if (waterCut === undefined && (oil === undefined || water === undefined)) return refuse('waterCut', 'or both oil and water rates are required');
  const n = waterCut !== undefined ? (Array.isArray(waterCut) ? waterCut.length : -1) : (Array.isArray(oil) ? oil.length : -1);
  if (waterCut !== undefined) { const b = checkSeries('waterCut', waterCut, { minPresent: 0 }); if (b) return b; }
  if (oil !== undefined || water !== undefined) {
    const b = checkSeries('oil', oil, { minPresent: 0 }) || checkSeries('water', water, { minPresent: 0 });
    if (b) return b;
    if (oil.length !== n) return refuse('oil', 'must be the same length as waterCut');
    if (water.length !== n) return refuse('water', 'must be the same length as oil');
  }
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) return refuse('tolerance', 'must be a finite number, zero or more');
  const flags = [];
  const computed = [];
  for (let i = 0; i < n; i += 1) {
    let wcCalc = null;
    if (oil && !isMissing(oil[i]) && !isMissing(water[i]) && oil[i] >= 0 && water[i] >= 0 && oil[i] + water[i] > 0) {
      wcCalc = water[i] / (oil[i] + water[i]);
    }
    computed.push(wcCalc);
    const wc = waterCut ? waterCut[i] : null;
    if (!isMissing(wc) && (wc < 0 || wc > 1)) {
      flags.push(flag(i, 'water-cut-out-of-range', `water cut ${fmt(wc)} is outside [0, 1]`, { value: wc }));
    } else if (!isMissing(wc) && wcCalc !== null && Math.abs(wc - wcCalc) > tolerance) {
      flags.push(flag(i, 'water-cut-mismatch', `water cut ${fmt(wc)} disagrees with water / (oil + water) = ${fmt(wcCalc)}`, { value: wc, computed: wcCalc }));
    }
  }
  return { computed, failed: flags.length, flags, basis: { formula: 'water cut = water / (oil + water), liquid basis', tolerance } };
};

/**
 * Phase sum: the parts (for example oil + water + gas equivalent, or
 * allocated well rates) must add to the total within
 * max(absTolerance, relTolerance x |total|).
 */
export const phaseSumCheck = ({ parts, total, relTolerance = 0.005, absTolerance = 0 } = {}) => {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts) || Object.keys(parts).length === 0) {
    return refuse('parts', 'must be an object of named arrays, for example { oil: [...], water: [...] }');
  }
  const b = checkSeries('total', total, { minPresent: 0 });
  if (b) return b;
  const names = Object.keys(parts);
  for (const k of names) {
    const e = checkSeries(`parts.${k}`, parts[k], { minPresent: 0 });
    if (e) return e;
    if (parts[k].length !== total.length) return refuse(`parts.${k}`, 'must be the same length as total');
  }
  if (!(Number.isFinite(relTolerance) && relTolerance >= 0)) return refuse('relTolerance', 'must be a finite number, zero or more');
  if (!(Number.isFinite(absTolerance) && absTolerance >= 0)) return refuse('absTolerance', 'must be a finite number, zero or more');
  const sums = [];
  const flags = [];
  total.forEach((t, i) => {
    if (isMissing(t) || names.some((k) => isMissing(parts[k][i]))) { sums.push(null); return; }
    const s = names.reduce((a, k) => a + parts[k][i], 0);
    sums.push(s);
    const allowed = Math.max(absTolerance, relTolerance * Math.abs(t));
    if (Math.abs(s - t) > allowed) {
      flags.push(flag(i, 'phase-sum-mismatch', `parts sum to ${fmt(s)} against a total of ${fmt(t)} (allowed difference ${fmt(allowed)})`, { sum: s, total: t, difference: s - t, allowed }));
    }
  });
  return { parts: names, sums, failed: flags.length, flags, basis: { rule: '|sum(parts) - total| <= max(absTolerance, relTolerance x |total|)', relTolerance, absTolerance } };
};

/**
 * Frozen (stuck) value runs: at least minRun consecutive present values
 * each within tolerance of the run's FIRST value. A missing value ends a
 * run.
 */
export const frozenRuns = ({ values, minRun = 5, tolerance = 0 } = {}) => {
  const b = checkSeries('values', values, { minPresent: 0 });
  if (b) return b;
  if (!Number.isInteger(minRun) || minRun < 2) return refuse('minRun', 'must be a whole number, 2 or more');
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) return refuse('tolerance', 'must be a finite number, zero or more');
  const runs = [];
  let s = -1;
  const close = (end) => { if (s >= 0 && end - s + 1 >= minRun) runs.push({ start: s, end, length: end - s + 1, value: values[s] }); };
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (isMissing(v)) { close(i - 1); s = -1; continue; }
    if (s >= 0 && Math.abs(v - values[s]) <= tolerance) continue;
    close(i - 1);
    s = i;
  }
  close(values.length - 1);
  return {
    runs,
    flags: runs.map((r) => flag(r.start, 'frozen-run', `${r.length} values in a row from entry ${r.start} to ${r.end} stay at ${fmt(r.value)}`, { end: r.end, length: r.length, value: r.value })),
    basis: { minRun, tolerance, rule: 'each value within tolerance of the run\'s first value; a missing value ends the run' },
  };
};

/* ------------------------------------------------------------------ */
/* Uniqueness. */

/** Levenshtein edit distance, unit costs, by the two-row dynamic programme. */
export const levenshtein = (a, b) => {
  if (typeof a !== 'string') return refuse('a', 'must be a string');
  if (typeof b !== 'string') return refuse('b', 'must be a string');
  const s = Array.from(a);
  const t = Array.from(b);
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
};

/**
 * Stated identifier normalisation: trim, upper case, drop every character
 * that is not A-Z or 0-9 (spaces, hyphens, underscores, dots, slashes),
 * then, by default, strip leading zeros from each digit group
 * ("Well-007" and "WELL 7" both become "WELL7"). Letters outside A-Z are
 * dropped too, after NFKD removes accents.
 */
export const normalizeIdentifier = (id, { stripLeadingZeros = true } = {}) => {
  if (typeof id !== 'string') return refuse('id', 'must be a string');
  let s = id.normalize('NFKD').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripLeadingZeros) s = s.replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ''));
  return s;
};

const digitsOf = (s) => s.replace(/\D/g, '');

/**
 * Duplicate and near-duplicate identifiers. For every pair i < j:
 *   exact      raw strings equal
 *   normalised equal after normalizeIdentifier
 *   near       Levenshtein distance of the normalised forms in
 *              1..maxDistance, AND (by default) the same digits in the
 *              same order, so WELL-1 and WELL-2 (two real wells) are not
 *              called near-duplicates while WLL-1 and WELL-1 are.
 * Pairs are listed in (i, j) order; a pair is reported under its
 * strongest class only.
 */
export const duplicateIdentifiers = ({ ids, maxDistance = 1, digitsMustMatch = true, stripLeadingZeros = true } = {}) => {
  if (!Array.isArray(ids) || ids.length === 0) return refuse('ids', 'must be a non-empty array of strings');
  for (let i = 0; i < ids.length; i += 1) if (typeof ids[i] !== 'string') return refuse(`ids[${i}]`, 'must be a string');
  if (!Number.isInteger(maxDistance) || maxDistance < 0) return refuse('maxDistance', 'must be a whole number, zero or more');
  const norm = ids.map((s) => normalizeIdentifier(s, { stripLeadingZeros }));
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (ids[i] === ids[j]) {
        pairs.push({ i, j, kind: 'exact', distance: 0, reason: `"${ids[j]}" repeats entry ${i} exactly` });
      } else if (norm[i] === norm[j]) {
        pairs.push({ i, j, kind: 'normalised', distance: 0, reason: `"${ids[i]}" and "${ids[j]}" are the same after normalisation (${norm[i]})` });
      } else if (maxDistance > 0) {
        const d = levenshtein(norm[i], norm[j]);
        if (d <= maxDistance && (!digitsMustMatch || digitsOf(norm[i]) === digitsOf(norm[j]))) {
          pairs.push({ i, j, kind: 'near', distance: d, reason: `"${ids[i]}" and "${ids[j]}" differ by ${d} edit${d === 1 ? '' : 's'} after normalisation (${norm[i]}, ${norm[j]})` });
        }
      }
    }
  }
  const count = (k) => pairs.filter((p) => p.kind === k).length;
  return {
    normalised: norm,
    pairs,
    exact: count('exact'),
    normalisedDuplicates: count('normalised'),
    near: count('near'),
    flags: pairs.map((p) => flag(p.j, `duplicate-${p.kind}`, p.reason, { other: p.i, distance: p.distance })),
    basis: {
      normalisation: 'NFKD, trim, upper case, keep A-Z and 0-9 only' + (stripLeadingZeros ? ', strip leading zeros in each digit group' : ''),
      distance: 'Levenshtein, unit costs',
      maxDistance,
      digitsMustMatch,
    },
  };
};

/* ------------------------------------------------------------------ */
/* Quantiles. */

const QUANTILE_METHODS = new Set(['R6', 'R7', 'R8']);

/**
 * Sample quantile, Hyndman and Fan (1996) methods R6, R7, R8 as NIST
 * 7.2.6.2 states them: set h = p(N + 1) (R6), 1 + p(N - 1) (R7) or
 * p(N + 1/3) + 1/3 (R8), h = k + d; the quantile is
 * Y[k] + d (Y[k+1] - Y[k]) on the 1-based order statistics, clamped to
 * the minimum and maximum.
 */
export const sampleQuantile = (values, p, method = 'R7') => {
  const b = checkSeries('values', values, { minPresent: 1 });
  if (b) return b;
  if (!(Number.isFinite(p) && p >= 0 && p <= 1)) return refuse('p', 'must be a probability between 0 and 1');
  if (!QUANTILE_METHODS.has(method)) return refuse('method', "must be 'R6', 'R7' or 'R8'");
  const y = presentPairs(values).x.sort((a, c) => a - c);
  const n = y.length;
  let h;
  if (method === 'R6') h = p * (n + 1);
  else if (method === 'R7') h = 1 + p * (n - 1);
  else h = p * (n + 1 / 3) + 1 / 3;
  if (h <= 1) return y[0];
  if (h >= n) return y[n - 1];
  const k = Math.floor(h);
  const d = h - k;
  return y[k - 1] + d * (y[k] - y[k - 1]);
};

/* ------------------------------------------------------------------ */
/* Univariate outliers. */

/**
 * z-scores, z_i = (x_i - mean) / s, with the SAMPLE SD by default
 * (NIST 1.3.5.17). Also reports the largest possible |z| for this n and
 * the chosen SD, reached when n - 1 values are equal and one differs:
 * (n - 1) / sqrt(n) with the sample SD (at n = 10 no point can pass
 * |z| > 3), sqrt(n - 1) with the population SD (at n = 10 exactly 3).
 * thresholdReachable is ceiling > threshold (strict, like the flags).
 */
export const zScores = ({ values, threshold = 3, sd = 'sample' } = {}) => {
  const b = checkSeries('values', values, { minPresent: 3 });
  if (b) return b;
  if (sd !== 'sample' && sd !== 'population') return refuse('sd', "must be 'sample' or 'population'");
  const tb = checkPositive('threshold', threshold);
  if (tb) return tb;
  const { idx, x } = presentPairs(values);
  const m = mean(x);
  const s = sd === 'sample' ? ss.sampleStandardDeviation(x) : ss.standardDeviation(x);
  if (!(s > 0)) return refuse('values', 'have zero spread: every present value is the same, so a z-score is undefined');
  const z = values.map(() => null);
  const flags = [];
  x.forEach((v, j) => {
    const zi = (v - m) / s;
    z[idx[j]] = zi;
    if (Math.abs(zi) > threshold) flags.push(flag(idx[j], 'z-score', `value ${fmt(v)} has z = ${fmt(zi)}, beyond the threshold ${fmt(threshold)}`, { value: v, statistic: zi }));
  });
  const n = x.length;
  const bound = sd === 'sample' ? (n - 1) / Math.sqrt(n) : Math.sqrt(n - 1);
  return {
    n, mean: m, sd: s, z,
    maxAbsZ: Math.max(...z.filter((v) => v !== null).map(Math.abs)),
    maxPossibleAbsZ: bound,
    thresholdReachable: bound > threshold,
    threshold,
    flags,
    basis: { sd: sd === 'sample' ? 'sample standard deviation (n - 1)' : 'population standard deviation (n)', rule: `|z| > ${threshold}`, ceiling: sd === 'sample' ? '(n - 1) / sqrt(n), sample SD' : 'sqrt(n - 1), population SD', note: `the largest possible |z| is ${sd === 'sample' ? '(n - 1) / sqrt(n) with the sample SD' : 'sqrt(n - 1) with the population SD'}, reached when n - 1 values are equal` },
  };
};

/**
 * Modified z-scores (Iglewicz and Hoaglin 1993, NIST 1.3.5.17):
 * M_i = 0.6745 (x_i - median) / MAD, MAD = median |x_i - median|.
 * |M| > 3.5 is labelled a potential outlier.
 */
export const modifiedZScores = ({ values, threshold = CONSTANTS.MODIFIED_Z_THRESHOLD } = {}) => {
  const b = checkSeries('values', values, { minPresent: 3 });
  if (b) return b;
  const tb = checkPositive('threshold', threshold);
  if (tb) return tb;
  const { idx, x } = presentPairs(values);
  const med = median(x);
  const mad = median(x.map((v) => Math.abs(v - med)));
  if (!(mad > 0)) return refuse('values', 'have MAD = 0: at least half the present values equal the median, so the modified z-score is undefined');
  const scores = values.map(() => null);
  const flags = [];
  x.forEach((v, j) => {
    const mz = (CONSTANTS.MODIFIED_Z_SCALE * (v - med)) / mad;
    scores[idx[j]] = mz;
    if (Math.abs(mz) > threshold) flags.push(flag(idx[j], 'modified-z', `value ${fmt(v)} has modified z = ${fmt(mz)}, beyond ${fmt(threshold)}`, { value: v, statistic: mz }));
  });
  return {
    n: x.length, median: med, mad, scores, threshold, flags,
    basis: { formula: 'M = 0.6745 (x - median) / MAD', mad: 'median of |x - median| (raw, unscaled)', source: 'Iglewicz and Hoaglin (1993); NIST/SEMATECH e-Handbook 1.3.5.17' },
  };
};

/**
 * Tukey fences: Q1 - k IQR and Q3 + k IQR, k = 1.5 by default (3 for
 * "far out"). Quartiles by sampleQuantile with the stated method.
 */
export const iqrFences = ({ values, k = CONSTANTS.TUKEY_K, method = 'R7' } = {}) => {
  const b = checkSeries('values', values, { minPresent: 3 });
  if (b) return b;
  const kb = checkPositive('k', k);
  if (kb) return kb;
  if (!QUANTILE_METHODS.has(method)) return refuse('method', "must be 'R6', 'R7' or 'R8'");
  const q1 = sampleQuantile(values, 0.25, method);
  const q3 = sampleQuantile(values, 0.75, method);
  const iqr = q3 - q1;
  const lower = q1 - k * iqr;
  const upper = q3 + k * iqr;
  const flags = [];
  values.forEach((v, i) => {
    if (isMissing(v)) return;
    if (v < lower) flags.push(flag(i, 'below-lower-fence', `value ${fmt(v)} is below the lower fence ${fmt(lower)} (Q1 ${fmt(q1)} - ${fmt(k)} x IQR ${fmt(iqr)})`, { value: v, limit: lower }));
    else if (v > upper) flags.push(flag(i, 'above-upper-fence', `value ${fmt(v)} is above the upper fence ${fmt(upper)} (Q3 ${fmt(q3)} + ${fmt(k)} x IQR ${fmt(iqr)})`, { value: v, limit: upper }));
  });
  return {
    q1, q3, iqr, lower, upper, k, method, flags,
    basis: { quantile: `Hyndman and Fan ${method}`, rule: 'flag strictly outside [Q1 - k IQR, Q3 + k IQR]' },
  };
};

/**
 * Hampel identifier over a centred window of 2 halfWindow + 1 samples.
 * The DECISION is engines/petrophysics/conditioning.js despikeHampel
 * (imported): |x - window median| > nSigma x 1.4826 x MAD, strict, a
 * window with fewer than three present samples is not judged, missing
 * values never enter a window. This function adds the working (median,
 * MAD, threshold per sample) and the replacement series.
 */
export const hampel = ({ values, halfWindow, nSigma = 3 } = {}) => {
  const b = checkSeries('values', values, { minPresent: 1 });
  if (b) return b;
  if (!Number.isInteger(halfWindow) || halfWindow < 1) return refuse('halfWindow', 'must be a whole number, 1 or more (the window is 2 x halfWindow + 1 samples)');
  const nb = checkPositive('nSigma', nSigma);
  if (nb) return nb;
  const x = values.map((v) => (isMissing(v) ? NaN : v));
  const out = despikeHampel(x, halfWindow, nSigma);
  const n = x.length;
  const points = [];
  const flags = [];
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(x[i])) { points.push({ index: i, value: null, median: null, mad: null, threshold: null, windowCount: null, judged: false }); continue; }
    const w = [];
    for (let j = Math.max(0, i - halfWindow); j < Math.min(n, i + halfWindow + 1); j += 1) if (!Number.isNaN(x[j])) w.push(x[j]);
    const judged = w.length >= 3;
    const med = judged ? median(w) : null;
    const mad = judged ? median(w.map((v) => Math.abs(v - med))) : null;
    const thr = judged ? nSigma * CONSTANTS.HAMPEL_MAD_SCALE * mad : null;
    points.push({ index: i, value: x[i], median: med, mad, threshold: thr, windowCount: w.length, judged });
    if (out[i] !== x[i]) {
      flags.push(flag(i, 'hampel', `value ${fmt(x[i])} is ${fmt(Math.abs(x[i] - med))} from its window median ${fmt(med)}, beyond ${fmt(nSigma)} x 1.4826 x MAD = ${fmt(thr)}`, { value: x[i], replacement: out[i], median: med, deviation: Math.abs(x[i] - med), threshold: thr }));
    }
  }
  return {
    halfWindow,
    nSigma,
    points,
    cleaned: Array.from(out, (v) => (Number.isNaN(v) ? null : v)),
    flags,
    basis: { halfWindow, nSigma, madScale: CONSTANTS.HAMPEL_MAD_SCALE, rule: '|x - window median| > nSigma x 1.4826 x MAD (strict)', window: `2 x ${halfWindow} + 1 samples, truncated at the ends`, source: 'Hampel (1974); engines/petrophysics/conditioning.js despikeHampel' },
  };
};

/* ------------------------------------------------------------------ */
/* Special functions for Grubbs: regularised incomplete beta and the
   Student t upper quantile. */

// Continued fraction for I_x(a, b) (modified Lentz; Numerical Recipes 6.4).
const betaContinuedFraction = (a, b, x) => {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10000; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
};

/** Regularised incomplete beta I_x(a, b), a, b > 0, 0 <= x <= 1. */
export const regularizedBeta = (x, a, b) => {
  if (!(a > 0) || !(b > 0) || !(x >= 0) || !(x <= 1)) return NaN;
  if (x === 0) return 0;
  if (x === 1) return 1;
  const lbt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(lbt) * betaContinuedFraction(a, b, x)) / a;
  return 1 - (Math.exp(lbt) * betaContinuedFraction(b, a, 1 - x)) / b;
};

/**
 * Student t upper quantile: t with P(T_df > t) = q, 0 < q < 0.5.
 * Uses P(T > t) = I_{df/(df + t^2)}(df/2, 1/2) / 2 and bisects on
 * w = df / (df + t^2) to double precision.
 */
export const studentTUpperQuantile = (q, df) => {
  if (!(df > 0) || !Number.isFinite(df) || !(q > 0) || !(q < 0.5)) return NaN;
  const target = 2 * q;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 2000; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    if (regularizedBeta(mid, df / 2, 0.5) < target) lo = mid; else hi = mid;
  }
  const w = 0.5 * (lo + hi);
  return Math.sqrt((df * (1 - w)) / w);
};

/**
 * Grubbs' test for ONE outlier (NIST/SEMATECH 1.3.5.17.1). G is the
 * largest |Y - mean| / s (two-sided), (max - mean) / s or (mean - min) / s
 * (one-sided); s is the sample SD. Reject when G exceeds
 *   (N - 1) / sqrt(N) sqrt(t^2 / (N - 2 + t^2)),
 * t the upper alpha/(2N) (two-sided) or alpha/N (one-sided) point of t
 * on N - 2 degrees of freedom. Not for several outliers (masking): NIST
 * points to the generalised ESD test for that.
 */
export const grubbsTest = ({ values, alpha = 0.05, side = 'two-sided' } = {}) => {
  const b = checkSeries('values', values, { minPresent: 3 });
  if (b) return b;
  if (!(Number.isFinite(alpha) && alpha > 0 && alpha < 1)) return refuse('alpha', 'must be a significance level strictly between 0 and 1');
  if (!['two-sided', 'max', 'min'].includes(side)) return refuse('side', "must be 'two-sided', 'max' or 'min'");
  const { idx, x } = presentPairs(values);
  const n = x.length;
  const m = mean(x);
  const s = ss.sampleStandardDeviation(x);
  if (!(s > 0)) return refuse('values', 'have zero spread: every present value is the same');
  let best = -1;
  let g = -Infinity;
  x.forEach((v, j) => {
    const dev = side === 'two-sided' ? Math.abs(v - m) : side === 'max' ? v - m : m - v;
    if (dev / s > g) { g = dev / s; best = j; } // lowest index wins a tie
  });
  const tailProb = side === 'two-sided' ? alpha / (2 * n) : alpha / n;
  const t = studentTUpperQuantile(tailProb, n - 2);
  const critical = ((n - 1) / Math.sqrt(n)) * Math.sqrt((t * t) / (n - 2 + t * t));
  const reject = g > critical;
  return {
    n, mean: m, sd: s, statistic: g, tCritical: t, tailProbability: tailProb, critical,
    maxPossible: (n - 1) / Math.sqrt(n),
    suspectIndex: idx[best],
    suspectValue: x[best],
    reject,
    flags: reject ? [flag(idx[best], 'grubbs', `value ${fmt(x[best])} gives G = ${fmt(g)} above the ${side} critical value ${fmt(critical)} at alpha ${fmt(alpha)}`, { value: x[best], statistic: g })] : [],
    basis: { side, alpha, source: 'Grubbs (1969); NIST/SEMATECH e-Handbook 1.3.5.17.1', sd: 'sample standard deviation (n - 1)' },
  };
};

/* ------------------------------------------------------------------ */
/* Multivariate outliers. */

/**
 * Mahalanobis distance of each row from the classical centre:
 * d^2 = (x - mean)' S^-1 (x - mean), S the SAMPLE covariance. A row is
 * flagged when d^2 exceeds the chi-square (1 - alpha) quantile on p
 * degrees of freedom (engines/hse/safetyStats.js chiSquareQuantile).
 * Rows with any missing value are skipped and listed. The classical
 * estimates are themselves pulled by outliers (masking); a robust
 * covariance is out of scope here and says so.
 */
export const mahalanobis = ({ rows, alpha = 0.025 } = {}) => {
  if (!Array.isArray(rows) || rows.length === 0) return refuse('rows', 'must be a non-empty array of numeric rows');
  const p = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (p < 1) return refuse('rows[0]', 'must be an array of at least one number');
  if (!(Number.isFinite(alpha) && alpha > 0 && alpha < 1)) return refuse('alpha', 'must be strictly between 0 and 1');
  const keep = [];
  const skipped = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length !== p) return refuse(`rows[${i}]`, `must hold ${p} values like rows[0]`);
    if (r.some(isMissing)) { skipped.push(i); continue; }
    for (let c = 0; c < p; c += 1) if (!Number.isFinite(r[c])) return refuse(`rows[${i}]`, 'must hold finite numbers or missing (null)');
    keep.push(i);
  }
  const n = keep.length;
  if (n < p + 2) return refuse('rows', `need at least p + 2 = ${p + 2} complete rows for a sample covariance of ${p} variables`);
  const centre = Array.from({ length: p }, (_, c) => mean(keep.map((i) => rows[i][c])));
  const cov = Array.from({ length: p }, () => new Array(p).fill(0));
  keep.forEach((i) => {
    for (let a = 0; a < p; a += 1) for (let c = 0; c < p; c += 1) cov[a][c] += (rows[i][a] - centre[a]) * (rows[i][c] - centre[c]);
  });
  for (let a = 0; a < p; a += 1) for (let c = 0; c < p; c += 1) cov[a][c] /= n - 1;
  const d2 = rows.map(() => null);
  try {
    keep.forEach((i) => {
      const dev = rows[i].map((v, c) => v - centre[c]);
      const sol = solveDense(cov, dev);
      d2[i] = dev.reduce((s, v, c) => s + v * sol[c], 0);
    });
  } catch (e) {
    return refuse('rows', 'have a singular covariance matrix: a variable is constant or one is a linear combination of others');
  }
  const cutoff = chiSquareQuantile(1 - alpha, p);
  const flags = keep.filter((i) => d2[i] > cutoff).map((i) => flag(i, 'mahalanobis',
    `row ${i} has squared distance ${fmt(d2[i])}, beyond the chi-square ${fmt(1 - alpha)} quantile ${fmt(cutoff)} on ${p} degrees of freedom`, { statistic: d2[i] }));
  return {
    n, p, centre, covariance: cov, d2, cutoff, alpha, level: 1 - alpha, skippedRows: skipped, flags,
    basis: { covariance: 'sample covariance (n - 1), classical (not robust)', cutoff: `chi-square quantile at 1 - alpha on p = ${p} degrees of freedom`, rule: 'd^2 > cutoff' },
  };
};

/* ------------------------------------------------------------------ */
/* Time-series control charts. */

const checkChart = (values) => checkSeries('values', values, { allowMissing: false, minPresent: 2 });

/**
 * Shewhart individuals and moving range chart (NIST/SEMATECH 6.3.2.2):
 * MR_i = |x_i - x_{i-1}|, sigma = MRbar / 1.128, limits
 * centre +/- 3 sigma; MR chart upper limit 3.267 MRbar, lower 0 (NIST
 * 6.3.2.1 table, n = 2). centre and mrBar default to the data's own
 * averages; either may be given as a standard or target.
 */
export const individualsChart = ({ values, centre, mrBar } = {}) => {
  const b = checkChart(values);
  if (b) return b;
  if (centre !== undefined && !Number.isFinite(centre)) return refuse('centre', 'must be a finite number when given');
  if (mrBar !== undefined) { const e = checkPositive('mrBar', mrBar); if (e) return e; }
  const mr = [null];
  for (let i = 1; i < values.length; i += 1) mr.push(Math.abs(values[i] - values[i - 1]));
  const cl = centre === undefined ? mean(values) : centre;
  const mrb = mrBar === undefined ? mean(mr.slice(1)) : mrBar;
  if (!(mrb > 0)) return refuse('values', 'have no movement: every moving range is zero, so the limits have zero width');
  const sigma = mrb / CONSTANTS.D2_N2;
  const ucl = cl + 3 * sigma;
  const lcl = cl - 3 * sigma;
  const mrUcl = CONSTANTS.D4_N2 * mrb;
  const flags = [];
  values.forEach((v, i) => {
    if (v > ucl) flags.push(flag(i, 'individuals-above-ucl', `value ${fmt(v)} is above the upper limit ${fmt(ucl)}`, { value: v, limit: ucl }));
    else if (v < lcl) flags.push(flag(i, 'individuals-below-lcl', `value ${fmt(v)} is below the lower limit ${fmt(lcl)}`, { value: v, limit: lcl }));
    if (i > 0 && mr[i] > mrUcl) flags.push(flag(i, 'moving-range-above-ucl', `moving range ${fmt(mr[i])} is above its upper limit ${fmt(mrUcl)}`, { value: mr[i], limit: mrUcl }));
  });
  return {
    centre: cl, movingRanges: mr, mrBar: mrb, sigma, ucl, lcl, mrUcl, mrLcl: 0, flags,
    outOfControl: [...new Set(flags.map((f) => f.index))],
    basis: { d2: CONSTANTS.D2_N2, D4: CONSTANTS.D4_N2, source: 'NIST/SEMATECH e-Handbook 6.3.2.2 (limits) and 6.3.2.1 (D4 table)', rule: 'a point strictly outside its limits' },
  };
};

/**
 * EWMA chart (Roberts 1959; NIST/SEMATECH 6.3.2.4):
 * EWMA_t = lambda x_t + (1 - lambda) EWMA_{t-1}, EWMA_0 = target.
 * Asymptotic limits target +/- L sigma sqrt(lambda / (2 - lambda)), or
 * exact ones that multiply the variance by 1 - (1 - lambda)^(2t).
 * target and sigma come from historical in-control data and are
 * required: the chart does not estimate them from the data it monitors.
 */
export const ewmaChart = ({ values, lambda, target, sigma, L = 3, limits = 'asymptotic' } = {}) => {
  const b = checkChart(values);
  if (b) return b;
  if (!(Number.isFinite(lambda) && lambda > 0 && lambda <= 1)) return refuse('lambda', 'must be in (0, 1]; 0.2 to 0.3 is usual (NIST 6.3.2.4)');
  if (!Number.isFinite(target)) return refuse('target', 'is required: EWMA_0, the historical in-control mean or target');
  const sb = checkPositive('sigma', sigma) || checkPositive('L', L);
  if (sb) return sb;
  if (limits !== 'asymptotic' && limits !== 'exact') return refuse('limits', "must be 'asymptotic' or 'exact'");
  const ewma = [];
  let e = target;
  const factor = Math.sqrt(lambda / (2 - lambda));
  const points = [];
  const flags = [];
  values.forEach((v, i) => {
    e = lambda * v + (1 - lambda) * e;
    ewma.push(e);
    const t = i + 1;
    const f = limits === 'asymptotic' ? factor : factor * Math.sqrt(1 - (1 - lambda) ** (2 * t));
    const ucl = target + L * sigma * f;
    const lcl = target - L * sigma * f;
    points.push({ index: i, value: v, ewma: e, ucl, lcl });
    if (e > ucl) flags.push(flag(i, 'ewma-above-ucl', `EWMA ${fmt(e)} is above the upper limit ${fmt(ucl)}`, { statistic: e, limit: ucl }));
    else if (e < lcl) flags.push(flag(i, 'ewma-below-lcl', `EWMA ${fmt(e)} is below the lower limit ${fmt(lcl)}`, { statistic: e, limit: lcl }));
  });
  return {
    start: target, ewma, sigmaEwma: sigma * factor,
    ucl: target + L * sigma * factor, lcl: target - L * sigma * factor,
    points, flags,
    basis: { lambda, L, limits, source: 'NIST/SEMATECH e-Handbook 6.3.2.4', start: 'EWMA_0 = target', rule: 'EWMA strictly outside its limits' },
  };
};

/**
 * Tabular CUSUM (NIST/SEMATECH 6.3.2.3):
 *   S_hi(i) = max(0, S_hi(i-1) + x_i - target - k)
 *   S_lo(i) = max(0, S_lo(i-1) + target - k - x_i),   S(0) = 0,
 * a signal when either EXCEEDS h. units: 'data' (k, h in the data's
 * units) or 'sigma' (k, h in multiples of sigma, which is then
 * required); the rule of thumb is k = 0.5, h = 4 or 5 sigma. No reset
 * after a signal. The plain cumulative sum of x - target is returned too.
 */
export const cusumChart = ({ values, target, k, h, units, sigma } = {}) => {
  const b = checkChart(values);
  if (b) return b;
  if (!Number.isFinite(target)) return refuse('target', 'is required: the in-control mean');
  if (units !== 'data' && units !== 'sigma') return refuse('units', "is required: 'sigma' (k and h in multiples of sigma, rule of thumb k = 0.5, h = 4 or 5) or 'data' (k and h in the data's own units)");
  if (!(Number.isFinite(k) && k >= 0)) return refuse('k', 'must be a finite number, zero or more');
  const hb = checkPositive('h', h);
  if (hb) return hb;
  let scale = 1;
  if (units === 'sigma') { const e = checkPositive('sigma', sigma); if (e) return e; scale = sigma; }
  const kd = k * scale;
  const hd = h * scale;
  let hi = 0;
  let lo = 0;
  let cum = 0;
  const points = [];
  const flags = [];
  values.forEach((v, i) => {
    hi = Math.max(0, hi + v - target - kd);
    lo = Math.max(0, lo + target - kd - v);
    cum += v - target;
    const up = hi > hd;
    const down = lo > hd;
    points.push({ index: i, value: v, deviation: v - target, sHigh: hi, sLow: lo, cusum: cum, signalHigh: up, signalLow: down });
    if (up) flags.push(flag(i, 'cusum-high', `upper CUSUM ${fmt(hi)} exceeds h = ${fmt(hd)}: the mean has shifted up`, { statistic: hi, limit: hd }));
    if (down) flags.push(flag(i, 'cusum-low', `lower CUSUM ${fmt(lo)} exceeds h = ${fmt(hd)}: the mean has shifted down`, { statistic: lo, limit: hd }));
  });
  const firstHigh = points.findIndex((p) => p.signalHigh);
  const firstLow = points.findIndex((p) => p.signalLow);
  return {
    target, kData: kd, hData: hd, points, flags,
    firstSignalHigh: firstHigh < 0 ? null : firstHigh,
    firstSignalLow: firstLow < 0 ? null : firstLow,
    basis: { units, sigma: units === 'sigma' ? sigma : null, source: 'NIST/SEMATECH e-Handbook 6.3.2.3, tabular form', rule: 'S_hi or S_lo strictly above h; no reset after a signal' },
  };
};

/* ------------------------------------------------------------------ */
/* Scorecard. */

/**
 * Data quality scorecard. Each dimension gives a score in [0, 1], either
 * directly (`score`) or as 1 - failed / checked. The total is the
 * weighted mean, weights normalised by their sum; with no weights every
 * listed dimension weighs the same. The weakest dimension is the lowest
 * score; a tie goes to the dimension listed first.
 */
export const scorecard = ({ dimensions, weights } = {}) => {
  if (!Array.isArray(dimensions) || dimensions.length === 0) return refuse('dimensions', 'must be a non-empty array of { name, score } or { name, checked, failed }');
  const rows = [];
  const names = new Set();
  for (let i = 0; i < dimensions.length; i += 1) {
    const d = dimensions[i] || {};
    if (typeof d.name !== 'string' || d.name === '') return refuse(`dimensions[${i}].name`, 'must be a non-empty string');
    if (names.has(d.name)) return refuse(`dimensions[${i}].name`, `repeats ${d.name}`);
    names.add(d.name);
    let score;
    if (d.score !== undefined) {
      if (!(Number.isFinite(d.score) && d.score >= 0 && d.score <= 1)) return refuse(`dimensions[${i}].score`, 'must be a number in [0, 1]');
      score = d.score;
    } else {
      if (!(Number.isInteger(d.checked) && d.checked > 0)) return refuse(`dimensions[${i}].checked`, 'must be a whole number above zero (or give score directly)');
      if (!(Number.isInteger(d.failed) && d.failed >= 0 && d.failed <= d.checked)) return refuse(`dimensions[${i}].failed`, 'must be a whole number from 0 to checked');
      score = 1 - d.failed / d.checked;
    }
    rows.push({ name: d.name, score, checked: d.checked ?? null, failed: d.failed ?? null });
  }
  let w;
  if (weights === undefined) {
    w = rows.map(() => 1);
  } else {
    if (!weights || typeof weights !== 'object') return refuse('weights', 'must be an object of dimension name to weight');
    for (const key of Object.keys(weights)) if (!names.has(key)) return refuse(`weights.${key}`, 'names no listed dimension');
    w = [];
    for (const r of rows) {
      const v = weights[r.name];
      if (v === undefined) return refuse(`weights.${r.name}`, 'is missing: give every listed dimension a weight, or none for equal weights');
      if (!(Number.isFinite(v) && v >= 0)) return refuse(`weights.${r.name}`, 'must be a finite number, zero or more');
      w.push(v);
    }
  }
  const wsum = w.reduce((a, c) => a + c, 0);
  if (!(wsum > 0)) return refuse('weights', 'sum to zero');
  const out = rows.map((r, i) => ({ ...r, weight: w[i] / wsum, contribution: (w[i] / wsum) * r.score }));
  const total = out.reduce((a, r) => a + r.contribution, 0);
  let weakest = out[0];
  out.forEach((r) => { if (r.score < weakest.score) weakest = r; });
  return {
    total,
    dimensions: out,
    weakest: weakest.name,
    basis: {
      weights: weights === undefined ? 'equal weights over the listed dimensions' : 'caller weights, normalised by their sum',
      score: 'score, or 1 - failed / checked',
      tieBreak: 'the weakest is the lowest score; a tie goes to the dimension listed first',
    },
  };
};
