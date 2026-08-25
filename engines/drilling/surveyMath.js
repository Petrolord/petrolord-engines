// Drilling survey-computation layer (Well Design Studio WD0).
//
// Wraps the validated seismolord minimum-curvature kernel (single source
// of truth for tangent/dogleg/RF/path/interpolation — never duplicated)
// and adds the directional-drilling quantities Compass-class planning
// needs: exact attitude interpolation on the minimum-curvature arc,
// dogleg severity in both industry conventions, true vertical section,
// wellhead-relative closure, TVD-plane crossings, MD resampling and the
// full survey table.
//
// Conventions (inherited from engines/seismolord/wellPath.js): inc/azi
// in degrees, azimuth clockwise from grid north (north = +Y/+N,
// east = +X/+E), TVD positive down below KB, TVDss = TVD − KB. MD and
// lengths are in the caller's depth unit ('m' or 'ft'); dogleg-severity
// reporting intervals are 30 m and 100 ft with the exact identity
// DLS[°/100ft] = DLS[°/30m] · 30.48/30.
//
// Pure math, worker-safe, no I/O. Validated against the analytic
// goldens in test-data/drilling/goldens/ (tools/validation/drilling/).

import {
  tangent, doglegRad, ratioFactor, toGridAzimuths,
  computeWellPath, positionAtMd, verticalWellPath,
} from '../seismolord/wellPath.js';

export {
  tangent, doglegRad, ratioFactor, toGridAzimuths,
  computeWellPath, positionAtMd, verticalWellPath,
};

const DEG = Math.PI / 180;
const FT_PER_M = 1 / 0.3048;

/** Normalize an azimuth in degrees to [0, 360). */
export function normalizeAzi(azi) {
  return ((azi % 360) + 360) % 360;
}

