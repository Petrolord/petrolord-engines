// Moved with engines/qi/propertyCalibration.js from the Suite (QI course gate E2); the job-param checks, the
// fluid labels and the issue register stay in the Suite.
import {
  modeFilter, upscaleWells, fitProperty, predictTrace, calibrateProperty, posteriorTable,
} from '../engines/qi/propertyCalibration';
import { predictWithInterval, faciesPosterior } from '../engines/qi/propertyPrediction';

// Wells with a known porosity law: phi = 0.40 - 3.5e-5 AI plus a little noise,
// and facies from AI cut-offs (gas sand low, brine sand middle, shale high).
const dtMs = 4; const ns = 300;
let seed = 3; const u = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
function well(name, il, shift) {
  const ai = Array.from({ length: ns }, (_, k) => 7000 + 1200 * Math.sin((k + shift) / 9) + 300 * Math.sin((k + shift) / 2.3));
  const phi = ai.map((v) => 0.40 - 3.5e-5 * v + 0.004 * u());
  const fac = ai.map((v) => (v < 6300 ? 1 : v < 7400 ? 2 : 3));
  return { name, il, xl: 0, ai, phi, fac };
}
const W = [well('A', 0, 0), well('B', 1, 17), well('C', 2, 41), well('D', 3, 63)];
const asJob = (kind) => ({
  kind,
  wells: W.map((w) => ({ name: w.name, il: w.il, xl: w.xl, ln_ai: w.ai.map(Math.log), target: kind === 'facies' ? w.fac : w.phi })),
  ...(kind === 'facies' ? { names: { 1: 'gas sand', 2: 'brine sand', 3: 'shale' }, density: 'gaussian', priors: 'wells' } : {}),
  upscaleHz: 50,
});

describe('mode filter', () => {
  test('mode filter keeps the majority and skips code 0', () => {
    expect(modeFilter([1, 1, 2, 1, 1], 1)).toEqual([1, 1, 1, 1, 1]);
    expect(modeFilter([0, 0, 0], 1).every(Number.isNaN)).toBe(true);
  });
});

describe('porosity from impedance', () => {
  const pr = asJob('porosity');
  test('with the true impedance at each left-out well, the prediction is close and the 80 percent interval covers about 80 percent', () => {
    const res = calibrateProperty({ pr, aiTraces: W.map((w) => upscaleWells(pr, dtMs).find((x) => x.name === w.name).ai), dtMs });
    expect(res.summary.b).toBeCloseTo(-3.5e-5, 6);
    for (const r of res.rows) {
      expect(r.rms).toBeLessThan(0.004);
      expect(r.corr).toBeGreaterThan(0.95);
      expect(r.coverage).toBeGreaterThan(0.6);
      expect(r.coverage).toBeLessThan(0.97);
    }
  });
  test('a noisy inverted impedance: the band widens by the left-out error and covers about 80 percent (it covered far less before)', () => {
    const up = upscaleWells(pr, dtMs);
    let sd = 11; const g = () => { sd = (sd * 1103515245 + 12345) % 2147483648; return sd / 2147483648 - 0.5; };
    // an inversion with about 6 percent random error at each sample
    const noisy = up.map((w) => w.ai.map((v) => v * (1 + 0.2 * g())));
    const res = calibrateProperty({ pr, aiTraces: noisy, dtMs });
    expect(res.summary.sExtra).toBeGreaterThan(res.summary.s);
    for (const r of res.rows) { expect(r.coverage).toBeGreaterThan(0.6); expect(r.coverage).toBeLessThan(0.97); }
    // negative control: the same band from the fit's scatter alone (the old rule) covers far less
    const m = fitProperty(up, pr, dtMs, up[0].name);
    const [lo, , hi] = predictTrace(m, pr, noisy[0]);
    let inside = 0; let n = 0;
    up[0].target.forEach((y, i) => { if (Number.isFinite(y) && Number.isFinite(lo[i])) { n += 1; if (y >= lo[i] && y <= hi[i]) inside += 1; } });
    expect(inside / n).toBeLessThan(0.5);
    // the volume run uses the widened model
    const [lo2, , hi2] = predictTrace(res.model, pr, [7000]);
    const [lo1, , hi1] = predictTrace({ ...res.model, sExtra: 0 }, pr, [7000]);
    expect(hi2[0] - lo2[0]).toBeGreaterThan(2 * (hi1[0] - lo1[0]));
  });
  test('a biased impedance (10 percent high) is reported as a shift at every well', () => {
    const up = upscaleWells(pr, dtMs);
    const res = calibrateProperty({ pr, aiTraces: up.map((w) => w.ai.map((v) => 1.1 * v)), dtMs });
    for (const r of res.rows) expect(Math.abs(r.bias)).toBeGreaterThan(0.7 * r.rms);
  });
  test('predictTrace gives ordered quantiles and leaves nulls', () => {
    const up = upscaleWells(pr, dtMs);
    const m = fitProperty(up, pr, dtMs);
    const [lo, mid, hi] = predictTrace(m, pr, [6000, 1e30, 8000]);
    expect(lo[0]).toBeLessThan(mid[0]); expect(mid[0]).toBeLessThan(hi[0]);
    expect(mid[1]).toBeNaN();
  });
});

