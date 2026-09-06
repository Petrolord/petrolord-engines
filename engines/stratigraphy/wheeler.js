// Wheeler (chronostratigraphic) chart (Stratigraphy Studio ST2, 2026-09-06).
//
// A section re-plotted with geologic time on the vertical axis: for each
// well, the intervals between consecutive dated surfaces become
// DEPOSITION cells spanning their ages, an unconformity with a known
// older bound becomes a HIATUS cell, and the whole is labelled with the
// systems tract the bounding surfaces imply (expectedTract) when they
// imply one. Rock volume is lost, time is gained: that is the point of
// the diagram (Wheeler 1958). Closed-form: the transform is the age-depth
// model of ageDepth.js applied per well, so the golden is a hand-derived
// synthetic (test-data/stratigraphy/wheeler-synthetic.json).

import { ageDepthModel, validateAgeDepth, sortDated } from './ageDepth';
import { expectedTract, normalizeSurfaceType } from './vocabulary';

/**
 * @typedef {Object} WheelerWell
 * @property {string} id
 * @property {string} name
 * @property {number} [position]   distance along the section (m); index order when absent
 * @property {Array<{name, md_m, age_ma, hiatus_to_ma?, surface_type?}>} surfaces
 */

/**
 * @typedef {Object} WheelerCell
 * @property {string} wellId
 * @property {'deposition'|'hiatus'} kind
 * @property {number} from_ma   younger bound
 * @property {number} to_ma     older bound
 * @property {?number} top_md_m
 * @property {?number} base_md_m
 * @property {?string} upper    name of the surface above (deposition) or the hiatus surface
 * @property {?string} lower    name of the surface below (deposition)
 * @property {?string} tract    systems tract code the bounding surfaces imply
 * @property {boolean} certain  false when the tract needs an unpicked internal boundary
 * @property {string} label
 */

/** Cells of one well; an empty array when it has fewer than two dated surfaces or an invalid set. */
export function wellCells(well) {
  const model = ageDepthModel(well.surfaces);
  if (!model) return [];
  const cells = [];
  for (const s of model.segments) {
    const upperPt = model.points.find((p) => Math.abs(p.md_m - s.top_md_m) < 1e-9) || null;
    const lowerPt = model.points.find((p) => Math.abs(p.md_m - s.base_md_m) < 1e-9) || null;
    const upperCode = normalizeSurfaceType(upperPt?.surface_type);
    const lowerCode = normalizeSurfaceType(lowerPt?.surface_type);
    const t = expectedTract(lowerCode, upperCode);
    const label = t ? t.code : `${s.lower || 'base'} to ${s.upper || 'top'}`;
    cells.push({
      wellId: well.id, kind: 'deposition', from_ma: s.age_top_ma, to_ma: s.age_base_ma,
      top_md_m: s.top_md_m, base_md_m: s.base_md_m, upper: s.upper, lower: s.lower,
      tract: t ? t.code : null, certain: t ? t.certain : false, label,
    });
  }
  for (const h of model.hiatuses) {
    cells.push({
      wellId: well.id, kind: 'hiatus', from_ma: h.from_ma, to_ma: h.to_ma,
      top_md_m: h.md_m, base_md_m: h.md_m, upper: h.name, lower: null, tract: null, certain: true,
      label: `hiatus at ${h.name || `${h.md_m} m`}`,
    });
  }
  return cells.sort((a, b) => a.from_ma - b.from_ma || (a.kind === 'hiatus' ? -1 : 1));
}

/**
 * The chart: every well's cells, the age axis, and the wells that could
 * not be placed (with the reason). Wells keep section order; `x` is the
 * given position or the index.
 * @param {WheelerWell[]} wells
 * @returns {{ wells: Array<{id, name, x, cells: WheelerCell[]}>, age_min_ma: number, age_max_ma: number, skipped: Array<{id, name, reason}>, boundaries: number[] }}
 */
export function wheelerChart(wells) {
  const out = [];
  const skipped = [];
  let min = Infinity; let max = -Infinity;
  const bounds = new Set();
  (wells || []).forEach((w, i) => {
    const dated = sortDated(w.surfaces);
    if (dated.length < 2) { skipped.push({ id: w.id, name: w.name, reason: dated.length ? 'only one dated surface' : 'no dated surfaces' }); return; }
    const problems = validateAgeDepth(dated);
    if (problems.length) { skipped.push({ id: w.id, name: w.name, reason: problems[0].message }); return; }
    const cells = wellCells({ ...w, surfaces: dated });
    for (const c of cells) { min = Math.min(min, c.from_ma); max = Math.max(max, c.to_ma); bounds.add(c.from_ma); bounds.add(c.to_ma); }
    out.push({ id: w.id, name: w.name, x: Number.isFinite(w.position) ? w.position : i, cells });
  });
  return {
    wells: out,
    age_min_ma: out.length ? min : 0,
    age_max_ma: out.length ? max : 0,
    skipped,
    boundaries: Array.from(bounds).sort((a, b) => a - b),
  };
}

/**
 * The cell of a well that covers an age (a hiatus wins over the
 * deposition cells that touch it at the same age), or null.
 */
export function cellAt(chartWell, ma) {
  if (!chartWell) return null;
  const hit = chartWell.cells.filter((c) => ma >= c.from_ma - 1e-9 && ma <= c.to_ma + 1e-9);
  if (!hit.length) return null;
  return hit.find((c) => c.kind === 'hiatus') || hit[0];
}

/** Total hiatus duration per well, Ma. */
export const hiatusDuration = (chartWell) => (chartWell ? chartWell.cells.filter((c) => c.kind === 'hiatus').reduce((s, c) => s + (c.to_ma - c.from_ma), 0) : 0);
