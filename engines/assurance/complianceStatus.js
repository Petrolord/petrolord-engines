/**
 * The one compliance status authority for the Assurance module.
 *
 * AS3, Assurance-ROADMAP.md §6, the same rule that produced
 * src/lib/riskScoring.js in AS2: a status band is computed in exactly
 * one module and imported everywhere, including by the hub. Two places
 * that both know what "Overdue" means is the defect this module is most
 * likely to grow, and the risk register had already grown it four times
 * over before AS2 took it away.
 *
 * Regulatory Compliance was one step behind that. It had no threshold
 * to duplicate, because it had no derivation at all: `status` was a free
 * text column, and the only place a date was ever compared to today was
 * a loop on the dashboard that counted an obligation overdue while the
 * table beside it printed whatever word was stored. So the register
 * could show "Compliant" on a permit that expired last month.
 *
 * Status is DERIVED here and never typed. What a person chooses is the
 * LIFECYCLE — is this obligation live, a draft, superseded, or not
 * applicable to us — and the status follows from the lifecycle and the
 * dates. The database column keeps a cached copy, rewritten from this
 * module on every save, exactly as AS2 treats risk_register.rating.
 *
 * The date that matters most here is `expiry_date`. A permit's expiry
 * and a report's due date are different obligations against the same
 * row. An app that folds them into one date cannot tell an operator
 * that their discharge permit lapses in three weeks, which is the
 * failure this app exists to prevent, so both are carried and the
 * earlier of the two drives the warning.
 */

import {
  daysUntil,
  parseDateOnly,
  toDateOnlyString,
} from './calendar.js';

export { daysUntil, parseDateOnly, toDateOnlyString };

/** What a person sets. */
export const LIFECYCLES = Object.freeze([
  'Active',
  'Draft',
  'Superseded',
  'Not applicable',
]);

/**
 * Regulatory regimes. The retired Environmental Compliance tile folds
 * in here as a value rather than as a second app (roadmap §3).
 */
export const REGIMES = Object.freeze([
  'Environmental',
  'Health & Safety',
  'Operational',
  'Licensing',
  'Reporting',
  'Financial',
  'Other',
]);

export const OBLIGATION_TYPES = Object.freeze([
  'Permit',
  'Licence',
  'Consent',
  'Periodic report',
  'Inspection',
  'Fee or levy',
  'Notification',
  'Other',
]);

export const FREQUENCIES = Object.freeze([
  'One-off',
  'Monthly',
  'Quarterly',
  'Semi-annual',
  'Annual',
  'Biennial',
  'Other',
]);

/** Months to add when a submission rolls the next due date forward. */
const FREQUENCY_MONTHS = Object.freeze({
  Monthly: 1,
  Quarterly: 3,
  'Semi-annual': 6,
  Annual: 12,
  Biennial: 24,
});

/**
 * How far ahead an obligation starts reading "Due soon" when it does
 * not say. Per obligation in the schema, because a 90-day permit
 * renewal and a 7-day incident notification are not the same warning.
 */
export const DEFAULT_LEAD_TIME_DAYS = 30;

export const STATUS = Object.freeze({
  EXPIRED: 'Expired',
  OVERDUE: 'Overdue',
  DUE_SOON: 'Due soon',
  ON_TRACK: 'On track',
  COMPLIANT: 'Compliant',
  NO_DATE: 'No date set',
  DRAFT: 'Draft',
  SUPERSEDED: 'Superseded',
  NOT_APPLICABLE: 'Not applicable',
});

/**
 * Worst first. This is the sort order for the register and the order
 * the dashboard counts in, so that "what needs attention" means the
 * same thing in both places.
 */
export const STATUS_SEVERITY = Object.freeze([
  STATUS.EXPIRED,
  STATUS.OVERDUE,
  STATUS.DUE_SOON,
  STATUS.ON_TRACK,
  STATUS.COMPLIANT,
  STATUS.NO_DATE,
  STATUS.DRAFT,
  STATUS.SUPERSEDED,
  STATUS.NOT_APPLICABLE,
]);

/** The statuses that mean somebody has to do something. */
export const ATTENTION_STATUSES = Object.freeze([
  STATUS.EXPIRED,
  STATUS.OVERDUE,
  STATUS.DUE_SOON,
]);

/**
 * The date this obligation is actually counting down to: the earlier of
 * the next submission due date and the permit's own expiry.
 */
export const nextActionDate = (obligation = {}) => {
  const due = parseDateOnly(obligation.due_date);
  const expiry = parseDateOnly(obligation.expiry_date);
  if (due && expiry) return due <= expiry ? due : expiry;
  return due || expiry || null;
};

const leadTime = (obligation) => {
  const raw = obligation?.lead_time_days;
  // Number(null) and Number('') are both 0, not NaN, so a null column
  // would otherwise mean a zero-day warning window: the obligation
  // would jump straight from On track to Overdue with no notice at all,
  // which is the one thing this field exists to prevent.
  if (raw === null || raw === undefined || raw === '') return DEFAULT_LEAD_TIME_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_TIME_DAYS;
};

/**
 * The status of one obligation.
 *
 * Order matters and is the argument of the app:
 *   1. A lifecycle other than Active answers for itself. A superseded
 *      obligation is not overdue; it is superseded.
 *   2. An EXPIRED permit outranks an overdue report. If the licence has
 *      lapsed, when the next return was due is no longer the headline.
 *   3. Overdue: the due date has passed. Evidence filed earlier does
 *      not clear it, because the filing that is late is this period's.
 *   4. Due soon: inside the obligation's own lead time.
 *   5. Compliant: something has actually been filed, and nothing is
 *      near. "Compliant" is never asserted for an obligation with no
 *      evidence against it — that reads On track instead, which is the
 *      honest difference between "we are on schedule" and "we have
 *      done it".
 */
