// CRS hints from EBCDIC textual headers: hints prefill, never commit,
// and always carry the line they came from.

import { crsHintsFromText } from '../engines/seismolord/crsHint';

test('explicit EPSG code wins with catalog name resolved', () => {
  const { suggestions } = crsHintsFromText([
    'C 1 CLIENT: PETROLORD  AREA: NIGER DELTA',
    'C 2 COORDINATE SYSTEM EPSG:32631',
  ]);
  expect(suggestions[0]).toMatchObject({
    code: 'EPSG:32631',
    name: 'WGS 84 / UTM zone 31N',
    kind: 'epsg',
    confidence: 0.9,
  });
  expect(suggestions[0].line).toContain('EPSG:32631');
});

test('UTM zone plus datum composes the family code', () => {
  const { suggestions } = crsHintsFromText([
    'C 3 PROJECTION: UTM ZONE 31 N   DATUM: ED-50   SPHEROID: INTERNATIONAL',
  ]);
  expect(suggestions[0]).toMatchObject({ code: 'EPSG:23031', kind: 'utm-datum', confidence: 0.7 });
});

test('Minna and southern-hemisphere composition', () => {
  const minna = crsHintsFromText(['C 4 UTM ZONE 32N DATUM MINNA (CLARKE 1880)']);
  expect(minna.suggestions[0].code).toBe('EPSG:26332');
  const south = crsHintsFromText(['C 4 UTM ZONE 20S DATUM WGS84']);
  expect(south.suggestions[0].code).toBe('EPSG:32720');
});

test('UTM zone alone falls back to WGS 84 at reduced confidence', () => {
  const { suggestions } = crsHintsFromText(['C 5 UTM ZONE 31']);
  expect(suggestions[0]).toMatchObject({ code: 'EPSG:32631', kind: 'utm-only', confidence: 0.5 });
});

test('datum alone is named without a code, and dropped when composed evidence exists', () => {
  const alone = crsHintsFromText(['C 6 DATUM: NAD-27']);
  expect(alone.suggestions[0]).toMatchObject({ code: null, name: 'NAD27', kind: 'datum-only' });
  const both = crsHintsFromText(['C 6 UTM ZONE 15N NAD27']);
  expect(both.suggestions.every((s) => s.code)).toBe(true);
  expect(both.suggestions[0].code).toBe('EPSG:26715');
});

test('unknown EPSG codes still surface, at lower confidence', () => {
  const { suggestions } = crsHintsFromText(['C 7 EPSG 2056 SWISS GRID']);
  expect(suggestions[0]).toMatchObject({ code: 'EPSG:2056', name: null, confidence: 0.6 });
});

test('unit keywords are reported separately', () => {
  const { unitHints } = crsHintsFromText([
    'C 8 COORDINATES IN METERS',
    'C 9 DEPTHS IN FEET',
  ]);
  expect(unitHints.map((u) => u.unit)).toEqual(['m', 'ft']);
});

test('empty and garbage headers yield nothing', () => {
  expect(crsHintsFromText([]).suggestions).toEqual([]);
  expect(crsHintsFromText(['C 1 @@@@####', '']).suggestions).toEqual([]);
});
