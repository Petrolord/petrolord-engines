# FINDINGS: documentControl (oracle_documents.py, AS12 group A)

Golden: `test-data/assurance/goldens/documentControl_cases.json`, 116 cases, 3 knownDefect.

## DC-1 an unreadable review date reads "Review due soon"

`reviewState({status:'Published', next_review_date:'tbc'}, 2026-09-17)`:
engine 'Review due soon', oracle 'No review scheduled'.

`daysUntil` returns null for an unreadable date; `reviewState` then does
`null < 0` (false) and `null <= 30`, which is TRUE because null coerces
to 0. So any non-empty unreadable review date is reported due soon, and
counted in `summarise().dueSoon` and the dashboard's due list. Why the
oracle is right: calendar.js's rule "an unreadable date is no date, never
today", and complianceStatus / peerReview both guard the null (peerReview:
`days !== null && days < 0`). Fix: `if (days === null) return REVIEW.NOT_SCHEDULED;`.

Blast radius: document-control StatusBadge, Library and Reports
("Review state" column/export), Dashboard's due-for-review list and the
summarise counts. Severity LOW from Postgres (a `date` column is null or
a real date); real for imported or hand-built rows.

The other 2 knownDefect cases are CAL-1 knock-ons (FINDINGS-calendar.md):
a review date of 2026-02-30 reads Review overdue, and
`nextReviewDate('2026-02-30', 12)` returns 2027-03-02.

## Rules taken from the code, not the docs

- Status matching is exact and case-sensitive ('published' is not in force).
- `summarise.byStatus` counts only the seven known statuses; `total`
  counts every row.
- `nextRevisionNumber` accepts ASCII digits only after trimming; '00' -> '01';
  a number argument is stringified (3 -> '04').
- `documentPrefix` drops accented letters rather than transliterating
  ('Géologie' -> 'GOL').
- byReviewUrgency sorts by review date inside every state, including
  Not in force.

## Ambiguities for the owner (not pinned)

- `nextReviewDate(issue, periodMonths)` does not default to
  `DEFAULT_REVIEW_PERIOD_MONTHS` (24) when the period is missing; it
  returns null and leaves the default to the caller.
- A fractional period is truncated by the Date constructor: 0.5 months
  passes the `> 0` check and returns the issue date itself (a document due
  for review on the day it is issued). The DB column is an integer, so this
  only reaches a caller passing a computed value. No case written.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.
