// Prestack gather QC (QI programme Q4b, Milestone C; SOW section 3): what
// a QI study checks on NMO-corrected CDP gathers before AVO or inversion.
//  - NMO stretch: the period of an event at offset x and zero-offset time
//    t0 stretches by t / t0 - 1, t = sqrt(t0^2 + x^2 / v^2) (Yilmaz 2001,
//    Seismic Data Analysis, section 3.2); the offset beyond which the
//    stretch passes a limit is the stretch mute.
//  - Residual moveout: on a gather that should be flat, each offset's shift
//    of the event against the near-offset reference, by cross-correlation in
//    a window (parabolic peak), and the least-squares fit dt = a x^2 (the
//    parabolic residual that a slightly wrong velocity leaves). The residual
//    at the far offset is the number a QC map shows.
//  - Fold: live traces per bin and the far offset still covered.
// Pure, float64.

const fin = Number.isFinite;
const live = (v) => fin(v) && Math.abs(v) < 1e29;

/** Fractional NMO stretch of an event at offset x (m), t0 (s) and NMO velocity v (m/s). */
export function nmoStretch(offsetM, t0S, v) {
  if (!(t0S > 0) || !(v > 0)) return NaN;
  return Math.sqrt(t0S * t0S + (offsetM * offsetM) / (v * v)) / t0S - 1;
}

/** The offset at which the stretch reaches maxStretch (the stretch mute). */
export function stretchMuteOffset(t0S, v, maxStretch) {
  if (!(t0S > 0) || !(v > 0) || !(maxStretch > 0)) return NaN;
  return v * t0S * Math.sqrt((1 + maxStretch) ** 2 - 1);
}

/** Lag (samples, sub-sample by a parabola through the peak) maximising the correlation of b against a over [i0, i1]. */
function bestLag(a, b, i0, i1, maxLag) {
  let best = 0; let bv = -Infinity; const vals = new Map();
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0; let ea = 0; let eb = 0;
    for (let i = i0; i <= i1; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length || !live(a[i]) || !live(b[j])) continue;
      s += a[i] * b[j]; ea += a[i] * a[i]; eb += b[j] * b[j];
    }
    const c = ea > 0 && eb > 0 ? s / Math.sqrt(ea * eb) : -Infinity;
    vals.set(lag, c);
    if (c > bv) { bv = c; best = lag; }
  }
  const l = vals.get(best - 1); const r = vals.get(best + 1);
  let off = 0;
  if (fin(l) && fin(r)) { const den = l - 2 * bv + r; if (den < 0) off = (0.5 * (l - r)) / den; }
  return { lag: best + off, corr: bv };
}

/**
 * Residual moveout of one gather around an event.
 * @param {Object} p
 * @param {ArrayLike<number>[]} p.traces one per offset (bin), NMO-corrected
 * @param {number[]} p.offsets metres
 * @param {number} p.dtMs
 * @param {number} p.centreMs the event time (zero offset)
 * @param {number} [p.windowMs] half window (default 40)
 * @param {number} [p.maxLagMs] largest shift searched (default 24)
 * @param {number} [p.nearCount] near traces stacked for the reference (default 3)
 * @returns {{lagsMs: number[], curvature: number, rmoFarMs: number, farOffset: number, corr: number[], used: number}}
 *   curvature a of dt = a x^2 (ms per m^2); rmoFarMs = a x_far^2
 */
export function residualMoveout({ traces, offsets, dtMs, centreMs, windowMs = 40, maxLagMs = 24, nearCount = 3 }) {
  const order = offsets.map((x, k) => [x, k]).filter(([, k]) => traces[k].some(live)).sort((a, b) => a[0] - b[0]);
  if (order.length < nearCount + 2) return { lagsMs: [], curvature: NaN, rmoFarMs: NaN, farOffset: NaN, corr: [], used: order.length };
  const ns = traces[0].length;
  const ref = new Float64Array(ns);
  for (let i = 0; i < ns; i++) {
    let s = 0; let n = 0;
    for (let q = 0; q < nearCount; q++) { const v = traces[order[q][1]][i]; if (live(v)) { s += v; n += 1; } }
    ref[i] = n ? s / n : NaN;
  }
  const c = Math.round(centreMs / dtMs); const h = Math.round(windowMs / dtMs);
  const i0 = Math.max(0, c - h); const i1 = Math.min(ns - 1, c + h);
  const maxLag = Math.max(1, Math.round(maxLagMs / dtMs));
  const lagsMs = []; const corr = []; let sxy = 0; let sxx = 0;
  for (const [x, k] of order) {
    const { lag, corr: cc } = bestLag(ref, traces[k], i0, i1, maxLag);
    lagsMs.push(lag * dtMs); corr.push(cc);
    if (cc > 0.3) { const x2 = x * x; sxy += x2 * lag * dtMs; sxx += x2 * x2; }
  }
  const a = sxx > 0 ? sxy / sxx : NaN;
  const far = order[order.length - 1][0];
  return { lagsMs, curvature: a, rmoFarMs: a * far * far, farOffset: far, corr, used: order.length };
}

/** Fold per bin and the far offset still covered with at least minFold traces. */
export function foldSummary(fold, centres, minFold = 1) {
  const total = fold.reduce((a, v) => a + v, 0);
  let far = NaN;
  for (let b = 0; b < fold.length; b++) if (fold[b] >= minFold) far = centres[b];
  return { total, farOffset: far, liveBins: fold.filter((v) => v >= minFold).length };
}
