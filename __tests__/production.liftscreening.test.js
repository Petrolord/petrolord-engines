/**
 * Artificial lift screening gates.
 *
 * A rules matrix has no second method to reach its numbers by, so this
 * suite does not pretend to have one. The oracle
 * (tools/validation/production/oracle_liftscreening.py) re-expresses
 * every rule as a DECLARATIVE PENALTY LEDGER walked by one generic
 * scorer with no branch on a method name anywhere, and then gates the
 * things a transcription cannot fake:
 *
 *   - no adverse condition ever RAISES a score, measured by running the
 *     scorer twice rather than by reading the rules;
 *   - the clamp holds over a swept input space;
 *   - `recommended` is exactly {score >= top - 15 and score > 50},
 *     recomputed from the scores;
 *   - ties keep catalog order;
 *   - seven archetype wells rank the way an engineer would argue in one
 *     sentence, and the sentence is in the golden.
 *
 * THE TWO SEAMS THIS SUITE USED TO GATE AS FINDINGS ARE NOW OWNER
 * DECISIONS, AND ARE GATED AS FIXES.
 *
 *   - ITEM 20. A missing input used to be coerced to zero, so an absent
 *     API read as ultra-heavy crude and swung the ESP and the PCP 45
 *     points apart on no information. Now the rate and the depth are
 *     required and their absence is a refusal, an absent optional input
 *     SKIPS its rule and says so, and an unreadable input is refused
 *     rather than coerced.
 *   - ITEM 19. The target rate MEANS LIQUID, and this module reads it as
 *     liquid, which is what every rate rule in it is about. The
 *     parameter is `targetLiquidRateBpd`. The golden's input records
 *     predate the rename and still say `targetRate`, so `fromGolden`
 *     maps the key at the call: not one golden number moved.
 */
import fs from 'fs';
import path from 'path';
import {
  LIFT_METHODS, liftMethod, screenLift, screeningInputsFromModel,
} from '../engines/production/liftScreening';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'lift_screening_cases.json'),
  'utf8',
));

const scoreMap = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.score]));

/**
 * The goldens were written before item 19 renamed the door parameter,
 * so their input records still call the rate `targetRate`. This maps
 * the key and nothing else: every value reaches `screenLift` untouched,
 * which is what makes the rename provably free of moved numbers.
 */
const fromGolden = ({ targetRate, ...rest }) => (
  targetRate === undefined ? { ...rest } : { ...rest, targetLiquidRateBpd: targetRate }
);

/** Every reason text a screening handed back, across all six methods. */
const allReasons = (rows) => rows.flatMap((r) => r.reasons.map((x) => x.text));

// ---------------------------------------------------------------------------

describe('the six methods', () => {
  test('are the catalog, and say which of them can actually be designed', () => {
    expect(LIFT_METHODS.map((m) => m.id)).toEqual(G.methods.map((m) => m.id));
    LIFT_METHODS.forEach((m, i) => {
      expect(m.label).toBe(G.methods[i].label);
      expect(m.hasEngine).toBe(G.methods[i].hasEngine);
    });
    expect(LIFT_METHODS.filter((m) => m.hasEngine).map((m) => m.id).sort())
      .toEqual(['esp', 'gasLift', 'plunger', 'rodPump']);
  });

  test('a method with no engine carries no studio to hand off to', () => {
    LIFT_METHODS.filter((m) => !m.hasEngine).forEach((m) => expect(m.studio).toBeNull());
    expect(liftMethod('pcp').label).toMatch(/Progressing cavity/);
    expect(liftMethod('nonsense')).toBeNull();
  });
});

describe('the score against a declarative penalty ledger', () => {
  test('every archetype scores exactly what the ledger gives', () => {
    G.archetypes.forEach((a) => {
      const got = screenLift(fromGolden(a.inputs));
      expect(got.map((r) => r.id)).toEqual(a.result.map((r) => r.id));
      got.forEach((r, i) => {
        expect(r.score).toBe(a.result[i].score);
        expect(r.recommended).toBe(a.result[i].recommended);
      });
    });
  });

  test('and emits exactly the reasons the ledger says, in kind and in order', () => {
    G.archetypes.forEach((a) => {
      const got = screenLift(fromGolden(a.inputs));
      got.forEach((r, i) => {
        expect(r.reasons.map((x) => x.type)).toEqual(a.result[i].reasonKinds);
        // Every reason is spelled out, because the reasons are the
        // output and the score is only the ranking device.
        r.reasons.forEach((x) => expect(x.text.length).toBeGreaterThan(20));
      });
    });
  });

  test('over a swept input space too, score for score', () => {
    expect(G.sweep.length).toBeGreaterThan(100);
    G.sweep.forEach((c) => {
      const got = screenLift(fromGolden(c.inputs));
      expect(scoreMap(got)).toEqual(c.scores);
      expect(got.map((r) => r.id)).toEqual(c.order);
    });
  });
});

