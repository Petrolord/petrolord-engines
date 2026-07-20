/**
 * Well Test Analysis Studio - nonlinear regression kernel
 *
 * Levenberg-Marquardt least squares used by the auto-match: minimizes
 * ||r(theta)||^2 for a user-supplied residual function (typically log-space
 * pressure + Bourdet-derivative mismatch). Numerical forward-difference
 * Jacobian, multiplicative damping schedule, optional box bounds (projection),
 * and the parameter covariance matrix at the optimum for 95% confidence
 * intervals: cov = s^2 (J'J)^{-1}, s^2 = SSR / (m - n).
 *
 * The model catalog log-transforms strictly positive parameters (k, C, ...)
 * before handing them here, so bounds are a safety rail rather than the main
 * positivity mechanism.
 *
 * No external matrix library exists in this repo; the small dense solver
 * below (Gaussian elimination with partial pivoting) covers the n <= ~8
 * parameter systems PTA fitting needs.
 */

const EPS = 1e-12;

/**
 * Solve A x = b for a small dense system. A is an array of rows; both inputs
 * are copied, not mutated. Returns null if the system is singular.
 */
export const solveLinear = (A, b) => {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < EPS) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    for (let row = col + 1; row < n; row += 1) {
      const f = M[row][col] / M[col][col];
      for (let c = col; c <= n; c += 1) M[row][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = M[row][n];
    for (let c = row + 1; c < n; c += 1) sum -= M[row][c] * x[c];
    x[row] = sum / M[row][row];
  }
  return x;
};

/** Invert a small dense symmetric matrix by solving n unit systems. */
export const invertMatrix = (A) => {
  const n = A.length;
  const inv = [];
  for (let i = 0; i < n; i += 1) {
    const e = new Array(n).fill(0);
    e[i] = 1;
    const col = solveLinear(A, e);
    if (!col) return null;
    inv.push(col);
  }
  // columns of the inverse were computed; transpose into row-major
  const out = [];
  for (let r = 0; r < n; r += 1) {
    out.push(inv.map((column) => column[r]));
  }
  return out;
};

const sumSquares = (r) => r.reduce((acc, v) => acc + v * v, 0);

const numericJacobian = (residualsFn, theta, r0, jacobianStep) => {
  const n = theta.length;
  const m = r0.length;
  const J = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j += 1) {
    // Callers whose residuals come from iterative solvers with a coarse
    // stopping tolerance (e.g. a bisection quantized to 0.05 psia) must
    // widen the step above that noise floor or the derivative reads zero;
    // jacobianStep gives a per-parameter absolute h for exactly that.
    const h = (Array.isArray(jacobianStep) && Number.isFinite(jacobianStep[j]) && jacobianStep[j] > 0)
      ? jacobianStep[j]
      : Math.max(1e-7, Math.abs(theta[j]) * 1e-6);
    const perturbed = [...theta];
    perturbed[j] += h;
    const r1 = residualsFn(perturbed);
    for (let i = 0; i < m; i += 1) J[i][j] = (r1[i] - r0[i]) / h;
  }
  return J;
};

const applyBounds = (theta, bounds) => {
  if (!bounds) return theta;
  return theta.map((v, j) => {
    const lo = bounds[j]?.[0];
    const hi = bounds[j]?.[1];
    let out = v;
    if (Number.isFinite(lo)) out = Math.max(out, lo);
    if (Number.isFinite(hi)) out = Math.min(out, hi);
    return out;
  });
};

/**
 * Levenberg-Marquardt minimization of ||residualsFn(theta)||^2.
 *
 * @param {(theta: number[]) => number[]} residualsFn residual vector; entries
 *   must be finite (return large-but-finite penalties for invalid regions)
 * @param {number[]} theta0 starting parameter vector
 * @param {object} [options]
 * @param {number} [options.maxIterations=80]
 * @param {number} [options.lambda0=1e-3] initial damping
 * @param {number} [options.tolerance=1e-9] relative SSR improvement stop
 * @param {Array<[number, number]>} [options.bounds] per-parameter [lo, hi]
 * @param {(iter: number, ssr: number) => void} [options.onIteration]
 * @param {number[]} [options.jacobianStep] per-parameter absolute
 *   finite-difference step; use when residuals carry solver quantization
 *   noise the default relative step would read as a zero derivative
 * @returns {{ theta, ssr, iterations, converged, covariance, standardErrors,
 *             confidence95 }}
 */
export const levenbergMarquardt = (residualsFn, theta0, options = {}) => {
  const {
    maxIterations = 80,
    lambda0 = 1e-3,
    tolerance = 1e-9,
    bounds = null,
    onIteration = null,
    jacobianStep = null,
  } = options;

  let theta = applyBounds([...theta0], bounds);
  let r = residualsFn(theta);
  let ssr = sumSquares(r);
  let lambda = lambda0;
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;
    const J = numericJacobian(residualsFn, theta, r, jacobianStep);
    const n = theta.length;
    const m = r.length;

    // Normal equations pieces: JtJ and Jtr
    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let i = 0; i < m; i += 1) {
      for (let a = 0; a < n; a += 1) {
        Jtr[a] += J[i][a] * r[i];
        for (let b = a; b < n; b += 1) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < a; b += 1) JtJ[a][b] = JtJ[b][a];
    }

    let improved = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const damped = JtJ.map((row, a) =>
        row.map((v, b) => (a === b ? v + lambda * Math.max(v, 1e-12) : v))
      );
      const step = solveLinear(damped, Jtr);
      if (step) {
        const trial = applyBounds(theta.map((v, j) => v - step[j]), bounds);
        const rTrial = residualsFn(trial);
        const ssrTrial = sumSquares(rTrial);
        if (Number.isFinite(ssrTrial) && ssrTrial < ssr) {
          const relImprovement = (ssr - ssrTrial) / Math.max(ssr, EPS);
          theta = trial;
          r = rTrial;
          ssr = ssrTrial;
          lambda = Math.max(lambda * 0.3, 1e-12);
          improved = true;
          if (relImprovement < tolerance) converged = true;
          break;
        }
      }
      lambda *= 10;
      if (lambda > 1e12) break;
    }

    if (onIteration) onIteration(iterations, ssr);
    if (!improved || converged) {
      if (!improved) converged = true; // stalled at a (local) minimum
      break;
    }
  }

  // Covariance at the optimum from the undamped normal equations
  const J = numericJacobian(residualsFn, theta, r, jacobianStep);
  const n = theta.length;
  const m = r.length;
  const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < m; i += 1) {
    for (let a = 0; a < n; a += 1) {
      for (let b = a; b < n; b += 1) JtJ[a][b] += J[i][a] * J[i][b];
    }
  }
  for (let a = 0; a < n; a += 1) {
    for (let b = 0; b < a; b += 1) JtJ[a][b] = JtJ[b][a];
  }
  const dof = Math.max(m - n, 1);
  const sigma2 = ssr / dof;
  const JtJinv = invertMatrix(JtJ);
  const covariance = JtJinv
    ? JtJinv.map((row) => row.map((v) => v * sigma2))
    : null;
  const standardErrors = covariance
    ? covariance.map((row, i) => (row[i] > 0 ? Math.sqrt(row[i]) : NaN))
    : theta.map(() => NaN);
  const confidence95 = theta.map((v, i) => {
    const se = standardErrors[i];
    return Number.isFinite(se) ? [v - 1.96 * se, v + 1.96 * se] : [NaN, NaN];
  });

  return { theta, ssr, iterations, converged, covariance, standardErrors, confidence95 };
};
