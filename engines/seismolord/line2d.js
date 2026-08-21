// 2D seismic lines (W5.1/W5.2): scan, strip transcode, navigation blob
// and section assembly. A 2D line has NO lattice — its geometry is a
// MEASURED polyline of per-trace world coordinates (crooked lines are
// the normal case), parameterized by trace order; CDP/SP numbers are
// labels along it, never indices.
//
// Storage model (the 3D brick discipline at one dimension less):
//   strips/{i}-{k}.f32 — stripSize x stripSize float32 tiles
//     (i = trace band, k = sample window; layout localTrace * stripSize
//     + localSample, padding = 1.0E+30)
//   nav.bin — per-trace navigation: int32 ntraces, float64 x/y pairs,
//     int32 cdp[], int32 sp[] (float64 because UTM eastings at 1e6 lose
//     sub-metre precision in float32)
//   manifest.json — manifest_version 3, kind '2d_line' (the aged W0.1
//   gate turns v3 into upgrade copy on pre-W5 clients; 3D readers
//   refuse the kind loudly rather than guessing a lattice)
//
// Pure engine: injected readers, no I/O, playbook nulls.

import {
  TEXT_HEADER_BYTES, BIN_HEADER_BYTES, TRACE_HEADER_BYTES,
  decodeSamples, readHeaderInt32, readHeaderInt16, applyCoordScalar,
} from './segyDecode';
import { readFileHeaders } from './segyScan';
import { NULL_VALUE } from './manifest';

export const DEFAULT_2D_MAPPING = Object.freeze({
  cdpByte: 21,        // ensemble/CDP number (SEG-Y rev1 standard)
  spByte: 17,         // energy-source-point (shotpoint) number
  xByte: 181,         // CDP X (rev1); preset 73/77 = source coords
  yByte: 185,
  scalarByte: 71,
});

export const MAPPING_2D_PRESETS = [
  { key: 'rev1_cdp', label: 'SEG-Y rev1 CDP (X/Y at 181/185)', mapping: DEFAULT_2D_MAPPING },
  {
    key: 'source_coords',
    label: 'Source coordinates (X/Y at 73/77)',
    mapping: { ...DEFAULT_2D_MAPPING, xByte: 73, yByte: 77 },
  },
];

export const DEFAULT_STRIP_SIZE = 64;
export const stripRelPath = (i, k) => `strips/${i}-${k}.f32`;

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * Scan a 2D SEG-Y: per-trace navigation (world x/y through the
 * coordinate scalar), CDP and SP labels, polyline arc length. Always a
 * FULL scan — 2D lines are small next to cubes, and the navigation IS
 * the geometry, so sampling it would invent a straighter line than was
 * shot.
 *
 * @param {import('./reader').ByteReader} reader
 * @param {Partial<typeof DEFAULT_2D_MAPPING>} [mapping]
 * @param {{chunkBytes?: number, onProgress?: (done, total) => void}} [opts]
 */
