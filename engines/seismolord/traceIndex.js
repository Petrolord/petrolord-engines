// Trace index from headers only (large-survey plan section 1).
//
// Answers "where in the file is the trace at (inline, crossline)?" without
// reading any samples, so a local SEG-Y can be viewed before (and without)
// any conversion. Two modes:
//
//  - predicted: a regular file sorted by inline (or by crossline). Every
//    trace's position follows from the first line's length, so the index
//    holds no per-trace data. It is VERIFIED, never assumed: the first,
//    the last and one interior trace header of every line must carry the
//    predicted (inline, crossline). On the tester's survey that is 2,130
//    reads of 240 bytes plus a ~20-read search for the line length.
//  - lattice: anything else (dead or missing traces, duplicates, unsorted
//    files). One streaming pass over the trace headers fills an Int32Array
//    lattice of trace numbers, -1 where no trace exists (a dead cell reads
//    as the playbook null, 1.0E+30). This lifts the old regular-grid and
//    inline-sorted refusals for viewing.
//
// Byte mappings stay caller-supplied (DEFAULT_MAPPING 189/193).

import {
  TEXT_HEADER_BYTES,
  BIN_HEADER_BYTES,
  TRACE_HEADER_BYTES,
  readHeaderInt32,
  readHeaderInt16,
  applyCoordScalar,
} from './segyDecode';
import { DEFAULT_MAPPING, readFileHeaders } from './segyScan';
import {
  makeAffineFit, affineFitAdd, solveAffineFit, affineToManifest,
} from './surveyGeometry';

export const TRACE_INDEX_VERSION = 1;

/** Largest lattice the index will allocate (cells). 64 M cells = 256 MB of
 *  Int32; a mapping that implies more is almost certainly wrong. */
export const MAX_LATTICE_CELLS = 64 * 1024 * 1024;

/** Named refusal for an aborted index build. */
export const INDEX_ABORTED = 'TRACE_INDEX_ABORTED';

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    const e = new Error(INDEX_ABORTED);
    e.name = 'AbortError';
    throw e;
  }
};

const traceOffset = (traceBytes, t) => TEXT_HEADER_BYTES + BIN_HEADER_BYTES + t * traceBytes;

/**
 * Run `fn` over `items` with at most `limit` in flight, results in order.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      out[n] = await fn(items[n]);
    }
  };
  const runners = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) runners.push(worker());
  await Promise.all(runners);
  return out;
}

/**
 * Build the trace index of a SEG-Y source.
 *
 * @param {import('./reader').ByteReader} reader
 * @param {Partial<typeof DEFAULT_MAPPING>} [mapping]
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {(done: number, total: number, phase: 'verify'|'headers') => void} [opts.onProgress]
 * @param {number} [opts.concurrency] header reads in flight (predicted mode)
 * @param {number} [opts.chunkBytes] read size of the streaming header pass
 * @param {boolean} [opts.forceLattice] skip the predicted fast path (tests)
 * @returns {Promise<TraceIndex>}
 *
 * @typedef {Object} TraceIndex
 * @property {number} version
 * @property {'predicted'|'lattice'} mode
 * @property {'inline'|'crossline'|'unsorted'} sort
 * @property {Object} header readFileHeaders() result
 * @property {Object} mapping
 * @property {{min:number,max:number,step:number,count:number}} il
 * @property {{min:number,max:number,step:number,count:number}} xl
 * @property {?{fast:'xl'|'il', fastRev:boolean, slowRev:boolean, nFast:number}} predict
 * @property {?Int32Array} lattice [ilIdx * nXl + xlIdx] = trace number, -1 dead
 * @property {number} liveTraces
 * @property {number} deadTraces cells with no trace
 * @property {number} duplicateTraces traces landing on an occupied cell (first wins)
 * @property {number} headerReads
 * @property {number} coordScalar first trace's coordinate scalar
 * @property {{first:?{x:number,y:number}, last:?{x:number,y:number}}} corners
 * @property {?Object} affine solveAffineFit() result
 * @property {string[]} warnings
 */
