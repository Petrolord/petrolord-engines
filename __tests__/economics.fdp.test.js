/**
 * Gates for the FDP Accelerator engines (engines/economics/fdp/*.js).
 *
 * Three layers, per the EC0 brief:
 *   (a) closed-form identities the method must satisfy exactly;
 *   (b) agreement with every golden case in
 *       test-data/economics/goldens/fdp_cases.json (emitted by the independent
 *       stdlib oracle tools/validation/economics/oracle_fdp.py) within a
 *       STATED absolute tolerance per quantity, with every legitimate
 *       disagreement pinned on BOTH sides;
 *   (c) every test the Suite already had for these modules
 *       (src/utils/fdp/__tests__/economics.test.js), ported verbatim in intent.
 *
 * Tolerances. Money in $MM: 1e-6 absolute (sums of a dozen terms in doubles
 * agree to 1e-9 or better; 1e-6 leaves room for summation order). IRR in
 * percent: 1e-6 where the engine's Newton and the oracle's bisection find the
 * same root (Newton stops at 1e-7 in the rate). Ratios and factors: 1e-9.
 * Counts, days and rounded scores: exact.
 *
 * Timezone assumption: UTC (the concept schedule and the project duration
 * go through Date; the goldens were emitted for UTC and the dates gate
 * asserts the zone).
 */
import fs from 'fs';
import path from 'path';
import {
  runFdpCase, runFdpSensitivity, buildFdpCaseInputs, paybackYears, DEFAULT_FISCAL,
} from '../engines/economics/fdp/economics.js';
import {
  calculateCashFlows, calculateNPV, calculateIRR, calculatePaybackPeriod,
  calculateTotalCAPEX, calculateTotalOPEX, calculateCostByPhase,
} from '../engines/economics/fdp/costCalculations.js';
import {
  runScenario, scenarioNPV, scenarioIRR, scenarioPayback, conceptProfileKbpd,
  conceptCapexMM, scenarioSensitivity,
} from '../engines/economics/fdp/scenarioCalculations.js';
import {
  calculateConceptCost, calculateConceptSchedule, calculateReservesImpact,
} from '../engines/economics/fdp/conceptCalculations.js';
import {
  calculateRecoveryFactor, calculateOOIP, calculateRecoverableReserves, calculatePressureGradient,
  calculateTemperatureGradient, calculateRiskScore, aggregateReserves, reservesP50,
} from '../engines/economics/fdp/subsurfaceCalculations.js';
import {
  calculateDrillingTime, calculateDrillingCost, calculateWellCount, aggregateWellsByType, calculateTotalDrillingCost,
} from '../engines/economics/fdp/wellCalculations.js';
import {
  calculateFacilityCapacity, calculateFacilityCost, calculateFlowAssuranceRisk, identifyBottlenecks,
} from '../engines/economics/fdp/facilitiesCalculations.js';
import {
  calculateRiskMatrix, calculateTotalRiskScore, aggregateRisksByType, calculateComplianceScore,
} from '../engines/economics/fdp/hseCalculations.js';
import {
  calculateConsolidatedRiskScore, calculateRiskExposure, aggregateRisksBySource, aggregateRisksByLevel,
  calculatePortfolioHealth,
} from '../engines/economics/fdp/riskCalculations.js';
import {
  calculateProjectDuration, calculateCPM, calculateResourceRequirements, identifyMilestones,
  calculateNetworkDuration, criticalPaths,
} from '../engines/economics/fdp/scheduleCalculations.js';
import { calculateCompleteness, validateFDPData, planReservesP50 } from '../engines/economics/fdp/fdpCalculations.js';
import { FdpInputError } from '../engines/economics/fdp/inputError.js';
import { getRiskLevel, RiskTypes, RiskStatus } from '../engines/economics/fdp/riskModel.js';
import { calculateEconomics } from '../engines/economics/screening.js';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/economics/goldens/fdp_cases.json'), 'utf8'));

const MONEY = 1e-6;
const IRR = 1e-6;
const RATIO = 1e-9;

/** null in a golden is NaN (or Infinity) in the engine; the case note says which. */
const expectNum = (actual, expected, tol) => {
  if (expected === null) {
    expect(Number.isFinite(actual)).toBe(false);
    return;
  }
  expect(typeof actual).toBe('number');
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
};

const deck = (prices) => prices.map((p) => ({ oil_price_usd: p }));

// ---------------------------------------------------------------------------
// (c) The Suite's own tests, ported.
// ---------------------------------------------------------------------------

const profile = [10, 25, 45, 50, 48, 42, 35, 30, 25, 20];
const prices = profile.map(() => 75);

describe('Suite port: runFdpCase', () => {
  test('FISCAL TERMS ARE APPLIED: royalty and tax are both non-zero', () => {
    const r = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices });
    expect(r.metrics.totalRoyalty).toBeGreaterThan(0);
    expect(r.metrics.totalTax).toBeGreaterThan(0);
    expect(r.metrics.totalGovTake).toBeGreaterThan(0);
  });

  test('post-fiscal NPV is materially below the pre-fiscal number', () => {
    const withFiscal = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices }).metrics.npv;
    const withoutFiscal = runFdpCase({
      capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices, fiscal: { royaltyRate: 0, taxRate: 0 },
    }).metrics.npv;
    expect(withFiscal).toBeLessThan(withoutFiscal);
    expect(withFiscal / withoutFiscal).toBeLessThan(0.75);
  });

  test('it IS the sanctioned engine, not a copy of it', () => {
    const r = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices });
    const life = profile.length + 1;
    const oil = [0, ...profile.map((k) => k * 1000 * 365)];
    const capexArr = new Array(life).fill(0);
    capexArr[0] = 800;
    const direct = calculateEconomics({
      startYear: 0,
      projectLife: life,
      discountRate: DEFAULT_FISCAL.discountRate,
      fiscalType: 'TaxRoyalty',
      production: { oil, gas: new Array(life).fill(0) },
      price: { oil: [0, ...prices], gas: new Array(life).fill(0) },
      capex: capexArr,
      opexFixed: [0, ...profile.map(() => 60)],
      opexVariable: [0, ...profile.map((k) => (k * 1000 * 365 * 5) / 1e6)],
      abandonment: new Array(life).fill(0),
      royaltyRate: DEFAULT_FISCAL.royaltyRate,
      taxRate: DEFAULT_FISCAL.taxRate,
    });
    expect(r.metrics.npv).toBeCloseTo(direct.metrics.npv, 9);
  });

  test('development year carries the capex and no revenue', () => {
    const r = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices });
    expect(r.cashflow[0].capex).toBe(800);
    expect(r.cashflow[0].grossRevenue).toBe(0);
    expect(r.cashflow[0].ncf).toBeLessThan(0);
  });
});

