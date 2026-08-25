// WMM2025 synthesis vs the official NOAA/NCEI test-value table
// (test-data/drilling/goldens/wmm2025_noaa_testvalues.json — the
// published double-precision test points for the 11/13/2024 release).
// The table is printed to 0.1 nT / 0.01 deg, so the gates use half-ulp
// tolerances of that rounding: 0.06 nT for field components and
// 0.006 deg for angles. Any coefficient corruption or synthesis error
// fails these by orders of magnitude.

import fs from 'fs';
import path from 'path';
import {
  fieldAt, declinationAt, decimalYearOf, wrapTo180, WMM2025,
} from '../engines/drilling/magnetics';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', 'wmm2025_noaa_testvalues.json'),
  'utf8',
));

const NT_TOL = 0.06;
const DEG_TOL = 0.006;

describe('WMM2025 main field vs the official NOAA test values', () => {
  for (const c of G.mainField) {
    test(`${c.date} h=${c.heightKm}km lat=${c.latDeg} lon=${c.lonDeg}`, () => {
      const f = fieldAt({
        latDeg: c.latDeg, lonDeg: c.lonDeg, heightKm: c.heightKm, decimalYear: c.date,
      });
      expect(Math.abs(f.x - c.x)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.y - c.y)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.z - c.z)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.h - c.h)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.f - c.f)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.declinationDeg - c.d)).toBeLessThanOrEqual(DEG_TOL);
      expect(Math.abs(f.inclinationDeg - c.i)).toBeLessThanOrEqual(DEG_TOL);
      if (c.gv != null) {
        expect(Math.abs(f.gridVariationDeg - c.gv)).toBeLessThanOrEqual(DEG_TOL);
      } else {
        expect(f.gridVariationDeg).toBeNull();
      }
      expect(f.inModelRange).toBe(true);
    });
  }
});

describe('WMM2025 secular variation vs the official NOAA test values', () => {
  for (const c of G.secularVariation) {
    test(`${c.date} h=${c.heightKm}km lat=${c.latDeg} lon=${c.lonDeg}`, () => {
      const f = fieldAt({
        latDeg: c.latDeg, lonDeg: c.lonDeg, heightKm: c.heightKm, decimalYear: c.date,
      });
      expect(Math.abs(f.xDot - c.xDot)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.yDot - c.yDot)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.zDot - c.zDot)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.hDot - c.hDot)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.fDot - c.fDot)).toBeLessThanOrEqual(NT_TOL);
      expect(Math.abs(f.declinationDotDeg - c.dDot)).toBeLessThanOrEqual(DEG_TOL);
      expect(Math.abs(f.inclinationDotDeg - c.iDot)).toBeLessThanOrEqual(DEG_TOL);
    });
  }
});

describe('coefficient set integrity', () => {
  test('90 rows, degree 12, epoch 2025.0', () => {
    expect(WMM2025.coefficients).toHaveLength(90);
    expect(WMM2025.nMax).toBe(12);
    expect(WMM2025.epoch).toBe(2025.0);
    const seen = new Set();
    for (const [n, m] of WMM2025.coefficients) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(12);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(n);
      seen.add(`${n},${m}`);
    }
    expect(seen.size).toBe(90);
  });

  test('first dipole coefficient matches the published release', () => {
    const [n, m, g] = WMM2025.coefficients[0];
    expect([n, m]).toEqual([1, 0]);
    expect(g).toBe(-29351.8);
  });
});

describe('helpers and properties', () => {
  test('declinationAt exposes declination, dip, total field and validity', () => {
    const d = declinationAt({ latDeg: 80, lonDeg: 0, decimalYear: 2025.0 });
    expect(d.declinationDeg).toBeCloseTo(1.28, 2);
    expect(d.dipDeg).toBeCloseTo(83.21, 2);
    expect(d.totalFieldNt).toBeCloseTo(55178.5, 0);
    expect(d.inModelRange).toBe(true);
    expect(d.model).toBe('WMM-2025');
  });

  test('field is continuous across the longitude wrap', () => {
    const a = fieldAt({ latDeg: 10, lonDeg: 180, decimalYear: 2026.0 });
    const b = fieldAt({ latDeg: 10, lonDeg: -180, decimalYear: 2026.0 });
    expect(a.declinationDeg).toBeCloseTo(b.declinationDeg, 9);
    expect(a.f).toBeCloseTo(b.f, 6);
  });

  test('dates outside 2025.0-2030.0 are flagged, not refused', () => {
    expect(fieldAt({ latDeg: 5, lonDeg: 5, decimalYear: 2031.0 }).inModelRange).toBe(false);
    expect(fieldAt({ latDeg: 5, lonDeg: 5, decimalYear: 2024.9 }).inModelRange).toBe(false);
    expect(fieldAt({ latDeg: 5, lonDeg: 5, decimalYear: 2027.0 }).inModelRange).toBe(true);
  });

  test('decimalYearOf', () => {
    expect(decimalYearOf(2025, 1, 1)).toBe(2025.0);
    expect(decimalYearOf(2025, 7, 2)).toBeCloseTo(2025.4986, 3);
    // Leap year: mid-year lands on July 1 in 2028.
    expect(decimalYearOf(2028, 7, 1)).toBeCloseTo(2028.4973, 3);
  });

  test('wrapTo180', () => {
    expect(wrapTo180(190)).toBe(-170);
    expect(wrapTo180(-190)).toBe(170);
    expect(wrapTo180(180)).toBe(180);
    expect(wrapTo180(-51.22 - 360)).toBeCloseTo(-51.22, 10);
  });

  test('invalid inputs fail loudly', () => {
    expect(() => fieldAt({ latDeg: 91, lonDeg: 0, decimalYear: 2026 })).toThrow();
    expect(() => fieldAt({ latDeg: 0, lonDeg: 0 })).toThrow(/decimalYear/);
  });
});
