# FINDINGS: cluster (oracle_cluster.py, Data & AI D3, electrofacies)

Golden: `test-data/dataai/goldens/cluster_cases.json`, 145 cases (68 of
them refusals, every refusal message pinned in full), written by
`tools/validation/dataai/oracle_cluster.py`. Second witness:
`test-data/dataai/pins/cluster_pins.json`, 169 pins and 18 recorded skips,
written by `tools/validation/dataai/pin_cluster.py` (numpy, scipy,
scikit-learn 1.9.1 from `/root/daienv`; exact versions in the pin file).
Gate: `__tests__/dataai.cluster.test.js` (349 tests) calls the engine on
every golden, the published figures and every pin, plus property tests and
the row-cap boundaries. Negative control: `negcontrol_cluster.sh`
(52/52 engine plants red, 6/6 oracle plants red and 1 stopped). Timing: `timing_cluster.mjs` (table below). Regenerating the golden and the pins is byte-identical (sha256 checked).

The oracle is STDLIB ONLY (python 3.12: `fractions`, `decimal` at 60
digits, `itertools`, `random` for the synthetic inputs). It reads no
JavaScript and takes a different road on every route (table in its
docstring): PCA eigenvalues by bisection on the inertia of S - xI (the
count of negative LDL' pivots, Sylvester's law) with eigenvectors by
inverse iteration, where the engine uses cyclic Jacobi; agglomerative
merge heights from their DEFINITIONS every step (maximum or mean over
member pairs; Ward from centroids as sqrt(2 na nb / (na + nb) |ca - cb|^2)),
where the engine uses the Lance-Williams recursion with a nearest-neighbour
cache; CART by re-counting every candidate split from the rows in
Fractions, where the engine updates counts incrementally with exact BigInt
tie checks; the adjusted Rand index by counting all C(n, 2) row pairs,
where the engine uses the contingency formula; one-to-one matching by
brute force over every injective map in lexicographic order, where the
engine runs the Hungarian method and a greedy feasibility fix; mulberry32
in 32-bit integers with the k-means++ draw compared exactly.

**Ambiguity guard.** Where a float program could branch differently from
the exact one, the oracle refuses to write the case: a distance or merge
height between 1e-13 and 1e-9 (relative) of the smallest, a k-means++ draw
within 1e-9 of a boundary, two k-means runs whose inertias sit in that
band, a sign-rule loading near its band, eigenvalues within 1e-6 of each
other. Iris seed 1 (raw units, nInit 10) tripped it, so that case uses
seed 3 (seeds 3, 5, 6, 7 and 13 are clean).

## Sources and published values

Fisher, R. A. (1936). The use of multiple measurements in taxonomic
problems. Annals of Eugenics 7(2), 179-188. The 150 x 4 measurements are
committed at `test-data/dataai/iris/iris.csv` (sha256 f13ffa8fdd56...,
copied from scikit-learn 1.9.1 `sklearn/datasets/data/iris.csv`). That copy
carries Fisher's values for samples 35 (4.9, 3.1, 1.5, 0.2) and 38 (4.9,
3.6, 1.4, 0.1); the UCI Machine Learning Repository copy has errors in both
(its own note says so), and the oracle and a gate test assert the Fisher
values. Licence: measurements published in 1936 are facts in a public
domain publication; scikit-learn distributes the file under BSD-3.

Published figure: the covariance-PCA explained variance ratio of the first
two components, printed as `[0.92461872 0.05306648]` by the scikit-learn
example "Comparison of LDA and PCA 2D projection of Iris dataset"
(scikit-learn.org/stable/auto_examples/decomposition/plot_pca_vs_lda.html,
read 2026-09-24). The oracle asserts its exact value rounds to it before
writing; the engine is held to the same 8 decimals
(`pca-iris-covariance`, `published`).

Other iris figures the goldens reproduce (well known, not claimed as
published anchors): raw-unit k = 3 k-means inertia 78.851441426146 with
sizes 62/50/38, its silhouette 0.552819, its ARI against species 0.730238;
correlation-PCA eigenvalues 2.918498, 0.914030, 0.146757, 0.020715.

