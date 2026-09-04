/**
 * Production back-allocation gates.
 *
 * The oracle (tools/validation/production/oracle_allocation.py) reaches
 * every number by a different road: each well's share taken directly
 * out of the metered total where the engine multiplies by a precomputed
 * factor, an explicit validity-interval list bisected where the engine
 * scans and breaks, a theoretical-weighted mean of the daily factors
 * where the engine divides one month total by another, calendar dates
 * where the engine counts epoch days, and a quadratic root written down
 * where the engine is handed a bisecting solver.
 *
 * THE FIRST GATE IS CLOSURE, AND IT IS EXACT. An allocation that does
 * not add back up to the meter is not an allocation. Every day, every
 * phase, to the last bit the arithmetic allows.
 */
import fs from 'fs';
import path from 'path';
import {
  monthKey, PHASES, groupTests, testInForce, computeAllocation,
  monthlyFactors, allocatedLedgerRows, imbalanceSeries,
  validateWellTests, crossCheckTestsAgainstNodal,
  DEFAULT_ALLOCATION_SETTINGS, DEFAULT_TEST_QC_SETTINGS,
  DEFAULT_NODAL_CHECK_SETTINGS, TEST_ISSUES,
} from '../engines/production/allocation';
import { buildWellSeries } from '../engines/production/surveillance';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'allocation_cases.json'),
  'utf8',
));

const KEYS = ['oil', 'water', 'gas'];
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

/** Ledger rows with their well object attached, which is the shape the
 *  series builder reads. */
const attachWells = (field) => {
  const byId = new Map(field.wells.map((w) => [w.id, w]));
  return field.ledger.map((r) => ({ ...r, well: byId.get(r.well_id) }));
};

const countCodes = (diagnostics) => {
  const out = {};
  diagnostics.forEach((x) => { out[x.code] = (out[x.code] || 0) + 1; });
  return out;
};

const run = (field, settings) => computeAllocation({
  wells: field.wells,
  tests: field.tests,
  ledger: field.ledger,
  totals: field.totals,
  settings,
});

// ---------------------------------------------------------------------------

describe('the shape of the problem', () => {
  test('three phases, in the ledger units the whole module is stated in', () => {
    expect(PHASES.map((p) => p.key)).toEqual(['oil', 'water', 'gas']);
    expect(PHASES.map((p) => p.unit)).toEqual(['stb', 'stb', 'Mscf']);
  });

  test('monthKey collapses a date to the first of its month', () => {
    expect(monthKey('2025-03-17')).toBe('2025-03-01');
    expect(monthKey(G.field.totals[0].total_date)).toBe('2025-01-01');
  });

  test('the defaults are the ones the goldens were cut against', () => {
    expect(G.allocation.settings.maxTestAgeDays).toBe(DEFAULT_ALLOCATION_SETTINGS.maxTestAgeDays);
    expect(G.allocation.settings.factorWarnLow).toBe(DEFAULT_ALLOCATION_SETTINGS.factorWarnLow);
    expect(G.allocation.settings.factorWarnHigh).toBe(DEFAULT_ALLOCATION_SETTINGS.factorWarnHigh);
    expect(DEFAULT_TEST_QC_SETTINGS.outlierPct).toBe(50);
    expect(DEFAULT_NODAL_CHECK_SETTINGS.tolerancePct).toBe(35);
    expect(Object.keys(TEST_ISSUES).sort()).toEqual([
      'ledger_mismatch', 'no_ledger', 'rate_outlier',
      'short_duration', 'watercut_mismatch', 'zero_rate',
    ]);
  });
});

