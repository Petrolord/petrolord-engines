/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/economics.js in the EC0 Economics
 * extraction wave (2026-09-08). The only edit is the import: '@/utils/npvCalculations' became '../screening.js' (the same file, vendored verbatim on this branch).
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
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

import { calculateEconomics } from '../screening.js';

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
export const runFdpCase = ({
  capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal = {},
}) => {
  const terms = { ...DEFAULT_FISCAL, ...fiscal };
  const producingYears = productionKbpd.length;

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

  return calculateEconomics({
    startYear: 0,
    projectLife,
    discountRate: terms.discountRate,
    fiscalType: 'TaxRoyalty',
    production: { oil, gas: new Array(projectLife).fill(0) },
    price: { oil: price, gas: new Array(projectLife).fill(0) },
    capex,
    opexFixed,
    opexVariable,
    abandonment: new Array(projectLife).fill(0),
    royaltyRate: terms.royaltyRate,
    taxRate: terms.taxRate,
  });
};

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
