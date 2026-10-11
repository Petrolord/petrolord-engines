// Moved with engines/qi/angleWavelets.js from the Suite (QI course gate E2).
import { angleReflectivity, extractAngleWavelets } from '../engines/qi/angleWavelets';
import { forwardFatti } from '../engines/qi/prestackInversion';

// Stacks made with a different wavelet per angle (lower frequency at far angles, as absorption and NMO stretch give).
const ns = 300; const dtMs = 4;
const ricker = (f) => Array.from({ length: 31 }, (_, i) => { const t = ((i - 15) * dtMs) / 1000; const a = (Math.PI * f * t) ** 2; return (1 - 2 * a) * Math.exp(-a); });
const THETA = [5, 20, 35]; const FREQ = [30, 25, 18];
let seed = 3; const u = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const well = (name) => {
  const w = { name, ln_ai: [], ln_si: [], ln_rho: [] };
  let a = 8.8; let s = 8.1; let r = 0.85;
  for (let i = 0; i < ns; i++) { if (i % 9 === 0) { a += 0.06 * u(); s += 0.07 * u(); r += 0.02 * u(); } w.ln_ai.push(a); w.ln_si.push(s); w.ln_rho.push(r); }
  return w;
};
const W = [well('A'), well('B')];
const stacks = (w) => THETA.map((t, k) => forwardFatti({ lnAi: w.ln_ai, lnSi: w.ln_si, lnRho: w.ln_rho }, [t], [ricker(FREQ[k])], 0.5)[0].map((v) => 1.7 * v));

test('reflectivity: the Fatti operator with a unit spike, NaN where a log is missing', () => {
  const w = { ...W[0], ln_si: W[0].ln_si.map((v, i) => (i === 50 ? NaN : v)) };
  const r = angleReflectivity(w, 20, 0.5);
  expect(r[49]).toBeNaN(); expect(r[51]).toBeNaN();
  expect(Number.isFinite(r[100])).toBe(true);
});

test('each stack gets its own wavelet back (frequency falls with angle), and the synthetics match the stacks', () => {
  const out = extractAngleWavelets({ wells: W, tracesByWell: W.map(stacks), thetaDeg: THETA, vsVp: 0.5 });
  out.forEach((o, k) => {
    const truth = ricker(FREQ[k]).map((v) => 1.7 * v);
    let c = 0; let ss = 0; let tt = 0;
    for (let i = 0; i < 31; i++) { c += o.samples[i] * truth[i]; ss += o.samples[i] ** 2; tt += truth[i] ** 2; }
    expect(c / Math.sqrt(ss * tt)).toBeGreaterThan(0.98);
    for (const w of o.wells) expect(w.synthCorr).toBeGreaterThan(0.97);
  });
  // negative control: the near wavelet used at the far angle fits the far stack worse
  const near = out[0].samples; const far = out[2].samples;
  let c = 0; let ss = 0; let tt = 0;
  for (let i = 0; i < 31; i++) { c += near[i] * far[i]; ss += near[i] ** 2; tt += far[i] ** 2; }
  expect(c / Math.sqrt(ss * tt)).toBeLessThan(0.95);
});
