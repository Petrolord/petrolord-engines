// Phase along the tie (QI round 3, 2026-10-15; tie quality after Suggest
// anchors): the constant phase of the Synthetics tie measured window by
// window down the logged interval, a straight-line trend through it, and
// the synthetic rotated by that time-variant phase. A constant-phase wavelet
// is the usual tie, and it breaks when the seismic phase drifts with time
// (absorption without Q compensation, a processing filter that is not zero
// phase at depth); the profile shows where, and by how much.
//
// Convention (the same as tieWarp.js rotateConstantPhase):
//   rot(s, phi) = cos(phi) s + sin(phi) H[s],   H the Hilbert transform
// (the imaginary part of the analytic signal of the WHOLE synthetic, so the
// windowed sums never see a windowed transform's edge effects). In each
// window the best phase is atan2(<H s, r>, <s, r>) and its correlation is
// computed exactly from the window's energies.
//
// Pure maths, worker-safe, no I/O. Gaps (null and NaN) never enter a sum.

import { analyticSignal } from './attributes';
import { isGap } from '../../lib/waveform';

const live = (v) => !isGap(v) && Number.isFinite(v);
const NULL_F32 = 1e30;

export const TIE_PHASE_DEFAULTS = Object.freeze({ windowMs: 300, stepMs: 100, minOverlap: 20, minCorr: 0.3, minDriftDeg: 30, minGain: 0.03 });

/** Wrap degrees into (-180, 180]. */
export const wrapDeg = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x; };

function sums(s, h, r, i0, i1) {
  let sr = 0; let hr = 0; let ss = 0; let hh = 0; let sh = 0; let rr = 0; let m = 0;
  for (let i = i0; i <= i1; i++) {
    const a = s[i]; const b = r[i];
    if (!live(a) || !live(b)) continue;
    const q = h[i];
    sr += a * b; hr += q * b; ss += a * a; hh += q * q; sh += a * q; rr += b * b; m++;
  }
  return { sr, hr, ss, hh, sh, rr, m };
}

const corrAt = (S, phi) => {
  const c = Math.cos(phi); const sn = Math.sin(phi);
  const num = c * S.sr + sn * S.hr;
  const e = c * c * S.ss + sn * sn * S.hh + 2 * c * sn * S.sh;
  return e > 0 && S.rr > 0 ? num / Math.sqrt(e * S.rr) : null;
};

/**
 * The best constant phase in windows down the tie.
 * @returns {Array<{twtMs:number, phiDeg:number|null, corr0:number|null, corr:number|null, overlap:number}>}
 */
export function phaseProfile(synthetic, seismic, dtMs, opts = {}) {
  const o = { ...TIE_PHASE_DEFAULTS, ...opts };
  const n = Math.min(synthetic.length, seismic.length);
  const s = Float64Array.from({ length: n }, (_, i) => (live(synthetic[i]) ? synthetic[i] : NaN));
  const { im } = analyticSignal(Float64Array.from(s, (v) => (Number.isFinite(v) ? v : 0)));
  const half = Math.max(2, Math.round(o.windowMs / 2 / dtMs)); const step = Math.max(1, Math.round(o.stepMs / dtMs));
  const rows = [];
  for (let c = 0; c < n; c += step) {
    const S = sums(s, im, seismic, Math.max(0, c - half), Math.min(n - 1, c + half));
    if (S.m < o.minOverlap || (S.sr === 0 && S.hr === 0)) continue;
    const phi = Math.atan2(S.hr, S.sr);
    rows.push({ twtMs: c * dtMs, phiDeg: (phi * 180) / Math.PI, corr0: corrAt(S, 0), corr: corrAt(S, phi), overlap: S.m });
  }
  return rows;
}

/**
 * A straight line phi(t) = a + b t through the window phases that correlate
 * at minCorr or more, unwrapped around their circular mean and weighted by
 * correlation.
 * @returns {?{aDeg:number, bDegPerS:number, t0Ms:number, t1Ms:number, driftDeg:number, rmsDeg:number, windows:number}}
 *   aDeg is the phase at t0Ms; null with fewer than three windows
 */
