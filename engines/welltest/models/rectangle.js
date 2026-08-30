/**
 * Closed rectangular reservoir (WT6): homogeneous reservoir, vertical well
 * at an arbitrary position inside a no-flow rectangle, composed with
 * constant wellbore storage and skin through the universal Laplace
 * composition in radial.js.
 *
 * Geometry (dimensionless, rw units): rectangle [0, xeD] x [0, yeD] with
 * the well at (xwD, ywD). The catalog parameterizes it as four boundary
 * distances L1/L2 (x direction) and W1/W2 (y direction):
 *   xeD = (L1 + L2)/rw, xwD = L1/rw, yeD = (W1 + W2)/rw, ywD = W1/rw.
 *
 * Solution, b = sqrt(u):
 *
 *   pbarD(u) = p0(u) + (1/u) * sum_images K0(d_i b)
 *
 * where p0 is the WT1 finite-radius well solution K0(b)/(u b K1(b)) and the
 * images are the standard no-flow mirror lattice of the rectangle: x offsets
 * {2 m xeD} u {2 m xeD - 2 xwD}, y offsets {2 n yeD} u {2 n yeD - 2 ywD},
 * every (dx, dy) combination except the well itself. K0 terms with argument
 * beyond the WT3 cutoff (38) are dropped; as u grows the sum empties and the
 * model reduces exactly to the infinite-acting homogeneous solution.
 *
 * For small u the lattice inside the cutoff radius grows like 1/(u AD).
 * Once the estimated image count passes IMAGE_CAP the solution switches to
 * the exact boundary-dominated asymptote of a closed system,
 *
 *   pbarD(u) ~= 2 pi / (AD u^2) + b_int / u,   AD = xeD yeD,
 *
 * whose time-domain form is the pseudo-steady-state line
 * pwD = 2 pi tDA + b_int. The intercept b_int is the Dietz constant
 * 0.5 ln(2.2458 AD / (CA rw^2-free)) for the geometry; instead of a shape
 * factor lookup it is extracted once per geometry from the lattice sum
 * itself at the crossover u*, via Richardson extrapolation in u of
 * u pbarD(u) - 2 pi/(AD u) (the residual decays linearly in u), and cached.
 * Harness gates pin b_int against the published Dietz CA values for the
 * centered square (30.8828) and 2:1 rectangle (21.8369), and the PSS slope
 * against the exact 2 pi/AD.
 *
 * Skin is restricted to S >= 0 (same reason as the rest of the boundary
 * family, see radial.js).
 */

import { besselK0e, besselK1e } from '../numerics.js';
import { composeWellbore } from './radial.js';

const K0 = (x) => besselK0e(x) * Math.exp(-x); // args stay <= K0_CUTOFF_ARG

const K0_CUTOFF_ARG = 38; // K0(38) ~ 1e-18 (same cutoff as radial.js images)
const IMAGE_CAP = 40000; // lattice size beyond which the PSS asymptote takes over

/**
 * Sum of K0(d * b) over the no-flow mirror lattice of the rectangle,
 * excluding the source itself. Offsets in each axis come in two families:
 * translations 2 m E and reflections 2 m E - 2 w.
 */
const latticeK0Sum = (b, { xeD, yeD, xwD, ywD }) => {
  const R = K0_CUTOFF_ARG / b; // beyond this distance K0 is numerically zero
  const mMax = Math.ceil(R / (2 * xeD)) + 1;
  const nMax = Math.ceil(R / (2 * yeD)) + 1;
  const dxs = [];
  for (let m = -mMax; m <= mMax; m += 1) {
    const t = 2 * m * xeD;
    dxs.push([t, true]); // translation family (dx = 0 at m = 0 is the source axis)
    dxs.push([t - 2 * xwD, false]); // reflection family
  }
  const dys = [];
  for (let n = -nMax; n <= nMax; n += 1) {
    const t = 2 * n * yeD;
    dys.push([t, true]);
    dys.push([t - 2 * ywD, false]);
  }
  let sum = 0;
  for (const [dx, xIsTranslation] of dxs) {
    if (Math.abs(dx) > R) continue;
    for (const [dy, yIsTranslation] of dys) {
      if (dx === 0 && dy === 0 && xIsTranslation && yIsTranslation) continue; // the well
      const d = Math.hypot(dx, dy);
      if (d > R || d === 0) continue; // d === 0 only for degenerate zero offsets
      const arg = d * b;
      if (arg <= K0_CUTOFF_ARG) sum += K0(arg);
    }
  }
  return sum;
};

/** Finite-radius well infinite-acting sandface solution (WT1). */
const p0FiniteRadius = (u, b) => besselK0e(b) / (u * b * besselK1e(b));

/** Lattice-route sandface solution, valid while the lattice is affordable. */
const latticePwd = (u, geom) => {
  const b = Math.sqrt(u);
  return p0FiniteRadius(u, b) + latticeK0Sum(b, geom) / u;
};

/** Estimated image count inside the K0 cutoff radius at Laplace variable u. */
const estimatedImages = (u, { xeD, yeD }) =>
  (Math.PI * K0_CUTOFF_ARG * K0_CUTOFF_ARG) / (u * xeD * yeD);

const intercepts = new Map(); // geometry -> Dietz-type PSS intercept b_int

/**
 * PSS intercept for the geometry, from the lattice sum itself at the
 * largest affordable u values (Richardson extrapolation: the residual
 * u pbarD - 2 pi/(AD u) approaches b_int linearly in u).
 */
export const rectanglePssIntercept = (geom) => {
  const { xeD, yeD, xwD, ywD } = geom;
  const key = `${xeD}|${yeD}|${xwD}|${ywD}`;
  const cached = intercepts.get(key);
  if (cached !== undefined) return cached;
  const AD = xeD * yeD;
  const uStar = (Math.PI * K0_CUTOFF_ARG * K0_CUTOFF_ARG) / (IMAGE_CAP * AD);
  const residual = (u) => u * latticePwd(u, geom) - (2 * Math.PI) / (AD * u);
  const b1 = residual(uStar);
  const b2 = residual(uStar / 2); // twice the images, one-time cost, cached
  const bInt = 2 * b2 - b1;
  intercepts.set(key, bInt);
  return bInt;
};

/**
 * Sandface pbarD(u) for the closed rectangle.
 * @param {number} u Laplace variable (rw-based tD domain)
 * @param {{xeD: number, yeD: number, xwD: number, ywD: number}} geom
 */
export const rectangleSandfaceLaplace = (u, geom) => {
  if (!(u > 0)) return NaN;
  const { xeD, yeD, xwD, ywD } = geom;
  if (!(xeD > 0) || !(yeD > 0) || !(xwD > 0) || !(ywD > 0)) return NaN;
  if (!(xwD < xeD) || !(ywD < yeD)) return NaN;
  if (estimatedImages(u, geom) > IMAGE_CAP) {
    const AD = xeD * yeD;
    return (2 * Math.PI) / (AD * u * u) + rectanglePssIntercept(geom) / u;
  }
  return latticePwd(u, geom);
};

/**
 * Factory: catalog-ready pwdLaplace(u, dimless) for the closed rectangle.
 * dimless: { xeD, yeD, xwD, ywD, skin, cd }.
 */
export const makeRectanglePwdLaplace = () => (u, dimless = {}) => {
  const p0 = rectangleSandfaceLaplace(u, dimless);
  return composeWellbore(u, p0, dimless.skin, dimless.cd);
};
