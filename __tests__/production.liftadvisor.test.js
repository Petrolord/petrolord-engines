/**
 * Artificial lift advisor gates.
 *
 * What is gated here is POLICY: which reference stage to probe with,
 * which motor frame to hang on a shaft load, which rung of the rod
 * ladder counts as the answer, what a refusal means, and how a
 * screening opinion is reconciled against a design. The ESP, rod pump
 * and gas lift chains are INJECTED as stubs whose answers are known, so
 * every branch is arithmetic; the plunger chain lives in this package
 * and is run for real.
 *
 * The oracle (tools/validation/production/oracle_liftadvisor.py) takes
 * the reference stage as a covering SET plus a separate BEP ranking,
 * the motor by MINIMISING over the satisfying set, the rod rung by a
 * SET SELECTION over all six rungs at once, the plunger gas-liquid
 * ratio from a MASS BALANCE, and the reconciliation as a full four-way
 * TRUTH TABLE.
 *
 * THREE FINDINGS ARE GATED AS BEHAVIOUR, NOT AS CORRECTNESS.
 *   - the reference-stage ranges OVERLAP and the pick is decided by
 *     catalog order inside them, which above 3250 bbl/d is not the
 *     nearest best-efficiency point;
 *   - the motor pick falls back to the largest frame in the catalog
 *     above 320 hp of shaft, which does not meet its own headroom rule,
 *     and is outright overloaded above 400;
 *   - the reference-stage and motor-frame findings above are still
 *     BEHAVIOUR, gated as they behave.
 *
 * THE THIRD FINDING IS NOW FIXED. The rod loading guard used to FAIL
 * OPEN on an unknown loading, which on the golden scenario turned a
 * shortfall at 1100 bbl/d into a reported success at 3000 with its
 * loading printed to the user as "NaN % of Goodman". Item 21 makes the
 * guard refuse what it cannot read, so the ladder is now walked against
 * the golden's own `resultIfUnknownLoadingWereAFailure`, which it
 * carries for every case and which differs from `result` on exactly the
 * one scenario the finding was about. No golden value was touched.
 */
import fs from 'fs';
import path from 'path';
import {
  ROD_TRIALS, RATE_TOLERANCE, ATM_PSIA, psigToPsia, num, liquidGravity,
  mdAtTvd, pickReferenceStage, pickMotorFrame, plungerWellGlr,
  designEsp, designGasLift, designRodPump, designPlunger,
  runDesignPass, reconcile, oilDesignRate,
} from '../engines/production/liftAdvisor';
import { REFERENCE_STAGES, MOTOR_FRAMES } from '../engines/production/data/espCatalog';
import { screenPlungerLift } from '../engines/production/plungerLift';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'lift_advisor_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

/** A well record in the shape every designer reads. */
const makeModel = (over = {}) => ({
  phase: 'oil',
  tvdMax: 7000,
  tAt: (tvd) => 90 + (210 - 90) * (tvd / 7000),
  trajectory: { points: G.mdAtTvd.trajectory, mdMax: 11000 },
  vlp: { idIn: 2.441, nodeMd: 7000, whp: 200 },
  fluidModel: { api: 32, gor: 400, gasSg: 0.65 },
  ipr: { qmax: 3000 },
  ...over,
});

// ---------------------------------------------------------------------------

describe('the catalogs the policy picks out of', () => {
  test('are the ones the goldens were cut against', () => {
    expect(REFERENCE_STAGES.map((s) => s.id)).toEqual(G.catalog.referenceStages.map((s) => s.id));
    REFERENCE_STAGES.forEach((s, i) => {
      expect(s.qMin).toBe(G.catalog.referenceStages[i].qMin);
      expect(s.qMax).toBe(G.catalog.referenceStages[i].qMax);
      expect(s.bepBpd).toBe(G.catalog.referenceStages[i].bepBpd);
    });
    expect(MOTOR_FRAMES.map((m) => m.hp)).toEqual(G.catalog.motorFrames.map((m) => m.hp));
  });

  test('THE MOTOR CATALOG IS HP-ASCENDING, which is the only reason a forward find is a minimum', () => {
    expect(G.catalog.motorCatalogIsHpAscending).toBe(true);
    for (let i = 1; i < MOTOR_FRAMES.length; i += 1) {
      expect(MOTOR_FRAMES[i].hp).toBeGreaterThan(MOTOR_FRAMES[i - 1].hp);
    }
  });

  test('THE ROD LADDER ASCENDS IN DISPLACEMENT, which is what makes "the first that meets" mean "the smallest"', () => {
    expect(G.catalog.rodLadderIsAscending).toBe(true);
    expect(ROD_TRIALS).toHaveLength(G.catalog.rodTrials.length);
    const disp = ROD_TRIALS.map((t) => (Math.PI / 4) * t.plungerDIn ** 2 * t.strokeIn * t.spm);
    disp.forEach((v, i) => expect(rel(v, G.catalog.rodDisplacements[i])).toBeLessThan(1e-12));
    for (let i = 1; i < disp.length; i += 1) expect(disp[i]).toBeGreaterThan(disp[i - 1]);
    expect(RATE_TOLERANCE).toBe(G.catalog.rateTolerance);
  });
});

