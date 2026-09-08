/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/scenarioCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). The only edit is the import: '@/utils/fdp/economics' became './economics.js'.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * FDP scenario economics.
 *
 * Economics E1: this file used to carry its own NPV, its own IRR and its
 * own cash-flow generator (the latter labelled "Mock cash flow
 * generation" in the source). None of it applied royalty or tax, so the
 * NPV shown on a scenario card was a pre-fiscal number. It now builds the
 * case and runs it through the sanctioned screening engine via
 * `runFdpCase`, so a scenario's NPV means the same thing here as
 * everywhere else in the module.
 *
 * The exported names are kept so the scenario cards need no change
 * beyond passing the fiscal terms.
 */

import { runFdpCase, paybackYears, DEFAULT_FISCAL } from './economics.js';

const PLATEAU_YEARS = 3;
const DECLINE = 0.9;
const PROFILE_YEARS = 20;

/**
 * Build the production profile a concept implies: a short plateau at the
 * stated peak rate, then exponential decline. Explicitly a screening
 * shape, not a reservoir forecast; a real profile belongs in the
 * Forecast Scenario Hub and can be handed in instead.
 */
export const conceptProfileKbpd = (concept) => {
  const peak = parseFloat(concept?.peakProduction) || 50;
  const profile = [];
  for (let year = 1; year <= PROFILE_YEARS; year += 1) {
    profile.push(year <= PLATEAU_YEARS ? peak : peak * DECLINE ** (year - PLATEAU_YEARS));
  }
  return profile;
};

/**
 * Run one scenario against one concept.
 *
 * @returns {{cashflow: object[], metrics: object}} full engine result
 */
export const runScenario = (scenario, concept) => {
  const productionKbpd = concept?.productionProfileKbpd?.length
    ? concept.productionProfileKbpd
    : conceptProfileKbpd(concept);
  const oilPrice = parseFloat(scenario?.oilPrice) || 70;
  return runFdpCase({
    capexMM: parseFloat(concept?.capex) || 100,
    annualOpexMM: parseFloat(concept?.opex) || 10,
    productionKbpd,
    pricesUsd: new Array(productionKbpd.length).fill(oilPrice),
    fiscal: {
      discountRate: Number.isFinite(Number(scenario?.discountRate))
        ? Number(scenario.discountRate)
        : DEFAULT_FISCAL.discountRate,
      royaltyRate: Number.isFinite(Number(scenario?.royaltyRate))
        ? Number(scenario.royaltyRate)
        : DEFAULT_FISCAL.royaltyRate,
      taxRate: Number.isFinite(Number(scenario?.taxRate))
        ? Number(scenario.taxRate)
        : DEFAULT_FISCAL.taxRate,
    },
  });
};

/** Post-fiscal NPV in $MM. */
export const scenarioNPV = (scenario, concept) => runScenario(scenario, concept).metrics.npv;

/** IRR in percent, from the engine's bisection solver. */
export const scenarioIRR = (scenario, concept) => runScenario(scenario, concept).metrics.irr;

/** Years to payback, or null. */
export const scenarioPayback = (scenario, concept) =>
  paybackYears(runScenario(scenario, concept));
