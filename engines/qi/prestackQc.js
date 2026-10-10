// Prestack gather QC (QI programme Q4b, Milestone C; SOW section 3): what
// a QI study checks on NMO-corrected CDP gathers before AVO or inversion.
//  - NMO stretch: the period of an event at offset x and zero-offset time
//    t0 stretches by t / t0 - 1, t = sqrt(t0^2 + x^2 / v^2) (Yilmaz 2001,
//    Seismic Data Analysis, section 3.2); the offset beyond which the
//    stretch passes a limit is the stretch mute.
//  - Residual moveout: on a gather that should be flat, each offset's shift
//    of the event against the near-offset pilot, by cross-correlation in a
//    window (|correlation| peak, offsets whose waveform no longer resembles
//    the pilot left out, see residualMoveout), and the weighted fit
//    dt = a x^2 (the parabolic residual that a slightly wrong velocity
//    leaves). The residual at the far offset is the number a QC map shows.
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

// Residual moveout, found two ways and checked against each other.
// The first version cross-correlated every offset against a near-offset pilot
// and took the SIGNED correlation peak; where the amplitude changes across
// offset (a class I top that dims and flips polarity, two close events with
// opposite AVO, a tuned thin bed) the peak jumps to another cycle, and flat
// gathers read 5 to 33 ms of residual (the Ekene demo gathers, flat by
// construction, raised "flatten the gathers" issues, found 2026-10-10).
//  1. Correlation against the pilot, now on the |correlation| peak (a polarity
//     reversal is not a half-period shift), with only offsets whose waveform
//     still resembles the pilot (|correlation| >= MIN_CORR) in a fit weighted
//     by the squared correlation. Where the waveform holds across offset, the
//     lags sit on the parabola and this is the sharper measure.
//  2. Where they do not (weighted scatter about the fitted parabola above one
//     sample), the waveform has changed with offset and the lags are not
//     timing. Then AB semblance (Sarkar, Castagna and Lamb 2002, Geophysics
//     67, 1393): each trial curvature flattens the gather, every time sample
//     is fitted across offset with A + B u (u = x / x_far), and the
//     curvature whose fit explains the most energy wins. A flat gather with
//     linear AVO, polarity changes and composite events included, fits
//     exactly at zero; its weakness, a small moveout on a gather with little
//     AVO, is the case step 1 already covers.
// With fewer than nearCount + 2 usable offsets the gather has no measure.

const MIN_CORR = 0.7;

/** Lag (samples, sub-sample by a parabola through the peak) maximising |correlation| of b against a over [i0, i1]; corr is signed at the peak. */
function bestLag(a, b, i0, i1, maxLag) {
  let best = 0; let bv = -Infinity; const vals = new Map();
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0; let ea = 0; let eb = 0;
    for (let i = i0; i <= i1; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length || !live(a[i]) || !live(b[j])) continue;
      s += a[i] * b[j]; ea += a[i] * a[i]; eb += b[j] * b[j];
    }
    const c = ea > 0 && eb > 0 ? s / Math.sqrt(ea * eb) : NaN;
    vals.set(lag, c);
    if (fin(c) && Math.abs(c) > bv) { bv = Math.abs(c); best = lag; }
  }
  if (!fin(bv)) return { lag: 0, corr: NaN };
  const peak = vals.get(best);
  const sgn = Math.sign(peak) || 1;
  const l = sgn * vals.get(best - 1); const r = sgn * vals.get(best + 1); const m = sgn * peak;
  let off = 0;
  if (fin(l) && fin(r)) { const den = l - 2 * m + r; if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)); }
  return { lag: best + off, corr: peak };
}

/** Linear interpolation of a trace at fractional sample position p (NaN outside or on a gap). */
function sampleAt(tr, p) {
  const i = Math.floor(p); const f = p - i;
  if (i < 0 || i + 1 >= tr.length) return NaN;
  const a = tr[i]; const b = tr[i + 1];
  if (!live(a) || !live(b)) return NaN;
  return a + f * (b - a);
}

/** Energy of y explained by its least-squares line on u, and the total energy. */
function lineFitEnergy(u, y) {
  const n = y.length; let su = 0; let sy = 0; let suu = 0; let suy = 0; let syy = 0;
  for (let k = 0; k < n; k++) { su += u[k]; sy += y[k]; suu += u[k] * u[k]; suy += u[k] * y[k]; syy += y[k] * y[k]; }
  const det = n * suu - su * su;
  if (!(Math.abs(det) > 1e-12)) return { fit: 0, tot: syy };
  const b = (n * suy - su * sy) / det; const a0 = (sy - b * su) / n;
  let fit = 0;
  for (let k = 0; k < n; k++) { const v = a0 + b * u[k]; fit += v * v; }
  return { fit, tot: syy };
}

