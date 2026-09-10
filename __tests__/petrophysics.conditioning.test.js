// PT11c: tie-point stretch and squeeze (depthShiftTiePoints) against the
// COND goldens and the behavioural invariants the plan pins: identity,
// one tie = block shift, exact recovery, constant beyond the outer ties,
// monotonicity refusal, nulls never bridged.

import fs from 'fs';
import path from 'path';
import {
  depthShiftBlock, depthShiftTiePoints, tiePointWarp, shiftCurve,
} from '../engines/petrophysics/conditioning';

const DATA = path.join(__dirname, '..', 'test-data', 'petrophysics');
const typewell = JSON.parse(fs.readFileSync(path.join(DATA, 'typewell.json'), 'utf8'));
const goldens = JSON.parse(fs.readFileSync(path.join(DATA, 'goldens.json'), 'utf8'));
const C = goldens.COND;
const toArr = (a) => Float64Array.from(a, (v) => (v == null ? NaN : v));
const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const expectCurve = (got, want, tol) => {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < got.length; i++) {
    if (want[i] == null) expect(Number.isNaN(got[i])).toBe(true);
    else expect(close(got[i], want[i], tol)).toBe(true);
  }
};
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

const depth = toArr(typewell.curves.DEPT);
const gr = toArr(typewell.curves.GR);

test('gate 1: no ties is the identity, byte for byte (nulls included)', () => {
  expect(sameBytes(depthShiftTiePoints(depth, gr, []), gr)).toBe(true);
  expect(Array.from(shiftCurve(depth, [])).every((v) => v === 0)).toBe(true);
});

test('gate 2: one tie equals the block shift byte for byte', () => {
  const one = depthShiftTiePoints(depth, gr, [[2020, 2018.5]]);
  expect(sameBytes(one, depthShiftBlock(depth, gr, 1.5))).toBe(true);
  expectCurve(one, C.GR_SHIFTED);
});

test('gate 3a: exact recovery of a synthetic known stretch (piecewise-linear curve, any warp)', () => {
  // nodes on the 0.5 m grid so the raw samples are exactly linear between
  // neighbours; the tie-point read is then exactly f(warp(z)) for ANY warp
  const z = Float64Array.from({ length: 81 }, (_, i) => 2000 + 0.5 * i);
  const nodes = [[2000, 10], [2010, 40], [2020, 20], [2030, 90], [2040, 30]];
  const pl = (q) => {
    let k = 0;
    while (k < nodes.length - 2 && q > nodes[k + 1][0]) k++;
    const [z0, v0] = nodes[k];
    const [z1, v1] = nodes[k + 1];
    return v0 + ((q - z0) / (z1 - z0)) * (v1 - v0);
  };
  const raw = Float64Array.from(z, pl);
  const pairs = [[2005, 2006.1], [2015, 2018.7], [2025, 2026.5], [2035, 2033.9]];
  const w = tiePointWarp(pairs);
  const warped = depthShiftTiePoints(z, raw, pairs);
  let checked = 0;
  for (let i = 0; i < z.length; i++) {
    const q = w.warp(z[i]);
    if (q < 2000 || q > 2040) { expect(Number.isNaN(warped[i])).toBe(true); continue; }
    expect(close(warped[i], pl(q), 1e-12)).toBe(true);
    checked++;
  }
  expect(checked).toBeGreaterThan(70);

  // and the inverse ties undo a stretch exactly when every kink of the
  // stretched curve lands on a grid node (slopes 2 and 0.5 here)
  const gridPairs = [[2005, 2005], [2010, 2015], [2020, 2020]];
  const stretched = depthShiftTiePoints(z, raw, gridPairs);
  const back = depthShiftTiePoints(z, stretched, gridPairs.map(([r, t]) => [t, r]));
  let roundTrip = 0;
  for (let i = 0; i < z.length; i++) {
    if (Number.isNaN(back[i]) || Number.isNaN(stretched[i])) continue;
    expect(close(back[i], raw[i], 1e-12)).toBe(true);
    roundTrip++;
  }
  expect(roundTrip).toBeGreaterThan(50);
});

