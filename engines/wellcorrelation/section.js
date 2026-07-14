// Cross-section geometry (Well Correlation G3.0): datum flattening,
// depth-to-screen mapping, correlation-line pairing across wells, and
// zone-fill spans between correlated tops. Pure functions, plain JS +
// JSDoc, no I/O.
//
// The math is exact closed-form arithmetic (a per-well additive depth
// shift), so validation is hand-derivable analytic jest cases + a
// deterministic synthetic section — NOT a Python oracle. There is no
// numerical method here to cross-check against (unlike Archie/lasio in
// G2/G1); the fixtures README records that choice.
//
// Depth convention: MD metres, increasing downward. A well's DISPLAYED
// depth on the section is md + shift; structural view uses shift 0,
// flatten-on-top sets shift so the chosen top lands on the datum line.

/**
 * @typedef {{id: string, name: string, tops: Array<{name: string, md_m: number}>}} SectionWell
 * @typedef {{mode: 'structural'|'flatten', topName?: string, datumM?: number}} Datum
 */

/** Top MD for a well by name, or null. */
export function topMd(well, name) {
  const t = (well.tops || []).find((x) => x.name === name);
  return t ? t.md_m : null;
}

/**
 * Per-well flattening shift for a datum.
 * structural -> shift 0 for every well.
 * flatten    -> shift = datumM - md(topName); wells lacking the top get
 *               shift null and hasDatumTop false (drawn UNflattened and
 *               flagged, never silently mis-hung).
 * @param {SectionWell[]} wells @param {Datum} datum
 * @returns {Array<{id: string, shift: number|null, hasDatumTop: boolean}>}
 */
export function computeFlattening(wells, datum) {
  if (datum.mode === 'structural') {
    return wells.map((w) => ({ id: w.id, shift: 0, hasDatumTop: true }));
  }
  if (datum.mode !== 'flatten') throw new Error(`Unknown datum mode "${datum.mode}".`);
  if (!datum.topName) throw new Error('Flatten-on-top needs a top name.');
  if (!Number.isFinite(datum.datumM)) throw new Error('Flatten-on-top needs a datum depth.');
  return wells.map((w) => {
    const md = topMd(w, datum.topName);
    return md === null
      ? { id: w.id, shift: null, hasDatumTop: false }
      : { id: w.id, shift: datum.datumM - md, hasDatumTop: true };
  });
}

/** Displayed section depth of a measured depth under a well's shift.
 *  A null shift (well missing the datum top) displays at true MD. */
export function displayedDepth(md, shift) {
  return md + (shift || 0);
}

/**
 * Correlation polyline for one top across the section: the displayed
 * depth of that top in each well that has it, in section order. Wells
 * without the top are skipped (the line simply doesn't reach them).
 * @param {SectionWell[]} wells
 * @param {Array<{id: string, shift: number|null}>} flattening
 * @param {string} topName
 * @returns {Array<{wellIndex: number, wellId: string, displayed: number}>}
 */
export function correlationPolyline(wells, flattening, topName) {
  const byId = new Map(flattening.map((f) => [f.id, f.shift]));
  const out = [];
  wells.forEach((w, i) => {
    const md = topMd(w, topName);
    if (md === null) return;
    out.push({ wellIndex: i, wellId: w.id, displayed: displayedDepth(md, byId.get(w.id)) });
  });
  return out;
}

/**
 * Zone fill span for one well between two correlated tops (topTop above
 * topBase). Returns displayed {top, base} or null when either top is
 * absent. Always ordered top < base even if the rows are reversed.
 */
export function zoneSpan(well, shift, topTopName, topBaseName) {
  const a = topMd(well, topTopName);
  const b = topMd(well, topBaseName);
  if (a === null || b === null) return null;
  const da = displayedDepth(a, shift);
  const db = displayedDepth(b, shift);
  return { top: Math.min(da, db), base: Math.max(da, db) };
}

/**
 * Displayed-depth range across the whole section (for the auto-fit
 * view). Spans every well's tops under flattening, plus optional
 * per-well [minMd, maxMd] log ranges. Returns null when there is
 * nothing to bound.
 * @param {SectionWell[]} wells
 * @param {Array<{id: string, shift: number|null}>} flattening
 * @param {Object<string,[number,number]>} [logRanges] wellId -> [minMd,maxMd]
 */
export function displayedRange(wells, flattening, logRanges = {}) {
  const byId = new Map(flattening.map((f) => [f.id, f.shift]));
  let min = Infinity;
  let max = -Infinity;
  const push = (d) => { if (d < min) min = d; if (d > max) max = d; };
  for (const w of wells) {
    const shift = byId.get(w.id);
    for (const t of w.tops || []) push(displayedDepth(t.md_m, shift));
    const r = logRanges[w.id];
    if (r) { push(displayedDepth(r[0], shift)); push(displayedDepth(r[1], shift)); }
  }
  return max >= min ? [min, max] : null;
}

/** Linear displayed-depth -> screen-y within a plot band. */
export function depthToY(displayed, viewTop, viewBase, plotTop, plotH) {
  return plotTop + ((displayed - viewTop) / (viewBase - viewTop || 1)) * plotH;
}

/** Left screen-x of well column i (equal columns across the plot). */
export function columnX(i, n, plotLeft, plotW) {
  return plotLeft + (i * plotW) / Math.max(1, n);
}

/** The set of top names present in ANY well, in first-seen order —
 *  the candidate list for datum/correlation/zone controls. */
export function allTopNames(wells) {
  const seen = [];
  for (const w of wells) for (const t of w.tops || []) if (!seen.includes(t.name)) seen.push(t.name);
  return seen;
}
