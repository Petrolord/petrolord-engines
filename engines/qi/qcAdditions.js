// Seismic QC additions (QI upgrade P2.11, 2026-10-15):
//  - multiples: the averaged, normalised autocorrelation of the traces in a
//    window, its peaks past the wavelet's own lobes, and a periodic flag when
//    a peak at lag L is matched by one near 2L (a multiple train repeats at
//    its period; a primary sequence does not);
//  - amplitude preservation at the wells: the ratio of observed to modelled
//    amplitude at each stack angle, fitted per well as ln(ratio) = c + k
//    sin^2(theta); a slope k shared by the wells is a gain that changes with
//    angle (processing that did not preserve relative amplitudes), which an
//    AVO gradient would read as geology;
//  - depth alignment between wells: each well's mistie (horizon time at the
//    well minus the well's top time through its tie), and the wells whose
//    mistie departs from the median by more than a tolerance.
// Pure, float64.

const fin = Number.isFinite;
const RAD = Math.PI / 180;

/** Normalised autocorrelation of one trace up to maxLag samples (nulls as zero). */
export function autocorrelation(trace, maxLag) {
  const x = Array.from(trace, (v) => (fin(v) && Math.abs(v) <= 1e29 ? v : 0));
  const out = new Float64Array(maxLag + 1);
  let r0 = 0;
  for (const v of x) r0 += v * v;
  if (!(r0 > 0)) return out.fill(NaN);
  for (let l = 0; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0; i + l < x.length; i++) s += x[i] * x[i + l];
    out[l] = s / r0;
  }
  return out;
}

/**
 * The multiple diagnosis of a set of traces in a window.
 * @param {ArrayLike<number>[]} traces the window's samples
 * @param {number} dtMs
 * @param {{minLagMs?, maxLagMs?, threshold?}} [o] lags searched; a peak counts above threshold (0.25)
 * @returns {{acf: Float64Array, peaks: Array<{lagMs, value}>, periodic: boolean, periodMs: ?number, repeat: ?number}}
 */
export function multipleDiagnosis(traces, dtMs, { minLagMs = 40, maxLagMs = 400, threshold = 0.25 } = {}) {
  const maxLag = Math.round(maxLagMs / dtMs);
  const acc = new Float64Array(maxLag + 1);
  let n = 0;
  for (const t of traces) {
    const a = autocorrelation(t, maxLag);
    if (!fin(a[0])) continue;
    for (let l = 0; l <= maxLag; l++) acc[l] += a[l];
    n += 1;
  }
  if (!n) return { acf: acc.fill(NaN), peaks: [], periodic: false, periodMs: null, repeat: null };
  for (let l = 0; l <= maxLag; l++) acc[l] /= n;
  const minLag = Math.max(1, Math.round(minLagMs / dtMs));
  const peaks = [];
  // peaks of |acf|: a free-surface multiple reverses polarity, so its lag reads negative
  const mag = (l) => Math.abs(acc[l]);
  for (let l = minLag; l < maxLag; l++) {
    if (mag(l) > threshold && mag(l) >= mag(l - 1) && mag(l) >= mag(l + 1)) peaks.push({ lagMs: l * dtMs, value: acc[l] });
  }
  peaks.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  let periodic = false; let periodMs = null; let repeat = null;
  for (const p of peaks) {
    const twice = Math.round((2 * p.lagMs) / dtMs);
    if (twice > maxLag) continue;
    let best = -Infinity;
    for (let l = twice - 2; l <= twice + 2; l++) if (l > 0 && l <= maxLag) best = Math.max(best, mag(l));
    if (best > threshold / 2) { periodic = true; periodMs = p.lagMs; repeat = best; break; }
  }
  return { acf: acc, peaks, periodic, periodMs, repeat };
}

/**
 * Amplitude preservation at the wells.
 * @param {Array<{name, angles: number[], observed: number[], modelled: number[]}>} wells amplitudes at one event per stack
 * @param {{tolerance?: number}} [o] a shared |k| over tolerance (0.5: the ratio changes by about 40 percent from 0 to 40 degrees) is flagged
 * @returns {{rows: Array<{name, k, c, n}>, k: number, flagged: boolean, consistent: boolean}}
 */
export function amplitudePreservation(wells, { tolerance = 0.5 } = {}) {
  const rows = wells.map((w) => {
    const xs = []; const ys = [];
    w.angles.forEach((a, i) => {
      const o = w.observed[i]; const m = w.modelled[i];
      if (fin(a) && fin(o) && fin(m) && o !== 0 && m !== 0 && Math.sign(o) === Math.sign(m)) { xs.push(Math.sin(a * RAD) ** 2); ys.push(Math.log(o / m)); }
    });
    const n = xs.length;
    if (n < 2) return { name: w.name, k: NaN, c: NaN, n };
    const mx = xs.reduce((s, v) => s + v, 0) / n; const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxx = 0; let sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    const k = sxx > 0 ? sxy / sxx : NaN;
    return { name: w.name, k, c: my - k * mx, n };
  });
  const ks = rows.map((r) => r.k).filter(fin).sort((a, b) => a - b);
  const k = ks.length ? ks[Math.floor(ks.length / 2)] : NaN;
  const consistent = ks.length >= 2 && ks.every((v) => Math.sign(v) === Math.sign(k));
  return { rows, k, flagged: fin(k) && Math.abs(k) > tolerance && (ks.length < 2 || consistent), consistent };
}

/**
 * Depth alignment between wells.
 * @param {Array<{name, horizonMs: number, wellMs: number}>} wells one horizon: its time at the well and the well top's time through the tie
 * @param {{toleranceMs?: number}} [o] (8 ms)
 * @returns {{rows: Array<{name, mistieMs, offMs, flagged}>, medianMs: number}}
 */
export function depthAlignment(wells, { toleranceMs = 8 } = {}) {
  const rows = wells.map((w) => ({ name: w.name, mistieMs: fin(w.horizonMs) && fin(w.wellMs) ? w.horizonMs - w.wellMs : NaN }));
  const m = rows.map((r) => r.mistieMs).filter(fin).sort((a, b) => a - b);
  const median = m.length ? (m.length % 2 ? m[(m.length - 1) / 2] : (m[m.length / 2 - 1] + m[m.length / 2]) / 2) : NaN;
  return { medianMs: median, rows: rows.map((r) => ({ ...r, offMs: fin(r.mistieMs) ? r.mistieMs - median : NaN, flagged: fin(r.mistieMs) && Math.abs(r.mistieMs - median) > toleranceMs })) };
}
