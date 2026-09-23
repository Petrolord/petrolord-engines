// Tops to events (Tops to Horizons plan, TP1): which seismic event does
// each well top sit on?
//
// For every top at every well: the top's predicted two-way time (its own
// lattice cell along a deviated path, through the well's time-depth
// relation) with an uncertainty that depends on where that relation came
// from; every candidate event (peak, trough, zero crossing) within a few
// sigma of it; and a score per candidate made of four explained parts:
//   time      closeness to the prediction (Gaussian on the uncertainty)
//   polarity  agreement with the event kind the logs predict (the
//             impedance contrast across the top, under the field's
//             polarity convention); neutral when there are no logs
//   amplitude strength against the trace's RMS
//   coherence normalized cross-correlation with the neighbouring traces
//             (a real reflector continues; noise does not)
// Then, per well, a dynamic programme chooses one event per top so the
// chosen events keep the tops' stratigraphic order and never share an
// event; a field-wide vote fixes one event kind per top and the wells are
// re-assigned under it. Tops closer together than the tuning thickness are
// grouped: the strongest contrast is mapped and the others ride on it at
// their well-measured offsets (the interpreter's bulk shift, made explicit).
//
// Everything is explained: each decision carries its parts, so a review
// board can show why. Pure math, worker-safe, no I/O.

import { snapPick } from './horizonTrack';
import { buildWellLatticePath } from './wellSection';
import { fft, nextPow2 } from '../../lib/fft';

export const EVENT_KINDS = Object.freeze(['peak', 'trough', 'zero_pos', 'zero_neg']);

/** Default time uncertainty (1 sigma, ms) by time-depth source. */
export const TIME_SIGMA_MS = Object.freeze({
  tie: 4,           // checkshots derived from a well tie (synthetic matched)
  checkshots: 8,    // imported checkshots or VSP
  model: 24,        // the volume's velocity model
});

/** Score given to a top left unmatched at a well (a low floor, so the
 *  programme prefers a reasonable event but never forces a bad one). */
export const UNMATCHED_SCORE = 0.02;

/** Default weights of the four score parts (exponents of a weighted
 *  geometric mean, so one very bad part sinks the candidate). */
export const DEFAULT_WEIGHTS = Object.freeze({
  time: 1, polarity: 1, amplitude: 0.5, coherence: 0.75,
});

const isNull = (v) => !Number.isFinite(v) || Math.abs(v) > 1.0e29;

/** Tuning thickness in two-way time (ms) for a Ricker of peak frequency
 *  fHz: Kallweit and Wood, 1 / (2.31 fp). */
export function tuningTimeMs(fHz) {
  return 1000 / (2.31 * fHz);
}

/**
 * Peak frequency (Hz) of a trace's amplitude spectrum (Hann-windowed),
 * over the samples [s0, s1). Nulls are zero-filled.
 */
export function peakFrequencyHz(trace, dtMs, { s0 = 0, s1 = trace.length } = {}) {
  const n = Math.max(0, s1 - s0);
  if (n < 8) return null;
  const nfft = nextPow2(Math.max(64, 2 * n));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) {
    const v = trace[s0 + i];
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = isNull(v) ? 0 : v * w;
  }
  fft(re, im, false);
  const df = 1000 / (nfft * dtMs);
  let best = 1;
  let bestA = -1;
  for (let k = 1; k < nfft / 2; k++) {
    const a = Math.hypot(re[k], im[k]);
    if (a > bestA) { bestA = a; best = k; }
  }
  // parabolic refinement on the spectral peak
  if (best > 1 && best < nfft / 2 - 1) {
    const am = Math.hypot(re[best - 1], im[best - 1]);
    const ap = Math.hypot(re[best + 1], im[best + 1]);
    const d = am - 2 * bestA + ap;
    if (d !== 0) {
      const off = (0.5 * (am - ap)) / d;
      if (Math.abs(off) <= 1) return (best + off) * df;
    }
  }
  return best * df;
}

/** RMS of the live samples in [s0, s1). */
export function traceRms(trace, s0 = 0, s1 = trace.length) {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, s0); i < Math.min(trace.length, s1); i++) {
    const v = trace[i];
    if (isNull(v)) continue;
    s += v * v;
    n += 1;
  }
  return n ? Math.sqrt(s / n) : 0;
}

/**
 * Every event on a trace within [lo, hi] samples: strict local extrema
 * (parabolic sub-sample refinement through snapPick) and zero crossings
 * (linear), each {kind, sample, amp}.
 */
