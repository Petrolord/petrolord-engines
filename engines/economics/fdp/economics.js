/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/economics.js in the EC0 Economics
 * extraction wave (2026-09-08). The only edit is the import: '@/utils/npvCalculations' became '../screening.js' (the same file, vendored verbatim on this branch).
 * Repaired since in EC6-8 (2026-09-15): the case carries the plan's end-of-life
 * cost in its final production year (resolveAbandonment). The gates in
 * __tests__/economics.fdp.test.js and the independent oracle
 * tools/validation/economics/oracle_fdp.py cover it.
 */
// FDP economics, on the sanctioned engine (Economics E1).
//
// Before this module, FDP carried its OWN net present value arithmetic in
// two places (costCalculations.js and scenarioCalculations.js) - the
// sixth de facto NPV implementation in a module that had declared one
// source of truth, and the only one nobody had ever tested.
//
// The substantive problem was not duplication, it was that neither
// version applied any fiscal terms at all. "NPV" meant revenue minus
// operating cost, before royalty and before tax. On ordinary Nigerian
// terms that overstates project value by roughly forty percent, and it
// was the number the app put on a card labelled NPV at 10 percent.
//
// Both call sites now build their case here and run it through
// `calculateEconomics`, the sanctioned client-side screening engine, so
// FDP screening economics agree with the NPV Scenario Builder, the
// Probabilistic Breakeven Analyzer and the Fiscal Regime Designer. Full
// Nigerian fiscal detail still belongs to the EPE engine.
//
// CONVENTION: mid-year discounting, inherited from calculateEconomics.

import { calculateEconomics, runSensitivityAnalysis } from '../screening.js';
import { calculateFacilityCost } from './facilitiesCalculations.js';
import { FdpInputError, isBlank, requireNonNegative } from './inputError.js';

/**
 * Default screening fiscal terms. Stated rather than assumed silently,
 * and overridable per case, because a plan built on no royalty and no
 * tax is not a plan.
 */
export const DEFAULT_FISCAL = {
  royaltyRate: 12.5,
  taxRate: 30,
  discountRate: 10,
  variableOpexPerBbl: 5,
};

/**
 * EC6-8 (owner decision 2026-09-15). The end-of-life cost of a screening case.
 *
 * Before: `buildFdpCaseInputs` set the abandonment row to zeros. A plan's
 * ABEX cost item was listed on the cost screen and left out of the cash
 * flow, and the facility decommissioning estimate was shown on the
 * facilities screen and left out too, so a known cost never reached the NPV
 * and the NPV was overstated by its discounted after-tax value.
 *
 * Now the case carries one end-of-life cost, charged in the FINAL
 * PRODUCTION YEAR (the last year of the profile), and it is deductible for
 * tax in that year as the screening engine treats every abandonment cost.
 * Its source is exactly one of:
 *
 *   'abex-item'                 the sum of the plan's ABEX cost items. Used
 *                               whenever the plan carries one, a typed zero
 *                               included.
 *   'decommissioning-estimate'  no ABEX item: the screening decommissioning
 *                               estimate (15 percent of the sized capex, see
 *                               calculateFacilityCost) of the facility the
 *                               plan builds, which is the selected facility,
 *                               or the only facility when just one is listed.
 *   'none'                      neither: nothing is charged, and the basis
 *                               says why.
 *
 * Never both: an ABEX item replaces the estimate, it is not added to it.
 *
 * CONSEQUENCE FOR THE RATE OF RETURN. A final year that pays the
 * abandonment usually has a negative net cash flow, so the flow changes
 * sign twice. The IRR contract (irrContract.js) then reports every root in
 * `metrics.irrRoots`, `metrics.irr` null and `irrStatus` 'multiple-roots'.
 * That is the honest answer for such a flow and it is left to the contract.
 */

/** The sources an end-of-life cost may carry. */
export const ABANDONMENT_SOURCES = ['abex-item', 'decommissioning-estimate', 'none'];

const NO_ABANDONMENT = { abandonmentSource: 'none', abandonmentMM: 0 };

