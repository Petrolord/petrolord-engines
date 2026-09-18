/**
 * The one ISO Compliance authority for the Assurance module.
 *
 * AS8, after riskScoring (AS2), complianceStatus (AS3),
 * documentControl (AS4), peerReview (AS5), managementOfChange (AS6)
 * and qualityAssurance (AS7).
 *
 * Like AS6 and AS7 there was no logic to consolidate, because there was
 * no data. The whole app was `src/data/isoComplianceData.js`, and that
 * file did not even hold fixed rows: it GENERATED thirty clauses,
 * fifteen audits, twenty findings and fifteen actions at module load,
 * with `Math.random()` in the audit scores, the finding due dates and
 * the clause review dates. Refreshing the page gave a different
 * compliance position for the same organization, and neither of them
 * described anything.
 *
 * Four rules, and the first is the one that makes a clause register
 * worth keeping:
 *
 *   A CONFORMITY CLAIM IS EVIDENCE, A DATE AND A NAME. "Compliant" in
 *   a dropdown is an opinion. ISO conformity is a claim about
 *   documented information, and the first question at a certification
 *   audit is which document, and when anybody last looked at it. A
 *   claim with no evidence reference is not a claim this module will
 *   count.
 *
 *   AN AUDITOR MAY NOT AUDIT THEIR OWN WORK. ISO 19011's independence
 *   principle. It is the rule an internal audit programme lives or
 *   dies by and the easiest one to lose in a hurry, because the person
 *   who owns the procedure is the fastest person to audit it.
 *
 *   COVERAGE IS COUNTED OVER THE CERTIFICATION CYCLE, NOT CLAIMED. An
 *   applicable clause that no internal audit has examined within the
 *   cycle has not been audited, whatever its owner has marked it.
 *
 *   CERTIFICATION READINESS IS A LIST OF BLOCKERS, NOT A PERCENTAGE.
 *   The app this replaces showed "Overall Compliance 73%", computed as
 *   the share of clauses whose own owners had marked them compliant,
 *   over data it had invented. A percentage of self-assessments cannot
 *   tell you whether a certification audit will go well; the things
 *   that will stop it are countable and each one is nameable, so this
 *   module names them.
 */

import {
  isCapaOpen,
  isCapaOverdue,
  isEffectivenessVerified,
  isEffectivenessFailed,
  parseDateOnly,
  daysUntil,
  toDateOnlyString,
} from './qualityAssurance.js';

/* ------------------------------------------------------------------ */
/* Reuse, stated openly.                                              */
/*                                                                    */
/* An ISO corrective action and an NCR corrective action are the same  */
/* object: a description, an owner, a due date, a completion, and an   */
/* effectiveness check that is a date and a name either way. AS7 wrote */
/* those rules; `iso_actions` carries the same column names on purpose */
/* so they can be imported rather than restated. Two modules that both */
/* know when an action is overdue is the defect this module is most    */
/* likely to grow (Assurance-ROADMAP.md §6).                          */
/* ------------------------------------------------------------------ */

export const isActionOpen = isCapaOpen;
export const isActionOverdue = isCapaOverdue;
export { isEffectivenessVerified, isEffectivenessFailed, parseDateOnly, daysUntil, toDateOnlyString };

/* ------------------------------------------------------------------ */
/* Vocabularies. Every one is a check constraint in migration          */
/* 20260917600000, and every gate below compares against one of them.  */
/* ------------------------------------------------------------------ */

export const CERTIFICATION_STATUSES = Object.freeze([
  'Not certified', 'Seeking certification', 'Certified', 'Suspended', 'Withdrawn',
]);

export const APPLICABILITIES = Object.freeze(['Applicable', 'Not applicable']);

export const CLAUSE_STATUSES = Object.freeze([
  'Not assessed', 'Conformant', 'Partially conformant', 'Nonconformant', 'Not applicable',
]);

/** The statuses that assert conformity, and so require evidence. */
export const CLAUSE_CLAIM_STATUSES = Object.freeze(['Conformant', 'Partially conformant']);

