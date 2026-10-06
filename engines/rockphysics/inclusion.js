// Inclusion-based rock physics models (QI programme Q2, Milestone A1b).
// Forms as published in Mavko, Mukerji & Dvorkin, The Rock Physics Handbook
// (2nd ed., 2009): Berryman (1980) strain concentration factors P and Q for
// spheroids (4.8, Table 4.8.1 notes), Kuster-Toksoz (4.8.1), differential
// effective medium (4.11); and Xu & White (1995) for clay-bearing sands.
// Validated against an independent oracle (tools/validation/rockphysics/
// oracle_inclusion.py), rockphypy's P and Q (oblate pores) and an adaptive
// ODE integration of the DEM (crosscheck_inclusion_rockphypy.py).
//
// SI throughout: moduli in Pa. Aspect ratio alpha < 1 is oblate (cracks and
// flat pores), alpha = 1 is a sphere, alpha > 1 is prolate (needles).

import { hashinShtrikman, hsZeta, dryToVelocities } from './granular.js';

const isPos = (x) => Number.isFinite(x) && x > 0;

/**
 * Berryman (1980) P and Q for a spheroidal inclusion (Ki, Gi, aspect ratio
 * alpha) in a background (Km, Gm).
 * @returns {{P:number, Q:number}}
 */
export function berrymanPQ(Km, Gm, Ki, Gi, alpha) {
  if (!isPos(Km) || !isPos(Gm)) throw new Error('Background moduli must be positive.');
  if (!(Ki >= 0) || !(Gi >= 0)) throw new Error('Inclusion moduli must be zero or positive.');
  if (!isPos(alpha)) throw new Error('Aspect ratio must be positive.');
  if (Math.abs(alpha - 1) < 1e-6) {
    const z = hsZeta(Km, Gm);
    return { P: (Km + (4 / 3) * Gm) / (Ki + (4 / 3) * Gm), Q: (Gm + z) / (Gi + z) };
  }
  const a2 = alpha * alpha;
  const theta = alpha < 1
    ? (alpha / (1 - a2) ** 1.5) * (Math.acos(alpha) - alpha * Math.sqrt(1 - a2))
    : (alpha / (a2 - 1) ** 1.5) * (alpha * Math.sqrt(a2 - 1) - Math.acosh(alpha));
  const f = (a2 / (1 - a2)) * (3 * theta - 2);
  const A = Gi / Gm - 1;
  const B = (Ki / Km - Gi / Gm) / 3;
  const R = Gm / (Km + (4 / 3) * Gm);
  const F1 = 1 + A * (1.5 * (f + theta) - R * (1.5 * f + 2.5 * theta - 4 / 3));
  const F2 = 1 + A * (1 + 1.5 * (f + theta) - R * (1.5 * f + 2.5 * theta)) + B * (3 - 4 * R)
    + A * (A + 3 * B) * (1.5 - 2 * R) * (f + theta - R * (f - theta + 2 * theta * theta));
  const F3 = 1 + A * (1 - f - 1.5 * theta + R * (f + theta));
  const F4 = 1 + (A / 4) * (f + 3 * theta - R * (f - theta));
  const F5 = A * (-f + R * (f + theta - 4 / 3)) + B * theta * (3 - 4 * R);
  const F6 = 1 + A * (1 + f - R * (f + theta)) + B * (1 - theta) * (3 - 4 * R);
  const F7 = 2 + (A / 4) * (3 * f + 9 * theta - R * (3 * f + 5 * theta)) + B * theta * (3 - 4 * R);
  const F8 = A * (1 - 2 * R + (f / 2) * (R - 1) + (theta / 2) * (5 * R - 3)) + B * (1 - theta) * (3 - 4 * R);
  const F9 = A * ((R - 1) * f - R * theta) + B * theta * (3 - 4 * R);
  const Tiijj = (3 * F1) / F2;
  const Tijij = Tiijj / 3 + 2 / F3 + 1 / F4 + (F4 * F5 + F6 * F7 - F8 * F9) / (F2 * F4);
  const P = Tiijj / 3;
  return { P, Q: (Tijij - P) / 5 };
}

