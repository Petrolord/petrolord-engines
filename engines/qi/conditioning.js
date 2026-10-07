// Gather and stack conditioning for QI (QI programme Q5, Milestone C; SOW
// section 7). Conditioning is judged against the geology (synthetic
// gathers at wells, Q6b) and never only by how clean it looks; these are
// the operations, each with what it measured:
//  - trim statics: each trace of an NMO-corrected gather shifted onto the
//    gather's own stack in a window (cross-correlation, sub-sample peak),
//    iterated, the shifts capped;
//  - stack matching: a partial stack brought onto a reference in time
//    (cross-correlation), constant phase (the rotation that maximises the
//    correlation, from the trace and its quadrature) and amplitude (least
//    squares), so AVO compares like with like;
//  - spectral balancing: a zero-phase shaping filter that gives a trace the
//    target amplitude spectrum inside a band (smoothed, tapered).
// Pure, float64.

import { fft, nextPow2 } from '../../lib/fft.js';

const fin = Number.isFinite;
const live = (v) => fin(v) && Math.abs(v) < 1e29;

/** A trace delayed by shiftMs (positive later), linear interpolation; samples from outside stay null. */
export function shiftTrace(trace, shiftMs, dtMs) {
  const s = shiftMs / dtMs; const n = trace.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i - s; const j = Math.floor(x); const f = x - j;
    if (j < 0 || j >= n - 1 || !live(trace[j]) || !live(trace[j + 1])) {
      out[i] = j === n - 1 && f < 1e-9 && live(trace[j]) ? trace[j] : NaN;
      continue;
    }
    out[i] = trace[j] + f * (trace[j + 1] - trace[j]);
  }
  return out;
}

/** Lag (samples, sub-sample) of b against a in [i0, i1], the correlation at it. */
export function correlationLag(a, b, i0, i1, maxLag) {
  const nl = 2 * maxLag + 1;
  const vals = new Float64Array(nl).fill(-Infinity);
  let best = 0; let bv = -Infinity;
  for (let q = 0; q < nl; q++) {
    const lag = q - maxLag;
    let s = 0; let ea = 0; let eb = 0;
    const lo = Math.max(i0, -lag); const hi = Math.min(i1, b.length - 1 - lag);
    for (let i = lo; i <= hi; i++) {
      const x = a[i]; const y = b[i + lag];
      if (!live(x) || !live(y)) continue;
      s += x * y; ea += x * x; eb += y * y;
    }
    const c = ea > 0 && eb > 0 ? s / Math.sqrt(ea * eb) : -Infinity;
    vals[q] = c;
    if (c > bv) { bv = c; best = lag; }
  }
  const qb = best + maxLag;
  const l = qb > 0 ? vals[qb - 1] : -Infinity; const r = qb < nl - 1 ? vals[qb + 1] : -Infinity;
  let off = 0;
  if (fin(l) && fin(r)) { const den = l - 2 * bv + r; if (den < 0) off = (0.5 * (l - r)) / den; }
  return { lag: best + off, corr: bv };
}

/**
 * Trim statics: flatten a gather onto its own stack.
 * @returns {{traces: Float64Array[], shiftsMs: number[], corrBefore: number, corrAfter: number}}
 *   corr: the mean correlation of each trace with the stack in the window
 */
export function trimStatics({ traces, dtMs, centreMs, windowMs = 60, maxShiftMs = 12, iterations = 2 }) {
  const ns = traces[0].length;
  const c = Math.round(centreMs / dtMs); const h = Math.round(windowMs / dtMs);
  const i0 = Math.max(0, c - h); const i1 = Math.min(ns - 1, c + h);
  const maxLag = Math.max(1, Math.round(maxShiftMs / dtMs));
  const stackOf = (trs) => {
    const out = new Float64Array(ns);
    for (let i = 0; i < ns; i++) { let s = 0; let n = 0; for (let k = 0; k < trs.length; k++) { const v = trs[k][i]; if (live(v)) { s += v; n += 1; } } out[i] = n ? s / n : NaN; }
    return out;
  };
  const meanCorr = (trs) => { const st = stackOf(trs); const cs = trs.map((t) => correlationLag(st, t, i0, i1, 0).corr).filter(fin); return cs.reduce((a, v) => a + v, 0) / (cs.length || 1); };
  const corrBefore = meanCorr(traces);
  let cur = traces.map((t) => Float64Array.from(t));
  const total = traces.map(() => 0);
  for (let it = 0; it < iterations; it++) {
    const st = stackOf(cur);
    cur = cur.map((t, k) => {
      const { lag } = correlationLag(st, t, i0, i1, maxLag);
      const shift = Math.max(-maxShiftMs, Math.min(maxShiftMs, -lag * dtMs));
      if (Math.abs(total[k] + shift) > maxShiftMs) return t;
      total[k] += shift;
      return shiftTrace(t, shift, dtMs);
    });
  }
  return { traces: cur, shiftsMs: total, corrBefore, corrAfter: meanCorr(cur) };
}

