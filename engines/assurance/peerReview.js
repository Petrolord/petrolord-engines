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

/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);


export { daysUntil, parseDateOnly, toDateOnlyString };

// ASC-0 (RC-9): an article that agrees with the word it introduces. The
// refusal was written 'A ${word}', which printed "A archived lesson" and
// "A emergency change".
const withArticle = (word) => `${/^[aeiou]/i.test(word) ? 'An' : 'A'} ${word}`;

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

/**
 * Owner decision D1 of 2026-09-18 (segregation of duties), applied to
 * peer review at ASC-0: the author of the reviewed work never acts as its
 * reviewer. Same shape as managementOfChange's canAssignApprover /
 * canDecideApproval and documentControl's canAssignReviewer.
 *
 * The author is `peer_reviews.author_id`. `created_by` is whoever raised
 * the review record (often the coordinator) and is not the author of the
 * work, so it is not read here. A review with no author_id recorded
 * cannot be checked, and nothing is refused on it.
 */
export const REVIEWER_ROLES = Object.freeze(['Lead Reviewer', 'Reviewer']);

const isAuthor = (review, userId) =>
  Boolean(userId) && Boolean(review?.author_id) && userId === review.author_id;

/**
 * May this person be put on the review as a reviewer?
 *
 * `participant` is a `peer_review_participants` row: `user_id`,
 * `display_name`, `role`. The same question answers for
 * `peer_reviews.lead_reviewer_id`: pass `{ user_id: lead_reviewer_id,
 * role: 'Lead Reviewer' }`. A reviewer named by display name only (no
 * user_id, an external reviewer) cannot be matched to the author and is
 * allowed. Roles outside REVIEWER_ROLES (Author, Coordinator, Approver,
 * Observer) are not reviewers and are not refused here; a row with no
 * role is asked as a Reviewer.
 */
export const canAssignPeerReviewer = (review = {}, participant = {}) => {
  const p = participant || {};
  if (!p.user_id && !String(p.display_name || '').trim()) {
    return { ok: false, reason: 'Choose the reviewer.' };
  }
  // No role given is asked as a reviewer: this is the reviewer question.
  if (REVIEWER_ROLES.includes(p.role || 'Reviewer') && isAuthor(review, p.user_id)) {
    return {
      ok: false,
      reason: 'The author of the work under review cannot review it. Choose somebody independent of the work.',
    };
  }
  return { ok: true };
};

const REVIEWER_VERB = Object.freeze({
  Verified: 'verify', Rejected: 'reject', Withdrawn: 'withdraw',
});

/**
 * May this signed-in user move this comment to `to`?
 *
 * First the disposition rules (explainRefusal), then segregation of
 * duties: a transition TRANSITION_ACTOR gives to the reviewer (Verified,
 * Rejected, Withdrawn) is never taken by the author of the work under
 * review, who would otherwise accept their own answer to a finding
 * against their own work. The author's own move (Responded) and the
 * coordinator's (Closed) are not restricted here. With no user there is
 * nobody to check, so nothing moves.
 */
export const canActOnComment = (comment = {}, to, review = {}, userId) => {
  const refusal = explainRefusal(comment || {}, to);
  if (refusal) return { ok: false, reason: refusal };
  if (!userId) return { ok: false, reason: 'Sign in to act on this comment.' };
  if (ownPreset(TRANSITION_ACTOR, to) && TRANSITION_ACTOR[to] === 'reviewer' && isAuthor(review, userId)) {
    return {
      ok: false,
      reason: `The author of the work under review cannot ${REVIEWER_VERB[to]} a comment on it. A reviewer independent of the work decides it.`,
    };
  }
  return { ok: true };
};

export const canTransition = (from, to) =>
  (ownPreset(COMMENT_TRANSITIONS, from) ? COMMENT_TRANSITIONS[from] : []).includes(to);

export const nextStatuses = (from) => (ownPreset(COMMENT_TRANSITIONS, from) ? COMMENT_TRANSITIONS[from] : []);

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
  if (!allowed.length) return `${withArticle(from.toLowerCase())} comment is final.`;
  return `${withArticle(from.toLowerCase())} comment can only go to ${allowed.join(' or ')}.`;
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
    // ASC-0 (RC-9): the verb agrees with the count ("1 critical comment
    // still needs resolving").
    reason: `${counts.join(' and ')} comment${blocking.length === 1 ? '' : 's'} `
      + `still need${blocking.length === 1 ? 's' : ''} resolving. `
      + `Verify, close out or withdraw ${blocking.length === 1 ? 'it' : 'them'} first.`,
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

export const nextStages = (stage) => (ownPreset(STAGE_TRANSITIONS, stage) ? STAGE_TRANSITIONS[stage] : []);

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
  // ASC-0 (RC-4b), the AS14 rule MOC and QA already follow: a comment
  // belongs to a review, and once that review is Closed or Cancelled it is
  // locked, so nobody can resolve a comment left on it. Counting it kept
  // "open" and "blocking" high for ever. The history counts
  // (totalComments, bySeverity, byStatus) still count every comment. A
  // comment whose review is not in `reviews` still counts, as an MOC
  // action with an unknown change does: not knowing the parent is not a
  // reason to hide the work.
  const finished = new Set(reviews
    .filter((r) => ['Closed', 'Cancelled'].includes(r.stage))
    .map((r) => r.id)
    .filter((id) => id !== undefined && id !== null));
  const liveComments = comments.filter((c) => !finished.has(c.review_id));

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
    openComments: liveComments.filter((c) => !isResolved(c)).length,
    blockingComments: liveComments.filter(isBlocking).length,
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
