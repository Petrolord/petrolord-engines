// 2D-3D integration (W5.4): line-line intersections, line-into-volume
// projection, and mistie analysis with a least-squares bulk-shift
// solve. Pure math, worker-safe.
//
// Conventions: navigation is the measured per-trace polyline
// (line2d.js); fractional TRACE indices parameterize positions along a
// line; picks are per-trace sample indices (1e30 nulls); misties are in
// ms POSITIVE when line B reads DEEPER than line A at the crossing.

import { NULL_VALUE } from './manifest';
import { worldToIlxl } from './surveyGeometry';

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/**
 * All crossings of two navigation polylines. Segment bounding boxes are
 * binned on a coarse grid so realistic pairs (thousands of traces each)
 * stay far from O(nA x nB).
 *
 * @param {{x: Float64Array, y: Float64Array}} navA
 * @param {{x: Float64Array, y: Float64Array}} navB
 * @param {{cellM?: number}} [opts] bin size (default 500 m)
 * @returns {{ia: number, ib: number, x: number, y: number}[]} fractional
 *   trace indices on each line + the world crossing point
 */
export function lineIntersections(navA, navB, { cellM = 500 } = {}) {
  const nA = navA.x.length;
  const nB = navB.x.length;
  if (nA < 2 || nB < 2) return [];

  // bin B's segments
  const bins = new Map();
  const key = (cx, cy) => `${cx}:${cy}`;
  for (let j = 0; j < nB - 1; j++) {
    const x0 = Math.min(navB.x[j], navB.x[j + 1]);
    const x1 = Math.max(navB.x[j], navB.x[j + 1]);
    const y0 = Math.min(navB.y[j], navB.y[j + 1]);
    const y1 = Math.max(navB.y[j], navB.y[j + 1]);
    for (let cx = Math.floor(x0 / cellM); cx <= Math.floor(x1 / cellM); cx++) {
      for (let cy = Math.floor(y0 / cellM); cy <= Math.floor(y1 / cellM); cy++) {
        const k = key(cx, cy);
        let arr = bins.get(k);
        if (!arr) { arr = []; bins.set(k, arr); }
        arr.push(j);
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (let i = 0; i < nA - 1; i++) {
    const ax0 = navA.x[i];
    const ay0 = navA.y[i];
    const ax1 = navA.x[i + 1];
    const ay1 = navA.y[i + 1];
    const bx0 = Math.min(ax0, ax1);
    const bx1 = Math.max(ax0, ax1);
    const by0 = Math.min(ay0, ay1);
    const by1 = Math.max(ay0, ay1);
    const cand = new Set();
    for (let cx = Math.floor(bx0 / cellM); cx <= Math.floor(bx1 / cellM); cx++) {
      for (let cy = Math.floor(by0 / cellM); cy <= Math.floor(by1 / cellM); cy++) {
        const arr = bins.get(key(cx, cy));
        if (arr) for (const j of arr) cand.add(j);
      }
    }
    for (const j of cand) {
      const hit = segmentIntersection(
        ax0, ay0, ax1, ay1,
        navB.x[j], navB.y[j], navB.x[j + 1], navB.y[j + 1],
      );
      if (!hit) continue;
      const ia = i + hit.t;
      const ib = j + hit.u;
      // adjacent segments sharing an endpoint report the same crossing
      // twice — dedupe on rounded parameter pairs
      const dk = `${Math.round(ia * 8)}:${Math.round(ib * 8)}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push({ ia, ib, x: hit.x, y: hit.y });
    }
  }
  return out.sort((a, b) => a.ia - b.ia);
}

/** Proper segment-segment intersection (t, u in [0, 1]); null when
 *  parallel or disjoint. */
function segmentIntersection(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
  const rx = ax1 - ax0;
  const ry = ay1 - ay0;
  const sx = bx1 - bx0;
  const sy = by1 - by0;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = bx0 - ax0;
  const qpy = by0 - ay0;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: ax0 + t * rx, y: ay0 + t * ry };
}

/**
 * Project a 2D line into a 3D volume's lattice: fractional (il, xl) per
 * trace, null where the line leaves the survey — EXACTLY the traverse
 * `positions` contract, so the whole 3D overlay stack (horizons on
 * traverses, stick projection, well corridors) works on lines for free.
 *
 * @param {{x: Float64Array, y: Float64Array}} nav
 * @param {Object} affine volume survey affine
 * @param {{nIl: number, nXl: number}} geom
 * @returns {{positions: ({il:number, xl:number}|null)[], inside: number}}
 */
export function lineToLattice(nav, affine, geom) {
  const n = nav.x.length;
  const positions = new Array(n).fill(null);
  let inside = 0;
  for (let i = 0; i < n; i++) {
    const ij = worldToIlxl(affine, nav.x[i], nav.y[i]);
    if (!ij) continue;
    if (ij.i < -0.5 || ij.i > geom.nIl - 0.5 || ij.j < -0.5 || ij.j > geom.nXl - 0.5) continue;
    positions[i] = { il: ij.i, xl: ij.j };
    inside += 1;
  }
  return { positions, inside };
}

/** Pick value at a fractional trace index (linear over live picks;
 *  null when either bracketing pick is null). */
export function pickAtTrace(picks, idx) {
  if (!Number.isFinite(idx) || idx < 0 || idx > picks.length - 1) return null;
  const i0 = Math.min(picks.length - 2, Math.floor(idx));
  const a = picks[i0];
  const b = picks[i0 + 1];
  if (isNull(a) || isNull(b)) return null;
  return a + (idx - i0) * (b - a);
}

/**
 * Misties of one named horizon over a set of lines: at every crossing
 * where BOTH lines carry a live pick, dt_ms = t(B) − t(A) (positive =
 * B deeper). Bulk shifts then solve in least squares: find per-line
 * shifts s minimizing Σ (t_A + s_A − t_B − s_B)², gauge-fixed by
 * Σ s = 0 (report is relative; applying any common constant is a
 * datum choice, not a tie).
 *
 * @param {Array<{id: string, picks: Float32Array}>} lines picks are
 *   per-trace sample indices for THIS horizon (1e30 nulls)
 * @param {Array<{a: number, b: number, ia: number, ib: number}>}
 *   crossings indices into `lines` + fractional trace positions
 * @param {number} dtMs sample interval (all lines resampled alike; pass
 *   per-line conversion upstream when they differ)
 * @returns {{observations: Array, shiftsMs: number[], rmsBeforeMs: number,
 *   rmsAfterMs: number, tied: number}}
 */
export function solveMisties(lines, crossings, dtMs) {
  const observations = [];
  for (const c of crossings) {
    const tA = pickAtTrace(lines[c.a].picks, c.ia);
    const tB = pickAtTrace(lines[c.b].picks, c.ib);
    if (tA == null || tB == null) continue;
    observations.push({
      ...c, tAMs: tA * dtMs, tBMs: tB * dtMs, dtMs: (tB - tA) * dtMs,
    });
  }
  const n = lines.length;
  const shifts = new Array(n).fill(0);
  if (!observations.length) {
    return {
      observations, shiftsMs: shifts, rmsBeforeMs: 0, rmsAfterMs: 0, tied: 0,
    };
  }

  // normal equations for Σ (tA + sA − tB − sB)² + gauge Σ s = 0
  const G = Array.from({ length: n }, () => new Array(n).fill(0));
  const r = new Array(n).fill(0);
  for (const o of observations) {
    G[o.a][o.a] += 1;
    G[o.b][o.b] += 1;
    G[o.a][o.b] -= 1;
    G[o.b][o.a] -= 1;
    r[o.a] += o.dtMs;          // sA − sB should absorb tB − tA
    r[o.b] -= o.dtMs;
  }
  // gauge: add the Σs=0 constraint to every row (Tikhonov-style exact
  // for the singular direction; leaves connected components mean-zero)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) G[i][j] += 1;
  }
  const solved = solveDense(G, r);
  if (solved) for (let i = 0; i < n; i++) shifts[i] = solved[i];

  const rms = (vals) => Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length);
  const before = observations.map((o) => o.dtMs);
  const after = observations.map((o) => o.dtMs - (shifts[o.a] - shifts[o.b]));
  return {
    observations: observations.map((o, i) => ({ ...o, residualMs: after[i] })),
    shiftsMs: shifts.map((v) => Math.round(v * 100) / 100),
    rmsBeforeMs: rms(before),
    rmsAfterMs: rms(after),
    tied: observations.length,
  };
}

/** Gaussian elimination with partial pivoting. */
function solveDense(G, r) {
  const n = r.length;
  const a = G.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let q = c + 1; q < n; q++) if (Math.abs(a[q][c]) > Math.abs(a[p][c])) p = q;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let q = 0; q < n; q++) {
      if (q === c) continue;
      const f = a[q][c] / a[c][c];
      for (let m = c; m <= n; m++) a[q][m] -= f * a[c][m];
    }
  }
  return a.map((row, i) => row[n] / a[i][i]);
}

/**
 * The nearest trace pair at a crossing for character QC — the returned
 * traces feed tieWarp.estimatePhaseRotation (phase mistie) and
 * synthetics.suggestBulkShift (time-lag cross-check) unchanged.
 * @param {{data: Float32Array, width: number, height: number}} sectionA
 * @param {{data: Float32Array, width: number, height: number}} sectionB
 * @param {{ia: number, ib: number}} crossing
 * @returns {?{a: Float32Array, b: Float32Array}} null off-line
 */
export function crossingTraces(sectionA, sectionB, crossing) {
  const cut = (section, idx) => {
    const t = Math.round(idx);
    if (t < 0 || t >= section.height) return null;
    return section.data.subarray(t * section.width, (t + 1) * section.width);
  };
  const a = cut(sectionA, crossing.ia);
  const b = cut(sectionB, crossing.ib);
  if (!a || !b) return null;
  return { a: Float32Array.from(a), b: Float32Array.from(b) };
}
