// Ekene dynamic-field fixture generator (NextGen Reservoir course series, RC).
// ============================================================================
// Puts the Ekene teaching field (the geoscience courses' static fixture) on
// production. Everything here is DETERMINISTIC and closed-form: planted Arps
// declines per producer, a material-balance pressure history derived in closed
// form from the locked NG5 volumetric STOIIP, Corey/Buckley-Leverett rock
// curves, and a voidage-replacement injection ledger. The generator then runs
// the ACTUAL central engines on each fixture and records the engine outputs as
// goldens (teaching datasets ARE the goldens), asserting recovery along the way.
//
// Run from the repo root:   npx tsx tools/ekene-dynamic/generate.mjs
// Output:                   test-data/ekene-dynamic/*.json
//
// Design doctrine (docs: petrolord-suite docs/scope/NextGen-Reservoir-Courses-PLAN.md §3):
// - No noise anywhere: fits recover planted parameters, material balance
//   recovers the volumetric STOIIP, so every graded number is hand-reachable.
// - No rounding of emitted values: JSON carries full double precision.
// - Every engine-facing number in a course lesson must trace to this file.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { fitArpsModel, calculateEUR } from '../../engines/dca/arps.js';
import { computeMaterialBalance } from '../../engines/mbal/mbalEngine.ts';
import { analyzeDisplacement, mobilityRatio } from '../../engines/scal/fractionalFlow.js';
import {
  computeJTable,
  averageJCurves,
  fitJPowerLaw,
  pcFromJ,
  swVsHeight,
  heightFromPc,
  LEVERETT_C,
  PSI_PER_FT_WATER,
} from '../../engines/scal/scal.js';
import { computeVRRSeries, summarizeVRR } from '../../engines/waterflood/vrr.js';
import {
  buildFieldPeriods,
  validateAllocation,
  allocateInjection,
  buildPatternPeriods,
  computeRollingVRR,
  findFillUp,
  attachPressure,
  interpolateFvfTrack,
  recommendPatternInjection,
} from '../../engines/waterflood/vrrLedger.js';
import { analyzeWaterflood } from '../../engines/waterflood/waterflood.js';
import { analyzeLayeredSweep, inverseNormal } from '../../engines/waterflood/layeredSweep.js';
import { forecastPattern } from '../../engines/waterflood/patternForecast.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '..', 'test-data', 'ekene-dynamic');

// ============================================================================
// 1. Locked static field (geoscience NG5 / DC9 goldens — NEVER change here;
//    these are the published values of the geoscience ladder).
// ============================================================================

const STATIC_FIELD = {
  owc_m_tvd: 1560,
  oil_cells: 169,
  cell_size_m: 100,
  grv_m3: 22.26903564453125e6,
  net_m3: 17.81522878109259e6,
  pore_m3: 3.563045809312045e6,
  hcpv_m3: 2.3159797972902343e6,
  stoiip_stb: 12139208.107496763, // 12.139208107496763 MMstb (NG5)
  max_oil_column_m: 20.2818603515625,
  ntg: 0.8,
  phi: 0.2,
  swi: 0.35,
  boi_rb_stb: 1.2,
  stb_per_m3: 6.2898,
};

// The geoscience mapping/correlation well table (nextgen mappingTeaching.js),
// with dynamic roles: E2 and E4 penetrated TOP_SAND below the 1560 m contact
// (1565 and 1590), found the sand wet, and are completed as water injectors
// when the flood starts. The DC22 sealing-fault case (fault at x=1800) is a
// ReservoirCalc Professional what-if SCENARIO; the base development case is
// the unfaulted single tank consistent with NG5 volumetrics and this MB history.
const WELL_TABLE = [
  { name: 'Ekene-1', x: 1000, y: 1000, top_sand_m: 1548, base_sand_m: 1580, role: 'producer' },
  { name: 'Ekene-2', x: 2200, y: 1150, top_sand_m: 1565, base_sand_m: 1601, role: 'injector_from_2023-01-01' },
  { name: 'Ekene-3', x: 1400, y: 2300, top_sand_m: 1541, base_sand_m: 1570, role: 'producer' },
  { name: 'Ekene-4', x: 2600, y: 2500, top_sand_m: 1590, base_sand_m: 1615, role: 'injector_from_2023-01-01' },
  { name: 'Ekene-5', x: 600, y: 1900, top_sand_m: 1552, base_sand_m: 1583, role: 'producer' },
  { name: 'Ekene-6', x: 1900, y: 1800, top_sand_m: 1546, base_sand_m: 1580, role: 'producer' },
];

// ============================================================================
// 2. Timeline + planted producer declines (one well per Arps model family).
//    Di is per DAY (the engine's fit unit). Hyperbolic b values sit on the
//    engine's 0.05 grid so the grid search can land on them.
// ============================================================================

const PRODUCTION_START = '2020-01-01';
const FLOOD_START = '2023-01-01';
const HISTORY_END = '2025-12-01'; // last monthly row (inclusive)
const ECON_LIMIT_BOPD = 10;

// Flood response follows injector distance: E6 is 712 m from Ekene-2 (first,
// strongest response, first water); E5 is ~1.8 km from both injectors (last,
// weakest, no breakthrough in the fixture window).
const PRODUCERS = [
  {
    name: 'Ekene-1', start: '2020-01-01',
    model: 'exponential', qi: 120, Di: 0.0012, b: 0,
    flood: { lagMonths: 5, lift: 1.28, btDate: '2025-06-01', wcMax: 0.08 },
  },
  {
    name: 'Ekene-3', start: '2020-03-01',
    model: 'hyperbolic', qi: 150, Di: 0.002, b: 0.5,
    flood: { lagMonths: 6, lift: 1.25, btDate: '2024-09-01', wcMax: 0.25 },
  },
  {
    name: 'Ekene-5', start: '2020-06-01',
    model: 'harmonic', qi: 100, Di: 0.0015, b: 1,
    flood: { lagMonths: 9, lift: 1.15, btDate: null, wcMax: 0 },
  },
  {
    name: 'Ekene-6', start: '2020-09-01',
    model: 'hyperbolic', qi: 90, Di: 0.001, b: 0.35,
    flood: { lagMonths: 3, lift: 1.35, btDate: '2024-03-01', wcMax: 0.45 },
  },
];

const RAMP_MONTHS = 6;         // response builds linearly over 6 months after the lag
const FLOOD_DECLINE_PER_DAY = 0.00035; // gentle post-response decline (~12%/yr nominal)

// ============================================================================
// 3. Material-balance design (undersaturated single-tank depletion, no aquifer)
// ============================================================================

const MBAL_DESIGN = {
  pi_psia: 3200,
  pb_psia: 2000,
  temp_f: 180,
  api: 32,
  gas_sg: 0.75,
  salinity_ppm: 35000,
  rsi_scf_stb: 400,   // constant above the bubble point
  co_per_psi: 1.2e-5, // design undersaturated oil compressibility (drives the lab Bo line)
  cf_per_psi: 4e-6,
  cw_per_psi: 3e-6,
  bw_rb_stb: 1.02,
  survey_dates: ['2020-07-01', '2021-01-01', '2021-07-01', '2022-01-01', '2022-07-01', '2023-01-01'],
};

// ============================================================================
// 4. SCAL / displacement design (Ekene sand)
// ============================================================================

const SCAL_DESIGN = {
  krSpec: { type: 'corey', Swc: 0.35, Sor: 0.25, krwMax: 0.3, kroMax: 0.9, nw: 2.5, no: 2.0 },
  muW_cp: 0.5,
  muO_cp: 1.8, // reservoir oil viscosity at flood-era pressure (see PVT table)
};

