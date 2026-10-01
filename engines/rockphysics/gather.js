// Angle-gather synthetic (Rock Physics Studio U2-003, 2026-10-01).
//
// One trace per incidence angle: the reflection coefficient of every
// interface at that angle (exact Zoeppritz, real part, or Aki-Richards),
// placed in two-way time and convolved with a wavelet. This is the
// convolutional angle gather of Hampson-Russell AVO and RokDoc: a constant
// incidence angle per trace, primaries only, no transmission loss, no
// spreading, no NMO stretch. The reflectivity comes from ./avo (oracle
// validated; the exact curve reproduces the two polarity reversals at 25
// and 49 degrees published by van der Baan and Smit, 2006, Geophysics 71,
// C93, for their model 1), the wavelet from the shared waveform primitives.
//
// SI throughout (m, m/s, kg/m3); time in ms two-way; angles in degrees.
// Pure math, worker-safe, no I/O.

import { rickerWavelet, convolveSame } from '../../lib/waveform';
import { rotateConstantPhase } from '../seismolord/tieWarp';
import { zoeppritzRpp, akiRichards } from './avo';

export const GATHER_METHODS = Object.freeze(['zoeppritz', 'aki-richards']);

const finite = (...xs) => xs.every((x) => Number.isFinite(x));

/**
 * PP reflection coefficient of one interface at one angle.
 * Zoeppritz returns the real part of the exact coefficient and says when
 * the angle is past critical (the coefficient is then complex);
 * Aki-Richards is undefined past critical and returns NaN there.
 * @returns {{r: number, postCritical: boolean}}
 */
export function interfaceReflectivity(vp1, vs1, rho1, vp2, vs2, rho2, thetaDeg, method = 'zoeppritz') {
  if (!GATHER_METHODS.includes(method)) throw new Error(`Unknown reflectivity method "${method}".`);
  const postCritical = vp2 > vp1 && Math.sin((thetaDeg * Math.PI) / 180) * (vp2 / vp1) >= 1;
  if (method === 'aki-richards') {
    if (postCritical) return { r: NaN, postCritical };
    return { r: akiRichards(vp1, vs1, rho1, vp2, vs2, rho2, thetaDeg), postCritical };
  }
  return { r: zoeppritzRpp(vp1, vs1, rho1, vp2, vs2, rho2, thetaDeg).re, postCritical };
}

/**
 * A Ricker wavelet rotated by a constant phase (0 = zero phase). The
 * rotation is the one the well tie measures and applies
 * (seismolord/tieWarp rotateConstantPhase: cos(phi) w + sin(phi) H[w]).
 * @returns {Float32Array} odd length, unit peak before rotation
 */
export function phaseRotatedRicker(freqHz, dtMs, phaseDeg = 0, halfLengthMs = 60) {
  const w = rickerWavelet(freqHz, dtMs, halfLengthMs);
  if (!Number.isFinite(phaseDeg) || phaseDeg === 0) return w;
  return rotateConstantPhase(w, (phaseDeg * Math.PI) / 180);
}

/**
 * Two-way time (ms) at each depth sample, from the first sample, by
 * integrating slowness (trapezoid). Samples must be finite and increasing.
 */
export function twoWayTimeMs(depth, vp) {
  const n = depth.length;
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dz = depth[i] - depth[i - 1];
    if (!(dz > 0) || !(vp[i] > 0) || !(vp[i - 1] > 0)) throw new Error('Depths must increase and velocities must be positive to convert depth to time.');
    t[i] = t[i - 1] + 2000 * dz * 0.5 * (1 / vp[i] + 1 / vp[i - 1]);
  }
  return t;
}

/**
 * Depth logs onto a regular two-way-time grid (linear interpolation in
 * time). Samples with a gap in any of the four curves are dropped before
 * the conversion and counted; the time axis starts at the first usable
 * sample.
 * @param {{depth: ArrayLike<number>, vp: ArrayLike<number>, vs: ArrayLike<number>, rho: ArrayLike<number>}} logs
 * @param {number} dtMs
 * @returns {{tMs: Float64Array, depth: Float64Array, vp: Float64Array, vs: Float64Array, rho: Float64Array, dropped: number, used: number}}
 */
export function logsToTime(logs, dtMs) {
  if (!(dtMs > 0)) throw new Error('The time sample must be positive.');
  const z = []; const p = []; const s = []; const r = [];
  let dropped = 0;
  for (let i = 0; i < logs.depth.length; i++) {
    const zi = logs.depth[i]; const pi = logs.vp[i]; const si = logs.vs[i]; const ri = logs.rho[i];
    if (finite(zi, pi, si, ri) && pi > 0 && si > 0 && ri > 0 && (!z.length || zi > z[z.length - 1])) {
      z.push(zi); p.push(pi); s.push(si); r.push(ri);
    } else dropped += 1;
  }
  if (z.length < 2) throw new Error('Fewer than two usable samples: the gather needs Vp, Vs and density over the window.');
  const t = twoWayTimeMs(z, p);
  const nt = Math.floor(t[t.length - 1] / dtMs) + 1;
  const out = {
    tMs: new Float64Array(nt), depth: new Float64Array(nt), vp: new Float64Array(nt), vs: new Float64Array(nt), rho: new Float64Array(nt),
    dropped, used: z.length,
  };
  let j = 0;
  for (let k = 0; k < nt; k++) {
    const tk = k * dtMs;
    while (j < t.length - 2 && t[j + 1] < tk) j += 1;
    const span = t[j + 1] - t[j];
    const w = span > 0 ? Math.min(1, Math.max(0, (tk - t[j]) / span)) : 0;
    out.tMs[k] = tk;
    out.depth[k] = z[j] + w * (z[j + 1] - z[j]);
    out.vp[k] = p[j] + w * (p[j + 1] - p[j]);
    out.vs[k] = s[j] + w * (s[j + 1] - s[j]);
    out.rho[k] = r[j] + w * (r[j + 1] - r[j]);
  }
  return out;
}