/** Validates an abandonment argument; absent is none. */
const checkedAbandonment = (abandonment) => {
  if (abandonment === undefined || abandonment === null) return NO_ABANDONMENT;
  const { abandonmentSource } = abandonment;
  if (!ABANDONMENT_SOURCES.includes(abandonmentSource)) {
    throw new FdpInputError(
      `the abandonment source is unknown (${String(abandonmentSource)}); `
      + `expected one of ${ABANDONMENT_SOURCES.join(', ')}`,
    );
  }
  const abandonmentMM = requireNonNegative(abandonment.abandonmentMM, 'the abandonment cost');
  if (abandonmentSource === 'none' && abandonmentMM !== 0) {
    throw new FdpInputError('an abandonment cost with source none must be 0');
  }
  return { abandonmentSource, abandonmentMM };
};

/**
 * Resolve the end-of-life cost a plan implies.
 *
 * @param {object} p
 * @param {object[]} [p.costItems] the plan's cost items (`type` 'ABEX' counts)
 * @param {object[]} [p.facilities] the plan's facilities
 * @param {*} [p.selectedFacilityId] the id of the facility the plan builds
 * @returns {{abandonmentSource: string, abandonmentMM: number, abandonmentBasis: string}}
 */
export const resolveAbandonment = ({ costItems, facilities, selectedFacilityId } = {}) => {
  const abex = (costItems || []).filter((item) => item?.type === 'ABEX');
  if (abex.length) {
    const amounts = abex.map((item, i) => requireNonNegative(
      item.amount, `the ABEX cost item "${item.name || `ABEX item ${i + 1}`}" amount`,
    ));
    const names = abex.map((item, i) => item.name || `ABEX item ${i + 1}`);
    return {
      abandonmentSource: 'abex-item',
      abandonmentMM: amounts.reduce((sum, a) => sum + a, 0),
      abandonmentBasis: `The plan's ABEX cost item${abex.length > 1 ? 's' : ''}: ${names.join(', ')}.`,
    };
  }
  const list = (facilities || []).filter(Boolean);
  const selected = isBlank(selectedFacilityId)
    ? null
    : list.find((f) => f.id === selectedFacilityId) || null;
  const facility = selected || (list.length === 1 ? list[0] : null);
  if (facility) {
    const name = facility.name || 'the facility';
    return {
      abandonmentSource: 'decommissioning-estimate',
      abandonmentMM: calculateFacilityCost(facility).decommissioning,
      abandonmentBasis: `Screening decommissioning estimate for ${name}: 15 percent of its sized capex. `
        + 'Enter an ABEX cost item to use your own figure.',
    };
  }
  return {
    abandonmentSource: 'none',
    abandonmentMM: 0,
    abandonmentBasis: list.length > 1
      ? 'The plan carries no ABEX cost item and lists several facilities with none selected, '
        + 'so no end-of-life cost is in the case. Select the facility the plan builds or enter an ABEX cost item.'
      : 'The plan carries no ABEX cost item and no facility, so no end-of-life cost is in the case.',
  };
};

/**
 * `resolveAbandonment` on an FDP plan state: its cost items, its facilities
 * and the selected facility.
 *
 * @param {object} state the FDP plan state
 * @returns {{abandonmentSource: string, abandonmentMM: number, abandonmentBasis: string}}
 */
export const planAbandonment = (state) => resolveAbandonment({
  costItems: state?.costs?.items,
  facilities: state?.facilities?.list,
  selectedFacilityId: state?.facilities?.selectedId,
});

/**
 * Run one FDP case.
 *
 * @param {object} p
 * @param {number} p.capexMM total development capex, $MM, spent in year one
 * @param {number} p.annualOpexMM fixed operating cost, $MM per year
 * @param {number[]} p.productionKbpd daily rate per production year, kbpd
 * @param {number[]} p.pricesUsd oil price per production year, $/bbl
 * @param {object} [p.fiscal] overrides for DEFAULT_FISCAL
 * @returns {{cashflow: object[], metrics: object}}
 */
/**
 * Build the screening-engine inputs one FDP case implies.
 *
 * Split out of `runFdpCase` in EC6-0 so the Economics tab can run the same
 * case through the sanctioned sensitivity sweep instead of the hard-coded
 * tornado it used to draw (a literal five-bar chart around "Base Case
 * ($245MM)", the same picture whatever the plan said).
 *
 * @param {object} p see runFdpCase
 * @returns {object} inputs for calculateEconomics
 */
