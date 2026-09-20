// HSE H5 gates: quantitative risk assessment (event trees, LSIR, IRPA, PLL,
// FAR, F-N curves and criteria, ALARP banding, cost-benefit and gross
// disproportion, Purple Book fatality fractions, consequence linkage)
// against the independent oracle (tools/validation/hse/oracle_qra.py,
// numpy and scipy in /root/hseenv) and the published values it transcribes.
//
// Every golden below is CALLED THROUGH THE ENGINE. What the routes check:
//
//  - route A (the oracle's own transcription): 1e-12 relative for sums and
//    products, 1e-9 for the toxic probability integral (engine Simpson vs
//    scipy quad), 1e-10 for the pool fire chain;
//  - PUBLISHED: PB Appendix 6.B (C, Pr, Pcl, PI, ECW, Pci, Pd, dIR, stepwise
//    and as a chain), PB Table 4.5, PB Figures 5.2 to 5.5 and Table 5.3,
//    Bevi art. 13 against PB Figure 6.8, the R2P2 paragraph 128 examples,
//    the R2P2 VPF footnote and the HSE CBA checklist worked example;
//  - route B: exact rational event trees, brute-force F(N), the area under
//    the F-N curve as PLL, a dense-grid sup of F / line, the closed-form
//    growing annuity, and the analytic probit across the plume.
//
// Negative controls: tools/validation/hse/negcontrol_qra.sh.

import fs from 'fs';
import path from 'path';
import * as Q from '../engines/hse/qra';
import * as C from '../engines/hse/consequence';
import { fatalAccidentRate } from '../engines/hse/safetyStats';
import { npv } from '../engines/economics/cashflow';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'hse', 'goldens', 'qra_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const RTOL = 1e-12;

const expectClose = (actual, expected, tol = RTOL) => {
  expect(typeof actual).toBe('number');
  if (expected === 0) expect(Math.abs(actual)).toBeLessThan(1e-300);
  else expect(rel(actual, expected)).toBeLessThan(tol);
};

describe('golden file', () => {
  test('is the oracle output and every case says where it came from', () => {
    expect(G.module).toBe('qra');
    expect(G.generatedBy).toBe('tools/validation/hse/oracle_qra.py');
    const all = [
      ...G.eventTrees.trees, ...G.eventTrees.flammable, ...G.eventTrees.directIgnition,
      ...G.individualRisk.lsir, G.individualRisk.pbAppendix6bContribution, ...G.individualRisk.irpa, ...G.individualRisk.pll, ...G.individualRisk.far,
      ...G.fn.curves, ...G.fn.comparisons, ...G.alarp, ...G.costBenefit, ...G.pbFractions,
      G.toxicGridPoint.pbAppendix6b, ...G.toxicGridPoint.derived,
      ...G.transects.thermal, ...G.transects.poolFire, G.transects.lsir,
    ];
    all.forEach((c) => expect(c.source).toMatch(/^(PUBLISHED|ORACLE-DERIVED): /));
    expect(all.filter((c) => c.source.startsWith('PUBLISHED')).length).toBeGreaterThanOrEqual(20);
  });
});

