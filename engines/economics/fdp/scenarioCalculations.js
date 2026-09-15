/**
 * EC6-0. Vendored from the Suite in the EC0 extraction wave, repaired here.
 *
 * `runScenario` read `concept.capex`. The concept form has never had such a
 * field: it collects `drillingCapex`, `facilitiesCapex` and `subseaCapex`.
 * So every scenario card in the app was priced at the fallback, $100MM,
 * whatever the user typed. A concept entered as 400 + 1200 + 300 = $1,900MM
 * showed NPV $3,507.6MM and IRR 676.4%; on its own capex it is $1,791.4MM
 * and 30.0%. The same three silent fallbacks covered a missing operating
 * cost ($10MM a year), a missing peak rate (50 kbpd) and a blank or zero
 * oil price ($70/bbl, while the card printed "$0/bbl").
 *
 * The capex now comes from the fields the form actually collects, and a
 * figure that is absent is refused by name rather than replaced. A zero a
 * user typed is a value and is honoured.
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

import { runFdpCase, runFdpSensitivity, paybackYears, DEFAULT_FISCAL } from './economics.js';
import { FdpInputError, isBlank, requireNumber, requireNonNegative } from './inputError.js';

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
  const peak = requireNonNegative(concept?.peakProduction, 'the concept peak production rate');
  const profile = [];
  for (let year = 1; year <= PROFILE_YEARS; year += 1) {
    profile.push(year <= PLATEAU_YEARS ? peak : peak * DECLINE ** (year - PLATEAU_YEARS));
  }
  return profile;
};

const CAPEX_PARTS = [
  ['drillingCapex', 'the drilling capex'],
  ['facilitiesCapex', 'the facilities capex'],
  ['subseaCapex', 'the subsea capex'],
];

/**
 * Total development capex for a concept, and whether it is complete.
 *
 * Reads the three fields the concept form collects, and accepts a single
 * `capex` when a caller has already totalled them. A concept that carries
 * none of the four is refused: there is no defensible screening number for
 * a development whose cost nobody has entered.
 *
 * EC6-9. A concept with some of the three left blank is still summed (a
 * partial concept is legitimate in early screening), but the result says
 * so. `capexStatus` is 'partial' and `capexMissing` names the blank fields,
 * in the form's order. Before, the partial sum reached the scenario card
 * looking like a complete one: an FPSO concept whose facilities capex was
 * left blank screened at 1350 against its 2250. A total `capex`, or all
 * three fields entered (a typed zero counts as entered), is 'complete'.
 *
 * @param {object} concept
 * @returns {{capexMM: number, capexStatus: 'complete'|'partial', capexMissing: string[]}}
 */
export const conceptCapex = (concept) => {
  if (!isBlank(concept?.capex)) {
    return {
      capexMM: requireNonNegative(concept.capex, 'the concept capex'),
      capexStatus: 'complete',
      capexMissing: [],
    };
  }
  const given = CAPEX_PARTS.filter(([key]) => !isBlank(concept?.[key]));
  if (given.length === 0) {
    throw new FdpInputError(
      'the concept carries no capex: enter a drilling, facilities or subsea capex',
    );
  }
  const capexMissing = CAPEX_PARTS.filter(([key]) => isBlank(concept?.[key])).map(([key]) => key);
  return {
    capexMM: given.reduce((sum, [key, label]) => sum + requireNonNegative(concept[key], label), 0),
    capexStatus: capexMissing.length === 0 ? 'complete' : 'partial',
    capexMissing,
  };
};

/**
 * Total development capex for a concept, $MM. The number alone; use
 * `conceptCapex` to learn whether it is complete.
 *
 * @param {object} concept
 * @returns {number}
 */
export const conceptCapexMM = (concept) => conceptCapex(concept).capexMM;

/** The fiscal terms a scenario implies, defaults stated rather than silent. */
const scenarioFiscal = (scenario) => ({
  discountRate: isBlank(scenario?.discountRate)
    ? DEFAULT_FISCAL.discountRate
    : requireNumber(scenario.discountRate, 'the scenario discount rate'),
  royaltyRate: isBlank(scenario?.royaltyRate)
    ? DEFAULT_FISCAL.royaltyRate
    : requireNumber(scenario.royaltyRate, 'the scenario royalty rate'),
  taxRate: isBlank(scenario?.taxRate)
    ? DEFAULT_FISCAL.taxRate
    : requireNumber(scenario.taxRate, 'the scenario tax rate'),
});

/**
 * The case and the capex status together, validated in the order the card
 * has always refused in: profile, capex, operating cost, oil price.
 */
const buildScenario = (scenario, concept) => {
  const productionKbpd = concept?.productionProfileKbpd?.length
    ? concept.productionProfileKbpd
    : conceptProfileKbpd(concept);
  const capex = conceptCapex(concept);
  return {
    capex,
    fdpCase: {
      capexMM: capex.capexMM,
      annualOpexMM: requireNonNegative(concept?.opex, 'the concept annual operating cost'),
      productionKbpd,
      pricesUsd: new Array(productionKbpd.length)
        .fill(requireNonNegative(scenario?.oilPrice, 'the scenario oil price')),
      fiscal: scenarioFiscal(scenario),
    },
  };
};

/** The case one scenario and one concept imply, ready for the screening engine. */
export const scenarioCase = (scenario, concept) => buildScenario(scenario, concept).fdpCase;

/**
 * Run one scenario against one concept.
 *
 * The full engine result, plus `capexStatus` ('complete' or 'partial') and
 * `capexMissing` (the blank capex field names) so a card screened on a
 * partial capex can say so (EC6-9).
 *
 * @returns {{cashflow: object[], metrics: object, capexStatus: string, capexMissing: string[]}}
 */
export const runScenario = (scenario, concept) => {
  const { capex, fdpCase } = buildScenario(scenario, concept);
  return {
    ...runFdpCase(fdpCase),
    capexStatus: capex.capexStatus,
    capexMissing: capex.capexMissing,
  };
};

/**
 * The sensitivity sweep for one scenario, on the same case the card shows.
 *
 * @returns {Array<{name: string, lowParamNPV: number, highParamNPV: number, baseNPV: number}>}
 */
export const scenarioSensitivity = (scenario, concept) => runFdpSensitivity(scenarioCase(scenario, concept));

/** Post-fiscal NPV in $MM. */
export const scenarioNPV = (scenario, concept) => runScenario(scenario, concept).metrics.npv;

/** IRR in percent, from the engine's bisection solver. */
export const scenarioIRR = (scenario, concept) => runScenario(scenario, concept).metrics.irr;

/** Years to payback, or null. */
export const scenarioPayback = (scenario, concept) =>
  paybackYears(runScenario(scenario, concept));
