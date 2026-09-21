/**
 * Ported from the Suite at AS12 (src/lib/__tests__/lessonsLearned.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS9 — the Lessons Learned authority under test.
 *
 * The app it replaces had five lessons and a METRICS object of seven
 * literal numbers in src/utils/lessons-learned/mockData.js, a capture
 * form with no state, and a detail page that fell back to
 * MOCK_LESSONS[0] when the id did not match. So these tests are the
 * first statement anywhere in the Suite of what a lessons database
 * actually enforces.
 *
 * Per gate-must-call-the-engine, every gate test carries its negative
 * control: the case that must be refused AND the case that must be
 * allowed.
 */
import {
  APPLICABILITY_SCOPES,
  APPLICATION_OUTCOMES,
  LESSON_STATUSES,
  SUITE_TARGET_TYPES,
  TARGET_TYPES,
  canAdvanceLesson,
  canArchive,
  canEmbed,
  canRecordApplication,
  canSupersede,
  canValidate,
  countBy,
  didChangeSomething,
  hasSubstance,
  hasValidationRecord,
  isReviewDueSoon,
  isReviewOverdue,
  isUnapplied,
  isVisible,
  lessonAgeDays,
  lessonByAttention,
  missingSubstance,
  nextLessonStatuses,
  reuseRecord,
  searchLessons,
  summarise,
} from '../engines/assurance/lessonsLearned.js';

const TODAY = new Date(2026, 8, 17); // 17 September 2026, local

const lesson = (over = {}) => ({
  id: 'l1',
  org_id: 'o1',
  lesson_code: 'LL-2026-001',
  title: 'Pump failure during startup',
  status: 'Draft',
  author_id: 'u1',
  source_type: 'Incident',
  applicability_scope: 'This asset',
  event_date: '2026-09-01',
  ...over,
});

/** A lesson with all three parts: what, why, and what to do. */
const complete = (over = {}) => lesson({
  description: 'The export pump was run without an alignment check.',
  root_cause: 'The commissioning procedure had no alignment hold point.',
  recommendation: 'Add an alignment hold point to the commissioning ITP.',
  ...over,
});

const validated = (over = {}) => complete({
  status: 'Validated',
  validated_by: 'u2',
  validated_at: '2026-09-10',
  ...over,
});

const application = (over = {}) => ({
  id: 'a1',
  lesson_id: 'l1',
  target_type: 'Procedure',
  reference: 'OPS-PR-14 rev 6',
  outcome: 'Adopted',
  applied_on: '2026-09-12',
  ...over,
});

describe('an anecdote is not a lesson', () => {
  it('needs what happened, why it happened, and what to do about it', () => {
    expect(hasSubstance(lesson())).toBe(false);
    expect(hasSubstance(complete())).toBe(true);
  });

  it('names exactly what is missing, in the user\'s words', () => {
    expect(missingSubstance(lesson())).toEqual([
      'what happened', 'why it happened', 'what to do about it']);
    expect(missingSubstance(complete({ recommendation: '' })))
      .toEqual(['what to do about it']);
    expect(missingSubstance(complete())).toEqual([]);
  });

  it('whitespace is not a recommendation', () => {
    expect(hasSubstance(complete({ recommendation: '   ' }))).toBe(false);
  });

  it('REFUSES validation of a story and ALLOWS it for a lesson', () => {
    const story = canValidate(complete({ recommendation: '' }), 'u2');
    expect(story.ok).toBe(false);
    expect(story.reason).toMatch(/what to do about it/);
    expect(canValidate(complete(), 'u2').ok).toBe(true);
  });
});

