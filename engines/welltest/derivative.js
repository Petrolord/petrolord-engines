/**
 * Bourdet pressure derivative and gauge-data preparation.
 *
 * The Bourdet derivative (Bourdet, Ayoub & Pirard, 1989) is the diagnostic
 * backbone of modern PTA: de = dp / d(ln x) computed with a three-point
 * weighted difference where the two neighbors are at least L log10 cycles
 * away, which suppresses gauge noise without distorting the response.
 * L between 0 and 0.5 cycles is the accepted range (0.1 default).
 *
 * The abscissa x is whatever log-time variable suits the test: elapsed time
 * for a drawdown, Agarwal equivalent time (or a superposition time function)
 * for a buildup. This module is agnostic; it differentiates y against ln x.
 */

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

const clean = (series, xKey, yKey) =>
  (series || [])
    .map((p) => ({ x: num(p[xKey], NaN), y: num(p[yKey], NaN) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0)
    .sort((a, b) => a.x - b.x);

/**
 * Bourdet three-point derivative dy/d(ln x) with smoothing window L
 * (log10 cycles). Endpoints fall back to a two-point one-sided slope.
 * @returns [{ x, y, derivative }]
 */
export const bourdetDerivative = (series, { L = 0.1, xKey = 'x', yKey = 'y' } = {}) => {
  const pts = clean(series, xKey, yKey);
  if (pts.length < 3) return [];
  const lnx = pts.map((p) => Math.log(p.x));
  const window = Math.max(num(L, 0.1), 0) * Math.LN10;
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    // nearest neighbor at least `window` away on each side (Bourdet rule)
    let left = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (lnx[i] - lnx[j] >= window) { left = j; break; }
    }
    if (left === -1 && i > 0 && window === 0) left = i - 1;
    let right = -1;
    for (let j = i + 1; j < pts.length; j += 1) {
      if (lnx[j] - lnx[i] >= window) { right = j; break; }
    }
    if (right === -1 && i < pts.length - 1 && window === 0) right = i + 1;

    let derivative = NaN;
    if (left >= 0 && right >= 0) {
      const dx1 = lnx[i] - lnx[left];
      const dx2 = lnx[right] - lnx[i];
      const m1 = (pts[i].y - pts[left].y) / dx1;
      const m2 = (pts[right].y - pts[i].y) / dx2;
      derivative = (m1 * dx2 + m2 * dx1) / (dx1 + dx2);
    } else if (right >= 0 && i === 0) {
      derivative = (pts[right].y - pts[i].y) / (lnx[right] - lnx[i]);
    } else if (left >= 0 && i === pts.length - 1) {
      derivative = (pts[i].y - pts[left].y) / (lnx[i] - lnx[left]);
    } else if (i > 0 && i < pts.length - 1) {
      // window wider than available span on one side; use plain central slope
      derivative = (pts[i + 1].y - pts[i - 1].y) / (lnx[i + 1] - lnx[i - 1]);
    }
    out.push({ x: pts[i].x, y: pts[i].y, derivative });
  }
  return out;
};

/**
 * Reduce a dense gauge series to ~pointsPerDecade log-spaced points,
 * always keeping the first and last sample.
 */
