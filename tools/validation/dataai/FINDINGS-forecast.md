# FINDINGS: forecast (oracle_forecast.py, Data & AI D4, production forecasting)

Golden: `test-data/dataai/goldens/forecast_cases.json`, 139 cases (62 of
them refusals, every refusal message pinned in full), written by
`tools/validation/dataai/oracle_forecast.py`. Second witness:
`test-data/dataai/pins/forecast_pins.json`, 224 pins and 8 recorded skips,
written by `tools/validation/dataai/pin_forecast.py` (numpy 2.5.3, scipy
1.18.1, statsmodels 0.15.0, scikit-learn 1.9.1 from `/root/daienv`).
Gate: `__tests__/dataai.forecast.test.js` (452 tests) calls the engine on
every golden, the published NIST figures and every pin, plus property
tests, the Ekene scale run and the row cap. Negative control:
`negcontrol_forecast.sh` (51/51 engine plants red, 5/5 oracle plants red
and 1 stopped). Timing: `timing_forecast.mjs` (table below).

The oracle is STDLIB ONLY (python 3.12: `fractions`, `decimal` at 60
digits, `random` for the synthetic inputs). It reads no JavaScript and
takes a different road on every route (table in its docstring): the
recursions in the ERROR-CORRECTION form (l_t = f_t + alpha e_t, b_t =
phi b_{t-1} + alpha beta e_t) in Decimal, where the engine runs the
component form in float; single smoothing also checked against NIST's
expanded weighted sum; the damped h-step forecast by the closed form
phi (1 - phi^h) / (1 - phi), where the engine sums powers; the parameter
fit by a ZOOM GRID (the stated coarse grid, then an 11-point lattice per
axis re-centred until the centre holds, spacing / 4 down to 1e-11, then an
optimality check at +-1e-7 on every free axis), where the engine runs a
compass search; metrics in Fractions; mulberry32 in 32-bit integers with
the draw index (k m) >> 32 and Decimal paths; fitArpsModel's published
algorithm (log, reciprocal and q^-b regressions, the b grid accumulated as
JavaScript accumulates it) in Decimal.

**Ambiguity guard.** Where a float program could take a different branch
from the exact one (two coarse-grid SSEs within 1e-9 relative but not
equal, two Arps candidates' RMSE within 1e-9, a published figure within
1e-9 of a rounding boundary) the oracle refuses to write the case.

## Sources and published values

NIST/SEMATECH e-Handbook of Statistical Methods, section 6.4.3 (6.4.3.1
Single Exponential Smoothing, 6.4.3.2 Forecasting with Single Exponential
Smoothing, 6.4.3.4 Double Exponential Smoothing),
https://www.itl.nist.gov/div898/handbook/pmc/section4/pmc43.htm, read
2026-09-24. A U.S. government publication, public domain. Six golden
cases carry `source: 'published'`; the oracle asserts each printed figure
at NIST's printed precision before writing, and the gate holds the engine
to the same digits:

| case | NIST section | published figures asserted |
|---|---|---|
| nist-6431-ses-alpha-0.1 | 6.4.3.1, 6.4.3.2 | the smoothed column at alpha 0.1 (2 dp), MSE 19.0, the next forecast 71.5 |
| nist-6432-ses-trend-alpha-0.3 | 6.4.3.2 | single smoothing of the trend data at alpha 0.3, the Fit column (1 dp) |
| nist-6434-holt-fixed | 6.4.3.4 | alpha 0.3623, gamma 1.0, S_1 = 6.4, b_1 = 0.8: the Double and Forecast columns and the forecasts for periods 11 to 15 (1 dp) |
| nist-6434-holt-fit | 6.4.3.4 | the least-MSE double smoothing alpha 0.3623 (4 dp), gamma 1.0 at its bound |
| nist-6434-ses-fit | 6.4.3.4 | the least-MSE single smoothing alpha 0.977 (3 dp), its Single column and five forecasts of 22.4 |
| nist-6434-ses-alpha-1 | 6.4.3.4 | MSE 8.8867 (4 dp), the MSE at alpha = 1 exactly |

