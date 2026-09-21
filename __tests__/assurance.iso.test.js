/**
 * Ported from the Suite at AS12 (src/lib/__tests__/isoCompliance.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS8 — the ISO Compliance authority under test.
 *
 * The app it replaces had no logic to test and, unusually, no fixed
 * data either: src/data/isoComplianceData.js GENERATED its thirty
 * clauses, fifteen audits, twenty findings and fifteen actions at
 * module load, with Math.random() in the scores and the dates. Two
 * refreshes gave two different compliance positions.
 *
 * Per gate-must-call-the-engine, every gate test carries its negative
 * control: the case that must be refused AND the case that must be
 * allowed. A gate that only ever says yes proves nothing.
 */
import {
  AUDIT_STATUSES,
  CLAUSE_STATUSES,
  EFFECTIVENESS_REQUIRED_TYPES,
  FINDING_TYPES,
  NONCONFORMITY_TYPES,
  auditIndependence,
  COVERAGE_COUNTING_STATUSES,
  canAdvanceAudit,
  canCloseAudit,
  canCloseFinding,
  canExamineClause,
  canReportAudit,
  canSetClauseStatus,
  certificationReadiness,
  clauseCoverage,
  claimsConformity,
  countBy,
  findingAgeDays,
  findingByUrgency,
  hasEvidenceRecord,
  isActionOpen,
  isActionOverdue,
  isApplicable,
  isAssessed,
  isCoverageExamined,
  isFindingOpen,
  isFindingOverdue,
  isReviewDueSoon,
  isReviewOverdue,
  nextAuditStatuses,
  summarise,
} from '../engines/assurance/isoCompliance.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local

const standard = (over = {}) => ({
  id: 's1', org_id: 'o1', code: 'ISO 9001:2015', certification_status: 'Certified',
  certificate_number: 'NG-QMS-44812', certification_body: 'Lloyd\'s Register',
  certificate_expires: '2029-03-31', cycle_years: 3, ...over,
});

const clause = (over = {}) => ({
  id: 'c1', org_id: 'o1', standard_id: 's1', clause_ref: '7.1.5',
  title: 'Monitoring and measuring resources', applicability: 'Applicable',
  status: 'Not assessed', ...over,
});

/** A clause whose conformity claim is actually backed. */
const evidenced = (over = {}) => clause({
  status: 'Conformant',
  evidence_reference: 'QMS-PR-009 rev 4',
  assessed_date: '2026-06-01',
  assessed_by: 'u1',
  ...over,
});

const audit = (over = {}) => ({
  id: 'a1', org_id: 'o1', audit_code: 'IA-2026-001', standard_id: 's1',
  title: 'Q3 internal audit', audit_type: 'Internal', status: 'Fieldwork complete',
  lead_auditor_id: 'u9', conclusion: 'The system conforms, with two minor nonconformities.',
  ...over,
});

const cover = (over = {}) => ({
  id: 'ac1', audit_id: 'a1', clause_id: 'c1', clause_ref: '7.1.5',
  result: 'Conformant', examined_on: '2026-09-10', ...over,
});

const finding = (over = {}) => ({
  id: 'f1', org_id: 'o1', finding_code: 'IAF-2026-001', audit_id: 'a1', standard_id: 's1',
  finding_type: 'Minor nonconformity', title: 'Calibration records not retained',
  status: 'Open', raised_date: '2026-09-01', ...over,
});

const action = (over = {}) => ({
  id: 'ac1', finding_id: 'f1', action_type: 'Corrective',
  description: 'Assign retention periods', status: 'Open', ...over,
});