/* ------------------------------------------------------------------ */
describe('what this engine does not re-grade', () => {
  // H5 consumes consequence results; it does not recompute them. The live
  // NextGen courses FC1 and FC5 grade point-source flare and pool radiation
  // and setbacks (engines/facilities/relief.js and spacing.js), and H4
  // (engines/hse/consequence.js) owns the source terms, the plume, the solid
  // flame and the probits. None of that is re-exposed or restated here.
  test('no radiation, setback, plume or probit is re-exported from qra.js', () => {
    [
      'radiationIntensity', 'distanceForIntensity', 'flareSetbackM', 'poolFireSetbackM',
      'RADIATION_LEVELS', 'thermalProbit', 'toxicProbit', 'probabilityToProbit',
      'gaussianPlume', 'poolFireSolidFlame', 'poolFireFlameLength', 'poolBurningRate',
    ].forEach((name) => expect(Q[name]).toBeUndefined());
  });

  test('the thermal transect IS the H4 probit, bit for bit (reuse, not a second transcription)', () => {
    const fluxes = [1000, 4730, 12500, 35000];
    const r = Q.thermalFatalityTransect({ heatFluxesWM2: fluxes, exposureTimeS: 20, coefficients: 'purple-book' });
    expect(r.error).toBeUndefined();
    fluxes.forEach((q, i) => {
      const h4 = C.thermalProbit({ coefficients: 'purple-book', heatFluxWM2: q, exposureTimeS: 20 });
      expect(r.probabilities[i]).toBe(h4.probability);
    });
  });

  test('the pool fire transect IS the H4 solid flame, bit for bit', () => {
    const c = G.transects.poolFire[0];
    const r = Q.poolFireFatalityTransect(c.args);
    expect(r.error).toBeUndefined();
    const { distancesFromCentreM, exposureTimeS, coefficients, ...pf } = c.args;
    const radiated = r.points.filter((p) => p.state === 'RADIATION');
    expect(radiated.length).toBeGreaterThan(0);
    radiated.forEach((p) => {
      const h4 = C.poolFireSolidFlame({ ...pf, distanceFromCentreM: p.distanceFromCentreM });
      expect(p.heatFluxWM2).toBe(h4.heatFluxWM2);
    });
  });
});

/* ------------------------------------------------------------------ */
describe('event trees', () => {
  test.each(G.eventTrees.trees.map((c) => [c.id, c]))('%s: outcomes, totals, exact route and conservation', (id, c) => {
    const r = Q.eventTree(c.args);
    expect(r.error).toBeUndefined();
    expect(r.outcomes.length).toBe(c.expected.outcomes.length);
    r.outcomes.forEach((o, i) => {
      const e = c.expected.outcomes[i];
      expect(o.path).toEqual(e.path);
      expect(o.outcome).toBe(e.outcome);
      expectClose(o.probability, e.probability);
      expectClose(o.frequencyPerYr, e.frequencyPerYr);
      expectClose(o.frequencyPerYr, c.routeB.exactFrequencies[i], 1e-12);
    });
    Object.entries(c.expected.outcomeTotalsPerYr).forEach(([k, v]) => expectClose(r.outcomeTotalsPerYr[k], v));
    expect(rel(r.totalFrequencyPerYr, c.routeB.f0)).toBeLessThan(1e-9);
    expect(rel(c.routeB.exactTotal, c.routeB.f0)).toBeLessThan(1e-9);
  });

  test.each(G.eventTrees.flammable.map((c) => [c.id, c]))('flammable release builder %s', (id, c) => {
    const r = Q.flammableReleaseEventTree(c.args);
    expect(r.error).toBeUndefined();
    Object.entries(c.expectedTotals).forEach(([k, v]) => expectClose(r.outcomeTotalsPerYr[k], v));
  });

  test('the PB vapour cloud split is 0.6 flash fire and 0.4 explosion (PB 4.8)', () => {
    expect(Q.PB_VAPOUR_CLOUD_SPLIT.flashFire).toBe(0.6);
    expect(Q.PB_VAPOUR_CLOUD_SPLIT.explosion).toBe(0.4);
  });

  test('0.7 + 0.2 + 0.1 passes the branch-sum check although it is 0.9999999999999999 in doubles', () => {
    expect(0.7 + 0.2 + 0.1).not.toBe(1);
    const r = Q.eventTree({ initiatingFrequencyPerYr: 1, tree: { branches: [{ name: 'a', probability: 0.7 }, { name: 'b', probability: 0.2 }, { name: 'c', probability: 0.1 }] } });
    expect(r.error).toBeUndefined();
  });

  // Fail-open closed 2026-09-20 (FINDINGS-qra.md section 9). The outcome
  // totals were accumulated into an object literal, so an outcome named
  // 'constructor' concatenated onto the inherited Object constructor
  // (giving the string "function Object() { [native code] }0.5") and one
  // named '__proto__' hit the prototype setter and vanished from the
  // totals altogether, losing its frequency without any refusal.
  test.each([['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty']])(
    'an outcome named %s is a plain key of outcomeTotalsPerYr, with its own frequency',
    (name) => {
      const r = Q.eventTree({
        initiatingFrequencyPerYr: 2e-3,
        tree: { branches: [{ name, probability: 0.25 }, { name: 'other', probability: 0.75 }] },
      });
      expect(r.error).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(r.outcomeTotalsPerYr, name)).toBe(true);
      expectClose(r.outcomeTotalsPerYr[name], 2e-3 * 0.25);
      expectClose(r.outcomeTotalsPerYr.other, 2e-3 * 0.75);
      const totals = Object.values(r.outcomeTotalsPerYr).reduce((a, b) => a + b, 0);
      expectClose(totals, 2e-3, 1e-12);
      expect(JSON.parse(JSON.stringify(r.outcomeTotalsPerYr))[name]).toBe(2e-3 * 0.25);
    },
  );

  test.each(G.eventTrees.directIgnition.map((c, i) => [i, c]))('PB Table 4.5 cell %p', (i, c) => {
    const r = Q.pbDirectIgnitionProbability(c.args);
    expect(r.error).toBeUndefined();
    expect(r.probability).toBe(c.probability);
  });
});

