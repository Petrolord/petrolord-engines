// Log editing (QI programme Q1, Milestone A3): splice runs, interval
// edits with a ledger, and sonic drift correction against checkshots.
// Shared engine conventions (conditioning.js): pure, float64,
// NaN-propagating, no I/O, every curve on ONE depth grid (the registry
// resamples runs onto it). The caller saves the result as a NEW curve with
// the ledger in its provenance; raw curves are never overwritten.
//
// Sonic drift (the standard calibration of a sonic log to checkshots;
// e.g. Schlumberger, Log Interpretation Principles; White, 1983): the sonic
// integrated from the first checkshot level gives one-way times t_s(z); the
// drift at each checkshot is D_k = t_cs(z_k) - t_s(z_k). Between two levels
// the drift change is spread as a constant slowness correction
// dD / dz, so the corrected sonic integrates to the checkshot time at every
// level (the block-shift method; the minimum-delta-t variant that loads the
// correction onto the slow samples only is not offered). Above the first and
// below the last level the sonic is left as it was and the result says so.

import { despikeHampel } from './conditioning.js';

const fin = Number.isFinite;

function checkGrid(depth, x) {
  if (!depth || depth.length < 2) throw new Error('The depth grid needs at least two samples.');
  if (x && x.length !== depth.length) throw new Error('The curve and the depth grid must have the same length.');
  for (let i = 1; i < depth.length; i++) {
    if (!(depth[i] > depth[i - 1])) throw new Error('Depth must increase down the grid.');
  }
}

// ---------------------------------------------------------------------------
// Splice

/**
 * Join runs of one curve into a single curve. Each sample takes the first
 * run (in the order given) whose [top, base] holds it and has a value
 * there. With matchWindowM > 0 each later run is shifted by the mean
 * difference to the curve built so far over the overlap just above its top
 * (both finite), the usual level match at a join; the offsets are reported.
 * @param {ArrayLike<number>} depth
 * @param {Array<{x: ArrayLike<number>, top: number, base: number, name?: string}>} runs
 * @param {{matchWindowM?: number}} [opts]
 * @returns {{x: Float64Array, source: Int16Array, joins: Array<{run: string, at: number, offset: number, nOverlap: number}>}}
 *   source is the run index per sample (-1 none)
 */
export function spliceRuns(depth, runs, { matchWindowM = 0 } = {}) {
  checkGrid(depth);
  if (!Array.isArray(runs) || runs.length === 0) throw new Error('Give at least one run.');
  for (const r of runs) {
    if (r.x?.length !== depth.length) throw new Error(`Run ${r.name || ''} is not on the depth grid.`);
    if (!(r.base > r.top)) throw new Error(`Run ${r.name || ''} needs a base below its top.`);
  }
  if (!(matchWindowM >= 0)) throw new Error('The match window must be zero or positive.');
  const n = depth.length;
  const out = new Float64Array(n).fill(NaN);
  const source = new Int16Array(n).fill(-1);
  const joins = [];
  runs.forEach((r, k) => {
    let offset = 0;
    let nOverlap = 0;
    if (k > 0 && matchWindowM > 0) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const z = depth[i];
        if (z < r.top - matchWindowM || z > r.top + matchWindowM) continue;
        if (fin(out[i]) && fin(r.x[i])) { s += out[i] - r.x[i]; nOverlap += 1; }
      }
      offset = nOverlap ? s / nOverlap : 0;
    }
    if (k > 0) joins.push({ run: r.name || `run ${k + 1}`, at: r.top, offset, nOverlap });
    for (let i = 0; i < n; i++) {
      if (source[i] >= 0) continue;
      const z = depth[i];
      if (z < r.top || z > r.base || !fin(r.x[i])) continue;
      out[i] = r.x[i] + offset;
      source[i] = k;
    }
  });
  return { x: out, source, joins };
}

// ---------------------------------------------------------------------------
// Interval edits

const EDIT_OPS = ['null', 'constant', 'interpolate', 'scale', 'offset', 'despike', 'clip'];

