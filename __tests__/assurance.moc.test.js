/**
 * Ported from the Suite at AS12 (src/lib/__tests__/managementOfChange.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS6 — the Management of Change authority.
 *
 * The approval gate, the action ordering and the temporary-change
 * expiry are the three things the discipline exists for, and none of
 * them existed in the app: every page was a literal and no stage change
 * was ever checked against anything.
 */
import {
  ACTION_TYPES,
  APPROVAL_STATUSES,
  CATEGORIES,
  CHANGE_TYPES,
  EXPIRY,
  EXPIRY_LEAD_DAYS,
  IMPACT_SEVERITIES,
  RISK_LEVELS,
  STAGES,
  approvalState,
  byUrgency,
  canAdvance,
  countBy,
  daysUntil,
  expiryState,
  isExpired,
  isOverdue,
  nextStages,
  parseDateOnly,
  summarise,
  toDateOnlyString,
  EMERGENCY_RATIFY_DAYS,
  RATIFICATION,
  canAssignApprover,
  canDecideApproval,
  ratificationState,
} from '../engines/assurance/managementOfChange.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local midnight

const moc = (over = {}) => ({
  type: 'Permanent',
  stage: 'Review',
  target_implementation_date: '2026-12-31',
  ...over,
});

const approval = (over = {}) => ({ level: 1, status: 'Approved', ...over });
const action = (over = {}) => ({ action_type: 'Pre-implementation', status: 'Open', ...over });

describe('dates', () => {
  it('parses a date-only value at LOCAL midnight, not UTC', () => {
    const d = parseDateOnly('2026-09-17');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 17, 0]);
  });

  it('counts whole calendar days, signed', () => {
    expect(daysUntil('2026-09-17', TODAY)).toBe(0);
    expect(daysUntil('2026-09-10', TODAY)).toBe(-7);
    expect(daysUntil(null, TODAY)).toBeNull();
  });

  it('round-trips a date-only string', () => {
    expect(toDateOnlyString('2026-09-17')).toBe('2026-09-17');
    expect(toDateOnlyString('rubbish')).toBeNull();
  });
});

describe('temporary change expiry', () => {
  const temp = (over = {}) => moc({ type: 'Temporary', stage: 'Implementation', ...over });

  it('is expired the day after the expiry date and not before', () => {
    expect(isExpired(temp({ expiry_date: '2026-09-17' }), TODAY)).toBe(false);
    expect(isExpired(temp({ expiry_date: '2026-09-16' }), TODAY)).toBe(true);
  });

  it('warns inside the lead time', () => {
    expect(EXPIRY_LEAD_DAYS).toBe(14);
    expect(expiryState(temp({ expiry_date: '2026-09-25' }), TODAY)).toBe(EXPIRY.EXPIRING);
    expect(expiryState(temp({ expiry_date: '2026-11-01' }), TODAY)).toBe(EXPIRY.WITHIN);
  });

  it('applies to emergency changes as well as temporary ones', () => {
    expect(isExpired(temp({ type: 'Emergency', expiry_date: '2026-01-01' }), TODAY)).toBe(true);
  });

  it('never applies to a permanent change', () => {
    expect(expiryState(moc({ type: 'Permanent', stage: 'Implementation', expiry_date: '2020-01-01' }), TODAY))
      .toBe(EXPIRY.NOT_APPLICABLE);
    expect(isExpired(moc({ type: 'Permanent', expiry_date: '2020-01-01' }), TODAY)).toBe(false);
  });

  it('only counts a change that is actually on the facility', () => {
    // A temporary change still in Review is not running anywhere, so
    // its expiry date is a plan and not a breach. One that was
    // rejected or cancelled never happened at all.
    ['Draft', 'Screening', 'Review', 'Approval', 'Rejected', 'Cancelled'].forEach((stage) => {
      expect(isExpired(temp({ stage, expiry_date: '2020-01-01' }), TODAY)).toBe(false);
    });
    expect(isExpired(temp({ stage: 'Implementation', expiry_date: '2020-01-01' }), TODAY)).toBe(true);
  });

  it('says so when a live temporary change has no expiry at all', () => {
    expect(expiryState(temp({ expiry_date: null }), TODAY)).toBe(EXPIRY.NONE);
  });
});