Ekene synthetic facies (ours): `ekene_facies()` in the oracle, six wells
EKENE-1..6 of 30 rows, four facies (sandstone, shaly sand, shale,
limestone) in blocky runs, GR / RHOB / NPHI / PEF drawn per facies and
rounded as logged. The JS twin for scale runs is `syntheticFacies` in
`synthetic_wells.js`.

## Agreement achieved

Engine against the stdlib oracle: every golden passes at its stated
tolerance (1e-10 relative with a 1e-12 absolute floor for most; 1e-9 for
the agglomerative heights and the elbow; 1e-12 for CART and ARI; labels,
indices, counts and messages exactly).

Library witness against the oracle, worst relative disagreement where the
conventions agree (printed by `pin_cluster.py`): PCA 2.2e-11 (scores after
the sqrt((n - 1)/n) mapping), pcaTransform 2.7e-13, k-means 1.3e-13
(labels, centres, inertia and n_iter_ where the stop rules agree),
silhouette 6.1e-14, agglomerative 1.5e-15 (scipy linkage matrices,
cut_tree and sklearn partitions), CART, kNN, ARI and the matching optimum
exactly.

The 18 skips, each a documented convention difference:

| case | library | why it differs |
|---|---|---|
| kmeans-empty-cluster-relocated, kmeans-distinct-equals-k (n_iter_) | KMeans | scikit-learn also stops when the centres do not move (shift <= tol = 0) and relocates empties without touching the labels; the engine counts the confirming assignment pass. Labels, centres and inertia agree (pinned). |
| agglomerative-iris-complete-k3 (heights) | scipy linkage | standardised iris has tied merges (duplicate rows, equal distances); scipy's nearest-neighbour chain resolves them differently, and complete linkage then builds a different tree. The engine's lowest-ids rule is the stated convention. |
| knn-vote-tie-nearest-b, knn-equidistant-lower-row | KNeighborsClassifier | a tied vote: the engine gives it to the label whose nearest member comes first; scikit-learn to the label that sorts first. |
| cart-iris-depth3, cart-iris-depth5-leaf5 (importances, thresholds) | DecisionTreeClassifier | the iris root has an exact tie: petal_length <= 2.45 and petal_width <= 0.8 both isolate setosa. The engine takes the lower feature index (petal_length); scikit-learn permutes features with random_state and took petal_width. Predictions agree (pinned). |
| cart-ekene-depth4-leaf3, cart-ekene-min-split-40 (importances, thresholds) | DecisionTreeClassifier | the same kind of root tie (limestone is isolated exactly by NPHI and by PEF); the engine takes NPHI, scikit-learn PEF. Same partition, same predictions (pinned). `cart-ekene-gr-rhob-depth3` has no tie and its thresholds are pinned. |
| cart-iris-depth0 | DecisionTreeClassifier | scikit-learn refuses max_depth = 0; the engine allows it (a single leaf). |
| cart-xor-no-split (4 fields) | DecisionTreeClassifier | scikit-learn accepts a split with zero impurity decrease; the engine requires a decrease above zero, so XOR stays one leaf. |

## Decisions (conventions the oracle cannot check)

