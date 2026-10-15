// Automatic feasibility sweeps (QI upgrade P2.9, 2026-10-15). For a target,
// the reservoir rock is modelled from porosity, shale volume and effective
// stress (a granular sand model, Gassmann with each fluid), thin-bedded with
// shale at a net-to-gross by Backus averaging, set in the cap shale at a
// thickness, and its band-limited response is read under a Ricker wavelet:
// the peak amplitude at the top of the bed at normal incidence and at a far
// angle (Aki-Richards contrasts, both interfaces). Each sweep varies one of
// porosity, shale volume, effective stress or thickness from the base case,
// and scores how far apart two fluid cases (for example brine and gas) are
// against the seismic noise: d' = |amplitude A - amplitude B| / noise, and
// the chance a single measurement is put in the wrong case, Phi(-d'/2). A
// case is separable at d' of 2 or more (the default; a stated threshold).
//
// Backus (1962) for fine layering, at normal incidence (Mavko, Mukerji and
// Dvorkin, Rock Physics Handbook 4.13): the P-wave modulus and the shear
// modulus are the harmonic means weighted by thickness, density the
// arithmetic mean. Pure, float64.

import { mixMinerals } from '../rockphysics/minerals.js';
import { softSand, stiffSand, dryToVelocities } from '../rockphysics/granular.js';
import { akiRichards } from './avo.js';
import { rickerWavelet, convolveSame } from '../../lib/waveform.js';
import { normalCDF } from '../../lib/stats/stats.js';

const fin = Number.isFinite;

/** Backus average of fine layers [{h, vp, vs, rho}] (h any thickness unit, SI velocities and density). */
export function backusAverage(layers) {
  const H = layers.reduce((s, l) => s + l.h, 0);
  if (!(H > 0)) throw new Error('Backus averaging needs layers with thickness.');
  let invM = 0; let invMu = 0; let rho = 0;
  for (const l of layers) {
    if (!(l.h >= 0) || !(l.vp > 0) || !(l.vs > 0) || !(l.rho > 0)) throw new Error('Each layer needs a thickness, Vp, Vs and density above zero.');
    const f = l.h / H;
    invM += f / (l.rho * l.vp * l.vp);
    invMu += f / (l.rho * l.vs * l.vs);
    rho += f * l.rho;
  }
  return { vp: Math.sqrt(1 / invM / rho), vs: Math.sqrt(1 / invMu / rho), rho };
}

/** Effective stress (MPa) from overburden and pore pressure with a Biot coefficient. */
export const effectiveStress = ({ overburdenMPa, porePressureMPa, biot = 1 }) => overburdenMPa - biot * porePressureMPa;

/**
 * Saturated sand from porosity, shale volume (as clay in the grains) and
 * effective stress, with a fluid {k (Pa), rho (kg/m3)}.
 * @param {{phi, vsh, peffMPa, fluid, model?: 'soft'|'stiff', phiC?, n?, f?}} p
 */
export function sandElastic({ phi, vsh, peffMPa, fluid, model = 'soft', phiC = 0.4, n = 8, f = 1 }) {
  if (!(vsh >= 0 && vsh < 1)) throw new Error('Shale volume must be at least 0 and below 1.');
  if (!(peffMPa > 0)) throw new Error('Effective stress must be above zero.');
  const min = mixMinerals(vsh > 0 ? [{ name: 'quartz', frac: 1 - vsh }, { name: 'clay', frac: vsh }] : [{ name: 'quartz', frac: 1 }]);
  const dry = (model === 'stiff' ? stiffSand : softSand)({ K: min.k, G: min.mu, phi, phiC, n, P: peffMPa * 1e6, f });
  const s = dryToVelocities({ kdry: dry.K, gdry: dry.G, kmin: min.k, kfl: fluid.k, phi, rhoMin: min.rho, rhoFl: fluid.rho });
  return { vp: s.vp, vs: s.vs, rho: s.rho };
}

/** Relative contrasts from rock a (above) to rock b (below), with the mean Vs/Vp. */
export function contrasts(a, b) {
  const m = (x, y) => (x + y) / 2;
  return {
    dVpVp: (b.vp - a.vp) / m(a.vp, b.vp), dVsVs: (b.vs - a.vs) / m(a.vs, b.vs), dRhoRho: (b.rho - a.rho) / m(a.rho, b.rho),
    vsVp: m(a.vs, b.vs) / m(a.vp, b.vp),
  };
}

/**
 * The band-limited response of a bed of rock `bed` (thickness in metres)
 * inside `shale`: peak |amplitude| near the top under a Ricker wavelet at
 * each angle (the tuning-curve window of rockphysics/wedge.js), with the
 * base reflection the opposite contrast.
 * @returns {{thicknessMs, amp: number[], rc: number[]}}
 */
