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
 * TWO SEAMS ARE GATED AS FINDINGS, NOT AS CORRECT BEHAVIOUR. A missing
 * API is read as ultra-heavy crude and swings the ESP and the PCP 45
 * points apart on no information; and the same `targetRate` is
 * documented as liquid here and used as oil by the design pass, which
 * on a 70 per cent water-cut well costs rod pumping 40 points and
 * reorders the list.
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
      const got = screenLift(a.inputs);
      expect(got.map((r) => r.id)).toEqual(a.result.map((r) => r.id));
      got.forEach((r, i) => {
        expect(r.score).toBe(a.result[i].score);
        expect(r.recommended).toBe(a.result[i].recommended);
      });
    });
  });

  test('and emits exactly the reasons the ledger says, in kind and in order', () => {
    G.archetypes.forEach((a) => {
      const got = screenLift(a.inputs);
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
      const got = screenLift(c.inputs);
      expect(scoreMap(got)).toEqual(c.scores);
      expect(got.map((r) => r.id)).toEqual(c.order);
    });
  });
});

describe('the archetypes rank the way an engineer would argue', () => {
  test.each(G.archetypes.map((a) => [a.id, a]))('%s', (_id, a) => {
    const got = screenLift(a.inputs);
    // The named method must be at the top, or tied at the top.
    const top = got[0].score;
    const winners = got.filter((r) => r.score === top).map((r) => r.id);
    expect(a.expectTop.some((m) => winners.includes(m))).toBe(true);
    expect(a.why.length).toBeGreaterThan(40);
  });

  test('no power at the wellsite is decisive against an ESP, and no gas against gas lift', () => {
    const noPower = scoreMap(screenLift(G.archetypes.find((a) => a.id === 'noPower').inputs));
    const noGas = scoreMap(screenLift(G.archetypes.find((a) => a.id === 'noGas').inputs));
    expect(noPower.gasLift).toBeGreaterThan(noPower.esp);
    expect(noGas.esp).toBeGreaterThan(noGas.gasLift);
  });

  test('rod pumping is limited by depth AND rate together, not by either alone', () => {
    const shallowFast = scoreMap(screenLift({ targetRate: 2000, depthFt: 1000, api: 32, bhtF: 150 }));
    const deepSlow = scoreMap(screenLift({ targetRate: 100, depthFt: 12000, api: 32, bhtF: 150 }));
    const deepFast = scoreMap(screenLift({ targetRate: 2000, depthFt: 12000, api: 32, bhtF: 150 }));
    // 2.0 and 1.2 duty index are both comfortable; 24 is not.
    expect(shallowFast.rodPump).toBeGreaterThan(deepFast.rodPump);
    expect(deepSlow.rodPump).toBeGreaterThan(deepFast.rodPump);
  });
});