1. **Scaling is imported from ml.js** (fitStandardScaler, fitMinMaxScaler,
   applyScaler), default `scale: 'standard'` (population SD, a constant
   log refused by name with ml.js's message, the fitted rows named by the
   scaler's `rowNoun`: "rows passed" for pca, kmeans, silhouette, elbow and
   agglomerative, "training rows" for kNN; see "Foundation findings
   repaired" below). Clustering fits the scaler on
   the rows clustered; kNN on the TRAINING rows only and applies it
   unchanged to the new rows. The same option applies in the silhouette so
   it scores the space k-means clustered. Input checks are cluster.js's
   own (ml.js does not export checkMatrix) with ml.js's wording.
2. **PCA** defaults to the correlation matrix (logs are in different
   units: on the Ekene logs the covariance form gives GR almost all the
   variance, `pca-ekene-covariance`). Correlation standardises with the
   SAMPLE SD so score variances equal eigenvalues and the eigenvalues sum
   to p; covariance uses divisor n - 1 (scikit-learn explained_variance_).
   `loadings` = component x sqrt(eigenvalue) (in the correlation form, the
   feature-score correlation); `components` are the unit eigenvectors.
3. **Jacobi convergence**: cyclic sweeps; an off-diagonal entry at or
   below 2^-52 sqrt(|a_pp a_qq|) is zeroed; stop after the first sweep
   needing no rotation, at most `maxSweeps` (default 50; the default is
   never reached in any golden, `maxSweeps: 1` makes it reachable).
   Eigenvalues sorted descending, equal values keep column order; a
   rounding value below zero is reported as 0. Neighbouring eigenvalues
   (in sorted order) that differ by at most 1e-10 times the largest,
   |lambda_k - lambda_k+1| <= 1e-10 x lambda_1 (inclusive), are flagged
   with a warning (directions not unique). When
   both warnings apply both are kept: non-convergence first, then the
   repeated eigenvalues, joined by '; '.
4. **Sign convention**: in each component the first loading whose absolute
   value is within 1e-9 (relative) of the largest is made positive. This
   is scikit-learn's rule (largest absolute loading positive) made robust
   to exact ties: with two standardised features both loadings are
   1/sqrt(2) and float noise would otherwise flip the sign
   (`pca-two-features-sign-tie`).
5. **k-means++** is Arthur and Vassilvitskii's one candidate per step
   (scikit-learn's default greedy k-means++ tries 2 + log k candidates, so
   its seeding cannot be matched; the pins give scikit-learn the oracle's
   starting centres instead). First centre row floor(u n); each later
   centre is the first row whose running sum of D^2 exceeds u x sum D^2.
   Fewer distinct (scaled) rows than k is refused. nInit (default 10) runs
   draw in turn from ONE mulberry32(seed) stream; the lowest inertia wins.
6. **Banded ties.** Decimal log values are not exact in binary, so two
   distances equal on paper differ in the last bits. Every distance tie is
   therefore judged in a relative band of 1e-12: k-means assignment (lower
   centre index), kNN neighbour order (lowest row among those within the
   band of the smallest remaining), merge heights (lowest cluster ids),
   and the best of nInit runs (earlier run). The first draft used exact
   equality for k-means and kNN; the oracle's guard refused iris cases
   because rounding, not the stated rule, would have decided them.
7. **Empty cluster**: takes the row farthest from its current centre,
   ties to the lower row, among clusters with at least 2 rows (so no donor
   empties), as scikit-learn relocates (`kmeans-empty-cluster-relocated`).
8. **Convergence**: converged when an assignment pass returns the labels
   of the pass before; `iterations` counts assignment passes (scikit-learn
   n_iter_ when the stop is by labels). maxIter reached gives `converged:
   false`, a warning, and labels from one more pass against the last
   centres (as scikit-learn).
9. **Elbow**: each k runs `kmeans` with its own mulberry32(seed), so a
   row equals the single call (property test). No elbow is picked
   automatically; `bestSilhouetteK` (ties to the smaller k) when asked;
   inertia rising with k is flagged (a local minimum; raise nInit).
10. **Silhouette**: Euclidean; a singleton scores 0 and a = b = 0 scores 0
    (scikit-learn); 2 to n - 1 clusters. Above 10,000 rows it needs a
    seeded `sampleSize` (Fisher-Yates from the end, as ml.js; the sample
    scored among itself, as scikit-learn sample_size).
11. **Agglomerative**: Lance-Williams on Euclidean heights, scipy
    semantics (Ward's height is sqrt(2 x the rise in within-cluster sum of
    squares)); linkage matrix rows [smaller id, larger id, height, size]
    with scipy ids; ties as decision 6; cut labels numbered by first row;
    `cutTree` re-cuts a returned matrix. Capped at 3,000 rows (the
    condensed distance matrix is 36 MB and a run about 1 s there).
12. **kNN**: uniform weights; ties as decision 6; a tied vote goes to the
    tied label whose nearest member comes first (it degrades toward 1-NN,
    which a learner can check by hand; scikit-learn takes the label that
    sorts first). Refused above 1e8 training x new distance pairs
    (10,000 x 10,000 runs in about 1.7 s).
13. **CART**: Gini, midpoint thresholds a/2 + b/2 (a when that rounds to b,
    as scikit-learn), x <= threshold left; splits compared EXACTLY on the
    integer class counts (the score (S_L n_R + S_R n_L)/(n_L n_R) in
    BigInt when two floats are within 1e-9), ties to the lower feature
    then lower threshold; a split needs a decrease above zero; maxDepth
    default 5 (root depth 0, maxDepth 0 allowed); a leaf's majority tie to
    the class that sorts first; importances as scikit-learn; nodes in
    scikit-learn's depth-first order; a printed tree in export_text style
    with thresholds as the shortest round-trip decimal (so
    `NPHI <= 0.14300000000000002` prints the true float, not a rounded
    figure that would not reproduce the split).
