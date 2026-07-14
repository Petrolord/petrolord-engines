// Well ties (Earth Modeling G8.1): minimum-curvature trajectories
// from the registry deviation shape ({md, inc, azi} degrees, jsonb on
// geo_wells), top TVDSS, well-tie residuals against framework
// surfaces, and zone-midpoint control points for property population.
// Pure functions, no I/O; oracle-validated.
//
// Conventions: MD/TVD metres below KB; TVDSS = TVD − kb_m, metres
// positive down below MSL (model z datum, plan decision 3). Between
// stations positions interpolate LINEARLY in MD (documented v1
// convention, matched by the oracle).

import { sampleAtXY, isNull } from '../../lib/gridding/gridmath';

/**
 * Minimum-curvature trajectory (ratio-factor formulation, the
 * wellpath-kernel / SPE textbook form). A vertical md-0 start is
 * implied; stations with non-increasing MD are skipped.
 * @param {Array<{md,inc,azi}>} deviation degrees, md ascending
 * @param {number} kbM kelly bushing above MSL
 * @param {number} x0 @param {number} y0 wellhead world XY
 * @returns {Array<{md,x,y,tvd,tvdss}>}
 */
export function minCurvature(deviation, kbM, x0, y0) {
  const sts = [{ md: 0, inc: 0, azi: 0 }];
  for (const d of deviation || []) {
    if (Number.isFinite(d?.md) && d.md > sts[sts.length - 1].md) {
      sts.push({ md: d.md, inc: d.inc || 0, azi: d.azi || 0 });
    }
  }
  const rad = (deg) => (deg * Math.PI) / 180;
  const out = [{ md: 0, x: x0, y: y0, tvd: 0, tvdss: -(kbM || 0) }];
  for (let i = 1; i < sts.length; i++) {
    const a = sts[i - 1];
    const b = sts[i];
    const dmd = b.md - a.md;
    const i1 = rad(a.inc);
    const i2 = rad(b.inc);
    const a1 = rad(a.azi);
    const a2 = rad(b.azi);
    const cosd = Math.cos(i2 - i1) - Math.sin(i1) * Math.sin(i2) * (1 - Math.cos(a2 - a1));
    const dog = Math.acos(Math.max(-1, Math.min(1, cosd)));
    const rf = dog <= 1e-4 ? 1 : (2 / dog) * Math.tan(dog / 2);
    const dn = (dmd / 2) * (Math.sin(i1) * Math.cos(a1) + Math.sin(i2) * Math.cos(a2)) * rf;
    const de = (dmd / 2) * (Math.sin(i1) * Math.sin(a1) + Math.sin(i2) * Math.sin(a2)) * rf;
    const dz = (dmd / 2) * (Math.cos(i1) + Math.cos(i2)) * rf;
    const p = out[out.length - 1];
    out.push({ md: b.md, x: p.x + de, y: p.y + dn, tvd: p.tvd + dz, tvdss: p.tvd + dz - (kbM || 0) });
  }
  return out;
}

/**
 * Position at an MD by linear-in-MD interpolation between stations;
 * clamps to the first/last station outside the surveyed range.
 * @returns {{x,y,tvd,tvdss}}
 */
export function positionAtMd(traj, md) {
  if (md <= traj[0].md) {
    const t = traj[0];
    return { x: t.x, y: t.y, tvd: t.tvd, tvdss: t.tvdss };
  }
  for (let i = 1; i < traj.length; i++) {
    if (md <= traj[i].md) {
      const a = traj[i - 1];
      const b = traj[i];
      const f = (md - a.md) / (b.md - a.md);
      return {
        x: a.x + f * (b.x - a.x),
        y: a.y + f * (b.y - a.y),
        tvd: a.tvd + f * (b.tvd - a.tvd),
        tvdss: a.tvdss + f * (b.tvdss - a.tvdss),
      };
    }
  }
  const t = traj[traj.length - 1];
  return { x: t.x, y: t.y, tvd: t.tvd, tvdss: t.tvdss };
}

/**
 * Well-tie QC rows: residual = top TVDSS − surface z at the top's
 * along-path location (positive ⇒ the pick sits deeper than the
 * surface). Null surface samples give residual null — reported, never
 * silently dropped (plan decision 3).
 * @param {Array<{name,x,y,kb_m,deviation,tops:Array<{name,md_m}>}>} wells
 * @param {Array<Float32Array|Float64Array>} clamped framework grids
 * @param {{x0,y0,dx,dy,nx,ny}} spec model frame
 * @param {Object<string, number>} surfIndexByTop top name -> surface index
 * @returns {Array<{well,top,md,x,y,tvdss,surfaceZ,residualM}>}
 */
export function wellTies(wells, clamped, spec, surfIndexByTop) {
  const rows = [];
  for (const w of wells) {
    const traj = minCurvature(w.deviation, w.kb_m, w.x, w.y);
    for (const top of w.tops || []) {
      const idx = surfIndexByTop[top.name];
      if (idx === undefined || !clamped[idx]) continue;
      const pos = positionAtMd(traj, top.md_m);
      const zs = sampleAtXY(clamped[idx], spec, pos.x, pos.y);
      const live = !isNull(zs);
      rows.push({
        well: w.name,
        top: top.name,
        md: top.md_m,
        x: pos.x,
        y: pos.y,
        tvdss: pos.tvdss,
        surfaceZ: live ? zs : null,
        residualM: live ? pos.tvdss - zs : null,
      });
    }
  }
  return rows;
}

/**
 * Zone control points for property population: XY at the zone
 * interval's MD midpoint along the well path (plan decision 4),
 * weight = interval length.
 * @param {Array<{name,x,y,kb_m,deviation,zones:Array<{name,top_md_m,base_md_m}>}>} wells
 * @param {string} zoneName
 * @returns {Array<{well,x,y,tvdss,w}>}
 */
export function zoneControlPoints(wells, zoneName) {
  const pts = [];
  for (const w of wells) {
    const zone = (w.zones || []).find((z) => z.name === zoneName);
    if (!zone || !Number.isFinite(zone.top_md_m) || !Number.isFinite(zone.base_md_m)) continue;
    const traj = minCurvature(w.deviation, w.kb_m, w.x, w.y);
    const pos = positionAtMd(traj, (zone.top_md_m + zone.base_md_m) / 2);
    pts.push({ well: w.name, x: pos.x, y: pos.y, tvdss: pos.tvdss, w: zone.base_md_m - zone.top_md_m });
  }
  return pts;
}
