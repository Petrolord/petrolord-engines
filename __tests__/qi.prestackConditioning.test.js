// Gates for qi/prestackConditioning.js (QI round 3, 2026-10-15): parabolic
// Radon demultiple, f-x deconvolution and the survey shaping filter, each on
// synthetic gathers or stacks with known truth, each with a negative
// control. Every number comes from the shipped functions.
import {
  toeplitzSolve, hermitianSolve, blockToeplitzCg, radonQAxis, radonForward, radonInverse,
  timeWindows, radonDemultiple, fxDecon, meanAmplitudeSpectrum, shapingOperator, applyShaping,
} from '../engines/qi/prestackConditioning.js';
import { spectralBalance } from '../engines/qi/conditioning.js';

const DT = 4; const NS = 500; const XM = 3000;
const OFFS = Array.from({ length: 31 }, (_, j) => 100 * j);
const XS = OFFS.map((x) => (x / XM) ** 2);
const ricker = (t, f = 25) => { const a = (Math.PI * f * t / 1000) ** 2; return (1 - 2 * a) * Math.exp(-a); };
// primaries: [t0 ms, intercept, gradient in (x/xmax)^2]; multiples: [t0, amplitude, residual moveout at xmax ms]
const PRIM = [[500, 1, -0.6], [900, -0.5, -0.4], [1300, 0.7, 0.5]];
const MULT = [[700, 0.8, 80], [1100, -0.6, 120], [1300, 0.5, 150]];
const primaries = () => OFFS.map((x) => Float64Array.from({ length: NS }, (_, i) => PRIM.reduce((s, [t0, A, B]) => s + (A + B * (x / XM) ** 2) * ricker(i * DT - t0), 0)));
const multiples = () => OFFS.map((x) => Float64Array.from({ length: NS }, (_, i) => MULT.reduce((s, [t0, a, q]) => s + a * ricker(i * DT - t0 - q * (x / XM) ** 2), 0)));
const energy = (G, ref) => G.reduce((s, t, j) => s + t.reduce((a, v, i) => a + (v - (ref ? ref[j][i] : 0)) ** 2, 0), 0);
/** least-squares intercept and gradient of the event at t0 across the gather */
const avoAt = (G, t0) => {
  const ys = G.map((t) => t[t0 / DT]); const n = XS.length;
  const mx = XS.reduce((a, b) => a + b) / n; const my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0; let sxx = 0; XS.forEach((x, k) => { sxy += (x - mx) * (ys[k] - my); sxx += (x - mx) ** 2; });
  const B = sxy / sxx; return { A: my - B * mx, B };
};
const relErr = (G) => PRIM.map(([t0, A, B]) => { const f = avoAt(G, t0); return { t0, A: (f.A - A) / Math.abs(A), B: (f.B - B) / Math.abs(B) }; });
const lcg = (seed) => { let s = seed; const u = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; }; return () => { let g = 0; for (let k = 0; k < 12; k++) g += u(); return g; }; };

