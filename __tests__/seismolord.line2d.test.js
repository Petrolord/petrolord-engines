/**
 * W5 2D-line oracles: scan of a synthetic crooked-line SEG-Y (known
 * navigation, IEEE samples), bit-exact strip transcode + reassembly,
 * nav blob round trip, manifest/gate behaviour, intersections against
 * analytic crossings, and the mistie least-squares solve on constructed
 * shifts.
 */

import {
  scanLine2d, transcodeLineToStrips, writeNavBlob, readNavBlob,
  buildLineManifest, geomFromLineManifest, assembleLineSection,
  DEFAULT_STRIP_SIZE,
} from '../engines/seismolord/line2d';
import {
  lineIntersections, lineToLattice, pickAtTrace, solveMisties, crossingTraces,
} from '../engines/seismolord/line2dIntegration';
import { assertManifestSupported, NULL_VALUE, MANIFEST_READ_MAX } from '../engines/seismolord/manifest';
import { geomFromManifest } from '../engines/seismolord/sliceAssembly';

const NULL_F32 = Math.fround(NULL_VALUE);

// ---- synthetic 2D SEG-Y builder ------------------------------------------

const NTR = 150;
const NS = 90;
const DT_US = 4000;

/** crooked navigation: an L-ish dogleg in world coords */
const navTruth = (i) => (i < 80
  ? { x: 500000 + i * 25, y: 6700000 }
  : { x: 500000 + 80 * 25, y: 6700000 + (i - 80) * 25 });
const ampTruth = (i, k) => Math.fround(Math.sin(i * 0.37) * 100 + k);

function buildSegy2d({ deadTrace = -1 } = {}) {
  const traceBytes = 240 + NS * 4;
  const buf = new ArrayBuffer(3600 + NTR * traceBytes);
  const dv = new DataView(buf);
  dv.setInt16(3200 + 16, DT_US, false);     // dt
  dv.setInt16(3200 + 20, NS, false);        // ns
  dv.setInt16(3200 + 24, 5, false);         // IEEE float
  for (let i = 0; i < NTR; i++) {
    const off = 3600 + i * traceBytes;
    const { x, y } = navTruth(i);
    dv.setInt32(off + 16, 1000 + i, false);            // SP at byte 17
    dv.setInt32(off + 20, 2000 + i * 2, false);        // CDP at byte 21
    dv.setInt16(off + 70, -100, false);                // scalar: divide by 100
    const sx = deadTrace === i ? 0 : Math.round(x * 100);
    const sy = deadTrace === i ? 0 : Math.round(y * 100);
    dv.setInt32(off + 180, sx, false);                 // CDP X at 181
    dv.setInt32(off + 184, sy, false);                 // CDP Y at 185
    for (let k = 0; k < NS; k++) {
      dv.setFloat32(off + 240 + k * 4, ampTruth(i, k), false);
    }
  }
  return buf;
}

const bufReader = (buf) => ({
  size: buf.byteLength,
  read: async (off, len) => buf.slice(off, off + len),
});

// ---------------------------------------------------------------------------

describe('scanLine2d', () => {
  test('navigation, labels and arc length from a crooked line', async () => {
    const scan = await scanLine2d(bufReader(buildSegy2d()));
    expect(scan.ntraces).toBe(NTR);
    expect(scan.ns).toBe(NS);
    expect(scan.dtUs).toBe(DT_US);
    expect(scan.nav.cdp[0]).toBe(2000);
    expect(scan.nav.sp[NTR - 1]).toBe(1000 + NTR - 1);
    for (const i of [0, 40, 79, 80, 120, NTR - 1]) {
      const t = navTruth(i);
      expect(scan.nav.x[i]).toBeCloseTo(t.x, 6);
      expect(scan.nav.y[i]).toBeCloseTo(t.y, 6);
    }
    // dogleg arc length: 149 segments of 25 m (80 easting + 69 northing)
    expect(scan.lengthM).toBeCloseTo(149 * 25, 4);
    expect(scan.warnings).toHaveLength(0);
  });

  test('dead coordinates interpolate, with a warning', async () => {
    const scan = await scanLine2d(bufReader(buildSegy2d({ deadTrace: 40 })));
    expect(scan.warnings.some((w) => /zero\/invalid coordinates/.test(w))).toBe(true);
    const t = navTruth(40);                  // straight span: interp is exact
    expect(scan.nav.x[40]).toBeCloseTo(t.x, 6);
    expect(scan.nav.y[40]).toBeCloseTo(t.y, 6);
  });
});

