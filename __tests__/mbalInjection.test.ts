// MBAL acceptance gates added in the Material Balance Studio upgrade, Step 2
// (MBAL-U2, 2026-10-02).
// ============================================================================
//
// GATE 11  Injection in the balance (MBAL-U2-002). F is the net withdrawal of
//          the Havlena-Odeh form, Np[Bt + (Rp - Rsi)Bg] + Wp·Bw - Winj·Bw -
//          Ginj·Bginj. No published worked example WITH injection could be
//          read for this round, so the gate rests on an independent stdlib
//          oracle (test-data/mbal/injection/oracle.py, README there):
//            - a hand calculation on the published Ahmed Example 11-1 data
//              with stated injection volumes added;
//            - an exact synthetic oil tank under water and gas injection and
//              an exact synthetic gas tank under gas cycling, built from a
//              known N or G by the oracle's own MBE;
//          each with a negative control (the same rows without the injection
//          columns, which is what the engine computed before 2026-10-02).
// GATE 12  Bo above the bubble point (MBAL-U2-007, S1). Boi was Bob, the
//          volume factor at the bubble point, so Eo was negative above Pb for
//          any case without a Bo on its initial row; and a PVT table's rows
//          above Pb were never read. Anchored on the published Ahmed Example
//          11-3 (all 13 points above Pb): the same data given as a PVT table
//          must give the answer it gives as per-row values.
// GATE 13  The engine says where it left the PVT table (MBAL-U2-006).
//
// Every assertion calls the shipped engine. None recomputes its formula.

import * as fs from 'fs';
import * as path from 'path';
import {
  computeMaterialBalance,
  computeOilPerTimestep,
  computeGasPerTimestep,
  oilDriveIndices,
  runHistoryMatch,
} from '../engines/mbal/mbalEngine.ts';

