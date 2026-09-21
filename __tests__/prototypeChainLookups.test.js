/**
 * Prototype-chain preset lookups: the repo-wide gate.
 *
 * A preset or table lookup written as `TABLE[key]` walks the JavaScript
 * prototype chain. `'constructor'`, `'toString'`, `'valueOf'`,
 * `'hasOwnProperty'` and `'__proto__'` are therefore "found" in EVERY object
 * literal, return a truthy function or object, and walk straight through a
 * `if (!row) return refuse(...)` guard. Because every comparison against the
 * resulting NaN is false, execution then falls through to the SAFE side of
 * every threshold. A typo in a preset name is enough to trigger it.
 *
 * The six instances inside `engines/hse/qra.js` were found and closed with
 * the H5 engine (`tools/validation/hse/FINDINGS-qra.md` section 9). This file
 * gates every OTHER site the repo-wide sweep found: each one is called here
 * with all five magic keys and must refuse, throw, or return the same empty /
 * default answer any other unknown key gets. None may return a function, an
 * object off Object.prototype, or a NaN-bearing "answer".
 *
 * Revert any one own-property guard and the matching case below goes red.
 *
 * The second half of the file covers the second sweep: sites found by a
 * static scan for object-literal tables read with a caller key, and by a
 * differential fuzz (each inherited name against a same-length unknown name)
 * over every exported function. It also covers running totals keyed by a
 * caller's name, where '__proto__' used to vanish from the total or write
 * onto Object.prototype.
 */

import { resolveNoiseCriterion, hearingProtectorEstimate } from '../engines/hse/exposure';
import { briggsRuralSigmas, poolBurningRate } from '../engines/hse/consequence';
import { nextAuditStatuses, nextProgrammeStatuses } from '../engines/assurance/auditManagement';
import { nextAuditStatuses as isoNextAuditStatuses } from '../engines/assurance/isoCompliance';
import { nextLessonStatuses } from '../engines/assurance/lessonsLearned';
import { nextStages as mocNextStages } from '../engines/assurance/managementOfChange';
import { nextPlanStatuses } from '../engines/assurance/qualityAssurance';
import { nextStatuses, canTransition as prCanTransition, nextStages as prNextStages } from '../engines/assurance/peerReview';
import { periodStart, rollForward } from '../engines/assurance/complianceStatus';
import { canTransition as topsCanTransition } from '../engines/wellsite/tops';
import { getCompactionParams, LithologyCompaction } from '../engines/basin/CompactionModelLibrary';
import { getThermalProps, ThermalProperties } from '../engines/basin/ThermalPropertiesLibrary';
import { getKerogenParams, KerogenKinetics } from '../engines/basin/KerogenLibrary';
import { benchmarkSuggestion } from '../engines/drilling/data/costBenchmarks';
import { computeErrorModel } from '../engines/drilling/errorModel';
import { populateZoneProperty } from '../engines/earthmodeling/properties';
import { metricLabel } from '../engines/economics/fiscalConventions';
import { aggregateReserves } from '../engines/economics/fdp/subsurfaceCalculations';
import { gasOutletPressure } from '../engines/facilities/lineHydraulics';
import { straightRunDiameters } from '../engines/facilities/metering';
import { jhaveriYoungrenShift } from '../engines/fluid/characterization';
import { swCurve } from '../engines/petrophysics/sw';
import { vshFromGr } from '../engines/petrophysics/vsh';
import { criticalVelocity } from '../engines/production/gasWellLoading';
import { rateSeriesForFit, FIT_STREAMS } from '../engines/production/surveillance';
import { gcLithVs } from '../engines/rockphysics/vsEstimate';
import { mixMinerals } from '../engines/rockphysics/minerals';
import { makeTraceCompute } from '../engines/seismolord/attributes';
import { makeNeighborhoodCompute } from '../engines/seismolord/discontinuity';
import { optionsFor, resolveTerm } from '../engines/wellsite/descriptionVocabulary';
import { showAbbrev } from '../engines/wellsite/shows';
import { emitWELSPECS } from '../engines/sim/emitSchedule';
import { runHistoryMatch } from '../engines/mbal/mbalEngine';
import { DAKE_CT_RESERVOIR, DAKE_CT_PERFORMANCE } from '../test-data/mbal/dake-9-2.ts';