14. **Matching**: one-to-one refuses more clusters than facies (it would
    leave clusters unmatched, and the ml.js report takes predictions only
    from the facies labels); majority allows it. Among equal one-to-one
    totals, the lexicographically first mapping in cluster order. Metrics
    by ml.js classificationReport (imported). ARI is independent of the
    mapping; 1 when both labelings are trivial the same way.
15. **Messages** state exact conditions; figures print as shortest
    round-trip (the oracle writes every refusal message in full).

## Boundary table (per rule)

| rule | accepted at the boundary | refused | golden / test |
|---|---|---|---|
| pca rows | n = 2 | n = 1 | pca-one-row |
| pca nComponents | 1 and p | 0, p + 1 | pca-ncomp-0, pca-ncomp-5-of-4 |
| kmeans k | 1 and n | 0, n + 1 | kmeans-ekene-k1, kmeans-k0, kmeans-k-above-n |
| kmeans distinct rows | distinct = k | distinct < k (on the scaled rows) | kmeans-distinct-equals-k, kmeans-few-distinct(-scaled) |
| silhouette clusters | 2 and n - 1 | 1, n | silhouette-n-minus-1-clusters, silhouette-one-cluster, silhouette-n-clusters |
| silhouette rows | 10,000 in full | 10,001 without sampleSize | jest row-cap test |
| silhouette sampleSize | 2 to min(n, 10,000) | above | silhouette-sample-too-big |
| agglomerative rows | 3,000 | 3,001 | jest row-cap test |
| agglomerative / cutTree k | 1 and n | 0, n + 1 | cut-tree-grid-k1/k6, agglomerative-k-above-n, cut-tree-k0 |
| kNN k | 1 and n train | n train + 1 | knn-ekene-wells-k1, knn-k-above-n |
| kNN pairs | 1e8 (10,000 x 10,000) | 100,010,000 | jest row-cap test |
| CART maxDepth | 0 | -1 | cart-iris-depth0, cart-maxdepth-negative |
| CART minSamplesLeaf / minSamplesSplit | 1 / 2 | 0 / 1 | cart-min-leaf-0, cart-min-split-1 |
| CART split | decrease > 0 | decrease = 0 (leaf) | cart-xor-no-split |
| matching one-to-one | clusters = facies | clusters > facies | match-perfect, match-more-clusters-than-facies |
| tie bands (distance, merge, run) | within 1e-12 relative, inclusive | beyond | kmeans-assignment-tie-lower-centre, agglomerative-grid-ties-*, knn-equidistant-lower-row |
| sign rule | within 1e-9 of the largest, inclusive | | pca-two-features-sign-tie |
| pca repeated eigenvalues | \|lambda_k - lambda_k+1\| <= 1e-10 x lambda_1, inclusive (flagged) | above (not flagged) | pca-warning-repeated-only, pca-warning-both (exact repeats); no golden sits on the edge itself: a difference of two doubles near lambda_1 is a whole number of ulps while 1e-10 x lambda_1 rounds to a full 53-bit mantissa, and a search of 4,001 neighbouring inputs found no exact hit |

## Salvage review: Suite src/utils/logFaciesCalculations.js

Rebuilt, not vendored. What the old code gets wrong (none of it survives):

1. k-means starts from the FIRST k rows (no k-means++, no seed, no nInit),
   and an empty cluster is re-seeded with `Math.random()`: results are not
   reproducible and depend on row order.
2. When a dataset has fewer rows than k it silently returns every row in
   cluster 0 with SSE 0.
3. Normalisation silently maps a constant log to 0 (z-score and min-max),
   hiding a dead curve; min/max use `Math.min(...spread)`, which throws
   RangeError past about 125,000 rows.
4. "Supervised" facies runs 1-nearest-neighbour "as a proxy for Random
   Forest": the method named to the user is not the method run.