/**
 * Apply edits in order, each over [top, base] (inclusive).
 *   null          the samples become null
 *   constant      value
 *   interpolate   a straight line between the nearest values just outside the interval
 *   scale         factor
 *   offset        value added
 *   despike       Hampel (halfWindow samples, nSigma) inside the interval
 *   clip          samples outside [min, max] become null
 * @returns {{x: Float64Array, ledger: Array<{op, top, base, changed: number, params: Object}>}}
 */
export function applyEdits(depth, x, edits) {
  checkGrid(depth, x);
  const n = depth.length;
  let cur = Float64Array.from(x, (v) => (fin(v) ? v : NaN));
  const ledger = [];
  for (const e of edits || []) {
    if (!EDIT_OPS.includes(e.op)) throw new Error(`Unknown edit: ${e.op}.`);
    if (!(e.base >= e.top)) throw new Error('An edit needs a base at or below its top.');
    const inside = [];
    for (let i = 0; i < n; i++) if (depth[i] >= e.top && depth[i] <= e.base) inside.push(i);
    const before = Float64Array.from(cur);
    if (e.op === 'null') for (const i of inside) cur[i] = NaN;
    else if (e.op === 'constant') {
      if (!fin(e.value)) throw new Error('A constant edit needs a value.');
      for (const i of inside) cur[i] = e.value;
    } else if (e.op === 'scale') {
      if (!fin(e.factor)) throw new Error('A scale edit needs a factor.');
      for (const i of inside) cur[i] *= e.factor;
    } else if (e.op === 'offset') {
      if (!fin(e.value)) throw new Error('An offset edit needs a value.');
      for (const i of inside) cur[i] += e.value;
    } else if (e.op === 'clip') {
      const lo = fin(e.min) ? e.min : -Infinity;
      const hi = fin(e.max) ? e.max : Infinity;
      for (const i of inside) if (!(cur[i] >= lo && cur[i] <= hi)) cur[i] = NaN;
    } else if (e.op === 'interpolate') {
      if (!inside.length) { ledger.push({ op: e.op, top: e.top, base: e.base, changed: 0, params: {} }); continue; }
      let a = inside[0] - 1;
      while (a >= 0 && !fin(cur[a])) a--;
      let b = inside[inside.length - 1] + 1;
      while (b < n && !fin(cur[b])) b++;
      if (a < 0 || b >= n) throw new Error('Interpolation needs a value above and below the interval.');
      for (const i of inside) cur[i] = cur[a] + ((cur[b] - cur[a]) * (depth[i] - depth[a])) / (depth[b] - depth[a]);
    } else if (e.op === 'despike') {
      const hw = Math.max(1, Math.round(e.halfWindow ?? 5));
      const ns = e.nSigma ?? 3;
      const d = despikeHampel(cur, hw, ns);
      for (const i of inside) cur[i] = d[i];
    }
    let changed = 0;
    for (const i of inside) if (!(before[i] === cur[i] || (Number.isNaN(before[i]) && Number.isNaN(cur[i])))) changed += 1;
    const { op, top, base, ...params } = e;
    ledger.push({ op, top, base, changed, params });
  }
  return { x: cur, ledger };
}

// ---------------------------------------------------------------------------
// Sonic drift against checkshots

/**
 * One-way time down a slowness curve (us/m) by the trapezoid rule, in
 * seconds from the first depth, bridging interior nulls linearly (the gap
 * length is reported). NaN above the first and below the last value.
 */
export function integrateSlowness(depth, dt) {
  checkGrid(depth, dt);
  const n = depth.length;
  let first = -1; let last = -1;
  for (let i = 0; i < n; i++) if (fin(dt[i])) { if (first < 0) first = i; last = i; }
  const t = new Float64Array(n).fill(NaN);
  if (first < 0) return { t, gapM: 0, first, last };
  // bridge interior gaps for the integration only
  const filled = Float64Array.from(dt);
  let gapM = 0;
  for (let i = first + 1; i < last; i++) {
    if (fin(filled[i])) continue;
    let b = i;
    while (!fin(dt[b])) b++;
    const a = i - 1;
    for (let j = i; j < b; j++) filled[j] = filled[a] + ((dt[b] - filled[a]) * (depth[j] - depth[a])) / (depth[b] - depth[a]);
    gapM += depth[b] - depth[a];
    i = b - 1;
  }
  t[first] = 0;
  for (let i = first + 1; i <= last; i++) t[i] = t[i - 1] + 0.5 * (filled[i - 1] + filled[i]) * (depth[i] - depth[i - 1]) * 1e-6;
  return { t, gapM, first, last };
}

