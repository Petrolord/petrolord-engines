# FINDINGS: auditManagement (AS10, Audit & Findings Manager)

Oracle: `tools/validation/assurance/oracle_audit.py`, which writes
`auditManagement_cases.json`: 163 cases, 2 knownDefect (ISO-2, CAL-1). Both
defects come in through re-exports. **There is no disagreement in AS10's
own rules.** Every export has a case, including every isoCompliance
re-export.

Sources: the module docstrings, AssuranceApps-STATUS.md §3i, and the
header, constraints and triggers of migration 20260917800000. The finding
and action rules are imported from `oracle_iso.py` on purpose, in the same
way the engine imports AS8's.

## Pinned here

- **ISO-2** (`reexport-age-closed`): a finding raised 2026-07-01 and closed
  2026-07-15. Engine 78, oracle 14.
- **CAL-1** (`reexport-parse-feb-30`).

## Rules taken from the code

- A cancellation reason in the patch wins, even when it is blank (`??`).
- Rule 2 (a critical nonconformance must raise a finding) applies to ad-hoc
  audits as well, as the migration trigger does.
- `isAuditOverdue` stops at Reported here, whereas AS8 kept a Reported
  audit overdue until ASC-1 (E3) aligned AS8 with this module.
- `findingByAttention` tie-breaks on the due date, else the raised date,
  and dated findings sort before undated ones.

## Ambiguities for the owner (not pinned)

1. **The engine header states two rules the engine does not enforce:**
   Not applicable needs a reason, and a programme completes only when its
   cancelled audits carry a reason.
   - `isAnswered`, `checklistProgress`, `unansweredItems` and
     `canReportAudit` count a Not applicable answer that has no note.
   - `programmeProgress` and `canCompleteProgramme` count any Cancelled
     audit as done.
   - Both rules are enforced at write time instead, by the check
     constraints `audit_responses_na_needs_reason` and
     `audit_records_cancel_needs_reason`, by the answer form, and by
     `canCancelAudit`.
   - The oracle trusts the stored status: cases
     `complete-cancelled-no-reason-trusts-status` and
     `answered-not-applicable`.
2. **Percent rounding:** `Math.round(57/200*100)` gives 28 because of
   binary floating point, where exact half-up gives 29. Cosmetic.
3. **Complete programmes can show under 100%.** `percent` counts reported
   audits over all audits, so a legitimately Complete programme that
   includes cancelled audits reads below 100%. This is deliberate per the
   docstring.
4. **A templated audit passed with no `items` passes rule 1 vacuously**
   (`report-template-empty-protocol`). The database trigger counts the
   template's items itself.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.

## AS15 (2026-09-18): owner decisions

- **AS15-Q11, the engine no longer trusts the stored row.** Both AS10
  reason rules were enforced only at write time (the form, plus the
  `audit_responses_na_needs_reason` and
  `audit_records_cancel_needs_reason` constraints), and the engine
  believed the status:
  - `isAnswered` now treats "Not applicable" with a blank, whitespace-only
    or missing note as unanswered. So `checklistProgress`,
    `unansweredItems` and `canReportAudit` refuse a checklist that was
    emptied by unexplained N/A.
  - `canCompleteProgramme` treats a Cancelled audit with no written
    `cancellation_reason` as outstanding.
  - The oracle's `checklist_progress` now counts through `answered()`.
    Case `complete-cancelled-no-reason-trusts-status` is replaced by
    `complete-cancelled-{no,blank,whitespace}-reason-outstanding`. Also
    `answered-na-*`, `answered-not-applicable`,
    `progress-na-without-reason-is-outstanding`,
    `unanswered-na-without-reason` and
    `report-refused-over-na-without-reason`.

Negative control: against the pre-AS15 engine every case above fails.

## ASC-0 (2026-09-18): RC-9, copy (family sweep)

- "A <status> audit is final." and "A <status> programme is final." now
  choose their article from the word ("An archived audit is final."). No
  status the module defines starts with a vowel, so only an unknown value
  printed the defect; nothing in the goldens moved. Covered by
  `__tests__/assurance.copy.test.js`.

## ASC-0 (2026-09-18): the repairs the Compliance course found

- **R1, two authorities for "outstanding".** AS15 Q11 made a cancellation
  with no written reason outstanding in `programmeProgress` and
  `canCompleteProgramme`; `summarise().auditsOutstanding` still counted
  it done. Repro, audits [Reported, Cancelled with no reason, Cancelled
  'Plant shutdown', Planned ending 2026-09-01] as of 2026-10-15:
  `programmeProgress(...).outstanding` 2, `summarise({audits}).auditsOutstanding`
  1. The oracle's `programme_progress` did not model Q11 either (it said
  1 as well), and no golden case put a reasonless cancellation inside a
  programme, so nothing caught it. Changed: one internal predicate,
  `isOutstandingAudit`, answers for all three; the oracle's new
  `audit_outstanding` models Q11 once for `programme_progress` and
  `summarise`. Cases `r1-*` (4): the repro in each function and a
  blank/whitespace-reason set. The previous engine fails the two
  summarise cases (its programmeProgress was already right). No existing
  case moved. 171 -> 175. Latent in production: the database constraint
  `audit_records_cancel_needs_reason` refuses such a row on the write path.
- **R2, percent rounding at an exact half (ambiguity 2 above, now
  decided).** `checklistProgress` on 57 answered of 200 printed 28:
  `Math.round((57 / 200) * 100)` rounds the binary float 28.499999...,
  where the exact 28.5 rounds half up to 29. The lead ruled every
  percentage in the family is round half UP on the EXACT rational.
  Changed: `checklistProgress` and `programmeProgress` compute
  `floor((200n + d) / 2d)` from the integer counts (`halfUpPercent`, with
  the exactness argument in its comment). This oracle already rounded
  that way (`half_up_percent`); the gap was that no golden sat on an exact
  half the float gets wrong. Cases `r2-*` (6): 57 of 200 (29), 23 of 40
  (58), 29 of 200 (15), 1 of 8 (13, where the float agreed). The previous
  engine fails 4 (all but the 1-of-8 pair). No existing case moved. 175
  -> 181.

## ASC-1 (2026-09-18): E3, ISO agrees with this module

`isoCompliance.isAuditOverdue` now returns false for a Reported audit, as
`isAuditOverdue` here always has (see FINDINGS-iso.md, ASC-1). Nothing in
this module changed and no golden here moved (181 cases). The shared
jest check in `assurance.copy.test.js` compares the two predicates for
every audit status.
