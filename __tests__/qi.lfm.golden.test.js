/**
 * Low-frequency model against its independent oracle (QI course gate E1c,
 * G5): tools/validation/qi/oracle_qi_lfm.py (stdlib, knot map by bisect,
 * exact-rational sampling, explicit IDW weights, two-pass correlation).
 * Every assertion calls the shipped engine.
 */
import G from '../test-data/qi/goldens.lfm.json';
import { mapToWellTime, sampleAt, lfmTrace, blindWellScore } from '../engines/qi/lfm';

const nan = (a) => a.map((v) => (v === null ? NaN : v));
const wells = G.wells.map((w) => ({ ...w, values: nan(w.values) }));
const close = (got, want, tol) => {
  if (want === null) { expect(got).toBeNaN(); return; }
  expect(Math.abs(got - want)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(want)));
};

describe('lfm against the oracle', () => {
  test('mapToWellTime on every knot table', () => {
    expect(G.map.length).toBeGreaterThan(0);
    for (const c of G.map) close(mapToWellTime(c.t, c.trace, c.well), c.out, 1e-12);
  });
  test('sampleAt matches exact-rational interpolation, missing outside and beside a null', () => {
    expect(G.sample.length).toBeGreaterThan(0);
    for (const c of G.sample) close(sampleAt(nan(c.values), c.t0, c.dt, c.t), c.out, 1e-14);
  });
  test.each(G.traces.map((t, k) => [k, t]))('trace %s: lfmTrace sample by sample', (k, c) => {
    const ws = c.horizons ? wells : wells.map((w) => ({ ...w, horizons: undefined }));
    const m = lfmTrace(ws, c.at, G.grid, { power: c.power, exclude: c.exclude ?? undefined });
    expect(m.length).toBe(c.lfm.length);
    c.lfm.forEach((v, i) => close(m[i], v, 1e-12));
  });
  test('blindWellScore', () => {
    for (const c of G.scores) {
      const s = blindWellScore(nan(c.est), nan(c.truth));
      expect(s.n).toBe(c.out.n);
      close(s.corr, c.out.corr, 1e-10);
      close(s.rmsPct, c.out.rmsPct, 1e-10);
    }
  });
  test('negative control: the constant-time trace differs from the horizon-guided one at the same place', () => {
    const at = { x: 600, y: 500, horizons: [255, 420] };
    const flat = lfmTrace(wells.map((w) => ({ ...w, horizons: undefined })), { x: 600, y: 500 }, G.grid);
    const diff = G.traces[0].lfm.reduce((s, v, i) => s + Math.abs(v - flat[i]), 0);
    expect(diff).toBeGreaterThan(0.1);
    expect(lfmTrace(wells, at, G.grid)[70]).toBeCloseTo(G.traces[0].lfm[70], 12);
  });
});
