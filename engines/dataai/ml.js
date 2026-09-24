/**
 * Machine learning on well data (Data & AI D2).
 *
 * Pure functions, no I/O. Inputs are plain arrays: a feature matrix X is an
 * array of rows (one row per sample, one column per feature), a target y is
 * an array of numbers, and groups is an array of well identifiers, one per
 * row. Every function returns either a result object or `{ error, field }`,
 * where `field` names the input it refused and the message starts with that
 * name and states the exact condition that failed. Every result carries a
 * `basis` naming the method and its conventions, so a course can print the
 * working.
 *
 * Conventions, stated once (FINDINGS-ml.md has the sources and the reasons):
 *   scaling       fitted on the TRAINING rows only (the rows passed, or
 *                 trainIndices) and applied unchanged to any other rows.
 *                 Standardisation divides by the POPULATION standard
 *                 deviation (n) by default, as scikit-learn's
 *                 StandardScaler; the sample SD (n - 1) is an option.
 *                 Min-max maps the training minimum to 0 and maximum to 1;
 *                 new rows are NOT clipped. A feature is refused as
 *                 constant when every training value is identical (exact
 *                 equality), and only then.
 *   shuffles      one mulberry32 stream (lib/stats) per call, seeded by
 *                 `seed`; Fisher-Yates from the END: for i = m - 1 down to
 *                 1, j = floor(u x (i + 1)), swap positions i and j.
 *   group order   group ids are all strings (sorted by UTF-16 code unit) or
 *                 all finite numbers (sorted ascending); the sorted list is
 *                 shuffled, then the first nTest groups are the test set.
 *   test size     ceil(testFraction x count), where a product within 1e-9
 *                 of a whole number is taken as that whole number (so
 *                 0.28 x 25 = 7.000000000000001 gives 7, not 8).
 *   k-fold        sorted ids shuffled once, then dealt round robin: the
 *                 group at shuffled position q goes to fold q mod k.
 *   OLS           Householder QR of the design with every column scaled to
 *                 unit Euclidean length (equilibration), back
 *                 substitution, then two steps of iterative refinement
 *                 by corrected semi-normal equations (Bjorck) with the
 *                 residual y - X beta and the gradient X'r carried in
 *                 double-double (Dekker TwoProduct, Knuth TwoSum). RSS is
 *                 the sum of squares of that final residual. Standard
 *                 errors s x sqrt(diag((X'X)^-1)) with s^2 = RSS / (n - p), p counting the intercept.
 *                 R^2 about the mean of y with an intercept, about zero
 *                 without one (uncentred), as NIST StRD and statsmodels.
 *                 Adjusted R^2 = 1 - (1 - R^2)(n - c) / (n - p), c = 1 with
 *                 an intercept, 0 without.
 *   conditioning  conditionNumber is the 2-norm condition number of the
 *                 design as given (intercept column of ones included);
 *                 scaledConditionNumber is that of the design with unit
 *                 length columns (Belsley). A fit is REFUSED when the
 *                 scaled condition number is above maxCondition (default
 *                 1e8).
 *                 At kappa = 1e8, kappa^2 x machine epsilon
 *                 (2.2e-16) is about 2, the classical worst-case bound for
 *                 a least squares solution, so no digit can be guaranteed
 *                 for some coefficient. A value exactly at the limit is
 *                 fitted.
 *   ridge         minimises sum (y - b0 - z'b)^2 + lambda x sum b_j^2 on
 *                 features standardised with the POPULATION SD of the
 *                 training rows; the intercept is NOT penalised (y is
 *                 centred). lambda is on the sum of squares, so it equals
 *                 scikit-learn Ridge's alpha on the same standardised
 *                 features. Solved by QR of [Z; sqrt(lambda) I].
 *   logistic      binary, labels 0 and 1, Newton-Raphson (IRLS) from
 *                 beta = 0, the intercept unpenalised under the optional
 *                 L2 term (l2 / 2) x sum beta_j^2. Stops when the largest
 *                 absolute component of the full Newton step is at most
 *                 tol (default 1e-10), or after maxIter (default 100)
 *                 updates with converged false. A step that lowers the
 *                 penalised log likelihood by more than 1e-12 x (1 + |l|)
 *                 is halved, up to 30 times; the full-step test means a
 *                 halved step can never fake convergence. The Newton
 *                 system is solved by solveSPD (relative pivot rule).
 *                 Separation is tested FIRST by the dual linear
 *                 programmes of Gordan and Stiemke (lib/lp): with l2 = 0
 *                 a separated sample is refused, with l2 > 0 it is fitted
 *                 and reported.
 *   metrics       R^2 on a test set uses the mean of the TEST targets
 *                 (scikit-learn r2_score) unless referenceMean is given.
 *                 Precision, recall and F1 = 2TP / (2TP + FP + FN) per
 *                 class; a zero denominator scores zeroDivision (default
 *                 0). Macro = unweighted mean over the labels, weighted =
 *                 mean weighted by support. ROC: positive label 1, one
 *                 point per DISTINCT score (equal scores move together, a
 *                 diagonal step), AUC by the trapezoid rule. Log loss
 *                 clips probabilities to [eps, 1 - eps], eps = 1e-15, and
 *                 averages the natural-log loss over the rows.
 *   prediction    a logistic probability above 0.5 is class 1; exactly 0.5
 *                 is class 0.
 *   reasons       figures in messages print as the shortest round-trip
 *                 decimal (ECMAScript Number to String).
 *
 * Reused, by import: lib/stats (mulberry32, mean), lib/lp/simplex (the
 * separation test). The Newton system is solved by this module's own
 * scale-aware Cholesky (solveSPD), NOT lib/linalg/solveDense, whose
 * absolute 1e-14 pivot test refuses well-conditioned systems with small
 * entries (FINDINGS-ml.md).
 *
 * Validation: tools/validation/dataai/oracle_ml.py (stdlib python, written
 * from the equations) writes test-data/dataai/goldens/ml_cases.json; the
 * NIST StRD linear regression certified values are published anchors in it.
 * A second witness (numpy, scikit-learn, statsmodels) is pinned in
 * test-data/dataai/pins/ml_pins.json by tools/validation/dataai/pin_ml.py.
 * Findings and the negative control: tools/validation/dataai/FINDINGS-ml.md,
 * negcontrol_ml.sh.
 */

import { mulberry32, mean as statsMean } from '../../lib/stats/stats.js';
import { solveLP, LP_STATUS } from '../../lib/lp/simplex.js';

/* ------------------------------------------------------------------ */
/* Constants. */

export const DEFAULTS = Object.freeze({
  MAX_CONDITION: 1e8, // OLS / ridge refusal on the scaled condition number
  LOGISTIC_TOL: 1e-10, // largest absolute coefficient change at convergence
  LOGISTIC_MAX_ITER: 100,
  STEP_HALVINGS: 30,
  LOG_LOSS_EPS: 1e-15,
  WHOLE_TOL: 1e-9, // a size product this close to a whole number is that number
});

/** Metric names, and whether a higher value is better. */
export const METRICS = Object.freeze({
  rmse: { higherIsBetter: false, task: 'regression' },
  mae: { higherIsBetter: false, task: 'regression' },
  r2: { higherIsBetter: true, task: 'regression' },
  accuracy: { higherIsBetter: true, task: 'classification' },
  logLoss: { higherIsBetter: false, task: 'classification' },
  auc: { higherIsBetter: true, task: 'classification' },
});

/* ------------------------------------------------------------------ */
/* Helpers. */

const refuse = (field, message) => ({ error: `${field} ${message}`, field });

const fmt = (x) => {
  if (x === Infinity) return 'infinity';
  if (x === -Infinity) return 'minus infinity';
  return String(x);
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Checks a feature matrix: rows of finite numbers, all the same length. */
const checkMatrix = (field, X, { minRows = 1 } = {}) => {
  if (!Array.isArray(X) || X.length < minRows) return refuse(field, `must be an array of at least ${minRows} rows`);
  if (!Array.isArray(X[0]) || X[0].length < 1) return refuse(`${field}[0]`, 'must be an array of at least one number');
  const p = X[0].length;
  for (let i = 0; i < X.length; i += 1) {
    if (!Array.isArray(X[i]) || X[i].length !== p) return refuse(`${field}[${i}]`, `must be an array of ${p} numbers, like row 0`);
    for (let j = 0; j < p; j += 1) {
      if (!isNum(X[i][j])) return refuse(`${field}[${i}][${j}]`, 'must be a finite number: fill or drop missing values first');
    }
  }
  return null;
};

const checkVector = (field, y, n) => {
  if (!Array.isArray(y) || y.length !== n) return refuse(field, `must be an array of ${n} numbers, one per row`);
  for (let i = 0; i < n; i += 1) if (!isNum(y[i])) return refuse(`${field}[${i}]`, 'must be a finite number');
  return null;
};

const checkNames = (names, p) => {
  if (names === undefined) return { names: Array.from({ length: p }, (_, j) => `x${j + 1}`) };
  if (!Array.isArray(names) || names.length !== p) return { bad: refuse('names', `must be an array of ${p} feature names, one per column`) };
  for (let j = 0; j < p; j += 1) {
    if (typeof names[j] !== 'string' || names[j].length === 0) return { bad: refuse(`names[${j}]`, 'must be a non-empty string') };
    if (names.indexOf(names[j]) !== j) return { bad: refuse(`names[${j}]`, `repeats the name ${names[j]}`) };
    if (names[j] === 'intercept') return { bad: refuse(`names[${j}]`, "must not be 'intercept', which names the constant term") };
  }
  return { names: [...names] };
};

const checkSeed = (seed) => (Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? null : refuse('seed', 'must be a whole number from 0 to 4294967295'));

/** Fisher-Yates from the end with the stated draw j = floor(u (i + 1)). */
const shuffleInPlace = (a, rng) => {
  for (let i = a.length - 1; i >= 1; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
};

/** ceil(f x m) with products within WHOLE_TOL of a whole number taken as it. */
const ceilCount = (f, m) => {
  const t = f * m;
  const r = Math.round(t);
  return Math.abs(t - r) <= DEFAULTS.WHOLE_TOL ? r : Math.ceil(t);
};

/** Sorted distinct group ids, or a refusal. */
const groupIds = (groups) => {
  if (!Array.isArray(groups) || groups.length === 0) return { bad: refuse('groups', 'must be a non-empty array of group (well) identifiers, one per row') };
  const kind = typeof groups[0];
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    if (typeof g === 'string') { if (kind !== 'string') return { bad: refuse(`groups[${i}]`, 'must be the same type as groups[0]: all strings or all numbers') }; }
    else if (isNum(g)) { if (kind !== 'number') return { bad: refuse(`groups[${i}]`, 'must be the same type as groups[0]: all strings or all numbers') }; }
    else return { bad: refuse(`groups[${i}]`, 'must be a string or a finite number') };
  }
  const ids = [...new Set(groups)];
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ids };
};

