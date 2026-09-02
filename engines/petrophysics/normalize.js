// Curve normalization (Petrophysics Studio PS7): the numbers a
// petrophysicist quotes when calibrating one well's GR to a field
// reference — percentile anchors, the affine fit, and its
// application. Shared engine conventions (see vsh.js): pure, float64,
// NaN-propagating, no I/O.
//
// Two cited-practice methods:
//   two-point: match the pLow/pHigh percentiles of the target to the
//     reference (the standard GR field normalization, usually P5/P95)
//   mean-std: match mean and population standard deviation
// Both produce v' = shift + scale*v; applying a fit computed from a
// target that is an exact affine distortion of the reference recovers
// the reference exactly (the anchor the fixtures assert).

/** p-th percentile (0-100) of the FINITE values, linear interpolation
 *  on rank (n-1)*p/100 — the numpy 'linear' definition. NaN when no
 *  finite value exists. */
export function percentile(values, p) {
  const finite = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) finite.push(values[i]);
  }
  if (!finite.length) return NaN;
  finite.sort((a, b) => a - b);
  const rank = ((finite.length - 1) * p) / 100;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return finite[lo];
  return finite[lo] + (finite[hi] - finite[lo]) * (rank - lo);
}

function meanStd(values) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) { s += values[i]; n += 1; }
  }
  if (!n) return { mean: NaN, std: NaN, n: 0 };
  const mean = s / n;
  let v = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) v += (values[i] - mean) ** 2;
  }
  return { mean, std: Math.sqrt(v / n), n }; // population std
}

/**
 * Fit target -> reference: v' = shift + scale*v.
 * @param {ArrayLike<number>} refValues
 * @param {ArrayLike<number>} targetValues
 * @param {{method?: 'two-point'|'mean-std', pLow?: number, pHigh?: number}} [opts]
 * @returns {{method, shift, scale, refP: ?number[], targetP: ?number[],
 *            refMean: ?number, refStd: ?number, targetMean: ?number, targetStd: ?number}}
 *   shift/scale are NaN when the fit is degenerate (flat target).
 */
export function fitNormalization(refValues, targetValues, { method = 'two-point', pLow = 5, pHigh = 95 } = {}) {
  if (method === 'mean-std') {
    const r = meanStd(refValues);
    const t = meanStd(targetValues);
    const scale = t.std > 0 ? r.std / t.std : NaN;
    return {
      method,
      scale,
      shift: r.mean - t.mean * scale,
      refP: null,
      targetP: null,
      refMean: r.mean,
      refStd: r.std,
      targetMean: t.mean,
      targetStd: t.std,
    };
  }
  const refP = [percentile(refValues, pLow), percentile(refValues, pHigh)];
  const targetP = [percentile(targetValues, pLow), percentile(targetValues, pHigh)];
  const denom = targetP[1] - targetP[0];
  const scale = denom !== 0 ? (refP[1] - refP[0]) / denom : NaN;
  return {
    method: 'two-point',
    scale,
    shift: refP[0] - targetP[0] * scale,
    refP,
    targetP,
    refMean: null,
    refStd: null,
    targetMean: null,
    targetStd: null,
  };
}

/** Apply a fit: v' = shift + scale*v, NaN preserved. */
export function applyNormalization(values, { shift, scale }) {
  return Float64Array.from(values, (v) => (Number.isFinite(v) ? shift + scale * v : NaN));
}