describe('Suite port: payback', () => {
  test('PAYBACK IS NOT A YEAR EARLY', () => {
    const cashflow = [{ ncf: -100, cumulativeNCF: -100 }, { ncf: 150, cumulativeNCF: 50 }];
    expect(paybackYears({ cashflow, metrics: { payback: 1 + 100 / 150 } })).toBeCloseTo(1 + 100 / 150, 9);
    const rows = [
      { netCashFlow: -100, cumulativeCashFlow: -100 },
      { netCashFlow: 150, cumulativeCashFlow: 50 },
    ];
    expect(calculatePaybackPeriod(rows)).toBeCloseTo(1 + 100 / 150, 9);
  });

  test('payback lands after the crossing year begins and before it ends', () => {
    const r = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices });
    const pb = paybackYears(r);
    const crossing = r.cashflow.findIndex((c) => c.cumulativeNCF >= 0);
    expect(pb).toBeGreaterThanOrEqual(crossing);
    expect(pb).toBeLessThan(crossing + 1);
  });

  test('a project that never pays back reports null, not the project life', () => {
    const r = runFdpCase({ capexMM: 100000, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices });
    expect(paybackYears(r)).toBeNull();
    expect(calculatePaybackPeriod(calculateCashFlows(100000, 60, profile, deck(prices)))).toBeNull();
  });
});

describe('Suite port: costCalculations delegation', () => {
  const d = deck(prices);

  test('its NPV equals the engine NPV', () => {
    const rows = calculateCashFlows(800, 60, profile, d);
    const engine = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices });
    expect(calculateNPV(rows)).toBeCloseTo(engine.metrics.npv, 6);
  });

  test('rows carry royalty and tax so the charts can show them', () => {
    const rows = calculateCashFlows(800, 60, profile, d);
    expect(rows.slice(1).every((r) => r.royalty > 0)).toBe(true);
    expect(rows.some((r) => r.tax > 0)).toBe(true);
  });

  test('IRR is the rate that zeroes the NPV, and null when none exists', () => {
    const rows = calculateCashFlows(800, 60, profile, d);
    const irr = calculateIRR(rows);
    expect(irr).toBeGreaterThan(0);
    const npvAtIrr = rows.reduce((s, r, t) => s + r.netCashFlow / (1 + irr / 100) ** (t + 0.5), 0);
    expect(npvAtIrr).toBeCloseTo(0, 4);
    expect(calculateIRR([
      { netCashFlow: 10, cumulativeCashFlow: 10 },
      { netCashFlow: 20, cumulativeCashFlow: 30 },
    ])).toBeNull();
  });
});

describe('Suite port: scenarioCalculations delegation', () => {
  const concept = { drillingCapex: 300, facilitiesCapex: 400, subseaCapex: 100, opex: 60, peakProduction: 50 };
  const scenario = { oilPrice: 75, discountRate: 10 };

  test('the concept profile plateaus then declines', () => {
    const p = conceptProfileKbpd(concept);
    expect(p.slice(0, 3)).toEqual([50, 50, 50]);
    expect(p[3]).toBeLessThan(p[2]);
    expect(p[p.length - 1]).toBeLessThan(p[3]);
  });

  test('scenario NPV is post-fiscal and comes from the engine', () => {
    const r = runScenario(scenario, concept);
    expect(r.metrics.totalTax).toBeGreaterThan(0);
    expect(scenarioNPV(scenario, concept)).toBeCloseTo(r.metrics.npv, 9);
  });

  test('a higher price scenario is worth more', () => {
    expect(scenarioNPV({ ...scenario, oilPrice: 95 }, concept)).toBeGreaterThan(scenarioNPV({ ...scenario, oilPrice: 55 }, concept));
  });

  test('a higher discount rate is worth less', () => {
    expect(scenarioNPV({ ...scenario, discountRate: 15 }, concept)).toBeLessThan(scenarioNPV({ ...scenario, discountRate: 5 }, concept));
  });
});

// ---------------------------------------------------------------------------
// (a) Closed-form identities.
// ---------------------------------------------------------------------------