import fs from 'fs';
import path from 'path';
import { mixtureFromKeys } from '../engines/fluid/pr78';
import { getBip } from '../engines/fluid/components';
import { yieldCeiling } from '../engines/downstream/flareToValue';
import { materialBalance } from '../engines/downstream/streamModel';
import { karakasTariq } from '../engines/drilling/perforation';
import { tubeCount } from '../engines/facilities/heatTransfer';
import { corrosionRate } from '../engines/facilities/corrosion';
import { parameterPercentileLabel } from '../lib/conventions/percentile';
import { unitLabel } from '../engines/welltest/units';
import { summarise as docSummarise } from '../engines/assurance/documentControl';
import { summarise as lessonSummarise } from '../engines/assurance/lessonsLearned';
import { ncrAgeing } from '../engines/assurance/qualityAssurance';
import { latestScenarioByWell } from '../engines/dca/groupRollup';
import { calculateCostByPhase } from '../engines/economics/fdp/costCalculations';
import { aggregateRisksByType } from '../engines/economics/fdp/hseCalculations';
import { calculateRiskExposure, aggregateRisksBySource } from '../engines/economics/fdp/riskCalculations';
import { aggregateWellsByType } from '../engines/economics/fdp/wellCalculations';
import { buildNetwork, solveLinearNetwork, linearBranch, diagnose } from '../engines/production/networkSolve';
import { allocateInjection } from '../engines/waterflood/vrrLedger';
import { timeByType } from '../engines/wellsite/events';
import { term, PETROLORD_PROFILE } from '../engines/wellsite/abbreviations';
import { parseLas } from '../engines/welldata/lasParse';
import { alignSeriesByAge } from '../engines/basin/results';
import { parseSurfaceFile } from '../lib/gridding/surfaceImport';
import { combine } from '../lib/gridding/gridmath';
import { computeWell } from '../engines/petrophysics/pipeline';

/** The five keys every object literal inherits. */
export const MAGIC_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

const each = (fn) => MAGIC_KEYS.forEach((k) => fn(k));

/** A refusal object from the HSE engines. */
const isRefusal = (r, field) => {
  expect(typeof r).toBe('object');
  expect(r).not.toBeNull();
  expect(typeof r.error).toBe('string');
  if (field) expect(r.field).toBe(field);
};

/** Nothing anywhere may hand back a prototype member or a NaN answer. */
const noPrototypeLeak = (v) => {
  expect(typeof v).not.toBe('function');
  const seen = JSON.stringify(v, (kk, vv) => (typeof vv === 'function' ? '@@FUNCTION' : (typeof vv === 'number' && Number.isNaN(vv) ? '@@NAN' : vv)));
  if (seen !== undefined) {
    expect(seen).not.toContain('@@FUNCTION');
    expect(seen).not.toContain('@@NAN');
  }
};

// ---------------------------------------------------------------- HSE H2
// Vendored into the live petrolord-hse Occupational Hygiene module.

test('hse/exposure resolveNoiseCriterion refuses the inherited keys', () => {
  each((k) => {
    const r = resolveNoiseCriterion(k);
    isRefusal(r, 'criterion');
    expect(r.error).toContain(k);
    noPrototypeLeak(r);
  });
  // A legitimate preset is untouched.
  expect(resolveNoiseCriterion('OSHA_PEL').criterionLevelDbA).toBe(90);
});

test('hse/exposure hearingProtectorEstimate refuses an inherited method name', () => {
  each((k) => {
    const r = hearingProtectorEstimate({
      exposureDb: 95, weighting: 'A', nrrDb: 25, method: k, protectorType: 'earmuff',
    });
    isRefusal(r, 'method');
    noPrototypeLeak(r);
  });
});

test('hse/exposure hearingProtectorEstimate refuses an inherited protectorType', () => {
  each((k) => {
    const r = hearingProtectorEstimate({
      exposureDb: 95, weighting: 'A', nrrDb: 25, method: 'NIOSH_TYPE', protectorType: k,
    });
    isRefusal(r, 'protectorType');
    noPrototypeLeak(r);
  });
  // The legitimate derating is untouched: 0.75 * 25 - 7 = 11.75 dB.
  const good = hearingProtectorEstimate({
    exposureDb: 95, weighting: 'A', nrrDb: 25, method: 'NIOSH_TYPE', protectorType: 'earmuff',
  });
  expect(good.attenuationDb).toBeCloseTo(11.75, 10);
});

