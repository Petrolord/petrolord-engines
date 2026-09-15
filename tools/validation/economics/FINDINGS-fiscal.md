# FINDINGS: screening, fiscal regime sandbox and breakeven (EC0 agent C, 2026-09-08)

Scope: `engines/economics/screening.js` (the Suite's npvCalculations.js),
`engines/economics/fiscalRegime.js` and `fiscalTemplates.js` (the Suite's
fiscalDesignerCalculations.js and fiscalTemplates.js) and
`engines/economics/breakeven.js` (the Suite's breakevenCalculations.js).
All four are verbatim; only imports were repointed. Nothing below was
fixed. Every disagreement is pinned on BOTH sides in the goldens
(`engine` object with a `disagreement` note) and gated so a silent change
to either number is caught. Owner decisions are the owner's.

Discounting conventions, as the engines document them and as the oracles
implement them: screening.js and breakeven.js discount MID-YEAR (cash at
t = i + 0.5); fiscalRegime.js discounts YEAR-END (t = 1, 2, ...). The
parity gate in `__tests__/economics.fiscal.test.js` pins the ratio between
the two, sqrt(1 + r), on identical cash flows.

Oracles: `oracle_screening.py`, `oracle_fiscal.py`, `oracle_breakeven.py`
(python3 standard library only, byte-identical goldens on rerun). Goldens:
`test-data/economics/goldens/screening_cases.json` (90 cases),
`fiscal_cases.json` (61), `breakeven_cases.json` (22).

## Screening engine (screening.js)

### S1. IRR reports the Newton clamp (1000 percent) as the answer, including on a project that never pays back

The engine's IRR is a Newton-Raphson from 10 percent with the guess clamped
to [-99, 1000] percent for 100 iterations, and whatever the guess is after
that is reported. Two ways that goes wrong, both pinned:

1. The true root lies beyond the clamp. `tr_hand_2yr_depr2` (the Suite's
   own depreciation test: ncf -2.5 then +47.5) has a mid-year IRR of 1800
   percent; the engine reports 1000. `irr_beyond_clamp` (ncf -1, +100) has
   9900 percent; the engine reports 1000. The oracle scans to 20000 percent
   and finds the root.
2. THE SERIOUS ONE. When NPV(10 percent) is negative and the NPV curve
   slopes upward there (a project whose only root is negative), the first
   Newton step lands past the clamp and stays there, and the engine
   reports 1000 percent. `fdp_never_pays_back` (the Suite's FDP test case
   with capex 100000 $MM, NPV -92616.5 $MM at 10 percent, cumulative cash
   never positive) reports an IRR of 1000 percent; the only root is
   -36.67 percent. `depr_capex_in_last_year` (capex spent in the final
   year, NPV +55.8 $MM) reports 1000 percent; the only root is -76.81
   percent.

Method statement that decides: the header says an IRR "only exists if the
cash flow changes sign; without that, report 0 rather than letting
Newton-Raphson wander". These cash flows do change sign, Newton wanders,
and nothing catches it. A screening card that prints "IRR 1000%" on a
project that loses 92 billion dollars is the number a user reads. The
Suite's FDP wrapper happens to suppress payback for that case (null) but
not the IRR.

### S2. IRR derivative guard is absolute, so small cash flows return the 10 percent seed

`Math.abs(dNpv) < 1e-5` breaks the iteration before it starts when the cash
flows are small in $MM. `irr_tiny_cash_flows_derivative_guard` (ncf -1e-7,
+1.21e-7 $MM, the 21 percent case scaled down) reports 10 percent (the
starting guess); the oracle gives 21.000 percent. Any project entered in
the wrong unit (dollars where $MM is expected, so 1e-6 too small) will
report exactly 10 percent for its IRR.

### S3. runMonteCarlo is not reproducible (Math.random)

**FIXED EC3-0 (2026-09-14, owner decision).** runMonteCarlo draws from mulberry32(settings.seed), default DEFAULT_MC_SEED 20260829, and returns the seed. The stream is consumed in the order the gate's stand-in consumed it, so every published seeded value is unchanged; a gate asserts Math.random is never called.

The sampler is a bare `Math.random()`. Two runs on the same inputs give
different P10/P50/P90 (gated as such). The gate substitutes a mulberry32
stream for Math.random and the oracle replicates mulberry32 bit for bit
(uint32 arithmetic, divided by 4294967296), so the sampler's arithmetic,
the quantile rule, the histogram and the CDF are all proven on four seeded
cases; only the seeding itself is missing. breakeven.js and lib/stats
already carry the seeded generator this function should use.

### S4. runMonteCarlo throws when every uncertainty is zero

**FIXED EC3-0.** A zero-width range puts every iteration in the first bin; `mc_zero_uncertainty_degenerate` pins P10 = P50 = P90 = base NPV.

With all three ranges at 0 every iteration is the base NPV, the histogram
bin width is 0, `(v - min) / binSize` is NaN, `histogram[NaN]` is undefined
and `.count++` throws a TypeError. `mc_zero_uncertainty_throws`: the oracle
reports P10 = P50 = P90 = EMV = base NPV (188.3699 $MM on that case); the
engine rejects. Pinned as `engine.throws`.

### S5. runMonteCarlo returns an empty CDF below 50 iterations

**FIXED EC3-0.** The downsample step is floored at 1; `mc_seed11_40_iters` keeps all 40 points.

The S-curve downsample is `i % Math.floor(iterations / 50) === 0`; below
50 iterations the divisor is 0, `i % 0` is NaN, and the CDF is empty.
`mc_seed11_40_iters_cdf_empty` pins the empty array on both sides.

### S6. getPortfolioMetrics reads a chance of success of 0 as certain

**FIXED 2026-09-15 (EC1-10, owner decision).** The chance is read with `?? 1`,
so only a missing or null chance means certainty, and a present chance that is
not a finite number from 0 to 1 is refused with a RangeError naming the
project (by name and index, or index alone). `portfolio_zero_chance` is no
longer a recorded disagreement: its `engine` pin is removed and the engine
gives the oracle's 20. The gate re-implements `|| 1.0` as the negative control
(120). No other screening value moved. The text below is the finding as
recorded.

`(p.chanceOfSuccess || 1.0)` turns 0 into 1.0. `portfolio_zero_chance`
(NPV 100 at chance 0 plus NPV 40 at chance 0.5): risked NPV should be 20;
the engine reports 120. A project the user has written off as a certain
failure is counted at full value.

### S7. Observations, no numerical disagreement

**Resolved in part (EC3 repairs, owner decisions 2026-09-15).** The Production
sensitivity carries variable opex since EC6-1 and the Low/High scenarios do
since EC3-3; payback is null with `paybackStatus` 'not-recovered' when the
project never pays back (EC3-2). The OPEX sensitivity still scales fixed opex
only, as its label says.

- The OPEX sensitivity and the Low/High scenarios scale FIXED opex only;
  variable opex is left untouched, and the Production sensitivity scales
  volumes without scaling variable opex. The oracle follows the code's own
  comment. The header does not say so; a user reading "OPEX plus 30
  percent" is not getting that.
- `projectLife: 0` returns `maxExposure: Infinity` (serialises as null).
- Payback reports the project life when the project never pays back,
  which is indistinguishable from paying back on the last day (the Suite's
  FDP wrapper adds the null itself).

## Fiscal regime sandbox (fiscalRegime.js, fiscalTemplates.js)

### F1. The capex sensitivity stops at 1.4, not the documented 1.5

`for (let multiplier = 0.8; multiplier <= 1.5; multiplier += 0.1)`
accumulates in floating point: 1.2000000000000002, 1.3000000000000003,
1.4000000000000004, and then 1.5000000000000004 fails `<= 1.5`. The sweep
the app labels 0.8 to 1.5 has seven points and its last label is "1.4".
The "Resilience to cost overrun" verdict therefore measures the NPV given
up from 0.8 to 1.4. On the Designer's default comparison the eight point
sweep says the PIA regime gives up 177.2 $MM and the concession 194.7; the
engine's seven point sweep says 149.0 and 164.9 (both sentences are in the
golden as `insights` and `insightsAsEngine`). The golden carries the eight
point sweep; the gate pins the engine's seven against the first seven.

### F2. Two definitions of the effective tax rate in one result

The summary table computes government take over (government take plus
contractor take WITH total capex added back); the price sensitivity
computes the same ratio WITHOUT the add-back, on the same cash flows. On
the Designer's defaults at the base $70 price: Concessionary 46.35 percent
in the table against 59.62 percent on the chart; PIA 55.54 against 71.45.
A user comparing the chart's $70 point to the table sees two different
numbers for one regime. The oracle computes both and the gate pins both.

**Named, not merged (owner decision, naming wave 2026-09-14).** Both
computations stay exactly as they were; they get distinct names, defined once
in `engines/economics/fiscalConventions.js`:

- **Government take** (the headline): government cash flow over the
  project's pre-take net cash flow, revenue less opex less capex. This is the
  price sweep's ratio. `takeMetrics` returns it with its state, undiscounted by
  default, and the summary carries it undiscounted (`governmentTakePct`) and
  discounted at the project rate (`governmentTakeDiscountedPct`).
- **Government share of net revenue** (always second): government cash flow
  over revenue less opex, the capex add-back. This is the summary's legacy
  `effectiveTaxRate`, now also `governmentShareOfNetRevenuePct` with a null
  in place of the zero fallback.

The money quantity both divide is **government cash flow** (royalty plus
government profit oil plus tax); "total government take" in money is retired
from the verdict text. Gates: share of net revenue equals the legacy rate
wherever positive, take equals the sweep at the deck price, the discounted
take equals the ratio of year-end present values, and no verdict prints
"government share" or "effective tax rate".

### F3. The resilience and progressivity verdicts rank ties by rounding noise

When every regime gives up the same NPV across the capex sweep (any
comparison where cost is never recovered, `cmp_never_recovers`: all six
regimes give up 10909.0909 $MM, differing in the fifteenth figure) the
strict `<` reduce in deriveInsights names whichever regime's floating point
noise happened to be smallest. The engine names "USA - Gulf of Mexico",
the oracle's arithmetic names "Brazil - Concession"; neither is a result.
The golden carries the ranked quantities (`capexLossesAsEngine`,
`priceClimbs`) and the gate treats a tie as a tie. The PRICE half is closed
by EC2-1 below: a lead under one percentage point now declines to rank, so
noise can no longer name a winner there.

**Capex half FIXED 2026-09-15 (EC2-4, owner decision).** The capex verdict
uses the price verdict's rule through one helper, `leadOrTie`: each end is
named alone only when it leads the next regime by at least one printed step
(`CAPEX_RESILIENCE_MIN_SPREAD_MM`, 0.1 million USD), otherwise every regime
within that step is named with it, and when the two ends share a regime no
regime is ranked. `cmp_never_recovers` now reads "No regime can be ranked on
resilience to cost overrun" and names all six; the comparison gate lost its
tie branch because every verdict text is now exact. Goldens
`insights_capex_all_tied`, `insights_capex_least_end_tied`,
`insights_capex_one_step_ranks`, `insights_capex_ends_meet`.

### F6. The price sweep returned 0 percent when profit was not positive (EC2-1, FIXED 2026-09-14)

Found by the NextGen EC2 wave, not by this oracle, because the oracle
implemented the same `totalProfit > 0 ? ... : 0` guard from the same method
statement and the golden pinned the agreement. On `cmp_never_recovers` all
six templates plotted a flat 0 percent at nine prices while the government
collected 700.1194 to 1662.7835 $MM; Angola on the default project with
capex tripled read 0, 2223.0766, 144.0692 and 85.6015 at 40 to 70 USD per
bbl, three meanings on one line with no flag.

Owner decision (b), 2026-09-14. Every price sweep series carries `states`
beside `values`: `share` (profit positive, share 0 to 100), `exceeds`
(profit positive, share above 100, true value kept) or `undefined` (profit
zero or negative, value null). Zero is never a fallback. The progressivity
verdict ranks only over the longest contiguous run of prices at which every
regime is a share, needs at least three such prices and a lead of at least
one percentage point, and otherwise says no regime can be ranked and names
the first price at which a regime is economic. A lead whose climb is not
positive is named least regressive rather than most progressive. The oracle
implements the same rule independently (`point_state`, `share_window`,
`price_verdict`); goldens `cmp_angola_capex_x3` and five
`insights_price_*` cases pin the edges. No share value moved: every point
that was a real number is the same number, and only the old zeros became
null.

### F4. IRR beyond the 102400 percent bracket reports the bracket

**FIXED 2026-09-15 (EC2-5, owner decision).** See the EC2 section below: the
fiscal IRR follows the screening engine's contract, and `irr_beyond_bracket`
is now `irr_above_clamp_past_old_bracket`, null with status 'above-clamp'.
The text below is the finding as recorded.

The bisection brackets by doubling from 100 percent ten times and reports
the bracket if NPV is still positive there. `irr_beyond_bracket` (ncf -1
then +2000): true IRR 199900 percent, engine 102400. Pinned; a curiosity
rather than a defect at real project scale.

### F5. Observations, no numerical disagreement

- The RRT uplift is `totalCapex * rrtUpliftPct / 100` deducted EVERY
  year of the 25 year life, so at the default 20 percent the uplift over
  the life is five times the capex. The engine calls this a screening
  approximation; the oracle implements it as stated.
- The R-factor is a ratio of cumulatives and is not monotone: on
  `rfactor_falls_back` it rises past 2.5 (split 30) and then falls back
  below it in year 23 as revenue declines while opex accrues, and the
  contractor's split steps back UP to 40. Real R-factor contracts usually
  ratchet; this one does not. Recorded as a property, gated as such.
- **FIXED 2026-09-15 (EC2-8).** Sliding-scale and R-factor tiers were
  selected as the LAST tier in list order whose threshold is reached. Identical to "highest threshold
  reached" for sorted tiers (all templates and the Designer's defaults
  are sorted); an unsorted tier list would silently pick the wrong rate.
  A sorted copy is now selected from (below every threshold, the lowest
  tier), and a repeated threshold is refused naming the regime and table.
