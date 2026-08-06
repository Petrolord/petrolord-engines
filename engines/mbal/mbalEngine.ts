/**
 * Reservoir Balance — Material Balance Engine
 * ============================================
 * 
 * Path in repo: supabase/functions/_shared/mbal-engine.ts
 * 
 * Pure compute library. No I/O, no Supabase imports, no side effects.
 * Imported by:
 *   - Edge Function `calculate-mbal` (Phase 2)
 *   - Validation harness `tools/validation/mbal-validation.ts` (Phase 1)
 * 
 * Scope: docs/scope/ReservoirBalance.md
 * 
 * Phase 1 status:
 *   - Gas reservoir MBE: implemented and will be validated
 *   - Oil reservoir MBE: implemented but unvalidated (Phase 5 validates)
 *   - PVT correlations: Standing/Beggs-Robinson for oil, Hall-Yarborough z for gas
 *   - Aquifer models: Pot aquifer only (Phase 2-3 add Fetkovich, Carter-Tracy)
 *   - Solver: linear regression (no aquifer history matching yet)
 * 
 * Validation case: Pletcher SPE 75354 Two-Cell Gas-Simulation Model
 *   Known: True OGIP = 100.8 Bcf, Aquifer W = 74.5 MM res bbl
 *   Tolerance: OGIP ±2%, W ±10%, drive index sum 1.00±0.05
 * 
 * Unit conventions (field units throughout):
 *   Pressure:        psia
 *   Oil volume:      STB
 *   Gas volume:      scf (or Mscf where noted; converted internally)
 *   Water volume:    STB (or res bbl for influx; converted internally)
 *   Bo:              RB/STB     (reservoir barrels per stock tank barrel)
 *   Bg:              RB/Mscf    (CRITICAL: Mscf NOT scf — matches Pletcher Table 3)
 *   Bw:              RB/STB
 *   Rs, Rp:          scf/STB
 *   Compressibility: 1/psi
 *   Temperature:     °F (converted to °R for gas calcs)
 *   API gravity:     °API
 *   Gas sg:          dimensionless (ratio to air at standard conditions)
 * 
 * Internal computation volumes: reservoir barrels (res bbl) for all phase volumes.
 */

// MB5 (2026-07-18): the pressure history match minimizes observed-vs-simulated
// pressure residuals with the shared Levenberg-Marquardt kernel. lm.ts is
// pure compute (a jest-pinned port of the client WTA kernel), so the
// no-I/O/no-Supabase contract above still holds.
import { levenbergMarquardt } from './lm.ts';

// ============================================================================
// TYPE DEFINITIONS — public interface
// ============================================================================

export type FluidSystem = 'oil' | 'gas' | 'oil_with_gas_cap';

export type AquiferModel = 'none' | 'pot' | 'fetkovich' | 'carter_tracy';

export type SolverMethod =
  | 'havlena_odeh'        // F vs Et regression (oil) or F/Eg vs deltaP/Eg (gas pot aquifer)
  | 'p_over_z'            // Gas reservoir, no aquifer
  | 'p_over_z_modified'   // Gas reservoir with cf correction (Ramagost-Farshad)
  | 'pot_aquifer_plot';   // Gas reservoir with pot aquifer (Pletcher Eq. 13)

export interface PVTCorrelations {
  pb_rs_bo: 'standing' | 'vasquez_beggs' | 'glaso';
  oil_viscosity: 'beggs_robinson' | 'beal_standing' | 'beal_cook_spillman';
  z_factor: 'hall_yarborough' | 'dranchuk_abou_kassem';
  water: 'mccain';
  gas_viscosity: 'lee_gonzalez_eakin';
}

export interface ProductionDataPoint {
  timestep_index: number;
  pressure_psia: number;
  // ISO date string (e.g. "2024-05-15"). Required for Fetkovich and Carter-Tracy
  // aquifer models, which need Δt between timesteps. Optional for pot aquifer
  // and no-aquifer models. The engine extracts Δt in days when it needs it.
  observation_date?: string;
  cum_oil_stb?: number;
  cum_gas_scf?: number;
  cum_water_stb?: number;
  cum_water_inj_stb?: number;
  cum_gas_inj_scf?: number;
  // Optional lab PVT (if provided, used directly; otherwise correlations compute these)
  bo_rb_stb?: number;
  rs_scf_stb?: number;
  bg_rb_mscf?: number;
  bg_rb_scf?: number;   // MB1: RB/scf alternative, honored since 2026-07-18
  bw_rb_stb?: number;
  z_factor?: number;
  // Optional observed water influx (for validation against simulator data; null in real cases)
  observed_we_rb?: number;
}

export interface MBALInputs {
  // Case identity
  fluid_system: FluidSystem;
  has_aquifer: boolean;
  has_gas_cap: boolean;

  // Initial conditions
  initial_pressure_psia: number;
  reservoir_temperature_f: number;
  initial_water_saturation: number;          // Fraction 0-1
  bubble_point_psia?: number;                 // Oil cases

  // Fluid properties (for correlations)
  oil_gravity_api?: number;                   // Oil cases
  gas_specific_gravity?: number;              // Gas + oil-with-gas-cap cases
  water_salinity_ppm?: number;

  // Rock properties
  formation_compressibility_psi: number;     // cf
  water_compressibility_psi: number;          // cw

  // Aquifer (if has_aquifer)
  aquifer_model: AquiferModel;
  aquifer_params?: {
    initial_aquifer_water_in_place_rb?: number;  // W, for pot aquifer (or Fetkovich Wei)
    aquifer_pi_rb_d_psi?: number;                 // Fetkovich PI (Phase 2+)
    aquifer_total_compressibility_psi?: number;   // ct, Fetkovich (Phase 2+)
    radius_ratio?: number;                        // re/rR for Carter-Tracy (Phase 3+)
    aquifer_thickness_ft?: number;                // Carter-Tracy (Phase 3+)
    aquifer_porosity?: number;                    // Carter-Tracy (Phase 3+)
    aquifer_permeability_md?: number;             // Carter-Tracy (Phase 3+)
    theta_degrees?: number;                       // Angle of aquifer (Phase 3+)
    aquifer_radius_ft?: number;                   // r_R at the OWC (Phase 5)
    aquifer_water_viscosity_cp?: number;          // mu_w override (Phase 5)
    // MB1 (2026-07-18): optional inputs the McCain-default chain derives from.
    reservoir_area_acres?: number;                // A; default r_R = sqrt(A/(pi*f))
    water_salinity_ppm?: number;                  // TDS for McCain mu_w default
  };

  // Gas cap (if has_gas_cap)
  gas_cap_ratio_m?: number;                   // m = initial gas cap / initial oil volume

  // PVT configuration
  pvt_source: 'correlated' | 'lab_table' | 'mixed';
  pvt_correlations: PVTCorrelations;

  // Capsule 4C chunk (b): Standalone PVT lab table.
  // When provided, the engine interpolates PVT properties at each timestep's
  // pressure rather than (or in addition to) calling correlations.
  //
  // Precedence chain at each timestep's pressure:
  //   1. Per-row PVT in production_data (bo_rb_stb, rs_scf_stb, etc.) — most specific
  //   2. Lab table interpolation at the row's pressure — if pvt_lab_table is provided
  //   3. Correlation fallback (Standing/HY/McCain/etc) — least specific
  //
  // The table must be sorted by pressure ascending. Pressures outside the
  // table's range fall through to correlation (and emit a warning).
  pvt_lab_table?: PvtLabTableRow[];

  // Solver
  solver_method: SolverMethod;
  excluded_timesteps?: number[];

  // Production history (sorted by timestep_index ascending; index 0 = initial)
  production_data: ProductionDataPoint[];
}

/**
 * One row of a lab-measured PVT table at a specific pressure point.
 * Used in MBALInputs.pvt_lab_table for the lab-table interpolation path.
 *
 * Units:
 *   pressure_psia    — psia
 *   bo_rb_stb        — RB/STB
 *   rs_scf_stb       — scf/STB
 *   bg_rb_mscf       — RB/Mscf (display unit)
 *   z_factor         — dimensionless
 *   bw_rb_stb        — RB/STB
 *   oil_viscosity_cp — cP
 *   gas_viscosity_cp — cP
 *
 * All fields except pressure_psia are optional; the engine interpolates only
 * fields present at both the bracketing pressure rows.
 */
export interface PvtLabTableRow {
  pressure_psia: number;
  bo_rb_stb?: number;
  rs_scf_stb?: number;
  bg_rb_mscf?: number;
  z_factor?: number;
  bw_rb_stb?: number;
  oil_viscosity_cp?: number;
  gas_viscosity_cp?: number;
}

export interface PerTimestepResult {
  timestep_index: number;
  pressure_psia: number;
  delta_p_psi: number;          // pi - p
  // PVT
  bo_rb_stb?: number;
  rs_scf_stb?: number;
  bg_rb_scf?: number;            // INTERNAL: bg in RB/scf (NOT Mscf)
  bg_rb_mscf?: number;           // For display: bg in RB/Mscf
  bw_rb_stb?: number;
  z_factor?: number;
  // Underground withdrawal
  F_rb: number;                  // Cumulative reservoir voidage, res bbl
  // Expansion terms
  Eo_rb_stb?: number;            // Oil expansion (oil cases)
  Eg_rb_mscf?: number;           // Gas expansion (gas cases) — RB/Mscf
  Eg_rb_stb?: number;            // Gas-cap expansion (oil with gas cap)
  Efw_rb: number;                // Formation+water expansion
  Et_rb: number;                 // Total expansion
  // Aquifer
  We_rb?: number;                 // Cumulative water influx, res bbl
  // p/z (gas)
  p_over_z?: number;
  // Drive indices
  ddi?: number;
  gdi?: number;
  wdi?: number;
  cdi?: number;                  // Formation+water compressibility drive (gas)
  sdi?: number;                  // Segregation drive (oil)
  drive_index_sum?: number;
}

export interface MBALResult {
  // Headline regression results
  estimated_ooip_stb?: number;
  estimated_ogip_scf?: number;
  r_squared: number;
  regression_slope: number;
  regression_intercept: number;
  n_data_points: number;

  // Aquifer
  aquifer_owip_rb?: number;
  aquifer_cumulative_we_rb?: number;
  aquifer_fit_quality?: number;

  // Drive indices at final timestep
  final_ddi?: number;
  final_gdi?: number;
  final_wdi?: number;
  final_sdi?: number;
  final_cdi?: number;
  final_drive_index_sum?: number;

  // Diagnostics
  drive_mechanism: string;
  aquifer_strength: string;
  warnings: string[];

  // Validation tier — structural confidence in this engine path.
  //   'benchmark_verified'  = Implementation has been tested against a
  //                           published worked example and matches within the
  //                           stated tolerance. The reference case is recorded
  //                           for traceability.
  //   'published_method'    = Implementation follows a recognized peer-reviewed
  //                           or industry-standard formulation. The workflow
  //                           includes documented assumptions, internal checks,
  //                           and calculation traceability.
  //   'engineering_basis'   = Implementation follows established reservoir
  //                           engineering principles where a suitable public
  //                           worked example is not available. The method is
  //                           documented, traceable, and ready for engineering
  //                           use within stated assumptions.
  // Distinct from `warnings`, which carries runtime issues (R² low, drive
  // index sum off, etc.). Tier describes the method; warnings describe the run.
  validation_tier: 'benchmark_verified' | 'published_method' | 'engineering_basis';
  validation_reference?: string;
  validation_tolerance_pct?: number;

  // Time-series for plotting
  per_timestep: PerTimestepResult[];

  // Engine metadata
  engine_version: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ENGINE_VERSION = '1.0.0-phase1';
const MSCF_PER_SCF = 0.001;
const SCF_PER_MSCF = 1000;

// ============================================================================
// PVT CORRELATIONS
// ============================================================================

/**
 * Standing's correlation for oil bubble-point pressure.
 * Reference: Standing, M.B. (1947). Returns Pb in psia.
 */
function standingPb(rs: number, gas_sg: number, api: number, temp_f: number): number {
  // Standing 1947: Pb = 18.2 * [(Rs/gas_sg)^0.83 * 10^(0.00091*T - 0.0125*API) - 1.4]
  const exponent = 0.00091 * temp_f - 0.0125 * api;
  const term = Math.pow(rs / gas_sg, 0.83) * Math.pow(10, exponent);
  return 18.2 * (term - 1.4);
}

/**
 * Standing's correlation for solution gas-oil ratio (Rs) below bubble point.
 * Reference: Standing, M.B. (1947). Returns Rs in scf/STB.
 */
function standingRs(p: number, pb: number, gas_sg: number, api: number, temp_f: number): number {
  // If above bubble point, Rs = Rsb (constant); caller handles that case.
  // Rs = gas_sg * [(p / 18.2 + 1.4) * 10^(0.0125*API - 0.00091*T)]^(1/0.83)
  const exponent = 0.0125 * api - 0.00091 * temp_f;
  const inner = (p / 18.2 + 1.4) * Math.pow(10, exponent);
  return gas_sg * Math.pow(inner, 1.0 / 0.83);
}

/**
 * Standing's correlation for oil formation volume factor at and below bubble point.
 * Reference: Standing, M.B. (1947). Returns Bo in RB/STB.
 */
function standingBoSat(rs: number, gas_sg: number, oil_sg: number, temp_f: number): number {
  // Bo = 0.972 + 0.000147 * F^1.175
  // F = Rs * (gas_sg / oil_sg)^0.5 + 1.25 * T
  const F = rs * Math.sqrt(gas_sg / oil_sg) + 1.25 * temp_f;
  return 0.972 + 0.000147 * Math.pow(F, 1.175);
}

/**
 * Hall-Yarborough gas compressibility (z) factor.
 * Reference: Hall, K.R. and Yarborough, L. (1973).
 * Uses Newton-Raphson on the reduced density y.
 * Inputs: pseudo-reduced pressure ppr, pseudo-reduced temperature tpr.
 * Returns z (dimensionless).
 */
function hallYarboroughZ(ppr: number, tpr: number): number {
  const t = 1.0 / tpr;
  const A = 0.06125 * t * Math.exp(-1.2 * Math.pow(1 - t, 2));
  // Solve F(y) = 0 for y by Newton-Raphson:
  //   F(y) = -A*ppr + (y + y^2 + y^3 - y^4)/(1-y)^3
  //          - (14.76*t - 9.76*t^2 + 4.58*t^3) * y^2
  //          + (90.7*t - 242.2*t^2 + 42.4*t^3) * y^(2.18 + 2.82*t)
  let y = 0.001;
  for (let iter = 0; iter < 50; iter++) {
    const oneMinusY = 1 - y;
    const denom = Math.pow(oneMinusY, 3);
    const F =
      -A * ppr +
      (y + y * y + y * y * y - y * y * y * y) / denom -
      (14.76 * t - 9.76 * t * t + 4.58 * t * t * t) * y * y +
      (90.7 * t - 242.2 * t * t + 42.4 * t * t * t) *
        Math.pow(y, 2.18 + 2.82 * t);
    const dF =
      (1 + 4 * y + 4 * y * y - 4 * y * y * y + y * y * y * y) /
        Math.pow(oneMinusY, 4) -
      2 * (14.76 * t - 9.76 * t * t + 4.58 * t * t * t) * y +
      (90.7 * t - 242.2 * t * t + 42.4 * t * t * t) *
        (2.18 + 2.82 * t) *
        Math.pow(y, 1.18 + 2.82 * t);
    const dy = F / dF;
    y -= dy;
    if (Math.abs(dy) < 1e-10) break;
    if (y < 0) y = 0.001;
  }
  return A * ppr / y;
}

/**
 * Compute gas formation volume factor Bg in RB/scf from pressure, temperature, and z.
 * 
 * Bg = z * T * Psc / (Tsc * p) ... in res ft^3 / scf at standard conditions (Tsc=520°R, Psc=14.7psia)
 * Bg [res ft^3/scf] = 0.02827 * z * T(°R) / p(psia)
 * Bg [res bbl/scf]  = 0.02827 / 5.615 * z * T / p = 0.005035 * z * T / p
 * Bg [res bbl/Mscf] = 5.035 * z * T / p
 * 
 * Returns Bg in RB/scf (internal unit).
 */
function bgRbPerScf(p_psia: number, temp_f: number, z: number): number {
  const temp_r = temp_f + 459.67;
  return 0.005035 * z * temp_r / p_psia;
}

/**
 * Compute water FVF using simple correlation.
 * McCain's correlation is the proper one; for Phase 1 we use a simple linear approximation
 * sufficient for validation. Pletcher's Table 3 has Bw rising from 1.0452 to 1.0571
 * over a pressure decline of 6411 to 2638 psia — a ~1.1% rise.
 * Linear interpolation: Bw ≈ Bwi * (1 + cw_apparent * (pi - p))
 * For Phase 1 we accept Bw as input from production_data or assume 1.0 if absent.
 * (Phase 2 implements McCain properly.)
 */
function bwApprox(bwi: number, p: number, pi: number, cw: number): number {
  return bwi * (1 + cw * (pi - p));
}

// ============================================================================
// CAPSULE 4C — ADDITIONAL PVT CORRELATIONS (2026-05-15)
// ============================================================================
//
// All correlations below extend the engine's PVT capability beyond Standing
// (Rs/Bo), Hall-Yarborough (z), and the simple linear bwApprox (Bw).
//
// Activation: each correlation is plumbed through computeGasMBE/computeOilMBE
// based on `inputs.pvt_correlations.{pb_rs_bo|z_factor|water}`. Default fall-
// backs remain Standing / Hall-Yarborough / bwApprox.
//
// Validity ranges: each correlation has a documented training range from its
// primary publication. `correlationValidityWarnings()` checks reservoir
// conditions against those ranges and emits structured warnings into the
// result. The engine still computes — the warnings inform the user that
// results may be outside the correlation author's intended scope.

/**
 * Vasquez-Beggs (1980) bubble-point pressure Pb.
 *
 * Reference: Vasquez, M.E. & Beggs, H.D., "Correlations for Fluid Physical
 * Property Prediction," JPT June 1980, pp. 968-970 (SPE 6719).
 *
 * Splits coefficients by API gravity at 30°. Uses separator-corrected gas
 * gravity (we approximate this as the produced gas gravity; for highest
 * accuracy a separator-condition correction can be applied — deferred to
 * Phase 5+ if user feedback indicates need).
 *
 * Inputs: rs (scf/STB), gas_sg (air=1), api (°API), temp_f (°F).
 * Returns: Pb (psia).
 */
function vasquezBeggsPb(rs: number, gas_sg: number, api: number, temp_f: number): number {
  // Coefficient set by API gravity
  let C1: number, C2: number, C3: number;
  if (api <= 30) {
    C1 = 0.0362;
    C2 = 1.0937;
    C3 = 25.7240;
  } else {
    C1 = 0.0178;
    C2 = 1.1870;
    C3 = 23.9310;
  }
  const tempR = temp_f + 459.67;
  // Pb = ( Rs / (C1 * gas_sg * exp(C3 * api / (temp_f + 460))) )^(1/C2)
  const inner = rs / (C1 * gas_sg * Math.exp(C3 * api / tempR));
  return Math.pow(inner, 1 / C2);
}

/**
 * Vasquez-Beggs (1980) solution GOR Rs.
 *
 * Inputs: p (psia, must be ≤ Pb for saturated computation), pb (psia),
 *         gas_sg, api, temp_f.
 * Returns: Rs (scf/STB).
 */
function vasquezBeggsRs(p: number, pb: number, gas_sg: number, api: number, temp_f: number): number {
  let C1: number, C2: number, C3: number;
  if (api <= 30) {
    C1 = 0.0362;
    C2 = 1.0937;
    C3 = 25.7240;
  } else {
    C1 = 0.0178;
    C2 = 1.1870;
    C3 = 23.9310;
  }
  const tempR = temp_f + 459.67;
  const p_use = Math.min(p, pb);  // saturate at Pb
  // Rs = C1 * gas_sg * P^C2 * exp(C3 * api / (T + 460))
  return C1 * gas_sg * Math.pow(p_use, C2) * Math.exp(C3 * api / tempR);
}

/**
 * Vasquez-Beggs (1980) saturated oil FVF Bob.
 *
 * Inputs: rs (scf/STB at p), gas_sg, api, temp_f.
 * Returns: Bo at saturated conditions (RB/STB).
 */
function vasquezBeggsBoSat(rs: number, gas_sg: number, api: number, temp_f: number): number {
  let A1: number, A2: number, A3: number;
  if (api <= 30) {
    A1 = 4.677e-4;
    A2 = 1.751e-5;
    A3 = -1.811e-8;
  } else {
    A1 = 4.670e-4;
    A2 = 1.100e-5;
    A3 = 1.337e-9;
  }
  // Bo = 1 + A1*Rs + (T - 60) * (api/gas_sg) * (A2 + A3*Rs)
  return 1.0 + A1 * rs + (temp_f - 60) * (api / gas_sg) * (A2 + A3 * rs);
}

/**
 * Glaso (1980) bubble-point pressure Pb.
 *
 * Reference: Glaso, O., "Generalized Pressure-Volume-Temperature Correlations,"
 * JPT May 1980, pp. 785-795 (SPE 8013).
 *
 * Developed for North Sea crude oils but widely applied where the API and
 * temperature ranges match. Niger Delta crudes typically fall within Glaso's
 * intended scope.
 *
 * Inputs: rs (scf/STB), gas_sg, api, temp_f.
 * Returns: Pb (psia).
 */
function glasoPb(rs: number, gas_sg: number, api: number, temp_f: number): number {
  // Pb* = (Rs/gas_sg)^0.816 * T^0.172 / api^0.989
  const pb_star = Math.pow(rs / gas_sg, 0.816) * Math.pow(temp_f, 0.172) / Math.pow(api, 0.989);
  // log10(Pb) = 1.7669 + 1.7447*log10(Pb*) - 0.30218*(log10(Pb*))^2
  const lpb = Math.log10(pb_star);
  const log_pb = 1.7669 + 1.7447 * lpb - 0.30218 * lpb * lpb;
  return Math.pow(10, log_pb);
}

/**
 * Glaso (1980) solution GOR Rs.
 *
 * Solves Glaso's Pb correlation in reverse for Rs at a given pressure.
 *
 * Inputs: p (psia), pb (psia), gas_sg, api, temp_f.
 * Returns: Rs (scf/STB).
 */
function glasoRs(p: number, pb: number, gas_sg: number, api: number, temp_f: number): number {
  const p_use = Math.min(p, pb);
  // Invert: log10(Pb*) from log10(p_use) using quadratic
  // log10(p) = 1.7669 + 1.7447*x - 0.30218*x^2  where x = log10(Pb*)
  // Solve quadratic: -0.30218*x^2 + 1.7447*x + (1.7669 - log10(p)) = 0
  const a = -0.30218;
  const b = 1.7447;
  const c = 1.7669 - Math.log10(p_use);
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    // Fall back to small positive — shouldn't happen physically
    return 0.001;
  }
  // Take the root that gives the lower log(Pb*) (the physical one)
  const x1 = (-b + Math.sqrt(disc)) / (2 * a);
  const x2 = (-b - Math.sqrt(disc)) / (2 * a);
  const x = Math.min(x1, x2);
  const pb_star = Math.pow(10, x);
  // Solve Pb* = (Rs/gas_sg)^0.816 * T^0.172 / api^0.989 for Rs
  // Rs = gas_sg * (Pb* * api^0.989 / T^0.172)^(1/0.816)
  const inner = pb_star * Math.pow(api, 0.989) / Math.pow(temp_f, 0.172);
  return gas_sg * Math.pow(inner, 1 / 0.816);
}

