// Zone maps from volumes (QI upgrade P1.5, 2026-10-15): per-trace statistics
// of a volume between two horizons, or a horizon and a window below it, for
// map products: the zone mean, RMS, minimum, maximum and the share of the
// zone beyond a cutoff (for a facies probability volume, the mean is the
// expected share of the zone in that facies and the share beyond 0.5 is the
// share where it is the more likely), and the zone mean of an uncertainty
// spread (Q90 - Q10, and relative to Q50) for confidence maps. Pure; the
// seismic worker drives it over the lattice.
//
// Window convention: the samples from round(min(top, base)) to
// round(max(top, base)), clamped to the trace, the A-to-B convention of
// Seismolord's interval attributes (seismolord/horizonAmplitude.js
// intervalStat), so a zone map and an interval attribute agree. A pick is a
// fractional sample index; null picks (1e30) give no value.
//
// Oracle: tools/validation/qi/oracle_zone_maps.py (numpy, its own window
// arithmetic), goldens in test-data/qi/goldens.zoneMaps.json.

import { avoClassCode } from './avoCalibration.js';

const NULL_LIM = 1e29;
const fin = Number.isFinite;
const isNull = (v) => !(Math.abs(v) <= NULL_LIM) || !fin(v);

export const ZONE_STATS = Object.freeze([
  { key: 'mean', label: 'Zone mean' },
  { key: 'rms', label: 'Zone RMS' },
  { key: 'min', label: 'Zone minimum' },
  { key: 'max', label: 'Zone maximum' },
  { key: 'frac', label: 'Share of the zone beyond the cutoff' },
]);

/**
 * The zone's sample range on one trace.
 * @param {number} top fractional sample index of the top pick
 * @param {?number} base fractional sample index of the base pick, or null
 * @param {number} ns samples per trace
 * @param {{windowSamples?: number}} [o] with no base: the window below the top, in samples
 * @returns {?[number, number]} inclusive [s0, s1], or null (missing pick, empty zone)
 */
export function zoneRange(top, base, ns, { windowSamples = null } = {}) {
  if (isNull(top)) return null;
  let b = base;
  if (b == null) {
    if (!(windowSamples > 0)) return null;
    b = top + windowSamples;
  } else if (isNull(b)) return null;
  const s0 = Math.max(0, Math.round(Math.min(top, b)));
  const s1 = Math.min(ns - 1, Math.round(Math.max(top, b)));
  return s1 >= s0 ? [s0, s1] : null;
}

/**
 * Statistics of one trace over [s0, s1]; null samples never count.
 * @param {ArrayLike<number>} trace
 * @param {number} s0 @param {number} s1
 * @param {{cutoff?: ?number, above?: boolean}} [o]
 * @returns {{n, mean, rms, min, max, frac}} NaN where the zone has no live sample (frac NaN without a cutoff)
 */
export function zoneStats(trace, s0, s1, { cutoff = null, above = true } = {}) {
  let n = 0; let sum = 0; let sq = 0; let mn = Infinity; let mx = -Infinity; let beyond = 0;
  const hasCut = cutoff != null && fin(cutoff);
  for (let s = s0; s <= s1; s++) {
    const v = trace[s];
    if (isNull(v)) continue;
    n += 1; sum += v; sq += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    if (hasCut && (above ? v > cutoff : v < cutoff)) beyond += 1;
  }
  if (!n) return { n: 0, mean: NaN, rms: NaN, min: NaN, max: NaN, frac: NaN };
  return { n, mean: sum / n, rms: Math.sqrt(sq / n), min: mn, max: mx, frac: hasCut ? beyond / n : NaN };
}

/**
 * The zone mean of an uncertainty spread: Q90 - Q10, and (Q90 - Q10) / Q50,
 * over the samples where all three are live (Q50 not zero for the relative
 * spread). A narrower spread is a more confident prediction.
 * @returns {{n, spread, relSpread}}
 */
export function zoneSpread(q10, q50, q90, s0, s1) {
  let n = 0; let sp = 0; let nr = 0; let rel = 0;
  for (let s = s0; s <= s1; s++) {
    const a = q10[s]; const m = q50[s]; const b = q90[s];
    if (isNull(a) || isNull(m) || isNull(b)) continue;
    n += 1; sp += b - a;
    if (m !== 0) { nr += 1; rel += (b - a) / m; }
  }
  return { n, spread: n ? sp / n : NaN, relSpread: nr ? rel / nr : NaN };
}

/** Zone thickness in ms from the picks (base below top), NaN without both. */
export function zoneThicknessMs(top, base, dtMs) {
  if (isNull(top) || isNull(base)) return NaN;
  return Math.abs(base - top) * dtMs;
}

/**
 * Every requested product of one trace position.
 * @param {Object} p
 * @param {Object<string, ArrayLike<number>>} p.traces the traces by input key
 * @param {Array<{key, kind: 'stat'|'spread'|'thickness'|'avo_class', input?, stat?, cutoff?, above?, q10?, q50?, q90?, a?, b?, scale?, band?}>} p.products (avo_class: the class code of the zone means of A and B divided by the scale)
 * @param {?[number, number]} p.range zoneRange output
 * @param {number} p.top @param {?number} p.base @param {number} p.dtMs
 * @returns {Float64Array} one value per product, NaN where there is none
 */
export function zoneProducts({ traces, products, range, top, base, dtMs }) {
  const out = new Float64Array(products.length).fill(NaN);
  if (!range) return out;
  const [s0, s1] = range;
  products.forEach((p, i) => {
    if (p.kind === 'thickness') { out[i] = base == null ? (s1 - s0) * dtMs : zoneThicknessMs(top, base, dtMs); return; }
    if (p.kind === 'avo_class') {
      // QI upgrade P2.10: the AVO class (1 to 4) of the zone means of the scaled intercept and gradient
      const a = zoneStats(traces[p.a], s0, s1).mean; const b = zoneStats(traces[p.b], s0, s1).mean;
      const sc = fin(p.scale) && p.scale !== 0 ? p.scale : 1;
      out[i] = avoClassCode(a / sc, b / sc, p.band ?? 0.02);
      return;
    }
    if (p.kind === 'spread') {
      const r = zoneSpread(traces[p.q10], traces[p.q50], traces[p.q90], s0, s1);
      out[i] = p.relative ? r.relSpread : r.spread;
      return;
    }
    const st = zoneStats(traces[p.input], s0, s1, { cutoff: p.cutoff ?? null, above: p.above !== false });
    out[i] = st[p.stat];
  });
  return out;
}
