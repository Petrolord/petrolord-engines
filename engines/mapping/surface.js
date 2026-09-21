// Surface engine (Mapping & Surface Studio G4.1): registry data ->
// control points, grid spec derivation, bilinear resample to a common
// frame, and two-surface / scalar math. The gridding itself is the
// shared, byte-golden-validated engine (src/lib/gridding); this layer
// is the app-specific glue around it. Pure functions, no I/O.
//
// Grid convention (matches src/lib/gridding): z is a row-major
// Float32Array of nx*ny, z[r*nx + c], with world x[c] = x0 + c*dx and
// y[r] = y0 + r*dy. NULL_VALUE (1e30) marks empty nodes.
//
// G8.1: the generic grid math (resample / combine / stats) moved to
// the shared src/lib/gridding/gridmath.js at its second consumer
// (Earth Modeling); re-exported here so this module's API is unchanged.

import { makeDepthFrame } from '../welldata/checkshots.js';

export {
  resampleTo,
  combine,
  isochore,
  thickness,
  scalarAdd,
  maskOutsidePolygon,
  convertZUnit,
  surfaceStats,
} from '../../lib/gridding/gridmath';

/**
 * Depth references a structure map can be built in. `tvdss` and `tvd`
 * produce ELEVATION values (negative below datum, the geo_surfaces
 * convention since 2026-09-05); `md` is the raw measured depth,
 * positive, kept for attribute-style uses and legacy callers.
 */
export const STRUCTURE_DEPTH_REFS = ['md', 'tvd', 'tvdss'];
/** Where a top's control point is posted: the borehole position at the
 *  top's MD (what Petrel maps) or the wellhead. */
export const STRUCTURE_PLACEMENTS = ['borehole', 'surface'];
/** Fixed skip reasons, rendered by the workstation. */
export const CONTROL_POINT_SKIP_REASONS = Object.freeze({
  no_top: 'no such top',
  no_location: 'no surface location',
  bad_md: 'non-numeric top depth',
  bad_survey: 'unusable deviation survey',
  above_survey: 'top above the survey',
});

/**
 * Control points for a named top across wells (a structure map), placed
 * through each well's depth frame (survey + KB).
 * @param {Array<{name, surface_x, surface_y, kb_m?, td_md_m?, deviation?, tops:Array<{name, md_m}>}>} wells
 * @param {string} topName
 * @param {{depthRef?: 'md'|'tvd'|'tvdss', placement?: 'borehole'|'surface'}} [opts]
 * @returns {{points: Array<{x, y, z, well, md, extrapolated}>,
 *   skipped: Array<{well, reason, detail?}>, extrapolated: number,
 *   depthRef: string, placement: string}}
 */
export function topsToControlPoints(wells, topName, { depthRef = 'tvdss', placement = 'borehole' } = {}) {
  if (!STRUCTURE_DEPTH_REFS.includes(depthRef)) throw new Error(`Unknown depth reference "${depthRef}" (expected md, tvd or tvdss).`);
  if (!STRUCTURE_PLACEMENTS.includes(placement)) throw new Error(`Unknown placement "${placement}" (expected borehole or surface).`);
  const points = [];
  const skipped = [];
  let extrapolated = 0;
  for (const w of wells || []) {
    const well = w.name;
    const t = (w.tops || []).find((x) => x.name === topName);
    if (!t) { skipped.push({ well, reason: 'no_top' }); continue; }
    if (!Number.isFinite(w.surface_x) || !Number.isFinite(w.surface_y)) { skipped.push({ well, reason: 'no_location' }); continue; }
    const md = Number(t.md_m);
    if (!Number.isFinite(md)) { skipped.push({ well, reason: 'bad_md', detail: String(t.md_m) }); continue; }
    let frame;
    try {
      frame = makeDepthFrame({ deviation: w.deviation, kbM: w.kb_m ?? 0, tdMdM: w.td_md_m });
    } catch (e) {
      skipped.push({ well, reason: 'bad_survey', detail: e.message });
      continue;
    }
    let p;
    try {
      p = frame.mdToPosition(md);
    } catch (e) {
      skipped.push({ well, reason: 'above_survey', detail: e.message });
      continue;
    }
    const z = depthRef === 'md' ? md : depthRef === 'tvd' ? -p.tvd : -p.tvdss;
    const x = placement === 'borehole' ? w.surface_x + p.x : w.surface_x;
    const y = placement === 'borehole' ? w.surface_y + p.y : w.surface_y;
    if (p.extrapolated) extrapolated += 1;
    points.push({ x, y, z, well, md, extrapolated: p.extrapolated });
  }
  return { points, skipped, extrapolated, depthRef, placement };
}

/**
 * The control points alone (array shape kept for existing callers).
 * Default: TVDSS elevation at the borehole position.
 */
export function topsToPoints(wells, topName, opts) {
  return topsToControlPoints(wells, topName, opts).points;
}

/**
 * Control points from a zone attribute (an attribute map): z =
 * geo_wells_zones.properties[key] for the named zone on each well.
 * @param {Array} wells each {surface_x,surface_y,zones:[{name,properties}]}
 */
export function zoneAttrToPoints(wells, zoneName, key) {
  const pts = [];
  for (const w of wells) {
    const z = (w.zones || []).find((x) => x.name === zoneName);
    const v = z?.properties?.[key];
    if (Number.isFinite(v) && Number.isFinite(w.surface_x)) {
      pts.push({ x: w.surface_x, y: w.surface_y, z: v, well: w.name });
    }
  }
  return pts;
}

/**
 * A grid spec bounding the control points, cell size cellM, padded by
 * padCells on each side. nx/ny capped so nx*ny stays sane.
 * @returns {{x0,y0,dx,dy,nx,ny}}
 */
export function specForPoints(points, cellM, padCells = 2) {
  if (!points.length) throw new Error('No control points to grid.');
  if (!(cellM > 0)) throw new Error('Cell size must be positive.');
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const x0 = minX - padCells * cellM;
  const y0 = minY - padCells * cellM;
  const nx = Math.max(2, Math.ceil((maxX - minX) / cellM) + 1 + 2 * padCells);
  const ny = Math.max(2, Math.ceil((maxY - minY) / cellM) + 1 + 2 * padCells);
  return { x0, y0, dx: cellM, dy: cellM, nx, ny };
}

/** Attach world x[]/y[] axis arrays to a spec+z for the export writers
 *  (which expect {x, y, z, nx, ny, dx, dy}). */
export function gridObject(spec, z) {
  const x = Array.from({ length: spec.nx }, (_, c) => spec.x0 + c * spec.dx);
  const y = Array.from({ length: spec.ny }, (_, r) => spec.y0 + r * spec.dy);
  return { x, y, z, nx: spec.nx, ny: spec.ny, dx: spec.dx, dy: spec.dy };
}

