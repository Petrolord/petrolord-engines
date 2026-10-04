/**
 * Well Test U2-007: slant pseudo-skin of a deviated well (Cinco-Ley, Ramey
 * and Miller 1975) against the published Cinco-Ley table, as printed in
 * Economides and Nolte, Reservoir Stimulation, 3rd ed., chapter 1,
 * Table 1-3. And, as information the report states, how the Papatzacos
 * pseudo-skin the studio uses for vertical partial penetration compares
 * with the same table's s_c column.
 */
import { slantPseudoSkin, papatzacosPseudoSkin } from '../engines/welltest/partialPenetration.js';

// full penetration (hw cos(theta) / h = 1), isotropic: [hD, theta, s_theta]
const FULL = [
  [100, 15, -0.128], [100, 30, -0.517], [100, 45, -1.178], [100, 60, -2.149], [100, 75, -3.577],
  [1000, 15, -0.206], [1000, 30, -0.824], [1000, 45, -1.850], [1000, 60, -3.298], [1000, 75, -5.282],
];

describe('Cinco-Ley slant pseudo-skin against the published table', () => {
  test.each(FULL)('hD %p, theta %p degrees: s_theta %p within 4 percent', (hD, theta, published) => {
    const r = slantPseudoSkin({ thetaDeg: theta, h: hD, rw: 1, kvkh: 1 });
    expect(r.ok).toBe(true);
    expect(Math.abs(r.sTheta - published) / Math.abs(published)).toBeLessThan(0.04);
  });

  test('vertical is zero; anisotropy flattens the angle; beyond 75 degrees is refused', () => {
    expect(slantPseudoSkin({ thetaDeg: 0, h: 100, rw: 1, kvkh: 1 }).sTheta).toBeCloseTo(0, 14);
    const iso = slantPseudoSkin({ thetaDeg: 60, h: 100, rw: 1, kvkh: 1 });
    const aniso = slantPseudoSkin({ thetaDeg: 60, h: 100, rw: 1, kvkh: 0.1 });
    expect(aniso.thetaPrime).toBeCloseTo((Math.atan(Math.sqrt(0.1) * Math.tan(Math.PI / 3)) * 180) / Math.PI, 12);
    expect(aniso.hD).toBeCloseTo(100 * Math.sqrt(10), 9);
    expect(Math.abs(aniso.sTheta)).toBeLessThan(Math.abs(iso.sTheta));
    expect(slantPseudoSkin({ thetaDeg: 80, h: 100, rw: 1, kvkh: 1 }).code).toBe('outside-correlation');
  });

  test('negative control: a natural log in place of log10 misses the published hD 1000, 60 degree value by more than 10 percent', () => {
    const r = slantPseudoSkin({ thetaDeg: 60, h: 1000, rw: 1, kvkh: 1 });
    const wrong = -Math.pow(r.thetaPrime / 41, 2.06) - Math.pow(r.thetaPrime / 56, 1.865) * Math.log(1000 / 100);
    expect(Math.abs(wrong - -3.298) / 3.298).toBeGreaterThan(0.1);
    expect(Math.abs(r.sTheta - -3.298) / 3.298).toBeLessThan(0.04);
  });

  test('partially open and slanted, the table holds a larger slant term than the full-penetration correlation (the stated limit)', () => {
    // hD 100, centred, half open, 60 degrees: table -2.879 against the correlation's -2.149 class value
    const r = slantPseudoSkin({ thetaDeg: 60, h: 100, rw: 1, kvkh: 1 });
    expect(r.sTheta).toBeGreaterThan(-2.879 + 0.5);
  });
});

describe('Papatzacos against the s_c column of the same table (information for the report)', () => {
  // [hD, zw/h of the interval midpoint from the base, hw/h, published s_c]
  const SC = [
    [100, 0.95, 0.1, 20.810], [100, 0.875, 0.25, 8.641], [100, 0.75, 0.5, 3.067],
    [100, 0.5, 0.1, 15.213], [100, 0.5, 0.25, 6.611], [100, 0.5, 0.5, 2.369], [100, 0.5, 0.75, 0.694],
    [1000, 0.95, 0.1, 41.521], [1000, 0.875, 0.25, 15.733], [1000, 0.5, 0.5, 4.777],
  ];
  const pap = ([hD, z, f]) => papatzacosPseudoSkin({ h: hD, hp: f * hD, h1: hD - z * hD - (f * hD) / 2, rw: 1, kvkh: 1 }).spp;
  test('an interval at the top of the pay agrees within 0.25', () => {
    for (const row of SC.filter((r) => r[1] + r[2] / 2 >= 0.999)) expect(Math.abs(pap(row) - row[3])).toBeLessThan(0.25);
  });
  test('an interval centred in the pay comes out higher than the table, by under 1.6 skin units', () => {
    for (const row of SC.filter((r) => r[1] === 0.5)) {
      const d = pap(row) - row[3];
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(1.6);
    }
  });
});
