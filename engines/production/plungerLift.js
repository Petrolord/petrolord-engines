/**
 * Plunger lift (Production P7).
 *
 * A plunger is a free piston. The well is shut in until the casing has
 * built enough pressure to push the plunger, with a slug of liquid on
 * top of it, from the bottom of the tubing to surface. The well then
 * flows until it can no longer carry its liquid, the plunger falls
 * back, and the cycle repeats. It is the cheapest form of artificial
 * lift there is, and it works only when the well makes enough gas per
 * barrel to do that work.
 *
 * WHAT IS PHYSICS HERE AND WHAT IS OPERATING PRACTICE. The division
 * matters, because plunger lift is a field with a lot of rules of
 * thumb and this module is careful not to dress any of them up.
 *
 *   Physics, computed:
 *     - the pressure needed to lift the plunger and its slug, which is
 *       a static force balance and nothing more
 *     - the gas volume that has to expand to move them, from the real
 *       gas law over the swept tubing volume
 *     - the gas-liquid ratio that follows from those two, which is the
 *       honest feasibility number
 *     - the cycle arithmetic, once the velocities are known
 *
 *   Operating practice, INPUTS with stated typical ranges:
 *     - plunger rise and fall velocities
 *     - slug and plunger friction
 *     - afterflow and shut-in times
 *     - the screening rule of thumb, which is offered as a labelled
 *       cross-check and never as the answer
 *
 * The well-known screening heuristic -- roughly 400 scf of gas per
 * barrel per 1,000 ft of depth -- is included as
 * `ruleOfThumbGlr` because operators use it and comparing against it
 * is informative. It is NOT how this module decides feasibility. The
 * required gas-liquid ratio is computed from the work the gas actually
 * has to do, and the two are reported side by side.
 *
 * Field units: depth ft, pressure psia, length ft, area in2 and ft2,
 * volume bbl and scf, rate Mscf/d and bbl/d, velocity ft/min, time min.
 */

import {
  P_STANDARD_PSIA, T_STANDARD_R, gasDensityLbFt3, tubingAreaFt2,
  describeUnusableNumber,
} from './gasWellLoading.js';

/**
 * One decimal, with the thousands separators the messages already used.
 * The gas-liquid ratio warning contrasts what a cycle needs with what
 * the well makes, and rounded whole the two can print identically while
 * one is said to fall short of the other.
 */
const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 };

export const FT3_PER_BBL = 5.614583;
export const PSI_PER_FT_SG = 0.433;

/** Typical operating values, offered as starting points and labelled. */
export const TYPICAL = {
  riseFtMin: 750,        // 700-1000 is the usual target band
  fallInGasFtMin: 1000,  // dry-gas fall
  fallInLiquidFtMin: 172, // much slower once it reaches the slug
  frictionPsi: 0,        // slug and plunger drag; measured, not modelled
};

/** Tubing cross-section, square inches, from inside diameter. */
export const tubingAreaIn2 = (idIn) => (Math.PI * idIn * idIn) / 4;

/**
 * Liquid volume of a slug, bbl.
 * A slug is quoted as a length of tubing, and this is what that means.
 */
export const slugVolumeBbl = ({ slugLengthFt, idIn }) =>
  (tubingAreaFt2(idIn) * slugLengthFt) / FT3_PER_BBL;

/** The reverse: what slug length a target liquid volume needs. */
export const slugLengthForBbl = ({ bbl, idIn }) => {
  const a = tubingAreaFt2(idIn);
  return a > 0 ? (bbl * FT3_PER_BBL) / a : NaN;
};

/**
 * Pressure required under the plunger to lift it and its slug, psia.
 *
 * A static force balance, term by term, so every one of them is
 * visible and arguable:
 *
 *   line pressure          what the plunger has to arrive against
 *   slug hydrostatic       0.433 SG L, the weight of the liquid
 *   plunger weight         W / A, the piston itself
 *   gas column             the tubing gas above the slug
 *   friction               drag of slug and plunger on the tubing, an
 *                          input because it is measured, not modelled
 *
 * returns { requiredPsia, terms }
 */
