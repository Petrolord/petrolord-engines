// Screening economics gates (engines/economics/screening.js, the Suite's
// npvCalculations.js, EC0 extraction 2026-09-08).
//
// Three layers: (a) closed-form identities the ledger must satisfy exactly,
// (b) agreement with the independent stdlib oracle
// (tools/validation/economics/oracle_screening.py) through its committed
// goldens, and (c) every test the Suite already had for the module
// (src/utils/__tests__/npvCalculations.test.js and the FDP economics tests
// that call calculateEconomics directly), ported verbatim with the imports
// repointed.
//
// The oracle reaches every number by a different road: closed-form decline
// profiles, IRR by a fine scan and bisection of every sign change where the
// engine runs clamped Newton, and runMonteCarlo replayed with a bit-for-bit
// mulberry32 stream in place of Math.random. Where the two disagree the
// golden carries the engine's number under `engine` and the gate pins BOTH.
//
// Tolerances (absolute): money $MM 1e-6, NPV 1e-6, IRR 1e-4 percentage
// points, payback 1e-9 years, volumes 1e-6 bbl.

import fs from 'fs';
import path from 'path';
import {
  calculateEconomics, runSensitivityAnalysis, generateScenarios, runMonteCarlo, DEFAULT_MC_SEED,
  expandQuickInputs, getPortfolioMetrics,
} from '../engines/economics/screening.js';
import { mulberry32, quantile } from '../lib/stats/stats.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'screening_cases.json'),
  'utf8',
));

const MONEY = 1e-6;
const IRR = 1e-4;
const PAYBACK = 1e-9;

const flat = (v, n) => new Array(n).fill(v);

const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

const ROW_FIELDS = ['grossRevenue', 'royalty', 'capex', 'opex', 'abex', 'tax', 'depreciation',
  'pscUnrecoveredCost', 'ncf', 'cumulativeNCF', 'govTake'];

/** Gate one engine result against one golden expectation. */
const gateResult = (res, exp, engine) => {
  expect(res.cashflow).toHaveLength(exp.cashflow.length);
  res.cashflow.forEach((row, i) => {
    const e = exp.cashflow[i];
    if (e.year !== null) expect(row.year).toBe(e.year);
    ROW_FIELDS.forEach((f) => near(row[f], e[f], MONEY));
  });
  const m = res.metrics;
  const em = exp.metrics;
  near(m.npv, em.npv, MONEY);
  ['totalRevenue', 'totalCapex', 'totalOpex', 'totalTax', 'totalRoyalty', 'totalGovTake']
    .forEach((f) => near(m[f], em[f], MONEY));
  // EC3-1 / EC3-2: the first crossing, the last, and what happened between.
  expect(m.paybackStatus).toBe(em.paybackStatus);
  if (em.payback === null) expect(m.payback).toBeNull(); else near(m.payback, em.payback, PAYBACK);
  if (em.paybackLast === null) expect(m.paybackLast).toBeNull(); else near(m.paybackLast, em.paybackLast, PAYBACK);
  if (em.maxExposure !== null) near(m.maxExposure, em.maxExposure, MONEY);
  // EC6-1: the internal rate of return, and the reason when there is none.
  // There are no recorded IRR disagreements left; the engine agrees with
  // the oracle case by case, including on which cases have no answer.
  expect(m.irrStatus).toBe(em.irrStatus);
  if (em.irr === null) {
    expect(m.irr).toBeNull();
  } else {
    near(m.irr, em.irr, IRR);
  }
  if (em.irrStatus === 'multiple-roots') {
    // Every root the oracle found INSIDE the band, reported rather than one
    // of them picked. The oracle's irrRoots also lists roots above the band.
    const inBand = em.irrRoots.filter((r) => r > -99 && r < 1000);
    expect(m.irrRoots).toHaveLength(inBand.length);
    m.irrRoots.forEach((r, i) => near(r, inBand[i], IRR));
  } else {
    expect(m.irrRoots).toBeNull();
  }
  // A root above the band (lead decision 2026-09-15), on every result.
  expect(m.irrRootAboveBand).toBe(em.irrRootAboveBand);
};

// ---------------------------------------------------------------------
// (c) The Suite's own tests, ported.
// ---------------------------------------------------------------------

