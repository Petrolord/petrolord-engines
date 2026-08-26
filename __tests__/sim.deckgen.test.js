// S3 deck-generation gates: serializer pins per keyword + the composed
// reference deck (SPE1-equivalent spec). Flow acceptance of the composed
// deck runs in the Suite's sim-worker image (test_generated_deck.py) —
// this suite pins the TEXT the emitters produce.
import { fmt, starRepeat } from '../engines/sim/deckFormat.js';
import {
  emitPVTO, emitPVDG, emitPVTW, emitROCK, emitDENSITY, pvtoRecordsFromTable,
} from '../engines/sim/emitPvt.js';
import { emitSWOF, emitSGOF, resamplePc } from '../engines/sim/emitSatFns.js';
import { emitGrid, gridCellCount } from '../engines/sim/emitGrid.js';
import {
  emitWELSPECS, emitCOMPDAT, emitWCONPROD, emitWCONINJE, emitTSTEP,
} from '../engines/sim/emitSchedule.js';
import { composeDeck, validateSpec, eclDate } from '../engines/sim/composeDeck.js';
import { referenceSpec } from '../engines/sim/referenceSpec.js';

describe('deckFormat', () => {
  test('fmt trims and survives tiny magnitudes', () => {
    expect(fmt(1000)).toBe('1000');
    expect(fmt(1.5)).toBe('1.5');
    expect(fmt(0.30000001, 4)).toBe('0.3');
    expect(fmt(3.22e-6, 8)).toBe('0.00000322');
    expect(fmt(3e-9, 4)).toBe('3.0000e-9');
    expect(() => fmt(NaN)).toThrow();
  });

  test('starRepeat compresses runs', () => {
    expect(starRepeat([1, 1, 1, 2])).toBe('3*1 2');
    expect(starRepeat([5])).toBe('5');
    expect(starRepeat([0.3, 0.3])).toBe('2*0.3');
  });
});

describe('emitPvt', () => {
  test('PVTO serializes saturated nodes and undersaturated branches', () => {
    const text = emitPVTO([
      { rs: 0.1, p: 300, bo: 1.15, muo: 0.97 },
      { rs: 1.0, p: 4000, bo: 1.69, muo: 0.51, undersat: [{ p: 9000, bo: 1.58, muo: 0.74 }] },
    ]);
    expect(text).toContain('PVTO');
    expect(text).toContain('  0.1  300 1.15 0.97 /');
    expect(text).toContain('  1  4000 1.69 0.51');
    expect(text).toContain('         9000 1.58 0.74 /');
    expect(text.trimEnd().endsWith('/')).toBe(true);
  });

  test('PVTO rejects non-increasing Rs and bad branches', () => {
    expect(() => emitPVTO([{ rs: 1, p: 1, bo: 1, muo: 1 }, { rs: 1, p: 2, bo: 1, muo: 1 }])).toThrow(/Rs/);
    expect(() => emitPVTO([{ rs: 1, p: 4000, bo: 1, muo: 1, undersat: [{ p: 3000, bo: 1, muo: 1 }] }]))
      .toThrow(/undersaturated/);
  });

  test('pvtoRecordsFromTable collapses duplicate Rs and closes the last node', () => {
    const recs = pvtoRecordsFromTable(
      [
        { p: 300, rs: 0.1, bo: 1.1, muo: 1 },
        { p: 400, rs: 0.1, bo: 1.12, muo: 0.98 }, // duplicate Rs: dropped
        { p: 4000, rs: 1.0, bo: 1.7, muo: 0.5 },
      ],
      [{ p: 6000, bo: 1.65, muo: 0.55 }],
    );
    expect(recs).toHaveLength(2);
    expect(recs[1].undersat).toHaveLength(1);
  });

  test('PVDG requires ascending pressure', () => {
    expect(() => emitPVDG([{ p: 100, bg: 10, mug: 0.01 }, { p: 100, bg: 9, mug: 0.01 }])).toThrow();
    const text = emitPVDG([{ p: 14.7, bg: 166.666, mug: 0.008 }, { p: 5000, bg: 0.65, mug: 0.03 }]);
    expect(text).toContain('  14.7 166.666 0.008');
  });

  test('PVTW/ROCK/DENSITY single records', () => {
    expect(emitPVTW({ pref: 4017.55, bw: 1.038, cw: 3.22e-6, muw: 0.318 }))
      .toContain('  4017.55 1.038 0.00000322 0.318 0 /');
    expect(emitROCK({ pref: 14.7, cr: 3e-6 })).toContain('  14.7 0.000003 /');
    expect(emitDENSITY({ oil: 53.66, water: 64.49, gas: 0.0533 }))
      .toContain('  53.66 64.49 0.0533 /');
  });
});

