// Stratigraphic stretch (Stratigraphy Studio ST2, 2026-09-06).
//
// Flattening on one surface shifts a well rigidly (wellcorrelation/
// section.js computeFlattening). Stratigraphic flattening hangs a well on
// TWO surfaces: the interval between them is stretched or squeezed so
// both picks land on common datum lines, and the rock above and below
// rides along with a rigid shift (the Wheeler transform in depth, at
// constant rate between the two surfaces). The mapping per well is a
// {fwd, inv} pair the section painters apply wherever they applied a
// numeric shift. Closed-form: analytic tests.

import { topMd } from '../wellcorrelation/section';

/**
 * A piecewise-linear depth mapping: [upperMd, lowerMd] -> [frameTop, frameBase],
 * rigid shift outside. Returns {fwd, inv, kind, upperMd, lowerMd, frameTop, frameBase, scale}.
 */
export function makeStretch(upperMd, lowerMd, frameTop, frameBase) {
  if (!(lowerMd > upperMd) || !(frameBase > frameTop)) throw new Error('A stretch needs upper above lower on the well and on the frame.');
  const scale = (frameBase - frameTop) / (lowerMd - upperMd);
  const fwd = (md) => (md <= upperMd ? md + (frameTop - upperMd)
    : md >= lowerMd ? md + (frameBase - lowerMd)
      : frameTop + (md - upperMd) * scale);
  const inv = (d) => (d <= frameTop ? d - (frameTop - upperMd)
    : d >= frameBase ? d - (frameBase - lowerMd)
      : upperMd + (d - frameTop) / scale);
  return { kind: 'stretch', fwd, inv, upperMd, lowerMd, frameTop, frameBase, scale };
}

/**
 * Flattening entries for a section under the stretch datum: every well
 * carrying both surfaces maps [upper, lower] onto the frame; a well with
 * only the upper (or only the lower) is shifted rigidly onto that one
 * line and flagged partial; a well with neither is drawn unshifted and
 * flagged. The frame defaults to the mean pick depths across the wells
 * that carry both, so the section stays near its true depths.
 * @param {Array} wells  section wells with `tops` [{name, md_m}]
 * @param {{ upperName: string, lowerName: string, frameTop?: number, frameBase?: number }} datum
 * @returns {Array<{ id, shift: number|Object|null, hasDatumTop: boolean, partial: boolean }>}
 */
export function computeStretch(wells, datum) {
  const { upperName, lowerName } = datum;
  if (!upperName || !lowerName || upperName === lowerName) throw new Error('A stretch needs two different surfaces.');
  const picks = wells.map((w) => ({ id: w.id, u: topMd(w, upperName), l: topMd(w, lowerName) }));
  const both = picks.filter((p) => p.u !== null && p.l !== null && p.l > p.u);
  let frameTop = datum.frameTop; let frameBase = datum.frameBase;
  if (!Number.isFinite(frameTop) || !Number.isFinite(frameBase) || !(frameBase > frameTop)) {
    if (!both.length) throw new Error(`No well carries both ${upperName} and ${lowerName} in order.`);
    frameTop = both.reduce((s, p) => s + p.u, 0) / both.length;
    frameBase = both.reduce((s, p) => s + p.l, 0) / both.length;
  }
  return picks.map((p) => {
    if (p.u !== null && p.l !== null && p.l > p.u) return { id: p.id, shift: makeStretch(p.u, p.l, frameTop, frameBase), hasDatumTop: true, partial: false };
    if (p.u !== null) return { id: p.id, shift: frameTop - p.u, hasDatumTop: true, partial: true };
    if (p.l !== null) return { id: p.id, shift: frameBase - p.l, hasDatumTop: true, partial: true };
    return { id: p.id, shift: null, hasDatumTop: false, partial: true };
  });
}

/** Apply any shift form: number, null, or a {fwd} mapping. */
export const applyShift = (md, shift) => (shift && typeof shift === 'object' ? shift.fwd(md) : md + (shift || 0));
/** Invert any shift form. */
export const invertShift = (displayed, shift) => (shift && typeof shift === 'object' ? shift.inv(displayed) : displayed - (shift || 0));
