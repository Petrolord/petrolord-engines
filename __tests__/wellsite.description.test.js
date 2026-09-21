/** WS1: the description vocabulary, validation, describe-by-exception, and abbreviation profiles against the hand-derived golden. */
import g from '../test-data/wellsite/description-goldens.json';
import {
  ATTRIBUTES, QUICK_KEYS, TABLES, resolveTerm, resolveColour, optionsFor, emptyComponent, validateDescription,
  copyPrevious, diffDescriptions, dominantLithology, toIntervalRow,
} from '../engines/wellsite/descriptionVocabulary';
import { PETROLORD_PROFILE, validateProfile, mergeProfile, term, abbreviate, narrative } from '../engines/wellsite/abbreviations';

describe('vocabulary', () => {
  test('every table term has a code, name and abbreviation; codes are unique per table', () => {
    for (const [name, list] of Object.entries(TABLES)) {
      const codes = new Set();
      for (const t of list) {
        expect(typeof t.code).toBe('string');
        expect(typeof t.name).toBe('string');
        expect(codes.has(t.code)).toBe(false);
        codes.add(t.code);
      }
      expect(optionsFor(name).length).toBe(list.length);
    }
    expect(ATTRIBUTES[0].key).toBe('lithology');
    expect(QUICK_KEYS).toEqual(['lithology', 'percent', 'colour', 'grainSize', 'porosity']);
  });
  test('typed text resolves through aliases, abbreviations and unique prefixes', () => {
    expect(resolveTerm('lithology', 'sst').code).toBe('sandstone');
    expect(resolveTerm('lithology', 'SH').code).toBe('shale');
    expect(resolveTerm('grainSize', 'f').code).toBe('f_sand');
    expect(resolveTerm('grainSize', 'vc').code).toBe('vc_sand');
    expect(resolveTerm('sorting', 'mod srt').code).toBe('moderate');
    expect(resolveTerm('sorting', 'moderately').code).toBe('moderate');
    expect(resolveTerm('rounding', 'sbang').code).toBe('subangular');
    expect(resolveTerm('hardness', 'frm').code).toBe('firm');
    expect(resolveTerm('porosity', 'fr').code).toBe('fair');
    expect(resolveTerm('accessories', 'py').code).toBe('pyrite');
    expect(resolveTerm('texture', 'fis').code).toBe('fissile');
    expect(resolveTerm('texture', 'zzz')).toBeNull();
    expect(resolveTerm('hardness', 's').code).toBe('soft');
    expect(resolveColour('lt gy')).toEqual({ hue: 'grey', modifier: 'light' });
    expect(resolveColour('dark grey')).toEqual({ hue: 'grey', modifier: 'dark' });
    expect(resolveColour('gy')).toEqual({ hue: 'grey', modifier: null });
    expect(resolveColour('bluish grey')).toEqual({ hue: 'blue_grey', modifier: null });
    expect(resolveColour('lt bl gy')).toEqual({ hue: 'blue_grey', modifier: 'light' });
    expect(resolveColour('mauve')).toBeNull();
  });
});