describe('calculateEconomics TaxRoyalty (hand-derived, mid-year discounting)', () => {
  // $100 oil, 1 MMbbl/yr for 2 years, royalty 20%, tax 50%,
  // capex $50MM year 1, opex $10MM/yr, immediate expensing.
  // Year 1: royalty 20, taxable = 80 - 10 - 50 = 20, tax 10, ncf = 80-60-10 = +10
  // Year 2: taxable = 80 - 10 = 70, tax 35, ncf = 80-10-35 = +35
  // NPV(10%, mid-year) = 10/1.1^0.5 + 35/1.1^1.5
  const inputs = {
    startYear: 2030, projectLife: 2, discountRate: 10, fiscalType: 'TaxRoyalty',
    production: { oil: [1_000_000, 1_000_000], gas: [0, 0] },
    price: { oil: [100, 100], gas: [0, 0] },
    capex: [50, 0], opexFixed: [10, 10], opexVariable: [0, 0], abandonment: [0, 0],
    royaltyRate: 20, taxRate: 50,
  };

  it('matches the closed-form royalty, tax, and net cash flow', () => {
    const { cashflow } = calculateEconomics(inputs);
    expect(cashflow[0].royalty).toBeCloseTo(20, 9);
    expect(cashflow[0].tax).toBeCloseTo(10, 9);
    expect(cashflow[0].ncf).toBeCloseTo(10, 9);
    expect(cashflow[1].tax).toBeCloseTo(35, 9);
    expect(cashflow[1].ncf).toBeCloseTo(35, 9);
  });

  it('discounts mid-year', () => {
    const { metrics } = calculateEconomics(inputs);
    const expected = 10 / Math.pow(1.1, 0.5) + 35 / Math.pow(1.1, 1.5);
    expect(metrics.npv).toBeCloseTo(expected, 9);
  });

  it('spreads CAPEX for tax via capexDepreciationYears without changing cash timing', () => {
    const res = calculateEconomics({ ...inputs, capexDepreciationYears: 2 });
    // Depreciation 25/yr: Y1 taxable = 80-10-25 = 45 -> tax 22.5, ncf = 80-60-22.5 = -2.5
    // Y2 taxable = 80-10-25 = 45 -> tax 22.5, ncf = 80-10-22.5 = +47.5
    expect(res.cashflow[0].depreciation).toBeCloseTo(25, 9);
    expect(res.cashflow[0].tax).toBeCloseTo(22.5, 9);
    expect(res.cashflow[0].ncf).toBeCloseTo(-2.5, 9);
    expect(res.cashflow[1].ncf).toBeCloseTo(47.5, 9);
    // Total pre-tax cash out is unchanged: only tax timing moved.
    const cashOut = res.cashflow.reduce((s, c) => s + c.capex + c.opex, 0);
    expect(cashOut).toBeCloseTo(70, 9);
  });
});

describe('calculateEconomics PSC carryforward (cross-engine with epe-engine Case 3)', () => {
  // Same terms as tools/validation/epe-validation.ts Case 3:
  // royalty 10%, cost oil cap 40%, contractor share 50%, tax 50%,
  // $100 oil, 1 MMbbl/yr, capex $80MM year 1, opex $10MM/yr.
  // Expected (hand-derived there): ncf year 1 = -40.5, year 2 = +39.5,
  // unrecovered pool 54 -> 28.
  const inputs = {
    startYear: 2030, projectLife: 2, discountRate: 10, fiscalType: 'PSC',
    production: { oil: [1_000_000, 1_000_000], gas: [0, 0] },
    price: { oil: [100, 100], gas: [0, 0] },
    capex: [80, 0], opexFixed: [10, 10], opexVariable: [0, 0], abandonment: [0, 0],
    royaltyRate: 10, taxRate: 50, costRecoveryCap: 40, profitSplitContractor: 50,
  };

  it('carries unrecovered costs forward and matches the server engine', () => {
    const { cashflow } = calculateEconomics(inputs);
    expect(cashflow[0].ncf).toBeCloseTo(-40.5, 9);
    expect(cashflow[0].pscUnrecoveredCost).toBeCloseTo(54, 9);
    expect(cashflow[1].ncf).toBeCloseTo(39.5, 9);
    expect(cashflow[1].pscUnrecoveredCost).toBeCloseTo(28, 9);
  });

  it('recovers the pool fully when later revenue allows', () => {
    // Extend to 4 years: pool 28 -> 0 by year 3 (recovery capped at 36).
    const long = {
      ...inputs, projectLife: 4,
      production: { oil: flat(1_000_000, 4), gas: flat(0, 4) },
      price: { oil: flat(100, 4), gas: flat(0, 4) },
      capex: [80, 0, 0, 0], opexFixed: flat(10, 4), opexVariable: flat(0, 4), abandonment: flat(0, 4),
    };
    const { cashflow } = calculateEconomics(long);
    // Year 3 pool: 28 + 10 = 38 -> recover 36, carry 2. Year 4: 2 + 10 = 12 -> recover 12, carry 0.
    expect(cashflow[2].pscUnrecoveredCost).toBeCloseTo(2, 9);
    expect(cashflow[3].pscUnrecoveredCost).toBeCloseTo(0, 9);
  });
});