export const buildFdpCaseInputs = ({
  capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal = {}, abandonment,
}) => {
  const terms = { ...DEFAULT_FISCAL, ...fiscal };
  const producingYears = productionKbpd.length;
  const end = checkedAbandonment(abandonment);
  if (end.abandonmentMM > 0 && producingYears === 0) {
    throw new FdpInputError(
      'the case has no production years to carry the abandonment cost in: enter a production profile',
    );
  }

  // Year one carries the capex and no production; the profile follows.
  // Modelling development as its own year is what makes payback and IRR
  // mean anything.
  const projectLife = producingYears + 1;
  const oil = new Array(projectLife).fill(0);
  const price = new Array(projectLife).fill(0);
  const opexFixed = new Array(projectLife).fill(0);
  const opexVariable = new Array(projectLife).fill(0);
  const capex = new Array(projectLife).fill(0);
  capex[0] = capexMM;

  for (let i = 0; i < producingYears; i += 1) {
    const kbpd = Number(productionKbpd[i]) || 0;
    const annualBbl = kbpd * 1000 * 365;
    oil[i + 1] = annualBbl;
    price[i + 1] = Number(pricesUsd[i]) || 0;
    opexFixed[i + 1] = annualOpexMM;
    opexVariable[i + 1] = (annualBbl * terms.variableOpexPerBbl) / 1e6;
  }

  return {
    startYear: 0,
    projectLife,
    discountRate: terms.discountRate,
    fiscalType: 'TaxRoyalty',
    production: { oil, gas: new Array(projectLife).fill(0) },
    price: { oil: price, gas: new Array(projectLife).fill(0) },
    capex,
    opexFixed,
    opexVariable,
    // EC6-8: the end-of-life cost falls in the final production year.
    abandonment: new Array(projectLife).fill(0).map((_, i) => (
      i === projectLife - 1 && producingYears > 0 ? end.abandonmentMM : 0)),
    royaltyRate: terms.royaltyRate,
    taxRate: terms.taxRate,
  };
};

/**
 * Run one FDP case.
 *
 * @param {object} p
 * @param {number} p.capexMM total development capex, $MM, spent in year one
 * @param {number} p.annualOpexMM fixed operating cost, $MM per year
 * @param {number[]} p.productionKbpd daily rate per production year, kbpd
 * @param {number[]} p.pricesUsd oil price per production year, $/bbl
 * @param {object} [p.fiscal] overrides for DEFAULT_FISCAL
 * @param {{abandonmentSource: string, abandonmentMM: number}} [p.abandonment]
 *   the end-of-life cost, as `resolveAbandonment` or `planAbandonment`
 *   returns it. Charged in the final production year. Absent means none.
 * @returns {{cashflow: object[], metrics: object, abandonmentSource: string,
 *   abandonmentMM: number, abandonmentYear: number|null}}
 */
export const runFdpCase = (p) => {
  const end = checkedAbandonment(p.abandonment);
  return {
    ...calculateEconomics(buildFdpCaseInputs(p)),
    abandonmentSource: end.abandonmentSource,
    abandonmentMM: end.abandonmentMM,
    // The year index (0 is the development year) the cost is charged in.
    abandonmentYear: end.abandonmentSource === 'none' ? null : p.productionKbpd.length,
  };
};

/**
 * The screening sensitivity sweep for one FDP case: NPV at plus and minus
 * 30 percent on oil price, capex, opex and production, against the base.
 *
 * @param {object} p see runFdpCase
 * @returns {Array<{name: string, lowParamNPV: number, highParamNPV: number, baseNPV: number}>}
 */
export const runFdpSensitivity = (p) => runSensitivityAnalysis(buildFdpCaseInputs(p));

/**
 * Years to payback, or null when the project never pays back.
 *
 * Delegates the interpolation to the engine's own `metrics.payback` and
 * only adds the honest null: the engine reports the project life when
 * payback never happens, which is indistinguishable from paying back on
 * the last day.
 *
 * @param {{cashflow: object[], metrics: object}} result a runFdpCase result
 * @returns {number|null}
 */
export const paybackYears = (result) => {
  const paysBack = result.cashflow.some((c) => c.cumulativeNCF >= 0);
  return paysBack ? result.metrics.payback : null;
};
