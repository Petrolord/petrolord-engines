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

export {
  resampleTo,
  combine,
  isochore,
  scalarAdd,
  surfaceStats,
} from '../../lib/gridding/gridmath';

/**
 * Control points {x,y,z} for a named top across wells (a structure
 * map): surface X/Y from the well, z = the top's MD. Wells lacking the
 * top are skipped.
 * @param {Array<{surface_x,surface_y,tops:Array<{name,md_m}>}>} wells
 */
export function topsToPoints(wells, topName) {
  const pts = [];
  for (const w of wells) {
    const t = (w.tops || []).find((x) => x.name === topName);
    if (t && Number.isFinite(t.md_m) && Number.isFinite(w.surface_x)) {
      pts.push({ x: w.surface_x, y: w.surface_y, z: t.md_m, well: w.name });
    }
  }
  return pts;
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

