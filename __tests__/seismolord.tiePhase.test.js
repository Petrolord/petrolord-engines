// Gates for seismolord/tiePhase.js (QI round 3): a seismic made from the
// synthetic with a known phase that drifts linearly with time is measured
// window by window, the trend recovers the drift, and the time-variant
// rotation raises the correlation above the best constant phase. Negative
// controls: a constant-phase seismic shows no drift and nothing is offered;
// noise alone offers nothing.
import { phaseProfile, phaseTrend, rotateTimeVariant, timeVariantPhaseCheck, trendPhaseAt, wrapDeg } from '../engines/seismolord/tiePhase.js';
import { rotateConstantPhase } from '../engines/seismolord/tieWarp.js';

const DT = 2; const NS = 1000;
let seed = 4; const u = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const ricker = (t) => { const a = (Math.PI * 30 * t / 1000) ** 2; return (1 - 2 * a) * Math.exp(-a); };
const refl = Float64Array.from({ length: NS }, () => (u() > 0.2 ? u() : 0));
const synth = Float64Array.from({ length: NS }, (_, i) => { let s = 0; for (let k = -30; k <= 30; k++) { const j = i - k; if (j >= 0 && j < NS) s += refl[j] * ricker(k * DT); } return s; });
const gauss = () => { let s = 0; for (let k = 0; k < 12; k++) s += u(); return s; };
const rms = Math.sqrt(synth.reduce((a, v) => a + v * v, 0) / NS);
// the truth: 10 degrees at the top, 70 at the base (60 degrees of drift over 2 s)
const truthAt = (t) => 10 + 60 * (t / ((NS - 1) * DT));

test('wrap', () => { expect(wrapDeg(190)).toBe(-170); expect(wrapDeg(-180)).toBe(180); expect(wrapDeg(30)).toBe(30); });

test('a rotation by one constant phase is the tieWarp convention', () => {
  const a = rotateTimeVariant(synth, DT, () => 40);
  const b = rotateConstantPhase(synth, (40 * Math.PI) / 180);
  for (let i = 100; i < 900; i += 37) expect(a[i]).toBeCloseTo(b[i], 4);
});

test('a linear phase drift is measured window by window and recovered by the trend', () => {
  const seis = rotateTimeVariant(synth, DT, truthAt);
  const prof = phaseProfile(synth, seis, DT);
  for (const r of prof.filter((x) => x.twtMs > 200 && x.twtMs < 1800)) expect(Math.abs(wrapDeg(r.phiDeg - truthAt(r.twtMs)))).toBeLessThan(6);
  const tr = phaseTrend(prof);
  expect(tr.driftDeg).toBeGreaterThan(50); expect(tr.driftDeg).toBeLessThan(70);
  expect(Math.abs(trendPhaseAt(tr, 1000) - truthAt(1000))).toBeLessThan(5);
});

test('with noise the time-variant phase raises the correlation above the best constant phase and is offered', () => {
  const seis = Float64Array.from(rotateTimeVariant(synth, DT, truthAt), (v) => v + 0.3 * rms * gauss());
  const c = timeVariantPhaseCheck(synth, seis, DT);
  expect(c.offer).toBe(true);
  // the best constant phase is at most 30 degrees off at the ends, so a 60 degree drift gains a few hundredths
  expect(c.gain).toBeGreaterThan(0.03);
  expect(c.corrTimeVariant).toBeGreaterThan(0.85);
  expect(Math.abs(c.trend.driftDeg - 60)).toBeLessThan(15);
  // a 120 degree drift gains far more
  const big = Float64Array.from(rotateTimeVariant(synth, DT, (t) => -50 + 120 * (t / ((NS - 1) * DT))), (v) => v + 0.3 * rms * gauss());
  const c2 = timeVariantPhaseCheck(synth, big, DT);
  expect(c2.gain).toBeGreaterThan(0.12);
  expect(Math.abs(c2.trend.driftDeg - 120)).toBeLessThan(20);
});

test('negative control: a constant 40 degree phase shows no drift and nothing is offered', () => {
  const seis = Float64Array.from(rotateTimeVariant(synth, DT, () => 40), (v) => v + 0.3 * rms * gauss());
  const c = timeVariantPhaseCheck(synth, seis, DT);
  expect(Math.abs(c.trend.driftDeg)).toBeLessThan(15);
  expect(Math.abs(c.constantDeg - 40)).toBeLessThan(6);
  expect(c.offer).toBe(false);
});

test('negative control: noise alone offers nothing', () => {
  const seis = Float64Array.from({ length: NS }, () => gauss());
  expect(timeVariantPhaseCheck(synth, seis, DT).offer).toBe(false);
});

test('gaps never enter a sum and stay gaps', () => {
  const s2 = Float64Array.from(synth); for (let i = 0; i < 100; i++) s2[i] = NaN;
  const seis = rotateTimeVariant(synth, DT, truthAt);
  const prof = phaseProfile(s2, seis, DT);
  expect(prof.every((r) => r.twtMs > 0 || r.overlap >= 20)).toBe(true);
  const rot = rotateTimeVariant(s2, DT, () => 10);
  expect(rot[50]).toBeGreaterThan(1e29);
});
