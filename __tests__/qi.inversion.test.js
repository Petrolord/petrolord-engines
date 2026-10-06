/**
 * Post-stack inversion gates (QI programme Q8a, Milestone B). The forward
 * operator matches pylops' PoststackLinearModelling (explicit, centered), so
 * pylops' solvers are the oracle (tools/validation/qi/oracle_inversion.py,
 * goldens.inversion.json: forward data, the regularised least-squares
 * solution, FISTA reflectivity). Known-truth recovery on the blocky model,
 * and negative controls.
 */
import fs from 'fs';
import path from 'path';
import {
  forwardPoststack, diffCentred, diffCentredAdjoint, convolveCentred, convolveCentredAdjoint,
  modelBased, fistaReflectivity, sparseSpike, lowFrequencyModel,
} from '../engines/qi/inversion';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/qi/goldens.inversion.json'), 'utf8'));
const maxAbs = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const corr = (a, b) => {
  const n = a.length; const ma = a.reduce((s, v) => s + v, 0) / n; const mb = b.reduce((s, v) => s + v, 0) / n;
  let s = 0; let x = 0; let y = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); x += (a[i] - ma) ** 2; y += (b[i] - mb) ** 2; }
  return s / Math.sqrt(x * y);
};

describe('operators', () => {
  test('the forward model equals pylops PoststackLinearModelling', () => {
    expect(maxAbs(forwardPoststack(G.m, G.wavelet), G.d)).toBeLessThan(1e-12);
  });
  test('the adjoints pass the dot-product test', () => {
    const n = 60; const x = Array.from({ length: n }, (_, i) => Math.sin(i * 1.3)); const y = Array.from({ length: n }, (_, i) => Math.cos(i * 0.7));
    const dp = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
    expect(Math.abs(dp(diffCentred(x), y) - dp(x, diffCentredAdjoint(y)))).toBeLessThan(1e-12);
    expect(Math.abs(dp(convolveCentred(x, G.wavelet), y) - dp(x, convolveCentredAdjoint(y, G.wavelet)))).toBeLessThan(1e-12);
  });
});

describe('model-based inversion', () => {
  test('equals the pylops regularised least-squares solution', () => {
    const r = modelBased({ d: G.d, wavelet: G.wavelet, m0: G.m0, eps: G.eps, iters: 2000 });
    expect(maxAbs(r.m, G.mInv)).toBeLessThan(1e-6);
  });
  test('recovers the blocky impedance from noise-free data, better than the low-frequency model alone', () => {
    const r = modelBased({ d: G.d, wavelet: G.wavelet, m0: G.m0, eps: G.eps, iters: 2000 });
    expect(corr(r.m, G.m)).toBeGreaterThan(0.97);
    expect(corr(r.m, G.m)).toBeGreaterThan(corr(G.m0, G.m));
    expect(r.residualRms).toBeLessThan(1e-3);
  });
  test('negative control: with no low-frequency model the trend is lost', () => {
    // the seismic band holds no trend: a flat prior recovers the layers' contrasts but not the
    // increase of impedance with depth, so the low-passed result misses the true trend
    const flat = new Array(G.nt).fill(G.m0.reduce((s, v) => s + v, 0) / G.nt);
    const r = modelBased({ d: G.d, wavelet: G.wavelet, m0: flat, eps: G.eps, iters: 2000 });
    const good = modelBased({ d: G.d, wavelet: G.wavelet, m0: G.m0, eps: G.eps, iters: 2000 });
    const trend = lowFrequencyModel(G.m, 30);
    const trendErr = (m) => maxAbs(lowFrequencyModel(m, 30), trend);
    expect(trendErr(r.m)).toBeGreaterThan(5 * trendErr(good.m));
  });
  test('the blocky option sharpens the layer edges', () => {
    const smooth = modelBased({ d: G.d, wavelet: G.wavelet, m0: G.m0, eps: G.eps, iters: 800 });
    const blocky = modelBased({ d: G.d, wavelet: G.wavelet, m0: G.m0, eps: G.eps, iters: 800, blocky: { epsTV: 0.02, beta: 1e-3, outer: 5 } });
    const err = (m) => m.reduce((s, v, i) => s + Math.abs(v - G.m[i]), 0);
    expect(err(blocky.m)).toBeLessThan(err(smooth.m));
  });
});

