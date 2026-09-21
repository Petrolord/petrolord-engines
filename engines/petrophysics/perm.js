// Permeability + BVW (Petrophysics Studio PS6). Shared engine
// conventions (see vsh.js): pure scalars, float64, NaN on invalid
// input, no I/O.
//
// UNITS EXCEPTION (documented like the degF-inside-Arps precedent):
// k returns in MILLIDARCY with phi and Swirr as fractions — the
// correlations are defined and used in mD, and m^2 would be
// user-hostile. Constants are pinned to ONE cited form each, because
// every published "Timur" differs by unit convention; the UI shows
// the formula next to the method:
//
//   Timur (1968, SPWLA 9th): k = 0.136*phi%^4.4/Swi%^2, which in
//     fractions is k = 8581*phi^4.4/Swirr^2
//   Tixier (1949): k^0.5 = 250*phi^3/Swirr  ->  k = 62500*phi^6/Swirr^2
//   Coates & Denoo (1981): k^0.5 = c*phi^2*(1-Swirr)/Swirr, c = 100
//   Wyllie & Rose (1950) generalized k^0.5 = c*phi^q/Swirr with the
//     Morris & Biggs (1967) presets c = 250 (oil), 79 (gas), q = 3

export function kTimur(phi, swirr) {
  if (!(phi > 0) || !(swirr > 0)) return NaN;
  return (8581 * phi ** 4.4) / swirr ** 2;
}

export function kTixier(phi, swirr) {
  if (!(phi > 0) || !(swirr > 0)) return NaN;
  return ((250 * phi ** 3) / swirr) ** 2;
}

export function kCoates(phi, swirr, c = 100) {
  if (!(phi > 0) || !(swirr > 0) || swirr > 1) return NaN;
  return ((c * phi ** 2 * (1 - swirr)) / swirr) ** 2;
}

export function kWyllieRose(phi, swirr, c, q) {
  if (!(phi > 0) || !(swirr > 0)) return NaN;
  return ((c * phi ** q) / swirr) ** 2;
}

/** Morris & Biggs (1967) presets for the Wyllie-Rose form. */
export const MORRIS_BIGGS = { oil: { c: 250, q: 3 }, gas: { c: 79, q: 3 } };

/** Bulk volume water phi*Sw (Buckles 1965 diagnostic). */
export function bvw(phi, sw) {
  if (!Number.isFinite(phi) || !Number.isFinite(sw)) return NaN;
  return phi * sw;
}

/** Swirr from the constant-BVW rule, CLAMPED to 1 (over-unity Swirr
 *  means the rock is at or past irreducible everywhere; the perm
 *  correlations need a physical saturation). */
export function swirrFromBuckles(phi, bucklesConst) {
  if (!(phi > 0)) return NaN;
  return Math.min(1, bucklesConst / phi);
}

/**
 * Thickness-weighted geometric mean of k over flagged pay samples —
 * the standard zone-average for permeability (arithmetic means are
 * meaningless across orders of magnitude). NaN when no valid pay
 * sample carries a positive k.
 */
export function kGeomMean(ks, flags, thickness) {
  let s = 0;
  let w = 0;
  for (let i = 0; i < ks.length; i++) {
    if (!flags[i] || !(ks[i] > 0)) continue;
    s += Math.log(ks[i]) * thickness[i];
    w += thickness[i];
  }
  return w > 0 ? Math.exp(s / w) : NaN;
}
