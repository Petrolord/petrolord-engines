/**
 * Gas conditioning: dehydration, sweetening, dew point (Facilities F3).
 *
 * The predecessor app hid its assumptions inside constants
 * (4 gal/lb, 750 Btu/gal, 15 percent BTEX). This engine's rule is the
 * opposite: everything that is a DESIGN CHOICE or a chart value is an
 * input with its customary range named, and everything that is
 * computable from first principles is computed.
 *
 * Computed here:
 *  - saturated water content of a gas by ideal vapor-liquid
 *    equilibrium over liquid water (Magnus saturation pressure), with
 *    the honesty note that the McKetta-Wehe chart's real-gas
 *    correction grows with pressure (armed literature gate)
 *  - the Kremser absorption-factor relation for staged contactors
 *  - TEG and amine material balances, with reboiler duty built from
 *    sensible heat, water vaporization and a stated reflux ratio
 *    instead of a single hidden number
 *  - contactor diameter by Souders-Brown with the K value an input
 *  - the Joule-Thomson coefficient DERIVED from the DAK z-factor
 *    correlation by its temperature derivative, not assumed
 *
 * Units: field throughout (MMscfd, lb/MMscf, gpm, psia, F, Btu).
 */

import { suttonPseudoCriticals, dakZ, toRankine } from '../production/gasProperties.js';

const LBMOL_SCF = 379.49;   // scf per lbmol at 14.65 psia, 60 F
const MW_WATER = 18.01528;

/* ------------------------------------------------------------------ *
 * Water content
 * ------------------------------------------------------------------ */

/** Magnus saturation pressure of water, psia (published fit, -45..60 C). */
export const waterSatPsia = (tF) => {
  const tC = (tF - 32) / 1.8;
  if (tC < -45 || tC > 100) return NaN;
  const kPa = 0.61094 * Math.exp((17.625 * tC) / (tC + 243.04));
  return kPa / 6.894757293168;
};

/**
 * Saturated water content by ideal VLE: y_w = Psat/P, converted to
 * lb/MMscf. Exact in the ideal-mixing limit; the real-gas departure
 * the McKetta-Wehe chart carries reaches roughly 10-20 percent by
 * 1500 psia, so the answer above 1000 psia comes with a warning and
 * the chart gate stays armed.
 */
