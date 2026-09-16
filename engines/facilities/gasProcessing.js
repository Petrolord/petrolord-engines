/**
 * Gas conditioning: dehydration, sweetening, dew point (Facilities F3).
 *
 * The predecessor app hid its assumptions inside constants
 * (4 gal/lb, 750 Btu/gal, 15 percent BTEX). This engine's rule is the
 * opposite: everything that is a DESIGN CHOICE or a chart value is an
 * input with its customary range named, and everything that is
 * computable from first principles is computed.
 *
 * THE FC4-0 WAVE FOUND THIS FILE BREAKING ITS OWN RULE. The header
 * above criticised three hidden constants and the file then hid three
 * of its own: 1100 Btu per lb of water carried overhead, 69.9 lb/ft3
 * of contactor liquid and 8.34 lb per gallon of water. The first two
 * are inputs now; the third is a named export with its provenance
 * stated, because it is a customary rounding rather than something
 * this repository can derive. `DECLARED_CONSTANTS` at the foot of this
 * file lists every number in here that no oracle route can check, and
 * the gate pins each one to the value written down there, so changing
 * any of them is a reviewed act rather than a silent one.
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
 * ONE STANDARD BASE. The molar volume is derived from the package's
 * gas constant at 14.696 psia and 519.67 degR and is not quoted. The
 * file used to carry `LBMOL_SCF = 379.49` with a comment naming a
 * 14.65 psia base it does not belong to, and the contactor converted
 * standard to actual volume at a THIRD base, 14.65 psia over 520 degR:
 * 0.028173077 against the 0.028279006 psia per degR the pound mole
 * implies, a factor of 0.996254, which moves a published contactor
 * diameter by 1.001887. The same MMscfd was one molar quantity when it became
 * a water content and a different one when it became a column volume.
 *
 * Units: field throughout (MMscfd, lb/MMscf, gpm, psia, F, Btu).
 */

import {
  suttonPseudoCriticals, dakZ, toRankine, R_UNIVERSAL, AIR_MW,
} from '../production/gasProperties.js';
import {
  DAK_TPR_MIN, DAK_TPR_MAX, DAK_PPR_MIN_FIT, DAK_PPR_MAX,
} from './separatorSizing.js';

/* ------------------------------------------------------------------ *
 * The one standard base, and the volumetric packagings that are exact
 * by definition.
 * ------------------------------------------------------------------ */

/** Standard pressure and temperature of this module, once. */
export const STD_PRESSURE_PSIA = 14.696;
export const STD_TEMPERATURE_R = 519.67;

/** scf per lbmol, DERIVED from the package's gas constant at the base
 *  above: 379.48357185628737. The 379.49 this file used to quote is a
 *  rounding of it, 1.0000169391883849 times it, with no independent
 *  provenance; the comment beside it named 14.65 psia, which is a base
 *  it does not belong to at all. */
export const LBMOL_SCF = (R_UNIVERSAL * STD_TEMPERATURE_R) / STD_PRESSURE_PSIA;

const MW_WATER = 18.01528;

/** US gallons in a cubic foot. Exact: 1728 in3/ft3 over 231 in3/gal. */
export const GAL_PER_FT3 = 1728 / 231;

/** Pounds in a short ton, and days in a year, both by convention. */
const LB_PER_SHORT_TON = 2000;
const DAYS_PER_YEAR = 365;

const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = 1440;

/* ------------------------------------------------------------------ *
 * Declared constants: the numbers in this module that NO oracle route
 * can check, because there is nothing in this repository to check them
 * against. Each is exported so the gate can pin it by value and say
 * why it cannot do better. See `DECLARED_CONSTANTS` at the foot.
 * ------------------------------------------------------------------ */

/** Triethylene glycol at operating strength, lb per US gallon.
 *  THE MODULE'S ONE GLYCOL DENSITY. It used to carry two: this 9.3
 *  lb/gal as the default of `tegLbPerGal`, and a typed 69.9 lb/ft3
 *  inside the contactor, which is 1.004760 times the 69.568831 lb/ft3
 *  this one implies. Two densities of one fluid in one file is a
 *  defect whatever its size, because nothing downstream can tell which
 *  of the two it is holding. lb/gal is kept as the spelling because it
 *  is how a glycol datasheet quotes it and because it is already the
 *  door of a typed input. */
export const TEG_LB_PER_GAL = 9.3;

/** The same density in lb/ft3, derived, for Souders-Brown. */
export const TEG_LB_PER_FT3 = TEG_LB_PER_GAL * GAL_PER_FT3;

/** Water, lb per US gallon. The customary US figure; the density of
 *  water at 60 degF is 999.016 kg/m3, which is 8.337193 lb/gal, so
 *  this is 1.000338 times the measured value. It is kept because it is
 *  what the amine circulation charts this balance is compared against
 *  are drawn with, and moving it moves every shipped amine number in
 *  the platform; the gap is recorded rather than silently closed. */
export const WATER_LB_PER_GAL = 8.34;

/** Btu per lb of water carried out of the still overhead: the latent
 *  heat plus the sensible heat to reach the still, folded. Customary;
 *  no publication in this repository splits it, so the 970 Btu/lb the
 *  old comment named was NOT IN THE CODE and could not be recovered
 *  from outside. It is the DEFAULT of an input now
 *  (`waterOverheadBtuPerLb`), so a user who has a better figure can
 *  state it and a grader can see what was assumed. */
