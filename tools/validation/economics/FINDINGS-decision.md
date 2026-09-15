# FINDINGS: decision analysis, VOI and portfolio (EC0 agent B, 2026-09-08)

Scope: `engines/economics/decisionTree.js`, `engines/economics/voi.js` and
`engines/economics/portfolio.js`, extracted verbatim from the Suite
(`src/lib/decisionTree.js`, `src/utils/voiCalculations.js`,
`src/utils/portfolioOptimizer.js`), gated by
`__tests__/economics.decision.test.js` and `__tests__/economics.portfolio.test.js`
against the independent oracles `oracle_decision.py` and `oracle_portfolio.py`
and their goldens `test-data/economics/goldens/decision_cases.json` (90 cases)
and `portfolio_cases.json` (62 cases).

Discounting convention: none of these three modules discounts. EMV rollback,
EVPI, EVII, VOI and the knapsack all take payoffs and NPVs that were already
discounted by whichever engine produced them (screening.js at mid-year,
cashflow.ts at year-end). Money is USD millions.

Every engine behaviour below is UNCHANGED. Where the engine and the oracle
disagree, the golden carries both numbers, labelled, and the gate pins the
gap. Decisions are the owner's.

## Disagreements

### D1. impliedPriors: a delta of exactly half a percent is reported inconsistent (RESOLVED in EC4-0, see below)

Golden: `impliedPriors/justInsideTolerance`.

Inputs: stated priors 0.3 / 0.7; one indicator at probability 1 with
posteriors 0.305 / 0.695. The implied priors are 0.305 / 0.695, deltas
+0.005 / -0.005.

Method statement (engine header): consistent when every delta is within 0.005,
an inclusive threshold. Oracle, exact arithmetic: delta = 1/200 <= 1/200,
consistent = true.

Engine: `0.305 - 0.3` evaluates to `0.0050000000000000044` in binary floating
point, which fails `<= 0.005` by 4.4e-18, so consistent = false.

Who is right: the method, at the boundary. In practice this is a UI warning
that fires one representation error early, and the boundary is unreachable
from the VOI Analyzer's integer-percent form (it needs a posterior typed to
three decimals of a percent). Recorded so the boundary is known; a fix would
be a small tolerance in the comparison, not a change of threshold.

### D2. Knapsack grid: a free project (capex 0) is charged one cell

Golden: `optimize/freeProjectZeroLimit`, `optimize/freeProjectTightLimit`
(and `freeProjectSlack`, where one spare cell makes the two agree).

Method statement: maximise summed risked EMV subject to the sum of capex not
exceeding the limit; leaving capital unspent is always allowed. A project
with capex 0 and positive EMV therefore belongs in every optimum.

Engine: each project weighs `max(1, round(capex / resolution))` cells, so a
free project costs one cell of budget.

| case | engine set, capex, EMV | exact optimum, capex, EMV | gap |
|---|---|---|---|
| freeProjectZeroLimit (limit 0) | [], 0, 0 | [free], 0, 10 | -10 |
| freeProjectTightLimit (limit 100) | [A], 100, 60 | [free, A], 100, 70 | -10 |

Who is right: the method. The `max(1, ...)` guard exists so a project never
weighs zero cells on a coarse grid; its side effect is that a genuinely free
project (a carried interest, a farm-in with no capex) needs one cell of slack
to be funded. Narrow, but real when the budget is fully committed.

### D3. Knapsack grid: overshoot, a reported portfolio above the limit

Golden: `optimize/gridOvershoot`. Limit 6000 (above 5000, so the grid is
6000 / 2000 = 3 per cell). A(4000, EMV 500) weighs 1333 cells (3999
effective), B(2002, 300) weighs 667 (2001 effective), C(1995, 280) weighs 665.

Engine: [A, B], totalCapex 6002, totalEmv 800. Exact optimum: [A, C],
capex 5995, EMV 780. Gap +20 (the engine reports more EMV than is
affordable, and a capex 2 over the limit the user typed).