/**
 * Glaso (1980) saturated oil FVF Bob.
 *
 * Inputs: rs (scf/STB at p), gas_sg, oil_sg (γo, water=1), temp_f.
 * Returns: Bo at saturated conditions (RB/STB).
 */
function glasoBoSat(rs: number, gas_sg: number, oil_sg: number, temp_f: number): number {
  // Bob* = Rs * (gas_sg/oil_sg)^0.526 + 0.968 * T
  const bob_star = rs * Math.pow(gas_sg / oil_sg, 0.526) + 0.968 * temp_f;
  // log10(Bo - 1) = -6.58511 + 2.91329*log10(Bob*) - 0.27683*(log10(Bob*))^2
  const lbs = Math.log10(bob_star);
  const log_bom1 = -6.58511 + 2.91329 * lbs - 0.27683 * lbs * lbs;
  return 1.0 + Math.pow(10, log_bom1);
}

/**
 * Dranchuk-Abou-Kassem (1975) z-factor.
 *
 * Reference: Dranchuk, P.M. & Abou-Kassem, J.H., "Calculation of Z Factors
 * for Natural Gases Using Equations of State," J. Cdn. Pet. Tech., 14(3),
 * July-Sept 1975.
 *
 * Alternative to Hall-Yarborough; widely regarded as more accurate at very
 * low and very high pseudo-reduced pressures (Hall-Yarborough deteriorates
 * at low Tpr below ~1.05 and at very high Ppr). Uses an 11-parameter
 * equation of state on reduced density.
 *
 * Inputs: ppr, tpr (pseudo-reduced pressure and temperature).
 * Returns: z (dimensionless).
 */
function dranchukAbouKassemZ(ppr: number, tpr: number): number {
  // 11 parameters from DAK 1975
  const A1 = 0.3265;
  const A2 = -1.0700;
  const A3 = -0.5339;
  const A4 = 0.01569;
  const A5 = -0.05165;
  const A6 = 0.5475;
  const A7 = -0.7361;
  const A8 = 0.1844;
  const A9 = 0.1056;
  const A10 = 0.6134;
  const A11 = 0.7210;

  // Newton-Raphson on reduced density ρ_r
  // f(ρ_r) = c1*ρ_r + c2*ρ_r^2 - c3*ρ_r^5 + c4*ρ_r^2*(1 + A11*ρ_r^2)*exp(-A11*ρ_r^2) + 1 - z
  // where z = 0.27*ppr / (ρ_r * tpr)
  let rho_r = 0.27 * ppr / tpr;  // initial guess from ideal-gas limit
  if (rho_r < 0.01) rho_r = 0.01;
  if (rho_r > 2.5) rho_r = 2.5;

  for (let iter = 0; iter < 50; iter++) {
    const z = 0.27 * ppr / (rho_r * tpr);
    const c1 = A1 + A2 / tpr + A3 / (tpr * tpr * tpr) + A4 / (tpr * tpr * tpr * tpr) + A5 / Math.pow(tpr, 5);
    const c2 = A6 + A7 / tpr + A8 / (tpr * tpr);
    const c3 = A9 * (A7 / tpr + A8 / (tpr * tpr));
    const c4 = A10 / (tpr * tpr * tpr);

    const exp_term = Math.exp(-A11 * rho_r * rho_r);
    const F =
      -z + 1 +
      c1 * rho_r +
      c2 * rho_r * rho_r -
      c3 * Math.pow(rho_r, 5) +
      c4 * rho_r * rho_r * (1 + A11 * rho_r * rho_r) * exp_term;

    // dF/dρ_r
    const dz_drho = -0.27 * ppr / (rho_r * rho_r * tpr);
    const dF =
      -dz_drho +
      c1 +
      2 * c2 * rho_r -
      5 * c3 * Math.pow(rho_r, 4) +
      c4 * (
        2 * rho_r * (1 + A11 * rho_r * rho_r) * exp_term +
        rho_r * rho_r * (2 * A11 * rho_r) * exp_term +
        rho_r * rho_r * (1 + A11 * rho_r * rho_r) * (-2 * A11 * rho_r) * exp_term
      );

    const drho = F / dF;
    rho_r -= drho;
    if (rho_r <= 0) rho_r = 0.001;
    if (Math.abs(drho) < 1e-10) break;
  }
  return 0.27 * ppr / (rho_r * tpr);
}

/**
 * McCain (1990) water formation volume factor Bw.
 *
 * Reference: McCain, W.D. Jr., *The Properties of Petroleum Fluids*,
 * 2nd ed., PennWell, 1990. Bw correlation pp. 514-516.
 *
 * Accounts for pressure (compressibility) and temperature (thermal
 * expansion) contributions to water FVF. Treats brine salinity implicitly
 * via the pure-water baseline (salinity correction is small and deferred
 * to user feedback).
 *
 * Inputs: p (psia), temp_f (°F).
 * Returns: Bw (RB/STB).
 */
function mccainBw(p: number, temp_f: number): number {
  // Volumetric change due to temperature
  const dVwT =
    -1.0001e-2 +
    1.33391e-4 * temp_f +
    5.50654e-7 * temp_f * temp_f;
  // Volumetric change due to pressure
  const dVwP =
    -1.95301e-9 * p * temp_f -
    1.72834e-13 * p * p * temp_f -
    3.58922e-7 * p -
    2.25341e-10 * p * p;
  // Bw = (1 + dVwP) * (1 + dVwT)
  return (1 + dVwP) * (1 + dVwT);
}

/**
 * McCain (1991) water viscosity correlation.
 *
 * mu_w1 = A * T^B at atmospheric pressure, with A and B polynomial in
 * salinity S (weight percent solids), then a pressure correction:
 *   mu_w = mu_w1 * (0.9994 + 4.0295e-5 p + 3.1062e-9 p^2)
 *
 * Validity (McCain, The Properties of Petroleum Fluids, 2nd ed.):
 * 100-400 F, S up to ~26 wt%, p up to ~10,000 psia.
 *
 * Inputs: p (psia), temp_f (F), salinity_ppm (TDS; 0 for fresh water).
 * Returns: mu_w (cp).
 *
 * MB1 (2026-07-18): used as the Carter-Tracy mu_w default when
 * aquifer_params.aquifer_water_viscosity_cp is not supplied.
 */
function mccainMuW(p: number, temp_f: number, salinity_ppm = 0): number {
  const S = salinity_ppm / 10_000; // ppm -> weight percent
  const A = 109.574 - 8.40564 * S + 0.313314 * S * S + 8.72213e-3 * S * S * S;
  const B = -1.12166 + 2.63951e-2 * S - 6.79461e-4 * S * S
    - 5.47119e-5 * S * S * S + 1.55586e-6 * S * S * S * S;
  const muw1 = A * Math.pow(temp_f, B);
  return muw1 * (0.9994 + 4.0295e-5 * p + 3.1062e-9 * p * p);
}

/**
 * Validity-range warning helper.
 *
 * For each PVT correlation selected by the user, check the reservoir
 * conditions against the correlation's documented training range from its
 * primary publication. Emit a structured warning string for each violation
 * (one warning per correlation, summarizing which parameters are out of range).
 *
 * Returns an array of warning strings to be appended to result.warnings.
 *
 * Reference for ranges:
 *   Vasquez-Beggs (1980 SPE 6719) Table 1: 50 ≤ p ≤ 5250 psia; 75 ≤ T ≤ 294 °F;
 *     20 ≤ Rs ≤ 2199 scf/STB; 15.3 ≤ api ≤ 59.5 °API; 0.511 ≤ γg ≤ 1.351
 *   Glaso (1980 SPE 8013): 150 ≤ p ≤ 7127 psia; 80 ≤ T ≤ 280 °F;
 *     90 ≤ Rs ≤ 2637 scf/STB; 22.3 ≤ api ≤ 48.1 °API; 0.65 ≤ γg ≤ 1.276
 *   Dranchuk-Abou-Kassem (1975): 0.2 ≤ Ppr ≤ 30; 1.0 ≤ Tpr ≤ 3.0
 *   Hall-Yarborough (1973): 0 ≤ Ppr ≤ 24.9; 1.2 ≤ Tpr ≤ 3.0
 *   McCain Bw (1990): pure water/light brine; deteriorates above 200000 ppm TDS
 */
function correlationValidityWarnings(
  pb_rs_bo: 'standing' | 'vasquez_beggs' | 'glaso',
  z_factor: 'hall_yarborough' | 'dranchuk_abou_kassem',
  water: 'mccain',
  conditions: {
    pi: number;
    temp_f: number;
    api?: number;
    gas_sg?: number;
    ppr_max?: number;
    tpr?: number;
  },
): string[] {
  const warnings: string[] = [];

  // Vasquez-Beggs
  if (pb_rs_bo === 'vasquez_beggs') {
    const violations: string[] = [];
    if (conditions.pi > 5250) violations.push(`pressure ${conditions.pi.toFixed(0)} psia exceeds the upper bound of 5250 psia`);
    if (conditions.temp_f < 75 || conditions.temp_f > 294) violations.push(`temperature ${conditions.temp_f.toFixed(0)} °F is outside the 75-294 °F range`);
    if (conditions.api != null) {
      if (conditions.api < 15.3) violations.push(`API ${conditions.api.toFixed(1)} ° is below the 15.3 °API lower bound`);
      if (conditions.api > 59.5) violations.push(`API ${conditions.api.toFixed(1)} ° exceeds the 59.5 °API upper bound`);
    }
    if (conditions.gas_sg != null) {
      if (conditions.gas_sg < 0.511 || conditions.gas_sg > 1.351) violations.push(`gas SG ${conditions.gas_sg.toFixed(3)} is outside the 0.511-1.351 range`);
    }
    if (violations.length > 0) {
      warnings.push(
        `Vasquez-Beggs (Rs/Bo) correlation: reservoir conditions outside the correlation's training range — ${violations.join('; ')}. ` +
        `Engine continues to compute, but treat results as extrapolations beyond the correlation author's intended scope.`,
      );
    }
  }

  // Glaso
  if (pb_rs_bo === 'glaso') {
    const violations: string[] = [];
    if (conditions.pi < 150 || conditions.pi > 7127) violations.push(`pressure ${conditions.pi.toFixed(0)} psia is outside the 150-7127 psia range`);
    if (conditions.temp_f < 80 || conditions.temp_f > 280) violations.push(`temperature ${conditions.temp_f.toFixed(0)} °F is outside the 80-280 °F range`);
    if (conditions.api != null) {
      if (conditions.api < 22.3 || conditions.api > 48.1) violations.push(`API ${conditions.api.toFixed(1)} ° is outside the 22.3-48.1 °API range`);
    }
    if (conditions.gas_sg != null) {
      if (conditions.gas_sg < 0.65 || conditions.gas_sg > 1.276) violations.push(`gas SG ${conditions.gas_sg.toFixed(3)} is outside the 0.65-1.276 range`);
    }
    if (violations.length > 0) {
      warnings.push(
        `Glaso (Rs/Bo) correlation: reservoir conditions outside the correlation's training range — ${violations.join('; ')}. ` +
        `Glaso was developed primarily for North Sea crudes; results outside the stated range may not reflect the correlation author's intended scope.`,
      );
    }
  }

  // Dranchuk-Abou-Kassem
  if (z_factor === 'dranchuk_abou_kassem') {
    const violations: string[] = [];
    if (conditions.ppr_max != null && conditions.ppr_max > 30) violations.push(`Ppr ${conditions.ppr_max.toFixed(2)} exceeds the upper bound of 30`);
    if (conditions.tpr != null) {
      if (conditions.tpr < 1.0) violations.push(`Tpr ${conditions.tpr.toFixed(3)} is below the lower bound of 1.0 (correlation may not converge or may give negative z)`);
      if (conditions.tpr > 3.0) violations.push(`Tpr ${conditions.tpr.toFixed(2)} exceeds the upper bound of 3.0`);
    }
    if (violations.length > 0) {
      warnings.push(
        `Dranchuk-Abou-Kassem z-factor correlation: reservoir conditions outside the correlation's training range — ${violations.join('; ')}. ` +
        `For Tpr below 1.0 (near-critical and below), consider an alternative formulation.`,
      );
    }
  }

  // Hall-Yarborough (the default — also has bounds)
  if (z_factor === 'hall_yarborough') {
    if (conditions.tpr != null && conditions.tpr < 1.2) {
      warnings.push(
        `Hall-Yarborough z-factor correlation: Tpr ${conditions.tpr.toFixed(3)} is below the documented 1.2 lower bound. ` +
        `Consider switching to Dranchuk-Abou-Kassem for better accuracy near the critical temperature.`,
      );
    }
  }

  // McCain Bw — currently the only water FVF correlation, so the choice is implicit
  // No external salinity input today; deferred to user feedback.

  return warnings;
}

// ============================================================================
// CAPSULE 4C CHUNK (b) — VISCOSITY CORRELATIONS (2026-05-15)
// ============================================================================
//
// Viscosity correlations do not feed the MBAL math directly. They surface
// in the PVT preview table for users to see, and prepare the engine for
// Phase 5+ consumers (Carter-Tracy water viscosity, forecast math).
//
// Chain at any pressure:
//   - Above bubble point (or no Pb): μ_o = undersaturated correction on μ_o(Pb)
//   - At bubble point: μ_o = Beggs-Robinson(μ_od, Rsb)
//   - Below bubble point: μ_o = Beggs-Robinson(μ_od, Rs(p))
//   - μ_od always from Beal (1946) / Standing
//   - μ_g from Lee-Gonzalez-Eakin (1966)

/**
 * Beal (1946) / Standing dead-oil viscosity μ_od.
 *
 * Reference: Beal, C., "The Viscosity of Air, Water, Natural Gas, Crude Oil
 * and Its Associated Gases at Oil Field Temperatures and Pressures,"
 * Trans. AIME 165 (1946) 94-115. As tabulated in Standing, M.B.,
 * *Volumetric and Phase Behavior of Oil Field Hydrocarbon Systems*, 1947.
 *
 * Form widely cited (e.g. Bradley *Petroleum Engineering Handbook*):
 *   μ_od = (0.32 + 1.8e7 / api^4.53) · (360 / (T + 200))^A
 *   where A = 10^(0.43 + 8.33/api)
 *
 * Inputs: api (°API), temp_f (°F).
 * Returns: μ_od (cP).
 */
function bealDeadOilViscosity(api: number, temp_f: number): number {
  const A = Math.pow(10, 0.43 + 8.33 / api);
  const base = 0.32 + 1.8e7 / Math.pow(api, 4.53);
  return base * Math.pow(360 / (temp_f + 200), A);
}

/**
 * Beggs-Robinson (1975) live-oil viscosity μ_o (saturated).
 *
 * Reference: Beggs, H.D. & Robinson, J.R., "Estimating the Viscosity of
 * Crude Oil Systems," JPT September 1975, pp. 1140-1141.
 *
 * Form:
 *   μ_o = a · μ_od^b
 *   where a = 10.715 · (Rs + 100)^(-0.515)
 *         b = 5.44 · (Rs + 150)^(-0.338)
 *
 * Inputs: rs (scf/STB), mu_od (cP — typically from Beal).
 * Returns: μ_o saturated live-oil viscosity (cP).
 */
function beggsRobinsonLiveOilViscosity(rs: number, mu_od: number): number {
  const a = 10.715 * Math.pow(rs + 100, -0.515);
  const b = 5.44 * Math.pow(rs + 150, -0.338);
  return a * Math.pow(mu_od, b);
}

/**
 * Vasquez-Beggs (1980) undersaturated oil viscosity correction.
 *
 * Reference: Vasquez & Beggs 1980 (SPE 6719), as the standard
 * undersaturated extension layered on Beggs-Robinson at Pb.
 *
 * Form:
 *   μ_o = μ_ob · (p / pb)^m
 *   where m = 2.6 · p^1.187 · exp(-11.513 - 8.98e-5 · p)
 *
 * Inputs: p (psia), pb (psia), mu_ob (cP at bubble point).
 * Returns: μ_o undersaturated (cP).
 */
function vasquezBeggsUndersaturatedOilViscosity(p: number, pb: number, mu_ob: number): number {
  if (p <= pb) return mu_ob;
  const m_exp = 2.6 * Math.pow(p, 1.187) * Math.exp(-11.513 - 8.98e-5 * p);
  return mu_ob * Math.pow(p / pb, m_exp);
}

/**
 * Lee-Gonzalez-Eakin (1966) gas viscosity μ_g.
 *
 * Reference: Lee, A.L., Gonzalez, M.H. & Eakin, B.E., "The Viscosity of
 * Natural Gases," JPT August 1966, pp. 997-1000.
 *
 * Form:
 *   μ_g = 1e-4 · K · exp(X · ρ_g^Y)
 *   where K = ((9.4 + 0.02·Mg) · T^1.5) / (209 + 19·Mg + T)
 *         X = 3.5 + 986/T + 0.01·Mg
 *         Y = 2.4 - 0.2·X
 *         T = temperature in °R
 *         Mg = gas molecular weight = 28.97 · gas_sg
 *         ρ_g = gas density in g/cm³ = 0.0014935 · p · Mg / (z · T)
 *
 * Inputs: p (psia), temp_f (°F), gas_sg (air=1), z (dimensionless).
 * Returns: μ_g (cP).
 */
function leeGonzalezEakinGasViscosity(p: number, temp_f: number, gas_sg: number, z: number): number {
  const T_r = temp_f + 459.67;             // °R
  const Mg = 28.97 * gas_sg;               // gas molecular weight
  const rho_g = 0.0014935 * p * Mg / (z * T_r);  // g/cm³

  const K = ((9.4 + 0.02 * Mg) * Math.pow(T_r, 1.5)) / (209 + 19 * Mg + T_r);
  const X = 3.5 + 986 / T_r + 0.01 * Mg;
  const Y = 2.4 - 0.2 * X;

  return 1e-4 * K * Math.exp(X * Math.pow(rho_g, Y));
}

/**
 * Viscosity-correlation validity-range warnings.
 *
 * Documented ranges per primary publication:
 *   Beal (1946): 18 ≤ api ≤ 50; 100 ≤ T ≤ 220 °F
 *   Beggs-Robinson (1975): 16 ≤ api ≤ 58; 70 ≤ T ≤ 295 °F; 20 ≤ Rs ≤ 2070 scf/STB
 *   Vasquez-Beggs undersat (1980): 141 ≤ p ≤ 9515 psia
 *   Lee-Gonzalez-Eakin (1966): 100 ≤ p ≤ 8000 psia; 100 ≤ T ≤ 340 °F;
 *                              0.55 ≤ gas_sg ≤ 1.0 (no significant non-HC)
 */
