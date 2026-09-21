/**
 * FS1 gates — component library integrity.
 *
 * GATE A: every constant in components.js exactly matches the committed,
 * source-cited reference table (componentReference.json). Guards accidental
 * edits; the table carries the citations.
 * Sanity gate: Tc values agree with NIST WebBook Kelvin values within 0.5 K,
 * an independent check that the psia/degR table was not mistranscribed.
 * Structural gates: BIP matrix symmetry, zero diagonal, full population.
 */

import { COMPONENTS, COMPONENT_ORDER, PLUS_FRACTION_KEY, getBip, buildBipMatrix } from '../engines/fluid/components.js';
import { RtoK } from '../engines/fluid/units.js';
import reference from '../test-data/fluid/componentReference.json';

const PROPS = ['mw', 'tcR', 'pcPsia', 'omega', 'vcFt3PerLbmol', 'parachor', 'shift'];

describe('FS1 GATE A: component constants match the cited reference table', () => {
  test('same component set', () => {
    expect(Object.keys(COMPONENTS).sort()).toEqual(Object.keys(reference.components).sort());
  });

  test.each(Object.keys(reference.components))('%s constants exact', (key) => {
    for (const prop of PROPS) {
      expect(COMPONENTS[key][prop]).toBe(reference.components[key][prop]);
    }
  });
});

describe('FS1 sanity gate: Tc vs NIST WebBook (independent transcription check)', () => {
  test.each(Object.entries(reference.sanityBandsK).filter(([k]) => k !== '_note'))(
    '%s Tc within 0.5 K of NIST',
    (key, nistK) => {
      expect(Math.abs(RtoK(COMPONENTS[key].tcR) - nistK)).toBeLessThan(0.5);
    },
  );
});

describe('FS1 structural gates: library shape', () => {
  test('COMPONENT_ORDER covers every component exactly once', () => {
    expect([...COMPONENT_ORDER].sort()).toEqual(Object.keys(COMPONENTS).sort());
  });

  test('plus-fraction key is reserved, not in the pure library', () => {
    expect(COMPONENTS[PLUS_FRACTION_KEY]).toBeUndefined();
    expect(COMPONENT_ORDER).not.toContain(PLUS_FRACTION_KEY);
  });

  test('every component fully populated with finite values', () => {
    for (const key of COMPONENT_ORDER) {
      for (const prop of PROPS) {
        expect(Number.isFinite(COMPONENTS[key][prop])).toBe(true);
      }
      expect(COMPONENTS[key].tcR).toBeGreaterThan(0);
      expect(COMPONENTS[key].pcPsia).toBeGreaterThan(0);
      expect(COMPONENTS[key].vcFt3PerLbmol).toBeGreaterThan(0);
      expect(COMPONENTS[key].mw).toBeGreaterThan(0);
    }
  });

  test('BIP matrix is symmetric with zero diagonal and no NaN', () => {
    const m = buildBipMatrix(COMPONENT_ORDER);
    const n = COMPONENT_ORDER.length;
    for (let i = 0; i < n; i += 1) {
      expect(m[i][i]).toBe(0);
      for (let j = 0; j < n; j += 1) {
        expect(Number.isFinite(m[i][j])).toBe(true);
        expect(m[i][j]).toBe(m[j][i]);
        expect(Math.abs(m[i][j])).toBeLessThan(0.5);
      }
    }
  });

  test('getBip is order-independent and defaults unknown pairs to 0', () => {
    expect(getBip('CO2', 'C1')).toBe(getBip('C1', 'CO2'));
    expect(getBip('CO2', 'C1')).toBe(0.105);
    expect(getBip('N2', 'H2S')).toBe(0.13);
    expect(getBip('C2', 'C3')).toBe(0);
    expect(getBip('C1', PLUS_FRACTION_KEY)).toBe(0); // FS4 characterization supplies this
  });
});