describe('calculateEconomics IRR guard', () => {
  it('returns 0 when the cash flow never changes sign', () => {
    const { metrics } = calculateEconomics({
      startYear: 2030, projectLife: 2, discountRate: 10, fiscalType: 'TaxRoyalty',
      production: { oil: [1_000_000, 1_000_000], gas: [0, 0] },
      price: { oil: [100, 100], gas: [0, 0] },
      capex: [0, 0], opexFixed: [10, 10], opexVariable: [0, 0], abandonment: [0, 0],
      royaltyRate: 0, taxRate: 0,
    });
    // EC6-1: no sign change means no rate returns the money, which is null
    // and a reason. It used to be reported as an IRR of 0.
    expect(metrics.irr).toBeNull();
    expect(metrics.irrStatus).toBe('no-sign-change');
  });

  it('solves a known mid-year IRR', () => {
    // ncf = [-100, +121] (all revenue year 2, all capex year 1, no tax):
    // -100/(1+r)^0.5 + 121/(1+r)^1.5 = 0 -> (1+r) = 1.21 -> IRR 21%
    const { metrics, cashflow } = calculateEconomics({
      startYear: 2030, projectLife: 2, discountRate: 10, fiscalType: 'TaxRoyalty',
      production: { oil: [0, 1_210_000], gas: [0, 0] },
      price: { oil: [0, 100], gas: [0, 0] },
      capex: [100, 0], opexFixed: [0, 0], opexVariable: [0, 0], abandonment: [0, 0],
      royaltyRate: 0, taxRate: 0,
    });
    expect(cashflow[0].ncf).toBeCloseTo(-100, 9);
    expect(cashflow[1].ncf).toBeCloseTo(121, 9);
    expect(metrics.irr).toBeCloseTo(21, 3);
  });
});

// The FDP economics gates (src/utils/fdp/__tests__/economics.test.js) that
// exercise calculateEconomics directly. runFdpCase itself is a thin
// mapping that stays in the Suite; the golden `fdp` cases carry that
// mapping expanded, so the same numbers are gated here without it.
describe('FDP economics on the sanctioned engine', () => {
  const byId = (id) => G.fdp.find((c) => c.id === id);

  test('FISCAL TERMS ARE APPLIED: royalty and tax are both non-zero', () => {
    const r = calculateEconomics(byId('fdp_800_default_fiscal').inputs);
    expect(r.metrics.totalRoyalty).toBeGreaterThan(0);
    expect(r.metrics.totalTax).toBeGreaterThan(0);
    expect(r.metrics.totalGovTake).toBeGreaterThan(0);
  });

  test('post-fiscal NPV is materially below the pre-fiscal number', () => {
    const withFiscal = calculateEconomics(byId('fdp_800_default_fiscal').inputs).metrics.npv;
    const withoutFiscal = calculateEconomics(byId('fdp_800_no_fiscal').inputs).metrics.npv;
    expect(withFiscal).toBeLessThan(withoutFiscal);
    expect(withFiscal / withoutFiscal).toBeLessThan(0.75);
  });

  test('development year carries the capex and no revenue', () => {
    const r = calculateEconomics(byId('fdp_800_default_fiscal').inputs);
    expect(r.cashflow[0].capex).toBe(800);
    expect(r.cashflow[0].grossRevenue).toBe(0);
    expect(r.cashflow[0].ncf).toBeLessThan(0);
  });

  test('payback lands after the crossing year begins and before it ends', () => {
    const r = calculateEconomics(byId('fdp_800_default_fiscal').inputs);
    const crossing = r.cashflow.findIndex((c) => c.cumulativeNCF >= 0);
    expect(r.metrics.payback).toBeGreaterThanOrEqual(crossing);
    expect(r.metrics.payback).toBeLessThan(crossing + 1);
  });

  test('a project that never pays back reports null and not-recovered (EC3-2; it used to report the project life)', () => {
    const c = byId('fdp_never_pays_back');
    const r = calculateEconomics(c.inputs);
    expect(r.cashflow.some((x) => x.cumulativeNCF >= 0)).toBe(false);
    expect(r.metrics.payback).toBeNull();
    expect(r.metrics.paybackStatus).toBe('not-recovered');
    expect(r.metrics.payback).not.toBe(c.inputs.projectLife);
  });
});

// ---------------------------------------------------------------------
// (a) Closed-form identities.
// ---------------------------------------------------------------------

