/**
 * Stratigraphy vocabulary (ST0): the stored Catuneanu codes, the Exxon
 * display map and its fallbacks, marker styles, and the systems tract a
 * pair of surfaces bounds. Analytic: the vocabulary is a lookup table, so
 * the tests pin every row of it in both schemes (Catuneanu 2006; Catuneanu
 * et al. 2009 Table 1 for the Exxon equivalences).
 */
import {
  SCHEMES, DEFAULT_SCHEME, DEFAULT_SURFACE_TYPE, SURFACE_TYPES, SURFACE_CODES, SYSTEMS_TRACTS, TRACT_CODES,
  MOTIFS, MOTIF_CODES, STACKING_CODES, surfaceType, systemsTract, isSurfaceCode, isTractCode, normalizeSurfaceType,
  displayLabel, surfaceLineStyle, expectedTract, surfaceOrder, legend, assertScheme,
} from '../engines/stratigraphy/vocabulary';

describe('stored vocabulary', () => {
  test('the surface codes are the Catuneanu set plus the litho default, the unclassified unconformity and the biozone datum', () => {
    expect(SURFACE_CODES).toEqual(['formation_top', 'SU', 'CC', 'BSFR', 'RSME', 'MRS', 'TRS', 'MFS', 'unconformity', 'biozone']);
    expect(DEFAULT_SURFACE_TYPE).toBe('formation_top');
    expect(TRACT_CODES).toEqual(['LST', 'TST', 'HST', 'FSST', 'RST']);
    expect(MOTIF_CODES).toEqual(['blocky', 'bell', 'funnel', 'bow', 'serrated']);
    expect(STACKING_CODES).toEqual(['progradational', 'retrogradational', 'aggradational']);
    expect(SCHEMES).toEqual(['catuneanu', 'exxon']);
    expect(DEFAULT_SCHEME).toBe('catuneanu');
  });

  test('codes are unique and every entry carries a description', () => {
    for (const list of [SURFACE_TYPES, SYSTEMS_TRACTS, MOTIFS]) {
      const codes = list.map((e) => e.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const e of list) expect(typeof e.description).toBe('string');
    }
    expect(Object.isFrozen(SURFACE_TYPES)).toBe(true);
  });

  test('lookups and normalization', () => {
    expect(surfaceType('MFS').name).toBe('Maximum flooding surface');
    expect(surfaceType('nope')).toBeNull();
    expect(systemsTract('TST').order).toBe(2);
    expect(isSurfaceCode('SU')).toBe(true);
    expect(isSurfaceCode('SB')).toBe(false);   // Exxon codes are never stored
    expect(isTractCode('FSST')).toBe(true);
    expect(normalizeSurfaceType(null)).toBe('formation_top');
    expect(normalizeSurfaceType('SB')).toBe('formation_top');
    expect(normalizeSurfaceType('CC')).toBe('CC');
  });
});

describe('display option', () => {
  test('Catuneanu is the identity and never a fallback', () => {
    for (const s of SURFACE_TYPES) {
      const d = displayLabel(s.code, 'catuneanu');
      expect(d).toEqual({ label: s.name, scheme: 'catuneanu', fallback: false, code: s.code });
    }
    expect(displayLabel('MFS').label).toBe('Maximum flooding surface');   // default scheme
  });

  test('the Exxon map (Catuneanu et al. 2009 equivalences)', () => {
    expect(displayLabel('SU', 'exxon')).toEqual({ label: 'Sequence boundary (SB)', scheme: 'exxon', fallback: false, code: 'SU' });
    expect(displayLabel('CC', 'exxon').label).toBe('Sequence boundary, correlative conformity');
    expect(displayLabel('BSFR', 'exxon').label).toBe('Sequence boundary (sensu Posamentier and Allen)');
    expect(displayLabel('MRS', 'exxon').label).toBe('Transgressive surface (TS)');
    expect(displayLabel('TRS', 'exxon').label).toBe('Transgressive surface (ravinement)');
    expect(displayLabel('MFS', 'exxon').label).toBe('Maximum flooding surface (MFS)');
    expect(displayLabel('SU', 'exxon', { short: true }).label).toBe('SB');
    expect(displayLabel('MRS', 'exxon', { short: true }).label).toBe('TS');
    expect(displayLabel('MRS', 'catuneanu', { short: true }).label).toBe('MRS');
  });

  test('where Exxon has no term the Catuneanu name comes back flagged as a fallback', () => {
    expect(displayLabel('RSME', 'exxon')).toEqual({ label: 'Regressive surface of marine erosion', scheme: 'catuneanu', fallback: true, code: 'RSME' });
    expect(displayLabel('FSST', 'exxon')).toEqual({ label: 'Falling-stage systems tract', scheme: 'catuneanu', fallback: true, code: 'FSST' });
    expect(displayLabel('RST', 'exxon').fallback).toBe(true);
    expect(displayLabel('LST', 'exxon')).toEqual({ label: 'Lowstand systems tract', scheme: 'exxon', fallback: false, code: 'LST' });
  });

  test('motifs are the same in both schemes and kind disambiguates', () => {
    expect(displayLabel('bell', 'exxon')).toEqual({ label: 'Bell (fining upward)', scheme: 'catuneanu', fallback: false, code: 'bell' });
    expect(displayLabel('MFS', 'exxon', { kind: 'surface' }).scheme).toBe('exxon');
    expect(() => displayLabel('MFS', 'exxon', { kind: 'tract' })).toThrow(/Unknown stratigraphy code/);
  });

  test('unknown codes and schemes are refused, never guessed', () => {
    expect(() => displayLabel('SB')).toThrow(/Unknown stratigraphy code "SB"/);
    expect(() => displayLabel('MFS', 'vail')).toThrow(/Unknown terminology scheme/);
    expect(() => assertScheme('exxon')).not.toThrow();
  });

  test('legend rows carry both names, the scheme label, the fallback flag and the style', () => {
    const ex = legend('exxon');
    const rsme = ex.surfaces.find((r) => r.code === 'RSME');
    expect(rsme.fallback).toBe(true);
    expect(rsme.catuneanu).toBe('Regressive surface of marine erosion');
    expect(rsme.style).toEqual({ dash: [8, 3, 1, 3], width: 1.5 });
    const su = ex.surfaces.find((r) => r.code === 'SU');
    expect(su.label).toBe('Sequence boundary (SB)');
    expect(su.abbrev).toBe('SB');
    expect(ex.tracts.find((r) => r.code === 'FSST').fallback).toBe(true);
    expect(ex.tracts.find((r) => r.code === 'HST').fallback).toBe(false);
    expect(ex.motifs).toHaveLength(5);
    expect(legend().surfaces.every((r) => !r.fallback)).toBe(true);
  });
});

