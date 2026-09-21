/**
 * Stratigraphy ST5 in the seismic domain: the proportional stratal slice
 * between two horizons (ends reproduce the single-horizon value
 * extraction; the interior is exact on a volume linear in sample) and
 * the per-trace flatten offsets along inline, crossline and traverse
 * sections. Analytic on a synthetic brick store.
 */
import {
  extractStratalSlice, bricksForStratalSlice, bricksForIntervalAttribute, extractHorizonAmplitude,
} from '../engines/seismolord/horizonAmplitude';
import { flattenOffsets, datumForHorizon, sectionCell, shiftedSample } from '../engines/seismolord/flatten';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const B = 4; const NIL = 8; const NXL = 8; const NS = 16;
const geom = { nIl: NIL, nXl: NXL, ns: NS, brickSize: B, nbi: 2, nbj: 2, nbk: 4 };
// amplitude linear in sample, distinct per trace: a parabola through three
// points of a line IS the line, so fractional picks give exact values
const value = (il, xl, k) => il * 100 + xl * 10 + k * 0.5;

function makeStore() {
  const bricks = new Map();
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 4; k++) bricks.set(`${i}-${j}-${k}`, new Float32Array(B * B * B).fill(NULL_VALUE));
  for (let il = 0; il < NIL; il++) for (let xl = 0; xl < NXL; xl++) for (let k = 0; k < NS; k++) {
    bricks.get(`${Math.floor(il / B)}-${Math.floor(xl / B)}-${Math.floor(k / B)}`)[((il % B) * B + (xl % B)) * B + (k % B)] = value(il, xl, k);
  }
  return async (i, j, k) => bricks.get(`${i}-${j}-${k}`);
}

describe('stratal slice', () => {
  const getBrick = makeStore();
  const picksA = new Float32Array(NIL * NXL).fill(3);
  const picksB = new Float32Array(NIL * NXL).fill(11);
  picksB[5] = NULL_VALUE;

  test('fraction 0 and 1 reproduce the single-horizon value extraction; the interior is exact', async () => {
    const onA = await extractHorizonAmplitude(getBrick, geom, picksA, { mode: 'value' });
    const onB = await extractHorizonAmplitude(getBrick, geom, picksB, { mode: 'value' });
    const f0 = await extractStratalSlice(getBrick, geom, picksA, picksB, { fraction: 0 });
    const f1 = await extractStratalSlice(getBrick, geom, picksA, picksB, { fraction: 1 });
    const fh = await extractStratalSlice(getBrick, geom, picksA, picksB, { fraction: 0.25 });
    for (let cell = 0; cell < NIL * NXL; cell++) {
      if (cell === 5) { expect(f0[cell]).toBe(NULL_F32); expect(f1[cell]).toBe(NULL_F32); expect(fh[cell]).toBe(NULL_F32); continue; }
      expect(f0[cell]).toBe(onA[cell]);
      expect(f1[cell]).toBe(onB[cell]);
      const il = Math.floor(cell / NXL); const xl = cell % NXL;
      expect(fh[cell]).toBeCloseTo(Math.fround(value(il, xl, 3 + 0.25 * 8)), 3);   // z = 5 exactly
    }
  });

  test('order-free span, the same bricks as the interval attribute, bad fractions refused', async () => {
    const swapped = await extractStratalSlice(getBrick, geom, picksB, picksA, { fraction: 0.25 });
    const il = 2; const xl = 3; const cell = il * NXL + xl;
    expect(swapped[cell]).toBeCloseTo(Math.fround(value(il, xl, 11 - 0.25 * 8)), 3);   // from B towards A
    expect(bricksForStratalSlice(geom, picksA, picksB)).toEqual(bricksForIntervalAttribute(geom, picksA, picksB));
    await expect(extractStratalSlice(getBrick, geom, picksA, picksB, { fraction: 1.5 })).rejects.toThrow(/between 0 and 1/);
  });
});

describe('flatten offsets', () => {
  const grid = new Float32Array(NIL * NXL);
  for (let il = 0; il < NIL; il++) for (let xl = 0; xl < NXL; xl++) grid[il * NXL + xl] = 4 + il + 0.5 * xl;   // a dipping horizon
  grid[2 * NXL + 6] = NULL_VALUE;   // untracked at inline 2, crossline 6

  test('sectionCell indexes the lattice per orientation', () => {
    expect(sectionCell('inline', 2, 6, geom)).toBe(2 * NXL + 6);
    expect(sectionCell('xline', 6, 2, geom)).toBe(2 * NXL + 6);
    expect(sectionCell('traverse', 0, 1, geom, [{ il: 0, xl: 0 }, { il: 2, xl: 6 }])).toBe(2 * NXL + 6);
    expect(sectionCell('traverse', 0, 5, geom, [])).toBe(-1);
    expect(sectionCell('time', 0, 0, geom)).toBe(-1);
  });

  test('inline 2 hung on datum 8: offsets put every tracked pick on 8, the untracked trace is NaN', () => {
    const { offsets, tracked, nTraces } = flattenOffsets(grid, geom, 'inline', 2, 8);
    expect(nTraces).toBe(NXL);
    expect(tracked).toBe(NXL - 1);
    for (let xl = 0; xl < NXL; xl++) {
      if (xl === 6) { expect(Number.isNaN(offsets[xl])).toBe(true); continue; }
      expect(offsets[xl]).toBeCloseTo(8 - (4 + 2 + 0.5 * xl), 6);
      expect(shiftedSample(grid[2 * NXL + xl], offsets[xl])).toBeCloseTo(8, 6);
    }
    expect(shiftedSample(12, NaN)).toBe(12);
  });

  test('crossline and traverse sections, and the median datum', () => {
    const x = flattenOffsets(grid, geom, 'xline', 6, 10);
    expect(x.nTraces).toBe(NIL);
    expect(x.tracked).toBe(NIL - 1);
    expect(x.offsets[0]).toBeCloseTo(10 - (4 + 0 + 3), 6);
    const positions = [{ il: 0, xl: 0 }, { il: 7, xl: 7 }];
    const t = flattenOffsets(grid, geom, 'traverse', 0, 10, positions);
    expect(Array.from(t.offsets)).toEqual([10 - 4, 10 - (4 + 7 + 3.5)]);
    expect(datumForHorizon(grid, geom, 'inline', 2)).toBe(7.5);   // median of the 7 tracked picks 6, 6.5, 7, 7.5, 8, 8.5, 9.5
    expect(datumForHorizon(new Float32Array(NIL * NXL).fill(NULL_VALUE), geom, 'inline', 0)).toBeNull();
  });
});
