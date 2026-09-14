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

## Not done

- Literature byte-verification against the worked examples in Newendorp and
  Schuyler and in Mian remains an owner-PDF gate (as the Suite's test header
  already states); every golden here is hand-derived or oracle-derived.
- No engine edit of any kind, per the brief.
