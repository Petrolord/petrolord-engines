// Depth conversion tied to wells (Mapping & Surface Studio T1 finding
// MAP-T1-009, 2026-09-26).
//
// The routine depth conversion in a well-controlled basin (the Niger
// Delta practice) does not start from a velocity cube: at every well the
// top's depth below datum and the horizon's two-way time at that well
// give an average velocity from datum to the horizon,
//
//   Vavg = Z / (TWT / 2)          Z in m below datum, TWT in s, Vavg in m/s
//
// Vavg is gridded between the wells (it varies far more smoothly than
// depth), and depth follows node by node as Z = Vavg * TWT / 2, so the
// map honours every well by construction. Any other conversion (a linear
// V0 + kZ function, a velocity model) is checked with the tie residuals
// r = well elevation - map elevation at each well, which a residual
// correction (Earth Modeling's residualField) spreads over the grid.
//
// Conventions: datum is the seismic reference datum of the time surface
// (sea level unless the caller says otherwise); depths below datum are
// positive metres in, elevations (negative below datum) out, matching
// the geo_surfaces rule. Pure functions, no I/O. Validated against
// tools/validation/mapping/oracle_welltie.py (closed-form linear
// velocity: t(z) = ln(1 + k z / v0) / k one-way).

import { NULL_VALUE } from '../../lib/gridding/numeric';
import { isNull, sampleAtXY } from '../../lib/gridding/gridmath';

export const TIE_SKIP_REASONS = Object.freeze({
  no_twt: 'the time surface has no value at this well',
  bad_depth: 'the top depth below datum is missing or not positive',
  bad_twt: 'the two-way time at this well is not positive',
});

/**
 * Average velocity from datum to the horizon at each well.
 * @param {Array<{well:string,x:number,y:number,depthM:number}>} wells
 *   depthM: the top's depth below datum, metres, positive down
 * @param {ArrayLike<number>} twtMs TWT grid in ms (positive), on `spec`
 * @param {{x0,y0,dx,dy,nx,ny,rotation_deg?}} spec
 * @returns {{ties:Array<{well,x,y,depthM,twtMs,vavg}>, skipped:Array<{well,reason}>}}
 */
export function averageVelocityTies(wells, twtMs, spec) {
  const ties = [];
  const skipped = [];
  for (const w of wells || []) {
    if (!(Number.isFinite(w.depthM) && w.depthM > 0)) { skipped.push({ well: w.well, reason: 'bad_depth' }); continue; }
    const t = sampleAtXY(twtMs, spec, w.x, w.y);
    if (isNull(t)) { skipped.push({ well: w.well, reason: 'no_twt' }); continue; }
    if (!(t > 0)) { skipped.push({ well: w.well, reason: 'bad_twt' }); continue; }
    ties.push({ well: w.well, x: w.x, y: w.y, depthM: w.depthM, twtMs: t, vavg: w.depthM / (t / 2000) });
  }
  return { ties, skipped };
}

/**
 * Depth from TWT and an average-velocity grid on the same frame.
 * @returns {Float64Array} elevation in metres (negative below datum); a
 *   null in either input, or a non-positive velocity, gives a null node
 */
export function depthFromAverageVelocity(twtMs, vavg) {
  if (twtMs.length !== vavg.length) throw new Error('The velocity grid must share the time surface frame.');
  const out = new Float64Array(twtMs.length);
  for (let i = 0; i < out.length; i++) {
    const t = twtMs[i]; const v = vavg[i];
    out[i] = isNull(t) || isNull(v) || !(v > 0) ? NULL_VALUE : -(v * t) / 2000;
  }
  return out;
}

/**
 * Mis-tie of a depth map at the wells.
 * @param {Array<{well,x,y,depthM}>} wells depthM below datum, positive
 * @param {ArrayLike<number>} zElev elevation grid in metres
 * @returns {Array<{well,x,y,wellZ:number,mapZ:number|null,residualM:number|null}>}
 *   residualM = well elevation - map elevation (positive: the well came
 *   in shallower than the map); null where the map is null at the well
 */
export function tieResiduals(wells, zElev, spec) {
  return (wells || []).filter((w) => Number.isFinite(w.depthM)).map((w) => {
    const m = sampleAtXY(zElev, spec, w.x, w.y);
    const wellZ = -w.depthM;
    return { well: w.well, x: w.x, y: w.y, wellZ, mapZ: isNull(m) ? null : m, residualM: isNull(m) ? null : wellZ - m };
  });
}

/** Summary of a residual table: count, mean, RMS and worst absolute mis-tie (m). */
export function residualStats(rows) {
  const r = (rows || []).map((x) => x.residualM).filter((v) => Number.isFinite(v));
  if (!r.length) return { count: 0, mean: null, rms: null, maxAbs: null };
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const rms = Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length);
  return { count: r.length, mean, rms, maxAbs: Math.max(...r.map(Math.abs)) };
}
