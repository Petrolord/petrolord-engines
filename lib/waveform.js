// Shared waveform primitives — extracted VERBATIM from Seismolord
// engine/synthetics.js at the second consumer (Rock Physics Studio
// wedge modeling), per the G4 gridding precedent. Seismolord
// re-exports these so its synthetics API is unchanged; the Seismolord
// synthetics jest goldens are the extraction tripwire.
//
// Gap convention (shared with the LAS import layer): NaN, |v| >= 9e29
// (SEG-Y/DISKOS-style 1.0E+30 nulls) and the classic LAS null codes
// are all "no data".
//
// Pure math, worker-safe, no I/O.

const BIG_NULL = 9.0e29;
const RAW_LAS_NULLS = [-999.25, -999.0, -9999.0, -9999.25];

/** @param {number} v @returns {boolean} gap sample? (see header) */
export function isGap(v) {
  if (!Number.isFinite(v)) return true;
  if (Math.abs(v) >= BIG_NULL) return true;
  return RAW_LAS_NULLS.includes(v);
}

/**
 * Zero-phase Ricker wavelet r(t) = (1 - 2 pi^2 f^2 t^2) exp(-pi^2 f^2 t^2),
 * peak 1.0 at the centre sample.
 * @param {number} freqHz @param {number} dtMs
 * @param {number} [halfLengthMs]
 * @returns {Float32Array} length 2*round(halfLengthMs/dtMs) + 1
 */
export function rickerWavelet(freqHz, dtMs, halfLengthMs = 60) {
  if (!(freqHz > 0) || !(dtMs > 0) || !(halfLengthMs > 0)) {
    throw new Error('Ricker wavelet needs a positive frequency, sample rate and half-length.');
  }
  const n = Math.round(halfLengthMs / dtMs);
  const out = new Float32Array(2 * n + 1);
  for (let i = 0; i < out.length; i++) {
    const t = ((i - n) * dtMs) / 1000;
    const x = (Math.PI * freqHz * t) ** 2;
    out[i] = (1 - 2 * x) * Math.exp(-x);
  }
  return out;
}

/**
 * 'same' convolution with the gap policy the goldens pin: gap samples
 * are ZERO-FILLED for the sum, and the validity mask returned is the
 * input sample's own validity (display pen-breaks there).
 *
 * @param {ArrayLike<number>} signal e.g. reflectivity (may contain gaps)
 * @param {ArrayLike<number>} wavelet odd length, centre = zero lag
 * @returns {{data: Float32Array, valid: Uint8Array}}
 */
export function convolveSame(signal, wavelet) {
  const nw = wavelet.length;
  if (nw % 2 !== 1) {
    throw new Error(`The wavelet must have an odd number of samples (got ${nw}).`);
  }
  const half = (nw - 1) / 2;
  const n = signal.length;
  const valid = new Uint8Array(n);
  const s0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!isGap(signal[i])) {
      valid[i] = 1;
      s0[i] = signal[i];
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < nw; j++) {
      const k = i + half - j;
      if (k >= 0 && k < n) acc += wavelet[j] * s0[k];
    }
    out[i] = acc;
  }
  return { data: out, valid };
}
