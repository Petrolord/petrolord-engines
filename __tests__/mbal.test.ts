// MBAL domain acceptance gates.
// ============================================================================
// Ported from the Suite's tiered validation harness
// (tools/validation/mbal-validation.ts), which REMAINS the canonical full
// runner (14+ cases, tier promotion rules) and now exercises this vendored
// engine through the Suite-side shim. The gates here are the literature
// anchors that must hold wherever the engine travels:
//
//   1. Pletcher SPE 75354 (2002) gas + pot aquifer (Tables 1-3):
//      OGIP, aquifer W, cumulative We, drive-index closure.
//   2. Ahmed REH 4th ed. Example 10-10 (data from Dake Ex. 9.2): oil +
//      Fetkovich aquifer — printed constants, printed We marching table,
//      full-path OOIP vs Dake's N = 312 MMSTB.
//   3. Ahmed REH 4th ed. Example 11-1: combination drive (oil + gas cap +
//      water) — combined-MBE terms and printed drive indexes, plus the m>0
//      pot-regression exact synthetic round trip.
//
// Fixture JSONs in test-data/mbal are typed verbatim from the cited book
// pages (armed-fixture pattern); dake-9-2.ts carries Dake Table 9.3.

import * as fs from 'fs';
import * as path from 'path';
import {
  computeMaterialBalance,
  computeFetkovichWe,
  computeOilPerTimestep,
} from '../engines/mbal/mbalEngine.ts';
import { DAKE_CT_RESERVOIR, DAKE_CT_PERFORMANCE } from '../test-data/mbal/dake-9-2.ts';

const FIXTURE_DIR = path.join(__dirname, '..', 'test-data', 'mbal');
const loadFixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

/** Relative-tolerance check matching the harness's check() semantics. */
const expectClose = (actual: number, expected: number, relTol: number) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relTol);
};

// ============================================================================
// GATE 1 — Pletcher SPE 75354 gas + pot aquifer
// ============================================================================

const PLETCHER_RESERVOIR = {
  initial_pressure_psia: 6411,
  reservoir_temperature_f: 239,
  initial_water_saturation: 0.15,
  formation_compressibility_psi: 6e-6,
  water_compressibility_psi: 3e-6,
  gas_specific_gravity: 0.65,
  true_ogip_bcf: 100.8,
  true_aquifer_w_mmrb: 74.5,
  true_we_year10_rb: 2_494_000,
};

const PLETCHER_PERFORMANCE = [
  { year: 0, p: 6411, Gp_bscf: 0.0, Wp_stb: 0 },
  { year: 1, p: 5947, Gp_bscf: 5.475, Wp_stb: 378 },
  { year: 2, p: 5509, Gp_bscf: 10.95, Wp_stb: 1_434 },
  { year: 3, p: 5093, Gp_bscf: 16.425, Wp_stb: 3_056 },
  { year: 4, p: 4697, Gp_bscf: 21.9, Wp_stb: 5_284 },
  { year: 5, p: 4319, Gp_bscf: 27.375, Wp_stb: 8_183 },
  { year: 6, p: 3957, Gp_bscf: 32.85, Wp_stb: 11_864 },
  { year: 7, p: 3610, Gp_bscf: 38.325, Wp_stb: 16_425 },
  { year: 8, p: 3276, Gp_bscf: 43.8, Wp_stb: 22_019 },
  { year: 9, p: 2953, Gp_bscf: 49.275, Wp_stb: 28_860 },
  { year: 10, p: 2638, Gp_bscf: 54.75, Wp_stb: 37_256 },
];

const PLETCHER_PVT = [
  { year: 0, p: 6411, z: 1.1192, Bg_rb_mscf: 0.6279, Bw_rb_stb: 1.0452 },
  { year: 1, p: 5947, z: 1.089, Bg_rb_mscf: 0.6587, Bw_rb_stb: 1.0467 },
  { year: 2, p: 5509, z: 1.0618, Bg_rb_mscf: 0.6933, Bw_rb_stb: 1.048 },
  { year: 3, p: 5093, z: 1.0374, Bg_rb_mscf: 0.7327, Bw_rb_stb: 1.0493 },
  { year: 4, p: 4697, z: 1.0156, Bg_rb_mscf: 0.7778, Bw_rb_stb: 1.0506 },
  { year: 5, p: 4319, z: 0.9966, Bg_rb_mscf: 0.83, Bw_rb_stb: 1.0517 },
  { year: 6, p: 3957, z: 0.9801, Bg_rb_mscf: 0.891, Bw_rb_stb: 1.0529 },
  { year: 7, p: 3610, z: 0.9663, Bg_rb_mscf: 0.9628, Bw_rb_stb: 1.054 },
  { year: 8, p: 3276, z: 0.9551, Bg_rb_mscf: 1.0487, Bw_rb_stb: 1.0551 },
  { year: 9, p: 2953, z: 0.9467, Bg_rb_mscf: 1.1532, Bw_rb_stb: 1.056 },
  { year: 10, p: 2638, z: 0.9409, Bg_rb_mscf: 1.2829, Bw_rb_stb: 1.0571 },
];

