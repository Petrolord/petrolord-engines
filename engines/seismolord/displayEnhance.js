// Section display enhancements (interpreter program Wave 1 / W1.1):
// windowed AGC gain maps, percentile amplitude scaling, and wiggle /
// variable-area geometry. All of it is DISPLAY math — stored amplitudes
// are never modified; AGC ships as a gain map the shader multiplies in,
// and the CPU reference mirrors it (GPU==CPU parity self-test).
//
// Slice layout convention (assembleSlice): width = samples per trace,
// height = traces, data[trace * width + s]. AGC windows run along the
// sample axis within each trace; time slices have no trace axis and
// take no AGC.

const isNull = (v, lim) => Math.abs(v) > lim;

/** RMS of the non-null samples (0 when everything is null). */
export function sliceRms(data) {
  const lim = 1.0e29;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNull(v, lim)) continue;
    sum += v * v;
    n += 1;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/**
 * Windowed AGC gain map: per trace, gain[s] = reference / rms(window),
 * where the window is samples [s - halfWindow, s + halfWindow] clamped
 * to the trace (edge windows shrink), nulls excluded. All-null or
 * zero-energy windows get gain 0 (the shader's null mask hides the
 * sample anyway). `reference` defaults to the slice's global non-null
 * RMS so overall brightness is preserved and existing clip settings
 * stay meaningful.
 *
 * O(width) per trace via prefix sums; float64 accumulation.
 *
 * @param {Float32Array} data slice amplitudes, data[trace*width + s]
 * @param {number} width samples per trace
 * @param {number} height traces
 * @param {{halfWindow: number, reference?: number}} opts
 * @returns {Float32Array} gain map, same layout as data
 */
export function agcGainMap(data, width, height, {
  halfWindow, reference = null,
} = {}) {
  if (!Number.isFinite(halfWindow) || halfWindow < 1) {
    throw new Error(`AGC half-window must be a positive sample count, got ${halfWindow}`);
  }
  const hw = Math.floor(halfWindow);
  const lim = 1.0e29;
  const ref = reference == null ? sliceRms(data) : reference;
  const out = new Float32Array(width * height);
  if (ref <= 0) return out;                     // silent slice: flat zero gain
  const sum2 = new Float64Array(width + 1);
  const cnt = new Int32Array(width + 1);
  for (let tr = 0; tr < height; tr++) {
    const base = tr * width;
    for (let s = 0; s < width; s++) {
      const v = data[base + s];
      const ok = !isNull(v, lim);
      sum2[s + 1] = sum2[s] + (ok ? v * v : 0);
      cnt[s + 1] = cnt[s] + (ok ? 1 : 0);
    }
    for (let s = 0; s < width; s++) {
      const lo = Math.max(0, s - hw);
      const hi = Math.min(width - 1, s + hw);
      const n = cnt[hi + 1] - cnt[lo];
      if (n === 0) continue;                    // all-null window: gain 0
      const rms = Math.sqrt((sum2[hi + 1] - sum2[lo]) / n);
      out[base + s] = rms > 0 ? ref / rms : 0;
    }
  }
  return out;
}

/**
 * Percentile of |amplitude| over the non-null samples, with linear
 * interpolation between order statistics (the numpy 'linear' default).
 * Arrays above `cap` samples are strided deterministically before
 * sorting (stride = ceil(n / cap)) — same input, same answer.
 *
 * @param {Float32Array} data
 * @param {number} pct percentile in [0, 100]
 * @param {{cap?: number}} [opts]
 * @returns {number} 0 when no valid samples
 */
export function amplitudePercentile(data, pct, { cap = 1 << 20 } = {}) {
  if (!(pct >= 0 && pct <= 100)) throw new Error(`Percentile out of range: ${pct}`);
  const lim = 1.0e29;
  const stride = Math.max(1, Math.ceil(data.length / cap));
  const vals = [];
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (isNull(v, lim)) continue;
    vals.push(Math.abs(v));
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  const pos = (pct / 100) * (vals.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(vals.length - 1, i0 + 1);
  const f = pos - i0;
  return vals[i0] * (1 - f) + vals[i1] * f;
}

/**
 * Normalized wiggle deviations for one trace: the SAME amplitude
 * pipeline the density shader runs (per-trace balance scale, optional
 * AGC gain, display gain including polarity sign, symmetric clip),
 * mapped to [-1, 1]. Null samples become NaN (pen breaks).
 *
 * @param {Float32Array} samples one trace (subarray of a slice)
 * @param {{gain?: number, clip: number, rmsScale?: number,
 *          agc?: Float32Array|null}} opts
 *   agc, when present, is this trace's slice of the agcGainMap
 * @returns {Float64Array} deviations, NaN at nulls
 */
export function wiggleDeviations(samples, {
  gain = 1, clip, rmsScale = 1, agc = null,
} = {}) {
  if (!(clip > 0)) throw new Error(`Wiggle clip must be positive, got ${clip}`);
  const lim = 1.0e29;
  const out = new Float64Array(samples.length);
  for (let s = 0; s < samples.length; s++) {
    const v = samples[s];
    if (isNull(v, lim)) {
      out[s] = NaN;
      continue;
    }
    const a = (v * rmsScale * (agc ? agc[s] : 1) * gain) / clip;
    out[s] = a > 1 ? 1 : a < -1 ? -1 : a;
  }
  return out;
}

/**
 * Variable-area fill runs: intervals of the sample axis where the
 * deviation is positive, with sub-sample zero crossings linearly
 * interpolated. NaN (null) samples end the current run at the last
 * valid sample. Returns [{s0, s1}] in fractional sample coordinates.
 *
 * @param {Float64Array|Float32Array|number[]} dev wiggleDeviations output
 */
export function varAreaRuns(dev) {
  const runs = [];
  let open = null;
  const close = (at) => {
    if (open != null && at > open) runs.push({ s0: open, s1: at });
    open = null;
  };
  for (let s = 0; s < dev.length; s++) {
    const v = dev[s];
    if (Number.isNaN(v)) {
      close(s - 1);
      continue;
    }
    const prev = s > 0 ? dev[s - 1] : NaN;
    if (v > 0) {
      if (open == null) {
        // entering a positive lobe: fractional crossing from the previous
        // non-positive sample, or the run starts at this sample
        open = (!Number.isNaN(prev) && prev <= 0 && v !== prev)
          ? (s - 1) + (0 - prev) / (v - prev)
          : s;
      }
    } else if (open != null) {
      // leaving the lobe: fractional crossing between s-1 and s
      const at = (!Number.isNaN(prev) && prev > 0 && v !== prev)
        ? (s - 1) + (0 - prev) / (v - prev)
        : s - 1;
      close(at);
    }
  }
  close(dev.length - 1);
  return runs;
}
