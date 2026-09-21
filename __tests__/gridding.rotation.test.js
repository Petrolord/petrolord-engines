// Rotated grid frames vs the closed-form oracle (Mapping MS5, 2026-09-06).
// test-data/mapping/goldens/rotation_cases.json is written by
// tools/validation/mapping/oracle_rotation.py from the convention.
import fs from 'fs';
import path from 'path';
import {
  gridXY, worldToGridIndex, gridCorners, gridBBox, sampleAtXY, resampleTo, maskOutsidePolygon, gridRotation,
} from '../lib/gridding/gridmath.js';
import { parseIrapClassic, parseSurfaceFile } from '../lib/gridding/surfaceImport.js';
import { writeIrapClassic, writeCPS3, writeZMAP, writeXYZ } from '../lib/gridding/surfaceExport.js';

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'mapping', 'goldens', 'rotation_cases.json'), 'utf8'));
const TOL = golden.tolerance;
const near = (a, b, tol = TOL) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

test('corners and bbox of a rotated spec', () => {
  const { spec, expected, bbox } = golden.corners;
  const got = gridCorners(spec);
  got.forEach((p, i) => { near(p.x, expected[i].x); near(p.y, expected[i].y); });
  const b = gridBBox(spec);
  for (const k of Object.keys(bbox)) near(b[k], bbox[k]);
  expect(gridRotation(spec)).toBe(30);
  expect(gridRotation({ x0: 0 })).toBe(0);
});

test('worldToGridIndex inverts gridXY on off-node points', () => {
  const { spec, probes } = golden.round_trip;
  for (const p of probes) {
    const { fx, fy } = worldToGridIndex(spec, p.x, p.y);
    near(fx, p.fx); near(fy, p.fy);
    const back = gridXY(spec, fy, fx);
    near(back.x, p.x); near(back.y, p.y);
  }
});

test('an unrotated spec keeps the plain arithmetic exactly', () => {
  const spec = { x0: 12.5, y0: -7.25, dx: 3.3, dy: 1.1, nx: 4, ny: 4 };
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const p = gridXY(spec, r, c);
    expect(p.x).toBe(spec.x0 + c * spec.dx);
    expect(p.y).toBe(spec.y0 + r * spec.dy);
  }
});

test('a plane on a rotated source resamples exactly onto an unrotated frame, and sampleAtXY agrees', () => {
  const { source, source_z, target, expected, plane } = golden.plane_resample;
  const z = Float64Array.from(source_z);
  const out = resampleTo(z, source, target);
  out.forEach((v, i) => near(v, expected[i]));
  const w = gridXY(target, 2, 2);
  near(sampleAtXY(z, source, w.x, w.y), plane.a + plane.bx * w.x + plane.cy * w.y);
});

test('maskOutsidePolygon judges rotated nodes by their world position', () => {
  const spec = { x0: 0, y0: 0, dx: 10, dy: 10, nx: 3, ny: 3, rotation_deg: 90 };
  // rotated 90 deg: node (r, c) sits at (-r*10, c*10); a ring over x in [-25, -5] keeps rows 1..2 only
  const z = new Float64Array(9).fill(1);
  const m = maskOutsidePolygon(z, spec, [[-25, -5], [-5, -5], [-5, 25], [-25, 25]]);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    expect(Math.abs(m[r * 3 + c]) >= 1e29).toBe(r === 0);
  }
});

test('Irap classic round-trips a rotated grid byte for byte and the other formats refuse it', () => {
  const { spec, z, text } = golden.irap;
  const g = parseIrapClassic(text);
  expect(g.rotation_deg).toBe(spec.rotation_deg);
  near(g.x0, spec.x0); near(g.y0, spec.y0);
  expect(g.nx).toBe(spec.nx); expect(g.ny).toBe(spec.ny);
  Array.from(g.z).forEach((v, i) => near(v, z[i], 1e-6));
  expect(writeIrapClassic({ ...g, z })).toBe(text);
  expect(parseSurfaceFile(text).rotation_deg).toBe(30);
  for (const w of [writeCPS3, writeZMAP, writeXYZ]) {
    expect(() => w({ ...g, x: [], y: [] })).toThrow(/no rotation field/);
  }
});
