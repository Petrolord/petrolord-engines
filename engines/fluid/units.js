/**
 * EOS internal unit conventions — Fluid Systems Studio compositional engine.
 *
 * Everything inside src/utils/fluidstudio/eos/ works in ONE unit system:
 *   pressure     psia
 *   temperature  °R (Rankine)
 *   moles        lb-mol
 *   volume       ft³ (molar volume ft³/lb-mol)
 *   density      lb/ft³
 *   energy       via R below (psia·ft³/(lb-mol·°R))
 *
 * UI-facing conversions (°F, MPa, kg/m³, cP) happen at the boundary, never
 * inside the solvers. This mirrors the psia/°R convention already used by
 * pvtCalculations.js so black-oil and EOS paths agree at the seam.
 */

/** Universal gas constant, psia·ft³ / (lb-mol·°R). */
export const R_PSIA = 10.7316;

export const PSC = 14.696; // psia, standard pressure
export const TSC = 519.67; // °R, standard temperature (60 °F)

export const degFtoR = (tF) => tF + 459.67;
export const degRtoF = (tR) => tR - 459.67;
export const KtoR = (tK) => tK * 1.8;
export const RtoK = (tR) => tR / 1.8;
export const barToPsia = (pBar) => pBar * 14.503774;
export const psiaToBar = (p) => p / 14.503774;
export const mpaToPsia = (pMPa) => pMPa * 145.03774;
/** cm³/mol → ft³/lb-mol (for critical volumes in LBC). */
export const cm3molToFt3lbmol = (v) => v * 0.016018463;
/** lb-mol/ft³ → g-mol/cm³ (Weinaug-Katz molar densities); same factor. */
export const LBMOL_FT3_TO_GMOL_CM3 = 0.016018463;
/** lb/ft³ → g/cm³. */
export const lbft3ToGcc = (rho) => rho / 62.427961;