// ============================================================================
// 4b. Capillary / J-function design (Ekene sand, RC3)
// ============================================================================
// The capillary half of the SCAL fixture. One designed drainage J curve
// (power law) generates three core plugs' lab Pc tables through the engine's
// own pcFromJ, so the Leverett collapse back to the single curve is EXACT:
// the collapse exercise recovers the plant the way the DCA fits recover the
// planted Arps parameters.
//
// Design intent (assertions below hold the generator to it):
// - Swirr 0.25 sits deliberately BELOW the kr table's Swc 0.35. The Pc
//   asymptote is the true irreducible saturation; connate water in the kr
//   set is what the crest zone drains to. Both are real conventions and the
//   gap between them is course material, not an inconsistency.
// - The free water level is placed so Sw reaches 1.0 exactly at the mapped
//   1560 m contact: FWL = 1560 + entry height. The contact the geoscience
//   ladder mapped is the TOP of the water-saturated rock, not the FWL.
// - With a 0.25 / b 1.0 the crest of the structure (max oil column
//   20.2818603515625 m above the contact) drains to Sw 0.3506: the NG5
//   booking's flat Sw 0.35 is true AT THE CREST ONLY, and every metre below
//   it is wetter. The height-averaged Sw over the crest column is the
//   honest number the flat booking replaces.
const CAP_DESIGN = {
  // Ekene sand average rock + reservoir oil-brine system for J scaling
  // (field units; k is a NEW design constant, nothing upstream fixed it).
  reservoir: { k_md: 250, phi: 0.2, sigma_dyncm: 26, thetaDeg: 30 },
  // Height conversion: design brine SG 1.03; oil SG follows from the locked
  // API 32 (141.5 / (131.5 + API)).
  gammaW: 1.03,
  // The designed field drainage curve: J = a * Sw*^-b on
  // Sw* = (Sw - Swirr)/(1 - Swirr).
  jTrue: { type: 'power', a: 0.25, b: 1.0, Swirr: 0.25 },
  // Three plugs, three lab fluid systems, k/phi spread around the field
  // average. Lab Pc tables are GENERATED from jTrue.
  plugs: [
    { name: 'EK1-P', well: 'Ekene-1', system: 'air-brine', k_md: 420, phi: 0.23, sigma_dyncm: 72, thetaDeg: 0 },
    { name: 'EK3-P', well: 'Ekene-3', system: 'mercury-air', k_md: 250, phi: 0.2, sigma_dyncm: 480, thetaDeg: 40 },
    { name: 'EK5-P', well: 'Ekene-5', system: 'oil-brine', k_md: 95, phi: 0.16, sigma_dyncm: 48, thetaDeg: 30 },
  ],
  // Lab saturation grid: 0.30 to 1.00 in 0.05 steps (15 rows).
  swGrid: { SwMin: 0.3, SwMax: 1.0, n: 14 },
};

// ============================================================================
// 5. Waterflood ledger design
// ============================================================================

const FLOOD_DESIGN = {
  // VRR target ramps 0.85 -> 1.05 over the first six months (deliberate
  // under-injection at start-up: fill-up + facility commissioning), then holds
  // 1.05 (slow repressurization back toward the bubble-point margin).
  vrrTarget: (m) => (m < 6 ? 0.85 + 0.04 * m : 1.05),
  injectionSplit: { 'Ekene-2': 0.6, 'Ekene-4': 0.4 },
  // Ledger FVF convention: frozen at the flood-era average pressure 2100 psia
  // on the fixture's own PVT line: Bo = 1.2*(1 + 1.2e-5*(3200-2100)) = 1.21584.
  fvf: { Bo: 1.21584, Bw: 1.02, Bg: 0, Rs: 400 },
  // Injectivity index (bbl/d/psi) for the Hall-plot surveillance story:
  // Ekene-4 loses injectivity from 2025-01-01 (near-wellbore plugging).
  injectivity: {
    'Ekene-2': () => 0.5,
    'Ekene-4': (dateStr) => (dateStr >= '2025-01-01' ? 0.35 : 0.5),
  },
  refPressure_psia: 2050, // flowing-reservoir proxy behind the whp model
};

// ============================================================================
// 5b. Flood-design design constants (RC4): layers, patterns, allocation,
//     pressure surveillance. Everything downstream is derived from these.
// ============================================================================

// The Ekene sand as five non-communicating layers. Permeabilities are PLANTED
// on an exact log-normal so the engine's Dykstra-Parsons fit recovers the
// design back: k_i = k50 * exp(-sigma * z_i) with z_i the standard-normal
// quantile of the (i + 0.5)/n plotting position the engine itself uses. With
// sigma = ln 2 the recovered permeability variation is V = 1 - exp(-sigma)
// = 0.5 EXACTLY. k50 = 250 md is the RC3 reservoir permeability, so the
// capillary and the sweep halves of the course describe the same rock.
//
// Thicknesses are given in DEPTH order (top to base) and the permeability
// order is deliberately NOT the depth order: the fastest layer sits in the
// middle of the column. normalizeLayers reorders by k, and a reader who
// assumes the top layer floods first is wrong.
const LAYER_DESIGN = {
  k50_md: 250,
  sigma: Math.log(2),
  n: 5,
  // depth order (top -> base): thickness in ft, and which quantile rank
  // (0 = fastest) that layer draws its permeability from.
  column: [
    { name: 'L1', h_ft: 18, rank: 3 },
    { name: 'L2', h_ft: 22, rank: 0 },
    { name: 'L3', h_ft: 16, rank: 2 },
    { name: 'L4', h_ft: 14, rank: 4 },
    { name: 'L5', h_ft: 14, rank: 1 },
  ],
};

// Injector -> producer allocation factors. Operator judgement (inverse
// distance on the mapped well coordinates, rounded to the nearest 0.05),
// deliberately summing to LESS than 1 on both injectors: the shortfall is
// out-of-zone injection, a real reportable quantity the engine books rather
// than redistributing.
const ALLOCATION = {
  'Ekene-2': { 'Ekene-6': 0.45, 'Ekene-1': 0.3, 'Ekene-3': 0.15 },
  'Ekene-4': { 'Ekene-3': 0.4, 'Ekene-6': 0.35, 'Ekene-5': 0.1 },
};

// Two flood elements. Each pattern draws injection from BOTH injectors, which
// is what allocation factors are for.
const PATTERNS = [
  { name: 'North (Ekene-2 element)', producers: ['Ekene-1', 'Ekene-6'] },
  { name: 'South (Ekene-4 element)', producers: ['Ekene-3', 'Ekene-5'] },
];

// Five-spot forecast element. The flood element is HALF the mapped oil leg
// (one element per injector); net thickness and area come from the locked NG5
// static volumes, so the field-unit pore volume 7758*A*h*phi can be compared
// against the exact metric one (they differ, and the difference is the lesson).
const PATTERN_DESIGN = {
  elementsPerField: 2,
  iw_design_rb_d: 2000, // the FDP design injection rate per element
  worLimit: 25,
  maxYears: 30,
  Sgi_case: 0.05, // the "if the flood had started below the bubble point" case
};

// Pressure surveillance. Surveys are taken on the first of the month at a
// six-month cadence; each reading is the closed-form tank pressure at the END
// of the PREVIOUS month, so every survey value is hand-checkable. The cadence
// deliberately straddles the pressure trough.
const PRESSURE_DESIGN = {
  survey_dates: ['2023-02-01', '2023-08-01', '2024-02-01', '2024-08-01', '2025-02-01', '2025-08-01'],
  pvt_grid: { pMin: 1800, pMax: 3400, step: 200 },
};

// ============================================================================
// Helpers (UTC-safe date arithmetic; no argless Date construction anywhere)
// ============================================================================

