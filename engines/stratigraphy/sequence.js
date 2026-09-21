// Sequence-stratigraphic interpretation products (Stratigraphy Studio ST2).
//
// Turns a well's typed surfaces into the systems-tract intervals they
// bound (expectedTract per consecutive pair, depth order), ready for
// geo_wells_intervals with kind 'systems_tract', and reads a stacking
// pattern from the motif intervals inside a tract. Nothing is invented: a
// pair that bounds no single tract yields no row, and an uncertain tract
// (an unpicked internal boundary) is stored with certain: false so the
// section paints it hatched and the Wheeler labels it with a question.

import { expectedTract, normalizeSurfaceType, systemsTract } from './vocabulary';

/**
 * @param {Array<{id?, name, md_m, surface_type?}>} tops a well's tops
 * @returns {Array<{kind: 'systems_tract', top_md_m, base_md_m, code, label, properties: {upper_surface, lower_surface, upper_type, lower_type, certain}, source: 'interpretation'}>}
 */
export function tractsFromSurfaces(tops) {
  const sorted = [...(tops || [])].filter((t) => Number.isFinite(t.md_m)).sort((a, b) => a.md_m - b.md_m);
  const out = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const upper = sorted[i]; const lower = sorted[i + 1];
    if (!(lower.md_m > upper.md_m)) continue;
    const t = expectedTract(normalizeSurfaceType(lower.surface_type), normalizeSurfaceType(upper.surface_type));
    if (!t) continue;
    out.push({
      kind: 'systems_tract', top_md_m: upper.md_m, base_md_m: lower.md_m, code: t.code, label: systemsTract(t.code)?.name || t.code,
      properties: { upper_surface: upper.name, lower_surface: lower.name, upper_type: normalizeSurfaceType(upper.surface_type), lower_type: normalizeSurfaceType(lower.surface_type), certain: t.certain },
      source: 'interpretation',
    });
  }
  return out;
}

/**
 * Stacking pattern of a tract from the motifs inside it: a run of
 * funnels (coarsening upward, each parasequence stepping basinward) reads
 * progradational, a run of bells retrogradational, blocky aggradational;
 * mixed or empty is null. Motifs are the well's 'motif' intervals.
 */
export function stackingFromMotifs(tract, motifs) {
  const inside = (motifs || []).filter((m) => m.kind === 'motif' && m.top_md_m >= tract.top_md_m - 1e-9 && m.base_md_m <= tract.base_md_m + 1e-9);
  if (!inside.length) return null;
  const codes = new Set(inside.map((m) => m.code));
  if (codes.size !== 1) return null;
  const code = inside[0].code;
  return code === 'funnel' ? 'progradational' : code === 'bell' ? 'retrogradational' : code === 'blocky' ? 'aggradational' : null;
}

/** Tract rows with a stacking property filled from the well's motifs where it can be read. */
export function tractsWithStacking(tops, motifs) {
  return tractsFromSurfaces(tops).map((t) => {
    const stacking = stackingFromMotifs(t, motifs);
    return stacking ? { ...t, properties: { ...t.properties, stacking } } : t;
  });
}