- The price multiplier scales oil only; gas and NGL prices are untouched,
  so the price sweep is an oil price sweep.

## EC2 decisions, all FIXED 2026-09-15 (owner decisions)

Found while the EC2 Fiscal Systems course was written. Each is gated in
`__tests__/economics.fiscal.test.js` (describe "EC2 owner decisions") with a
negative control that re-implements the retired rule, and the oracle
implements each rule from its statement.

- **EC2-2.** `effectiveTaxRate` kept a zero fallback beside the null-safe
  `governmentShareOfNetRevenuePct`. The key is now a DEPRECATED alias equal to
  that field, null where it is null. The gate recomputes the legacy formula on
  every comparison golden: no defined value moved (1e-9), and only the old
  zeros become null.
- **EC2-4.** The capex verdict ranked ties with a strict reduce. Fixed as F3
  above.
- **EC2-5.** `calculateIRR` returned 0 for a flow that never changes sign and
  for one whose only root is negative, and reported its 102400 percent bracket
  as a rate. The screening engine's EC6-1 contract now serves both engines
  from `engines/economics/irrContract.js` (lifted out of screening.js
  unchanged, so every screening golden holds): a rate only when it is a
  verified root strictly inside -99 to 1000 percent, negative roots included;
  otherwise null with 'no-sign-change', 'no-root', 'above-clamp' or
  'multiple-roots' and the roots listed. Discounting stays year-end.
  `calculateIRRResult` returns `{ irr, irrStatus, irrRoots }`; `calculateIRR`
  returns the rate or null; the summary carries all three. The contractor
  sentence states the status when there is no rate. Golden renames:
  `irr_all_positive` to `irr_all_positive_no_sign_change`, `irr_npv0_negative`
  to `irr_negative_root_reported` (-10 percent), `irr_beyond_bracket` to
  `irr_above_clamp_past_old_bracket`; new `irr_above_clamp_inside_old_bracket`,
  `irr_no_root_below_band`, `irr_multiple_roots_listed`.
