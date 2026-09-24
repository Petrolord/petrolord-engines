/**
 * Electrofacies: clustering and classification of well logs (Data & AI D3).
 *
 * Pure functions, no I/O. A feature matrix X is an array of rows (one row
 * per depth sample, one column per log). Every function returns either a
 * result object carrying a `basis` (the method and its conventions, so a
 * course can print the working) or `{ error, field }`, where `field` names
 * the input refused and the message starts with that name and states the
 * exact condition that failed.
 *
 * Conventions, stated once (FINDINGS-cluster.md has the sources and reasons):
 *   scaling     `scale` is 'standard' (default), 'minmax' or 'none'. Scaling
 *               is ml.js fitStandardScaler / fitMinMaxScaler (population SD,
 *               a constant feature refused by name) fitted on the rows being
 *               clustered, or on the TRAINING rows for kNN; imported, not
 *               re-implemented. A constant feature's refusal names the rows
 *               it was fitted on: "on the N rows passed" for pca
 *               (correlation), kmeans, silhouette, elbow and agglomerative;
 *               "on the N training rows" for knnClassify.
 *   distance    Euclidean on the scaled features everywhere (k-means,
 *               silhouette, agglomerative, kNN).
 *   PCA         matrix 'correlation' (default: features standardised with
 *               the SAMPLE SD, so score variances equal the eigenvalues) or
 *               'covariance' (centred, divisor n - 1). Eigenvalues by cyclic
 *               Jacobi rotations; an off-diagonal entry at or below
 *               eps x sqrt(|a_pp a_qq|) (eps = 2^-52) is set to zero; stops
 *               after the first sweep that needs no rotation (at most
 *               maxSweeps, default 50). Warnings: a Jacobi non-convergence
 *               warning first, then a repeated-eigenvalue warning, joined
 *               by '; ' when both apply.
 *               Sorted descending, equal values keep column order. A
 *               computed eigenvalue below zero (rounding) is reported as 0.
 *               Sign: in each component the first loading whose absolute
 *               value is within 1e-9 (relative) of the largest is positive.
 *   k-means     k-means++ (Arthur and Vassilvitskii 2007, one candidate per
 *               step) from one mulberry32(seed) stream: first centre row
 *               floor(u n); then u x (sum of D^2) picks the first row whose
 *               running sum of D^2 (rows in order) is above it. nInit runs
 *               draw from the same stream in turn; the lowest inertia wins,
 *               a tie (within 1e-12) keeps the earlier run. Lloyd passes: each row goes to
 *               the nearest centre, squared distances within 1e-12 (relative)
 *               of the smallest tied and going to the lower centre index;
 *               centres become member means. Converged when a pass gives
 *               the same labels as the pass before; `iterations` counts
 *               assignment passes (scikit-learn n_iter_). Empty cluster: it
 *               takes the row farthest from its current centre (ties to the
 *               lower row index) among clusters with at least 2 rows, as
 *               scikit-learn relocates.
 *   silhouette  s = (b - a) / max(a, b); a singleton cluster scores 0, and
 *               a = b = 0 scores 0 (scikit-learn). 2 to n - 1 clusters.
 *               Above 10,000 rows it is refused unless a seeded sampleSize
 *               is given (the rows are the first sampleSize of a
 *               Fisher-Yates shuffle, as ml.js).
 *   hierarchy   agglomerative Ward, complete or average by the Lance-Williams
 *               update on Euclidean merge heights (scipy linkage semantics).
 *               Each step merges the closest pair; merges whose heights are
 *               within 1e-12 (relative) of the smallest are TIED and the pair
 *               with the lowest cluster ids wins (smaller id first, then the
 *               other). Ids as scipy: rows 0 to n - 1, the cluster made at
 *               step s is n + s. Refused above 3,000 rows (O(n^2) memory).
 *               Cut labels number clusters by their first row.
 *   kNN         the k nearest training rows, taken one at a time: the lowest
 *               row among those whose squared distance is within 1e-12
 *               (relative) of the smallest remaining (decimal data put
 *               equal distances a rounding apart, so equality is banded); majority vote, a tied vote to
 *               the tied label whose nearest member comes first.
 *   CART        Gini; candidate thresholds at midpoints a/2 + b/2 of
 *               consecutive distinct values (a if that rounds to b); x at or
 *               below the threshold goes left. The best split has the
 *               largest impurity decrease (compared exactly on the integer
 *               counts); ties go to the lower feature index, then the lower
 *               threshold. A node splits only when the decrease is above
 *               zero. A leaf predicts its majority class, a tie to the
 *               class that sorts first.
 *   matching    one-to-one (maximum matched rows, Hungarian; among equal
 *               totals the first mapping in cluster order taking the first
 *               facies) or majority (each cluster to its most common facies,
 *               a tie to the facies that sorts first). Metrics by ml.js
 *               classificationReport. Adjusted Rand index is 1 when both
 *               partitions are trivial the same way (scikit-learn).
 *   reasons     figures in messages print as the shortest round-trip decimal.
 *
 * Reused by import: lib/stats mulberry32; ml.js fitStandardScaler,
 * fitMinMaxScaler, applyScaler, classificationReport.
 *
 * Validation: tools/validation/dataai/oracle_cluster.py (stdlib python)
 * writes test-data/dataai/goldens/cluster_cases.json (Fisher's iris data a
 * published anchor); pin_cluster.py pins scikit-learn / scipy in
 * test-data/dataai/pins/cluster_pins.json; FINDINGS-cluster.md,
 * negcontrol_cluster.sh.
 */

import { mulberry32 } from '../../lib/stats/stats.js';
import { fitStandardScaler, fitMinMaxScaler, applyScaler, classificationReport } from './ml.js';

export const DEFAULTS = Object.freeze({
  JACOBI_MAX_SWEEPS: 50,
  SIGN_TIE_REL: 1e-9, // loadings this close to the largest count as largest
  REPEATED_EIGEN_REL: 1e-10, // eigenvalues this close (relative to the largest) are flagged repeated
  KMEANS_MAX_ITER: 300,
  KMEANS_N_INIT: 10,
  SILHOUETTE_MAX_ROWS: 10000,
  AGGLOMERATIVE_MAX_ROWS: 3000,
  TIE_REL: 1e-12, // distances (and merge heights) this close to the smallest are tied
  KNN_MAX_PAIRS: 100000000, // training rows x new rows
  CART_MAX_DEPTH: 5,
  MATCH_MAX_LABELS: 50,
});

const EPS = 2 ** -52;

