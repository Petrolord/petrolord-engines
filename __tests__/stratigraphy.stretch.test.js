/**
 * Stratigraphic stretch (ST2): two surfaces onto two datum lines, rigid
 * outside, inverse exact; the section-engine displayedDepth accepts the
 * mapping. Analytic.
 */
import { makeStretch, computeStretch, applyShift, invertShift } from '../engines/stratigraphy/stretch';
import { displayedDepth, correlationPolyline, zoneSpan } from '../engines/wellcorrelation/section';

test('makeStretch maps the interval linearly and shifts rigidly outside; inv undoes fwd', () => {
  const s = makeStretch(1500, 1600, 1520, 1720);   // 100 m of rock onto 200 m of frame
  expect(s.scale).toBe(2);
  expect(s.fwd(1500)).toBe(1520);
  expect(s.fwd(1600)).toBe(1720);
  expect(s.fwd(1550)).toBe(1620);
  expect(s.fwd(1400)).toBe(1420);   // above: shift by frameTop - upperMd = +20
  expect(s.fwd(1700)).toBe(1820);   // below: shift by frameBase - lowerMd = +120
  for (const md of [1400, 1500, 1525, 1600, 1700]) expect(s.inv(s.fwd(md))).toBeCloseTo(md, 12);
  expect(() => makeStretch(1600, 1500, 0, 1)).toThrow(/upper above lower/);
});

const wells = [
  { id: 'a', tops: [{ name: 'MFS', md_m: 1520 }, { name: 'SB', md_m: 1680 }] },
  { id: 'b', tops: [{ name: 'MFS', md_m: 1560 }, { name: 'SB', md_m: 1690 }] },
  { id: 'c', tops: [{ name: 'MFS', md_m: 1600 }] },
  { id: 'd', tops: [] },
];

test('computeStretch: both picks stretch onto the mean frame, one pick shifts rigidly, none is flagged', () => {
  const f = computeStretch(wells, { upperName: 'MFS', lowerName: 'SB' });
  expect(f.map((x) => [x.id, x.hasDatumTop, x.partial])).toEqual([['a', true, false], ['b', true, false], ['c', true, true], ['d', false, true]]);
  // frame = mean picks: top 1540, base 1685
  expect(f[0].shift.frameTop).toBe(1540);
  expect(f[0].shift.frameBase).toBe(1685);
  expect(displayedDepth(1520, f[0].shift)).toBe(1540);
  expect(displayedDepth(1680, f[0].shift)).toBe(1685);
  expect(displayedDepth(1560, f[1].shift)).toBe(1540);
  expect(displayedDepth(1690, f[1].shift)).toBe(1685);
  expect(f[2].shift).toBe(1540 - 1600);   // rigid onto the upper line
  expect(f[3].shift).toBeNull();
  // the correlation lines are flat on both surfaces
  expect(correlationPolyline(wells, f, 'MFS').map((p) => p.displayed)).toEqual([1540, 1540, 1540]);
  expect(correlationPolyline(wells, f, 'SB').map((p) => p.displayed)).toEqual([1685, 1685]);
  expect(zoneSpan(wells[1], f[1].shift, 'MFS', 'SB')).toEqual({ top: 1540, base: 1685 });
});

test('an explicit frame is honoured; bad inputs are refused', () => {
  const f = computeStretch(wells.slice(0, 2), { upperName: 'MFS', lowerName: 'SB', frameTop: 1000, frameBase: 1100 });
  expect(displayedDepth(1520, f[0].shift)).toBe(1000);
  expect(displayedDepth(1600, f[0].shift)).toBe(1050);
  expect(() => computeStretch(wells, { upperName: 'MFS', lowerName: 'MFS' })).toThrow(/two different surfaces/);
  expect(() => computeStretch([wells[3]], { upperName: 'MFS', lowerName: 'SB' })).toThrow(/No well carries both/);
});

test('applyShift and invertShift accept numbers, null and mappings', () => {
  const s = makeStretch(0, 10, 0, 20);
  expect(applyShift(5, 3)).toBe(8);
  expect(applyShift(5, null)).toBe(5);
  expect(applyShift(5, s)).toBe(10);
  expect(invertShift(10, s)).toBe(5);
  expect(invertShift(8, 3)).toBe(5);
});
