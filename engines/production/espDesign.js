/**
 * Electrical submersible pump sizing (Production P5).
 *
 * The design chain, in the order a designer walks it:
 *
 *   inflow  ->  pump intake pressure  ->  what the fluid does there
 *           ->  total dynamic head    ->  stages, shaft power
 *
 * Two things the old Artificial Lift Designer got wrong and this module
 * is built around:
 *
 *  1. **Total dynamic head is not the friction plus the wellhead.** It
 *     is the pressure the pump has to add, converted to feet of the
 *     fluid it is pumping: TDH = (p_discharge - p_intake) / gradient.
 *     The net vertical lift is most of it, and leaving it out understates
 *     the stage count by roughly an order of magnitude.
 *  2. **The discharge pressure is a flowing traverse result, not a
 *     static column.** This module takes p_discharge as an input,
 *     because the honest way to get it is to march the tubing from the
 *     wellhead down to the pump at the rate being designed for, with the
 *     gas that is actually still in the stream. The consumer does that
 *     with its validated nodal model and passes the answer in.
 *
 * Gas. The free gas at intake is computed from the black-oil PVT the
 * caller supplies at intake conditions, not from a rule of thumb. What a
 * separator removes is a user number (vendor efficiency or a measured
 * one); what is left goes through the pump and is reported as the gas
 * volume fraction, which is the number that decides whether a standard
 * pump, a gas handler or a separator is needed. The thresholds for that
 * decision are ordinary operating guidance and are configurable.
 *
 * Field units: rates bbl/d and scf/d, pressures psia, depths ft TVD,
 * head ft, power hp.
 */

import {
  stagePerformance, stackPerformance, hydraulicHp, brakeHp, bepOf,
  WATER_LBF_PER_FT3,
} from './espPump.js';

/**
 * psi per ft per unit specific gravity (a 1.0 SG column).
 *
 * ONE CONVERSION, DERIVED. It is `WATER_LBF_PER_FT3 / 144`, the same
 * 62.4 lbf/ft3 over 144 square inches that `gradientFromDensity` uses
 * and that the hydraulic power constant `HP_HEAD_DIVISOR` is built
 * from, which makes it 0.43333... rather than the rounded field
 * constant 0.433.
 *
 * It used to be the rounded 0.433, and the two forms were 0.077 percent
 * apart in one package. The design chain took its gradient from
 * `gradientFromDensity(mixture density)` and `diagnoseOperation` built
 * its gradient as `PSI_PER_FT_SG * specificGravity`, so the same well
 * read through the two routes gave heads 0.077 percent apart, about 2.8
 * ft on a 3,700 ft total dynamic head. The rule for keeping them apart
 * was to LAUNDER the specific gravity through the rounded constant,
 * `specificGravity = gradientPsiPerFt / PSI_PER_FT_SG`, which is a
 * convention every consumer had to know and none of them could see.
 *
 * With one constant that convention is not needed: a TRUE specific
 * gravity, density / 62.4, now makes `PSI_PER_FT_SG * specificGravity`
 * identically equal to `gradientFromDensity(density)`, and the design
 * chain and the diagnostics chain agree to the last bit without anyone
 * laundering anything. Item 3.
 */
export const PSI_PER_FT_SG = WATER_LBF_PER_FT3 / 144;

/**
 * Pressure gradient of a fluid, psi/ft, from its in-situ density.
 * The same conversion as `PSI_PER_FT_SG` above, taken from a density
 * instead of from a specific gravity: 144 square inches per square
 * foot.
 */
export const gradientFromDensity = (densityLbFt3) => densityLbFt3 / 144;

/**
 * Pump intake pressure: the flowing bottomhole pressure less the
 * annulus column between the perforations and the pump intake.
 *
 * Above the pump the annulus carries whatever gas has separated, so its
 * gradient is a caller input rather than an assumption; a gassy annulus
 * is much lighter than the produced liquid and using the liquid
 * gradient there is a common way to overstate the intake pressure.
 */
