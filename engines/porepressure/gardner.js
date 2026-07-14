// Gardner (1974) density-velocity transform — metric coefficients
// (a = 0.31 pairs with m/s; the classic 0.23 pairs with ft/s).
// Validated against the porepressure oracle goldens.

/** Bulk density [kg/m3] from velocity [m/s]. */
export function gardnerRho(v, a = 0.31, b = 0.25) {
  if (!(v > 0)) throw new Error('Velocity must be positive.');
  if (!(a > 0) || !(b > 0)) throw new Error('Gardner coefficients must be positive.');
  return 1000.0 * a * v ** b;
}

/** Velocity [m/s] from bulk density [kg/m3] (Gardner inverted). */
export function gardnerV(rho, a = 0.31, b = 0.25) {
  if (!(rho > 0)) throw new Error('Density must be positive.');
  if (!(a > 0) || !(b > 0)) throw new Error('Gardner coefficients must be positive.');
  return (rho / 1000.0 / a) ** (1.0 / b);
}
