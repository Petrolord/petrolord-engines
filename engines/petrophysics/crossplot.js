// Crossplot math (Petrophysics Studio G2.4): sample extraction, manual
// facies polygon tagging, density-neutron lithology overlays, Pickett
// iso-Sw lines and the depth-windowed water-line fit. Pure functions,
// shared engine conventions (see vsh.js): NaN-propagating, no I/O.

import { pickettFit } from './rw';

/** Ray-casting point-in-polygon. poly = [[x, y], ...] (>= 3 vertices,
 *  implicit closure). Boundary behaviour is standard ray-cast (edges
 *  count on one side) — fine for hand-drawn facies polygons. */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Finite (x, y) sample pairs for a crossplot.
 * @returns {Array<{i: number, x: number, y: number, depthM: number}>}
 */
export function crossplotSamples(xData, yData, depth) {
  const out = [];
  for (let i = 0; i < depth.length; i++) {
    const x = xData[i];
    const y = yData[i];
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ i, x, y, depthM: depth[i] });
  }
  return out;
}

/**
 * Categorical facies curve: each sample gets the index of the FIRST
 * polygon containing its (x, y), NaN when untagged/invalid — first
 * match wins so polygon order is the user's priority order.
 * @param {Array<{polygon: Array<[number, number]>}>} facies
 * @returns {Float64Array}
 */
export function faciesCurve(xData, yData, facies) {
  const out = new Float64Array(xData.length).fill(NaN);
  for (let i = 0; i < xData.length; i++) {
    const x = xData[i];
    const y = yData[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    for (let f = 0; f < facies.length; f++) {
      if (pointInPolygon(x, y, facies[f].polygon)) { out[i] = f; break; }
    }
  }
  return out;
}

/** Clean-matrix density-neutron lithology lines (x = NPHI v/v,
 *  y = RHOB g/cc), the classic chart-book quicklook trio (ported from
 *  the superseded CrossplotGenerator — endpoints unchanged). */
export const ND_LITHOLOGY_LINES = [
  { name: 'Sandstone', pts: [{ x: -0.02, y: 2.65 }, { x: 0.45, y: 1.9 }] },
  { name: 'Limestone', pts: [{ x: 0.0, y: 2.71 }, { x: 0.48, y: 2.0 }] },
  { name: 'Dolomite', pts: [{ x: 0.02, y: 2.87 }, { x: 0.46, y: 2.2 }] },
];

/** One Pickett iso-Sw line (straight in log-log): Archie inverted,
 *  Rt = a*Rw/(phi^m * Sw^n). x = RT, y = phi (the Asquith layout).
 *  Two endpoints suffice. */
export function pickettIsoSwLine(sw, { a, m, n, rw }, phiMin, phiMax) {
  const rt = (phi) => (a * rw) / (phi ** m * sw ** n);
  return { sw, pts: [{ x: rt(phiMin), y: phiMin }, { x: rt(phiMax), y: phiMax }] };
}

/**
 * Depth-windowed Pickett water-line fit: take the presumed
 * water-bearing interval [topM, baseM], fit Archie's Sw=1 line through
 * its (phi, rt) samples. Throws the rw.js domain errors when the
 * window yields < 2 valid points.
 * @returns {{m: number, aRw: number, nPoints: number}}
 */
export function pickettFitDepthWindow(depth, phi, rt, topM, baseM) {
  const pts = [];
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] < topM || depth[i] > baseM) continue;
    if (Number.isFinite(phi[i]) && phi[i] > 0 && Number.isFinite(rt[i]) && rt[i] > 0) {
      pts.push([phi[i], rt[i]]);
    }
  }
  const fit = pickettFit(pts);
  return { ...fit, nPoints: pts.length };
}
