/**
 * The one Audit & Findings authority for the Assurance module.
 *
 * AS10, after riskScoring (AS2), complianceStatus (AS3),
 * documentControl (AS4), peerReview (AS5), managementOfChange (AS6),
 * qualityAssurance (AS7), isoCompliance (AS8) and lessonsLearned
 * (AS9).
 *
 * This one is not a rebuild. The two tiles it replaces —
 * `safety-audit-manager` and `audit-trail-manager` — were Active and
 * sellable with NO CODE OF ANY KIND behind either of them, and AS1
 * archived both with a note that they would be rebuilt together here.
 *
 * WHAT IS SHARED, AND WHY IT IS IMPORTED RATHER THAN COPIED. An audit
 * here is executed against a CHECKLIST; an AS8 audit is executed
 * against the clauses of a management system standard. Those two are
 * genuinely different objects and have their own tables. But a
 * finding is a finding: `audit_findings` and `audit_actions` carry the
 * same columns and the same vocabularies as `iso_findings` and
 * `iso_actions` on purpose, so this module imports AS8's
 * `canCloseFinding` and, through it, AS7's effectiveness rules.
 * Assurance-ROADMAP.md §6: one authority per concept, and the two
 * places that both know when a finding may close is exactly the defect
 * that rule exists to prevent.
 *
 * Five rules of its own:
 *
 *   AN AUDIT IS NOT REPORTED WITH HALF ITS CHECKLIST BLANK, and "not
 *   applicable" is an answer that carries a reason. A 120-item
 *   protocol returned with 40 items untouched, reported as "no
 *   findings", is the failure this app exists to prevent.
 *
 *   A NONCONFORMANT ANSWER ON A CRITICAL ITEM MUST RAISE A FINDING.
 *   That link is what makes a checklist a control rather than a form.
 *
 *   A STOP-WORK FINDING RECORDS WHAT WAS DONE ABOUT IT IMMEDIATELY.
 *   Imminent danger does not wait for the corrective action cycle.
 *
 *   AN AUDITOR MAY NOT AUDIT THEIR OWN AREA. The module's fourth
 *   independence rule, after AS5's reviewer, AS8's ISO 19011 auditor
 *   and AS9's lesson author.
 *
 *   A PROGRAMME IS COMPLETE WHEN ITS AUDITS ARE, NOT WHEN THE YEAR
 *   ENDS. An annual programme marked complete over four audits that
 *   never happened is the document a certification body asks for.
 */

import {
  AUDIT_STATUSES,
  AUDIT_TERMINAL_STATUSES,
  COVERAGE_RESULTS,
  FINDING_OPEN_STATUSES,
  FINDING_STATUSES,
  FINDING_TYPES,
  ACTION_STATUSES,
  ACTION_TYPES,
  EFFECTIVENESS_REQUIRED_TYPES,
  NONCONFORMITY_TYPES,
  ROOT_CAUSE_CATEGORIES,
  canCloseFinding,
  findingAgeDays,
  findingByUrgency,
  isActionOpen,
  isActionOverdue,
  isEffectivenessFailed,
  isEffectivenessVerified,
  isFindingOpen,
  isFindingOverdue,
  isNonconformity,
  daysUntil,
  parseDateOnly,
  toDateOnlyString,
} from './isoCompliance.js';

/* ------------------------------------------------------------------ */
/* Shared with AS8, re-exported so this app's pages have one import.   */
/* ------------------------------------------------------------------ */

// ASC-0 (RC-9): an article that agrees with the word it introduces. The
// refusal was written 'A ${word}', which printed "A archived lesson" and
// "A emergency change".
const withArticle = (word) => `${/^[aeiou]/i.test(word) ? 'An' : 'A'} ${word}`;

/**
 * ASC-0 (R2): a whole percent, round half UP on the EXACT rational n/d
 * (n, d whole counts, n >= 0, d > 0). floor((200n + d) / 2d) is
 * floor(100n/d + 1/2), computed from integers. It replaces
 * Math.round((n / d) * 100), which rounds the binary float of n/d: 57 of
 * 200 is 0.285, stored as 0.28499999..., and printed 28 where the exact
 * half rounds to 29 (23 of 40 printed 57 for 58). Exact while d < 2^45:
 * the true quotient is at least 1/(2d) below the next whole number, far
 * more than the float division's error.
 */
