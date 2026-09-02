// Log conditioning (Petrophysics Studio PS8): despike, smooth, block
// depth-shift, bad-hole flag and repair. Shared engine conventions
// (see vsh.js): pure, float64, NaN-propagating, no I/O.
//
// SCOPE GUARD: depthShiftBlock is a CONSTANT block shift resampled
// back onto the original grid — deliberately NOT interval-wise
// stretch/squeeze correlation; that interactive depth match is a
// program of its own and is out of scope here by decision.
//
// The defensibility rule lives with the CALLER: conditioned curves are
// saved as NEW registry curves with full provenance; raw curves are
// never overwritten.

/**
 * Hampel filter (Hampel 1974; Pearson et al. 2016 review): replace
 * x[i] with the window median where |x[i] - median| exceeds
 * nSigma * 1.4826 * MAD. A zero-MAD window (at least half the samples
 * identical) treats ANY deviation from the median as a spike — the
 * strict inequality handles it. NaN passes through and never enters a
 * window.
 */
export function despikeHampel(x, halfWindow, nSigma) {
  const n = x.length;
  const out = Float64Array.from(x);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i])) continue;
    const w = [];
    for (let j = Math.max(0, i - halfWindow); j < Math.min(n, i + halfWindow + 1); j++) {
      if (Number.isFinite(x[j])) w.push(x[j]);
    }
    if (w.length < 3) continue;
    w.sort((a, b) => a - b);
    const med = w.length % 2 ? w[(w.length - 1) / 2] : 0.5 * (w[w.length / 2 - 1] + w[w.length / 2]);
    const dev = w.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = dev.length % 2 ? dev[(dev.length - 1) / 2] : 0.5 * (dev[dev.length / 2 - 1] + dev[dev.length / 2]);
    if (Math.abs(x[i] - med) > nSigma * 1.4826 * mad) out[i] = med;
  }
  return out;
}

/** Centred moving mean of the finite window values; a NaN centre stays
 *  NaN (smoothing never fabricates samples). */
export function smoothMean(x, halfWindow) {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i])) continue;
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - halfWindow); j < Math.min(n, i + halfWindow + 1); j++) {
      if (Number.isFinite(x[j])) { s += x[j]; c += 1; }
    }
    out[i] = s / c;
  }
  return out;
}

/** Centred moving median; a NaN centre stays NaN. */
export function smoothMedian(x, halfWindow) {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i])) continue;
    const w = [];
    for (let j = Math.max(0, i - halfWindow); j < Math.min(n, i + halfWindow + 1); j++) {
      if (Number.isFinite(x[j])) w.push(x[j]);
    }
    w.sort((a, b) => a - b);
    out[i] = w.length % 2 ? w[(w.length - 1) / 2] : 0.5 * (w[w.length / 2 - 1] + w[w.length / 2]);
  }
  return out;
}

/**
 * Constant block shift: the shifted curve at depth z reads the
 * original at z - shift, linearly interpolated on the original grid.
 * Outside the original extent, or bracketed by a NaN, -> NaN (gaps
 * are never bridged).
 */
export function depthShiftBlock(depth, x, shiftM) {
  const n = depth.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const zq = depth[i] - shiftM;
    if (zq < depth[0] || zq > depth[n - 1]) continue;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (depth[mid] <= zq) lo = mid;
      else hi = mid;
    }
    if (!Number.isFinite(x[lo]) || !Number.isFinite(x[hi])) continue;
    if (depth[hi] === depth[lo]) { out[i] = x[lo]; continue; }
    const t = (zq - depth[lo]) / (depth[hi] - depth[lo]);
    out[i] = x[lo] + t * (x[hi] - x[lo]);
  }
  return out;
}

/**
 * Per-sample bad-hole flag: caliper reads more than washoutOver over
 * bit size (same units as the caliper curve), OR |DRHO| exceeds
 * drhoMax (g/cc). A missing curve skips its criterion; a sample with
 * both inputs missing is not flagged.
 * @returns {Uint8Array}
 */
export function badHoleFlag({ cali = null, bitSize, drho = null }, { washoutOver, drhoMax }) {
  const n = (cali || drho).length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (cali && Number.isFinite(cali[i]) && cali[i] - bitSize > washoutOver) out[i] = 1;
    if (drho && Number.isFinite(drho[i]) && Math.abs(drho[i]) > drhoMax) out[i] = 1;
  }
  return out;
}

/**
 * Null or bridge flagged samples. 'null' -> NaN. 'interp' -> linear
 * bridge across flagged runs of length <= maxGapSamples with finite
 * neighbours on both sides; longer or unbounded runs -> NaN (a
 * VISIBLE cap, never silent fabrication).
 */
export function applyBadHole(x, flags, { mode = 'null', maxGapSamples = 6 } = {}) {
  const n = x.length;
  const out = Float64Array.from(x);
  let i = 0;
  while (i < n) {
    if (!flags[i]) { i += 1; continue; }
    let j = i;
    while (j < n && flags[j]) j += 1;
    const run = j - i;
    const lo = i - 1;
    const hi = j;
    const canBridge = mode === 'interp' && run <= maxGapSamples
      && lo >= 0 && hi < n && Number.isFinite(x[lo]) && Number.isFinite(x[hi]);
    for (let k = i; k < j; k++) {
      out[k] = canBridge ? x[lo] + ((k - lo) / (hi - lo)) * (x[hi] - x[lo]) : NaN;
    }
    i = j;
  }
  return out;
}
