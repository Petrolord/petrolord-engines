// Inline and crossline slices straight from a local SEG-Y (large-survey
// plan section 2), reading only the traces a slice needs.
//
// An inline of an inline-sorted file is one contiguous read (876 traces x
// 7,240 bytes = 6.3 MB on the tester's survey). A crossline is strided:
// reads are coalesced where the gap between wanted traces is small and
// issued with bounded concurrency otherwise. Samples go through the one
// decoder (segyDecode.decodeSamples: IBM and IEEE, bit-identical to
// segyio), and the output layout and trace RMS are exactly those of
// sliceAssembly.assembleSlice, so a slice read locally and the same slice
// assembled from bricks are the same bits.
//
// Time slices need one sample from every trace in the file, so they are
// refused with a named error; the viewer says they are available after
// conversion.

import { TRACE_HEADER_BYTES, decodeSamples } from './segyDecode';
import { NULL_VALUE } from './manifest';
import { traceNumberAt, traceByteOffset } from './traceIndex';
import { sliceTraceRms } from './sliceAssembly';

const NULL_F32 = Math.fround(NULL_VALUE);

export const LOCAL_ABORTED = 'LOCAL_SLICE_ABORTED';

/** Named refusal: a time slice from an unconverted local file. Catch by
 *  `e.name === 'TIME_SLICE_NEEDS_CONVERSION'`. */
export class TimeSliceUnavailableError extends Error {
  constructor() {
    super('Time slices are available after conversion, because each one needs the whole file.');
    this.name = 'TIME_SLICE_NEEDS_CONVERSION';
  }
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    const e = new Error(LOCAL_ABORTED);
    e.name = 'AbortError';
    throw e;
  }
};

const normOrientation = (o) => (o === 'crossline' ? 'xline' : o);

/**
 * Trace numbers along one line, in the slice's row order (-1 = no trace).
 * @param {import('./traceIndex').TraceIndex} index
 * @param {'inline'|'xline'|'crossline'} orientation
 * @param {number} lineIdx 0-based lattice index of the line
 * @returns {Int32Array}
 */
export function lineTraceNumbers(index, orientation, lineIdx) {
  const o = normOrientation(orientation);
  if (o === 'inline') {
    const n = index.xl.count;
    const out = new Int32Array(n);
    for (let x = 0; x < n; x++) out[x] = traceNumberAt(index, lineIdx, x);
    return out;
  }
  if (o === 'xline') {
    const n = index.il.count;
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = traceNumberAt(index, i, lineIdx);
    return out;
  }
  throw new Error(`Unknown slice orientation: ${orientation}`);
}

/**
 * Group wanted trace numbers into contiguous read ranges.
 * @param {ArrayLike<number>} traceNumbers wanted traces (any order, -1 ignored)
 * @param {number} traceBytes
 * @param {{maxGapBytes?: number, maxReadBytes?: number}} [opts]
 * @returns {{first: number, last: number}[]} inclusive trace-number runs, ascending
 */
export function planTraceReads(traceNumbers, traceBytes, {
  maxGapBytes = 64 * 1024, maxReadBytes = 16 * 1024 * 1024,
} = {}) {
  const live = Array.from(traceNumbers).filter((t) => t >= 0).sort((a, b) => a - b);
  const runs = [];
  let cur = null;
  for (const t of live) {
    if (cur && t === cur.last) continue;                      // duplicate
    if (cur
      && (t - cur.last - 1) * traceBytes <= maxGapBytes
      && (t - cur.first + 1) * traceBytes <= maxReadBytes) {
      cur.last = t;
    } else {
      cur = { first: t, last: t };
      runs.push(cur);
    }
  }
  return runs;
}

async function forEachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      await fn(items[n]);
    }
  };
  const runners = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) runners.push(worker());
  await Promise.all(runners);
}

/**
 * Read wanted traces and decode each into its destination slots.
 * @param {import('./reader').ByteReader} reader
 * @param {import('./traceIndex').TraceIndex} index
 * @param {Int32Array} wanted trace number per destination slot (-1 skip)
 * @param {(slot: number) => Float32Array} dest destination of a slot (ns long)
 * @param {{signal?: AbortSignal, concurrency?: number, maxGapBytes?: number,
 *   maxReadBytes?: number, k0?: number, k1?: number}} opts
 *   k0/k1: sample window [k0, k1) decoded into dest[0 .. k1-k0)
 */