export const AUDIT_TYPES = Object.freeze([
  'Internal', 'Supplier', 'Certification', 'Surveillance', 'Recertification',
]);

export const AUDIT_STATUSES = Object.freeze([
  'Planned', 'In progress', 'Fieldwork complete', 'Reported', 'Closed', 'Cancelled',
]);

export const AUDIT_OPEN_STATUSES = Object.freeze([
  'Planned', 'In progress', 'Fieldwork complete', 'Reported',
]);

export const AUDIT_TERMINAL_STATUSES = Object.freeze(['Closed', 'Cancelled']);

/** Only an internal audit counts towards internal audit coverage. */
export const COVERING_AUDIT_TYPES = Object.freeze(['Internal']);

/**
 * Owner decision AS15 (§3k.4 Q4): an examination counts towards a
 * clause's audit coverage only once its audit is Reported or Closed. ISO
 * 9001 §9.2.2(c) asks for the RESULTS of internal audits to be reported;
 * an examination in an audit still In progress, or one later Cancelled,
 * is not a result anybody reported.
 */
export const COVERAGE_COUNTING_STATUSES = Object.freeze(['Reported', 'Closed']);

export const COVERAGE_RESULTS = Object.freeze([
  'Not examined', 'Conformant', 'Nonconformant', 'Observation', 'Not applicable',
]);

export const COVERAGE_EXAMINED_RESULTS = Object.freeze([
  'Conformant', 'Nonconformant', 'Observation', 'Not applicable',
]);

export const FINDING_TYPES = Object.freeze([
  'Major nonconformity', 'Minor nonconformity', 'Observation',
  'Opportunity for improvement',
]);

/** The types that are nonconformities, and so need a correction. */
export const NONCONFORMITY_TYPES = Object.freeze([
  'Major nonconformity', 'Minor nonconformity',
]);

/**
 * The type for which a completed corrective action is not enough.
 *
 * AS5's proportionality precedent, and AS7's: a major nonconformity
 * needs the effectiveness check, a minor one does not, and an
 * observation needs neither. Treating all four the same is how an
 * audit programme stops distinguishing between a typo and a systemic
 * failure.
 */
export const EFFECTIVENESS_REQUIRED_TYPES = Object.freeze(['Major nonconformity']);

export const FINDING_STATUSES = Object.freeze([
  'Open', 'Correction proposed', 'Action in progress', 'Verification', 'Closed', 'Voided',
]);

export const FINDING_OPEN_STATUSES = Object.freeze([
  'Open', 'Correction proposed', 'Action in progress', 'Verification',
]);

export const FINDING_TERMINAL_STATUSES = Object.freeze(['Closed', 'Voided']);

export const ROOT_CAUSE_CATEGORIES = Object.freeze([
  'Procedure or documentation',
  'Human factors or competence',
  'Design',
  'Material or equipment',
  'Supplier or subcontractor',
  'Planning or scheduling',
  'Communication',
  'Measurement or monitoring',
  'Management system',
  'Other',
]);

export const ACTION_TYPES = Object.freeze(['Corrective', 'Preventive']);
export const ACTION_STATUSES = Object.freeze(['Open', 'In progress', 'Complete', 'Cancelled']);

/** How far ahead a clause review or a certificate starts reading "due soon". */
export const REVIEW_LEAD_DAYS = 30;
export const CERTIFICATE_LEAD_DAYS = 90;

/* ------------------------------------------------------------------ */
/* Clauses                                                            */
/* ------------------------------------------------------------------ */

export const isApplicable = (clause = {}) => clause.applicability !== 'Not applicable';

export const claimsConformity = (clause = {}) =>
  CLAUSE_CLAIM_STATUSES.includes(clause.status);

export const isAssessed = (clause = {}) =>
  clause.status !== 'Not assessed' && Boolean(clause.assessed_date);

