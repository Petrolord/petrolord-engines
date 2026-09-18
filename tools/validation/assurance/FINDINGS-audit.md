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
- `isAuditOverdue` stops at Reported here, whereas AS8 keeps a Reported
  audit overdue.
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
