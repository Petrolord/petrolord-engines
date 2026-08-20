// CRS-step scan evidence: measurement system from the binary header,
// coordinate-units word, per-trace scalar statistics, source-XY
// cross-check, and the manifest crs block + byte-mapping provenance.

import { bufferReader } from '../engines/seismolord/reader';
import { scanGeometry } from '../engines/seismolord/segyScan';
import { buildManifest } from '../engines/seismolord/manifest';

const TEXT = 3200;
const BIN = 400;
const TRACE_HEADER = 240;

/**
 * Minimal IEEE-float SEG-Y: nIl x nXl regular grid, inline-sorted,
 * 4 samples per trace. Per-trace overrides let tests vary scalar and
 * the byte-89 units word.
 */
function makeSegy({
  nIl = 2, nXl = 3, scalar = -100, units = 1, measurementSystem = 1,
  perTrace = null,
}) {
  const ns = 4;
  const traceBytes = TRACE_HEADER + ns * 4;
  const buf = new ArrayBuffer(TEXT + BIN + nIl * nXl * traceBytes);
  const view = new DataView(buf);
  new Uint8Array(buf, 0, TEXT).fill(0x40);
  view.setInt16(TEXT + 16, 2000, false);   // dtUs
  view.setInt16(TEXT + 20, ns, false);     // ns
  view.setInt16(TEXT + 24, 5, false);      // IEEE float
  view.setInt16(TEXT + 54, measurementSystem, false);

  let t = 0;
  for (let i = 0; i < nIl; i += 1) {
    for (let j = 0; j < nXl; j += 1, t += 1) {
      const off = TEXT + BIN + t * traceBytes;
      const o = perTrace ? perTrace(i, j) : {};
      const s = o.scalar ?? scalar;
      const u = o.units ?? units;
      // world = (500000 + 25*j, 6700000 + 25*i), stored scaled by |s|
      const mult = s < 0 ? -s : (s > 1 ? 1 / s : 1);
      view.setInt32(off + 188, 100 + i, false);                       // il (189)
      view.setInt32(off + 192, 300 + j, false);                       // xl (193)
      view.setInt16(off + 70, s, false);                              // scalar (71)
      view.setInt32(off + 72, (500001 + 25 * j) * mult, false);       // source X (73)
      view.setInt32(off + 76, (6700002 + 25 * i) * mult, false);      // source Y (77)
      view.setInt32(off + 180, (500000 + 25 * j) * mult, false);      // CDP X (181)
      view.setInt32(off + 184, (6700000 + 25 * i) * mult, false);     // CDP Y (185)
      view.setInt16(off + 88, u, false);                              // units (89)
      for (let k = 0; k < ns; k += 1) view.setFloat32(off + TRACE_HEADER + k * 4, t + k, false);
    }
  }
  return bufferReader(buf);
}

test('scan reports measurement system, units word, scalar stats and source XY', async () => {
  const scan = await scanGeometry(makeSegy({}));
  expect(scan.measurementSystem).toBe(1);
  expect(scan.coordUnits).toBe(1);
  expect(scan.coordUnitsVaried).toBe(false);
  expect(scan.scalarStats).toEqual({ first: -100, distinct: [-100], varied: false });
  expect(scan.sourceCoords.x).toBeCloseTo(500001, 6);
  expect(scan.sourceCoords.y).toBeCloseTo(6700002, 6);
  expect(scan.corners.first.x).toBeCloseTo(500000, 6);
  expect(scan.affine).not.toBeNull();
  expect(scan.warnings).toEqual([]);
});

test('arc-second units word raises a warning, geometry still measured', async () => {
  const scan = await scanGeometry(makeSegy({ units: 2 }));
  expect(scan.coordUnits).toBe(2);
  expect(scan.warnings.some((w) => w.includes('ARC-SECONDS'))).toBe(true);
  expect(scan.affine).not.toBeNull();
});

test('a varying scalar is reported per trace and warned about', async () => {
  const scan = await scanGeometry(makeSegy({
    perTrace: (i, j) => ({ scalar: (i + j) % 2 === 0 ? -100 : -10 }),
  }));
  expect(scan.scalarStats.varied).toBe(true);
  expect(new Set(scan.scalarStats.distinct)).toEqual(new Set([-100, -10]));
  expect(scan.warnings.some((w) => w.includes('scalar varies'))).toBe(true);
  // Each trace scaled by its own value: the affine stays exact.
  expect(scan.affine.fit.rmsM).toBeLessThan(1e-6);
});

test('manifest carries the crs block and the full byte mapping', async () => {
  const reader = makeSegy({});
  const scan = await scanGeometry(reader);
  const crs = {
    project: 'EPSG:32631',
    native: 'EPSG:23031',
    native_xy_unit: 'm',
    transform: 'helmert3',
    max_residual_m: 0.004,
  };
  const transcode = {
    brickGrid: { brickSize: 64, ni: 1, nj: 1, nk: 1 },
    stats: { min: 0, max: 8 },
    traceCount: 6,
  };
  const m = buildManifest({
    volumeId: 'v1', name: 'test', scan, transcode,
    sourceFileName: 'test.sgy', sourceFileSize: reader.size, crs,
  });
  expect(m.geometry.crs).toEqual(crs);
  expect(m.source).toMatchObject({
    il_byte: 189, xl_byte: 193, x_byte: 181, y_byte: 185, scalar_byte: 71,
  });
  const noCrs = buildManifest({
    volumeId: 'v1', name: 'test', scan, transcode,
    sourceFileName: 'test.sgy', sourceFileSize: reader.size,
  });
  expect(noCrs.geometry.crs).toBeUndefined();
});
