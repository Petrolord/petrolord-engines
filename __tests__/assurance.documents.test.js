/**
 * Ported from the Suite at AS12 (src/lib/__tests__/documentControl.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS4 — the document control authority.
 *
 * Same shape as riskScoring (AS2) and complianceStatus (AS3): unit
 * tests, then a guard that fails if a second copy of the derivation
 * appears in the app again.
 *
 * Every test pins a date. A review-due test that calls new Date()
 * passes today and fails in three weeks.
 */
import {
  CONFIDENTIALITY_LEVELS,
  DOC_STATUSES,
  REVIEW,
  REVIEW_LEAD_DAYS,
  atLeastConfidential,
  byReviewUrgency,
  countBy,
  daysUntil,
  documentPrefix,
  isReviewOverdue,
  nextReviewDate,
  nextRevisionNumber,
  parseDateOnly,
  reviewState,
  summarise,
  toDateOnlyString,
  canAssignReviewer,
  canDecideReviewTask,
} from '../engines/assurance/documentControl.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local midnight

const doc = (over = {}) => ({ status: 'Published', next_review_date: '2027-01-01', ...over });

describe('dates', () => {
  it('parses a date-only string at LOCAL midnight, not UTC', () => {
    const d = parseDateOnly('2026-09-17');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()])
      .toEqual([2026, 8, 17, 0]);
  });

  it('counts whole calendar days, signed', () => {
    expect(daysUntil('2026-09-17', TODAY)).toBe(0);
    expect(daysUntil('2026-09-10', TODAY)).toBe(-7);
  });

  it('returns null rather than NaN for a missing date', () => {
    expect(parseDateOnly(null)).toBeNull();
    expect(toDateOnlyString('nonsense')).toBeNull();
  });
});

describe('review state', () => {
  it('is overdue the day after the review date and not before', () => {
    expect(reviewState(doc({ next_review_date: '2026-09-17' }), TODAY)).not.toBe(REVIEW.OVERDUE);
    expect(reviewState(doc({ next_review_date: '2026-09-16' }), TODAY)).toBe(REVIEW.OVERDUE);
  });

  it('warns inside the lead time', () => {
    expect(REVIEW_LEAD_DAYS).toBe(30);
    expect(reviewState(doc({ next_review_date: '2026-10-10' }), TODAY)).toBe(REVIEW.DUE_SOON);
    expect(reviewState(doc({ next_review_date: '2026-12-01' }), TODAY)).toBe(REVIEW.SCHEDULED);
  });

  it('does not chase a document that is no longer in force', () => {
    // A superseded procedure from 2019 is not work for anybody.
    // Counting it is how a review queue fills with noise nobody can
    // close, which is the same call complianceStatus makes in AS3.
    ['Superseded', 'Obsolete', 'Rejected', 'Draft'].forEach((status) => {
      expect(reviewState(doc({ status, next_review_date: '2019-01-01' }), TODAY))
        .toBe(REVIEW.NOT_APPLICABLE);
      expect(isReviewOverdue(doc({ status, next_review_date: '2019-01-01' }), TODAY)).toBe(false);
    });
  });

  it('says so when a published document has no review scheduled', () => {
    // Silently treating this as fine is how a controlled document goes
    // years without one.
    expect(reviewState(doc({ next_review_date: null }), TODAY)).toBe(REVIEW.NOT_SCHEDULED);
  });

  it('counts an approved document as in force, not only a published one', () => {
    expect(reviewState(doc({ status: 'Approved', next_review_date: '2026-01-01' }), TODAY))
      .toBe(REVIEW.OVERDUE);
  });
});

describe('the review date a document earns when issued', () => {
  it('counts from the ISSUE date, not from today', () => {
    // Re-publishing a correction to a document issued last month must
    // not push its review a further two years out from the correction.
    expect(toDateOnlyString(nextReviewDate('2026-08-15', 24))).toBe('2028-08-15');
  });

  it('pulls a month-end back instead of overflowing', () => {
    expect(toDateOnlyString(nextReviewDate('2026-08-31', 6))).toBe('2027-02-28');
  });

  it('returns null where it cannot be computed', () => {
    expect(nextReviewDate(null, 24)).toBeNull();
    expect(nextReviewDate('2026-08-15', 0)).toBeNull();
    expect(nextReviewDate('2026-08-15', null)).toBeNull();
  });
});

