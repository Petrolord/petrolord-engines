// Structural closure analysis on a depth grid (Mapping & Surface Studio
// T1 findings MAP-T1-001, -002 and enhancement E1, 2026-09-26).
//
// A gross rock volume above a contact means something only for ONE trap
// that is CLOSED on the map. The old quick GRV summed every node above
// the contact, so two domes counted twice and a contact below the mapped
// area returned the whole map as a volume. This module answers the three
// questions a mapper asks before trusting the number:
//
//   1. Which closures sit above this contact, and is each one closed on
//      the map, or does it run off the map edge / into unmapped nodes?
//   2. Where does the closure spill? A priority flood from the crest
//      (always expanding the highest frontier node) reaches the map
//      boundary for the first time when its running minimum equals the
//      bottleneck (minimax) elevation between the crest and the boundary:
//      that is the spill elevation, and the node that set the running
//      minimum is the spill point. Contacts at or above the spill leave
//      the closure closed; below it the closure is open.
//   3. How do area and GRV grow with the contact (area-depth and
//      GRV-versus-contact curves)? The flood visits the whole component
//      {z > L} that contains the crest before any node at or below L, so
//      every level's closure is a PREFIX of one pop order and the curve
//      costs one flood.
//
// Conventions: z is ELEVATION in metres (higher = shallower, negative
// below datum), row-major z[r*nx + c] on a gridmath spec; null nodes
// (isNull) are unmapped and never part of a closure. Connectivity is
// 4-neighbour (a trap does not leak through a cell corner). The boundary
// of the mapped area is any node on the grid edge or with a null
// 4-neighbour. Volume uses the same midpoint rule as grvAcreFt:
// GRV = sum over closure nodes of (z - contact) * |dx * dy|.

import { isNull, gridXY } from './gridmath';

const cellArea = (spec) => Math.abs(spec.dx * spec.dy);

function neighbours(i, nx, ny) {
  const r = Math.floor(i / nx);
  const c = i - r * nx;
  const out = [];
  if (c > 0) out.push(i - 1);
  if (c < nx - 1) out.push(i + 1);
  if (r > 0) out.push(i - nx);
  if (r < ny - 1) out.push(i + nx);
  return out;
}

/** True when node i touches the edge of the mapped area. */
export function isBoundaryNode(z, spec, i) {
  const { nx, ny } = spec;
  const r = Math.floor(i / nx);
  const c = i - r * nx;
  if (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) return true;
  return isNull(z[i - 1]) || isNull(z[i + 1]) || isNull(z[i - nx]) || isNull(z[i + nx]);
}

const nodeInfo = (z, spec, i) => {
  const r = Math.floor(i / spec.nx);
  const c = i - r * spec.nx;
  const w = gridXY(spec, r, c);
  return { index: i, r, c, x: w.x, y: w.y, z: z[i] };
};

/** Index of the highest live node, or -1 on an empty grid. */
export function crestIndex(z) {
  let best = -1;
  let bz = -Infinity;
  for (let i = 0; i < z.length; i++) {
    if (!isNull(z[i]) && z[i] > bz) { bz = z[i]; best = i; }
  }
  return best;
}

/**
 * Connected closures above a flat contact.
 * @param {ArrayLike<number>} z elevation grid (m)
 * @param {{nx,ny,dx,dy,x0,y0,rotation_deg?}} spec
 * @param {{contact:number}} opts contact elevation (m)
 * @returns {{contact:number, closures:Array<{id:number, crest:object, nodes:number,
 *   areaM2:number, grvM3:number, open:boolean}>}} sorted by crest, highest first
 */
