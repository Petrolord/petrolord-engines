// S4 gates: structural tops, trajectory -> connections geometry, and the
// history schedule (WCONHIST/WCONINJH + DATES). Text pins as in the S3
// suite; flow acceptance of a composed S4 deck runs in the Suite's
// sim-worker image (test_generated_deck.py).
import { eclDate, daysBetween } from '../engines/sim/deckFormat.js';
import {
  emitGrid, topsArray, columnInterfaces, gridDepthRange,
} from '../engines/sim/emitGrid.js';
import {
  cellAtPoint, connectionsFromPath, cellCenterXY,
} from '../engines/sim/wellPath.js';
import {
  emitCOMPDAT, emitWELSPECS, emitWCONHIST, emitWCONINJH, emitDATES,
  emitHistorySchedule, historyStepCount, wellHeadIJ,
} from '../engines/sim/emitSchedule.js';
import { composeDeck, validateSpec } from '../engines/sim/composeDeck.js';
import { referenceSpec } from '../engines/sim/referenceSpec.js';

// 4x3x2 structural grid dipping east: column tops rise with I.
const structGrid = () => ({
  nx: 4, ny: 3, nz: 2, dx: 100, dy: 100,
  tops: [
    8000, 8010, 8020, 8030,
    8000, 8010, 8020, 8030,
    8000, 8010, 8020, 8030,
  ],
  layers: [
    { dz: 20, poro: 0.2, permx: 100, permz: 10 },
    { dz: 30, poro: 0.18, permx: 50, permz: 5 },
  ],
});

describe('emitGrid structure (S4)', () => {
  test('per-cell TOPS array emits in natural order with repeats compressed', () => {
    const text = emitGrid(structGrid());
    expect(text).toContain('TOPS');
    expect(text).toContain('8000 8010 8020 8030 8000 8010 8020 8030 8000 8010 8020 8030 /');
  });

  test('tops array is validated for length and positivity', () => {
    expect(() => topsArray({ nx: 4, ny: 3, tops: [1, 2, 3] })).toThrow(/nx\*ny/);
    expect(() => topsArray({ nx: 1, ny: 1, tops: [NaN] })).toThrow(/positive depth/);
    expect(topsArray({ nx: 2, ny: 1, topsDepth: 8000 })).toEqual([8000, 8000]);
  });

  test('columnInterfaces and gridDepthRange track the structure', () => {
    const g = structGrid();
    expect(columnInterfaces(g, 1, 1)).toEqual([8000, 8020, 8050]);
    expect(columnInterfaces(g, 4, 2)).toEqual([8030, 8050, 8080]);
    const d = gridDepthRange(g);
    expect(d.topMin).toBe(8000);
    expect(d.topMax).toBe(8030);
    expect(d.bottomMax).toBe(8080);
    expect(d.thickness).toBe(50);
  });
});

