// Multi-well wavelet comparison and averaging (QI programme Q6a, Milestone
// A6). Wavelets extracted at several wells (Seismolord's well-based Wiener
// extraction, stored with each tie) are compared before one is used for a
// study: aligned by cross-correlation, normalised to unit energy, then the
// pairwise similarity, the average wavelet and each well's misfit to it.
// The average of aligned, energy-normalised wavelets is the common practice
// for a field wavelet (e.g. White and Simm 2003, First Break 21(10)).
// Pure, float64.

const fin = Number.isFinite;

/** Resample a wavelet from dtIn to dtOut ms, linear, centred on its middle sample. */
export function resampleWavelet(w, dtIn, dtOut) {
  if (!(dtIn > 0) || !(dtOut > 0)) throw new Error('Sample intervals must be positive.');
  if (!w?.length) throw new Error('The wavelet is empty.');
  const c = (w.length - 1) / 2;
  const half = Math.floor((c * dtIn) / dtOut);
  const out = new Float64Array(2 * half + 1);
  for (let k = -half; k <= half; k++) {
    const x = c + (k * dtOut) / dtIn;
    const i = Math.floor(x);
    const f = x - i;
    const a = w[i]; const b = w[i + 1];
    out[k + half] = f < 1e-12 ? (fin(a) ? a : 0) : (fin(a) && fin(b) ? a + f * (b - a) : 0);
  }
  return out;
}

const energy = (w) => { let s = 0; for (const v of w) s += v * v; return Math.sqrt(s); };

/** Unit-energy copy (a zero wavelet stays zero). */
export function normaliseWavelet(w) {
  const e = energy(w);
  return Float64Array.from(w, (v) => (e > 0 ? v / e : 0));
}

/** Normalised cross-correlation of a and b with b shifted by lag samples (zero outside). */
function ncc(a, b, lag) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const j = i - lag; if (j >= 0 && j < b.length) s += a[i] * b[j]; }
  const d = energy(a) * energy(b);
  return d > 0 ? s / d : 0;
}

/**
 * Shift b (zero padded) so it best matches a, searching |lag| <= maxLag samples.
 * @returns {{aligned: Float64Array, lag: number, corr: number}}
 */
export function alignWavelet(a, b, { maxLag = 10 } = {}) {
  let best = { lag: 0, corr: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const c = ncc(a, b, lag);
    if (c > best.corr) best = { lag, corr: c };
  }
  const aligned = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { const j = i - best.lag; aligned[i] = j >= 0 && j < b.length ? b[j] : 0; }
  return { aligned, lag: best.lag, corr: best.corr };
}

/**
 * Compare and average wavelets that share one sample interval and length.
 * The first wavelet is the alignment reference; each is aligned to it, then
 * all are normalised to unit energy and averaged; the average is normalised.
 * @param {Array<{name: string, samples: ArrayLike<number>}>} wavelets
 * @param {{maxLag?: number}} [opts]
 * @returns {{average: Float64Array, aligned: Array<{name, samples: Float64Array, lag: number}>,
 *   similarity: number[][], misfit: Array<{name, corrToAverage: number}>}}
 *   similarity is the zero-lag correlation of the aligned, normalised wavelets
 */
export function compareWavelets(wavelets, { maxLag = 10 } = {}) {
  if (!Array.isArray(wavelets) || wavelets.length < 2) throw new Error('Compare at least two wavelets.');
  const n = wavelets[0].samples.length;
  if (wavelets.some((w) => w.samples.length !== n)) throw new Error('Resample the wavelets to one length first.');
  const ref = normaliseWavelet(wavelets[0].samples);
  const aligned = wavelets.map((w, k) => {
    if (k === 0) return { name: w.name, samples: ref, lag: 0 };
    const r = alignWavelet(ref, normaliseWavelet(w.samples), { maxLag });
    return { name: w.name, samples: normaliseWavelet(r.aligned), lag: r.lag };
  });
  const avg = new Float64Array(n);
  for (const a of aligned) for (let i = 0; i < n; i++) avg[i] += a.samples[i] / aligned.length;
  const average = normaliseWavelet(avg);
  const zc = (a, b) => ncc(a, b, 0);
  const similarity = aligned.map((a) => aligned.map((b) => zc(a.samples, b.samples)));
  const misfit = aligned.map((a) => ({ name: a.name, corrToAverage: zc(a.samples, average) }));
  return { average, aligned, similarity, misfit };
}