describe('identities', () => {
  const r = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices });

  test('at zero discount the NPV is the plain sum of the cash flow', () => {
    const z = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices, fiscal: { discountRate: 0 } });
    const sum = z.cashflow.reduce((s, c) => s + c.ncf, 0);
    expect(z.metrics.npv).toBeCloseTo(sum, 9);
    expect(z.cashflow[z.cashflow.length - 1].cumulativeNCF).toBeCloseTo(sum, 9);
  });

  test('government take is royalty plus tax in every row and in total', () => {
    r.cashflow.forEach((c) => expect(c.govTake).toBeCloseTo(c.royalty + c.tax, 12));
    expect(r.metrics.totalGovTake).toBeCloseTo(r.metrics.totalRoyalty + r.metrics.totalTax, 9);
  });

  test('the cash flow is revenue less royalty, cost and tax; the cumulative is its running sum', () => {
    let cum = 0;
    r.cashflow.forEach((c) => {
      expect(c.ncf).toBeCloseTo(c.grossRevenue - c.royalty - c.capex - c.opex - c.abex - c.tax, 9);
      cum += c.ncf;
      expect(c.cumulativeNCF).toBeCloseTo(cum, 9);
    });
    expect(r.metrics.maxExposure).toBe(Math.min(...r.cashflow.map((c) => c.cumulativeNCF)));
  });

  test('the NPV is zero at the IRR, mid-year', () => {
    const npvAt = (pct) => r.cashflow.reduce((s, c, t) => s + c.ncf / (1 + pct / 100) ** (t + 0.5), 0);
    expect(Math.abs(npvAt(r.metrics.irr))).toBeLessThan(1e-4);
    const rows = calculateCashFlows(800, 60, profile, deck(prices));
    const irr2 = calculateIRR(rows);
    expect(Math.abs(irr2 - r.metrics.irr)).toBeLessThan(IRR);
  });

  test('revenue is linear in price and in rate; royalty is linear in revenue', () => {
    const twice = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: prices.map((p) => 2 * p) });
    twice.cashflow.forEach((c, i) => {
      expect(c.grossRevenue).toBeCloseTo(2 * r.cashflow[i].grossRevenue, 9);
      expect(c.royalty).toBeCloseTo(2 * r.cashflow[i].royalty, 9);
    });
    const half = runFdpCase({ capexMM: 800, annualOpexMM: 60, productionKbpd: profile.map((k) => k / 2), pricesUsd: prices });
    half.cashflow.forEach((c, i) => expect(c.grossRevenue).toBeCloseTo(r.cashflow[i].grossRevenue / 2, 9));
  });

  test('the concept profile is a 3 year plateau then a 0.9 geometric decline over 20 years', () => {
    const p = conceptProfileKbpd({ peakProduction: 80 });
    expect(p).toHaveLength(20);
    for (let y = 3; y < 20; y += 1) expect(p[y] / p[y - 1]).toBeCloseTo(0.9, 12);
    expect(p[19]).toBeCloseTo(80 * 0.9 ** 17, 9);
  });

  test('OOIP is the 7758 volumetric identity and recovery inverts it', () => {
    const o = calculateOOIP(640, 50, 0.22, 0.25, 1.2);
    expect(o).toBeCloseTo((7758 * 640 * 50 * 0.22 * 0.75) / 1.2, 6);
    expect(calculateRecoverableReserves(o, 0.35)).toBeCloseTo(0.35 * o, 6);
    expect(calculateRecoveryFactor(o, calculateRecoverableReserves(o, 0.35))).toBeCloseTo(0.35, 12);
    expect(calculateOOIP(640, 50, 0.22, 0.25)).toBeCloseTo(calculateOOIP(640, 50, 0.22, 0.25, 1.2), 9);
  });

  test('the drilling time table: rop by complexity and trajectory, plus ten flat days, ceilinged', () => {
    expect(calculateDrillingTime(4000, 'Vertical')).toBe(20);
    expect(calculateDrillingTime(4000, 'Vertical', 'High')).toBe(26);
    expect(calculateDrillingTime(4000, 'Vertical', 'Low')).toBe(Math.ceil(4000 / 600 + 10));
    expect(calculateDrillingTime(2800, 'Horizontal')).toBe(20);
    expect(calculateDrillingTime(3400, 'Deviated')).toBe(20);
    expect(calculateDrillingTime(0, 'Vertical')).toBe(10);
  });

  test('drilling cost with default services is 2.5 times the rig spend', () => {
    expect(calculateDrillingCost(30, 250000)).toBe(30 * 250000 * 2.5);
    expect(calculateDrillingCost(30, 250000, 1)).toBe(30 * 250000 + 1);
  });

  test('facility cost scales as size to the 0.7 (capex) and 0.6 (opex) powers', () => {
    const one = calculateFacilityCost({ type: 'FPSO', nameplateCapacity: 50000 });
    const two = calculateFacilityCost({ type: 'FPSO', nameplateCapacity: 100000 });
    expect(two.capex / one.capex).toBeCloseTo(2 ** 0.7, 12);
    expect(two.opex / one.opex).toBeCloseTo(2 ** 0.6, 12);
    expect(one.decommissioning).toBeCloseTo(0.15 * 1200, 12);
  });

  test('capacity fractions are 1.5 gas, 0.8 water and 0.85 effective of nameplate', () => {
    const c = calculateFacilityCapacity({ nameplateCapacity: 80000 });
    expect(c.gasCapacity / c.oilCapacity).toBeCloseTo(1.5, 12);
    expect(c.waterHandling / c.oilCapacity).toBeCloseTo(0.8, 12);
    expect(c.effectiveCapacity / c.oilCapacity).toBeCloseTo(0.85, 12);
  });

  test('risk levels: 20 Critical, 12 High, 6 Medium, below Low; counts sum to the total', () => {
    expect(getRiskLevel(20).level).toBe('Critical');
    expect(getRiskLevel(19).level).toBe('High');
    expect(getRiskLevel(12).level).toBe('High');
    expect(getRiskLevel(11).level).toBe('Medium');
    expect(getRiskLevel(6).level).toBe('Medium');
    expect(getRiskLevel(5).level).toBe('Low');
    const risks = [];
    for (let p = 1; p <= 5; p += 1) for (let i = 1; i <= 5; i += 1) risks.push({ probability: p, impact: i });
    const lv = aggregateRisksByLevel(risks);
    expect(lv.Critical + lv.High + lv.Medium + lv.Low).toBe(25);
    const m = calculateRiskMatrix(risks);
    expect(m.low + m.medium + m.high).toBe(m.total);
    expect(calculateTotalRiskScore(risks)).toBe(15 * 15);
    expect(calculateConsolidatedRiskScore(risks)).toBe(225);
    expect(calculateRiskScore(4, 5)).toBe(20);
  });

  test('portfolio health is 100 with no risks and never below 0', () => {
    expect(calculatePortfolioHealth([])).toBe(100);
    expect(calculatePortfolioHealth(new Array(5).fill({ probability: 5, impact: 5 }))).toBe(0);
    expect(calculatePortfolioHealth([{ probability: 1, impact: 1 }])).toBe(100);
  });

  test('exposure is the factor table times cost impact, summed', () => {
    const risks = [
      { probability: 1, costImpact: 100 }, { probability: 2, costImpact: 100 }, { probability: 3, costImpact: 100 },
      { probability: 4, costImpact: 100 }, { probability: 5, costImpact: 100 },
    ];
    expect(calculateRiskExposure(risks)).toBeCloseTo((0.05 + 0.2 + 0.4 + 0.6 + 0.85) * 100, 9);
  });

  test('the cost roll-ups partition the items: CAPEX plus OPEX plus other equals the phase total', () => {
    const items = G.example.inputs.costs;
    const byPhase = calculateCostByPhase(items);
    const phaseTotal = Object.values(byPhase).reduce((s, v) => s + v, 0);
    expect(calculateTotalCAPEX(items) + calculateTotalOPEX(items)).toBeCloseTo(phaseTotal, 9);
  });

  test('completeness is the fraction of nine checks, rounded, and a full plan is 100', () => {
    const full = G.plan.find((c) => c.name === 'complete plan').inputs;
    expect(calculateCompleteness(full).score).toBe(100);
    expect(calculateCompleteness({}).score).toBe(0);
    expect(calculateCompleteness({}).breakdown).toHaveLength(9);
    expect(validateFDPData(full).isValid).toBe(true);
  });

  test('EC6-0: the plan reads its reserves from the table, not from a key nothing writes', () => {
    const state = {
      subsurface: { reserves: { summary: { p50: 0 }, breakdown: [
        { name: 'A', fluid: 'Oil', p50: 85 }, { name: 'B', fluid: 'Gas', p50: 30 },
      ] } },
    };
    expect(planReservesP50(state)).toBe(85);
    expect(planReservesP50(state, 'Gas')).toBe(30);
    // the old path, still honoured for a plan that carries only a summary
    expect(planReservesP50({ subsurface: { reserves: { summary: { p50: 115 } } } })).toBe(115);
    // a full table no longer fails validation for want of a summary
    expect(validateFDPData({ ...state, fieldData: { fieldName: 'X' }, economics: { capex: 1 } }).errors)
      .not.toContain('Reserves (P50) not estimated.');
  });

  test('calculateResourceRequirements is an empty stub and returns an empty profile', () => {
    expect(calculateResourceRequirements([{ resources: { crew: 5, cost: 10 } }])).toEqual({});
  });

  test('the risk model enums are what the data files say', () => {
    expect(RiskTypes.TECHNICAL).toBe('Technical');
    expect(RiskStatus.ESCALATED).toBe('Escalated');
  });
});