export const intakePressure = ({
  pwfPsia, perfTvdFt, pumpTvdFt, annulusGradPsiPerFt,
}) => {
  const lift = Math.max(perfTvdFt - pumpTvdFt, 0);
  return pwfPsia - annulusGradPsiPerFt * lift;
};

/**
 * What the produced stream is doing at intake conditions.
 *
 * inputs: { qoStbd, wct (fraction), gorScfStb, pvt: { rs, bo, bw, bg,
 *           rhoO, rhoW, rhoG } }
 * `bg` is rb/scf, matching the nodal PVT set.
 *
 * returns {
 *   qwStbd, qoResBpd, qwResBpd, freeGasScfd, freeGasResBpd,
 *   totalResBpd, gvf, liquidResBpd, mixtureDensityLbFt3
 * }
 */
export const intakeStream = ({ qoStbd, wct = 0, gorScfStb, pvt }) => {
  const wc = Math.min(Math.max(wct, 0), 0.999);
  const qwStbd = wc > 0 ? (qoStbd * wc) / (1 - wc) : 0;
  const qoResBpd = qoStbd * pvt.bo;
  const qwResBpd = qwStbd * pvt.bw;
  const freeGasScfd = Math.max(0, qoStbd * (gorScfStb - pvt.rs));
  const freeGasResBpd = freeGasScfd * pvt.bg;
  const liquidResBpd = qoResBpd + qwResBpd;
  const totalResBpd = liquidResBpd + freeGasResBpd;
  const gvf = totalResBpd > 0 ? freeGasResBpd / totalResBpd : 0;
  const massLiquid = qoResBpd * (pvt.rhoO ?? 0) + qwResBpd * (pvt.rhoW ?? 0);
  const massGas = freeGasResBpd * (pvt.rhoG ?? 0);
  const liquidDensityLbFt3 = liquidResBpd > 0 ? massLiquid / liquidResBpd : 0;
  const gasDensityLbFt3 = pvt.rhoG ?? 0;
  const mixtureDensityLbFt3 = totalResBpd > 0 ? (massLiquid + massGas) / totalResBpd : 0;
  return {
    qwStbd,
    qoResBpd,
    qwResBpd,
    freeGasScfd,
    freeGasResBpd,
    liquidResBpd,
    totalResBpd,
    gvf,
    liquidDensityLbFt3,
    gasDensityLbFt3,
    mixtureDensityLbFt3,
  };
};

/**
 * Gas volume fraction thresholds. These are ordinary operating
 * guidance, not a correlation: below the first a standard pump handles
 * the gas, between the two a gas handler is normal practice, above the
 * second a separator (or a different lift method) is called for. They
 * are inputs so a user with their own vendor limits can set them.
 */
export const DEFAULT_GAS_LIMITS = { standardMax: 0.10, handlerMax: 0.25 };

/**
 * What the separator takes out and what the pump has to swallow.
 *
 * `separatorEfficiency` is a fraction of the free gas removed at
 * intake. It is a user or vendor number: no separator efficiency
 * correlation is invented here.
 */
export const gasHandling = ({
  stream, separatorEfficiency = 0, limits = DEFAULT_GAS_LIMITS,
}) => {
  const eff = Math.min(Math.max(separatorEfficiency, 0), 1);
  const ventedResBpd = stream.freeGasResBpd * eff;
  const throughPumpGasResBpd = stream.freeGasResBpd - ventedResBpd;
  const pumpIntakeBpd = stream.liquidResBpd + throughPumpGasResBpd;
  const gvfThroughPump = pumpIntakeBpd > 0 ? throughPumpGasResBpd / pumpIntakeBpd : 0;
  // Density of what the pump actually swallows, which is heavier than
  // the full stream once a separator has taken gas out. This is the
  // gradient the head conversion has to use, so it is computed here
  // rather than left to the caller to get subtly wrong.
  const massThrough = stream.liquidResBpd * stream.liquidDensityLbFt3
    + throughPumpGasResBpd * stream.gasDensityLbFt3;
  const mixtureDensityLbFt3 = pumpIntakeBpd > 0 ? massThrough / pumpIntakeBpd : 0;
  let verdict = 'standard';
  if (gvfThroughPump > limits.handlerMax) verdict = 'separatorRequired';
  else if (gvfThroughPump > limits.standardMax) verdict = 'gasHandler';
  return {
    separatorEfficiency: eff,
    ventedResBpd,
    throughPumpGasResBpd,
    pumpIntakeBpd,
    gvfThroughPump,
    mixtureDensityLbFt3,
    verdict,
    limits,
  };
};

