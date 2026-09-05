/**
 * Artificial lift advisor: the design pass and the reconciliation
 * (Production, extracted from the Suite's Artificial Lift Advisor P9
 * layer).
 *
 * THE IDEA. Screening is a rules matrix and says so
 * (./liftScreening.js). This module does the thing that matrix cannot:
 * it takes ONE shared well record and actually runs each lift method's
 * validated design chain on it, so the answer is not "an ESP suits
 * high-rate wells" but "on this well at 300 stb/d an ESP needs 162
 * stages against 4,183 ft of head, and 31 per cent of what the pump
 * swallows is gas".
 *
 * ONE WELL RECORD IS THE WHOLE POINT. Comparing lift methods is
 * meaningless if each method holds its own description of the well. The
 * four engine-backed methods are run against exactly the same
 * trajectory, fluid, inflow and completion, and the differences in the
 * answers are therefore differences between the METHODS.
 *
 * WHAT A DESIGN PASS HERE IS AND IS NOT. It is SCREENING GRADE. Every
 * method needs equipment chosen before it can be designed, and this
 * module chooses defaults from a short ladder rather than asking for
 * forty numbers. Those choices are REPORTED WITH THE ANSWER
 * (`equipment`), and every result carries a link to the studio that
 * designs the thing properly. What the pass is good for is telling you
 * which methods can work at all on this well, and what each would cost
 * in equipment.
 *
 * THE RATE TOLERANCE IS THE MOST IMPORTANT LINE IN THE FILE. A method
 * that designs cleanly but delivers a third of what was asked has NOT
 * solved the problem, and reporting it as workable would be the single
 * most misleading thing this advisor could do. `RATE_TOLERANCE`
 * (0.9) is the fraction of the target a design must reach to count as
 * ok; anything below it is a SHORTFALL with the achieved rate stated,
 * never a success.
 *
 * WHEN SCREENING AND DESIGN DISAGREE, THE DESIGN WINS. It solved the
 * well; the matrix applied a rule. `reconcile` surfaces the
 * disagreement rather than hiding it, and names which of the two is
 * being believed.
 *
 * WHAT IS INJECTED, AND WHY. The ESP, ROD PUMP and GAS LIFT design
 * chains are passed in as functions (`chain`). Those chains need a
 * multiphase traverse and a PVT stack that live in the consumer, and
 * this module's own content is the POLICY around them: which reference
 * stage to probe with, which motor frame to hang on the shaft load,
 * which rung of the rod ladder counts as the answer, what a refusal
 * means and how it is phrased. Injecting the chains is what makes that
 * policy checkable without judgement -- hand in a stub whose answers
 * are known and every branch is arithmetic. PLUNGER LIFT is NOT
 * injected: its whole chain (./plungerLift.js) is in this package, so
 * `designPlunger` runs end to end for real and is gated that way.
 *
 * UNITS. Field units throughout, as everywhere else in
 * engines/production. They are not converted internally and they are
 * not optional:
 *
 *   targetLiquidRateBpd   bbl/d of LIQUID at the door, oil plus water
 *                         (see decision 1 below: this module still
 *                         CONSUMES it as oil stb/d until Wave 2)
 *   wctPct                PER CENT, 0 to 100
 *   gorScfStb             scf/stb
 *   whp                   psia at the wellhead
 *   facility.injectionPsig   PSIG at the surface (the one gauge
 *                            pressure in the domain, because that is
 *                            how an injection manifold is read; it is
 *                            converted here and nowhere else)
 *   facility.injectionMscfd  Mscf/d
 *   depths                ft (tvd unless a name says md)
 *   shaft power           hp
 *
 * SEAMS FOUND ON EXTRACTION. 1 AND 4 ARE NOW OWNER DECISIONS.
 *
 *  1. ITEM 19, DECIDED 4 SEPTEMBER 2026: THE TARGET RATE MEANS LIQUID.
 *     The door parameter is `targetLiquidRateBpd`, oil plus water in
 *     bbl/d, which is what ./liftScreening.js always documented and
 *     what the shipped studio's one number is.
 *
 *     THIS MODULE STILL CONSUMES IT AS OIL. It compares the number
 *     against the inflow's OIL absolute open flow and hands it to every
 *     chain as the oil design rate, with the water cut supplied
 *     separately. Reconciling the two means deriving
 *     oil = liquid x (1 - water cut) at the door, and THAT MOVES EVERY
 *     PUBLISHED NUMBER this module produces: the ESP stage count and
 *     head, the gas lift operating point, which rung of the rod ladder
 *     is the answer, and the absolute open flow refusal threshold. It
 *     is therefore a WAVE 2 change with a golden refresh, and
 *     `oilDesignRate` below is the one place it lands. Wave 1 renamed
 *     the door and moved nothing.
 *
 *     Until Wave 2, a rate that reaches both modules is screened as
 *     liquid and designed as oil, which on a 70 per cent water cut well
 *     is the same number standing for three times the liquid.
 *
 *  2. `pickReferenceStage` IS CATALOG-ORDER DEPENDENT IN THE OVERLAP
 *     BANDS. The reference stage ranges overlap (1250-1450, 2200-3500,
 *     4000-5600 bbl/d), and `find` takes the FIRST covering stage,
 *     which is always the SMALLER housing. That is a defensible rule --
 *     a smaller housing fits more casing -- but it was not the stated
 *     one, and at the top of an overlap band it does NOT pick the
 *     nearest best-efficiency point: at 3500 bbl/d it returns the 540
 *     series (BEP 2500, 1000 bbl/d away) over the 562 series (BEP 4000,
 *     500 bbl/d away). Gated as it behaves; the rule is now stated.
 *
 *  3. `pickMotorFrame` CAN RETURN A FRAME THAT DOES NOT MEET ITS OWN
 *     RULE. The rule is "the smallest frame carrying the shaft load
 *     with 25 per cent headroom"; when no frame does, it falls back to
 *     the largest in the catalog and says nothing. Above about 320 hp
 *     of shaft the returned frame has less than the stated headroom,
 *     and above 400 hp it is outright overloaded. This is NOT silent
 *     downstream -- the ESP sizing chain raises its own overload
 *     warning, which this module passes through in `warnings` -- but
 *     the `equipment` string still reads as a clean pick. Behaviour
 *     preserved; the fallback is now stated.
 *
 *  4. ITEM 21, FIXED 4 SEPTEMBER 2026: THE ROD LOADING GUARD NO LONGER
 *     FAILS OPEN. It used to reject a trial only when the worst rod
 *     section ran over 100 per cent of its allowable, so a design that
 *     came back with NO worst section made the loading NaN, `NaN > 100`
 *     false, and the trial was accepted as workable with its loading
 *     PRINTED TO THE USER as "NaN % of Goodman". A guard that lets an
 *     unknown through as a pass is the trusting half of a disagreeing
 *     function. A rung is now accepted only when its loading was read
 *     and is at or under the allowable, `Number.isFinite(loading) &&
 *     loading <= 100`; anything else is a refused rung with its reason
 *     stated in `attempts`. On the golden scenario that turns on this,
 *     the answer moves from a reported success at 3000 bbl/d to the
 *     shortfall at 1100 the golden already carries as
 *     `resultIfUnknownLoadingWereAFailure`.
 *
 * VALIDATION NOTE. Gated against
 * tools/validation/production/oracle_liftadvisor.py through
 * test-data/production/goldens/lift_advisor_cases.json. The oracle is
 * written from the policy statement, not by transcribing this file: it
 * picks the reference stage by building the covering-interval SET and
 * the BEP-distance ranking separately (so the overlap ambiguity is
 * measured rather than inherited), picks the motor by MINIMISING hp
 * over the frames that satisfy the headroom inequality (equal to a
 * forward `find` only because the catalog happens to be hp-ascending,
 * which the oracle also asserts), walks the rod ladder as a
 * SELECTION OVER THE WHOLE SET rather than a first-match scan, derives
 * the gas-liquid ratio a plunger cycle sees from a mass balance rather
 * than from the expression here, and enumerates the reconciliation
 * verdict as a full four-way TRUTH TABLE so a missing branch cannot
 * hide.
 */
