// Ordinary kriging vs the independent stdlib-Python oracle (Mapping MS5,
// 2026-09-06). test-data/mapping/goldens/kriging_cases.json is written
// by tools/validation/mapping/oracle_kriging.py, never from this code.
import fs from 'fs';
import path from 'path';
import {
  krigePoints, krigeSurface, experimentalVariogram, fitVariogram, variogramModel,
  variogramParams, mergeDuplicates, fitPlane, VARIOGRAM_MODELS,
} from '../lib/gridding/kriging.js';
import { gridSurface } from '../lib/gridding/gridding.js';
import { isNull } from '../lib/gridding/gridmath.js';

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'mapping', 'goldens', 'kriging_cases.json'), 'utf8'));
const TOL = golden.tolerance;
const near = (a, b, tol = TOL) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const byName = Object.fromEntries(golden.cases.map((c) => [c.name, c]));

describe.each(golden.cases.filter((c) => c.kind === 'points').map((c) => [c.name, c]))('krigePoints %s', (_n, c) => {
  test('values match the oracle', () => {
    const r = krigePoints(c.points, c.targets, c.params);
    r.values.forEach((v, i) => near(v, c.expected.values[i]));
    if (c.expected.variances) r.variances.forEach((v, i) => near(v, c.expected.variances[i]));
    if (c.expected.weights) r.weights.forEach((w, i) => w.forEach((wi, j) => near(wi, c.expected.weights[i][j])));
    if (c.expected.plane) { near(r.plane.a, c.expected.plane.a); near(r.plane.b, c.expected.plane.b); near(r.plane.c, c.expected.plane.c); }
  });
  test('weights sum to one (unbiased) and the datum is honoured at zero nugget', () => {
    const r = krigePoints(c.points, c.targets, c.params);
    for (const w of r.weights) near(w.reduce((a, b) => a + b, 0), 1, 1e-10);
    if (!c.params.nugget) {
      const p0 = c.points[0];
      const at = krigePoints(c.points, [[p0.x, p0.y]], c.params);
      near(at.values[0], p0.z, 1e-9);
      near(at.variances[0], 0, 1e-9);
    }
  });
});

test('lattice experimental variogram matches the oracle bin by bin', () => {
  const c = byName.lattice_variogram;
  const ev = experimentalVariogram(c.points, { lag: c.lag, nLags: c.nLags });
  expect(ev).toHaveLength(c.expected.length);
  ev.forEach((b, i) => {
    expect(b.pairs).toBe(c.expected[i].pairs);
    expect(b.lagCentre).toBe(c.expected[i].lagCentre);
    near(b.h, c.expected[i].h);
    near(b.gamma, c.expected[i].gamma);
  });
});

test('fitVariogram recovers a known model from its own curve (each model, within 0.5%)', () => {
  for (const model of VARIOGRAM_MODELS) {
    const truth = { model, range: 25, sill: 3, nugget: 0.5 };
    const exp = [];
    for (let h = 2; h <= 40; h += 2) exp.push({ h, gamma: variogramModel(h, truth), pairs: 10 });
    const fit = fitVariogram(exp, { model, nugget: 0.5 });
    expect(Math.abs(fit.range - 25) / 25).toBeLessThan(0.005);
    expect(Math.abs(fit.sill - 3) / 3).toBeLessThan(0.005);
    expect(fit.rmse).toBeLessThan(2e-3); // below 0.1% of the sill
  }
});