describe('clauses: a conformity claim is evidence, a date and a name', () => {
  it('a claim with nothing behind it is not evidenced', () => {
    expect(hasEvidenceRecord(clause({ status: 'Conformant' }))).toBe(false);
  });

  it('evidence alone is not enough, nor evidence and a date', () => {
    expect(hasEvidenceRecord(clause({ evidence_reference: 'QMS-PR-009' }))).toBe(false);
    expect(hasEvidenceRecord(clause({
      evidence_reference: 'QMS-PR-009', assessed_date: '2026-06-01',
    }))).toBe(false);
  });

  it('all three, and an external assessor named in text, are enough', () => {
    expect(hasEvidenceRecord(evidenced())).toBe(true);
    expect(hasEvidenceRecord(evidenced({
      assessed_by: null, assessor_name: 'External consultant',
    }))).toBe(true);
  });

  it('whitespace is not an evidence reference', () => {
    expect(hasEvidenceRecord(evidenced({ evidence_reference: '   ' }))).toBe(false);
  });

  it('REFUSES a conformant claim with no evidence, and ALLOWS an evidenced one', () => {
    const bare = canSetClauseStatus(clause(), 'Conformant');
    expect(bare.ok).toBe(false);
    expect(bare.reason).toMatch(/evidence/i);
    expect(canSetClauseStatus(clause(), 'Conformant', {
      evidence_reference: 'QMS-PR-009 rev 4', assessed_date: '2026-06-01', assessed_by: 'u1',
    }).ok).toBe(true);
  });

  it('refuses partially conformant on the same terms', () => {
    expect(canSetClauseStatus(clause(), 'Partially conformant').ok).toBe(false);
  });

  it('a nonconformant verdict needs the date and the assessor but not the evidence', () => {
    expect(canSetClauseStatus(clause(), 'Nonconformant').ok).toBe(false);
    expect(canSetClauseStatus(clause(), 'Nonconformant', {
      assessed_date: '2026-06-01', assessed_by: 'u1',
    }).ok).toBe(true);
  });

  it('not assessed needs nothing: it is the honest starting state', () => {
    expect(canSetClauseStatus(evidenced(), 'Not assessed').ok).toBe(true);
  });

  it('REFUSES an exclusion with no justification and ALLOWS one with it (ISO 9001 4.3)', () => {
    const bare = canSetClauseStatus(clause(), 'Not applicable', {
      applicability: 'Not applicable',
    }, standard());
    expect(bare.ok).toBe(false);
    expect(bare.reason).toMatch(/ISO 9001:2015 §4\.3/);
    expect(canSetClauseStatus(clause(), 'Not applicable', {
      applicability: 'Not applicable',
      applicability_justification: 'The organization holds no design authority.',
    }).ok).toBe(true);
  });

  it('whitespace is not a justification', () => {
    expect(canSetClauseStatus(clause(), 'Not applicable', {
      applicability: 'Not applicable', applicability_justification: '  ',
    }).ok).toBe(false);
  });

  it('an excluded clause cannot also be claimed conformant', () => {
    const verdict = canSetClauseStatus(
      clause({ applicability: 'Not applicable', applicability_justification: 'no design' }),
      'Conformant',
      { evidence_reference: 'x', assessed_date: '2026-06-01', assessed_by: 'u1' },
    );
    expect(verdict.ok).toBe(false);
  });

  it('rejects a status that is not in the vocabulary', () => {
    expect(canSetClauseStatus(clause(), 'Compliant').ok).toBe(false);
  });

  it('knows applicable from excluded, and assessed from claimed', () => {
    expect(isApplicable(clause())).toBe(true);
    expect(isApplicable(clause({ applicability: 'Not applicable' }))).toBe(false);
    expect(isAssessed(clause())).toBe(false);
    expect(isAssessed(evidenced())).toBe(true);
    expect(claimsConformity(evidenced())).toBe(true);
    expect(claimsConformity(clause({ status: 'Nonconformant' }))).toBe(false);
  });

  it('a review is overdue, due soon, or neither — and an excluded clause is none of them', () => {
    expect(isReviewOverdue(clause({ next_review_due: '2026-09-16' }), TODAY)).toBe(true);
    expect(isReviewOverdue(clause({ next_review_due: '2026-09-17' }), TODAY)).toBe(false);
    expect(isReviewDueSoon(clause({ next_review_due: '2026-10-01' }), TODAY)).toBe(true);
    expect(isReviewDueSoon(clause({ next_review_due: '2026-12-01' }), TODAY)).toBe(false);
    expect(isReviewOverdue(clause({
      applicability: 'Not applicable', next_review_due: '2020-01-01',
    }), TODAY)).toBe(false);
    expect(isReviewOverdue(clause(), TODAY)).toBe(false);
  });
});

