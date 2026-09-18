/**
 * Ported from the Suite at AS12 (src/lib/__tests__/auditManagement.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS10 — the Audit & Findings authority under test.
 *
 * There was no app to rebuild: `safety-audit-manager` and
 * `audit-trail-manager` were Active, sellable tiles with no route, no
 * page and no component behind either of them. So these tests are the
 * first statement anywhere in the Suite of what a checklist-driven
 * audit programme enforces.
 *
 * Per gate-must-call-the-engine, every gate test carries its negative
 * control. And the last block asserts the thing this wave is most
 * likely to get wrong: that the finding rules are AS8's, imported,
 * rather than a second copy living here.
 */
import {
  AUDIT_STATUSES,
  CRITICALITIES,
  FINDING_TYPES,
  PROGRAMME_STATUSES,
  RESPONSE_RESULTS,
  auditIndependence,
  canAdvanceAudit,
  canAdvanceProgramme,
  canApproveProgramme,
  canCancelAudit,
  canCloseAudit,
  canCloseFinding,
  canCompleteProgramme,
  canRaiseFinding,
  canReportAudit,
  checklistProgress,
  countBy,
  criticalAnswersWithoutFindings,
  findingByAttention,
  isAnswered,
  isAuditOverdue,
  nextAuditStatuses,
  nextProgrammeStatuses,
  programmeProgress,
  summarise,
  unansweredItems,
} from '../engines/assurance/auditManagement.js';
import { canCloseFinding as isoCanCloseFinding } from '../engines/assurance/isoCompliance.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local

const item = (over = {}) => ({
  id: 'i1', template_id: 't1', item_no: '1.1',
  question: 'Is a valid permit to work displayed at the worksite?',
  criticality: 'Critical', ...over,
});

const response = (over = {}) => ({
  id: 'r1', audit_id: 'a1', item_id: 'i1', result: 'Conformant',
  examined_on: '2026-09-02', ...over,
});

const audit = (over = {}) => ({
  id: 'a1', org_id: 'o1', audit_code: 'AUD-2026-001', template_id: 't1',
  title: 'Contractor HSE audit: Rig 7', audit_type: 'Contractor',
  status: 'Fieldwork complete', lead_auditor_id: 'u1', auditee_id: 'u2',
  conclusion: 'One nonconformity, closed on site.',
  planned_start: '2026-09-01', planned_end: '2026-09-05', ...over,
});

const finding = (over = {}) => ({
  id: 'f1', org_id: 'o1', finding_code: 'AF-2026-001', audit_id: 'a1',
  finding_type: 'Major nonconformity', title: 'Work without a displayed permit',
  objective_evidence: 'No permit at the drill floor at 09:40.',
  status: 'Open', raised_date: '2026-09-02', stop_work: false, ...over,
});

const action = (over = {}) => ({
  id: 'ac1', finding_id: 'f1', action_type: 'Corrective',
  description: 'Restore the permit board', status: 'Open', ...over,
});

const programme = (over = {}) => ({
  id: 'p1', org_id: 'o1', title: '2026 HSE audit programme', programme_year: 2026,
  status: 'In progress', approved_at: '2026-01-10', approved_by: 'u9', ...over,
});

describe('the checklist is the audit', () => {
  const items = [item({ id: 'i1', item_no: '1.1' }), item({ id: 'i2', item_no: '1.2', criticality: 'Minor' })];

  it('counts answers, and Not applicable with its reason IS an answer', () => {
    expect(isAnswered(response({ result: 'Not applicable', note: 'No cranes on site.' }))).toBe(true);
    expect(isAnswered(response({ result: 'Not examined' }))).toBe(false);
    expect(isAnswered({})).toBe(false);
  });

  it('reports progress over the protocol, and null for an audit with none', () => {
    const progress = checklistProgress(items, [response({ item_id: 'i1' })]);
    expect(progress).toMatchObject({ total: 2, answered: 1, outstanding: 1, percent: 50 });
    expect(checklistProgress([], []).percent).toBe(null);
  });

  it('names the items nobody answered rather than counting them', () => {
    expect(unansweredItems(items, [response({ item_id: 'i1' })]).map((i) => i.item_no))
      .toEqual(['1.2']);
    expect(unansweredItems(items, [])).toHaveLength(2);
  });

  it('counts each result separately', () => {
    const progress = checklistProgress(items, [
      response({ id: 'r1', item_id: 'i1', result: 'Nonconformant' }),
      response({ id: 'r2', item_id: 'i2', result: 'Not applicable', note: 'No hot work.' }),
    ]);
    expect(progress).toMatchObject({ nonconformant: 1, notApplicable: 1, answered: 2 });
  });
});