// ---------------------------------------------------------------------------
// (b) Golden agreement.
// ---------------------------------------------------------------------------

const ROW_KEYS = ['year', 'grossRevenue', 'royalty', 'capex', 'opex', 'abex', 'tax', 'depreciation', 'pscUnrecoveredCost', 'ncf', 'cumulativeNCF', 'govTake'];

describe('golden: runFdpCase and the costCalculations view', () => {
  test.each(G.fdpCase.map((c) => [c.name, c]))('%s', (_n, c) => {
    const { capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal } = c.inputs;
    const r = runFdpCase({ capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal });
    const e = c.expected;
    expect(r.cashflow).toHaveLength(e.cashflow.length);
    r.cashflow.forEach((row, i) => ROW_KEYS.forEach((k) => expectNum(row[k], e.cashflow[i][k], MONEY)));
    ['npv', 'payback', 'maxExposure', 'totalRevenue', 'totalCapex', 'totalOpex', 'totalTax', 'totalRoyalty', 'totalGovTake']
      .forEach((k) => expectNum(r.metrics[k], e.metrics[k], MONEY));

    // IRR. Three outcomes: the same root by two methods; a root the engine
    // cannot reach (beyond its clamp, or none at all), where the golden pins
    // the engine's own number as a DISAGREEMENT beside the oracle's; or no
    // sign change, where 0 is the documented convention.
    if (e.engineReported) {
      // The engine's published number, pinned; and the gap to the oracle,
      // which must be real (a pin that could be removed silently is no pin).
      expect(e.engineReported.label).toMatch(/^DISAGREEMENT/);
      expectNum(r.metrics.irr, e.engineReported.irr, IRR);
      if (e.metrics.irr !== null) expect(Math.abs(e.metrics.irr - e.engineReported.irr)).toBeGreaterThan(100);
      if (e.irrBeyondEngineClamp) expect(e.irrRootsPercent[0]).toBeGreaterThan(1000);
      if (e.irrNoRoot) expect(e.irrRootsPercent).toBeNull();
    } else {
      expect(e.metrics.irr).not.toBeNull();
      expectNum(r.metrics.irr, e.metrics.irr, IRR);
    }
    if (e.paybackYears === null) expect(paybackYears(r)).toBeNull();
    else expectNum(paybackYears(r), e.paybackYears, MONEY);

    // costCalculations builds the same case from a price deck (missing
    // rows default to 70 there, which the oracle models separately).
    const rows = calculateCashFlows(capexMM, annualOpexMM, productionKbpd, deck(pricesUsd), fiscal);
    const cc = e.costCalculations;
    expect(rows).toHaveLength(cc.rows.length);
    rows.forEach((row, i) => Object.keys(cc.rows[i]).forEach((k) => expectNum(row[k], cc.rows[i][k], MONEY)));
    expectNum(calculateNPV(rows), cc.npv, MONEY);
    const irr = calculateIRR(rows);
    if (cc.irr === null) expect(irr).toBeNull();
    else expectNum(irr, cc.irr, Math.max(IRR, 1e-9 * Math.abs(cc.irr)));
    const pb = calculatePaybackPeriod(rows);
    if (cc.paybackPeriod === null) expect(pb).toBeNull();
    else expectNum(pb, cc.paybackPeriod, MONEY);
  });

  test('the two IRR conventions agree with each other wherever both exist inside the clamp', () => {
    G.fdpCase.forEach((c) => {
      const e = c.expected;
      if (e.metrics.irr !== null && e.irrExists && e.costCalculations.irr !== null && e.metrics.irr > 0
          && !e.costCalculations.priceDeckPaddedTo70) {
        expect(Math.abs(e.metrics.irr - e.costCalculations.irr)).toBeLessThan(1e-6);
      }
    });
  });
});

describe('golden: scenarios', () => {
  test.each(G.scenario.map((c) => [c.name, c]))('%s', (_n, c) => {
    const { scenario, concept } = c.inputs;
    const e = c.expected;
    const r = runScenario(scenario, concept);
    const prod = concept?.productionProfileKbpd?.length ? concept.productionProfileKbpd : conceptProfileKbpd(concept);
    expect(prod).toHaveLength(e.productionKbpd.length);
    prod.forEach((k, i) => expectNum(k, e.productionKbpd[i], RATIO));
    expectNum(r.metrics.npv, e.npv, MONEY);
    expectNum(scenarioNPV(scenario, concept), e.npv, MONEY);
    expectNum(r.metrics.totalTax, e.totalTax, MONEY);
    if (e.engineReported) {
      expect(e.engineReported.label).toMatch(/^DISAGREEMENT/);
      expectNum(scenarioIRR(scenario, concept), e.engineReported.irr, IRR);
      expect(e.irr).toBeNull();
    } else {
      expectNum(scenarioIRR(scenario, concept), e.irr, IRR);
    }
    if (e.payback === null) expect(scenarioPayback(scenario, concept)).toBeNull();
    else expectNum(scenarioPayback(scenario, concept), e.payback, MONEY);
    // The resolved inputs are what the engine actually ran: capex row 0 and
    // the opex of a producing year say so.
    expect(r.cashflow[0].capex).toBe(e.resolved.capexMM);
    const varOpex = (e.productionKbpd[0] * 1000 * 365 * DEFAULT_FISCAL.variableOpexPerBbl) / 1e6;
    expectNum(r.cashflow[1].opex, e.resolved.annualOpexMM + varOpex, MONEY);
    expectNum(r.cashflow[1].royalty, r.cashflow[1].grossRevenue * (e.resolved.royaltyRate / 100), MONEY);
  });
});

