/**
 * Automatic tie-anchor suggestion: known-truth oracles.
 *  - A synthetic warped by a KNOWN smooth stretch and squeeze (12 +- 16 ms,
 *    strain under 0.1) and rotated by a KNOWN 30 degrees: the suggested
 *    anchors recover the shift within one sample at every anchor, the phase
 *    within 5 degrees, and the warped synthetic correlates above 0.95.
 *  - A pure bulk shift gives a constant shift (no invented stretch).
 *  - Negative controls: unrelated noise gives no anchors (ok false); and
 *    the bulk shift and phase alone (the autoTie tie) leave the stretched
 *    trace far below the warped correlation.
 */
import { suggestTieAnchors, traceCorrelation, AUTO_ANCHOR_DEFAULTS } from '../engines/seismolord/autoAnchors';
import { makeTieWarp, warpTrace, rotateConstantPhase } from '../engines/seismolord/tieWarp';

const DT = 4; const NS = 640;
function rng(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; }; }
function ricker(fHz, dtMs) {
  const half = Math.round(60 / dtMs); const w = [];
  for (let i = -half; i <= half; i++) { const a = (Math.PI * fHz * i * dtMs / 1000) ** 2; w.push((1 - 2 * a) * Math.exp(-a)); }
  return w;
}
function synthetic(seed) {
  const r = rng(seed); const refl = new Float64Array(NS);
  for (let i = 0; i < NS; i++) refl[i] = r() < 0.25 ? (r() - 0.5) * 0.2 : 0;
  const w = ricker(30, DT); const h = (w.length - 1) / 2; const out = new Float32Array(NS);
  for (let i = 0; i < NS; i++) { let s = 0; for (let k = 0; k < w.length; k++) { const j = i - k + h; if (j >= 0 && j < NS) s += refl[j] * w[k]; } out[i] = s; }
  return out;
}
const shiftOf = (t) => 12 + 16 * Math.sin((2 * Math.PI * t) / 1200);
const trueWarp = makeTieWarp(Array.from({ length: 65 }, (_, i) => { const t = i * 40; return { synTwtMs: t, seisTwtMs: t + shiftOf(t) }; }));

test('a known stretch and squeeze with a 30 degree phase is recovered within a sample', () => {
  const syn = synthetic(7);
  const seis = rotateConstantPhase(warpTrace(syn, DT, trueWarp, NS), (30 * Math.PI) / 180);
  const s = suggestTieAnchors(syn, seis, DT);
  expect(s.ok).toBe(true);
  expect(s.anchors.length).toBeGreaterThan(10);
  for (const a of s.anchors) expect(Math.abs(a.seisTwtMs - a.synTwtMs - shiftOf(a.synTwtMs))).toBeLessThanOrEqual(DT);
  expect(Math.abs(s.phiDeg - 30)).toBeLessThan(5);
  expect(s.corrAfter).toBeGreaterThan(0.95);
  // anchors are a valid (monotone) warp
  expect(() => makeTieWarp(s.anchors)).not.toThrow();
  // negative control: the bulk shift and phase alone (what autoTie commits) cannot match the stretch
  const bulkOnly = makeTieWarp([{ synTwtMs: 0, seisTwtMs: s.bulkShiftMs }]);
  const flat = traceCorrelation(warpTrace(rotateConstantPhase(syn, (s.phiDeg * Math.PI) / 180), DT, bulkOnly, NS), seis);
  expect(flat).toBeLessThan(s.corrAfter - 0.3);
});

test('with noise at a quarter of the signal, over eight reflectivity series, still within a sample', () => {
  for (const seed of [7, 5, 13, 21, 33, 42, 57, 64]) {
    const syn = synthetic(seed);
    const clean = rotateConstantPhase(warpTrace(syn, DT, trueWarp, NS), (30 * Math.PI) / 180);
    let rms = 0; let n = 0; for (const v of clean) if (Math.abs(v) < 1e29) { rms += v * v; n += 1; }
    rms = Math.sqrt(rms / n);
    const r = rng(seed + 1000);
    const seis = Float32Array.from(clean, (v) => (Math.abs(v) < 1e29 ? v + 0.25 * rms * 2 * Math.sqrt(3) * (r() - 0.5) : v));
    const s = suggestTieAnchors(syn, seis, DT);
    expect(s.ok).toBe(true);
    for (const a of s.anchors) expect(Math.abs(a.seisTwtMs - a.synTwtMs - shiftOf(a.synTwtMs))).toBeLessThanOrEqual(DT);
    expect(Math.abs(s.phiDeg - 30)).toBeLessThan(6);
  }
});

test('a pure bulk shift gives a constant shift: no invented stretch', () => {
  const syn = synthetic(11);
  const seis = warpTrace(syn, DT, makeTieWarp([{ synTwtMs: 0, seisTwtMs: 20 }]), NS);
  const s = suggestTieAnchors(syn, seis, DT);
  expect(s.ok).toBe(true);
  for (const a of s.anchors) expect(Math.abs(a.seisTwtMs - a.synTwtMs - 20)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.phiDeg)).toBeLessThan(3);
});

test('negative control: unrelated noise suggests no anchors, at the default settings, over twenty draws', () => {
  for (let k = 0; k < 20; k++) {
    const r = rng(100 + k);
    const noise = Float32Array.from({ length: NS }, () => r() - 0.5);
    const s = suggestTieAnchors(synthetic(k), noise, DT);
    expect(s.ok).toBe(false);
    expect(s.anchors).toEqual([]);
    expect(s.reason).toMatch(/no anchors are suggested/);
  }
});

test('gaps never enter the sums; settings are checked', () => {
  const syn = synthetic(5);
  const seis = warpTrace(syn, DT, trueWarp, NS); // nulls beyond the synthetic's end
  const holed = Float32Array.from(seis, (v, i) => (i > 300 && i < 330 ? NaN : v));
  const s = suggestTieAnchors(syn, holed, DT);
  expect(s.ok).toBe(true);
  for (const a of s.anchors) expect(Math.abs(a.seisTwtMs - a.synTwtMs - shiftOf(a.synTwtMs))).toBeLessThanOrEqual(DT);
  expect(() => suggestTieAnchors(syn, seis, DT, { maxStrain: 1 })).toThrow(/strain/);
  expect(AUTO_ANCHOR_DEFAULTS.maxStrain).toBeLessThan(1);
});