export async function scanLine2d(reader, mapping = {}, opts = {}) {
  const map = { ...DEFAULT_2D_MAPPING, ...mapping };
  const { chunkBytes = 4 * 1024 * 1024, onProgress } = opts;
  const header = await readFileHeaders(reader);
  const { traceBytes, totalTraces } = header;
  if (totalTraces <= 0) throw new Error('No traces found in file.');

  const x = new Float64Array(totalTraces);
  const y = new Float64Array(totalTraces);
  const cdp = new Int32Array(totalTraces);
  const sp = new Int32Array(totalTraces);
  const warnings = [];
  if (header.trailingBytes !== 0) {
    warnings.push(`${header.trailingBytes} trailing bytes do not form a whole trace.`);
  }

  const tracesPerChunk = Math.max(1, Math.floor(chunkBytes / traceBytes));
  let deadCoords = 0;
  let cdpNonMonotonic = 0;
  for (let t = 0; t < totalTraces; t += tracesPerChunk) {
    const count = Math.min(tracesPerChunk, totalTraces - t);
    const off = TEXT_HEADER_BYTES + BIN_HEADER_BYTES + t * traceBytes;
    const buf = await reader.read(off, count * traceBytes);
    for (let c = 0; c < count; c++) {
      const th = new DataView(buf, c * traceBytes, TRACE_HEADER_BYTES);
      const s = readHeaderInt16(th, map.scalarByte);
      const cx = applyCoordScalar(readHeaderInt32(th, map.xByte), s);
      const cy = applyCoordScalar(readHeaderInt32(th, map.yByte), s);
      const i = t + c;
      x[i] = cx;
      y[i] = cy;
      cdp[i] = readHeaderInt32(th, map.cdpByte);
      sp[i] = readHeaderInt32(th, map.spByte);
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || (cx === 0 && cy === 0)) {
        deadCoords += 1;
      }
      if (i > 0 && cdp[i] <= cdp[i - 1]) cdpNonMonotonic += 1;
    }
    if (onProgress) onProgress(Math.min(totalTraces, t + count), totalTraces);
  }

  if (deadCoords === totalTraces) {
    throw new Error('No usable coordinates in the trace headers — check the X/Y byte positions and the scalar byte.');
  }
  if (deadCoords > 0) {
    warnings.push(`${deadCoords} trace(s) carry zero/invalid coordinates; the navigation interpolates across them.`);
    repairDeadCoords(x, y);
  }
  if (cdpNonMonotonic > 0) {
    warnings.push(`CDP numbers are not strictly increasing at ${cdpNonMonotonic} trace(s); trace order stays the line parameterization.`);
  }

  let lengthM = 0;
  for (let i = 1; i < totalTraces; i++) {
    lengthM += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }

  return {
    kind: '2d_line',
    ns: header.ns,
    dtUs: header.dtUs,
    formatCode: header.formatCode,
    traceBytes,
    ntraces: totalTraces,
    mapping: map,
    nav: { x, y, cdp, sp },
    lengthM,
    warnings,
  };
}

/** Linear interpolation across zero/invalid coordinate runs (dead
 *  headers happen; a gap must not fold the polyline through 0,0). */
function repairDeadCoords(x, y) {
  const n = x.length;
  const dead = (i) => !Number.isFinite(x[i]) || !Number.isFinite(y[i]) || (x[i] === 0 && y[i] === 0);
  let firstLive = -1;
  for (let i = 0; i < n; i++) if (!dead(i)) { firstLive = i; break; }
  if (firstLive < 0) return;
  for (let i = 0; i < firstLive; i++) { x[i] = x[firstLive]; y[i] = y[firstLive]; }
  let prev = firstLive;
  for (let i = firstLive + 1; i < n; i++) {
    if (dead(i)) continue;
    if (i > prev + 1) {
      for (let j = prev + 1; j < i; j++) {
        const f = (j - prev) / (i - prev);
        x[j] = x[prev] + f * (x[i] - x[prev]);
        y[j] = y[prev] + f * (y[i] - y[prev]);
      }
    }
    prev = i;
  }
  for (let i = prev + 1; i < n; i++) { x[i] = x[prev]; y[i] = y[prev]; }
}

/**
 * Stream the line into stripSize x stripSize float32 strips. One pass,
 * one trace band in memory (stripSize traces x ns samples — a few MB),
 * the 3D transcoder's discipline without the k-group re-streaming.
 *
 * @param {import('./reader').ByteReader} reader
 * @param {ReturnType<typeof scanLine2d> extends Promise<infer T> ? T : never} scan
 * @param {{stripSize?: number, readChunkBytes?: number,
 *   onStrip: (s: {i:number,k:number,data:Float32Array}) => Promise<void>|void,
 *   onProgress?: (done, total, phase) => void}} opts
 */