import { REFERENCE_STAGES, MOTOR_FRAMES } from './data/espCatalog.js';
import { screenPlungerLift } from './plungerLift.js';
import { linearTemperature } from './gasLiftDesign.js';
import { rateAtPwf } from './nodal.js';
import { LIFT_METHODS } from './liftScreening.js';

/** Numeric coercion with a fallback, matching the domain's convention. */
export const num = (v, fallback = 0) => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(x) ? x : fallback;
};

/** Standard atmosphere, the only place gauge meets absolute in here. */
export const ATM_PSIA = 14.7;
export const psigToPsia = (psig) => num(psig, NaN) + ATM_PSIA;

/**
 * Specific gravity of the LIQUID a positive-displacement pump lifts:
 * oil and water in the produced proportion, water taken as 1.0. Gas is
 * not in this, because what stands in the tubing above a rod pump is
 * liquid. Identical to the rod-pump chain's own definition; it is
 * restated here rather than injected because it is one line of
 * arithmetic and injecting it would make the policy harder to read, not
 * easier.
 */
export const liquidGravity = ({ api, wct }) => {
  const oilSg = 141.5 / (num(api, 32) + 131.5);
  return oilSg * (1 - wct) + 1.0 * wct;
};

/**
 * Measured depth at a true vertical depth, by linear interpolation in
 * the survey table. Off the bottom of the table it returns the deepest
 * station rather than extrapolating, because a trajectory says nothing
 * about hole that has not been drilled.
 */
