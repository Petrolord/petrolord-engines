/**
 * Gates for the Economics capital portfolio optimizer
 * (engines/economics/portfolio.js).
 *
 * Three parts, per the EC0 brief:
 *   (c) every test the Suite carried for the module, ported verbatim in
 *       intent (src/utils/__tests__/portfolioOptimizer.test.js: 15 D4 cases
 *       and 10 E5 correlation cases);
 *   (b) agreement with every case in the independent oracle's golden,
 *       test-data/economics/goldens/portfolio_cases.json, within stated
 *       absolute tolerances: 1e-9 on EMVs, capex sums, means, spreads and
 *       percentiles (scaled by the magnitude for the rawDollars case, whose
 *       capex is 1e8), 1.5e-7 + 1e-12 on P(loss) (the engine's Abramowitz
 *       and Stegun erf against math.erf; the largest gap seen is reported),
 *       and an exact match on chosen sets, frontier lengths and clamped
 *       correlations. The oracle solves the knapsack by brute force, both
 *       exactly and on the engine's documented quantised grid; the engine
 *       must reproduce the GRID optimum, and the gap to the exact optimum is
 *       pinned case by case. Cases where the grid changes the chosen set are
 *       pinned by name (CHANGED_BY_GRID) so a new one cannot appear unseen.
 *   (a) closed-form identities: frontier monotone and ending at the
 *       optimum; correlation never moves the mean; rho 1 gives the sum of
 *       the spreads and rho 0 the root sum of squares; risk of the picked
 *       set equals portfolioRiskMetrics of that set.
 *
 * Money is $MM (rawDollars deliberately in dollars).
 */
import fs from 'fs';
import path from 'path';
import {
  projectEmv, projectMoments, portfolioRiskMetrics, optimizePortfolio, successStdDev,
} from '../engines/economics/portfolio.js';
import { normalCDF } from '../lib/stats/stats.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'portfolio_cases.json'),
  'utf8',
));

const ABS = 1e-9;
const PROB = 1.5e-7 + 1e-12;

const near = (actual, expected, tol, label) => {
  const gap = Math.abs(actual - expected);
  if (!(gap <= tol)) {
    throw new Error(`${label}: engine ${actual} vs oracle ${expected} (gap ${gap} > ${tol})`);
  }
};
const scaled = (v) => ABS * Math.max(1, Math.abs(v));
const rho = (v) => (v === 'NaN' ? NaN : v);
const ids = (ps) => ps.map((p) => p.id).slice().sort();
const sameIds = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Cases where the engine's grid changes the chosen set from the exact optimum.
 *  Recorded in tools/validation/economics/FINDINGS-decision.md. */
const CHANGED_BY_GRID = ['freeProjectTightLimit', 'freeProjectZeroLimit', 'gridOvershoot', 'gridUndershoot'];

let maxProbLossGap = 0;
const probLossGate = (actual, expected, label) => {
  maxProbLossGap = Math.max(maxProbLossGap, Math.abs(actual - expected));
  near(actual, expected, PROB, label);
};

const riskGate = (r, e, label) => {
  near(r.emv, e.emv, scaled(e.emv), `${label} emv`);
  near(r.stdDev, e.stdDev, scaled(e.stdDev), `${label} stdDev`);
  near(r.independentStdDev, e.independentStdDev, scaled(e.independentStdDev), `${label} independentStdDev`);
  near(r.p90, e.p90, scaled(e.p90), `${label} p90`);
  near(r.p10, e.p10, scaled(e.p10), `${label} p10`);
  expect(r.correlation).toBe(e.correlation);
  probLossGate(r.probLoss, e.probLoss, `${label} probLoss`);
};

// ---------------------------------------------------------------------------
// (c) The Suite's portfolioOptimizer.test.js, ported.
// ---------------------------------------------------------------------------

const P = (name, capex, npv, extra = {}) => ({ id: name, name, capex, npv_p50: npv, ...extra });

describe('Suite port: projectEmv (risked)', () => {
  it('defaults to the unrisked NPV when pos/fail_cost are absent', () => {
    expect(projectEmv(P('a', 100, 250))).toBe(250);
  });
  it('risks the NPV: EMV = pos*npv - (1-pos)*fail_cost', () => {
    expect(projectEmv(P('a', 100, 300, { pos: 0.3, fail_cost: 50 }))).toBeCloseTo(55, 9);
  });
});

describe('Suite port: successStdDev', () => {
  it('prefers an explicit npv_stddev (linked Monte Carlo run)', () => {
    expect(successStdDev({ npv_stddev: 40, npv_p10: 200, npv_p90: 50 })).toBe(40);
  });
  it('falls back to (P10-P90)/2.5631 from entered percentiles', () => {
    expect(successStdDev({ npv_p10: 200, npv_p90: 50 })).toBeCloseTo(150 / 2.5631, 6);
  });
  it('is 0 with neither', () => {
    expect(successStdDev({})).toBe(0);
  });
});

