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
// declines, tier selection by highest threshold reached, IRR by a tripling
// bracket and the Illinois method where the engine doubles and bisects, and
// the verdict sentences rebuilt with JavaScript toFixed rounding.
//
// ONE PLACE THEY DO NOT AGREE, AND IT IS PINNED. The engine's capex sweep
// accumulates 0.1 in floating point from 0.8 and stops at 1.4000000000000004
// because the next step (1.5000000000000004) fails the `<= 1.5` test, so the
// documented 0.8 to 1.5 sweep has 7 points, not 8. The golden carries the
// 8 point sweep; the gate pins the engine's 7 against the first 7 and the
// capex insight against `insightsAsEngine`, the oracle's rebuild of that
// verdict over the 7 points the engine actually sees.
//
// Tolerances (absolute): money $MM 1e-6, IRR 1e-6 percentage points,
// effective tax rate 1e-9 points.

import fs from 'fs';
import path from 'path';
import {
  calculateCashFlowForRegime,
  calculateNPV,
  calculateIRR,
  deriveInsights,
  runFiscalComparison,
} from '../engines/economics/fiscalRegime.js';
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
  test('IRR is the rate at which NPV is zero', () => {
    const rows = calculateCashFlowForRegime(flatRegime(), project);
    const irr = calculateIRR(rows);
    expect(irr).toBeGreaterThan(0);
    expect(calculateNPV(rows, irr)).toBeCloseTo(0, 6);
  });

  test('no IRR is reported when the cash flow never changes sign', () => {
    const allPositive = [
      { year: 1, contractorNCF: 10 },
      { year: 2, contractorNCF: 20 },
    ];
    expect(calculateIRR(allPositive)).toBe(0);
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

describe.each(['cashflow', 'priceSweep', 'capexSweep'])('golden agreement: %s', (group) => {
  test.each(G[group].map((c) => [c.id, c]))('%s', (_id, c) => {
    const rows = calculateCashFlowForRegime(c.regime, c.project, c.capexMultiplier, c.priceMultiplier);
    gateRows(rows, c.expected.cashflow);
    near(calculateNPV(rows, c.project.discountRate), c.expected.npv, MONEY);
    near(calculateIRR(rows), c.expected.irr, IRR);
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

  test('a project that never recovers its cost: pool never clears, no payback, IRR 0', () => {
    const c = G.cashflow.find((x) => x.id === 'never_recovers_huge_capex');
    const rows = calculateCashFlowForRegime(c.regime, c.project);
    expect(rows.every((cf) => cf.unrecoveredCostPool > 0)).toBe(true);
    expect(rows.every((cf) => cf.cumulativeNCF < 0)).toBe(true);
    expect(calculateIRR(rows)).toBe(0);
    expect(c.expected.paybackYear).toBeNull();
  });
});

describe('golden agreement: IRR solver', () => {
  test.each(G.irr.map((c) => [c.id, c]))('%s', (_id, c) => {
    near(calculateNPV(c.cashFlows, 10), c.npvAt10, MONEY);
    near(calculateIRR(c.cashFlows), c.expected, IRR);
    if (c.engine) {
      // The bracket is reported as the IRR; the true root is far beyond it.
      expect(c.trueIrr).toBeGreaterThan(c.engine.irr);
      expect(calculateNPV(c.cashFlows, c.trueIrr)).toBeCloseTo(0, 6);
    }
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
      near(s.irr, es.irr, IRR);
      expect(s.paybackPeriod).toBe(es.paybackPeriod);
      expect(s.rFactorPayoutYear).toBe(es.rFactorPayoutYear);
      near(s.govTake, es.govTake, MONEY);
      near(s.effectiveTaxRate, es.effectiveTaxRate, 1e-9);
    });

    // Annual cash flows per regime, in input order.
    expect(res.annualCashFlows.map((a) => a.regimeId)).toEqual(e.annualCashFlows.map((a) => a.regimeId));
    res.annualCashFlows.forEach((a, i) => gateRows(a.data, e.annualCashFlows[i].data));

    // Price sweep: $40 to $120, effective tax rate WITHOUT the capex add-back.
    expect(res.sensitivityData.price.labels).toEqual(e.sensitivityData.price.labels);
    res.sensitivityData.price.data.forEach((d, i) => {
      expect(d.regimeId).toBe(e.sensitivityData.price.data[i].regimeId);
      expect(d.values).toHaveLength(9);
      d.values.forEach((v, k) => near(v, e.sensitivityData.price.data[i].values[k], 1e-9));
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
    // 8 point rebuild. A verdict that ranks quantities which are TIED
    // (equal to 1e-6 $MM or 1e-9 points) is decided by rounding noise, so
    // there the gate checks that the regime named is one of the tied set.
    const tied = (list, key, tol) => {
      const sorted = list.map((x) => x[key]).sort((a, b) => a - b);
      return sorted.some((v, i) => i > 0 && Math.abs(v - sorted[i - 1]) <= tol);
    };
    const capexTie = tied(e.capexLossesAsEngine, 'loss', 1e-6);
    const priceTie = tied(e.priceClimbs, 'climb', 1e-9);
    res.insights.forEach((got, i) => {
      const exp = e.insightsAsEngine[i];
      expect(got.key).toBe(exp.key);
      expect(got.label).toBe(exp.label);
      if (got.key === 'capex' && capexTie) {
        const losses = e.capexLossesAsEngine;
        const minLoss = Math.min(...losses.map((l) => l.loss));
        const maxLoss = Math.max(...losses.map((l) => l.loss));
        const least = got.text.match(/"([^"]+)" gives up the least/)[1];
        const most = got.text.match(/and "([^"]+)" the most/)[1];
        expect(Math.abs(losses.find((l) => l.name === least).loss - minLoss)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(losses.find((l) => l.name === most).loss - maxLoss)).toBeLessThanOrEqual(1e-6);
      } else if (got.key === 'price' && priceTie) {
        const climbs = e.priceClimbs;
        const maxClimb = Math.max(...climbs.map((l) => l.climb));
        const name = got.text.match(/^"([^"]+)" is the most progressive/)[1];
        expect(Math.abs(climbs.find((l) => l.name === name).climb - maxClimb)).toBeLessThanOrEqual(1e-9);
      } else {
        expect(got.text).toBe(exp.text);
      }
    });
    expect(res.insights).toHaveLength(e.insightsAsEngine.length);
    e.insights.forEach((ins) => {
      const got = res.insights.find((x) => x.key === ins.key);
      expect(got).toBeDefined();
      if (ins.key !== 'capex' && !(ins.key === 'price' && priceTie)) expect(got.text).toBe(ins.text);
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
