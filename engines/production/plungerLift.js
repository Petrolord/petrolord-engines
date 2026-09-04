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
 * Field units: depth ft, pressure psia, temperature degR, length ft,
 * area in2 and ft2, volume bbl and scf, rate Mscf/d and bbl/d, velocity
 * ft/min, time min.
 *
 * ONE DOOR CONVENTION FOR TEMPERATURE: degR AT EVERY BOUNDARY.
 *
 * Every temperature this module accepts is absolute, in degrees
 * Rankine, and the parameter that carries one says so in its name:
 * `avgTempR`. Nothing here takes degF and nothing here converts, so a
 * Fahrenheit reading handed to `liftPressure`, `gasPerCycleScf`,
 * `screenPlungerLift` or `maxSlugLengthFt` is silently wrong by 459.67
 * rather than refused. It reaches the real gas law through
 * `gasDensityLbFt3` and `gasPerCycleScf`, both of which are degR at
 * their own doors too.
 *
 * The one place in this domain that takes degF at its door is
 * `gasProperties.js`, whose `tF` and `tempAtDepthF` arguments are
 * Fahrenheit by name and which converts with its own `toRankine`. This
 * module does not call it. Callers crossing between the two convert at
 * the boundary.
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
 * `avgTempR` is degR at the door, per the module header.
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
 *
 * `avgTempR` is degR at the door, per the module header.
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
 * `avgTempR` is degR at the door, per the module header.
 *
 * THE CASING PRESSURE IS AN INPUT THIS FUNCTION READS, SO IT IS AN
 * INPUT THIS FUNCTION CHECKS. It was not in the refusal list, and it is
 * the pressure the whole verdict turns on: it sets the start of the gas
 * expansion, it decides `pressureOk`, and it is printed in the
 * `insufficientPressure` warning. An undefined one used to walk past
 * the gate, produce a NaN gas volume and a NaN required ratio, and come
 * back as a design object with a warning attached rather than as a
 * refusal. A verdict on an input never read is not a verdict.
 *
 * ONLY THE ROOT ERROR IS REPORTED. "The slug is longer than the tubing
 * it sits in" is a true statement about a well with no depth and a 200
 * ft slug, and it is not a finding: it is what the missing depth looks
 * like from one line further down. It is tested only when both lengths
 * were readable in the first place, so a caller taking `errors[0]` and
 * showing it to a user gets the thing to fix rather than the loudest
 * consequence of it.
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
  if (!Number.isFinite(casingPressurePsia)) {
    errors.push(`The gas expands from the casing pressure, so a cycle needs one, and ${describeUnusableNumber(casingPressurePsia)}. Hand a numeric casing pressure in psia.`);
  }
  // Consequence, not a finding: only asked once both lengths are real.
  if (depthFt > 0 && slugLengthFt > 0 && slugLengthFt > depthFt) {
    errors.push('The slug is longer than the tubing it sits in.');
  }
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
  // THE SLUG NAMED WITHOUT A DIRECTION SENDS THE READER THE WRONG WAY.
  // "There is not enough gas to drive the plunger at this slug size"
  // names the lever and says nothing about which way it moves, and the
  // intuitive reading is the wrong one: a shorter slug looks like less
  // work. It is not. The gas a cycle needs is set by the swept tubing
  // volume, which is the whole string whatever the slug does, while the
  // liquid a cycle brings up is proportional to the slug. So the
  // required ratio goes roughly as one over the slug length: a LONGER
  // slug LOWERS it and a SHORTER slug RAISES it, and an operator who
  // shortened the slug on the strength of the old sentence made the
  // well less feasible, not more.
  if (Number.isFinite(wellGlrScfBbl) && !glrOk) {
    warnings.push({
      code: 'insufficientGas',
      message: `A cycle needs ${requiredGlr.toLocaleString(undefined, ONE_DECIMAL)} scf of gas per barrel and the well makes ${wellGlrScfBbl.toLocaleString(undefined, ONE_DECIMAL)}. There is not enough gas to drive the plunger at a slug of ${slugLengthFt.toLocaleString(undefined, ONE_DECIMAL)} ft. A longer slug LOWERS the ratio a cycle needs and a shorter slug RAISES it, so lengthening the slug is the direction that helps here, up to the longest slug this casing pressure can lift.`,
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
  const ruleOfThumbAgrees = Number.isFinite(wellGlrScfBbl)
    ? (wellGlrScfBbl >= ruleGlr) === glrOk
    : null;
  // A well between the two numbers is exactly where a screening
  // heuristic misleads, and `ruleOfThumbAgrees: false` reported that
  // only as a boolean nobody renders. It is said in words now, with
  // both figures in the sentence, because the reader who has to be told
  // is the one who screened this well on the rule of thumb and is about
  // to be surprised by the verdict.
  if (ruleOfThumbAgrees === false) {
    warnings.push({
      code: 'ruleOfThumbDisagrees',
      message: `The screening rule of thumb and the computed ratio disagree about this well. The rule of thumb asks for ${ruleGlr.toLocaleString(undefined, ONE_DECIMAL)} scf of gas per barrel and a cycle actually needs ${requiredGlr.toLocaleString(undefined, ONE_DECIMAL)}, and the well makes ${wellGlrScfBbl.toLocaleString(undefined, ONE_DECIMAL)}. The verdict above follows the computed ratio, which is the work the gas has to do; the rule of thumb is a screen and is reported for comparison only.`,
    });
  }

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
      ruleOfThumbAgrees,
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
 *
 * `avgTempR` is degR at the door, per the module header.
 *
 * A CLAMP IS NOT AN ANSWER, AND THERE WERE TWO OF THEM.
 *
 * The solve used to end `Math.min(Math.max(L, 0), depthFt)`, and both
 * ends of that clamp turned a well this function had just proved
 * something about into a number that reads as an ordinary answer.
 *
 *   Math.max(L, 0) fires when the casing pressure does not even cover
 *   the line pressure, the plunger's own weight and the gas column,
 *   which is to say BEFORE any slug at all. The finding is that this
 *   well cannot lift a bare plunger. It was reported as "0 ft", which a
 *   reader takes as a very short slug and an operator takes as a
 *   tuning problem.
 *
 *   Math.min(L, depthFt) fires when the balance says the well could
 *   carry a slug longer than the tubing is deep. The finding is that
 *   the casing pressure is not the binding constraint here and the
 *   answer is the well's own liquid, not this equation. It was reported
 *   as exactly the depth, which is indistinguishable from a genuine
 *   solve that landed on the shoe.
 *
 * Both refuse now, with the same `{ ok: false, code, error }` shape as
 * the gradient branch, and the third branch below is there because a
 * clamp cannot be evaluated on a value that is not a number: the Suite
 * hands this function NaN for an unentered casing pressure or plunger
 * weight, and `Math.min(Math.max(NaN, 0), depthFt)` is NaN, which the
 * Suite then formatted and displayed.
 *
 * THE RETURN SHAPE CHANGED, AND IT HAD TO. This used to return a bare
 * number, and a bare number cannot carry `ok`. On success it now returns
 * `{ ok: true, maxSlugLengthFt }` and the value inside is the value it
 * always was, unchanged, for every input that produced an answer rather
 * than a clamp.
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
  if (!(perFt > 0)) {
    return {
      ok: false,
      code: 'noSlugGradient',
      error: `The liquid gradient here is ${(PSI_PER_FT_SG * liquidSg).toFixed(4)} psi/ft and the gas gradient is ${gasPerFt.toFixed(4)} psi/ft, so a longer slug adds no net pressure and there is no longest slug to find. Check the liquid gravity and the gas column conditions.`,
    };
  }
  const lengthFt = available / perFt;
  // The band is [0, depthFt] and its EDGES are answers: a casing pressure
  // that lifts a bare plunger and no more solves to exactly zero, and one
  // that solves to exactly the depth is a real solve that landed on the
  // shoe. Only values OUTSIDE the band were ever clamped, and only those
  // refuse. The tolerance is there because the two edge cases are reached
  // by a subtraction of like-sized pressures and land a few parts in 1e16
  // either side of the edge; at 1e-9 of the depth it is a rounding window,
  // not a finding, and a value inside it returns the edge exactly as the
  // old clamp did.
  const edgeTolFt = 1e-9 * Math.max(Math.abs(depthFt), 1);
  if (!Number.isFinite(lengthFt)) {
    return {
      ok: false,
      code: 'unreadableInputs',
      error: 'The longest slug could not be computed from these inputs. Check that the casing pressure, the line pressure, the plunger weight, the tubing diameter and the depth are all numbers.',
    };
  }
  if (lengthFt < -edgeTolFt) {
    return {
      ok: false,
      code: 'casingBelowLiftPressure',
      error: `The casing builds to ${casingPressurePsia.toFixed(1)} psia and lifting a bare plunger against this line pressure, with its own weight and the gas column above it, already takes ${(casingPressurePsia - available).toFixed(1)} psia. There is no slug this well can lift, not even a short one.`,
    };
  }
  if (lengthFt > depthFt + edgeTolFt) {
    return {
      ok: false,
      code: 'slugExceedsDepth',
      error: `The balance puts the longest slug at ${lengthFt.toFixed(1)} ft in a well ${depthFt.toFixed(1)} ft deep, so the casing pressure is not what limits the slug here. The limit is the liquid the well makes between cycles, which this function does not know.`,
    };
  }
  return { ok: true, maxSlugLengthFt: Math.min(Math.max(lengthFt, 0), depthFt) };
};