const indicesOf = (groups, set) => {
  const out = [];
  groups.forEach((g, i) => { if (set.has(g)) out.push(i); });
  return out;
};

const pick = (arr, idx) => idx.map((i) => arr[i]);

/* ------------------------------------------------------------------ */
/* Dense linear algebra (small p). */

/**
 * Householder QR of an m x p matrix A (array of rows, m >= p), in place on
 * a copy. Returns R (p x p upper) and a function applying Q' to a vector.
 */
const householderQR = (A) => {
  const m = A.length;
  const p = A[0].length;
  const a = A.map((r) => r.slice());
  const vs = [];
  const betas = [];
  for (let k = 0; k < p; k += 1) {
    let norm = 0;
    for (let i = k; i < m; i += 1) norm = Math.hypot(norm, a[i][k]);
    const v = new Array(m - k).fill(0);
    if (norm === 0) { vs.push(v); betas.push(0); continue; }
    const alpha = a[k][k] > 0 ? -norm : norm;
    for (let i = k; i < m; i += 1) v[i - k] = a[i][k];
    v[0] -= alpha;
    let vv = 0;
    for (let i = 0; i < v.length; i += 1) vv += v[i] * v[i];
    const beta = vv === 0 ? 0 : 2 / vv;
    for (let j = k; j < p; j += 1) {
      let s = 0;
      for (let i = k; i < m; i += 1) s += v[i - k] * a[i][j];
      s *= beta;
      for (let i = k; i < m; i += 1) a[i][j] -= s * v[i - k];
    }
    vs.push(v); betas.push(beta);
  }
  const R = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (__, j) => (j >= i ? a[i][j] : 0)));
  const applyQt = (y) => {
    const b = y.slice();
    for (let k = 0; k < p; k += 1) {
      const v = vs[k];
      let s = 0;
      for (let i = k; i < m; i += 1) s += v[i - k] * b[i];
      s *= betas[k];
      for (let i = k; i < m; i += 1) b[i] -= s * v[i - k];
    }
    return b;
  };
  return { R, applyQt };
};

const backSolve = (R, c) => {
  const p = R.length;
  const x = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i -= 1) {
    let s = c[i];
    for (let j = i + 1; j < p; j += 1) s -= R[i][j] * x[j];
    x[i] = s / R[i][i];
  }
  return x;
};

/** Inverse of an upper triangular matrix by back substitution. */
const invUpper = (R) => {
  const p = R.length;
  const inv = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < p; j += 1) {
    const e = new Array(p).fill(0); e[j] = 1;
    const col = backSolve(R, e);
    for (let i = 0; i < p; i += 1) inv[i][j] = col[i];
  }
  return inv;
};

/**
 * Singular values of a small square matrix by one-sided Jacobi (Hestenes):
 * rotate column pairs until every pair is orthogonal to working precision;
 * the singular values are then the column lengths.
 */
const singularValues = (M) => {
  const p = M.length;
  const a = M.map((r) => r.slice());
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let j = 0; j < p - 1; j += 1) {
      for (let k = j + 1; k < p; k += 1) {
        let alpha = 0; let beta = 0; let gamma = 0;
        for (let i = 0; i < p; i += 1) { alpha += a[i][j] * a[i][j]; beta += a[i][k] * a[i][k]; gamma += a[i][j] * a[i][k]; }
        if (gamma === 0 || Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta)) continue;
        off = Math.max(off, Math.abs(gamma) / Math.sqrt(alpha * beta));
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let i = 0; i < p; i += 1) {
          const x = a[i][j]; const y = a[i][k];
          a[i][j] = c * x - s * y;
          a[i][k] = s * x + c * y;
        }
      }
    }
    if (off === 0) break;
  }
  const sv = [];
  for (let j = 0; j < p; j += 1) { let s = 0; for (let i = 0; i < p; i += 1) s = Math.hypot(s, a[i][j]); sv.push(s); }
  return sv.sort((x, y) => y - x);
};

const condFrom = (sv) => (sv[sv.length - 1] === 0 ? Infinity : sv[0] / sv[sv.length - 1]);

/* ------------------------------------------------------------------ */
/* Preprocessing. */

const fitRows = (X, trainIndices) => {
  if (trainIndices === undefined) return { rows: X, idx: null };
  if (!Array.isArray(trainIndices) || trainIndices.length === 0) return { bad: refuse('trainIndices', 'must be a non-empty array of row numbers') };
  const seen = new Set();
  for (let k = 0; k < trainIndices.length; k += 1) {
    const i = trainIndices[k];
    if (!Number.isInteger(i) || i < 0 || i >= X.length) return { bad: refuse(`trainIndices[${k}]`, `must be a whole number from 0 to ${X.length - 1}`) };
    if (seen.has(i)) return { bad: refuse(`trainIndices[${k}]`, `repeats row ${i}`) };
    seen.add(i);
  }
  return { rows: pick(X, trainIndices), idx: [...trainIndices] };
};

/**
 * Standardisation (z) fitted on the training rows only: the rows of X, or
 * the rows trainIndices picks. Returns the fitted centre and scale per
 * feature; applyScaler applies them to any rows.
 */
export const fitStandardScaler = ({ X, trainIndices, names, sd = 'population' } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const p = X[0].length;
  const nm = checkNames(names, p);
  if (nm.bad) return nm.bad;
  if (sd !== 'population' && sd !== 'sample') return refuse('sd', "must be 'population' or 'sample'");
  const fr = fitRows(X, trainIndices);
  if (fr.bad) return fr.bad;
  const rows = fr.rows;
  const n = rows.length;
  if (sd === 'sample' && n < 2) return refuse('X', 'must have at least 2 training rows for the sample standard deviation');
  const centre = [];
  const scale = [];
  for (let j = 0; j < p; j += 1) {
    const col = rows.map((r) => r[j]);
    if (col.every((v) => v === col[0])) {
      return refuse(`X.${nm.names[j]}`, `has zero variance on the ${n} training rows (every value is ${fmt(col[0])}): standardising would divide by zero, so drop the feature or fit on rows where it varies`);
    }
    const m = statsMean(col);
    let s2 = 0;
    for (let i = 0; i < n; i += 1) s2 += (col[i] - m) ** 2;
    centre.push(m);
    scale.push(Math.sqrt(s2 / (sd === 'sample' ? n - 1 : n)));
  }
  return {
    kind: 'standard',
    names: nm.names,
    nFit: n,
    fitIndices: fr.idx,
    centre,
    scale,
    basis: {
      method: 'z = (x - mean) / sd, per feature',
      sd: sd === 'sample' ? 'sample standard deviation (n - 1)' : 'population standard deviation (n), as scikit-learn StandardScaler',
      fittedOn: fr.idx ? 'the rows listed in trainIndices only' : 'the rows of X passed (the training rows)',
      constant: 'a feature whose training values are all identical is refused by name',
    },
  };
};

/** Min-max scaling to [0, 1] fitted on the training rows only; new rows are not clipped. */
export const fitMinMaxScaler = ({ X, trainIndices, names } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const p = X[0].length;
  const nm = checkNames(names, p);
  if (nm.bad) return nm.bad;
  const fr = fitRows(X, trainIndices);
  if (fr.bad) return fr.bad;
  const rows = fr.rows;
  const centre = [];
  const scale = [];
  const min = [];
  const max = [];
  for (let j = 0; j < p; j += 1) {
    const col = rows.map((r) => r[j]);
    let lo = col[0];
    let hi = col[0];
    for (let i = 1; i < col.length; i += 1) { if (col[i] < lo) lo = col[i]; if (col[i] > hi) hi = col[i]; }
    if (lo === hi) return refuse(`X.${nm.names[j]}`, `has zero range on the ${rows.length} training rows (every value is ${fmt(lo)}): min-max scaling would divide by zero, so drop the feature or fit on rows where it varies`);
    min.push(lo); max.push(hi); centre.push(lo); scale.push(hi - lo);
  }
  return {
    kind: 'minmax',
    names: nm.names,
    nFit: rows.length,
    fitIndices: fr.idx,
    min,
    max,
    centre,
    scale,
    basis: {
      method: 'x_scaled = (x - min) / (max - min), per feature, min and max of the training rows',
      fittedOn: fr.idx ? 'the rows listed in trainIndices only' : 'the rows of X passed (the training rows)',
      clipping: 'none: a new row outside the training range maps outside [0, 1]',
      constant: 'a feature whose training values are all identical is refused by name',
    },
  };
};

/** Applies a fitted scaler (standard or min-max) to any rows. */
export const applyScaler = ({ scaler, X } = {}) => {
  if (!scaler || (scaler.kind !== 'standard' && scaler.kind !== 'minmax') || !Array.isArray(scaler.centre) || !Array.isArray(scaler.scale)) {
    return refuse('scaler', 'must be the result of fitStandardScaler or fitMinMaxScaler');
  }
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const p = scaler.centre.length;
  if (X[0].length !== p) return refuse('X', `must have ${p} columns, as the scaler was fitted on`);
  return {
    X: X.map((r) => r.map((v, j) => (v - scaler.centre[j]) / scaler.scale[j])),
    basis: { applied: `${scaler.kind} scaler fitted on ${scaler.nFit} training rows; parameters unchanged` },
  };
};

