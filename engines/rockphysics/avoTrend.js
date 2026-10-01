// Wet background trend on the intercept-gradient crossplot (Rock Physics
// Studio U2-002, 2026-10-01).
//
// Brine-filled sands and shales plot along a line through the origin of the
// (A, B) plane, the "fluid line"; hydrocarbons pull an interface off it.
// Castagna, Swan and Foster (1998, Geophysics 63, 948) give its slope for a
// background with a constant Vp/Vs and a Gardner density (rho ~ Vp^g):
//
//   B / A = (1 - 4 (Vs/Vp)^2 (g + 2)) / (1 + g)
//
// which for g = 1/4 is (4/5) (1 - 9 (Vs/Vp)^2), and for Vp/Vs = 2 is the
// well known B = -A (for any density exponent). The line can also be fitted to the interfaces of a
// well's own brine-filled logs; an interface's anomaly is then its signed
// distance from the line.
//
// Intercepts and gradients come from ./avo shuey (oracle validated).
// Pure math, no I/O.

import { shuey } from './avo';

/** Slope B/A of the fluid line for a constant Vs/Vp and a Gardner exponent. */
export function backgroundSlope(vsOverVp, gardnerExponent = 0.25) {
  if (!(vsOverVp > 0 && vsOverVp < 1)) throw new Error('Vs/Vp must be between 0 and 1.');
  if (!(gardnerExponent >= 0)) throw new Error('The Gardner exponent must be zero or more.');
  return (1 - 4 * vsOverVp * vsOverVp * (gardnerExponent + 2)) / (1 + gardnerExponent);
}

/**
 * Block means of the logs over the given sample indices: `blockSamples`
 * consecutive usable samples per block (the last short block is kept when
 * it has at least half a block).
 * @returns {Array<{vp: number, vs: number, rho: number, from: number, to: number, n: number}>}
 */
export function blockLogs(vp, vs, rho, indices, blockSamples = 1) {
  const size = Math.max(1, Math.round(blockSamples));
  const blocks = [];
  let acc = null;
  const flush = (force) => {
    if (acc && (acc.n >= size || (force && acc.n >= Math.ceil(size / 2)))) {
      blocks.push({ vp: acc.vp / acc.n, vs: acc.vs / acc.n, rho: acc.rho / acc.n, from: acc.from, to: acc.to, n: acc.n });
    }
    acc = null;
  };
  for (const i of indices) {
    const p = vp[i]; const s = vs[i]; const r = rho[i];
    if (!(p > 0) || !(s > 0) || !(r > 0) || !(s < p)) continue;
    if (!acc) acc = { vp: 0, vs: 0, rho: 0, n: 0, from: i, to: i };
    acc.vp += p; acc.vs += s; acc.rho += r; acc.n += 1; acc.to = i;
    if (acc.n >= size) flush(false);
  }
  flush(true);
  return blocks;
}

/**
 * Intercept and gradient of every interface between consecutive blocks
 * (Shuey's A and B). Interfaces with no contrast are skipped.
 * @returns {Array<{a: number, b: number, at: number}>} `at` = first sample of the lower block
 */
export function interfacePoints(blocks) {
  const pts = [];
  for (let k = 1; k < blocks.length; k++) {
    const u = blocks[k - 1]; const l = blocks[k];
    if (u.vp === l.vp && u.vs === l.vs && u.rho === l.rho) continue;
    const { a, b } = shuey(u.vp, u.vs, u.rho, l.vp, l.vs, l.rho, 0);
    if (Number.isFinite(a) && Number.isFinite(b)) pts.push({ a, b, at: l.from });
  }
  return pts;
}

/**
 * The fluid line through the origin fitted to (A, B) points: the principal
 * axis of the points about the origin (total least squares, so neither A
 * nor B is treated as error free).
 * @returns {{slope: number, angleDeg: number, n: number, rmsDistance: number}}
 */
export function fitFluidLine(points) {
  const pts = points.filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b));
  if (pts.length < 3) throw new Error('A fluid line needs at least three interfaces.');
  let saa = 0; let sbb = 0; let sab = 0;
  for (const p of pts) { saa += p.a * p.a; sbb += p.b * p.b; sab += p.a * p.b; }
  if (!(saa + sbb > 0)) throw new Error('Every interface has zero intercept and gradient: there is no trend to fit.');
  // direction (cos t, sin t) maximising the projected energy
  const t = 0.5 * Math.atan2(2 * sab, saa - sbb);
  const c = Math.cos(t); const s = Math.sin(t);
  if (Math.abs(c) < 1e-12) throw new Error('The fitted trend is vertical (no spread in the intercept).');
  const line = { slope: s / c, angleDeg: (t * 180) / Math.PI, n: pts.length };
  let ss = 0;
  for (const p of pts) ss += distanceFromLine(p.a, p.b, line) ** 2;
  return { ...line, rmsDistance: Math.sqrt(ss / pts.length) };
}

/**
 * Signed perpendicular distance of (a, b) from the line B = slope x A.
 * Negative is below and to the left of a falling line: the side a
 * hydrocarbon sand moves to (lower intercept and gradient).
 */
export function distanceFromLine(a, b, line) {
  const m = line.slope;
  return (b - m * a) / Math.sqrt(1 + m * m);
}