// ---------------------------------------------------------------- HSE H4

test('hse/consequence briggsRuralSigmas refuses the inherited keys', () => {
  each((k) => {
    const r = briggsRuralSigmas({ stabilityClass: k, downwindDistanceM: 500 });
    isRefusal(r, 'stabilityClass');
    noPrototypeLeak(r);
  });
});

test('hse/consequence poolBurningRate names the FUEL field, not a downstream one', () => {
  each((k) => {
    const r = poolBurningRate({ method: 'babrauskas', fuel: k, poolDiameterM: 10 });
    isRefusal(r, 'fuel');
    noPrototypeLeak(r);
  });
});

// ---------------------------------------------- assurance state machines
// `TRANSITIONS[status] || []` returned a FUNCTION, so the caller's
// `.includes(to)` threw or silently misjudged the transition.

test('every assurance state machine returns an empty list for an inherited status', () => {
  const machines = [
    ['auditManagement.nextAuditStatuses', nextAuditStatuses],
    ['auditManagement.nextProgrammeStatuses', nextProgrammeStatuses],
    ['isoCompliance.nextAuditStatuses', isoNextAuditStatuses],
    ['lessonsLearned.nextLessonStatuses', nextLessonStatuses],
    ['managementOfChange.nextStages', mocNextStages],
    ['qualityAssurance.nextPlanStatuses', nextPlanStatuses],
    ['peerReview.nextStatuses', nextStatuses],
    ['peerReview.nextStages', prNextStages],
  ];
  for (const [name, fn] of machines) {
    each((k) => {
      const out = fn(k);
      expect(Array.isArray(out)).toBe(true);
      expect(out).toEqual([]);
      expect(name).toBe(name);
    });
  }
});

test('peerReview.canTransition and wellsite/tops.canTransition refuse instead of throwing', () => {
  each((k) => {
    expect(prCanTransition(k, 'resolved')).toBe(false);
    const t = topsCanTransition(k, 'confirmed');
    expect(t.ok).toBe(false);
  });
});

test('assurance/complianceStatus gives no period for an inherited frequency', () => {
  each((k) => {
    expect(periodStart('2026-06-15', k)).toBeNull();
    expect(rollForward('2026-06-15', k)).toBeNull();
  });
  // A real frequency still rolls.
  expect(rollForward('2026-06-15', 'Quarterly')).not.toBeNull();
});

// ------------------------------------------------------------------ basin

test('basin libraries fall back to their default, never to a prototype member', () => {
  each((k) => {
    expect(getCompactionParams(k)).toBe(LithologyCompaction.default);
    expect(getThermalProps(k)).toBe(ThermalProperties.default);
    expect(getKerogenParams(k)).toBe(KerogenKinetics.default);
  });
  expect(getCompactionParams('sandstone')).toBe(LithologyCompaction.sandstone);
});

// --------------------------------------------------------------- drilling

test('drilling/costBenchmarks gives no suggestion instead of NaN day rates', () => {
  each((k) => {
    expect(benchmarkSuggestion({ region: k, wellType: 'Exploration', mdM: 3000 })).toBeNull();
    expect(benchmarkSuggestion({ region: 'Brazil', wellType: k, mdM: 3000 })).toBeNull();
  });
  expect(benchmarkSuggestion({ region: 'Brazil', wellType: 'Exploration', mdM: 3000 })).not.toBeNull();
});

test('drilling/errorModel refuses an inherited model name', () => {
  each((k) => {
    expect(() => computeErrorModel([], { bTotalNT: 50000, dipDeg: 60 }, { model: k }))
      .toThrow(/Unknown error model/);
  });
});

// ----------------------------------------------------------- earthmodeling

test('earthmodeling/properties refuses an inherited population method', () => {
  const spec = { nx: 2, ny: 2, x0: 0, y0: 0, dx: 1, dy: 1 };
  each((k) => {
    expect(() => populateZoneProperty(spec, null, { 0: [] }, [], k))
      .toThrow(/Unknown population method/);
  });
});

// -------------------------------------------------------------- economics

