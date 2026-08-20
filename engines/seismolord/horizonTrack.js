// Horizon tracking engine (Phase 3): snap picking with parabolic
// sub-sample refinement, guided 2D autotrack along a section, and 3D
// seeded region-grow over an async trace accessor (bricks arrive through
// the cache; the tracker never sees the file).
//
// All z values are SAMPLE indices (float, sub-sample) — time increases
// downward with sample index (domain rule). Untracked/lost positions are
// NULL_VALUE and nulls never enter statistics.

import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

export const SNAP_MODES = ['peak', 'trough', 'zero_pos', 'zero_neg'];

// ---- Tracker 2.0 (W3.2): normalized cross-correlation mode ------------
//
// 'ncc' tracks the WAVEFORM, not an event kind: the previous trace's
// window around its pick is the reference, correlated against the
// candidate trace over a lag search window; the correlation peak
// (parabolic sub-sample refinement) is the new pick and the peak
// coefficient is the pick's CONFIDENCE (stored in the companion layer).
// Picks below corrThreshold are rejected — the classic guided-tracker
// stop rule.

/**
 * Extract a clean reference window (2·half+1 samples) centred at the
 * rounded sample; null when it would leave the trace or touch a null.
 */
export function refWindow(trace, sample, half) {
  const c = Math.round(sample);
  if (c - half < 0 || c + half >= trace.length) return null;
  const out = new Float32Array(2 * half + 1);
  for (let k = -half; k <= half; k++) {
    const v = trace[c + k];
    if (isNull(v)) return null;
    out[k + half] = v;
  }
  return out;
}

/** Normalized cross-correlation of a reference window against the
 *  candidate window centred at c (same length); null on nulls/flat. */
function nccAt(ref, trace, c) {
  const half = (ref.length - 1) / 2;
  if (c - half < 0 || c + half >= trace.length) return null;
  let sr = 0; let sc = 0;
  for (let k = -half; k <= half; k++) {
    const v = trace[c + k];
    if (isNull(v)) return null;
    sr += ref[k + half];
    sc += v;
  }
  const n = ref.length;
  const mr = sr / n;
  const mc = sc / n;
  let num = 0; let dr = 0; let dc = 0;
  for (let k = -half; k <= half; k++) {
    const a = ref[k + half] - mr;
    const b = trace[c + k] - mc;
    num += a * b;
    dr += a * a;
    dc += b * b;
  }
  const denom = Math.sqrt(dr * dc);
  if (denom < 1e-20) return null; // flat window has no correlation
  return num / denom;
}

/**
 * Correlation pick: slide the reference over the candidate trace within
 * ±search samples of `center`, take the best NCC lag, refine the peak
 * parabolically, and gate on the threshold.
 *
 * @param {Float32Array} ref reference window (refWindow)
 * @param {Float32Array} trace candidate trace
 * @param {number} center expected sample on the candidate (float ok)
 * @param {{search?: number, threshold?: number}} [opts]
 * @returns {{sample: number, coeff: number}|null}
 */
