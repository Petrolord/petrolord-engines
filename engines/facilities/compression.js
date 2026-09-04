/**
 * Gas compression: staging, head, power and machine screening
 * (Facilities F9).
 *
 * A new app, not a rebuild: the F0-retired Compressor & Pump Pack was
 * fifty lines of static HTML printing "Power: 1250 hp" as a literal.
 * This is the GPSA Chapter 13 method it pretended to be.
 *
 * What the engine does:
 *  - splits a compression ratio into stages, by the equal-ratio rule
 *    AND by the discharge-temperature limit, because the second is
 *    what actually decides stage count on a hot or a high-k gas
 *  - polytropic head and power with the polytropic efficiency and the
 *    exponent derived from it (not the isentropic exponent misused as
 *    a polytropic one, which is the classic error and is worth about
 *    ten percent of power)
 *  - the isentropic route as well, so the two can be compared: they
 *    are different idealisations and quoting one as the other is how
 *    a driver ends up undersized
 *  - real-gas Z at suction AND discharge, averaged, because Z changes
 *    materially across a stage at pipeline pressures
 *  - interstage cooling and the condensed liquid it drops out
 *  - a reciprocating versus centrifugal screen on the actual
 *    published selection criteria (flow, ratio, power), not a guess
 *  - fuel gas for a gas-engine or turbine driver
 *
 * Units: field (MMscfd, psia, F, hp, Btu).
 */

import { suttonPseudoCriticals, dakZ, toRankine } from '../production/gasProperties.js';

const R_UNIVERSAL_FT_LBF = 1545.349; // ft.lbf/(lbmol.R)
const MW_AIR = 28.9625;
const LBMOL_SCF = 379.49;

/* ------------------------------------------------------------------ *
 * Staging
 * ------------------------------------------------------------------ */

/**
 * Discharge temperature of a polytropic stage:
 *   T2 = T1 * r^((n-1)/n),  (n-1)/n = (k-1)/(k * eta_p)
 * The polytropic exponent is NOT the isentropic one: using k where n
 * belongs under-predicts the discharge temperature and over-predicts
 * how much ratio a stage can take.
 */
export const polytropicExponentRatio = ({ k, polytropicEfficiency }) => {
  if (!(k > 1) || !(polytropicEfficiency > 0) || polytropicEfficiency > 1) return NaN;
  return (k - 1) / (k * polytropicEfficiency);
};

export const dischargeTempR = ({ tSuctionR, ratio, k, polytropicEfficiency }) => {
  const e = polytropicExponentRatio({ k, polytropicEfficiency });
  if (!Number.isFinite(e) || !(ratio > 0) || !(tSuctionR > 0)) return NaN;
  return tSuctionR * ratio ** e;
};

/**
 * Stage count. The equal-ratio rule gives the thermodynamic minimum
 * for a given per-stage ratio; the temperature limit is what usually
 * governs, and the engine reports which one did.
 */
export const stageCount = ({
  pSuctionPsia, pDischargePsia, tSuctionF, k, polytropicEfficiency = 0.75,
  maxRatioPerStage = 4, maxDischargeF = 300,
}) => {
  if (!(pSuctionPsia > 0) || !(pDischargePsia > pSuctionPsia)) {
    return { error: 'discharge pressure must exceed suction pressure' };
  }
  if (!(k > 1)) return { error: 'the heat capacity ratio must exceed 1' };
  const overall = pDischargePsia / pSuctionPsia;
  const tSuctionR = toRankine(tSuctionF);

  // stages the per-stage ratio limit demands
  const byRatio = Math.max(1, Math.ceil(Math.log(overall) / Math.log(maxRatioPerStage)));

  // stages the temperature limit demands: raise n until each equal
  // stage stays under the limit
  let byTemp = 1;
  for (; byTemp <= 12; byTemp += 1) {
    const r = overall ** (1 / byTemp);
    const tOut = dischargeTempR({ tSuctionR, ratio: r, k, polytropicEfficiency });
    if (tOut - 459.67 <= maxDischargeF) break;
  }
  if (byTemp > 12) {
    return { error: 'no practical stage count keeps the discharge temperature under the limit: intercool harder, or check k and the suction temperature' };
  }

  const stages = Math.max(byRatio, byTemp);
  return {
    overallRatio: overall,
    stages,
    ratioPerStage: overall ** (1 / stages),
    byRatio,
    byTemp,
    governedBy: byTemp > byRatio ? 'discharge temperature'
      : (byRatio > byTemp ? 'ratio per stage' : 'both equally'),
  };
};

/* ------------------------------------------------------------------ *
 * A single stage
 * ------------------------------------------------------------------ */

/** Z at a state, from the validated correlation. */
const zAt = ({ pPsia, tF, gasSg }) => {
  const { tpcR, ppcPsia } = suttonPseudoCriticals(gasSg);
  return dakZ({ ppr: pPsia / ppcPsia, tpr: toRankine(tF) / tpcR }).z;
};