export const deriveStatus = (obligation = {}, today = new Date()) => {
  const lifecycle = obligation.lifecycle || 'Active';
  if (lifecycle === 'Draft') return STATUS.DRAFT;
  if (lifecycle === 'Superseded') return STATUS.SUPERSEDED;
  if (lifecycle === 'Not applicable') return STATUS.NOT_APPLICABLE;

  const due = parseDateOnly(obligation.due_date);
  const expiry = parseDateOnly(obligation.expiry_date);
  const submitted = parseDateOnly(obligation.last_submitted_date);

  if (!due && !expiry) return STATUS.NO_DATE;

  if (expiry && daysUntil(expiry, today) < 0) return STATUS.EXPIRED;
  // A One-off obligation has no next period. Once something is filed
  // against it, it is done, and its due date passing does not make it
  // overdue. It stayed in Needs attention for good before AS13-0: filing
  // leaves a one-off's due date where it is (rollForward has no period
  // for it), so the next rule fired the day after the deadline. An
  // expired permit still outranks it above.
  if (obligation.frequency === 'One-off' && submitted) return STATUS.COMPLIANT;
  if (due && daysUntil(due, today) < 0) return STATUS.OVERDUE;

  const next = nextActionDate(obligation);
  if (next !== null && daysUntil(next, today) <= leadTime(obligation)) {
    return STATUS.DUE_SOON;
  }

  return submitted ? STATUS.COMPLIANT : STATUS.ON_TRACK;
};

/**
 * The same answer with its reason, for the detail page and tooltips.
 * A status a user cannot account for is a status they will overwrite.
 */
export const explainStatus = (obligation = {}, today = new Date()) => {
  const status = deriveStatus(obligation, today);
  const next = nextActionDate(obligation);
  const days = next ? daysUntil(next, today) : null;
  const expiryDays = obligation.expiry_date
    ? daysUntil(obligation.expiry_date, today)
    : null;

  let reason;
  switch (status) {
    case STATUS.EXPIRED:
      reason = `The permit expired ${Math.abs(expiryDays)} day${Math.abs(expiryDays) === 1 ? '' : 's'} ago.`;
      break;
    case STATUS.OVERDUE:
      reason = `The due date passed ${Math.abs(daysUntil(obligation.due_date, today))} day${Math.abs(daysUntil(obligation.due_date, today)) === 1 ? '' : 's'} ago.`;
      break;
    case STATUS.DUE_SOON:
      reason = days === 0
        ? 'Due today.'
        : `Due in ${days} day${days === 1 ? '' : 's'}, inside the ${leadTime(obligation)} day lead time set for this obligation.`;
      break;
    case STATUS.COMPLIANT:
      reason = `Last filed ${obligation.last_submitted_date}, next due in ${days} days.`;
      break;
    case STATUS.ON_TRACK:
      reason = `Due in ${days} days. Nothing has been filed against it yet.`;
      break;
    case STATUS.NO_DATE:
      reason = 'No due date or expiry date has been set, so nothing can fall due.';
      break;
    default:
      reason = `Lifecycle is ${obligation.lifecycle}, so it is not tracked against a date.`;
  }
  return { status, reason, daysUntil: days, nextActionDate: next };
};

/** Sort comparator: worst status first, then by the nearest date. */
export const byUrgency = (today = new Date()) => (a, b) => {
  const rank = (o) => STATUS_SEVERITY.indexOf(deriveStatus(o, today));
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  const da = nextActionDate(a);
  const db = nextActionDate(b);
  if (da && db) return da - db;
  if (da) return -1;
  if (db) return 1;
  return 0;
};

/**
 * Counts for the dashboard and the reports page, computed once here so
 * the two cannot disagree. `attention` is the number a compliance lead
 * is actually managing.
 */
export const summarise = (obligations = [], today = new Date()) => {
  const byStatus = Object.fromEntries(STATUS_SEVERITY.map((s) => [s, 0]));
  obligations.forEach((o) => {
    byStatus[deriveStatus(o, today)] += 1;
  });
  return {
    total: obligations.length,
    byStatus,
    attention: ATTENTION_STATUSES.reduce((n, s) => n + byStatus[s], 0),
  };
};

/** Group a count by any field, with a label for rows that do not say. */
export const countBy = (obligations = [], field, unset = 'Unspecified') => {
  const counts = new Map();
  obligations.forEach((o) => {
    const key = o?.[field] || unset;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};

/**
 * The next due date after a submission, by frequency.
 *
 * Rolled forward from the date that WAS due, not from the date it was
 * filed: an annual return filed three weeks late is still due on the
 * same day next year, and rolling from the filing date would walk the
 * whole schedule later every year.
 *
 * Returns null for One-off and Other, which have no next occurrence to
 * compute; the user sets the next date if there is one.
 */
export const rollForward = (dueDate, frequency) => {
  const months = FREQUENCY_MONTHS[frequency];
  const from = parseDateOnly(dueDate);
  if (!months || !from) return null;
  const next = new Date(from.getFullYear(), from.getMonth() + months, from.getDate());
  // A 31st rolling into a 30-day month overflows into the next month.
  // Pull it back to the last day of the intended month.
  if (next.getDate() !== from.getDate()) next.setDate(0);
  return next;
};
