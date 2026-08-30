/**
 * Horizontal well (WT7): uniform-flux horizontal well of length Lw in a
 * laterally infinite slab of thickness h with no-flow top and bottom,
 * anisotropy kv/kh, composed with constant wellbore storage and skin
 * through the universal Laplace composition in radial.js.
 *
 * Formulation (Ozkan-Raghavan): stretch z by beta = sqrt(kh/kv) so the
 * medium is isotropic with diffusivity based on kh, then the well is a
 * finite line source between two no-flow planes. Dimensionless groups are
 * based on the half-length Lh = Lw/2:
 *
 *   tDL = 0.0002637 kh t / (phi mu ct Lh^2)
 *   pD  = kh h dp / (141.2 q B mu)
 *   hD  = h beta / Lh,  zwD = zw beta / Lh
 *
 * and the wellbore is observed at zobs = zwD + rwD' with the anisotropic
 * effective radius rw' = rw (1 + beta) / 2 (Peaceman-type average of the
 * stretched ellipse), the standard equivalent-pressure treatment of the
 * log singularity for uniform flux.
 *
 * Laplace solution (v conjugate to tDL). Writing the slab as a cosine
 * eigenexpansion in z and using F(x) = int_0^x K0, s_n = sqrt(v + n^2 pi^2 / hD^2):
 *
 *   pbarD(v) = (1/(2v)) sum_n eps_n cos(n pi zobs/hD) cos(n pi zwD/hD)
 *                        [F(s_n(1+xD)) + F(s_n(1-xD))] / s_n
 *
 * evaluated at the well midpoint xD = 0. Each F saturates at pi/2, so the
 * raw series converges only like the underlying log singularity. The
 * Poisson-dual identity used here splits it exactly into a short mode sum
 * plus a K0 image sum over the stretched z-mirror images:
 *
 *   pbarD(v) = (1/(2v)) sum_n eps_n cos cos [F + F - pi]/s_n            (A)
 *            + (hD/(2v)) sum_m K0(sqrt(v) |dz_m|)                       (B)
 *
 * (A) truncates once s_n > ~45 (the bracket is minus the exponentially
 * small K0-integral tails); (B) runs over dz_m in {2 n hD - rw'D} and
 * {2 n hD - 2 zwD - rw'D}. For sqrt(v) hD >= 1 it is summed directly with
 * the WT3 cutoff (few images); for sqrt(v) hD < 1 the exact Poisson dual
 * of each mirror family is used instead,
 *
 *   sum_n K0(rv |z0 + 2 n hD|) = pi/(2 hD rv) - ln(2 |sin(pi z0/(2 hD))|)
 *     + (pi/hD) sum_k cos(pi k z0/hD) [ (v + (pi k/hD)^2)^(-1/2) - hD/(pi k) ]
 *
 * whose correction series converges like v hD^2 / k^3, so the dual is used
 * only where sqrt(v) hD is small and the direct K0 sum is used everywhere
 * else. The log term is what carries the partial-penetration pseudo-skin
 * (a naive continuum limit pi/(rv hD) would silently drop it).
 *
 * Exact limits (harness gates):
 *   early time:   vertical-radial derivative plateau hD/4
 *                 (dimensionally 70.6 q B mu / (Lw sqrt(kh kv)))
 *   hD -> 0:      Gringarten uniform-flux fracture (the n = 0 mode);
 *                 intermediate linear flow, half slope
 *   late time:    pseudoradial derivative plateau 0.5 on kh h
 *
 * Storage and skin are composed in the rw-based Laplace domain exactly as
 * for the fracture models: pwD(u) = A pD(A u), A = (Lh/rw)^2; the additive
 * skin is referenced to kh h (dp_skin = 141.2 q B mu S / (kh h)) like every
 * model in this catalog, and is restricted to S >= 0.
 */

import { besselK0e, besselK0Integral } from '../numerics.js';
import { composeWellbore } from './radial.js';

const K0 = (x) => besselK0e(x) * Math.exp(-x); // args stay <= K0_CUTOFF_ARG

