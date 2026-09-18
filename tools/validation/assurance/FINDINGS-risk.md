# FINDINGS: riskScoring (oracle_risk.py, AS12 group A)

Golden: `test-data/assurance/goldens/riskScoring_cases.json`, 111 cases, 5 knownDefect.
All 25 matrix cells, every product's band, off-scale refusals, the band
edges (14/15, 9/10, 4/5, 0.5, 4.5, 14.5, 26), per-axis residual, every
appetite outcome, review overdue, deriveRiskFields and countByBand
(inherent and residual) are independent and agree, apart from the below.

## RS-1 `isReviewOverdue` bypasses calendar.js (UTC parse; lenient parse)

`isReviewOverdue` is the one date rule in the Assurance engines that does
not use `parseDateOnly`. It does `new Date(risk.next_review_date)`, which
for `'YYYY-MM-DD'` is UTC midnight: the exact defect AS3 recorded
(STATUS 3b.3) and calendar.js exists to prevent.

- West of Greenwich a review due TODAY reads overdue. Verified:
  `TZ=America/Los_Angeles`, `isReviewOverdue({next_review_date:'2026-09-17'}, new Date(2026,8,17))`
  returns `true`; the method statement ("a review due today is not yet
  overdue") says `false`. Same in St John's.
- Pinned case `review-feb-30`: `{next_review_date:'2026-02-30'}` as of
  2026-03-05. V8 parses '2026-02-30' leniently to 2 March, so the engine
  says `true`; an unreadable date is no date, so the oracle says `false`.

**The time-zone half cannot be pinned by the harness.** A knownDefect case
must fail in the main (UTC) jest run and is skipped in the zone sweep; this
defect is correct in UTC and east of it and wrong only west. So the golden
pins due-today with a `Date` argument (engine correct) and keeps its
string cases at least a day from the edge, and the zone half lives only
here. Harness owners may want a per-zone knownDefect form.

Blast radius: Suite `RiskDetailPage` (`isReviewOverdue(risk)` prints
"· overdue" in red beside the review date). Fix: `daysUntil(next_review_date, asOf) < 0`
from calendar.js.

## RS-2 residual treats the register form's "not assessed" ('') as a level

The register's own form holds "no residual assessment" as the empty
string: `RiskForm` initialises `residual_likelihood: initialData.residual_likelihood || ''`
and maps the 'none' option to `''`. `calculateResidualScore` falls back
with `??`, which only catches null/undefined, so `''` is passed through,
`Number('')` is 0, the level is off-scale and the residual is 0 (band None).

| input | engine | oracle |
|---|---|---|
| L4 I5, residual L '' I '' | residual 0 | 20 (inherent, per axis) |
| L4 I5, residual L 2, I '' | residual 0 | 10 (2 x inherent impact 5) |
| L4 I4, residual '' '', target 8 | appetite 'Not set' | 'Above appetite' (16 > 8) |
| deriveRiskFields(L4 I5, rL 2, rI '', target 8) | residual 0/None, appetite 'Not set' | 10/High, 'Above appetite' |

Why the oracle is right: the docstring ("a risk whose residual position
has not been assessed ... its residual IS its inherent score") and STATUS
3.4 ("falls back PER AXIS, because mitigation that cuts likelihood but not
impact must not silently reset impact") are exactly the case of one axis
left at 'none' on the form. The generated DB column agrees with the oracle
(the payload drops '' so the column is null and COALESCEs per axis), so
the engine now disagrees with the database it says it must match.

Blast radius: (1) RiskForm live preview shows residual 0 / no band and
"Appetite: Not set" whenever one residual axis is left at none. (2)
`buildRiskWrite` stores `appetite_status` from `deriveRiskFields(form)`,
so the stored column reads 'Not set' for every risk saved with a target
and an incomplete (or absent) residual; `useRiskSnapshots` copies that
stored column into board-review snapshots. The hub recomputes from DB rows
(null, not ''), so the hub is right and disagrees with the stored column.
Fix: treat '' as not assessed (e.g. `const pick = (r, i) => (r === '' || r == null ? i : r)`).

## Rules taken from the code, not the docs

- `getRiskBand` uses lower bounds only; the `max` of each band is
  decorative, so 26 or 30 is Critical and 14.5 is High, 4.5 Low, 0.5 None.
- A numeric string level ('3') is accepted; a residual level that is SET
  but off the scale (e.g. 7) is not a fallback, it zeroes the residual.
  Consistent with "never guesses a level"; the DB check forbids it anyway.
- `rating` is the inherent band (STATUS 3.2 ties it to the stored score).

## Ambiguities for the owner (not pinned)

- Non-integer levels (2.5) are accepted and multiplied (2.5 x 4 = 10,
  High). A 5x5 ordinal matrix has no level 2.5; the DB integer columns
  make it unreachable from storage but not from a caller. No case written.
- `calculateRiskScore(true, 5)` scores 5 (Number(true) = 1).

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.