export const mdAtTvd = (trajectory, tvdFt) => {
  const pts = trajectory?.points || [];
  if (pts.length === 0) return 0;
  if (!(tvdFt > 0)) return pts[0].md;
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i].tvd >= tvdFt) {
      const span = pts[i].tvd - pts[i - 1].tvd;
      if (!(span > 0)) return pts[i].md;
      const f = (tvdFt - pts[i - 1].tvd) / span;
      return pts[i - 1].md + f * (pts[i].md - pts[i - 1].md);
    }
  }
  return pts[pts.length - 1].md;
};

/** Small equipment ladders, so a screening-grade pass has something to
 *  try. Ascending in displacement (plunger area x stroke x speed), which
 *  is what makes "the first that meets the target" mean "the smallest
 *  that meets the target". */
export const ROD_TRIALS = [
  { plungerDIn: 1.25, strokeIn: 48, spm: 6 },
  { plungerDIn: 1.5, strokeIn: 54, spm: 7 },
  { plungerDIn: 1.75, strokeIn: 64, spm: 9 },
  { plungerDIn: 2.0, strokeIn: 74, spm: 10 },
  { plungerDIn: 2.25, strokeIn: 86, spm: 11 },
  { plungerDIn: 2.75, strokeIn: 120, spm: 12 },
];

/**
 * How close to the target a screening-grade design has to get to count.
 * A method that designs cleanly but delivers a third of what was asked
 * has not solved the problem.
 */
export const RATE_TOLERANCE = 0.9;

/**
 * ITEM 19, THE LIQUID TO OIL SEAM, AND THE ONE PLACE WAVE 2 CHANGES.
 *
 * The door takes `targetLiquidRateBpd`, oil plus water, because that is
 * what the owner decided the shared number means and what
 * ./liftScreening.js scores. Every design chain below wants the OIL
 * rate, with the water cut handed to it separately.
 *
 * WAVE 1 RETURNS THE RATE UNCHANGED, so not one number moved with the
 * rename. WAVE 2 makes this `targetLiquidRateBpd * (1 - wctPct / 100)`
 * and refreshes the goldens, which is why the water cut is already a
 * parameter here. Nothing else in this module reads the target rate
 * directly, so this function is the whole of the change.
 */
export const oilDesignRate = (targetLiquidRateBpd, wctPct) => {
  // ITEM 19, SECOND HALF. The rate at the door is LIQUID, which is what
  // the screening half has always read it as and what the parameter now
  // says. The design chains below consume it as OIL. On a 70 per cent
  // water cut well that is one number standing for three times the
  // liquid, and it reaches the ESP intake, the pump stages, the total
  // dynamic head, the shaft power, the motor frame, the cable, the gas
  // lift operating point and which rung of the rod ladder is the answer.
  //
  // A water cut that cannot be read is NOT a water cut of zero: an
  // absent one would silently design the whole well on liquid again,
  // which is the defect. It refuses by returning NaN, and the callers
  // hand that on as a refusal rather than designing on it.
  if (!Number.isFinite(targetLiquidRateBpd)) return NaN;
  if (!Number.isFinite(wctPct)) return NaN;
  const wct = Math.min(Math.max(wctPct, 0), 100);
  return targetLiquidRateBpd * (1 - wct / 100);
};

/**
 * The reference stage whose published range covers the duty, else the
 * nearest best-efficiency point. In an overlap band the FIRST covering
 * stage wins, which is always the smaller housing -- see seam 2 in the
 * module header.
 */
export const pickReferenceStage = (qBpd) => {
  // ITEM 22. Every stage whose published range covers the duty is a
  // candidate, and the one whose best efficiency point is nearest the
  // duty wins. `find` took the FIRST covering stage, which is always the
  // smaller housing because the catalogue is ordered by size, so at the
  // top of an overlap band it returned the stage the duty sits at the
  // very edge of: at 3,500 bbl/d the 540 series, BEP 2,500 and 1,000
  // bbl/d away, over the 562 series, BEP 4,000 and 500 bbl/d away. The
  // rule is the same one the out-of-range branch below has always used,
  // applied to the covering set instead of to the catalogue order.
  const covering = REFERENCE_STAGES.filter((s) => qBpd >= s.qMin && qBpd <= s.qMax);
  const pool = covering.length ? covering : REFERENCE_STAGES;
  return pool.reduce(
    (best, s) => (Math.abs(s.bepBpd - qBpd) < Math.abs(best.bepBpd - qBpd) ? s : best),
    pool[0],
  );
};

/**
 * The smallest motor frame that carries the shaft load with 25 per cent
 * headroom, or -- when none does -- the largest frame in the catalog,
 * which does NOT meet that rule. See seam 3 in the module header.
 */
export const MOTOR_HEADROOM = 1.25;

export const pickMotorFrame = (shaftHp) => {
  const hit = MOTOR_FRAMES.find((m) => m.hp >= shaftHp * MOTOR_HEADROOM);
  if (hit) return { ...hit, outOfRange: false };
  // ITEM 22. The fallback is the largest frame in the catalogue and it
  // does NOT meet the rule this function states. Above about 320 hp of
  // shaft it has less than the stated headroom and above 400 hp it is
  // outright overloaded, and the record it returned read exactly like a
  // clean pick. It carries `outOfRange` now, and every string built from
  // it says so.
  const largest = MOTOR_FRAMES[MOTOR_FRAMES.length - 1];
  return { ...largest, outOfRange: true };
};

