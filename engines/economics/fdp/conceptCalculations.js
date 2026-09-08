/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/conceptCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). No edit at all beyond this header: the module has no imports.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * Concept Calculations Utility
 * Handling economics and technical metrics for development concepts.
 */

export const calculateConceptCost = (concept) => {
    // Simple aggregation of CAPEX and OPEX
    const totalCapex = (parseFloat(concept.drillingCapex) || 0) + 
                       (parseFloat(concept.facilitiesCapex) || 0) + 
                       (parseFloat(concept.subseaCapex) || 0);
    
    const annualOpex = parseFloat(concept.opex) || 0;
    const lifeOfField = parseFloat(concept.lifeOfField) || 20;
    const totalOpex = annualOpex * lifeOfField;

    return {
        totalCapex,
        totalOpex,
        totalLifecycleCost: totalCapex + totalOpex
    };
};

export const calculateConceptSchedule = (concept) => {
    // Mock schedule milestones based on facility type
    const startDate = new Date(concept.startDate || new Date());
    const firstOilOffset = concept.facilityType === 'FPSO' ? 36 : 24; // Months
    
    const firstOilDate = new Date(startDate);
    firstOilDate.setMonth(startDate.getMonth() + firstOilOffset);

    return {
        fidDate: startDate.toISOString().split('T')[0],
        firstOilDate: firstOilDate.toISOString().split('T')[0],
        durationMonths: firstOilOffset
    };
};

export const calculateReservesImpact = (concept, subsurfaceData) => {
    // Adjust reserves based on recovery mechanism
    const baseRecoverable = subsurfaceData?.reserves?.p50 || 0;
    let rfMultiplier = 1.0;

    switch(concept.driveMechanism) {
        case 'Water Injection': rfMultiplier = 1.15; break;
        case 'Gas Injection': rfMultiplier = 1.10; break;
        case 'Natural Depletion': rfMultiplier = 0.85; break;
        case 'ESP': rfMultiplier = 1.05; break;
        default: rfMultiplier = 1.0;
    }

    return {
        recoverableReserves: baseRecoverable * rfMultiplier,
        rfMultiplier
    };
};