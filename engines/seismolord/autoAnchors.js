// Automatic tie-anchor suggestion (QI upgrade, F3 benchmark F-4,
// 2026-10-15): the stretch and squeeze that a bulk shift and a constant
// phase cannot give, proposed as anchors for the Synthetics tie warp
// (tieWarp.js), for the interpreter to review, edit and commit.
//
// METHOD (dynamic warping on windowed correlations, after Hale 2013,
// "Dynamic warping of seismic images", Geophysics 78(2) S105):
//  1. bulk shift: the lag of the best whole-trace normalized correlation;
//  2. coarse lags from the ENVELOPES (demeaned correlation in windows every
//     stepMs, lags within maxShiftMs of the bulk shift): a phase error
//     trades off against a small shift on the waveform, not on the envelope;
//  3. the lag path that maximizes the summed correlation less a penalty on
//     each change of lag, with a change between neighbouring windows of at
//     most maxStrain x stepMs (dynamic programming). The strain limit keeps
//     the warp monotone: the seismic times of neighbouring windows differ by
//     stepMs plus the change, which stays above zero;
//  4. the constant phase measured on the synthetic warped by those lags
//     (estimatePhaseRotation), and the synthetic rotated by it;
//  5. the lags refined on the rotated waveform within two samples of the
//     coarse path (the same dynamic programming), each refined to a fraction
//     of a sample by a parabola through its neighbours, then smoothed 1-2-1;
//  6. anchors at the windows whose correlation reaches minCorr, offered only
//     when the whole warped synthetic correlates at minTraceCorr or more.
// Validated on known warps (engines __tests__/seismolord.autoAnchors.test.js):
// the shift within one sample at every anchor, with and without noise.
//
// Pure maths, worker-safe, no I/O. Gaps (the seismic null and NaN) never
// enter a sum.

import { estimatePhaseRotation, rotateConstantPhase, makeTieWarp, warpTrace } from './tieWarp';
import { analyticSignal } from './attributes';
import { isGap } from '../../lib/waveform';

export const AUTO_ANCHOR_DEFAULTS = Object.freeze({
  windowMs: 100, stepMs: 40, maxShiftMs: 60, maxStrain: 0.25, penalty: 0.02, minCorr: 0.3, minTraceCorr: 0.3, phase: true,
});

const live = (v) => !isGap(v) && Number.isFinite(v);

