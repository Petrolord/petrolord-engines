// Structure-map control points vs the closed-form oracle (Mapping MS0,
// 2026-09-05). test-data/mapping/goldens/structure_points_cases.json is
// written by tools/validation/mapping/oracle_structure_points.py from
// analytic trajectories and planes, never from this code.
import fs from 'fs';
import path from 'path';
import {
  topsToControlPoints, topsToPoints, STRUCTURE_DEPTH_REFS, STRUCTURE_PLACEMENTS,
  CONTROL_POINT_SKIP_REASONS, thickness, convertZUnit, maskOutsidePolygon,
} from '../engines/mapping/surface.js';
import { gridSurface } from '../lib/gridding/gridding.js';
import { isNull } from '../lib/gridding/gridmath.js';
import { makeDepthFrame } from '../engines/welldata/checkshots.js';

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'mapping', 'goldens', 'structure_points_cases.json'), 'utf8'));
const TOL = golden.tolerance_m;
const GTOL = golden.grid_tolerance_m;
const byName = Object.fromEntries(golden.cases.map((c) => [c.name, c]));

const near = (a, b, tol = TOL) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

const expectPoints = (got, exp) => {
  expect(got).toHaveLength(exp.length);
  got.forEach((p, i) => {
    expect(p.well).toBe(exp[i].well);
    near(p.x, exp[i].x);
    near(p.y, exp[i].y);
    near(p.z, exp[i].z);
    near(p.md, exp[i].md);
    expect(p.extrapolated).toBe(exp[i].extrapolated);
  });
};

describe.each(golden.cases.filter((c) => c.kind === 'points').map((c) => [c.name, c]))('control points %s', (_n, c) => {
  test.each(Object.keys(c.expected))('match the closed form for %s', (key) => {
    const [depthRef, placement] = key.split('/');
    const r = topsToControlPoints(c.wells, c.top, { depthRef, placement });
    expectPoints(r.points, c.expected[key].points);
    expect(r.skipped.map(({ well, reason }) => ({ well, reason }))).toEqual(c.expected[key].skipped);
    expect(r.extrapolated).toBe(c.expected[key].extrapolated);
    expect(r.depthRef).toBe(depthRef);
    expect(r.placement).toBe(placement);
  });
});

test('skipped wells carry the fixed reason codes and a detail where one exists', () => {
  const c = byName.skipped_rows;
  const r = topsToControlPoints(c.wells, c.top);
  for (const s of r.skipped) expect(Object.keys(CONTROL_POINT_SKIP_REASONS)).toContain(s.reason);
  expect(r.skipped.find((s) => s.reason === 'bad_md').detail).toBe('abc');
  expect(r.skipped.find((s) => s.reason === 'above_survey').detail).toMatch(/above the first survey station/);
});

test('plane_grid: TVDSS controls at the borehole reproduce the plane; TPS through them equals the plane inside the hull and is null outside', () => {
  const c = byName.plane_grid;
  const r = topsToControlPoints(c.wells, c.top);
  expectPoints(r.points, c.expected_points);
  expect(r.extrapolated).toBe(1);
  const g = gridSurface(r.points, c.spec, { maxExtrapolation: 1e9 });
  const { nx } = c.spec;
  for (const [row, col, z] of c.interior_nodes) near(g.z[row * nx + col], z, GTOL);
  for (const [row, col] of c.exterior_nodes) expect(isNull(g.z[row * nx + col])).toBe(true);
});

test('parallel_planes: thickness of two elevation surfaces is top minus base, positive', () => {
  const c = byName.parallel_planes;
  const { spec } = c;
  const build = ({ a, b, cc }) => {
    const z = new Float64Array(spec.nx * spec.ny);
    for (let r = 0; r < spec.ny; r++) for (let col = 0; col < spec.nx; col++) z[r * spec.nx + col] = a + b * (spec.x0 + col * spec.dx) + cc * (spec.y0 + r * spec.dy);
    return z;
  };
  const top = build({ a: c.top.a, b: c.top.b, cc: c.top.c });
  const base = build({ a: c.base.a, b: c.base.b, cc: c.base.c });
  const t = thickness(top, base);
  for (const v of t) near(v, c.expected_thickness_m, 1e-9);
});

