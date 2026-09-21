// Checkshot conventions (Petrophysics PT0, 2026-09-03).
//
// The registry stores a checkshot table as `[{tvdss_m, twt_ms}]`, strictly
// increasing in both, because Seismolord's synthetics, well tie and every
// time-depth consumer read exactly that. Petrel users enter checkshots as
// MEASURED DEPTH and ONE-WAY TIME, often in feet. This module is the door:
// it converts what the user typed into the stored core through the well's
// survey and KB, keeps the entered MD beside each stored row (`md_m`) so
// the table round-trips and re-derives when KB or the survey change, and
// converts back for display and export.
//
// Depth frame conventions (inherited from drilling/surveyMath.js):
//   MD     measured depth below KB (the survey's depth reference)
//   TVD    true vertical depth below KB
//   TVDSS  TVD below the elevation datum, TVDSS = TVD - KB (positive down)
// A well with no survey (fewer than two stations) is vertical: MD = TVD.
// A survey whose first station is deeper than 0 m is assumed vertical from
// KB to that station (Petrel's tie-in convention); the frame says so.
// Below the last station the path continues along the final tangent and
// every derived value is flagged `extrapolated`.
//
// Limits stated, never hidden: a flat or uphill lateral cannot live in a
// TVDSS-keyed table (the depth would not increase); such rows are refused
// with a message naming the MD interval. When a TVDSS is reached at more
// than one MD (S-shaped or uphill sections) the shallowest MD is taken and
// the row is flagged `ambiguous`; no `md_m` is stored for it.
//
// Pure functions, worker-safe, no I/O. Validated against the closed-form
// goldens in test-data/wells/goldens/checkshots_cases.json
// (tools/validation/wells/oracle_checkshots.py, vertical and build-and-hold
// trajectories written from analytic geometry, never from this code).

import { computeWellPath, positionAtMd, mdsAtTvd } from '../drilling/surveyMath.js';

export const CHECKSHOT_DEPTH_REFS = ['md', 'tvd', 'tvdss'];
export const CHECKSHOT_TIMES = ['owt', 'twt'];
export const CHECKSHOT_DEPTH_UNITS = ['m', 'ft'];
export const PETREL_CHECKSHOT_CONVENTION = Object.freeze({ depthRef: 'md', time: 'owt', depthUnit: 'm' });
export const STORED_CHECKSHOT_CONVENTION = Object.freeze({ depthRef: 'tvdss', time: 'twt', depthUnit: 'm' });
export const M_PER_FT = 0.3048;

const DEG = Math.PI / 180;
const REF_LABEL = { md: 'MD', tvd: 'TVD', tvdss: 'TVDSS' };
const TIME_LABEL = { owt: 'OWT', twt: 'TWT' };

function normalizeConvention(c) {
  const conv = { ...PETREL_CHECKSHOT_CONVENTION, ...(c || {}) };
  if (!CHECKSHOT_DEPTH_REFS.includes(conv.depthRef)) throw new Error(`Unknown checkshot depth reference "${conv.depthRef}" (expected md, tvd or tvdss).`);
  if (!CHECKSHOT_TIMES.includes(conv.time)) throw new Error(`Unknown checkshot time kind "${conv.time}" (expected owt or twt).`);
  if (!CHECKSHOT_DEPTH_UNITS.includes(conv.depthUnit)) throw new Error(`Unknown checkshot depth unit "${conv.depthUnit}" (expected m or ft).`);
  return conv;
}

const toMetres = (v, unit) => (unit === 'ft' ? v * M_PER_FT : v);
const fromMetres = (v, unit) => (unit === 'ft' ? v / M_PER_FT : v);

/** Clean a registry deviation array into ascending finite stations. */
function cleanStations(deviation) {
  if (!Array.isArray(deviation)) return [];
  return deviation
    .map((s) => ({ md: Number(s?.md), inc: Number(s?.inc), azi: Number(s?.azi) }))
    .filter((s) => Number.isFinite(s.md) && Number.isFinite(s.inc) && Number.isFinite(s.azi))
    .sort((a, b) => a.md - b.md);
}

/**
 * Depth frame for one well: MD <-> TVD <-> TVDSS over its survey, or the
 * vertical fallback.
 * @param {{deviation?: Array, kbM?: number, tdMdM?: ?number}} well
 */