describe('golden: concepts', () => {
  test.each(G.concept.map((c) => [c.name, c]))('%s', (_n, c) => {
    const { concept, subsurfaceData } = c.inputs;
    const e = c.expected;
    const cost = calculateConceptCost(concept);
    ['totalCapex', 'totalOpex', 'totalLifecycleCost'].forEach((k) => expectNum(cost[k], e.cost[k], MONEY));
    if (e.schedule.throws) {
      expect(() => calculateConceptSchedule(concept)).toThrow(globalThis[e.schedule.throws]);
    } else {
      expect(calculateConceptSchedule(concept)).toEqual(e.schedule);
    }
    const ri = calculateReservesImpact(concept, subsurfaceData === null ? undefined : subsurfaceData);
    expectNum(ri.recoverableReserves, e.reserves.recoverableReserves, RATIO);
    expectNum(ri.rfMultiplier, e.reserves.rfMultiplier, RATIO);
  });
});

describe('golden: subsurface', () => {
  test.each(G.subsurface.ooip.map((c) => [c.name, c]))('OOIP %s', (_n, c) => {
    const { area, thickness, porosity, saturation, formationVolumeFactor } = c.inputs;
    const o = formationVolumeFactor === '__default__'
      ? calculateOOIP(area, thickness, porosity, saturation)
      : calculateOOIP(area, thickness, porosity, saturation, formationVolumeFactor);
    expectNum(o, c.expected.ooip, 1e-6 * Math.max(1, Math.abs(c.expected.ooip)));
    expectNum(calculateRecoverableReserves(o, 0.35), c.expected.recoverable_at_35pct, 1e-6 * Math.max(1, Math.abs(o)));
    expectNum(calculateRecoveryFactor(o, o * 0.35), c.expected.recoveryFactor_of_that, RATIO);
  });

  test.each(G.subsurface.recoveryFactor.map((c) => [c.name, c]))('%s', (_n, c) => {
    expectNum(calculateRecoveryFactor(c.inputs.ooip, c.inputs.recoverable), c.expected, RATIO);
  });

  test.each(G.subsurface.gradients.map((c) => [c.name, c]))('%s', (_n, c) => {
    const [v1, d1, v2, d2] = c.inputs;
    expectNum(calculatePressureGradient(v1, d1, v2, d2), c.expected, RATIO);
    expectNum(calculateTemperatureGradient(v1, d1, v2, d2), c.expected, RATIO);
  });

  test.each(G.subsurface.aggregateReserves.map((c) => [c.name, c]))('aggregate %s', (_n, c) => {
    const a = aggregateReserves(c.inputs);
    expect(a.fluids).toEqual(c.expected.fluids);
    expect(a.percentileNote).toBe(c.expected.percentileNote);
    Object.keys(c.expected.byFluid).forEach((f) => {
      const e = c.expected.byFluid[f];
      expect(a.byFluid[f].units).toBe(e.units);
      expect(a.byFluid[f].count).toBe(e.count);
      ['p90Sum', 'p50Sum', 'p10Sum', 'recoverableSum'].forEach((k) => expectNum(a.byFluid[f][k], e[k], RATIO));
    });
  });

  test.each(G.subsurface.aggregateReservesRefusals.map((c) => [c.name, c]))('aggregate refuses %s', (_n, c) => {
    expect(() => aggregateReserves(c.inputs)).toThrow(FdpInputError);
    try {
      aggregateReserves(c.inputs);
    } catch (err) {
      expect(err.message).toBe(c.expected.message);
    }
  });

  test('EC6-0: oil and gas never land in the same total', () => {
    const rows = [{ name: 'A', fluid: 'Oil', p50: 85 }, { name: 'B', fluid: 'Gas', p50: 30 }];
    const a = aggregateReserves(rows);
    expect(reservesP50(a)).toBe(85);
    expect(reservesP50(a, 'Gas')).toBe(30);
    // the retired total, for the record: it read 115 and was labelled MMbbl
    expect(Object.values(a.byFluid).reduce((s, t) => s + t.p50Sum, 0)).toBe(115);
    expect(a.percentileNote).toMatch(/sum of P90s is not the P90 of the sum/);
  });

  test('every cell of the risk score matrix', () => {
    G.subsurface.riskScore.forEach((c) => expect(calculateRiskScore(c.inputs[0], c.inputs[1])).toBe(c.expected));
  });
});

describe('golden: wells', () => {
  test('drilling time and cost across the md, trajectory and complexity grid', () => {
    G.wells.drillingTime.forEach((c) => {
      const { md, wellType, complexity } = c.inputs;
      const days = complexity === '__default__' ? calculateDrillingTime(md, wellType) : calculateDrillingTime(md, wellType, complexity);
      expect(days).toBe(c.expected.days);
      expectNum(calculateDrillingCost(days, 250000), c.expected.cost_at_250k_default_services, 1e-6);
    });
    expect(G.wells.drillingTime.length).toBeGreaterThanOrEqual(84);
  });

  test('drilling cost with and without a services estimate', () => {
    G.wells.drillingCost.forEach((c) => expectNum(calculateDrillingCost(...c.inputs), c.expected, 1e-6));
  });

  test('well count is the ceiling of reserves over EUR, and 0 without an EUR', () => {
    G.wells.wellCount.forEach((c) => expect(calculateWellCount(...c.inputs)).toBe(c.expected));
  });

  test.each(G.wells.aggregate.map((c, i) => [i, c]))('aggregate set %i', (_i, c) => {
    expect(aggregateWellsByType(c.inputs)).toEqual(c.expected.byType);
    expectNum(calculateTotalDrillingCost(c.inputs), c.expected.totalCost, 1e-6);
  });
});