export function findEvents(trace, lo, hi) {
  const out = [];
  const a = Math.max(1, Math.floor(lo));
  const b = Math.min(trace.length - 2, Math.ceil(hi));
  for (let i = a; i <= b; i++) {
    const vm = trace[i - 1];
    const v0 = trace[i];
    const vp = trace[i + 1];
    if (isNull(vm) || isNull(v0) || isNull(vp)) continue;
    if (v0 > 0 && v0 >= vm && v0 > vp) {
      const hit = snapPick(trace, i, { mode: 'peak', window: 0 });
      if (hit) out.push({ kind: 'peak', sample: hit.sample, amp: hit.amp });
    } else if (v0 < 0 && v0 <= vm && v0 < vp) {
      const hit = snapPick(trace, i, { mode: 'trough', window: 0 });
      if (hit) out.push({ kind: 'trough', sample: hit.sample, amp: hit.amp });
    }
    if (v0 < 0 && vp >= 0) {
      out.push({ kind: 'zero_pos', sample: i + v0 / (v0 - vp), amp: Math.max(Math.abs(v0), Math.abs(vp)) });
    } else if (v0 > 0 && vp <= 0) {
      out.push({ kind: 'zero_neg', sample: i + v0 / (v0 - vp), amp: Math.max(Math.abs(v0), Math.abs(vp)) });
    }
  }
  return out.filter((e) => e.sample >= lo && e.sample <= hi).sort((p, q) => p.sample - q.sample);
}

/**
 * The event kind the logs predict at a top: the sign of the impedance
 * contrast between averages over `windowM` above and below the top, under
 * the polarity convention ('normal': an impedance increase is a peak;
 * 'reverse': a trough) and the wavelet phase (0: extrema; 90: zero
 * crossings, '-' to '+' for an increase under normal polarity).
 *
 * @param {{md: ArrayLike<number>, dtUsPerM: ArrayLike<number>, rho: ArrayLike<number>}} logs
 * @param {number} topMd
 * @param {{polarity?: 'normal'|'reverse', phaseDeg?: 0|90|180|-90, windowM?: number}} [opts]
 * @returns {?{kind: string, rc: number}} null without logs around the top
 */
export function expectedEventAtTop(logs, topMd, { polarity = 'normal', phaseDeg = 0, windowM = 6 } = {}) {
  if (!logs || !logs.md || !logs.dtUsPerM || !logs.rho) return null;
  let upS = 0; let upN = 0; let dnS = 0; let dnN = 0;
  for (let i = 0; i < logs.md.length; i++) {
    const md = logs.md[i];
    if (md < topMd - windowM || md > topMd + windowM) continue;
    const dt = logs.dtUsPerM[i];
    const rho = logs.rho[i];
    if (!(dt > 0) || !(rho > 0)) continue;
    const imp = (1e6 / dt) * rho;
    if (md < topMd) { upS += imp; upN += 1; } else if (md > topMd) { dnS += imp; dnN += 1; }
  }
  if (!upN || !dnN) return null;
  const i1 = upS / upN;
  const i2 = dnS / dnN;
  const rc = (i2 - i1) / (i2 + i1);
  let up = rc > 0;
  if (polarity === 'reverse') up = !up;
  const ph = ((phaseDeg % 360) + 360) % 360;
  if (ph === 180) up = !up;
  let kind;
  if (ph === 90 || ph === 270) {
    const pos = ph === 90 ? up : !up;
    kind = pos ? 'zero_pos' : 'zero_neg';
  } else {
    kind = up ? 'peak' : 'trough';
  }
  return { kind, rc };
}

/** NCC of a window of `a` centred at ca and `b` centred at cb (null on
 *  nulls, edges or a flat window). */
function nccWindows(a, ca, b, cb, half) {
  const ra = Math.round(ca);
  const rb = Math.round(cb);
  if (ra - half < 0 || rb - half < 0 || ra + half >= a.length || rb + half >= b.length) return null;
  let sa = 0; let sb = 0;
  for (let k = -half; k <= half; k++) {
    const x = a[ra + k]; const y = b[rb + k];
    if (isNull(x) || isNull(y)) return null;
    sa += x; sb += y;
  }
  const n = 2 * half + 1;
  const ma = sa / n; const mb = sb / n;
  let num = 0; let da = 0; let db = 0;
  for (let k = -half; k <= half; k++) {
    const x = a[ra + k] - ma; const y = b[rb + k] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const d = Math.sqrt(da * db);
  return d < 1e-20 ? null : num / d;
}

/**
 * Lateral coherence of an event at sample s on `center`: mean over the
 * neighbours of the best NCC within ±maxLag samples (a dipping reflector
 * shifts a little from trace to trace). 0 when nothing can be measured.
 */
export function lateralCoherence(center, neighbours, s, { half = 5, maxLag = 2 } = {}) {
  if (!neighbours || !neighbours.length) return null;
  let sum = 0;
  let n = 0;
  for (const nb of neighbours) {
    let best = null;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const c = nccWindows(center, s, nb, s + lag, half);
      if (c != null && (best == null || c > best)) best = c;
    }
    if (best != null) { sum += best; n += 1; }
  }
  return n ? sum / n : null;
}

