// Arbitrary traverse lines: a user-drawn map polyline becomes a seismic
// section along that path.
//
// The path is resampled at EQUAL GROUND-DISTANCE steps (through the
// survey affine, so rotated surveys and rectangular bins measure true
// metres) and each sample takes its NEAREST trace — amplitudes are
// never interpolated laterally (domain rule: amplitudes preserved
// end-to-end; any smoothing is display-side in the shader only).
// Consecutive duplicate traces collapse, so the section's columns are
// distinct traces roughly one step apart.
//
// Pure math + brick copies, worker-safe, no I/O.

import { NULL_VALUE } from './manifest';
import { surveyAffine, ilxlToWorld, cellSpacing } from './surveyGeometry';

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * Resample a map polyline into traverse trace positions.
 *
 * @param {{il:number, xl:number}[]} vertices continuous lattice coords
 *   (same space MapView draws in), at least 2
 * @param {{nIl:number, nXl:number}} geom
 * @param {?Object} geometry manifest.geometry (for the survey affine);
 *   without usable coordinates the step falls back to one crossline bin
 *   in lattice units
 * @returns {?{positions: {il:number, xl:number}[], stepM: number|null,
 *   lengthM: number|null}} positions are integer trace indices, clamped
 *   to the survey and deduped; null when the path yields fewer than 2
 *   distinct traces
 */
