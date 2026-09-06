// Basin layers from a dated, typed well (Stratigraphy Studio ST3).
//
// Basin & Charge Modeling wants a layer table youngest first: name,
// thickness (m), a lithology from its own short list (sandstone, shale,
// limestone, salt, coal), deposition ages (ageStart older, ageEnd
// younger), plus erosion events (age, amount). Until now those layers
// were typed by hand or built from tops with placeholder ages. A well
// with typed, dated surfaces and a lithology log carries the answer:
// each layer is the rock between two consecutive tops, its ages are the
// bounding surfaces' ages (an unconformity above a layer ends deposition
// at the OLDER bound of its hiatus), its lithology is the one that
// dominates the interval log by thickness, and every unconformity with a
// known hiatus becomes an erosion event whose amount is unknown and said
// so. Nothing is invented: a layer without both ages keeps placeholders
// and the agesGuessed flag, exactly as the Basin importer does.

import { resolveLithology } from './lithology';
import { sortDated } from './ageDepth';

/** The Basin app's lithology list and the registry classes that map onto it. */
export const BASIN_LITHOLOGIES = Object.freeze(['sandstone', 'shale', 'limestone', 'salt', 'coal']);

const BASIN_OF = {
  sandstone: 'sandstone', siltstone: 'sandstone', conglomerate: 'sandstone',
  shale: 'shale', marl: 'shale', unknown: 'shale', basement: 'shale', volcanic: 'shale', chert: 'shale',
  limestone: 'limestone', chalk: 'limestone', dolomite: 'limestone',
  anhydrite: 'salt', gypsum: 'salt', halite: 'salt',
  coal: 'coal',
};

/** Registry lithology code (or free text) to the Basin list; null when nothing resolves. */
export function basinLithology(code) {
  const l = resolveLithology(code);
  return l ? BASIN_OF[l.code] || 'shale' : null;
}

/**
 * Dominant registry lithology between two depths, by thickness of the
 * lithology intervals overlapping [top, base). Null when none overlap.
 */
export function dominantLithology(intervals, top, base) {
  const sums = new Map();
  for (const r of intervals || []) {
    if (r.kind !== 'lithology') continue;
    const a = Math.max(top, r.top_md_m); const b = Math.min(base, r.base_md_m);
    if (b <= a) continue;
    sums.set(r.code, (sums.get(r.code) || 0) + (b - a));
  }
  let best = null; let bestT = 0;
  for (const [code, t] of sums) if (t > bestT) { best = code; bestT = t; }
  return best;
}

/**
 * @param {Array<{name, md_m, age_ma?, hiatus_to_ma?, surface_type?}>} tops every top of the well
 * @param {{ baseDepth?: number, intervals?: Array, defaultThickness?: number, idFor?: (i: number) => string }} [opts]
 * @returns {{ layers: Array, erosionEvents: Array<{age: number, amount: number, from_ma: number, to_ma: number, surface: string, amountUnknown: true}>, problems: string[] }}
 *   layers youngest first: {id, name, top_md_m, base_md_m, thickness, lithology, ageStart, ageEnd, agesGuessed, lithologyGuessed, sourceRock}
 */
export function layersFromDatedTops(tops, { baseDepth = null, intervals = [], defaultThickness = 500, idFor = (i) => `strat-${i}` } = {}) {
  const sorted = [...(tops || [])].filter((t) => Number.isFinite(t.md_m)).sort((a, b) => a.md_m - b.md_m);
  const problems = [];
  const layers = [];
  const erosionEvents = [];
  const n = sorted.length;
  for (let i = 0; i < n; i++) {
    const t = sorted[i];
    const next = i + 1 < n ? sorted[i + 1] : null;
    const base = next ? next.md_m : (Number.isFinite(baseDepth) && baseDepth > t.md_m ? baseDepth : t.md_m + defaultThickness);
    const thickness = Math.max(1, base - t.md_m);
    // ages: the layer was deposited from the lower surface's age (older) to the upper surface's age
    // (younger); an unconformity ABOVE the layer stops deposition at the older bound of its hiatus
    const ageEnd = Number.isFinite(t.hiatus_to_ma) ? t.hiatus_to_ma : (Number.isFinite(t.age_ma) ? t.age_ma : null);
    const ageStart = next && Number.isFinite(next.age_ma) ? next.age_ma : null;
    const dated = ageStart !== null && ageEnd !== null && ageStart > ageEnd;
    if (ageStart !== null && ageEnd !== null && !(ageStart > ageEnd)) problems.push(`${t.name}: the layer below it would be deposited from ${ageStart} to ${ageEnd} Ma, which is not older to younger.`);
    const dom = dominantLithology(intervals, t.md_m, base);
    const lith = dom ? basinLithology(dom) : null;
    const guess = /sand|sst|reservoir/i.test(t.name) ? 'sandstone' : /lime|carb|chalk|dolo/i.test(t.name) ? 'limestone' : /salt|halite|evap|anhy/i.test(t.name) ? 'salt' : /coal|lig/i.test(t.name) ? 'coal' : 'shale';
    layers.push({
      id: idFor(i), name: t.name, top_md_m: t.md_m, base_md_m: base, thickness,
      lithology: lith || guess, lithologyGuessed: !lith,
      ageStart: dated ? ageStart : 10 * (i + 1), ageEnd: dated ? ageEnd : 10 * i, agesGuessed: !dated,
      sourceRock: { isSource: false, toc: 0, hi: 0, kerogen: 'type2' },
    });
    if (Number.isFinite(t.hiatus_to_ma) && Number.isFinite(t.age_ma)) {
      erosionEvents.push({ age: t.age_ma, amount: 0, from_ma: t.age_ma, to_ma: t.hiatus_to_ma, surface: t.name, amountUnknown: true });
      problems.push(`${t.name}: erosion between ${t.age_ma} and ${t.hiatus_to_ma} Ma, amount unknown; type the eroded thickness in Basin & Charge Modeling.`);
    }
  }
  if (layers.some((l) => l.agesGuessed)) problems.push('Some layers have placeholder ages; date their bounding surfaces in the Tops view.');
  return { layers, erosionEvents, problems };
}
