/**
 * Gates for engines/economics/afe.js: the joint-venture partner split, the
 * AFE earned-value metrics and the S-curve.
 *
 *   (a) closed-form identities: conservation of the split, the EVM
 *       definitions, monotone cumulative curves;
 *   (b) agreement with every golden case in
 *       test-data/economics/goldens/afe_cases.json (independent stdlib oracle
 *       tools/validation/economics/oracle_afe.py), disagreements pinned;
 *   (c) the Suite's src/utils/__tests__/costControlCalculations.test.js,
 *       ported (all 19 tests).
 *
 * Tolerances: money 1e-9 absolute (single-digit sums), ratios 1e-12; the
 * S-curve points are rounded integers and compare exactly.
 *
 * Clock. calculateMetrics and generateSCurveData read `new Date()`. The
 * goldens use windows wholly in the past or wholly in the future (valid until
 * 2080; the gate checks the calendar has not caught up), and the past-window
 * S-curve pins the points inside the window plus an invariant for every point
 * after it, because the number of later points moves with the calendar.
 */
import fs from 'fs';
import path from 'path';
import { calculatePartnerCosts, calculateMetrics, generateSCurveData } from '../engines/economics/afe.js';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/economics/goldens/afe_cases.json'), 'utf8'));

const MONEY = 1e-9;
const RATIO = 1e-12;

const expectNum = (actual, expected, tol) => {
  if (expected === null) {
    expect(Number.isFinite(actual)).toBe(false);
    return;
  }
  expect(typeof actual).toBe('number');
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
};

const AFE = { start_date: '2020-01-01', end_date: '2020-12-31', currency: 'USD' };

// ---------------------------------------------------------------------------
// (c) The Suite's tests, ported.
// ---------------------------------------------------------------------------

describe('Suite port: calculateMetrics', () => {
  it('sums budget, commitments and actuals across the cost items', () => {
    const items = [
      { budget: 100, commitment: 20, actual: 30, progress: 0 },
      { budget: 200, commitment: 50, actual: 40, progress: 0 },
    ];
    const m = calculateMetrics(AFE, items, []);
    expect(m.totalBudget).toBe(300);
    expect(m.totalCommitments).toBe(70);
    expect(m.totalActuals).toBe(70);
  });

  it('uses the entered forecast for an item when there is one', () => {
    const items = [{ budget: 100, commitment: 0, actual: 0, forecast: 140, progress: 0 }];
    expect(calculateMetrics(AFE, items, []).totalForecast).toBe(140);
  });

  it('otherwise forecasts the greater of budget and committed spend', () => {
    const under = [{ budget: 100, commitment: 10, actual: 20, progress: 0 }];
    expect(calculateMetrics(AFE, under, []).totalForecast).toBe(100);
    const over = [{ budget: 100, commitment: 60, actual: 70, progress: 0 }];
    expect(calculateMetrics(AFE, over, []).totalForecast).toBe(130);
  });

  it('reports variance as budget less forecast, negative when overrunning', () => {
    const items = [{ budget: 100, commitment: 60, actual: 70, progress: 0 }];
    expect(calculateMetrics(AFE, items, []).variance).toBe(-30);
  });

  it('earns value in proportion to progress, weighted by budget', () => {
    const items = [
      { budget: 100, actual: 0, progress: 50 },
      { budget: 300, actual: 0, progress: 20 },
    ];
    const m = calculateMetrics(AFE, items, []);
    expect(m.earnedValue).toBeCloseTo(110, 10);
    expect(m.percentComplete).toBeCloseTo(27.5, 10);
  });

  it('reports CPI as earned value over actual cost', () => {
    const items = [{ budget: 200, actual: 80, progress: 50 }];
    expect(calculateMetrics(AFE, items, []).cpi).toBeCloseTo(1.25, 10);
  });

  it('reports SPI against elapsed time, which is the documented simplification', () => {
    const items = [{ budget: 200, actual: 100, progress: 50 }];
    expect(calculateMetrics(AFE, items, []).spi).toBeCloseTo(0.5, 10);
  });

  it('does not divide by zero on an empty or unspent AFE', () => {
    const empty = calculateMetrics(AFE, [], []);
    expect(empty.totalBudget).toBe(0);
    expect(empty.cpi).toBe(1);
    expect(empty.spi).toBe(1);
    expect(empty.percentSpent).toBe(0);
    expect(Number.isFinite(empty.percentComplete)).toBe(true);
  });

  it('treats missing numbers as zero rather than producing NaN', () => {
    const items = [{ budget: null, commitment: undefined, actual: '', progress: 'x' }];
    const m = calculateMetrics(AFE, items, []);
    Object.values(m).forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });
});

