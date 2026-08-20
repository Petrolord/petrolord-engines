// Surface grid reprojection by inverse mapping: build the target frame in
// the destination CRS, then for every target node transform BACK to the
// native CRS and bilinear-sample the native grid. Inverse mapping leaves
// no holes and never invents data: nodes whose native preimage falls
// outside the native grid (or on null cells) stay NULL_VALUE.
//
// Scattered points headed for gridding do not come through here — they
// are point-transformed before the TPS fit, which then runs entirely in
// the target frame. This module is for grids that already exist.

import { NULL_VALUE } from '../gridding/numeric';
import { sampleAtXY } from '../gridding/gridmath';
import { unitToMetres } from './catalog';

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) >= 1e29;

/**
 * Reproject a regular grid into another CRS.
 *
 * @param {{x0,y0,dx,dy,nx,ny}} spec native grid frame
 * @param {Float32Array|number[]} z row-major nx*ny values, NULL_VALUE nulls
 * @param {{forward:Function, inverse:Function}} transformer
 *   native CRS -> target CRS (makeTransformer())
 * @param {Object} [opts]
 * @param {string} [opts.nativeUnit='m'] native XY unit, sets default target
 *   spacing = native spacing in metres (target CRS assumed metric)
 * @param {number} [opts.cellM] explicit target cell size override
 * @returns {{spec:Object, z:Float32Array, coverage:number}|null}
 *   coverage = fraction of native non-null nodes that survived; null when
 *   the transform produces no finite frame
 */
export function reprojectGrid(spec, z, transformer, opts = {}) {
  const cell = Number.isFinite(opts.cellM) && opts.cellM > 0
    ? opts.cellM
    : Math.max(Math.abs(spec.dx), Math.abs(spec.dy)) * unitToMetres(opts.nativeUnit || 'm');

  // Target bbox from the transformed native hull: corners plus edge
  // midpoints, because projected edges bow.
  const xEnd = spec.x0 + (spec.nx - 1) * spec.dx;
  const yEnd = spec.y0 + (spec.ny - 1) * spec.dy;
  const xMid = (spec.x0 + xEnd) / 2;
  const yMid = (spec.y0 + yEnd) / 2;
  const hull = [
    [spec.x0, spec.y0], [xEnd, spec.y0], [spec.x0, yEnd], [xEnd, yEnd],
    [xMid, spec.y0], [xMid, yEnd], [spec.x0, yMid], [xEnd, yMid],
  ].map(([x, y]) => transformer.forward(x, y));
  if (hull.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

  const tx0 = Math.min(...hull.map((p) => p.x));
  const tx1 = Math.max(...hull.map((p) => p.x));
  const ty0 = Math.min(...hull.map((p) => p.y));
  const ty1 = Math.max(...hull.map((p) => p.y));
  const nx = Math.max(2, Math.floor((tx1 - tx0) / cell) + 1);
  const ny = Math.max(2, Math.floor((ty1 - ty0) / cell) + 1);
  const target = { x0: tx0, y0: ty0, dx: cell, dy: cell, nx, ny };

  const out = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r += 1) {
    for (let c = 0; c < nx; c += 1) {
      const native = transformer.inverse(tx0 + c * cell, ty0 + r * cell);
      out[r * nx + c] = (Number.isFinite(native.x) && Number.isFinite(native.y))
        ? sampleAtXY(z, spec, native.x, native.y)
        : NULL_VALUE;
    }
  }

  let nativeLive = 0;
  for (let i = 0; i < z.length; i += 1) if (!isNull(z[i])) nativeLive += 1;
  let targetLive = 0;
  for (let i = 0; i < out.length; i += 1) if (!isNull(out[i])) targetLive += 1;
  // Node counts differ between frames; compare areas via cell footprint.
  const nativeArea = nativeLive * Math.abs(spec.dx * spec.dy)
    * unitToMetres(opts.nativeUnit || 'm') ** 2;
  const targetArea = targetLive * cell * cell;
  const coverage = nativeArea > 0 ? Math.min(1, targetArea / nativeArea) : 0;

  return { spec: target, z: out, coverage };
}
