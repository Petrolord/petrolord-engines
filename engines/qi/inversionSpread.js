// Inversion uncertainty (QI programme Q8a): the per-sample spread of
// impedance across a set of inversions that differ in one assumption each
// (the wavelet, the low-frequency model, the noise). Quantiles use linear
// interpolation between order statistics (Hyndman and Fan type 7, numpy's
// default). Following the Suite's percentile convention for parameters
// (PT10, owner decision 1), the products are named Q10, Q50 and Q90 (the
// 10th, 50th and 90th percentiles); P-labels are kept for outcomes such as
// volumes. Pure, float64.

import { mulberry32, randomNormal } from '../../lib/stats/stats.js';

const fin = Number.isFinite;

/** The q-quantile (0..1) of sorted finite values, type 7. */
export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Per-sample quantiles across realisations of one trace.
 * @param {ArrayLike<number>[]} realisations equal-length traces; NaN samples are left out
 * @param {number[]} [qs] quantiles in 0..1
 * @returns {Float64Array[]} one trace per quantile (NaN where no realisation has a value)
 */
export function quantilesAcross(realisations, qs = [0.1, 0.5, 0.9]) {
  if (!realisations.length) throw new Error('No realisations to summarise.');
  const n = realisations[0].length;
  if (realisations.some((r) => r.length !== n)) throw new Error('The realisations differ in length.');
  const out = qs.map(() => new Float64Array(n));
  const col = [];
  for (let i = 0; i < n; i++) {
    col.length = 0;
    for (const r of realisations) if (fin(r[i])) col.push(r[i]);
    col.sort((a, b) => a - b);
    for (let j = 0; j < qs.length; j++) out[j][i] = quantileSorted(col, qs[j]);
  }
  return out;
}

/** The relative spread (Q90 - Q10) / Q50 per sample. */
export function relativeSpread(q10, q50, q90) {
  return Float64Array.from(q50, (m, i) => (fin(m) && m !== 0 && fin(q10[i]) && fin(q90[i]) ? (q90[i] - q10[i]) / m : NaN));
}

/**
 * A trace with seeded Gaussian noise at a signal-to-noise ratio (RMS of the
 * live samples over the noise standard deviation). Null samples stay as they are.
 * @param {(v: number) => boolean} [isLive] which samples carry signal (default finite)
 */
export function addNoise(trace, snr, seed, isLive = fin) {
  if (!(snr > 0)) throw new Error('The signal-to-noise ratio must be positive.');
  let ss = 0; let n = 0;
  for (const v of trace) if (isLive(v)) { ss += v * v; n += 1; }
  const sd = n ? Math.sqrt(ss / n) / snr : 0;
  const rng = mulberry32(seed);
  return Float64Array.from(trace, (v) => (isLive(v) ? v + sd * randomNormal(rng) : v));
}
