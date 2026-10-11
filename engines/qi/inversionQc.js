// Inversion quality control at the wells (QI programme Q8a, 2026-10-06;
// moved from the Suite's QIStudio/services/inversionRun.js on 2026-10-11, QI
// course gate E2): the least-squares scale that ties the wavelet's synthetic
// to the seismic at the wells, the moving-average high cut used for the LFM
// and the truth logs, and the blind-well table (each well inverted with the
// low-frequency model built from the other wells, scored against its own log
// after a high cut). Pure. Oracle: tools/validation/qi/oracle_qi_inversion_qc.py.

import { forwardPoststack, lowFrequencyModel } from './inversion.js';
import { blindWellScore } from './lfm.js';

/** The default low cut of the coloured truth band (Hz), as QI Studio's INVERSION_DEFAULTS.band[0]. */
export const BLIND_LOW_CUT_HZ = 8;

const NULL_LIM = 1e29; // brick nulls are 1e30
const fin = Number.isFinite;
const isNull = (v) => !(Math.abs(v) <= NULL_LIM);

/** Moving-average half window in samples for a cut frequency. */
export const halfWindowFor = (hz, dtMs) => Math.max(1, Math.round(1000 / (hz * dtMs) / 2));

/** A copy of an array with its NaN runs left alone and its finite runs low-passed. */
export function lowPassFinite(values, half) {
  const out = Float64Array.from(values, (v) => (fin(v) ? v : NaN));
  const lp = lowFrequencyModel(out, half);
  for (let i = 0; i < out.length; i++) out[i] = fin(out[i]) ? lp[i] : NaN;
  return out;
}

/**
 * The least-squares scale s that makes s * forward(ln AI) match the seismic
 * at the wells, pooled over every well sample where both are defined.
 * @param {Array<{trace: ArrayLike<number>, lnAi: ArrayLike<number>}>} pairs
 */
export function waveletScale(pairs, wavelet) {
  let sxy = 0; let sxx = 0; let n = 0;
  for (const { trace, lnAi } of pairs) {
    // fill the log's gaps with its own edge values so the forward model has no step at a gap
    const filled = holdFill(lnAi);
    if (!filled) continue;
    const syn = forwardPoststack(filled, wavelet);
    const half = (wavelet.length - 1) / 2;
    for (let i = 0; i < trace.length; i++) {
      if (isNull(trace[i]) || !coveredWithin(lnAi, i, half)) continue;
      sxy += syn[i] * trace[i]; sxx += syn[i] * syn[i]; n += 1;
    }
  }
  if (n < 10 || !(sxx > 0)) throw new Error('The wells overlap too little seismic to scale the wavelet.');
  return { scale: sxy / sxx, samples: n };
}

function holdFill(values) {
  let first = -1;
  for (let i = 0; i < values.length; i++) if (fin(values[i])) { first = i; break; }
  if (first < 0) return null;
  const out = Float64Array.from(values, (v) => (fin(v) ? v : NaN)); // JSON carries NaN as null
  for (let i = 0; i < first; i++) out[i] = out[first];
  for (let i = first + 1; i < out.length; i++) if (!fin(out[i])) out[i] = out[i - 1];
  return out;
}

const coveredWithin = (values, i, half) => {
  for (let j = i - half - 1; j <= i + half + 1; j++) if (!(j >= 0 && j < values.length && fin(values[j]))) return false;
  return true;
};

/**
 * The blind-well table: each well inverted with the low-frequency model
 * built from the other wells, scored against its own log after a high cut
 * at truthHz; beside it the same well with itself in the model, so the
 * share of the match that comes from the model is visible. Relative
 * impedance (coloured) has no low frequencies, so its truth is the log
 * band-passed between lowCutHz and truthHz and only the correlation counts.
 * @returns {Array<{name, blind: {corr, rmsPct, n}, withWell: {corr, rmsPct, n}}>}
 */
export function blindWellTable({ invert, wells, traces, dtMs, truthHz, absolute, lowCutHz = BLIND_LOW_CUT_HZ }) {
  const half = halfWindowFor(truthHz, dtMs);
  return wells.map((w, k) => {
    let truth = lowPassFinite(w.ln_ai, half);
    if (!absolute) {
      const low = lowPassFinite(w.ln_ai, halfWindowFor(lowCutHz, dtMs));
      truth = truth.map((v, i) => v - low[i]);
    }
    const score = (est) => {
      if (absolute) return blindWellScore(est, truth);
      // relative impedance has no level or scale: compare the shapes only
      return correlationOnly(est, truth);
    };
    return {
      name: w.name,
      blind: score(invert(traces[k], w.il, w.xl, w.name)),
      withWell: score(invert(traces[k], w.il, w.xl)),
    };
  });
}

function correlationOnly(a, b) {
  const x = []; const y = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (fin(a[i]) && fin(b[i])) { x.push(a[i]); y.push(b[i]); }
  const n = x.length;
  if (n < 3) return { corr: NaN, rmsPct: null, n };
  const mx = x.reduce((s, v) => s + v, 0) / n; const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return { corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN, rmsPct: null, n };
}
