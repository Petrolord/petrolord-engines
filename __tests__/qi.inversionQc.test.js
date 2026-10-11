// engines/qi/inversionQc.js, moved from the Suite's QIStudio/services/inversionRun.js (QI course gate E2).
// The same survey as the Suite's inversionRun gate: two horizons dipping across the inlines, three layers
// with a thin-bed texture, and a seismic amplitude scale the wavelet has to recover. The trace inverter
// here is the engines' own LFM and model-based inversion, which QI Studio's makeTraceInverter wraps.
import { waveletScale, blindWellTable, halfWindowFor, lowPassFinite, BLIND_LOW_CUT_HZ } from '../engines/qi/inversionQc';
import { forwardPoststack, modelBased } from '../engines/qi/inversion';
import { lfmTrace } from '../engines/qi/lfm';

const ns = 220; const dtMs = 4; const SCALE = 3.5; const NULL = 1e30;
const ricker = Array.from({ length: 41 }, (_, i) => { const t = ((i - 20) * dtMs) / 1000; const a = (Math.PI * 25 * t) ** 2; return (1 - 2 * a) * Math.exp(-a); });
const topAt = (il) => 300 + 20 * il;
const baseAt = (il) => 520 + 35 * il;
const texture = (p) => 0.03 * Math.sin(2 * Math.PI * 5 * p);
function truthTrace(il) {
  const top = topAt(il); const base = baseAt(il);
  return Float64Array.from({ length: ns }, (_, k) => {
    const t = k * dtMs;
    if (t < top) return 8.4 + texture((t - top) / 200);
    if (t < base) return 8.75 + texture((t - top) / (base - top));
    return 8.6 + texture((t - base) / 200);
  });
}
const seismic = (il) => Float32Array.from(forwardPoststack(truthTrace(il), ricker).map((v) => SCALE * v));
const wellAt = (name, il, xl) => ({ name, il, xl, ln_ai: Array.from(truthTrace(il), (v, k) => (k * dtMs >= 160 && k * dtMs <= 800 ? v : NaN)) });
const WELLS = [wellAt('A', 0, 0), wellAt('B', 3, 4), wellAt('C', 6, 1), wellAt('D', 6, 4)];

function inverter({ horizons = true } = {}) {
  const half = halfWindowFor(8, dtMs);
  const lfm = WELLS.map((w) => ({ name: w.name, x: w.il * 25, y: w.xl * 25, t0Ms: 0, dtMs, values: lowPassFinite(w.ln_ai, half), horizons: horizons ? [topAt(w.il), baseAt(w.il)] : undefined }));
  const wavelet = ricker.map((v) => v * SCALE);
  return (trace, il, xl, exclude) => {
    const d = Float64Array.from(trace, (v) => (Math.abs(v) < 1e29 ? v : 0));
    const m0 = lfmTrace(lfm, { x: il * 25, y: xl * 25, horizons: horizons ? [topAt(il), baseAt(il)] : undefined }, { t0Ms: 0, dtMs, ns }, { power: 2, exclude });
    return modelBased({ d, wavelet, m0, eps: 0.05, iters: 60 }).m;
  };
}

describe('wavelet scale at the wells', () => {
  test('recovers the seismic amplitude scale', () => {
    const { scale, samples } = waveletScale(WELLS.map((w) => ({ trace: seismic(w.il), lnAi: w.ln_ai })), ricker);
    expect(scale).toBeCloseTo(SCALE, 6);
    expect(samples).toBeGreaterThan(400);
  });
  test('a log gap is held at its edge value and the samples near it are skipped', () => {
    const w = { ...WELLS[1], ln_ai: WELLS[1].ln_ai.map((v, k) => (k >= 100 && k < 104 ? NaN : v)) };
    const full = waveletScale([{ trace: seismic(w.il), lnAi: WELLS[1].ln_ai }], ricker).samples;
    const gap = waveletScale([{ trace: seismic(w.il), lnAi: w.ln_ai }], ricker);
    expect(full - gap.samples).toBe(4 + 2 * 21);
    expect(gap.scale).toBeCloseTo(SCALE, 6);
  });
  test('refuses when the wells overlap no seismic', () => {
    expect(() => waveletScale([{ trace: new Float32Array(ns).fill(NULL), lnAi: WELLS[0].ln_ai }], ricker)).toThrow(/too little seismic/);
  });
});

describe('the high cut', () => {
  test('halfWindowFor and a low pass that leaves the gaps alone', () => {
    expect(halfWindowFor(8, 4)).toBe(16);
    expect(halfWindowFor(500, 4)).toBe(1);
    const lp = lowPassFinite([1, 2, NaN, 4, 5], 1);
    expect(lp[2]).toBeNaN();
    expect(Number.isFinite(lp[0]) && Number.isFinite(lp[4])).toBe(true);
    expect(BLIND_LOW_CUT_HZ).toBe(8);
  });
});

describe('blind wells', () => {
  test('model-based: each well left out of the model is still matched', () => {
    const rows = blindWellTable({ invert: inverter(), wells: WELLS, traces: WELLS.map((w) => seismic(w.il)), dtMs, truthHz: 50, absolute: true });
    for (const r of rows) {
      expect(r.blind.corr).toBeGreaterThan(0.95);
      expect(r.blind.rmsPct).toBeLessThan(3);
      expect(r.withWell.rmsPct).toBeLessThan(3);
    }
  });
  test('negative control: without horizons the dipping layers are misplaced and the blind error grows', () => {
    const run = (horizons) => Math.max(...blindWellTable({ invert: inverter({ horizons }), wells: WELLS, traces: WELLS.map((w) => seismic(w.il)), dtMs, truthHz: 50, absolute: true }).map((r) => r.blind.rmsPct));
    expect(run(false)).toBeGreaterThan(2 * run(true));
  });
  test('relative impedance: only the correlation counts, against the log band-passed above the low cut', () => {
    const exact = (trace, il) => { const t = truthTrace(il); const lo = lowPassFinite(Array.from(t), halfWindowFor(BLIND_LOW_CUT_HZ, dtMs)); return t.map((v, i) => 2.5 * (v - lo[i])); };
    const rows = blindWellTable({ invert: exact, wells: WELLS, traces: WELLS.map((w) => seismic(w.il)), dtMs, truthHz: 50, absolute: false });
    for (const r of rows) { expect(r.blind.rmsPct).toBeNull(); expect(r.blind.corr).toBeGreaterThan(0.85); }
    // negative control: the polarity reversed reads as an anticorrelation, and the scale does not matter
    const flipped = blindWellTable({ invert: (t, il) => exact(t, il).map((v) => -7 * v), wells: WELLS, traces: WELLS.map((w) => seismic(w.il)), dtMs, truthHz: 50, absolute: false });
    flipped.forEach((r, k) => expect(r.blind.corr).toBeCloseTo(-rows[k].blind.corr, 12));
  });
});
