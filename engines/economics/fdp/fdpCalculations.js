/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/fdpCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). No edit at all beyond this header: the module has no imports.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * FDP Calculations
 * Logic for checking completeness and quality of FDP modules.
 */

export const calculateCompleteness = (state) => {
    const checks = [
        { module: 'Field Data', valid: !!state.fieldData?.fieldName && !!state.fieldData?.country },
        { module: 'Subsurface', valid: (state.subsurface?.reserves?.p50 || 0) > 0 },
        { module: 'Concepts', valid: (state.concepts?.list?.length || 0) > 0 },
        { module: 'Wells', valid: (state.wells?.list?.length || 0) > 0 },
        { module: 'Facilities', valid: (state.facilities?.list?.length || 0) > 0 },
        { module: 'Schedule', valid: (state.schedule?.activities?.length || 0) > 0 },
        { module: 'Economics', valid: (state.economics?.npv || 0) !== 0 },
        { module: 'HSE', valid: (state.hseData?.hazards?.length || 0) > 0 },
        { module: 'Risks', valid: (state.risks?.length || 0) > 0 }
    ];

    const completed = checks.filter(c => c.valid).length;
    const total = checks.length;
    
    return {
        score: Math.round((completed / total) * 100),
        breakdown: checks
    };
};

export const validateFDPData = (state) => {
    const errors = [];
    const warnings = [];

    if (!state.fieldData?.fieldName) errors.push("Project name is missing.");
    if ((state.subsurface?.reserves?.p50 || 0) <= 0) errors.push("Reserves (P50) not estimated.");
    if ((state.wells?.list?.length || 0) === 0) warnings.push("No wells defined in the drilling program.");
    if ((state.facilities?.list?.length || 0) === 0) warnings.push("No facilities concepts selected.");
    if ((state.costs?.items?.length || 0) === 0) warnings.push("Cost breakdown is empty.");
    if ((state.economics?.capex || 0) <= 0) errors.push("Total CAPEX is zero or missing.");

    return {
        isValid: errors.length === 0,
        errors,
        warnings
    };
};