/**
 * The gather of a model already on a regular time grid. The interface
 * between samples k-1 and k sits at sample k.
 * @param {{vp: ArrayLike<number>, vs: ArrayLike<number>, rho: ArrayLike<number>}} model
 * @param {{angles: number[], wavelet: ArrayLike<number>, method?: string}} opts wavelet: odd length, centre = zero lag
 * @returns {{angles: number[], rc: Float64Array[], traces: Float32Array[], postCritical: number[], method: string}}
 */
export function gatherFromTimeModel(model, { angles, wavelet, method = 'zoeppritz' }) {
  if (!Array.isArray(angles) || !angles.length) throw new Error('The gather needs at least one angle.');
  for (const a of angles) if (!(a >= 0 && a < 90)) throw new Error('Angles must be from 0 up to (not including) 90 degrees.');
  if (!wavelet || wavelet.length % 2 !== 1) throw new Error('The wavelet must have an odd number of samples.');
  const n = model.vp.length;
  const rc = [];
  const traces = [];
  const postCritical = [];
  for (const theta of angles) {
    const series = new Float64Array(n);
    let past = 0;
    for (let k = 1; k < n; k++) {
      const a = [model.vp[k - 1], model.vs[k - 1], model.rho[k - 1]];
      const b = [model.vp[k], model.vs[k], model.rho[k]];
      if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
      const { r, postCritical: pc } = interfaceReflectivity(...a, ...b, theta, method);
      if (pc) past += 1;
      series[k] = Number.isFinite(r) ? r : 0;
    }
    rc.push(series);
    traces.push(convolveSame(series, wavelet).data);
    postCritical.push(past);
  }
  return { angles: [...angles], rc, traces, postCritical, method };
}

/**
 * The angle gather of depth logs.
 * @param {{depth, vp, vs, rho}} logs SI
 * @param {{angles: number[], dtMs?: number, wavelet?: ArrayLike<number>, freqHz?: number, phaseDeg?: number, method?: string}} opts
 *   a wavelet sampled at dtMs wins; otherwise a Ricker at freqHz rotated by phaseDeg
 * @returns the gatherFromTimeModel result plus {tMs, depth, dtMs, dropped, used, wavelet}
 */
export function angleGather(logs, {
  angles, dtMs = 2, wavelet = null, freqHz = 25, phaseDeg = 0, method = 'zoeppritz',
} = {}) {
  const model = logsToTime(logs, dtMs);
  const w = wavelet || phaseRotatedRicker(freqHz, dtMs, phaseDeg);
  const g = gatherFromTimeModel(model, { angles, wavelet: w, method });
  return { ...g, tMs: model.tMs, depth: model.depth, dtMs, dropped: model.dropped, used: model.used, wavelet: w };
}

/**
 * Amplitude against angle along one event of a gather: at each trace the
 * extreme (largest magnitude) sample within +-halfWindow samples of the
 * event sample, keeping its sign.
 * @returns {number[]} one amplitude per angle
 */
export function pickEvent(traces, sample, halfWindow = 0) {
  return traces.map((trace) => {
    let best = 0;
    const lo = Math.max(0, sample - halfWindow);
    const hi = Math.min(trace.length - 1, sample + halfWindow);
    for (let i = lo; i <= hi; i++) if (Math.abs(trace[i]) > Math.abs(best)) best = trace[i];
    return best;
  });
}

/**
 * Intercept and gradient from amplitudes picked off a gather: least
 * squares of R = A + B sin^2(theta) (Shuey's two-term form) over the
 * angles up to maxAngle.
 * @returns {{a: number, b: number, n: number, r2: number}}
 */
export function fitInterceptGradient(anglesDeg, amplitudes, { maxAngle = 30 } = {}) {
  let n = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < anglesDeg.length; i++) {
    const y = amplitudes[i];
    if (!(anglesDeg[i] <= maxAngle) || !Number.isFinite(y)) continue;
    const x = Math.sin((anglesDeg[i] * Math.PI) / 180) ** 2;
    n += 1; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const den = n * sxx - sx * sx;
  if (n < 2 || !(Math.abs(den) > 1e-18)) throw new Error('Intercept and gradient need at least two different angles.');
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  let ssRes = 0;
  for (let i = 0; i < anglesDeg.length; i++) {
    const y = amplitudes[i];
    if (!(anglesDeg[i] <= maxAngle) || !Number.isFinite(y)) continue;
    const x = Math.sin((anglesDeg[i] * Math.PI) / 180) ** 2;
    ssRes += (y - a - b * x) ** 2;
  }
  return { a, b, n, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}