export const WATER_OVERHEAD_BTU_PER_LB = 1100;

/** Molecular weight of the BTEX cut carried by the glycol. 92.14 is
 *  toluene; a real BTEX cut is benzene, toluene, ethylbenzene and the
 *  xylenes in field-dependent proportions, so this default is one
 *  compound standing for four and is an input for that reason. */
export const BTEX_MW_DEFAULT = 92;

/* ------------------------------------------------------------------ *
 * Refusal helpers. Every refusal names the input and its value, and
 * carries whatever evidence the caller needs to see where it died.
 * One sentence covering several unrelated faults is itself a defect.
 * ------------------------------------------------------------------ */

const num = (v) => (typeof v === 'number' && Number.isFinite(v));
const show = (v) => (v === undefined ? 'undefined' : String(v));

/** Refuse unless `v` is a finite number strictly above zero. */
const needPositive = (v, name, unit) => (num(v) && v > 0
  ? null
  : `${name} must be a finite number above zero (got ${show(v)}${unit ? ` ${unit}` : ''})`);

/** Refuse unless `v` is a finite number at or above zero. */
const needNonNegative = (v, name, unit) => (num(v) && v >= 0
  ? null
  : `${name} must be a finite number at or above zero (got ${show(v)}${unit ? ` ${unit}` : ''})`);

const needInRange = (v, lo, hi, name, unit) => (num(v) && v >= lo && v <= hi
  ? null
  : `${name} must be between ${lo} and ${hi}${unit ? ` ${unit}` : ''} (got ${show(v)})`);

/** Above absolute zero, stated in degF because that is this module's door. */
const ABSOLUTE_ZERO_F = -459.67;
const needAboveAbsoluteZero = (tF, name) => (num(tF) && toRankine(tF) > 0
  ? null
  : `${name} must be a finite temperature above absolute zero (${ABSOLUTE_ZERO_F} degF); got ${show(tF)} degF`);

/** Run a list of guards and return the first refusal, or null. */
const firstFault = (checks) => checks.find((c) => c !== null) ?? null;

/* ------------------------------------------------------------------ *
 * Water content
 * ------------------------------------------------------------------ */

/**
 * Magnus saturation pressure of water over the LIQUID, psia.
 *
 * Alduchov & Eskridge (1996) coefficients, published over -40 to
 * +50 degC with a stated maximum error of 0.384 percent. This function
 * accepts -45 to +60 degC, which is the band the module's own docstring
 * has always claimed, and NOT the 100 degC its guard used to allow.
 *
 * The old 100 degC guard was a fails-open: at its own upper edge the
 * fit puts the vapour pressure of water at 15.095051 psia where the
 * DEFINITION of the normal boiling point fixes 14.695949, so it read
 * 1.027157 times the defining value and said nothing. Against the
 * Antoine fit the oracle uses, the gap runs 0.12 percent at 30 degC,
 * 0.45 percent at 50, 0.77 percent at 60, 1.63 percent at 80 and
 * 2.70 percent at 100. 60 degC is 140 degF, which is a real contactor
 * inlet; 100 degC is not a temperature this fit should be asked about.
 *
 * BARE-NUMBER CONTRACT, DELIBERATE AND DOCUMENTED: this is a leaf
 * correlation with nowhere to put an error key, so it returns NaN
 * outside its band and never returns a plausible number there. Its one
 * caller, `saturatedWaterContent`, turns that into a named refusal.
 */
export const WATER_FIT_MIN_C = -45;
export const WATER_FIT_MAX_C = 60;
/** The same band at this module's own door, which is degF. Both are
 *  exact: -45 degC is -49 degF and 60 degC is 140 degF. */
export const WATER_FIT_MIN_F = -49;
export const WATER_FIT_MAX_F = 140;
export const WATER_FIT_PUBLISHED_MIN_C = -40;
export const WATER_FIT_PUBLISHED_MAX_C = 50;

export const waterSatPsia = (tF) => {
  if (!num(tF)) return NaN;
  const tC = (tF - 32) / 1.8;
  if (tC < WATER_FIT_MIN_C || tC > WATER_FIT_MAX_C) return NaN;
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
  const fault = firstFault([
    needPositive(pPsia, 'total pressure', 'psia'),
    needAboveAbsoluteZero(tF, 'gas temperature'),
  ]);
  if (fault) return { error: fault };
  const tC = (tF - 32) / 1.8;
  const psat = waterSatPsia(tF);
  if (Number.isNaN(psat)) {
    return {
      error: `the Magnus water-saturation fit holds from ${WATER_FIT_MIN_C} to ${WATER_FIT_MAX_C} degC (${WATER_FIT_MIN_F} to ${WATER_FIT_MAX_F} degF); ${tF} degF is ${tC.toFixed(1)} degC`,
      tC,
    };
  }
  if (!(pPsia > psat)) {
    return {
      error: `total pressure ${pPsia} psia must exceed the water vapour pressure ${psat.toFixed(4)} psia at ${tF} degF, or the gas is not a gas`,
      psatPsia: psat,
    };
  }
  const y = psat / pPsia;
  const lbPerMMscf = y * (1e6 / LBMOL_SCF) * MW_WATER;
  const notes = [];
  if (pPsia > 1000) {
    notes.push('ideal-mixing estimate: above about 1000 psia the real-gas correction of the McKetta-Wehe chart grows to tens of percent; use a chart reading for design');
  }
  if (tC > WATER_FIT_PUBLISHED_MAX_C || tC < WATER_FIT_PUBLISHED_MIN_C) {
    notes.push(`${tC.toFixed(1)} degC is outside the ${WATER_FIT_PUBLISHED_MIN_C} to ${WATER_FIT_PUBLISHED_MAX_C} degC the Magnus coefficients were published over; the fit is extrapolated here and reads about 0.8 percent above the Antoine fit at ${WATER_FIT_MAX_C} degC`);
  }
  return {
    lbPerMMscf,
    yWater: y,
    psatPsia: psat,
    warning: notes.length ? notes.join('. ') : null,
  };
};