const halfUpPercent = (n, d) => Math.floor((200 * n + d) / (2 * d));

export {
  ACTION_STATUSES,
  ACTION_TYPES,
  AUDIT_STATUSES,
  AUDIT_TERMINAL_STATUSES,
  EFFECTIVENESS_REQUIRED_TYPES,
  FINDING_OPEN_STATUSES,
  FINDING_STATUSES,
  FINDING_TYPES,
  NONCONFORMITY_TYPES,
  ROOT_CAUSE_CATEGORIES,
  canCloseFinding,
  daysUntil,
  findingAgeDays,
  findingByUrgency,
  isActionOpen,
  isActionOverdue,
  isEffectivenessFailed,
  isEffectivenessVerified,
  isFindingOpen,
  isFindingOverdue,
  isNonconformity,
  parseDateOnly,
  toDateOnlyString,
};

/* ------------------------------------------------------------------ */
/* This app's own vocabularies. Each is a check constraint in          */
/* migration 20260917800000.                                          */
/* ------------------------------------------------------------------ */

export const PROGRAMME_STATUSES = Object.freeze([
  'Draft', 'Approved', 'In progress', 'Complete', 'Cancelled',
]);

export const AUDIT_TYPES = Object.freeze([
  'Safety', 'Environmental', 'Contractor', 'Supplier', 'Process',
  'Operational', 'Permit to work', 'Management system', 'Other',
]);

export const TEMPLATE_STATUSES = Object.freeze(['Draft', 'Active', 'Retired']);

/**
 * How much a checklist question matters.
 *
 * `Critical` is not decoration: a critical question answered
 * Nonconformant must raise a finding before the audit can be reported.
 */
export const CRITICALITIES = Object.freeze(['Critical', 'Major', 'Minor']);

/** The same five results AS8 records against a clause. */
export const RESPONSE_RESULTS = COVERAGE_RESULTS;

export const ANSWERED_RESULTS = Object.freeze([
  'Conformant', 'Nonconformant', 'Observation', 'Not applicable',
]);

/** The finding type a critical nonconformance defaults to. */
export const DEFAULT_FINDING_TYPE_BY_CRITICALITY = Object.freeze({
  Critical: 'Major nonconformity',
  Major: 'Major nonconformity',
  Minor: 'Minor nonconformity',
});

/* ------------------------------------------------------------------ */
/* Checklist execution                                                */
/* ------------------------------------------------------------------ */

/**
 * Owner decision AS15 (§3k.4 Q11): the engine no longer trusts the
 * stored row. "Not applicable" without a reason is not an answer, the
 * same rule the database constraint and the form enforce at write time,
 * so a row that reached the table by any other route cannot report an
 * audit.
 */
export const isAnswered = (response = {}) => ANSWERED_RESULTS.includes(response.result)
  && (response.result !== 'Not applicable' || Boolean(String(response.note || '').trim()));

/**
 * How far through its checklist an audit is.
 *
 * `percent` is null, not zero, for an audit with no checklist at all:
 * an ad-hoc walkdown with no protocol is not 0% complete, it has no
 * protocol. The AS7 precedent, where a plan with no ITP says so rather
 * than drawing an empty bar.
 */
export const checklistProgress = (items = [], responses = []) => {
  const total = items.length;
  const byItem = new Map(responses.map((r) => [r.item_id, r]));
  const answered = items.filter((i) => isAnswered(byItem.get(i.id) || {})).length;
  const count = (result) => items.filter((i) => (byItem.get(i.id) || {}).result === result).length;
  return {
    total,
    answered,
    outstanding: total - answered,
    conformant: count('Conformant'),
    nonconformant: count('Nonconformant'),
    observations: count('Observation'),
    notApplicable: count('Not applicable'),
    percent: total === 0 ? null : halfUpPercent(answered, total),
  };
};