Method statement: the engine's own header admits this ("overshoot is bounded
by half a cell per project, screening-grade and reported via `resolution`").
So it is a documented approximation, not a defect of implementation. The
finding is that nothing in the result flags that `totalCapex` exceeds
`capexLimit`; a reader must know to compare them.

### D4. Knapsack grid: undershoot, a feasible project left out

Golden: `optimize/gridUndershoot`. Limit 6000 (grid 3 per cell). W, X, Y at
capex 1499 (EMV 200, 210, 220) and Z at 1502 (EMV 230): total 5999, which fits
exactly. On the grid each rounds up (1499 / 3 = 499.67 to 500; 1502 / 3 =
500.67 to 501), summing to 2001 > 2000 cells.

Engine: [X, Y, Z], capex 4500, EMV 660. Exact optimum: all four, capex 5999,
EMV 860. Gap -200, a 23 percent shortfall in reported EMV from rounding
alone.

Same method statement as D3: documented, bounded by half a cell per project,
but the bound is on capex, and the EMV consequence can be large when several
projects each round the same way. The exact 1 $MM grid is used whenever every
capex and the limit are integers and the limit is at most 5000, so D3 and D4
only bite on large budgets or non-integer inputs.

None of the seeded random sets (seeds 6001, 1002, 1601, 1602 at 6, 10, 16 and
16 projects) tripped the grid; the gate pins `setChanged` false on every one
of them and `CHANGED_BY_GRID` names the four cases above, so a new case
where the grid changes the set cannot appear unseen.

## Documented approximations, not disagreements

- P(portfolio NPV < 0): the engine uses the Abramowitz and Stegun 7.1.26 erf
  (published max error 1.5e-7); the oracle uses `math.erf`. Largest gap across
  the 62 cases: 6.86e-8 on `riskMetrics/correlation_0` (engine 0.0015708182,
  oracle 0.0015707496). The gate allows 1.5e-7 and asserts the observed
  maximum stays below it.
- Ties resolve to the first branch or action listed (`rollback/equalEmvTie`,
  `informationTree/costExactlyNetZero`, `optimize/tieIdenticalProjects`,
  `optimize/tieDifferentComposition`). The oracle states the same convention
  for trees and lists every optimal set for the knapsack.

## Observations for the owner (no number disagrees)

- VOI Analyzer with a malformed indicator (`voi/malformedPosterior`:
  posteriors 90 / 40 for the positive indicator). The KPIs are computed from
  the entered numbers as typed (EMV with information 74, VOI 69, net 59),
  which is what the method statement says, and only the diagram is withheld
  with a consistency warning. A VOI of 69 against an EVPI of 63 is on the
  card, above the theoretical maximum. The engine is doing what it
  documents; whether a non-distribution should produce KPIs at all is a
  product decision.
- The VOI verdict at exactly zero net value (`voi/costExactlyValue`, cost 33
  against a gross VOI of 33) reproduces the neutral wording in floating
  point on the default inputs. Other inputs could land a hair either side of
  zero; the two-decimal KPI would read 0.00 while the verdict reads positive
  or negative.

## EC4-0 repair (2026-09-14, owner decision before the EC4 course)

The Decision Analysis & Value of Information course's app audit found the VOI
Analyzer reporting values the method does not admit, and the owner chose to
repair the engine before the course teaches it.

- **Percent inputs that are not distributions are now REFUSED**, with a
  `DecisionTreeError` naming the sum in percent (`Outcome chances given
  "Positive Seismic" sum to 130 percent, expected 100`): outcome chances,
  indicator chances, and each indicator's outcome chances, each chance in
  [0, 100] and each sum within 1e-4 percent points of 100. Goldens:
  `voiRefusals` (7 cases). Before, `posteriorsAboveHundred` (the old
  `voi/malformedPosterior`) computed a VOI of 69 above the EVPI of 63, and
  `posteriorsOffsetButPriorsAgree` (indicators 50 / 50 with outcome chances
  60 / 50 and 0 / 90) PASSED the consistency check while its cards said an
  EMV with information of 47.5 and its diagram 45.5: the tree renormalises,
  the cards did not. `indicatorChancesAboveHundred` (40 + 70) printed the
  default cards and silently dropped the diagram.
