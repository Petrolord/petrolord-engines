/**
 * Horizon pick export writers + Irap classic surface writer — dialect
 * anchors on hand-computed fixtures. The byte-identity tests against
 * the Python oracle goldens run in the Suite (griddingExport /
 * pickExport suites there); this suite guards the repo standalone.
 */
import {
  picksToPickRows, writeCharismaHorizon, writeIlXlXyz, writeXyzPoints,
} from '../engines/seismolord/pickExport';
import { NULL_VALUE } from '../engines/seismolord/manifest';
import { writeIrapClassic, IRAP_NULL } from '../lib/gridding/surfaceExport';

const NULL_F32 = Math.fround(NULL_VALUE);

// 2 inlines x 3 crosslines, one null node; axis-aligned 25 m bins.
const geom = { nIl: 2, nXl: 3 };
const affine = {
  origin: { x: 500000, y: 6700000 },
  ilVec: { x: 0, y: 25 },
  xlVec: { x: 25, y: 0 },
};
const lines = { il0: 10, ilStep: 2, xl0: 200, xlStep: 3 };
const picks = new Float32Array([10, NULL_F32, 30, 12.5, 20, 40]);
const sampleToZ = (s) => -(s * 4);            // dt 4 ms, negative-down TWT

describe('picksToPickRows', () => {
  test('labels live picks with real line numbers and world coordinates', () => {
    const rows = picksToPickRows(picks, geom, affine, sampleToZ, lines);
    expect(rows).toHaveLength(5);              // the null node is absent
    expect(rows[0]).toEqual({ il: 10, xl: 200, x: 500000, y: 6700000, z: -40 });
    // il index 1, xl index 2 -> il 12, xl 206, x +50 m, y +25 m
    expect(rows[4]).toEqual({ il: 12, xl: 206, x: 500050, y: 6700025, z: -160 });
  });

  test('sampleToZ receives the lattice cell for column-dependent conversion', () => {
    const cells = [];
    picksToPickRows(picks, geom, affine, (s, cell) => { cells.push(cell); return s; }, lines);
    expect(cells).toEqual([0, 2, 3, 4, 5]);
  });

  test('throws without a usable affine', () => {
    expect(() => picksToPickRows(picks, geom, null, sampleToZ, lines))
      .toThrow(/survey coordinates/);
  });
});

describe('pick writers', () => {
  const rows = picksToPickRows(picks, geom, affine, sampleToZ, lines);

  test('Charisma rows are 9 whitespace tokens with markers at 1/2 and 4/5', () => {
    const text = writeCharismaHorizon(rows);
    const first = text.split('\n')[0];
    expect(first).toBe(
      'INLINE :     10 XLINE :    200   500000.00  6700000.00    -40.0000');
    for (const line of text.trim().split('\n')) {
      const tok = line.split(/\s+/);
      expect(tok).toHaveLength(9);
      expect([tok[0], tok[1], tok[3], tok[4]]).toEqual(['INLINE', ':', 'XLINE', ':']);
    }
  });

  test('five-column and XYZ writers emit one row per live pick', () => {
    expect(writeIlXlXyz(rows).trim().split('\n')[0])
      .toBe('10 200 500000.00 6700000.00 -40.0000');
    expect(writeXyzPoints(rows).trim().split('\n'))
      .toHaveLength(5);
  });
});

describe('writeIrapClassic', () => {
  test('emits the classic 4-line header and x-fastest south-first body', () => {
    const g = {
      nx: 3,
      ny: 2,
      dx: 25,
      dy: 50,
      x: [1000, 1025, 1050],
      y: [2000, 2050],
      z: new Float32Array([1, 2, NULL_F32, 4, 5, 6]),
    };
    const text = writeIrapClassic(g);
    const l = text.trim().split('\n');
    expect(l[0]).toBe('-996 2 25.000000 50.000000');
    expect(l[1]).toBe('1000.000000 1050.000000 2000.000000 2050.000000');
    expect(l[2]).toBe('3 0.000000 1000.000000 2000.000000');
    expect(l[3]).toBe('0  0  0  0  0  0  0');
    // south row first, x fastest; null becomes Irap's own sentinel
    expect(l[4]).toBe(`1.000000 2.000000 ${IRAP_NULL.toFixed(6)} 4.000000 5.000000 6.000000`);
    expect(l).toHaveLength(5);
  });
});
