// Generic grid math shared across geoscience apps — extracted from
// Mapping & Surface Studio's engine/surface.js at the second consumer
// (Earth Modeling, G8.1), the WorkspaceShell/waveform/gridding rule.
// Pure functions, no I/O.
//
// Grid convention (matches src/lib/gridding): z is a row-major typed
// array of nx*ny, z[r*nx + c], with world x[c] = x0 + c*dx and
// y[r] = y0 + r*dy (row 0 = south). NULL_VALUE (1e30) marks empty
// nodes. Outputs preserve the input array type (Float32Array in ->
// Float32Array out; Float64Array in -> Float64Array out), so callers
// choose their precision and the f32 house default is unchanged.

import { NULL_VALUE } from '../../lib/gridding/numeric';

export const isNull = (v) => !Number.isFinite(v) || Math.abs(v) >= 1e29;

const outArray = (like, length) =>
  new (ArrayBuffer.isView(like) ? like.constructor : Float64Array)(length);

/** World coordinates of node (r, c) on a spec. */
export const gridXY = (spec, r, c) => ({
  x: spec.x0 + c * spec.dx,
  y: spec.y0 + r * spec.dy,
});

/**
 * Bilinear sample of z (nx*ny) at fractional index (fx, fy). Outside
 * the frame, or with any null corner, returns NULL_VALUE. An exact
 * node hit needs only that node to be live.
 */
export function bilinearSample(z, nx, ny, fx, fy) {
  if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return NULL_VALUE;
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const tx = fx - c0;
  const ty = fy - r0;
  const c1 = tx > 0 ? c0 + 1 : c0;   // only reach the next node when actually weighted
  const r1 = ty > 0 ? r0 + 1 : r0;   // so an exact node hit needs only that node
  const v00 = z[r0 * nx + c0];
  const v01 = z[r0 * nx + c1];
  const v10 = z[r1 * nx + c0];
  const v11 = z[r1 * nx + c1];
  if (isNull(v00) || isNull(v01) || isNull(v10) || isNull(v11)) return NULL_VALUE;
  return (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty;
}

/** Bilinear sample at a WORLD coordinate on a spec. */
export function sampleAtXY(z, spec, x, y) {
  return bilinearSample(z, spec.nx, spec.ny, (x - spec.x0) / spec.dx, (y - spec.y0) / spec.dy);
}

/**
 * Bilinear resample z (on specA) onto specB's frame. A target node
 * outside specA, or whose source neighbours include a null, becomes
 * null. Reproduces any bilinear (hence linear) field exactly.
 */
export function resampleTo(z, specA, specB) {
  const out = outArray(z, specB.nx * specB.ny);
  for (let r = 0; r < specB.ny; r++) {
    const wy = specB.y0 + r * specB.dy;
    const fy = (wy - specA.y0) / specA.dy;
    for (let c = 0; c < specB.nx; c++) {
      const wx = specB.x0 + c * specB.dx;
      const fx = (wx - specA.x0) / specA.dx;
      out[r * specB.nx + c] = bilinearSample(z, specA.nx, specA.ny, fx, fy);
    }
  }
  return out;
}

/** Elementwise a op b on the SAME spec; null if either side null. */
export function combine(zA, zB, op) {
  if (zA.length !== zB.length) throw new Error('Surfaces must share a grid frame — resample first.');
  const fn = { subtract: (a, b) => a - b, add: (a, b) => a + b, multiply: (a, b) => a * b }[op];
  if (!fn) throw new Error(`Unknown surface op "${op}".`);
  const out = outArray(zA, zA.length);
  for (let i = 0; i < zA.length; i++) {
    out[i] = (isNull(zA[i]) || isNull(zB[i])) ? NULL_VALUE : fn(zA[i], zB[i]);
  }
  return out;
}

/** Isochore = deeper − shallower (both positive-down => thickness). */
export const isochore = (zDeep, zShallow) => combine(zDeep, zShallow, 'subtract');

/** z + k on every live node. */
export function scalarAdd(z, k) {
  const out = outArray(z, z.length);
  for (let i = 0; i < z.length; i++) out[i] = isNull(z[i]) ? NULL_VALUE : z[i] + k;
  return out;
}

/** min / max / mean / live-node count over a grid. */
export function surfaceStats(z) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const v of z) {
    if (isNull(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n += 1;
  }
  return n ? { min, max, mean: sum / n, count: n } : { min: null, max: null, mean: null, count: 0 };
}
