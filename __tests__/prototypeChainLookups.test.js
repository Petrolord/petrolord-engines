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
import { metricTitle } from '../engines/economics/fiscalConventions';
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
    expect(() => metricTitle(k)).toThrow(/Unknown fiscal metric/);
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
  const points = [{ date: '2026-01-01', oil_bopd: 100, days_on: 30 }];
  const oil = rateSeriesForFit(points, 'oil');
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
  each((k) => {
    expect(() => runHistoryMatch({}, { fit_parameters: [k] }))
      .toThrow(/Unknown history-match parameter|history-match/i);
  });
});