const outcome = (id, extra) => {
  const method = LIFT_METHODS.find((m) => m.id === id);
  return { id, label: method.label, studio: method.studio, hasEngine: true, ...extra };
};

/** A refusal for a chain that was not supplied. Unreachable when all
 *  three chains are injected, which is how every shipped consumer runs
 *  it; present so a partial chain refuses instead of throwing. */
const noChain = (id, what) => outcome(id, {
  ok: false,
  reason: `No ${what} design chain was supplied to the advisor, so this method could not be designed on this well.`,
});

/**
 * ESP. Run the real sizing chain with a reference stage picked for the
 * duty, then a motor picked for the shaft load it produces.
 *
 * Three passes, and the reason is the circularity: the stage that suits
 * the duty cannot be chosen until the in-situ duty is known, and the
 * duty depends on the stage. The first pass PROBES with a mid-range
 * stage purely to learn the intake rate, the second sizes on the stage
 * that rate deserves, and the third re-runs with the motor that
 * second pass's shaft load calls for.
 */
export const designEsp = ({
  model, targetLiquidRateBpd, wctPct, gorScfStb, whp, facility, chain,
}) => {
  const runEspDesign = chain?.runEspDesign;
  if (!runEspDesign) return noChain('esp', 'ESP');
  const oilRateStbd = oilDesignRate(targetLiquidRateBpd, wctPct);
  const perfTvdFt = model.tvdMax;
  const pumpTvdFt = Math.round(perfTvdFt * 0.94);
  const baseForm = {
    designRateStbd: String(oilRateStbd),
    wctPct: String(wctPct),
    gorScfStb: String(gorScfStb),
    pumpTvdFt: String(pumpTvdFt),
    perfTvdFt: String(perfTvdFt),
    annulusGradPsiPerFt: '0.4',
    separatorEfficiencyPct: String(num(facility?.separatorEfficiencyPct, 70)),
    whp: String(whp),
    hz: '60',
    motorEfficiencyPct: '85',
    powerFactor: '0.85',
    cableLengthFt: String(Math.round(pumpTvdFt * 1.03)),
    cableTempF: '180',
    maxDropPct: '5',
    curveSource: 'reference',
    curveRefHz: '60',
    curveText: '',
    nameplateHp: '250',
    nameplateVolts: '2400',
    nameplateAmps: '67',
  };

  // A first pass to learn the in-situ duty, then the stage that suits it.
  const probe = runEspDesign({
    form: { ...baseForm, referenceStageId: 'ref-540-2500' }, model,
  });
  if (!probe.ok) {
    return outcome('esp', { ok: false, reason: probe.errors[0], errors: probe.errors });
  }
  const stage = pickReferenceStage(probe.design.duty.pumpIntakeBpd);
  const sized = runEspDesign({ form: { ...baseForm, referenceStageId: stage.id }, model });
  if (!sized.ok) {
    return outcome('esp', { ok: false, reason: sized.errors[0], errors: sized.errors });
  }
  const motor = pickMotorFrame(sized.design.sized.shaftHp);
  const final = runEspDesign({
    form: {
      ...baseForm,
      referenceStageId: stage.id,
      nameplateHp: String(motor.hp),
      nameplateVolts: String(motor.volts),
      nameplateAmps: String(motor.amps),
    },
    model,
  });
  if (!final.ok) {
    return outcome('esp', { ok: false, reason: final.errors[0], errors: final.errors });
  }
  const d = final.design;
  return outcome('esp', {
    ok: true,
    rateStbd: oilRateStbd,
    equipment: `${stage.label}, ${d.sized.stages} stages, ${motor.hp} hp motor`,
    figures: [
      { label: 'Stages', value: d.sized.stages },
      { label: 'Total dynamic head', value: `${Math.round(d.duty.tdhFt).toLocaleString()} ft` },
      { label: 'Intake pressure', value: `${Math.round(d.duty.intake.pipPsia).toLocaleString()} psia` },
      { label: 'Gas through the pump', value: `${(d.duty.intake.gas.gvfThroughPump * 100).toFixed(0)} %` },
      { label: 'Shaft power', value: `${d.sized.shaftHp.toFixed(1)} hp` },
      { label: 'Cable', value: d.electrical.cable ? d.electrical.cable.label : 'none qualifies' },
    ],
    warnings: motor.outOfRange
      ? [...d.warnings, {
        code: 'motorFrameOutOfRange',
        message: `No frame in this catalogue carries ${d.sized.shaftHp.toFixed(1)} hp of shaft with the ${(MOTOR_HEADROOM - 1) * 100} percent headroom the selection rule asks for, so the largest one, ${motor.hp} hp, was taken. It is a placeholder for a real nameplate, not a recommendation.`,
      }]
      : d.warnings,
    motorOutOfRange: motor.outOfRange,
    design: d,
  });
};

