# FINDINGS: complianceStatus (oracle_compliance.py, AS12 group A)

Golden: `test-data/assurance/goldens/complianceStatus_cases.json`, 103 cases, 3 knownDefect.

No defect of this module's own. Every status in STATUS_SEVERITY is reached;
the precedence (lifecycle, expired over overdue, overdue despite filing,
due soon inside the lead time, Compliant only with evidence) and the lead
time edges (0, 7, 30 default, 90; exactly at the edge and one day past;
null, '', negative, text, NaN falling back to 30; '10' honoured) agree,
including 30-day windows spanning the US and NZ DST changes. rollForward
agrees for all five frequencies including Jan 31 + 1 month (Feb 28, and
Feb 29 in 2028), Aug 31 + 3, Mar 31 + 6, a leap day + 12 and + 24, and
None for One-off, Other, unknown frequencies and unreadable dates.
summarise (all 9 counts and `attention`), countBy, byUrgency (status then
nearest date, undated last, stable ties) and explainStatus (status,
daysUntil, nextActionDate) are all computed independently.

The 3 knownDefect cases are CAL-1 knock-ons (see FINDINGS-calendar.md):
an expiry of 2026-09-31 becomes 1 October and the obligation reads Due soon
instead of Compliant; evidence dated 2026-02-30 counts as filed; and
rollForward('2026-02-30', Monthly) returns 2026-04-02.

## Rules taken from the code, not the docs

- An unknown lifecycle string ('Archived') is tracked as Active.
- explainStatus returns daysUntil and nextActionDate even for a Draft,
  Superseded or Not applicable obligation (it has dates, they just do not
  drive the status).
- In byUrgency, ties within a status keep input order (stable sort).

## Ambiguities for the owner

- Evidence recency is not checked: a `last_submitted_date` from years ago
  still makes a not-yet-due obligation "Compliant". The docstring says
  "something has actually been filed", and AS3 deliberately keeps it; the
  roll-forward on filing is what keeps it honest. Worth a line in the help.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.
