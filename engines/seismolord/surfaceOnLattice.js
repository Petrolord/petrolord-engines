// Registry surface -> volume lattice resampling, for the Map window.
// A stored surface is an axis-aligned world-metre grid (row-major,
// row 0 = southernmost Y); the map draws il/xl lattice grids. Each
// lattice cell resolves to world XY through the survey affine and
// bilinearly samples the surface; a cell whose 2x2 support is not
// fully live goes null (no invented values at surface edges or across
// null holes), as does a cell outside the surface extent.

import { NULL_VALUE } from './manifest';
import { ilxlToWorld } from './surveyGeometry';

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => v === NULL_F32 || !Number.isFinite(v) || Math.abs(v) > 1.0e29;

const W_EPS = 1e-6;

/**
 * Bilinear sample of a surface grid at world (x, y); NULL_VALUE when
 * outside the extent or when any support node that actually
 * CONTRIBUTES (bilinear weight > 0) is null — so a sample landing
 * exactly on a live node beside a null hole keeps that node's value,
 * while anything genuinely between live and null stays null (no
 * invented values across holes or edges).
 * @param {{nx, ny, x0, y0, dx, dy, z: Float32Array}} g
 */
export function sampleSurfaceAt(g, x, y) {
  const u = (x - g.x0) / g.dx;
  const v = (y - g.y0) / g.dy;
  if (u < 0 || v < 0 || u > g.nx - 1 || v > g.ny - 1) return NULL_VALUE;
  const c0 = Math.min(Math.floor(u), g.nx - 2);
  const r0 = Math.min(Math.floor(v), g.ny - 2);
  const fu = u - c0;
  const fv = v - r0;
  const corners = [
    [g.z[r0 * g.nx + c0], (1 - fu) * (1 - fv)],
    [g.z[r0 * g.nx + c0 + 1], fu * (1 - fv)],
    [g.z[(r0 + 1) * g.nx + c0], (1 - fu) * fv],
    [g.z[(r0 + 1) * g.nx + c0 + 1], fu * fv],
  ];
  let sum = 0;
  for (const [z, w] of corners) {
    if (w <= W_EPS) continue;
    if (isNull(z)) return NULL_VALUE;
    sum += z * w;
  }
  return sum;
}

/**
 * Resample a surface onto the volume lattice.
 * @param {{nx, ny, x0, y0, dx, dy, z: Float32Array}} g surface grid
 * @param {Object} affine survey affine (surveyAffine(geometry))
 * @param {{nIl: number, nXl: number}} geom
 * @returns {{values: Float32Array, live: number}} nIl x nXl values in
 *   the surface's own units/sign; 1e30 nulls
 */
export function latticeSampleSurface(g, affine, geom) {
  if (!affine?.origin) throw new Error('Volume has no usable survey coordinates.');
  const values = new Float32Array(geom.nIl * geom.nXl);
  let live = 0;
  for (let i = 0; i < geom.nIl; i++) {
    for (let j = 0; j < geom.nXl; j++) {
      const w = ilxlToWorld(affine, i, j);
      const v = sampleSurfaceAt(g, w.x, w.y);
      if (isNull(v)) {
        values[i * geom.nXl + j] = NULL_F32;
      } else {
        values[i * geom.nXl + j] = v;
        live += 1;
      }
    }
  }
  return { values, live };
}