/** Shortest signed angular difference a2 − a1 in degrees, in (−180, 180]. */
export function wrapDeltaDeg(a1, a2) {
  let d = (a2 - a1) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Attitude {inc, azi} from a unit tangent {e, n, v}. Vertical tangents
 *  have undefined azimuth; fallbackAzi (default 0) is used there. */
export function attitudeFromTangent(t, fallbackAzi = 0) {
  const inc = Math.acos(Math.max(-1, Math.min(1, t.v))) / DEG;
  const h = Math.hypot(t.e, t.n);
  const azi = h < 1e-12 ? normalizeAzi(fallbackAzi)
    : normalizeAzi(Math.atan2(t.e, t.n) / DEG);
  return { inc, azi };
}

/**
 * Attitude at an arbitrary MD by exact tangent slerp on the
 * minimum-curvature circular arc of the containing interval:
 *   t(f) = [sin((1−f)β)·t1 + sin(fβ)·t2] / sin β,   β→0 limit: t1.
 * Returns null outside the surveyed MD range.
 */
export function attitudeAtMd(stations, md) {
  const last = stations[stations.length - 1];
  if (!Number.isFinite(md) || md < stations[0].md || md > last.md) return null;
  let i = 1;
  while (i < stations.length - 1 && stations[i].md < md) i += 1;
  const s1 = stations[i - 1];
  const s2 = stations[i];
  const f = (md - s1.md) / (s2.md - s1.md);
  const beta = doglegRad(s1.inc, s1.azi, s2.inc, s2.azi);
  if (beta < 1e-9) {
    // Straight (or vanishing-dogleg) interval: attitude is constant.
    return { inc: s1.inc, azi: normalizeAzi(s1.azi) };
  }
  const t1 = tangent(s1.inc, s1.azi);
  const t2 = tangent(s2.inc, s2.azi);
  const sb = Math.sin(beta);
  const a = Math.sin((1 - f) * beta) / sb;
  const b = Math.sin(f * beta) / sb;
  const t = { e: a * t1.e + b * t2.e, n: a * t1.n + b * t2.n, v: a * t1.v + b * t2.v };
  return attitudeFromTangent(t, f < 0.5 ? s1.azi : s2.azi);
}

/** Full interpolated station (position + attitude) at an arbitrary MD. */
export function stationAtMd(stations, path, md) {
  const pos = positionAtMd(stations, path, md);
  if (!pos) return null;
  const att = attitudeAtMd(stations, md);
  return { ...pos, inc: att.inc, azi: att.azi };
}

/**
 * Dogleg severity between two stations in both reporting conventions.
 * mdUnit is the unit of the stations' MD ('m' | 'ft').
 */
export function doglegSeverity(s1, s2, { mdUnit = 'm' } = {}) {
  const dmd = s2.md - s1.md;
  if (!(dmd > 0)) return { dls30m: 0, dls100ft: 0 };
  const deg = doglegRad(s1.inc, s1.azi, s2.inc, s2.azi) / DEG;
  if (mdUnit === 'ft') {
    const dls100ft = (deg * 100) / dmd;
    return { dls30m: dls100ft * (30 / 30.48), dls100ft };
  }
  const dls30m = (deg * 30) / dmd;
  return { dls30m, dls100ft: dls30m * (30.48 / 30) };
}

/**
 * Build and turn rates between two stations, per the mdUnit's reporting
 * interval (deg/30m for metres, deg/100ft for feet). Turn uses the
 * shortest signed azimuth change.
 */
export function buildTurnRates(s1, s2, { mdUnit = 'm' } = {}) {
  const dmd = s2.md - s1.md;
  const interval = mdUnit === 'ft' ? 100 : 30;
  if (!(dmd > 0)) return { buildRate: 0, turnRate: 0, interval };
  return {
    buildRate: ((s2.inc - s1.inc) * interval) / dmd,
    turnRate: (wrapDeltaDeg(s1.azi, s2.azi) * interval) / dmd,
    interval,
  };
}

/**
 * True vertical section: projection of the horizontal offset from the
 * VS origin onto the vertical plane at vsAzimuthDeg.
 * pt/origin use world x (east) / y (north).
 */
export function verticalSection(pt, { originX = 0, originY = 0, vsAzimuthDeg = 0 } = {}) {
  const a = vsAzimuthDeg * DEG;
  return (pt.y - originY) * Math.cos(a) + (pt.x - originX) * Math.sin(a);
}

/** Closure distance/azimuth of a point relative to the wellhead.
 *  Compass azimuth convention: atan2(ΔE, ΔN). */
export function closure(pt, { originX = 0, originY = 0 } = {}) {
  const de = pt.x - originX;
  const dn = pt.y - originY;
  return {
    dist: Math.hypot(de, dn),
    azi: (de === 0 && dn === 0) ? 0 : normalizeAzi(Math.atan2(de, dn) / DEG),
  };
}

/** Compass default VS azimuth: closure azimuth of the last station. */
export function defaultVsAzimuth(path) {
  const first = path[0];
  const last = path[path.length - 1];
  return closure(last, { originX: first.x, originY: first.y }).azi;
}

/**
 * All MDs at which the path crosses a given TVD (S-wells and horizontals
 * cross more than once). Exact per-interval solve on the
 * minimum-curvature arc:
 *   ΔV(θ) = r·[t1v·sinθ + Bv·(1−cosθ)],  Bv = (t2v − t1v·cosβ)/sinβ
 * i.e. a·sinθ + b·cosθ = c with a = t1v, b = −Bv, c = d − Bv,
 * d = (tvd − tvd1)/r; roots kept in θ ∈ [0, β]. Straight intervals are
 * linear. Endpoint hits are deduplicated.
 */
export function mdsAtTvd(stations, path, tvd) {
  const out = [];
  const push = (md) => {
    if (out.length === 0 || Math.abs(out[out.length - 1] - md) > 1e-7) out.push(md);
  };
  for (let i = 1; i < stations.length; i++) {
    const s1 = stations[i - 1];
    const s2 = stations[i];
    const p1 = path[i - 1];
    const p2 = path[i];
    const dmd = s2.md - s1.md;
    const beta = doglegRad(s1.inc, s1.azi, s2.inc, s2.azi);
    if (beta < 1e-9) {
      const dv = p2.tvd - p1.tvd;
      if (Math.abs(dv) < 1e-12) {
        if (Math.abs(tvd - p1.tvd) < 1e-9) push(s1.md);
        continue;
      }
      const f = (tvd - p1.tvd) / dv;
      if (f >= -1e-12 && f <= 1 + 1e-12) {
        push(s1.md + Math.min(1, Math.max(0, f)) * dmd);
      }
      continue;
    }
    const t1 = tangent(s1.inc, s1.azi);
    const t2 = tangent(s2.inc, s2.azi);
    const r = dmd / beta;
    const sb = Math.sin(beta);
    const cb = Math.cos(beta);
    const bv = (t2.v - t1.v * cb) / sb;
    const a = t1.v;
    const b = -bv;
    const c = (tvd - p1.tvd) / r - bv;
    const R = Math.hypot(a, b);
    if (R < 1e-15) {
      if (Math.abs(c) < 1e-12 && Math.abs(tvd - p1.tvd) < 1e-9) push(s1.md);
      continue;
    }
    const ratio = c / R;
    if (ratio < -1 - 1e-12 || ratio > 1 + 1e-12) continue;
    const phi = Math.atan2(b, a);
    const asr = Math.asin(Math.max(-1, Math.min(1, ratio)));
    const cands = [asr - phi, Math.PI - asr - phi];
    for (const raw of cands) {
      // Bring each candidate into [0, 2π) then test against [0, β].
      let th = raw % (2 * Math.PI);
      if (th < 0) th += 2 * Math.PI;
      if (th <= beta + 1e-12) {
        push(s1.md + Math.min(beta, Math.max(0, th)) * r);
      }
    }
  }
  out.sort((x, y) => x - y);
  const dedup = [];
  for (const md of out) {
    if (dedup.length === 0 || md - dedup[dedup.length - 1] > 1e-7) dedup.push(md);
  }
  return dedup;
}

/** Full interpolated stations at every crossing of a TVD plane. */
export function stationsAtTvd(stations, path, tvd) {
  return mdsAtTvd(stations, path, tvd)
    .map((md) => stationAtMd(stations, path, md))
    .filter(Boolean);
}

/**
 * Resample a survey to a regular MD grid (plus the original stations,
 * which are always kept exactly). Attitudes by exact arc slerp.
 */
export function resample(stations, { step = 10 } = {}) {
  if (!(step > 0)) throw new Error('Resample step must be positive.');
  const first = stations[0].md;
  const last = stations[stations.length - 1].md;
  const mds = stations.map((s) => s.md);
  for (let md = first + step; md < last - 1e-9; md += step) mds.push(md);
  mds.sort((a, b) => a - b);
  const out = [];
  for (const md of mds) {
    if (out.length && md - out[out.length - 1].md < 1e-9) continue;
    const att = attitudeAtMd(stations, md);
    out.push({ md, inc: att.inc, azi: att.azi });
  }
  return out;
}

/**
 * The single call that produces a Compass-style survey listing.
 * Returns one row per station:
 * {md, inc, azi, tvd, tvdss, n, e, x, y, dls30m, dls100ft,
 *  buildRate, turnRate, vs, closureDist, closureAzi}
 * n/e are relative to the wellhead; x/y are world coordinates.
 */
export function computeSurveyTable(stations, {
  surfaceX = 0, surfaceY = 0, kb = 0, mdUnit = 'm',
  vsOriginX = null, vsOriginY = null, vsAzimuthDeg = null,
} = {}) {
  const path = computeWellPath(stations, { surfaceX, surfaceY, kb });
  const ox = vsOriginX == null ? surfaceX : vsOriginX;
  const oy = vsOriginY == null ? surfaceY : vsOriginY;
  const vsAzi = vsAzimuthDeg == null ? defaultVsAzimuth(path) : vsAzimuthDeg;
  return path.map((p, i) => {
    const s = stations[i];
    const prev = i > 0 ? stations[i - 1] : null;
    const dls = prev ? doglegSeverity(prev, s, { mdUnit }) : { dls30m: 0, dls100ft: 0 };
    const rates = prev ? buildTurnRates(prev, s, { mdUnit }) : { buildRate: 0, turnRate: 0 };
    const clo = closure(p, { originX: surfaceX, originY: surfaceY });
    return {
      md: s.md,
      inc: s.inc,
      azi: normalizeAzi(s.azi),
      tvd: p.tvd,
      tvdss: p.tvdss,
      n: p.y - surfaceY,
      e: p.x - surfaceX,
      x: p.x,
      y: p.y,
      dls30m: dls.dls30m,
      dls100ft: dls.dls100ft,
      buildRate: rates.buildRate,
      turnRate: rates.turnRate,
      vs: verticalSection(p, { originX: ox, originY: oy, vsAzimuthDeg: vsAzi }),
      closureDist: clo.dist,
      closureAzi: clo.azi,
    };
  });
}

export const M_TO_FT = FT_PER_M;
