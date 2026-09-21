// Age-depth arithmetic (Stratigraphy Studio ST2, 2026-09-06).
//
// A well's dated surfaces (measured depth, age in Ma, and for an
// unconformity the age of the youngest rock preserved below it) define a
// piecewise-linear age-depth model: constant accumulation rate between
// consecutive dated surfaces, a hiatus where a surface carries
// `hiatus_to_ma` (deposition stopped at hiatus_to_ma and resumed at
// age_ma). Depth increases with age; the model refuses an inversion
// rather than fitting through it. Closed-form: analytic tests.
//
// Conventions: depth in metres MD, age in Ma, older is larger. The
// seabed (or the shallowest dated point) may be given as age 0.

const EPS = 1e-9;

/**
 * @typedef {Object} DatedSurface
 * @property {string} [name]
 * @property {number} md_m
 * @property {number} age_ma          age of the surface (deposition resumed at this age)
 * @property {?number} [hiatus_to_ma] for an unconformity: age of the rock just below (older than age_ma)
 * @property {string} [surface_type]
 */

/** Shallow to deep. */
export const sortDated = (points) => [...(points || [])].filter((p) => Number.isFinite(p.md_m) && Number.isFinite(p.age_ma)).sort((a, b) => a.md_m - b.md_m);

/**
 * Problems an age-depth set has: a shallower surface older than a deeper
 * one (inversion), a hiatus bound younger than its surface, duplicates.
 * @returns {Array<{ name: ?string, code: string, message: string }>}
 */
export function validateAgeDepth(points) {
  const problems = [];
  const list = sortDated(points);
  for (const p of list) {
    if (p.hiatus_to_ma != null && !(p.hiatus_to_ma > p.age_ma)) {
      problems.push({ name: p.name ?? null, code: 'hiatus', message: `${p.name || `${p.md_m} m`}: the hiatus must end older than the surface (${p.hiatus_to_ma} Ma is not older than ${p.age_ma} Ma).` });
    }
  }
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]; const b = list[i];
    const aOld = a.hiatus_to_ma != null ? a.hiatus_to_ma : a.age_ma;
    if (b.md_m - a.md_m < EPS) {
      problems.push({ name: b.name ?? null, code: 'duplicate', message: `${b.name || `${b.md_m} m`} sits at the same depth as ${a.name || `${a.md_m} m`}.` });
    } else if (b.age_ma < aOld - EPS) {
      problems.push({ name: b.name ?? null, code: 'inversion', message: `${b.name || `${b.md_m} m`} (${b.age_ma} Ma) is deeper than ${a.name || `${a.md_m} m`} (${aOld} Ma) but younger.` });
    }
  }
  return problems;
}

/**
 * The model: segments between consecutive dated surfaces (top age is the
 * older bound of the upper surface's hiatus if it has one), each with a
 * rate in m per Ma, plus the hiatuses. Returns null when fewer than two
 * dated surfaces or the set is invalid.
 * @returns {{ segments: Array<{top_md_m, base_md_m, age_top_ma, age_base_ma, rate_m_per_ma, upper: ?string, lower: ?string}>, hiatuses: Array<{md_m, from_ma, to_ma, name: ?string}>, points: DatedSurface[] } | null}
 */
export function ageDepthModel(points) {
  const list = sortDated(points);
  if (list.length < 2 || validateAgeDepth(list).length) return null;
  const segments = [];
  const hiatuses = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]; const b = list[i];
    const ageTop = a.hiatus_to_ma != null ? a.hiatus_to_ma : a.age_ma;
    const dz = b.md_m - a.md_m;
    const dt = b.age_ma - ageTop;
    segments.push({
      top_md_m: a.md_m, base_md_m: b.md_m, age_top_ma: ageTop, age_base_ma: b.age_ma,
      rate_m_per_ma: dt > EPS ? dz / dt : null,   // null: an instantaneous (event) bed
      upper: a.name ?? null, lower: b.name ?? null,
    });
  }
  for (const p of list) if (p.hiatus_to_ma != null) hiatuses.push({ md_m: p.md_m, from_ma: p.age_ma, to_ma: p.hiatus_to_ma, name: p.name ?? null });
  return { segments, hiatuses, points: list };
}

/**
 * Age at a depth: linear within a segment, the surface age on a surface
 * (the younger side of a hiatus), null outside the dated range.
 */
export function ageAt(model, md) {
  if (!model || !Number.isFinite(md)) return null;
  const { segments, points } = model;
  if (md < points[0].md_m - EPS || md > points[points.length - 1].md_m + EPS) return null;
  for (const s of segments) {
    if (md >= s.top_md_m - EPS && md <= s.base_md_m + EPS) {
      if (Math.abs(md - s.top_md_m) <= EPS) {
        const p = points.find((q) => Math.abs(q.md_m - s.top_md_m) <= EPS);
        return p ? p.age_ma : s.age_top_ma;
      }
      const f = (md - s.top_md_m) / (s.base_md_m - s.top_md_m);
      return s.age_top_ma + f * (s.age_base_ma - s.age_top_ma);
    }
  }
  return null;
}

/**
 * Depth at an age: linear within a segment; an age inside a hiatus maps
 * to the hiatus surface (nothing was deposited then); null outside the
 * dated range.
 */
export function depthAt(model, ma) {
  if (!model || !Number.isFinite(ma)) return null;
  const { segments, hiatuses } = model;
  for (const h of hiatuses) if (ma >= h.from_ma - EPS && ma <= h.to_ma + EPS) return h.md_m;
  for (const s of segments) {
    if (ma >= s.age_top_ma - EPS && ma <= s.age_base_ma + EPS) {
      const dt = s.age_base_ma - s.age_top_ma;
      if (dt <= EPS) return s.top_md_m;
      const f = (ma - s.age_top_ma) / dt;
      return s.top_md_m + f * (s.base_md_m - s.top_md_m);
    }
  }
  return null;
}

/** Accumulation rate per segment, m per Ma, with the bounding names. */
export const accumulationRates = (model) => (model ? model.segments.map((s) => ({ upper: s.upper, lower: s.lower, top_md_m: s.top_md_m, base_md_m: s.base_md_m, rate_m_per_ma: s.rate_m_per_ma })) : []);
