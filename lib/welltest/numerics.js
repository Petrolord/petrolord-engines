/**
 * Well Test Analysis Studio - numerical kernel
 *
 * Special functions and the numerical Laplace inversion that every analytical
 * pressure-transient model in this module is built on:
 *
 *  - Modified Bessel functions I0, I1, K0, K1 via the Abramowitz & Stegun
 *    polynomial approximations (A&S 9.8.1-9.8.8, abs error < ~2e-7).
 *    Exponentially scaled variants K0e(x) = e^x K0(x) and K1e(x) = e^x K1(x)
 *    are exported so Laplace-space model ratios stay finite for large
 *    arguments (K0/K1 underflow past x ~ 700 otherwise; in the ratios used by
 *    the models the e^{-x} factors cancel exactly).
 *  - Exponential integral E1(x) for x > 0 (ascending series for x <= 1,
 *    modified Lentz continued fraction for x > 1). The line-source solution is
 *    pD = 0.5 * E1(rD^2 / (4 tD)).
 *  - Gaver-Stehfest numerical Laplace inversion (default N = 12). Accuracy for
 *    the smooth, monotonic pressure responses used here is ~0.1% or better,
 *    which is well inside gauge resolution.
 *
 * Pure functions, oilfield-unit agnostic (everything here is dimensionless).
 * Validated against tools/validation/welltest goldens (integral-based Python
 * oracle) and known transform pairs; see __tests__/numerics.test.js.
 */

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Modified Bessel function I0(x). A&S 9.8.1 / 9.8.2. */
export const besselI0 = (x) => {
  const ax = Math.abs(num(x));
  if (ax < 3.75) {
    const t = (ax / 3.75) * (ax / 3.75);
    return (
      1 +
      t * (3.5156229 +
        t * (3.0899424 +
          t * (1.2067492 +
            t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))))
    );
  }
  const t = 3.75 / ax;
  const poly =
    0.39894228 +
    t * (0.01328592 +
      t * (0.00225319 +
        t * (-0.00157565 +
          t * (0.00916281 +
            t * (-0.02057706 +
              t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))));
  return (Math.exp(ax) / Math.sqrt(ax)) * poly;
};

/** Modified Bessel function I1(x). A&S 9.8.3 / 9.8.4. */
export const besselI1 = (x) => {
  const xv = num(x);
  const ax = Math.abs(xv);
  let result;
  if (ax < 3.75) {
    const t = (ax / 3.75) * (ax / 3.75);
    result =
      ax *
      (0.5 +
        t * (0.87890594 +
          t * (0.51498869 +
            t * (0.15084934 +
              t * (0.02658733 + t * (0.00301532 + t * 0.00032411))))));
  } else {
    const t = 3.75 / ax;
    const poly =
      0.39894228 +
      t * (-0.03988024 +
        t * (-0.00362018 +
          t * (0.00163801 +
            t * (-0.01031555 +
              t * (0.02282967 +
                t * (-0.02895312 + t * (0.01787654 + t * -0.00420059)))))));
    result = (Math.exp(ax) / Math.sqrt(ax)) * poly;
  }
  return xv < 0 ? -result : result;
};

/** Exponentially scaled K0e(x) = e^x K0(x), x > 0. A&S 9.8.5 / 9.8.6. */
export const besselK0e = (x) => {
  const xv = num(x);
  if (xv <= 0) return Number.POSITIVE_INFINITY;
  if (xv <= 2) {
    const t = (xv / 2) * (xv / 2);
    const k0 =
      -Math.log(xv / 2) * besselI0(xv) +
      (-0.57721566 +
        t * (0.4227842 +
          t * (0.23069756 +
            t * (0.0348859 +
              t * (0.00262698 + t * (0.0001075 + t * 0.0000074))))));
    return Math.exp(xv) * k0;
  }
  const t = 2 / xv;
  const poly =
    1.25331414 +
    t * (-0.07832358 +
      t * (0.02189568 +
        t * (-0.01062446 +
          t * (0.00587872 + t * (-0.0025154 + t * 0.00053208)))));
  return poly / Math.sqrt(xv);
};