/**
 * Score one candidate event for one top.
 *
 * @param {{kind: string, sample: number, amp: number}} ev
 * @param {Object} ctx {predSample, sigmaSamples, expectedKind (or null),
 *   rms, coherence (or null)}
 * @param {Object} [weights] DEFAULT_WEIGHTS
 * @returns {{score: number, parts: {time, polarity, amplitude, coherence}}}
 */
export function scoreCandidate(ev, ctx, weights = DEFAULT_WEIGHTS) {
  const dz = (ev.sample - ctx.predSample) / Math.max(1e-6, ctx.sigmaSamples);
  const time = Math.exp(-0.5 * dz * dz);
  let polarity;
  if (!ctx.expectedKind) polarity = 0.6;                  // no logs: neutral
  else if (ev.kind === ctx.expectedKind) polarity = 1;
  else if (sameFamily(ev.kind, ctx.expectedKind)) polarity = 0.1;   // opposite extremum / crossing
  else polarity = 0.3;                                    // extremum vs crossing: phase unsure
  const amplitude = ctx.rms > 0 ? Math.min(1, Math.abs(ev.amp) / (1.5 * ctx.rms)) : 0.5;
  const coherence = ctx.coherence == null ? 0.6 : Math.max(0.01, ctx.coherence);
  const w = weights;
  const score = (time ** w.time) * (polarity ** w.polarity)
    * (Math.max(0.01, amplitude) ** w.amplitude) * (coherence ** w.coherence);
  return {
    score,
    parts: {
      time, polarity, amplitude, coherence,
    },
  };
}

function sameFamily(a, b) {
  const ext = (k) => k === 'peak' || k === 'trough';
  return ext(a) === ext(b);
}

/**
 * Candidates for one top at one well, scored and best-first.
 *
 * @param {Object} p
 * @param {Float32Array} p.trace the trace at the top's own lattice cell
 * @param {Float32Array[]} [p.neighbours] traces around it (coherence)
 * @param {number} p.predSample predicted sample of the top
 * @param {number} p.sigmaMs time uncertainty (1 sigma)
 * @param {number} p.dtMs
 * @param {?string} [p.expectedKind]
 * @param {?string} [p.onlyKind] restrict to one kind (field vote)
 * @param {number} [p.searchSigmas] half-width of the search, in sigmas
 * @param {Object} [p.weights]
 * @returns {Array<{kind, sample, amp, score, parts}>}
 */
export function topCandidates({
  trace, neighbours = null, predSample, sigmaMs, dtMs, expectedKind = null, onlyKind = null,
  searchSigmas = 3, weights = DEFAULT_WEIGHTS,
}) {
  const sigmaSamples = sigmaMs / dtMs;
  const half = Math.max(2, searchSigmas * sigmaSamples);
  const lo = predSample - half;
  const hi = predSample + half;
  const rms = traceRms(trace, Math.floor(lo - 25), Math.ceil(hi + 25));
  return findEvents(trace, lo, hi)
    .filter((e) => !onlyKind || e.kind === onlyKind)
    .map((e) => {
      const coherence = lateralCoherence(trace, neighbours, e.sample);
      const s = scoreCandidate(e, {
        predSample, sigmaSamples, expectedKind, rms, coherence,
      }, weights);
      return { ...e, ...s };
    })
    .sort((p, q) => q.score - p.score);
}

/**
 * Choose one event per top at one well: maximise the summed log score
 * with the chosen samples strictly increasing in the tops' order (at
 * least `minSepSamples` apart) and no event shared. A top may stay
 * unmatched at UNMATCHED_SCORE.
 *
 * @param {Array<{name: string, candidates: Array}>} tops in stratigraphic
 *   order (shallow first)
 * @param {{minSepSamples?: number}} [opts]
 * @returns {Array<{name, choice: ?Object}>} same order
 */