async function readTracesInto(reader, index, wanted, dest, opts) {
  const {
    signal, concurrency = 8, maxGapBytes, maxReadBytes,
  } = opts;
  const { traceBytes, ns, formatCode } = index.header;
  const k0 = opts.k0 ?? 0;
  const k1 = opts.k1 ?? ns;
  // slots per trace number (a trace may feed several slots)
  const slotsOf = new Map();
  for (let s = 0; s < wanted.length; s++) {
    const t = wanted[s];
    if (t < 0) continue;
    const list = slotsOf.get(t);
    if (list) list.push(s);
    else slotsOf.set(t, [s]);
  }
  const runs = planTraceReads(slotsOf.keys(), traceBytes, { maxGapBytes, maxReadBytes });
  await forEachLimited(runs, concurrency, async (run) => {
    throwIfAborted(signal);
    const count = run.last - run.first + 1;
    const buf = await reader.read(traceByteOffset(index, run.first), count * traceBytes);
    throwIfAborted(signal);
    const view = new DataView(buf);
    for (let t = run.first; t <= run.last; t++) {
      const slots = slotsOf.get(t);
      if (!slots) continue;
      const off = (t - run.first) * traceBytes + TRACE_HEADER_BYTES + k0 * 4;
      const first = dest(slots[0]);
      decodeSamples(view, off, k1 - k0, formatCode, first);
      for (let n = 1; n < slots.length; n++) dest(slots[n]).set(first.subarray(0, k1 - k0));
    }
  });
}

/**
 * One inline or crossline from the local file.
 *
 * `level` > 0 is the quick preview: every 2^level-th trace is read and
 * repeated over the positions it stands for, so the result has the full
 * slice's shape (a coarse crossline arrives in a quarter of the reads at
 * level 2). Level 0 is exact.
 *
 * @param {import('./reader').ByteReader} reader
 * @param {import('./traceIndex').TraceIndex} index
 * @param {'inline'|'xline'|'crossline'|'time'} orientation
 * @param {number} lineIdx 0-based lattice index
 * @param {{signal?: AbortSignal, level?: number, concurrency?: number,
 *   maxGapBytes?: number, maxReadBytes?: number}} [opts]
 * @returns {Promise<{data: Float32Array, width: number, height: number,
 *   traceRms: Float32Array, nullValue: number, level: number}>}
 */
export async function readLocalSlice(reader, index, orientation, lineIdx, opts = {}) {
  const o = normOrientation(orientation);
  if (o === 'time') throw new TimeSliceUnavailableError();
  const level = Math.max(0, Math.floor(opts.level || 0));
  const max = o === 'inline' ? index.il.count : index.xl.count;
  if (!(lineIdx >= 0 && lineIdx < max)) {
    throw new Error(`${o === 'inline' ? 'Inline' : 'Crossline'} index ${lineIdx} is outside 0..${max - 1}.`);
  }
  throwIfAborted(opts.signal);
  const ns = index.header.ns;
  const all = lineTraceNumbers(index, o, lineIdx);
  const height = all.length;
  const step = 2 ** level;
  const wanted = new Int32Array(height).fill(-1);
  for (let p = 0; p < height; p++) {
    const src = p - (p % step);
    wanted[p] = all[src];
  }
  const data = new Float32Array(ns * height).fill(NULL_F32);
  // a slot repeated at a coarse level decodes once and is copied
  await readTracesInto(reader, index, wanted,
    (slot) => data.subarray(slot * ns, slot * ns + ns), opts);
  const traceRms = sliceTraceRms(data, ns, height);
  return {
    data, width: ns, height, traceRms, nullValue: NULL_F32, level,
  };
}

/**
 * One full trace (horizon picking, synthetics), null-filled when dead.
 * @returns {Promise<Float32Array>}
 */
export async function readLocalTrace(reader, index, ilIdx, xlIdx, opts = {}) {
  const ns = index.header.ns;
  const out = new Float32Array(ns).fill(NULL_F32);
  const t = traceNumberAt(index, ilIdx, xlIdx);
  if (t < 0) return out;
  await readTracesInto(reader, index, Int32Array.of(t), () => out, opts);
  return out;
}

/**
 * One 3D brick in the v1 layout (data[(li*b + lj)*b + lk], padded and
 * dead cells null), so everything that reads bricks (tracking, traverses,
 * horizon extraction) also works on a local file. Each brick touches up
 * to b x b traces; inline-sorted files read them as b runs.
 *
 * @param {number} brickSize
 * @returns {Promise<Float32Array>}
 */
export async function readLocalBrick(reader, index, brickSize, i, j, k, opts = {}) {
  const b = brickSize;
  const ns = index.header.ns;
  const nIl = index.il.count;
  const nXl = index.xl.count;
  const out = new Float32Array(b * b * b).fill(NULL_F32);
  const k0 = k * b;
  const k1 = Math.min(k0 + b, ns);
  if (k0 >= ns) return out;
  const wanted = new Int32Array(b * b).fill(-1);
  for (let li = 0; li < b; li++) {
    const il = i * b + li;
    if (il >= nIl) break;
    for (let lj = 0; lj < b; lj++) {
      const xl = j * b + lj;
      if (xl >= nXl) break;
      wanted[li * b + lj] = traceNumberAt(index, il, xl);
    }
  }
  await readTracesInto(reader, index, wanted,
    (slot) => out.subarray(slot * b, slot * b + b), { ...opts, k0, k1 });
  return out;
}
