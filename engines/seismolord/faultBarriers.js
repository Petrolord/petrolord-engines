// Fault barriers for gridding: where a fault cuts a horizon, gridding
// must not interpolate across it (TPS is global — without barriers the
// throw smears into a ramp).
//
// Pipeline (all in horizon-lattice index space, i = inline index,
// j = crossline index, s = sub-sample time increasing downward):
//   1. each fault stick is intersected with the horizon's pick grid
//      (null-aware bilinear sampling along the stick polyline);
//   2. crossings in STORED stick order form the fault's trace polyline —
//      the same order the 3D ribbon lofts, so 2D barriers and the 3D
//      surface can't disagree about fault topology;
//   3. traces rasterize onto the lattice as 4-CONNECTED barrier chains
//      (diagonal chains would leak a 4-connected flood fill);
//   4. flood fill labels the remaining cells into fault blocks.
//
// Pure math, worker-safe, no I/O. Nulls are 1.0E+30 (playbook) and
// never enter interpolation.

import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * Null-aware bilinear sample of a horizon pick grid at continuous
 * lattice coordinates. Live neighbours are weight-renormalized so a
 * hole edge degrades gracefully instead of pulling toward 1e30.
 *
 * @param {Float32Array} picks nIl x nXl sample indices, 1e30 nulls
 * @param {{nIl:number, nXl:number}} geom
 * @param {number} i inline index (continuous)
 * @param {number} j crossline index (continuous)
 * @returns {number|null} sub-sample horizon position, null in a hole
 */
export function horizonSampleAt(picks, geom, i, j) {
  const { nIl, nXl } = geom;
  const i0 = Math.max(0, Math.min(nIl - 1, Math.floor(i)));
  const j0 = Math.max(0, Math.min(nXl - 1, Math.floor(j)));
  const i1 = Math.min(nIl - 1, i0 + 1);
  const j1 = Math.min(nXl - 1, j0 + 1);
  const fi = Math.max(0, Math.min(1, i - i0));
  const fj = Math.max(0, Math.min(1, j - j0));
  let sum = 0;
  let wsum = 0;
  const add = (ii, jj, w) => {
    if (w <= 0) return;
    const v = picks[ii * nXl + jj];
    if (v === NULL_F32) return;
    sum += w * v;
    wsum += w;
  };
  add(i0, j0, (1 - fi) * (1 - fj));
  add(i0, j1, (1 - fi) * fj);
  add(i1, j0, fi * (1 - fj));
  add(i1, j1, fi * fj);
  return wsum > 0 ? sum / wsum : null;
}

/**
 * Where a fault stick crosses the horizon: walk the stick polyline and
 * find the first sign change of (stick s − horizon s). Segments with a
 * null horizon at either end are skipped (no invented crossings inside
 * holes).
 *
 * @param {{points:{il:number,xl:number,s:number}[]}|Array} stick
 * @param {Float32Array} picks @param {{nIl:number,nXl:number}} geom
 * @returns {{i:number, j:number}|null} lattice-space crossing point
 */
export function stickCrossing(stick, picks, geom) {
  const pts = stick.points || stick;
  if (!pts || pts.length === 0) return null;
  let prev = null; // {il, xl, d}
  for (const p of pts) {
    const h = horizonSampleAt(picks, geom, p.il, p.xl);
    if (h === null) { prev = null; continue; }
    const d = p.s - h;
    if (d === 0) return { i: p.il, j: p.xl };
    if (prev && (d > 0) !== (prev.d > 0)) {
      const t = prev.d / (prev.d - d);
      return {
        i: prev.il + t * (p.il - prev.il),
        j: prev.xl + t * (p.xl - prev.xl),
      };
    }
    prev = { il: p.il, xl: p.xl, d };
  }
  return null;
}

/**
 * Horizon-level trace polylines, one per fault that yields at least two
 * stick crossings (a single crossing is a point — no barrier direction).
 * @param {Array<{sticks:Array}>} faults
 * @returns {Array<Array<{i:number, j:number}>>}
 */
