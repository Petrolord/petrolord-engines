// PT11d stage one: the deterministic multi-mineral solver against
// synthetic recovery, the single-source and two-mineral collapses, the
// refusals, the type-well MINERAL golden and the pipeline's explicit
// 'mineral' porosity source.

import fs from 'fs';
import path from 'path';
import {
  solveMineralSample, solveMineralCurves, MINERAL_ENDPOINTS, FLUID_DEFAULT, withU, uOf, rhoElectron, MINERAL_FLAGS,
} from '../engines/petrophysics/mineral';
import { phiDensity } from '../engines/petrophysics/porosity';
import { twoMineralSolve } from '../engines/petrophysics/matrix';
import { computeWell, DEFAULT_PARAMS, PIPELINE_VERSION } from '../engines/petrophysics/pipeline';

const DATA = path.join(__dirname, '..', 'test-data', 'petrophysics');
const typewell = JSON.parse(fs.readFileSync(path.join(DATA, 'typewell.json'), 'utf8'));
const goldens = JSON.parse(fs.readFileSync(path.join(DATA, 'goldens.json'), 'utf8'));
const analytic = JSON.parse(fs.readFileSync(path.join(DATA, 'analytic_cases.json'), 'utf8'));
const G = goldens.MINERAL;
const toArr = (a) => Float64Array.from(a, (v) => (v == null ? NaN : v));
const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

const Q = withU(MINERAL_ENDPOINTS.quartz);
const C = withU(MINERAL_ENDPOINTS.calcite);
const D = withU(MINERAL_ENDPOINTS.dolomite);
const F = { ...FLUID_DEFAULT };
const forward = (mins, v, phi) => {
  const rhob = mins.reduce((s, m, i) => s + v[i] * m.rho, 0) + phi * F.rho;
  const nphi = mins.reduce((s, m, i) => s + v[i] * m.nphi, 0) + phi * F.nphi;
  const u = mins.reduce((s, m, i) => s + v[i] * m.u, 0) + phi * F.u;
  return { rhob, nphi, pef: u / rhoElectron(rhob) };
};

test('gate 1: exact recovery of synthetic three-mineral cases, incl. a pure-mineral corner and zero porosity', () => {
  const cases = [
    [[0.5, 0.3, 0.05], 0.15],
    [[0.2, 0.6, 0.1], 0.1],
    [[1, 0, 0], 0],            // pure quartz, no porosity
    [[0, 0, 0.7], 0.3],        // dolomite only with porosity
    [[0.33, 0.33, 0.34], 0],   // zero porosity mix
  ];
  for (const [v, phi] of cases) {
    const r = solveMineralSample(forward([Q, C, D], v, phi), { minerals: [Q, C, D], fluid: F });
    expect(r.ok).toBe(true);
    expect(r.flag).toBe(0);
    expect(r.residual).toBe(0);
    for (let i = 0; i < 3; i++) expect(close(r.v[i], v[i])).toBe(true);
    expect(close(r.phi, phi)).toBe(true);
  }
});

test('gate 2: one mineral collapses to phiDensity byte for byte over the type well', () => {
  const rhob = toArr(typewell.curves.RHOB);
  const { outputs } = solveMineralCurves({ RHOB: rhob }, { minerals: [{ key: 'quartz', ...Q }], fluid: F });
  const want = Float64Array.from(rhob, (r) => phiDensity(r, Q.rho, F.rho));
  for (let i = 0; i < rhob.length; i++) {
    if (Number.isNaN(want[i])) { expect(Number.isNaN(outputs.PHI_MM[i])).toBe(true); continue; }
    // phi outside 0..1 is refused (flag 2) rather than returned
    if (want[i] < -1e-9 || want[i] > 1 + 1e-9) { expect(outputs.MM_FLAG[i]).toBe(2); continue; }
    expect(Object.is(outputs.PHI_MM[i], want[i])).toBe(true);
    expect(Object.is(outputs.V_QUARTZ[i], 1 - want[i])).toBe(true);
  }
  // the golden PHID agrees where it is finite
  for (let i = 0; i < rhob.length; i++) {
    if (goldens.PHID[i] == null || outputs.MM_FLAG[i] !== 0) continue;
    expect(close(outputs.PHI_MM[i], goldens.PHID[i])).toBe(true);
  }
});

