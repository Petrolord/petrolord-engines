/**
 * AVO calibration and classes (QI upgrade P2.10). Gates call the shipped
 * functions: the per-well scale against the pooled least squares of
 * qi/avoWells.js on one well, the scale field exact at the wells and
 * constant for equal scales (kriging and inverse distance), the class code
 * against the one classifier on its borders, and the Shuey terms rule.
 * Negative controls: one pooled scale misses a drifting survey that the
 * field follows; a two-term fit of three-term data biases the gradient that
 * a three-term fit recovers exactly.
 */
import { wellScale, scaleFieldAt, avoClassCode, shueyTermsFor, CLASS_NAMES } from '../engines/qi/avoCalibration';
import { compareAtWells } from '../engines/qi/avoWells';
import { avoClass } from '../engines/rockphysics/avo';
import { fitShuey, akiRichards } from '../engines/qi/avo';

test('a well\'s scale is the pooled least squares on that well alone', () => {
  const row = { name: 'W', modelled: { A: 0.08, B: -0.21 }, observed: { A: 40, B: -110 } };
  const s = wellScale(row);
  expect(s).toBeCloseTo((0.08 * 40 + 0.21 * 110) / (0.08 * 0.08 + 0.21 * 0.21), 9);
  const pooled = compareAtWells([{ name: 'W', modelled: row.modelled, observed: row.observed }]);
  expect(pooled.scale).toBeCloseTo(s, 12);
  expect(Number.isNaN(wellScale({ modelled: { A: 0, B: 0 }, observed: row.observed }))).toBe(true);
});

describe('scale field', () => {
  const wells = [{ name: 'A', x: 0, y: 0, scale: 0.010 }, { name: 'B', x: 2000, y: 0, scale: 0.014 }, { name: 'C', x: 0, y: 2000, scale: 0.012 }];
  const vg = { model: 'spherical', range: 5000, sill: 1 };
  test('exact at the wells and between their values', () => {
    for (const o of [{}, { method: 'kriging', variogram: vg }]) {
      for (const w of wells) expect(scaleFieldAt(wells, w, o)).toBeCloseTo(w.scale, 12);
      const mid = scaleFieldAt(wells, { x: 800, y: 700 }, o);
      expect(mid).toBeGreaterThan(0.010); expect(mid).toBeLessThan(0.014);
    }
    const same = wells.map((w) => ({ ...w, scale: 0.02 }));
    expect(scaleFieldAt(same, { x: 1234, y: 567 }, { method: 'kriging', variogram: vg })).toBeCloseTo(0.02, 12);
  });
  test('negative control: in a survey whose amplitude scale drifts east, one pooled scale misses the far side and the field does not', () => {
    const truth = (x) => 0.01 * (1 + x / 4000);
    const ws = [0, 1000, 3000, 4000].map((x, i) => ({ name: `W${i}`, x, y: 0, scale: truth(x) }));
    const pooled = ws.reduce((a, w) => a + w.scale, 0) / ws.length;
    const at = { x: 3800, y: 0 };
    expect(Math.abs(scaleFieldAt(ws, at) - truth(3800)) / truth(3800)).toBeLessThan(0.03);
    expect(Math.abs(pooled - truth(3800)) / truth(3800)).toBeGreaterThan(0.2);
  });
});

test('class codes follow the one classifier, borders included', () => {
  for (const [A, B] of [[0.05, -0.1], [0.02, -0.1], [-0.02, -0.1], [0, 0], [-0.05, -0.1], [-0.05, 0], [-0.05, 0.03]]) {
    expect(CLASS_NAMES[avoClassCode(A, B)]).toBe(avoClass(A, B));
  }
  expect(Number.isNaN(avoClassCode(NaN, 1))).toBe(true);
});

test('three Shuey terms only with three angles reaching 35 degrees; then the gradient comes back exactly', () => {
  expect(shueyTermsFor([5, 15, 25])).toBe(2);
  expect(shueyTermsFor([10, 40])).toBe(2);
  expect(shueyTermsFor([8, 22, 38])).toBe(3);
  const c = { dVpVp: 0.12, dVsVs: 0.18, dRhoRho: 0.05, vsVp: 0.5 };
  const angles = [8, 22, 38];
  const amps = angles.map((t) => akiRichards(c, t));
  const g2 = c.vsVp ** 2;
  const B = 0.5 * c.dVpVp - 4 * g2 * c.dVsVs - 2 * g2 * c.dRhoRho;
  expect(fitShuey(angles, amps, { terms: shueyTermsFor(angles) }).B).toBeCloseTo(B, 10);
  // negative control: two terms over the same angles bias the gradient
  expect(Math.abs(fitShuey(angles, amps, { terms: 2 }).B - B) / Math.abs(B)).toBeGreaterThan(0.05);
});

test('a class map cell is the class of the zone means of the scaled A and B', () => {
  const { zoneProducts, zoneRange } = require('../engines/qi/zoneMaps');
  const A = Float64Array.from({ length: 50 }, (_, k) => (k >= 10 && k <= 20 ? -60 : 0));
  const B = Float64Array.from({ length: 50 }, (_, k) => (k >= 10 && k <= 20 ? -120 : 0));
  const range = zoneRange(10, 20, 50);
  const out = zoneProducts({ traces: { 0: A, 1: B }, products: [{ key: 'c', kind: 'avo_class', a: 0, b: 1, scale: 1000 }], range, top: 10, base: 20, dtMs: 4 });
  expect(CLASS_NAMES[out[0]]).toBe('III'); // A = -0.06, B = -0.12
  // negative control: unscaled, the same means read as class III too but with A, B 1000 times too large the band is meaningless; scale 100000 puts A inside class II
  const out2 = zoneProducts({ traces: { 0: A, 1: B }, products: [{ key: 'c', kind: 'avo_class', a: 0, b: 1, scale: 100000 }], range, top: 10, base: 20, dtMs: 4 });
  expect(CLASS_NAMES[out2[0]]).toBe('II');
});
