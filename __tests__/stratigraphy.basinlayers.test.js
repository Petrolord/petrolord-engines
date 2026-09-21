/**
 * Basin layers from dated tops (ST3): the W1 column of the Wheeler
 * synthetic (test-data/stratigraphy/README.md) with a lithology log.
 */
import fixture from '../test-data/stratigraphy/wheeler-synthetic.json';
import { layersFromDatedTops, dominantLithology, basinLithology, BASIN_LITHOLOGIES } from '../engines/stratigraphy/basinLayers';

const w1 = fixture.wells[0].surfaces;
const lith = [
  { kind: 'lithology', top_md_m: 1500, base_md_m: 1530, code: 'shale' },
  { kind: 'lithology', top_md_m: 1530, base_md_m: 1600, code: 'sandstone' },
  { kind: 'lithology', top_md_m: 1600, base_md_m: 1650, code: 'LS' },
  { kind: 'lithology', top_md_m: 1650, base_md_m: 1680, code: 'dolomite' },
  { kind: 'facies', top_md_m: 1500, base_md_m: 1700, code: 'Channel' },
];

test('lithology mapping and dominance', () => {
  expect(BASIN_LITHOLOGIES).toEqual(['sandstone', 'shale', 'limestone', 'salt', 'coal']);
  expect(basinLithology('SST')).toBe('sandstone');
  expect(basinLithology('dolomite')).toBe('limestone');
  expect(basinLithology('anhydrite')).toBe('salt');
  expect(basinLithology('marble')).toBeNull();
  expect(dominantLithology(lith, 1520, 1600)).toBe('sandstone');    // 10 m shale vs 70 m sandstone
  expect(dominantLithology(lith, 1600, 1680)).toBe('LS');           // 50 m limestone vs 30 m dolomite
  expect(dominantLithology(lith, 1700, 1800)).toBeNull();
});

test('W1 becomes four layers with the surface ages, the hiatus ending deposition, and one erosion event', () => {
  const { layers, erosionEvents, problems } = layersFromDatedTops(w1, { intervals: lith, baseDepth: 1800 });
  expect(layers.map((l) => [l.name, l.thickness, l.ageStart, l.ageEnd, l.agesGuessed])).toEqual([
    ['Seabed', 20, 5, 0, false],
    ['MFS-1', 80, 8, 5, false],
    ['MRS-1', 80, 10, 8, false],
    ['SB-1', 40, 16, 14, false],     // deposition below the unconformity stopped when the hiatus began
    ['Base', 80, 50, 40, true],      // below the last top: placeholders to the given base depth
  ]);
  expect(layers.map((l) => [l.lithology, l.lithologyGuessed])).toEqual([
    ['shale', false], ['sandstone', false], ['limestone', false], ['shale', true], ['shale', true],
  ]);
  expect(erosionEvents).toEqual([{ age: 10, amount: 0, from_ma: 10, to_ma: 14, surface: 'SB-1', amountUnknown: true }]);
  expect(problems.some((p) => /erosion between 10 and 14 Ma/.test(p))).toBe(true);
  expect(problems.some((p) => /placeholder ages/.test(p))).toBe(true);
});

test('undated tops keep the Basin importer placeholders and say so; an inverted pair is named', () => {
  const { layers, problems } = layersFromDatedTops([{ name: 'A', md_m: 100 }, { name: 'B', md_m: 200 }]);
  expect(layers.map((l) => [l.ageStart, l.ageEnd, l.agesGuessed, l.thickness])).toEqual([[10, 0, true, 100], [20, 10, true, 500]]);
  const bad = layersFromDatedTops([{ name: 'A', md_m: 100, age_ma: 10 }, { name: 'B', md_m: 200, age_ma: 5 }]);
  expect(bad.problems[0]).toMatch(/not older to younger/);
  expect(bad.layers[0].agesGuessed).toBe(true);
  expect(layersFromDatedTops([]).layers).toEqual([]);
});