describe('independence: an auditor may not audit their own work (ISO 19011)', () => {
  it('REFUSES an audit whose lead auditor owns a clause in scope, and names it', () => {
    const verdict = auditIndependence(audit({ lead_auditor_id: 'u1' }), [
      clause({ owner_id: 'u1' }), clause({ id: 'c2', clause_ref: '8.5.1', owner_id: 'u2' }),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.clauses).toEqual(['7.1.5']);
    expect(verdict.reason).toMatch(/7\.1\.5/);
    expect(verdict.reason).toMatch(/19011/);
  });

  it('ALLOWS an independent lead auditor over the same scope', () => {
    expect(auditIndependence(audit({ lead_auditor_id: 'u9' }), [
      clause({ owner_id: 'u1' }),
    ]).ok).toBe(true);
  });

  it('an external lead auditor with no Suite account is independent by construction', () => {
    expect(auditIndependence(
      audit({ lead_auditor_id: null, lead_auditor_name: 'External lead auditor' }),
      [clause({ owner_id: 'u1' })],
    ).ok).toBe(true);
  });

  it('names every clause the auditor owns, not just the first', () => {
    const verdict = auditIndependence(audit({ lead_auditor_id: 'u1' }), [
      clause({ owner_id: 'u1' }),
      clause({ id: 'c2', clause_ref: '8.5.1', owner_id: 'u1' }),
    ]);
    expect(verdict.clauses).toEqual(['7.1.5', '8.5.1']);
  });
});

describe('audits: reported means examined, closed means resolved', () => {
  it('REFUSES a report while a clause in scope has no result, and names it', () => {
    const verdict = canReportAudit(audit(), [cover(), cover({
      id: 'ac2', clause_id: 'c2', clause_ref: '9.2', result: 'Not examined', examined_on: null,
    })]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/9\.2/);
  });

  it('REFUSES a report over an empty scope', () => {
    expect(canReportAudit(audit(), []).ok).toBe(false);
  });

  it('REFUSES a report with no conclusion, and ALLOWS a complete one', () => {
    expect(canReportAudit(audit({ conclusion: '' }), [cover()]).ok).toBe(false);
    expect(canReportAudit(audit(), [cover()]).ok).toBe(true);
  });

  it('refuses a report with nobody named as lead auditor', () => {
    expect(canReportAudit(
      audit({ lead_auditor_id: null, lead_auditor_name: '' }), [cover()],
    ).ok).toBe(false);
  });

  it('counts every examined result, including not applicable', () => {
    expect(isCoverageExamined(cover({ result: 'Not applicable' }))).toBe(true);
    expect(isCoverageExamined(cover({ result: 'Nonconformity' }))).toBe(false);
    expect(isCoverageExamined(cover({ result: 'Not examined' }))).toBe(false);
  });

  it('REFUSES closure over an open MAJOR nonconformity and ALLOWS it over a minor one', () => {
    const reported = audit({ status: 'Reported' });
    expect(canCloseAudit(reported, [
      finding({ finding_type: 'Major nonconformity', status: 'Open' }),
    ]).ok).toBe(false);
    expect(canCloseAudit(reported, [
      finding({ finding_type: 'Minor nonconformity', status: 'Open' }),
    ]).ok).toBe(true);
  });

  it('refuses closure before the audit has been reported', () => {
    const verdict = canCloseAudit(audit({ status: 'Fieldwork complete' }), []);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/report/i);
  });

  it('refuses anything on a closed or cancelled audit', () => {
    expect(canCloseAudit(audit({ status: 'Closed' }), []).ok).toBe(false);
    expect(canReportAudit(audit({ status: 'Cancelled' }), [cover()]).ok).toBe(false);
  });

  it('only moves an audit where the transition table allows', () => {
    expect(nextAuditStatuses('Planned')).toContain('In progress');
    expect(nextAuditStatuses('Planned')).not.toContain('Reported');
    expect(nextAuditStatuses('Closed')).toEqual([]);
    expect(canAdvanceAudit(audit({ status: 'Planned' }), 'Reported').ok).toBe(false);
    expect(canAdvanceAudit(audit({ status: 'Planned' }), 'In progress').ok).toBe(true);
  });

  it('routes a move to Reported and Closed through their own gates', () => {
    expect(canAdvanceAudit(audit(), 'Reported', { coverage: [] }).ok).toBe(false);
    expect(canAdvanceAudit(audit(), 'Reported', { coverage: [cover()] }).ok).toBe(true);
    expect(canAdvanceAudit(audit({ status: 'Reported' }), 'Closed', {
      findings: [finding({ finding_type: 'Major nonconformity' })],
    }).ok).toBe(false);
  });
});