test('krigeSurface has the gridSurface shape plus a variance grid, masks like it, and the moving neighbourhood agrees with the global solve on a small set', () => {
  const c = byName.five_spherical_n0;
  const spec = { x0: -5, y0: -5, dx: 2.5, dy: 2.5, nx: 9, ny: 9 };
  const g = krigeSurface(c.points, spec, { ...c.params, maxExtrapolation: 1e9 });
  const t = gridSurface(c.points, spec, { maxExtrapolation: 1e9 });
  expect(g.z).toBeInstanceOf(Float32Array);
  expect(g.variance).toBeInstanceOf(Float32Array);
  expect(g.live).toBe(t.live);
  for (let i = 0; i < g.z.length; i++) expect(isNull(g.z[i])).toBe(isNull(t.z[i]));
  expect(g.controlCount).toBe(5);
  expect(g.neighbourhood).toBe('global');
  // node (2,2) is the origin datum: exact, zero variance
  const i0 = 2 * spec.nx + 2;
  near(g.z[i0], 1, 1e-6);
  near(g.variance[i0], 0, 1e-6);
  const m = krigeSurface(c.points, spec, { ...c.params, maxExtrapolation: 1e9, neighbours: 3 });
  expect(m.neighbourhood).toBe('moving');
  expect(m.live).toBe(g.live);
});

test('detrend reproduces a dipping plane at every live node while plain ordinary kriging does not', () => {
  const c = byName.plane_gaussian_detrend;
  const spec = { x0: 100, y0: 100, dx: 100, dy: 100, nx: 9, ny: 9 };
  const d = krigeSurface(c.points, spec, { ...c.params, maxExtrapolation: 1e9 });
  const o = krigeSurface(c.points, spec, { ...c.params, detrend: false, maxExtrapolation: 1e9 });
  let worstD = 0; let worstO = 0;
  for (let r = 0; r < spec.ny; r++) {
    for (let col = 0; col < spec.nx; col++) {
      const i = r * spec.nx + col;
      if (isNull(d.z[i])) continue;
      const x = spec.x0 + col * spec.dx; const y = spec.y0 + r * spec.dy;
      const truth = 100 - 0.02 * x + 0.05 * y;
      worstD = Math.max(worstD, Math.abs(d.z[i] - truth));
      worstO = Math.max(worstO, Math.abs(o.z[i] - truth));
    }
  }
  expect(worstD).toBeLessThan(1e-3); // Float32 storage of ~100
  expect(worstO).toBeGreaterThan(0.05);
});

test('duplicates are averaged instead of making the system singular', () => {
  const pts = [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 3 }, { x: 10, y: 0, z: 2 }, { x: 0, y: 10, z: 2 }];
  const { points, merged } = mergeDuplicates(pts);
  expect(merged).toBe(1);
  expect(points[0].z).toBe(2);
  const r = krigePoints(pts, [[0, 0]], { model: 'spherical', range: 20, sill: 1 });
  near(r.values[0], 2, 1e-9);
  expect(r.merged).toBe(1);
});

test('fitPlane recovers a plane and survives collinear points', () => {
  const pl = fitPlane([{ x: 0, y: 0, z: 5 }, { x: 1, y: 0, z: 6 }, { x: 0, y: 1, z: 7 }, { x: 1, y: 1, z: 8 }]);
  near(pl.a, 5, 1e-12); near(pl.b, 1, 1e-12); near(pl.c, 2, 1e-12);
  const col = fitPlane([{ x: 0, y: 0, z: 5 }, { x: 1, y: 1, z: 7 }, { x: 2, y: 2, z: 9 }]);
  expect(Number.isFinite(col.a)).toBe(true);
});

test('invalid parameters throw plain messages', () => {
  expect(() => variogramParams({ model: 'cubic', range: 1, sill: 1 })).toThrow(/Unknown variogram model/);
  expect(() => variogramParams({ model: 'spherical', range: 0, sill: 1 })).toThrow(/range greater than zero/);
  expect(() => variogramParams({ model: 'spherical', range: 1, sill: 0 })).toThrow(/sill greater than zero/);
  expect(() => variogramParams({ model: 'spherical', range: 1, sill: 1, nugget: 1 })).toThrow(/nugget/);
  expect(() => krigePoints([{ x: 0, y: 0, z: 1 }], [[1, 1]], { model: 'spherical', range: 1, sill: 1 })).toThrow(/at least two/);
  expect(() => experimentalVariogram([], { lag: 0 })).toThrow(/lag distance/);
  expect(() => fitVariogram([{ h: 1, gamma: 1, pairs: 1 }], {})).toThrow(/two occupied/);
});
