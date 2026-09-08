// Probabilistic breakeven gates (engines/economics/breakeven.js, the Suite's
// breakevenCalculations.js, EC0 extraction 2026-09-08).
//
// Three layers: (a) the parity identity that makes a breakeven price mean
// anything (feeding it back into the screening engine lands on the target
// NPV), (b) agreement with the independent stdlib oracle
// (tools/validation/economics/oracle_breakeven.py) through its committed
// goldens, and (c) every test the Suite already had, ported verbatim with
// the imports repointed.
//
// The oracle reaches every number by a different road: the breakeven price
// is solved in CLOSED FORM on the piecewise-linear NPV(price) where the
// engine bisects 100 times; the seeded sample is replayed through a
// bit-for-bit mulberry32 and an independently fitted triangular, so the
// whole sorted sample, every percentile, the tornado, the fit notes and the
// insight sentence are compared, not just a summary.
//
// Tolerances (absolute): price $/bbl 1e-8, NPV $MM 1e-6, fit parameters 1e-9.

import fs from 'fs';
import path from 'path';
import {
  generateBreakevenData,
  solveBreakevenPrice,
  npvAtPrice,
  DEFAULT_SEED,
} from '../engines/economics/breakeven.js';
import { calculateEconomics } from '../engines/economics/screening.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'breakeven_cases.json'),
  'utf8',
));

const PRICE = 1e-8;
const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

const rows = Array.from({ length: 10 }, (_, i) => ({
  year: 2026 + i,
  oil_production_bbl: 3_000_000 * (0.85 ** i),
}));

const base = {
  rows,
  discountRate: 10,
  royaltyRate: 12.5,
  taxRate: 30,
  capexMM: 1000,
  opexMM: 60,
  efficiency: 0.9,
};

const inputs = {
  iterations: 300,
  discountRate: 10,
  royaltyRate: 12.5,
  taxRate: 30,
  targetNpv: 0,
  productionData: { data: rows },
  variables: [
    { id: 1, name: 'Total CAPEX ($MM)', p10: 800, p50: 1000, p90: 1300 },
    { id: 2, name: 'Annual OPEX ($MM/year)', p10: 50, p50: 60, p90: 75 },
    { id: 3, name: 'Production Efficiency (%)', p10: 85, p50: 90, p90: 95 },
  ],
};

// ---------------------------------------------------------------------
// (a) and (c): the Suite's tests, ported.
// ---------------------------------------------------------------------

describe('breakeven price solve', () => {
  test('PARITY: the solved price zeroes the sanctioned engine, not a private one', () => {
    const price = solveBreakevenPrice(base, 0);
    expect(price).toBeGreaterThan(0);

    const projectLife = rows.length;
    const capex = new Array(projectLife).fill(0);
    capex[0] = base.capexMM;
    const econ = calculateEconomics({
      startYear: rows[0].year,
      projectLife,
      discountRate: base.discountRate,
      fiscalType: 'TaxRoyalty',
      production: {
        oil: rows.map((r) => r.oil_production_bbl * base.efficiency),
        gas: new Array(projectLife).fill(0),
      },
      price: {
        oil: new Array(projectLife).fill(price),
        gas: new Array(projectLife).fill(0),
      },
      capex,
      opexFixed: new Array(projectLife).fill(base.opexMM),
      opexVariable: new Array(projectLife).fill(0),
      abandonment: new Array(projectLife).fill(0),
      royaltyRate: base.royaltyRate,
      taxRate: base.taxRate,
    });
    expect(econ.metrics.npv).toBeCloseTo(0, 6);
  });

  test('solves a non-zero NPV target too', () => {
    const price = solveBreakevenPrice(base, 250);
    expect(npvAtPrice({ ...base, price })).toBeCloseTo(250, 6);
    expect(price).toBeGreaterThan(solveBreakevenPrice(base, 0));
  });

  test('NPV is monotone in price, which is what makes bisection legitimate', () => {
    let prev = -Infinity;
    for (let p = 10; p <= 200; p += 10) {
      const npv = npvAtPrice({ ...base, price: p });
      expect(npv).toBeGreaterThan(prev);
      prev = npv;
    }
  });

  test('an unreachable target returns null rather than a fabricated price', () => {
    expect(solveBreakevenPrice(base, 5e5)).toBeNull();
  });

  test('higher costs raise the breakeven, higher efficiency lowers it', () => {
    const b = solveBreakevenPrice(base, 0);
    expect(solveBreakevenPrice({ ...base, capexMM: 1300 }, 0)).toBeGreaterThan(b);
    expect(solveBreakevenPrice({ ...base, opexMM: 75 }, 0)).toBeGreaterThan(b);
    expect(solveBreakevenPrice({ ...base, efficiency: 0.95 }, 0)).toBeLessThan(b);
  });
});