/* ------------------------------------------------------------------ */
/* Splits. */

const checkFraction = (field, f) => (isNum(f) && f > 0 && f < 1 ? null : refuse(field, 'must be a number strictly between 0 and 1'));

const splitBasis = {
  shuffle: 'mulberry32(seed); Fisher-Yates from the end, j = floor(u x (i + 1))',
  order: 'group ids sorted (numbers ascending, strings by UTF-16 code unit) before the shuffle',
  testSize: 'ceil(testFraction x count), a product within 1e-9 of a whole number taken as that number',
};

/**
 * Group split: whole groups (wells) go to the test set, so no well has
 * rows on both sides. The sorted group ids are shuffled with the seed and
 * the first nTest are held out; `order` is the whole shuffled list.
 */
export const groupSplit = ({ groups, testFraction, nTestGroups, seed } = {}) => {
  const g = groupIds(groups);
  if (g.bad) return g.bad;
  const bs = checkSeed(seed);
  if (bs) return bs;
  const G = g.ids.length;
  if (G < 2) return refuse('groups', `must hold at least 2 distinct groups to hold one out (found ${G})`);
  let nTest;
  if (nTestGroups !== undefined) {
    if (testFraction !== undefined) return refuse('nTestGroups', 'and testFraction cannot both be given');
    if (!Number.isInteger(nTestGroups) || nTestGroups < 1 || nTestGroups > G - 1) return refuse('nTestGroups', `must be a whole number from 1 to ${G - 1} (one fewer than the ${G} groups)`);
    nTest = nTestGroups;
  } else {
    const bf = checkFraction('testFraction', testFraction);
    if (bf) return bf;
    nTest = ceilCount(testFraction, G);
    if (nTest > G - 1) return refuse('testFraction', `puts all ${G} groups in the test set (ceil(${fmt(testFraction)} x ${G}) = ${nTest}): lower it so at least one group trains`);
  }
  const order = shuffleInPlace(g.ids.slice(), mulberry32(seed));
  const test = new Set(order.slice(0, nTest));
  const trainGroups = g.ids.filter((x) => !test.has(x));
  const testGroups = g.ids.filter((x) => test.has(x));
  const trainIndices = [];
  const testIndices = [];
  groups.forEach((x, i) => (test.has(x) ? testIndices : trainIndices).push(i));
  return {
    trainIndices,
    testIndices,
    trainGroups,
    testGroups,
    sharedGroups: [],
    order,
    nGroups: G,
    nTestGroups: nTest,
    seed,
    basis: { ...splitBasis, rule: 'the first nTest groups of the shuffled order are the test set; every row of a group goes with it' },
  };
};

/**
 * Group k-fold: the sorted ids are shuffled once and dealt round robin,
 * so shuffled position q goes to fold q mod k. Fold f tests on its groups
 * and trains on all the others.
 */
export const groupKFold = ({ groups, k, seed } = {}) => {
  const g = groupIds(groups);
  if (g.bad) return g.bad;
  const bs = checkSeed(seed);
  if (bs) return bs;
  const G = g.ids.length;
  if (!Number.isInteger(k) || k < 2 || k > G) return refuse('k', `must be a whole number from 2 to ${G} (the number of distinct groups)`);
  const order = shuffleInPlace(g.ids.slice(), mulberry32(seed));
  const foldOf = new Map(order.map((id, q) => [id, q % k]));
  const folds = [];
  for (let f = 0; f < k; f += 1) {
    const testGroups = g.ids.filter((x) => foldOf.get(x) === f);
    const trainGroups = g.ids.filter((x) => foldOf.get(x) !== f);
    const trainIndices = [];
    const testIndices = [];
    groups.forEach((x, i) => (foldOf.get(x) === f ? testIndices : trainIndices).push(i));
    folds.push({ fold: f, trainIndices, testIndices, trainGroups, testGroups, sharedGroups: [] });
  }
  return { k, nGroups: G, order, seed, folds, basis: { ...splitBasis, rule: 'shuffled position q goes to fold q mod k; each fold tests on its groups and trains on every other group' } };
};

/**
 * Random row split. It EXISTS ONLY TO DEMONSTRATE LEAKAGE: rows of one
 * well land on both sides, so the test score measures interpolation inside
 * wells the model has seen. `sharedGroups` lists the wells on both sides.
 */
export const randomRowSplit = ({ n, groups, testFraction, seed } = {}) => {
  let m = n;
  if (groups !== undefined) {
    const g = groupIds(groups);
    if (g.bad) return g.bad;
    if (m !== undefined && m !== groups.length) return refuse('n', `must equal the length of groups (${groups.length}) when both are given`);
    m = groups.length;
  }
  if (!Number.isInteger(m) || m < 2) return refuse('n', 'must be a whole number of rows, 2 or more (or give groups)');
  const bs = checkSeed(seed);
  if (bs) return bs;
  const bf = checkFraction('testFraction', testFraction);
  if (bf) return bf;
  const nTest = ceilCount(testFraction, m);
  if (nTest > m - 1) return refuse('testFraction', `puts all ${m} rows in the test set (ceil(${fmt(testFraction)} x ${m}) = ${nTest}): lower it so at least one row trains`);
  const order = shuffleInPlace(Array.from({ length: m }, (_, i) => i), mulberry32(seed));
  const testSet = new Set(order.slice(0, nTest));
  const testIndices = [];
  const trainIndices = [];
  for (let i = 0; i < m; i += 1) (testSet.has(i) ? testIndices : trainIndices).push(i);
  const out = { trainIndices, testIndices, nTest, seed };
  if (groups !== undefined) {
    const { ids } = groupIds(groups);
    const tr = new Set(pick(groups, trainIndices));
    const te = new Set(pick(groups, testIndices));
    out.trainGroups = ids.filter((x) => tr.has(x));
    out.testGroups = ids.filter((x) => te.has(x));
    out.sharedGroups = ids.filter((x) => tr.has(x) && te.has(x));
  }
  out.basis = {
    shuffle: splitBasis.shuffle,
    testSize: splitBasis.testSize,
    rule: 'the first nTest rows of the shuffled row order are the test set',
    purpose: 'leakage demonstration only: rows of one well can fall on both sides (sharedGroups); use groupSplit or groupKFold to score a model',
  };
  return out;
};

/* ------------------------------------------------------------------ */
/* Linear models. */

const designMatrix = (X, intercept) => (intercept ? X.map((r) => [1, ...r]) : X.map((r) => r.slice()));

/**
 * Least squares by Householder QR on the equilibrated design. Returns the
 * coefficients, R of the scaled design and the Q'y tail sum of squares.
 */
/**
 * y - sum_j a_j (z_j / d_j) with the products and sums carried in
 * double-double (Dekker TwoProduct via the Veltkamp split, Knuth TwoSum),
 * so the refinement step sees the residual to about twice working
 * precision.
 */
const SPLIT = 134217729; // 2^27 + 1
const twoProd = (a, b) => {
  const p = a * b;
  let t = SPLIT * a; const ah = t - (t - a); const al = a - ah;
  t = SPLIT * b; const bh = t - (t - b); const bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
};
const twoSum = (a, b) => { const s = a + b; const bb = s - a; return [s, (a - (s - bb)) + (b - bb)]; };
const compensatedResidual = (y, row, beta) => {
  let hi = y; let lo = 0;
  for (let j = 0; j < row.length; j += 1) {
    const [ph, pl] = twoProd(row[j], -beta[j]);
    const [sh, sl] = twoSum(hi, ph);
    hi = sh; lo += sl + pl;
  }
  return twoSum(hi, lo); // [head, tail]: the residual to about twice working precision
};

/** sum_i a_i (r_i head + r_i tail), products and sums in double-double. */
const compensatedDot = (a, r) => {
  let hi = 0; let lo = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let h = 0; h < 2; h += 1) {
      const [ph, pl] = twoProd(a[i], r[i][h]);
      const [sh, sl] = twoSum(hi, ph);
      hi = sh; lo += sl + pl;
    }
  }
  return hi + lo;
};

/** Solves R'w = g for upper triangular R (forward substitution on R'). */
const forwardSolveT = (R, g) => {
  const p = R.length;
  const w = new Array(p).fill(0);
  for (let i = 0; i < p; i += 1) {
    let s = g[i];
    for (let k = 0; k < i; k += 1) s -= R[k][i] * w[k];
    w[i] = s / R[i][i];
  }
  return w;
};

const REFINE_STEPS = 2;

/** R of the Householder QR of A with unit-length columns (no solve). */
const equilibratedR = (A) => {
  const p = A[0].length;
  const d = new Array(p).fill(0);
  for (let j = 0; j < p; j += 1) { let s = 0; for (let i = 0; i < A.length; i += 1) s = Math.hypot(s, A[i][j]); d[j] = s; }
  return householderQR(A.map((r) => r.map((v, j) => v / d[j]))).R;
};

const qrSolve = (A, y) => {
  const m = A.length;
  const p = A[0].length;
  const d = [];
  for (let j = 0; j < p; j += 1) { let s = 0; for (let i = 0; i < m; i += 1) s = Math.hypot(s, A[i][j]); d.push(s); }
  const As = A.map((r) => r.map((v, j) => v / d[j]));
  const qr = householderQR(As);
  const c = qr.applyQt(y);
  const z = backSolve(qr.R, c.slice(0, p));
  // iterative refinement by corrected semi-normal equations (Bjorck) in the
  // ORIGINAL units: the residual r = y - A beta and the gradient A'r are
  // carried in double-double, the correction solves R'R dz = D^-1 A'r with
  // the same R and is unscaled, beta_j += dz_j / d_j
  const beta = z.map((v, j) => v / d[j]);
  for (let it = 0; it < REFINE_STEPS; it += 1) {
    const r = y.map((v, i) => compensatedResidual(v, A[i], beta));
    const g = new Array(p).fill(0);
    for (let j = 0; j < p; j += 1) g[j] = compensatedDot(A.map((row) => row[j]), r) / d[j];
    const dz = backSolve(qr.R, forwardSolveT(qr.R, g));
    for (let j = 0; j < p; j += 1) beta[j] += dz[j] / d[j];
  }
  // the final residual, in double-double, and its sum of squares
  const rr = y.map((v, i) => compensatedResidual(v, A[i], beta));
  const residuals = rr.map(([h, t]) => h + t);
  const rss = compensatedDot(residuals, rr);
  return { beta, d, Rs: qr.R, rss, residuals };
};

