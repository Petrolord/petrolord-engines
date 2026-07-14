// Fault blocks (Earth Modeling G8.1): app-owned fault polygons in
// world XY partition the model grid into blocks (plan decision 1 — no
// shared fault-polygon registry exists yet). Even-odd ray crossing
// (PNPOLY formulation); label = 1 + index of the FIRST containing
// polygon, 0 = outside all. Pure functions, no I/O.

/** Normalize a vertex ([x, y] pair or {x, y} object) to [x, y]. */
const vxy = (v) => (Array.isArray(v) ? v : [v.x, v.y]);

/**
 * Validate a fault polygon: >= 3 finite vertices, non-degenerate
 * area, no self-intersection. Throws with a specific message.
 * @param {Array<[number,number]|{x:number,y:number}>} verts closed implicitly
 */
export function validatePolygon(verts) {
  if (!Array.isArray(verts) || verts.length < 3) {
    throw new Error('A fault polygon needs at least 3 vertices.');
  }
  const pts = verts.map(vxy);
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Fault polygon vertices must be finite numbers.');
    }
  }
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area2 += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area2) < 1e-9) {
    throw new Error('Fault polygon is degenerate (zero area).');
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      // Skip adjacent edges (they share a vertex by construction).
      if (j === i || (j + 1) % pts.length === i || (i + 1) % pts.length === j) continue;
      if (segmentsCross(pts[i], pts[(i + 1) % pts.length], pts[j], pts[(j + 1) % pts.length])) {
        throw new Error('Fault polygon must not self-intersect.');
      }
    }
  }
  return pts;
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) &&
    o(a, b, c) !== 0 && o(a, b, d) !== 0;
}

/**
 * Even-odd point-in-polygon test.
 * @param {number} x @param {number} y
 * @param {Array<[number,number]|{x,y}>} verts closed implicitly
 */
export function pointInPolygon(x, y, verts) {
  const pts = verts.map(vxy);
  let inside = false;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    if ((y1 > y) !== (y2 > y)) {
      const xin = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
      if (x < xin) inside = !inside;
    }
  }
  return inside;
}

/**
 * Per-node block labels on a model spec.
 * @param {{x0,y0,dx,dy,nx,ny}} spec
 * @param {Array<Array>} polygons validated fault polygons
 * @returns {Int32Array} length nx*ny; 0 outside all polygons
 */
export function labelBlocks(spec, polygons) {
  const polys = (polygons || []).map(validatePolygon);
  const labels = new Int32Array(spec.nx * spec.ny);
  for (let r = 0; r < spec.ny; r++) {
    const y = spec.y0 + r * spec.dy;
    for (let c = 0; c < spec.nx; c++) {
      const x = spec.x0 + c * spec.dx;
      let lab = 0;
      for (let i = 0; i < polys.length; i++) {
        if (pointInPolygon(x, y, polys[i])) { lab = i + 1; break; }
      }
      labels[r * spec.nx + c] = lab;
    }
  }
  return labels;
}

/** Node count per block label. @returns {Object<string, number>} */
export function blockCensus(labels) {
  const out = {};
  for (const lab of labels) out[lab] = (out[lab] || 0) + 1;
  return out;
}