/** The items of the protocol that nobody has answered, named. */
export const unansweredItems = (items = [], responses = []) => {
  const byItem = new Map(responses.map((r) => [r.item_id, r]));
  return items.filter((i) => !isAnswered(byItem.get(i.id) || {}));
};

/**
 * Critical questions answered Nonconformant with no finding raised.
 *
 * Returns the items, so the page can name them rather than counting
 * them. A voided finding does not satisfy the rule: voiding one is how
 * an auditor says it should never have been raised.
 */
export const criticalAnswersWithoutFindings = (items = [], responses = [], findings = []) => {
  const byItem = new Map(items.map((i) => [i.id, i]));
  const covered = new Set(
    findings.filter((f) => f.status !== 'Voided' && f.response_id).map((f) => f.response_id));
  return responses
    .filter((r) => r.result === 'Nonconformant'
      && (byItem.get(r.item_id) || {}).criticality === 'Critical'
      && !covered.has(r.id))
    .map((r) => byItem.get(r.item_id))
    .filter(Boolean);
};

/* ------------------------------------------------------------------ */
/* Independence                                                       */
/* ------------------------------------------------------------------ */

/**
 * The lead auditor may not be the auditee.
 *
 * An external lead auditor — named in text, with no Suite account — is
 * independent by construction and is never blocked, as in AS8 and AS9.
 */
export const auditIndependence = (audit = {}) => {
  if (!audit.lead_auditor_id || !audit.auditee_id) return { ok: true };
  if (audit.lead_auditor_id !== audit.auditee_id) return { ok: true };
  return {
    ok: false,
    reason: 'The lead auditor is also the auditee for this audit. An auditor may not audit their own area: name somebody else as one or the other.',
  };
};

/* ------------------------------------------------------------------ */
/* The audit lifecycle                                                */
/* ------------------------------------------------------------------ */

export const canReportAudit = (audit = {}, { items = [], responses = [], findings = [] } = {}) => {
  if (AUDIT_TERMINAL_STATUSES.includes(audit.status)) {
    return { ok: false, reason: `This audit is already ${String(audit.status).toLowerCase()}.` };
  }

  if (audit.template_id) {
    const outstanding = unansweredItems(items, responses);
    if (outstanding.length) {
      const refs = outstanding.map((i) => i.item_no).filter(Boolean);
      return {
        ok: false,
        reason: `${outstanding.length} checklist item${outstanding.length === 1 ? '' : 's'} ${outstanding.length === 1 ? 'has' : 'have'} no answer yet${refs.length ? ` (${refs.slice(0, 8).join(', ')}${refs.length > 8 ? ', and more' : ''})` : ''}. An audit reported with its checklist half blank says nothing about the items nobody looked at.`,
      };
    }
  }

  const uncovered = criticalAnswersWithoutFindings(items, responses, findings);
  if (uncovered.length) {
    const refs = uncovered.map((i) => i.item_no).filter(Boolean);
    return {
      ok: false,
      reason: `Critical item${uncovered.length === 1 ? '' : 's'} ${refs.join(', ')} ${uncovered.length === 1 ? 'was' : 'were'} answered Nonconformant with no finding raised. A critical question that fails needs a finding with a number, an owner and a due date.`,
    };
  }

  if (!String(audit.conclusion || '').trim()) {
    return { ok: false, reason: 'Write the audit conclusion. It is the deliverable.' };
  }
  if (!audit.lead_auditor_id && !String(audit.lead_auditor_name || '').trim()) {
    return { ok: false, reason: 'Name the lead auditor.' };
  }
  return { ok: true };
};

/**
 * May this audit be closed?
 *
 * The AS8 rule, unchanged and deliberately: not while a major
 * nonconformity it raised is still open, and not before it has been
 * reported. Stated here rather than imported because AS8's version
 * keys off its own status vocabulary — which is the same vocabulary,
 * so the two stay in step by the test that asserts it.
 */
