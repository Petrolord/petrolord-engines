// Fault OBJECTS (W3.1): the fault stops being a display-only stick set.
//
// Three constructions, all in horizon-lattice space (il/xl = continuous
// 0-based grid indices, s = sub-sample time index increasing downward,
// nulls 1.0E+30 — playbook):
//
//   1. loftFaultSurface — the persisted, exportable fault surface: each
//      stick resampled to a fixed number of points by arc length, rails
//      oriented to match their neighbour (the exact algorithm the 3D
//      ribbon uses, so the stored surface and the display ribbon cannot
//      disagree about topology). Plain arrays, jsonb-friendly.
//
//   2. faultHorizonIntersection — hanging-wall/footwall cutoff pairs
//      where the fault cuts a horizon. Per stick: the horizon is sampled
//      on each side of the fault along the stick's own horizontal
//      direction (outside a corridor that excludes drag/smear), each
//      side is fit with a straight line, both lines are extrapolated to
//      the fault (itself fit as a line through the stick near horizon
//      level), and the two line-line intersections are the cutoffs.
//      Throw = vertical separation of the cutoffs (samples), heave =
//      horizontal separation (lattice cells along the profile
//      direction). Cutoff polylines across the ordered sticks form the
//      fault polygon (the interpretation gap the gridder must not
//      interpolate across).
//
//   3. polygonMask — rasterize polygon rings onto the lattice so
//      gridding can null the fault gap (used with the existing
//      faultBarriers block machinery).
//
// Sign conventions (documented + tested): each stick's profile direction
// d is oriented to agree with the local trace normal (trace tangent
// rotated +90° in the (i, j) plane), so "neg"/"pos" sides are consistent
// along the whole fault. throwSamples = s(pos) − s(neg) (positive = pos
// side deeper). heaveCells = u(pos) − u(neg) (its magnitude is the
// heave; sign carries dip direction along the profile).
//
// Pure math, worker-safe, no I/O.

import { NULL_VALUE } from './manifest';
import { horizonSampleAt } from './faultBarriers';

const NULL_F32 = Math.fround(NULL_VALUE);

const stickPoints = (stick) => stick.points || stick;

/**
 * Gap-tolerant stick-horizon crossing. faultBarriers.stickCrossing
 * deliberately resets across horizon holes (no invented barrier inside a
 * hole) — but a CORRECTLY interpreted faulted horizon is null exactly in
 * the fault gap, so for fault objects the crossing must bridge nulls:
 * the last live point is kept across gaps and a sign change across a gap
 * interpolates between the two live points (landing mid-gap; the cutoff
 * fit refines both walls from there).
 *
 * @returns {{i:number, j:number}|null} lattice-space crossing
 */