describe('wellPath (S4)', () => {
  test('cellAtPoint honours areal bounds and the local column depths', () => {
    const g = structGrid();
    expect(cellAtPoint(g, { x: 50, y: 50, depth: 8010 })).toEqual({ i: 1, j: 1, k: 1 });
    expect(cellAtPoint(g, { x: 50, y: 50, depth: 8030 })).toEqual({ i: 1, j: 1, k: 2 });
    // Same depth sits ABOVE the dipped-up column at i=4.
    expect(cellAtPoint(g, { x: 350, y: 50, depth: 8010 })).toBeNull();
    expect(cellAtPoint(g, { x: -1, y: 50, depth: 8010 })).toBeNull();
    expect(cellAtPoint(g, { x: 50, y: 50, depth: 9000 })).toBeNull();
  });

  test('vertical path completes every layer in the column, direction Z', () => {
    const g = structGrid();
    const { x, y } = cellCenterXY(g, 2, 2);
    const conns = connectionsFromPath(
      [{ x, y, depth: 7900 }, { x, y, depth: 8100 }], g,
    );
    expect(conns.map((c) => [c.i, c.j, c.k, c.dir])).toEqual([
      [2, 2, 1, 'Z'], [2, 2, 2, 'Z'],
    ]);
    expect(conns[0].lengthFt).toBeCloseTo(20, 0);
    expect(conns[1].lengthFt).toBeCloseTo(30, 0);
  });

  test('horizontal path tracks one layer across columns, direction X', () => {
    const g = structGrid();
    // At constant depth 8035 the eastward dip moves the lateral up
    // section: layer 2 in columns i=1..2, layer 1 in i=3..4.
    const conns = connectionsFromPath(
      [{ x: 0, y: 150, depth: 8035 }, { x: 400, y: 150, depth: 8035 }], g,
    );
    expect(conns.every((c) => c.dir === 'X')).toBe(true);
    expect(conns.map((c) => [c.i, c.k])).toEqual([[1, 2], [2, 2], [3, 1], [4, 1]]);
    expect(conns[0].lengthFt).toBeCloseTo(100, 0);
  });

  test('re-entered cells merge into one connection with summed length', () => {
    const g = structGrid();
    const { x, y } = cellCenterXY(g, 1, 1);
    const conns = connectionsFromPath([
      { x, y, depth: 8005 },
      { x, y, depth: 8015 },
      { x, y, depth: 8006 },
    ], g);
    expect(conns).toHaveLength(1);
    expect(conns[0].lengthFt).toBeCloseTo(19, 0);
  });

  test('a path that misses the grid returns no connections', () => {
    const g = structGrid();
    expect(connectionsFromPath(
      [{ x: 5000, y: 5000, depth: 8010 }, { x: 5100, y: 5000, depth: 8010 }], g,
    )).toEqual([]);
    expect(() => connectionsFromPath([{ x: 0, y: 0, depth: 1 }], g)).toThrow(/at least 2/);
    expect(() => connectionsFromPath([{ x: 0, y: 0 }, { x: 1, y: 1, depth: 2 }], g)).toThrow(/finite/);
  });
});

describe('emitSchedule history + connections (S4)', () => {
  const devWell = {
    name: 'DEV1',
    type: 'producer',
    refDepth: 8000,
    wellboreRadiusFt: 0.25,
    connections: [
      { i: 1, j: 2, k: 1, dir: 'Z' },
      { i: 2, j: 2, k: 2, dir: 'X' },
    ],
    control: { mode: 'ORAT', rate: 1000, bhpMin: 900 },
  };

  test('COMPDAT emits one record per connection with direction item 13', () => {
    const text = emitCOMPDAT([devWell]);
    expect(text).toContain("  'DEV1' 1 2 1 1 'OPEN' 1* 1* 0.5 3* 'Z' /");
    expect(text).toContain("  'DEV1' 2 2 2 2 'OPEN' 1* 1* 0.5 3* 'X' /");
  });

  test('WELSPECS heads a connections well at its first cell', () => {
    expect(wellHeadIJ(devWell)).toEqual({ i: 1, j: 2 });
    expect(emitWELSPECS([devWell])).toContain("  'DEV1' 'G1' 1 2 8000 'OIL' /");
    expect(() => emitCOMPDAT([{ ...devWell, connections: [] }])).toThrow(/empty connections/);
    expect(() => emitCOMPDAT([{ ...devWell, connections: [{ i: 1, j: 1, k: 1, dir: 'Q' }] }]))
      .toThrow(/direction/);
  });

  test('WCONHIST/WCONINJH/DATES pin the history text', () => {
    expect(emitWCONHIST([{ name: 'P1', orat: 1250.5, wrat: 80, grat: 900 }]))
      .toContain("  'P1' 'OPEN' 'ORAT' 1250.5 80 900 /");
    expect(emitWCONINJH([{ name: 'I1', phase: 'WATER', rate: 2000 }]))
      .toContain("  'I1' 'WATER' 'OPEN' 2000 /");
    expect(emitDATES('2020-02-01')).toBe("DATES\n  1 'FEB' 2020 /\n/\n");
    expect(() => emitWCONHIST([{ name: 'P1', orat: -1, wrat: 0, grat: 0 }])).toThrow(/non-negative/);
    expect(() => emitWCONINJH([{ name: 'I1', phase: 'OIL', rate: 1 }])).toThrow(/WATER or GAS/);
  });

  test('history schedule advances period by period to the end date', () => {
    const text = emitHistorySchedule({
      periods: [
        { date: '2020-01-01', prod: [{ name: 'P1', orat: 1000, wrat: 50, grat: 800 }] },
        {
          date: '2020-02-01',
          prod: [{ name: 'P1', orat: 900, wrat: 60, grat: 780 }],
          inj: [{ name: 'I1', phase: 'WATER', rate: 1500 }],
        },
      ],
      endDate: '2020-03-01',
    });
    const feb = text.indexOf("1 'FEB' 2020");
    const mar = text.indexOf("1 'MAR' 2020");
    expect(feb).toBeGreaterThan(text.indexOf("'ORAT' 1000"));
    expect(mar).toBeGreaterThan(text.indexOf("'ORAT' 900"));
    expect(mar).toBeGreaterThan(text.indexOf("'I1' 'WATER' 'OPEN' 1500"));
    expect(historyStepCount({ periods: [{}, {}] })).toBe(2);
    expect(() => emitHistorySchedule({
      periods: [{ date: '2020-02-01', prod: [] }], endDate: '2020-01-01',
    })).toThrow(/ascend/);
  });
});