export function closuresAtContact(z, spec, { contact }) {
  if (!Number.isFinite(contact)) throw new Error('Closure analysis needs a contact elevation.');
  const { nx, ny } = spec;
  const n = nx * ny;
  if (z.length !== n) throw new Error('The grid does not match its frame.');
  const label = new Int32Array(n).fill(-1);
  const A = cellArea(spec);
  const closures = [];
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || isNull(z[s]) || !(z[s] > contact)) continue;
    const id = closures.length;
    const stack = [s];
    label[s] = id;
    let nodes = 0; let sum = 0; let open = false; let top = s;
    while (stack.length) {
      const i = stack.pop();
      nodes += 1;
      sum += z[i] - contact;
      if (z[i] > z[top]) top = i;
      if (isBoundaryNode(z, spec, i)) open = true;
      for (const j of neighbours(i, nx, ny)) {
        if (label[j] === -1 && !isNull(z[j]) && z[j] > contact) { label[j] = id; stack.push(j); }
      }
    }
    closures.push({ id, crest: nodeInfo(z, spec, top), nodes, areaM2: nodes * A, grvM3: sum * A, open });
  }
  closures.sort((a, b) => b.crest.z - a.crest.z);
  return { contact, closures, label };
}

// Max-heap on z of node indices.
function makeHeap(z) {
  const h = [];
  const up = (k) => {
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (z[h[p]] >= z[h[k]]) break;
      [h[p], h[k]] = [h[k], h[p]];
      k = p;
    }
  };
  const down = (k) => {
    for (;;) {
      const l = 2 * k + 1; const r = l + 1;
      let m = k;
      if (l < h.length && z[h[l]] > z[h[m]]) m = l;
      if (r < h.length && z[h[r]] > z[h[m]]) m = r;
      if (m === k) break;
      [h[m], h[k]] = [h[k], h[m]];
      k = m;
    }
  };
  return {
    push(i) { h.push(i); up(h.length - 1); },
    pop() { const t = h[0]; const last = h.pop(); if (h.length) { h[0] = last; down(0); } return t; },
    get size() { return h.length; },
  };
}

/**
 * Spill point and closure curve of the trap whose crest is `seed` (a node
 * index, or the highest live node when omitted).
 *
 * @param {{seed?:number, minRelief?:number}} [opts] minRelief: a merge with
 *   a neighbouring culmination is reported only when that culmination
 *   rises at least this far above the saddle (default 0: every climb),
 *   so single-node bumps on a noisy flank can be ignored
 * @returns {{crest:object, spillZ:number, spill:object, limitedByEdge:boolean,
 *   merges:Array<{saddleZ:number, saddle:object, culminationZ:number, relief:number}>,
 *   order:Int32Array, runMin:Float64Array, prefixSum:Float64Array}}
 *   merges: shallow to deep, the levels at which the crest's closure joins
 *   another culmination before it spills off the map (fill-spill: filled
 *   below that saddle, the trap is one accumulation with its neighbour).
 *   limitedByEdge: the lowest point on the escape path is itself on the
 *   edge of the mapped area, so the true spill may lie deeper, off the map.
 *   order/runMin/prefixSum: the flood's pop order up to (not including)
 *   the first boundary node, with the running minimum and the running sum
 *   of z, which closureCurve reads.
 */
