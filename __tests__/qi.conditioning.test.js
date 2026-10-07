import { shiftTrace, trimStatics, quadrature, rotatePhase, matchStacks, spectralBalance } from '../engines/qi/conditioning';

const dtMs = 2; const ns = 400;
const ricker = (f) => (t) => { const a = (Math.PI * f * t / 1000) ** 2; return (1 - 2 * a) * Math.exp(-a); };
const event = (t0, f = 30) => Float64Array.from({ length: ns }, (_, i) => ricker(f)(i * dtMs - t0) - 0.6 * ricker(f)(i * dtMs - t0 - 60));
const corr = (a, b) => { let s = 0; let ea = 0; let eb = 0; for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { s += a[i] * b[i]; ea += a[i] ** 2; eb += b[i] ** 2; } return s / Math.sqrt(ea * eb); };

test('shift and phase primitives', () => {
  const e = event(300);
  const s = shiftTrace(e, 10, dtMs);
  expect(corr(s, event(310))).toBeGreaterThan(0.999);
  // the quadrature of a cosine is a sine
  const cosT = Float64Array.from({ length: 512 }, (_, i) => Math.cos((2 * Math.PI * 16 * i) / 512));
  const q = quadrature(cosT);
  for (const i of [100, 200, 300]) expect(q[i]).toBeCloseTo(Math.sin((2 * Math.PI * 16 * i) / 512), 2);
  // rotating by 90 then -90 returns the trace
  const back = rotatePhase(rotatePhase(e, 90), -90);
  expect(corr(back, e)).toBeGreaterThan(0.995);
});

test('trim statics flatten a gather with random static shifts', () => {
  let seed = 5; const u = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const shifts = Array.from({ length: 20 }, () => 14 * u());
  const gather = shifts.map((sh) => event(400 + sh));
  const r = trimStatics({ traces: gather, dtMs, centreMs: 430, windowMs: 80, maxShiftMs: 10 });
  expect(r.corrAfter).toBeGreaterThan(0.98);
  expect(r.corrAfter).toBeGreaterThan(r.corrBefore + 0.05);
  // relative shifts recovered: each trace's shift is minus its static, up to one common offset
  const mean = r.shiftsMs.reduce((a, v, k) => a + v + shifts[k], 0) / shifts.length;
  r.shiftsMs.forEach((v, k) => expect(Math.abs(v + shifts[k] - mean)).toBeLessThan(0.6));
});

test('negative control: shifts are capped, so a gather that is not flat because of an event change is left alone', () => {
  // a different event at a far offset (a 40 ms change) is beyond the 10 ms cap
  const gather = [event(400), event(400), event(400), event(440)];
  const r = trimStatics({ traces: gather, dtMs, centreMs: 420, windowMs: 80, maxShiftMs: 10 });
  r.shiftsMs.forEach((v) => expect(Math.abs(v)).toBeLessThanOrEqual(10));
});

test('stack matching recovers a known shift, phase and scale', () => {
  const ref = event(400);
  const target = rotatePhase(shiftTrace(ref, 6, dtMs).map((v) => (Number.isFinite(v) ? v : 0)), 35).map((v) => 0.5 * v);
  const m = matchStacks(ref, target, dtMs);
  expect(m.shiftMs).toBeCloseTo(-6, 0);
  expect(m.phaseDeg).toBeCloseTo(-35, -1);
  expect(Math.abs(m.phaseDeg + 35)).toBeLessThan(3);
  expect(m.scale).toBeCloseTo(2, 1);
  expect(m.corrAfter).toBeGreaterThan(0.99);
  expect(m.corrAfter).toBeGreaterThan(m.corrBefore + 0.2);
});

test('spectral balancing takes a 20 Hz trace to a 35 Hz target in band (negative control: the unbalanced trace fits worse)', () => {
  const low = event(400, 20);
  const target = event(400, 35);
  const N = 1024; const df = 1000 / (N * dtMs);
  const re = new Float64Array(N); const im = new Float64Array(N); target.forEach((v, i) => { re[i] = v; });
  // the target's amplitude as a function, from its own spectrum
  const { fft } = require('../lib/fft');
  fft(re, im, false);
  const tAmp = (f) => { const k = Math.round(f / df); return k >= 0 && k <= N / 2 ? Math.hypot(re[k], im[k]) : 0; };
  const out = spectralBalance(low, tAmp, dtMs, { fLo: 5, fHi: 90 });
  expect(corr(out, target)).toBeGreaterThan(corr(low, target));
  expect(corr(out, target)).toBeGreaterThan(0.95);
});