NIST figures that do not reproduce from the handbook's own recursion are
NOT asserted (each is a golden at the computed value with a note):
6.4.3.1 prints MSE 16.29 for alpha 0.5, the recursion gives 16.4965;
6.4.3.4 prints MSE 3.7024 for the double smoothing, the recursion gives
3.674309 over the 9 scored errors; 6.4.3.4 prints MSE 8.8867 beside alpha
0.977, which is the value at alpha = 1 (alpha 0.977 gives 8.8768). At
alpha 0.977 exactly S_4 is 7.7498, printed 7.7: NIST used the unrounded
optimum 0.97728, which the engine's search also finds.

Method references: Hyndman, R. J. and Athanasopoulos, G. (2021)
Forecasting: Principles and Practice, 3rd ed., OTexts, sections 5.5, 5.8,
8.1, 8.2; Gardner, E. S. and McKenzie, E. (1985) Forecasting trends in
time series, Management Science 31(10), 1237-1246; Hyndman, R. J. and
Koehler, A. B. (2006) Another look at measures of forecast accuracy,
International Journal of Forecasting 22(4), 679-688.

Ekene synthetic production (ours): `ekene_production()` in the oracle,
three wells EKENE-P01..P03 of 60 months, hyperbolic decline with 6%
multiplicative noise, a 2 to 4 month shut-in of zeros and a 25% workover
uplift after it, rounded to 0.1. The JS twin for scale runs is
`syntheticProduction` in `synthetic_wells.js` (mulberry32, same shape).

## Agreement achieved

Engine against the stdlib oracle: every golden passes at its stated
tolerance (1e-10 relative with a 1e-12 absolute floor for arithmetic;
estimated parameters carry a per-field tolerance because the two searches
reach the same minimum by different roads; labels, counts, indices and
messages exactly).

Library witness against the oracle, worst relative disagreement where the
conventions agree (printed by `pin_forecast.py`): accuracy (sklearn MAE,
RMSE, MAPE) 2.1e-16; backtest per-origin forecasts (statsmodels on each
window) 8e-16; bootstrap point forecasts 2.1e-16; fitSmoothing 4.8e-05.
The fitSmoothing figure is optimiser parameter agreement: the recursions
(fitted values, levels, trends, forecasts, scored SSE) agree at 1e-10;
scipy L-BFGS-B and statsmodels' own optimiser land within 1e-4 of the
oracle's parameters on the pinned cases, and the engine's SSE must be no
worse than L-BFGS-B's (relative 1e-9, `atMost` pins). Each pin's
tolerance is 10 x the library's own disagreement rounded up to a power of
ten.

Lead spot check 2026-09-24: an independent float recursion of
damped-ekene1-fit reproduces the engine SSE 379728.0583058 at the engine's
parameters, and multi-start L-BFGS-B in the stated box reaches the same
point (alpha 0.899177, beta 0, phi 0.870961).

The 8 skips, each a documented convention difference:

| case | library | why it differs |
|---|---|---|
| nist-6434-holt-fit (own fit) | statsmodels fit() | statsmodels holds beta <= alpha; stops at alpha = beta = 0.520453, SSE 37.8089 against the engine's 33.0688 |
| damped-phi-at-upper-bound (own fit) | statsmodels fit() | the same beta <= alpha limit: alpha = beta = 0.793925, SSE 52.5858 against 47.5921 |
| damped-ekene1-fit, damped-ekene1-fit-alpha-fixed (own fit) | statsmodels fit() | stops at a slightly worse point (379729.47 vs 379728.06; 465925.57 vs 465925.45); L-BFGS-B agrees with the engine (pinned) |
| holt-linear-exact (own fit) | statsmodels fit() | an exact line: every parameter gives SSE 0, so the point found is arbitrary |
| ses-two-points | statsmodels | refuses a series of one value after the known start |
| acc-zero-actual, acc-smape-zero-zero (MAPE) | sklearn | divides by max(\|y\|, eps) and returns a huge number; the engine reports null with the reason |