describe('marker styles', () => {
  test('a formation top keeps the historic dashed marker; sequence surfaces differ from it and from each other', () => {
    expect(surfaceLineStyle('formation_top')).toEqual({ dash: [5, 3], width: 1 });
    expect(surfaceLineStyle(null)).toEqual({ dash: [5, 3], width: 1 });
    expect(surfaceLineStyle('SU')).toEqual({ dash: [], width: 2.5 });
    const keys = SURFACE_TYPES.map((s) => JSON.stringify(surfaceLineStyle(s.code)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the returned dash is a copy, not the table row', () => {
    const a = surfaceLineStyle('MFS');
    a.dash.push(99);
    expect(surfaceLineStyle('MFS').dash).toEqual([8, 3, 2, 3]);
  });
});

describe('expected systems tract between two surfaces (depositional sequence, CC sensu Hunt and Tucker)', () => {
  test('the four tracts of one sequence, base to top', () => {
    expect(expectedTract('SU', 'MRS')).toEqual({ code: 'LST', certain: true });
    expect(expectedTract('CC', 'MRS')).toEqual({ code: 'LST', certain: true });
    expect(expectedTract('MRS', 'MFS')).toEqual({ code: 'TST', certain: true });
    expect(expectedTract('TRS', 'MFS')).toEqual({ code: 'TST', certain: true });
    expect(expectedTract('MFS', 'BSFR')).toEqual({ code: 'HST', certain: true });
    expect(expectedTract('BSFR', 'CC')).toEqual({ code: 'FSST', certain: true });
    expect(expectedTract('BSFR', 'SU')).toEqual({ code: 'FSST', certain: true });
  });

  test('the transgressive-regressive model', () => {
    expect(expectedTract('MFS', 'MRS')).toEqual({ code: 'RST', certain: true });
  });

  test('an unpicked internal boundary is reported as uncertain, not invented', () => {
    expect(expectedTract('MFS', 'SU')).toEqual({ code: 'HST', certain: false });
    expect(expectedTract('MFS', 'CC')).toEqual({ code: 'HST', certain: false });
  });

  test('pairs that bound no single tract return null', () => {
    expect(expectedTract('MRS', 'SU')).toBeNull();          // wrong order
    expect(expectedTract('formation_top', 'MFS')).toBeNull();
    expect(expectedTract('SU', 'MFS')).toBeNull();          // spans LST and TST
    expect(expectedTract('unconformity', 'MRS')).toBeNull();
    expect(expectedTract('SB', 'MFS')).toBeNull();
  });

  test('sequence order puts the base surfaces first and positionless surfaces last', () => {
    const codes = ['MFS', 'formation_top', 'SU', 'MRS', 'BSFR'];
    codes.sort((a, b) => surfaceOrder(a) - surfaceOrder(b));
    expect(codes).toEqual(['SU', 'MRS', 'MFS', 'BSFR', 'formation_top']);
  });
});