- **EC2-8.** Tiers are selected in threshold order; a repeated threshold is
  refused. Fixed as the F5 observation above. Goldens
  `tiers_unsorted_selected_by_threshold` and `tierRefusals`.
- **EC2-9.** Three golden notes contradicted their values. The case
  `capped_5pct_never_recovers` (renamed `capped_5pct_pool_never_clears`) said
  "no payback, IRR 0" beside payback year 3 and a root at 54.6792 percent;
  `rfactor_tranche_crossing` dated the 1.0 crossing to year 3 (it is year 2;
  the 60 to 40 step in year 3 is the 1.6 threshold); `rfactor_falls_back` said
  the R factor peaks "just above 2.5" (it peaks at 2.972625 in year 11). The
  notes now state the engine's numbers and a gate ties each note to them.
- **EC2-10.** The payback verdict named the first regime at the winning year.
  It names every regime at that year ("both" or "all" when every regime ties).
- **EC2-11.** Money read "$1339.3MM". `formatMillionUSD` in
  fiscalConventions.js gives "1,339.3 million USD" for every insight sentence;
  golden group `moneyFormat` pins it and a gate refuses "$" and "MM" in every
  golden sentence.

### Decided after EC2-5 (lead, delegated by the owner, 2026-09-15)

1. **Null 'multiple-roots' IRRs on the fixed 25 year projects: the contract is
   KEPT.** The sandbox runs a fixed 25 year life with no economic limit, so on
   the Suite test project (fixed opex 60) late contractor cash flow turns
   negative and the NPV is zero at a second, negative rate as well as the
   familiar one: `flat_test_project` at -20.4061 and 124.5777 percent. 18 cash
   flow goldens, `price_40_pia_default`, and all eight regimes in
   `cmp_all_templates_test_project` and `cmp_flat_vs_complex` read null with
   both roots listed; in every one the old IRR is one of the listed roots,
   unchanged to 1e-6. The Designer's default project keeps its rates at the
   deck price, but at 35 and 40 USD per bbl it too has two roots. Honest and
   consistent with screening; the summary carries `irrRoots` and the contractor
   sentence prints them. An economic limit would move graded EC2 values and is
   a separate product decision, recorded as a FUTURE item.
