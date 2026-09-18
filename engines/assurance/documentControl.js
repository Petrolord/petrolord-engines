/**
 * The one document control authority for the Assurance module.
 *
 * AS4, Assurance-ROADMAP.md §6, after `riskScoring.js` (AS2) and
 * `complianceStatus.js` (AS3). Same rule: a status band, a review-due
 * calculation and a revision number are worked out in exactly one place
 * and imported everywhere.
 *
 * Document Control had two copies of the status colour map before this
 * file, one for status and one for confidentiality, each with a silent
 * fall-through to grey for any word it did not recognise. Since status
 * was free text, an unrecognised word was not hypothetical.
 *
 * It also had no review-due calculation at all. `next_review_date` was
 * a column that existed, was never derived, and was never compared to
 * anything: the dashboard's "Overdue Reviews" tile read `overdue: 1`,
 * a literal, in the branch that was otherwise querying the database.
 * A document control system whose whole job is to tell you what is due
 * for review reported the number one, forever.
 */

import {
  daysUntil,
  parseDateOnly,
  toDateOnlyString,
} from './calendar.js';

export { daysUntil, parseDateOnly, toDateOnlyString };

/** Lifecycle of a controlled document. Order is the workflow order. */
export const DOC_STATUSES = Object.freeze([
  'Draft',
  'In Review',
  'Approved',
  'Published',
  'Superseded',
  'Obsolete',
  'Rejected',
]);

/** Statuses a document can be read and relied upon in. */
export const EFFECTIVE_STATUSES = Object.freeze(['Published', 'Approved']);

/** Statuses that are no longer in force. */
export const RETIRED_STATUSES = Object.freeze(['Superseded', 'Obsolete', 'Rejected']);

export const CONFIDENTIALITY_LEVELS = Object.freeze([
  'Public',
  'Internal',
  'Confidential',
  'Restricted',
]);

export const DEFAULT_REVIEW_PERIOD_MONTHS = 24;

export const REVIEW = Object.freeze({
  OVERDUE: 'Review overdue',
  DUE_SOON: 'Review due soon',
  SCHEDULED: 'Review scheduled',
  NOT_SCHEDULED: 'No review scheduled',
  NOT_APPLICABLE: 'Not in force',
});

/** How far ahead a review starts reading "due soon". */
export const REVIEW_LEAD_DAYS = 30;

/**
 * Where a document stands against its review date.
 *
 * A document that is not in force cannot be overdue for review: a
 * superseded procedure from 2019 is not work for anybody, and counting
 * it is how a review queue fills with noise nobody can close. This is
 * the same judgement `complianceStatus` makes about a superseded
 * obligation.
 */
export const reviewState = (doc = {}, today = new Date()) => {
  if (!EFFECTIVE_STATUSES.includes(doc.status)) return REVIEW.NOT_APPLICABLE;
  if (!doc.next_review_date) return REVIEW.NOT_SCHEDULED;
  const days = daysUntil(doc.next_review_date, today);
  // An unreadable date is no date. `null <= 30` is true in JavaScript, so
  // 'tbc' used to read "Review due soon" (DC-1, AS12 oracle).
  if (days === null) return REVIEW.NOT_SCHEDULED;
  if (days < 0) return REVIEW.OVERDUE;
  if (days <= REVIEW_LEAD_DAYS) return REVIEW.DUE_SOON;
  return REVIEW.SCHEDULED;
};

export const isReviewOverdue = (doc, today = new Date()) =>
  reviewState(doc, today) === REVIEW.OVERDUE;

/**
 * The review date a document earns when it is issued.
 *
 * Counted from the issue date, not from today: re-publishing a
 * correction to a document issued last month should not push its review
 * a further two years out from the correction.
 */
export const nextReviewDate = (issueDate, periodMonths) => {
  const from = parseDateOnly(issueDate);
  const months = Number(periodMonths);
  if (!from || !Number.isFinite(months) || months <= 0) return null;
  const next = new Date(from.getFullYear(), from.getMonth() + months, from.getDate());
  // A 31st rolling into a 30-day month overflows; pull it back.
  if (next.getDate() !== from.getDate()) next.setDate(0);
  return next;
};

