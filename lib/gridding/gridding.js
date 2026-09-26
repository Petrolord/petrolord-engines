// Surface gridding (Phase 4): thin-plate spline interpolation of
// scattered picks onto a regular grid, masked to the convex hull of the
// control points plus a maximum extrapolation distance. Nodes outside
// the mask are NULL_VALUE — the playbook null that propagates and never
// enters statistics or sums.
//
// Pure math, worker-safe, no I/O. Column/row order conventions live in
// surfaceExport.js, not here: this module's grid is z[row * nx + col]
// with row 0 at the minimum Y (south) — matching the oracle's model.

import { NULL_VALUE } from './numeric';

const NULL_F32 = Math.fround(NULL_VALUE);

/** TPS radial basis U(r) = r^2 log r^2 (0 at r = 0). */
const tpsU = (r2) => (r2 > 0 ? r2 * Math.log(r2) : 0);

/**
 * Dense Gaussian elimination with partial pivoting. A is n x n (row
 * major, mutated), b length n (mutated); returns the solution in b.
 */
function solveDense(A, b, n) {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (best < 1e-12) throw new Error('Gridding system is singular — control points may be collinear or duplicated.');
    if (pivot !== col) {
      for (let c = col; c < n; c++) {
        const t = A[col * n + c];
        A[col * n + c] = A[pivot * n + c];
        A[pivot * n + c] = t;
      }
      const t = b[col]; b[col] = b[pivot]; b[pivot] = t;
    }
    const inv = 1 / A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * b[c];
    b[r] = s / A[r * n + r];
  }
  return b;
}

/**
 * Thin the control set to at most maxControl points by keeping one point
 * per cell of a coarse grid (dense TPS is O(N^3); beyond ~1000 points the
 * decimated fit is indistinguishable at seismic pick density).
 * @returns {{points: Array, dropped: number}}
 */
export function decimateControls(points, maxControl) {
  if (points.length <= maxControl) return { points, dropped: 0 };
  let xmin = Infinity; let xmax = -Infinity; let ymin = Infinity; let ymax = -Infinity;
  for (const p of points) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  const cells = Math.ceil(Math.sqrt(maxControl));
  const cw = (xmax - xmin) / cells || 1;
  const ch = (ymax - ymin) / cells || 1;
  const byCell = new Map();
  for (const p of points) {
    const key = `${Math.min(cells - 1, Math.floor((p.x - xmin) / cw))}:`
      + `${Math.min(cells - 1, Math.floor((p.y - ymin) / ch))}`;
    if (!byCell.has(key)) byCell.set(key, p);
  }
  const kept = [...byCell.values()];
  return { points: kept, dropped: points.length - kept.length };
}

/**
 * Merge control points closer together than `tol` (world units) into one
 * point at their mean position and mean value (Mapping T1 MAP-T1-003).
 *
 * An exact interpolant (TPS) through two points at the same place with
 * different values is singular, and through two points a few metres apart
 * with slightly different values it overshoots into a bullseye: a pilot
 * hole and its sidetrack 5 m apart with tops 3 m different put a false
 * crest 13 m above the truth. Clusters are single-linkage (a chain of
 * points each within tol of the next is one cluster), found with a
 * union-find over a tol-sized hash grid.
 *
 * @param {Array<{x:number,y:number,z:number,well?:string}>} points
 * @param {number} tol merge distance, >= 0 (0 merges exact duplicates only)
 * @returns {{points:Array, merged:Array<{wells:string[], n:number, x:number,
 *   y:number, z:number, spreadZ:number}>}} merged lists only the clusters
 *   of two or more; each output point of a cluster carries `wells` and
 *   `merged: n`, and `well` joined with " + "
 */
