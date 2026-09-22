// Assemble display slices (inline / crossline / time) from cached bricks.
// Pure copy loops; decoding happens in the brick cache (brickCodec).
// Layouts match the segyio golden slices exactly, which is what the
// bit-identity tests assert.

import { NULL_VALUE, assertManifestSupported } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * @typedef {Object} VolumeGeom
 * @property {number} nIl inline count
 * @property {number} nXl crossline count
 * @property {number} ns samples per trace
 * @property {number} brickSize
 * @property {[number, number, number]} grid brick grid [ni, nj, nk]
 */

/** Extract the geometry the assembler needs from a v1 manifest.
 *  This is the single reader choke point: every display and compute
 *  path derives its geometry here, so the version gate lives here. */
export function geomFromManifest(manifest) {
  assertManifestSupported(manifest);
  // W5.1: a 2D line manifest passes the version gate but has NO lattice —
  // 3D readers must refuse the KIND loudly rather than guess one
  if (manifest?.kind === '2d_line') {
    throw new Error('This is a 2D line, not a 3D volume — open it in the 2D Line window.');
  }
  return {
    nIl: manifest.geometry.il.count,
    nXl: manifest.geometry.xl.count,
    ns: manifest.geometry.ns,
    brickSize: manifest.brick.size,
    grid: manifest.brick.grid,
  };
}

/**
 * Brick coordinates a slice needs.
 * @param {VolumeGeom} geom
 * @param {'inline'|'xline'|'time'} orientation
 * @param {number} index 0-based ilIdx / xlIdx / sample index
 * @returns {{i:number,j:number,k:number}[]}
 */
export function bricksForSlice(geom, orientation, index) {
  const [ni, nj, nk] = geom.grid;
  if (orientation === 'crossline') orientation = 'xline'; // eslint-disable-line no-param-reassign
  const b = geom.brickSize;
  const out = [];
  if (orientation === 'inline') {
    const i = Math.floor(index / b);
    for (let j = 0; j < nj; j++) for (let k = 0; k < nk; k++) out.push({ i, j, k });
  } else if (orientation === 'xline') {
    const j = Math.floor(index / b);
    for (let i = 0; i < ni; i++) for (let k = 0; k < nk; k++) out.push({ i, j, k });
  } else if (orientation === 'time') {
    const k = Math.floor(index / b);
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) out.push({ i, j, k });
  } else {
    throw new Error(`Unknown slice orientation: ${orientation}`);
  }
  return out;
}

/** Default bricks in flight per assembly. The assembler holds at most
 *  this many brick references at a time: each brick's contribution is
 *  copied into the slice as it arrives and the reference dropped. */
export const DEFAULT_ASSEMBLY_CONCURRENCY = 12;

/** Error message for an assembly the caller aborted. */
export const ASSEMBLY_ABORTED = 'SLICE_ASSEMBLY_ABORTED';

const normOrientation = (o) => (o === 'crossline' ? 'xline' : o);

/** Output shape of a slice: width = samples (or crosslines for time),
 *  height = traces (or inlines for time). */
export function sliceShape(geom, orientation) {
  const o = normOrientation(orientation);
  if (o === 'inline') return { width: geom.ns, height: geom.nXl };
  if (o === 'xline') return { width: geom.ns, height: geom.nIl };
  if (o === 'time') return { width: geom.nXl, height: geom.nIl };
  throw new Error(`Unknown slice orientation: ${orientation}`);
}

/**
 * Copy one brick's contribution into a slice (layouts as assembleSlice).
 * @param {Float32Array} data slice being filled
 * @param {Float32Array} brickData
 * @param {VolumeGeom} geom
 * @param {'inline'|'xline'|'time'} o
 * @param {number} index 0-based slice index
 * @param {number} bi @param {number} bj @param {number} bk brick coordinates
 */
export function copyBrickIntoSlice(data, brickData, geom, o, index, bi, bj, bk) {
  const b = geom.brickSize;
  const { ns, nIl, nXl } = geom;
  if (o === 'inline') {
    const li = index % b;
    const s0 = bk * b;
    const n = Math.min(b, ns - s0);
    const xEnd = Math.min(nXl, (bj + 1) * b);
    for (let x = bj * b; x < xEnd; x++) {
      const src = (li * b + (x - bj * b)) * b;
      data.set(brickData.subarray(src, src + n), x * ns + s0);
    }
  } else if (o === 'xline') {
    const lj = index % b;
    const s0 = bk * b;
    const n = Math.min(b, ns - s0);
    const iEnd = Math.min(nIl, (bi + 1) * b);
    for (let i = bi * b; i < iEnd; i++) {
      const src = ((i - bi * b) * b + lj) * b;
      data.set(brickData.subarray(src, src + n), i * ns + s0);
    }
  } else {
    const lk = index % b;
    const iEnd = Math.min(nIl, (bi + 1) * b);
    const xEnd = Math.min(nXl, (bj + 1) * b);
    for (let i = bi * b; i < iEnd; i++) {
      const li = i - bi * b;
      for (let x = bj * b; x < xEnd; x++) {
        data[i * nXl + x] = brickData[(li * b + (x - bj * b)) * b + lk];
      }
    }
  }
}

/**
 * Per-trace RMS (nulls excluded) for shader-side trace balancing.
 * @param {Float32Array} data [height][width] @param {number} width @param {number} height
 */
