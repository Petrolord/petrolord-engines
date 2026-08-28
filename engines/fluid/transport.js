/**
 * Compositional transport properties — FS4.
 *
 * Lohrenz-Bray-Clark (1964) viscosity and Weinaug-Katz (1943)
 * parachor interfacial tension, evaluated on PR78 phase states.
 *
 * The LBC formulation follows the field-unit statement in Yang, Fevang,
 * Christoffersen & Ivarrud, SPE 109892 (2007), eqs. 1-7 (which restates
 * the original Lohrenz et al. 1964 / Jossi-Stiel-Thodos equations):
 * T °R, P psia, MW lb/lb-mol, Vc ft³/lb-mol, μ cP, ξ cP⁻¹ with the 5.35
 * field-unit constant. Dilute-gas component viscosities are Stiel-Thodos,
 * mixed by Herning-Zipperer; pseudocriticals are Kay (mole-fraction)
 * rules; the dense correction is the LBC quartic in reduced density.
 *
 * LBC is a correlation, not thermodynamics: expect order-10% gas and
 * order-2x untuned oil accuracy. Critical-volume tuning (the standard
 * LBC calibration) is part of the FS8+ / lab-tuning follow-on, not FS4.
 *
 * Weinaug-Katz: σ^(1/4) = Σ Pch_i·(x_i·ρ̃L − y_i·ρ̃V) with molar
 * densities ρ̃ in g-mol/cm³ and σ in dyn/cm (Macleod-Sugden mixture
 * form). Parachors are carried by the component library (pseudo: the
 * Firoozabadi correlation from characterization.js).
 */

import { LBMOL_FT3_TO_GMOL_CM3 } from './units.js';

/** LBC dense-correction quartic coefficients (Lohrenz et al. 1964). */
export const LBC_COEFFS = [0.1023, 0.023364, 0.058533, -0.040758, 0.0093324];

/** Stiel-Thodos viscosity-reducing parameter, field units (cP⁻¹). */
export function xiViscosity(tcR, pcPsia, mw) {
  return 5.35 * (tcR / (mw ** 3 * pcPsia ** 4)) ** (1 / 6);
}

/** Stiel-Thodos dilute-gas viscosity of one component, cP. */
export function diluteComponentViscosity(comp, tR) {
  const tr = tR / comp.tcR;
  const xi = xiViscosity(comp.tcR, comp.pcPsia, comp.mw);
  if (tr <= 1.5) return (34e-5 * tr ** 0.94) / xi;
  return (17.78e-5 * (4.58 * tr - 1.67) ** 0.625) / xi;
}

/** Herning-Zipperer dilute-gas mixture viscosity, cP. */
export function diluteMixtureViscosity(mix, x, tR) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i += 1) {
    const w = x[i] * Math.sqrt(mix.comps[i].mw);
    num += w * diluteComponentViscosity(mix.comps[i], tR);
    den += w;
  }
  return num / den;
}

/**
 * LBC phase viscosity, cP. `phase` is a pr78.phaseProps result for the
 * same composition (its Peneloux-translated molarVolume feeds the
 * reduced density). Every component needs vcFt3PerLbmol.
 */
export function lbcViscosity(mix, x, tR, phase) {
  let tpc = 0;
  let ppc = 0;
  let vpc = 0;
  let mwm = 0;
  for (let i = 0; i < x.length; i += 1) {
    const c = mix.comps[i];
    if (!(c.vcFt3PerLbmol > 0)) throw new Error(`LBC needs vcFt3PerLbmol for ${c.key || c.name}`);
    tpc += x[i] * c.tcR;
    ppc += x[i] * c.pcPsia;
    vpc += x[i] * c.vcFt3PerLbmol;
    mwm += x[i] * c.mw;
  }
  const mu0 = diluteMixtureViscosity(mix, x, tR);
  const rhoR = vpc / phase.molarVolume;
  const xiM = xiViscosity(tpc, ppc, mwm);
  const [a0, a1, a2, a3, a4] = LBC_COEFFS;
  const poly = a0 + rhoR * (a1 + rhoR * (a2 + rhoR * (a3 + rhoR * a4)));
  const viscosityCp = mu0 + (poly ** 4 - 1e-4) / xiM;
  return { viscosityCp, diluteCp: mu0, rhoR, xiM };
}

/**
 * Weinaug-Katz interfacial tension between the two flash phases, dyn/cm.
 * `liquid`/`vapor` are pr78.phaseProps results for x/y. The parachor sum
 * is clamped at zero (it can dip epsilon-negative approaching the
 * critical point, where IFT physically vanishes).
 */
export function weinaugKatzIFT(mix, x, y, liquid, vapor) {
  const rhoLm = LBMOL_FT3_TO_GMOL_CM3 / liquid.molarVolume;
  const rhoVm = LBMOL_FT3_TO_GMOL_CM3 / vapor.molarVolume;
  let s = 0;
  for (let i = 0; i < x.length; i += 1) {
    const pch = mix.comps[i].parachor;
    if (!(pch > 0)) throw new Error(`Weinaug-Katz needs a parachor for ${mix.comps[i].key || mix.comps[i].name}`);
    s += pch * (x[i] * rhoLm - y[i] * rhoVm);
  }
  const base = Math.max(s, 0);
  return { iftDynPerCm: base ** 4, parachorSum: s };
}
