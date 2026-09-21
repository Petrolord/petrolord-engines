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
  resolveAbandonment, planAbandonment, ABANDONMENT_SOURCES,
} from '../engines/economics/fdp/economics.js';
import {
  calculateCashFlows, calculateNPV, calculateIRR, calculatePaybackPeriod,
  calculateTotalCAPEX, calculateTotalOPEX, calculateCostByPhase,
} from '../engines/economics/fdp/costCalculations.js';
import {
  runScenario, scenarioNPV, scenarioIRR, scenarioPayback, conceptProfileKbpd,
  conceptCapex, conceptCapexMM, scenarioCase, scenarioSensitivity,
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
  SCREENING_RECOVERY_PER_WELL_MMBBL,
} from '../engines/economics/fdp/wellCalculations.js';
import {
  calculateFacilityCapacity, calculateFacilityCost, calculateFlowAssuranceRisk, identifyBottlenecks,
  screenSourService, SOUR_SERVICE_THRESHOLD_PSIA, CORROSION_STATUSES,
} from '../engines/economics/fdp/facilitiesCalculations.js';
import {
  calculateRiskMatrix, calculateTotalRiskScore, aggregateRisksByType, calculateComplianceScore,
} from '../engines/economics/fdp/hseCalculations.js';
import {
  calculateConsolidatedRiskScore, calculateRiskExposure, aggregateRisksBySource, aggregateRisksByLevel,
  calculatePortfolioHealth, countUnscoredRisks,
} from '../engines/economics/fdp/riskCalculations.js';
import {
  calculateProjectDuration, calculateCPM, calculateResourceRequirements, identifyMilestones,
  calculateNetworkDuration, criticalPaths,
} from '../engines/economics/fdp/scheduleCalculations.js';
import {
  calculateCompleteness, validateFDPData, planReservesP50, planReservesCheck, RESERVES_PROFILE_MARGIN,
} from '../engines/economics/fdp/fdpCalculations.js';
import { FdpInputError } from '../engines/economics/fdp/inputError.js';
import { getRiskLevel, riskScore, RiskTypes, RiskStatus } from '../engines/economics/fdp/riskModel.js';
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

/**
 * EC6-3: the corrosion screen. Strings, the threshold and the status are
 * exact; the partial pressures are compared to a tolerance because the
 * oracle reaches them by a different road (ppm x pressure over a million,
 * where the engine takes the mole fraction first, and its own psi to kPa
 * conversion from the definition of the pound-force per square inch).
 */
const expectCorrosion = (actual, expected) => {
  ['status', 'message', 'standard', 'thresholdPsia', 'thresholdKpa']
    .forEach((k) => expect(actual[k]).toEqual(expected[k]));
  ['h2sPpm', 'operatingPressurePsia', 'h2sPartialPressurePsia', 'h2sPartialPressureKpa'].forEach((k) => {
    if (expected[k] === null) expect(actual[k]).toBeNull();
    else expect(Math.abs(actual[k] - expected[k])).toBeLessThanOrEqual(1e-12);
  });
};

