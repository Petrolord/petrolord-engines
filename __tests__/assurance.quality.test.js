/**
 * Ported from the Suite at AS12 (src/lib/__tests__/qualityAssurance.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS7 — the Quality Assurance authority under test.
 *
 * The app it replaces had no logic at all to test: six plans, two
 * checkpoints, two NCRs and two corrective actions, written out by hand
 * in src/data/qa-plan/, and a create form with no state. So these tests
 * are the first statement anywhere in the Suite of what a quality plan
 * and a non-conformance report actually enforce.
 *
 * Per gate-must-call-the-engine, every gate test includes the negative
 * control: the case that must be refused AND the case that must be
 * allowed. A gate that only ever says yes proves nothing.
 */
import {
  AGE_BANDS,
  BLOCKING_POINT_TYPES,
  CHECKPOINT_RESOLVED_STATUSES,
  CONCESSION_DISPOSITIONS,
  DISPOSITIONS,
  NCR_EFFECTIVENESS_REQUIRED,
  NCR_SEVERITIES,
  PLAN_STATUSES,
  POINT_TYPES,
  ageBand,
  canAdvancePlan,
  canCloseNcr,
  canClosePlan,
  canDecideCheckpoint,
  countBy,
  daysUntil,
  hasVerificationRecord,
  isBlockingPoint,
  isCapaOverdue,
  isCheckpointOverdue,
  isEffectivenessFailed,
  isEffectivenessVerified,
  isNcrOpen,
  isNcrOverdue,
  isResolved,
  ncrAgeDays,
  ncrAgeing,
  ncrByUrgency,
  nextPlanStatuses,
  parseDateOnly,
  planProgress,
  summarise,
  toDateOnlyString,
} from '../engines/assurance/qualityAssurance.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local

const plan = (over = {}) => ({
  id: 'p1', plan_code: 'QAP-2026-001', title: 'Subsea tie-back ITP', status: 'Active', ...over,
});
const chk = (over = {}) => ({
  id: 'c1', plan_id: 'p1', item_no: '1.1', title: 'Material certificate verification',
  point_type: 'Review point', status: 'Pending', ...over,
});
const ncr = (over = {}) => ({
  id: 'n1', ncr_code: 'NCR-2026-001', title: 'Flange out of tolerance',
  severity: 'Minor', status: 'Open', raised_date: '2026-09-01', ...over,
});
const capa = (over = {}) => ({
  id: 'k1', ncr_id: 'n1', action_type: 'Corrective', description: 'Rework the flange face',
  status: 'Open', ...over,
});

const verified = (over = {}) => capa({
  status: 'Complete',
  completed_at: '2026-09-10T00:00:00Z',
  effectiveness_verified: true,
  effectiveness_checked_at: '2026-09-15',
  effectiveness_verified_by: 'u1',
  ...over,
});

