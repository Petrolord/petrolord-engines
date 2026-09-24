# FINDINGS: ml (oracle_ml.py, Data & AI D2)

Golden: `test-data/dataai/goldens/ml_cases.json`, 171 cases (69 of them
refusals; 11 published NIST StRD anchors carrying 132 certified figures),
written by `tools/validation/dataai/oracle_ml.py`. Second witness:
`test-data/dataai/pins/ml_pins.json`, 276 pins written by
`tools/validation/dataai/pin_ml.py` (numpy, scipy, scikit-learn 1.9.1,
statsmodels 0.15 from `/root/daienv`; exact versions in the pin file).
Gate: `__tests__/dataai.ml.test.js` (614 tests) calls the engine on every
golden, every certified figure and every pin, plus property tests.
Negative control: `tools/validation/dataai/negcontrol_ml.sh`, 41/41 engine
plants red, 5 oracle plants red or stopped. For scale and the Newton solve,
see "Scale and the Newton solve (lead review, 2026-09-24)" below. Regeneration of the golden and
the pins is byte-identical (sha256 checked twice each).

The oracle is STDLIB ONLY (python 3.12: `fractions`, `decimal` at 60
digits, `math`, `random` for synthetic inputs, `re`, `json`). It reads no
JavaScript and takes a different road on every route (the table is in its
docstring): OLS by EXACT rational normal equations, where the engine uses
Householder QR; ridge by Decimal normal equations, where the engine uses
QR of the augmented matrix; logistic by Newton in 60-digit Decimal run to
a gradient below 1e-40; condition numbers by Jacobi eigenvalues of the
Gram matrix in Decimal, where the engine uses one-sided Jacobi on R;
mulberry32 in 32-bit integers with the draw floor(u (i + 1)) as the exact
integer (k (i + 1)) >> 32; AUC by the Mann-Whitney pair count in
Fractions, where the engine sweeps thresholds; separation by exact
certificates, where the engine solves the dual linear programmes; and the scale-aware
Newton solve by exact LDL' pivots in Fractions.

## Sources, and which goldens are published

NIST/ITL Statistical Reference Datasets, Linear Least Squares Regression
(itl.nist.gov/div898/strd/lls/lls.shtml), read 2026-09-24. The eleven
`.dat` files are committed unchanged under `test-data/dataai/nist-strd/`
and the oracle parses the certified values and the data from them.
Licence: NIST StRD data are works of the U.S. Government (public domain in
the United States, 17 U.S.C. 105); Longley's data are from Longley (1967),
JASA 62, 819-841, as NIST distributes them. Published reference values
with citation are allowed as goldens (brief rule 13).

| file | sha256 (first 12) | model | NIST difficulty |
|---|---|---|---|
| Norris.dat | 5ab6906c68a9 | y = B0 + B1 x | lower |
| Pontius.dat | de60baa5dc66 | quadratic | lower |
| NoInt1.dat | d8234c428ded | y = B1 x, no intercept | average |
| NoInt2.dat | a71c2810b1ed | y = B1 x, no intercept | average |
| Filip.dat | 403b34689e40 | degree 10 polynomial | higher |
| Longley.dat | fc4b0c824f8f | 6 predictors | higher |
| Wampler1-5.dat | 8bcd6f00dbe8, 01ba5f08b5b9, c5b025f6ebf0, dcff32075a52, c4e260a6638d | degree 5 polynomial | higher |

Before any golden is written the oracle solves each problem EXACTLY on the
decimal data as printed and requires every certified figure (coefficients,
their standard deviations, residual SD, R-squared) to 13 significant
digits; it reached 14.35 to 16 (`nistOracleDigits` in the golden). A
failure stops the oracle.

Polynomial designs are built as the correctly rounded float of the exact
x^k, the design any float64 program sees. The oracle's exact solve on that
FLOAT design shows how many certified digits float inputs allow
(`nistFloatDesignDigits`).

## NIST digits achieved (LRE = -log10 relative error; absolute where certified 0)