test('economics/fiscalConventions refuses an inherited metric key', () => {
  each((k) => {
    expect(() => metricLabel(k)).toThrow(/Unknown fiscal metric/);
  });
});

test('economics/fdp aggregateReserves refuses an inherited fluid', () => {
  each((k) => {
    expect(() => aggregateReserves([{ name: 'R', fluid: k, p90: 1, p50: 2, p10: 3 }]))
      .toThrow(/fluid type is missing or unknown/);
  });
});

// ------------------------------------------------------------- facilities

test('facilities/lineHydraulics refuses an inherited gas flow equation', () => {
  each((k) => {
    const r = gasOutletPressure({
      equation: k, qScfd: 1e6, p1Psia: 800, dIn: 6, lengthMi: 10, gasSg: 0.65, tempR: 530, z: 0.9,
    });
    expect(String(r.error)).toContain('unknown gas flow equation');
  });
});

test('facilities/metering gives no straight-run table for an inherited fitting', () => {
  each((k) => {
    const r = straightRunDiameters({ beta: 0.5, upstreamFitting: k });
    expect(r.withheld).toBeUndefined();
    expect(String(r.error)).toContain('no straight-run table');
    noPrototypeLeak(r);
  });
});

// ------------------------------------------------------------------ fluid

test('fluid/characterization refuses an inherited Jhaveri-Youngren family', () => {
  each((k) => {
    expect(() => jhaveriYoungrenShift(100, k)).toThrow(/Unknown Jhaveri-Youngren family/);
  });
});

// ----------------------------------------------------------- petrophysics
// swCurve fell through to Indonesia and returned a plausible saturation.

test('petrophysics/sw refuses an inherited Sw method instead of silently running Indonesia', () => {
  const curves = { rt: new Float64Array([10]), phi: new Float64Array([0.2]), vsh: new Float64Array([0.1]) };
  each((k) => {
    expect(() => swCurve(curves, { method: k, rw: 0.05, rsh: 2 })).toThrow(/Unknown Sw method/);
  });
  expect(swCurve(curves, { method: 'archie', rw: 0.05, rsh: 2 })[0]).toBeGreaterThan(0);
});

test('petrophysics/vsh refuses an inherited Vsh method', () => {
  each((k) => {
    expect(() => vshFromGr(new Float64Array([60]), { grClean: 20, grClay: 120, method: k }))
      .toThrow(/Unknown Vsh method/);
  });
  expect(vshFromGr(new Float64Array([60]), { grClean: 20, grClay: 120, method: 'linear' })[0]).toBeCloseTo(0.4, 10);
});

// ------------------------------------------------------------- production

