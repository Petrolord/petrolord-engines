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
import { conceptProfileKbpd } from './scenarioCalculations.js';
import { FdpInputError } from './inputError.js';
import {
  calculateWellCount, SCREENING_RECOVERY_PER_WELL_MMBBL, SCREENING_RECOVERY_PER_WELL_SOURCE,
} from './wellCalculations.js';
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

/**
 * EC6-1 (owner decision 2026-09-15). How far the profile may exceed the oil
 * P50 before the reserves check warns, as a fraction: more than 10 percent.
 * A screening shape within 10 percent of the P50 is as close as a shape with
 * no reservoir behind it can be expected to land.
 */
export const RESERVES_PROFILE_MARGIN = 0.1;

/** The concept the plan develops: the selected one, or the only one. */
const planConcept = (state) => {
  const list = Array.isArray(state?.concepts?.list) ? state.concepts.list : [];
  const selectedId = state?.concepts?.selectedId;
  const selected = selectedId === undefined || selectedId === null
    ? null
    : list.find((c) => c && c.id === selectedId);
  if (selected) return selected;
  return list.length === 1 ? list[0] : null;
};

/**
 * EC6-1. Does the concept's production profile fit the plan's reserves, and
 * do the wells carried fit the reserves?
 *
 * Before: nothing compared them. The EGINA plan's FPSO concept, a 60 kbpd
 * screening shape, produces 229.9293 MMbbl over 20 years against an oil P50
 * of 130.0000 MMbbl, and 130 MMbbl at 12 MMbbl a well takes 11 wells
 * against the 4 the plan carries, yet the plan scored 100 percent complete
 * with no warning.
 *
 * The check is NON-BLOCKING and caps nothing: the profile is a screening
 * shape and not a reservoir forecast, so the engine has no better profile to
 * put in its place. It reports and warns.
 *
 *   profileVolumeMMbbl   the sum of the profile's daily rates x 365 days
 *                        (kbpd x 1000 x 365 / 1e6), MMbbl
 *   oilP50MMbbl          planReservesP50(state, 'Oil'), MMbbl
 *   profileToP50Ratio    profile volume over oil P50 (null without both)
 *   impliedWells         calculateWellCount(oil P50, recovery per well):
 *                        the P50 divided by the recovery per well, rounded up
 *   carriedWells         the wells in the plan's drilling program
 *   wellsRatio           implied over carried (null with no wells carried)
 *
 * Warnings, each `{ code, message }`:
 *   'profile-exceeds-p50'           the ratio is above 1 + RESERVES_PROFILE_MARGIN
 *   'implied-wells-exceed-carried'  implied wells above carried wells
 *
 * The profile is the plan concept's (the selected concept, or the only one):
 * its `productionProfileKbpd` when it carries one, otherwise the screening
 * shape conceptProfileKbpd builds from its peak rate. `status` is 'checked'
 * when the profile, the oil P50 and at least one carried well are all there,
 * and 'incomplete' otherwise with `missing` naming what is not; each warning
 * runs whenever its own inputs are there.
 *
 * @param {object} state the FDP plan state
 * @returns {object}
 */
