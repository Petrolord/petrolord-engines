/**
 * The one peer review authority for the Assurance module.
 *
 * AS5, after riskScoring (AS2), complianceStatus (AS3) and
 * documentControl (AS4). Same rule: a stage, a severity band and a
 * comment's disposition are decided in exactly one place.
 *
 * Peer Review Manager had three colour maps of its own, for stage,
 * priority and decision, each a switch over lower-cased strings with a
 * silent fall-through to grey. It had no disposition logic at all: the
 * comment status was whatever string the UI last assigned, so a comment
 * could be marked Verified without anyone having responded to it, and a
 * review could be Closed with unanswered Critical findings against it.
 *
 * That last one is the point of the app. A technical assurance review
 * that can be closed over an open showstopper is not an assurance
 * process; it is a list. The transitions below are what make the
 * comment loop mean something, and `canClose()` is what makes the
 * review outcome defensible.
 */

import {
  daysUntil,
  parseDateOnly,
  toDateOnlyString,
} from './calendar.js';

export { daysUntil, parseDateOnly, toDateOnlyString };

/** Review stages, in workflow order. */
export const STAGES = Object.freeze([
  'Draft',
  'In Review',
  'Verification',
  'Closed',
  'Cancelled',
]);

/** Stages in which a review is still live work. */
export const ACTIVE_STAGES = Object.freeze(['Draft', 'In Review', 'Verification']);

export const PRIORITIES = Object.freeze(['Low', 'Medium', 'High', 'Critical']);

export const DECISIONS = Object.freeze([
  'Pending',
  'Approved',
  'Approved with conditions',
  'Rejected',
]);

/**
 * Comment severity, worst first. "Editorial" is separated from "Minor"
 * deliberately: a typo and a questionable assumption are both small and
 * only one of them is technical, and lumping them together is how a
 * comment count stops meaning anything.
 */
export const SEVERITIES = Object.freeze(['Critical', 'Major', 'Minor', 'Editorial']);

/** Severities that must be resolved before a review can close. */
export const BLOCKING_SEVERITIES = Object.freeze(['Critical', 'Major']);

/**
 * Comment disposition.
 *
 *   Open      raised by a reviewer, nobody has answered
 *   Responded the author has answered, awaiting the reviewer
 *   Verified  the reviewer accepts the response
 *   Closed    formally closed out
 *   Rejected  the reviewer does not accept the response; back to the author
 *   Withdrawn the reviewer withdraws their own comment
 */
export const COMMENT_STATUSES = Object.freeze([
  'Open', 'Responded', 'Verified', 'Closed', 'Rejected', 'Withdrawn',
]);

/** Statuses that no longer need anybody to act. */
export const RESOLVED_STATUSES = Object.freeze(['Verified', 'Closed', 'Withdrawn']);

/**
 * Which transitions are legal, and who they belong to.
 *
 * Written as a map rather than as `if` statements in the page, because
 * the old app let the UI assign any status to any comment at any time.
 */
export const COMMENT_TRANSITIONS = Object.freeze({
  Open: Object.freeze(['Responded', 'Withdrawn']),
  Responded: Object.freeze(['Verified', 'Rejected']),
  Rejected: Object.freeze(['Responded', 'Withdrawn']),
  Verified: Object.freeze(['Closed']),
  Closed: Object.freeze([]),
  Withdrawn: Object.freeze([]),
});

/** The party a transition belongs to, for the label on the button. */
export const TRANSITION_ACTOR = Object.freeze({
  Responded: 'author',
  Verified: 'reviewer',
  Rejected: 'reviewer',
  Withdrawn: 'reviewer',
  Closed: 'coordinator',
});

export const canTransition = (from, to) =>
  (COMMENT_TRANSITIONS[from] || []).includes(to);

export const nextStatuses = (from) => COMMENT_TRANSITIONS[from] || [];

/**
 * Why a transition is refused, in words a user can act on.
 * Returns null when it is allowed.
 */
export const explainRefusal = (comment = {}, to) => {
  const from = comment.status || 'Open';
  if (canTransition(from, to)) {
    // Verified needs a response to verify. The database cannot express
    // this, so it is stated here and the hook enforces it.
    if (to === 'Verified' && !String(comment.response_text || '').trim()) {
      return 'A comment cannot be verified before the author has responded to it.';
    }
    return null;
  }
  if (from === to) return `This comment is already ${to.toLowerCase()}.`;
  const allowed = nextStatuses(from);
  if (!allowed.length) return `A ${from.toLowerCase()} comment is final.`;
  const word = from.toLowerCase();
  const article = /^[aeiou]/.test(word) ? 'An' : 'A';
  return `${article} ${word} comment can only go to ${allowed.join(' or ')}.`;
};