describe('which test carries a well on a date', () => {
  test('agrees with an explicit validity-interval list, bisected', () => {
    const grouped = groupTests(G.field.tests);
    expect(G.testInForce.length).toBeGreaterThan(20);
    G.testInForce.forEach((c) => {
      const t = testInForce(grouped.get(c.wellId), c.date, c.maxTestAgeDays);
      expect(t ? t.id : null).toBe(c.testId);
    });
  });

  test('a well with no valid test has none in force, on every date', () => {
    const grouped = groupTests(G.field.tests);
    // P-3's only test failed QC, so the well is carried by nothing.
    expect(grouped.get('w-p3')).toBeUndefined();
    expect(testInForce(grouped.get('w-p3'), '2025-02-01')).toBeNull();
  });

  test('an invalid test is honoured as invalid unless asked for', () => {
    const strict = groupTests(G.field.tests);
    const loose = groupTests(G.field.tests, { includeInvalid: true });
    expect(strict.get('w-p1').map((t) => t.id)).toEqual(['t-p1-a', 't-p1-b']);
    expect(loose.get('w-p1').map((t) => t.id)).toEqual(['t-p1-a', 't-p1-bad', 't-p1-b']);
  });

  test('the age cap expires a test rather than stretching it', () => {
    const grouped = groupTests(G.field.tests);
    // P-2's one test is 2024-09-15. Inside 180 days on 2025-02-17,
    // outside 120 days from 2025-01-14 onward.
    expect(testInForce(grouped.get('w-p2'), '2025-02-17', 180).id).toBe('t-p2-a');
    expect(testInForce(grouped.get('w-p2'), '2025-01-13', 120).id).toBe('t-p2-a');
    expect(testInForce(grouped.get('w-p2'), '2025-01-14', 120)).toBeNull();
  });
});

describe('the allocation itself', () => {
  const alloc = run(G.field);

  test('CLOSES EXACTLY: the wells sum back to the meter, every day, every phase', () => {
    expect(alloc.days).toHaveLength(G.allocation.days.length);
    alloc.days.forEach((day) => {
      KEYS.forEach((k) => {
        if (day.factors[k] == null) {
          expect(day.allocated[k]).toBe(0);
          return;
        }
        const sum = day.entries.reduce((a, e) => a + e.allocated[k], 0);
        expect(rel(sum, day.measured[k])).toBeLessThan(1e-12);
        expect(rel(day.allocated[k], day.measured[k])).toBeLessThan(1e-12);
      });
    });
  });

  test('every daily factor, theoretical and allocated volume matches the oracle', () => {
    alloc.days.forEach((day, i) => {
      const g = G.allocation.days[i];
      expect(day.date).toBe(g.date);
      KEYS.forEach((k) => {
        expect(day.measured[k]).toBeCloseTo(g.measured[k], 9);
        expect(rel(day.theoretical[k], g.theoretical[k])).toBeLessThan(1e-12);
        if (g.factors[k] == null) {
          expect(day.factors[k]).toBeNull();
        } else {
          expect(rel(day.factors[k], g.factors[k])).toBeLessThan(1e-12);
        }
      });
    });
  });

  test('every well takes exactly the share the oracle gives it, and no factor was used to get it', () => {
    alloc.days.forEach((day, i) => {
      const g = G.allocation.days[i];
      expect(day.entries.map((e) => e.wellId)).toEqual(g.entries.map((e) => e.wellId));
      day.entries.forEach((e, j) => {
        const ge = g.entries[j];
        expect(e.uptime).toBeCloseTo(ge.uptime, 12);
        expect(e.testId).toBe(ge.testId);
        KEYS.forEach((k) => {
          expect(rel(e.theoretical[k], ge.theoretical[k])).toBeLessThan(1e-12);
          if (ge.allocated[k] === 0) {
            expect(Math.abs(e.allocated[k])).toBeLessThan(1e-9);
          } else {
            expect(rel(e.allocated[k], ge.allocated[k])).toBeLessThan(1e-12);
          }
        });
      });
    });
  });

  test('the roll-ups agree: grand totals, per-well aggregates, ordering', () => {
    expect(alloc.totals.days).toBe(G.allocation.grand.days);
    KEYS.forEach((k) => {
      expect(rel(alloc.totals.measured[k], G.allocation.grand[`measured_${k}`])).toBeLessThan(1e-12);
      expect(rel(alloc.totals.theoretical[k], G.allocation.grand[`theoretical_${k}`])).toBeLessThan(1e-12);
      expect(rel(alloc.totals.allocated[k], G.allocation.grand[`allocated_${k}`])).toBeLessThan(1e-12);
    });
    expect(alloc.wells.map((w) => w.wellName)).toEqual(G.allocation.wells.map((w) => w.wellName));
    alloc.wells.forEach((w, i) => {
      expect(w.days).toBe(G.allocation.wells[i].days);
      KEYS.forEach((k) => {
        expect(rel(w.allocated[k], G.allocation.wells[i].allocated[k])).toBeLessThan(1e-12);
      });
    });
  });

  test('the diagnostics fire exactly as often as the oracle says', () => {
    expect(countCodes(alloc.diagnostics)).toEqual(G.allocation.diagnosticCounts);
  });

  test('a factor outside the band is FLAGGED and NOT clamped', () => {
    const flagged = alloc.diagnostics.filter((x) => x.code === 'factor_out_of_band');
    expect(flagged.length).toBeGreaterThan(0);
    flagged.forEach((f) => {
      const day = alloc.days.find((x) => x.date === f.date);
      // the reported value is the raw factor, still out of band
      expect(day.factors[f.phase]).toBe(f.value);
      const out = f.value < alloc.settings.factorWarnLow || f.value > alloc.settings.factorWarnHigh;
      expect(out).toBe(true);
    });
  });

  test('injectors and observation wells never take a share of produced volumes', () => {
    const ids = new Set();
    alloc.days.forEach((d) => d.entries.forEach((e) => ids.add(e.wellId)));
    expect([...ids].sort()).toEqual(['w-p1', 'w-p2']);
  });

  test('a date with no metered total is not invented', () => {
    const dates = new Set(alloc.days.map((d) => d.date));
    expect(dates.size).toBe(G.field.totals.length);
    expect(dates.has('2025-02-18')).toBe(false);
  });
});