describe('composeDeck S4', () => {
  const s4Spec = () => {
    const spec = referenceSpec();
    spec.grid = {
      ...spec.grid,
      topsDepth: undefined,
      tops: Array.from({ length: 100 }, (_, idx) => 8325 + (idx % 10) * 5),
    };
    spec.wells = [
      {
        name: 'PROD', type: 'producer', refDepth: 8330, wellboreRadiusFt: 0.25,
        connections: [{ i: 10, j: 10, k: 1, dir: 'Z' }, { i: 10, j: 10, k: 2, dir: 'Z' },
          { i: 9, j: 10, k: 3, dir: 'X' }],
        control: { mode: 'ORAT', rate: 15000, bhpMin: 1000 },
      },
      spec.wells[1], // vertical gas injector, unchanged
    ];
    spec.startDate = '2015-01-01';
    spec.schedule = {
      history: {
        periods: [
          { date: '2015-01-01', prod: [{ name: 'PROD', orat: 18000, wrat: 0, grat: 22000 }] },
          {
            date: '2015-02-01',
            prod: [{ name: 'PROD', orat: 17000, wrat: 10, grat: 21500 }],
            inj: [{ name: 'INJ', phase: 'GAS', rate: 90000 }],
          },
        ],
        endDate: '2015-03-01',
      },
      steps: [{ count: 12, dtDays: 30.4375 }],
    };
    return spec;
  };

  test('history deck carries WCONHIST phase, then the prediction switch', () => {
    const deck = composeDeck(s4Spec());
    const iHist = deck.indexOf('WCONHIST');
    const iPred = deck.indexOf('WCONPROD');
    const iTstep = deck.indexOf('TSTEP');
    expect(iHist).toBeGreaterThan(-1);
    expect(iPred).toBeGreaterThan(iHist);
    expect(iTstep).toBeGreaterThan(iPred);
    expect(deck).toContain('FOPRH');
    expect(deck).toContain('WOPRH');
    expect(deck).toContain('FWIR');
    // WELLDIMS max connections reflects the trajectory (3 cells).
    expect(deck).toMatch(/WELLDIMS\n {2}2 3 2 2 \//);
    // Structural TOPS made it into the GRID section.
    expect(deck).toMatch(/TOPS\n[\s\S]*8370/);
    expect(deck).toContain("1 'MAR' 2015");
  });

  test('history-only decks are valid; misdated or misnamed histories are not', () => {
    const historyOnly = s4Spec();
    delete historyOnly.schedule.steps;
    expect(validateSpec(historyOnly).ok).toBe(true);
    expect(composeDeck(historyOnly)).not.toContain('TSTEP');

    const wrongStart = s4Spec();
    wrongStart.schedule.history.periods[0].date = '2015-01-15';
    expect(validateSpec(wrongStart).errors.join(' ')).toMatch(/must start on the deck start date/);

    const badName = s4Spec();
    badName.schedule.history.periods[0].prod[0].name = 'GHOST';
    expect(validateSpec(badName).errors.join(' ')).toMatch(/GHOST/);

    const missedGrid = s4Spec();
    missedGrid.wells[0].connections = [];
    expect(validateSpec(missedGrid).errors.join(' ')).toMatch(/misses the grid/);
  });

  test('reference (S3) spec still composes unchanged semantics', () => {
    const deck = composeDeck(referenceSpec());
    expect(deck).toContain('WCONPROD');
    expect(deck).not.toContain('WCONHIST');
    expect(deck).toContain('FWIR'); // injection vectors now standard
    expect(daysBetween('2015-01-01', '2015-03-01')).toBe(59);
    expect(eclDate('2015-01-01')).toBe("1 'JAN' 2015");
  });
});