export function sliceTraceRms(data, width, height) {
  const traceRms = new Float32Array(height);
  for (let t = 0; t < height; t++) {
    let sum = 0;
    let n = 0;
    for (let s = 0; s < width; s++) {
      const v = data[t * width + s];
      if (v !== NULL_F32) { sum += v * v; n += 1; }
    }
    traceRms[t] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  return traceRms;
}

/**
 * Assemble several slices of one orientation in a single streaming pass
 * over the union of their bricks: every brick is fetched once, copied
 * into every slice it feeds, and released. Slices that share a brick row
 * (inlines 64..127, say) cost one fetch set, which is how the viewer
 * loads neighbouring slices at no extra transfer.
 *
 * At most `concurrency` bricks are referenced at any time, so the pinned
 * memory is concurrency x brick bytes (12 MiB at the default on 64^3
 * float32), where the old Promise.all pinned every brick of the slice at
 * once (392 MiB for one inline of the tester's survey).
 *
 * @param {(i:number,j:number,k:number) => Promise<Float32Array>} getBrick
 * @param {VolumeGeom} geom
 * @param {'inline'|'xline'|'crossline'|'time'} orientation
 * @param {number[]} indices 0-based slice indices
 * @param {{concurrency?: number, signal?: AbortSignal,
 *   onProgress?: (done: number, total: number) => void}} [opts]
 * @returns {Promise<Map<number, {data: Float32Array, width: number, height: number,
 *   traceRms: Float32Array|null, nullValue: number}>>}
 */
export async function assembleSlices(getBrick, geom, orientation, indices, opts = {}) {
  const o = normOrientation(orientation);
  const { concurrency = DEFAULT_ASSEMBLY_CONCURRENCY, signal, onProgress } = opts;
  const { width, height } = sliceShape(geom, o);
  const uniq = [...new Set(indices)];
  const slices = new Map(uniq.map((idx) => [idx, new Float32Array(width * height)]));
  // union of bricks, remembering which slices each brick feeds
  const feeds = new Map();
  for (const idx of uniq) {
    for (const c of bricksForSlice(geom, o, idx)) {
      const key = `${c.i}-${c.j}-${c.k}`;
      const f = feeds.get(key);
      if (f) f.indices.push(idx);
      else feeds.set(key, { ...c, indices: [idx] });
    }
  }
  const work = [...feeds.values()];
  let next = 0;
  let done = 0;
  let failure = null;
  const runner = async () => {
    while (next < work.length && !failure) {
      if (signal?.aborted) throw new Error(ASSEMBLY_ABORTED);
      const w = work[next];
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      const brickData = await getBrick(w.i, w.j, w.k);
      if (signal?.aborted) throw new Error(ASSEMBLY_ABORTED);
      for (const idx of w.indices) {
        copyBrickIntoSlice(slices.get(idx), brickData, geom, o, idx, w.i, w.j, w.k);
      }
      done += 1;
      if (onProgress) onProgress(done, work.length);
    }
  };
  const runners = [];
  for (let n = 0; n < Math.max(1, Math.min(concurrency, work.length)); n++) {
    runners.push(runner().catch((e) => { if (!failure) failure = e; }));
  }
  await Promise.all(runners);
  if (failure) throw failure;

  const out = new Map();
  for (const [idx, data] of slices) {
    const traceRms = o === 'time' ? null : sliceTraceRms(data, width, height);
    out.set(idx, {
      data, width, height, traceRms, nullValue: NULL_F32,
    });
  }
  return out;
}

/**
 * Assemble one slice.
 *
 * Layouts (row-major, matching the segyio goldens):
 *  - inline: [nXl traces][ns]   data[x*ns + s]
 *  - xline:  [nIl traces][ns]   data[i*ns + s]
 *  - time:   [nIl][nXl]         data[i*nXl + x]
 *
 * Streaming: bricks are fetched with bounded concurrency and released as
 * soon as they are copied (see assembleSlices).
 *
 * @param {(i:number,j:number,k:number) => Promise<Float32Array>} getBrick
 * @param {VolumeGeom} geom
 * @param {'inline'|'xline'|'crossline'|'time'} orientation
 * @param {number} index 0-based
 * @param {{concurrency?: number, signal?: AbortSignal,
 *   onProgress?: (done: number, total: number) => void}} [opts]
 * @returns {Promise<{data: Float32Array, width: number, height: number,
 *   traceRms: Float32Array|null, nullValue: number}>}
 *   width = samples along a trace (or crosslines for time slices),
 *   height = trace count (or inline count for time slices)
 */
export async function assembleSlice(getBrick, geom, orientation, index, opts = {}) {
  const out = await assembleSlices(getBrick, geom, orientation, [index], opts);
  return out.get(index);
}

/**
 * Assemble one full trace from bricks (horizon trackers walk traces).
 * @param {(i:number,j:number,k:number) => Promise<Float32Array>} getBrick
 * @param {VolumeGeom} geom
 * @param {number} ilIdx @param {number} xlIdx
 * @returns {Promise<Float32Array>} ns samples
 */
export async function assembleTrace(getBrick, geom, ilIdx, xlIdx) {
  const b = geom.brickSize;
  const bi = Math.floor(ilIdx / b);
  const bj = Math.floor(xlIdx / b);
  const li = ilIdx % b;
  const lj = xlIdx % b;
  const out = new Float32Array(geom.ns);
  for (let bk = 0; bk * b < geom.ns; bk++) {
    const brick = await getBrick(bi, bj, bk);
    const s0 = bk * b;
    const n = Math.min(b, geom.ns - s0);
    out.set(brick.subarray((li * b + lj) * b, (li * b + lj) * b + n), s0);
  }
  return out;
}

/** Cache-key helper shared by the viewer and the cache layer. */
export const brickKey = (storagePath, i, j, k) => `${storagePath}/bricks/${i}-${j}-${k}.f32`;