describe('the settings variants', () => {
  const cases = [
    ['allocationLedgerBasis', { basis: 'ledger' }],
    ['allocationAged120', { maxTestAgeDays: 120 }],
    ['allocationNoUptime', { useUptime: false }],
    ['allocationWithInvalidTests', { includeInvalidTests: true }],
  ];

  test.each(cases)('%s matches the oracle day for day', (key, settings) => {
    const alloc = run(G.field, settings);
    const g = G[key];
    expect(alloc.days).toHaveLength(g.days.length);
    alloc.days.forEach((day, i) => {
      KEYS.forEach((k) => {
        expect(rel(day.theoretical[k], g.days[i].theoretical[k])).toBeLessThan(1e-12);
        if (g.days[i].factors[k] == null) expect(day.factors[k]).toBeNull();
        else expect(rel(day.factors[k], g.days[i].factors[k])).toBeLessThan(1e-12);
        expect(rel(day.allocated[k] || 1, g.days[i].allocated[k] || 1)).toBeLessThan(1e-12);
      });
    });
    expect(countCodes(alloc.diagnostics)).toEqual(g.diagnosticCounts);
  });

  test('the ledger basis prorates the wells own meters and still closes', () => {
    const alloc = run(G.field, { basis: 'ledger' });
    alloc.days.forEach((day) => {
      expect(day.entries.every((e) => e.testId === null)).toBe(true);
      KEYS.forEach((k) => {
        if (day.factors[k] == null) return;
        expect(rel(day.allocated[k], day.measured[k])).toBeLessThan(1e-12);
      });
    });
  });

  test('letting an invalid test back in POISONS the split, which is why it is off by default', () => {
    const strict = run(G.field);
    const loose = run(G.field, { includeInvalidTests: true });
    // The all-zero test of 2025-01-30 carries P-1 until it is retested,
    // so for those days P-1 is capable of nothing and P-2 takes the
    // entire field. That is not a subtle degradation.
    const day = '2025-02-01';
    const s = strict.days.find((x) => x.date === day);
    const l = loose.days.find((x) => x.date === day);
    expect(s.entries.find((e) => e.wellId === 'w-p1').allocated.oil).toBeGreaterThan(0);
    expect(l.entries.find((e) => e.wellId === 'w-p1').allocated.oil).toBe(0);
    expect(rel(l.entries.find((e) => e.wellId === 'w-p2').allocated.oil, l.measured.oil))
      .toBeLessThan(1e-12);
  });
});