describe('the structural properties', () => {
  test('AN ADVERSE CONDITION NEVER RAISES A SCORE', () => {
    const base = scoreMap(screenLift(G.monotonicity.base));
    expect(base).toEqual(G.monotonicity.baseScores);
    G.monotonicity.cases.forEach((c) => {
      const inputs = { ...G.monotonicity.base, [c.condition]: c.turnedOn };
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
      targetRate: 3000, depthFt: 14000, gor: 20, api: 45, bhtF: 340, wctPct: 20,
      hasSand: true, isHorizontal: true, isOffshore: true,
      powerAvailable: false, gasAvailable: false, reservoirPressureLow: true,
    }));
    expect(Math.min(...Object.values(awful))).toBe(0);
  });

  test('recommended is a BAND recomputed from the scores, not a winner', () => {
    G.sweep.forEach((c) => {
      const got = screenLift(c.inputs);
      const top = got[0].score;
      const expected = got.filter((r) => r.score >= top - 15 && r.score > 50).map((r) => r.id);
      expect(got.filter((r) => r.recommended).map((r) => r.id)).toEqual(expected);
      expect(expected).toEqual(c.recommended);
    });
  });

  test('best first, and a tie keeps catalog order', () => {
    G.sweep.forEach((c) => {
      const got = screenLift(c.inputs);
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

describe('SEAM 1: a missing input is not a neutral input', () => {
  const s = G.seams.missingApiIsHeavy;

  test('an absent API is coerced to zero and read as heavier than any real crude', () => {
    const known = scoreMap(screenLift(s.known));
    const missing = scoreMap(screenLift({ ...s.known, api: undefined }));
    expect(known).toEqual(s.knownScores);
    expect(missing).toEqual(s.missingScores);
  });

  test('which swings the ESP and the PCP 45 points apart on NO information', () => {
    expect(s.deltas.esp).toBe(-20);
    expect(s.deltas.pcp).toBe(25);
    expect(Math.abs(s.deltas.esp) + s.deltas.pcp).toBe(45);
    // And the PCP gains its single strongest reason for it.
    const missing = screenLift({ ...s.known, api: undefined });
    const pcp = missing.find((r) => r.id === 'pcp');
    expect(pcp.reasons.some((r) => r.type === 'pro' && /best in the world/.test(r.text))).toBe(true);
  });

  test('and the model reader can hand back exactly that undefined API', () => {
    // screeningInputsFromModel reads what the well model knows. A model
    // with no fluid description hands back an undefined api and gor,
    // which screenLift then reads as dead, ultra-heavy crude.
    const bare = screeningInputsFromModel({
      tvdMax: 6000, tAt: () => 190, trajectory: { mdMax: 6000 },
    }, { targetRate: 500, wctPct: 40 });
    expect(bare.api).toBeUndefined();
    expect(bare.gor).toBeUndefined();
    expect(bare.depthFt).toBe(6000);
    expect(bare.bhtF).toBe(190);
    expect(bare.isDeviated).toBe(false);
    expect(screeningInputsFromModel(null)).toEqual({});
  });

  test('a deviated well is read off the survey, not asked for twice', () => {
    const dev = screeningInputsFromModel({
      tvdMax: 6000, tAt: () => 190, trajectory: { mdMax: 6800 },
      fluidModel: { api: 30, gor: 400 },
    }, { targetRate: 500, wctPct: 40 });
    expect(dev.isDeviated).toBe(true);
    expect(dev.api).toBe(30);
  });
});

describe('SEAM 2: the same targetRate is liquid here and oil in the design pass', () => {
  const s = G.seams.targetRateOilVersusLiquid;

  test('the shipped studio passes the OIL rate to rules written about liquid', () => {
    const asOil = screenLift({
      targetRate: s.oilRate, depthFt: 7000, gor: 600, wctPct: s.wctPct, api: 30, bhtF: 210,
    });
    const asLiquid = screenLift({
      targetRate: s.liquidRate, depthFt: 7000, gor: 600, wctPct: s.wctPct, api: 30, bhtF: 210,
    });
    expect(scoreMap(asOil)).toEqual(s.asOilScores);
    expect(scoreMap(asLiquid)).toEqual(s.asLiquidScores);
  });

  test('and on a 70 per cent water-cut well the reading REORDERS the list', () => {
    // Rod pumping is scored on a duty index of rate x depth: at 300 the
    // string is comfortable, at 1000 it is not. Forty points, and a
    // change of place.
    expect(s.asOilScores.rodPump - s.asLiquidScores.rodPump).toBe(40);
    expect(s.asOilScores.esp - s.asLiquidScores.esp).toBe(-15);
    expect(s.asOilOrder).not.toEqual(s.asLiquidOrder);
    expect(s.asOilOrder.indexOf('rodPump')).toBeLessThan(s.asLiquidOrder.indexOf('rodPump'));
  });
});

describe('screening nothing at all', () => {
  test('still returns six methods and a winner, which is worth knowing', () => {
    const got = screenLift({});
    expect(scoreMap(got)).toEqual(scoreMap(G.emptyInput));
    expect(got).toHaveLength(6);
    // With no information entered the matrix declares rod pumping the
    // answer, because every zero reads as the most favourable case for
    // it (a duty index of zero, no gas interference, low rate). Gated
    // as it behaves, and it is the same seam as the missing API.
    expect(got[0].id).toBe('rodPump');
    expect(got[0].score).toBe(100);
  });

  test('undefined and null inputs are the same as an empty object', () => {
    expect(scoreMap(screenLift(undefined))).toEqual(scoreMap(screenLift({})));
    expect(scoreMap(screenLift(null))).toEqual(scoreMap(screenLift({})));
  });
});