| dataset | scaled kappa | engine coef | engine SE | engine resid SD | engine R^2 | float-design limit (coef) | gate floor coef/SE/rsd/R^2 | statsmodels qr coef | numpy lstsq coef |
|---|---|---|---|---|---|---|---|---|---|
| Norris | 2.8 | 14.06 | 13.94 | 14.03 | 15.48 | 14.07 | 14/13/14/15 | 11.9 | 12.4 |
| Pontius | 18.4 | 13.51 | 13.83 | 13.78 | 15.95 | 13.51 | 13/13/13/15 | 12.3 | 6.3 |
| NoInt1 | 1 | 14.72 | 15.38 | 15.43 | 15.65 | 14.74 | 14/15/15/15 | 14.8 | 14.7 |
| NoInt2 | 1 | 15.34 | 14.88 | 15.22 | 15.95 | 15.43 | 15/14/15/15 | 15.1 | 15.1 |
| Longley | 4.3e4 | 14.62 | 12.92 | 15.25 | 15.48 | 14.62 | 14/12/15/15 | 10.9 | 10.8 |
| Wampler1 | 2220 | 16 | 16 (0 exactly) | 16 (0 exactly) | 16 | 16 | 15/15/15/15 | 10.2 | 9.6 |
| Wampler2 | 2220 | 13.20 | 14.90 | 14.91 | 16 | 13.20 | 13/14/14/15 | 13.2 | 10.6 |
| Wampler3 | 2220 | 16 | 13.38 | 14.81 | 15.95 | 16 | 15/13/14/15 | 9.4 | 9.1 |
| Wampler4 | 2220 | 16 | 13.38 | 14.83 | 15.94 | 16 | 15/13/14/15 | 7.6 | 7.6 |
| Wampler5 | 2220 | 16 | 13.39 | 14.80 | 13.73 | 16 | 15/13/14/13 | 5.6 | 5.6 |
| Filip (forced, maxCondition 1e10) | 5.2e9 | 7.97 | 7.56 | 8.15 | 10.33 | 7.66 | 7/7/8/10 | 7.9 | 0 (rank deficient) |

Filip is REFUSED at the default maxCondition 1e8 (`nist-filip-refused`);
the forced row is `nist-filip-forced`. Every engine coefficient reaches
the float-design limit, the digits the float64 inputs themselves carry.
Filip's certified values cannot be reached from float64 data by any method
(7.66 digits for the exact solve on the rounded design), so its 8 digits
are an input limit, not an arithmetic one. Wampler5's first engine draft
(plain QR) reached only 5.9 digits, the same as statsmodels and numpy;
decision 6 is what brought it to 16. Wampler5's R^2 of 13.73 digits is
cancellation in 1 - RSS/TSS for R^2 = 0.0022 (an absolute error near 1e-16
in a small number); left as is.