describe('ledger identities', () => {
  const base = G.taxRoyalty.find((c) => c.id === 'tr_base_10yr').inputs;

  test('TaxRoyalty: contractor NCF plus government take equals revenue less cash cost, every year', () => {
    calculateEconomics(base).cashflow.forEach((cf) => {
      expect(cf.ncf + cf.govTake).toBeCloseTo(cf.grossRevenue - cf.capex - cf.opex - cf.abex, 9);
    });
  });

  test('PSC: the same mass balance holds with cost recovery and a profit split', () => {
    const psc = { ...base, fiscalType: 'PSC', costRecoveryCap: 50, profitSplitContractor: 55 };
    calculateEconomics(psc).cashflow.forEach((cf) => {
      expect(cf.ncf + cf.govTake).toBeCloseTo(cf.grossRevenue - cf.capex - cf.opex - cf.abex, 9);
    });
  });

  test('PSC with full recovery, a 100 percent split and no tax or royalty is revenue less cash cost', () => {
    const psc = calculateEconomics({
      ...base, fiscalType: 'PSC', costRecoveryCap: 100, profitSplitContractor: 100, royaltyRate: 0, taxRate: 0,
    });
    psc.cashflow.forEach((cf) => {
      expect(cf.ncf).toBeCloseTo(cf.grossRevenue - cf.capex - cf.opex - cf.abex, 9);
      expect(cf.govTake).toBeCloseTo(0, 9);
    });
    // The pool clears as soon as revenue covers the cost carried in.
    expect(psc.cashflow[psc.cashflow.length - 1].pscUnrecoveredCost).toBeCloseTo(0, 9);
  });

  test('mid-year NPV of a single period cash flow is ncf / (1 + r)^0.5', () => {
    const r = calculateEconomics({
      startYear: 2030, projectLife: 1, discountRate: 21, fiscalType: 'TaxRoyalty',
      production: { oil: [1_000_000], gas: [0] }, price: { oil: [100], gas: [0] },
      capex: [0], opexFixed: [0], opexVariable: [0], abandonment: [0], royaltyRate: 0, taxRate: 0,
    });
    expect(r.metrics.npv).toBeCloseTo(100 / Math.sqrt(1.21), 12);
    expect(r.metrics.npv).toBeCloseTo(100 / 1.1, 12);
  });

  test('every IRR root the oracle reports zeroes the mid-year NPV of the ENGINE cash flow', () => {
    // This checks the oracle against the engine ledger, not the engine
    // against itself: the roots come from the golden, the cash flow from
    // the engine. The golden gates then pin the engine to those roots.
    const groups = ['taxRoyalty', 'psc', 'irr', 'payback', 'sweeps', 'fdp', 'depreciation', 'horizon'];
    let checked = 0;
    groups.forEach((g) => G[g].forEach((c) => {
      const { cashflow } = calculateEconomics(c.inputs);
      const scale = cashflow.reduce((s, cf) => s + Math.abs(cf.ncf), 0);
      c.expected.metrics.irrRoots.forEach((root) => {
        const r = root / 100;
        const npv = cashflow.reduce((s, cf, i) => s + cf.ncf / Math.pow(1 + r, i + 0.5), 0);
        expect(Math.abs(npv) / scale).toBeLessThan(1e-9);
        checked += 1;
      });
    }));
    expect(checked).toBeGreaterThan(40);
  });

  test('depreciation totals the capex actually deductible inside the horizon', () => {
    for (let n = 1; n <= 6; n += 1) {
      const res = calculateEconomics({ ...base, capexDepreciationYears: n });
      const totalDepr = res.cashflow.reduce((s, c) => s + c.depreciation, 0);
      // Capex 400 in year 0 and 200 in year 1, 10 year life: nothing is lost until n > 9.
      expect(totalDepr).toBeCloseTo(600, 9);
    }
    const lost = calculateEconomics({ ...base, projectLife: 3, capexDepreciationYears: 4 });
    // Year 0 capex: 3 of 4 portions inside the horizon; year 1 capex: 2 of 4.
    expect(lost.cashflow.reduce((s, c) => s + c.depreciation, 0)).toBeCloseTo(400 * 0.75 + 200 * 0.5, 9);
  });

  test('payback is inside the crossing period and 0 when the first period is in the black', () => {
    const r = calculateEconomics(base);
    const i = r.cashflow.findIndex((c) => c.cumulativeNCF >= 0);
    expect(r.metrics.payback).toBeGreaterThan(i);
    expect(r.metrics.payback).toBeLessThanOrEqual(i + 1);
    const rich = calculateEconomics({ ...base, capex: flat(0, 10) });
    expect(rich.metrics.payback).toBe(0);
    expect(rich.metrics.paybackStatus).toBe('no-investment');
  });
});

// ---------------------------------------------------------------------
// (b) Golden agreement with the independent oracle.
// ---------------------------------------------------------------------

describe.each(['taxRoyalty', 'fdp', 'psc', 'irr', 'payback', 'depreciation', 'horizon', 'sweeps'])(
  'golden agreement: %s', (group) => {
    test.each(G[group].map((c) => [c.id, c]))('%s', (_id, c) => {
      gateResult(calculateEconomics(c.inputs), c.expected, c.engine);
    });
  },
);

