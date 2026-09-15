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
 *
 * EC5-1, the negative-forecast flag and EC5-9b (owner decisions 2026-09-15).
 * A positive entered forecast below actual + commitment is kept and the line
 * is flagged (forecastBelowCommitted, forecastBelowCommittedBy); a negative
 * entered forecast is flagged forecastIgnored 'negative'; the metrics count
 * both. The S-curve closes on the window end date, Planned the budget and
 * Forecast the EAC. Negative controls: the retired silent forecast and the
 * retired walk with no closing point, restated here.
 *
 * EC5-3, EC5-5, EC5-8 and the CPI item (owner decisions 2026-09-15). CPI and
 * SPI are null wherever the ratio is undefined, with cpiStatus / spiStatus
 * naming why; progress above 100 percent is refused; the S-curve is UTC
 * throughout, and the zone sweep replays it in child processes under five TZ
 * values. Each retired rule has a negative control: restated here, it must
 * disagree with the golden it was retired by.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  AfeInputError,
  calculatePartnerCosts,
  calculateMetrics,
  generateSCurveData,
  itemForecast,
  itemForecastCheck,
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

  it('does not divide by zero on an empty or unspent AFE: the undefined ratios are null, with the reason', () => {
    // EC5-3 and the CPI item: this test used to expect CPI 1 and SPI 1.
    const empty = calculateMetrics(AFE, [], []);
    expect(empty.totalBudget).toBe(0);
    expect(empty.cpi).toBeNull();
    expect(empty.cpiStatus).toBe('no-spend');
    expect(empty.spi).toBeNull();
    expect(empty.spiStatus).toBe('no-budget');
    expect(empty.percentSpent).toBe(0);
    expect(Number.isFinite(empty.percentComplete)).toBe(true);
  });

  it('treats missing numbers as zero rather than producing NaN', () => {
    const items = [{ budget: null, commitment: undefined, actual: '', progress: 'x' }];
    const m = calculateMetrics(AFE, items, []);
    const {
      cpi, spi, cpiStatus, spiStatus, lineForecasts, ...numbers
    } = m;
    Object.values(numbers).forEach((v) => expect(Number.isFinite(v)).toBe(true));
    expect([cpi, spi, cpiStatus, spiStatus]).toEqual([null, null, 'no-spend', 'no-budget']);
    // The line carries its own numbers and its flags, all of them readable.
    expect(lineForecasts).toEqual([{
      index: 0, label: 0, forecast: 0, committed: 0,
      forecastBelowCommitted: false, forecastBelowCommittedBy: 0, forecastIgnored: null,
    }]);
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

  it('refuses progress above 100 percent, naming the item (EC5-8)', () => {
    const items = [{ code: 'X2', budget: 100, actual: 90, progress: 150 }];
    expect(() => calculateMetrics(AFE, items, [])).toThrow(AfeInputError);
    expect(() => calculateMetrics(AFE, items, [])).toThrow('Cost item "X2" has progress above 100 percent (150 percent). Progress runs from 0 to 100 percent.');
    expect(calculateMetrics(AFE, [{ code: 'X3', budget: 100, progress: 100 }], []).earnedValue).toBe(100);
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
    // EC5-9b: the closing point is the whole budget, on the end date.
    expect(points[points.length - 1].Planned).toBe(1200);
    expect(points[points.length - 1].date).toBe('31 Dec 20');
    expect(points[points.length - 1].windowEnd).toBe(true);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].Planned).toBeGreaterThanOrEqual(points[i - 1].Planned);
    }
  });

  it('stops at the end of the window whatever the date', () => {
    // Twelve monthly buckets and the EC5-9b closing point.
    expect(generateSCurveData(AFE, [{ budget: 1200 }], [])).toHaveLength(13);
    expect(generateSCurveData(AFE, [{ budget: 1200 }], [], '2099-01-01')).toHaveLength(13);
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
    // The monthly buckets, plus the EC5-9b closing point unless a bucket
    // already lands on the end date, where it takes that bucket's place.
    const pointsIn = (afe) => {
      const end = new Date(afe.end_date);
      let n = 0;
      let last = null;
      for (const d = new Date(afe.start_date); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
        n += 1;
        last = new Date(d.getTime());
      }
      if (n === 0) return 0;
      return last.getTime() === end.getTime() ? n : n + 1;
    };
    G.sCurve.filter((c) => c.expected.kind !== 'none').forEach((c) => {
      [undefined, '1990-01-01', '2026-09-14', '2200-01-01'].forEach((asOf) => {
        const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOf);
        expect(pts).toHaveLength(pointsIn(c.inputs.afe));
        if (pts.length > 0) {
          expect(pts[pts.length - 1].windowEnd).toBe(true);
          expect(pts.slice(0, -1).every((q) => q.windowEnd === false)).toBe(true);
        }
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

  test('every curve closes on the budget and the EAC (EC5-9b)', () => {
    G.sCurve.filter((c) => c.expected.kind !== 'none').forEach((c) => {
      const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));
      if (pts.length === 0) return;
      const last = pts[pts.length - 1];
      expect(last.Planned).toBe(Math.round(c.expected.totalBudget));
      expect(last.Forecast).toBe(Math.round(c.expected.totalForecast));
      expect(last.windowEnd).toBe(true);
    });
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
  const LINE_KEYS = ['index', 'label', 'committed', 'forecastBelowCommitted', 'forecastBelowCommittedBy', 'forecastIgnored'];
  const KEYS = ['totalBudget', 'totalCommitments', 'totalActuals', 'totalForecast', 'variance', 'earnedValue', 'plannedValue', 'timeProgress', 'cpi', 'percentSpent', 'percentComplete'];

  test.each(G.metrics.map((c) => [c.name, c]))('%s', (_n, c) => {
    const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));
    const e = c.expected;
    KEYS.filter((k) => k !== 'cpi').forEach((k) => expectNum(m[k], e[k], k === 'timeProgress' ? RATIO : MONEY));
    // EC5-3 and the CPI item: an undefined ratio is null exactly, with its reason.
    if (e.cpi === null) expect(m.cpi).toBeNull();
    else expectNum(m.cpi, e.cpi, RATIO);
    if (e.spi === null) expect(m.spi).toBeNull();
    else expectNum(m.spi, e.spi, RATIO);
    expect(m.cpiStatus).toBe(e.cpiStatus);
    expect(m.spiStatus).toBe(e.spiStatus);
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
    // EC5-1 and the negative-forecast flag: the line list and the counts.
    expect(m.lineForecasts).toHaveLength(e.lineForecasts.length);
    m.lineForecasts.forEach((line, i) => {
      const g = e.lineForecasts[i];
      LINE_KEYS.forEach((k) => expect(line[k]).toEqual(g[k]));
      expectNum(line.forecast, g.forecast, MONEY);
    });
    expect(m.linesForecastBelowCommitted).toBe(e.linesForecastBelowCommitted);
    expect(m.linesForecastIgnored).toBe(e.linesForecastIgnored);
    expect(m.totalForecast).toBeCloseTo(m.lineForecasts.reduce((t, l) => t + l.forecast, 0), 9);
    if (c.note) expect(c.note).not.toMatch(/DISAGREEMENT/);
  });
});

// ---------------------------------------------------------------------------
// EC5-1 and the negative-forecast flag: the line says what the number is worth.
// ---------------------------------------------------------------------------

describe('EC5-1: a forecast below the money spent and committed is kept and flagged', () => {
  const golden = G.metrics.find((c) => c.name.startsWith('EC5-1: a forecast below'));

  test('the typed value is still the EAC: no silent floor', () => {
    const m = calculateMetrics(golden.inputs.afe, golden.inputs.costItems, [], asOfOf(golden.inputs));
    expect(m.lineForecasts[0].forecast).toBe(850);
    expect(m.lineForecasts[0].forecastBelowCommitted).toBe(true);
    expect(m.lineForecasts[0].forecastBelowCommittedBy).toBe(50);
    expect(m.lineForecasts[0].label).toBe('RIG');
    expect(m.lineForecasts[1].forecastBelowCommitted).toBe(false);
    expect(m.linesForecastBelowCommitted).toBe(1);
    expect(m.totalForecast).toBe(850 + 400);
  });

  test('equal to committed is not below it, and the flag is off above it', () => {
    expect(itemForecastCheck({ budget: 500, actual: 300, commitment: 100, forecast: 400 }).forecastBelowCommitted).toBe(false);
    expect(itemForecastCheck({ budget: 500, actual: 300, commitment: 100, forecast: 401 }).forecastBelowCommitted).toBe(false);
    expect(itemForecastCheck({ budget: 500, actual: 300, commitment: 100, forecast: 399 })).toMatchObject({
      forecast: 399, committed: 400, forecastBelowCommitted: true, forecastBelowCommittedBy: 1,
    });
  });

  test('a fallback EAC is never below committed, so it is never flagged', () => {
    G.metrics.forEach((c) => {
      const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));
      m.lineForecasts.forEach((line, i) => {
        const entered = Number(c.inputs.costItems[i].forecast) || 0;
        if (!(entered > 0)) expect(line.forecastBelowCommitted).toBe(false);
        if (line.forecastBelowCommitted) expect(line.forecast).toBeLessThan(line.committed);
      });
    });
  });

  test('negative control: the retired rule reported the same EAC with nothing to read', () => {
    const retired = (item) => {
      const entered = Number(item.forecast) || 0;
      if (entered > 0) return entered;
      return Math.max(Number(item.budget) || 0, (Number(item.actual) || 0) + (Number(item.commitment) || 0));
    };
    let flagged = 0;
    G.metrics.forEach((c) => {
      c.inputs.costItems.forEach((item) => {
        expect(itemForecast(item)).toBe(retired(item));
        if (itemForecastCheck(item).forecastBelowCommitted) flagged += 1;
      });
    });
    // The EAC is unchanged; what is new is that the flagged lines are named.
    expect(flagged).toBeGreaterThan(0);
  });
});

