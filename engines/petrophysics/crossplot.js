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

/**
 * One iso-BVW line for the Buckles plot (x = phi v/v, y = Sw v/v,
 * linear axes): Buckles (1965) observed that bulk volume water
 * BVW = phi*Sw is roughly constant at irreducible saturation, so each
 * constant-BVW locus Sw = bvw/phi is a hyperbola. Sampled (a curve,
 * not two endpoints); samples with Sw > swMax or phi <= 0 are dropped
 * so the locus enters the frame cleanly.
 * @returns {{bvw: number, pts: Array<{x: number, y: number}>}}
 */
export function bucklesIsoBvwLine(bvw, phiMin, phiMax, swMax = 1, nPts = 64) {
  const pts = [];
  for (let k = 0; k < nPts; k++) {
    const phi = phiMin + (k / (nPts - 1)) * (phiMax - phiMin);
    if (phi <= 0) continue;
    const sw = bvw / phi;
    if (sw <= swMax) pts.push({ x: phi, y: sw });
  }
  return { bvw, pts };
}

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

/** Hingle (1959) transform: y = Rt^(-1/m), which makes the Sw = 1
 *  locus a straight line THROUGH THE ORIGIN, y = phi / (a*Rw)^(1/m),
 *  on a phi (x) vs y plot. */
export function hingleY(rt, m) {
  return rt > 0 ? rt ** (-1 / m) : NaN;
}

/** Water line for the Hingle plot at given (a, m, rw): two points
 *  through the origin in (phi, y) space. */
export function hingleWaterLine({ a, m, rw }, phiMax) {
  const s = (a * rw) ** (-1 / m);
  return { pts: [{ x: 0, y: 0 }, { x: phiMax, y: s * phiMax }] };
}

/**
 * Depth-windowed Hingle water-line fit: least-squares slope THROUGH
 * THE ORIGIN of y = Rt^(-1/m) vs phi over the presumed water leg,
 * inverted for Rw = s^(-m) / a. m is taken as given (the Pickett fit
 * recovers m; Hingle recovers Rw at a chosen m).
 * @returns {{rw: number, slope: number, nPoints: number}}
 */
export function hingleFitDepthWindow(depth, phi, rt, topM, baseM, { a = 1, m = 2 } = {}) {
  let sxy = 0;
  let sxx = 0;
  let n = 0;
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] < topM || depth[i] > baseM) continue;
    if (!(phi[i] > 0) || !(rt[i] > 0)) continue;
    const y = hingleY(rt[i], m);
    sxy += phi[i] * y;
    sxx += phi[i] * phi[i];
    n += 1;
  }
  if (n < 2 || sxx === 0) throw new Error('Hingle fit needs at least two valid points in the window.');
  const slope = sxy / sxx;
  return { rw: slope ** (-m) / a, slope, nPoints: n };
}
