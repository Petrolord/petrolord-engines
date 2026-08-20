// int16 quantized brick codec (W4.4): halves brick storage and egress.
//
// Payload layout ('int16le-scaled'):
//   bytes 0-3   float32le scale   (amplitude units per count)
//   bytes 4-7   float32le offset  (amplitude at count 0)
//   bytes 8-    int16le   counts  (brick voxels, x-fastest like float32)
//   count -32768 = the NULL sentinel (1.0E+30 on decode)
//
// Per-brick scale/offset: offset = (min+max)/2 and scale spans the
// brick's own live range over the usable count range [-32767, 32767] —
// quiet bricks keep fine resolution instead of inheriting the volume's
// loudest reflector. Quantization error is bounded by scale/2 (pinned
// by the oracle). A brick with no live samples (or a flat one) encodes
// scale 0 and decodes exactly.
//
// The manifest gate (W0.1, aged in production since Wave 0) rejects
// this dtype on pre-W4.4 clients with upgrade copy — never garbage.

import { NULL_VALUE } from './manifest';

export const INT16_DTYPE = 'int16le-scaled';
export const INT16_HEADER_BYTES = 8;
export const INT16_NULL = -32768;

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

const nextUpScratch = new DataView(new ArrayBuffer(4));
/** The next representable float32 above a positive float32. */
function nextFloat32Up(v) {
  nextUpScratch.setFloat32(0, v, true);
  nextUpScratch.setUint32(0, nextUpScratch.getUint32(0, true) + 1, true);
  return nextUpScratch.getFloat32(0, true);
}

/**
 * Encode one float32 brick as int16le-scaled.
 * @param {Float32Array} data brick voxels (1e30 nulls)
 * @returns {ArrayBuffer} INT16_HEADER_BYTES + 2 bytes per voxel
 */
export function encodeBrickInt16(data) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNull(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const flat = !(max > min);
  // quantize against the FLOAT32-ROUNDED header values decode will read
  // (or the scale/2 error bound fails by a rounding hair), and round the
  // scale UP to the next float32 when fround went down — a scale that
  // under-spans the range clamps the extremes past the bound
  const offset = Math.fround(max >= min ? (min + max) / 2 : 0);
  let scale = 0;
  if (!flat) {
    const s0 = (max - min) / 65534;               // counts -32767..32767
    scale = Math.fround(s0);
    if (scale < s0) scale = nextFloat32Up(scale);
  }

  const buf = new ArrayBuffer(INT16_HEADER_BYTES + data.length * 2);
  const head = new DataView(buf);
  head.setFloat32(0, scale, true);
  head.setFloat32(4, offset, true);
  const out = new Int16Array(buf, INT16_HEADER_BYTES);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNull(v)) { out[i] = INT16_NULL; continue; }
    if (scale === 0) { out[i] = 0; continue; }
    const q = Math.round((v - offset) / scale);
    out[i] = q < -32767 ? -32767 : q > 32767 ? 32767 : q;
  }
  return buf;
}

/**
 * Decode an int16le-scaled payload back to float32 (1e30 nulls).
 * @param {ArrayBuffer} buffer
 * @returns {Float32Array}
 */
export function decodeBrickInt16(buffer) {
  const head = new DataView(buffer);
  const scale = head.getFloat32(0, true);
  const offset = head.getFloat32(4, true);
  const counts = new Int16Array(buffer, INT16_HEADER_BYTES);
  const out = new Float32Array(counts.length);
  for (let i = 0; i < counts.length; i++) {
    const q = counts[i];
    out[i] = q === INT16_NULL ? NULL_F32 : offset + q * scale;
  }
  return out;
}

/**
 * Decode any supported brick payload to float32 voxels — the single
 * read-side dispatch (BrickCache calls this, so everything downstream
 * of the cache is codec-blind).
 * @param {ArrayBuffer} buffer @param {string} [dtype]
 * @returns {Float32Array}
 */
export function decodeBrickPayload(buffer, dtype = 'float32le') {
  if (dtype === INT16_DTYPE) return decodeBrickInt16(buffer);
  if (dtype === 'float32le' || dtype == null) return new Float32Array(buffer);
  throw new Error(`Unsupported brick dtype "${dtype}".`);
}

/** Stored bytes per voxel for a dtype (headers amortized per brick). */
export function bytesPerVoxel(dtype = 'float32le') {
  return dtype === INT16_DTYPE ? 2 : 4;
}

/**
 * Stored bytes of a whole PADDED brick grid — the honest quota
 * preflight (bricks pad to brickSize^3 regardless of the survey edge;
 * the old ns*nIl*nXl*4 estimate under-counted every ragged edge).
 * @param {{ni:number, nj:number, nk:number, brickSize:number}} grid
 * @param {string} [dtype]
 */
export function brickGridBytes(grid, dtype = 'float32le') {
  const bricks = grid.ni * grid.nj * grid.nk;
  const voxels = grid.brickSize ** 3;
  const header = dtype === INT16_DTYPE ? INT16_HEADER_BYTES : 0;
  return bricks * (voxels * bytesPerVoxel(dtype) + header);
}