/** EC6-1: the plan reserves check. Volumes and ratios to a tolerance. */
const expectReservesCheck = (actual, expected) => {
  ['status', 'profileSource', 'recoveryPerWellSource', 'profileYears', 'impliedWells',
    'carriedWells', 'recoveryPerWellMMbbl', 'marginFraction']
    .forEach((k) => expect(actual[k]).toEqual(expected[k]));
  expect(actual.missing).toEqual(expected.missing);
  expect(actual.warnings).toEqual(expected.warnings);
  ['profileVolumeMMbbl', 'oilP50MMbbl', 'profileToP50Ratio', 'wellsRatio'].forEach((k) => {
    if (expected[k] === null) expect(actual[k]).toBeNull();
    else expect(Math.abs(actual[k] - expected[k])).toBeLessThanOrEqual(1e-9);
  });
};

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
    expect(lv.Unscored).toBe(0);
    const m = calculateRiskMatrix(risks);
    // EC6-1: the HSE matrix bands on the SAME scale as the register, so the
    // two screens agree about what a score of 12 is. It used to band on 15
    // and 8 and had no Critical band at all.
    expect(m.low + m.medium + m.high + m.critical + m.unscored).toBe(m.total);
    expect(m.critical).toBe(lv.Critical);
    expect(m.high).toBe(lv.High);
    expect(m.medium).toBe(lv.Medium);
    expect(m.low).toBe(lv.Low);
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

    // IRR. EC6-1: a rate is reported only when it is a single root inside
    // the band the engine searches, and `irrStatus` carries the reason when
    // there is none. There are no disagreements left to pin.
    expect(r.metrics.irrStatus).toBe(e.metrics.irrStatus);
    if (e.metrics.irr === null) {
      expect(r.metrics.irr).toBeNull();
      if (e.irrBeyondEngineClamp) {
        expect(e.metrics.irrStatus).toBe('above-clamp');
        expect(e.irrRootsPercent[0]).toBeGreaterThan(1000);
      }
      if (e.irrNoRoot) {
        expect(e.metrics.irrStatus).toBe('no-root');
        expect(e.irrRootsPercent).toBeNull();
      }
    } else {
      expectNum(r.metrics.irr, e.metrics.irr, IRR);
      // and it really is a root of this cash flow
      const rate = r.metrics.irr / 100;
      const npvAtIrr = r.cashflow.reduce((sum, cf, i) => sum + cf.ncf / (1 + rate) ** (i + 0.5), 0);
      const scale = r.cashflow.reduce((sum, cf) => sum + Math.abs(cf.ncf), 0);
      expect(Math.abs(npvAtIrr) / scale).toBeLessThan(1e-8);
    }
    if (e.paybackYears === null) expect(paybackYears(r)).toBeNull();
    else expectNum(paybackYears(r), e.paybackYears, MONEY);

    // costCalculations builds the same case from a price deck. EC6-1: a deck
    // that does not cover the profile is refused rather than padded with 70,
    // which is what made the two doors disagree.
    const cc = e.costCalculations;
    if (cc.priceDeckRefused) {
      expect(() => calculateCashFlows(capexMM, annualOpexMM, productionKbpd, deck(pricesUsd), fiscal))
        .toThrow(FdpInputError);
      return;
    }
    const rows = calculateCashFlows(capexMM, annualOpexMM, productionKbpd, deck(pricesUsd), fiscal);
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
          && !e.costCalculations.priceDeckRefused) {
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
    // EC6-9: the card says whether the capex it screened is complete.
    expect(r.capexStatus).toBe(e.capexStatus);
    expect(r.capexMissing).toEqual(e.capexMissing);
    expect(r.capexStatus === 'partial').toBe(e.capexMissing.length > 0);
    expect(conceptCapex(concept)).toEqual({
      capexMM: e.resolved.capexMM, capexStatus: e.capexStatus, capexMissing: e.capexMissing,
    });
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
    const r = calculateFlowAssuranceRisk(c.inputs.facility, fluid === null ? undefined : fluid);
    const { corrosion, ...rest } = r;
    const { corrosion: expectedCorrosion, ...expectedRest } = c.expected;
    expect(rest).toEqual(expectedRest);
    expectCorrosion(corrosion, expectedCorrosion);
    expectCorrosion(screenSourService(fluid === null ? undefined : fluid), expectedCorrosion);
    expect(CORROSION_STATUSES).toContain(corrosion.status);
    // EC6-3: the corrosion points are scored on the sour service status alone.
    expect(r.contributions.some((x) => x.hazards.includes('Corrosion')))
      .toBe(corrosion.status === 'sour-service');
    // EC6-2: the score is the sum of its named contributions, and no band.
    expect(r.contributions.reduce((sum, x) => sum + x.points, 0)).toBe(r.score);
    expect(r.contributions.flatMap((x) => x.hazards)).toEqual(r.hazards);
    expect(r.risks.map((x) => x.type)).toEqual(r.hazards);
    expect(r).not.toHaveProperty('level');
  });

  test('EC6-2 NEGATIVE CONTROL: the retired band borrowed the register words for a different quantity', () => {
    // The retired rule, restated: High above 5, Medium above 2, Low otherwise.
    const retiredBand = (score) => (score > 5 ? 'High' : score > 2 ? 'Medium' : 'Low');
    G.facilities.flowAssurance.forEach((c) => expect(retiredBand(c.expected.score)).toBe(c.retired.level));
    const three = G.facilities.flowAssurance.find((c) => c.expected.score === 3 && c.note);
    expect(three.inputs.facility.type).toBe('Subsea Tie-back');
    expect(three.retired.level).toBe('Medium');
    expect(getRiskLevel(3).level).toBe('Low');
    const r = calculateFlowAssuranceRisk(three.inputs.facility, undefined);
    expect(r.score).toBe(3);
    expect(r.hazards).toEqual(['Hydrates', 'Wax']);
    expect(r.level).toBeUndefined();
    // Across the goldens the retired band and the register disagree on
    // some score, so the retirement is a change and not a relabel.
    const disagree = G.facilities.flowAssurance
      .filter((c) => c.retired.level !== getRiskLevel(c.expected.score).level);
    expect(disagree.length).toBeGreaterThan(0);
  });

  test('EC6-3: the corrosion screen is the H2S partial pressure against the NACE threshold', () => {
    expect(SOUR_SERVICE_THRESHOLD_PSIA).toBe(0.05);
    // 100 ppm at 1000 psia is 0.1 psia, twice the threshold.
    const sour = screenSourService({ h2s: 100, operatingPressurePsia: 1000 });
    expect(sour.status).toBe('sour-service');
    expect(sour.h2sPartialPressurePsia).toBeCloseTo(0.1, 12);
    expect(sour.h2sPartialPressureKpa).toBeCloseTo(0.1 * 6.894757293168361, 12);
    // the same 100 ppm at 400 psia is 0.04 psia, below it
    expect(screenSourService({ h2s: 100, operatingPressurePsia: 400 }).status).toBe('below-sour-threshold');
    // blank, measured without a pressure, and a measured zero
    expect(screenSourService(undefined).status).toBe('not-measured');
    expect(screenSourService({ api: 30 }).status).toBe('not-measured');
    expect(screenSourService({ h2s: '' }).status).toBe('not-measured');
    expect(screenSourService({ h2s: 50 }).status).toBe('sour-severity-needs-pressure');
    expect(screenSourService({ h2s: 0 }).status).toBe('below-sour-threshold');
    expect(screenSourService({ h2s: 0 }).h2sPartialPressurePsia).toBe(0);
    // the messages carry the numbers and no severity is claimed without them
    expect(screenSourService(undefined).message).toMatch(/not measured/);
    expect(screenSourService({ h2s: 50 }).message).toMatch(/enter the operating pressure in psia/);
  });

  test.each(G.facilities.flowAssuranceRefusals.map((c) => [c.name, c]))('refuses %s', (_n, c) => {
    expect(() => calculateFlowAssuranceRisk({ type: 'FPSO' }, c.inputs)).toThrow(FdpInputError);
    try {
      screenSourService(c.inputs);
    } catch (err) {
      expect(err.message).toBe(c.expected.message);
    }
  });

  test('EC6-3 NEGATIVE CONTROL: the retired trigger fired at any H2S above zero, always High', () => {
    // The retired rule, restated: `(fluidProperties?.h2s || 0) > 0` scored 4
    // points and a High corrosion risk, and a blank H2S was 0, so it read
    // as sweet.
    const retiredFired = (fluid) => ((fluid?.h2s || 0) > 0);
    G.facilities.flowAssurance.forEach((c) => {
      const fluid = c.inputs.fluidProperties === null ? undefined : c.inputs.fluidProperties;
      expect(retiredFired(fluid)).toBe(c.retired.corrosionFired);
    });
    const disagree = G.facilities.flowAssurance
      .filter((c) => c.retired.corrosionFired !== (c.expected.corrosion.status === 'sour-service'));
    expect(disagree.length).toBeGreaterThan(0);
    // 1 ppm at 100 psia is 0.0001 psia, five hundred times below the
    // threshold, and it used to score the same 4 points as 5 percent H2S.
    const trace = { api: 32, h2s: 1, operatingPressurePsia: 100 };
    const severe = { api: 32, h2s: 50000, operatingPressurePsia: 5000 };
    expect(retiredFired(trace)).toBe(true);
    expect(retiredFired(severe)).toBe(true);
    expect(calculateFlowAssuranceRisk({ type: 'FPSO' }, trace).score).toBe(0);
    expect(calculateFlowAssuranceRisk({ type: 'FPSO' }, severe).score).toBe(4);
    // and a blank H2S is no longer an answer at all
    expect(retiredFired(undefined)).toBe(false);
    expect(calculateFlowAssuranceRisk({ type: 'FPSO' }, undefined).corrosion.status).toBe('not-measured');
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

  test('EC6-4 NEGATIVE CONTROL: only the empty plan moved, and it used to read 0', () => {
    const moved = G.schedule.filter((c) => !c.expected.refused
      && c.expected.retiredProjectDuration !== c.expected.projectDuration);
    expect(moved.map((c) => c.inputs.length)).toEqual([0]);
    expect(moved[0].expected.retiredProjectDuration).toBe(0);
    expect(moved[0].expected.projectDuration).toBeNull();
    expect(calculateProjectDuration(moved[0].inputs)).toBeNull();
    expect(calculateProjectDuration(undefined)).toBeNull();
  });

  test('EC6-0: a span with no readable dates is null, and the count is in calendar days', () => {
    expect(calculateProjectDuration([{ id: 'a', duration: 3 }])).toBeNull();
    // EC6-4: an empty plan is null too (it was 0)
    expect(calculateProjectDuration([])).toBeNull();
    expect(calculateProjectDuration([
      { id: 'a', startDate: '2026-10-30', endDate: '2026-11-03' },
    ])).toBe(4);
  });
});

