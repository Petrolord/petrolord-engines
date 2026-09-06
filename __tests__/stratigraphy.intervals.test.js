/**
 * Interval-log arithmetic (ST1): ordering, validation, gaps, lookup,
 * merge, rasterizing onto a depth vector, run-length encoding back into
 * intervals, thickness by code. Analytic fixtures with hand-derived
 * answers.
 */
import {
  sortIntervals, validateIntervals, intervalGaps, intervalAt, mergeAdjacent, rasterizeIntervals, intervalsFromRuns, thicknessByCode,
} from '../engines/stratigraphy/intervals';

const I = (kind, top, base, code, extra = {}) => ({ kind, top_md_m: top, base_md_m: base, code, ...extra });

const litho = () => [
  I('lithology', 1510, 1520, 'shale'),
  I('lithology', 1500, 1510, 'sandstone'),
  I('lithology', 1520, 1525, 'shale'),
  I('facies', 1505, 1515, 'A', { properties: { colour: '#ff0000' } }),   // overlaps lithology, a different kind: fine
];

describe('order and validation', () => {
  test('sortIntervals is shallow to deep, then kind, then code', () => {
    expect(sortIntervals(litho()).map((r) => `${r.kind}:${r.top_md_m}`)).toEqual(['lithology:1500', 'facies:1505', 'lithology:1510', 'lithology:1520']);
  });

  test('a sound set has no problems; overlaps are per kind', () => {
    expect(validateIntervals(litho())).toEqual([]);
  });

  test.each([
    ['kind', [I('zone', 1, 2, 'x')], /kind "zone" is not an interval kind/],
    ['depth', [I('lithology', 'a', 2, 'x')], /top depth is not a number/],
    ['order', [I('lithology', 5, 5, 'x')], /base \(5 m\) is not below the top \(5 m\)/],
    ['code', [I('lithology', 1, 2, '')], /has no code or label/],
    ['overlap', [I('lithology', 1500, 1510, 'a'), I('lithology', 1505, 1512, 'b')], /"b" \(1505 to 1512 m\) overlaps "a" \(1500 to 1510 m\)/],
  ])('refuses %s', (code, rows, message) => {
    const p = validateIntervals(rows);
    expect(p.some((x) => x.code === code && message.test(x.message))).toBe(true);
  });

  test('touching intervals do not overlap', () => {
    expect(validateIntervals([I('lithology', 1500, 1510, 'a'), I('lithology', 1510, 1520, 'b')])).toEqual([]);
  });
});

describe('gaps, lookup, merge', () => {
  test('gaps between consecutive intervals of one kind', () => {
    const rows = [I('lithology', 1500, 1505, 'a'), I('lithology', 1507, 1510, 'b'), I('lithology', 1510, 1512, 'c'), I('facies', 1505, 1507, 'f')];
    expect(intervalGaps(rows, 'lithology')).toEqual([{ top_md_m: 1505, base_md_m: 1507 }]);
    expect(intervalGaps(rows, 'facies')).toEqual([]);
  });

  test('intervalAt: top inclusive, base exclusive, per kind', () => {
    const rows = litho();
    expect(intervalAt(rows, 'lithology', 1500).code).toBe('sandstone');
    expect(intervalAt(rows, 'lithology', 1510).code).toBe('shale');
    expect(intervalAt(rows, 'lithology', 1509.999).code).toBe('sandstone');
    expect(intervalAt(rows, 'lithology', 1525)).toBeNull();
    expect(intervalAt(rows, 'facies', 1506).code).toBe('A');
    expect(intervalAt(rows, 'facies', 1500)).toBeNull();
  });

  test('mergeAdjacent joins touching same-code intervals of one kind only', () => {
    const merged = mergeAdjacent(litho(), 'lithology');
    expect(merged.map((r) => [r.top_md_m, r.base_md_m, r.code])).toEqual([[1500, 1510, 'sandstone'], [1510, 1525, 'shale']]);
    const gap = mergeAdjacent([I('lithology', 1, 2, 'a'), I('lithology', 3, 4, 'a')], 'lithology');
    expect(gap).toHaveLength(2);
  });
});

describe('raster and runs', () => {
  const depth = Float64Array.from({ length: 11 }, (_, i) => 1500 + i * 0.5);   // 1500 .. 1505

  test('rasterizeIntervals: per-sample category index, NaN outside, categories with colours', () => {
    const rows = [I('lithology', 1500, 1502, 'sandstone'), I('lithology', 1502, 1503, 'shale'), I('lithology', 1504, 1505.5, 'sandstone')];
    const { data, categories } = rasterizeIntervals(rows, 'lithology', depth);
    expect(categories.map((c) => c.code)).toEqual(['sandstone', 'shale']);
    expect(categories[1].colour).toBe('#8fa08a');
    expect(Array.from(data)).toEqual([0, 0, 0, 0, 1, 1, NaN, NaN, 0, 0, 0]);
  });

  test('rasterize with nothing to draw', () => {
    expect(Array.from(rasterizeIntervals([], 'lithology', depth).data).every(Number.isNaN)).toBe(true);
    expect(rasterizeIntervals([I('lithology', 1, 2, 'a')], 'lithology', []).data).toHaveLength(0);
  });

  test('intervalsFromRuns: runs of a facies index become intervals; NaN breaks a run; the last sample covers one step', () => {
    const values = [0, 0, 1, 1, NaN, 1, 2, 2, 2, 0, 0];
    const rows = intervalsFromRuns(depth, values, ['A', 'B', 'C'], { kind: 'facies', colours: ['#a', '#b', '#c'], source: 'log' });
    expect(rows.map((r) => [r.top_md_m, r.base_md_m, r.code])).toEqual([
      [1500, 1501, 'A'], [1501, 1502, 'B'], [1502.5, 1503, 'B'], [1503, 1504.5, 'C'], [1504.5, 1505.5, 'A'],
    ]);
    expect(rows[0]).toMatchObject({ kind: 'facies', label: 'A', source: 'log', properties: { index: 0, colour: '#a' } });
    expect(validateIntervals(rows)).toEqual([]);
  });

  test('a raster of the runs reproduces the input where defined', () => {
    const values = [0, 0, 1, 1, NaN, 1, 2, 2, 2, 0, 0];
    const rows = intervalsFromRuns(depth, values, ['A', 'B', 'C']);
    const { data } = rasterizeIntervals(rows, 'facies', depth);
    expect(Array.from(data)).toEqual(values.map((v) => (Number.isFinite(v) ? v : NaN)));
  });

  test('empty input', () => {
    expect(intervalsFromRuns([], [], ['A'])).toEqual([]);
  });
});

describe('thickness', () => {
  test('thicknessByCode sums per code with the lithology label', () => {
    expect(thicknessByCode(litho(), 'lithology')).toEqual([
      { code: 'shale', label: 'Shale', thickness_m: 15 },
      { code: 'sandstone', label: 'Sandstone', thickness_m: 10 },
    ]);
  });
});
