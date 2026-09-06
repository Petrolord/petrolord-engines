import { parallelSurface, proportionalSurface, DERIVED_KINDS } from '../engines/earthmodeling/derived.js';
import { NULL_VALUE } from '../lib/gridding/numeric.js';
import { isNull } from '../lib/gridding/gridmath.js';

const top = Float32Array.from([1000, 1010, 1020, NULL_VALUE]);
const base = Float32Array.from([1100, 1110, NULL_VALUE, 1130]);

test('parallelSurface adds a constant or a thickness grid, nulls propagate, type preserved', () => {
  const p = parallelSurface(top, 25);
  expect(p).toBeInstanceOf(Float32Array);
  expect(Array.from(p.slice(0, 3))).toEqual([1025, 1035, 1045]);
  expect(isNull(p[3])).toBe(true);
  const iso = Float32Array.from([5, 10, NULL_VALUE, 20]);
  const q = parallelSurface(top, iso);
  expect(Array.from(q.slice(0, 2))).toEqual([1005, 1020]);
  expect(isNull(q[2])).toBe(true);
  expect(isNull(q[3])).toBe(true);
  expect(parallelSurface(top, -10)[0]).toBe(990);
  expect(() => parallelSurface(top, 'x')).toThrow(/thickness/);
  expect(() => parallelSurface(top, new Float32Array(2))).toThrow(/share the surface frame/);
});

test('proportionalSurface is exact at 0, 1 and midway; nulls on either side propagate', () => {
  expect(Array.from(proportionalSurface(top, base, 0).slice(0, 2))).toEqual([1000, 1010]);
  expect(Array.from(proportionalSurface(top, base, 1).slice(0, 2))).toEqual([1100, 1110]);
  const mid = proportionalSurface(top, base, 0.5);
  expect(Array.from(mid.slice(0, 2))).toEqual([1050, 1060]);
  expect(isNull(mid[2])).toBe(true);
  expect(isNull(mid[3])).toBe(true);
  expect(() => proportionalSurface(top, base, 1.5)).toThrow(/between 0/);
  expect(() => proportionalSurface(top, new Float32Array(2), 0.5)).toThrow(/share a frame/);
  expect(DERIVED_KINDS.map((k) => k.key)).toEqual(['parallel', 'proportional']);
});