/**
 * Gas lift. Find the deepest point the available surface pressure can
 * reach, then solve the well lifted at that point.
 *
 * The order matters and is the method: the injection point is where the
 * casing gas pressure line crosses the flowing tubing gradient, so the
 * flowing gradient has to be built FIRST (at the target rate, fully
 * lifted) and the point read off it. Solving the node first and placing
 * the valve afterwards would place it against a gradient that no longer
 * exists.
 */
export const designGasLift = ({
  model, targetLiquidRateBpd, wctPct, gorScfStb, whp, facility, chain,
}) => {
  const { liftedTraverse, injectionPointFromTraverse, solveLiftedOperatingPoint } = chain || {};
  if (!liftedTraverse || !injectionPointFromTraverse || !solveLiftedOperatingPoint) {
    return noChain('gasLift', 'gas lift');
  }
  const oilRateStbd = oilDesignRate(targetLiquidRateBpd, wctPct);
  const operatingPsig = num(facility?.injectionPsig, 900);
  const qgiMscfd = num(facility?.injectionMscfd, 500);
  const vlp = {
    ...model.vlp,
    whp,
    rates: { wct: wctPct / 100, gor: gorScfStb },
  };

  let traverse;
  try {
    traverse = liftedTraverse({
      ...vlp, qo: oilRateStbd, injectionMd: vlp.nodeMd, qgiMscfd,
    });
  } catch (e) {
    return outcome('gasLift', { ok: false, reason: `The lifted traverse could not be built: ${e.message}` });
  }
  if (!traverse?.points?.length) {
    return outcome('gasLift', { ok: false, reason: 'The lifted traverse produced no points to place an injection point against.' });
  }

  const point = injectionPointFromTraverse({
    traversePoints: traverse.points,
    pSurfPsia: psigToPsia(operatingPsig),
    gasSg: num(facility?.injGasSg, 0.65),
    tempAtDepthF: linearTemperature({
      whtF: model.tAt(0), bhtF: model.tAt(model.tvdMax), refDepthFt: model.tvdMax,
    }),
    dpTransferPsi: 50,
    maxDepthFt: model.tvdMax,
  });
  if (!point || !(point.depthFt > 0)) {
    return outcome('gasLift', {
      ok: false,
      reason: `At ${operatingPsig} psig the injection line never gets below the flowing gradient, so there is nowhere to put gas in. More surface pressure, or a lighter design rate.`,
    });
  }

  const injectionMd = mdAtTvd(model.trajectory, point.depthFt);
  let lifted;
  try {
    lifted = solveLiftedOperatingPoint({
      ipr: model.ipr, vlp, injectionMd, qgiMscfd, nGrid: 25,
    });
  } catch (e) {
    return outcome('gasLift', { ok: false, reason: `The lifted operating point could not be solved: ${e.message}` });
  }
  // solveLiftedOperatingPoint reports { q, pwf, status }; a node that
  // never crossed comes back as status 'dead' with a zero rate.
  if (!lifted || lifted.status !== 'flowing' || !(lifted.q > 0)) {
    return outcome('gasLift', {
      ok: false,
      reason: `Injecting ${Math.round(qgiMscfd).toLocaleString()} Mscf/d at ${Math.round(point.depthFt).toLocaleString()} ft still does not lighten the column enough for this well to flow. More gas, more injection pressure to reach deeper, or a lower wellhead pressure.`,
    });
  }

  return outcome('gasLift', {
    ok: true,
    rateStbd: lifted.q,
    equipment: `${Math.round(qgiMscfd).toLocaleString()} Mscf/d injected at ${Math.round(point.depthFt).toLocaleString()} ft, ${operatingPsig} psig at surface`,
    figures: [
      { label: 'Rate lifted', value: `${Math.round(lifted.q).toLocaleString()} stb/d` },
      { label: 'Injection depth', value: `${Math.round(point.depthFt).toLocaleString()} ft` },
      { label: 'Injection rate', value: `${Math.round(qgiMscfd).toLocaleString()} Mscf/d` },
      { label: 'Flowing bottomhole', value: `${Math.round(lifted.pwf).toLocaleString()} psia` },
      {
        label: 'Limited by',
        value: point.limitedBy === 'depth' ? 'the packer or the traverse, not the pressure' : 'the available injection pressure',
      },
    ],
    warnings: [],
    design: { point, lifted, qgiMscfd, operatingPsig },
  });
};

