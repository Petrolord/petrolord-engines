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

## ASC-0 (2026-09-18): the repairs the Risk and Change course found

- **RC-4a, peer review had no independence rule (owner decision D1 of
  2026-09-18, extended to peer review by the lead).** `TRANSITION_ACTOR`
  named a party only for a button label; nothing stopped the author of
  the work under review from verifying or rejecting the findings against
  it, or from being rostered as its reviewer. Added, in the shape of
  MOC's `canAssignApprover` / `canDecideApproval`:
  - `REVIEWER_ROLES` = Lead Reviewer, Reviewer.
  - `canAssignPeerReviewer(review, participant)`: `participant` is a
    `peer_review_participants` row (`user_id`, `display_name`, `role`).
    Refused when nobody is named ("Choose the reviewer."), and when the
    role is a reviewer role (no role counts as Reviewer) and `user_id`
    equals `peer_reviews.author_id`. The same call answers for
    `peer_reviews.lead_reviewer_id`. An external reviewer named by
    display name only, a review with no `author_id`, and the author in a
    non-reviewer role (Author, Coordinator, Approver, Observer) are
    allowed.
  - `canActOnComment(comment, to, review, userId)`: the disposition rules
    first (`explainRefusal`), then no signed-in user refuses, then a
    reviewer-owned move (`TRANSITION_ACTOR[to] === 'reviewer'`: Verified,
    Rejected, Withdrawn) is refused when `userId` equals
    `review.author_id`. Responded (author) and Closed (coordinator) are
    not restricted.
  - The author is `peer_reviews.author_id`. `created_by` (who raised the
    record, often the coordinator) is deliberately NOT read: treating it
    as the author would bar every coordinator who opens a review from
    reviewing it, which D1 did not decide.
  Cases `rc4a-*` (26). The Suite hook and a database trigger are the next
  wave.
- **RC-4b, `summarise` counted comments on finished reviews.** Repro:
  `summarise([{id:'a',stage:'Cancelled'}],
  [{review_id:'a',severity:'Critical',status:'Open'}], asOf).blockingComments`
  -> 1, for ever, because a cancelled review is locked and nobody can
  resolve it. Changed: `openComments` and `blockingComments` skip
  comments whose review is in `reviews` with stage Closed or Cancelled,
  the AS14 rule MOC and QA follow. `totalComments`, `bySeverity` and
  `byStatus` are history and still count every comment. A comment whose
  review is NOT in `reviews` (or has no `review_id`) still counts,
  matching MOC's held rule for an action with an unknown change ("not
  knowing the parent is not a reason to hide the work"). Cases `rc4b-*`
  (3); the previous engine fails the two with a finished parent (the
  third, with no reviews supplied, reads the same before and after).
- **Goldens moved:** none of the 151 existing cases changed (their
  comments carry no `review_id`). 29 added. 151 -> 180.
- **Not changed:** the disposition machine, `canClose`, the stage machine,
  who may raise a comment (the author raising a comment on their own
  work is not refused; D1 as ruled covers reviewing and the reviewer's
  moves).
- **RC-9 (copy), count agreement.** Repro: `canClose([{severity:'Critical',
  status:'Open'}]).reason` -> "1 critical comment still need resolving.
  Verify, close out or withdraw them first." Now "1 critical comment still
  needs resolving. Verify, close out or withdraw it first."; two or more
  keep "need" and "them". `explainRefusal` already chose its article (PR-2);
  it now uses the same helper for the "is final" branch too ("An open
  comment ..." was already right; "A withdrawn comment is final." is
  unchanged). Golden cases `rc9-close-*` (4) compare the sentence
  verbatim; the previous engine fails the two single-comment cases. 184
  cases in total.