describe('a nonconformant answer on a critical item must raise a finding', () => {
  const items = [item({ id: 'i1', item_no: '1.1', criticality: 'Critical' }),
    item({ id: 'i2', item_no: '1.2', criticality: 'Minor' })];
  const answers = [
    response({ id: 'r1', item_id: 'i1', result: 'Nonconformant' }),
    response({ id: 'r2', item_id: 'i2', result: 'Nonconformant' }),
  ];

  it('names the critical item with no finding, and ignores the minor one', () => {
    const uncovered = criticalAnswersWithoutFindings(items, answers, []);
    expect(uncovered.map((i) => i.item_no)).toEqual(['1.1']);
  });

  it('is satisfied by a finding against that answer', () => {
    expect(criticalAnswersWithoutFindings(items, answers,
      [finding({ response_id: 'r1' })])).toEqual([]);
  });

  it('is NOT satisfied by a voided finding', () => {
    const uncovered = criticalAnswersWithoutFindings(items, answers,
      [finding({ response_id: 'r1', status: 'Voided' })]);
    expect(uncovered.map((i) => i.item_no)).toEqual(['1.1']);
  });

  it('is not satisfied by a finding against a different answer', () => {
    expect(criticalAnswersWithoutFindings(items, answers,
      [finding({ response_id: 'r2' })])).toHaveLength(1);
  });
});

