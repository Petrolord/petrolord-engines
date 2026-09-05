/**
 * Sucker-rod pumping design (Production P6).
 *
 * The chain, in the order a designer walks it:
 *
 *   unit geometry   ->  polished rod motion
 *   inflow + fluid  ->  fluid load on the plunger
 *   wave equation   ->  plunger stroke, polished rod load through the cycle
 *   plunger stroke  ->  what the well actually makes
 *   the card        ->  torque, counterbalance, power
 *   the envelope    ->  rod stress, and whether the string survives it
 *
 * Everything dynamic comes out of `rodDynamics`, which solves the
 * damped wave equation rather than reading API RP 11L's dimensionless
 * charts. The RP 11L groups are still reported, because they are how a
 * rod-pump engineer reads an answer, and the published charts remain a
 * literature gate. See the header of rodDynamics for why.
 *
 * Field units: rate bbl/d, depth ft, stroke in, load lb, torque in-lb,
 * pressure psi, stress psi.
 */

import { predictCard, polishedRodHp, cardArea } from './rodDynamics.js';
import { balanceUnit } from './pumpingUnit.js';
import { rodArea } from './data/rodCatalog.js';

/**
 * Pump displacement constant, derived rather than remembered.
 *
 *   volume per stroke = (pi/4) D^2 S            [in^3]
 *   per day           = x 1440 N                [in^3/d]
 *   to barrels        = / 9702                  (42 gal x 231 in^3/gal)
 *
 * which gives 0.11657, the 0.1166 every rod-pump text quotes.
 *
 * UNITS, spelled out because the square inches in them are the whole
 * trap: bbl per day, per SQUARED PLUNGER DIAMETER in square inches,
 * per inch of stroke, per stroke a minute. The squared diameter is not
 * an area. The pi over four is already INCLUDED in the constant, so a
 * caller who reads that in2 as an area and multiplies by pi d^2 / 4
 * applies the pi over four twice. That is the predecessor's error
 * recorded on `displacementBpd` below, and it understated
 * displacement by 21 percent.
 */
export const IN3_PER_BBL = 42 * 231;
export const PUMP_CONSTANT = (Math.PI / 4) * (1440 / IN3_PER_BBL);

/**
 * Displacement of a plunger, bbl/d.
 *
 * NOTE the predecessor's error, because it is easy to repeat: it wrote
 * `0.1166 * plungerArea * S * N`. The constant already contains the
 * pi/4, so multiplying by the AREA instead of the diameter squared
 * applies pi/4 twice and understates displacement by 21 percent, which
 * came back out as a pump fillage 27 percent too high.
 */
export const displacementBpd = ({ plungerDIn, strokeIn, spm }) =>
  PUMP_CONSTANT * plungerDIn * plungerDIn * strokeIn * spm;

/**
 * Fluid load carried by the plunger on the upstroke, lb.
 *
 * Fo is the differential across the plunger times its area. The two
 * pressures are the caller's: the honest way to get them is from the
 * inflow relationship and the fluid column, which is the consumer's
 * validated well model, exactly as the ESP engines take their
 * discharge pressure.
 *
 * The predecessor SUBTRACTED tubing pressure from the column instead
 * of adding it, which is a sign error that lightened every design.
 */
export const fluidLoadLb = ({ plungerDIn, pDischargePsi, pIntakePsi }) =>
  rodArea(plungerDIn) * Math.max(pDischargePsi - pIntakePsi, 0);

/**
 * Rod stress at the top of each taper section.
 *
 * A taper is designed so every section carries the same peak stress,
 * so this is the check that says whether it does. The tension envelope
 * comes from the wave solution, so these are dynamic stresses, not the
 * static weight.
 */
export const sectionStresses = ({ string, tensionEnvelope }) => {
  const out = [];
  let top = 0;
  for (const sec of string.sections) {
    const depth = top;
    // Envelope sample nearest the top of this section.
    let best = tensionEnvelope[0];
    for (const e of tensionEnvelope) {
      if (Math.abs(e.depthFt - depth) < Math.abs(best.depthFt - depth)) best = e;
    }
    out.push({
      label: sec.label,
      dIn: sec.dIn,
      areaIn2: sec.areaIn2,
      topDepthFt: depth,
      maxLoadLb: best.maxLb,
      minLoadLb: best.minLb,
      maxStressPsi: best.maxLb / sec.areaIn2,
      minStressPsi: best.minLb / sec.areaIn2,
    });
    top += sec.lengthFt;
  }
  return out;
};