describe('EC6-1: the IRR disagreements are resolved, and the clamp is not an answer', () => {
  test('a cash flow of order 1e-7 $MM: the 21 percent root is found, not the 10 percent seed', () => {
    const c = G.irr.find((x) => x.id === 'irr_tiny_cash_flows_derivative_guard');
    const m = calculateEconomics(c.inputs).metrics;
    expect(m.irr).toBeCloseTo(21, 6);
    expect(m.irrStatus).toBe('ok');
  });

  test('a 9900 percent root is reported as no answer and a reason, not as 1000', () => {
    const c = G.irr.find((x) => x.id === 'irr_beyond_clamp');
    const m = calculateEconomics(c.inputs).metrics;
    expect(m.irr).toBeNull();
    expect(m.irrStatus).toBe('above-clamp');
    expect(c.expected.metrics.irrRoots[0]).toBeCloseTo(9900, 6);
  });

  test('one root inside the band and one above it: not called THE return (lead decision 2026-09-15)', () => {
    const c = G.irr.find((x) => x.id === 'irr_root_above_band_with_one_inside');
    const m = calculateEconomics(c.inputs).metrics;
    expect(m.irr).toBeNull();
    expect(m.irrStatus).toBe('multiple-roots');
    expect(m.irrRootAboveBand).toBe(true);
    expect(m.irrRoots).toHaveLength(1);
    near(m.irrRoots[0], -20, 1e-6);
    expect(c.expected.metrics.irrRoots.map((r) => Math.round(r))).toEqual([-20, 1500]);
    // Negative control: the rule before it reported the in-band root as 'ok'.
    const inBand = c.expected.metrics.irrRoots.filter((r) => r > -99 && r < 1000);
    expect(inBand).toHaveLength(1);
  });

  test('a lone root above the band keeps above-clamp, with the flag set', () => {
    const c = G.irr.find((x) => x.id === 'irr_beyond_clamp');
    const m = calculateEconomics(c.inputs).metrics;
    expect(m.irrStatus).toBe('above-clamp');
    expect(m.irrRootAboveBand).toBe(true);
  });

  test('two roots: both are reported and neither is called THE return', () => {
    const c = G.irr.find((x) => x.id === 'irr_two_roots');
    const m = calculateEconomics(c.inputs).metrics;
    expect(m.irr).toBeNull();
    expect(m.irrStatus).toBe('multiple-roots');
    expect(m.irrRoots.map((r) => Math.round(r))).toEqual([10, 20]);
  });

  test('the case that ran to the clamp now reports its only, negative, root', () => {
    const c = G.fdp.find((x) => x.id === 'fdp_never_pays_back');
    const m = calculateEconomics(c.inputs).metrics;
    expect(m.irrStatus).toBe('ok');
    expect(m.irr).toBeCloseTo(-36.674688, 4);
    // and it is a root: the mid-year NPV there is zero
    const { cashflow } = calculateEconomics(c.inputs);
    const npvAtIrr = cashflow.reduce((s, cf, i) => s + cf.ncf / Math.pow(1 + m.irr / 100, i + 0.5), 0);
    const scale = cashflow.reduce((s, cf) => s + Math.abs(cf.ncf), 0);
    expect(Math.abs(npvAtIrr) / scale).toBeLessThan(1e-9);
  });

  test('NEGATIVE CONTROL: no case anywhere reports exactly the clamp as its IRR', () => {
    let checked = 0;
    ['taxRoyalty', 'fdp', 'psc', 'irr', 'payback', 'depreciation', 'horizon', 'sweeps'].forEach((g) => {
      G[g].forEach((c) => {
        const m = calculateEconomics(c.inputs).metrics;
        if (m.irr !== null) {
          expect(m.irr).toBeLessThan(1000);
          expect(m.irr).toBeGreaterThan(-99);
        }
        checked += 1;
      });
    });
    expect(checked).toBeGreaterThan(40);
  });
});

describe('EC3-1 and EC3-2: payback says what happened around it', () => {
  const byId = (id) => G.payback.find((c) => c.id === id);

  test('the OKPOMA shape: payback 0 at the first crossing, recrossed, and paybackLast by hand', () => {
    const m = calculateEconomics(byId('payback_recrossed_from_first_period').inputs).metrics;
    expect(m.payback).toBe(0);
    expect(m.paybackStatus).toBe('recrossed');
    // cumulative 10, -5, 55: back to non-negative two periods in, 5 short of zero with 60 coming in
    near(m.paybackLast, 2 + 5 / 60, PAYBACK);
    expect(m.maxExposure).toBeLessThan(0);
  });

  test('a crossing that is undone and redone: the first and the last crossing, both by hand', () => {
    const m = calculateEconomics(byId('payback_recrossed_after_crossing').inputs).metrics;
    near(m.payback, 1 + 100 / 150, PAYBACK);
    near(m.paybackLast, 3 + 30 / 50, PAYBACK);
    expect(m.paybackStatus).toBe('recrossed');
  });

  test('recrossed and never recovered for good: paybackLast is null', () => {
    const m = calculateEconomics(byId('payback_recrossed_never_recovers').inputs).metrics;
    expect(m.payback).toBe(0);
    expect(m.paybackLast).toBeNull();
    expect(m.paybackStatus).toBe('recrossed');
  });

  test('EC3-4: payback_multi_year recovers in the FIFTH period, 4.75 years, and its note now says so', () => {
    const c = byId('payback_multi_year');
    near(calculateEconomics(c.inputs).metrics.payback, 4 + 30 / 40, PAYBACK);
    expect(c.note).toMatch(/4 \+ 30\/40 = 4\.75/);
    expect(c.note).not.toMatch(/fourth period: 3 \+ 10\/40/);
  });

  test('NEGATIVE CONTROL: no case anywhere reports the project life for a cumulative that never turns non-negative', () => {
    let never = 0;
    ['taxRoyalty', 'fdp', 'psc', 'irr', 'payback', 'depreciation', 'horizon', 'sweeps'].forEach((g) => {
      G[g].forEach((c) => {
        const r = calculateEconomics(c.inputs);
        if (!r.cashflow.some((x) => x.cumulativeNCF >= 0)) {
          never += 1;
          expect(r.metrics.payback).toBeNull();
          expect(r.metrics.paybackStatus).toBe('not-recovered');
        }
      });
    });
    expect(never).toBeGreaterThan(3);
  });
});

