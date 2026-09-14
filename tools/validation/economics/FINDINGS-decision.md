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

### D1. impliedPriors: a delta of exactly half a percent is reported inconsistent

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