export const canCloseAudit = (audit = {}, findings = []) => {
  if (AUDIT_TERMINAL_STATUSES.includes(audit.status)) {
    return { ok: false, reason: `This audit is already ${String(audit.status).toLowerCase()}.` };
  }
  if (audit.status !== 'Reported') {
    return {
      ok: false,
      reason: 'Report the audit before closing it: the report is the deliverable, and closure is the statement that everything it raised has been dealt with.',
    };
  }
  const openMajor = findings.filter(
    (f) => isFindingOpen(f) && EFFECTIVENESS_REQUIRED_TYPES.includes(f.finding_type));
  if (openMajor.length) {
    return {
      ok: false,
      reason: `${openMajor.length} major nonconformit${openMajor.length === 1 ? 'y' : 'ies'} raised by this audit ${openMajor.length === 1 ? 'is' : 'are'} still open.`,
    };
  }
  const stopWork = findings.filter((f) => f.stop_work && isFindingOpen(f));
  if (stopWork.length) {
    return {
      ok: false,
      reason: `${stopWork.length} finding${stopWork.length === 1 ? '' : 's'} that stopped work ${stopWork.length === 1 ? 'is' : 'are'} still open.`,
    };
  }
  return { ok: true };
};

export const canCancelAudit = (audit = {}, patch = {}) => {
  if (AUDIT_TERMINAL_STATUSES.includes(audit.status)) {
    return { ok: false, reason: `This audit is already ${String(audit.status).toLowerCase()}.` };
  }
  const reason = patch.cancellation_reason ?? audit.cancellation_reason;
  if (!String(reason || '').trim()) {
    return {
      ok: false,
      reason: 'Say why this audit is not being done. An audit that quietly disappears from the programme is the reason a programme cannot be trusted.',
    };
  }
  return { ok: true };
};

export const AUDIT_TRANSITIONS = Object.freeze({
  Planned: Object.freeze(['In progress', 'Cancelled']),
  'In progress': Object.freeze(['Fieldwork complete', 'Cancelled']),
  'Fieldwork complete': Object.freeze(['Reported', 'In progress', 'Cancelled']),
  Reported: Object.freeze(['Closed']),
  Closed: Object.freeze([]),
  Cancelled: Object.freeze([]),
});

export const nextAuditStatuses = (status) => AUDIT_TRANSITIONS[status] || [];

export const canAdvanceAudit = (audit = {}, to, context = {}) => {
  const allowed = nextAuditStatuses(audit.status);
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: allowed.length
        ? `An audit that is ${String(audit.status).toLowerCase()} can only move to ${allowed.join(', ')}.`
        : `${withArticle(String(audit.status).toLowerCase())} audit is final.`,
    };
  }
  if (to === 'Reported') return canReportAudit(audit, context);
  if (to === 'Closed') return canCloseAudit(audit, context.findings || []);
  if (to === 'Cancelled') return canCancelAudit(audit, context.patch);
  return { ok: true };
};

export const isAuditOverdue = (audit = {}, today = new Date()) => {
  if (['Reported', 'Closed', 'Cancelled'].includes(audit.status)) return false;
  const days = daysUntil(audit.planned_end, today);
  return days !== null && days < 0;
};

/* ------------------------------------------------------------------ */
/* The programme                                                      */
/* ------------------------------------------------------------------ */

export const PROGRAMME_DONE_STATUSES = Object.freeze(['Reported', 'Closed', 'Cancelled']);

/**
 * The one authority for "outstanding" (ASC-0, R1). An audit is outstanding
 * until it is reported, closed, or cancelled WITH a written reason (AS15
 * §3k.4 Q11: a cancellation counts as done only with its reason).
 * programmeProgress, canCompleteProgramme and summarise all ask this, so
 * the Programmes page and the dashboard cannot print different counts for
 * the same audits; summarise used to count a reasonless cancellation done.
 */
const isOutstandingAudit = (a = {}) => !PROGRAMME_DONE_STATUSES.includes(a.status)
  || (a.status === 'Cancelled' && !String(a.cancellation_reason || '').trim());

