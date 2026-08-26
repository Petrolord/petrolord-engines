// Drillstring and casing tubular catalog (API 5DP / RP 7G / 5CT lineage).
//
// Provenance: dimensions, nominal weights, and grade yield strengths are the
// standard published API values as republished in every drilling data
// handbook (API RP 7G drill-pipe tables; API 5CT casing tables). Adjusted
// weights (tool joints included) are the customary approximate RP 7G values
// and are marked approx: true. Drill-collar weights follow the steel-section
// identity w[lb/ft] = 2.67·(OD² − ID²) [in²], which reproduces the published
// tables to the pound.
//
// Storage is SI (metres, kg/m, Pa); `designation` strings keep the familiar
// field-unit names for display. Conversion constants are applied here, once,
// at data-definition time — engine code never converts units silently.

const IN = 0.0254; // m
const LBFT = 1.4881639; // kg/m
const KSI = 6.894757e6; // Pa

export const GRADES = [
  { name: 'E-75', yieldPa: 75e3 * 6.894757e3 },
  { name: 'X-95', yieldPa: 95e3 * 6.894757e3 },
  { name: 'G-105', yieldPa: 105e3 * 6.894757e3 },
  { name: 'S-135', yieldPa: 135e3 * 6.894757e3 },
];

export function gradeYieldPa(name) {
  const g = GRADES.find((x) => x.name === name);
  return g ? g.yieldPa : null;
}

// type 'dp': API drill pipe. Nominal weight names the size; weightKgM is the
// approx adjusted weight (tool joints included) used for string weight.
export const DRILL_PIPE = [
  {
    designation: '3-1/2" 13.30 (NC38)', type: 'dp', odM: 3.5 * IN, idM: 2.764 * IN,
    nominalWeightKgM: 13.30 * LBFT, weightKgM: 14.70 * LBFT, approx: true,
    tooljointOdM: 4.75 * IN, connection: 'NC38',
  },
  {
    designation: '4" 14.00 (NC40)', type: 'dp', odM: 4.0 * IN, idM: 3.340 * IN,
    nominalWeightKgM: 14.00 * LBFT, weightKgM: 15.42 * LBFT, approx: true,
    tooljointOdM: 5.25 * IN, connection: 'NC40',
  },
  {
    designation: '4-1/2" 16.60 (NC46)', type: 'dp', odM: 4.5 * IN, idM: 3.826 * IN,
    nominalWeightKgM: 16.60 * LBFT, weightKgM: 18.37 * LBFT, approx: true,
    tooljointOdM: 6.25 * IN, connection: 'NC46',
  },
  {
    designation: '5" 19.50 (NC50)', type: 'dp', odM: 5.0 * IN, idM: 4.276 * IN,
    nominalWeightKgM: 19.50 * LBFT, weightKgM: 22.26 * LBFT, approx: true,
    tooljointOdM: 6.625 * IN, connection: 'NC50',
  },
  {
    designation: '5-1/2" 21.90 (5-1/2 FH)', type: 'dp', odM: 5.5 * IN, idM: 4.778 * IN,
    nominalWeightKgM: 21.90 * LBFT, weightKgM: 24.44 * LBFT, approx: true,
    tooljointOdM: 7.0 * IN, connection: '5-1/2 FH',
  },
  {
    designation: '6-5/8" 25.20 (6-5/8 FH)', type: 'dp', odM: 6.625 * IN, idM: 5.965 * IN,
    nominalWeightKgM: 25.20 * LBFT, weightKgM: 27.72 * LBFT, approx: true,
    tooljointOdM: 8.0 * IN, connection: '6-5/8 FH',
  },
];

export const HWDP = [
  { designation: '3-1/2" HWDP 25.3', type: 'hwdp', odM: 3.5 * IN, idM: 2.0625 * IN, weightKgM: 25.3 * LBFT, tooljointOdM: 4.75 * IN },
  { designation: '4" HWDP 29.9', type: 'hwdp', odM: 4.0 * IN, idM: 2.5625 * IN, weightKgM: 29.9 * LBFT, tooljointOdM: 5.25 * IN },
  { designation: '4-1/2" HWDP 41.0', type: 'hwdp', odM: 4.5 * IN, idM: 2.75 * IN, weightKgM: 41.0 * LBFT, tooljointOdM: 6.25 * IN },
  { designation: '5" HWDP 49.3', type: 'hwdp', odM: 5.0 * IN, idM: 3.0 * IN, weightKgM: 49.3 * LBFT, tooljointOdM: 6.5 * IN },
  { designation: '5-1/2" HWDP 57.4', type: 'hwdp', odM: 5.5 * IN, idM: 3.375 * IN, weightKgM: 57.4 * LBFT, tooljointOdM: 7.0 * IN },
];

// Drill collars: w[lb/ft] = 2.67·(OD² − ID²) in inches (steel section).
export const DRILL_COLLARS = [
  { designation: '4-3/4" x 2-1/4" DC (46.7)', type: 'dc', odM: 4.75 * IN, idM: 2.25 * IN, weightKgM: 46.7 * LBFT },
  { designation: '6-1/4" x 2-13/16" DC (83.2)', type: 'dc', odM: 6.25 * IN, idM: 2.8125 * IN, weightKgM: 83.2 * LBFT },
  { designation: '6-3/4" x 2-1/4" DC (108.1)', type: 'dc', odM: 6.75 * IN, idM: 2.25 * IN, weightKgM: 108.1 * LBFT },
  { designation: '8" x 2-13/16" DC (149.8)', type: 'dc', odM: 8.0 * IN, idM: 2.8125 * IN, weightKgM: 149.8 * LBFT },
  { designation: '9-1/2" x 3" DC (216.9)', type: 'dc', odM: 9.5 * IN, idM: 3.0 * IN, weightKgM: 216.9 * LBFT },
];

