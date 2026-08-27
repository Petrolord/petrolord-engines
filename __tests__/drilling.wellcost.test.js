// Well cost & time (D11): activity schedule closed forms, the
// time-depth curve, AFE rollup arithmetic, the cost-time accrual
// identity, ADE ch.1 cost per metre, benchmark suggestion determinism
// and oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  ACTIVITY_KINDS, activityDuration, evaluateProgram, afeCosts,
  costTimeCurve, costPerMeter, programFromSections,
} from '../engines/drilling/wellCost.js';
import {
  REGION_BENCHMARKS, WELL_TYPE_MODIFIERS, benchmarkSuggestion,
} from '../engines/drilling/data/costBenchmarks.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('wellcost_cases.json');
const DOC = golden.caseDoc;

describe('activity durations', () => {
  test('closed forms per kind', () => {
    expect(ACTIVITY_KINDS).toEqual(['drill', 'trip', 'casing', 'flat']);
    expect(activityDuration({ kind: 'drill', fromMdM: 500, toMdM: 2000, ropMPerHr: 15 })).toBe(100);
    expect(activityDuration({ kind: 'trip', mdM: 2000, tripSpeedMPerHr: 500 })).toBe(8);
    expect(activityDuration({ kind: 'casing', mdM: 2000, runSpeedMPerHr: 400, flatHr: 19 })).toBe(24);
    expect(activityDuration({ kind: 'flat', durationHr: 60 })).toBe(60);
    expect(() => activityDuration({ kind: 'drill', fromMdM: 100, toMdM: 100, ropMPerHr: 10 })).toThrow(/exceed/);
    expect(() => activityDuration({ kind: 'drill', fromMdM: 0, toMdM: 100, ropMPerHr: 0 })).toThrow(/ROP/);
    expect(() => activityDuration({ kind: 'party' })).toThrow(/kind/);
  });

  test('program totals, NPT stretch and depth continuity vs golden', () => {
    const res = evaluateProgram(DOC.program);
    expect(res.totals.productiveHr).toBe(golden.totals.productiveHr);
    expect(res.totals.totalHr).toBe(golden.totals.totalHr);
    expect(res.totals.totalDays).toBe(18);
    expect(res.totals.drilledM).toBe(3000);
    res.rows.forEach((r, i) => {
      expectClose(r.endHr, golden.rows[i].endHr, 1e-12);
      expectClose(r.endMdM, golden.rows[i].endMdM, 1e-12);
      expectClose(r.drilledToM, golden.rows[i].drilledToM, 1e-12);
    });
    expect(res.curve).toHaveLength(golden.curve.length);
    res.curve.forEach((p, i) => {
      expectClose(p.tHr, golden.curve[i].tHr, 1e-12);
      expectClose(p.mdM, golden.curve[i].mdM, 1e-12);
    });
    // A discontinuous drill start is refused.
    expect(() => evaluateProgram({
      activities: [{ kind: 'drill', fromMdM: 100, toMdM: 200, ropMPerHr: 10 }],
    })).toThrow(/hole is at/);
  });
});

describe('AFE rollup', () => {
  const program = evaluateProgram(DOC.program);
  const costs = afeCosts({
    items: DOC.costs.items,
    totalDays: program.totals.totalDays,
    drilledM: program.totals.drilledM,
    contingencyFrac: DOC.costs.contingencyFrac,
  });

  test('per-day / per-meter / lump amounts and category subtotals vs golden', () => {
    costs.byItem.forEach((r, i) => {
      expectClose(r.amountUsd, golden.afe.byItem[i].amountUsd, 1e-12);
    });
    expect(costs.tangibleUsd).toBe(golden.afe.tangibleUsd);
    expect(costs.intangibleUsd).toBe(golden.afe.intangibleUsd);
    expect(costs.baseUsd).toBe(golden.afe.baseUsd);
    expect(costs.contingencyUsd).toBe(golden.afe.contingencyUsd);
    expect(costs.totalUsd).toBe(golden.afe.totalUsd);
    expect(() => afeCosts({
      items: [{ id: 'x', category: 'tangible', basis: 'per-well', rate: 1 }],
      totalDays: 1, drilledM: 1,
    })).toThrow(/basis/);
  });

  test('cost-time accrual: golden points, checkpoint and endpoint identity', () => {
    const pts = costTimeCurve({ program, items: DOC.costs.items });
    expect(pts).toHaveLength(golden.costCurve.length);
    pts.forEach((p, i) => {
      expectClose(p.tHr, golden.costCurve[i].tHr, 1e-12);
      expectClose(p.usd, golden.costCurve[i].usd, 1e-12);
    });
    const cp = pts.find((p) => p.tHr === golden.costCurveCheckpoint.tHr);
    expectClose(cp.usd, golden.costCurveCheckpoint.usd, 1e-12);
    expectClose(pts[pts.length - 1].usd, costs.baseUsd, 1e-12);
    expect(() => costTimeCurve({
      program,
      items: [{ id: 'x', basis: 'lump', value: 1, atActivityId: 'nope' }],
    })).toThrow(/unknown activity/);
  });
});

describe('cost per metre and benchmarks', () => {
  test('ADE ch.1 closed form vs golden', () => {
    expect(costPerMeter(golden.costPerMeter.inputs)).toBe(golden.costPerMeter.usdPerM);
    expect(() => costPerMeter({ ...golden.costPerMeter.inputs, intervalM: 0 })).toThrow(/interval/);
  });

  test('benchmark suggestion is deterministic and honest about unknowns', () => {
    expect(Object.keys(REGION_BENCHMARKS)).toContain('Gulf of Mexico');
    expect(Object.keys(WELL_TYPE_MODIFIERS)).toContain('Offshore shelf');
    expect(benchmarkSuggestion(golden.benchmark.inputs)).toEqual(golden.benchmark.suggestion);
    expect(benchmarkSuggestion({ region: 'Atlantis', wellType: 'Offshore shelf', mdM: 1000 })).toBeNull();
    expect(benchmarkSuggestion({ region: 'Brazil', wellType: 'Offshore shelf', mdM: 0 })).toBeNull();
  });
});

describe('program from hole sections', () => {
  test('starter program drills, trips and cases each section in order', () => {
    const acts = programFromSections(
      [{ name: 'surface', endMdM: 500 }, { name: 'production', endMdM: 3000, ropMPerHr: 8 }],
      { moveHr: 24, completionHr: 48 },
    );
    expect(acts.map((a) => a.kind)).toEqual(
      ['flat', 'drill', 'trip', 'casing', 'drill', 'trip', 'casing', 'flat']);
    expect(acts[4].fromMdM).toBe(500);
    expect(acts[4].ropMPerHr).toBe(8);
    const res = evaluateProgram({ activities: acts, nptFrac: 0 });
    expect(res.totals.tdMdM).toBe(3000);
    expect(() => programFromSections([{ endMdM: 500 }, { endMdM: 400 }])).toThrow(/ascending/);
  });
});

describe('linear MC fixture (analytic identities used by suite gate A33)', () => {
  test('representative evaluation matches the analytic mean structure', () => {
    // At the modes: cost = 5000*(100+30+20+10) + 200000 + 500000.
    const prog = evaluateProgram(golden.mc.program);
    const costs = afeCosts({
      items: golden.mc.costs.items,
      totalDays: prog.totals.totalDays,
      drilledM: prog.totals.drilledM,
      contingencyFrac: 0,
    });
    expect(prog.totals.totalHr).toBe(160);
    expect(costs.totalUsd).toBe(5000 * 160 + 200000 + 500000);
    expect(golden.mc.analytic.meanUsd).toBe(1530000);
  });
});