/**
 * Rod pump. Walk the equipment ladder and take the SMALLEST rung that
 * MEETS the target, not the first that merely designs.
 *
 * A rung is discarded when the chain refuses it outright, when the
 * worst rod section runs over 100 per cent of its Goodman allowable, or
 * when that loading could not be read at all: a rung is kept only on
 * `Number.isFinite(loading) && loading <= 100`, so an unknown loading is
 * a refusal with its reason stated and never a silent pass (item 21,
 * seam 4 in the module header). Of the rungs that survive, the ones producing at
 * least RATE_TOLERANCE of the target are the answer and the first of
 * them is reported, because the ladder ascends in displacement. If none
 * reach the target, the rung that got CLOSEST is reported as a
 * SHORTFALL with its achieved rate, which is the honest statement that
 * rod pumping is rate-limited by the plunger it can swing at this
 * depth.
 */
export const designRodPump = ({
  model, targetLiquidRateBpd, wctPct, gorScfStb, whp, chain,
}) => {
  const runRodDesign = chain?.runRodDesign;
  if (!runRodDesign) return noChain('rodPump', 'rod pump');
  const oilRateStbd = oilDesignRate(targetLiquidRateBpd, wctPct);
  const perfTvdFt = model.tvdMax;
  const pumpTvdFt = Math.round(perfTvdFt * 0.96);
  const liquidSg = liquidGravity({ api: model.fluidModel?.api ?? 32, wct: wctPct / 100 });
  const attempts = [];
  const workable = [];

  for (const trial of ROD_TRIALS) {
    const form = {
      designRateStbd: String(oilRateStbd),
      wctPct: String(wctPct),
      whp: String(whp),
      pumpTvdFt: String(pumpTvdFt),
      annulusGradPsiPerFt: '0.38',
      separatorEfficiencyPct: '60',
      pumpEfficiencyPct: '90',
      strokeIn: String(trial.strokeIn),
      spm: String(trial.spm),
      plungerDIn: String(trial.plungerDIn),
      unitSource: 'generic',
      unitDesignation: '',
      structuralUnbalanceLb: '0',
      crankOffsetDeg: '0',
      dampingRatio: '0.1',
      gradeId: 'D',
      serviceFactor: '1',
      // A taper proportioned for the depth, heaviest at the top.
      sectionsText: `7/8, ${Math.round(pumpTvdFt * 0.55)}\n3/4, ${pumpTvdFt - Math.round(pumpTvdFt * 0.55)}`,
      api: String(model.fluidModel?.api ?? 32),
      gorScfStb: String(gorScfStb),
    };
    const res = runRodDesign({ form, model });
    if (!res.ok) {
      attempts.push({ trial, reason: res.errors[0] });
      continue;
    }
    const d = res.design;
    const loading = d.worstSection ? d.worstSection.loadingPct : NaN;
    // ITEM 21. A guard that cannot evaluate its condition refuses. This
    // used to be `loading > 100`, which is FALSE for a NaN, so a design
    // whose rod loading could not be read was accepted as workable and
    // its loading printed to the user as "NaN % of Goodman". A rung is
    // now kept only when the loading was read AND is at or under the
    // allowable, and nothing unreadable reaches a formatter.
    if (!Number.isFinite(loading)) {
      attempts.push({
        trial,
        reason: d.worstSection
          ? `the rod loading came back as ${d.worstSection.loadingPct}, which is not a number, so the rods could not be checked against their allowable`
          : 'the design came back with no worst rod section, so there is no rod loading to check against the allowable',
      });
      continue;
    }
    if (loading > 100) {
      // Fires strictly above 100, so the rejected trial has to print
      // above 100: rounded whole, 100.3 read as a trial thrown out for
      // running at exactly its allowable.
      attempts.push({ trial, reason: `the ${d.worstSection.label} rods run at ${loading.toFixed(1)} percent of their allowable` });
      continue;
    }
    workable.push({ trial, design: d, loading });
  }

  // The smallest workable unit that MEETS the target, or failing that
  // the one that gets closest to it. Taking the first that merely
  // designs would report a third of the asked-for rate as a success.
  const meets = workable.filter((x) => x.design.producedBpd >= oilRateStbd * RATE_TOLERANCE);
  const best = meets.length
    ? meets[0]
    : workable.reduce(
      (a, x) => (!a || x.design.producedBpd > a.design.producedBpd ? x : a),
      null,
    );

  if (best && meets.length) {
    const { trial, design: d, loading } = best;
    return outcome('rodPump', {
      ok: true,
      rateStbd: d.producedBpd,
      equipment: `${trial.plungerDIn} in plunger, ${trial.strokeIn} in stroke at ${trial.spm} spm, ${liquidSg.toFixed(2)} gravity liquid`,
      figures: [
        { label: 'Production', value: `${d.producedBpd.toFixed(0)} bbl/d` },
        { label: 'Plunger stroke', value: `${d.plungerStrokeIn.toFixed(1)} in of ${trial.strokeIn}` },
        { label: 'Peak rod load', value: `${Math.round(d.pprlLb).toLocaleString()} lb` },
        { label: 'Peak torque', value: d.balance ? `${Math.round(d.balance.peakTorqueInLb).toLocaleString()} in-lb` : '--' },
        // One decimal, the same precision the rejection reason states it
        // at, and reachable only for a loading the guard above has read.
        { label: 'Rod loading', value: `${loading.toFixed(1)} % of Goodman` },
        { label: 'Barrel fillage', value: `${(d.gas.fillage * 100).toFixed(0)} %` },
      ],
      warnings: d.warnings,
      design: d,
      attempts,
      triedCount: ROD_TRIALS.length,
    });
  }

  if (best) {
    return outcome('rodPump', {
      ok: false,
      reason: `The largest unit tried (${best.trial.plungerDIn} in plunger, ${best.trial.strokeIn} in stroke at ${best.trial.spm} spm) makes ${best.design.producedBpd.toFixed(0)} bbl/d against a target of ${Math.round(oilRateStbd).toLocaleString()}. Rod pumping is rate-limited by the plunger it can swing at this depth, and this well is past it.`,
      shortfall: { achievedBpd: best.design.producedBpd, targetBpd: oilRateStbd },
      design: best.design,
      attempts,
      triedCount: ROD_TRIALS.length,
    });
  }

  return outcome('rodPump', {
    ok: false,
    reason: attempts.length
      ? `None of the ${attempts.length} equipment combinations tried works. The last failed because ${attempts[attempts.length - 1].reason}.`
      : 'No equipment combination could be designed for this well.',
    attempts,
    triedCount: ROD_TRIALS.length,
  });
};