describe('an author may not validate their own lesson', () => {
  it('REFUSES the author and ALLOWS somebody else', () => {
    const own = canValidate(complete({ author_id: 'u1' }), 'u1');
    expect(own.ok).toBe(false);
    expect(own.reason).toMatch(/author/i);
    expect(canValidate(complete({ author_id: 'u1' }), 'u2').ok).toBe(true);
  });

  it('falls back to created_by when no author is named', () => {
    expect(canValidate(
      complete({ author_id: null, created_by: 'u1' }), 'u1').ok).toBe(false);
  });

  it('an external validator with no Suite account is not blocked', () => {
    // validatorId is undefined for somebody recorded by name.
    expect(canValidate(complete(), undefined).ok).toBe(true);
  });

  it('a validation is a date and a name', () => {
    expect(hasValidationRecord(complete())).toBe(false);
    expect(hasValidationRecord(complete({ validated_at: '2026-09-10' }))).toBe(false);
    expect(hasValidationRecord(validated())).toBe(true);
    expect(hasValidationRecord(complete({
      validated_at: '2026-09-10', validator_name: 'External reviewer',
    }))).toBe(true);
  });

  it('will not publish a lesson nobody validated', () => {
    const verdict = canAdvanceLesson(complete({ status: 'Validated' }), 'Published');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/validated/i);
    expect(canAdvanceLesson(validated(), 'Published').ok).toBe(true);
  });
});

describe('a lesson that was never applied has not been learned', () => {
  it('REFUSES Embedded with nothing applied, and ALLOWS it with one', () => {
    const bare = canEmbed(lesson(), []);
    expect(bare.ok).toBe(false);
    expect(bare.reason).toMatch(/where this lesson was applied/i);
    expect(canEmbed(lesson(), [application()]).ok).toBe(true);
  });

  it('a REJECTED application embeds nothing, and says so differently', () => {
    const verdict = canEmbed(lesson(), [application({
      outcome: 'Rejected', notes: 'The procedure is being retired.',
    })]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/adopted nowhere/i);
  });

  it('an ADAPTED application counts: a lesson reused with changes is reused', () => {
    expect(canEmbed(lesson(), [application({ outcome: 'Adapted' })]).ok).toBe(true);
    expect(didChangeSomething(application({ outcome: 'Adapted' }))).toBe(true);
    expect(didChangeSomething(application({ outcome: 'Rejected' }))).toBe(false);
  });

  it('counts reuse rather than claiming it, and names the kinds of target', () => {
    const record = reuseRecord([
      application({ id: 'a1', target_type: 'Procedure', applied_on: '2026-09-12' }),
      application({ id: 'a2', target_type: 'Risk register', outcome: 'Adapted', applied_on: '2026-09-14' }),
      application({ id: 'a3', target_type: 'Training', outcome: 'Rejected', applied_on: '2026-09-15' }),
    ]);
    expect(record).toMatchObject({
      total: 3, applied: 2, adopted: 1, adapted: 1, rejected: 1,
      lastAppliedOn: '2026-09-14',
    });
    expect(record.targets.sort()).toEqual(['Procedure', 'Risk register']);
  });

  it('an empty register reuses nothing and does not crash', () => {
    expect(reuseRecord()).toMatchObject({ total: 0, applied: 0, lastAppliedOn: null });
  });

  it('knows a published lesson nobody has applied', () => {
    expect(isUnapplied(complete({ status: 'Published' }), [])).toBe(true);
    expect(isUnapplied(complete({ status: 'Published' }), [application()])).toBe(false);
    // A draft nobody has applied is not the same problem.
    expect(isUnapplied(lesson(), [])).toBe(false);
  });
});