describe('findings: a correction is not a corrective action (ISO 9001 10.2)', () => {
  it('REFUSES a nonconformity with no correction recorded, and ALLOWS one with it', () => {
    const bare = canCloseFinding(finding(), []);
    expect(bare.ok).toBe(false);
    expect(bare.reason).toMatch(/correction/i);
    expect(canCloseFinding(finding({ correction: 'Records reconstructed.' }), []).ok).toBe(true);
  });

  it('an observation closes without a correction', () => {
    expect(canCloseFinding(finding({ finding_type: 'Observation' }), []).ok).toBe(true);
    expect(canCloseFinding(finding({
      finding_type: 'Opportunity for improvement',
    }), []).ok).toBe(true);
  });

  it('refuses closure while an action is open, and allows it once complete', () => {
    const f = finding({ correction: 'Records reconstructed.' });
    expect(canCloseFinding(f, [action()]).ok).toBe(false);
    expect(canCloseFinding(f, [action({
      status: 'Complete', completed_at: '2026-09-15',
    })]).ok).toBe(true);
  });

  it('a MAJOR nonconformity needs a root cause, and a minor one does not', () => {
    const major = finding({
      finding_type: 'Major nonconformity', correction: 'Records reconstructed.',
    });
    const verdict = canCloseFinding(major, []);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/root cause/i);
    expect(canCloseFinding(finding({ correction: 'done' }), []).ok).toBe(true);
  });

  it('a MAJOR nonconformity needs a corrective action, not only a correction', () => {
    const major = finding({
      finding_type: 'Major nonconformity',
      correction: 'Records reconstructed.',
      root_cause: 'No retention period was assigned.',
    });
    expect(canCloseFinding(major, []).ok).toBe(false);
    expect(canCloseFinding(major, [action({
      status: 'Complete', completed_at: '2026-09-15',
    })]).ok).toBe(false);
  });

  it('and that corrective action must have been VERIFIED EFFECTIVE', () => {
    const major = finding({
      finding_type: 'Major nonconformity',
      correction: 'Records reconstructed.',
      root_cause: 'No retention period was assigned.',
    });
    const done = action({ status: 'Complete', completed_at: '2026-09-15' });
    expect(canCloseFinding(major, [done]).ok).toBe(false);
    expect(canCloseFinding(major, [{
      ...done, effectiveness_verified: true, effectiveness_checked_at: '2026-10-01',
      effectiveness_verified_by: 'u1',
    }]).ok).toBe(true);
  });

  it('will not close over an action that was checked and did NOT work', () => {
    const major = finding({
      finding_type: 'Major nonconformity',
      correction: 'Records reconstructed.',
      root_cause: 'No retention period was assigned.',
    });
    const failed = action({
      status: 'Complete', completed_at: '2026-09-15', effectiveness_verified: false,
      effectiveness_checked_at: '2026-10-01', effectiveness_verified_by: 'u1',
    });
    const verdict = canCloseFinding(major, [failed]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not to have worked/i);
    // Going round again, with a second action that did work, closes it.
    expect(canCloseFinding(major, [failed, {
      ...action({ id: 'ac2' }), status: 'Complete', completed_at: '2026-10-10',
      effectiveness_verified: true, effectiveness_checked_at: '2026-11-01',
      effectiveness_verified_by: 'u1',
    }]).ok).toBe(true);
  });

  it('a cancelled corrective action does not count as one', () => {
    const major = finding({
      finding_type: 'Major nonconformity', correction: 'done', root_cause: 'cause',
    });
    expect(canCloseFinding(major, [action({ status: 'Cancelled' })]).ok).toBe(false);
  });

  it('refuses to close what is already closed or voided', () => {
    expect(canCloseFinding(finding({ status: 'Closed' }), []).ok).toBe(false);
    expect(canCloseFinding(finding({ status: 'Voided' }), []).ok).toBe(false);
  });

  it('knows open from terminal, overdue from due, and the age of a finding', () => {
    expect(isFindingOpen(finding({ status: 'Verification' }))).toBe(true);
    expect(isFindingOpen(finding({ status: 'Closed' }))).toBe(false);
    expect(isFindingOverdue(finding({ due_date: '2026-09-16' }), TODAY)).toBe(true);
    expect(isFindingOverdue(finding({ due_date: '2026-09-17' }), TODAY)).toBe(false);
    expect(isFindingOverdue(finding({
      due_date: '2020-01-01', status: 'Closed',
    }), TODAY)).toBe(false);
    expect(findingAgeDays(finding(), TODAY)).toBe(16);
  });
});

