// Spectral decomposition RGB blend: three frequency volumes (or three
// horizon isofrequency grids) shown at once as red, green and blue.
// A thin bed tunes at a frequency set by its thickness, so where one
// frequency dominates the colour says which; where all three are strong
// the colour goes to white, and where all are weak to black.
//
// The frequency volumes themselves come from the existing spectral
// attribute (attributes.spectralTrace, the windowed Hann STFT the horizon
// isofrequency kernel defines), so the worker, the browser and the horizon
// maps share one kernel. This module adds:
//   - spectralTriplet: the three frequency traces of one trace, through
//     makeTraceCompute('spectral'), the code path every runner calls;
//   - channelRange: a percentile clip per channel, nulls ignored;
//   - blendRgb: the RGBA pixels, nulls transparent;
//   - dominantFrequency: which of the three is strongest at a sample.
//
// Pure math, no I/O, worker safe.

import { NULL_VALUE } from './manifest';
import { makeTraceCompute } from './attributes';

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1e29;

/** Low, middle and high frequency offered by default (Hz), inside the
 *  Ekene stack's -6 dB band of about 14 to 35 Hz plus its shoulders. */
export const RGB_DEFAULT_FREQS = Object.freeze([12, 25, 40]);
/** Default STFT window (ms): long enough to resolve 12 Hz (about 1.5 cycles). */
export const RGB_DEFAULT_WINDOW_MS = 120;
export const CHANNELS = Object.freeze(['red', 'green', 'blue']);

/**
 * Check three frequencies for a blend: three distinct, ascending, positive
 * values below Nyquist.
 * @returns {string|null} a reason it cannot run, or null
 */
export function tripletProblem(freqs, dtUs) {
  if (!Array.isArray(freqs) || freqs.length !== 3) return 'Choose three frequencies.';
  if (!freqs.every((f) => Number.isFinite(f) && f > 0)) return 'Each frequency must be a positive number of hertz.';
  if (!(freqs[0] < freqs[1] && freqs[1] < freqs[2])) return 'Give the frequencies in ascending order, low (red) to high (blue).';
  if (dtUs > 0) {
    const nyq = 1 / (2 * dtUs * 1e-6);
    if (freqs[2] > nyq) return `The high frequency is above the Nyquist frequency, ${nyq} Hz, for this sample interval.`;
  }
  return null;
}

/**
 * The three frequency traces of one trace (the same kernel as the
 * spectral attribute volumes).
 * @param {Float32Array} trace
 * @param {number[]} freqs three frequencies (Hz)
 * @param {{windowMs?: number, dtUs: number}} opts
 * @returns {Float32Array[]} [low, middle, high]
 */
export function spectralTriplet(trace, freqs, { windowMs = RGB_DEFAULT_WINDOW_MS, dtUs }) {
  const why = tripletProblem(freqs, dtUs);
  if (why) throw new Error(why);
  return freqs.map((freqHz) => {
    const out = new Float32Array(trace.length);
    makeTraceCompute('spectral', { freqHz, windowMs }, { dtUs })(trace, out);
    return out;
  });
}

/**
 * Display range of one channel: the lo and hi percentiles of its live
 * values (nulls and non-finite values ignored). A flat channel returns a
 * unit-wide range so it maps to black rather than dividing by zero.
 * @param {ArrayLike<number>} values
 * @returns {{min: number, max: number, n: number}}
 */
export function channelRange(values, { lo = 0.02, hi = 0.98, maxSamples = 200000 } = {}) {
  const n = values.length;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const live = [];
  for (let i = 0; i < n; i += step) { const v = values[i]; if (!isNull(v)) live.push(v); }
  if (!live.length) return { min: 0, max: 1, n: 0 };
  live.sort((a, b) => a - b);
  const q = (p) => live[Math.min(live.length - 1, Math.max(0, Math.round(p * (live.length - 1))))];
  const min = q(lo);
  let max = q(hi);
  if (!(max > min)) max = min + 1;
  return { min, max, n: live.length };
}

/**
 * RGBA pixels of a blend. Each channel is scaled to 0..255 over its range
 * (clipped), with an optional gamma. A sample null in any channel is
 * transparent.
 * @param {ArrayLike<number>} r low frequency
 * @param {ArrayLike<number>} g middle frequency
 * @param {ArrayLike<number>} b high frequency
 * @param {{ranges?: {min:number,max:number}[], gamma?: number, out?: Uint8ClampedArray}} [opts]
 * @returns {{pixels: Uint8ClampedArray, ranges: {min:number,max:number}[]}}
 */
export function blendRgb(r, g, b, { ranges = null, gamma = 1, out = null } = {}) {
  const n = r.length;
  if (g.length !== n || b.length !== n) throw new Error('The three channels must be the same size.');
  const chans = [r, g, b];
  const rg = ranges || chans.map((c) => channelRange(c));
  const pixels = out || new Uint8ClampedArray(4 * n);
  const inv = rg.map(({ min, max }) => 1 / (max - min));
  const g1 = gamma > 0 ? 1 / gamma : 1;
  for (let i = 0; i < n; i++) {
    const o = 4 * i;
    let dead = false;
    for (let c = 0; c < 3; c++) {
      const v = chans[c][i];
      if (isNull(v)) { dead = true; break; }
      let t = (v - rg[c].min) * inv[c];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      pixels[o + c] = Math.round(255 * (g1 === 1 ? t : t ** g1));
    }
    if (dead) { pixels[o] = 0; pixels[o + 1] = 0; pixels[o + 2] = 0; pixels[o + 3] = 0; } else pixels[o + 3] = 255;
  }
  return { pixels, ranges: rg };
}

/**
 * Which of the three channels is strongest at each sample after scaling
 * to its range: 0 red, 1 green, 2 blue, -1 null. Used for the readout.
 */
export function dominantChannel(r, g, b, ranges) {
  const n = r.length;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const v = [r[i], g[i], b[i]];
    if (v.some(isNull)) { out[i] = -1; continue; }
    let best = 0; let bv = -Infinity;
    for (let c = 0; c < 3; c++) { const t = (v[c] - ranges[c].min) / (ranges[c].max - ranges[c].min); if (t > bv) { bv = t; best = c; } }
    out[i] = best;
  }
  return out;
}

export { NULL_VALUE };