5. Training and prediction rows are normalised with their OWN statistics
   (the scaler is refitted on the prediction set), so one depth sample gets
   different features in training and prediction; the validation set is
   normalised a third time. The engine fits on training rows only (plant
   "kNN new rows scaled with their own scaler" proves the gate sees it).
6. Validation silently drops rows whose facies was not in training and
   reports only accuracy; no per-class metrics.
7. Hierarchical clustering is average linkage by an O(n^3) per-merge scan
   with no row cap, ties broken by scan order, and cluster ids renumbered
   by splice order.
8. The SOM uses `Math.random()` for weights and samples and folds map
   nodes into k clusters with `bmu % k`, merging unrelated nodes; the
   facies summary then iterates 0..(distinct count - 1), dropping clusters
   whose ids are not contiguous.
9. Result rows are shallow copies whose objects are mutated
   (`logDataWithFacies[...].FACIES = ...` writes into the input data).
10. The elbow plot reruns the first-k-rows k-means per k, so its curve can
    rise with k with no warning.

The SOM is not rebuilt (out of the D3 scope); the Suite app should not
offer it until it has a seeded, validated engine.

## Timings (Node v18.19.1, this host; `timing_cluster.mjs`)

Synthetic facies logs, four features. Milliseconds, one run.

| n | pca | kmeans k5 nInit1 | kmeans k5 nInit10 | passes | elbow k1-8 nInit1 | silhouette (sample 5,000) | CART depth 6 | CART depth 10 | kNN k5, 1,000 new | match |
|---|---|---|---|---|---|---|---|---|---|---|
| 10,000 | 90 | 267 | 466 | 21 | 370 | 166 | 164 | 231 | 246 | 10 |
| 50,000 | 117 | 260 | 1640 | 53 | 2424 | 182 | 255 | 238 | 1168 | 17 |

| rows | Ward | complete | average | silhouette in full |
|---|---|---|---|---|
| 1,000 | 81 | 135 | 110 | 9 |
| 2,000 | 396 | 343 | 343 | 23 |
| 3,000 (cap) | 1031 | 1032 | 1028 | 42 |

Silhouette in full at 10,000 rows (its cap): 449 ms. kNN 10,000 x 10,000
(its cap): 1,659 ms. Against the target (< 2 s at 50k for k-means and
CART): k-means with the default nInit 10 takes 1.6 s, CART 0.26 s. The
elbow over eight k at 50k takes 2.4 s with nInit 1; the app should run it
on a sample or show progress.

## Foundation findings repaired (2026-09-24)

Found by the D3 course foundation; branch
`fix/dataai-cluster-foundation-findings`.

**E1: constant-feature refusals named training rows where nothing is
trained.** The refusal came from ml.js's scaler and read "X.CALI has zero
variance on the 30 training rows ...". Clustering and PCA have no training
rows. The smaller clean change was an option on the scaler (a cluster.js
wrapper would have had to repeat the constant check or rewrite ml.js's
text): `fitStandardScaler` and `fitMinMaxScaler` take `rowNoun`,
`'training rows'` (default) or `'rows passed'` (anything else refused:
"rowNoun must be 'training rows' or 'rows passed'"). Every ml.js caller
keeps the default, so ml.js's own messages and its goldens and pins are
byte-identical (ml_cases.json and ml_pins.json untouched; ml jest green).
Which function says what:

| function | rows named | message (standard scaler; min-max says "zero range" and "min-max scaling") |
|---|---|---|
| pca (correlation) | rows passed | X.CALI has zero variance on the 30 rows passed (every value is 8.5): standardising would divide by zero, so drop the feature or fit on rows where it varies |
| pca (covariance) | none | no scaler: a constant column is kept and adds a zero eigenvalue (`pca-ekene-constant-cali-covariance`) |
| kmeans, silhouette, agglomerative | rows passed | X.RHOB has zero variance on the 3 rows passed (every value is 2.3): ... |
| elbow | rows passed | through its first kmeans run, same text |
| knnClassify | training rows | X.RHOB has zero variance on the 3 training rows (every value is 2.3): ... (kNN fits its scaler on the labelled training rows, so the noun is exact) |
| any, `scale: 'none'` | none | no scaler, no refusal (`kmeans-constant-log-none`) |

