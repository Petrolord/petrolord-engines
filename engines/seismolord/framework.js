// Horizon framework from well tops (Tops to Horizons plan, TP3/TP5/TP6):
// the pure pieces between "which event is each top on" (topsToEvents) and
// a set of named, non-crossing, well-tied horizons with an honest error.
//
//   seedsForTop        tracking seeds for one top from the matched wells
//   trackingOrder      which tops to track first (most reliable first)
//   approxLevelGrid / faultBarriersForTop  fault barriers cut at the
//                      horizon's own level (TP4)
//   tuningMask         cells too close to a neighbour to trust (tuned)
//   bandedTrace        a trace with everything outside the band between the
//                      horizons above and below nulled, so the existing
//                      tracker (regionGrow3D) cannot cross them
//   trackTop           one top tracked from all its seeds inside its band
//   conformableHorizon a top too thin to have its own event: the mapped
//                      neighbour plus an isochron fitted to the wells
//   mistieTable        horizon vs top at every well
//   leaveOneWellOut    track without well W, measure the error at W
//   predictTops        tops of a planned well from the horizons (prognosis)
//
// Pure math over injected I/O, worker-safe.

import { regionGrow3D } from './horizonTrack';
import { sampleGridAt } from './wellTie';
import { NULL_VALUE } from './manifest';
import { faultTraces, rasterizeTraces } from './faultBarriers';

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/**
 * Tracking seeds for one top: its matched event at every well where it
 * was matched. Wells flagged as tuned for this top (a pinch-out at that
 * well only) are left out when other wells can seed it.
 *
 * @param {Object} match matchTopsToEvents result
 * @param {string} topName
 * @param {Array<{name, tops: Array<{name, cell: {il, xl}}>}>} wells the
 *   wells as given to matchTopsToEvents
 * @returns {Array<{ilIdx, xlIdx, sample, well, score, kind}>}
 */
export function seedsForTop(match, topName, wells) {
  const top = match.tops.find((t) => t.name === topName);
  if (!top) return [];
  const flagged = new Set(match.wells
    .filter((w) => w.tuned.some((g) => g.includes(topName))).map((w) => w.name));
  const all = [];
  for (const [wName, at] of Object.entries(top.atWells)) {
    if (!at.choice) continue;
    const t = wells.find((w) => w.name === wName)?.tops.find((q) => q.name === topName);
    if (!t) continue;
    all.push({
      ilIdx: t.cell.il,
      xlIdx: t.cell.xl,
      sample: at.choice.sample,
      well: wName,
      score: at.choice.score,
      kind: at.choice.kind,
      tuned: flagged.has(wName),
    });
  }
  const clean = all.filter((s) => !s.tuned);
  return clean.length ? clean : all;
}

/**
 * Tracking order of the mapped tops: by mean seed score, best first, so
 * the most reliable horizons become the bounds the others are tracked
 * between.
 */
export function trackingOrder(match, wells) {
  return match.tops
    .filter((t) => t.role === 'mapped')
    .map((t) => {
      const seeds = seedsForTop(match, t.name, wells);
      const mean = seeds.length ? seeds.reduce((a, s) => a + s.score, 0) / seeds.length : 0;
      return { name: t.name, kind: t.kind, seeds, meanScore: mean };
    })
    .filter((t) => t.seeds.length > 0)
    .sort((a, b) => b.meanScore - a.meanScore);
}

/**
 * A trace with every sample outside (upper + margin, lower - margin)
 * nulled. `upper` / `lower` are sample values at this cell (null: open).
 */
export function bandedTrace(trace, upper, lower, margin) {
  const lo = isNull(upper) ? -Infinity : upper + margin;
  const hi = isNull(lower) ? Infinity : lower - margin;
  if (lo === -Infinity && hi === Infinity) return trace;
  const out = new Float32Array(trace.length);
  for (let k = 0; k < trace.length; k++) out[k] = k > lo && k < hi ? trace[k] : NULL_F32;
  return out;
}

/**
 * For each cell, the nearest tracked horizon above and below a top in
 * stratigraphic order. `tracked` maps name -> picks; `order` is the full
 * stratigraphic order of names (shallow first).
 */