describe('coverage is counted over the certification cycle', () => {
  const clauses = [
    clause({ id: 'c1', clause_ref: '7.1.5' }),
    clause({ id: 'c2', clause_ref: '8.5.1' }),
    clause({ id: 'c3', clause_ref: '9.2' }),
    clause({
      id: 'c4', clause_ref: '8.3', applicability: 'Not applicable',
      status: 'Not applicable', applicability_justification: 'no design authority',
    }),
  ];
  const audits = [
    // Reported: since AS15 (Q4) only reported results are coverage.
    audit({ id: 'a1', audit_type: 'Internal', status: 'Reported' }),
    audit({ id: 'a2', audit_type: 'Certification', status: 'Reported' }),
  ];

  it('excludes clauses that do not apply', () => {
    const rows = clauseCoverage({ clauses, auditClauses: [], audits }, TODAY);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.clause_ref)).not.toContain('8.3');
  });

  it('a clause nobody has examined is never audited, not zero per cent', () => {
    const rows = clauseCoverage({ clauses, auditClauses: [], audits }, TODAY);
    expect(rows.every((r) => r.lastExaminedOn === null)).toBe(true);
    expect(rows.every((r) => r.covered === false && r.stale === false)).toBe(true);
  });

  it('counts an internal audit and NOT a certification body audit', () => {
    const rows = clauseCoverage({
      clauses,
      audits,
      auditClauses: [
        cover({ audit_id: 'a1', clause_id: 'c1' }),
        cover({ id: 'x2', audit_id: 'a2', clause_id: 'c2' }),
      ],
    }, TODAY);
    const byRef = Object.fromEntries(rows.map((r) => [r.clause_ref, r]));
    expect(byRef['7.1.5'].covered).toBe(true);
    expect(byRef['8.5.1'].covered).toBe(false);
  });

  it('separates never audited from audited before this cycle', () => {
    const rows = clauseCoverage({
      clauses,
      audits,
      auditClauses: [cover({ audit_id: 'a1', clause_id: 'c1', examined_on: '2021-01-01' })],
    }, TODAY);
    const byRef = Object.fromEntries(rows.map((r) => [r.clause_ref, r]));
    expect(byRef['7.1.5']).toMatchObject({ covered: false, stale: true });
    expect(byRef['8.5.1']).toMatchObject({ covered: false, stale: false });
  });

  it('a result with no date does not count as an examination', () => {
    const rows = clauseCoverage({
      clauses,
      audits,
      auditClauses: [cover({ audit_id: 'a1', clause_id: 'c1', examined_on: null })],
    }, TODAY);
    expect(rows.find((r) => r.clause_ref === '7.1.5').covered).toBe(false);
  });

  it('keeps the most recent examination when there are several', () => {
    const rows = clauseCoverage({
      clauses,
      audits,
      auditClauses: [
        cover({ audit_id: 'a1', clause_id: 'c1', examined_on: '2024-02-02' }),
        cover({ id: 'x2', audit_id: 'a1', clause_id: 'c1', examined_on: '2026-02-02' }),
      ],
    }, TODAY);
    expect(rows.find((r) => r.clause_ref === '7.1.5').lastExaminedOn).toBe('2026-02-02');
  });
});

