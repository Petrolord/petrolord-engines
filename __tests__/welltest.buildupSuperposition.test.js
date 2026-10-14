// Buildup after a rate history (Well Test video round, 2026-10-14): the
// superposition time, the equivalent time, the exact model response, the
// straight line on superposition time and the fault distance from two
// semilog lines. Every check calls the engine; truths are the generating
// parameters of an engine-independent route where one exists (the image-well
// identity for the fault constant, the one-rate Horner/Agarwal limits).
import {
  hornerTime, agarwalEquivalentTime, rateStepsFromHistory, equivalentProducingTime,
  buildupSuperpositionTerms, buildupSuperpositionTime, superpositionEquivalentTime, shutInTimeAtSuperpositionTime,
} from '../engines/welltest/superposition.js';
import { getModel, evaluateBuildup, evaluateBuildupFromHistory, evaluateRateHistory, evaluateDrawdown, OILFIELD } from '../engines/welltest/models/modelCatalog.js';
import {
  hornerAnalysis, superpositionBuildupAnalysis, mdhBuildupAnalysis, faultDistanceFromIntersection, FAULT_INTERSECTION_CONSTANT, twoLineFaultAnalysis,
} from '../engines/welltest/analysis.js';
import { bourdetDerivative } from '../engines/welltest/derivative.js';
import { autoFitModel } from '../engines/welltest/autoFit.js';

const RES = { phi: 0.2, mu: 1.8, ct: 1.27e-5, rw: 0.51, h: 21, B: 1.21, q: 140, pi: 2120 };
const TRUTH = { k: 225, skin: 3.2, C: 0.0004 };
const homog = getModel('homogeneous');
const logspace = (a, b, n) => Array.from({ length: n }, (_, i) => 10 ** (a + ((b - a) * i) / (n - 1)));

// a clean-up test: three rates, an hour's shut-in between the first two, then the buildup
const HISTORY = rateStepsFromHistory([
  { t: 0, q: 60 }, { t: 6, q: 0 }, { t: 7, q: 100 }, { t: 15, q: 140 }, { t: 27, q: 0 },
]);
const TS = 27;

describe('superposition time and equivalent time', () => {
  test('one rate from t = 0 is Horner and Agarwal exactly', () => {
    const steps = [{ start: 0, q: 300 }];
    for (const dt of [0.01, 0.5, 3, 48, 500]) {
      expect(buildupSuperpositionTime(steps, 36, dt)).toBeCloseTo(Math.log10(hornerTime(36, dt)), 12);
      expect(superpositionEquivalentTime(steps, 36, dt) / agarwalEquivalentTime(36, dt)).toBeCloseTo(1, 12);
    }
  });

  test('weights sum to one and the last flowing rate is q_n', () => {
    const sup = buildupSuperpositionTerms(HISTORY, TS);
    expect(sup.ok).toBe(true);
    expect(sup.qn).toBe(140);
    expect(sup.terms.reduce((a, t) => a + t.w, 0)).toBeCloseTo(1, 12);
    expect(buildupSuperpositionTerms([{ start: 0, q: 100 }, { start: 5, q: 0 }], 10).ok).toBe(false);
  });

  test('dt is recovered from X', () => {
    for (const dt of [0.003, 0.2, 7, 90]) {
      const x = buildupSuperpositionTime(HISTORY, TS, dt);
      expect(shutInTimeAtSuperpositionTime(HISTORY, TS, x) / dt).toBeCloseTo(1, 9);
    }
  });
});

describe('model response through a rate history', () => {
  test('one rate step reproduces evaluateBuildup', () => {
    const dts = logspace(-2, 2, 15);
    const a = evaluateBuildup({ model: homog, params: TRUTH, reservoir: RES, tp: 36, dts });
    const b = evaluateBuildupFromHistory({ model: homog, params: TRUTH, reservoir: RES, steps: [{ start: 0, q: RES.q }], shutInTime: 36, dts });
    expect(b.pwfAtShutIn).toBeCloseTo(a.pwfAtShutIn, 6);
    a.forEach((p, i) => expect(b[i].pws).toBeCloseTo(p.pws, 6));
  });

  test('a constant history is the constant-rate drawdown', () => {
    const times = [0.1, 1, 10];
    const a = evaluateDrawdown({ model: homog, params: TRUTH, reservoir: RES, times });
    const b = evaluateRateHistory({ model: homog, params: TRUTH, reservoir: RES, steps: [{ start: 0, q: RES.q }], times });
    a.forEach((p, i) => expect(b[i].pw).toBeCloseTo(p.pw, 8));
  });
});