/**
 * Total dynamic head from the two pressures that define it.
 * `gradientPsiPerFt` is the gradient of the fluid IN the pump, which is
 * why the mixture density at intake is carried through the chain.
 */
export const totalDynamicHead = ({ pIntakePsia, pDischargePsia, gradientPsiPerFt }) => {
  const dpPsi = pDischargePsia - pIntakePsia;
  if (!(gradientPsiPerFt > 0)) return { dpPsi, tdhFt: NaN };
  return { dpPsi, tdhFt: dpPsi / gradientPsiPerFt };
};

/**
 * The classic three-part reading of the same head, for the report:
 * net vertical lift from the dynamic fluid level to the surface, tubing
 * friction at the design rate, and the wellhead pressure expressed in
 * feet of the produced fluid. It is a decomposition of a TDH that has
 * already been computed from pressures, never a substitute route to it.
 */
export const tdhBreakdown = ({ netLiftFt, frictionFt, whpHeadFt }) => ({
  netLiftFt,
  frictionFt,
  whpHeadFt,
  tdhFt: netLiftFt + frictionFt + whpHeadFt,
});

/** Stages needed to make the head, always rounded up. */
export const stageCount = ({ tdhFt, headPerStageFt }) => {
  if (!(headPerStageFt > 0)) return NaN;
  return Math.ceil(tdhFt / headPerStageFt);
};

/**
 * Size a pump for a duty.
 *
 * inputs: {
 *   curve                stage curve (vendor fit or reference model)
 *   qBpd                 in-situ rate through the pump
 *   tdhFt                total dynamic head
 *   hz                   drive frequency
 *   specificGravity      of the fluid in the pump
 *   motorEfficiency      fraction, for the motor loading report
 *   nameplateHp          the motor being considered (optional)
 *   viscosity            { viscosityCp, densityLbFt3 } for the check
 * }
 * returns { stages, stage, stack, hydraulicHp, shaftHp, motorLoad,
 *           warnings }
 *
 * TWO POWERS COME BACK, and they are not the same question.
 *
 *   `shaftHp`         brake power at the head the duty REQUIRES, that
 *                     is at tdhFt, at the stage efficiency at this
 *                     duty. It is what the well asks for.
 *   `stack.bhpTotal`  brake power per stage times the stage count,
 *                     which is brake power at the head the stack
 *                     ACTUALLY MAKES (`headMadeFt`). It is what the
 *                     pump on the string will absorb at this rate.
 *
 * Because `stageCount` rounds up, headMadeFt >= tdhFt always, so
 * bhpTotal >= shaftHp always, and the two differ by exactly the
 * rounding margin: bhpTotal / shaftHp = headMadeFt / tdhFt, bounded by
 * one stage in `stages`. On a 166 stage design whose head requirement
 * lands 99 percent of the way through the last stage the gap is 0.6
 * percent (0.81 hp on 134.6); on a short stack it is larger.
 *
 * THE ELECTRICAL CHAIN RUNS ON THE SECOND OF THE TWO. The published
 * motor sizing method takes it: PetroWiki, ESP system selection and
 * performance calculations, gives BHP = total stages x (BHP/stage) x
 * SG, the power of the stage count actually selected. `motorLoad`, the
 * amps, the cable drop and `espMotorCable.selectCable` were all built
 * on `shaftHp` instead, so every one of them understated the load by
 * the rounding margin, in the non conservative direction, and a cable
 * chosen that way can be a size light. Item 2.
 *
 * `motorSizingHp` is the number the chain is now taken at, and it is
 * `stack.bhpTotal`. `shaftHp` is still returned, because the power the
 * duty asks for is a real quantity and the head margin is read from the
 * gap between the two, but nothing electrical is taken from it and
 * `espMotorCable`'s functions name their input `motorHp` so a caller
 * cannot hand them the wrong one without noticing.
 */