describe('golden: plan completeness and validation', () => {
  test.each(G.plan.map((c) => [c.name, c]))('%s', (_n, c) => {
    const { reservesCheck, ...completeness } = calculateCompleteness(c.inputs);
    const { reservesCheck: expectedCheck, ...expectedCompleteness } = c.expected.completeness;
    expect(completeness).toEqual(expectedCompleteness);
    expectReservesCheck(reservesCheck, expectedCheck);
    expect(reservesCheck).toEqual(planReservesCheck(c.inputs));

    const { reservesCheck: validationCheck, ...validation } = validateFDPData(c.inputs);
    const { reservesCheck: expectedValidationCheck, ...expectedValidation } = c.expected.validation;
    expect(validation).toEqual(expectedValidation);
    expectReservesCheck(validationCheck, expectedValidationCheck);
  });
});

describe('EC6-1: the reserves check against the profile', () => {
  const egina = G.plan.find((c) => c.name.startsWith('EC6-1: the EGINA plan'));

  test('the headline case: a screening shape far above the P50, on too few wells', () => {
    const check = planReservesCheck(egina.inputs);
    expect(check.status).toBe('checked');
    expect(check.profileVolumeMMbbl).toBeCloseTo(229.9293, 4);
    expect(check.oilP50MMbbl).toBe(130);
    expect(check.profileToP50Ratio).toBeCloseTo(229.9293 / 130, 6);
    expect(check.impliedWells).toBe(11);
    expect(check.carriedWells).toBe(4);
    expect(check.wellsRatio).toBeCloseTo(11 / 4, 12);
    expect(check.recoveryPerWellMMbbl).toBe(SCREENING_RECOVERY_PER_WELL_MMBBL);
    expect(check.warnings.map((w) => w.code))
      .toEqual(['profile-exceeds-p50', 'implied-wells-exceed-carried']);
    // Non-blocking and uncapped: the score is what it always was, the plan
    // is valid, and the warnings are on the result instead.
    const completeness = calculateCompleteness(egina.inputs);
    expect(completeness.score).toBe(100);
    expect(completeness.completeWithWarnings).toBe(true);
    const validation = validateFDPData(egina.inputs);
    expect(validation.isValid).toBe(true);
    expect(validation.warnings).toEqual(expect.arrayContaining(check.warnings.map((w) => w.message)));
  });

  test('a profile within the margin and wells enough raises nothing', () => {
    const within = G.plan.find((c) => c.name.includes('within the margin'));
    const check = planReservesCheck(within.inputs);
    expect(check.status).toBe('checked');
    expect(check.profileToP50Ratio).toBeLessThanOrEqual(1 + RESERVES_PROFILE_MARGIN);
    expect(check.warnings).toEqual([]);
    expect(calculateCompleteness(within.inputs).completeWithWarnings).toBe(false);
  });

  test('NEGATIVE CONTROL: the retired result compared nothing, so it was silent on every one of them', () => {
    // The retired rule, restated: completeness was the nine section checks
    // and validation was the six field checks, and NEITHER looked at the
    // profile, the reserves or the well count. Restating it is restating
    // silence, so the control is that the silence disagrees.
    const retiredValidationWarnings = (state) => {
      const warnings = [];
      if ((state.wells?.list?.length || 0) === 0) warnings.push('No wells defined in the drilling program.');
      if ((state.facilities?.list?.length || 0) === 0) warnings.push('No facilities concepts selected.');
      if ((state.costs?.items?.length || 0) === 0) warnings.push('Cost breakdown is empty.');
      return warnings;
    };
    const warned = G.plan.filter((c) => c.expected.completeness.reservesCheck.warnings.length);
    expect(warned.length).toBeGreaterThan(0);
    warned.forEach((c) => {
      const retired = retiredValidationWarnings(c.inputs);
      const now = validateFDPData(c.inputs).warnings;
      expect(retired).toEqual(now.slice(0, retired.length));
      // every reserves warning is new, and the retired result had no check
      expect(now.length).toBeGreaterThan(retired.length);
      expect(calculateCompleteness(c.inputs).reservesCheck.warnings.length).toBeGreaterThan(0);
    });
    // and the EGINA plan is the one that used to read 100 percent complete
    // and perfectly clean
    expect(retiredValidationWarnings(egina.inputs)).toEqual([]);
    expect(calculateCompleteness(egina.inputs).score).toBe(100);
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

describe('EC6-9: a partial concept capex is screened and named', () => {
  const partial = G.scenario.find((c) => c.name === 'a partial concept: the facilities capex is left blank');
  const complete = G.scenario.find((c) => c.name === 'the same concept with its facilities capex entered is complete');

  test('the golden pair: 1350 partial with facilitiesCapex missing, 2250 complete', () => {
    expect(partial.expected.resolved.capexMM).toBe(1350);
    expect(partial.expected.capexStatus).toBe('partial');
    expect(partial.expected.capexMissing).toEqual(['facilitiesCapex']);
    expect(complete.expected.resolved.capexMM).toBe(2250);
    expect(complete.expected.capexStatus).toBe('complete');
    expect(complete.expected.capexMissing).toEqual([]);
    const r = runScenario(partial.inputs.scenario, partial.inputs.concept);
    expect(r.capexStatus).toBe('partial');
    expect(r.capexMissing).toEqual(['facilitiesCapex']);
  });

  test('NEGATIVE CONTROL: the retired result carried the partial sum with nothing to say so', () => {
    // The retired card: the screening result of the same case, no status.
    const asBefore = runFdpCase(scenarioCase(partial.inputs.scenario, partial.inputs.concept));
    expect(asBefore).not.toHaveProperty('capexStatus');
    expect(asBefore).not.toHaveProperty('capexMissing');
    expect(asBefore.cashflow[0].capex).toBe(1350);
    // and that partial NPV is not the complete concept's NPV
    expectNum(asBefore.metrics.npv, partial.expected.npv, MONEY);
    expect(partial.expected.npv - complete.expected.npv).toBeGreaterThan(1);
  });

  test('an all-blank concept is still refused, and a total capex is complete', () => {
    expect(() => conceptCapex({ drillingCapex: '', subseaCapex: null })).toThrow(FdpInputError);
    expect(conceptCapex({ capex: 1900 })).toEqual({ capexMM: 1900, capexStatus: 'complete', capexMissing: [] });
    expect(conceptCapex({ drillingCapex: 0, facilitiesCapex: 0, subseaCapex: 0 }).capexStatus).toBe('complete');
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


describe('EC6-8: the end-of-life cost is in the case', () => {
  test.each(G.abandonment.map((c) => [c.name, c]))('resolve: %s', (_n, c) => {
    const r = resolveAbandonment(c.inputs);
    expect(r.abandonmentSource).toBe(c.expected.abandonmentSource);
    expect(ABANDONMENT_SOURCES).toContain(r.abandonmentSource);
    expectNum(r.abandonmentMM, c.expected.abandonmentMM, MONEY);
    expect(r.abandonmentBasis).toBe(c.expected.abandonmentBasis);
    // the plan-state door reads the same three places
    expect(planAbandonment({
      costs: { items: c.inputs.costItems },
      facilities: { list: c.inputs.facilities, selectedId: c.inputs.selectedFacilityId },
    })).toEqual(r);
  });

  test.each(G.abandonmentRefusals.map((c) => [c.name, c]))('refuses %s', (_n, c) => {
    const run = () => (c.inputs.case
      ? runFdpCase({ ...c.inputs.case, abandonment: c.inputs.abandonment })
      : resolveAbandonment(c.inputs));
    expect(run).toThrow(FdpInputError);
    try {
      run();
    } catch (err) {
      expect(err.message).toBe(c.expected.message);
    }
  });

  test.each(G.fdpCaseAbandonment.map((c) => [c.name, c]))('%s', (_n, c) => {
    const { capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal } = c.inputs.case;
    const abandonment = c.inputs.abandonment;
    const r = runFdpCase({ capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal, abandonment });
    const e = c.expected;
    expect(r.abandonmentSource).toBe(e.abandonmentSource);
    expectNum(r.abandonmentMM, e.abandonmentMM, MONEY);
    expect(r.abandonmentYear).toBe(e.abandonmentYear);
    r.cashflow.forEach((row, i) => expectNum(row.abex, e.cashflow[i].abex, MONEY));
    ['npv', 'payback', 'totalTax', 'totalGovTake'].forEach((k) => expectNum(r.metrics[k], e.metrics[k], MONEY));
    expect(r.metrics.irrStatus).toBe(e.metrics.irrStatus);
    if (e.metrics.irr === null) expect(r.metrics.irr).toBeNull();
    else expectNum(r.metrics.irr, e.metrics.irr, IRR);
    // the cost screen's door carries it too, and shows it in the rows
    const rows = calculateCashFlows(capexMM, annualOpexMM, productionKbpd, deck(pricesUsd), fiscal, abandonment);
    rows.forEach((row, i) => expectNum(row.abex, e.cashflow[i].abex, MONEY));
    expectNum(calculateNPV(rows), e.costCalculations.npv, MONEY);
    // and a scenario card, where the golden carries the scenario it came from
    if (c.inputs.scenario) {
      const sc = runScenario(c.inputs.scenario, c.inputs.concept, abandonment);
      expectNum(sc.metrics.npv, e.metrics.npv, MONEY);
      expect(sc.abandonmentSource).toBe(e.abandonmentSource);
    }
  });

  test('NEGATIVE CONTROL: the retired case abandoned the field for nothing', () => {
    // The retired rule, restated: `abandonment` was an array of zeros, so
    // the ABEX item and the decommissioning estimate never reached the NPV.
    G.fdpCaseAbandonment.forEach((c) => {
      const { capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal } = c.inputs.case;
      const asBefore = runFdpCase({ capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal });
      expect(asBefore.abandonmentSource).toBe('none');
      expect(asBefore.cashflow.every((row) => row.abex === 0)).toBe(true);
      expectNum(asBefore.metrics.npv, c.retired.npv, MONEY);
      if (c.expected.abandonmentMM > 0) {
        // the retired NPV is the overstatement, every time
        expect(asBefore.metrics.npv).toBeGreaterThan(c.expected.metrics.npv);
      } else {
        expectNum(asBefore.metrics.npv, c.expected.metrics.npv, MONEY);
      }
    });
    const charged = G.fdpCaseAbandonment.filter((c) => c.expected.abandonmentMM > 0);
    expect(charged.length).toBeGreaterThan(0);
  });

  test('an ABEX item replaces the decommissioning estimate and is never added to it', () => {
    const items = [{ name: 'Abandonment provision', type: 'ABEX', amount: 260 }];
    const facilities = [{ id: 'f1', name: 'FPSO', type: 'FPSO', nameplateCapacity: 60000 }];
    const both = resolveAbandonment({ costItems: items, facilities });
    const estimateOnly = resolveAbandonment({ facilities });
    expect(both.abandonmentSource).toBe('abex-item');
    expect(both.abandonmentMM).toBe(260);
    expect(estimateOnly.abandonmentSource).toBe('decommissioning-estimate');
    expect(estimateOnly.abandonmentMM).toBeCloseTo(calculateFacilityCost(facilities[0]).decommissioning, 12);
    expect(both.abandonmentMM).toBeLessThan(260 + estimateOnly.abandonmentMM);
  });
});

describe('EC6-1: the findings this wave closed', () => {
  test('section 10: an unscored risk cannot improve the register', () => {
    const scored = [{ probability: 5, impact: 5 }, { probability: 4, impact: 3 }];
    const withUnscored = [...scored, { impact: 4 }, { probability: 3 }];
    // The score no longer goes NaN, the unscored risks are counted as such,
    // and the health is the same as the register that leaves them out.
    expect(calculateConsolidatedRiskScore(withUnscored)).toBe(calculateConsolidatedRiskScore(scored));
    expect(Number.isNaN(calculateConsolidatedRiskScore(withUnscored))).toBe(false);
    expect(aggregateRisksByLevel(withUnscored).Unscored).toBe(2);
    expect(calculatePortfolioHealth(withUnscored)).toBe(calculatePortfolioHealth(scored));
    // Before: the two unscored risks each counted as Low, and the health
    // improved because the register was less complete.
    const asLow = [...scored, { probability: 1, impact: 1 }, { probability: 1, impact: 1 }];
    expect(calculatePortfolioHealth(asLow)).toBeGreaterThan(calculatePortfolioHealth(scored));
  });

  test('one banding scale: the HSE matrix and the register agree on every score', () => {
    for (let p = 1; p <= 5; p += 1) {
      for (let i = 1; i <= 5; i += 1) {
        const risk = [{ probability: p, impact: i }];
        const m = calculateRiskMatrix(risk);
        const level = getRiskLevel(p * i).level.toLowerCase();
        expect(m[level]).toBe(1);
      }
    }
    // The old boundaries, for the record: a score of 12 was High on the
    // register and Medium here, and 15 to 19 was High in both but for
    // different reasons.
    expect(getRiskLevel(12).level).toBe('High');
    expect(calculateRiskMatrix([{ probability: 3, impact: 4 }]).high).toBe(1);
    expect(calculateRiskMatrix([{ probability: 3, impact: 4 }]).medium).toBe(0);
  });

  test('section 12: decommissioning scales with the facility', () => {
    const small = calculateFacilityCost({ type: 'FPSO', nameplateCapacity: 50000 });
    const large = calculateFacilityCost({ type: 'FPSO', nameplateCapacity: 150000 });
    expect(large.capex).toBeGreaterThan(small.capex);
    expect(large.decommissioning).toBeGreaterThan(small.decommissioning);
    // it is 15 percent of the capex the facility actually carries
    expect(small.decommissioning).toBeCloseTo(small.capex * 0.15, 9);
    expect(large.decommissioning).toBeCloseTo(large.capex * 0.15, 9);
  });

  test('section 5: a price deck that does not cover the profile is refused, not padded', () => {
    const profile = [10, 20, 30];
    const short = [{ oil_price_usd: 70 }, { oil_price_usd: 70 }];
    expect(() => calculateCashFlows(800, 60, profile, short)).toThrow(FdpInputError);
    try {
      calculateCashFlows(800, 60, profile, short);
    } catch (err) {
      expect(err.message).toMatch(/no price for production year 3/);
    }
    // A full deck is unchanged, and now agrees with runFdpCase exactly.
    const full = [{ oil_price_usd: 70 }, { oil_price_usd: 70 }, { oil_price_usd: 70 }];
    const rows = calculateCashFlows(800, 60, profile, full);
    const direct = runFdpCase({
      capexMM: 800, annualOpexMM: 60, productionKbpd: profile, pricesUsd: [70, 70, 70],
    });
    rows.forEach((row, i) => expect(row.netCashFlow).toBeCloseTo(direct.cashflow[i].ncf, 9));
  });

  test('the sensitivity sweep carries the variable operating cost with the volume', () => {
    const p = {
      capexMM: 800, annualOpexMM: 60, productionKbpd: new Array(10).fill(50),
      pricesUsd: new Array(10).fill(70),
    };
    const sweep = runFdpSensitivity(p);
    const production = sweep.find((x) => x.name === 'Production');
    const price = sweep.find((x) => x.name === 'Oil Price');
    // Before EC6-1 the production sweep scaled the volume alone, so it moved
    // the NPV exactly as far as the price sweep. Volume costs money to
    // produce; price does not.
    const productionSpread = Math.abs(production.highParamNPV - production.lowParamNPV);
    const priceSpread = Math.abs(price.highParamNPV - price.lowParamNPV);
    expect(productionSpread).toBeLessThan(priceSpread);
  });
});