function buildPletcherInputs() {
  const production_data = PLETCHER_PERFORMANCE.map((perf, idx) => {
    const pvt = PLETCHER_PVT[idx];
    return {
      timestep_index: perf.year,
      pressure_psia: perf.p,
      cum_oil_stb: 0,
      cum_gas_scf: perf.Gp_bscf * 1e9,
      cum_water_stb: perf.Wp_stb,
      cum_water_inj_stb: 0,
      cum_gas_inj_scf: 0,
      bg_rb_mscf: pvt.Bg_rb_mscf,
      bw_rb_stb: pvt.Bw_rb_stb,
      z_factor: pvt.z,
    };
  });
  return {
    fluid_system: 'gas',
    has_aquifer: true,
    has_gas_cap: false,
    initial_pressure_psia: PLETCHER_RESERVOIR.initial_pressure_psia,
    reservoir_temperature_f: PLETCHER_RESERVOIR.reservoir_temperature_f,
    initial_water_saturation: PLETCHER_RESERVOIR.initial_water_saturation,
    gas_specific_gravity: PLETCHER_RESERVOIR.gas_specific_gravity,
    formation_compressibility_psi: PLETCHER_RESERVOIR.formation_compressibility_psi,
    water_compressibility_psi: PLETCHER_RESERVOIR.water_compressibility_psi,
    aquifer_model: 'pot',
    pvt_source: 'lab_table',
    pvt_correlations: {
      pb_rs_bo: 'standing',
      oil_viscosity: 'beggs_robinson',
      z_factor: 'hall_yarborough',
      water: 'mccain',
      gas_viscosity: 'lee_gonzalez_eakin',
    },
    solver_method: 'pot_aquifer_plot',
    // Pletcher excludes Year 1 (early-time outlier) from least squares.
    excluded_timesteps: [1],
    production_data,
  } as any;
}

describe('GATE 1: Pletcher SPE 75354 gas + pot aquifer', () => {
  const result = computeMaterialBalance(buildPletcherInputs());

  it('recovers OGIP within 2% of the true 100.8 Bcf', () => {
    expectClose(result.estimated_ogip_scf! / 1e9, PLETCHER_RESERVOIR.true_ogip_bcf, 0.02);
  });

  it('recovers aquifer W within 10% of the true 74.5 MM res bbl', () => {
    expectClose(result.aquifer_owip_rb! / 1e6, PLETCHER_RESERVOIR.true_aquifer_w_mmrb, 0.10);
  });

  it('matches the simulator cumulative We at year 10 within 10%', () => {
    expectClose(result.aquifer_cumulative_we_rb!, PLETCHER_RESERVOIR.true_we_year10_rb, 0.10);
  });

  it('closes the drive-index sum to 1.00 within 0.05', () => {
    expect(result.final_drive_index_sum).toBeGreaterThanOrEqual(0.95);
    expect(result.final_drive_index_sum).toBeLessThanOrEqual(1.05);
  });
});

// ============================================================================
// GATE 2 — Ahmed Example 10-10: oil + Fetkovich aquifer (Dake 9.2 data)
// ============================================================================