const conditionNumbers = (Rs, d) => {
  const scaled = condFrom(singularValues(Rs));
  const raw = condFrom(singularValues(Rs.map((r) => r.map((v, j) => v * d[j]))));
  return { scaled, raw };
};

const condRefusal = (field, kappa, maxCondition, what) => refuse(field,
  `is too ill-conditioned for a float64 ${what}: the scaled condition number ${fmt(kappa)} is above maxCondition ${fmt(maxCondition)}, so some coefficients could carry no reliable digits; drop or combine collinear features, centre or rescale them, or raise maxCondition knowingly`);

/**
 * Ordinary least squares, with an intercept by default. Refused when there
 * are not more rows than coefficients, when a column is all zeros or the
 * design is rank deficient (scaled condition number infinite or above
 * maxCondition), and when R^2 is undefined (the target does not vary
 * about its mean, or is all zero without an intercept).
 */
export const ols = ({ X, y, names, intercept = true, maxCondition = DEFAULTS.MAX_CONDITION } = {}) => {
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const n = X.length;
  const by = checkVector('y', y, n);
  if (by) return by;
  const nm = checkNames(names, X[0].length);
  if (nm.bad) return nm.bad;
  if (typeof intercept !== 'boolean') return refuse('intercept', 'must be true or false');
  if (!(isNum(maxCondition) && maxCondition >= 1)) return refuse('maxCondition', 'must be a finite number, 1 or more');
  const A = designMatrix(X, intercept);
  const p = A[0].length;
  if (n <= p) return refuse('X', `must have more rows than coefficients (${n} rows for ${p} coefficients${intercept ? ', the intercept included' : ''}): the residual degrees of freedom n - p must be at least 1`);
  const allNames = intercept ? ['intercept', ...nm.names] : nm.names;
  for (let j = 0; j < p; j += 1) {
    if (A.every((r) => r[j] === 0)) return refuse(`X.${allNames[j]}`, 'is zero in every row, so its coefficient is not identifiable');
  }
  const ybar = statsMean(y);
  let tss = 0;
  for (let i = 0; i < n; i += 1) tss += intercept ? (y[i] - ybar) ** 2 : y[i] * y[i];
  if (!(tss > 0)) return refuse('y', intercept ? 'has zero variance about its mean (every value is equal), so R-squared is undefined' : 'is zero in every row, so the uncentred R-squared is undefined');
  const s = qrSolve(A, y);
  const cond = conditionNumbers(s.Rs, s.d);
  if (!(cond.scaled <= maxCondition)) return condRefusal('X', cond.scaled, maxCondition, 'least squares fit');
  const dfResidual = n - p;
  const sigma2 = s.rss / dfResidual;
  const Rinv = invUpper(s.Rs);
  const se = Rinv.map((row, j) => {
    let q = 0;
    for (let k = 0; k < p; k += 1) q += row[k] * row[k];
    return Math.sqrt(sigma2 * q) / s.d[j];
  });
  const residuals = s.residuals;
  const fitted = y.map((v, i) => v - residuals[i]);
  const r2 = 1 - s.rss / tss;
  const cdf = intercept ? 1 : 0;
  return {
    kind: 'ols',
    intercept,
    names: allNames,
    n,
    p,
    dfResidual,
    coefficients: s.beta,
    standardErrors: se,
    tValues: s.beta.map((b, j) => b / se[j]),
    residualSE: Math.sqrt(sigma2),
    rss: s.rss,
    tss,
    rSquared: r2,
    adjustedRSquared: 1 - (1 - r2) * (n - cdf) / dfResidual,
    conditionNumber: cond.raw,
    scaledConditionNumber: cond.scaled,
    fitted,
    residuals,
    basis: {
      method: 'Householder QR of the design with unit-length columns, back substitution, then two steps of iterative refinement by corrected semi-normal equations with the residual and gradient in double-double',
      standardErrors: 's x sqrt(diag((X\'X)^-1)), s^2 = RSS / (n - p), p counting the intercept',
      rSquared: intercept ? '1 - RSS / sum (y - mean y)^2 (centred)' : '1 - RSS / sum y^2 (uncentred, no intercept)',
      adjustedRSquared: `1 - (1 - R^2)(n - ${cdf}) / (n - p)`,
      conditionNumber: '2-norm condition number of the design as given (singular values by one-sided Jacobi on R)',
      scaledConditionNumber: `2-norm condition number of the design with unit-length columns; refused above maxCondition ${fmt(maxCondition)}`,
      residuals: 'y - X beta at the refined beta, carried in double-double; rss is their sum of squares',
    },
  };
};

/**
 * Ridge regression in closed form on standardised features. The intercept
 * is the training mean of y and is not penalised; lambda multiplies the
 * sum of squared standardised coefficients (scikit-learn Ridge alpha on the
 * same standardised features). Coefficients come back in both the
 * standardised and the original units.
 */
export const ridge = ({ X, y, lambda, names, maxCondition = DEFAULTS.MAX_CONDITION } = {}) => {
  const bad = checkMatrix('X', X, { minRows: 2 });
  if (bad) return bad;
  const n = X.length;
  const by = checkVector('y', y, n);
  if (by) return by;
  if (!(isNum(lambda) && lambda >= 0)) return refuse('lambda', 'must be a finite number, zero or more');
  if (!(isNum(maxCondition) && maxCondition >= 1)) return refuse('maxCondition', 'must be a finite number, 1 or more');
  const scaler = fitStandardScaler({ X, names });
  if (scaler.error) return scaler;
  const p = X[0].length;
  const Z = X.map((r) => r.map((v, j) => (v - scaler.centre[j]) / scaler.scale[j]));
  const ybar = statsMean(y);
  const yc = y.map((v) => v - ybar);
  const rl = Math.sqrt(lambda);
  const A = [...Z, ...Array.from({ length: p }, (_, j) => Array.from({ length: p }, (__, k) => (j === k ? rl : 0)))];
  const b = [...yc, ...new Array(p).fill(0)];
  const s = qrSolve(A, b);
  const cond = conditionNumbers(s.Rs, s.d);
  if (!(cond.scaled <= maxCondition)) return condRefusal('X', cond.scaled, maxCondition, 'ridge fit');
  const bs = s.beta;
  const coef = bs.map((v, j) => v / scaler.scale[j]);
  const b0 = ybar - coef.reduce((acc, v, j) => acc + v * scaler.centre[j], 0);
  // effective degrees of freedom sum d_i^2 / (d_i^2 + lambda), d_i the singular values of Z
  const Zp = Z.length >= p ? Z : [...Z, ...Array.from({ length: p - Z.length }, () => new Array(p).fill(0))];
  const zqr = qrSolve(Zp, new Array(Zp.length).fill(0));
  const dz = singularValues(zqr.Rs.map((r) => r.map((v, j) => v * zqr.d[j])));
  const edf = dz.reduce((acc, di) => acc + (di * di === 0 && lambda === 0 ? 0 : (di * di) / (di * di + lambda)), 0);
  const fitted = Z.map((r) => ybar + r.reduce((acc, v, j) => acc + v * bs[j], 0));
  let rss = 0; let tss = 0;
  for (let i = 0; i < n; i += 1) { rss += (y[i] - fitted[i]) ** 2; tss += yc[i] * yc[i]; }
  return {
    kind: 'ridge',
    intercept: true,
    lambda,
    names: ['intercept', ...scaler.names],
    n,
    coefficients: [b0, ...coef],
    standardizedCoefficients: [ybar, ...bs],
    scaler: { centre: scaler.centre, scale: scaler.scale },
    effectiveDegreesOfFreedom: edf,
    rss,
    rSquared: tss > 0 ? 1 - rss / tss : null,
    scaledConditionNumber: cond.scaled,
    fitted,
    basis: {
      objective: 'sum (y - b0 - z\'b)^2 + lambda x sum b_j^2, the intercept b0 not penalised',
      features: 'z = (x - mean) / sd with the population SD (n) of the rows passed',
      lambda: 'on the sum of squares: equals scikit-learn Ridge(alpha = lambda, fit_intercept = True) on the same standardised features',
      method: 'Householder QR of [Z; sqrt(lambda) I] against [y - mean y; 0]',
      originalUnits: 'b_j / sd_j, intercept mean y - sum b_j mean_j / sd_j',
      effectiveDegreesOfFreedom: 'sum d_i^2 / (d_i^2 + lambda), d_i the singular values of Z (intercept not counted)',
    },
  };
};

/* ------------------------------------------------------------------ */
/* Scale-aware symmetric positive definite solve. */

/**
 * Cholesky factor of a symmetric matrix after scaling it to unit diagonal
 * (Hs = D^-1/2 H D^-1/2). The rule is RELATIVE: a diagonal entry at or
 * below zero, or a pivot of the unit-diagonal factorisation at or below
 * p x machine epsilon (p x 2.220446049250313e-16), means singular to
 * working precision. Scaling a variable by any factor leaves the decision
 * unchanged, unlike an absolute pivot threshold.
 */
