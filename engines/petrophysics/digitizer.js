// Raster log digitizer (Petrophysics Studio G2.6, folding in the
// standalone AutomatedLogDigitizer as a utility-grade import wizard):
// scanned image + two-point axis calibration + a clicked trace -> a
// uniform-step curve for the registry. Pure functions, no I/O; the UI
// (DigitizerDialog) supplies pixel coordinates and the user's
// reference values.
//
// Utility-grade by design (plan decision 6): a hand trace is only as
// good as the clicks. Provenance marks every digitized curve
// {digitized:true} so downstream apps never mistake it for a logged
// measurement.

/**
 * Linear or log10 axis from two calibration points (pixel -> data).
 * Depth axes are linear; value axes may be log (resistivity).
 * @param {number} p1 @param {number} v1 @param {number} p2 @param {number} v2
 * @param {boolean} [log]
 */
export function makeAxis(p1, v1, p2, v2, log = false) {
  if (p1 === p2) throw new Error('Calibration points must sit at different pixels.');
  if (log && (v1 <= 0 || v2 <= 0)) throw new Error('A log axis needs positive calibration values.');
  const a1 = log ? Math.log10(v1) : v1;
  const a2 = log ? Math.log10(v2) : v2;
  const slope = (a2 - a1) / (p2 - p1);
  return (pixel) => {
    const a = a1 + slope * (pixel - p1);
    return log ? 10 ** a : a;
  };
}

/**
 * Clicked pixels -> (depth, value) samples, sorted by depth ascending.
 * Duplicate depths are collapsed (last wins) so the result is a
 * function of depth the resampler can interpolate.
 * @param {Array<{x: number, y: number}>} points pixel coords
 * @param {(py: number) => number} depthAxis @param {(px: number) => number} valueAxis
 */
export function traceToSamples(points, depthAxis, valueAxis) {
  const byDepth = new Map();
  for (const p of points) byDepth.set(depthAxis(p.y), valueAxis(p.x));
  return [...byDepth.entries()]
    .map(([depth, value]) => ({ depth, value }))
    .sort((a, b) => a.depth - b.depth);
}

/**
 * Resample (depth, value) samples onto a uniform depth grid by linear
 * interpolation; grid runs from the first to the last sample depth at
 * `step`. Extrapolation never happens — the grid is bounded by the
 * trace. NaN is impossible here (both endpoints finite by
 * construction).
 * @param {Array<{depth: number, value: number}>} samples >= 2, sorted
 * @param {number} step metres
 * @returns {{startMdM: number, stopMdM: number, stepM: number, depth: Float64Array, data: Float32Array}}
 */
export function resampleUniform(samples, step) {
  if (samples.length < 2) throw new Error('Digitize at least two points before building a curve.');
  if (!(step > 0)) throw new Error('The depth step must be positive.');
  const start = samples[0].depth;
  const stop = samples[samples.length - 1].depth;
  const n = Math.floor((stop - start) / step) + 1;
  const depth = new Float64Array(n);
  const data = new Float32Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const d = start + i * step;
    depth[i] = d;
    while (seg < samples.length - 2 && samples[seg + 1].depth < d) seg += 1;
    const a = samples[seg];
    const b = samples[seg + 1];
    const t = b.depth === a.depth ? 0 : (d - a.depth) / (b.depth - a.depth);
    data[i] = a.value + t * (b.value - a.value);
  }
  return { startMdM: start, stopMdM: depth[n - 1], stepM: step, depth, data };
}

/**
 * Full pixel-trace -> registry log payload (wellsRegistry saveLog
 * shape, digitized provenance). Convenience over the three steps.
 * @param {{points: Array<{x,y}>, depthCal: [{pixel,value},{pixel,value}],
 *   valueCal: [{pixel,value},{pixel,value}], valueLog?: boolean,
 *   step: number, mnemonic: string, unit?: string, sourceImage?: string}} spec
 */
export function digitizeCurve(spec) {
  const depthAxis = makeAxis(spec.depthCal[0].pixel, spec.depthCal[0].value,
    spec.depthCal[1].pixel, spec.depthCal[1].value, false);
  const valueAxis = makeAxis(spec.valueCal[0].pixel, spec.valueCal[0].value,
    spec.valueCal[1].pixel, spec.valueCal[1].value, !!spec.valueLog);
  const samples = traceToSamples(spec.points, depthAxis, valueAxis);
  const r = resampleUniform(samples, spec.step);
  return {
    mnemonic: spec.mnemonic,
    description: `Digitized ${spec.mnemonic}${spec.sourceImage ? ` from ${spec.sourceImage}` : ''}`,
    unit: spec.unit || null,
    data: r.data,
    startMdM: r.startMdM,
    stopMdM: r.stopMdM,
    stepM: r.stepM,
    nSamples: r.data.length,
    nullCount: 0,
    provenance: {
      digitized: true,
      engine: 'petrophysics-studio',
      value_scale: spec.valueLog ? 'log10' : 'linear',
      n_trace_points: spec.points.length,
      source_image: spec.sourceImage || null,
    },
  };
}
