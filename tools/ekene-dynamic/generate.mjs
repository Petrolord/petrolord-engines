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
import { computeVRRSeries, summarizeVRR } from '../../engines/waterflood/vrr.js';

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
    expected: {
      cumulative_vrr: vrrSummary.cumulativeVRR,
      latest_instantaneous_vrr: vrrSummary.latestInstantaneousVRR,
      total_produced_voidage_rb: vrrSummary.totalProducedVoidage,
      total_injected_voidage_rb: vrrSummary.totalInjectedVoidage,
      instantaneous_vrr_by_month: vrrSeries.map((r) => ({ label: r.label, vrr: r.instantaneousVRR })),
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