export function correlatePick(ref, trace, center, { search = 5, threshold = 0.7 } = {}) {
  const c0 = Math.round(center);
  let bestLag = null;
  let bestVal = -Infinity;
  const vals = new Map();
  for (let lag = -search; lag <= search; lag++) {
    const v = nccAt(ref, trace, c0 + lag);
    if (v === null) continue;
    vals.set(lag, v);
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  if (bestLag === null || bestVal < threshold) return null;
  // parabolic refinement over the correlation peak
  const vm = vals.get(bestLag - 1);
  const vp = vals.get(bestLag + 1);
  let refine = 0;
  let coeff = bestVal;
  if (vm !== undefined && vp !== undefined) {
    const denom = vm - 2 * bestVal + vp;
    if (denom !== 0) {
      const d = (0.5 * (vm - vp)) / denom;
      if (Math.abs(d) <= 1) {
        refine = d;
        coeff = bestVal - 0.25 * (vm - vp) * d;
      }
    }
  }
  return { sample: c0 + bestLag + refine, coeff: Math.min(1, coeff) };
}

/**
 * Zero-crossing snap: the crossing of the requested direction NEAREST to
 * the requested sample (extrema snap to the strongest, crossings to the
 * closest — a crossing has no amplitude to rank by). Position is the
 * linear zero between the bracketing samples; the returned amp is the
 * strongest flanking amplitude (±3 samples) so autotrack's minAbsAmp /
 * dead-trace gates keep working where the value at the pick is ~0.
 */
function snapZero(trace, sample, mode, window) {
  const ns = trace.length;
  const c = Math.round(sample);
  const lo = Math.max(0, c - window);
  const hi = Math.min(ns - 2, c + window);
  let best = null;
  let bestDist = Infinity;
  for (let i = lo; i <= hi; i++) {
    const v0 = trace[i];
    const v1 = trace[i + 1];
    if (isNull(v0) || isNull(v1)) continue;
    const crosses = mode === 'zero_pos' ? (v0 < 0 && v1 >= 0) : (v0 > 0 && v1 <= 0);
    if (!crosses) continue;
    const x = i + v0 / (v0 - v1);
    const dist = Math.abs(x - sample);
    if (dist < bestDist) { bestDist = dist; best = { i, x }; }
  }
  if (!best) return null;
  let amp = 0;
  for (let j = Math.max(0, best.i - 2); j <= Math.min(ns - 1, best.i + 3); j++) {
    if (!isNull(trace[j])) amp = Math.max(amp, Math.abs(trace[j]));
  }
  return { sample: best.x, amp };
}

/**
 * Snap to the nearest event of the requested kind within a sample
 * window: extrema ('peak'/'trough', parabolic sub-sample refinement) or
 * zero crossings ('zero_pos' = − to +, 'zero_neg' = + to −, linear
 * sub-sample position).
 *
 * @param {Float32Array} trace
 * @param {number} sample centre of the search window (float ok)
 * @param {{mode?: 'peak'|'trough'|'zero_pos'|'zero_neg', window?: number}} [opts]
 * @returns {{sample: number, amp: number}|null} null if no event found
 */
export function snapPick(trace, sample, { mode = 'peak', window = 3 } = {}) {
  if (mode === 'zero_pos' || mode === 'zero_neg') {
    return snapZero(trace, sample, mode, window);
  }
  const ns = trace.length;
  const c = Math.round(sample);
  const lo = Math.max(1, c - window);
  const hi = Math.min(ns - 2, c + window);
  if (lo > hi) return null;

  const sign = mode === 'trough' ? -1 : 1;
  let best = -1;
  let bestVal = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const vm = trace[i - 1];
    const v0 = trace[i];
    const vp = trace[i + 1];
    if (isNull(v0) || isNull(vm) || isNull(vp)) continue;
    const a0 = sign * v0;
    // strict local extremum of the requested polarity, positive lobe
    if (a0 > 0 && a0 >= sign * vm && a0 >= sign * vp && a0 > bestVal) {
      best = i;
      bestVal = a0;
    }
  }
  if (best < 0) return null;

  // parabolic refinement: x* = x0 + 0.5 (a-1 - a+1) / (a-1 - 2 a0 + a+1)
  const am = trace[best - 1];
  const a0 = trace[best];
  const ap = trace[best + 1];
  const denom = am - 2 * a0 + ap;
  let refined = best;
  if (denom !== 0) {
    const d = (0.5 * (am - ap)) / denom;
    if (Math.abs(d) <= 1) refined = best + d;
  }
  return { sample: refined, amp: a0 };
}

/**
 * Guided 2D autotrack across a section slice (assembleSlice layout:
 * data[trace * ns + sample]).
 *
 * @param {{data: Float32Array, width: number, height: number}} slice
 *   width = ns, height = trace count
 * @param {number} startTrace
 * @param {number} startSample
 * @param {{mode?: string, window?: number, maxJump?: number, minAbsAmp?: number}} [opts]
 * @returns {{picks: Float32Array, tracked: number}} picks[trace] = sample
 *   (float) or NULL_VALUE where the event was lost
 */