test('gate 3: two minerals on density and neutron equal twoMineralSolve to 1e-12 (the two_mineral_ss_dol case)', () => {
  const c = analytic.two_mineral_ss_dol;
  const m1 = { rho: c.in.m1[0], nphi: c.in.m1[1], pe: 1.81 };
  const m2 = { rho: c.in.m2[0], nphi: c.in.m2[1], pe: 3.14 };
  const fluid = { rho: c.in.fluid[0], nphi: c.in.fluid[1] };
  const r = solveMineralSample({ rhob: c.in.rhob, nphi: c.in.nphi }, { minerals: [m1, m2], fluid });
  const t = twoMineralSolve(c.in.rhob, c.in.nphi, { m1, m2, fluid });
  expect(close(r.v[0], t.v1)).toBe(true);
  expect(close(r.v[1], t.v2)).toBe(true);
  expect(close(r.phi, t.phi)).toBe(true);
  expect(close(r.v[0], c.out.v1)).toBe(true);
});

test('gate 4: singular sets are refused with a reason and NaN, never a number', () => {
  const dup = solveMineralSample({ rhob: 2.3, nphi: 0.2, pef: 2 }, { minerals: [Q, Q, D], fluid: F });
  expect(dup.ok).toBe(false);
  expect(dup.flag).toBe(1);
  expect(MINERAL_FLAGS[dup.flag]).toBe('singular');
  expect(dup.reason).toMatch(/singular/);
  expect(dup.v.every(Number.isNaN)).toBe(true);
  expect(Number.isNaN(dup.phi)).toBe(true);
  const asFluid = solveMineralSample({ rhob: 2.3, nphi: 0.2, pef: 2 }, { minerals: [Q, C, { rho: 1.0, nphi: 1.0, u: 0.398 }], fluid: F });
  expect(asFluid.flag).toBe(1);
  const two = solveMineralSample({ rhob: 2.3, nphi: 0.2 }, { minerals: [Q, Q], fluid: F });
  expect(two.flag).toBe(1);
  expect(solveMineralSample({ rhob: 2.3, nphi: 0.2, pef: 2 }, { minerals: [], fluid: F }).flag).toBe(1);
});

test('gate 5: a point outside the mineral triangle is refused with the excursion, and the unclamped solution reconstructs the tools', () => {
  const tools = { rhob: 2.1, nphi: 0.05, pef: 5.5 };
  const r = solveMineralSample(tools, { minerals: [Q, C, D], fluid: F });
  expect(r.ok).toBe(false);
  expect(r.flag).toBe(2);
  expect(r.residual).toBeGreaterThan(0);
  expect(r.reason).toMatch(/does not fit/);
  expect(r.v.every(Number.isNaN)).toBe(true);
  const back = forward([Q, C, D], r.unclamped.v, r.unclamped.phi);
  expect(close(back.rhob, tools.rhob)).toBe(true);
  expect(close(back.nphi, tools.nphi)).toBe(true);
  expect(close(back.pef, tools.pef)).toBe(true);
  // missing inputs are flag 3
  expect(solveMineralSample({ rhob: 2.3, nphi: NaN, pef: 2 }, { minerals: [Q, C, D], fluid: F }).flag).toBe(3);
  expect(solveMineralSample({ rhob: 2.3, nphi: 0.2 }, { minerals: [Q, C, D], fluid: F }).flag).toBe(3);
});