export function phaseTrend(profile, { minCorr = TIE_PHASE_DEFAULTS.minCorr } = {}) {
  const use = profile.filter((r) => Number.isFinite(r.phiDeg) && r.corr >= minCorr);
  if (use.length < 3) return null;
  let cs = 0; let sn = 0; for (const r of use) { cs += r.corr * Math.cos((r.phiDeg * Math.PI) / 180); sn += r.corr * Math.sin((r.phiDeg * Math.PI) / 180); }
  const mean = (Math.atan2(sn, cs) * 180) / Math.PI;
  // unwrap in time order: each phase within 180 degrees of its predecessor
  const pts = []; let prev = mean;
  for (const r of use) { const p = prev + wrapDeg(r.phiDeg - prev); pts.push({ t: r.twtMs, p, w: r.corr }); prev = p; }
  const t0 = pts[0].t; const W = pts.reduce((a, q) => a + q.w, 0);
  const mt = pts.reduce((a, q) => a + q.w * (q.t - t0), 0) / W; const mp = pts.reduce((a, q) => a + q.w * q.p, 0) / W;
  let stt = 0; let stp = 0; for (const q of pts) { stt += q.w * (q.t - t0 - mt) ** 2; stp += q.w * (q.t - t0 - mt) * (q.p - mp); }
  const b = stt > 0 ? stp / stt : 0; const a = mp - b * mt; // degrees per ms, at t0
  const rms = Math.sqrt(pts.reduce((acc, q) => acc + q.w * (q.p - (a + b * (q.t - t0))) ** 2, 0) / W);
  const t1 = pts[pts.length - 1].t;
  return { aDeg: wrapDeg(a), bDegPerS: b * 1000, t0Ms: t0, t1Ms: t1, driftDeg: b * (t1 - t0), rmsDeg: rms, windows: pts.length };
}

/** The phase (degrees) of a trend at time t, held flat outside its interval. */
export function trendPhaseAt(trend, tMs) {
  const t = Math.min(trend.t1Ms, Math.max(trend.t0Ms, tMs));
  return trend.aDeg + (trend.bDegPerS / 1000) * (t - trend.t0Ms);
}

/** The synthetic rotated by a phase that varies with time (degrees from phiDegAt(tMs)); gaps stay gaps. */
export function rotateTimeVariant(trace, dtMs, phiDegAt) {
  const { im } = analyticSignal(Float64Array.from(trace, (v) => (live(v) ? v : 0)));
  const out = new Float32Array(trace.length);
  for (let i = 0; i < trace.length; i++) {
    const v = trace[i];
    if (!live(v)) { out[i] = NULL_F32; continue; }
    const p = (phiDegAt(i * dtMs) * Math.PI) / 180;
    out[i] = Math.cos(p) * v + Math.sin(p) * im[i];
  }
  return out;
}

const corrWhole = (a, b) => {
  let num = 0; let aa = 0; let bb = 0; let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { if (!live(a[i]) || !live(b[i]) || Math.abs(a[i]) >= 1e29) continue; num += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; m++; }
  return m > 0 && aa > 0 && bb > 0 ? num / Math.sqrt(aa * bb) : null;
};

/**
 * The check the Synthetics panel runs: the profile, the trend, the
 * correlation with one constant phase and with the time-variant phase, and
 * whether the time-variant phase is worth offering (the drift reaches
 * minDriftDeg and the correlation rises by minGain or more).
 */
export function timeVariantPhaseCheck(synthetic, seismic, dtMs, opts = {}) {
  const o = { ...TIE_PHASE_DEFAULTS, ...opts };
  const profile = phaseProfile(synthetic, seismic, dtMs, o);
  const whole = phaseProfile(synthetic, seismic, dtMs, { ...o, windowMs: 2 * synthetic.length * dtMs + 2 * dtMs, stepMs: 1e9 })[0] || null;
  const trend = phaseTrend(profile, o);
  const constantDeg = whole ? whole.phiDeg : null;
  const corrConstant = whole ? whole.corr : null;
  let corrTimeVariant = null; let rotated = null;
  if (trend) { rotated = rotateTimeVariant(synthetic, dtMs, (t) => trendPhaseAt(trend, t)); corrTimeVariant = corrWhole(rotated, seismic); }
  const gain = Number.isFinite(corrTimeVariant) && Number.isFinite(corrConstant) ? corrTimeVariant - corrConstant : null;
  const offer = !!trend && Math.abs(trend.driftDeg) >= o.minDriftDeg && gain != null && gain >= o.minGain;
  return { profile, trend, constantDeg, corrConstant, corrTimeVariant, gain, offer, rotated };
}