describe('facies from impedance', () => {
  const pr = asJob('facies');
  test('each left-out well is classified well from its impedance', () => {
    const up = upscaleWells(pr, dtMs);
    const res = calibrateProperty({ pr, aiTraces: up.map((w) => w.ai), dtMs });
    expect(res.summary.classes.map((c) => c.name).sort()).toEqual(['brine sand', 'gas sand', 'shale']);
    for (const r of res.rows) expect(r.accuracy).toBeGreaterThan(0.8);
  });
  test('predictTrace: probabilities sum to one and the code follows the most likely', () => {
    const up = upscaleWells(pr, dtMs);
    const m = fitProperty(up, pr, dtMs);
    const out = predictTrace(m, pr, [5800, 6900, 8200]);
    const codes = out[out.length - 1];
    expect(Array.from(codes)).toEqual([1, 2, 3]);
    for (let k = 0; k < 3; k++) expect(out.slice(0, -1).reduce((a, o) => a + o[k], 0)).toBeCloseTo(1, 12);
  });
  test('negative control: shuffled labels lose the classification', () => {
    const shuffled = { ...pr, wells: pr.wells.map((w) => ({ ...w, target: w.target.map((c, k) => ((c + k) % 3) + 1) })) };
    const up = upscaleWells(shuffled, dtMs);
    const res = calibrateProperty({ pr: shuffled, aiTraces: up.map((w) => w.ai), dtMs });
    for (const r of res.rows) expect(r.accuracy).toBeLessThan(0.6);
  });
});

test('the per-sample interval equals the engine call', () => {
  const pr = asJob('porosity');
  const m = fitProperty(upscaleWells(pr, dtMs), pr, dtMs);
  const [lo, mid, hi] = predictTrace(m, pr, [5500, 7000, 9100]);
  [5500, 7000, 9100].forEach((x, k) => {
    const r = predictWithInterval(m, x, 0.8);
    expect(lo[k]).toBeCloseTo(r.lo, 12); expect(mid[k]).toBeCloseTo(r.y, 12); expect(hi[k]).toBeCloseTo(r.hi, 12);
  });
});

test('the tabulated facies posterior matches the direct one (Gaussian and KDE)', () => {
  for (const density of ['gaussian', 'kde']) {
    const pr = { ...asJob('facies'), density };
    const m = fitProperty(upscaleWells(pr, dtMs), pr, dtMs);
    const t = posteriorTable(m);
    for (const x of [5600, 6300, 6900, 7400, 8100, 9000]) {
      const d = faciesPosterior(m, [x]).probs;
      t(x).forEach((p, j) => expect(Math.abs(p - d[j])).toBeLessThan(2e-3));
    }
  }
});
