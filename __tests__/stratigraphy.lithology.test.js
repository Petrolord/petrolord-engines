/**
 * Lithology, grain size, environment and interval-kind vocabulary (ST1).
 * Lookup tables, so the tests pin the rows and the tolerant resolution of
 * the abbreviations mud logs actually carry.
 */
import {
  INTERVAL_KINDS, INTERVAL_KIND_CODES, INTERVAL_SOURCES, LITHOLOGIES, LITHOLOGY_CODES, GRAIN_SIZES, GRAIN_SIZE_CODES,
  ENVIRONMENTS, ENVIRONMENT_CODES, lithology, grainSize, environment, intervalKind, isIntervalKind,
  resolveLithology, resolveGrainSize, resolveEnvironment, intervalColour, intervalLegend,
} from '../engines/stratigraphy/lithology';

describe('tables', () => {
  test('interval kinds are the eight the registry stores', () => {
    expect(INTERVAL_KIND_CODES).toEqual(['lithology', 'core_description', 'facies', 'electrofacies', 'environment', 'motif', 'systems_tract', 'biozone_interval']);
    expect(INTERVAL_SOURCES).toEqual(['core', 'cuttings', 'log', 'interpretation', 'import']);
    expect(isIntervalKind('facies')).toBe(true);
    expect(isIntervalKind('zone')).toBe(false);
    expect(intervalKind('motif').name).toBe('Log motif');
    for (const k of INTERVAL_KINDS) expect(typeof k.description).toBe('string');
  });

  test('codes are unique, every lithology and environment has a colour, grain sizes ascend', () => {
    for (const [codes] of [[LITHOLOGY_CODES], [GRAIN_SIZE_CODES], [ENVIRONMENT_CODES]]) expect(new Set(codes).size).toBe(codes.length);
    for (const l of LITHOLOGIES) expect(l.colour).toMatch(/^#[0-9a-f]{6}$/);
    for (const e of ENVIRONMENTS) expect(e.colour).toMatch(/^#[0-9a-f]{6}$/);
    for (let i = 1; i < GRAIN_SIZES.length; i++) expect(GRAIN_SIZES[i].maxMm).toBeGreaterThan(GRAIN_SIZES[i - 1].maxMm);
    expect(GRAIN_SIZES[0].code).toBe('clay');
    expect(GRAIN_SIZES[1].maxMm).toBe(0.0625);   // Wentworth silt/sand boundary
  });

  test('direct lookups', () => {
    expect(lithology('sandstone').colour).toBe('#f4d03f');
    expect(lithology('nope')).toBeNull();
    expect(grainSize('m_sand').maxMm).toBe(0.5);
    expect(environment('shoreface').family).toBe('shallow_marine');
  });
});

describe('tolerant resolution', () => {
  test.each([
    ['SST', 'sandstone'], ['ss', 'sandstone'], ['Sandstone', 'sandstone'], ['SAND', 'sandstone'],
    ['SH', 'shale'], ['claystone', 'shale'], ['Mudstone', 'shale'],
    ['LS', 'limestone'], ['LIMESTONE', 'limestone'], ['DOL', 'dolomite'], ['ANH', 'anhydrite'], ['SALT', 'halite'],
    ['COAL', 'coal'], ['basalt', 'volcanic'], ['GRANITE', 'basement'], ['?', 'unknown'],
    ['SST W/ SH STRINGERS', 'sandstone'],   // the first recognised token wins
    ['sh w/ sst', 'shale'],
  ])('%s resolves to %s', (text, code) => {
    expect(resolveLithology(text).code).toBe(code);
  });

  test('unknown text and blanks resolve to null, never guessed', () => {
    expect(resolveLithology('MARBLE')).toBeNull();
    expect(resolveLithology('')).toBeNull();
    expect(resolveLithology(null)).toBeNull();
  });

  test('grain sizes and environments', () => {
    expect(resolveGrainSize('F').code).toBe('f_sand');
    expect(resolveGrainSize('fine sand').code).toBe('f_sand');
    expect(resolveGrainSize('CLY').code).toBe('clay');
    expect(resolveGrainSize('huge')).toBeNull();
    expect(resolveEnvironment('Fluvial').code).toBe('fluvial');
    expect(resolveEnvironment('submarine fan (turbidite)').code).toBe('submarine_fan');
    expect(resolveEnvironment('mars')).toBeNull();
  });
});

describe('colours and legends', () => {
  test('an interval draws with its own colour, else its lithology or environment colour, else grey', () => {
    expect(intervalColour({ kind: 'lithology', code: 'shale' })).toBe('#8fa08a');
    expect(intervalColour({ kind: 'core_description', code: 'LS' })).toBe('#6fa8dc');
    expect(intervalColour({ kind: 'environment', code: 'deltaic' })).toBe('#65a30d');
    expect(intervalColour({ kind: 'facies', code: 'A', properties: { colour: '#123456' } })).toBe('#123456');
    expect(intervalColour({ kind: 'facies', code: 'A' })).toBe('#cbd5e1');
    expect(intervalColour(null)).toBe('#cbd5e1');
  });

  test('legend lists distinct codes in first-appearance order with labels', () => {
    const rows = [
      { kind: 'lithology', code: 'shale' }, { kind: 'lithology', code: 'sandstone' }, { kind: 'lithology', code: 'shale' },
      { kind: 'lithology', code: 'MARBLE', label: 'Marble' },
    ];
    expect(intervalLegend(rows)).toEqual([
      { code: 'shale', label: 'Shale', colour: '#8fa08a' },
      { code: 'sandstone', label: 'Sandstone', colour: '#f4d03f' },
      { code: 'MARBLE', label: 'Marble', colour: '#cbd5e1' },
    ]);
  });
});