export const sizePump = ({
  curve, qBpd, tdhFt, hz = 60, specificGravity, nameplateHp,
  motorEfficiency = 0.85, thrustDeratePct,
}) => {
  const warnings = [];
  const stage = stagePerformance({ curve, qBpd, hz, specificGravity });
  // Item 5. Past the band there is no head and no efficiency, so there
  // is no stage count and no design: the refusal travels rather than
  // being turned into a stack of a stage nobody can read.
  if (stage.ok === false) {
    return { ok: false, code: stage.code, error: stage.error, stage };
  }
  if (!stage.inRange) {
    warnings.push({
      code: 'outsideCurve',
      // The rate is said to be OUTSIDE the range printed next to it, so
      // rounded whole a rate a fraction past `qMax` read as the bound
      // itself: "At 2500 bbl/d ... outside its published range (1200 to
      // 2500 bbl/d)". One decimal on the rate; the bounds read exactly
      // as they did before, because they are the published range and
      // not a number this well is being measured to a fraction of.
      // copy-lint-allow: the bounds are the published range, decided in 2ed47d5.
      message: `At ${qBpd.toFixed(1)} bbl/d and ${hz} Hz the pump runs outside its published range (${Math.round(curve.qMin)} to ${Math.round(curve.qMax)} bbl/d at ${curve.refHz} Hz). Head and efficiency here are an extrapolation.`,
    });
  }
  if (stage.region === 'downthrust' || stage.region === 'upthrust') {
    warnings.push({
      code: stage.region,
      message: stage.region === 'downthrust'
        ? 'The duty sits left of the recommended range: the stages run in downthrust and wear on the thrust washers.'
        : 'The duty sits right of the recommended range: the stages run in upthrust, which is the harder of the two on a pump.',
    });
  }

  const stages = stageCount({ tdhFt, headPerStageFt: stage.headFt });
  const stack = stackPerformance({ curve, stages, qBpd, hz, specificGravity });
  const hydraulic = hydraulicHp({ qBpd, headFt: tdhFt, specificGravity });
  const shaftHp = Number.isFinite(stage.efficiency) && stage.efficiency > 0
    ? brakeHp({ qBpd, headFt: tdhFt, specificGravity, efficiency: stage.efficiency })
    : stack.bhpTotal;

  // motorLoad.loadFraction is a UTILISATION against the motor's usable
  // rating: the derate reduces how much shaft power this motor may
  // legally carry, so a derated 150 hp motor is judged as a 132 hp one
  // and the flag fires accordingly. That is the selection question, and
  // it is the same arithmetic as the published rule that required motor
  // horsepower is the pump horsepower divided by the derating factor.
  //
  // It is NOT the same quantity as `espMotorCable.motorCurrent`'s field
  // of the same name, which is the ELECTRICAL load fraction, shaft hp
  // over nameplate hp with no derate, because the current a motor draws
  // at a given shaft load is a property of the machine and does not
  // move when its permissible load is cut for heat, thrust or voltage
  // unbalance (PetroWiki, ESP motors: the motor current is nearly
  // linear with HP loading). Both are right; sharing one field name is
  // the trap. The two differ by loadFraction * (1/derate - 1), which on
  // a 12 percent derate and a motor at 0.897 of plate is 12.2 points.
  // The power the electrical chain is sized on: what the stack absorbs
  // at the stage count actually selected, not what the duty asks for.
  const motorSizingHp = stack.bhpTotal;
  let motorLoad = null;
  if (nameplateHp > 0) {
    // A DERATE THAT CANNOT BE READ IS NOT NO DERATE. `thrustDeratePct ?
    // ... : 1` sent a NaN, a null and an unentered field down the same
    // path as a deliberate zero, so a percentage the user meant to
    // supply and got wrong silently became a motor at full rating, in
    // the non conservative direction, and the string "12" silently
    // worked. Not one of the 80; R2's door rule.
    if (thrustDeratePct !== undefined && thrustDeratePct !== null
      && !Number.isFinite(thrustDeratePct)) {
      return {
        ok: false,
        code: 'unreadableDerate',
        error: `The thrust derate could not be read as a number, so how much of this motor may be used cannot be said and no load fraction is reported. Hand a numeric derate in percent, or leave it out for no derate.`,
      };
    }
    const derate = thrustDeratePct ? 1 - thrustDeratePct / 100 : 1;
    motorLoad = {
      nameplateHp,
      derate,
      sizingHp: motorSizingHp,
      loadFraction: motorSizingHp / (nameplateHp * derate),
      motorEfficiency,
      inputKw: (motorSizingHp * 0.7457) / motorEfficiency,
    };
    // Both of these fire on `loadFraction`, which is measured against
    // the DERATED rating, so the derate has to appear in the message
    // or the numbers argue against the warning they are attached to:
    // 95.4 hp against a 100 hp motor reads as comfortably inside
    // rating, while what tripped the flag is 95.4 / (100 x 0.88) =
    // 1.084 at a 12 percent thrust derate. The usable rating and the
    // load fraction are both named for the same reason, and the
    // underload message names them too rather than asserting a
    // condition a reader cannot check.
    const usableHp = nameplateHp * motorLoad.derate;
    const plate = motorLoad.derate < 1
      ? `a ${nameplateHp} hp motor derated ${thrustDeratePct} percent for thrust, a usable ${usableHp.toFixed(1)} hp`
      : `a ${nameplateHp} hp motor`;
    const carried = `${(motorLoad.loadFraction * 100).toFixed(1)} percent of what it may carry`;
    if (motorLoad.loadFraction > 1) {
      warnings.push({
        code: 'motorOverloaded',
        message: `The ${stages} stages absorb ${motorSizingHp.toFixed(1)} hp against ${plate}, ${carried}. Move up a motor or take stages out.`,
      });
    } else if (motorLoad.loadFraction < 0.5) {
      warnings.push({
        code: 'motorUnderloaded',
        message: `The ${stages} stages absorb ${motorSizingHp.toFixed(1)} hp against ${plate}, ${carried}: it will run cool but the power factor and the cost both suffer.`,
      });
    }
  }

  return {
    ok: true,
    stages,
    stage,
    stack,
    hydraulicHp: hydraulic,
    shaftHp,
    // the power everything electrical is taken at, published so a
    // consumer does not have to know that it is stack.bhpTotal
    motorSizingHp,
    motorLoad,
    headMadeFt: stack.headFt,
    headMarginFt: stack.headFt - tdhFt,
    warnings,
  };
};

