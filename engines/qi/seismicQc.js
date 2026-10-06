// Seismic data QC (QI programme Q4a, Milestone A5): amplitude spectra and
// bandwidth, a signal-to-noise estimate from trace-to-trace coherency, and
// an acquisition-footprint measure on a time slice. Pure, float64, no I/O;
// the seismic worker runs these over whole volumes and the browser over a
// window, with the same functions.
//
//   Spectrum: a Tukey-tapered trace zero-padded to twice the next power of
//   two, one-sided amplitude |X(f)|; the peak refined by a parabola through
//   the three highest bins; band edges where the amplitude crosses -6 dB and
//   -20 dB below the peak, linearly interpolated between bins.
//
//   Signal-to-noise (Hatton, Worthington and Makin 1986, Seismic Data
//   Processing, 4.4): for neighbouring traces carrying the same signal and
//   uncorrelated noise of equal power, the normalised cross-correlation c at
//   the best lag gives S/N (power) = c / (1 - c). Reported per pair and as
//   the median, in power ratio and dB.
//
//   Footprint: the slice's mean profile along one axis (the average over
//   the other axis), detrended, then its power spectrum; a footprint is a
//   periodic stripe, a single wavenumber holding a large share of the
//   profile's variance. Reported as the period in lines and that share.

import { fft, nextPow2 } from '../../lib/fft.js';

const fin = Number.isFinite;

function tukey(n, alpha) {
  const w = new Float64Array(n).fill(1);
  const edge = Math.floor((alpha * (n - 1)) / 2);
  for (let i = 0; i < edge; i++) {
    const v = 0.5 * (1 - Math.cos((Math.PI * i) / edge));
    w[i] = v;
    w[n - 1 - i] = v;
  }
  return w;
}

/**
 * One-sided amplitude spectrum of a trace.
 * @param {ArrayLike<number>} trace samples (nulls taken as 0)
 * @param {number} dtMs sample interval, ms
 * @param {{taper?: number}} [opts] Tukey taper fraction (default 0.1)
 * @returns {{freqHz: Float64Array, amp: Float64Array, df: number}}
 */
export function amplitudeSpectrum(trace, dtMs, { taper = 0.1 } = {}) {
  if (!(dtMs > 0)) throw new Error('The sample interval must be positive.');
  const n = trace.length;
  if (n < 8) throw new Error('A spectrum needs at least 8 samples.');
  const w = tukey(n, Math.min(1, Math.max(0, taper)));
  const N = 2 * nextPow2(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = (fin(trace[i]) ? trace[i] : 0) * w[i];
  fft(re, im, false);
  const half = N / 2 + 1;
  const df = 1000 / (N * dtMs);
  const freqHz = new Float64Array(half);
  const amp = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    freqHz[k] = k * df;
    amp[k] = Math.hypot(re[k], im[k]);
  }
  return { freqHz, amp, df };
}

/** The mean spectrum of many traces (power averaged, then the root). */
export function averageSpectrum(traces, dtMs, opts) {
  if (!traces.length) throw new Error('Give at least one trace.');
  let acc = null;
  let first = null;
  let used = 0;
  for (const t of traces) {
    const s = amplitudeSpectrum(t, dtMs, opts);
    if (!acc) { acc = new Float64Array(s.amp.length); first = s; }
    if (s.amp.length !== acc.length) throw new Error('Every trace must have the same length.');
    for (let k = 0; k < acc.length; k++) acc[k] += s.amp[k] * s.amp[k];
    used += 1;
  }
  return { freqHz: first.freqHz, amp: acc.map((p) => Math.sqrt(p / used)), df: first.df, traces: used };
}

/**
 * Peak, centroid and band edges of a spectrum.
 * @returns {{peakHz, peakAmp, centroidHz, band6: [number, number], band20: [number, number], bandwidth6Hz}}
 */
export function spectrumStats({ freqHz, amp }) {
  let kMax = 1;
  for (let k = 1; k < amp.length; k++) if (amp[k] > amp[kMax]) kMax = k;
  let peakHz = freqHz[kMax];
  let peakAmp = amp[kMax];
  if (kMax > 0 && kMax < amp.length - 1) {
    const a = amp[kMax - 1]; const b = amp[kMax]; const c = amp[kMax + 1];
    const den = a - 2 * b + c;
    if (den < 0) {
      const p = (0.5 * (a - c)) / den;
      peakHz = freqHz[kMax] + p * (freqHz[1] - freqHz[0]);
      peakAmp = b - 0.25 * (a - c) * p;
    }
  }
  let sw = 0; let s = 0;
  for (let k = 0; k < amp.length; k++) { const p = amp[k] * amp[k]; sw += p * freqHz[k]; s += p; }
  const edge = (level) => {
    const thr = peakAmp * level;
    let lo = freqHz[0]; let hi = freqHz[freqHz.length - 1];
    for (let k = kMax; k > 0; k--) {
      if (amp[k - 1] < thr) { lo = freqHz[k - 1] + ((thr - amp[k - 1]) / (amp[k] - amp[k - 1])) * (freqHz[k] - freqHz[k - 1]); break; }
    }
    for (let k = kMax; k < amp.length - 1; k++) {
      if (amp[k + 1] < thr) { hi = freqHz[k] + ((amp[k] - thr) / (amp[k] - amp[k + 1])) * (freqHz[k + 1] - freqHz[k]); break; }
    }
    return [lo, hi];
  };
  const band6 = edge(10 ** (-6 / 20));
  const band20 = edge(10 ** (-20 / 20));
  return { peakHz, peakAmp, centroidHz: s > 0 ? sw / s : NaN, band6, band20, bandwidth6Hz: band6[1] - band6[0] };
}

