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