function viscosityValidityWarnings(
  oil_visc: 'beggs_robinson' | 'beal_standing' | 'beal_cook_spillman',
  gas_visc: 'lee_gonzalez_eakin',
  conditions: {
    pi: number;
    temp_f: number;
    api?: number;
    gas_sg?: number;
    rs_max?: number;  // maximum Rs seen across the case (typically Rsi)
  },
): string[] {
  const warnings: string[] = [];

  // Beggs-Robinson live-oil
  if (oil_visc === 'beggs_robinson') {
    const violations: string[] = [];
    if (conditions.api != null) {
      if (conditions.api < 16 || conditions.api > 58) violations.push(`API ${conditions.api.toFixed(1)} ° is outside the 16-58 °API range`);
    }
    if (conditions.temp_f < 70 || conditions.temp_f > 295) violations.push(`temperature ${conditions.temp_f.toFixed(0)} °F is outside the 70-295 °F range`);
    if (conditions.rs_max != null && conditions.rs_max > 2070) violations.push(`maximum Rs ${conditions.rs_max.toFixed(0)} scf/STB exceeds the 2070 scf/STB upper bound`);
    if (violations.length > 0) {
      warnings.push(
        `Beggs-Robinson live-oil viscosity correlation: conditions outside the correlation's training range — ${violations.join('; ')}. ` +
        `Viscosity estimates appear in the PVT preview but do not feed the MBAL calculation today.`,
      );
    }
  }

  // Beal/Standing dead-oil — same general window as Beggs-Robinson for API
  if (oil_visc === 'beal_standing') {
    const violations: string[] = [];
    if (conditions.api != null) {
      if (conditions.api < 18 || conditions.api > 50) violations.push(`API ${conditions.api.toFixed(1)} ° is outside the Beal 18-50 °API range`);
    }
    if (conditions.temp_f < 100 || conditions.temp_f > 220) violations.push(`temperature ${conditions.temp_f.toFixed(0)} °F is outside the Beal 100-220 °F range`);
    if (violations.length > 0) {
      warnings.push(
        `Beal dead-oil viscosity correlation: conditions outside the correlation's training range — ${violations.join('; ')}.`,
      );
    }
  }

  // Lee-Gonzalez-Eakin gas viscosity
  if (gas_visc === 'lee_gonzalez_eakin') {
    const violations: string[] = [];
    if (conditions.pi < 100 || conditions.pi > 8000) violations.push(`pressure ${conditions.pi.toFixed(0)} psia is outside the 100-8000 psia range`);
    if (conditions.temp_f < 100 || conditions.temp_f > 340) violations.push(`temperature ${conditions.temp_f.toFixed(0)} °F is outside the 100-340 °F range`);
    if (conditions.gas_sg != null) {
      if (conditions.gas_sg < 0.55 || conditions.gas_sg > 1.0) violations.push(`gas SG ${conditions.gas_sg.toFixed(3)} is outside the 0.55-1.0 range`);
    }
    if (violations.length > 0) {
      warnings.push(
        `Lee-Gonzalez-Eakin gas viscosity correlation: conditions outside the correlation's training range — ${violations.join('; ')}.`,
      );
    }
  }

  return warnings;
}

// ============================================================================
// CAPSULE 4C CHUNK (b) — PVT LAB TABLE INTERPOLATION (2026-05-15)
// ============================================================================
//
// Linear interpolation across a user-supplied lab PVT table. The table is
// MBALInputs.pvt_lab_table — an array of {pressure_psia, bo_rb_stb, ...}
// rows that the lab measured. Engine looks up at each timestep's pressure.
//
// Precedence in dispatchers: per-row PVT > lab-table interpolation > correlation.
//
// Pressures outside the table's range fall through (caller falls back to
// correlation). The engine emits a one-time warning if any timestep's
// pressure falls outside the table's range.

/**
 * Find the lab-table rows bracketing a given pressure and linearly interpolate
 * the requested field.
 *
 * @param table sorted lab table (ascending by pressure_psia)
 * @param p target pressure
 * @param field which PvtLabTableRow numeric field to interpolate
 * @returns interpolated value, or null if p is outside table range or the
 *          field is missing at one of the bracketing rows
 */
function interpolateLabTable(
  table: PvtLabTableRow[] | undefined,
  p: number,
  field: keyof PvtLabTableRow,
): number | null {
  if (!table || table.length < 2) return null;
  const p_min = table[0].pressure_psia;
  const p_max = table[table.length - 1].pressure_psia;
  if (p < p_min || p > p_max) return null;

  // Binary search for bracketing rows
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid].pressure_psia <= p) lo = mid;
    else hi = mid;
  }
  const row_lo = table[lo];
  const row_hi = table[hi];
  const v_lo = row_lo[field] as number | undefined;
  const v_hi = row_hi[field] as number | undefined;
  if (v_lo == null || v_hi == null) return null;
  if (row_hi.pressure_psia === row_lo.pressure_psia) return v_lo;
  const t = (p - row_lo.pressure_psia) / (row_hi.pressure_psia - row_lo.pressure_psia);
  return v_lo + t * (v_hi - v_lo);
}

/**
 * Pre-flight check: validate a lab table's structure.
 *
 * Returns array of warning messages describing structural issues. Empty array
 * means the table is well-formed for interpolation.
 *
 * Checks:
 *   - Table has at least 2 rows
 *   - Rows are sorted ascending by pressure_psia
 *   - No duplicate pressures
 *   - All pressures are positive
 */
function validateLabTable(table: PvtLabTableRow[] | undefined): string[] {
  const warnings: string[] = [];
  if (!table || table.length === 0) return warnings;
  if (table.length < 2) {
    warnings.push(
      `PVT lab table has only ${table.length} row(s). At least 2 rows are required for interpolation; the engine will fall through to correlations.`,
    );
    return warnings;
  }
  for (let i = 0; i < table.length; i++) {
    if (!isFinite(table[i].pressure_psia) || table[i].pressure_psia <= 0) {
      warnings.push(`PVT lab table row ${i} has invalid pressure ${table[i].pressure_psia} psia.`);
    }
    if (i > 0 && table[i].pressure_psia <= table[i - 1].pressure_psia) {
      warnings.push(
        `PVT lab table is not sorted ascending: row ${i} pressure ${table[i].pressure_psia} psia is not greater than row ${i - 1} pressure ${table[i - 1].pressure_psia} psia.`,
      );
    }
  }
  return warnings;
}

// ============================================================================
// LINEAR REGRESSION (least squares)
// ============================================================================

interface RegressionResult {
  slope: number;
  intercept: number;
  r_squared: number;
  n: number;
}

/**
 * Ordinary least squares for y = slope * x + intercept.
 * Skips points where either x or y is NaN or non-finite.
 */
function linearRegression(x: number[], y: number[]): RegressionResult {
  if (x.length !== y.length) {
    throw new Error(`Regression: x.length (${x.length}) !== y.length (${y.length})`);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      pairs.push([x[i], y[i]]);
    }
  }
  const n = pairs.length;
  if (n < 2) {
    throw new Error(`Regression: need at least 2 valid points, got ${n}`);
  }
  const xs = pairs.map(p => p[0]);
  const ys = pairs.map(p => p[1]);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sumXY += dx * dy;
    sumXX += dx * dx;
    sumYY += dy * dy;
  }
  if (sumXX === 0) {
    throw new Error('Regression: zero variance in x (all x values identical)');
  }
  const slope = sumXY / sumXX;
  const intercept = meanY - slope * meanX;
  const r_squared = sumYY === 0 ? 1.0 : (sumXY * sumXY) / (sumXX * sumYY);
  return { slope, intercept, r_squared, n };
}

// ============================================================================
// PUBLIC ENTRY POINT
// ============================================================================

/**
 * Main entry point. Computes material balance, drive indices, and aquifer support
 * for either oil or gas reservoirs.
 * 
 * Phase 1 implementation:
 *   - Gas reservoirs: fully implemented and validated (Pletcher SPE 75354)
 *   - Oil reservoirs: implemented but unvalidated; will validate in Phase 5
 */
export function computeMaterialBalance(inputs: MBALInputs): MBALResult {
  validateInputs(inputs);
  if (inputs.fluid_system === 'gas') {
    return computeGasMBE(inputs);
  } else {
    return computeOilMBE(inputs);
  }
}

// ============================================================================
// AQUIFER HELPERS (Capsule 4A)
// ============================================================================

const DAYS_PER_MS = 1 / (1000 * 60 * 60 * 24);

/**
 * Extract Δt (days between successive timesteps) from observation_date values.
 *
 * Returns an array of length `production_data.length`, where index i holds
 * the number of days between timestep i-1 and timestep i. Index 0 is always 0
 * (initial timestep has no predecessor).
 *
 * Throws a clear, actionable error if any observation_date is missing or
 * unparseable. This is the precondition check for Fetkovich and Carter-Tracy
 * aquifer models, which require time deltas (unlike the pot aquifer which is
 * time-independent).
 *
 * Pot aquifer and no-aquifer paths never call this — they don't need Δt.
 */
function extractTimedeltasDays(production_data: ProductionDataPoint[]): number[] {
  const deltas: number[] = new Array(production_data.length).fill(0);
  const dates: (Date | null)[] = production_data.map((p, i) => {
    if (p.observation_date == null || p.observation_date === '') {
      throw new Error(
        `Timestep ${i} is missing observation_date. Fetkovich and Carter-Tracy aquifer models require a date column in the production data (Δt is needed for the time-marching scheme). Add observation_date to every row in the Data tab, or switch to the Pot aquifer model (time-independent).`,
      );
    }
    const d = new Date(p.observation_date);
    if (isNaN(d.getTime())) {
      throw new Error(
        `Timestep ${i} has an unparseable observation_date: "${p.observation_date}". Use ISO format (YYYY-MM-DD).`,
      );
    }
    return d;
  });
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1]!.getTime();
    const curr = dates[i]!.getTime();
    const dt_days = (curr - prev) * DAYS_PER_MS;
    if (dt_days <= 0) {
      throw new Error(
        `Timestep ${i} has observation_date "${production_data[i].observation_date}" which is not after timestep ${i - 1}'s date "${production_data[i - 1].observation_date}". Dates must be strictly increasing.`,
      );
    }
    deltas[i] = dt_days;
  }
  return deltas;
}

/**
 * Compute cumulative water influx We[] at each timestep for a Fetkovich aquifer.
 *
 * Reference: Fetkovich (1971) "A Simplified Approach to Water Influx
 * Calculations — Finite Aquifer Systems," JPT July 1971, p. 814.
 *
 * Marching scheme at each step n:
 *   ΔWe[n] = (Wei / pi) · (p̄_aq[n-1] - p_wf[n]) · (1 - exp(-J · pi · Δt[n] / Wei))
 *   We[n]  = We[n-1] + ΔWe[n]
 *   p̄_aq[n] = pi · (1 - We[n] / Wei)
 *
 * Where:
 *   Wei  = (cw + cf) · W · pi   -- initial aquifer encroachable water (res bbl)
 *   p̄_aq = average aquifer pressure
 *   p_wf = reservoir-aquifer interface pressure (approximated as reservoir
 *          pressure for material balance use)
 *   J    = aquifer productivity index, rb/day/psi
 *   Δt   = time step in days
 *
 * `p_wf[n]` is taken as the *midpoint* of the reservoir pressure across the
 * step: p_wf[n] = (p[n-1] + p[n]) / 2. This is Pletcher's recommended
 * convention for material balance applications.
 *
 * Returns an array of length production_data.length with We[i] in res bbl.
 * We[0] is always 0 (initial conditions).
 */
// Exported for the validation harness (tools/validation/mbal-validation.ts
// CASE 8 checks the marching scheme directly against the printed We table of
// Ahmed REH 4th ed. Example 10-10) and for the MB2 client cross-validation
// golden generator. Not part of the edge-function request surface.
export function computeFetkovichWe(
  inputs: MBALInputs,
  deltas_days: number[],
): number[] {
  const params = inputs.aquifer_params ?? {};
  const W_rb = params.initial_aquifer_water_in_place_rb;
  const J_rb_d_psi = params.aquifer_pi_rb_d_psi;
  const ct = params.aquifer_total_compressibility_psi
    ?? (inputs.water_compressibility_psi + inputs.formation_compressibility_psi);
  const pi = inputs.initial_pressure_psia;

  if (W_rb == null || W_rb <= 0) {
    throw new Error(
      'Fetkovich aquifer requires aquifer_params.initial_aquifer_water_in_place_rb (W, in res bbl). Set the aquifer water-in-place in the Aquifer tab.',
    );
  }
  if (J_rb_d_psi == null || J_rb_d_psi <= 0) {
    throw new Error(
      'Fetkovich aquifer requires aquifer_params.aquifer_pi_rb_d_psi (J, in rb/day/psi). Set the aquifer productivity index in the Aquifer tab.',
    );
  }

  const Wei = ct * W_rb * pi;  // res bbl
  const n = inputs.production_data.length;
  const We: number[] = new Array(n).fill(0);
  let p_avg_aq = pi;  // average aquifer pressure starts at pi

  for (let i = 1; i < n; i++) {
    const dt_days = deltas_days[i];
    const p_prev = inputs.production_data[i - 1].pressure_psia;
    const p_curr = inputs.production_data[i].pressure_psia;
    const p_wf = (p_prev + p_curr) / 2;  // midpoint convention

    const driving_dp = p_avg_aq - p_wf;
    // Fetkovich's productivity-index decay term
    const decay = 1 - Math.exp(-J_rb_d_psi * pi * dt_days / Wei);
    const dWe = (Wei / pi) * driving_dp * decay;

    We[i] = We[i - 1] + dWe;
    // Update average aquifer pressure for the next step
    p_avg_aq = pi * (1 - We[i] / Wei);
  }
  return We;
}

/**
 * Compute cumulative water influx We[] at each timestep for a Carter-Tracy aquifer.
 *
 * Reference: Carter-Tracy (1960); Lee-Wattenbarger (1996, Chapter 5) for the
 * pD/pD' polynomial fit to van Everdingen-Hurst infinite-aquifer functions.
 *
 * Convolution-style recurrence avoiding the integral:
 *   We[n] = We[n-1] + (U·ΔP[n] - We[n-1]·pD'(tD[n])) / (pD(tD[n]) - tD[n-1]·pD'(tD[n])) · (tD[n] - tD[n-1])
 *
 * Where:
 *   U      = 1.119 · φ_aq · h_aq · c_t · r_R² · (θ/360)   -- aquifer constant (rb/psi)
 *   tD[n]  = (6.328e-3 · k_aq · t[n]) / (φ_aq · μ_w · c_t · r_R²)
 *            (Lee field-units form; 6.328e-3 converts to dimensionless time)
 *   ΔP[n]  = Pi - average reservoir pressure between steps n-1 and n+1
 *            (van Everdingen superposition convention)
 *
 * CRITICAL: the Δp definition in Carter-Tracy uses the *average* of
 * neighboring pressure observations, not the raw step difference. This is
 * where most independent implementations diverge. The form used here:
 *   ΔP[1] = (pi - p[1]) / 2
 *   ΔP[j] = (p[j-1] - p[j+1]) / 2   for 2 <= j <= N-1
 *   ΔP[N] = (p[N-1] - p[N]) / 2
 *
 * pD(tD) and pD'(tD) polynomial fits (Lee-Wattenbarger 1996, Eqs 5.74/5.75):
 *   pD(tD)  ≈ (370.529·√tD + 137.582·tD + 5.69549·tD^1.5)
 *             / (328.834 + 265.488·√tD + 45.2157·tD + tD^1.5)
 *
 * Returns an array of length production_data.length with We[i] in res bbl.
 * We[0] is always 0 (initial conditions).
 */
