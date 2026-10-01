
/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => (typeof key === 'string' || typeof key === 'number') && Object.prototype.hasOwnProperty.call(table, key);

// Vs estimation when no shear log exists (Rock Physics Studio G6.1).
// Castagna et al. (1985) mudrock line + Greenberg & Castagna (1992)
// polynomial regressions (coefficients cross-checked against rockphypy
// and auralib; see test-data/rockphysics/README.md). Brine-saturated
// rock assumption — substitute fluids AFTER estimating Vs.
//
// Every estimate carries source: 'estimated' so the UI can badge it —
// the synthetics T(z)-provenance discipline: measured and estimated
// shear are never silently mixed.

import { substituteVels } from './gassmann';

// Vs = a2*Vp^2 + a1*Vp + a0, in km/s (GC 1992; RPH p. 516).
export const GC_COEFF = {
  sandstone: [0.0, 0.80416, -0.85588],
  limestone: [-0.05508, 1.01677, -1.03049],
  dolomite: [0.0, 0.58321, -0.07775],
  shale: [0.0, 0.76969, -0.86735],
};

/** Castagna mudrock line, m/s: Vs = 0.8621*Vp - 1172.4. */
export function mudrockVs(vp) {
  return Number.isFinite(vp) ? 0.8621 * vp - 1172.4 : NaN;
}

/** Single-lithology GC regression, m/s in / m/s out. */
export function gcLithVs(vp, lith) {
  const c = ownPreset(GC_COEFF, lith) ? GC_COEFF[lith] : undefined;
  if (!c) throw new Error(`Unknown Greenberg-Castagna lithology "${lith}".`);
  if (!Number.isFinite(vp)) return NaN;
  const vpk = vp / 1000;
  return (c[0] * vpk * vpk + c[1] * vpk + c[2]) * 1000;
}

/** GC composite: average of the arithmetic and harmonic means of the
 *  per-lithology estimates. fracs = {lith: volume fraction}, sum 1. */
export function greenbergCastagnaVs(vp, fracs) {
  const entries = Object.entries(fracs).filter(([, f]) => f > 0);
  const total = Object.values(fracs).reduce((s, f) => s + f, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error('Lithology fractions must sum to 1.');
  }
  if (!Number.isFinite(vp)) return NaN;
  let arith = 0;
  let inv = 0;
  for (const [lith, f] of entries) {
    const vs = gcLithVs(vp, lith);
    if (!(vs > 0)) return NaN; // below the regression's valid range
    arith += f * vs;
    inv += f / vs;
  }
  return 0.5 * (arith + 1 / inv);
}

/**
 * Greenberg-Castagna on a sand/shale split, one sample, no allocation
 * (U2-014, 2026-10-01). The same arithmetic, in the same order, as
 * greenbergCastagnaVs(vp, {sandstone: 1 - vsh, shale: vsh}) and, at the end
 * members, gcLithVs: the results are identical to the last bit. A 30,000
 * sample well no longer builds four small objects and arrays per sample.
 * vsh is clamped to [0, 1]; a non-finite vsh reads as 0 (clean sand).
 */
export function gcSandShaleVs(vp, vsh) {
  if (!Number.isFinite(vp)) return NaN;
  const v = Number.isFinite(vsh) ? Math.min(1, Math.max(0, vsh)) : 0;
  const vpk = vp / 1000;
  const cs = GC_COEFF.sandstone;
  const ch = GC_COEFF.shale;
  if (v === 0) return (cs[0] * vpk * vpk + cs[1] * vpk + cs[2]) * 1000;
  if (v === 1) return (ch[0] * vpk * vpk + ch[1] * vpk + ch[2]) * 1000;
  const fs = 1 - v;
  const sand = (cs[0] * vpk * vpk + cs[1] * vpk + cs[2]) * 1000;
  if (!(sand > 0)) return NaN; // below the regression's valid range
  const shale = (ch[0] * vpk * vpk + ch[1] * vpk + ch[2]) * 1000;
  if (!(shale > 0)) return NaN;
  let arith = 0;
  let inv = 0;
  arith += fs * sand;
  inv += fs / sand;
  arith += v * shale;
  inv += v / shale;
  return 0.5 * (arith + 1 / inv);
}

/** Curve-level shear: measured DTS wins; otherwise GC on a VSH-based
 *  sand/shale split (v1 lithology model). Returns {vs[], source}. */
export function shearForWell({ vpCurve, dtsVsCurve = null, vshCurve = null }) {
  if (dtsVsCurve) return { vs: dtsVsCurve, source: 'measured' };
  const n = vpCurve.length;
  const vs = new Array(n);
  for (let i = 0; i < n; i++) vs[i] = gcSandShaleVs(vpCurve[i], vshCurve ? vshCurve[i] : 0);
  return { vs, source: 'estimated' };
}

/**
 * Shear velocity in a hydrocarbon-bearing rock with no shear log, by
 * iteration (U2-005, 2026-10-01; the Greenberg and Castagna 1992 procedure
 * as given in the Rock Physics Handbook, 7.9, and as RokDoc and
 * Hampson-Russell run it). The Greenberg-Castagna regressions hold for
 * BRINE-filled rock, so applying them to the in-situ Vp of a gas sand
 * gives a Vs that is too low. Instead:
 *   1. guess Vs;
 *   2. Gassmann the rock from its in-situ fluid to brine with that Vs,
 *      which gives the brine Vp and density;
 *   3. Greenberg-Castagna on the brine Vp gives the brine Vs, and so the
 *      shear modulus, which the fluid does not change;
 *   4. Vs in situ = sqrt(mu / rho in situ); repeat from 2 until it settles.
 * The answer is the fixed point at which the in-situ rock, taken to brine,
 * lies on the Greenberg-Castagna line.
 *
 * @param {Object} p
 * @param {number} p.vp in-situ P velocity, m/s  @param {number} p.rho in-situ bulk density, kg/m3
 * @param {number} p.phi porosity (0, 1)          @param {number} p.kmin mineral bulk modulus, Pa
 * @param {{k: number, rho: number}} p.fluidInSitu  @param {{k: number, rho: number}} p.fluidBrine
 * @param {number} [p.vsh] shale fraction for the sand/shale split (default 0)
 * @param {number} [p.tol] relative change in Vs that ends the iteration (default 1e-9)
 * @param {number} [p.maxIter] default 100
 * @returns {{vs: number, vpBrine: number, iterations: number, converged: boolean}}
 * @throws when Gassmann refuses the sample (the reason is the engine's)
 */
export function iterativeVs({
  vp, rho, phi, kmin, fluidInSitu, fluidBrine, vsh = 0, tol = 1e-9, maxIter = 100,
}) {
  if (!(vp > 0) || !(rho > 0)) throw new Error('vp and rho must be positive.');
  let vs = gcSandShaleVs(vp, vsh);
  if (!(vs > 0) || vs >= vp) vs = vp / 2;
  let vpBrine = NaN;
  for (let it = 1; it <= maxIter; it++) {
    const wet = substituteVels(vp, vs, rho, kmin, phi, fluidInSitu, fluidBrine);
    vpBrine = wet.vp;
    const vsBrine = gcSandShaleVs(wet.vp, vsh);
    if (!(vsBrine > 0)) throw new Error('The brine-filled rock is below the range of the Greenberg-Castagna regression.');
    const next = Math.sqrt((wet.rho * vsBrine * vsBrine) / rho);
    const change = Math.abs(next - vs) / vs;
    vs = next;
    if (change < tol) return { vs, vpBrine, iterations: it, converged: true };
  }
  return { vs, vpBrine, iterations: maxIter, converged: false };
}
