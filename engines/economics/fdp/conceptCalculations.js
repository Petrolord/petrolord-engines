/**
 * EC6-0. Vendored from the Suite in the EC0 extraction wave;
 * `calculateConceptSchedule` repaired here.
 *
 * It read the clock when a concept had no start date, so the same concept
 * gave a different first-oil date every day it was opened, and it did its
 * month arithmetic on a UTC midnight while reading and writing local
 * fields: 2024-03-01 plus 24 months landed on a different day depending on
 * the reader's time zone, and in Lagos just after midnight the example's
 * Project Sanction was dated yesterday.
 *
 * The date is now parsed and formatted on the local calendar, and a
 * concept with no start date is refused unless the caller states what
 * today is, which is the as-of rule the AFE engine already follows.
 */
import { FdpInputError } from './inputError.js';
import { parseScheduleDate } from './scheduleCalculations.js';
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

/** A local date as YYYY-MM-DD, with no zone round trip. */
const formatLocalDate = (d) => [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
].join('-');

/**
 * Screening milestones for a concept: sanction, then first oil a fixed
 * number of months later by facility type.
 *
 * @param {object} concept
 * @param {object} [options]
 * @param {Date|string} [options.today] what to use when the concept has no
 *   start date. Stated by the caller so the result is reproducible.
 * @returns {{fidDate: string, firstOilDate: string, durationMonths: number}}
 */
export const calculateConceptSchedule = (concept, { today } = {}) => {
    const startDate = parseScheduleDate(concept?.startDate) || parseScheduleDate(today);
    if (!startDate) {
        throw new FdpInputError(
            'the concept has no start date: enter one, or pass today to date the schedule from',
        );
    }
    const firstOilOffset = concept?.facilityType === 'FPSO' ? 36 : 24; // Months

    // Month arithmetic on the local calendar fields, so adding 24 months to
    // the first of a month always lands on the first of a month.
    const firstOilDate = new Date(
        startDate.getFullYear(),
        startDate.getMonth() + firstOilOffset,
        startDate.getDate(),
    );

    return {
        fidDate: formatLocalDate(startDate),
        firstOilDate: formatLocalDate(firstOilDate),
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