test('gate 6: the type-well MINERAL golden at 1e-12, recovering phi_true and the shale fraction off the gas zone', () => {
  const curves = { RHOB: toArr(typewell.curves.RHOB), NPHI: toArr(typewell.curves.NPHI), PEF: toArr(typewell.curves.PEF) };
  const model = {
    minerals: [{ key: 'quartz', ...G.minerals.quartz }, { key: 'calcite', ...G.minerals.calcite }, { key: 'clay', ...G.minerals.clay }],
    fluid: G.fluid,
  };
  const { outputs, counts } = solveMineralCurves(curves, model);
  expect(Object.keys(outputs).sort()).toEqual(['MM_FLAG', 'MM_RES', 'PHI_MM', 'V_CALCITE', 'V_CLAY', 'V_QUARTZ']);
  let exact = 0;
  for (let i = 0; i < curves.RHOB.length; i++) {
    expect(outputs.MM_FLAG[i]).toBe(G.MM_FLAG[i]);
    for (const k of ['PHI_MM', 'V_QUARTZ', 'V_CALCITE', 'V_CLAY', 'MM_RES']) {
      if (G[k][i] == null) expect(Number.isNaN(outputs[k][i])).toBe(true);
      else expect(close(outputs[k][i], G[k][i])).toBe(true);
    }
    if (G.MM_FLAG[i] === 0) {
      const z = typewell.curves.DEPT[i];
      const gas = z >= 2012 && z <= 2028;
      if (!gas) {
        expect(Math.abs(outputs.PHI_MM[i] - typewell.construction.phi_true[i])).toBeLessThan(1e-9);
        expect(Math.abs(outputs.V_CLAY[i] - typewell.construction.shale_fraction[i])).toBeLessThan(1e-9);
        expect(Math.abs(outputs.V_CALCITE[i])).toBeLessThan(1e-9);
        exact++;
      }
    }
  }
  expect(exact).toBeGreaterThan(120);
  expect(counts.accepted).toBe(G.MM_FLAG.filter((f) => f === 0).length);
  expect(counts.outOfRange).toBe(G.MM_FLAG.filter((f) => f === 2).length);
  // the gas zone is where the fixed-fluid assumption fails: refused, not fudged
  const gasIdx = typewell.curves.DEPT.map((z, i) => (z >= 2014 && z <= 2026 ? i : -1)).filter((i) => i >= 0);
  expect(gasIdx.every((i) => outputs.MM_FLAG[i] === 2)).toBe(true);
});

test('gate 6b: phiSource mineral feeds PHIT from PHI_MM and reproduces PHID where the model is quartz only', () => {
  const rhob = toArr(typewell.curves.RHOB);
  const { outputs: mm } = solveMineralCurves({ RHOB: rhob }, { minerals: [{ key: 'quartz', ...Q }], fluid: F });
  const curves = { DEPT: toArr(typewell.curves.DEPT), GR: toArr(typewell.curves.GR), RHOB: rhob, NPHI: toArr(typewell.curves.NPHI), RT: toArr(typewell.curves.RT), PHI_MM: mm.PHI_MM };
  const res = computeWell(curves, { ...DEFAULT_PARAMS, phiSource: 'mineral' });
  expect(res.missing.some((m) => /mineral/.test(m))).toBe(false);
  for (let i = 0; i < rhob.length; i++) {
    if (mm.MM_FLAG[i] !== 0) continue;
    expect(Object.is(res.outputs.PHIT[i], res.outputs.PHID[i])).toBe(true);
  }
  // without PHI_MM the source is reported missing, never defaulted
  const none = computeWell({ ...curves, PHI_MM: undefined }, { ...DEFAULT_PARAMS, phiSource: 'mineral' });
  expect(none.outputs.PHIT).toBeUndefined();
  expect(none.missing).toContain('mineral porosity inputs');
  expect(DEFAULT_PARAMS.phiSource).toBe('density');
});

test('gate 7: every other phiSource is unchanged (the PHID golden through the pipeline) and the version moved', () => {
  const curves = { DEPT: toArr(typewell.curves.DEPT), GR: toArr(typewell.curves.GR), RHOB: toArr(typewell.curves.RHOB), NPHI: toArr(typewell.curves.NPHI), DT: toArr(typewell.curves.DT), RT: toArr(typewell.curves.RT) };
  const res = computeWell(curves, { ...DEFAULT_PARAMS, phiSource: 'density' });
  for (let i = 0; i < curves.DEPT.length; i++) {
    if (goldens.PHID[i] == null) expect(Number.isNaN(res.outputs.PHIT[i])).toBe(true);
    else expect(close(res.outputs.PHIT[i], goldens.PHID[i])).toBe(true);
  }
  expect(PIPELINE_VERSION).toBe(6);
  expect(uOf(1.81, 2.65)).toBeCloseTo(analytic.u_maa_quartz.out, 9);
});
