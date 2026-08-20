// Grid reprojection oracle: an analytic plane z = ax + by + c defined in
// the native frame must survive reprojection, because bilinear sampling
// reproduces linear fields exactly. Every live target node is compared
// against the plane evaluated at the node's native preimage.

import proj4 from 'proj4';
import { catalogGet } from '../lib/crs/catalog';
import { makeTransformer } from '../lib/crs/transform';
import { reprojectGrid } from '../lib/crs/gridReproject';
import { NULL_VALUE } from '../lib/gridding/numeric';

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) >= 1e29;

const A = 0.001;
const B = -0.002;
const C = 8000;
const plane = (x, y) => A * x + B * y + C;

function planeGrid(spec) {
  const z = new Float32Array(spec.nx * spec.ny);
  for (let r = 0; r < spec.ny; r += 1) {
    for (let c = 0; c < spec.nx; c += 1) {
      z[r * spec.nx + c] = plane(spec.x0 + c * spec.dx, spec.y0 + r * spec.dy);
    }
  }
  return z;
}

const SPEC = { x0: 525000, y0: 5755000, dx: 100, dy: 100, nx: 81, ny: 61 };

test('plane survives ED50 UTM31 -> WGS84 UTM31 within 1e-3', () => {
  const t = makeTransformer(proj4, catalogGet('EPSG:23031').proj4, catalogGet('EPSG:32631').proj4);
  const z = planeGrid(SPEC);
  const r = reprojectGrid(SPEC, z, t);
  expect(r).not.toBeNull();
  expect(r.spec.dx).toBe(100);
  expect(r.coverage).toBeGreaterThan(0.9);

  let checked = 0;
  for (let row = 0; row < r.spec.ny; row += 1) {
    for (let col = 0; col < r.spec.nx; col += 1) {
      const v = r.z[row * r.spec.nx + col];
      if (isNull(v)) continue;
      const native = t.inverse(r.spec.x0 + col * r.spec.dx, r.spec.y0 + row * r.spec.dy);
      expect(Math.abs(v - plane(native.x, native.y))).toBeLessThan(1e-3);
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(1000);
});

test('nodes outside the native hull stay null; native nulls propagate', () => {
  const t = makeTransformer(proj4, catalogGet('EPSG:23031').proj4, catalogGet('EPSG:32631').proj4);
  const z = planeGrid(SPEC);
  // Punch a null block into the native grid.
  for (let r = 20; r < 30; r += 1) {
    for (let c = 30; c < 40; c += 1) z[r * SPEC.nx + c] = NULL_VALUE;
  }
  const out = reprojectGrid(SPEC, z, t);
  // The target node nearest the center of the punched block must be null.
  const holeNative = { x: SPEC.x0 + 35 * SPEC.dx, y: SPEC.y0 + 25 * SPEC.dy };
  const holeTarget = t.forward(holeNative.x, holeNative.y);
  const col = Math.round((holeTarget.x - out.spec.x0) / out.spec.dx);
  const row = Math.round((holeTarget.y - out.spec.y0) / out.spec.dy);
  expect(isNull(out.z[row * out.spec.nx + col])).toBe(true);
  // A node just outside the native hull must be null too.
  const outsideNative = { x: SPEC.x0 - 3 * SPEC.dx, y: SPEC.y0 - 3 * SPEC.dy };
  const outsideTarget = t.forward(outsideNative.x, outsideNative.y);
  const oc = Math.round((outsideTarget.x - out.spec.x0) / out.spec.dx);
  const or = Math.round((outsideTarget.y - out.spec.y0) / out.spec.dy);
  if (oc >= 0 && oc < out.spec.nx && or >= 0 && or < out.spec.ny) {
    expect(isNull(out.z[or * out.spec.nx + oc])).toBe(true);
  }
  expect(out.coverage).toBeLessThan(1);
});

test('explicit target cell override and ft-native default spacing', () => {
  const t = makeTransformer(proj4, catalogGet('EPSG:23031').proj4, catalogGet('EPSG:32631').proj4);
  const z = planeGrid(SPEC);
  const coarse = reprojectGrid(SPEC, z, t, { cellM: 250 });
  expect(coarse.spec.dx).toBe(250);
  const ftNative = reprojectGrid(SPEC, z, t, { nativeUnit: 'ft' });
  expect(ftNative.spec.dx).toBeCloseTo(100 * 0.3048, 12);
});