The gate floors are the floor of what the engine achieved on 2026-09-24,
set as a regression guard (a numerical regression turns them red; the "no
iterative refinement" plant does). They are not a claim the oracle makes;
the oracle's claim is the exact-solve table above.

## Agreement achieved

Engine against the stdlib oracle, worst relative error over all goldens
(absolute floor 1e-12):

| function | worst relative error | gate tolerance |
|---|---|---|
| applyScaler, fitStandardScaler, fitMinMaxScaler | 0 above the floor | 1e-10 |
| groupSplit, groupKFold, randomRowSplit | exact (integers) | 0 |
| ols (well data, Longley bracket cases) | 1.8e-11 | 1e-10 (1e-9 Longley) |
| ols (NIST) | 5.4e-6 (Filip forced; kappa_s^2 eps is about 3e3) | per dataset, 1e-12 to 1e-4 |
| ridge | 8.6e-15 | 1e-10 (1e-8 Longley) |
| logistic | 0 above the floor | 1e-9 |
| predict, regressionMetrics, confusionMatrix, classificationReport, rocCurve, logLoss | 0 above the floor | 1e-12 to 1e-10 |
| permutationImportance, learningCurve, leakageDemo | 0 above the floor | 1e-9 |
| solveSPD | 0 above the floor (exact Fractions) | 1e-12 |

Library witness against the oracle, worst relative disagreement (printed
by `pin_ml.py`): scalers 6.3e-16, ridge (sklearn Ridge on StandardScaler)
6.1e-14, logistic (statsmodels Logit, sklearn LogisticRegression
newton-cholesky) 1.7e-10, metrics and ROC 1.4e-15, learning curve 4.9e-14,
leakage demo 3.4e-15, OLS 7.0e-3 (statsmodels on Filip; 1e-7 on Longley's
standard errors). Each pin's tolerance is 10 x the library's own error,
rounded up to a power of ten and at least 1e-10, so a pin is only as tight
as its witness. Three library results were NOT pinned: statsmodels gives
NaN standard errors on Filip, and on Wampler2 (an exact fit) its residual
SD and standard errors are 3.6x the exact value (rounding noise), so it
cannot witness them there.

No library shares mulberry32, so the splits and the permutation importance
have ONE witness (the oracle's integer mulberry32); the learning curve and
leakage demo pins refit with the libraries on the oracle's split indices.

## Decisions (conventions the oracle cannot check)

1. **Scaling is fitted on training rows only**, by construction: the fit
   sees the rows passed or those `trainIndices` picks, and returns the
   parameters; `applyScaler` applies them unchanged. Standardisation uses
   the POPULATION SD (n), as scikit-learn StandardScaler, so the ridge
   alpha mapping is exact; the sample SD is an option. A feature is
   refused as constant only when every training value is IDENTICAL (exact
   equality), refused by name (`X.<name>`), and it can be refused on the
   training rows while it varies over all rows
   (`scaler-zero-variance-on-train-rows`). Min-max does not clip new rows.
2. **Seeded shuffles**: one `lib/stats` mulberry32 stream per call;
   Fisher-Yates from the end with j = floor(u (i + 1)). No Math.random in
   the engine (a gate test reads the source).
3. **Group order**: ids are all strings (sorted by UTF-16 code unit) or
   all numbers (ascending); mixed types are refused. The sorted list is
   shuffled, the first nTest are the test set, and `order` returns the
   whole shuffled list (the learning curve reads its training part).
4. **Test size** is ceil(fraction x count), with a float product within
   1e-9 of a whole number taken as that number. This matters: 0.28 x 25 is
   7.000000000000001 in float, and a plain ceil holds out 8. (My draft
   named 0.3 x 10 as the example; in float it is exactly 3. A search over
   fractions 0.01 to 0.99 and counts 2 to 40 found only 0.28 x 25 and
   0.56 x 25 off a whole number; the first is now a golden for both
   groupSplit and randomRowSplit.) A fraction that leaves nothing to train
   is refused with the ceil arithmetic printed.
5. **Group k-fold** deals the shuffled groups round robin (position q to
   fold q mod k), so fold sizes differ by at most one group. It balances
   GROUPS, not rows (scikit-learn GroupKFold balances rows greedily and is
   not seeded); stated in the basis.
6. **OLS numerics.** Householder QR on the design with unit-length
   columns, then TWO steps of iterative refinement by corrected
   semi-normal equations (Bjorck): the residual y - X beta and the
   gradient X'r are carried in double-double (Dekker TwoProduct with the
   Veltkamp split, Knuth TwoSum), and the correction solves
   R'R dz = D^-1 X'r with the same R. Three drafts were measured: plain QR
   (Wampler5 5.9 digits, Longley 11.4), a plain same-precision refinement
   step (no gain on large-residual problems), then the double-double
   residual AND gradient, which reached the float-design limit
   everywhere. The gradient must use the original X, not the rounded
   scaled copy (a plant proves it). RSS is the sum of squares of that
   refined residual, so Wampler1's exact fit gives a residual SD of
   exactly 0, as certified.
7. **Refusal on conditioning**: a scaled (Belsley, unit-column) condition
   number above maxCondition = 1e8 is refused; at the limit it is fitted.
   The reason: at kappa = 1e8, kappa^2 x 2.2e-16 is about 2, the classical
   worst-case bound for a least squares solution, so no digit can be
   guaranteed for some coefficient. The refusal prints the number and
   says what to do; `maxCondition` can be raised knowingly (Filip then
   fits to 8 digits, its input limit). A constant feature or an exact
   collinear pair is refused by this rule; an all-zero column is refused
   by name. Both condition numbers are reported: the raw one
   (`numpy.linalg.cond` of the design, pinned) and the scaled one. The
   Longley brackets (`ols-longley-below-limit` at 43000,
   `ols-longley-limit-44000`) pin the rule on either side of its 43275.
8. **R-squared**: centred with an intercept, uncentred without (NIST
   NoInt1/2 certify the uncentred value); adjusted R^2 uses n - 1 with an
   intercept and n without (statsmodels). A constant y (or all-zero y
   without an intercept) is refused rather than reporting 0/0. t values
   are not compared for the exact fits Wampler1/2 (ratios of rounding
   noise).
9. **Ridge**: the intercept is not penalised (y is centred; b0 is the
   training mean of y in standardised space); lambda multiplies the sum of
   squares, so lambda = scikit-learn Ridge alpha on StandardScaler
   features (pinned). Coefficients are returned in standardised and
   original units, plus effective degrees of freedom sum d^2/(d^2 +
   lambda). lambda = 0 is OLS (property test); ridge with lambda > 0 fits
   collinear or wide designs that OLS refuses (`ridge-lambda1-collinear`,
   `ridge-more-features-than-rows`).
10. **Logistic**: Newton-Raphson from beta = 0 (the Newton system solved
    by `solveSPD`, see the scale section), intercept unpenalised
    under the optional L2 (l2/2) sum beta_j^2 (scikit-learn C = 1/l2).
    Converged when the largest component of the FULL Newton step is at
    most tol = 1e-10; at most maxIter = 100 updates, then
    `converged: false` with a warning quoting the last step. A step that
    lowers the penalised log likelihood by more than 1e-12 x (1 + |l|) is
    halved (up to 30 times). Standard errors are sqrt(diag) of the inverse
    information at the solution (plus l2 on the penalised diagonal when
    l2 > 0). The iteration count is a golden: the oracle refuses to write
    a case where any Newton step lies within a factor 100 of tol (it
    caught one; `logistic-no-intercept` runs at tol 1e-12 for that
    reason).
11. **Separation** is decided BEFORE iterating, on S (the design with
    row i multiplied by s_i = +1 for y = 1 and -1 for y = 0, and every
    column divided by its largest absolute value). Two DUAL linear
    programmes decide it (lib/lp):
    - Gordan's LP, S'w = 0, sum w = 1, w >= 0, runs first. Infeasible
      means COMPLETE separation (some beta has S beta > 0).
    - Stiemke's LP, S'w = 0, w >= 1, runs only when Gordan's is feasible.
      Infeasible means QUASI-COMPLETE separation (some beta has
      S beta >= 0 and S beta != 0); feasible means no separation.

    Each pair of alternatives is a theorem, so the rule is exact.
    "Infeasible" means lib/lp's phase one leaves an artificial sum above
    1e-7. With l2 = 0 both kinds are refused on `y`, the message stating
    the exact condition; with l2 > 0 the fit proceeds and `separation`
    reports it. The oracle proves each separated golden with an exact
    certificate (a separating beta; for quasi-complete, a Gordan
    certificate that no strict separator exists), and each fitted golden
    by reaching a finite stationary point. The first version solved the
    PRIMAL LPs, whose tableau has n rows; see the scale section.
12. **Classification**: labels sorted (numbers ascending, strings by code
    unit) unless given; the confusion matrix is rows TRUE, columns
    PREDICTED (scikit-learn). F1 = 2TP/(2TP + FP + FN), equal to the
    harmonic mean wherever that is defined; a zero denominator scores
    `zeroDivision` (0 or 1, as scikit-learn `zero_division`) and is listed
    in `undefinedRatios`. A label that is neither true nor predicted still
    counts in the macro mean (weighted gives it weight 0). A logistic
    probability above 0.5 is class 1; exactly 0.5 is class 0
    (scikit-learn decision_function > 0).
13. **ROC**: positive label 1; one point per DISTINCT score, so tied rows
    move together (a diagonal step); AUC by trapezoids, which equals the
    Mann-Whitney probability with ties counted one half (the oracle's
    road). The start point carries threshold null (scikit-learn prints
    infinity; JSON cannot). scikit-learn roc_curve with
    drop_intermediate = False gives the same points (pinned).
14. **Log loss**: natural log, probabilities clipped to [eps, 1 - eps]
    with eps = 1e-15 formed in float; `clipped` counts the clipped rows.
    scikit-learn 1.9 no longer takes eps and clips at the dtype epsilon,
    so the library pin for clipped cases is numpy on the same clip.
15. **Regression metrics**: R^2 about the mean of the TEST targets by
    default (scikit-learn r2_score); `referenceMean` (for example the
    training mean, the out-of-sample convention) is an option and changes
    the answer (`metrics-reference-train-mean`).
16. **Permutation importance**: one mulberry32 stream per call, features
    in column order and repeats inner; row i takes the value from row
    perm[i]; drop = loss of score, positive when the feature matters
    (baseline - permuted for r2, accuracy, auc; permuted - baseline for
    rmse, mae, logLoss); SD over repeats is the population SD; ranking by
    mean drop with ties in column order. A negative drop is possible and
    shown (`perm-ols-rmse`, GR).
17. **Learning curve** sizes are counted in GROUPS: one seeded group split
    fixes the test wells; the model trains on the first m training groups
    of the split's shuffled order.
18. **Leakage demo** runs the same model under `randomRowSplit` and
    `groupSplit` with the same fraction and seed; `optimism` is how much
    better the random-row test score looks. On the constructed leak data
    (five well-level attributes, a large per-well offset, ridge lambda
    0.1) the random-row test R^2 is 0.60 to 0.68 against a group test R^2
    of -2.3 to -36 (optimism 3.0 to 36.9 over three seeds). On the plain
    log data (no well identifiers) the optimism is -0.016 in RMSE: the
    leak needs features that identify the well, and the course should say
    so rather than claim random splits always flatter.
19. **Messages** state exact conditions and print figures as the shortest
    round-trip decimal (the oracle's `js_num`, D1's routine, pins the text
    of every refusal whose figures are exact; the condition-number
    refusals are pinned by prefix, suffix and the figure to 1e-6).

## Scale and the Newton solve (lead review, 2026-09-24)

### Timings (Node v18.19.1, this host; `tools/validation/dataai/timing_ml.mjs`)

Seeded synthetic well data (`synthetic_wells.js`: wells of 500 rows,
features on magnitudes 1, 10 and 100, a per-well offset, an overlapping
label and a completely separated label). Milliseconds per call; one run.

| n | p | ols | ridge | logistic | logistic l2=1 | LP pivots | Newton its | groupKFold k5 | permImp ols r2 x5 | permImp logistic auc x5 | rocCurve | minmax | separated: refusal | separated l2=1 | separated LP pivots |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10,000 | 3 | 156 | 137 | 252 | 180 | 11 | 6 | 7 | 62 | 131 | 13 | 3 | 133 | 168 | 77 |
| 10,000 | 8 | 53 | 160 | 212 | 156 | 55 | 4 | 4 | 48 | 227 | 5 | 5 | 152 | 233 | 175 |
| 50,000 | 3 | 287 | 385 | 301 | 181 | 11 | 6 | 16 | 151 | 836 | 34 | 40 | 228 | 244 | 58 |
| 50,000 | 8 | 306 | 580 | 460 | 485 | 57 | 4 | 13 | 424 | 2334 | 30 | 100 | 1139 | 1261 | 316 |
| 200,000 | 3 | 643 | 964 | 829 | 618 | 11 | 6 | 57 | 1048 | 3543 | 162 | 86 | 1352 | 1591 | 125 |
| 200,000 | 8 | 1072 | 1982 | 2156 | 1449 | 55 | 4 | 57 | 2800 | 10411 | 134 | 159 | 5174 | 5732 | 372 |

Against the target (each single fit under about 2 s at 50k rows): every
fit takes at most 0.6 s at 50k on overlapping labels and at most 1.3 s on
a completely separated label (the heaviest LP path). Permutation
importance at p = 8 and 5 repeats is 40 re-scorings, 58 ms each (2.3 s in
all for AUC, which sorts on every re-scoring). At 200k rows and p = 8 the
separated path takes 5 to 6 s. That is linear in n: the pivot count
barely moves (316 at 50k, 372 at 200k) and each pivot costs O(p n).

What changed to get there. None of the 160 existing golden results
changed (checked case by case against the pre-review golden file):

1. **The separation LP was super-linear and unusable at app sizes.** The
   first version solved the PRIMAL LPs (constraints s_i x_i'beta >= 0,
   one tableau row per sample), a dense tableau of n x ~2n. Measured on
   the old engine at p = 3: 0.30 s at 500 rows, 0.33 s at 1,000, 1.9 s at
   2,000, 8.3 s at 4,000; at 10,000 rows the tableau alone would be about
   1.6 GB. The DUAL LPs of Gordan and Stiemke have p + 1 (or p) rows
   whatever n, and give the same decision by the theorems of the
   alternative (decision 11). A constraint-generation version of the
   primal was tried and rejected: Bland's rule took 1,400 to 2,300 pivots
   on the working sets (1.5 to 5.6 s). Gordan runs first, so a complete
   separation (the common separated case) costs one LP.
2. **Permutation importance** no longer copies every row per repeat: the
   permuted column is read in place, in the same summation order as
   `predict`, so every golden figure is unchanged. About 2x faster.
3. **The logistic condition pre-check** used the full refined least
   squares solve on a zero target; it now takes R from one equilibrated
   QR (about 0.5 s saved at 200k rows).
4. **No spread arguments on columns.** `Math.min(...col)` and
   `Math.max(...col)` throw a RangeError past about 125,000 values in V8.
   Min-max scaling and the separation column scaling now loop.

Guards in the gate are deterministic (pivot counts), with time budgets
about 10x a Node 18 run so they cannot flake:
- at 20,000 rows x 8 features the separation LP takes at most 100 pivots
  on overlapping labels and at most 400 on a complete separation
  (measured 58 and 276);
- logistic, OLS, ridge and permutation importance finish within 20 s;
- 150,000 rows pass through both scalers, group k-fold and ROC.

Negcontrol plants for them: the spread restored (RED at 150,000 rows),
and the Stiemke LP run before Gordan on a complete separation (RED on the
pivot guard).

### The Newton solve: `solveSPD`, a relative pivot rule

The logistic Newton step and the standard errors used lib/linalg
`solveDense`, whose singular test is ABSOLUTE (a pivot below 1e-14). A
feature in small units makes a well-conditioned Hessian small in absolute
terms: rock compressibility in 1/Pa (about 6e-10) gives a Hessian entry
near 1e-18, and the old engine refused `logistic-compressibility-per-pa`
with "X gives a singular Newton system at iteration 1". `solveDense` is
NOT changed (it is shared, and other engines' goldens depend on it).
Instead ml.js now exports its own `solveSPD`:

- Cholesky of the unit-diagonal scaling D^-1/2 A D^-1/2, D = diag(A);
  only the lower triangle is read.
- Rule: singular when a diagonal entry is at or below zero, or a pivot of
  the scaled factorisation is at or below p x machine epsilon
  (p x 2.220446049250313e-16). The rule is relative: rescaling any
  variable never changes the decision. The refusal names the pivot and
  prints both numbers.
- The oracle checks the rule in exact arithmetic: scaled pivot k is
  d_k / A_kk, with d_k the exact LDL' pivot.

New goldens:
- Fitted now: `spd-tiny-entries` (every entry below 1e-14, scaled pivots
  0.83; solveDense says "Singular system."), `spd-tiny-hessian-3x3` (the
  shape of a logistic Hessian with a feature in units of 1e-9; solveDense
  refuses it), `spd-mixed-scales` (diagonal 1e-10 to 1e10, raw condition
  about 1e20, smallest scaled pivot 0.72) and `spd-identity-large`.
- Still refused: `spd-singular-exact` (rank one; the exact message with
  pivot 0), `spd-singular-tiny` (the same rank-one matrix at 1e-20), a
  zero and a negative diagonal, plus shape refusals.
- The fit `logistic-compressibility-per-pa`: 40 rows, CF coefficient
  about 6.8e9, converged in 6 iterations.
- The rank-deficient logistic design is still refused
  (`logistic-collinear`).

Negcontrol plants: the absolute 1e-14 test restored (RED on
`spd-tiny-entries` and the compressibility fit), and the pivot taken on
A's own scale (RED).

**The libraries fail this case.** On `logistic-compressibility-per-pa`,
statsmodels Logit (newton) does not converge: its coefficients are
-4.9e-8 and 84 against the MLE -4.035 and 6.83e9. scikit-learn
LogisticRegression (newton-cholesky, C = inf) stops at -1.41 and 2.42e9.
The pin for this case therefore fits statsmodels on the feature rescaled
to unit maximum and converts the coefficients back; that agrees with the
oracle.

**Stopping rule and units.** The logistic stopping rule is unchanged:
converged when the largest ABSOLUTE component of the full Newton step is
at most tol, in coefficient units. With a feature in 1/Pa the coefficient
is about 1e9, so the golden passes tol = 0.1 (a relative 1e-10). The
default 1e-10 cannot be met there; the fit would end with
`converged: false` and its warning, never silently. A column-scaled rule
was tried and rejected for this PR, because it changed an existing
golden's iteration count (one Newton step of the pay case fell within a
factor 100 of tol). See open question 3.

## Found while building (fixed before the first push)

1. **Step halving on rounding noise faked convergence.** The first
   logistic draft measured convergence on the APPLIED step and halved
   whenever the penalised log likelihood fell at all. On the separated
   sample with l2 = 1 a rounding-level fall triggered 18 halvings, the
   applied step shrank below tol, and the engine stopped with coefficients
   4e-9 from the optimum and `converged: true`. The oracle (Decimal, no
   noise) disagreed. Fix: convergence on the full Newton step (so halving
   can never fake it) and a 1e-12 x (1 + |l|) floor on what counts as a
   fall. Goldens now pin stepHalvings = 0 on every case.
2. **Plain QR is not enough for the Wampler set** (decision 6).
3. **The whole-number rule's float example** was wrong in the draft
   (decision 4); the goldens use the real one.

## Boundary rules, per function

| function | rule | boundary |
|---|---|---|
| fitStandardScaler / fitMinMaxScaler | refuse a constant feature | only when every training value is identical; any difference is fitted |
| groupSplit / randomRowSplit | test size ceil(f x count) | a float product within 1e-9 of a whole number is that number; refused when it leaves nothing to train |
| groupKFold | 2 <= k <= number of groups | k = number of groups is leave-one-group-out, allowed |
| ols / ridge | refuse scaled condition number > maxCondition | exactly at the limit is fitted |
| ols | n > p | n = p is refused (no residual degrees of freedom) |
| logistic | converged when max full step <= tol | inclusive |
| logistic | complete when Gordan's LP is infeasible; quasi-complete when Stiemke's is (after a feasible Gordan) | infeasible = phase-one artificial sum > 1e-7, strict |
| solveSPD (and the Newton step) | singular when a diagonal entry <= 0 or a scaled pivot <= p x 2.220446049250313e-16 | at the threshold is singular (inclusive) |
| logistic | halve when the fall exceeds 1e-12 (1 + abs(l)) | strict |
| predict (logistic) | class 1 when p > 0.5 | 0.5 is class 0 |
| rocCurve | a row is positive at score >= threshold | ties move together |
| logLoss | clip to [eps, 1 - eps] | a probability equal to eps is kept |
| classificationReport | zeroDivision when a denominator is 0 | any non-zero denominator uses the ratio |

## Negative control (2026-09-24)

`tools/validation/dataai/negcontrol_ml.sh`: 41/41 ENGINE plants RED;
baseline and restored runs 614/614 green (re-run after the lead-review
changes). The 41 are the 36 first-round plants, with the three separation
plants retargeted at the dual LPs (complete separation missed,
quasi-complete missed, quasi-complete called complete), plus five new
ones: the absolute 1e-14 pivot test restored; the pivot on A's own scale;
the Math.min spread; the Stiemke LP run first on a complete separation
(pivot guard). First-round plants: scaler fitted on all
rows; sample SD default; min-max over max; a split leaking the first row
of each test well; Fisher-Yates draw floor(u i); contiguous k-fold; no
whole-number rule; OLS SE on RSS/n; uncentred R^2 with an intercept;
adjusted R^2 n - 1 without an intercept; no refinement; residual not in
double-double; gradient from the rounded scaled design; maxCondition 1e10;
raw condition reported as scaled; ridge penalising the intercept; ridge
lambda x n; ridge on the sample SD; effective df on d; logistic stopping
at 1e-6; separation never detected; quasi-complete called complete; L2 on
the intercept; 0.5 as class 1; ROC without tie grouping; AUC by
rectangles; transposed confusion matrix; zeroDivision ignored; weighted
recall by predicted count; log loss eps 1e-7; log10; referenceMean
ignored; permutation drop sign; permutation SD on n - 1; learning curve on
all groups; leakage demo scoring the group split twice. ORACLE plants:
Fisher-Yates floor(u i) RED; OLS SE on RSS/n STOP (the NIST self-check
refused); AUC ties as losses RED; log loss clip at 10 eps RED; ridge
penalised intercept RED.

## What could not be verified

- Splits and permutation importance have one independent witness (the
  oracle); no library reproduces mulberry32 draws.
- The separation decision uses lib/lp's phase-one tolerance (an
  artificial sum above 1e-7 means infeasible). A sample that is separated
  or overlapping only to within that tolerance could be judged
  differently from exact arithmetic; no golden sits near it.