export function autotrack2D(slice, startTrace, startSample, opts = {}) {
  const {
    maxJump = 3, minAbsAmp = 0, mode = 'peak',
    corrHalf = 8, corrSearch = 5, corrThreshold = 0.7,
  } = opts;
  const ns = slice.width;
  const nTraces = slice.height;
  const picks = new Float32Array(nTraces).fill(NULL_F32);
  const confidence = new Float32Array(nTraces).fill(NULL_F32);
  const traceAt = (t) => slice.data.subarray(t * ns, (t + 1) * ns);
  const ncc = mode === 'ncc';

  const seedSnap = ncc
    ? (refWindow(traceAt(startTrace), startSample, corrHalf)
      ? { sample: startSample } : null)
    : snapPick(traceAt(startTrace), startSample, opts);
  if (!seedSnap) return { picks, tracked: 0, confidence };
  picks[startTrace] = seedSnap.sample;
  if (ncc) confidence[startTrace] = 1;
  let tracked = 1;

  for (const dir of [1, -1]) {
    let prev = seedSnap.sample;
    let prevTrace = startTrace;
    for (let t = startTrace + dir; t >= 0 && t < nTraces; t += dir) {
      if (ncc) {
        // rolling reference: the previous trace's window at its pick.
        // The window is cut at round(prev), so the aligned position is
        // corrected by the sub-sample residual (prev − round(prev)) —
        // without it a dipping event accumulates a half-sample bias.
        const ref = refWindow(traceAt(prevTrace), prev, corrHalf);
        const hit = ref && correlatePick(ref, traceAt(t), prev, {
          search: corrSearch, threshold: corrThreshold,
        });
        const pick = hit ? hit.sample + (prev - Math.round(prev)) : null;
        if (!hit || Math.abs(pick - prev) > maxJump) break;
        picks[t] = pick;
        confidence[t] = hit.coeff;
        prev = pick;
        prevTrace = t;
      } else {
        const hit = snapPick(traceAt(t), prev, opts);
        if (!hit || Math.abs(hit.sample - prev) > maxJump
          || Math.abs(hit.amp) < minAbsAmp) break;
        picks[t] = hit.sample;
        prev = hit.sample;
      }
      tracked += 1;
    }
  }
  return { picks, tracked, confidence };
}

/**
 * 3D seeded region-grow over the volume. Tracker 2.0 (W3.2) additions,
 * all opt-in and default-off so pre-W3.2 behavior is bit-identical:
 *
 *  - mode 'ncc': each accepted cell's own trace window becomes the
 *    reference for its neighbours (rolling reference), the correlation
 *    peak is the pick and its coefficient the confidence;
 *  - opts.seeds: additional seeds beyond the primary (multi-seed);
 *  - opts.initialPicks: grow FROM an existing horizon — every live cell
 *    seeds the queue and keeps its value exactly (confidence stays null
 *    on pre-existing picks);
 *  - opts.barriers: nIl x nXl mask (rasterizeTraces) — growth never
 *    assigns a pick on a barrier cell, so faults stop the tracker the
 *    same way they stop gridding.
 *
 * @param {(ilIdx: number, xlIdx: number) => Promise<Float32Array>} getTrace
 * @param {{nIl: number, nXl: number, ns: number}} geom
 * @param {{ilIdx: number, xlIdx: number, sample: number}|null} seed
 * @param {{mode?: string, window?: number, maxJump?: number,
 *          minAbsAmp?: number, corrHalf?: number, corrSearch?: number,
 *          corrThreshold?: number,
 *          seeds?: {ilIdx:number, xlIdx:number, sample:number}[],
 *          initialPicks?: Float32Array, barriers?: Uint8Array,
 *          onProgress?: (tracked: number, total: number) => void,
 *          shouldCancel?: () => boolean}} [opts]
 * @returns {Promise<{picks: Float32Array, tracked: number,
 *   confidence: Float32Array}>} picks[ilIdx * nXl + xlIdx] = sample
 *   (float) or NULL_VALUE; confidence carries NCC coefficients (1e30
 *   where absent)
 */
