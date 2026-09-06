// Section flattening on a horizon (Stratigraphy ST5, 2026-09-06).
//
// A flattened section hangs every trace on a horizon: each trace shifts
// vertically so the horizon's pick sits on one datum sample. The
// renderer applies the shift in the shader (display math, never baked
// into stored data, the playbook rule) and the overlay painter applies
// the same numbers to picks, faults and wells. This module computes the
// per-trace offsets along a section from a horizon's pick lattice, in
// samples: positive moves the trace DOWN the screen. Untracked traces
// get NaN (drawn unshifted and the panel says so).

import { NULL_VALUE } from './manifest';

const NULL_LIM = 1.0e29;

/**
 * Lattice cell of trace `tr` along a section.
 * @param {'inline'|'xline'|'traverse'} ori
 * @param {number} idx inline or crossline index of the section
 * @param {number} tr trace position along the section
 * @param {{nIl: number, nXl: number}} geom
 * @param {?Array<{il: number, xl: number}>} positions traverse positions
 */
export function sectionCell(ori, idx, tr, geom, positions = null) {
  if (ori === 'inline') return idx * geom.nXl + tr;
  if (ori === 'xline') return tr * geom.nXl + idx;
  if (ori === 'traverse') {
    const p = positions?.[tr];
    return p ? p.il * geom.nXl + p.xl : -1;
  }
  return -1;
}

/**
 * Per-trace vertical offsets (samples) that put the horizon on `datum`.
 * @param {Float32Array} grid the horizon's pick lattice (nIl*nXl, samples, NULL where untracked)
 * @param {{nIl: number, nXl: number, ns: number}} geom
 * @param {'inline'|'xline'|'traverse'} ori
 * @param {number} idx
 * @param {number} datum datum sample the horizon is hung on
 * @param {?Array<{il, xl}>} [positions] traverse trace positions
 * @returns {{ offsets: Float32Array, tracked: number, nTraces: number }}
 */
export function flattenOffsets(grid, geom, ori, idx, datum, positions = null) {
  const nTraces = ori === 'inline' ? geom.nXl : ori === 'xline' ? geom.nIl : (positions?.length || 0);
  const offsets = new Float32Array(nTraces).fill(NaN);
  let tracked = 0;
  for (let tr = 0; tr < nTraces; tr++) {
    const cell = sectionCell(ori, idx, tr, geom, positions);
    if (cell < 0) continue;
    const z = grid[cell];
    if (z === undefined || Math.abs(z) > NULL_LIM || !Number.isFinite(z)) continue;
    offsets[tr] = datum - z;
    tracked += 1;
  }
  return { offsets, tracked, nTraces };
}

/**
 * A sensible datum for a horizon on a section: the median tracked pick,
 * so the flattened section sits where the horizon already is; null when
 * nothing is tracked.
 */
export function datumForHorizon(grid, geom, ori, idx, positions = null) {
  const nTraces = ori === 'inline' ? geom.nXl : ori === 'xline' ? geom.nIl : (positions?.length || 0);
  const zs = [];
  for (let tr = 0; tr < nTraces; tr++) {
    const cell = sectionCell(ori, idx, tr, geom, positions);
    if (cell < 0) continue;
    const z = grid[cell];
    if (z === undefined || Math.abs(z) > NULL_LIM || !Number.isFinite(z)) continue;
    zs.push(z);
  }
  if (!zs.length) return null;
  zs.sort((a, b) => a - b);
  return zs[Math.floor(zs.length / 2)];
}

/** Displayed sample of a pick under the offsets (NaN offset = unshifted). */
export const shiftedSample = (z, offset) => (Number.isFinite(offset) ? z + offset : z);

export { NULL_VALUE };