const DIR = path.join(__dirname, '..', 'test-data', 'mbal');
const golden = JSON.parse(fs.readFileSync(path.join(DIR, 'injection', 'injection-golden.json'), 'utf8'));
const ex111 = JSON.parse(fs.readFileSync(path.join(DIR, 'ahmed-ex-11-1-combination.json'), 'utf8'));
const ex113 = JSON.parse(fs.readFileSync(path.join(DIR, 'ahmed-ex-11-3-depletion.json'), 'utf8'));

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const CORR = {
  pb_rs_bo: 'standing', oil_viscosity: 'beggs_robinson', z_factor: 'hall_yarborough',
  water: 'mccain', gas_viscosity: 'lee_gonzalez_eakin',
} as const;
const stripInjection = (rows: any[]) =>
  rows.map(({ cum_water_inj_stb, cum_gas_inj_scf, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
const stripOracle = (rows: any[]) => rows.map(({ Et, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars

// ============================================================================
// GATE 11 — injection in the balance
// ============================================================================
describe('GATE 11: injection in the balance (MBAL-U2-002)', () => {
  const g = ex111.given;
  const hand = golden.cases.ahmed_11_1_with_injection;
  const oneStep = (inj: { w: number; g: number }) => ({
    fluid_system: 'oil', has_aquifer: true, has_gas_cap: true,
    initial_pressure_psia: g.pi_psia, bubble_point_psia: g.pi_psia,
    reservoir_temperature_f: g.temp_f, initial_water_saturation: g.Swi,
    formation_compressibility_psi: g.cf_psi, water_compressibility_psi: g.cw_psi,
    oil_gravity_api: 35, gas_specific_gravity: g.gas_sg, gas_cap_ratio_m: g.m,
    aquifer_model: 'pot', pvt_source: 'lab_table', pvt_correlations: CORR,
    production_data: [
      {
        timestep_index: 0, pressure_psia: g.pi_psia, cum_oil_stb: 0, cum_gas_scf: 0, cum_water_stb: 0,
        bo_rb_stb: g.pvt.at_3000.Bo, rs_scf_stb: g.pvt.at_3000.Rs,
        bg_rb_scf: g.pvt.at_3000.Bg_rb_scf, bw_rb_stb: g.pvt.at_3000.Bw,
      },
      {
        timestep_index: 1, pressure_psia: g.p2_psia, cum_oil_stb: g.Np_stb, cum_gas_scf: g.Gp_scf,
        cum_water_stb: g.Wp_stb, cum_water_inj_stb: inj.w, cum_gas_inj_scf: inj.g,
        bo_rb_stb: g.pvt.at_2800.Bo, rs_scf_stb: g.pvt.at_2800.Rs,
        bg_rb_scf: g.pvt.at_2800.Bg_rb_scf, bw_rb_stb: g.pvt.at_2800.Bw,
      },
    ],
  }) as any;

  it('I-0: the oracle reproduces the published Example 11-1 influx before any injection is added', () => {
    // Anchors the oracle to the book: 411,281 bbl printed; the oracle carries
    // Bt from Bo and Rs (1.6548) where the book rounds it to 1.655.
    expect(rel(hand.We_without_injection_rb, ex111.printed.We_bbl)).toBeLessThan(0.005);
  });

  it('I-1: F nets out Winj·Bw and Ginj·Bginj exactly as the hand calculation', () => {
    const { per_timestep } = computeOilPerTimestep(oneStep({ w: hand.added.Winj_stb, g: hand.added.Ginj_scf }));
    const r = per_timestep[1];
    expect(rel(r.F_rb, hand.F_net_rb)).toBeLessThan(1e-12);
    expect(rel(r.winj_bw_rb!, hand.winj_bw_rb)).toBeLessThan(1e-12);
    expect(rel(r.ginj_bg_rb!, hand.ginj_bg_rb)).toBeLessThan(1e-12);
    expect(rel(r.Et_rb, hand.Et)).toBeLessThan(1e-12);
    // Back-calculated influx with N given, as the book does it.
    const We = r.F_rb - g.N_stb * r.Et_rb;
    expect(rel(We, hand.We_rb)).toBeLessThan(1e-9);
  });

  it('I-2: drive indices include both injection indices and close to 1 as an identity', () => {
    const { per_timestep } = computeOilPerTimestep(oneStep({ w: hand.added.Winj_stb, g: hand.added.Ginj_scf }));
    const r = per_timestep[1];
    const row = { ...r, We_rb: r.F_rb - g.N_stb * r.Et_rb };
    const idx = oilDriveIndices(row, g.N_stb, g.m, g.Wp_stb);
    expect(rel(idx.A_rb, hand.A_rb)).toBeLessThan(1e-12);
    for (const k of ['ddi', 'gdi', 'cdi', 'wdi', 'winj_di', 'ginj_di'] as const) {
      expect(rel(idx[k], hand.indices[k])).toBeLessThan(1e-9);
    }
    expect(Math.abs(idx.drive_index_sum - 1)).toBeLessThan(1e-12);
  });

  it('I-3 (negative control): without the injection columns F is the gross voidage and the influx is overstated', () => {
    const r = computeOilPerTimestep(oneStep({ w: 0, g: 0 })).per_timestep[1];
    expect(rel(r.F_rb, hand.F_gross_rb)).toBeLessThan(1e-12);
    const We = r.F_rb - g.N_stb * r.Et_rb;
    expect(We - hand.We_rb).toBeGreaterThan(0.99 * (hand.winj_bw_rb + hand.ginj_bg_rb));
  });

  const oilCase = golden.cases.synthetic_oil_injection;
  const oilInputs = (rows: any[]) => ({
    fluid_system: 'oil', has_aquifer: false, has_gas_cap: false,
    initial_pressure_psia: oilCase.case.pi, bubble_point_psia: oilCase.case.Pb,
    reservoir_temperature_f: 180, initial_water_saturation: oilCase.case.Swi,
    formation_compressibility_psi: oilCase.case.cf, water_compressibility_psi: oilCase.case.cw,
    oil_gravity_api: 35, gas_specific_gravity: 0.75,
    aquifer_model: 'none', pvt_source: 'lab_table', pvt_correlations: CORR,
    production_data: rows,
  }) as any;

  it('I-4: an oil tank under water and gas injection gives back its N to round-off', () => {
    const res = computeMaterialBalance(oilInputs(stripOracle(oilCase.rows)));
    expect(rel(res.estimated_ooip_stb!, oilCase.N_truth_stb)).toBeLessThan(1e-9);
    expect(res.r_squared).toBeGreaterThan(0.999999);
    for (const r of res.per_timestep.slice(1)) {
      expect(Math.abs(r.drive_index_sum! - 1)).toBeLessThan(1e-9);
    }
    expect(res.final_winj_di!).toBeGreaterThan(0.5);
    expect(res.final_ginj_di!).toBeGreaterThan(0);
    expect(res.drive_mechanism).toBe('injection_pressure_maintenance');
    // No published example with injection backs the path: the tier says so.
    expect(res.validation_tier).toBe('published_method');
    expect(res.validation_reference).toMatch(/not against a published worked example with injection/);
  });

  it('I-5 (negative control): the same tank read without injection is wrong by more than a factor of five', () => {
    const res = computeMaterialBalance(oilInputs(stripInjection(stripOracle(oilCase.rows))));
    expect((res.estimated_ooip_stb ?? 0) / oilCase.N_truth_stb).toBeGreaterThan(5);
  });

  it('I-6: the pressure history match reads the injection too and recovers N', () => {
    const hm = runHistoryMatch(oilInputs(stripOracle(oilCase.rows)), { fit_parameters: ['stoiip_stb'] });
    expect(rel(hm.matched_ooip_stb!, oilCase.N_truth_stb)).toBeLessThan(0.01);
    expect(hm.rms_error_psi).toBeLessThan(1);
    const blind = runHistoryMatch(oilInputs(stripInjection(stripOracle(oilCase.rows))), { fit_parameters: ['stoiip_stb'] });
    expect(rel(blind.matched_ooip_stb ?? 0, oilCase.N_truth_stb)).toBeGreaterThan(0.5);
  });

  const gasCase = golden.cases.synthetic_gas_cycling;
  const gasInputs = (rows: any[]) => ({
    fluid_system: 'gas', has_aquifer: false, has_gas_cap: false,
    initial_pressure_psia: gasCase.case.pi, reservoir_temperature_f: 200,
    initial_water_saturation: gasCase.case.Swi,
    formation_compressibility_psi: gasCase.case.cf, water_compressibility_psi: gasCase.case.cw,
    gas_specific_gravity: 0.65, aquifer_model: 'none', pvt_source: 'lab_table', pvt_correlations: CORR,
    production_data: rows,
  }) as any;

  it('I-7: a gas tank under gas cycling gives back its G to round-off, indices closing', () => {
    const res = computeMaterialBalance(gasInputs(stripOracle(gasCase.rows)));
    expect(rel(res.estimated_ogip_scf!, gasCase.G_truth_scf)).toBeLessThan(1e-9);
    const { per_timestep } = computeGasPerTimestep(gasInputs(stripOracle(gasCase.rows)));
    for (let k = 1; k < per_timestep.length; k++) {
      expect(rel(per_timestep[k].Et_rb, gasCase.rows[k].Et)).toBeLessThan(1e-12);
    }
    for (const r of res.per_timestep.slice(1)) {
      expect(Math.abs(r.drive_index_sum! - 1)).toBeLessThan(1e-9);
    }
    expect(res.final_ginj_di!).toBeGreaterThan(0);
    const blind = computeMaterialBalance(gasInputs(stripInjection(stripOracle(gasCase.rows))));
    expect((blind.estimated_ogip_scf ?? 0) / gasCase.G_truth_scf).toBeGreaterThan(1.5);
  });

  it('I-8: zero injection leaves every number bit for bit as it was', () => {
    const rows = stripInjection(stripOracle(oilCase.rows));
    const a = computeMaterialBalance(oilInputs(rows));
    const b = computeMaterialBalance(oilInputs(rows.map((r) => ({ ...r, cum_water_inj_stb: 0, cum_gas_inj_scf: 0 }))));
    expect(b.estimated_ooip_stb).toBe(a.estimated_ooip_stb);
    expect(b.per_timestep.map((r) => r.F_rb)).toEqual(a.per_timestep.map((r) => r.F_rb));
    expect(b.per_timestep.map((r) => r.drive_index_sum)).toEqual(a.per_timestep.map((r) => r.drive_index_sum));
    expect(a.final_winj_di).toBe(0);
    expect(a.final_ginj_di).toBe(0);
    expect(b.validation_tier).toBe(a.validation_tier);
    expect(b.validation_reference).toBe(a.validation_reference);
  });

  it('I-9: injection on the initial row, or a negative cumulative, is refused with a reason', () => {
    const rows = stripOracle(oilCase.rows);
    expect(() => computeMaterialBalance(oilInputs([{ ...rows[0], cum_water_inj_stb: 10 }, ...rows.slice(1)])))
      .toThrow(/initial reservoir state.*injected must be zero/);
    expect(() => computeMaterialBalance(oilInputs([rows[0], { ...rows[1], cum_gas_inj_scf: -5 }, ...rows.slice(2)])))
      .toThrow(/cannot be negative/);
  });
});

// ============================================================================
// GATE 12 — Bo above the bubble point (MBAL-U2-007)
// ============================================================================
describe('GATE 12: Bo above the bubble point', () => {
  const g = ex113.given;
  const perf = ex113.performance as Array<{ p: number; Bo: number; Np_mstb: number; Wp_mstb: number }>;
  const base = {
    fluid_system: 'oil', has_aquifer: false, has_gas_cap: false,
    initial_pressure_psia: g.pi_psia, bubble_point_psia: g.Pb_psia,
    reservoir_temperature_f: g.temp_f, initial_water_saturation: g.Swi,
    formation_compressibility_psi: g.cf_psi, water_compressibility_psi: g.cw_psi,
    oil_gravity_api: 35, gas_specific_gravity: 0.7, aquifer_model: 'none',
    pvt_correlations: CORR,
  };
  const rows = (withBo: boolean) => perf.map((r, i) => ({
    timestep_index: i, pressure_psia: r.p,
    cum_oil_stb: r.Np_mstb * 1000, cum_gas_scf: r.Np_mstb * 1000 * 500, cum_water_stb: r.Wp_mstb * 1000,
    ...(withBo ? { bo_rb_stb: r.Bo, rs_scf_stb: 500 } : {}),
    bw_rb_stb: 1.0,
  }));
  const table = perf.map((r) => ({ pressure_psia: r.p, bo_rb_stb: r.Bo, rs_scf_stb: 500 }));

  it('B-1: the published data as a PVT table gives the answer it gives as per-row values', () => {
    const perRow = computeMaterialBalance({ ...base, pvt_source: 'lab_table', production_data: rows(true) } as any);
    const asTable = computeMaterialBalance({ ...base, pvt_source: 'lab_table', pvt_lab_table: table, production_data: rows(false) } as any);
    expect(rel(asTable.estimated_ooip_stb!, perRow.estimated_ooip_stb!)).toBeLessThan(1e-9);
    expect(asTable.n_data_points).toBe(perRow.n_data_points);
    // The per-row answer is the engine's published-case figure (CASE 2D).
    expect(Math.abs(perRow.estimated_ooip_stb! / 1e6 - ex113.printed.engine_lsq_ooip_mmstb_2026_05_17)).toBeLessThan(0.1);
  });

  it('B-2: with correlations, Eo above the bubble point is positive and zero at the initial state', () => {
    const { per_timestep, meta } = computeOilPerTimestep({ ...base, pvt_source: 'correlated', production_data: rows(false) } as any);
    expect(per_timestep[0].Eo_rb_stb).toBe(0);
    expect(meta.Boi).toBe(per_timestep[0].bo_rb_stb);
    for (const r of per_timestep.slice(1)) expect(r.Eo_rb_stb!).toBeGreaterThan(0);
  });

  it('B-3 (negative control): Boi taken at the bubble point, as before, makes every Eo negative', () => {
    // Give the initial row the Bob the old code used; the later rows keep the
    // correlation path. This is the pre-2026-10-02 arithmetic, reproduced with
    // inputs rather than a copy of the old code.
    const corr = computeOilPerTimestep({ ...base, pvt_source: 'correlated', production_data: rows(false) } as any);
    const Bob = corr.per_timestep[0].bo_rb_stb! / (1 - 1e-5 * (g.pi_psia - g.Pb_psia));
    const old = rows(false);
    old[0] = { ...old[0], bo_rb_stb: Bob, rs_scf_stb: corr.meta.Rsi } as any;
    const { per_timestep } = computeOilPerTimestep({ ...base, pvt_source: 'correlated', production_data: old } as any);
    for (const r of per_timestep.slice(1)) expect(r.Eo_rb_stb!).toBeLessThan(0);
  });
});

// ============================================================================
// GATE 13 — the engine says where it left the PVT table (MBAL-U2-006)
// ============================================================================
describe('GATE 13: PVT table coverage', () => {
  const g = ex113.given;
  const perf = ex113.performance as Array<{ p: number; Bo: number; Np_mstb: number; Wp_mstb: number }>;
  const inputs = (tableTop: number) => ({
    fluid_system: 'oil', has_aquifer: false, has_gas_cap: false,
    initial_pressure_psia: g.pi_psia, bubble_point_psia: g.Pb_psia,
    reservoir_temperature_f: g.temp_f, initial_water_saturation: g.Swi,
    formation_compressibility_psi: g.cf_psi, water_compressibility_psi: g.cw_psi,
    oil_gravity_api: 35, gas_specific_gravity: 0.7, aquifer_model: 'none',
    pvt_source: 'lab_table', pvt_correlations: CORR,
    pvt_lab_table: perf.filter((r) => r.p <= tableTop).map((r) => ({ pressure_psia: r.p, bo_rb_stb: r.Bo, rs_scf_stb: 500 })),
    production_data: perf.map((r, i) => ({
      timestep_index: i, pressure_psia: r.p,
      cum_oil_stb: r.Np_mstb * 1000, cum_gas_scf: r.Np_mstb * 1000 * 500, cum_water_stb: r.Wp_mstb * 1000,
      bw_rb_stb: 1.0,
    })),
  }) as any;

  it('C-1: a table that covers every pressure reports full coverage and no warning', () => {
    const res = computeMaterialBalance(inputs(4000));
    expect(res.pvt_table_coverage).toEqual(expect.objectContaining({ timesteps_outside: [], initial_outside: false }));
    expect(res.warnings.some((w) => /PVT table coverage/.test(w))).toBe(false);
  });

  it('C-2: a table ending at 3,600 psia names the timesteps above it, the initial state among them', () => {
    const res = computeMaterialBalance(inputs(3600));
    const cov = res.pvt_table_coverage!;
    expect(cov.table_max_psia).toBe(3567);
    expect(cov.timesteps_outside).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cov.initial_outside).toBe(true);
    const bo = cov.fallbacks.filter((f) => f.property === 'Bo');
    expect(bo.map((f) => f.timestep_index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(bo.every((f) => f.used === 'fixed_co')).toBe(true);
    // Rsi came from the correlation at the bubble point, since the table
    // reaches neither pi nor Pb; said once, at the initial state.
    expect(cov.fallbacks.filter((f) => f.property === 'Rs')).toEqual([
      { timestep_index: 0, pressure_psia: g.Pb_psia, property: 'Rs', used: 'correlation' },
    ]);
    const w = res.warnings.find((x) => /PVT table coverage/.test(x))!;
    expect(w).toMatch(/7 timesteps \(0, 1, 2, 3, 4, 5, 6\)/);
    expect(w).toMatch(/3,188 to 3,567 psia/);
    expect(w).toMatch(/initial state is one of them/);
    expect(w).toMatch(/fixed oil compressibility of 1e-5/);
    expect(w).toMatch(/for Rs, Bo in place/);
  });

  it('C-3: a case with no table has no coverage block and no coverage warning', () => {
    const res = computeMaterialBalance({ ...inputs(4000), pvt_lab_table: undefined, pvt_source: 'correlated' });
    expect(res.pvt_table_coverage).toBeNull();
    expect(res.warnings.some((w) => /PVT table coverage/.test(w))).toBe(false);
  });

  it('C-4: rows with their own PVT never count as outside the table', () => {
    const inp = inputs(3600);
    inp.production_data = inp.production_data.map((r: any, i: number) => ({ ...r, bo_rb_stb: perf[i].Bo, rs_scf_stb: 500 }));
    const res = computeMaterialBalance(inp);
    expect(res.pvt_table_coverage!.timesteps_outside).toEqual([]);
  });

  it('C-5: the gas path records Bg outside the table', () => {
    const rows = golden.cases.synthetic_gas_cycling.rows;
    const res = computeMaterialBalance({
      fluid_system: 'gas', has_aquifer: false, has_gas_cap: false,
      initial_pressure_psia: 5000, reservoir_temperature_f: 200, initial_water_saturation: 0.25,
      formation_compressibility_psi: 5e-6, water_compressibility_psi: 3e-6, gas_specific_gravity: 0.65,
      aquifer_model: 'none', pvt_source: 'lab_table', pvt_correlations: CORR,
      pvt_lab_table: rows.filter((r: any) => r.pressure_psia <= 4700).map((r: any) => ({ pressure_psia: r.pressure_psia, bg_rb_mscf: r.bg_rb_mscf })),
      production_data: rows.map((r: any) => ({ timestep_index: r.timestep_index, pressure_psia: r.pressure_psia, cum_gas_scf: r.cum_gas_scf, cum_water_stb: r.cum_water_stb, bw_rb_stb: 1 })),
    } as any);
    expect(res.pvt_table_coverage!.timesteps_outside).toEqual([0, 1]);
    expect(res.pvt_table_coverage!.fallbacks.map((f) => f.property)).toEqual(['Bg', 'Bg']);
  });
});