describe('golden: facilities', () => {
  test('capacity', () => {
    G.facilities.capacity.forEach((c) => {
      const cap = calculateFacilityCapacity(c.inputs);
      Object.keys(c.expected).forEach((k) => expectNum(cap[k], c.expected[k], 1e-6));
    });
  });

  test('cost', () => {
    G.facilities.cost.forEach((c) => {
      const cost = calculateFacilityCost(c.inputs);
      Object.keys(c.expected).forEach((k) => expectNum(cost[k], c.expected[k], 1e-6));
    });
  });

  test.each(G.facilities.flowAssurance.map((c) => [JSON.stringify(c.inputs), c]))('flow assurance %s', (_n, c) => {
    const fluid = c.inputs.fluidProperties;
    expect(calculateFlowAssuranceRisk(c.inputs.facility, fluid === null ? undefined : fluid)).toEqual(c.expected);
  });

  test('bottlenecks', () => {
    G.facilities.bottlenecks.forEach((c) => {
      expect(identifyBottlenecks(c.inputs.facility, c.inputs.peakProduction)).toEqual(c.expected);
    });
  });
});

describe('golden: HSE', () => {
  test.each(G.hse.sets.map((c) => [c.name, c]))('%s', (_n, c) => {
    expect(calculateRiskMatrix(c.inputs)).toEqual(c.expected.matrix);
    expect(calculateTotalRiskScore(c.inputs)).toBe(c.expected.totalScore);
    expect(aggregateRisksByType(c.inputs)).toEqual(c.expected.byType);
  });

  test.each(G.hse.compliance.map((c) => [c.name, c]))('compliance %s', (_n, c) => {
    expect(calculateComplianceScore(c.inputs)).toBe(c.expected);
  });
});

describe('golden: risk management', () => {
  test.each(G.risk.map((c) => [c.name, c]))('%s', (_n, c) => {
    const e = c.expected;
    const score = calculateConsolidatedRiskScore(c.inputs);
    if (e.consolidatedScore === null) expect(Number.isNaN(score)).toBe(true);
    else expectNum(score, e.consolidatedScore, RATIO);
    expectNum(calculateRiskExposure(c.inputs), e.exposure, 1e-9);
    expect(aggregateRisksBySource(c.inputs)).toEqual(e.bySource);
    expect(aggregateRisksByLevel(c.inputs)).toEqual(e.byLevel);
    expect(calculatePortfolioHealth(c.inputs)).toBe(e.health);
  });
});

describe('golden: schedule', () => {
  const runnable = G.schedule.filter((c) => !c.expected.refused);

  test.each(runnable.map((c) => [c.name, c]))('%s', (_n, c) => {
    const e = c.expected;
    const dur = calculateProjectDuration(c.inputs);
    if (e.projectDuration === null) expect(dur).toBeNull();
    else expect(dur).toBe(e.projectDuration);
    expect(identifyMilestones(c.inputs).map((a) => a.id)).toEqual(e.milestones);

    const cpm = calculateCPM(c.inputs);
    expect(cpm).toHaveLength(c.inputs.length);
    if (!c.inputs.length) return;

    // The engine against the independent reference: the oracle computes the
    // same table two other ways (Kahn order and memoised recursion) and
    // asserts they agree before emitting it.
    expect(e.cpmReference.passesAgree).toBe(true);
    const byId = new Map(e.cpmReference.activities.map((a) => [a.id, a]));
    cpm.forEach((a) => {
      const r = byId.get(a.id);
      ['es', 'ef', 'ls', 'lf', 'float'].forEach((k) => expect(a[k]).toBeCloseTo(r[k], 9));
      expect(a.isCritical).toBe(r.isCritical);
    });
    expect(calculateNetworkDuration(c.inputs)).toBeCloseTo(e.cpmReference.projectDurationDays, 9);
    expect(criticalPaths(c.inputs)).toEqual(e.cpmReference.criticalPaths);

    // CPM's own identities, on the engine's table.
    cpm.forEach((a) => {
      const duration = Number(a.duration) || 0;
      expect(a.ef).toBeCloseTo(a.es + duration, 9);
      expect(a.float).toBeCloseTo(a.ls - a.es, 9);
      expect(a.float).toBeGreaterThanOrEqual(-1e-9);
      expect(a.lf).toBeLessThanOrEqual(e.cpmReference.projectDurationDays + 1e-9);
    });
    e.cpmReference.criticalPaths.forEach((path) => {
      const total = path.reduce((sum, id) => sum + (Number(c.inputs.find((x) => x.id === id).duration) || 0), 0);
      expect(total).toBeCloseTo(e.cpmReference.projectDurationDays, 9);
    });

    // NEGATIVE CONTROL: the retired passthrough called these activities
    // critical, and the method does not. If this list ever empties the
    // repair has been undone.
    const retired = new Set(e.retiredPassthrough.filter((a) => a.isCritical).map((a) => a.id));
    const nowCritical = new Set(cpm.filter((a) => a.isCritical).map((a) => a.id));
    const differing = c.inputs.map((a) => a.id).filter((id) => retired.has(id) !== nowCritical.has(id));
    expect(differing).toEqual(e.criticalityDisagreements);
  });

  test.each(G.schedule.filter((c) => c.expected.refused).map((c) => [c.name, c]))('refuses %s', (_n, c) => {
    expect(() => calculateCPM(c.inputs)).toThrow(FdpInputError);
    try {
      calculateCPM(c.inputs);
    } catch (err) {
      expect(err.message).toBe(c.expected.message);
    }
  });

  test('the textbook network: A-B-D-F at 14 days, four days of float on C and E', () => {
    const c = G.schedule.find((x) => x.name.startsWith('textbook network'));
    const cpm = calculateCPM(c.inputs);
    expect(cpm.filter((a) => a.isCritical).map((a) => a.id)).toEqual(['A', 'B', 'D', 'F']);
    expect(cpm.find((a) => a.id === 'C').float).toBe(4);
    expect(cpm.find((a) => a.id === 'E').float).toBe(4);
    expect(calculateNetworkDuration(c.inputs)).toBe(14);
    expect(criticalPaths(c.inputs)).toEqual([['A', 'B', 'D', 'F']]);
    // what the app used to show on this network
    expect(c.expected.retiredPassthrough.every((a) => a.isCritical)).toBe(true);
    expect(c.expected.criticalityDisagreements).toEqual(['C', 'E']);
  });

  test('the example schedule: act-2 and act-5 carry float the passthrough denied', () => {
    const c = G.schedule.find((x) => x.name.startsWith('example schedule'));
    const cpm = calculateCPM(c.inputs);
    expect(cpm.filter((a) => a.isCritical).map((a) => a.id)).toEqual(['act-1', 'act-3', 'act-4', 'act-6', 'act-7']);
    expect(cpm.find((a) => a.id === 'act-2').float).toBe(20);
    expect(cpm.find((a) => a.id === 'act-5').float).toBe(20);
    expect(c.expected.cpmReference.projectDurationDays).toBe(330);
    expect(c.expected.criticalityDisagreements).toEqual(['act-2', 'act-5']);
  });

  test('a diamond with equal legs: both paths are critical (a tie, listed twice)', () => {
    const c = G.schedule.find((x) => x.name.startsWith('diamond'));
    expect(criticalPaths(c.inputs)).toEqual([['A', 'B', 'D'], ['A', 'C', 'D']]);
    expect(c.expected.criticalityDisagreements).toEqual([]);
  });

  test('EC6-0: a span with no readable dates is null, and the count is in calendar days', () => {
    expect(calculateProjectDuration([{ id: 'a', duration: 3 }])).toBeNull();
    expect(calculateProjectDuration([])).toBe(0);
    expect(calculateProjectDuration([
      { id: 'a', startDate: '2026-10-30', endDate: '2026-11-03' },
    ])).toBe(4);
  });
});