describe('strips: transcode + assembly round trip', () => {
  test('bit-exact through the strip store, padding stays null', async () => {
    const reader = bufReader(buildSegy2d());
    const scan = await scanLine2d(reader);
    const strips = new Map();
    const t = await transcodeLineToStrips(reader, scan, {
      onStrip: ({ i, k, data }) => { strips.set(`${i}-${k}`, data); },
    });
    expect(t.stripGrid).toEqual({
      ni: Math.ceil(NTR / DEFAULT_STRIP_SIZE),
      nk: Math.ceil(NS / DEFAULT_STRIP_SIZE),
      stripSize: DEFAULT_STRIP_SIZE,
    });
    const manifest = buildLineManifest({
      lineId: 'L1', name: 'line 1', scan, transcode: t, sourceFileName: 'x.sgy', sourceFileSize: 1,
    });
    const geom2d = geomFromLineManifest(manifest);
    const section = await assembleLineSection(
      async (i, k) => strips.get(`${i}-${k}`), geom2d,
    );
    expect(section.width).toBe(NS);
    expect(section.height).toBe(NTR);
    for (const i of [0, 63, 64, NTR - 1]) {
      for (const k of [0, 63, 64, NS - 1]) {
        expect(section.data[i * NS + k]).toBe(ampTruth(i, k));
      }
    }
    // padded strip cells beyond the line are null in the store
    const lastStrip = strips.get(`${t.stripGrid.ni - 1}-0`);
    const padTrace = NTR - (t.stripGrid.ni - 1) * DEFAULT_STRIP_SIZE;
    expect(lastStrip[padTrace * DEFAULT_STRIP_SIZE]).toBe(NULL_F32);
    // stats over live samples only
    expect(t.stats.live_samples).toBe(NTR * NS);
  });
});

describe('nav blob + manifest + gate', () => {
  test('nav blob round-trips exactly (float64 coordinates)', async () => {
    const scan = await scanLine2d(bufReader(buildSegy2d()));
    const back = readNavBlob(writeNavBlob(scan.nav));
    expect(Array.from(back.x)).toEqual(Array.from(scan.nav.x));
    expect(Array.from(back.y)).toEqual(Array.from(scan.nav.y));
    expect(Array.from(back.cdp)).toEqual(Array.from(scan.nav.cdp));
    expect(Array.from(back.sp)).toEqual(Array.from(scan.nav.sp));
    expect(() => readNavBlob(new ArrayBuffer(3))).toThrow(/Corrupt/);
  });

  test('v3 manifests pass the gate; 3D readers refuse the kind', async () => {
    const reader = bufReader(buildSegy2d());
    const scan = await scanLine2d(reader);
    const t = await transcodeLineToStrips(reader, scan, { onStrip: () => {} });
    const m = buildLineManifest({
      lineId: 'L1', name: 'l', scan, transcode: t, sourceFileName: 'x', sourceFileSize: 1,
    });
    expect(m.manifest_version).toBe(3);
    expect(MANIFEST_READ_MAX).toBeGreaterThanOrEqual(3);
    expect(() => assertManifestSupported(m)).not.toThrow();
    expect(() => geomFromManifest(m)).toThrow(/2D line/);
    expect(() => geomFromLineManifest({ kind: 'seismic' })).toThrow(/Not a 2D line/);
  });
});

describe('lineIntersections', () => {
  const straight = (n, x0, y0, dx, dy) => ({
    x: Float64Array.from({ length: n }, (_, i) => x0 + i * dx),
    y: Float64Array.from({ length: n }, (_, i) => y0 + i * dy),
  });

  test('perpendicular lines cross once at the analytic point', () => {
    const a = straight(101, 0, 50, 10, 0);        // y=50, x 0..1000
    const b = straight(101, 500, 0, 0, 1);        // x=500, y 0..100
    const hits = lineIntersections(a, b, { cellM: 100 });
    expect(hits).toHaveLength(1);
    expect(hits[0].x).toBeCloseTo(500, 9);
    expect(hits[0].y).toBeCloseTo(50, 9);
    expect(hits[0].ia).toBeCloseTo(50, 9);        // trace 50 on A
    expect(hits[0].ib).toBeCloseTo(50, 9);        // trace 50 on B
  });

  test('parallel lines never cross; a zigzag crosses twice', () => {
    const a = straight(50, 0, 0, 10, 0);
    expect(lineIntersections(a, straight(50, 0, 5, 10, 0))).toHaveLength(0);
    const zig = {
      x: Float64Array.from([100, 100, 300, 300]),
      y: Float64Array.from([-50, 50, 50, -50]),
    };
    const hits = lineIntersections(a, zig, { cellM: 60 });
    expect(hits).toHaveLength(2);
    expect(hits[0].x).toBeCloseTo(100, 6);
    expect(hits[1].x).toBeCloseTo(300, 6);
  });
});

