// The NPV-only path of the screening engine (calculateEconomics(inputs,
// { skipIrr: true })), used by the breakeven price solve and every Monte Carlo
// iteration.
//
// Since EC6-1 the IRR search sweeps and bisects the whole rate band whenever
// Newton does not land on a verified root or the flow changes sign more than
// once. A breakeven run calls the engine about a hundred times per iteration,
// so on a profile whose late years lose money a 5000 iteration run took minutes
// (probe: 264 ms per iteration against 8 ms). These gates pin that skipping the
// IRR changes nothing a caller reads except the IRR itself, and that it is the
// fast path.

import fs from 'fs';
import path from 'path';
import { calculateEconomics } from '../engines/economics/screening.js';
import { npvAtPrice, generateBreakevenData } from '../engines/economics/breakeven.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'screening_cases.json'),
  'utf8',
));

const GROUPS = ['taxRoyalty', 'fdp', 'psc', 'irr', 'payback', 'depreciation', 'horizon', 'sweeps'];

describe('skipIrr changes nothing but the IRR', () => {
  test.each(GROUPS.flatMap((g) => G[g].map((c) => [`${g}/${c.id}`, c])))('%s', (_id, c) => {
    const full = calculateEconomics(c.inputs);
    const fast = calculateEconomics(c.inputs, { skipIrr: true });
    expect(fast.cashflow).toEqual(full.cashflow);
    const { irr, irrStatus, irrRoots, ...rest } = fast.metrics;
    const { irr: _i, irrStatus: _s, irrRoots: _r, ...fullRest } = full.metrics;
    expect(rest).toEqual(fullRest);
    expect(irr).toBeNull();
    expect(irrStatus).toBe('not-computed');
    expect(irrRoots).toBeNull();
  });

  test('no option, or skipIrr other than true, still computes the IRR', () => {
    const c = G.irr.find((x) => x.id === 'irr_known_21pct');
    expect(calculateEconomics(c.inputs).metrics.irr).toBeCloseTo(21, 3);
    expect(calculateEconomics(c.inputs, {}).metrics.irr).toBeCloseTo(21, 3);
    expect(calculateEconomics(c.inputs, { skipIrr: 'yes' }).metrics.irr).toBeCloseTo(21, 3);
  });
});

describe('the breakeven solve and the Monte Carlo take the fast path', () => {
  const life = 20;
  const lateLosses = {
    startYear: 2030, projectLife: life, discountRate: 10, fiscalType: 'TaxRoyalty',
    production: { oil: Array.from({ length: life }, (_, i) => (i === 0 ? 0 : 3e6 * 0.85 ** (i - 1))), gas: Array(life).fill(0) },
    price: { oil: Array(life).fill(70), gas: Array(life).fill(0) },
    capex: [800, ...Array(life - 1).fill(0)], opexFixed: Array(life).fill(60),
    opexVariable: Array(life).fill(0), abandonment: Array(life).fill(0), royaltyRate: 12.5, taxRate: 30,
  };

  const perCall = (fn, n) => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < n; i += 1) fn();
    return Number(process.hrtime.bigint() - t) / 1e6 / n;
  };

  test('NEGATIVE CONTROL: the full engine is the slow path on a flow whose IRR search sweeps', () => {
    expect(['multiple-roots', 'no-root', 'above-clamp']).toContain(calculateEconomics(lateLosses).metrics.irrStatus);
    const full = perCall(() => calculateEconomics(lateLosses), 60);
    const fast = perCall(() => calculateEconomics(lateLosses, { skipIrr: true }), 60);
    expect(full / fast).toBeGreaterThan(5);
  });

  test('npvAtPrice equals the full engine NPV', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ year: 2026 + i, oil_production_bbl: 3e6 * 0.85 ** i }));
    const args = { rows, discountRate: 10, royaltyRate: 12.5, taxRate: 30, capexMM: 1000, opexMM: 60, efficiency: 0.9, price: 80 };
    const capex = new Array(20).fill(0); capex[0] = 1000;
    const full = calculateEconomics({
      startYear: 2026, projectLife: 20, discountRate: 10, fiscalType: 'TaxRoyalty',
      production: { oil: rows.map((r) => r.oil_production_bbl * 0.9), gas: new Array(20).fill(0) },
      price: { oil: new Array(20).fill(80), gas: new Array(20).fill(0) }, capex,
      opexFixed: new Array(20).fill(60), opexVariable: new Array(20).fill(0), abandonment: new Array(20).fill(0),
      royaltyRate: 12.5, taxRate: 30,
    }).metrics.npv;
    expect(npvAtPrice(args)).toBe(full);
  });

  test('a breakeven run on a late-loss profile completes in well under a second per hundred iterations', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ year: 2026 + i, oil_production_bbl: 3e6 * 0.85 ** i }));
    const t = Date.now();
    generateBreakevenData({
      iterations: 100, discountRate: 10, royaltyRate: 12.5, taxRate: 30, targetNpv: 0, seed: 7,
      productionData: { data: rows },
      variables: [
        { id: 1, name: 'Total CAPEX ($MM)', p10: 800, p50: 1000, p90: 1300 },
        { id: 2, name: 'Annual OPEX ($MM/year)', p10: 50, p50: 60, p90: 75 },
        { id: 3, name: 'Production Efficiency (%)', p10: 85, p50: 90, p90: 95 },
      ],
    });
    // Before the fix this took about 26 seconds; allow generous headroom for a loaded CI box.
    expect(Date.now() - t).toBeLessThan(8000);
  });
});