/** Exponentially scaled K1e(x) = e^x K1(x), x > 0. A&S 9.8.7 / 9.8.8. */
export const besselK1e = (x) => {
  const xv = num(x);
  if (xv <= 0) return Number.POSITIVE_INFINITY;
  if (xv <= 2) {
    const t = (xv / 2) * (xv / 2);
    const k1 =
      Math.log(xv / 2) * besselI1(xv) +
      (1 / xv) *
        (1 +
          t * (0.15443144 +
            t * (-0.67278579 +
              t * (-0.18156897 +
                t * (-0.01919402 + t * (-0.00110404 + t * -0.00004686))))));
    return Math.exp(xv) * k1;
  }
  const t = 2 / xv;
  const poly =
    1.25331414 +
    t * (0.23498619 +
      t * (-0.0365562 +
        t * (0.01504268 +
          t * (-0.00780353 + t * (0.00325614 + t * -0.00068245)))));
  return poly / Math.sqrt(xv);
};

/** Exponentially scaled I0e(x) = e^{-|x|} I0(x); finite for all x (WT3). */
export const besselI0e = (x) => {
  const ax = Math.abs(num(x));
  if (ax < 3.75) return besselI0(ax) * Math.exp(-ax);
  const t = 3.75 / ax;
  const poly =
    0.39894228 +
    t * (0.01328592 +
      t * (0.00225319 +
        t * (-0.00157565 +
          t * (0.00916281 +
            t * (-0.02057706 +
              t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))));
  return poly / Math.sqrt(ax);
};

/** Exponentially scaled I1e(x) = e^{-|x|} I1(x), sign of x preserved (WT3). */
export const besselI1e = (x) => {
  const xv = num(x);
  const ax = Math.abs(xv);
  let result;
  if (ax < 3.75) {
    result = Math.abs(besselI1(ax)) * Math.exp(-ax);
  } else {
    const t = 3.75 / ax;
    const poly =
      0.39894228 +
      t * (-0.03988024 +
        t * (-0.00362018 +
          t * (0.00163801 +
            t * (-0.01031555 +
              t * (0.02282967 +
                t * (-0.02895312 + t * (0.01787654 + t * -0.00420059)))))));
    result = poly / Math.sqrt(ax);
  }
  return xv < 0 ? -result : result;
};

/**
 * Integral of K0: F(x) = int_0^x K0(t) dt, x >= 0 (WT3, fracture models).
 *
 * x <= 9: term-by-term integration of the K0 ascending series
 *   (A&S 9.6.13): K0(t) = -(ln(t/2)+gamma) I0(t) + sum_k H_k (t^2/4)^k/(k!)^2
 *   giving F(x) = sum_k c_k x^{2k+1} [ (1/(2k+1)^2 + H_k/(2k+1))
 *                 - (ln(x/2)+gamma)/(2k+1) ],  c_k = 1/(4^k (k!)^2), H_0 = 0.
 * x > 9: F(x) = pi/2 - int_x^inf K0, with the tail evaluated as
 *   e^{-x} int_0^inf K0e(x+s) e^{-s} ds by fixed composite Simpson on
 *   s in [0, 30] (integrand decays like e^{-s}; truncation < 1e-13 rel).
 * Cross-validated against the integral-based Python oracle.
 */
export const besselK0Integral = (x) => {
  const xv = num(x);
  if (!(xv > 0)) return 0;
  if (xv <= 9) {
    const lnTerm = Math.log(xv / 2) + EULER_GAMMA;
    let ck = 1; // c_0
    let hk = 0; // harmonic number H_0
    let sum = 0;
    for (let k = 0; k <= 40; k += 1) {
      if (k > 0) {
        ck *= (xv * xv) / (4 * k * k); // c_k x^{2k} accumulated
        hk += 1 / k;
      }
      const m = 2 * k + 1;
      const add = ck * xv * (1 / (m * m) + hk / m - lnTerm / m);
      sum += add;
      if (k > 3 && Math.abs(add) < 1e-16 * Math.abs(sum)) break;
    }
    return sum;
  }
  // tail: e^{-x} int_0^30 K0e(x+s) e^{-s} ds, Simpson with 120 intervals
  const S = 30;
  const n = 120;
  const h = S / n;
  let total = besselK0e(xv) + besselK0e(xv + S) * Math.exp(-S);
  for (let i = 1; i < n; i += 1) {
    const s = i * h;
    total += besselK0e(xv + s) * Math.exp(-s) * (i % 2 ? 4 : 2);
  }
  const tail = Math.exp(-xv) * (total * h) / 3;
  return Math.PI / 2 - tail;
};

/** Modified Bessel function K0(x), x > 0. Underflows to 0 past x ~ 700. */
export const besselK0 = (x) => besselK0e(x) * Math.exp(-num(x));

/** Modified Bessel function K1(x), x > 0. Underflows to 0 past x ~ 700. */
export const besselK1 = (x) => besselK1e(x) * Math.exp(-num(x));

const EULER_GAMMA = 0.5772156649015329;

/**
 * Exponential integral E1(x) = int_x^inf e^{-t}/t dt, x > 0.
 * Series (A&S 5.1.11) for x <= 1, modified Lentz continued fraction
 * (A&S 5.1.22) for x > 1. Relative accuracy ~1e-14.
 */
export const expE1 = (x) => {
  const xv = num(x);
  if (xv <= 0) return Number.POSITIVE_INFINITY;
  if (xv <= 1) {
    let sum = 0;
    let term = 1;
    for (let n = 1; n <= 40; n += 1) {
      term *= -xv / n;
      const add = -term / n;
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return -EULER_GAMMA - Math.log(xv) + sum;
  }
  // Continued fraction: E1(x) = e^{-x} * 1/(x+1- 1/(x+3- 4/(x+5- 9/(...))))
  const tiny = 1e-300;
  let b = xv + 1;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const a = -i * i;
    b += 2;
    d = 1 / (a * d + b);
    c = b + a / c;
    const delta = c * d;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h * Math.exp(-xv);
};

/** Ei(-x) = -E1(x) convenience for the line-source solution. */
export const expEi = (x) => -expE1(-num(x));

const factorial = (n) => {
  let f = 1;
  for (let i = 2; i <= n; i += 1) f *= i;
  return f;
};

const stehfestCache = new Map();

/**
 * Gaver-Stehfest weights V_i, i = 1..n (n even). Cached per n.
 * V_i = (-1)^(n/2+i) * sum_{k=floor((i+1)/2)}^{min(i,n/2)}
 *       k^(n/2) (2k)! / ((n/2-k)! k! (k-1)! (i-k)! (2k-i)!)
 */
export const stehfestCoefficients = (n = 12) => {
  const N = num(n, 12);
  if (N < 2 || N % 2 !== 0) {
    throw new Error(`Stehfest N must be a positive even integer, got ${n}`);
  }
  if (stehfestCache.has(N)) return stehfestCache.get(N);
  const half = N / 2;
  const V = [];
  for (let i = 1; i <= N; i += 1) {
    let sum = 0;
    const kMin = Math.floor((i + 1) / 2);
    const kMax = Math.min(i, half);
    for (let k = kMin; k <= kMax; k += 1) {
      sum +=
        (Math.pow(k, half) * factorial(2 * k)) /
        (factorial(half - k) *
          factorial(k) *
          factorial(k - 1) *
          factorial(i - k) *
          factorial(2 * k - i));
    }
    V.push(((half + i) % 2 === 0 ? 1 : -1) * sum);
  }
  stehfestCache.set(N, V);
  return V;
};

/**
 * Invert a Laplace-space function F(s) at time t via Gaver-Stehfest.
 * f(t) ~= (ln2 / t) * sum_i V_i * F(i ln2 / t)
 */
export const stehfestInvert = (laplaceFn, t, n = 12) => {
  const tv = num(t);
  if (!(tv > 0) || typeof laplaceFn !== 'function') return NaN;
  const V = stehfestCoefficients(n);
  const ln2t = Math.LN2 / tv;
  let sum = 0;
  for (let i = 1; i <= V.length; i += 1) {
    const F = laplaceFn(i * ln2t);
    if (!Number.isFinite(F)) return NaN;
    sum += V[i - 1] * F;
  }
  return ln2t * sum;
};