/* ------------------------------------------------------------------ */
/* Helpers. */

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => (x === Infinity ? 'infinity' : x === -Infinity ? 'minus infinity' : String(x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

const checkMatrix = (field, X, minRows = 1) => {
  if (!Array.isArray(X) || X.length < minRows) return refuse(field, `must be an array of at least ${minRows} rows`);
  if (!Array.isArray(X[0]) || X[0].length < 1) return refuse(`${field}[0]`, 'must be an array of at least one number');
  const p = X[0].length;
  for (let i = 0; i < X.length; i += 1) {
    if (!Array.isArray(X[i]) || X[i].length !== p) return refuse(`${field}[${i}]`, `must be an array of ${p} numbers, like row 0`);
    for (let j = 0; j < p; j += 1) if (!isNum(X[i][j])) return refuse(`${field}[${i}][${j}]`, 'must be a finite number: fill or drop missing values first');
  }
  return null;
};

const checkSeed = (seed) => (isInt(seed) && seed >= 0 && seed <= 4294967295 ? null : refuse('seed', 'must be a whole number from 0 to 4294967295'));

const cmpLabel = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Labels: all strings or all finite numbers; returns the sorted distinct list. */
const checkLabelArray = (field, y, n) => {
  if (!Array.isArray(y) || y.length !== n) return { bad: refuse(field, `must be an array of ${n} labels, one per row`) };
  const kind = typeof y[0];
  for (let i = 0; i < n; i += 1) {
    const v = y[i];
    if (!(typeof v === 'string' || isNum(v))) return { bad: refuse(`${field}[${i}]`, 'must be a string or a finite number') };
    if (typeof v !== kind) return { bad: refuse(`${field}[${i}]`, `must be the same type as ${field}[0]: all strings or all numbers`) };
  }
  const classes = [...new Set(y)].sort(cmpLabel);
  return { classes };
};

const checkNames = (names, p) => {
  if (names === undefined) return null;
  if (!Array.isArray(names) || names.length !== p) return refuse('names', `must be an array of ${p} feature names, one per column`);
  for (let j = 0; j < p; j += 1) {
    if (typeof names[j] !== 'string' || names[j].length === 0) return refuse(`names[${j}]`, 'must be a non-empty string');
    if (names.indexOf(names[j]) !== j) return refuse(`names[${j}]`, `repeats the name ${names[j]}`);
  }
  return null;
};

const SCALES = ['standard', 'minmax', 'none'];

/**
 * Fits the named scaler on X (ml.js) and returns the scaled rows. `rowNoun`
 * names the fitted rows in a constant-feature refusal: 'rows passed' where
 * X is clustered (kmeans, silhouette, agglomerative, and elbow through
 * kmeans), 'training rows' for kNN, whose X is the labelled training set.
 */
const scaleFit = (X, scale, names, rowNoun) => {
  if (!SCALES.includes(scale)) return { bad: refuse('scale', "must be 'standard', 'minmax' or 'none'") };
  const bn = checkNames(names, X[0].length);
  if (bn) return { bad: bn };
  if (scale === 'none') return { Z: X, scaler: null };
  const fit = scale === 'standard' ? fitStandardScaler({ X, names, rowNoun }) : fitMinMaxScaler({ X, names, rowNoun });
  if (fit.error) return { bad: fit };
  return { Z: applyScaler({ scaler: fit, X }).X, scaler: { kind: fit.kind, centre: fit.centre, scale: fit.scale } };
};

const scaleApply = (scaler, X) => (scaler ? X.map((r) => r.map((v, j) => (v - scaler.centre[j]) / scaler.scale[j])) : X);

const scaleBasis = (scale) => ({
  standard: 'z = (x - mean) / population SD per feature (ml.js fitStandardScaler), fitted on the rows clustered',
  minmax: '(x - min) / (max - min) per feature (ml.js fitMinMaxScaler), fitted on the rows clustered',
  none: 'features used as given (no scaling)',
}[scale]);

const flat = (Z) => {
  const n = Z.length; const p = Z[0].length;
  const a = new Float64Array(n * p);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < p; j += 1) a[i * p + j] = Z[i][j];
  return a;
};

/** Fisher-Yates from the end, j = floor(u (i + 1)), as ml.js. */
const shuffledRows = (n, seed) => {
  const rng = mulberry32(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i >= 1; i -= 1) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
};

/* ------------------------------------------------------------------ */
/* PCA. */

/** Cyclic Jacobi eigen-decomposition of a symmetric matrix. */
const jacobiEigen = (S, maxSweeps) => {
  const p = S.length;
  const A = S.map((r) => r.slice());
  const V = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (__, j) => (i === j ? 1 : 0)));
  let sweeps = 0;
  let converged = false;
  while (sweeps < maxSweeps) {
    sweeps += 1;
    let rotations = 0;
    for (let a = 0; a < p - 1; a += 1) {
      for (let b = a + 1; b < p; b += 1) {
        const apq = A[a][b];
        if (apq === 0) continue;
        if (Math.abs(apq) <= EPS * Math.sqrt(Math.abs(A[a][a] * A[b][b]))) { A[a][b] = 0; A[b][a] = 0; continue; }
        rotations += 1;
        const theta = (A[b][b] - A[a][a]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.hypot(theta, 1));
        const c = 1 / Math.hypot(t, 1);
        const s = t * c;
        for (let k = 0; k < p; k += 1) {
          const akp = A[k][a]; const akq = A[k][b];
          A[k][a] = c * akp - s * akq;
          A[k][b] = s * akp + c * akq;
        }
        for (let k = 0; k < p; k += 1) {
          const apk = A[a][k]; const aqk = A[b][k];
          A[a][k] = c * apk - s * aqk;
          A[b][k] = s * apk + c * aqk;
        }
        A[a][b] = 0; A[b][a] = 0;
        for (let k = 0; k < p; k += 1) {
          const vka = V[k][a]; const vkb = V[k][b];
          V[k][a] = c * vka - s * vkb;
          V[k][b] = s * vka + c * vkb;
        }
      }
    }
    if (rotations === 0) { converged = true; break; }
  }
  return { values: A.map((r, i) => r[i]), vectors: V, sweeps, converged };
};

const MATRICES = ['correlation', 'covariance'];

/**
 * Principal components of the rows of X from the correlation matrix
 * (default) or the covariance matrix. Components are unit eigenvectors
 * (rows of `components`); `loadings` are components x sqrt(eigenvalue)
 * (in the correlation form, the correlation of each feature with the
 * score); `scores` are the centred (and, for correlation, sample-SD
 * standardised) rows times the components.
 */
export const pca = ({ X, names, matrix = 'correlation', nComponents, maxSweeps = DEFAULTS.JACOBI_MAX_SWEEPS } = {}) => {
  const bad = checkMatrix('X', X, 2);
  if (bad) return bad;
  const n = X.length;
  const p = X[0].length;
  if (!MATRICES.includes(matrix)) return refuse('matrix', "must be 'correlation' or 'covariance'");
  const q = nComponents === undefined ? p : nComponents;
  if (!isInt(q) || q < 1 || q > p) return refuse('nComponents', `must be a whole number from 1 to ${p} (the number of features)`);
  if (!isInt(maxSweeps) || maxSweeps < 1) return refuse('maxSweeps', 'must be a whole number, 1 or more');
  let centre; let scale;
  if (matrix === 'correlation') {
    const fit = fitStandardScaler({ X, names, sd: 'sample', rowNoun: 'rows passed' });
    if (fit.error) return fit;
    centre = fit.centre; scale = fit.scale;
  } else {
    const bn = checkNames(names, p);
    if (bn) return bn;
    centre = []; scale = new Array(p).fill(1);
    for (let j = 0; j < p; j += 1) { let s = 0; for (let i = 0; i < n; i += 1) s += X[i][j]; centre.push(s / n); }
  }
  const Z = X.map((r) => r.map((v, j) => (v - centre[j]) / scale[j]));
  const S = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let a = 0; a < p; a += 1) {
    for (let b = 0; b <= a; b += 1) {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += Z[i][a] * Z[i][b];
      S[a][b] = s / (n - 1); S[b][a] = S[a][b];
    }
  }
  let trace = 0;
  for (let j = 0; j < p; j += 1) trace += S[j][j];
  if (!(trace > 0)) return refuse('X', 'has zero total variance (every column is constant), so there are no principal components');
  const eig = jacobiEigen(S, maxSweeps);
  const order = eig.values.map((v, j) => j).sort((a, b) => eig.values[b] - eig.values[a] || a - b);
  const values = order.map((j) => Math.max(0, eig.values[j]));
  const components = order.map((j) => {
    const v = eig.vectors.map((r) => r[j]);
    let mx = 0;
    for (let k = 0; k < p; k += 1) mx = Math.max(mx, Math.abs(v[k]));
    let lead = 0;
    while (Math.abs(v[lead]) < mx * (1 - DEFAULTS.SIGN_TIE_REL)) lead += 1;
    return v[lead] < 0 ? v.map((x) => -x) : v;
  });
  const total = values.reduce((a, v) => a + v, 0);
  const ratio = values.map((v) => v / total);
  let cum = 0;
  const cumulative = ratio.map((r) => (cum += r));
  const repeated = [];
  for (let k = 0; k + 1 < p; k += 1) if (Math.abs(values[k] - values[k + 1]) <= DEFAULTS.REPEATED_EIGEN_REL * values[0]) repeated.push([k, k + 1]);
  const featureNames = names === undefined ? Array.from({ length: p }, (_, j) => `x${j + 1}`) : [...names];
  const comp = components.slice(0, q);
  const scores = Z.map((r) => comp.map((v) => { let s = 0; for (let j = 0; j < p; j += 1) s += r[j] * v[j]; return s; }));
  const out = {
    kind: 'pca',
    matrix,
    names: featureNames,
    n,
    p,
    nComponents: q,
    centre,
    scale,
    covarianceMatrix: S,
    eigenvalues: values,
    explainedVariance: values.slice(0, q),
    explainedVarianceRatio: ratio.slice(0, q),
    cumulativeRatio: cumulative.slice(0, q),
    totalVariance: total,
    components: comp,
    loadings: comp.map((v, k) => v.map((x) => x * Math.sqrt(values[k]))),
    scores,
    jacobiSweeps: eig.sweeps,
    converged: eig.converged,
    repeatedEigenvalues: repeated,
    basis: {
      matrix: matrix === 'correlation'
        ? 'correlation matrix: features standardised with the SAMPLE SD (n - 1), so each score variance equals its eigenvalue and the eigenvalues sum to the number of features'
        : 'covariance matrix of the centred features, divisor n - 1 (as scikit-learn PCA explained_variance_)',
      eigen: `cyclic Jacobi rotations; an off-diagonal entry at or below 2^-52 x sqrt(|a_pp a_qq|) is set to zero; stops after the first sweep needing no rotation (at most ${maxSweeps} sweeps); eigenvalues sorted descending, equal values keep column order, a rounding value below zero reported as 0`,
      sign: 'in each component the first loading whose absolute value is within 1e-9 (relative) of the largest is made positive (scikit-learn: the largest absolute loading positive)',
      loadings: 'component x sqrt(eigenvalue); in the correlation form, the correlation of the feature with the score',
      scores: 'centred (and for correlation, standardised) rows times the unit components',
      ratio: 'eigenvalue / sum of all eigenvalues',
    },
  };
  // Both warnings are kept, non-convergence first (it qualifies every
  // figure, the repeated-eigenvalue test included), joined by '; '.
  const warnings = [];
  if (!eig.converged) warnings.push(`Jacobi did not converge in ${maxSweeps} sweep${maxSweeps === 1 ? '' : 's'} (the last sweep still rotated): the eigenvalues and components shown are those after sweep ${maxSweeps}`);
  if (repeated.length) warnings.push(`eigenvalues ${repeated.map(([a, b]) => `${a + 1} and ${b + 1}`).join(', ')} differ by at most 1e-10 times the largest eigenvalue, so the directions of those components are not unique: the loadings shown are one valid choice`);
  if (warnings.length) out.warning = warnings.join('; ');
  return out;
};

