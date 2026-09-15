# FINDINGS: FDP Accelerator, AFE cost control and project controls (EC0 agent D)

Scope: engines/economics/fdp/*.js, engines/economics/afe.js,
engines/economics/projectControls.js, lib/dates/dates.js. Oracles:
tools/validation/economics/oracle_fdp.py and oracle_afe.py. Goldens:
test-data/economics/goldens/fdp_cases.json (34 FDP cases, 17 scenarios, 8
concepts, 41 subsurface, 97 wells, 40 facilities, 12 HSE, 11 risk, 7
schedules, 8 plans, 4 cost sets, the worked example end to end) and
afe_cases.json (17 splits, 21 metric sets, 17 S-curves, 12 EVM sets, 9 CPI
and SPI pairs, 2 Gantt sets). Gates: __tests__/economics.fdp.test.js (188
tests), economics.afe.test.js (139), economics.projectControls.test.js (28),
dates.test.js (170). No engine was changed. Every disagreement below is
recorded in the golden with the engine's number labelled, and pinned on both
sides by the gate.

Discounting convention named per brief rule 9: runFdpCase, calculateCashFlows
and every scenario figure discount MID-YEAR at t + 0.5 through the screening
engine (screening.js, D1). The oracle implements that convention. Payback is
measured in years from the start of the development year (period 0).

Timezone assumption for every date golden: UTC, asserted by the dates gate.

## 1. DISAGREEMENT: the screening IRR reports 1000 percent where no positive IRR exists

Engine: screening.js calculateEconomics, IRR by Newton from 10 percent,
clamped to [-99, 1000] percent, reached through runFdpCase and every
scenario card. Oracle: every sign change of the mid-year NPV on a 20000
point grid over (-99, 1000] percent bisected to machine precision, then a
log-space bisection to 1e14 percent.

| case (fdp_cases.json fdpCase / scenario) | engine irr | oracle |
|---|---|---|
| suite test: never pays back (100000 capex, 60 opex, the 10 year profile at 75) | 1000 | -36.67468836383813 percent, the ONLY root |
| tax floor: loss years pay no tax (800 capex, 700 opex, [10,40,60,60,20,5] kbpd at 75) | 1000 | no root: NPV(r) < 0 at every rate from -99 percent to 1e14 percent |
| tiny capex, large single year (1 capex, 0 opex, [10] kbpd at 75) | 1000 | 15389.687500000002 percent |
| high IRR above the clamp (20 capex, 5 opex, [30,30,30] at 75) | 1000 | 2305.7875180064907 percent |
| scenario: price so low the scenario never pays back (oilPrice 12 on the 800/60/50 concept) | 1000 | no root |

Method statement that decides it: the engine's own comment says "an IRR only
exists if the cash flow changes sign; without that, report 0 rather than
letting Newton-Raphson wander". A sign change is necessary, not sufficient;
on these cash flows Newton wanders anyway, hits the upper clamp and the
engine reports the clamp as the answer. A project whose NPV is -92617 $MM
shows an IRR of 1000 percent on the card. The clamp was meant as a guard and
is being read as a result. The two true-IRR-above-clamp cases are a limitation
rather than an error, but the number reported is still not the IRR. Owner
decision; a candidate fix is to report null (as costCalculations.calculateIRR
already does) whenever Newton ends on a clamp or NPV(guess) is not near zero.
costCalculations.calculateIRR (bisection, null when none) agrees with the
oracle on every case, including the 2^20 cap.

## 2. DISAGREEMENT: calculateCPM does not run a critical path method

Engine: scheduleCalculations.calculateCPM marks an activity critical when its
`float` field is 0 or absent and passes `a.float || 0` through; it computes
nothing. Oracle: a real CPM from durations and dependencies, run twice (Kahn
topological forward pass with an iterative backward pass; memoised recursive
longest path with a recursive backward pass), both agreeing before emission.

On the app's own worked example (exampleSchedule, seven activities) the engine
marks ALL SEVEN critical. The method gives the critical path act-1, act-3,
act-4, act-6, act-7 (330 days) with 20 days of float on act-2 (Detailed
Engineering) and act-5 (Drilling Campaign). The golden records the engine's
passthrough and the reference side by side and lists the disagreeing ids
(criticalityDisagreements); a string '0' float passes through as the string
and is NOT critical (strict equality), a null float is not critical either.

Mitigating fact: no Suite component calls calculateCPM, calculateProjectDuration
or identifyMilestones (grep of src/components and src/pages). The header of
the vendored file says so.

## 3. calculateProjectDuration reads fields the schedule data does not carry

The function reads a.startDate and a.endDate; exampleSchedule (and the
Schedule module rows) carry start and end. On the example it returns NaN
(Math.ceil of NaN). Recorded as null with a note in the example golden.
Unused in the Suite (see 2).

## 4. Scenario defaulting: a blank rate is a ZERO rate, a zero cost is the default cost

scenarioCalculations.runScenario resolves royaltyRate, taxRate and
discountRate with Number.isFinite(Number(x)) ? Number(x) : default.
Number('') and Number(null) are 0 and finite, so a blank or cleared royalty or
tax field runs the scenario at ZERO royalty and ZERO tax (golden: NPV
5761.54 against 3146.93 with the defaults on the same concept). Conversely
capex, opex and peakProduction resolve with parseFloat(x) || default, so an
entered 0 becomes 100 $MM capex, 10 $MM opex and 50 kbpd. Both are the
published behaviour; both are pinned. The asymmetry is the finding.

## 5. Missing price deck rows: 0 in runFdpCase, 70 in calculateCashFlows

runFdpCase reads a missing price as 0 (Number(undefined) || 0);
calculateCashFlows pads a short deck with 70 $/bbl (`?? 70`) before calling
it. The oracle models both (costCalculations.priceDeckPaddedTo70) and the
gate excludes padded cases from the cross-convention IRR check. The two
callers can show different NPVs for the same profile when the deck is short.

## 6. Two forecast rules in one AFE app

afe.js calculateMetrics takes an entered forecast only when it is positive,
else max(budget, actual + commitment). generateSCurveData takes any non-zero
entered forecast as it is, negative included (`Number(i.forecast) || ...`).
A cost item with forecast -50 on a 1200 budget shows EAC 1200 on the metric
tiles and a forecast curve that runs negative on the chart (golden sCurve
"future window with a NEGATIVE entered forecast"; metrics "negative entered
forecast is ignored here").

## 7. DISAGREEMENT: SPI on an AFE that has not started is Infinity or NaN

calculateMetrics uses planned value = budget x time progress, and time
progress is 0 before the start date. SPI = EV / 0: Infinity when value has
been earned, NaN when not. The standard definition leaves SPI undefined at
PV = 0. Goldens "future window with progress" and "future window with no
progress" record null with a DISAGREEMENT note; the gate asserts the engine
value is not finite. The empty-budget guard (SPI 1) fires first when BAC is 0.

## 8. A null invoice date is counted as paid on the epoch

generateSCurveData filters invoices with new Date(inv.invoice_date) <=
currentDate. A missing (undefined) or unparsable date is Invalid Date and
never counts; a NULL date is new Date(null) = 1970-01-01 and counts in EVERY
bucket from the first. Golden "past window, all invoices unpaid: none
dated": the undefined-dated 100 is excluded, the null-dated 200 is in every
Actual. An unpaid invoice with a null date inflates actuals from day one.

## 9. calculateEVM: strings, an unused argument, and "NaN"

projectControls.calculateEVM returns every figure as a toFixed(2) STRING
(a KPI consumer must Number() them), ignores its baselineBudget argument
entirely (the gate proves the output is identical for 1 and 1e9), and
returns percentCompleteRaw "NaN" for an empty task list and "Infinity" when
planned costs net to zero with value earned. The oracle reproduces the
ECMAScript toFixed rule on Decimal (ties on the exact binary value round
away from zero: 0.125 to 0.13, -0.125 to -0.13, 2.675 to 2.67) and the gate
compares the strings exactly. The Suite had no test for this module.

## 10. Risk indices with a missing factor

riskCalculations.calculateConsolidatedRiskScore multiplies probability by
impact without coercion, so a risk missing either factor makes the whole
score NaN (golden "missing probability: consolidated score is NaN"). The
same NaN reads as Low in aggregateRisksByLevel (every comparison false), so
portfolio health improves when a factor is missing. hseCalculations coerces
with || 0 and does not have the problem.

## 11. calculateConceptSchedule throws on a bad start date

conceptCalculations.calculateConceptSchedule calls toISOString on new
Date(startDate); an unparsable startDate is Invalid Date and toISOString
throws RangeError (golden "invalid start date throws"). A missing startDate
uses the clock, so that path is not a golden. Month arithmetic is JS setMonth:
2024-02-29 plus 24 months is 2026-03-01 (pinned).

## 12. Observation: facility decommissioning is 15 percent of the UNSCALED base

calculateFacilityCost scales capex by size^0.7 and opex by size^0.6 but
returns decommissioning = 0.15 x the base (50000 bbl/d) capex regardless of
size. The method statement is silent; the oracle follows the engine and says
so in its comment. A 150000 bbl/d FPSO decommissions for the same 180 $MM as
a 50000 bbl/d one.

## 13. What stayed in the Suite, and why

- src/utils/fdp/formatting.js: presentation through Intl.NumberFormat and
  toLocaleDateString; its output depends on the runtime's ICU data, so it is
  not reproducible enough to golden. Left in the Suite.
- afeServices.js generateAFESummaryPDF, generateBillingStatement,
  exportToExcel: jspdf, jspdf-autotable and xlsx. Left in the Suite; only
  calculatePartnerCosts moved (afe.js header says so).
- scheduleCalculations.js imports addDays, differenceInDays, parseISO and
  format from date-fns and calls none of them; the import is kept verbatim,
  repointed to lib/dates/dates.js.

## 14. Test inventory facts

The brief expected src/utils/__tests__/afeServices* and
projectManagementCalculations* test files. Neither exists in the Suite; the
only AFE test is costControlCalculations.test.js (19 tests, all ported into
economics.afe.test.js). The only FDP test is
src/utils/fdp/__tests__/economics.test.js (14 tests, all ported).
src/components/fdp/__tests__/fdpSlimRebuild.test.jsx is a React render test
and does not exercise the utils numerically. The engines/economics/fdp
example golden runs src/services/fdp/exampleData.js values (copied into the
oracle) through every module; the schedule is laid out from a fixed
2026-01-01 rather than today's date.

## 15. lib/dates/dates.js

Vendored subset of date-fns 4.1.0: parseISO, isValid, differenceInDays,
addDays, format (light tokens y, M, d, h, H, m, s, S, a only; any other
date-fns token throws a RangeError naming it). Pinned against the real
date-fns from the Suite's node_modules on 170 inputs
(test-data/dates/date_fns_pins.json) including 20 invalid ISO strings,
month ends, leap days, negative differences, sub-day remainders, fractional
and NaN amounts and the format ties. Machine timezone UTC (`date` and
Intl.DateTimeFormat().resolvedOptions().timeZone both UTC); the gate refuses
to compare under any other zone.

## EC5-0 repair (2026-09-14, owner decision before the EC5 course)

Engine: engines/economics/afe.js. This section supersedes sections 6 and 7
and the clock caveat in the afe.js header. Oracle, goldens and gate were
regenerated: afe_cases.json now holds 20 splits, 32 metric sets, 7 metric
refusals and 24 S-curves. The evm, cpiSpi and gantt sections regenerated
byte-identical, because projectControls.js was not touched.

**The clock (RESOLVED).** Before: calculateMetrics took its time progress
from `new Date()`, so SPI on a window that spans today changed every day. On
2026-01-01..2027-12-31 with 1000 budget at 40 percent progress it was
1.1390625 on 2026-09-14 and would read differently tomorrow. A fourth
argument was ignored. After: calculateMetrics(afe, costItems, invoices,
asOf) and generateSCurveData(afe, costItems, invoices, asOf) take asOf, a
Date or an ISO date string. They read the clock only as the default. The
same window gives 1.1390625 as of 2026-09-14 (256 of 729 whole days) and
0.6877358490566039 as of 2027-03-01, on any day. An invalid asOf throws
AfeInputError('asOf is not a valid date'). The gate proves the clock is not
read: two different faked todays give identical output with asOf, and
different output without it. calculateMetrics also returns plannedValue
(budget x time progress) and timeProgress.

**Section 7, SPI before the start (RESOLVED).** Before: SPI = EV / 0 was
Infinity with value earned and NaN without, and the app printed a verdict on
it. After: SPI is null whenever planned value is not positive, which covers
before the start and on the start day. The goldens "future window with
progress" and "future window with no progress" now expect null and carry no
DISAGREEMENT note. The empty-budget guard (SPI 1) is unchanged.

**Section 6, two forecast rules (RESOLVED).** Before: the metric tiles used
an entered forecast only when positive, while the S-curve took any non-zero
entered forecast. A -50 forecast on a 1200 budget showed EAC 1200 on the
tiles and a curve that ran negative. After: both use the exported
itemForecast(item). That is the entered forecast when Number(forecast) > 0,
else max(budget, actual + commitment). The -50 case gives 1200 in both
places. The gate checks that the last forecast point of a bucket-aligned
future window equals Math.round of the itemForecast sum.

**S-curve bounded to the window.** Before: the monthly walk ran
`while (currentDate <= end || currentDate <= now)`. A 2020 AFE emitted 81
points on 2026-09-14 and gained one a month, so the goldens could pin only
the points inside the window plus an after-window invariant. After: the walk
stops at the end, and the 2020 AFE gives 12 points on any day. Actual and
Forecast split at asOf: a bucket on or before asOf shows the invoices to
date, and a later bucket shows Actual null with the linear projection.
Every S-curve golden now pins the exact point list. A window whose end is
before its start still returns [].

**Negative inputs.**
- Negative progress: calculateMetrics throws AfeInputError when any item has
  a finite Number(progress) < 0. The message names the item (code, else
  description, else index) and the value, for example `Cost item "CMP-02"
  has negative progress (-20 percent). Progress runs from 0 to 100 percent.`
  Before, -20 on a 1000 line gave EV -200 and CPI -2. Progress above 100 is
  still accepted (golden "progress beyond 100 percent earns beyond the
  budget").
- Negative working interest: calculatePartnerCosts returns valid false with
  a note naming each such partner and its value, for example `Partner "B"
  has a negative working interest (-20.00 percent). Correct the interests
  before billing.` Before, -20 on a 1000 cost billed the partner -200, gave
  the operator 120 percent and returned valid true. When the total is also
  over 100, both sentences are given, the negative one first. The allocation
  is still returned unchanged, and the conservation identity still holds
  (gated on every split golden).

**Section 8 is unchanged.** A null invoice date is still new Date(null), the
epoch, and still counts in every bucket (golden "past window, all invoices
unpaid: none dated"). It remains an open finding.

## EC6-0 repair (2026-09-15, owner decision before the EC6 course)

Engines: engines/economics/fdp/scenarioCalculations.js, economics.js,
subsurfaceCalculations.js, fdpCalculations.js, scheduleCalculations.js,
conceptCalculations.js, the new inputError.js, and
engines/economics/projectControls.js. This section supersedes sections 2, 3,
4, 9 and 11. Both oracles and both goldens were regenerated: fdp_cases.json
now holds 19 scenarios, 10 scenario refusals, 4 sensitivity sweeps, 9
concepts, 14 schedules (6 of them refusals) and 12 plans; afe_cases.json
gains 7 EVM refusals. The AFE partnerSplit, metrics and sCurve sections
regenerated byte-identical, because afe.js was not touched.

The owner scoped this wave. What was repaired is below. What was left as a
finding, by decision, is listed at the end.

**The scenario cards read the capex nobody enters (RESOLVED).** Before:
`runScenario` read `concept.capex`. The concept form has never had such a
field; it collects `drillingCapex`, `facilitiesCapex` and `subseaCapex`, and
`parseFloat(undefined) || 100` priced every scenario in the app at $100MM. A
concept entered as 400 + 1200 + 300 showed NPV $3,507.6MM and IRR 676.4
percent; on its own capex it is $1,791.4MM and 30.0 percent. After:
`conceptCapexMM` adds the three fields, accepts a single `capex` when a
caller has already totalled them, and refuses a concept that carries none of
the four. Golden "the three capex fields are added"; the gate pins both the
repaired figures and the ones the app used to show.

**Silent defaults (RESOLVED).** Before: a missing operating cost became $10MM
a year, a missing peak rate 50 kbpd, and a blank or zero oil price $70/bbl
while the card printed "$0/bbl". A non-numeric royalty or discount rate fell
back to the default without saying so, and `Number('')` being 0 meant a
blank royalty field ran the case at a zero royalty rate (section 4). After:
an absent figure is refused by name (FdpInputError, engines/economics/fdp/
inputError.js), a blank fiscal field takes DEFAULT_FISCAL and says which,
anything unreadable is refused, and a zero someone actually typed is
honoured. Ten refusals are goldened, each with a negative control showing
the same input used to produce a full set of economics.

**The Economics tab ran an illustrative profile (RESOLVED in the engine).**
`buildFdpCaseInputs` is split out of `runFdpCase`, and `runFdpSensitivity`
runs the sanctioned screening sweep (plus and minus 30 percent on price,
capex, opex and production) over the case actually in front of the user.
`scenarioSensitivity` does the same for one scenario card. This replaces the
hard-coded five-bar tornado around "Base Case ($245MM)" that the app drew
whatever the plan said. Four sweeps are goldened against an independent
rebuild, and the gate proves the base NPV in the sweep is the case's own NPV.

**Section 2, CPM (RESOLVED).** Before: `calculateCPM` passed the caller's own
`float` back out and called every activity with a zero or absent float
critical; it computed nothing. On the textbook network (A3 then B4, D5, F2,
with C2 and E3 in parallel) it marked all six critical. After: a forward
pass, a backward pass, float = LS - ES, critical at zero float, plus
`calculateNetworkDuration` and `criticalPaths` (which lists every zero-float
chain, so a tie returns both). The engine now equals the oracle's two-pass
reference on every golden schedule: A-B-D-F at 14 days with four days of
float on C and E; the app's own example gives act-1, act-3, act-4, act-6,
act-7 at 330 days with 20 days of float on Detailed Engineering and the
Drilling Campaign. A cycle, a dependency on an id that is not in the
schedule, a duplicate id, a missing id and a negative or unreadable duration
are refused, all six goldened. The gate keeps the retired passthrough beside
the reference as a negative control: if the disagreement list ever empties,
the repair has been undone.

**Section 3, project duration (RESOLVED).** It still answers "how long is the
window" (the network's own length is `calculateNetworkDuration`), but it
counts whole CALENDAR days rather than subtracting timestamps, and returns
null rather than NaN when an activity has no readable date. Date-only
strings parse as local midnight, so the same schedule reports the same
length in every time zone: Oct 30 to Nov 3 is 4 days in UTC, Los Angeles,
Lagos and Tokyo alike, where it used to be 4 in UTC and 3 in Los Angeles.

**Section 11, the concept schedule (RESOLVED).** `calculateConceptSchedule`
did its month arithmetic on a UTC midnight while reading local fields, so
2024-03-01 plus 24 months landed on a different day depending on the
reader's zone, and it fell back to the clock when a concept had no start
date, which made it unreproducible. After: local parsing, local month
arithmetic, local formatting, and a concept with no start date is refused
unless the caller states `today` (the as-of rule afe.js already follows).
2024-03-01 FPSO gives 2027-03-01 in all four zones.

**Reserves: oil added to gas, and summed percentiles (RESOLVED).**
`aggregateReserves` reduced every row of the reserves table into one set of
totals whatever fluid it held, so the example's 85 MMbbl of oil and 30 Bcf
of gas came out as "Total (P50) 115" and the summary card called that 115
MMbbl of oil. It added the P90 and P10 columns the same way. After: totals
per fluid, each in its own unit, with `percentileNote` saying in words that a
sum of P90s is not the P90 of the sum. A row whose fluid is missing or
unknown is refused by row name. `reservesP50(aggregate, fluid)` is the
accessor for the volumetric cards.

**The completeness check read a key nothing writes (RESOLVED).**
`calculateCompleteness` and `validateFDPData` read
`state.subsurface.reserves.p50`. The plan keeps its reserves in
`reserves.breakdown` (the table) and its totals in `reserves.summary`, which
only Load example ever wrote, so a fully entered plan scored 78 percent and
failed validation with "Reserves (P50) not estimated". After: the new
`planReservesP50` reads the table first and falls back to the summary, a gas
only plan passes, and an unreadable table reads as no reserves rather than
throwing on a completeness screen.

**Section 9, calculateEVM (RESOLVED).** Before: every figure came back as a
toFixed(2) string, so callers compared them as text and one card read
`parseFloat(kpis.percentComplete || 1)`, turning "0.00" into 0 and printing
"Behind Schedule" on a project with no costs at all; percent complete was
the string "NaN" whenever planned value was zero, which was every project in
the app; a cost index of 1.00 was invented whenever actual cost was zero;
`baselineBudget` was accepted and never read; and anything unreadable was
taken as zero, so a cost pasted as "$1,200" counted as nothing while a
negative planned cost and a 150 percent complete were taken as typed. After:
numbers, `pv`/`ev`/`ac` aliases beside the long names (the card that read
`kpis.ev` now finds it), null for an index with no denominator and for
percent complete with no planned value, the unused argument dropped, and
seven refusals goldened. `formatTasksForGantt` parses date-only strings as
local midnight (a 2026-03-01 task used to draw on Feb 28 west of Greenwich),
returns null rather than an Invalid Date, and keeps `task_category`, which
the stage managers filter on and the reshape used to drop.

**Left as findings by owner decision (EC6, 2026-09-15).** These were put to
the owner with the repairs above and deliberately not taken into this wave.
They are taught in the course instead:
- Section 1, the screening IRR clamp: a scenario at $12/bbl still shows IRR
  1000.0 percent, coloured green, on an NPV of -$740.3MM.
- The FDP risk banding: five different scales across the register, the HSE
  tab, the matrix and response planning (a score of 12 reads High, Medium
  and critical on three screens), `mitigation` saved against
  `mitigationStrategy` read, and three example HSE risks sharing one id.
- Report Autopilot: the pre-filled Alpha Prospect / A-21 / ROP 150 ft/hr /
  NPT 5 percent that the edge function sends to the model as "Reported
  figures", the ignored GPT-4 toggle, Max Pages not being a document cap,
  the dead /dashboard/automation Back route and the missing help guide.
- Time-phased planned value in projectControls.js. Planned value is still
  the whole budget of every task in scope, so the schedule index is a
  progress ratio and cannot tell early from late. The engine says so in
  `spiBasis`, and EC6 grades earned value on afe.js, which is time-phased
  against an as-of date.
- Section 8 (a null invoice date counts from the epoch) and section 12
  (decommissioning at 15 percent of the unscaled base) are unchanged.
- The screening sweep scales production without scaling the variable
  operating cost that production implies (screening.js
  runSensitivityAnalysis, shared with the other economics apps). Noted here
  because runFdpSensitivity inherits it.

## EC6-1 repair (2026-09-15, owner: implement the recommendations)

Engines: engines/economics/screening.js, fdp/costCalculations.js,
fdp/facilitiesCalculations.js, fdp/hseCalculations.js,
fdp/riskCalculations.js, fdp/riskModel.js, afe.js, projectControls.js.
Oracles and goldens regenerated on all three sides (screening, fdp, afe).
This section closes sections 1, 5, 8, 10 and 12, and the four items EC6-0
left as findings by decision.

**Section 1, the IRR clamp (RESOLVED).** Before: Newton ran from 10 percent
between a lower clamp of -99 percent and an upper clamp of 1000 percent, and
whatever it stopped at was reported. A project whose net present value is
negative at every rate from -99 percent to 1e14 percent showed an IRR of
1000.0 percent, and on a scenario card that 1000 was coloured green for
clearing the 15 percent hurdle. After: the search must land strictly inside
the clamps AND the net present value there must be zero to within a
tolerance scaled by the size of the cash flow. When it does not, the engine
sweeps the band and bisects every sign change, and `metrics.irr` is null
with `metrics.irrStatus` saying why:

| status | what it means |
|---|---|
| `ok` | one root in the band, reported |
| `no-sign-change` | every period the same sign, no IRR exists |
| `multiple-roots` | the flow changes sign more than once; every root is in `irrRoots` |
| `above-clamp` | still positive at 1000 percent: the rate is higher than the band |
| `no-root` | nothing in the band zeroes the net present value |

What this recovers: the -36.67468836383813 percent root Newton used to run
past on the 100000 capex case; the 21 percent root of a cash flow of order
1e-7 $MM that used to trip the absolute derivative guard and come back as
the 10 percent starting guess; both roots (10 and 20 percent) of the
two-root case, reported as a pair rather than one of them picked. Every
`ENGINE_IRR_PINS` entry in oracle_screening.py and every `ENGINE_REPORTED`
entry in oracle_fdp.py is gone, because there is no disagreement left to
pin. Descartes' rule keeps the cost down: a flow that changes sign once has
at most one root, so Newton's answer is trusted there and the sweep only
runs when it has already failed or the flow changes sign more than once (so
the 10,000 iteration Monte Carlo does not pay for it). `getPortfolioMetrics`
averages only the projects that HAVE a rate, and reports how many
(`irrProjectCount`); a project with none used to be averaged in as a zero.

**Section 5, the price deck (RESOLVED).** `calculateCashFlows` padded a
short deck with 70 $/bbl while `runFdpCase` read a missing price as 0, so
the same profile gave $178.99MM through one door and -$66.92MM through the
other. A deck that does not cover the profile is refused by
FdpInputError, naming the years it has no price for.

**Section 8, the undated invoice (RESOLVED).** An invoice with a NULL date
was `new Date(null)`, the first of January 1970, so it counted in every
bucket of the S-curve from the first one and inflated actual spend from day
one. `invoiceDate` returns null for anything it cannot read, those invoices
are off the curve, and `countUndatedInvoices` plus `calculateMetrics`'s new
`undatedInvoices` field tell the app how many to ask about.

**Section 10, the missing risk factor (RESOLVED).** `probability * impact`
with a factor missing is NaN, and NaN fails every band comparison, so an
unscored risk was counted as Low and the portfolio health went UP the less
of the register was filled in. `riskScore` returns null for an unscored
risk; the consolidated score sums the scored ones, `aggregateRisksByLevel`
and `calculateRiskMatrix` count an `Unscored` band, and the health is taken
over the scored risks only.

**The five banding scales (RESOLVED).** `getRiskLevel` in riskModel.js is
the one scale: 20 Critical, 12 High, 6 Medium, below Low. `calculateRiskMatrix`
banded on 15 and 8 with no Critical band at all, so a score of 12 read High
on the register and Medium on the HSE tab; it now returns low / medium /
high / critical / unscored on the register's scale, and the gate walks all
25 cells of the 5 by 5 to prove the two screens agree.

**Section 12, decommissioning (RESOLVED).** It was 15 percent of the
UNSCALED base capex, so a 150,000 bbl/d FPSO decommissioned for the same
$180MM as a 50,000 bbl/d one. It is 15 percent of the capex the facility
actually carries.

**Time-phased planned value (RESOLVED).** `calculateEVM(tasks, { asOf })`
spreads each task's budget evenly across its own planned window and cuts it
off at the as-of date, which is the definition afe.js already follows, so
the two apps mean the same thing by SPI. Before, planned value was the whole
budget of every task, so the index was earned value over budget at
completion: a project half done on time and a project half done a year late
both read 0.50, and it could never read above 1. The ratio it really was is
still reported, as `completionRatio`. A costed task with no planned dates
makes the time-phased number impossible, so `spi` and `plannedValue` are
null and `spiBasis` says how many tasks are missing dates. `asOf` is a
parameter, not the clock.

**The sensitivity sweep (RESOLVED).** `runSensitivityAnalysis` scaled the
production volume without scaling the variable operating cost that volume
implies, so a 30 percent cut in production kept the full profile's operating
cost and the production bar of the tornado moved the NPV exactly as far as
the price bar. Volume now carries its own cost, and the gate pins the
production spread below the price spread.

**Still open after this wave.**
- `fiscalRegime.calculateIRR` (Fiscal Regime Designer) has the same shape of
  defect as section 1 in its own bisection: it returns 0 when NPV(0) <= 0 and
  returns the search bound when the root is beyond it. It was not in the EC6
  audit's scope and is recorded here for the owner.
- `getPortfolioMetrics` reads `chanceOfSuccess` with `|| 1.0`, so a stated
  chance of 0 is read as certainty (pinned as a disagreement in
  screening_cases.json, FINDINGS-fiscal.md).
