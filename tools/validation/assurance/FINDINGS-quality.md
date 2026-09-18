# FINDINGS: qualityAssurance (AS12 oracle, group B)

Oracle: `tools/validation/assurance/oracle_quality.py`. Golden:
`qualityAssurance_cases.json` (296 cases).

Independence: the engine was read once, for signatures, fields and
vocabularies only. The oracle was written from the four docstring rules,
STATUS §3f, ISO 9001:2015 §8.7 and §10.2, and inspection and test plan
(ITP) hold and witness point practice. Percentages and mean ages round
half up (12.5 becomes 13, 1.5 becomes 2).

## Disagreements

The engine and the oracle agree on every rule case except CAL-1, which
comes from the calendar.js re-export: `parseDateOnly('2026-04-31')` returns
2026-05-01 where the oracle returns null. Case: parse-31-april.

## Rules taken from the code, not the docs

- R1. PLAN_TRANSITIONS: a Draft may go straight to Active, and only an
  Active plan can close.
- R2. `canCloseNcr` treats a CAPA with no status as open.
- R3. `ncrAgeDays` takes the first present of raised_date and created_at.
  A closed NCR with no closed_date keeps ageing to today.
- R4. `capasAwaitingEffectiveness` counts every Complete CAPA that has no
  effectiveness verdict.
- R5. NCR urgency order: serious and overdue, serious, overdue, open,
  closed. Ties sort by due_date, else raised_date, earliest first.
- R6. An NCR raised in the future has a negative age.

## For the owner's attention

- O1. A HOLD point can be set "Not applicable" with no date, verifier or
  reason, and that clears it for plan closure. "Waived" has the same effect
  but needs a verifier and a reason.
- O2. A CAPA marked effectiveness_verified:true with no record of who
  checked it falls in no effectiveness bucket. The database constraint
  should prevent that row.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.