/** Scores of new rows on a fitted PCA (the model's centre, scale and components). */
export const pcaTransform = ({ model, X } = {}) => {
  if (!model || model.kind !== 'pca' || !Array.isArray(model.components)) return refuse('model', 'must be the result of pca');
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  if (X[0].length !== model.p) return refuse('X', `must have ${model.p} columns, as the PCA was fitted on`);
  const scores = X.map((r) => model.components.map((v) => { let s = 0; for (let j = 0; j < model.p; j += 1) s += ((r[j] - model.centre[j]) / model.scale[j]) * v[j]; return s; }));
  return { scores, basis: { rule: `rows centred${model.matrix === 'correlation' ? ' and standardised' : ''} with the fitted parameters, times the ${model.nComponents} unit components` } };
};

/* ------------------------------------------------------------------ */
/* k-means. */

const distinctRows = (Z) => new Set(Z.map((r) => r.join(','))).size;

const kmeansPP = (A, n, p, k, rng) => {
  const picks = [Math.floor(rng() * n)];
  const D2 = new Float64Array(n);
  const c0 = picks[0] * p;
  for (let i = 0; i < n; i += 1) { let s = 0; for (let j = 0; j < p; j += 1) { const d = A[i * p + j] - A[c0 + j]; s += d * d; } D2[i] = s; }
  for (let c = 1; c < k; c += 1) {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += D2[i];
    const target = rng() * total;
    let cum = 0; let pick = -1; let lastPos = -1;
    for (let i = 0; i < n; i += 1) {
      if (D2[i] > 0) lastPos = i;
      cum += D2[i];
      if (cum > target) { pick = i; break; }
    }
    if (pick < 0) pick = lastPos;
    picks.push(pick);
    const cp = pick * p;
    for (let i = 0; i < n; i += 1) {
      let s = 0; for (let j = 0; j < p; j += 1) { const d = A[i * p + j] - A[cp + j]; s += d * d; }
      if (s < D2[i]) D2[i] = s;
    }
  }
  return picks;
};

/**
 * Nearest centre; squared distances within TIE_REL (relative) of the
 * smallest are tied and the lower centre index wins. Returns the inertia.
 */
const assignRows = (A, n, p, C, k, labels, d2) => {
  let inertia = 0;
  const ds = new Float64Array(k);
  for (let i = 0; i < n; i += 1) {
    let m = Infinity;
    for (let c = 0; c < k; c += 1) {
      let s = 0;
      for (let j = 0; j < p; j += 1) { const d = A[i * p + j] - C[c * p + j]; s += d * d; }
      ds[c] = s;
      if (s < m) m = s;
    }
    const thr = m + m * DEFAULTS.TIE_REL;
    let best = 0;
    while (ds[best] > thr) best += 1;
    labels[i] = best; d2[i] = ds[best]; inertia += ds[best];
  }
  return inertia;
};

const lloyd = (A, n, p, k, C0, maxIter) => {
  const C = Float64Array.from(C0);
  let labels = new Int32Array(n);
  let prev = null;
  const d2 = new Float64Array(n);
  let iterations = 0; let converged = false; let relocations = 0;
  const trace = [];
  while (iterations < maxIter) {
    iterations += 1;
    const inertia = assignRows(A, n, p, C, k, labels, d2);
    let changed = n;
    if (prev) { changed = 0; for (let i = 0; i < n; i += 1) if (labels[i] !== prev[i]) changed += 1; }
    trace.push({ pass: iterations, inertia, changed });
    if (prev && changed === 0) { converged = true; break; }
    // update: member means, then the empty-cluster rule
    const sums = new Float64Array(k * p); const counts = new Int32Array(k);
    for (let i = 0; i < n; i += 1) { const c = labels[i]; counts[c] += 1; for (let j = 0; j < p; j += 1) sums[c * p + j] += A[i * p + j]; }
    const empties = [];
    for (let c = 0; c < k; c += 1) if (counts[c] === 0) empties.push(c);
    if (empties.length) {
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d2[b] - d2[a] || a - b);
      let q = 0;
      for (const e of empties) {
        while (q < n && counts[labels[order[q]]] < 2) q += 1;
        if (q >= n) break;
        const r = order[q]; q += 1;
        const old = labels[r];
        counts[old] -= 1;
        for (let j = 0; j < p; j += 1) { sums[old * p + j] -= A[r * p + j]; sums[e * p + j] = A[r * p + j]; }
        counts[e] = 1; relocations += 1;
      }
    }
    for (let c = 0; c < k; c += 1) if (counts[c] > 0) for (let j = 0; j < p; j += 1) C[c * p + j] = sums[c * p + j] / counts[c];
    prev = labels; labels = new Int32Array(n);
  }
  if (!converged) {
    const inertia = assignRows(A, n, p, C, k, labels, d2);
    return { C, labels, d2, inertia, iterations, converged, trace, relocations };
  }
  let inertia = 0;
  for (let i = 0; i < n; i += 1) inertia += d2[i];
  return { C, labels, d2, inertia, iterations, converged, trace, relocations };
};

const toRows = (C, k, p) => Array.from({ length: k }, (_, c) => Array.from(C.subarray(c * p, c * p + p)));

/**
 * k-means on the scaled rows of X: seeded k-means++ (or the given initial
 * centres, in the ORIGINAL units) and Lloyd passes to convergence.
 */