describe('sparse-spike', () => {
  test('FISTA equals pylops FISTA on the same problem', () => {
    // pylops thresholds at eps * alpha / 2, so it minimises 1/2 ||Cx - d||^2 + (eps / 2) ||x||_1: our lambda is eps / 2
    const r = fistaReflectivity({ d: G.dR, wavelet: G.wavelet, lambda: G.lam / 2, iters: 400, step: 1 / G.L });
    expect(maxAbs(r.r, G.rFista)).toBeLessThan(1e-9);
  });
  test('finds the three spikes of a sparse reflectivity', () => {
    const r = fistaReflectivity({ d: G.dR, wavelet: G.wavelet, lambda: G.lam, iters: 400 });
    const top = Array.from(r.r.keys()).sort((a, b) => Math.abs(r.r[b]) - Math.abs(r.r[a])).slice(0, 3).sort((a, b) => a - b);
    expect(top).toEqual([50, 110, 170]);
  });
  test('sparse-spike impedance tracks the blocky model; a huge lambda flattens it (negative control)', () => {
    const ss = sparseSpike({ d: G.d, wavelet: G.wavelet, m0: G.m0, lambda: 1e-4, dtMs: G.dtMs, iters: 600 });
    expect(corr(ss.m, G.m)).toBeGreaterThan(0.9);
    const flat = sparseSpike({ d: G.d, wavelet: G.wavelet, m0: G.m0, lambda: 10, dtMs: G.dtMs, iters: 100 });
    expect(maxAbs(flat.r, new Array(G.nt).fill(0))).toBe(0);
  });
});

describe('low-frequency model and guards', () => {
  test('the moving-average LFM equals the oracle m0', () => {
    expect(maxAbs(lowFrequencyModel(G.m, 15), G.m0)).toBeLessThan(1e-12);
  });
  test('refusals', () => {
    expect(() => modelBased({ d: [1, 2], wavelet: G.wavelet, m0: [1, 2], eps: 0.1 })).toThrow(/at least 4/);
    expect(() => modelBased({ d: G.d, wavelet: [1, 2], m0: G.m0, eps: 0.1 })).toThrow(/odd number/);
    expect(() => modelBased({ d: G.d, wavelet: G.wavelet, m0: [1], eps: 0.1 })).toThrow(/one value per/);
    expect(() => modelBased({ d: [1, NaN, 2, 3], wavelet: [1], m0: [1, 1, 1, 1], eps: 0.1 })).toThrow(/null samples/);
  });
});

describe('coloured inversion', () => {
  const { impedanceSpectrumSlope, colouredOperator, applyColoured } = require('../engines/qi/inversion');
  // a layered impedance with a red (falling) spectrum: a random walk in ln(AI)
  let s = 11; const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  const n = 512; const dtMs = 2;
  const lnAi = [8.6]; for (let i = 1; i < n; i++) lnAi.push(lnAi[i - 1] + 0.02 * u());
  const ai = lnAi.map(Math.exp);
  const w = Array.from({ length: 61 }, (_, i) => { const t = ((i - 30) * dtMs) / 1000; const a = (Math.PI * 30 * t) ** 2; return (1 - 2 * a) * Math.exp(-a); });
  const d = forwardPoststack(lnAi, w);
  // the Ricker amplitude spectrum stands in for the measured seismic spectrum
  const rickerAmp = (f) => (f * f / 900) * Math.exp(-(f * f) / 900);
  const band = [8, 70];
  const detrended = (() => {
    const a = lnAi[0]; const b = (lnAi[n - 1] - lnAi[0]) / (n - 1);
    return lnAi.map((v, i) => v - a - b * i);
  })();
  test('the impedance slope of a random-walk log is close to -1', () => {
    expect(impedanceSpectrumSlope(ai, dtMs)).toBeLessThan(-0.6);
    expect(impedanceSpectrumSlope(ai, dtMs)).toBeGreaterThan(-1.4);
  });
  test('the output tracks the band-limited true relative impedance', () => {
    const alpha = impedanceSpectrumSlope(ai, dtMs);
    const op = colouredOperator({ seismicAmp: rickerAmp, alpha, n, dtMs, band });
    const ci = applyColoured(d, op);
    // the truth in the same band: ln(AI) band-passed with a zero-phase filter (two -90 degree passes undone)
    const flat = colouredOperator({ seismicAmp: () => 1, alpha: 0, n, dtMs, band });
    const once = applyColoured(detrended, flat);
    const truth = applyColoured(once, flat).map((v) => -v); // -i * -i = -1, so negate for zero phase
    expect(corr(Array.from(ci).slice(40, n - 40), Array.from(truth).slice(40, n - 40))).toBeGreaterThan(0.85);
  });
  test('negative control: without the -90 degree rotation the output does not track impedance', () => {
    const alpha = impedanceSpectrumSlope(ai, dtMs);
    const op = colouredOperator({ seismicAmp: rickerAmp, alpha, n, dtMs, band });
    const ci = applyColoured(d, op);
    const flat = colouredOperator({ seismicAmp: () => 1, alpha: 0, n, dtMs, band });
    const truth = applyColoured(applyColoured(detrended, flat), flat).map((v) => -v);
    // undo the rotation: rotating the output by -90 degrees again leaves a quadrature trace
    const noRotation = applyColoured(ci, flat).map((v) => -v);
    const good = Math.abs(corr(Array.from(ci).slice(40, n - 40), Array.from(truth).slice(40, n - 40)));
    const bad = Math.abs(corr(Array.from(noRotation).slice(40, n - 40), Array.from(truth).slice(40, n - 40)));
    expect(bad).toBeLessThan(good - 0.3);
  });
});