- **Inputs that contradict the stated priors are WITHHELD.** EMV without
  information and EVPI depend only on the stated priors and are still
  reported; `emvWithInfo`, `voi`, `netVoi` and the tree are null, `withheld`
  is true, and the insight says the value is withheld and why. Goldens:
  `contradictingPosterior` (was a gross VOI of 75 above the EVPI of 63),
  `identicalPosteriorsWithheld` (was -15, below zero),
  `certainPosteriorsWithheld` (was 245), `withheldPastHalfPercent`.
- **D1 resolved.** `impliedPriors` compares against 0.005 + 1e-12, so a
  delta of exactly half a percent in the typed decimals is consistent as the
  method states. `justInsideTolerance` no longer carries a disagreement, and
  `voi/consistentAtHalfPercent` pins the inclusive boundary end to end.
- **The two "Observations for the owner" above are closed** for the
  malformed indicator (now refused). The zero-net wording observation stands.

Unchanged by EC4-0 and taught by the course as properties of the apps (owner
kept them out of the repair): exact ties recommend the first option listed;
the net VOI verdict reads the unrounded value beside a two-decimal card; the
Decision Tree Builder's node label shows the value before the branch cost;
non-numeric or blank costs read as 0 and negative costs are accepted.

## EC4-8 and EC4-2 (FIXED 2026-09-15, owner decisions)

These supersede two lines above: the EC4-0 note that "the net VOI verdict
reads the unrounded value beside a two-decimal card", and the standing
zero-net wording observation. Both are closed.

### EC4-8. Probability tolerances refused sums on their own edge (FIXED 2026-09-15)

Evidence: three branches typed 0.333333 sum to 0.999999, exactly 1e-6 short
in the typed decimals, but `Math.abs(0.999999 - 1)` is
1.0000000000287557e-6 in binary, so `> PROB_TOL` refused a sum that the
refusal message printed as 0.999999. The same held in the VOI Analyzer at
percent scale: 33.3333 x 3 = 99.9999 is 1.0000000000331966e-4 short against
`PCT_TOL` 1e-4.

Fix: every tolerance comparison adds the 1e-12 representation allowance
`impliedPriors` already used for D1: the chance node rollback, the outcome
priors (`validateLottery`, so `bestActionEmv`, `evpi` and `evii`), each EVII
likelihood column, and the VOI Analyzer's percent sums. Accepted
probabilities are used as typed, never renormalised (the oracle states the
same). The tolerance itself is unchanged: 0.999998 and 99.9998 are refused.

Goldens (oracle method statement updated: distributions sum to 1 within an
inclusive 1e-6): accepted `rollback/thirdsTypedToSixPlaces` (EMV 34.999965),
`evpi/thirdsPriorsSixPlaces`, `evii/likelihoodColumnSixPlaces`,
`voi/thirdsOutcomeChancesFourPlaces`; refused
`rollbackRefusals/thirdsTypedToThreePlaces` (0.999),
`rollbackRefusals/sumShortByTwoMillionths`,
`eviiRefusals/likelihoodColumnShortByTwoMillionths`,
`eviiRefusals/priorsShortByTwoMillionths`,
`voiRefusals/thirdsOutcomeChancesThreePlaces` (99.999),
`voiRefusals/outcomeChancesShortByTwoTenThousandths`.

Gates: `EC4-8: binary representation allowance on every probability
tolerance` in `__tests__/economics.decision.test.js`. Its negative controls
restore the retired `> 1e-6` and `> 1e-4` comparisons and show they refuse
each accepted golden.

### EC4-2. The net VOI verdict disagreed with its own card (FIXED 2026-09-15)

Evidence, default Analyzer inputs (gross VOI 33):

| survey cost | net VOI (unrounded) | card before | verdict before | card now | verdict now |
|---|---|---|---|---|---|
| 32.996 | +0.004 | 0.00 | Since this is positive | 0.00 | neutral |
| 33.000 | 0 | 0.00 | exactly pays for itself | 0.00 | neutral |
| 33.004 | -0.004 | -0.00 | not justified | 0.00 | neutral |

