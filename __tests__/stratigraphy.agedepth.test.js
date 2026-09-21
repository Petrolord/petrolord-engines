/**
 * Age-depth model (ST2): piecewise-linear between dated surfaces with
 * hiatuses at unconformities. Analytic on the W1 column of the Wheeler
 * synthetic (see test-data/stratigraphy/README.md).
 */
import fixture from '../test-data/stratigraphy/wheeler-synthetic.json';
import { sortDated, validateAgeDepth, ageDepthModel, ageAt, depthAt, accumulationRates } from '../engines/stratigraphy/ageDepth';

const w1 = fixture.wells[0].surfaces;

test('validation: inversions, bad hiatus bounds and duplicates are named; the synthetic is sound', () => {
  expect(validateAgeDepth(w1)).toEqual([]);
  expect(validateAgeDepth([{ name: 'A', md_m: 100, age_ma: 10 }, { name: 'B', md_m: 200, age_ma: 5 }])[0]).toMatchObject({ code: 'inversion', name: 'B' });
  expect(validateAgeDepth([{ name: 'U', md_m: 100, age_ma: 10, hiatus_to_ma: 9 }])[0]).toMatchObject({ code: 'hiatus' });
  expect(validateAgeDepth([{ name: 'A', md_m: 100, age_ma: 1 }, { name: 'B', md_m: 100, age_ma: 2 }])[0]).toMatchObject({ code: 'duplicate' });
  // a hiatus makes the deeper surface older than the surface age, and that is fine
  expect(validateAgeDepth([{ md_m: 100, age_ma: 10, hiatus_to_ma: 14 }, { md_m: 200, age_ma: 16 }])).toEqual([]);
  expect(validateAgeDepth([{ md_m: 100, age_ma: 10, hiatus_to_ma: 14 }, { md_m: 200, age_ma: 12 }])[0].code).toBe('inversion');
});

test('the model of W1: four segments with the hand-derived rates and one hiatus', () => {
  const m = ageDepthModel(w1);
  expect(m.segments.map((s) => [s.age_top_ma, s.age_base_ma])).toEqual([[0, 5], [5, 8], [8, 10], [14, 16]]);
  expect(accumulationRates(m).map((r) => r.rate_m_per_ma)).toEqual(fixture.expected.rates_m_per_ma.w1);
  expect(m.hiatuses).toEqual([{ md_m: 1680, from_ma: 10, to_ma: 14, name: 'SB-1' }]);
  expect(ageDepthModel([{ md_m: 1, age_ma: 1 }])).toBeNull();
  expect(ageDepthModel([{ md_m: 1, age_ma: 5 }, { md_m: 2, age_ma: 1 }])).toBeNull();
});

test('ageAt and depthAt are inverse within segments; a hiatus collapses to its surface', () => {
  const m = ageDepthModel(w1);
  expect(ageAt(m, 1500)).toBe(0);
  expect(ageAt(m, 1510)).toBeCloseTo(2.5, 12);
  expect(ageAt(m, 1560)).toBeCloseTo(6.5, 12);
  expect(ageAt(m, 1680)).toBe(10);          // the surface itself reads the younger side
  expect(ageAt(m, 1700)).toBeCloseTo(15, 12);
  expect(ageAt(m, 1499)).toBeNull();
  expect(ageAt(m, 1721)).toBeNull();
  expect(depthAt(m, 2.5)).toBeCloseTo(1510, 12);
  expect(depthAt(m, 12)).toBe(1680);        // inside the hiatus: nothing deposited
  expect(depthAt(m, 15)).toBeCloseTo(1700, 12);
  expect(depthAt(m, 17)).toBeNull();
  for (const md of [1505, 1550, 1650, 1710]) expect(depthAt(m, ageAt(m, md))).toBeCloseTo(md, 9);
});

test('an event bed (two surfaces of one age) gets a null rate, not a division by zero', () => {
  const m = ageDepthModel([{ md_m: 100, age_ma: 5 }, { md_m: 110, age_ma: 5 }, { md_m: 200, age_ma: 8 }]);
  expect(m.segments[0].rate_m_per_ma).toBeNull();
  expect(depthAt(m, 5)).toBe(100);
});

test('sortDated drops undated points and orders by depth', () => {
  expect(sortDated([{ md_m: 300, age_ma: 3 }, { md_m: 100 }, { md_m: 200, age_ma: 2 }]).map((p) => p.md_m)).toEqual([200, 300]);
});