describe('emitSatFns', () => {
  test('SWOF serializes with Pc column and validates kr range', () => {
    const text = emitSWOF([
      { Sw: 0.12, krw: 0, krow: 1 },
      { Sw: 1, krw: 0.00001, krow: 0, pcow: 0 },
    ]);
    expect(text).toContain('SWOF');
    expect(text).toContain('  0.12 0 1 0');
    expect(() => emitSWOF([{ Sw: 0.2, krw: 1.5, krow: 1 }])).toThrow(/kr/);
    expect(() => emitSWOF([{ Sw: 0.5, krw: 0, krow: 1 }, { Sw: 0.4, krw: 0, krow: 1 }])).toThrow(/non-decreasing/);
  });

  test('resamplePc aligns a Pc grid onto the kr Sw grid', () => {
    const pc = [{ Sw: 0.2, Pc_psi: 10 }, { Sw: 0.8, Pc_psi: 1 }];
    const out = resamplePc(pc, [0.1, 0.5, 0.9]);
    expect(out[0]).toBe(10);           // clamped low
    expect(out[1]).toBeCloseTo(5.5);   // linear midpoint
    expect(out[2]).toBe(1);            // clamped high
  });
});

describe('emitGrid', () => {
  test('layer-cake grid with per-layer constants', () => {
    const spec = referenceSpec().grid;
    const text = emitGrid(spec);
    expect(text).toContain('DX');
    expect(text).toContain('300*1000 /');
    expect(text).toContain('DZ');
    expect(text).toContain('100*20 100*30 100*50 /');
    expect(text).toContain('TOPS');
    expect(text).toContain('100*8325 /');
    expect(text).toContain('PERMX');
    expect(text).toContain('100*500 100*50 100*200 /');
    expect(gridCellCount(spec)).toBe(300);
  });

  test('rejects mismatched layer count', () => {
    expect(() => emitGrid({ nx: 2, ny: 2, nz: 2, dx: 1, dy: 1, topsDepth: 1, layers: [{ dz: 1, poro: 0.1, permx: 1, permz: 1 }] }))
      .toThrow(/layer/);
  });
});

describe('emitSchedule', () => {
  const wells = referenceSpec().wells;
  test('WELSPECS/COMPDAT/controls match the SPE1 shapes', () => {
    expect(emitWELSPECS(wells)).toContain("  'PROD' 'G1' 10 10 8400 'OIL' /");
    expect(emitWELSPECS(wells)).toContain("  'INJ' 'G1' 1 1 8335 'GAS' /");
    expect(emitCOMPDAT(wells)).toContain("  'PROD' 10 10 3 3 'OPEN' 1* 1* 0.5 /");
    expect(emitWCONPROD([wells[0]])).toContain("  'PROD' 'OPEN' 'ORAT' 20000 4* 1000 /");
    expect(emitWCONINJE([wells[1]])).toContain("  'INJ' 'GAS' 'OPEN' 'RATE' 100000 1* 9014 /");
  });

  test('TSTEP star-repeats and validates', () => {
    expect(emitTSTEP([{ count: 60, dtDays: 30.4375 }])).toContain(' 60*30.438 /');
    expect(() => emitTSTEP([{ count: 0, dtDays: 30 }])).toThrow();
  });

  test('rejects hostile well names', () => {
    expect(() => emitWELSPECS([{ ...wells[0], name: "P' INCLUDE" }])).toThrow(/name/);
  });
});

describe('composeDeck', () => {
  test('eclDate formats', () => {
    expect(eclDate('2015-01-01')).toBe("1 'JAN' 2015");
    expect(() => eclDate('01/2015')).toThrow();
  });

  test('validateSpec reports actionable errors', () => {
    const { ok, errors } = validateSpec({ title: 'x' });
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/start date/i);
    expect(errors.join(' ')).toMatch(/Grid dimensions/i);
  });

  test('reference spec composes with every required section in order', () => {
    const deck = composeDeck(referenceSpec());
    const order = ['RUNSPEC', 'DIMENS', 'DISGAS', 'FIELD', 'START', 'GRID', 'PROPS',
      'SWOF', 'SGOF', 'DENSITY', 'PVTW', 'PVDG', 'PVTO', 'ROCK',
      'SOLUTION', 'EQUIL', 'RSVD', 'SUMMARY', 'SCHEDULE', 'WELSPECS',
      'COMPDAT', 'WCONPROD', 'WCONINJE', 'TSTEP', 'END'];
    let last = -1;
    order.forEach((kw) => {
      const idx = deck.indexOf(`\n${kw}`);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    });
    // The equilibration keeps the box in the oil leg with constant Rs.
    expect(deck).toContain('  8400 4800 8450 0 8300 0 1 0 0 /');
    expect(deck).toContain('RSVD');
    expect(deck).toContain('1.27');
    // Summary requests exactly the worker's charted vectors.
    ['FOPR', 'FOPT', 'FWCT', 'FGOR', 'FPR', 'WBHP', 'WOPR'].forEach((k) => {
      expect(deck).toContain(`\n${k}`);
    });
    // No banned keywords sneak in (worker deny-list stays green).
    expect(deck).not.toMatch(/PYACTION|PYINPUT|PATHS/);
  });

  test('deck output is deterministic', () => {
    expect(composeDeck(referenceSpec())).toBe(composeDeck(referenceSpec()));
  });
});