/**
 * Is this clause's conformity claim backed by anything?
 *
 * Mirrors `iso_clauses_claim_needs_evidence` so a form can name the
 * missing field rather than showing a user a constraint name.
 */
export const hasEvidenceRecord = (clause = {}) =>
  Boolean(String(clause.evidence_reference || '').trim())
  && Boolean(clause.assessed_date)
  && Boolean(clause.assessed_by || String(clause.assessor_name || '').trim());

/**
 * May this clause be moved to `status`, and if not, why not?
 *
 * The old app's Add Clause modal set `status: 'Compliant'` on every
 * clause it created, with no evidence, no date and no assessor, and
 * toasted that it had been successfully registered.
 */
export const canSetClauseStatus = (clause = {}, status, patch = {}) => {
  if (!CLAUSE_STATUSES.includes(status)) {
    return { ok: false, reason: `${status} is not a clause status.` };
  }
  const next = { ...clause, ...patch, status };

  if (status === 'Not applicable' || next.applicability === 'Not applicable') {
    if (status !== 'Not applicable' || next.applicability !== 'Not applicable') {
      return {
        ok: false,
        reason: 'A clause determined not applicable cannot also carry a conformity verdict. Set both together, or neither.',
      };
    }
    if (!String(next.applicability_justification || '').trim()) {
      return {
        ok: false,
        reason: 'ISO 9001:2015 §4.3 requires the justification for a requirement determined not applicable to be kept. Say why this one does not apply.',
      };
    }
    return { ok: true };
  }

  if (CLAUSE_CLAIM_STATUSES.includes(status) && !hasEvidenceRecord(next)) {
    return {
      ok: false,
      reason: 'Name the evidence, the date it was assessed and who assessed it. Conformity is a claim about documented information; without those three it is an opinion in a dropdown.',
    };
  }

  if (status === 'Nonconformant'
      && !(next.assessed_date
           && (next.assessed_by || String(next.assessor_name || '').trim()))) {
    return {
      ok: false,
      reason: 'Record the date this was assessed and who assessed it.',
    };
  }

  return { ok: true };
};

export const isReviewOverdue = (clause = {}, today = new Date()) => {
  if (!isApplicable(clause)) return false;
  const days = daysUntil(clause.next_review_due, today);
  return days !== null && days < 0;
};

export const isReviewDueSoon = (clause = {}, today = new Date()) => {
  if (!isApplicable(clause)) return false;
  const days = daysUntil(clause.next_review_due, today);
  return days !== null && days >= 0 && days <= REVIEW_LEAD_DAYS;
};

/* ------------------------------------------------------------------ */
/* The internal audit programme                                       */
/* ------------------------------------------------------------------ */

/**
 * ISO 19011: an auditor may not audit their own work.
 *
 * Returns `{ ok, reason, clauses }`, where `clauses` are the clause
 * references in scope that the lead auditor owns. The database refuses
 * the same thing; this says so before the row is attempted, and names
 * them.
 *
 * An external lead auditor — named in text, with no Suite account — is
 * independent by construction and never blocked.
 */
export const auditIndependence = (audit = {}, clausesInScope = []) => {
  if (!audit.lead_auditor_id) return { ok: true, clauses: [] };
  const owned = clausesInScope.filter((c) => c && c.owner_id === audit.lead_auditor_id);
  if (!owned.length) return { ok: true, clauses: [] };
  const refs = owned.map((c) => c.clause_ref).filter(Boolean);
  return {
    ok: false,
    clauses: refs,
    reason: `The lead auditor owns ${refs.length === 1 ? 'clause' : 'clauses'} ${refs.join(', ')} in this audit's own scope. An auditor may not audit their own work (ISO 19011), so either the scope or the auditor has to change.`,
  };
};

/**
 * Owner decision AS15 (§3k.4 Q5): ISO 19011 independence applies to
 * EVERY auditor, and it was checked for the lead auditor only. Whoever
 * records a clause's examination result is auditing that clause, so they
 * may not be the clause's owner. The app has no audit-team table, so the
 * examiner is the signed-in person recording the result (stored as
 * `examined_by`, AS15 migration). An examiner with no Suite account is
 * not modelled: results are always recorded by a signed-in user.
 */
