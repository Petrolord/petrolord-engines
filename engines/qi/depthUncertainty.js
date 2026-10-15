// Depth uncertainty for prospects (QI upgrade P2.12, 2026-10-15): a time
// structure is converted to depth under several velocity cases (a constant
// average velocity, or a linear instantaneous velocity v = v0 + k z), the
// closure engine (lib/gridding/closure.js) is run on each, and the GRV to
// spill of the cases becomes a range for prospect ranking: each case, the
// low and high, and weighted Q10, Q50 and Q90 when the cases carry weights
// (parameters carry Q labels, the PT10 rule). Also a SUGGESTED chance of
// geological success from the QI assessment, by a stated rule, for the user
// to accept, change or ignore: QI never sets it.
// Pure, float64.

import { spillAnalysis, closureAt } from '../../lib/gridding/closure.js';

const fin = Number.isFinite;
const NULL_LIM = 1e29;

/**
 * Depth (elevation, metres, negative below datum) of a positive two-way time
 * (ms) under one velocity case.
 *  - { kind: 'constant', v }: z = v t / 2 (v the average velocity, m/s);
 *  - { kind: 'linear', v0, k }: v(z) = v0 + k z, so the one-way time is
 *    t = ln(1 + k z / v0) / k and z = v0 (exp(k t) - 1) / k.
 */
export function timeToDepthM(twtMs, c) {
  if (!fin(twtMs) || Math.abs(twtMs) > NULL_LIM) return NaN;
  const t = twtMs / 2000; // one-way seconds
  if (c.kind === 'linear') {
    if (!(c.v0 > 0) || !fin(c.k)) throw new Error('A linear velocity needs v0 above zero and a gradient k.');
    return c.k === 0 ? -c.v0 * t : -(c.v0 * (Math.exp(c.k * t) - 1)) / c.k;
  }
  if (!(c.v > 0)) throw new Error('A constant velocity must be above zero.');
  return -c.v * t;
}

/** A time grid (positive ms, nulls 1e30) as an elevation grid under one case. */
export function depthGrid(twt, c) {
  return Float64Array.from(twt, (v) => {
    const z = timeToDepthM(v, c);
    return fin(z) ? z : 1e30;
  });
}

/** Weighted quantile (linear between the cumulative midpoints). */
export function weightedQuantile(values, weights, q) {
  const pts = values.map((v, i) => [v, weights[i]]).filter(([v, w]) => fin(v) && w > 0).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return NaN;
  const W = pts.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  const mids = pts.map(([v, w]) => { const m = (acc + w / 2) / W; acc += w; return [m, v]; });
  if (q <= mids[0][0]) return mids[0][1];
  if (q >= mids[mids.length - 1][0]) return mids[mids.length - 1][1];
  for (let i = 1; i < mids.length; i++) {
    if (q <= mids[i][0]) {
      const [m0, v0] = mids[i - 1]; const [m1, v1] = mids[i];
      return v0 + ((q - m0) / (m1 - m0)) * (v1 - v0);
    }
  }
  return mids[mids.length - 1][1];
}

/**
 * The GRV range of a prospect over the velocity cases.
 * @param {Object} p
 * @param {ArrayLike<number>} p.twt the time structure (positive ms), on spec
 * @param {{nx, ny, dx, dy, x0?, y0?}} p.spec
 * @param {Array<{name, velocity: Object, weight?: number}>} p.cases
 * @param {?number} [p.seed] the crest node (index), or the highest node of each case
 * @returns {{rows: Array<{name, weight, crestZ, spillZ, columnM, areaM2, grvM3, limitedByEdge}>, low, high, q10, q50, q90}}
 */
export function depthCaseGrvs({ twt, spec, cases, seed = null }) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('Give at least one velocity case.');
  const rows = cases.map((c) => {
    const z = depthGrid(twt, c.velocity);
    const s = spillAnalysis(z, spec, { seed });
    const at = closureAt(s, spec, s.spillZ);
    return { name: c.name, weight: c.weight ?? 1, crestZ: s.crest.z, spillZ: s.spillZ, columnM: s.crest.z - s.spillZ, areaM2: at.areaM2, grvM3: at.grvM3, limitedByEdge: s.limitedByEdge };
  });
  const g = rows.map((r) => r.grvM3); const w = rows.map((r) => r.weight);
  return {
    rows, low: Math.min(...g), high: Math.max(...g),
    q10: weightedQuantile(g, w, 0.1), q50: weightedQuantile(g, w, 0.5), q90: weightedQuantile(g, w, 0.9),
  };
}

/**
 * A SUGGESTED chance of geological success from the QI assessment (a stated
 * rule for discussion, never applied automatically): the user's own Pg
 * times a factor, held within 0.01 and 0.9.
 *   mature, with conformance 0.7 or more and a feasible target: x 1.3
 *   retain or investigate: x 1 (no change)
 *   downgrade: x 0.7
 * The factors are a convention of this tool, in the spirit of DHI-based
 * risk revision (Roden, Forrest and Holeywell 2005); they are not
 * calibrated on a database of outcomes.
 * @returns {{suggestedPg, factor, reasons: string[]}}
 */
export function suggestPg({ baselinePg, recommendation, conformance = NaN, feasibility = '' }) {
  if (!(baselinePg > 0 && baselinePg < 1)) throw new Error('Give your own chance of success, above 0 and below 1.');
  const reasons = [];
  let factor = 1;
  if (recommendation === 'mature') {
    if (fin(conformance) && conformance >= 0.7 && feasibility === 'feasible') { factor = 1.3; reasons.push('The QI matures the prospect: the anomaly conforms to structure and the target is feasible.'); } else reasons.push('Mature, but conformance under 0.7 or a target not assessed feasible: no change suggested.');
  } else if (recommendation === 'downgrade') { factor = 0.7; reasons.push('The QI argues against the prospect.'); } else reasons.push('The QI neither supports nor argues against the prospect: no change suggested.');
  const suggestedPg = Math.min(0.9, Math.max(0.01, baselinePg * factor));
  if (suggestedPg !== baselinePg * factor) reasons.push('Held within 0.01 and 0.9.');
  return { suggestedPg, factor, reasons };
}
