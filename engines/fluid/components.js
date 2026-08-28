/**
 * Pure-component library for the PR78 compositional engine (FS1).
 *
 * Constants follow the standard petroleum-engineering compilation in
 * Whitson & Brulé, "Phase Behavior", SPE Monograph 20 (2000), Appendix A
 * (which itself derives from GPSA Engineering Data Book / API TDB values),
 * cross-checked against NIST WebBook critical constants. Where sources
 * differ at the last digit the Monograph value is used, because the FS
 * literature fixtures (Whitson worked examples) assume it.
 *
 * Units: Tc °R, Pc psia, Vc ft³/lb-mol, MW lb/lb-mol. omega dimensionless.
 * parachor per Weinaug-Katz usage (dyn/cm basis). shift is the dimensionless
 * PR volume-translation parameter s = c/b from Jhaveri & Youngren, SPE 13118
 * (1988), Table 2 (non-hydrocarbons per Monograph 20 Table 4-3).
 *
 * This file is DATA ONLY — no math. The committed reference table in
 * __tests__/componentReference.json must match these values exactly; the
 * jest gate exists so an accidental edit here cannot slip through unnoticed.
 */

export const COMPONENTS = {
  N2: { name: 'Nitrogen', mw: 28.013, tcR: 227.16, pcPsia: 492.84, omega: 0.0403, vcFt3PerLbmol: 1.4417, parachor: 41.0, shift: -0.1927 },
  CO2: { name: 'Carbon dioxide', mw: 44.010, tcR: 547.42, pcPsia: 1069.51, omega: 0.2276, vcFt3PerLbmol: 1.5057, parachor: 78.0, shift: -0.0817 },
  H2S: { name: 'Hydrogen sulfide', mw: 34.082, tcR: 672.12, pcPsia: 1299.97, omega: 0.0827, vcFt3PerLbmol: 1.5698, parachor: 80.1, shift: -0.1288 },
  C1: { name: 'Methane', mw: 16.043, tcR: 343.01, pcPsia: 667.03, omega: 0.0115, vcFt3PerLbmol: 1.5794, parachor: 77.0, shift: -0.1595 },
  C2: { name: 'Ethane', mw: 30.070, tcR: 549.58, pcPsia: 706.62, omega: 0.0995, vcFt3PerLbmol: 2.3707, parachor: 108.0, shift: -0.1134 },
  C3: { name: 'Propane', mw: 44.097, tcR: 665.69, pcPsia: 616.12, omega: 0.1523, vcFt3PerLbmol: 3.2037, parachor: 150.3, shift: -0.0863 },
  iC4: { name: 'Isobutane', mw: 58.123, tcR: 734.13, pcPsia: 527.94, omega: 0.1770, vcFt3PerLbmol: 4.2129, parachor: 181.5, shift: -0.0844 },
  nC4: { name: 'n-Butane', mw: 58.123, tcR: 765.29, pcPsia: 550.60, omega: 0.2002, vcFt3PerLbmol: 4.0817, parachor: 189.9, shift: -0.0675 },
  iC5: { name: 'Isopentane', mw: 72.150, tcR: 828.77, pcPsia: 490.37, omega: 0.2275, vcFt3PerLbmol: 4.9337, parachor: 225.0, shift: -0.0608 },
  nC5: { name: 'n-Pentane', mw: 72.150, tcR: 845.47, pcPsia: 488.79, omega: 0.2515, vcFt3PerLbmol: 4.9817, parachor: 231.5, shift: -0.0390 },
  nC6: { name: 'n-Hexane', mw: 86.177, tcR: 913.27, pcPsia: 436.62, omega: 0.3013, vcFt3PerLbmol: 5.9226, parachor: 271.0, shift: -0.0080 },
};

/** Canonical input/display order (lightest non-HC first, then paraffin series). */
export const COMPONENT_ORDER = ['N2', 'CO2', 'H2S', 'C1', 'C2', 'C3', 'iC4', 'nC4', 'iC5', 'nC5', 'nC6'];

/** Key used for the user-characterized plus fraction (FS4 populates its props). */
export const PLUS_FRACTION_KEY = 'C7+';

/**
 * PR binary interaction parameters. Defaults per Whitson & Brulé Monograph 20
 * Table 4-2 (non-hydrocarbon pairs) with hydrocarbon-hydrocarbon pairs zero
 * (standard PR practice for lean paraffin pairs). The C1-C7+ BIP is NOT here:
 * FS4 computes it from the Whitson correlation during characterization.
 * Stored one-sided; use getBip() for symmetric access.
 */
const BIP_TABLE = {
  N2: { CO2: 0.0, H2S: 0.130, C1: 0.025, C2: 0.010, C3: 0.090, iC4: 0.095, nC4: 0.095, iC5: 0.100, nC5: 0.100, nC6: 0.100 },
  CO2: { H2S: 0.135, C1: 0.105, C2: 0.130, C3: 0.125, iC4: 0.120, nC4: 0.115, iC5: 0.115, nC5: 0.115, nC6: 0.115 },
  H2S: { C1: 0.070, C2: 0.085, C3: 0.080, iC4: 0.075, nC4: 0.075, iC5: 0.070, nC5: 0.070, nC6: 0.055 },
};

/** Symmetric BIP lookup; unknown pairs (incl. HC-HC and self) return 0. */
export function getBip(a, b) {
  if (a === b) return 0;
  const row = BIP_TABLE[a];
  if (row && row[b] !== undefined) return row[b];
  const rev = BIP_TABLE[b];
  if (rev && rev[a] !== undefined) return rev[a];
  return 0;
}

/** Build the full symmetric BIP matrix for an ordered component-key list. */
export function buildBipMatrix(keys) {
  return keys.map((a) => keys.map((b) => getBip(a, b)));
}