export function mergeCloseControls(points, tol) {
  if (!(tol >= 0) || !Number.isFinite(tol)) throw new Error('The merge distance must be zero or more.');
  const n = points.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => { let k = i; while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const unite = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const cell = tol > 0 ? tol : 1;
  const key = (cx, cy) => `${cx}:${cy}`;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(points[i].x / cell);
    const cy = Math.floor(points[i].y / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const b = buckets.get(key(cx + ox, cy + oy));
        if (!b) continue;
        for (const j of b) {
          if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) <= tol) unite(i, j);
        }
      }
    }
    const k = key(cx, cy);
    if (buckets.has(k)) buckets.get(k).push(i); else buckets.set(k, [i]);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (groups.has(r)) groups.get(r).push(i); else groups.set(r, [i]);
  }
  const out = [];
  const merged = [];
  for (const idx of [...groups.values()].sort((a, b) => a[0] - b[0])) {
    if (idx.length === 1) { out.push(points[idx[0]]); continue; }
    let sx = 0; let sy = 0; let sz = 0; let zmin = Infinity; let zmax = -Infinity;
    for (const i of idx) {
      sx += points[i].x; sy += points[i].y; sz += points[i].z;
      zmin = Math.min(zmin, points[i].z); zmax = Math.max(zmax, points[i].z);
    }
    const wells = idx.map((i) => (points[i].well != null ? String(points[i].well) : `#${i}`));
    const m = { x: sx / idx.length, y: sy / idx.length, z: sz / idx.length };
    out.push({ ...points[idx[0]], ...m, well: wells.join(' + '), wells, merged: idx.length });
    merged.push({ wells, n: idx.length, ...m, spreadZ: zmax - zmin });
  }
  return { points: out, merged };
}

/** Andrew monotone-chain convex hull; returns hull vertices CCW. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export const insideHull = (hull, x, y) => {
  // CCW hull: point is inside iff it is left of (or on) every edge
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
};

/**
 * Fit a thin-plate spline to control points.
 * @param {{x:number,y:number,z:number}[]} points
 * @returns {(x: number, y: number) => number}
 */
export function fitTps(points) {
  const n = points.length;
  if (n < 3) throw new Error('Gridding needs at least 3 control points.');
  const m = n + 3;
  const A = new Float64Array(m * m);
  const b = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const pi = points[i];
    for (let j = 0; j < n; j++) {
      const dx = pi.x - points[j].x;
      const dy = pi.y - points[j].y;
      A[i * m + j] = tpsU(dx * dx + dy * dy);
    }
    A[i * m + n] = 1;
    A[i * m + n + 1] = pi.x;
    A[i * m + n + 2] = pi.y;
    A[(n) * m + i] = 1;
    A[(n + 1) * m + i] = pi.x;
    A[(n + 2) * m + i] = pi.y;
    b[i] = pi.z;
  }
  const sol = solveDense(A, b, m);
  const w = sol.slice(0, n);
  const [a0, ax, ay] = [sol[n], sol[n + 1], sol[n + 2]];
  return (x, y) => {
    let s = a0 + ax * x + ay * y;
    for (let i = 0; i < n; i++) {
      const dx = x - points[i].x;
      const dy = y - points[i].y;
      s += w[i] * tpsU(dx * dx + dy * dy);
    }
    return s;
  };
}

/**
 * Grid scattered points with TPS + hull/extrapolation masking.
 *
 * @param {{x:number,y:number,z:number}[]} rawPoints
 * @param {{x0:number,y0:number,dx:number,dy:number,nx:number,ny:number}} spec
 * @param {{maxControl?: number, maxExtrapolation?: number,
 *          onProgress?: (done:number,total:number)=>void}} [opts]
 *   maxExtrapolation: nodes farther than this from every control point
 *   are nulled even inside the hull (default 2 grid cells).
 *   mask: 'hull' (default) nulls every node outside the convex hull of
 *   the control points; 'none' evaluates every node of the spec (subject
 *   to maxExtrapolation), so a caller can map the flanks beyond the
 *   outermost wells and clip with its own polygon (Mapping T1 MAP-T1-007).
 * @returns {{z: Float32Array, live: number, controlCount: number,
 *            dropped: number, zMin: number|null, zMax: number|null}}
 */