describe('Suite port: generateSCurveData', () => {
  it('returns nothing without a start and end date, rather than guessing one', () => {
    expect(generateSCurveData({}, [{ budget: 100 }], [])).toEqual([]);
  });

  it('spreads the plan across the window and ends at the full budget', () => {
    const points = generateSCurveData(AFE, [{ budget: 1200 }], []);
    expect(points.length).toBeGreaterThan(1);
    expect(points[0].Planned).toBe(0);
    expect(points[points.length - 1].Planned).toBeLessThanOrEqual(1200);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].Planned).toBeGreaterThanOrEqual(points[i - 1].Planned);
    }
  });

  it('builds actuals from invoices up to each date', () => {
    const invoices = [
      { invoice_date: '2020-02-15', amount: 100 },
      { invoice_date: '2020-06-15', amount: 250 },
    ];
    const points = generateSCurveData(AFE, [{ budget: 1200 }], invoices);
    const last = points[points.length - 1];
    expect(last.Actual).toBe(350);
  });
});

describe('Suite port: calculatePartnerCosts', () => {
  const partners = [
    { name: 'A', working_interest: 30 },
    { name: 'B', working_interest: 15 },
  ];

  it('allocates each partner their working interest of the cost', () => {
    const { partnerAllocations } = calculatePartnerCosts(1000, partners);
    expect(partnerAllocations[0].shareAmount).toBeCloseTo(300, 10);
    expect(partnerAllocations[1].shareAmount).toBeCloseTo(150, 10);
  });

  it('leaves the operator carrying the rest', () => {
    const { operatorShare, operatorAmount } = calculatePartnerCosts(1000, partners);
    expect(operatorShare).toBeCloseTo(55, 10);
    expect(operatorAmount).toBeCloseTo(550, 10);
  });

  it('allocates every currency unit exactly once', () => {
    const { partnerAllocations, operatorAmount } = calculatePartnerCosts(1234.56, partners);
    const total = partnerAllocations.reduce((s, p) => s + p.shareAmount, 0) + operatorAmount;
    expect(total).toBeCloseTo(1234.56, 8);
  });

  it('flags interests that add to more than the whole instead of billing them', () => {
    const tooMuch = [
      { name: 'A', working_interest: 70 },
      { name: 'B', working_interest: 45 },
    ];
    const out = calculatePartnerCosts(1000, tooMuch);
    expect(out.valid).toBe(false);
    expect(out.note).toMatch(/115\.00 percent/);
    expect(out.operatorShare).toBeCloseTo(-15, 10);
  });

  it('accepts a shortfall as valid, since the operator may simply hold the balance', () => {
    const out = calculatePartnerCosts(1000, [{ name: 'A', working_interest: 10 }]);
    expect(out.valid).toBe(true);
    expect(out.note).toBeNull();
    expect(out.operatorShare).toBeCloseTo(90, 10);
  });

  it('gives the operator the whole cost when there are no partners', () => {
    const out = calculatePartnerCosts(500, []);
    expect(out.operatorShare).toBe(100);
    expect(out.operatorAmount).toBe(500);
    expect(out.valid).toBe(true);
  });

  it('treats a non-numeric interest as zero rather than producing NaN', () => {
    const out = calculatePartnerCosts(1000, [{ name: 'A', working_interest: '' }]);
    expect(out.partnerAllocations[0].shareAmount).toBe(0);
    expect(out.operatorAmount).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// (a) Identities.
// ---------------------------------------------------------------------------

describe('identities', () => {
  test('the calendar has not caught up with the future-window goldens', () => {
    expect(new Date().toISOString().slice(0, 10) < G.validUntil).toBe(true);
  });

  test('the split conserves the cost for every golden partner set, valid or not', () => {
    G.partnerSplit.forEach((c) => {
      const out = calculatePartnerCosts(c.inputs.totalCost, c.inputs.partners);
      const allocated = out.partnerAllocations.reduce((s, p) => s + p.shareAmount, 0) + out.operatorAmount;
      expect(Math.abs(allocated - c.inputs.totalCost)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(c.inputs.totalCost)));
      expect(out.valid).toBe(out.operatorShare >= 0);
      expect(out.note === null).toBe(out.valid);
    });
  });

  test('the split is linear in the cost', () => {
    const partners = G.partnerSplit[0].inputs.partners;
    const a = calculatePartnerCosts(1000, partners);
    const b = calculatePartnerCosts(2000, partners);
    b.partnerAllocations.forEach((p, i) => expect(p.shareAmount).toBeCloseTo(2 * a.partnerAllocations[i].shareAmount, 9));
    expect(b.operatorAmount).toBeCloseTo(2 * a.operatorAmount, 9);
    expect(b.operatorShare).toBe(a.operatorShare);
  });

  test('EVM definitions: EV = sum(budget x progress), CPI = EV / AC, SPI = EV / PV, percent complete = EV / BAC', () => {
    const items = [
      { budget: 100, actual: 40, progress: 30 },
      { budget: 300, actual: 200, progress: 60 },
    ];
    const m = calculateMetrics(AFE, items, []);
    const ev = 100 * 0.3 + 300 * 0.6;
    expect(m.earnedValue).toBeCloseTo(ev, 12);
    expect(m.cpi).toBeCloseTo(ev / 240, 12);
    expect(m.spi).toBeCloseTo(ev / 400, 12);
    expect(m.percentComplete).toBeCloseTo((ev / 400) * 100, 12);
    expect(m.percentSpent).toBeCloseTo((240 / 400) * 100, 12);
    expect(m.variance).toBeCloseTo(m.totalBudget - m.totalForecast, 12);
  });

  test('the forecast is never below money already spent and committed', () => {
    G.metrics.forEach((c) => {
      const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
      const floor = c.inputs.costItems.reduce((s, i) => {
        const f = Number(i.forecast) || 0;
        return s + (f > 0 ? f : Math.max(Number(i.budget) || 0, (Number(i.actual) || 0) + (Number(i.commitment) || 0)));
      }, 0);
      expect(m.totalForecast).toBeCloseTo(floor, 9);
    });
  });

  test('planned and forecast curves are monotone and capped, and actuals never decrease', () => {
    G.sCurve.forEach((c) => {
      const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
      const bac = c.expected.totalBudget ?? 0;
      for (let i = 1; i < pts.length; i += 1) {
        expect(pts[i].Planned).toBeGreaterThanOrEqual(pts[i - 1].Planned);
        if (pts[i].Actual !== null && pts[i - 1].Actual !== null) expect(pts[i].Actual).toBeGreaterThanOrEqual(pts[i - 1].Actual);
      }
      pts.forEach((p) => expect(p.Planned).toBeLessThanOrEqual(Math.round(bac)));
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Golden agreement.
// ---------------------------------------------------------------------------

describe('golden: partner split', () => {
  test.each(G.partnerSplit.map((c) => [c.name, c]))('%s', (_n, c) => {
    const out = calculatePartnerCosts(c.inputs.totalCost, c.inputs.partners);
    const e = c.expected;
    expect(out.partnerAllocations).toHaveLength(e.partnerAllocations.length);
    out.partnerAllocations.forEach((p, i) => {
      expectNum(p.shareAmount, e.partnerAllocations[i].shareAmount, MONEY);
      expect(p.billingStatus).toBe('Pending');
      expect(p.name).toBe(e.partnerAllocations[i].name);
      expect(p.working_interest).toEqual(e.partnerAllocations[i].working_interest);
    });
    expectNum(out.operatorShare, e.operatorShare, RATIO);
    expectNum(out.operatorAmount, e.operatorAmount, MONEY);
    expectNum(out.partnerTotal, e.partnerTotal, RATIO);
    expect(out.valid).toBe(e.valid);
    expect(out.note).toBe(e.note);
    const allocated = out.partnerAllocations.reduce((s, p) => s + p.shareAmount, 0) + out.operatorAmount;
    expectNum(allocated, e.conservation.allocated, MONEY);
  });
});

describe('golden: metrics', () => {
  const KEYS = ['totalBudget', 'totalCommitments', 'totalActuals', 'totalForecast', 'variance', 'earnedValue', 'cpi', 'spi', 'percentSpent', 'percentComplete'];

  test.each(G.metrics.map((c) => [c.name, c]))('%s', (_n, c) => {
    const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
    const e = c.expected;
    KEYS.forEach((k) => expectNum(m[k], e[k], k === 'cpi' || k === 'spi' ? RATIO : MONEY));
    // The standard EVM set the oracle carries: the module's fields must map
    // onto it exactly where the module reports them.
    const s = e.standardEvm;
    expectNum(m.totalBudget, s.bac, MONEY);
    expectNum(m.earnedValue, s.ev, MONEY);
    expectNum(m.totalActuals, s.ac, MONEY);
    expectNum(m.totalForecast, s.eac, MONEY);
    expectNum(m.variance, s.vac, MONEY);
    if (s.cpi !== null && m.totalActuals > 0) expectNum(m.cpi, s.cpi, RATIO);
    if (s.spi !== null && m.totalBudget > 0) expectNum(m.spi, s.spi, RATIO);
    if (e.spi === null) expect(c.note).toMatch(/^DISAGREEMENT/);
  });
});

describe('golden: S-curve', () => {
  test.each(G.sCurve.map((c) => [c.name, c]))('%s', (_n, c) => {
    const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
    const e = c.expected;
    if (e.kind === 'none') {
      expect(pts).toEqual([]);
      return;
    }
    const inside = e.pointsWithinWindow;
    if (e.kind === 'future') {
      expect(pts).toHaveLength(inside.length);
    } else {
      expect(pts.length).toBeGreaterThanOrEqual(inside.length);
    }
    inside.forEach((p, i) => {
      expect(pts[i].date).toBe(p.date);
      expect(pts[i].Planned).toBe(p.Planned);
      expect(pts[i].Actual).toBe(p.Actual);
      expect(pts[i].Forecast).toBe(p.Forecast);
    });
    if (e.afterWindow) {
      pts.slice(inside.length).forEach((p) => {
        expect(p.Planned).toBe(e.afterWindow.Planned);
        expect(p.Actual).toBe(e.afterWindow.Actual);
        expect(p.Forecast).toBe(e.afterWindow.Forecast);
      });
      // and the walk really did continue past the window into the present
      expect(pts.length).toBeGreaterThan(inside.length);
    }
  });

  test('a negative entered forecast is used as is by the S-curve and ignored by the metrics', () => {
    const c = G.sCurve.find((x) => x.name.includes('NEGATIVE'));
    expect(c.expected.totalForecast).toBe(-50);
    const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
    expect(pts[pts.length - 1].Forecast).toBeLessThan(0);
    const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, []);
    expect(m.totalForecast).toBe(1200);
  });
});
