/**
 * EC6-0. Vendored from the Suite in the EC0 extraction wave, repaired here.
 *
 * Both functions read `state.subsurface.reserves.p50`. The plan has never
 * kept a figure there: the reserves live in `reserves.breakdown`, the rows
 * of the reserves table, and `reserves.summary` holds the totals, which
 * only Load example ever wrote. So a fully entered plan scored 78 percent
 * complete and failed validation with "Reserves (P50) not estimated", and
 * a plan whose reserves came from the table could never pass at all.
 *
 * They now read the rows through `aggregateReserves`, and fall back to the
 * summary when a caller hands in a plan that carries only that.
 */
import { aggregateReserves, reservesP50 } from './subsurfaceCalculations.js';
/**
 * FDP Calculations
 * Logic for checking completeness and quality of FDP modules.
 */

/**
 * The plan's P50 reserves, in the unit of the fluid asked for.
 *
 * Reads the reserves table first, because that is where a user's own
 * numbers go; falls back to the summary a loaded example carries. A row
 * with no fluid type makes the table unreadable, and that is reported as
 * no reserves rather than as a crash on a completeness screen.
 *
 * @param {object} state the FDP plan state
 * @param {string} [fluid] 'Oil', 'Gas' or 'Condensate'
 * @returns {number}
 */
export const planReservesP50 = (state, fluid = 'Oil') => {
  const reserves = state?.subsurface?.reserves;
  const rows = reserves?.breakdown;
  if (Array.isArray(rows) && rows.length) {
    try {
      return reservesP50(aggregateReserves(rows), fluid);
    } catch (err) {
      return 0;
    }
  }
  return parseFloat(reserves?.summary?.p50) || parseFloat(reserves?.p50) || 0;
};

export const calculateCompleteness = (state) => {
    const checks = [
        { module: 'Field Data', valid: !!state.fieldData?.fieldName && !!state.fieldData?.country },
        { module: 'Subsurface', valid: planReservesP50(state) > 0 || planReservesP50(state, 'Gas') > 0 },
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
    if (planReservesP50(state) <= 0 && planReservesP50(state, 'Gas') <= 0) errors.push("Reserves (P50) not estimated.");
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