/**
 * Probabilistic breakeven price: bisection on the screening engine's NPV
 * to a target, and a seeded Monte Carlo over triangular capex, opex and
 * production efficiency fitted to stated percentiles (Economics, extracted
 * VERBATIM from the Suite's src/utils/breakevenCalculations.js in the EC0
 * extraction wave, 2026-09-08). The only edits are the two imports:
 * `calculateEconomics` now comes from ./screening.js (the Suite's
 * npvCalculations.js) and `mulberry32`, `fitTriangularToPercentiles` and
 * `triInvCDF` from ../../lib/stats/stats.js (the Suite's lib/monteCarlo.js).
 * Discounting is MID-YEAR, inherited from the screening engine. Oracle:
 * tools/validation/economics/oracle_breakeven.py, goldens:
 * test-data/economics/goldens/breakeven_cases.json.
 */
// Probabilistic breakeven engine (Economics E1).
//
// REBUILT 2026-08-29. What this file used to be, and why it is gone:
//
//  * It carried its OWN net present value calculation - a fifth fiscal
//    engine in a module that had declared one source of truth. Flat
//    royalty, flat tax, no depreciation, capex forced to time zero, and
//    year-end discounting with no convention stated anywhere. It now
//    calls `calculateEconomics` from npvCalculations.js, the sanctioned
//    client-side screening engine, so a breakeven price is computed by
//    the same arithmetic as every other screening number in the module.
//    That engine discounts MID-YEAR, so breakeven prices from this app
//    now differ slightly from the old ones. That is the convention
//    correction, not a regression.
//
//  * It sampled with a bare `Math.random()`. A sold, gated app returned
//    a different answer every run and no one could reproduce a number
//    they had put in front of a board. Sampling now runs through a
//    seeded generator and the seed travels with the result.
//
//  * It treated the stated P10, P50 and P90 as a triangular
//    distribution's minimum, mode and maximum. They are percentiles, not
//    endpoints. Doing that deletes the outer twenty percent of the
//    distribution and understates every downside case. The percentiles
//    are now FITTED to a triangular whose CDF actually passes through
//    all three points (`fitTriangularToPercentiles`).
//
//  * Its tornado plotted only one side of each swing, so a symmetric
//    uncertainty looked one-sided. Both sides are now returned.
//
// Scope note: this is the SCREENING tier. Full Nigerian fiscal terms
// (PIA/NTA, terrain royalties, HCT/CIT, cost recovery detail) live in
// the EPE engine, supabase/functions/_shared/epe-engine.ts, which
// remains the module's single fiscal source of truth.

import { calculateEconomics } from './screening.js';
import { mulberry32, fitTriangularToPercentiles, triInvCDF } from '../../lib/stats/stats.js';

/** Default seed, so an unconfigured run is still reproducible. */
export const DEFAULT_SEED = 20260829;

const PRICE_BRACKET_MAX = 500; // $/bbl; well past any real breakeven

/**
 * Physical bounds on each belief (EC3-8, owner decision 2026-09-15). A cost
 * below zero or an efficiency above 100 percent describes nothing a field
 * can do, so a stated percentile outside these is refused and a draw from a
 * fitted tail past them is held at the limit and counted.
 */
export const BELIEF_BOUNDS = Object.freeze({
  capex: Object.freeze({ min: 0, max: Infinity, label: 'CAPEX', unit: '$MM' }),
  opex: Object.freeze({ min: 0, max: Infinity, label: 'OPEX', unit: '$MM a year' }),
  efficiency: Object.freeze({ min: 0, max: 100, label: 'Production efficiency', unit: 'percent' }),
});

/**
 * Build the screening-engine inputs for one trial price.
 *
 * CAPEX is placed in the first year and OPEX is held flat across the
 * profile. Both are assumptions this app has always made; they are
 * stated here rather than buried, because a lumpy capex schedule moves
 * a breakeven price materially and a user with one should say so in
 * the NPV Scenario Builder or EPE instead.
 */