export function gridSurface(rawPoints, spec, opts = {}) {
  const {
    maxControl = 700,
    maxExtrapolation = 2 * Math.max(spec.dx, spec.dy),
    mask = 'hull',
    onProgress,
  } = opts;
  if (mask !== 'hull' && mask !== 'none') throw new Error(`Unknown gridding mask "${mask}" (expected hull or none).`);
  const clean = rawPoints.filter((p) => Number.isFinite(p.z) && Math.abs(p.z) < 1.0e29);
  const { points, dropped } = decimateControls(clean, maxControl);
  const tps = fitTps(points);
  const hull = convexHull(points);
  const maxExtrap2 = maxExtrapolation * maxExtrapolation;

  const { nx, ny } = spec;
  const z = new Float32Array(nx * ny).fill(NULL_F32);
  let live = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  const total = nx * ny;
  for (let r = 0; r < ny; r++) {
    const y = spec.y0 + r * spec.dy;
    for (let c = 0; c < nx; c++) {
      const x = spec.x0 + c * spec.dx;
      if (mask === 'hull' && !insideHull(hull, x, y)) continue;
      let near = false;
      for (let i = 0; i < points.length; i++) {
        const dx = x - points[i].x;
        const dy = y - points[i].y;
        if (dx * dx + dy * dy <= maxExtrap2) { near = true; break; }
      }
      if (!near) continue;
      const v = tps(x, y);
      z[r * nx + c] = v;
      const vf = z[r * nx + c];
      if (vf < zMin) zMin = vf;
      if (vf > zMax) zMax = vf;
      live += 1;
    }
    if (onProgress && r % 8 === 0) onProgress(r * nx, total);
  }
  if (onProgress) onProgress(total, total);
  return {
    z,
    live,
    controlCount: points.length,
    dropped,
    zMin: live ? zMin : null,
    zMax: live ? zMax : null,
  };
}

/**
 * Fault-blocked TPS gridding: control points carry a fault-block id and
 * every output node is evaluated ONLY against its own block's surface,
 * so interpolation never crosses a fault — throw is preserved right up
 * to the barrier instead of smearing into a ramp (TPS extends each
 * block's trend across pick gaps; a planar block stays exactly planar).
 *
 * @param {{x:number,y:number,z:number,block:number}[]} rawPoints
 *   block < 0 (barrier cells) is dropped — picks within half a bin of a
 *   fault are unreliable
 * @param {{x0:number,y0:number,dx:number,dy:number,nx:number,ny:number}} spec
 * @param {{nodeBlocks: Int32Array, maxControl?: number,
 *          maxExtrapolation?: number,
 *          onProgress?: (done:number,total:number)=>void}} opts
 *   nodeBlocks: block id per output node (r * nx + c), -1 = on a
 *   barrier -> null (the standard fault-gap look)
 * @returns {{z: Float32Array, live: number, controlCount: number,
 *            dropped: number, zMin: number|null, zMax: number|null,
 *            blockCount: number, skippedBlocks: number}}
 */
export function gridSurfaceBlocked(rawPoints, spec, opts = {}) {
  const {
    maxControl = 700,
    maxExtrapolation = 2 * Math.max(spec.dx, spec.dy),
    nodeBlocks,
    onProgress,
  } = opts;
  const { nx, ny } = spec;
  if (!nodeBlocks || nodeBlocks.length !== nx * ny) {
    throw new Error('Blocked gridding needs a block id per output node.');
  }
  const clean = rawPoints.filter((p) =>
    Number.isFinite(p.z) && Math.abs(p.z) < 1.0e29 && p.block >= 0);
  if (clean.length < 3) throw new Error('Gridding needs at least 3 control points.');

  const byBlock = new Map();
  for (const p of clean) {
    const arr = byBlock.get(p.block);
    if (arr) arr.push(p); else byBlock.set(p.block, [p]);
  }

  // one TPS + hull per block; the decimation budget is split by point
  // share so the total solve cost stays at or below the unblocked cost
  const models = new Map();
  let controlCount = 0;
  let dropped = 0;
  let skippedBlocks = 0;
  for (const [block, pts] of byBlock) {
    if (pts.length < 3) { skippedBlocks += 1; continue; }
    const budget = Math.min(maxControl,
      Math.max(16, Math.floor((maxControl * pts.length) / clean.length)));
    const dec = decimateControls(pts, budget);
    try {
      models.set(block, {
        tps: fitTps(dec.points),
        points: dec.points,
      });
      controlCount += dec.points.length;
      dropped += dec.dropped;
    } catch {
      skippedBlocks += 1; // collinear/degenerate block — null its nodes
    }
  }

  const maxExtrap2 = maxExtrapolation * maxExtrapolation;
  const z = new Float32Array(nx * ny).fill(NULL_F32);
  let live = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  const total = nx * ny;
  for (let r = 0; r < ny; r++) {
    const y = spec.y0 + r * spec.dy;
    for (let c = 0; c < nx; c++) {
      const m = models.get(nodeBlocks[r * nx + c]);
      if (!m) continue;                       // barrier or skipped block
      const x = spec.x0 + c * spec.dx;
      // no hull mask here (unlike gridSurface): a block must extrapolate
      // its trend across the pick gap up to the fault — the barrier
      // labels and the distance gate below are the boundary authority
      let near = false;
      for (let i = 0; i < m.points.length; i++) {
        const dx = x - m.points[i].x;
        const dy = y - m.points[i].y;
        if (dx * dx + dy * dy <= maxExtrap2) { near = true; break; }
      }
      if (!near) continue;
      z[r * nx + c] = m.tps(x, y);
      const vf = z[r * nx + c];
      if (vf < zMin) zMin = vf;
      if (vf > zMax) zMax = vf;
      live += 1;
    }
    if (onProgress && r % 8 === 0) onProgress(r * nx, total);
  }
  if (onProgress) onProgress(total, total);
  return {
    z,
    live,
    controlCount,
    dropped,
    zMin: live ? zMin : null,
    zMax: live ? zMax : null,
    blockCount: models.size,
    skippedBlocks,
  };
}