export async function buildTraceIndex(reader, mapping = {}, opts = {}) {
  const map = { ...DEFAULT_MAPPING, ...mapping };
  const {
    signal, onProgress, concurrency = 16, chunkBytes = 8 * 1024 * 1024, forceLattice = false,
  } = opts;
  const header = await readFileHeaders(reader);
  const { traceBytes, totalTraces } = header;
  if (totalTraces <= 0) throw new Error('No traces found in file.');
  throwIfAborted(signal);

  const warnings = [];
  if (header.trailingBytes !== 0) {
    warnings.push(`${header.trailingBytes} trailing bytes do not form a whole trace.`);
  }
  let headerReads = 0;
  const readHeader = async (t) => {
    headerReads += 1;
    return new DataView(await reader.read(traceOffset(traceBytes, t), TRACE_HEADER_BYTES));
  };
  const ilxl = (th) => [readHeaderInt32(th, map.ilByte), readHeaderInt32(th, map.xlByte)];

  if (!forceLattice && totalTraces >= 2) {
    const fast = await tryPredicted({
      readHeader, ilxl, map, totalTraces, concurrency, signal, onProgress,
    });
    if (fast) {
      return finish({
        header, map, warnings, headerReads, mode: 'predicted', ...fast,
      });
    }
  }
  throwIfAborted(signal);
  const lat = await latticePass({
    reader, map, header, chunkBytes, signal, onProgress, warnings,
  });
  headerReads += lat.reads;
  return finish({
    header, map, warnings, headerReads, mode: 'lattice', ...lat,
  });
}

/**
 * Fast path. Returns null (fall back to the lattice pass) as soon as the
 * file stops behaving like a regular sorted grid.
 */
async function tryPredicted({
  readHeader, ilxl, map, totalTraces, concurrency, signal, onProgress,
}) {
  const th0 = await readHeader(0);
  const th1 = await readHeader(1);
  const [il0, xl0] = ilxl(th0);
  const [il1, xl1] = ilxl(th1);
  let fast;
  if (il1 === il0 && xl1 !== xl0) fast = 'xl';
  else if (xl1 === xl0 && il1 !== il0) fast = 'il';
  else return null;
  const fastOf = (pair) => (fast === 'xl' ? pair[1] : pair[0]);
  const slowOf = (pair) => (fast === 'xl' ? pair[0] : pair[1]);
  const slow0 = slowOf([il0, xl0]);
  const fastStep = fastOf([il1, xl1]) - fastOf([il0, xl0]);

  // line length L: traces 0..L-1 share the first slow-axis value; search
  // exponentially then by bisection (the predicate is monotone in a
  // sorted file; a file that breaks it fails verification below)
  const onFirstLine = async (t) => slowOf(ilxl(await readHeader(t))) === slow0;
  let lo = 1;                 // known on the first line
  let hi = 2;
  while (hi < totalTraces && await onFirstLine(hi)) {
    lo = hi;
    hi = Math.min(totalTraces, hi * 2);
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await onFirstLine(mid)) lo = mid;
    else hi = mid;
  }
  const nFast = hi;
  if (totalTraces % nFast !== 0) return null;
  const nSlow = totalTraces / nFast;
  let slowStep = 0;
  if (nSlow > 1) {
    slowStep = slowOf(ilxl(await readHeader(nFast))) - slow0;
    if (slowStep === 0) return null;
  }
  if (nFast > 1 && fastStep === 0) return null;
  throwIfAborted(signal);

  // verify the first and last trace of every line plus one interior trace
  // chosen by a fixed hash (a line shuffled inside keeps its end traces),
  // collecting coordinates on the way
  const coordFit = makeAffineFit();
  const scalars = new Set();
  let corners = { first: null, last: null };
  let firstScalar = null;
  const probes = [];
  for (let s = 0; s < nSlow; s++) {
    probes.push({ s, f: 0 });
    if (nFast > 1) probes.push({ s, f: nFast - 1 });
    if (nFast > 2) probes.push({ s, f: 1 + (Math.imul(s + 1, 2654435761) >>> 0) % (nFast - 2) });
  }
  let done = 0;
  let ok = true;
  await mapLimited(probes, concurrency, async ({ s, f }) => {
    if (!ok) return;
    throwIfAborted(signal);
    const t = s * nFast + f;
    const th = await readHeader(t);
    const pair = ilxl(th);
    if (slowOf(pair) !== slow0 + s * slowStep || fastOf(pair) !== fastOf([il0, xl0]) + f * fastStep) {
      ok = false;
      return;
    }
    const sc = readHeaderInt16(th, map.scalarByte);
    if (scalars.size < 16) scalars.add(sc);
    const x = applyCoordScalar(readHeaderInt32(th, map.xByte), sc);
    const y = applyCoordScalar(readHeaderInt32(th, map.yByte), sc);
    affineFitAdd(coordFit, pair[0], pair[1], x, y);
    if (t === 0) { corners.first = { x, y }; firstScalar = sc; }
    if (t === totalTraces - 1) corners.last = { x, y };
    done += 1;
    if (onProgress && done % 64 === 0) onProgress(done, probes.length, 'verify');
  });
  if (!ok) return null;
  if (onProgress) onProgress(probes.length, probes.length, 'verify');

  const axis = (v0, step, n) => {
    const a = v0;
    const b = v0 + (n - 1) * step;
    return { min: Math.min(a, b), max: Math.max(a, b), step: Math.abs(step) || 1, count: n };
  };
  const fastAxis = axis(fastOf([il0, xl0]), fastStep, nFast);
  const slowAxis = axis(slow0, slowStep, nSlow);
  if (!corners.last) corners = { ...corners, last: corners.first };
  return {
    sort: fast === 'xl' ? 'inline' : 'crossline',
    il: fast === 'xl' ? slowAxis : fastAxis,
    xl: fast === 'xl' ? fastAxis : slowAxis,
    predict: { fast, fastRev: fastStep < 0, slowRev: slowStep < 0, nFast },
    lattice: null,
    liveTraces: totalTraces,
    duplicateTraces: 0,
    coordFit,
    scalars,
    coordScalar: firstScalar,
    corners,
  };
}

