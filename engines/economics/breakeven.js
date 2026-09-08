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
 * @param {object} inputs app inputs, plus an optional `seed`
 * @returns {object} kpis, plot data, two-sided tornado, and the seed used
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

  const base = { rows, discountRate, royaltyRate, taxRate };
  const rng = mulberry32(seed);
  const results = [];
  let unreachable = 0;

  for (let i = 0; i < iterations; i += 1) {
    const capexMM = triInvCDF(rng(), fits.capex.min, fits.capex.mode, fits.capex.max);
    const opexMM = triInvCDF(rng(), fits.opex.min, fits.opex.mode, fits.opex.max);
    const efficiency = triInvCDF(
      rng(), fits.efficiency.min, fits.efficiency.mode, fits.efficiency.max,
    ) / 100;

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
  const baseCase = {
    ...base,
    capexMM: capexVar.p50,
    opexMM: opexVar.p50,
    efficiency: efficiencyVar.p50 / 100,
  };
  const baseBreakeven = solveBreakevenPrice(baseCase, targetNpv);

  const swingOf = (label, lowCase, highCase) => {
    const low = solveBreakevenPrice({ ...baseCase, ...lowCase }, targetNpv);
    const high = solveBreakevenPrice({ ...baseCase, ...highCase }, targetNpv);
    return {
      name: label,
      low, high,
      swing: low === null || high === null ? 0 : Math.abs(high - low),
    };
  };

  const sensitivityData = [
    swingOf('Total CAPEX', { capexMM: capexVar.p10 }, { capexMM: capexVar.p90 }),
    swingOf('Annual OPEX', { opexMM: opexVar.p10 }, { opexMM: opexVar.p90 }),
    // A HIGHER efficiency is a LOWER breakeven, so the low-price end of
    // this bar comes from the P90 efficiency. Naming it explicitly
    // because getting it backwards is how tornadoes end up misleading.
    swingOf(
      'Prod. Efficiency',
      { efficiency: efficiencyVar.p90 / 100 },
      { efficiency: efficiencyVar.p10 / 100 },
    ),
  ].sort((a, b) => b.swing - a.swing);

  const tornadoData = {
    y: sensitivityData.map((d) => d.name),
    // Both sides of each bar, measured from the base case.
    low: sensitivityData.map((d) => (d.low === null ? 0 : d.low - baseBreakeven)),
    high: sensitivityData.map((d) => (d.high === null ? 0 : d.high - baseBreakeven)),
    base: sensitivityData.map(() => baseBreakeven),
  };

  const plotData = {
    cdf: { x: results, y: results.map((_, i) => (i + 1) / results.length) },
    histogram: { x: results },
  };

  const topSensitivities = sensitivityData.slice(0, 2).map((d) => d.name).join(' and ');
  const insights = [
    `The P50 breakeven oil price is ${kpis.p50.toFixed(2)} per barrel, `
    + `with a 90 percent chance of being below ${kpis.p90.toFixed(2)}.`,
    `Breakeven is most sensitive to ${topSensitivities}.`,
    `Run seed ${seed}: the same inputs and seed reproduce this result exactly.`,
    unreachable > 0
      ? `${unreachable} of ${iterations} iterations did not break even below `
        + `${PRICE_BRACKET_MAX} dollars a barrel and are excluded from the statistics.`
      : null,
    ...fitNotes,
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
  };
};