export function boundsFor(name, order, tracked, cell) {
  const i = order.indexOf(name);
  let upper = NULL_F32;
  let lower = NULL_F32;
  for (let k = i - 1; k >= 0; k--) {
    const g = tracked.get(order[k]);
    if (g && !isNull(g[cell])) { upper = g[cell]; break; }
  }
  for (let k = i + 1; k < order.length; k++) {
    const g = tracked.get(order[k]);
    if (g && !isNull(g[cell])) { lower = g[cell]; break; }
  }
  return { upper, lower };
}

/**
 * Track one top from all its seeds, inside the band left by the horizons
 * already tracked above and below it (they cannot be crossed).
 *
 * @param {Object} p
 * @param {(il, xl) => Promise<Float32Array>} p.getTrace
 * @param {{nIl, nXl, ns}} p.geom
 * @param {Array} p.seeds seedsForTop
 * @param {string} p.kind event kind (snap mode)
 * @param {string} p.name @param {string[]} p.order stratigraphic order
 * @param {Map<string, Float32Array>} p.tracked horizons already tracked
 * @param {?Uint8Array} [p.barriers] fault barriers (regionGrow3D)
 * @param {Object} [p.opts] regionGrow3D options (window, maxJump, ...)
 * @param {number} [p.marginSamples] minimum separation from the bounds
 * @returns {Promise<{picks, tracked, confidence}>}
 */
export async function trackTop({
  getTrace, geom, seeds, kind, name, order, tracked, barriers = null, opts = {}, marginSamples = 1,
}) {
  const banded = async (il, xl) => {
    const tr = await getTrace(il, xl);
    const { upper, lower } = boundsFor(name, order, tracked, il * geom.nXl + xl);
    return bandedTrace(tr, upper, lower, marginSamples);
  };
  const [first, ...rest] = seeds;
  return regionGrow3D(banded, geom, first, {
    mode: kind,
    window: 3,
    maxJump: 2,
    ...opts,
    seeds: rest,
    barriers,
  });
}

/**
 * Isochron (ms) at every cell from values at a few wells: a least-squares
 * plane (3+ wells; the mean for fewer) plus inverse-distance-squared
 * residuals, clamped to the range the wells measured (thin beds do not
 * extrapolate into negative or runaway thickness).
 *
 * @param {Array<{il: number, xl: number, value: number}>} pts
 * @param {number} nIl @param {number} nXl
 * @param {{clamp?: boolean}} [opts] clamp to the wells' range (isochrons);
 *   off for a dipping level (approxLevelGrid)
 * @returns {Float32Array}
 */
export function isochronFromWells(pts, nIl, nXl, { clamp = true } = {}) {
  const out = new Float32Array(nIl * nXl);
  if (!pts.length) return out.fill(NULL_F32);
  const vmin = Math.min(...pts.map((p) => p.value));
  const vmax = Math.max(...pts.map((p) => p.value));
  let plane = null;
  if (pts.length >= 3) plane = fitPlane(pts);
  const base = (il, xl) => (plane ? plane.a + plane.b * il + plane.c * xl
    : pts.reduce((s, p) => s + p.value, 0) / pts.length);
  const resid = pts.map((p) => ({ ...p, r: p.value - base(p.il, p.xl) }));
  for (let il = 0; il < nIl; il++) {
    for (let xl = 0; xl < nXl; xl++) {
      let wsum = 0;
      let rsum = 0;
      let exact = null;
      for (const p of resid) {
        const d2 = (il - p.il) ** 2 + (xl - p.xl) ** 2;
        if (d2 < 1e-9) { exact = p.r; break; }
        const w = 1 / d2;
        wsum += w;
        rsum += w * p.r;
      }
      const r = exact != null ? exact : rsum / wsum;
      const v = base(il, xl) + r;
      out[il * nXl + xl] = clamp ? Math.min(vmax, Math.max(vmin, v)) : v;
    }
  }
  return out;
}

