/**
 * Kinetics library.
 *
 * Two DISTINCT parameter sets live here — conflating them was the G0
 * audit's headline defect:
 *
 * 1. Easy%Ro (Sweeney & Burnham 1990, AAPG Bull. 74/10 p.1559) —
 *    VITRINITE maturation. Kerogen-type independent. A = 1.0e13 1/s,
 *    E = 34..72 kcal/mol step 2, stoichiometric weights below (sum
 *    0.85), %Ro = exp(-1.6 + 3.7*F) with F the unnormalised weighted
 *    reacted fraction — reproducing the published 0.20–4.69 range.
 *    Cross-checked against PyBasin lib/easyRo.py (2026-07-14).
 *
 * 2. Kerogen GENERATION potentials per type (library data, editable in
 *    the app's KineticsEditor) — drive transformation ratio and
 *    hydrocarbon mass generation, never %Ro.
 */

// Shared activation-energy grid (kcal/mol)
export const ActivationEnergies = [34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72];

// Easy%Ro vitrinite parameters
export const EasyRoFrequencyFactor = 1.0e13; // s^-1
export const EasyRoWeights = [0.03, 0.03, 0.04, 0.04, 0.05, 0.05, 0.06, 0.04, 0.04, 0.07, 0.06, 0.06, 0.06, 0.05, 0.05, 0.04, 0.03, 0.02, 0.02, 0.01];

// Generation kinetics frequency factor (per-type override allowed)
export const FrequencyFactor = 1.0e13;

// Stoichiometric factors (initial potentials) for generation kinetics.
// Fraction of the kerogen's HC potential reacting at each energy bin.
export const KerogenKinetics = {
  type1: {
    // Green River Shale type (Oil prone)
    potentials: [0, 0, 0, 0, 0, 0.01, 0.04, 0.09, 0.18, 0.25, 0.22, 0.13, 0.06, 0.02, 0.0, 0, 0, 0, 0, 0],
    aFactor: 1.0e13,
    description: "Type I (Lacustrine)"
  },
  type2: {
    // Standard Marine Shale (Oil/Gas prone)
    potentials: [0, 0, 0, 0, 0, 0, 0.01, 0.05, 0.11, 0.17, 0.22, 0.19, 0.13, 0.07, 0.03, 0.02, 0, 0, 0, 0],
    aFactor: 1.0e13,
    description: "Type II (Marine)"
  },
  type3: {
    // Terrestrial (Gas prone)
    potentials: [0, 0, 0, 0, 0, 0, 0, 0, 0.01, 0.03, 0.06, 0.10, 0.14, 0.17, 0.18, 0.15, 0.10, 0.04, 0.02, 0],
    aFactor: 1.0e13,
    description: "Type III (Terrestrial)"
  },
  default: {
    potentials: [0, 0, 0, 0, 0, 0, 0.01, 0.05, 0.11, 0.17, 0.22, 0.19, 0.13, 0.07, 0.03, 0.02, 0, 0, 0, 0],
    aFactor: 1.0e13,
    description: "Type II (Default)"
  }
};

export const getKerogenParams = (type) => {
    // Clean input string like "Type II" -> "type2"
    if(!type) return KerogenKinetics.default;
    if (typeof type === 'object' && Array.isArray(type.potentials)) return type;
    const cleanType = String(type).toLowerCase().replace(/\s+/g, '');
    if (cleanType.includes('typei') && !cleanType.includes('typeii') && !cleanType.includes('typeiii')) return KerogenKinetics.type1;
    if (cleanType.includes('typeii') && !cleanType.includes('typeiii')) return KerogenKinetics.type2;
    if (cleanType.includes('typeiii')) return KerogenKinetics.type3;

    return KerogenKinetics[cleanType] || KerogenKinetics.default;
};