// Exported for the validation harness and the MB2 Dake 9.2 client
// cross-validation golden generator (the client engine's finite-reD
// Carter-Tracy must match this We history within a committed tolerance).
// The optional `notes` array collects default-usage messages (McCain mu_w,
// area-derived r_R) that callers append to result warnings.
export function computeCarterTracyWe(
  inputs: MBALInputs,
  deltas_days: number[],
  notes?: string[],
): number[] {
  const params = inputs.aquifer_params ?? {};
  const k_aq = params.aquifer_permeability_md;
  const h_aq = params.aquifer_thickness_ft;
  const phi_aq = params.aquifer_porosity;
  const theta = params.theta_degrees ?? 360;
  const radius_ratio = params.radius_ratio ?? Infinity; // ignored — we use infinite-aquifer pD
  const ct = params.aquifer_total_compressibility_psi
    ?? (inputs.water_compressibility_psi + inputs.formation_compressibility_psi);
  const pi_psia = inputs.initial_pressure_psia;

  // Missing-parameter guards — actionable error messages
  if (k_aq == null || k_aq <= 0) {
    throw new Error(
      'Carter-Tracy aquifer requires aquifer_params.aquifer_permeability_md. Set aquifer permeability in the Aquifer tab.',
    );
  }
  if (h_aq == null || h_aq <= 0) {
    throw new Error(
      'Carter-Tracy aquifer requires aquifer_params.aquifer_thickness_ft. Set aquifer thickness in the Aquifer tab.',
    );
  }
  if (phi_aq == null || phi_aq <= 0 || phi_aq >= 1) {
    throw new Error(
      'Carter-Tracy aquifer requires aquifer_params.aquifer_porosity in (0,1). Set aquifer porosity in the Aquifer tab.',
    );
  }

  // Aquifer reservoir radius needs to be derived. We use radius_ratio (ra/rR)
  // with an effective r_R from the hydrocarbon pore volume estimate. But since
  // the reservoir radius is implicitly buried in the U constant and tD anyway,
  // we group these into a single "aquifer time constant" the user can tune.
  // For now we ask for radius_ratio (ra/rR) which sets a finite-aquifer cap,
  // but we use the infinite-aquifer pD until ra >> rR breaks down.
  //
  // Effective reservoir radius for an aquifer-style calculation. Since we don't
  // have rR directly (the reservoir geometry is encapsulated in the OGIP/OOIP
  // we're trying to estimate), we adopt the convention that the user supplies
  // r_R indirectly via the aquifer geometry. Pletcher's modified Roach example
  // uses the cell area (640 acres → r ≈ 2980 ft); for generality we let the
  // user supply this through aquifer_params as a derived quantity bundled
  // into U.
  //
  // For Capsule 4A we treat U as user-derived: aquifer_params can provide
  // the aquifer constant directly. If aquifer_pi_rb_d_psi is set (Fetkovich
  // crossover), we synthesize U from it as an approximation. Otherwise we
  // require the user to set radius_ratio + permeability + thickness + porosity
  // and we compute r_R from the assumed cell area.

  // Reservoir radius precedence (MB1, 2026-07-18):
  //   1. aquifer_params.aquifer_radius_ft (explicit; Dake 9.2 uses 9200 ft and
  //      reproduces Dake's aquifer constant U = 6446 rb/psi exactly).
  //   2. Derived from aquifer_params.reservoir_area_acres via the wedge
  //      identity A = pi * r_R^2 * (theta/360):
  //        r_R = sqrt(A * 43560 / (pi * theta/360))
  //      For a full circle this reduces to the McCain default r_R = sqrt(A/pi)
  //      named in ReservoirBalance-STATUS "Next priorities".
  //   3. Legacy fallback 2980 ft (640 acres single-cell, Pletcher convention)
  //      for backward compatibility with cases authored before the
  //      aquifer_radius_ft input was added.
  let r_R_ft: number;
  if (params.aquifer_radius_ft != null && params.aquifer_radius_ft > 0) {
    r_R_ft = params.aquifer_radius_ft;
  } else if (params.reservoir_area_acres != null && params.reservoir_area_acres > 0) {
    const f_wedge = theta / 360;
    r_R_ft = Math.sqrt((params.reservoir_area_acres * 43_560) / (Math.PI * f_wedge));
    notes?.push(
      `Carter-Tracy reservoir radius defaulted to r_R = ${r_R_ft.toFixed(0)} ft, derived from the reservoir area (${params.reservoir_area_acres.toFixed(0)} acres, encroachment ${theta.toFixed(0)} deg). Set aquifer_radius_ft to override.`,
    );
  } else {
    r_R_ft = 2980;
    notes?.push(
      'Carter-Tracy reservoir radius defaulted to the legacy 2980 ft (640-acre cell). Provide aquifer_radius_ft or reservoir_area_acres for a case-specific radius.',
    );
  }

  // Aquifer constant U (rb/psi)
  // Conversion factor 1.119 comes from converting 1 bbl/(psi·ft) to consistent units
  const U_rb_psi = 1.119 * phi_aq * h_aq * ct * r_R_ft * r_R_ft * (theta / 360);

  // Dimensionless time conversion factor — Lee field units
  // tD = (6.328e-3 · k · t_days) / (φ · μ · ct · r_R²)
  // Water viscosity precedence (MB1, 2026-07-18): explicit
  // aquifer_params.aquifer_water_viscosity_cp, else the McCain (1991)
  // correlation at initial pressure and reservoir temperature with
  // aquifer_params.water_salinity_ppm (0 = fresh water). This replaces the
  // old flat 0.5 cP default; the McCain value is reported as a note so the
  // user can see (and pin) what was used.
  let mu_w_cp: number;
  if (params.aquifer_water_viscosity_cp != null && params.aquifer_water_viscosity_cp > 0) {
    mu_w_cp = params.aquifer_water_viscosity_cp;
  } else {
    // Salinity precedence: aquifer-specific value, else the case's PVT
    // salinity (PvtRock water_salinity_ppm flows in at the top level), else
    // fresh water.
    const salinity_ppm = params.water_salinity_ppm ?? inputs.water_salinity_ppm ?? 0;
    mu_w_cp = mccainMuW(pi_psia, inputs.reservoir_temperature_f, salinity_ppm);
    notes?.push(
      `Carter-Tracy water viscosity defaulted to ${mu_w_cp.toFixed(3)} cp via McCain (1991) at ${inputs.reservoir_temperature_f.toFixed(0)} F, salinity ${salinity_ppm.toFixed(0)} ppm. Set aquifer_water_viscosity_cp to override.`,
    );
  }
  const tD_factor = (6.328e-3 * k_aq) / (phi_aq * mu_w_cp * ct * r_R_ft * r_R_ft);

  // Build cumulative time (days from start)
  const n = inputs.production_data.length;
  const t_days = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    t_days[i] = t_days[i - 1] + deltas_days[i];
  }

  // Dimensionless pressure pD(tD) and its derivative pD'(tD).
  //
  // For infinite-acting aquifer (radius_ratio = Infinity): Lee-Wattenbarger
  // (1996) polynomial fit to van Everdingen-Hurst tables (Eqs 5.74/5.75).
  //
  // For finite aquifer (radius_ratio = reD, finite): blend between
  // infinite-acting pD (early time, before boundary effects matter) and
  // pseudo-steady-state pD (late time, after boundary effects dominate).
  // The transition is centered at tD_pss = 0.4·reD² (Lee 1982 criterion
  // for onset of pseudo-steady-state in closed reservoirs), with width
  // 0.3·tD_pss for smooth derivative continuity.
  //
  // Pseudo-steady-state formula (Lee 1982 Eq 5.65; Dake 1978 Ch 6):
  //   pD_pss(tD, reD) = 2·tD/(reD² - 1) + ln(reD) - 0.75
  //
  // Added 2026-05-17 (Phase 5 chunk 3) to enable finite-aquifer Carter-
  // Tracy. Backward compatible: when radius_ratio is unset (defaults to
  // Infinity), behavior is unchanged from prior engine.
  function pD_inf(tD: number): number {
    if (tD <= 0) return 0;
    const sqrtTD = Math.sqrt(tD);
    const num = 370.529 * sqrtTD + 137.582 * tD + 5.69549 * tD * sqrtTD;
    const den = 328.834 + 265.488 * sqrtTD + 45.2157 * tD + tD * sqrtTD;
    return num / den;
  }
  function pD(tD: number): number {
    if (tD <= 0) return 0;
    if (!isFinite(radius_ratio) || radius_ratio <= 1) {
      return pD_inf(tD);
    }
    const tD_pss = 0.4 * radius_ratio * radius_ratio;
    const width = 0.3 * tD_pss;
    const w = 0.5 * (1 + Math.tanh((tD - tD_pss) / width));
    const p_inf = pD_inf(tD);
    const p_pss = 2 * tD / (radius_ratio * radius_ratio - 1) + Math.log(radius_ratio) - 0.75;
    return (1 - w) * p_inf + w * p_pss;
  }
  function pDprime(tD: number): number {
    // Numerical derivative — central difference, ~6 digits accurate
    if (tD <= 0) return 0;
    const h = Math.max(1e-6, tD * 1e-4);
    return (pD(tD + h) - pD(tD - h)) / (2 * h);
  }

  // Δp definition — cumulative drop from initial pressure to time step j.
  // This is the CORRECT convention for the Carter-Tracy recursive form.
  //
  // Previously this function used the van Everdingen superposition Δp_j ≈
  // (p[j-1] - p[j+1]) / 2. That convention applies to the CONVOLUTION form
  // of Hurst-van Everdingen, not to the recursive form of Carter-Tracy.
  // The Carter-Tracy (1960) original paper, Klins (1988), and Lee-
  // Wattenbarger (1996) all use cumulative Δp.
  //
  // Bug fix: 2026-05-17 (Phase 5 chunk 3). Validated against Dake Exercise
  // 9.2: prior convention produced ~80% under-prediction of We; corrected
  // implementation matches Dake's published Hurst-van Everdingen values
  // to within ~1-2% at late time, ~17% at year 1 (CT's intrinsic early-
  // time limitation vs HvE exact convolution).
  function deltaP(j: number): number {
    return pi_psia - inputs.production_data[j].pressure_psia;
  }

  const We: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const tD_n = t_days[i] * tD_factor;
    const tD_prev = t_days[i - 1] * tD_factor;
    const pD_n = pD(tD_n);
    const pDp_n = pDprime(tD_n);
    const denom = pD_n - tD_prev * pDp_n;
    if (denom <= 0) {
      // Degenerate — should not happen for sensible inputs; fall back to no influx this step
      We[i] = We[i - 1];
      continue;
    }
    const dWe_per_dtD = (U_rb_psi * deltaP(i) - We[i - 1] * pDp_n) / denom;
    We[i] = We[i - 1] + dWe_per_dtD * (tD_n - tD_prev);
    if (We[i] < 0) We[i] = 0; // physical floor
  }

  return We;
}

// ============================================================================
// VALIDATION TIER RESOLVER (Capsule 4A)
// ============================================================================

/**
 * Resolve the validation tier for a given engine path.
 *
 * Tier vocabulary (also documented in MBALResult):
 *   'benchmark_verified'  = Implementation has been tested against a published
 *                           worked example and matches within the stated
 *                           tolerance. The reference case is recorded for
 *                           traceability.
 *   'published_method'    = Implementation follows a recognized peer-reviewed
 *                           or industry-standard formulation. The workflow
 *                           includes documented assumptions, internal checks,
 *                           and calculation traceability.
 *   'engineering_basis'   = Implementation follows established reservoir
 *                           engineering principles where a suitable public
 *                           worked example is not available. The method is
 *                           documented, traceable, and ready for engineering
 *                           use within stated assumptions.
 *
 * This is the single source of truth for tier mapping. UI and any downstream
 * consumer reads `result.validation_tier` and uses the optional `reference`
 * and `tolerance_pct` to render constructive language.
 */
// MB7: exported so tools/validation/gen-tier-matrix-golden.ts can dump the
// full mapping into src/pages/apps/reservoir-balance/lib/tierMatrix.json —
// the UI's pre-run tier badge reads THAT file instead of hand-mirroring this
// function (the Capsule 4B mirror had already drifted: it still showed
// Carter-Tracy as published_method after the Phase 5 benchmark promotion).
export function resolveValidationTier(
  fluid_system: 'oil' | 'gas',
  aquifer_model: AquiferModel,
  has_gas_cap: boolean,
): {
  tier: 'benchmark_verified' | 'published_method' | 'engineering_basis';
  reference?: string;
  tolerance_pct?: number;
} {
  // Gas paths
  if (fluid_system === 'gas') {
    if (aquifer_model === 'pot') {
      return {
        tier: 'benchmark_verified',
        reference: 'Pletcher SPE 75354 (2002) Tables 1-3, two-cell gas simulation. Matched within stated tolerance.',
        tolerance_pct: 0.19, // OGIP error vs Pletcher's reported value
      };
    }
    if (aquifer_model === 'fetkovich') {
      return {
        tier: 'benchmark_verified',
        reference: 'Pletcher SPE 75354 (2002) Tables 9 / Fig. 8, single-cell gas with finite-aquifer Fetkovich support. Matched within stated tolerance.',
        tolerance_pct: 0.76, // OGIP error vs Pletcher's reported true value (100.8 Bcf)
      };
    }
    if (aquifer_model === 'carter_tracy') {
      return {
        tier: 'benchmark_verified',
        reference: 'Carter-Tracy (1960) with Lee-Wattenbarger pD/pD\' polynomial fits. Validated 2026-05-17 against Dake (1978) Exercise 9.2 (oil + Carter-Tracy + reD=5, wedge aquifer 140° encroachment): engine OOIP 301.0 MMSTB vs Dake truth 312 MMSTB (3.53% error), R² = 0.9998, drive indices match expected water-drive-with-depletion signature. The CT math is shared between gas and oil fluid systems; validation on the oil path qualifies the gas path. Implementation corrections in same release: Δp convention now cumulative drop (was van Everdingen averaged, a bug), finite-aquifer pD via tanh-blended pseudo-steady-state transition when radius_ratio is set, r_R and μ_w user-configurable via aquifer_params.',
        tolerance_pct: 3.53,
      };
    }
    // aquifer_model === 'none'
    return {
      tier: 'published_method',
      reference: 'Standard p/z material balance formulation (Havlena-Odeh 1963). Documented calculation logic and internal checks.',
    };
  }

  // Oil paths
  if (aquifer_model === 'pot' && !has_gas_cap) {
    return {
      tier: 'benchmark_verified',
      reference: 'Pletcher SPE 75354 (2002) Tables 10-13, multicell oil with pot aquifer. Matched within stated tolerance.',
      tolerance_pct: 0.13, // OOIP error vs Pletcher's reported value
    };
  }
  if (aquifer_model === 'pot' && has_gas_cap) {
    return {
      tier: 'benchmark_verified',
      reference: 'Validated 2026-07-18 (MB1) against Ahmed, Reservoir Engineering Handbook 4th ed., Chapter 11, Example 11-1: combination-drive reservoir (gas cap m=0.25 plus water influx, N=10 MMSTB given). Engine per-timestep terms reproduce the printed back-calculated We = 411,281 bbl and the printed driving indexes DDI/SDI/WDI/EDI = 0.4385/0.3465/0.2112/0.0038 (book index convention, denominator F - Wp*Bw). Scope note: the published truth is a single pressure step with N given, so it anchors the combined-MBE term math and drive indexes; the m>0 pot-plot regression (F/(Eo+m*Eg) vs dp/(Eo+m*Eg), generalized in MB1) is additionally gated by an exact synthetic multi-step round trip recovering N and W to numerical precision (harness CASE 9).',
      tolerance_pct: 1.5,
    };
  }
  if (aquifer_model === 'fetkovich') {
    return {
      tier: 'benchmark_verified',
      reference: 'Validated 2026-07-18 (MB1) against Ahmed, Reservoir Engineering Handbook 4th ed., Chapter 10, Example 10-10 (data credited to Dake 1978; the Dake Exercise 9.2 wedge aquifer worked with Fetkovich): the marching scheme reproduces the printed step-by-step We table (final We 37.971 MM bbl at 4 years) within 1%, confirming the published midpoint p_r-bar convention, Wei = ct*Wi*pi*f = 211.9 MM bbl and J = 116.5 bbl/day/psi (no-flow-boundary form ln(reD) - 3/4). Full oil path additionally benchmarked on Dake Exercise 9.2 production data with this aquifer: OOIP within 10% of Dake N = 312 MMSTB (Fetkovich vs Hurst-van Everdingen method spread, same reasoning as the Carter-Tracy case). Harness CASE 8.',
      tolerance_pct: 10,
    };
  }
  if (aquifer_model === 'carter_tracy') {
    return {
      tier: 'benchmark_verified',
      reference: 'Carter-Tracy (1960) with Lee-Wattenbarger pD/pD\' polynomial fits applied to oil material balance via Havlena-Odeh F/Eo vs We/Eo regression. Validated 2026-05-17 against Dake (1978) Exercise 9.2 (wedge reservoir, 140° encroachment angle, reD=5, k=200 mD, h=100 ft, φ=0.25, μw=0.55 cP, r_o=9200 ft): engine OOIP = 301.0 MMSTB vs Dake truth 312 MMSTB (3.53% error), R² = 0.9998. Drive indices at year 10: IDD=0.608, IWD=0.392, GDI=0, SDI=0.011, sum=1.010 — matching the water-drive-with-depletion signature Dake describes. Implementation corrections in same release (2026-05-17): Δp convention now cumulative drop from initial pressure (was van Everdingen averaged step, a bug that caused systematic ~80%% under-prediction of We); finite-aquifer pD via tanh-blended pseudo-steady-state transition at tD_pss = 0.4·reD² when radius_ratio is set; r_R and μ_w user-configurable via aquifer_params (defaults: 2980 ft, 0.5 cP for backward compatibility with pre-Phase-5 cases).',
      tolerance_pct: 3.53,
    };
  }
  // aquifer_model === 'none'
  // Validated 2026-05-17 against Tarek Ahmed Example 11-3 (Virginia Hills
  // Beaverhill Lake field). Validation harness Case 2D asserts D-1..D-6:
  // OOIP, drive index sum, DDI+SDI invariant, WDI≈0, GDI=0, mechanism
  // classification. All pass.
  return {
    tier: 'benchmark_verified',
    reference: 'Validated against two worked examples: (a) Tarek Ahmed (2010) Reservoir Engineering Handbook, 4th ed., Chapter 11, Example 11-3 — Virginia Hills Beaverhill Lake field — for the no-gas-cap (m=0) variant. Engine LSQ N = 291.3 MM STB vs Ahmed graphical fit 257 MM STB vs volumetric 270.6 MM STB. (b) Dake (1978) Fundamentals of Reservoir Engineering, Chapter 3, Exercise 3.4 — for the gas-cap (m>0) variant. Engine LSQ N = 115.5 MM STB vs Dake trial-and-error fit 114 MM STB vs volumetric 115 MM STB; m=0.5 input reproduces Dake\'s preferred solution. Both use Havlena-Odeh (1963) F vs Et or F vs (Eo + m·Eg) formulations.',
    notes: 'For m=0 the method spread between LSQ (engine) and graphical fit (Ahmed) is the dominant source of disagreement on real-world data. For m>0 the engine matches Dake\'s LSQ within < 2% (engine 115.5 MM STB vs Dake 114 MM STB).',
  };
}

/**
 * Sanity-check inputs before the engine runs.
 * Throws descriptive errors on bad inputs (fail-fast).
 *
 * NOTE: these error messages are surfaced directly to end users via the
 * Edge Function's response. Keep them human-readable and actionable
 * (tell the user what to fix, not just what's wrong).
 */
function validateInputs(inputs: MBALInputs): void {
  if (!inputs.production_data || inputs.production_data.length < 2) {
    throw new Error(
      'Add at least 2 timesteps of production data. The first row should be the initial state (zero cumulative production); subsequent rows are observations over time.',
    );
  }
  // Production data must be sorted by timestep_index
  for (let i = 1; i < inputs.production_data.length; i++) {
    if (
      inputs.production_data[i].timestep_index <=
      inputs.production_data[i - 1].timestep_index
    ) {
      throw new Error(
        `Production data rows must be in chronological order (each timestep_index greater than the last). Found timestep ${inputs.production_data[i].timestep_index} after ${inputs.production_data[i - 1].timestep_index}.`,
      );
    }
  }
  // Initial point must have zero cumulative production
  const t0 = inputs.production_data[0];
  if ((t0.cum_oil_stb ?? 0) > 0 || (t0.cum_gas_scf ?? 0) > 0 || (t0.cum_water_stb ?? 0) > 0) {
    throw new Error(
      'The first row of production data must be the initial reservoir state: cumulative oil, gas, and water all zero. Add a row before your first observation with the initial pressure and zero cumulatives.',
    );
  }
  // Initial pressure should match
  if (Math.abs(t0.pressure_psia - inputs.initial_pressure_psia) > 1) {
    throw new Error(
      `The initial pressure on the case (${inputs.initial_pressure_psia} psia, set on the Overview tab) doesn't match the pressure in the first row of production data (${t0.pressure_psia} psia). Update one of them so they agree.`,
    );
  }
  // Saturation sanity
  if (inputs.initial_water_saturation < 0 || inputs.initial_water_saturation >= 1) {
    throw new Error(
      `Initial water saturation must be between 0 and 1 (exclusive). Got ${inputs.initial_water_saturation}. Update it on the Overview tab.`,
    );
  }
  // Compressibility sanity (reasonable ranges)
  if (inputs.formation_compressibility_psi <= 0 || inputs.formation_compressibility_psi > 1e-3) {
    throw new Error(
      `Formation compressibility ${inputs.formation_compressibility_psi} 1/psi is out of typical range. Expected 1e-7 to 1e-4. Update it on the PVT tab.`,
    );
  }
  if (inputs.water_compressibility_psi <= 0 || inputs.water_compressibility_psi > 1e-3) {
    throw new Error(
      `Water compressibility ${inputs.water_compressibility_psi} 1/psi is out of typical range. Expected ~3e-6. Update it on the PVT tab.`,
    );
  }
  // Capsule 4C chunk (b): if pvt_source is 'lab_table' but no lab data is
  // available at all — neither a separate pvt_lab_table nor per-row PVT in
  // production_data — that's a user/config error worth a clear error rather
  // than silent fallback to correlations.
  if (inputs.pvt_source === 'lab_table') {
    const hasSeparateTable = inputs.pvt_lab_table && inputs.pvt_lab_table.length >= 2;
    const hasPerRowPvt = inputs.production_data.some(
      (p) =>
        p.bo_rb_stb != null ||
        p.rs_scf_stb != null ||
        p.bg_rb_mscf != null ||
        p.z_factor != null ||
        p.bw_rb_stb != null,
    );
    if (!hasSeparateTable && !hasPerRowPvt) {
      throw new Error(
        `PVT source is set to "lab_table" but no lab data is supplied: there is no pvt_lab_table (separate table with ≥ 2 pressure points) and no per-row PVT columns in production_data. Either upload a PVT lab table in the PVT tab, supply per-row PVT in the Data tab, or switch the PVT source to "correlated" or "mixed".`,
      );
    }
  }
}

// ============================================================================
// GAS RESERVOIR MBE
// ============================================================================

/**
 * Compute material balance for a gas reservoir.
 * 
 * Reference: Pletcher SPE 75354 (2002), equations 1-15.
 *   F = G·Eg + Efw + We              (Eq. 1)
 *   F = Gp·Bg + Wp·Bw                (Eq. 2)
 *   Eg = Bg - Bgi                    (Eq. 3)
 *   Efw = Bgi · [Swi·(cw+cf)/(1-Swi)] · (pi-p)   (Eq. 4)
 *   Et = Eg + Efw                    (Eq. 7)
 * 
 * If aquifer is 'pot':
 *   F/Eg = G + (pi-p)/Eg · [G·Bgi·Swi·(cw+cf)/(1-Swi) + (cw+cf)·W]   (Eq. 13)
 *   Linear regression on (pi-p)/Eg vs F/Eg gives G as intercept and W from slope.
 * 
 * If no aquifer:
 *   p/z plot (modified for cf): linear regression of (p/z)·(1 - cf·Δp / (1-Swi)) vs Gp.
 *   Or pot aquifer plot with W=0 (which falls out from Eq. 13 when no aquifer).
 *   For Phase 1 we use the pot aquifer plot in both cases for unified math.
 */
