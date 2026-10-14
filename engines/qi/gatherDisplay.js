// Gather display maths for the QI Studio gather viewer (QI upgrade P1.7,
// 2026-10-15; closes QI-UPGRADE U2-004): normal moveout correction of an
// offset gather with an RMS velocity function, the incidence-angle field of
// an NMO-corrected gather (Walden's straight ray, qi/prestack.js), the time
// each offset reaches a given angle (the angle overlay and the angle mute)
// and the earliest time each offset is inside a stretch limit (the stretch
// mute line, qi/prestackQc.js). Pure, float64.
//
// NMO: a reflection at zero-offset time t0 arrives at offset x at
//   t(x) = sqrt(t0^2 + x^2 / Vrms(t0)^2)
// (the hyperbola of a flat reflector under Vrms; Dix 1955, Yilmaz 2001
// section 3.2). The corrected sample at t0 is the input read at t(x) by
// linear interpolation. Samples whose stretch t / t0 - 1 passes the limit
// are muted (null), the usual stretch mute.

import { waldenAngle } from './prestack.js';
import { nmoStretch } from './prestackQc.js';

const fin = Number.isFinite;
const live = (v) => fin(v) && Math.abs(v) < 1e29;

/**
 * NMO-correct an offset gather.
 * @param {Object} p
 * @param {ArrayLike<number>[]} p.traces one per offset, ns samples (nulls non-finite or |v| >= 1e29)
 * @param {number[]} p.offsets metres, one per trace
 * @param {ArrayLike<number>} p.vrms RMS velocity at each output sample's t0 (m/s)
 * @param {number} p.dtMs
 * @param {number} [p.t0Ms] time of the first sample
 * @param {?number} [p.maxStretch] mute where the stretch passes this (fraction); null keeps every sample
 * @returns {Float64Array[]} corrected traces, NaN where muted or off the input
 */
export function nmoCorrect({ traces, offsets, vrms, dtMs, t0Ms = 0, maxStretch = null }) {
  if (traces.length !== offsets.length) throw new Error('Give one offset per trace.');
  const ns = vrms.length;
  return traces.map((tr, j) => {
    const x = offsets[j];
    const out = new Float64Array(ns).fill(NaN);
    for (let i = 0; i < ns; i++) {
      const t0 = (t0Ms + i * dtMs) / 1000;
      const v = vrms[i];
      if (!(v > 0)) continue;
      if (maxStretch != null && x > 0) {
        if (!(t0 > 0)) continue;
        if (nmoStretch(x, t0, v) > maxStretch) continue;
      }
      const t = Math.sqrt(t0 * t0 + (x * x) / (v * v));
      const f = (t * 1000 - t0Ms) / dtMs;
      const k = Math.floor(f);
      if (k < 0 || k >= tr.length) continue;
      const a = tr[k];
      if (!live(a)) continue;
      if (k === tr.length - 1) { out[i] = f === k ? a : NaN; continue; }
      const b = tr[k + 1];
      const w = f - k;
      if (w === 0) out[i] = a;
      else if (live(b)) out[i] = a + w * (b - a);
    }
    return out;
  });
}

/**
 * The incidence angle (degrees) of every sample of an NMO-corrected gather.
 * @param {{offsets: number[], vrms: ArrayLike<number>, vint: ArrayLike<number>, dtMs: number, t0Ms?: number}} p
 * @returns {Float64Array[]} one per offset (NaN at t0 = 0)
 */
export function angleField({ offsets, vrms, vint, dtMs, t0Ms = 0 }) {
  const ns = vrms.length;
  return offsets.map((x) => Float64Array.from({ length: ns }, (_, i) => waldenAngle(x, (t0Ms + i * dtMs) / 1000, vrms[i], vint[i])));
}

/**
 * For each offset, the t0 (ms) at which the angle falls to angleDeg (the
 * angle decreases with time at a fixed offset): the angle contour, also the
 * angle mute (above it the angle is larger). Linear between samples. NaN
 * when the offset never reaches the angle inside the trace (it is smaller
 * everywhere: no mute) and t0Ms when it is smaller from the first sample.
 * @param {Float64Array[]} field angleField output
 */
export function angleContour(field, { angleDeg, dtMs, t0Ms = 0 }) {
  return field.map((a) => {
    let prev = NaN;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!fin(v)) { prev = v; continue; }
      if (v <= angleDeg) {
        if (!fin(prev) || i === 0) return t0Ms + i * dtMs;
        const f = (prev - angleDeg) / (prev - v);
        return t0Ms + (i - 1 + f) * dtMs;
      }
      prev = v;
    }
    return NaN;
  });
}

/**
 * For each offset, the earliest t0 (ms) from which the NMO stretch stays
 * within maxStretch: the stretch-mute line. Uses the RMS velocity at each
 * sample, so a varying velocity function is honoured. NaN when the stretch
 * never comes within the limit inside the trace.
 */
export function stretchMuteTimes({ offsets, vrms, dtMs, maxStretch, t0Ms = 0 }) {
  if (!(maxStretch > 0)) throw new Error('The stretch limit must be positive.');
  return offsets.map((x) => {
    if (!(x > 0)) return t0Ms;
    let last = NaN;
    for (let i = vrms.length - 1; i >= 0; i--) {
      const t0 = (t0Ms + i * dtMs) / 1000;
      if (!(t0 > 0) || !(nmoStretch(x, t0, vrms[i]) <= maxStretch)) break;
      last = t0Ms + i * dtMs;
    }
    return last;
  });
}