describe('an application names what it changed', () => {
  it('REFUSES a risk-register push with no risk, and ALLOWS one with it', () => {
    const bare = canRecordApplication({ target_type: 'Risk register', outcome: 'Adopted' });
    expect(bare.ok).toBe(false);
    expect(bare.reason).toMatch(/risk/i);
    expect(canRecordApplication({
      target_type: 'Risk register', target_risk_id: 'r1', outcome: 'Adopted',
    }).ok).toBe(true);
  });

  it('REFUSES an MOC push with no change record', () => {
    expect(canRecordApplication({
      target_type: 'Management of change', outcome: 'Adopted',
    }).ok).toBe(false);
    expect(canRecordApplication({
      target_type: 'Management of change', target_moc_id: 'm1', outcome: 'Adopted',
    }).ok).toBe(true);
  });

  it('everything else names something a person can go and look at', () => {
    expect(canRecordApplication({ target_type: 'Training', outcome: 'Adopted' }).ok).toBe(false);
    expect(canRecordApplication({
      target_type: 'Training', reference: 'IND-104', outcome: 'Adopted',
    }).ok).toBe(true);
  });

  it('a rejection carries its reasoning', () => {
    expect(canRecordApplication({
      target_type: 'Training', reference: 'IND-104', outcome: 'Rejected',
    }).ok).toBe(false);
    expect(canRecordApplication({
      target_type: 'Training', reference: 'IND-104', outcome: 'Rejected',
      notes: 'The course is being replaced.',
    }).ok).toBe(true);
  });

  it('rejects a target type or outcome the register does not accept', () => {
    expect(canRecordApplication({ target_type: 'Vibes', outcome: 'Adopted' }).ok).toBe(false);
    expect(canRecordApplication({
      target_type: 'Training', reference: 'x', outcome: 'Maybe',
    }).ok).toBe(false);
  });
});

describe('the workflow', () => {
  it('only moves where the transition table allows', () => {
    expect(nextLessonStatuses('Draft')).toContain('Submitted');
    expect(nextLessonStatuses('Draft')).not.toContain('Published');
    expect(nextLessonStatuses('Archived')).toEqual([]);
    expect(canAdvanceLesson(lesson(), 'Published').ok).toBe(false);
    expect(canAdvanceLesson(lesson(), 'Submitted').ok).toBe(true);
  });

  it('routes each move through its own gate', () => {
    expect(canAdvanceLesson(complete({ status: 'Submitted' }), 'Validated', {
      validatorId: 'u1',
    }).ok).toBe(false);
    expect(canAdvanceLesson(complete({ status: 'Submitted' }), 'Validated', {
      validatorId: 'u2',
    }).ok).toBe(true);
    expect(canAdvanceLesson(validated({ status: 'Published' }), 'Embedded', {
      applications: [],
    }).ok).toBe(false);
    expect(canAdvanceLesson(validated({ status: 'Published' }), 'Embedded', {
      applications: [application()],
    }).ok).toBe(true);
  });

  it('archiving needs a reason, and superseding needs a successor', () => {
    expect(canArchive(lesson()).ok).toBe(false);
    expect(canArchive(lesson(), { archive_reason: 'The asset was decommissioned.' }).ok).toBe(true);
    expect(canSupersede(validated({ status: 'Published' })).ok).toBe(false);
    expect(canSupersede(validated({ status: 'Published' }), { superseded_by: 'l9' }).ok).toBe(true);
  });

  it('a lesson cannot supersede itself', () => {
    expect(canSupersede(lesson({ id: 'l1' }), { superseded_by: 'l1' }).ok).toBe(false);
  });

  it('refuses any move out of a terminal status', () => {
    expect(canAdvanceLesson(lesson({ status: 'Archived' }), 'Published').ok).toBe(false);
    expect(canAdvanceLesson(lesson({ status: 'Superseded' }), 'Draft').ok).toBe(false);
  });
});

