// Reservoir Simulation Studio U2 deck gates: observed bottomhole pressure in
// the history (WBHPH), the three-phase oil relative permeability choice and
// the analytical aquifer. Text pins as in the S3/S4 suites; OPM Flow runs the
// composed decks in the Suite's sim-worker image (test_u2_deck.py), where the
// simulator itself is the gate.
import {
  emitWCONHIST, emitWCONINJH, historyHasBhp,
} from '../engines/sim/emitSchedule.js';
import { composeDeck, validateSpec } from '../engines/sim/composeDeck.js';
import { emitThreePhase } from '../engines/sim/emitSatFns.js';
import { referenceSpec } from '../engines/sim/referenceSpec.js';

const historySpec = (bhp = true) => {
  const spec = referenceSpec();
  spec.schedule = {
    history: {
      periods: [
        { date: spec.startDate, prod: [{ name: spec.wells[0].name, orat: 1000, wrat: 0, grat: 800, ...(bhp ? { bhp: 3500 } : {}) }] },
        { date: '2015-02-01', prod: [{ name: spec.wells[0].name, orat: 900, wrat: 10, grat: 750 }] },
      ],
      endDate: '2015-03-01',
    },
    steps: [{ count: 2, dtDays: 30 }],
  };
  return spec;
};

describe('SIM-U2-001 observed bottomhole pressure (WBHPH)', () => {
  test('a row with an observed BHP writes it to WCONHIST item 10; a row without is unchanged', () => {
    expect(emitWCONHIST([{ name: 'P1', orat: 1250.5, wrat: 80, grat: 900, bhp: 2875.25 }]))
      .toBe("WCONHIST\n  'P1' 'OPEN' 'ORAT' 1250.5 80 900 3* 2875.25 /\n/\n");
    expect(emitWCONHIST([{ name: 'P1', orat: 1250.5, wrat: 80, grat: 900 }]))
      .toBe("WCONHIST\n  'P1' 'OPEN' 'ORAT' 1250.5 80 900 /\n/\n");
    expect(emitWCONINJH([{ name: 'I1', phase: 'WATER', rate: 2500, bhp: 5200 }]))
      .toBe("WCONINJH\n  'I1' 'WATER' 'OPEN' 2500 5200 /\n/\n");
    expect(() => emitWCONHIST([{ name: 'P1', orat: 1, wrat: 0, grat: 0, bhp: -5 }])).toThrow(/positive pressure/);
    expect(() => emitWCONHIST([{ name: 'P1', orat: 1, wrat: 0, grat: 0, bhp: 'abc' }])).toThrow(/positive pressure/);
  });

  test('WBHPH is asked for only when the history carries a pressure', () => {
    expect(historyHasBhp(historySpec(true).schedule.history)).toBe(true);
    expect(historyHasBhp(historySpec(false).schedule.history)).toBe(false);
    const withP = composeDeck(historySpec(true));
    expect(withP).toMatch(/\nWBHPH\n\/\n/);
    expect(withP).toContain("'OPEN' 'ORAT' 1000 0 800 3* 3500 /");
    // negative control: the same history without pressures composes without WBHPH
    const without = composeDeck(historySpec(false));
    expect(without).not.toContain('WBHPH');
    expect(withP.replace(/ 3\* 3500/, '').replace('WBHPH\n/\n\n', '')).toBe(without);
  });
});

describe('SIM-U2-003 three-phase oil relative permeability', () => {
  test('STONE1 or STONE2 after the two-phase tables; the default writes no keyword', () => {
    expect(emitThreePhase('stone1')).toBe('STONE1\n');
    expect(emitThreePhase('stone2')).toBe('STONE2\n');
    expect(emitThreePhase('default')).toBe('');
    expect(emitThreePhase(undefined)).toBe('');
    expect(() => emitThreePhase('stone3')).toThrow(/unknown three-phase model/);
    expect(() => emitThreePhase('constructor')).toThrow(/unknown three-phase model/);
    const spec = referenceSpec();
    const plain = composeDeck(spec);
    spec.satfn.threePhase = 'stone2';
    const s2 = composeDeck(spec);
    expect(s2).toMatch(/SGOF\n[\s\S]*?\/\n\nSTONE2\n\nDENSITY/);
    // negative control: the explicit default composes byte for byte as no choice
    spec.satfn.threePhase = 'default';
    expect(composeDeck(spec)).toBe(plain);
    expect(s2.replace('STONE2\n\n', '')).toBe(plain);
    expect(validateSpec(spec).ok).toBe(true);
  });
});