test('gate 3b: a smooth synthetic is recovered within the linear-interpolation bound', () => {
  const step = 0.5;
  const z = Float64Array.from({ length: 201 }, (_, i) => 2000 + step * i);
  const f = (q) => 50 + 20 * Math.sin((q - 2000) / 4);
  const raw = Float64Array.from(z, f);
  const pairs = [[2020, 2021.3], [2050, 2048.2], [2080, 2081.1]];
  const w = tiePointWarp(pairs);
  expect(w.ok).toBe(true);
  const warped = depthShiftTiePoints(z, raw, pairs);
  // bound: h^2/8 * max|f''|, f'' = -20/16 sin -> 1.25
  const bound = (step * step / 8) * 1.25 + 1e-12;
  for (let i = 0; i < z.length; i++) {
    if (Number.isNaN(warped[i])) continue;
    expect(Math.abs(warped[i] - f(w.warp(z[i])))).toBeLessThanOrEqual(bound);
  }
});

test('gate 4: constant beyond the outer ties and equal to the outer pair difference', () => {
  const pairs = [[2020, 2021], [2050, 2052.5], [2070, 2069]];
  const s = shiftCurve(depth, pairs);
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] <= 2020) expect(close(s[i], 2020 - 2021)).toBe(true);
    if (depth[i] >= 2070) expect(close(s[i], 2070 - 2069)).toBe(true);
    if (depth[i] > 2020 && depth[i] < 2050) {
      expect(s[i]).toBeLessThanOrEqual(-1 + 1e-12);
      expect(s[i]).toBeGreaterThanOrEqual(-2.5 - 1e-12);
    }
  }
  // the block sign convention: positive moves the curve deeper
  expect(sameBytes(depthShiftTiePoints(depth, gr, [[2030, 2029]]), depthShiftBlock(depth, gr, 1))).toBe(true);
});

test('gate 5: crossing or duplicate ties are refused with a sentence naming the pairs', () => {
  const crossed = tiePointWarp([[2010, 2012], [2012, 2011]]);
  expect(crossed.ok).toBe(false);
  expect(crossed.error).toMatch(/Ties cross: reference 2010 to 2012/);
  expect(crossed.error).toMatch(/target 2012 to 2011/);
  const dup = tiePointWarp([[2010, 2012], [2010, 2013]]);
  expect(dup.ok).toBe(false);
  expect(dup.error).toMatch(/share the reference depth 2010/);
  expect(tiePointWarp([[2010, NaN]]).ok).toBe(false);
  expect(() => depthShiftTiePoints(depth, gr, [[2010, 2012], [2012, 2011]])).toThrow(/Ties cross/);
  expect(() => shiftCurve(depth, [[2010, 2012], [2012, 2011]])).toThrow(/Ties cross/);
  // order of entry does not matter: sorted by reference depth
  expect(tiePointWarp([[2050, 2052], [2010, 2011]]).pairs[0][0]).toBe(2010);
});

test('gate 6: nulls are never bridged and reads outside the raw extent are NaN', () => {
  const z = Float64Array.from([0, 1, 2, 3, 4, 5]);
  const x = Float64Array.from([10, 20, NaN, 40, 50, 60]);
  const out = depthShiftTiePoints(z, x, [[1, 1.5], [4, 4.5]]); // 0.5 stretch across the gap
  // reads at 1.5, 2.5, 3.5 straddle the NaN at index 2 -> NaN; 4.5 -> 55
  expect(Number.isNaN(out[1])).toBe(true);
  expect(Number.isNaN(out[2])).toBe(true);
  expect(close(out[3], 45)).toBe(true);
  expect(close(out[4], 55)).toBe(true);
  expect(Number.isNaN(out[5])).toBe(true); // 5.5 is outside the extent
  // an exact-sample read is that sample even beside a null
  const exact = depthShiftTiePoints(z, x, [[2, 1]]); // block shift by one sample
  expect(close(exact[2], 20)).toBe(true);
  expect(Number.isNaN(exact[3])).toBe(true);
});

test('gate 7: the COND tie golden at 1e-12', () => {
  expectCurve(depthShiftTiePoints(depth, gr, C.tiePairs), C.GR_TIE_SHIFTED);
  expectCurve(shiftCurve(depth, C.tiePairs), C.SHIFT_CURVE);
});