describe('Suite port: projectMoments (success/failure mixture, exact)', () => {
  it('matches the closed-form mixture variance', () => {
    const m = projectMoments({ npv_p50: 100, npv_stddev: 20, pos: 0.5, fail_cost: 40 });
    expect(m.mean).toBeCloseTo(30, 9);
    expect(m.variance).toBeCloseTo(5100, 9);
  });
  it('a sure project with no spread has zero variance', () => {
    const m = projectMoments({ npv_p50: 100 });
    expect(m.mean).toBe(100);
    expect(m.variance).toBe(0);
  });
});

describe('Suite port: portfolioRiskMetrics (independent normal approximation)', () => {
  it('sums means and variances and computes P(loss) = Phi(-mean/sd)', () => {
    const a = { npv_p50: 100, npv_stddev: 20, pos: 0.5, fail_cost: 40 };
    const b = { npv_p50: 50, npv_stddev: 10 };
    const r = portfolioRiskMetrics([a, b]);
    expect(r.emv).toBeCloseTo(80, 9);
    expect(r.stdDev).toBeCloseTo(Math.sqrt(5200), 9);
    expect(r.probLoss).toBeCloseTo(normalCDF(-80 / Math.sqrt(5200)), 12);
    expect(r.p90).toBeLessThan(r.emv);
    expect(r.p10).toBeGreaterThan(r.emv);
  });
  it('a deterministic profitable portfolio has zero loss probability', () => {
    expect(portfolioRiskMetrics([{ npv_p50: 10 }]).probLoss).toBe(0);
  });
});

describe('Suite port: optimizePortfolio (step-scaled knapsack)', () => {
  const projects = [P('A', 100, 60), P('B', 200, 100), P('C', 300, 120), P('D', 150, 90)];

  it('solves the classic knapsack exactly', () => {
    const r = optimizePortfolio({ projects, capexLimit: 450 });
    expect(r.optimalProjects.map((p) => p.name).sort()).toEqual(['A', 'B', 'D']);
    expect(r.totalEmv).toBeCloseTo(250, 6);
    expect(r.totalCapex).toBeCloseTo(450, 6);
  });

  it('optimizes RISKED EMV, not the headline NPV', () => {
    const r = optimizePortfolio({
      projects: [P('X', 100, 300, { pos: 0.2, fail_cost: 50 }), P('Y', 100, 50)],
      capexLimit: 100,
    });
    expect(r.optimalProjects.map((p) => p.name)).toEqual(['Y']);
  });

  it('never forces in a negative-EMV project', () => {
    const r = optimizePortfolio({ projects: [P('bad', 50, -20), P('good', 50, 30)], capexLimit: 200 });
    expect(r.optimalProjects.map((p) => p.name)).toEqual(['good']);
  });

  it('keeps the DP bounded when the limit is typed in raw dollars', () => {
    const dollarProjects = projects.map((p) => ({ ...p, capex: p.capex * 1e6 }));
    const r = optimizePortfolio({ projects: dollarProjects, capexLimit: 450e6 });
    expect(r.optimalProjects.map((p) => p.name).sort()).toEqual(['A', 'B', 'D']);
    expect(r.resolution).toBeGreaterThan(1);
  });

  it('produces a monotone frontier ending at the optimum', () => {
    const r = optimizePortfolio({ projects, capexLimit: 450 });
    for (let i = 1; i < r.frontierData.length; i++) {
      expect(r.frontierData[i].emv).toBeGreaterThan(r.frontierData[i - 1].emv);
      expect(r.frontierData[i].capex).toBeGreaterThanOrEqual(r.frontierData[i - 1].capex);
    }
    expect(r.frontierData[r.frontierData.length - 1].emv).toBeCloseTo(r.totalEmv, 6);
  });

  it('attaches the risk summary of the picked set', () => {
    const r = optimizePortfolio({ projects, capexLimit: 450 });
    expect(r.risk.emv).toBeCloseTo(250, 6);
    expect(r.risk.probLoss).toBe(0);
  });
});