describe('sensitivity and scenarios', () => {
  test.each(G.sensitivity.map((c) => [c.id, c]))('%s', (_id, c) => {
    const res = runSensitivityAnalysis(c.inputs);
    expect(res.map((r) => r.name)).toEqual(c.expected.map((r) => r.name));
    res.forEach((r, i) => {
      near(r.lowParamNPV, c.expected[i].lowParamNPV, MONEY);
      near(r.highParamNPV, c.expected[i].highParamNPV, MONEY);
      near(r.baseNPV, c.expected[i].baseNPV, MONEY);
    });
  });

  test('sensitivity does not mutate the base inputs', () => {
    const inputs = JSON.parse(JSON.stringify(G.sensitivity[0].inputs));
    runSensitivityAnalysis(inputs);
    expect(inputs).toEqual(G.sensitivity[0].inputs);
  });

  test.each(G.scenarios.map((c) => [c.id, c]))('%s', (_id, c) => {
    const res = generateScenarios(c.inputs);
    ['Base', 'Low', 'High'].forEach((k) => gateResult(res[k], c.expected[k]));
    expect(res.Low.metrics.npv).toBeLessThan(res.Base.metrics.npv);
    expect(res.High.metrics.npv).toBeGreaterThan(res.Base.metrics.npv);
  });

  test('EC3-3: a scenario\'s variable opex moves with its production, by hand', () => {
    const inputs = G.scenarios[0].inputs;
    const res = generateScenarios(inputs);
    const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);
    const fixed = sum(inputs.opexFixed);
    const variable = sum(inputs.opexVariable);
    expect(variable).toBeGreaterThan(0);
    near(res.Low.metrics.totalOpex, 1.2 * fixed + 0.8 * variable, MONEY);
    near(res.High.metrics.totalOpex, 0.8 * fixed + 1.2 * variable, MONEY);
    // Negative control: the retired rule held variable opex at the base money.
    expect(Math.abs(res.Low.metrics.totalOpex - (1.2 * fixed + variable))).toBeGreaterThan(1);
  });
});

describe('expandQuickInputs', () => {
  test.each(G.quickInputs.map((c) => [c.id, c]))('%s', (_id, c) => {
    const exp = expandQuickInputs(c.quick);
    const e = c.expandedInputs;
    expect(exp.projectLife).toBe(20);
    expect(exp.fiscalType).toBe('TaxRoyalty');
    expect(exp.startYear).toBe(e.startYear);
    expect(exp.discountRate).toBe(e.discountRate);
    expect(exp.royaltyRate).toBe(e.royaltyRate);
    expect(exp.taxRate).toBe(e.taxRate);
    exp.production.oil.forEach((v, i) => near(v, e.production.oil[i], 1e-6));
    expect(exp.production.gas).toEqual(e.production.gas);
    expect(exp.price.oil).toEqual(e.price.oil);
    expect(exp.price.gas).toEqual(e.price.gas);
    expect(exp.capex).toEqual(e.capex);
    expect(exp.opexFixed).toEqual(e.opexFixed);
    exp.opexVariable.forEach((v, i) => near(v, e.opexVariable[i], 1e-9));
    expect(exp.abandonment).toEqual(e.abandonment);
    gateResult(calculateEconomics(exp), c.expected);
  });
});