export function assignWellTops(tops, { minSepSamples = 0.75 } = {}) {
  const n = tops.length;
  const floor = Math.log(UNMATCHED_SCORE);
  // states per top: candidates + "unmatched" (index -1)
  // best[i][j] = best total for tops 0..i with top i taking option j;
  // last matched sample carried for the ordering constraint
  const opts = tops.map((t) => [null, ...t.candidates]);
  const best = [];
  const back = [];
  const lastS = [];
  for (let i = 0; i < n; i++) {
    best.push(new Array(opts[i].length).fill(-Infinity));
    back.push(new Array(opts[i].length).fill(-1));
    lastS.push(new Array(opts[i].length).fill(-Infinity));
    for (let j = 0; j < opts[i].length; j++) {
      const o = opts[i][j];
      const gain = o ? Math.log(Math.max(1e-12, o.score)) : floor;
      if (i === 0) {
        best[i][j] = gain;
        lastS[i][j] = o ? o.sample : -Infinity;
        continue;
      }
      for (let k = 0; k < opts[i - 1].length; k++) {
        if (best[i - 1][k] === -Infinity) continue;
        const prevS = lastS[i - 1][k];
        if (o && !(o.sample >= prevS + minSepSamples)) continue;
        const v = best[i - 1][k] + gain;
        if (v > best[i][j]) {
          best[i][j] = v;
          back[i][j] = k;
          lastS[i][j] = o ? o.sample : prevS;
        }
      }
    }
  }
  if (!n) return [];
  let j = 0;
  for (let k = 1; k < best[n - 1].length; k++) if (best[n - 1][k] > best[n - 1][j]) j = k;
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = { name: tops[i].name, choice: opts[i][j] || null };
    j = back[i][j];
  }
  return out;
}

/**
 * Resolution groups at one well: consecutive tops whose predicted times
 * are closer than the tuning thickness. Returns an array of groups (each
 * an array of top names, shallow first); singletons are omitted.
 */
export function tunedPairsAtWell(tops, tuningMs) {
  const groups = [];
  let cur = null;
  for (let i = 1; i < tops.length; i++) {
    const a = tops[i - 1];
    const b = tops[i];
    if (b.predMs - a.predMs < tuningMs) {
      if (!cur) { cur = [a.name]; groups.push(cur); }
      cur.push(b.name);
    } else {
      cur = null;
    }
  }
  return groups;
}

/**
 * Field-wide matching: tops to events at every well.
 *
 * @param {Object} p
 * @param {Array<{name: string, tops: Array<{name: string, predSample: number,
 *   sigmaMs: number, expected?: ?{kind: string, rc: number}}>,
 *   traces: Map<string, {trace: Float32Array, neighbours?: Float32Array[]}>}>} p.wells
 *   each well's tops in stratigraphic order (shallow first) with the trace
 *   at each top's own cell (keyed by top name)
 * @param {number} p.dtMs
 * @param {string[]} [p.order] field stratigraphic order of top names
 *   (column order); defaults to the order of first appearance
 * @param {number} [p.peakHz] dominant frequency for tuning (estimated
 *   from the traces when absent)
 * @param {Object} [p.weights]
 * @returns {{order: string[], tuningMs: number, peakHz: number,
 *   tops: Array<Object>, wells: Array<Object>}}
 */