export const kmeans = ({ X, k, seed, nInit, maxIter = DEFAULTS.KMEANS_MAX_ITER, init, scale = 'standard', names } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const n = X.length; const p = X[0].length;
  if (!isInt(k) || k < 1 || k > n) return refuse('k', `must be a whole number from 1 to ${n} (the number of rows)`);
  if (!isInt(maxIter) || maxIter < 1) return refuse('maxIter', 'must be a whole number, 1 or more');
  const sf = scaleFit(X, scale, names, 'rows passed');
  if (sf.bad) return sf.bad;
  const Z = sf.Z;
  const A = flat(Z);
  let starts;
  if (init !== undefined) {
    if (nInit !== undefined && nInit !== 1) return refuse('nInit', 'must be 1 (or left out) when init gives the starting centres');
    const bi = checkMatrix('init', init);
    if (bi) return bi;
    if (init.length !== k || init[0].length !== p) return refuse('init', `must hold ${k} centres of ${p} numbers (k rows, one per cluster)`);
    starts = [{ C: flat(scaleApply(sf.scaler, init)), picks: null }];
  } else {
    const bs = checkSeed(seed);
    if (bs) return bs;
    const ni = nInit === undefined ? DEFAULTS.KMEANS_N_INIT : nInit;
    if (!isInt(ni) || ni < 1) return refuse('nInit', 'must be a whole number, 1 or more');
    const m = distinctRows(Z);
    if (m < k) return refuse('X', `has ${m} distinct rows${sf.scaler ? ' after scaling' : ''}, fewer than k = ${k}: k-means++ cannot place ${k} distinct centres`);
    const rng = mulberry32(seed);
    starts = [];
    for (let r = 0; r < ni; r += 1) {
      const picks = kmeansPP(A, n, p, k, rng);
      const C = new Float64Array(k * p);
      picks.forEach((row, c) => { for (let j = 0; j < p; j += 1) C[c * p + j] = A[row * p + j]; });
      starts.push({ C, picks });
    }
  }
  let best = null; let bestRun = -1;
  const runs = [];
  starts.forEach((s, r) => {
    const res = lloyd(A, n, p, k, s.C, maxIter);
    runs.push({ run: r, inertia: res.inertia, iterations: res.iterations, converged: res.converged, initialRows: s.picks });
    if (!best || res.inertia < best.inertia - best.inertia * DEFAULTS.TIE_REL) { best = { ...res, start: s }; bestRun = r; }
  });
  const centres = toRows(best.C, k, p);
  const sizes = new Array(k).fill(0);
  for (let i = 0; i < n; i += 1) sizes[best.labels[i]] += 1;
  const sc = sf.scaler;
  const out = {
    kind: 'kmeans',
    k,
    n,
    p,
    names: names === undefined ? Array.from({ length: p }, (_, j) => `x${j + 1}`) : [...names],
    scale,
    scaler: sc,
    labels: Array.from(best.labels),
    sizes,
    centres,
    centresOriginal: sc ? centres.map((r) => r.map((v, j) => v * sc.scale[j] + sc.centre[j])) : centres.map((r) => r.slice()),
    inertia: best.inertia,
    iterations: best.iterations,
    converged: best.converged,
    emptyClusterRelocations: best.relocations,
    trace: best.trace,
    initialCentres: toRows(best.start.C, k, p),
    initialRows: best.start.picks,
    bestRun,
    runs,
    seed: init === undefined ? seed : null,
    basis: {
      scaling: scaleBasis(scale),
      init: init === undefined
        ? 'k-means++ (one candidate per step) from one mulberry32(seed) stream: first centre row floor(u n), then u x sum D^2 picks the first row whose running sum of D^2 is above it; nInit runs draw in turn from the same stream'
        : 'the given centres (original units, scaled with the fitted scaler)',
      assignment: 'nearest centre by Euclidean distance on the scaled features; squared distances within 1e-12 (relative) of the smallest are tied and go to the lower centre index',
      update: 'centre = mean of its rows; an empty cluster takes the row farthest from its current centre (ties to the lower row) among clusters with at least 2 rows',
      convergence: `converged when an assignment pass returns the labels of the pass before; iterations counts assignment passes (scikit-learn n_iter_); at most maxIter ${maxIter}`,
      inertia: 'sum of squared distances of the rows to their centres, on the scaled features',
      best: 'lowest inertia over the runs; a run within 1e-12 (relative) of the best so far does not replace it',
    },
  };
  if (!best.converged) out.warning = `did not converge in ${maxIter} assignment passes: the labels printed come from one more pass against the last centres`;
  return out;
};

/** Assigns new rows to the nearest centre of a fitted k-means model. */
export const assignClusters = ({ model, X } = {}) => {
  if (!model || model.kind !== 'kmeans' || !Array.isArray(model.centres)) return refuse('model', 'must be the result of kmeans');
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  if (X[0].length !== model.p) return refuse('X', `must have ${model.p} columns, as the model was fitted on`);
  const Z = scaleApply(model.scaler, X);
  const n = Z.length; const p = model.p;
  const labels = new Int32Array(n); const d2 = new Float64Array(n);
  assignRows(flat(Z), n, p, flat(model.centres), model.k, labels, d2);
  return { labels: Array.from(labels), distances: Array.from(d2, Math.sqrt), basis: { rule: 'scaled with the fitted scaler, then the nearest centre; squared distances within 1e-12 (relative) of the smallest are tied and go to the lower centre index' } };
};

/* ------------------------------------------------------------------ */
/* Silhouette. */

const silhouetteCore = (Z, lab, K) => {
  const n = Z.length; const p = Z[0].length;
  const A = flat(Z);
  const sums = new Float64Array(n * K);
  const size = new Int32Array(K);
  for (let i = 0; i < n; i += 1) size[lab[i]] += 1;
  for (let i = 0; i < n; i += 1) {
    const li = lab[i];
    for (let j = i + 1; j < n; j += 1) {
      let s = 0;
      for (let t = 0; t < p; t += 1) { const d = A[i * p + t] - A[j * p + t]; s += d * d; }
      const d = Math.sqrt(s);
      sums[i * K + lab[j]] += d;
      sums[j * K + li] += d;
    }
  }
  const values = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const li = lab[i];
    if (size[li] === 1) { values[i] = 0; continue; }
    const a = sums[i * K + li] / (size[li] - 1);
    let b = Infinity;
    for (let c = 0; c < K; c += 1) if (c !== li && size[c] > 0) b = Math.min(b, sums[i * K + c] / size[c]);
    const m = Math.max(a, b);
    values[i] = m === 0 ? 0 : (b - a) / m;
  }
  return values;
};

/** Silhouette coefficient per row and its mean, on the scaled rows. */
export const silhouette = ({ X, labels, scale = 'standard', names, sampleSize, seed } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const n = X.length;
  const L = checkLabelArray('labels', labels, n);
  if (L.bad) return L.bad;
  let rows = null;
  if (sampleSize !== undefined) {
    if (!isInt(sampleSize) || sampleSize < 2 || sampleSize > Math.min(n, DEFAULTS.SILHOUETTE_MAX_ROWS)) return refuse('sampleSize', `must be a whole number from 2 to ${Math.min(n, DEFAULTS.SILHOUETTE_MAX_ROWS)}`);
    const bs = checkSeed(seed);
    if (bs) return bs;
    rows = shuffledRows(n, seed).slice(0, sampleSize).sort((a, b) => a - b);
  } else if (n > DEFAULTS.SILHOUETTE_MAX_ROWS) {
    return refuse('X', `has ${n} rows, above the ${DEFAULTS.SILHOUETTE_MAX_ROWS} the silhouette computes in full (every pair of rows): give sampleSize and seed to score a seeded sample`);
  }
  const sf = scaleFit(X, scale, names, 'rows passed');
  if (sf.bad) return sf.bad;
  const Z = rows ? rows.map((i) => sf.Z[i]) : sf.Z;
  const lab = rows ? rows.map((i) => labels[i]) : labels;
  const classes = rows ? [...new Set(lab)].sort(cmpLabel) : L.classes;
  const m = Z.length;
  if (classes.length < 2 || classes.length > m - 1) return refuse('labels', `must hold from 2 to ${m - 1} distinct clusters${rows ? ' in the sample' : ''} (found ${classes.length}): the silhouette compares each row with the next nearest cluster`);
  const pos = new Map(classes.map((c, i) => [c, i]));
  const values = silhouetteCore(Z, lab.map((v) => pos.get(v)), classes.length);
  const perCluster = classes.map((c) => {
    const vs = values.filter((_, i) => lab[i] === c);
    return { label: c, size: vs.length, mean: vs.reduce((a, v) => a + v, 0) / vs.length };
  });
  return {
    mean: values.reduce((a, v) => a + v, 0) / m,
    values,
    perCluster,
    labels: classes,
    rows,
    n: m,
    basis: {
      scaling: scaleBasis(scale),
      formula: 's = (b - a) / max(a, b): a the mean distance to the other rows of its cluster, b the smallest mean distance to another cluster; Euclidean',
      singleton: 'a row alone in its cluster scores 0, and a = b = 0 scores 0 (scikit-learn)',
      sample: rows ? `the first ${m} rows of a mulberry32(${seed}) Fisher-Yates shuffle, scored among themselves (scikit-learn sample_size)` : 'every row',
    },
  };
};

