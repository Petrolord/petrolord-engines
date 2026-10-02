// Wellsite Studio U2-006: the drilling exponent and its mud-weight
// correction (first half of Pore Pressure U2-014).
//
// Jorden and Shirley (1966) normalised the rate of penetration for weight
// on bit, rotary speed and bit size, so that a change in the exponent
// reflects the rock and the differential pressure rather than the driller:
//
//   d = log10( R / (60 N) ) / log10( 12 W / (10^6 D) )
//
// with R in ft/hr, N in rev/min, W in lbf and D in inches. Rehm and
// McClendon (1971) corrected it for the mud weight in use, so that a mud
// weight raised to hold a pressure does not hide the pressure:
//
//   dc = d x (normal pore pressure gradient as a mud weight) / (mud weight in use, as ECD)
//
// The ratio is of two densities, so any one unit serves for both.
//
// In normally pressured shale dc rises with depth along a trend that is a
// straight line on a semi-logarithmic plot (log dc against depth). A dc
// falling away to the left of that trend is the sign of undercompaction.
// This module gives d, dc, the fitted normal trend and the ratio of the
// observed dc to the trend. It does NOT turn that ratio into a pore
// pressure: that step (Eaton, or the Rehm and McClendon and Zamora
// overlays) belongs to the pressure engines and is not part of U2-006.
//
// Both logarithm arguments must lie strictly between 0 and 1 for the
// exponent to mean anything: R/(60N) is the feet advanced per revolution
// and 12W/(10^6 D) the weight per inch of bit over 10^6/12 lbf/in. A weight
// above 83,333 lbf per inch of bit, or more than a foot per revolution,
// makes a logarithm zero or positive and the engine refuses.

export const M_PER_FT = 0.3048;
export const M_PER_IN = 0.0254;
export const N_PER_LBF = 4.4482216152605;
/** 0.465 psi/ft, the US Gulf Coast normal gradient, as a mud weight: 0.465 / 0.052 lbm/gal. */
export const GULF_COAST_NORMAL_PPG = 0.465 / 0.052;

/**
 * The d-exponent in field units.
 * @returns {{ ok: true, d: number, ropTerm: number, wobTerm: number } | { ok: false, reason: string }}
 */
export function dExponentField({ ropFtHr, rpm, wobLbf, bitIn }) {
  if (!(ropFtHr > 0)) return { ok: false, reason: 'The rate of penetration must be positive.' };
  if (!(rpm > 0)) return { ok: false, reason: 'The rotary speed must be positive.' };
  if (!(wobLbf > 0)) return { ok: false, reason: 'The weight on bit must be positive.' };
  if (!(bitIn > 0)) return { ok: false, reason: 'The bit diameter must be positive.' };
  const ropTerm = ropFtHr / (60 * rpm);
  const wobTerm = (12 * wobLbf) / (1e6 * bitIn);
  if (!(ropTerm < 1)) return { ok: false, reason: 'The bit advances a foot or more per revolution, outside the range the d-exponent is defined for.' };
  if (!(wobTerm < 1)) return { ok: false, reason: 'The weight on bit is above 83,333 lbf per inch of bit diameter, outside the range the d-exponent is defined for.' };
  return { ok: true, d: Math.log10(ropTerm) / Math.log10(wobTerm), ropTerm, wobTerm };
}

/** The d-exponent from SI inputs: ROP in m/hr, weight on bit in newtons, bit diameter in metres. */
export function dExponent({ ropMPerHr, rpm, wobN, bitM }) {
  return dExponentField({ ropFtHr: ropMPerHr / M_PER_FT, rpm, wobLbf: wobN / N_PER_LBF, bitIn: bitM / M_PER_IN });
}

/**
 * The corrected d-exponent. normalMudWeight and mudWeight share one unit
 * (lbm/gal, sg or kg/m3); mudWeight is the mud weight in use, the ECD when known.
 */
export function correctedDExponent({ d, normalMudWeight, mudWeight }) {
  if (!Number.isFinite(d)) return { ok: false, reason: 'A d-exponent is needed first.' };
  if (!(normalMudWeight > 0)) return { ok: false, reason: 'The normal pore pressure gradient, as a mud weight, must be positive.' };
  if (!(mudWeight > 0)) return { ok: false, reason: 'The mud weight in use must be positive.' };
  return { ok: true, dc: d * (normalMudWeight / mudWeight), ratio: normalMudWeight / mudWeight };
}

/**
 * The normal compaction trend of dc: a least squares line of log10(dc)
 * against depth through the points given (the interpreter chooses the
 * normally pressured shale points). Depth is in whatever one unit the
 * caller uses throughout (TVD is the convention).
 * @param {{depth:number, dc:number}[]} points
 * @returns {{ ok: true, slope, intercept, n, at(depth) } | { ok: false, reason }}
 */
export function fitNormalTrend(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p.depth) && p.dc > 0);
  if (pts.length < 2) return { ok: false, reason: 'A normal trend needs at least two points with a positive dc.' };
  const n = pts.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const p of pts) { const y = Math.log10(p.dc); sx += p.depth; sy += y; sxx += p.depth * p.depth; sxy += p.depth * y; }
  const den = n * sxx - sx * sx;
  if (!(Math.abs(den) > 0)) return { ok: false, reason: 'The trend points are all at one depth, so no trend can be fitted.' };
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  return { ok: true, slope, intercept, n, at: (depth) => 10 ** (intercept + slope * depth) };
}

/** dc on a fitted trend at a depth (for callers that stored slope and intercept). */
export function trendAt({ slope, intercept }, depth) {
  return 10 ** (intercept + slope * depth);
}

/**
 * Observed dc against the normal trend at each depth: the ratio and
 * whether it has fallen below the trend by more than `tolerance`
 * (a fraction; 0.1 flags a dc more than 10 percent under the trend).
 */
export function trendDeparture(points, trend, { tolerance = 0.1 } = {}) {
  if (!trend || !Number.isFinite(trend.slope) || !Number.isFinite(trend.intercept)) return [];
  return (points || []).filter((p) => Number.isFinite(p.depth) && p.dc > 0).map((p) => {
    const normal = trendAt(trend, p.depth);
    const ratio = p.dc / normal;
    return { depth: p.depth, dc: p.dc, normalDc: normal, ratio, below: ratio < 1 - tolerance };
  });
}
