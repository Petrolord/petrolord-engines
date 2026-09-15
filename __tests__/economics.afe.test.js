/**
 * Gates for engines/economics/afe.js: the joint-venture partner split, the
 * AFE earned-value metrics and the S-curve.
 *
 *   (a) closed-form identities: conservation of the split, the EVM
 *       definitions, monotone cumulative curves;
 *   (b) agreement with every golden case in
 *       test-data/economics/goldens/afe_cases.json (independent stdlib oracle
 *       tools/validation/economics/oracle_afe.py), refusals included;
 *   (c) the Suite's src/utils/__tests__/costControlCalculations.test.js,
 *       ported (all 19 tests).
 *
 * Tolerances: money 1e-9 absolute (single-digit sums), ratios 1e-12; the
 * S-curve points are rounded integers and compare exactly.
 *
 * Clock. Since EC5-0 calculateMetrics and generateSCurveData take `asOf` and
 * read the clock only as its default. Golden cases that carry an asOf pass
 * it; the rest use windows wholly in the past or wholly in the future (valid
 * until 2080; the gate checks the calendar has not caught up). Every S-curve
 * golden pins the exact point list: the curve stops at the window's end.
 */
import fs from 'fs';
import path from 'path';
import {
  AfeInputError,
  calculatePartnerCosts,
  calculateMetrics,
  generateSCurveData,
  itemForecast,
  countUndatedInvoices,
} from '../engines/economics/afe.js';

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

