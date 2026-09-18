/**
 * The one Lessons Learned authority for the Assurance module.
 *
 * AS9, after riskScoring (AS2), complianceStatus (AS3),
 * documentControl (AS4), peerReview (AS5), managementOfChange (AS6),
 * qualityAssurance (AS7) and isoCompliance (AS8).
 *
 * The third app in a row with no data of its own: five lessons and a
 * seven-number METRICS object in src/utils/lessons-learned/mockData.js,
 * a capture form with no state, and a detail page that fell back to
 * `MOCK_LESSONS[0]` when the id did not match — so asking for a lesson
 * this organization does not have showed it a different lesson.
 *
 * Three rules, and the third is the reason the roadmap kept this app
 * rather than folding it into a document library:
 *
 *   AN AUTHOR MAY NOT VALIDATE THEIR OWN LESSON. The third
 *   independence rule in this module, after AS5's reviewer and AS8's
 *   ISO 19011 auditor. A lessons database published by the people who
 *   wrote it holds what individuals think happened; a validated one
 *   holds what the organization accepts happened.
 *
 *   AN ANECDOTE IS NOT A LESSON. What happened, why it happened, and
 *   what to do about it. The first two without the third are a story,
 *   and a register full of stories is why nobody reads one.
 *
 *   A LESSON THAT WAS NEVER APPLIED HAS NOT BEEN LEARNED. This module
 *   counts applications: a risk raised on the register, an MOC opened,
 *   a procedure revised, a course changed. `Embedded` is not a status
 *   somebody selects; it is a status a row in `lesson_applications`
 *   earns. And REUSABILITY IS COUNTED, NOT CLAIMED — there is no
 *   reusability column, because the old register's High / Medium / Low
 *   badge on every row was typed into a data file.
 */

import { parseDateOnly, daysUntil, toDateOnlyString } from './qualityAssurance.js';

export { parseDateOnly, daysUntil, toDateOnlyString };

// ASC-0 (RC-9): an article that agrees with the word it introduces. The
// refusal was written 'A ${word}', which printed "A archived lesson" and
// "A emergency change".
const withArticle = (word) => `${/^[aeiou]/i.test(word) ? 'An' : 'A'} ${word}`;