/** Normalized correlation of a[i] with b[i + lag] over i in [i0, i1] (demeaned for envelopes). */
function corrAt(a, b, i0, i1, lag, minOverlap, demean = false) {
  let sa = 0; let sb = 0; let ab = 0; let aa = 0; let bb = 0; let n = 0;
  for (let i = i0; i <= i1; i++) {
    const j = i + lag;
    if (j < 0 || j >= b.length || i < 0 || i >= a.length) continue;
    const x = a[i]; const y = b[j];
    if (!live(x) || !live(y)) continue;
    sa += x; sb += y; ab += x * y; aa += x * x; bb += y * y; n += 1;
  }
  if (n < minOverlap) return null;
  if (demean) { ab -= (sa * sb) / n; aa -= (sa * sa) / n; bb -= (sb * sb) / n; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null;
}

/** The envelope of a trace (gaps stay gaps). */
function envelope(trace) {
  const { re, im } = analyticSignal(Float64Array.from(trace, (v) => (live(v) ? v : 0)));
  return Float64Array.from(trace, (v, i) => (live(v) ? Math.hypot(re[i], im[i]) : NaN));
}

/** Zero-lag normalized correlation over the mutually live samples. */
export function traceCorrelation(a, b) {
  return corrAt(a, b, 0, Math.min(a.length, b.length) - 1, 0, 8);
}

/**
 * Suggest tie anchors between a synthetic and the seismic at the well.
 *
 * @param {ArrayLike<number>} synthetic on the seismic's time grid (sample 0 at 0 ms)
 * @param {ArrayLike<number>} seismic the trace at the well
 * @param {number} dtMs
 * @param {Partial<typeof AUTO_ANCHOR_DEFAULTS>} [opts]
 * @returns {{ok: boolean, reason?: string, anchors: Array<{synTwtMs, seisTwtMs, corr}>,
 *   bulkShiftMs: number, phiDeg: number, corrBefore: ?number, corrAfter: ?number,
 *   windows: Array<{synTwtMs, shiftMs, corr}>}}
 */
export function suggestTieAnchors(synthetic, seismic, dtMs, opts = {}) {
  const o = { ...AUTO_ANCHOR_DEFAULTS, ...opts };
  if (!(dtMs > 0)) throw new Error('The sample interval must be above zero.');
  if (!(o.maxStrain > 0 && o.maxStrain < 1)) throw new Error('The strain limit must lie between 0 and 1.');
  const n = Math.min(synthetic.length, seismic.length);
  const L = Math.max(1, Math.round(o.maxShiftMs / dtMs));
  const half = Math.max(2, Math.round(o.windowMs / 2 / dtMs));
  const step = Math.max(1, Math.round(o.stepMs / dtMs));
  const M = Math.floor(o.maxStrain * step);
  const minOverlap = Math.max(8, Math.round(half * 0.8));
  const corrBefore = traceCorrelation(synthetic, seismic);
  const empty = (reason) => ({ ok: false, reason, anchors: [], bulkShiftMs: 0, phiDeg: 0, corrBefore, corrAfter: null, windows: [] });

  // 1. bulk shift
  let bulk = 0; let best = -Infinity;
  for (let l = -L; l <= L; l++) {
    const c = corrAt(synthetic, seismic, 0, n - 1, l, 16);
    if (c != null && c > best) { best = c; bulk = l; }
  }
  if (!Number.isFinite(best)) return empty('The synthetic and the seismic overlap too little.');

  // 3-5. local correlations around the bulk shift, the dynamic-programming
  // lag path, and the sub-sample refinement, on a given (rotated) synthetic
  const centres = [];
  for (let c = half; c < n - half; c += step) centres.push(c);
  if (centres.length < 2) return empty('The traces are too short for windowed warping.');
  const W = centres.length;
  // lags searched per window: around the bulk shift (+-L), or around a
  // previous pass's lags (+-2 samples)
  const localShifts = (a, b, { demean = false, around = null } = {}) => {
    const Lw = around ? 2 : L;
    const nlw = 2 * Lw + 1;
    const baseOf = (i) => (around ? Math.round(around[i].shiftMs / dtMs) : bulk);
    const C = centres.map((c, i) => {
      const row = new Float64Array(nlw);
      for (let k = 0; k < nlw; k++) { const v = corrAt(a, b, c - half, c + half, baseOf(i) + k - Lw, minOverlap, demean); row[k] = v == null ? NaN : v; }
      return row;
    });
    // lag index k at window i means lag baseOf(i) + k - Lw; neighbours may differ in base
    const lagOf = (i, k) => baseOf(i) + k - Lw;
    const score = C.map(() => new Float64Array(nlw));
    const from = C.map(() => new Int32Array(nlw));
    const val = (i, k) => (Number.isFinite(C[i][k]) ? C[i][k] : 0);
    for (let k = 0; k < nlw; k++) score[0][k] = val(0, k);
    for (let i = 1; i < W; i++) {
      for (let k = 0; k < nlw; k++) {
        let best = -Infinity; let arg = -1;
        for (let q = 0; q < nlw; q++) {
          const d = Math.abs(lagOf(i, k) - lagOf(i - 1, q));
          if (d > M) continue;
          const sc = score[i - 1][q] - o.penalty * d;
          if (sc > best) { best = sc; arg = q; }
        }
        if (arg < 0) { score[i][k] = -Infinity; from[i][k] = 0; } else { score[i][k] = val(i, k) + best; from[i][k] = arg; }
      }
    }
    const path = new Int32Array(W);
    let kEnd = 0;
    for (let k = 1; k < nlw; k++) if (score[W - 1][k] > score[W - 1][kEnd]) kEnd = k;
    path[W - 1] = kEnd;
    for (let i = W - 1; i > 0; i--) path[i - 1] = from[i][path[i]];
    return centres.map((c, i) => {
      const k = path[i];
      let frac = 0;
      if (k > 0 && k < nlw - 1 && [C[i][k - 1], C[i][k], C[i][k + 1]].every(Number.isFinite)) {
        const den = C[i][k - 1] - 2 * C[i][k] + C[i][k + 1];
        if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (C[i][k - 1] - C[i][k + 1])) / den));
      }
      return { synTwtMs: c * dtMs, shiftMs: (lagOf(i, k) + frac) * dtMs, corr: Number.isFinite(C[i][k]) ? C[i][k] : null };
    });
  };
  const warpOf = (ws) => {
    const a = ws.filter((w) => w.corr != null).map((w) => ({ synTwtMs: w.synTwtMs, seisTwtMs: w.synTwtMs + w.shiftMs }));
    return a.length ? makeTieWarp(a) : makeTieWarp([{ synTwtMs: 0, seisTwtMs: bulk * dtMs }]);
  };

  // 2. the lags first from the envelopes, which a phase error does not
  // move (a phase rotation and a small shift trade off on the waveform);
  // then the constant phase on the synthetic warped by them; then the lags
  // refined on the waveform of the rotated synthetic, within two samples
  const coarse = localShifts(envelope(synthetic), envelope(seismic), { demean: true });
  let phiRad = 0;
  let syn = Float32Array.from(synthetic);
  if (o.phase) {
    const warped = warpTrace(synthetic, dtMs, warpOf(coarse), seismic.length).map((v) => (live(v) ? v : 0));
    const est = estimatePhaseRotation(warped, seismic);
    if (est) {
      phiRad = est.phiRad;
      // the Hilbert transform runs on the zero-filled synthetic (a NaN outside
      // the logged interval would spread through the whole trace, F3 benchmark
      // F-9); the gaps are put back after the rotation
      const rotated = rotateConstantPhase(Float32Array.from(synthetic, (v) => (live(v) ? v : 0)), phiRad);
      syn = Float32Array.from(rotated, (v, i) => (live(synthetic[i]) ? v : NaN));
    }
  }
  const raw = localShifts(syn, seismic, { around: coarse });
  // a light 1-2-1 smoothing of the shifts between confident neighbours: the
  // stretch varies slowly, the noise on each window's lag does not
  const windows = raw.map((w, i) => {
    const a = raw[i - 1]; const b = raw[i + 1];
    if (w.corr == null || !a || !b || a.corr == null || b.corr == null) return w;
    return { ...w, shiftMs: (a.shiftMs + 2 * w.shiftMs + b.shiftMs) / 4 };
  });
  const anchors = windows.filter((w) => w.corr != null && w.corr >= o.minCorr)
    .map((w) => ({ synTwtMs: w.synTwtMs, seisTwtMs: w.synTwtMs + w.shiftMs, corr: w.corr }));
  if (!anchors.length) {
    return { ...empty(`No window matches at a correlation of ${o.minCorr} or more: the synthetic does not follow the seismic here, so no anchors are suggested.`), bulkShiftMs: bulk * dtMs, phiDeg: (phiRad * 180) / Math.PI, windows };
  }
  const warp = makeTieWarp(anchors);
  const corrAfter = traceCorrelation(warpTrace(syn, dtMs, warp, seismic.length), seismic);
  // a window can match noise by chance at the best of many lags; the whole
  // warped trace cannot (on unrelated noise it stays under 0.2), so the
  // suggestion stands only when the warped synthetic follows the seismic
  if (!(corrAfter >= o.minTraceCorr)) {
    return { ...empty(`Even warped, the synthetic follows the seismic at only ${Number.isFinite(corrAfter) ? corrAfter.toFixed(2) : 'no'} correlation (under ${o.minTraceCorr}), so no anchors are suggested. Check the wavelet, the polarity and the well's time-depth.`), bulkShiftMs: bulk * dtMs, phiDeg: (phiRad * 180) / Math.PI, corrAfter, windows };
  }
  return { ok: true, anchors, bulkShiftMs: bulk * dtMs, phiDeg: (phiRad * 180) / Math.PI, corrBefore, corrAfter, windows };
}