test('production/gasWellLoading refuses an inherited correlation instead of returning ok with a NaN velocity', () => {
  each((k) => {
    const r = criticalVelocity({
      correlation: k, sigmaDyneCm: 60, rhoLiquidLbFt3: 62.4, pPsia: 1000, tempR: 600, z: 0.9, gasSg: 0.65,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('unknownCorrelation');
    noPrototypeLeak(r);
  });
});

test('production/surveillance falls back to the oil stream, not to a prototype member', () => {
  const points = [{ date: '2026-01-01', oilPd: 100, oil: 90 }, { date: '2026-02-01', oilPd: 95, oil: 85 }];
  const oil = rateSeriesForFit(points, 'oil');
  expect(oil).toHaveLength(2);
  each((k) => {
    expect(rateSeriesForFit(points, k)).toEqual(oil);
  });
  expect(Object.prototype.hasOwnProperty.call(FIT_STREAMS, 'oil')).toBe(true);
});

// ------------------------------------------------------------ rockphysics

test('rockphysics refuses inherited lithology and mineral names', () => {
  each((k) => {
    expect(() => gcLithVs(4000, k)).toThrow(/Unknown Greenberg-Castagna lithology/);
    expect(() => mixMinerals([{ name: k, frac: 1 }])).toThrow(/Unknown mineral/);
  });
});

// ------------------------------------------------------------- seismolord

test('seismolord refuses inherited attribute names', () => {
  each((k) => {
    expect(() => makeTraceCompute(k, {}, { dtUs: 2000 })).toThrow(/Unknown attribute/);
    expect(() => makeNeighborhoodCompute(k, {}, { dtUs: 2000 })).toThrow(/Unknown discontinuity attribute/);
  });
});

// ---------------------------------------------------------------- wellsite

test('wellsite vocabularies return nothing for an inherited table name instead of throwing', () => {
  each((k) => {
    expect(optionsFor(k)).toEqual([]);
    expect(resolveTerm(k, 'sst')).toBeNull();
    expect(() => showAbbrev({ [k]: 'x' })).not.toThrow();
  });
  expect(optionsFor('lithology').length).toBeGreaterThan(0);
});

// --------------------------------------------------------------------- sim
// `'${PHASE_OF[w.type]}'` wrote `function Object() { [native code] }` into a
// SCHEDULE deck.

test('sim/emitSchedule refuses an inherited well type', () => {
  each((k) => {
    expect(() => emitWELSPECS([{ name: 'W1', type: k, i: 1, j: 1, k1: 1, k2: 1, refDepth: 1000 }]))
      .toThrow(/unknown well type/);
  });
});

// -------------------------------------------------------------------- mbal

test('mbal history match refuses an inherited fit parameter name', () => {
  const inputs = {
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
    aquifer_model: 'none',
    pvt_source: 'lab_table',
    excluded_timesteps: [],
    production_data: DAKE_CT_PERFORMANCE.map((row, idx) => ({
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
    })),
  };
  each((k) => {
    expect(() => runHistoryMatch(inputs, { fit_parameters: [k] }))
      .toThrow(`Unknown history-match parameter "${k}".`);
  });
});

// ===================================================================
// Second sweep: sites found beyond the first 36 files, by a static scan
// for object-literal tables read with a caller key and by a differential
// fuzz (each inherited name against a same-length unknown name).
// ===================================================================

/** A plain object carrying `key` as an OWN property, '__proto__' included. */
const ownObj = (key, value) => JSON.parse(`{${JSON.stringify(key)}: ${JSON.stringify(value)}}`);

test('fluid/pr78 refuses an inherited component key instead of building a NaN mixture', () => {
  each((k) => {
    expect(() => mixtureFromKeys(['C1', k])).toThrow(`Unknown EOS component: ${k}`);
  });
  // extra and extraBip are caller maps: only their own keys count.
  const mix = mixtureFromKeys(['C1', 'C7+'], { 'C7+': { mw: 100, tcR: 1000, pcPsia: 400, omega: 0.3 } }, {});
  expect(mix.bip[0][1]).toBe(0);
});

test('fluid/components getBip never reads a function as a kij', () => {
  each((k) => {
    expect(getBip(k, 'C1')).toBe(0);
    expect(getBip('toString', k === 'toString' ? 'constructor' : k)).toBe(0);
  });
  expect(getBip('CO2', 'C1')).toBe(0.105);
});

test('downstream/flareToValue yield ceiling treats an inherited unit as an unknown unit, never NaN', () => {
  const gas = { kgPerMscf: 20, c3PlusKgPerMscf: 5 };
  const unknown = yieldCeiling({ yieldBasis: { unit: 'bbl', ceiling: 'gas mass' }, gas });
  each((k) => {
    const c = yieldCeiling({ yieldBasis: { unit: k, ceiling: 'gas mass' }, gas });
    expect(c).toBe(unknown);
    expect(Number.isNaN(c)).toBe(false);
  });
  expect(yieldCeiling({ yieldBasis: { unit: 't', ceiling: 'gas mass' }, gas })).toBeCloseTo(0.02, 12);
});

test('downstream/streamModel keeps a material named after an inherited member, and never touches Object.prototype', () => {
  each((k) => {
    const rows = materialBalance({
      events: [
        { ledger: 'actual', materialId: k, type: 'receipt', quantity: 100 },
        { ledger: 'actual', materialId: 'crude', type: 'receipt', quantity: 50 },
      ],
      openingByMaterial: {},
      closingByMaterial: {},
    });
    const row = rows.find((r) => r.materialId === k);
    expect(row).toBeDefined();
    expect(row.in).toBe(100);
    expect(row.opening).toBe(0);
    expect(row.closing).toBe(100);
    expect(row.reportedClosing).toBeNull();
    expect(rows).toHaveLength(2);
  });
  expect({}.in).toBeUndefined();
  expect({}.out).toBeUndefined();
});

test('drilling/perforation refuses an inherited phasing', () => {
  each((k) => {
    expect(() => karakasTariq({ lpM: 0.3, rpM: 0.005, spfPerM: 13, phasingDeg: k, rwM: 0.1 }))
      .toThrow(/is not in the SPE 18247 tables/);
  });
  // A numeric phasing still resolves (the table's keys are numbers).
  expect(() => karakasTariq({ lpM: 0.3, rpM: 0.005, spfPerM: 13, phasingDeg: 90, rwM: 0.1 })).not.toThrow();
});

test('drilling/errorModel refuses an inherited weighting function in a custom model', () => {
  const G = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', 'iscwsa_mwd_rev4_well1.json'), 'utf8'));
  const stations = G.survey.md.map((md, i) => ({ md, inc: G.survey.inc[i], azi: G.survey.azi[i] }));
  each((k) => {
    const model = { name: 'custom', codes: { X: { fn: k, magnitude: 1, prop: 'systematic' } } };
    expect(() => computeErrorModel(stations, G.header, { model }))
      .toThrow(`unknown weighting function "${k}"`);
  });
});

test('facilities/heatTransfer refuses an inherited bundle layout instead of a NaN tube count', () => {
  each((k) => {
    const r = tubeCount({ areaFt2: 1000, doIn: 0.75, tubeLengthFt: 16, layoutDeg: k });
    expect(String(r.error)).toContain('bundle constants for 30, 45 and 90 degree layouts only');
    noPrototypeLeak(r);
  });
  expect(tubeCount({ areaFt2: 1000, doIn: 0.75, tubeLengthFt: 16, layoutDeg: 30 }).error).toBeUndefined();
});

test('facilities/corrosion refuses an inherited wetting regime', () => {
  each((k) => {
    const r = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.02, velocityMS: 2, diameterM: 0.2, ph: 5, flowRegime: k,
    });
    expect(String(r.error)).toContain('the wetting regime must be one of');
    noPrototypeLeak(r);
  });
});