function fitPlane(pts) {
  // normal equations for v = a + b il + c xl
  let n = 0; let si = 0; let sx = 0; let sii = 0; let sxx = 0; let six = 0;
  let sv = 0; let svi = 0; let svx = 0;
  for (const p of pts) {
    n += 1; si += p.il; sx += p.xl; sii += p.il * p.il; sxx += p.xl * p.xl; six += p.il * p.xl;
    sv += p.value; svi += p.value * p.il; svx += p.value * p.xl;
  }
  const M = [[n, si, sx], [si, sii, six], [sx, six, sxx]];
  const y = [sv, svi, svx];
  const sol = solve3(M, y);
  return sol ? { a: sol[0], b: sol[1], c: sol[2] } : null;
}

function solve3(M, y) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(M);
  if (Math.abs(d) < 1e-9) return null;
  const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? y[i] : v)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/**
 * An approximate level for a top before it is tracked: a plane (3+ wells)
 * plus inverse-distance residuals through its seeds' samples, unclamped.
 * Used where a fault crosses the horizon, to cut fault barriers at the
 * horizon's own level instead of one time slice.
 */
export function approxLevelGrid(seeds, geom) {
  return isochronFromWells(seeds.map((q) => ({ il: q.ilIdx, xl: q.xlIdx, value: q.sample })),
    geom.nIl, geom.nXl, { clamp: false });
}

/**
 * Fault barriers for one top: every fault's trace where its sticks cross
 * the top's level (faultTraces, per stick at the local level), rasterized
 * as a 4-connected line the tracker cannot enter.
 *
 * @param {Array<{sticks: Array}>} faults lattice sticks {points: [{il, xl, s}]}
 * @param {Float32Array} levelGrid samples (tracked picks or approxLevelGrid)
 * @param {{nIl, nXl}} geom
 * @returns {Uint8Array}
 */
export function faultBarriersForTop(faults, levelGrid, geom) {
  return rasterizeTraces(faultTraces(faults, levelGrid, geom), geom.nIl, geom.nXl);
}

/**
 * Cells where a tracked horizon sits closer than the tuning thickness to
 * its tracked neighbour above or below: there its event is the tuned
 * composite of both interfaces, so the pick is flagged, not trusted.
 *
 * @returns {Uint8Array} 1 = tuned
 */
export function tuningMask(name, order, tracked, geom, tuningSamples) {
  const g = tracked.get(name);
  const mask = new Uint8Array(geom.nIl * geom.nXl);
  if (!g) return mask;
  for (let c = 0; c < mask.length; c++) {
    if (isNull(g[c])) continue;
    const { upper, lower } = boundsFor(name, order, tracked, c);
    if ((!isNull(upper) && g[c] - upper < tuningSamples)
      || (!isNull(lower) && lower - g[c] < tuningSamples)) mask[c] = 1;
  }
  return mask;
}

/**
 * A conformable horizon: the representative's picks plus an isochron
 * gridded from the offsets measured at the wells (the bulk shift made
 * consistent across the field).
 *
 * @param {Float32Array} repPicks representative horizon (samples)
 * @param {Array<{il: number, xl: number, offsetMs: number}>} wellOffsets
 * @param {{nIl, nXl, ns}} geom @param {number} dtMs
 * @returns {{picks: Float32Array, isochronMs: Float32Array}}
 */
export function conformableHorizon(repPicks, wellOffsets, geom, dtMs) {
  const iso = isochronFromWells(wellOffsets.map((w) => ({ il: w.il, xl: w.xl, value: w.offsetMs })),
    geom.nIl, geom.nXl);
  const picks = new Float32Array(repPicks.length);
  for (let c = 0; c < picks.length; c++) {
    const r = repPicks[c];
    const o = iso[c];
    picks[c] = isNull(r) || isNull(o) ? NULL_F32 : r + o / dtMs;
  }
  return { picks, isochronMs: iso };
}

/**
 * Horizon vs top at every well, in ms (+ = the horizon is deeper than the
 * top's predicted time).
 *
 * @param {Map<string, Float32Array>} horizons name -> picks
 * @param {Array<{name, tops: Array<{name, il, xl, predSample}>}>} wells
 * @param {{nIl, nXl}} geom @param {number} dtMs
 * @returns {Array<{well, top, horizonMs, topMs, mistieMs}>}
 */
