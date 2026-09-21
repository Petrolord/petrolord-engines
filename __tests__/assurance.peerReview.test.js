/**
 * Ported from the Suite at AS12 (src/lib/__tests__/peerReview.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS5 — the peer review authority.
 *
 * The disposition state machine and `canClose()` are the two things
 * this module is for. Everything else in the app was a list.
 */
import {
  ACTIVE_STAGES,
  BLOCKING_SEVERITIES,
  COMMENT_STATUSES,
  DECISIONS,
  PRIORITIES,
  SEVERITIES,
  STAGES,
  REVIEWER_ROLES,
  bySeverityThenAge,
  byUrgency,
  canActOnComment,
  canAssignPeerReviewer,
  canClose,
  canTransition,
  countBy,
  daysUntil,
  explainRefusal,
  isBlocking,
  isOverdue,
  isResolved,
  nextStages,
  nextStatuses,
  parseDateOnly,
  summarise,
  toDateOnlyString,
} from '../engines/assurance/peerReview.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local midnight

const comment = (over = {}) => ({ severity: 'Major', status: 'Open', ...over });
const review = (over = {}) => ({ stage: 'In Review', due_date: '2026-12-31', ...over });

describe('dates', () => {
  it('parses a date-only value at LOCAL midnight, not UTC', () => {
    const d = parseDateOnly('2026-09-17');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 17, 0]);
  });

  it('counts whole calendar days, signed', () => {
    expect(daysUntil('2026-09-17', TODAY)).toBe(0);
    expect(daysUntil('2026-09-10', TODAY)).toBe(-7);
  });

  it('returns null rather than NaN for a missing date', () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(toDateOnlyString('nonsense')).toBeNull();
  });
});

describe('overdue reviews', () => {
  it('is overdue the day after the due date and not before', () => {
    // The old count read a date-only column as a UTC instant, so a
    // review due today was overdue for everyone west of Greenwich.
    expect(isOverdue(review({ due_date: '2026-09-17' }), TODAY)).toBe(false);
    expect(isOverdue(review({ due_date: '2026-09-16' }), TODAY)).toBe(true);
  });

  it('does not chase a review that is no longer live', () => {
    // The old test was `stage !== 'Closed' && due < now`, which counted
    // every cancelled review forever.
    expect(isOverdue(review({ stage: 'Cancelled', due_date: '2020-01-01' }), TODAY)).toBe(false);
    expect(isOverdue(review({ stage: 'Closed', due_date: '2020-01-01' }), TODAY)).toBe(false);
    ACTIVE_STAGES.forEach((stage) => {
      expect(isOverdue(review({ stage, due_date: '2020-01-01' }), TODAY)).toBe(true);
    });
  });

  it('is not overdue when there is no due date', () => {
    expect(isOverdue(review({ due_date: null }), TODAY)).toBe(false);
  });
});

describe('comment disposition', () => {
  it('walks the intended loop', () => {
    expect(canTransition('Open', 'Responded')).toBe(true);
    expect(canTransition('Responded', 'Verified')).toBe(true);
    expect(canTransition('Verified', 'Closed')).toBe(true);
  });

  it('refuses to verify a comment nobody has answered', () => {
    // The old app let the UI assign any status to any comment, so a
    // Critical finding could be marked Verified without a response.
    expect(canTransition('Open', 'Verified')).toBe(false);
    expect(explainRefusal(comment({ status: 'Open' }), 'Verified')).toMatch(/only go to/);
  });

  it('refuses to verify a response that is empty', () => {
    // The transition is legal; the content is not. The database cannot
    // express this, so the authority does.
    expect(canTransition('Responded', 'Verified')).toBe(true);
    expect(explainRefusal(comment({ status: 'Responded', response_text: '   ' }), 'Verified'))
      .toMatch(/before the author has responded/);
    expect(explainRefusal(comment({ status: 'Responded', response_text: 'Updated section 4.2.' }), 'Verified'))
      .toBeNull();
  });

  it('sends a rejected comment back to the author, not forward', () => {
    expect(nextStatuses('Rejected')).toEqual(['Responded', 'Withdrawn']);
    expect(canTransition('Rejected', 'Closed')).toBe(false);
  });

  it('treats closed and withdrawn as final', () => {
    expect(nextStatuses('Closed')).toEqual([]);
    expect(nextStatuses('Withdrawn')).toEqual([]);
    expect(explainRefusal(comment({ status: 'Closed' }), 'Responded')).toMatch(/final/);
  });

  it('explains a no-op rather than treating it as an error', () => {
    expect(explainRefusal(comment({ status: 'Open' }), 'Open')).toMatch(/already open/);
  });

  it('counts verified, closed and withdrawn as resolved', () => {
    ['Verified', 'Closed', 'Withdrawn'].forEach((status) => {
      expect(isResolved(comment({ status }))).toBe(true);
    });
    ['Open', 'Responded', 'Rejected'].forEach((status) => {
      expect(isResolved(comment({ status }))).toBe(false);
    });
  });
});

