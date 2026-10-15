/**
 * Feasibility sweeps (QI upgrade P2.9). Every gate calls the shipped
 * functions: Backus and the saturated soft sand against a stdlib oracle
 * written from the Rock Physics Handbook (tools/validation/qi/
 * oracle_feasibility_sweep.py), the bed response's tuning against
 * rockphysics/wedge.js and the analytic peak-to-trough time, and physical
 * truths of the sweep (a gas sand separates more than a brine one does from
 * itself; a vanishing bed separates nothing; separation grows with porosity
 * in a soft sand). Negative controls: the arithmetic average is not Backus;
 * the same fluid twice gives d' of exactly zero; a thin bed is not separable
 * where the thick one is.
 */
import fs from 'fs';
import path from 'path';
import {
  backusAverage, sandElastic, bedResponse, separability, feasibilitySweep, separableRanges, effectiveStress, contrasts,
} from '../engines/qi/feasibilitySweep';
import { tuningCurve, tuningThicknessMs } from '../engines/rockphysics/wedge';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/qi/goldens.feasibilitySweep.json'), 'utf8'));
const brine = { k: 2.6e9, rho: 1030 };
const gas = { k: 0.08e9, rho: 180 };
const shale = { vp: 2900, vs: 1350, rho: 2450 };

test('Backus against the oracle; identical layers; negative control: the arithmetic average', () => {
  const l = G.backus.layers.map(([h, vp, vs, rho]) => ({ h, vp, vs, rho }));
  const b = backusAverage(l);
  expect(b.vp).toBeCloseTo(G.backus.out[0], 8);
  expect(b.vs).toBeCloseTo(G.backus.out[1], 8);
  expect(b.rho).toBeCloseTo(G.backus.out[2], 10);
  const same = backusAverage([{ h: 1, vp: 3000, vs: 1500, rho: 2400 }, { h: 3, vp: 3000, vs: 1500, rho: 2400 }]);
  expect(same.vp).toBeCloseTo(3000, 9);
  const arith = 0.6 * 3200 + 0.4 * 2700;
  expect(Math.abs(b.vp - arith)).toBeGreaterThan(10);
});

test.each(G.sands.map((s, i) => [i, s]))('saturated soft sand %i against the oracle', (i, s) => {
  const r = sandElastic({ phi: s.phi, vsh: s.vsh, peffMPa: s.peffMPa, fluid: s.fluid });
  expect(r.vp / s.vp).toBeCloseTo(1, 10);
  expect(r.vs / s.vs).toBeCloseTo(1, 10);
  expect(r.rho / s.rho).toBeCloseTo(1, 12);
});

test('the bed response tunes where rockphysics/wedge.js does, at the peak-to-trough time', () => {
  const bed = { vp: 2500, vs: 1400, rho: 2200 };
  const c = contrasts(shale, bed);
  const rc = 0.5 * (c.dVpVp + c.dRhoRho);
  const f = 30; const dt = 0.5;
  const { amplitudes } = tuningCurve(rc, -rc, f, dt, 60);
  const tuneMs = tuningThicknessMs(amplitudes, dt);
  let best = 0; let bestMs = 0;
  for (let ms = 0; ms <= 60; ms += 0.5) {
    const a = bedResponse({ bed, shale, thicknessM: (ms * bed.vp) / 2000, freqHz: f, anglesDeg: [0] }).amp[0];
    if (a > best) { best = a; bestMs = ms; }
  }
  expect(Math.abs(bestMs - tuneMs)).toBeLessThanOrEqual(1);
  expect(Math.abs(bestMs - (1000 * Math.sqrt(6)) / (2 * Math.PI * f))).toBeLessThan(1.5);
});

test('separability: d\' and the misclassification of a normal; the same fluid twice is zero (negative control)', () => {
  const s = separability(0.12, 0.10, 0.01);
  expect(s.dprime).toBeCloseTo(2, 12);
  expect(s.misclass).toBeCloseTo(0.158655, 5);
  const sweep = feasibilitySweep({ base: { phi: 0.3, vsh: 0.05, peffMPa: 20, thicknessM: 30 }, sweeps: {}, fluidA: brine, fluidB: brine, shale, freqHz: 30, snr: 5 });
  expect(sweep.base.dprime).toEqual([0, 0]);
  expect(sweep.base.separable).toBe(false);
});

test('the sweeps: thickness to zero separates nothing; porosity raises separation in a soft sand; ranges for the gate', () => {
  const sweep = feasibilitySweep({
    base: { phi: 0.28, vsh: 0.1, peffMPa: 20, thicknessM: 25 },
    sweeps: { thicknessM: [0, 2, 25], phi: [0.18, 0.24, 0.32], vsh: [0, 0.3], peffMPa: [10, 30] },
    fluidA: brine, fluidB: gas, shale, freqHz: 30, snr: 4,
  });
  const th = sweep.rows.filter((r) => r.variable === 'thicknessM');
  expect(th[0].dprime[0]).toBeCloseTo(0, 12);
  expect(th[2].separable).toBe(true);
  expect(th[1].dprime[0]).toBeLessThan(th[2].dprime[0]); // negative control: thin is weaker than thick
  const ph = sweep.rows.filter((r) => r.variable === 'phi').map((r) => r.dprime[0]);
  expect(ph[0]).toBeLessThan(ph[1]); expect(ph[1]).toBeLessThan(ph[2]);
  const ranges = separableRanges(sweep);
  expect(ranges.thicknessM).toMatchObject({ tested: 3, max: 25 });
  expect(Object.keys(ranges).sort()).toEqual(['peffMPa', 'phi', 'thicknessM', 'vsh']);
  expect(sweep.noiseSd).toBeCloseTo(sweep.base.ampA[0] / 4, 12);
  // Backus net-to-gross dilutes the response
  const half = feasibilitySweep({ base: { phi: 0.28, vsh: 0.1, peffMPa: 20, thicknessM: 25, ntg: 0.5 }, sweeps: {}, fluidA: brine, fluidB: gas, shale, freqHz: 30, noiseSd: sweep.noiseSd });
  expect(half.base.dprime[0]).toBeLessThan(sweep.base.dprime[0]);
});

test('effective stress and refusals', () => {
  expect(effectiveStress({ overburdenMPa: 50, porePressureMPa: 22 })).toBe(28);
  expect(() => feasibilitySweep({ base: { phi: 0.2, vsh: 0, peffMPa: 20, thicknessM: 10 }, sweeps: { depth: [1] }, fluidA: brine, fluidB: gas, shale, freqHz: 30, snr: 4 })).toThrow(/Unknown sweep/);
  expect(() => feasibilitySweep({ base: { phi: 0.2, vsh: 0, peffMPa: 20, thicknessM: 10 }, sweeps: {}, fluidA: brine, fluidB: gas, shale, freqHz: 30 })).toThrow(/noise/);
  expect(() => sandElastic({ phi: 0.2, vsh: 0, peffMPa: 0, fluid: brine })).toThrow(/Effective stress/);
});