export const planReservesCheck = (state) => {
  const missing = [];
  const concept = planConcept(state);
  let profile = null;
  let profileSource = null;
  if (!concept) {
    missing.push('a selected concept');
  } else if (Array.isArray(concept.productionProfileKbpd) && concept.productionProfileKbpd.length) {
    profile = concept.productionProfileKbpd;
    profileSource = 'concept-profile';
  } else {
    try {
      profile = conceptProfileKbpd(concept);
      profileSource = 'screening-shape';
    } catch (err) {
      if (!(err instanceof FdpInputError)) throw err;
      missing.push('the concept peak production rate');
    }
  }
  const oilP50 = planReservesP50(state, 'Oil');
  if (!(oilP50 > 0)) missing.push('the oil P50 reserves');
  const carriedWells = Array.isArray(state?.wells?.list) ? state.wells.list.length : 0;
  if (carriedWells === 0) missing.push('wells in the drilling program');

  const profileVolumeMMbbl = profile
    ? profile.reduce((sum, kbpd) => sum + (Number(kbpd) || 0), 0) * 1000 * 365 / 1e6
    : null;
  const oilP50MMbbl = oilP50 > 0 ? oilP50 : null;
  const profileToP50Ratio = profileVolumeMMbbl !== null && oilP50MMbbl !== null
    ? profileVolumeMMbbl / oilP50MMbbl
    : null;
  const recoveryPerWellMMbbl = SCREENING_RECOVERY_PER_WELL_MMBBL;
  const impliedWells = oilP50MMbbl !== null ? calculateWellCount(oilP50MMbbl, recoveryPerWellMMbbl) : null;
  const wellsRatio = impliedWells !== null && carriedWells > 0 ? impliedWells / carriedWells : null;

  const warnings = [];
  if (profileToP50Ratio !== null && profileToP50Ratio > 1 + RESERVES_PROFILE_MARGIN) {
    warnings.push({
      code: 'profile-exceeds-p50',
      message: `The concept production profile carries ${profileVolumeMMbbl.toFixed(1)} MMbbl over `
        + `${profile.length} years, ${((profileToP50Ratio - 1) * 100).toFixed(1)} percent above the oil P50 `
        + `of ${oilP50MMbbl.toFixed(1)} MMbbl. The warning margin is ${RESERVES_PROFILE_MARGIN * 100} percent. `
        + 'The profile is a screening shape with no reservoir behind it, so check the peak rate against '
        + 'the reserves before relying on the economics.',
    });
  }
  if (impliedWells !== null && impliedWells > carriedWells) {
    warnings.push({
      code: 'implied-wells-exceed-carried',
      message: `Recovering the oil P50 of ${oilP50MMbbl.toFixed(1)} MMbbl at ${recoveryPerWellMMbbl} MMbbl `
        + `a well takes ${impliedWells} wells, and the drilling program carries ${carriedWells}. `
        + `The ${recoveryPerWellMMbbl} MMbbl a well is the engine screening figure.`,
    });
  }

  return {
    status: missing.length ? 'incomplete' : 'checked',
    missing,
    profileSource,
    profileYears: profile ? profile.length : null,
    profileVolumeMMbbl,
    oilP50MMbbl,
    profileToP50Ratio,
    marginFraction: RESERVES_PROFILE_MARGIN,
    recoveryPerWellMMbbl,
    recoveryPerWellSource: SCREENING_RECOVERY_PER_WELL_SOURCE,
    impliedWells,
    carriedWells,
    wellsRatio,
    warnings,
  };
};

/**
 * EC6-1: the result also carries `reservesCheck` (planReservesCheck) and
 * `completeWithWarnings`, true when every section is filled in (score 100)
 * and the reserves check has warnings, so a complete plan never reads as
 * clean while they stand. The score itself is unchanged.
 */
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
    const score = Math.round((completed / total) * 100);
    const reservesCheck = planReservesCheck(state);

    return {
        score,
        breakdown: checks,
        reservesCheck,
        completeWithWarnings: score === 100 && reservesCheck.warnings.length > 0
    };
};

/**
 * EC6-1: the reserves check's warning messages are appended to `warnings`
 * (they never make a plan invalid), and the check itself is `reservesCheck`.
 */
export const validateFDPData = (state) => {
    const errors = [];
    const warnings = [];

    if (!state.fieldData?.fieldName) errors.push("Project name is missing.");
    if (planReservesP50(state) <= 0 && planReservesP50(state, 'Gas') <= 0) errors.push("Reserves (P50) not estimated.");
    if ((state.wells?.list?.length || 0) === 0) warnings.push("No wells defined in the drilling program.");
    if ((state.facilities?.list?.length || 0) === 0) warnings.push("No facilities concepts selected.");
    if ((state.costs?.items?.length || 0) === 0) warnings.push("Cost breakdown is empty.");
    if ((state.economics?.capex || 0) <= 0) errors.push("Total CAPEX is zero or missing.");
    const reservesCheck = planReservesCheck(state);
    reservesCheck.warnings.forEach((w) => warnings.push(w.message));

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
        reservesCheck
    };
};