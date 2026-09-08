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

The sampler is a bare `Math.random()`. Two runs on the same inputs give
different P10/P50/P90 (gated as such). The gate substitutes a mulberry32
stream for Math.random and the oracle replicates mulberry32 bit for bit
(uint32 arithmetic, divided by 4294967296), so the sampler's arithmetic,
the quantile rule, the histogram and the CDF are all proven on four seeded
cases; only the seeding itself is missing. breakeven.js and lib/stats
already carry the seeded generator this function should use.

### S4. runMonteCarlo throws when every uncertainty is zero

With all three ranges at 0 every iteration is the base NPV, the histogram
bin width is 0, `(v - min) / binSize` is NaN, `histogram[NaN]` is undefined
and `.count++` throws a TypeError. `mc_zero_uncertainty_throws`: the oracle
reports P10 = P50 = P90 = EMV = base NPV (188.3699 $MM on that case); the
engine rejects. Pinned as `engine.throws`.

### S5. runMonteCarlo returns an empty CDF below 50 iterations

The S-curve downsample is `i % Math.floor(iterations / 50) === 0`; below
50 iterations the divisor is 0, `i % 0` is NaN, and the CDF is empty.
`mc_seed11_40_iters_cdf_empty` pins the empty array on both sides.

### S6. getPortfolioMetrics reads a chance of success of 0 as certain

`(p.chanceOfSuccess || 1.0)` turns 0 into 1.0. `portfolio_zero_chance`
(NPV 100 at chance 0 plus NPV 40 at chance 0.5): risked NPV should be 20;
the engine reports 120. A project the user has written off as a certain
failure is counted at full value.

### S7. Observations, no numerical disagreement

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

### F3. The resilience and progressivity verdicts rank ties by rounding noise

When every regime gives up the same NPV across the capex sweep (any
comparison where cost is never recovered, `cmp_never_recovers`: all six
regimes give up 10909.0909 $MM, differing in the fifteenth figure) the
strict `<` reduce in deriveInsights names whichever regime's floating point
noise happened to be smallest. The engine names "USA - Gulf of Mexico",
the oracle's arithmetic names "Brazil - Concession"; neither is a result.
The golden carries the ranked quantities (`capexLossesAsEngine`,
`priceClimbs`) and the gate treats a tie as a tie.

### F4. IRR beyond the 102400 percent bracket reports the bracket

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
- Sliding-scale and R-factor tiers are selected as the LAST tier in list
  order whose threshold is reached. Identical to "highest threshold
  reached" for sorted tiers (all templates and the Designer's defaults
  are sorted); an unsorted tier list would silently pick the wrong rate.
- The price multiplier scales oil only; gas and NGL prices are untouched,
  so the price sweep is an oil price sweep.

## Breakeven (breakeven.js)

### B1. A one-sided tornado bar collapses to zero instead of flagging

When one side of a swing cannot break even below $500 the bar's `swing` is
0 and that side is drawn at 0 from the base case; the variable then sorts
LAST regardless of how influential it is. `mc_with_unreachable` (capex P50
3400 $MM): all three high sides are null, all three swings are 0, and the
tornado is in input order with every high side at 0.0 while the low sides
are -80.7, -6.8 and -26.2 $/bbl. Pinned as engine behaviour.

### B2. Two percentile conventions in one module

breakeven.js reads P10/P50/P90 as `sorted[min(n - 1, floor(q n))]`;
screening.js's runMonteCarlo uses the simple-statistics rule (averaging the
two middle values when q n is an integer on an even length). On a 300 point
sample the two P50s are different elements. Both are gated as stated.

### B3. No disagreements

The closed-form price solve agrees with the engine's 100 step bisection to
1e-8 $/bbl on every case, the seeded sample is reproduced element for
element on six seeds including the default (20260829) and a 2000 iteration
run, and every verdict sentence matches character for character.
