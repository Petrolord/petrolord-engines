// Well display math for the TWT viewers (Phase W2): T(z) resolution,
// dense lattice paths, and corridor projection onto sections.
//
// T(z) source priority (plan decision #4, never silently mixed): the
// well's own checkshots (piecewise linear over the validated strictly
// monotonic table, linear extrapolation at both ends) → the volume's
// velocity model INVERTED — by bisection against the app's own
// makeDepthConverter, so a well plots exactly where the depth
// conversion says, for the layer cake too → null (well is map-only).
//
// Corridor rule: a path point draws where it passes within ~1.5
// lattice cells of the section plane (fractional distance — wells are
// continuous positions, unlike stick picks), pen-breaking outside; the
// traverse case reuses projectStickToTraverse. Off-survey and
// no-time samples are kept as pen-breaks, never interpolated across.
//
// Pure math, worker-safe, no I/O.

import { computeWellPath, positionAtMd } from './wellPath';
import { worldToIlxl, cellSpacing } from './surveyGeometry';
import { makeDepthConverter } from './velocityModel';

/**
 * Resolve a well's TVDss → TWT function.
 *
 * @param {Object} p
 * @param {?{tvdss_m:number, twt_ms:number}[]} p.checkshots the well's
 *   own table (strictly monotonic — validated at import)
 * @param {?Object} p.velocity normalized volume velocity model
 * @param {?(Float32Array|null)[]} p.boundaries layer-cake boundary grids
 * @param {number} p.dtUs
 * @param {number} p.maxTwtMs volume time window bottom
 * @returns {?{toTwtMs: (tvdssM: number, cell?: number) => ?number,
 *   source: 'checkshots'|'model'}} null = no T(z), well is map-only
 */
