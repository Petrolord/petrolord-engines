/**
 * Gas properties for the production engines (Production P4, Gas Lift
 * Design Studio).
 *
 * Two jobs, both of which the gas-lift design math needs and neither of
 * which the drilling or reservoir domains already provide in this
 * package:
 *
 *  1. Injection-gas compressibility for the casing gas column that sets
 *     the injection pressure at every valve depth. Sutton (1985)
 *     pseudo-criticals, optional Wichert-Aziz (1972) non-hydrocarbon
 *     correction, Dranchuk & Abou-Kassem (1975) z.
 *  2. Nitrogen compressibility for the dome charge of a bellows valve.
 *     A valve is set on a test rack at 60 degF and then works at valve
 *     temperature; the correction between the two is a real-gas ratio,
 *     not the linear rule of thumb printed in older manuals.
 *
 * DAK is the standard 11-coefficient fit to the Standing-Katz chart, so
 * it is a two-parameter corresponding-states model. Applying it to pure
 * nitrogen with nitrogen's own criticals is an extrapolation off the
 * natural-gas basis it was fitted to; it is defensible here because
 * nitrogen is a simple near-spherical molecule (acentric factor 0.037,
 * against methane's 0.011) and because the gas-lift dome window is
 * Tpr 2.3-3.1, Ppr 1-5, where the Standing-Katz surface is smooth and
 * nearly acentric-factor independent. The published-data check against
 * the NIST nitrogen isotherms is a separate ARMED gate; nothing here
 * asserts agreement with numbers this repo has not verified.
 *
 * Field units throughout: pressure psia, temperature degF (converted to
 * degR internally), depth ft.
 */

/** Rankine offset. */
export const R_OFFSET = 459.67;

/** Molecular weight of dry air, lbm/lbmol, and the gas constant in
 *  psia ft3 / (lbmol degR). Exported so the closed-form gate builds its
 *  exponent from the same numbers the gradient uses. */
export const AIR_MW = 28.9625;
export const R_UNIVERSAL = 10.7316;

export const toRankine = (tF) => tF + R_OFFSET;

/** Dranchuk & Abou-Kassem (1975) coefficients. */
const DAK = {
  a1: 0.3265, a2: -1.07, a3: -0.5339, a4: 0.01569, a5: -0.05165,
  a6: 0.5475, a7: -0.7361, a8: 0.1844, a9: 0.1056, a10: 0.6134, a11: 0.721,
};

/**
 * Sutton (1985) pseudo-criticals for a hydrocarbon gas mixture from its
 * specific gravity (air = 1).
 */
export const suttonPseudoCriticals = (gasSg) => ({
  tpcR: 169.2 + 349.5 * gasSg - 74.0 * gasSg * gasSg,
  ppcPsia: 756.8 - 131.0 * gasSg - 3.6 * gasSg * gasSg,
});

/**
 * Wichert & Aziz (1972) correction of the pseudo-criticals for acid-gas
 * content. yCo2 / yH2s are mole fractions.
 */
export const wichertAziz = ({ tpcR, ppcPsia, yCo2 = 0, yH2s = 0 }) => {
  const a = yCo2 + yH2s;
  if (!(a > 0)) return { tpcR, ppcPsia, epsilon: 0 };
  const eps = 120 * (Math.pow(a, 0.9) - Math.pow(a, 1.6)) + 15 * (Math.pow(yH2s, 0.5) - Math.pow(yH2s, 4));
  const tpcCorr = tpcR - eps;
  const ppcCorr = (ppcPsia * tpcCorr) / (tpcR + yH2s * (1 - yH2s) * eps);
  return { tpcR: tpcCorr, ppcPsia: ppcCorr, epsilon: eps };
};

/**
 * z from DAK at given reduced conditions. Newton iteration on the
 * reduced density rhoR = 0.27 Ppr / (z Tpr); the residual is the DAK
 * equation itself, so a converged root satisfies it to `tol`.
 * Returns { z, rhoR, iterations, converged }.
 */
export const dakZ = ({ ppr, tpr, tol = 1e-10, maxIter = 60 }) => {
  if (!(ppr > 0)) return { z: 1, rhoR: 0, iterations: 0, converged: true };
  const t1 = DAK.a1 + DAK.a2 / tpr + DAK.a3 / tpr ** 3 + DAK.a4 / tpr ** 4 + DAK.a5 / tpr ** 5;
  const t2 = DAK.a6 + DAK.a7 / tpr + DAK.a8 / tpr ** 2;
  const t3 = DAK.a9 * (DAK.a7 / tpr + DAK.a8 / tpr ** 2);
  const c = 0.27 * ppr / tpr;

  // f(rhoR) = z(rhoR) * rhoR - c, with z from the DAK polynomial.
  const zOf = (r) => 1 + t1 * r + t2 * r * r - t3 * r ** 5
    + (DAK.a10 * (1 + DAK.a11 * r * r) * (r * r / tpr ** 3) * Math.exp(-DAK.a11 * r * r));
  const f = (r) => zOf(r) * r - c;

  let r = c; // z = 1 first guess
  let converged = false;
  let i = 0;
  for (; i < maxIter; i += 1) {
    const fr = f(r);
    const h = Math.max(1e-8, Math.abs(r) * 1e-7);
    const d = (f(r + h) - f(r - h)) / (2 * h);
    if (!Number.isFinite(d) || d === 0) break;
    let next = r - fr / d;
    if (!(next > 0)) next = r / 2;
    if (Math.abs(next - r) < tol) { r = next; converged = true; break; }
    r = next;
  }
  return { z: zOf(r), rhoR: r, iterations: i, converged };
};

