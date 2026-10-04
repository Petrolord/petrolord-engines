/**
 * Changing wellbore storage (Well Test U2-002, 2026-10-04): Fair (1981)
 * and Hegeman, Hallford and Joseph (1993), composed in Laplace space with
 * ANY sandface solution of the catalog.
 *
 * Fair's wellbore equation adds a phase-redistribution pressure p_phiD to
 * the constant-storage balance (van Everdingen and Hurst 1949):
 *
 *   q_sf / q = 1 - C_D ( dp_wD/dt_D - dp_phiD/dt_D )
 *
 * with p_phiD(0) = 0, p_phiD(inf) = C_phiD and dp_phiD/dt_D -> 0 late.
 *   Fair (exponential):  p_phiD = C_phiD (1 - exp(-t_D/alpha_D))
 *   Hegeman (error fn):  p_phiD = C_phiD erf(t_D/alpha_D)
 * alpha_D = 0.0002637 k alpha / (phi mu ct rw^2), alpha in hours.
 * (Equations as printed in Tobing, Lemigas Scientific Contributions 31(2),
 * 2008, eqs. 2 to 7, which cites Hegeman et al., SPE Formation Evaluation,
 * September 1993, 201-207.)
 *
 * Laplace transform of the balance with Duhamel's p_w = u q_sf p_sf, where
 * p_sf is the constant-rate sandface solution WITH skin and WITHOUT storage:
 *
 *   p_w(u) = p_sf (1 + C_D u^2 p_phi) / (1 + C_D u^2 p_sf)
 *
 * which is the constant-storage composition when C_phiD = 0 (exactly), so
 * the catalog's own models evaluated at cd = 0 give p_sf.
 *   Fair:     p_phi(u) = C_phiD / ( u (1 + u alpha_D) )
 *   Hegeman:  p_phi(u) = C_phiD erfcx(u alpha_D / 2) / u,
 *             erfcx(x) = exp(x^2) erfc(x)
 *
 * The user states the storage as two numbers a well-test analyst reads off
 * the log-log plot: the final (late) storage C and the ratio Ci/C of the
 * initial (early) apparent storage to it, plus the time alpha of the
 * change. The early-time limit of the balance gives
 *   1/C_iD = 1/C_D + dp_phiD/dt_D (t_D = 0)
 * with dp_phiD/dt_D(0) = C_phiD/alpha_D (Fair) or 2 C_phiD/(sqrt(pi) alpha_D)
 * (Hegeman), so
 *   Fair:     C_phiD = (alpha_D / C_D) (C/Ci - 1)
 *   Hegeman:  C_phiD = (sqrt(pi) alpha_D / (2 C_D)) (C/Ci - 1)
 * Ci/C > 1 is decreasing storage (C_phiD < 0; the dp curve steps up from
 * the lower unit-slope line to the upper one and the derivative rises above
 * the unit slope); Ci/C < 1 gives C_phiD > 0, the phase-redistribution
 * pressure of Fair, which overshoots (the hump) when it is strong.
 *
 * Buildups are superposed from the drawdown response like every catalog
 * model; the change is then tied to the start of each rate period, which
 * matters only in the shut-in term (the drawdown terms have long reached
 * C_phiD and cancel). This is the convention of the published model.
 */

const SQRT_PI = Math.sqrt(Math.PI);

/**
 * exp(x^2) erfc(x) for x >= 0, to near machine precision: the Taylor
 * series of erf for x <= 2.5, a Lentz continued fraction beyond (the same
 * split as engines/prospect/valuation.js erfc, kept scaled here so it never
 * underflows at large x).
 */
export const erfcx = (x) => {
  if (!(x >= 0)) return NaN;
  if (x <= 2.5) {
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n += 1) {
      term *= -(x * x) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return Math.exp(x * x) * (1 - (2 / SQRT_PI) * sum);
  }
  const tiny = 1e-300;
  let f = x;
  let C = x;
  let D = 0;
  for (let n = 1; n < 500; n += 1) {
    const an = n / 2;
    D = x + an * D; D = D === 0 ? tiny : D; D = 1 / D;
    C = x + an / C; C = C === 0 ? tiny : C;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 / (SQRT_PI * f);
};

export const WELLBORE_STORAGE_MODELS = Object.freeze({
  constant: Object.freeze({ id: 'constant', label: 'Constant wellbore storage', reference: 'van Everdingen and Hurst (1949)' }),
  hegeman: Object.freeze({
    id: 'hegeman',
    label: 'Changing wellbore storage, Hegeman (error function)',
    reference: 'Hegeman, Hallford and Joseph (1993), SPE Formation Evaluation 8(3) 201-207',
  }),
  fair: Object.freeze({
    id: 'fair',
    label: 'Changing wellbore storage, Fair (exponential)',
    reference: 'Fair (1981), SPE Journal 21(2) 206-214',
  }),
});

/** Laplace transform of the phase-redistribution pressure p_phiD(t_D). */
export const phaseRedistributionLaplace = (u, { kind, cphiD = 0, alphaD = 1 }) => {
  if (!(u > 0) || !cphiD) return 0;
  if (kind === 'fair') return cphiD / (u * (1 + u * alphaD));
  if (kind === 'hegeman') return (cphiD * erfcx((u * alphaD) / 2)) / u;
  return 0;
};

/** p_phiD in real time (for a reader that wants to draw it, and for the gates). */
export const phaseRedistributionPressure = (tD, { kind, cphiD = 0, alphaD = 1 }) => {
  if (!(tD >= 0) || !cphiD) return 0;
  const x = tD / alphaD;
  if (kind === 'fair') return cphiD * (1 - Math.exp(-x));
  if (kind === 'hegeman') return cphiD * (1 - erfcx(x) * Math.exp(-x * x));
  return 0;
};

/** C_phiD from the stated ratio Ci/C, alpha_D and C_D (see the file header). */
export const cphiDFromRatio = ({ kind, ciOverC, alphaD, cd }) => {
  if (!(ciOverC > 0) || !(alphaD > 0) || !(cd > 0)) return 0;
  const slope = kind === 'hegeman' ? (SQRT_PI * alphaD) / 2 : alphaD;
  return (slope / cd) * (1 / ciOverC - 1);
};

/**
 * Wrap a catalog pwdLaplace(u, dimless) so the storage changes: the
 * sandface solution is the model's own at cd = 0.
 * dimless additionally carries { cphiD, alphaD, wellboreKind }.
 */
export const withChangingStorage = (pwdLaplace, kind) => (u, dimless = {}) => {
  const cd = dimless.cd ?? 0;
  const psf = pwdLaplace(u, { ...dimless, cd: 0 });
  if (!(cd > 0)) return psf;
  const pphi = phaseRedistributionLaplace(u, { kind, cphiD: dimless.cphiD ?? 0, alphaD: dimless.alphaD ?? 1 });
  return (psf * (1 + cd * u * u * pphi)) / (1 + cd * u * u * psf);
};
