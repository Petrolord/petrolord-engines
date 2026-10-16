import { mapToWellTime, sampleAt, lfmTrace, blindWellScore } from '../engines/qi/lfm';

const grid = { t0Ms: 0, dtMs: 4, ns: 251 };
// a three-layer earth: ln(AI) 8.5 above the top, 8.9 between top and base, 8.7 below
const layered = (top, base) => Float64Array.from({ length: grid.ns }, (_, k) => {
  const t = k * grid.dtMs;
  return t < top ? 8.5 : t < base ? 8.9 : 8.7;
});

describe('low-frequency model', () => {
  test('mapToWellTime keeps proportional position between horizons and offsets outside', () => {
    expect(mapToWellTime(550, [500, 600], [400, 600])).toBeCloseTo(500, 12);
    expect(mapToWellTime(450, [500, 600], [400, 600])).toBeCloseTo(350, 12);
    expect(mapToWellTime(650, [500, 600], [400, 600])).toBeCloseTo(650, 12);
    expect(mapToWellTime(123, [], [])).toBe(123);
    // a trace outside the horizons' coverage (a fault, an untracked edge) or a
    // well without picks: constant time, the no-horizon model (QI showcase,
    // 2026-10-16: a guided survey inversion on the faulted Ekene v4 threw here)
    expect(mapToWellTime(321, [], [400, 600])).toBe(321);
    expect(mapToWellTime(321, [500, 600], [])).toBe(321);
    expect(mapToWellTime(321, undefined, [400, 600])).toBe(321);
    // two pick lists of different lengths are still an error
    expect(() => mapToWellTime(1, [1, 2], [1])).toThrow(/same horizons/);
  });
  test('sampleAt interpolates and returns NaN outside', () => {
    expect(sampleAt([0, 10, 20], 0, 4, 6)).toBeCloseTo(15, 12);
    expect(sampleAt([0, 10, 20], 0, 4, 9)).toBeNaN();
  });
  test('at a well the model is that well', () => {
    const w = { name: 'A', x: 0, y: 0, t0Ms: 0, dtMs: 4, values: layered(400, 600), horizons: [400, 600] };
    const m = lfmTrace([w, { ...w, name: 'B', x: 1000, values: layered(300, 500), horizons: [300, 500] }], { x: 0, y: 0, horizons: [400, 600] }, grid);
    expect(Array.from(m)).toEqual(Array.from(w.values));
  });
  test('a dipping layer keeps its impedance between wells with horizons', () => {
    const A = { name: 'A', x: 0, y: 0, t0Ms: 0, dtMs: 4, values: layered(400, 600), horizons: [400, 600] };
    const B = { name: 'B', x: 1000, y: 0, t0Ms: 0, dtMs: 4, values: layered(600, 800), horizons: [600, 800] };
    const m = lfmTrace([A, B], { x: 500, y: 0, horizons: [500, 700] }, grid);
    const truth = layered(500, 700);
    // exact inside and outside the layer, away from the boundary samples
    for (const t of [200, 480, 520, 600, 680, 720, 900]) expect(m[t / 4]).toBeCloseTo(truth[t / 4], 9);
  });
  test('negative control: at constant time the same layer is smeared', () => {
    const A = { name: 'A', x: 0, y: 0, t0Ms: 0, dtMs: 4, values: layered(400, 600) };
    const B = { name: 'B', x: 1000, y: 0, t0Ms: 0, dtMs: 4, values: layered(600, 800) };
    const m = lfmTrace([A, B], { x: 500, y: 0 }, grid);
    const truth = layered(500, 700);
    const err = (t) => Math.abs(m[t / 4] - truth[t / 4]);
    expect(err(520) + err(680)).toBeGreaterThan(0.2);
  });
  test('exclude leaves a well out, and IDW weights by distance', () => {
    const mk = (name, x, v) => ({ name, x, y: 0, t0Ms: 0, dtMs: 4, values: new Float64Array(grid.ns).fill(v) });
    const wells = [mk('A', 0, 8), mk('B', 300, 9), mk('C', 100, 10)];
    expect(lfmTrace(wells, { x: 100, y: 0 }, grid, { exclude: 'C' })[0]).toBeCloseTo((8 / 1e4 + 9 / 4e4) / (1 / 1e4 + 1 / 4e4), 12);
    expect(lfmTrace(wells, { x: 100, y: 0 }, grid)[0]).toBe(10);
    expect(() => lfmTrace([mk('A', 0, 8)], { x: 0, y: 0 }, grid, { exclude: 'A' })).toThrow();
  });
  test('samples no well covers hold the nearest covered value', () => {
    const w = { name: 'A', x: 0, y: 0, t0Ms: 100, dtMs: 4, values: [1, 2, 3] };
    const m = lfmTrace([w], { x: 0, y: 0 }, { t0Ms: 0, dtMs: 4, ns: 40 });
    expect(m[0]).toBe(1); expect(m[26]).toBe(2); expect(m[39]).toBe(3);
  });
  test('blindWellScore', () => {
    const t = Array.from({ length: 50 }, (_, i) => 8.5 + 0.01 * Math.sin(i / 3));
    const s = blindWellScore(t.map((v) => v + Math.log(1.05)), t);
    expect(s.corr).toBeCloseTo(1, 9);
    expect(s.rmsPct).toBeCloseTo(5, 9);
    expect(blindWellScore([1, NaN], [1, 2]).n).toBe(1);
  });
});


describe('a trace in a horizon hole (QI showcase, 2026-10-16)', () => {
  // two wells with horizons, a trace where the horizons are missing: the model
  // exists, equals the constant-time model at that trace, and differs from the
  // guided model where the horizons are present (negative control)
  const wells = [0, 1].map((k) => ({
    name: `W${k}`, x: 1000 * k, y: 0, t0Ms: 0, dtMs: 4,
    values: Float64Array.from({ length: 200 }, (_, i) => 15 + 0.002 * i + (i > 100 + 10 * k ? 0.3 : 0)),
    horizons: [400 + 40 * k, 500 + 40 * k],
  }));
  const grid = { t0Ms: 0, dtMs: 4, ns: 200 };
  test('no horizons at the trace: the constant-time model, no error', () => {
    const hole = lfmTrace(wells, { x: 500, y: 0 }, grid);
    const flat = lfmTrace(wells.map(({ horizons, ...w }) => w), { x: 500, y: 0 }, grid);
    expect(Array.from(hole)).toEqual(Array.from(flat));
  });
  test('with horizons at the trace the guided model differs (the guide is used)', () => {
    const guided = lfmTrace(wells, { x: 500, y: 0, horizons: [420, 520] }, grid);
    const hole = lfmTrace(wells, { x: 500, y: 0 }, grid);
    expect(Array.from(guided)).not.toEqual(Array.from(hole));
  });
});
