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
} from './espPump.js';

/** psi per ft per unit specific gravity (a 1.0 SG column). */
export const PSI_PER_FT_SG = 0.433;

/** Pressure gradient of a fluid, psi/ft, from its in-situ density. */
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
 */
export const sizePump = ({
  curve, qBpd, tdhFt, hz = 60, specificGravity, nameplateHp,
  motorEfficiency = 0.85, thrustDeratePct,
}) => {
  const warnings = [];
  const stage = stagePerformance({ curve, qBpd, hz, specificGravity });
  if (!stage.inRange) {
    warnings.push({
      code: 'outsideCurve',
      message: `At ${Math.round(qBpd)} bbl/d and ${hz} Hz the pump runs outside its published range (${Math.round(curve.qMin)} to ${Math.round(curve.qMax)} bbl/d at ${curve.refHz} Hz). Head and efficiency here are an extrapolation.`,
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

  let motorLoad = null;
  if (nameplateHp > 0) {
    const derate = thrustDeratePct ? 1 - thrustDeratePct / 100 : 1;
    motorLoad = {
      nameplateHp,
      derate,
      loadFraction: shaftHp / (nameplateHp * derate),
      motorEfficiency,
      inputKw: (shaftHp * 0.7457) / motorEfficiency,
    };
    if (motorLoad.loadFraction > 1) {
      warnings.push({
        code: 'motorOverloaded',
        message: `The shaft needs ${shaftHp.toFixed(1)} hp against a ${nameplateHp} hp motor. Move up a motor or take stages out.`,
      });
    } else if (motorLoad.loadFraction < 0.5) {
      warnings.push({
        code: 'motorUnderloaded',
        message: 'The motor is loaded below half its nameplate: it will run cool but the power factor and the cost both suffer.',
      });
    }
  }

  return {
    stages,
    stage,
    stack,
    hydraulicHp: hydraulic,
    shaftHp,
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
        message: `The stack is making ${(headRatio * 100).toFixed(0)} percent of the head its curve says it should at this rate. Wear, free gas through the stages or a wrong stage count all look like this.`,
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
      flags.push({ code: 'ampsHigh', message: `Motor amps are ${(load * 100).toFixed(0)} percent of nameplate.` });
    } else if (load < 0.4) {
      flags.push({ code: 'ampsLow', message: `Motor amps are ${(load * 100).toFixed(0)} percent of nameplate, which is where a gas-locked or pumped-off well sits.` });
    }
  }

  return {
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
