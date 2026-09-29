// PETRO-U2-012 (Petrophysics Studio Step 2, 2026-09-29): one porosity system
// per saturation. Closes PETRO-U1-019 (BVW for Waxman-Smits and dual water
// was PHIE x Swt), 020 (the total-porosity saturation was published as SW)
// and 021 (probabilistic zone Sw statistics were thickness-weighted while
// the zone card is pore-volume weighted).
//
// Every gate calls the shipped function. The invariants are asserted to
// numerical precision: BVW = PHIT x Swt sample by sample for the total
// models; net x phi_avg x (1 - sw_avg) = HCPV for the zone; a degenerate
// probabilistic run reproduces the deterministic zone Sw and HCPV exactly.
//
// Negative controls (run 2026-09-29): with BVW back on PHIE the total-model
// gate fails on every shaly sample; with the probabilistic loop reading
// zoneSummary's sw_avg the degenerate-run gate reads the thickness-weighted
// figure and fails; with the SW mask removed from preparePublishLogs the
// publish gate finds an SW row carrying Swt.

import fs from 'fs';
import path from 'path';
import {
  computeWell, computeWellZoned, zoneSummary, zoneHydrocarbon, preparePublishLogs, isTotalSwModel, TOTAL_SW_MODELS, DEFAULT_PARAMS,
} from '../engines/petrophysics/pipeline';
import { runProbabilistic, OUTCOME_FIELDS } from '../engines/petrophysics/probabilistic';

const DATA_DIR = path.join(__dirname, '..', 'test-data', 'petrophysics');
const typewell = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'typewell.json'), 'utf8'));
const curve = (name) => Float64Array.from(typewell.curves[name], (v) => (v === null ? NaN : v));
const curves = { DEPT: curve('DEPT'), GR: curve('GR'), RHOB: curve('RHOB'), NPHI: curve('NPHI'), DT: curve('DT'), RT: curve('RT') };
const params = { ...DEFAULT_PARAMS, phiShale: typewell.params.phi_shale };
const [aTop, aBase] = typewell.params.zones.SAND_A;
const SAND_A = { top_md_m: aTop, base_md_m: aBase };
const F = (a) => Float64Array.from(a);

test('the total-porosity models are named', () => {
  expect(TOTAL_SW_MODELS).toEqual(['waxman-smits', 'dual-water']);
  expect(isTotalSwModel('dual-water')).toBe(true);
  expect(isTotalSwModel('archie')).toBe(false);
});

describe('BVW in the porosity system of its saturation (019)', () => {
  test.each(['waxman-smits', 'dual-water'])('%s: BVW = PHIT x Swt, sample by sample; SWT carries Swt', (swMethod) => {
    const { outputs: o } = computeWell(curves, { ...params, swMethod });
    expect(o.SWT).toBe(o.SW);
    let shaly = 0;
    for (let i = 0; i < o.SW.length; i++) {
      if (!Number.isFinite(o.SW[i]) || !Number.isFinite(o.PHIT[i])) continue;
      const sw = Math.min(1, Math.max(0, o.SW[i]));
      expect(o.BVW[i]).toBe(o.PHIT[i] * sw);
      if (Math.abs(o.PHIT[i] - o.PHIE[i]) > 1e-6) shaly += 1;
    }
    expect(shaly).toBeGreaterThan(20); // the case discriminates: PHIE differs from PHIT on these samples
  });

  test('Archie family: BVW stays PHIE x Sw and there is no SWT', () => {
    const { outputs: o } = computeWell(curves, params);
    expect(o.SWT).toBeUndefined();
    for (let i = 0; i < o.SW.length; i++) {
      if (!Number.isFinite(o.SW[i]) || !Number.isFinite(o.PHIE[i])) continue;
      expect(o.BVW[i]).toBe(o.PHIE[i] * Math.min(1, Math.max(0, o.SW[i])));
    }
  });
});

describe('publish names the saturation by its system (020)', () => {
  const wellData = { curves, inventory: [{ key: 'DEPT', log: { id: 'd', step_m: 0.5 } }] };
  test('a dual-water well publishes SWT and no SW', () => {
    const p = { ...params, swMethod: 'dual-water' };
    const logs = preparePublishLogs(wellData, computeWell(curves, p).outputs, p, { projectId: 'x' });
    const names = logs.map((l) => l.mnemonic);
    expect(names).toContain('SWT');
    expect(names).not.toContain('SW');
    expect(logs.find((l) => l.mnemonic === 'SWT').description).toMatch(/Total water saturation Swt on PHIT \(dual-water\)/);
  });
  test('an Archie well with one dual-water zone: SW outside the zone, SWT inside, never both', () => {
    const zp = [{ top: aTop, base: aBase, params: { swMethod: 'dual-water' } }];
    const { outputs } = computeWellZoned(curves, params, zp);
    const logs = preparePublishLogs(wellData, outputs, params, { projectId: 'x' });
    const sw = logs.find((l) => l.mnemonic === 'SW').data;
    const swt = logs.find((l) => l.mnemonic === 'SWT').data;
    let inside = 0;
    for (let i = 0; i < curves.DEPT.length; i++) {
      const d = curves.DEPT[i];
      if (Number.isFinite(sw[i]) && Number.isFinite(swt[i])) throw new Error(`both at ${d}`);
      if (d >= aTop && d <= aBase && Number.isFinite(outputs.SW[i])) { inside += 1; expect(Number.isFinite(swt[i])).toBe(true); }
    }
    expect(inside).toBeGreaterThan(10);
  });
});