describe('a negative entered forecast is flagged instead of ignored silently', () => {
  const golden = G.metrics.find((c) => c.name.startsWith('negative forecast flag'));

  test('the flag names the reason and the EAC still comes from the standard rule', () => {
    const m = calculateMetrics(golden.inputs.afe, golden.inputs.costItems, [], asOfOf(golden.inputs));
    expect(m.lineForecasts.map((l) => l.forecastIgnored)).toEqual(['negative', null, null, null, 'negative', null]);
    expect(m.lineForecasts[0].forecast).toBe(100);
    expect(m.lineForecasts[4].forecast).toBe(130);
    expect(m.linesForecastIgnored).toBe(2);
    expect(m.linesForecastBelowCommitted).toBe(1);
  });

  test('a zero, blank or non-numeric forecast is no forecast, not an ignored one', () => {
    expect(itemForecastCheck({ budget: 100, forecast: 0 }).forecastIgnored).toBeNull();
    expect(itemForecastCheck({ budget: 100, forecast: '' }).forecastIgnored).toBeNull();
    expect(itemForecastCheck({ budget: 100, forecast: 'abc' }).forecastIgnored).toBeNull();
    expect(itemForecastCheck({ budget: 100, forecast: -0.5 }).forecastIgnored).toBe('negative');
  });

  test('negative control: the retired rule dropped a negative forecast with no count at all', () => {
    const items = golden.inputs.costItems;
    const retiredIgnored = items.filter((i) => (Number(i.forecast) || 0) < 0).length;
    expect(retiredIgnored).toBe(2);
    const m = calculateMetrics(golden.inputs.afe, items, [], asOfOf(golden.inputs));
    expect(m.linesForecastIgnored).toBe(retiredIgnored);
    expect(Object.keys(m)).toContain('linesForecastIgnored');
  });
});