describe('picking a reference stage for the duty', () => {
  test('matches the covering-set-then-nearest-BEP construction over a sweep', () => {
    G.referenceStage.sweep.forEach((c) => {
      expect(pickReferenceStage(c.q).id).toBe(c.picked);
    });
  });

  test('outside every published range it falls back to the nearest best-efficiency point', () => {
    G.referenceStage.sweep.filter((c) => c.coveringSet.length === 0).forEach((c) => {
      expect(pickReferenceStage(c.q).id).toBe(c.bepRanking[0]);
    });
    expect(pickReferenceStage(100).id).toBe('ref-400-1000');
    expect(pickReferenceStage(50000).id).toBe('ref-675-7000');
  });

  // ITEM 22. The ranges overlap, and inside an overlap the pick used to
  // be decided by catalogue ORDER, which is always the smaller housing.
  // The rule is now the nearest best-efficiency point among the stages
  // that cover the duty, which is the rule the out-of-range branch has
  // always used.
  test('inside an overlap band the nearest best-efficiency point wins, not the catalogue order', () => {
    expect(G.referenceStage.overlapBands).toHaveLength(3);
    G.referenceStage.overlapBands.forEach((b) => {
      expect(pickReferenceStage(b.from).id).toBe(b.picked);
      expect(pickReferenceStage(b.to).id).toBe(b.pickedAtTop);
      // the pick MOVES across a band now, where catalogue order held it
      // on the smaller housing all the way up
      expect(b.pickedByCatalogOrder).toBe(b.stages[0]);
    });
    // the rule holds over the whole sweep: the pick is the nearest BEP
    // among the stages that COVER the duty
    G.referenceStage.sweep.forEach((c) => {
      expect(pickReferenceStage(c.q).id).toBe(c.nearestBepInCoveringSet);
      expect(c.pickedIsNearestInCoveringSet).toBe(true);
    });
    // one duty in the sweep is covered by a stage that is NOT the
    // nearest in the whole catalogue, and that is correct: a stage
    // cannot be run outside its published range
    const notGlobal = G.referenceStage.sweep.filter((c) => !c.pickedIsNearestBep);
    expect(notGlobal.map((c) => c.q)).toEqual([1451]);
    expect(notGlobal[0].coveringSet).toEqual(['ref-540-2500']);
    // the case the finding was written about: 3,500 bbl/d is 1,000 from
    // the 540 series and 500 from the 562
    expect(pickReferenceStage(3500).id).toBe('ref-562-4000');
    expect(pickReferenceStage(3500).bepBpd).toBe(4000);
    const nearest = REFERENCE_STAGES.reduce(
      (a, s) => (Math.abs(s.bepBpd - 3500) < Math.abs(a.bepBpd - 3500) ? s : a),
    );
    expect(nearest.id).toBe('ref-562-4000');
  });
});

describe('picking a motor frame for the shaft load', () => {
  test('is the smallest frame with 25 per cent headroom, over the whole sweep', () => {
    G.motorFrame.sweep.forEach((c) => {
      expect(pickMotorFrame(c.shaftHp).hp).toBe(c.hp);
      expect(pickMotorFrame(c.shaftHp).id).toBe(c.id);
    });
  });

  test('the headroom rule is really 1.25, and it is applied at the boundary', () => {
    // 48 hp x 1.25 = 60 exactly, so the 60 hp frame qualifies.
    expect(pickMotorFrame(48).hp).toBe(60);
    expect(pickMotorFrame(48.1).hp).toBe(100);
  });

  test('FINDING: above 320 hp of shaft it returns a frame that does NOT meet its own rule', () => {
    expect(G.motorFrame.headroomLostAboveShaftHp).toBe(320);
    expect(pickMotorFrame(320).hp).toBe(400);
    expect(pickMotorFrame(321).hp).toBe(400);
    G.motorFrame.sweep.filter((c) => !c.meetsHeadroom).forEach((c) => {
      const m = pickMotorFrame(c.shaftHp);
      expect(m.hp).toBe(MOTOR_FRAMES[MOTOR_FRAMES.length - 1].hp);
      expect(m.hp).toBeLessThan(c.shaftHp * 1.25);
    });
  });

  test('and above 400 hp the returned motor is outright overloaded', () => {
    const overloaded = G.motorFrame.sweep.filter((c) => c.overloaded);
    expect(overloaded.map((c) => c.shaftHp)).toEqual([401, 500]);
    overloaded.forEach((c) => expect(pickMotorFrame(c.shaftHp).hp).toBeLessThan(c.shaftHp));
  });
});

describe('the small closed forms', () => {
  test('liquid gravity is oil and water in the produced proportion', () => {
    G.liquidGravity.forEach((c) => {
      expect(rel(liquidGravity({ api: c.api, wct: c.wct }), c.sg)).toBeLessThan(1e-12);
    });
    expect(liquidGravity({ api: 10, wct: 0 })).toBeCloseTo(1, 12); // 10 API is water
    expect(liquidGravity({ api: 32, wct: 1 })).toBe(1);
  });

  test('measured depth at a true vertical depth is the linear interpolant, and does not extrapolate', () => {
    G.mdAtTvd.cases.forEach((c) => {
      expect(rel(mdAtTvd({ points: G.mdAtTvd.trajectory }, c.tvd) || 1, c.md || 1))
        .toBeLessThan(1e-12);
    });
    // below the deepest station the deepest measured depth comes back
    expect(mdAtTvd({ points: G.mdAtTvd.trajectory }, 9000)).toBe(11000);
    expect(mdAtTvd({ points: [] }, 4000)).toBe(G.mdAtTvd.emptyTrajectoryMd);
    expect(mdAtTvd(null, 4000)).toBe(0);
  });

  test('psig meets psia in exactly one place, and it is the standard atmosphere', () => {
    expect(ATM_PSIA).toBe(14.7);
    expect(psigToPsia(900)).toBeCloseTo(914.7, 12);
    expect(num('12.5', 0)).toBe(12.5);
    expect(num(undefined, 7)).toBe(7);
  });
});

