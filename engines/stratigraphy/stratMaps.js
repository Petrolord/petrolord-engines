// Stratigraphic map sources (Stratigraphy Studio ST4, 2026-09-06).
//
// Mapping & Surface Studio grids control points at wells. A structure map
// takes a top's depth; an attribute map a zone property. A stratigrapher
// also wants the ROCK between two surfaces: gross thickness, net thickness
// of a lithology family (net sand) from the well's lithology log, or the
// net-to-gross ratio, and the environment that dominates the interval for
// a gross depositional environment map. This module turns wells with
// tops and interval logs into those control points. Thicknesses are
// measured-depth thicknesses between the two picks (true vertical
// thickness is a later correction and is named as such in the
// provenance). Closed-form: analytic tests.

import { resolveLithology, resolveEnvironment } from './lithology';

export const NET_MEASURES = Object.freeze(['gross', 'net', 'ratio']);
export const SAND_FAMILY = Object.freeze(['sandstone', 'siltstone', 'conglomerate']);

const EPS = 1e-9;

/** Depth of a named top on a well, or null. */
const topMdOf = (w, name) => {
  const t = (w.tops || []).find((x) => x.name === name);
  return t && Number.isFinite(Number(t.md_m)) ? Number(t.md_m) : null;
};

/** Thickness (m) of lithology intervals with a code in `codes` overlapping [top, base). */
export function netThicknessBetween(intervals, top, base, codes = SAND_FAMILY) {
  const set = new Set(codes.map((c) => resolveLithology(c)?.code || c));
  let net = 0;
  for (const r of intervals || []) {
    if (r.kind !== 'lithology') continue;
    const code = resolveLithology(r.code)?.code || r.code;
    if (!set.has(code)) continue;
    const a = Math.max(top, r.top_md_m); const b = Math.min(base, r.base_md_m);
    if (b > a + EPS) net += b - a;
  }
  return net;
}

/**
 * Control points between two tops.
 * @param {Array} wells  {id, name, surface_x, surface_y, tops}
 * @param {string} upperName
 * @param {string} lowerName
 * @param {{ intervalsByWell: Object<string, Array>, measure?: 'gross'|'net'|'ratio', codes?: string[] }} opts
 * @returns {{ points: Array<{x, y, z, well, top_md_m, base_md_m, gross_m, net_m}>, skipped: Array<{well, reason}>, measure, codes }}
 */
export function thicknessPoints(wells, upperName, lowerName, { intervalsByWell = {}, measure = 'net', codes = SAND_FAMILY } = {}) {
  if (!NET_MEASURES.includes(measure)) throw new Error(`Unknown measure "${measure}" (expected gross, net or ratio).`);
  if (!upperName || !lowerName || upperName === lowerName) throw new Error('Thickness needs two different surfaces.');
  const points = [];
  const skipped = [];
  for (const w of wells || []) {
    const u = topMdOf(w, upperName); const l = topMdOf(w, lowerName);
    if (u === null) { skipped.push({ well: w.name, reason: 'no_upper' }); continue; }
    if (l === null) { skipped.push({ well: w.name, reason: 'no_lower' }); continue; }
    if (!(l > u)) { skipped.push({ well: w.name, reason: 'inverted' }); continue; }
    if (!Number.isFinite(w.surface_x) || !Number.isFinite(w.surface_y)) { skipped.push({ well: w.name, reason: 'no_location' }); continue; }
    const gross = l - u;
    const ivs = intervalsByWell[w.id] || [];
    const hasLith = ivs.some((r) => r.kind === 'lithology');
    if (measure !== 'gross' && !hasLith) { skipped.push({ well: w.name, reason: 'no_lithology' }); continue; }
    const net = measure === 'gross' ? null : netThicknessBetween(ivs, u, l, codes);
    const z = measure === 'gross' ? gross : measure === 'net' ? net : (gross > EPS ? net / gross : 0);
    points.push({ x: w.surface_x, y: w.surface_y, z, well: w.name, top_md_m: u, base_md_m: l, gross_m: gross, net_m: net });
  }
  return { points, skipped, measure, codes: [...codes] };
}

/**
 * The environment that dominates the interval log of each well between
 * two tops, by thickness of `environment` intervals (a core description's
 * properties.environment counts too). Categorical: posted at the well,
 * not gridded.
 * @returns {{ points: Array<{x, y, well, code, label, colour, thickness_m}>, skipped: Array<{well, reason}> }}
 */
export function environmentPoints(wells, upperName, lowerName, { intervalsByWell = {} } = {}) {
  const points = [];
  const skipped = [];
  for (const w of wells || []) {
    const u = topMdOf(w, upperName); const l = topMdOf(w, lowerName);
    if (u === null || l === null || !(l > u)) { skipped.push({ well: w.name, reason: u === null ? 'no_upper' : l === null ? 'no_lower' : 'inverted' }); continue; }
    if (!Number.isFinite(w.surface_x) || !Number.isFinite(w.surface_y)) { skipped.push({ well: w.name, reason: 'no_location' }); continue; }
    const sums = new Map();
    for (const r of intervalsByWell[w.id] || []) {
      const code = r.kind === 'environment' ? r.code : (r.kind === 'core_description' ? r.properties?.environment : null);
      if (!code) continue;
      const a = Math.max(u, r.top_md_m); const b = Math.min(l, r.base_md_m);
      if (b <= a + EPS) continue;
      const key = resolveEnvironment(code)?.code || code;
      sums.set(key, (sums.get(key) || 0) + (b - a));
    }
    if (!sums.size) { skipped.push({ well: w.name, reason: 'no_environment' }); continue; }
    let best = null; let bestT = 0;
    for (const [code, t] of sums) if (t > bestT) { best = code; bestT = t; }
    const env = resolveEnvironment(best);
    points.push({ x: w.surface_x, y: w.surface_y, well: w.name, code: best, label: env?.name || best, colour: env?.colour || '#cbd5e1', thickness_m: bestT });
  }
  return { points, skipped };
}