## Decisions (conventions the oracle cannot check)

1. **Form and names.** Component form of FPP3 8.1-8.2; beta is FPP3's
   beta* (statsmodels `smoothing_trend`); holt is damped with phi = 1.
2. **Initialisation at the first observation** (NIST 6.4.3.1, 6.4.3.3):
   l_1 = y_1, b_1 = y_2 - y_1, both overridable. Under the default trend
   start f_2 = y_2 by construction (damped: off by (1 - phi) b_1), so y_2
   is spent and scoring starts at t = 3; ses and an explicit initialTrend
   score from t = 2 (`scoredFrom`, 0-based). MSE = SSE / scored count.
3. **Bounds.** alpha, beta in [0, 1] inclusive; a FITTED phi in
   [0.8, 0.98] (FPP3 8.2); a GIVEN phi anywhere in (0, 1]. Parameters that
   end on a bound are listed in `optimiser.atBounds`.
4. **Deterministic optimiser.** Stage 1 grid (alpha, beta 0 to 1 by 0.1;
   phi 0.8, 0.85, 0.9, 0.95, 0.98; alpha outermost); a later point wins
   only when its SSE is below best x (1 - 1e-12). Stage 2 compass search:
   step 0.05 of each range, +step then -step on alpha, beta, phi in turn
   (clipped to the box; a trial the clip leaves in place is skipped),
   moves to the strictly lowest trial (ties to the earlier), halves the
   step after a sweep with no improvement, stops when a sweep at a step of
   at most 2^-30 of the range improves nothing (`converged`), or after
   200,000 SSE evaluations (`converged: false` with a warning; no golden
   or scale run reached it).
5. **Errors and metrics.** e = actual - forecast (ME positive means the
   forecast is low). RMSE divisor n. MAPE in percent, null with the reason
   when ANY actual is 0 (shut-in months are real zeros; dropping them
   silently would change the metric). sMAPE 100 mean 2|e| / (|y| + |f|),
   0 to 200 scale, a y = f = 0 term scoring 0. MASE mean |e| / Q,
   Q = mean |y_t - y_{t-m}| over the TRAINING series (divisor n - m,
   m = 1 default), null with the reason when Q = 0 or the training series
   has m values or fewer.
6. **Backtests.** Rolling origin, expanding window; origins firstOrigin,
   + step, ... while o + H <= n. refit true re-estimates at every origin;
   refit false holds the first window's parameters. Pooled metrics
   average over every origin and step; MASE scales each error by its own
   origin's Q.
7. **Bootstrap intervals** (FPP3 5.5). nSims paths; each step adds a
   residual drawn with replacement from the scored in-sample residuals
   (index floor(u x m)) to the one-step forecast, and the simulated value
   updates the state. One mulberry32(seed) stream (lib/stats), path by
   path, step by step; no Math.random in the engine. At least 2 scored
   residuals are needed. Residuals are drawn as fitted, without centring
   (their mean is not subtracted), as FPP3 5.5 and statsmodels simulate
   do; the docstring and the result's `basis.bootstrap` say so. A method
   whose residuals have a non-zero mean therefore drifts: on a declining
   well a flat method's paths can fall below its own point forecast (the
   gate shows it on arps-clean-auto with ses at alpha 0.3, where the mean
   residual is negative and the step-12 P10 sits below the point forecast).
