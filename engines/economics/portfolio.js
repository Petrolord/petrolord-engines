// Capital portfolio optimizer (Economics D4 + E5), extracted VERBATIM from
// the Suite's src/utils/portfolioOptimizer.js in the EC0 extraction wave,
// 2026-09-08. The extraction's only edit was the import (the Suite file took
// `normalCDF` from '@/lib/monteCarlo'; this copy takes the bit-identical
// vendored stats module '../../lib/stats/stats.js'). Gated by
// __tests__/economics.portfolio.test.js against the independent oracle
// tools/validation/economics/oracle_portfolio.py and its committed golden
// test-data/economics/goldens/portfolio_cases.json.
//
// EC5-0 repair (owner decision 2026-09-14): the portfolio loss probability
// and the P90 / P10 cards used to come from a NORMAL approximation of the
// summed NPV, which is badly wrong for a few risked projects (one wildcat at
// pos 0.3, NPV 300, fail cost 50 reported P(loss) 0.366 against a true 0.7,
// and a P90 of -150.6 below the worst possible outcome of -50). They now come
// from a SEEDED Monte Carlo of the actual success / failure mixture (see
// portfolioRiskMetrics). The knapsack also refuses a negative capex and flags
// a chosen set whose capex exceeds the limit on the quantised grid
// (overLimit / overLimitBy; FINDINGS-decision.md D3).
//
// EC5-6 and EC5-7 (owner decisions 2026-09-15): a pos that is present but
// blank, non-numeric or outside 0..1 is refused by project name (a blank pos
// used to read as 0, a certain failure, while "n/a" read as 1 and 1.4 was
// clamped), and the knapsack refuses any capex that is not a finite number
// of 0 or more (capex "abc" used to count as 0). A missing or null pos keeps
// the documented default 1. FINDINGS-decision.md, "EC5-6 and EC5-7".
//
// Capital portfolio optimizer (D4, docs/scope/Economics-ROADMAP.md).
// Extracted from CapitalPortfolioStudio's inline knapsack and upgraded:
// risked EMV objective, step-scaled DP (bounded memory whatever the units),
// efficient frontier, and a portfolio risk summary.
//
// Conventions:
// - All money in $MM.
// - Risked EMV per project follows the ProspectRiskEngine convention of
//   keeping risked and success-case values separate:
//     EMV = pos * npv_p50 - (1 - pos) * fail_cost
//   where pos is the chance of success (0..1; 1 when missing or null; any
//   other pos outside 0..1, blank or non-numeric is refused) and fail_cost
//   is the expected loss if the project fails (>= 0, default 0).
// - Portfolio risk: the mean (emv) and the spread (stdDev, with one average
//   correlation rho in the moment formula) stay closed form. P(NPV < 0), P90
//   and P10 are read from a seeded Monte Carlo (mulberry32, default seed
//   DEFAULT_RISK_SEED, DEFAULT_RISK_ITERATIONS draws) in which rho is the
//   correlation of the latent Gaussian drivers (a one-factor Gaussian
//   copula). Screening-grade by design; the UI states the assumption.

import {
  mulberry32, normalCDF, quantile, randomNormal,
} from '../../lib/stats/stats.js';

/** Default Monte Carlo seed, the EC3-0 screening seed, so an unconfigured run
 *  is reproducible. */
export const DEFAULT_RISK_SEED = 20260829;

/** Default Monte Carlo iterations for the portfolio risk summary. */
export const DEFAULT_RISK_ITERATIONS = 10000;

/** Thrown when a project cannot be optimised as entered (EC5-0). */
export class PortfolioInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortfolioInputError';
  }
}

/** How a refusal names a project: name, else id, else its index when known. */
const projectWho = (p, index) => {
  const label = p?.name ?? p?.id ?? index;
  return label === undefined ? 'A project with no name or id' : `Project "${label}"`;
};

/** An entered value as a refusal message shows it: a string in quotes. */
const shown = (raw) => (typeof raw === 'string' ? `"${raw}"` : String(raw));

/** Number() of a number or a non-blank string; NaN for anything else. */
const numberOrNaN = (raw) => (
  typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN
);

/**
 * The chance of success of one project (EC5-6, owner decision 2026-09-15).
 * Missing or null is the documented default 1. A pos that is present must be
 * a number, or a numeric string, from 0 to 1 inclusive; a blank, a
 * non-numeric value (a boolean included) or a value outside 0..1 throws a
 * PortfolioInputError naming the project (name, else id, else `index`).
 */