const buildInputs = ({
  rows, price, capexMM, opexMM, efficiency,
  discountRate, royaltyRate, taxRate,
}) => {
  const projectLife = rows.length;
  const startYear = rows[0]?.year ?? new Date().getFullYear();
  const capex = new Array(projectLife).fill(0);
  capex[0] = capexMM;
  return {
    startYear,
    projectLife,
    discountRate,
    fiscalType: 'TaxRoyalty',
    production: {
      oil: rows.map((r) => (Number(r.oil_production_bbl) || 0) * efficiency),
      gas: new Array(projectLife).fill(0),
    },
    price: {
      oil: new Array(projectLife).fill(price),
      gas: new Array(projectLife).fill(0),
    },
    capex,
    opexFixed: new Array(projectLife).fill(opexMM),
    opexVariable: new Array(projectLife).fill(0),
    abandonment: new Array(projectLife).fill(0),
    royaltyRate,
    taxRate,
  };
};

/** NPV in $MM at a given oil price, through the sanctioned engine. */
export const npvAtPrice = (args) => calculateEconomics(buildInputs(args)).metrics.npv;

/**
 * Solve the oil price that puts NPV on the target.
 *
 * NPV is monotone increasing in price (more revenue, and royalty and tax
 * take only a fraction of the increase), so bisection is safe and needs
 * no derivative. Returns null when the target is unreachable inside the
 * bracket, which is an honest answer: a profile that cannot break even
 * at 500 dollars a barrel has a problem no price fixes.
 */
export const solveBreakevenPrice = (args, targetNpv = 0) => {
  const at = (price) => npvAtPrice({ ...args, price });
  if (at(PRICE_BRACKET_MAX) < targetNpv) return null;
  let lo = 0;
  let hi = PRICE_BRACKET_MAX;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) < targetNpv) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};

const findVariable = (variables, needle) =>
  variables.find((v) => String(v.name).toUpperCase().includes(needle.toUpperCase()));

/**
 * Run the probabilistic breakeven.
 *
 * `kpis.p10`, `p50` and `p90` are the 10th, 50th and 90th PERCENTILES of the
 * breakeven price (sorted[min(n - 1, floor(q n))]), and the input variables'
 * `p10`, `p50`, `p90` are percentiles of each parameter. Neither is a P-label
 * under the Suite's exceedance convention; screens say "10th percentile".
 *
 * EC3 repairs (owner decisions 2026-09-15): stated percentiles outside
 * BELIEF_BOUNDS are refused and fitted draws past them are held and counted
 * (EC3-8); an inexact fit hands the base case and the tornado the fitted
 * triangle's own percentiles, reported in `beliefs` (EC3-5); a tornado end
 * with no breakeven is null and its bar sorts first (B1).
 *
 * @param {object} inputs app inputs, plus an optional `seed`
 * @returns {object} kpis, plot data, two-sided tornado, beliefs, clipped draws and the seed used
 */