describe('certification readiness is a list of blockers, not a percentage', () => {
  const ready = {
    clauses: [evidenced({ id: 'c1' })],
    findings: [],
    actions: [],
    audits: [audit({ id: 'a1', audit_type: 'Internal', status: 'Reported' })],
    auditClauses: [cover({ audit_id: 'a1', clause_id: 'c1', examined_on: '2026-09-10' })],
  };

  it('returns no percentage at all', () => {
    const verdict = certificationReadiness(standard(), ready, TODAY);
    expect(verdict).not.toHaveProperty('percent');
    expect(verdict).not.toHaveProperty('complianceRate');
    expect(verdict).not.toHaveProperty('score');
  });

  it('is READY when every applicable clause is evidenced and audited this cycle', () => {
    const verdict = certificationReadiness(standard(), ready, TODAY);
    expect(verdict.ready).toBe(true);
    expect(verdict.blockers.filter((b) => b.severity === 'blocking')).toEqual([]);
  });

  it('is NOT ready over one open major nonconformity', () => {
    const verdict = certificationReadiness(standard(), {
      ...ready,
      findings: [finding({ finding_type: 'Major nonconformity', status: 'Open' })],
    }, TODAY);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.some((b) => /major nonconformity is open/i.test(b.text))).toBe(true);
  });

  it('is NOT ready over a clause that no internal audit has examined', () => {
    const verdict = certificationReadiness(standard(), {
      ...ready, auditClauses: [],
    }, TODAY);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.some((b) => /never been examined/i.test(b.text))).toBe(true);
  });

  it('is NOT ready over a conformant claim with no evidence behind it', () => {
    const verdict = certificationReadiness(standard(), {
      ...ready,
      clauses: [{ ...evidenced({ id: 'c1' }), evidence_reference: null }],
    }, TODAY);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.some((b) => /no evidence/i.test(b.text))).toBe(true);
  });

  it('treats a stale audit as serious but not blocking, and says which it is', () => {
    const verdict = certificationReadiness(standard(), {
      ...ready,
      auditClauses: [cover({ audit_id: 'a1', clause_id: 'c1', examined_on: '2021-01-01' })],
    }, TODAY);
    // Never audited is blocking; audited outside the cycle is serious.
    expect(verdict.blockers.some(
      (b) => b.severity === 'serious' && /before this certification cycle/i.test(b.text))).toBe(true);
  });

  it('counts an empty register as a blocker rather than reporting it ready', () => {
    const verdict = certificationReadiness(standard(), {
      clauses: [], findings: [], actions: [], audits: [], auditClauses: [],
    }, TODAY);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers[0].text).toMatch(/no applicable clauses/i);
  });

  it('reports the certificate position without blocking on it', () => {
    const soon = certificationReadiness(
      standard({ certificate_expires: '2026-10-01' }), ready, TODAY);
    expect(soon.counts.certificateExpiring).toBe(true);
    expect(soon.counts.certificateExpired).toBe(false);
    expect(soon.ready).toBe(true);
    const gone = certificationReadiness(
      standard({ certificate_expires: '2026-01-01' }), ready, TODAY);
    expect(gone.counts.certificateExpired).toBe(true);
  });

  it('only counts the clauses and findings of the standard it was asked about', () => {
    const verdict = certificationReadiness(standard(), {
      ...ready,
      clauses: [...ready.clauses, clause({ id: 'z1', standard_id: 's2' })],
      findings: [finding({ standard_id: 's2', finding_type: 'Major nonconformity' })],
    }, TODAY);
    expect(verdict.counts.clauses).toBe(1);
    expect(verdict.ready).toBe(true);
  });

  it('honours the standard\'s own certification cycle length', () => {
    const rows = certificationReadiness(standard({ cycle_years: 1 }), {
      ...ready,
      auditClauses: [cover({ audit_id: 'a1', clause_id: 'c1', examined_on: '2024-09-10' })],
    }, TODAY);
    expect(rows.counts.staleAudited).toBe(1);
  });
});