/* ------------------------------------------------------------------ */
/* Elbow. */

/** k-means inertia over a range of k (each k with its own mulberry32(seed) stream), with the silhouette optionally. */
export const elbow = ({ X, kMin = 1, kMax = 10, seed, nInit, maxIter, scale = 'standard', names, withSilhouette = false, sampleSize } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const n = X.length;
  if (!isInt(kMin) || kMin < 1) return refuse('kMin', 'must be a whole number, 1 or more');
  if (!isInt(kMax) || kMax < kMin || kMax > n) return refuse('kMax', `must be a whole number from kMin (${fmt(kMin)}) to ${n} (the number of rows)`);
  if (typeof withSilhouette !== 'boolean') return refuse('withSilhouette', 'must be true or false');
  const table = [];
  for (let k = kMin; k <= kMax; k += 1) {
    const r = kmeans({ X, k, seed, nInit, maxIter, scale, names });
    if (r.error) return r;
    const row = { k, inertia: r.inertia, iterations: r.iterations, converged: r.converged };
    const prev = table[table.length - 1];
    row.drop = prev ? prev.inertia - r.inertia : null;
    row.dropFraction = prev && prev.inertia > 0 ? (prev.inertia - r.inertia) / prev.inertia : null;
    if (withSilhouette) {
      if (k < 2 || k > n - 1) row.silhouette = null;
      else {
        const s = silhouette({ X, labels: r.labels, scale, names, sampleSize, seed: sampleSize === undefined ? undefined : seed });
        if (s.error) return s;
        row.silhouette = s.mean;
      }
    }
    table.push(row);
  }
  const rises = table.filter((r, i) => i > 0 && r.inertia > table[i - 1].inertia).map((r) => r.k);
  let bestSilhouetteK = null;
  if (withSilhouette) {
    let bv = -Infinity;
    table.forEach((r) => { if (r.silhouette !== null && r.silhouette > bv) { bv = r.silhouette; bestSilhouetteK = r.k; } });
  }
  const out = {
    table,
    bestSilhouetteK,
    inertiaRises: rises,
    basis: {
      runs: 'kmeans(X, k, seed, nInit) for each k, each k with its own mulberry32(seed) stream, so a row equals the single kmeans call',
      drop: 'inertia(k - 1) - inertia(k); dropFraction divides by inertia(k - 1)',
      pick: withSilhouette ? 'bestSilhouetteK has the highest mean silhouette; a tie goes to the smaller k. No elbow is picked automatically: read the drops' : 'no k is picked automatically: read the drops',
    },
  };
  if (rises.length) out.warning = `inertia rises at k = ${rises.join(', ')}: those runs stopped in a local minimum; raise nInit`;
  return out;
};

/* ------------------------------------------------------------------ */
/* Agglomerative clustering. */

const LINKAGES = ['ward', 'complete', 'average'];

/** Labels after the first n - k merges of a linkage matrix, numbered by first row. */
const cutLabels = (Z, n, k) => {
  const parent = Array.from({ length: 2 * n - 1 }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let s = 0; s < n - k; s += 1) { const nid = n + s; parent[find(Z[s][0])] = nid; parent[find(Z[s][1])] = nid; }
  const map = new Map(); const labels = new Array(n);
  for (let i = 0; i < n; i += 1) { const r = find(i); if (!map.has(r)) map.set(r, map.size); labels[i] = map.get(r); }
  return labels;
};

/**
 * Agglomerative (hierarchical) clustering: the full merge history as a
 * scipy linkage matrix [id1, id2, height, size] and, when k is given, the
 * labels of the k-cluster cut.
 */
export const agglomerative = ({ X, linkage = 'ward', k, scale = 'standard', names } = {}) => {
  const bad = checkMatrix('X', X, 2);
  if (bad) return bad;
  const n = X.length; const p = X[0].length;
  if (!LINKAGES.includes(linkage)) return refuse('linkage', "must be 'ward', 'complete' or 'average'");
  if (n > DEFAULTS.AGGLOMERATIVE_MAX_ROWS) return refuse('X', `has ${n} rows, above the ${DEFAULTS.AGGLOMERATIVE_MAX_ROWS} agglomerative clustering accepts (it holds every pairwise distance, n(n - 1)/2 of them): cluster a sample or use kmeans`);
  if (k !== undefined && (!isInt(k) || k < 1 || k > n)) return refuse('k', `must be a whole number from 1 to ${n} (the number of rows)`);
  const sf = scaleFit(X, scale, names, 'rows passed');
  if (sf.bad) return sf.bad;
  const A = flat(sf.Z);
  const idx = (i, j) => (i < j ? i * n - (i * (i + 1)) / 2 + (j - i - 1) : j * n - (j * (j + 1)) / 2 + (i - j - 1));
  const D = new Float64Array((n * (n - 1)) / 2);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let s = 0; for (let t = 0; t < p; t += 1) { const d = A[i * p + t] - A[j * p + t]; s += d * d; }
      D[idx(i, j)] = Math.sqrt(s);
    }
  }
  const ids = Int32Array.from({ length: n }, (_, i) => i);
  const size = new Int32Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const nnd = new Float64Array(n); const nn = new Int32Array(n);
  const rowMin = (s) => {
    let b = Infinity; let bi = -1;
    for (let t = 0; t < n; t += 1) if (t !== s && active[t]) { const d = D[idx(s, t)]; if (d < b) { b = d; bi = t; } }
    nnd[s] = b; nn[s] = bi;
  };
  for (let s = 0; s < n; s += 1) rowMin(s);
  const Zl = [];
  let tiedSteps = 0;
  for (let step = 0; step < n - 1; step += 1) {
    let m = Infinity;
    for (let s = 0; s < n; s += 1) if (active[s] && nnd[s] < m) m = nnd[s];
    const thr = m + m * DEFAULTS.TIE_REL;
    let a = -1; let nCand = 0;
    for (let s = 0; s < n; s += 1) if (active[s] && nnd[s] <= thr) { nCand += 1; if (a < 0 || ids[s] < ids[a]) a = s; }
    let b = -1; let nPart = 0;
    for (let t = 0; t < n; t += 1) if (t !== a && active[t] && D[idx(a, t)] <= thr) { nPart += 1; if (b < 0 || ids[t] < ids[b]) b = t; }
    if (nCand > 2 || nPart > 1) tiedSteps += 1;
    const h = D[idx(a, b)];
    const na = size[a]; const nb = size[b];
    Zl.push([Math.min(ids[a], ids[b]), Math.max(ids[a], ids[b]), h, na + nb]);
    const keep = Math.min(a, b); const drop = Math.max(a, b);
    for (let t = 0; t < n; t += 1) {
      if (!active[t] || t === a || t === b) continue;
      const dat = D[idx(a, t)]; const dbt = D[idx(b, t)];
      let d;
      if (linkage === 'complete') d = Math.max(dat, dbt);
      else if (linkage === 'average') d = (na * dat + nb * dbt) / (na + nb);
      else { const nt = size[t]; const v = ((na + nt) * dat * dat + (nb + nt) * dbt * dbt - nt * h * h) / (na + nb + nt); d = Math.sqrt(Math.max(0, v)); }
      D[idx(keep, t)] = d;
    }
    active[drop] = 0;
    size[keep] = na + nb;
    ids[keep] = n + step;
    rowMin(keep);
    for (let t = 0; t < n; t += 1) {
      if (!active[t] || t === keep) continue;
      if (nn[t] === a || nn[t] === b) rowMin(t);
      else { const d = D[idx(keep, t)]; if (d < nnd[t]) { nnd[t] = d; nn[t] = keep; } }
    }
  }
  const out = {
    kind: 'agglomerative',
    linkage,
    n,
    scale,
    scaler: sf.scaler,
    linkageMatrix: Zl,
    heights: Zl.map((r) => r[2]),
    tiedSteps,
    basis: {
      scaling: scaleBasis(scale),
      linkage: {
        ward: 'Ward: Lance-Williams d(ab, t) = sqrt(((na + nt) d_at^2 + (nb + nt) d_bt^2 - nt d_ab^2) / (na + nb + nt)) from Euclidean distances (scipy ward); the height is sqrt(2 x the rise in within-cluster sum of squares)',
        complete: 'complete: the largest Euclidean distance between the two clusters (max of d_at, d_bt)',
        average: 'average (UPGMA): the mean Euclidean distance over all cross pairs ((na d_at + nb d_bt) / (na + nb))',
      }[linkage],
      ties: 'merges whose heights are within 1e-12 (relative) of the smallest are tied; the tied pair with the lowest cluster ids wins (the smaller id first, then the other)',
      ids: 'scipy linkage matrix: rows 0 to n - 1, the cluster made at step s is n + s; each row [smaller id, larger id, height, size]',
      cut: 'k clusters after the first n - k merges; clusters numbered 0 to k - 1 in the order of their first row',
      cap: `at most ${DEFAULTS.AGGLOMERATIVE_MAX_ROWS} rows (every pairwise distance is held)`,
    },
  };
  if (k !== undefined) {
    out.k = k;
    out.labels = cutLabels(Zl, n, k);
    out.cutHeights = { below: k < n ? Zl[n - k - 1][2] : 0, above: k > 1 ? Zl[n - k][2] : null };
  }
  return out;
};