export function spillAnalysis(z, spec, { seed = null, minRelief = 0 } = {}) {
  const { nx, ny } = spec;
  if (z.length !== nx * ny) throw new Error('The grid does not match its frame.');
  const start = seed === null ? crestIndex(z) : seed;
  if (start < 0 || isNull(z[start])) throw new Error('The closure needs a mapped crest node.');
  const heap = makeHeap(z);
  const seen = new Uint8Array(nx * ny);
  const from = new Int32Array(nx * ny).fill(-1); // the node that pushed each node
  heap.push(start);
  seen[start] = 1;
  let runMin = Infinity;
  const order = []; const mins = []; const sums = [];
  let sum = 0;
  let exit = -1;
  const events = [];
  // highest node popped above the current running minimum, and the saddle
  // it was entered through: the node that pushed the first such climb
  // node. That pusher sits exactly at the running minimum (a higher node
  // would have been popped before it), and on a grid with many nodes at
  // the saddle elevation it is the one on the actual flood path.
  let climbMax = -Infinity;
  let climbSaddle = -1;
  const closeEvent = () => {
    if (climbSaddle >= 0 && climbMax - runMin >= minRelief) {
      events.push({ saddleZ: runMin, saddle: nodeInfo(z, spec, climbSaddle), culminationZ: climbMax, relief: climbMax - runMin });
    }
  };
  while (heap.size) {
    const i = heap.pop();
    if (z[i] < runMin) { closeEvent(); runMin = z[i]; climbMax = -Infinity; climbSaddle = -1; }
    else if (z[i] > runMin) {
      if (climbSaddle < 0) climbSaddle = from[i];
      if (z[i] > climbMax) climbMax = z[i];
    }
    if (isBoundaryNode(z, spec, i)) { exit = i; break; }
    order.push(i);
    sum += z[i];
    mins.push(runMin);
    sums.push(sum);
    for (const j of neighbours(i, nx, ny)) {
      if (!seen[j] && !isNull(z[j])) { seen[j] = 1; from[j] = i; heap.push(j); }
    }
  }
  // exit === -1 cannot happen on a finite grid (the flood always reaches
  // an edge node); guard anyway so a caller never reads undefined.
  if (exit === -1) throw new Error('The closure never reached the map boundary.');
  // The closure is limited by the edge when the exit node itself sits at
  // the bottleneck level; otherwise the spill is the lowest node on the
  // flood path from the crest to the exit (nearest the exit on ties).
  const limitedByEdge = z[exit] <= runMin;
  let spillNode = exit;
  if (!limitedByEdge) {
    for (let k = from[exit]; k >= 0; k = from[k]) {
      if (z[k] < z[spillNode]) spillNode = k;
      if (z[k] === runMin) { spillNode = k; break; }
    }
  }
  // An event is closed only when the running minimum drops below its
  // saddle, so a climb seen at the spill level itself (the far side of
  // the spill, e.g. into a neighbour the map edge cuts) is never
  // recorded as a merge inside the closure.
  return {
    merges: events,
    crest: nodeInfo(z, spec, start),
    spillZ: runMin,
    spill: nodeInfo(z, spec, spillNode),
    limitedByEdge,
    order: Int32Array.from(order),
    runMin: Float64Array.from(mins),
    prefixSum: Float64Array.from(sums),
  };
}

/**
 * The trap's closure at one contact from a spillAnalysis: the prefix of
 * the flood whose running minimum stays above the contact.
 * @returns {{contact:number, nodes:number, areaM2:number, grvM3:number, closed:boolean}}
 */
export function closureAt(spill, spec, contact) {
  const { runMin, prefixSum } = spill;
  // first index where runMin <= contact (runMin is non-increasing)
  let lo = 0; let hi = runMin.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runMin[mid] <= contact) hi = mid; else lo = mid + 1;
  }
  const nodes = lo;
  const A = cellArea(spec);
  const sumZ = nodes ? prefixSum[nodes - 1] : 0;
  return {
    contact,
    nodes,
    areaM2: nodes * A,
    grvM3: nodes ? (sumZ - contact * nodes) * A : 0,
    closed: contact >= spill.spillZ,
  };
}

/**
 * Area-depth and GRV-versus-contact curve from the crest down to the spill.
 * @param {number} [levels=40] points on the curve (crest excluded, spill included)
 * @returns {Array<{contact, nodes, areaM2, grvM3, closed}>} shallow to deep
 */
export function closureCurve(spill, spec, { levels = 40 } = {}) {
  const top = spill.crest.z;
  const bottom = spill.spillZ;
  if (!(top > bottom)) return [];
  const out = [];
  for (let k = 1; k <= levels; k++) {
    const contact = top - ((top - bottom) * k) / levels;
    out.push(closureAt(spill, spec, contact));
  }
  return out;
}