describe('the archetypes rank the way an engineer would argue', () => {
  test.each(G.archetypes.map((a) => [a.id, a]))('%s', (_id, a) => {
    const got = screenLift(fromGolden(a.inputs));
    // The named method must be at the top, or tied at the top.
    const top = got[0].score;
    const winners = got.filter((r) => r.score === top).map((r) => r.id);
    expect(a.expectTop.some((m) => winners.includes(m))).toBe(true);
    expect(a.why.length).toBeGreaterThan(40);
  });

  test('no power at the wellsite is decisive against an ESP, and no gas against gas lift', () => {
    const noPower = scoreMap(screenLift(fromGolden(G.archetypes.find((a) => a.id === 'noPower').inputs)));
    const noGas = scoreMap(screenLift(fromGolden(G.archetypes.find((a) => a.id === 'noGas').inputs)));
    expect(noPower.gasLift).toBeGreaterThan(noPower.esp);
    expect(noGas.esp).toBeGreaterThan(noGas.gasLift);
  });

  test('rod pumping is limited by depth AND rate together, not by either alone', () => {
    const shallowFast = scoreMap(screenLift({ targetLiquidRateBpd: 2000, depthFt: 1000, api: 32, bhtF: 150 }));
    const deepSlow = scoreMap(screenLift({ targetLiquidRateBpd: 100, depthFt: 12000, api: 32, bhtF: 150 }));
    const deepFast = scoreMap(screenLift({ targetLiquidRateBpd: 2000, depthFt: 12000, api: 32, bhtF: 150 }));
    // 2.0 and 1.2 duty index are both comfortable; 24 is not.
    expect(shallowFast.rodPump).toBeGreaterThan(deepFast.rodPump);
    expect(deepSlow.rodPump).toBeGreaterThan(deepFast.rodPump);
  });
});

describe('the structural properties', () => {
  test('AN ADVERSE CONDITION NEVER RAISES A SCORE', () => {
    const base = scoreMap(screenLift(fromGolden(G.monotonicity.base)));
    expect(base).toEqual(G.monotonicity.baseScores);
    G.monotonicity.cases.forEach((c) => {
      const inputs = { ...fromGolden(G.monotonicity.base), [c.condition]: c.turnedOn };
      const got = scoreMap(screenLift(inputs));
      LIFT_METHODS.forEach((m) => {
        expect(got[m.id] - base[m.id]).toBe(c.deltas[m.id]);
        expect(c.deltas[m.id]).toBeLessThanOrEqual(0);
      });
    });
  });

  test('the clamp holds: every score in the sweep lands in 0..100', () => {
    G.sweep.forEach((c) => {
      Object.values(c.scores).forEach((s) => {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(100);
        expect(Number.isInteger(s)).toBe(true);
      });
    });
    // and the clamp really bites: a well that offends every rule floors.
    const awful = scoreMap(screenLift({
      targetLiquidRateBpd: 3000, depthFt: 14000, gor: 20, api: 45, bhtF: 340, wctPct: 20,
      hasSand: true, isHorizontal: true, isOffshore: true,
      powerAvailable: false, gasAvailable: false, reservoirPressureLow: true,
    }));
    expect(Math.min(...Object.values(awful))).toBe(0);
  });

  test('recommended is a BAND recomputed from the scores, not a winner', () => {
    G.sweep.forEach((c) => {
      const got = screenLift(fromGolden(c.inputs));
      const top = got[0].score;
      const expected = got.filter((r) => r.score >= top - 15 && r.score > 50).map((r) => r.id);
      expect(got.filter((r) => r.recommended).map((r) => r.id)).toEqual(expected);
      expect(expected).toEqual(c.recommended);
    });
  });

  test('best first, and a tie keeps catalog order', () => {
    G.sweep.forEach((c) => {
      const got = screenLift(fromGolden(c.inputs));
      for (let i = 1; i < got.length; i += 1) {
        expect(got[i].score).toBeLessThanOrEqual(got[i - 1].score);
        if (got[i].score === got[i - 1].score) {
          const a = LIFT_METHODS.findIndex((m) => m.id === got[i - 1].id);
          const b = LIFT_METHODS.findIndex((m) => m.id === got[i].id);
          expect(b).toBeGreaterThan(a);
        }
      }
    });
  });
});