/** Cuts a linkage matrix (from agglomerative) at k clusters. */
export const cutTree = ({ linkageMatrix, k } = {}) => {
  if (!Array.isArray(linkageMatrix) || linkageMatrix.length < 1) return refuse('linkageMatrix', 'must be the non-empty linkageMatrix of agglomerative');
  const n = linkageMatrix.length + 1;
  const mergedAt = new Map(); // id -> the step that merged it
  for (let s = 0; s < n - 1; s += 1) {
    const r = linkageMatrix[s];
    if (!Array.isArray(r) || r.length !== 4 || !isInt(r[0]) || !isInt(r[1]) || r[0] < 0 || r[1] >= n + s || r[0] >= r[1]) {
      return refuse(`linkageMatrix[${s}]`, `must be [id1, id2, height, size] with whole ids 0 <= id1 < id2 < ${n + s}`);
    }
    for (const id of [r[0], r[1]]) {
      if (mergedAt.has(id)) return refuse(`linkageMatrix[${s}]`, `merges id ${id}, which linkageMatrix[${mergedAt.get(id)}] already merged: each row id (0 to ${n - 1}) and each cluster id (${n} to ${2 * n - 3}) may be merged once only`);
      mergedAt.set(id, s);
    }
  }
  if (!isInt(k) || k < 1 || k > n) return refuse('k', `must be a whole number from 1 to ${n} (the number of rows)`);
  const labels = cutLabels(linkageMatrix, n, k);
  return { k, labels, basis: { cut: 'k clusters after the first n - k merges; clusters numbered 0 to k - 1 in the order of their first row' } };
};

/* ------------------------------------------------------------------ */
/* kNN. */

/**
 * k-nearest-neighbour classification of new rows from labelled training
 * rows, on features scaled with the training rows' scaler.
 */
export const knnClassify = ({ X, y, Xnew, k = 5, scale = 'standard', names } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const n = X.length; const p = X[0].length;
  const L = checkLabelArray('y', y, n);
  if (L.bad) return L.bad;
  const bn = checkMatrix('Xnew', Xnew);
  if (bn) return bn;
  if (Xnew[0].length !== p) return refuse('Xnew', `must have ${p} column${p === 1 ? '' : 's'}, like X`);
  if (!isInt(k) || k < 1 || k > n) return refuse('k', `must be a whole number from 1 to ${n} (the training rows)`);
  if (n * Xnew.length > DEFAULTS.KNN_MAX_PAIRS) return refuse('Xnew', `has ${Xnew.length} rows against ${n} training rows, ${n * Xnew.length} distance pairs, above the ${DEFAULTS.KNN_MAX_PAIRS} kNN computes: classify fewer rows at a time or thin the training rows`);
  const sf = scaleFit(X, scale, names, 'training rows');
  if (sf.bad) return sf.bad;
  const A = flat(sf.Z);
  const B = flat(scaleApply(sf.scaler, Xnew));
  const m = Xnew.length;
  const predictions = new Array(m); const neighbours = new Array(m); const distances = new Array(m); const votes = new Array(m);
  const bd = new Float64Array(k);
  const all = new Float64Array(n);
  const bi = new Array(k);
  let tiedVotes = 0;
  for (let r = 0; r < m; r += 1) {
    // the k-th smallest squared distance, by a sorted buffer
    let cnt = 0;
    for (let i = 0; i < n; i += 1) {
      let s = 0; for (let t = 0; t < p; t += 1) { const d = B[r * p + t] - A[i * p + t]; s += d * d; }
      all[i] = s;
      if (cnt === k && s >= bd[k - 1]) continue;
      let q = cnt === k ? k - 1 : cnt;
      while (q > 0 && bd[q - 1] > s) { bd[q] = bd[q - 1]; q -= 1; }
      bd[q] = s;
      if (cnt < k) cnt += 1;
    }
    // candidates within the tie band of the k-th; then take k greedily: the
    // lowest row among those within the band of the smallest remaining
    const lim = bd[k - 1] + bd[k - 1] * DEFAULTS.TIE_REL;
    const cand = [];
    for (let i = 0; i < n; i += 1) if (all[i] <= lim) cand.push(i);
    cand.sort((a, b) => all[a] - all[b] || a - b);
    const taken = new Uint8Array(cand.length);
    for (let q = 0; q < k; q += 1) {
      let first = 0; while (taken[first]) first += 1;
      const thr = all[cand[first]] + all[cand[first]] * DEFAULTS.TIE_REL;
      let pick = first;
      for (let z = first; z < cand.length && all[cand[z]] <= thr; z += 1) if (!taken[z] && cand[z] < cand[pick]) pick = z;
      taken[pick] = 1; bi[q] = cand[pick]; bd[q] = all[cand[pick]];
    }
    const count = new Map(); const first = new Map();
    for (let q = 0; q < k; q += 1) { const lab = y[bi[q]]; count.set(lab, (count.get(lab) || 0) + 1); if (!first.has(lab)) first.set(lab, q); }
    // labels in the order of their nearest member; a strictly larger count replaces the winner
    let win = null; let tie = false;
    for (const [lab, c] of count) {
      if (win === null || c > count.get(win)) { win = lab; tie = false; } else if (c === count.get(win)) tie = true;
    }
    if (tie) tiedVotes += 1;
    predictions[r] = win;
    neighbours[r] = bi.slice();
    distances[r] = Array.from(bd, Math.sqrt);
    votes[r] = L.classes.filter((c) => count.has(c)).map((c) => ({ label: c, count: count.get(c) }));
  }
  return {
    k,
    predictions,
    neighbours,
    distances,
    votes,
    tiedVotes,
    scaler: sf.scaler,
    classes: L.classes,
    basis: {
      scaling: scale === 'none' ? 'features used as given (no scaling)' : `${scale} scaler (ml.js) fitted on the TRAINING rows only and applied unchanged to the new rows`,
      distance: 'Euclidean on the scaled features',
      neighbours: 'the k nearest training rows, taken one at a time: the lowest row among those whose squared distance is within 1e-12 (relative) of the smallest remaining',
      vote: 'majority of the k labels; a tied vote goes to the tied label whose nearest member comes first in the neighbour order (scikit-learn takes the label that sorts first)',
      cap: `training rows x new rows at most ${DEFAULTS.KNN_MAX_PAIRS}`,
    },
  };
};