const readPos = (p, index) => {
  const raw = p.pos;
  if (raw === undefined || raw === null) return 1;
  const who = projectWho(p, index);
  const rule = 'pos must be a number from 0 to 1';
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new PortfolioInputError(`${who} has a blank pos; ${rule}`);
  }
  const n = numberOrNaN(raw);
  if (Number.isNaN(n)) {
    throw new PortfolioInputError(`${who} has a pos that is not a number (${shown(raw)}); ${rule}`);
  }
  if (!(n >= 0 && n <= 1)) {
    throw new PortfolioInputError(`${who} has a pos outside 0 to 1 (${n}); ${rule}`);
  }
  return n;
};

/**
 * The capex of one project for the knapsack (EC5-0, widened by EC5-7): a
 * finite number, or a numeric string, of 0 or more. Missing, null, blank,
 * non-numeric, infinite or negative throws a PortfolioInputError naming the
 * project.
 */
const readCapex = (p, index) => {
  const raw = p.capex;
  const who = projectWho(p, index);
  const rule = 'capex must be 0 or more';
  if (raw === undefined || raw === null) {
    throw new PortfolioInputError(`${who} has no capex; ${rule}`);
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new PortfolioInputError(`${who} has a blank capex; ${rule}`);
  }
  const n = numberOrNaN(raw);
  if (!Number.isFinite(n)) {
    throw new PortfolioInputError(`${who} has a capex that is not a finite number (${shown(raw)}); ${rule}`);
  }
  if (n < 0) {
    throw new PortfolioInputError(`${who} has a negative capex (${n}); ${rule}`);
  }
  return n;
};

/** Risked EMV of one project. @throws {PortfolioInputError} an invalid pos. */
export const projectEmv = (p) => {
  const pos = readPos(p);
  const failCost = Math.max(0, Number(p.fail_cost) || 0);
  return pos * (Number(p.npv_p50) || 0) - (1 - pos) * failCost;
};

// Success-case NPV spread of one project, as a standard deviation in $MM.
// Preference order: explicit npv_stddev (a linked Monte Carlo run), else
// the (P10 - P90) / 2.5631 normal-equivalent from the entered percentiles
// (2.5631 = 2 * z_0.90), else 0.
export const successStdDev = (p) => {
  const sd = Number(p.npv_stddev);
  if (Number.isFinite(sd) && sd > 0) return sd;
  const p10 = Number(p.npv_p10);
  const p90 = Number(p.npv_p90);
  if (Number.isFinite(p10) && Number.isFinite(p90) && p10 > p90) {
    return (p10 - p90) / 2.5631;
  }
  return 0;
};

// Mean and variance of one project's NPV as a success/failure mixture:
// success (prob pos): normal(npv_p50-ish mean, successStdDev); failure:
// point mass at -fail_cost. Mixture moments are exact; only the summed
// portfolio shape is approximated as normal.
export const projectMoments = (p) => {
  const pos = readPos(p);
  const failCost = Math.max(0, Number(p.fail_cost) || 0);
  const muS = Number(p.npv_p50) || 0;
  const sdS = successStdDev(p);
  const mean = pos * muS - (1 - pos) * failCost;
  const secondMoment = pos * (sdS * sdS + muS * muS) + (1 - pos) * failCost * failCost;
  const variance = Math.max(0, secondMoment - mean * mean);
  return { mean, variance };
};

