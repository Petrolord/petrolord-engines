// Map-window math: null-aware marching-squares contouring of horizon
// grids, nice contour levels, and the color-fill pixel buffer. Pure and
// jest-tested; MapView paints the results through its ViewTransform.
//
// Grid convention (matches horizon pick grids): value[il * nXl + xl],
// 1e30 = null. Contour coordinates come back in NODE units — x = xl
// index, y = il index; painters add the +0.5 cell-centre offset when
// projecting, exactly like the slice overlays.

import { NULL_VALUE, niceStepUp } from './numeric';

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * Contour level values covering [zMin, zMax] on a nice step.
 * @returns {{levels: number[], step: number}}
 */
export function contourLevels(zMin, zMax, target = 10) {
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || !(zMax > zMin)) {
    return { levels: [], step: 0 };
  }
  const step = niceStepUp((zMax - zMin) / Math.max(target, 1));
  const levels = [];
  for (let v = Math.ceil(zMin / step) * step; v <= zMax + step * 1e-9; v += step) {
    levels.push(Number(v.toPrecision(12)));
  }
  return { levels, step };
}

/**
 * Marching squares for one level. Cells touching a null node are
 * skipped (holes keep hard edges, playbook null rule).
 *
 * @param {Float32Array} grid nIl x nXl values, 1e30 nulls
 * @returns {Float32Array} segment soup [x0, y0, x1, y1, ...] in node units
 */
export function contourSegments(grid, nIl, nXl, level) {
  const out = [];
  const val = (i, j) => grid[i * nXl + j];
  for (let i = 0; i < nIl - 1; i++) {
    for (let j = 0; j < nXl - 1; j++) {
      const vA = val(i, j);          // (x=j,   y=i)
      const vB = val(i, j + 1);      // (x=j+1, y=i)
      const vC = val(i + 1, j + 1);  // (x=j+1, y=i+1)
      const vD = val(i + 1, j);      // (x=j,   y=i+1)
      if (vA === NULL_F32 || vB === NULL_F32 || vC === NULL_F32 || vD === NULL_F32) continue;
      let mask = 0;
      if (vA >= level) mask |= 1;
      if (vB >= level) mask |= 2;
      if (vC >= level) mask |= 4;
      if (vD >= level) mask |= 8;
      if (mask === 0 || mask === 15) continue;

      const frac = (a, b) => (b === a ? 0.5 : (level - a) / (b - a));
      const top = () => [j + frac(vA, vB), i];
      const right = () => [j + 1, i + frac(vB, vC)];
      const bottom = () => [j + frac(vD, vC), i + 1];
      const left = () => [j, i + frac(vA, vD)];
      const seg = (p, q) => out.push(p[0], p[1], q[0], q[1]);

      switch (mask) {
        case 1: case 14: seg(left(), top()); break;
        case 2: case 13: seg(top(), right()); break;
        case 4: case 11: seg(right(), bottom()); break;
        case 8: case 7: seg(bottom(), left()); break;
        case 3: case 12: seg(left(), right()); break;
        case 6: case 9: seg(top(), bottom()); break;
        case 5: {   // A & C high — resolve the saddle with the centre mean
          if ((vA + vB + vC + vD) / 4 >= level) {
            seg(left(), bottom()); seg(top(), right());
          } else {
            seg(top(), left()); seg(right(), bottom());
          }
          break;
        }
        case 10: {  // B & D high
          if ((vA + vB + vC + vD) / 4 >= level) {
            seg(top(), left()); seg(right(), bottom());
          } else {
            seg(top(), right()); seg(left(), bottom());
          }
          break;
        }
        default: break;
      }
    }
  }
  return Float32Array.from(out);
}

/**
 * Chain a level's segment soup into polylines (for stroking and for
 * placing value labels along the line). Adjacent cells produce bitwise-
 * identical endpoints on their shared edge, so exact-key matching chains
 * everything; open lines end at nulls / the survey edge, closed loops
 * come back to their first point.
 *
 * @returns {Float32Array[]} polylines as [x0, y0, x1, y1, ...] node units
 */
