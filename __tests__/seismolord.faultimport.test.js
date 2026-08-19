/**
 * Fault-stick import mirrors — round-trip against the Charisma
 * fault-stick writer (parse(write) reproduces the stored sticks within
 * the dialect's decimal precision), grouping/order invariants (stick
 * order is load-bearing for faultBarriers and the 3D ribbon loft),
 * malformed-file domain errors, and lattice landing with skip/drop
 * counts. Plus latticeValuesToSamples: physical surface values ->
 * fractional sample indices for the section overlay contract.
 */
import {
  detectFaultStickFormat, parseFaultStickFile, faultSticksToLattice,
} from '../engines/seismolord/faultImport';
import {
  faultSticksToRows, writeCharismaFaultSticks, writeCharismaHorizon, picksToPickRows,
} from '../engines/seismolord/pickExport';
import { latticeValuesToSamples } from '../engines/seismolord/surfaceOnLattice';
import { makeTvdssToTwt } from '../engines/seismolord/wellSection';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

const geom = { nIl: 8, nXl: 10, ns: 64 };
const lines = { il0: 10, ilStep: 2, xl0: 200, xlStep: 3 };
const affine = {
  origin: { x: 500000, y: 6700000 },
  ilVec: { x: 0, y: 25 },
  xlVec: { x: 25, y: 0 },
};
const dtMs = 4;
const sampleToZ = (s) => -(s * dtMs);   // suite negative-down ms
const zToSample = (z) => -z / dtMs;

/** Two sticks of a listric-ish fault, fractional lattice positions. */
const storedSticks = [
  { points: [{ il: 1, xl: 2.5, s: 8.25 }, { il: 1, xl: 3, s: 20.5 }, { il: 1, xl: 3.75, s: 40 }] },
  { points: [{ il: 3.5, xl: 2, s: 10 }, { il: 3.5, xl: 4, s: 44.75 }] },
];

describe('fault-stick import round-trips its own writer', () => {
  const faults = [{ name: 'Main Fault', rows: faultSticksToRows(storedSticks, affine, sampleToZ, lines) }];
  const text = writeCharismaFaultSticks(faults);

  test('writer emits 8-token INLINE- rows with underscored names', () => {
    const first = text.split('\n')[0].trim().split(/\s+/);
    expect(first).toHaveLength(8);
    expect(first[0]).toBe('INLINE-');
    expect(first[6]).toBe('Main_Fault');
  });

  test('Charisma text lands back on the identical sticks', () => {
    const parsed = parseFaultStickFile(text);
    expect(parsed.format).toBe('charisma');
    expect(parsed.faults).toHaveLength(1);
    expect(parsed.faults[0].name).toBe('Main_Fault');
    const out = faultSticksToLattice(parsed.faults, geom, lines, affine, zToSample);
    expect(out.skipped).toBe(0);
    expect(out.droppedSticks).toBe(0);
    expect(out.faults[0].sticks).toHaveLength(storedSticks.length);
    out.faults[0].sticks.forEach((stick, k) => {
      const truth = storedSticks[k].points;
      expect(stick.points).toHaveLength(truth.length);
      stick.points.forEach((q, m) => {
        // il/xl written to 2 dp of the REAL line number -> /step
        expect(q.il).toBeCloseTo(truth[m].il, 2);
        expect(q.xl).toBeCloseTo(truth[m].xl, 2);
        // z written to 4 dp of ms -> /dtMs
        expect(q.s).toBeCloseTo(truth[m].s, 3);
      });
    });
  });

  test('xyzn rows locate through the inverse affine as one named fault', () => {
    const xyzn = faults[0].rows
      .map((r) => `${r.x} ${r.y} ${r.z} ${r.stick}`).join('\n');
    const parsed = parseFaultStickFile(xyzn, null, 'F1');
    expect(parsed.format).toBe('xyzn');
    expect(parsed.faults[0].name).toBe('F1');
    const out = faultSticksToLattice(parsed.faults, geom, lines, affine, zToSample);
    expect(out.faults[0].sticks).toHaveLength(2);
    expect(out.faults[0].sticks[1].points[0].il).toBeCloseTo(3.5, 6);
    expect(out.faults[0].sticks[1].points[0].xl).toBeCloseTo(2, 6);
  });
});

describe('grouping and order invariants', () => {
  test('interleaved faults group by name; sticks sort by number; points keep file order', () => {
    const text = [
      'INLINE- 12 206 500150.00 6700025.00 40.0000 F_B 2',
      'INLINE- 10 203 500075.00 6700000.00 33.0000 F_A 1',
      'INLINE- 12 209 500225.00 6700025.00 41.0000 F_B 2',
      'INLINE- 10 206 500150.00 6700000.00 82.0000 F_A 1',
      'INLINE- 14 206 500150.00 6700050.00 40.0000 F_B 1',
      'INLINE- 14 209 500225.00 6700050.00 80.0000 F_B 1',
    ].join('\n');
    const { faults } = parseFaultStickFile(text);
    expect(faults.map((f) => f.name)).toEqual(['F_B', 'F_A']);   // first appearance
    const fb = faults[0];
    expect(fb.sticks).toHaveLength(2);
    expect(fb.sticks[0][0].il).toBe(14);                         // stick 1 before stick 2
    expect(fb.sticks[1].map((p) => p.xl)).toEqual([206, 209]);   // file order within stick
  });

  test('fault names with spaces survive (name = tokens between z and stick#)', () => {
    const text = 'INLINE- 10 203 500075.00 6700000.00 33.0000 Big Boundary Fault 4\n';
    const { faults } = parseFaultStickFile(text);
    expect(faults[0].name).toBe('Big Boundary Fault');
  });
});

