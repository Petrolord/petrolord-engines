// Dake Exercise 9.2 shared fixture (MB2, 2026-07-18)
// ============================================================================
// Reference: Dake, L.P. (1978), "Fundamentals of Reservoir Engineering,"
// Elsevier, Chapter 9 "Natural Water Influx", Exercise 9.2 "Aquifer fitting
// using the unsteady state theory of Hurst and van Everdingen", pp. 310-319.
//
// Extracted from tools/validation/mbal-validation.ts (CASE 2C) so the same
// book-verified data feeds BOTH the server-engine harness case and the MB2
// client cross-validation golden generator
// (tools/validation/gen-dake92-client-golden.ts). The values are unchanged
// from the CASE 2C originals (year-9 Rs OCR correction 381 -> 371 retained).
//
// This is the fixture behind the §4.1 HARD GATE
// (docs/scope/ReservoirEngineering-Module.md): the client Carter-Tracy in
// src/utils/aquiferInfluxCalculations.js must reproduce this benchmark before
// the Reservoir Balance aquifer tab ships.

export const DAKE_CT_RESERVOIR = {
  initial_pressure_psia: 2740,
  bubble_point_psia: 2740,            // No mention of pb; assume pi = pb is OK
                                       // because PVT is provided per-pressure
                                       // (engine uses table, not correlations)
  reservoir_temperature_f: 200,        // Not given by Dake; nominal value
  initial_water_saturation: 0.05,      // Dake calls it Swc (connate)
  formation_compressibility_psi: 4e-6,
  water_compressibility_psi: 3e-6,
  oil_gravity_api: 35,                 // Nominal; engine uses lab table
  gas_specific_gravity: 0.7,           // Nominal; engine uses lab table
  gas_cap_ratio_m: 0,                  // No gas cap in this exercise

  // Carter-Tracy aquifer parameters from Dake
  aquifer_radius_ft: 9200,              // Dake's r_o (reservoir radius at OWC)
  aquifer_dim_radius_ratio: 5,           // Dake's r_eD (the correct value)
  aquifer_thickness_ft: 100,            // Dake's h
  aquifer_permeability_md: 200,         // Dake's k
  aquifer_porosity: 0.25,               // Dake's phi
  aquifer_water_viscosity_cp: 0.55,     // Dake's mu_w
  aquifer_encroachment_angle_deg: 140,  // Wedge angle (f = 140/360)
  aquifer_total_compressibility_psi: 7e-6,  // cw + cf

  // Truth values from Dake
  dake_N_truth_mmstb: 312,
  dake_N_lsq_hve_mmstb: 310.2,
  dake_reD_correct: 5,
  dake_final_we_hve_mmrb: 89.2,        // Dake's reD=5 HvE solution at year 10
  rsi_scf_stb: 650,
};

// Table 9.3 — Production and PVT data
// 11 rows (year 0..10). Note: year-9 Rs corrected from OCR-error 381 to 371.
export const DAKE_CT_PERFORMANCE = [
  { yr:  0, p: 2740, Np_mmstb:  0.00, Rp:  650, Bo: 1.404, Rs: 650, Bg: 0.00093 },
  { yr:  1, p: 2620, Np_mmstb:  7.88, Rp:  760, Bo: 1.374, Rs: 592, Bg: 0.00098 },
  { yr:  2, p: 2395, Np_mmstb: 18.42, Rp:  845, Bo: 1.349, Rs: 545, Bg: 0.00107 },
  { yr:  3, p: 2199, Np_mmstb: 29.15, Rp:  920, Bo: 1.329, Rs: 507, Bg: 0.00117 },
  { yr:  4, p: 2029, Np_mmstb: 40.69, Rp:  975, Bo: 1.316, Rs: 471, Bg: 0.00128 },
  { yr:  5, p: 1883, Np_mmstb: 50.14, Rp: 1025, Bo: 1.303, Rs: 442, Bg: 0.00139 },
  { yr:  6, p: 1760, Np_mmstb: 58.42, Rp: 1065, Bo: 1.294, Rs: 418, Bg: 0.00150 },
  { yr:  7, p: 1655, Np_mmstb: 65.39, Rp: 1095, Bo: 1.287, Rs: 398, Bg: 0.00160 },
  { yr:  8, p: 1571, Np_mmstb: 70.74, Rp: 1120, Bo: 1.280, Rs: 383, Bg: 0.00170 },
  { yr:  9, p: 1507, Np_mmstb: 74.54, Rp: 1145, Bo: 1.276, Rs: 371, Bg: 0.00176 },  // Rs corrected
  { yr: 10, p: 1460, Np_mmstb: 77.43, Rp: 1160, Bo: 1.273, Rs: 364, Bg: 0.00182 },
];