export function makeTvdssToTwt({ checkshots, velocity, boundaries, dtUs, maxTwtMs }) {
  if (Array.isArray(checkshots) && checkshots.length >= 2) {
    const cs = checkshots;
    return {
      source: 'checkshots',
      toTwtMs(z) {
        if (!Number.isFinite(z)) return null;
        let i = 1;
        while (i < cs.length - 1 && cs[i].tvdss_m < z) i += 1;
        const a = cs[i - 1];
        const b = cs[i];
        const f = (z - a.tvdss_m) / (b.tvdss_m - a.tvdss_m);
        return a.twt_ms + f * (b.twt_ms - a.twt_ms);
      },
    };
  }
  if (velocity) {
    const conv = makeDepthConverter(velocity, { dtUs, boundaries });
    return {
      source: 'model',
      toTwtMs(z, cell) {
        if (!Number.isFinite(z) || z < 0) return null;    // above datum: no time
        if (z === 0) return 0;
        if (conv.toDepthM(maxTwtMs, cell) < z) return null; // below the window
        let lo = 0;
        let hi = maxTwtMs;
        for (let it = 0; it < 48; it++) {                 // ~1e-12 relative
          const mid = (lo + hi) / 2;
          if (conv.toDepthM(mid, cell) < z) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      },
    };
  }
  return null;
}

/** Stations of a well row: its deviation survey, or a synthesized
 *  two-station vertical from TD (the wellPath shortcut semantics). */
export function normalizeStations(well) {
  if (Array.isArray(well.deviation) && well.deviation.length >= 2) return well.deviation;
  const td = well.tdMdM
    ?? (well.path && well.path.length ? well.path[well.path.length - 1].md : null);
  if (!(td > 0)) return null;
  return [{ md: 0, inc: 0, azi: 0 }, { md: td, inc: 0, azi: 0 }];
}

/**
 * Dense lattice path + top markers of a well on one survey.
 *
 * Samples the exact minimum-curvature arc every ~stepM of MD (default:
 * half the smaller bin, clamped 5–50 m), mapping each sample through
 * the survey affine and the resolved T(z). Samples outside the survey
 * or without a time keep a null `s` so drawing pen-breaks there.
 *
 * @param {{deviation?: Array, tdMdM?: number, path?: Array,
 *   surfaceX: number, surfaceY: number, kbM?: number,
 *   tops?: {name:string, md:number}[]}} well
 * @param {Object} p
 * @param {Object} p.affine resolved survey affine
 * @param {{toTwtMs: Function}} p.timeConv from makeTvdssToTwt
 * @param {{nIl:number, nXl:number, ns:number}} p.geom
 * @param {number} p.dtUs
 * @param {number} [p.stepM]
 * @returns {?{points: {md:number, il:number, xl:number, s:?number}[],
 *   tops: {name:string, md:number, il:number, xl:number, s:?number}[]}}
 */
export function buildWellLatticePath(well, { affine, timeConv, geom, dtUs, stepM }) {
  const stations = normalizeStations(well);
  if (!stations || !affine || !timeConv) return null;
  const opts = { surfaceX: well.surfaceX, surfaceY: well.surfaceY, kb: well.kbM || 0 };
  let path;
  try {
    path = computeWellPath(stations, opts);
  } catch {
    return null;
  }
  const dtMs = dtUs / 1000;
  const spacing = cellSpacing(affine);
  const step = stepM || Math.min(50, Math.max(5, Math.min(spacing.il, spacing.xl) / 2));

  const toLattice = (pos) => {
    const ij = worldToIlxl(affine, pos.x, pos.y);
    if (!ij) return null;
    const inSurvey = ij.i >= -0.5 && ij.i <= geom.nIl - 0.5
      && ij.j >= -0.5 && ij.j <= geom.nXl - 0.5;
    let s = null;
    if (inSurvey) {
      const cell = Math.min(geom.nIl - 1, Math.max(0, Math.round(ij.i))) * geom.nXl
        + Math.min(geom.nXl - 1, Math.max(0, Math.round(ij.j)));
      const twt = timeConv.toTwtMs(pos.tvdss, cell);
      if (twt != null && twt >= 0 && twt / dtMs < geom.ns) s = twt / dtMs;
    }
    return { il: ij.i, xl: ij.j, s };
  };

  const md0 = stations[0].md;
  const md1 = stations[stations.length - 1].md;
  const points = [];
  for (let md = md0; md < md1; md += step) {
    const q = toLattice(positionAtMd(stations, path, md));
    if (q) points.push({ md, ...q });
  }
  const qEnd = toLattice(path[path.length - 1]);
  if (qEnd) points.push({ md: md1, ...qEnd });
  if (!points.some((q) => q.s != null)) return null;      // never enters the window

  const tops = [];
  for (const t of well.tops || []) {
    if (!Number.isFinite(t.md) || t.md < md0 || t.md > md1) continue;
    const q = toLattice(positionAtMd(stations, path, t.md));
    if (q && q.s != null) tops.push({ name: t.name, md: t.md, ...q });
  }
  return { points, tops };
}

/**
 * Corridor projection onto an inline/xline section: an array aligned
 * with `points` — {trace, s, dist} inside the corridor, null outside
 * (pen-break) or where the point has no time. The traverse analog is
 * projectStickToTraverse (engine/traverse.js) on the same points.
 *
 * @param {{il:number, xl:number, s:?number}[]} points
 * @param {'inline'|'xline'} orientation
 * @param {number} index section line index
 * @param {number} [maxDist] corridor half-width in lattice cells
 * @returns {?({trace:number, s:number, dist:number}|null)[]}
 */
export function projectWellToSection(points, orientation, index, maxDist = 1.5) {
  if (!points || !points.length) return null;
  const out = new Array(points.length).fill(null);
  let any = false;
  for (let i = 0; i < points.length; i++) {
    const q = points[i];
    if (q.s == null) continue;
    const d = orientation === 'inline' ? Math.abs(q.il - index) : Math.abs(q.xl - index);
    if (d > maxDist) continue;
    out[i] = { trace: orientation === 'inline' ? q.xl : q.il, s: q.s, dist: d };
    any = true;
  }
  return any ? out : null;
}