export function makeDepthFrame({ deviation = null, kbM = 0, tdMdM = null } = {}) {
  const kb = Number.isFinite(Number(kbM)) ? Number(kbM) : 0;
  let stations = cleanStations(deviation);
  let assumedVerticalToFirstStation = false;
  if (stations.length >= 2 && stations[0].md > 1e-9) {
    stations = [{ md: 0, inc: 0, azi: stations[0].azi }, ...stations];
    assumedVerticalToFirstStation = true;
  }
  const isVertical = stations.length < 2;
  const path = isVertical ? null : computeWellPath(stations, { kb });
  const last = isVertical ? null : stations[stations.length - 1];
  const lastPath = isVertical ? null : path[path.length - 1];
  const cosLast = isVertical ? 1 : Math.cos(last.inc * DEG);

  // Unit tangent of the last station, for the continuation past TD.
  const sinLast = isVertical ? 0 : Math.sin(last.inc * DEG);
  const eLast = isVertical ? 0 : sinLast * Math.sin(last.azi * DEG);
  const nLast = isVertical ? 0 : sinLast * Math.cos(last.azi * DEG);

  /**
   * Borehole position at an MD: x/y are East/North OFFSETS from the
   * wellhead in metres (the path is built at the origin), tvd below KB,
   * tvdss below datum. Past the last station the path continues along
   * the final tangent in all three components and is flagged.
   */
  const mdToPosition = (md) => {
    if (!Number.isFinite(md)) throw new Error('MD must be a number.');
    if (isVertical) return { x: 0, y: 0, tvd: md, tvdss: md - kb, extrapolated: false };
    if (md < stations[0].md - 1e-9) {
      throw new Error(`MD ${md} m is above the first survey station (${stations[0].md} m).`);
    }
    if (md <= last.md + 1e-9) {
      const p = positionAtMd(stations, path, Math.min(md, last.md));
      return { x: p.x, y: p.y, tvd: p.tvd, tvdss: p.tvdss, extrapolated: false };
    }
    const d = md - last.md;
    const tvd = lastPath.tvd + d * cosLast;
    return { x: lastPath.x + d * eLast, y: lastPath.y + d * nLast, tvd, tvdss: tvd - kb, extrapolated: true };
  };

  const mdToTvdss = (md) => {
    const p = mdToPosition(md);
    return { tvd: p.tvd, tvdss: p.tvdss, extrapolated: p.extrapolated };
  };

  const tvdssToMd = (tvdss) => {
    if (!Number.isFinite(tvdss)) return null;
    const tvd = tvdss + kb;
    if (isVertical) return tvd < -1e-9 ? null : { md: tvd, ambiguous: false, extrapolated: false };
    const hits = mdsAtTvd(stations, path, tvd);
    if (hits.length) return { md: hits[0], ambiguous: hits.length > 1, extrapolated: false };
    if (tvd > lastPath.tvd && cosLast > 1e-9) {
      return { md: last.md + (tvd - lastPath.tvd) / cosLast, ambiguous: false, extrapolated: true };
    }
    return null;
  };

  return {
    kbM: kb,
    tdMdM: Number.isFinite(Number(tdMdM)) ? Number(tdMdM) : null,
    stations: isVertical ? null : stations,
    path,
    isVertical,
    assumedVerticalToFirstStation,
    mdRange: isVertical ? null : [stations[0].md, last.md],
    mdToPosition,
    mdToTvdss,
    tvdssToMd,
  };
}

/** Rows as the stored core, extra keys dropped except md_m; throws the
 *  monotonicity domain errors. */
