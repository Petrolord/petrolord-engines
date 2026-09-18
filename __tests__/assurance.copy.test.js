/**
 * ASC-0 (RC-9): refusal and blocker sentences agree with what they count
 * and name, across the whole Assurance family.
 *
 * Three classes, found by the Risk and Change course foundation and then
 * swept for in every module:
 *   - number: "Approval levels 2 and 3 have not signed yet."
 *   - article: "An archived lesson is final.", "An emergency change ..."
 *   - count: "1 critical comment still needs resolving."
 * The goldens pin the moc, peer review and lessons sentences verbatim
 * ("prose": "exact"); this file covers every module the sweep touched.
 */
import { canAdvance } from '../engines/assurance/managementOfChange.js';
import { canClose, explainRefusal } from '../engines/assurance/peerReview.js';
import { canAdvanceLesson, canValidate } from '../engines/assurance/lessonsLearned.js';
import { canAdvanceAudit, canAdvanceProgramme } from '../engines/assurance/auditManagement.js';
import {
  canAdvanceAudit as isoCanAdvanceAudit,
  certificationReadiness,
} from '../engines/assurance/isoCompliance.js';
import { canAdvancePlan } from '../engines/assurance/qualityAssurance.js';
import { isAuditOverdue as auditIsAuditOverdue } from '../engines/assurance/auditManagement.js';
import {
  AUDIT_OPEN_STATUSES,
  AUDIT_STATUSES,
  isAuditOverdue as isoIsAuditOverdue,
  summarise as isoSummarise,
} from '../engines/assurance/isoCompliance.js';

const TODAY = new Date(2026, 8, 18);
const ap = (level, status) => ({ level, status });

describe('number agreement', () => {
  const perm = { type: 'Permanent', stage: 'Approval' };

  it('names one outstanding approval level in the singular', () => {
    expect(canAdvance(perm, 'Implementation', { approvals: [ap(1, 'Approved'), ap(2, 'Pending')] }).reason)
      .toBe('Approval level 2 has not signed yet.');
  });

  it('names several in the plural, as a list', () => {
    expect(canAdvance(perm, 'Implementation', {
      approvals: [ap(1, 'Approved'), ap(2, 'Pending'), ap(3, 'Pending')],
    }).reason).toBe('Approval levels 2 and 3 have not signed yet.');
    expect(canAdvance(perm, 'Implementation', {
      approvals: [ap(1, 'Approved'), ap(2, 'Pending'), ap(3, 'Pending'), ap(4, 'Pending')],
    }).reason).toBe('Approval levels 2, 3 and 4 have not signed yet.');
  });

  it('does the same for ratification of an emergency change', () => {
    const em = { type: 'Emergency', stage: 'Implementation', expiry_date: '2026-12-01' };
    expect(canAdvance(em, 'Closed', {
      approvals: [ap(1, 'Approved'), ap(2, 'Pending'), ap(3, 'Pending')],
    }).reason).toBe('Approval levels 2 and 3 have not ratified this emergency change. It cannot close until every level has signed.');
  });

  it('lists what a lesson is missing', () => {
    expect(canValidate({ status: 'Submitted' }, 'u-other').reason)
      .toMatch(/^This lesson is missing what happened, why it happened and what to do about it\./);
    expect(canValidate({ status: 'Submitted', description: 'x' }, 'u-other').reason)
      .toMatch(/^This lesson is missing why it happened and what to do about it\./);
  });

  it('says overdue actions and findings are past THEIR due dates', () => {
    const findings = [
      { id: 'f1', standard_id: 's', status: 'Open', finding_type: 'Observation', due_date: '2026-01-01' },
      { id: 'f2', standard_id: 's', status: 'Open', finding_type: 'Observation', due_date: '2026-01-02' },
    ];
    const actions = [
      { finding_id: 'f1', status: 'Open', due_date: '2026-01-01' },
      { finding_id: 'f2', status: 'Open', due_date: '2026-01-01' },
    ];
    const texts = (f, a) => certificationReadiness({ id: 's' }, { findings: f, actions: a }, TODAY)
      .blockers.map((b) => b.text);
    expect(texts(findings, actions)).toEqual(expect.arrayContaining([
      '2 corrective or preventive actions are past their due dates.',
      '2 findings are past their due dates.',
    ]));
    expect(texts(findings.slice(0, 1), actions.slice(0, 1))).toEqual(expect.arrayContaining([
      '1 corrective or preventive action is past its due date.',
      '1 finding is past its due date.',
    ]));
  });
});