const cholScaled = (H) => {
  const p = H.length;
  const tol = p * Number.EPSILON;
  const r = new Array(p);
  for (let k = 0; k < p; k += 1) {
    if (!(H[k][k] > 0)) return { singular: true, k, pivot: H[k][k], diagonal: true, tol };
    r[k] = Math.sqrt(H[k][k]);
  }
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < p; j += 1) {
    let d = H[j][j] / (r[j] * r[j]);
    for (let k = 0; k < j; k += 1) d -= L[j][k] * L[j][k];
    if (!(d > tol)) return { singular: true, k: j, pivot: d, diagonal: false, tol };
    const ljj = Math.sqrt(d);
    L[j][j] = ljj;
    for (let i = j + 1; i < p; i += 1) {
      let v = H[i][j] / (r[i] * r[j]);
      for (let k = 0; k < j; k += 1) v -= L[i][k] * L[j][k];
      L[i][j] = v / ljj;
    }
  }
  let minPivot = Infinity;
  for (let j = 0; j < p; j += 1) minPivot = Math.min(minPivot, L[j][j] * L[j][j]);
  return { L, r, minPivot, tol };
};

const cholSolve = ({ L, r }, b) => {
  const p = L.length;
  const z = new Array(p);
  for (let i = 0; i < p; i += 1) {
    let s = b[i] / r[i];
    for (let k = 0; k < i; k += 1) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
  }
  const x = new Array(p);
  for (let i = p - 1; i >= 0; i -= 1) {
    let s = z[i];
    for (let k = i + 1; k < p; k += 1) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x.map((v, i) => v / r[i]);
};

const singularText = (f) => (f.diagonal
  ? `diagonal entry ${f.k + 1} is ${fmt(f.pivot)}, at or below zero, so the matrix is not positive definite`
  : `pivot ${f.k + 1} of the Cholesky factorisation of the unit-diagonal scaled matrix is ${fmt(f.pivot)}, at or below p x machine epsilon = ${fmt(f.tol)}`);

/**
 * Solves A x = b for a symmetric positive definite A (the Newton system of
 * the logistic fit) by Cholesky on the unit-diagonal scaling of A, with the
 * relative singularity rule of cholScaled. Only the lower triangle of A is
 * read. Returns x, the smallest scaled pivot and the rule.
 */
export const solveSPD = ({ A, b } = {}) => {
  if (!Array.isArray(A) || A.length === 0) return refuse('A', 'must be a non-empty square array of rows');
  const p = A.length;
  for (let i = 0; i < p; i += 1) {
    if (!Array.isArray(A[i]) || A[i].length !== p) return refuse(`A[${i}]`, `must be an array of ${p} numbers (A is square)`);
    for (let j = 0; j < p; j += 1) if (!isNum(A[i][j])) return refuse(`A[${i}][${j}]`, 'must be a finite number');
  }
  const bb = checkVector('b', b, p);
  if (bb) return bb;
  const f = cholScaled(A);
  if (f.singular) return refuse('A', `is singular to working precision: ${singularText(f)}`);
  return {
    x: cholSolve(f, b),
    minScaledPivot: f.minPivot,
    pivotTolerance: f.tol,
    basis: {
      method: 'Cholesky of D^-1/2 A D^-1/2 (unit diagonal), D = diag(A); lower triangle read',
      rule: 'singular when a diagonal entry is at or below zero or a scaled pivot is at or below p x machine epsilon; the rule is relative, so rescaling a variable never changes it',
    },
  };
};

/* ------------------------------------------------------------------ */
/* Logistic regression. */

const sigmoid = (t) => (t >= 0 ? 1 / (1 + Math.exp(-t)) : Math.exp(t) / (1 + Math.exp(t)));
const softplus = (t) => (t > 0 ? t + Math.log1p(Math.exp(-t)) : Math.log1p(Math.exp(t)));

/**
 * Separation test by linear programming, on the DUAL side so the tableau
 * has p + 1 (or p) rows whatever the number of samples; every pivot is
 * O(p n) and the pivot count does not grow with n (FINDINGS-ml.md has the
 * timings). S is the design with row i multiplied by s_i (+1 for y = 1,
 * -1 for y = 0) and every column divided by its largest absolute value.
 *
 *   Gordan's theorem: exactly one holds, (a) some beta has S beta > 0
 *   (COMPLETE separation), or (b) some w >= 0, w != 0, has S'w = 0.
 *   Tested first, by the LP  S'w = 0, sum w = 1, w >= 0.
 *   Stiemke's theorem: exactly one holds, (a) some beta has S beta >= 0
 *   and S beta != 0 (separated, completely or quasi-completely), or
 *   (b) some w > 0 has S'w = 0. Tested only when Gordan's LP is feasible,
 *   by the LP  S'w = 0, w >= 1  (feasible: not separated; infeasible:
 *   quasi-complete separation).
 *
 * Feasibility is lib/lp's phase one: infeasible when the artificial sum
 * left after phase one is above 1e-7.
 */
const separationTest = (A, y) => {
  const n = A.length;
  const p = A[0].length;
  const cols = [];
  for (let j = 0; j < p; j += 1) {
    let mx = 0;
    for (let i = 0; i < n; i += 1) { const v = Math.abs(A[i][j]); if (v > mx) mx = v; }
    if (mx === 0) mx = 1;
    const col = new Array(n);
    for (let i = 0; i < n; i += 1) col[i] = ((y[i] === 1 ? 1 : -1) * A[i][j]) / mx;
    cols.push(col);
  }
  const zeros = new Array(n).fill(0);
  const inf = new Array(n).fill(Infinity);
  const gordan = solveLP({ c: zeros, A: [...cols, new Array(n).fill(1)], b: [...new Array(p).fill(0), 1], ops: new Array(p + 1).fill('='), lo: zeros, hi: inf });
  if (gordan.status === LP_STATUS.ITERATION_LIMIT) return { undecided: true, lpPivots: gordan.iterations };
  if (gordan.status !== LP_STATUS.OPTIMAL) {
    return { detected: true, type: 'complete', certificate: 'no w >= 0 with sum 1 and S\'w = 0 (Gordan): some beta has S beta > 0', lpPivots: gordan.iterations };
  }
  const stiemke = solveLP({ c: zeros, A: cols, b: new Array(p).fill(0), ops: new Array(p).fill('='), lo: new Array(n).fill(1), hi: inf });
  const pivots = gordan.iterations + stiemke.iterations;
  if (stiemke.status === LP_STATUS.ITERATION_LIMIT) return { undecided: true, lpPivots: pivots };
  if (stiemke.status === LP_STATUS.OPTIMAL) return { detected: false, type: 'none', certificate: 'weights w >= 1 with S\'w = 0 (Stiemke)', lpPivots: pivots };
  return { detected: true, type: 'quasi-complete', certificate: 'no w >= 1 with S\'w = 0 (Stiemke), but w >= 0 with sum 1 and S\'w = 0 exists (Gordan): no strict separator', lpPivots: pivots };
};

const penLogLik = (A, y, beta, l2, pen) => {
  let ll = 0;
  for (let i = 0; i < A.length; i += 1) {
    let eta = 0;
    for (let j = 0; j < beta.length; j += 1) eta += A[i][j] * beta[j];
    ll += y[i] * eta - softplus(eta);
  }
  let q = 0;
  for (let j = 0; j < beta.length; j += 1) if (pen[j]) q += beta[j] * beta[j];
  return { ll, pll: ll - 0.5 * l2 * q };
};

/**
 * Binary logistic regression by Newton-Raphson (IRLS). Labels must be 0
 * and 1, both present. With l2 = 0 a separated sample (complete or
 * quasi-complete) is refused because the maximum likelihood coefficients
 * are infinite; with l2 > 0 it is fitted and `separation` reports it.
 */
export const logistic = ({ X, y, names, intercept = true, l2 = 0, tol = DEFAULTS.LOGISTIC_TOL, maxIter = DEFAULTS.LOGISTIC_MAX_ITER } = {}) => {
  const bad = checkMatrix('X', X, { minRows: 2 });
  if (bad) return bad;
  const n = X.length;
  if (!Array.isArray(y) || y.length !== n) return refuse('y', `must be an array of ${n} labels, one per row`);
  for (let i = 0; i < n; i += 1) if (y[i] !== 0 && y[i] !== 1) return refuse(`y[${i}]`, 'must be 0 or 1');
  if (!y.includes(0) || !y.includes(1)) return refuse('y', 'must contain both classes, 0 and 1');
  const nm = checkNames(names, X[0].length);
  if (nm.bad) return nm.bad;
  if (typeof intercept !== 'boolean') return refuse('intercept', 'must be true or false');
  if (!(isNum(l2) && l2 >= 0)) return refuse('l2', 'must be a finite number, zero or more');
  if (!(isNum(tol) && tol > 0)) return refuse('tol', 'must be a finite number above zero');
  if (!(Number.isInteger(maxIter) && maxIter >= 1)) return refuse('maxIter', 'must be a whole number, 1 or more');
  const A = designMatrix(X, intercept);
  const p = A[0].length;
  const allNames = intercept ? ['intercept', ...nm.names] : nm.names;
  const pen = allNames.map((nmj) => nmj !== 'intercept');
  if (l2 === 0) {
    if (n <= p) return refuse('X', `must have more rows than coefficients without a penalty (${n} rows for ${p} coefficients)`);
    const kappa = condFrom(singularValues(equilibratedR(A)));
    if (!(kappa <= DEFAULTS.MAX_CONDITION)) return refuse('X', `is rank deficient or too ill-conditioned for an unpenalised fit: the scaled condition number ${fmt(kappa)} is above ${fmt(DEFAULTS.MAX_CONDITION)}; add an L2 penalty (l2 > 0) or drop collinear features`);
  }
  const separation = separationTest(A, y);
  if (separation.undecided) return refuse('y', `could not be tested for separation: a separation linear programme stopped at its iteration limit (${separation.lpPivots} pivots)`);
  if (separation.detected && l2 === 0) {
    return refuse('y', `is ${separation.type === 'complete' ? 'completely' : 'quasi-completely'} separated by a linear combination of the features (${separation.type === 'complete' ? 'every row lies strictly on its own class side of a hyperplane' : 'every row lies on or on its own class side of a hyperplane, some exactly on it'}), so the maximum likelihood coefficients are infinite: add an L2 penalty (l2 > 0) or remove the separating feature`);
  }
  let beta = new Array(p).fill(0);
  let cur = penLogLik(A, y, beta, l2, pen);
  let iterations = 0;
  let converged = false;
  let halvings = 0;
  const trace = [];
  while (iterations < maxIter) {
    const g = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i += 1) {
      let eta = 0;
      for (let j = 0; j < p; j += 1) eta += A[i][j] * beta[j];
      const mu = sigmoid(eta);
      const w = mu * (1 - mu);
      for (let j = 0; j < p; j += 1) {
        g[j] += A[i][j] * (y[i] - mu);
        for (let k = 0; k <= j; k += 1) H[j][k] += w * A[i][j] * A[i][k];
      }
    }
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k < j; k += 1) H[k][j] = H[j][k];
      if (pen[j]) { g[j] -= l2 * beta[j]; H[j][j] += l2; }
    }
    const fac = cholScaled(H);
    if (fac.singular) {
      return refuse('X', `gives a singular Newton system at iteration ${iterations + 1} (X'WX${l2 > 0 ? ' + l2 P' : ''}): ${singularText(fac)}; add an L2 penalty or drop collinear features`);
    }
    const delta = cholSolve(fac, g);
    let step = 1;
    let next = beta.map((b, j) => b + delta[j]);
    let nextVal = penLogLik(A, y, next, l2, pen);
    let h = 0;
    // a decrease within rounding (1e-12 x (1 + |l|)) is not a decrease
    const floor = cur.pll - 1e-12 * (1 + Math.abs(cur.pll));
    while (nextVal.pll < floor && h < DEFAULTS.STEP_HALVINGS) {
      step /= 2; h += 1;
      next = beta.map((b, j) => b + step * delta[j]);
      nextVal = penLogLik(A, y, next, l2, pen);
    }
    halvings += h;
    // the FULL Newton step, before any halving
    let change = 0;
    for (let j = 0; j < p; j += 1) change = Math.max(change, Math.abs(delta[j]));
    beta = next; cur = nextVal; iterations += 1;
    trace.push({ iteration: iterations, maxChange: change, logLikelihood: cur.ll, stepHalvings: h });
    if (change <= tol) { converged = true; break; }
  }
  // information at the solution
  const I = Array.from({ length: p }, () => new Array(p).fill(0));
  const probs = [];
  let nullLL = 0;
  const ybar = y.reduce((a, v) => a + v, 0) / n;
  for (let i = 0; i < n; i += 1) {
    let eta = 0;
    for (let j = 0; j < p; j += 1) eta += A[i][j] * beta[j];
    const mu = sigmoid(eta);
    probs.push(mu);
    const w = mu * (1 - mu);
    for (let j = 0; j < p; j += 1) for (let k = 0; k < p; k += 1) I[j][k] += w * A[i][j] * A[i][k];
    nullLL += y[i] * Math.log(ybar) + (1 - y[i]) * Math.log(1 - ybar);
  }
  for (let j = 0; j < p; j += 1) if (pen[j]) I[j][j] += l2;
  let se = null;
  const fi = cholScaled(I);
  if (!fi.singular) se = allNames.map((_, j) => { const e = new Array(p).fill(0); e[j] = 1; return Math.sqrt(cholSolve(fi, e)[j]); });
  const out = {
    kind: 'logistic',
    intercept,
    l2,
    names: allNames,
    n,
    coefficients: beta,
    standardErrors: se,
    logLikelihood: cur.ll,
    deviance: -2 * cur.ll,
    nullDeviance: intercept ? -2 * nullLL : null,
    iterations,
    converged,
    stepHalvings: halvings,
    trace,
    separation,
    probabilities: probs,
    basis: {
      method: 'Newton-Raphson (IRLS) from beta = 0; a step is halved while it lowers the penalised log likelihood by more than 1e-12 x (1 + |log likelihood|), up to 30 halvings',
      convergence: `converged when the largest absolute component of the full Newton step is at most tol ${fmt(tol)} (in coefficient units: set tol to the scale of the coefficients when features are in very small or very large units); at most maxIter ${maxIter} updates`,
      newtonSolve: 'Cholesky on the unit-diagonal scaled Hessian (solveSPD); singular when a scaled pivot is at or below p x machine epsilon',
      penalty: l2 > 0 ? `(l2 / 2) x sum beta_j^2 on the non-intercept coefficients, l2 = ${fmt(l2)}; scikit-learn C = 1 / l2` : 'none (maximum likelihood)',
      standardErrors: l2 > 0 ? 'sqrt(diag((X\'WX + l2 P)^-1)) at the solution, P the penalty pattern' : 'sqrt(diag((X\'WX)^-1)) at the solution, W = p(1 - p)',
      separation: 'dual linear programmes on the column-scaled, sign-flipped design S (lib/lp): COMPLETE when S\'w = 0, sum w = 1, w >= 0 is infeasible (Gordan); otherwise QUASI-COMPLETE when S\'w = 0, w >= 1 is infeasible (Stiemke), else none; infeasible means an artificial sum above 1e-7 after phase one',
    },
  };
  if (!converged) {
    out.warning = `did not converge in ${maxIter} updates: the last full Newton step had a largest component of ${fmt(trace[trace.length - 1].maxChange)}, above tol ${fmt(tol)}`;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* Prediction. */

/** Predictions from a fitted ols, ridge or logistic model. */
export const predict = ({ model, X } = {}) => {
  if (!model || !['ols', 'ridge', 'logistic'].includes(model.kind) || !Array.isArray(model.coefficients)) {
    return refuse('model', 'must be the result of ols, ridge or logistic');
  }
  const bad = checkMatrix('X', X);
  if (bad) return bad;
  const q = model.coefficients.length - (model.intercept ? 1 : 0);
  if (X[0].length !== q) return refuse('X', `must have ${q} columns, as the model was fitted on`);
  const eta = X.map((r) => {
    let s = model.intercept ? model.coefficients[0] : 0;
    const off = model.intercept ? 1 : 0;
    for (let j = 0; j < q; j += 1) s += r[j] * model.coefficients[j + off];
    return s;
  });
  if (model.kind !== 'logistic') return { values: eta, basis: { rule: 'intercept + sum b_j x_j in the original units' } };
  const pr = eta.map(sigmoid);
  return { values: pr, classes: pr.map((v) => (v > 0.5 ? 1 : 0)), basis: { rule: 'probability 1 / (1 + exp(-eta)); class 1 when the probability is above 0.5, class 0 at exactly 0.5' } };
};

/* ------------------------------------------------------------------ */
/* Metrics. */

/** RMSE, MAE and R^2 on a set of predictions. */
export const regressionMetrics = ({ yTrue, yPred, referenceMean } = {}) => {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return refuse('yTrue', 'must be a non-empty array of numbers');
  const b1 = checkVector('yTrue', yTrue, yTrue.length);
  if (b1) return b1;
  const b2 = checkVector('yPred', yPred, yTrue.length);
  if (b2) return b2;
  if (referenceMean !== undefined && !isNum(referenceMean)) return refuse('referenceMean', 'must be a finite number');
  const n = yTrue.length;
  const m = referenceMean === undefined ? statsMean(yTrue) : referenceMean;
  let sse = 0; let sae = 0; let sst = 0;
  for (let i = 0; i < n; i += 1) {
    const e = yTrue[i] - yPred[i];
    sse += e * e; sae += Math.abs(e); sst += (yTrue[i] - m) ** 2;
  }
  if (!(sst > 0)) return refuse('yTrue', referenceMean === undefined ? 'has zero variance (every value is equal), so R-squared about its mean is undefined' : `equals referenceMean ${fmt(m)} in every row, so R-squared is undefined`);
  return {
    n,
    rmse: Math.sqrt(sse / n),
    mae: sae / n,
    r2: 1 - sse / sst,
    sse,
    sst,
    referenceMean: m,
    basis: {
      rmse: 'sqrt(sum (y - yhat)^2 / n)',
      mae: 'sum |y - yhat| / n',
      r2: referenceMean === undefined ? '1 - SSE / sum (y - mean of these y)^2 (scikit-learn r2_score); negative when worse than that mean' : '1 - SSE / sum (y - referenceMean)^2, referenceMean supplied (for example the training mean)',
    },
  };
};

const labelList = (yTrue, yPred, labels) => {
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length === 0) return { bad: refuse('labels', 'must be a non-empty array') };
    if (new Set(labels).size !== labels.length) return { bad: refuse('labels', 'must not repeat a label') };
    const set = new Set(labels);
    for (let i = 0; i < yTrue.length; i += 1) {
      if (!set.has(yTrue[i])) return { bad: refuse(`yTrue[${i}]`, `is ${JSON.stringify(yTrue[i])}, which is not in labels`) };
      if (!set.has(yPred[i])) return { bad: refuse(`yPred[${i}]`, `is ${JSON.stringify(yPred[i])}, which is not in labels`) };
    }
    return { labels: [...labels] };
  }
  const all = [...yTrue, ...yPred];
  const kind = typeof all[0];
  if (!all.every((v) => (kind === 'string' ? typeof v === 'string' : isNum(v)))) return { bad: refuse('yTrue', 'and yPred must hold labels of one type: all strings or all finite numbers') };
  const u = [...new Set(all)];
  u.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { labels: u };
};