/**
 * The gas-liquid ratio a plunger cycle actually has to work with, from
 * the oil rate, the gas-oil ratio and the water cut.
 *
 * A plunger is driven by gas and lifts LIQUID, so the ratio that
 * matters is gas per barrel of liquid, not gas per barrel of oil. With
 * gas = GOR x oil and liquid = oil / (1 - wc), the ratio reduces to
 * GOR x (1 - wc): every point of water cut is gas the cycle no longer
 * has per barrel it must lift. The water cut is clamped just under 1
 * because at exactly 1 there is no oil to carry the gas and the ratio
 * is not defined.
 */
export const plungerWellGlr = ({ targetLiquidRateBpd, gorScfStb, wctPct }) => {
  // The water cut is clamped just under one here, because at exactly one
  // there is no oil to carry the gas and the ratio is not defined. The
  // derivation is taken at the SAME clamped figure, so the liquid the
  // cycle sees is the rate that came in at every water cut including
  // 100 per cent.
  const wctFrac = Math.min(Math.max(wctPct / 100, 0), 0.999);
  const oilRateStbd = oilDesignRate(targetLiquidRateBpd, wctFrac * 100);
  const liquidBpd = wctFrac > 0 ? oilRateStbd / (1 - wctFrac) : oilRateStbd;
  return {
    wctFrac,
    liquidBpd,
    glrScfBbl: liquidBpd > 0 ? (gorScfStb * oilRateStbd) / liquidBpd : gorScfStb,
  };
};

/**
 * Plunger lift. The gas-liquid ratio the well makes against the ratio a
 * cycle actually needs, which is COMPUTED (./plungerLift.js) rather
 * than screened. This is the one method whose whole chain lives in this
 * package, so nothing is injected and the pass runs end to end.
 */
export const designPlunger = ({
  model, targetLiquidRateBpd, wctPct, gorScfStb, whp, facility,
}) => {
  const depthFt = model.tvdMax;
  const liquidSg = liquidGravity({ api: model.fluidModel?.api ?? 32, wct: wctPct / 100 });
  const { glrScfBbl: wellGlr } = plungerWellGlr({ targetLiquidRateBpd, gorScfStb, wctPct });

  const res = screenPlungerLift({
    depthFt,
    idIn: model.vlp.idIn,
    linePressurePsia: whp,
    casingPressurePsia: num(facility?.casingPressurePsia, whp * 2.5),
    slugLengthFt: num(facility?.slugLengthFt, 150),
    liquidSg,
    plungerWeightLb: num(facility?.plungerWeightLb, 6),
    gasSg: model.fluidModel?.gasSg ?? 0.65,
    avgTempR: (model.tAt(0) + model.tAt(depthFt)) / 2 + 460,
    z: 0.9,
    wellGlrScfBbl: wellGlr,
    afterflowMin: 20,
    shutInMin: 30,
  });
  if (!res.ok) {
    return outcome('plunger', { ok: false, reason: res.errors[0], errors: res.errors });
  }
  const d = res.design;
  if (!d.feasible) {
    const why = d.warnings.map((w) => w.message).join(' ');
    return outcome('plunger', { ok: false, reason: why, design: d, warnings: d.warnings });
  }
  return outcome('plunger', {
    ok: true,
    rateStbd: d.liquidPerDayBbl,
    equipment: `${Math.round(num(facility?.slugLengthFt, 150))} ft slug, ${Math.round(d.timing.cyclesPerDay)} trips a day`,
    figures: [
      { label: 'Liquid lifted', value: `${d.liquidPerDayBbl.toFixed(1)} bbl/d` },
      { label: 'Gas-liquid ratio needed', value: `${Math.round(d.requiredGlrScfBbl).toLocaleString()} scf/bbl` },
      { label: 'This well makes', value: `${Math.round(wellGlr).toLocaleString()} scf/bbl` },
      { label: 'Pressure to lift', value: `${Math.round(d.lift.requiredPsia).toLocaleString()} psia` },
      { label: 'Cycle', value: `${d.timing.totalMin.toFixed(0)} min` },
    ],
    warnings: d.warnings,
    design: d,
  });
};

