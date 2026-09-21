/**
 * Stratigraphic map sources (ST4): gross, net-sand and ratio control
 * points between two tops from a lithology log, and the dominant
 * environment per well. Analytic on three wells.
 */
import { thicknessPoints, netThicknessBetween, environmentPoints, SAND_FAMILY, NET_MEASURES } from '../engines/stratigraphy/stratMaps';

const wells = [
  { id: 'a', name: 'A', surface_x: 0, surface_y: 0, tops: [{ name: 'MFS', md_m: 1500 }, { name: 'SB', md_m: 1600 }] },
  { id: 'b', name: 'B', surface_x: 1000, surface_y: 0, tops: [{ name: 'MFS', md_m: 1520 }, { name: 'SB', md_m: 1640 }] },
  { id: 'c', name: 'C', surface_x: 2000, surface_y: 0, tops: [{ name: 'MFS', md_m: 1500 }] },
  { id: 'd', name: 'D', surface_x: null, surface_y: null, tops: [{ name: 'MFS', md_m: 1500 }, { name: 'SB', md_m: 1550 }] },
];
const L = (top, base, code) => ({ kind: 'lithology', top_md_m: top, base_md_m: base, code });
const intervalsByWell = {
  a: [L(1400, 1530, 'shale'), L(1530, 1580, 'SST'), L(1580, 1620, 'siltstone'), { kind: 'facies', top_md_m: 1500, base_md_m: 1600, code: 'sandstone' }],
  b: [L(1500, 1640, 'shale')],
  d: [L(1500, 1550, 'SST')],
};

test('netThicknessBetween sums the sand family inside the window, resolving abbreviations, ignoring other kinds', () => {
  expect(netThicknessBetween(intervalsByWell.a, 1500, 1600)).toBe(70);          // SST 50 + siltstone 20 (clipped at 1600)
  expect(netThicknessBetween(intervalsByWell.a, 1500, 1600, ['sandstone'])).toBe(50);
  expect(netThicknessBetween(intervalsByWell.b, 1520, 1640)).toBe(0);
  expect(SAND_FAMILY).toEqual(['sandstone', 'siltstone', 'conglomerate']);
  expect(NET_MEASURES).toEqual(['gross', 'net', 'ratio']);
});

test('thicknessPoints: gross, net and ratio; wells without both tops, a location or a lithology log are skipped by reason', () => {
  const gross = thicknessPoints(wells, 'MFS', 'SB', { measure: 'gross' });
  expect(gross.points.map((p) => [p.well, p.z])).toEqual([['A', 100], ['B', 120]]);
  expect(gross.skipped).toEqual([{ well: 'C', reason: 'no_lower' }, { well: 'D', reason: 'no_location' }]);
  const net = thicknessPoints(wells, 'MFS', 'SB', { intervalsByWell, measure: 'net' });
  expect(net.points.map((p) => [p.well, p.z, p.gross_m, p.net_m])).toEqual([['A', 70, 100, 70], ['B', 0, 120, 0]]);
  const ratio = thicknessPoints(wells, 'MFS', 'SB', { intervalsByWell, measure: 'ratio' });
  expect(ratio.points.map((p) => [p.well, p.z])).toEqual([['A', 0.7], ['B', 0]]);
  // a well with the tops but no lithology log cannot give a net thickness
  const noLith = thicknessPoints(wells.slice(0, 2), 'MFS', 'SB', { intervalsByWell: { a: intervalsByWell.a }, measure: 'net' });
  expect(noLith.skipped).toEqual([{ well: 'B', reason: 'no_lithology' }]);
  expect(() => thicknessPoints(wells, 'MFS', 'MFS')).toThrow(/two different surfaces/);
  expect(() => thicknessPoints(wells, 'MFS', 'SB', { measure: 'nett' })).toThrow(/Unknown measure/);
  expect(thicknessPoints([{ id: 'x', name: 'X', surface_x: 0, surface_y: 0, tops: [{ name: 'MFS', md_m: 1600 }, { name: 'SB', md_m: 1500 }] }], 'MFS', 'SB').skipped).toEqual([{ well: 'X', reason: 'inverted' }]);
});

test('environmentPoints posts the dominant environment per well, from environment intervals and core descriptions', () => {
  const env = {
    a: [{ kind: 'environment', top_md_m: 1500, base_md_m: 1560, code: 'shoreface' }, { kind: 'environment', top_md_m: 1560, base_md_m: 1600, code: 'Shelf' }],
    b: [{ kind: 'core_description', top_md_m: 1520, base_md_m: 1640, code: 'shale', properties: { environment: 'basin_floor' } }],
  };
  const r = environmentPoints(wells, 'MFS', 'SB', { intervalsByWell: env });
  expect(r.points.map((p) => [p.well, p.code, p.label, p.thickness_m])).toEqual([['A', 'shoreface', 'Shoreface', 60], ['B', 'basin_floor', 'Basin floor', 120]]);
  expect(r.points[0].colour).toBe('#facc15');
  expect(r.skipped.map((s) => [s.well, s.reason])).toEqual([['C', 'no_lower'], ['D', 'no_location']]);
  expect(environmentPoints(wells.slice(0, 1), 'MFS', 'SB', { intervalsByWell: {} }).skipped).toEqual([{ well: 'A', reason: 'no_environment' }]);
});
