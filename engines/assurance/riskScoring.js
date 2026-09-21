/**
 * The one risk scoring authority for the Assurance module.
 *
 * AS2, Assurance-ROADMAP.md §6: "Risk score, rating band and appetite
 * status are computed in exactly one module and imported everywhere,
 * including by the hub. Two places that both know the 5x5 matrix is the
 * defect this module is most likely to grow."
 *
 * It had already grown it. Before this file there were four different
 * answers to "how red is this risk" in the same app:
 *
 *   utils/riskScoring.js          >= 15 / >= 10 / >= 5
 *   RiskHeatmapMatrix getCellBg   the same thresholds, written again,
 *                                 in the file that imports the first one
 *   RiskRegisterTablePage         > 15, so a score of exactly 15 was
 *                                 green in the table and red everywhere
 *                                 else
 *   useAssuranceAnalytics         `r.rating || (computed)`, preferring a
 *                                 stored text column the app never
 *                                 writes, so the hub would have shown a
 *                                 stale band the moment anything did
 *
 * Nothing in this module may restate a threshold. Import from here.
 * `src/lib/__tests__/riskScoring.test.js` has a guard that fails if a
 * second copy appears.
 *
 * Convention: a 5x5 likelihood-by-impact matrix, ISO 31000 shaped,
 * scored as the product. The bands are the ones the register shipped
 * with; they are not changed here, because changing them would silently
 * reclassify every risk an organization has already logged. Changing
 * them is an owner decision with a migration behind it.
 */

import { daysUntil, parseDateOnly } from './calendar.js';

export const SCALE_MIN = 1;
export const SCALE_MAX = 5;

/** Band thresholds, inclusive lower bounds, highest first. */
export const RISK_BANDS = Object.freeze([
  { band: 'Critical', min: 15, max: 25, cssVar: '--risk-critical' },
  { band: 'High', min: 10, max: 14, cssVar: '--risk-high' },
  { band: 'Medium', min: 5, max: 9, cssVar: '--risk-medium' },
  { band: 'Low', min: 1, max: 4, cssVar: '--risk-low' },
]);

export const RISK_BAND_NAMES = Object.freeze(RISK_BANDS.map((b) => b.band));

/**
 * The register's status vocabulary (the form's list, in
 * `pages/apps/risk-register/constants.js`) split into the risks an
 * organization still carries and the ones it does not. AS11 needed the
 * split for the hub, and the hub is not the place to decide it.
 * A Mitigated risk is still carried: mitigation lowers the residual,
 * it does not remove the risk. A Realized risk has happened and is
 * still carried until someone closes it. Draft has not been raised.
 */
export const RISK_LIVE_STATUSES = Object.freeze(['Open', 'Under Review', 'Mitigated', 'Realized']);
export const RISK_NOT_LIVE_STATUSES = Object.freeze(['Draft', 'Closed']);

/** Returned when a risk has no usable likelihood or impact. */
export const NO_BAND = 'None';

const clampLevel = (value) => {
  const n = Number(value);
  // Owner decision AS15 (§3k.4 Q3): the scale is five whole levels. 2.5
  // is not a level, and multiplying it produced scores (6.25, 7.5) that
  // no cell of the matrix holds. A fraction is unscored, like any other
  // value off the scale.
  if (!Number.isInteger(n)) return null;
  if (n < SCALE_MIN || n > SCALE_MAX) return null;
  return n;
};

/**
 * Inherent or residual score from a likelihood and an impact.
 * Returns 0 when either side is missing or off the 1-5 scale, which is
 * the only score that maps to NO_BAND. It never guesses a level.
 */
export const calculateRiskScore = (likelihood, impact) => {
  const l = clampLevel(likelihood);
  const i = clampLevel(impact);
  if (l === null || i === null) return 0;
  return l * i;
};