describe('overdue implementation', () => {
  it('is overdue the day after the target and not before', () => {
    expect(isOverdue(moc({ target_implementation_date: '2026-09-17' }), TODAY)).toBe(false);
    expect(isOverdue(moc({ target_implementation_date: '2026-09-16' }), TODAY)).toBe(true);
  });

  it('does not chase a change that is finished', () => {
    ['Closed', 'Rejected', 'Cancelled'].forEach((stage) => {
      expect(isOverdue(moc({ stage, target_implementation_date: '2020-01-01' }), TODAY)).toBe(false);
    });
  });

  // RC-3 (ASC-0): a change in Implementation is on the facility, so it is
  // not late to be implemented. Late work after that is its actions.
  it('asks only before the change is on the facility', () => {
    ['Draft', 'Screening', 'Review', 'Approval'].forEach((stage) => {
      expect(isOverdue(moc({ stage, target_implementation_date: '2020-01-01' }), TODAY)).toBe(true);
    });
    expect(isOverdue(moc({
      stage: 'Implementation', target_implementation_date: '2026-09-10', actual_implementation_date: '2026-09-10',
    }), TODAY)).toBe(false);
  });

  it('a change implemented on its target date is not counted overdue or ranked as overdue', () => {
    const inEffect = moc({ id: 'impl', stage: 'Implementation', type: 'Permanent', target_implementation_date: '2026-09-10' });
    const late = moc({ id: 'late', stage: 'Approval', type: 'Permanent', target_implementation_date: '2026-09-12' });
    const live = moc({ id: 'live', stage: 'Review', type: 'Permanent', target_implementation_date: '2026-09-01' });
    expect(summarise([inEffect, late], {}, TODAY).overdue).toBe(1);
    // live is overdue (Review, past target) and ranks with late; inEffect
    // ranks with live work after them.
    const order = [inEffect, late, live].sort(byUrgency(TODAY)).map((m) => m.id);
    expect(order).toEqual(['live', 'late', 'impl']);
  });
});

describe('the multi-level approval gate', () => {
  it('is complete only when every level has signed', () => {
    const state = approvalState([
      approval({ level: 1, status: 'Approved' }),
      approval({ level: 2, status: 'Pending' }),
    ]);
    expect(state.levels).toEqual([1, 2]);
    expect(state.outstanding).toEqual([2]);
    expect(state.complete).toBe(false);
  });

  it('is complete when all levels have at least one approval', () => {
    expect(approvalState([
      approval({ level: 1 }),
      approval({ level: 2 }),
    ]).complete).toBe(true);
  });

  it('takes one approval per level, not one per person', () => {
    // Two technical authorities at level 1; either signing clears it.
    expect(approvalState([
      approval({ level: 1, approver_id: 'a', status: 'Approved' }),
      approval({ level: 1, approver_id: 'b', status: 'Pending' }),
    ]).complete).toBe(true);
  });

  it('is never complete while anyone has rejected', () => {
    const state = approvalState([
      approval({ level: 1, status: 'Approved' }),
      approval({ level: 2, status: 'Rejected' }),
    ]);
    expect(state.rejected).toHaveLength(1);
    expect(state.complete).toBe(false);
  });

  it('is not complete when there are no approvers at all', () => {
    // An empty approval list is not a passed gate. This is the failure
    // mode a naive `every()` would produce.
    expect(approvalState([]).complete).toBe(false);
  });
});