describe('golden: plan completeness and validation', () => {
  test.each(G.plan.map((c) => [c.name, c]))('%s', (_n, c) => {
    expect(calculateCompleteness(c.inputs)).toEqual(c.expected.completeness);
    expect(validateFDPData(c.inputs)).toEqual(c.expected.validation);
  });
});

describe('golden: cost items', () => {
  test.each(G.costItems.map((c) => [c.name, c]))('%s', (_n, c) => {
    const items = c.inputs;
    expectNum(calculateTotalCAPEX(items), c.expected.totalCAPEX, 1e-9);
    expectNum(calculateTotalOPEX(items), c.expected.totalOPEX, 1e-9);
    if (c.expected.byPhase !== null) {
      const by = calculateCostByPhase(items);
      expect(Object.keys(by).sort()).toEqual(Object.keys(c.expected.byPhase).sort());
      Object.keys(by).forEach((k) => expectNum(by[k], c.expected.byPhase[k], 1e-9));
    } else {
      expect(() => calculateCostByPhase(items)).toThrow(TypeError);
    }
  });
});

describe('golden: scenario refusals', () => {
  test.each(G.scenarioRefusals.map((c) => [c.name, c]))('refuses %s', (_n, c) => {
    const { scenario, concept } = c.inputs;
    expect(() => runScenario(scenario, concept)).toThrow(FdpInputError);
    try {
      runScenario(scenario, concept);
    } catch (err) {
      expect(err.message).toBe(c.expected.message);
    }
  });

  test('NEGATIVE CONTROL: every refused case used to return a full set of economics', () => {
    // The retired defaults: capex 100, opex 10, peak 50 kbpd, price $70,
    // and a fiscal rate that did not parse fell back to DEFAULT_FISCAL.
    // Restated here (runFdpCase carries no guards) to show that these
    // inputs really did produce a card rather than an error, so the
    // refusals above are a change in behaviour and not a change in wording.
    const retiredProfile = (peak) => {
      const p = [];
      for (let y = 1; y <= 20; y += 1) p.push(y <= 3 ? peak : peak * 0.9 ** (y - 3));
      return p;
    };
    G.scenarioRefusals.forEach((c) => {
      const { scenario, concept } = c.inputs;
      const productionKbpd = retiredProfile(parseFloat(concept.peakProduction) || 50);
      const asBefore = runFdpCase({
        capexMM: parseFloat(concept.capex) || 100,
        annualOpexMM: parseFloat(concept.opex) || 10,
        productionKbpd,
        pricesUsd: new Array(productionKbpd.length).fill(parseFloat(scenario.oilPrice) || 70),
        fiscal: { discountRate: 10, royaltyRate: DEFAULT_FISCAL.royaltyRate, taxRate: DEFAULT_FISCAL.taxRate },
      });
      expect(Number.isFinite(asBefore.metrics.npv)).toBe(true);
    });
  });

  test('the headline case: the three capex fields are read, not the field nobody writes', () => {
    const concept = {
      drillingCapex: 400, facilitiesCapex: 1200, subseaCapex: 300, opex: 60, peakProduction: 50,
    };
    expect(conceptCapexMM(concept)).toBe(1900);
    const r = runScenario({ oilPrice: 70, discountRate: 10 }, concept);
    expect(r.metrics.npv).toBeCloseTo(1791.4, 0);
    expect(r.metrics.irr).toBeCloseTo(30.0, 0);
    // what the app showed while the capex fell back to 100
    const retired = runScenario({ oilPrice: 70, discountRate: 10 },
      { capex: 100, opex: 60, peakProduction: 50 });
    expect(retired.metrics.npv).toBeCloseTo(3507.6, 0);
    expect(retired.metrics.irr).toBeCloseTo(676.4, 0);
  });
});

describe('golden: the sensitivity sweep', () => {
  test.each(G.sensitivity.map((c) => [c.name, c]))('%s', (_n, c) => {
    const i = c.inputs;
    const sens = runFdpSensitivity({
      capexMM: i.capexMM,
      annualOpexMM: i.annualOpexMM,
      productionKbpd: i.productionKbpd,
      pricesUsd: i.pricesUsd,
      fiscal: i.fiscal || {},
    });
    expect(sens.map((x) => x.name)).toEqual(c.expected.map((x) => x.name));
    sens.forEach((x, k) => {
      expectNum(x.lowParamNPV, c.expected[k].lowParamNPV, MONEY);
      expectNum(x.highParamNPV, c.expected[k].highParamNPV, MONEY);
      expectNum(x.baseNPV, c.expected[k].baseNPV, MONEY);
    });
  });

  test('the sweep is about the case in front of the user, not a fixed picture', () => {
    const base = {
      capexMM: 800,
      annualOpexMM: 60,
      productionKbpd: new Array(10).fill(50),
      pricesUsd: new Array(10).fill(70),
    };
    const a = runFdpSensitivity(base);
    const b = runFdpSensitivity({ ...base, capexMM: 1600 });
    expect(Math.abs(a[0].baseNPV - b[0].baseNPV)).toBeGreaterThan(1);
    // the base NPV in the sweep is the case's own NPV
    expectNum(a[0].baseNPV, runFdpCase(base).metrics.npv, MONEY);
    // and the scenario wrapper sweeps the same case the card shows
    const concept = { drillingCapex: 800, opex: 60, peakProduction: 50 };
    const scenario = { oilPrice: 70, discountRate: 10 };
    expectNum(scenarioSensitivity(scenario, concept)[0].baseNPV,
      runScenario(scenario, concept).metrics.npv, MONEY);
  });

  test('buildFdpCaseInputs is the case runFdpCase runs', () => {
    const p = {
      capexMM: 500, annualOpexMM: 20, productionKbpd: [10, 20], pricesUsd: [60, 60],
    };
    const inputs = buildFdpCaseInputs(p);
    expect(inputs.capex[0]).toBe(500);
    expect(inputs.projectLife).toBe(3);
    expect(inputs.production.oil[1]).toBeCloseTo(10 * 1000 * 365, 9);
  });
});