describe('detection and malformed files', () => {
  test('detects charisma fault sticks vs xyzn', () => {
    expect(detectFaultStickFormat('INLINE- 10 203 1.0 2.0 33.0 F 1')).toBe('charisma');
    expect(detectFaultStickFormat('# c\n1.0 2.0 33.0 1')).toBe('xyzn');
  });

  test('a Charisma HORIZON file is refused, not misread', () => {
    const rows = picksToPickRows(
      (() => { const p = new Float32Array(80).fill(NULL_F32); p[0] = 10; return p; })(),
      geom, affine, sampleToZ, lines,
    );
    expect(() => detectFaultStickFormat(writeCharismaHorizon(rows)))
      .toThrow(/Unrecognised fault-stick file/);
  });

  test('malformed rows throw with the line number', () => {
    expect(() => parseFaultStickFile('INLINE- 10 203 1.0 2.0 33.0 F 1\nINLINE- 10 oops 1.0 2.0 33.0 F 1'))
      .toThrow(/Line 2/);
    expect(() => parseFaultStickFile('1.0 2.0 33.0 1\n1.0 2.0 oops', 'xyzn'))
      .toThrow(/Line 2/);
    expect(() => parseFaultStickFile('')).toThrow(/empty/);
  });

  test('sticks reduced below two points are dropped whole and counted', () => {
    const parsed = parseFaultStickFile([
      'INLINE- 10 203 500075.00 6700000.00 33.0000 F 1',
      'INLINE- 10 206 500150.00 6700000.00 9999.0000 F 1',  // out of window -> skipped
      'INLINE- 12 203 500075.00 6700025.00 33.0000 F 2',
      'INLINE- 12 206 500150.00 6700025.00 40.0000 F 2',
    ].join('\n'));
    const out = faultSticksToLattice(parsed.faults, geom, lines, affine, (z) => z / dtMs);
    expect(out.droppedSticks).toBe(1);
    expect(out.skipped).toBe(2);           // the out-of-window row + the orphaned survivor
    expect(out.placed).toBe(2);
    expect(out.faults[0].sticks).toHaveLength(1);
  });

  test('nothing placed is an error, not an empty import', () => {
    const parsed = parseFaultStickFile([
      'INLINE- 900 203 0.0 0.0 33.0000 F 1',
      'INLINE- 902 203 0.0 0.0 40.0000 F 1',
    ].join('\n'));
    expect(() => faultSticksToLattice(parsed.faults, geom, lines, affine, (z) => z / dtMs))
      .toThrow(/No fault sticks landed/);
  });
});

describe('latticeValuesToSamples (surfaces on sections)', () => {
  test('time surface: positive-down ms divides by the sample rate', () => {
    const values = Float32Array.from([80, 12, NULL_F32, 300]);   // ns 64 * 4ms = 252ms max
    const { grid, live } = latticeValuesToSamples(values, { nIl: 2, nXl: 2, ns: 64 }, { dtMs });
    expect(live).toBe(2);
    expect(grid[0]).toBeCloseTo(20, 6);
    expect(grid[1]).toBeCloseTo(3, 6);
    expect(grid[2]).toBe(NULL_F32);
    expect(grid[3]).toBe(NULL_F32);                              // 300ms > (ns-1)*dt
  });

  test('depth surface converts through makeTvdssToTwt (constant 2000 m/s)', () => {
    const timeConv = makeTvdssToTwt({
      checkshots: null,
      velocity: { v0: 2000, k: 0 },
      boundaries: null,
      dtUs: dtMs * 1000,
      maxTwtMs: (64 - 1) * dtMs,
    });
    // depth m = v0 * t/2000 -> t = depth (numerically) at v0=2000
    const ft = 100 / 0.3048;                                     // 100 m in feet
    const values = Float32Array.from([ft, NULL_F32]);
    const { grid, live } = latticeValuesToSamples(values, { nIl: 1, nXl: 2, ns: 64 }, {
      dtMs, timeConv, mPerUnit: 0.3048,
    });
    expect(live).toBe(1);
    expect(grid[0]).toBeCloseTo(100 / dtMs, 5);                  // 100 ms -> sample 25
    expect(grid[1]).toBe(NULL_F32);
  });

  test('depth below the time window goes null, never clamped', () => {
    const timeConv = makeTvdssToTwt({
      checkshots: null,
      velocity: { v0: 2000, k: 0 },
      boundaries: null,
      dtUs: dtMs * 1000,
      maxTwtMs: (64 - 1) * dtMs,
    });
    const values = Float32Array.from([5000]);                    // 5 km >> window
    const { grid, live } = latticeValuesToSamples(values, { nIl: 1, nXl: 1, ns: 64 }, {
      dtMs, timeConv, mPerUnit: 1,
    });
    expect(live).toBe(0);
    expect(grid[0]).toBe(NULL_F32);
  });
});