Fix: net VOI is rounded once to card precision (2 decimal places, half away
from zero on the magnitude, with the 1e-12 allowance so an exact half cent
rounds as its decimals do). That one value feeds the card and the verdict.
Rounding to 0.00 (|net| < 0.005) is neutral and has its own sentence. Every
card and every dollar figure in the insight uses the same formatter, which
normalises negative zero, so "-0.00" is never printed.

Wording changed (the neutral sentence only). Before: `The information
exactly pays for itself, so the decision is value-neutral on EMV grounds.`
Now: `Since this rounds to zero, the information costs what it is worth, so
acquiring it or not is indifferent on EMV grounds.` The positive and negative
sentences are unchanged.

Goldens: every `voi` case now carries `cards` (the oracle's rounded strings),
and the gate requires exact string equality. New cases
`netRoundsToZeroFromAbove` (32.996), `netRoundsToZeroFromBelow` (33.004),
`netHalfCentAbove` (32.995, 0.01 acquire), `netHalfCentBelow` (33.005, -0.01
reject), `netClearlyPositive` (32.9), `netClearlyNegative` (33.1);
`costExactlyValue` keeps its values. No existing golden number moved.

Two card strings moved on the engine (goldens carry the unrounded numbers,
which did not move):

- `voi/accuracySweep_0p55`, an existing case: the VOI card printed `-0.00`
  (the exact VOI is 0; binary gave a tiny negative) and the insight repeated
  it. It now prints `0.00`. The retired rule was already showing -0.00 on a
  shipped golden.
- `voi/netHalfCentBelow` (cost 33.005): the EMV with information card was
  `14.99` from `toFixed(2)` on the binary 14.994999999999997; exact 14.995
  rounds half away from zero to `15.00`, which it now prints.

Gates: `golden: VOI Analyzer` (card strings, no "-0.00" anywhere, verdict
sign equal to the card sign) and `EC4-2: one rounded net VOI for the card
and the verdict`. Its negative controls show the retired unrounded verdict
says acquire under the 0.00 card at 32.996, and the retired `toFixed(2)` card
prints -0.00 at 33.004.

### EC4-9. The VOI diagram refused a node the user never typed (FIXED 2026-09-15)

Evidence: after EC4-8, typing every outcome chance, every indicator chance
and every outcome chance given an indicator as 33.3333 passes each percent
sum (99.9999, on the edge). The diagram's Bayes inversion then gave each
"Signal received" branch P(indicator) x (sum of its outcome chances), and
those summed to 0.999998. The strict chance node check refused with
`Chance branch probabilities sum to 0.999998, expected 1 (at node "Signal
received")`, naming a node the user never typed. (With a single edge typed,
the tree already renormalised the posteriors silently while the cards used
them as typed, so the two could differ by about 1e-6 relative.)

Fix (owner decision): once every typed percent input has passed validation,
the indicator chances, and each indicator's outcome chances, are divided by
their own sums. That one renormalised set feeds the cards and the diagram,
so the two remain one analysis. The stated outcome chances stay as typed,
the consistency check reads the typed entries, and a chance node typed
directly in the Decision Tree Builder keeps the strict refusal (0.999998
still throws). Sums that are exactly 100 are unchanged, so no existing
golden value moved.

Goldens (oracle method statement updated the same way): `voi/compoundEdgeAllThirds`
(the reproduction: useless signal, net VOI card -1.00, reject) against
`voi/compoundEdgeAllThirdsExact`, and `voi/compoundEdgeInformative` (outcome
chances given each indicator 66.6666 / 22.2222 / 11.1111 and mirrors, net VOI
card 7.89, acquire) against `voi/compoundEdgeInformativeExact`. Every
unrounded quantity agrees with its exact reference within the stated 1e-3
$MM (largest gap 1.03e-4, from the typed stated chances 0.333333 used as
typed), and every card string matches.

Gates: `EC4-9: derived branch probabilities are renormalised once typed
inputs pass`. The negative control restores the pre-EC4-9 derivation (typed
chances inverted with no renormalisation) and shows it throws at "Signal
received" on both edge cases and builds on both exact references. A second
test shows a typed 0.999998 chance node is still refused.

## Not done

- Literature byte-verification against the worked examples in Newendorp and
  Schuyler and in Mian remains an owner-PDF gate (as the Suite's test header
  already states); every golden here is hand-derived or oracle-derived.
- No engine edit of any kind, per the brief.

## EC5-0 repair (2026-09-14, owner decision before the EC5 course)

Scope: `engines/economics/portfolio.js` only. This supersedes the P(loss)
erf bullet under "Documented approximations" above: the loss probability is
no longer a normal CDF at all.

### Why: the normal approximation was badly wrong for a few risked projects

`portfolioRiskMetrics` reported P(portfolio NPV < 0) as Phi(-mean/sd) and the
P90 / P10 cards as mean -/+ 1.2816 sd. Exact answers (enumeration, oracle
`riskMethod` section) against what the engine used to say and what it says
now at the default seed 20260829 and 10000 iterations:

| portfolio (pos / NPV / fail cost) | exact P(loss) | old normal | new Monte Carlo | exact P90 | old P90 | new P90 |
|---|---|---|---|---|---|---|
| one wildcat 0.3 / 300 / 50 | 0.7 | 0.365832 | 0.6961 | -50 | -150.56 | -50 |
| three mixed (0.3/300/50, 0.25/400/60, 0.4/250/45), rho 0 | 0.315 | 0.266646 | 0.3128 | -155 | -193.46 | -155 |
| 2 identical wildcats | 0.49 | 0.313855 | 0.4871 | -100 | -180.70 | -100 |
| 6 identical wildcats | 0.117649 | 0.200464 | 0.1181 | -300 | -173.51 | -300 |
| 8 identical wildcats | 0.255298 | 0.166046 | 0.2514 | -50 | -141.40 | -50 |

The old P90 sat below the worst possible outcome (-50 for one wildcat, -155
for the three), and the sign of the probability error changed with n (too
low at 1 to 3 projects, too high at 6, too low at 8).

### The new contract

- `DEFAULT_RISK_SEED = 20260829` (the EC3-0 screening seed) and
  `DEFAULT_RISK_ITERATIONS = 10000` are exported.
- `portfolioRiskMetrics(selected, correlation = 0, { seed, iterations })`.
  `emv`, `stdDev` (the rho moment formula), `independentStdDev` and the
  clamped `correlation` are unchanged and closed form. `probLoss`, `p90` and
  `p10` come from a seeded Monte Carlo on mulberry32(seed): per iteration
  F1, F2, then per project in array order e1, e2 (all Box-Muller normals,
  every one drawn whether needed or not); z1 = sqrt(rho) F1 + sqrt(1 - rho) e1,
  z2 likewise; success when normalCDF(z1) < pos, worth npv_p50 + sd z2,
  otherwise -fail_cost. probLoss = count(value < 0) / iterations; p90 = the
  simple-statistics quantile at 0.1 (the LOW case), p10 at 0.9. The result
  carries `seed`, `iterations` and `method: 'monte-carlo'`. An invalid seed
  or iteration count falls back to the default; an empty selection is
  0 / 0 / 0 with the seed and iterations still reported.
- rho is now the correlation of the LATENT drivers (a one-factor Gaussian
  copula). The success / failure event correlation it implies is lower than
  rho except at 0 and 1, so the Monte Carlo spread is not the analytic
  `stdDev`, which still uses the moment formula. p90 <= emv <= p10 is not
  guaranteed for a skewed mixture; p90 <= p10 is.
- `optimizePortfolio({ ..., seed, iterations })` passes both through to the
  risk block.

### Validation

The oracle replays the sampler bit for bit (goldens `riskMetrics` and
`optimize`, 2000 iterations each, plus two cases at the engine defaults
called with no options); the gate compares probLoss exactly and P90 / P10
within 1e-9 scaled. Independently, `riskMethod` holds 14 cases whose answers
owe nothing to sampling: exact enumeration of independent binary projects
(1, 2, 3, 6, 8 identical and the three mixed), pos 1 normal sums at rho 0,
0.5 and 0.8, a success / failure mixture with spreads, comonotone rho 1
cases (P(loss) = 1 - pos), and binary projects at rho 0.35 and 0.5 by
conditioning on F1. Every Monte Carlo estimate is within 4 standard errors
(worst 1.88), and the discrete P90 / P10 equal the exact percentile outcome
wherever the cumulative probability at and below it is more than 0.01 from
the level. The negative control (the old normal formulas restored) turns the
riskMethod cases red.

### Knapsack: D3 flagged, negative capex refused

- `optimizePortfolio` now returns `capexLimit` (the clamped limit),
  `overLimit` (totalCapex > capexLimit) and `overLimitBy`
  (max(0, totalCapex - capexLimit)). `optimize/gridOvershoot` reports
  overLimit true by 2 (capex 6002 at limit 6000); `classic450` reports false.
  D3 is now FLAGGED, not prevented: the grid still chooses the same set.
- A project whose capex is a finite number below 0 throws
  `PortfolioInputError` naming it, e.g. `Project "B" has a negative capex
  (-150); capex must be 0 or more` (`optimizeRefusals`). It used to be
  accepted silently, pushing the frontier's x axis negative and out of order.
- D2 (a free project charged one cell) and D4 (grid undershoot) are
  UNCHANGED, and `CHANGED_BY_GRID` still names the same four cases.

## EC5-6 and EC5-7: FIXED 2026-09-15 (owner decisions)

Engine: engines/economics/portfolio.js. Oracle
tools/validation/economics/oracle_portfolio.py regenerated twice,
byte-identical. Gate __tests__/economics.portfolio.test.js, 149 tests.

**EC5-6, a blank pos made the project a certain failure (FIXED).** Before:
`projectEmv` took `p.pos ?? 1` and clamp01 read "n/a" as 1 but an empty
string as 0, so a blank pos turned a 300 NPV wildcat into EMV minus the fail
cost; 1.4 and -0.2 were clamped silently. After: a missing or null pos is the
documented default 1. A pos that is present must be a number, or a numeric
string, from 0 to 1; otherwise projectEmv, projectMoments,
portfolioRiskMetrics and optimizePortfolio throw PortfolioInputError naming the
project (name, else id, else index; "A project with no name or id" when a
lone project has neither):
- `Project "<label>" has a blank pos; pos must be a number from 0 to 1`
- `Project "<label>" has a pos that is not a number (<value>); pos must be a number from 0 to 1`
- `Project "<label>" has a pos outside 0 to 1 (<n>); pos must be a number from 0 to 1`

Goldens: projectEmv cases posAboveOneClamps, posBelowZeroClamps and
nonNumericPosIsDefault moved to the new projectEmvRefusals section (10 cases)
as posAboveOneRefused, posBelowZeroRefused and nonNumericPosRefused; new
accepted cases posOneBoundary, nullPosIsDefault, numericStringPos; new
riskMetricsRefusals section (2 cases). Negative controls: the retired reader
computes a number for every refusal golden (blank pos to 0, "n/a" to 1) and
agrees with the engine on every accepted golden.

**EC5-7, capex "abc" counted as 0 (FIXED).** Before: the EC5-0 refusal checked
finite numbers only, so a non-numeric, blank or missing capex was 0 and the
project was funded for free. After: optimizePortfolio checks every project in
array order, capex then pos, before computing anything, and refuses any capex
that is not a finite number of 0 or more:
- `Project "<label>" has no capex; capex must be 0 or more` (missing or null)
- `Project "<label>" has a blank capex; capex must be 0 or more`
- `Project "<label>" has a capex that is not a finite number (<value>); capex must be 0 or more`
- `Project "<label>" has a negative capex (<n>); capex must be 0 or more` (unchanged)

A string value is shown in double quotes. optimizeRefusals grew from 2 to 11
cases, and the gate now asserts each exact message. New optimize case
numericStrings (capex "100" and " 200 ", pos "0.9") shows that numeric strings
are numbers. Negative control: the retired finite-only check lets every
non-numeric, blank, missing and infinite capex golden through. D2, D3 and D4
are unchanged, and CHANGED_BY_GRID still names the same four cases.