describe('probabilistic run', () => {
  test('REPRODUCIBLE: the same seed gives the identical distribution', () => {
    const a = generateBreakevenData({ ...inputs, seed: 12345 });
    const b = generateBreakevenData({ ...inputs, seed: 12345 });
    expect(a.kpis).toEqual(b.kpis);
    expect(a.plotData.histogram.x).toEqual(b.plotData.histogram.x);
  });

  test('a different seed gives a different sample but a similar distribution', () => {
    const a = generateBreakevenData({ ...inputs, seed: 1 });
    const b = generateBreakevenData({ ...inputs, seed: 2 });
    expect(a.plotData.histogram.x).not.toEqual(b.plotData.histogram.x);
    expect(Math.abs(a.kpis.p50 - b.kpis.p50) / a.kpis.p50).toBeLessThan(0.05);
  });

  test('the default seed is used and reported when none is given', () => {
    const r = generateBreakevenData(inputs);
    expect(r.seed).toBe(DEFAULT_SEED);
    expect(r.insights).toContain(String(DEFAULT_SEED));
  });

  test('percentiles are ordered and bracket the deterministic base case', () => {
    const r = generateBreakevenData({ ...inputs, seed: 7 });
    expect(r.kpis.p10).toBeLessThan(r.kpis.p50);
    expect(r.kpis.p50).toBeLessThan(r.kpis.p90);
    expect(r.baseBreakeven).toBeGreaterThan(r.kpis.p10);
    expect(r.baseBreakeven).toBeLessThan(r.kpis.p90);
  });

  test('the fitted ranges extend beyond the stated percentiles', () => {
    const r = generateBreakevenData({ ...inputs, seed: 7 });
    expect(r.distributionFits.capex.min).toBeLessThan(800);
    expect(r.distributionFits.capex.max).toBeGreaterThan(1300);
    expect(Math.min(...r.plotData.histogram.x))
      .toBeLessThan(r.kpis.p10);
  });

  test('the tornado carries BOTH sides of every swing', () => {
    const r = generateBreakevenData({ ...inputs, seed: 7 });
    expect(r.tornadoData.low).toHaveLength(3);
    expect(r.tornadoData.high).toHaveLength(3);
    r.tornadoData.low.forEach((lowSide, i) => {
      expect(lowSide).toBeLessThan(0);
      expect(r.tornadoData.high[i]).toBeGreaterThan(0);
    });
    const spans = r.tornadoData.high.map((h, i) => h - r.tornadoData.low[i]);
    expect(spans[0]).toBeGreaterThanOrEqual(spans[1]);
    expect(spans[1]).toBeGreaterThanOrEqual(spans[2]);
  });

  test('missing production data and missing variables both fail loudly', () => {
    expect(() => generateBreakevenData({ ...inputs, productionData: null }))
      .toThrow(/Production data/);
    expect(() => generateBreakevenData({ ...inputs, variables: [] }))
      .toThrow(/required/);
  });
});

// ---------------------------------------------------------------------
// (b) Golden agreement with the independent oracle.
// ---------------------------------------------------------------------