describe('a metered volume no well could have made', () => {
  const g = G.noBasis;
  const alloc = run(g.field);

  test('is not spread anyway: the day reports no basis and allocates nothing', () => {
    const dead = alloc.days.find((x) => x.date === '2025-03-02');
    KEYS.forEach((k) => {
      expect(dead.theoretical[k]).toBe(0);
      expect(dead.factors[k]).toBeNull();
      expect(dead.allocated[k]).toBe(0);
    });
    expect(countCodes(alloc.diagnostics)).toEqual(g.allocation.diagnosticCounts);
    expect(alloc.diagnostics.filter((x) => x.code === 'no_basis')
      .every((x) => x.severity === 'high')).toBe(true);
  });

  test('and the day that CAN be allocated still is', () => {
    const live = alloc.days.find((x) => x.date === '2025-03-01');
    const gl = g.allocation.days.find((x) => x.date === '2025-03-01');
    KEYS.forEach((k) => {
      expect(rel(live.factors[k], gl.factors[k])).toBeLessThan(1e-12);
      expect(rel(live.allocated[k], live.measured[k])).toBeLessThan(1e-12);
    });
  });
});

describe('the monthly factors', () => {
  const rows = monthlyFactors(run(G.field));

  test('are what a theoretical-volume-weighted mean of the daily factors gives', () => {
    expect(rows).toHaveLength(G.monthlyFactors.length);
    rows.forEach((r, i) => {
      const g = G.monthlyFactors[i];
      expect(r.wellId).toBe(g.wellId);
      expect(r.periodMonth).toBe(g.periodMonth);
      KEYS.forEach((k) => {
        expect(rel(r.factors[k], g.factors[k])).toBeLessThan(1e-12);
        expect(rel(r.theoretical[k], g.theoretical[k])).toBeLessThan(1e-12);
      });
    });
  });

  test('a month with no theoretical volume for a phase carries 1, not a divide by zero', () => {
    const noGas = monthlyFactors({
      days: [{
        date: '2025-04-01',
        factors: { oil: 1.1, water: 1, gas: null },
        entries: [{
          wellId: 'x', wellName: 'X-1',
          theoretical: { oil: 100, water: 10, gas: 0 },
          allocated: { oil: 110, water: 10, gas: 0 },
        }],
      }],
    });
    expect(noGas[0].factors.gas).toBe(1);
    expect(noGas[0].factors.oil).toBeCloseTo(1.1, 12);
  });
});

describe('writing the split back to the ledger', () => {
  const alloc = run(G.field);
  const rows = allocatedLedgerRows(alloc);

  test('one row per well per allocated day, and the volumes still close', () => {
    const entryCount = alloc.days.reduce((a, d) => a + d.entries.length, 0);
    expect(rows).toHaveLength(entryCount);
    const byDate = new Map();
    rows.forEach((r) => {
      const t = byDate.get(r.date) || { oil: 0, water: 0, gas: 0 };
      t.oil += r.oil_stb; t.water += r.water_stb; t.gas += r.gas_mscf;
      byDate.set(r.date, t);
    });
    alloc.days.forEach((d) => {
      const t = byDate.get(d.date);
      KEYS.forEach((k) => {
        if (d.factors[k] == null) return;
        const got = k === 'gas' ? t.gas : t[k];
        expect(rel(got, d.measured[k])).toBeLessThan(1e-12);
      });
    });
  });

  test('hours_on carries the uptime that produced the split, so the ledger stays self-consistent', () => {
    rows.forEach((r) => {
      const day = alloc.days.find((d) => d.date === r.date);
      const e = day.entries.find((x) => x.wellId === r.wellId);
      expect(r.hours_on).toBeCloseTo(e.uptime * 24, 12);
    });
    const noUptime = allocatedLedgerRows(run(G.field, { useUptime: false }));
    expect(noUptime.every((r) => r.hours_on === null)).toBe(true);
  });
});

