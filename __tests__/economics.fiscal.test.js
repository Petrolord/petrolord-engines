// Fiscal regime sandbox gates (engines/economics/fiscalRegime.js and
// fiscalTemplates.js, the Suite's fiscalDesignerCalculations.js and
// fiscalTemplates.js, EC0 extraction 2026-09-08).
//
// Three layers: (a) ledger identities the regime model must satisfy exactly
// (these ARE the Suite's E1 tests, ported verbatim with the imports
// repointed), (b) agreement with the independent stdlib oracle
// (tools/validation/economics/oracle_fiscal.py) through its committed
// goldens, and (c) the rest of the Suite's tests: parity with the screening
// engine, the solvers and deriveInsights.
//
// The oracle reaches every number by a different road: closed-form 25 year
// declines, tier selection by highest threshold reached (max over the tiers,
// not a sorted walk), IRR roots by a fine scan and the Illinois method where
// the engine runs Newton and sweeps the band, and the verdict sentences
// rebuilt with JavaScript toFixed rounding.
//
// EC2 owner decisions, 2026-09-15 (FINDINGS-fiscal.md): EC2-2 effectiveTaxRate
// is a deprecated alias with no zero fallback; EC2-4 the capex verdict uses
// the price verdict's tie rule; EC2-5 IRR follows the screening engine's
// contract (null plus a status); EC2-8 tiers are selected in threshold order
// and a repeated threshold is refused; EC2-10 payback names every regime at
// the winning year; EC2-11 money reads "1,339.3 million USD". Each has a
// negative control that re-implements the retired rule and shows it differs.
//
// ONE PLACE THEY DO NOT AGREE, AND IT IS PINNED. The engine's capex sweep
// accumulates 0.1 in floating point from 0.8 and stops at 1.4000000000000004
// because the next step (1.5000000000000004) fails the `<= 1.5` test, so the
// documented 0.8 to 1.5 sweep has 7 points, not 8. The golden carries the
// 8 point sweep; the gate pins the engine's 7 against the first 7 and the
// capex insight against `insightsAsEngine`, the oracle's rebuild of that
// verdict over the 7 points the engine actually sees.
//
// Tolerances (absolute): money (million USD) 1e-6, IRR 1e-6 percentage points,
// effective tax rate 1e-9 points.

import fs from 'fs';
import path from 'path';
import {
  calculateCashFlowForRegime,
  calculateNPV,
  calculateIRR,
  calculateIRRResult,
  orderedTierTable,
  leadOrTie,
  CAPEX_RESILIENCE_MIN_SPREAD_MM,
  deriveInsights,
  runFiscalComparison,
  classifyGovernmentShare,
  commonShareWindow,
  GOVERNMENT_SHARE_STATES,
  takeMetrics,
} from '../engines/economics/fiscalRegime.js';
import {
  FISCAL_METRICS,
  GOVERNMENT_CASH_FLOW,
  basisLabel,
  metricLabel,
  metricPhrase,
  metricDefinition,
  exportHeaderLines,
  formatMillionUSD,
} from '../engines/economics/fiscalConventions.js';
import { fiscalTemplates } from '../engines/economics/fiscalTemplates.js';
import { calculateEconomics } from '../engines/economics/screening.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'fiscal_cases.json'),
  'utf8',
));

const MONEY = 1e-6;
const IRR = 1e-6;
const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

const ROW_FIELDS = ['grossRevenue', 'royalty', 'costRecovered', 'unrecoveredCostPool', 'profitOil', 'tax',
  'opex', 'capex', 'contractorNCF', 'governmentTake', 'cumulativeNCF'];

const gateRows = (rows, exp) => {
  expect(rows).toHaveLength(exp.length);
  rows.forEach((cf, i) => {
    const e = exp[i];
    expect(cf.year).toBe(e.year);
    ROW_FIELDS.forEach((f) => near(cf[f], e[f], MONEY));
    near(cf.rFactor, e.rFactor, 1e-9);
  });
};

const project = {
  production: {
    oil: { initial: 30000, decline: 12 },
    gas: { initial: 0, decline: 0 },
    ngl: { initial: 0, decline: 0 },
  },
  prices: [{ year: 1, oil: 80, gas: 3, ngl: 45 }],
  costs: {
    capex: { drilling: 400, facilities: 500, subsea: 100 },
    opex: { fixed: 60, variable: 4 },
  },
  discountRate: 10,
};

/** A plain regime: flat royalty, full cost recovery, flat split, CIT only. */
const flatRegime = (over = {}) => ({
  id: 'flat',
  name: 'Flat',
  royalty: { type: 'flat', rate: 12.5 },
  costRecoveryLimit: 100,
  profitSplit: { type: 'flat', split: 100 },
  tax: { cit: 30, rrt: 0, minTax: 0, rrtUpliftPct: 0 },
  ...over,
});

// ---------------------------------------------------------------------
// (a) and (c): the Suite's tests, ported.
// ---------------------------------------------------------------------