/** One streaming pass over every trace header. */
async function latticePass({
  reader, map, header, chunkBytes, signal, onProgress, warnings,
}) {
  const { traceBytes, totalTraces } = header;
  const ils = new Int32Array(totalTraces);
  const xls = new Int32Array(totalTraces);
  const coordFit = makeAffineFit();
  const scalars = new Set();
  let coordScalar = null;
  const corners = { first: null, last: null };
  let reads = 0;
  let inlineSorted = true;
  let crosslineSorted = true;

  // Whole-trace chunks: a streaming read of the file is far faster than
  // one 240-byte read per trace on a cold disk (1.2 ms a seek measured
  // on the benchmark survey). Only the headers are parsed.
  const tracesPerChunk = Math.max(1, Math.floor(chunkBytes / traceBytes));
  for (let start = 0; start < totalTraces; start += tracesPerChunk) {
    throwIfAborted(signal);
    const count = Math.min(tracesPerChunk, totalTraces - start);
    // eslint-disable-next-line no-await-in-loop
    const buf = await reader.read(traceOffset(traceBytes, start), count * traceBytes);
    reads += 1;
    for (let c = 0; c < count; c++) {
      const t = start + c;
      const th = new DataView(buf, c * traceBytes, TRACE_HEADER_BYTES);
      const il = readHeaderInt32(th, map.ilByte);
      const xl = readHeaderInt32(th, map.xlByte);
      ils[t] = il;
      xls[t] = xl;
      if (t > 0) {
        const pil = ils[t - 1];
        const pxl = xls[t - 1];
        if (il < pil || (il === pil && xl < pxl)) inlineSorted = false;
        if (xl < pxl || (xl === pxl && il < pil)) crosslineSorted = false;
      }
      // coordinates: a strided subset is plenty for the affine fit and
      // keeps the pass parse-light
      if (t === 0 || t === totalTraces - 1 || t % 97 === 0) {
        const sc = readHeaderInt16(th, map.scalarByte);
        if (scalars.size < 16) scalars.add(sc);
        const x = applyCoordScalar(readHeaderInt32(th, map.xByte), sc);
        const y = applyCoordScalar(readHeaderInt32(th, map.yByte), sc);
        affineFitAdd(coordFit, il, xl, x, y);
        if (t === 0) { corners.first = { x, y }; coordScalar = sc; }
        if (t === totalTraces - 1) corners.last = { x, y };
      }
    }
    if (onProgress) onProgress(start + count, totalTraces, 'headers');
  }

  let ilMin = Infinity; let ilMax = -Infinity; let xlMin = Infinity; let xlMax = -Infinity;
  for (let t = 0; t < totalTraces; t++) {
    const il = ils[t]; const xl = xls[t];
    if (il < ilMin) ilMin = il;
    if (il > ilMax) ilMax = il;
    if (xl < xlMin) xlMin = xl;
    if (xl > xlMax) xlMax = xl;
  }
  let ilStep = 0; let xlStep = 0;
  for (let t = 0; t < totalTraces; t++) {
    if (ilStep !== 1) ilStep = gcd(ilStep, ils[t] - ilMin);
    if (xlStep !== 1) xlStep = gcd(xlStep, xls[t] - xlMin);
    if (ilStep === 1 && xlStep === 1) break;
  }
  if (ilStep === 0) ilStep = 1;
  if (xlStep === 0) xlStep = 1;
  const nIl = Math.floor((ilMax - ilMin) / ilStep) + 1;
  const nXl = Math.floor((xlMax - xlMin) / xlStep) + 1;
  if (nIl * nXl > MAX_LATTICE_CELLS) {
    throw new Error(
      `These byte positions give a ${nIl.toLocaleString('en-US')} x ${nXl.toLocaleString('en-US')} `
      + 'grid, far larger than the trace count. Check the inline and crossline byte positions.');
  }
  const lattice = new Int32Array(nIl * nXl).fill(-1);
  let duplicateTraces = 0;
  for (let t = 0; t < totalTraces; t++) {
    const cell = ((ils[t] - ilMin) / ilStep) * nXl + (xls[t] - xlMin) / xlStep;
    if (lattice[cell] === -1) lattice[cell] = t;
    else duplicateTraces += 1;
  }
  const liveTraces = totalTraces - duplicateTraces;
  if (duplicateTraces > 0) {
    warnings.push(`${duplicateTraces.toLocaleString('en-US')} traces repeat an inline and crossline `
      + 'already seen; the first one is shown.');
  }
  if (nIl <= 1 && nXl <= 1 && totalTraces > 1) {
    warnings.push('Every trace has the same inline and crossline under these byte positions; '
      + 'they are almost certainly wrong.');
  }
  return {
    sort: inlineSorted ? 'inline' : crosslineSorted ? 'crossline' : 'unsorted',
    il: { min: ilMin, max: ilMax, step: ilStep, count: nIl },
    xl: { min: xlMin, max: xlMax, step: xlStep, count: nXl },
    predict: null,
    lattice,
    liveTraces,
    duplicateTraces,
    coordFit,
    scalars,
    coordScalar,
    corners,
    reads,
  };
}

