// Carrying a horizon across a fault into a block no well reaches (Tops to
// Horizons plan, TP4).
//
// An amplitude tracker stops at a fault barrier (or, without one, leaks
// onto whichever event of the right kind sits within its jump limit on the
// far side, which after a throw of one wavelet period is the wrong one).
// Where the far block has a well, that well seeds it. Where it has none,
// the throw has to be inferred, the way an interpreter does it: by the
// CHARACTER of the whole sequence across the fault, not one event.
//
//   1. pair cells across the fault barrier (picked side P, empty side T);
//   2. for every candidate throw (lag), the mean normalized correlation of
//      a long vertical window (several reflectors) around the horizon on P
//      with the window shifted by the lag on T;
//   3. only lags with the fault's sense: the hanging wall is on the side
//      the fault dips toward, and moves down for a normal fault;
//   4. a prior from the same fault's throw on other horizons (already
//      carried or seeded on both sides), when there is one: throw varies
//      smoothly with depth, so a candidate far from it is penalised;
//   5. the best lag seeds T (snapped to the horizon's event kind) and the
//      tracker grows T from those seeds; every jumped pick is flagged.
//
// Pure math over injected I/O, worker-safe.

import { regionGrow3D, snapPick } from './horizonTrack';
import { labelBlocks } from './faultBarriers';
import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/** Map direction (dil, dxl) the fault moves toward with depth: the dip
 *  direction, averaged over the sticks (unit vector), or null. */
export function faultDipDirection(fault) {
  let di = 0;
  let dx = 0;
  for (const st of fault.sticks || []) {
    const p = st.points || st;
    if (p.length < 2) continue;
    const a = p[0];
    const b = p[p.length - 1];
    if (!(b.s > a.s)) continue;
    di += (b.il - a.il);
    dx += (b.xl - a.xl);
  }
  const n = Math.hypot(di, dx);
  return n > 1e-9 ? { il: di / n, xl: dx / n } : null;
}

/**
 * Cell pairs across a fault's barrier: for barrier cells every `step`
 * along it, a picked cell on one side and a cell of `targetLabel` on the
 * other, both `minDist`..`maxDist` cells away along the fault's normal
 * (the dip direction). Far enough that a long vertical window lies inside
 * one fault block on each side: a dipping fault moves laterally with
 * depth, so a window beside the barrier would straddle it.
 */
export function pairsAcrossBarrier({
  picks, barriers, labels, targetLabel, geom, dipDir, minDist = 5, maxDist = 9, step = 2,
}) {
  const { nIl, nXl } = geom;
  const pairs = [];
  let seen = 0;
  const cellAt = (il, xl) => {
    const i = Math.round(il);
    const x = Math.round(xl);
    if (i < 0 || x < 0 || i >= nIl || x >= nXl) return null;
    const k = i * nXl + x;
    return barriers[k] ? null : { k, il: i, xl: x };
  };
  for (let c = 0; c < barriers.length; c++) {
    if (!barriers[c]) continue;
    seen += 1;
    if (seen % step) continue;
    const il = Math.floor(c / nXl);
    const xl = c % nXl;
    let p = null;
    let t = null;
    for (let d = minDist; d <= maxDist && !(p && t); d++) {
      for (const sgn of [1, -1]) {
        const q = cellAt(il + sgn * d * dipDir.il, xl + sgn * d * dipDir.xl);
        if (!q) continue;
        if (!t && labels[q.k] === targetLabel && isNull(picks[q.k])) t = q;
        else if (!p && labels[q.k] !== targetLabel && labels[q.k] >= 0 && !isNull(picks[q.k])) p = q;
      }
    }
    if (p && t) pairs.push({ p, t, barrier: { il, xl } });
  }
  return pairs;
}

