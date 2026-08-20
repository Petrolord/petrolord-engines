// Survey affine reprojection: a rotated synthetic survey in ED50 / UTM
// 31N carried into WGS 84 frames. Assertions:
// - every refit corner agrees with the DIRECT point transform of the
//   native corner to within the reported residual (plus float slack)
// - the residual itself is centimetre-scale for a survey-sized extent
// - the grid azimuth change equals the convergence difference between
//   the two frames (rotation of the frame, measured two independent ways)

import proj4 from 'proj4';
import { catalogGet } from '../lib/crs/catalog';
import { makeTransformer, makeProjector } from '../lib/crs/transform';
import { gridConvergenceDeg } from '../lib/crs/convergence';
import { reprojectAffine, residualWarnThresholdM } from '../lib/crs/affineReproject';
import { ilxlToWorld, gridAzimuthDeg } from '../engines/seismolord/surveyGeometry';

// 30-degree-rotated survey near 52N 3.5E (North Sea), 25 m bins,
// 200 inlines x 300 crosslines (~5 x 7.5 km).
const ROT = (30 * Math.PI) / 180;
const NATIVE_AFFINE = {
  origin: { x: 530000, y: 5760000 },
  ilVec: { x: -25 * Math.sin(ROT), y: 25 * Math.cos(ROT) },
  xlVec: { x: 25 * Math.cos(ROT), y: 25 * Math.sin(ROT) },
};
const N_IL = 200;
const N_XL = 300;

test('ED50 UTM31 -> WGS84 UTM31: corners match direct transforms, residual tiny', () => {
  const t = makeTransformer(proj4, catalogGet('EPSG:23031').proj4, catalogGet('EPSG:32631').proj4);
  const r = reprojectAffine(NATIVE_AFFINE, N_IL, N_XL, t);
  expect(r).not.toBeNull();
  expect(r.maxResidualM).toBeLessThan(0.1);

  for (const [i, j] of [[0, 0], [0, N_XL - 1], [N_IL - 1, 0], [N_IL - 1, N_XL - 1]]) {
    const native = ilxlToWorld(NATIVE_AFFINE, i, j);
    const direct = t.forward(native.x, native.y);
    const refit = ilxlToWorld(r.affine, i, j);
    expect(Math.hypot(refit.x - direct.x, refit.y - direct.y))
      .toBeLessThan(r.maxResidualM + 0.01);
  }

  // Same-zone datum shift: corners move by the ~100 m ED50 offset.
  for (const s of r.cornerShifts) {
    const d = Math.hypot(s.dx, s.dy);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(250);
  }
});

test('cross-zone reprojection rotates the frame by the convergence difference', () => {
  const from = catalogGet('EPSG:23031');
  const to = catalogGet('EPSG:32632');
  const t = makeTransformer(proj4, from.proj4, to.proj4);
  const r = reprojectAffine(NATIVE_AFFINE, N_IL, N_XL, t);
  expect(r).not.toBeNull();

  const center = ilxlToWorld(NATIVE_AFFINE, (N_IL - 1) / 2, (N_XL - 1) / 2);
  const centerTo = t.forward(center.x, center.y);
  const gammaFrom = gridConvergenceDeg(makeProjector(proj4, from.proj4), center.x, center.y);
  const gammaTo = gridConvergenceDeg(makeProjector(proj4, to.proj4), centerTo.x, centerTo.y);

  // gridAzimuthDeg is CCW from +X; grid azimuths clockwise from north
  // change by (gammaTo - gammaFrom), so the CCW bearing changes by the
  // negative of that.
  const azShift = gridAzimuthDeg(r.affine) - gridAzimuthDeg(NATIVE_AFFINE);
  expect(Math.abs(azShift - -(gammaTo - gammaFrom))).toBeLessThan(0.05);
});

test('reprojection from native is idempotent in error: A->B equals A->B, never chained', () => {
  const tAB = makeTransformer(proj4, catalogGet('EPSG:23031').proj4, catalogGet('EPSG:32631').proj4);
  const r1 = reprojectAffine(NATIVE_AFFINE, N_IL, N_XL, tAB);
  const r2 = reprojectAffine(NATIVE_AFFINE, N_IL, N_XL, tAB);
  expect(r1.affine.origin.x).toBe(r2.affine.origin.x);
  expect(r1.affine.origin.y).toBe(r2.affine.origin.y);
});

test('warn threshold floors at 0.5 m and scales with bin size', () => {
  expect(residualWarnThresholdM(1)).toBe(0.5);
  expect(residualWarnThresholdM(25)).toBe(6.25);
  expect(residualWarnThresholdM(NaN)).toBe(0.5);
});