test('lib/conventions/percentile refuses an inherited percentile key', () => {
  each((k) => {
    expect(() => parameterPercentileLabel('Sw', k)).toThrow(/unknown percentile/);
  });
  expect(parameterPercentileLabel('Sw', 'q90')).toBe('90th percentile of Sw');
});

test('welltest/units falls back to dimensionless for an inherited kind', () => {
  each((k) => {
    expect(unitLabel(k, 'oilfield')).toBe(unitLabel('zzNoSuchKind', 'oilfield'));
  });
});

test('assurance dashboards count no inherited status or severity', () => {
  each((k) => {
    const d = docSummarise([{ status: k }]);
    expect(Object.prototype.hasOwnProperty.call(d.byStatus, k)).toBe(false);
    const l = lessonSummarise([{ status: k }]);
    expect(Object.prototype.hasOwnProperty.call(l.byStatus, k)).toBe(false);
    const rows = ncrAgeing([{ status: 'Open', severity: k, raised_date: '2026-01-01' }], new Date('2026-06-01'));
    rows.forEach((r) => expect(Object.prototype.hasOwnProperty.call(r, k)).toBe(false));
  });
});

// ------------------------------------------- accumulators keyed by names
// A name of '__proto__' used to vanish from the total (the write replaced the
// prototype); 'constructor' and friends turned a count into a string.

test('dca/groupRollup keeps a well whose id is an inherited name', () => {
  each((k) => {
    const out = latestScenarioByWell([{ stream: 'oil', wellId: k, createdAt: '2026-01-01', eur: 5 }], 'oil');
    expect(Object.keys(out)).toEqual([k]);
    expect(Object.getOwnPropertyDescriptor(out, k).value.eur).toBe(5);
  });
});

test('economics/fdp aggregations total inherited names as their own keys', () => {
  each((k) => {
    const byPhase = calculateCostByPhase([{ phase: k, amount: 5 }, { phase: k, amount: 2 }]);
    expect(Object.getOwnPropertyDescriptor(byPhase, k).value).toBe(7);
    const byType = aggregateRisksByType([{ type: k }, { type: k }]);
    expect(Object.getOwnPropertyDescriptor(byType, k).value).toBe(2);
    const bySource = aggregateRisksBySource([{ source: k }]);
    expect(Object.getOwnPropertyDescriptor(bySource, k).value).toBe(1);
    const wells = aggregateWellsByType([{ type: k }, { type: 'Producer' }]);
    expect(Object.getOwnPropertyDescriptor(wells, k).value).toBe(1);
    expect(calculateRiskExposure([{ probability: k, costImpact: 100 }])).toBe(0);
  });
  expect(calculateRiskExposure([{ probability: 3, costImpact: 100 }])).toBeCloseTo(40, 12);
});