/** Normalised cross-correlation of a and b at integer lag (b shifted by lag). */
function ncc(a, b, lag) {
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const j = i + lag;
    if (j < 0 || j >= b.length) continue;
    const x = a[i]; const y = b[j];
    if (!fin(x) || !fin(y)) continue;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

/**
 * Signal-to-noise from neighbouring traces.
 * @param {Array<ArrayLike<number>>} traces neighbours in order
 * @param {{maxLag?: number}} [opts] samples searched either side for the best alignment (dip)
 * @returns {{snr: number, snrDb: number, pairs: number, perPair: number[]}}
 */
export function snrFromCoherency(traces, { maxLag = 3 } = {}) {
  if (traces.length < 2) throw new Error('Signal-to-noise needs at least two neighbouring traces.');
  const perPair = [];
  for (let t = 0; t + 1 < traces.length; t++) {
    let best = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const c = ncc(traces[t], traces[t + 1], lag);
      if (c > best) best = c;
    }
    if (!fin(best)) continue;
    const c = Math.min(Math.max(best, 0), 0.999999);
    perPair.push(c / (1 - c));
  }
  if (!perPair.length) throw new Error('No neighbouring pair had samples to correlate.');
  const sorted = perPair.slice().sort((x, y) => x - y);
  const m = sorted.length;
  const snr = m % 2 ? sorted[(m - 1) / 2] : 0.5 * (sorted[m / 2 - 1] + sorted[m / 2]);
  return { snr, snrDb: snr > 0 ? 10 * Math.log10(snr) : -Infinity, pairs: m, perPair };
}

/**
 * Footprint on a time slice: the strongest periodic stripe along each axis.
 * @param {Array<ArrayLike<number>>} slice rows = inlines, columns = crosslines
 * @param {{minPeriod?: number, maxPeriod?: number}} [opts] periods searched, in lines
 * @returns {{alongCrossline: {period, share}, alongInline: {period, share}}}
 *   share is the fraction of the detrended profile's variance at that period
 */
export function footprint(slice, { minPeriod = 2, maxPeriod = 16 } = {}) {
  const nIl = slice.length;
  const nXl = slice[0]?.length || 0;
  if (nIl < 4 || nXl < 4) throw new Error('A footprint needs a slice of at least 4 by 4.');
  const profile = (len, at) => {
    const p = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      let s = 0; let c = 0;
      for (const v of at(k)) if (fin(v)) { s += v; c += 1; }
      p[k] = c ? s / c : 0;
    }
    return p;
  };
  const colAt = (j) => { const out = []; for (let i = 0; i < nIl; i++) out.push(slice[i][j]); return out; };
  const rowAt = (i) => slice[i];
  const stripe = (p) => {
    const n = p.length;
    // remove the linear trend (regional geology varies slowly)
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    for (let k = 0; k < n; k++) { sx += k; sy += p[k]; sxx += k * k; sxy += k * p[k]; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const a = (sy - b * sx) / n;
    const d = p.map((v, k) => v - (a + b * k));
    const N = nextPow2(n) * 4;
    const re = new Float64Array(N); const im = new Float64Array(N);
    for (let k = 0; k < n; k++) re[k] = d[k];
    fft(re, im, false);
    const power = (k) => re[k] * re[k] + im[k] * im[k];
    let total = 0;
    for (let k = 1; k < N / 2; k++) total += power(k);
    let bestK = -1; let bestP = 0;
    for (let k = 1; k < N / 2; k++) {
      const period = N / k;
      if (period < minPeriod || period > maxPeriod) continue;
      if (power(k) > bestP) { bestP = power(k); bestK = k; }
    }
    if (bestK < 0 || !(total > 0)) return { period: NaN, share: 0 };
    // the stripe's power spreads over the neighbouring bins of the padded transform
    let peak = 0;
    for (let k = Math.max(1, bestK - 2); k <= Math.min(N / 2 - 1, bestK + 2); k++) peak += power(k);
    return { period: N / bestK, share: peak / total };
  };
  return {
    alongCrossline: stripe(profile(nXl, colAt)),
    alongInline: stripe(profile(nIl, rowAt)),
  };
}