const checkLabels = (yTrue, yPred) => {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return refuse('yTrue', 'must be a non-empty array of labels');
  if (!Array.isArray(yPred) || yPred.length !== yTrue.length) return refuse('yPred', `must be an array of ${yTrue.length} labels, one per row`);
  for (let i = 0; i < yTrue.length; i += 1) {
    if (!(typeof yTrue[i] === 'string' || isNum(yTrue[i]))) return refuse(`yTrue[${i}]`, 'must be a string or a finite number');
    if (!(typeof yPred[i] === 'string' || isNum(yPred[i]))) return refuse(`yPred[${i}]`, 'must be a string or a finite number');
  }
  return null;
};

/** Confusion matrix: rows are the TRUE label, columns the PREDICTED label. */
export const confusionMatrix = ({ yTrue, yPred, labels } = {}) => {
  const b = checkLabels(yTrue, yPred);
  if (b) return b;
  const L = labelList(yTrue, yPred, labels);
  if (L.bad) return L.bad;
  const pos = new Map(L.labels.map((l, i) => [l, i]));
  const M = L.labels.map(() => new Array(L.labels.length).fill(0));
  for (let i = 0; i < yTrue.length; i += 1) M[pos.get(yTrue[i])][pos.get(yPred[i])] += 1;
  return {
    labels: L.labels,
    matrix: M,
    n: yTrue.length,
    basis: { layout: 'matrix[i][j] counts rows whose TRUE label is labels[i] and PREDICTED label is labels[j] (scikit-learn layout)', order: labels === undefined ? 'labels sorted (numbers ascending, strings by UTF-16 code unit)' : 'labels in the order given' },
  };
};