const K0_CUTOFF_ARG = 38;
const MODE_CUTOFF = 45; // F(x) - pi/2 is below double precision past ~45

const F = besselK0Integral;

/** Mode sum (A): finite because the bracket is the exponential K0 tail. */
const modeSum = (v, { hD, zwD, zobsD }) => {
  let sum = 0;
  for (let n = 0; ; n += 1) {
    const sn = Math.sqrt(v + (n * n * Math.PI * Math.PI) / (hD * hD));
    if (n > 0 && sn > MODE_CUTOFF) break;
    const eps = n === 0 ? 1 : 2;
    const bracket = 2 * F(sn) - Math.PI; // xD = 0: F(s(1+0)) + F(s(1-0)) = 2 F(s)
    sum +=
      (eps *
        Math.cos((n * Math.PI * zobsD) / hD) *
        Math.cos((n * Math.PI * zwD) / hD) *
        bracket) /
      sn;
    if (n > 1e6) break;
  }
  return sum;
};

/** Exact Poisson dual of one mirror family sum_n K0(rv |z0 + 2 n hD|). */
const mirrorFamilyDual = (rv, hD, z0) => {
  const v = rv * rv;
  const s = Math.abs(Math.sin((Math.PI * z0) / (2 * hD)));
  let sum = Math.PI / (2 * hD * rv) - Math.log(2 * s);
  const scale = Math.PI / hD;
  for (let k = 1; k <= 100000; k += 1) {
    const a = (Math.PI * k) / hD;
    const term = scale * Math.cos(a * z0) * (1 / Math.sqrt(v + a * a) - 1 / a);
    sum += term;
    if (k > 3 && Math.abs(term) < 1e-15 * Math.max(Math.abs(sum), 1)) break;
  }
  return sum;
};

const DUAL_SWITCH = 0.015; // sqrt(v) hD below this: dual; above: direct K0 sum

/** Image sum (B) over the stretched z-mirror offsets. */
const zImageK0Sum = (rv, { hD, zwD, zobsD }) => {
  if (rv * hD < DUAL_SWITCH) {
    return (
      mirrorFamilyDual(rv, hD, zobsD - zwD) +
      mirrorFamilyDual(rv, hD, zobsD + zwD)
    );
  }
  const R = K0_CUTOFF_ARG / rv;
  const nMax = Math.ceil(R / (2 * hD)) + 1;
  let sum = 0;
  for (let n = -nMax; n <= nMax; n += 1) {
    for (const dz of [zobsD - (2 * n * hD + zwD), zobsD - (2 * n * hD - zwD)]) {
      const arg = Math.abs(dz) * rv;
      if (arg > 0 && arg <= K0_CUTOFF_ARG) sum += K0(arg);
    }
  }
  return sum;
};

/**
 * Sandface pbarD(v) in the Lh-based Laplace domain.
 * @param {number} v Laplace variable conjugate to tDL
 * @param {{hD: number, zwD: number, zobsD: number}} geom stretched slab geometry
 */
export const horizontalSandfaceLaplace = (v, geom) => {
  if (!(v > 0)) return NaN;
  const { hD, zwD, zobsD } = geom;
  if (!(hD > 0) || !(zwD > 0) || !(zwD < hD) || !(zobsD > 0)) return NaN;
  const rv = Math.sqrt(v);
  return modeSum(v, geom) / (2 * v) + (hD * zImageK0Sum(rv, geom)) / (2 * v);
};

/**
 * Factory: catalog-ready pwdLaplace(u, dimless) in the rw-based domain.
 * dimless: { lhOverRw, hD, zwD, zobsD, skin, cd }.
 */
export const makeHorizontalPwdLaplace = () => (u, dimless = {}) => {
  const ratio = Math.max(dimless.lhOverRw, 1e-9);
  const A = ratio * ratio; // tD(rw) = A tDL  =>  pwD(u) = A pD(A u)
  const p0 = A * horizontalSandfaceLaplace(A * u, dimless);
  return composeWellbore(u, p0, dimless.skin, dimless.cd);
};