describe('lineToLattice / pickAtTrace', () => {
  test('projects through the affine with the traverse null contract', () => {
    const affine = {
      origin: { x: 1000, y: 2000 }, ilVec: { x: 0, y: 25 }, xlVec: { x: 25, y: 0 },
    };
    const nav = {
      x: Float64Array.from([1000, 1250, 5000]),   // last point far outside
      y: Float64Array.from([2000, 2250, 2000]),
    };
    const { positions, inside } = lineToLattice(nav, affine, { nIl: 64, nXl: 64 });
    expect(inside).toBe(2);
    expect(positions[0].il).toBeCloseTo(0, 12);
    expect(positions[0].xl).toBeCloseTo(0, 12);
    expect(positions[1].il).toBeCloseTo(10, 9);
    expect(positions[1].xl).toBeCloseTo(10, 9);
    expect(positions[2]).toBeNull();
  });

  test('pickAtTrace interpolates and nulls across gaps', () => {
    const picks = Float32Array.from([10, 12, NULL_F32, 16]);
    expect(pickAtTrace(picks, 0.5)).toBeCloseTo(11, 6);
    expect(pickAtTrace(picks, 1.5)).toBeNull();
    expect(pickAtTrace(picks, -1)).toBeNull();
    expect(pickAtTrace(picks, 9)).toBeNull();
  });
});

describe('solveMisties', () => {
  test('recovers constructed per-line shifts (relative, mean zero)', () => {
    // truth: a horizon at 100 samples everywhere; line shifts +2, -1, -1
    // samples (acquisition statics). dt = 4 ms.
    const truthShift = [2, -1, -1];
    const mkPicks = (s) => new Float32Array(50).fill(100 + s);
    const lines = truthShift.map((s, i) => ({ id: `L${i}`, picks: mkPicks(s) }));
    const crossings = [
      { a: 0, b: 1, ia: 10, ib: 20 },
      { a: 0, b: 2, ia: 30, ib: 5 },
      { a: 1, b: 2, ia: 40, ib: 45 },
    ];
    const res = solveMisties(lines, crossings, 4);
    expect(res.tied).toBe(3);
    expect(res.rmsBeforeMs).toBeGreaterThan(0);
    expect(res.rmsAfterMs).toBeLessThan(1e-6);
    // shifts recover the truth up to the mean-zero gauge
    const mean = truthShift.reduce((s, v) => s + v, 0) / 3;
    truthShift.forEach((s, i) => {
      expect(res.shiftsMs[i]).toBeCloseTo(-(s - mean) * 4, 2);
    });
  });

  test('null picks at a crossing drop the observation, not the solve', () => {
    const a = new Float32Array(50).fill(100);
    a.fill(NULL_F32, 8, 12);
    const lines = [
      { id: 'A', picks: a },
      { id: 'B', picks: new Float32Array(50).fill(101) },
    ];
    const res = solveMisties(lines, [
      { a: 0, b: 1, ia: 10, ib: 10 },       // inside A's hole -> dropped
      { a: 0, b: 1, ia: 30, ib: 30 },
    ], 4);
    expect(res.tied).toBe(1);
    expect(res.observations[0].dtMs).toBeCloseTo(4, 6);
    expect(res.rmsAfterMs).toBeLessThan(1e-6);
  });
});

describe('crossingTraces', () => {
  test('cuts the nearest trace pair, null off-line', () => {
    const mk = (h, w, fill) => ({
      width: w, height: h, data: new Float32Array(h * w).fill(fill),
    });
    const A = mk(10, 8, 1);
    const B = mk(10, 8, 2);
    const pair = crossingTraces(A, B, { ia: 3.4, ib: 7.6 });
    expect(pair.a[0]).toBe(1);
    expect(pair.b[0]).toBe(2);
    expect(crossingTraces(A, B, { ia: 40, ib: 0 })).toBeNull();
  });
});
