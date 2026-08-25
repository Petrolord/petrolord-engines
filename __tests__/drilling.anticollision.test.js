// ISCWSA separation rule vs the official clearance example wells
// (test-data/drilling/goldens/iscwsa_clearance_wells.json): 11 offset
// scenarios against the standard reference well, Rev4 covariances,
// k=3.5, sigma_pa=0.5, Sm=0.3, incl. the KOP-sliced sidetrack case
// (well 10, kop 900 m).
//
// Two gates per well: the published per-station separation factors at
// the official criteria (rtol 1e-2 / atol 1e-3 — same as welleng's own
// validation), and the welleng 0.29.0 oracle outputs (SF, C-C
// distance, pedal radii, bearings) at tight tolerances to pin the
// geometry port itself.

import fs from 'fs';
import path from 'path';
import { computeErrorModel } from '../engines/drilling/errorModel';
import {
  computeClearance, ladderSeries, travelingCylinderSeries, classifyClearance,
  closestXOnArc,
} from '../engines/drilling/antiCollision';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', 'iscwsa_clearance_wells.json'),
  'utf8',
));

function buildWell(name, radius) {
  const w = G.wells[name];
  const stations = w.md.map((md, i) => ({
    md, inc: w.inc[i], azi: w.azi[i], tvd: w.tvd[i],
  }));
  const positions = w.md.map((_, i) => ({ n: w.n[i], e: w.e[i], tvd: w.tvd[i] }));
  const model = computeErrorModel(stations, w.header);
  return {
    stations, positions, cov: model.totalCov, sources: model.sources, radius,
  };
}

const reference = buildWell('Reference well', G.acr.refRadius);
const offsetNames = Object.keys(G.wells).filter((n) => n !== 'Reference well');

const clearances = {};
for (const name of offsetNames) {
  const offset = buildWell(name, G.acr.offRadius);
  clearances[name] = computeClearance(reference, offset, {
    k: G.acr.k, sigmaPa: G.acr.sigmaPa, Sm: G.acr.Sm,
    kopDepth: G.oracle[name].kopDepth,
  });
}

describe('separation factors vs the published ISCWSA values', () => {
  for (const name of offsetNames) {
    test(name, () => {
      const sfOfficial = G.wells[name].sfOfficial;
      const got = clearances[name].sf;
      expect(got).toHaveLength(sfOfficial.length);
      for (let i = 0; i < sfOfficial.length; i++) {
        // np.allclose criteria: |got - exp| <= atol + rtol * |exp|
        expect(Math.abs(got[i] - sfOfficial[i]))
          .toBeLessThanOrEqual(1e-3 + 1e-2 * Math.abs(sfOfficial[i]));
      }
    });
  }
});

describe('geometry and uncertainty vs the welleng oracle', () => {
  for (const name of offsetNames) {
    test(name, () => {
      const o = G.oracle[name];
      const c = clearances[name];
      for (let i = 0; i < o.sf.length; i++) {
        expect(Math.abs(c.distanceCC[i] - o.distanceCC[i]))
          .toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(o.distanceCC[i])));
        expect(Math.abs(c.refPcr[i] - o.refPcr[i]))
          .toBeLessThanOrEqual(1e-6 * Math.max(1, o.refPcr[i]));
        expect(Math.abs(c.offPcr[i] - o.offPcr[i]))
          .toBeLessThanOrEqual(1e-6 * Math.max(1, o.offPcr[i]));
        expect(Math.abs(c.sf[i] - o.sf[i]))
          .toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(o.sf[i])));
        // welleng rounds bearing radians to 6 dp before reporting
        const dHoz = Math.abs(c.hozBearingDeg[i] - o.hozBearingDeg[i]);
        expect(Math.min(dHoz, 360 - dHoz)).toBeLessThanOrEqual(1e-3);
        const dTc = Math.abs(c.travCylAziDeg[i] - o.travCylAziDeg[i]);
        expect(Math.min(dTc, 360 - dTc)).toBeLessThanOrEqual(1e-3);
      }
    });
  }
});

describe('chart series and classification', () => {
  const results = offsetNames.map((name) => ({
    label: name, clearance: clearances[name],
  }));

  test('ladder series carries one point per reference station', () => {
    const ladder = ladderSeries(results);
    expect(ladder).toHaveLength(offsetNames.length);
    for (const row of ladder) {
      expect(row.points).toHaveLength(clearances[row.label].md.length);
      for (const p of row.points) {
        expect(Number.isFinite(p.distanceCC)).toBe(true);
        expect(Number.isFinite(p.masd)).toBe(true);
      }
    }
  });

  test('traveling-cylinder azimuths stay in [0, 360)', () => {
    for (const row of travelingCylinderSeries(results)) {
      for (const p of row.points) {
        expect(p.azimuthDeg).toBeGreaterThanOrEqual(0);
        expect(p.azimuthDeg).toBeLessThan(360);
        expect(p.radius).toBeGreaterThanOrEqual(0);
      }
    }
    for (const row of travelingCylinderSeries(results, { referenceFrame: 'north' })) {
      for (const p of row.points) {
        expect(p.azimuthDeg).toBeGreaterThanOrEqual(0);
        expect(p.azimuthDeg).toBeLessThan(360);
      }
    }
  });

  test('classification flags the known collision scenarios', () => {
    // Wells whose published SF dips below 1.0 (crossing / near-miss set).
    const hits = new Set(['03 - well', '04 - well', '09 - well', '10 - well', '11 - well']);
    for (const name of offsetNames) {
      const cls = classifyClearance(clearances[name]);
      expect(cls.status === 'no-go').toBe(hits.has(name));
      if (cls.status === 'no-go') {
        expect(cls.violations.some((v) => v.level === 'no-go')).toBe(true);
      }
    }
  });
});

describe('closest point on arc', () => {
  test('straight leg reduces to tangent projection', () => {
    const x = closestXOnArc([0, 0, 0], [0, 0, 1], [0, 0, 1], 100, 0, [5, 0, 40]);
    expect(x).toBeCloseTo(40, 9);
    expect(closestXOnArc([0, 0, 0], [0, 0, 1], [0, 0, 1], 100, 0, [5, 0, -10])).toBe(0);
    expect(closestXOnArc([0, 0, 0], [0, 0, 1], [0, 0, 1], 100, 0, [5, 0, 500])).toBe(100);
  });

  test('quarter-circle arc: closest point to the centre-side point is exact', () => {
    // Arc from [0,0,0] heading +V, turning to +N over 90 deg; radius
    // R = dmd / (pi/2). Point at the arc's midpoint direction.
    const dmd = 100;
    const R = dmd / (Math.PI / 2);
    const centre = [R, 0, 0];
    // point outside the arc along the 45-degree radius
    const q = [
      centre[0] - 2 * R * Math.cos(Math.PI / 4), 0, 2 * R * Math.sin(Math.PI / 4),
    ];
    const x = closestXOnArc([0, 0, 0], [0, 0, 1], [1, 0, 0], dmd, Math.PI / 2, q);
    expect(x).toBeCloseTo(dmd / 2, 6);
  });
});
