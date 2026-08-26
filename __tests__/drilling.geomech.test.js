// Geomechanics: closed-form exactness + oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  horizontalStresses, ucsFromDt, wellboreStability, mudWindowAlongWell,
  qualityScore, frictionalLimitRatio, boreholeFrame, farFieldInBoreholeFrame,
  LITHOLOGY_SEEDS,
} from '../engines/drilling/geomech.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const g = 9.80665;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('geomech_cases.json');
const FX = golden.verticalFixture;
const P = golden.params;

describe('closed forms', () => {
  test('vertical well collapse and frac initiation match the exact algebra', () => {
    const st = wellboreStability(FX.inputs);
    expectClose(st.collapsePa, FX.expected.closedFormCollapsePa, 1e-5, 500);
    expectClose(st.fracInitPa, FX.expected.closedFormFracPa, 1e-5, 500);
    expect(Math.abs(st.breakoutThetaDeg - 90)).toBeLessThanOrEqual(1);
  });

  test('poroelastic algebra + frictional ratio exact', () => {
    const q = frictionalLimitRatio(30);
    expectClose(q, (1 + 0.5) / (1 - 0.5), 1e-12);
    const { shminPa, k0Used } = horizontalStresses({
      svPa: [50e6], ppPa: [20e6], nu: 0.25, frictionAngleDeg: 45,
    });
    expectClose(k0Used, 0.25 / 0.75, 1e-12);
    expectClose(shminPa[0], (0.25 / 0.75) * 30e6 + 20e6, 1e-9);
  });

  test('strain terms and k0 override', () => {
    const withStrain = horizontalStresses({
      svPa: [50e6], ppPa: [20e6], nu: 0.25, frictionAngleDeg: 45,
      ePa: 20e9, epsX: 1e-4, epsY: 3e-4,
    });
    const dMin = (20e9 / (1 - 0.0625)) * (1e-4 + 0.25 * 3e-4);
    const dMax = (20e9 / (1 - 0.0625)) * (3e-4 + 0.25 * 1e-4);
    expectClose(withStrain.shminPa[0], (0.25 / 0.75) * 30e6 + 20e6 + dMin, 1e-9);
    expectClose(withStrain.shmaxPa[0], (0.25 / 0.75) * 30e6 + 20e6 + dMax, 1e-9);
    const k0 = horizontalStresses({
      svPa: [50e6], ppPa: [20e6], nu: 0.25, frictionAngleDeg: 45, k0Override: 0.8,
    });
    expectClose(k0.shminPa[0], 0.8 * 30e6 + 20e6, 1e-9);
  });

  test('frictional bounds clamp and count', () => {
    // Tiny nu drives the estimate below the active limit at phi=20.
    const res = horizontalStresses({
      svPa: [80e6], ppPa: [20e6], nu: 0.05, frictionAngleDeg: 20,
    });
    const q = frictionalLimitRatio(20);
    expectClose(res.shminPa[0], 60e6 / q + 20e6, 1e-9);
    expect(res.clampedCount).toBe(1);
    expect(res.warnings.length).toBe(1);
  });

  test('UCS correlations reproduce the published formulas', () => {
    const dt = [300]; // us/m -> Vp = 3.333 km/s
    const h = ucsFromDt({ dtUsPerM: dt, correlation: 'horsrud' });
    expectClose(h.ucsPa[0], 0.77 * (1e6 / 300 / 1000) ** 3.2 * 1e6, 1e-12);
    const m = ucsFromDt({ dtUsPerM: dt, correlation: 'mcnally' });
    expectClose(m.ucsPa[0], 1200 * Math.exp(-0.036 * 300 * 0.3048) * 1e6, 1e-12);
    const c = ucsFromDt({ dtUsPerM: dt, correlation: 'constant', params: { ucsPa: 5e7 } });
    expect(c.ucsPa[0]).toBe(5e7);
    expect(() => ucsFromDt({ dtUsPerM: dt, correlation: 'nope' })).toThrow(/Unknown/);
  });

  test('rotation: orthonormal frame and principal alignment along SHmax', () => {
    const { xb, yb, zb } = boreholeFrame(90, 60);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expectClose(dot(xb, xb), 1, 1e-12);
    expectClose(dot(yb, yb), 1, 1e-12);
    expectClose(dot(zb, zb), 1, 1e-12);
    expectClose(dot(xb, zb), 0, 0, 1e-12);
    // Horizontal well drilled ALONG SHmax (azi 60 = SHmax azimuth): the
    // borehole axis stress is SHmax; the cross-section sees Sv and Shmin.
    const sig = farFieldInBoreholeFrame({
      svPa: 55e6, shmaxPa: 60e6, shminPa: 45e6, ppPa: 0, alphaBiot: 0,
      shmaxAzimuthDeg: 60, incDeg: 90, aziDeg: 60,
    });
    expectClose(sig.s33, 60e6, 1e-9);
    expectClose(sig.s11, 55e6, 1e-9); // high side of a horizontal well = vertical
    expectClose(sig.s22, 45e6, 1e-9);
    expectClose(sig.s12, 0, 0, 1);
    expectClose(sig.s13, 0, 0, 1);
    expectClose(sig.s23, 0, 0, 1);
  });

  test('isotropic horizontal stress: window independent of well azimuth', () => {
    const base = {
      svPa: 55e6, shmaxPa: 50e6, shminPa: 50e6, ppPa: 20e6, ucsPa: 40e6,
      shmaxAzimuthDeg: 0, incDeg: 45, frictionAngleDeg: 30, nu: 0.25,
    };
    const a = wellboreStability({ ...base, aziDeg: 0 });
    const b = wellboreStability({ ...base, aziDeg: 137 });
    expectClose(a.collapsePa, b.collapsePa, 1e-9, 100);
    expectClose(a.fracInitPa, b.fracInitPa, 1e-9, 100);
  });

  test('monotonicity: stronger rock lowers the collapse pressure', () => {
    const base = { ...FX.inputs };
    const weak = wellboreStability({ ...base, ucsPa: 30e6 });
    const strong = wellboreStability({ ...base, ucsPa: 60e6 });
    expect(strong.collapsePa).toBeLessThan(weak.collapsePa);
  });

  test('quality score and lithology seeds', () => {
    const ok = qualityScore({
      svPa: [50e6], shmaxPa: [45e6], shminPa: [40e6], ppPa: [20e6], regime: 'NF',
    });
    expect(ok.score).toBe(100);
    const bad = qualityScore({
      svPa: [50e6], shmaxPa: [45e6], shminPa: [48e6], ppPa: [20e6], regime: 'NF',
    });
    expect(bad.score).toBe(80);
    expect(LITHOLOGY_SEEDS.find((l) => l.name === 'shale').nu).toBe(0.35);
  });
});