// Common casing sizes for hole-section presets (API 5CT nominal ID).
export const CASING_QUICK = [
  { designation: '20" 94 K-55', odM: 20 * IN, idM: 19.124 * IN, weightKgM: 94 * LBFT, wallM: 0.438 * IN },
  { designation: '13-3/8" 68 L-80', odM: 13.375 * IN, idM: 12.415 * IN, weightKgM: 68 * LBFT, wallM: 0.480 * IN },
  { designation: '9-5/8" 47 L-80', odM: 9.625 * IN, idM: 8.681 * IN, weightKgM: 47 * LBFT, wallM: 0.472 * IN },
  { designation: '7" 29 P-110', odM: 7 * IN, idM: 6.184 * IN, weightKgM: 29 * LBFT, wallM: 0.408 * IN },
  { designation: '5-1/2" 17 P-110', odM: 5.5 * IN, idM: 4.892 * IN, weightKgM: 17 * LBFT, wallM: 0.304 * IN },
];

// ---- casing & tubing design catalog (D6) -----------------------------------
// Rows per (OD, nominal weight) with the REAL published API 5CT wall/ID —
// one wall per weight, unlike the legacy single id_ref-per-OD shortcut.
// Ratings are NOT stored here: they are computed at load by the validated
// tubularDesign engine per selected grade.

export const CASING_GRADES = [
  { name: 'H-40', yieldPa: 40 * KSI },
  { name: 'J-55', yieldPa: 55 * KSI },
  { name: 'K-55', yieldPa: 55 * KSI },
  { name: 'M-65', yieldPa: 65 * KSI },
  { name: 'L-80', yieldPa: 80 * KSI },
  { name: 'N-80', yieldPa: 80 * KSI },
  { name: 'C-90', yieldPa: 90 * KSI },
  { name: 'T-95', yieldPa: 95 * KSI },
  { name: 'P-110', yieldPa: 110 * KSI },
  { name: 'Q-125', yieldPa: 125 * KSI },
];

export function casingGradeYieldPa(name) {
  const g = CASING_GRADES.find((x) => x.name === name);
  return g ? g.yieldPa : null;
}

const ct = (odIn, wLbFt, wallIn, idIn, kind) => ({
  designation: `${odIn}" ${wLbFt}#`, kind,
  odM: odIn * IN, wallM: wallIn * IN, idM: idIn * IN,
  weightKgM: wLbFt * LBFT, odIn, weightLbFt: wLbFt,
});

// API 5CT casing dimensional rows (published wall/ID per weight).
export const CASING_CATALOG = [
  ct(20, 94, 0.438, 19.124, 'casing'),
  ct(20, 106.5, 0.500, 19.000, 'casing'),
  ct(20, 133, 0.635, 18.730, 'casing'),
  ct(13.375, 54.5, 0.380, 12.615, 'casing'),
  ct(13.375, 61, 0.430, 12.515, 'casing'),
  ct(13.375, 68, 0.480, 12.415, 'casing'),
  ct(13.375, 72, 0.514, 12.347, 'casing'),
  ct(9.625, 36, 0.352, 8.921, 'casing'),
  ct(9.625, 40, 0.395, 8.835, 'casing'),
  ct(9.625, 43.5, 0.435, 8.755, 'casing'),
  ct(9.625, 47, 0.472, 8.681, 'casing'),
  ct(9.625, 53.5, 0.545, 8.535, 'casing'),
  ct(7, 23, 0.317, 6.366, 'casing'),
  ct(7, 26, 0.362, 6.276, 'casing'),
  ct(7, 29, 0.408, 6.184, 'casing'),
  ct(7, 32, 0.453, 6.094, 'casing'),
  ct(7, 35, 0.498, 6.004, 'casing'),
  ct(5.5, 17, 0.304, 4.892, 'casing'),
  ct(5.5, 20, 0.361, 4.778, 'casing'),
  ct(5.5, 23, 0.415, 4.670, 'casing'),
  ct(4.5, 11.6, 0.250, 4.000, 'casing'),
  ct(4.5, 13.5, 0.290, 3.920, 'casing'),
];

// API 5CT tubing dimensional rows.
export const TUBING_CATALOG = [
  ct(2.375, 4.7, 0.190, 1.995, 'tubing'),
  ct(2.875, 6.5, 0.217, 2.441, 'tubing'),
  ct(3.5, 9.3, 0.254, 2.992, 'tubing'),
  ct(3.5, 12.95, 0.375, 2.750, 'tubing'),
  ct(4, 11, 0.262, 3.476, 'tubing'),
  ct(4.5, 12.75, 0.271, 3.958, 'tubing'),
];

// Nominal planning-level joint-strength efficiencies (fraction of pipe body
// yield). These are customary screening values, NOT connection-specific
// ratings — real designs verify against the manufacturer data sheet.
export const CONNECTION_EFFICIENCIES = [
  { name: 'BTC', efficiency: 1.0, note: 'buttress thread and coupling' },
  { name: 'LTC', efficiency: 0.85, note: 'long thread and coupling' },
  { name: 'STC', efficiency: 0.75, note: 'short thread and coupling' },
  { name: 'Premium', efficiency: 1.0, note: 'metal-to-metal seal premium' },
  { name: 'EUE', efficiency: 1.0, note: 'external upset tubing' },
  { name: 'NUE', efficiency: 0.75, note: 'non-upset tubing' },
];

export const TUBULAR_CATALOG = { GRADES, DRILL_PIPE, HWDP, DRILL_COLLARS, CASING_QUICK };
export const CT_CATALOG = { CASING_GRADES, CASING_CATALOG, TUBING_CATALOG, CONNECTION_EFFICIENCIES };