export function stickCrossingGapTolerant(stick, picks, geom) {
  const pts = stickPoints(stick);
  if (!pts || pts.length === 0) return null;
  let prev = null; // {il, xl, d} — last LIVE point, gaps do not reset it
  for (const p of pts) {
    const h = horizonSampleAt(picks, geom, p.il, p.xl);
    if (h === null) continue;
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

/** Arc-length resample of a stick polyline to exactly k points, in
 * lattice units (il, xl, s all contribute; s is in samples). */
export function resampleStickLattice(stick, k) {
  const pts = stickPoints(stick);
  if (!pts || pts.length === 0) return [];
  if (pts.length === 1) {
    return Array.from({ length: k }, () => [pts[0].il, pts[0].xl, pts[0].s]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(
      pts[i].il - pts[i - 1].il,
      pts[i].xl - pts[i - 1].xl,
      pts[i].s - pts[i - 1].s,
    ));
  }
  const total = cum[cum.length - 1];
  const out = [];
  let seg = 0;
  for (let j = 0; j < k; j++) {
    const target = total * (k === 1 ? 0 : j / (k - 1));
    while (seg < pts.length - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 0 ? (target - cum[seg]) / span : 0;
    out.push([
      pts[seg].il + t * (pts[seg + 1].il - pts[seg].il),
      pts[seg].xl + t * (pts[seg + 1].xl - pts[seg].xl),
      pts[seg].s + t * (pts[seg + 1].s - pts[seg].s),
    ]);
  }
  return out;
}

/**
 * Loft a fault's sticks into the persisted surface object: rails (one
 * per stick with >= 2 points, STORED stick order) x samples points, each
 * [il, xl, s]. Rail i+1 is reversed when that shortens the join to rail
 * i — the faultRibbonMesh orientation rule, re-derived here in lattice
 * space so persistence and display agree. Fewer than two usable sticks
 * -> null (a single stick has no surface).
 *
 * @param {Array<{points:{il,xl,s}[]}|Array>} sticks
 * @param {{samples?: number}} [opts]
 * @returns {{version: 1, samples: number, rails: number[][][]}|null}
 */
export function loftFaultSurface(sticks, { samples = 16 } = {}) {
  const rails = (sticks || [])
    .filter((stick) => stickPoints(stick) && stickPoints(stick).length >= 2)
    .map((stick) => resampleStickLattice(stick, samples));
  if (rails.length < 2) return null;

  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  for (let i = 1; i < rails.length; i++) {
    let same = 0;
    let flipped = 0;
    for (let j = 0; j < samples; j++) {
      same += dist2(rails[i - 1][j], rails[i][j]);
      flipped += dist2(rails[i - 1][j], rails[i][samples - 1 - j]);
    }
    if (flipped < same) rails[i].reverse();
  }
  return { version: 1, samples, rails };
}

/** Least squares y = a + b·x over point pairs; null when degenerate. */
function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

/** Horizontal chord direction of a stick (unit [di, dj]), or null when
 * the stick has no usable horizontal extent (< minChord cells). */
export function stickChordDir(stick, minChord = 0.5) {
  const pts = stickPoints(stick);
  if (!pts || pts.length < 2) return null;
  const di = pts[pts.length - 1].il - pts[0].il;
  const dj = pts[pts.length - 1].xl - pts[0].xl;
  const len = Math.hypot(di, dj);
  if (len < minChord) return null;
  return [di / len, dj / len];
}

/**
 * One stick's hanging-wall/footwall cutoff pair against a horizon.
 *
 * @param {{points:{il,xl,s}[]}|Array} stick
 * @param {Float32Array} picks nIl x nXl sample indices, 1e30 nulls
 * @param {{nIl:number, nXl:number}} geom
 * @param {{gapCells?: number, spanCells?: number, stepCells?: number,
 *   fitWindowS?: number, minSidePts?: number, dir?: number[]}} [opts]
 *   gapCells: half-width of the excluded corridor around the fault
 *   (drag/smear zone); spanCells: how far beyond the gap each side is
 *   sampled; dir: profile direction override (unit [di, dj]) used when
 *   the stick is vertical in map view.
 * @returns {{neg:{il,xl,s}, pos:{il,xl,s}, crossing:{i,j},
 *   dir:number[], throwSamples:number, heaveCells:number}|null}
 */
export function horizonFaultCutoff(stick, picks, geom, opts = {}) {
  const {
    gapCells = 2, spanCells = 6, stepCells = 0.5,
    fitWindowS = 12, minSidePts = 3,
  } = opts;
  const crossing = stickCrossingGapTolerant(stick, picks, geom);
  if (!crossing) return null;
  const dir = stickChordDir(stick) || opts.dir;
  if (!dir) return null;
  const [di, dj] = dir;
  const { i: i0, j: j0 } = crossing;

  // fault as a local line u = alpha + beta * s through the stick points
  // near horizon level (u = signed distance along dir from the crossing)
  const hCentre = horizonSampleAt(picks, geom, i0, j0);
  const pts = stickPoints(stick);
  const us = [];
  const ss = [];
  for (const p of pts) {
    if (hCentre !== null && Math.abs(p.s - hCentre) > fitWindowS) continue;
    us.push((p.il - i0) * di + (p.xl - j0) * dj);
    ss.push(p.s);
  }
  if (us.length < 2) { // window too tight for a sparse stick: use it all
    us.length = 0; ss.length = 0;
    for (const p of pts) {
      us.push((p.il - i0) * di + (p.xl - j0) * dj);
      ss.push(p.s);
    }
  }
  let fault = fitLine(ss, us); // u = alpha + beta * s
  if (!fault) fault = { a: 0, b: 0 }; // vertical fault through the crossing

  // each side: horizon samples along the profile, outside the corridor
  const side = (sign) => {
    const su = [];
    const sh = [];
    for (let t = 0; t <= spanCells + 1e-9; t += stepCells) {
      const u = sign * (gapCells + t);
      const h = horizonSampleAt(picks, geom, i0 + u * di, j0 + u * dj);
      if (h === null) continue;
      su.push(u);
      sh.push(h);
    }
    if (su.length < minSidePts) return null;
    const line = fitLine(su, sh); // s = a + b * u
    if (!line) return null;
    // intersect s = a + b·u with u = alpha + beta·s
    const denom = 1 - line.b * fault.b;
    if (Math.abs(denom) < 1e-9) return null; // horizon parallel to fault
    const s = (line.a + line.b * fault.a) / denom;
    const u = fault.a + fault.b * s;
    return { u, s };
  };
  const neg = side(-1);
  const pos = side(1);
  if (!neg || !pos) return null;

  const toPoint = ({ u, s }) => ({ il: i0 + u * di, xl: j0 + u * dj, s });
  return {
    neg: toPoint(neg),
    pos: toPoint(pos),
    crossing,
    dir,
    throwSamples: pos.s - neg.s,
    heaveCells: pos.u - neg.u,
  };
}

/**
 * Full fault-vs-horizon intersection: ordered cutoff polylines (the
 * hanging-wall/footwall pair), per-stick throw/heave segments (the throw
 * map along the fault trace), and the closed fault polygon (neg polyline
 * + reversed pos polyline, horizontal footprint of the gap).
 *
 * Profile directions are made consistent along the fault: each stick's
 * dir is flipped to agree with the local trace normal (tangent rotated
 * +90° in (i, j)), so "neg"/"pos" name the same wall on every stick.
 *
 * @param {{sticks: Array}} fault
 * @param {Float32Array} picks @param {{nIl,nXl}} geom
 * @param {Object} [opts] horizonFaultCutoff options
 * @returns {{trace:{i,j}[], cutNeg:{il,xl,s}[], cutPos:{il,xl,s}[],
 *   segments:{i,j,throwSamples,heaveCells}[],
 *   polygon:{il,xl}[]|null}|null} null when fewer than two sticks cross
 */
export function faultHorizonIntersection(fault, picks, geom, opts = {}) {
  const sticks = (fault && fault.sticks) || [];
  const crossed = [];
  for (const stick of sticks) {
    const c = stickCrossingGapTolerant(stick, picks, geom);
    if (c) crossed.push({ stick, c });
  }
  if (crossed.length < 2) return null;
  const trace = crossed.map(({ c }) => ({ i: c.i, j: c.j }));

  const cutNeg = [];
  const cutPos = [];
  const segments = [];
  for (let m = 0; m < crossed.length; m++) {
    // local trace normal: tangent from the neighbouring crossings
    const a = trace[Math.max(0, m - 1)];
    const b = trace[Math.min(trace.length - 1, m + 1)];
    const tLen = Math.hypot(b.i - a.i, b.j - a.j);
    const normal = tLen > 1e-9
      ? [-(b.j - a.j) / tLen, (b.i - a.i) / tLen]
      : null;

    let cut = horizonFaultCutoff(crossed[m].stick, picks, geom, {
      ...opts, dir: opts.dir || normal || undefined,
    });
    if (!cut) continue;
    // orient the profile with the trace normal so sides stay consistent
    if (normal && cut.dir[0] * normal[0] + cut.dir[1] * normal[1] < 0) {
      cut = {
        ...cut,
        dir: [-cut.dir[0], -cut.dir[1]],
        neg: cut.pos,
        pos: cut.neg,
        throwSamples: -cut.throwSamples,
        heaveCells: -cut.heaveCells,
      };
    }
    cutNeg.push(cut.neg);
    cutPos.push(cut.pos);
    segments.push({
      i: cut.crossing.i,
      j: cut.crossing.j,
      throwSamples: cut.throwSamples,
      heaveCells: cut.heaveCells,
    });
  }
  if (segments.length === 0) return null;

  const polygon = cutNeg.length >= 2
    ? [
      ...cutNeg.map((p) => ({ il: p.il, xl: p.xl })),
      ...[...cutPos].reverse().map((p) => ({ il: p.il, xl: p.xl })),
    ]
    : null;
  return { trace, cutNeg, cutPos, segments, polygon };
}

/**
 * Rasterize polygon rings onto the lattice (even-odd rule at cell
 * centres). Gridding nulls these cells: the fault gap is not
 * interpolated across.
 *
 * @param {Array<{il:number, xl:number}[]>} rings
 * @returns {Uint8Array} nIl x nXl, 1 = inside a ring
 */
export function polygonMask(rings, nIl, nXl) {
  const mask = new Uint8Array(nIl * nXl);
  for (const ring of rings || []) {
    if (!ring || ring.length < 3) continue;
    let minI = Infinity; let maxI = -Infinity;
    let minJ = Infinity; let maxJ = -Infinity;
    for (const p of ring) {
      if (p.il < minI) minI = p.il;
      if (p.il > maxI) maxI = p.il;
      if (p.xl < minJ) minJ = p.xl;
      if (p.xl > maxJ) maxJ = p.xl;
    }
    const i0 = Math.max(0, Math.floor(minI));
    const i1 = Math.min(nIl - 1, Math.ceil(maxI));
    const j0 = Math.max(0, Math.floor(minJ));
    const j1 = Math.min(nXl - 1, Math.ceil(maxJ));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        let inside = false;
        for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
          const yi = ring[k].il; const xi = ring[k].xl;
          const yl = ring[l].il; const xll = ring[l].xl;
          if ((xi > j) !== (xll > j)
            && i < ((yl - yi) * (j - xi)) / (xll - xi) + yi) inside = !inside;
        }
        if (inside) mask[i * nXl + j] = 1;
      }
    }
  }
  return mask;
}

