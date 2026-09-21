/**
 * Homogeneous infinite-acting reservoir, finite-radius well, constant
 * wellbore storage and skin. The workhorse PTA model.
 *
 * Laplace-space dimensionless wellbore pressure (van Everdingen-Hurst /
 * Agarwal-Al-Hussainy-Ramey formulation), u = Laplace variable conjugate
 * to tD:
 *
 *   pwD(u) = [K0(ru) + S ru K1(ru)] / ( u [ ru K1(ru) + CD u (K0(ru) + S ru K1(ru)) ] )
 *   ru = sqrt(u)
 *
 * Implemented with exponentially scaled Bessel functions; the e^{-ru}
 * factors cancel exactly in the ratio, so the solution stays finite at very
 * early dimensionless time (large u).
 *
 * Negative skin: the additive Laplace skin term is only physical for S >= 0.
 * For S < 0 the standard effective-wellbore-radius mapping is used
 * (rw' = rw e^{-S}), which in dimensionless form is
 *   pwD(tD; CD, S<0) = pwD(tD e^{2S}; CD e^{2S}, S=0)
 * and in Laplace space F(u) -> (1/a) F0(u/a) with a = e^{2S}.
 *
 * Limiting behaviors (used as harness gates, exact literature truths):
 *   early time:  pwD -> tD / CD                (wellbore storage unit slope)
 *   late time:   pwD -> 0.5 (ln tD + 0.80907) + S   (radial semilog)
 *   derivative:  dpwD/dln tD -> 0.5           (radial stabilization)
 */

import { besselK0e, besselK1e, expE1, stehfestInvert } from '../numerics.js';

const basePwdLaplace = (u, skin, cd) => {
  const ru = Math.sqrt(u);
  const k0 = besselK0e(ru);
  const k1 = besselK1e(ru);
  const numerator = k0 + skin * ru * k1;
  const denominator = u * (ru * k1 + cd * u * numerator);
  return numerator / denominator;
};

/**
 * Laplace-space dimensionless wellbore pressure.
 * @param {number} u Laplace variable (conjugate to tD), u > 0
 * @param {{skin?: number, cd?: number}} params dimensionless skin and storage
 */
export const pwdLaplaceHomogeneous = (u, { skin = 0, cd = 0 } = {}) => {
  if (!(u > 0)) return NaN;
  if (skin >= 0) return basePwdLaplace(u, skin, cd);
  const a = Math.exp(2 * skin); // effective-radius time scaling, a < 1
  return basePwdLaplace(u / a, 0, cd * a) / a;
};

/**
 * Time-domain dimensionless wellbore pressure pwD(tD) via Stehfest.
 */
export const pwdHomogeneous = (tD, params = {}, { stehfestN = 12 } = {}) =>
  stehfestInvert((u) => pwdLaplaceHomogeneous(u, params), tD, stehfestN);

/**
 * Exponential-integral line-source solution (no storage, no skin),
 * pD = 0.5 E1(rD^2 / 4 tD). Valid for tD/rD^2 > ~25.
 */
export const lineSourcePd = (tD, rD = 1) => {
  if (!(tD > 0) || !(rD > 0)) return NaN;
  return 0.5 * expE1((rD * rD) / (4 * tD));
};

/**
 * Radial-flow semilog approximation pwD = 0.5 (ln tD + 0.80907) + S.
 * Valid for tD > ~100 once storage has died out.
 */
export const radialSemilogPwd = (tD, skin = 0) =>
  0.5 * (Math.log(tD) + 0.80907) + skin;
