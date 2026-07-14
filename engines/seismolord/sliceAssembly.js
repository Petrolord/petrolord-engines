// Assemble display slices (inline / crossline / time) from cached bricks.
// Pure copy loops — decode happened at ingest; bricks are raw float32.
// Layouts match the segyio golden slices exactly, which is what the
// bit-identity tests assert.

import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * @typedef {Object} VolumeGeom
 * @property {number} nIl inline count
 * @property {number} nXl crossline count
 * @property {number} ns samples per trace
 * @property {number} brickSize
 * @property {[number, number, number]} grid brick grid [ni, nj, nk]
 */

/** Extract the geometry the assembler needs from a v1 manifest. */
export function geomFromManifest(manifest) {
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

/**
 * Assemble one slice.
 *
 * Layouts (row-major, matching the segyio goldens):
 *  - inline: [nXl traces][ns]   data[x*ns + s]
 *  - xline:  [nIl traces][ns]   data[i*ns + s]
 *  - time:   [nIl][nXl]         data[i*nXl + x]
 *
 * @param {(i:number,j:number,k:number) => Promise<Float32Array>} getBrick
 * @param {VolumeGeom} geom
 * @param {'inline'|'xline'|'time'} orientation
 * @param {number} index 0-based
 * @returns {Promise<{data: Float32Array, width: number, height: number,
 *   traceRms: Float32Array|null, nullValue: number}>}
 *   width = samples along a trace (or crosslines for time slices),
 *   height = trace count (or inline count for time slices)
 */
export async function assembleSlice(getBrick, geom, orientation, index) {
  const b = geom.brickSize;
  const needed = bricksForSlice(geom, orientation, index);
  const bricks = new Map();
  await Promise.all(needed.map(async ({ i, j, k }) => {
    bricks.set(`${i}-${j}-${k}`, await getBrick(i, j, k));
  }));
  const brick = (i, j, k) => bricks.get(`${i}-${j}-${k}`);

  let data;
  let width;
  let height;

  if (orientation === 'inline') {
    const li = index % b;
    const bi = Math.floor(index / b);
    width = geom.ns;
    height = geom.nXl;
    data = new Float32Array(width * height);
    for (let x = 0; x < geom.nXl; x++) {
      const bj = Math.floor(x / b);
      const lj = x % b;
      const src = brick(bi, bj, 0 /* per-k below */);
      for (let bk = 0; bk * b < geom.ns; bk++) {
        const cur = bk === 0 ? src : brick(bi, bj, bk);
        const s0 = bk * b;
        const n = Math.min(b, geom.ns - s0);
        data.set(cur.subarray((li * b + lj) * b, (li * b + lj) * b + n), x * geom.ns + s0);
      }
    }
  } else if (orientation === 'xline') {
    const lj = index % b;
    const bj = Math.floor(index / b);
    width = geom.ns;
    height = geom.nIl;
    data = new Float32Array(width * height);
    for (let i = 0; i < geom.nIl; i++) {
      const bi = Math.floor(i / b);
      const li = i % b;
      for (let bk = 0; bk * b < geom.ns; bk++) {
        const cur = brick(bi, bj, bk);
        const s0 = bk * b;
        const n = Math.min(b, geom.ns - s0);
        data.set(cur.subarray((li * b + lj) * b, (li * b + lj) * b + n), i * geom.ns + s0);
      }
    }
  } else {
    const lk = index % b;
    const bk = Math.floor(index / b);
    width = geom.nXl;
    height = geom.nIl;
    data = new Float32Array(width * height);
    for (let i = 0; i < geom.nIl; i++) {
      const bi = Math.floor(i / b);
      const li = i % b;
      for (let x = 0; x < geom.nXl; x++) {
        const bj = Math.floor(x / b);
        const lj = x % b;
        data[i * geom.nXl + x] = brick(bi, bj, bk)[(li * b + lj) * b + lk];
      }
    }
  }

  // Per-trace RMS (nulls excluded) for shader-side trace balancing; time
  // slices have no trace axis.
  let traceRms = null;
  if (orientation !== 'time') {
    traceRms = new Float32Array(height);
    for (let t = 0; t < height; t++) {
      let sum = 0;
      let n = 0;
      for (let s = 0; s < width; s++) {
        const v = data[t * width + s];
        if (v !== NULL_F32) { sum += v * v; n += 1; }
      }
      traceRms[t] = n > 0 ? Math.sqrt(sum / n) : 0;
    }
  }

  return { data, width, height, traceRms, nullValue: NULL_F32 };
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