describe('getPortfolioMetrics', () => {
  test.each(G.portfolio.map((c) => [c.id, c]))('%s', (_id, c) => {
    const m = getPortfolioMetrics(c.projects);
    ['totalNPV', 'totalCapex', 'capitalEfficiency', 'avgIRR', 'totalRiskedNPV'].forEach((f) => near(m[f], c.expected[f], 1e-9));
    // EC1-10: no portfolio golden is a recorded disagreement any more.
    expect(c.engine).toBeUndefined();
  });

  describe('EC1-10: a chance of success of 0 is a chance of 0', () => {
    const golden = () => G.portfolio.find((c) => c.id === 'portfolio_zero_chance');

    test('the written-off project contributes nothing; the retired `|| 1.0` rule is the negative control', () => {
      const c = golden();
      const m = getPortfolioMetrics(c.projects);
      near(m.totalRiskedNPV, 20, 1e-9);
      const retired = c.projects.reduce((t, p) => t + (p.npv || 0) * (p.chanceOfSuccess || 1.0), 0);
      near(retired, 120, 1e-9);
      expect(Math.abs(m.totalRiskedNPV - retired)).toBeGreaterThan(50);
    });

    test('a missing or null chance still means certainty', () => {
      const m = getPortfolioMetrics([{ npv: 100 }, { npv: 40, chanceOfSuccess: null }, { npv: 10, chanceOfSuccess: undefined }]);
      near(m.totalRiskedNPV, 150, 1e-9);
    });

    test('the band edges 0 and 1 are accepted', () => {
      near(getPortfolioMetrics([{ npv: 10, chanceOfSuccess: 0 }, { npv: 7, chanceOfSuccess: 1 }]).totalRiskedNPV, 7, 1e-12);
    });

    test.each([
      [-0.1, /project at index 1 has chanceOfSuccess -0\.1/],
      [1.5, /project at index 1 has chanceOfSuccess 1\.5/],
      [NaN, /chanceOfSuccess NaN/],
      [Infinity, /chanceOfSuccess Infinity/],
      ['0.5', /chanceOfSuccess "0\.5"/],
      [true, /chanceOfSuccess true/],
    ])('a present chance of %p is refused by project', (chance, message) => {
      expect(() => getPortfolioMetrics([{ npv: 1, chanceOfSuccess: 0.5 }, { npv: 2, chanceOfSuccess: chance }]))
        .toThrow(message);
      // Negative control: the retired rule silently accepted every one of these.
      expect(() => [{ npv: 2, chanceOfSuccess: chance }].reduce((t, p) => t + p.npv * (p.chanceOfSuccess || 1.0), 0))
        .not.toThrow();
    });

    test('a named project is refused by name as well as index', () => {
      expect(() => getPortfolioMetrics([{ name: 'Block 7', npv: 1, chanceOfSuccess: 2 }]))
        .toThrow(/project "Block 7" \(index 0\) has chanceOfSuccess 2; a chance of success must be a number from 0 to 1/);
    });
  });
});

