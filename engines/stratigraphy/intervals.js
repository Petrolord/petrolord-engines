// Interval-log arithmetic (Stratigraphy Studio ST1, 2026-09-06).
//
// An interval is "a named thing between two depths on a well": lithology,
// core description, facies, environment, motif, systems tract, biozone.
// One table holds them all (geo_wells_intervals, keyed by kind). This
// module is the closed-form arithmetic the editors and painters need:
// ordering, overlap and gap checks per kind, rasterizing intervals onto a
// depth vector for the strip track, run-length encoding a per-sample
// categorical curve back into intervals (publishing crossplot facies),
// and the interval at a depth. Analytic tests only.

import { intervalColour, intervalLegend, isIntervalKind, resolveLithology } from './lithology';

const EPS = 1e-9;

/** Shallow to deep, then by kind, then by code, for a stable table. */
export function sortIntervals(rows) {
  return [...(rows || [])].sort((a, b) => (a.top_md_m - b.top_md_m) || (a.base_md_m - b.base_md_m)
    || String(a.kind).localeCompare(String(b.kind)) || String(a.code ?? '').localeCompare(String(b.code ?? '')));
}

/**
 * Problems an interval editor refuses to save, per well. Overlaps are
 * checked within one kind only: a lithology interval may well overlap a
 * facies interval. Messages are plain words the UI shows as-is.
 * @returns {Array<{ id: ?string, code: string, message: string }>}
 */
export function validateIntervals(rows) {
  const problems = [];
  const list = rows || [];
  for (const r of list) {
    const name = r.code || r.label || 'an interval';
    if (!isIntervalKind(r.kind)) problems.push({ id: r.id ?? null, code: 'kind', message: `${name}: kind "${r.kind}" is not an interval kind.` });
    if (!Number.isFinite(r.top_md_m)) problems.push({ id: r.id ?? null, code: 'depth', message: `${name}: the top depth is not a number.` });
    if (!Number.isFinite(r.base_md_m)) problems.push({ id: r.id ?? null, code: 'depth', message: `${name}: the base depth is not a number.` });
    if (Number.isFinite(r.top_md_m) && Number.isFinite(r.base_md_m) && !(r.base_md_m > r.top_md_m)) {
      problems.push({ id: r.id ?? null, code: 'order', message: `${name}: the base (${r.base_md_m} m) is not below the top (${r.top_md_m} m).` });
    }
    if (!String(r.code ?? r.label ?? '').trim()) problems.push({ id: r.id ?? null, code: 'code', message: `An interval at ${r.top_md_m} m has no code or label.` });
  }
  const byKind = new Map();
  for (const r of list) {
    if (!Number.isFinite(r.top_md_m) || !Number.isFinite(r.base_md_m)) continue;
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  for (const [kind, group] of byKind) {
    const sorted = sortIntervals(group);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]; const b = sorted[i];
      if (b.top_md_m < a.base_md_m - EPS) {
        problems.push({ id: b.id ?? null, code: 'overlap', message: `${kind}: "${b.code || b.label}" (${b.top_md_m} to ${b.base_md_m} m) overlaps "${a.code || a.label}" (${a.top_md_m} to ${a.base_md_m} m).` });
      }
    }
  }
  return problems;
}

/** Gaps between consecutive intervals of one kind, shallow to deep. */
export function intervalGaps(rows, kind) {
  const sorted = sortIntervals((rows || []).filter((r) => r.kind === kind));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]; const b = sorted[i];
    if (b.top_md_m > a.base_md_m + EPS) gaps.push({ top_md_m: a.base_md_m, base_md_m: b.top_md_m });
  }
  return gaps;
}

/** The interval of a kind that contains a depth (top inclusive, base exclusive), or null. */
export function intervalAt(rows, kind, md) {
  for (const r of rows || []) {
    if (r.kind !== kind) continue;
    if (md >= r.top_md_m - EPS && md < r.base_md_m - EPS) return r;
  }
  return null;
}

