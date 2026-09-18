# FINDINGS: isoCompliance (AS8, ISO Compliance)

Oracle: `tools/validation/assurance/oracle_iso.py` (stdlib Python 3), which
writes `isoCompliance_cases.json`: 186 cases, 5 knownDefect (ISO-1, ISO-2
x2, ISO-3, CAL-1). Every other case agrees with the engine. Every function
export has a case, including the re-exports.

Sources: the module docstrings, AssuranceApps-STATUS.md §3g, migration
20260917600000, ISO 9001:2015 §4.3, §9.2 and §10.2, and ISO 19011. Dates
are modelled with `datetime.date`.

## ISO-1: `summarise()` ignores each standard's certification cycle

Case `summary-honours-standard-cycle`, today 2026-09-17. One standard has
`cycle_years: 1` and two evidenced clauses: c1 was last examined internally
on 2025-03-01, c2 on 2026-09-01.

- Engine: clausesCovered 2, clausesStale 0.
- Oracle: 1 and 1.

`summarise()` calls `clauseCoverage` with no `cycleYears`, so every clause
is judged against three years. `cycle_years` is a real column (check 1 to
6, editable on the Standards page), and `certificationReadiness()` does use
it. On the same data, case `ready-agrees-with-summary-cycle` shows
readiness reporting c1 as stale while the dashboard summary counts it as
covered.

Blast radius:

- iso-compliance `Dashboard.jsx` lines 76-78 (the coverage chart, shown
  next to the readiness cards).
- `Reports.jsx` lines 184-212.
- The Assurance hub.
- Suite-side, `ClauseRegister.jsx:90` and `Reports.jsx:67` also call
  `clauseCoverage` without `cycleYears`.

Only standards whose cycle is not three years are affected.

## ISO-2: `findingAgeDays()` keeps counting after closure

Cases `age-closed-stops-at-closure` and `age-voided-stops`.

- Closed finding, raised 2026-01-01 and closed 2026-02-01: engine 259,
  oracle 31.
- Voided finding, raised 2026-03-01 and closed 2026-03-04: engine 200,
  oracle 3.

Age is how long the finding was open. `qualityAssurance.ncrAgeDays` already
stops at `closed_date`, and both findings tables store `closed_date` with a
check that `closed_date >= raised_date`.

Blast radius: the iso `FindingDetail.jsx` Age tile, the iso
`FindingsRegister.jsx` CSV and, through the re-export, the audit-manager
`FindingDetail.jsx` and `Findings.jsx` CSV. Open findings are unaffected.

## ISO-3: on 29 February the cycle starts on 1 March

Case `coverage-leap-day-boundary`: today is 2028-02-29, the cycle is three
years, and the clause was last examined on 2025-02-28.

- Engine: covered false, stale true.
- Oracle: covered true, stale false.

`new Date(2025, 1, 29)` rolls over to 2025-03-01. Postgres intervals,
date-fns `subYears` and dateutil all step back to 28 February instead. The
roll-over is a side effect of the Date constructor, not a decision.

Low severity. The neighbouring days (`coverage-leap-day-agreed`,
`coverage-leap-to-leap`, `coverage-march-first`) are pinned and agree.

## CAL-1 (shared)

`parseDateOnly('2026-02-30')` returns 2026-03-02 rather than null. See
FINDINGS-calendar.md. It is pinned once here (`parse-feb-30`) because of
the re-export.

## Rules taken from the code, not the docs

- **Blocker order:** blockers are ordered within each severity, and the
  "no applicable clauses" blocker comes first with `count: 0`.
- **Coverage fallback:** when `examined_on` is missing, coverage falls back
  to `audits.actual_end`. The schema makes `examined_on` mandatory, so this
  only affects rows that cannot be stored.
- **`isAssessed`:** requires an assessed date.
- **Lead-day limits are inclusive:** a certificate 90 days out counts as
  expiring, and one 91 days out does not.
- **Nonconformant status:** requires a date and an assessor, but no
  evidence reference.

## Ambiguities for the owner (not pinned)

1. Cancelled and in-progress internal audits still count as coverage. ISO
   9001 §9.2.2(c) expects results to be reported.
2. Independence is checked for the lead auditor only. `audit_team` is free
   text.
3. An expired certificate appears only in `counts`, never as a blocker.
4. When one clause has two examinations on the same day with different
   results, the engine keeps the first row it meets.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.
