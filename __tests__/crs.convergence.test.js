// Convergence oracles: the analytic Transverse Mercator first-order
// formula gamma ~= (lon - lon0) * sin(lat) (Snyder, Map Projections — A
// Working Manual). Our function returns the grid azimuth of true north,
// which for TM east of the central meridian in the northern hemisphere is
// the NEGATIVE of that classic convergence (true north leans back toward
// the central meridian).

import proj4 from 'proj4';
import { catalogGet } from '../lib/crs/catalog';
import { makeProjector } from '../lib/crs/transform';
import { gridConvergenceDeg, gridAzFromTrueAz, trueAzFromGridAz } from '../lib/crs/convergence';

const d2r = Math.PI / 180;

test('zero on the central meridian', () => {
  const proj = makeProjector(proj4, catalogGet('EPSG:32631').proj4);
  const p = proj.fromLonLat(3, 52);
  expect(Math.abs(gridConvergenceDeg(proj, p.x, p.y))).toBeLessThan(1e-4);
});

test('UTM 31N at 52N 5E: -(lon-lon0)sin(lat) within 0.01 deg', () => {
  const proj = makeProjector(proj4, catalogGet('EPSG:32631').proj4);
  const p = proj.fromLonLat(5, 52);
  const analytic = -(5 - 3) * Math.sin(52 * d2r);
  expect(Math.abs(gridConvergenceDeg(proj, p.x, p.y) - analytic)).toBeLessThan(0.01);
});

test('British National Grid at 52N 1E: -(1-(-2))sin(52) within 0.01 deg', () => {
  const proj = makeProjector(proj4, catalogGet('EPSG:27700').proj4);
  const p = proj.fromLonLat(1, 52);
  const analytic = -(1 - -2) * Math.sin(52 * d2r);
  expect(Math.abs(gridConvergenceDeg(proj, p.x, p.y) - analytic)).toBeLessThan(0.01);
});

test('sign flips west of the central meridian and in the southern hemisphere', () => {
  const proj = makeProjector(proj4, catalogGet('EPSG:32631').proj4);
  const west = proj.fromLonLat(1, 52);
  expect(gridConvergenceDeg(proj, west.x, west.y)).toBeGreaterThan(0);
  const projS = makeProjector(proj4, catalogGet('EPSG:32731').proj4);
  const south = projS.fromLonLat(5, -30);
  expect(gridConvergenceDeg(projS, south.x, south.y)).toBeGreaterThan(0);
});

test('azimuth conversions are inverse of each other', () => {
  expect(gridAzFromTrueAz(120, -1.5)).toBeCloseTo(118.5, 12);
  expect(trueAzFromGridAz(118.5, -1.5)).toBeCloseTo(120, 12);
});