describe('buildup straight line on superposition time', () => {
  const dts = logspace(-2, Math.log10(72), 60);
  const bu = evaluateBuildupFromHistory({ model: homog, params: TRUTH, reservoir: RES, steps: HISTORY, shutInTime: TS, dts });
  const radial = bu.filter((p) => p.dt >= 5).map((p) => ({ dt: p.dt, pws: p.pws }));

  test('recovers k, skin and p* = pi after a clean-up', () => {
    const r = superpositionBuildupAnalysis({ points: radial, steps: HISTORY, shutInTime: TS, pwfShutIn: bu.pwfAtShutIn, ...RES });
    expect(r.qn).toBe(140);
    expect(Math.abs(r.k / TRUTH.k - 1)).toBeLessThan(0.002);
    expect(Math.abs(r.skin - TRUTH.skin)).toBeLessThan(0.05);
    expect(Math.abs(r.pStar - RES.pi)).toBeLessThan(0.01);
  });

  test('Horner on the equivalent tp misreads the same data (why the history matters)', () => {
    const tpEq = equivalentProducingTime(HISTORY, TS);
    const h = hornerAnalysis({ points: radial, tp: tpEq, pwfShutIn: bu.pwfAtShutIn, ...RES, q: 140 });
    const s = superpositionBuildupAnalysis({ points: radial, steps: HISTORY, shutInTime: TS, pwfShutIn: bu.pwfAtShutIn, ...RES });
    expect(Math.abs(h.k / TRUTH.k - 1)).toBeGreaterThan(0.015);
    expect(Math.abs(h.k / TRUTH.k - 1)).toBeGreaterThan(10 * Math.abs(s.k / TRUTH.k - 1));
    expect(h.skin - TRUTH.skin).toBeGreaterThan(0.1);
  });

  test('one rate from t = 0 returns hornerAnalysis', () => {
    const one = evaluateBuildup({ model: homog, params: TRUTH, reservoir: RES, tp: 48, dts });
    const pts = one.filter((p) => p.dt >= 2).map((p) => ({ dt: p.dt, pws: p.pws }));
    const h = hornerAnalysis({ points: pts, tp: 48, pwfShutIn: one.pwfAtShutIn, ...RES });
    const s = superpositionBuildupAnalysis({ points: pts, steps: [{ start: 0, q: RES.q }], shutInTime: 48, pwfShutIn: one.pwfAtShutIn, ...RES });
    for (const key of ['m', 'k', 'pStar', 'p1hr', 'skin']) expect(s[key]).toBeCloseTo(h[key], 9);
  });

  test('the derivative on equivalent time is flat at 70.6 qn B mu / kh in radial flow', () => {
    const series = bu.map((p) => ({ x: superpositionEquivalentTime(HISTORY, TS, p.dt), y: p.dp }));
    const d = bourdetDerivative(series, { L: 0.1 });
    const plateau = (OILFIELD.DERIVATIVE_PLATEAU * 140 * RES.B * RES.mu) / (TRUTH.k * RES.h);
    const late = d.filter((p, i) => bu[i].dt >= 3 && bu[i].dt <= 40 && Number.isFinite(p.derivative));
    expect(late.length).toBeGreaterThan(10);
    for (const p of late) expect(Math.abs(p.derivative / plateau - 1)).toBeLessThan(0.01);
  });
});

describe('distance to a sealing fault from two semilog lines', () => {
  test('the constant is 0.0002637 exp(-gamma), Earlougher 0.000148', () => {
    expect(FAULT_INTERSECTION_CONSTANT).toBeCloseTo(0.0001481, 7);
    expect(faultDistanceFromIntersection({ k: 100, dtx: 10, phi: 0.2, mu: 1, ct: 1e-5 })).toBeCloseTo(Math.sqrt(FAULT_INTERSECTION_CONSTANT * 1000 / 2e-6), 9);
  });

  test('recovers the distance of the engine fault model (image well, independent of the formula)', () => {
    const fault = getModel('homogeneous-sealing-fault');
    const L = 555;
    const params = { k: 225, skin: 3, C: 0.0004, L };
    const tp = 30000;
    const pts = evaluateBuildup({ model: fault, params, reservoir: RES, tp, dts: logspace(-1, 3.7, 90) });
    const eta = (OILFIELD.TD_FACTOR * 225) / (RES.phi * RES.mu * RES.ct);
    const tFor = (tDL) => (tDL * L * L) / eta; // hours at which t_DL = 0.000264 k t / (phi mu ct L^2)
    const early = pts.filter((p) => p.dt >= 0.2 && p.dt <= tFor(0.08));
    const late = pts.filter((p) => p.dt >= tFor(40) && p.dt <= tFor(150));
    const r = twoLineFaultAnalysis({ kind: 'buildup', early, late, steps: [{ start: 0, q: RES.q }], shutInTime: tp, ...RES });
    expect(r.ok).toBe(true);
    expect(r.k / 225).toBeCloseTo(1, 1);
    expect(r.ratio).toBeGreaterThan(1.9);
    expect(r.ratio).toBeLessThan(2.1);
    expect(Math.abs(r.L / L - 1)).toBeLessThan(0.05);
    expect(r.warnings).toEqual([]);
  });

  test('a late line that has not doubled is flagged', () => {
    const fault = getModel('homogeneous-sealing-fault');
    const pts = evaluateBuildup({ model: fault, params: { k: 225, skin: 3, C: 0.004, L: 555 }, reservoir: RES, tp: 30000, dts: logspace(-1, 2, 60) });
    const r = twoLineFaultAnalysis({ kind: 'buildup', early: pts.filter((p) => p.dt >= 0.6 && p.dt <= 2), late: pts.filter((p) => p.dt >= 10 && p.dt <= 30), steps: [{ start: 0, q: RES.q }], shutInTime: 30000, ...RES });
    expect(r.warnings.join(' ')).toMatch(/differ by a factor/);
  });

  test('drawdown kind reads the MDH lines', () => {
    const fault = getModel('homogeneous-sealing-fault');
    const L = 800;
    const eta = (OILFIELD.TD_FACTOR * 225) / (RES.phi * RES.mu * RES.ct);
    const times = logspace(-1, 4, 100);
    const dd = evaluateDrawdown({ model: fault, params: { k: 225, skin: 3, C: 0.0004, L }, reservoir: RES, times });
    const pts = dd.map((p) => ({ t: p.t, pwf: p.pw }));
    const r = twoLineFaultAnalysis({
      kind: 'drawdown', q: RES.q,
      early: pts.filter((p) => p.t >= 0.2 && p.t <= (0.08 * L * L) / eta),
      late: pts.filter((p) => p.t >= (40 * L * L) / eta && p.t <= (150 * L * L) / eta),
      ...RES,
    });
    expect(Math.abs(r.L / L - 1)).toBeLessThan(0.05);
  });
});

