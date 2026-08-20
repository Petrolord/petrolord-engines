// Depth section display (W3.4): CPU per-column depth stretch of a time
// section through the volume's velocity model. The seismic itself is
// NEVER modified — this is a display resample, exactly like gain/AGC
// live in the shader; picks stay in time (picking is disabled in depth
// mode v1, readout only).
//
// The whole conversion goes through ONE closure per column — the
// column's piecewise-linear map z_i = toDepthM(i·dt, cell) sampled at
// the volume's own samples — so the stretched amplitudes, the horizon
// rows, the fault vertices and the well markers can never disagree
// about where a time lands in depth. A layer boundary at time T_b
// therefore lands EXACTLY on the stretched row of z(T_b) (oracle).
//
// Monotone walk: z_i is non-decreasing in i (the velocity model clamps
// crossing boundaries to zero thickness), so resampling each output
// depth row advances a single cursor over the input samples —
// O(ns + nz) per column. Zero-thickness intervals (z_{i+1} == z_i)
// resolve to the FIRST sample of the interval.
//
// Nulls are 1.0E+30 (playbook): a null input sample nulls every output
// row whose interpolation touches it; rows beyond the column's maximum
// depth stay null.

import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/**
 * One column's sampled time->depth map.
 * @param {{toDepthM: Function}} conv makeDepthConverter result
 * @param {number} cell lattice cell (layer-cake column lookup)
 * @param {number} dtMs @param {number} ns
 * @returns {Float64Array} z[i] = depth (m) of sample i
 */
export function columnDepths(conv, cell, dtMs, ns) {
  const z = new Float64Array(ns);
  for (let i = 0; i < ns; i++) z[i] = conv.toDepthM(i * dtMs, cell);
  return z;
}

/**
 * Shared depth axis for a set of columns: 0 down to the DEEPEST bottom
 * sample of any column, nz rows.
 * @param {{toDepthM: Function}} conv @param {Iterable<number>} cells
 * @param {number} maxTwtMs @param {number} nz
 * @returns {{z0: number, dz: number, nz: number, zMax: number}}
 */
export function depthAxisFor(conv, cells, maxTwtMs, nz) {
  let zMax = 0;
  for (const cell of cells) {
    const z = conv.toDepthM(maxTwtMs, cell);
    if (Number.isFinite(z) && z > zMax) zMax = z;
  }
  if (!(zMax > 0)) throw new Error('The velocity model yields no positive depth for this section.');
  return { z0: 0, dz: zMax / (nz - 1), nz, zMax };
}

/**
 * Resample one time trace onto the depth axis through its column map
 * (monotone walk, linear interpolation, null propagation).
 *
 * @param {ArrayLike<number>} trace ns samples
 * @param {Float64Array} zOfSample columnDepths for this column
 * @param {{z0: number, dz: number, nz: number}} axis
 * @param {Float32Array} [out] nz output (allocated when omitted)
 * @returns {Float32Array}
 */
export function depthResampleColumn(trace, zOfSample, axis, out = null) {
  const { z0, dz, nz } = axis;
  const ns = trace.length;
  const res = out || new Float32Array(nz);
  res.fill(NULL_F32);
  let i = 0;
  for (let k = 0; k < nz; k++) {
    const zk = z0 + k * dz;
    while (i < ns - 2 && zOfSample[i + 1] < zk) i++;
    if (zk < zOfSample[i] || zk > zOfSample[i + 1]) continue; // above/below column
    const a = trace[i];
    const b = trace[i + 1];
    if (isNull(a) || isNull(b)) continue;
    const span = zOfSample[i + 1] - zOfSample[i];
    const f = span > 0 ? (zk - zOfSample[i]) / span : 0;
    res[k] = a + f * (b - a);
  }
  return res;
}

/**
 * Depth-stretch a whole section slice (assembleSlice layout:
 * data[trace * ns + sample], width = ns, height = trace count).
 *
 * @param {{data: Float32Array, width: number, height: number}} slice
 * @param {(traceIdx: number) => number} cellOf lattice cell per column
 * @param {{toDepthM: Function}} conv @param {number} dtMs
 * @param {{z0, dz, nz}} axis
 * @returns {{data: Float32Array, width: number, height: number,
 *   z0: number, dz: number}}
 */
export function depthStretchSlice(slice, cellOf, conv, dtMs, axis) {
  const ns = slice.width;
  const nTraces = slice.height;
  const data = new Float32Array(nTraces * axis.nz);
  for (let t = 0; t < nTraces; t++) {
    const z = columnDepths(conv, cellOf(t), dtMs, ns);
    depthResampleColumn(
      slice.data.subarray(t * ns, (t + 1) * ns), z, axis,
      data.subarray(t * axis.nz, (t + 1) * axis.nz),
    );
  }
  return {
    data, width: axis.nz, height: nTraces, z0: axis.z0, dz: axis.dz,
  };
}

/**
 * A time sample's DEPTH ROW (float) on the axis, through the same
 * closure — overlays convert with this so they land exactly where the
 * stretched amplitude landed. Null when the conversion has no depth.
 *
 * @param {{toDepthM: Function}} conv @param {number} cell
 * @param {number} sample (float) @param {number} dtMs @param {{z0, dz}} axis
 * @returns {?number}
 */
export function depthRowOfSample(conv, cell, sample, dtMs, axis) {
  if (!Number.isFinite(sample)) return null;
  const z = conv.toDepthM(sample * dtMs, cell);
  if (!Number.isFinite(z)) return null;
  return (z - axis.z0) / axis.dz;
}

/**
 * Convert a whole pick grid (sample indices, 1e30 nulls) to depth-row
 * values on the axis — the horizon overlay for a depth section.
 * @param {Float32Array} picks @param {{toDepthM: Function}} conv
 * @param {number} dtMs @param {{z0, dz}} axis
 * @returns {Float32Array} same shape, depth ROWS, 1e30 nulls
 */
export function depthRowGrid(picks, conv, dtMs, axis) {
  const out = new Float32Array(picks.length);
  for (let c = 0; c < picks.length; c++) {
    const s = picks[c];
    if (isNull(s)) { out[c] = NULL_F32; continue; }
    const r = depthRowOfSample(conv, c, s, dtMs, axis);
    out[c] = r == null ? NULL_F32 : r;
  }
  return out;
}