/**
 * Null every masked cell of a grid (fault-polygon clip after gridding).
 * @param {Float32Array} grid @param {Uint8Array} mask
 * @returns {Float32Array} new grid
 */
export function applyPolygonMask(grid, mask) {
  const out = new Float32Array(grid);
  for (let c = 0; c < out.length; c++) if (mask[c]) out[c] = NULL_F32;
  return out;
}

/**
 * World-unit scale of one profile-direction lattice step, for callers
 * converting heaveCells to metres: |di·e_il + dj·e_xl| under orthogonal
 * survey axes with the given spacings.
 */
export function profileStepMeters(dir, ilSpacingM, xlSpacingM) {
  return Math.hypot(dir[0] * ilSpacingM, dir[1] * xlSpacingM);
}

/**
 * The fault surface's map trace at a constant time level: one (i, j)
 * point per rail whose s-span brackets `s` (linear interpolation between
 * the bracketing samples along the rail). This is how fault-aware
 * tracking gets its barriers BEFORE a horizon exists — the surface knows
 * where the fault lives at the seed's level; no picks required.
 *
 * @param {{samples:number, rails:number[][][]}} surface loftFaultSurface
 * @param {number} s time level (sample index, float)
 * @returns {Array<{i:number, j:number}>|null} rasterizeTraces-ready
 *   polyline; null when fewer than two rails reach the level
 */
export function surfaceLevelTrace(surface, s) {
  if (!surface || !Array.isArray(surface.rails)) return null;
  const pts = [];
  for (const rail of surface.rails) {
    let found = null;
    for (let k = 0; k + 1 < rail.length; k++) {
      const [ilA, xlA, sA] = rail[k];
      const [ilB, xlB, sB] = rail[k + 1];
      if ((s >= sA && s <= sB) || (s >= sB && s <= sA)) {
        const span = sB - sA;
        const t = span !== 0 ? (s - sA) / span : 0;
        found = { i: ilA + t * (ilB - ilA), j: xlA + t * (xlB - xlA) };
        break;
      }
    }
    if (found) pts.push(found);
  }
  return pts.length >= 2 ? pts : null;
}