const dUTC = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const daysBetween = (isoA, isoB) => (dUTC(isoB) - dUTC(isoA)) / 86400000;
const isoOf = (utcMs) => new Date(utcMs).toISOString().slice(0, 10);
const addMonths = (iso, n) => {
  const [y, m] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const yy = Math.floor(total / 12);
  const mm = total - yy * 12;
  return isoOf(Date.UTC(yy, mm, 1));
};
const monthsBetween = (isoA, isoB) => {
  const [ya, ma] = isoA.split('-').map(Number);
  const [yb, mb] = isoB.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
const daysInMonthOf = (iso) => daysBetween(iso, addMonths(iso, 1));

// Monthly firsts from startIso through endIso inclusive.
function monthlyDates(startIso, endIso) {
  const out = [];
  for (let d = startIso; d <= endIso; d = addMonths(d, 1)) out.push(d);
  return out;
}

// Closed-form Arps rate and cumulative (t in days).
function arpsRate(w, t) {
  if (t < 0) return 0;
  if (w.model === 'exponential') return w.qi * Math.exp(-w.Di * t);
  if (w.model === 'harmonic') return w.qi / (1 + w.Di * t);
  return w.qi / Math.pow(1 + w.b * w.Di * t, 1 / w.b);
}
function arpsCum(w, t) {
  if (t <= 0) return 0;
  if (w.model === 'exponential') return (w.qi / w.Di) * (1 - Math.exp(-w.Di * t));
  if (w.model === 'harmonic') return (w.qi / w.Di) * Math.log(1 + w.Di * t);
  const { qi, Di, b } = w;
  return (qi / (Di * (1 - b))) * (1 - Math.pow(1 + b * Di * t, 1 - 1 / b));
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Gross-liquid rate under the flood response model (see plan §3 and the
// per-producer flood config above). Returns { gross, wc, oil, water }.
function floodRate(w, dateIso) {
  const base = arpsRate(w, daysBetween(w.start, FLOOD_START));
  const m = monthsBetween(FLOOD_START, dateIso);
  const { lagMonths, lift, btDate, wcMax } = w.flood;
  let gross;
  if (m < lagMonths + RAMP_MONTHS) {
    const r = clamp01((m - lagMonths) / RAMP_MONTHS);
    gross = base * (1 + (lift - 1) * r);
  } else {
    const rampEnd = addMonths(FLOOD_START, lagMonths + RAMP_MONTHS);
    gross = base * lift * Math.exp(-FLOOD_DECLINE_PER_DAY * daysBetween(rampEnd, dateIso));
  }
  let wc = 0;
  if (btDate && dateIso >= btDate) {
    const s = clamp01(monthsBetween(btDate, dateIso) / monthsBetween(btDate, HISTORY_END));
    wc = wcMax * s * s;
  }
  return { gross, wc, oil: gross * (1 - wc), water: gross * wc };
}

// Oil rate on a given monthly date (primary Arps before the flood, response
// model from the flood start).
function wellRates(w, dateIso) {
  if (dateIso < FLOOD_START) {
    return { oil: arpsRate(w, daysBetween(w.start, dateIso)), water: 0 };
  }
  const f = floodRate(w, dateIso);
  return { oil: f.oil, water: f.water };
}

function assertClose(label, actual, expected, relTol) {
  const denom = Math.max(Math.abs(expected), 1e-12);
  const rel = Math.abs(actual - expected) / denom;
  if (!(rel <= relTol)) {
    throw new Error(`ASSERT ${label}: actual ${actual} vs expected ${expected} (rel ${rel} > ${relTol})`);
  }
  return rel;
}

const report = [];
const say = (line) => { report.push(line); console.log(line); };

// ============================================================================
// A. Rates fixture (RC1)
// ============================================================================

say('=== Ekene dynamic fixture generation ===');

const ratesWells = PRODUCERS.map((w) => {
  const dates = monthlyDates(w.start, HISTORY_END);
  const monthly = dates.map((d) => {
    const { oil } = wellRates(w, d);
    return { date: d, oil_bpd: oil };
  });
  const primary = monthly.filter((r) => r.date < FLOOD_START);

  // Fit the PRIMARY window with the real engine (auto-select) — must recover
  // the planted model and parameters on this noise-free data.
  const fitPrimary = fitArpsModel(
    primary.map((r) => ({ date: r.date, rate: r.oil_bpd })),
    'Auto-Select',
  );
  const modelName = { exponential: 'Exponential', harmonic: 'Harmonic', hyperbolic: 'Hyperbolic' }[w.model];
  if (fitPrimary.parameters.modelType !== modelName) {
    throw new Error(`${w.name}: auto-select picked ${fitPrimary.parameters.modelType}, planted ${modelName}`);
  }
  assertClose(`${w.name} qi`, fitPrimary.parameters.qi, w.qi, 1e-6);
  assertClose(`${w.name} Di`, fitPrimary.parameters.Di, w.Di, 1e-6);
  if (Math.abs(fitPrimary.parameters.b - w.b) > 1e-3) {
    throw new Error(`${w.name}: recovered b ${fitPrimary.parameters.b} vs planted ${w.b}`);
  }

  // The NAIVE fit through the whole history (flood response included) — the
  // "decline analysis assumes unchanging conditions" lesson. Recorded verbatim.
  const fitNaive = fitArpsModel(
    monthly.map((r) => ({ date: r.date, rate: r.oil_bpd })),
    'Auto-Select',
  );

  const tFlood = daysBetween(w.start, FLOOD_START);
  const eur = calculateEUR(w.qi, w.Di, w.b, ECON_LIMIT_BOPD, w.model);

  say(`${w.name}: ${w.model} qi=${w.qi} Di=${w.Di} b=${w.b} | recovered qi=${fitPrimary.parameters.qi} Di=${fitPrimary.parameters.Di} b=${fitPrimary.parameters.b} R2=${fitPrimary.R2}`);
  say(`  Np@floodStart=${arpsCum(w, tFlood)} stb, EUR@${ECON_LIMIT_BOPD}bopd=${eur} stb, naive-fit=${fitNaive.parameters.modelType} R2=${fitNaive.R2}`);

  return {
    name: w.name,
    start_date: w.start,
    planted: { model: w.model, qi_bpd: w.qi, di_per_day: w.Di, b: w.b },
    primary_window: { start: w.start, end_exclusive: FLOOD_START },
    flood_response: { ...w.flood, ramp_months: RAMP_MONTHS, post_ramp_decline_per_day: FLOOD_DECLINE_PER_DAY },
    monthly,
    closed_form: {
      np_at_flood_start_stb: arpsCum(w, tFlood),
      rate_at_flood_start_bpd: arpsRate(w, tFlood),
      eur_at_econ_limit_stb: eur,
      econ_limit_bopd: ECON_LIMIT_BOPD,
    },
    engine_fit_primary_window: {
      modelType: fitPrimary.parameters.modelType,
      qi: fitPrimary.parameters.qi,
      Di: fitPrimary.parameters.Di,
      b: fitPrimary.parameters.b,
      R2: fitPrimary.R2,
      RMSE: fitPrimary.RMSE,
      t0: fitPrimary.t0,
    },
    engine_fit_full_history_naive: {
      modelType: fitNaive.parameters.modelType,
      qi: fitNaive.parameters.qi,
      Di: fitNaive.parameters.Di,
      b: fitNaive.parameters.b,
      R2: fitNaive.R2,
      RMSE: fitNaive.RMSE,
      t0: fitNaive.t0,
    },
  };
});

// ============================================================================
// B. Material-balance fixture (RC2)
// ============================================================================

const D = MBAL_DESIGN;
const N = STATIC_FIELD.stoiip_stb;
const Boi = STATIC_FIELD.boi_rb_stb;
const Swi = STATIC_FIELD.swi;

// Efw slope per psi (the engine's own formula, m = 0): Bti*(Swi*cw+cf)/(1-Swi)
const efwSlope = (Swi * D.cw_per_psi + D.cf_per_psi) / (1 - Swi);
// Closed-form pressure inversion: N*Boi*(co+efwSlope)*dp = Np*Boi*(1+co*dp)
//   => dp = Np / (N*(co+efwSlope) - Np*co)
const dpForNp = (Np) => Np / (N * (D.co_per_psi + efwSlope) - Np * D.co_per_psi);
const boAt = (p) => Boi * (1 + D.co_per_psi * (D.pi_psia - p));

const fieldNpAt = (dateIso) =>
  PRODUCERS.reduce((s, w) => s + arpsCum(w, Math.max(0, daysBetween(w.start, dateIso))), 0);

const productionData = [
  {
    timestep_index: 0,
    observation_date: PRODUCTION_START,
    pressure_psia: D.pi_psia,
    cum_oil_stb: 0,
    cum_gas_scf: 0,
    cum_water_stb: 0,
    bo_rb_stb: Boi,
    rs_scf_stb: D.rsi_scf_stb,
    bw_rb_stb: D.bw_rb_stb,
  },
  ...D.survey_dates.map((date, i) => {
    const Np = fieldNpAt(date);
    const dp = dpForNp(Np);
    const p = D.pi_psia - dp;
    if (p < D.pb_psia) throw new Error(`survey ${date}: pressure ${p} fell below pb ${D.pb_psia}`);
    return {
      timestep_index: i + 1,
      observation_date: date,
      pressure_psia: p,
      cum_oil_stb: Np,
      cum_gas_scf: D.rsi_scf_stb * Np,
      cum_water_stb: 0,
      bo_rb_stb: boAt(p),
      rs_scf_stb: D.rsi_scf_stb,
      bw_rb_stb: D.bw_rb_stb,
    };
  }),
];

// Documentation-grade lab PVT table on the same design lines (per-row values
// above take precedence in the engine; the table is the course-facing PVT).
const pvtLabTable = [3400, 3200, 2900, 2600, 2300, 2000].map((p) => ({
  pressure_psia: p,
  bo_rb_stb: boAt(p),
  rs_scf_stb: D.rsi_scf_stb,
  bw_rb_stb: D.bw_rb_stb,
  oil_viscosity_cp: 2.05 + (3200 - p) * (1.77 - 2.05) / 1200, // 2.05 cp at pi, 1.77 at pb (linear)
}));

const mbalInputs = {
  fluid_system: 'oil',
  has_aquifer: false,
  has_gas_cap: false,
  initial_pressure_psia: D.pi_psia,
  reservoir_temperature_f: D.temp_f,
  initial_water_saturation: Swi,
  bubble_point_psia: D.pb_psia,
  oil_gravity_api: D.api,
  gas_specific_gravity: D.gas_sg,
  water_salinity_ppm: D.salinity_ppm,
  formation_compressibility_psi: D.cf_per_psi,
  water_compressibility_psi: D.cw_per_psi,
  aquifer_model: 'none',
  pvt_source: 'lab_table',
  pvt_correlations: {
    pb_rs_bo: 'standing',
    oil_viscosity: 'beggs_robinson',
    z_factor: 'hall_yarborough',
    water: 'mccain',
    gas_viscosity: 'lee_gonzalez_eakin',
  },
  pvt_lab_table: pvtLabTable,
  solver_method: 'havlena_odeh',
  production_data: productionData,
};

const mbalResult = computeMaterialBalance(mbalInputs);
assertClose('MBAL OOIP vs NG5 STOIIP', mbalResult.estimated_ooip_stb, N, 1e-9);
say(`MBAL: OOIP=${mbalResult.estimated_ooip_stb} stb (NG5 ${N}), R2=${mbalResult.r_squared}, p(floodStart)=${productionData[6].pressure_psia} psia`);

// ============================================================================
// C. SCAL / displacement fixture (RC3)
// ============================================================================

const displacement = analyzeDisplacement({
  krSpec: SCAL_DESIGN.krSpec,
  muW: SCAL_DESIGN.muW_cp,
  muO: SCAL_DESIGN.muO_cp,
});
const M = mobilityRatio(SCAL_DESIGN.krSpec, SCAL_DESIGN.muW_cp, SCAL_DESIGN.muO_cp);
say(`SCAL: M=${M}, Swf=${displacement.bl.Swf}, fw@front=${displacement.bl.fwf ?? displacement.bl.fwSwf ?? 'see bl'}, bl keys=${Object.keys(displacement.bl).join(',')}`);

const pvBbl = STATIC_FIELD.pore_m3 * STATIC_FIELD.stb_per_m3;

// ============================================================================
// C2. Capillary / J-function fixture (RC3)
// ============================================================================

const M_TO_FT = 1 / 0.3048;
const gammaO = 141.5 / (131.5 + MBAL_DESIGN.api); // from the locked API 32
const capFluids = { gammaW: CAP_DESIGN.gammaW, gammaHc: gammaO };
const gradPsiPerFt = PSI_PER_FT_WATER * (CAP_DESIGN.gammaW - gammaO);
const sigmaCosOf = (s) => s.sigma_dyncm * Math.cos((s.thetaDeg * Math.PI) / 180);
// psi of Pc per unit J on a given rock/fluid pair (the pcFromJ scaling factor).
const psiPerJ = (s) => sigmaCosOf(s) / (LEVERETT_C * Math.sqrt(s.k_md / s.phi));
const jTrueAt = (Sw) => {
  const { a, b, Swirr } = CAP_DESIGN.jTrue;
  return a * Math.pow((Sw - Swirr) / (1 - Swirr), -b);
};

// Lab Pc per plug, generated from the designed J curve through the engine.
const labPlugs = CAP_DESIGN.plugs.map((plug) => {
  const pc = pcFromJ(CAP_DESIGN.jTrue, plug, CAP_DESIGN.swGrid);
  if (!pc.ok) throw new Error(`pcFromJ failed for ${plug.name}: ${pc.errors.join('; ')}`);
  return { ...plug, rows: pc.rows };
});

// The collapse: each plug's lab table reduces back to the ONE designed curve.
const plugJTables = labPlugs.map((plug) => {
  const jt = computeJTable(plug.rows.map((r) => ({ Sw: r.Sw, Pc_psi: r.Pc_psi })), plug);
  if (!jt.ok) throw new Error(`computeJTable failed for ${plug.name}: ${jt.errors.join('; ')}`);
  return jt.rows;
});
let collapseMaxSpread = 0;
for (let i = 0; i < plugJTables[0].length; i++) {
  const values = plugJTables.map((rows) => rows[i].J);
  collapseMaxSpread = Math.max(collapseMaxSpread, Math.max(...values) - Math.min(...values));
  assertClose(`J collapse row ${i}`, values[0], jTrueAt(plugJTables[0][i].Sw), 1e-9);
}
if (!(collapseMaxSpread < 1e-9)) throw new Error(`J collapse spread ${collapseMaxSpread} not < 1e-9`);

// Power-law fit on one plug recovers the plant; averaging over all three
// returns the source curve (its refit runs on the Sw* axis, same a and b).
const capFitSingle = fitJPowerLaw(
  plugJTables[1].map((r) => ({ Sw: r.Sw, J: r.J })),
  { Swirr: CAP_DESIGN.jTrue.Swirr },
);
assertClose('J fit a', capFitSingle.a, CAP_DESIGN.jTrue.a, 1e-6);
assertClose('J fit b', capFitSingle.b, CAP_DESIGN.jTrue.b, 1e-6);
const capAverage = averageJCurves(
  labPlugs.map((plug, i) => ({ name: plug.name, jRows: plugJTables[i].map((r) => ({ Sw: r.Sw, J: r.J })) })),
  { Swirr: CAP_DESIGN.jTrue.Swirr },
);
if (!capAverage.ok) throw new Error(`averageJCurves failed: ${capAverage.errors.join('; ')}`);
// The average refit is NOT exact: averageJCurves resamples each plug through
// its log-linear tabulated evaluator before refitting, so a and b drift a
// few tenths of a percent while the direct fit on raw points recovers the
// plant to 1e-6. Engine behavior worth teaching, recorded as a golden.
assertClose('J average refit a (interpolation drift)', capAverage.fit.a, CAP_DESIGN.jTrue.a, 2e-2);
assertClose('J average refit b (interpolation drift)', capAverage.fit.b, CAP_DESIGN.jTrue.b, 2e-2);

// Reservoir Pc and the saturation-height profile on the Ekene sand rock.
const reservoirPc = pcFromJ(CAP_DESIGN.jTrue, CAP_DESIGN.reservoir, CAP_DESIGN.swGrid);
if (!reservoirPc.ok) throw new Error(`reservoir pcFromJ failed: ${reservoirPc.errors.join('; ')}`);
const capHeight = swVsHeight(CAP_DESIGN.jTrue, CAP_DESIGN.reservoir, capFluids, CAP_DESIGN.swGrid);
if (!capHeight.ok) throw new Error(`swVsHeight failed: ${capHeight.errors.join('; ')}`);

// Entry pressure (Sw = 1, J = a) and the FWL placement: Sw reaches 1.0
// exactly at the mapped 1560 m contact, so FWL = contact + entry height.
const pcEntryPsi = CAP_DESIGN.jTrue.a * psiPerJ(CAP_DESIGN.reservoir);
const hEntryFt = heightFromPc(pcEntryPsi, capFluids);
const hEntryM = hEntryFt * 0.3048;
const fwlM = STATIC_FIELD.owc_m_tvd + hEntryM;
assertClose('entry height round trip', hEntryFt, pcEntryPsi / gradPsiPerFt, 1e-12);

// Crest saturation: the highest point of the oil column sits
// max_oil_column_m above the contact, entry height + that above the FWL.
const hCrestFt = (STATIC_FIELD.max_oil_column_m + hEntryM) * M_TO_FT;
const jAtCrest = (hCrestFt * gradPsiPerFt) / psiPerJ(CAP_DESIGN.reservoir);
const swAtCrest =
  CAP_DESIGN.jTrue.Swirr +
  Math.pow(jAtCrest / CAP_DESIGN.jTrue.a, -1 / CAP_DESIGN.jTrue.b) * (1 - CAP_DESIGN.jTrue.Swirr);
// Design intent: the booking's flat Sw 0.35 is what the crest drains to.
assertClose('Sw at crest vs the NG5 booking Swi', swAtCrest, STATIC_FIELD.swi, 0.002);

// Height-averaged Sw over the crest column (composite trapezoid, 2000
// intervals from the contact h = hEntry to the crest): the honest number
// the flat 0.35 booking replaces for THIS column.
const N_TRAPZ = 2000;
let swSum = 0;
for (let i = 0; i <= N_TRAPZ; i++) {
  const h = hEntryFt + ((hCrestFt - hEntryFt) * i) / N_TRAPZ;
  const j = (h * gradPsiPerFt) / psiPerJ(CAP_DESIGN.reservoir);
  const sw = Math.min(
    1,
    CAP_DESIGN.jTrue.Swirr +
      Math.pow(j / CAP_DESIGN.jTrue.a, -1 / CAP_DESIGN.jTrue.b) * (1 - CAP_DESIGN.jTrue.Swirr),
  );
  swSum += i === 0 || i === N_TRAPZ ? sw / 2 : sw;
}
const swAvgCrestColumn = swSum / N_TRAPZ;
if (!(swAvgCrestColumn > STATIC_FIELD.swi)) {
  throw new Error(`column-average Sw ${swAvgCrestColumn} should exceed the flat booking ${STATIC_FIELD.swi}`);
}

say(
  `SCAL capillary: collapse spread=${collapseMaxSpread}, fit a=${capFitSingle.a} b=${capFitSingle.b}, ` +
    `entry ${pcEntryPsi} psi = ${hEntryM} m, FWL ${fwlM} m, Sw@crest ${swAtCrest}, colAvg ${swAvgCrestColumn}`,
);

// ============================================================================
// D. Waterflood ledger + surveillance fixture (RC4)
// ============================================================================

const floodMonths = monthlyDates(FLOOD_START, HISTORY_END);
const injectors = WELL_TABLE.filter((w) => w.role.startsWith('injector')).map((w) => w.name);

const ledgerPeriods = [];
const surveillanceRows = [];
for (let m = 0; m < floodMonths.length; m++) {
  const date = floodMonths[m];
  const days = daysInMonthOf(date);
  let oilDaily = 0;
  let waterDaily = 0;
  for (const w of PRODUCERS) {
    const r = wellRates(w, date);
    oilDaily += r.oil;
    waterDaily += r.water;
    surveillanceRows.push({
      date,
      well: w.name,
      oil_bbl: r.oil,
      water_bbl: r.water,
      gas_mcf: (r.oil * D.rsi_scf_stb) / 1000,
      inj_bbl: 0,
      whp_psi: null,
    });
  }
  const Np = oilDaily * days;
  const Wp = waterDaily * days;
  const producedVoidage = Np * FLOOD_DESIGN.fvf.Bo + Wp * FLOOD_DESIGN.fvf.Bw;
  const target = FLOOD_DESIGN.vrrTarget(m);
  const WiTotal = (target * producedVoidage) / FLOOD_DESIGN.fvf.Bw;
  for (const inj of injectors) {
    const share = FLOOD_DESIGN.injectionSplit[inj];
    const injDaily = (WiTotal * share) / days;
    const ii = FLOOD_DESIGN.injectivity[inj](date);
    surveillanceRows.push({
      date,
      well: inj,
      oil_bbl: 0,
      water_bbl: 0,
      gas_mcf: 0,
      inj_bbl: injDaily,
      whp_psi: FLOOD_DESIGN.refPressure_psia + injDaily / ii,
    });
  }
  ledgerPeriods.push({
    label: date.slice(0, 7),
    Np,
    Wp,
    Gp: (D.rsi_scf_stb * Np) / 1000, // Mscf, all solution gas
    Wi: WiTotal,
    Gi: 0,
    vrr_target: target,
  });
}

const vrrSeries = computeVRRSeries(ledgerPeriods, FLOOD_DESIGN.fvf);
const vrrSummary = summarizeVRR(vrrSeries);
assertClose('month-0 instantaneous VRR vs target', vrrSeries[0].instantaneousVRR, 0.85, 1e-12);
assertClose('month-6 instantaneous VRR vs target', vrrSeries[6].instantaneousVRR, 1.05, 1e-12);
say(`VRR: cumulative=${vrrSummary.cumulativeVRR}, latest=${vrrSummary.latestInstantaneousVRR}, totalProducedVoidage=${vrrSummary.totalProducedVoidage} rb`);

// ============================================================================
// E. Flood design + pattern surveillance fixture (RC4)
// ============================================================================
//
// Everything below is derived by RUNNING the waterflood engines on the ledger
// built in section D. Five blocks:
//   E1  per-well ledger rows (the vrrLedger row schema) and the invariant that
//       they rebuild section D's field periods exactly;
//   E2  allocation factors, pattern periods and pattern VRR;
//   E3  the closed-form flood-era pressure track, six-monthly surveys, the
//       PVT grid, and VRR recomputed on a pressure-tracked Bo;
//   E4  layered sweep (Dykstra-Parsons + Stiles) on the planted layer set;
//   E5  five-spot pattern forecasts and the daily-surveillance diagnostics
//       (Hall, Chan, cross-correlation lags).

// ---------------------------------------------------------------- E1. rows
// The ledger schema carries monthly VOLUMES per well; the surveillance schema
// carries daily RATES. Same flood, two shapes: converting between them is a
// month-length multiply and nothing else.
const ledgerRows = surveillanceRows.map((r) => {
  const days = daysInMonthOf(r.date);
  return {
    date: r.date,
    well: r.well,
    oil_stb: r.oil_bbl * days,
    water_stb: r.water_bbl * days,
    gas_mscf: r.gas_mcf * days,
    winj_stb: r.inj_bbl * days,
    ginj_mscf: 0,
  };
});

const rebuiltPeriods = buildFieldPeriods(ledgerRows);
if (rebuiltPeriods.length !== ledgerPeriods.length) {
  throw new Error(`rebuilt period count ${rebuiltPeriods.length} != ${ledgerPeriods.length}`);
}
let periodMaxRel = 0;
rebuiltPeriods.forEach((p, i) => {
  const q = ledgerPeriods[i];
  if (p.label !== q.label) throw new Error(`period label mismatch at ${i}: ${p.label} vs ${q.label}`);
  for (const k of ['Np', 'Wp', 'Gp', 'Wi', 'Gi']) {
    const rel = q[k] === 0 ? Math.abs(p[k]) : Math.abs(p[k] - q[k]) / Math.abs(q[k]);
    if (rel > periodMaxRel) periodMaxRel = rel;
  }
});
if (!(periodMaxRel < 1e-12)) throw new Error(`per-well rows do not rebuild the field periods (max rel ${periodMaxRel})`);
say(`ledger rows: ${ledgerRows.length} rows rebuild the ${ledgerPeriods.length} field periods, max rel diff ${periodMaxRel}`);

// ---------------------------------------------------------- E2. allocation
const allocValidation = validateAllocation(ALLOCATION);
if (!allocValidation.ok) throw new Error(`allocation invalid: ${allocValidation.errors.join('; ')}`);
const allocated = allocateInjection(ledgerRows, ALLOCATION);
const totalWinj = ledgerRows.reduce((s, r) => s + r.winj_stb, 0);
const allocatedSum = Object.values(allocated.perProducer).reduce((s, v) => s + v.winj_stb, 0);
const conservationResidual = totalWinj - (allocatedSum + allocated.unallocated.winj_stb);
if (conservationResidual !== 0) throw new Error(`allocation does not conserve exactly: residual ${conservationResidual}`);
say(`allocation: ${totalWinj} bbl injected = ${allocatedSum} allocated + ${allocated.unallocated.winj_stb} out-of-zone (residual ${conservationResidual})`);

const patternResults = PATTERNS.map((pattern) => {
  const periods = buildPatternPeriods(ledgerRows, pattern, ALLOCATION);
  const series = computeVRRSeries(periods, FLOOD_DESIGN.fvf);
  const rolling = computeRollingVRR(series, 3);
  const last = series[series.length - 1];
  const recommendation = recommendPatternInjection(ledgerRows, pattern, ALLOCATION, FLOOD_DESIGN.fvf, {
    targetVRR: 1.0,
    windowPeriods: 3,
  });
  return {
    name: pattern.name,
    producers: pattern.producers,
    periods,
    cumulative_vrr: last.cumulativeVRR,
    latest_instantaneous_vrr: last.instantaneousVRR,
    rolling3_last: rolling[rolling.length - 1],
    total_produced_voidage_rb: last.cumProd,
    total_injected_voidage_rb: last.cumInj,
    fill_up: findFillUp(series),
    recommendation,
  };
});
patternResults.forEach((p) => {
  say(`pattern ${p.name}: cumVRR=${p.cumulative_vrr}, roll3=${p.rolling3_last}, fillUp=${JSON.stringify(p.fill_up)}`);
});
// The field is balanced while its two elements are not: that split is the
// whole point of pattern-level surveillance.
const northVrr = patternResults[0].cumulative_vrr;
const southVrr = patternResults[1].cumulative_vrr;
if (!(northVrr > 1.15 && southVrr < 0.7 && vrrSummary.cumulativeVRR > 1.0 && vrrSummary.cumulativeVRR < 1.05)) {
  throw new Error(`pattern split lost its teaching shape: field ${vrrSummary.cumulativeVRR}, north ${northVrr}, south ${southVrr}`);
}

// ------------------------------------------------------------ E3. pressure
// Closed-form flood-era tank pressure. The undersaturated balance with
// injection is  Np*Bo + (Wp - Wi)*Bw = N*Boi*(co + efwSlope)*dp  with
// Bo = Boi*(1 + co*dp), which inverts to
//   dp = (Np + (Wp - Wi)*Bw/Boi) / (N*(co + efwSlope) - Np*co)
// exactly as the depletion-only form in section B, with the injected volume
// entering as a negative withdrawal. Cumulative volumes are counted from
// PRODUCTION_START, so the flood-era track continues the depletion track with
// no seam.
const dpForNetWithdrawal = (Np, Wp, Wi) => {
  const water = ((Wp - Wi) * D.bw_rb_stb) / Boi;
  return (Np + water) / (N * (D.co_per_psi + efwSlope) - Np * D.co_per_psi);
};
const npAtFloodStart = fieldNpAt(FLOOD_START);
const pAtFloodStart = D.pi_psia - dpForNetWithdrawal(npAtFloodStart, 0, 0);
assertClose('flood-start pressure continues the depletion track', pAtFloodStart, productionData[6].pressure_psia, 1e-15);

let cumNp = npAtFloodStart;
let cumWp = 0;
let cumWi = 0;
const pressureTrack = ledgerPeriods.map((p) => {
  cumNp += p.Np;
  cumWp += p.Wp;
  cumWi += p.Wi;
  return {
    label: p.label,
    cum_np_stb: cumNp,
    cum_wp_stb: cumWp,
    cum_wi_bbl: cumWi,
    p_end_psia: D.pi_psia - dpForNetWithdrawal(cumNp, cumWp, cumWi),
  };
});
// Break-even VRR: while Wp is zero the net withdrawal changes sign at
// VRR = Boi / Bo(ledger), NOT at 1.0, because the ledger freezes Bo at the
// flood-era 2100 psia while the tank is referenced to Boi at 3200 psia.
const breakEvenVrr = Boi / FLOOD_DESIGN.fvf.Bo;
const troughIndex = pressureTrack.reduce((best, r, i) => (r.p_end_psia < pressureTrack[best].p_end_psia ? i : best), 0);
const troughPeriod = pressureTrack[troughIndex];
say(`pressure: floodStart=${pAtFloodStart}, trough=${troughPeriod.p_end_psia} psia at ${troughPeriod.label}, end=${pressureTrack[pressureTrack.length - 1].p_end_psia}, breakEvenVRR=${breakEvenVrr}`);
if (!(troughIndex > 0 && troughIndex < 6)) throw new Error(`pressure trough moved out of the ramp window (index ${troughIndex})`);

// Surveys read the END-of-previous-month track value, so every survey number
// is a row of the track and nothing is interpolated to make the fixture.
const trackByLabel = new Map(pressureTrack.map((r) => [r.label, r.p_end_psia]));
const pressureSurveys = PRESSURE_DESIGN.survey_dates.map((date) => {
  const prev = addMonths(date, -1).slice(0, 7);
  const p = trackByLabel.get(prev);
  if (p == null) throw new Error(`survey ${date} has no preceding track month ${prev}`);
  return { date, p_psia: p, reads_month: prev };
});

const attached = attachPressure(ledgerPeriods, pressureSurveys);
const attachedTroughIndex = attached.reduce(
  (best, r, i) => (r.pressure != null && (attached[best].pressure == null || r.pressure < attached[best].pressure) ? i : best),
  0,
);
const troughMissedBy = attached[attachedTroughIndex].pressure - troughPeriod.p_end_psia;
say(`survey cadence: true trough ${troughPeriod.label}, interpolated trough ${attached[attachedTroughIndex].label}, missed by ${troughMissedBy} psi`);
if (attached[attachedTroughIndex].label === troughPeriod.label) {
  throw new Error('the six-monthly survey cadence was supposed to MISS the trough month');
}

// PVT grid on the fixture's own Bo line (the same line the mbal lab table
// samples), so interpolateFvfTrack is exact and the lesson is why.
const pvtTable = [];
for (let p = PRESSURE_DESIGN.pvt_grid.pMin; p <= PRESSURE_DESIGN.pvt_grid.pMax; p += PRESSURE_DESIGN.pvt_grid.step) {
  pvtTable.push({ p, Bo: boAt(p), Bw: D.bw_rb_stb, Bg: 0, Rs: D.rsi_scf_stb });
}
const fvfTrack = interpolateFvfTrack(pvtTable, attached.map((r) => r.pressure));
let fvfMaxRel = 0;
fvfTrack.forEach((f, i) => {
  const exact = boAt(attached[i].pressure);
  const rel = Math.abs(f.Bo - exact) / exact;
  if (rel > fvfMaxRel) fvfMaxRel = rel;
});
if (!(fvfMaxRel < 1e-14)) throw new Error(`interpolated Bo is not exact on a linear Bo line (max rel ${fvfMaxRel})`);

const trackedPeriods = ledgerPeriods.map((p, i) => ({ ...p, Bo: fvfTrack[i].Bo }));
const trackedSeries = computeVRRSeries(trackedPeriods, FLOOD_DESIGN.fvf);
const trackedCumVrr = trackedSeries[trackedSeries.length - 1].cumulativeVRR;
const frozenCumVrr = vrrSummary.cumulativeVRR;
say(`VRR on a pressure-tracked Bo: ${trackedCumVrr} vs frozen ${frozenCumVrr} (${((trackedCumVrr / frozenCumVrr - 1) * 100)} pct)`);

// ------------------------------------------------------- E4. layered sweep
const layerZ = (i) => inverseNormal((i + 0.5) / LAYER_DESIGN.n);
const layerK = (rank) => LAYER_DESIGN.k50_md * Math.exp(-LAYER_DESIGN.sigma * layerZ(rank));
const layerColumn = LAYER_DESIGN.column.map((l) => ({ name: l.name, h_ft: l.h_ft, k_md: layerK(l.rank), quantile_rank: l.rank }));
const netPayFt = layerColumn.reduce((s, l) => s + l.h_ft, 0);
// Stiles capacity ratio: A = (krw/muW)/(kro/muO) * (Bo/Bw) = M * Bo/Bw.
const stilesA = (M * FLOOD_DESIGN.fvf.Bo) / FLOOD_DESIGN.fvf.Bw;
const sweep = analyzeLayeredSweep({
  layers: layerColumn.map((l) => ({ h: l.h_ft, k: l.k_md })),
  M,
  A: stilesA,
});
assertClose('planted permeability variation recovers V = 0.5', sweep.V.V, 0.5, 1e-15);
assertClose('planted sigma recovers ln 2', sweep.V.sigma, Math.log(2), 1e-15);
const EV_FIRST_BT = sweep.dykstraParsons[0].coverage;
say(`layers: net ${netPayFt} ft, V=${sweep.V.V}, sigma=${sweep.V.sigma}, k50=${sweep.V.k50}, A=${stilesA}, EV@firstBT=${EV_FIRST_BT}, Stiles@firstBT=${sweep.stiles[0].coverage}`);

// ---------------------------------------------- E5. forecasts + diagnostics
const M2_PER_ACRE = 4046.8564224;
const oilAreaM2 = STATIC_FIELD.oil_cells * STATIC_FIELD.cell_size_m * STATIC_FIELD.cell_size_m;
const oilAreaAcres = oilAreaM2 / M2_PER_ACRE;
const elementAreaAcres = oilAreaAcres / PATTERN_DESIGN.elementsPerField;
const netThicknessFt = (STATIC_FIELD.net_m3 / oilAreaM2) * M_TO_FT;
const pvFieldUnits = 7758 * elementAreaAcres * netThicknessFt * STATIC_FIELD.phi;
const pvExactRb = pvBbl / PATTERN_DESIGN.elementsPerField;
const pvUnitRelDiff = (pvFieldUnits - pvExactRb) / pvExactRb;
// Observed injection per element, in RESERVOIR barrels per day.
const floodDays = daysBetween(FLOOD_START, addMonths(HISTORY_END, 1));
const totalWiBbl = ledgerPeriods.reduce((s, p) => s + p.Wi, 0);
const iwObservedRbD = (totalWiBbl * FLOOD_DESIGN.fvf.Bw) / floodDays / PATTERN_DESIGN.elementsPerField;
say(`pattern element: ${elementAreaAcres} acres x ${netThicknessFt} ft, PV(7758)=${pvFieldUnits} rb vs exact ${pvExactRb} rb (${pvUnitRelDiff}), iw observed ${iwObservedRbD} rb/d over ${floodDays} d`);

const displacementSpec = { krSpec: SCAL_DESIGN.krSpec, muW: SCAL_DESIGN.muW_cp, muO: SCAL_DESIGN.muO_cp };
const basePattern = {
  area_acres: elementAreaAcres,
  h_ft: netThicknessFt,
  phi: STATIC_FIELD.phi,
  Bo: FLOOD_DESIGN.fvf.Bo,
  Bw: FLOOD_DESIGN.fvf.Bw,
  Sgi: 0,
  EV: 1,
  worLimit: PATTERN_DESIGN.worLimit,
  maxYears: PATTERN_DESIGN.maxYears,
};
const forecastCases = {
  observed: { ...basePattern, iw_bpd: iwObservedRbD },
  design: { ...basePattern, iw_bpd: PATTERN_DESIGN.iw_design_rb_d, EV: EV_FIRST_BT },
  fillup: { ...basePattern, iw_bpd: PATTERN_DESIGN.iw_design_rb_d, EV: EV_FIRST_BT, Sgi: PATTERN_DESIGN.Sgi_case },
};
const forecasts = {};
for (const [name, pat] of Object.entries(forecastCases)) {
  const r = forecastPattern({ displacementSpec, pattern: pat });
  forecasts[name] = { inputs: pat, summary: r.summary, breakthrough: r.breakthrough, steps: r.series.length, warnings: r.warnings };
  say(`forecast ${name}: BT=${r.summary.breakthrough_days} d, Np=${r.summary.Np_stb} stb, RF=${r.summary.recoveryFactorOfFloodedOOIP}, stopped=${r.summary.stopped}`);
}
if (forecasts.observed.summary.breakthrough_days !== null) {
  throw new Error('the observed-rate element was supposed to stay pre-breakthrough over the whole horizon');
}
if (!(forecasts.design.summary.breakthrough_days > 0)) throw new Error('the design case must break through');

// The observed breakthrough at Ekene-6 (2024-03-01) against the pattern
// arithmetic: the swept pore volume implied by that date is a small fraction
// of the element, which is what "channeling" means quantitatively.
const e6BtDate = PRODUCERS.find((w) => w.name === 'Ekene-6').flood.btDate;
const e6BtDays = daysBetween(FLOOD_START, e6BtDate);
const e6AllocatedBbl = ledgerRows
  .filter((r) => r.date < e6BtDate && r.winj_stb > 0)
  .reduce((s, r) => {
    const frac = ALLOCATION[r.well]?.['Ekene-6'] ?? 0;
    return s + r.winj_stb * frac;
  }, 0);
const e6EAbt = forecasts.design.summary.EAbt;
const impliedSweptPvRb = (e6AllocatedBbl * FLOOD_DESIGN.fvf.Bw) / (displacement.bl.QiBt * e6EAbt);
const impliedSweptFraction = impliedSweptPvRb / pvExactRb;
say(`Ekene-6 breakthrough ${e6BtDate} (${e6BtDays} d): ${e6AllocatedBbl} bbl allocated -> implied swept PV ${impliedSweptPvRb} rb = ${impliedSweptFraction} of the element`);

// Daily-surveillance diagnostics. NOTE the config key case: this engine reads
// lowercase bo/bw/bg/rs; the capitalised ledger shape silently defaults to
// Bo = 1 and inflates VRR. Both runs are recorded so the course can show it.
const surveillanceConfig = { bo: FLOOD_DESIGN.fvf.Bo, bw: FLOOD_DESIGN.fvf.Bw, bg: FLOOD_DESIGN.fvf.Bg, rs: FLOOD_DESIGN.fvf.Rs };
const surveillance = analyzeWaterflood(surveillanceRows, surveillanceConfig);
const surveillanceWrongCase = analyzeWaterflood(surveillanceRows, FLOOD_DESIGN.fvf);
const wrongCaseRatio = surveillanceWrongCase.kpis.vrr_avg / surveillance.kpis.vrr_avg;
say(`surveillance: cumVRR(rows-as-days)=${surveillance.kpis.vrr_avg} vs ledger volumes ${frozenCumVrr}; wrong-case config inflates by ${wrongCaseRatio}`);

// Hall plots twice: on the measured absolute wellhead pressure, and on the
// pressure ABOVE the reference (the classic Hall convention). Only the second
// recovers the planted injectivity index.
const deltaPRows = surveillanceRows.map((r) => ({
  ...r,
  whp_psi: r.whp_psi == null ? null : r.whp_psi - FLOOD_DESIGN.refPressure_psia,
}));
const surveillanceDeltaP = analyzeWaterflood(deltaPRows, surveillanceConfig);
const hallOf = (a) => a.hall_plots.map((h) => ({
  injector: h.injector,
  slope_baseline: h.slope_baseline,
  slope_recent: h.slope_last,
  slope_ratio: h.slope_ratio,
}));
const hallDeltaP = hallOf(surveillanceDeltaP);
const e4DeltaP = hallDeltaP.find((h) => h.injector === 'Ekene-4');
assertClose('Hall baseline slope on delta-p is 1/II', e4DeltaP.slope_baseline, 1 / 0.5, 1e-12);
assertClose('Hall recent slope on delta-p is 1/II after the kink', e4DeltaP.slope_recent, 1 / 0.35, 1e-12);
assertClose('Hall slope ratio recovers the injectivity step', e4DeltaP.slope_ratio, 0.5 / 0.35, 1e-12);
say(`Hall: absolute ratio E4=${hallOf(surveillance).find((h) => h.injector === 'Ekene-4').slope_ratio}, delta-p ratio E4=${e4DeltaP.slope_ratio}`);
if (surveillance.alerts.injectivity_issue.length !== 0) {
  throw new Error('the absolute-pressure Hall run was supposed to raise NO injectivity alert');
}
if (surveillanceDeltaP.alerts.injectivity_issue.length !== 1) {
  throw new Error('the delta-p Hall run was supposed to raise exactly one injectivity alert');
}

const chanOf = (a) => ({
  field: a.chan.field ? { late_slope: a.chan.field.lateSlope, code: a.chan.field.classification.code } : null,
  producers: a.chan.producers.map((p) => ({ producer: p.producer, late_slope: p.lateSlope, code: p.classification.code })),
});
const lagsOf = (a) => a.pattern_lags.map((p) => ({ injector: p.injector, producer: p.producer, lag: p.lag_days, corr: p.corr, overlap: p.overlap }));
say(`Chan: ${JSON.stringify(chanOf(surveillance))}`);
say(`lags (rows are MONTHLY, so lag_days counts months): ${JSON.stringify(lagsOf(surveillance))}`);

// ============================================================================
// Emit fixtures
// ============================================================================

const HEADER_NOTE =
  'GENERATED by tools/ekene-dynamic/generate.mjs — do not hand-edit. ' +
  'Regenerate with: npx tsx tools/ekene-dynamic/generate.mjs. ' +
  'Every value is engine-derived or closed-form at full double precision.';

const files = {
  'field.json': {
    _note: HEADER_NOTE,
    field: 'Ekene',
    description:
      'The geoscience teaching field on production. Static values are the LOCKED NG5/DC9 goldens; the dynamic life (rates, pressures, flood) is this package.',
    static: STATIC_FIELD,
    wells: WELL_TABLE,
    timeline: {
      production_start: PRODUCTION_START,
      flood_start: FLOOD_START,
      history_end: HISTORY_END,
      notes: [
        'Ekene-2 and Ekene-4 found TOP_SAND below the 1560 m OWC (wet) and are converted to water injectors at the flood start.',
        'Primary depletion stays above the 2000 psia bubble point; the flood arrives as pressure approaches it.',
        'The DC22 sealing-fault case (x=1800) is a ReservoirCalc Professional what-if scenario, NOT the base development case.',
      ],
    },
    monthly_volume_convention:
      'A monthly volume is the rate on the first of the month held flat for that calendar month.',
  },
  'rates.json': {
    _note: HEADER_NOTE,
    units: { rate: 'stb/d oil', time: 'days', di: 'per day (nominal)' },
    flood_start: FLOOD_START,
    wells: ratesWells,
  },
  'mbal.json': {
    _note: HEADER_NOTE,
    design: {
      ...MBAL_DESIGN,
      efw_slope_per_psi: efwSlope,
      pressure_inversion:
        'dp = Np / (N*(co + efwSlope) - Np*co); per-row Bo = Boi*(1 + co*dp). Closed form, hand-checkable.',
      stoiip_source: 'NG5 volumetric STOIIP (the reconciliation IS the RC2 capstone story)',
    },
    inputs: mbalInputs,
    expected: {
      estimated_ooip_stb: mbalResult.estimated_ooip_stb,
      r_squared: mbalResult.r_squared,
      regression_slope: mbalResult.regression_slope,
      regression_intercept: mbalResult.regression_intercept,
      n_data_points: mbalResult.n_data_points,
      pressure_at_flood_start_psia: productionData[6].pressure_psia,
      per_timestep: (mbalResult.per_timestep ?? []).map((r) => ({
        timestep_index: r.timestep_index,
        pressure_psia: r.pressure_psia,
        F_rb: r.F_rb,
        Eo_rb_stb: r.Eo_rb_stb,
        Efw_rb: r.Efw_rb,
        Et_rb: r.Et_rb,
      })),
    },
  },
  'scal.json': {
    _note: HEADER_NOTE,
    design: SCAL_DESIGN,
    pore_volume: { pv_m3: STATIC_FIELD.pore_m3, pv_bbl: pvBbl, stb_per_m3: STATIC_FIELD.stb_per_m3 },
    expected: {
      mobility_ratio: M,
      muWeff: displacement.muWeff,
      bl: displacement.bl,
      recovery: displacement.recovery,
      warnings: displacement.warnings,
    },
    capillary: {
      design: {
        ...CAP_DESIGN,
        gammaO_from_api32: gammaO,
        fwl_convention:
          'Sw reaches 1.0 exactly at the mapped 1560 m contact; FWL = contact + entry height. Swirr 0.25 sits below the kr Swc 0.35 on purpose (Pc asymptote vs crest-zone connate).',
      },
      factors: {
        leverett_c: LEVERETT_C,
        psi_per_ft_water: PSI_PER_FT_WATER,
        sigma_cos_reservoir: sigmaCosOf(CAP_DESIGN.reservoir),
        psi_per_j_reservoir: psiPerJ(CAP_DESIGN.reservoir),
        grad_psi_per_ft: gradPsiPerFt,
      },
      lab_pc: labPlugs.map((plug) => ({
        name: plug.name,
        well: plug.well,
        system: plug.system,
        sample: { k_md: plug.k_md, phi: plug.phi, sigma_dyncm: plug.sigma_dyncm, thetaDeg: plug.thetaDeg },
        rows: plug.rows,
      })),
      expected: {
        collapse_max_spread: collapseMaxSpread,
        j_table_ek1p: plugJTables[0],
        fit_single_plug: {
          a: capFitSingle.a,
          b: capFitSingle.b,
          Swirr: capFitSingle.Swirr,
          r2Log: capFitSingle.r2Log,
        },
        average_refit: { a: capAverage.fit.a, b: capAverage.fit.b, r2Log: capAverage.fit.r2Log },
        reservoir_pc: reservoirPc.rows,
        sw_vs_height: capHeight.rows,
        pc_entry_psi: pcEntryPsi,
        h_entry_ft: hEntryFt,
        h_entry_m: hEntryM,
        fwl_m_tvd: fwlM,
        h_crest_ft: hCrestFt,
        sw_at_crest: swAtCrest,
        sw_avg_crest_column_trapz2000: swAvgCrestColumn,
      },
    },
  },
  'waterflood.json': {
    _note: HEADER_NOTE,
    design: {
      vrr_target_profile: '0.85 + 0.04*monthIndex for months 0-5, then 1.05',
      injection_split: FLOOD_DESIGN.injectionSplit,
      fvf_convention:
        'Ledger FVFs frozen at the flood-era average pressure 2100 psia on the fixture PVT line (Bo 1.21584); Bg 0 = liquid voidage only, all gas is solution gas.',
      injectivity_story:
        'whp_psi = 2050 + inj_daily/II with II 0.5 bbl/d/psi; Ekene-4 degrades to 0.35 from 2025-01-01 (Hall-plot slope kink).',
    },
    fvf: FLOOD_DESIGN.fvf,
    ledger_periods: ledgerPeriods,
    surveillance_rows: surveillanceRows,
    flood_design: {
      layers:
        'Five non-communicating layers, permeabilities PLANTED on an exact log-normal (k = k50*exp(-sigma*z) on the engine plotting positions) so dykstraParsonsV recovers V = 0.5 and sigma = ln 2 exactly. k50 = 250 md is the RC3 reservoir permeability. Thicknesses are in DEPTH order and the permeability order is deliberately different.',
      allocation:
        'Operator injector-to-producer factors. Both injector rows sum to less than 1 on purpose; the shortfall is out-of-zone injection, booked by allocateInjection rather than redistributed.',
      patterns:
        'Two flood elements, each drawing injection from BOTH injectors. The field cumulative VRR is near 1 while North is over-injected and South is under-injected: that split is why pattern-level surveillance exists.',
      pressure:
        'Closed-form tank pressure with injection as a negative withdrawal: dp = (Np + (Wp - Wi)*Bw/Boi) / (N*(co + efwSlope) - Np*co). Continues the section-B depletion track with no seam. Surveys are six-monthly and read the end of the PREVIOUS month, and the cadence deliberately straddles the pressure trough.',
      forecast:
        'Five-spot element = half the mapped oil leg. The observed-rate case never breaks through in 30 years; the design case injects at 2000 rb/d with EV from the Dykstra-Parsons first-breakthrough coverage; the fill-up case adds Sgi 0.05.',
      hall:
        'Hall plots are recorded twice: on the measured absolute wellhead pressure (which dilutes the injectivity step badly and raises no alert) and on pressure above the 2050 psia reference (which recovers 1/II exactly).',
      config_case_trap:
        'analyzeWaterflood reads LOWERCASE bo/bw/bg/rs. Handing it the capitalised ledger fvf object silently defaults Bo to 1 and inflates cumulative VRR; the ratio is recorded in expected.surveillance.wrong_case_vrr_ratio.',
    },
    layers: layerColumn,
    layer_design: {
      k50_md: LAYER_DESIGN.k50_md,
      sigma: LAYER_DESIGN.sigma,
      n: LAYER_DESIGN.n,
      net_pay_ft: netPayFt,
      mobility_ratio: M,
      stiles_capacity_ratio: stilesA,
    },
    allocation: ALLOCATION,
    patterns: PATTERNS,
    pattern_element: {
      oil_area_acres: oilAreaAcres,
      elements_per_field: PATTERN_DESIGN.elementsPerField,
      area_acres: elementAreaAcres,
      net_thickness_ft: netThicknessFt,
      phi: STATIC_FIELD.phi,
      Bo: FLOOD_DESIGN.fvf.Bo,
      Bw: FLOOD_DESIGN.fvf.Bw,
      pv_field_units_rb: pvFieldUnits,
      pv_exact_rb: pvExactRb,
      pv_unit_rel_diff: pvUnitRelDiff,
      iw_observed_rb_d: iwObservedRbD,
      iw_design_rb_d: PATTERN_DESIGN.iw_design_rb_d,
      flood_days: floodDays,
    },
    pressure: {
      survey_dates: PRESSURE_DESIGN.survey_dates,
      surveys: pressureSurveys,
      track: pressureTrack,
      pvt_table: pvtTable,
      p_flood_start_psia: pAtFloodStart,
      break_even_vrr: breakEvenVrr,
    },
    ledger_rows: ledgerRows,
    expected: {
      cumulative_vrr: vrrSummary.cumulativeVRR,
      latest_instantaneous_vrr: vrrSummary.latestInstantaneousVRR,
      total_produced_voidage_rb: vrrSummary.totalProducedVoidage,
      total_injected_voidage_rb: vrrSummary.totalInjectedVoidage,
      instantaneous_vrr_by_month: vrrSeries.map((r) => ({ label: r.label, vrr: r.instantaneousVRR })),
      rows_rebuild_periods_max_rel_diff: periodMaxRel,
      allocation: {
        row_sums: allocValidation.rowSums,
        warnings: allocValidation.warnings,
        per_producer: allocated.perProducer,
        unallocated: allocated.unallocated,
        total_injected_bbl: totalWinj,
        allocated_bbl: allocatedSum,
        conservation_residual: conservationResidual,
      },
      patterns: patternResults.map((p) => ({
        name: p.name,
        producers: p.producers,
        cumulative_vrr: p.cumulative_vrr,
        latest_instantaneous_vrr: p.latest_instantaneous_vrr,
        rolling3_last: p.rolling3_last,
        total_produced_voidage_rb: p.total_produced_voidage_rb,
        total_injected_voidage_rb: p.total_injected_voidage_rb,
        fill_up: p.fill_up,
        recommendation: p.recommendation,
      })),
      pressure: {
        trough_label: troughPeriod.label,
        trough_psia: troughPeriod.p_end_psia,
        end_psia: pressureTrack[pressureTrack.length - 1].p_end_psia,
        attached: attached.map((r) => ({ label: r.label, pressure: r.pressure, dpdt: r.dpdt })),
        interpolated_trough_label: attached[attachedTroughIndex].label,
        interpolated_trough_psia: attached[attachedTroughIndex].pressure,
        trough_missed_by_psi: troughMissedBy,
        fvf_track_bo: fvfTrack.map((f) => f.Bo),
        fvf_interpolation_max_rel_diff: fvfMaxRel,
        cumulative_vrr_tracked_bo: trackedCumVrr,
        cumulative_vrr_frozen_bo: frozenCumVrr,
        tracked_vs_frozen_pct: (trackedCumVrr / frozenCumVrr - 1) * 100,
      },
      layered_sweep: {
        V: sweep.V.V,
        sigma: sweep.V.sigma,
        k50: sweep.V.k50,
        n: sweep.V.n,
        dykstra_parsons: sweep.dykstraParsons.map((s) => ({
          layerIndex: s.layerIndex,
          k_md: s.kBroken,
          coverage: s.coverage,
          WOR: Number.isFinite(s.WOR) ? s.WOR : 'Infinity',
        })),
        stiles: sweep.stiles.map((s) => ({
          layerIndex: s.layerIndex,
          k_md: s.kBroken,
          coverage: s.coverage,
          water_cut: s.waterCut,
        })),
        ev_first_breakthrough: EV_FIRST_BT,
      },
      pattern_forecast: forecasts,
      channeling: {
        producer: 'Ekene-6',
        breakthrough_date: e6BtDate,
        breakthrough_days: e6BtDays,
        allocated_injection_bbl: e6AllocatedBbl,
        EAbt: e6EAbt,
        QiBt: displacement.bl.QiBt,
        implied_swept_pv_rb: impliedSweptPvRb,
        implied_swept_fraction_of_element: impliedSweptFraction,
      },
      surveillance: {
        kpis: surveillance.kpis,
        cumulative_vrr_rows_as_days: surveillance.kpis.vrr_avg,
        wrong_case_vrr_avg: surveillanceWrongCase.kpis.vrr_avg,
        wrong_case_vrr_ratio: wrongCaseRatio,
        hall_absolute_pressure: hallOf(surveillance),
        hall_above_reference: hallDeltaP,
        injectivity_alerts_absolute: surveillance.alerts.injectivity_issue,
        injectivity_alerts_above_reference: surveillanceDeltaP.alerts.injectivity_issue,
        chan: chanOf(surveillance),
        pattern_lags: lagsOf(surveillance),
        field_recommendation: surveillance.recommendations,
      },
    },
  },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, obj] of Object.entries(files)) {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  say(`wrote ${path.relative(path.join(__dirname, '..', '..'), p)}`);
}

say('=== generation complete, all assertions passed ===');
