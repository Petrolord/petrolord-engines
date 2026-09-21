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

/* ------------------------------------------------------------------ *
 * Power and energy, derived rather than quoted.
 *
 * Added by the FC3-0 rotating-equipment wave, which found the same
 * disease as the barrel above in two more places:
 * `facilities/pumps.js` carried kilowatts per horsepower as 0.7457
 * against the derived 0.7456998715822702, a ratio of 1.0000001722, so
 * every motorInputKw the Pump Station Designer printed was 1.72e-7
 * high; and `facilities/compression.js` carried Btu per
 * horsepower-hour as 2544.43 against the derived 2544.433577644024, a
 * ratio of 0.9999985939, so every driver thermal efficiency was
 * 1.406e-6 high. Neither rounding had independent provenance. Both are
 * roundings of quantities that are EXACT BY DEFINITION, so the exact
 * value is the one kept, exactly as the barrel was.
 *
 * The chain: the foot is exactly 0.3048 m, the pound is exactly
 * 0.45359237 kg and standard gravity is exactly 9.80665 m/s2, all
 * three by international agreement; mechanical horsepower is DEFINED
 * as 550 ft.lbf/s; and the international-table Btu is exactly
 * 1055.05585262 J.
 * ------------------------------------------------------------------ */

/** One foot-pound-force in joules. Exact. */
export const J_PER_FT_LBF = 0.3048 * 0.45359237 * 9.80665;

/** Foot-pounds-force per minute in one horsepower. Exact: 550 x 60. */
export const FT_LBF_PER_MIN_PER_HP = 550 * 60;

/** One mechanical horsepower in watts. Exact.
 *  Written left to right on purpose: `550 * (0.3048 * 0.45359237 *
 *  9.80665)` rounds to 745.6998715822704, one unit in the last place
 *  above the correctly rounded 745.6998715822702 this grouping gives,
 *  which is the double nearest the exact rational value. */
export const W_PER_HP = 550 * 0.3048 * 0.45359237 * 9.80665;

/** Kilowatts per horsepower. Exact; 0.7457 is a rounding of it. */
export const KW_PER_HP = W_PER_HP / 1000;

/** One international-table Btu in joules. Exact by definition. */
export const J_PER_BTU = 1055.05585262;

/** Btu in one horsepower-hour. Exact; 2544.43 is a rounding of it.
 *  Grouped as W x (s/Btu) rather than (W x s) / Btu for the same
 *  last-place reason as W_PER_HP: this grouping is the double nearest
 *  the exact rational value, 2544.433577644024. */
export const BTU_PER_HP_HR = W_PER_HP * (3600 / J_PER_BTU);
