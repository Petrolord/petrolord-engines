// Isopach: true stratigraphic thickness (Mapping & Surface Studio
// upgrade U2-009, 2026-09-30).
//
// An isochore is the VERTICAL thickness between two surfaces (TVT, top
// elevation minus base elevation). An isopach is the thickness measured
// perpendicular to bedding (TST). For a layer whose bedding dips at
// angle theta,
//
//   TST = TVT * cos(theta)
//
// (Tearpock & Bischke, Applied Subsurface Geological Mapping, on
// isochore and isopach maps; Surfer's isopach help states the same
// cosine rule). The relation is exact for parallel bedding and is the
// standard mapping approximation otherwise. The dip is taken from the
// gradient of a reference surface: the mid-surface of top and base by
// default (the bedding inside the layer), or the top or the base.
// tan(theta) = |grad z|, with z and the node spacing in the SAME length
// unit: pass xyToM (metres per map unit) with z in metres.
// Central differences where both neighbours are live, one-sided at an
// edge or a null, and the node is null when it has no live neighbour
// along an axis. Rotation does not change |grad z| (the grid axes stay
// orthogonal). Pure math, no I/O.

import { NULL_VALUE } from './numeric';
import { isNull } from './gridmath';

const outArray = (like, length) =>
  new (ArrayBuffer.isView(like) ? like.constructor : Float64Array)(length);

/**
 * Dip angle in degrees at every node of an elevation grid.
 * @param {ArrayLike<number>} z elevation (or depth) in metres
 * @param {{dx:number,dy:number,nx:number,ny:number}} spec
 * @param {{xyToM?:number}} [o] metres per map unit (1 for a metric frame)
 */
export function dipGrid(z, spec, { xyToM = 1 } = {}) {
  if (!(xyToM > 0) || !Number.isFinite(xyToM)) throw new Error('The dip needs the map in a projected frame (metres per map unit).');
  const { nx, ny } = spec;
  const hx = Math.abs(spec.dx) * xyToM;
  const hy = Math.abs(spec.dy) * xyToM;
  const out = outArray(z, nx * ny);
  const at = (r, c) => z[r * nx + c];
  const slope = (r, c, dr, dc, h) => {
    const i = r * nx + c;
    const r0 = r - dr; const c0 = c - dc; const r1 = r + dr; const c1 = c + dc;
    const ok0 = r0 >= 0 && c0 >= 0 && !isNull(at(r0, c0));
    const ok1 = r1 < ny && c1 < nx && !isNull(at(r1, c1));
    if (ok0 && ok1) return (at(r1, c1) - at(r0, c0)) / (2 * h);
    if (ok1) return (at(r1, c1) - z[i]) / h;
    if (ok0) return (z[i] - at(r0, c0)) / h;
    return NaN;
  };
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (isNull(z[i])) { out[i] = NULL_VALUE; continue; }
      const gx = nx > 1 ? slope(r, c, 0, 1, hx) : 0;
      const gy = ny > 1 ? slope(r, c, 1, 0, hy) : 0;
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) { out[i] = NULL_VALUE; continue; }
      out[i] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    }
  }
  return out;
}

/**
 * True stratigraphic thickness between two ELEVATION grids on one frame
 * (the geo_surfaces convention, metres, negative below datum).
 * @param {ArrayLike<number>} zTop @param {ArrayLike<number>} zBase
 * @param {{dx,dy,nx,ny}} spec
 * @param {{xyToM?:number, dipFrom?:'mid'|'top'|'base'}} [o]
 * @returns {{tst: ArrayLike<number>, tvt: ArrayLike<number>, dip: ArrayLike<number>,
 *   negative: number, maxDipDeg: number|null}}
 *   negative counts nodes where the base is above the top (TVT < 0):
 *   they are nulled in tst and tvt, never reported as thickness.
 */
export function isopach(zTop, zBase, spec, { xyToM = 1, dipFrom = 'mid' } = {}) {
  const n = spec.nx * spec.ny;
  if (zTop.length !== n || zBase.length !== n) throw new Error('Top and base must share one grid frame: resample first.');
  if (!['mid', 'top', 'base'].includes(dipFrom)) throw new Error(`Unknown dip reference "${dipFrom}" (expected mid, top or base).`);
  let ref = zTop;
  if (dipFrom === 'base') ref = zBase;
  if (dipFrom === 'mid') {
    ref = outArray(zTop, n);
    for (let i = 0; i < n; i++) ref[i] = isNull(zTop[i]) || isNull(zBase[i]) ? NULL_VALUE : (zTop[i] + zBase[i]) / 2;
  }
  const dip = dipGrid(ref, spec, { xyToM });
  const tst = outArray(zTop, n);
  const tvt = outArray(zTop, n);
  let negative = 0; let maxDipDeg = null;
  for (let i = 0; i < n; i++) {
    if (isNull(zTop[i]) || isNull(zBase[i]) || isNull(dip[i])) { tst[i] = NULL_VALUE; tvt[i] = NULL_VALUE; continue; }
    const t = zTop[i] - zBase[i];
    if (t < 0) { negative += 1; tst[i] = NULL_VALUE; tvt[i] = NULL_VALUE; continue; }
    tvt[i] = t;
    tst[i] = t * Math.cos((dip[i] * Math.PI) / 180);
    if (maxDipDeg == null || dip[i] > maxDipDeg) maxDipDeg = dip[i];
  }
  return { tst, tvt, dip, negative, maxDipDeg };
}