function checkInclusions(inclusions) {
  if (!Array.isArray(inclusions) || inclusions.length === 0) throw new Error('Give at least one inclusion type.');
  for (const c of inclusions) {
    if (!(c.x >= 0)) throw new Error('Inclusion fractions must be zero or positive.');
    if (!(c.K >= 0) || !(c.G >= 0) || !isPos(c.alpha)) throw new Error('Each inclusion needs K, G >= 0 and a positive aspect ratio.');
  }
}

/**
 * Kuster-Toksoz (dilute, non-interacting) effective moduli (RPH 4.8.1).
 * Valid only while the inclusion concentration is small relative to the
 * aspect ratio; prefer differentialEffectiveMedium for real porosity.
 * @param {{Km:number, Gm:number, inclusions:{K:number, G:number, alpha:number, x:number}[]}} p
 *   x is each inclusion type's volume fraction of the rock
 */
export function kusterToksoz({ Km, Gm, inclusions }) {
  checkInclusions(inclusions);
  let sK = 0;
  let sG = 0;
  for (const c of inclusions) {
    const { P, Q } = berrymanPQ(Km, Gm, c.K, c.G, c.alpha);
    sK += c.x * (c.K - Km) * P;
    sG += c.x * (c.G - Gm) * Q;
  }
  const a = (4 / 3) * Gm;
  const z = hsZeta(Km, Gm);
  const K = (Km * (Km + a) + sK * a) / (Km + a - sK);
  const G = (Gm * (Gm + z) + sG * z) / (Gm + z - sG);
  if (!(K > 0 && G >= 0) || Km + a - sK <= 0 || Gm + z - sG <= 0) {
    throw new Error('Kuster-Toksoz is outside its dilute range here (moduli went non-physical); use the differential effective medium.');
  }
  return { K, G };
}

/**
 * Differential effective medium (RPH 4.11.1-4.11.2): inclusions are added
 * in small steps to the evolving composite, in fixed proportions among the
 * inclusion types, until their total volume fraction reaches y. Fourth-order
 * Runge-Kutta in y with `steps` steps.
 * @param {{Km:number, Gm:number, inclusions:{K:number, G:number, alpha:number, w:number}[], y:number, steps?:number}} p
 *   w is each type's share of the inclusion volume (shares sum to 1)
 */
function demSetup({ Km, Gm, inclusions }) {
  if (!isPos(Km) || !isPos(Gm)) throw new Error('Host moduli must be positive.');
  if (!Array.isArray(inclusions) || inclusions.length === 0) throw new Error('Give at least one inclusion type.');
  const wSum = inclusions.reduce((s, c) => s + c.w, 0);
  if (Math.abs(wSum - 1) > 1e-9) throw new Error(`Inclusion shares must sum to 1 (got ${wSum}).`);
  checkInclusions(inclusions.map((c) => ({ ...c, x: c.w })));
  const rate = (t, K, G) => {
    let dK = 0;
    let dG = 0;
    for (const c of inclusions) {
      if (c.w === 0) continue;
      const { P, Q } = berrymanPQ(K, G, c.K, c.G, c.alpha);
      dK += c.w * (c.K - K) * P;
      dG += c.w * (c.G - G) * Q;
    }
    return [dK / (1 - t), dG / (1 - t)];
  };
  // one RK4 step from t to t + h
  return (t, K, G, h) => {
    const k1 = rate(t, K, G);
    const k2 = rate(t + h / 2, K + (h / 2) * k1[0], G + (h / 2) * k1[1]);
    const k3 = rate(t + h / 2, K + (h / 2) * k2[0], G + (h / 2) * k2[1]);
    const k4 = rate(t + h, K + h * k3[0], G + h * k3[1]);
    const nK = K + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    const nG = G + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    // DEM decays towards zero without crossing it; below a millionth of the
    // host the frame has no usable stiffness (thin cracks at high porosity)
    if (!(nK > 1e-6 * Km) || !(nG > 1e-6 * Gm)) throw new Error('The frame has no usable stiffness at this porosity for these aspect ratios (pores too flat for the porosity).');
    return [nK, nG];
  };
}