describe('MDH buildup line', () => {
  test('long producing time: MDH and Horner agree and recover k and skin', () => {
    const dts = logspace(-2, Math.log10(72), 60);
    const bu = evaluateBuildup({ model: homog, params: TRUTH, reservoir: RES, tp: 50000, dts });
    const pts = bu.filter((p) => p.dt >= 2).map((p) => ({ dt: p.dt, pws: p.pws }));
    const m = mdhBuildupAnalysis({ points: pts, pwfShutIn: bu.pwfAtShutIn, ...RES });
    expect(Math.abs(m.k / TRUTH.k - 1)).toBeLessThan(0.01);
    expect(Math.abs(m.skin - TRUTH.skin)).toBeLessThan(0.05);
  });

  test('short producing time: MDH bends and reads k high, Horner does not', () => {
    const dts = logspace(-2, Math.log10(72), 60);
    const bu = evaluateBuildup({ model: homog, params: TRUTH, reservoir: RES, tp: 24, dts });
    const pts = bu.filter((p) => p.dt >= 5).map((p) => ({ dt: p.dt, pws: p.pws }));
    const m = mdhBuildupAnalysis({ points: pts, pwfShutIn: bu.pwfAtShutIn, ...RES });
    const h = hornerAnalysis({ points: pts, tp: 24, pwfShutIn: bu.pwfAtShutIn, ...RES });
    expect(Math.abs(h.k / TRUTH.k - 1)).toBeLessThan(0.01);
    expect(m.k / TRUTH.k).toBeGreaterThan(1.3);
  });
});

describe('auto-fit on a buildup after a rate history', () => {
  test('recovers k, skin and C with the history; the equivalent tp misses the skin', () => {
    const truth = { k: 225, skin: 3.2, C: 0.004 };
    const dts = logspace(-2.5, Math.log10(48), 45);
    const bu = evaluateBuildupFromHistory({ model: homog, params: truth, reservoir: RES, steps: HISTORY, shutInTime: TS, dts });
    const data = bu.map((p) => ({ dt: p.dt, dp: p.dp }));
    const start = { k: 100, skin: 0, C: 0.01 };
    const withHistory = autoFitModel({ model: homog, testType: 'buildup', data, reservoir: { ...RES, q: 140 }, tp: equivalentProducingTime(HISTORY, TS), rateHistory: { steps: HISTORY, shutInTime: TS }, initialParams: start });
    expect(Math.abs(withHistory.params.k / truth.k - 1)).toBeLessThan(0.005);
    expect(Math.abs(withHistory.params.skin - truth.skin)).toBeLessThan(0.02);
    expect(Math.abs(withHistory.params.C / truth.C - 1)).toBeLessThan(0.01);
    const onTp = autoFitModel({ model: homog, testType: 'buildup', data, reservoir: { ...RES, q: 140 }, tp: equivalentProducingTime(HISTORY, TS), initialParams: start });
    const errHistory = Math.abs(withHistory.params.k / truth.k - 1) + Math.abs(withHistory.params.skin - truth.skin);
    const errTp = Math.abs(onTp.params.k / truth.k - 1) + Math.abs(onTp.params.skin - truth.skin);
    expect(errTp).toBeGreaterThan(5 * errHistory);
  });
});