export const logDecimate = (series, { pointsPerDecade = 12, xKey = 'x' } = {}) => {
  const pts = (series || [])
    .filter((p) => num(p[xKey], NaN) > 0)
    .sort((a, b) => a[xKey] - b[xKey]);
  if (pts.length < 3) return [...pts];
  const perDecade = Math.max(num(pointsPerDecade, 12), 1);
  const out = [pts[0]];
  let lastLog = Math.log10(pts[0][xKey]);
  const minGap = 1 / perDecade;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const lg = Math.log10(pts[i][xKey]);
    if (lg - lastLog >= minGap) {
      out.push(pts[i]);
      lastLog = lg;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
};

/**
 * Remove isolated gauge spikes with a rolling-median MAD filter.
 * A point is dropped when it deviates from the local median by more than
 * `threshold` times the local median absolute deviation.
 * @returns { kept, removed }
 */
export const trimSpikes = (series, { window = 5, threshold = 6, yKey = 'y' } = {}) => {
  const pts = [...(series || [])];
  if (pts.length < window) return { kept: pts, removed: [] };
  const half = Math.floor(window / 2);
  const kept = [];
  const removed = [];
  for (let i = 0; i < pts.length; i += 1) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(pts.length, i + half + 1);
    const neighborhood = [];
    for (let j = lo; j < hi; j += 1) {
      if (j !== i) neighborhood.push(num(pts[j][yKey], NaN));
    }
    const sortedN = neighborhood.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sortedN.length) { kept.push(pts[i]); continue; }
    const median = sortedN[Math.floor(sortedN.length / 2)];
    const deviations = sortedN.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)] || 1e-12;
    if (Math.abs(num(pts[i][yKey], NaN) - median) > threshold * 1.4826 * mad) {
      removed.push(pts[i]);
    } else {
      kept.push(pts[i]);
    }
  }
  return { kept, removed };
};

const REGIME_LABELS = {
  'unit-slope': 'Unit slope',
  radial: 'Radial flow',
  linear: 'Linear flow',
  bilinear: 'Bilinear flow',
  'wellbore-storage': 'Wellbore storage',
  'boundary-or-pss': 'Boundary / pseudo-steady state',
  'constant-pressure': 'Constant-pressure boundary / recharge',
};

/**
 * Classify flow regimes from the log-log slope of the Bourdet derivative.
 * Slope bands (classical diagnostic values):
 *   ~1     unit slope   (wellbore storage early, PSS/boundary late)
 *   ~0     radial stabilization
 *   ~1/2   linear flow
 *   ~1/4   bilinear flow
 * Segments shorter than minSpanDecades are discarded as noise.
 *
 * @param {Array<{x:number, derivative:number}>} derivSeries from
 *   bourdetDerivative (positive derivative values only are considered)
 * @returns [{ regime, label, xStart, xEnd, spanDecades }]
 */
export const detectFlowRegimes = (derivSeries, { minSpanDecades = 0.25 } = {}) => {
  const pts = (derivSeries || []).filter(
    (p) => num(p.x, NaN) > 0 && num(p.derivative, NaN) > 0
  );
  if (pts.length < 5) return [];
  const lx = pts.map((p) => Math.log10(p.x));
  const ly = pts.map((p) => Math.log10(p.derivative));

  const classify = (slope) => {
    if (slope >= 0.85 && slope <= 1.2) return 'unit-slope';
    if (Math.abs(slope) <= 0.12) return 'radial';
    if (slope >= 0.38 && slope <= 0.62) return 'linear';
    if (slope >= 0.16 && slope <= 0.34) return 'bilinear';
    if (slope <= -0.35) return 'constant-pressure'; // derivative plunging late
    return null;
  };

  // local slope by central difference over ~2 points each side
  const classes = pts.map((_, i) => {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(pts.length - 1, i + 2);
    if (hi === lo) return null;
    return classify((ly[hi] - ly[lo]) / (lx[hi] - lx[lo]));
  });

  const segments = [];
  let current = null;
  for (let i = 0; i < classes.length; i += 1) {
    if (classes[i] && current && classes[i] === current.regime) {
      current.endIdx = i;
    } else {
      if (current) segments.push(current);
      current = classes[i] ? { regime: classes[i], startIdx: i, endIdx: i } : null;
    }
  }
  if (current) segments.push(current);

  return segments
    .map((seg) => ({
      ...seg,
      spanDecades: lx[seg.endIdx] - lx[seg.startIdx],
    }))
    .filter((seg) => seg.spanDecades >= minSpanDecades)
    .map((seg, idx, arr) => {
      let regime = seg.regime;
      if (regime === 'unit-slope') {
        if (idx === 0) regime = 'wellbore-storage';
        else if (idx === arr.length - 1) regime = 'boundary-or-pss';
      }
      return {
        regime,
        label: REGIME_LABELS[regime] || regime,
        xStart: pts[seg.startIdx].x,
        xEnd: pts[seg.endIdx].x,
        spanDecades: seg.spanDecades,
      };
    });
};