**PCA warnings overwrote each other.** A Jacobi non-convergence warning
replaced a repeated-eigenvalue warning. Both are now kept in `warning`,
non-convergence first (it qualifies every figure, the repeated test
included), joined by "; ". To make non-convergence reachable, `pca` takes
`maxSweeps` (default 50, "maxSweeps must be a whole number, 1 or more").
The non-convergence text now states the count exactly and the plural:
"Jacobi did not converge in 1 sweep (the last sweep still rotated): the
eigenvalues and components shown are those after sweep 1". Goldens: a
correlation matrix of two 2 x 2 blocks built from orthogonal +-1 (Hadamard)
columns has eigenvalues 1 + 1/sqrt 2 and 1 - 1/sqrt 2, each twice, and
exact zeros across the blocks; the oracle computes them in Fractions (one
square root in Decimal) and derives the sweep facts from the stated rule
(sweep 1 rotates each block to diagonal and leaves the exact zeros at zero,
so sweep 2 needs no rotation): `pca-warning-repeated-only` (default,
converged at sweep 2, repeated warning alone), `pca-warning-both`
(`maxSweeps: 1`), `pca-warning-nonconverged-only` (one block, distinct
eigenvalues, `maxSweeps: 1`).

**cutTree accepted a hand-built linkage matrix that reused an id.** It
now refuses the first reuse: "linkageMatrix[2] merges id 4, which
linkageMatrix[1] already merged: each row id (0 to 3) and each cluster id
(4 to 5) may be merged once only" (`cut-tree-reuse-row-id`,
`cut-tree-reuse-cluster-id`). The ids are checked in row order, id1 before
id2. A matrix from `agglomerative` never reuses an id (the oracle asserts
it on the grid tree).

**Nothing else changed.** Proof: every one of the 145 golden cases was
run through the origin/main engine (4dfbb29) and this branch's engine and
the whole outputs compared. 129 identical; 10 differ in the refusal text
alone (the constant-feature cases, old wording "training rows"); 6 differ
because the old engine had no such input (4 `maxSweeps` cases it ignored,
2 id-reuse matrices it accepted). No label, centre, eigenvalue, flag, basis
or number of any other case differs. The oracle diff agrees: of the 126
previous cases, 124 are byte-identical and 2 differ in `message` only;
19 cases added. The pins: all 158 previous pins identical, 11 added, the
18 skips unchanged. Oracle and pins regenerate byte-identically
(`OMP_NUM_THREADS=1` for the pins).