/**
 * The modified Goodman allowable stress (API RP 11BR).
 *
 *   Sa = ( T/4 + 0.5625 Smin ) SF
 *
 * with T the grade's minimum tensile strength and SF the service
 * factor. SF is NOT a property of the rod: it stands for the fluid,
 * the corrosion and the operator's own practice, so it is an input
 * with no default that pretends otherwise. A design is acceptable when
 * the maximum stress stays under the allowable.
 */
export const modifiedGoodman = ({ minTensilePsi, minStressPsi, serviceFactor = 1 }) => {
  const allowable = (minTensilePsi / 4 + 0.5625 * minStressPsi) * serviceFactor;
  return { allowablePsi: allowable, serviceFactor };
};

/**
 * The dimensionless groups API RP 11L is plotted against.
 *
 * They are definitions, so they are computed here regardless of which
 * route produced the loads, and they are what makes a wave-equation
 * answer readable by anyone who works in RP 11L terms. The published
 * chart values for these groups are a LITERATURE GATE, not something
 * this package reproduces from memory.
 */
export const dimensionlessGroups = ({
  spm, n0Spm, nPrimeSpm, fluidLoad, strokeIn, krLbPerIn,
  plungerStrokeIn, pprlLb, mprlLb, weightFluidLb, peakTorqueInLb,
}) => {
  const skr = strokeIn * krLbPerIn;
  return {
    nOverN0: spm / n0Spm,
    nOverNPrime: spm / nPrimeSpm,
    foOverSkr: fluidLoad / skr,
    spOverS: plungerStrokeIn / strokeIn,
    f1OverSkr: (pprlLb - weightFluidLb) / skr,
    f2OverSkr: (weightFluidLb - mprlLb) / skr,
    // ITEM 50. Null, not zero, when there is no counterbalance solve
    // behind it. A torque group of 0 reads as a unit that sees no
    // gearbox torque, which is a claim; `torquePct` beside it has
    // always said null in the same case.
    torqueGroup: Number.isFinite(peakTorqueInLb)
      ? (2 * peakTorqueInLb) / (strokeIn * strokeIn * krLbPerIn)
      : null,
    skrLb: skr,
  };
};

/**
 * The whole design run.
 *
 * inputs: {
 *   string          rodString.buildRodString
 *   frequency       rodString.naturalFrequency
 *   kin             pumpingUnit.unitKinematics
 *   surfacePosition (tFrac) -> ft, downward positive
 *   strokeIn, spm
 *   plungerDIn, pDischargePsi, pIntakePsi
 *   fillage         barrel fill fraction
 *   pumpEfficiency  slippage and shrinkage, a measured or vendor number
 *   dampingRatio
 *   serviceFactor, structuralUnbalanceLb, crankOffsetDeg
 *   unitRating      parseUnitDesignation result, or null
 *
 *   ADVANCED, both optional and both handed straight to
 *   rodDynamics.predictCard. Omit them and the march runs exactly as
 *   it always has; they exist so a march that does not settle can be
 *   re-run at a finer resolution or given more strokes to settle in,
 *   which is a real lever on the `notPeriodic` warning.
 *   nodes           spatial nodes on the string, at least 8. Default 120.
 *   maxCycles       strokes marched before periodicity is given up on.
 *                   Default 20.
 * }
 *
 * returns { ok, errors, design }
 */