describe('article agreement', () => {
  it('an archived lesson, a superseded one', () => {
    expect(canAdvanceLesson({ status: 'Archived' }, 'Draft').reason).toBe('An archived lesson is final.');
    expect(canAdvanceLesson({ status: 'Superseded' }, 'Draft').reason).toBe('A superseded lesson is final.');
  });

  it('an emergency change needs an expiry date, a temporary one too', () => {
    const signed = { approvals: [ap(1, 'Approved')] };
    expect(canAdvance({ type: 'Emergency', stage: 'Approval' }, 'Implementation', signed).reason)
      .toMatch(/^An emergency change needs an expiry date/);
    expect(canAdvance({ type: 'Temporary', stage: 'Approval' }, 'Implementation', signed).reason)
      .toMatch(/^A temporary change needs an expiry date/);
  });

  it('every "is final" refusal in the family agrees with its status', () => {
    expect(canAdvance({ stage: 'Approved' }, 'Draft').reason).toBe('An approved change is final.');
    expect(canAdvance({ stage: 'Closed' }, 'Draft').reason).toBe('A closed change is final.');
    expect(explainRefusal({ status: 'Withdrawn' }, 'Open')).toBe('A withdrawn comment is final.');
    expect(explainRefusal({ status: 'Open' }, 'Closed')).toBe('An open comment can only go to Responded or Withdrawn.');
    expect(canAdvanceAudit({ status: 'Archived' }, 'Closed').reason).toBe('An archived audit is final.');
    expect(canAdvanceProgramme({ status: 'Obsolete' }, 'Closed').reason).toBe('An obsolete programme is final.');
    expect(isoCanAdvanceAudit({ status: 'Archived' }, 'Closed').reason).toBe('An archived audit is final.');
    expect(canAdvancePlan({ status: 'Obsolete' }, 'Closed').reason).toBe('An obsolete plan is final.');
    expect(canAdvancePlan({ status: 'Closed' }, 'Active').reason).toBe('A closed plan is final.');
  });
});

describe('count agreement', () => {
  it('one blocking comment needs resolving; two need it', () => {
    expect(canClose([{ severity: 'Critical', status: 'Open' }]).reason)
      .toBe('1 critical comment still needs resolving. Verify, close out or withdraw it first.');
    expect(canClose([{ severity: 'Critical', status: 'Open' }, { severity: 'Major', status: 'Open' }]).reason)
      .toBe('1 critical and 1 major comments still need resolving. Verify, close out or withdraw them first.');
  });
});

/**
 * ASC-1, found by the NextGen compliance course writers.
 *   E3: the ISO and audit modules disagreed about a Reported audit past
 *       its planned end. Overdue asks "delivered by the planned end?".
 */
describe('ASC-1 E3: one answer to "is this audit overdue"', () => {
  const past = { planned_end: '2026-08-06' };
  const T = new Date(2026, 8, 17);

  it('a Reported audit past its planned end is open and not overdue, in both modules', () => {
    const reported = { ...past, status: 'Reported' };
    expect(AUDIT_OPEN_STATUSES).toContain('Reported');
    expect(isoIsAuditOverdue(reported, T)).toBe(false);
    expect(auditIsAuditOverdue(reported, T)).toBe(false);
  });

  it('agrees with auditManagement for every audit status, past and future', () => {
    AUDIT_STATUSES.forEach((status) => {
      ['2026-08-06', '2026-09-16', '2026-09-17', '2026-10-01'].forEach((planned_end) => {
        const a = { status, planned_end };
        expect([status, planned_end, isoIsAuditOverdue(a, T)])
          .toEqual([status, planned_end, auditIsAuditOverdue(a, T)]);
      });
    });
  });

  it('summarise counts the Reported audit as open and not as overdue', () => {
    const s = isoSummarise({ audits: [
      { id: 'r', status: 'Reported', ...past },
      { id: 'f', status: 'Fieldwork complete', ...past },
    ] }, T);
    expect(s.auditsOpen).toBe(2);
    expect(s.auditsOverdue).toBe(1);
  });
});
