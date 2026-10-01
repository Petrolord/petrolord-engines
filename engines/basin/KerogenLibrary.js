
/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => (typeof key === 'string' || typeof key === 'number') && Object.prototype.hasOwnProperty.call(table, key);

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

/**
 * U2-013: Pepper and Corvi (1995, Marine and Petroleum Geology 12(3),
 * 291-319, Table 3): oil generation from the five kerogen organofacies,
 * a single frequency factor A (1/s) and a Gaussian distribution of
 * activation energy (mean and standard deviation, kJ/mol).
 *  A    marine, siliceous or carbonate (Type II/IIS)
 *  B    marine, siliciclastic (Type II)
 *  C    non-marine lacustrine (Type I)
 *  D/E  non-marine, waxy, coastal plain (Type II/III)
 *  F    non-marine, terrigenous, lignin-rich (Type III)
 * Their abstract: at 2 C/Ma the oil window (10 to 90 % of the oil-generative
 * kerogen degraded) runs from about 95-135 C (A) to 145-175 C (F); the
 * engines suite checks that against this table through the engine.
 */
export const PepperCorvi1995 = Object.freeze({
  A: { aFactor: 2.13e13, eMeanKJ: 206.4, sigmaKJ: 8.2, label: 'Organofacies A (marine, carbonate or siliceous)' },
  B: { aFactor: 8.14e13, eMeanKJ: 215.2, sigmaKJ: 8.3, label: 'Organofacies B (marine, siliciclastic)' },
  C: { aFactor: 2.44e14, eMeanKJ: 221.4, sigmaKJ: 3.9, label: 'Organofacies C (lacustrine)' },
  DE: { aFactor: 4.97e14, eMeanKJ: 228.2, sigmaKJ: 7.9, label: 'Organofacies D/E (waxy coastal plain)' },
  F: { aFactor: 1.23e17, eMeanKJ: 259.1, sigmaKJ: 6.6, label: 'Organofacies F (terrigenous, lignin-rich)' },
});

const KJ_PER_KCAL = 4.184;

const erf = (x) => {
  // Abramowitz and Stegun 7.1.26 is too coarse for bin weights; use the
  // series / continued fraction split (|err| < 1e-14).
  const t = Math.abs(x);
  if (t < 2.5) {
    let sum = t; let term = t; const t2 = t * t;
    for (let n = 1; n < 200; n++) { term *= -t2 / n; const add = term / (2 * n + 1); sum += add; if (Math.abs(add) < 1e-17) break; }
    const v = (2 / Math.sqrt(Math.PI)) * sum;
    return x < 0 ? -v : v;
  }
  // erfc continued fraction (Lentz)
  let f = t; let C = t; let D = 0;
  for (let n = 1; n < 300; n++) {
    const an = n / 2;
    D = t + an * D; D = D === 0 ? 1e-300 : 1 / D;
    C = t + an / C; if (C === 0) C = 1e-300;
    const delta = C * D; f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  const erfc = Math.exp(-t * t) / Math.sqrt(Math.PI) / f;
  const v = 1 - erfc;
  return x < 0 ? -v : v;
};
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * A discrete kinetics set from a Gaussian activation-energy distribution:
 * bins of `stepKJ` across mean +/- 5 sigma, each bin's weight the normal
 * probability between its edges, normalised to 1. Energies in kcal/mol for
 * the engine (E kJ / 4.184).
 */
export function gaussianKinetics({ aFactor, eMeanKJ, sigmaKJ, stepKJ = null, label = '' }) {
  const s = Number(sigmaKJ); const m = Number(eMeanKJ); const A = Number(aFactor);
  if (!(A > 0) || !(m > 0) || !(s >= 0)) throw new Error('Kinetics need A above 0, a mean energy above 0 and a standard deviation of 0 or more.');
  if (s === 0) return { potentials: [1], energies: [m / KJ_PER_KCAL], aFactor: A, description: label || 'Single energy' };
  const step = stepKJ || Math.min(1, s / 4);
  const n = Math.ceil((10 * s) / step);
  const lo = m - (n * step) / 2;
  const potentials = []; const energies = [];
  for (let i = 0; i < n; i++) {
    const a = lo + i * step; const b = a + step;
    potentials.push(normCdf((b - m) / s) - normCdf((a - m) / s));
    energies.push((a + b) / 2 / KJ_PER_KCAL);
  }
  const tot = potentials.reduce((x, y) => x + y, 0);
  return { potentials: potentials.map((p) => p / tot), energies, aFactor: A, description: label };
}

/** The engine kinetics for a Pepper and Corvi organofacies key (A, B, C, DE, F). */
export function organofaciesKinetics(key) {
  const k = String(key || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!Object.prototype.hasOwnProperty.call(PepperCorvi1995, k)) return null;
  return gaussianKinetics(PepperCorvi1995[k]);
}

export const getKerogenParams = (type) => {
    // Clean input string like "Type II" -> "type2"
    if(!type) return KerogenKinetics.default;
    if (typeof type === 'object' && Array.isArray(type.potentials)) return type;
    const pc = /^pc[-_ ]?(a|b|c|de|d\/e|f)$/i.exec(String(type).trim());
    if (pc) return organofaciesKinetics(pc[1]);
    const cleanType = String(type).toLowerCase().replace(/\s+/g, '');
    if (cleanType.includes('typei') && !cleanType.includes('typeii') && !cleanType.includes('typeiii')) return KerogenKinetics.type1;
    if (cleanType.includes('typeii') && !cleanType.includes('typeiii')) return KerogenKinetics.type2;
    if (cleanType.includes('typeiii')) return KerogenKinetics.type3;

    return (ownPreset(KerogenKinetics, cleanType) ? KerogenKinetics[cleanType] : null) || KerogenKinetics.default;
};
