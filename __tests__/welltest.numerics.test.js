import {
  besselI0,
  besselI1,
  besselK0,
  besselK1,
  besselK0e,
  besselK1e,
  expE1,
  expEi,
  stehfestCoefficients,
  stehfestInvert,
} from '../engines/welltest/numerics.js';

const relErr = (actual, expected) =>
  Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

describe('modified Bessel functions (A&S 9.8 reference values)', () => {
  // Reference values to 10+ digits (Abramowitz & Stegun tables / mpmath)
  const CASES = [
    { fn: besselI0, x: 1, expected: 1.2660658777520084, tol: 1e-6 },
    { fn: besselI0, x: 4, expected: 11.30192195213633, tol: 1e-6 },
    { fn: besselI1, x: 1, expected: 0.565159103992485, tol: 1e-6 },
    { fn: besselI1, x: 2, expected: 1.5906368546373291, tol: 1e-6 },
    { fn: besselK0, x: 0.1, expected: 2.4270690247020166, tol: 1e-6 },
    { fn: besselK0, x: 1, expected: 0.42102443824070834, tol: 1e-6 },
    { fn: besselK0, x: 5, expected: 0.003691098334042594, tol: 1e-4 },
    { fn: besselK1, x: 0.1, expected: 9.853844780870606, tol: 1e-6 },
    { fn: besselK1, x: 1, expected: 0.6019072301972346, tol: 1e-6 },
    { fn: besselK1, x: 5, expected: 0.004044613445452164, tol: 1e-4 },
  ];

  test.each(CASES)('$fn.name($x) matches reference', ({ fn, x, expected, tol }) => {
    expect(relErr(fn(x), expected)).toBeLessThan(tol);
  });

  test('scaled variants satisfy K0e(x) e^{-x} = K0(x)', () => {
    for (const x of [0.05, 0.5, 1.5, 3, 10]) {
      expect(relErr(besselK0e(x) * Math.exp(-x), besselK0(x))).toBeLessThan(1e-12);
      expect(relErr(besselK1e(x) * Math.exp(-x), besselK1(x))).toBeLessThan(1e-12);
    }
  });

  test('scaled K0e stays finite far past the K0 underflow point', () => {
    expect(besselK0(800)).toBe(0); // raw form underflows
    const k0e = besselK0e(800);
    expect(Number.isFinite(k0e)).toBe(true);
    // asymptote: K0e(x) sqrt(x) -> sqrt(pi/2) (1 - 1/(8x) + ...)
    expect(relErr(k0e * Math.sqrt(800), Math.sqrt(Math.PI / 2) * (1 - 1 / 6400))).toBeLessThan(1e-5);
  });

  test('K1/K0 ratio tends to 1 for large argument', () => {
    expect(besselK1e(200) / besselK0e(200)).toBeCloseTo(1, 2);
  });

  test('small-argument limits: K0 ~ -ln(x/2) - gamma, x*K1 ~ 1', () => {
    const x = 1e-4;
    expect(relErr(besselK0(x), -Math.log(x / 2) - 0.5772156649015329)).toBeLessThan(1e-6);
    expect(relErr(x * besselK1(x), 1)).toBeLessThan(1e-6);
  });

  test('non-positive arguments return Infinity for K functions', () => {
    expect(besselK0(0)).toBe(Number.POSITIVE_INFINITY);
    expect(besselK1e(-1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('exponential integral E1', () => {
  const CASES = [
    { x: 0.01, expected: 4.037929576538114 },
    { x: 0.5, expected: 0.5597735947761608 },
    { x: 1, expected: 0.21938393439552029 },
    { x: 2, expected: 0.04890051070806112 },
    { x: 5, expected: 0.001148295591275326 },
  ];

  test.each(CASES)('E1($x) matches reference', ({ x, expected }) => {
    expect(relErr(expE1(x), expected)).toBeLessThan(1e-10);
  });

  test('Ei(-x) = -E1(x)', () => {
    expect(expEi(-1.5)).toBeCloseTo(-expE1(1.5), 12);
  });

  test('E1 of non-positive argument is Infinity', () => {
    expect(expE1(0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('Gaver-Stehfest inversion', () => {
  test('coefficient identities: sum V_i = 0 and sum V_i / i = 1', () => {
    for (const n of [8, 12, 16]) {
      const V = stehfestCoefficients(n);
      expect(V).toHaveLength(n);
      const sum = V.reduce((a, v) => a + v, 0);
      const sumOverI = V.reduce((a, v, idx) => a + v / (idx + 1), 0);
      expect(Math.abs(sum)).toBeLessThan(1e-4 * Math.max(...V.map(Math.abs)));
      expect(sumOverI).toBeCloseTo(1, 7);
    }
  });

  test('rejects odd N', () => {
    expect(() => stehfestCoefficients(7)).toThrow();
  });

  test('inverts known transform pairs', () => {
    // F(s) = 1/s  ->  f(t) = 1
    expect(stehfestInvert((s) => 1 / s, 3.7)).toBeCloseTo(1, 8);
    // F(s) = 1/s^2  ->  f(t) = t
    expect(relErr(stehfestInvert((s) => 1 / (s * s), 2.5), 2.5)).toBeLessThan(1e-5);
    // F(s) = 1/(s+2)  ->  f(t) = e^{-2t}
    expect(relErr(stehfestInvert((s) => 1 / (s + 2), 0.5), Math.exp(-1))).toBeLessThan(1e-4);
    // F(s) = 1/sqrt(s)  ->  f(t) = 1/sqrt(pi t)
    expect(relErr(stehfestInvert((s) => 1 / Math.sqrt(s), 2), 1 / Math.sqrt(2 * Math.PI))).toBeLessThan(1e-4);
    // F(s) = s^{-3/2}  ->  f(t) = 2 sqrt(t/pi)
    expect(relErr(stehfestInvert((s) => Math.pow(s, -1.5), 4), 2 * Math.sqrt(4 / Math.PI))).toBeLessThan(1e-4);
  });

  test('returns NaN for invalid time or non-finite transform', () => {
    expect(stehfestInvert((s) => 1 / s, 0)).toBeNaN();
    expect(stehfestInvert(() => NaN, 1)).toBeNaN();
  });
});
