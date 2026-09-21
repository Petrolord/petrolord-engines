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
// D2, D4 and EC1-12 (owner decisions 2026-09-15): the knapsack is SOLVED
// EXACTLY, so the funded set never exceeds the limit and is optimal, and a
// free project (capex 0) weighs nothing. The quantised grid is gone from the
// normal path; it survives only as a stated fallback whose weights round UP,
// so even the fallback is feasible. `solveMethod` says which ran ('exact' or
// 'grid-feasible') and `optimalityGap` bounds the EMV the answer could leave
// on the table (0 when exact). See optimizePortfolio and
// FINDINGS-decision.md, "D2, D4 and EC1-12".
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
// risked EMV objective, an exact knapsack with a bounded state count (see
// optimizePortfolio), efficient frontier, and a portfolio risk summary.
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

/** The most non-dominated partial portfolios the exact solve may hold at
 *  once. Above it optimizePortfolio falls back to the feasible grid. */
export const EXACT_STATE_LIMIT = 200000;

/** Cells in the fallback grid: the limit divided into this many. */
export const FALLBACK_GRID_CELLS = 2000;

/** The most decimal places the exact solve rescales to whole numbers. */
const MAX_EXACT_DECIMALS = 6;

/**
 * The power of ten that makes the limit and every capex a safe integer, with
 * a safe-integer total, trying 1, 10, ... 10^6; null when none does. Scaled
 * capex are summed as integers, so a set whose decimal capex add up to the
 * limit exactly (0.1 + 0.2 at 0.3) is never pushed over it by binary
 * rounding.
 */
const exactScale = (values) => {
  for (let k = 0, scale = 1; k <= MAX_EXACT_DECIMALS; k += 1, scale *= 10) {
    const fits = values.every((v) => {
      const n = Math.round(v * scale);
      return Number.isSafeInteger(n) && n / scale === v;
    });
    if (fits) {
      const total = values.reduce((sum, v) => sum + Math.round(v * scale), 0);
      return Number.isSafeInteger(total) ? scale : null;
    }
  }
  return null;
};

/** The candidate indices on a chain of picks, in candidate order. */
const chainIndices = (node) => {
  const out = [];
  for (let n = node; n; n = n.prev) out.push(n.item);
  return out.reverse();
};

/**
 * Exact 0/1 knapsack by dominance (the Nemhauser and Ullmann list DP). After
 * each candidate, in array order, `states` holds every non-dominated partial
 * portfolio: sorted by weight, EMV strictly rising, weight within `cap`. A
 * candidate adds a shifted copy of the list; the two sorted lists are merged
 * and any state no better than a lighter one is dropped (at equal weight and
 * equal EMV the state without the candidate is kept). Returns null when a
 * list would exceed `stateLimit`.
 */
const solveByDominance = (items, cap, stateLimit) => {
  let states = [{ w: 0, v: 0, node: null }];
  for (let idx = 0; idx < items.length; idx += 1) {
    const { w: wi, v: vi } = items[idx];
    const n = states.length;
    let m = n;
    while (m > 0 && states[m - 1].w + wi > cap) m -= 1;
    const next = [];
    let best = -Infinity;
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      let takeOld;
      if (j >= m) takeOld = true;
      else if (i >= n) takeOld = false;
      else {
        const ow = states[i].w;
        const nw = states[j].w + wi;
        takeOld = ow < nw || (ow === nw && states[i].v >= states[j].v + vi);
      }
      if (takeOld) {
        const st = states[i];
        i += 1;
        if (st.v > best) { next.push(st); best = st.v; }
      } else {
        const st = states[j];
        j += 1;
        const v = st.v + vi;
        if (v > best) { next.push({ w: st.w + wi, v, node: { item: idx, prev: st.node } }); best = v; }
      }
    }
    if (next.length > stateLimit) return null;
    states = next;
  }
  return states;
};

/**
 * 0/1 knapsack on a grid of `cells`, each candidate weighing `weights[k]`
 * cells: best[w] is the largest EMV of a set weighing at most w cells.
 */
const solveOnGrid = (items, weights, cells) => {
  const best = new Array(cells + 1).fill(0);
  const pick = new Array(cells + 1).fill(null);
  items.forEach((it, idx) => {
    const wt = weights[idx];
    if (wt > cells) return;
    for (let w = cells; w >= wt; w -= 1) {
      if (best[w - wt] + it.v > best[w]) {
        best[w] = best[w - wt] + it.v;
        pick[w] = { item: idx, prev: pick[w - wt] };
      }
    }
  });
  return { best, pick };
};