// ---------------------------------------------------------------------------
// EC5-9b: the curve closes on the window end.
// ---------------------------------------------------------------------------

describe('EC5-9b: the S-curve closes on the budget and the EAC', () => {
  const golden = G.sCurve.find((c) => c.name.startsWith('EC5-9b: OFON-1 at 2027-08-15'));
  const run = () => generateSCurveData(golden.inputs.afe, golden.inputs.costItems, golden.inputs.invoices, golden.inputs.asOf);

  test('OFON-1 draws its overrun as an overrun', () => {
    const pts = run();
    const last = pts[pts.length - 1];
    expect(last.date).toBe('30 Nov 27');
    expect(last.Planned).toBe(27050000);
    expect(last.Forecast).toBe(27600000);
    expect(last.Forecast).toBeGreaterThan(last.Planned);
    expect(last.windowEnd).toBe(true);
  });

  test('negative control: the retired walk ended below both', () => {
    // The point the walk used to end on, carried by the oracle.
    const retiredLast = golden.expected.retiredLastPoint;
    expect(retiredLast.date).toBe('Nov 27');
    expect(retiredLast.Forecast).toBe(24949669);
    expect(retiredLast.Planned).toBe(24452483);
    expect(retiredLast.Forecast).toBeLessThan(27050000);
    const pts = run();
    expect(pts[pts.length - 2]).toEqual({ ...retiredLast, windowEnd: false });
  });

  test('a monthly step on the end date is replaced, so no date is listed twice', () => {
    const c = G.sCurve.find((x) => x.name.startsWith('EC5-9b: a window ending on a month step'));
    const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, c.inputs.asOf);
    const dates = pts.map((q) => q.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates[dates.length - 1]).toBe('1 May 26');
    expect(dates).not.toContain('May 26');
  });

  test('the closing Actual follows the bucket rule: the invoices up to the end when the end is read', () => {
    const c = G.sCurve.find((x) => x.name.startsWith('EC5-9b: asOf on the end day'));
    const pts = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, c.inputs.asOf);
    expect(pts[pts.length - 1].Actual).toBe(750);
    // Read before the end, the closing point has no actual at all.
    const early = generateSCurveData(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, '2026-03-02');
    expect(early[early.length - 1].Actual).toBeNull();
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

// ---------------------------------------------------------------------------
// EC5-3 and the CPI item: one null rule for an undefined ratio.
// ---------------------------------------------------------------------------

describe('EC5-3 and CPI: an undefined ratio is null, with the reason named', () => {
  const byName = (prefix) => {
    const c = G.metrics.find((x) => x.name.startsWith(prefix));
    if (!c) throw new Error(`no golden named ${prefix}`);
    return c;
  };
  const run = (c) => calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs));

  test('the statuses are exactly the four the contract names, and a null ratio never says ok', () => {
    G.metrics.forEach((c) => {
      const m = run(c);
      expect(['ok', 'no-spend']).toContain(m.cpiStatus);
      expect(['ok', 'no-budget', 'no-planned-value']).toContain(m.spiStatus);
      expect(m.cpi === null).toBe(m.cpiStatus !== 'ok');
      expect(m.spi === null).toBe(m.spiStatus !== 'ok');
    });
  });

  test('the golden set exercises every status', () => {
    const seen = new Set(G.metrics.flatMap((c) => [`cpi:${c.expected.cpiStatus}`, `spi:${c.expected.spiStatus}`]));
    ['cpi:ok', 'cpi:no-spend', 'spi:ok', 'spi:no-budget', 'spi:no-planned-value'].forEach((s) => expect(seen.has(s)).toBe(true));
  });

  test('the empty AFE and the budgeted AFE with no planned value now agree: both SPI null', () => {
    const empty = run(byName('suite test: empty AFE'));
    const notStarted = run(byName('future window with progress'));
    expect([empty.spi, empty.spiStatus]).toEqual([null, 'no-budget']);
    expect([notStarted.spi, notStarted.spiStatus]).toEqual([null, 'no-planned-value']);
  });

  test('value earned with nothing spent: CPI null, not 1', () => {
    const m = run(byName('value earned with no spend'));
    expect(m.earnedValue).toBe(400);
    expect(m.totalActuals).toBe(0);
    expect([m.cpi, m.cpiStatus]).toEqual([null, 'no-spend']);
  });

  // Negative controls: the retired rules, restated, disagree with the goldens.
  const retiredCpi = (m) => (m.totalActuals > 0 ? m.earnedValue / m.totalActuals : 1.0);
  const retiredSpi = (m) => {
    if (!(m.totalBudget > 0)) return 1.0;
    return m.plannedValue > 0 ? m.earnedValue / m.plannedValue : null;
  };

  test('negative control: the retired CPI rule (1 when nothing is spent) fails the no-spend goldens', () => {
    const noSpend = G.metrics.filter((c) => c.expected.cpiStatus === 'no-spend');
    expect(noSpend.length).toBeGreaterThanOrEqual(5);
    noSpend.forEach((c) => expect(retiredCpi(run(c))).not.toBe(c.expected.cpi));
    // and it agrees wherever the ratio is defined, so the control isolates the rule
    G.metrics.filter((c) => c.expected.cpiStatus === 'ok')
      .forEach((c) => expectNum(retiredCpi(run(c)), c.expected.cpi, RATIO));
  });

  test('negative control: the retired zero-budget guard (SPI 1) fails the no-budget goldens', () => {
    const noBudget = G.metrics.filter((c) => c.expected.spiStatus === 'no-budget');
    expect(noBudget.length).toBeGreaterThanOrEqual(4);
    noBudget.forEach((c) => {
      expect(retiredSpi(run(c))).toBe(1);
      expect(c.expected.spi).toBeNull();
    });
    G.metrics.filter((c) => c.expected.spiStatus !== 'no-budget').forEach((c) => {
      const r = retiredSpi(run(c));
      if (c.expected.spi === null) expect(r).toBeNull();
      else expectNum(r, c.expected.spi, RATIO);
    });
  });
});

