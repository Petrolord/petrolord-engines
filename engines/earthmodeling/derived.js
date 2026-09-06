// Derived horizons (Earth Modeling EM2, 2026-09-06): surfaces built
// from other surfaces the way Petrel's "make surface" does. Depth is
// metres positive down on one frame; nulls propagate. Exact closed-form
// arithmetic, validated by analytic jest cases (the Well Correlation
// datum precedent), no Python oracle.

import { NULL_VALUE } from '../../lib/gridding/numeric';
import { isNull } from '../../lib/gridding/gridmath';

const outArray = (like, n) => new (ArrayBuffer.isView(like) ? like.constructor : Float64Array)(n);

/**
 * A surface parallel to `z` at a thickness below it (positive down):
 * a constant, or a thickness grid on the same frame (an isochore).
 * Negative thickness places it above.
 */
export function parallelSurface(z, thickness) {
  const out = outArray(z, z.length);
  const grid = ArrayBuffer.isView(thickness) || Array.isArray(thickness) ? thickness : null;
  if (grid && grid.length !== z.length) throw new Error('The thickness grid must share the surface frame.');
  const k = grid ? null : Number(thickness);
  if (!grid && !Number.isFinite(k)) throw new Error('Parallel surface needs a thickness in metres or a thickness grid.');
  for (let i = 0; i < z.length; i++) {
    const t = grid ? grid[i] : k;
    out[i] = isNull(z[i]) || isNull(t) ? NULL_VALUE : z[i] + t;
  }
  return out;
}

/**
 * A surface a fraction of the way from `zTop` to `zBase` (0 = top,
 * 1 = base, 0.5 = midway), node by node; both must be live.
 */
export function proportionalSurface(zTop, zBase, fraction) {
  if (zTop.length !== zBase.length) throw new Error('Top and base must share a frame.');
  const f = Number(fraction);
  if (!Number.isFinite(f) || f < 0 || f > 1) throw new Error('The fraction must be between 0 (top) and 1 (base).');
  const out = outArray(zTop, zTop.length);
  for (let i = 0; i < zTop.length; i++) {
    out[i] = isNull(zTop[i]) || isNull(zBase[i]) ? NULL_VALUE : zTop[i] + f * (zBase[i] - zTop[i]);
  }
  return out;
}

export const DERIVED_KINDS = Object.freeze([
  { key: 'parallel', label: 'Parallel to a surface at a thickness' },
  { key: 'proportional', label: 'Proportional between two surfaces' },
]);