export const runRodPumpDesign = ({
  string, frequency, kin, surfacePosition, strokeIn, spm,
  plungerDIn, pDischargePsi, pIntakePsi, fillage = 1, pumpEfficiency = 1,
  dampingRatio, serviceFactor = 1, structuralUnbalanceLb = 0, crankOffsetDeg = 0,
  unitRating = null, balance, nodes, maxCycles,
}) => {
  const errors = [];
  const warnings = [];
  // The two advanced inputs are optional, so ABSENT means the default
  // and is not an error. Present and unreadable is an error: a node
  // count that is not a number marches a grid of NaN and returns
  // confident nonsense, so it is refused here rather than coerced.
  const asGiven = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
  if (nodes !== undefined && !(Number.isFinite(nodes) && nodes >= 8)) {
    errors.push(`The node count must be a number of at least 8 spatial nodes. It was given as ${asGiven(nodes)}.`);
  }
  if (maxCycles !== undefined && !(Number.isFinite(maxCycles) && maxCycles >= 1)) {
    errors.push(`The cycle limit must be a number of at least 1 stroke. It was given as ${asGiven(maxCycles)}.`);
  }
  const fo = fluidLoadLb({ plungerDIn, pDischargePsi, pIntakePsi });
  if (!(fo > 0)) {
    errors.push('The plunger has no fluid to lift: the discharge pressure does not exceed the intake pressure. Check the fluid level, the tubing pressure and the inflow.');
  }
  if (!(spm > 0)) errors.push('Pumping speed must be greater than zero.');
  if (errors.length) return { ok: false, errors, design: null };

  // Above the string's own natural frequency the rod string is being
  // driven past resonance and none of this is trustworthy. That is a
  // real limit, not a numerical one, so it is refused rather than
  // extrapolated.
  if (spm >= frequency.nPrimeSpm) {
    return {
      ok: false,
      design: null,
      errors: [
        `At ${spm} strokes a minute this string is being driven at or above its own natural frequency (${frequency.nPrimeSpm.toFixed(1)} spm). Nothing predicted there would be trustworthy: slow the unit down, shorten the string or run a stiffer taper.`,
      ],
    };
  }

  const dyn = predictCard({
    string,
    surfacePosition,
    strokeFt: strokeIn / 12,
    spm,
    fluidLoadLb: fo,
    fillage,
    dampingRatio,
    // Undefined here is what predictCard's own defaults are written
    // against, so an omitted advanced input marches exactly the grid
    // and the cycle limit it always did.
    nodes,
    maxCycles,
  });
  if (!dyn.ok) return { ok: false, errors: [dyn.error], design: null };

  const prhp = polishedRodHp({ workInLbPerCycle: dyn.workInLbPerCycle, spm });

  // Production. The plunger stroke, not the surface stroke, is what
  // sweeps the barrel; fillage and the pump's own efficiency then say
  // how much of that swept volume reaches the tank.
  const ratedBpd = displacementBpd({ plungerDIn, strokeIn, spm });
  const sweptBpd = displacementBpd({ plungerDIn, strokeIn: dyn.plungerStrokeIn, spm });
  const producedBpd = sweptBpd * fillage * pumpEfficiency;

  // ITEMS 15 AND 37. `kin`, `structuralUnbalanceLb` and `crankOffsetDeg`
  // were accepted at this door and never read: the design took whatever
  // `balance` the CALLER had already solved, so a unit's crank offset
  // and structural unbalance reached the torque numbers only if the
  // caller had remembered to pass them to `balanceUnit` itself. Three
  // inputs that a design silently ignores are three inputs a user will
  // set and believe in.
  //
  // The balance is solved here now, from the kinematics and the card
  // this design just produced, unless the caller supplied one. The card
  // is read off the FULL march (items 14 and 38), so the gearbox
  // numbers are not taken from the 180 point plotting subsample either.
  const solvedBalance = balance || (kin
    ? balanceUnit({
      kin,
      cardLoadAt: dyn.surfaceLoadAt,
      structuralUnbalanceLb,
      crankOffsetDeg,
    })
    : null);

  const groups = dimensionlessGroups({
    spm,
    n0Spm: frequency.n0Spm,
    nPrimeSpm: frequency.nPrimeSpm,
    fluidLoad: fo,
    strokeIn,
    krLbPerIn: string.krLbPerIn,
    plungerStrokeIn: dyn.plungerStrokeIn,
    pprlLb: dyn.prlPeakLb,
    mprlLb: dyn.prlMinLb,
    weightFluidLb: string.weightFluidLb,
    peakTorqueInLb: solvedBalance ? solvedBalance.peakTorqueInLb : null,
  });

  // Rod stress, section by section, against the modified Goodman line.
  const stresses = sectionStresses({ string, tensionEnvelope: dyn.tensionEnvelope })
    .map((s) => {
      const goodman = modifiedGoodman({
        minTensilePsi: string.grade.minTensilePsi,
        minStressPsi: s.minStressPsi,
        serviceFactor,
      });
      return {
        ...s,
        allowablePsi: goodman.allowablePsi,
        loadingPct: (s.maxStressPsi / goodman.allowablePsi) * 100,
      };
    });
  const worst = stresses.reduce(
    (a, s) => (s.loadingPct > a.loadingPct ? s : a), stresses[0],
  );
  // MESSAGE PRECISION, for every warning below. Each fires on a strict
  // inequality against a threshold and then prints the value it fired
  // on, so the printed number has to be able to sit OFF the threshold.
  // Printed to whole units, a loading of 100.2 percent rendered as
  // "100 percent" under a flag that only fires above 100, and a peak
  // load a fifth of a pound over the structure rendered as the
  // structure's own rating in the same sentence: a real warning that
  // reads as a false alarm, which invites a reader to dismiss it. The
  // rounding errs upward as readily as downward (100.55 printed whole
  // reads as 101). One decimal place does not remove the collision, it
  // narrows it by ten: a value within 0.05 of the threshold still
  // prints as the threshold. Gated by `warnings print a value that is
  // off their own threshold` in __tests__/production.rodpump.test.js.
  if (worst && worst.loadingPct > 100) {
    warnings.push({
      code: 'rodOverstressed',
      message: `The ${worst.label} section runs at ${worst.loadingPct.toFixed(1)} percent of its modified Goodman allowable. Move up a rod size, change grade, shorten the stroke or slow the unit.`,
    });
  }

  // Unit ratings, when a designation was given.
  const rating = {};
  if (unitRating) {
    rating.structuralPct = (dyn.prlPeakLb / unitRating.structuralCapacityLb) * 100;
    rating.torquePct = solvedBalance
      ? (solvedBalance.peakTorqueInLb / unitRating.torqueRatingInLb) * 100
      : null;
    rating.strokePct = (strokeIn / unitRating.strokeIn) * 100;
    if (rating.structuralPct > 100) {
      warnings.push({
        code: 'structuralOverload',
        message: `Peak polished rod load is ${dyn.prlPeakLb.toFixed(1)} lb against a ${unitRating.structuralCapacityLb} lb structure.`,
      });
    }
    if (rating.torquePct != null && rating.torquePct > 100) {
      warnings.push({
        code: 'torqueOverload',
        message: `Peak gearbox torque is ${solvedBalance.peakTorqueInLb.toFixed(1)} in-lb against a ${unitRating.torqueRatingInLb} in-lb rating.`,
      });
    }
    if (rating.strokePct > 100) {
      warnings.push({
        code: 'strokeOverload',
        message: `The design stroke of ${strokeIn} in is longer than the unit's ${unitRating.strokeIn} in.`,
      });
    }
  }

  if (fillage < 0.85) {
    warnings.push({
      code: 'incompleteFillage',
      message: `The barrel fills only ${(fillage * 100).toFixed(1)} percent. The load stays on the rods into the downstroke and the unit is pumping air for part of every stroke; slow it down, shorten the stroke or fit a smaller plunger.`,
    });
  }
  dyn.warnings.forEach((w) => warnings.push(w));

  return {
    ok: true,
    errors: [],
    design: {
      fluidLoadLb: fo,
      plungerAreaIn2: rodArea(plungerDIn),
      dynamics: dyn,
      plungerStrokeIn: dyn.plungerStrokeIn,
      pprlLb: dyn.prlPeakLb,
      mprlLb: dyn.prlMinLb,
      prhp,
      cardAreaInLb: dyn.workInLbPerCycle,
      ratedBpd,
      sweptBpd,
      producedBpd,
      groups,
      stresses,
      worstSection: worst,
      rating,
      balance: solvedBalance,
      warnings,
    },
  };
};

export { cardArea, polishedRodHp };