/** The quadrature (90 degree rotated) trace by the analytic signal. */
export function quadrature(trace) {
  const n = trace.length; const N = nextPow2(n) * 2;
  const re = new Float64Array(N); const im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = live(trace[i]) ? trace[i] : 0;
  fft(re, im, false);
  // multiply by -i sign(f): the Hilbert transform
  for (let k = 1; k < N / 2; k++) { const a = re[k]; re[k] = im[k]; im[k] = -a; }
  for (let k = N / 2 + 1; k < N; k++) { const a = re[k]; re[k] = -im[k]; im[k] = a; }
  re[0] = 0; im[0] = 0; re[N / 2] = 0; im[N / 2] = 0;
  fft(re, im, true);
  return re.subarray(0, n);
}

/** A trace rotated by a constant phase (degrees): cos(phi) x - sin(phi) H[x]. */
export function rotatePhase(trace, phaseDeg) {
  const q = quadrature(trace); const c = Math.cos(phaseDeg * Math.PI / 180); const s = Math.sin(phaseDeg * Math.PI / 180);
  return Float64Array.from(trace, (v, i) => (live(v) ? c * v - s * q[i] : NaN));
}

/**
 * Match a target stack trace onto a reference: time shift and constant
 * phase together (the shift maximises the envelope of the cross-correlation,
 * which a phase rotation does not move; the phase is then the rotation that
 * maximises the correlation at that shift), then amplitude by least squares.
 * @returns {{shiftMs, phaseDeg, scale, corrBefore, corrAfter, matched: Float64Array}}
 */
export function matchStacks(reference, target, dtMs, { maxShiftMs = 20 } = {}) {
  const n = reference.length;
  const maxLag = Math.max(1, Math.round(maxShiftMs / dtMs));
  const before = correlationLag(reference, target, 0, n - 1, 0).corr;
  const x = Float64Array.from(target, (v) => (live(v) ? v : 0));
  const hx = quadrature(x);
  const at = (lag) => {
    let c = 0; let h = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n || !live(reference[i]) || !live(target[j])) continue;
      c += x[j] * reference[i]; h += hx[j] * reference[i];
    }
    return { c, h, env: Math.hypot(c, h) };
  };
  let best = 0; let bv = -Infinity; const env = new Map();
  for (let lag = -maxLag; lag <= maxLag; lag++) { const r = at(lag); env.set(lag, r.env); if (r.env > bv) { bv = r.env; best = lag; } }
  const l = env.get(best - 1); const r0 = env.get(best + 1);
  let off = 0;
  if (fin(l) && fin(r0)) { const den = l - 2 * bv + r0; if (den < 0) off = (0.5 * (l - r0)) / den; }
  const shiftMs = -(best + off) * dtMs;
  const shifted = shiftTrace(target, shiftMs, dtMs);
  const sh0 = shifted.map((v) => (live(v) ? v : 0));
  const q = quadrature(sh0);
  let xr = 0; let hr = 0;
  for (let i = 0; i < n; i++) if (live(shifted[i]) && live(reference[i])) { xr += sh0[i] * reference[i]; hr += q[i] * reference[i]; }
  const phaseDeg = (Math.atan2(-hr, xr) * 180) / Math.PI;
  const rotated = rotatePhase(sh0, phaseDeg).map((v, i) => (live(shifted[i]) ? v : NaN));
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i++) if (live(rotated[i]) && live(reference[i])) { sxy += rotated[i] * reference[i]; sxx += rotated[i] * rotated[i]; }
  const scale = sxx > 0 ? sxy / sxx : NaN;
  const matched = rotated.map((v) => v * scale);
  return { shiftMs, phaseDeg, scale, corrBefore: before, corrAfter: correlationLag(reference, matched, 0, n - 1, 0).corr, matched };
}

/**
 * Spectral balancing: a zero-phase filter giving the trace the target
 * amplitude spectrum inside [fLo, fHi] (cosine tapers of taperHz outside),
 * both spectra smoothed over smoothHz.
 * @param {(f: number) => number} targetAmp
 */
export function spectralBalance(trace, targetAmp, dtMs, { fLo = 5, fHi = 80, taperHz = 5, smoothHz = 5 } = {}) {
  const n = trace.length; const N = nextPow2(n) * 2; const df = 1000 / (N * dtMs);
  const re = new Float64Array(N); const im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = live(trace[i]) ? trace[i] : 0;
  fft(re, im, false);
  const amp = Float64Array.from({ length: N / 2 + 1 }, (_, k) => Math.hypot(re[k], im[k]));
  const h = Math.max(1, Math.round(smoothHz / df));
  const sm = Float64Array.from(amp, (_, k) => { let s = 0; let c = 0; for (let j = Math.max(0, k - h); j <= Math.min(amp.length - 1, k + h); j++) { s += amp[j]; c += 1; } return s / c; });
  const ref = sm.reduce((a, v) => Math.max(a, v), 0);
  for (let k = 0; k <= N / 2; k++) {
    const f = k * df;
    let w = 1;
    if (f < fLo) w = f < fLo - taperHz ? 0 : 0.5 * (1 + Math.cos((Math.PI * (fLo - f)) / taperHz));
    if (f > fHi) w = f > fHi + taperHz ? 0 : 0.5 * (1 + Math.cos((Math.PI * (f - fHi)) / taperHz));
    const g = sm[k] > 1e-6 * ref ? (w * targetAmp(f)) / sm[k] : 0;
    re[k] *= g; im[k] *= g;
    if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
  }
  fft(re, im, true);
  return Float64Array.from({ length: n }, (_, i) => (live(trace[i]) ? re[i] : NaN));
}