export async function transcodeLineToStrips(reader, scan, opts = {}) {
  const {
    stripSize = DEFAULT_STRIP_SIZE,
    readChunkBytes = 4 * 1024 * 1024,
    onStrip, onProgress,
  } = opts;
  if (!onStrip) throw new Error('onStrip callback is required.');
  const { ns, traceBytes, ntraces, formatCode } = scan;
  const ni = Math.ceil(ntraces / stripSize);
  const nk = Math.ceil(ns / stripSize);
  const totalStrips = ni * nk;

  const scratch = new Float32Array(ns);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let nLive = 0;
  let stripsDone = 0;

  const tracesPerChunk = Math.max(1, Math.floor(readChunkBytes / traceBytes));
  for (let bi = 0; bi < ni; bi++) {
    const t0 = bi * stripSize;
    const t1 = Math.min(t0 + stripSize, ntraces);          // exclusive
    /** band strips, one per k window, pre-filled with nulls */
    const strips = Array.from({ length: nk },
      () => new Float32Array(stripSize * stripSize).fill(NULL_VALUE));

    for (let t = t0; t < t1; t += tracesPerChunk) {
      const count = Math.min(tracesPerChunk, t1 - t);
      const off = TEXT_HEADER_BYTES + BIN_HEADER_BYTES + t * traceBytes;
      const buf = await reader.read(off, count * traceBytes);
      const view = new DataView(buf);
      for (let c = 0; c < count; c++) {
        decodeSamples(view, c * traceBytes + TRACE_HEADER_BYTES, ns, formatCode, scratch);
        const lt = (t + c) - t0;
        for (let k = 0; k < ns; k++) {
          const v = scratch[k];
          const sk = Math.floor(k / stripSize);
          strips[sk][lt * stripSize + (k - sk * stripSize)] = v;
          if (v !== NULL_F32) {
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
            sumSq += v * v;
            nLive += 1;
          }
        }
      }
    }

    for (let sk = 0; sk < nk; sk++) {
      await onStrip({ i: bi, k: sk, data: strips[sk] });
      strips[sk] = null;
      stripsDone += 1;
      if (onProgress) onProgress(stripsDone, totalStrips, 'transcode');
    }
  }

  return {
    stripGrid: { ni, nk, stripSize },
    stats: {
      min, max, mean: sum / nLive, rms: Math.sqrt(sumSq / nLive), live_samples: nLive,
    },
  };
}

// ---- navigation blob ------------------------------------------------------

/** Serialize per-trace navigation (see the layout note at the top). */
export function writeNavBlob(nav) {
  const n = nav.x.length;
  const buf = new ArrayBuffer(4 + n * (8 + 8 + 4 + 4));
  const dv = new DataView(buf);
  dv.setInt32(0, n, true);
  let o = 4;
  for (let i = 0; i < n; i++) { dv.setFloat64(o, nav.x[i], true); o += 8; }
  for (let i = 0; i < n; i++) { dv.setFloat64(o, nav.y[i], true); o += 8; }
  for (let i = 0; i < n; i++) { dv.setInt32(o, nav.cdp[i], true); o += 4; }
  for (let i = 0; i < n; i++) { dv.setInt32(o, nav.sp[i], true); o += 4; }
  return buf;
}

export function readNavBlob(buffer) {
  if (!buffer || buffer.byteLength < 4) throw new Error('Corrupt navigation blob.');
  const dv = new DataView(buffer);
  const n = dv.getInt32(0, true);
  const expected = 4 + n * 24;
  if (n <= 0 || buffer.byteLength < expected) {
    throw new Error('Corrupt navigation blob.');
  }
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const cdp = new Int32Array(n);
  const sp = new Int32Array(n);
  let o = 4;
  for (let i = 0; i < n; i++) { x[i] = dv.getFloat64(o, true); o += 8; }
  for (let i = 0; i < n; i++) { y[i] = dv.getFloat64(o, true); o += 8; }
  for (let i = 0; i < n; i++) { cdp[i] = dv.getInt32(o, true); o += 4; }
  for (let i = 0; i < n; i++) { sp[i] = dv.getInt32(o, true); o += 4; }
  return { x, y, cdp, sp };
}

// ---- manifest -------------------------------------------------------------

