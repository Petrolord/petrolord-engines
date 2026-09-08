/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/wellCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). No edit at all beyond this header: the module has no imports.
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

export const calculateWellCount = (reserves, avgWellEur) => {
    if (!avgWellEur || avgWellEur === 0) return 0;
    return Math.ceil(reserves / avgWellEur);
};

export const aggregateWellsByType = (wells) => {
    return wells.reduce((acc, well) => {
        const type = well.type || 'Other';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
    }, {});
};

export const calculateTotalDrillingCost = (wells) => {
    return wells.reduce((sum, well) => sum + (parseFloat(well.cost) || 0), 0);
};