/* ------------------------------------------------------------------ */
describe('individual risk, PLL, FAR', () => {
  test.each(G.individualRisk.lsir.map((c) => [c.id, c]))('LSIR %s', (id, c) => {
    const r = Q.locationIndividualRisk(c.args);
    expectClose(r.lsirPerYr, c.expected.lsirPerYr);
    r.contributions.forEach((x, i) => expectClose(x.contributionPerYr, c.expected.contributions[i]));
    // the Monte Carlo figure is a sanity check recorded by the oracle, not a golden
    expect(Math.abs(c.monteCarloSanity.estimate - r.lsirPerYr)).toBeLessThan(4 * c.monteCarloSanity.standardError);
  });

  test('PB Appendix 6.B step 6: 5e-7 x 0.0368 x 0.381 = 7.0e-9 per year', () => {
    const c = G.individualRisk.pbAppendix6bContribution;
    const r = Q.locationIndividualRisk(c.args);
    expect(Number(r.lsirPerYr.toPrecision(2))).toBe(c.printed);
  });

  test.each(G.individualRisk.irpa.map((c) => [c.id, c]))('IRPA %s', (id, c) => {
    const r = Q.individualRiskPerAnnum(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.irpaPerYr, c.expected.irpaPerYr);
    expectClose(r.totalOccupancyFraction, c.expected.totalOccupancyFraction);
  });

  test('IRPA with occupancy 1 at one location equals the LSIR there', () => {
    const r = Q.individualRiskPerAnnum({ locations: [{ name: 'x', lsirPerYr: 3.7e-5, occupancyFraction: 1 }] });
    expect(r.irpaPerYr).toBe(3.7e-5);
  });

  test.each(G.individualRisk.pll.map((c) => [c.id, c]))('PLL %s', (id, c) => {
    expectClose(Q.potentialLossOfLife(c.args).pllPerYr, c.expected.pllPerYr);
  });

  test.each(G.individualRisk.far.map((c) => [c.id, c]))('FAR %s', (id, c) => {
    expectClose(Q.fatalAccidentRateFromPll(c.args).far, c.expected.far);
  });

  test('FAR from a whole PLL is bit for bit safetyStats.fatalAccidentRate (base 1e8, not 1e6)', () => {
    [[3, 2.5e7], [1, 1e8], [7, 123456789]].forEach(([n, h]) => {
      expect(Q.fatalAccidentRateFromPll({ pllPerYr: n, exposedHoursPerYr: h }).far).toBe(fatalAccidentRate({ fatalities: n, exposureHours: h }).rate);
    });
  });
});