8. **Quantile rule.** lib/stats `quantile` (simple-statistics 7.8.8) on
   the n sorted values, idx = n p: idx not whole gives the ceil(idx)-th
   smallest; idx whole with n even the mean of the idx-th and (idx+1)-th;
   idx whole with n odd the (idx+1)-th. For every nSims from 1 to 100,000
   and p in 0.1, 0.5, 0.9 the float test for a whole idx and ceil(idx)
   agree with exact arithmetic (checked exhaustively).
9. **Percentile labels** per `lib/conventions/percentile.js`: production
   is an outcome where more is better, so P90 (low) is the 10th percentile
   and P10 (high) the 90th; results carry EXCEEDANCE_DEFINITION.
   nonNegative (default true) reports a negative percentile as 0 and
   counts it in `clippedToZero`.
10. **Arps baseline** imported from `engines/dca/arps.js` (fitArpsModel,
    calculateArpsHyperbolic). Step k is passed as day k, so qi and Di are
    per step. fitArpsModel drops non-positive rates and its t = 0 is the
    first positive value; forecasts are evaluated at k - t0. In
    compareWithArps it is refitted on every window.
11. **Ranking.** Lowest metric first; within 1e-12 relative keeps the
    listed order (methods as given, arps last); a null metric is unranked.
