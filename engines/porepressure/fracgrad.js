// Fracture pressure, coefficient form: FP = K*(S - PP) + PP.
// Eaton: K = nu/(1 - nu); Matthews-Kelly is the same identity with an
// empirical K(z) — one function serves both. Validated against the
// porepressure oracle goldens.

/** Fracture pressure [Pa]. */
export function fracPressure(S, PP, K) {
  if (!(K >= 0)) throw new Error('Stress-ratio coefficient K must be >= 0.');
  if (!Number.isFinite(S) || !Number.isFinite(PP)) {
    throw new Error('Stresses must be finite.');
  }
  return K * (S - PP) + PP;
}

/** Eaton's K from Poisson's ratio. */
export function eatonK(nu) {
  if (!(nu >= 0) || !(nu < 0.5)) {
    throw new Error("Poisson's ratio must be in [0, 0.5).");
  }
  return nu / (1.0 - nu);
}

// ---- fracture methods (U2-012) --------------------------------------------
// All three are the coefficient form FP = K (S - PP) + PP with a
// different K (Zhang and Yin, "Fracture gradient prediction: an overview
// and an improved method", Pet. Sci. 14, 2017, eqs. 3, 4, 7):
//   Eaton (1969):            K = nu / (1 - nu)
//   Matthews and Kelly (1967): K = k0, the matrix (effective) stress
//     coefficient; Zhang and Yin's LOT study puts the most likely k0 at 0.75
//   Daines (1982):           K = beta + nu / (1 - nu), beta the superposed
//     tectonic stress over the effective overburden, taken from a LOT
// Eaton equals Matthews and Kelly when k0 = nu / (1 - nu); Daines equals
// Eaton when beta = 0.

export const FRAC_METHODS = Object.freeze(['eaton', 'matthews-kelly', 'daines']);
export const MATTHEWS_KELLY_K0_MOST_LIKELY = 0.75;

/** Matthews and Kelly fracture pressure [Pa] with a matrix stress coefficient k0. */
export function matthewsKellyFP(S, PP, k0) {
  if (!(k0 >= 0) || !(k0 <= 1.5)) throw new Error('Matrix stress coefficient k0 must be in [0, 1.5].');
  return fracPressure(S, PP, k0);
}

/** Daines fracture pressure [Pa]: (beta + nu/(1-nu)) (S - PP) + PP. */
export function dainesFP(S, PP, nu, beta) {
  if (!Number.isFinite(beta)) throw new Error('Daines beta must be finite.');
  const K = beta + eatonK(nu);
  if (!(K >= 0)) throw new Error('Daines beta + nu/(1-nu) must be >= 0.');
  return fracPressure(S, PP, K);
}

/** The effective stress coefficient a leak-off test implies: (LOT - PP) / (S - PP). */
export function k0FromLot(lotPa, S, PP) {
  if (![lotPa, S, PP].every(Number.isFinite)) throw new Error('LOT, overburden and pore pressure must be finite.');
  if (!(S - PP > 0)) throw new Error('The effective overburden at the LOT depth must be positive.');
  return (lotPa - PP) / (S - PP);
}

/** Daines beta from a leak-off test: k0 from the LOT minus nu/(1-nu). */
export function dainesBetaFromLot(lotPa, S, PP, nu) {
  return k0FromLot(lotPa, S, PP) - eatonK(nu);
}

/**
 * The coefficient K for a method's parameters.
 * @param {{fracMethod?: string, nu?: number, K?: number, k0?: number, beta?: number}} p
 */
export function fracCoefficient(p = {}) {
  const method = p.fracMethod || 'eaton';
  if (method === 'eaton') return p.K != null ? p.K : eatonK(p.nu != null ? p.nu : 0.4);
  if (method === 'matthews-kelly') {
    const k0 = p.k0 != null ? p.k0 : MATTHEWS_KELLY_K0_MOST_LIKELY;
    if (!(k0 >= 0) || !(k0 <= 1.5)) throw new Error('Matrix stress coefficient k0 must be in [0, 1.5].');
    return k0;
  }
  if (method === 'daines') {
    const K = (p.beta ?? 0) + eatonK(p.nu != null ? p.nu : 0.4);
    if (!(K >= 0)) throw new Error('Daines beta + nu/(1-nu) must be >= 0.');
    return K;
  }
  throw new Error(`Unknown fracture method '${method}'.`);
}