describe('golden agreement: solveBreakevenPrice against the closed form', () => {
  test.each(G.solve.map((c) => [c.id, c]))('%s', (_id, c) => {
    const price = solveBreakevenPrice(c.args, c.targetNpv);
    near(npvAtPrice({ ...c.args, price: 500 }), c.expected.npvAt500, 1e-6);
    if (c.expected.price === null) {
      expect(price).toBeNull();
    } else {
      near(price, c.expected.price, PRICE);
      near(npvAtPrice({ ...c.args, price }), c.expected.npvAtPrice, 1e-6);
      near(npvAtPrice({ ...c.args, price }), c.targetNpv, 1e-6);
    }
  });

  test('breakeven is exactly discounted cost over discounted net barrels when there is no tax', () => {
    const c = G.solve.find((x) => x.id === 'solve_no_fiscal');
    const r = 0.1;
    const w = (i) => 1 / Math.pow(1 + r, i + 0.5);
    const cost = rows.reduce((s, _, i) => s + w(i) * (c.args.opexMM + (i === 0 ? c.args.capexMM : 0)), 0);
    const bbl = rows.reduce((s, row, i) => s + w(i) * row.oil_production_bbl * c.args.efficiency / 1e6, 0);
    near(solveBreakevenPrice(c.args, 0), cost / bbl, 1e-9);
  });
});

describe('golden agreement: generateBreakevenData, the whole seeded sample', () => {
  const runs = G.monteCarlo.filter((c) => !c.expected.throws);
  test.each(runs.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = generateBreakevenData(c.inputs);
    const e = c.expected;
    expect(r.seed).toBe(e.seed);
    expect(r.excludedIterations).toBe(e.excludedIterations);
    expect(r.plotData.histogram.x).toHaveLength(e.sample.length);
    r.plotData.histogram.x.forEach((v, i) => near(v, e.sample[i], PRICE));
    expect(r.plotData.cdf.x).toEqual(r.plotData.histogram.x);
    r.plotData.cdf.y.forEach((y, i) => near(y, e.cdfY[i], 1e-12));
    ['p10', 'p50', 'p90', 'mean'].forEach((k) => near(r.kpis[k], e.kpis[k], PRICE));
    near(r.baseBreakeven, e.baseBreakeven, PRICE);
    expect(r.tornadoData.y).toEqual(e.tornadoData.y);
    ['low', 'high', 'base'].forEach((k) => r.tornadoData[k].forEach((v, i) => near(v, e.tornadoData[k][i], PRICE)));
    ['capex', 'opex', 'efficiency'].forEach((k) => {
      near(r.distributionFits[k].min, e.distributionFits[k].min, 1e-9);
      near(r.distributionFits[k].mode, e.distributionFits[k].mode, 1e-9);
      near(r.distributionFits[k].max, e.distributionFits[k].max, 1e-9);
      expect(r.distributionFits[k].exact).toBe(e.distributionFits[k].exact);
      expect(r.distributionFits[k].note).toBe(e.distributionFits[k].note);
    });
    expect(r.insights).toBe(e.insights);
  });

  test('P(breakeven < price) read off the sample matches the CDF at every sample point', () => {
    const c = G.monteCarlo.find((x) => x.id === 'mc_default_seed_300');
    const r = generateBreakevenData(c.inputs);
    const n = r.plotData.cdf.x.length;
    [100, 150, 175.15, 200, 250].forEach((price) => {
      const below = r.plotData.histogram.x.filter((v) => v < price).length / n;
      const fromGolden = c.expected.sample.filter((v) => v < price).length / n;
      expect(below).toBe(fromGolden);
      // And the CDF y at the last sample below the price is that probability.
      const idx = r.plotData.cdf.x.findIndex((v) => v >= price);
      const y = idx <= 0 ? 0 : r.plotData.cdf.y[idx - 1];
      near(y, below, 1e-12);
    });
  });

  test('when no iteration breaks even below $500 the engine throws, as the oracle recorded', () => {
    const c = G.monteCarlo.find((x) => x.id === 'mc_all_unreachable_throws');
    expect(c.expected.throws).toBe(true);
    expect(c.expected.excludedIterations).toBe(c.inputs.iterations);
    expect(() => generateBreakevenData(c.inputs)).toThrow(/No iteration broke even/);
  });
});