describe('ledger identities (the E1 defects)', () => {
  test('MASS BALANCE: contractor take plus government take equals revenue minus costs', () => {
    const rows = calculateCashFlowForRegime(flatRegime(), project);
    rows.forEach((cf) => {
      const shouldBe = cf.grossRevenue - cf.opex - cf.capex;
      expect(cf.contractorNCF + cf.governmentTake).toBeCloseTo(shouldBe, 8);
    });
  });

  test('mass balance holds under a sliding scale, tiered splits, RRT and a minimum tax', () => {
    const complex = flatRegime({
      royalty: {
        type: 'sliding',
        tiers: [
          { threshold: 0, rate: 5 },
          { threshold: 60, rate: 12.5 },
          { threshold: 100, rate: 20 },
        ],
      },
      costRecoveryLimit: 70,
      profitSplit: {
        type: 'tiered',
        tiers: [
          { threshold: 0, split: 80 },
          { threshold: 1.5, split: 55 },
          { threshold: 3, split: 35 },
        ],
      },
      tax: { cit: 30, rrt: 20, minTax: 2, rrtUpliftPct: 20 },
    });
    const rows = calculateCashFlowForRegime(complex, project);
    rows.forEach((cf) => {
      expect(cf.contractorNCF + cf.governmentTake)
        .toBeCloseTo(cf.grossRevenue - cf.opex - cf.capex, 8);
    });
  });

  test('REVENUE SPLIT: gross equals royalty plus cost oil plus profit oil', () => {
    const rows = calculateCashFlowForRegime(flatRegime(), project);
    rows.forEach((cf) => {
      if (cf.profitOil > 0) {
        expect(cf.royalty + cf.costRecovered + cf.profitOil)
          .toBeCloseTo(cf.grossRevenue, 8);
      }
    });
  });

  test('OPEX IS RECOVERABLE: the cost pool takes in opex, not capex alone', () => {
    const capped = flatRegime({ costRecoveryLimit: 5 });
    const rows = calculateCashFlowForRegime(capped, project);
    const late = rows[rows.length - 1];
    const totalCapex = 1000;
    expect(late.unrecoveredCostPool).toBeGreaterThan(totalCapex);
  });

  test('cost recovery never exceeds the cap or the pool', () => {
    const capped = flatRegime({ costRecoveryLimit: 40 });
    const rows = calculateCashFlowForRegime(capped, project);
    rows.forEach((cf) => {
      const cap = (cf.grossRevenue - cf.royalty) * 0.4;
      expect(cf.costRecovered).toBeLessThanOrEqual(cap + 1e-9);
      expect(cf.costRecovered).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('parity with the canonical screening engine', () => {
  const rows = calculateCashFlowForRegime(flatRegime(), project);

  const screening = () => {
    const life = rows.length;
    const capex = new Array(life).fill(0);
    capex[0] = 1000;
    return calculateEconomics({
      startYear: 1,
      projectLife: life,
      discountRate: project.discountRate,
      fiscalType: 'PSC',
      production: {
        oil: rows.map((_, i) => 30000 * 365 * (0.88 ** i)),
        gas: new Array(life).fill(0),
      },
      price: { oil: new Array(life).fill(80), gas: new Array(life).fill(0) },
      capex,
      opexFixed: rows.map((cf) => cf.opex),
      opexVariable: new Array(life).fill(0),
      abandonment: new Array(life).fill(0),
      royaltyRate: 12.5,
      taxRate: 30,
      costRecoveryCap: 100,
      profitSplitContractor: 100,
    });
  };

  test('the two engines produce the same annual contractor cash flow', () => {
    const econ = screening();
    rows.forEach((cf, i) => {
      expect(cf.contractorNCF).toBeCloseTo(econ.cashflow[i].ncf, 6);
    });
  });

  test('CONVENTION: the NPVs differ by exactly one half year of discounting', () => {
    const r = project.discountRate / 100;
    const yearEnd = calculateNPV(rows, project.discountRate);
    const midYear = screening().metrics.npv;
    expect(midYear).toBeCloseTo(yearEnd * Math.sqrt(1 + r), 6);
  });
});

describe('solvers', () => {
  test('every IRR root reported is a rate at which NPV is zero', () => {
    // The flat regime on this project runs past its economic limit, so late
    // contractor cash flow is negative and the NPV is zero at two rates.
    const rows = calculateCashFlowForRegime(flatRegime(), project);
    const res = calculateIRRResult(rows);
    expect(res.irrStatus).toBe('multiple-roots');
    expect(res.irr).toBeNull();
    expect(res.irrRoots).toHaveLength(2);
    res.irrRoots.forEach((r) => expect(calculateNPV(rows, r)).toBeCloseTo(0, 6));
    // Truncated at year 10, before the flow turns negative, there is one.
    const early = rows.slice(0, 10);
    const one = calculateIRRResult(early);
    expect(one.irrStatus).toBe('ok');
    expect(calculateIRR(early)).toBe(one.irr);
    expect(calculateNPV(early, one.irr)).toBeCloseTo(0, 6);
  });

  test('no IRR is reported when the cash flow never changes sign', () => {
    const allPositive = [
      { year: 1, contractorNCF: 10 },
      { year: 2, contractorNCF: 20 },
    ];
    expect(calculateIRR(allPositive)).toBeNull();
    expect(calculateIRRResult(allPositive)).toEqual({ irr: null, irrStatus: 'no-sign-change', irrRoots: null, irrRootAboveBand: false });
  });

  test('a harsher regime leaves the contractor less', () => {
    const soft = calculateCashFlowForRegime(flatRegime(), project);
    const harsh = calculateCashFlowForRegime(
      flatRegime({ profitSplit: { type: 'flat', split: 40 }, royalty: { type: 'flat', rate: 20 } }),
      project,
    );
    expect(calculateNPV(harsh, project.discountRate))
      .toBeLessThan(calculateNPV(soft, project.discountRate));
    const govOf = (r) => r.reduce((sum, cf) => sum + cf.governmentTake, 0);
    expect(govOf(harsh)).toBeGreaterThan(govOf(soft));
  });
});

describe('deriveInsights', () => {
  const sens = {
    price: {
      labels: [40, 120],
      data: [
        { regimeId: 'a', values: [30, 40] },
        { regimeId: 'b', values: [35, 60] },
      ],
    },
    capex: {
      labels: ['0.8', '1.5'],
      data: [
        { regimeId: 'a', values: [200, 100] },
        { regimeId: 'b', values: [180, 150] },
      ],
    },
  };
  const summary = [
    { id: 'a', name: 'Alpha', npv: 150, irr: 22, paybackPeriod: 6, govTake: 400, effectiveTaxRate: 55 },
    { id: 'b', name: 'Beta', npv: 120, irr: 18, paybackPeriod: 4, govTake: 900, effectiveTaxRate: 70 },
  ];

  it('names the top-NPV regime for the contractor', () => {
    const out = deriveInsights(summary, sens);
    expect(out.find((i) => i.key === 'npv').text).toContain('Alpha');
  });

  it('names the regime that actually pays back fastest, not the top-NPV one', () => {
    const out = deriveInsights(summary, sens);
    const payback = out.find((i) => i.key === 'payback');
    expect(payback.text).toContain('Beta');
    expect(payback.text).toContain('year 4');
  });

  it('names the regime that actually collects the most, not the runner-up by NPV', () => {
    const flipped = [
      { ...summary[1], npv: 300 },
      { ...summary[0] },
    ];
    const out = deriveInsights(flipped, sens);
    const gov = out.find((i) => i.key === 'government');
    expect(gov.text).toContain('Beta');
    expect(gov.text).toContain('900');
  });

  it('ranks capex resilience by NPV actually given up across the sweep', () => {
    const out = deriveInsights(summary, sens);
    const capex = out.find((i) => i.key === 'capex');
    expect(capex.text).toMatch(/"Beta" gives up the least/);
    expect(capex.text).toMatch(/"Alpha" the most/);
  });

  it('ranks price progressivity by the actual climb in government share', () => {
    const out = deriveInsights(summary, sens);
    expect(out.find((i) => i.key === 'price').text).toContain('Beta');
  });

  it('says so plainly when nothing pays back, rather than printing a null year', () => {
    const never = summary.map((r) => ({ ...r, paybackPeriod: null }));
    const out = deriveInsights(never, sens);
    expect(out.find((i) => i.key === 'payback').text).toMatch(/No regime pays back/);
  });

  it('omits the sweep claims when there is only one regime to compare', () => {
    const one = [summary[0]];
    const oneSens = { price: { labels: [40, 120], data: [sens.price.data[0]] }, capex: { labels: ['0.8', '1.5'], data: [sens.capex.data[0]] } };
    const out = deriveInsights(one, oneSens);
    expect(out.some((i) => i.key === 'capex')).toBe(false);
    expect(out.some((i) => i.key === 'price')).toBe(false);
    expect(out.some((i) => i.key === 'npv')).toBe(true);
  });

  it('returns nothing at all rather than a conclusion about no regimes', () => {
    expect(deriveInsights([], sens)).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// (b) Golden agreement with the independent oracle.
// ---------------------------------------------------------------------

describe('templates match the oracle\'s copy', () => {
  test('six templates, same names and regimes', () => {
    expect(fiscalTemplates).toHaveLength(6);
    const ids = G.comparisons.find((c) => c.id === 'cmp_all_templates_default_project').regimes;
    fiscalTemplates.forEach((t, i) => {
      expect(ids[i].name).toBe(t.name);
      const { id, name, ...regime } = ids[i];
      expect(regime).toEqual(t.regime);
    });
  });
});

// EC2-5: the IRR result against the oracle's { irr, irrStatus, irrRoots }.
const gateIrr = (got, exp) => {
  expect(got.irrStatus).toBe(exp.irrStatus);
  expect(got.irrRootAboveBand).toBe(exp.irrRootAboveBand);
  if (exp.irr === null) expect(got.irr).toBeNull();
  else near(got.irr, exp.irr, IRR);
  if (exp.irrRoots === null) {
    expect(got.irrRoots).toBeNull();
  } else {
    expect(got.irrRoots).toHaveLength(exp.irrRoots.length);
    got.irrRoots.forEach((r, i) => near(r, exp.irrRoots[i], IRR));
  }
};

describe.each(['cashflow', 'priceSweep', 'capexSweep'])('golden agreement: %s', (group) => {
  test.each(G[group].map((c) => [c.id, c]))('%s', (_id, c) => {
    const rows = calculateCashFlowForRegime(c.regime, c.project, c.capexMultiplier, c.priceMultiplier);
    gateRows(rows, c.expected.cashflow);
    near(calculateNPV(rows, c.project.discountRate), c.expected.npv, MONEY);
    gateIrr(calculateIRRResult(rows), c.expected);
    near(rows.reduce((s, cf) => s + cf.governmentTake, 0), c.expected.totalGovTake, MONEY);
    near(rows.reduce((s, cf) => s + cf.contractorNCF, 0), c.expected.totalContractorNCF, MONEY);
    near(rows[rows.length - 1].unrecoveredCostPool, c.expected.finalUnrecoveredPool, MONEY);
    const pay = rows.find((cf) => cf.cumulativeNCF > 0);
    expect(pay ? pay.year : null).toBe(c.expected.paybackYear);
    const rpay = rows.find((cf) => cf.rFactor > 1.0);
    expect(rpay ? rpay.year : null).toBe(c.expected.rFactorPayoutYear);
  });
});

describe('golden agreement: tranche and tier selection', () => {
  test('the R-factor walk steps the contractor split 60 -> 40 -> 30 in years 3 and 6', () => {
    const c = G.cashflow.find((x) => x.id === 'rfactor_tranche_crossing');
    const splits = c.expected.cashflow.map((r) => r.contractorSplit);
    expect(new Set(splits)).toEqual(new Set([0.6, 0.4, 0.3]));
    expect(splits.slice(0, 2)).toEqual([0.6, 0.6]);
    expect(splits.slice(2, 5)).toEqual([0.4, 0.4, 0.4]);
    expect(splits.slice(5).every((v) => v === 0.3)).toBe(true);
    const rows = calculateCashFlowForRegime(c.regime, c.project);
    // The split the engine used is profit share over profit oil.
    rows.forEach((cf, i) => {
      if (cf.profitOil > 0) {
        const contractorShare = cf.contractorNCF + cf.tax + cf.opex + cf.capex - cf.costRecovered;
        near(contractorShare / cf.profitOil, splits[i], 1e-9);
      }
    });
    // And each step happens exactly where R crosses the tranche threshold.
    rows.forEach((cf, i) => {
      const expected = cf.rFactor >= 2.5 ? 0.3 : cf.rFactor >= 1.6 ? 0.4 : 0.6;
      expect(splits[i]).toBe(expected);
    });
  });

  test('the R-factor can fall back through a threshold late in life, and the split follows it up again', () => {
    const c = G.cashflow.find((x) => x.id === 'rfactor_falls_back');
    const rows = calculateCashFlowForRegime(c.regime, c.project);
    const splits = c.expected.cashflow.map((r) => r.contractorSplit);
    const peak = Math.max(...rows.map((cf) => cf.rFactor));
    expect(peak).toBeGreaterThan(2.5);
    expect(rows[rows.length - 1].rFactor).toBeLessThan(2.5);
    expect(splits[splits.length - 1]).toBe(0.4);
    rows.forEach((cf, i) => {
      const expected = cf.rFactor >= 2.5 ? 0.3 : cf.rFactor >= 1.6 ? 0.4 : 0.6;
      expect(splits[i]).toBe(expected);
      if (cf.profitOil > 0) {
        const contractorShare = cf.contractorNCF + cf.tax + cf.opex + cf.capex - cf.costRecovered;
        near(contractorShare / cf.profitOil, splits[i], 1e-9);
      }
    });
  });

  test('the sliding royalty on the default project steps 12.5 -> 15 when the deck reaches $80 in year 10', () => {
    const c = G.cashflow.find((x) => x.id === 'sliding_royalty_price_deck_crossing');
    const rows = calculateCashFlowForRegime(c.regime, c.project);
    rows.forEach((cf, i) => {
      near(cf.royalty / cf.grossRevenue, c.expected.cashflow[i].royaltyRate, 1e-12);
      expect(c.expected.cashflow[i].royaltyRate).toBe(cf.year >= 10 ? 0.15 : 0.125);
    });
  });

  test('a price below every sliding tier takes the first tier', () => {
    const c = G.cashflow.find((x) => x.id === 'price_below_every_threshold');
    const rows = calculateCashFlowForRegime(c.regime, c.project, 1, 0.5);
    rows.forEach((cf) => near(cf.royalty / cf.grossRevenue, 0.125, 1e-12));
  });

  test('a project that never recovers its cost: pool never clears, no payback, no IRR (no-root)', () => {
    const c = G.cashflow.find((x) => x.id === 'never_recovers_huge_capex');
    const rows = calculateCashFlowForRegime(c.regime, c.project);
    expect(rows.every((cf) => cf.unrecoveredCostPool > 0)).toBe(true);
    expect(rows.every((cf) => cf.cumulativeNCF < 0)).toBe(true);
    expect(calculateIRR(rows)).toBeNull();
    expect(calculateIRRResult(rows).irrStatus).toBe('no-root');
    expect(c.expected.paybackYear).toBeNull();
  });
});

// The fiscal IRR before EC2-5, kept only as the negative control.
const retiredIRR = (cashFlows) => {
  const hasNeg = cashFlows.some((cf) => cf.contractorNCF < 0);
  const hasPos = cashFlows.some((cf) => cf.contractorNCF > 0);
  if (!hasNeg || !hasPos) return 0;
  const npvAt = (ratePct) => calculateNPV(cashFlows, ratePct);
  if (npvAt(0) <= 0) return 0;
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 10 && npvAt(hi) > 0; i++) hi *= 2;
  if (npvAt(hi) > 0) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (npvAt(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};

describe('golden agreement: IRR solver (EC2-5)', () => {
  test.each(G.irr.map((c) => [c.id, c]))('%s', (_id, c) => {
    near(calculateNPV(c.cashFlows, 10), c.npvAt10, MONEY);
    gateIrr(calculateIRRResult(c.cashFlows), c.expected);
    if (c.expected.irr !== null) expect(calculateNPV(c.cashFlows, c.expected.irr)).toBeCloseTo(0, 6);
    if (c.trueIrr !== undefined) expect(calculateNPV(c.cashFlows, c.trueIrr)).toBeCloseTo(0, 6);
    (c.trueRoots || []).forEach((r) => expect(calculateNPV(c.cashFlows, r)).toBeCloseTo(0, 6));
  });

  test('negative control: the retired bisection printed 0 or its bracket where the contract reports a status', () => {
    const id = (x) => G.irr.find((c) => c.id === x);
    expect(retiredIRR(id('irr_all_positive_no_sign_change').cashFlows)).toBe(0);
    expect(retiredIRR(id('irr_negative_root_reported').cashFlows)).toBe(0);
    near(calculateIRR(id('irr_negative_root_reported').cashFlows), -10, IRR);
    expect(retiredIRR(id('irr_above_clamp_past_old_bracket').cashFlows)).toBe(102400);
    near(retiredIRR(id('irr_above_clamp_inside_old_bracket').cashFlows), 1400, 1e-9);
    expect(calculateIRR(id('irr_above_clamp_inside_old_bracket').cashFlows)).toBeNull();
    expect(retiredIRR(id('irr_no_root_below_band').cashFlows)).toBe(0);
    // On the multiple-roots flow the retired rule picked one root silently.
    expect(retiredIRR(id('irr_multiple_roots_listed').cashFlows)).toBe(0);
  });

  test('one root in the band and another above it is multiple-roots, not ok (lead decision 2026-09-15)', () => {
    const c = G.cashflow.find((x) => x.id === 'capex_multiplier_0_7');
    const rows = calculateCashFlowForRegime(c.regime, c.project, 0.7, 1);
    const res = calculateIRRResult(rows);
    expect(res.irrStatus).toBe('multiple-roots');
    expect(res.irr).toBeNull();
    expect(res.irrRootAboveBand).toBe(true);
    expect(res.irrRoots).toHaveLength(1);
    near(res.irrRoots[0], -20.4852, 1e-4);
    expect(c.expected.rootsToScan).toHaveLength(2);
    near(c.expected.rootsToScan[1], 1095.4783, 1e-4);
    // Negative controls: the retired bisection read the root above the band,
    // and an in-band-only count would have called -20.4852 'ok'.
    near(retiredIRR(rows), 1095.4783, 1e-4);
    expect(c.expected.rootsToScan.filter((r) => r > -99 && r < 1000)).toHaveLength(1);
    const syn = G.irr.find((x) => x.id === 'irr_root_above_band_with_one_inside');
    expect(calculateIRRResult(syn.cashFlows)).toMatchObject({ irr: null, irrStatus: 'multiple-roots', irrRootAboveBand: true });
  });

  test('a lone root above the band keeps above-clamp with the flag set; every other status carries false', () => {
    G.irr.forEach((c) => {
      const res = calculateIRRResult(c.cashFlows);
      expect(typeof res.irrRootAboveBand).toBe('boolean');
      if (res.irrStatus === 'above-clamp') expect(res.irrRootAboveBand).toBe(true);
      if (res.irrStatus === 'ok' || res.irrStatus === 'no-sign-change' || res.irrStatus === 'no-root') expect(res.irrRootAboveBand).toBe(false);
    });
  });
});

describe('golden agreement: deriveInsights', () => {
  test.each(G.insights.map((c) => [c.id, c]))('%s', (_id, c) => {
    expect(deriveInsights(c.summary, c.sensitivityData)).toEqual(c.expected);
  });
});

describe('golden agreement: runFiscalComparison', () => {
  test.each(G.comparisons.map((c) => [c.id, c]))('%s', async (_id, c) => {
    const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
    const e = c.expected;

    // Summary: same ranking, every field.
    expect(res.summary.map((s) => s.id)).toEqual(e.summary.map((s) => s.id));
    res.summary.forEach((s, i) => {
      const es = e.summary[i];
      expect(s.name).toBe(es.name);
      near(s.npv, es.npv, MONEY);
      gateIrr(s, es);
      expect(s.paybackPeriod).toBe(es.paybackPeriod);
      expect(s.rFactorPayoutYear).toBe(es.rFactorPayoutYear);
      near(s.govTake, es.govTake, MONEY);
      if (es.effectiveTaxRate === null) expect(s.effectiveTaxRate).toBeNull();
      else near(s.effectiveTaxRate, es.effectiveTaxRate, 1e-9);
      // Naming wave: the two named metrics, each against the oracle.
      ['governmentTakePct', 'governmentTakeDiscountedPct', 'governmentShareOfNetRevenuePct'].forEach((k) => {
        if (es[k] === null) expect(s[k]).toBeNull();
        else near(s[k], es[k], 1e-9);
      });
      expect(s.governmentTakeState).toBe(es.governmentTakeState);
      expect(s.governmentTakeDiscountedState).toBe(es.governmentTakeDiscountedState);
      expect(s.discountRatePct).toBe(es.discountRatePct);
    });

    // Annual cash flows per regime, in input order.
    expect(res.annualCashFlows.map((a) => a.regimeId)).toEqual(e.annualCashFlows.map((a) => a.regimeId));
    res.annualCashFlows.forEach((a, i) => gateRows(a.data, e.annualCashFlows[i].data));

    // Price sweep: $40 to $120, government take on profit (WITHOUT the capex
    // add-back), every point with its state. An undefined point is null and
    // never a number (EC2-1).
    expect(res.sensitivityData.price.labels).toEqual(e.sensitivityData.price.labels);
    res.sensitivityData.price.data.forEach((d, i) => {
      const ed = e.sensitivityData.price.data[i];
      expect(d.regimeId).toBe(ed.regimeId);
      expect(d.values).toHaveLength(9);
      expect(d.states).toEqual(ed.states);
      d.values.forEach((v, k) => {
        if (ed.values[k] === null) expect(v).toBeNull();
        else near(v, ed.values[k], 1e-9);
      });
    });

    // Capex sweep: the engine emits 7 of the documented 8 points (pinned).
    expect(e.sensitivityData.capex.labels).toEqual(['0.8', '0.9', '1.0', '1.1', '1.2', '1.3', '1.4', '1.5']);
    expect(res.sensitivityData.capex.labels).toEqual(e.sensitivityData.capex.labels.slice(0, e.engineCapexPoints));
    expect(e.engineCapexPoints).toBe(7);
    res.sensitivityData.capex.data.forEach((d, i) => {
      expect(d.regimeId).toBe(e.sensitivityData.capex.data[i].regimeId);
      expect(d.values).toHaveLength(7);
      d.values.forEach((v, k) => near(v, e.sensitivityData.capex.data[i].values[k], MONEY));
    });

    // Insights: identical to the oracle's rebuild over the 7 points the
    // engine sees; and only the capex sentence can differ from the
    // 8 point rebuild. No verdict needs a tie branch: since EC2-1 (price) and
    // EC2-4 (capex) a lead inside the tie rule declines to rank, so rounding
    // noise can never pick a winner.
    res.insights.forEach((got, i) => {
      const exp = e.insightsAsEngine[i];
      expect(got.key).toBe(exp.key);
      expect(got.label).toBe(exp.label);
      expect(got.text).toBe(exp.text);
    });
    expect(res.insights).toHaveLength(e.insightsAsEngine.length);
    e.insights.forEach((ins) => {
      const got = res.insights.find((x) => x.key === ins.key);
      expect(got).toBeDefined();
      if (ins.key !== 'capex') expect(got.text).toBe(ins.text);
    });
  });

  test('the two effective tax rate definitions are both computed and differ by the capex add-back (recorded)', async () => {
    const c = G.comparisons.find((x) => x.id === 'cmp_designer_defaults');
    const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
    const capex = 500;
    res.summary.forEach((s) => {
      const rows = res.annualCashFlows.find((a) => a.regimeId === s.id).data;
      const gov = rows.reduce((t, cf) => t + cf.governmentTake, 0);
      const con = rows.reduce((t, cf) => t + cf.contractorNCF, 0);
      near(s.effectiveTaxRate, (gov / (gov + con + capex)) * 100, 1e-9);
      // The $70 point of the price sweep is the base price: same cash flow, other definition.
      const sweep = res.sensitivityData.price.data.find((d) => d.regimeId === s.id).values[3];
      near(sweep, (gov / (gov + con)) * 100, 1e-9);
      expect(sweep).toBeGreaterThan(s.effectiveTaxRate);
    });
  });
});

describe('EC2-1: every government share point says what it is', () => {
  const golden = (id) => G.comparisons.find((c) => c.id === id);
  const S = GOVERNMENT_SHARE_STATES;

  test('the published never recovers case: all six regimes undefined at all nine prices, no value, no rank', async () => {
    const c = golden('cmp_never_recovers');
    const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
    const price = res.sensitivityData.price;
    expect(price.data).toHaveLength(6);
    price.data.forEach((d) => {
      expect(d.states).toEqual(Array(9).fill(S.UNDEFINED));
      // Null, never the old zero fallback.
      expect(d.values).toEqual(Array(9).fill(null));
    });
    // The government still collected: the undefined state is about profit, not take.
    res.summary.forEach((s) => expect(s.govTake).toBeGreaterThan(700));
    const verdict = res.insights.find((i) => i.key === 'price');
    expect(verdict.text).toMatch(/^No regime can be ranked across this sweep/);
    expect(verdict.text).toMatch(/No regime is economic at any swept price from 40 to 120 USD per bbl\.$/);
    expect(verdict.text).not.toMatch(/most progressive/);
  });

  test('the barely positive point: Angola with tripled capex exceeds 100 percent at 50 USD per bbl, true value kept', async () => {
    const c = golden('cmp_angola_capex_x3');
    const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
    const [d] = res.sensitivityData.price.data;
    expect(d.states.slice(0, 5)).toEqual([S.UNDEFINED, S.EXCEEDS, S.EXCEEDS, S.SHARE, S.SHARE]);
    expect(d.values[0]).toBeNull();
    near(d.values[1], 2223.0766, 1e-4);
    near(d.values[2], 144.0692, 1e-4);
    near(d.values[3], 85.6015, 1e-4);
    // Recomputed from the ledger, not from the sweep.
    const rows = calculateCashFlowForRegime(c.regimes[0], c.project, 1, 50 / c.project.prices[0].oil);
    const gov = rows.reduce((t, x) => t + x.governmentTake, 0);
    const ncf = rows.reduce((t, x) => t + x.contractorNCF, 0);
    expect(gov + ncf).toBeGreaterThan(0);
    expect(ncf).toBeLessThan(0);
    near(d.values[1], (gov / (gov + ncf)) * 100, 1e-9);
  });

  test('classifyGovernmentShare: the three states at their boundaries', () => {
    expect(classifyGovernmentShare(10, -10)).toEqual({ value: null, state: S.UNDEFINED });
    expect(classifyGovernmentShare(10, -20)).toEqual({ value: null, state: S.UNDEFINED });
    expect(classifyGovernmentShare(50, 0)).toEqual({ value: 100, state: S.SHARE });
    expect(classifyGovernmentShare(0, 50)).toEqual({ value: 0, state: S.SHARE });
    const over = classifyGovernmentShare(50, -1);
    expect(over.state).toBe(S.EXCEEDS);
    near(over.value, 5000 / 49, 1e-9);
    expect(classifyGovernmentShare(NaN, 1).state).toBe(S.UNDEFINED);
  });

  test('no golden sweep point is a zero standing in for a missing value', () => {
    G.comparisons.forEach((c) => c.expected.sensitivityData.price.data.forEach((d) => {
      d.values.forEach((v, k) => {
        expect(v === null).toBe(d.states[k] === S.UNDEFINED);
        if (d.states[k] === S.EXCEEDS) expect(v).toBeGreaterThan(100);
        if (d.states[k] === S.SHARE) expect(v >= 0 && v <= 100).toBe(true);
      });
    }));
  });

  test('commonShareWindow takes the longest run where every series is a share, the later one on a tie', () => {
    const st = (str) => ({ states: [...str].map((ch) => ({ s: S.SHARE, x: S.EXCEEDS, u: S.UNDEFINED }[ch])), values: [] });
    expect(commonShareWindow([st('ssuss'), st('sssss')], 5)).toEqual({ start: 3, end: 4, length: 2 });
    expect(commonShareWindow([st('xssss'), st('sssus')], 5)).toEqual({ start: 1, end: 2, length: 2 });
    expect(commonShareWindow([st('uuu'), st('sss')], 3)).toBeNull();
  });

  test('the window is recorded on every comparison golden and the price verdict agrees with it', () => {
    G.comparisons.forEach((c) => {
      const e = c.expected;
      const w = e.priceWindow;
      const verdict = e.insightsAsEngine.find((i) => i.key === 'price');
      if (!verdict) return;
      if (/most progressive/.test(verdict.text)) {
        expect(w.length).toBeGreaterThanOrEqual(3);
        const sorted = e.priceClimbs.map((x) => x.climb).sort((a, b) => b - a);
        expect(sorted[0] - sorted[1]).toBeGreaterThanOrEqual(1);
      }
    });
  });
});

describe('naming wave: government take and government share of net revenue', () => {
  const golden = (id) => G.comparisons.find((c) => c.id === id);

  test('no computation changed: share of net revenue IS the legacy summary rate and take IS the sweep at the deck price', async () => {
    for (const c of G.comparisons) {
      // eslint-disable-next-line no-await-in-loop
      const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
      const basePrice = c.project.prices[0].oil;
      const at = res.sensitivityData.price.labels.indexOf(basePrice);
      res.summary.forEach((s) => {
        // EC2-2: the deprecated alias IS the named field, null included.
        expect(s.effectiveTaxRate).toBe(s.governmentShareOfNetRevenuePct);
        if (at >= 0) {
          const sweep = res.sensitivityData.price.data.find((d) => d.regimeId === s.id);
          expect(s.governmentTakeState).toBe(sweep.states[at]);
          if (sweep.values[at] === null) expect(s.governmentTakePct).toBeNull();
          else near(s.governmentTakePct, sweep.values[at], 1e-9);
        }
      });
    }
  });

  test('the headline is larger than the add-back metric wherever both are ordinary shares', async () => {
    const c = golden('cmp_all_templates_default_project');
    const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
    res.summary.forEach((s) => {
      expect(s.governmentTakeState).toBe('share');
      expect(s.governmentTakePct).toBeGreaterThan(s.governmentShareOfNetRevenuePct);
    });
  });

  test('the discounted variant is the ratio of year-end present values, recomputed by hand', async () => {
    const c = golden('cmp_designer_defaults');
    const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
    const r = c.project.discountRate / 100;
    res.summary.forEach((s) => {
      const rows = res.annualCashFlows.find((a) => a.regimeId === s.id).data;
      let pvGov = 0;
      let pvNcf = 0;
      rows.forEach((cf) => { pvGov += cf.governmentTake / (1 + r) ** cf.year; pvNcf += cf.contractorNCF / (1 + r) ** cf.year; });
      near(s.governmentTakeDiscountedPct, (pvGov / (pvGov + pvNcf)) * 100, 1e-9);
      // Negative control: discounting moves the number, so the field grades something.
      expect(Math.abs(s.governmentTakeDiscountedPct - s.governmentTakePct)).toBeGreaterThan(1);
    });
  });

  test('never recovers: take is undefined undiscounted and discounted, share of net revenue is still a number', async () => {
    const c = golden('cmp_never_recovers');
    const res = await runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });
    res.summary.forEach((s) => {
      expect(s.governmentTakePct).toBeNull();
      expect(s.governmentTakeState).toBe('undefined');
      expect(s.governmentTakeDiscountedPct).toBeNull();
      expect(s.governmentShareOfNetRevenuePct).toBeGreaterThan(0);
    });
  });

  test('takeMetrics returns null, never zero, when revenue less opex is not positive', () => {
    const rows = [{ year: 1, governmentTake: 0, contractorNCF: -50, capex: 10 }];
    const m = takeMetrics(rows);
    expect(m.governmentTake).toBeNull();
    expect(m.governmentTakeState).toBe('undefined');
    expect(m.governmentShareOfNetRevenue).toBeNull();
  });

  test('conventions: both definitions, basis labels and export header lines', () => {
    expect(FISCAL_METRICS.governmentTake.role).toBe('headline');
    expect(FISCAL_METRICS.governmentShareOfNetRevenue.role).toBe('secondary');
    expect(FISCAL_METRICS.governmentTake.definition).toMatch(/revenue less opex less capex/);
    expect(FISCAL_METRICS.governmentShareOfNetRevenue.definition).toMatch(/revenue less opex over the project life, so capex is added back/);
    expect(basisLabel()).toBe('undiscounted');
    expect(basisLabel(10)).toBe('discounted at 10 percent');
    expect(metricLabel('governmentTake')).toBe('Government take (undiscounted)');
    expect(metricPhrase('governmentShareOfNetRevenue', 12.5)).toBe('government share of net revenue (discounted at 12.5 percent)');
    expect(metricDefinition('governmentTake', 10)).toMatch(/^Government take \(discounted at 10 percent\): /);
    expect(exportHeaderLines([{ key: 'governmentTake' }, { key: 'governmentShareOfNetRevenue' }])).toHaveLength(2);
    expect(GOVERNMENT_CASH_FLOW.definition).toMatch(/Royalty plus/);
    expect(() => metricLabel('effectiveTaxRate')).toThrow();
    // Copy rule: no em dashes, and neither definition calls itself a tax rate.
    const words = JSON.stringify(FISCAL_METRICS) + JSON.stringify(GOVERNMENT_CASH_FLOW);
    expect(words).not.toMatch(/\u2014/);
    expect(words.toLowerCase()).not.toMatch(/tax rate/);
  });

  test('no verdict the engine prints says "government share" or "effective tax rate"', () => {
    const texts = [
      ...G.insights.flatMap((c) => c.expected.map((i) => i.text)),
      ...G.comparisons.flatMap((c) => [...c.expected.insights, ...c.expected.insightsAsEngine].map((i) => i.text)),
    ];
    expect(texts.length).toBeGreaterThan(20);
    texts.forEach((t) => {
      expect(t).not.toMatch(/government share/i);
      expect(t).not.toMatch(/effective tax rate/i);
      if (/government take/.test(t)) expect(t).toMatch(/government take \((undiscounted|discounted at [0-9.]+ percent)\)|every regime's government take is within|a government take within/);
    });
  });
});

describe('EC2 owner decisions, 2026-09-15', () => {
  const golden = (id) => G.comparisons.find((c) => c.id === id);
  const run = (c) => runFiscalComparison({ projectInputs: c.project, regimes: c.regimes });

  describe('EC2-2: effectiveTaxRate is a deprecated alias, with no zero fallback', () => {
    // The legacy computation, kept only to prove no defined value moved.
    const legacyRate = (rows, capex) => {
      const gov = rows.reduce((t, cf) => t + cf.governmentTake, 0);
      const con = rows.reduce((t, cf) => t + cf.contractorNCF, 0) + capex;
      return gov + con > 0 ? (gov / (gov + con)) * 100 : 0;
    };

    test('no value changed wherever the share is defined, on every comparison golden', async () => {
      let compared = 0;
      for (const c of G.comparisons) {
        // eslint-disable-next-line no-await-in-loop
        const res = await run(c);
        const capex = c.project.costs.capex.drilling + c.project.costs.capex.facilities + c.project.costs.capex.subsea;
        res.summary.forEach((s) => {
          const rows = res.annualCashFlows.find((a) => a.regimeId === s.id).data;
          expect(s.governmentShareOfNetRevenuePct).not.toBeNull();
          near(s.effectiveTaxRate, legacyRate(rows, capex), 1e-9);
          compared += 1;
        });
      }
      expect(compared).toBeGreaterThan(20);
    });

    test('where revenue less opex is not positive the alias is null; the retired rule printed 0 (negative control)', async () => {
      const c = golden('cmp_designer_defaults');
      const project = { ...c.project, prices: [{ year: 1, oil: 0.5, gas: 0, ngl: 0 }] };
      const res = await runFiscalComparison({ projectInputs: project, regimes: c.regimes });
      res.summary.forEach((s) => {
        expect(s.governmentShareOfNetRevenuePct).toBeNull();
        expect(s.effectiveTaxRate).toBeNull();
        const rows = res.annualCashFlows.find((a) => a.regimeId === s.id).data;
        expect(legacyRate(rows, 500)).toBe(0);
      });
    });
  });

  describe('EC2-4: the capex verdict uses the price verdict\'s tie rule', () => {
    test('leadOrTie: a lead of at least the spread ranks, a smaller one names every tied item', () => {
      const items = [{ n: 'a', v: 10 }, { n: 'b', v: 10.05 }, { n: 'c', v: 20 }];
      const least = leadOrTie(items, 'v', 0.1, 'min');
      expect(least.ranked).toBe(false);
      expect(least.tied.map((x) => x.n)).toEqual(['a', 'b']);
      const most = leadOrTie(items, 'v', 0.1, 'max');
      expect(most.ranked).toBe(true);
      expect(most.tied.map((x) => x.n)).toEqual(['c']);
      // The first of equal items leads, as the strict reduce chose.
      expect(leadOrTie([{ n: 'x', v: 1 }, { n: 'y', v: 1 }], 'v', 0.1, 'max').leader.n).toBe('x');
      expect(CAPEX_RESILIENCE_MIN_SPREAD_MM).toBe(0.1);
    });

    test('cmp_never_recovers: six equal losses rank nobody; the retired strict reduce named a winner (negative control)', async () => {
      const c = golden('cmp_never_recovers');
      const res = await run(c);
      const text = res.insights.find((i) => i.key === 'capex').text;
      expect(text).toMatch(/^No regime can be ranked on resilience to cost overrun/);
      expect(text).not.toMatch(/gives up the least/);
      c.regimes.forEach((r) => expect(text).toContain(`"${r.name}"`));
      const losses = res.sensitivityData.capex.data.map((d) => ({
        name: c.regimes.find((r) => r.id === d.regimeId).name,
        loss: d.values[0] - d.values[d.values.length - 1],
      }));
      const retired = losses.reduce((a, b) => (b.loss < a.loss ? b : a));
      expect(retired.name).toBeTruthy();
      expect(Math.max(...losses.map((l) => l.loss)) - Math.min(...losses.map((l) => l.loss))).toBeLessThan(1e-6);
    });
  });

  describe('EC2-8: tiers are selected in threshold order; a repeated threshold is refused', () => {
    // List-order selection, the retired rule, for the negative control.
    const retiredPick = (x, tiers, field) => {
      let v = tiers[0][field];
      tiers.forEach((t) => { if (x >= t.threshold) v = t[field]; });
      return v;
    };

    test('an unsorted table gives the sorted table\'s ledger, row for row', () => {
      const unsorted = G.cashflow.find((x) => x.id === 'tiers_unsorted_selected_by_threshold');
      const sorted = G.cashflow.find((x) => x.id === 'rfactor_tranche_crossing');
      const a = calculateCashFlowForRegime(unsorted.regime, unsorted.project);
      const b = calculateCashFlowForRegime(sorted.regime, sorted.project);
      a.forEach((row, i) => ROW_FIELDS.forEach((k) => expect(row[k]).toBe(b[i][k])));
      // Negative control: list order would have picked other rates and splits.
      const r = unsorted.regime;
      const wrongRoyalty = retiredPick(80, r.royalty.tiers, 'rate');
      expect(wrongRoyalty).toBe(7.5);
      const wrongSplits = a.map((row) => retiredPick(row.rFactor, r.profitSplit.tiers, 'split') / 100);
      const rightSplits = unsorted.expected.cashflow.map((row) => row.contractorSplit);
      expect(wrongSplits.some((w, i) => w !== rightSplits[i])).toBe(true);
    });

    test('orderedTierTable returns a sorted copy and leaves the input alone', () => {
      const tiers = [{ threshold: 2, split: 1 }, { threshold: 1, split: 2 }];
      expect(orderedTierTable({ name: 'R' }, 'profit split', tiers).map((t) => t.threshold)).toEqual([1, 2]);
      expect(tiers.map((t) => t.threshold)).toEqual([2, 1]);
    });

    test.each(G.tierRefusals.map((c) => [c.id, c]))('%s', (_id, c) => {
      const { regime, table, threshold } = c.refused;
      let message = '';
      try {
        calculateCashFlowForRegime(c.regime, c.project);
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
        message = err.message;
      }
      expect(message).toContain(`"${regime}"`);
      expect(message).toContain(`the ${table} tier table`);
      expect(message).toContain(`threshold ${threshold}`);
      // Negative control: the retired selection accepted the table silently.
      const tiers = table === 'royalty' ? c.regime.royalty.tiers : c.regime.profitSplit.tiers;
      expect(() => retiredPick(threshold, tiers, table === 'royalty' ? 'rate' : 'split')).not.toThrow();
    });
  });

  describe('EC2-9: the corrected golden notes say what the numbers say', () => {
    const cf = (id) => G.cashflow.find((x) => x.id === id);

    test('capped_5pct_pool_never_clears pays back in year 3 and its NPV is zero at 54.6792 and -14.2614 percent', () => {
      const c = cf('capped_5pct_pool_never_clears');
      expect(c.expected.paybackYear).toBe(3);
      expect(c.expected.finalUnrecoveredPool).toBeGreaterThan(1000);
      near(c.expected.irrRoots[1], 54.6792, 1e-4);
      near(c.expected.irrRoots[0], -14.2614, 1e-4);
      expect(c.note).toMatch(/year 3/);
      expect(c.note).toMatch(/54\.6792/);
      expect(c.note).not.toMatch(/no payback|IRR 0/);
      expect(G.cashflow.some((x) => x.id === 'capped_5pct_never_recovers')).toBe(false);
    });

    test('rfactor_tranche_crossing: R reaches 1.0 in year 2, 1.6 in year 3 and 2.5 in year 6', () => {
      const c = cf('rfactor_tranche_crossing');
      const first = (t) => c.expected.cashflow.find((r) => r.rFactor >= t).year;
      expect([first(1.0), first(1.6), first(2.5)]).toEqual([2, 3, 6]);
      expect(c.note).toMatch(/1\.0 in year 2, 1\.6 in year 3 and 2\.5 in year 6/);
    });

    test('rfactor_falls_back peaks at 2.972625 in year 11 and the split steps back up in year 23', () => {
      const c = cf('rfactor_falls_back');
      const peak = c.expected.cashflow.reduce((a, b) => (b.rFactor > a.rFactor ? b : a));
      near(peak.rFactor, 2.972625, 1e-6);
      expect(peak.year).toBe(11);
      expect(c.expected.cashflow[22].contractorSplit).toBe(0.4);
      expect(c.expected.cashflow[21].contractorSplit).toBe(0.3);
      expect(c.note).toMatch(/2\.972625 in year 11/);
      expect(c.note).not.toMatch(/just above 2\.5/);
    });
  });

  describe('EC2-10: payback names every regime at the winning year', () => {
    test('cmp_all_templates_default_project: all four year-3 regimes are named; the retired reduce named one (negative control)', async () => {
      const c = golden('cmp_all_templates_default_project');
      const res = await run(c);
      const text = res.insights.find((i) => i.key === 'payback').text;
      const atThree = res.summary.filter((s) => s.paybackPeriod === 3);
      expect(atThree).toHaveLength(4);
      atThree.forEach((s) => expect(text).toContain(`"${s.name}"`));
      expect(text).toMatch(/ pay back in year 3, against year 4 for /);
      const retired = res.summary.reduce((a, b) => (b.paybackPeriod < a.paybackPeriod ? b : a));
      expect(`"${retired.name}" pays back in year 3`).not.toBe(text.slice(0, text.indexOf(',')));
    });
  });

  describe('EC2-11: one money formatter, no "$..MM" in any sentence', () => {
    test.each(G.moneyFormat.map((c) => [c.id, c]))('%s', (_id, c) => {
      expect(formatMillionUSD(c.value)).toBe(c.expected);
    });

    test('every engine sentence in the goldens is free of the shorthand and of em dashes', () => {
      const texts = [
        ...G.insights.flatMap((c) => c.expected.map((i) => i.text)),
        ...G.comparisons.flatMap((c) => [...c.expected.insights, ...c.expected.insightsAsEngine].map((i) => i.text)),
      ];
      expect(texts.filter((t) => /million USD/.test(t)).length).toBeGreaterThan(40);
      texts.forEach((t) => {
        expect(t).not.toMatch(/\$/);
        expect(t).not.toMatch(/MM\b/);
        expect(t).not.toMatch(/\u2014/);
      });
    });

    test('negative control: the retired format is a different string', () => {
      const retired = (v) => `$${v.toFixed(1)}MM`;
      expect(retired(1339.3)).toBe('$1339.3MM');
      expect(formatMillionUSD(1339.3)).toBe('1,339.3 million USD');
    });
  });
});
