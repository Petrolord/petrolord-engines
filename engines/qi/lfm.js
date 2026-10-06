// Low-frequency model for impedance inversion (QI programme Q8a). Well
// ln(AI) logs in two-way time, low-passed, are interpolated to any trace by
// inverse-distance weighting inside a stratigraphic frame: between two
// interpreted horizons a sample keeps its proportional position, so a layer
// that thickens or dips between wells keeps its impedance (the usual
// horizon-guided LFM, e.g. Simm and Bacon 2014, Seismic Amplitude, ch. 9).
// Above the first horizon and below the last the time offset from that
// horizon is kept. With no horizons the interpolation is at constant time.
// Also the blind-well score used to report the error at a well left out of
// the model. Pure, float64.

const fin = Number.isFinite;

/** Time at the well that corresponds to time t at the trace, given matching horizon picks. */
export function mapToWellTime(t, traceHorizons, wellHorizons) {
  const H = traceHorizons || []; const h = wellHorizons || [];
  if (H.length !== h.length) throw new Error('The trace and the well need the same horizons.');
  if (!H.length) return t;
  if (t <= H[0]) return h[0] + (t - H[0]);
  const last = H.length - 1;
  if (t >= H[last]) return h[last] + (t - H[last]);
  for (let i = 0; i < last; i++) {
    if (t <= H[i + 1]) {
      const span = H[i + 1] - H[i];
      const p = span > 0 ? (t - H[i]) / span : 0;
      return h[i] + p * (h[i + 1] - h[i]);
    }
  }
  return t;
}

/** Linear sample of a regularly sampled log at time t (NaN outside or on a null). */
export function sampleAt(values, t0Ms, dtMs, t) {
  const x = (t - t0Ms) / dtMs;
  if (!(x >= 0) || x > values.length - 1) return NaN;
  const i = Math.floor(x); const f = x - i;
  const a = values[i];
  if (f < 1e-12) return fin(a) ? a : NaN;
  const b = values[i + 1];
  return fin(a) && fin(b) ? a + f * (b - a) : NaN;
}

/**
 * The low-frequency model at one trace.
 * @param {Array<{name: string, x: number, y: number, t0Ms: number, dtMs: number,
 *   values: ArrayLike<number>, horizons?: number[]}>} wells low-passed ln(AI) in TWT
 * @param {{x: number, y: number, horizons?: number[]}} at the trace position and its horizon times
 * @param {{t0Ms: number, dtMs: number, ns: number}} grid the trace sampling
 * @param {{power?: number, exclude?: string}} [opts] IDW power; exclude names a well left out (blind test)
 * @returns {Float64Array} samples no well covers hold the nearest covered value
 */
export function lfmTrace(wells, at, grid, { power = 2, exclude } = {}) {
  const used = wells.filter((w) => w.name !== exclude);
  if (!used.length) throw new Error('The low-frequency model needs at least one well.');
  const weights = used.map((w) => {
    const d = Math.hypot(w.x - at.x, w.y - at.y);
    return d < 1e-6 ? Infinity : 1 / d ** power;
  });
  const exact = weights.findIndex((v) => v === Infinity);
  const out = new Float64Array(grid.ns).fill(NaN);
  for (let k = 0; k < grid.ns; k++) {
    const t = grid.t0Ms + k * grid.dtMs;
    let s = 0; let ws = 0;
    for (let j = 0; j < used.length; j++) {
      if (exact >= 0 && j !== exact) continue;
      const w = used[j];
      const v = sampleAt(w.values, w.t0Ms, w.dtMs, mapToWellTime(t, at.horizons, w.horizons));
      if (!fin(v)) continue;
      const wt = exact >= 0 ? 1 : weights[j];
      s += wt * v; ws += wt;
    }
    if (ws > 0) out[k] = s / ws;
  }
  let first = -1;
  for (let k = 0; k < grid.ns; k++) if (fin(out[k])) { first = k; break; }
  if (first < 0) throw new Error('No well log covers this trace window.');
  for (let k = 0; k < first; k++) out[k] = out[first];
  for (let k = first + 1; k < grid.ns; k++) if (!fin(out[k])) out[k] = out[k - 1];
  return out;
}

/**
 * Score an inverted ln(AI) trace against the well's ln(AI) at the same times.
 * @returns {{corr: number, rmsPct: number, n: number}} correlation of AI and the
 *   RMS of the relative AI error in percent, over samples where both are defined
 */
export function blindWellScore(estimateLnAi, truthLnAi) {
  const a = []; const b = [];
  for (let i = 0; i < Math.min(estimateLnAi.length, truthLnAi.length); i++) {
    if (fin(estimateLnAi[i]) && fin(truthLnAi[i])) { a.push(Math.exp(estimateLnAi[i])); b.push(Math.exp(truthLnAi[i])); }
  }
  const n = a.length;
  if (n < 3) return { corr: NaN, rmsPct: NaN, n };
  const ma = a.reduce((s, v) => s + v, 0) / n; const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0; let saa = 0; let sbb = 0; let se = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2;
    se += ((a[i] - b[i]) / b[i]) ** 2;
  }
  return { corr: saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN, rmsPct: 100 * Math.sqrt(se / n), n };
}