describe('oracle golden agreement (geomech_cases.json)', () => {
  const prof = golden.profile;

  test('horizontal stresses + UCS over the synthetic profile', () => {
    const hs = horizontalStresses({
      svPa: prof.svPa, ppPa: prof.ppPa, nu: P.nu, alphaBiot: P.alphaBiot,
      ePa: P.ePa, epsX: P.epsX, epsY: P.epsY,
      frictionAngleDeg: P.frictionAngleDeg, regime: P.regime,
    });
    expect(hs.clampedCount).toBe(prof.clampedCount);
    for (let i = 0; i < prof.tvdM.length; i += 1) {
      expectClose(hs.shminPa[i], prof.shminPa[i], 1e-6, 1);
      expectClose(hs.shmaxPa[i], prof.shmaxPa[i], 1e-6, 1);
    }
    const ucs = ucsFromDt({ dtUsPerM: prof.dtUsPerM, correlation: 'horsrud' });
    for (let i = 0; i < prof.tvdM.length; i += 1) {
      expectClose(ucs.ucsPa[i], prof.ucsPa[i], 1e-6, 1);
    }
  });

  for (const c of golden.cases) {
    test(`${c.well}: mud window along the trajectory`, () => {
      const res = mudWindowAlongWell({
        stations: c.stations,
        profile: {
          tvdM: prof.tvdM, svPa: prof.svPa, shmaxPa: prof.shmaxPa,
          shminPa: prof.shminPa, ppPa: prof.ppPa, ucsPa: prof.ucsPa,
        },
        params: {
          shmaxAzimuthDeg: P.shmaxAzimuthDeg, frictionAngleDeg: P.frictionAngleDeg,
          nu: P.nu, tensileStrengthPa: P.tensileStrengthPa, alphaBiot: P.alphaBiot,
        },
        stepMdM: 30,
      });
      expect(res.rows.length).toBe(c.expected.nRows);
      for (const cp of c.expected.checkpoints) {
        const row = res.rows.find((r) => Math.abs(r.md - cp.md) < 1e-6);
        expect(row).toBeTruthy();
        expectClose(row.tvd, cp.tvd, 1e-6, 1e-6);
        expectClose(row.ppEmwKgM3, cp.ppEmwKgM3, 1e-6, 1e-4);
        expectClose(row.collapseEmwKgM3, cp.collapseEmwKgM3, 1e-6, 1e-3);
        expectClose(row.fracInitEmwKgM3, cp.fracInitEmwKgM3, 1e-6, 1e-3);
      }
      expectClose(res.tightest.widthKgM3, c.expected.tightestWidthKgM3, 1e-6, 1e-3);
      expectClose(res.tightest.md, c.expected.tightestMd, 1e-6, 1e-6);
    });
  }

  test('guards', () => {
    expect(() => horizontalStresses({ svPa: [1], ppPa: [] })).toThrow();
    expect(() => wellboreStability({ ...FX.inputs, ucsPa: 0 })).toThrow(/UCS/);
    expect(() => mudWindowAlongWell({
      stations: golden.cases[0].stations,
      profile: { tvdM: [5000], svPa: [1e8], shmaxPa: [1e8], shminPa: [1e8], ppPa: [5e7], ucsPa: [4e7] },
      params: {},
    })).toThrow(/does not cover/);
  });
});
