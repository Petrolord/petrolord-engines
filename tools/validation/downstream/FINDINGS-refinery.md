# FINDINGS: refinery planning, the variance model and modular refinery feasibility (MD2-0, 2026-09-19)

The second validation wave of MD-0, before the NextGen course MD2 Refinery
Feasibility & Planning. It covers `engines/downstream/refineryPlanning.js`,
`engines/downstream/streamModel.js` (the plan-versus-actual variance) and
`engines/downstream/modularRefinery.js` at engines main `ac45012`, the
screening economics engine where the modular refinery meets it, and the LIVE
Suite layer (`RefineryPlanningContext`, `ModularRefineryContext` and their
panels). The LP kernel underneath was repaired in MD1-0 (FINDINGS-crude.md).

**Fifteen findings: twelve defects repaired, one comment corrected, two HELD.**
- **Wrong on screen at the Refinery Planning Studio's defaults (1):** R1.
- **Reachable by typing into a box (9):** R2, R3, R4, R5, M1, M2, M3, M4, M5.
- **Fail open (6):** R1, R2, R3, M3, M4, M5.

## The gate

| file | what it is |
|---|---|
| `exact_simplex.py` | a rational-arithmetic simplex that returns an answer only with an exact DUALITY CERTIFICATE (every row and bound holds exactly; every reduced cost has the optimal sign). Checked against `oracle_lp.py`'s vertex enumeration: 181 of 181 LP golden cases agree. Its first run REFUSED to certify, correctly: its own dual solve had built B where B' was needed |
| `oracle_refineryplanning.py` | plans solved by `exact_simplex`, closed stream by stream, stream values by exact re-solve, schedule dates from `datetime.date`, the variance from explicit ledgers signed by margin. 6 plan cases, the first the Suite default |
| `oracle_modularrefinery.py` | annual accounts in barrels and dollars, a DATED tax-loss ledger used oldest first, mid-year NPV; 8 cases, the first the Suite default |
| `__tests__/downstream.refinery.golden.test.js` | 73 assertions, every one calls the engine; the schedule is run in five time zones, each in its own node process |
| `negcontrol_md2.sh` | main's engines turn the gate red; 16 planted defects, 16 caught |

The battery's first run had ONE survivor: returning the schedule to local
calendar arithmetic left the gate green. Two reasons, both instructive.
Setting `process.env.TZ` inside a jest worker does not reach its `Date`, so
the test was running in the worker's zone whatever it asked for; the zones
now run in child processes. And the golden period crossed the AUTUMN change,
where a UTC-midnight date landing at 19:00 or 20:00 local moves later and
survives; the defect shows at the SPRING change, where 19:00 EDT is 23:00 UTC
the day before. The period is now March 2026.

## Refinery Planning Studio

**R1. AT DEFAULTS: the crude distillation unit constrained nothing.** A unit
with no feed had no row, and crudes produced their streams directly, so the
default plan showed the CDU at 0 barrels and 0 percent utilisation beside
2.91 million barrels of crude, its 4 million barrel capacity could never bind,
and its 1.20 a barrel operating cost (3.49 million over the month) was never
charged. Now every barrel of crude runs through the feedless (crude) units,
by an equality row. The default margin moves from 21.85 to 18.36 million;
the exact oracle gives 18,360,000.

**R2. A typed zero was unlimited:** crude availability, unit capacity and
maximum demand all read `cap > 0 ? cap : Infinity`. Typing the reformer as
shut (capacity 0) ran it at 960,000 barrels and lifted the margin from 21.9 to
32.0 million. Now blank is no limit, zero is zero, negative is refused. With
the reformer truly shut the margin is 0: without reformate no crude here
covers its cost (light sweet makes 66.59 a barrel of product against 83.20).

**R3. A blank crude cost, unit operating cost or product price was 0.**
Refused now, each named.

**R4. The variance added revenue gaps to cost gaps.** A delivery's `cost`
field carries what it sold for, so a positive gap is good news on a delivery
and bad news on a receipt, and `total` summed them anyway. On screen, the
Actuals panel coloured every line's gap green when positive: an OVERSPEND on
crude showed green. Lines now carry `direction` and `marginEffect`, the
headline total is on margin, cost and revenue are also totalled apart, and
the panel colours by margin effect.

**R5. The schedule slipped a day west of Greenwich after the spring clock
change.** Dates were stepped with local `setDate` and printed in UTC; in New
York a March 2026 period put day 14 on 14 March instead of 15 March and every
later event a day early. Now UTC arithmetic throughout.