12. **Messages** state exact conditions; figures print shortest
    round-trip. Changed 2026-09-24: phi on 'ses' ("'ses' has no trend to
    damp", previously named holt); the Arps no-fit reason now states
    fitArpsModel's test (finite qi > 0 and Di > 0) in place of "a series
    that does not decline cannot be fitted".
    Changed 2026-09-24 (engine PR fix/dataai-forecast-foundation-findings,
    no numeric field changed): backtest and comparison MASE reasons name
    "the training window" once ("at origin 12 the training window has 12
    values, so the lag-12 naive forecast has no in-sample error (it needs
    more than 12)"; was "the 12 training values has 12 values"); the
    zero-scale reason states the count once ("insample has 3 values and
    the lag-1 naive forecast has zero in-sample error on them"; was "on the
    3 values of the 3 training values"); the Arps window reasons read "at
    origin 5 the training window has / gives" (was "the 5 training values
    have / give"); singular forms at 1: "then 1 actual", "leaves no actual"
    (was "fewer than 1 actuals"), "y has 1 value", "forecast must have 1
    value", "1 scored residual(s)", basis "1 path" and "forecasts y[o]".

## Boundary table (per rule)

| rule | accepted at the boundary | refused | golden / test |
|---|---|---|---|
| ses length | 2 values | 1 | ses-two-points, fit-ses-one-value |
| holt / damped length (default start) | 3 | 2 | holt-three-points, fit-holt-two-values |
| holt / damped with initialTrend | 2 | 1 | fit-damped-trend-one-value |
| alpha, beta | 0 and 1 inclusive | below 0, above 1 | ses-alpha-0, ses-alpha-1, holt-beta-0, fit-alpha-negative, fit-alpha-above-1 |
| phi given | (0, 1] | 0, above 1 | damped-phi-0.5-fixed, damped-ekene2-phi-1, fit-phi-0, fit-phi-above-1 |
| phi fitted | 0.8 and 0.98 inclusive | never searched outside | damped-ekene2-phi-0.8, damped-phi-at-upper-bound |
| h (fit, arps) | 0 to 10,000 | -1, 10,001, fractions | fit-h-negative, fit-h-above-max, fit-h-fraction, arps-h-bad |
| h (intervals) | 1 to 10,000 | 0 | pi-h-0 |
| nSims | 1 to 100,000 | 0, 100,001 | pi-ses-nsims-1, pi-nsims-0, pi-nsims-above |
| bootstrap pool | 2 scored residuals | 1 | pi-pool-too-small |
| series length | 100,000 | 100,001 | jest row-cap test |
| backtest last origin | o + H = n | o + H > n | bt-ses-last-origin-exact, bt-first-too-large |
| backtest origin count | 5,000 | above | bt-too-many-origins |
| MAPE | every actual non-zero | any actual 0 (null + reason) | acc-zero-actual, bt-ses-shutin-actuals |
| MASE scale | Q > 0, training length > m | Q = 0 or length <= m (null + reason) | acc-constant-insample, acc-insample-too-short, bt-ses-flat-training |
| Arps positive values | 3 | 2 | arps-clean-*, arps-two-positive-refused |
| grid and ranking ties | within 1e-12 relative (earlier kept) | beyond | holt-linear-exact, cmp-constant-ties |

## Negative control

Run 2026-09-24 on `feat/dataai-forecast` (`negcontrol_forecast.sh`):
baseline 432 passed; **51/51 engine plants red**; 5/5 oracle plants red
and 1 stopped (the oracle with a misread NIST column refuses to write);
restored and re-verified 432 passed. The first run of this session gave
49/50: "phi searched to 0.99" stayed green because no golden fitted phi on
its upper bound (fixed by `damped-phi-at-upper-bound`), and the "holt
length rule" plant skipped on a wrong target (fixed). Plants cover the
initialisation, scoring start, recursions, damping, h-step forecasts, grid
tie, grid values, phi bounds, clipping, stop rule, atBounds, parameter
rules, the draft wordings, error sign, MAPE/sMAPE/MASE/RMSE definitions,
bootstrap draw, pool, state update, percentile labels and level, one
stream per call, backtest origins, refit, window leakage, MASE scale
window, Arps time base and window, ranking ties and direction.

## Timings (Node v18.19.1, this host; `timing_forecast.mjs`)

| points | method | fit ms | SSE evaluations | backtest refit ms (origins) | backtest held ms | intervals h 12 x 1,000 ms |
|---|---|---|---|---|---|---|
| 600 | ses | 9 | 38 | 22 (19) | 1 | 8 |
| 600 | holt | 12 | 365 | 82 (19) | 7 | 8 |
| 600 | damped | 6 | 769 | 132 (19) | 7 | 14 |
| 5,000 | ses | 1 | 38 | 14 (20) | 5 | 13 |
| 5,000 | holt | 40 | 353 | 452 (20) | 20 | 35 |
| 5,000 | damped | 49 | 761 | 917 (20) | 46 | 56 |

200 wells x 120 months: fit ses + holt + damped (h 24) 564 ms;
compareWithArps (origins 96, 102, 108; horizon 12) 2,525 ms; damped
intervals h 24 x 1,000 paths 1,843 ms. The app should run field-wide
comparisons with progress shown or in a worker.

## Known limits

1. No seasonal smoothing (Holt-Winters); m in MASE allows a seasonal naive
   scale only.
2. The residual bootstrap resamples independently with the parameters held
   fixed: no parameter uncertainty, no autocorrelated errors (FPP3 5.5).
3. The optimiser is local from the best grid point; on a flat SSE surface
   (`holt-linear-exact`) the parameters are not identified and the point
   returned is the one the stated rule reaches.
4. Arps inherits fitArpsModel's linearised fits and day time base: qi and
   Di are per month when steps are months.
5. Additive errors only (no multiplicative ETS forms).
6. Bootstrap residuals are not centred (decision 7): when a method is
   biased on the training series (a flat method on a decline) the
   simulated paths inherit that bias, and the percentile band can sit
   wholly on one side of the point forecast. Compare the band with the
   point forecast and the backtest ME before reading it as uncertainty.

## Lead decisions (2026-09-24)

1. MASE lag stays m = 1 in the engine (a production decline has no
   seasonality to scale by); the app exposes m and states it.
2. The app leads with MASE (compareWithArps' default ranking) and shows
   MAPE only with its null reason when a shut-in month is in the actuals.
3. Field-wide runs in the app go through a web worker with progress.
4. Bootstrap residuals stay uncentred (FPP3 5.5, statsmodels); the
   convention is stated in the docstring, `basis.bootstrap`, decision 7
   and known limit 6.
