// Well tie 2.0 (W3.3): multi-anchor stretch/squeeze, constant-phase
// rotation and windowed tie QC — the tools that turn the display-only
// bulk shift into a committable tie.
//
// The WARP: anchors pair a synthetic event time with the seismic time
// the interpreter dragged it to. Between anchors the mapping is
// piecewise linear; beyond the first/last anchor it extends with slope
// one (a constant shift — exactly the bulk-shift behaviour, which is
// the single-anchor case). Both coordinates must be strictly
// increasing: time cannot fold.
//
// COMMITTING the warp (helpers here, persistence in the Suite):
//  - to checkshots: each anchor knows its depth through the SAME T(z)
//    the synthetic was built with, so (depth, warped time) rows form a
//    derived checkshot set — never overwriting imported data;
//  - to velocity calibration: the same (depth, warped time) pairs are
//    exactly wellTie.js tie points, so fitWellTie does the fitting.
//
// PHASE: the constant-phase rotation of a trace is
//   rot(s, φ) = s·cos φ + H(s)·sin φ      (H = Hilbert transform)
// and the best φ against a reference maximizes the correlation of
// rot(s, φ) with r. With <s, H(s)> ≈ 0 and |H(s)| ≈ |s| (analytic
// signal properties on a well-windowed trace) the maximizer is
// φ* = atan2(<H(s), r>, <s, r>) — computed that way, then reported
// with the ACTUAL correlation at φ*.
//
// Nulls: the seismic null (|v| > 9e29) and NaN are gaps everywhere;
// gaps never enter sums and warped samples that land in a gap stay
// gaps. Pure math, worker-safe, no I/O.

import { analyticSignal } from './attributes';
import { isGap } from '../../lib/waveform';
import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * Validate + build the piecewise-linear tie warp.
 *
 * @param {{synTwtMs:number, seisTwtMs:number}[]} anchors 1..n pairs
 * @returns {{anchors: Array, toSeismicMs: (t:number)=>number,
 *   toSyntheticMs: (t:number)=>number}}
 */
export function makeTieWarp(anchors) {
  if (!anchors || !anchors.length) throw new Error('A tie warp needs at least one anchor.');
  const a = [...anchors]
    .map((p) => ({ synTwtMs: Number(p.synTwtMs), seisTwtMs: Number(p.seisTwtMs) }))
    .sort((p, q) => p.synTwtMs - q.synTwtMs);
  for (const p of a) {
    if (!Number.isFinite(p.synTwtMs) || !Number.isFinite(p.seisTwtMs)) {
      throw new Error('Tie anchors need finite times.');
    }
  }
  for (let i = 1; i < a.length; i++) {
    if (a[i].synTwtMs <= a[i - 1].synTwtMs || a[i].seisTwtMs <= a[i - 1].seisTwtMs) {
      throw new Error('Tie anchors must increase in both synthetic and seismic time — the warp cannot fold.');
    }
  }
  const map = (t, from, to) => {
    if (a.length === 1) return t + (a[0][to] - a[0][from]);
    if (t <= a[0][from]) return t + (a[0][to] - a[0][from]);
    const last = a[a.length - 1];
    if (t >= last[from]) return t + (last[to] - last[from]);
    let i = 1;
    while (a[i][from] < t) i++;
    const p = a[i - 1];
    const q = a[i];
    const f = (t - p[from]) / (q[from] - p[from]);
    return p[to] + f * (q[to] - p[to]);
  };
  return {
    anchors: a,
    toSeismicMs: (t) => map(t, 'synTwtMs', 'seisTwtMs'),
    toSyntheticMs: (t) => map(t, 'seisTwtMs', 'synTwtMs'),
  };
}

/**
 * Resample a synthetic onto the seismic time axis through the warp:
 * output sample j (seismic time j·dt) takes the synthetic's value at
 * toSyntheticMs(j·dt), linearly interpolated; anything touching a gap
 * or outside the synthetic stays the seismic null.
 *
 * @param {ArrayLike<number>} values synthetic samples (dt grid from 0)
 * @param {number} dtMs @param {ReturnType<typeof makeTieWarp>} warp
 * @param {number} [ns] output length (default: input length)
 * @returns {Float32Array}
 */
export function warpTrace(values, dtMs, warp, ns = values.length) {
  const out = new Float32Array(ns).fill(NULL_F32);
  const n = values.length;
  for (let j = 0; j < ns; j++) {
    const tSyn = warp.toSyntheticMs(j * dtMs) / dtMs;
    const i0 = Math.floor(tSyn);
    if (i0 < 0 || i0 + 1 >= n) continue;
    const v0 = values[i0];
    const v1 = values[i0 + 1];
    if (isGap(v0) || isGap(v1)) continue;
    const f = tSyn - i0;
    out[j] = v0 + f * (v1 - v0);
  }
  return out;
}

/**
 * Derived checkshot rows from the warp: each anchor's depth through the
 * SAME T(z) the synthetic used, paired with its warped (seismic) time.
 * Imported checkshots are never touched — the Suite stores these as a
 * new set with provenance.
 *
 * @param {ReturnType<typeof makeTieWarp>} warp
 * @param {(twtMs:number)=>?number} twtToTvdss inverse of the synthetic's
 *   tvdssToTwt (null where the relation does not reach)
 * @returns {{tvdssM:number, twtMs:number}[]} strictly increasing rows
 */