**R6. Money with no quantity broke the volume-plus-price identity silently**
(a bill on a cargo that never came). It is now an explicit `unexplained`
term, zero otherwise.

## Modular Refinery Feasibility Studio

**M1. The NPV wiring fed product revenue in as a negative operating cost.**
The screening engine therefore saw no revenue: its royalty (a share of gross
revenue) was zero whatever the page's Royalty box said, and its revenue total
was zero. The wiring now lives in the engine (`feasibilityEconomics`) and
passes revenue as revenue.

**M2. Construction-year tax losses were thrown away.** The capital is
expensed in the years it is spent, before the plant earns, and the screening
engine had no loss carry-forward, so the whole capital deduction vanished.

| case | NPV, old page | NPV, carried forward |
|---|---|---|
| defaults on crude at 74 (a profitable hydroskimmer) | -12.25 MM | **+5.32 MM** |
| conversion plant, 20,000 bpd | 67.47 MM | **104.14 MM** |

The first is a sign flip on the investment decision. At the page's own
defaults the plant never makes a taxable profit, so the default NPV
(-97.44 MM) is unchanged.

**M3. Blank inputs were zero.** This module's `num()` falls back to 0, so a
blank crude price made crude free and a blank capital cost made the plant
free. Refused now, named.

**M4. Utilisation was clamped to 0..1,** so 90 typed for 90 percent became
100 percent. Refused now with the reason.

**M5. With no construction period the capital vanished from the streams.**
Now it is spent in year 0. The existing test asserted the defect (every
year's capex 0) and was corrected.

**M6. A comment had the scale crossover backwards** (it said the 0.9 law
costs MORE below the reference size; a fraction to the 0.9 is smaller than
the same fraction to the 0.6). The page did not print it.

## Decisions taken (owner delegation, 2026-09-19)

- **Loss carry-forward is an OPT-IN of the canonical screening engine**
  (`lossCarryForward`, default false). Every other caller and every economics
  golden is unchanged (11 suites, 1,840 tests green with it off). The
  refinery turns it on, because a company's income-tax losses carry forward
  and because it approximates capital allowances that start at commissioning.
- **No royalty on a refinery.** A royalty is a charge on producing petroleum;
  a refinery buys its crude. The page's Royalty box is removed.
- **A feedless unit is a crude unit** and carries every barrel of crude. A
  plan with no feedless unit writes no such row, as before.

## HELD

- **H1. The scaling exponents 0.6 and 0.9** are defaults the page labels as
  replaceable by vendor data; no published source is in this repository and
  none is quoted from memory. Pinned.
- **H2. The screening engine starts depreciation in the year of spend** and
  offers no capital-allowance schedule from commissioning. Carry-forward
  covers the refinery case; a fuller allowance model belongs to the Economics
  module, not here.

## MD2-1 (2026-09-19): three more, found by the NextGen course foundation

The refinery course foundation read every function in scope and stopped on
four items. Three are repaired here; one is HELD.

- **R7. `dualLedgerTotals` summed sales into `cost`.** Same class as R4 in a
  sibling function: on the course's teaching month it reported 121,082,150 as
  cost, which is spend 60,658,650 plus sales 60,423,500. Spend (`cost`), sales
  (`revenue`) and `margin` are now apart. No Suite page calls it.
- **M7. `feasibilityEconomics` read a blank or null tax or discount rate as
  0** (`Number('')` is 0), valuing the plant tax-free: NPV 94.02 against 61.80
  at 30 percent on the course case. Refused now. The Suite page supplies its
  own defaults, so the page was not exposed.
- **M8. A comment contradicted the code:** it said the schedule terms take
  their defaults only when absent, never when blank; the code read blank as
  the default for on-stream days, utilisation and life, and read a blank
  construction period as 0 where absent gave 2. Now every schedule term,
  construction years included, reads blank or absent as its stated default,
  and the comment says so.
- **H3 HELD. `materialBalance` cannot close a refinery's tanks.** It treats a
  unit run as moving nothing, so a crude consumed by the crude unit never
  leaves its tank (on the course's teaching month an Escravos tank shows
  -724,500 unaccounted). No Suite page uses it and no oracle covers it. A
  repair needs a design (a unit run as feed out and products in), not a
  patch; it is taught as a limit and never graded.

Gate: three new assertions in `downstream.refinery.golden`, three new plants
in `negcontrol_md2.sh` (19 in all, all caught).
