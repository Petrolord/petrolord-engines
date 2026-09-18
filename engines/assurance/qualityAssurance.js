/**
 * The one Quality Assurance authority for the Assurance module.
 *
 * AS7, after riskScoring (AS2), complianceStatus (AS3),
 * documentControl (AS4), peerReview (AS5) and managementOfChange (AS6).
 *
 * Like MOC, this app had no logic to consolidate, because it had no
 * data: six plans, two checkpoints, two NCRs and two corrective
 * actions, all written out by hand in `src/data/qa-plan/`. The
 * corrective actions file was imported by no page at all, so corrective
 * action — the half of the discipline that closes the loop — was absent
 * from the interface entirely.
 *
 * Four rules, and the first is the one that makes an inspection and
 * test plan a control rather than a document:
 *
 *   A HOLD POINT STOPS WORK. A witness point does not. Both appear as
 *   rows in an ITP and they mean different things: a hold point may not
 *   be passed until the verifying party attends and signs, while a
 *   witness point is a notification, and work may proceed if the party
 *   does not attend. Everything about whether a plan is complete turns
 *   on that distinction, so it is stated once, here.
 *
 *   PROGRESS IS COUNTED, NOT TYPED. The old register showed a progress
 *   bar per plan, at 45%, 10%, 78%, 90%, 30% and 100%, each one a
 *   number somebody wrote into a data file. There is no progress
 *   column in the AS7 schema. Completion is the resolved fraction of
 *   the checkpoints, weighted by nothing, because an ITP item is an
 *   ITP item.
 *
 *   AN NCR CLOSES WHEN ITS ACTIONS ARE DONE AND, FOR THE SERIOUS ONES,
 *   WHEN ONE OF THEM HAS BEEN SHOWN TO WORK. A completed corrective
 *   action is not a working corrective action. For a critical or major
 *   non-conformance the effectiveness check is the difference between
 *   closing a finding and fixing a problem; for a minor one or an
 *   observation it is disproportionate, and this module says so rather
 *   than pretending otherwise.
 *
 *   A PLAN CLOSES WHEN ITS HOLD POINTS ARE RESOLVED AND NOTHING IT
 *   RAISED IS STILL OPEN. Closing a quality plan over an open major
 *   NCR is the paperwork equivalent of shipping the part.
 */

import {
  MS_PER_DAY,
  startOfDay,
  daysUntil,
  parseDateOnly,
  toDateOnlyString,
} from './calendar.js';

export { daysUntil, parseDateOnly, toDateOnlyString };

/* ------------------------------------------------------------------ */
/* Vocabularies. Every one of these is a database check constraint in  */
/* migration 20260917500000, and every gate below compares against    */
/* one of them, so a typo would silently drop a record out of a count. */
/* ------------------------------------------------------------------ */

export const PLAN_STATUSES = Object.freeze([
  'Draft', 'Under review', 'Active', 'Superseded', 'Closed', 'Cancelled',
]);

/** Statuses in which the plan is still governing work. */
export const PLAN_LIVE_STATUSES = Object.freeze(['Draft', 'Under review', 'Active']);
export const PLAN_TERMINAL_STATUSES = Object.freeze(['Superseded', 'Closed', 'Cancelled']);

export const POINT_TYPES = Object.freeze([
  'Hold point', 'Witness point', 'Review point', 'Monitor point', 'Surveillance point',
]);

/**
 * The one intervention type that stops work.
 *
 * A hold point may not be passed until the verifying party attends and
 * signs. Everything else in an ITP is notification or oversight: the
 * party is told, may attend, and work continues if it does not. An app
 * that treats all five the same has a checklist, not a plan.
 */
export const BLOCKING_POINT_TYPES = Object.freeze(['Hold point']);

export const CHECKPOINT_STATUSES = Object.freeze([
  'Pending', 'Notified', 'In progress', 'Passed', 'Failed', 'Waived', 'Not applicable',
]);