/** NCC of trace a around ca and trace b around cb (±half samples). */
function ncc(a, ca, b, cb, half) {
  const ra = Math.round(ca);
  const rb = Math.round(cb);
  if (ra - half < 0 || rb - half < 0 || ra + half >= a.length || rb + half >= b.length) return null;
  let sa = 0; let sb = 0; let n = 0;
  for (let k = -half; k <= half; k++) {
    const x = a[ra + k]; const y = b[rb + k];
    if (isNull(x) || isNull(y)) return null;
    sa += x; sb += y; n += 1;
  }
  const ma = sa / n; const mb = sb / n;
  let num = 0; let da = 0; let db = 0;
  for (let k = -half; k <= half; k++) {
    const x = a[ra + k] - ma; const y = b[rb + k] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const d = Math.sqrt(da * db);
  return d < 1e-20 ? null : num / d;
}

/** NCC with the second window at a fractional centre (linear interpolation). */
function nccFrac(a, ca, b, cb, half) {
  const ra = Math.round(ca);
  const base = Math.floor(cb);
  const fr = cb - base;
  if (ra - half < 0 || ra + half >= a.length || base - half < 0 || base + half + 1 >= b.length) return null;
  let sa = 0; let sb = 0; let n = 0;
  const xs = []; const ys = [];
  for (let k = -half; k <= half; k++) {
    const x = a[ra + k];
    const y0 = b[base + k];
    const y1 = b[base + k + 1];
    if (isNull(x) || isNull(y0) || isNull(y1)) return null;
    const y = y0 + fr * (y1 - y0);
    xs.push(x); ys.push(y); sa += x; sb += y; n += 1;
  }
  const ma = sa / n; const mb = sb / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - ma; const y = ys[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const d = Math.sqrt(da * db);
  return d < 1e-20 ? null : num / d;
}

/**
 * Throw (samples, hanging wall minus footwall) measured where a horizon
 * is picked on both sides of a fault's barrier: the median over pairs.
 * Used as the prior for the same fault on other horizons.
 */
export function measuredThrow({ picks, barriers, geom, dipDir, reach = 3, step = 2 }) {
  const { nIl, nXl } = geom;
  const vals = [];
  let seen = 0;
  for (let c = 0; c < barriers.length; c++) {
    if (!barriers[c]) continue;
    seen += 1;
    if (seen % step) continue;
    const il = Math.floor(c / nXl);
    const xl = c % nXl;
    let hw = null; let fw = null;
    for (let di = -reach; di <= reach; di++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const i = il + di; const x = xl + dx;
        if (i < 0 || x < 0 || i >= nIl || x >= nXl) continue;
        const k = i * nXl + x;
        if (barriers[k] || isNull(picks[k])) continue;
        const side = di * dipDir.il + dx * dipDir.xl;
        const d = di * di + dx * dx;
        if (side > 0.5 && (!hw || d < hw.d)) hw = { v: picks[k], d };
        if (side < -0.5 && (!fw || d < fw.d)) fw = { v: picks[k], d };
      }
    }
    if (hw && fw) vals.push(hw.v - fw.v);
  }
  if (vals.length < 3) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

/**
 * Choose the throw across a fault into an empty block.
 *
 * @param {Object} p
 * @param {Array} p.pairs pairsAcrossBarrier
 * @param {(il, xl) => Promise<Float32Array>} p.getTrace
 * @param {Float32Array} p.picks
 * @param {{il: number, xl: number}} p.dipDir faultDipDirection
 * @param {'normal'|'reverse'} [p.sense]
 * @param {?number} [p.priorThrow] samples (hanging minus footwall) from other horizons
 * @param {number} [p.windowHalf] correlation half-window, samples
 * @param {number} [p.maxThrow] samples
 * @returns {Promise<?{lag: number, ncc: number, margin: number, targetIsHanging: boolean,
 *   curve: Array<{lag, ncc}>}>}
 */
export async function chooseThrow({
  pairs, getTrace, picks, dipDir, sense = 'normal', priorThrow = null, windowHalf = 20, maxThrow = 40,
  priorSigma = 3,
}) {
  if (!pairs.length) return null;
  // which side is the target? the dip side is the hanging wall
  let vote = 0;
  for (const pr of pairs) vote += (pr.t.il - pr.p.il) * dipDir.il + (pr.t.xl - pr.p.xl) * dipDir.xl;
  const targetIsHanging = vote > 0;
  // hanging wall down for a normal fault: target deeper if it is the hanging wall
  const deeper = (sense === 'normal') === targetIsHanging;
  const sums = new Map();
  const cache = new Map();
  const get = async (c) => {
    const k = c.il * 1e6 + c.xl;
    if (!cache.has(k)) cache.set(k, await getTrace(c.il, c.xl));
    return cache.get(k);
  };
  for (const pr of pairs) {
    const a = await get(pr.p);
    const b = await get(pr.t);
    const h = picks[pr.p.k];
    for (let lag = 0; lag <= maxThrow; lag++) {
      const L = deeper ? lag : -lag;
      const v = ncc(a, h, b, h + L, windowHalf);
      if (v == null) continue;
      const s = sums.get(L) || { sum: 0, n: 0 };
      s.sum += v; s.n += 1;
      sums.set(L, s);
    }
  }
  const curve = [...sums].map(([lag, s]) => ({ lag, ncc: s.sum / s.n }))
    .filter((r) => r.lag !== 0).sort((x, y) => x.lag - y.lag);
  if (!curve.length) return null;
  // the hanging-wall-minus-footwall throw a lag implies
  const hwMinusFw = (lag) => (targetIsHanging ? lag : -lag);
  const scored = curve.map((r) => {
    let s = r.ncc;
    if (priorThrow != null) {
      const d = (hwMinusFw(r.lag) - priorThrow) / priorSigma;
      s -= 0.5 * Math.min(4, d * d) * 0.25;               // a gentle pull toward the prior
    }
    return { ...r, score: s };
  }).sort((x, y) => y.score - x.score);
  const best = scored[0];
  // margin over the best lag at least a quarter period away (a distinct event)
  const other = scored.find((r) => Math.abs(r.lag - best.lag) >= 3);
  // sub-sample refinement of the chosen lag on the correlation curve
  const at = (lag) => curve.find((r) => r.lag === lag)?.ncc;
  let lag = best.lag;
  const m = at(best.lag - 1);
  const pl = at(best.lag + 1);
  if (m != null && pl != null) {
    const d = m - 2 * best.ncc + pl;
    if (d < 0) {
      const off = (0.5 * (m - pl)) / d;
      if (Math.abs(off) <= 1) lag = best.lag + off;
    }
  }
  // confidence at the refined lag (a sample of misalignment costs a lot
  // of correlation on a single strong event)
  let refined = 0;
  let rn = 0;
  for (const pr of pairs) {
    const a = await get(pr.p);
    const b = await get(pr.t);
    const h = picks[pr.p.k];
    const v = nccFrac(a, h, b, h + lag, windowHalf);        // lag is signed already
    if (v != null) { refined += v; rn += 1; }
  }
  const nccRefined = rn ? refined / rn : best.ncc;
  return {
    lag,
    ncc: Math.max(best.ncc, nccRefined),
    margin: other ? best.score - other.score : best.score,
    targetIsHanging,
    throwSamples: hwMinusFw(lag),
    curve,
  };
}

/**
 * Carry a horizon into every empty fault block adjacent to its picked
 * area, one fault crossing at a time, and grow each block.
 *
 * @param {Object} p
 * @param {(il, xl) => Promise<Float32Array>} p.getTrace
 * @param {{nIl, nXl, ns}} p.geom
 * @param {Float32Array} p.picks tracked with barriers
 * @param {Uint8Array} p.barriers this horizon's fault barriers
 * @param {Array<{name, sticks}>} p.faults
 * @param {string} p.kind snap mode of the horizon
 * @param {Map<string, number>} [p.priorThrows] fault name -> samples (hanging minus footwall)
 * @param {Object} [p.opts] {minBlockCells, minNcc, windowHalf, maxThrow, trackOpts}
 * @returns {Promise<{picks: Float32Array, jumped: Uint8Array, jumps: Array}>}
 */
export async function jumpAcrossFaults({
  getTrace, geom, picks, barriers, faults, kind, priorThrows = new Map(), opts = {},
}) {
  const {
    minBlockCells = 20, minNcc = 0.3, minMargin = 0.05, windowHalf = 20, maxThrow = 40, trackOpts = {},
  } = opts;
  const { nIl, nXl } = geom;
  const { labels, count } = labelBlocksOf(barriers, nIl, nXl);
  const out = Float32Array.from(picks);
  const jumped = new Uint8Array(picks.length);
  const jumps = [];
  const dipDirs = faults.map((f) => faultDipDirection(f)).filter(Boolean);
  const dipDir = dipDirs.length ? averageDir(dipDirs) : null;
  if (!dipDir) return { picks: out, jumped, jumps };

  // blocks with no picks, largest first
  const size = new Map();
  const picked = new Map();
  for (let c = 0; c < labels.length; c++) {
    const l = labels[c];
    if (l < 0) continue;
    size.set(l, (size.get(l) || 0) + 1);
    if (!isNull(out[c])) picked.set(l, (picked.get(l) || 0) + 1);
  }
  const empty = [...size].filter(([l, n]) => n >= minBlockCells && !(picked.get(l) > 0))
    .sort((a, b) => b[1] - a[1]).map(([l]) => l);

  for (const target of empty) {
    const pairs = pairsAcrossBarrier({
      picks: out, barriers, labels, targetLabel: target, geom, dipDir,
    });
    if (pairs.length < 3) continue;
    const prior = priorThrows.size ? [...priorThrows.values()][0] : null;
    const choice = await chooseThrow({
      pairs, getTrace, picks: out, dipDir, priorThrow: prior, windowHalf, maxThrow,
    });
    if (!choice || choice.ncc < minNcc || choice.margin < minMargin) {
      const reason = !choice ? 'no overlap' : choice.ncc < minNcc ? 'weak correlation' : 'no clear throw';
      jumps.push({ block: target, skipped: true, reason, choice });
      continue;
    }
    // seeds on T: the event of the horizon's kind nearest the carried time
    const seeds = [];
    for (const pr of pairs) {
      const tr = await getTrace(pr.t.il, pr.t.xl);
      const hit = snapPick(tr, out[pr.p.k] + choice.lag, { mode: kind, window: 2 });
      if (hit) seeds.push({ ilIdx: pr.t.il, xlIdx: pr.t.xl, sample: hit.sample });
    }
    if (!seeds.length) continue;
    // grow only inside the target block: every other block is a barrier
    const blockBarrier = new Uint8Array(labels.length);
    for (let c = 0; c < labels.length; c++) if (labels[c] !== target) blockBarrier[c] = 1;
    const [first, ...rest] = seeds;
    const grown = await regionGrow3D(getTrace, geom, first, {
      mode: kind, window: 3, maxJump: 2, ...trackOpts, seeds: rest, barriers: blockBarrier,
    });
    let n = 0;
    for (let c = 0; c < labels.length; c++) {
      if (labels[c] === target && !isNull(grown.picks[c])) {
        out[c] = grown.picks[c];
        jumped[c] = 1;
        n += 1;
      }
    }
    jumps.push({
      block: target, cells: n, lag: choice.lag, throwSamples: choice.throwSamples, ncc: choice.ncc, margin: choice.margin, pairs: pairs.length,
    });
  }
  return { picks: out, jumped, jumps };
}

function averageDir(dirs) {
  let a = 0; let b = 0;
  for (const d of dirs) { a += d.il; b += d.xl; }
  const n = Math.hypot(a, b);
  return n > 1e-9 ? { il: a / n, xl: b / n } : null;
}

function labelBlocksOf(barriers, nIl, nXl) {
  return labelBlocks(barriers, nIl, nXl);   // {labels (block id, -1 on a barrier), count}
}

export { NULL_F32 };