2. **A root above the band: FIXED 2026-09-15.** `capex_multiplier_0_7` has
   roots at -20.4852 and 1095.4783 percent, and the contract used to report the
   in-band one as 'ok'. `irrContract.js` now compares the sign of the NPV at
   1000 percent with the sign it tends to as the rate grows without bound (the
   earliest non-zero flow, under either discounting convention). When they
   differ a root lies above the band: one in-band root is then null
   'multiple-roots' with the in-band roots in `irrRoots` and
   `irrRootAboveBand: true`; with no in-band root it stays 'above-clamp' (flag
   true). Every other result carries `irrRootAboveBand: false`. Both engines
   follow it. Goldens: fiscal `capex_multiplier_0_7` moved ok to
   multiple-roots; new `irr_root_above_band_with_one_inside` in both oracles
   (ncf -5, 84, -64: roots -20 and 1500 percent). One screening status moved
   WITHOUT a root above the band: `payback_recrossed_from_first_period` (ncf
   10, -15, 60, which has no real root at any rate) read 'above-clamp' only
   because its NPV is positive at 1000 percent; it is 'no-root' now. No other
   screening value moved. An even number of roots above the band is not
   detected by the sign test.

## Breakeven (breakeven.js)

### B1. A one-sided tornado bar collapses to zero instead of flagging