/** Statuses that are a decision, and so require a date and a verifier. */
export const CHECKPOINT_DECIDED_STATUSES = Object.freeze(['Passed', 'Failed', 'Waived']);

/**
 * Statuses that take a checkpoint off the outstanding list.
 *
 * `Failed` is deliberately not here. A failed inspection is the most
 * outstanding thing on a plan: it is what raises the NCR.
 */
export const CHECKPOINT_RESOLVED_STATUSES = Object.freeze([
  'Passed', 'Waived', 'Not applicable',
]);

export const RESPONSIBLE_PARTIES = Object.freeze([
  'Company', 'Contractor', 'Vendor', 'Third party', 'Certifying authority',
]);

export const NCR_SEVERITIES = Object.freeze(['Critical', 'Major', 'Minor', 'Observation']);

/**
 * Severities for which a completed corrective action is not enough, and
 * an effectiveness check is required before closure.
 *
 * The same shape as AS5's rule that a review cannot close over an
 * unresolved Critical or Major comment while Minor and Editorial do not
 * block. Proportionality is part of the rule, not an exception to it.
 */
export const NCR_EFFECTIVENESS_REQUIRED = Object.freeze(['Critical', 'Major']);

export const NCR_STATUSES = Object.freeze([
  'Open', 'Under investigation', 'Disposition agreed', 'Actions in progress',
  'Verification', 'Closed', 'Voided',
]);

/** Statuses in which the non-conformance is still live. */
export const NCR_OPEN_STATUSES = Object.freeze([
  'Open', 'Under investigation', 'Disposition agreed', 'Actions in progress', 'Verification',
]);

export const NCR_TERMINAL_STATUSES = Object.freeze(['Closed', 'Voided']);

/**
 * The dispositions a non-conformance can be given. This is the actual
 * quality vocabulary: what happens to the non-conforming item.
 */
export const DISPOSITIONS = Object.freeze([
  'Use as is', 'Repair', 'Rework', 'Regrade', 'Reject', 'Return to supplier', 'Scrap',
]);

/**
 * Dispositions that accept the item as it stands. These are the ones a
 * quality manager is asked about at an audit, because each is a
 * documented decision to live with a departure from specification.
 */
export const CONCESSION_DISPOSITIONS = Object.freeze(['Use as is', 'Regrade']);

export const ROOT_CAUSE_CATEGORIES = Object.freeze([
  'Procedure or documentation',
  'Human factors or competence',
  'Design',
  'Material or equipment',
  'Supplier or subcontractor',
  'Planning or scheduling',
  'Communication',
  'Measurement or inspection',
  'Other',
]);

export const CAPA_TYPES = Object.freeze(['Corrective', 'Preventive']);
export const CAPA_STATUSES = Object.freeze(['Open', 'In progress', 'Complete', 'Cancelled']);
export const CAPA_CLOSED_STATUSES = Object.freeze(['Complete', 'Cancelled']);

/** How far ahead a due date starts reading "due soon". */
export const DUE_LEAD_DAYS = 14;

/* ------------------------------------------------------------------ */
/* Dates. Calendar dates parse at LOCAL midnight: new Date('2026-09-17')*/
/* is UTC midnight, which is 16 September anywhere west of Greenwich,  */
/* and an off-by-one day on an overdue NCR is a real wrong answer.     */
/* (The AS3 gotcha, kept.)                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Checkpoints: the inspection and test plan                          */
/* ------------------------------------------------------------------ */

export const isBlockingPoint = (checkpoint = {}) =>
  BLOCKING_POINT_TYPES.includes(checkpoint.point_type);

export const isResolved = (checkpoint = {}) =>
  CHECKPOINT_RESOLVED_STATUSES.includes(checkpoint.status);

export const isDecided = (checkpoint = {}) =>
  CHECKPOINT_DECIDED_STATUSES.includes(checkpoint.status);

/**
 * Has this checkpoint's decision actually been recorded?
 *
 * Mirrors the database constraint so the form can name the missing
 * field instead of showing the user a constraint name.
 */
