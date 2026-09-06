// Well adjustment vs the independent oracle (Earth Modeling EM1,
// 2026-09-06). test-data/earthmodel/adjust_cases.json is written by
// tools/validation/earthmodel/oracle_adjust.py, never from this code.
import fs from 'fs';
import path from 'path';
import { residualField, applyCorrection, adjustSurfaces, defaultRadius } from '../engines/earthmodeling/adjust.js';
import { sampleAtXY, isNull } from '../lib/gridding/gridmath.js';
import { NULL_VALUE } from '../lib/gridding/numeric.js';

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'earthmodel', 'adjust_cases.json'), 'utf8'));
const TOL = golden.tolerance;
const byName = Object.fromEntries(golden.cases.map((c) => [c.name, c]));

describe.each(golden.cases.map((c) => [c.name, c]))('residualField %s', (_n, c) => {
  test('matches the oracle field node for node', () => {
    const { field, used } = residualField(c.ties, c.spec, c.radius);
    expect(used).toBe(c.ties.length);
    field.forEach((v, i) => expect(Math.abs(v - c.expected_field[i])).toBeLessThanOrEqual(TOL));
  });
});

test('one tie on a node: exact there, half at R/2, untouched beyond the radius', () => {
  const c = byName.one_tie_on_node;
  const { field } = residualField(c.ties, c.spec, c.radius);
  const idx = ([r, col]) => r * c.spec.nx + col;
  expect(field[idx(c.probes.centre)]).toBeCloseTo(12.5, 12);
  expect(field[idx(c.probes.far)]).toBe(0);
  expect(field[idx(c.probes.half)]).toBeCloseTo(6.25, 12);
  expect(field[idx(c.probes.near)]).toBeGreaterThan(6.25);
  expect(field[idx(c.probes.near)]).toBeLessThan(12.5);
  const z = Float64Array.from(c.z);
  const out = applyCorrection(z, field);
  expect(out[idx(c.probes.far)]).toBe(z[idx(c.probes.far)]);
});

test('a tie off the lattice: the corrected surface samples within 5% of the pick and the residual shrinks', () => {
  const c = byName.tie_off_lattice;
  const t = { ...c.ties[0], tvdss: c.pick_tvdss, surfaceIndex: 0 };
  const { grids, report, tiesAfter } = adjustSurfaces([Float64Array.from(c.z)], c.spec, [t], { radius: c.radius });
  expect(report[0]).toMatchObject({ surface: 0, ties: 1, adjusted: true });
  expect(Math.abs(report[0].after)).toBeLessThan(Math.abs(report[0].before));
  expect(Math.abs(tiesAfter[0].after - c.expected_after)).toBeLessThanOrEqual(1e-9);
  const zs = sampleAtXY(grids[0], c.spec, t.x, t.y);
  expect(Math.abs(c.pick_tvdss - zs)).toBeLessThan(0.05 * 8);
});

test('surfaces without ties or switched off are returned as they were; nulls stay null', () => {
  const c = byName.one_tie_on_node;
  const z = Float64Array.from(c.z);
  z[0] = NULL_VALUE;
  const t = { ...c.ties[0], tvdss: 0, surfaceIndex: 1 };
  const { grids, report } = adjustSurfaces([z, z], c.spec, [t], { radius: c.radius, enabled: [true, false] });
  expect(grids[0]).toBe(z);
  expect(grids[1]).toBe(z);
  expect(report[0].adjusted).toBe(false);
  expect(report[1]).toMatchObject({ adjusted: false, ties: 1 });
  const on = adjustSurfaces([z, z], c.spec, [t], { radius: c.radius });
  expect(isNull(on.grids[1][0])).toBe(true);
  expect(on.report[1].adjusted).toBe(true);
});

test('defaultRadius is three times the median tie spacing, with a fallback', () => {
  expect(defaultRadius([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 300, y: 0 }])).toBe(300);
  expect(defaultRadius([{ x: 0, y: 0 }])).toBe(1000);
  expect(() => residualField([], { nx: 2, ny: 2 }, 0)).toThrow(/radius/);
});