**FIXED 2026-09-15 (owner decision).** An end with no breakeven below $500 is
null, the bar carries `unreachable: true` and no swing, unreachable bars sort
first, and the insight names each one. `mc_one_bar_unreachable` pins a run
where exactly one bar is open, with the retired zero-and-sort-last rule as the
negative control. The text below is the finding as recorded.

When one side of a swing cannot break even below $500 the bar's `swing` is
0 and that side is drawn at 0 from the base case; the variable then sorts
LAST regardless of how influential it is. `mc_with_unreachable` (capex P50
3400 $MM): all three high sides are null, all three swings are 0, and the
tornado is in input order with every high side at 0.0 while the low sides
are -80.7, -6.8 and -26.2 $/bbl. Pinned as engine behaviour.

### B2. Two percentile conventions in one module

EC3-0 note: both are PERCENTILE rules (the keys `p10`/`p90` are 10th and 90th percentiles). Screens now map them through the Suite's exceedance convention: an NPV's P90 (low case) reads `p10`, and a breakeven price carries no P-label at all.

breakeven.js reads P10/P50/P90 as `sorted[min(n - 1, floor(q n))]`;
screening.js's runMonteCarlo uses the simple-statistics rule (averaging the
two middle values when q n is an integer on an even length). On a 300 point
sample the two P50s are different elements. Both are gated as stated.

