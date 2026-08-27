// Trajectory -> grid connections (S4). Pure geometry: walk a wellbore
// path polyline through the block-centred grid emitGrid describes and
// return the ordered, merged list of penetrated cells for COMPDAT.
//
// Frame: grid-local feet. x grows with I from the (i=1, j=1) cell's
// outer corner at x=0, y grows with J from y=0, depth is positive down
// in the same datum as TOPS. The caller (Suite adapter) converts survey
// units and places the wellhead in this frame; minimum-curvature path
// densification also happens there (drilling surveyMath.resample) — this
// module treats consecutive path points as straight segments and
// subsamples them finely enough that no cell face is stepped over.
import { columnInterfaces, gridDepthRange } from './emitGrid.js';

function perLayerDzMin(grid) {
  return grid.layers.reduce((m, l) => Math.min(m, Number(l.dz)), Infinity);
}

/** Cell index (1-based) for a point, or null when outside the grid
 *  areally or vertically (above the local top / below the local base). */
export function cellAtPoint(grid, pt) {
  const { nx, ny, nz, dx, dy } = grid;
  const i = Math.floor(pt.x / dx) + 1;
  const j = Math.floor(pt.y / dy) + 1;
  if (i < 1 || i > nx || j < 1 || j > ny) return null;
  const ifc = columnInterfaces(grid, i, j);
  if (pt.depth < ifc[0] || pt.depth >= ifc[nz]) return null;
  let k = 1;
  while (k < nz && pt.depth >= ifc[k]) k += 1;
  return { i, j, k };
}

/**
 * path: [{x, y, depth}] ft in the grid frame, ordered downhole. Returns
 * connections [{i, j, k, lengthFt, dir}] — one entry per penetrated
 * cell in first-traversal order, lengths summed over re-entries, dir the
 * dominant traversal axis ('X' | 'Y' | 'Z') for COMPDAT item 13.
 */
export function connectionsFromPath(path, grid) {
  if (!Array.isArray(path) || path.length < 2) {
    throw new Error('connectionsFromPath: path needs at least 2 points');
  }
  path.forEach((p, idx) => {
    [p?.x, p?.y, p?.depth].forEach((v) => {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`connectionsFromPath: path[${idx}] needs finite x/y/depth`);
      }
    });
  });
  gridDepthRange(grid); // validates tops/layers up front

  const step = Math.max(0.5, Math.min(grid.dx, grid.dy, perLayerDzMin(grid)) / 4);
  const byCell = new Map();
  const order = [];

  for (let s = 0; s < path.length - 1; s += 1) {
    const a = path[s];
    const b = path[s + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.depth - a.depth);
    if (!(segLen > 0)) continue;
    const nSub = Math.max(1, Math.ceil(segLen / step));
    for (let q = 0; q < nSub; q += 1) {
      const t0 = q / nSub;
      const t1 = (q + 1) / nSub;
      const mid = {
        x: a.x + ((b.x - a.x) * (t0 + t1)) / 2,
        y: a.y + ((b.y - a.y) * (t0 + t1)) / 2,
        depth: a.depth + ((b.depth - a.depth) * (t0 + t1)) / 2,
      };
      const cell = cellAtPoint(grid, mid);
      if (!cell) continue;
      const key = `${cell.i},${cell.j},${cell.k}`;
      const dl = segLen / nSub;
      let entry = byCell.get(key);
      if (!entry) {
        entry = { ...cell, lengthFt: 0, ax: 0, ay: 0, az: 0 };
        byCell.set(key, entry);
        order.push(key);
      }
      entry.lengthFt += dl;
      entry.ax += (Math.abs(b.x - a.x) * dl) / segLen;
      entry.ay += (Math.abs(b.y - a.y) * dl) / segLen;
      entry.az += (Math.abs(b.depth - a.depth) * dl) / segLen;
    }
  }

  return order.map((key) => {
    const e = byCell.get(key);
    const dir = e.az >= e.ax && e.az >= e.ay ? 'Z' : (e.ax >= e.ay ? 'X' : 'Y');
    return {
      i: e.i, j: e.j, k: e.k,
      lengthFt: Math.round(e.lengthFt * 100) / 100,
      dir,
    };
  });
}

/** Areal center of cell (i, j) in the grid frame — wellhead placement
 *  helpers for the Suite UI. */
export function cellCenterXY(grid, i, j) {
  return { x: (i - 0.5) * grid.dx, y: (j - 0.5) * grid.dy };
}