describe('closing a review', () => {
  it('refuses while a Critical or Major comment is unresolved', () => {
    // The whole point of the app. A review could previously be moved to
    // Closed from a dropdown with showstoppers open against it.
    const result = canClose([
      comment({ severity: 'Critical', status: 'Open' }),
      comment({ severity: 'Minor', status: 'Open' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.blocking).toHaveLength(1);
    expect(result.reason).toMatch(/1 critical comment still needs? resolving/i);
  });

  it('allows closing over Minor and Editorial comments', () => {
    // Recorded, and closing over them is a coordinator's judgement.
    const result = canClose([
      comment({ severity: 'Minor', status: 'Open' }),
      comment({ severity: 'Editorial', status: 'Open' }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('allows closing once the blocking comments are resolved', () => {
    expect(canClose([
      comment({ severity: 'Critical', status: 'Closed' }),
      comment({ severity: 'Major', status: 'Verified' }),
      comment({ severity: 'Major', status: 'Withdrawn' }),
    ]).ok).toBe(true);
  });

  it('allows closing a review with no comments at all', () => {
    expect(canClose([]).ok).toBe(true);
  });

  it('counts both blocking severities in the reason', () => {
    const result = canClose([
      comment({ severity: 'Critical', status: 'Open' }),
      comment({ severity: 'Major', status: 'Responded' }),
    ]);
    expect(result.reason).toMatch(/critical/);
    expect(result.reason).toMatch(/major/);
    expect(BLOCKING_SEVERITIES).toEqual(['Critical', 'Major']);
  });

  it('treats a responded-but-unverified comment as still blocking', () => {
    // An answer is not an acceptance. This is the difference between a
    // review loop and a suggestion box.
    expect(isBlocking(comment({ severity: 'Critical', status: 'Responded' }))).toBe(true);
  });
});

describe('stage transitions', () => {
  it('does not skip verification', () => {
    expect(nextStages('In Review')).toContain('Verification');
    expect(nextStages('In Review')).not.toContain('Closed');
  });

  it('can send a review back a stage', () => {
    expect(nextStages('Verification')).toContain('In Review');
  });

  it('treats closed and cancelled as final', () => {
    expect(nextStages('Closed')).toEqual([]);
    expect(nextStages('Cancelled')).toEqual([]);
  });
});

describe('rollup', () => {
  const reviews = [
    review({ id: 1, stage: 'In Review', due_date: '2025-01-01' }),  // overdue
    review({ id: 2, stage: 'Draft', due_date: '2027-01-01' }),
    review({ id: 3, stage: 'Closed', due_date: '2020-01-01' }),
    review({ id: 4, stage: 'Cancelled', due_date: '2020-01-01' }),
  ];
  const comments = [
    comment({ severity: 'Critical', status: 'Open' }),
    comment({ severity: 'Major', status: 'Verified' }),
    comment({ severity: 'Minor', status: 'Closed' }),
  ];

  it('counts from the rows rather than from a module-level array', () => {
    const s = summarise(reviews, comments, TODAY);
    expect(s.total).toBe(4);
    expect(s.active).toBe(2);
    expect(s.overdue).toBe(1);
    expect(s.totalComments).toBe(3);
    expect(s.openComments).toBe(1);
    expect(s.blockingComments).toBe(1);
  });

  // RC-4b (ASC-0): the AS14 rule. A comment on a finished review is locked
  // with it, so it is history, not open work; an unknown review still counts.
  it('does not count open or blocking comments on a closed or cancelled review', () => {
    const s = summarise(reviews, [
      comment({ review_id: 1, severity: 'Critical', status: 'Open' }),
      comment({ review_id: 3, severity: 'Critical', status: 'Open' }),
      comment({ review_id: 4, severity: 'Major', status: 'Rejected' }),
      comment({ review_id: 99, severity: 'Major', status: 'Open' }),
    ], TODAY);
    expect(s.totalComments).toBe(4);
    expect(s.bySeverity.Critical).toBe(2);
    expect(s.openComments).toBe(2);
    expect(s.blockingComments).toBe(2);
  });

  it('counts every review into exactly one stage', () => {
    const s = summarise(reviews, comments, TODAY);
    expect(Object.values(s.byStage).reduce((a, b) => a + b, 0)).toBe(reviews.length);
  });

  it('sorts overdue first and finished last', () => {
    const order = [...reviews].sort(byUrgency(TODAY)).map((r) => r.id);
    expect(order[0]).toBe(1);
    expect(order[1]).toBe(2);
  });

  it('sorts comments unresolved first, then worst severity', () => {
    const rows = [
      comment({ id: 'a', severity: 'Minor', status: 'Open' }),
      comment({ id: 'b', severity: 'Critical', status: 'Closed' }),
      comment({ id: 'c', severity: 'Critical', status: 'Open' }),
    ];
    expect([...rows].sort(bySeverityThenAge).map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('groups by a field and labels rows that do not say', () => {
    expect(countBy([{ discipline: 'Reservoir' }, { discipline: null }], 'discipline'))
      .toEqual([{ name: 'Reservoir', count: 1 }, { name: 'Unspecified', count: 1 }]);
  });

});

describe('segregation of duties (owner decision D1, ASC-0 RC-4a)', () => {
  const pr = { id: 'r', author_id: 'author', lead_reviewer_id: 'lead', created_by: 'coord' };
  const responded = comment({ status: 'Responded', response_text: 'Revised in rev B.' });

  it('names the reviewer roles', () => {
    expect(REVIEWER_ROLES).toEqual(['Lead Reviewer', 'Reviewer']);
  });

  it('never puts the author of the work on the review as a reviewer', () => {
    expect(canAssignPeerReviewer(pr, { user_id: 'author', role: 'Reviewer' }).ok).toBe(false);
    expect(canAssignPeerReviewer(pr, { user_id: 'author', role: 'Lead Reviewer' }).ok).toBe(false);
    expect(canAssignPeerReviewer(pr, { user_id: 'author' }).ok).toBe(false);
    expect(canAssignPeerReviewer(pr, { user_id: 'author', role: 'Reviewer' }).reason)
      .toMatch(/author of the work under review cannot review it/);
  });

  it('lets the author hold the Author role, and anybody else review', () => {
    expect(canAssignPeerReviewer(pr, { user_id: 'author', role: 'Author' }).ok).toBe(true);
    expect(canAssignPeerReviewer(pr, { user_id: 'coord', role: 'Reviewer' }).ok).toBe(true);
    expect(canAssignPeerReviewer(pr, { display_name: 'External expert', role: 'Reviewer' }).ok).toBe(true);
  });

  it('needs somebody named', () => {
    expect(canAssignPeerReviewer(pr, { role: 'Reviewer' })).toEqual({ ok: false, reason: 'Choose the reviewer.' });
  });

  it('refuses the author every reviewer move', () => {
    ['Verified', 'Rejected'].forEach((to) => {
      expect(canActOnComment(responded, to, pr, 'author').ok).toBe(false);
    });
    expect(canActOnComment(comment({ status: 'Open' }), 'Withdrawn', pr, 'author').ok).toBe(false);
    expect(canActOnComment(responded, 'Verified', pr, 'author').reason)
      .toBe('The author of the work under review cannot verify a comment on it. A reviewer independent of the work decides it.');
  });

  it("leaves the author's own move and the reviewer's moves alone", () => {
    expect(canActOnComment(comment({ status: 'Open' }), 'Responded', pr, 'author').ok).toBe(true);
    expect(canActOnComment(responded, 'Verified', pr, 'reviewer-1').ok).toBe(true);
    expect(canActOnComment(responded, 'Rejected', pr, 'lead').ok).toBe(true);
  });

  it('applies the disposition rules first, and needs a signed-in user', () => {
    expect(canActOnComment(comment({ status: 'Open' }), 'Verified', pr, 'reviewer-1').ok).toBe(false);
    expect(canActOnComment(responded, 'Verified', pr, null).ok).toBe(false);
  });
});