export const generateBreakevenData = (inputs) => {
  const {
    iterations = 5000, variables = [], productionData,
    discountRate, royaltyRate, taxRate, targetNpv = 0,
    seed = DEFAULT_SEED,
  } = inputs;

  const rows = productionData?.data;
  if (!rows || rows.length === 0) {
    throw new Error('Production data is missing or invalid.');
  }

  const capexVar = findVariable(variables, 'CAPEX');
  const opexVar = findVariable(variables, 'OPEX');
  const efficiencyVar = findVariable(variables, 'Production Efficiency');
  if (!capexVar || !opexVar || !efficiencyVar) {
    throw new Error('CAPEX, OPEX and Production Efficiency variables are all required.');
  }

  const stated = { capex: capexVar, opex: opexVar, efficiency: efficiencyVar };

  // EC3-8 (owner decision 2026-09-15): a belief a field cannot have is
  // refused by name. Nothing used to stop a negative cost or an efficiency
  // above 100 percent from being sampled.
  Object.entries(stated).forEach(([key, v]) => {
    const b = BELIEF_BOUNDS[key];
    ['p10', 'p50', 'p90'].forEach((q) => {
      const x = Number(v[q]);
      if (!Number.isFinite(x)) {
        throw new Error(`${b.label} percentiles must be numbers.`);
      }
      if (x < b.min || x > b.max) {
        throw new Error(b.max === Infinity
          ? `${b.label} percentiles must not be negative.`
          : `${b.label} percentiles must lie between ${b.min} and ${b.max} ${b.unit}.`);
      }
    });
  });

  // Fit each stated P10/P50/P90 to a triangular whose CDF passes through
  // all three, rather than pretending the percentiles are endpoints.
  const fits = {
    capex: fitTriangularToPercentiles(capexVar.p10, capexVar.p50, capexVar.p90),
    opex: fitTriangularToPercentiles(opexVar.p10, opexVar.p50, opexVar.p90),
    efficiency: fitTriangularToPercentiles(
      efficiencyVar.p10, efficiencyVar.p50, efficiencyVar.p90,
    ),
  };
  const fitNotes = Object.entries(fits)
    .filter(([, f]) => !f.exact && f.note)
    .map(([key, f]) => `${key}: ${f.note}`);

  // A stated belief can still fit a triangle whose tail runs past a physical
  // limit (efficiency 90 / 96 / 99 fits a maximum above 100). The draw is
  // held at the limit and the count is reported.
  const clipped = { capex: 0, opex: 0, efficiency: 0 };
  const atBounds = (key, x) => Math.min(BELIEF_BOUNDS[key].max, Math.max(BELIEF_BOUNDS[key].min, x));
  const draw = (key, u) => {
    const f = fits[key];
    const x = triInvCDF(u, f.min, f.mode, f.max);
    const held = atBounds(key, x);
    if (held !== x) clipped[key] += 1;
    return held;
  };

  const base = { rows, discountRate, royaltyRate, taxRate };
  const rng = mulberry32(seed);
  const results = [];
  let unreachable = 0;

  for (let i = 0; i < iterations; i += 1) {
    const capexMM = draw('capex', rng());
    const opexMM = draw('opex', rng());
    const efficiency = draw('efficiency', rng()) / 100;

    const price = solveBreakevenPrice(
      { ...base, capexMM, opexMM, efficiency }, targetNpv,
    );
    if (price === null) unreachable += 1; else results.push(price);
  }

  if (results.length === 0) {
    throw new Error(
      'No iteration broke even below 500 dollars a barrel. Check the production profile, '
      + 'the cost ranges and the target NPV.',
    );
  }

  results.sort((a, b) => a - b);
  const pct = (q) => results[Math.min(results.length - 1, Math.floor(q * results.length))];
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const kpis = { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), mean };

  // --- Deterministic base case and a two-sided tornado ---
  //
  // EC3-5 (owner decision 2026-09-15). The sample draws from the FITTED
  // triangle. When the fit is exact that triangle passes through the stated
  // percentiles and they can be used as they are. When it is clamped, its
  // percentiles are not the stated ones (opex 16 / 17 / 26 fits a triangle
  // whose median is near 19.8), and a base case and tornado at the stated
  // 17 described a different belief from the sample on the same screen. So
  // an inexact fit hands the base case and the tornado the fitted
  // triangle's own 10th, 50th and 90th percentiles, and a note says so.
  const beliefOf = (key) => {
    const f = fits[key];
    const v = stated[key];
    if (f.exact) {
      return { p10: Number(v.p10), p50: Number(v.p50), p90: Number(v.p90), source: 'stated' };
    }
    const q = (u) => atBounds(key, triInvCDF(u, f.min, f.mode, f.max));
    return { p10: q(0.1), p50: q(0.5), p90: q(0.9), source: 'fitted' };
  };
  const beliefs = { capex: beliefOf('capex'), opex: beliefOf('opex'), efficiency: beliefOf('efficiency') };

  const baseCase = {
    ...base,
    capexMM: beliefs.capex.p50,
    opexMM: beliefs.opex.p50,
    efficiency: beliefs.efficiency.p50 / 100,
  };
  const baseBreakeven = solveBreakevenPrice(baseCase, targetNpv);

  // B1 (owner decision 2026-09-15). An end of a swing with no breakeven
  // below the bracket used to be drawn as 0 and its bar sorted last, so the
  // variable that can put the project out of reach looked like the one that
  // matters least. That end is now null, the bar is flagged `unreachable`,
  // and unreachable bars sort FIRST.
  const swingOf = (label, lowCase, highCase) => {
    const low = solveBreakevenPrice({ ...baseCase, ...lowCase }, targetNpv);
    const high = solveBreakevenPrice({ ...baseCase, ...highCase }, targetNpv);
    const unreachableSide = low === null || high === null;
    return {
      name: label,
      low, high,
      unreachable: unreachableSide,
      swing: unreachableSide ? null : Math.abs(high - low),
    };
  };

  const sensitivityData = [
    swingOf('Total CAPEX', { capexMM: beliefs.capex.p10 }, { capexMM: beliefs.capex.p90 }),
    swingOf('Annual OPEX', { opexMM: beliefs.opex.p10 }, { opexMM: beliefs.opex.p90 }),
    // A HIGHER efficiency is a LOWER breakeven, so the low-price end of
    // this bar comes from the 90th percentile efficiency. Naming it
    // explicitly because getting it backwards is how tornadoes end up
    // misleading.
    swingOf(
      'Prod. Efficiency',
      { efficiency: beliefs.efficiency.p90 / 100 },
      { efficiency: beliefs.efficiency.p10 / 100 },
    ),
  ].sort((a, b) => (Number(b.unreachable) - Number(a.unreachable)) || ((b.swing ?? 0) - (a.swing ?? 0)));

  const fromBase = (x) => (x === null || baseBreakeven === null ? null : x - baseBreakeven);
  const tornadoData = {
    y: sensitivityData.map((d) => d.name),
    // Both sides of each bar, measured from the base case; null where that
    // end has no breakeven below the bracket.
    low: sensitivityData.map((d) => fromBase(d.low)),
    high: sensitivityData.map((d) => fromBase(d.high)),
    unreachable: sensitivityData.map((d) => d.unreachable),
    base: sensitivityData.map(() => baseBreakeven),
  };

  const unreachableNotes = sensitivityData
    .filter((d) => d.unreachable)
    .map((d) => `${d.name} has no breakeven below ${PRICE_BRACKET_MAX} dollars a barrel at one end of its range, so that side of its bar is left open.`);
  const beliefNotes = Object.entries(beliefs)
    .filter(([, b]) => b.source === 'fitted')
    .map(([key, b]) => `${key}: the base case and the tornado use the fitted triangle's 10th, 50th and 90th percentiles, `
      + `${b.p10.toFixed(2)}, ${b.p50.toFixed(2)} and ${b.p90.toFixed(2)}, so they describe the same belief the sample is drawn from.`);
  const boundNotes = Object.entries(fits)
    .map(([key, f]) => {
      const b = BELIEF_BOUNDS[key];
      const limits = [f.min < b.min ? b.min : null, f.max > b.max ? b.max : null].filter((x) => x !== null);
      if (limits.length === 0) return null;
      return `${key}: the fitted triangle runs past the physical limit of ${limits.join(' and ')} ${b.unit}, `
        + `so ${clipped[key]} of ${iterations} draws were held at that limit.`;
    })
    .filter(Boolean);

  const plotData = {
    cdf: { x: results, y: results.map((_, i) => (i + 1) / results.length) },
    histogram: { x: results },
  };

  const topSensitivities = sensitivityData.slice(0, 2).map((d) => d.name).join(' and ');
  const insights = [
    // No P-labels on a breakeven price (EC3-0, Suite percentile convention):
    // the price is a quantity where more is worse, so it is described by its
    // percentiles, never by P90 or P10.
    `The median breakeven oil price is ${kpis.p50.toFixed(2)} per barrel, `
    + `and its 90th percentile is ${kpis.p90.toFixed(2)}: a 90 percent chance the breakeven price is below that.`,
    `Breakeven is most sensitive to ${topSensitivities}.`,
    `Run seed ${seed}: the same inputs and seed reproduce this result exactly.`,
    unreachable > 0
      ? `${unreachable} of ${iterations} iterations did not break even below `
        + `${PRICE_BRACKET_MAX} dollars a barrel and are excluded from the statistics.`
      : null,
    ...unreachableNotes,
    ...fitNotes,
    ...beliefNotes,
    ...boundNotes,
  ].filter(Boolean).join(' ');

  return {
    kpis,
    plotData,
    tornadoData,
    insights,
    seed,
    baseBreakeven,
    excludedIterations: unreachable,
    distributionFits: fits,
    beliefs,
    clippedDraws: clipped,
  };
};
