// Casing wear: crescent groove geometry + energy model vs oracle goldens.
import fs from 'fs';
import path from 'path';
import {
  grooveArea, grooveDepthForArea, slidingDistanceM, computeCasingWear,
} from '../engines/drilling/casingWear.js';
import { computeTorqueDrag } from '../engines/drilling/torqueDrag.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const wearGolden = G('casingwear_cases.json');
const tdGolden = G('torquedrag_cases.json');

describe('crescent groove geometry', () => {
  const R = wearGolden.casing.irM;
  const r = wearGolden.tjRadiusM;

  test('oracle anchors: A(d) matches the independent lens formula', () => {
    for (const { depthM, areaM2 } of wearGolden.grooveGeometry) {
      // Golden floats are rounded to 9 dp; allow that quantum.
      expectClose(grooveArea({ casingIrM: R, tjRadiusM: r, depthM }), areaM2, 1e-6, 1e-9);
    }
  });

  test('depth ↔ area round trip', () => {
    for (const d of [0.0005, 0.002, 0.007, 0.012]) {
      const a = grooveArea({ casingIrM: R, tjRadiusM: r, depthM: d });
      expectClose(grooveDepthForArea({ casingIrM: R, tjRadiusM: r, areaM2: a }), d, 1e-8, 1e-11);
    }
    expect(grooveDepthForArea({ casingIrM: R, tjRadiusM: r, areaM2: 0 })).toBe(0);
  });

  test('A(0) = 0 and A grows monotonically', () => {
    expect(grooveArea({ casingIrM: R, tjRadiusM: r, depthM: 0 })).toBeCloseTo(0, 12);
    let prev = 0;
    for (let d = 0.001; d <= 0.01; d += 0.001) {
      const a = grooveArea({ casingIrM: R, tjRadiusM: r, depthM: d });
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });
});

describe('sliding distance and wear volume', () => {
  test('L = 2πr·rpm·60·hours exactly', () => {
    const s = wearGolden.schedule[0];
    expectClose(
      slidingDistanceM({ tjRadiusM: wearGolden.tjRadiusM, rpm: s.rpm, hours: s.hours }),
      wearGolden.totalSlidingDistanceM, 1e-12,
    );
  });

  test('constant side force: V = WF·N·L closed form', () => {
    const profile = [
      { md: 0, sideForceNPerM: 500 },
      { md: 1000, sideForceNPerM: 500 },
    ];
    const res = computeCasingWear({
      tdProfile: profile,
      casing: { idM: 0.2205, wallM: 0.012, fromMd: 0, toMd: 300 },
      tjRadiusM: 0.0841375,
      schedule: [{ rpm: 100, hours: 10 }],
      wearFactorMm3PerKNm: 2,
      intervalM: 30,
    });
    const slide = 2 * Math.PI * 0.0841375 * 100 * 60 * 10;
    const vPerInterval = 2e-12 * (500 * 30) * slide;
    for (const row of res.rows) {
      expectClose(row.wearVolumeM3, vPerInterval, 1e-12);
    }
    expectClose(res.totalSlidingDistanceM, slide, 1e-12);
  });
});

describe('oracle golden agreement (casingwear_cases.json)', () => {
  test('wear rows from the horizontal rotate-on-bottom profile', () => {
    const c = tdGolden.cases.find((x) => x.name === 'horizontal');
    const td = computeTorqueDrag({
      stations: c.stations, string: c.string, geometry: c.geometry,
      mud: { densityKgM3: c.mudDensityKgM3 }, operation: 'rotate_on_bottom',
      params: { ...c.params, stepM: 1 },
    });
    const res = computeCasingWear({
      tdProfile: td.profile,
      casing: {
        idM: wearGolden.casing.irM * 2,
        wallM: wearGolden.casing.wallM,
        fromMd: 0,
        toMd: wearGolden.casing.shoeMd,
      },
      tjRadiusM: wearGolden.tjRadiusM,
      schedule: wearGolden.schedule,
      wearFactorMm3PerKNm: wearGolden.wearFactorMm3PerKNm,
      intervalM: wearGolden.intervalM,
    });
    expect(res.rows.length).toBe(wearGolden.rows.length);
    for (let i = 0; i < res.rows.length; i += 1) {
      const a = res.rows[i];
      const b = wearGolden.rows[i];
      // Chained tolerance: JS profile vs oracle profile, then wear mapping.
      expectClose(a.sideForceN, b.sideForceN, 5e-3, 5);
      expectClose(a.wearDepthM, b.wearDepthM, 5e-3, 1e-6);
      expectClose(a.remainingWallM, b.remainingWallM, 5e-3, 1e-6);
    }
    expectClose(res.summary.maxWearDepthM, wearGolden.summary.maxWearDepthM, 5e-3, 1e-6);
    expectClose(res.summary.minRemainingWallM, wearGolden.summary.minRemainingWallM, 5e-3, 1e-6);
    expect(res.summary.collapseNote).toMatch(/API 5C3/);
  });

  test('burst derate is Barlow-linear in remaining wall', () => {
    const res = computeCasingWear({
      tdProfile: [{ md: 0, sideForceNPerM: 400 }, { md: 1200, sideForceNPerM: 400 }],
      casing: { idM: 0.2205, wallM: 0.012, fromMd: 0, toMd: 120, burstRatingPa: 50e6 },
      tjRadiusM: 0.0841375,
      schedule: [{ rpm: 120, hours: 40 }],
      wearFactorMm3PerKNm: 3,
      intervalM: 30,
    });
    for (const row of res.rows) {
      expectClose(row.burstDeratedPa, 50e6 * (row.remainingWallM / 0.012), 1e-12);
    }
  });

  test('input guards', () => {
    expect(() => computeCasingWear({ tdProfile: [], casing: {}, tjRadiusM: 0.08, schedule: [], wearFactorMm3PerKNm: 1 })).toThrow();
    expect(() => grooveArea({ casingIrM: 0.1, tjRadiusM: 0.2, depthM: 0 })).toThrow();
  });
});