describe('ITEM 20: a missing input is not a neutral input', () => {
  const s = G.seams.missingApiIsHeavy;

  test('an absent API no longer reads as heavier than any real crude', () => {
    const known = scoreMap(screenLift(fromGolden(s.known)));
    const missing = scoreMap(screenLift({ ...fromGolden(s.known), api: undefined }));
    expect(known).toEqual(s.knownScores);
    // The golden still records what the coercion used to give: the ESP
    // docked 20 points for a viscosity it was never told about.
    expect(s.missingScores.esp).toBe(80);
    expect(missing.esp).toBe(100);
    expect(missing.esp).not.toBe(s.missingScores.esp);
  });

  test('the gravity rule is SKIPPED, and every method that reads it says so', () => {
    const missing = screenLift({ ...fromGolden(s.known), api: undefined });
    ['esp', 'rodPump', 'pcp'].forEach((id) => {
      const row = missing.find((r) => r.id === id);
      const note = row.reasons.find((x) => /No API gravity was supplied/.test(x.text));
      expect(note).toBeDefined();
      expect(note.type).toBe('neutral');
      expect(note.text).toMatch(/A missing gravity is not a heavy crude/);
    });
    // And nothing is claimed about viscosity anywhere in the screening.
    expect(allReasons(missing).some((t) => /best in the world/.test(t))).toBe(false);
    expect(allReasons(missing).some((t) => /Viscous crude cuts centrifugal head/.test(t))).toBe(false);
  });

  test('an absent gas ratio, water cut or temperature skips its rule too', () => {
    const bare = screenLift({ targetLiquidRateBpd: 700, depthFt: 6500 });
    const texts = allReasons(bare);
    expect(texts.some((t) => /No gas to oil ratio was supplied/.test(t))).toBe(true);
    expect(texts.some((t) => /No water cut was supplied/.test(t))).toBe(true);
    expect(texts.some((t) => /No bottomhole temperature was supplied/.test(t))).toBe(true);
    // Skipped means no points move, in either direction. Plunger lift
    // used to lose 55 points for a gas ratio nobody had supplied: all
    // that is left against it here is the rate rule, which was.
    const withNoGas = scoreMap(screenLift({ targetLiquidRateBpd: 700, depthFt: 6500, gor: 100 }));
    expect(withNoGas.plunger).toBe(0);
    expect(scoreMap(bare).plunger).toBe(55);
    expect(scoreMap(bare).esp).toBe(100);
  });

  test('the duty is REQUIRED, so screening an empty object is a refusal', () => {
    const out = screenLift({});
    expect(out.ok).toBe(false);
    expect(out.code).toBe('missingInputs');
    expect(out.error).toMatch(/targetLiquidRateBpd and depthFt was not supplied/);
    expect(out.error).toMatch(/a missing input is not a zero one/);
    expect(Array.isArray(out)).toBe(false);
    // The golden records what the coercion used to give instead: a
    // clean sweep for rod pumping, on no information at all.
    expect(G.emptyInput[0].id).toBe('rodPump');
    expect(G.emptyInput[0].score).toBe(100);
  });

  test('undefined, null and a half-filled well all refuse the same way', () => {
    [undefined, null, {}, { depthFt: 6500 }, { targetLiquidRateBpd: 700 }].forEach((inputs) => {
      const out = screenLift(inputs);
      expect(out.ok).toBe(false);
      expect(out.code).toBe('missingInputs');
    });
    expect(screenLift({ depthFt: 6500 }).error).toMatch(/targetLiquidRateBpd was not supplied/);
    expect(screenLift({ targetLiquidRateBpd: 700 }).error).toMatch(/depthFt was not supplied/);
  });

  test('an input that is present but unreadable is REFUSED, never coerced', () => {
    const out = screenLift({ targetLiquidRateBpd: '700', depthFt: 6500 });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('nonNumericInput');
    expect(out.error).toMatch(/targetLiquidRateBpd was given as "700"/);
    expect(out.error).toMatch(/never coerces/);
    // A NaN is not a number either, and neither is a boolean.
    expect(screenLift({ targetLiquidRateBpd: NaN, depthFt: 6500 }).code).toBe('nonNumericInput');
    expect(screenLift({ targetLiquidRateBpd: 700, depthFt: 6500, api: true }).code)
      .toBe('nonNumericInput');
    // An OPTIONAL input that is merely absent is not a refusal.
    expect(Array.isArray(screenLift({ targetLiquidRateBpd: 700, depthFt: 6500 }))).toBe(true);
  });

  test('and the model reader can hand back exactly that undefined API', () => {
    // screeningInputsFromModel reads what the well model knows. A model
    // with no fluid description hands back an undefined api and gor,
    // which since item 20 the screening skips rather than reads as dead,
    // ultra-heavy crude.
    const bare = screeningInputsFromModel({
      tvdMax: 6000, tAt: () => 190, trajectory: { mdMax: 6000 },
    }, { targetLiquidRateBpd: 500, wctPct: 40 });
    expect(bare.api).toBeUndefined();
    expect(bare.gor).toBeUndefined();
    expect(bare.depthFt).toBe(6000);
    expect(bare.bhtF).toBe(190);
    expect(bare.isDeviated).toBe(false);
    expect(bare.targetLiquidRateBpd).toBe(500);
    expect(screeningInputsFromModel(null)).toEqual({});
    // Which screens cleanly, with the skipped rules stated.
    const screened = screenLift(bare);
    expect(Array.isArray(screened)).toBe(true);
    expect(allReasons(screened).some((t) => /No API gravity was supplied/.test(t))).toBe(true);
  });

  test('a deviated well is read off the survey, not asked for twice', () => {
    const dev = screeningInputsFromModel({
      tvdMax: 6000, tAt: () => 190, trajectory: { mdMax: 6800 },
      fluidModel: { api: 30, gor: 400 },
    }, { targetLiquidRateBpd: 500, wctPct: 40 });
    expect(dev.isDeviated).toBe(true);
    expect(dev.api).toBe(30);
  });

  test('a trajectory that was not supplied is not a vertical well', () => {
    const noSurvey = screeningInputsFromModel({
      tvdMax: 6000, tAt: () => 190, fluidModel: { api: 30, gor: 400 },
    }, { targetLiquidRateBpd: 500, wctPct: 40 });
    expect(noSurvey.isDeviated).toBeUndefined();
  });
});