/**
 * How the programme actually went: performed, cancelled with a reason,
 * and still outstanding.
 *
 * `percent` counts audits REPORTED, not audits planned. A programme
 * whose ten audits are all still Planned is 0% delivered, whatever the
 * calendar says.
 */
export const programmeProgress = (audits = [], today = new Date()) => {
  const total = audits.length;
  const reported = audits.filter((a) => ['Reported', 'Closed'].includes(a.status)).length;
  const cancelled = audits.filter((a) => a.status === 'Cancelled').length;
  // AS15 (§3k.4 Q11): a cancellation counts as done only with its reason.
  const outstanding = audits.filter(isOutstandingAudit);
  return {
    total,
    reported,
    cancelled,
    outstanding: outstanding.length,
    overdue: outstanding.filter((a) => isAuditOverdue(a, today)).length,
    percent: total === 0 ? null : halfUpPercent(reported, total),
  };
};

export const canApproveProgramme = (programme = {}, patch = {}) => {
  const next = { ...programme, ...patch };
  if (!next.approved_at) {
    return { ok: false, reason: 'Record the date the programme was approved.' };
  }
  if (!next.approved_by && !String(next.approver_name || '').trim()) {
    return { ok: false, reason: 'Name who approved it.' };
  }
  return { ok: true };
};

export const canCompleteProgramme = (programme = {}, audits = []) => {
  if (['Complete', 'Cancelled'].includes(programme.status)) {
    return { ok: false, reason: `This programme is already ${String(programme.status).toLowerCase()}.` };
  }
  // AS15 (§3k.4 Q11): a cancellation counts as done only with its reason.
  const outstanding = audits.filter(isOutstandingAudit);
  if (outstanding.length) {
    const codes = outstanding.map((a) => a.audit_code).filter(Boolean);
    return {
      ok: false,
      reason: `${outstanding.length} audit${outstanding.length === 1 ? '' : 's'} in this programme ${outstanding.length === 1 ? 'has' : 'have'} not been reported or cancelled${codes.length ? ` (${codes.slice(0, 6).join(', ')}${codes.length > 6 ? ', and more' : ''})` : ''}. A programme marked complete over audits that never happened is the document a certification body will ask for.`,
    };
  }
  return { ok: true };
};

export const PROGRAMME_TRANSITIONS = Object.freeze({
  Draft: Object.freeze(['Approved', 'Cancelled']),
  Approved: Object.freeze(['In progress', 'Cancelled']),
  'In progress': Object.freeze(['Complete', 'Cancelled']),
  Complete: Object.freeze([]),
  Cancelled: Object.freeze([]),
});

export const nextProgrammeStatuses = (status) => PROGRAMME_TRANSITIONS[status] || [];

export const canAdvanceProgramme = (programme = {}, to, context = {}) => {
  const allowed = nextProgrammeStatuses(programme.status);
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: allowed.length
        ? `A programme that is ${String(programme.status).toLowerCase()} can only move to ${allowed.join(', ')}.`
        : `${withArticle(String(programme.status).toLowerCase())} programme is final.`,
    };
  }
  if (to === 'Approved') return canApproveProgramme(programme, context.patch);
  if (to === 'Complete') return canCompleteProgramme(programme, context.audits || []);
  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Findings raised from an audit                                      */
/* ------------------------------------------------------------------ */

/**
 * May this finding be raised as written?
 *
 * The stop-work rule is the one that is this app's own: imminent
 * danger is dealt with on the spot, so the record of what was done
 * exists from the moment the finding is raised rather than at closure.
 */