- The timings are one run on one host; the gate's guards are pivot counts
  and generous budgets, not timings.
- The quasi-complete path runs both LPs. No app-sized quasi-complete
  sample was timed; its cost is bounded by the two LP costs measured
  above.

## Open questions for the lead

1. **Resolved (scale).** Timings are above; every single fit is under 2 s
   at 50k rows. Two paths stay over budget at 200k x 8: a separated label
   (5 to 6 s, linear in n) and permutation importance with AUC (10 s,
   40 sorts). If the ML Workbench fits on hundreds of thousands of rows,
   run these off the main thread or subsample for importance.
2. **Resolved for ml.js (pivot rule); still open elsewhere.** ml.js no
   longer calls lib/linalg `solveDense`. The ABSOLUTE 1e-14 pivot test in
   `solveDense` remains an open item for its other callers (quality.js
   Mahalanobis, the petrophysics mineral solver, earth modelling): those
   still refuse a well-conditioned system with small entries. A relative
   test in lib/linalg would move those engines' goldens and needs its own
   PR.
3. **Logistic stopping rule in coefficient units.** Features in very
   small units need a matching tol (the compressibility golden passes
   0.1). A column-scaled stopping rule (step_j x max |x_j|) is the natural
   fix, but it changes existing iteration-count goldens; that is a
   decision for the D2 foundation, not made here.
4. **Default maxCondition 1e8** refuses Filip. If the course wants to show
   "ill-conditioned but fitted", raise it per call and print the digit
   loss; the default should stay conservative.
5. **Population SD** for scaling matches scikit-learn but differs from
   D1's z-scores (sample SD, as NIST defines the z-score). The course
   should say which SD each app uses and why; the D2 basis states it.