export function validateStoredCheckshots(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('At least two checkshot rows are needed.');
  const out = rows.map((r, i) => {
    const tvdss = Number(r?.tvdss_m);
    const twt = Number(r?.twt_ms);
    if (!Number.isFinite(tvdss) || !Number.isFinite(twt)) throw new Error(`Row ${i + 1}: checkshot depth and time must be numbers.`);
    const o = { tvdss_m: tvdss, twt_ms: twt };
    if (r.md_m !== undefined && r.md_m !== null) {
      const md = Number(r.md_m);
      if (Number.isFinite(md)) o.md_m = md;
    }
    return o;
  });
  for (let i = 1; i < out.length; i++) {
    if (!(out[i].tvdss_m > out[i - 1].tvdss_m) || !(out[i].twt_ms > out[i - 1].twt_ms)) {
      throw new Error(`Row ${i + 1}: checkshots must strictly increase in depth and time `
        + `(got TVDSS ${out[i].tvdss_m} m / TWT ${out[i].twt_ms} ms after TVDSS ${out[i - 1].tvdss_m} m / TWT ${out[i - 1].twt_ms} ms). `
        + 'Fix the file rather than let the app re-sort it.');
    }
  }
  return out;
}

/**
 * Convert entered rows to the stored core.
 * @param {Array<{depth:number, time:number}>} rowsIn as typed, in `convention`
 * @param {{depthRef, time, depthUnit}} convention
 * @param {ReturnType<typeof makeDepthFrame>} frame
 * @returns {{rows: Array<{tvdss_m:number, twt_ms:number, md_m?:number}>, warnings: string[]}}
 */
export function toStoredCheckshots(rowsIn, convention, frame) {
  const conv = normalizeConvention(convention);
  if (!Array.isArray(rowsIn) || rowsIn.length < 2) throw new Error('At least two checkshot rows are needed.');
  const warnings = [];
  const unitTxt = conv.depthUnit;
  const label = (r) => `${REF_LABEL[conv.depthRef]} ${r.depth} ${unitTxt} / ${TIME_LABEL[conv.time]} ${r.time} ms`;
  const rows = rowsIn.map((r, i) => {
    const depth = Number(r?.depth);
    const time = Number(r?.time);
    if (!Number.isFinite(depth) || !Number.isFinite(time)) throw new Error(`Row ${i + 1}: checkshot depth and time must be numbers.`);
    const depthM = toMetres(depth, conv.depthUnit);
    const twt = conv.time === 'owt' ? 2 * time : time;
    let tvdss;
    let mdM;
    if (conv.depthRef === 'md') {
      let res;
      try {
        res = frame.mdToTvdss(depthM);
      } catch (e) {
        throw new Error(`Row ${i + 1}: ${e.message}`);
      }
      tvdss = res.tvdss;
      mdM = depthM;
      if (res.extrapolated) warnings.push(`Row ${i + 1}: MD ${depth} ${unitTxt} is below the last survey station; TVD extrapolated along the final tangent.`);
    } else {
      tvdss = conv.depthRef === 'tvd' ? depthM - frame.kbM : depthM;
      const inv = frame.tvdssToMd(tvdss);
      if (inv && !inv.ambiguous) {
        mdM = inv.md;
        if (inv.extrapolated) warnings.push(`Row ${i + 1}: ${REF_LABEL[conv.depthRef]} ${depth} ${unitTxt} is below the last survey station; MD extrapolated along the final tangent.`);
      } else if (inv && inv.ambiguous) {
        warnings.push(`Row ${i + 1}: ${REF_LABEL[conv.depthRef]} ${depth} ${unitTxt} is reached at more than one MD along this well; no MD is stored for it.`);
      }
    }
    const o = { tvdss_m: tvdss, twt_ms: twt };
    if (Number.isFinite(mdM)) o.md_m = mdM;
    return o;
  });
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (conv.depthRef === 'md' && Number(rowsIn[i].depth) > Number(rowsIn[i - 1].depth) && !(b.tvdss_m > a.tvdss_m)) {
      throw new Error(`Row ${i + 1}: TVDSS does not increase between MD ${rowsIn[i - 1].depth} and MD ${rowsIn[i].depth} ${unitTxt} `
        + '(the well is flat or uphill here). Checkshots are stored as a depth-time table in TVDSS and cannot hold a flat or uphill section; drop the rows in the lateral.');
    }
    if (!(b.tvdss_m > a.tvdss_m) || !(b.twt_ms > a.twt_ms)) {
      throw new Error(`Row ${i + 1}: checkshots must strictly increase in depth and time (got ${label(rowsIn[i])} after ${label(rowsIn[i - 1])}). `
        + 'Fix the file rather than let the app re-sort it.');
    }
  }
  return { rows, warnings };
}