export const liftPressure = ({
  linePressurePsia, slugLengthFt, liquidSg, idIn, plungerWeightLb,
  depthFt, gasSg, avgTempR, z, frictionPsi = TYPICAL.frictionPsi,
}) => {
  const areaIn2 = tubingAreaIn2(idIn);
  const slugPsi = PSI_PER_FT_SG * liquidSg * slugLengthFt;
  const plungerPsi = areaIn2 > 0 ? plungerWeightLb / areaIn2 : NaN;
  // Weight of the tubing gas standing above the slug. Small next to
  // the slug itself, and it is carried because leaving it out is a
  // choice rather than an approximation anyone stated.
  const rhoGas = gasDensityLbFt3({
    pPsia: linePressurePsia, tempR: avgTempR, z, gasSg,
  });
  const gasColumnFt = Math.max(depthFt - slugLengthFt, 0);
  const gasColumnPsi = Number.isFinite(rhoGas) ? (rhoGas * gasColumnFt) / 144 : 0;
  const terms = {
    linePressurePsia,
    slugPsi,
    plungerPsi,
    gasColumnPsi,
    frictionPsi,
  };
  return {
    requiredPsia: linePressurePsia + slugPsi + plungerPsi + gasColumnPsi + frictionPsi,
    terms,
    areaIn2,
  };
};

/**
 * Gas needed to move the plunger and slug to surface, scf per cycle.
 *
 * The gas expands into the tubing volume the plunger sweeps. Taking
 * the average of the pressure under the plunger at the start and at
 * the end of the rise, the real gas law converts that swept volume to
 * standard conditions. This is the work the gas does, and it is where
 * the feasibility number comes from.
 */
export const gasPerCycleScf = ({
  depthFt, idIn, pStartPsia, pEndPsia, avgTempR, z,
}) => {
  const sweptFt3 = tubingAreaFt2(idIn) * depthFt;
  const pAvg = (pStartPsia + pEndPsia) / 2;
  if (!(pAvg > 0) || !(avgTempR > 0) || !(z > 0)) return NaN;
  return sweptFt3 * (pAvg / P_STANDARD_PSIA) * (T_STANDARD_R / avgTempR) / z;
};

/**
 * Cycle timing, minutes.
 *
 * Rise, then the plunger falls through the gas to the top of the
 * liquid and then much more slowly through the liquid itself, then the
 * well flows for a while, then it is shut in. Every velocity here is
 * an operating number.
 */
export const cycleTime = ({
  depthFt, riseFtMin = TYPICAL.riseFtMin, fallInGasFtMin = TYPICAL.fallInGasFtMin,
  fallInLiquidFtMin = TYPICAL.fallInLiquidFtMin, liquidColumnFt = 0,
  afterflowMin = 0, shutInMin = 0,
}) => {
  const riseMin = riseFtMin > 0 ? depthFt / riseFtMin : NaN;
  const gasFallFt = Math.max(depthFt - liquidColumnFt, 0);
  const fallMin = (fallInGasFtMin > 0 ? gasFallFt / fallInGasFtMin : NaN)
    + (fallInLiquidFtMin > 0 ? liquidColumnFt / fallInLiquidFtMin : 0);
  const totalMin = riseMin + fallMin + afterflowMin + shutInMin;
  return {
    riseMin,
    fallMin,
    afterflowMin,
    shutInMin,
    totalMin,
    cyclesPerDay: totalMin > 0 ? 1440 / totalMin : NaN,
  };
};

/**
 * The screening rule of thumb, for comparison only.
 *
 * Roughly 400 scf of gas per barrel of liquid per 1,000 ft of depth is
 * the number the industry screens on. It is a heuristic, it is
 * reported as one, and `scfPerBblPer1000ft` is editable because
 * different operators carry different versions of it.
 */
export const RULE_OF_THUMB_SCF_PER_BBL_PER_1000FT = 400;