/* ------------------------------------------------------------------ */
describe('F-N curves', () => {
  test.each(G.fn.curves.map((c) => [c.id, c]))('%s: corners, brute force, area = PLL', (id, c) => {
    const r = Q.fnCurve(c.args);
    expect(r.error).toBeUndefined();
    expect(r.points.map((p) => p.fatalities)).toEqual(c.expected.points.map((p) => p.fatalities));
    r.points.forEach((p, i) => expectClose(p.cumulativeFrequencyPerYr, c.expected.points[i].cumulativeFrequencyPerYr, 1e-12));
    expectClose(r.zeroFatalityFrequencyPerYr, c.expected.zeroFatalityFrequencyPerYr);
    expectClose(r.expectedFatalitiesPerYr, c.expected.expectedFatalitiesPerYr);
    // route B: F at any N from the engine's corners equals the brute-force sum
    const F = (n) => {
      const p = r.points.find((q) => q.fatalities >= n);
      return p ? p.cumulativeFrequencyPerYr : 0;
    };
    c.routeB.grid.forEach(({ n, F: f }) => expectClose(F(n), f, 1e-12));
    if (c.expected.expectedFatalitiesPerYr > 0) expect(rel(r.expectedFatalitiesPerYr, c.routeB.areaUnderCurve)).toBeLessThan(1e-12);
    // the curve never rises with N
    for (let i = 1; i < r.points.length; i += 1) expect(r.points[i].cumulativeFrequencyPerYr).toBeLessThanOrEqual(r.points[i - 1].cumulativeFrequencyPerYr);
  });

  test.each(G.fn.comparisons.map((c) => [c.id, c]))('criterion %s', (id, c) => {
    const r = Q.fnCriterionComparison(c.args);
    expect(r.error).toBeUndefined();
    expect(r.state).toBe(c.expected.state);
    expect(r.checks.length).toBe(c.expected.checks.length);
    r.checks.forEach((k, i) => {
      const e = c.expected.checks[i];
      expect(k.fatalities).toBe(e.fatalities);
      expect(k.state).toBe(e.state);
      expectClose(k.curveFrequencyPerYr, e.curveFrequencyPerYr);
      expectClose(k.criterionFrequencyPerYr, e.criterionFrequencyPerYr);
      expectClose(k.ratio, e.ratio);
      if (e.exceedsOverFatalities) {
        expectClose(k.exceedsOverFatalities.from, e.exceedsOverFatalities.from);
        expect(k.exceedsOverFatalities.to).toBe(e.exceedsOverFatalities.to);
      } else expect(k.exceedsOverFatalities).toBeUndefined();
    });
    expectClose(r.maxRatio, c.expected.maxRatio);
    // route B: the dense-grid sup of F / line never exceeds the corner maximum
    if (c.routeB.gridMaxRatio !== null) {
      expect(c.routeB.gridMaxRatio).toBeLessThanOrEqual(r.maxRatio * (1 + 1e-12));
      expect(c.routeB.gridMaxRatio).toBeGreaterThan(r.maxRatio * (1 - 1e-3));
    }
  });

  test('Bevi art. 13(1)(b) points lie on the PB Figure 6.8 line F = 1e-3 / N^2', () => {
    const v = Q.FN_CRITERIA['vrom-establishments'];
    G.fn.beviPoints.forEach(({ fatalities, printed }) => {
      expect(rel(v.constantC / fatalities ** v.exponentAlpha, printed)).toBeLessThan(1e-12);
    });
    expect(v.minFatalities).toBe(10);
  });

  test('R2P2 para 136 is one point, 50 or more deaths at 1 in 5000 per year, with no slope', () => {
    const p = Q.FN_CRITERIA['r2p2-para-136'];
    expect(p.points).toEqual([{ fatalities: 50, frequencyPerYr: 1 / 5000 }]);
    expect(p.exponentAlpha).toBeUndefined();
  });

  test('N = 0 scenarios stay out of the curve; a list of only N = 0 gives an empty curve', () => {
    const r = Q.fnCurve({ scenarios: [{ name: 'a', frequencyPerYr: 0.1, fatalities: 0 }] });
    expect(r.points).toEqual([]);
    expect(r.zeroFatalityFrequencyPerYr).toBe(0.1);
    const s = Q.fnCriterionComparison({ scenarios: [{ name: 'a', frequencyPerYr: 0.1, fatalities: 0 }], criterion: 'vrom-establishments' });
    expect(s.state).toBe('BELOW');
    expect(s.checks).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
describe('ALARP banding', () => {
  test.each(G.alarp.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = Q.alarpBand(c.args);
    expect(r.error).toBeUndefined();
    expect(r.band).toBe(c.expected.band);
    expect(r.atBoundary).toBe(c.expected.atBoundary);
    expect(r.alarpDemonstrationRequired).toBe(c.expected.band === 'TOLERABLE');
  });

  test('R2P2 presets are 1e-3 (workers) and 1e-4 (public), 1e-6 for both', () => {
    expect(Q.TOLERABILITY_PRESETS['r2p2-workers']).toMatchObject({ unacceptableAbovePerYr: 1e-3, broadlyAcceptableAtOrBelowPerYr: 1e-6 });
    expect(Q.TOLERABILITY_PRESETS['r2p2-public']).toMatchObject({ unacceptableAbovePerYr: 1e-4, broadlyAcceptableAtOrBelowPerYr: 1e-6 });
  });
});

/* ------------------------------------------------------------------ */
describe('cost-benefit and gross disproportion', () => {
  test('HSE CBA checklist example: 6684 + 2072 + 512 + 15 = 9,283 over 25 years; up to about 93,000 at DF 10', () => {
    const c = G.costBenefit.find((x) => x.id === 'hse-cba-checklist-example');
    const r = Q.costBenefit(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.presentValueBenefit, c.expected.presentValueBenefit);
    expect(Math.abs(r.fatalityBenefitPerYr * 25 - c.printed.fatalities)).toBeLessThan(c.printedAbsTol);
    const h = r.otherHarms.map((x) => x.benefitPerYr * 25);
    expect(Math.abs(h[0] - c.printed.permanent)).toBeLessThan(c.printedAbsTol);
    expect(Math.abs(h[1] - c.printed.serious)).toBeLessThan(c.printedAbsTol);
    expect(Math.abs(h[2] - c.printed.slight)).toBeLessThan(c.printedAbsTol);
    expect(Math.abs(r.presentValueBenefit - c.printed.total)).toBeLessThan(c.printedAbsTol);
    expect(rel(r.maximumReasonablyPracticableCost, c.printed.maxCost)).toBeLessThan(c.printedMaxCostRelTol);
    expect(r.verdict).toBe(c.expected.verdict);
    expect(r.basis.discounting).toMatch(/undiscounted/);
  });

  test('R2P2 footnote: a VPF of 1 000 000 makes a 1 in 100 000 reduction worth 10', () => {
    const c = G.costBenefit.find((x) => x.id === 'r2p2-vpf-footnote');
    const r = Q.costBenefit(c.args);
    expect(rel(r.presentValueBenefit, c.printed)).toBeLessThan(1e-12);
    expect(r.verdict).toBe(c.expected.verdict);
    expect(r.atBoundary).toBe(true);
  });

  test.each(G.costBenefit.filter((c) => c.routeB).map((c) => [c.id, c]))('discounted %s: explicit sum and closed-form annuity', (id, c) => {
    const r = Q.costBenefit(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.presentValueBenefit, c.expected.presentValueBenefit, 1e-12);
    expectClose(r.presentValueCost, c.expected.presentValueCost, 1e-12);
    expectClose(r.presentValueBenefit, c.routeB.presentValueBenefit, 1e-11);
    expectClose(r.presentValueCost, c.routeB.presentValueCost, 1e-11);
    expectClose(r.costPerFatalityPrevented, c.expected.costPerFatalityPrevented, 1e-12);
    expectClose(r.costToBenefitRatio, c.expected.costToBenefitRatio, 1e-12);
    expect(r.verdict).toBe(c.expected.verdict);
  });

  test('cost exactly DF x benefit is NOT grossly disproportionate (the checklist test is costs/benefits > DF)', () => {
    const c = G.costBenefit.find((x) => x.id === 'exactly-at-df');
    const r = Q.costBenefit(c.args);
    expect(r.verdict).toBe('NOT_GROSSLY_DISPROPORTIONATE');
    expect(r.atBoundary).toBe(true);
    const over = Q.costBenefit({ ...c.args, capitalCost: c.args.capitalCost * 1.000001 });
    expect(over.verdict).toBe('GROSSLY_DISPROPORTIONATE');
  });

  test('the present values are the canonical cashflow.ts npv, year-end', () => {
    const a = { deltaPllPerYr: 1e-4, vpf: 2e6, lifetimeYears: 7, capitalCost: 1000, annualCost: 50, disproportionFactor: 2, benefitDiscountRate: 0.02, costDiscountRate: 0.05 };
    const r = Q.costBenefit(a);
    expect(r.presentValueBenefit).toBe(npv(Array(7).fill(200), 0.02, 0, 1));
    expect(r.presentValueCost).toBe(npv([1000, ...Array(7).fill(50)], 0.05, 0, 0));
  });

  test('HSE figures are exported as illustrative data only; VPF and DF have no default', () => {
    expect(Q.HSE_ILLUSTRATIVE_VALUES.vpfGbp2001.value).toBe(1000000);
    expect(Q.HSE_ILLUSTRATIVE_VALUES.vpfGbp2003Q3.value).toBe(1336800);
    expect(Q.costBenefit({ deltaPllPerYr: 1e-4, lifetimeYears: 1, capitalCost: 1, disproportionFactor: 1 }).field).toBe('vpf');
  });
});

/* ------------------------------------------------------------------ */
describe('Purple Book fatality fractions', () => {
  test.each(G.pbFractions.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = Q.pbFatalityFractions(c.args);
    expect(r.error).toBeUndefined();
    ['probabilityOfDeath', 'fractionDyingIndoors', 'fractionDyingOutdoors', 'fractionIndoors', 'fractionOfDeaths'].forEach((k) => {
      if (c.expected[k] === 0) expect(r[k]).toBe(0);
      else expect(rel(r[k], c.expected[k])).toBeLessThan(2e-7 / Math.max(c.expected[k], 1e-3) + 1e-12);
    });
  });

  test('PB Table 5.3: 0.93 indoors by day, 0.99 by night; Figure 5.4 35 kW/m2; Figure 5.5 0.3 and 0.1 barg; 20 s', () => {
    expect(Q.PB_FRACTION_INDOORS).toEqual({ day: 0.93, night: 0.99 });
    expect(Q.PB_IGNITION_FLUX_WM2).toBe(35000);
    expect(Q.PB_VCE_OVERPRESSURE_PA).toEqual({ lethal: 30000, indoorOnly: 10000 });
    expect(Q.PB_MAX_FIRE_EXPOSURE_S).toBe(20);
  });

  test('the fire exposure is capped at 20 s (PB 5.2.3 note 3)', () => {
    const r = Q.pbFatalityFractions({ effect: 'fire', heatFluxWM2: 12000, fireDurationS: 60, period: 'day' });
    expect(r.exposureTimeUsedS).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
describe('toxic plume at a grid point (PB 6.2.5)', () => {
  const c = G.toxicGridPoint.pbAppendix6b;
  const r = Q.toxicPlumeGridPointRisk(c.args);

  test('matches the oracle chain (scipy quad of the analytic probit)', () => {
    expect(r.error).toBeUndefined();
    expectClose(r.centrelineConcentrationMgM3, c.expected.centrelineConcentrationMgM3, 1e-12);
    expectClose(r.centrelineProbit, c.expected.centrelineProbit, 1e-12);
    expect(Math.abs(r.centrelineProbability - c.expected.centrelineProbability)).toBeLessThan(2e-7);
    expectClose(r.cutoffHalfWidthM, c.expected.cutoffHalfWidthM, 1e-6);
    ['probabilityIntegralM', 'effectiveCloudWidthM', 'coverageProbability', 'probabilityOfDeath', 'contributionPerYr'].forEach((k) => {
      expectClose(r[k], c.expected[k], 1e-6);
    });
  });

  test('reproduces every printed Appendix 6.B value as a chain', () => {
    Object.entries(c.printedChainTolerances).forEach(([k, tol]) => {
      expect(rel(r[k], c.printed[k])).toBeLessThan(tol);
    });
    expect(Math.round(r.probabilityIntegralM)).toBe(72);
    expect(Number(r.contributionPerYr.toPrecision(2))).toBe(7.0e-9);
  });

  test('reproduces each printed step from its printed predecessor (PB 6.9, 6.10, 6.11, 6.1)', () => {
    const s = c.printedStepwise;
    expect(Number(s.ecw.toFixed(1))).toBe(86.2);
    expect(Number(s.pci.toFixed(3))).toBe(0.456);
    expect(Number(s.pd.toFixed(3))).toBe(0.381);
    expect(Number(s.dir.toPrecision(2))).toBe(7.0e-9);
    expect(Number(s.pmPphi.toFixed(4))).toBe(0.0368);
    // and the engine's own formula applied to the printed PI and Pcl
    expect(Number(((12 * (72 / 0.835)) / (2 * Math.PI * 361)).toFixed(3))).toBe(0.456);
  });

  test.each(G.toxicGridPoint.derived.map((x) => [x.id, x]))('%s', (id, x) => {
    const q = Q.toxicPlumeGridPointRisk(x.args);
    expect(q.error).toBeUndefined();
    expect(q.exposureMinutesUsed).toBe(30);
    ['probabilityIntegralM', 'effectiveCloudWidthM', 'coverageProbability', 'probabilityOfDeath'].forEach((k) => expectClose(q[k], x.expected[k], 1e-6));
  });

  test('the centreline is the H4 plume and probit, not a restatement', () => {
    const plume = C.gaussianPlume({ massRateKgS: 100, windSpeedMS: 5, downwindDistanceM: 361, sigmaYM: 28.8, sigmaZM: 10.3, releaseHeightM: 1, receptorHeightM: 1 });
    const p = C.toxicProbit({ coefficients: 'pb-carbon-monoxide', concentrationMgM3: plume.concentrationMgM3, exposureMinutes: 30 });
    expect(r.centrelineProbit).toBe(p.probit);
    expect(r.centrelineProbability).toBe(p.probability);
  });

  test('below the 1 percent cutoff on the centreline the grid point carries no risk', () => {
    const q = Q.toxicPlumeGridPointRisk({ ...c.args, massRateKgS: 1 });
    expect(q.state).toBe('BELOW_CUTOFF');
    expect(q.probabilityOfDeath).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
describe('consequence linkage along a transect', () => {
  test.each(G.transects.thermal.map((c) => [c.id, c]))('thermal probit transect %s', (id, c) => {
    const r = Q.thermalFatalityTransect(c.args);
    expect(r.error).toBeUndefined();
    r.probabilities.forEach((p, i) => expect(Math.abs(p - c.expected[i])).toBeLessThan(2e-7));
    // bit for bit the H4 thermalProbit
    c.args.heatFluxesWM2.forEach((q, i) => {
      if (q > 0) expect(r.probabilities[i]).toBe(C.thermalProbit({ coefficients: c.args.coefficients || 'eisenberg', heatFluxWM2: q, exposureTimeS: c.args.exposureTimeS }).probability);
    });
  });

  test.each(G.transects.poolFire.map((c) => [c.id, c]))('pool fire transect %s', (id, c) => {
    const r = Q.poolFireFatalityTransect(c.args);
    expect(r.error).toBeUndefined();
    r.points.forEach((p, i) => {
      const e = c.expected[i];
      expect(p.state).toBe(e.state);
      if (e.heatFluxWM2 === null) {
        expect(p.probability).toBe(1);
      } else {
        expectClose(p.heatFluxWM2, e.heatFluxWM2, 1e-10);
        expect(Math.abs(p.probability - e.probability)).toBeLessThan(2e-7);
      }
    });
  });

  test('LSIR along the transect and its PB contour crossings', () => {
    const c = G.transects.lsir;
    const r = Q.lsirTransect(c.args);
    expect(r.error).toBeUndefined();
    r.lsirPerYr.forEach((v, i) => expectClose(v, c.expected.lsirPerYr[i]));
    expect(r.contours.map((k) => k.levelPerYr)).toEqual(Q.PB_IR_CONTOURS_PER_YR);
    r.contours.forEach((k, i) => {
      expect(k.crossingsM.length).toBe(c.expected.contours[i].crossingsM.length);
      k.crossingsM.forEach((x, j) => expectClose(x, c.expected.contours[i].crossingsM[j], 1e-12));
    });
  });

  test('end to end: the pool fire transect feeds lsirTransect unchanged', () => {
    const pf = G.transects.poolFire[0];
    const t = Q.poolFireFatalityTransect(pf.args);
    const r = Q.lsirTransect({ distancesM: pf.args.distancesFromCentreM, scenarios: [{ name: 'pool fire', frequencyPerYr: 2e-4, fatalityProbabilities: t.probabilities }] });
    r.lsirPerYr.forEach((v, i) => expect(v).toBe(2e-4 * t.probabilities[i]));
  });
});

/* ------------------------------------------------------------------ */
describe('refusals, by name', () => {
  test.each(G.refusals.map((c, i) => [i, c.fn, c.field, c]))('#%p %s refuses %s', (i, fn, field, c) => {
    const r = Q[fn](c.args);
    expect(r.error).toBeDefined();
    expect(r.field).toBe(field);
    expect(r.error.startsWith(`${field}:`)).toBe(true);
  });

  test('every successful result carries a basis naming its model and source', () => {
    const results = [
      Q.eventTree(G.eventTrees.trees[0].args), Q.flammableReleaseEventTree(G.eventTrees.flammable[0].args),
      Q.pbDirectIgnitionProbability(G.eventTrees.directIgnition[0].args), Q.locationIndividualRisk(G.individualRisk.lsir[0].args),
      Q.individualRiskPerAnnum(G.individualRisk.irpa[0].args), Q.potentialLossOfLife(G.individualRisk.pll[0].args),
      Q.fatalAccidentRateFromPll(G.individualRisk.far[0].args), Q.fnCurve(G.fn.curves[0].args), Q.fnCriterionComparison(G.fn.comparisons[0].args),
      Q.alarpBand(G.alarp[0].args), Q.costBenefit(G.costBenefit[0].args), Q.pbFatalityFractions(G.pbFractions[0].args),
      Q.toxicPlumeGridPointRisk(G.toxicGridPoint.pbAppendix6b.args), Q.thermalFatalityTransect(G.transects.thermal[0].args),
      Q.poolFireFatalityTransect(G.transects.poolFire[0].args), Q.lsirTransect(G.transects.lsir.args),
    ];
    results.forEach((r) => {
      expect(r.error).toBeUndefined();
      expect(typeof r.basis.model).toBe('string');
      expect(typeof r.basis.source).toBe('string');
    });
  });
});