/* ------------------------------------------------------------------ */
/* CART classification tree. */

const giniOf = (counts, n) => { let s = 0; for (const c of counts) s += c * c; return 1 - s / (n * n); };
const argmaxFirst = (counts) => { let b = 0; for (let c = 1; c < counts.length; c += 1) if (counts[c] > counts[b]) b = c; return b; };

/**
 * A CART classification tree grown with the Gini criterion to maxDepth,
 * with minSamplesLeaf rows in every leaf and minSamplesSplit rows to split.
 */
export const cartFit = ({ X, y, names, maxDepth = DEFAULTS.CART_MAX_DEPTH, minSamplesLeaf = 1, minSamplesSplit = 2 } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const n = X.length; const p = X[0].length;
  const L = checkLabelArray('y', y, n);
  if (L.bad) return L.bad;
  const bnm = checkNames(names, p);
  if (bnm) return bnm;
  if (!isInt(maxDepth) || maxDepth < 0) return refuse('maxDepth', 'must be a whole number, 0 or more (0 is a single leaf)');
  if (!isInt(minSamplesLeaf) || minSamplesLeaf < 1) return refuse('minSamplesLeaf', 'must be a whole number, 1 or more');
  if (!isInt(minSamplesSplit) || minSamplesSplit < 2) return refuse('minSamplesSplit', 'must be a whole number, 2 or more');
  const featureNames = names === undefined ? Array.from({ length: p }, (_, j) => `x${j + 1}`) : [...names];
  const classes = L.classes; const C = classes.length;
  const pos = new Map(classes.map((c, i) => [c, i]));
  const yi = Int32Array.from(y, (v) => pos.get(v));
  const col = Array.from({ length: p }, (_, j) => Float64Array.from(X, (r) => r[j]));
  const rootOrders = col.map((v) => Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => v[a] - v[b] || a - b));
  const nodes = [];
  const importance = new Array(p).fill(0);
  const mark = new Uint8Array(n);
  const build = (orders, depth) => {
    const rows = orders[0]; const m = rows.length;
    const counts = new Array(C).fill(0);
    for (let q = 0; q < m; q += 1) counts[yi[rows[q]]] += 1;
    const node = { id: nodes.length, depth, n: m, counts, gini: giniOf(counts, m), prediction: classes[argmaxFirst(counts)], leaf: true };
    nodes.push(node);
    const pure = counts.filter((c) => c > 0).length === 1;
    if (pure || depth >= maxDepth || m < minSamplesSplit || m < 2 * minSamplesLeaf) return node.id;
    let parentSq = 0; for (const c of counts) parentSq += c * c;
    let best = null;
    const cl = new Array(C); const cr = new Array(C);
    for (let f = 0; f < p; f += 1) {
      const ord = orders[f]; const v = col[f];
      cl.fill(0); for (let c = 0; c < C; c += 1) cr[c] = counts[c];
      let SL = 0; let SR = parentSq;
      for (let q = 0; q < m - 1; q += 1) {
        const c = yi[ord[q]];
        SL += 2 * cl[c] + 1; SR -= 2 * cr[c] - 1; cl[c] += 1; cr[c] -= 1;
        const a = v[ord[q]]; const b = v[ord[q + 1]];
        if (a === b) continue;
        const nL = q + 1; const nR = m - nL;
        if (nL < minSamplesLeaf || nR < minSamplesLeaf) continue;
        const score = SL / nL + SR / nR;
        let better = !best;
        if (best) {
          if (score > best.score * (1 + 1e-9)) better = true;
          else if (score >= best.score * (1 - 1e-9)) {
            // exact comparison on the integer counts: (SL nR + SR nL) / (nL nR)
            const lhs = (BigInt(SL) * BigInt(nR) + BigInt(SR) * BigInt(nL)) * BigInt(best.nL) * BigInt(best.nR);
            const rhs = (BigInt(best.SL) * BigInt(best.nR) + BigInt(best.SR) * BigInt(best.nL)) * BigInt(nL) * BigInt(nR);
            better = lhs > rhs;
          }
        }
        if (better) {
          let t = a / 2 + b / 2;
          if (t === b || !Number.isFinite(t)) t = a;
          best = { score, SL, SR, nL, nR, f, q, t };
        }
      }
    }
    if (!best) return node.id;
    // split only on a decrease above zero: (SL nR + SR nL) m > parentSq nL nR
    const lhs = (BigInt(best.SL) * BigInt(best.nR) + BigInt(best.SR) * BigInt(best.nL)) * BigInt(m);
    if (!(lhs > BigInt(parentSq) * BigInt(best.nL) * BigInt(best.nR))) return node.id;
    const ord = orders[best.f];
    for (let q = 0; q < m; q += 1) mark[ord[q]] = q <= best.q ? 1 : 0;
    const left = orders.map((o) => o.filter((r) => mark[r] === 1));
    const right = orders.map((o) => o.filter((r) => mark[r] === 0));
    node.leaf = false;
    node.featureIndex = best.f;
    node.feature = featureNames[best.f];
    node.threshold = best.t;
    node.left = build(left, depth + 1);
    node.right = build(right, depth + 1);
    const l = nodes[node.left]; const r = nodes[node.right];
    node.impurityDecrease = (m * node.gini - l.n * l.gini - r.n * r.gini) / n;
    importance[best.f] += m * node.gini - l.n * l.gini - r.n * r.gini;
    return node.id;
  };
  build(rootOrders, 0);
  const tot = importance.reduce((a, v) => a + v, 0);
  const featureImportances = importance.map((v) => (tot > 0 ? v / tot : 0));
  const model = { kind: 'cart', classes, names: featureNames, p, nodes };
  const lines = [];
  const show = (id, level) => {
    const nd = nodes[id];
    const pre = `${'|   '.repeat(level)}|--- `;
    if (nd.leaf) { lines.push(`${pre}class: ${nd.prediction} (n = ${nd.n}, counts ${nd.counts.join('/')})`); return; }
    lines.push(`${pre}${nd.feature} <= ${fmt(nd.threshold)}`);
    show(nd.left, level + 1);
    lines.push(`${pre}${nd.feature} >  ${fmt(nd.threshold)}`);
    show(nd.right, level + 1);
  };
  show(0, 0);
  const train = nodesPredict(model, X);
  let correct = 0; for (let i = 0; i < n; i += 1) if (train[i] === y[i]) correct += 1;
  return {
    ...model,
    nNodes: nodes.length,
    nLeaves: nodes.filter((d) => d.leaf).length,
    depth: nodes.reduce((a, d) => Math.max(a, d.depth), 0),
    featureImportances,
    trainingPredictions: train,
    trainingAccuracy: correct / n,
    printed: lines.join('\n'),
    maxDepth,
    minSamplesLeaf,
    minSamplesSplit,
    basis: {
      criterion: 'Gini impurity 1 - sum p_c^2; a split is scored by the weighted child impurity, the best has the largest decrease',
      thresholds: 'midpoints a/2 + b/2 of consecutive distinct values of the node (a when that rounds to b); x <= threshold goes left',
      ties: 'equal decreases (compared exactly on the integer counts) go to the lower feature index, then the lower threshold (scikit-learn breaks feature ties at random)',
      stopping: `a node is a leaf when pure, at depth maxDepth ${maxDepth} (the root is depth 0), with fewer than minSamplesSplit ${minSamplesSplit} rows, when no split leaves minSamplesLeaf ${minSamplesLeaf} rows each side, or when the best decrease is zero`,
      prediction: 'the majority class of the leaf; a tie goes to the class that sorts first',
      importance: 'sum over the feature\'s splits of n_t gini_t - n_L gini_L - n_R gini_R, normalised to sum 1 (scikit-learn feature_importances_); all 0 for a single leaf',
      nodes: 'numbered depth first, left before right (scikit-learn tree_ order)',
    },
  };
};

function nodesPredict(model, X) {
  return X.map((r) => {
    let nd = model.nodes[0];
    while (!nd.leaf) nd = model.nodes[r[nd.featureIndex] <= nd.threshold ? nd.left : nd.right];
    return nd.prediction;
  });
}

