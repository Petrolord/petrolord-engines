/**
 * The one Management of Change authority for the Assurance module.
 *
 * AS6, after riskScoring (AS2), complianceStatus (AS3),
 * documentControl (AS4) and peerReview (AS5).
 *
 * MOC had no logic of any kind to consolidate, because it had no data.
 * Every page was a literal. So this file is not a de-duplication; it is
 * the first statement anywhere in the Suite of what an MOC process
 * actually enforces.
 *
 * Three rules, and they are the reason the discipline exists:
 *
 *   A change does not leave Approval until every approval level has
 *   signed. That is what "multi-level approval gate" means, and an app
 *   that lets a stage dropdown skip it has a workflow diagram rather
 *   than a gate.
 *
 *   A change does not get implemented until its pre-implementation
 *   actions are closed, and does not close until its post-
 *   implementation actions are. The ordering is the whole point of
 *   splitting the action list.
 *
 *   A temporary change past its expiry date is EXPIRED, and that
 *   outranks every other state it is in. A temporary change that has
 *   quietly become permanent is the failure mode MOC exists to catch,
 *   and it is invisible unless something looks for it.
 */

import {
  daysUntil,
  parseDateOnly,
  toDateOnlyString,
} from './calendar.js';

export { daysUntil, parseDateOnly, toDateOnlyString };

// ASC-0 (RC-9): an article that agrees with the word it introduces. The
// refusal was written 'A ${word}', which printed "A archived lesson" and
// "A emergency change".
const withArticle = (word) => `${/^[aeiou]/i.test(word) ? 'An' : 'A'} ${word}`;

