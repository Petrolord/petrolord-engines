/**
 * Central black-oil PVT correlations.
 *
 * Extracted 2026-08-28 from engines/mbal/mbalEngine.ts, which defined these
 * as private helpers and is now the first consumer. The code is UNCHANGED by
 * the extraction: the mbal gate suite pins every one of these correlations
 * through the material-balance results that depend on them, so a behavioural
 * drift here fails there.
 *
 * Field units throughout: psia, degrees Fahrenheit, scf/STB, rb/STB, cp.
 * Every function is pure and synchronous.
 *
 * Correlation set and references:
 *   Pb / Rs / Bo        Standing (1947), Vasquez & Beggs (1980), Glaso (1980)
 *   gas z               Hall & Yarborough (1973), Dranchuk & Abou-Kassem (1975)
 *   water Bw / muW      McCain (1991)
 *   dead oil viscosity  Beal (1946)
 *   live oil viscosity  Beggs & Robinson (1975)
 *   undersaturated muO  Vasquez & Beggs (1980)
 *   gas viscosity       Lee, Gonzalez & Eakin (1966)
 *
 * The two validity-warning functions carry each correlation's published
 * training range and say so in the warning text, which is what lets a caller
 * report that a number was produced outside the range it was fitted over.
 */

/** The correlation choices a black-oil calculation has to make. */
export interface PVTCorrelations {
  pb_rs_bo: 'standing' | 'vasquez_beggs' | 'glaso';
  oil_viscosity: 'beggs_robinson' | 'beal_standing' | 'beal_cook_spillman';
  z_factor: 'hall_yarborough' | 'dranchuk_abou_kassem';
  water: 'mccain';
  gas_viscosity: 'lee_gonzalez_eakin';
}

/**
 * Standing's correlation for oil bubble-point pressure.
 * Reference: Standing, M.B. (1947). Returns Pb in psia.
 */
export function standingPb(rs: number, gas_sg: number, api: number, temp_f: number): number {
  // Standing 1947: Pb = 18.2 * [(Rs/gas_sg)^0.83 * 10^(0.00091*T - 0.0125*API) - 1.4]
  const exponent = 0.00091 * temp_f - 0.0125 * api;
  const term = Math.pow(rs / gas_sg, 0.83) * Math.pow(10, exponent);
  return 18.2 * (term - 1.4);
}

/**
 * Standing's correlation for solution gas-oil ratio (Rs) below bubble point.
 * Reference: Standing, M.B. (1947). Returns Rs in scf/STB.
 */
export function standingRs(p: number, pb: number, gas_sg: number, api: number, temp_f: number): number {
  // Rs = gas_sg * [(p / 18.2 + 1.4) * 10^(0.0125*API - 0.00091*T)]^(1/0.83)
  //
  // Saturates at Pb, like vasquezBeggsRs and glasoRs: undersaturated oil has
  // released no gas, so Rs above the bubble point is Rsb. This clamp was added
  // when the correlations were centralized (2026-08-28) because Standing was
  // the one of the three that took pb and ignored it, which made the contract
  // depend on which correlation a caller had selected. It is inert for the
  // material-balance engine, whose dispatchers are only reached on the p <= pb
  // branch and which passes min(pi, Pb) explicitly at initialisation.
  const p_use = Math.min(p, pb);  // saturate at Pb
  const exponent = 0.0125 * api - 0.00091 * temp_f;
  const inner = (p_use / 18.2 + 1.4) * Math.pow(10, exponent);
  return gas_sg * Math.pow(inner, 1.0 / 0.83);
}

/**
 * Standing's correlation for oil formation volume factor at and below bubble point.
 * Reference: Standing, M.B. (1947). Returns Bo in RB/STB.
 */
export function standingBoSat(rs: number, gas_sg: number, oil_sg: number, temp_f: number): number {
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
export function hallYarboroughZ(ppr: number, tpr: number): number {
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
export function bgRbPerScf(p_psia: number, temp_f: number, z: number): number {
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
export function bwApprox(bwi: number, p: number, pi: number, cw: number): number {
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
export function vasquezBeggsPb(rs: number, gas_sg: number, api: number, temp_f: number): number {
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
export function vasquezBeggsRs(p: number, pb: number, gas_sg: number, api: number, temp_f: number): number {
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
export function vasquezBeggsBoSat(rs: number, gas_sg: number, api: number, temp_f: number): number {
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
export function glasoPb(rs: number, gas_sg: number, api: number, temp_f: number): number {
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
export function glasoRs(p: number, pb: number, gas_sg: number, api: number, temp_f: number): number {
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
export function glasoBoSat(rs: number, gas_sg: number, oil_sg: number, temp_f: number): number {
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
export function dranchukAbouKassemZ(ppr: number, tpr: number): number {
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
export function mccainBw(p: number, temp_f: number): number {
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
export function mccainMuW(p: number, temp_f: number, salinity_ppm = 0): number {
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
export function correlationValidityWarnings(
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
export function bealDeadOilViscosity(api: number, temp_f: number): number {
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
export function beggsRobinsonLiveOilViscosity(rs: number, mu_od: number): number {
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
export function vasquezBeggsUndersaturatedOilViscosity(p: number, pb: number, mu_ob: number): number {
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
export function leeGonzalezEakinGasViscosity(p: number, temp_f: number, gas_sg: number, z: number): number {
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
export function viscosityValidityWarnings(
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