describe('dates', () => {
  it('parses a calendar date at LOCAL midnight, not UTC', () => {
    // new Date('2026-09-17') is UTC midnight, which is 16 September
    // anywhere west of Greenwich. An NCR a day overdue is a wrong
    // answer, not a rounding one. (The AS3 gotcha.)
    const d = parseDateOnly('2026-09-17');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(17);
  });

  it('round-trips through toDateOnlyString', () => {
    expect(toDateOnlyString('2026-09-17')).toBe('2026-09-17');
    expect(toDateOnlyString(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toDateOnlyString(null)).toBeNull();
    expect(toDateOnlyString('not a date')).toBeNull();
  });

  it('counts days to a date and back from one', () => {
    expect(daysUntil('2026-09-17', TODAY)).toBe(0);
    expect(daysUntil('2026-09-20', TODAY)).toBe(3);
    expect(daysUntil('2026-09-10', TODAY)).toBe(-7);
    expect(daysUntil(null, TODAY)).toBeNull();
  });
});

describe('the hold point is the only intervention that stops work', () => {
  it('names exactly one blocking type', () => {
    expect(BLOCKING_POINT_TYPES).toEqual(['Hold point']);
    expect(POINT_TYPES).toContain('Witness point');
    expect(isBlockingPoint(chk({ point_type: 'Hold point' }))).toBe(true);
    expect(isBlockingPoint(chk({ point_type: 'Witness point' }))).toBe(false);
  });

  it('does NOT count a failed checkpoint as resolved', () => {
    // A failed inspection is the most outstanding item on a plan: it is
    // what raises the NCR. Treating Failed as "done" would let a plan
    // report 100% complete on a failed hydrotest.
    expect(CHECKPOINT_RESOLVED_STATUSES).not.toContain('Failed');
    expect(isResolved(chk({ status: 'Failed' }))).toBe(false);
    expect(isResolved(chk({ status: 'Passed' }))).toBe(true);
    expect(isResolved(chk({ status: 'Waived' }))).toBe(true);
    expect(isResolved(chk({ status: 'Not applicable' }))).toBe(true);
  });
});

describe('a decided checkpoint carries the date and the verifier', () => {
  it('refuses Passed with nothing recorded', () => {
    const v = canDecideCheckpoint(chk({ point_type: 'Hold point' }), 'Passed');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hold point needs the date/i);
  });

  it('refuses Passed with a date but no name', () => {
    const v = canDecideCheckpoint(chk(), 'Passed', { result_date: '2026-09-17' });
    expect(v.ok).toBe(false);
  });

  it('allows Passed with a date and a Suite user', () => {
    expect(canDecideCheckpoint(chk(), 'Passed', {
      result_date: '2026-09-17', verified_by: 'u1',
    }).ok).toBe(true);
  });

  it('allows a named third party who has no Suite login', () => {
    // A certifying authority surveyor is not a user of this platform.
    expect(hasVerificationRecord({ result_date: '2026-09-17', verifier_name: 'Lloyds surveyor' }))
      .toBe(true);
    expect(hasVerificationRecord({ result_date: '2026-09-17', verifier_name: '   ' }))
      .toBe(false);
  });

  it('refuses a waiver with no reason and allows one with a reason', () => {
    const bad = canDecideCheckpoint(chk(), 'Waived', {
      result_date: '2026-09-17', verified_by: 'u1',
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/why this point is being waived/i);

    expect(canDecideCheckpoint(chk(), 'Waived', {
      result_date: '2026-09-17',
      verified_by: 'u1',
      remarks: "Covered by the vendor's own third-party release note",
    }).ok).toBe(true);
  });

  it('needs nothing to mark a checkpoint Notified or In progress', () => {
    expect(canDecideCheckpoint(chk(), 'Notified').ok).toBe(true);
    expect(canDecideCheckpoint(chk(), 'In progress').ok).toBe(true);
  });

  it('refuses a status that is not one of the seven', () => {
    expect(canDecideCheckpoint(chk(), 'Signed off').ok).toBe(false);
  });

  it('counts a checkpoint overdue only while it is unresolved', () => {
    expect(isCheckpointOverdue(chk({ planned_date: '2026-09-01' }), TODAY)).toBe(true);
    expect(isCheckpointOverdue(chk({ planned_date: '2026-09-30' }), TODAY)).toBe(false);
    expect(isCheckpointOverdue(
      chk({ planned_date: '2026-09-01', status: 'Passed' }), TODAY)).toBe(false);
    expect(isCheckpointOverdue(chk({ planned_date: null }), TODAY)).toBe(false);
  });
});

describe('progress is counted, not typed', () => {
  it('is null, not zero, for a plan with no ITP', () => {
    // A plan with nothing in its inspection and test plan is not 0%
    // complete: it has no ITP. The register said 10% for one of these.
    expect(planProgress([]).percent).toBeNull();
  });

  it('counts the resolved fraction', () => {
    const p = planProgress([
      chk({ status: 'Passed' }),
      chk({ status: 'Waived', remarks: 'x' }),
      chk({ status: 'Pending' }),
      chk({ status: 'Failed' }),
    ]);
    expect(p.total).toBe(4);
    expect(p.resolved).toBe(2);
    expect(p.failed).toBe(1);
    expect(p.outstanding).toBe(2);
    expect(p.percent).toBe(50);
  });

  it('reports outstanding hold points separately', () => {
    const p = planProgress([
      chk({ point_type: 'Hold point', status: 'Pending' }),
      chk({ point_type: 'Hold point', status: 'Passed' }),
      chk({ point_type: 'Witness point', status: 'Pending' }),
    ]);
    expect(p.holdPoints).toBe(2);
    expect(p.holdPointsOutstanding).toBe(1);
  });
});

describe('a non-conformance report closes on evidence', () => {
  it('refuses closure with no disposition', () => {
    const v = canCloseNcr(ncr(), []);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/disposition first/i);
  });

  it('refuses a disposition with no date', () => {
    const v = canCloseNcr(ncr({ disposition: 'Rework' }), []);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/date the disposition was agreed/i);
  });

  it('closes a MINOR non-conformance on the disposition alone', () => {
    // Proportionality is part of the rule, not an exception to it.
    expect(canCloseNcr(ncr({
      severity: 'Minor', disposition: 'Rework', disposition_date: '2026-09-10',
    }), []).ok).toBe(true);
  });

  it('closes an OBSERVATION the same way', () => {
    expect(canCloseNcr(ncr({
      severity: 'Observation', disposition: 'Use as is', disposition_date: '2026-09-10',
    }), []).ok).toBe(true);
  });

  it('refuses a MAJOR non-conformance with no root cause', () => {
    const v = canCloseNcr(ncr({
      severity: 'Major', disposition: 'Rework', disposition_date: '2026-09-10',
    }), [verified()]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/needs a root cause/i);
  });

  it('refuses a MAJOR non-conformance with no corrective action at all', () => {
    // A disposition deals with the item. A corrective action deals with
    // the cause. They are not the same decision.
    const v = canCloseNcr(ncr({
      severity: 'Major',
      disposition: 'Rework',
      disposition_date: '2026-09-10',
      root_cause: 'Superseded drawing revision issued to the vendor',
    }), []);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/at least one corrective action/i);
  });

  it('refuses while any action is still open', () => {
    const v = canCloseNcr(ncr({
      severity: 'Major',
      disposition: 'Rework',
      disposition_date: '2026-09-10',
      root_cause: 'x',
    }), [verified(), capa({ id: 'k2', status: 'In progress' })]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/still open/i);
  });

  it('REFUSES A MAJOR NCR WHOSE ACTIONS ARE DONE BUT UNVERIFIED', () => {
    // The rule this app exists for. A completed corrective action is
    // not a working corrective action.
    const v = canCloseNcr(ncr({
      severity: 'Major',
      disposition: 'Rework',
      disposition_date: '2026-09-10',
      root_cause: 'x',
    }), [capa({ status: 'Complete', completed_at: '2026-09-10T00:00:00Z' })]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/verified effective/i);
  });

  it('allows it once one corrective action is verified effective', () => {
    expect(canCloseNcr(ncr({
      severity: 'Major',
      disposition: 'Rework',
      disposition_date: '2026-09-10',
      root_cause: 'x',
    }), [verified()]).ok).toBe(true);
  });

  it('refuses when the only check found the action did NOT work', () => {
    // "Not effective" is a real answer and it must not close anything.
    const v = canCloseNcr(ncr({
      severity: 'Critical',
      disposition: 'Rework',
      disposition_date: '2026-09-10',
      root_cause: 'x',
    }), [capa({
      status: 'Complete',
      completed_at: '2026-09-10T00:00:00Z',
      effectiveness_verified: false,
      effectiveness_checked_at: '2026-09-15',
      effectiveness_verified_by: 'u1',
    })]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not to have worked/i);
  });

  it('allows it when a later action did work', () => {
    expect(canCloseNcr(ncr({
      severity: 'Critical',
      disposition: 'Rework',
      disposition_date: '2026-09-10',
      root_cause: 'x',
    }), [
      capa({
        id: 'k1',
        status: 'Complete',
        completed_at: '2026-09-10T00:00:00Z',
        effectiveness_verified: false,
        effectiveness_checked_at: '2026-09-11',
        effectiveness_verified_by: 'u1',
      }),
      verified({ id: 'k2' }),
    ]).ok).toBe(true);
  });

  it('ignores a CANCELLED corrective action when looking for one', () => {
    const v = canCloseNcr(ncr({
      severity: 'Major',
      disposition: 'Rework',
      disposition_date: '2026-09-10',
      root_cause: 'x',
    }), [capa({ status: 'Cancelled' })]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/at least one corrective action/i);
  });

  it('refuses to close something already closed or voided', () => {
    expect(canCloseNcr(ncr({ status: 'Closed' }), []).ok).toBe(false);
    expect(canCloseNcr(ncr({ status: 'Voided' }), []).ok).toBe(false);
  });

  it('will not accept an effectiveness claim with no date or name', () => {
    expect(isEffectivenessVerified({ effectiveness_verified: true })).toBe(false);
    expect(isEffectivenessVerified({
      effectiveness_verified: true, effectiveness_checked_at: '2026-09-15',
    })).toBe(false);
    expect(isEffectivenessVerified(verified())).toBe(true);
    expect(isEffectivenessFailed({ effectiveness_verified: false })).toBe(true);
    expect(isEffectivenessFailed({ effectiveness_verified: true })).toBe(false);
  });
});