/**
 * Portfolio risk summary: closed-form mean and spread, Monte Carlo loss
 * probability and percentiles (EC5-0, owner decision 2026-09-14).
 *
 * MEAN AND SPREAD (closed form, unchanged). `emv` is the sum of the project
 * mixture means. `correlation` is a single average pairwise correlation,
 * which is what a screening tool can honestly ask for. Economics E5 closed
 * the D4 parked item: real projects sharing a basin, a partner, a rig
 * contract or a price deck fail together, so the downside is fatter than
 * independence implies. Under equal correlation the moment formula is
 *
 *   Var = sum_i var_i + rho * ( (sum_i sd_i)^2 - sum_i var_i )
 *
 * because the cross terms are rho * sd_i * sd_j over every ordered pair with
 * i != j. At rho = 0 this is the independent sum; at rho = 1 it is
 * (sum sd_i)^2. `stdDev` is that formula and `independentStdDev` is
 * sqrt(sum var_i). Means are unaffected by correlation.
 *
 * LOSS PROBABILITY AND PERCENTILES (seeded Monte Carlo). These used to be
 * Phi(-mean/sd) and mean -/+ 1.2816 sd, a normal approximation that is badly
 * wrong for a handful of risked projects (a single 0.3 / 300 / 50 wildcat:
 * 0.366 against a true 0.7, and a P90 below the worst possible outcome).
 * Now rng = mulberry32(seed) and every iteration draws, in this FIXED order,
 *
 *   F1 = randomNormal(rng), F2 = randomNormal(rng),
 *   then for each project in array order e1 = randomNormal(rng),
 *   e2 = randomNormal(rng),
 *
 * sets a = sqrt(rho), b = sqrt(1 - rho), z1 = a F1 + b e1, z2 = a F2 + b e2,
 * and the project succeeds when normalCDF(z1) < pos (pos read as in
 * projectMoments; an invalid pos is refused before any draw, naming the
 * project by name, else id, else its index in `selected`). Its value is
 * npv_p50 + successStdDev * z2 on success and -fail_cost on failure; the
 * portfolio value is the sum in array order.
 * Every normal is drawn whether or not it is needed, so the stream structure
 * never depends on the inputs.
 *
 * So rho is the correlation of the LATENT drivers, a one-factor Gaussian
 * copula: the success drivers z1 of two projects correlate at rho, and so do
 * their success-case NPV drivers z2. The correlation this implies between
 * the success / failure EVENTS (and between the mixture outcomes) is lower
 * than rho except at 0 and 1, so the Monte Carlo sample spread is not the
 * analytic `stdDev`, which still uses the moment formula above.
 *
 *   probLoss = (count of portfolio values < 0) / iterations
 *   p90      = quantile(values, 0.1), the LOW case (exceedance convention)
 *   p10      = quantile(values, 0.9), the HIGH case
 *
 * with the stats module's simple-statistics scalar quantile. p90 <= emv <=
 * p10 is NOT guaranteed for a skewed mixture (one wildcat's P10 can be its
 * failure outcome); p90 <= p10 always holds.
 *
 * @param {object[]} selected the funded projects
 * @param {number} [correlation] average pairwise correlation, clamped to [0, 1]
 * @param {object} [options]
 * @param {number} [options.seed] integer mulberry32 seed (unsigned); anything
 *   else is DEFAULT_RISK_SEED
 * @param {number} [options.iterations] integer >= 1; anything else is
 *   DEFAULT_RISK_ITERATIONS
 */
export const portfolioRiskMetrics = (
  selected,
  correlation = 0,
  { seed = DEFAULT_RISK_SEED, iterations = DEFAULT_RISK_ITERATIONS } = {},
) => {
  selected.forEach((p, i) => readPos(p, i));
  const rho = Math.min(1, Math.max(0, Number(correlation) || 0));
  const runSeed = Number.isInteger(seed) ? seed >>> 0 : DEFAULT_RISK_SEED;
  const runIterations = Number.isInteger(iterations) && iterations >= 1
    ? iterations
    : DEFAULT_RISK_ITERATIONS;

  let mean = 0;
  let varianceSum = 0;
  let sdSum = 0;
  for (const p of selected) {
    const m = projectMoments(p);
    mean += m.mean;
    varianceSum += m.variance;
    sdSum += Math.sqrt(m.variance);
  }
  // The cross-term block is non-negative because sdSum^2 >= varianceSum by
  // Cauchy-Schwarz, so a positive correlation can only widen the spread.
  const crossTerms = Math.max(0, sdSum * sdSum - varianceSum);
  const variance = varianceSum + rho * crossTerms;
  const sd = Math.sqrt(Math.max(0, variance));

  const base = {
    emv: mean,
    stdDev: sd,
    correlation: rho,
    // The spread you would have reported assuming independence, so the effect
    // of the assumption is visible rather than buried.
    independentStdDev: Math.sqrt(varianceSum),
    seed: runSeed,
    iterations: runIterations,
    method: 'monte-carlo',
  };
  if (selected.length === 0) {
    return { ...base, probLoss: 0, p90: 0, p10: 0 };
  }

  const params = selected.map((p) => ({
    pos: readPos(p),
    failCost: Math.max(0, Number(p.fail_cost) || 0),
    muS: Number(p.npv_p50) || 0,
    sdS: successStdDev(p),
  }));
  const a = Math.sqrt(rho);
  const b = Math.sqrt(1 - rho);
  const rng = mulberry32(runSeed);
  const values = new Array(runIterations);
  let losses = 0;
  for (let it = 0; it < runIterations; it++) {
    const f1 = randomNormal(rng);
    const f2 = randomNormal(rng);
    let total = 0;
    for (const q of params) {
      const e1 = randomNormal(rng);
      const e2 = randomNormal(rng);
      const z1 = a * f1 + b * e1;
      const z2 = a * f2 + b * e2;
      total += normalCDF(z1) < q.pos ? q.muS + q.sdS * z2 : -q.failCost;
    }
    values[it] = total;
    if (total < 0) losses += 1;
  }
  values.sort((x, y) => x - y);

  return {
    ...base,
    probLoss: losses / runIterations,
    p90: quantile(values, 0.1),
    p10: quantile(values, 0.9),
  };
};