describe('linear algebra', () => {
  const n = 7;
  const tRe = new Float64Array(2 * n - 1); const tIm = new Float64Array(2 * n - 1);
  for (let l = -(n - 1); l < n; l++) { tRe[n - 1 + l] = l === 0 ? 10 : Math.cos(l) / (1 + Math.abs(l)); tIm[n - 1 + l] = l === 0 ? 0 : Math.sin(l) / (1 + Math.abs(l)); }
  const yRe = Float64Array.from({ length: n }, (_, i) => i + 1); const yIm = Float64Array.from({ length: n }, (_, i) => -i);
  const dense = () => { const aRe = new Float64Array(n * n); const aIm = new Float64Array(n * n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { aRe[i * n + j] = tRe[n - 1 + i - j]; aIm[i * n + j] = tIm[n - 1 + i - j]; } return { aRe, aIm }; };
  test('Levinson equals Cholesky on a Hermitian Toeplitz system, and both satisfy it', () => {
    const x = toeplitzSolve(tRe, tIm, yRe, yIm);
    const { aRe, aIm } = dense();
    const c = hermitianSolve(aRe, aIm, yRe, yIm, n);
    for (let i = 0; i < n; i++) { expect(x.re[i]).toBeCloseTo(c.re[i], 12); expect(x.im[i]).toBeCloseTo(c.im[i], 12); }
    for (let i = 0; i < n; i++) {
      let sr = 0; let si = 0;
      for (let j = 0; j < n; j++) { sr += aRe[i * n + j] * x.re[j] - aIm[i * n + j] * x.im[j]; si += aRe[i * n + j] * x.im[j] + aIm[i * n + j] * x.re[j]; }
      expect(sr).toBeCloseTo(yRe[i], 10); expect(si).toBeCloseTo(yIm[i], 10);
    }
  });
  test('conjugate gradients on the block Toeplitz form converge to the direct solution, warm or cold', () => {
    const dg = Float64Array.from({ length: n }, (_, i) => 0.5 + 0.1 * i);
    const { aRe, aIm } = dense(); for (let i = 0; i < n; i++) aRe[i * n + i] += dg[i];
    const c = hermitianSolve(aRe, aIm, yRe, yIm, n);
    const g = blockToeplitzCg([tRe], [tIm], 1, n, dg, yRe, yIm, 60);
    const w = blockToeplitzCg([tRe], [tIm], 1, n, dg, yRe, yIm, 60, { re: c.re.map((v) => v * 0.9), im: c.im });
    for (let i = 0; i < n; i++) { expect(g.re[i]).toBeCloseTo(c.re[i], 5); expect(w.im[i]).toBeCloseTo(c.im[i], 5); }
  });
  test('time windows sum to one at every sample', () => {
    for (const [ns, win, step] of [[500, 300, 1], [500, 300, 0.5], [500, 200, 1], [123, 40, 0.5], [500, 0, 1]]) {
      const sum = new Float64Array(ns);
      for (const { i0, w } of timeWindows(ns, DT, win, step)) w.forEach((v, i) => { sum[i0 + i] += v; });
      for (const v of sum) expect(v).toBeCloseTo(1, 12);
    }
  });
});

describe('parabolic Radon', () => {
  test('the q axis respects the alias limit', () => {
    const ax = radonQAxis({ offsets: OFFS, qMinMs: -60, qMaxMs: 300, fMaxHz: 70 });
    expect(ax.dq).toBeLessThanOrEqual(ax.dqAliasMs);
    expect(ax.dqAliasMs).toBeCloseTo(1000 / 70, 6);
  });
  test('a single event maps to its own q and the model rebuilds the gather', () => {
    for (const [B, q0] of [[0, 0], [-0.6, 0], [0, 80]]) {
      const D = OFFS.map((x) => Float64Array.from({ length: NS }, (_, i) => (1 + B * (x / XM) ** 2) * ricker(i * DT - 500 - q0 * (x / XM) ** 2)));
      const rad = radonForward({ traces: D, offsets: OFFS, dtMs: DT, qMinMs: -60, qMaxMs: 300, highRes: 2, avo: true });
      const eq = rad.model.map((m, k) => { let s = 0; for (let f = 0; f < m.re.length; f++) s += m.re[f] ** 2 + m.im[f] ** 2 + rad.modelB[k].re[f] ** 2 + rad.modelB[k].im[f] ** 2; return s; });
      const peak = rad.q[eq.indexOf(Math.max(...eq))];
      expect(Math.abs(peak - q0)).toBeLessThan(rad.q[1] - rad.q[0]);
      const back = radonInverse(rad);
      expect(energy(back, D) / energy(D)).toBeLessThan(2e-3);
    }
  });

  const D = () => { const p = primaries(); const m = multiples(); return p.map((t, j) => t.map((v, i) => v + m[j][i])); };

  test('demultiple: over 20 dB of the multiples removed, isolated primaries\' AVO within 2 percent (A) and 5 percent (B), the primary under a multiple within 6 and 14 percent', () => {
    const P0 = primaries(); const G = D();
    const r = radonDemultiple({ traces: G, offsets: OFFS, dtMs: DT, cutMs: 30 });
    const removedDb = 10 * Math.log10(energy(G, P0) / energy(r.traces, P0));
    expect(removedDb).toBeGreaterThan(20);
    for (const e of relErr(r.traces)) {
      const hard = e.t0 === 1300; // the multiple at 1300 ms starts on this primary
      expect(Math.abs(e.A)).toBeLessThan(hard ? 0.06 : 0.02); expect(Math.abs(e.B)).toBeLessThan(hard ? 0.14 : 0.05);
    }
    // the multiples biased the AVO before: the 1300 ms primary sits on one
    const before = relErr(G).find((e) => e.t0 === 1300);
    expect(Math.abs(before.B)).toBeGreaterThan(0.4);
    expect(r.windows).toBeGreaterThan(1);
  });

  test('negative control: plain least-squares Radon (no AVO terms, windows or sparsity) biases the gradients', () => {
    const r = radonDemultiple({ traces: D(), offsets: OFFS, dtMs: DT, cutMs: 30, avo: false, highRes: 0, windowMs: 0 });
    const e500 = relErr(r.traces).find((e) => e.t0 === 500);
    expect(Math.abs(e500.B)).toBeGreaterThan(0.25);
  });

  test('negative control: a cut below the primaries\' q removes them too', () => {
    const r = radonDemultiple({ traces: primaries(), offsets: OFFS, dtMs: DT, cutMs: -30 });
    for (const [t0, A] of PRIM) expect(Math.abs(avoAt(r.traces, t0).A / A)).toBeLessThan(0.2);
  });

  test('null traces stay null and a primaries-only gather passes almost unchanged', () => {
    const P0 = primaries(); const G = P0.map((t, j) => (j === 7 ? null : t));
    const r = radonDemultiple({ traces: G, offsets: OFFS, dtMs: DT, cutMs: 30 });
    expect(r.traces[7]).toBeNull();
    const kept = G.filter(Boolean); const out = r.traces.filter(Boolean);
    expect(energy(out, kept) / energy(kept)).toBeLessThan(0.01);
  });
});

describe('f-x deconvolution', () => {
  test('noise-free primaries pass within 1 percent of the intercept', () => {
    const r = fxDecon({ traces: primaries(), dtMs: DT, fHiHz: 100 });
    for (const e of relErr(r.traces)) { expect(Math.abs(e.A)).toBeLessThan(0.01); expect(Math.abs(e.B)).toBeLessThan(0.04); }
  });

  const monteCarlo = (opts, level = 0.5, runs = 10) => {
    const P0 = primaries(); const S = energy(P0); const sig = Math.sqrt(S / (OFFS.length * NS)); const g = lcg(7);
    let gain = 0; const biasA = PRIM.map(() => 0);
    for (let r = 0; r < runs; r++) {
      const N = P0.map((t) => t.map((v) => v + level * sig * g()));
      const out = fxDecon({ traces: N, dtMs: DT, fHiHz: 100, ...opts }).traces;
      gain += 10 * Math.log10(energy(N, P0) / energy(out, P0)) / runs;
      relErr(out).forEach((e, k) => { biasA[k] += e.A / runs; });
    }
    return { gain, biasA };
  };

  test('random noise: S/N up by over 4.5 dB, intercept bias within 4 percent (10 realisations)', () => {
    const { gain, biasA } = monteCarlo({});
    expect(gain).toBeGreaterThan(4.5);
    for (const b of biasA) expect(Math.abs(b)).toBeLessThan(0.04);
  });

  test('negative control: an over-damped filter visibly loses amplitude, so the gate sees amplitude loss', () => {
    const { biasA } = monteCarlo({ damping: 5 });
    expect(Math.min(...biasA)).toBeLessThan(-0.2);
  });
});

describe('survey shaping filter', () => {
  const NT = 64;
  const conv = (r, f, g) => Float64Array.from({ length: NS }, (_, i) => { let s = 0; for (let k = -40; k <= 40; k++) { const j = i - k; if (j >= 0 && j < NS) s += r[j] * ricker(k * DT, f); } return s * g; });
  const setup = () => {
    let s = 3; const u = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
    const refl = Array.from({ length: NT }, () => Float64Array.from({ length: NS }, () => (u() > 0.45 ? u() : 0)));
    refl[5] = refl[4]; // trace 5 has trace 4's geology...
    const gain = Array.from({ length: NT }, (_, k) => (k === 5 ? 2 : 1)); // ...at twice its amplitude
    const near = refl.map((r, k) => conv(r, 35, gain[k]));
    const far = refl.map((r, k) => conv(r, 20, 0.7 * gain[k]));
    const farTrue = refl.map((r, k) => conv(r, 35, 0.7 * gain[k]));
    return { near, far, farTrue };
  };
  const corr = (a, b) => { let s = 0; let x = 0; let y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return s / Math.sqrt(x * y); };
  const meanCorr = (A, B) => A.reduce((s, a, k) => s + corr(a, B[k]), 0) / A.length;
  const rms = (t) => Math.sqrt(t.reduce((a, v) => a + v * v, 0) / t.length);

  test('a 20 Hz far stack takes the 35 Hz near stack\'s bandwidth: correlation with the truth from under 0.75 to over 0.94', () => {
    const { near, far, farTrue } = setup();
    const op = shapingOperator(meanAmplitudeSpectrum(far, DT), meanAmplitudeSpectrum(near, DT).amp, { fLo: 6, fHi: 60 });
    const bal = far.map((t) => applyShaping(t, op));
    expect(meanCorr(far, farTrue)).toBeLessThan(0.75);
    expect(meanCorr(bal, farTrue)).toBeGreaterThan(0.94);
  });

  test('one operator for every trace: a trace twice as bright stays exactly twice as bright, and the band energy is kept', () => {
    const { near, far } = setup();
    const sF = meanAmplitudeSpectrum(far, DT);
    const op = shapingOperator(sF, meanAmplitudeSpectrum(near, DT).amp, { fLo: 6, fHi: 60 });
    const bal = far.map((t) => applyShaping(t, op));
    expect(rms(bal[5]) / rms(bal[4])).toBeCloseTo(2, 9);
    const sB = meanAmplitudeSpectrum(bal, DT);
    let e0 = 0; let e1 = 0; for (let k = 0; k < sF.amp.length; k++) { const f = k * sF.df; if (f >= 6 && f <= 60) { e0 += sF.amp[k] ** 2; e1 += sB.amp[k] ** 2; } }
    expect(e1 / e0).toBeGreaterThan(0.8); expect(e1 / e0).toBeLessThan(1.25);
  });

  test('negative control: per-trace balancing (qi/conditioning spectralBalance) equalises the bright trace', () => {
    const { near, far } = setup();
    const sN = meanAmplitudeSpectrum(near, DT);
    const target = (f) => sN.amp[Math.min(sN.amp.length - 1, Math.round(f / sN.df))];
    const pt = far.map((t) => spectralBalance(t, target, DT, { fLo: 6, fHi: 60 }));
    expect(rms(pt[5]) / rms(pt[4])).toBeLessThan(1.2);
  });

  test('a flat target whitens inside the band; nulls stay null', () => {
    const { far } = setup();
    const op = shapingOperator(meanAmplitudeSpectrum(far, DT), null, { fLo: 10, fHi: 50 });
    const bal = far.map((t) => applyShaping(t, op));
    const sB = meanAmplitudeSpectrum(bal, DT); const sF = meanAmplitudeSpectrum(far, DT);
    const flat = (s) => { const v = []; for (let k = 0; k < s.amp.length; k++) { const f = k * s.df; if (f >= 15 && f <= 45) v.push(s.amp[k]); } return Math.max(...v) / Math.min(...v); };
    expect(flat(sB)).toBeLessThan(flat(sF) / 3);
    const withNull = Float64Array.from(far[0]); withNull[10] = 1e30;
    expect(applyShaping(withNull, op)[10]).toBe(1e30);
  });
});