describe('validation and describe by exception', () => {
  test('the golden description validates; 90 percent is refused with the exact message; 97 passes with a warning', () => {
    expect(validateDescription(g.sample)).toMatchObject({ ok: true, errors: [], percentSum: 100 });
    const ninety = { components: [{ ...g.sample.components[0] }, { ...g.sample.components[1], percent: 30 }] };
    expect(validateDescription(ninety).errors).toEqual(['Component percentages sum to 90, expected 100 within 5.']);
    const ninetySeven = { components: [{ ...g.sample.components[0] }, { ...g.sample.components[1], percent: 37 }] };
    const r = validateDescription(ninetySeven);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['Component percentages sum to 97.']);
    expect(validateDescription({ components: [] }).errors[0]).toBe('A description needs at least one component.');
    const bad = { components: [{ ...emptyComponent(), lithology: 'granite', percent: 100, cement: ['glue'], accessories: [{ code: 'pyrite', amount: 'lots' }] }] };
    const e = validateDescription(bad).errors;
    expect(e).toContain('Component 1 needs a lithology from the vocabulary.');
    expect(e).toContain('Component 1 cement entry glue is not in the vocabulary.');
    expect(e).toContain('Component 1 accessories amount lots is not in the vocabulary.');
  });
  test('copy previous keeps the components and the diff names only what changed', () => {
    const prev = { id: 'd1', mode: 'quick', ...g.sample };
    const next = copyPrevious(prev, { sampleId: 's2', mdTopM: 3050, mdBaseM: 3053 });
    expect(next.copiedFrom).toBe('d1');
    expect(next.components).toEqual(g.sample.components);
    expect(next.components[0]).not.toBe(g.sample.components[0]);
    next.components[0].percent = 90;
    next.components[1].percent = 10;
    next.components[1].hardness = 'soft';
    expect(diffDescriptions(prev, next)).toEqual([
      { componentIndex: 0, field: 'percent', from: 60, to: 90 },
      { componentIndex: 1, field: 'percent', from: 40, to: 10 },
      { componentIndex: 1, field: 'hardness', from: 'firm', to: 'soft' },
    ]);
    expect(dominantLithology(next)).toBe('sandstone');
    const row = toIntervalRow({ ...next, id: 'd2' }, { abbrev: 'x' });
    expect(row).toMatchObject({ kind: 'lithology', code: 'sandstone', label: 'Sandstone', source: 'cuttings', top_md_m: 3050, base_md_m: 3053 });
    expect(row.properties.components).toEqual([{ lithology: 'sandstone', percent: 90 }, { lithology: 'shale', percent: 10 }]);
    expect(row.properties.grain_size).toBe('f_sand');
    expect(row.properties.ws_pipeline).toBe('ws-1.0.0');
  });
});

describe('abbreviation profiles', () => {
  test('the Petrolord default renders the golden abbreviation and narrative', () => {
    const a = abbreviate(g.sample);
    expect(a.text).toBe(g.expected.petrolord);
    expect(a.fallbacks).toEqual([]);
    expect(narrative(g.sample).text).toBe(g.expected.narrative);
  });
  test('an operator profile overrides terms and format; undefined terms fall back and are reported', () => {
    expect(validateProfile(g.operatorProfile)).toEqual([]);
    const p = mergeProfile(g.operatorProfile);
    expect(term(p, 'colourHue', 'grey')).toEqual({ label: 'gry', fallback: false, code: 'grey' });
    expect(term(p, 'colourHue', 'brown')).toEqual({ label: 'brn', fallback: true, code: 'brown' });
    expect(term(PETROLORD_PROFILE, 'colourHue', 'brown').fallback).toBe(false);
    const a = abbreviate(g.sample, p);
    expect(a.text).toBe(g.expected.operator);
    expect(a.fallbacks).toEqual(g.expected.operatorFallbacks);
  });
  test('a profile with unknown codes, unknown tables, or dashes is refused', () => {
    expect(validateProfile({ id: 'x', terms: { colourHue: { mauve: 'mv' } } })).toEqual(['Profile table colourHue names an unknown code mauve.']);
    expect(validateProfile({ id: 'x', terms: { smell: {} } })).toEqual(['Profile names an unknown table smell.']);
    expect(validateProfile({ id: 'x', terms: { sorting: { moderate: 'mod–srt' } } })[0]).toMatch(/dash character/);
    expect(validateProfile({ terms: {} })).toEqual(['A profile needs an id.']);
    expect(validateProfile({ id: 'x', order: ['smell'] })).toEqual(['Profile order names an unknown attribute smell.']);
  });
  test('a draft component without a lithology renders nothing and never throws', () => {
    const d = { components: [emptyComponent(), { ...emptyComponent(), lithology: 'shale', percent: 100, colour: { hue: 'grey', modifier: null } }, emptyComponent()] };
    expect(abbreviate(d).text).toBe('100% SH: gy');
    expect(narrative(d).text).toBe('Shale (100 percent), grey.');
    expect(abbreviate({ components: [emptyComponent()] }).text).toBe('');
    expect(term(PETROLORD_PROFILE, 'lithology', null)).toEqual({ label: '', fallback: false, code: null });
  });
  test('a comment rides at the end of both renderings', () => {
    const d = { components: [{ ...emptyComponent(), lithology: 'coal', percent: 100 }], comment: 'stringers throughout' };
    expect(abbreviate(d).text).toBe('100% COAL; stringers throughout');
    expect(narrative(d).text).toBe('Coal (100 percent). stringers throughout.');
  });
});
