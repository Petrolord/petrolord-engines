// Vs estimation when no shear log exists (Rock Physics Studio G6.1).
// Castagna et al. (1985) mudrock line + Greenberg & Castagna (1992)
// polynomial regressions (coefficients cross-checked against rockphypy
// and auralib; see test-data/rockphysics/README.md). Brine-saturated
// rock assumption — substitute fluids AFTER estimating Vs.
//
// Every estimate carries source: 'estimated' so the UI can badge it —
// the synthetics T(z)-provenance discipline: measured and estimated
// shear are never silently mixed.

// Vs = a2*Vp^2 + a1*Vp + a0, in km/s (GC 1992; RPH p. 516).
export const GC_COEFF = {
  sandstone: [0.0, 0.80416, -0.85588],
  limestone: [-0.05508, 1.01677, -1.03049],
  dolomite: [0.0, 0.58321, -0.07775],
  shale: [0.0, 0.76969, -0.86735],
};

/** Castagna mudrock line, m/s: Vs = 0.8621*Vp - 1172.4. */
export function mudrockVs(vp) {
  return Number.isFinite(vp) ? 0.8621 * vp - 1172.4 : NaN;
}

/** Single-lithology GC regression, m/s in / m/s out. */
export function gcLithVs(vp, lith) {
  const c = GC_COEFF[lith];
  if (!c) throw new Error(`Unknown Greenberg-Castagna lithology "${lith}".`);
  if (!Number.isFinite(vp)) return NaN;
  const vpk = vp / 1000;
  return (c[0] * vpk * vpk + c[1] * vpk + c[2]) * 1000;
}

/** GC composite: average of the arithmetic and harmonic means of the
 *  per-lithology estimates. fracs = {lith: volume fraction}, sum 1. */
export function greenbergCastagnaVs(vp, fracs) {
  const entries = Object.entries(fracs).filter(([, f]) => f > 0);
  const total = Object.values(fracs).reduce((s, f) => s + f, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error('Lithology fractions must sum to 1.');
  }
  if (!Number.isFinite(vp)) return NaN;
  let arith = 0;
  let inv = 0;
  for (const [lith, f] of entries) {
    const vs = gcLithVs(vp, lith);
    if (!(vs > 0)) return NaN; // below the regression's valid range
    arith += f * vs;
    inv += f / vs;
  }
  return 0.5 * (arith + 1 / inv);
}

/** Curve-level shear: measured DTS wins; otherwise GC on a VSH-based
 *  sand/shale split (v1 lithology model). Returns {vs[], source}. */
export function shearForWell({ vpCurve, dtsVsCurve = null, vshCurve = null }) {
  if (dtsVsCurve) return { vs: dtsVsCurve, source: 'measured' };
  const vs = vpCurve.map((vp, i) => {
    if (!Number.isFinite(vp)) return NaN;
    const vsh = vshCurve && Number.isFinite(vshCurve[i])
      ? Math.min(1, Math.max(0, vshCurve[i])) : 0;
    if (vsh === 0) return gcLithVs(vp, 'sandstone');
    if (vsh === 1) return gcLithVs(vp, 'shale');
    return greenbergCastagnaVs(vp, { sandstone: 1 - vsh, shale: vsh });
  });
  return { vs, source: 'estimated' };
}