describe('revision numbers', () => {
  it('increments and keeps the width, because a revision is cited as written', () => {
    expect(nextRevisionNumber('01')).toBe('02');
    expect(nextRevisionNumber('09')).toBe('10');
    expect(nextRevisionNumber('099')).toBe('100');
  });

  it('starts a chain at 01 rather than producing NaN', () => {
    expect(nextRevisionNumber(null)).toBe('01');
    expect(nextRevisionNumber('')).toBe('01');
    expect(nextRevisionNumber('Rev A')).toBe('01');
  });
});

describe('confidentiality', () => {
  it('is ordered, so "at least Confidential" means something', () => {
    expect(atLeastConfidential('Restricted')).toBe(true);
    expect(atLeastConfidential('Confidential')).toBe(true);
    expect(atLeastConfidential('Internal')).toBe(false);
    expect(atLeastConfidential('Public')).toBe(false);
    expect(atLeastConfidential(undefined)).toBe(false);
  });
});

describe('rollup', () => {
  const library = [
    doc({ id: 1, status: 'Published', next_review_date: '2025-01-01' }), // overdue
    doc({ id: 2, status: 'Published', next_review_date: '2026-10-01' }), // due soon
    doc({ id: 3, status: 'In Review', next_review_date: null }),
    doc({ id: 4, status: 'Draft', next_review_date: '2019-01-01' }),     // not in force
    doc({ id: 5, status: 'Superseded', next_review_date: '2019-01-01' }),
  ];

  it('counts overdue reviews from the rows, not from a literal', () => {
    // The dashboard tile used to read `overdue: 1`, hardcoded, inside
    // the branch that was otherwise querying the database.
    const s = summarise(library, TODAY);
    expect(s.overdue).toBe(1);
    expect(s.dueSoon).toBe(1);
    expect(s.total).toBe(5);
    expect(s.inReview).toBe(1);
    expect(s.published).toBe(2);
  });

  it('sorts the review queue worst first, and not-in-force last', () => {
    // 3 is In Review and 4 is Draft, so neither is in force and neither
    // is review-due however old its date. The two that ARE in force
    // come first, overdue before due-soon.
    const order = [...library].sort(byReviewUrgency(TODAY)).map((d) => d.id);
    expect(order.slice(0, 2)).toEqual([1, 2]);
    expect(order.slice(2).sort()).toEqual([3, 4, 5]);
  });

  it('groups by a field and labels rows that do not say', () => {
    expect(countBy([{ department: 'HSE' }, { department: null }], 'department'))
      .toEqual([{ name: 'HSE', count: 1 }, { name: 'Unspecified', count: 1 }]);
  });

});

describe('document number prefixes', () => {
  it('builds a stable prefix from department and category', () => {
    expect(documentPrefix('HSE', 'Policy')).toBe('HSE-POL');
    expect(documentPrefix('Engineering', 'Drawing')).toBe('ENG-DRA');
  });

  it('falls back rather than emitting an empty segment', () => {
    // '--001' would start a sequence nothing else can ever match.
    expect(documentPrefix('', '')).toBe('GEN-DOC');
    expect(documentPrefix('!!!', 'SOP')).toBe('GEN-SOP');
  });
});

describe('AS15: segregation of duties on review tasks', () => {
  const rev = { created_by: 'u-author' };
  it('the author is never the reviewer', () => {
    expect(canAssignReviewer(rev, 'u-author').ok).toBe(false);
    expect(canAssignReviewer(rev, 'u-rev').ok).toBe(true);
    expect(canAssignReviewer(rev, null).ok).toBe(false);
    expect(canDecideReviewTask({ reviewer_id: 'u-author', status: 'Pending' }, rev, 'u-author').ok).toBe(false);
  });
  it('only the assigned reviewer decides a pending task', () => {
    const t = { reviewer_id: 'u-rev', status: 'Pending' };
    expect(canDecideReviewTask(t, rev, 'u-rev').ok).toBe(true);
    expect(canDecideReviewTask(t, rev, 'u-other').ok).toBe(false);
    expect(canDecideReviewTask({ ...t, status: 'Closed' }, rev, 'u-rev').ok).toBe(false);
  });
});
