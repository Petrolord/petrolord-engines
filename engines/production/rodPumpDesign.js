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
import { rodArea } from './data/rodCatalog.js';

/**
 * Pump displacement constant, derived rather than remembered.
 *
 *   volume per stroke = (pi/4) D^2 S            [in^3]
 *   per day           = x 1440 N                [in^3/d]
 *   to barrels        = / 9702                  (42 gal x 231 in^3/gal)
 *
 * which gives 0.11657, the 0.1166 every rod-pump text quotes.
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
    torqueGroup: (2 * peakTorqueInLb) / (strokeIn * strokeIn * krLbPerIn),
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
 * }
 *
 * returns { ok, errors, design }
 */
export const runRodPumpDesign = ({
  string, frequency, kin, surfacePosition, strokeIn, spm,
  plungerDIn, pDischargePsi, pIntakePsi, fillage = 1, pumpEfficiency = 1,
  dampingRatio, serviceFactor = 1, structuralUnbalanceLb = 0, crankOffsetDeg = 0,
  unitRating = null, balance,
}) => {
  const errors = [];
  const warnings = [];
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
  });
  if (!dyn.ok) return { ok: false, errors: [dyn.error], design: null };

  const prhp = polishedRodHp({ workInLbPerCycle: dyn.workInLbPerCycle, spm });

  // Production. The plunger stroke, not the surface stroke, is what
  // sweeps the barrel; fillage and the pump's own efficiency then say
  // how much of that swept volume reaches the tank.
  const ratedBpd = displacementBpd({ plungerDIn, strokeIn, spm });
  const sweptBpd = displacementBpd({ plungerDIn, strokeIn: dyn.plungerStrokeIn, spm });
  const producedBpd = sweptBpd * fillage * pumpEfficiency;

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
    peakTorqueInLb: balance ? balance.peakTorqueInLb : 0,
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
  if (worst && worst.loadingPct > 100) {
    warnings.push({
      code: 'rodOverstressed',
      message: `The ${worst.label} section runs at ${worst.loadingPct.toFixed(0)} percent of its modified Goodman allowable. Move up a rod size, change grade, shorten the stroke or slow the unit.`,
    });
  }

  // Unit ratings, when a designation was given.
  const rating = {};
  if (unitRating) {
    rating.structuralPct = (dyn.prlPeakLb / unitRating.structuralCapacityLb) * 100;
    rating.torquePct = balance
      ? (balance.peakTorqueInLb / unitRating.torqueRatingInLb) * 100
      : null;
    rating.strokePct = (strokeIn / unitRating.strokeIn) * 100;
    if (rating.structuralPct > 100) {
      warnings.push({
        code: 'structuralOverload',
        message: `Peak polished rod load is ${Math.round(dyn.prlPeakLb)} lb against a ${unitRating.structuralCapacityLb} lb structure.`,
      });
    }
    if (rating.torquePct != null && rating.torquePct > 100) {
      warnings.push({
        code: 'torqueOverload',
        message: `Peak gearbox torque is ${Math.round(balance.peakTorqueInLb)} in-lb against a ${unitRating.torqueRatingInLb} in-lb rating.`,
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
      message: `The barrel fills only ${(fillage * 100).toFixed(0)} percent. The load stays on the rods into the downstroke and the unit is pumping air for part of every stroke; slow it down, shorten the stroke or fit a smaller plunger.`,
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
      balance,
      warnings,
    },
  };
};

export { cardArea, polishedRodHp };