/**
 * Stored rows expressed in a display convention.
 * @returns {Array<{depth:number, time:number, md_m:?number, tvd_m:number, tvdss_m:number,
 *   twt_ms:number, owt_ms:number, ambiguous:boolean, extrapolated:boolean}>}
 */
export function fromStoredCheckshots(rows, convention, frame) {
  const conv = normalizeConvention(convention);
  return (rows || []).map((r) => {
    const tvdss = Number(r.tvdss_m);
    const twt = Number(r.twt_ms);
    const tvd = tvdss + frame.kbM;
    let md = Number.isFinite(Number(r.md_m)) ? Number(r.md_m) : null;
    let ambiguous = false;
    let extrapolated = false;
    if (md === null) {
      const inv = frame.tvdssToMd(tvdss);
      if (inv) { md = inv.md; ambiguous = inv.ambiguous; extrapolated = inv.extrapolated; }
    }
    const depthM = conv.depthRef === 'md' ? md : conv.depthRef === 'tvd' ? tvd : tvdss;
    return {
      depth: depthM === null ? NaN : fromMetres(depthM, conv.depthUnit),
      time: conv.time === 'owt' ? twt / 2 : twt,
      md_m: md,
      tvd_m: tvd,
      tvdss_m: tvdss,
      twt_ms: twt,
      owt_ms: twt / 2,
      ambiguous,
      extrapolated,
    };
  });
}

/** Table-level provenance stored beside the rows (geo_wells.checkshots_provenance). */
export function makeCheckshotProvenance(convention, { source = 'well-import', kbM = 0, stations = 0, now = new Date(), note = null } = {}) {
  const conv = normalizeConvention(convention);
  const p = {
    units_in: { depth_ref: conv.depthRef, time: conv.time, depth_unit: conv.depthUnit },
    source,
    kb_m_used: Number(kbM) || 0,
    deviation_stations_used: Number(stations) || 0,
    edited_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  if (note) p.note = note;
  return p;
}

/** Provenance to assume for rows that carry none (pre-PT0 tables). */
export const LEGACY_CHECKSHOT_PROVENANCE = Object.freeze({
  units_in: { depth_ref: 'tvdss', time: 'twt', depth_unit: 'm' },
  source: 'legacy',
});

/**
 * Re-derive a stored table after KB or the survey changed, honouring the
 * reference the user entered it in: MD-referenced rows are recomputed from
 * `md_m` (every row needs one), TVD-referenced rows shift by the KB delta,
 * TVDSS-referenced rows are unchanged (their md_m is refreshed).
 */
export function rebaseStoredCheckshots(rows, provenance, frame, { now = new Date() } = {}) {
  const prov = provenance && provenance.units_in ? provenance : { ...LEGACY_CHECKSHOT_PROVENANCE, kb_m_used: frame.kbM };
  const ref = prov.units_in.depth_ref;
  const warnings = [];
  const stored = validateStoredCheckshots(rows);
  const oldKb = Number.isFinite(Number(prov.kb_m_used)) ? Number(prov.kb_m_used) : frame.kbM;
  const out = stored.map((r, i) => {
    if (ref === 'md') {
      if (!Number.isFinite(r.md_m)) throw new Error(`Row ${i + 1}: this MD-referenced checkshot table has no MD stored for the row, so it cannot be re-derived. Re-enter the table.`);
      const res = frame.mdToTvdss(r.md_m);
      if (res.extrapolated) warnings.push(`Row ${i + 1}: MD ${r.md_m} m is below the last survey station; TVD extrapolated along the final tangent.`);
      return { tvdss_m: res.tvdss, twt_ms: r.twt_ms, md_m: r.md_m };
    }
    const tvdss = ref === 'tvd' ? r.tvdss_m + (oldKb - frame.kbM) : r.tvdss_m;
    const inv = frame.tvdssToMd(tvdss);
    const o = { tvdss_m: tvdss, twt_ms: r.twt_ms };
    if (inv && !inv.ambiguous) o.md_m = inv.md;
    return o;
  });
  const valid = validateStoredCheckshots(out);
  return {
    rows: valid,
    provenance: {
      ...prov,
      kb_m_used: frame.kbM,
      deviation_stations_used: frame.stations ? frame.stations.length : 0,
      edited_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    },
    warnings,
  };
}
