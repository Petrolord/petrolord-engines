/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/wellCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). EC6-1 added the stated screening recovery per well; the
 * functions are unchanged and the module has no imports.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * Well Calculations Utility
 * Estimates for drilling times, costs, and technical parameters.
 */

export const calculateDrillingTime = (md, wellType, complexity = 'Medium') => {
    // Base rate (ft/day) depending on complexity
    let rop = 400; // ft/day
    if (complexity === 'High') rop = 250;
    if (complexity === 'Low') rop = 600;

    // Adjustment for well type
    if (wellType === 'Horizontal') rop *= 0.7;
    if (wellType === 'Deviated') rop *= 0.85;

    // Calculate days + flat time (casing, cementing, logging - approx 10 days)
    const drillingDays = (md / rop) + 10;
    
    return Math.ceil(drillingDays);
};

export const calculateDrillingCost = (days, rigRate, servicesCost = 0) => {
    // rigRate in USD/day
    // servicesCost (mud, bits, logging, casing, cement) roughly estimated if not provided
    const estimatedServices = servicesCost > 0 ? servicesCost : days * rigRate * 1.5; 
    return (days * rigRate) + estimatedServices;
};

/**
 * EC6-1. The recovery per well the plan's reserves check divides the oil
 * P50 by, MMbbl a well. The engine has no well performance model; this is
 * the screening figure its own worked example counts wells at (the golden
 * `example.expected.wellCountAt12MMbbl` in fdp_cases.json) and the figure
 * the FDP course asks the well count at. It is stated on every reserves
 * check as `recoveryPerWellSource` so nobody reads it as a forecast.
 */
export const SCREENING_RECOVERY_PER_WELL_MMBBL = 12;
export const SCREENING_RECOVERY_PER_WELL_SOURCE = 'The engine screening figure of 12 MMbbl a well '
  + '(wellCalculations.js SCREENING_RECOVERY_PER_WELL_MMBBL, the worked example well count).';

export const calculateWellCount = (reserves, avgWellEur) => {
    if (!avgWellEur || avgWellEur === 0) return 0;
    return Math.ceil(reserves / avgWellEur);
};

/** Own-property access. `obj[key]` walks the prototype chain, so a caller
 *  name of 'constructor', 'toString', 'valueOf', 'hasOwnProperty' or
 *  '__proto__' reads an inherited member, and writing '__proto__' replaces
 *  the prototype instead of storing a row. */
const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);
const ownValue = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);
const setOwn = (obj, key, value) => Object.defineProperty(obj, key, {
  value, writable: true, enumerable: true, configurable: true,
});

export const aggregateWellsByType = (wells) => {
    return wells.reduce((acc, well) => {
        const type = well.type || 'Other';
        setOwn(acc, type, (ownValue(acc, type) || 0) + 1);
        return acc;
    }, {});
};

export const calculateTotalDrillingCost = (wells) => {
    return wells.reduce((sum, well) => sum + (parseFloat(well.cost) || 0), 0);
};