describe('the gas-liquid ratio a plunger cycle actually sees', () => {
  test('is GOR x (1 - water cut), by mass balance', () => {
    G.plungerGlr.forEach((c) => {
      const got = plungerWellGlr({
        targetLiquidRateBpd: c.targetRate, gorScfStb: c.gorScfStb, wctPct: c.wctPct,
      });
      expect(rel(got.glrScfBbl, c.glrScfBbl)).toBeLessThan(1e-9);
      expect(rel(got.glrScfBbl, c.glrByRatio)).toBeLessThan(1e-12);
      expect(rel(got.liquidBpd || 1, c.liquidBpd || 1)).toBeLessThan(1e-12);
      expect(got.wctFrac).toBeCloseTo(c.wctFrac, 12);
      // item 19: the liquid the cycle sees IS the rate that came in
      expect(rel(got.liquidBpd || 1, c.targetRate || 1)).toBeLessThan(1e-12);
    });
  });

  test('every point of water cut is gas the cycle no longer has per barrel it must lift', () => {
    const dry = plungerWellGlr({ targetLiquidRateBpd: 100, gorScfStb: 3000, wctPct: 0 });
    const wet = plungerWellGlr({ targetLiquidRateBpd: 100, gorScfStb: 3000, wctPct: 90 });
    expect(dry.glrScfBbl).toBe(3000);
    expect(wet.glrScfBbl).toBeCloseTo(300, 9);
  });

  test('the water cut is clamped just under one, so the ratio stays defined', () => {
    const all = plungerWellGlr({ targetLiquidRateBpd: 100, gorScfStb: 3000, wctPct: 100 });
    expect(all.wctFrac).toBe(0.999);
    expect(Number.isFinite(all.glrScfBbl)).toBe(true);
    const negative = plungerWellGlr({ targetLiquidRateBpd: 100, gorScfStb: 3000, wctPct: -10 });
    expect(negative.wctFrac).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The rod ladder
// ---------------------------------------------------------------------------

/** A chain that answers from a scenario table, keyed on the trial. */
const ladderChain = (outcomes) => ({
  runRodDesign: ({ form }) => {
    const i = ROD_TRIALS.findIndex((t) => String(t.plungerDIn) === form.plungerDIn);
    const o = outcomes[i];
    if (o.refused) return { ok: false, errors: [o.refused] };
    const design = {
      producedBpd: o.producedBpd,
      plungerStrokeIn: Number(form.strokeIn) * 0.9,
      pprlLb: 12000,
      balance: { peakTorqueInLb: 320000 },
      gas: { fillage: 0.85 },
      warnings: [],
    };
    // An outcome with no loading is a design with NO worst section,
    // which is the whole of the fails-open finding.
    if (o.loadingPct !== null) {
      design.worstSection = { loadingPct: o.loadingPct, label: '7/8 in' };
    }
    return { ok: true, errors: [], design };
  },
});

describe('walking the rod ladder', () => {
  test.each(G.rodLadder.map((s) => [s.id, s]))('%s', (_id, s) => {
    const out = designRodPump({
      model: makeModel(), targetLiquidRateBpd: s.target, wctPct: 40, gorScfStb: 300, whp: 150,
      chain: ladderChain(s.outcomes),
    });
    // ITEM 21: an unreadable loading is a refused rung, so the golden's
    // second column is the one the engine must now reproduce. For six of
    // the seven scenarios the two columns are identical.
    const g = s.resultIfUnknownLoadingWereAFailure;
    if (s.id !== 'loadingUnknownFailsOpen') expect(g).toEqual(s.result);
    expect(out.ok).toBe(g.ok);
    if (g.ok) {
      expect(rel(out.rateStbd, g.producedBpd)).toBeLessThan(1e-12);
      expect(out.equipment).toContain(`${ROD_TRIALS[g.index].plungerDIn} in plunger`);
      expect(out.equipment).toContain(`${ROD_TRIALS[g.index].strokeIn} in stroke`);
    } else if (g.shortfall) {
      expect(out.shortfall.achievedBpd).toBeCloseTo(g.producedBpd, 9);
      expect(out.shortfall.targetBpd).toBe(g.targetBpd);
      expect(out.reason).toMatch(/rate-limited by the plunger/);
    } else {
      expect(out.reason).toBeTruthy();
      expect(out.shortfall).toBeUndefined();
    }
    expect(out.attempts).toHaveLength(g.attempts);
    expect(out.triedCount).toBe(ROD_TRIALS.length);
    expect(s.why.length).toBeGreaterThan(40);
  });

  test('a design that MISSES the target is a shortfall, never a success', () => {
    const s = G.rodLadder.find((x) => x.id === 'shortfall');
    const out = designRodPump({
      model: makeModel(), targetLiquidRateBpd: s.target, wctPct: s.wctPct,
      gorScfStb: 300, whp: 150, chain: ladderChain(s.outcomes),
    });
    expect(out.ok).toBe(false);
    expect(out.shortfall.achievedBpd).toBe(1100);
    // the ladder is walked against the OIL rate now (item 19)
    expect(s.oilTargetBpd).toBeCloseTo(s.target * 0.6, 9);
    expect(out.shortfall.achievedBpd / s.oilTargetBpd).toBeLessThan(RATE_TOLERANCE);
  });

  test('the smallest unit that MEETS the target wins, not the first that designs', () => {
    const s = G.rodLadder.find((x) => x.id === 'firstThatDesignsIsNotTheAnswer');
    const out = designRodPump({
      model: makeModel(), targetLiquidRateBpd: s.target, wctPct: s.wctPct,
      gorScfStb: 300, whp: 150, chain: ladderChain(s.outcomes),
    });
    // ITEM 19. 300 bbl/d of LIQUID at 40 per cent water cut is 180 stb/d
    // of oil, so the answer is the rung making 200, not the 290 that
    // answered when the liquid rate was designed on as oil.
    expect(out.rateStbd).toBe(200);
    expect(s.result.index).toBe(2);
    expect(s.resultAtLiquidTarget.producedBpd).toBe(290);
    expect(out.rateStbd / s.oilTargetBpd).toBeGreaterThanOrEqual(RATE_TOLERANCE);
  });

  test('ITEM 21: an unreadable rod loading is REFUSED, not accepted', () => {
    const s = G.rodLadder.find((x) => x.id === 'loadingUnknownFailsOpen');
    const out = designRodPump({
      model: makeModel(), targetLiquidRateBpd: s.target, wctPct: s.wctPct,
      gorScfStb: 300, whp: 150, chain: ladderChain(s.outcomes),
    });
    // The rung whose design came back with NO worst rod section used to
    // be accepted as the answer at 3000 bbl/d, with its loading printed
    // as NaN. It is now a refused rung, and the honest answer is the
    // shortfall the golden already carried as the alternative.
    const alt = s.resultIfUnknownLoadingWereAFailure;
    expect(alt.ok).toBe(false);
    expect(alt.shortfall).toBe(true);
    expect(alt.producedBpd).toBe(1100);
    expect(out.ok).toBe(false);
    expect(out.shortfall.achievedBpd).toBe(alt.producedBpd);
    expect(out.shortfall.targetBpd).toBe(alt.targetBpd);
    expect(out.attempts).toHaveLength(alt.attempts);
    // The old answer is gone, and so is the string it printed.
    expect(out.rateStbd).toBeUndefined();
    expect(out.figures).toBeUndefined();
    expect(s.result.ok).toBe(true);
    expect(s.result.producedBpd).toBe(3000);
  });

  test('ITEM 21: the refused rung says WHY it could not be checked', () => {
    const s = G.rodLadder.find((x) => x.id === 'loadingUnknownFailsOpen');
    const out = designRodPump({
      model: makeModel(), targetLiquidRateBpd: s.target, wctPct: 40, gorScfStb: 300, whp: 150,
      chain: ladderChain(s.outcomes),
    });
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0].reason)
      .toBe('the design came back with no worst rod section, so there is no rod loading to check against the allowable');
    expect(out.attempts[0].trial).toEqual(ROD_TRIALS[5]);
    expect(out.attempts[0].reason).not.toMatch(/NaN/);
    expect(out.attempts[0].reason).not.toMatch(/--|\u2014|\u2013/);
  });

  test('ITEM 21: a loading that is present but not a number is refused too', () => {
    const withLoading = (loadingPct) => designRodPump({
      model: makeModel(), targetLiquidRateBpd: 100, wctPct: 40, gorScfStb: 300, whp: 150,
      chain: {
        runRodDesign: () => ({
          ok: true,
          errors: [],
          design: {
            producedBpd: 500,
            plungerStrokeIn: 50,
            pprlLb: 12000,
            balance: { peakTorqueInLb: 320000 },
            gas: { fillage: 0.85 },
            warnings: [],
            worstSection: { loadingPct, label: '7/8 in' },
          },
        }),
      },
    });
    ['not a number', undefined, null, NaN, Infinity].forEach((bad) => {
      const out = withLoading(bad);
      expect(out.ok).toBe(false);
      expect(out.attempts).toHaveLength(ROD_TRIALS.length);
      expect(out.attempts[0].reason).toMatch(/is not a number, so the rods could not be checked/);
    });
    // And a loading that IS a number still designs, exactly as before.
    const good = withLoading(88);
    expect(good.ok).toBe(true);
    expect(good.rateStbd).toBe(500);
  });

  test('ITEM 21: nothing unreadable ever reaches the loading formatter', () => {
    const out = designRodPump({
      model: makeModel(), targetLiquidRateBpd: 100, wctPct: 40, gorScfStb: 300, whp: 150,
      chain: {
        runRodDesign: () => ({
          ok: true,
          errors: [],
          design: {
            producedBpd: 500,
            plungerStrokeIn: 50,
            pprlLb: 12000,
            balance: { peakTorqueInLb: 320000 },
            gas: { fillage: 0.85 },
            warnings: [],
            worstSection: { loadingPct: 87.62, label: '7/8 in' },
          },
        }),
      },
    });
    const shown = out.figures.find((f) => f.label === 'Rod loading').value;
    // Item 17 family: the figure used to be rounded whole, so 87.62 and
    // 88.4 printed as the same number. One decimal, and never a NaN.
    expect(shown).toBe('87.6 % of Goodman');
    expect(shown).not.toMatch(/NaN/);
    expect(out.figures.every((f) => !/NaN/.test(String(f.value)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ESP pass
// ---------------------------------------------------------------------------

describe('the ESP pass and its three runs', () => {
  const PROBE_INTAKE = 2800;   // in-situ bbl/d the probe reports
  const SHAFT_HP = 96;

  const espChain = (calls) => ({
    runEspDesign: ({ form }) => {
      calls.push({ ...form });
      return {
        ok: true,
        errors: [],
        design: {
          duty: {
            pumpIntakeBpd: PROBE_INTAKE,
            tdhFt: 4183,
            intake: { pipPsia: 620, gas: { gvfThroughPump: 0.31 } },
          },
          sized: { stages: 162, shaftHp: SHAFT_HP },
          electrical: { cable: { label: '1 AWG' } },
          warnings: [],
        },
      };
    },
  });

  test('probes with a mid-range stage, sizes on the stage the duty deserves, then hangs the motor the shaft needs', () => {
    const calls = [];
    const out = designEsp({
      model: makeModel(), targetLiquidRateBpd: 900, wctPct: 55, gorScfStb: 300, whp: 200,
      facility: {}, chain: espChain(calls),
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].referenceStageId).toBe('ref-540-2500');
    const stage = pickReferenceStage(PROBE_INTAKE);
    expect(stage.id).toBe('ref-540-2500');
    expect(calls[1].referenceStageId).toBe(stage.id);
    const motor = pickMotorFrame(SHAFT_HP);
    expect(calls[2].nameplateHp).toBe(String(motor.hp));
    expect(calls[2].nameplateVolts).toBe(String(motor.volts));
    expect(calls[2].nameplateAmps).toBe(String(motor.amps));
    expect(out.ok).toBe(true);
    expect(out.equipment).toContain(`${motor.hp} hp motor`);
    expect(out.equipment).toContain('162 stages');
  });

  test('the screening-grade defaults are stated and are reported with the answer', () => {
    const calls = [];
    designEsp({
      model: makeModel({ tvdMax: 8000 }), targetLiquidRateBpd: 900, wctPct: 55, gorScfStb: 300,
      whp: 200, facility: { separatorEfficiencyPct: 80 }, chain: espChain(calls),
    });
    // pump at 94 per cent of the perforations, cable 3 per cent longer
    expect(calls[0].perfTvdFt).toBe('8000');
    expect(calls[0].pumpTvdFt).toBe(String(Math.round(8000 * 0.94)));
    expect(calls[0].cableLengthFt).toBe(String(Math.round(Math.round(8000 * 0.94) * 1.03)));
    expect(calls[0].separatorEfficiencyPct).toBe('80');
  });

  test('a chain that refuses is a refusal with the chain reason, at any of the three runs', () => {
    let n = 0;
    const out = designEsp({
      model: makeModel(), targetLiquidRateBpd: 900, wctPct: 55, gorScfStb: 300, whp: 200, facility: {},
      chain: {
        runEspDesign: () => {
          n += 1;
          if (n === 1) {
            return {
              ok: true,
              design: {
                duty: { pumpIntakeBpd: 900, tdhFt: 1, intake: { pipPsia: 1, gas: { gvfThroughPump: 0 } } },
                sized: { stages: 1, shaftHp: 1 }, electrical: {}, warnings: [],
              },
            };
          }
          return { ok: false, errors: ['this well flows on its own'] };
        },
      },
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('this well flows on its own');
  });

  test('with no chain at all it refuses rather than throwing', () => {
    const out = designEsp({ model: makeModel(), targetLiquidRateBpd: 900, wctPct: 55, gorScfStb: 300, whp: 200, chain: {} });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/No ESP design chain/);
  });
});

// ---------------------------------------------------------------------------
// The gas lift pass
// ---------------------------------------------------------------------------

describe('the gas lift pass', () => {
  const gasChain = (log, over = {}) => ({
    liftedTraverse: (args) => { log.push(['traverse', args]); return { points: [{ md: 0, p: 200 }, { md: 7000, p: 2400 }] }; },
    injectionPointFromTraverse: (args) => { log.push(['point', args]); return { depthFt: 4600, limitedBy: 'pressure' }; },
    solveLiftedOperatingPoint: (args) => { log.push(['solve', args]); return { q: 640, pwf: 1450, status: 'flowing' }; },
    ...over,
  });

  test('builds the flowing gradient FIRST, places the injection point on it, then solves the node', () => {
    const log = [];
    const out = designGasLift({
      model: makeModel(), targetLiquidRateBpd: 700, wctPct: 55, gorScfStb: 400, whp: 200,
      facility: { injectionPsig: 900, injectionMscfd: 500 }, chain: gasChain(log),
    });
    expect(log.map((x) => x[0])).toEqual(['traverse', 'point', 'solve']);
    // the surface pressure reaches the placement as an ABSOLUTE
    expect(log[1][1].pSurfPsia).toBeCloseTo(914.7, 9);
    // and the placement depth is turned into a MEASURED depth on the
    // well's own survey before the node is solved at it
    expect(log[2][1].injectionMd).toBeCloseTo(mdAtTvd(makeModel().trajectory, 4600), 9);
    expect(out.ok).toBe(true);
    expect(out.rateStbd).toBe(640);
    expect(out.equipment).toMatch(/4,600 ft/);
  });

  test('nowhere to put the gas in is a refusal that says why', () => {
    const log = [];
    const out = designGasLift({
      model: makeModel(), targetLiquidRateBpd: 700, wctPct: 55, gorScfStb: 400, whp: 200,
      facility: { injectionPsig: 250 },
      chain: gasChain(log, { injectionPointFromTraverse: () => ({ depthFt: 0 }) }),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/never gets below the flowing gradient/);
    expect(out.reason).toMatch(/250 psig/);
  });

  test('a node that does not cross is a refusal, not a zero rate reported as a design', () => {
    const log = [];
    const out = designGasLift({
      model: makeModel(), targetLiquidRateBpd: 700, wctPct: 55, gorScfStb: 400, whp: 200,
      facility: { injectionMscfd: 500 },
      chain: gasChain(log, { solveLiftedOperatingPoint: () => ({ q: 0, pwf: 0, status: 'dead' }) }),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/does not lighten the column enough/);
    expect(out.rateStbd).toBeUndefined();
  });

  test('a chain that throws is a refusal carrying the message, not an exception', () => {
    const out = designGasLift({
      model: makeModel(), targetLiquidRateBpd: 700, wctPct: 55, gorScfStb: 400, whp: 200, facility: {},
      chain: gasChain([], { liftedTraverse: () => { throw new Error('no PVT'); } }),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/no PVT/);
  });

  test('the facility defaults are the stated ones', () => {
    const log = [];
    designGasLift({
      model: makeModel(), targetLiquidRateBpd: 700, wctPct: 55, gorScfStb: 400, whp: 200,
      facility: {}, chain: gasChain(log),
    });
    expect(log[1][1].pSurfPsia).toBeCloseTo(psigToPsia(900), 9);  // 900 psig
    expect(log[0][1].qgiMscfd).toBe(500);                          // 500 Mscf/d
    expect(log[1][1].gasSg).toBe(0.65);
  });
});

// ---------------------------------------------------------------------------
// The plunger pass, run for real
// ---------------------------------------------------------------------------

describe('the plunger pass, end to end through the real chain', () => {
  test.each(G.plungerPass.map((w) => [w.id, w]))('%s assembles exactly the oracle inputs', (_id, w) => {
    const model = makeModel({
      tvdMax: w.tvdMax,
      vlp: { idIn: w.idIn, nodeMd: w.tvdMax, whp: w.whp },
      fluidModel: { api: w.api, gor: w.gorScfStb, gasSg: w.gasSg },
      tAt: (tvd) => w.whtF + (w.bhtF - w.whtF) * (tvd / w.tvdMax),
    });
    const out = designPlunger({
      model, targetLiquidRateBpd: w.targetRate, wctPct: w.wctPct,
      gorScfStb: w.gorScfStb, whp: w.whp, facility: w.facility,
    });
    // The gate on the ASSEMBLY: running the chain directly on the
    // oracle's independently derived inputs must give the same design.
    const direct = screenPlungerLift(w.chainInputs);
    expect(direct.ok).toBe(true);
    if (out.ok) {
      expect(direct.design.feasible).toBe(true);
      expect(rel(out.rateStbd, direct.design.liquidPerDayBbl)).toBeLessThan(1e-12);
      expect(rel(out.design.requiredGlrScfBbl, direct.design.requiredGlrScfBbl))
        .toBeLessThan(1e-12);
      expect(rel(out.design.lift.requiredPsia, direct.design.lift.requiredPsia))
        .toBeLessThan(1e-12);
    } else {
      expect(direct.design.feasible).toBe(false);
      expect(out.reason.length).toBeGreaterThan(10);
    }
    expect(w.why.length).toBeGreaterThan(40);
  });

  test('a gassy stripper runs and reports the ratio the cycle needs against the one the well makes', () => {
    const w = G.plungerPass.find((x) => x.id === 'gassyStripper');
    const model = makeModel({
      tvdMax: w.tvdMax, vlp: { idIn: w.idIn, nodeMd: w.tvdMax, whp: w.whp },
      fluidModel: { api: w.api, gor: w.gorScfStb, gasSg: w.gasSg },
      tAt: (tvd) => w.whtF + (w.bhtF - w.whtF) * (tvd / w.tvdMax),
    });
    const out = designPlunger({
      model, targetLiquidRateBpd: w.targetRate, wctPct: w.wctPct,
      gorScfStb: w.gorScfStb, whp: w.whp, facility: w.facility,
    });
    expect(out.ok).toBe(true);
    const makes = out.figures.find((f) => f.label === 'This well makes').value;
    expect(makes).toBe(`${Math.round(w.chainInputs.wellGlrScfBbl).toLocaleString()} scf/bbl`);
    expect(w.chainInputs.wellGlrScfBbl).toBe(8400); // 12000 x (1 - 0.30)
  });

  test('not enough gas per barrel is a refusal with the reason, not a design', () => {
    const w = G.plungerPass.find((x) => x.id === 'notEnoughGas');
    const model = makeModel({
      tvdMax: w.tvdMax, vlp: { idIn: w.idIn, nodeMd: w.tvdMax, whp: w.whp },
      fluidModel: { api: w.api, gor: w.gorScfStb, gasSg: w.gasSg },
      tAt: (tvd) => w.whtF + (w.bhtF - w.whtF) * (tvd / w.tvdMax),
    });
    const out = designPlunger({
      model, targetLiquidRateBpd: w.targetRate, wctPct: w.wctPct,
      gorScfStb: w.gorScfStb, whp: w.whp, facility: w.facility,
    });
    expect(out.ok).toBe(false);
    expect(out.design.feasible).toBe(false);
  });

  test('the casing pressure defaults to 2.5 times the line pressure when the facility does not say', () => {
    const w = G.plungerPass[0];
    expect(w.chainInputs.casingPressurePsia).toBe(w.whp * 2.5);
  });
});

// ---------------------------------------------------------------------------
// The pass, and the reconciliation
// ---------------------------------------------------------------------------

describe('the pass-level refusals, before any chain is run', () => {
  const chainThatMustNotRun = {
    runEspDesign: () => { throw new Error('should not have been called'); },
    runRodDesign: () => { throw new Error('should not have been called'); },
    liftedTraverse: () => { throw new Error('should not have been called'); },
    injectionPointFromTraverse: () => { throw new Error('should not have been called'); },
    solveLiftedOperatingPoint: () => { throw new Error('should not have been called'); },
  };

  test.each(G.passRefusals.map((c) => [c.id, c]))('%s', (_id, c) => {
    const model = c.model === null ? null : makeModel({
      phase: c.phase, ipr: { qmax: c.qmax },
    });
    const out = runDesignPass({
      model, targetLiquidRateBpd: c.targetRate, wctPct: 40, gorScfStb: 400, whp: 200,
      facility: {}, chain: c.expect === 'runs' ? {} : chainThatMustNotRun,
    });
    if (c.expect === 'runs') {
      expect(out.ok).toBe(true);
      expect(out.results).toHaveLength(4);
    } else {
      expect(out.ok).toBe(false);
      expect(out.results).toEqual([]);
      expect(out.errors).toHaveLength(1);
    }
    if (c.expect === 'gas') expect(out.errors[0]).toMatch(/designs lift for an oil well/);
    if (c.expect === 'noTarget') expect(out.errors[0]).toMatch(/target rate is needed/);
    if (c.expect === 'aboveAof') expect(out.errors[0]).toMatch(/absolute open flow/);
    if (c.expect === 'incomplete') expect(out.errors[0]).toMatch(/well model is incomplete/);
    expect(c.why.length).toBeGreaterThan(20);
  });

  test('only the four engine-backed methods are in the pass at all', () => {
    const out = runDesignPass({
      model: makeModel(), targetLiquidRateBpd: 500, wctPct: 40, gorScfStb: 400, whp: 200,
      facility: {}, chain: {},
    });
    expect(out.results.map((r) => r.id).sort()).toEqual(['esp', 'gasLift', 'plunger', 'rodPump']);
    expect(out.results.every((r) => r.hasEngine)).toBe(true);
  });

  test('a chain that throws inside a designer is one failed method, not a failed pass', () => {
    const out = runDesignPass({
      model: makeModel(), targetLiquidRateBpd: 500, wctPct: 40, gorScfStb: 400, whp: 200, facility: {},
      chain: { runEspDesign: () => { throw new Error('PVT blew up'); } },
    });
    expect(out.ok).toBe(true);
    const esp = out.results.find((r) => r.id === 'esp');
    expect(esp.ok).toBe(false);
    expect(esp.reason).toMatch(/PVT blew up/);
  });
});

describe('reconciling the screening against the design', () => {
  test('the verdict is a complete four-way truth table', () => {
    G.truthTable.forEach((c) => {
      const screening = [{
        id: 'esp', label: 'ESP', hasEngine: c.hasEngine, score: 70,
        recommended: c.recommended,
      }];
      const designPass = c.hasDesign
        ? { results: [{ id: 'esp', ok: c.designOk }] }
        : { results: [] };
      expect(reconcile({ screening, designPass }).rows[0].verdict).toBe(c.verdict);
    });
  });

  test('names the disagreements rather than quietly resolving them', () => {
    const c = G.reconcile;
    const screening = c.screening.map((s) => ({ ...s, label: s.id }));
    const designPass = {
      results: Object.entries(c.design).map(([id, ok]) => ({ id, ok })),
    };
    const out = reconcile({ screening, designPass });
    expect(out.rows.map((r) => r.verdict)).toEqual(c.expected.rows.map((r) => r.verdict));
    expect(out.disagreements.map((r) => r.id)).toEqual(c.expected.disagreements);
    expect(out.workable.map((r) => r.id)).toEqual(c.expected.workable);
    // A method the matrix liked that the design refuses, and one it was
    // lukewarm about that the design ran. Both say the design won.
    expect(out.rows.find((r) => r.id === 'rodPump').verdict).toBe('designNo');
    expect(out.rows.find((r) => r.id === 'plunger').verdict).toBe('designYes');
    expect(out.rows.find((r) => r.id === 'rodPump').note).toMatch(/design is the one that solved/);
  });

  test('RANKS WHAT DEMONSTRABLY WORKS ABOVE WHAT MERELY SCORES WELL', () => {
    const c = G.reconcile;
    const screening = c.screening.map((s) => ({ ...s, label: s.id }));
    const designPass = {
      results: Object.entries(c.design).map(([id, ok]) => ({ id, ok })),
    };
    const out = reconcile({ screening, designPass });
    expect(out.ranked.map((r) => r.id)).toEqual(c.expected.ranked);
    // Plunger lift scored 45 and is ranked SECOND, above a rod pump
    // that scored 90, because the plunger design ran and the rod pump
    // design did not.
    expect(out.ranked[1].id).toBe('plunger');
    expect(out.ranked[1].score).toBe(45);
    expect(out.ranked[2].id).toBe('rodPump');
    expect(out.ranked[2].score).toBe(90);
  });

  test('a screened-only method is never dressed up as a design', () => {
    const out = reconcile({
      screening: [{ id: 'pcp', label: 'PCP', hasEngine: false, score: 80, recommended: true }],
      designPass: { results: [] },
    });
    expect(out.rows[0].verdict).toBe('noEngine');
    expect(out.rows[0].design).toBeNull();
    expect(out.workable).toEqual([]);
  });

  test('with no design pass it is screening alone, and nothing is workable', () => {
    const out = reconcile({
      screening: [{ id: 'esp', label: 'ESP', hasEngine: true, score: 90, recommended: true }],
      designPass: null,
    });
    expect(out.rows[0].verdict).toBe('notRun');
    expect(out.workable).toEqual([]);
    expect(out.disagreements).toEqual([]);
  });
});

// The advisor keeps its own copy of the rod loading message, and it had the
// second spelling of the defect PR #113 fixed in the engine: it fires
// strictly above 100 percent and printed the loading rounded whole, so a
// trial thrown out at 100.3 percent read as thrown out for running at
// exactly its allowable. One decimal narrows the collision to the 0.05
// above 100, it does not remove it.
describe('a rejected rod trial prints a loading above its own limit', () => {
  test('a trial at 100.3 percent does not print as 100 percent', () => {
    const loadingPct = 100.3;
    const out = designRodPump({
      model: makeModel(),
      targetLiquidRateBpd: 400,
      wctPct: 40,
      gorScfStb: 300,
      whp: 150,
      // every trial comes back overstressed by the same three tenths of a
      // point, which is inside the band the flag fires on and clear of the
      // neighbourhood one decimal leaves
      chain: {
        runRodDesign: () => ({
          ok: true,
          errors: [],
          design: {
            producedBpd: 300,
            plungerStrokeIn: 50,
            pprlLb: 12000,
            balance: { peakTorqueInLb: 320000 },
            gas: { fillage: 0.85 },
            warnings: [],
            worstSection: { loadingPct, label: '7/8 in' },
          },
        }),
      },
    });
    expect(loadingPct).toBeGreaterThan(100);
    expect(loadingPct - 100).toBeGreaterThan(0.05);
    expect(Math.round(loadingPct)).toBe(100);        // what the old print gave
    expect(out.ok).toBe(false);
    expect(out.attempts).toHaveLength(ROD_TRIALS.length);
    out.attempts.forEach((a) => {
      expect(a.reason).toContain('run at 100.3 percent of their allowable');
      expect(a.reason).not.toMatch(/run at 100 percent/);
    });
  });
});

// ---------------------------------------------------------------------------
// ITEM 19: the door says LIQUID, the chains still want OIL, and the seam
// between them is one exported function.
// ---------------------------------------------------------------------------

describe('ITEM 19: the target rate is named for the phase it carries', () => {
  test('the door takes targetLiquidRateBpd, and the old name is not read', () => {
    const withOldKey = runDesignPass({
      model: makeModel(), targetRate: 500, wctPct: 40, gorScfStb: 400, whp: 200,
      facility: {}, chain: {},
    });
    // Fails closed: an unrecognised key is no target at all, not a zero.
    expect(withOldKey.ok).toBe(false);
    expect(withOldKey.errors[0]).toMatch(/target rate is needed/);
    const withNewKey = runDesignPass({
      model: makeModel(), targetLiquidRateBpd: 500, wctPct: 40, gorScfStb: 400, whp: 200,
      facility: {}, chain: {},
    });
    expect(withNewKey.ok).toBe(true);
  });

  test('WAVE 2: the derivation is the one place it lands', () => {
    expect(oilDesignRate(1000, 70)).toBeCloseTo(300, 9);
    expect(oilDesignRate(1000, 0)).toBe(1000);
    expect(oilDesignRate(1000, 100)).toBe(0);
    // a water cut outside the physical band is clamped, not extrapolated
    expect(oilDesignRate(1000, -5)).toBe(1000);
    expect(oilDesignRate(1000, 120)).toBe(0);
    // and a water cut that cannot be read is NOT a water cut of zero:
    // designing on the liquid rate again is exactly the defect
    expect(Number.isNaN(oilDesignRate(1000, undefined))).toBe(true);
    expect(Number.isNaN(oilDesignRate(1000, NaN))).toBe(true);
    expect(Number.isNaN(oilDesignRate(undefined, 40))).toBe(true);
  });

  test('so a water cut changes what the chains are asked for', () => {
    const asked = [];
    const chain = {
      runEspDesign: ({ form }) => {
        asked.push(Number(form.designRateStbd));
        return { ok: false, errors: ['probe only'] };
      },
    };
    [0, 40, 90].forEach((wctPct) => {
      designEsp({
        model: makeModel(), targetLiquidRateBpd: 800, wctPct, gorScfStb: 300, whp: 200, chain,
      });
    });
    expect(asked[0]).toBeCloseTo(800, 9);
    expect(asked[1]).toBeCloseTo(480, 9);
    expect(asked[2]).toBeCloseTo(80, 9);
  });

  test('and the plunger ratio reads the number as liquid', () => {
    // The liquid the cycle sees IS the input now. It used to be the
    // input divided by (1 - wct), which on a 90 per cent water cut well
    // is ten times the liquid. The ratio itself does not move either
    // way: it is GOR x (1 - wct).
    const wet = plungerWellGlr({ targetLiquidRateBpd: 100, gorScfStb: 3000, wctPct: 90 });
    expect(wet.liquidBpd).toBeCloseTo(100, 9);
    expect(wet.glrScfBbl).toBeCloseTo(300, 9);
  });
});

// Found by the Suite port (Wave 4). The probe runs on one arbitrary
// stage to learn the duty, and since item 5 a stage refuses to be read
// far outside its tested span, so the probe itself can refuse on a well
// the catalogue can perfectly well design.
describe('the ESP probe learns the duty even when it cannot design at the probe stage', () => {
  const model = makeModel();
  const duty = { pumpIntakeBpd: 900 };

  test('a chain that reports its duty alongside a refusal still gets a stage picked', () => {
    const stagesTried = [];
    const chain = {
      runEspDesign: ({ form }) => {
        stagesTried.push(form.referenceStageId);
        // the probe stage refuses, and says what the duty was
        if (form.referenceStageId === 'ref-540-2500') {
          return { ok: false, errors: ['outside the tested rate span'], duty };
        }
        return {
          ok: true,
          errors: [],
          design: {
            duty: { ...duty, tdhFt: 4200, intake: { pipPsia: 800, gas: { gvfThroughPump: 0.1 } } },
            sized: { stages: 120, shaftHp: 60, motorSizingHp: 61, warnings: [] },
            electrical: { cable: { label: '4 AWG' } },
            warnings: [],
          },
        };
      },
    };
    const out = designEsp({
      model, targetLiquidRateBpd: 1000, wctPct: 10, gorScfStb: 200, whp: 150, chain,
    });
    expect(out.ok).toBe(true);
    // the probe stage first, then the stage the DUTY calls for, twice
    // more for the sizing and the final run
    expect(stagesTried[0]).toBe('ref-540-2500');
    expect(stagesTried[1]).toBe(pickReferenceStage(900).id);
    expect(stagesTried[1]).not.toBe('ref-540-2500');
  });

  test('a chain that refuses with no duty at all still refuses the method', () => {
    const chain = {
      runEspDesign: () => ({ ok: false, errors: ['no inflow'] }),
    };
    const out = designEsp({
      model, targetLiquidRateBpd: 1000, wctPct: 10, gorScfStb: 200, whp: 150, chain,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no inflow');
  });

  test('when the nearest stage cannot be read either, the refusal says which was tried', () => {
    const chain = {
      runEspDesign: ({ form }) => (form.referenceStageId === 'ref-540-2500'
        ? { ok: false, errors: ['probe stage is off the curve'], duty: { pumpIntakeBpd: 120 } }
        : { ok: false, errors: ['this duty is off every curve'] }),
    };
    const out = designEsp({
      model, targetLiquidRateBpd: 200, wctPct: 10, gorScfStb: 200, whp: 150, chain,
    });
    expect(out.ok).toBe(false);
    // the chain's own sentence is the reason, verbatim
    expect(out.reason).toBe('this duty is off every curve');
    // and the context travels beside it
    expect(out.stageTried).toBe(pickReferenceStage(120).id);
    expect(out.dutyBpd).toBe(120);
    expect(out.note).toMatch(/nearest stage in this catalogue/);
    expect(out.note).toMatch(/120\.0 bbl\/d/);
  });
});