/**
 * Differential effective medium (RPH 4.11.1-4.11.2): inclusions are added
 * in small steps to the evolving composite, in fixed proportions among the
 * inclusion types, until their total volume fraction reaches y. Fourth-order
 * Runge-Kutta in y with `steps` steps.
 * @param {{Km:number, Gm:number, inclusions:{K:number, G:number, alpha:number, w:number}[], y:number, steps?:number}} p
 *   w is each type's share of the inclusion volume (shares sum to 1)
 */
export function differentialEffectiveMedium({ Km, Gm, inclusions, y, steps = 400 }) {
  const step = demSetup({ Km, Gm, inclusions });
  if (!(y >= 0 && y < 1)) throw new Error('Inclusion volume fraction must be in [0, 1).');
  let K = Km;
  let G = Gm;
  const h = y / steps;
  for (let i = 0; i < steps && h > 0; i++) [K, G] = step(i * h, K, G, h);
  return { K, G };
}

/**
 * The DEM along a path of increasing inclusion fractions in one pass (a
 * template line): RK4 with steps no longer than maxStep, landing exactly
 * on every requested fraction. Same moduli as differentialEffectiveMedium
 * to the integration accuracy.
 * @returns {{y:number, K:number, G:number}[]} in the order of ys
 */
export function differentialEffectiveMediumPath({ Km, Gm, inclusions, ys, maxStep = 1e-3 }) {
  const step = demSetup({ Km, Gm, inclusions });
  if (!Array.isArray(ys) || ys.some((y) => !(y >= 0 && y < 1))) throw new Error('Inclusion volume fractions must be in [0, 1).');
  const order = ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(ys.length);
  let t = 0;
  let K = Km;
  let G = Gm;
  for (const [y, i] of order) {
    const span = y - t;
    const n = Math.ceil(span / maxStep - 1e-9);
    for (let j = 0; j < n; j++) {
      const h = span / n;
      [K, G] = step(t + j * h, K, G, h);
    }
    t = y;
    out[i] = { y, K, G };
  }
  return out;
}

/**
 * Xu-White (1995) clay-sand model, dry frame by differential effective medium
 * then Gassmann. Total porosity is split into sand-related pores (stiff,
 * aspect ratio alphaSand, default 0.12) and clay-related pores (compliant,
 * alphaClay, default 0.03) in proportion to the clay share of the solid
 * (Xu and White 1995). Mineral moduli are the Hashin-Shtrikman average of
 * the sand and clay minerals.
 * @param {Object} p
 * @param {number} p.phi total porosity (0, 1)
 * @param {number} p.vclay clay volume fraction of the bulk rock
 * @param {{K:number, G:number, rho:number}} p.sand
 * @param {{K:number, G:number, rho:number}} p.clay
 * @param {{K:number, rho:number}} [p.fluid] if given, saturated velocities are returned
 */
export function xuWhite({ phi, vclay, sand, clay, fluid, alphaSand = 0.12, alphaClay = 0.03, steps = 400 }) {
  if (!(phi > 0 && phi < 1)) throw new Error('Porosity must be in (0, 1).');
  if (!(vclay >= 0 && vclay <= 1 - phi)) throw new Error('Clay volume must be between 0 and 1 minus porosity.');
  const fc = vclay / (1 - phi);
  const hs = hashinShtrikman([{ K: sand.K, G: sand.G, f: 1 - fc }, { K: clay.K, G: clay.G, f: fc }]);
  const Km = (hs.kUpper + hs.kLower) / 2;
  const Gm = (hs.gUpper + hs.gLower) / 2;
  const rhoMin = (1 - fc) * sand.rho + fc * clay.rho;
  const dry = differentialEffectiveMedium({
    Km,
    Gm,
    y: phi,
    steps,
    inclusions: [
      { K: 0, G: 0, alpha: alphaSand, w: 1 - fc },
      { K: 0, G: 0, alpha: alphaClay, w: fc },
    ],
  });
  const out = { kdry: dry.K, gdry: dry.G, kmin: Km, gmin: Gm, rhoMin, phiClay: phi * fc, phiSand: phi * (1 - fc) };
  if (fluid) Object.assign(out, dryToVelocities({ kdry: dry.K, gdry: dry.G, kmin: Km, kfl: fluid.K, phi, rhoMin, rhoFl: fluid.rho }));
  return out;
}
