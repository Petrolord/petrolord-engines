/**
 * Wheeler chart (ST2) against the hand-derived three-well synthetic
 * (test-data/stratigraphy/wheeler-synthetic.json + README.md).
 */
import fixture from '../test-data/stratigraphy/wheeler-synthetic.json';
import { wheelerChart, wellCells, cellAt, hiatusDuration } from '../engines/stratigraphy/wheeler';

const pick = (c) => ({ kind: c.kind, from_ma: c.from_ma, to_ma: c.to_ma, top_md_m: c.top_md_m, base_md_m: c.base_md_m, tract: c.tract, label: c.label });

test('every well reproduces its golden cells, in age order, with the tract the surfaces imply', () => {
  const chart = wheelerChart(fixture.wells);
  expect(chart.skipped).toEqual([]);
  expect(chart.age_min_ma).toBe(fixture.expected.age_min_ma);
  expect(chart.age_max_ma).toBe(fixture.expected.age_max_ma);
  expect(chart.boundaries).toEqual(fixture.expected.boundaries);
  for (const w of chart.wells) {
    expect(w.cells.map(pick)).toEqual(fixture.expected.cells[w.id]);
    expect(hiatusDuration(w)).toBe(fixture.expected.hiatus_duration_ma[w.id]);
  }
  expect(chart.wells.map((w) => w.x)).toEqual([0, 1000, 2000]);
});

test('tract certainty and names ride along', () => {
  const cells = wellCells(fixture.wells[0]);
  const tst = cells.find((c) => c.tract === 'TST');
  expect(tst).toMatchObject({ upper: 'MFS-1', lower: 'MRS-1', certain: true, wellId: 'w1' });
  const uncertain = wellCells({ id: 'u', surfaces: [{ name: 'SB', md_m: 100, age_ma: 10, surface_type: 'SU' }, { name: 'MFS', md_m: 200, age_ma: 12, surface_type: 'MFS' }, { name: 'Base', md_m: 300, age_ma: 14 }] });
  expect(uncertain[0]).toMatchObject({ tract: 'HST', certain: false, label: 'HST' });
});

test('cellAt: a hiatus wins over the deposition cells touching it; outside is null', () => {
  const chart = wheelerChart(fixture.wells);
  const w1 = chart.wells[0];
  expect(cellAt(w1, 6).tract).toBe('TST');
  expect(cellAt(w1, 10).kind).toBe('hiatus');
  expect(cellAt(w1, 14).kind).toBe('hiatus');
  expect(cellAt(w1, 12).kind).toBe('hiatus');
  expect(cellAt(w1, 15).label).toBe('Base to SB-1');
  expect(cellAt(w1, 20)).toBeNull();
  expect(cellAt(chart.wells[2], 12).kind).toBe('deposition');   // W3 carries the correlative conformity: no hiatus
});

test('wells that cannot be placed are skipped and named; positions fall back to index', () => {
  const chart = wheelerChart([
    { id: 'a', name: 'A', surfaces: [{ md_m: 1, age_ma: 1 }] },
    { id: 'b', name: 'B', surfaces: [{ md_m: 1, age_ma: 5 }, { md_m: 2, age_ma: 1 }] },
    { id: 'c', name: 'C', surfaces: [{ md_m: 1, age_ma: 1 }, { md_m: 2, age_ma: 3 }] },
    { id: 'd', name: 'D', surfaces: [] },
  ]);
  expect(chart.skipped.map((s) => [s.id, s.reason])).toEqual([
    ['a', 'only one dated surface'], ['b', expect.stringMatching(/deeper .* but younger/)], ['d', 'no dated surfaces'],
  ]);
  expect(chart.wells.map((w) => [w.id, w.x])).toEqual([['c', 2]]);
  expect(wheelerChart([]).age_max_ma).toBe(0);
});
