// Prospect valuation (Risked Reserves Valuation T1): lognormal success case,
// commercial chance, EMV after the well, break-even Pg, expectation curve,
// portfolio. Expected values from tools/validation/prospect/oracle_valuation.py
// (statistics.NormalDist and a numerical integral, never this code);
// negcontrol_valuation.sh proves the gates go red.
import fs from 'fs';
import path from 'path';
import {
  valueProspect, expectationCurve, valuePortfolio, lognormalFromP90P10, normCdf, normInv, swansonMean,
} from '../engines/prospect/valuation.js';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'prospect', 'goldens', 'valuation_cases.json'), 'utf8'));
const near = (a, b, rel = G.tolerance) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));

describe.each(G.prospects.map((p) => [p.input.name, p]))('%s', (_n, c) => {
  const v = valueProspect(c.input);
  test('chances, means and money match the oracle', () => {
    near(v.pc, c.expected.pc);
    near(v.pCommercialGivenSuccess, c.expected.pCommercialGivenSuccess);
    near(v.successCase.mean, c.expected.mean);
    near(v.successCase.fittedP50, c.expected.fittedP50);
    near(v.successCase.swansonMean, c.expected.swansonMean);
    near(v.riskedMean, c.expected.riskedMean);
    near(v.emv, c.expected.emv);
    if (c.expected.meanIfCommercial === null) expect(v.meanIfCommercial).toBeNull(); else near(v.meanIfCommercial, c.expected.meanIfCommercial);
    if (c.expected.npvIfCommercial === null) expect(v.npvIfCommercial).toBeNull(); else near(v.npvIfCommercial, c.expected.npvIfCommercial);
    if (c.expected.breakEvenPg === null) expect(v.breakEvenPg).toBeNull(); else near(v.breakEvenPg, c.expected.breakEvenPg);
    near(v.lognormal.sigma, c.expected.sigma);
  });
  test('the risked expectation curve matches point for point', () => {
    expectationCurve(c.input).forEach((pt, i) => { near(pt.volume, c.curve[i].volume); near(pt.exceedance, c.curve[i].exceedance); });
  });
});

test('the portfolio of independent prospects', () => {
  const p = valuePortfolio(G.prospects.map((c) => valueProspect(c.input)));
  for (const k of ['riskedMean', 'emv', 'expectedCommercial', 'pAtLeastOneCommercial']) near(p[k], G.portfolio[k]);
  expect(p.count).toBe(3);
});

test('normal helpers, the fit and refusals', () => {
  near(normCdf(1.2815515655446004), 0.9, 2e-7);
  near(normInv(0.9), 1.2815515655446004, 1e-8);
  const ln = lognormalFromP90P10(10, 40);
  near(ln.percentile(0.9), 10, 1e-7); near(ln.percentile(0.1), 40, 1e-7);
  expect(swansonMean(10, 20, 40)).toBeCloseTo(23, 12);
  expect(() => lognormalFromP90P10(40, 10)).toThrow(/P90 is the low case/);
  expect(() => valueProspect({ pg: 1.2, p90: 1, p10: 2 })).toThrow(/Pg must be between 0 and 1/);
  expect(() => normInv(1)).toThrow(/strictly between/);
});
