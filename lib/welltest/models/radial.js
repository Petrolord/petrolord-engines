/**
 * Generalized radial vertical-well models (WT3): homogeneous or dual-porosity
 * reservoir with the boundary family, composed with constant wellbore storage
 * and skin in Laplace space.
 *
 * Sandface solution (no storage, no skin), b = sqrt(u f(u)):
 *   infinite acting:   p0 = K0(b) / (u b K1(b))      (finite-radius well)
 *   sealing fault:     p0 + K0(2 LD b) / u           (image line source)
 *   constant pressure: p0 - K0(2 LD b) / u           (negative image)
 *   channel:           p0 + (2/u) sum_n K0(n WD b)   (well centered between
 *                      two parallel sealing faults; images at distance n WD,
 *                      two per n)
 *   closed circle:     van Everdingen-Hurst bounded-circle solution with a
 *                      no-flow boundary at reD (exponentially scaled Bessel
 *                      mix so the ratio stays finite at early time)
 *
 * Wellbore storage and skin are then applied through the universal Laplace
 * composition (exact for any sandface solution; reduces algebraically to the
 * WT1 homogeneous formula):
 *   psf = p0 + S/u
 *   pw  = psf / (1 + CD u^2 psf)
 *
 * Skin is restricted to S >= 0 here: the additive Laplace skin term is only
 * physical for non-negative skin, and the effective-radius mapping used by
 * the WT1 homogeneous model does not commute with f(u) or image distances.
 * Stimulated (negative-skin) vertical wells belong to the plain homogeneous
 * model or a fracture model.
 */

import { besselK0e, besselK1e, besselI0e, besselI1e } from '../numerics.js';
import { interporosityF } from './dualPorosity.js';

const K0 = (x) => besselK0e(x) * Math.exp(-x); // safe: args here stay < ~40

/** Universal storage + skin composition on a sandface Laplace solution. */
export const composeWellbore = (u, p0, skin = 0, cd = 0) => {
  const psf = p0 + Math.max(skin, 0) / u;
  return psf / (1 + cd * u * u * psf);
};

const MAX_IMAGE_TERMS = 100000;
const K0_CUTOFF_ARG = 38; // K0(38) ~ 1e-18, below double-precision relevance

const imageSum = (u, b, boundary) => {
  const type = boundary?.type || 'infinite';
  if (type === 'fault') return K0(2 * boundary.ld * b) / u;
  if (type === 'constant-pressure') return -K0(2 * boundary.ld * b) / u;
  if (type === 'channel') {
    const wd = boundary.wd;
    let sum = 0;
    for (let n = 1; n <= MAX_IMAGE_TERMS; n += 1) {
      const arg = n * wd * b;
      if (arg > K0_CUTOFF_ARG) break;
      sum += K0(arg);
    }
    return (2 * sum) / u;
  }
  return 0;
};

/** Bounded circle (no-flow at reD), exponentially scaled van Everdingen-Hurst. */
const closedCirclePwd = (u, b, reD) => {
  const a = reD * b;
  const c = b;
  const E = Math.exp(2 * (c - a)); // underflows to 0 for large b: infinite acting
  const numerator = besselK1e(a) * besselI0e(c) * E + besselI1e(a) * besselK0e(c);
  const denominator = besselI1e(a) * besselK1e(c) - besselK1e(a) * besselI1e(c) * E;
  return numerator / (u * b * denominator);
};

/**
 * Sandface p0(u) for a radial vertical well.
 * @param {number} u Laplace variable (rw-based dimensionless time domain)
 * @param {object} opts
 *   fissure: { omega, lambda, mode } for dual porosity (omit for homogeneous)
 *   boundary: { type: 'infinite'|'fault'|'constant-pressure'|'channel'|'closed-circle',
 *               ld?, wd?, reD? } (dimensionless distances in rw units)
 */
export const radialSandfaceLaplace = (u, { fissure, boundary } = {}) => {
  if (!(u > 0)) return NaN;
  const f = fissure ? interporosityF(u, fissure) : 1;
  const b = Math.sqrt(u * f);
  if (boundary?.type === 'closed-circle') return closedCirclePwd(u, b, boundary.reD);
  const p0 = besselK0e(b) / (u * b * besselK1e(b)); // e^{-b} cancels in the ratio
  return p0 + imageSum(u, b, boundary);
};

/**
 * Factory: catalog-ready pwdLaplace(u, dimless) for a radial model.
 * dimless carries { skin, cd } plus the boundary/fissure dimensionless
 * numbers produced by the catalog's toDimless mapping.
 */
export const makeRadialPwdLaplace = ({ mode, boundaryType }) => (u, dimless = {}) => {
  const fissure =
    mode === 'dual-porosity'
      ? { omega: dimless.omega, lambda: dimless.lambda, mode: dimless.interporosity || 'pss' }
      : null;
  const boundary = boundaryType && boundaryType !== 'infinite'
    ? { type: boundaryType, ld: dimless.ld, wd: dimless.wd, reD: dimless.reD }
    : null;
  const p0 = radialSandfaceLaplace(u, { fissure, boundary });
  return composeWellbore(u, p0, dimless.skin, dimless.cd);
};