/**
 * Convert a horizon pick grid to world-coordinate control points.
 *
 * Positions come from the survey affine (world = origin + i*ilVec +
 * j*xlVec), so rotated surveys and rectangular bins map correctly; a
 * legacy corner-fallback affine reproduces the old axis-aligned
 * arithmetic exactly.
 *
 * @param {Float32Array} picks sample indices, nIl x nXl, 1e30 nulls
 * @param {{nIl:number,nXl:number}} geom
 * @param {Object} affine resolved survey affine —
 *   surveyAffine(manifest.geometry)
 * @param {(sample: number, cell?: number) => number} sampleToZ e.g. TWT
 *   ms or depth ft; receives the lattice cell index so column-dependent
 *   conversions (layer-cake velocity models) work
 */
export function picksToPoints(picks, geom, affine, sampleToZ) {
  if (!affine?.origin) throw new Error('Volume has no usable survey coordinates.');
  const out = [];
  for (let i = 0; i < geom.nIl; i++) {
    for (let x = 0; x < geom.nXl; x++) {
      const cell = i * geom.nXl + x;
      const s = picks[cell];
      if (s === NULL_F32) continue;
      out.push({
        x: affine.origin.x + i * affine.ilVec.x + x * affine.xlVec.x,
        y: affine.origin.y + i * affine.ilVec.y + x * affine.xlVec.y,
        z: sampleToZ(s, cell),
      });
    }
  }
  return out;
}

/** Output-grid node ceiling: a mistyped tiny cell must fail with a clear
 *  domain error, not a huge allocation that freezes the tab. */
export const MAX_GRID_NODES = 4_000_000;

/**
 * Build the export grid spec over a survey's world bbox. A non-finite or
 * non-positive cell falls back to the survey bin; a cell that would blow
 * the node ceiling throws with the minimum usable cell in the message.
 *
 * @param {{x0:number,y0:number,x1:number,y1:number}} b world bounds
 * @param {number} cellM requested cell (0 / NaN / negative -> bin)
 * @param {number} bin survey bin size fallback (m)
 * @param {number} [maxNodes]
 */
export function exportGridSpec(b, cellM, bin, maxNodes = MAX_GRID_NODES) {
  const dxy = Number.isFinite(cellM) && cellM > 0 ? cellM : bin;
  const spec = {
    x0: b.x0, y0: b.y0, dx: dxy, dy: dxy,
    nx: Math.floor((b.x1 - b.x0) / dxy) + 1,
    ny: Math.floor((b.y1 - b.y0) / dxy) + 1,
  };
  if (spec.nx * spec.ny > maxNodes) {
    const minCell = Math.sqrt(((b.x1 - b.x0) * (b.y1 - b.y0)) / maxNodes);
    throw new Error(
      `A ${dxy} m cell gives ${spec.nx.toLocaleString()} × ${spec.ny.toLocaleString()} grid nodes `
      + `(over the ${maxNodes.toLocaleString()} ceiling) — use a cell of `
      + `~${Math.ceil(minCell)} m or larger for this survey.`);
  }
  return spec;
}