export const hasVerificationRecord = (checkpoint = {}) =>
  Boolean(checkpoint.result_date)
  && Boolean(checkpoint.verified_by || String(checkpoint.verifier_name || '').trim());

/**
 * Whether a checkpoint may be moved to `status`, and why not.
 *
 * The old app had no such question: "Add Checkpoint" toasted "Add
 * checkpoint dialog..." and there was no way to change a checkpoint's
 * status at all, because there were no checkpoints.
 */
export const canDecideCheckpoint = (checkpoint = {}, status, patch = {}) => {
  if (!CHECKPOINT_STATUSES.includes(status)) {
    return { ok: false, reason: `${status} is not a checkpoint status.` };
  }
  const next = { ...checkpoint, ...patch, status };
  if (CHECKPOINT_DECIDED_STATUSES.includes(status) && !hasVerificationRecord(next)) {
    return {
      ok: false,
      reason: isBlockingPoint(next)
        ? 'A hold point needs the date it was verified and who verified it. Without those it has not been held.'
        : 'Record the date this was decided and who decided it.',
    };
  }
  // A HOLD point cannot be set aside more quietly than it can be waived.
  // "Not applicable" clears a hold point for plan closure exactly as a
  // waiver does, so it carries the same record: who, when and why
  // (AS13-0; it needed nothing at all before). Other point types may
  // still be marked not applicable freely.
  if (status === 'Not applicable' && isBlockingPoint(next)) {
    if (!hasVerificationRecord(next)) {
      return {
        ok: false,
        reason: 'Setting a hold point aside needs the date and who decided it, the same record a waiver needs.',
      };
    }
    if (!String(next.remarks || '').trim()) {
      return {
        ok: false,
        reason: 'Say why this hold point does not apply. It stops work until released, so setting it aside needs a reason on the record.',
      };
    }
  }
  if (status === 'Waived' && !String(next.remarks || '').trim()) {
    return {
      ok: false,
      reason: 'Say why this point is being waived. A waiver is a deliberate acceptance of less assurance, and the reason is what makes it auditable later.',
    };
  }
  return { ok: true };
};

export const isCheckpointOverdue = (checkpoint = {}, today = new Date()) => {
  if (isResolved(checkpoint)) return false;
  const days = daysUntil(checkpoint.planned_date, today);
  return days !== null && days < 0;
};

/**
 * How far through its inspection and test plan a plan is.
 *
 * Counted from the checkpoints. The register used to show a progress
 * bar driven by a `progress` field that somebody typed: 45, 10, 78, 90,
 * 30, 100. There is no such column in the AS7 schema on purpose.
 *
 * `percent` is null, not zero, for a plan with no checkpoints. A plan
 * with nothing in its ITP is not 0% complete; it has no ITP, and the
 * register says so instead of drawing an empty bar.
 */
export const planProgress = (checkpoints = []) => {
  const total = checkpoints.length;
  const resolved = checkpoints.filter(isResolved).length;
  const failed = checkpoints.filter((c) => c.status === 'Failed').length;
  const blocking = checkpoints.filter(isBlockingPoint);
  const blockingOutstanding = blocking.filter((c) => !isResolved(c));
  return {
    total,
    resolved,
    failed,
    outstanding: total - resolved,
    holdPoints: blocking.length,
    holdPointsOutstanding: blockingOutstanding.length,
    percent: total === 0 ? null : Math.round((resolved / total) * 100),
  };
};

/* ------------------------------------------------------------------ */
/* Non-conformance reports                                            */
/* ------------------------------------------------------------------ */

export const isNcrOpen = (ncr = {}) => NCR_OPEN_STATUSES.includes(ncr.status);

export const isNcrOverdue = (ncr = {}, today = new Date()) => {
  if (!isNcrOpen(ncr)) return false;
  const days = daysUntil(ncr.due_date, today);
  return days !== null && days < 0;
};

