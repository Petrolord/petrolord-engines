/**
 * Sequence products (ST2): systems tracts from typed surfaces, stacking
 * from motifs. Analytic.
 */
import { tractsFromSurfaces, stackingFromMotifs, tractsWithStacking } from '../engines/stratigraphy/sequence';

const tops = [
  { name: 'Top', md_m: 1500, surface_type: 'formation_top' },
  { name: 'MFS', md_m: 1520, surface_type: 'MFS' },
  { name: 'MRS', md_m: 1600, surface_type: 'MRS' },
  { name: 'SB', md_m: 1680, surface_type: 'SU' },
  { name: 'Base', md_m: 1720 },
];

test('consecutive typed pairs become tract rows; pairs bounding no tract are skipped', () => {
  const rows = tractsFromSurfaces(tops);
  expect(rows.map((r) => [r.top_md_m, r.base_md_m, r.code])).toEqual([[1520, 1600, 'TST'], [1600, 1680, 'LST']]);
  expect(rows[0]).toMatchObject({ kind: 'systems_tract', label: 'Transgressive systems tract', source: 'interpretation', properties: { upper_surface: 'MFS', lower_surface: 'MRS', upper_type: 'MFS', lower_type: 'MRS', certain: true } });
  expect(tractsFromSurfaces([])).toEqual([]);
  expect(tractsFromSurfaces([{ name: 'A', md_m: 1 }, { name: 'B', md_m: 2 }])).toEqual([]);
});

test('an uncertain tract is recorded as such', () => {
  const rows = tractsFromSurfaces([{ name: 'SB', md_m: 100, surface_type: 'SU' }, { name: 'MFS', md_m: 200, surface_type: 'MFS' }]);
  expect(rows[0]).toMatchObject({ code: 'HST', properties: { certain: false } });
});

test('stacking from motifs inside a tract', () => {
  const tract = { top_md_m: 1520, base_md_m: 1600 };
  const m = (top, base, code) => ({ kind: 'motif', top_md_m: top, base_md_m: base, code });
  expect(stackingFromMotifs(tract, [m(1520, 1550, 'funnel'), m(1550, 1600, 'funnel')])).toBe('progradational');
  expect(stackingFromMotifs(tract, [m(1520, 1560, 'bell')])).toBe('retrogradational');
  expect(stackingFromMotifs(tract, [m(1520, 1600, 'blocky')])).toBe('aggradational');
  expect(stackingFromMotifs(tract, [m(1520, 1560, 'bell'), m(1560, 1600, 'funnel')])).toBeNull();
  expect(stackingFromMotifs(tract, [m(1400, 1500, 'bell')])).toBeNull();   // outside
  expect(stackingFromMotifs(tract, [])).toBeNull();
  const rows = tractsWithStacking(tops, [m(1520, 1600, 'bell')]);
  expect(rows[0].properties.stacking).toBe('retrogradational');
  expect(rows[1].properties.stacking).toBeUndefined();
});