describe('golden: the worked example, end to end', () => {
  const { inputs: I, expected: E } = G.example;

  test('cost roll-ups', () => {
    expectNum(calculateTotalCAPEX(I.costs), E.costs.totalCAPEX, 1e-9);
    expectNum(calculateTotalOPEX(I.costs), E.costs.totalOPEX, 1e-9);
    const by = calculateCostByPhase(I.costs);
    Object.keys(E.costs.byPhase).forEach((k) => expectNum(by[k], E.costs.byPhase[k], 1e-9));
  });

  test('wells: days and cost as WellForm computes them, counts by type', () => {
    I.wells.forEach((w, i) => {
      const days = calculateDrillingTime(w.md, w.trajectory);
      expect(days).toBe(E.wells[i].days);
      expectNum(calculateDrillingCost(days, I.rigRate), E.wells[i].cost, 1e-6);
    });
    expect(aggregateWellsByType(I.wells)).toEqual(E.wellsByType);
    expect(calculateTotalDrillingCost(I.wells)).toBe(E.totalDrillingCostFromCostField);
  });

  test('facilities: capacity, cost, flow assurance, bottlenecks', () => {
    I.facilities.forEach((f, i) => {
      const cap = calculateFacilityCapacity(f);
      Object.keys(E.facilities[i].capacity).forEach((k) => expectNum(cap[k], E.facilities[i].capacity[k], 1e-6));
      const cost = calculateFacilityCost(f);
      Object.keys(E.facilities[i].cost).forEach((k) => expectNum(cost[k], E.facilities[i].cost[k], 1e-6));
      expect(calculateFlowAssuranceRisk(f, undefined)).toEqual(E.facilities[i].flowAssurance);
      expect(identifyBottlenecks(f, I.peakProduction)).toEqual(E.facilities[i].bottlenecks);
    });
  });

  test('HSE and risk indices', () => {
    expect(calculateRiskMatrix(I.hseRisks)).toEqual(E.hse.matrix);
    expect(calculateTotalRiskScore(I.hseRisks)).toBe(E.hse.totalScore);
    expect(aggregateRisksByType(I.hseRisks)).toEqual(E.hse.byType);
    expect(calculateConsolidatedRiskScore(I.hseRisks)).toBe(E.risk.consolidatedScore);
    expect(calculateRiskExposure(I.hseRisks)).toBe(E.risk.exposure);
    expect(aggregateRisksBySource(I.hseRisks)).toEqual(E.risk.bySource);
    expect(aggregateRisksByLevel(I.hseRisks)).toEqual(E.risk.byLevel);
    expect(calculatePortfolioHealth(I.hseRisks)).toBe(E.risk.health);
  });

  test('reserves and volumetrics', () => {
    const agg = aggregateReserves(I.reservoirs);
    expect(agg.fluids).toEqual(E.reserves.fluids);
    Object.keys(E.reserves.byFluid).forEach((f) => {
      ['p90Sum', 'p50Sum', 'p10Sum', 'recoverableSum'].forEach(
        (k) => expectNum(agg.byFluid[f][k], E.reserves.byFluid[f][k], 1e-9),
      );
      expect(agg.byFluid[f].units).toBe(E.reserves.byFluid[f].units);
    });
    const oilP50 = reservesP50(agg);
    const z = I.zone;
    const o = calculateOOIP(z.area, z.thickness, z.porosity, z.sw, z.bo);
    expectNum(o, E.ooip, 1e-6);
    expectNum(calculateRecoveryFactor(o, oilP50 * 1e6), E.recoveryFactor, RATIO);
    expect(calculateWellCount(oilP50, 12)).toBe(E.wellCountAt12MMbbl);
    // the volumetrics read OIL, in MMbbl: the gas row is not in this number
    expect(oilP50).toBe(85);
  });

  test('schedule', () => {
    expect(identifyMilestones(I.schedule).map((a) => a.id)).toEqual(E.schedule.milestones);
    // the example carries start and end, not startDate and endDate
    expect(calculateProjectDuration(I.schedule)).toBeNull();
    const cpm = calculateCPM(I.schedule);
    const byId = new Map(E.schedule.cpmReference.activities.map((a) => [a.id, a]));
    cpm.forEach((a) => {
      expect(a.isCritical).toBe(byId.get(a.id).isCritical);
      expect(a.float).toBeCloseTo(byId.get(a.id).float, 9);
    });
    expect(E.schedule.cpmReference.criticalActivities).toEqual(['act-1', 'act-3', 'act-4', 'act-6', 'act-7']);
    expect(cpm.filter((a) => a.isCritical).map((a) => a.id)).toEqual(E.schedule.cpmReference.criticalActivities);
  });

  test('the example sensitivity sweep', () => {
    const sens = runFdpSensitivity({
      capexMM: 1500, annualOpexMM: 65, productionKbpd: conceptProfileKbpd({ peakProduction: 150 }),
      pricesUsd: new Array(20).fill(70),
    });
    expect(sens.map((x) => x.name)).toEqual(E.sensitivity.map((x) => x.name));
    sens.forEach((x, i) => {
      expectNum(x.lowParamNPV, E.sensitivity[i].lowParamNPV, MONEY);
      expectNum(x.highParamNPV, E.sensitivity[i].highParamNPV, MONEY);
      expectNum(x.baseNPV, E.sensitivity[i].baseNPV, MONEY);
    });
  });

  test('the FPSO concept scenario', () => {
    const r = runScenario(I.scenario, I.concept);
    expectNum(r.metrics.npv, E.scenario.npv, MONEY);
    expectNum(r.metrics.irr, E.scenario.irr, IRR);
    expectNum(scenarioPayback(I.scenario, I.concept), E.scenario.payback, MONEY);
  });
});