/** How long an open non-conformance has been open. The ageing number. */
export const ncrAgeDays = (ncr = {}, today = new Date()) => {
  const raised = parseDateOnly(ncr.raised_date || ncr.created_at);
  if (!raised) return null;
  const end = isNcrOpen(ncr) ? startOfDay(today) : (parseDateOnly(ncr.closed_date) || startOfDay(today));
  return Math.round((end - raised) / MS_PER_DAY);
};

export const AGE_BANDS = Object.freeze([
  { label: '0 to 30 days', min: 0, max: 30 },
  { label: '31 to 60 days', min: 31, max: 60 },
  { label: '61 to 90 days', min: 61, max: 90 },
  { label: 'Over 90 days', min: 91, max: Infinity },
]);

export const ageBand = (days) => {
  if (days === null || days === undefined) return null;
  const band = AGE_BANDS.find((b) => days >= b.min && days <= b.max);
  return band ? band.label : null;
};

export const isCapaOpen = (capa = {}) => !CAPA_CLOSED_STATUSES.includes(capa.status);

export const isCapaOverdue = (capa = {}, today = new Date()) => {
  if (!isCapaOpen(capa)) return false;
  const days = daysUntil(capa.due_date, today);
  return days !== null && days < 0;
};

/**
 * A corrective action that was verified to have worked.
 *
 * `effectiveness_verified === false` is a real answer, not a missing
 * one: it says somebody looked and the action did not fix the problem.
 * That is the trigger to go round again, and it must not count towards
 * closing the NCR.
 */
export const isEffectivenessVerified = (capa = {}) =>
  capa.effectiveness_verified === true
  && Boolean(capa.effectiveness_checked_at)
  && Boolean(capa.effectiveness_verified_by);

export const isEffectivenessFailed = (capa = {}) => capa.effectiveness_verified === false;

/**
 * May this non-conformance be closed?
 *
 * Returns `{ ok, reason }`. The reasons are written for the person
 * holding the NCR open, not for a developer.
 *
 * This is AS7's `canClose`, on the AS5 precedent, and the same
 * proportionality applies: the effectiveness check is required for a
 * critical or major non-conformance and not for a minor one or an
 * observation.
 */