describe('reporting an audit', () => {
  const items = [item({ id: 'i1', item_no: '1.1' }), item({ id: 'i2', item_no: '1.2', criticality: 'Minor' })];
  const answered = [
    response({ id: 'r1', item_id: 'i1' }),
    response({ id: 'r2', item_id: 'i2' }),
  ];

  it('REFUSES a report with the checklist half blank, and names the items', () => {
    const verdict = canReportAudit(audit(), {
      items, responses: [response({ id: 'r1', item_id: 'i1' })],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/1\.2/);
  });

  it('ALLOWS one whose checklist is answered', () => {
    expect(canReportAudit(audit(), { items, responses: answered }).ok).toBe(true);
  });

  it('REFUSES a critical nonconformance with no finding, and ALLOWS it with one', () => {
    const responses = [response({ id: 'r1', item_id: 'i1', result: 'Nonconformant' }),
      response({ id: 'r2', item_id: 'i2' })];
    expect(canReportAudit(audit(), { items, responses }).ok).toBe(false);
    expect(canReportAudit(audit(), {
      items, responses, findings: [finding({ response_id: 'r1' })],
    }).ok).toBe(true);
  });

  it('an ad-hoc audit with no template is not held to the checklist rule', () => {
    expect(canReportAudit(audit({ template_id: null }), { items: [], responses: [] }).ok)
      .toBe(true);
  });

  it('refuses a report with no conclusion, and with nobody named as lead auditor', () => {
    expect(canReportAudit(audit({ conclusion: '' }), { items, responses: answered }).ok)
      .toBe(false);
    expect(canReportAudit(audit({ lead_auditor_id: null, lead_auditor_name: '' }),
      { items, responses: answered }).ok).toBe(false);
  });

  it('refuses anything on a closed or cancelled audit', () => {
    expect(canReportAudit(audit({ status: 'Closed' }), { items, responses: answered }).ok)
      .toBe(false);
    expect(canReportAudit(audit({ status: 'Cancelled' }), { items, responses: answered }).ok)
      .toBe(false);
  });
});

describe('closing and cancelling an audit', () => {
  it('REFUSES closure over an open major nonconformity and ALLOWS it over a minor one', () => {
    const reported = audit({ status: 'Reported' });
    expect(canCloseAudit(reported, [finding({ status: 'Open' })]).ok).toBe(false);
    expect(canCloseAudit(reported, [
      finding({ finding_type: 'Minor nonconformity', status: 'Open' }),
    ]).ok).toBe(true);
  });

  it('REFUSES closure over an open STOP-WORK finding, whatever its type', () => {
    const verdict = canCloseAudit(audit({ status: 'Reported' }), [
      finding({ finding_type: 'Minor nonconformity', stop_work: true, correction: 'x' }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/stopped work/i);
  });

  it('refuses closure before the audit has been reported', () => {
    expect(canCloseAudit(audit(), []).ok).toBe(false);
  });

  it('REFUSES cancellation with no reason and ALLOWS it with one', () => {
    expect(canCancelAudit(audit()).ok).toBe(false);
    expect(canCancelAudit(audit(), {
      cancellation_reason: 'The contractor demobilised before the window.',
    }).ok).toBe(true);
  });

  it('only moves an audit where the transition table allows', () => {
    expect(nextAuditStatuses('Planned')).toEqual(['In progress', 'Cancelled']);
    expect(nextAuditStatuses('Closed')).toEqual([]);
    expect(canAdvanceAudit(audit({ status: 'Planned' }), 'Reported').ok).toBe(false);
    expect(canAdvanceAudit(audit({ status: 'Planned' }), 'In progress').ok).toBe(true);
  });

  it('routes each move through its own gate', () => {
    const items = [item()];
    expect(canAdvanceAudit(audit(), 'Reported', { items, responses: [] }).ok).toBe(false);
    expect(canAdvanceAudit(audit(), 'Reported', {
      items, responses: [response()],
    }).ok).toBe(true);
    expect(canAdvanceAudit(audit({ status: 'Reported' }), 'Closed', {
      findings: [finding()],
    }).ok).toBe(false);
    expect(canAdvanceAudit(audit(), 'Cancelled', { patch: {} }).ok).toBe(false);
  });

  it('knows an audit past its planned end, and does not nag about finished ones', () => {
    expect(isAuditOverdue(audit({ planned_end: '2026-09-16' }), TODAY)).toBe(true);
    expect(isAuditOverdue(audit({ planned_end: '2026-09-17' }), TODAY)).toBe(false);
    expect(isAuditOverdue(audit({
      planned_end: '2020-01-01', status: 'Reported',
    }), TODAY)).toBe(false);
  });
});

describe('an auditor may not audit their own area', () => {
  it('REFUSES the lead auditor being the auditee, and ALLOWS anyone else', () => {
    const verdict = auditIndependence(audit({ lead_auditor_id: 'u1', auditee_id: 'u1' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/own area/i);
    expect(auditIndependence(audit()).ok).toBe(true);
  });

  it('an external lead auditor with no Suite account is independent by construction', () => {
    expect(auditIndependence(audit({
      lead_auditor_id: null, lead_auditor_name: 'External auditor', auditee_id: 'u1',
    })).ok).toBe(true);
  });
});

describe('a finding that stopped work records what was done at the time', () => {
  it('REFUSES a stop-work finding with no correction and ALLOWS one with it', () => {
    const bare = canRaiseFinding(finding({ stop_work: true }));
    expect(bare.ok).toBe(false);
    expect(bare.reason).toMatch(/imminent danger/i);
    expect(canRaiseFinding(finding({
      stop_work: true, correction: 'Work stopped at 09:45 and the guard refitted.',
    })).ok).toBe(true);
  });

  it('a stop-work OBSERVATION is a contradiction', () => {
    expect(canRaiseFinding(finding({
      finding_type: 'Observation', stop_work: true, correction: 'x',
    })).ok).toBe(false);
  });

  it('every finding needs objective evidence, stop-work or not', () => {
    expect(canRaiseFinding(finding({ objective_evidence: '' })).ok).toBe(false);
    expect(canRaiseFinding(finding({ objective_evidence: '   ' })).ok).toBe(false);
    expect(canRaiseFinding(finding()).ok).toBe(true);
  });

  it('rejects a finding type the register does not accept, or no title', () => {
    expect(canRaiseFinding(finding({ finding_type: 'Serious' })).ok).toBe(false);
    expect(canRaiseFinding(finding({ title: '' })).ok).toBe(false);
  });
});

describe('a programme is complete when its audits are', () => {
  it('REFUSES completion over an audit that is still planned, and names it', () => {
    const verdict = canCompleteProgramme(programme(), [
      audit({ audit_code: 'AUD-2026-001', status: 'Reported' }),
      audit({ id: 'a2', audit_code: 'AUD-2026-002', status: 'Planned' }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/AUD-2026-002/);
  });

  it('ALLOWS completion when every audit is reported or cancelled', () => {
    expect(canCompleteProgramme(programme(), [
      audit({ status: 'Closed' }),
      audit({ id: 'a2', status: 'Cancelled', cancellation_reason: 'Contractor demobilised.' }),
    ]).ok).toBe(true);
  });

  it('an empty programme completes: nothing was planned, nothing is missing', () => {
    expect(canCompleteProgramme(programme(), []).ok).toBe(true);
  });

  it('counts delivery from audits REPORTED, not from audits planned', () => {
    const progress = programmeProgress([
      audit({ status: 'Reported' }),
      audit({ id: 'a2', status: 'Closed' }),
      audit({ id: 'a3', status: 'Planned', planned_end: '2026-08-01' }),
      audit({ id: 'a4', status: 'Cancelled', cancellation_reason: 'x' }),
    ], TODAY);
    expect(progress).toMatchObject({
      total: 4, reported: 2, cancelled: 1, outstanding: 1, overdue: 1, percent: 50,
    });
    expect(programmeProgress([]).percent).toBe(null);
  });

  it('an approved programme is a date and a name', () => {
    expect(canApproveProgramme(programme({ approved_at: null })).ok).toBe(false);
    expect(canApproveProgramme(programme({ approved_by: null, approver_name: '' })).ok)
      .toBe(false);
    expect(canApproveProgramme(programme({
      approved_by: null, approver_name: 'The HSE manager',
    })).ok).toBe(true);
  });

  it('only moves a programme where the transition table allows', () => {
    expect(nextProgrammeStatuses('Draft')).toEqual(['Approved', 'Cancelled']);
    expect(nextProgrammeStatuses('Complete')).toEqual([]);
    expect(canAdvanceProgramme(programme({ status: 'Draft' }), 'Complete').ok).toBe(false);
    expect(canAdvanceProgramme(programme(), 'Complete', {
      audits: [audit({ status: 'Planned' })],
    }).ok).toBe(false);
    expect(canAdvanceProgramme(programme(), 'Complete', { audits: [] }).ok).toBe(true);
  });
});

describe('summary and sorting', () => {
  it('counts the checklist work as well as the audits', () => {
    const s = summarise({
      audits: [audit({ status: 'Reported' }), audit({ id: 'a2', status: 'Planned', planned_end: '2026-08-01' })],
      responses: [
        response({ id: 'r1', result: 'Conformant' }),
        response({ id: 'r2', result: 'Nonconformant' }),
        response({ id: 'r3', result: 'Not applicable', note: 'Not a lifting site.' }),
        response({ id: 'r4', result: 'Not examined', examined_on: null }),
      ],
      findings: [finding(), finding({ id: 'f2', stop_work: true, correction: 'x' })],
      actions: [action(), action({ id: 'ac2', status: 'Complete', completed_at: '2026-09-10' })],
    }, TODAY);
    expect(s).toMatchObject({
      audits: 2, auditsReported: 1, auditsOutstanding: 1, auditsOverdue: 1,
      answers: 3, answersOutstanding: 1, nonconformances: 1, notApplicable: 1,
      openMajor: 2, stopWork: 1, stopWorkOpen: 1,
      openActions: 1, actionsAwaitingEffectiveness: 1,
    });
  });

  it('returns zeros, not a crash, for an organization with nothing', () => {
    const s = summarise({}, TODAY);
    expect(s.audits).toBe(0);
    expect(s.openFindings).toBe(0);
    expect(s.answers).toBe(0);
  });

  it('puts an open stop-work finding first, ahead of an overdue major', () => {
    const rows = [
      finding({ id: 'f1', finding_type: 'Observation' }),
      finding({ id: 'f2', due_date: '2026-08-01' }),
      finding({ id: 'f3', stop_work: true, correction: 'x', due_date: '2026-12-01' }),
      finding({ id: 'f4', status: 'Closed' }),
    ];
    expect([...rows].sort(findingByAttention(TODAY)).map((f) => f.id))
      .toEqual(['f3', 'f2', 'f1', 'f4']);
  });

  it('groups and labels an unset field instead of dropping it', () => {
    expect(countBy([{ audit_type: 'Contractor' }, {}], 'audit_type'))
      .toEqual([{ name: 'Contractor', count: 1 }, { name: 'Unspecified', count: 1 }]);
  });
});

describe('the finding rules are AS8\'s, imported rather than copied', () => {
  it('canCloseFinding IS the ISO one, not a second implementation', () => {
    expect(canCloseFinding).toBe(isoCanCloseFinding);
  });

  it('and it behaves the same on an audit finding, because the columns match', () => {
    const major = finding({ correction: 'Permit reissued.' });
    expect(canCloseFinding(major, []).ok).toBe(false);
    expect(canCloseFinding({
      ...major, root_cause: 'The permit board was moved at shift change.',
    }, [{
      ...action(), status: 'Complete', completed_at: '2026-09-15',
      effectiveness_verified: true, effectiveness_checked_at: '2026-10-01',
      effectiveness_verified_by: 'u1',
    }]).ok).toBe(true);
  });

  it('shares the vocabularies with AS8 so the two apps can be counted together', () => {
    expect(FINDING_TYPES).toEqual([
      'Major nonconformity', 'Minor nonconformity', 'Observation',
      'Opportunity for improvement']);
    expect(AUDIT_STATUSES).toHaveLength(6);
    expect(RESPONSE_RESULTS).toEqual([
      'Not examined', 'Conformant', 'Nonconformant', 'Observation', 'Not applicable']);
  });

  it('has its own vocabularies for what AS8 does not have', () => {
    expect(CRITICALITIES).toEqual(['Critical', 'Major', 'Minor']);
    expect(PROGRAMME_STATUSES).toEqual([
      'Draft', 'Approved', 'In progress', 'Complete', 'Cancelled']);
  });
});

describe('AS15 owner decision Q11: the engine does not trust the stored row', () => {
  it('a Not applicable answer with no written reason is not an answer', () => {
    ['', '   ', null, undefined].forEach((note) => {
      expect(isAnswered(response({ result: 'Not applicable', note }))).toBe(false);
    });
    const items = [item({ id: 'i1', item_no: '3.1' }), item({ id: 'i2', item_no: '3.2' })];
    const answers = [
      response({ id: 'r1', item_id: 'i1', result: 'Not applicable', note: ' ' }),
      response({ id: 'r2', item_id: 'i2', result: 'Conformant' }),
    ];
    expect(unansweredItems(items, answers).map((i) => i.item_no)).toEqual(['3.1']);
    expect(checklistProgress(items, answers)).toMatchObject({ answered: 1, outstanding: 1 });
  });

  it('a cancelled audit with no written reason keeps the programme open', () => {
    ['', '  ', null].forEach((cancellation_reason) => {
      const v = canCompleteProgramme(programme(), [
        audit({ status: 'Reported' }),
        audit({ id: 'a2', audit_code: 'AUD-2026-009', status: 'Cancelled', cancellation_reason }),
      ]);
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/AUD-2026-009/);
    });
  });
});