/**
 * Where a running pump actually sits, from measured operating data.
 * This is the diagnostics half of the studio (the absorbed ESP
 * Performance Monitor): the same curve, read backwards.
 *
 * `measured` carries what a surveillance record has: the rate, the
 * intake and discharge pressures (or the head directly), the drive
 * frequency and the motor amps.
 *
 * Head degradation is the honest comparison the curve supports: what
 * the stack SHOULD make at this rate and speed against what it IS
 * making. A pump making 80 percent of its curve is worn, gas locked or
 * running on a wrong stage count, and the number says so without
 * guessing which.
 *
 * Message precision. All three ratio flags below fire on a strict
 * inequality against a threshold and then PRINT the ratio, so the
 * printed number must be able to sit off the threshold. Rounded to
 * whole percent, a head ratio of 0.8461 renders as "85 percent" under a
 * flag that only fires below 85, which reads as a false alarm and
 * invites a reader to dismiss a real warning. One decimal place is
 * therefore the format for every ratio printed here, and the gate
 * `boundary bands print a value off the threshold` in
 * __tests__/production.esp.test.js pins each of the three bands.
 */
export const diagnoseOperation = ({
  curve, stages, hz = 60, specificGravity, measured, nameplateAmps,
}) => {
  const { qBpd, pIntakePsia, pDischargePsia, headFt, amps } = measured || {};
  const gradient = PSI_PER_FT_SG * specificGravity;
  const actualHeadFt = Number.isFinite(headFt)
    ? headFt
    : (Number.isFinite(pDischargePsia) && Number.isFinite(pIntakePsia) && gradient > 0
      ? (pDischargePsia - pIntakePsia) / gradient
      : NaN);

  const expected = stackPerformance({ curve, stages, qBpd, hz, specificGravity });
  if (expected.ok === false) {
    return { ok: false, code: expected.code, error: expected.error };
  }
  const headRatio = Number.isFinite(actualHeadFt) && expected.headFt > 0
    ? actualHeadFt / expected.headFt
    : NaN;
  const bep = curve.bep || bepOf(curve);
  const ratio = hz / (curve.refHz || 60);
  const qRef = qBpd / ratio;

  const flags = [];
  if (Number.isFinite(headRatio)) {
    if (headRatio < 0.85) {
      flags.push({
        code: 'underCurve',
        message: `The stack is making ${(headRatio * 100).toFixed(1)} percent of the head its curve says it should at this rate. Wear, free gas through the stages or a wrong stage count all look like this.`,
      });
    } else if (headRatio > 1.15) {
      flags.push({
        code: 'overCurve',
        message: 'The stack is making more head than its curve allows, so one of the inputs is wrong: the rate, the pressures, the fluid gradient or the stage count.',
      });
    }
  }
  if (expected.region === 'downthrust' || expected.region === 'upthrust') {
    flags.push({
      code: expected.region,
      message: `Running in ${expected.region}: the duty is ${(qRef / bep.qBpd).toFixed(2)} of the best efficiency rate.`,
    });
  }
  if (nameplateAmps > 0 && Number.isFinite(amps)) {
    const load = amps / nameplateAmps;
    if (load > 1.05) {
      flags.push({ code: 'ampsHigh', message: `Motor amps are ${(load * 100).toFixed(1)} percent of nameplate.` });
    } else if (load < 0.4) {
      flags.push({ code: 'ampsLow', message: `Motor amps are ${(load * 100).toFixed(1)} percent of nameplate, which is where a gas-locked or pumped-off well sits.` });
    }
  }

  return {
    ok: true,
    actualHeadFt,
    expectedHeadFt: expected.headFt,
    headRatio,
    region: expected.region,
    qOverBep: Number.isFinite(bep.qBpd) && bep.qBpd > 0 ? qRef / bep.qBpd : NaN,
    efficiency: expected.efficiency,
    ampsLoad: nameplateAmps > 0 && Number.isFinite(amps) ? amps / nameplateAmps : null,
    flags,
  };
};

/**
 * Head the stack makes across a rate range, with the stage curve and
 * the duty point, for plotting against the well's system curve.
 */
export const stackCurve = ({ curve, stages, hz = 60, specificGravity, nPoints = 25 }) => {
  const ratio = hz / (curve.refHz || 60);
  const qLo = curve.qMin * ratio;
  const qHi = curve.qMax * ratio;
  return Array.from({ length: nPoints }, (_, i) => {
    const qBpd = qLo + ((qHi - qLo) * i) / (nPoints - 1);
    const s = stackPerformance({ curve, stages, qBpd, hz, specificGravity });
    return {
      qBpd,
      headFt: s.headFt,
      efficiency: s.efficiency,
      bhpTotal: s.bhpTotal,
      region: s.region,
    };
  });
};