// MB5 (2026-07-18): the per-timestep F/Et computation was extracted from
// computeGasMBE so the pressure history match can evaluate F and Et at
// candidate (simulated) pressures through the exact same PVT precedence
// chain the regression path uses. Mirrors the MB1 computeOilPerTimestep
// extraction on the oil side. computeGasMBE behavior is unchanged.
export function computeGasPerTimestep(inputs: MBALInputs): {
  per_timestep: PerTimestepResult[];
  meta: {
    pi: number; T_f: number; Swi: number; cf: number; cw: number;
    gas_sg: number; ppc: number; tpc: number; T_r: number;
    zi: number; Bgi_rb_scf: number; Bgi_rb_mscf: number; Bwi: number;
    zCorr: 'hall_yarborough' | 'dranchuk_abou_kassem';
    waterCorr: 'mccain';
  };
} {
  const pi = inputs.initial_pressure_psia;
  const T_f = inputs.reservoir_temperature_f;
  const Swi = inputs.initial_water_saturation;
  const cf = inputs.formation_compressibility_psi;
  const cw = inputs.water_compressibility_psi;
  const gas_sg = inputs.gas_specific_gravity ?? 0.65;

  // Pseudo-reduced properties for z-factor correlations
  // Sutton (1985) correlations for natural gas pseudo-critical properties:
  //   ppc = 756.8 - 131.0·sg - 3.6·sg^2 (psia)
  //   tpc = 169.2 + 349.5·sg - 74.0·sg^2 (°R)
  const ppc = 756.8 - 131.0 * gas_sg - 3.6 * gas_sg * gas_sg;
  const tpc = 169.2 + 349.5 * gas_sg - 74.0 * gas_sg * gas_sg;
  const T_r = T_f + 459.67;

  // Capsule 4C: select z-factor correlation. Default Hall-Yarborough; Dranchuk-
  // Abou-Kassem available as alternative (recommended at low Tpr).
  const zCorr = inputs.pvt_correlations?.z_factor ?? 'hall_yarborough';
  const waterCorr = inputs.pvt_correlations?.water ?? 'mccain';

  // Helper: compute z at any pressure. Precedence:
  //   1. lab_z (per-row override from production_data)
  //   2. pvt_lab_table interpolation (Capsule 4C chunk b)
  //   3. correlation (HY or DAK)
  function zAt(p: number, lab_z?: number): number {
    if (lab_z != null) return lab_z;
    const labTableZ = interpolateLabTable(inputs.pvt_lab_table, p, 'z_factor');
    if (labTableZ != null) return labTableZ;
    const ppr = p / ppc;
    const tpr = T_r / tpc;
    if (zCorr === 'dranchuk_abou_kassem') {
      return dranchukAbouKassemZ(ppr, tpr);
    }
    return hallYarboroughZ(ppr, tpr);
  }

  // Helper: Bw at any pressure. Same precedence chain.
  function bwAt(p: number, bwi: number): number {
    const labTableBw = interpolateLabTable(inputs.pvt_lab_table, p, 'bw_rb_stb');
    if (labTableBw != null) return labTableBw;
    if (waterCorr === 'mccain') return mccainBw(p, T_f);
    return bwApprox(bwi, p, pi, inputs.water_compressibility_psi);
  }

  // Initial conditions
  const t0 = inputs.production_data[0];
  const zi = zAt(pi, t0.z_factor);
  // Bgi: honor lab Bg if supplied at initial timestep; otherwise compute from z.
  // Must use the same source as per-row Bg to keep Eg = Bg - Bgi self-consistent.
  const Bgi_rb_scf = (t0.bg_rb_mscf != null)
    ? t0.bg_rb_mscf / SCF_PER_MSCF
    : bgRbPerScf(pi, T_f, zi);
  const Bgi_rb_mscf = Bgi_rb_scf * SCF_PER_MSCF;       // For display

  // Initial Bw — if user provided lab Bw, use it; else assume 1.0
  const Bwi = t0.bw_rb_stb ?? 1.0;

  // Loop over timesteps
  const per_timestep: PerTimestepResult[] = [];
  for (const point of inputs.production_data) {
    const p = point.pressure_psia;
    const dp = pi - p;

    const z = zAt(p, point.z_factor);
    // Bg precedence: per-row → lab-table → z-derived (and Bgi short-circuit at initial pressure).
    let Bg_rb_scf: number;
    if (point.bg_rb_mscf != null) {
      Bg_rb_scf = point.bg_rb_mscf / SCF_PER_MSCF;
    } else {
      const labTableBg_mscf = interpolateLabTable(inputs.pvt_lab_table, p, 'bg_rb_mscf');
      if (labTableBg_mscf != null) {
        Bg_rb_scf = labTableBg_mscf / SCF_PER_MSCF;
      } else if (p === pi) {
        Bg_rb_scf = Bgi_rb_scf;
      } else {
        Bg_rb_scf = bgRbPerScf(p, T_f, z);
      }
    }
    const Bg_rb_mscf = Bg_rb_scf * SCF_PER_MSCF;
    const Bw = point.bw_rb_stb ?? bwAt(p, Bwi);

    // F = Gp·Bg + Wp·Bw     (all in res bbl after multiplication)
    const Gp_scf = point.cum_gas_scf ?? 0;
    const Wp_stb = point.cum_water_stb ?? 0;
    const F_rb = Gp_scf * Bg_rb_scf + Wp_stb * Bw;

    // Eg = Bg - Bgi  (in RB/scf internally; convert to RB/Mscf for display)
    const Eg_rb_scf = Bg_rb_scf - Bgi_rb_scf;
    const Eg_rb_mscf = Eg_rb_scf * SCF_PER_MSCF;

    // Efw = Bgi · [(Swi·cw + cf)/(1-Swi)] · (pi-p)   — Pletcher Eq. 4
    //   Note: (Swi*cw + cf), NOT Swi*(cw+cf). Connate water expansion scales with
    //   Swi (only water-filled pore expands), but rock compaction (cf) reduces
    //   the total pore volume regardless of saturation.
    //   The combined "effective compressibility" (Swi·cw + cf)/(1-Swi) is a
    //   standard form in reservoir engineering literature.
    //   Bgi in RB/scf, so Efw is in RB/scf; we'll combine with G in scf to get res bbl.
    const Efw_rb_scf = Bgi_rb_scf * ((Swi * cw + cf) / (1 - Swi)) * dp;
    // For display/reporting we want Efw in res bbl at full Gp scale, which is
    // not how Pletcher defines it. Pletcher's Efw is per scf of OGIP.
    // For per-timestep display we report Efw_rb_scf normalized as RB/scf;
    // the multiplication by G (OGIP, in scf) happens in drive index calc.
    const Efw_rb = Efw_rb_scf;  // Stored as RB/scf, named _rb for consistency

    // Et = Eg + Efw  (both RB/scf)
    const Et_rb = Eg_rb_scf + Efw_rb_scf;

    // p/z (for diagnostic plot)
    const p_over_z = p / z;

    per_timestep.push({
      timestep_index: point.timestep_index,
      pressure_psia: p,
      delta_p_psi: dp,
      bg_rb_scf: Bg_rb_scf,
      bg_rb_mscf: Bg_rb_mscf,
      bw_rb_stb: Bw,
      z_factor: z,
      F_rb,
      Eg_rb_mscf,
      Efw_rb,
      Et_rb,
      p_over_z,
    });
  }

  return {
    per_timestep,
    meta: {
      pi, T_f, Swi, cf, cw, gas_sg, ppc, tpc, T_r,
      zi, Bgi_rb_scf, Bgi_rb_mscf, Bwi, zCorr, waterCorr,
    },
  };
}

function computeGasMBE(inputs: MBALInputs): MBALResult {
  const { per_timestep, meta } = computeGasPerTimestep(inputs);
  const {
    pi, T_f, Swi, cf, cw, gas_sg, ppc, tpc, T_r,
    Bgi_rb_scf, Bgi_rb_mscf, zCorr,
  } = meta;

  // ==========================================================================
  // SOLVE: branch on aquifer model
  //
  // For 'none' and 'pot', the regression has W (or no W) entangled with the
  // intercept/slope. For 'fetkovich' and 'carter_tracy', We[n] is computed
  // directly from user-supplied aquifer parameters via the marching scheme,
  // and the regression then becomes a simple (F - We) vs Et through origin.
  // ==========================================================================
  const aquiferModel: AquiferModel = inputs.aquifer_model ?? 'none';
  const excluded = new Set(inputs.excluded_timesteps ?? []);

  const aquifer_default_notes: string[] = [];
  let G_scf: number;
  let W_rb: number = 0;
  let reg: { slope: number; intercept: number; r_squared: number; n: number };

  if (aquiferModel === 'pot') {
    // ─── Pot Aquifer Plot (Pletcher Eq. 13) ───
    // y = F/Eg            [scf]
    // x = (pi-p)/Eg
    // Intercept = G, slope = G·Bgi·(Swi·cw+cf)/(1-Swi) + (cw+cf)·W
    const regression_x: number[] = [];
    const regression_y: number[] = [];
    for (const r of per_timestep) {
      if (r.timestep_index === 0) continue;
      if (excluded.has(r.timestep_index)) continue;
      const Eg = (r.Eg_rb_mscf ?? 0) * MSCF_PER_SCF;
      if (Eg <= 0) continue;
      regression_y.push(r.F_rb / Eg);
      regression_x.push(r.delta_p_psi / Eg);
    }
    if (regression_x.length < 2) {
      throw new Error(`Pot aquifer plot needs at least 2 valid timesteps below the initial state. After excluding the initial timestep and any user-excluded timesteps, only ${regression_x.length} remained. Add more production data observations or reduce the excluded_timesteps list.`);
    }
    reg = linearRegression(regression_x, regression_y);
    G_scf = reg.intercept;
    // Solve for W from slope (Pletcher Eq. 14):
    //   W = [slope - G·Bgi·(Swi·cw + cf)/(1-Swi)] / (cw+cf)
    const expansion_term_rb_psi = G_scf * Bgi_rb_scf * (Swi * cw + cf) / (1 - Swi);
    W_rb = (reg.slope - expansion_term_rb_psi) / (cw + cf);
    // We at each timestep: pot model is time-independent (Pletcher Eq. 12)
    for (const r of per_timestep) {
      r.We_rb = (cw + cf) * W_rb * r.delta_p_psi;
    }

  } else if (aquiferModel === 'fetkovich' || aquiferModel === 'carter_tracy') {
    // ─── Time-dependent aquifer: compute We[] from user-supplied parameters ───
    const deltas = extractTimedeltasDays(inputs.production_data);
    const We_array = aquiferModel === 'fetkovich'
      ? computeFetkovichWe(inputs, deltas)
      : computeCarterTracyWe(inputs, deltas, aquifer_default_notes);
    // Assign We per timestep
    for (let i = 0; i < per_timestep.length; i++) {
      per_timestep[i].We_rb = We_array[i];
    }
    // Now regress (F - We) vs Et through origin: slope = G
    const regression_x: number[] = [];
    const regression_y: number[] = [];
    for (let i = 0; i < per_timestep.length; i++) {
      const r = per_timestep[i];
      if (r.timestep_index === 0) continue;
      if (excluded.has(r.timestep_index)) continue;
      if (r.Et_rb <= 0) continue;
      regression_x.push(r.Et_rb);
      regression_y.push(r.F_rb - We_array[i]);
    }
    if (regression_x.length < 2) {
      throw new Error(`${aquiferModel} regression needs at least 2 valid timesteps after excluding the initial timestep and user-excluded points. Only ${regression_x.length} remained.`);
    }
    reg = linearRegression(regression_x, regression_y);
    G_scf = reg.slope; // through origin: F-We = G·Et
    // Report the user-supplied W (not derived from slope)
    W_rb = inputs.aquifer_params?.initial_aquifer_water_in_place_rb ?? 0;

  } else {
    // ─── No aquifer: F = G·Et regression through origin ───
    const regression_x: number[] = [];
    const regression_y: number[] = [];
    for (const r of per_timestep) {
      if (r.timestep_index === 0) continue;
      if (excluded.has(r.timestep_index)) continue;
      if (r.Et_rb <= 0) continue;
      regression_x.push(r.Et_rb);
      regression_y.push(r.F_rb);
    }
    if (regression_x.length < 2) {
      throw new Error(`Havlena-Odeh regression needs at least 2 valid timesteps below the initial state. Only ${regression_x.length} remained.`);
    }
    reg = linearRegression(regression_x, regression_y);
    G_scf = reg.slope;
    for (const r of per_timestep) {
      r.We_rb = 0;
    }
  }

  // ==========================================================================
  // Drive indices (Pletcher Eqs. 8-10)
  // IGD = G·Eg / (Gp·Bg)
  // ICD = G·Efw / (Gp·Bg)
  // IWD = (We - Wp·Bw) / (Gp·Bg)
  // Common denominator Gp·Bg is the cumulative reservoir voidage at that timestep.
  // ==========================================================================
  for (let i = 0; i < per_timestep.length; i++) {
    const r = per_timestep[i];
    const point = inputs.production_data[i];
    if (r.timestep_index === 0) {
      r.gdi = 0; r.cdi = 0; r.wdi = 0; r.drive_index_sum = 0;
      continue;
    }
    const Gp_scf = point.cum_gas_scf ?? 0;
    const Bg = r.bg_rb_scf!;
    const denom = Gp_scf * Bg;  // res bbl
    if (denom <= 0) {
      r.gdi = 0; r.cdi = 0; r.wdi = 0; r.drive_index_sum = 0;
      continue;
    }
    const Eg_rb_scf = (r.Eg_rb_mscf ?? 0) * MSCF_PER_SCF;
    const Efw_rb_scf = r.Efw_rb;
    const Wp_stb = point.cum_water_stb ?? 0;

    r.gdi = (G_scf * Eg_rb_scf) / denom;
    r.cdi = (G_scf * Efw_rb_scf) / denom;
    r.wdi = (r.We_rb! - Wp_stb * r.bw_rb_stb!) / denom;
    r.drive_index_sum = r.gdi + r.cdi + r.wdi;
  }

  // ==========================================================================
  // Final timestep diagnostics
  // ==========================================================================
  const last = per_timestep[per_timestep.length - 1];

  const drive_mechanism = classifyDriveMechanismGas(last.gdi ?? 0, last.cdi ?? 0, last.wdi ?? 0);
  const aquifer_strength = classifyAquiferStrength(last.wdi ?? 0);

  // ==========================================================================
  // Warnings
  // ==========================================================================
  const warnings: string[] = [];
  warnings.push(...aquifer_default_notes);
  if (last.drive_index_sum != null && Math.abs(last.drive_index_sum - 1.0) > 0.05) {
    warnings.push(
      `Drive index sum at final timestep is ${last.drive_index_sum.toFixed(3)} ` +
      `(expected ~1.00 ± 0.05). Possible material balance solution issue.`
    );
  }
  if (reg.r_squared < 0.95) {
    warnings.push(`Regression R²=${reg.r_squared.toFixed(4)} is low; data may have scatter or wrong aquifer model.`);
  }
  if (aquiferModel === 'pot' && W_rb < 0) {
    warnings.push(`Computed aquifer W is negative (${W_rb.toFixed(0)} res bbl). The pot aquifer regression solved for a W < 0, which is physically impossible. This often indicates no aquifer is actually present; consider switching to "none". If you do expect aquifer support, the data may have a different drive mechanism (gas-cap expansion, communicating reservoirs, etc.).`);
  }

  // Capsule 4C: correlation-validity warnings. Tpr is the most-likely-violated
  // range for gas correlations; we report it at the reservoir temperature.
  const tpr_at_T = T_r / tpc;
  const ppr_max = pi / ppc;
  const cvWarnings = correlationValidityWarnings(
    inputs.pvt_correlations?.pb_rs_bo ?? 'standing',
    zCorr,
    inputs.pvt_correlations?.water ?? 'mccain',
    { pi, temp_f: T_f, gas_sg, ppr_max, tpr: tpr_at_T },
  );
  warnings.push(...cvWarnings);

  // Capsule 4C chunk (b): viscosity-correlation validity (only gas matters here).
  const visWarnings = viscosityValidityWarnings(
    inputs.pvt_correlations?.oil_viscosity ?? 'beggs_robinson',
    inputs.pvt_correlations?.gas_viscosity ?? 'lee_gonzalez_eakin',
    { pi, temp_f: T_f, gas_sg },
  );
  warnings.push(...visWarnings);

  // Capsule 4C chunk (b): structural warnings about the lab-table itself.
  warnings.push(...validateLabTable(inputs.pvt_lab_table));

  const tier = resolveValidationTier('gas', aquiferModel, false);

  return {
    estimated_ogip_scf: G_scf,
    r_squared: reg.r_squared,
    regression_slope: reg.slope,
    regression_intercept: reg.intercept,
    n_data_points: reg.n,
    aquifer_owip_rb: inputs.has_aquifer ? W_rb : undefined,
    aquifer_cumulative_we_rb: inputs.has_aquifer ? last.We_rb : undefined,
    final_gdi: last.gdi,
    final_wdi: last.wdi,
    final_cdi: last.cdi,
    final_drive_index_sum: last.drive_index_sum,
    drive_mechanism,
    aquifer_strength,
    warnings,
    validation_tier: tier.tier,
    validation_reference: tier.reference,
    validation_tolerance_pct: tier.tolerance_pct,
    per_timestep,
    engine_version: ENGINE_VERSION,
  };
}

// ============================================================================
// OIL RESERVOIR MBE (Phase 1: implemented but unvalidated)
// ============================================================================

/**
 * Compute material balance for an oil reservoir.
 * Phase 1 status: implemented but UNVALIDATED. Phase 5 will validate against a
 * published oil example (Pletcher Table 9 or Tarek Ahmed).
 * 
 * Havlena-Odeh formulation:
 *   F = N·Et + We
 *   where:
 *     F = Np·[Bt + Bg·(Rp - Rsi)] + Wp·Bw     (Bt = Bo + Bg·(Rsi - Rs))
 *     Et = Eo + m·Eg + Efw  for oil with gas cap; just Eo + Efw for undersaturated
 *     Eo = Bt - Bti
 *     Eg = Bti/Bgi · (Bg - Bgi)
 *     Efw = Bti·(1+m) · Swi·(cw+cf)/(1-Swi) · (pi - p)
 * 
 * Solve: F/Et = N + We/Et
 *   - No aquifer: F vs Et is a straight line through origin, slope = N (OOIP)
 *   - With aquifer: F/Et vs We/Et linear with intercept N and slope=1
 */
/**
 * Per-timestep oil MBE terms (F, Eo, Eg, Efw, Et) plus the initial-PVT meta
 * the solver needs. Split out of computeOilMBE in MB1 (2026-07-18) and
 * exported so the validation harness can anchor the term math against a
 * single-step published truth (Ahmed REH 4th ed. Example 11-1 combined-drive
 * reservoir) that has too few rows for the regression solver. Pure function;
 * behavior is identical to the pre-split loop.
 */