export const saturatedWaterContent = ({ pPsia, tF }) => {
  const psat = waterSatPsia(tF);
  if (Number.isNaN(psat)) return { error: 'water saturation fit holds from -45 to 100 C' };
  if (!(pPsia > psat)) return { error: 'total pressure must exceed the water vapor pressure' };
  const y = psat / pPsia;
  const lbPerMMscf = y * (1e6 / LBMOL_SCF) * MW_WATER;
  return {
    lbPerMMscf,
    yWater: y,
    warning: pPsia > 1000
      ? 'ideal-mixing estimate: above about 1000 psia the real-gas correction of the McKetta-Wehe chart grows to tens of percent; use a chart reading for design'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Staged absorption (Kremser)
 * ------------------------------------------------------------------ */

/**
 * Kremser: fraction remaining after N theoretical stages with
 * absorption factor A = L/(V K). Solves any one of the three
 * questions; here, the fraction absorbed for given N and A, and the N
 * a spec demands for a given A.
 */
export const kremserFractionRemoved = ({ absorptionFactor: A, stages: N }) => {
  if (!(A > 0) || !(N > 0)) return NaN;
  if (Math.abs(A - 1) < 1e-9) return N / (N + 1);
  return (A ** (N + 1) - A) / (A ** (N + 1) - 1);
};

export const kremserStagesFor = ({ absorptionFactor: A, fractionRemoved: f }) => {
  if (!(A > 0) || !(f > 0) || f >= 1) return { error: 'Kremser needs 0 < fraction < 1 and a positive absorption factor' };
  if (A <= f) {
    return { error: 'absorption factor at or below the required removal: no stage count reaches this spec; raise circulation' };
  }
  if (Math.abs(A - 1) < 1e-9) return { stages: f / (1 - f) };
  // f = (A^(N+1) - A)/(A^(N+1) - 1)  =>  A^(N+1) = (A - f)/(1 - f)
  return { stages: Math.log((A - f) / (1 - f)) / Math.log(A) - 1 };
};

/* ------------------------------------------------------------------ *
 * TEG dehydration
 * ------------------------------------------------------------------ */

/**
 * TEG package balance. The circulation RATIO (gal TEG per lb water,
 * customary 2 to 5) is a design choice and stays an input; what is
 * computed is everything that follows from it, plus a reboiler duty
 * assembled from its named parts instead of one hidden number.
 */
export const tegPackage = ({
  gasMMscfd, inletLbMMscf, outletLbMMscf,
  circulationGalPerLb = 3, leanTegWtPct = 99.0,
  absorberTF = 100, reboilerTF = 380, refluxRatio = 0.25,
  cpTegBtuLbF = 0.55, tegLbPerGal = 9.3,
  btexInletPpmv = 0, btexAbsorbedFrac = 0.15, btexMw = 92,
}) => {
  if (!(gasMMscfd > 0)) return { error: 'a gas rate is needed' };
  const removedLbMMscf = inletLbMMscf - outletLbMMscf;
  if (!(removedLbMMscf > 0)) return { error: 'inlet water content must exceed the outlet spec' };
  if (!(leanTegWtPct > 90) || leanTegWtPct >= 100) {
    return { error: 'lean TEG between 90 and 100 weight percent' };
  }
  const waterLbDay = removedLbMMscf * gasMMscfd;
  const circGpd = waterLbDay * circulationGalPerLb;
  const circGpm = circGpd / 1440;

  // Reboiler duty per gallon, from named parts:
  //  sensible: heat the glycol from absorber to reboiler temperature
  //  vaporization: boil the absorbed water out (latent ~970 plus
  //  sensible to the still, folded as 1100 Btu/lb overhead here)
  //  reflux: a stated fraction of the overhead condensed and reboiled
  const sensiblePerGal = tegLbPerGal * cpTegBtuLbF * (reboilerTF - absorberTF);
  const waterPerGal = 1 / circulationGalPerLb; // lb water per gal TEG
  const vaporPerGal = waterPerGal * 1100 * (1 + refluxRatio);
  const dutyBtuPerGal = sensiblePerGal + vaporPerGal;
  const reboilerMMBtuHr = (circGpd * dutyBtuPerGal) / 24 / 1e6;

  // BTEX: the absorbed fraction is a chart/operating value (typed);
  // the arithmetic from it is a mole balance.
  const btexMolesDay = (gasMMscfd * 1e6 * (btexInletPpmv / 1e6)) / LBMOL_SCF;
  const btexLbDay = btexMolesDay * btexAbsorbedFrac * btexMw;

  return {
    waterLbDay,
    circGpm,
    circGpd,
    dutyBtuPerGal,
    sensiblePerGal,
    vaporPerGal,
    reboilerMMBtuHr,
    btexLbDay,
    btexTonsYear: (btexLbDay * 365) / 2000,
    warning: circulationGalPerLb < 2 || circulationGalPerLb > 5
      ? 'circulation ratio outside the customary 2 to 5 gal per lb'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Amine sweetening
 * ------------------------------------------------------------------ */

/** Published property sets the balance needs; sources in comments. */
export const AMINES = [
  // maxLoading mol acid gas / mol amine (customary rich limits),
  // heatBtuPerGal: customary reboiler duty per gallon circulated,
  // offered as the DEFAULT for the typed input, not hidden.
  { id: 'MEA', mw: 61.08, wtPctTypical: 18, maxLoading: 0.35, heatBtuPerGal: 1100, sgSolution: 1.01 },
  { id: 'DEA', mw: 105.14, wtPctTypical: 28, maxLoading: 0.4, heatBtuPerGal: 950, sgSolution: 1.02 },
  { id: 'MDEA', mw: 119.16, wtPctTypical: 45, maxLoading: 0.5, heatBtuPerGal: 800, sgSolution: 1.04 },
];

export const amineOf = (id) => AMINES.find((a) => a.id === id) || null;

/**
 * Amine circulation from the acid-gas mole balance: moles of CO2+H2S
 * picked up over the loading swing, through the solution strength to
 * gallons. The loading swing and duty factor are design inputs with
 * the customary values offered.
 */
export const aminePackage = ({
  gasMMscfd, co2MolPct = 0, h2sMolPct = 0,
  co2SpecMolPct = 0, h2sSpecMolPct = 0,
  amineId = 'MDEA', amineWtPct, leanLoading = 0.05, richLoading,
  dutyBtuPerGal,
}) => {
  const amine = amineOf(amineId);
  if (!amine) return { error: `unknown amine '${amineId}'` };
  if (!(gasMMscfd > 0)) return { error: 'a gas rate is needed' };
  const wtPct = amineWtPct ?? amine.wtPctTypical;
  const rich = richLoading ?? amine.maxLoading;
  const duty = dutyBtuPerGal ?? amine.heatBtuPerGal;
  const swing = rich - leanLoading;
  if (!(swing > 0)) return { error: 'rich loading must exceed lean loading' };

  const removedMolPct = (co2MolPct - co2SpecMolPct) + (h2sMolPct - h2sSpecMolPct);
  if (!(removedMolPct > 0)) return { error: 'no acid gas to remove at these specs' };
  if (co2SpecMolPct > co2MolPct || h2sSpecMolPct > h2sMolPct) {
    return { error: 'a spec above the inlet is already met; check the inputs' };
  }

  const acidMolesDay = (gasMMscfd * 1e6 * (removedMolPct / 100)) / LBMOL_SCF;
  const amineMolesDay = acidMolesDay / swing;
  const amineLbDay = amineMolesDay * amine.mw;
  const solutionLbDay = amineLbDay / (wtPct / 100);
  const solutionGpd = solutionLbDay / (8.34 * amine.sgSolution);
  const circGpm = solutionGpd / 1440;
  const reboilerMMBtuHr = (circGpm * 60 * duty) / 1e6;

  return {
    acidMolesDay,
    circGpm,
    richLoadingUsed: rich,
    reboilerMMBtuHr,
    warning: rich > amine.maxLoading
      ? `rich loading above the customary ${amine.maxLoading} for ${amine.id}: corrosion territory`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Contactor sizing (Souders-Brown; K is an input with named custom)
 * ------------------------------------------------------------------ */

export const contactorDiameter = ({
  gasMMscfd, pPsia, tF, gasSg, ksFtS = 0.3, z: zIn,
}) => {
  if (!(gasMMscfd > 0) || !(pPsia > 0) || !(gasSg > 0) || !(ksFtS > 0)) {
    return { error: 'contactor sizing needs positive rate, pressure, gravity and a K value' };
  }
  const tR = toRankine(tF);
  const { tpcR, ppcPsia } = suttonPseudoCriticals(gasSg);
  const z = zIn ?? dakZ({ ppr: pPsia / ppcPsia, tpr: tR / tpcR }).z;
  const rhoG = (28.9625 * gasSg * pPsia) / (z * 10.7316 * tR);
  const rhoL = 69.9; // TEG at operating strength, lb/ft3 (published)
  const vAllow = ksFtS * Math.sqrt((rhoL - rhoG) / rhoG);
  const qActFt3S = ((gasMMscfd * 1e6) / 86400) * (14.65 / pPsia) * (tR / 520) * z;
  const areaFt2 = qActFt3S / vAllow;
  return {
    z,
    rhoG,
    vAllowFtS: vAllow,
    diameterFt: Math.sqrt((4 * areaFt2) / Math.PI),
  };
};

/* ------------------------------------------------------------------ *
 * Joule-Thomson screening, from the z-factor correlation itself
 * ------------------------------------------------------------------ */

/**
 * mu_JT = (RT^2 / (Cp P)) (dz/dT)_P / z  [consistent units], derived
 * from the real-gas enthalpy departure. z and its temperature
 * derivative come from the SAME validated DAK correlation the rest of
 * the platform uses, differentiated numerically with a central step.
 * Cp is an input (Btu/lbmol.F); the answer is F per psi.
 */
export const jouleThomsonFPerPsi = ({ pPsia, tF, gasSg, cpBtuLbmolF = 9.5 }) => {
  if (!(pPsia > 0) || !(gasSg > 0) || !(cpBtuLbmolF > 0)) {
    return { error: 'JT screening needs positive pressure, gravity and Cp' };
  }
  const tR = toRankine(tF);
  const { tpcR, ppcPsia } = suttonPseudoCriticals(gasSg);
  const zAt = (t) => dakZ({ ppr: pPsia / ppcPsia, tpr: t / tpcR }).z;
  const h = tR * 1e-4;
  const z = zAt(tR);
  const dzdT = (zAt(tR + h) - zAt(tR - h)) / (2 * h);
  // R = 10.7316 psia.ft3/(lbmol.R); Cp Btu/lbmol.R; 1 Btu = 5.4039 psia.ft3
  const rOverCp = 10.7316 / (cpBtuLbmolF * 5.40395);
  const muJT = (rOverCp * tR * tR * dzdT) / (z * pPsia); // R per psia
  return { muFPerPsi: muJT, z, dzdT };
};

/** Temperature after a JT drop, marched so mu can change with P. */
export const jtDrop = ({ p1Psia, p2Psia, tF, gasSg, cpBtuLbmolF = 9.5, steps = 20 }) => {
  if (!(p1Psia > p2Psia) || !(p2Psia > 0)) return { error: 'JT drop needs p1 above p2 above zero' };
  let t = tF;
  const dp = (p1Psia - p2Psia) / steps;
  for (let i = 0; i < steps; i += 1) {
    const p = p1Psia - dp * (i + 0.5);
    const mu = jouleThomsonFPerPsi({ pPsia: p, tF: t, gasSg, cpBtuLbmolF });
    if (mu.error) return mu;
    t -= mu.muFPerPsi * dp;
  }
  return { t2F: t, dropF: tF - t };
};