test('unit_roundtrip: m to ft and back, nulls preserved, array type kept', () => {
  const c = byName.unit_roundtrip;
  const z = Float32Array.from([...c.values_m, 1e30]);
  const ft = convertZUnit(z, 'm', 'ft');
  expect(ft).toBeInstanceOf(Float32Array);
  c.values_ft.forEach((v, i) => near(ft[i], v, 1e-3));
  expect(isNull(ft[ft.length - 1])).toBe(true);
  const back = convertZUnit(ft, 'ft', 'm');
  c.values_m.forEach((v, i) => near(back[i], v, 1e-3));
  expect(() => convertZUnit(z, 'm', 'in')).toThrow(/depth unit/);
});

test('maskOutsidePolygon nulls node centres outside the ring and keeps the rest', () => {
  const spec = { x0: 0, y0: 0, dx: 1, dy: 1, nx: 5, ny: 5 };
  const z = new Float32Array(25).fill(7);
  const ring = [[0.5, 0.5], [3.5, 0.5], [3.5, 3.5], [0.5, 3.5]]; // nodes 1..3 in both axes
  const m = maskOutsidePolygon(z, spec, ring);
  let live = 0;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    const inside = r >= 1 && r <= 3 && c >= 1 && c <= 3;
    expect(isNull(m[r * 5 + c])).toBe(!inside);
    if (inside) live += 1;
  }
  expect(live).toBe(9);
  expect(maskOutsidePolygon(z, spec, [{ x: 0.5, y: 0.5 }, { x: 3.5, y: 0.5 }, { x: 3.5, y: 3.5 }, { x: 0.5, y: 3.5 }])).toEqual(m);
  expect(() => maskOutsidePolygon(z, spec, [[0, 0]])).toThrow(/at least 3/);
});

test('topsToPoints is the points array of topsToControlPoints; legacy callers get TVDSS elevation at the borehole', () => {
  const c = byName.vertical_kb_only;
  expect(topsToPoints(c.wells, c.top)).toEqual(topsToControlPoints(c.wells, c.top).points);
  expect(topsToPoints(c.wells, c.top)[0].z).toBe(-(1500 - 30));
});

test('unknown depthRef or placement is a plain domain error', () => {
  expect(() => topsToControlPoints([], 'Top A', { depthRef: 'depth' })).toThrow(/depth reference/);
  expect(() => topsToControlPoints([], 'Top A', { placement: 'toe' })).toThrow(/placement/);
  expect(STRUCTURE_DEPTH_REFS).toEqual(['md', 'tvd', 'tvdss']);
  expect(STRUCTURE_PLACEMENTS).toEqual(['borehole', 'surface']);
});

test('mdToPosition: vertical wells have zero offset; tvdss agrees with mdToTvdss on and past the survey', () => {
  const v = makeDepthFrame({ deviation: [], kbM: 30 });
  expect(v.mdToPosition(1000)).toEqual({ x: 0, y: 0, tvd: 1000, tvdss: 970, extrapolated: false });
  const c = byName.buildhold_extrapolated;
  const f = makeDepthFrame({ deviation: c.wells[0].deviation, kbM: c.wells[0].kb_m });
  for (const md of [250, 900, 2000, 3000, 3200]) {
    const p = f.mdToPosition(md);
    const t = f.mdToTvdss(md);
    expect(p.tvd).toBe(t.tvd);
    expect(p.tvdss).toBe(t.tvdss);
    expect(p.extrapolated).toBe(t.extrapolated);
  }
  // past TD the offset grows along the last tangent: 200 m at 40 deg inclination, azimuth 135
  const a = f.mdToPosition(3000);
  const b = f.mdToPosition(3200);
  const h = 200 * Math.sin(40 * Math.PI / 180);
  near(b.x - a.x, h * Math.sin(135 * Math.PI / 180), 1e-9);
  near(b.y - a.y, h * Math.cos(135 * Math.PI / 180), 1e-9);
  expect(b.extrapolated).toBe(true);
});
