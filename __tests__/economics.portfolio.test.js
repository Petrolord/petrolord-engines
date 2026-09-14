/**
 * Gates for the Economics capital portfolio optimizer
 * (engines/economics/portfolio.js).
 *
 * Parts, per the EC0 brief and the EC5-0 repair (owner decision 2026-09-14):
 *   (c) every test the Suite carried for the module, ported in intent
 *       (src/utils/__tests__/portfolioOptimizer.test.js: 15 D4 cases and 10
 *       E5 correlation cases). The one that asserted the old normal
 *       approximation (P(loss) = Phi(-mean/sd)) now asserts the Monte Carlo
 *       contract against the exact answer instead.
 *   (b) agreement with every case in the independent oracle's golden,
 *       test-data/economics/goldens/portfolio_cases.json: 1e-9 on EMVs, capex
 *       sums, means and spreads (scaled by magnitude; rawDollars has capex
 *       1e8); the Monte Carlo risk block against the oracle's bit-for-bit
 *       replica, probLoss EXACTLY (a count ratio) and P90 / P10 within 1e-9
 *       scaled, at the seed and iterations each case states (the largest
 *       replication gap is reported); an exact match on chosen sets, frontier
 *       lengths, clamped correlations, overLimit and overLimitBy. The knapsack
 *       optimum is brute force, exact and on the quantised grid; cases where
 *       the grid changes the set are pinned by name (CHANGED_BY_GRID).
 *   (m) the risk METHOD against exact answers (riskMethod): enumeration,
 *       normal sums, comonotone and conditioned-copula cases, within 4
 *       standard errors, and the discrete percentile outcomes exactly.
 *   (a) properties: frontier monotone and ending at the optimum; correlation
 *       never moves the mean; seeded determinism; Math.random never called;
 *       p90 <= p10; p90 never below the worst possible outcome.
 *
 * Money is $MM (rawDollars deliberately in dollars).
 */
import fs from 'fs';
import path from 'path';
import {
  projectEmv, projectMoments, portfolioRiskMetrics, optimizePortfolio, successStdDev,
  DEFAULT_RISK_SEED, DEFAULT_RISK_ITERATIONS, PortfolioInputError,
} from '../engines/economics/portfolio.js';
import { normalCDF } from '../lib/stats/stats.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'portfolio_cases.json'),
  'utf8',
));

const ABS = 1e-9;
const SE_LIMIT = 4;

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
const withinSE = (mc, exact, n, label) => {
  const se = Math.sqrt((exact * (1 - exact)) / n);
  const z = Math.abs(mc - exact) / se;
  if (!(z <= SE_LIMIT)) throw new Error(`${label}: Monte Carlo ${mc} vs exact ${exact} is ${z} standard errors`);
  return z;
};

/** Cases where the engine's grid changes the chosen set from the exact optimum.
 *  Recorded in tools/validation/economics/FINDINGS-decision.md. */
const CHANGED_BY_GRID = ['freeProjectTightLimit', 'freeProjectZeroLimit', 'gridOvershoot', 'gridUndershoot'];

// Replication gaps, engine against the oracle's replayed sampler.
const gaps = { lossCount: 0, quantile: 0, compared: 0 };

