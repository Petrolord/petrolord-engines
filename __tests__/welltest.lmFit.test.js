import { solveLinear, invertMatrix, levenbergMarquardt } from '../engines/welltest/lmFit.js';

describe('solveLinear', () => {
  test('solves a known 3x3 system', () => {
    const A = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ];
    const b = [8, -11, -3];
    const x = solveLinear(A, b); // known solution [2, 3, -1]
    expect(x[0]).toBeCloseTo(2, 10);
    expect(x[1]).toBeCloseTo(3, 10);
    expect(x[2]).toBeCloseTo(-1, 10);
  });

  test('returns null for a singular system', () => {
    expect(solveLinear([[1, 2], [2, 4]], [1, 2])).toBeNull();
  });

  test('does not mutate inputs', () => {
    const A = [[3, 1], [1, 2]];
    const b = [9, 8];
    solveLinear(A, b);
    expect(A).toEqual([[3, 1], [1, 2]]);
    expect(b).toEqual([9, 8]);
  });
});

describe('invertMatrix', () => {
  test('A * A^{-1} = I', () => {
    const A = [
      [4, 1],
      [1, 3],
    ];
    const inv = invertMatrix(A);
    const prod = [
      [A[0][0] * inv[0][0] + A[0][1] * inv[1][0], A[0][0] * inv[0][1] + A[0][1] * inv[1][1]],
      [A[1][0] * inv[0][0] + A[1][1] * inv[1][0], A[1][0] * inv[0][1] + A[1][1] * inv[1][1]],
    ];
    expect(prod[0][0]).toBeCloseTo(1, 10);
    expect(prod[0][1]).toBeCloseTo(0, 10);
    expect(prod[1][0]).toBeCloseTo(0, 10);
    expect(prod[1][1]).toBeCloseTo(1, 10);
  });
});

describe('levenbergMarquardt', () => {
  const xs = Array.from({ length: 25 }, (_, i) => i * 0.4);

  test('recovers exponential decay parameters from clean data', () => {
    const truth = { a: 2, b: -0.7 };
    const ys = xs.map((x) => truth.a * Math.exp(truth.b * x));
    const residuals = ([a, b]) => xs.map((x, i) => a * Math.exp(b * x) - ys[i]);
    const fit = levenbergMarquardt(residuals, [1, -0.2]);
    expect(fit.converged).toBe(true);
    expect(fit.theta[0]).toBeCloseTo(2, 5);
    expect(fit.theta[1]).toBeCloseTo(-0.7, 5);
    expect(fit.ssr).toBeLessThan(1e-10);
  });

  test('recovers parameters from noisy data within confidence intervals', () => {
    const truth = { a: 5, b: -0.4 };
    // deterministic pseudo-noise (no Math.random in tests either, keeps goldens stable)
    const noise = xs.map((_, i) => 0.02 * Math.sin(12.9898 * (i + 1)));
    const ys = xs.map((x, i) => truth.a * Math.exp(truth.b * x) + noise[i]);
    const residuals = ([a, b]) => xs.map((x, i) => a * Math.exp(b * x) - ys[i]);
    const fit = levenbergMarquardt(residuals, [2, -1]);
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.theta[0] - truth.a)).toBeLessThan(0.1);
    expect(Math.abs(fit.theta[1] - truth.b)).toBeLessThan(0.05);
    const [aLo, aHi] = fit.confidence95[0];
    expect(aLo).toBeLessThan(truth.a + 0.1);
    expect(aHi).toBeGreaterThan(truth.a - 0.1);
    expect(fit.standardErrors.every((se) => Number.isFinite(se) && se > 0)).toBe(true);
  });

  test('respects box bounds', () => {
    const ys = xs.map((x) => 3 * x + 1);
    const residuals = ([m, c]) => xs.map((x, i) => m * x + c - ys[i]);
    const fit = levenbergMarquardt(residuals, [0.5, 0.5], {
      bounds: [
        [0, 2], // slope capped below the true value of 3
        [-10, 10],
      ],
    });
    expect(fit.theta[0]).toBeLessThanOrEqual(2 + 1e-9);
  });

  test('reports iteration progress via onIteration', () => {
    const ys = xs.map((x) => 2 * x);
    const residuals = ([m]) => xs.map((x, i) => m * x - ys[i]);
    const seen = [];
    levenbergMarquardt(residuals, [0], { onIteration: (iter, ssr) => seen.push([iter, ssr]) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1][1]).toBeLessThan(1e-8);
  });

  test('jacobianStep lifts quantized residuals above the noise floor (ET2)', () => {
    // Residual from an iterative solver stopped at a coarse tolerance:
    // quantized to steps of 0.05. The default relative step (1e-6 of
    // theta ~ 1) changes the residual by ~1e-5, far below the quantum,
    // so the derivative reads zero and LM cannot move. A step wider
    // than the quantum recovers the fit.
    const quantize = (v) => Math.round(v / 0.05) * 0.05;
    const residuals = ([t]) => [quantize(10 * (t - 1.42))];
    const stuck = levenbergMarquardt(residuals, [1], {});
    expect(Math.abs(stuck.theta[0] - 1)).toBeLessThan(1e-3);
    const fit = levenbergMarquardt(residuals, [1], { jacobianStep: [0.02] });
    expect(Math.abs(fit.theta[0] - 1.42)).toBeLessThan(0.01);
  });
});