export const canExamineClause = (clause = {}, examinerId) => {
  if (examinerId && clause.owner_id && examinerId === clause.owner_id) {
    return {
      ok: false,
      reason: `You own clause ${clause.clause_ref || ''}`.trim()
        + '. An auditor may not audit their own work (ISO 19011), so somebody else on the audit has to record this result.',
    };
  }
  return { ok: true };
};

export const isCoverageExamined = (row = {}) =>
  COVERAGE_EXAMINED_RESULTS.includes(row.result);

/**
 * May this audit be reported?
 *
 * An audit reported with half its scope unexamined is what makes
 * coverage statistics meaningless, so the unexamined clauses are named
 * rather than counted.
 */
export const canReportAudit = (audit = {}, coverage = []) => {
  if (AUDIT_TERMINAL_STATUSES.includes(audit.status)) {
    return { ok: false, reason: `This audit is already ${String(audit.status).toLowerCase()}.` };
  }
  if (!coverage.length) {
    return {
      ok: false,
      reason: 'This audit has no clauses in its scope. An audit that examined nothing has nothing to report.',
    };
  }
  const outstanding = coverage.filter((c) => !isCoverageExamined(c));
  if (outstanding.length) {
    const refs = outstanding.map((c) => c.clause_ref).filter(Boolean);
    return {
      ok: false,
      reason: `${outstanding.length} clause${outstanding.length === 1 ? '' : 's'} in scope ${outstanding.length === 1 ? 'has' : 'have'} no result yet${refs.length ? ` (${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ', and more' : ''})` : ''}.`,
    };
  }
  if (!String(audit.conclusion || '').trim()) {
    return {
      ok: false,
      reason: 'Write the audit conclusion. A score out of 100 is not a report, which is all the register this replaces held.',
    };
  }
  if (!audit.lead_auditor_id && !String(audit.lead_auditor_name || '').trim()) {
    return { ok: false, reason: 'Name the lead auditor.' };
  }
  return { ok: true };
};

/**
 * May this audit be closed?
 *
 * Not while a major nonconformity it raised is still open. A minor one
 * does not block, on the same proportionality as everywhere else in
 * this module.
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
  const open = findings.filter(
    (f) => isFindingOpen(f) && EFFECTIVENESS_REQUIRED_TYPES.includes(f.finding_type));
  if (open.length) {
    return {
      ok: false,
      reason: `${open.length} major nonconformit${open.length === 1 ? 'y' : 'ies'} raised by this audit ${open.length === 1 ? 'is' : 'are'} still open.`,
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
        : `A ${String(audit.status).toLowerCase()} audit is final.`,
    };
  }
  if (to === 'Reported') return canReportAudit(audit, context.coverage || []);
  if (to === 'Closed') return canCloseAudit(audit, context.findings || []);
  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Findings                                                           */
/* ------------------------------------------------------------------ */

/**
 * An audit still open past its planned end. Named at AS11 so the hub
 * asks this module rather than restating the rule; `summarise()` uses
 * it too. Reported counts as open here because an ISO audit is not
 * finished until its findings are closed.
 */
export const isAuditOverdue = (audit = {}, today = new Date()) =>
  AUDIT_OPEN_STATUSES.includes(audit.status)
  && (daysUntil(audit.planned_end, today) ?? 1) < 0;

export const isFindingOpen = (finding = {}) =>
  FINDING_OPEN_STATUSES.includes(finding.status);

export const isNonconformity = (finding = {}) =>
  NONCONFORMITY_TYPES.includes(finding.finding_type);

export const isFindingOverdue = (finding = {}, today = new Date()) => {
  if (!isFindingOpen(finding)) return false;
  const days = daysUntil(finding.due_date, today);
  return days !== null && days < 0;
};

