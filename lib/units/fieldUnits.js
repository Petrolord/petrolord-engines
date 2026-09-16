/**
 * Field-unit conversions that more than one engine needs.
 *
 * ONE definition per quantity, because the alternative is what this file
 * was created to end: `engines/facilities/lineHydraulics.js` carried the
 * barrel exactly as (42 * 231) / 1728 and
 * `engines/production/chokePerformance.js` carried it truncated to seven
 * figures as 5.614583, a ratio of 1.0000000593692, inside the SINGLE chain
 * the Pipeline & Line Sizing Studio composes (bores from pipeSchedule,
 * pressure drops from lineHydraulics, the erosional verdict from
 * chokePerformance). Two values of one constant one import apart is a
 * defect however small the gap, because nothing downstream can tell which
 * of the two it is holding.
 *
 * The EXACT value is the one kept, and it is exact by definition rather
 * than by measurement: an oil barrel is 42 US gallons, a US gallon is 231
 * cubic inches and a cubic foot is 1728 cubic inches, all three exact. The
 * truncated form had no independent provenance; it was a rounding of this.
 * Both engines' Python oracles already work from the SI barrel
 * 0.158987294928 m3, which IS this number to the last bit
 * (0.158987294928 / 0.3048^3 = 5.614583333333333), so the goldens already
 * said which half of the disagreement was right.
 *
 * Other modules (production/plungerLift.js, production/espPump.js,
 * fluid/separator.js, welltest/models/modelCatalog.js) still carry the
 * truncated form. They are not in this chain and moving them moves other
 * courses' shipped goldens, so they are recorded rather than changed here.
 */

/** Cubic feet in one oil barrel. Exact: 42 gal x 231 in3/gal / 1728 in3/ft3. */
export const CUFT_PER_BBL = (42 * 231) / 1728;

/** Seconds in a day. */
export const S_PER_DAY = 86400;