export function faultTraces(faults, picks, geom) {
  const traces = [];
  for (const f of faults || []) {
    const trace = [];
    for (const stick of f.sticks || []) {
      const c = stickCrossing(stick, picks, geom);
      if (c) trace.push(c);
    }
    if (trace.length >= 2) traces.push(trace);
  }
  return traces;
}

/** Mark a segment's cells 4-connectedly (substeps small enough that a
 * step moves at most one cell per axis; diagonal steps get a bridging
 * cell so the chain never has a diagonal gap a flood fill could leak
 * through). */
function markSegment(mask, nIl, nXl, a, b) {
  const clampI = (v) => Math.max(0, Math.min(nIl - 1, v));
  const clampJ = (v) => Math.max(0, Math.min(nXl - 1, v));
  const span = Math.max(Math.abs(b.i - a.i), Math.abs(b.j - a.j));
  const steps = Math.max(1, Math.ceil(span / 0.4));
  let pi = null;
  let pj = null;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const ci = clampI(Math.round(a.i + t * (b.i - a.i)));
    const cj = clampJ(Math.round(a.j + t * (b.j - a.j)));
    if (pi !== null && ci !== pi && cj !== pj) {
      mask[ci * nXl + pj] = 1; // bridge the diagonal step
    }
    mask[ci * nXl + cj] = 1;
    pi = ci;
    pj = cj;
  }
}

/**
 * Rasterize trace polylines onto the lattice.
 * @returns {Uint8Array} nIl x nXl, 1 = barrier cell
 */
export function rasterizeTraces(traces, nIl, nXl) {
  const mask = new Uint8Array(nIl * nXl);
  for (const trace of traces) {
    for (let k = 1; k < trace.length; k++) {
      markSegment(mask, nIl, nXl, trace[k - 1], trace[k]);
    }
  }
  return mask;
}

/**
 * Label fault blocks: 4-connected flood fill over non-barrier cells.
 * @param {Uint8Array} mask barrier mask (rasterizeTraces)
 * @returns {{labels: Int32Array, count: number}} labels are 0..count-1,
 *   -1 on barrier cells
 */
export function labelBlocks(mask, nIl, nXl) {
  const n = nIl * nXl;
  const labels = new Int32Array(n).fill(-2);
  for (let k = 0; k < n; k++) if (mask[k]) labels[k] = -1;
  const stack = new Int32Array(n);
  let count = 0;
  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] !== -2) continue;
    const label = count++;
    let top = 0;
    stack[top++] = seed;
    labels[seed] = label;
    while (top > 0) {
      const c = stack[--top];
      const ci = Math.floor(c / nXl);
      const cj = c - ci * nXl;
      if (ci > 0 && labels[c - nXl] === -2) { labels[c - nXl] = label; stack[top++] = c - nXl; }
      if (ci < nIl - 1 && labels[c + nXl] === -2) { labels[c + nXl] = label; stack[top++] = c + nXl; }
      if (cj > 0 && labels[c - 1] === -2) { labels[c - 1] = label; stack[top++] = c - 1; }
      if (cj < nXl - 1 && labels[c + 1] === -2) { labels[c + 1] = label; stack[top++] = c + 1; }
    }
  }
  return { labels, count };
}

/**
 * Convenience: faults + horizon picks -> block labeling, or null when no
 * fault yields a usable trace (callers then grid exactly as before).
 * @returns {{labels: Int32Array, count: number, traces: Array,
 *   barrierCells: number}|null}
 */
export function buildFaultBlocks(faults, picks, geom) {
  const traces = faultTraces(faults, picks, geom);
  if (traces.length === 0) return null;
  const mask = rasterizeTraces(traces, geom.nIl, geom.nXl);
  const { labels, count } = labelBlocks(mask, geom.nIl, geom.nXl);
  let barrierCells = 0;
  for (let k = 0; k < mask.length; k++) barrierCells += mask[k];
  return { labels, count, traces, barrierCells };
}
