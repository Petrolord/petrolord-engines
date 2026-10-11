// Moved with engines/qi/propertyCalibration.js from the Suite (QI course gate E2); the job-param checks stay in the Suite.
import { calibrateProperty, upscaleWells, fitProperty, predictTrace, posteriorTable2D } from '../engines/qi/propertyCalibration';
import { faciesPosterior } from '../engines/qi/propertyPrediction';

// Gas sand and shale overlap in AI (6800) but not in Vp/Vs; brine sand sits apart in AI (7600).
const dtMs = 4; const ns = 400;
let seed = 7; const u = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
function well(name, il, shift) {
  const fac = Array.from({ length: ns }, (_, k) => [1, 2, 3][Math.floor((k + shift) / 40) % 3]);
  const ai = fac.map((f) => (f === 2 ? 7600 : 6800) + 120 * u());
  const vpvs = fac.map((f) => (f === 1 ? 1.62 : f === 2 ? 1.92 : 2.2) + 0.03 * u());
  return { name, il, xl: 0, ln_ai: ai.map(Math.log), vpvs, target: fac };
}
const W = [well('A', 0, 0), well('B', 1, 13), well('C', 2, 27)];
const NAMES = { 1: 'gas sand', 2: 'brine sand', 3: 'shale' };
const job = (attributes) => ({ kind: 'facies', names: NAMES, density: 'gaussian', priors: 'wells', upscaleHz: 50, attributes, wells: W.map((w) => ({ ...w })) });

test('AI and Vp/Vs classify each left-out well; the 2D table matches the direct posterior', () => {
  const pr = job('ai_vpvs');
  const up = upscaleWells(pr, dtMs);
  const res = calibrateProperty({ pr, aiTraces: up.map((w) => w.ai), vpvsTraces: up.map((w) => w.vpvs), dtMs });
  for (const r of res.rows) expect(r.accuracy).toBeGreaterThan(0.85);
  expect(res.summary.attributes).toBe('ai_vpvs');
  const m = fitProperty(up, pr, dtMs);
  const t = posteriorTable2D(m);
  for (const [a, v] of [[6800, 1.62], [6800, 2.2], [7600, 1.92], [7200, 1.9]]) {
    const d = faciesPosterior(m, [a, v]).probs;
    t(a, v).forEach((p, j) => expect(Math.abs(p - d[j])).toBeLessThan(0.02));
  }
  const out = predictTrace(m, pr, [6800, 6800, 7600], [1.62, 2.2, 1.92]);
  expect(Array.from(out[out.length - 1])).toEqual([1, 3, 2]);
});

test('negative control: with AI alone the gas sand and the shale cannot be told apart', () => {
  const pr = job('ai');
  const up = upscaleWells(pr, dtMs);
  const res = calibrateProperty({ pr, aiTraces: up.map((w) => w.ai), dtMs });
  for (const r of res.rows) expect(r.accuracy).toBeLessThan(0.75);
});