export function resampleTraverse(vertices, geom, geometry = null) {
  if (!vertices || vertices.length < 2) return null;
  const affine = geometry ? surveyAffine(geometry) : null;
  const toWorld = affine
    ? (p) => ilxlToWorld(affine, p.il, p.xl)
    : (p) => ({ x: p.xl, y: p.il });      // lattice units, aspect unknown
  // step: one crossline bin of ground distance (the survey's natural
  // trace spacing along a line)
  const stepM = affine ? (cellSpacing(affine).xl || 1) : 1;

  // cumulative ground distance per vertex
  const world = vertices.map(toWorld);
  const cum = [0];
  for (let v = 1; v < world.length; v++) {
    cum.push(cum[v - 1] + Math.hypot(
      world[v].x - world[v - 1].x, world[v].y - world[v - 1].y,
    ));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;

  const clampI = (v) => Math.max(0, Math.min(geom.nIl - 1, v));
  const clampJ = (v) => Math.max(0, Math.min(geom.nXl - 1, v));
  const positions = [];
  let seg = 1;
  const nSteps = Math.max(1, Math.round(total / stepM));
  for (let k = 0; k <= nSteps; k++) {
    const d = (k / nSteps) * total;
    while (seg < vertices.length - 1 && cum[seg] < d) seg += 1;
    const d0 = cum[seg - 1];
    const d1 = cum[seg];
    const f = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
    const a = vertices[seg - 1];
    const b = vertices[seg];
    const il = clampI(Math.round(a.il + f * (b.il - a.il)));
    const xl = clampJ(Math.round(a.xl + f * (b.xl - a.xl)));
    const prev = positions[positions.length - 1];
    if (!prev || prev.il !== il || prev.xl !== xl) positions.push({ il, xl });
  }
  if (positions.length < 2) return null;
  return {
    positions,
    stepM: affine ? total / nSteps : null,
    lengthM: affine ? total : null,
  };
}

/**
 * Project fault-stick points onto a traverse path.
 *
 * The inline/xline analog draws stick points within one LINE of the
 * section plane; here a point is kept when its nearest path column is
 * within `maxDist` lattice cells. The default 1.5 matches that
 * generosity: an adjacent trace measures 1.0 and a diagonal neighbor
 * 1.41 — both count as "on this section" like |il − idx| <= 1 does —
 * while anything a full bin off the corridor is dropped. Nearest-column
 * distance ≈ true point-to-path distance because path columns are about
 * one bin apart (the along-path error is at most half a step).
 *
 * @param {{il:number, xl:number, s:number}[]} points one stick, in pick
 *   order (top-down along the discontinuity)
 * @param {{il:number, xl:number}[]} positions traverse trace positions
 * @param {number} [maxDist] tolerance in lattice cells
 * @returns {?({trace:number, s:number, dist:number}|null)[]} aligned
 *   with `points` (null = beyond tolerance, so drawing pen-breaks where
 *   the stick leaves the corridor); null when nothing projects
 */
export function projectStickToTraverse(points, positions, maxDist = 1.5) {
  if (!points || !points.length || !positions || !positions.length) return null;
  const out = new Array(points.length).fill(null);
  let any = false;
  for (let i = 0; i < points.length; i++) {
    const q = points[i];
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < positions.length; c++) {
      const d = Math.hypot(positions[c].il - q.il, positions[c].xl - q.xl);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (bestD <= maxDist) {
      out[i] = { trace: best, s: q.s, dist: bestD };
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Cells (il·nXl + xl grid indices) covered by an erase brush of
 * `radius` path columns centered on `trace` — the traverse analog of
 * the section eraser's trace ± radius. The brush follows the PATH:
 * at a bend it erases around the corner, never across it, and it
 * clamps at the path ends instead of wrapping.
 *
 * @param {{il:number, xl:number}[]} positions traverse trace positions
 * @param {number} trace path column under the pointer
 * @param {number} radius brush half-width in path columns
 * @param {number} nXl horizon grid row stride
 * @returns {number[]} horizon grid cell indices (positions are deduped,
 *   so cells are distinct)
 */
export function traverseEraseCells(positions, trace, radius, nXl) {
  const cells = [];
  for (let d = -radius; d <= radius; d++) {
    const c = trace + d;
    if (c < 0 || c >= positions.length) continue;
    cells.push(positions[c].il * nXl + positions[c].xl);
  }
  return cells;
}

/**
 * Validate a manifest's saved traverse list (manifest.json is plain
 * storage — treat it as hand-editable input): keep entries with a
 * string id and name and at least 2 finite vertices, dropping invalid
 * vertices and everything unknown. Never throws.
 *
 * @param {*} list manifest.traverses
 * @returns {{id:string, name:string, vertices:{il:number, xl:number}[]}[]}
 */
export function sanitizeTraverses(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t.id !== 'string' || typeof t.name !== 'string') continue;
    const vertices = (Array.isArray(t.vertices) ? t.vertices : [])
      .filter((v) => v && Number.isFinite(v.il) && Number.isFinite(v.xl))
      .map((v) => ({ il: v.il, xl: v.xl }));
    if (vertices.length < 2) continue;
    out.push({ id: t.id, name: t.name, vertices });
  }
  return out;
}

/**
 * Assemble a traverse section from bricks: one column per position,
 * laid out exactly like the inline/crossline sections —
 * data[column * ns + sample], width = ns, height = positions.length —
 * so the section renderer, overlays and readout reuse untouched.
 *
 * @param {(i:number,j:number,k:number) => Promise<Float32Array>} getBrick
 * @param {import('./sliceAssembly').VolumeGeom} geom
 * @param {{il:number, xl:number}[]} positions integer trace indices
 * @returns {Promise<{data: Float32Array, width: number, height: number,
 *   traceRms: Float32Array, nullValue: number}>}
 */
export async function assembleTraverse(getBrick, geom, positions) {
  const b = geom.brickSize;
  const nK = Math.ceil(geom.ns / b);

  // prefetch each needed brick exactly once
  const bricks = new Map();
  const jobs = [];
  for (const p of positions) {
    const bi = Math.floor(p.il / b);
    const bj = Math.floor(p.xl / b);
    for (let bk = 0; bk < nK; bk++) {
      const key = `${bi}-${bj}-${bk}`;
      if (!bricks.has(key)) {
        bricks.set(key, null);
        jobs.push(getBrick(bi, bj, bk).then((data) => bricks.set(key, data)));
      }
    }
  }
  await Promise.all(jobs);

  const width = geom.ns;
  const height = positions.length;
  const data = new Float32Array(width * height);
  for (let c = 0; c < height; c++) {
    const p = positions[c];
    const bi = Math.floor(p.il / b);
    const bj = Math.floor(p.xl / b);
    const li = p.il % b;
    const lj = p.xl % b;
    for (let bk = 0; bk < nK; bk++) {
      const brick = bricks.get(`${bi}-${bj}-${bk}`);
      const s0 = bk * b;
      const n = Math.min(b, geom.ns - s0);
      data.set(brick.subarray((li * b + lj) * b, (li * b + lj) * b + n), c * width + s0);
    }
  }

  // per-column RMS for shader-side trace balancing (nulls excluded)
  const traceRms = new Float32Array(height);
  for (let c = 0; c < height; c++) {
    let sum = 0;
    let n = 0;
    for (let s = 0; s < width; s++) {
      const v = data[c * width + s];
      if (v !== NULL_F32) { sum += v * v; n += 1; }
    }
    traceRms[c] = n > 0 ? Math.sqrt(sum / n) : 0;
  }

  return { data, width, height, traceRms, nullValue: NULL_F32 };
}
