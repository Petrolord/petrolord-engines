/**
 * Levenberg-Marquardt nonlinear least squares (MB5).
 *
 * TypeScript port of the Well Test Analysis Studio kernel
 * (src/utils/welltest/lmFit.js) for the material-balance pressure history
 * match: numerical forward-difference Jacobian, multiplicative damping
 * schedule, optional box bounds (projection), and the parameter covariance at
 * the optimum for 95% confidence intervals: cov = s^2 (J'J)^{-1},
 * s^2 = SSR / (m - n).
 *
 * A port rather than an import because the client kernel lives on the Vite
 * side of the repo and this file is bundled into Deno edge functions; the
 * algorithm and constants are kept identical so the two stay comparable.
 * jest pins the port against the client kernel on a shared fixture
 * (src/utils/__tests__/lmPort.test.js).
 */

const EPS = 1e-12;

export function solveLinear(A: number[][], b: number[]): number[] | null {
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
}

export function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  const inv: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const e = new Array(n).fill(0);
    e[i] = 1;
    const col = solveLinear(A, e);
    if (!col) return null;
    inv.push(col);
  }
  const out: number[][] = [];
  for (let r = 0; r < n; r += 1) {
    out.push(inv.map((column) => column[r]));
  }
  return out;
}

const sumSquares = (r: number[]) => r.reduce((acc, v) => acc + v * v, 0);

type ResidualsFn = (theta: number[]) => number[];
type Bounds = Array<[number, number]> | null;

function numericJacobian(residualsFn: ResidualsFn, theta: number[], r0: number[]): number[][] {
  const n = theta.length;
  const m = r0.length;
  const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j += 1) {
    const h = Math.max(1e-7, Math.abs(theta[j]) * 1e-6);
    const perturbed = [...theta];
    perturbed[j] += h;
    const r1 = residualsFn(perturbed);
    for (let i = 0; i < m; i += 1) J[i][j] = (r1[i] - r0[i]) / h;
  }
  return J;
}

function applyBounds(theta: number[], bounds: Bounds): number[] {
  if (!bounds) return theta;
  return theta.map((v, j) => {
    const lo = bounds[j]?.[0];
    const hi = bounds[j]?.[1];
    let out = v;
    if (Number.isFinite(lo)) out = Math.max(out, lo as number);
    if (Number.isFinite(hi)) out = Math.min(out, hi as number);
    return out;
  });
}

export interface LMOptions {
  maxIterations?: number;
  lambda0?: number;
  tolerance?: number;
  bounds?: Bounds;
  onIteration?: (iter: number, ssr: number) => void;
}

export interface LMResult {
  theta: number[];
  ssr: number;
  iterations: number;
  converged: boolean;
  covariance: number[][] | null;
  standardErrors: number[];
  confidence95: Array<[number, number]>;
}

export function levenbergMarquardt(
  residualsFn: ResidualsFn,
  theta0: number[],
  options: LMOptions = {},
): LMResult {
  const {
    maxIterations = 80,
    lambda0 = 1e-3,
    tolerance = 1e-9,
    bounds = null,
    onIteration = null,
  } = options;

  let theta = applyBounds([...theta0], bounds);
  let r = residualsFn(theta);
  let ssr = sumSquares(r);
  let lambda = lambda0;
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;
    const J = numericJacobian(residualsFn, theta, r);
    const n = theta.length;
    const m = r.length;

    const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
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
        row.map((v, b) => (a === b ? v + lambda * Math.max(v, 1e-12) : v)),
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

  const J = numericJacobian(residualsFn, theta, r);
  const n = theta.length;
  const m = r.length;
  const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
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
  const confidence95: Array<[number, number]> = theta.map((v, i) => {
    const se = standardErrors[i];
    return Number.isFinite(se) ? [v - 1.96 * se, v + 1.96 * se] : [NaN, NaN];
  });

  return { theta, ssr, iterations, converged, covariance, standardErrors, confidence95 };
}
