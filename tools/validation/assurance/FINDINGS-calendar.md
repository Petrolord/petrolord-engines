# FINDINGS: calendar (oracle_calendar.py, AS12 group A)

Golden: `test-data/assurance/goldens/calendar_cases.json`, 63 cases, 11 knownDefect.
The oracle models a calendar date as Python `datetime.date` (no clock, no zone),
so its day differences are the independent check on the engine's
local-midnight `Math.round` across DST. All DST spans (US 2026-03-08 and
2026-11-01, NZ 2026-04-05 and 2026-09-27) agree in all five sweep zones.

## CAL-1 `parseDateOnly` rolls an impossible date over instead of refusing it

| input | engine | oracle |
|---|---|---|
| `parseDateOnly('2026-02-30')` | 2026-03-02 | null |
| `parseDateOnly('2026-02-29')` | 2026-03-01 | null |
| `parseDateOnly('2026-04-31')` | 2026-05-01 | null |
| `parseDateOnly('2026-13-01')` | 2027-01-01 | null |
| `parseDateOnly('2026-00-10')` | 2025-12-10 | null |
| `parseDateOnly('2026-09-00')` | 2026-08-31 | null |
| `daysUntil('2026-02-30', 2026-09-17)` | -199 | null |
| `toDateOnlyString('2026-02-30')` | '2026-03-02' | null |

Why the oracle is right: the docstring says "Anything else, including an
out-of-range date string's Invalid Date, is null: an unreadable date is no
date". `new Date(y, m-1, d)` never produces an Invalid Date for these; it
normalises them, so the guard `Number.isNaN(d.getTime())` never fires and
30 February silently becomes 2 March. The fix is to check that the built
date's year/month/day equal the parsed ones.

Blast radius: every rule module that imports calendar.js
(complianceStatus, documentControl, peerReview, managementOfChange,
qualityAssurance) and the Suite screens that call `parseDateOnly`
directly (document-control DocumentDetail, Library, Dashboard,
ApprovalQueue; peer-review Dashboard). Knock-on cases are pinned in the
other goldens under the same ID: a permit expiring "2026-09-31" reads Due
soon (engine) instead of the next real date's status; "2026-02-30" evidence
makes an obligation Compliant; a review due "2026-02-30" is Overdue.
Practical severity is LOW for rows read from Postgres (a `date` column
cannot hold 30 February); it bites on CSV/import paths, URL parameters and
any caller that passes a typed string.

## CAL-2 years below 1000 are mis-rendered (two-digit years become 19xx)

| input | engine | oracle |
|---|---|---|
| `toDateOnlyString('0026-09-17')` | '1926-09-17' | '0026-09-17' |
| `toDateOnlyString('0099-12-31')` | '1999-12-31' | '0099-12-31' |
| `toDateOnlyString('0100-01-01')` | '100-01-01' | '0100-01-01' |

`new Date(26, 8, 17)` is 1926 (the legacy two-digit-year rule), and the
formatter does not pad the year to four digits, so the output is not
`YYYY-MM-DD`. Severity LOW, but not hypothetical: a browser date input
holds values like `0002-..`, `0020-..`, `0202-..` while a user is typing a
year, and a live status preview (the AS3 obligation form) would compute
against 1920. Fix with `setFullYear(y, m-1, d)` and `padStart(4, '0')`.
Only `toDateOnlyString` can pin it: the golden `$date` reviver uses the
same `new Date(y, ...)` constructor, so a `$date` expectation for year 26
cannot distinguish the two answers.

## Rules taken from the code, not the docs

- `startOfDay(Invalid Date)` returns an Invalid Date (no docstring).
- A string is read by its leading `YYYY-MM-DD` only; anything after it
  (a time, an offset) is ignored, so `'2026-09-17T01:00:00+14:00'` is
  17 September everywhere. The docstring says "a string beginning
  YYYY-MM-DD", which the oracle follows; noted because it discards the
  offset of a real instant.
- Leading whitespace, `2026-9-7` and `17/09/2026` are not dates.

## Ambiguities for the owner (not pinned)

- `daysUntil(date, today)` with an Invalid Date `today` returns NaN, and
  every rule module then compares NaN (`NaN < 0` and `NaN <= lead` are both
  false), so every obligation reads On track / Compliant, a review reads
  Scheduled. Callers pass `new Date()` today, so it is latent; a guard
  returning null would fail closed.

## Status after AS12 (2026-09-18)

Every knownDefect in this file was REPAIRED in the engine in the same
wave (engines PR "AS12"), and each case now carries `"repaired": "<id>"`
instead of `"knownDefect"`, so it is gated like any other case and a
regression fails the suite. The ambiguities listed above for the owner
were NOT changed; they are recorded in the Suite's
docs/scope/AssuranceApps-STATUS.md §3k for decision.

## ASC-0 item 12 (2026-09-18): the local date of an instant

- **Finding (Suite repair agent, lead's item 12).** `lessonAgeDays` falls
  back from `event_date` to `created_at`, a timestamptz sent as
  `'2026-09-17T23:30:00+00:00'`. `parseDateOnly` takes its leading
  YYYY-MM-DD, the UTC date, so in Lagos (UTC+1) a lesson created between
  00:00 and 01:00 local time was dated a day early (and west of Greenwich,
  one created after 23:00 local a day late in Pago Pago).
- **Changed:** new export `localDateOf(value)`: a string with a time part
  is read as the instant it names and its LOCAL calendar date taken, the
  way `daysUntil` takes today; a date-only string, a Date and anything
  else read exactly as `parseDateOnly` reads them, and an impossible date
  (`2026-02-30T10:00Z`) is still no date. `parseDateOnly` is unchanged: a
  date column that arrives as a timestamp keeps its leading date (cases
  `parse-timestamp-prefix`, `days-timestamp-prefix` did not move).
- **Sweep of the family for a date field that falls back to an instant:**
  `lessonsLearned.lessonAgeDays` and `lessonByAttention` (event_date ->
  created_at) and `qualityAssurance.ncrAgeDays` (raised_date -> created_at,
  which feeds `summarise().oldestOpenNcrDays`, `meanOpenNcrAgeDays` and
  `ncrAgeing`). All three now read through `localDateOf`. No other
  function falls back to an instant. Not a fallback and not changed:
  `managementOfChange.ratificationState` reads
  `actual_implementation_date`, which the Suite stamps with a UTC instant
  (RC-5, a Suite item), and `peerReview.bySeverityThenAge` compares
  `created_at` strings as an order, not as dates.
- **Harness:** a literal instant has a different local date per zone, so
  it cannot be one golden expectation. The golden contract gains
  `{"$localInstant": "YYYY-MM-DDTHH:MM"}`, the moment at that LOCAL
  wall-clock time, revived as the UTC ISO string PostgREST sends
  (`...+00:00`); its local date is the same in every zone and its UTC date
  is not. The oracles' `LI(...)` writes it. `__tests__/assurance.instants.test.js`
  pins the literal `2026-09-17T23:30:00+00:00` (and `Z`) per zone in child
  processes: the 17th in UTC, Los Angeles, St John's and Pago Pago, the
  18th in Lagos, Kolkata and Auckland.
- **Goldens:** calendar 63 -> 77 (`item12-*`, 14). Negative control: with
  the three fallbacks reverted to `parseDateOnly`, the zone sweep fails in
  5 of 6 zones (every zone but UTC): the 23:30-local cases west of
  Greenwich, the 00:30-local cases east of it.