/**
 * The next revision number.
 *
 * Controlled documents are numbered '01', '02', ... and the width is
 * kept, because a revision is cited as written. Anything unparseable
 * starts the chain at 01 rather than producing 'NaN'.
 */
export const nextRevisionNumber = (current) => {
  const m = /^(\d+)$/.exec(String(current ?? '').trim());
  if (!m) return '01';
  const width = Math.max(2, m[1].length);
  return String(Number(m[1]) + 1).padStart(width, '0');
};

/** Is this confidentiality level at or above the given one? */
export const atLeastConfidential = (level, floor = 'Confidential') => {
  const a = CONFIDENTIALITY_LEVELS.indexOf(level);
  const b = CONFIDENTIALITY_LEVELS.indexOf(floor);
  return a >= 0 && b >= 0 && a >= b;
};

/**
 * Counts for the dashboard and the reports page, computed once so the
 * two cannot disagree. `overdue` is a real count of real rows; it used
 * to be the literal 1.
 */
export const summarise = (documents = [], today = new Date()) => {
  const byStatus = Object.fromEntries(DOC_STATUSES.map((s) => [s, 0]));
  let overdue = 0;
  let dueSoon = 0;
  documents.forEach((d) => {
    if (byStatus[d.status] !== undefined) byStatus[d.status] += 1;
    const state = reviewState(d, today);
    if (state === REVIEW.OVERDUE) overdue += 1;
    if (state === REVIEW.DUE_SOON) dueSoon += 1;
  });
  return {
    total: documents.length,
    byStatus,
    inReview: byStatus['In Review'],
    published: byStatus.Published,
    overdue,
    dueSoon,
  };
};

/** Group a count by any field, with a label for rows that do not say. */
export const countBy = (documents = [], field, unset = 'Unspecified') => {
  const counts = new Map();
  documents.forEach((d) => {
    const key = d?.[field] || unset;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};

/** Sort: review overdue first, then due soon, then by review date. */
export const byReviewUrgency = (today = new Date()) => (a, b) => {
  const order = [REVIEW.OVERDUE, REVIEW.DUE_SOON, REVIEW.SCHEDULED,
    REVIEW.NOT_SCHEDULED, REVIEW.NOT_APPLICABLE];
  const diff = order.indexOf(reviewState(a, today)) - order.indexOf(reviewState(b, today));
  if (diff !== 0) return diff;
  const da = parseDateOnly(a.next_review_date);
  const db = parseDateOnly(b.next_review_date);
  if (da && db) return da - db;
  if (da) return -1;
  if (db) return 1;
  return 0;
};

/**
 * The prefix a document number is issued under, from its department and
 * category. `next_document_number` normalises what it is given, but
 * building it the same way on both sides keeps the sequences aligned.
 */
export const documentPrefix = (department, category) => {
  const part = (v, fallback) => {
    const clean = String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return clean ? clean.slice(0, 3) : fallback;
  };
  return `${part(department, 'GEN')}-${part(category, 'DOC')}`;
};

/* ------------------------------------------------------------------ */
/* Segregation of duties (owner decision AS15)                        */
/* ------------------------------------------------------------------ */

/**
 * A review task is decided by the reviewer it is assigned to, and the
 * author of a revision does not review it. Before AS15 any member of the
 * organization could approve any task, the author included, so a
 * controlled document could be approved by the person who wrote it. The
 * database enforces the same rule (AS15 migration).
 */
export const canAssignReviewer = (revision = {}, reviewerId) => {
  if (!reviewerId) return { ok: false, reason: 'Choose the reviewer.' };
  if (revision.created_by && reviewerId === revision.created_by) {
    return { ok: false, reason: 'The author of a revision cannot review it. Choose somebody independent of the draft.' };
  }
  return { ok: true };
};

export const canDecideReviewTask = (task = {}, revision = {}, userId) => {
  if (task.status && task.status !== 'Pending') {
    return { ok: false, reason: `This review task is already ${String(task.status).toLowerCase()}.` };
  }
  if (!userId || userId !== task.reviewer_id) {
    return { ok: false, reason: 'Only the reviewer this task is assigned to can decide it.' };
  }
  if (revision.created_by && userId === revision.created_by) {
    return { ok: false, reason: 'The author of a revision cannot approve it.' };
  }
  return { ok: true };
};

