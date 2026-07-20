/**
 * Warren-Root dual-porosity interporosity transfer functions (WT3).
 *
 * A naturally fractured reservoir is modeled by replacing the Laplace
 * variable u in the homogeneous radial solution with u f(u):
 *
 *   pseudo-steady-state matrix flow (Warren & Root, 1963):
 *     f(u) = [ omega (1-omega) u + lambda ] / [ (1-omega) u + lambda ]
 *
 *   transient matrix flow, slab matrix blocks (de Swaan / Serra et al.):
 *     f(u) = omega + sqrt( lambda (1-omega) / (3 u) )
 *                    * tanh( sqrt( 3 (1-omega) u / lambda ) )
 *
 * omega  = storativity ratio (phi ct)_f / (phi ct)_total, 0 < omega <= 1
 * lambda = interporosity flow coefficient alpha k_m rw^2 / k_f
 *
 * Exact limits (harness gates): omega -> 1 gives f = 1 (homogeneous);
 * early time (large u) gives f -> omega (fissure system flowing alone);
 * late time (small u) gives f -> 1 (total system).
 */

export const INTERPOROSITY_MODES = ['pss', 'transient-slab'];

/** f(u) for the chosen interporosity mode. */
export const interporosityF = (u, { omega = 1, lambda = 1e-6, mode = 'pss' } = {}) => {
  if (!(u > 0)) return NaN;
  const w = Math.min(Math.max(omega, 1e-6), 1);
  if (w >= 1) return 1;
  const lam = Math.max(lambda, 1e-30);
  if (mode === 'transient-slab') {
    const arg = Math.sqrt((3 * (1 - w) * u) / lam);
    return w + Math.sqrt((lam * (1 - w)) / (3 * u)) * Math.tanh(arg);
  }
  // pseudo-steady state (Warren-Root)
  return (w * (1 - w) * u + lam) / ((1 - w) * u + lam);
};
