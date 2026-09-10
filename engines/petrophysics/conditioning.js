// Log conditioning (Petrophysics Studio PS8): despike, smooth, block
// depth-shift, bad-hole flag and repair. Shared engine conventions
// (see vsh.js): pure, float64, NaN-propagating, no I/O.
//
// Two depth shifts, both resampled back onto the ORIGINAL grid so every
// index-based consumer keeps working: depthShiftBlock is a constant
// shift; depthShiftTiePoints (PT11c, 2026-09-10) is stretch and squeeze
// through user-placed tie points, piecewise linear between ties and a
// constant shift beyond the outermost ones. Both read the raw curve
// through the same bracketing linear interpolation (readAt), the only
// resampler in the Studio; nulls are never bridged.
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
 * The one resampler: the raw curve read at depth zq by linear
 * interpolation between the two bracketing samples. Outside the extent,
 * or bracketed by a NaN, -> NaN (gaps are never bridged); a read that
 * lands exactly on a sample is that sample.
 */
function readAt(depth, x, zq) {
  const n = depth.length;
  if (!(zq >= depth[0]) || !(zq <= depth[n - 1])) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (depth[mid] <= zq) lo = mid;
    else hi = mid;
  }
  // a read exactly on a sample is that sample (the identity warp returns
  // the input byte for byte); only a read BETWEEN samples needs both
  // brackets finite. A repeated depth therefore also takes the lower one.
  if (zq === depth[lo]) return x[lo];
  if (zq === depth[hi]) return x[hi];
  if (!Number.isFinite(x[lo]) || !Number.isFinite(x[hi])) return NaN;
  const t = (zq - depth[lo]) / (depth[hi] - depth[lo]);
  return x[lo] + t * (x[hi] - x[lo]);
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
  for (let i = 0; i < n; i++) out[i] = readAt(depth, x, depth[i] - shiftM);
  return out;
}

/**
 * Tie-point warp (PT11c). `pairs` are [refMd, targetMd]: the target
 * curve's feature at targetMd belongs at refMd, so the shifted curve at
 * z reads the raw curve at warp(z). warp is piecewise linear through
 * the pairs (sorted by reference depth) and z + (targetOuter - refOuter)
 * beyond the outermost ties. Zero pairs is the identity; one pair is
 * the block shift with shiftM = refMd - targetMd.
 *
 * Refused (structured, the fit convention): a non-finite pair,
 * duplicate reference depths, or ties that cross (the target sequence
 * must increase strictly with the reference sequence).
 * @returns {{ ok: true, pairs: number[][], warp: (z: number) => number } | { ok: false, error: string }}
 */
export function tiePointWarp(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  for (const p of list) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      return { ok: false, error: 'Every tie point needs a finite reference depth and a finite target depth.' };
    }
  }
  const sorted = list.map(([r, t]) => [r, t]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) {
    const [r0, t0] = sorted[i - 1];
    const [r1, t1] = sorted[i];
    if (r1 === r0) return { ok: false, error: `Two ties share the reference depth ${r0}; a depth can map to one place only.` };
    if (!(t1 > t0)) {
      return { ok: false, error: `Ties cross: reference ${r0} to ${r1} would map target ${t0} to ${t1}, which runs backwards. Depth order must be kept.` };
    }
  }
  const m = sorted.length;
  const warp = (z) => {
    if (m === 0) return z;
    if (m === 1 || z <= sorted[0][0]) return z + (sorted[0][1] - sorted[0][0]);
    if (z >= sorted[m - 1][0]) return z + (sorted[m - 1][1] - sorted[m - 1][0]);
    let lo = 0;
    let hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid][0] <= z) lo = mid;
      else hi = mid;
    }
    const [r0, t0] = sorted[lo];
    const [r1, t1] = sorted[hi];
    return t0 + ((z - r0) / (r1 - r0)) * (t1 - t0);
  };
  return { ok: true, pairs: sorted, warp };
}

/**
 * Stretch and squeeze through tie points: out[i] = readAt(warp(depth[i])).
 * Same resampler and null rules as the block shift. Throws on a refused
 * tie set (call tiePointWarp first to get the sentence).
 */
export function depthShiftTiePoints(depth, x, pairs) {
  const w = tiePointWarp(pairs);
  if (!w.ok) throw new Error(w.error);
  const n = depth.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) out[i] = readAt(depth, x, w.warp(depth[i]));
  return out;
}

/**
 * The shift-versus-depth track: shift(z) = z - warp(z), positive where
 * the curve is moved deeper (the block shift's sign). Throws on a
 * refused tie set.
 */
export function shiftCurve(depth, pairs) {
  const w = tiePointWarp(pairs);
  if (!w.ok) throw new Error(w.error);
  return Float64Array.from(depth, (z) => z - w.warp(z));
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