describe('the imbalance against the wells own meters', () => {
  const series = imbalanceSeries(run(G.field), G.field.ledger);

  test('matches the oracle, sign and all', () => {
    expect(series).toHaveLength(G.imbalance.length);
    series.forEach((r, i) => {
      const g = G.imbalance[i];
      expect(r.date).toBe(g.date);
      KEYS.forEach((k) => {
        expect(r[k].booked).toBeCloseTo(g[k].booked, 9);
        expect(r[k].imbalance).toBeCloseTo(g[k].imbalance, 9);
        if (g[k].imbalancePct == null) expect(r[k].imbalancePct).toBeNull();
        else expect(rel(r[k].imbalancePct, g[k].imbalancePct)).toBeLessThan(1e-12);
      });
    });
  });

  test('positive means the meter saw more than the wells booked', () => {
    const r = series[0];
    expect(r.oil.imbalance).toBeCloseTo(r.oil.measured - r.oil.booked, 9);
  });

  test('nothing booked means no percentage, rather than an infinity', () => {
    const s = imbalanceSeries(run(G.field), []);
    expect(s.every((r) => r.oil.imbalancePct === null)).toBe(true);
    expect(s.every((r) => Number.isFinite(r.oil.imbalance))).toBe(true);
  });
});

describe('well test QC', () => {
  const rows = G.testQc.ledger.map((r) => ({ ...r, well: G.testQc.well }));
  const series = buildWellSeries(rows);
  const results = validateWellTests(G.testQc.tests, series);

  test('flags exactly the tests the oracle flags, with the same issue codes', () => {
    expect(results.map((r) => r.testId)).toEqual(G.testQc.results.map((r) => r.testId));
    results.forEach((r, i) => {
      const g = G.testQc.results[i];
      expect(r.severity).toBe(g.severity);
      expect(r.issues.map((x) => x.code)).toEqual(g.codes);
    });
  });

  test('a clean test is absent rather than present with an empty issue list', () => {
    const flagged = new Set(results.map((r) => r.testId));
    expect(flagged.has('q-1')).toBe(false);
    expect(flagged.has('q-2')).toBe(false);
    expect(flagged.has('q-3')).toBe(false);
  });

  test('the outlier rule waits for three earlier tests before it reads a median', () => {
    // q-4 is 3x the median of q-1..q-3 and is flagged. The same rate as
    // the FIRST test in a well's history is not, because there is no
    // history to be an outlier against.
    const early = validateWellTests([
      { ...G.testQc.tests[0], id: 'e-1', oil_rate_stbd: 1500 },
    ], series);
    expect(early.some((r) => r.issues.some((i) => i.code === 'rate_outlier'))).toBe(false);
    const late = results.find((r) => r.testId === 'q-4');
    expect(late.issues.find((i) => i.code === 'rate_outlier').severity).toBe('high');
  });

  test('worst first, and inside a severity the most recent test first', () => {
    const rank = { high: 0, medium: 1, info: 2 };
    for (let i = 1; i < results.length; i += 1) {
      expect(rank[results[i].severity]).toBeGreaterThanOrEqual(rank[results[i - 1].severity]);
    }
  });
});

// ---------------------------------------------------------------------------
// The nodal cross-check, on an analytic instrument.
//
// Inflow  pwf = pr - q/J, outflow pwf = whp + A + B q^2. The oracle
// writes the crossing down as a quadratic root; the stub handed to the
// engine here finds it by BISECTION on the residual, so the two agree
// only if the crossing is really where both say it is.
// ---------------------------------------------------------------------------

