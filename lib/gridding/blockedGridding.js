// Fault blocks for every gridding method (Mapping & Surface Studio
// upgrade U2-001, 2026-09-30).
//
// gridSurfaceBlocked (gridding.js) honours fault blocks with the
// thin-plate spline: each block's control points build their own
// surface and each node is evaluated only against its own block, so a
// throw stays a step at the fault instead of smearing into a ramp. This
// module gives the spline in tension and ordinary kriging the same
// rule, through the gridders' own `nodeMask` option: the block's points
// are gridded on the block's nodes only, and the blocks are stitched.
// Nothing is re-implemented here; the per-block result IS the validated
// gridder's output (tensionSpline.js, kriging.js oracles).
//
// Conventions (the gridSurfaceBlocked contract):
// - control points carry `block`; block < 0 (a barrier) is dropped;
// - nodeBlocks gives a block id per output node (r * nx + c); -1 is on a
//   barrier and stays null;
// - a block with too few control points for the method is left empty
//   and counted in skippedBlocks, never filled from a neighbour;
// - within a block there is no hull mask: the block extends its trend up
//   to the fault (the barrier labels are the boundary authority), gated
//   by maxExtrapolation from the block's own points.
// Pure math, worker-safe, no I/O.

import { NULL_VALUE } from './numeric';
import { gridTensionSpline } from './tensionSpline';
import { krigeSurface } from './kriging';

const NULL_F32 = Math.fround(NULL_VALUE);

const MIN_POINTS = Object.freeze({ tension: 3, kriging: 2 });

/**
 * @param {'tension'|'kriging'} method
 * @param {{x:number,y:number,z:number,block:number}[]} rawPoints
 * @param {{x0,y0,dx,dy,nx,ny,rotation_deg?}} spec
 * @param {{nodeBlocks: ArrayLike<number>, maxExtrapolation?: number}} opts
 *   plus the method's own options (tension, smoothing; variogram, detrend,
 *   neighbours). The variogram is shared by every block (fit it from all
 *   the points before calling); a detrend plane is fitted per block.
 * @returns {{z: Float32Array, variance: Float32Array|null, live: number,
 *   controlCount: number, dropped: number, zMin: number|null, zMax: number|null,
 *   blockCount: number, skippedBlocks: number, blocks: Array<{block:number, points:number, live:number}>}}
 */
export function gridBlocked(method, rawPoints, spec, opts = {}) {
  if (!(method in MIN_POINTS)) throw new Error(`Fault blocks are available for tension and kriging here; got "${method}".`);
  const { nodeBlocks, maxExtrapolation = Infinity, ...methodOpts } = opts;
  const { nx, ny } = spec;
  if (!nodeBlocks || nodeBlocks.length !== nx * ny) throw new Error('Blocked gridding needs a block id per output node.');
  const clean = (rawPoints || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)
    && Number.isFinite(p.z) && Math.abs(p.z) < 1.0e29 && Number.isInteger(p.block) && p.block >= 0);
  if (clean.length < 3) throw new Error('Gridding needs at least 3 control points.');
  const byBlock = new Map();
  for (const p of clean) {
    const arr = byBlock.get(p.block);
    if (arr) arr.push(p); else byBlock.set(p.block, [p]);
  }

  const z = new Float32Array(nx * ny).fill(NULL_F32);
  const variance = method === 'kriging' ? new Float32Array(nx * ny).fill(NULL_F32) : null;
  const mask = new Uint8Array(nx * ny);
  let live = 0; let controlCount = 0; let dropped = 0; let skippedBlocks = 0;
  let zMin = Infinity; let zMax = -Infinity;
  const blocks = [];
  for (const [block, pts] of [...byBlock].sort((a, b) => a[0] - b[0])) {
    if (pts.length < MIN_POINTS[method]) { skippedBlocks += 1; blocks.push({ block, points: pts.length, live: 0 }); continue; }
    let any = false;
    for (let i = 0; i < mask.length; i++) { mask[i] = nodeBlocks[i] === block ? 1 : 0; if (mask[i]) any = true; }
    if (!any) { blocks.push({ block, points: pts.length, live: 0 }); continue; }
    let g;
    try {
      g = method === 'tension'
        ? gridTensionSpline(pts, spec, { ...methodOpts, mask: 'none', maxExtrapolation, nodeMask: mask })
        : krigeSurface(pts, spec, { ...methodOpts, mask: 'none', maxExtrapolation, nodeMask: mask });
    } catch {
      skippedBlocks += 1; // collinear or coincident block: its nodes stay null
      blocks.push({ block, points: pts.length, live: 0 });
      continue;
    }
    controlCount += g.controlCount;
    dropped += g.dropped || 0;
    let bl = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const v = g.z[i];
      if (!Number.isFinite(v) || Math.abs(v) >= 1e29) continue;
      z[i] = v;
      if (variance) variance[i] = g.variance[i];
      if (v < zMin) zMin = v;
      if (v > zMax) zMax = v;
      bl += 1;
    }
    live += bl;
    blocks.push({ block, points: pts.length, live: bl });
  }
  const blockCount = blocks.filter((b) => b.live > 0).length;
  return {
    z, variance, live, controlCount, dropped,
    zMin: live ? zMin : null, zMax: live ? zMax : null,
    blockCount, skippedBlocks, blocks,
  };
}