// ---------------------------------------------------------------------------
// EC5-8: progress above 100 percent is refused.
// ---------------------------------------------------------------------------

describe('EC5-8: progress above 100 percent is refused', () => {
  // The retired check: the message for the first NEGATIVE item, else no refusal.
  const retiredRefusal = (items) => {
    const k = items.findIndex((i) => Number.isFinite(Number(i.progress)) && Number(i.progress) < 0);
    if (k < 0) return false;
    const i = items[k];
    return `Cost item "${i.code ?? i.description ?? k}" has negative progress (${Number(i.progress)} percent). Progress runs from 0 to 100 percent.`;
  };

  test('the former golden "progress beyond 100 percent earns beyond the budget" is now a refusal', () => {
    expect(G.metrics.some((c) => /beyond 100/.test(c.name))).toBe(false);
    const c = G.metricsRefusals.find((x) => x.name === 'progress beyond 100 percent is refused');
    expect(c.expected.message).toBe('Cost item "0" has progress above 100 percent (150 percent). Progress runs from 0 to 100 percent.');
    expect(() => calculateMetrics(c.inputs.afe, c.inputs.costItems, [], c.inputs.asOf)).toThrow(c.expected.message);
  });

  test('negative control: the retired rule (only negative progress refused) lets every over-100 golden through', () => {
    const over = G.metricsRefusals.filter((c) => /above 100 percent/.test(c.expected.message));
    expect(over.length).toBeGreaterThanOrEqual(4);
    over.forEach((c) => expect(retiredRefusal(c.inputs.costItems)).not.toBe(c.expected.message));
    expect(over.filter((c) => retiredRefusal(c.inputs.costItems) === false).length).toBeGreaterThanOrEqual(3);
  });

  test('exactly 100 percent is accepted', () => {
    const c = G.metrics.find((x) => x.name.startsWith('progress of exactly 100 percent'));
    const m = calculateMetrics(c.inputs.afe, c.inputs.costItems, c.inputs.invoices);
    expect(m.percentComplete).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// EC5-5: the S-curve is the same in every time zone.
// ---------------------------------------------------------------------------

describe('EC5-5: the S-curve is identical under five TZ values', () => {
  // Each zone runs in its own node process, because TZ is read once at
  // process start. The child imports the engine directly (plain ES modules).
  const ZONES = {
    UTC: 0, 'America/Los_Angeles': 480, 'Africa/Lagos': -60, 'Asia/Tokyo': -540, 'Pacific/Kiritimati': -840,
  };
  const url = (rel) => `file://${path.join(__dirname, '..', rel)}`;
  const goldenPath = path.join(__dirname, '../test-data/economics/goldens/afe_cases.json');

  // Probes beyond the goldens: the input forms whose parsing depends on the zone.
  const PROBES = [
    { name: 'date-time strings with no zone', afe: { start_date: '2027-02-01T00:00:00', end_date: '2028-01-31T00:00:00' }, items: [{ budget: 3650 }], invoices: [{ invoice_date: '2027-03-01T00:00:00', amount: 10 }], asOf: '2027-06-01T12:00:00' },
    { name: 'a Date asOf', afe: { start_date: '2027-02-01', end_date: '2028-01-31' }, items: [{ budget: 3650 }], invoices: [], asOfIso: '2027-06-01T00:00:00Z' },
    { name: 'an asOf with an offset', afe: { start_date: '2027-02-01', end_date: '2028-01-31' }, items: [{ budget: 3650 }], invoices: [{ invoice_date: '2027-06-01', amount: 5 }], asOf: '2027-06-01T00:30:00+01:00' },
    { name: 'a non-ISO window', afe: { start_date: 'February 1, 2027', end_date: 'January 31, 2028' }, items: [{ budget: 1200 }], invoices: [], asOf: '2027-09-01' },
    { name: 'autumn clock change inside the window', afe: { start_date: '2026-06-01', end_date: '2026-12-01' }, items: [{ budget: 1830 }], invoices: [{ invoice_date: '2026-10-31', amount: 70 }], asOf: '2026-12-01' },
    { name: 'a date-only asOf on the first bucket', afe: { start_date: '2027-02-01', end_date: '2027-06-30' }, items: [{ budget: 500 }], invoices: [{ invoice_date: '2027-02-01', amount: 50 }], asOf: '2027-02-01' },
  ];

  const CHILD = `
    import fs from 'fs';
    import { generateSCurveData } from ${JSON.stringify(url('engines/economics/afe.js'))};
    import { differenceInDays, parseISO, isValid } from ${JSON.stringify(url('lib/dates/dates.js'))};
    const G = JSON.parse(fs.readFileSync(${JSON.stringify(goldenPath)}, 'utf8'));
    const PROBES = ${JSON.stringify(PROBES)};
    const asOfOf = (i) => (i.asOfIso ? new Date(i.asOfIso) : (i.asOfAs === 'Date' ? new Date(i.asOf) : i.asOf));
    // The RETIRED walk (main before EC5-5), restated as the negative control:
    // local setMonth, local label, local differenceInDays, parseISO asOf.
    const retired = (afe, costItems, invoices, asOf = new Date()) => {
      const now = asOf instanceof Date ? asOf : parseISO(asOf);
      if (!isValid(now)) throw new Error('asOf');
      if (!afe?.start_date || !afe?.end_date) return [];
      const start = new Date(afe.start_date); const end = new Date(afe.end_date);
      const fc = (i) => { const f = Number(i.forecast) || 0; return f > 0 ? f : Math.max(Number(i.budget) || 0, (Number(i.actual) || 0) + (Number(i.commitment) || 0)); };
      const bac = costItems.reduce((s, i) => s + (Number(i.budget) || 0), 0);
      const eac = costItems.reduce((s, i) => s + fc(i), 0);
      const dated = (inv) => { const r = inv?.invoice_date; if (r == null || r === '') return null; const d = new Date(r); return Number.isNaN(d.getTime()) ? null : d; };
      const sorted = invoices.filter((v) => dated(v) !== null);
      const pts = []; const cur = new Date(start);
      let a = 0; let p = 0; let f = 0; let last = null;
      const days = differenceInDays(end, start);
      while (cur <= end) {
        const label = cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        if (cur <= now) a = sorted.filter((v) => dated(v) <= cur).reduce((s, v) => s + Number(v.amount), 0);
        const el = differenceInDays(cur, start);
        if (el >= 0) { p = Math.min(bac, el * bac / Math.max(days, 1)); f = cur <= now ? a : Math.min(eac, el * eac / Math.max(days, 1)); }
        pts.push({ date: label, Planned: Math.round(p), Actual: cur <= now ? Math.round(a) : null, Forecast: Math.round(f), windowEnd: false });
        last = new Date(cur);
        cur.setMonth(cur.getMonth() + 1);
      }
      if (pts.length === 0) return pts;
      // EC5-9b, restated locally: the closing point at the window end.
      if (last.getTime() === end.getTime()) pts.pop();
      const endActual = sorted.filter((v) => dated(v) <= end).reduce((s, v) => s + Number(v.amount), 0);
      pts.push({ date: end.getDate() + ' ' + end.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), Planned: Math.round(bac), Actual: end <= now ? Math.round(endActual) : null, Forecast: Math.round(eac), windowEnd: true });
      return pts;
    };
    const both = (afe, items, invs, asOf) => ({
      engine: generateSCurveData(afe, items, invs, asOf),
      retired: retired(afe, items, invs, asOf),
    });
    const out = {
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      januaryOffset: new Date(2027, 0, 1).getTimezoneOffset(),
      goldens: G.sCurve.map((c) => ({ name: c.name, ...both(c.inputs.afe, c.inputs.costItems, c.inputs.invoices, asOfOf(c.inputs)) })),
      probes: PROBES.map((q) => ({ name: q.name, ...both(q.afe, q.items, q.invoices, asOfOf(q)) })),
    };
    process.stdout.write(JSON.stringify(out));
  `;

  const runs = {};
  beforeAll(() => {
    Object.keys(ZONES).forEach((tz) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
        env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 60000,
      });
      if (r.status !== 0) throw new Error(`child under TZ=${tz} failed: ${r.stderr}`);
      runs[tz] = JSON.parse(r.stdout);
    });
  });

  test('each child really ran in its zone (a missing tzdata would silently give UTC)', () => {
    Object.entries(ZONES).forEach(([tz, offset]) => {
      expect(runs[tz].zone).toBe(tz);
      expect(runs[tz].januaryOffset).toBe(offset);
    });
  });

  test('the UTC child reproduces every S-curve golden (the UTC output is unchanged)', () => {
    runs.UTC.goldens.forEach((g, i) => expect(g.engine).toEqual(G.sCurve[i].expected.points));
  });

  test('the retired walk agrees with the engine in UTC, on every golden and probe', () => {
    [...runs.UTC.goldens, ...runs.UTC.probes].forEach((g) => expect(g.retired).toEqual(g.engine));
  });

  test.each(Object.keys(ZONES).filter((z) => z !== 'UTC'))('TZ=%s draws exactly the UTC curve for every golden and probe', (tz) => {
    runs[tz].goldens.forEach((g, i) => expect({ name: g.name, points: g.engine }).toEqual({ name: runs.UTC.goldens[i].name, points: runs.UTC.goldens[i].engine }));
    runs[tz].probes.forEach((g, i) => expect({ name: g.name, points: g.engine }).toEqual({ name: runs.UTC.probes[i].name, points: runs.UTC.probes[i].engine }));
  });

  test('a February start is labelled Feb 27 in every zone', () => {
    const i = G.sCurve.findIndex((c) => c.name.startsWith('February start'));
    Object.keys(ZONES).forEach((tz) => expect(runs[tz].goldens[i].engine[0].date).toBe('Feb 27'));
  });

  test('negative control: the retired walk differs from UTC in Los Angeles (Jan 27) and in Tokyo', () => {
    const i = G.sCurve.findIndex((c) => c.name.startsWith('February start'));
    const la = runs['America/Los_Angeles'].goldens[i].retired;
    expect(la[0].date).toBe('Jan 27');
    expect(la).not.toEqual(runs.UTC.goldens[i].retired);
    const differsIn = (tz) => runs[tz].goldens.filter((g, k) => JSON.stringify(g.retired) !== JSON.stringify(runs.UTC.goldens[k].retired)).length;
    expect(differsIn('America/Los_Angeles')).toBeGreaterThan(10);
    expect(differsIn('Asia/Tokyo')).toBeGreaterThan(0);
  });
});
