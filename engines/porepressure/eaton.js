// Eaton (1975) pore pressure — PP = S - (S - P_h) * ratio^n, where
// ratio = dt_n/dt (sonic form) or V/V_n (velocity form), both < 1 in
// overpressure. Validated against the porepressure oracle goldens.

/** Eaton pore pressure [Pa]. */
export function eaton(S, Ph, ratio, n = 3.0) {
  if (!(ratio > 0)) throw new Error('Eaton ratio must be positive.');
  if (!Number.isFinite(S) || !Number.isFinite(Ph)) {
    throw new Error('Stresses must be finite.');
  }
  if (!(n >= 0)) throw new Error('Eaton exponent must be >= 0.');
  return S - (S - Ph) * ratio ** n;
}