const DESIGNERS = {
  esp: designEsp,
  gasLift: designGasLift,
  rodPump: designRodPump,
  plunger: designPlunger,
};

/**
 * Run every engine-backed method against one well.
 *
 * returns { ok, results: [...], errors }
 * Methods without an engine are not here at all: they belong to the
 * screening layer and the advisor keeps the two apart on purpose.
 *
 * Two refusals come BEFORE any design runs, because both mean no method
 * could succeed and running four chains to say so would be theatre: a
 * gas-well record (this pass designs lift for an OIL well), and a
 * target at or above the inflow's absolute open flow (no lift method
 * makes a well produce more than it can deliver).
 */
export const runDesignPass = ({
  model, targetLiquidRateBpd, wctPct, gorScfStb, whp, facility, chain,
}) => {
  if (!model) return { ok: false, results: [], errors: ['The well model is incomplete.'] };
  if (model.phase !== 'oil') {
    return {
      ok: false,
      results: [],
      errors: ['This pass designs lift for an oil well. The well record says gas; the Gas Well Performance Studio is where a gas well is worked.'],
    };
  }
  const qMax = model.ipr.qmax ?? rateAtPwf(model.ipr, 0);
  const oilRateStbd = oilDesignRate(targetLiquidRateBpd, wctPct);
  if (!(oilRateStbd > 0)) {
    return { ok: false, results: [], errors: ['A target rate is needed before anything can be designed.'] };
  }
  if (oilRateStbd >= qMax) {
    return {
      ok: false,
      results: [],
      errors: [`The target of ${Math.round(oilRateStbd).toLocaleString()} stb/d is at or above this inflow's absolute open flow (${Math.round(qMax).toLocaleString()} stb/d). No lift method makes a well produce more than it can deliver.`],
    };
  }

  const args = { model, targetLiquidRateBpd, wctPct, gorScfStb, whp, facility, chain };
  const results = Object.keys(DESIGNERS).map((id) => {
    try {
      return DESIGNERS[id](args);
    } catch (e) {
      const method = LIFT_METHODS.find((m) => m.id === id);
      return {
        id, label: method.label, studio: method.studio, hasEngine: true,
        ok: false, reason: `The design chain failed: ${e.message}`,
      };
    }
  });
  return { ok: true, results, errors: [] };
};

/**
 * Put the screening and the design side by side, and say where they
 * disagree.
 *
 * The disagreement is the interesting output. A method the matrix likes
 * that the engine refuses is a rule of thumb meeting a well it does not
 * fit; a method the matrix is lukewarm about that designs cleanly is
 * worth a second look. In both cases THE DESIGN is the one that solved
 * the well, and `ranked` says so structurally: anything with a working
 * design outranks anything without one, whatever the scores.
 */
export const reconcile = ({ screening, designPass }) => {
  const byId = new Map((designPass?.results || []).map((r) => [r.id, r]));
  const rows = (screening || []).map((s) => {
    const design = byId.get(s.id) || null;
    let verdict = 'screened';
    let note = null;
    if (!s.hasEngine) {
      verdict = 'noEngine';
      note = 'Screened only. This Suite has no validated engine for this method, so nothing here is a design.';
    } else if (!design) {
      verdict = 'notRun';
    } else if (design.ok && s.recommended) {
      verdict = 'agreeYes';
      note = 'The screening and the design agree: this method works on this well.';
    } else if (design.ok && !s.recommended) {
      verdict = 'designYes';
      note = 'The screening was lukewarm but the design runs cleanly. The design solved the well; the matrix applied a rule.';
    } else if (!design.ok && s.recommended) {
      verdict = 'designNo';
      note = 'The screening liked this method and the design refuses it. The design is the one that solved the well.';
    } else {
      verdict = 'agreeNo';
      note = 'Screening and design agree that this method does not suit this well.';
    }
    return { ...s, design, verdict, note };
  });

  const workable = rows.filter((r) => r.design?.ok);
  return {
    rows,
    workable,
    disagreements: rows.filter((r) => r.verdict === 'designYes' || r.verdict === 'designNo'),
    // Ranked by what the design actually achieved, then by the score,
    // because a method that demonstrably works outranks one that merely
    // scores well.
    ranked: [...rows].sort((a, b) => {
      const ao = a.design?.ok ? 1 : 0;
      const bo = b.design?.ok ? 1 : 0;
      if (ao !== bo) return bo - ao;
      return b.score - a.score;
    }),
  };
};