/**
 * 0/1 knapsack over the CAPEX limit maximizing summed risked EMV.
 *
 * Candidates are the projects with risked EMV above 0, in array order; a
 * project with EMV of 0 or less never improves a maximum, so leaving capital
 * unspent is always allowed.
 *
 * EXACT SOLVE (D2, D4 and EC1-12, owner decisions 2026-09-15). The problem
 * is solved exactly by the dominance list DP (solveByDominance): every
 * non-dominated partial portfolio is kept, so the answer is optimal and its
 * capex never exceeds the limit, whatever units the limit is typed in. When
 * the limit and every candidate capex have at most six decimals (and the
 * scaled total is a safe integer) the capex are rescaled to whole numbers
 * and summed exactly; otherwise they are summed in double precision in array
 * order, the same sum totalCapex reports, so the limit test and the reported
 * total can never disagree. A free project (capex 0) weighs nothing and is
 * always funded when its EMV is positive (D2: the grid used to charge it one
 * cell). The result has `solveMethod` 'exact', `optimalityGap` 0,
 * `resolution` null (there is no grid) and `overLimit` false by construction.
 * `frontierData` is the exact efficient frontier: every capex at which the
 * best affordable EMV rises, from capex 0 (where the free projects' EMV sits)
 * to the optimum.
 *
 * STATED SIZE LIMIT AND FALLBACK. If any list would hold more than
 * `exactStateLimit` states (default EXACT_STATE_LIMIT, 200000; a 16-project
 * inventory has at most 65536 subsets, so it cannot), the solve falls back to
 * a grid of FALLBACK_GRID_CELLS cells of `resolution` = limit / 2000 with
 * every weight rounded UP (ceil), so any set that fits the grid fits the
 * limit (D3 and EC1-12: the retired round-to-nearest grid could fund 6002 on
 * 6000). The result has `solveMethod` 'grid-feasible', the `resolution`, and
 * `optimalityGap` = the optimum on the same grid with weights rounded DOWN
 * (a relaxation, so at least the exact optimum) less the funded EMV: an upper
 * bound on the EMV the fallback leaves out (D4: the retired grid left a
 * feasible 200 out of 860 unreported). The frontier is the ceil grid's,
 * reported at the actual capex of each set.
 *
 * RETIRED. The step-scaled grid (1 $MM when every capex and the limit were
 * integers and the limit at most 5000, else limit / 2000 per cell, each
 * project weighing max(1, round(capex / cell)) cells) chose sets over the
 * limit (gridOvershoot: 6002 on 6000), sets short of the optimum
 * (gridUndershoot: 660 against 860) and charged a free project a cell
 * (freeProjectTightLimit: 60 against 70).
 *
 * EC5-0: a project with a negative capex is refused with a
 * PortfolioInputError. `overLimit` (totalCapex > capexLimit) and
 * `overLimitBy` (the excess, 0 when within) stay in the result shape.
 * `seed` and `iterations` pass through to portfolioRiskMetrics.
 *
 * EC5-7 widened the refusal: any capex that is not a finite number of 0 or
 * more (missing, blank, "abc", Infinity) is refused by project name; "abc"
 * used to count as 0. Every project is checked before anything is computed,
 * in array order, capex before pos, and the first failure is thrown.
 *
 * @param {object} args
 * @param {number} [args.exactStateLimit] positive integer; anything else is
 *   EXACT_STATE_LIMIT
 */
export const optimizePortfolio = ({
  projects, capexLimit, correlation = 0, seed, iterations, exactStateLimit,
}) => {
  projects.forEach((p, i) => {
    readCapex(p, i);
    readPos(p, i);
  });
  const limit = Math.max(0, Number(capexLimit) || 0);
  const stateLimit = Number.isInteger(exactStateLimit) && exactStateLimit >= 1
    ? exactStateLimit
    : EXACT_STATE_LIMIT;
  const items = projects
    .map((p) => ({ p, c: Number(p.capex), v: projectEmv(p) }))
    .filter((it) => it.v > 0);

  const scale = exactScale([limit, ...items.map((it) => it.c)]);
  const toWeight = scale === null ? (c) => c : (c) => Math.round(c * scale);
  const toCapex = scale === null ? (w) => w : (w) => w / scale;
  const states = solveByDominance(
    items.map((it) => ({ w: toWeight(it.c), v: it.v })),
    toWeight(limit),
    stateLimit,
  );

  let optimalProjects;
  let totalCapex;
  let frontierData;
  let resolution;
  let solveMethod;
  let optimalityGap;
  const sumCapex = (chosen) => chosen.reduce((s, it) => s + it.c, 0);

  if (states !== null) {
    const top = states[states.length - 1];
    optimalProjects = chainIndices(top.node).map((k) => items[k].p);
    totalCapex = toCapex(top.w);
    frontierData = states.map((st) => ({ capex: toCapex(st.w), emv: st.v }));
    resolution = null;
    solveMethod = 'exact';
    optimalityGap = 0;
  } else {
    resolution = limit / FALLBACK_GRID_CELLS;
    const cells = FALLBACK_GRID_CELLS;
    const ceilWeights = items.map((it) => {
      let wt = Math.ceil(it.c / resolution);
      if (wt * resolution < it.c) wt += 1;
      return wt;
    });
    const floorWeights = items.map((it) => {
      let wt = Math.floor(it.c / resolution);
      if (wt > 0 && wt * resolution > it.c) wt -= 1;
      return wt;
    });
    const grid = solveOnGrid(items, ceilWeights, cells);
    const bound = solveOnGrid(items, floorWeights, cells);
    const chosen = chainIndices(grid.pick[cells]).map((k) => items[k]);
    optimalProjects = chosen.map((it) => it.p);
    totalCapex = sumCapex(chosen);
    frontierData = [];
    let last = -Infinity;
    for (let w = 0; w <= cells; w += 1) {
      if (grid.best[w] > last) {
        frontierData.push({ capex: sumCapex(chainIndices(grid.pick[w]).map((k) => items[k])), emv: grid.best[w] });
        last = grid.best[w];
      }
    }
    solveMethod = 'grid-feasible';
    optimalityGap = Math.max(0, bound.best[cells] - grid.best[cells]);
  }

  const totalEmv = optimalProjects.reduce((s, p) => s + projectEmv(p), 0);
  const totalNpvSuccess = optimalProjects.reduce((s, p) => s + (Number(p.npv_p50) || 0), 0);

  return {
    optimalProjects,
    totalCapex,
    totalEmv,
    totalNpvSuccess,
    frontierData,
    resolution,
    capexLimit: limit,
    solveMethod,
    optimalityGap,
    overLimit: totalCapex > limit,
    overLimitBy: Math.max(0, totalCapex - limit),
    risk: portfolioRiskMetrics(optimalProjects, correlation, { seed, iterations }),
  };
};
