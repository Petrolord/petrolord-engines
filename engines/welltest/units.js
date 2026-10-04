/**
 * Unit system registry for the Well Test Analysis Studio (WT8).
 *
 * The engines and the persisted project payload are oilfield-units always
 * (the validated state). The unit system is a display-layer concern: input
 * fields convert what the user types into oilfield before it reaches state,
 * and results convert oilfield values into display units at render time.
 *
 * Each kind maps an oilfield quantity to its SI display twin through
 * value_display = fromOil(value_oilfield); toOil inverts it. Factors are
 * exact where the definitions are exact (ft, psi, bbl) and the round trip
 * is identity to machine precision (jest-gated).
 *
 * Permeability stays in md in both systems (universal PTA practice), and
 * viscosity cp = mPa s numerically. Gas pseudo-pressure converts as
 * psi^2/cp -> kPa^2/(mPa s) with the exact psi->kPa factor squared.
 */

const PSI_PER_KPA = 1 / 6.894757293168361;
const FT_PER_M = 1 / 0.3048;
const BBL_PER_M3 = 1 / 0.158987294928;
const MSCF_PER_E3M3 = 35.31466672148859; // Mscf per 10^3 m3

const linear = (oil, si, factorFromOil) => ({
  oil,
  si,
  fromOil: (v) => v * factorFromOil,
  toOil: (v) => v / factorFromOil,
});

const identity = (oil, si = oil) => ({
  oil,
  si,
  fromOil: (v) => v,
  toOil: (v) => v,
});

export const UNIT_KINDS = {
  length: linear('ft', 'm', 1 / FT_PER_M),
  pressure: linear('psi', 'kPa', 1 / PSI_PER_KPA),
  pressureAbs: linear('psia', 'kPa', 1 / PSI_PER_KPA),
  oilRate: linear('STB/D', 'm3/d', 1 / BBL_PER_M3),
  gasRate: linear('Mscf/D', '10³m³/d', 1 / MSCF_PER_E3M3),
  compressibility: linear('1/psi', '1/kPa', PSI_PER_KPA),
  // a volume per pressure: m3 per bbl times psi per kPa (as compressibility)
  storage: linear('bbl/psi', 'm³/kPa', (1 / BBL_PER_M3) * PSI_PER_KPA),
  poreVolume: linear('bbl', 'm³', 1 / BBL_PER_M3),
  area: linear('ft²', 'm²', 0.3048 * 0.3048),
  semilogSlope: linear('psi/cycle', 'kPa/cycle', 1 / PSI_PER_KPA),
  pssSlope: linear('psi/hr', 'kPa/hr', 1 / PSI_PER_KPA),
  sqrtSlope: linear('psi/√hr', 'kPa/√hr', 1 / PSI_PER_KPA),
  pseudoPressure: linear('psi²/cp', 'kPa²/mPa·s', (1 / PSI_PER_KPA) ** 2),
  pseudoSlope: linear('psi²/cp/cycle', 'kPa²/mPa·s/cycle', (1 / PSI_PER_KPA) ** 2),
  temperature: {
    oil: 'degF',
    si: 'degC',
    fromOil: (v) => (v - 32) / 1.8,
    toOil: (v) => v * 1.8 + 32,
  },
  // Tester round 2 (report): period volumes, solution GOR, choke size and
  // API gravity. Exact factors: 1 scf/STB = 0.3048^3 / 0.158987294928 m3/m3;
  // one sixty-fourth of an inch = 25.4/64 mm.
  oilVolume: linear('STB', 'm³', 1 / BBL_PER_M3),
  gasVolume: linear('Mscf', '10³m³', 1 / MSCF_PER_E3M3),
  liquidVolume: linear('bbl', 'm³', 1 / BBL_PER_M3),
  gor: linear('scf/STB', 'm³/m³', (0.3048 ** 3) * BBL_PER_M3),
  choke: linear('1/64 in', 'mm', 25.4 / 64),
  // Well Test U1 (2026-10-04): kh printed md-ft under SI; the RTA
  // productivity index printed the oilfield number under SI labels; the
  // transient-linear xf sqrt(k) had its own inline factor. Each has a kind
  // now, and every kind is pinned to one known value by a test
  // (welltest.unitsKnownValues.test.js), because a round trip cannot see a
  // wrong factor (the storage factor was 47.5 times off until 2026-10-02).
  kh: linear('md·ft', 'md·m', 0.3048),
  productivityIndex: linear('STB/D/psi', 'm³/d/kPa', (1 / BBL_PER_M3) * PSI_PER_KPA),
  gasProductivityIndex: linear('Mscf/D/(psi²/cp)', '10³m³/d/(kPa²/mPa·s)', (1 / MSCF_PER_E3M3) * PSI_PER_KPA * PSI_PER_KPA),
  xfSqrtK: linear('ft·√md', 'm·√md', 0.3048),
  apiGravity: identity('degAPI'),
  fraction: identity('fraction'),
  ratio: identity('ratio'),
  gasGravity: identity('air = 1'),
  permeability: identity('md'),
  viscosity: identity('cp', 'mPa·s'),
  fvf: identity('RB/STB', 'm³/m³'),
  time: identity('hr'),
  dimensionless: identity(''),
};

export const UNIT_SYSTEMS = ['oilfield', 'si'];

const kindOf = (kind) => UNIT_KINDS[kind] || UNIT_KINDS.dimensionless;

/** Unit label for a kind in the active system. */
export const unitLabel = (kind, system) =>
  kindOf(kind)[system === 'si' ? 'si' : 'oil'];

/** Oilfield value -> display value in the active system. */
export const fromOilfield = (kind, value, system) => {
  if (!Number.isFinite(value)) return value;
  return system === 'si' ? kindOf(kind).fromOil(value) : value;
};

/** Display value in the active system -> oilfield value. */
export const toOilfield = (kind, value, system) => {
  if (!Number.isFinite(value)) return value;
  return system === 'si' ? kindOf(kind).toOil(value) : value;
};

/**
 * Convert an oilfield input STRING to its display string, trimming float
 * noise so a converted round trip shows what the user typed.
 */
export const displayInputString = (kind, oilString, system) => {
  if (system !== 'si' || oilString === '' || oilString == null) return oilString ?? '';
  const v = parseFloat(oilString);
  if (!Number.isFinite(v)) return oilString;
  return String(parseFloat(fromOilfield(kind, v, system).toPrecision(10)));
};

/**
 * Convert a display-units input STRING to the oilfield string that goes to
 * state. Non-numeric text passes through so typing stays natural.
 */
export const storeInputString = (kind, displayString, system) => {
  if (system !== 'si' || displayString === '' || displayString == null) return displayString ?? '';
  const v = parseFloat(displayString);
  if (!Number.isFinite(v)) return displayString;
  return String(parseFloat(toOilfield(kind, v, system).toPrecision(12)));
};

/** Map a catalog parameter unit string to a unit kind (Match tab metadata). */
export const kindForCatalogUnit = (unit) => {
  switch (unit) {
    case 'ft': return 'length';
    case 'bbl/psi': return 'storage';
    case 'md': return 'permeability';
    default: return 'dimensionless';
  }
};