export function mistieTable(horizons, wells, geom, dtMs) {
  const rows = [];
  for (const w of wells) {
    for (const t of w.tops) {
      const g = horizons.get(t.name);
      if (!g) continue;
      const h = sampleGridAt(g, geom.nIl, geom.nXl, t.il, t.xl);
      rows.push({
        well: w.name,
        top: t.name,
        horizonMs: h == null ? null : h * dtMs,
        topMs: t.predSample * dtMs,
        mistieMs: h == null ? null : (h - t.predSample) * dtMs,
      });
    }
  }
  return rows;
}

/** RMS / mean / max of the live misties. */
export function mistieStats(rows) {
  const v = rows.map((r) => r.mistieMs).filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0, meanMs: null, rmsMs: null, maxAbsMs: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const rms = Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
  return {
    n: v.length, meanMs: mean, rmsMs: rms, maxAbsMs: Math.max(...v.map(Math.abs)),
  };
}

/**
 * Leave-one-well-out: for every well that seeds a top, track the top
 * without that well's seed and measure the horizon against the well's
 * own matched event there. The honest accuracy of the framework.
 *
 * @param {Object} p
 * @param {Array} p.seeds seedsForTop (all wells)
 * @param {(seeds: Array) => Promise<Float32Array>} p.track tracks from
 *   the given seeds, returns picks
 * @param {{nXl: number}} p.geom @param {number} p.dtMs
 * @returns {Promise<{rows: Array<{well, errorMs, reached}>, rmsMs, reached, n}>}
 */
export async function leaveOneWellOut({ seeds, track, geom, dtMs }) {
  const rows = [];
  if (seeds.length < 2) return { rows, rmsMs: null, reached: 0, n: 0 };
  for (const s of seeds) {
    const others = seeds.filter((q) => q !== s);
    const picks = await track(others);
    const v = picks[s.ilIdx * geom.nXl + s.xlIdx];
    rows.push({
      well: s.well,
      reached: !isNull(v),
      errorMs: isNull(v) ? null : (v - s.sample) * dtMs,
    });
  }
  const errs = rows.filter((r) => r.reached).map((r) => r.errorMs);
  return {
    rows,
    n: rows.length,
    reached: errs.length,
    rmsMs: errs.length ? Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / errs.length) : null,
  };
}

/**
 * Prognosis: where a planned well meets each horizon. Walks the planned
 * path (buildWellLatticePath points: md, il, xl, s, tvdss) and finds where
 * its time crosses the horizon's time at the cell it is in.
 *
 * @param {Array<{md, il, xl, s, tvdss}>} points planned path on the lattice
 * @param {Map<string, Float32Array>} horizons name -> picks
 * @param {{nIl, nXl}} geom
 * @param {{sigmaMs?: number, dtMs: number, velocityMps?: number}} opts
 *   sigmaMs: the framework's time error (e.g. leave-one-well-out RMS);
 *   velocityMps converts it to a depth band (default 2500)
 * @returns {Array<{name, md, tvdss, il, xl, bandM}>} in path order; a
 *   horizon the path never crosses is left out
 */
export function predictTops(points, horizons, geom, { sigmaMs = null, dtMs, velocityMps = 2500 } = {}) {
  const out = [];
  for (const [name, g] of horizons) {
    let prev = null;
    for (const p of points) {
      if (p.s == null) { prev = null; continue; }
      const h = sampleGridAt(g, geom.nIl, geom.nXl, p.il, p.xl);
      if (h == null) { prev = null; continue; }
      const d = p.s - h;
      if (prev && prev.d < 0 && d >= 0) {
        const f = prev.d / (prev.d - d);
        const lerp = (a, b) => a + f * (b - a);
        out.push({
          name,
          md: lerp(prev.p.md, p.md),
          tvdss: lerp(prev.p.tvdss, p.tvdss),
          il: lerp(prev.p.il, p.il),
          xl: lerp(prev.p.xl, p.xl),
          bandM: sigmaMs == null ? null : (sigmaMs / 1000) * velocityMps / 2,
        });
        break;
      }
      prev = { p, d };
    }
  }
  return out.sort((a, b) => a.md - b.md);
}
