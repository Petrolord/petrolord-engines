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
 *
 * EVERY REFUSAL IS A NAMED REFUSAL, and it names the input that is
 * actually wrong. The FC3-0 wave found one sentence covering four
 * unrelated faults here ("no practical stage count keeps the discharge
 * temperature under the limit") and another covering five ("a stage
 * needs a positive rate, suction pressure, gas gravity, k above 1 and
 * a ratio above 1"), so a user who typed a polytropic efficiency of
 * 1.5 was told to intercool harder and a user who typed a per-stage
 * ratio limit of 1 was sent to check four inputs that were correct.
 * Each guard now speaks for itself.
 *
 * THE EXCEPTIONS are `polytropicExponentRatio`, `dischargeTempR` and
 * `actualInletCfm`, which return a BARE NUMBER and have nowhere to put
 * an error. They return NaN by DOCUMENTED CONTRACT, never Infinity and
 * never a plausible number, and every caller inside this module checks
 * them before using them. `actualInletCfm` used to return a NEGATIVE
 * volume for a suction below absolute zero and `machineScreen`
 * recommended a machine on it.
 */

import {
  suttonPseudoCriticals, dakZ, toRankine, AIR_MW, R_UNIVERSAL, R_OFFSET,
} from '../production/gasProperties.js';
import { FT_LBF_PER_MIN_PER_HP, BTU_PER_HP_HR } from '../../lib/units/fieldUnits.js';
import {
  DAK_TPR_MIN, DAK_TPR_MAX, DAK_PPR_MIN_FIT, DAK_PPR_MAX,
} from './separatorSizing.js';

/**
 * ONE GAS CONSTANT FOR THE PACKAGE.
 *
 * This module used to declare `R_UNIVERSAL_FT_LBF = 1545.349` privately
 * while importing from `gasProperties.js`, which declares the SAME
 * CONSTANT as `R_UNIVERSAL = 10.7316` psia.ft3/(lbmol.degR), or
 * 1545.3504 in these units. A ratio of 0.999999094056597 between two
 * values of one constant, one import apart, on the same gas: every
 * polytropic head and every gas horsepower here was 9.06e-7 low
 * against the compressibility it was multiplied by. Two values of one
 * constant is a defect however small the gap, because nothing
 * downstream can tell which of the two it is holding.
 *
 * gasProperties.js is the OWNER: its header already declares itself
 * the domain's only home for this constant and for the molecular
 * weight of air, and many shipped courses grade against it. So the
 * private copy is the bug and it is gone, along with the private
 * MW_AIR and the three inline 459.67s.
 */
const SQ_IN_PER_SQ_FT = 144;
const R_UNIVERSAL_FT_LBF = R_UNIVERSAL * SQ_IN_PER_SQ_FT;

/**
 * ONE STANDARD BASE FOR THE MODULE.
 *
 * `LBMOL_SCF = 379.49` belongs to the 14.696 psia, 519.67 degR base,
 * and `actualInletCfm` worked from 14.7 psia and 520 degR, three parts
 * in ten thousand away. A module cannot mean two things by "scf": the
 * same MMscfd was one molar quantity when it became a mass flow and a
 * different one when it became an inlet volume. The base is now
 * declared once and every standard-condition quantity is derived from
 * it and from the package's gas constant, so 379.49 is no longer
 * quoted at all: it was a rounding of this derivation with no
 * independent provenance, and the derived value on the package's own
 * R is 379.48357185628737.
 */
const STD_PRESSURE_PSIA = 14.696;
const STD_TEMPERATURE_R = 519.67;
const LBMOL_SCF = (R_UNIVERSAL * STD_TEMPERATURE_R) / STD_PRESSURE_PSIA;

const MINUTES_PER_DAY = 1440;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;

/* ------------------------------------------------------------------ *
 * Staging
 * ------------------------------------------------------------------ */

/**
 * Discharge temperature of a polytropic stage:
 *   T2 = T1 * r^((n-1)/n),  (n-1)/n = (k-1)/(k * eta_p)
 * The polytropic exponent is NOT the isentropic one: using k where n
 * belongs under-predicts the discharge temperature and over-predicts
 * how much ratio a stage can take.
 *
 * Bare-number contract: NaN when the inputs cannot be read.
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
 *
 * THE TEMPERATURE LIMIT IS TESTED AGAINST THE TEMPERATURE THE STAGES
 * WILL ACTUALLY SEE. This used to run every trial stage from
 * `tSuctionF`, while `compressorTrain` ran stage 1 from `tSuctionF`
 * and every later stage from `interstageCoolToF`. Whenever the
 * intercooler approach sat above the suction temperature the later
 * stages were hotter than the count had been chosen for, and the train
 * broke the very limit its own return said had governed the staging:
 * on one duty by 73.3 degF, with no warning, on a return reading
 * `governedBy: 'discharge temperature'`. The Compressor Station
 * Designer's own default state has the approach above the suction
 * (110 degF against 100 degF), so this was reachable from an app
 * opened and not touched.
 *
 * A single stage starts from the suction and is never cooled, so the
 * inlet a trial count must be tested at is the suction for one stage
 * and the hotter of the suction and the cooled temperature for more
 * than one.
 */
export const stageCount = ({
  pSuctionPsia, pDischargePsia, tSuctionF, k, polytropicEfficiency = 0.75,
  maxRatioPerStage = 4, maxDischargeF = 300, interstageCoolToF,
}) => {
  if (!(pSuctionPsia > 0) || !(pDischargePsia > pSuctionPsia)) {
    return { error: 'discharge pressure must exceed suction pressure' };
  }
  if (!(k > 1)) return { error: 'the heat capacity ratio must exceed 1' };
  if (!(polytropicEfficiency > 0) || polytropicEfficiency > 1) {
    // The value is in the sentence because two typed values reach this
    // guard from opposite directions: a 0 and a 1.5 are not the same
    // mistake and a reader who is told only the rule has to work out
    // which of them they made.
    return { error: `polytropic efficiency must be greater than 0 and at most 1 (got ${polytropicEfficiency})` };
  }
  // At a limit of 1 the equal-ratio rule divides by log(1), which is
  // zero, and the stage count came back Infinity with no error key,
  // governed by "ratio per stage". A negative limit made it NaN.
  if (!(maxRatioPerStage > 1)) {
    return { error: 'the maximum ratio per stage must be greater than 1: a stage at a ratio of 1 adds no pressure, so no number of them reaches the discharge' };
  }
  const tSuctionR = toRankine(tSuctionF);
  if (!(tSuctionR > 0)) {
    return { error: `the suction temperature is at or below absolute zero (${tSuctionF} F)` };
  }
  const maxDischargeR = toRankine(maxDischargeF);
  if (!(maxDischargeR > 0)) {
    return { error: `the maximum discharge temperature is at or below absolute zero (${maxDischargeF} F)` };
  }
  if (maxDischargeR <= tSuctionR) {
    return { error: `the maximum discharge temperature of ${maxDischargeF} F is at or below the suction temperature of ${tSuctionF} F: compression raises the temperature of a gas, so no stage count can meet this limit` };
  }
  const coolToR = toRankine(Number.isFinite(interstageCoolToF) ? interstageCoolToF : tSuctionF);
  if (!(coolToR > 0)) {
    return { error: 'the interstage cooling temperature is at or below absolute zero' };
  }

  const overall = pDischargePsia / pSuctionPsia;

  // stages the per-stage ratio limit demands
  const byRatio = Math.max(1, Math.ceil(Math.log(overall) / Math.log(maxRatioPerStage)));

  // stages the temperature limit demands: raise n until every stage,
  // started from the inlet that stage will really have, stays under
  // the limit
  const hottestInletR = (n) => (n <= 1 ? tSuctionR : Math.max(tSuctionR, coolToR));
  const MAX_TRIAL_STAGES = 12;
  let byTemp = 1;
  let coolestReachedF = Infinity;
  for (; byTemp <= MAX_TRIAL_STAGES; byTemp += 1) {
    const r = overall ** (1 / byTemp);
    const tOut = dischargeTempR({
      tSuctionR: hottestInletR(byTemp), ratio: r, k, polytropicEfficiency,
    });
    const tOutF = tOut - R_OFFSET;
    if (tOutF < coolestReachedF) coolestReachedF = tOutF;
    if (tOutF <= maxDischargeF) break;
  }
  if (byTemp > MAX_TRIAL_STAGES) {
    // REFUSE WITH THE EVIDENCE. This sentence used to be the only thing
    // returned, and it was also the sentence four unrelated faults
    // reached (see the efficiency and temperature guards above, which
    // now catch those at the door). What is left here is the genuine
    // case, and the diagnosis has to survive the refusal: the coolest
    // discharge twelve equal stages could reach, the limit it was
    // measured against, and the inlet it was measured from, so the
    // reader can see whether it is the approach or the limit that is
    // impossible rather than being told to intercool harder.
    return {
      error: `no practical stage count keeps the discharge temperature under the limit: ${MAX_TRIAL_STAGES} equal stages still reach ${coolestReachedF.toFixed(1)} F against a stated limit of ${maxDischargeF.toFixed(1)} F, from an inlet of ${(hottestInletR(MAX_TRIAL_STAGES) - R_OFFSET).toFixed(1)} F`,
      overallRatio: overall,
      triedStages: MAX_TRIAL_STAGES,
      coolestReachedF,
      maxDischargeF,
      hottestInletF: hottestInletR(MAX_TRIAL_STAGES) - R_OFFSET,
      interstageCoolToF: coolToR - R_OFFSET,
    };
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

/**
 * Z at a state, from the validated correlation, INSIDE ITS VALIDITY
 * WINDOW AND NOWHERE ELSE.
 *
 * `separatorSizing.js` in this same package exports DAK_TPR_MIN,
 * DAK_TPR_MAX and DAK_PPR_MAX and refuses outside them by name. This
 * module called the same `dakZ` through this helper and never checked:
 * a stage at 1000 psia and -150 degF (Tpr 0.848) returned
 * z = 0.22349360002287877 and a gas horsepower of 180.88 with no error
 * key, and a stage at 24000 psia (Ppr 35.8) returned z = 2.8646 and
 * 1790.90 hp. `dakZ` reports converged: true in both, so reading the
 * convergence flag catches neither. Two modules, two philosophies, one
 * package; the window is now imported from the module that declares
 * and documents it rather than restated here, which is the same
 * one-owner rule the gas constant above is fixed by.
 *
 * It returns an OBJECT, and the refusal carries its own evidence: the
 * reduced coordinates, and the state they were taken at. A caller that
 * is told "Tpr 0.848 is below 1.0, at 1000 psia and -150 F" can see
 * which end of its train died and why.
 */
const beside = (v, limit) => `${v.toFixed(3)} against ${limit.toFixed(1)}`;

const zAt = ({ pPsia, tF, gasSg }) => {
  const { tpcR, ppcPsia } = suttonPseudoCriticals(gasSg);
  const tR = toRankine(tF);
  const at = `at ${pPsia} psia and ${tF} F`;
  if (!(tpcR > 0) || !(ppcPsia > 0)) {
    return { error: `the Sutton pseudo-criticals are not physical at a gas gravity of ${gasSg}`, atPsia: pPsia, atF: tF };
  }
  if (!(pPsia > 0) || !(tR > 0)) {
    return { error: `the z-factor needs a positive absolute pressure and a temperature above absolute zero (${at})`, atPsia: pPsia, atF: tF };
  }
  const ppr = pPsia / ppcPsia;
  const tpr = tR / tpcR;
  const ev = { ppr, tpr, atPsia: pPsia, atF: tF };
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
    return { ...ev, error: `the DAK z-factor did not converge ${at}` };
  }
  return {
    ...ev,
    z: zr.z,
    // Ppr below 0.2 is accepted, exactly as separatorSizing accepts it:
    // the fit data start there but the surface runs to the ideal-gas
    // limit as Ppr -> 0, and a low-pressure suction is an ordinary
    // machine rather than an extrapolation.
    note: ppr < DAK_PPR_MIN_FIT
      ? `Ppr ${beside(ppr, DAK_PPR_MIN_FIT)} ${at} is below the 0.2 where the DAK fit data start; the z-factor here runs toward the ideal-gas limit`
      : null,
  };
};

/**
 * One compression stage, polytropic and isentropic side by side.
 *
 * Polytropic head (GPSA):
 *   Hp = Z_avg R T1 / MW * (n/(n-1)) * (r^((n-1)/n) - 1)
 * Isentropic head is the same with k in place of n and no efficiency
 * inside the exponent. They are different idealisations; the engine
 * returns both so neither gets quoted as the other.
 *
 * THE HOT-STAGE WARNING FIRES ON THE CALLER'S LIMIT. It used to be
 * hardcoded at 300 degF with `maxDischargeF` never consulted, so a
 * train staged against a stated 200 degF broke it by 38 degF in
 * silence while a train run at 400 degF was warned at 310 for nothing.
 * The one field that could have caught the staging defect above was
 * measured against a different threshold from the one the user set.
 * 300 degF remains the DEFAULT, and the default is a customary figure
 * with no publication behind it in this repository.
 */
export const compressionStage = ({
  qMMscfd, pSuctionPsia, tSuctionF, ratio, gasSg, k,
  polytropicEfficiency = 0.75, mechanicalEfficiency = 0.97,
  maxDischargeF = 300,
}) => {
  if (!(qMMscfd > 0)) return { error: 'a stage needs a positive rate' };
  if (!(pSuctionPsia > 0)) return { error: 'a stage needs a positive suction pressure' };
  if (!(ratio > 1)) return { error: 'a stage needs a compression ratio above 1: at a ratio of 1 the stage adds no pressure' };
  if (!(gasSg > 0)) return { error: 'a stage needs a positive gas gravity' };
  if (!(k > 1)) return { error: 'a stage needs a heat capacity ratio above 1' };
  // Five inputs were validated and two efficiencies were handed
  // straight to the arithmetic: a polytropic efficiency of 0 or above
  // 1 made every thermodynamic field NaN with no error key, and a
  // mechanical efficiency of 0 made brakeHp Infinity beside a full set
  // of correct numbers.
  if (!(polytropicEfficiency > 0) || polytropicEfficiency > 1) {
    return { error: `polytropic efficiency must be greater than 0 and at most 1 (got ${polytropicEfficiency})` };
  }
  if (!(mechanicalEfficiency > 0) || mechanicalEfficiency > 1) {
    return { error: `mechanical efficiency must be greater than 0 and at most 1 (got ${mechanicalEfficiency})` };
  }
  const tSuctionR = toRankine(tSuctionF);
  if (!(tSuctionR > 0)) return { error: 'the suction temperature is at or below absolute zero' };
  if (!Number.isFinite(maxDischargeF)) {
    return { error: 'the maximum discharge temperature must be a number: the hot-stage warning is measured against it' };
  }

  const mw = AIR_MW * gasSg;
  const pDischargePsia = pSuctionPsia * ratio;

  const e = polytropicExponentRatio({ k, polytropicEfficiency });
  const tDischargeR = tSuctionR * ratio ** e;
  const tDischargeF = tDischargeR - R_OFFSET;

  // Z averaged across the stage: it moves materially at pipeline
  // pressures, and using suction Z alone overstates the head.
  const zSuction = zAt({ pPsia: pSuctionPsia, tF: tSuctionF, gasSg });
  if (zSuction.error) {
    return { ...zSuction, state: 'suction', error: `at the stage suction, ${zSuction.error}` };
  }
  const zDischarge = zAt({ pPsia: pDischargePsia, tF: tDischargeF, gasSg });
  if (zDischarge.error) {
    return { ...zDischarge, state: 'discharge', error: `at the stage discharge, ${zDischarge.error}` };
  }
  const z1 = zSuction.z;
  const z2 = zDischarge.z;
  const zAvg = (z1 + z2) / 2;
  const zNote = zSuction.note || zDischarge.note;

  const rConstant = R_UNIVERSAL_FT_LBF / mw; // ft.lbf/(lbm.R)
  const nOverNminus1 = 1 / e;
  const headPolyFtLbfLbm = zAvg * rConstant * tSuctionR * nOverNminus1 * (ratio ** e - 1);

  const kExp = (k - 1) / k;
  const headIsenFtLbfLbm = zAvg * rConstant * tSuctionR * (1 / kExp) * (ratio ** kExp - 1);

  // mass flow: MMscfd -> lbmol/hr -> lb/hr
  const lbmolPerHr = (qMMscfd * 1e6) / LBMOL_SCF / HOURS_PER_DAY;
  const massLbHr = lbmolPerHr * mw;

  // hp = (lb/hr * ft.lbf/lbm) / (33000 ft.lbf/min/hp * 60 min/hr)
  const gasHpPoly = (massLbHr * headPolyFtLbfLbm)
    / (FT_LBF_PER_MIN_PER_HP * MINUTES_PER_HOUR) / polytropicEfficiency;
  // Isentropic efficiency from the polytropic one, published relation:
  //   eta_s = (r^((k-1)/k) - 1) / (r^((k-1)/(k eta_p)) - 1)
  // It is always BELOW the polytropic efficiency for compression,
  // because the reheat a real machine generates has to be recompressed.
  //
  // The two power routes then agree, and that agreement is an ALGEBRAIC
  // IDENTITY rather than a check: e * eta_p == (k-1)/k exactly, so
  // headIsen/eta_s and headPoly/eta_p are one expression and cannot
  // disagree for any input at all. This module's gate used to call
  // their agreement "the strongest available check that neither is
  // transcribed wrong"; it could not fail, and a gate that restates
  // the formula validates nothing. The real check is now a numerical
  // quadrature of int(v dp) in __tests__/facilities.compression.test.js,
  // with a negative control proving it discriminates.
  const isentropicEfficiency = (ratio ** kExp - 1) / (ratio ** e - 1);
  const gasHpIsen = (massLbHr * headIsenFtLbfLbm)
    / (FT_LBF_PER_MIN_PER_HP * MINUTES_PER_HOUR) / isentropicEfficiency;

  return {
    pDischargePsia,
    tDischargeF,
    z1, z2, zAvg,
    zNote,
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
    warning: tDischargeF > maxDischargeF
      ? `discharge at ${tDischargeF.toFixed(1)} F is above the stated limit of ${maxDischargeF.toFixed(1)} F: the valves and the lube oil become the limit, not the thermodynamics`
      : null,
  };
};

/**
 * A whole multi-stage machine with interstage cooling. Cooling is
 * back to a stated approach above ambient, and the engine reports the
 * cooling duty because that is a real exchanger somebody has to buy.
 *
 * The approach is now handed to `stageCount` as well as used here, so
 * the count is chosen against the temperatures these stages will run
 * from, and `maxDischargeF` is handed to every stage so the hot-stage
 * warning is measured against the limit the caller stated.
 */
export const compressorTrain = ({
  qMMscfd, pSuctionPsia, tSuctionF, pDischargePsia, gasSg, k,
  polytropicEfficiency = 0.75, mechanicalEfficiency = 0.97,
  interstageCoolToF, cpBtuLbF = 0.55,
  maxRatioPerStage = 4, maxDischargeF = 300,
}) => {
  // Unreadable, this made totalCoolingBtuHr NaN while every power in
  // the return stayed correct, so the object carried one poisoned
  // field and no error key.
  if (!(cpBtuLbF >= 0)) {
    return { error: 'the interstage cooling needs a non-negative specific heat in Btu per lb per degF' };
  }
  const coolTo = Number.isFinite(interstageCoolToF) ? interstageCoolToF : tSuctionF;
  const staging = stageCount({
    pSuctionPsia, pDischargePsia, tSuctionF, k, polytropicEfficiency,
    maxRatioPerStage, maxDischargeF, interstageCoolToF: coolTo,
  });
  if (staging.error) return staging;

  const stages = [];
  let p = pSuctionPsia;
  let t = tSuctionF;
  let totalGasHp = 0;
  let totalCoolingBtuHr = 0;

  for (let i = 0; i < staging.stages; i += 1) {
    const s = compressionStage({
      qMMscfd, pSuctionPsia: p, tSuctionF: t, ratio: staging.ratioPerStage,
      gasSg, k, polytropicEfficiency, mechanicalEfficiency, maxDischargeF,
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
 *
 * Bare-number contract: NaN when the inputs cannot be read. A suction
 * below absolute zero used to give a NEGATIVE inlet volume, because
 * `Number.isFinite` was the only guard downstream and a negative
 * number is finite.
 */
export const actualInletCfm = ({ qMMscfd, pPsia, tF, gasSg }) => {
  if (!(qMMscfd > 0) || !(pPsia > 0) || !(gasSg > 0)) return NaN;
  const tR = toRankine(tF);
  if (!(tR > 0)) return NaN;
  const zr = zAt({ pPsia, tF, gasSg });
  // Outside the DAK window there is no z to multiply by, and the
  // bare-number contract says NaN rather than an extrapolation.
  // `machineScreen` asks `zAt` itself so it can name the reason.
  if (zr.error) return NaN;
  return ((qMMscfd * 1e6) / MINUTES_PER_DAY)
    * (STD_PRESSURE_PSIA / pPsia) * (tR / STD_TEMPERATURE_R) * zr.z;
};

export const machineScreen = ({
  qMMscfd, pSuctionPsia, tSuctionF, gasSg, overallRatio, totalBrakeHp,
}) => {
  // Asked before the volume, so that a state outside the correlation's
  // window is refused by NAME rather than as a missing volume.
  const zr = zAt({ pPsia: pSuctionPsia, tF: tSuctionF, gasSg });
  if (zr.error) {
    return { ...zr, error: `at the screening suction, ${zr.error}` };
  }
  const acfm = actualInletCfm({ qMMscfd, pPsia: pSuctionPsia, tF: tSuctionF, gasSg });
  // `Number.isFinite(acfm)` passed a volume of -275.5 acfm and the
  // screen then recommended a reciprocating machine because that is
  // "below about 500 acfm". A volume is positive.
  if (!(acfm > 0)) return { error: 'screening needs a rate and suction conditions that give a positive inlet volume' };
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
 *
 * A HEAT RATE BELOW THE FIRST LAW IS REFUSED. The thermal efficiency
 * is the Btu a horsepower-hour IS over the Btu the driver burns to
 * make one, so a heat rate under that figure reports an efficiency
 * above 100 percent. The only guard was `> 0`, so a heat rate of 2000
 * reported 127.2 percent and a heat rate of 1 reported 254,443
 * percent, and the Machine & Fuel tab renders that as a headline.
 */
export const driverFuel = ({ brakeHp, heatRateBtuHpHr = 8000, gasLhvBtuScf = 950 }) => {
  if (!(brakeHp > 0) || !(heatRateBtuHpHr > 0) || !(gasLhvBtuScf > 0)) {
    return { error: 'fuel needs a positive power, heat rate and heating value' };
  }
  if (heatRateBtuHpHr < BTU_PER_HP_HR) {
    // Four decimals, not two. This module already carries two findings
    // about a sentence that names its own threshold and then prints a
    // value that rounds onto it, and at two decimals a heat rate of
    // 2544.43 read "2544.43 is below the 2544.43 Btu", which refuses
    // correctly and explains nothing.
    return {
      error: `a heat rate of ${heatRateBtuHpHr} Btu per hp hr is below the ${BTU_PER_HP_HR.toFixed(4)} Btu that one horsepower-hour is: that driver would be more than 100 percent thermally efficient`,
    };
  }
  const btuHr = brakeHp * heatRateBtuHpHr;
  const scfd = (btuHr * HOURS_PER_DAY) / gasLhvBtuScf;
  return {
    fuelBtuHr: btuHr,
    fuelMMscfd: scfd / 1e6,
    thermalEfficiencyPct: (BTU_PER_HP_HR / heatRateBtuHpHr) * 100,
  };
};