/**
 * 0/1 knapsack over the CAPEX limit maximizing summed risked EMV.
 *
 * The DP is step-scaled: weights are quantized so the table never exceeds
 * ~2000 cells regardless of the units the user typed the limit in (the old
 * inline version allocated one cell per raw currency unit). `resolution`
 * (in $MM per cell) is reported so callers can state the quantization.
 * Projects with EMV <= 0 are never forced in: leaving capital unspent is
 * always allowed.
 *
 * EC5-0: a project with a negative capex is refused with a
 * PortfolioInputError (it used to be accepted silently and pushed the
 * frontier's x axis negative and out of order). The grid can still choose a
 * set whose actual capex exceeds the limit by up to half a cell per project
 * (FINDINGS D3); that is now FLAGGED, not prevented: `overLimit` is
 * totalCapex > capexLimit and `overLimitBy` the excess (0 when within).
 * `seed` and `iterations` pass through to portfolioRiskMetrics.
 *
 * EC5-7 widened the refusal: any capex that is not a finite number of 0 or
 * more (missing, blank, "abc", Infinity) is refused by project name; "abc"
 * used to count as 0. Every project is checked before anything is computed,
 * in array order, capex before pos, and the first failure is thrown.
 */
export const optimizePortfolio = ({
  projects, capexLimit, correlation = 0, seed, iterations,
}) => {
  projects.forEach((p, i) => {
    readCapex(p, i);
    readPos(p, i);
  });
  const limit = Math.max(0, Number(capexLimit) || 0);
  const candidates = projects.filter((p) => Number(p.capex) > 0 || projectEmv(p) > 0);

  // Exact 1-$MM DP when inputs are integer $MM and the table stays small;
  // otherwise quantize to ~2000 cells (round-to-nearest, so an exact-fit
  // portfolio stays feasible; overshoot is bounded by half a cell per
  // project, screening-grade and reported via `resolution`).
  const allInteger = Number.isInteger(limit) && candidates.every((p) => Number.isInteger(Number(p.capex)));
  const resolution = allInteger && limit <= 5000 ? 1 : Math.max(1e-9, limit / 2000);
  const cells = Math.round(limit / resolution);

  const dp = new Array(cells + 1).fill(0);
  const pick = new Array(cells + 1).fill(null).map(() => []);

  for (const p of candidates) {
    const value = projectEmv(p);
    if (value <= 0) continue; // never worth forcing in under a max objective
    const weight = Math.max(1, Math.round((Number(p.capex) || 0) / resolution));
    if (weight > cells) continue;
    for (let w = cells; w >= weight; w--) {
      if (dp[w - weight] + value > dp[w]) {
        dp[w] = dp[w - weight] + value;
        pick[w] = [...pick[w - weight], p];
      }
    }
  }

  const optimalProjects = pick[cells];
  const totalCapex = optimalProjects.reduce((s, p) => s + (Number(p.capex) || 0), 0);
  const totalEmv = optimalProjects.reduce((s, p) => s + projectEmv(p), 0);
  const totalNpvSuccess = optimalProjects.reduce((s, p) => s + (Number(p.npv_p50) || 0), 0);

  // Efficient frontier: best achievable EMV at each spending level where it
  // improves. Reported at the ACTUAL capex of the picked set, not the cell.
  const frontierData = [];
  let last = -Infinity;
  for (let w = 0; w <= cells; w++) {
    if (dp[w] > last) {
      const capex = pick[w].reduce((s, p) => s + (Number(p.capex) || 0), 0);
      frontierData.push({ capex, emv: dp[w] });
      last = dp[w];
    }
  }

  return {
    optimalProjects,
    totalCapex,
    totalEmv,
    totalNpvSuccess,
    frontierData,
    resolution,
    capexLimit: limit,
    overLimit: totalCapex > limit,
    overLimitBy: Math.max(0, totalCapex - limit),
    risk: portfolioRiskMetrics(optimalProjects, correlation, { seed, iterations }),
  };
};
