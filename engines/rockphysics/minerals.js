// Mineral moduli + Voigt-Reuss-Hill mixing (Rock Physics Studio G6.1).
// Default moduli from the Rock Physics Handbook (Mavko, Mukerji &
// Dvorkin) mineral tables — editable in the UI parameter panel; the
// math never hides constants (petrophysics engine rule).

/** RPH defaults, Pa. */
export const MINERALS = {
  quartz: { k: 36.6e9, mu: 45.0e9, rho: 2650 },
  calcite: { k: 76.8e9, mu: 32.0e9, rho: 2710 },
  dolomite: { k: 94.9e9, mu: 45.0e9, rho: 2870 },
  clay: { k: 20.9e9, mu: 6.9e9, rho: 2580 },
};

/** Voigt-Reuss-Hill average. parts = [{frac, m}] with fracs summing
 *  to 1 and m the modulus (K or mu) of each mineral. */
export function voigtReussHill(parts) {
  const total = parts.reduce((s, p) => s + p.frac, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error('Fractions must sum to 1.');
  let voigt = 0;
  let inv = 0;
  for (const p of parts) {
    if (p.frac < 0) throw new Error('Fractions must be >= 0.');
    if (p.frac > 0) {
      if (!(p.m > 0)) throw new Error('Moduli must be positive.');
      voigt += p.frac * p.m;
      inv += p.frac / p.m;
    }
  }
  return 0.5 * (voigt + 1 / inv);
}

/** Mixed mineral {k, mu, rho} from {name|k,mu,rho, frac} entries. */
export function mixMinerals(entries) {
  const parts = entries.map((e) => {
    const base = e.name ? MINERALS[e.name] : e;
    if (!base) throw new Error(`Unknown mineral "${e.name}".`);
    return { ...base, frac: e.frac };
  });
  return {
    k: voigtReussHill(parts.map((p) => ({ frac: p.frac, m: p.k }))),
    mu: voigtReussHill(parts.map((p) => ({ frac: p.frac, m: p.mu }))),
    rho: parts.reduce((s, p) => s + p.frac * p.rho, 0),
  };
}