export function computeOilPerTimestep(inputs: MBALInputs): {
  per_timestep: PerTimestepResult[];
  meta: {
    pi: number; T_f: number; Swi: number; cf: number; cw: number; m: number;
    api: number; gas_sg: number; Pb: number; Rsi: number; Boi: number;
    Bti: number; Bwi: number; Bgi_rb_scf: number;
    pbRsBoCorr: 'standing' | 'vasquez_beggs' | 'glaso';
    zCorr: 'hall_yarborough' | 'dranchuk_abou_kassem';
    waterCorr: 'mccain';
  };
} {
  const pi = inputs.initial_pressure_psia;
  const T_f = inputs.reservoir_temperature_f;
  const Swi = inputs.initial_water_saturation;
  const cf = inputs.formation_compressibility_psi;
  const cw = inputs.water_compressibility_psi;
  const m = inputs.gas_cap_ratio_m ?? 0;
  const api = inputs.oil_gravity_api ?? 35;
  const gas_sg = inputs.gas_specific_gravity ?? 0.7;
  const Pb = inputs.bubble_point_psia ?? pi;

  const oil_sg = 141.5 / (api + 131.5);

  // Capsule 4C: select PVT correlations
  const pbRsBoCorr = inputs.pvt_correlations?.pb_rs_bo ?? 'standing';
  const zCorr = inputs.pvt_correlations?.z_factor ?? 'hall_yarborough';
  const waterCorr = inputs.pvt_correlations?.water ?? 'mccain';

  // Dispatchers — precedence: lab-table → correlation. (Per-row PVT is
  // resolved at call sites before invoking the dispatcher.)
  const rsAt = (p: number, pb: number): number => {
    const labRs = interpolateLabTable(inputs.pvt_lab_table, p, 'rs_scf_stb');
    if (labRs != null) return labRs;
    if (pbRsBoCorr === 'vasquez_beggs') return vasquezBeggsRs(p, pb, gas_sg, api, T_f);
    if (pbRsBoCorr === 'glaso')         return glasoRs(p, pb, gas_sg, api, T_f);
    return standingRs(p, pb, gas_sg, api, T_f);
  };
  const boSatAt = (rs: number, p?: number): number => {
    // If a lab table is provided and the pressure for which we're computing Bo
    // is within the table's range, use interpolated Bo directly. Otherwise
    // call the correlation Bob(rs).
    if (p != null) {
      const labBo = interpolateLabTable(inputs.pvt_lab_table, p, 'bo_rb_stb');
      if (labBo != null) return labBo;
    }
    if (pbRsBoCorr === 'vasquez_beggs') return vasquezBeggsBoSat(rs, gas_sg, api, T_f);
    if (pbRsBoCorr === 'glaso')         return glasoBoSat(rs, gas_sg, oil_sg, T_f);
    return standingBoSat(rs, gas_sg, oil_sg, T_f);
  };
  const zForGasCap = (p: number): number => {
    const labZ = interpolateLabTable(inputs.pvt_lab_table, p, 'z_factor');
    if (labZ != null) return labZ;
    const ppc = 756.8 - 131.0 * gas_sg - 3.6 * gas_sg * gas_sg;
    const tpc = 169.2 + 349.5 * gas_sg - 74.0 * gas_sg * gas_sg;
    const T_r = T_f + 459.67;
    const ppr = p / ppc;
    const tpr = T_r / tpc;
    if (zCorr === 'dranchuk_abou_kassem') return dranchukAbouKassemZ(ppr, tpr);
    return hallYarboroughZ(ppr, tpr);
  };
  // Bw: lab-table → McCain → legacy bwApprox
  const bwAt = (p: number, bwi: number): number => {
    const labBw = interpolateLabTable(inputs.pvt_lab_table, p, 'bw_rb_stb');
    if (labBw != null) return labBw;
    if (waterCorr === 'mccain') return mccainBw(p, T_f);
    return bwApprox(bwi, p, pi, cw);
  };

  // Initial PVT
  const t0 = inputs.production_data[0];
  const Rsi = t0.rs_scf_stb ?? rsAt(Math.min(pi, Pb), Pb);
  const Boi = t0.bo_rb_stb ?? boSatAt(Rsi, Math.min(pi, Pb));
  const Bti = Boi;  // At initial conditions, Bt = Bo (no free gas yet)
  const Bwi = t0.bw_rb_stb ?? 1.0;

  // Gas PVT initial — only relevant if has_gas_cap or below-bubble production
  let Bgi_rb_scf = 0;
  if (m > 0 || pi < Pb) {
    if (t0.bg_rb_mscf != null) {
      // Honor lab Bgi if supplied
      Bgi_rb_scf = t0.bg_rb_mscf / SCF_PER_MSCF;
    } else if (t0.bg_rb_scf != null) {
      // MB1: RB/scf form honored too (see per-row Bg precedence note below)
      Bgi_rb_scf = t0.bg_rb_scf;
    } else {
      const zi = t0.z_factor ?? zForGasCap(pi);
      Bgi_rb_scf = bgRbPerScf(pi, T_f, zi);
    }
  }

  const per_timestep: PerTimestepResult[] = [];
  for (const point of inputs.production_data) {
    const p = point.pressure_psia;
    const dp = pi - p;

    // PVT at p
    let Rs: number;
    let Bo: number;
    if (point.rs_scf_stb != null && point.bo_rb_stb != null) {
      Rs = point.rs_scf_stb;
      Bo = point.bo_rb_stb;
    } else if (p >= Pb) {
      Rs = Rsi;
      // Undersaturated: Bo decreases slightly with pressure (oil compressibility)
      const Bob = boSatAt(Rsi, Pb);
      // Undersaturated oil compressibility placeholder. The proper Vasquez-Beggs
      // co correlation lands when Phase 5 needs co for forecast math.
      const co = 1e-5;
      Bo = Bob * (1 - co * (p - Pb));
    } else {
      Rs = rsAt(p, Pb);
      Bo = boSatAt(Rs, p);
    }

    // Gas PVT at p (only needed if there's free gas in the reservoir)
    let Bg_rb_scf = 0;
    let z = 1.0;
    if (m > 0 || p < Pb) {
      // Bg precedence: per-row (RB/Mscf, then RB/scf) → lab-table → z-derived.
      // MB1 (2026-07-18): honor bg_rb_scf on input points too. It was silently
      // ignored before (only the result type used it), so per-row Bg supplied
      // in RB/scf fell through to the correlation.
      if (point.bg_rb_mscf != null) {
        Bg_rb_scf = point.bg_rb_mscf / SCF_PER_MSCF;
        z = point.z_factor ?? 1.0;
      } else if (point.bg_rb_scf != null) {
        Bg_rb_scf = point.bg_rb_scf;
        z = point.z_factor ?? 1.0;
      } else {
        const labBg_mscf = interpolateLabTable(inputs.pvt_lab_table, p, 'bg_rb_mscf');
        if (labBg_mscf != null) {
          Bg_rb_scf = labBg_mscf / SCF_PER_MSCF;
          z = point.z_factor ?? interpolateLabTable(inputs.pvt_lab_table, p, 'z_factor') ?? 1.0;
        } else {
          z = point.z_factor ?? zForGasCap(p);
          Bg_rb_scf = bgRbPerScf(p, T_f, z);
        }
      }
    }

    const Bw = point.bw_rb_stb ?? bwAt(p, Bwi);

    // Bt = Bo + Bg·(Rsi - Rs)  — two-phase oil formation volume factor
    const Bt = Bo + Bg_rb_scf * SCF_PER_MSCF * (Rsi - Rs) / SCF_PER_MSCF;  // simplified: Bg_rb_scf * (Rsi - Rs)
    // Note: (Rsi - Rs) is scf/STB; multiplied by Bg [RB/scf] gives RB/STB. Correct.

    // F = Np·[Bt + Bg·(Rp - Rsi)] + Wp·Bw
    const Np_stb = point.cum_oil_stb ?? 0;
    const Gp_scf = point.cum_gas_scf ?? 0;
    const Wp_stb = point.cum_water_stb ?? 0;
    const Rp = Np_stb > 0 ? Gp_scf / Np_stb : Rsi;
    const F_rb = Np_stb * (Bt + Bg_rb_scf * (Rp - Rsi)) + Wp_stb * Bw;

    // Eo = Bt - Bti
    const Eo = Bt - Bti;

    // Eg = Bti/Bgi · (Bg - Bgi)   — Pletcher Eq. 23
    // Only meaningful if there's a gas cap (m > 0) or free gas present
    const Eg_oil = (Bgi_rb_scf > 0)
      ? (Bti / Bgi_rb_scf) * (Bg_rb_scf - Bgi_rb_scf)
      : 0;

    // Efw = Bti · (1+m) · (Swi·cw + cf)/(1-Swi) · (pi - p)
    // Same formula as for gas (Pletcher Eq. 4): (Swi·cw + cf), NOT Swi·(cw+cf).
    // The (1+m) factor accounts for the gas cap (m = initial gas cap / initial oil).
    const Efw = Bti * (1 + m) * (Swi * cw + cf) / (1 - Swi) * dp;

    // Et = Eo + m·Eg + Efw
    const Et = Eo + m * Eg_oil + Efw;

    per_timestep.push({
      timestep_index: point.timestep_index,
      pressure_psia: p,
      delta_p_psi: dp,
      bo_rb_stb: Bo,
      rs_scf_stb: Rs,
      bg_rb_scf: Bg_rb_scf,
      bg_rb_mscf: Bg_rb_scf * SCF_PER_MSCF,
      bw_rb_stb: Bw,
      z_factor: z,
      F_rb,
      Eo_rb_stb: Eo,
      Eg_rb_stb: Eg_oil,
      Efw_rb: Efw,
      Et_rb: Et,
    });
  }

  return {
    per_timestep,
    meta: {
      pi, T_f, Swi, cf, cw, m, api, gas_sg, Pb, Rsi, Boi, Bti, Bwi,
      Bgi_rb_scf, pbRsBoCorr, zCorr, waterCorr,
    },
  };
}

function computeOilMBE(inputs: MBALInputs): MBALResult {
  const { per_timestep, meta } = computeOilPerTimestep(inputs);
  const {
    pi, T_f, Swi, cf, cw, m, api, gas_sg, Pb, Rsi, Bti,
    pbRsBoCorr, zCorr, waterCorr,
  } = meta;

  // ==========================================================================
  // Solve for OOIP: regression depends on aquifer_model.
  //
  // No aquifer (none):       F = N·Et         → slope = N
  // Pot aquifer (pot):       F = N·Et + (cw+cf)·W·(pi-p)
  //                          F/Et = N + (cw+cf)·W·(pi-p)/Et
  //   (See oil pot branch below — uses F/Eo, not F/Et, per Pletcher derivation)
  //
  // Fetkovich, Carter-Tracy: We[n] computed from user-supplied parameters via
  //                          marching scheme. Then regress (F - We) vs Et
  //                          through origin → slope = N.
  // ==========================================================================
  const aquiferModel = inputs.aquifer_model ?? 'none';

  const excluded = new Set(inputs.excluded_timesteps ?? []);
  const aquifer_default_notes: string[] = [];
  let N_stb: number;
  let W_rb: number | null = null;
  let reg: { slope: number; intercept: number; r_squared: number; n: number };

  if (aquiferModel === 'pot') {
    // ─── Pot aquifer plot (Pletcher Eq. 13 oil version, generalized m ≥ 0) ───
    // Derivation: F = N·Eo + N·m·Eg + N·(1+m)·Efw' + (cw+cf)·W·(pi-p)
    // Group the pressure-proportional terms. With Em = Eo + m·Eg (the fluid
    // expansion excluding rock/water) and Efw = Bti·(1+m)·(Swi·cw+cf)/(1-Swi)·(pi-p):
    //   F/Em = N + [N·Bti·(1+m)·(Swi·cw+cf)/(1-Swi) + (cw+cf)·W]·(pi-p)/Em
    // Plot F/Em vs (pi-p)/Em → intercept = N, slope = bracketed term.
    // Solve for W (Pletcher Eq. 14 oil-form, generalized):
    //   W = [slope - N·Bti·(1+m)·(Swi·cw+cf)/(1-Swi)] / (cw+cf)
    //
    // For m = 0 this is EXACTLY the pre-MB1 formulation (Em = Eo, factor 1),
    // so the Pletcher Tables 10-13 benchmark (CASE 2) is unchanged. The m > 0
    // generalization is validated by CASE 9 (Ahmed REH 4th ed. Example 11-1
    // combined-drive terms) plus the synthetic round-trip identity.
    //
    // The Et-based regression we used earlier doesn't match Pletcher because
    // Et already absorbs Efw into the denominator, distorting the line.
    const regression_x: number[] = [];
    const regression_y: number[] = [];
    for (const r of per_timestep) {
      if (r.timestep_index === 0) continue;
      if (excluded.has(r.timestep_index)) continue;
      const Em_val = (r.Eo_rb_stb ?? 0) + m * (r.Eg_rb_stb ?? 0);
      if (Em_val <= 0) continue;
      regression_x.push(r.delta_p_psi / Em_val);
      regression_y.push(r.F_rb / Em_val);
    }
    if (regression_x.length < 2) {
      throw new Error(
        `Pot aquifer plot for oil needs at least 2 valid timesteps below the initial state. After excluding the initial timestep and any user-excluded timesteps, only ${regression_x.length} remained. Add more production data observations or reduce the excluded_timesteps list.`,
      );
    }
    reg = linearRegression(regression_x, regression_y);
    N_stb = reg.intercept;
    // slope = N·Bti·(1+m)·(Swi·cw+cf)/(1-Swi) + (cw+cf)·W
    // → W = [slope - N·Bti·(1+m)·(Swi·cw+cf)/(1-Swi)] / (cw+cf)
    const expansion_term = N_stb * Bti * (1 + m) * (Swi * cw + cf) / (1 - Swi);
    W_rb = (reg.slope - expansion_term) / (cw + cf);

    // Compute We at each timestep (Pletcher Eq. 12)
    for (const r of per_timestep) {
      r.We_rb = (cw + cf) * (W_rb as number) * r.delta_p_psi;
    }

  } else if (aquiferModel === 'fetkovich' || aquiferModel === 'carter_tracy') {
    // ─── Time-dependent aquifer: compute We[] from user-supplied parameters ───
    const deltas = extractTimedeltasDays(inputs.production_data);
    const We_array = aquiferModel === 'fetkovich'
      ? computeFetkovichWe(inputs, deltas)
      : computeCarterTracyWe(inputs, deltas, aquifer_default_notes);
    // Assign We per timestep
    for (let i = 0; i < per_timestep.length; i++) {
      per_timestep[i].We_rb = We_array[i];
    }
    // Regress (F - We) vs Et through origin: slope = N
    const regression_x: number[] = [];
    const regression_y: number[] = [];
    for (let i = 0; i < per_timestep.length; i++) {
      const r = per_timestep[i];
      if (r.timestep_index === 0) continue;
      if (excluded.has(r.timestep_index)) continue;
      if (r.Et_rb <= 0) continue;
      regression_x.push(r.Et_rb);
      regression_y.push(r.F_rb - We_array[i]);
    }
    if (regression_x.length < 2) {
      throw new Error(
        `${aquiferModel} regression for oil needs at least 2 valid timesteps after excluding the initial timestep and user-excluded points. Only ${regression_x.length} remained.`,
      );
    }
    reg = linearRegression(regression_x, regression_y);
    N_stb = reg.slope; // through origin: F-We = N·Et
    // Report the user-supplied W (not derived from slope)
    W_rb = inputs.aquifer_params?.initial_aquifer_water_in_place_rb ?? null;

  } else {
    // ─── No aquifer: F = N·Et (line through origin) ───
    const regression_x: number[] = [];
    const regression_y: number[] = [];
    for (const r of per_timestep) {
      if (r.timestep_index === 0) continue;
      if (excluded.has(r.timestep_index)) continue;
      if (r.Et_rb <= 0) continue;
      regression_x.push(r.Et_rb);
      regression_y.push(r.F_rb);
    }
    if (regression_x.length < 2) {
      throw new Error(
        `Havlena-Odeh regression needs at least 2 valid timesteps below the initial state. After excluding the initial timestep and any user-excluded timesteps, only ${regression_x.length} remained. Add more production data observations or reduce the excluded_timesteps list.`,
      );
    }
    reg = linearRegression(regression_x, regression_y);
    N_stb = reg.slope;
    // We stays at 0 for all timesteps (no aquifer)
    for (const r of per_timestep) {
      r.We_rb = 0;
    }
  }

  // ==========================================================================
  // Drive indices for oil
  // DDI = N·Eo / (F)             (depletion drive, oil expansion)
  // SDI = N·Efw / (F)            (rock+water compressibility drive)
  // GDI = N·m·Eg / (F)           (gas cap drive)
  // WDI = (We - Wp·Bw) / F       (water drive)
  // For Phase 1 with no aquifer, We = 0 so WDI = -Wp·Bw/F (usually small)
  // ==========================================================================
  for (let i = 0; i < per_timestep.length; i++) {
    const r = per_timestep[i];
    const point = inputs.production_data[i];
    if (r.timestep_index === 0 || r.F_rb <= 0) {
      r.ddi = 0; r.sdi = 0; r.gdi = 0; r.wdi = 0; r.drive_index_sum = 0;
      continue;
    }
    r.ddi = (N_stb * (r.Eo_rb_stb ?? 0)) / r.F_rb;
    r.sdi = (N_stb * r.Efw_rb) / r.F_rb;
    r.gdi = (N_stb * m * (r.Eg_rb_stb ?? 0)) / r.F_rb;
    const Wp_stb = point.cum_water_stb ?? 0;
    r.wdi = ((r.We_rb ?? 0) - Wp_stb * (r.bw_rb_stb ?? 1)) / r.F_rb;
    r.drive_index_sum = r.ddi + r.sdi + r.gdi + r.wdi;
  }

  const last = per_timestep[per_timestep.length - 1];

  const drive_mechanism = classifyDriveMechanismOil(
    last.ddi ?? 0, last.gdi ?? 0, last.wdi ?? 0
  );
  const aquifer_strength = classifyAquiferStrength(last.wdi ?? 0);

  // ──────────────────────────────────────────────────────────────────────────
  // Warnings
  //
  // Validated oil paths (harness tools/validation/mbal-validation.ts):
  //   • oil + pot aquifer + no gas cap (m=0): Pletcher SPE 75354 Tables
  //     10-13 (Capsule 3A, 1.79% OOIP error vs paper).
  //   • oil + no aquifer + no gas cap (m=0): Tarek Ahmed (2010) Example
  //     11-3, Virginia Hills Beaverhill Lake (Phase 5 chunk 1, 2026-05-17).
  //   • oil + no aquifer + gas cap (m>0): Dake (1978) Exercise 3.4
  //     'GASCAP DRIVE' (Phase 5 chunk 2, 2026-05-17). Engine LSQ 115.5 MM
  //     STB vs Dake 114 MM STB (1.33%); m=0.5 input.
  //   • oil + fetkovich (MB1, 2026-07-18): Ahmed REH 4th ed. Example 10-10
  //     printed We table (CASE 8) + Dake 9.2 full-path OOIP.
  //   • oil + pot aquifer + gas cap (m>0) (MB1, 2026-07-18): Ahmed REH
  //     4th ed. Example 11-1 combined-drive terms and printed drive
  //     indexes (CASE 9); the generalized m>0 pot regression is gated by
  //     an exact synthetic round trip.
  // ──────────────────────────────────────────────────────────────────────────
  const warnings: string[] = [];
  warnings.push(...aquifer_default_notes);

  if (last.drive_index_sum != null && Math.abs(last.drive_index_sum - 1.0) > 0.05) {
    warnings.push(
      `Drive index sum at final timestep is ${last.drive_index_sum.toFixed(3)} ` +
      `(expected ~1.00 ± 0.05). Possible material balance solution issue.`
    );
  }
  if (reg.r_squared < 0.95) {
    warnings.push(`Regression R²=${reg.r_squared.toFixed(4)} is low; data may have scatter or wrong drive mechanism.`);
  }

  // Capsule 4C: correlation-validity warnings for oil-side correlations.
  // For oil cases, Tpr/Ppr only matter when there's a gas cap or below-Pb path.
  const oilCondTpr = (m > 0 || pi < Pb)
    ? (T_f + 459.67) / (169.2 + 349.5 * gas_sg - 74.0 * gas_sg * gas_sg)
    : undefined;
  const oilCondPprMax = (m > 0 || pi < Pb)
    ? pi / (756.8 - 131.0 * gas_sg - 3.6 * gas_sg * gas_sg)
    : undefined;
  const oilCvWarnings = correlationValidityWarnings(
    pbRsBoCorr,
    zCorr,
    waterCorr,
    { pi, temp_f: T_f, api, gas_sg, ppr_max: oilCondPprMax, tpr: oilCondTpr },
  );
  warnings.push(...oilCvWarnings);

  // Capsule 4C chunk (b): viscosity-correlation validity warnings.
  // Use max Rs (typically Rsi) to test against Beggs-Robinson upper bound.
  const rsMaxForCheck = (() => {
    let maxRs = 0;
    for (const point of inputs.production_data) {
      if (point.rs_scf_stb != null && point.rs_scf_stb > maxRs) maxRs = point.rs_scf_stb;
    }
    return maxRs > 0 ? maxRs : Rsi;
  })();
  const oilVisWarnings = viscosityValidityWarnings(
    inputs.pvt_correlations?.oil_viscosity ?? 'beggs_robinson',
    inputs.pvt_correlations?.gas_viscosity ?? 'lee_gonzalez_eakin',
    { pi, temp_f: T_f, api, gas_sg, rs_max: rsMaxForCheck },
  );
  warnings.push(...oilVisWarnings);

  // Capsule 4C chunk (b): lab-table structural warnings.
  warnings.push(...validateLabTable(inputs.pvt_lab_table));

  const tier = resolveValidationTier('oil', aquiferModel, m > 0);

  return {
    estimated_ooip_stb: N_stb,
    aquifer_owip_rb: W_rb ?? undefined,
    // 2026-05-17: widened condition so Carter-Tracy and Fetkovich oil cases
    // also expose final We. Previously gated on W_rb !== null, which was only
    // true for the pot-aquifer regression path. The per-timestep last.We_rb
    // is computed correctly for all aquifer models; only this guard was wrong.
    aquifer_cumulative_we_rb: (
      W_rb !== null
      || aquiferModel === 'carter_tracy'
      || aquiferModel === 'fetkovich'
    ) ? (last.We_rb ?? 0) : undefined,
    r_squared: reg.r_squared,
    regression_slope: reg.slope,
    regression_intercept: reg.intercept,
    n_data_points: reg.n,
    final_ddi: last.ddi,
    final_gdi: last.gdi,
    final_wdi: last.wdi,
    final_sdi: last.sdi,
    final_cdi: last.sdi,  // For oil, the rock+water compressibility drive is in sdi
    final_drive_index_sum: last.drive_index_sum,
    drive_mechanism,
    aquifer_strength,
    warnings,
    validation_tier: tier.tier,
    validation_reference: tier.reference,
    validation_tolerance_pct: tier.tolerance_pct,
    per_timestep,
    engine_version: ENGINE_VERSION,
  };
}

// ============================================================================
// CLASSIFICATION HELPERS
// ============================================================================

function classifyDriveMechanismGas(gdi: number, cdi: number, wdi: number): string {
  if (gdi > 0.85) return 'gas_expansion_drive';
  if (wdi > 0.5) return 'strong_water_drive';
  if (wdi > 0.2) return 'moderate_water_drive';
  if (wdi > 0.02) return 'weak_water_drive';
  if (cdi > 0.1) return 'rock_water_compressibility_drive';
  return 'gas_expansion_drive';
}

function classifyDriveMechanismOil(ddi: number, gdi: number, wdi: number): string {
  if (wdi > 0.5) return 'strong_water_drive';
  if (gdi > 0.5) return 'gas_cap_drive';
  if (wdi > 0.2) return 'water_drive_with_depletion';
  if (gdi > 0.2) return 'combination_drive';
  return 'depletion_drive';
}

function classifyAquiferStrength(wdi: number): string {
  if (wdi <= 0.02) return 'none';
  if (wdi <= 0.15) return 'weak';
  if (wdi <= 0.4) return 'moderate';
  return 'strong';
}