export function bedResponse({ bed, shale, thicknessM, freqHz, anglesDeg = [0, 30], dtMs = 0.5 }) {
  if (!(freqHz > 0)) throw new Error('Give the wavelet frequency.');
  if (!(thicknessM >= 0)) throw new Error('Thickness must be zero or more.');
  const thicknessMs = (2000 * thicknessM) / bed.vp;
  const c = contrasts(shale, bed);
  const w = rickerWavelet(freqHz, dtMs, 60);
  const half = Math.round(((0.5 * Math.sqrt(6)) / (Math.PI * freqHz)) * 1000 / dtMs) + 1;
  const n = Math.round((thicknessMs + 400) / dtMs);
  const t0 = Math.round(150 / dtMs);
  const out = { thicknessMs, amp: [], rc: [] };
  for (const th of anglesDeg) {
    const rc = akiRichards(c, th);
    const spikes = new Float64Array(n);
    spikes[t0] += rc;
    const ib = t0 + Math.round(thicknessMs / dtMs);
    if (ib < n) spikes[ib] -= rc;
    const { data } = convolveSame(spikes, w);
    let peak = 0;
    for (let i = Math.max(0, t0 - half); i <= Math.min(n - 1, t0 + half); i++) peak = Math.max(peak, Math.abs(data[i]));
    out.amp.push(peak); out.rc.push(rc);
  }
  return out;
}

/** How far apart two cases are against noise: d' and the chance one measurement lands in the wrong case. */
export function separability(a, b, noiseSd) {
  if (!(noiseSd > 0)) throw new Error('The noise must be above zero.');
  const d = Math.abs(a - b) / noiseSd;
  return { dprime: d, misclass: normalCDF(-d / 2) };
}

const VARIABLES = ['phi', 'vsh', 'peffMPa', 'thicknessM'];

/**
 * The sweeps of one target.
 * @param {Object} p
 * @param {{phi, vsh, peffMPa, thicknessM, ntg?}} p.base
 * @param {Object<string, number[]>} p.sweeps values for any of phi, vsh, peffMPa, thicknessM
 * @param {{k, rho}} p.fluidA @param {{k, rho}} p.fluidB the two cases (A is usually brine)
 * @param {{vp, vs, rho}} p.shale the cap and interbedded shale
 * @param {number} p.freqHz Ricker peak frequency
 * @param {number} [p.noiseSd] amplitude noise (reflection-coefficient units)
 * @param {number} [p.snr] or a signal-to-noise ratio against the case-A normal-incidence amplitude at the base case
 * @param {number[]} [p.anglesDeg] @param {number} [p.threshold] d' for separable (2)
 * @param {Object} [p.rock] sandElastic options (model, phiC, n, f)
 * @returns {{noiseSd, base: Object, rows: Array<{variable, value, ampA: number[], ampB: number[], dprime: number[], misclass: number[], separable: boolean}>}}
 */
export function feasibilitySweep({ base, sweeps, fluidA, fluidB, shale, freqHz, noiseSd = null, snr = null, anglesDeg = [0, 30], threshold = 2, rock = {} }) {
  for (const k of Object.keys(sweeps || {})) if (!VARIABLES.includes(k)) throw new Error(`Unknown sweep "${k}": sweep porosity (phi), shale volume (vsh), effective stress (peffMPa) or thickness (thicknessM).`);
  const ntg = base.ntg ?? 1;
  if (!(ntg > 0 && ntg <= 1)) throw new Error('Net-to-gross must be above 0 and at most 1.');
  const caseAt = (v, fluid) => {
    const sand = sandElastic({ phi: v.phi, vsh: v.vsh, peffMPa: v.peffMPa, fluid, ...rock });
    const bed = ntg < 1 ? backusAverage([{ h: ntg, ...sand }, { h: 1 - ntg, ...shale }]) : sand;
    return bedResponse({ bed, shale, thicknessM: v.thicknessM, freqHz, anglesDeg });
  };
  const b0 = caseAt(base, fluidA);
  const noise = noiseSd ?? (snr > 0 ? b0.amp[0] / snr : null);
  if (!(noise > 0)) throw new Error('Give the noise, or a signal-to-noise ratio.');
  const row = (variable, value) => {
    const v = { ...base, ...(variable ? { [variable]: value } : {}) };
    const a = caseAt(v, fluidA); const b = caseAt(v, fluidB);
    const s = a.amp.map((x, i) => separability(x, b.amp[i], noise));
    return { variable, value, ampA: a.amp, ampB: b.amp, rcA: a.rc, rcB: b.rc, thicknessMs: a.thicknessMs, dprime: s.map((x) => x.dprime), misclass: s.map((x) => x.misclass), separable: s.some((x) => x.dprime >= threshold) };
  };
  const rows = [];
  for (const k of VARIABLES) for (const value of sweeps?.[k] || []) if (fin(value)) rows.push(row(k, value));
  return { noiseSd: noise, threshold, anglesDeg, base: row(null, null), rows };
}

/** The range of each swept variable where the cases separate, for the feasibility gate. */
export function separableRanges(sweep) {
  const out = {};
  for (const k of VARIABLES) {
    const r = sweep.rows.filter((x) => x.variable === k);
    if (!r.length) continue;
    const ok = r.filter((x) => x.separable).map((x) => x.value);
    out[k] = { tested: r.length, separable: ok.length, min: ok.length ? Math.min(...ok) : null, max: ok.length ? Math.max(...ok) : null };
  }
  return out;
}