describe('summary, sorting and grouping', () => {
  it('separates evidenced claims from claimed ones', () => {
    const s = summarise({
      clauses: [
        evidenced({ id: 'c1' }),
        { ...evidenced({ id: 'c2' }), evidence_reference: null },
      ],
    }, TODAY);
    expect(s.evidencedClaims).toBe(1);
    expect(s.unevidencedClaims).toBe(1);
  });

  it('counts open findings by type and the open majors on their own', () => {
    const s = summarise({
      findings: [
        finding({ id: 'f1', finding_type: 'Major nonconformity', status: 'Open' }),
        finding({ id: 'f2', finding_type: 'Major nonconformity', status: 'Closed' }),
        finding({ id: 'f3', finding_type: 'Observation', status: 'Open' }),
      ],
    }, TODAY);
    expect(s.byFindingType['Major nonconformity']).toBe(2);
    expect(s.openMajor).toBe(1);
    expect(s.openFindings).toBe(2);
  });

  it('counts actions done, verified and never checked', () => {
    const s = summarise({
      actions: [
        action({ id: 'a1', status: 'Complete', completed_at: '2026-09-01' }),
        action({
          id: 'a2', status: 'Complete', completed_at: '2026-09-01',
          effectiveness_verified: true, effectiveness_checked_at: '2026-09-10',
          effectiveness_verified_by: 'u1',
        }),
        action({
          id: 'a3', status: 'Complete', completed_at: '2026-09-01',
          effectiveness_verified: false, effectiveness_checked_at: '2026-09-10',
        }),
        action({ id: 'a4', status: 'Open', due_date: '2026-09-01' }),
      ],
    }, TODAY);
    expect(s.actionsAwaitingEffectiveness).toBe(1);
    expect(s.actionsVerifiedEffective).toBe(1);
    expect(s.actionsFoundIneffective).toBe(1);
    expect(s.overdueActions).toBe(1);
    expect(s.openActions).toBe(1);
  });

  it('returns zeros, not a crash, for an organization with nothing', () => {
    const s = summarise({}, TODAY);
    expect(s.clauses).toBe(0);
    expect(s.openFindings).toBe(0);
    expect(s.clausesNeverAudited).toBe(0);
  });

  it('puts an overdue major nonconformity first', () => {
    const rows = [
      finding({ id: 'f1', finding_type: 'Observation', status: 'Open' }),
      finding({ id: 'f2', finding_type: 'Major nonconformity', status: 'Closed' }),
      finding({ id: 'f3', finding_type: 'Major nonconformity', status: 'Open', due_date: '2026-08-01' }),
      finding({ id: 'f4', finding_type: 'Major nonconformity', status: 'Open', due_date: '2026-12-01' }),
    ];
    expect([...rows].sort(findingByUrgency(TODAY)).map((f) => f.id))
      .toEqual(['f3', 'f4', 'f1', 'f2']);
  });

  it('groups and labels an unset field instead of dropping it', () => {
    expect(countBy([{ department: 'Operations' }, {}], 'department'))
      .toEqual([{ name: 'Operations', count: 1 }, { name: 'Unspecified', count: 1 }]);
  });

  it('reuses the AS7 action helpers rather than restating them', () => {
    expect(isActionOpen(action())).toBe(true);
    expect(isActionOpen(action({ status: 'Complete' }))).toBe(false);
    expect(isActionOverdue(action({ due_date: '2026-09-16' }), TODAY)).toBe(true);
    expect(isActionOverdue(action({
      due_date: '2026-09-16', status: 'Complete',
    }), TODAY)).toBe(false);
  });
});

describe('AS15 owner decisions', () => {
  const ready = {
    clauses: [evidenced({ id: 'c1' })],
    findings: [],
    actions: [],
    audits: [audit({ id: 'a1', status: 'Reported' })],
    auditClauses: [cover({ audit_id: 'a1', clause_id: 'c1', examined_on: '2026-09-10' })],
  };

  it('Q4: only a Reported or Closed audit\'s examinations are coverage', () => {
    expect(COVERAGE_COUNTING_STATUSES).toEqual(['Reported', 'Closed']);
    ['Planned', 'In progress', 'Fieldwork complete', 'Cancelled'].forEach((status) => {
      const [row] = clauseCoverage({ ...ready, audits: [audit({ id: 'a1', status })] }, TODAY);
      expect(row.lastExaminedOn).toBeNull();
      expect(row.covered).toBe(false);
    });
    ['Reported', 'Closed'].forEach((status) => {
      const [row] = clauseCoverage({ ...ready, audits: [audit({ id: 'a1', status })] }, TODAY);
      expect(row.covered).toBe(true);
    });
  });

  it('Q4: an unreported examination leaves the clause blocking readiness as never audited', () => {
    const v = certificationReadiness(standard(),
      { ...ready, audits: [audit({ id: 'a1', status: 'In progress' })] }, TODAY);
    expect(v.ready).toBe(false);
    expect(v.counts.neverAudited).toBe(1);
  });

  it('Q5: the clause owner may not record its examination result', () => {
    const v = canExamineClause(clause({ owner_id: 'u5', clause_ref: '7.1.5' }), 'u5');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/7\.1\.5/);
    expect(canExamineClause(clause({ owner_id: 'u5' }), 'u6').ok).toBe(true);
    expect(canExamineClause(clause({ owner_id: null }), 'u6').ok).toBe(true);
    expect(canExamineClause(clause({ owner_id: 'u5' })).ok).toBe(true);
  });

  it('Q6: a lapsed certificate is a serious item, listed after the other serious ones', () => {
    const lapsed = certificationReadiness(
      standard({ certificate_expires: '2026-09-16' }),
      { ...ready, clauses: [...ready.clauses, clause({ id: 'c2', clause_ref: '8.5.1' })] }, TODAY);
    const sev = lapsed.blockers.map((b) => b.severity);
    expect(sev).toEqual([...sev].sort((a, b) =>
      ['blocking', 'serious', 'watch'].indexOf(a) - ['blocking', 'serious', 'watch'].indexOf(b)));
    const cert = lapsed.blockers.find((b) => /certificate expired/.test(b.text));
    expect(cert).toMatchObject({ severity: 'serious', count: 1 });
    expect(cert.text).toMatch(/1 day ago/);
  });

  it('Q6: expiring inside 90 days is a watch item, never blocking; 91 days says nothing', () => {
    const today = certificationReadiness(standard({ certificate_expires: '2026-09-17' }), ready, TODAY);
    expect(today.ready).toBe(true);
    expect(today.blockers).toEqual([expect.objectContaining({ severity: 'watch', count: 1 })]);
    const at90 = certificationReadiness(standard({ certificate_expires: '2026-12-16' }), ready, TODAY);
    expect(at90.blockers.map((b) => b.severity)).toEqual(['watch']);
    const at91 = certificationReadiness(standard({ certificate_expires: '2026-12-17' }), ready, TODAY);
    expect(at91.blockers).toEqual([]);
  });
});