/** Merge consecutive intervals of one kind that touch and share a code. */
export function mergeAdjacent(rows, kind) {
  const sorted = sortIntervals((rows || []).filter((r) => r.kind === kind));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && String(last.code) === String(r.code) && Math.abs(last.base_md_m - r.top_md_m) <= EPS) {
      out[out.length - 1] = { ...last, base_md_m: r.base_md_m };
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Rasterize the intervals of one kind onto a depth vector for the strip
 * painter: per-sample category index (NaN outside every interval) plus
 * the category list with colours and labels. A sample belongs to the
 * interval that contains it, top inclusive.
 * @param {Array} rows
 * @param {string} kind
 * @param {ArrayLike<number>} depth measured depths, m, ascending
 * @returns {{ data: Float64Array, categories: Array<{code, label, colour}> }}
 */
export function rasterizeIntervals(rows, kind, depth) {
  const list = sortIntervals((rows || []).filter((r) => r.kind === kind));
  const categories = intervalLegend(list);
  const index = new Map(categories.map((c, i) => [c.code, i]));
  const n = depth ? depth.length : 0;
  const data = new Float64Array(n).fill(NaN);
  if (!list.length || !n) return { data, categories };
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = depth[i];
    if (!Number.isFinite(d)) continue;
    while (j < list.length && list[j].base_md_m - EPS <= d) j++;
    if (j >= list.length) break;
    const r = list[j];
    if (d >= r.top_md_m - EPS && d < r.base_md_m - EPS) data[i] = index.get(String(r.code ?? r.label ?? ''));
  }
  return { data, categories };
}

/**
 * Run-length encode a per-sample categorical curve (facies index or NaN,
 * the crossplot facies output) into intervals of one kind. Sample i
 * covers [depth[i], depth[i+1]); the last sample covers one median step.
 * Consecutive samples with the same index become one interval; NaN
 * breaks a run. `labels[k]` names index k, `colours[k]` colours it.
 * @returns {Array<{kind, top_md_m, base_md_m, code, label, properties}>}
 */
export function intervalsFromRuns(depth, values, labels, { kind = 'facies', colours = [], source = 'log' } = {}) {
  const n = Math.min(depth.length, values.length);
  if (!n) return [];
  const steps = [];
  for (let i = 1; i < n; i++) if (Number.isFinite(depth[i]) && Number.isFinite(depth[i - 1])) steps.push(depth[i] - depth[i - 1]);
  steps.sort((a, b) => a - b);
  const step = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  const out = [];
  let run = null;
  const close = (baseMd) => {
    if (!run) return;
    out.push({
      kind, top_md_m: run.top, base_md_m: baseMd, code: labels[run.k] ?? String(run.k), label: labels[run.k] ?? String(run.k),
      properties: { index: run.k, ...(colours[run.k] ? { colour: colours[run.k] } : {}) }, source,
    });
    run = null;
  };
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const d = depth[i];
    const k = Number.isFinite(v) ? Math.round(v) : null;
    if (k === null || !Number.isFinite(d)) { close(d); continue; }
    if (run && run.k === k) continue;
    close(d);
    run = { k, top: d };
  }
  close(Number.isFinite(depth[n - 1]) ? depth[n - 1] + step : depth[n - 1]);
  return out.filter((r) => r.base_md_m > r.top_md_m);
}

/** Total thickness (m) of intervals of a kind whose code resolves to a lithology class or equals a code. */
export function thicknessByCode(rows, kind) {
  const out = new Map();
  for (const r of rows || []) {
    if (r.kind !== kind || !Number.isFinite(r.top_md_m) || !Number.isFinite(r.base_md_m)) continue;
    const key = String(r.code ?? r.label ?? '');
    out.set(key, (out.get(key) || 0) + Math.max(0, r.base_md_m - r.top_md_m));
  }
  return Array.from(out, ([code, thickness_m]) => ({ code, label: resolveLithology(code)?.name || code, thickness_m }));
}

export { intervalColour, intervalLegend };