/** The golden's asOf as the engine should receive it (undefined = the default). */
const asOfOf = (inputs) => {
  if (inputs.asOf === undefined) return undefined;
  return inputs.asOfAs === 'Date' ? new Date(inputs.asOf) : inputs.asOf;
};

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

  // EC5-0 contract.
  it('measures time progress as of the date passed, not the clock', () => {
    const afe = { start_date: '2026-01-01', end_date: '2027-12-31' };
    const items = [{ budget: 1000, actual: 300, progress: 40 }];
    const m = calculateMetrics(afe, items, [], new Date('2026-09-14'));
    expect(m.timeProgress).toBeCloseTo(256 / 729, 12);
    expect(m.plannedValue).toBeCloseTo(1000 * 256 / 729, 9);
    expect(m.spi).toBeCloseTo(400 / (1000 * 256 / 729), 12);
    expect(calculateMetrics(afe, items, [], '2026-09-14')).toEqual(m);
  });

  it('reports SPI as null before the start instead of Infinity', () => {
    const afe = { start_date: '2026-01-01', end_date: '2027-12-31' };
    const m = calculateMetrics(afe, [{ budget: 400, actual: 100, progress: 25 }], [], '2025-12-31');
    expect(m.plannedValue).toBe(0);
    expect(m.spi).toBeNull();
  });

  it('refuses an invalid asOf', () => {
    expect(() => calculateMetrics(AFE, [], [], new Date('x'))).toThrow(AfeInputError);
    expect(() => calculateMetrics(AFE, [], [], null)).toThrow('asOf is not a valid date');
    expect(() => calculateMetrics(AFE, [], [], 'soon')).toThrow('asOf is not a valid date');
  });

  it('refuses negative progress, naming the item', () => {
    const items = [{ code: 'X1', budget: 1000, actual: 100, progress: -20 }];
    expect(() => calculateMetrics(AFE, items, [])).toThrow(AfeInputError);
    expect(() => calculateMetrics(AFE, items, [])).toThrow(/"X1".*-20/);
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

  it('stops at the end of the window whatever the date', () => {
    expect(generateSCurveData(AFE, [{ budget: 1200 }], [])).toHaveLength(12);
    expect(generateSCurveData(AFE, [{ budget: 1200 }], [], '2099-01-01')).toHaveLength(12);
  });

  it('cuts actuals at asOf and projects the forecast after it', () => {
    const pts = generateSCurveData(AFE, [{ budget: 1200 }], [{ invoice_date: '2020-02-15', amount: 100 }], '2020-06-30');
    expect(pts[5].Actual).toBe(100);
    expect(pts[6].Actual).toBeNull();
    expect(pts[6].Forecast).toBeGreaterThan(0);
  });

  it('refuses an invalid asOf', () => {
    expect(() => generateSCurveData(AFE, [{ budget: 1 }], [], 'nope')).toThrow(AfeInputError);
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

  it('flags a negative working interest and still shows the allocation', () => {
    const out = calculatePartnerCosts(1000, [{ name: 'A', working_interest: 30 }, { name: 'B', working_interest: -20 }]);
    expect(out.valid).toBe(false);
    expect(out.note).toBe('Partner "B" has a negative working interest (-20.00 percent). Correct the interests before billing.');
    expect(out.partnerAllocations[1].shareAmount).toBeCloseTo(-200, 10);
    expect(out.operatorShare).toBeCloseTo(90, 10);
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
      const negative = c.inputs.partners.some((p) => Number.isFinite(Number(p.working_interest)) && Number(p.working_interest) < 0);
      expect(out.valid).toBe(out.operatorShare >= 0 && !negative);
      expect(out.note === null).toBe(out.valid);
      if (negative && out.operatorShare < 0) expect(out.note.indexOf('negative working interest')).toBeLessThan(out.note.indexOf('more than the whole'));
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
      const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));
      const floor = c.inputs.costItems.reduce((s, i) => {
        const f = Number(i.forecast) || 0;
        return s + (f > 0 ? f : Math.max(Number(i.budget) || 0, (Number(i.actual) || 0) + (Number(i.commitment) || 0)));
      }, 0);
      expect(m.totalForecast).toBeCloseTo(floor, 9);
    });
  });

  test('planned and forecast curves are monotone and capped, and actuals never decrease', () => {
    G.sCurve.forEach((c) => {
      const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));
      const bac = c.expected.totalBudget ?? 0;
      for (let i = 1; i < pts.length; i += 1) {
        expect(pts[i].Planned).toBeGreaterThanOrEqual(pts[i - 1].Planned);
        if (pts[i].Actual !== null && pts[i - 1].Actual !== null) expect(pts[i].Actual).toBeGreaterThanOrEqual(pts[i - 1].Actual);
      }
      pts.forEach((p) => expect(p.Planned).toBeLessThanOrEqual(Math.round(bac)));
    });
  });

  describe('the clock is not read when asOf is passed', () => {
    afterEach(() => jest.useRealTimers());

    const run = (today, withAsOf) => {
      jest.useFakeTimers({ now: new Date(today) });
      const afe = { start_date: '2026-01-01', end_date: '2027-12-31' };
      const items = [{ budget: 2400, actual: 900, commitment: 300, progress: 35 }];
      const invoices = [{ invoice_date: '2026-02-15', amount: 300 }, { invoice_date: '2026-08-20', amount: 600 }];
      const args = withAsOf ? [afe, items, invoices, '2026-09-14'] : [afe, items, invoices];
      const out = { metrics: calculateMetrics(...args), sCurve: generateSCurveData(...args) };
      jest.useRealTimers();
      return out;
    };

    test('two different todays give identical output with asOf', () => {
      expect(run('2026-03-01T08:00:00Z', true)).toEqual(run('2027-11-20T20:00:00Z', true));
    });

    test('negative control: the same two todays differ without asOf (the fake clock really moved)', () => {
      expect(run('2026-03-01T08:00:00Z', false)).not.toEqual(run('2027-11-20T20:00:00Z', false));
    });

    test('asOf equal to the fake today matches the default', () => {
      expect(run('2026-09-14T00:00:00Z', false)).toEqual(run('2026-09-14T00:00:00Z', true));
    });
  });

  test('the S-curve never extends past the end, whatever asOf', () => {
    const bucketsIn = (afe) => {
      const end = new Date(afe.end_date);
      let n = 0;
      for (const d = new Date(afe.start_date); d <= end; d.setMonth(d.getMonth() + 1)) n += 1;
      return n;
    };
    G.sCurve.filter((c) => c.expected.kind !== 'none').forEach((c) => {
      [undefined, '1990-01-01', '2026-09-14', '2200-01-01'].forEach((asOf) => {
        const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOf);
        expect(pts).toHaveLength(bucketsIn(c.inputs.afe));
      });
    });
  });

  test('metrics and S-curve share one forecast total: the last point of a bucket-aligned future window is the EAC', () => {
    const c = G.sCurve.find((x) => x.name.startsWith('future window ending on a bucket'));
    const eac = c.inputs.costItems.reduce((s, i) => s + itemForecast(i), 0);
    const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
    expect(pts[pts.length - 1].Forecast).toBe(Math.round(eac));
    expect(calculateMetrics(c.inputs.afe, c.inputs.costItems, []).totalForecast).toBe(eac);
    expect(eac).toBe(1500 + 650 + 300);
  });

  test('itemForecast: positive entered forecast, else max(budget, actual + commitment)', () => {
    expect(itemForecast({ budget: 100, forecast: 140 })).toBe(140);
    expect(itemForecast({ budget: 100, forecast: -50, actual: 20 })).toBe(100);
    expect(itemForecast({ budget: 100, forecast: 'abc', actual: 70, commitment: 60 })).toBe(130);
    expect(itemForecast({ budget: '', forecast: 0 })).toBe(0);
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
  const KEYS = ['totalBudget', 'totalCommitments', 'totalActuals', 'totalForecast', 'variance', 'earnedValue', 'plannedValue', 'timeProgress', 'cpi', 'percentSpent', 'percentComplete'];

  test.each(G.metrics.map((c) => [c.name, c]))('%s', (_n, c) => {
    const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));
    const e = c.expected;
    KEYS.forEach((k) => expectNum(m[k], e[k], k === 'cpi' || k === 'timeProgress' ? RATIO : MONEY));
    if (e.spi === null) expect(m.spi).toBeNull();
    else expectNum(m.spi, e.spi, RATIO);
    // The standard EVM set the oracle carries: the module's fields must map
    // onto it exactly where the module reports them.
    const s = e.standardEvm;
    expectNum(m.totalBudget, s.bac, MONEY);
    expectNum(m.earnedValue, s.ev, MONEY);
    expectNum(m.totalActuals, s.ac, MONEY);
    expectNum(m.totalForecast, s.eac, MONEY);
    expectNum(m.variance, s.vac, MONEY);
    if (s.cpi !== null && m.totalActuals > 0) expectNum(m.cpi, s.cpi, RATIO);
    expectNum(m.plannedValue, s.pv, MONEY);
    if (s.spi !== null && m.totalBudget > 0) expectNum(m.spi, s.spi, RATIO);
    if (s.spi === null && m.totalBudget > 0) expect(m.spi).toBeNull();
    if (c.note) expect(c.note).not.toMatch(/DISAGREEMENT/);
  });
});

