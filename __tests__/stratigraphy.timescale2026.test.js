/**
 * ICS chart versions (AppUpgrade STRAT-U2-003, 2026-09-30).
 *
 * Gate: the engine's 2026/06 table against the chart's OWN printed numbers
 * (test-data/stratigraphy/ics-chart-2026-06-numbers.txt, the numeric column
 * of the published PDF read with pdftotext, verbatim). Every distinct number
 * the chart prints is a base in the table and every base in the table is
 * printed on the chart, and "~" on the chart is `approx` in the table. This
 * reads the shipped tables through the exported lookups; nothing restates
 * them. Negative control: the same check on the 2023/09 table fails on
 * exactly the J/K and the other moved boundaries, and against the 2023/09
 * chart it fails on exactly the three recorded errata.
 */
import fs from 'fs';
import path from 'path';
import {
  TIMESCALE_VERSION, TIMESCALE_VERSIONS, TIMESCALE_V2023, TIMESCALE_V2026, TIMESCALE_ERRATA,
  timescaleUnits, ageBounds, unitAt, unitsOfRank, boundaryChanges, ageOnChart, isTimescaleVersion,
} from '../engines/stratigraphy/timescale';

const readChart = (v) => {
  const txt = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'stratigraphy', `ics-chart-${v}-numbers.txt`), 'utf8');
  const out = new Map(); // value -> approx
  for (const line of txt.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const m = line.match(/^(~)?\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!m) throw new Error(`unreadable chart line "${line}"`);
    const v2 = Number(m[2]);
    out.set(v2, (out.get(v2) || false) || !!m[1]);
  }
  return out;
};
const tableBases = (version) => {
  const out = new Map();
  for (const u of timescaleUnits(version)) out.set(u.base_ma, (out.get(u.base_ma) || false) || u.approx);
  return out;
};
const diff = (chart, tbl) => ({
  notInTable: [...chart.keys()].filter((v) => !tbl.has(v)).sort((a, b) => a - b),
  notOnChart: [...tbl.keys()].filter((v) => !chart.has(v)).sort((a, b) => a - b),
  approxDiffers: [...chart.keys()].filter((v) => tbl.has(v) && tbl.get(v) !== chart.get(v)).sort((a, b) => a - b),
});

describe('gate: the 2026/06 table is the printed 2026/06 chart', () => {
  test('every printed number is a base, every base is printed, "~" is approx', () => {
    const d = diff(readChart('2026-06'), tableBases(TIMESCALE_V2026));
    expect(d).toEqual({ notInTable: [], notOnChart: [], approxDiffers: [] });
  });

  test('negative control: the 2023/09 table is not the 2026/06 chart (J/K among the misses)', () => {
    const d = diff(readChart('2026-06'), tableBases(TIMESCALE_V2023));
    expect(d.notInTable).toContain(143.1);
    expect(d.notOnChart).toContain(145.0);
    expect(d.notInTable.length).toBeGreaterThan(40);
  });

  test('the 2023/09 table as shipped differs from the printed 2023/09 chart only in its recorded errata', () => {
    const d = diff(readChart('2023-09'), tableBases(TIMESCALE_V2023));
    expect(d.notInTable).toEqual(TIMESCALE_ERRATA.map((e) => e.chart_ma).sort((a, b) => a - b));
    expect(d.notOnChart).toEqual(TIMESCALE_ERRATA.map((e) => e.table_ma).sort((a, b) => a - b));
  });
});

describe('the current chart is 2026/06', () => {
  test('default version, known versions, unknown refused', () => {
    expect(TIMESCALE_VERSION).toBe('ICS 2026/06');
    expect(TIMESCALE_VERSIONS).toEqual(['ICS 2023/09', 'ICS 2026/06']);
    expect(isTimescaleVersion('ICS 2023/09')).toBe(true);
    expect(isTimescaleVersion('ICS 2031/01')).toBe(false);
    expect(() => ageBounds('Danian', 'ICS 2031/01')).toThrow(/Unknown timescale version "ICS 2031\/01"/);
  });

  test.each([
    ['Cretaceous', 66.0, 143.1],
    ['Jurassic', 143.1, 201.4],
    ['Valanginian', 132.6, 137.05],
    ['Santonian', 83.6, 85.7],
    ['Chattian', 23.04, 27.30],
    ['Triassic', 201.4, 251.902],
    ['Wuchiapingian', 254.14, 259.857],
    ['Anisian', 241.464, 247.0],
    ['Olenekian', 247.0, 250.8],
    ['Induan', 250.8, 251.902],
    ['Cambrian', 486.85, 538.8],
    ['Hadean', 4031, 4567],
  ])('%s spans %s to %s Ma by default', (name, top, base) => {
    expect(ageBounds(name)).toMatchObject({ top_ma: top, base_ma: base });
  });

  test('the same 102 Phanerozoic stages, same names, and 144 Ma is Tithonian now (Berriasian on 2023/09)', () => {
    expect(unitsOfRank('age').map((u) => u.name)).toEqual(unitsOfRank('age', TIMESCALE_V2023).map((u) => u.name));
    expect(unitAt(144).name).toBe('Tithonian');
    expect(unitAt(144, TIMESCALE_V2023).name).toBe('Berriasian');
  });
});

describe('what moved, and what it means for a typed age', () => {
  test('boundaryChanges names the J/K with its coarser units and the numeric change', () => {
    const jk = boundaryChanges(TIMESCALE_V2023).find((b) => b.name === 'Berriasian');
    expect(jk).toMatchObject({ from_ma: 145.0, to_ma: 143.1, delta_ma: -1.9, label: 'base of the Berriasian (base of the Cretaceous)' });
    expect(jk.alsoBaseOf).toEqual(['Cretaceous', 'Lower Cretaceous']);
    const names = boundaryChanges(TIMESCALE_V2023).map((b) => b.name);
    for (const n of ['Chattian', 'Bartonian', 'Santonian', 'Valanginian', 'Wuchiapingian', 'Anisian', 'Olenekian', 'Barremian']) expect(names).toContain(n);
    expect(names).not.toContain('Danian');   // 66.0 and 66.00 are one number
    expect(names).not.toContain('Hettangian');
    expect(boundaryChanges(TIMESCALE_V2026, TIMESCALE_V2026)).toEqual([]);
  });

  test('an age on a moved boundary is offered the new number; an age off every boundary keeps its own and says if its stage changed', () => {
    expect(ageOnChart(145.0, TIMESCALE_V2023).update).toMatchObject({ boundary: 'Berriasian', from_ma: 145.0, to_ma: 143.1, delta_ma: -1.9 });
    expect(ageOnChart(129.4, TIMESCALE_V2023).update).toMatchObject({ boundary: 'Barremian', to_ma: 125.77 });   // shipped erratum
    expect(ageOnChart(66.0, TIMESCALE_V2023).update).toBeNull();                                                 // did not move
    expect(ageOnChart(144.0, TIMESCALE_V2023)).toEqual({ update: null, stageFrom: 'Berriasian', stageTo: 'Tithonian' });
    expect(ageOnChart(12.0, TIMESCALE_V2023)).toEqual({ update: null, stageFrom: 'Serravallian', stageTo: 'Serravallian' });
    expect(ageOnChart(145.0, TIMESCALE_V2026).update).toBeNull();                                                // already current
    expect(ageOnChart(NaN, TIMESCALE_V2023)).toEqual({ update: null, stageFrom: null, stageTo: null });
  });
});
