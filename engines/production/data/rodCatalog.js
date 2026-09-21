/**
 * Sucker-rod reference data (Production P6).
 *
 * What is here and what is deliberately not:
 *
 *  - ROD_SIZES are the API sucker rod sizes. The DIAMETER is the size:
 *    the cross-sectional area is computed from it here rather than
 *    tabled, because a tabled area is a number that can be wrong while
 *    looking right. The weight per foot IS a published API figure
 *    (steel plus the couplings and upsets, which is why it is about 9
 *    percent above the bare-rod weight); `COUPLING_ALLOWANCE` states
 *    that relationship so a transcription slip in the table shows up
 *    as a gate failure rather than as a slightly heavy rod string.
 *  - ROD_GRADES carry the API RP 11B minimum tensile strengths. They
 *    are material minimums, not a vendor's product data. The service
 *    factor that multiplies the allowable stress is NOT here: it
 *    belongs to the fluid, the corrosion and the operator's own
 *    practice, so it is an input, the way cable ampacity and separator
 *    efficiency are inputs elsewhere in this domain.
 *  - PLUNGER_SIZES are the standard API pump bores.
 *  - There are NO named pumping units with dimensions behind them.
 *    Real beam geometry (A, C, P, K and the crank radius) is
 *    manufacturer data and differs between makers for the same API
 *    designation, so inventing a dimension set under a real
 *    designation would be exactly the failure the ESP catalog refuses.
 *    `pumpingUnit.genericConventionalGeometry` builds a self-consistent
 *    GENERIC four-bar that achieves a requested stroke, labelled as
 *    generic everywhere it surfaces; a real design types the
 *    dimensions off the unit's data sheet.
 *
 * Field units: diameter in, area in2, weight lb/ft, stress psi.
 */

/** Steel: density lb/ft3 and Young's modulus psi for API sucker rods. */
export const STEEL_DENSITY_LB_FT3 = 490;
export const STEEL_SG = 7.85;
export const ROD_ELASTIC_MODULUS_PSI = 30.5e6;

/**
 * Published rod weight over bare-rod weight. Couplings and upsets are
 * steel too, and they run a consistent fraction above the plain-body
 * weight across every API size; the gates check the table against this.
 */
export const COUPLING_ALLOWANCE = 1.087;

/** Area of a round rod, in2, from its diameter. Never tabled. */
export const rodArea = (dIn) => (Math.PI * dIn * dIn) / 4;

/** Bare steel weight of a round rod, lb/ft, from its diameter. */
export const bareRodWeightLbPerFt = (dIn) =>
  (rodArea(dIn) / 144) * STEEL_DENSITY_LB_FT3;

export const ROD_SIZES = [
  { label: '1/2', dIn: 0.500, weightLbPerFt: 0.726 },
  { label: '5/8', dIn: 0.625, weightLbPerFt: 1.135 },
  { label: '3/4', dIn: 0.750, weightLbPerFt: 1.634 },
  { label: '7/8', dIn: 0.875, weightLbPerFt: 2.224 },
  { label: '1', dIn: 1.000, weightLbPerFt: 2.904 },
  { label: '1 1/8', dIn: 1.125, weightLbPerFt: 3.676 },
];

/**
 * Rod size by label.
 *
 * The label is a fraction, and it has to be read as one. The
 * predecessor Artificial Lift Designer did
 * `parseFloat("7/8".replace('/', '.'))`, which is 7.8, so a 7/8 inch
 * rod was given a 47 square inch cross-section instead of 0.6, and the
 * string it computed could not stretch. `parseRodSize` below is the fix
 * and is gated on exactly that input.
 */
export const rodSize = (label) =>
  ROD_SIZES.find((r) => r.label === String(label).trim()) || null;

/**
 * Read a rod size as a diameter in inches.
 *
 * Accepts a catalog label ('7/8'), a mixed number ('1 1/8'), a bare
 * fraction ('11/16') or a decimal ('0.875'). Anything else is NaN
 * rather than a plausible-looking number.
 */
export const parseRodSize = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  const known = rodSize(text);
  if (known) return known.dIn;
  // mixed number: "1 1/8"
  const mixed = text.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const den = Number(mixed[3]);
    return den > 0 ? Number(mixed[1]) + Number(mixed[2]) / den : NaN;
  }
  // bare fraction: "7/8"
  const frac = text.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    return den > 0 ? Number(frac[1]) / den : NaN;
  }
  const dec = Number(text);
  return Number.isFinite(dec) ? dec : NaN;
};

/**
 * Weight per foot for a diameter, from the table when it is an API
 * size and from the bare-rod weight plus the coupling allowance when it
 * is not. The second route is stated rather than silent: a non-API
 * diameter has no published weight to look up.
 */
export const rodWeightLbPerFt = (dIn, label) => {
  const known = label != null ? rodSize(label) : ROD_SIZES.find((r) => Math.abs(r.dIn - dIn) < 1e-9);
  if (known) return { weightLbPerFt: known.weightLbPerFt, source: 'api' };
  return {
    weightLbPerFt: bareRodWeightLbPerFt(dIn) * COUPLING_ALLOWANCE,
    source: 'estimated',
  };
};

/**
 * API RP 11B rod grades: minimum tensile strength. The allowable
 * stress is NOT a property of the grade alone — it comes out of the
 * modified Goodman relation with the operator's service factor, which
 * is why no allowable appears here.
 */
export const ROD_GRADES = [
  { id: 'K', label: 'API Grade K', minTensilePsi: 85000 },
  { id: 'C', label: 'API Grade C', minTensilePsi: 90000 },
  { id: 'D', label: 'API Grade D', minTensilePsi: 115000 },
];

export const rodGrade = (id) =>
  ROD_GRADES.find((g) => g.id === String(id).trim().toUpperCase()) || ROD_GRADES[2];

/** Standard API subsurface pump bores, inches. */
export const PLUNGER_SIZES = [
  1.0625, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75,
];

/**
 * Effective acoustic velocity of a steel rod string, ft/s.
 *
 * The bare-steel value from sqrt(E/rho) is about 16,850 ft/s. The
 * value the industry uses for rod strings is lower, because the
 * couplings and the fluid the string runs in slow the wave down, and it
 * is the value the familiar natural-frequency constant is built on:
 *   N0 [spm] = 60 * a / (4 L) = 245,000 / L  for a = 16,333 ft/s.
 * Both are offered, the conventional one is the default, and
 * `rodString.naturalFrequency` reports which was used.
 */
export const ROD_ACOUSTIC_VELOCITY_FT_S = 16333;

/** Bare-steel wave speed from the material constants, ft/s. */
export const steelAcousticVelocityFtS = () => {
  const G_FT_S2 = 32.174;
  const ePsf = ROD_ELASTIC_MODULUS_PSI * 144; // lbf/ft2
  const rhoSlugFt3 = STEEL_DENSITY_LB_FT3 / G_FT_S2;
  return Math.sqrt(ePsf / rhoSlugFt3);
};
