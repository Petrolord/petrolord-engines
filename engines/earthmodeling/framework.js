// Structural framework (Earth Modeling G8.1): resample an ordered
// stack of structural surfaces onto a common model frame and enforce
// depth-down consistency with the v1 monotonic clamp. Pure functions,
// no I/O; oracle-validated against test-data/earthmodel/goldens.json.
//
// Grid convention (house, src/lib/gridding): z row-major nx*ny,
// z[r*nx + c], world x[c] = x0 + c*dx, y[r] = y0 + r*dy (row 0 =
// south), NULL_VALUE (1e30) marks empty nodes. Model z is TVDSS
// metres, positive down.

import { NULL_VALUE } from '../../lib/gridding/numeric';
import { isNull, resampleTo, isochore } from '../../lib/gridding/gridmath';

/**
 * Resample surfaces (shallow -> deep) onto the model frame.
 * @param {Array<{z: ArrayLike<number>, spec: object}>} surfaces
 * @param {{x0,y0,dx,dy,nx,ny}} modelSpec
 * @returns {Array<Float32Array|Float64Array>} one grid per surface
 */
export function resampleStack(surfaces, modelSpec) {
  if (!Array.isArray(surfaces) || !surfaces.length) {
    throw new Error('A framework needs at least one surface.');
  }
  if (!(modelSpec?.nx > 1) || !(modelSpec?.ny > 1) ||
      !(modelSpec.dx > 0) || !(modelSpec.dy > 0)) {
    throw new Error('Invalid model grid spec.');
  }
  return surfaces.map((s) => resampleTo(s.z, s.spec, modelSpec));
}

/**
 * Depth-down monotonic clamp (v1 stacking rule, plan decision 6).
 * Node-wise: a live node is clamped up to the running max of live
 * nodes above it; null nodes stay null and do not advance the running
 * max. Clamped node counts are surfaced, never silent.
 * @param {Array<Float32Array|Float64Array>} grids shallow -> deep, same frame
 * @returns {{clamped: Array, counts: number[]}}
 */
export function clampStack(grids) {
  if (!grids.length) return { clamped: [], counts: [] };
  const n = grids[0].length;
  for (const g of grids) {
    if (g.length !== n) throw new Error('Framework surfaces must share the model frame.');
  }
  const clamped = grids.map((g) => g.slice());
  const counts = new Array(grids.length).fill(0);
  for (let j = 0; j < n; j++) {
    let run = null;
    for (let i = 0; i < clamped.length; i++) {
      const v = clamped[i][j];
      if (isNull(v)) continue;
      if (run !== null && v < run) {
        clamped[i][j] = run;
        counts[i] += 1;
      }
      run = clamped[i][j];
    }
  }
  return { clamped, counts };
}

/**
 * Zone thickness = base − top (positive down ⇒ thickness ≥ 0 after
 * clamping); null where either surface is null.
 */
export const zoneThickness = (zTop, zBase) => isochore(zBase, zTop);

/**
 * Build the full framework in one call: resample, clamp, and derive
 * the K−1 zone thickness grids between consecutive surfaces.
 * @returns {{grids, clamped, counts, thickness: Array}}
 */
export function buildFramework(surfaces, modelSpec) {
  const grids = resampleStack(surfaces, modelSpec);
  const { clamped, counts } = clampStack(grids);
  const thickness = [];
  for (let i = 0; i + 1 < clamped.length; i++) {
    thickness.push(zoneThickness(clamped[i], clamped[i + 1]));
  }
  return { grids, clamped, counts, thickness };
}

export { NULL_VALUE, isNull };