/** The band a score falls in. */
export const getRiskBand = (score) => {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return NO_BAND;
  const hit = RISK_BANDS.find((b) => n >= b.min);
  return hit ? hit.band : NO_BAND;
};

/**
 * Residual score. A risk whose residual position has not been assessed
 * has not been mitigated, so its residual IS its inherent score. That
 * is the conservative reading and it matches the generated column in
 * migration 20260916110000, which must agree with this function.
 */
// A blank form field ('') is "not assessed", the same as null: without
// this, Number('') is 0, the axis failed the 1-5 scale and the whole
// residual scored 0 instead of falling back per axis (RS-2, AS12 oracle).
const assessed = (value) => (value === '' || value === null || value === undefined
  ? undefined : value);

export const calculateResidualScore = (risk = {}) =>
  calculateRiskScore(
    assessed(risk.residual_likelihood) ?? risk.likelihood,
    assessed(risk.residual_impact) ?? risk.impact,
  );

export const APPETITE = Object.freeze({
  WITHIN: 'Within appetite',
  ABOVE: 'Above appetite',
  NOT_SET: 'Not set',
});

/**
 * Appetite status: is the residual score inside the tolerance set for
 * this risk? With no target set there is no answer, and NOT_SET says so
 * rather than reporting a pass.
 */
export const getAppetiteStatus = (risk = {}) => {
  const target = Number(risk.target_score);
  if (!Number.isFinite(target) || target <= 0) return APPETITE.NOT_SET;
  const residual = calculateResidualScore(risk);
  if (residual <= 0) return APPETITE.NOT_SET;
  return residual <= target ? APPETITE.WITHIN : APPETITE.ABOVE;
};

/**
 * Is this risk's review overdue? `asOf` is injectable so the tests are
 * not a function of the day they run on.
 *
 * Only a LIVE risk (RISK_LIVE_STATUSES) can be review-overdue, the same
 * shape as every other overdue test in the family: a Closed or Draft
 * risk carries no review obligation, and a risk with no status is not
 * known to be live (RC-2, ASC-0).
 */
export const isReviewOverdue = (risk = {}, asOf = new Date()) => {
  if (!RISK_LIVE_STATUSES.includes(risk?.status)) return false;
  // Both dates are calendar dates, read at LOCAL midnight through
  // calendar.js. The risk's date used `new Date('YYYY-MM-DD')`, UTC
  // midnight, so west of Greenwich a review due today read overdue (RS-1,
  // AS12 oracle; the AS3 defect). The as-of date kept that read after the
  // RS-1 repair, so a STRING as-of date was the day before west of
  // Greenwich (RC-1, ASC-0). A review due today is not yet overdue, and an
  // unreadable as-of date decides nothing.
  const today = parseDateOnly(asOf);
  if (!today) return false;
  const days = daysUntil(risk.next_review_date, today);
  return days !== null && days < 0;
};

/**
 * Everything the UI and the database need for one risk, derived once.
 * `rating` is the column the register stores; it is written from here on
 * every save so the stored band can never disagree with the stored
 * score.
 */
export const deriveRiskFields = (risk = {}) => {
  const inherentScore = calculateRiskScore(risk.likelihood, risk.impact);
  const residualScore = calculateResidualScore(risk);
  return {
    inherentScore,
    inherentBand: getRiskBand(inherentScore),
    residualScore,
    residualBand: getRiskBand(residualScore),
    rating: getRiskBand(inherentScore),
    appetite_status: getAppetiteStatus(risk),
  };
};

/** Counts by band, for the dashboard and the hub. Never re-derived. */
export const countByBand = (risks = [], { residual = false } = {}) => {
  const counts = Object.fromEntries(RISK_BAND_NAMES.map((b) => [b, 0]));
  counts[NO_BAND] = 0;
  risks.forEach((r) => {
    const score = residual
      ? calculateResidualScore(r)
      : calculateRiskScore(r.likelihood, r.impact);
    counts[getRiskBand(score)] += 1;
  });
  return counts;
};
