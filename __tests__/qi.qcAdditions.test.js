/**
 * Seismic QC additions (QI upgrade P2.11). Gates call the shipped functions:
 * the autocorrelation against numpy (tools/validation/qi/
 * oracle_qc_additions.py), a designed water-bottom multiple train found at
 * its period, a designed angle-dependent gain recovered, designed misties.
 * Negative controls: a primary-only random reflectivity is not periodic;
 * true-amplitude stacks are not flagged; wells on one tie are not flagged.
 */
import fs from 'fs';
import path from 'path';
import { autocorrelation, multipleDiagnosis, amplitudePreservation, depthAlignment } from '../engines/qi/qcAdditions';
import { rickerWavelet, convolveSame } from '../lib/waveform';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/qi/goldens.qcAdditions.json'), 'utf8'));

test.each(G.cases.map((c, i) => [i, c]))('autocorrelation %i against numpy', (i, c) => {
  const a = autocorrelation(c.trace, 80);
  c.acf.forEach((v, k) => expect(a[k]).toBeCloseTo(v, 12));
});

function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; }; }
const dt = 4; const ns = 750;
const trace = (seed, multiple) => {
  const r = rng(seed); const refl = new Float64Array(ns);
  for (let i = 0; i < ns; i++) if (Math.abs(r()) > 0.42) refl[i] = r();
  if (multiple) {
    // a water-bottom peg-leg train: every reflection repeats every 120 ms with -0.6 times the amplitude
    const P = 120 / dt; const out = Float64Array.from(refl);
    for (let i = 0; i < ns; i++) { let a = refl[i]; for (let m = 1; m <= 4 && i + m * P < ns; m++) { a *= -0.6; out[i + m * P] += a; } }
    return convolveSame(out, rickerWavelet(30, dt, 60)).data;
  }
  return convolveSame(refl, rickerWavelet(30, dt, 60)).data;
};

test('a multiple train is found at its period; negative control: primaries alone are not periodic', () => {
  const m = multipleDiagnosis([1, 2, 3, 4, 5].map((s) => trace(s, true)), dt, { threshold: 0.2 });
  expect(m.periodic).toBe(true);
  expect(Math.abs(m.periodMs - 120)).toBeLessThanOrEqual(dt);
  const p = multipleDiagnosis([1, 2, 3, 4, 5].map((s) => trace(s, false)), dt, { threshold: 0.2 });
  expect(p.periodic).toBe(false);
});

test('amplitude preservation: a gain growing with angle is recovered; true amplitudes are not flagged', () => {
  const angles = [7, 17, 27, 37];
  const modelled = [0.10, 0.08, 0.05, 0.01].map((v, i) => v + 0.001 * i);
  const gain = (t) => Math.exp(0.9 * Math.sin((t * Math.PI) / 180) ** 2);
  const wells = ['A', 'B', 'C'].map((name, j) => ({ name, angles, modelled, observed: modelled.map((m, i) => 1500 * (1 + 0.1 * j) * m * gain(angles[i])) }));
  const r = amplitudePreservation(wells);
  r.rows.forEach((x) => expect(x.k).toBeCloseTo(0.9, 10));
  expect(r.flagged).toBe(true);
  const clean = wells.map((w) => ({ ...w, observed: w.modelled.map((m) => 1500 * m) }));
  const c = amplitudePreservation(clean);
  expect(Math.abs(c.k)).toBeLessThan(1e-12);
  expect(c.flagged).toBe(false);
});

test('depth alignment: the well off the others is flagged; negative control: one shared bulk shift is not', () => {
  const d = depthAlignment([{ name: 'A', horizonMs: 1504, wellMs: 1500 }, { name: 'B', horizonMs: 1606, wellMs: 1601 }, { name: 'C', horizonMs: 1720, wellMs: 1700 }]);
  expect(d.medianMs).toBe(5);
  expect(d.rows.map((r) => r.flagged)).toEqual([false, false, true]);
  const s = depthAlignment([{ name: 'A', horizonMs: 1512, wellMs: 1500 }, { name: 'B', horizonMs: 1613, wellMs: 1601 }]);
  expect(s.rows.every((r) => !r.flagged)).toBe(true);
});