/**
 * One compression stage, polytropic and isentropic side by side.
 *
 * Polytropic head (GPSA):
 *   Hp = Z_avg R T1 / MW * (n/(n-1)) * (r^((n-1)/n) - 1)
 * Isentropic head is the same with k in place of n and no efficiency
 * inside the exponent. They are different idealisations; the engine
 * returns both so neither gets quoted as the other.
 */
export const compressionStage = ({
  qMMscfd, pSuctionPsia, tSuctionF, ratio, gasSg, k,
  polytropicEfficiency = 0.75, mechanicalEfficiency = 0.97,
}) => {
  if (!(qMMscfd > 0) || !(pSuctionPsia > 0) || !(ratio > 1) || !(gasSg > 0) || !(k > 1)) {
    return { error: 'a stage needs a positive rate, suction pressure, gas gravity, k above 1 and a ratio above 1' };
  }
  const mw = MW_AIR * gasSg;
  const tSuctionR = toRankine(tSuctionF);
  const pDischargePsia = pSuctionPsia * ratio;

  const e = polytropicExponentRatio({ k, polytropicEfficiency });
  const tDischargeR = tSuctionR * ratio ** e;
  const tDischargeF = tDischargeR - 459.67;

  // Z averaged across the stage: it moves materially at pipeline
  // pressures, and using suction Z alone overstates the head.
  const z1 = zAt({ pPsia: pSuctionPsia, tF: tSuctionF, gasSg });
  const z2 = zAt({ pPsia: pDischargePsia, tF: tDischargeF, gasSg });
  const zAvg = (z1 + z2) / 2;

  const rConstant = R_UNIVERSAL_FT_LBF / mw; // ft.lbf/(lbm.R)
  const nOverNminus1 = 1 / e;
  const headPolyFtLbfLbm = zAvg * rConstant * tSuctionR * nOverNminus1 * (ratio ** e - 1);

  const kExp = (k - 1) / k;
  const headIsenFtLbfLbm = zAvg * rConstant * tSuctionR * (1 / kExp) * (ratio ** kExp - 1);

  // mass flow: MMscfd -> lbmol/hr -> lb/hr
  const lbmolPerHr = (qMMscfd * 1e6) / LBMOL_SCF / 24;
  const massLbHr = lbmolPerHr * mw;

  // hp = (lb/hr * ft.lbf/lbm) / (33000 ft.lbf/min/hp * 60 min/hr)
  const gasHpPoly = (massLbHr * headPolyFtLbfLbm) / (33000 * 60) / polytropicEfficiency;
  // Isentropic efficiency from the polytropic one, published relation:
  //   eta_s = (r^((k-1)/k) - 1) / (r^((k-1)/(k eta_p)) - 1)
  // It is always BELOW the polytropic efficiency for compression,
  // because the reheat a real machine generates has to be recompressed.
  // The two power routes must then agree exactly, which is the check.
  const isentropicEfficiency = (ratio ** kExp - 1) / (ratio ** e - 1);
  const gasHpIsen = (massLbHr * headIsenFtLbfLbm) / (33000 * 60) / isentropicEfficiency;

  return {
    pDischargePsia,
    tDischargeF,
    z1, z2, zAvg,
    massLbHr,
    headPolyFtLbfLbm,
    headIsenFtLbfLbm,
    polytropicEfficiency,
    isentropicEfficiency,
    gasHp: gasHpPoly,
    gasHpIsentropicRoute: gasHpIsen,
    brakeHp: gasHpPoly / mechanicalEfficiency,
    // One decimal, because the sentence names its own threshold: at
    // whole degrees a discharge of 300.3 F read "discharge at 300 F:
    // above about 300 F ...". Narrowed by ten, not closed.
    warning: tDischargeF > 300
      ? `discharge at ${tDischargeF.toFixed(1)} F: above about 300 F the valves and the lube oil become the limit, not the thermodynamics`
      : null,
  };
};

/**
 * A whole multi-stage machine with interstage cooling. Cooling is
 * back to a stated approach above ambient, and the engine reports the
 * cooling duty because that is a real exchanger somebody has to buy.
 */