/** z of a hydrocarbon injection gas. */
export const naturalGasZ = ({ pPsia, tF, gasSg, yCo2 = 0, yH2s = 0 }) => {
  const base = suttonPseudoCriticals(gasSg);
  const { tpcR, ppcPsia } = wichertAziz({ ...base, yCo2, yH2s });
  const tR = toRankine(tF);
  return dakZ({ ppr: pPsia / ppcPsia, tpr: tR / tpcR }).z;
};

/** Nitrogen criticals (NIST/CODATA values, converted to field units). */
export const N2_CRITICALS = { tpcR: 227.16, ppcPsia: 492.5 };

/** z of the nitrogen dome charge. See the module header on the basis. */
export const nitrogenZ = ({ pPsia, tF }) => dakZ({
  ppr: pPsia / N2_CRITICALS.ppcPsia,
  tpr: toRankine(tF) / N2_CRITICALS.tpcR,
}).z;

/**
 * Static gas gradient, psi/ft, from the real-gas density:
 *   rho = 28.9625 * gammaG * p / (z R T),  R = 10.7316 psia ft3 / (lbmol degR)
 *   dp/dD = rho / 144
 */
export const gasGradient = ({ pPsia, tF, gasSg, z }) => {
  const zz = z ?? naturalGasZ({ pPsia, tF, gasSg });
  const rho = (AIR_MW * gasSg * pPsia) / (zz * R_UNIVERSAL * toRankine(tF));
  return rho / 144;
};

/**
 * Injection-gas pressure down a static casing column.
 *
 * Marched in `steps` depth increments with a midpoint (trapezoidal in
 * gradient) correction, evaluating z and temperature locally rather
 * than assuming one average-z step, so a hot deep well and a cold
 * shallow one are not forced onto the same average. With temperature
 * held constant and z pinned at 1 the march converges to the closed
 * form p(D) = pSurf * exp(0.01875 * gammaG * D / T), which is the
 * self-asserting gate on this routine.
 *
 * inputs: { pSurfPsia, tvdFt, gasSg, tempAtDepthF(tvd) -> degF,
 *           steps = 40, zOverride }
 * returns { pBottomPsia, profile: [{ tvdFt, pPsia, tF, z, gradPsiPerFt }] }
 */
export const gasColumnPressure = ({
  pSurfPsia, tvdFt, gasSg, tempAtDepthF, steps = 40, zOverride,
}) => {
  const n = Math.max(1, Math.round(steps));
  const dz = tvdFt / n;
  const tempAt = typeof tempAtDepthF === 'function' ? tempAtDepthF : () => tempAtDepthF;
  const zAt = (p, tF) => (zOverride !== undefined ? zOverride : naturalGasZ({ pPsia: p, tF, gasSg }));

  let p = pSurfPsia;
  const t0 = tempAt(0);
  const profile = [{
    tvdFt: 0, pPsia: p, tF: t0, z: zAt(p, t0),
    gradPsiPerFt: gasGradient({ pPsia: p, tF: t0, gasSg, z: zAt(p, t0) }),
  }];

  for (let i = 1; i <= n; i += 1) {
    const dTop = (i - 1) * dz;
    const dBot = i * dz;
    const tTop = tempAt(dTop);
    const tBot = tempAt(dBot);
    const gTop = gasGradient({ pPsia: p, tF: tTop, gasSg, z: zAt(p, tTop) });
    // predictor then trapezoid corrector on the gradient
    let pBot = p + gTop * dz;
    for (let k = 0; k < 3; k += 1) {
      const gBot = gasGradient({ pPsia: pBot, tF: tBot, gasSg, z: zAt(pBot, tBot) });
      const next = p + 0.5 * (gTop + gBot) * dz;
      if (Math.abs(next - pBot) < 1e-10) { pBot = next; break; }
      pBot = next;
    }
    p = pBot;
    profile.push({
      tvdFt: dBot, pPsia: p, tF: tBot, z: zAt(p, tBot),
      gradPsiPerFt: gasGradient({ pPsia: p, tF: tBot, gasSg, z: zAt(p, tBot) }),
    });
  }
  return { pBottomPsia: p, profile };
};

/**
 * Inverse of gasColumnPressure: the surface injection pressure whose
 * static column reads `pAtDepthPsia` at `tvdFt`. Secant iteration on
 * the forward march, which is monotone in the surface pressure.
 */
export const gasColumnSurfacePressure = ({
  pAtDepthPsia, tvdFt, gasSg, tempAtDepthF, steps = 40, zOverride,
  tol = 1e-7, maxIter = 40,
}) => {
  if (!(tvdFt > 0)) return pAtDepthPsia;
  const at = (pSurf) => gasColumnPressure({
    pSurfPsia: pSurf, tvdFt, gasSg, tempAtDepthF, steps, zOverride,
  }).pBottomPsia;
  let a = pAtDepthPsia * 0.5;
  let b = pAtDepthPsia;
  let fa = at(a) - pAtDepthPsia;
  let fb = at(b) - pAtDepthPsia;
  for (let i = 0; i < maxIter; i += 1) {
    const denom = fb - fa;
    if (!Number.isFinite(denom) || denom === 0) break;
    const next = b - (fb * (b - a)) / denom;
    a = b; fa = fb;
    b = next > 0 ? next : b / 2;
    fb = at(b) - pAtDepthPsia;
    if (Math.abs(fb) < tol) break;
  }
  return b;
};