export const findingAgeDays = (finding = {}, today = new Date()) => {
  const raised = parseDateOnly(finding.raised_date);
  if (!raised) return null;
  // A finding's age is how long it was open. A closed or voided finding
  // stops at its closed date, as ncrAgeDays does; it used to keep ageing
  // to today (ISO-2, AS12 oracle).
  const end = !isFindingOpen(finding) && parseDateOnly(finding.closed_date)
    ? parseDateOnly(finding.closed_date) : today;
  return Math.max(0, -daysUntil(raised, end));
};

/**
 * May this finding be closed?
 *
 * ISO 9001 §10.2 in one function. The correction fixes the thing; the
 * corrective action removes the cause; and for a major nonconformity
 * the corrective action must have been shown to work.
 */
export const canCloseFinding = (finding = {}, actions = []) => {
  if (FINDING_TERMINAL_STATUSES.includes(finding.status)) {
    return { ok: false, reason: `This finding is already ${String(finding.status).toLowerCase()}.` };
  }

  if (isNonconformity(finding) && !String(finding.correction || '').trim()) {
    return {
      ok: false,
      reason: 'Record the correction: what was done about the thing that was found. A corrective action deals with the cause, and this is the other half.',
    };
  }

  const open = actions.filter(isActionOpen);
  if (open.length) {
    return {
      ok: false,
      reason: `${open.length} action${open.length === 1 ? '' : 's'} still open against this finding.`,
    };
  }

  if (EFFECTIVENESS_REQUIRED_TYPES.includes(finding.finding_type)) {
    if (!String(finding.root_cause || '').trim()) {
      return {
        ok: false,
        reason: 'A major nonconformity needs its root cause recorded before it closes. Closing one without it is how the same finding is raised again at the next surveillance audit.',
      };
    }
    const corrective = actions.filter(
      (a) => a.action_type === 'Corrective' && a.status !== 'Cancelled');
    if (!corrective.length) {
      return {
        ok: false,
        reason: 'A major nonconformity needs at least one corrective action. A correction deals with the instance; a corrective action deals with the cause.',
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
        reason: 'No corrective action has been verified effective yet. For a major nonconformity the effectiveness check is the point: a completed action is not a working one.',
      };
    }
  }

  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Coverage, over the certification cycle                             */
/* ------------------------------------------------------------------ */

/**
 * When was each applicable clause last examined by an internal audit,
 * and is that within the certification cycle?
 *
 * Only an internal audit counts (`COVERING_AUDIT_TYPES`): a
 * certification body's own audit is not this organization's internal
 * audit programme, and ISO 9001 §9.2 requires the organization to run
 * one of its own.
 *
 * Returns one row per applicable clause, so the gaps can be listed
 * rather than summarised into a percentage.
 */
export const clauseCoverage = (
  { clauses = [], auditClauses = [], audits = [], cycleYears = 3 } = {},
  today = new Date(),
) => {
  const auditById = new Map(audits.map((a) => [a.id, a]));
  // The same calendar day cycleYears back, or the last day of that month
  // when it has no such day: on 29 February the constructor rolled a
  // three-year cycle start over to 1 March (ISO-3, AS12 oracle).
  const y = today.getFullYear() - cycleYears;
  const lastDay = new Date(y, today.getMonth() + 1, 0).getDate();
  const cutoff = new Date(y, today.getMonth(), Math.min(today.getDate(), lastDay));

  const lastByClause = new Map();
  auditClauses.forEach((row) => {
    if (!isCoverageExamined(row)) return;
    const audit = auditById.get(row.audit_id);
    if (!audit || !COVERING_AUDIT_TYPES.includes(audit.audit_type)) return;
    if (!COVERAGE_COUNTING_STATUSES.includes(audit.status)) return;
    const when = parseDateOnly(row.examined_on) || parseDateOnly(audit.actual_end);
    if (!when) return;
    const current = lastByClause.get(row.clause_id);
    if (!current || when > current.when) {
      lastByClause.set(row.clause_id, { when, audit, result: row.result });
    }
  });

  return clauses.filter(isApplicable).map((clause) => {
    const last = lastByClause.get(clause.id) || null;
    return {
      clause,
      clause_ref: clause.clause_ref,
      lastExaminedOn: last ? toDateOnlyString(last.when) : null,
      lastAudit: last ? last.audit : null,
      lastResult: last ? last.result : null,
      // Never audited and audited before the cycle began are different
      // facts about an organization, and the register shows both.
      covered: Boolean(last && last.when >= cutoff),
      stale: Boolean(last && last.when < cutoff),
    };
  });
};

/**
 * clauseCoverage over clauses from several standards, each clause judged
 * against ITS OWN standard's certification cycle (`cycle_years`, default
 * 3). Rows come back in the order the applicable clauses were given.
 * summarise() and every register that shows coverage across standards
 * call this, so none of them can fall back to the 3-year default for a
 * standard that set another cycle (ISO-1, AS12 oracle; AS12b).
 */
export const clauseCoverageByStandard = (
  { standards = [], clauses = [], auditClauses = [], audits = [] } = {},
  today = new Date(),
) => {
  const cycleOf = new Map(standards.map((s) => [s.id, s.cycle_years || 3]));
  const byCycle = new Map();
  clauses.forEach((c) => {
    const cy = cycleOf.get(c.standard_id) || 3;
    if (!byCycle.has(cy)) byCycle.set(cy, []);
    byCycle.get(cy).push(c);
  });
  const byId = new Map();
  byCycle.forEach((group, cycleYears) => {
    clauseCoverage({ clauses: group, auditClauses, audits, cycleYears }, today)
      .forEach((row) => byId.set(row.clause.id, row));
  });
  return clauses.filter(isApplicable).map((c) => byId.get(c.id));
};

/* ------------------------------------------------------------------ */
/* Certification readiness                                            */
/* ------------------------------------------------------------------ */

/**
 * Is this standard ready for a certification or surveillance audit?
 *
 * Returns `{ ready, blockers, counts }`. Deliberately NOT a
 * percentage: the app this replaces showed "Overall Compliance 73%",
 * the share of clauses their own owners had marked compliant, over
 * generated data. Every blocker below is something a certification
 * auditor would raise, and each names how many clauses or findings it
 * is about, so the list is work rather than a score.
 */
export const certificationReadiness = (
  standard = {},
  { clauses = [], findings = [], actions = [], audits = [], auditClauses = [] } = {},
  today = new Date(),
) => {
  const mine = clauses.filter((c) => !standard.id || c.standard_id === standard.id);
  const applicable = mine.filter(isApplicable);
  const myFindings = findings.filter((f) => !standard.id || f.standard_id === standard.id);

  const coverage = clauseCoverage({
    clauses: mine,
    auditClauses,
    audits,
    cycleYears: standard.cycle_years || 3,
  }, today);

  const neverAudited = coverage.filter((c) => !c.lastExaminedOn);
  const staleAudited = coverage.filter((c) => c.stale);
  const notAssessed = applicable.filter((c) => !isAssessed(c));
  const unevidenced = applicable.filter((c) => claimsConformity(c) && !hasEvidenceRecord(c));
  const nonconformant = applicable.filter((c) => c.status === 'Nonconformant');
  const reviewsOverdue = applicable.filter((c) => isReviewOverdue(c, today));

  const openMajor = myFindings.filter(
    (f) => isFindingOpen(f) && f.finding_type === 'Major nonconformity');
  const openMinor = myFindings.filter(
    (f) => isFindingOpen(f) && f.finding_type === 'Minor nonconformity');
  const overdueFindings = myFindings.filter((f) => isFindingOverdue(f, today));
  const findingIds = new Set(myFindings.map((f) => f.id));
  const myActions = actions.filter((a) => findingIds.has(a.finding_id));
  const overdueActions = myActions.filter((a) => isActionOverdue(a, today));

  const blockers = [];
  const add = (severity, count, text) => { if (count > 0) blockers.push({ severity, count, text }); };

  add('blocking', openMajor.length,
    `${openMajor.length} major nonconformit${openMajor.length === 1 ? 'y is' : 'ies are'} open. A certification body will not recommend certification over one.`);
  add('blocking', neverAudited.length,
    `${neverAudited.length} applicable clause${neverAudited.length === 1 ? ' has' : 's have'} never been examined by an internal audit. ISO 9001 §9.2 requires the organization to audit its own system.`);
  add('blocking', unevidenced.length,
    `${unevidenced.length} clause${unevidenced.length === 1 ? ' is' : 's are'} marked conformant with no evidence, date or assessor recorded.`);
  add('blocking', nonconformant.length,
    `${nonconformant.length} clause${nonconformant.length === 1 ? ' is' : 's are'} assessed nonconformant and not yet resolved.`);
  add('serious', staleAudited.length,
    `${staleAudited.length} clause${staleAudited.length === 1 ? ' was' : 's were'} last audited before this certification cycle began.`);
  add('serious', notAssessed.length,
    `${notAssessed.length} applicable clause${notAssessed.length === 1 ? ' has' : 's have'} never been assessed at all.`);
  add('serious', overdueActions.length,
    `${overdueActions.length} corrective or preventive action${overdueActions.length === 1 ? ' is' : 's are'} past its due date.`);
  add('watch', openMinor.length,
    `${openMinor.length} minor nonconformit${openMinor.length === 1 ? 'y is' : 'ies are'} open.`);
  add('watch', reviewsOverdue.length,
    `${reviewsOverdue.length} clause review${reviewsOverdue.length === 1 ? ' is' : 's are'} past due.`);
  add('watch', overdueFindings.length,
    `${overdueFindings.length} finding${overdueFindings.length === 1 ? ' is' : 's are'} past its due date.`);

  // Owner decision AS15 (§3k.4 Q6): an expired certificate was a count
  // and never appeared in the list. It does not make the management
  // system unready (it is why a recertification audit is booked), so it
  // is serious rather than blocking, and it says what it changes.
  const certExpiry = daysUntil(standard.certificate_expires, today);
  if (certExpiry !== null && certExpiry < 0) {
    blockers.push({
      severity: 'serious',
      count: 1,
      text: `The certificate expired ${Math.abs(certExpiry)} day${Math.abs(certExpiry) === 1 ? '' : 's'} ago. The organization cannot claim certification, and a surveillance audit is no longer possible: it needs a recertification audit.`,
    });
  } else if (certExpiry !== null && certExpiry <= CERTIFICATE_LEAD_DAYS) {
    blockers.push({
      severity: 'watch',
      count: 1,
      text: `The certificate expires in ${certExpiry} day${certExpiry === 1 ? '' : 's'}. Book the recertification audit before then.`,
    });
  }

  // Keep the list in severity order (blocking, serious, watch): the
  // certificate entries above are pushed last. Array sort is stable.
  const RANK = { blocking: 0, serious: 1, watch: 2 };
  blockers.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  if (!applicable.length) {
    blockers.unshift({
      severity: 'blocking',
      count: 0,
      text: 'This standard has no applicable clauses in the register yet, so there is nothing to be ready with.',
    });
  }

  const certDays = daysUntil(standard.certificate_expires, today);

  return {
    ready: blockers.filter((b) => b.severity === 'blocking').length === 0,
    blockers,
    counts: {
      clauses: mine.length,
      applicable: applicable.length,
      excluded: mine.length - applicable.length,
      assessed: applicable.filter(isAssessed).length,
      evidenced: applicable.filter((c) => claimsConformity(c) && hasEvidenceRecord(c)).length,
      conformant: applicable.filter((c) => c.status === 'Conformant').length,
      partial: applicable.filter((c) => c.status === 'Partially conformant').length,
      nonconformant: nonconformant.length,
      notAssessed: notAssessed.length,
      covered: coverage.filter((c) => c.covered).length,
      neverAudited: neverAudited.length,
      staleAudited: staleAudited.length,
      openMajor: openMajor.length,
      openMinor: openMinor.length,
      overdueActions: overdueActions.length,
      certificateDays: certDays,
      certificateExpiring: certDays !== null && certDays <= CERTIFICATE_LEAD_DAYS,
      certificateExpired: certDays !== null && certDays < 0,
    },
    coverage,
  };
};

/* ------------------------------------------------------------------ */
/* Summaries and grouping                                             */
/* ------------------------------------------------------------------ */

export const summarise = (
  { standards = [], clauses = [], audits = [], findings = [], actions = [], auditClauses = [] } = {},
  today = new Date(),
) => {
  const applicable = clauses.filter(isApplicable);

  const byClauseStatus = Object.fromEntries(CLAUSE_STATUSES.map((s) => [s, 0]));
  clauses.forEach((c) => {
    if (byClauseStatus[c.status] !== undefined) byClauseStatus[c.status] += 1;
  });

  const byFindingType = Object.fromEntries(FINDING_TYPES.map((t) => [t, 0]));
  const openByFindingType = Object.fromEntries(FINDING_TYPES.map((t) => [t, 0]));
  findings.forEach((f) => {
    if (byFindingType[f.finding_type] !== undefined) byFindingType[f.finding_type] += 1;
    if (isFindingOpen(f) && openByFindingType[f.finding_type] !== undefined) {
      openByFindingType[f.finding_type] += 1;
    }
  });

  const byAuditStatus = Object.fromEntries(AUDIT_STATUSES.map((s) => [s, 0]));
  audits.forEach((a) => {
    if (byAuditStatus[a.status] !== undefined) byAuditStatus[a.status] += 1;
  });

  // Each clause against ITS standard's certification cycle (ISO-1).
  const coverage = clauseCoverageByStandard({ standards, clauses, auditClauses, audits }, today);

  return {
    standards: standards.length,
    certified: standards.filter((s) => s.certification_status === 'Certified').length,

    clauses: clauses.length,
    applicable: applicable.length,
    excluded: clauses.length - applicable.length,
    byClauseStatus,
    // The number the old dashboard could not have produced: a claim is
    // only counted when something stands behind it.
    evidencedClaims: applicable.filter((c) => claimsConformity(c) && hasEvidenceRecord(c)).length,
    unevidencedClaims: applicable.filter((c) => claimsConformity(c) && !hasEvidenceRecord(c)).length,
    notAssessed: applicable.filter((c) => !isAssessed(c)).length,
    reviewsOverdue: applicable.filter((c) => isReviewOverdue(c, today)).length,
    reviewsDueSoon: applicable.filter((c) => isReviewDueSoon(c, today)).length,

    audits: audits.length,
    byAuditStatus,
    auditsOpen: audits.filter((a) => AUDIT_OPEN_STATUSES.includes(a.status)).length,
    auditsOverdue: audits.filter((a) => isAuditOverdue(a, today)).length,

    clausesCovered: coverage.filter((c) => c.covered).length,
    clausesNeverAudited: coverage.filter((c) => !c.lastExaminedOn).length,
    clausesStale: coverage.filter((c) => c.stale).length,

    findings: findings.length,
    openFindings: findings.filter(isFindingOpen).length,
    byFindingType,
    openByFindingType,
    openMajor: openByFindingType['Major nonconformity'],
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

/** Sort: open major nonconformities first, then overdue, then by due date. */
export const findingByUrgency = (today = new Date()) => (a, b) => {
  const rank = (f) => {
    if (isFindingOpen(f) && f.finding_type === 'Major nonconformity') {
      return isFindingOverdue(f, today) ? 0 : 1;
    }
    if (isFindingOpen(f) && isFindingOverdue(f, today)) return 2;
    if (isFindingOpen(f)) return 3;
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