describe('golden: metrics refusals', () => {
  test.each(G.metricsRefusals.map((c) => [c.name, c]))('%s', (_n, c) => {
    const call = () => calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, c.inputs.asOf);
    expect(call).toThrow(AfeInputError);
    let err;
    try { call(); } catch (x) { err = x; }
    expect(err.name).toBe(c.expected.error);
    expect(err.message).toBe(c.expected.message);
  });
});

describe('golden: S-curve', () => {
  test.each(G.sCurve.map((c) => [c.name, c]))('%s', (_n, c) => {
    const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));
    expect(pts).toHaveLength(c.expected.points.length);
    expect(pts).toEqual(c.expected.points);
  });

  test('a negative entered forecast is ignored by the S-curve and the metrics alike', () => {
    const c = G.sCurve.find((x) => x.name.includes('NEGATIVE'));
    expect(c.expected.totalForecast).toBe(1200);
    const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
    pts.forEach((p) => expect(p.Forecast).toBeGreaterThanOrEqual(0));
    const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, []);
    expect(m.totalForecast).toBe(1200);
  });
});


describe('EC6-1: an invoice with no date is not on the curve', () => {
  // FINDINGS-fdp.md section 8, resolved. A NULL invoice date was
  // `new Date(null)`, the first of January 1970, so an undated invoice
  // counted in every bucket of every AFE from the first one.
  const afe = { start_date: '2020-01-01', end_date: '2020-12-31', currency: 'USD' };
  const items = [{ budget: 1200 }];
  const invoices = [{ amount: 100 }, { invoice_date: null, amount: 200 }];

  test('it is excluded, not counted from 1970', () => {
    const points = generateSCurveData(afe, items, invoices, '2020-12-31');
    expect(points.every((p) => p.Actual === 0)).toBe(true);
  });

  test('and the app is told how many were set aside', () => {
    expect(countUndatedInvoices(invoices)).toBe(2);
    expect(calculateMetrics(afe, items, invoices, '2020-12-31').undatedInvoices).toBe(2);
    expect(countUndatedInvoices([{ invoice_date: '2020-02-15', amount: 1 }])).toBe(0);
    expect(countUndatedInvoices([{ invoice_date: 'last Tuesday', amount: 1 }])).toBe(1);
  });

  test('a dated invoice is placed exactly where it always was', () => {
    const dated = [{ invoice_date: '2020-06-15', amount: 250 }];
    const points = generateSCurveData(afe, items, dated, '2020-12-31');
    const june = points.findIndex((p) => p.date === 'Jun 20');
    expect(points[june].Actual).toBe(0);
    expect(points[june + 1].Actual).toBe(250);
    expect(calculateMetrics(afe, items, dated, '2020-12-31').undatedInvoices).toBe(0);
  });
});