export function contourPolylines(grid, nIl, nXl, level) {
  const soup = contourSegments(grid, nIl, nXl, level);
  const nSeg = soup.length / 4;
  const key = (x, y) => `${Math.round(x * 4096)}:${Math.round(y * 4096)}`;
  const adj = new Map();   // endpoint key -> [segIndex, whichEnd][]
  for (let s = 0; s < nSeg; s++) {
    for (const e of [0, 1]) {
      const k = key(soup[s * 4 + e * 2], soup[s * 4 + e * 2 + 1]);
      let l = adj.get(k);
      if (!l) { l = []; adj.set(k, l); }
      l.push([s, e]);
    }
  }
  const used = new Uint8Array(nSeg);
  const out = [];
  for (let s0 = 0; s0 < nSeg; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const pts = [
      [soup[s0 * 4], soup[s0 * 4 + 1]],
      [soup[s0 * 4 + 2], soup[s0 * 4 + 3]],
    ];
    for (const atTail of [true, false]) {
      let guard = nSeg;
      while (guard-- > 0) {
        const tip = atTail ? pts[pts.length - 1] : pts[0];
        const cands = adj.get(key(tip[0], tip[1])) || [];
        const next = cands.find(([s]) => !used[s]);
        if (!next) break;
        const [s, e] = next;
        used[s] = 1;
        const p = [soup[s * 4 + (e === 0 ? 2 : 0)], soup[s * 4 + (e === 0 ? 3 : 1)]];
        if (atTail) pts.push(p);
        else pts.unshift(p);
      }
    }
    const flat = new Float32Array(pts.length * 2);
    pts.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
    out.push(flat);
  }
  return out;
}

/**
 * RGBA pixel buffer (nXl wide, nIl tall, row = inline) for the map's
 * color fill: linear zMin..zMax through the LUT, nulls transparent.
 * @param {Uint8Array} lut 256x4 RGBA (shaderChunks buildLut)
 * @returns {Uint8ClampedArray} nXl * nIl * 4
 */
export function buildMapPixels(grid, nIl, nXl, lut, zMin, zMax) {
  const out = new Uint8ClampedArray(nIl * nXl * 4);
  const span = zMax - zMin;
  for (let i = 0; i < nIl; i++) {
    for (let j = 0; j < nXl; j++) {
      const v = grid[i * nXl + j];
      if (v === NULL_F32 || !Number.isFinite(v)) continue;
      const f = span > 0 ? (v - zMin) / span : 0.5;
      const li = Math.max(0, Math.min(255, Math.round(f * 255))) * 4;
      const o = (i * nXl + j) * 4;
      out[o] = lut[li];
      out[o + 1] = lut[li + 1];
      out[o + 2] = lut[li + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Even-odd (ray-cast) point-in-polygon — handles concave polygons, which
 * the convex-hull test in gridding.js deliberately does not.
 * @param {ArrayLike<number>} poly flat vertices [x0, y0, x1, y1, ...]
 */
export function pointInPolygon(poly, x, y) {
  const n = poly.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Grid cells whose CENTRES (xl + 0.5, il + 0.5) fall inside a polygon in
 * map world coordinates (x = crossline index, y = inline index).
 * Bbox-bounded scan; the erase tools feed this for both rectangles
 * (4-vertex polygon) and hand-drawn outlines.
 * @returns {Int32Array} cell indices (il * nXl + xl)
 */
export function cellsInPolygon(poly, nIl, nXl) {
  if (poly.length < 6) return new Int32Array(0);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    xMin = Math.min(xMin, poly[i]);
    xMax = Math.max(xMax, poly[i]);
    yMin = Math.min(yMin, poly[i + 1]);
    yMax = Math.max(yMax, poly[i + 1]);
  }
  const x0 = Math.max(0, Math.floor(xMin));
  const x1 = Math.min(nXl - 1, Math.ceil(xMax));
  const i0 = Math.max(0, Math.floor(yMin));
  const i1 = Math.min(nIl - 1, Math.ceil(yMax));
  const out = [];
  for (let i = i0; i <= i1; i++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInPolygon(poly, x + 0.5, i + 0.5)) out.push(i * nXl + x);
    }
  }
  return Int32Array.from(out);
}

/**
 * Min/max of a grid ignoring nulls.
 * @returns {{zMin: number|null, zMax: number|null}}
 */
export function gridRange(grid) {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let k = 0; k < grid.length; k++) {
    const v = grid[k];
    if (v === NULL_F32 || !Number.isFinite(v)) continue;
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  return zMin === Infinity ? { zMin: null, zMax: null } : { zMin, zMax };
}