export const canCloseNcr = (ncr = {}, capas = []) => {
  if (NCR_TERMINAL_STATUSES.includes(ncr.status)) {
    return { ok: false, reason: `This non-conformance is already ${String(ncr.status).toLowerCase()}.` };
  }
  if (!ncr.disposition) {
    return {
      ok: false,
      reason: 'Agree the disposition first: what happens to the non-conforming item. Use as is, repair, rework, regrade, reject, return to supplier or scrap.',
    };
  }
  if (!ncr.disposition_date) {
    return { ok: false, reason: 'Record the date the disposition was agreed.' };
  }
  if (NCR_EFFECTIVENESS_REQUIRED.includes(ncr.severity)
      && !String(ncr.root_cause || '').trim()) {
    return {
      ok: false,
      reason: `A ${String(ncr.severity).toLowerCase()} non-conformance needs a root cause before it closes. Closing one without it is how the same non-conformance arrives again next quarter.`,
    };
  }

  const open = capas.filter(isCapaOpen);
  if (open.length) {
    return {
      ok: false,
      reason: `${open.length} corrective or preventive action${open.length === 1 ? '' : 's'} still open.`,
    };
  }

  if (NCR_EFFECTIVENESS_REQUIRED.includes(ncr.severity)) {
    const corrective = capas.filter((c) => c.action_type === 'Corrective'
      && c.status !== 'Cancelled');
    if (!corrective.length) {
      return {
        ok: false,
        reason: `A ${String(ncr.severity).toLowerCase()} non-conformance needs at least one corrective action. A disposition deals with the item; a corrective action deals with the cause.`,
      };
    }
    if (corrective.some(isEffectivenessFailed) && !corrective.some(isEffectivenessVerified)) {
      return {
        ok: false,
        reason: 'A corrective action here was checked and found not to have worked. Raise another one rather than closing over it.',
      };
    }
    if (!corrective.some(isEffectivenessVerified)) {
      return {
        ok: false,
        reason: 'No corrective action has been verified effective yet. A completed action is not a working one, and for a non-conformance this serious the check is the point.',
      };
    }
  }

  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Quality plans                                                      */
/* ------------------------------------------------------------------ */

/**
 * May this plan be closed?
 *
 * An unresolved HOLD point blocks; an unresolved witness, review,
 * monitor or surveillance point does not, because work was never
 * waiting on it. A failed checkpoint blocks whatever its type: a failed
 * inspection is the reason the NCR exists.
 *
 * An open non-conformance raised against the plan blocks too. Closing a
 * quality plan over an open major NCR is the paperwork equivalent of
 * shipping the part.
 */
export const canClosePlan = (plan = {}, { checkpoints = [], ncrs = [] } = {}) => {
  if (PLAN_TERMINAL_STATUSES.includes(plan.status)) {
    return { ok: false, reason: `This plan is already ${String(plan.status).toLowerCase()}.` };
  }

  const failed = checkpoints.filter((c) => c.status === 'Failed');
  if (failed.length) {
    return {
      ok: false,
      reason: `${failed.length} checkpoint${failed.length === 1 ? ' has' : 's have'} failed and ${failed.length === 1 ? 'has' : 'have'} not been resolved. A failed inspection is the most outstanding item on a plan.`,
    };
  }

  const heldOpen = checkpoints.filter((c) => isBlockingPoint(c) && !isResolved(c));
  if (heldOpen.length) {
    return {
      ok: false,
      reason: `${heldOpen.length} hold point${heldOpen.length === 1 ? '' : 's'} still outstanding (${heldOpen.map((c) => c.item_no).filter(Boolean).join(', ') || 'unnumbered'}). A hold point stops work until it is verified, so the plan cannot be finished over one.`,
    };
  }

  const openNcrs = ncrs.filter(isNcrOpen);
  if (openNcrs.length) {
    return {
      ok: false,
      reason: `${openNcrs.length} non-conformance${openNcrs.length === 1 ? '' : 's'} raised against this plan ${openNcrs.length === 1 ? 'is' : 'are'} still open.`,
    };
  }

  return { ok: true };
};

/** Legal next statuses from where a plan is now. */
export const PLAN_TRANSITIONS = Object.freeze({
  Draft: Object.freeze(['Under review', 'Active', 'Cancelled']),
  'Under review': Object.freeze(['Active', 'Draft', 'Cancelled']),
  Active: Object.freeze(['Closed', 'Superseded', 'Cancelled']),
  Superseded: Object.freeze([]),
  Closed: Object.freeze([]),
  Cancelled: Object.freeze([]),
});

export const nextPlanStatuses = (status) => PLAN_TRANSITIONS[status] || [];

export const canAdvancePlan = (plan = {}, to, context = {}) => {
  const allowed = nextPlanStatuses(plan.status);
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: allowed.length
        ? `A plan that is ${String(plan.status).toLowerCase()} can only move to ${allowed.join(', ')}.`
        : `A ${String(plan.status).toLowerCase()} plan is final.`,
    };
  }
  if (to === 'Closed') return canClosePlan(plan, context);
  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Counts for the dashboard and the reports                           */
/* ------------------------------------------------------------------ */

/**
 * Every number on the old dashboard was either a filter over the
 * invented plans or, for "Pending Checks", the literal 12.
 */