### B3. No disagreements

The closed-form price solve agrees with the engine's 100 step bisection to
1e-8 $/bbl on every case, the seeded sample is reproduced element for
element on six seeds including the default (20260829) and a 2000 iteration
run, and every verdict sentence matches character for character.

## EC3 wave findings, all FIXED 2026-09-15 (owner decisions)

Found while the EC3 Probabilistic Economics course was written (wave notes in
the NextGen repo). Each fix is gated in `economics.screening.test.js` or
`economics.breakeven.test.js` with a negative control for the retired rule.

- **EC3-1.** Payback was taken at the first non-negative cumulative and never
  revisited, so a cash-positive first year followed by more capex read payback
  0 beside a negative peak exposure. `payback` stays the first crossing (the
  definition cashflow.ts and fdp/costCalculations.js share); `paybackStatus`
  'recrossed' flags a return below zero and `paybackLast` is the last crossing
  into non-negative, null when the cumulative ends negative.
- **EC3-2.** An all-positive case read IRR 0 and payback 0. IRR was already
  null with 'no-sign-change' after EC6-1; payback is 0 with 'no-investment'
  (nothing was at risk, the same 0 cashflow.ts reports) and null with
  'not-recovered' where it used to be the project life.
- **EC3-3.** The Low and High scenarios scaled oil volume without its variable
  opex. They carry it now, as the Production sensitivity has since EC6-1.
- **EC3-4.** The `payback_multi_year` note said "3 + 10/40 = 3.25 years" while
  its own cumulative -100, -130, -70, -30, 10 pays back at 4 + 30/40 = 4.75,
  the value the golden always gated. Note corrected; no value moved.
- **EC3-5.** The breakeven base case and tornado read the STATED median while
  the sample drew from the fitted triangle, which differs when the fit clamps.
  An inexact fit now hands both the fitted triangle's 10th, 50th and 90th
  percentiles (`beliefs`), with a note.
- **EC3-6.** The Scenario Builder S-curve kept every floor(n/50)th sorted value,
  so it never plotted the top of the sample and disagreed with the cards. It
  is 51 points at 0, 2, ..., 100 percent read with the cards' quantile rule.
- **EC3-7.** The Monte Carlo drew every year independently and never moved
  variable opex, which narrowed the NPV spread far below the stated belief.
  It draws one factor per variable per iteration for every year, reserves
  carries variable opex, and a range outside 0 to 1 is refused.
- **EC3-8.** Nothing bounded a belief. Capex and opex percentiles below 0 and
  efficiency percentiles outside 0 to 100 are refused by name; a fitted draw
  past a limit is held at it and counted in `clippedDraws`, with a note.