describe('search, dates and summary', () => {
  const register = [
    complete({ id: 'l1', lesson_code: 'LL-2026-001', status: 'Published', category: 'Equipment',
      discipline: 'Mechanical', keywords: 'pump alignment commissioning' }),
    complete({ id: 'l2', lesson_code: 'LL-2026-002', title: 'Drill bit selection reduced NPT',
      status: 'Draft', category: 'Optimization', discipline: 'Drilling',
      description: 'PDC bits with a customized cutter layout cut tripping time.' }),
  ];

  it('requires every term, across every searchable field', () => {
    expect(searchLessons(register, 'pump').map((l) => l.id)).toEqual(['l1']);
    expect(searchLessons(register, 'pump alignment').map((l) => l.id)).toEqual(['l1']);
    expect(searchLessons(register, 'pump drill')).toEqual([]);
    expect(searchLessons(register, 'PDC').map((l) => l.id)).toEqual(['l2']);
    expect(searchLessons(register, 'LL-2026-002').map((l) => l.id)).toEqual(['l2']);
  });

  it('returns the whole register for an empty query', () => {
    expect(searchLessons(register, '')).toHaveLength(2);
    expect(searchLessons(register)).toHaveLength(2);
  });

  it('filters by status, category, discipline and visibility', () => {
    expect(searchLessons(register, '', { status: 'Draft' }).map((l) => l.id)).toEqual(['l2']);
    expect(searchLessons(register, '', { category: 'Equipment' }).map((l) => l.id)).toEqual(['l1']);
    expect(searchLessons(register, '', { discipline: 'Drilling' }).map((l) => l.id)).toEqual(['l2']);
    expect(searchLessons(register, '', { visibleOnly: true }).map((l) => l.id)).toEqual(['l1']);
  });

  it('knows a review that is overdue, due soon, or neither', () => {
    const published = complete({ status: 'Published' });
    expect(isReviewOverdue({ ...published, review_due: '2026-09-16' }, TODAY)).toBe(true);
    expect(isReviewOverdue({ ...published, review_due: '2026-09-17' }, TODAY)).toBe(false);
    expect(isReviewDueSoon({ ...published, review_due: '2026-10-01' }, TODAY)).toBe(true);
    // A draft's review date is not yet anybody's problem.
    expect(isReviewOverdue(complete({ review_due: '2020-01-01' }), TODAY)).toBe(false);
  });

  it('ages a lesson from the event, not from the row', () => {
    expect(lessonAgeDays(lesson({ event_date: '2026-09-01' }), TODAY)).toBe(16);
    expect(lessonAgeDays(lesson({ event_date: null, created_at: null }), TODAY)).toBe(null);
  });

  it('counts lessons applied and lessons not, which is the number that matters', () => {
    const s = summarise({
      lessons: [
        complete({ id: 'l1', status: 'Published' }),
        complete({ id: 'l2', status: 'Published' }),
        complete({ id: 'l3', status: 'Draft' }),
      ],
      applications: [
        application({ id: 'a1', lesson_id: 'l1', target_type: 'Risk register' }),
        application({ id: 'a2', lesson_id: 'l1', target_type: 'Management of change' }),
        application({ id: 'a3', lesson_id: 'l2', outcome: 'Rejected', notes: 'x' }),
      ],
    }, TODAY);
    expect(s.visible).toBe(2);
    expect(s.lessonsApplied).toBe(1);
    expect(s.lessonsUnapplied).toBe(1);
    expect(s.intoRiskRegister).toBe(1);
    expect(s.intoMoc).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.drafts).toBe(1);
  });

  it('returns zeros, not a crash, for an organization with nothing', () => {
    const s = summarise({}, TODAY);
    expect(s.lessons).toBe(0);
    expect(s.lessonsUnapplied).toBe(0);
    expect(s.applications).toBe(0);
  });

  it('puts a published lesson nobody applied first', () => {
    const rows = [
      complete({ id: 'l1', status: 'Published' }),
      complete({ id: 'l2', status: 'Submitted' }),
      complete({ id: 'l3', status: 'Published' }),
      complete({ id: 'l4', status: 'Archived' }),
    ];
    const byLesson = new Map([['l3', [application({ lesson_id: 'l3' })]]]);
    expect([...rows].sort(lessonByAttention(byLesson, TODAY)).map((l) => l.id))
      .toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('groups and labels an unset field instead of dropping it', () => {
    expect(countBy([{ category: 'Equipment' }, {}], 'category'))
      .toEqual([{ name: 'Equipment', count: 1 }, { name: 'Unspecified', count: 1 }]);
  });
});

describe('AS15: validation by typed name', () => {
  it('refuses the author as the person validating, even when they type another name', () => {
    const l = complete({ author_id: 'u-author' });
    const v = canValidate(l, 'u-author', { validator_name: 'An External Reviewer' });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/somebody else's name/);
    expect(canValidate(l, 'u-colleague', { validator_name: 'An External Reviewer' }).ok).toBe(true);
  });
});