describe('SIM-U2-004 analytical aquifer', () => {
  const conn = { face: 'I-', i1: 1, i2: 1, j1: 1, j2: 10, k1: 1, k2: 3 };
  const fet = { model: 'fetkovich', datumDepth: 8400, fetkovich: { volume: 11048888889, ct: 7e-6, pi: 116.5 }, connection: conn };
  const ct = {
    model: 'carter_tracy', datumDepth: 8400,
    carterTracy: { k: 116.36, phi: 0.25, ct: 7e-6, r0: 9200, h: 100, theta: 140, influence: [{ tD: 0.01, pD: 0.112 }, { tD: 1, pD: 0.802 }, { tD: 10, pD: 1.65 }] },
    connection: conn,
  };
  test('Fetkovich: AQUDIMS, AQUFETP with twelve significant figures, AQUANCON and the influx vectors', () => {
    const spec = referenceSpec();
    spec.aquifer = fet;
    const deck = composeDeck(spec);
    expect(deck).toContain('AQUDIMS\n  1* 1* 1 36 1 30 /');
    expect(deck).toContain('AQUFETP\n  1 8400 1* 11048888889 0.000007 116.5 1 /\n/');
    expect(deck).toContain("AQUANCON\n  1 1 1 1 10 1 3 'I-' /\n/");
    expect(deck).toMatch(/\nAAQR\n {2}1 \/\n\nAAQT\n {2}1 \/\n\nAAQP\n {2}1 \/\n/);
    expect(deck).not.toMatch(/FAQ[RT]/);
    expect(deck).not.toContain('AQUTAB');
    // the SOLUTION section holds the aquifer, RUNSPEC its dimensions
    expect(deck.indexOf('AQUDIMS')).toBeLessThan(deck.indexOf('\nGRID'));
    expect(deck.indexOf('AQUFETP')).toBeGreaterThan(deck.indexOf('\nSOLUTION'));
    expect(deck.indexOf('AQUFETP')).toBeLessThan(deck.indexOf('\nSUMMARY'));
  });
  test('Carter-Tracy: the influence table becomes table 2, AQUCT names it', () => {
    const spec = referenceSpec();
    spec.aquifer = ct;
    const deck = composeDeck(spec);
    expect(deck).toContain('AQUDIMS\n  1* 1* 2 36 1 30 /');
    expect(deck).toContain('AQUTAB\n  0.01 0.112\n  1 0.802\n  10 1.65\n/');
    expect(deck).toContain('AQUCT\n  1 8400 1* 116.36 0.25 0.000007 9200 100 140 1 2 /\n/');
  });
  test('refusals by name; a spec without an aquifer composes as before', () => {
    const spec = referenceSpec();
    const plain = composeDeck(spec);
    expect(plain).not.toMatch(/AQU|AAQ/);
    spec.aquifer = { ...fet, fetkovich: { ...fet.fetkovich, pi: 0 } };
    expect(validateSpec(spec).errors.join(' ')).toMatch(/productivity index must be positive/);
    spec.aquifer = { ...fet, connection: { ...conn, j2: 99 } };
    expect(validateSpec(spec).errors.join(' ')).toMatch(/inside the grid/);
    spec.aquifer = { ...ct, carterTracy: { ...ct.carterTracy, influence: [{ tD: 1, pD: 1 }, { tD: 0.5, pD: 2 }] } };
    expect(validateSpec(spec).errors.join(' ')).toMatch(/tD must increase/);
    spec.aquifer = { ...fet, model: 'numerical' };
    expect(validateSpec(spec).errors.join(' ')).toMatch(/model must be fetkovich or carter_tracy/);
    spec.aquifer = { ...fet, connection: { ...conn, face: 'X' } };
    expect(validateSpec(spec).errors.join(' ')).toMatch(/connection face/);
  });
});