export function warpToCheckshots(warp, twtToTvdss) {
  const rows = [];
  for (const a of warp.anchors) {
    const z = twtToTvdss(a.synTwtMs);
    if (z == null || !Number.isFinite(z)) continue;
    rows.push({ tvdssM: z, twtMs: a.seisTwtMs });
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].tvdssM <= rows[i - 1].tvdssM || rows[i].twtMs <= rows[i - 1].twtMs) {
      throw new Error('Derived checkshots must increase in depth and time — check the T(z) relation.');
    }
  }
  if (!rows.length) {
    throw new Error('No anchor could be converted to depth — the T(z) relation does not reach the tie window.');
  }
  return rows;
}

/**
 * The same anchors as wellTie.js tie points (fitWellTie input): depth
 * through the synthetic's T(z), seismic time from the warp.
 *
 * @param {ReturnType<typeof makeTieWarp>} warp
 * @param {(twtMs:number)=>?number} twtToTvdss
 * @param {{wellName?:string, cell?:number}} [meta] lattice cell of the
 *   well at the tie window (layer-cake boundary lookup)
 * @returns {Array} fitWellTie-shaped ties
 */
export function warpToTiePoints(warp, twtToTvdss, meta = {}) {
  const ties = [];
  for (const a of warp.anchors) {
    const z = twtToTvdss(a.synTwtMs);
    if (z == null || !Number.isFinite(z)) continue;
    ties.push({
      wellName: meta.wellName || 'well',
      topName: `anchor @ ${a.seisTwtMs.toFixed(0)} ms`,
      horizonId: null,
      il: null,
      xl: null,
      cell: meta.cell ?? 0,
      twtMs: a.seisTwtMs,
      zTopM: z,
    });
  }
  if (!ties.length) {
    throw new Error('No anchor could be converted to depth — the T(z) relation does not reach the tie window.');
  }
  return ties;
}

/**
 * Constant-phase rotation of a trace: s·cos φ + H(s)·sin φ. Gaps stay
 * gaps (the Hilbert transform runs on the zero-filled trace, the
 * attributes.js recipe).
 * @param {ArrayLike<number>} trace @param {number} phiRad
 * @returns {Float32Array}
 */
export function rotateConstantPhase(trace, phiRad) {
  const { im } = analyticSignal(trace);
  const c = Math.cos(phiRad);
  const s = Math.sin(phiRad);
  const out = new Float32Array(trace.length);
  for (let i = 0; i < trace.length; i++) {
    const v = trace[i];
    out[i] = isGap(v) ? NULL_F32 : c * v + s * im[i];
  }
  return out;
}

/**
 * Estimate the constant phase that best matches the synthetic to the
 * seismic: φ* = atan2(<H(s), r>, <s, r>) over mutually live samples,
 * reported with the ACTUAL normalized correlation of rot(s, φ*) vs r
 * and the zero-phase correlation for comparison.
 *
 * @param {ArrayLike<number>} synthetic
 * @param {ArrayLike<number>} seismic same grid
 * @param {{minOverlap?: number}} [opts]
 * @returns {?{phiRad:number, phiDeg:number, corr:number, corr0:number}}
 *   null when there is not enough overlapping energy
 */
export function estimatePhaseRotation(synthetic, seismic, { minOverlap = 8 } = {}) {
  const { im } = analyticSignal(synthetic);
  let u = 0;
  let v = 0;
  let count = 0;
  const n = Math.min(synthetic.length, seismic.length);
  for (let i = 0; i < n; i++) {
    const a = synthetic[i];
    const r = seismic[i];
    if (isGap(a) || isGap(r)) continue;
    u += a * r;
    v += im[i] * r;
    count++;
  }
  if (count < minOverlap || (u === 0 && v === 0)) return null;
  const phiRad = Math.atan2(v, u);

  const corrWith = (s) => {
    let num = 0;
    let ss = 0;
    let rr = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = s[i];
      const r = seismic[i];
      if (isGap(a) || isGap(r)) continue;
      num += a * r;
      ss += a * a;
      rr += r * r;
      m++;
    }
    if (m < minOverlap || ss === 0 || rr === 0) return null;
    return num / Math.sqrt(ss * rr);
  };
  const corr = corrWith(rotateConstantPhase(synthetic, phiRad));
  const corr0 = corrWith(synthetic);
  if (corr == null) return null;
  return {
    phiRad,
    phiDeg: (phiRad * 180) / Math.PI,
    corr,
    corr0: corr0 ?? 0,
  };
}

/**
 * Windowed tie QC: normalized zero-lag correlation of synthetic vs
 * seismic in sliding windows — the quality track beside the tie.
 *
 * @param {ArrayLike<number>} synthetic
 * @param {ArrayLike<number>} seismic same grid
 * @param {number} dtMs
 * @param {{windowMs?:number, stepMs?:number, minOverlap?:number}} [opts]
 * @returns {{twtMs:number, corr:?number, overlap:number}[]} one row per
 *   window centre; corr null where overlap is too thin
 */
export function windowedTieQc(synthetic, seismic, dtMs, {
  windowMs = 100, stepMs = 20, minOverlap = 8,
} = {}) {
  const n = Math.min(synthetic.length, seismic.length);
  const half = Math.max(1, Math.round(windowMs / 2 / dtMs));
  const step = Math.max(1, Math.round(stepMs / dtMs));
  const rows = [];
  for (let c = half; c < n - half; c += step) {
    let num = 0;
    let ss = 0;
    let rr = 0;
    let m = 0;
    for (let i = c - half; i <= c + half; i++) {
      const a = synthetic[i];
      const r = seismic[i];
      if (isGap(a) || isGap(r)) continue;
      num += a * r;
      ss += a * a;
      rr += r * r;
      m++;
    }
    rows.push({
      twtMs: c * dtMs,
      corr: m >= minOverlap && ss > 0 && rr > 0 ? num / Math.sqrt(ss * rr) : null,
      overlap: m,
    });
  }
  return rows;
}