describe('Suite port: portfolioRiskMetrics with correlation', () => {
  const a = { npv_p50: 100, npv_p10: 160, npv_p90: 40, pos: 1 };
  const b = { npv_p50: 80, npv_p10: 130, npv_p90: 30, pos: 1 };

  it('defaults to independence, so the previous behaviour is unchanged', () => {
    const explicit = portfolioRiskMetrics([a, b], 0);
    const implicit = portfolioRiskMetrics([a, b]);
    expect(implicit.stdDev).toBeCloseTo(explicit.stdDev, 12);
    expect(implicit.correlation).toBe(0);
  });

  it('leaves the expected value alone', () => {
    const indep = portfolioRiskMetrics([a, b], 0);
    const corr = portfolioRiskMetrics([a, b], 0.6);
    expect(corr.emv).toBeCloseTo(indep.emv, 12);
  });

  it('widens the spread as correlation rises', () => {
    const sd = [0, 0.25, 0.5, 0.75, 1].map((r) => portfolioRiskMetrics([a, b], r).stdDev);
    for (let i = 1; i < sd.length; i += 1) expect(sd[i]).toBeGreaterThan(sd[i - 1]);
  });

  it('reaches the sum of the standard deviations at full correlation', () => {
    const sdA = Math.sqrt(projectMoments(a).variance);
    const sdB = Math.sqrt(projectMoments(b).variance);
    expect(portfolioRiskMetrics([a, b], 1).stdDev).toBeCloseTo(sdA + sdB, 8);
  });

  it('matches the independent root-sum-of-squares at zero correlation', () => {
    const sdA = Math.sqrt(projectMoments(a).variance);
    const sdB = Math.sqrt(projectMoments(b).variance);
    expect(portfolioRiskMetrics([a, b], 0).stdDev).toBeCloseTo(Math.sqrt(sdA * sdA + sdB * sdB), 8);
  });

  it('raises the chance of a loss on a portfolio that is expected to profit', () => {
    const indep = portfolioRiskMetrics([a, b], 0);
    const corr = portfolioRiskMetrics([a, b], 0.8);
    expect(corr.emv).toBeGreaterThan(0);
    expect(corr.probLoss).toBeGreaterThan(indep.probLoss);
  });

  it('reports what independence would have said, so the assumption is visible', () => {
    const corr = portfolioRiskMetrics([a, b], 0.5);
    expect(corr.independentStdDev).toBeLessThan(corr.stdDev);
    expect(corr.independentStdDev).toBeCloseTo(portfolioRiskMetrics([a, b], 0).stdDev, 12);
  });

  it('makes no difference to a single project, which has nothing to correlate with', () => {
    const one = portfolioRiskMetrics([a], 0);
    const oneCorr = portfolioRiskMetrics([a], 0.9);
    expect(oneCorr.stdDev).toBeCloseTo(one.stdDev, 10);
  });

  it('clamps a nonsense correlation instead of producing a nonsense spread', () => {
    expect(portfolioRiskMetrics([a, b], 5).correlation).toBe(1);
    expect(portfolioRiskMetrics([a, b], -3).correlation).toBe(0);
    expect(Number.isFinite(portfolioRiskMetrics([a, b], NaN).stdDev)).toBe(true);
  });

  it('is threaded through the optimizer', () => {
    const projects = [
      { id: 1, capex: 10, npv_p50: 100, npv_p10: 160, npv_p90: 40, pos: 1 },
      { id: 2, capex: 10, npv_p50: 80, npv_p10: 130, npv_p90: 30, pos: 1 },
    ];
    const indep = optimizePortfolio({ projects, capexLimit: 20, correlation: 0 });
    const corr = optimizePortfolio({ projects, capexLimit: 20, correlation: 0.7 });
    expect(corr.optimalProjects).toHaveLength(indep.optimalProjects.length);
    expect(corr.totalEmv).toBeCloseTo(indep.totalEmv, 10);
    expect(corr.risk.stdDev).toBeGreaterThan(indep.risk.stdDev);
  });
});

// ---------------------------------------------------------------------------
// (b) Golden agreement gates.
// ---------------------------------------------------------------------------

describe('golden: projectEmv', () => {
  for (const c of G.projectEmv) {
    it(`${c.id}: ${c.description}`, () => {
      near(projectEmv(c.project), c.expected.emv, ABS, c.id);
    });
  }
});

describe('golden: successStdDev', () => {
  for (const c of G.successStdDev) {
    it(`${c.id}: ${c.description}`, () => {
      near(successStdDev(c.project), c.expected.sd, ABS, c.id);
    });
  }
});

describe('golden: projectMoments', () => {
  for (const c of G.projectMoments) {
    it(`${c.id}: ${c.description}`, () => {
      const m = projectMoments(c.project);
      near(m.mean, c.expected.mean, ABS, `${c.id} mean`);
      near(m.variance, c.expected.variance, scaled(c.expected.variance), `${c.id} variance`);
    });
  }
});

describe('golden: portfolioRiskMetrics', () => {
  for (const c of G.riskMetrics) {
    it(`${c.id}: ${c.description}`, () => {
      riskGate(portfolioRiskMetrics(c.selected, rho(c.correlation)), c.expected, c.id);
    });
  }
});