export async function regionGrow3D(getTrace, geom, seed, opts = {}) {
  const {
    maxJump = 3, minAbsAmp = 0, mode = 'peak',
    corrHalf = 8, corrSearch = 5, corrThreshold = 0.7,
    seeds = null, initialPicks = null, barriers = null,
    onProgress, shouldCancel,
  } = opts;
  const { nIl, nXl } = geom;
  const total = nIl * nXl;
  const picks = new Float32Array(total).fill(NULL_F32);
  const confidence = new Float32Array(total).fill(NULL_F32);
  const ncc = mode === 'ncc';

  const queue = [];
  let tracked = 0;

  const admitSeed = async (s) => {
    if (!s) return;
    const idx = s.ilIdx * nXl + s.xlIdx;
    if (picks[idx] !== NULL_F32) return;
    if (barriers && barriers[idx]) return;
    const trace = await getTrace(s.ilIdx, s.xlIdx);
    if (ncc) {
      if (!refWindow(trace, s.sample, corrHalf)) return;
      picks[idx] = s.sample;
      confidence[idx] = 1;
    } else {
      const hit = snapPick(trace, s.sample, opts);
      if (!hit) return;
      picks[idx] = hit.sample;
    }
    tracked += 1;
    queue.push([s.ilIdx, s.xlIdx]);
  };

  if (initialPicks) {
    for (let c = 0; c < total; c++) {
      const v = initialPicks[c];
      if (v === NULL_F32 || !Number.isFinite(v)) continue;
      if (barriers && barriers[c]) continue;
      picks[c] = v;               // existing interpretation kept exactly
      tracked += 1;
      queue.push([Math.floor(c / nXl), c % nXl]);
    }
  }
  await admitSeed(seed);
  for (const s of seeds || []) await admitSeed(s);
  if (tracked === 0) return { picks, tracked: 0, confidence };

  // FIFO breadth-first growth so the pick propagates evenly outward
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (queue.length > 0) {
    if (shouldCancel && shouldCancel()) throw new Error('Horizon tracking cancelled.');
    const [il, xl] = queue.shift();
    const from = picks[il * nXl + xl];
    const ref = ncc ? refWindow(await getTrace(il, xl), from, corrHalf) : null;
    if (ncc && !ref) continue;    // e.g. an initial pick too near the edge
    for (const [di, dx] of NEIGHBOURS) {
      const ni = il + di;
      const nx = xl + dx;
      if (ni < 0 || ni >= nIl || nx < 0 || nx >= nXl) continue;
      const idx = ni * nXl + nx;
      if (picks[idx] !== NULL_F32) continue;
      if (barriers && barriers[idx]) continue;
      if (ncc) {
        const hit = correlatePick(ref, await getTrace(ni, nx), from, {
          search: corrSearch, threshold: corrThreshold,
        });
        // sub-sample residual correction: the reference window is cut
        // at round(from) (see autotrack2D for the derivation)
        const pick = hit ? hit.sample + (from - Math.round(from)) : null;
        if (!hit || Math.abs(pick - from) > maxJump) continue;
        picks[idx] = pick;
        confidence[idx] = hit.coeff;
      } else {
        const hit = snapPick(await getTrace(ni, nx), from, opts);
        if (!hit || Math.abs(hit.sample - from) > maxJump
          || Math.abs(hit.amp) < minAbsAmp) continue;
        picks[idx] = hit.sample;
      }
      tracked += 1;
      queue.push([ni, nx]);
      if (onProgress && tracked % 256 === 0) onProgress(tracked, total);
    }
  }
  if (onProgress) onProgress(tracked, total);
  return { picks, tracked, confidence };
}

/**
 * Null-aware horizon smoothing: each LIVE cell becomes the mean (or
 * median — the spike killer) of the live cells in its (2·radius+1)²
 * neighbourhood, self included. Nulls stay null and never enter the
 * statistic, so coverage is preserved exactly — smoothing neither grows
 * nor shrinks the interpreted area.
 *
 * @param {Float32Array} picks nIl x nXl sample indices, 1e30 nulls
 * @param {{radius?: number, method?: 'mean'|'median'}} [opts]
 * @returns {Float32Array} new grid (input untouched)
 */