describe('GATE 2: Ahmed Ex. 10-10 oil + Fetkovich aquifer', () => {
  const fx = loadFixture('ahmed-ex-10-10-fetkovich.json');
  const g = fx.given;
  const f_wedge = g.theta_deg / 360;

  const Wi_bbl = (Math.PI * (g.ra_ft ** 2 - g.re_ft ** 2) * g.h_ft * g.phi) / 5.615;
  const W_eff_rb = Wi_bbl * f_wedge;
  const Wei_bbl = g.ct_psi * W_eff_rb * g.pi_psia;
  const J_bbl_d_psi = (0.00708 * g.k_md * g.h_ft * f_wedge) / (g.muw_cp * (Math.log(g.reD) - 0.75));

  it('F-1..F-4: reproduces the printed constants within 0.5%', () => {
    expectClose(Wi_bbl, fx.printed_derived.Wi_bbl, 0.005);
    expectClose(Wei_bbl, fx.printed_derived.Wei_bbl, 0.005);
    expectClose(J_bbl_d_psi, fx.printed_derived.J_bbl_d_psi, 0.005);
    const decay = 1 - Math.exp((-J_bbl_d_psi * g.pi_psia * g.dt_days) / Wei_bbl);
    expectClose(decay, fx.printed_derived.decay_term_365d, 0.005);
  });

  it('F-5..F-8: We marching reproduces the printed table within 1%', () => {
    const kernelInputs = {
      initial_pressure_psia: g.pi_psia,
      water_compressibility_psi: g.ct_psi / 2,
      formation_compressibility_psi: g.ct_psi / 2,
      aquifer_model: 'fetkovich',
      aquifer_params: {
        initial_aquifer_water_in_place_rb: W_eff_rb,
        aquifer_pi_rb_d_psi: J_bbl_d_psi,
        aquifer_total_compressibility_psi: g.ct_psi,
      },
      production_data: fx.pressure_history.map((r: any, i: number) => ({
        timestep_index: i,
        pressure_psia: r.p_psia,
      })),
    } as any;
    const deltas = fx.pressure_history.map((r: any, i: number) =>
      i === 0 ? 0 : r.t_days - fx.pressure_history[i - 1].t_days,
    );
    const We = computeFetkovichWe(kernelInputs, deltas);
    for (const row of fx.printed_table) {
      expectClose(We[row.n], row.We_MMbbl * 1e6, 0.01);
    }
  });

  it('F-9..F-12: full oil path recovers Dake OOIP within 10% with a coherent drive split', () => {
    const production_data = DAKE_CT_PERFORMANCE.map((row, idx) => ({
      timestep_index: idx,
      observation_date: `${1980 + row.yr}-01-01`,
      pressure_psia: row.p,
      cum_oil_stb: row.Np_mmstb * 1e6,
      cum_gas_scf: row.Np_mmstb * 1e6 * row.Rp,
      cum_water_stb: 0,
      bo_rb_stb: row.Bo,
      rs_scf_stb: row.Rs,
      bg_rb_scf: row.Bg,
      bw_rb_stb: 1.0,
    }));
    const result = computeMaterialBalance({
      fluid_system: 'oil',
      initial_pressure_psia: DAKE_CT_RESERVOIR.initial_pressure_psia,
      bubble_point_psia: DAKE_CT_RESERVOIR.bubble_point_psia,
      reservoir_temperature_f: DAKE_CT_RESERVOIR.reservoir_temperature_f,
      initial_water_saturation: DAKE_CT_RESERVOIR.initial_water_saturation,
      formation_compressibility_psi: DAKE_CT_RESERVOIR.formation_compressibility_psi,
      water_compressibility_psi: DAKE_CT_RESERVOIR.water_compressibility_psi,
      oil_gravity_api: DAKE_CT_RESERVOIR.oil_gravity_api,
      gas_specific_gravity: DAKE_CT_RESERVOIR.gas_specific_gravity,
      gas_cap_ratio_m: 0,
      aquifer_model: 'fetkovich',
      aquifer_params: {
        initial_aquifer_water_in_place_rb: W_eff_rb,
        aquifer_pi_rb_d_psi: J_bbl_d_psi,
        aquifer_total_compressibility_psi: g.ct_psi,
      },
      solver_method: 'havlena_odeh',
      pvt_source: 'lab_table',
      pvt_correlations: {
        pb_rs_bo: 'standing',
        oil_viscosity: 'beggs_robinson',
        z_factor: 'hall_yarborough',
        water: 'mccain',
        gas_viscosity: 'lee_gonzalez_eakin',
      },
      excluded_timesteps: [],
      production_data,
    } as any);

    expectClose((result.estimated_ooip_stb ?? 0) / 1e6, 312, 0.10);
    expect(result.final_drive_index_sum).toBeGreaterThanOrEqual(0.95);
    expect(result.final_drive_index_sum).toBeLessThanOrEqual(1.05);
    expect(result.final_wdi).toBeGreaterThanOrEqual(0.30);
    expect(result.r_squared).toBeGreaterThanOrEqual(0.85);
  });
});

// ============================================================================
// GATE 3 — Ahmed Example 11-1: combination drive + m>0 pot round trip
// ============================================================================