describe('golden: optimizePortfolio (brute-force knapsack, exact and on the grid)', () => {
  for (const c of G.optimize) {
    it(`${c.id}: ${c.description}`, () => {
      const r = optimizePortfolio({ projects: c.projects, capexLimit: c.capexLimit, correlation: c.correlation });
      const e = c.expected;
      near(r.resolution, e.resolution, scaled(e.resolution) * 1e-3, `${c.id} resolution`);

      // The chosen set is one of the grid optima, and its totals are that set's.
      const chosen = ids(r.optimalProjects);
      const match = e.quantized.optimalSets.find((s) => sameIds(s.ids.slice().sort(), chosen));
      if (!match) {
        throw new Error(`${c.id}: engine chose [${chosen}] but the grid optima are ${JSON.stringify(e.quantized.optimalSets.map((s) => s.ids))}`);
      }
      near(r.totalEmv, e.quantized.optimalEmv, scaled(e.quantized.optimalEmv), `${c.id} totalEmv`);
      near(r.totalCapex, match.capex, scaled(match.capex), `${c.id} totalCapex`);
      near(r.totalNpvSuccess, match.npvSuccess, scaled(match.npvSuccess), `${c.id} totalNpvSuccess`);
      riskGate(r.risk, match.risk, `${c.id} risk`);
      // (a) the risk block is the risk of the picked set.
      const direct = portfolioRiskMetrics(r.optimalProjects, c.correlation);
      expect(r.risk.stdDev).toBe(direct.stdDev);
      expect(r.risk.emv).toBe(direct.emv);

      // The gap to the exact optimum is pinned, and the set only changes
      // where the golden says it does.
      near(r.totalEmv - e.exact.optimalEmv, e.quantizationGap, scaled(e.exact.optimalEmv), `${c.id} quantization gap`);
      expect(e.setChanged).toBe(CHANGED_BY_GRID.includes(c.id));
      if (!e.setChanged) {
        expect(e.exact.optimalSets.some((s) => sameIds(s.ids.slice().sort(), chosen))).toBe(true);
      }

      // Frontier: same length, same EMV levels, capex among the tied sets'.
      expect(r.frontierData.length).toBe(e.quantized.frontier.length);
      e.quantized.frontier.forEach((f, i) => {
        near(r.frontierData[i].emv, f.emv, scaled(f.emv), `${c.id} frontier ${i} emv`);
        const ok = f.capexCandidates.some((cap) => Math.abs(cap - r.frontierData[i].capex) <= scaled(cap));
        if (!ok) throw new Error(`${c.id} frontier ${i} capex ${r.frontierData[i].capex} not in [${f.capexCandidates}]`);
      });
      // (a) monotone, starting at (0, 0) and ending at the optimum.
      expect(r.frontierData[0].capex).toBe(0);
      expect(r.frontierData[0].emv).toBe(0);
      for (let i = 1; i < r.frontierData.length; i++) {
        expect(r.frontierData[i].emv).toBeGreaterThan(r.frontierData[i - 1].emv);
      }
      near(r.frontierData[r.frontierData.length - 1].emv, r.totalEmv, scaled(r.totalEmv), `${c.id} frontier end`);
    });
  }

  it('pins the set of cases the grid changes, and every pinned case is in the golden', () => {
    const changed = G.optimize.filter((c) => c.expected.setChanged).map((c) => c.id).sort();
    expect(changed).toEqual(CHANGED_BY_GRID.slice().sort());
  });

  it('(a) correlation never moves the mean of the picked set', () => {
    for (const c of G.optimize) {
      const r0 = optimizePortfolio({ projects: c.projects, capexLimit: c.capexLimit, correlation: 0 });
      const r1 = optimizePortfolio({ projects: c.projects, capexLimit: c.capexLimit, correlation: 1 });
      near(r1.risk.emv, r0.risk.emv, scaled(r0.risk.emv), `${c.id} mean under rho`);
      expect(r1.risk.stdDev).toBeGreaterThanOrEqual(r0.risk.stdDev - ABS);
    }
  });
});

describe('golden: shape and the erf gap', () => {
  it('carries a description and every section', () => {
    expect(typeof G.description).toBe('string');
    for (const k of ['projectEmv', 'successStdDev', 'projectMoments', 'riskMetrics', 'optimize']) {
      expect(Array.isArray(G[k])).toBe(true);
      expect(G[k].length).toBeGreaterThan(0);
    }
  });

  it('the largest P(loss) gap between the engine erf and math.erf stays inside the published 1.5e-7', () => {
    // Runs after the risk and optimize gates in file order.
    expect(maxProbLossGap).toBeLessThanOrEqual(1.5e-7);
    expect(maxProbLossGap).toBeGreaterThan(0);
  });
});
