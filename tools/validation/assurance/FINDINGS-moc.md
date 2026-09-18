# FINDINGS: managementOfChange (AS12 oracle, group B)

- Oracle: `tools/validation/assurance/oracle_moc.py` (stdlib Python)
- Golden: `test-data/assurance/goldens/managementOfChange_cases.json` (227
  cases)

Independence note. The engine was read once, for signatures, field names
and vocabularies. The oracle was written from the module docstring's three
rules, STATUS §3e and CCPS MOC practice. Python `datetime.date` is the
calendar model.

## Disagreements (knownDefect)

### MOC-1: an unreadable expiry date reads as "Expiring soon" and passes the implementation gate

`expiryState` tests `days < 0` and then `days <= EXPIRY_LEAD_DAYS`. For a
string it cannot read, `daysUntil` returns null. In JS `null < 0` is false
and `null <= 14` is TRUE, so the unreadable date reads as expiring soon.

| input (today 2026-09-18) | engine | oracle |
|---|---|---|
| expiryState({type:'Temporary', stage:'Implementation', expiry_date:'after turnaround'}) | Expiring soon | No expiry |
| expiryState({type:'Emergency', stage:'Implementation', expiry_date:'2026-02-30'}) | Expired (via CAL-1) | No expiry |
| canAdvance(temporary change with expiry 'next shutdown', 'Implementation', all approvals signed) | {ok:true} | {ok:false} |
| summarise([that change]).expiringSoon | 1 | 0 |

Why the oracle is right:

- The module's third rule says a temporary change does not go in without a
  date to come back out.
- calendar.js says an unreadable date is no date.
- The gate tests only that a string is present (`!moc.expiry_date`), not
  that the date can be read.
- `isOverdue` in the same file already guards `days !== null`.

Blast radius: moc `Dashboard.jsx`, `Register.jsx` (the sort and the
"Expiry state" CSV column), `Reports.jsx`, `MOCDetail.jsx` and
`MOCBadges.jsx`. Practical exposure is low, because the database column is
a Postgres `date`.

Cases: expiry-unreadable-date, expiry-30-february, advance-impl-temp-unreadable-expiry,
summarise-unreadable-expiry.

### CAL-1 (calendar.js, re-exported): an impossible date rolls over and is not treated as no date

- `parseDateOnly('2026-02-30')` returns 2026-03-02.
- `'2026-13-01'` returns 2027-01-01.
- `'2027-02-29'` returns 2027-03-01.

## Rules taken from the code, not the docs

- R1. The STAGE_TRANSITIONS edges.
- R2. A CLOSED temporary change is outside expiry tracking (NOT_APPLICABLE).
- R3. For urgency, "Expiring soon" ranks between Expired and Overdue.
- R4. Ties within a rank sort by expiry_date, else target_implementation_date,
  earliest first, undated last.
- R5. An approval row with no level counts as level 1.
- R6. `summarise().overdueActions` counts every open action past its due
  date, whatever its phase.

## For the owner's attention

- O1. A closed temporary change reads "Permanent change", and the Register
  CSV "Expiry state" column exports it that way.
- O2. R4 mixes keys within a rank.
- O3. The implementation gate requires full multi-level approval for
  Emergency changes as well. CCPS practice often allows reduced authority
  with an after-the-fact review. Whether to be this strict should be a
  decision.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.

## AS13-0 (2026-09-18): O1 decided

A closed Temporary or Emergency change now reads `EXPIRY.CLOSED_OUT`
("Closed out"). It no longer exports as "Permanent change".

## AS14 (2026-09-18): MOC-AS14-1

`summarise` counted unfinished actions on closed, rejected and cancelled
changes as open and overdue work. The change's record is locked, so
nobody can finish them and the dashboard number never fell. They are now
skipped; an action whose change is not in `records` still counts. Case
`summarise-actions-on-finished-changes` fails against the previous
engine.

## AS15 (2026-09-18): owner decisions

- **AS15-Q9, emergency-change authority.** An Emergency change may enter
  Implementation once its LOWEST approval level has an Approved row and
  nothing is rejected (CCPS: reduced authority up front). Every remaining
  level must sign within `EMERGENCY_RATIFY_DAYS` (7) of
  `actual_implementation_date`, and the change cannot close until they
  have. `ratificationState`: day 7 after implementation reads Awaiting
  ratification, day 8 Ratification overdue; no readable implementation
  date reads Overdue (fails closed). `summarise` gains
  `ratificationPending` and `ratificationOverdue`. Temporary and
  Permanent changes still need every level first.
- **AS15-D1, segregation of duties.** `canAssignApprover` refuses the
  originator; `canDecideApproval` allows only the assignee, only while
  Pending, and never the originator even when assigned.
- **Engine bug fixed in passing (found by the oracle's reading of "an
  approval belongs to the change whose id it carries"):** the first AS15
  draft of `summarise` matched approvals with `a.moc_id === m.id`, so a
  record with no id picked up every approval with no `moc_id`
  (undefined === undefined). A record with no id now owns no approvals.
  Case `summarise-ratification`.

Negative control: against origin/main the new `AS15-*` cases fail (the
new exports do not exist; emergency implementation on a first-level
signature is refused; closing an unratified emergency change is allowed).

## ASC-0 (2026-09-18): the repairs the Risk and Change course found

- **RC-3, a change in effect read overdue against its target
  implementation date.** `isOverdue` tested `ACTIVE_STAGES`, which include
  Implementation, and Implementation is also in `IN_EFFECT_STAGES`: the
  same change was "on the facility" for its expiry and "late to be
  implemented" for its overdue flag. Repro:
  `isOverdue({stage:'Implementation', target_implementation_date:'2026-09-26',
  actual_implementation_date:'2026-09-26'}, new Date(2026,9,1))` -> `true`.
  The oracle agreed (same ACTIVE list), so this was a rule ambiguity, and
  the lead ruled: overdue against `target_implementation_date` applies
  only BEFORE the change is on the facility, i.e. Draft, Screening,
  Review and Approval. Late work after implementation is carried by
  overdue ACTIONS (`summarise().overdueActions`), which did not change.
  `summarise().overdue` and the `byUrgency` rank ask `isOverdue`, so both
  follow: an Implementation change past its target now ranks with live
  work (rank 3) instead of overdue (rank 2). Doc comments say so. The
  oracle's `o_is_overdue` now reads a `PRE_EFFECT` list.
- **Goldens moved (4 existing, expected only):** `overdue-Implementation-past`
  true -> false; `summarise-register` overdue 3 -> 2;
  `summarise-no-context` overdue 2 -> 1;
  `summarise-lead-edge-moves-a-day-later` overdue 4 -> 3. In each summary
  the one change that left the count is in Implementation. No other key
  moved. 8 cases added (`rc3-*`), including the course repro, every
  pre-effect stage still overdue, a summary with in-effect changes past
  target and an urgency sort. 272 -> 280. The previous engine fails the 4
  moved cases and 4 of the 8 new ones (the pre-effect cases pass on both,
  by design).
- **Not changed:** expiry, ratification, the approval gate, action
  counts, the within-rank date mix (O2).