/** Linear interpolation of a sampled function at z (NaN outside). */
function at(depth, y, z) {
  if (!(z >= depth[0] && z <= depth[depth.length - 1])) return NaN;
  let lo = 0; let hi = depth.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (depth[mid] <= z) lo = mid; else hi = mid; }
  const f = depth[hi] === depth[lo] ? 0 : (z - depth[lo]) / (depth[hi] - depth[lo]);
  return y[lo] + f * (y[hi] - y[lo]);
}

/**
 * Drift-correct a sonic to checkshots.
 * @param {{depth: ArrayLike<number>, dt: ArrayLike<number>, checkshots: Array<{md: number, owtS: number}>}} p
 *   dt in us/m on the depth grid; checkshot one-way times (s) at the same
 *   measured depths along the well (the caller corrects geometry)
 * @returns {{dt: Float64Array, drift: Array<{md, owtS, sonicS, driftMs}>, corrections: Array<{top, base, dtCorrUsM}>, closureMs: number,
 *   usedLevels: number, outside: {above: boolean, below: boolean}, gapM: number}}
 */
export function sonicDriftCorrection({ depth, dt, checkshots }) {
  checkGrid(depth, dt);
  const { t, gapM, first, last } = integrateSlowness(depth, dt);
  if (first < 0) throw new Error('The sonic has no values.');
  const zTop = depth[first]; const zBase = depth[last];
  const levels = (checkshots || [])
    .filter((c) => fin(c.md) && fin(c.owtS) && c.md >= zTop && c.md <= zBase)
    .sort((a, b) => a.md - b.md);
  if (levels.length < 2) throw new Error('Drift correction needs at least two checkshot levels inside the sonic.');
  for (let k = 1; k < levels.length; k++) {
    if (!(levels[k].owtS > levels[k - 1].owtS)) throw new Error(`Checkshot times must increase with depth (at ${levels[k].md} m).`);
  }
  // sonic time referenced to the first checkshot level
  const t0 = at(depth, t, levels[0].md);
  const drift = levels.map((c) => {
    const sonicS = levels[0].owtS + (at(depth, t, c.md) - t0);
    return { md: c.md, owtS: c.owtS, sonicS, driftMs: (c.owtS - sonicS) * 1e3 };
  });
  const out = Float64Array.from(dt, (v) => (fin(v) ? v : NaN));
  const corrections = [];
  for (let k = 0; k + 1 < drift.length; k++) {
    const a = drift[k]; const b = drift[k + 1];
    // drift change (us) over the interval (m): a constant slowness change
    const corr = ((b.driftMs - a.driftMs) * 1e3) / (b.md - a.md);
    corrections.push({ top: a.md, base: b.md, dtCorrUsM: corr });
    for (let i = 0; i < out.length; i++) {
      const z = depth[i];
      const inside = k + 2 === drift.length ? z >= a.md && z <= b.md : z >= a.md && z < b.md;
      if (inside && fin(out[i])) out[i] += corr;
    }
  }
  // closure: the corrected sonic's one-way time at each level against the
  // checkshot. The trapezoid cell that ends on a level mixes the two
  // intervals' corrections, so a residual of at most half the spread of the
  // corrections times the sample step remains (about 2 us for corrections
  // spanning 7 us/m on a 0.5 m grid).
  const tc = integrateSlowness(depth, out).t;
  const tc0 = at(depth, tc, levels[0].md);
  let closureMs = 0;
  for (const c of levels) closureMs = Math.max(closureMs, Math.abs(levels[0].owtS + (at(depth, tc, c.md) - tc0) - c.owtS) * 1e3);
  return {
    dt: out,
    drift,
    corrections,
    closureMs,
    usedLevels: levels.length,
    outside: { above: zTop < levels[0].md, below: zBase > levels[levels.length - 1].md },
    gapM,
  };
}