describe('ASC-0 repairs', () => {
  const ready = {
    clauses: [evidenced({ id: 'c1' })],
    findings: [],
    actions: [],
    audits: [audit({ id: 'a1', status: 'Reported' })],
    auditClauses: [cover({ audit_id: 'a1', clause_id: 'c1', examined_on: '2026-09-10' })],
  };
  const flags = (expires, asOf = TODAY) => {
    const { counts } = certificationReadiness(standard({ certificate_expires: expires }), ready, asOf);
    return [counts.certificateDays, counts.certificateExpiring, counts.certificateExpired];
  };

  it('R3: expiring and expired partition the line, with the day of expiry expiring', () => {
    expect(flags('2026-09-16')).toEqual([-1, false, true]);
    expect(flags('2026-09-17')).toEqual([0, true, false]);
    expect(flags('2026-12-16')).toEqual([90, true, false]);
    expect(flags('2026-12-17')).toEqual([91, false, false]);
    // the Compliance course's repro: lapsed 15 days
    expect(flags('2026-09-30', new Date(2026, 9, 15))).toEqual([-15, false, true]);
  });

  it('R3: on the day of expiry the blocker says today', () => {
    const r = certificationReadiness(standard({ certificate_expires: '2026-09-17' }), ready, TODAY);
    expect(r.blockers.map((b) => b.text)).toContain('The certificate expires today. Book the recertification audit now.');
  });

  it('R5: the never-audited blocker names the standard the register holds', () => {
    const never = { ...ready, auditClauses: [] };
    const text = (s) => certificationReadiness(s, never, TODAY).blockers
      .find((b) => /internal audit/.test(b.text)).text;
    expect(text(standard())).toMatch(/ISO 9001:2015 §9\.2 requires the organization to audit its own system\.$/);
    expect(text(standard({ code: 'ISO 14001:2015' }))).toMatch(/ISO 14001:2015 §9\.2 requires/);
    expect(text(standard({ code: 'ISO 14001:2015' }))).not.toMatch(/9001/);
    expect(text(standard({ code: 'API Q1' }))).toMatch(/API Q1 requires the organization to audit its own system\.$/);
    expect(text({ id: 's1' })).toMatch(/The standard requires the organization to audit its own system\.$/);
  });

  it('R5: the not-applicable refusal names the standard, or none', () => {
    const na = (s) => canSetClauseStatus(clause(), 'Not applicable', { applicability: 'Not applicable' }, s).reason;
    expect(na(standard({ code: 'ISO 14001:2015' })))
      .toBe('Say why this requirement of ISO 14001:2015 does not apply. A requirement determined not applicable keeps its justification on record.');
    expect(na(undefined)).not.toMatch(/ISO/);
  });
});