describe('ITEM 19: the target rate means LIQUID, and is read as liquid here', () => {
  const s = G.seams.targetRateOilVersusLiquid;

  test('the rules are liquid rules, and the number is taken as given', () => {
    // Two different liquid rates on the same well, scored exactly as the
    // golden has always had them. The rename moved nothing.
    const atOilRate = screenLift({
      targetLiquidRateBpd: s.oilRate, depthFt: 7000, gor: 600, wctPct: s.wctPct, api: 30, bhtF: 210,
    });
    const atLiquidRate = screenLift({
      targetLiquidRateBpd: s.liquidRate, depthFt: 7000, gor: 600, wctPct: s.wctPct, api: 30, bhtF: 210,
    });
    expect(scoreMap(atOilRate)).toEqual(s.asOilScores);
    expect(scoreMap(atLiquidRate)).toEqual(s.asLiquidScores);
  });

  test('NO oil is derived here: the water cut does not touch a rate rule', () => {
    // The screening reads the liquid it is given. Were it deriving oil
    // from the water cut, a 70 per cent cut would drop the duty index by
    // a factor of three and move the rod pump 40 points, which is
    // exactly the difference the golden records between the two rates.
    const dry = scoreMap(screenLift({
      targetLiquidRateBpd: s.liquidRate, depthFt: 7000, gor: 600, wctPct: 0, api: 30, bhtF: 210,
    }));
    const wet = scoreMap(screenLift({
      targetLiquidRateBpd: s.liquidRate, depthFt: 7000, gor: 600, wctPct: s.wctPct, api: 30, bhtF: 210,
    }));
    expect(dry).toEqual(wet);
    expect(wet.rodPump).toBe(s.asLiquidScores.rodPump);
    expect(s.asOilScores.rodPump - s.asLiquidScores.rodPump).toBe(40);
  });

  test('and the old key is gone: a rate named targetRate is not a rate', () => {
    const out = screenLift({ targetRate: 700, depthFt: 6500, gor: 400, api: 35, bhtF: 210 });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('missingInputs');
    expect(out.error).toMatch(/targetLiquidRateBpd/);
  });

  test('the door states the phase, in the reason a user reads', () => {
    const heavyDuty = screenLift({ targetLiquidRateBpd: 3000, depthFt: 9000, gor: 400, api: 35, bhtF: 210 });
    const duty = heavyDuty.find((r) => r.id === 'rodPump').reasons
      .find((x) => /past what a rod string comfortably carries/.test(x.text));
    expect(duty.text).toMatch(/3,000 bbl\/d at 9,000 ft/);
  });
});
