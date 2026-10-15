/**
 * Depth uncertainty for prospects (QI upgrade P2.12). Gates call the shipped
 * functions: the linear-velocity depth against a numerical integration of
 * dt = dz / (v0 + k z), the GRV of a dome scaling exactly with a constant
 * velocity (the closure engine on each case), the weighted quantiles, and
 * the stated Pg suggestion rule. Negative controls: the constant-velocity
 * depth is not the linear one; one case has no range; the suggestion is
 * never applied without a baseline.
 */
import { timeToDepthM, depthCaseGrvs, weightedQuantile, suggestPg } from '../engines/qi/depthUncertainty';

test('linear velocity: depth matches the integral of the travel time; negative control: a constant velocity misses', () => {
  const v0 = 1800; const k = 0.6;
  const zTrue = 2500;
  let t = 0; const n = 200000; const dz = zTrue / n;
  for (let i = 0; i < n; i++) t += dz / (v0 + k * (i + 0.5) * dz);
  const twtMs = 2000 * t;
  expect(-timeToDepthM(twtMs, { kind: 'linear', v0, k })).toBeCloseTo(zTrue, 4);
  expect(Math.abs(-timeToDepthM(twtMs, { kind: 'constant', v: v0 }) - zTrue)).toBeGreaterThan(200);
  expect(-timeToDepthM(1000, { kind: 'linear', v0: 2000, k: 0 })).toBeCloseTo(1000, 12);
});

test('a dome\'s GRV to spill scales exactly with a constant velocity; ranges and weighted quantiles over the cases', () => {
  const nx = 61; const ny = 61; const dx = 50;
  const spec = { nx, ny, dx, dy: dx, x0: 0, y0: 0 };
  // a time dome (positive ms) with a saddle-free flank to the edge
  const twt = Float64Array.from({ length: nx * ny }, (_, i) => { const x = (i % nx) - 30; const y = Math.floor(i / nx) - 30; return 1500 + 0.08 * (x * x + y * y); });
  const r = depthCaseGrvs({ twt, spec, cases: [{ name: 'slow', velocity: { kind: 'constant', v: 2000 } }, { name: 'mid', velocity: { kind: 'constant', v: 2200 } }, { name: 'fast', velocity: { kind: 'constant', v: 2600 } }] });
  expect(r.rows[1].grvM3 / r.rows[0].grvM3).toBeCloseTo(2200 / 2000, 10);
  expect(r.rows[2].grvM3 / r.rows[0].grvM3).toBeCloseTo(2600 / 2000, 10);
  expect(r.low).toBe(r.rows[0].grvM3); expect(r.high).toBe(r.rows[2].grvM3);
  expect(r.q50).toBeCloseTo(r.rows[1].grvM3, 6);
  const one = depthCaseGrvs({ twt, spec, cases: [{ name: 'only', velocity: { kind: 'constant', v: 2200 } }] });
  expect(one.high - one.low).toBe(0);
  expect(weightedQuantile([1, 2, 3], [1, 1, 1], 0.5)).toBe(2);
  expect(weightedQuantile([1, 2, 3], [1, 1, 2], 0.5)).toBeGreaterThan(2);
});

test('the Pg suggestion follows its stated rule, bounded, and needs the user\'s own Pg', () => {
  expect(suggestPg({ baselinePg: 0.3, recommendation: 'mature', conformance: 0.82, feasibility: 'feasible' })).toMatchObject({ factor: 1.3 });
  expect(suggestPg({ baselinePg: 0.3, recommendation: 'mature', conformance: 0.82, feasibility: 'feasible' }).suggestedPg).toBeCloseTo(0.39, 12);
  expect(suggestPg({ baselinePg: 0.3, recommendation: 'mature', conformance: 0.5, feasibility: 'feasible' }).factor).toBe(1);
  expect(suggestPg({ baselinePg: 0.3, recommendation: 'downgrade' }).suggestedPg).toBeCloseTo(0.21, 12);
  expect(suggestPg({ baselinePg: 0.8, recommendation: 'mature', conformance: 0.9, feasibility: 'feasible' }).suggestedPg).toBe(0.9);
  expect(suggestPg({ baselinePg: 0.3, recommendation: 'investigate' }).factor).toBe(1);
  expect(() => suggestPg({ recommendation: 'mature' })).toThrow(/your own chance/);
});