**The repeated-eigenvalue warning now states the exact test** (lead's
follow-up, same PR). It said "are equal to within 1e-10 of the largest";
the test is |lambda_k - lambda_k+1| <= 1e-10 x lambda_1 (inclusive, as the
code's `<=`). It now reads "eigenvalues 1 and 2, 3 and 4 differ by at most
1e-10 times the largest eigenvalue, so the directions of those components
are not unique: the loadings shown are one valid choice". Proof that only
the text moved: all 145 cases run through the previous commit's engine
and this one, 143 identical, 2 (`pca-warning-repeated-only`,
`pca-warning-both`) differ in `warning` alone; in the golden file the same
2 cases differ in `warning` alone; the pins are byte-identical.

## Negative control

Run 2026-09-24 on `fix/dataai-cluster-foundation-findings` (`negcontrol_cluster.sh`, full log reproduced here): baseline 349 passed; **52/52 engine plants red** (12 new: the old "training rows" wording planted in pca, the clustering standard and min-max scalers and in ml.js's two messages, "rows passed" planted in kNN, the pca warning overwritten and reordered, maxSweeps ignored or 0 accepted, the cutTree reuse check removed or naming the wrong step), 6/6 oracle plants red and 1 stopped (the oracle with no reuse rule cannot write the reuse refusals); restored and re-verified 349 passed. The first run (2026-09-24, 316 tests) had 40/40 engine and 4/4 oracle plants red. The plant list covers every convention in the decisions above, including the salvage defect (new rows scaled with their own scaler), the row cap off by one, the tie bands removed, and scikit-learn's vote-tie rule.

| kind | plant | tests failed | first failure |
|---|---|---|---|
| ENGINE | correlation PCA standardised with the population SD | 18 | goldens: the engine agrees with the oracle › pca-iris-correlation |
| ENGINE | covariance divisor n, not n - 1 | 20 | goldens: the engine agrees with the oracle › pca-iris-covariance |
| ENGINE | sign rule flipped (largest loading negative) | 18 | goldens: the engine agrees with the oracle › pca-iris-covariance |
| ENGINE | sign rule on the FIRST loading, not the largest | 13 | goldens: the engine agrees with the oracle › pca-iris-covariance |
| ENGINE | Jacobi stops after one sweep | 32 | goldens: the engine agrees with the oracle › pca-iris-covariance |
| ENGINE | eigenvalues sorted ascending | 42 | goldens: the engine agrees with the oracle › pca-iris-covariance |
| ENGINE | loadings scaled by the eigenvalue, not its square root | 5 | goldens: the engine agrees with the oracle › pca-iris-covariance |
| ENGINE | k-means++ first centre floor(u (n - 1)) | 38 | goldens: the engine agrees with the oracle › kmeans-iris-k3-none-seed3 |
| ENGINE | k-means++ weights by D, not D^2 | 44 | goldens: the engine agrees with the oracle › kmeans-iris-k3-none-seed3 |
| ENGINE | assignment tie to the HIGHER centre | 3 | goldens: the engine agrees with the oracle › kmeans-assignment-tie-lower-centre |
| ENGINE | empty cluster left empty (no relocation) | 4 | goldens: the engine agrees with the oracle › kmeans-empty-cluster-relocated |
| ENGINE | iterations count centre updates, not assignment passes | 29 | goldens: the engine agrees with the oracle › kmeans-iris-k3-none-seed3 |
| ENGINE | the LAST run wins, not the lowest inertia | 45 | goldens: the engine agrees with the oracle › kmeans-iris-k3-none-seed3 |
| ENGINE | each nInit run restarts the seed (identical starts) | 24 | goldens: the engine agrees with the oracle › kmeans-iris-k3-none-seed3 |
| ENGINE | clustering scaler on the sample SD | 39 | goldens: the engine agrees with the oracle › kmeans-iris-k3-standard-seed7 |
| ENGINE | a singleton scores 1, not 0 | 6 | goldens: the engine agrees with the oracle › silhouette-singleton-zero |
| ENGINE | a divides by the cluster size, not size - 1 | 22 | goldens: the engine agrees with the oracle › silhouette-iris-kmeans-none |
| ENGINE | silhouette on squared distances | 22 | goldens: the engine agrees with the oracle › silhouette-iris-kmeans-none |
| ENGINE | Ward Lance-Williams with + nt d_ab^2 | 11 | goldens: the engine agrees with the oracle › agglomerative-ekene90-ward-k4 |
| ENGINE | average linkage unweighted (WPGMA) | 5 | goldens: the engine agrees with the oracle › agglomerative-ekene90-average-k4 |
| ENGINE | complete linkage takes the min (single linkage) | 10 | goldens: the engine agrees with the oracle › agglomerative-ekene90-complete-k4 |
| ENGINE | merge tie to the HIGHEST ids | 6 | goldens: the engine agrees with the oracle › agglomerative-iris-complete-k3 |
| ENGINE | no merge tie band (exact float equality) | 2 | goldens: the engine agrees with the oracle › agglomerative-iris-complete-k3 |
| ENGINE | linkage row with the larger id first | 12 | goldens: the engine agrees with the oracle › agglomerative-ekene90-ward-k4 |
| ENGINE | new cluster id n + s + 1 | 28 | goldens: the engine agrees with the oracle › agglomerative-ekene90-ward-k4 |
| ENGINE | cut after n - k - 1 merges | 28 | goldens: the engine agrees with the oracle › agglomerative-ekene90-ward-k4 |
| ENGINE | row cap off by one (3,001 accepted) | 1 | row caps and boundaries › agglomerative: 3,000 rows are clustered, 3,001 refused |
| ENGINE | vote tie to the label that sorts first (scikit-learn) | 2 | goldens: the engine agrees with the oracle › knn-vote-tie-nearest-b |
| ENGINE | kNN new rows scaled with their own scaler (the salvage defect) | 7 | goldens: the engine agrees with the oracle › knn-ekene-wells-k1 |
| ENGINE | equidistant neighbours to the HIGHER row | 2 | goldens: the engine agrees with the oracle › knn-iris-k7 |
| ENGINE | threshold at the lower value, not the midpoint | 6 | goldens: the engine agrees with the oracle › cart-iris-depth3 |
| ENGINE | split tie to the HIGHER feature | 8 | goldens: the engine agrees with the oracle › cart-iris-depth3 |
| ENGINE | zero-decrease split allowed | 1 | goldens: the engine agrees with the oracle › cart-xor-no-split |
| ENGINE | majority tie to the class that sorts LAST | 7 | goldens: the engine agrees with the oracle › cart-iris-depth3 |
| ENGINE | minSamplesLeaf ignored | 10 | goldens: the engine agrees with the oracle › cart-iris-depth5-leaf5 |
| ENGINE | importances not normalised | 7 | goldens: the engine agrees with the oracle › cart-iris-depth3 |
| ENGINE | maxDepth counted from 1 | 11 | goldens: the engine agrees with the oracle › cart-iris-depth3 |
| ENGINE | pca constant refusal in the old wording (training rows) | 3 | goldens: the engine agrees with the oracle › pca-constant-feature-correlation |
| ENGINE | clustering standard scaler in the old wording (training rows) | 7 | goldens: the engine agrees with the oracle › kmeans-constant-log |
| ENGINE | clustering min-max scaler in the old wording (training rows) | 3 | goldens: the engine agrees with the oracle › kmeans-constant-log-minmax |
| ENGINE | kNN refusal says rows passed (its rows ARE training rows) | 3 | goldens: the engine agrees with the oracle › knn-constant-log-training |
| ENGINE | ml.js standard scaler ignores the row noun | 10 | goldens: the engine agrees with the oracle › pca-constant-feature-correlation |
| ENGINE | ml.js min-max scaler ignores the row noun | 3 | goldens: the engine agrees with the oracle › kmeans-constant-log-minmax |
| ENGINE | pca warning overwritten (the last one wins) | 2 | goldens: the engine agrees with the oracle › pca-warning-both |
| ENGINE | pca warnings in the other order | 2 | goldens: the engine agrees with the oracle › pca-warning-both |
| ENGINE | pca maxSweeps ignored (always 50) | 3 | goldens: the engine agrees with the oracle › pca-warning-both |
| ENGINE | pca maxSweeps 0 accepted | 1 | goldens: the engine agrees with the oracle › pca-maxsweeps-0 |
| ENGINE | cutTree id reuse not checked | 2 | goldens: the engine agrees with the oracle › cut-tree-reuse-row-id |
| ENGINE | cutTree reuse message names the later step | 2 | goldens: the engine agrees with the oracle › cut-tree-reuse-row-id |
| ENGINE | one-to-one greedy (first free facies, no optimum) | 5 | goldens: the engine agrees with the oracle › match-iris-one-to-one |
| ENGINE | ARI special case scores 0 | 4 | goldens: the engine agrees with the oracle › ari-both-one-cluster |
| ENGINE | ARI expected index over n^2 / 2 pairs | 16 | goldens: the engine agrees with the oracle › ari-iris-kmeans |
| ORACLE | oracle k-means++ first draw from n - 1 | 15 | goldens: the engine agrees with the oracle › kmeans-iris-k3-none-seed3 |
| ORACLE | oracle singleton silhouette 1 | 2 | goldens: the engine agrees with the oracle › silhouette-singleton-zero |
| ORACLE | oracle Ward height without the factor 2 | 3 | goldens: the engine agrees with the oracle › agglomerative-ekene90-ward-k4 |
| ORACLE | oracle ARI special case 0 | 2 | goldens: the engine agrees with the oracle › ari-both-one-cluster |
| ORACLE | oracle constant rule in the old wording | 10 | goldens: the engine agrees with the oracle › pca-constant-feature-correlation |
| ORACLE | oracle keeps only the last pca warning | 1 | goldens: the engine agrees with the oracle › pca-warning-both |
| ORACLE | oracle has no id reuse rule | STOP | the oracle refused to write a golden (cut_tree_reuse returns nothing to refuse with) |

## Open questions

1. Default `nInit` is 10 (scikit-learn's `n_init='auto'` is 1 for
   k-means++). Ten runs cost 1.6 s at 50k rows; the lead may prefer fewer.
2. The one-to-one refusal when clusters outnumber facies is deliberate
   (majority mode covers over-splitting); the app should offer the switch.
3. No SOM (the salvage had one); if the course wants it, it needs its own
   seeded engine and oracle.