/** AB semblance of the gather flattened by curvature a (ms per m^2) over window samples [i0, i1]. */
function abSemblance(tr, xs, dtMs, i0, i1, a) {
  const far = xs[xs.length - 1];
  let fit = 0; let tot = 0;
  for (let i = i0; i <= i1; i++) {
    const u = []; const y = [];
    for (let k = 0; k < tr.length; k++) {
      const v = sampleAt(tr[k], i + (a * xs[k] * xs[k]) / dtMs);
      if (fin(v)) { u.push(xs[k] / far); y.push(v); }
    }
    if (y.length < 4) continue;
    const e = lineFitEnergy(u, y); fit += e.fit; tot += e.tot;
  }
  return tot > 0 ? fit / tot : NaN;
}

/** The far-offset residual (ms) maximising AB semblance, scanned in quarter samples and refined by a parabola. */
function abSemblanceRmo(tr, xs, dtMs, i0, i1, maxLagMs) {
  const far = xs[xs.length - 1];
  const step = dtMs / 4; const n = Math.round(maxLagMs / step);
  let best = 0; let bv = -Infinity; const vals = new Map();
  for (let j = -n; j <= n; j++) {
    const v = abSemblance(tr, xs, dtMs, i0, i1, (j * step) / (far * far));
    vals.set(j, v);
    if (fin(v) && v > bv) { bv = v; best = j; }
  }
  if (!fin(bv)) return NaN;
  const l = vals.get(best - 1); const r = vals.get(best + 1);
  let off = 0;
  if (fin(l) && fin(r)) { const den = l - 2 * bv + r; if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)); }
  return (best + off) * step;
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
 * @param {number} [p.nearCount] near traces stacked for the pilot (default 3)
 * @returns {{lagsMs: number[], curvature: number, rmoFarMs: number, farOffset: number, corr: number[], used: number, fitted: number, method: string}}
 *   curvature a of dt = a x^2 (ms per m^2); rmoFarMs = a x_far^2; corr signed at each offset's peak;
 *   fitted the offsets that carried a lag into the correlation fit; method 'correlation' or 'ab-semblance'
 */
export function residualMoveout({ traces, offsets, dtMs, centreMs, windowMs = 40, maxLagMs = 24, nearCount = 3 }) {
  const order = offsets.map((x, k) => [x, k]).filter(([, k]) => traces[k].some(live)).sort((a, b) => a[0] - b[0]);
  const none = (used, lagsMs = [], corr = [], fitted = 0) => ({ lagsMs, curvature: NaN, rmoFarMs: NaN, farOffset: NaN, corr, used, fitted });
  if (order.length < nearCount + 2) return none(order.length);
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
  const lagsMs = []; const corr = []; let sxy = 0; let sxx = 0; let fitted = 0;
  for (const [x, k] of order) {
    const { lag, corr: cc } = bestLag(ref, traces[k], i0, i1, maxLag);
    lagsMs.push(lag * dtMs); corr.push(cc);
    if (Math.abs(cc) >= MIN_CORR) { const w = cc * cc; const x2 = x * x; sxy += w * x2 * lag * dtMs; sxx += w * x2 * x2; fitted += 1; }
  }
  const far = order[order.length - 1][0];
  const xs = order.map(([x]) => x);
  let a = fitted >= nearCount + 2 && sxx > 0 ? sxy / sxx : NaN;
  let method = 'correlation';
  if (fin(a)) {
    // do the lags sit on the parabola? weighted RMS scatter in ms
    let sw = 0; let se = 0;
    order.forEach(([x], q) => { if (Math.abs(corr[q]) >= MIN_CORR) { const w = corr[q] * corr[q]; sw += w; se += w * (lagsMs[q] - a * x * x) ** 2; } });
    if (Math.sqrt(se / sw) > dtMs) a = NaN;
  }
  if (!fin(a)) {
    const rmo = abSemblanceRmo(order.map(([, k]) => traces[k]), xs, dtMs, i0, i1, maxLagMs);
    if (!fin(rmo)) return none(order.length, lagsMs, corr, fitted);
    a = rmo / (far * far); method = 'ab-semblance';
  }
  return { lagsMs, curvature: a, rmoFarMs: a * far * far, farOffset: far, corr, used: order.length, fitted, method };
}

/** Fold per bin and the far offset still covered with at least minFold traces. */
export function foldSummary(fold, centres, minFold = 1) {
  const total = fold.reduce((a, v) => a + v, 0);
  let far = NaN;
  for (let b = 0; b < fold.length; b++) if (fold[b] >= minFold) far = centres[b];
  return { total, farOffset: far, liveBins: fold.filter((v) => v >= minFold).length };
}