export function matchTopsToEvents({
  wells, dtMs, order = null, peakHz = null, weights = DEFAULT_WEIGHTS,
}) {
  const names = order || firstAppearanceOrder(wells);
  const rank = new Map(names.map((n, i) => [n, i]));

  // dominant frequency from the traces around the tops
  let fHz = peakHz;
  if (!fHz) {
    const fs = [];
    for (const w of wells) {
      for (const t of w.tops) {
        const tr = w.traces.get(t.name)?.trace;
        if (!tr) continue;
        const f = peakFrequencyHz(tr, dtMs, {
          s0: Math.max(0, Math.round(t.predSample - 32)),
          s1: Math.min(tr.length, Math.round(t.predSample + 32)),
        });
        if (f) fs.push(f);
      }
    }
    fs.sort((a, b) => a - b);
    fHz = fs.length ? fs[Math.floor(fs.length / 2)] : 30;
  }
  const tuningMs = tuningTimeMs(fHz);

  // 1. resolution groups: a pair is grouped field-wide when it is tuned at
  //    the majority of the wells where both are present
  const pairVotes = new Map();   // "a|b" -> {tuned, total, offsets: Map well -> ms}
  for (const w of wells) {
    const tops = [...w.tops].sort((a, b) => rank.get(a.name) - rank.get(b.name))
      .map((t) => ({ ...t, predMs: t.predSample * dtMs }));
    for (let i = 1; i < tops.length; i++) {
      const key = `${tops[i - 1].name}|${tops[i].name}`;
      const v = pairVotes.get(key) || { tuned: 0, total: 0, offsets: new Map() };
      v.total += 1;
      const dt = tops[i].predMs - tops[i - 1].predMs;
      if (dt < tuningMs) v.tuned += 1;
      v.offsets.set(w.name, dt);
      pairVotes.set(key, v);
    }
  }
  const groupOf = new Map();       // name -> group id
  const groups = [];
  for (const n of names) {
    const i = rank.get(n);
    if (i === 0) continue;
    const key = `${names[i - 1]}|${n}`;
    const v = pairVotes.get(key);
    if (!v || v.tuned * 2 <= v.total) continue;
    let g = groupOf.get(names[i - 1]);
    if (g == null) {
      g = groups.length;
      groups.push({ id: g, members: [names[i - 1]] });
      groupOf.set(names[i - 1], g);
    }
    groups[g].members.push(n);
    groupOf.set(n, g);
  }
  // representative: the strongest mean |rc| from the logs, else the shallowest
  for (const g of groups) {
    let bestName = g.members[0];
    let bestRc = -1;
    for (const m of g.members) {
      const rcs = wells.map((w) => w.tops.find((t) => t.name === m)?.expected?.rc)
        .filter((r) => Number.isFinite(r)).map(Math.abs);
      const mean = rcs.length ? rcs.reduce((a, b) => a + b, 0) / rcs.length : -1;
      if (mean > bestRc) { bestRc = mean; bestName = m; }
    }
    g.representative = bestName;
  }
  const roleOf = (n) => {
    const g = groupOf.get(n);
    if (g == null) return 'mapped';
    return groups[g].representative === n ? 'mapped' : 'conformable';
  };

  // 2. first pass: per-well assignment of the mapped tops, all kinds
  const perWell = (onlyKinds) => wells.map((w) => {
    const tops = [...w.tops]
      .filter((t) => roleOf(t.name) === 'mapped')
      .sort((a, b) => rank.get(a.name) - rank.get(b.name))
      .map((t) => {
        const tr = w.traces.get(t.name);
        const candidates = tr ? topCandidates({
          trace: tr.trace,
          neighbours: tr.neighbours,
          predSample: t.predSample,
          sigmaMs: t.sigmaMs,
          dtMs,
          expectedKind: t.expected?.kind || null,
          onlyKind: onlyKinds?.get(t.name) || null,
          weights,
        }) : [];
        return { name: t.name, candidates, top: t };
      });
    const chosen = assignWellTops(tops);
    return {
      name: w.name,
      picks: chosen.map((c, i) => ({
        name: c.name,
        choice: c.choice,
        predSample: tops[i].top.predSample,
        alternatives: tops[i].candidates.slice(0, 4),
      })),
    };
  });
  const first = perWell(null);

  // 3. field vote: one kind per top, weighted by score
  const votes = new Map();
  for (const w of first) {
    for (const p of w.picks) {
      if (!p.choice) continue;
      const m = votes.get(p.name) || new Map();
      m.set(p.choice.kind, (m.get(p.choice.kind) || 0) + p.choice.score);
      votes.set(p.name, m);
    }
  }
  const kindOf = new Map();
  for (const [name, m] of votes) {
    let bk = null; let bv = -1;
    for (const [k, v] of m) if (v > bv) { bv = v; bk = k; }
    kindOf.set(name, bk);
  }
  const second = perWell(kindOf);

  // 4. summary per top
  const tops = names.map((name) => {
    const role = roleOf(name);
    const g = groupOf.get(name);
    const atWells = {};
    for (const w of second) {
      const p = w.picks.find((q) => q.name === name);
      if (p) {
        atWells[w.name] = {
          choice: p.choice,
          predSample: p.predSample,
          deltaMs: p.choice ? (p.choice.sample - p.predSample) * dtMs : null,
          alternatives: p.alternatives,
        };
      }
    }
    const entry = {
      name, role, kind: kindOf.get(name) || null, atWells,
    };
    if (g != null) {
      const grp = groups[g];
      entry.group = grp.members;
      entry.representative = grp.representative;
      if (role === 'conformable') {
        // offsets from the representative at each well (ms, + = deeper)
        const offsets = {};
        for (const w of wells) {
          const a = w.tops.find((t) => t.name === grp.representative);
          const b = w.tops.find((t) => t.name === name);
          if (a && b) offsets[w.name] = (b.predSample - a.predSample) * dtMs;
        }
        entry.offsetsMs = offsets;
      }
    }
    return entry;
  });

  // per-well tuned pairs that are not grouped field-wide (confidence flags)
  const wellFlags = wells.map((w) => {
    const ts = [...w.tops].sort((a, b) => rank.get(a.name) - rank.get(b.name))
      .map((t) => ({ name: t.name, predMs: t.predSample * dtMs }));
    const tuned = tunedPairsAtWell(ts, tuningMs)
      .filter((grp) => !grp.every((n) => groupOf.has(n) && groupOf.get(n) === groupOf.get(grp[0])));
    return { name: w.name, tuned };
  });

  return {
    order: names, peakHz: fHz, tuningMs, tops, groups, wells: wellFlags,
  };
}