describe('GATE 3: Ahmed Ex. 11-1 combination drive', () => {
  const fx = loadFixture('ahmed-ex-11-1-combination.json');
  const g = fx.given;

  const termInputs = {
    fluid_system: 'oil',
    initial_pressure_psia: g.pi_psia,
    bubble_point_psia: g.pi_psia,
    reservoir_temperature_f: g.temp_f,
    initial_water_saturation: g.Swi,
    formation_compressibility_psi: g.cf_psi,
    water_compressibility_psi: g.cw_psi,
    oil_gravity_api: 35,
    gas_specific_gravity: g.gas_sg,
    gas_cap_ratio_m: g.m,
    aquifer_model: 'pot',
    production_data: [
      {
        timestep_index: 0, pressure_psia: g.pi_psia, cum_oil_stb: 0, cum_gas_scf: 0,
        cum_water_stb: 0, bo_rb_stb: g.pvt.at_3000.Bo, rs_scf_stb: g.pvt.at_3000.Rs,
        bg_rb_scf: g.pvt.at_3000.Bg_rb_scf, bw_rb_stb: g.pvt.at_3000.Bw,
      },
      {
        timestep_index: 1, pressure_psia: g.p2_psia, cum_oil_stb: g.Np_stb, cum_gas_scf: g.Gp_scf,
        cum_water_stb: g.Wp_stb, bo_rb_stb: g.pvt.at_2800.Bo, rs_scf_stb: g.pvt.at_2800.Rs,
        bg_rb_scf: g.pvt.at_2800.Bg_rb_scf, bw_rb_stb: g.pvt.at_2800.Bw,
      },
    ],
  } as any;

  it('X-1..X-8: combined-MBE terms and printed drive indexes', () => {
    const { per_timestep } = computeOilPerTimestep(termInputs);
    const r = per_timestep[1];
    const N = g.N_stb;
    const WpBw = g.Wp_stb * g.pvt.at_2800.Bw;
    const A_rb = r.F_rb - WpBw;
    expectClose(A_rb, fx.printed.A_rb, 0.003);
    const We_backcalc = r.F_rb - N * r.Et_rb;
    expectClose(We_backcalc, fx.printed.We_bbl, 0.015);
    const N_Efw = N * r.Efw_rb;
    expectClose(N_Efw, fx.printed.We_neglecting_efw_bbl - fx.printed.We_bbl, 0.02);
    const DDI = (N * (r.Eo_rb_stb ?? 0)) / A_rb;
    const SDI_gascap = (N * g.m * (r.Eg_rb_stb ?? 0)) / A_rb;
    const WDI = (We_backcalc - WpBw) / A_rb;
    const EDI = N_Efw / A_rb;
    expectClose(DDI, fx.printed.DDI, 0.01);
    expectClose(SDI_gascap, fx.printed.SDI_gascap, 0.01);
    expectClose(WDI, fx.printed.WDI, 0.02);
    expectClose(EDI, fx.printed.EDI, 0.10);
    expect(Math.abs(DDI + SDI_gascap + WDI + EDI - 1.0)).toBeLessThanOrEqual(1e-9);
  });

  it('X-9..X-12: m>0 pot regression recovers a synthetic truth exactly', () => {
    const N_truth = 1.0e7;
    const m_truth = 0.25;
    const W_truth_rb = 5.0e8;
    const cwcf = g.cw_psi + g.cf_psi;
    const pressures = [3000, 2950, 2900, 2850, 2800, 2750, 2700, 2650, 2600];
    const pvtAt = (p: number) => {
      const t = (3000 - p) / 200;
      return {
        Bo: g.pvt.at_3000.Bo + t * (g.pvt.at_2800.Bo - g.pvt.at_3000.Bo),
        Rs: g.pvt.at_3000.Rs + t * (g.pvt.at_2800.Rs - g.pvt.at_3000.Rs),
        Bg: g.pvt.at_3000.Bg_rb_scf + t * (g.pvt.at_2800.Bg_rb_scf - g.pvt.at_3000.Bg_rb_scf),
      };
    };
    const skeleton = {
      ...termInputs,
      production_data: pressures.map((p, i) => {
        const pvt = pvtAt(p);
        return {
          timestep_index: i, pressure_psia: p, cum_oil_stb: 0, cum_gas_scf: 0, cum_water_stb: 0,
          bo_rb_stb: pvt.Bo, rs_scf_stb: pvt.Rs, bg_rb_scf: pvt.Bg, bw_rb_stb: 1.0,
        };
      }),
    } as any;
    const { per_timestep: termRows } = computeOilPerTimestep(skeleton);
    const Rsi_truth = g.pvt.at_3000.Rs;
    const synthetic_rows = pressures.map((p, i) => {
      if (i === 0) return skeleton.production_data[0];
      const tr = termRows[i];
      const F_target = N_truth * tr.Et_rb + cwcf * W_truth_rb * tr.delta_p_psi;
      const pvt = pvtAt(p);
      const Bt = pvt.Bo + pvt.Bg * (Rsi_truth - pvt.Rs);
      const Np = F_target / Bt;
      return { ...skeleton.production_data[i], cum_oil_stb: Np, cum_gas_scf: Np * Rsi_truth };
    });
    const synResult = computeMaterialBalance({
      ...skeleton, gas_cap_ratio_m: m_truth, production_data: synthetic_rows,
    } as any);
    expectClose(synResult.estimated_ooip_stb ?? 0, N_truth, 1e-6);
    expectClose(synResult.aquifer_owip_rb ?? 0, W_truth_rb, 1e-5);
    expect(synResult.r_squared).toBeGreaterThanOrEqual(0.999999);
    const stillWarns = (synResult.warnings ?? []).some((w: string) => w.includes('not yet validated'));
    expect(stillWarns).toBe(false);
  });
});