const riskGate = (r, e, label) => {
  near(r.emv, e.emv, scaled(e.emv), `${label} emv`);
  near(r.stdDev, e.stdDev, scaled(e.stdDev), `${label} stdDev`);
  near(r.independentStdDev, e.independentStdDev, scaled(e.independentStdDev), `${label} independentStdDev`);
  expect(r.correlation).toBe(e.correlation);
  expect(r.method).toBe('monte-carlo');
  expect(r.seed).toBe(e.seed);
  expect(r.iterations).toBe(e.iterations);
  gaps.compared += 1;
  gaps.lossCount = Math.max(gaps.lossCount, Math.abs(Math.round(r.probLoss * r.iterations) - Math.round(e.probLoss * e.iterations)));
  gaps.quantile = Math.max(gaps.quantile, Math.abs(r.p90 - e.p90), Math.abs(r.p10 - e.p10));
  if (r.probLoss !== e.probLoss) {
    throw new Error(`${label} probLoss: engine ${r.probLoss} vs replica ${e.probLoss} (a COUNT mismatch; report it, do not loosen)`);
  }
  near(r.p90, e.p90, scaled(e.p90), `${label} p90`);
  near(r.p10, e.p10, scaled(e.p10), `${label} p10`);
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

describe('Suite port: portfolioRiskMetrics (closed-form moments, Monte Carlo loss and percentiles)', () => {
  it('sums means and variances, and reads P(loss) from the Monte Carlo, not Phi(-mean/sd)', () => {
    const a = { npv_p50: 100, npv_stddev: 20, pos: 0.5, fail_cost: 40 };
    const b = { npv_p50: 50, npv_stddev: 10 };
    const r = portfolioRiskMetrics([a, b]);
    expect(r.emv).toBeCloseTo(80, 9);
    expect(r.stdDev).toBeCloseTo(Math.sqrt(5200), 9);
    expect(r.method).toBe('monte-carlo');
    expect(r.seed).toBe(DEFAULT_RISK_SEED);
    expect(r.iterations).toBe(DEFAULT_RISK_ITERATIONS);
    // Exact: a fails (0.5) and b < 40, or a succeeds and N(150, sqrt 500) < 0.
    const exact = 0.5 * normalCDF(-1) + 0.5 * normalCDF(-150 / Math.sqrt(500));
    withinSE(r.probLoss, exact, r.iterations, 'suite pair');
    // The old normal approximation (0.1336) is far outside the sampling error.
    expect(Math.abs(r.probLoss - normalCDF(-80 / Math.sqrt(5200)))).toBeGreaterThan(0.04);
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

describe('golden: portfolioRiskMetrics (Monte Carlo replayed bit for bit)', () => {
  for (const c of G.riskMetrics) {
    it(`${c.id}: ${c.description}`, () => {
      const r = c.useEngineDefaults
        ? portfolioRiskMetrics(c.selected, rho(c.correlation))
        : portfolioRiskMetrics(c.selected, rho(c.correlation), c.riskOptions);
      riskGate(r, c.expected, c.id);
    });
  }

  it('pins the engine defaults to the golden\'s stated seed and iterations', () => {
    expect(DEFAULT_RISK_SEED).toBe(20260829);
    expect(DEFAULT_RISK_ITERATIONS).toBe(10000);
    const def = G.riskMetrics.filter((c) => c.useEngineDefaults);
    expect(def.length).toBeGreaterThan(0);
    for (const c of def) {
      expect(c.riskOptions).toEqual({ seed: DEFAULT_RISK_SEED, iterations: DEFAULT_RISK_ITERATIONS });
    }
  });
});

describe('golden: optimizePortfolio (brute-force knapsack, exact and on the grid)', () => {
  for (const c of G.optimize) {
    it(`${c.id}: ${c.description}`, () => {
      const r = optimizePortfolio({
        projects: c.projects, capexLimit: c.capexLimit, correlation: c.correlation, ...c.riskOptions,
      });
      const e = c.expected;
      near(r.resolution, e.resolution, scaled(e.resolution) * 1e-3, `${c.id} resolution`);
      near(r.capexLimit, e.limit, scaled(e.limit), `${c.id} capexLimit`);

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

      // D3 flag: overLimit is the chosen set's capex above the clamped limit.
      expect(r.overLimit).toBe(match.overLimit);
      expect(r.overLimit).toBe(r.totalCapex > r.capexLimit);
      near(r.overLimitBy, match.overLimitBy, scaled(match.overLimitBy), `${c.id} overLimitBy`);
      expect(r.overLimitBy).toBe(Math.max(0, r.totalCapex - r.capexLimit));

      // (a) the risk block is the risk of the picked set.
      const direct = portfolioRiskMetrics(r.optimalProjects, c.correlation, c.riskOptions);
      expect(r.risk).toEqual(direct);

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

  it('D3 is flagged: gridOvershoot reports overLimit by 2, classic450 is within the limit', () => {
    const byId = Object.fromEntries(G.optimize.map((c) => [c.id, c]));
    const run = (id) => optimizePortfolio({
      projects: byId[id].projects, capexLimit: byId[id].capexLimit, correlation: byId[id].correlation, ...byId[id].riskOptions,
    });
    const over = run('gridOvershoot');
    expect(over.totalCapex).toBe(6002);
    expect(over.capexLimit).toBe(6000);
    expect(over.overLimit).toBe(true);
    expect(over.overLimitBy).toBe(2);
    const classic = run('classic450');
    expect(classic.overLimit).toBe(false);
    expect(classic.overLimitBy).toBe(0);
  });

  it('(a) correlation never moves the mean of the picked set', () => {
    for (const c of G.optimize) {
      const r0 = optimizePortfolio({ projects: c.projects, capexLimit: c.capexLimit, correlation: 0, ...c.riskOptions });
      const r1 = optimizePortfolio({ projects: c.projects, capexLimit: c.capexLimit, correlation: 1, ...c.riskOptions });
      near(r1.risk.emv, r0.risk.emv, scaled(r0.risk.emv), `${c.id} mean under rho`);
      expect(r1.risk.stdDev).toBeGreaterThanOrEqual(r0.risk.stdDev - ABS);
    }
  });
});

describe('golden: optimizeRefusals (EC5-0)', () => {
  for (const c of G.optimizeRefusals) {
    it(`${c.id}: ${c.description}`, () => {
      const call = () => optimizePortfolio({ projects: c.projects, capexLimit: c.capexLimit });
      expect(call).toThrow(PortfolioInputError);
      let err;
      try { call(); } catch (e) { err = e; }
      expect(err.name).toBe(c.expected.throws);
      for (const s of c.expected.messageIncludes) expect(err.message).toContain(s);
    });
  }
});

// ---------------------------------------------------------------------------
// (m) The risk method against exact answers.
// ---------------------------------------------------------------------------

describe('golden: riskMethod (Monte Carlo within 4 standard errors of the exact answer)', () => {
  for (const c of G.riskMethod) {
    it(`${c.id} [${c.kind}]: ${c.description}`, () => {
      const r = portfolioRiskMetrics(c.selected, c.correlation, c.riskOptions);
      const n = r.iterations;
      expect(n).toBe(c.riskOptions.iterations);
      // Method FIRST (so a method failure is reported as one, not masked by the
      // replica check): the engine's own estimate against the exact answer.
      withinSE(r.probLoss, c.exact.probLoss, n, `${c.id} probLoss`);
      for (const [key, level] of [['p90', 0.1], ['p10', 0.9]]) {
        const ex = c.exact[key];
        if (typeof ex === 'object') {
          // Discrete: the percentile IS the exact outcome wherever sampling
          // cannot tip it (neither cumulative within 0.01 of the level).
          const clear = Math.abs(ex.cumulativeAt - level) > 0.01 && Math.abs(ex.cumulativeBelow - level) > 0.01;
          expect(ex.checked).toBe(clear);
          if (clear) expect(r[key]).toBe(ex.outcome);
          expect(r[key]).toBeGreaterThanOrEqual(c.exact.worstOutcome);
        } else {
          const z = Math.abs(r[key] - ex) / c.exact[`${key}SE`];
          if (!(z <= SE_LIMIT)) throw new Error(`${c.id} ${key}: ${r[key]} vs exact ${ex} is ${z} standard errors`);
        }
      }
      // Replication: the engine is the stream the oracle replayed.
      expect(r.probLoss).toBe(c.mc.probLoss);
      near(r.p90, c.mc.p90, scaled(c.mc.p90), `${c.id} replica p90`);
      near(r.p10, c.mc.p10, scaled(c.mc.p10), `${c.id} replica p10`);
    });
  }

  it('covers every method family the brief names, with the discrete percentile check armed', () => {
    const kinds = new Set(G.riskMethod.map((c) => c.kind));
    for (const k of ['independent-binary', 'pos1-normal', 'comonotone']) expect(kinds.has(k)).toBe(true);
    const armed = G.riskMethod.filter((c) => typeof c.exact.p90 === 'object' && c.exact.p90.checked);
    expect(armed.length).toBeGreaterThan(5);
  });

  it('the old normal approximation fails the same gate (why EC5-0 exists)', () => {
    const wc = G.riskMethod.find((c) => c.id === 'singleWildcat');
    expect(() => withinSE(wc.normalApprox.probLoss, wc.exact.probLoss, 10000, 'old')).toThrow();
    expect(wc.normalApprox.p90).toBeLessThan(wc.exact.worstOutcome);
  });
});

// ---------------------------------------------------------------------------
// (a) Properties of the Monte Carlo.
// ---------------------------------------------------------------------------

describe('properties: the seeded Monte Carlo', () => {
  const wc = { npv_p50: 300, pos: 0.3, fail_cost: 50 };
  const three = [wc, { npv_p50: 400, pos: 0.25, fail_cost: 60 }, { npv_p50: 250, pos: 0.4, fail_cost: 45 }];

  it('is deterministic: the same seed gives identical results', () => {
    const opts = { seed: 12345, iterations: 3000 };
    expect(portfolioRiskMetrics(three, 0.4, opts)).toEqual(portfolioRiskMetrics(three, 0.4, opts));
    expect(portfolioRiskMetrics([wc])).toEqual(portfolioRiskMetrics([wc]));
  });

  it('a different seed moves probLoss, but stays within the standard error of the truth', () => {
    const a = portfolioRiskMetrics([wc], 0, { seed: 1 });
    const b = portfolioRiskMetrics([wc], 0, { seed: 2 });
    expect(a.seed).toBe(1);
    expect(b.seed).toBe(2);
    expect(a.probLoss).not.toBe(b.probLoss);
    withinSE(a.probLoss, 0.7, a.iterations, 'seed 1');
    withinSE(b.probLoss, 0.7, b.iterations, 'seed 2');
  });

  it('never calls Math.random', () => {
    const spy = jest.spyOn(Math, 'random');
    try {
      portfolioRiskMetrics(three, 0.5, { iterations: 500 });
      optimizePortfolio({ projects: [P('A', 100, 60, { pos: 0.5, fail_cost: 10 }), P('B', 50, 30)], capexLimit: 150, iterations: 500 });
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to the defaults for an invalid seed or iteration count', () => {
    const r = portfolioRiskMetrics([wc], 0, { seed: 'abc', iterations: -4 });
    expect(r.seed).toBe(DEFAULT_RISK_SEED);
    expect(r.iterations).toBe(DEFAULT_RISK_ITERATIONS);
    expect(portfolioRiskMetrics([wc], 0, { seed: null, iterations: 2.5 })).toEqual(portfolioRiskMetrics([wc]));
  });

  it('an empty selection is 0 / 0 / 0 and still reports the seed and iterations', () => {
    const r = portfolioRiskMetrics([], 0.3, { seed: 5, iterations: 50 });
    expect(r).toMatchObject({ emv: 0, stdDev: 0, probLoss: 0, p90: 0, p10: 0, seed: 5, iterations: 50, method: 'monte-carlo' });
  });

  it('p90 <= p10 always, and p90 is never below the worst outcome of a binary no-spread portfolio', () => {
    // mulberry32-free, hand-listed portfolios over a spread of pos and rho.
    const portfolios = [
      [wc], three, Array(8).fill(wc),
      [{ npv_p50: 50, pos: 0.9, fail_cost: 200 }, { npv_p50: 10, pos: 0.05, fail_cost: 1 }],
      [{ npv_p50: -20, pos: 1 }, { npv_p50: 500, pos: 0.02, fail_cost: 0 }],
    ];
    for (const ps of portfolios) {
      const worst = ps.reduce((s, p) => s + Math.min(-(p.fail_cost ?? 0), p.pos >= 1 ? p.npv_p50 : Infinity), 0);
      for (const r of [0, 0.3, 0.7, 1]) {
        const out = portfolioRiskMetrics(ps, r, { seed: 77, iterations: 4000 });
        expect(out.p90).toBeLessThanOrEqual(out.p10);
        expect(out.p90).toBeGreaterThanOrEqual(worst);
      }
    }
    // With a success spread the worst outcome is minus infinity; p90 <= p10 still holds.
    const spread = portfolioRiskMetrics([{ npv_p50: 100, npv_stddev: 80, pos: 0.6, fail_cost: 30 }], 0, { iterations: 4000 });
    expect(spread.p90).toBeLessThanOrEqual(spread.p10);
  });
});

describe('golden: shape and the replication gap', () => {
  it('carries a description and every section', () => {
    expect(typeof G.description).toBe('string');
    for (const k of ['projectEmv', 'successStdDev', 'projectMoments', 'riskMetrics', 'optimize', 'optimizeRefusals', 'riskMethod']) {
      expect(Array.isArray(G[k])).toBe(true);
      expect(G[k].length).toBeGreaterThan(0);
    }
  });

  it('the largest replication gap (engine against the replayed sampler) is zero counts and inside 1e-9 on the percentiles', () => {
    // Runs after the risk and optimize gates in file order.
    // eslint-disable-next-line no-console
    console.log(`portfolio Monte Carlo replication: ${gaps.compared} risk blocks, largest loss-count gap ${gaps.lossCount}, largest P90/P10 gap ${gaps.quantile}`);
    expect(gaps.compared).toBeGreaterThan(20);
    expect(gaps.lossCount).toBe(0);
    expect(gaps.quantile).toBeLessThanOrEqual(1e-6);
  });
});