export function smoothHorizon(picks, nIl, nXl, { radius = 1, method = 'mean' } = {}) {
  const out = new Float32Array(picks.length);
  const vals = [];
  for (let i = 0; i < nIl; i++) {
    for (let x = 0; x < nXl; x++) {
      const c = i * nXl + x;
      if (picks[c] === NULL_F32) { out[c] = NULL_F32; continue; }
      const i0 = Math.max(0, i - radius);
      const i1 = Math.min(nIl - 1, i + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(nXl - 1, x + radius);
      if (method === 'median') {
        vals.length = 0;
        for (let ii = i0; ii <= i1; ii++) {
          for (let xx = x0; xx <= x1; xx++) {
            const v = picks[ii * nXl + xx];
            if (v !== NULL_F32) vals.push(v);
          }
        }
        vals.sort((a, b) => a - b);
        const m = vals.length >> 1;
        out[c] = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
      } else {
        let sum = 0;
        let n = 0;
        for (let ii = i0; ii <= i1; ii++) {
          for (let xx = x0; xx <= x1; xx++) {
            const v = picks[ii * nXl + xx];
            if (v === NULL_F32) continue;
            sum += v;
            n += 1;
          }
        }
        out[c] = sum / n;               // n >= 1: the cell itself is live
      }
    }
  }
  return out;
}

/**
 * Cell-wise horizon difference b − a (isochron when a is the shallower
 * event: positive = b deeper). Null wherever EITHER pick is null — an
 * interval needs both bounding surfaces (playbook null rule).
 *
 * @param {Float32Array} a picks (sample indices, 1e30 nulls)
 * @param {Float32Array} b picks, same grid shape
 * @returns {Float32Array} b − a in SAMPLE units (callers scale to ms)
 */
export function horizonDifference(a, b) {
  const out = new Float32Array(a.length);
  for (let c = 0; c < a.length; c++) {
    out[c] = a[c] === NULL_F32 || b[c] === NULL_F32 ? NULL_F32 : b[c] - a[c];
  }
  return out;
}

/**
 * Fill INTERIOR holes of a horizon by membrane interpolation. A hole is
 * a null region NOT connected (4-neighbour) to the grid border — the
 * uninterpreted exterior stays exactly as it was, so the interpreted
 * outline never grows outward.
 *
 * Hole cells are seeded onion-peel inward (mean of already-valued
 * 8-neighbours) then relaxed with Gauss–Seidel Laplace iterations
 * against the live picks as fixed boundary values — a planar horizon
 * fills back exactly planar.
 *
 * @param {Float32Array} picks nIl x nXl sample indices, 1e30 nulls
 * @param {{maxIterations?: number, tolerance?: number}} [opts]
 * @returns {{grid: Float32Array, filled: number}} new grid + cells filled
 */
export function fillHorizonHoles(picks, nIl, nXl, {
  maxIterations = 200, tolerance = 1e-4,
} = {}) {
  const n = nIl * nXl;
  const out = new Float32Array(picks);

  // flood the exterior null region from the border (4-connectivity)
  const exterior = new Uint8Array(n);
  const stack = [];
  const pushIfNull = (c) => {
    if (picks[c] === NULL_F32 && !exterior[c]) { exterior[c] = 1; stack.push(c); }
  };
  for (let x = 0; x < nXl; x++) { pushIfNull(x); pushIfNull((nIl - 1) * nXl + x); }
  for (let i = 0; i < nIl; i++) { pushIfNull(i * nXl); pushIfNull(i * nXl + nXl - 1); }
  while (stack.length) {
    const c = stack.pop();
    const i = (c / nXl) | 0;
    const x = c % nXl;
    if (i > 0) pushIfNull(c - nXl);
    if (i < nIl - 1) pushIfNull(c + nXl);
    if (x > 0) pushIfNull(c - 1);
    if (x < nXl - 1) pushIfNull(c + 1);
  }

  const holes = [];
  for (let c = 0; c < n; c++) {
    if (picks[c] === NULL_F32 && !exterior[c]) holes.push(c);
  }
  if (!holes.length) return { grid: out, filled: 0 };

  // onion-peel seed: repeatedly value hole cells that touch valued cells
  let remaining = holes;
  while (remaining.length) {
    const next = [];
    const assigned = [];
    for (const c of remaining) {
      const i = (c / nXl) | 0;
      const x = c % nXl;
      let sum = 0;
      let cnt = 0;
      for (let di = -1; di <= 1; di++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!di && !dx) continue;
          const ii = i + di;
          const xx = x + dx;
          if (ii < 0 || ii >= nIl || xx < 0 || xx >= nXl) continue;
          const v = out[ii * nXl + xx];
          if (v === NULL_F32) continue;
          sum += v;
          cnt += 1;
        }
      }
      if (cnt > 0) assigned.push(c, sum / cnt);
      else next.push(c);
    }
    if (!assigned.length) break;              // defensive; holes are bounded
    for (let k = 0; k < assigned.length; k += 2) out[assigned[k]] = assigned[k + 1];
    remaining = next;
  }

  // Gauss–Seidel relaxation over hole cells only (live picks are BCs)
  for (let it = 0; it < maxIterations; it++) {
    let maxDelta = 0;
    for (const c of holes) {
      const i = (c / nXl) | 0;
      const x = c % nXl;
      let sum = 0;
      let cnt = 0;
      if (i > 0 && out[c - nXl] !== NULL_F32) { sum += out[c - nXl]; cnt++; }
      if (i < nIl - 1 && out[c + nXl] !== NULL_F32) { sum += out[c + nXl]; cnt++; }
      if (x > 0 && out[c - 1] !== NULL_F32) { sum += out[c - 1]; cnt++; }
      if (x < nXl - 1 && out[c + 1] !== NULL_F32) { sum += out[c + 1]; cnt++; }
      if (!cnt) continue;
      const v = sum / cnt;
      const d = Math.abs(v - out[c]);
      if (d > maxDelta) maxDelta = d;
      out[c] = v;
    }
    if (maxDelta < tolerance) break;
  }
  return { grid: out, filled: holes.length };
}

/**
 * Horizon grid statistics with nulls excluded (they never enter sums).
 * @param {Float32Array} picks
 */
export function horizonStats(picks) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const v of picks) {
    if (v === NULL_F32) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n += 1;
  }
  return {
    tracked: n,
    coverage: n / picks.length,
    minSample: n ? min : null,
    maxSample: n ? max : null,
    meanSample: n ? sum / n : null,
  };
}