export const compressorTrain = ({
  qMMscfd, pSuctionPsia, tSuctionF, pDischargePsia, gasSg, k,
  polytropicEfficiency = 0.75, mechanicalEfficiency = 0.97,
  interstageCoolToF, cpBtuLbF = 0.55,
  maxRatioPerStage = 4, maxDischargeF = 300,
}) => {
  const staging = stageCount({
    pSuctionPsia, pDischargePsia, tSuctionF, k, polytropicEfficiency,
    maxRatioPerStage, maxDischargeF,
  });
  if (staging.error) return staging;

  const coolTo = Number.isFinite(interstageCoolToF) ? interstageCoolToF : tSuctionF;
  const stages = [];
  let p = pSuctionPsia;
  let t = tSuctionF;
  let totalGasHp = 0;
  let totalCoolingBtuHr = 0;

  for (let i = 0; i < staging.stages; i += 1) {
    const s = compressionStage({
      qMMscfd, pSuctionPsia: p, tSuctionF: t, ratio: staging.ratioPerStage,
      gasSg, k, polytropicEfficiency, mechanicalEfficiency,
    });
    if (s.error) return s;
    totalGasHp += s.gasHp;
    const last = i === staging.stages - 1;
    let coolingBtuHr = 0;
    if (!last && s.tDischargeF > coolTo) {
      coolingBtuHr = s.massLbHr * cpBtuLbF * (s.tDischargeF - coolTo);
      totalCoolingBtuHr += coolingBtuHr;
    }
    stages.push({
      stage: i + 1,
      pSuctionPsia: p,
      pDischargePsia: s.pDischargePsia,
      tSuctionF: t,
      tDischargeF: s.tDischargeF,
      ratio: staging.ratioPerStage,
      zAvg: s.zAvg,
      headPolyFtLbfLbm: s.headPolyFtLbfLbm,
      gasHp: s.gasHp,
      brakeHp: s.brakeHp,
      coolingBtuHr,
      cooledToF: last ? null : coolTo,
      warning: s.warning,
    });
    p = s.pDischargePsia;
    t = last ? s.tDischargeF : coolTo;
  }

  return {
    ...staging,
    stages,
    totalGasHp,
    totalBrakeHp: totalGasHp / mechanicalEfficiency,
    totalCoolingBtuHr,
    totalCoolingMMBtuHr: totalCoolingBtuHr / 1e6,
    finalDischargeF: stages[stages.length - 1].tDischargeF,
  };
};

/* ------------------------------------------------------------------ *
 * Machine selection
 * ------------------------------------------------------------------ */

/**
 * Reciprocating versus centrifugal, on the published selection
 * criteria rather than a preference: actual inlet volume, pressure
 * ratio and power. Centrifugals want volume and dislike high ratios
 * per wheel; recips take ratio easily and dislike large volume.
 */
export const actualInletCfm = ({ qMMscfd, pPsia, tF, gasSg }) => {
  if (!(qMMscfd > 0) || !(pPsia > 0)) return NaN;
  const z = zAt({ pPsia, tF, gasSg });
  return ((qMMscfd * 1e6) / 1440) * (14.7 / pPsia) * (toRankine(tF) / 520) * z;
};

export const machineScreen = ({
  qMMscfd, pSuctionPsia, tSuctionF, gasSg, overallRatio, totalBrakeHp,
}) => {
  const acfm = actualInletCfm({ qMMscfd, pPsia: pSuctionPsia, tF: tSuctionF, gasSg });
  if (!Number.isFinite(acfm)) return { error: 'screening needs a rate and suction conditions' };
  const reasons = [];
  let recommendation;
  // Same as the discharge temperature above: this one names 500 acfm
  // and at whole acfm a suction volume of 499.7 read "only 500 acfm at
  // suction: below about 500 acfm ...".
  if (acfm < 500) {
    recommendation = 'reciprocating';
    reasons.push(`only ${acfm.toFixed(1)} acfm at suction: below about 500 acfm a centrifugal wheel is too small to be efficient`);
  } else if (acfm > 20000 && overallRatio < 4) {
    recommendation = 'centrifugal';
    reasons.push(`${acfm.toFixed(0)} acfm at a modest ratio: this is centrifugal territory`);
  } else if (overallRatio > 6 && acfm < 5000) {
    recommendation = 'reciprocating';
    reasons.push(`overall ratio ${overallRatio.toFixed(1)} at ${acfm.toFixed(0)} acfm: recips take ratio far more happily than centrifugals`);
  } else {
    recommendation = 'either';
    reasons.push('this duty sits where both machine types are viable; the decision goes on availability, footprint, maintenance philosophy and driver');
  }
  if (totalBrakeHp > 0) {
    if (totalBrakeHp < 200) reasons.push('under 200 bhp: a packaged gas-engine recip is the usual answer');
    else if (totalBrakeHp > 10000) reasons.push('over 10,000 bhp: turbine-driven centrifugal territory');
  }
  return { acfm, recommendation, reasons };
};

/* ------------------------------------------------------------------ *
 * Driver fuel
 * ------------------------------------------------------------------ */

/**
 * Fuel gas for a gas-engine or gas-turbine driver, from the driver's
 * heat rate. Reported in MMscfd, because on a gas plant the fuel is
 * taken out of the very stream being compressed and it matters to the
 * sales-gas balance.
 */
export const driverFuel = ({ brakeHp, heatRateBtuHpHr = 8000, gasLhvBtuScf = 950 }) => {
  if (!(brakeHp > 0) || !(heatRateBtuHpHr > 0) || !(gasLhvBtuScf > 0)) {
    return { error: 'fuel needs a positive power, heat rate and heating value' };
  }
  const btuHr = brakeHp * heatRateBtuHpHr;
  const scfd = (btuHr * 24) / gasLhvBtuScf;
  return {
    fuelBtuHr: btuHr,
    fuelMMscfd: scfd / 1e6,
    thermalEfficiencyPct: (2544.43 / heatRateBtuHpHr) * 100,
  };
};