describe('zone Sw by pore volume, in each sample\'s own system (021)', () => {
  test('hand case: thickness-weighted 0.35, pore-volume weighted 0.275', () => {
    const c = { DEPT: F([100, 101]) };
    const o = { PHIE: F([0.30, 0.10]), PHIT: F([0.30, 0.10]), VSH: F([0.1, 0.1]), SW: F([0.20, 0.50]) };
    const z = { top_md_m: 99, base_md_m: 102 };
    const pr = { cutPhi: 0.08, cutVsh: 0.5, cutSw: 0.6 };
    expect(zoneSummary(c, o, pr, z).sw_avg).toBeCloseTo(0.35, 14);
    const h = zoneHydrocarbon(c, o, pr, z);
    expect(h.sw_avg).toBeCloseTo(0.11 / 0.4, 14);
    expect(h.hcpv_m).toBeCloseTo(0.3 * 0.8 + 0.1 * 0.5, 14);
  });
  test('dual water: HCPV is PHIT (1 - Swt); sw_avg is the effective equivalent', () => {
    const c = { DEPT: F([100, 101]) };
    const o = { PHIT: F([0.25, 0.25]), PHIE: F([0.20, 0.20]), VSH: F([0.2, 0.2]), SW: F([0.4, 0.4]) };
    const h = zoneHydrocarbon(c, o, { swMethod: 'dual-water', cutPhi: 0.08, cutVsh: 0.5, cutSw: 0.6 }, { top_md_m: 99, base_md_m: 102 });
    expect(h.sw_system).toBe('total');
    expect(h.hcpv_m).toBeCloseTo(2 * 0.25 * 0.6, 14);
    expect(h.sw_avg).toBeCloseTo(1 - 0.3 / 0.4, 14);
  });
  test.each(['archie', 'dual-water', 'waxman-smits'])('%s on the type well: net x phi_avg x (1 - sw_avg) = HCPV to 1e-12', (swMethod) => {
    const p = { ...params, swMethod };
    const { outputs } = computeWell(curves, p);
    const s = zoneSummary(curves, outputs, p, SAND_A);
    const h = zoneHydrocarbon(curves, outputs, p, SAND_A);
    expect(s.net_m).toBeGreaterThan(0);
    expect(Math.abs(s.net_m * s.phi_avg * (1 - h.sw_avg) - h.hcpv_m)).toBeLessThan(1e-12);
  });

  test('probabilistic: a run with nothing varied reproduces the zone card Sw and HCPV exactly; HCPV is an outcome', () => {
    const p = { ...params, swMethod: 'dual-water' };
    const res = runProbabilistic(curves, p, [], {}, { n: 5, zones: [{ id: 'A', name: 'SAND A', ...SAND_A }] });
    const { outputs } = computeWell(curves, p);
    const h = zoneHydrocarbon(curves, outputs, p, SAND_A);
    const z = res.zones[0];
    expect(OUTCOME_FIELDS).toContain('hcpv_m');
    expect(z.parameters.sw_avg.q50).toBe(h.sw_avg);
    expect(z.outcomes.hcpv_m.p50).toBe(h.hcpv_m);
    // and it differs from the thickness-weighted figure the engine used to report
    expect(Math.abs(zoneSummary(curves, outputs, p, SAND_A).sw_avg - h.sw_avg)).toBeGreaterThan(1e-4);
  });

  test('probabilistic HCPV percentiles are ordered as exceedance', () => {
    const res = runProbabilistic(curves, params, [], { rw: { type: 'lognormal', mean: 0.05, stdDev: 0.015 } }, { n: 101, seed: 7, zones: [{ id: 'A', name: 'SAND A', ...SAND_A }] });
    const o = res.zones[0].outcomes.hcpv_m;
    expect(o.p90).toBeLessThanOrEqual(o.p50);
    expect(o.p50).toBeLessThanOrEqual(o.p10);
    expect(o.p10).toBeGreaterThan(o.p90);
  });
});