export const summarise = (
  { plans = [], checkpoints = [], ncrs = [], capas = [] } = {},
  today = new Date(),
) => {
  const byPlanStatus = Object.fromEntries(PLAN_STATUSES.map((s) => [s, 0]));
  plans.forEach((p) => {
    if (byPlanStatus[p.status] !== undefined) byPlanStatus[p.status] += 1;
  });

  const bySeverity = Object.fromEntries(NCR_SEVERITIES.map((s) => [s, 0]));
  const openBySeverity = Object.fromEntries(NCR_SEVERITIES.map((s) => [s, 0]));
  ncrs.forEach((n) => {
    if (bySeverity[n.severity] !== undefined) bySeverity[n.severity] += 1;
    if (isNcrOpen(n) && openBySeverity[n.severity] !== undefined) openBySeverity[n.severity] += 1;
  });

  const openNcrs = ncrs.filter(isNcrOpen);
  const ages = openNcrs.map((n) => ncrAgeDays(n, today)).filter((d) => d !== null);

  return {
    plans: plans.length,
    activePlans: byPlanStatus.Active,
    livePlans: plans.filter((p) => PLAN_LIVE_STATUSES.includes(p.status)).length,
    byPlanStatus,

    checkpoints: checkpoints.length,
    // The literal 12 this replaces.
    checkpointsOutstanding: checkpoints.filter((c) => !isResolved(c)).length,
    checkpointsOverdue: checkpoints.filter((c) => isCheckpointOverdue(c, today)).length,
    holdPointsOutstanding: checkpoints.filter(
      (c) => isBlockingPoint(c) && !isResolved(c)).length,
    checkpointsFailed: checkpoints.filter((c) => c.status === 'Failed').length,

    ncrs: ncrs.length,
    openNcrs: openNcrs.length,
    bySeverity,
    openBySeverity,
    ncrsOverdue: ncrs.filter((n) => isNcrOverdue(n, today)).length,
    // Closing a plan over one of these is what canClosePlan refuses.
    seriousOpen: openNcrs.filter(
      (n) => NCR_EFFECTIVENESS_REQUIRED.includes(n.severity)).length,
    concessions: ncrs.filter((n) => CONCESSION_DISPOSITIONS.includes(n.disposition)).length,
    oldestOpenNcrDays: ages.length ? Math.max(...ages) : null,
    meanOpenNcrAgeDays: ages.length
      ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null,

    capas: capas.length,
    openCapas: capas.filter(isCapaOpen).length,
    overdueCapas: capas.filter((c) => isCapaOverdue(c, today)).length,
    // The number that says whether corrective action is working: done,
    // and nobody has been back to see whether it worked.
    capasAwaitingEffectiveness: capas.filter(
      (c) => c.status === 'Complete'
        && c.effectiveness_verified !== true
        && c.effectiveness_verified !== false).length,
    capasVerifiedEffective: capas.filter(isEffectivenessVerified).length,
    capasFoundIneffective: capas.filter(isEffectivenessFailed).length,
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

export const ncrAgeing = (ncrs = [], today = new Date()) => {
  const open = ncrs.filter(isNcrOpen);
  return AGE_BANDS.map((band) => {
    const row = { name: band.label };
    NCR_SEVERITIES.forEach((s) => { row[s] = 0; });
    open.forEach((n) => {
      const days = ncrAgeDays(n, today);
      if (days === null) return;
      if (days >= band.min && days <= band.max && row[n.severity] !== undefined) {
        row[n.severity] += 1;
      }
    });
    return row;
  });
};

/**
 * Sort: failed checkpoints and overdue serious non-conformances first.
 */
export const ncrByUrgency = (today = new Date()) => (a, b) => {
  const rank = (n) => {
    if (isNcrOpen(n) && isNcrOverdue(n, today)
        && NCR_EFFECTIVENESS_REQUIRED.includes(n.severity)) return 0;
    if (isNcrOpen(n) && NCR_EFFECTIVENESS_REQUIRED.includes(n.severity)) return 1;
    if (isNcrOpen(n) && isNcrOverdue(n, today)) return 2;
    if (isNcrOpen(n)) return 3;
    return 4;
  };
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  const da = parseDateOnly(a.due_date || a.raised_date);
  const db = parseDateOnly(b.due_date || b.raised_date);
  if (da && db) return da - db;
  if (da) return -1;
  if (db) return 1;
  return 0;
};