test('production/networkSolve solves and diagnoses a node named after an inherited member', () => {
  each((k) => {
    const net = buildNetwork({
      nodes: [{ id: k, kind: 'well', qmax: 1000, prPsia: 3000 }, { id: 'S', kind: 'sink', pressurePsia: 100 }],
      branches: [{ id: 'b1', from: k, to: 'S' }],
    });
    expect(net.ok).toBe(true);
    const sol = solveLinearNetwork({
      network: net, conductance: () => 1, wellSlope: (n) => ({ qmax: n.qmax, prPsia: n.prPsia }),
    });
    expect(sol.ok).toBe(true);
    const p = Object.getOwnPropertyDescriptor(sol.pressures, k).value;
    expect(Number.isFinite(p)).toBe(true);
    const d = diagnose({ network: net, pressures: sol.pressures, flows: { b1: 10 } });
    expect(Number.isFinite(d.rows[0].dpPsi)).toBe(true);
  });
  expect(linearBranch(2)({}, 10, 4)).toBe(12);
});

test('waterflood/vrrLedger conserves injection to a producer named after an inherited member', () => {
  each((k) => {
    const allocation = { INJ1: ownObj(k, 1) };
    const r = allocateInjection([{ well: 'INJ1', winj_stb: 1000, ginj_mscf: 0 }], allocation);
    expect(Object.getOwnPropertyDescriptor(r.perProducer, k).value.winj_stb).toBeCloseTo(1000, 9);
    expect(r.unallocated.winj_stb).toBeCloseTo(0, 9);
  });
  expect({}.winj_stb).toBeUndefined();
});

test('wellsite/events totals time for an inherited event type', () => {
  each((k) => {
    const out = timeByType([{ type: k, startUtcMs: 0, endUtcMs: 60000, duration: true }], { startUtc: 0, endUtc: 120000 });
    expect(Object.getOwnPropertyDescriptor(out, k).value).toBe(1);
  });
});

test('wellsite/abbreviations never labels a term with an inherited member', () => {
  each((k) => {
    const t = term(PETROLORD_PROFILE, 'lithology', k);
    expect(typeof t.label).toBe('string');
  });
});

test('welldata/lasParse reads a LAS 3.0 block named after an inherited member instead of crashing', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'wells', 'las', 'las3_intervals_30.las'), 'utf8');
  each((k) => {
    const renamed = text.replace(/~Core_/g, `~${k}_`).replace(/\| Core_/g, `| ${k}_`);
    const las = parseLas(renamed);
    const block = Object.getOwnPropertyDescriptor(las.blocks, k).value;
    expect(block.name).toBe(k);
    expect(block.rows.length).toBeGreaterThan(0);
  });
});

test('basin/results keeps a layer named __proto__ in the plotted series', () => {
  each((k) => {
    const pts = alignSeriesByAge([0], [[{ age: 0, value: 3 }]], [{ name: k }]);
    expect(Object.getOwnPropertyDescriptor(pts[0], k).value).toBe(3);
  });
});

test('surface import and grid maths refuse an inherited format or operation', () => {
  each((k) => {
    expect(() => parseSurfaceFile('1 2 3', k)).toThrow(`Unknown surface format: ${k}`);
    expect(() => combine(new Float32Array([1]), new Float32Array([2]), k)).toThrow(`Unknown surface op "${k}".`);
  });
});

test('petrophysics pipeline reports an inherited phiSource as missing instead of storing a function as PHIT', () => {
  const curves = { DEPT: new Float64Array([1000, 1001]), RHOB: new Float64Array([2.3, 2.4]) };
  each((k) => {
    const r = computeWell(curves, { phiSource: k });
    expect(r.outputs.PHIT).toBeUndefined();
    expect(r.missing).toContain(`${k} porosity inputs`);
  });
  expect(computeWell(curves, { phiSource: 'density' }).outputs.PHIT).toBeDefined();
});