describe('advancing a change', () => {
  const approved = [approval({ level: 1 }), approval({ level: 2 })];

  it('refuses a stage that is not next', () => {
    const result = canAdvance(moc({ stage: 'Draft' }), 'Implementation');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/can only move to/);
  });

  it('refuses to implement while an approval level has not signed', () => {
    const result = canAdvance(moc({ stage: 'Approval' }), 'Implementation', {
      approvals: [approval({ level: 1 }), approval({ level: 2, status: 'Pending' })],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/level 2 has not signed/i);
  });

  it('refuses to implement when nobody has been asked to approve', () => {
    const result = canAdvance(moc({ stage: 'Approval' }), 'Implementation', { approvals: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/No approvers have been assigned/);
  });

  it('refuses to implement a rejected change outright', () => {
    const result = canAdvance(moc({ stage: 'Approval' }), 'Implementation', {
      approvals: [approval({ level: 1, status: 'Rejected' })],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/rejected/i);
  });

  it('refuses to implement while pre-implementation actions are open', () => {
    // They exist to be done before the change goes in. That ordering
    // is the whole point of splitting the action list.
    const result = canAdvance(moc({ stage: 'Approval' }), 'Implementation', {
      approvals: approved,
      actions: [action({ action_type: 'Pre-implementation', status: 'Open' })],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pre-implementation action/i);
  });

  it('does not let a POST-implementation action block implementation', () => {
    const result = canAdvance(moc({ stage: 'Approval' }), 'Implementation', {
      approvals: approved,
      actions: [action({ action_type: 'Post-implementation', status: 'Open' })],
    });
    expect(result.ok).toBe(true);
  });

  it('refuses to implement a temporary change with no expiry date', () => {
    const result = canAdvance(
      moc({ stage: 'Approval', type: 'Temporary', expiry_date: null }),
      'Implementation',
      { approvals: approved },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expiry date/);
  });

  it('allows implementation once every gate is satisfied', () => {
    expect(canAdvance(moc({ stage: 'Approval' }), 'Implementation', {
      approvals: approved,
      actions: [action({ status: 'Complete' })],
    }).ok).toBe(true);
  });

  it('refuses to close while implementation actions are open', () => {
    const result = canAdvance(moc({ stage: 'Implementation' }), 'Closed', {
      actions: [action({ action_type: 'Post-implementation', status: 'Open' })],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/post-implementation action/i);
  });

  it('treats a cancelled action as not blocking', () => {
    expect(canAdvance(moc({ stage: 'Implementation' }), 'Closed', {
      actions: [action({ action_type: 'Post-implementation', status: 'Cancelled' })],
    }).ok).toBe(true);
  });

  it('always allows cancelling a live change', () => {
    ACTION_TYPES.forEach(() => {});
    ['Draft', 'Screening', 'Review', 'Approval', 'Implementation'].forEach((stage) => {
      expect(nextStages(stage)).toContain('Cancelled');
    });
  });

  it('treats closed, rejected and cancelled as final', () => {
    ['Closed', 'Rejected', 'Cancelled'].forEach((stage) => {
      expect(nextStages(stage)).toEqual([]);
      expect(canAdvance(moc({ stage }), 'Draft').reason).toMatch(/final/);
    });
  });
});

describe('rollup', () => {
  const records = [
    moc({ id: 1, type: 'Temporary', stage: 'Implementation', expiry_date: '2025-01-01' }),
    moc({ id: 2, type: 'Temporary', stage: 'Implementation', expiry_date: '2026-09-25' }),
    moc({ id: 3, stage: 'Approval', target_implementation_date: '2025-01-01' }),
    moc({ id: 4, stage: 'Closed', risk_level: 'High' }),
  ];
  const actions = [
    action({ status: 'Open', due_date: '2025-01-01' }),
    action({ status: 'Complete', due_date: '2025-01-01' }),
  ];

  it('counts expired temporary changes, which the app never showed at all', () => {
    const s = summarise(records, { actions }, TODAY);
    expect(s.expired).toBe(1);
    expect(s.expiringSoon).toBe(1);
    expect(s.overdue).toBe(1);
    expect(s.awaitingApproval).toBe(1);
    expect(s.active).toBe(3);
    expect(s.openActions).toBe(1);
    expect(s.overdueActions).toBe(1);
  });

  it('counts every record into exactly one stage', () => {
    const s = summarise(records, { actions }, TODAY);
    expect(Object.values(s.byStage).reduce((a, b) => a + b, 0)).toBe(records.length);
  });

  it('sorts an expired temporary change above everything else', () => {
    // It is the one actually on the facility without authority.
    const order = [...records].sort(byUrgency(TODAY)).map((m) => m.id);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('groups by a field and labels rows that do not say', () => {
    expect(countBy([{ category: 'Other' }, { category: null }], 'category'))
      .toEqual([{ name: 'Other', count: 1 }, { name: 'Unspecified', count: 1 }]);
  });

});

describe('AS14: actions on finished changes', () => {
  it('are not open or overdue work; actions whose change is unknown still count', () => {
    const records = [moc({ id: 'r', stage: 'Rejected' }), moc({ id: 'c', stage: 'Cancelled' }),
      moc({ id: 'l', stage: 'Implementation' })];
    const actions = [
      action({ moc_id: 'r', due_date: '2026-01-01' }),
      action({ moc_id: 'c' }),
      action({ moc_id: 'l', due_date: '2026-09-01' }),
      action({ moc_id: 'elsewhere' }),
    ];
    const s = summarise(records, { actions }, TODAY);
    expect(s.openActions).toBe(2);
    expect(s.overdueActions).toBe(1);
  });
});

describe('AS15: emergency-change authority', () => {
  const em = (over = {}) => moc({ type: 'Emergency', stage: 'Approval', expiry_date: '2026-10-30', ...over });
  const first = [approval({ level: 1 }), approval({ level: 2, status: 'Pending' })];

  it('an emergency change goes in once its first level has signed; other types still need every level', () => {
    expect(canAdvance(em(), 'Implementation', { approvals: first }).ok).toBe(true);
    expect(canAdvance(moc({ stage: 'Approval', type: 'Temporary', expiry_date: '2026-10-30' }),
      'Implementation', { approvals: first }).ok).toBe(false);
    const late = [approval({ level: 1, status: 'Pending' }), approval({ level: 2 })];
    expect(canAdvance(em(), 'Implementation', { approvals: late }).ok).toBe(false);
    const rejected = [approval({ level: 1 }), approval({ level: 2, status: 'Rejected' })];
    expect(canAdvance(em(), 'Implementation', { approvals: rejected }).ok).toBe(false);
    expect(canAdvance(em(), 'Implementation', { approvals: [] }).ok).toBe(false);
  });

  it('cannot close until every level has ratified', () => {
    const live = em({ stage: 'Implementation' });
    const v = canAdvance(live, 'Closed', { approvals: first });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/level 2/);
    expect(canAdvance(live, 'Closed', { approvals: [approval({ level: 1 }), approval({ level: 2 })] }).ok).toBe(true);
  });

  it('gives seven days after implementation, then reads overdue; no date reads overdue', () => {
    expect(EMERGENCY_RATIFY_DAYS).toBe(7);
    const at = (d) => ratificationState(em({ stage: 'Implementation', actual_implementation_date: d }), first, TODAY);
    expect(at('2026-09-10T09:00:00').state).toBe(RATIFICATION.PENDING);
    expect(at('2026-09-10T09:00:00').dueDate).toBe('2026-09-17');
    expect(at('2026-09-09').state).toBe(RATIFICATION.OVERDUE);
    expect(at(null).state).toBe(RATIFICATION.OVERDUE);
    expect(ratificationState(em({ stage: 'Implementation' }),
      [approval({ level: 1 }), approval({ level: 2 })], TODAY).state).toBe(RATIFICATION.COMPLETE);
    expect(ratificationState(moc({ stage: 'Implementation' }), [], TODAY).state)
      .toBe(RATIFICATION.NOT_REQUIRED);
  });

  it('summarise counts pending and overdue ratifications by change id', () => {
    const records = [
      em({ id: 'p', stage: 'Implementation', actual_implementation_date: '2026-09-15' }),
      em({ id: 'o', stage: 'Implementation', actual_implementation_date: '2026-08-01' }),
    ];
    const approvals = ['p', 'o'].flatMap((id) => first.map((a) => ({ ...a, moc_id: id })));
    const s = summarise(records, { approvals }, TODAY);
    expect(s.ratificationPending).toBe(1);
    expect(s.ratificationOverdue).toBe(1);
  });
});

describe('AS15: segregation of duties on approvals', () => {
  const change = { originator_id: 'u-orig' };
  it('the originator cannot be assigned or decide', () => {
    expect(canAssignApprover(change, 'u-orig').ok).toBe(false);
    expect(canAssignApprover(change, 'u-app').ok).toBe(true);
    expect(canDecideApproval({ approver_id: 'u-orig', status: 'Pending' }, change, 'u-orig').ok).toBe(false);
  });
  it('only the assignee decides, and only while pending', () => {
    const a = { approver_id: 'u-app', status: 'Pending' };
    expect(canDecideApproval(a, change, 'u-app').ok).toBe(true);
    expect(canDecideApproval(a, change, 'u-other').reason).toMatch(/reassign/);
    expect(canDecideApproval(a, change, null).ok).toBe(false);
    expect(canDecideApproval({ ...a, status: 'Approved' }, change, 'u-app').ok).toBe(false);
  });
});