/** Predictions of a fitted CART tree, with the leaf of each row. */
export const cartPredict = ({ model, X } = {}) => {
  if (!model || model.kind !== 'cart' || !Array.isArray(model.nodes)) return refuse('model', 'must be the result of cartFit');
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  if (X[0].length !== model.p) return refuse('X', `must have ${model.p} columns, as the tree was fitted on`);
  const leaves = X.map((r) => {
    let nd = model.nodes[0];
    while (!nd.leaf) nd = model.nodes[r[nd.featureIndex] <= nd.threshold ? nd.left : nd.right];
    return nd.id;
  });
  return { predictions: leaves.map((id) => model.nodes[id].prediction), leaves, basis: { rule: 'from the root, x <= threshold goes left, until a leaf; the leaf\'s majority class' } };
};

/* ------------------------------------------------------------------ */
/* Cluster to facies matching and agreement. */

const contingency = (a, b) => {
  const ra = [...new Set(a)].sort(cmpLabel); const rb = [...new Set(b)].sort(cmpLabel);
  const pa = new Map(ra.map((v, i) => [v, i])); const pb = new Map(rb.map((v, i) => [v, i]));
  const M = ra.map(() => new Array(rb.length).fill(0));
  for (let i = 0; i < a.length; i += 1) M[pa.get(a[i])][pb.get(b[i])] += 1;
  return { rows: ra, cols: rb, M };
};

const ariFrom = (M, n) => {
  const c2 = (x) => (x * (x - 1)) / 2;
  let sij = 0; let sa = 0; let sb = 0;
  const colSums = new Array(M[0].length).fill(0);
  M.forEach((row) => { let r = 0; row.forEach((v, j) => { sij += c2(v); r += v; colSums[j] += v; }); sa += c2(r); });
  colSums.forEach((v) => { sb += c2(v); });
  const expected = (sa * sb) / c2(n);
  const mx = (sa + sb) / 2;
  if (mx - expected === 0) return 1;
  return (sij - expected) / (mx - expected);
};

const checkPair = (fa, a, fb, b) => {
  if (!Array.isArray(a) || a.length < 2) return refuse(fa, 'must be an array of at least 2 labels');
  const La = checkLabelArray(fa, a, a.length);
  if (La.bad) return La.bad;
  const Lb = checkLabelArray(fb, b, a.length);
  if (Lb.bad) return Lb.bad;
  return null;
};

/** Adjusted Rand index between two labelings of the same rows (Hubert and Arabie 1985). */
export const adjustedRandIndex = ({ a, b } = {}) => {
  const bad = checkPair('a', a, 'b', b);
  if (bad) return bad;
  const t = contingency(a, b);
  return {
    ari: ariFrom(t.M, a.length),
    contingency: t.M,
    rowLabels: t.rows,
    colLabels: t.cols,
    basis: {
      formula: '(sum C(n_ij, 2) - E) / (mean(sum C(a_i, 2), sum C(b_j, 2)) - E), E = sum C(a_i, 2) sum C(b_j, 2) / C(n, 2) (Hubert and Arabie 1985)',
      special: 'when the denominator is zero (both labelings one cluster, or both all singletons) the index is 1 (scikit-learn)',
    },
  };
};

/** Largest total of M[r][col[r]] over injective col (rows <= cols), Hungarian with potentials. */
const hungarianMax = (M) => {
  const nr = M.length; const nc = M[0].length;
  let big = 0; M.forEach((r) => r.forEach((v) => { if (v > big) big = v; }));
  const cost = (i, j) => big - M[i - 1][j - 1];
  const u = new Array(nr + 1).fill(0); const v = new Array(nc + 1).fill(0);
  const pcol = new Array(nc + 1).fill(0); const way = new Array(nc + 1).fill(0);
  for (let i = 1; i <= nr; i += 1) {
    pcol[0] = i; let j0 = 0;
    const minv = new Array(nc + 1).fill(Infinity); const used = new Array(nc + 1).fill(false);
    do {
      used[j0] = true; const i0 = pcol[j0]; let delta = Infinity; let j1 = 0;
      for (let j = 1; j <= nc; j += 1) {
        if (!used[j]) {
          const cur = cost(i0, j) - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= nc; j += 1) { if (used[j]) { u[pcol[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (pcol[j0] !== 0);
    do { const j1 = way[j0]; pcol[j0] = pcol[j1]; j0 = j1; } while (j0);
  }
  let total = 0;
  for (let j = 1; j <= nc; j += 1) if (pcol[j]) total += M[pcol[j] - 1][j - 1];
  return total;
};

/**
 * Matches unsupervised clusters to core facies, then scores the mapped
 * predictions with ml.js classificationReport. `mode` one-to-one (each
 * cluster a different facies, no more clusters than facies) or majority.
 */
export const matchClusters = ({ yTrue, clusters, mode = 'one-to-one', zeroDivision = 0 } = {}) => {
  const bad = checkPair('yTrue', yTrue, 'clusters', clusters);
  if (bad) return bad;
  if (mode !== 'one-to-one' && mode !== 'majority') return refuse('mode', "must be 'one-to-one' or 'majority'");
  const t = contingency(clusters, yTrue); // rows clusters, columns facies
  const nc = t.rows.length; const nf = t.cols.length;
  if (nc > DEFAULTS.MATCH_MAX_LABELS || nf > DEFAULTS.MATCH_MAX_LABELS) return refuse('clusters', `and yTrue must each hold at most ${DEFAULTS.MATCH_MAX_LABELS} distinct labels (found ${nc} clusters and ${nf} facies)`);
  const mapping = new Array(nc);
  let matched = 0;
  if (mode === 'one-to-one') {
    if (nc > nf) return refuse('clusters', `has ${nc} clusters, more than the ${nf} core facies: one-to-one matching would leave clusters unmatched; use mode 'majority' or fewer clusters`);
    let target = hungarianMax(t.M);
    const optimum = target;
    const usedF = new Array(nf).fill(false);
    for (let c = 0; c < nc; c += 1) {
      for (let f = 0; f < nf; f += 1) {
        if (usedF[f]) continue;
        const restRows = []; for (let r = c + 1; r < nc; r += 1) restRows.push(r);
        const restCols = []; for (let q = 0; q < nf; q += 1) if (!usedF[q] && q !== f) restCols.push(q);
        const rest = restRows.length ? hungarianMax(restRows.map((r) => restCols.map((q) => t.M[r][q]))) : 0;
        if (t.M[c][f] + rest === target) { mapping[c] = f; usedF[f] = true; target -= t.M[c][f]; break; }
      }
    }
    matched = optimum;
  } else {
    for (let c = 0; c < nc; c += 1) { mapping[c] = argmaxFirst(t.M[c]); matched += t.M[c][mapping[c]]; }
  }
  const map = new Map(t.rows.map((c, i) => [c, t.cols[mapping[i]]]));
  const yPred = clusters.map((c) => map.get(c));
  const report = classificationReport({ yTrue, yPred, labels: t.cols, zeroDivision });
  if (report.error) return report;
  return {
    mode,
    mapping: t.rows.map((c, i) => ({ cluster: c, facies: t.cols[mapping[i]], rows: t.M[i][mapping[i]], clusterSize: t.M[i].reduce((a, v) => a + v, 0) })),
    matchedRows: matched,
    contingency: t.M,
    clusterLabels: t.rows,
    faciesLabels: t.cols,
    yPred,
    report,
    ari: ariFrom(t.M, yTrue.length),
    basis: {
      mode: mode === 'one-to-one'
        ? 'one-to-one: each cluster to a different facies, maximising the rows matched (Hungarian); among equal totals the first mapping in cluster order that takes the first facies'
        : 'majority: each cluster to its most common facies (several clusters may share one); a tie goes to the facies that sorts first',
      contingency: 'contingency[i][j] counts rows in cluster clusterLabels[i] with core facies faciesLabels[j]',
      report: 'ml.js classificationReport of the mapped predictions against the core facies',
      ari: 'adjusted Rand index of the clusters against the facies (independent of the mapping)',
    },
  };
};