function firstAppearanceOrder(wells) {
  const seen = [];
  const set = new Set();
  // order by mean predicted time across wells (a robust default when no
  // stratigraphic column is supplied)
  const sums = new Map();
  for (const w of wells) {
    for (const t of w.tops) {
      const s = sums.get(t.name) || { sum: 0, n: 0 };
      s.sum += t.predSample; s.n += 1;
      sums.set(t.name, s);
      if (!set.has(t.name)) { set.add(t.name); seen.push(t.name); }
    }
  }
  return seen.sort((a, b) => sums.get(a).sum / sums.get(a).n - sums.get(b).sum / sums.get(b).n);
}

/**
 * A well's tops ready for matching: each top's own lattice cell and
 * predicted sample along the (deviated) path, through the well's
 * time-depth relation (buildWellLatticePath, the same placement the
 * viewers draw), its time uncertainty by source, and the event kind its
 * logs predict.
 *
 * @param {Object} well {name, deviation?, tdMdM?, surfaceX, surfaceY, kbM,
 *   tops: [{name, md}], logs?: {md, dtUsPerM, rho}}
 * @param {Object} p {affine, geom, dtUs, timeConv (makeTvdssToTwt),
 *   source?: 'tie'|'checkshots'|'model', sigmaMs?, polarity?, phaseDeg?}
 * @returns {Array<{name, md, il, xl, cell: {il, xl}, predSample, sigmaMs,
 *   source, expected}>} tops outside the survey or window are left out
 */
export function wellTopsForMatching(well, {
  affine, geom, dtUs, timeConv, source = null, sigmaMs = null, polarity = 'normal', phaseDeg = 0,
}) {
  const lat = buildWellLatticePath(well, {
    affine, timeConv, geom, dtUs,
  });
  if (!lat) return [];
  const src = source || timeConv?.source || 'model';
  const sigma = sigmaMs ?? TIME_SIGMA_MS[src] ?? TIME_SIGMA_MS.model;
  return lat.tops.map((t) => ({
    name: t.name,
    md: t.md,
    il: t.il,
    xl: t.xl,
    cell: {
      il: Math.min(geom.nIl - 1, Math.max(0, Math.round(t.il))),
      xl: Math.min(geom.nXl - 1, Math.max(0, Math.round(t.xl))),
    },
    predSample: t.s,
    sigmaMs: sigma,
    source: src,
    expected: expectedEventAtTop(well.logs, t.md, { polarity, phaseDeg }),
  }));
}

/**
 * Traces for matching: at each top's own cell plus its 4 neighbours
 * (radius 1) for lateral coherence. Returns Map topName -> {trace,
 * neighbours}.
 */
export async function gatherTopTraces(getTrace, geom, tops, { radius = 1 } = {}) {
  const out = new Map();
  const cache = new Map();
  const get = async (il, xl) => {
    const k = il * geom.nXl + xl;
    if (!cache.has(k)) cache.set(k, await getTrace(il, xl));
    return cache.get(k);
  };
  for (const t of tops) {
    const { il, xl } = t.cell;
    const trace = await get(il, xl);
    const neighbours = [];
    for (const [di, dx] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
      const ni = il + di;
      const nx = xl + dx;
      if (ni < 0 || nx < 0 || ni >= geom.nIl || nx >= geom.nXl) continue;
      neighbours.push(await get(ni, nx));
    }
    out.set(t.name, { trace, neighbours });
  }
  return out;
}