describe('runMonteCarlo, seeded (EC3-0)', () => {
  afterEach(() => jest.restoreAllMocks());

  const gate = (res, c) => {
    const e = c.expected;
    expect(res.seed).toBe(c.seed);
    expect(res.iterations).toBe(c.settings.iterations);
    expect(res.allValues).toHaveLength(e.allValues.length);
    res.allValues.forEach((v, i) => near(v, e.allValues[i], MONEY));
    near(res.p10, e.p10, MONEY);
    near(res.p50, e.p50, MONEY);
    near(res.p90, e.p90, MONEY);
    near(res.emv, e.emv, MONEY);
    expect(res.histogram).toHaveLength(20);
    res.histogram.forEach((b, i) => {
      near(b.binStart, e.histogram[i].binStart, MONEY);
      near(b.binEnd, e.histogram[i].binEnd, MONEY);
      expect(b.count).toBe(e.histogram[i].count);
    });
    expect(res.histogram.reduce((s, b) => s + b.count, 0)).toBe(c.settings.iterations);
    expect(res.cdf).toHaveLength(e.cdf.length);
    res.cdf.forEach((p, i) => {
      near(p.value, e.cdf[i].value, MONEY);
      near(p.probability, e.cdf[i].probability, 1e-9);
    });
  };

  test.each(G.monteCarloSeeded.map((c) => [c.id, c]))('%s', async (_id, c) => {
    gate(await runMonteCarlo(c.inputs, c.settings), c);
  });

  test('never calls Math.random', async () => {
    const spy = jest.spyOn(Math, 'random');
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_seed42_100');
    await runMonteCarlo(c.inputs, c.settings);
    expect(spy).not.toHaveBeenCalled();
  });

  test('the same seed reproduces the run exactly; a different seed does not', async () => {
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_seed42_100');
    const a = await runMonteCarlo(c.inputs, c.settings);
    const b = await runMonteCarlo(c.inputs, c.settings);
    const d = await runMonteCarlo(c.inputs, { ...c.settings, seed: 43 });
    expect(a.allValues).toEqual(b.allValues);
    expect(d.allValues).not.toEqual(a.allValues);
  });

  test('no seed means DEFAULT_MC_SEED, the breakeven default, reported with the result', async () => {
    expect(DEFAULT_MC_SEED).toBe(20260829);
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_default_seed');
    expect(c.settings.seed).toBeUndefined();
    const res = await runMonteCarlo(c.inputs, c.settings);
    expect(res.seed).toBe(DEFAULT_MC_SEED);
  });

  test('zero uncertainty everywhere: every value is the base NPV and every iteration lands in bin 0 (S4 fixed)', async () => {
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_zero_uncertainty_degenerate');
    const res = await runMonteCarlo(c.inputs, c.settings);
    near(res.p10, c.expected.baseNPV, MONEY);
    near(res.p90, c.expected.baseNPV, MONEY);
    near(calculateEconomics(c.inputs).metrics.npv, c.expected.baseNPV, MONEY);
    expect(res.histogram[0].count).toBe(c.settings.iterations);
  });

  test('fewer than 50 iterations still draws the whole S-curve (S5 fixed)', async () => {
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_seed11_40_iters');
    const res = await runMonteCarlo(c.inputs, c.settings);
    expect(res.cdf).toHaveLength(51);
  });

  test('EC3-6: the S-curve runs from the smallest NPV to the largest and its 10 / 50 / 90 heights ARE the cards', async () => {
    for (const c of G.monteCarloSeeded) {
      // eslint-disable-next-line no-await-in-loop
      const res = await runMonteCarlo(c.inputs, c.settings);
      expect(res.cdf).toHaveLength(51);
      expect(res.cdf[0]).toEqual({ value: res.allValues[0], probability: 0 });
      expect(res.cdf[50]).toEqual({ value: res.allValues[res.allValues.length - 1], probability: 100 });
      expect(res.cdf[5].probability).toBe(10);
      expect(res.cdf[5].value).toBe(res.p10);
      expect(res.cdf[25].value).toBe(res.p50);
      expect(res.cdf[45].value).toBe(res.p90);
    }
  });

  test('EC3-7: ONE price factor per iteration, applied to every year (read back through a linear ledger)', async () => {
    // No royalty, no tax, no gas, one uncertain variable: NPV is exactly
    // a + b * f in the price factor f, so each iteration's NPV names its f.
    const life = 6;
    const inputs = {
      startYear: 2030, projectLife: life, discountRate: 10, fiscalType: 'TaxRoyalty',
      production: { oil: [0, 900000, 800000, 700000, 600000, 500000], gas: flat(0, life) },
      price: { oil: flat(70, life), gas: flat(0, life) },
      capex: [120, 0, 0, 0, 0, 0], opexFixed: flat(5, life), opexVariable: flat(0, life), abandonment: flat(0, life),
      royaltyRate: 0, taxRate: 0,
    };
    const settings = { iterations: 200, seed: 99, uncertainties: { reserves: 0, price: 0.25, capex: 0 } };
    const res = await runMonteCarlo(inputs, settings);
    const a = calculateEconomics({ ...inputs, price: { oil: flat(0, life), gas: flat(0, life) } }).metrics.npv;
    const b = calculateEconomics(inputs).metrics.npv - a;
    const rng = mulberry32(99);
    const predicted = Array.from({ length: 200 }, () => a + b * (1 + 0.25 * (2 * rng() - 1))).sort((x, y) => x - y);
    res.allValues.forEach((v, i) => near(v, predicted[i], 1e-9));
    // Negative control: a draw per year would not collapse onto one factor.
    const perYear = mulberry32(99);
    const yearly = calculateEconomics({ ...inputs, price: { oil: inputs.price.oil.map((p) => p * (1 + 0.25 * (2 * perYear() - 1))), gas: flat(0, life) } }).metrics.npv;
    expect(Math.abs(yearly - predicted[0])).toBeGreaterThan(1e-6);
  });

  test('EC3-7: reserves moves variable opex with the volume', async () => {
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_seed42_100');
    const inputs = { ...c.inputs, opexVariable: c.inputs.opexVariable.map((v) => v * 50) };
    const only = { iterations: 1, seed: 5, uncertainties: { reserves: 0.2, price: 0, capex: 0 } };
    const [npv] = (await runMonteCarlo(inputs, only)).allValues;
    const f = 1 + 0.2 * (2 * mulberry32(5)() - 1);
    const scaled = {
      ...inputs,
      production: { oil: inputs.production.oil.map((v) => v * f), gas: inputs.production.gas.map((v) => v * f) },
      opexVariable: inputs.opexVariable.map((v) => v * f),
    };
    near(npv, calculateEconomics(scaled).metrics.npv, MONEY);
    const volumeOnly = { ...scaled, opexVariable: inputs.opexVariable };
    expect(Math.abs(npv - calculateEconomics(volumeOnly).metrics.npv)).toBeGreaterThan(1);
  });

  test.each((G.monteCarloRefused || []).map((c) => [c.id, c]))('refused: %s', async (_id, c) => {
    expect(c.expected.throws).toBe(true);
    await expect(runMonteCarlo(c.inputs, c.settings)).rejects.toThrow(c.expected.error);
  });
});