/**
 * Accuracy and per-class precision, recall, F1 and support, with macro and
 * support-weighted averages. A ratio whose denominator is zero scores
 * zeroDivision (0 or 1), and `undefinedRatios` lists where that happened.
 */
export const classificationReport = ({ yTrue, yPred, labels, zeroDivision = 0 } = {}) => {
  const cm = confusionMatrix({ yTrue, yPred, labels });
  if (cm.error) return cm;
  if (zeroDivision !== 0 && zeroDivision !== 1) return refuse('zeroDivision', 'must be 0 or 1');
  const M = cm.matrix;
  const k = cm.labels.length;
  const n = yTrue.length;
  const perClass = [];
  const undefinedRatios = [];
  let correct = 0;
  for (let c = 0; c < k; c += 1) {
    correct += M[c][c];
    const tp = M[c][c];
    let fp = 0; let fn = 0;
    for (let r = 0; r < k; r += 1) if (r !== c) { fp += M[r][c]; fn += M[c][r]; }
    const ratio = (num, den, what) => {
      if (den === 0) { undefinedRatios.push({ label: cm.labels[c], metric: what }); return zeroDivision; }
      return num / den;
    };
    perClass.push({
      label: cm.labels[c], tp, fp, fn, support: tp + fn,
      precision: ratio(tp, tp + fp, 'precision'),
      recall: ratio(tp, tp + fn, 'recall'),
      f1: ratio(2 * tp, 2 * tp + fp + fn, 'f1'),
    });
  }
  const avg = (key, w) => {
    const ws = perClass.reduce((a, r) => a + w(r), 0);
    return ws === 0 ? zeroDivision : perClass.reduce((a, r) => a + w(r) * r[key], 0) / ws;
  };
  const macro = { precision: avg('precision', () => 1), recall: avg('recall', () => 1), f1: avg('f1', () => 1) };
  const weighted = { precision: avg('precision', (r) => r.support), recall: avg('recall', (r) => r.support), f1: avg('f1', (r) => r.support) };
  return {
    labels: cm.labels,
    matrix: M,
    n,
    accuracy: correct / n,
    perClass,
    macro,
    weighted,
    zeroDivision,
    undefinedRatios,
    basis: {
      precision: 'TP / (TP + FP)', recall: 'TP / (TP + FN)', f1: '2TP / (2TP + FP + FN), the harmonic mean of precision and recall where both are defined',
      zeroDivision: `a zero denominator scores ${zeroDivision} (scikit-learn zero_division = ${zeroDivision})`,
      macro: 'unweighted mean over the labels', weighted: 'mean weighted by support (true count)', accuracy: 'correct / n',
    },
  };
};

const checkBinary = (yTrue) => {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return refuse('yTrue', 'must be a non-empty array of 0 and 1 labels');
  for (let i = 0; i < yTrue.length; i += 1) if (yTrue[i] !== 0 && yTrue[i] !== 1) return refuse(`yTrue[${i}]`, 'must be 0 or 1');
  return null;
};

/**
 * ROC curve with the positive label 1. Thresholds are the distinct scores
 * in descending order; rows with EQUAL scores move together, so a tie
 * between classes is one diagonal step. The curve starts at (0, 0) with
 * threshold null. AUC by the trapezoid rule over the points.
 */
export const rocCurve = ({ yTrue, scores } = {}) => {
  const b = checkBinary(yTrue);
  if (b) return b;
  const bs = checkVector('scores', scores, yTrue.length);
  if (bs) return bs;
  const P = yTrue.filter((v) => v === 1).length;
  const N = yTrue.length - P;
  if (P === 0 || N === 0) return refuse('yTrue', `must contain both classes (found ${P} positive and ${N} negative), or the ROC curve is undefined`);
  const order = yTrue.map((_, i) => i).sort((a, c) => scores[c] - scores[a] || a - c);
  const fpr = [0]; const tpr = [0]; const thresholds = [null];
  let tp = 0; let fp = 0;
  for (let q = 0; q < order.length;) {
    const s = scores[order[q]];
    while (q < order.length && scores[order[q]] === s) {
      if (yTrue[order[q]] === 1) tp += 1; else fp += 1;
      q += 1;
    }
    fpr.push(fp / N); tpr.push(tp / P); thresholds.push(s);
  }
  let auc = 0;
  for (let i = 1; i < fpr.length; i += 1) auc += (fpr[i] - fpr[i - 1]) * (tpr[i] + tpr[i - 1]) / 2;
  return {
    fpr, tpr, thresholds, auc, positives: P, negatives: N,
    basis: {
      positive: 'label 1; a row is called positive when its score is at or above the threshold',
      ties: 'equal scores are one threshold: their rows move together, a diagonal step when the classes are mixed',
      auc: 'trapezoid rule over the curve points (equals the Mann-Whitney probability with ties counted one half)',
      start: 'the curve starts at (0, 0) with threshold null (no row called positive; scikit-learn prints infinity)',
    },
  };
};

/** Binary log loss (natural log), probabilities clipped to [eps, 1 - eps]. */
export const logLoss = ({ yTrue, probabilities, eps = DEFAULTS.LOG_LOSS_EPS } = {}) => {
  const b = checkBinary(yTrue);
  if (b) return b;
  if (!Array.isArray(probabilities) || probabilities.length !== yTrue.length) return refuse('probabilities', `must be an array of ${yTrue.length} numbers, one per row`);
  for (let i = 0; i < probabilities.length; i += 1) {
    const v = probabilities[i];
    if (!(isNum(v) && v >= 0 && v <= 1)) return refuse(`probabilities[${i}]`, 'must be a number from 0 to 1');
  }
  if (!(isNum(eps) && eps > 0 && eps < 0.5)) return refuse('eps', 'must be a number above 0 and below 0.5');
  let s = 0;
  let clipped = 0;
  for (let i = 0; i < yTrue.length; i += 1) {
    let q = probabilities[i];
    if (q < eps) { q = eps; clipped += 1; } else if (q > 1 - eps) { q = 1 - eps; clipped += 1; }
    s -= yTrue[i] === 1 ? Math.log(q) : Math.log(1 - q);
  }
  return { logLoss: s / yTrue.length, n: yTrue.length, eps, clipped, basis: { formula: '-(1/n) sum [y ln p + (1 - y) ln(1 - p)], natural log', clipping: `p clipped to [eps, 1 - eps], eps = ${fmt(eps)}` } };
};

/* ------------------------------------------------------------------ */
/* Model evaluation helpers. */

const checkModelSpec = (spec) => {
  if (!spec || typeof spec !== 'object') return refuse('model', "must be an object with kind 'ols', 'ridge' or 'logistic'");
  if (!['ols', 'ridge', 'logistic'].includes(spec.kind)) return refuse('model.kind', "must be 'ols', 'ridge' or 'logistic'");
  if (spec.kind === 'ridge' && !(isNum(spec.lambda) && spec.lambda >= 0)) return refuse('model.lambda', 'must be a finite number, zero or more, for ridge');
  if (spec.kind === 'logistic' && spec.l2 !== undefined && !(isNum(spec.l2) && spec.l2 >= 0)) return refuse('model.l2', 'must be a finite number, zero or more');
  return null;
};

const fitSpec = (spec, X, y) => {
  if (spec.kind === 'ols') return ols({ X, y, ...(spec.maxCondition ? { maxCondition: spec.maxCondition } : {}) });
  if (spec.kind === 'ridge') return ridge({ X, y, lambda: spec.lambda });
  return logistic({ X, y, l2: spec.l2 ?? 0 });
};

const defaultMetric = (kind) => (kind === 'logistic' ? 'auc' : 'r2');

const checkMetric = (metric, kind) => {
  if (!METRICS[metric]) return refuse('metric', `must be one of ${Object.keys(METRICS).join(', ')}`);
  const task = kind === 'logistic' ? 'classification' : 'regression';
  if (METRICS[metric].task !== task) return refuse('metric', `${metric} is a ${METRICS[metric].task} metric and the model is ${kind}`);
  return null;
};

/** Scores a fitted model on rows with the named metric. */
/**
 * Model output without validation or row copies: the same summation order
 * as predict, with column j read from override (a permuted column) when
 * given. Values are probabilities for logistic.
 */
const modelOutput = (model, X, j = -1, override = null) => {
  const q = model.coefficients.length - (model.intercept ? 1 : 0);
  const off = model.intercept ? 1 : 0;
  const c = model.coefficients;
  const n = X.length;
  const values = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const r = X[i];
    let s = model.intercept ? c[0] : 0;
    for (let k = 0; k < q; k += 1) s += (k === j ? override[i] : r[k]) * c[k + off];
    values[i] = model.kind === 'logistic' ? sigmoid(s) : s;
  }
  return model.kind === 'logistic' ? { values, classes: values.map((v) => (v > 0.5 ? 1 : 0)) } : { values };
};

