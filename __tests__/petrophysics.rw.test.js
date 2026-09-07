// PT9d: Rw from NaCl salinity (Bateman & Konen 1977 fit to Gen-9) and
// its inverse against the oracle's analytic cases and chart anchors.

import fs from 'fs';
import path from 'path';
import { rwFromSalinity, salinityFromRw, rwArps } from '../engines/petrophysics/rw';

const analytic = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'petrophysics', 'analytic_cases.json'), 'utf8'));
const close = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

test('matches the oracle analytic cases at 1e-12', () => {
  expect(close(rwFromSalinity(30000, 75), analytic.rw_salinity_30000_75f.out)).toBe(true);
  expect(close(rwFromSalinity(100000, 150), analytic.rw_salinity_100000_150f.out)).toBe(true);
  expect(close(salinityFromRw(rwFromSalinity(30000, 120), 120), analytic.salinity_from_rw_roundtrip.out)).toBe(true);
});

test('sits within 10 percent of the Gen-9 chart at 75 degF and inverts exactly', () => {
  for (const [ppm, chart] of [[10000, 0.55], [30000, 0.20], [100000, 0.07]]) {
    const rw = rwFromSalinity(ppm, 75);
    expect(Math.abs(rw - chart) / chart).toBeLessThan(0.10);
    expect(Math.abs(salinityFromRw(rw, 75) - ppm) / ppm).toBeLessThan(1e-9);
  }
});

test('temperature enters through Arps only; invalid inputs are NaN', () => {
  const rw75 = rwFromSalinity(50000, 75);
  expect(close(rwFromSalinity(50000, 200), rwArps(rw75, 75, 200))).toBe(true);
  expect(Number.isNaN(rwFromSalinity(0, 75))).toBe(true);
  expect(Number.isNaN(rwFromSalinity(-5, 75))).toBe(true);
  expect(Number.isNaN(salinityFromRw(0.01, 75))).toBe(true); // below the fit floor
});