/* ------------------------------------------------------------------ *
 * Staged absorption (Kremser)
 * ------------------------------------------------------------------ */

/**
 * Kremser: fraction absorbed after N theoretical stages with
 * absorption factor A = L/(V K).
 *
 * OBJECT CONTRACT SINCE FC4-0. This was the one export in the module
 * outside the object-carrying-an-error contract: it returned a bare
 * number, so a non-positive absorption factor or stage count came back
 * as NaN, every caller's `if (r.error)` guard passed, and the Suite
 * rendered an empty dash where a fault belonged. Callers read
 * `.fractionRemoved`.
 */
export const kremserFractionRemoved = ({ absorptionFactor: A, stages: N }) => {
  const fault = firstFault([
    needPositive(A, 'absorption factor'),
    needPositive(N, 'theoretical stages'),
  ]);
  if (fault) return { error: fault };
  if (Math.abs(A - 1) < 1e-9) return { fractionRemoved: N / (N + 1) };
  return { fractionRemoved: (A ** (N + 1) - A) / (A ** (N + 1) - 1) };
};

export const kremserStagesFor = ({ absorptionFactor: A, fractionRemoved: f }) => {
  const fault = firstFault([
    needPositive(A, 'absorption factor'),
    (num(f) && f > 0 && f < 1) ? null : `the fraction removed must be between 0 and 1, exclusive (got ${show(f)})`,
  ]);
  if (fault) return { error: fault };
  if (A <= f) {
    return {
      error: `an absorption factor of ${A} caps the removal at ${A} however many stages are added, and the spec asks for ${f}: no stage count reaches it; raise circulation`,
      absorptionFactor: A,
      fractionRemoved: f,
      ceiling: A,
    };
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
 *
 * WHAT `leanTegWtPct` IS FOR (FC4-0 decision). It used to be range
 * checked, refused outside 90 to 100, and then never read: the package
 * run at 99.0 and at 90.001 returned every field bit-identical. A
 * validated input that moves nothing is worse than an absent one,
 * because the validation asserts that it matters.
 *
 * The temptation was to make it set the achievable outlet spec. That
 * is a chart (the equilibrium dew point of gas over lean glycol) and
 * this repository does not carry it, so making one up would be
 * inventing an unsourced model on top of a typed one. Instead the
 * input now does the thing that IS computable from it with no chart at
 * all: the LOOP WATER BALANCE. A gallon of lean glycol at w weight
 * percent carries (1 - w/100) lb of water per lb of solution before it
 * absorbs anything, and comes back rich at a strength this function
 * reports. The outlet spec stays a typed design input, and the
 * docstring says so instead of the validation implying otherwise.
 */
export const tegPackage = ({
  gasMMscfd, inletLbMMscf, outletLbMMscf,
  circulationGalPerLb = 3, leanTegWtPct = 99.0,
  absorberTF = 100, reboilerTF = 380, refluxRatio = 0.25,
  cpTegBtuLbF = 0.55, tegLbPerGal = TEG_LB_PER_GAL,
  waterOverheadBtuPerLb = WATER_OVERHEAD_BTU_PER_LB,
  btexInletPpmv = 0, btexAbsorbedFrac = 0.15, btexMw = BTEX_MW_DEFAULT,
}) => {
  const fault = firstFault([
    needPositive(gasMMscfd, 'gas rate', 'MMscfd'),
    needNonNegative(inletLbMMscf, 'inlet water content', 'lb/MMscf'),
    needNonNegative(outletLbMMscf, 'outlet water spec', 'lb/MMscf'),
    needPositive(circulationGalPerLb, 'circulation ratio', 'gal TEG per lb water'),
    needPositive(cpTegBtuLbF, 'glycol heat capacity', 'Btu/lb.F'),
    needPositive(tegLbPerGal, 'glycol density', 'lb/gal'),
    needPositive(waterOverheadBtuPerLb, 'water overhead', 'Btu/lb'),
    needNonNegative(refluxRatio, 'reflux ratio'),
    needAboveAbsoluteZero(absorberTF, 'absorber temperature'),
    needAboveAbsoluteZero(reboilerTF, 'reboiler temperature'),
    needNonNegative(btexInletPpmv, 'BTEX at inlet', 'ppmv'),
    needInRange(btexAbsorbedFrac, 0, 1, 'BTEX absorbed fraction'),
    needPositive(btexMw, 'BTEX molecular weight', 'lb/lbmol'),
  ]);
  if (fault) return { error: fault };

  // A still that is colder than the absorber it is drying glycol for
  // returns a NEGATIVE sensible duty and, below about 200 degF of
  // approach, a negative reboiler duty outright: -0.32 MMBtu/hr was on
  // screen with no warning at absorber 380, reboiler 100.
  if (!(reboilerTF > absorberTF)) {
    return {
      error: `the reboiler must be hotter than the absorber, or the glycol is not being regenerated: reboiler ${reboilerTF} degF against absorber ${absorberTF} degF`,
      absorberTF,
      reboilerTF,
    };
  }
  if (!(leanTegWtPct > 90) || leanTegWtPct >= 100) {
    return {
      error: `lean TEG must be between 90 and 100 weight percent, exclusive (got ${show(leanTegWtPct)}); below 90 the loop is not a dehydration loop and 100 is unreachable`,
      leanTegWtPct,
    };
  }
  const removedLbMMscf = inletLbMMscf - outletLbMMscf;
  if (!(removedLbMMscf > 0)) {
    return {
      error: `inlet water content must exceed the outlet spec: ${inletLbMMscf} against ${outletLbMMscf} lb/MMscf leaves nothing for the contactor to do`,
      inletLbMMscf,
      outletLbMMscf,
    };
  }

  const waterLbDay = removedLbMMscf * gasMMscfd;
  const circGpd = waterLbDay * circulationGalPerLb;
  const circGpm = circGpd / MINUTES_PER_DAY;

  // Reboiler duty per gallon, from named parts:
  //  sensible: heat the glycol from absorber to reboiler temperature
  //  vaporization: boil the absorbed water out, at the stated overhead
  //  reflux: a stated fraction of the overhead condensed and reboiled
  const sensiblePerGal = tegLbPerGal * cpTegBtuLbF * (reboilerTF - absorberTF);
  const waterPerGal = 1 / circulationGalPerLb; // lb water per gal TEG
  const vaporPerGal = waterPerGal * waterOverheadBtuPerLb * (1 + refluxRatio);
  const dutyBtuPerGal = sensiblePerGal + vaporPerGal;
  const reboilerMMBtuHr = (circGpd * dutyBtuPerGal) / HOURS_PER_DAY / 1e6;

  // The loop water balance, which is what the lean strength buys.
  // Per gallon circulated: the lean solution already carries water, and
  // the contactor adds `waterPerGal` more.
  const leanWaterLbPerGal = tegLbPerGal * (1 - leanTegWtPct / 100);
  const glycolLbPerGal = tegLbPerGal - leanWaterLbPerGal;
  const richLbPerGal = tegLbPerGal + waterPerGal;
  const richTegWtPct = (glycolLbPerGal / richLbPerGal) * 100;

  // BTEX: the absorbed fraction is a chart/operating value (typed);
  // the arithmetic from it is a mole balance.
  const btexMolesDay = (gasMMscfd * 1e6 * (btexInletPpmv / 1e6)) / LBMOL_SCF;
  const btexLbDay = btexMolesDay * btexAbsorbedFrac * btexMw;

  const notes = [];
  if (circulationGalPerLb < 2 || circulationGalPerLb > 5) {
    notes.push('circulation ratio outside the customary 2 to 5 gal per lb');
  }
  if (richTegWtPct < 90) {
    notes.push(`the rich glycol returns at ${richTegWtPct.toFixed(2)} weight percent, below the 90 this module will accept as a LEAN strength: the loop is carrying more water than a glycol loop is meant to`);
  }
  return {
    waterLbDay,
    circGpm,
    circGpd,
    dutyBtuPerGal,
    sensiblePerGal,
    vaporPerGal,
    reboilerMMBtuHr,
    btexLbDay,
    btexTonsYear: (btexLbDay * DAYS_PER_YEAR) / LB_PER_SHORT_TON,
    leanWaterLbPerGal,
    richTegWtPct,
    waterOverheadBtuPerLb,
    // The outlet spec is a DESIGN INPUT, not something the lean
    // strength is made to justify here; see the docstring.
    outletSpecBasis: 'typed: the dew point lean glycol can deliver is a chart this module does not carry',
    warning: notes.length ? notes.join('. ') : null,
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
  // sgSolution: specific gravity of the solution at strength, which is
  // what `contactorDiameter` should be sized against on a sweetening
  // column; see `solutionLbPerFt3`.
  { id: 'MEA', mw: 61.08, wtPctTypical: 18, maxLoading: 0.35, heatBtuPerGal: 1100, sgSolution: 1.01 },
  { id: 'DEA', mw: 105.14, wtPctTypical: 28, maxLoading: 0.4, heatBtuPerGal: 950, sgSolution: 1.02 },
  { id: 'MDEA', mw: 119.16, wtPctTypical: 45, maxLoading: 0.5, heatBtuPerGal: 800, sgSolution: 1.04 },
];

export const amineOf = (id) => AMINES.find((a) => a.id === id) || null;

/**
 * Liquid density in lb/ft3 from a specific gravity, through the
 * module's ONE water density. This exists so a caller sizing an AMINE
 * contactor can hand `contactorDiameter` the amine's own solution
 * density instead of letting it default to glycol: the Suite sized
 * both columns against 69.9 lb/ft3 of TEG, which is 1.94 percent small
 * on MDEA's own defaults.
 */
export const solutionLbPerFt3 = (sg) => sg * WATER_LB_PER_GAL * GAL_PER_FT3;

/** The amine solution density `contactorDiameter` wants, by id. */
export const amineSolutionLbPerFt3 = (id) => {
  const a = amineOf(id);
  return a ? solutionLbPerFt3(a.sgSolution) : null;
};

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
  if (!amine) {
    return { error: `unknown amine '${show(amineId)}'; this module carries ${AMINES.map((a) => a.id).join(', ')}` };
  }
  const wtPct = amineWtPct ?? amine.wtPctTypical;
  const rich = richLoading ?? amine.maxLoading;
  const duty = dutyBtuPerGal ?? amine.heatBtuPerGal;

  const fault = firstFault([
    needPositive(gasMMscfd, 'gas rate', 'MMscfd'),
    needNonNegative(co2MolPct, 'CO2 at inlet', 'mol percent'),
    needNonNegative(h2sMolPct, 'H2S at inlet', 'mol percent'),
    needNonNegative(co2SpecMolPct, 'CO2 spec', 'mol percent'),
    needNonNegative(h2sSpecMolPct, 'H2S spec', 'mol percent'),
    // A solution is a solution: 0 gives an infinite circulation and a
    // negative strength gave -372 gpm and a regenerator making heat.
    (num(wtPct) && wtPct > 0 && wtPct <= 100)
      ? null
      : `amine strength must be above 0 and at or below 100 weight percent (got ${show(wtPct)})`,
    needNonNegative(leanLoading, 'lean loading', 'mol acid gas per mol amine'),
    needPositive(rich, 'rich loading', 'mol acid gas per mol amine'),
    needPositive(duty, 'regenerator duty', 'Btu per gallon circulated'),
  ]);
  if (fault) return { error: fault };

  // Order matters: the specific fault is reported before the general
  // one. A CO2 spec above the CO2 inlet with no H2S used to come back
  // as "no acid gas to remove at these specs", which sent a user off
  // to check the gas rather than the spec they had just typed.
  if (co2SpecMolPct > co2MolPct || h2sSpecMolPct > h2sMolPct) {
    return {
      error: `a spec above the inlet is already met: CO2 ${co2SpecMolPct} against ${co2MolPct} mol percent, H2S ${h2sSpecMolPct} against ${h2sMolPct}`,
      co2MolPct, co2SpecMolPct, h2sMolPct, h2sSpecMolPct,
    };
  }
  const swing = rich - leanLoading;
  if (!(swing > 0)) {
    return {
      error: `rich loading must exceed lean loading: ${rich} against ${leanLoading} mol acid gas per mol amine leaves no swing to circulate on`,
      richLoading: rich, leanLoading,
    };
  }
  const removedMolPct = (co2MolPct - co2SpecMolPct) + (h2sMolPct - h2sSpecMolPct);
  if (!(removedMolPct > 0)) {
    return {
      error: `no acid gas to remove at these specs: CO2 ${co2MolPct} to ${co2SpecMolPct} and H2S ${h2sMolPct} to ${h2sSpecMolPct} mol percent`,
      removedMolPct,
    };
  }

  const acidMolesDay = (gasMMscfd * 1e6 * (removedMolPct / 100)) / LBMOL_SCF;
  const amineMolesDay = acidMolesDay / swing;
  const amineLbDay = amineMolesDay * amine.mw;
  const solutionLbDay = amineLbDay / (wtPct / 100);
  const solutionGpd = solutionLbDay / (WATER_LB_PER_GAL * amine.sgSolution);
  const circGpm = solutionGpd / MINUTES_PER_DAY;
  const reboilerMMBtuHr = (circGpm * 60 * duty) / 1e6;

  return {
    acidMolesDay,
    circGpm,
    solutionGpd,
    richLoadingUsed: rich,
    leanLoadingUsed: leanLoading,
    amineWtPctUsed: wtPct,
    dutyBtuPerGalUsed: duty,
    solutionLbPerFt3: solutionLbPerFt3(amine.sgSolution),
    reboilerMMBtuHr,
    warning: rich > amine.maxLoading
      ? `rich loading above the customary ${amine.maxLoading} for ${amine.id}: corrosion territory`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * The z-factor door of this module
 * ------------------------------------------------------------------ */

const beside = (v, limit) => `${v.toFixed(3)} against ${limit.toFixed(1)}`;

/**
 * z at a state, from the validated correlation, INSIDE ITS VALIDITY
 * WINDOW AND NOWHERE ELSE, with `dakZ`'s own convergence flag carried
 * rather than discarded.
 *
 * Both consumers in this file used to call `dakZ(...).z` and throw the
 * rest away. `contactorDiameter` reported z = 2.48 at 20000 psia and
 * z = 11.00 at 60000 psia with a finite diameter and no note, and
 * `jouleThomsonFPerPsi` did something worse: above a gas gravity of
 * 5.08 Sutton's pseudo-critical PRESSURE goes negative, `dakZ` takes
 * its non-positive-Ppr branch and hands back z = 1, so the coefficient
 * came back EXACTLY ZERO, which reads as "this gas does not cool". At
 * 5.07 it came back NEGATIVE with z = 38.5, which says the gas HEATS
 * on expansion. Neither is reachable through a flag, because `dakZ`
 * reports `converged: true` for both: the window has to be checked,
 * and the pseudo-criticals have to be checked before the window.
 *
 * The window is IMPORTED from `separatorSizing.js`, which declares and
 * documents it, rather than restated here. That is the same one-owner
 * rule the standard base above is fixed by, and it is what
 * `compression.js` does.
 *
 * Returns an object either way, and the refusal carries the reduced
 * coordinates and the state they were taken at.
 */
export const zAtState = ({ pPsia, tF, gasSg }) => {
  const fault = firstFault([
    needPositive(pPsia, 'pressure', 'psia'),
    needPositive(gasSg, 'gas gravity'),
    needAboveAbsoluteZero(tF, 'temperature'),
  ]);
  if (fault) return { error: fault, atPsia: pPsia, atF: tF };
  const at = `at ${pPsia} psia and ${tF} degF`;
  const tR = toRankine(tF);
  const { tpcR, ppcPsia } = suttonPseudoCriticals(gasSg);
  if (!(tpcR > 0) || !(ppcPsia > 0)) {
    return {
      error: `the Sutton pseudo-criticals are not physical at a gas gravity of ${gasSg}: Tpc ${tpcR.toFixed(1)} degR, Ppc ${ppcPsia.toFixed(1)} psia. Sutton's pressure correlation turns negative above a gravity of about 5.08, and a gas that heavy is not a natural gas`,
      tpcR, ppcPsia, atPsia: pPsia, atF: tF,
    };
  }
  const ppr = pPsia / ppcPsia;
  const tpr = tR / tpcR;
  const ev = { ppr, tpr, tpcR, ppcPsia, atPsia: pPsia, atF: tF };
  if (tpr < DAK_TPR_MIN) {
    return { ...ev, error: `Tpr ${beside(tpr, DAK_TPR_MIN)} is below the DAK validity range of 1.0 to 3.0, ${at}: the z-factor would be an extrapolation below the critical temperature, so it is refused` };
  }
  if (tpr > DAK_TPR_MAX) {
    return { ...ev, error: `Tpr ${beside(tpr, DAK_TPR_MAX)} is above the DAK validity range of 1.0 to 3.0, ${at}, so the z-factor is refused` };
  }
  if (ppr > DAK_PPR_MAX) {
    return { ...ev, error: `Ppr ${beside(ppr, DAK_PPR_MAX)} is above the DAK validity limit of 30, ${at}, so the z-factor is refused` };
  }
  const zr = dakZ({ ppr, tpr });
  if (!zr.converged || !(zr.z > 0)) {
    return { ...ev, error: `the DAK z-factor did not converge ${at} (Ppr ${ppr.toFixed(3)}, Tpr ${tpr.toFixed(3)})` };
  }
  return {
    ...ev,
    z: zr.z,
    converged: zr.converged,
    note: ppr < DAK_PPR_MIN_FIT
      ? `Ppr ${beside(ppr, DAK_PPR_MIN_FIT)} ${at} is below the 0.2 where the DAK fit data start; the z-factor here runs toward the ideal-gas limit`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Contactor sizing (Souders-Brown; K is an input with named custom)
 * ------------------------------------------------------------------ */

/**
 * Souders-Brown contactor diameter.
 *
 * THE LIQUID DENSITY IS AN INPUT SINCE FC4-0. It was a typed 69.9
 * lb/ft3 of glycol, and the Suite called this ONE function for both
 * its columns, so the AMINE contactor was sized against GLYCOL: on the
 * app's own MDEA defaults the diameter came out 1.94 percent small.
 * The default is the module's one glycol density, derived from
 * `TEG_LB_PER_GAL` rather than typed a second time; a sweetening
 * caller passes `amineSolutionLbPerFt3(amineId)`.
 *
 * `z` may still be supplied by a caller that has one; when it is not,
 * it comes from `zAtState`, which refuses outside the DAK window
 * instead of reporting z = 11 with a straight face.
 */
export const contactorDiameter = ({
  gasMMscfd, pPsia, tF, gasSg, ksFtS = 0.3, z: zIn,
  rhoLLbFt3 = TEG_LB_PER_FT3,
}) => {
  const fault = firstFault([
    needPositive(gasMMscfd, 'gas rate', 'MMscfd'),
    needPositive(pPsia, 'pressure', 'psia'),
    needPositive(gasSg, 'gas gravity'),
    needPositive(ksFtS, 'Souders-Brown K', 'ft/s'),
    needPositive(rhoLLbFt3, 'liquid density', 'lb/ft3'),
    needAboveAbsoluteZero(tF, 'contactor temperature'),
    zIn === undefined ? null : needPositive(zIn, 'supplied z-factor'),
  ]);
  if (fault) return { error: fault };

  const tR = toRankine(tF);
  let z = zIn;
  let zNote = null;
  let zSource = 'supplied by the caller';
  if (z === undefined) {
    const zr = zAtState({ pPsia, tF, gasSg });
    if (zr.error) return { error: zr.error, ppr: zr.ppr, tpr: zr.tpr, atPsia: pPsia, atF: tF };
    z = zr.z;
    zNote = zr.note;
    zSource = 'DAK correlation at these conditions';
  }

  const rhoG = (AIR_MW * gasSg * pPsia) / (z * R_UNIVERSAL * tR);
  if (!(rhoLLbFt3 > rhoG)) {
    return {
      error: `the liquid must be denser than the gas for Souders-Brown to mean anything: liquid ${rhoLLbFt3.toFixed(2)} against gas ${rhoG.toFixed(2)} lb/ft3 at ${pPsia} psia and ${tF} degF`,
      rhoG, rhoLLbFt3, z,
    };
  }
  const vAllow = ksFtS * Math.sqrt((rhoLLbFt3 - rhoG) / rhoG);
  // Standard to actual volume at THE MODULE'S base, not a second one.
  const qActFt3S = ((gasMMscfd * 1e6) / 86400)
    * (STD_PRESSURE_PSIA / pPsia) * (tR / STD_TEMPERATURE_R) * z;
  const areaFt2 = qActFt3S / vAllow;
  return {
    z,
    zSource,
    rhoG,
    rhoLLbFt3,
    qActFt3S,
    vAllowFtS: vAllow,
    diameterFt: Math.sqrt((4 * areaFt2) / Math.PI),
    warning: zNote,
  };
};

/* ------------------------------------------------------------------ *
 * Joule-Thomson screening, from the z-factor correlation itself
 * ------------------------------------------------------------------ */

/** Btu to psia.ft3. Exact given the international-table Btu and the
 *  exact foot, pound and standard gravity: 1 Btu = 1055.05585262 J and
 *  1 psia.ft3 = 6894.757293168 Pa x 0.3048^3 m3 = 195.20233960140358 J,
 *  so 1 Btu = 5.403953... psia.ft3. The 5.40395 this file used to type
 *  is a rounding of it. */
const PSIA_FT3_PER_BTU = 1055.05585262 / (6894.757293168 * 0.3048 ** 3);

/**
 * The Joule-Thomson coefficient of a real gas, from the DAK z-factor
 * correlation and its temperature derivative.
 *
 *   mu_JT = (1/Cp) [ T (dV/dT)_P - V ],   V = z R T / P
 *   T (dV/dT)_P = (R/P)( T z + T^2 (dz/dT)_P ) = V + (R T^2 / P)(dz/dT)_P
 *   =>  mu_JT = (R T^2 / (Cp P)) (dz/dT)_P
 *
 * THERE IS NO z IN THE DENOMINATOR. This function divided by one until
 * FC4-0, and so did the docstring above it, which is why it read as
 * settled rather than as a typo. The error is exactly a factor of 1/z:
 * zero in the ideal-gas limit and growing with pressure, which is the
 * shape that hides it, because it is smallest exactly where a sanity
 * check is easiest. On the Dew Point tab's own shipped defaults it
 * made the coefficient 6.6 degF per 100 psi instead of 5.7, the
 * cooling 27.3 degF instead of 24.0, and the water the cold gas can
 * hold 31.5 lb/MMscf instead of 35.1. A dew point skid is BOUGHT for
 * its cooling, so the old number sold a depression it does not deliver.
 *
 * The identity above is the whole derivation and admits no alternative;
 * `tools/validation/facilities/oracle_gasprocessing.py` checks it by a
 * route that does not use it, forming V from an independently solved z
 * and differentiating NUMERICALLY, so nothing but the correlation is
 * shared.
 *
 * z and its derivative come from the same validated DAK correlation
 * the rest of the platform uses, differentiated with a central step of
 * 1e-4 of the absolute temperature. Cp is an input (Btu/lbmol.F); the
 * answer is degF per psi.
 */
export const jouleThomsonFPerPsi = ({ pPsia, tF, gasSg, cpBtuLbmolF = 9.5 }) => {
  const fault = firstFault([
    needPositive(cpBtuLbmolF, 'heat capacity', 'Btu/lbmol.F'),
  ]);
  if (fault) return { error: fault };
  const zr = zAtState({ pPsia, tF, gasSg });
  if (zr.error) return { error: zr.error, ppr: zr.ppr, tpr: zr.tpr, atPsia: pPsia, atF: tF };

  const tR = toRankine(tF);
  const { tpcR, ppcPsia } = zr;
  const zAt = (t) => dakZ({ ppr: pPsia / ppcPsia, tpr: t / tpcR }).z;
  const h = tR * 1e-4;
  const z = zr.z;
  const dzdT = (zAt(tR + h) - zAt(tR - h)) / (2 * h);
  // R = 10.7316 psia.ft3/(lbmol.R); Cp Btu/lbmol.R
  const rOverCp = R_UNIVERSAL / (cpBtuLbmolF * PSIA_FT3_PER_BTU);
  const muJT = (rOverCp * tR * tR * dzdT) / pPsia; // degR per psia = degF per psi
  return {
    muFPerPsi: muJT,
    z,
    dzdT,
    ppr: zr.ppr,
    tpr: zr.tpr,
    warning: zr.note,
  };
};

/**
 * Temperature after a Joule-Thomson let-down, marched so mu can change
 * with pressure AND with the temperature the cooling has already
 * produced.
 *
 *   dT/dP = mu_JT(P, T),  integrated from p1 down to p2
 *
 * MIDPOINT RUNGE-KUTTA, `steps` equal pressure intervals, two
 * coefficient evaluations per interval. The march used to evaluate mu
 * at each interval's MIDPOINT PRESSURE but at the temperature it
 * started the interval with, which is midpoint in P and plain Euler in
 * T, so it was FIRST ORDER overall and carried a one-directional bias:
 * measured against a 20000-step march of itself it UNDERSTATED the
 * cooling by 3119 ppm on a 1000 to 600 psia drop, 4816 ppm on 1000 to
 * 400 and 6775 ppm on 850 to 300, and the error halved only when the
 * step count doubled, so 20 steps could not be made good by any
 * affordable increase. Taking the half-step temperature as well as the
 * half-step pressure makes it second order: the same 20 steps now land
 * within about 1e-5 of the converged answer on every case in the
 * golden, which is below the precision anything downstream prints.
 *
 * `steps` is a POSITIVE INTEGER. At zero or below, the loop never ran
 * and the function reported `dropF: 0` with no error, which reads as
 * "this gas does not cool"; at 0.4 it marched PAST the outlet pressure,
 * reporting 83.4 degF of cooling on a 1000 to 400 drop against 41.2.
 */
export const jtDrop = ({ p1Psia, p2Psia, tF, gasSg, cpBtuLbmolF = 9.5, steps = 20 }) => {
  const fault = firstFault([
    needPositive(p2Psia, 'outlet pressure', 'psia'),
    needPositive(p1Psia, 'inlet pressure', 'psia'),
    (Number.isInteger(steps) && steps > 0)
      ? null
      : `the march needs a positive whole number of steps (got ${show(steps)})`,
  ]);
  if (fault) return { error: fault };
  if (!(p1Psia > p2Psia)) {
    return {
      error: `a Joule-Thomson let-down needs the inlet above the outlet: ${p1Psia} against ${p2Psia} psia`,
      p1Psia,
      p2Psia,
    };
  }
  const dp = (p1Psia - p2Psia) / steps;
  let t = tF;
  let muInlet = null;
  let muOutlet = null;
  let note = null;
  for (let i = 0; i < steps; i += 1) {
    const p = p1Psia - dp * i;
    const k1 = jouleThomsonFPerPsi({ pPsia: p, tF: t, gasSg, cpBtuLbmolF });
    if (k1.error) {
      return {
        error: `the march died at step ${i + 1} of ${steps}: ${k1.error}`,
        diedAtStep: i + 1, diedAtPsia: p, diedAtF: t, steps,
      };
    }
    const tHalf = t - k1.muFPerPsi * (dp / 2);
    const k2 = jouleThomsonFPerPsi({ pPsia: p - dp / 2, tF: tHalf, gasSg, cpBtuLbmolF });
    if (k2.error) {
      return {
        error: `the march died at the half step of step ${i + 1} of ${steps}: ${k2.error}`,
        diedAtStep: i + 1, diedAtPsia: p - dp / 2, diedAtF: tHalf, steps,
      };
    }
    if (muInlet === null) muInlet = k1.muFPerPsi;
    muOutlet = k2.muFPerPsi;
    if (note === null && (k1.warning || k2.warning)) note = k1.warning || k2.warning;
    t -= k2.muFPerPsi * dp;
  }
  const dropF = tF - t;
  return {
    t2F: t,
    dropF,
    steps,
    // The coefficient the march actually delivered, which is NOT the one
    // at the inlet: the Suite prints an inlet coefficient beside a
    // temperature that twenty other coefficients produced, and this is
    // the number that belongs there.
    muMeanFPerPsi: dropF / (p1Psia - p2Psia),
    muInletFPerPsi: muInlet,
    muLastStepFPerPsi: muOutlet,
    warning: note,
  };
};

/* ------------------------------------------------------------------ *
 * The numbers no oracle route in this package can check.
 *
 * Every entry here is a customary or chart value with no publication
 * in this repository to check it against. The gate pins each one to
 * the value written down here and says that pinning is all it can do:
 * it makes a change to any of them a reviewed act instead of a silent
 * one, which is the honest best available for a number with no
 * independent source. It is NOT a validation, and nothing in the
 * course may present it as one.
 *
 * The recon that preceded this wave planted five defects in this
 * module and the suite stayed at 12 of 12 passing for all five; three
 * of the five were changes to numbers on this list.
 * ------------------------------------------------------------------ */
export const DECLARED_CONSTANTS = {
  TEG_LB_PER_GAL,
  WATER_LB_PER_GAL,
  WATER_OVERHEAD_BTU_PER_LB,
  BTEX_MW_DEFAULT,
  MW_WATER,
  AMINE_SG_SOLUTION: AMINES.map((a) => [a.id, a.sgSolution]),
  AMINE_MW: AMINES.map((a) => [a.id, a.mw]),
  AMINE_MAX_LOADING: AMINES.map((a) => [a.id, a.maxLoading]),
  AMINE_HEAT_BTU_PER_GAL: AMINES.map((a) => [a.id, a.heatBtuPerGal]),
  AMINE_WT_PCT_TYPICAL: AMINES.map((a) => [a.id, a.wtPctTypical]),
  MAGNUS_A: 0.61094,
  MAGNUS_B: 17.625,
  MAGNUS_C: 243.04,
  CUSTOMARY_CIRCULATION_LO: 2,
  CUSTOMARY_CIRCULATION_HI: 5,
  CHART_WARNING_PSIA: 1000,
};