const scoreOutput = (pr, y, metric) => {
  if (metric === 'accuracy') return { value: pr.classes.reduce((a, c, i) => a + (c === y[i] ? 1 : 0), 0) / y.length };
  if (metric === 'logLoss') { const r = logLoss({ yTrue: y, probabilities: pr.values }); return r.error ? r : { value: r.logLoss }; }
  if (metric === 'auc') { const r = rocCurve({ yTrue: y, scores: pr.values }); return r.error ? r : { value: r.auc }; }
  const r = regressionMetrics({ yTrue: y, yPred: pr.values });
  return r.error ? r : { value: r[metric] };
};

/** Scores a fitted model on rows with the named metric. */
const scoreModel = (model, X, y, metric) => {
  const pr = predict({ model, X });
  if (pr.error) return pr;
  return scoreOutput(pr, y, metric);
};

const checkXyGroups = (X, y, groups, kind) => {
  const bad = checkMatrix('X', X, { minRows: 2 });
  if (bad) return bad;
  if (kind === 'logistic') {
    if (!Array.isArray(y) || y.length !== X.length) return refuse('y', `must be an array of ${X.length} labels, one per row`);
    for (let i = 0; i < y.length; i += 1) if (y[i] !== 0 && y[i] !== 1) return refuse(`y[${i}]`, 'must be 0 or 1');
  } else {
    const by = checkVector('y', y, X.length);
    if (by) return by;
  }
  if (groups !== undefined && (!Array.isArray(groups) || groups.length !== X.length)) return refuse('groups', `must be an array of ${X.length} group ids, one per row`);
  return null;
};

/**
 * Seeded permutation importance. For each feature in column order and
 * each repeat, the column's values are permuted across the rows (one
 * mulberry32 stream for the whole call, features outer, repeats inner) and
 * the model is re-scored; the drop is the loss of score, positive when the
 * feature matters: baseline - permuted for r2, accuracy and auc, permuted -
 * baseline for rmse, mae and logLoss. SD over repeats is the population SD.
 */
export const permutationImportance = ({ model, X, y, metric, nRepeats = 5, seed } = {}) => {
  if (!model || !['ols', 'ridge', 'logistic'].includes(model.kind)) return refuse('model', 'must be the result of ols, ridge or logistic');
  const bad = checkXyGroups(X, y, undefined, model.kind);
  if (bad) return bad;
  const m = metric ?? defaultMetric(model.kind);
  const bm = checkMetric(m, model.kind);
  if (bm) return bm;
  if (!Number.isInteger(nRepeats) || nRepeats < 1) return refuse('nRepeats', 'must be a whole number, 1 or more');
  const bs = checkSeed(seed);
  if (bs) return bs;
  const base = scoreModel(model, X, y, m);
  if (base.error) return base;
  const hib = METRICS[m].higherIsBetter;
  const rng = mulberry32(seed);
  const names = model.names.filter((nme, j) => !(model.intercept && j === 0));
  const importances = [];
  for (let j = 0; j < X[0].length; j += 1) {
    const drops = [];
    for (let r = 0; r < nRepeats; r += 1) {
      const perm = shuffleInPlace(X.map((_, i) => i), rng);
      const col = perm.map((pi) => X[pi][j]);
      const sc = scoreOutput(modelOutput(model, X, j, col), y, m);
      if (sc.error) return sc;
      drops.push(hib ? base.value - sc.value : sc.value - base.value);
    }
    const mu = drops.reduce((a, v) => a + v, 0) / nRepeats;
    const sd = Math.sqrt(drops.reduce((a, v) => a + (v - mu) ** 2, 0) / nRepeats);
    importances.push({ feature: names[j], mean: mu, sd, drops });
  }
  const ranking = importances.map((r, j) => ({ j, mean: r.mean })).sort((a, b) => b.mean - a.mean || a.j - b.j).map((r) => importances[r.j].feature);
  return {
    metric: m,
    baseline: base.value,
    nRepeats,
    seed,
    importances,
    ranking,
    basis: {
      permutation: 'mulberry32(seed), one stream for the call; features in column order, repeats inner; Fisher-Yates from the end over the row order; row i takes the value from row perm[i]',
      drop: hib ? `baseline ${m} - permuted ${m} (positive when the feature matters)` : `permuted ${m} - baseline ${m} (positive when the feature matters)`,
      sd: 'population SD of the drops over the repeats',
      ranking: 'mean drop descending; a tie keeps column order',
    },
  };
};

/**
 * Learning curve by group count: one group split holds out the test wells
 * (groupSplit with the seed); the model is fitted on the first m training
 * groups of the split's shuffled order, for each m in trainGroupCounts,
 * and scored on those training rows and on the fixed test rows.
 */
export const learningCurve = ({ X, y, groups, model, trainGroupCounts, testFraction, nTestGroups, seed, metric } = {}) => {
  const bspec = checkModelSpec(model);
  if (bspec) return bspec;
  const bad = checkXyGroups(X, y, groups, model.kind);
  if (bad) return bad;
  if (groups === undefined) return refuse('groups', 'must be an array of group ids, one per row');
  const m = metric ?? defaultMetric(model.kind);
  const bm = checkMetric(m, model.kind);
  if (bm) return bm;
  const split = groupSplit({ groups, testFraction, nTestGroups, seed });
  if (split.error) return split;
  const testSet = new Set(split.testGroups);
  const trainOrder = split.order.filter((g) => !testSet.has(g));
  if (!Array.isArray(trainGroupCounts) || trainGroupCounts.length === 0) return refuse('trainGroupCounts', 'must be a non-empty array of whole numbers of training groups');
  const Xte = pick(X, split.testIndices);
  const yte = pick(y, split.testIndices);
  const points = [];
  for (let k = 0; k < trainGroupCounts.length; k += 1) {
    const c = trainGroupCounts[k];
    if (!Number.isInteger(c) || c < 1 || c > trainOrder.length) return refuse(`trainGroupCounts[${k}]`, `must be a whole number from 1 to ${trainOrder.length} (the training groups)`);
    if (k > 0 && !(c > trainGroupCounts[k - 1])) return refuse(`trainGroupCounts[${k}]`, 'must be larger than the count before it');
    const use = new Set(trainOrder.slice(0, c));
    const idx = indicesOf(groups, use);
    const Xtr = pick(X, idx);
    const ytr = pick(y, idx);
    const fit = fitSpec(model, Xtr, ytr);
    if (fit.error) return refuse(`trainGroupCounts[${k}]`, `(${c} groups, ${idx.length} rows) could not be fitted: ${fit.error}`);
    const tr = scoreModel(fit, Xtr, ytr, m);
    if (tr.error) return refuse(`trainGroupCounts[${k}]`, `(${c} groups) could not be scored on its training rows: ${tr.error}`);
    const te = scoreModel(fit, Xte, yte, m);
    if (te.error) return refuse('groups', `test rows could not be scored: ${te.error}`);
    points.push({ nGroups: c, nRows: idx.length, groups: trainOrder.slice(0, c), trainScore: tr.value, testScore: te.value });
  }
  return {
    metric: m,
    testGroups: split.testGroups,
    testIndices: split.testIndices,
    trainOrder,
    points,
    basis: {
      split: 'groupSplit(groups, seed): the test wells are fixed for every point',
      sizes: 'the first m training groups of the split\'s shuffled order; sizes counted in groups (wells), not rows',
      scores: `${m} on the training rows used and on the held-out test rows`,
    },
  };
};

/**
 * The same model and data scored under a random row split and under a
 * group split with the same testFraction and seed. `optimism` is how much
 * better the random row test score looks (positive = leakage flattered it).
 */
export const leakageDemo = ({ X, y, groups, model, testFraction, seed, metric } = {}) => {
  const bspec = checkModelSpec(model);
  if (bspec) return bspec;
  const bad = checkXyGroups(X, y, groups, model.kind);
  if (bad) return bad;
  if (groups === undefined) return refuse('groups', 'must be an array of group ids, one per row');
  const m = metric ?? defaultMetric(model.kind);
  const bm = checkMetric(m, model.kind);
  if (bm) return bm;
  const rs = randomRowSplit({ groups, testFraction, seed });
  if (rs.error) return rs;
  const gs = groupSplit({ groups, testFraction, seed });
  if (gs.error) return gs;
  const run = (split, label) => {
    const Xtr = pick(X, split.trainIndices); const ytr = pick(y, split.trainIndices);
    const Xte = pick(X, split.testIndices); const yte = pick(y, split.testIndices);
    const fit = fitSpec(model, Xtr, ytr);
    if (fit.error) return { bad: refuse('model', `could not be fitted on the ${label} training rows: ${fit.error}`) };
    const tr = scoreModel(fit, Xtr, ytr, m);
    const te = scoreModel(fit, Xte, yte, m);
    if (tr.error || te.error) return { bad: refuse('y', `could not be scored under the ${label} split: ${(tr.error || te.error)}`) };
    return {
      trainIndices: split.trainIndices, testIndices: split.testIndices,
      trainGroups: split.trainGroups, testGroups: split.testGroups, sharedGroups: split.sharedGroups,
      nTrain: split.trainIndices.length, nTest: split.testIndices.length,
      trainScore: tr.value, testScore: te.value, coefficients: fit.coefficients,
    };
  };
  const a = run(rs, 'random row');
  if (a.bad) return a.bad;
  const b = run(gs, 'group');
  if (b.bad) return b.bad;
  const hib = METRICS[m].higherIsBetter;
  return {
    metric: m,
    randomRow: a,
    group: b,
    optimism: hib ? a.testScore - b.testScore : b.testScore - a.testScore,
    basis: {
      randomRow: 'randomRowSplit(testFraction, seed): rows of one well can land on both sides (sharedGroups)',
      group: 'groupSplit(testFraction, seed): whole wells held out; the honest estimate for a new well',
      optimism: hib ? `random-row test ${m} - group test ${m}` : `group test ${m} - random-row test ${m}`,
    },
  };
};