export const ruleOfThumbGlr = ({ depthFt, scfPerBblPer1000ft = RULE_OF_THUMB_SCF_PER_BBL_PER_1000FT }) =>
  (scfPerBblPer1000ft * depthFt) / 1000;

/**
 * Can this well plunger lift, and what would a cycle look like?
 *
 * The verdict rests on the COMPUTED gas-liquid ratio: the gas one
 * cycle needs divided by the liquid one cycle brings up. If the well
 * makes more gas per barrel than that, it can drive the plunger; if
 * not, it cannot, whatever a rule of thumb says.
 *
 * returns { ok, errors, design }
 */
export const screenPlungerLift = ({
  depthFt, idIn, linePressurePsia, casingPressurePsia, slugLengthFt, liquidSg,
  plungerWeightLb, gasSg, avgTempR, z, wellGlrScfBbl, frictionPsi,
  riseFtMin, fallInGasFtMin, fallInLiquidFtMin, afterflowMin, shutInMin,
  scfPerBblPer1000ft,
}) => {
  const errors = [];
  if (!(depthFt > 0)) errors.push('The plunger has to travel a depth.');
  if (!(idIn > 0)) errors.push('The tubing needs an inside diameter.');
  if (!(slugLengthFt > 0)) errors.push('A cycle lifts a slug, so it needs a slug length.');
  if (!(plungerWeightLb > 0)) errors.push('The plunger needs a weight.');
  if (!(avgTempR > 0)) errors.push('The gas column needs an average temperature.');
  if (slugLengthFt > depthFt) errors.push('The slug is longer than the tubing it sits in.');
  if (errors.length) return { ok: false, errors, design: null };

  const lift = liftPressure({
    linePressurePsia, slugLengthFt, liquidSg, idIn, plungerWeightLb,
    depthFt, gasSg, avgTempR, z, frictionPsi,
  });

  // Gas expands from the casing pressure available down to the
  // pressure still needed at the top of the rise.
  const gasScf = gasPerCycleScf({
    depthFt, idIn, pStartPsia: casingPressurePsia, pEndPsia: lift.requiredPsia,
    avgTempR, z,
  });
  const liquidBbl = slugVolumeBbl({ slugLengthFt, idIn });
  const requiredGlr = liquidBbl > 0 ? gasScf / liquidBbl : NaN;

  const timing = cycleTime({
    depthFt, riseFtMin, fallInGasFtMin, fallInLiquidFtMin,
    liquidColumnFt: slugLengthFt, afterflowMin, shutInMin,
  });

  const warnings = [];
  // Both warnings below CONTRAST two quantities in one sentence, and
  // rounded whole the contrast can vanish: a casing at 899.6 psia
  // against a requirement of 900.2 read "The casing builds to 900 psia
  // but 900 psia is needed", and a well 0.8 scf/bbl short of what a
  // cycle needs read as making exactly what it needs. One decimal
  // narrows that collision by ten; a pair inside 0.05 of each other
  // still renders equal.
  //
  // `casingPressurePsia` is NOT in the refusal list above, so it
  // reaches this message unvalidated. `Math.round` swallowed that and
  // printed a bare NaN; `toFixed` is a method on Number, so the same
  // inputs threw at a caller that used to get an answer. The value is
  // checked before it is formatted, and a casing pressure that cannot
  // be read is named as unreadable rather than crashing or being
  // printed as though it were a gauge reading. `requiredPsia` is a sum
  // of inputs this function also does not all check, so it is guarded
  // the same way.
  // The pressure test comes first: without it the gas-liquid ratio is
  // beside the point, because the plunger never moves.
  const pressureOk = casingPressurePsia > lift.requiredPsia;
  if (!pressureOk) {
    const needed = Number.isFinite(lift.requiredPsia)
      ? `${lift.requiredPsia.toFixed(1)} psia`
      : 'a lift pressure these inputs do not allow computing';
    warnings.push({
      code: 'insufficientPressure',
      message: Number.isFinite(casingPressurePsia)
        ? `The casing builds to ${casingPressurePsia.toFixed(1)} psia but ${needed} is needed to move the plunger and its slug. Shorten the slug, drop the line pressure, or accept that this well will not plunger lift as it stands.`
        : `No casing pressure could be read here: ${describeUnusableNumber(casingPressurePsia)}. Moving the plunger and its slug takes ${needed}, and whether this well builds to it cannot be said until a numeric casing pressure in psia is given.`,
    });
  }
  const glrOk = Number.isFinite(wellGlrScfBbl) && wellGlrScfBbl >= requiredGlr;
  if (Number.isFinite(wellGlrScfBbl) && !glrOk) {
    warnings.push({
      code: 'insufficientGas',
      message: `A cycle needs ${requiredGlr.toLocaleString(undefined, ONE_DECIMAL)} scf of gas per barrel and the well makes ${wellGlrScfBbl.toLocaleString(undefined, ONE_DECIMAL)}. There is not enough gas to drive the plunger at this slug size.`,
    });
  }
  // One decimal on the cycle time: 1440 minutes IS one trip a day, so
  // at whole minutes a 1440.3 minute cycle read "At 1440 minutes a
  // cycle this well would make fewer than one trip a day", which is its
  // own contradiction to any reader who knows how long a day is.
  if (timing.cyclesPerDay < 1) {
    warnings.push({
      code: 'slowCycle',
      message: `At ${timing.totalMin.toFixed(1)} minutes a cycle this well would make fewer than one trip a day. Check the shut-in and afterflow times.`,
    });
  }

  const ruleGlr = ruleOfThumbGlr({ depthFt, scfPerBblPer1000ft });

  return {
    ok: true,
    errors: [],
    design: {
      lift,
      gasPerCycleScf: gasScf,
      liquidPerCycleBbl: liquidBbl,
      requiredGlrScfBbl: requiredGlr,
      wellGlrScfBbl,
      // Reported for comparison only; the verdict above does not use it.
      ruleOfThumbGlrScfBbl: ruleGlr,
      ruleOfThumbAgrees: Number.isFinite(wellGlrScfBbl)
        ? (wellGlrScfBbl >= ruleGlr) === glrOk
        : null,
      timing,
      liquidPerDayBbl: liquidBbl * timing.cyclesPerDay,
      gasPerDayMscf: (gasScf * timing.cyclesPerDay) / 1000,
      pressureOk,
      glrOk,
      feasible: pressureOk && glrOk,
      warnings,
    },
  };
};