export const canRaiseFinding = (finding = {}) => {
  if (!FINDING_TYPES.includes(finding.finding_type)) {
    return { ok: false, reason: 'Pick the finding type.' };
  }
  if (!String(finding.title || '').trim()) {
    return { ok: false, reason: 'State the finding in one line.' };
  }
  if (!String(finding.objective_evidence || '').trim()) {
    return {
      ok: false,
      reason: 'Objective evidence: what was seen, where, and when. It is the first thing an auditee will ask for.',
    };
  }
  if (finding.stop_work) {
    if (!NONCONFORMITY_TYPES.includes(finding.finding_type)) {
      return {
        ok: false,
        reason: 'A finding that stopped work is a nonconformity, not an observation.',
      };
    }
    if (!String(finding.correction || '').trim()) {
      return {
        ok: false,
        reason: 'A finding that stopped work records what was done about it at the time. Imminent danger does not wait for the corrective action cycle.',
      };
    }
  }
  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Summaries and grouping                                             */
/* ------------------------------------------------------------------ */

export const summarise = (
  { programmes = [], templates = [], audits = [], responses = [], findings = [], actions = [] } = {},
  today = new Date(),
) => {
  const byAuditStatus = Object.fromEntries(AUDIT_STATUSES.map((s) => [s, 0]));
  audits.forEach((a) => {
    if (byAuditStatus[a.status] !== undefined) byAuditStatus[a.status] += 1;
  });

  const byFindingType = Object.fromEntries(FINDING_TYPES.map((t) => [t, 0]));
  const openByFindingType = Object.fromEntries(FINDING_TYPES.map((t) => [t, 0]));
  findings.forEach((f) => {
    if (byFindingType[f.finding_type] !== undefined) byFindingType[f.finding_type] += 1;
    if (isFindingOpen(f) && openByFindingType[f.finding_type] !== undefined) {
      openByFindingType[f.finding_type] += 1;
    }
  });

  // ASC-0 (R1): the same rule as programmeProgress().outstanding.
  const live = audits.filter(isOutstandingAudit);

  return {
    programmes: programmes.length,
    activeProgrammes: programmes.filter(
      (p) => ['Approved', 'In progress'].includes(p.status)).length,
    templates: templates.length,
    activeTemplates: templates.filter((t) => t.status === 'Active').length,

    audits: audits.length,
    byAuditStatus,
    auditsOutstanding: live.length,
    auditsOverdue: audits.filter((a) => isAuditOverdue(a, today)).length,
    auditsReported: audits.filter((a) => ['Reported', 'Closed'].includes(a.status)).length,
    auditsCancelled: audits.filter((a) => a.status === 'Cancelled').length,

    // The number the old tiles could not have produced, because there
    // were no tiles and no app: how much of the checklist work
    // actually got done.
    answers: responses.filter(isAnswered).length,
    answersOutstanding: responses.filter((r) => !isAnswered(r)).length,
    nonconformances: responses.filter((r) => r.result === 'Nonconformant').length,
    notApplicable: responses.filter((r) => r.result === 'Not applicable').length,

    findings: findings.length,
    openFindings: findings.filter(isFindingOpen).length,
    byFindingType,
    openByFindingType,
    openMajor: openByFindingType['Major nonconformity'],
    stopWork: findings.filter((f) => f.stop_work).length,
    stopWorkOpen: findings.filter((f) => f.stop_work && isFindingOpen(f)).length,
    findingsOverdue: findings.filter((f) => isFindingOverdue(f, today)).length,

    actions: actions.length,
    openActions: actions.filter(isActionOpen).length,
    overdueActions: actions.filter((a) => isActionOverdue(a, today)).length,
    actionsAwaitingEffectiveness: actions.filter(
      (a) => a.status === 'Complete'
        && a.effectiveness_verified !== true
        && a.effectiveness_verified !== false).length,
    actionsVerifiedEffective: actions.filter(isEffectivenessVerified).length,
    actionsFoundIneffective: actions.filter(isEffectivenessFailed).length,
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

/** Sort: open stop-work findings first. They are the ones that stopped work. */
export const findingByAttention = (today = new Date()) => (a, b) => {
  const rank = (f) => {
    if (isFindingOpen(f) && f.stop_work) return 0;
    if (isFindingOpen(f) && f.finding_type === 'Major nonconformity') {
      return isFindingOverdue(f, today) ? 1 : 2;
    }
    if (isFindingOpen(f) && isFindingOverdue(f, today)) return 3;
    if (isFindingOpen(f)) return 4;
    return 5;
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