export const isResolved = (comment = {}) =>
  RESOLVED_STATUSES.includes(comment.status);

export const isBlocking = (comment = {}) =>
  BLOCKING_SEVERITIES.includes(comment.severity) && !isResolved(comment);

/**
 * May this review be closed?
 *
 * The question the old app never asked. A review could be moved to
 * Closed from a dropdown with Critical comments sitting open against
 * it, and the decision recorded beside it meant nothing.
 *
 * Minor and Editorial comments do not block: they are recorded, and
 * closing over them is a judgement a coordinator is entitled to make.
 * Critical and Major are not.
 */
export const canClose = (comments = []) => {
  const blocking = comments.filter(isBlocking);
  if (!blocking.length) return { ok: true, blocking: [] };
  const counts = BLOCKING_SEVERITIES
    .map((s) => ({ s, n: blocking.filter((c) => c.severity === s).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.s.toLowerCase()}`);
  return {
    ok: false,
    blocking,
    reason: `${counts.join(' and ')} comment${blocking.length === 1 ? '' : 's'} `
      + 'still need resolving. Verify, close out or withdraw them first.',
  };
};

/** Legal next stages from where a review is now. */
export const STAGE_TRANSITIONS = Object.freeze({
  Draft: Object.freeze(['In Review', 'Cancelled']),
  'In Review': Object.freeze(['Verification', 'Draft', 'Cancelled']),
  Verification: Object.freeze(['Closed', 'In Review', 'Cancelled']),
  Closed: Object.freeze([]),
  Cancelled: Object.freeze([]),
});

export const nextStages = (stage) => STAGE_TRANSITIONS[stage] || [];

/**
 * Is this review overdue?
 *
 * Only a live review can be. The old count was
 * `r.stage !== 'Closed' && new Date(r.due_date) < new Date()`, which
 * counted every cancelled review forever, and read a date-only column
 * as a UTC instant so a review due today was overdue west of Greenwich.
 */
export const isOverdue = (review = {}, today = new Date()) => {
  if (!ACTIVE_STAGES.includes(review.stage)) return false;
  const days = daysUntil(review.due_date, today);
  return days !== null && days < 0;
};

/**
 * Counts for the dashboard and the reports page, computed once.
 *
 * Every one of these came from a module-level array seeded from
 * MOCK_REVIEWS. `getDashboardStats()` never queried the database at
 * all, so a customer's peer review dashboard was a picture of somebody
 * else's invented project, permanently.
 */
export const summarise = (reviews = [], comments = [], today = new Date()) => {
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  reviews.forEach((r) => {
    if (byStage[r.stage] !== undefined) byStage[r.stage] += 1;
  });

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const byStatus = Object.fromEntries(COMMENT_STATUSES.map((s) => [s, 0]));
  comments.forEach((c) => {
    if (bySeverity[c.severity] !== undefined) bySeverity[c.severity] += 1;
    if (byStatus[c.status] !== undefined) byStatus[c.status] += 1;
  });

  return {
    total: reviews.length,
    byStage,
    active: reviews.filter((r) => ACTIVE_STAGES.includes(r.stage)).length,
    overdue: reviews.filter((r) => isOverdue(r, today)).length,
    totalComments: comments.length,
    bySeverity,
    byStatus,
    openComments: comments.filter((c) => !isResolved(c)).length,
    blockingComments: comments.filter(isBlocking).length,
  };
};

/** Group a count by any field, with a label for rows that do not say. */
export const countBy = (rows = [], field, unset = 'Unspecified') => {
  const counts = new Map();
  rows.forEach((r) => {
    const key = r?.[field] || unset;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};

/** Sort: overdue first, then by due date, then closed last. */
export const byUrgency = (today = new Date()) => (a, b) => {
  const rank = (r) => {
    if (isOverdue(r, today)) return 0;
    if (ACTIVE_STAGES.includes(r.stage)) return 1;
    return 2;
  };
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  const da = parseDateOnly(a.due_date);
  const db = parseDateOnly(b.due_date);
  if (da && db) return da - db;
  if (da) return -1;
  if (db) return 1;
  return 0;
};

/** Comments worst first, unresolved before resolved. */
export const bySeverityThenAge = (a, b) => {
  const resolved = Number(isResolved(a)) - Number(isResolved(b));
  if (resolved !== 0) return resolved;
  // A comment with no severity sorts after Editorial, never above
  // Critical, which indexOf's -1 used to do (PR-1, AS12 oracle).
  const rank = (c) => {
    const i = SEVERITIES.indexOf(c.severity);
    return i === -1 ? SEVERITIES.length : i;
  };
  const sev = rank(a) - rank(b);
  if (sev !== 0) return sev;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
};