describe('cross-checking a test against its own well', () => {
  const P = G.nodalCrossCheck.instrument;

  const solveByBisection = ({ vlp }) => {
    const resid = (q) => (P.pr - q / P.J) - (vlp.whp + P.A + P.B * q * q);
    if (!(resid(0) > 0)) return { op: null }; // the model does not flow here
    let lo = 0;
    let hi = P.J * P.pr; // absolute open flow of the straight-line inflow
    for (let i = 0; i < 200; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (resid(mid) > 0) lo = mid; else hi = mid;
    }
    return { op: { q: 0.5 * (lo + hi) } };
  };

  const wellModels = new Map([['w-n1', { instrument: true }]]);
  const buildModel = () => ({ ipr: { pr: P.pr, pi: P.J }, vlp: { rates: {} } });

  const results = crossCheckTestsAgainstNodal({
    tests: G.nodalCrossCheck.tests,
    wellModels,
    buildModel,
    solveNode: solveByBisection,
  });

  test('the bisected crossing is the closed-form quadratic root', () => {
    const g = G.nodalCrossCheck.results.find((r) => r.testId === 'n-ok');
    const r = results.find((x) => x.testId === 'n-ok');
    expect(rel(r.nodalStbd, g.nodalStbd)).toBeLessThan(1e-9);
  });

  test('every test lands on the oracle status, deviation and order', () => {
    expect(results.map((r) => r.testId)).toEqual(G.nodalCrossCheck.results.map((r) => r.testId));
    results.forEach((r, i) => {
      const g = G.nodalCrossCheck.results[i];
      expect(r.status).toBe(g.status);
      if (g.nodalStbd == null) expect(r.nodalStbd).toBeNull();
      else expect(rel(r.nodalStbd, g.nodalStbd)).toBeLessThan(1e-9);
      if (g.deviationPct == null) expect(r.deviationPct).toBeNull();
      else expect(rel(r.deviationPct, g.deviationPct)).toBeLessThan(1e-9);
    });
  });

  test('a well that should not flow at that wellhead pressure is DEAD, not zero', () => {
    const dead = results.find((r) => r.testId === 'n-dead');
    expect(dead.status).toBe('dead');
    expect(dead.nodalStbd).toBeNull();
    expect(dead.message).toMatch(/does not flow/);
    // and the test's own rate is still reported, because the point is
    // that the two disagree
    expect(dead.measuredStbd).toBe(700);
  });

  test('no model and no wellhead pressure are their own answers, not failures', () => {
    expect(results.find((r) => r.testId === 'n-nomodel').status).toBe('no-model');
    expect(results.find((r) => r.testId === 'n-nothp').status).toBe('no-thp');
    expect(results.every((r) => Number.isFinite(r.nodalStbd) || r.nodalStbd === null)).toBe(true);
  });

  test('a solver that throws is a refusal, not an exception out of the module', () => {
    const boom = crossCheckTestsAgainstNodal({
      tests: G.nodalCrossCheck.tests.filter((t) => t.well_id === 'w-n1' && t.thp_psia),
      wellModels,
      buildModel,
      solveNode: () => { throw new Error('traverse did not converge'); },
    });
    expect(boom.every((r) => r.status === 'no-model')).toBe(true);
    expect(boom[0].message).toMatch(/traverse did not converge/);
  });

  test('the tolerance is the stated one and is applied on the nodal rate', () => {
    const tight = crossCheckTestsAgainstNodal({
      tests: G.nodalCrossCheck.tests,
      wellModels,
      buildModel,
      solveNode: solveByBisection,
      settings: { tolerancePct: 5 },
    });
    // n-ok sits 10 per cent below the model: clean at 35, off at 5.
    expect(results.find((r) => r.testId === 'n-ok').status).toBe('ok');
    expect(tight.find((r) => r.testId === 'n-ok').status).toBe('off');
  });
});