function finish({
  header, map, warnings, headerReads, mode, sort, il, xl, predict, lattice,
  liveTraces, duplicateTraces, coordFit, scalars, coordScalar, corners,
}) {
  const cells = il.count * xl.count;
  const deadTraces = cells - liveTraces;
  if (deadTraces > 0) {
    warnings.push(`${deadTraces.toLocaleString('en-US')} of ${cells.toLocaleString('en-US')} grid `
      + 'positions have no trace; they show as nulls.');
  }
  const distinct = [...scalars];
  if (distinct.length > 1) {
    warnings.push(`Coordinate scalar varies across traces (${distinct.slice(0, 6).join(', ')}).`);
  }
  const affine = solveAffineFit(coordFit, {
    ilMin: il.min, ilStep: il.step, xlMin: xl.min, xlStep: xl.step,
  });
  return {
    version: TRACE_INDEX_VERSION,
    mode,
    sort,
    header,
    mapping: map,
    il,
    xl,
    predict,
    lattice,
    liveTraces,
    deadTraces,
    duplicateTraces,
    headerReads,
    coordScalar,
    corners,
    affine,
    warnings,
  };
}

/**
 * Trace number at a lattice cell, -1 for a dead cell.
 * @param {TraceIndex} index @param {number} ilIdx @param {number} xlIdx
 */
export function traceNumberAt(index, ilIdx, xlIdx) {
  const nIl = index.il.count;
  const nXl = index.xl.count;
  if (ilIdx < 0 || ilIdx >= nIl || xlIdx < 0 || xlIdx >= nXl) return -1;
  if (index.lattice) return index.lattice[ilIdx * nXl + xlIdx];
  const p = index.predict;
  if (p.fast === 'xl') {
    const s = p.slowRev ? nIl - 1 - ilIdx : ilIdx;
    const f = p.fastRev ? nXl - 1 - xlIdx : xlIdx;
    return s * p.nFast + f;
  }
  const s = p.slowRev ? nXl - 1 - xlIdx : xlIdx;
  const f = p.fastRev ? nIl - 1 - ilIdx : ilIdx;
  return s * p.nFast + f;
}

/** Byte offset of a trace (its header) in the file. */
export const traceByteOffset = (index, t) => traceOffset(index.header.traceBytes, t);

/**
 * The geometry block a v1 manifest carries, derived from the index, so
 * the viewer (axes, map, wells) treats a local file like an ingested
 * volume. `local: true` marks it as never uploaded.
 * @param {TraceIndex} index @param {{name?: string, fileSize?: number}} [meta]
 */
export function manifestFromTraceIndex(index, { name = 'Local SEG-Y', fileSize } = {}) {
  return {
    manifest_version: 1,
    app: 'seismolord',
    local: true,
    name,
    source: {
      file_name: name,
      file_size: fileSize,
      sample_format: index.header.formatCode,
      il_byte: index.mapping.ilByte,
      xl_byte: index.mapping.xlByte,
      x_byte: index.mapping.xByte,
      y_byte: index.mapping.yByte,
      scalar_byte: index.mapping.scalarByte,
    },
    geometry: {
      il: index.il,
      xl: index.xl,
      ns: index.header.ns,
      dt_us: index.header.dtUs,
      coord_scalar: index.coordScalar,
      corners: index.corners,
      affine: affineToManifest(index.affine),
    },
    trace_index: {
      mode: index.mode,
      sort: index.sort,
      live_traces: index.liveTraces,
      dead_traces: index.deadTraces,
    },
  };
}
