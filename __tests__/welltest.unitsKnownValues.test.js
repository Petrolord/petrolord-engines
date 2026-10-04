/**
 * Every unit kind of the Well Test registry pinned to one known value
 * (Well Test U1, 2026-10-04).
 *
 * A round-trip test cannot see a wrong factor: toOil(fromOil(v)) is v for
 * any factor, which is how the wellbore storage factor stayed 47.5 times
 * wrong under SI until 2026-10-02. Here each kind converts a value whose
 * SI twin is known from the unit definitions, written out as literals and
 * never computed with the module's own constants:
 *   1 ft = 0.3048 m; 1 psi = 6.894757293168 kPa; 1 bbl = 0.158987294928 m3
 *   (42 US gal x 3.785411784 L); 1 scf = 0.028316846592 m3; 1 in = 25.4 mm.
 * A kind added to the registry without a row here fails the coverage test.
 */
import { UNIT_KINDS, fromOilfield, toOilfield, unitLabel } from '../engines/welltest/units.js';

// [kind, oilfield value, SI value, SI label]
const KNOWN = [
  ['length', 1000, 304.8, 'm'],
  ['pressure', 1, 6.894757293168, 'kPa'],
  ['pressureAbs', 14.695948775513, 101.325, 'kPa'],
  ['oilRate', 1000, 158.987294928, 'm3/d'],
  ['gasRate', 1000, 28.316846592, '10³m³/d'],
  ['compressibility', 1e-5, 1.4503773773e-6, '1/kPa'],
  ['storage', 0.01, 2.305915758e-4, 'm³/kPa'],
  ['poreVolume', 1e6, 158987.294928, 'm³'],
  ['area', 43560, 4046.8564224, 'm²'],
  ['semilogSlope', 100, 689.4757293168, 'kPa/cycle'],
  ['pssSlope', 2, 13.789514586336, 'kPa/hr'],
  ['sqrtSlope', 10, 68.94757293168, 'kPa/√hr'],
  ['pseudoPressure', 1e6, 47.537678131698e6, 'kPa²/mPa·s'],
  ['pseudoSlope', 1e5, 47.537678131698e5, 'kPa²/mPa·s/cycle'],
  ['temperature', 212, 100, 'degC'],
  ['oilVolume', 1, 0.158987294928, 'm³'],
  ['gasVolume', 1000, 28.316846592, '10³m³'],
  ['liquidVolume', 6.289810770432, 1, 'm³'],
  ['gor', 1000, 178.10760667904, 'm³/m³'],
  ['choke', 64, 25.4, 'mm'],
  ['kh', 1000, 304.8, 'md·m'],
  ['productivityIndex', 1, 0.023059157584, 'm³/d/kPa'],
  ['gasProductivityIndex', 1, 5.956716378e-4, '10³m³/d/(kPa²/mPa·s)'],
  ['xfSqrtK', 100, 30.48, 'm·√md'],
  // Well Test U2 (2026-10-04): 0.433 psi/ft (fresh water) is 9.7947 kPa/m;
  // D of 1e-4 per Mscf/D is 3.5315e-3 per 10^3 m3/d (1 Mscf = 0.028316846592 x 10^3 m3)
  ['pressureGradient', 0.433, 9.794717545740629, 'kPa/m'],
  ['nonDarcySkin', 1e-4, 3.531466672148859e-3, '1/(10³m³/d)'],
  // identities: the value does not change between systems
  ['apiGravity', 35, 35, 'degAPI'],
  ['fraction', 0.2, 0.2, 'fraction'],
  ['ratio', 0.1, 0.1, 'ratio'],
  ['gasGravity', 0.65, 0.65, 'air = 1'],
  ['permeability', 85, 85, 'md'],
  ['viscosity', 0.9, 0.9, 'mPa·s'],
  ['fvf', 1.25, 1.25, 'm³/m³'],
  ['time', 36, 36, 'hr'],
  ['dimensionless', 6.5, 6.5, ''],
];

describe('Well Test unit registry: one known value per kind', () => {
  test.each(KNOWN)('%s: %p oilfield is %p SI', (kind, oil, si, label) => {
    expect(fromOilfield(kind, oil, 'si') / si).toBeCloseTo(1, 9);
    expect(toOilfield(kind, si, 'si') / oil).toBeCloseTo(1, 9);
    expect(unitLabel(kind, 'si')).toBe(label);
    expect(fromOilfield(kind, oil, 'oilfield')).toBe(oil);
  });

  test('every kind in the registry has a known value here', () => {
    const covered = new Set(KNOWN.map((r) => r[0]));
    expect(Object.keys(UNIT_KINDS).filter((k) => !covered.has(k))).toEqual([]);
  });

  test('negative control: the factor of 2026-10-02 put back fails the storage row', () => {
    const kept = UNIT_KINDS.storage;
    const old = 0.158987294928 * 6.894757293168; // m3 per bbl times kPa per psi: the inverted pressure factor
    UNIT_KINDS.storage = { ...kept, fromOil: (v) => v * old, toOil: (v) => v / old };
    try {
      const [, oil, si] = KNOWN.find((r) => r[0] === 'storage');
      const ratio = fromOilfield('storage', oil, 'si') / si;
      expect(ratio).toBeCloseTo(47.537678, 4); // the 47.5 seen live
      expect(Math.abs(toOilfield('storage', fromOilfield('storage', oil, 'si'), 'si') - oil)).toBeLessThan(1e-15); // the round trip stays blind
    } finally {
      UNIT_KINDS.storage = kept;
    }
  });
});