// ASC-0 (RC-9): '2', '2 and 3', '2, 3 and 4'.
const listed = (xs) => (xs.length <= 1 ? xs.join('')
  : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Stages, in workflow order. */
export const STAGES = Object.freeze([
  'Draft',
  'Screening',
  'Review',
  'Approval',
  'Implementation',
  'Closed',
  'Rejected',
  'Cancelled',
]);

/** Stages in which the change is still live work. */
export const ACTIVE_STAGES = Object.freeze([
  'Draft', 'Screening', 'Review', 'Approval', 'Implementation',
]);

/** Stages in which the change is on the facility. */
export const IN_EFFECT_STAGES = Object.freeze(['Implementation', 'Closed']);

export const TERMINAL_STAGES = Object.freeze(['Closed', 'Rejected', 'Cancelled']);

export const CHANGE_TYPES = Object.freeze(['Permanent', 'Temporary', 'Emergency']);

/** Types that must carry an expiry date once past Draft. */
export const EXPIRING_TYPES = Object.freeze(['Temporary', 'Emergency']);

export const CATEGORIES = Object.freeze([
  'Facility or hardware',
  'Process or chemistry',
  'Procedural or documentation',
  'Organizational or personnel',
  'Software or IT',
  'Other',
]);

export const RISK_LEVELS = Object.freeze(['Low', 'Medium', 'High', 'Critical']);
export const PRIORITIES = Object.freeze(['Low', 'Medium', 'High', 'Critical']);

export const APPROVAL_STATUSES = Object.freeze(['Pending', 'Approved', 'Rejected', 'Delegated']);
export const ACTION_STATUSES = Object.freeze(['Open', 'In progress', 'Complete', 'Cancelled']);
export const ACTION_TYPES = Object.freeze([
  'Pre-implementation', 'Implementation', 'Post-implementation',
]);
export const IMPACT_SEVERITIES = Object.freeze(['None', 'Low', 'Medium', 'High', 'Critical']);

/**
 * The impact areas an assessment is expected to cover. Not enforced by
 * the database, because an operator may have its own; offered so that
 * the common ones are not retyped differently every time.
 */
export const IMPACT_AREAS = Object.freeze([
  'Process safety',
  'Personnel safety',
  'Environment',
  'Asset integrity',
  'Operations',
  'Maintenance',
  'Training and competence',
  'Documentation',
  'Regulatory',
  'Cost and schedule',
]);

/** How far ahead an expiry starts reading "expiring soon". */
export const EXPIRY_LEAD_DAYS = 14;

export const EXPIRY = Object.freeze({
  EXPIRED: 'Expired',
  EXPIRING: 'Expiring soon',
  WITHIN: 'Within expiry',
  NONE: 'No expiry',
  NOT_APPLICABLE: 'Permanent change',
  CLOSED_OUT: 'Closed out',
});

/**
 * Where a temporary change stands against its expiry date.
 *
 * Only a change that is actually on the facility can expire. A
 * temporary change still in Review is not running anywhere, so its
 * expiry date is a plan, not a breach; one that was rejected or
 * cancelled never happened at all.
 */
export const expiryState = (moc = {}, today = new Date()) => {
  if (!EXPIRING_TYPES.includes(moc.type)) return EXPIRY.NOT_APPLICABLE;
  if (!IN_EFFECT_STAGES.includes(moc.stage)) return EXPIRY.NONE;
  // A temporary change that has been closed out was removed or made
  // permanent through its own MOC. It is no longer tracked against its
  // expiry, and it is not a permanent change either: the Register CSV
  // used to export it as one (AS13-0).
  if (moc.stage === 'Closed') return EXPIRY.CLOSED_OUT;
  if (!moc.expiry_date) return EXPIRY.NONE;
  const days = daysUntil(moc.expiry_date, today);
  // An unreadable expiry is no expiry. `null <= 14` is true in JavaScript,
  // so text like 'after turnaround' used to read "Expiring soon" (MOC-1).
  if (days === null) return EXPIRY.NONE;
  if (days < 0) return EXPIRY.EXPIRED;
  if (days <= EXPIRY_LEAD_DAYS) return EXPIRY.EXPIRING;
  return EXPIRY.WITHIN;
};

/**
 * A temporary change that is past its expiry and still in effect.
 * This is the number an MOC coordinator is judged on.
 */
export const isExpired = (moc, today = new Date()) =>
  expiryState(moc, today) === EXPIRY.EXPIRED;

/**
 * Is this change late to be implemented?
 *
 * Only BEFORE it is on the facility: a stage in ACTIVE_STAGES that is not
 * in IN_EFFECT_STAGES (Draft, Screening, Review, Approval). A change in
 * Implementation is in effect, so its target implementation date has been
 * met or passed by the fact of it; late work after that point is carried
 * by its overdue ACTIONS (`summarise().overdueActions`). Before ASC-0 the
 * test used ACTIVE_STAGES alone, so a change implemented ON its target
 * date read overdue from the next day until it closed (RC-3). The
 * dashboard's `summarise().overdue` and the `byUrgency` rank both ask this
 * function, so they follow it.
 */
export const isOverdue = (moc = {}, today = new Date()) => {
  if (!ACTIVE_STAGES.includes(moc.stage) || IN_EFFECT_STAGES.includes(moc.stage)) return false;
  const days = daysUntil(moc.target_implementation_date, today);
  return days !== null && days < 0;
};

/** Legal next stages from where a change is now. */
export const STAGE_TRANSITIONS = Object.freeze({
  Draft: Object.freeze(['Screening', 'Cancelled']),
  Screening: Object.freeze(['Review', 'Rejected', 'Cancelled', 'Draft']),
  Review: Object.freeze(['Approval', 'Rejected', 'Cancelled', 'Screening']),
  Approval: Object.freeze(['Implementation', 'Rejected', 'Cancelled', 'Review']),
  Implementation: Object.freeze(['Closed', 'Cancelled']),
  Closed: Object.freeze([]),
  Rejected: Object.freeze([]),
  Cancelled: Object.freeze([]),
});

export const nextStages = (stage) => STAGE_TRANSITIONS[stage] || [];

/**
 * Has every approval level signed?
 *
 * Every distinct `level` present must have at least one Approved row,
 * and no level may carry a Rejected one. Levels come from the data
 * rather than from a constant, because an operator decides how many
 * gates a change of a given risk needs.
 */
export const approvalState = (approvals = []) => {
  const levels = [...new Set(approvals.map((a) => a.level ?? 1))].sort((a, b) => a - b);
  const rejected = approvals.filter((a) => a.status === 'Rejected');
  const outstanding = levels.filter((lvl) => {
    const atLevel = approvals.filter((a) => (a.level ?? 1) === lvl);
    return !atLevel.some((a) => a.status === 'Approved');
  });
  return {
    levels,
    rejected,
    outstanding,
    complete: levels.length > 0 && outstanding.length === 0 && rejected.length === 0,
  };
};

/**
 * Owner decision AS15 (§3k.4 Q9, emergency-change authority). An
 * emergency change is made to stop harm now, and CCPS practice gives it
 * REDUCED authority up front with the full review after the event. So
 * an Emergency change may be implemented once its FIRST approval level
 * has signed (and nobody has rejected it); every remaining level must
 * then sign within EMERGENCY_RATIFY_DAYS of implementation, the change
 * cannot close until they have, and one that runs past the window is
 * flagged. Permanent and Temporary changes still need every level first.
 */
export const EMERGENCY_RATIFY_DAYS = 7;

export const RATIFICATION = Object.freeze({
  NOT_REQUIRED: 'Not required',
  PENDING: 'Awaiting ratification',
  OVERDUE: 'Ratification overdue',
  COMPLETE: 'Ratified',
});

const firstLevelSigned = (approvals = []) => {
  const state = approvalState(approvals);
  if (!state.levels.length || state.rejected.length) return false;
  return !state.outstanding.includes(state.levels[0]);
};

/**
 * Where an emergency change stands on its after-the-event approvals.
 * Returns `{ state, dueDate, outstanding }`. An implemented emergency
 * change with no recorded implementation date is OVERDUE: the window
 * cannot be shown to be open, so it fails closed.
 */
export const ratificationState = (moc = {}, approvals = [], today = new Date()) => {
  if (moc.type !== 'Emergency' || !IN_EFFECT_STAGES.includes(moc.stage)) {
    return { state: RATIFICATION.NOT_REQUIRED, dueDate: null, outstanding: [] };
  }
  const st = approvalState(approvals);
  if (st.complete) return { state: RATIFICATION.COMPLETE, dueDate: null, outstanding: [] };
  const went = parseDateOnly(moc.actual_implementation_date);
  const due = went
    ? new Date(went.getFullYear(), went.getMonth(), went.getDate() + EMERGENCY_RATIFY_DAYS)
    : null;
  const days = due ? daysUntil(due, today) : null;
  return {
    state: days === null || days < 0 ? RATIFICATION.OVERDUE : RATIFICATION.PENDING,
    dueDate: due ? toDateOnlyString(due) : null,
    outstanding: st.outstanding,
  };
};

/**
 * Owner decision AS15 (segregation of duties). An approval is decided by
 * the person it is assigned to, and nobody approves their own change.
 * Before this, role labels were not enforced: any member of the
 * organization could decide any level of any change, including the
 * originator approving their own. The database enforces the same rule
 * (AS15 migration). To cover an absence, reassign the approval.
 */
export const canAssignApprover = (moc = {}, approverId) => {
  if (!approverId) return { ok: false, reason: 'Choose the approver.' };
  if (approverId === moc.originator_id) {
    return { ok: false, reason: 'The originator of a change cannot approve it. Choose somebody independent of the change.' };
  }
  return { ok: true };
};

export const canDecideApproval = (approval = {}, moc = {}, userId) => {
  if (approval.status && approval.status !== 'Pending') {
    return { ok: false, reason: `This approval is already ${String(approval.status).toLowerCase()}.` };
  }
  if (!userId || userId !== approval.approver_id) {
    return { ok: false, reason: 'Only the person this approval is assigned to can decide it. If they are unavailable, reassign it.' };
  }
  if (userId === moc.originator_id) {
    return { ok: false, reason: 'The originator of a change cannot approve it.' };
  }
  return { ok: true };
};

const openActions = (actions = [], type) =>
  actions.filter((a) => a.action_type === type
    && !['Complete', 'Cancelled'].includes(a.status));

/**
 * May this change move to the stage asked for?
 *
 * Returns `{ ok, reason }`. The old app moved the stage from a button
 * that toasted "Moving to next stage..." and moved nothing, so none of
 * this was ever asked.
 */
export const canAdvance = (moc = {}, to, { approvals = [], actions = [] } = {}) => {
  if (!nextStages(moc.stage).includes(to)) {
    const allowed = nextStages(moc.stage);
    return {
      ok: false,
      reason: allowed.length
        ? `A change in ${moc.stage} can only move to ${allowed.join(', ')}.`
        : `${withArticle(String(moc.stage).toLowerCase())} change is final.`,
    };
  }

  if (to === 'Implementation') {
    const state = approvalState(approvals);
    if (state.rejected.length) {
      return { ok: false, reason: 'An approver has rejected this change. It cannot be implemented.' };
    }
    if (!state.levels.length) {
      return {
        ok: false,
        reason: 'No approvers have been assigned, so there is nothing to approve. Add the approval levels this change needs.',
      };
    }
    const emergencyReady = moc.type === 'Emergency' && firstLevelSigned(approvals);
    if (state.outstanding.length && !emergencyReady) {
      return {
        ok: false,
        reason: moc.type === 'Emergency'
          ? `An emergency change can go in once approval level ${state.levels[0]} has signed, with the rest ratified within ${EMERGENCY_RATIFY_DAYS} days. Level ${state.levels[0]} has not signed yet.`
          : `Approval level${state.outstanding.length === 1 ? '' : 's'} ${listed(state.outstanding)} ${state.outstanding.length === 1 ? 'has' : 'have'} not signed yet.`,
      };
    }
    const pre = openActions(actions, 'Pre-implementation');
    if (pre.length) {
      return {
        ok: false,
        reason: `${pre.length} pre-implementation action${pre.length === 1 ? '' : 's'} still open. They exist to be done before the change goes in.`,
      };
    }
    // A temporary change being implemented is a deviation the facility
    // will run on. It does not go in without a date to come back out.
    // A READABLE date: a temporary change does not go in without a date to
    // come back out, and 'next shutdown' is not one (MOC-1, AS12 oracle).
    if (EXPIRING_TYPES.includes(moc.type) && !parseDateOnly(moc.expiry_date)) {
      return {
        ok: false,
        reason: `${withArticle(String(moc.type).toLowerCase())} change needs an expiry date before it is implemented. Without one it is a permanent change nobody decided to make.`,
      };
    }
  }

  if (to === 'Closed') {
    const st = approvalState(approvals);
    if (moc.type === 'Emergency' && !st.complete) {
      return {
        ok: false,
        reason: st.rejected.length
          ? 'An approver has rejected this emergency change after the event. It has to be reversed or resubmitted, not closed.'
          : `Approval level${st.outstanding.length === 1 ? '' : 's'} ${listed(st.outstanding)} ${st.outstanding.length === 1 ? 'has' : 'have'} not ratified this emergency change. It cannot close until every level has signed.`,
      };
    }
    const post = openActions(actions, 'Post-implementation')
      .concat(openActions(actions, 'Implementation'));
    if (post.length) {
      return {
        ok: false,
        reason: `${post.length} implementation or post-implementation action${post.length === 1 ? '' : 's'} still open.`,
      };
    }
  }

  return { ok: true };
};

/**
 * Counts for the dashboard and reports, computed once.
 *
 * The dashboard's four tiles used to read 42, 12, 5 and 128 as
 * literals, and its stage breakdown and monthly trend were literals
 * too. `expired` is the one that was never shown at all: the page
 * carried a hardcoded warning that "MOC-2026-015 and MOC-2026-033
 * expire in less than 7 days", naming two changes that do not exist.
 */
export const summarise = (records = [], { actions = [], approvals = [] } = {}, today = new Date()) => {
  // AS14: an action belongs to a change. Once that change is closed,
  // rejected or cancelled its record is locked, so an action left
  // unfinished on it is not open work anybody can do. Counting it kept
  // "open actions" and "overdue actions" high for ever on a dashboard
  // whose changes were all finished. An action whose change is not in
  // `records` still counts: not knowing the parent is not a reason to
  // hide the work.
  const finished = new Set(records
    .filter((m) => TERMINAL_STAGES.includes(m.stage))
    .map((m) => m.id)
    .filter((id) => id !== undefined && id !== null));
  const liveActions = actions.filter((a) => !finished.has(a.moc_id));

  // A record with no id owns no approvals: without the guard it matched
  // every approval that has no moc_id (undefined === undefined).
  const approvalsOf = (m) => (m.id === undefined || m.id === null
    ? [] : approvals.filter((a) => a.moc_id === m.id));

  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const byRisk = Object.fromEntries(RISK_LEVELS.map((r) => [r, 0]));
  records.forEach((m) => {
    if (byStage[m.stage] !== undefined) byStage[m.stage] += 1;
    if (byRisk[m.risk_level] !== undefined) byRisk[m.risk_level] += 1;
  });

  return {
    total: records.length,
    byStage,
    byRisk,
    active: records.filter((m) => ACTIVE_STAGES.includes(m.stage)).length,
    awaitingApproval: byStage.Approval,
    expired: records.filter((m) => isExpired(m, today)).length,
    expiringSoon: records.filter((m) => expiryState(m, today) === EXPIRY.EXPIRING).length,
    overdue: records.filter((m) => isOverdue(m, today)).length,
    openActions: liveActions.filter((a) => !['Complete', 'Cancelled'].includes(a.status)).length,
    // AS15: emergency changes in effect that still lack approvals.
    ratificationPending: records.filter((m) => ratificationState(
      m, approvalsOf(m), today).state === RATIFICATION.PENDING).length,
    ratificationOverdue: records.filter((m) => ratificationState(
      m, approvalsOf(m), today).state === RATIFICATION.OVERDUE).length,
    overdueActions: liveActions.filter((a) => {
      if (['Complete', 'Cancelled'].includes(a.status)) return false;
      const d = daysUntil(a.due_date, today);
      return d !== null && d < 0;
    }).length,
  };
};

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

/**
 * Sort: expired temporary changes first, then expiring soon, then
 * overdue (late to be implemented, `isOverdue`, so never a change already
 * in Implementation), then live work, then everything finished. An expired temporary change outranks
 * everything because it is the one that is actually on the facility
 * without authority.
 */
export const byUrgency = (today = new Date()) => (a, b) => {
  const rank = (m) => {
    if (isExpired(m, today)) return 0;
    if (expiryState(m, today) === EXPIRY.EXPIRING) return 1;
    if (isOverdue(m, today)) return 2;
    if (ACTIVE_STAGES.includes(m.stage)) return 3;
    return 4;
  };
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  const da = parseDateOnly(a.expiry_date || a.target_implementation_date);
  const db = parseDateOnly(b.expiry_date || b.target_implementation_date);
  if (da && db) return da - db;
  if (da) return -1;
  if (db) return 1;
  return 0;
};