// ============================================================================
// PUBLIC PVT PREVIEW API (Phase 3)
// ============================================================================
//
// generatePvtTable() exposes the engine's internal PVT correlations as a public
// surface for the UI's PVT preview. This replaces the parallel implementation in
// src/utils/pvtCalculations.js so the UI preview and the engine's actual run
// use identical correlations — no silent divergence.
//
// Wired through the Edge Function `generate-pvt-preview/index.ts` (Phase 3
// Artifact 3). Frontend caller: PvtRock.jsx after Phase 3 wiring.
//
// Design notes:
//   - Returns rows shaped to match what the existing PvtRock UI expects
//     ({pressure, Bo, Rs, Bg, oil_viscosity, z, gas_viscosity}) so the swap
//     is purely the data source, not the UI.
//   - Generates a pressure range spanning roughly the operating envelope
//     (from a low value up through bubble point or initial pressure).
//   - For oil cases: returns Bo, Rs, oil_viscosity. Bg only meaningful below Pb.
//   - For gas cases: returns z, Bg, gas_viscosity. Bo/Rs always zero.
//   - For oil_with_gas_cap: both oil and gas terms present.
//
// Future correlation switches (Vasquez-Beggs, Glaso, Beggs-Robinson, etc.)
// land here when their engine-side internal functions are added.

export interface PvtPreviewInputs {
  fluid_system: FluidSystem;
  oil_gravity_api?: number;
  gas_specific_gravity?: number;
  reservoir_temperature_f: number;
  bubble_point_psia?: number;
  initial_pressure_psia?: number;
  // Defaults applied if missing:
  pvt_correlations?: Partial<PVTCorrelations>;
  // Pressure-range overrides (optional):
  pressure_min_psia?: number;
  pressure_max_psia?: number;
  n_steps?: number;
}

export interface PvtPreviewRow {
  pressure_psia: number;
  Bo: number | null;           // RB/STB; null if not applicable
  Rs: number | null;           // scf/STB
  Bg: number | null;           // RB/Mscf (display unit)
  z: number | null;            // dimensionless
  oil_viscosity_cp: number | null;
  gas_viscosity_cp: number | null;
  Bw: number | null;           // RB/STB
  is_above_bubble_point: boolean;
}

export interface PvtPreviewResult {
  rows: PvtPreviewRow[];
  metadata: {
    fluid_system: FluidSystem;
    pb_psia: number | null;
    correlations_used: PVTCorrelations;
    n_rows: number;
    pressure_range_psia: [number, number];
  };
  warnings: string[];
}

/**
 * Generate a PVT property table over a pressure range for UI preview.
 *
 * This is a PURE function — no I/O, no engine internals exposed to caller.
 * Phase 3 implementation: Standing/Hall-Yarborough only. Phase 4+ adds
 * the other correlation paths (Vasquez-Beggs, Glaso, Beggs-Robinson, etc.).
 */
export function generatePvtTable(inputs: PvtPreviewInputs): PvtPreviewResult {
  const warnings: string[] = [];

  // ──────────────────────────────────────────────────────────────────────────
  // Resolve correlation defaults
  // ──────────────────────────────────────────────────────────────────────────
  const correlations: PVTCorrelations = {
    pb_rs_bo: inputs.pvt_correlations?.pb_rs_bo ?? 'standing',
    oil_viscosity:
      inputs.pvt_correlations?.oil_viscosity ?? 'beggs_robinson',
    z_factor: inputs.pvt_correlations?.z_factor ?? 'hall_yarborough',
    water: inputs.pvt_correlations?.water ?? 'mccain',
    gas_viscosity:
      inputs.pvt_correlations?.gas_viscosity ?? 'lee_gonzalez_eakin',
  };

  // Capsule 4C: validity-range warnings for the selected correlations.
  // generatePvtTable supports the full correlation library — no fallbacks.
  const T_f_for_cv = inputs.reservoir_temperature_f;
  const gas_sg_for_cv = inputs.gas_specific_gravity ?? (inputs.fluid_system === 'gas' ? 0.65 : 0.75);
  const ppc_for_cv = 756.8 - 131.0 * gas_sg_for_cv - 3.6 * gas_sg_for_cv * gas_sg_for_cv;
  const tpc_for_cv = 169.2 + 349.5 * gas_sg_for_cv - 74.0 * gas_sg_for_cv * gas_sg_for_cv;
  const pi_for_cv = inputs.initial_pressure_psia ?? inputs.pressure_max_psia ?? 5000;
  const tpr_for_cv = (T_f_for_cv + 459.67) / tpc_for_cv;
  const ppr_max_for_cv = pi_for_cv / ppc_for_cv;
  const cvWarnings = correlationValidityWarnings(
    correlations.pb_rs_bo,
    correlations.z_factor,
    correlations.water,
    {
      pi: pi_for_cv,
      temp_f: T_f_for_cv,
      api: inputs.oil_gravity_api,
      gas_sg: gas_sg_for_cv,
      ppr_max: ppr_max_for_cv,
      tpr: tpr_for_cv,
    },
  );
  warnings.push(...cvWarnings);

  // Capsule 4C chunk (b): viscosity correlations in the preview.
  const visPreviewWarnings = viscosityValidityWarnings(
    correlations.oil_viscosity,
    correlations.gas_viscosity,
    {
      pi: pi_for_cv,
      temp_f: T_f_for_cv,
      api: inputs.oil_gravity_api,
      gas_sg: gas_sg_for_cv,
    },
  );
  warnings.push(...visPreviewWarnings);

  // ──────────────────────────────────────────────────────────────────────────
  // Resolve inputs
  // ──────────────────────────────────────────────────────────────────────────
  const fluid = inputs.fluid_system;
  const T_f = inputs.reservoir_temperature_f;
  const api = inputs.oil_gravity_api ?? 35;
  const gas_sg = inputs.gas_specific_gravity ?? (fluid === 'gas' ? 0.65 : 0.75);
  const oil_sg = 141.5 / (api + 131.5);

  // Determine bubble point. For oil: use user input or compute Pb assuming
  // some Rs value. For gas: not applicable.
  let pb: number | null = inputs.bubble_point_psia ?? null;

  // Pressure range: default 200 psia to 1.2× initial (or Pb)
  const p_max =
    inputs.pressure_max_psia ??
    (inputs.initial_pressure_psia
      ? inputs.initial_pressure_psia * 1.05
      : pb
      ? pb * 1.5
      : 5000);
  const p_min = inputs.pressure_min_psia ?? Math.max(200, p_max * 0.05);
  const n_steps = inputs.n_steps ?? 30;

  if (p_min >= p_max) {
    throw new Error(
      `Invalid pressure range: p_min (${p_min}) >= p_max (${p_max})`,
    );
  }

  // Pseudo-critical properties (Sutton 1985) for z-factor correlations
  const ppc = 756.8 - 131.0 * gas_sg - 3.6 * gas_sg * gas_sg;
  const tpc = 169.2 + 349.5 * gas_sg - 74.0 * gas_sg * gas_sg;
  const T_r = T_f + 459.67;

  // Capsule 4C: correlation dispatchers — same pattern as MBE-side
  const previewRs = (p: number, pb_use: number): number => {
    if (correlations.pb_rs_bo === 'vasquez_beggs') return vasquezBeggsRs(p, pb_use, gas_sg, api, T_f);
    if (correlations.pb_rs_bo === 'glaso')         return glasoRs(p, pb_use, gas_sg, api, T_f);
    return standingRs(p, pb_use, gas_sg, api, T_f);
  };
  const previewBoSat = (rs: number): number => {
    if (correlations.pb_rs_bo === 'vasquez_beggs') return vasquezBeggsBoSat(rs, gas_sg, api, T_f);
    if (correlations.pb_rs_bo === 'glaso')         return glasoBoSat(rs, gas_sg, oil_sg, T_f);
    return standingBoSat(rs, gas_sg, oil_sg, T_f);
  };
  const previewPb = (rs: number): number => {
    if (correlations.pb_rs_bo === 'vasquez_beggs') return vasquezBeggsPb(rs, gas_sg, api, T_f);
    if (correlations.pb_rs_bo === 'glaso')         return glasoPb(rs, gas_sg, api, T_f);
    return standingPb(rs, gas_sg, api, T_f);
  };
  const previewZ = (p: number): number => {
    const ppr = p / ppc;
    const tpr = T_r / tpc;
    if (correlations.z_factor === 'dranchuk_abou_kassem') return dranchukAbouKassemZ(ppr, tpr);
    return hallYarboroughZ(ppr, tpr);
  };
  const previewBw = (p: number): number => {
    if (correlations.water === 'mccain') return mccainBw(p, T_f);
    return bwApprox(1.0, p, p_max, 3e-6);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Generate rows
  // ──────────────────────────────────────────────────────────────────────────
  const rows: PvtPreviewRow[] = [];
  const dp = (p_max - p_min) / (n_steps - 1);

  for (let i = 0; i < n_steps; i++) {
    const p = p_min + dp * i;

    let Bo: number | null = null;
    let Rs: number | null = null;
    let Bg: number | null = null;
    let z: number | null = null;
    let oil_visc: number | null = null;
    let gas_visc: number | null = null;
    let is_above_pb = false;

    // ── Oil-side properties ──
    if (fluid === 'oil' || fluid === 'oil_with_gas_cap') {
      // If no Pb provided, compute it from an assumed Rsb at max pressure
      // (this is a fallback so preview is non-empty even without Pb)
      if (pb === null) {
        // Assume Rsb such that Pb = p_max (i.e. bubble point at top of range)
        Rs = previewRs(p_max, p_max);
        pb = previewPb(Rs);
      }

      if (p >= pb) {
        // Above bubble point: Rs = Rsb (constant); Bo declines slightly
        is_above_pb = true;
        Rs = previewRs(pb, pb);
        const Bob = previewBoSat(Rs);
        // Simple undersaturated Bo (more sophisticated correlation in later phase)
        const co = 1.5e-5; // typical for undersaturated oil
        Bo = Bob * Math.exp(-co * (p - pb));
      } else {
        Rs = previewRs(p, pb);
        Bo = previewBoSat(Rs);
      }

      // Oil viscosity: Beal dead-oil + Beggs-Robinson live-oil chain;
      // Vasquez-Beggs undersaturated correction above bubble point.
      // Capsule 4C chunk (b).
      const muod = bealDeadOilViscosity(api, T_f);
      if (Rs != null) {
        if (is_above_pb && pb != null) {
          // Above Pb: μ_o = undersaturated correction on μ_o at Pb
          const Rsb = previewRs(pb, pb);
          const mu_ob = beggsRobinsonLiveOilViscosity(Rsb, muod);
          oil_visc = vasquezBeggsUndersaturatedOilViscosity(p, pb, mu_ob);
        } else {
          oil_visc = beggsRobinsonLiveOilViscosity(Rs, muod);
        }
      } else {
        oil_visc = muod;  // fallback to dead-oil if Rs unknown
      }
    }

    // ── Gas-side properties ──
    if (fluid === 'gas' || fluid === 'oil_with_gas_cap') {
      z = previewZ(p);
      const bg_rb_scf = bgRbPerScf(p, T_f, z);
      Bg = bg_rb_scf * 1000; // RB/Mscf for display
      // Lee-Gonzalez-Eakin gas viscosity (Capsule 4C chunk b).
      gas_visc = leeGonzalezEakinGasViscosity(p, T_f, gas_sg, z);
    }

    // ── Water ──
    const Bw = previewBw(p);

    rows.push({
      pressure_psia: Math.round(p * 100) / 100,
      Bo,
      Rs,
      Bg,
      z,
      oil_viscosity_cp: oil_visc,
      gas_viscosity_cp: gas_visc,
      Bw,
      is_above_bubble_point: is_above_pb,
    });
  }

  return {
    rows,
    metadata: {
      fluid_system: fluid,
      pb_psia: pb,
      correlations_used: correlations,
      n_rows: rows.length,
      pressure_range_psia: [p_min, p_max],
    },
    warnings,
  };
}

// ============================================================================
// MB5 — PRESSURE HISTORY MATCH (inverse MBE + Levenberg-Marquardt)
// ============================================================================
//
// The regression paths above answer "given the observed pressures, what N (or
// G) best explains the voidage?". The history match inverts the tank model
// the other way: "given candidate parameters, what pressure history would the
// tank have produced?" and then adjusts the parameters until the simulated
// pressures reproduce the observed ones.
//
// Forward simulation: at each timestep k the cumulative withdrawals are
// known, so the material balance F(p) = N·Et(p) + We is a scalar equation in
// the unknown pressure p. F and Et are evaluated through the SAME per-timestep
// code the regression uses (computeOilPerTimestep / computeGasPerTimestep on
// a two-point [t0, candidate] series), so PVT precedence (per-row → lab table
// → correlation) is identical by construction. The scalar root is found by a
// safeguarded false-position (Illinois) search on p.
//
// Aquifer coupling: pot We is a pointwise function of p and is solved inside
// the root search. Fetkovich and Carter-Tracy We depend on the whole pressure
// history (marching schemes — and Carter-Tracy's van Everdingen Δp convention
// even references the NEXT observation), so the simulator iterates a fixed
// point: solve all steps with We frozen, recompute We from the full simulated
// series via the engine's own computeFetkovichWe/computeCarterTracyWe, repeat
// until the series stops moving. This keeps the simulated history exactly
// consistent with the We conventions of the forward (regression) path.
//
// Parameter estimation: Levenberg-Marquardt (shared kernel lm.ts, the
// jest-pinned port of the Well Test Analysis Studio auto-match) on
// ln-transformed parameters (all are strictly positive; the log transform is
// the same positivity mechanism the WTA model catalog uses), minimizing
// (p_observed − p_simulated) over the non-excluded timesteps. 95% confidence
// intervals come from the LM covariance at the optimum, exp-mapped back to
// value space.

export type HistoryMatchParameterKey =
  | 'stoiip_stb'              // N — oil and oil-with-gas-cap cases
  | 'ogip_scf'                // G — gas cases
  | 'gas_cap_m'               // m — oil with gas cap
  | 'aquifer_w_rb'            // W — pot and Fetkovich water in place
  | 'aquifer_j_rb_d_psi'      // J — Fetkovich productivity index
  | 'aquifer_radius_ft'       // r_R — Carter-Tracy reservoir radius
  | 'aquifer_permeability_md'; // k_aq — Carter-Tracy aquifer permeability

export interface HistoryMatchOptions {
  // Which parameters LM adjusts. Default: the fluid-in-place scale plus the
  // case's aquifer shape parameters (pot: W; Fetkovich: W and J;
  // Carter-Tracy: r_R). Keys not applicable to the case throw.
  fit_parameters?: HistoryMatchParameterKey[];
  // Value-space starting points. Default: the preliminary regression estimate
  // for N/G, the case's configured aquifer parameters otherwise.
  initial_guesses?: Partial<Record<HistoryMatchParameterKey, number>>;
  // Value-space box bounds. Defaults are wide multiples of the initial guess.
  bounds?: Partial<Record<HistoryMatchParameterKey, [number, number]>>;
  max_iterations?: number;    // LM iterations, default 30
}

export interface HistoryMatchedParameter {
  key: HistoryMatchParameterKey;
  label: string;
  unit: string;
  initial_value: number;
  matched_value: number;
  // Relative standard error in percent (exp-mapped from ln space); null when
  // the covariance is singular.
  std_error_pct: number | null;
  ci95_low: number | null;
  ci95_high: number | null;
  at_bound: boolean;
}

export interface HistoryMatchResult {
  matched_parameters: HistoryMatchedParameter[];
  // Full series aligned with production_data (index 0 = initial state).
  observed_pressure_psia: number[];
  simulated_pressure_psia: number[];
  residual_psi: number[];            // observed - simulated
  point_in_fit: boolean[];
  rms_error_psi: number;             // over fit points
  max_abs_error_psi: number;         // over fit points
  ssr_psi2: number;
  iterations: number;
  converged: boolean;
  matched_ooip_stb?: number;
  matched_ogip_scf?: number;
  // Full forward MBAL run at the matched parameters (drive indices, We
  // series, diagnostics). Note the regression inside it re-estimates N/G from
  // the OBSERVED pressures; the headline history-match numbers are
  // matched_ooip_stb / matched_ogip_scf above.
  forward: MBALResult;
  validation_tier: MBALResult['validation_tier'];
  validation_reference?: string;
  warnings: string[];
  engine_version: string;
}

interface HmParamSpec {
  label: string;
  unit: string;
  applies: (inputs: MBALInputs) => boolean;
  notApplicableHint: string;
  initial: (inputs: MBALInputs, prelim: MBALResult | null) => number | null;
  missingInitialHint: string;
  // Default value-space bounds as multiples of the initial guess, or absolute.
  defaultBounds: (initial: number) => [number, number];
}

const HM_PARAM_SPECS: Record<HistoryMatchParameterKey, HmParamSpec> = {
  stoiip_stb: {
    label: 'STOIIP N',
    unit: 'STB',
    applies: (i) => i.fluid_system !== 'gas',
    notApplicableHint: 'stoiip_stb applies to oil cases; use ogip_scf for gas cases.',
    initial: (_i, prelim) =>
      prelim?.estimated_ooip_stb != null && prelim.estimated_ooip_stb > 0
        ? prelim.estimated_ooip_stb
        : null,
    missingInitialHint:
      'The preliminary regression did not produce a positive OOIP to start from. Supply initial_guesses.stoiip_stb.',
    defaultBounds: (v) => [v / 100, v * 100],
  },
  ogip_scf: {
    label: 'OGIP G',
    unit: 'scf',
    applies: (i) => i.fluid_system === 'gas',
    notApplicableHint: 'ogip_scf applies to gas cases; use stoiip_stb for oil cases.',
    initial: (_i, prelim) =>
      prelim?.estimated_ogip_scf != null && prelim.estimated_ogip_scf > 0
        ? prelim.estimated_ogip_scf
        : null,
    missingInitialHint:
      'The preliminary regression did not produce a positive OGIP to start from. Supply initial_guesses.ogip_scf.',
    defaultBounds: (v) => [v / 100, v * 100],
  },
  gas_cap_m: {
    label: 'Gas cap ratio m',
    unit: 'fraction',
    applies: (i) =>
      i.fluid_system !== 'gas' && (i.has_gas_cap || (i.gas_cap_ratio_m ?? 0) > 0),
    notApplicableHint: 'gas_cap_m requires an oil case with a gas cap (has_gas_cap).',
    initial: (i) =>
      i.gas_cap_ratio_m != null && i.gas_cap_ratio_m > 0 ? i.gas_cap_ratio_m : 0.2,
    missingInitialHint: 'Supply initial_guesses.gas_cap_m.',
    defaultBounds: () => [1e-3, 10],
  },
  aquifer_w_rb: {
    label: 'Aquifer water in place W',
    unit: 'res bbl',
    applies: (i) =>
      i.has_aquifer && (i.aquifer_model === 'pot' || i.aquifer_model === 'fetkovich'),
    notApplicableHint:
      'aquifer_w_rb applies to pot and Fetkovich aquifers. Carter-Tracy is parameterized by geometry (aquifer_radius_ft, aquifer_permeability_md).',
    initial: (i, prelim) => {
      const configured = i.aquifer_params?.initial_aquifer_water_in_place_rb;
      if (configured != null && configured > 0) return configured;
      const regressed = prelim?.aquifer_owip_rb;
      return regressed != null && regressed > 0 ? regressed : null;
    },
    missingInitialHint:
      'Set the aquifer water in place in the Aquifer tab or supply initial_guesses.aquifer_w_rb.',
    defaultBounds: (v) => [v / 1000, v * 1000],
  },
  aquifer_j_rb_d_psi: {
    label: 'Aquifer productivity index J',
    unit: 'rb/d/psi',
    applies: (i) => i.has_aquifer && i.aquifer_model === 'fetkovich',
    notApplicableHint: 'aquifer_j_rb_d_psi applies to Fetkovich aquifers only.',
    initial: (i) => {
      const j = i.aquifer_params?.aquifer_pi_rb_d_psi;
      return j != null && j > 0 ? j : null;
    },
    missingInitialHint:
      'Set the aquifer productivity index in the Aquifer tab or supply initial_guesses.aquifer_j_rb_d_psi.',
    defaultBounds: (v) => [v / 1000, v * 1000],
  },
  aquifer_radius_ft: {
    label: 'Reservoir radius at the OWC r_R',
    unit: 'ft',
    applies: (i) => i.has_aquifer && i.aquifer_model === 'carter_tracy',
    notApplicableHint: 'aquifer_radius_ft applies to Carter-Tracy aquifers only.',
    initial: (i) => {
      const params = i.aquifer_params ?? {};
      if (params.aquifer_radius_ft != null && params.aquifer_radius_ft > 0) {
        return params.aquifer_radius_ft;
      }
      // Mirror the computeCarterTracyWe default chain (MB1): area-derived
      // wedge radius, else the legacy 2980 ft single-cell radius.
      if (params.reservoir_area_acres != null && params.reservoir_area_acres > 0) {
        const f_wedge = (params.theta_degrees ?? 360) / 360;
        return Math.sqrt((params.reservoir_area_acres * 43_560) / (Math.PI * f_wedge));
      }
      return 2980;
    },
    missingInitialHint: 'Supply initial_guesses.aquifer_radius_ft.',
    defaultBounds: (v) => [v / 30, v * 30],
  },
  aquifer_permeability_md: {
    label: 'Aquifer permeability',
    unit: 'md',
    applies: (i) => i.has_aquifer && i.aquifer_model === 'carter_tracy',
    notApplicableHint: 'aquifer_permeability_md applies to Carter-Tracy aquifers only.',
    initial: (i) => {
      const k = i.aquifer_params?.aquifer_permeability_md;
      return k != null && k > 0 ? k : null;
    },
    missingInitialHint:
      'Set aquifer permeability in the Aquifer tab or supply initial_guesses.aquifer_permeability_md.',
    defaultBounds: (v) => [v / 100, v * 100],
  },
};

/** Default fit set: the in-place scale plus the case's aquifer shape knobs. */
export function defaultHistoryMatchParameters(
  inputs: MBALInputs,
): HistoryMatchParameterKey[] {
  const keys: HistoryMatchParameterKey[] = [
    inputs.fluid_system === 'gas' ? 'ogip_scf' : 'stoiip_stb',
  ];
  if (inputs.has_aquifer) {
    if (inputs.aquifer_model === 'pot') keys.push('aquifer_w_rb');
    if (inputs.aquifer_model === 'fetkovich') {
      keys.push('aquifer_w_rb', 'aquifer_j_rb_d_psi');
    }
    if (inputs.aquifer_model === 'carter_tracy') keys.push('aquifer_radius_ft');
  }
  return keys;
}

/** Copy inputs with the fitted values written into their engine slots. */
function applyHmParams(
  inputs: MBALInputs,
  values: Partial<Record<HistoryMatchParameterKey, number>>,
): MBALInputs {
  const out: MBALInputs = {
    ...inputs,
    aquifer_params: { ...(inputs.aquifer_params ?? {}) },
  };
  if (values.gas_cap_m != null) out.gas_cap_ratio_m = values.gas_cap_m;
  if (values.aquifer_w_rb != null) {
    out.aquifer_params!.initial_aquifer_water_in_place_rb = values.aquifer_w_rb;
  }
  if (values.aquifer_j_rb_d_psi != null) {
    out.aquifer_params!.aquifer_pi_rb_d_psi = values.aquifer_j_rb_d_psi;
  }
  if (values.aquifer_radius_ft != null) {
    out.aquifer_params!.aquifer_radius_ft = values.aquifer_radius_ft;
  }
  if (values.aquifer_permeability_md != null) {
    out.aquifer_params!.aquifer_permeability_md = values.aquifer_permeability_md;
  }
  // stoiip_stb / ogip_scf are not engine inputs — they scale Et directly in
  // the simulator and are threaded through as `scale`.
  return out;
}

/**
 * Build an interpolation table from per-row lab PVT so the simulator can
 * evaluate PVT at pressures BETWEEN the observed rows. Per-row values are
 * keyed to the observed pressures, so they cannot be used directly at a
 * simulated pressure; interpolating through them preserves the lab data
 * (and reproduces the row values exactly when the simulated pressure lands
 * on an observed one). Returns undefined when no row carries lab PVT.
 */
function labTableFromRows(
  production_data: ProductionDataPoint[],
): PvtLabTableRow[] | undefined {
  const rows: PvtLabTableRow[] = [];
  for (const p of production_data) {
    const row: PvtLabTableRow = { pressure_psia: p.pressure_psia };
    let any = false;
    if (p.bo_rb_stb != null) { row.bo_rb_stb = p.bo_rb_stb; any = true; }
    if (p.rs_scf_stb != null) { row.rs_scf_stb = p.rs_scf_stb; any = true; }
    if (p.bg_rb_mscf != null) { row.bg_rb_mscf = p.bg_rb_mscf; any = true; }
    else if (p.bg_rb_scf != null) { row.bg_rb_mscf = p.bg_rb_scf * SCF_PER_MSCF; any = true; }
    if (p.bw_rb_stb != null) { row.bw_rb_stb = p.bw_rb_stb; any = true; }
    if (p.z_factor != null) { row.z_factor = p.z_factor; any = true; }
    if (any) rows.push(row);
  }
  if (rows.length < 2) return undefined;
  rows.sort((a, b) => a.pressure_psia - b.pressure_psia);
  // interpolateLabTable requires strictly ascending pressures — drop dupes.
  const deduped: PvtLabTableRow[] = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].pressure_psia > deduped[deduped.length - 1].pressure_psia + 1e-9) {
      deduped.push(rows[i]);
    }
  }
  return deduped.length >= 2 ? deduped : undefined;
}

