# FINDINGS: peerReview (oracle_peer_review.py, AS12 group A)

Golden: `test-data/assurance/goldens/peerReview_cases.json`, 151 cases, 5 knownDefect.
The full 6x6 disposition grid, every stage's moves, the Verified-needs-a-
response rule, isResolved/isBlocking over every severity and status,
canClose (including the blocking list), isOverdue over every stage and the
date edges, summarise (all nine fields), countBy and byUrgency agree.

## PR-1 a comment with no severity sorts ABOVE Critical

`bySeverityThenAge` ranks by `SEVERITIES.indexOf(severity)`; an unknown or
null severity is -1, which is before Critical (0). In the pinned case an
unrated open comment is first; the oracle puts it after Editorial among
the unresolved. "Comments worst first" cannot mean an unclassified comment
outranks a showstopper. `peer_review_comments.severity` is nullable
(`check (severity is null or severity in (...))`) and the AS1 schema's
default was 'Minor', so null/legacy rows exist in principle.
Blast radius: ReviewDetail comment list order (the Dashboard sorts only
`isBlocking` comments, which excludes null severity). Severity LOW.
Fix: map -1 to `SEVERITIES.length`.

## PR-2 "A open comment ..." in a user-facing refusal

`explainRefusal({status:'Open'}, 'Verified')` (and any illegal move from
Open, including a comment with no status) returns
"A open comment can only go to Responded or Withdrawn." The oracle expects
"An open ...". Open is the only status that starts with a vowel and the
commonest state a comment is in. Blast radius: the refusal returned by
`usePeerReview`'s comment status change (surfaced to the user when a move is
refused). Copy only.

The fifth knownDefect case is a CAL-1 knock-on (FINDINGS-calendar.md):
a review due '2026-02-30' is overdue on 2026-09-17.

## Rules taken from the code, not the docs

- `explainRefusal` returns a bare string, which the runner compares
  verbatim, so its sentences were copied from the code. The oracle decides
  independently which refusal applies (allowed / needs a response /
  already there / final / can only go to) and the article.
- A comment with an unknown status ('Pending') has no legal move and is
  reported "final".
- Within a severity, older `created_at` first (string order of ISO
  timestamps; missing timestamp first). "Then age" does not say which way.
- byUrgency: within a rank the earlier due date first, undated last,
  including for closed/cancelled reviews.
- `summarise.byStage/bySeverity/byStatus` count only known values;
  `total`, `totalComments` and `openComments` count every row (an unknown
  status is unresolved and so open).

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.
