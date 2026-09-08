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
  calculateEconomics, runSensitivityAnalysis, generateScenarios, runMonteCarlo,
  expandQuickInputs, getPortfolioMetrics,
} from '../engines/economics/screening.js';
import { mulberry32 } from '../lib/stats/stats.js';

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
  near(m.payback, em.payback, PAYBACK);
  if (em.maxExposure !== null) near(m.maxExposure, em.maxExposure, MONEY);
  if (engine && engine.irr !== undefined) {
    // A recorded disagreement: pin the engine's number and the oracle's.
    near(m.irr, engine.irr, IRR);
    expect(Math.abs(engine.irr - em.irr)).toBeGreaterThan(1);
  } else if (em.irrRoots.length > 1) {
    // Several roots: the engine must land on one of them.
    const hit = em.irrRoots.some((r) => Math.abs(r - m.irr) <= IRR);
    expect(hit).toBe(true);
  } else {
    near(m.irr, em.irr, IRR);
  }
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
    expect(metrics.irr).toBe(0);
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

  test('a project that never pays back reports the project life (the Suite wrapper turns that into null)', () => {
    const c = byId('fdp_never_pays_back');
    const r = calculateEconomics(c.inputs);
    expect(r.cashflow.some((x) => x.cumulativeNCF >= 0)).toBe(false);
    expect(r.metrics.payback).toBe(c.inputs.projectLife);
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

describe('recorded disagreements are pinned on both sides', () => {
  test('IRR: the absolute derivative guard returns the 10 percent seed on 1e-7 $MM cash flows', () => {
    const c = G.irr.find((x) => x.id === 'irr_tiny_cash_flows_derivative_guard');
    expect(calculateEconomics(c.inputs).metrics.irr).toBe(10);
    expect(c.expected.metrics.irr).toBeCloseTo(21, 6);
  });

  test('IRR: a 9900 percent root is reported as the 1000 percent clamp', () => {
    const c = G.irr.find((x) => x.id === 'irr_beyond_clamp');
    expect(calculateEconomics(c.inputs).metrics.irr).toBe(1000);
    expect(c.expected.metrics.irr).toBeCloseTo(9900, 6);
  });

  test('IRR: two roots at 10 and 20 percent, the engine lands on the lower one from its 10 percent start', () => {
    const c = G.irr.find((x) => x.id === 'irr_two_roots');
    expect(c.expected.metrics.irrRoots.map((r) => Math.round(r))).toEqual([10, 20]);
    expect(calculateEconomics(c.inputs).metrics.irr).toBeCloseTo(10, 6);
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
    ['totalNPV', 'totalCapex', 'capitalEfficiency', 'avgIRR'].forEach((f) => near(m[f], c.expected[f], 1e-9));
    if (c.engine) {
      // chanceOfSuccess 0 is read as 1.0 by `|| 1.0`: pinned on both sides.
      near(m.totalRiskedNPV, c.engine.totalRiskedNPV, 1e-9);
      expect(c.expected.totalRiskedNPV).toBeCloseTo(20, 9);
    } else {
      near(m.totalRiskedNPV, c.expected.totalRiskedNPV, 1e-9);
    }
  });
});

describe('runMonteCarlo with a seeded stand-in for Math.random', () => {
  afterEach(() => jest.restoreAllMocks());

  const seeded = G.monteCarloSeeded.filter((c) => !c.engine);
  test.each(seeded.map((c) => [c.id, c]))('%s', async (_id, c) => {
    jest.spyOn(Math, 'random').mockImplementation(mulberry32(c.seed));
    const res = await runMonteCarlo(c.inputs, c.settings);
    const e = c.expected;
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
  });

  test('an unseeded run is not reproducible (Math.random): two runs differ', async () => {
    const c = seeded[0];
    const a = await runMonteCarlo(c.inputs, c.settings);
    const b = await runMonteCarlo(c.inputs, c.settings);
    expect(a.allValues).not.toEqual(b.allValues);
  });

  test('zero uncertainty everywhere: the oracle gives the base NPV, the engine throws (recorded)', async () => {
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_zero_uncertainty_throws');
    expect(c.engine.throws).toBe(true);
    near(c.expected.p50, c.expected.baseNPV, MONEY);
    near(c.expected.p10, c.expected.p90, MONEY);
    near(calculateEconomics(c.inputs).metrics.npv, c.expected.baseNPV, MONEY);
    jest.spyOn(Math, 'random').mockImplementation(mulberry32(c.seed));
    await expect(runMonteCarlo(c.inputs, c.settings)).rejects.toThrow();
  });

  test('fewer than 50 iterations leaves the cdf empty (recorded)', async () => {
    const c = G.monteCarloSeeded.find((x) => x.id === 'mc_seed11_40_iters_cdf_empty');
    expect(c.expected.cdf).toEqual([]);
    jest.spyOn(Math, 'random').mockImplementation(mulberry32(c.seed));
    const res = await runMonteCarlo(c.inputs, c.settings);
    expect(res.cdf).toEqual([]);
  });
});