/** Strip pressure-keyed per-row PVT from a candidate row (see labTableFromRows). */
function stripRowPvt(point: ProductionDataPoint): ProductionDataPoint {
  const {
    bo_rb_stb: _bo,
    rs_scf_stb: _rs,
    bg_rb_mscf: _bgm,
    bg_rb_scf: _bgs,
    bw_rb_stb: _bw,
    z_factor: _z,
    ...rest
  } = point;
  return rest;
}

/**
 * Rewrite inputs for pressure simulation: per-row lab PVT is keyed to the
 * OBSERVED pressures, so at a simulated pressure it would freeze Et and
 * derail the root search (verified experimentally: keeping per-row PVT
 * floors the whole simulated series). Candidate rows are stripped of
 * per-row PVT and, when no explicit lab table exists, the per-row values
 * become an interpolation table so the lab data still governs PVT.
 */
function prepareSimulationInputs(
  inputs: MBALInputs,
  notes?: Set<string>,
): MBALInputs {
  const rows = inputs.production_data;
  const hasRowPvt = rows.some(
    (r) =>
      r.bo_rb_stb != null || r.rs_scf_stb != null || r.bg_rb_mscf != null ||
      r.bg_rb_scf != null || r.bw_rb_stb != null || r.z_factor != null,
  );
  if (!hasRowPvt) return inputs;
  let labTable = inputs.pvt_lab_table;
  if (!labTable) {
    labTable = labTableFromRows(rows);
    if (labTable) {
      notes?.add(
        'Per-row lab PVT was converted to an interpolation table for the pressure simulation. Simulated pressures fall between observed rows, so PVT is interpolated through the lab points there.',
      );
    }
  }
  return {
    ...inputs,
    pvt_lab_table: labTable,
    production_data: [rows[0], ...rows.slice(1).map(stripRowPvt)],
  };
}

/**
 * Simulate the reservoir pressure history for a given in-place scale
 * (N in STB for oil, G in scf for gas) and the aquifer parameters carried on
 * `inputs`. Returns the full pressure series aligned with production_data
 * (index 0 pinned at initial pressure). Collects simulator notes (clamps,
 * fixed-point convergence, PVT-table derivation) into `notes`.
 */
export function simulatePressureHistory(
  rawInputs: MBALInputs,
  scale: number,
  notes?: Set<string>,
): number[] {
  const inputs = prepareSimulationInputs(rawInputs, notes);
  const rows = inputs.production_data;
  const n = rows.length;
  const pi = inputs.initial_pressure_psia;
  const cw = inputs.water_compressibility_psi;
  const cf = inputs.formation_compressibility_psi;
  const isGas = inputs.fluid_system === 'gas';
  const model: AquiferModel = inputs.has_aquifer ? inputs.aquifer_model : 'none';

  const fEtAt = (k: number, p: number): { F: number; Et: number } => {
    const candidate = { ...rows[k], pressure_psia: p };
    const twoPoint: MBALInputs = {
      ...inputs,
      production_data: [rows[0], candidate],
    };
    const { per_timestep } = isGas
      ? computeGasPerTimestep(twoPoint)
      : computeOilPerTimestep(twoPoint);
    return { F: per_timestep[1].F_rb, Et: per_timestep[1].Et_rb };
  };

  const potW = inputs.aquifer_params?.initial_aquifer_water_in_place_rb ?? 0;
  if (model === 'pot' && potW <= 0) {
    throw new Error(
      'Pot-aquifer pressure simulation requires aquifer_params.initial_aquifer_water_in_place_rb (W). Set it in the Aquifer tab or fit it (aquifer_w_rb).',
    );
  }

  // Scalar solve at step k: find p with scale·Et(p) + We(p) = F(p).
  // g decreases as p rises toward pi (expansion vanishes faster than voidage).
  const pLo = Math.max(50, 0.02 * pi);
  const solveStep = (k: number, weOf: (p: number) => number): number => {
    const g = (p: number): number => {
      const { F, Et } = fEtAt(k, p);
      return scale * Et + weOf(p) - F;
    };
    let a = pLo;
    let b = pi;
    let fa = g(a);
    let fb = g(b);
    if (fb >= 0) {
      // Influx + expansion cover the voidage with no depletion: pressure is
      // fully maintained (or the trial aquifer is unphysically strong).
      notes?.add(
        'At one or more timesteps the trial parameters sustain reservoir pressure at the initial value (influx covers voidage); simulated pressure was capped at initial pressure there.',
      );
      return b;
    }
    if (fa <= 0) {
      notes?.add(
        `At one or more timesteps the trial parameters cannot supply the observed voidage even at ${pLo.toFixed(0)} psia; simulated pressure was floored there.`,
      );
      return a;
    }
    // Illinois false position: bracketing with superlinear convergence.
    for (let i = 0; i < 80 && b - a > 1e-3; i++) {
      let c = (a * fb - b * fa) / (fb - fa);
      if (!(c > a && c < b)) c = 0.5 * (a + b);
      const fc = g(c);
      if (fc === 0) return c;
      if (fc > 0) {
        a = c;
        fa = fc;
        fb *= 0.5;
      } else {
        b = c;
        fb = fc;
        fa *= 0.5;
      }
    }
    return 0.5 * (a + b);
  };

  const timeDependent = model === 'fetkovich' || model === 'carter_tracy';
  const deltas = timeDependent ? extractTimedeltasDays(rows) : null;

  const simP = rows.map((r) => r.pressure_psia);
  simP[0] = pi;

  // Settle tolerance 0.2 psi: the Carter-Tracy Δp convention references the
  // NEXT observation, so the fixed point can dither by ~0.1 psi without any
  // physical meaning; 0.2 psi is far below survey gauge resolution.
  const MAX_OUTER = timeDependent ? 25 : 1;
  let settled = !timeDependent;
  for (let outer = 0; outer < MAX_OUTER; outer++) {
    let weArr: number[] | null = null;
    if (timeDependent) {
      const simRows = rows.map((r, i) => ({ ...r, pressure_psia: simP[i] }));
      const simSeries: MBALInputs = { ...inputs, production_data: simRows };
      weArr =
        model === 'fetkovich'
          ? computeFetkovichWe(simSeries, deltas as number[])
          : computeCarterTracyWe(simSeries, deltas as number[]);
    }
    let maxShift = 0;
    for (let k = 1; k < n; k++) {
      const weOf =
        model === 'pot'
          ? (p: number) => (cw + cf) * potW * (pi - p)
          : () => (weArr ? weArr[k] : 0);
      const pNew = solveStep(k, weOf);
      maxShift = Math.max(maxShift, Math.abs(pNew - simP[k]));
      simP[k] = pNew;
    }
    if (!timeDependent) break;
    if (maxShift < 0.2) {
      settled = true;
      break;
    }
  }
  if (!settled) {
    notes?.add(
      'The aquifer pressure coupling loop did not fully settle within 25 sweeps; simulated pressures may carry a small aquifer-lag error.',
    );
  }
  return simP;
}

/**
 * Pressure history match: fit tank parameters by minimizing observed-minus-
 * simulated pressure residuals with Levenberg-Marquardt. See the section
 * comment above for the method; see HistoryMatchOptions for the knobs.
 */
export function runHistoryMatch(
  inputs: MBALInputs,
  options: HistoryMatchOptions = {},
): HistoryMatchResult {
  validateInputs(inputs);
  const warnings: string[] = [];

  if (inputs.production_data.length > 400) {
    throw new Error(
      `History match supports up to 400 timesteps (got ${inputs.production_data.length}). Decimate the pressure survey to representative points in the Data tab.`,
    );
  }

  // Preliminary forward run: initial guesses for N/G (and pot W) come from
  // the regression the user already trusts.
  let prelim: MBALResult | null = null;
  let prelimError: string | null = null;
  try {
    prelim = computeMaterialBalance(inputs);
  } catch (err) {
    prelimError = err instanceof Error ? err.message : String(err);
  }

  // Resolve the fit set and check applicability.
  const keys =
    options.fit_parameters && options.fit_parameters.length > 0
      ? options.fit_parameters
      : defaultHistoryMatchParameters(inputs);
  const seen = new Set<string>();
  for (const key of keys) {
    const spec = HM_PARAM_SPECS[key];
    if (!spec) throw new Error(`Unknown history-match parameter "${key}".`);
    if (seen.has(key)) throw new Error(`Duplicate history-match parameter "${key}".`);
    seen.add(key);
    if (!spec.applies(inputs)) {
      throw new Error(`Parameter "${key}" does not apply to this case. ${spec.notApplicableHint}`);
    }
  }

  // Initial values (value space).
  const initials: number[] = keys.map((key) => {
    const spec = HM_PARAM_SPECS[key];
    const fromUser = options.initial_guesses?.[key];
    if (fromUser != null && fromUser > 0) return fromUser;
    const derived = spec.initial(inputs, prelim);
    if (derived != null && derived > 0) return derived;
    const prelimNote = prelimError
      ? ` (the preliminary regression failed: ${prelimError})`
      : '';
    throw new Error(
      `No starting value for history-match parameter "${key}"${prelimNote}. ${spec.missingInitialHint}`,
    );
  });

  // The in-place scale is either fitted or held at its starting estimate.
  const scaleKey: HistoryMatchParameterKey =
    inputs.fluid_system === 'gas' ? 'ogip_scf' : 'stoiip_stb';
  const scaleFitIdx = keys.indexOf(scaleKey);
  let fixedScale: number | null = null;
  if (scaleFitIdx < 0) {
    const fromUser = options.initial_guesses?.[scaleKey];
    const derived = HM_PARAM_SPECS[scaleKey].initial(inputs, prelim);
    fixedScale = fromUser != null && fromUser > 0 ? fromUser : derived;
    if (fixedScale == null || fixedScale <= 0) {
      throw new Error(
        `The history match needs a value for ${scaleKey} even when it is not being fitted. ${HM_PARAM_SPECS[scaleKey].missingInitialHint}`,
      );
    }
  }

  // Fit points: every non-initial, non-excluded timestep.
  const excluded = new Set<number>(inputs.excluded_timesteps ?? []);
  const rows = inputs.production_data;
  const fitRowIdx: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (!excluded.has(rows[i].timestep_index)) fitRowIdx.push(i);
  }
  if (fitRowIdx.length < keys.length + 1) {
    throw new Error(
      `History match needs at least ${keys.length + 1} non-excluded observations to fit ${keys.length} parameter(s); only ${fitRowIdx.length} available. Add production rows or fit fewer parameters.`,
    );
  }

  // ln-space encoding and bounds. (Per-row PVT handling happens inside
  // simulatePressureHistory — see prepareSimulationInputs.)
  const theta0 = initials.map((v) => Math.log(v));
  const lnBounds: Array<[number, number]> = keys.map((key, j) => {
    const user = options.bounds?.[key];
    const [lo, hi] = user ?? HM_PARAM_SPECS[key].defaultBounds(initials[j]);
    if (!(lo > 0) || !(hi > lo)) {
      throw new Error(
        `Bounds for "${key}" must satisfy 0 < low < high (got [${lo}, ${hi}]).`,
      );
    }
    return [Math.log(lo), Math.log(hi)];
  });

  const decode = (theta: number[]): Partial<Record<HistoryMatchParameterKey, number>> => {
    const values: Partial<Record<HistoryMatchParameterKey, number>> = {};
    keys.forEach((key, j) => {
      values[key] = Math.exp(theta[j]);
    });
    return values;
  };

  const residualsFn = (theta: number[]): number[] => {
    const values = decode(theta);
    const simInputs = applyHmParams(inputs, values);
    const scale = scaleFitIdx >= 0 ? (values[scaleKey] as number) : (fixedScale as number);
    try {
      const simP = simulatePressureHistory(simInputs, scale);
      return fitRowIdx.map((i) => rows[i].pressure_psia - simP[i]);
    } catch {
      // LM requires finite residuals; a large flat penalty steers the step
      // search away from regions where the simulation cannot run.
      return fitRowIdx.map(() => 1e6);
    }
  };

  const lm = levenbergMarquardt(residualsFn, theta0, {
    maxIterations: options.max_iterations ?? 30,
    tolerance: 1e-8,
    bounds: lnBounds,
  });

  // Final simulation at the matched parameters, collecting simulator notes.
  const matchedValues = decode(lm.theta);
  const matchedScale =
    scaleFitIdx >= 0 ? (matchedValues[scaleKey] as number) : (fixedScale as number);
  const notes = new Set<string>();
  const simP = simulatePressureHistory(
    applyHmParams(inputs, matchedValues),
    matchedScale,
    notes,
  );
  notes.forEach((n) => warnings.push(n));

  const observed = rows.map((r) => r.pressure_psia);
  const residual = observed.map((p, i) => p - simP[i]);
  const point_in_fit = rows.map((r, i) => i > 0 && !excluded.has(r.timestep_index));
  const fitResiduals = fitRowIdx.map((i) => residual[i]);
  const ssr = fitResiduals.reduce((acc, v) => acc + v * v, 0);
  const rms = Math.sqrt(ssr / fitResiduals.length);
  const maxAbs = fitResiduals.reduce((acc, v) => Math.max(acc, Math.abs(v)), 0);

  if (!lm.converged) {
    warnings.push(
      `The parameter search stopped at the iteration cap (${options.max_iterations ?? 30}) before fully converging. Results are usable but re-running with more iterations or tighter starting values may improve the match.`,
    );
  }
  if (rms > 0.02 * inputs.initial_pressure_psia) {
    warnings.push(
      `Match quality is poor: RMS pressure error ${rms.toFixed(1)} psi exceeds 2% of initial pressure. Check drive-mechanism assumptions (aquifer model, gas cap) and data quality before trusting the fitted values.`,
    );
  }

  const matched_parameters: HistoryMatchedParameter[] = keys.map((key, j) => {
    const spec = HM_PARAM_SPECS[key];
    const value = matchedValues[key] as number;
    const se = lm.standardErrors[j];
    const [ciLo, ciHi] = lm.confidence95[j];
    const atBound =
      Math.abs(lm.theta[j] - lnBounds[j][0]) < 1e-9 ||
      Math.abs(lm.theta[j] - lnBounds[j][1]) < 1e-9;
    if (atBound) {
      warnings.push(
        `${spec.label} finished at its search bound; the bound is constraining the fit. Widen bounds or revisit the starting value.`,
      );
    }
    return {
      key,
      label: spec.label,
      unit: spec.unit,
      initial_value: initials[j],
      matched_value: value,
      std_error_pct: Number.isFinite(se) ? (Math.exp(se) - 1) * 100 : null,
      ci95_low: Number.isFinite(ciLo) ? Math.exp(ciLo) : null,
      ci95_high: Number.isFinite(ciHi) ? Math.exp(ciHi) : null,
      at_bound: atBound,
    };
  });

  // Full forward diagnostics at the matched parameters (original rows, so
  // per-row lab PVT stays in effect for the regression-side numbers).
  let forward: MBALResult;
  try {
    forward = computeMaterialBalance(applyHmParams(inputs, matchedValues));
  } catch (err) {
    if (!prelim) {
      throw new Error(
        `Forward run at the matched parameters failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    warnings.push(
      'The forward diagnostics run at the matched parameters failed; drive indices and diagnostics reflect the pre-match configuration.',
    );
    forward = prelim;
  }

  return {
    matched_parameters,
    observed_pressure_psia: observed,
    simulated_pressure_psia: simP,
    residual_psi: residual,
    point_in_fit,
    rms_error_psi: rms,
    max_abs_error_psi: maxAbs,
    ssr_psi2: ssr,
    iterations: lm.iterations,
    converged: lm.converged,
    matched_ooip_stb: inputs.fluid_system === 'gas' ? undefined : matchedScale,
    matched_ogip_scf: inputs.fluid_system === 'gas' ? matchedScale : undefined,
    forward,
    validation_tier: forward.validation_tier,
    validation_reference: forward.validation_reference
      ? `${forward.validation_reference}; history-match parameters from Levenberg-Marquardt minimization of pressure residuals (inverse MBE)`
      : 'History-match parameters from Levenberg-Marquardt minimization of pressure residuals (inverse MBE)',
    warnings,
    engine_version: ENGINE_VERSION,
  };
}

// ============================================================================
// END OF FILE
// ============================================================================
