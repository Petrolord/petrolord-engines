# FINDINGS: lessonsLearned (AS12 oracle, group B)

Oracle: `tools/validation/assurance/oracle_lessons.py`. Golden:
`lessonsLearned_cases.json` (328 cases).

## Disagreements (knownDefect)

### LL-1: lessonByAttention is not an ordering when a lesson has no date

Within a rank the comparator returns 0 when exactly one side is undated.
The comparison is then non-transitive, so the sort order is undefined.

| rows | engine | oracle |
|---|---|---|
| jan, undated, may | jan, undated, may | may, jan, undated |

The fix puts undated last, as the sibling comparators do.

- Blast radius: the lessons-learned Dashboard needs-attention list. Low,
  because every row has created_at.
- Case: attention-undated-between-dated.

### CAL-1 (calendar.js re-export)

`parseDateOnly('2026-06-31')` returns 2026-07-01. Case: parse-31-june.

## Rules taken from the code, not the docs

- R1. The LESSON_TRANSITIONS edges.
- R2. The searchable fields. An array of keywords is searched as its joined
  string.
- R3. The author is author_id, else created_by.
- R4. `canArchive` and `canSupersede` take the patch value when it is
  present, even when it is ''.
- R5. Moving to Published does not re-check that the validator differs from
  the author.
- R6. The application counts in `summarise()` include applications for
  lessons that are not visible.
- R7. The attention ranks.
- R8. The `missingSubstance` phrases are compared exactly.

## For the owner's attention

- O1. The hook passes validatorId = null whenever a validator name is
  typed, so an author can validate their own lesson by typing a name.
- O2. Publishing does not re-check independence.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.

## AS15 (2026-09-18): owner decisions

- **AS15-Q10, validation by typed name.** `canValidate`'s second argument
  is the ACTOR, the signed-in person doing the validation, whatever
  external name they type. The rule itself did not change; the defect was
  that the Suite passed null whenever a name was typed, so an author
  could validate their own lesson by typing any name. The new cases pin
  the contract: the author as actor is refused with a typed name in the
  patch, and a colleague recording an external name is allowed. An actor
  of null still passes the engine (`validate-external-no-id`): the
  engine cannot know who is signed in, and the Suite hook must always
  pass it (it does from AS15).

Negative control: these cases have the same verdict on origin/main (the
engine rule is unchanged); what changed is the reason text and the
caller. The guard is in the Suite hook test.

## ASC-0 (2026-09-18): RC-9, copy

- **Article.** `canAdvanceLesson({status:'Archived'}, 'Draft').reason` ->
  "A archived lesson is final." Now "An archived lesson is final." (the
  article follows the status word; "A superseded lesson is final." is
  unchanged).
- **List.** `canValidate` listed what a lesson is missing with " and "
  between every item: "missing what happened and why it happened and what
  to do about it". Now "what happened, why it happened and what to do
  about it".
- Golden cases `rc9-*` (6), verbatim (`"prose": "exact"`); the previous
  engine fails 3 (archived, obsolete, all-three). No existing case moved.
  333 -> 339.

## ASC-0 item 12 (2026-09-18): created_at is an instant

- `lessonAgeDays` and `lessonByAttention` date a lesson with no
  `event_date` by `created_at`, now read through calendar.js's
  `localDateOf` (its local calendar date). Repro, TZ=Africa/Lagos:
  `lessonAgeDays({created_at:'2026-09-17T23:30:00+00:00'}, new Date(2026,8,20))`
  -> 3 (dated the 17th, the UTC date); now 2 (00:30 on the 18th local).
  See FINDINGS-calendar.md for the rule and the harness tag.
- Goldens moved (ARGUMENTS only, no expected value): `age-created-at-only`
  (created_at '2026-09-01T23:59:00Z' -> `$localInstant` '2026-09-01T23:59',
  age still 17) and `attention-register` / `attention-empty-map` (the
  'submitted' row's created_at '...T09:00:00Z' -> `$localInstant`
  '...T09:00', order unchanged). A literal instant's local date differs by
  zone, so the old arguments could not stay under the new rule. Added
  `item12-*` (6): 00:30 and 23:30 local, created today, event date wins,
  and an attention sort. 339 -> 345.

## Prototype-chain lookups (2026-09-21, repo-wide sweep)

A table read as `TABLE[key]` walks the prototype chain, so `'constructor'`,
`'toString'`, `'valueOf'`, `'hasOwnProperty'` and `'__proto__'` are found in
every object literal. Every such read in this module now checks own
properties only; valid keys behave exactly as before and no golden moved.
Gate: `__tests__/prototypeChainLookups.test.js` (red on the unrepaired code).

- `nextLessonStatuses` returned a function for an inherited status; it now returns `[]`. `summarise` counts own keys only.