/**
 * The largest slug this well can actually lift, ft.
 *
 * Everything in the lift balance is linear in slug length except the
 * gas column, which shrinks as the slug grows, so the balance is
 * solved directly rather than searched.
 *
 *   P_c = P_line + 0.433 SG L + W/A + (rho_g/144)(D - L) + friction
 *
 * Solving for L gives the slug at which the available casing pressure
 * is exactly used up.
 */
export const maxSlugLengthFt = ({
  casingPressurePsia, linePressurePsia, liquidSg, idIn, plungerWeightLb,
  depthFt, gasSg, avgTempR, z, frictionPsi = TYPICAL.frictionPsi,
}) => {
  const areaIn2 = tubingAreaIn2(idIn);
  const plungerPsi = areaIn2 > 0 ? plungerWeightLb / areaIn2 : NaN;
  const rhoGas = gasDensityLbFt3({ pPsia: linePressurePsia, tempR: avgTempR, z, gasSg });
  const gasPerFt = Number.isFinite(rhoGas) ? rhoGas / 144 : 0;
  const available = casingPressurePsia - linePressurePsia - plungerPsi
    - frictionPsi - gasPerFt * depthFt;
  const perFt = PSI_PER_FT_SG * liquidSg - gasPerFt;
  if (!(perFt > 0)) return NaN;
  return Math.min(Math.max(available / perFt, 0), depthFt);
};