/**
 * 2D line manifest — manifest_version 3, kind '2d_line'. Pre-W5 clients
 * refuse v3 through the aged gate; 3D readers refuse the kind.
 */
export function buildLineManifest({
  lineId, name, scan, transcode, sourceFileName, sourceFileSize, crs = null,
}) {
  let xMin = Infinity; let xMax = -Infinity;
  let yMin = Infinity; let yMax = -Infinity;
  for (let i = 0; i < scan.ntraces; i++) {
    const px = scan.nav.x[i];
    const py = scan.nav.y[i];
    if (px < xMin) xMin = px;
    if (px > xMax) xMax = px;
    if (py < yMin) yMin = py;
    if (py > yMax) yMax = py;
  }
  return {
    manifest_version: 3,
    kind: '2d_line',
    line_id: lineId,
    name,
    geometry: {
      ntraces: scan.ntraces,
      ns: scan.ns,
      dt_us: scan.dtUs,
      length_m: Math.round(scan.lengthM * 100) / 100,
      cdp: { first: scan.nav.cdp[0], last: scan.nav.cdp[scan.ntraces - 1] },
      sp: { first: scan.nav.sp[0], last: scan.nav.sp[scan.ntraces - 1] },
      bbox: { x_min: xMin, x_max: xMax, y_min: yMin, y_max: yMax },
      ...(crs ? { crs } : {}),
    },
    strip: {
      size: transcode.stripGrid.stripSize,
      grid: [transcode.stripGrid.ni, transcode.stripGrid.nk],
      count: transcode.stripGrid.ni * transcode.stripGrid.nk,
      dtype: 'float32le',
    },
    nav: { storage: 'nav.bin' },
    stats: transcode.stats,
    source: {
      file_name: sourceFileName,
      file_size: sourceFileSize,
      sample_format: scan.formatCode,
      mapping: scan.mapping,
    },
  };
}

/** Geometry accessor with the same refusal discipline as 3D readers. */
export function geomFromLineManifest(manifest) {
  if (manifest?.kind !== '2d_line') {
    throw new Error('Not a 2D line manifest.');
  }
  const g = manifest.geometry;
  const s = manifest.strip;
  return {
    ntraces: g.ntraces,
    ns: g.ns,
    dtUs: g.dt_us,
    stripSize: s.size,
    grid: s.grid,
  };
}

// ---- section assembly -----------------------------------------------------

/** Hard ceiling so a monster line cannot allocate the tab away. */
export const MAX_SECTION_FLOATS = 64 * 1024 * 1024;   // 256 MB

/**
 * Assemble the full line section from strips (traverse slice layout:
 * data[trace * ns + sample], width = ns, height = ntraces — exactly
 * what the section window renders).
 *
 * @param {(i: number, k: number) => Promise<Float32Array>} getStrip
 * @param {ReturnType<typeof geomFromLineManifest>} geom2d
 */
export async function assembleLineSection(getStrip, geom2d) {
  const { ntraces, ns, stripSize, grid } = geom2d;
  if (ntraces * ns > MAX_SECTION_FLOATS) {
    throw new Error(
      `This line is too large to display in one section (${ntraces} traces x ${ns} samples).`);
  }
  const data = new Float32Array(ntraces * ns).fill(NULL_F32);
  const [ni, nk] = grid;
  const jobs = [];
  for (let i = 0; i < ni; i++) {
    for (let k = 0; k < nk; k++) {
      jobs.push((async () => {
        const strip = await getStrip(i, k);
        const t0 = i * stripSize;
        const t1 = Math.min(t0 + stripSize, ntraces);
        const s0 = k * stripSize;
        const s1 = Math.min(s0 + stripSize, ns);
        for (let t = t0; t < t1; t++) {
          const lt = t - t0;
          data.set(
            strip.subarray(lt * stripSize, lt * stripSize + (s1 - s0)),
            t * ns + s0,
          );
        }
      })());
    }
  }
  await Promise.all(jobs);
  return { data, width: ns, height: ntraces };
}