describe('a quality plan closes when nothing is waiting on it', () => {
  it('refuses over an outstanding HOLD point and names it', () => {
    const v = canClosePlan(plan(), {
      checkpoints: [chk({ item_no: '3.2', point_type: 'Hold point', status: 'Pending' })],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hold point/i);
    expect(v.reason).toContain('3.2');
  });

  it('DOES NOT refuse over an outstanding witness point', () => {
    // The negative control for the distinction that matters. A witness
    // point is a notification; work proceeds if the party does not
    // attend, so an unattended one does not hold the plan open.
    expect(canClosePlan(plan(), {
      checkpoints: [chk({ point_type: 'Witness point', status: 'Pending' })],
    }).ok).toBe(true);
    expect(canClosePlan(plan(), {
      checkpoints: [chk({ point_type: 'Surveillance point', status: 'Notified' })],
    }).ok).toBe(true);
  });

  it('refuses over a FAILED checkpoint whatever its type', () => {
    const v = canClosePlan(plan(), {
      checkpoints: [chk({ point_type: 'Review point', status: 'Failed' })],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/failed/i);
  });

  it('refuses over an open non-conformance raised against it', () => {
    const v = canClosePlan(plan(), {
      checkpoints: [chk({ status: 'Passed' })],
      ncrs: [ncr({ status: 'Under investigation' })],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/still open/i);
  });

  it('allows closure once the hold points are resolved and the NCRs are not open', () => {
    expect(canClosePlan(plan(), {
      checkpoints: [
        chk({ point_type: 'Hold point', status: 'Passed' }),
        chk({ point_type: 'Witness point', status: 'Pending' }),
      ],
      ncrs: [ncr({ status: 'Closed' }), ncr({ id: 'n2', status: 'Voided' })],
    }).ok).toBe(true);
  });

  it('allows closure of a plan with no ITP and no NCRs', () => {
    expect(canClosePlan(plan(), {}).ok).toBe(true);
  });

  it('refuses to close a plan that is already closed', () => {
    expect(canClosePlan(plan({ status: 'Closed' }), {}).ok).toBe(false);
  });
});

describe('plan status transitions', () => {
  it('knows where a plan may go next', () => {
    expect(nextPlanStatuses('Draft')).toEqual(['Under review', 'Active', 'Cancelled']);
    expect(nextPlanStatuses('Closed')).toEqual([]);
    expect(nextPlanStatuses('nonsense')).toEqual([]);
  });

  it('refuses a jump the workflow does not allow', () => {
    const v = canAdvancePlan(plan({ status: 'Draft' }), 'Closed', {});
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/can only move to/i);
  });

  it('runs the closure gate when the destination is Closed', () => {
    const v = canAdvancePlan(plan({ status: 'Active' }), 'Closed', {
      checkpoints: [chk({ point_type: 'Hold point', status: 'Pending' })],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hold point/i);
  });

  it('allows Active to Superseded without the closure gate', () => {
    // Superseding a plan is issuing a new revision, not finishing the
    // work, so the outstanding hold points travel to the new plan.
    expect(canAdvancePlan(plan({ status: 'Active' }), 'Superseded', {
      checkpoints: [chk({ point_type: 'Hold point', status: 'Pending' })],
    }).ok).toBe(true);
  });
});

describe('ageing and overdue', () => {
  it('ages an open NCR to today and a closed one to its closure', () => {
    expect(ncrAgeDays(ncr({ raised_date: '2026-09-01' }), TODAY)).toBe(16);
    expect(ncrAgeDays(ncr({
      raised_date: '2026-09-01', status: 'Closed', closed_date: '2026-09-05',
    }), TODAY)).toBe(4);
    expect(ncrAgeDays({ }, TODAY)).toBeNull();
  });

  it('bands an age', () => {
    expect(ageBand(0)).toBe('0 to 30 days');
    expect(ageBand(30)).toBe('0 to 30 days');
    expect(ageBand(31)).toBe('31 to 60 days');
    expect(ageBand(400)).toBe('Over 90 days');
    expect(ageBand(null)).toBeNull();
    expect(AGE_BANDS).toHaveLength(4);
  });

  it('counts overdue only while open', () => {
    expect(isNcrOverdue(ncr({ due_date: '2026-09-01' }), TODAY)).toBe(true);
    expect(isNcrOverdue(ncr({ due_date: '2026-09-01', status: 'Closed' }), TODAY)).toBe(false);
    expect(isNcrOverdue(ncr({ due_date: null }), TODAY)).toBe(false);
    expect(isCapaOverdue(capa({ due_date: '2026-09-01' }), TODAY)).toBe(true);
    expect(isCapaOverdue(capa({ due_date: '2026-09-01', status: 'Complete' }), TODAY)).toBe(false);
  });

  it('treats Verification as still open', () => {
    // An NCR in verification is not closed. The old register had two
    // statuses, Open and Closed, and everything in between was Open.
    expect(isNcrOpen(ncr({ status: 'Verification' }))).toBe(true);
    expect(isNcrOpen(ncr({ status: 'Closed' }))).toBe(false);
    expect(isNcrOpen(ncr({ status: 'Voided' }))).toBe(false);
  });

  it('builds an ageing table by severity', () => {
    const rows = ncrAgeing([
      ncr({ id: 'a', severity: 'Major', raised_date: '2026-09-10' }),
      ncr({ id: 'b', severity: 'Major', raised_date: '2026-06-01' }),
      ncr({ id: 'c', severity: 'Minor', raised_date: '2026-09-16', status: 'Closed', closed_date: '2026-09-16' }),
    ], TODAY);
    expect(rows).toHaveLength(4);
    expect(rows[0].Major).toBe(1);
    expect(rows[3].Major).toBe(1);
    // The closed one is not in the ageing table at all.
    expect(rows.reduce((a, r) => a + r.Minor, 0)).toBe(0);
  });
});

describe('summarise replaces the literals', () => {
  it('counts outstanding checkpoints instead of reporting 12', () => {
    // The dashboard's "Pending Checks" tile was the number 12.
    const s = summarise({
      plans: [plan(), plan({ id: 'p2', status: 'Draft' })],
      checkpoints: [
        chk({ status: 'Pending', point_type: 'Hold point' }),
        chk({ status: 'Passed' }),
        chk({ status: 'Failed' }),
      ],
      ncrs: [ncr({ severity: 'Major' }), ncr({ id: 'n2', status: 'Closed' })],
      capas: [capa(), verified({ id: 'k2' })],
    }, TODAY);

    expect(s.plans).toBe(2);
    expect(s.activePlans).toBe(1);
    expect(s.checkpointsOutstanding).toBe(2);
    expect(s.holdPointsOutstanding).toBe(1);
    expect(s.checkpointsFailed).toBe(1);
    expect(s.openNcrs).toBe(1);
    expect(s.seriousOpen).toBe(1);
    expect(s.openCapas).toBe(1);
    expect(s.capasVerifiedEffective).toBe(1);
  });

  it('counts completed actions nobody went back to check', () => {
    const s = summarise({
      capas: [
        capa({ status: 'Complete', completed_at: '2026-09-01T00:00:00Z' }),
        verified({ id: 'k2' }),
      ],
    }, TODAY);
    expect(s.capasAwaitingEffectiveness).toBe(1);
  });

  it('counts concessions, the dispositions an auditor asks about', () => {
    expect(CONCESSION_DISPOSITIONS.every((d) => DISPOSITIONS.includes(d))).toBe(true);
    const s = summarise({
      ncrs: [
        ncr({ disposition: 'Use as is' }),
        ncr({ id: 'n2', disposition: 'Rework' }),
      ],
    }, TODAY);
    expect(s.concessions).toBe(1);
  });

  it('reports the oldest open NCR and the mean age', () => {
    const s = summarise({
      ncrs: [
        ncr({ id: 'a', raised_date: '2026-09-07' }),
        ncr({ id: 'b', raised_date: '2026-09-17' }),
      ],
    }, TODAY);
    expect(s.oldestOpenNcrDays).toBe(10);
    expect(s.meanOpenNcrAgeDays).toBe(5);
  });

  it('returns zeros, not a crash, for an organization with nothing', () => {
    const s = summarise({}, TODAY);
    expect(s.plans).toBe(0);
    expect(s.openNcrs).toBe(0);
    expect(s.oldestOpenNcrDays).toBeNull();
  });
});

describe('sorting and grouping', () => {
  it('puts an overdue major non-conformance first', () => {
    const rows = [
      ncr({ id: 'closed', status: 'Closed' }),
      ncr({ id: 'openMinor', severity: 'Minor' }),
      ncr({ id: 'overdueMajor', severity: 'Major', due_date: '2026-09-01' }),
      ncr({ id: 'openMajor', severity: 'Major', due_date: '2026-12-01' }),
    ];
    expect([...rows].sort(ncrByUrgency(TODAY)).map((r) => r.id))
      .toEqual(['overdueMajor', 'openMajor', 'openMinor', 'closed']);
  });

  it('groups and labels an unset field instead of dropping it', () => {
    expect(countBy([{ x: 'a' }, { x: 'a' }, { x: null }], 'x'))
      .toEqual([{ name: 'a', count: 2 }, { name: 'Unspecified', count: 1 }]);
  });
});

// Kept separate so the assertion above reads as a statement about the
// transition table rather than about an import.
const PLAN_TRANSITIONS_KEYS = {
  Draft: 1, 'Under review': 1, Active: 1, Superseded: 1, Closed: 1, Cancelled: 1,
};