// ASC-0 (RC-9): 'a', 'a and b', 'a, b and c'.
const listed = (xs) => (xs.length <= 1 ? xs.join('')
  : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/* ------------------------------------------------------------------ */
/* Vocabularies. Every one is a check constraint in migration          */
/* 20260917700000, and every gate below compares against one of them.  */
/* ------------------------------------------------------------------ */

export const LESSON_STATUSES = Object.freeze([
  'Draft', 'Submitted', 'Validated', 'Published', 'Embedded', 'Archived', 'Superseded',
]);

/** Statuses in which the lesson is still being worked on or used. */
export const LESSON_LIVE_STATUSES = Object.freeze([
  'Draft', 'Submitted', 'Validated', 'Published', 'Embedded',
]);

export const LESSON_TERMINAL_STATUSES = Object.freeze(['Archived', 'Superseded']);

/** Statuses that assert the organization has accepted the lesson. */
export const LESSON_ACCEPTED_STATUSES = Object.freeze(['Validated', 'Published', 'Embedded']);

/** Statuses in which other people can find and use it. */
export const LESSON_VISIBLE_STATUSES = Object.freeze(['Published', 'Embedded']);

export const SOURCE_TYPES = Object.freeze([
  'Incident', 'Near miss', 'Audit finding', 'Non-conformance', 'Management of change',
  'Project close-out', 'Operational experience', 'Success', 'Other',
]);

/**
 * How widely this lesson applies. It replaces the reusability badge,
 * and it is a judgement about scope rather than a score: how often it
 * HAS been reused is `reuseRecord()`, which counts rows.
 */
export const APPLICABILITY_SCOPES = Object.freeze([
  'This asset', 'This discipline', 'This organization', 'Industry-wide',
]);

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

export const TARGET_TYPES = Object.freeze([
  'Risk register', 'Management of change', 'Procedure', 'Training',
  'Design standard', 'Contract or tender', 'Maintenance plan', 'Other',
]);

/** The two targets that are Suite registers, and carry a real key. */
export const SUITE_TARGET_TYPES = Object.freeze(['Risk register', 'Management of change']);

export const APPLICATION_OUTCOMES = Object.freeze(['Adopted', 'Adapted', 'Rejected']);

/** Outcomes that changed something. A rejection did not. */
export const EMBEDDING_OUTCOMES = Object.freeze(['Adopted', 'Adapted']);

/** How far ahead a lesson review starts reading "due soon". */
export const REVIEW_LEAD_DAYS = 30;

/* ------------------------------------------------------------------ */
/* The lesson itself                                                  */
/* ------------------------------------------------------------------ */

export const isLive = (lesson = {}) => LESSON_LIVE_STATUSES.includes(lesson.status);
export const isVisible = (lesson = {}) => LESSON_VISIBLE_STATUSES.includes(lesson.status);
export const isAccepted = (lesson = {}) => LESSON_ACCEPTED_STATUSES.includes(lesson.status);

/**
 * What happened, why it happened, and what to do about it.
 *
 * Mirrors `lesson_records_publishable_needs_substance` so a form can
 * name the missing field rather than showing a constraint name.
 */
export const hasSubstance = (lesson = {}) =>
  Boolean(String(lesson.description || '').trim())
  && Boolean(String(lesson.root_cause || '').trim())
  && Boolean(String(lesson.recommendation || '').trim());

export const missingSubstance = (lesson = {}) => [
  !String(lesson.description || '').trim() ? 'what happened' : null,
  !String(lesson.root_cause || '').trim() ? 'why it happened' : null,
  !String(lesson.recommendation || '').trim() ? 'what to do about it' : null,
].filter(Boolean);

export const hasValidationRecord = (lesson = {}) =>
  Boolean(lesson.validated_at)
  && Boolean(lesson.validated_by || String(lesson.validator_name || '').trim());

/**
 * May the signed-in person `actorId` validate this lesson?
 *
 * Owner decision AS15 (§3k.4 Q10, validation by typed name): `actorId` is
 * ALWAYS the person performing the validation, even when they record an
 * external reviewer by name. The Suite used to pass null whenever a name
 * was typed, so an author could validate their own lesson by typing
 * anybody's name. A typed name is still accepted, as the external
 * reviewer who did the review, but it is recorded by somebody other than
 * the author.
 */
export const canValidate = (lesson = {}, actorId, patch = {}) => {
  const next = { ...lesson, ...patch };
  const author = next.author_id || next.created_by;
  if (actorId && author && actorId === author) {
    return {
      ok: false,
      reason: 'The author of a lesson cannot validate it, and that includes recording somebody else\'s name. Ask a colleague who was not involved in writing it to validate it.',
    };
  }
  if (!hasSubstance(next)) {
    const missing = missingSubstance(next);
    return {
      ok: false,
      reason: `This lesson is missing ${listed(missing)}. A lesson is what happened, why it happened and what to do about it; the first two without the third are a story.`,
    };
  }
  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Applications: where the lesson actually went                       */
/* ------------------------------------------------------------------ */

export const didChangeSomething = (application = {}) =>
  EMBEDDING_OUTCOMES.includes(application.outcome);

/**
 * The reuse record, which is a count rather than a claim.
 *
 * This is what replaces the High / Medium / Low reusability badge the
 * old register drew on every row from a hand-written data file, and
 * the dashboard's "High Reusability: 89" tile.
 */
export const reuseRecord = (applications = []) => {
  const applied = applications.filter(didChangeSomething);
  const dates = applied
    .map((a) => parseDateOnly(a.applied_on))
    .filter(Boolean)
    .sort((a, b) => b - a);
  return {
    total: applications.length,
    applied: applied.length,
    adopted: applications.filter((a) => a.outcome === 'Adopted').length,
    adapted: applications.filter((a) => a.outcome === 'Adapted').length,
    rejected: applications.filter((a) => a.outcome === 'Rejected').length,
    // Which kinds of thing this lesson has actually changed.
    targets: [...new Set(applied.map((a) => a.target_type).filter(Boolean))],
    lastAppliedOn: dates.length ? toDateOnlyString(dates[0]) : null,
  };
};

/**
 * What an application must carry, mirrored from the constraints so the
 * form names the field instead of the database naming the constraint.
 */
export const canRecordApplication = (application = {}) => {
  if (!TARGET_TYPES.includes(application.target_type)) {
    return { ok: false, reason: 'Pick what this lesson was applied to.' };
  }
  if (application.target_type === 'Risk register' && !application.target_risk_id) {
    return {
      ok: false,
      reason: 'Name the risk. A lesson pushed into the register points at the row it raised or changed, so the trail runs both ways.',
    };
  }
  if (application.target_type === 'Management of change' && !application.target_moc_id) {
    return {
      ok: false,
      reason: 'Name the change record this lesson went into.',
    };
  }
  if (!SUITE_TARGET_TYPES.includes(application.target_type)
      && !String(application.reference || '').trim()) {
    return {
      ok: false,
      reason: 'Name what changed (the procedure, the course, the standard) so somebody can go and look at it.',
    };
  }
  if (!APPLICATION_OUTCOMES.includes(application.outcome)) {
    return { ok: false, reason: 'Was the lesson adopted, adapted, or rejected?' };
  }
  if (application.outcome === 'Rejected' && !String(application.notes || '').trim()) {
    return {
      ok: false,
      reason: 'Say why it was not adopted. A rejection is a decision, and the next person to read this lesson needs the reasoning.',
    };
  }
  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* The workflow                                                       */
/* ------------------------------------------------------------------ */

export const LESSON_TRANSITIONS = Object.freeze({
  Draft: Object.freeze(['Submitted', 'Archived']),
  Submitted: Object.freeze(['Validated', 'Draft', 'Archived']),
  Validated: Object.freeze(['Published', 'Submitted', 'Archived']),
  Published: Object.freeze(['Embedded', 'Superseded', 'Archived']),
  Embedded: Object.freeze(['Superseded', 'Archived']),
  Archived: Object.freeze([]),
  Superseded: Object.freeze([]),
});

export const nextLessonStatuses = (status) => LESSON_TRANSITIONS[status] || [];

/**
 * May this lesson be marked Embedded?
 *
 * Embedded is not a status somebody selects. It is the statement that
 * the lesson changed something, and it is earned by a row in
 * `lesson_applications` whose outcome is Adopted or Adapted. A
 * rejection is a real and useful record, and it embeds nothing.
 */
export const canEmbed = (lesson = {}, applications = []) => {
  const record = reuseRecord(applications);
  if (record.applied === 0) {
    return {
      ok: false,
      reason: record.rejected
        ? `This lesson has been considered ${record.rejected} time${record.rejected === 1 ? '' : 's'} and adopted nowhere. Record where it was applied before calling it embedded.`
        : 'Record where this lesson was applied first: the risk it raised, the change it caused, the procedure or the course it altered. A lesson that changed nothing has not been learned.',
    };
  }
  return { ok: true };
};

export const canArchive = (lesson = {}, patch = {}) => {
  const reason = patch.archive_reason ?? lesson.archive_reason;
  if (!String(reason || '').trim()) {
    return {
      ok: false,
      reason: 'Say why this lesson is being archived. "Archived, nobody said why" is how a lessons database becomes a folder of PDFs.',
    };
  }
  return { ok: true };
};

export const canSupersede = (lesson = {}, patch = {}) => {
  const successor = patch.superseded_by ?? lesson.superseded_by;
  if (!successor) {
    return { ok: false, reason: 'Name the lesson that replaces this one.' };
  }
  if (successor === lesson.id) {
    return { ok: false, reason: 'A lesson cannot supersede itself.' };
  }
  return { ok: true };
};

export const canAdvanceLesson = (lesson = {}, to, context = {}) => {
  const allowed = nextLessonStatuses(lesson.status);
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: allowed.length
        ? `A lesson that is ${String(lesson.status).toLowerCase()} can only move to ${allowed.join(', ')}.`
        : `${withArticle(String(lesson.status).toLowerCase())} lesson is final.`,
    };
  }
  if (to === 'Validated') return canValidate(lesson, context.validatorId, context.patch);
  if (to === 'Published') {
    if (!hasSubstance(lesson)) return canValidate(lesson, context.validatorId, context.patch);
    if (!hasValidationRecord(lesson)) {
      return {
        ok: false,
        reason: 'This lesson has not been validated. Somebody other than its author has to accept it before it is published to everyone.',
      };
    }
    return { ok: true };
  }
  if (to === 'Embedded') return canEmbed(lesson, context.applications || []);
  if (to === 'Archived') return canArchive(lesson, context.patch);
  if (to === 'Superseded') return canSupersede(lesson, context.patch);
  return { ok: true };
};

/* ------------------------------------------------------------------ */
/* Dates                                                              */
/* ------------------------------------------------------------------ */

export const isReviewOverdue = (lesson = {}, today = new Date()) => {
  if (!isVisible(lesson)) return false;
  const days = daysUntil(lesson.review_due, today);
  return days !== null && days < 0;
};

export const isReviewDueSoon = (lesson = {}, today = new Date()) => {
  if (!isVisible(lesson)) return false;
  const days = daysUntil(lesson.review_due, today);
  return days !== null && days >= 0 && days <= REVIEW_LEAD_DAYS;
};

export const lessonAgeDays = (lesson = {}, today = new Date()) => {
  const raised = parseDateOnly(lesson.event_date || lesson.created_at);
  if (!raised) return null;
  return Math.max(0, -daysUntil(raised, today));
};

/**
 * Published, and nobody has applied it anywhere.
 *
 * The number this app exists to move, and the one the old dashboard
 * could not have produced: it had a "Pending Action: 5" tile, and 5
 * was a literal.
 */
export const isUnapplied = (lesson = {}, applications = []) =>
  isVisible(lesson) && reuseRecord(applications).applied === 0;

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

const FIELDS = ['lesson_code', 'title', 'description', 'root_cause', 'recommendation',
  'consequence', 'category', 'discipline', 'department', 'project_ref', 'asset_id',
  'keywords', 'source_reference', 'author_name'];

/**
 * Search the register.
 *
 * Every term must appear somewhere in the lesson, which is what makes
 * a two-word search useful; the old page filtered on title,
 * description or root cause with a single `includes` and no filters at
 * all, over five invented lessons.
 */
export const searchLessons = (lessons = [], query = '', filters = {}) => {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return lessons.filter((lesson) => {
    if (filters.status && lesson.status !== filters.status) return false;
    if (filters.category && lesson.category !== filters.category) return false;
    if (filters.discipline && lesson.discipline !== filters.discipline) return false;
    if (filters.source_type && lesson.source_type !== filters.source_type) return false;
    if (filters.scope && lesson.applicability_scope !== filters.scope) return false;
    if (filters.visibleOnly && !isVisible(lesson)) return false;
    if (!terms.length) return true;
    const haystack = FIELDS.map((f) => lesson[f]).filter(Boolean).join(' ').toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
};

/* ------------------------------------------------------------------ */
/* Summaries and grouping                                             */
/* ------------------------------------------------------------------ */

export const summarise = (
  { lessons = [], applications = [] } = {},
  today = new Date(),
) => {
  const byStatus = Object.fromEntries(LESSON_STATUSES.map((s) => [s, 0]));
  lessons.forEach((l) => {
    if (byStatus[l.status] !== undefined) byStatus[l.status] += 1;
  });

  const byLesson = new Map();
  applications.forEach((a) => {
    if (!byLesson.has(a.lesson_id)) byLesson.set(a.lesson_id, []);
    byLesson.get(a.lesson_id).push(a);
  });

  const visible = lessons.filter(isVisible);
  const unapplied = visible.filter((l) => isUnapplied(l, byLesson.get(l.id) || []));
  const applied = applications.filter(didChangeSomething);

  return {
    lessons: lessons.length,
    byStatus,
    live: lessons.filter(isLive).length,
    visible: visible.length,
    awaitingValidation: byStatus.Submitted,
    drafts: byStatus.Draft,

    applications: applications.length,
    applied: applied.length,
    rejected: applications.filter((a) => a.outcome === 'Rejected').length,
    // Lessons that changed something, and lessons that did not.
    lessonsApplied: visible.length - unapplied.length,
    lessonsUnapplied: unapplied.length,
    // Into the Suite's own registers, which is the trail worth having.
    intoRiskRegister: applied.filter((a) => a.target_type === 'Risk register').length,
    intoMoc: applied.filter((a) => a.target_type === 'Management of change').length,

    reviewsOverdue: lessons.filter((l) => isReviewOverdue(l, today)).length,
    reviewsDueSoon: lessons.filter((l) => isReviewDueSoon(l, today)).length,
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

/** Sort: published lessons nobody has applied first. They are the work. */
export const lessonByAttention = (applicationsByLesson = new Map(), today = new Date()) =>
  (a, b) => {
    const rank = (l) => {
      if (isUnapplied(l, applicationsByLesson.get(l.id) || [])) return 0;
      if (l.status === 'Submitted') return 1;
      if (isReviewOverdue(l, today)) return 2;
      if (isLive(l)) return 3;
      return 4;
    };
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    const da = parseDateOnly(b.event_date || b.created_at);
    const db = parseDateOnly(a.event_date || a.created_at);
    if (da && db) return da - db;
    // Undated last, as the sibling comparators do. Returning 0 here made
    // the order non-transitive, so the sort could return anything (LL-1).
    if (da) return 1;
    if (db) return -1;
    return 0;
  };
