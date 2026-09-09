// Probabilistic petrophysics (Petrophysics Studio PT10c, 2026-09-09).
//
// Seeded parameter draws pushed through the SAME zoned pipeline the
// deterministic interpretation runs on, giving per-sample percentile
// curves, per-zone outcome and parameter statistics, and a sensitivity.
// Nothing petrophysical is re-derived here: every realisation is
// computeWellZoned + zoneSummary verbatim, and every random-number,
// distribution, quantile and sensitivity primitive is imported from
// lib/stats (the canonical Monte Carlo module ReservoirCalc Pro's
// MonteCarloEngine delegates to), per the Suite's no-new-Monte-Carlo rule.
//
// Naming (owner decision 1, 2026-09-09; SPE PRMS / SEC exceedance):
//   - per-sample curves and per-zone PARAMETER statistics are numeric
//     percentiles of the quantity, named _Q10 / _Q50 / _Q90 and described
//     as "10th percentile of Sw"; they never carry a P-label, because the
//     exceedance convention is only unambiguous where more is better
//     (Sw is where it breaks);
//   - per-zone OUTCOMES (net_m, ntg) carry p90 / p50 / p10 under the
//     exceedance meaning: p90 is the value with a 90 percent probability
//     of being met or exceeded, i.e. the 10th percentile of the draws, so
//     p90 <= p50 <= p10 always;
//   - PAY_PROB is the fraction of realisations that flag a sample as pay.
//
// Quantile definition: lib/stats `quantile` (simple-statistics
// quantileSorted): the order statistic at ceil(n*p) when n*p is not an
// integer, the mean of the two neighbours when it is. Pinned by test.
// With n = 201 draws every default quantile is an exact order statistic,
// which is what makes the monotone-transform identity gate exact.

import { computeWellZoned, zoneSummary, DEFAULT_PARAMS } from './pipeline';
import {
  mulberry32, createCorrelatedSampler, fitTriangularToPercentiles, isVariable,
  ss, mean as statsMean, rankCorrelationSensitivity, tornadoSwings,
} from '../../lib/stats/stats';

/** Numeric parameters a run may vary. Models (vshMethod, swMethod, ...) are fixed for a run. */
export const UNCERTAIN_PARAMS = [
  'grClean', 'grClay', 'phiShale', 'rhoMa', 'rhoFl', 'dtMa', 'dtFl',
  'a', 'm', 'n', 'rw', 'rsh', 'qv', 'rwb', 'swb',
  'bucklesConst', 'swirrManual', 'wrC', 'wrQ',
  'cutPhi', 'cutVsh', 'cutSw',
];

/** Curves that get per-sample percentile twins. */
export const QUANTILE_CURVES = ['PHIE', 'PHIT', 'VSH', 'SW', 'BVW', 'KPERM'];
export const DEFAULT_QUANTILES = [0.1, 0.5, 0.9];
/** Address suffix for a percentile curve: 0.1 -> Q10 (never a P-label). */
export const quantileSuffix = (q) => `Q${Math.round(q * 100)}`;
/** Zone summary fields that are OUTCOMES (exceedance P-labels) and PARAMETERS (percentiles). */
export const OUTCOME_FIELDS = ['net_m', 'ntg'];
export const PARAMETER_FIELDS = ['phi_avg', 'sw_avg', 'vsh_avg', 'k_gm_md'];

/**
 * A triangular distribution from three stated percentiles of a PARAMETER
 * (its 10th, 50th and 90th; the lib/stats fit, which is not min/mode/max).
 */
export function distFromPercentiles(q10, q50, q90) {
  const fit = fitTriangularToPercentiles(q10, q50, q90);
  return { type: 'triangular', min: fit.min, mode: fit.mode, max: fit.max, exact: fit.exact, note: fit.note };
}

/** Keys of `spec` that genuinely vary, in the stable UNCERTAIN_PARAMS order. */
export function varyingKeys(spec) {
  return UNCERTAIN_PARAMS.filter((k) => spec && isVariable(spec[k]));
}

/**
 * Draw `n` parameter patches from `spec` with a seeded generator. A patch
 * carries only the varying keys; a normal or lognormal draw outside an
 * optional finite dist.min / dist.max is clamped to that bound.
 *
 * @param {Object<string, Object>} spec { key: dist } in the lib/stats shape
 *   (triangular min/mode/max, uniform min/max, normal or lognormal mean/stdDev)
 * @param {number} n
 * @param {number} [seed=1]
 * @param {Array<{a: string, b: string, rho: number}>} [correlations]
 * @returns {{patches: Array<Object>, varKeys: string[]}}
 */
export function drawRealisations(spec, n, seed = 1, correlations = []) {
  const varKeys = varyingKeys(spec);
  const count = Math.max(1, Math.floor(n) || 1);
  if (!varKeys.length) return { patches: Array.from({ length: count }, () => ({})), varKeys };
  const sampler = createCorrelatedSampler({ inputs: spec, paramOrder: varKeys, correlations, rng: mulberry32(seed >>> 0) });
  const patches = [];
  for (let r = 0; r < count; r++) {
    const { values } = sampler.sample();
    const patch = {};
    for (const key of varKeys) {
      let v = values[key];
      const d = spec[key];
      if (Number.isFinite(d.min) && v < d.min) v = d.min;
      if (Number.isFinite(d.max) && v > d.max) v = d.max;
      patch[key] = v;
    }
    patches.push(patch);
  }
  return { patches, varKeys };
}

/**
 * Quantile of the finite entries (NaN when none): the canonical lib/stats
 * definition (`ss.quantileSorted`) over a typed-array sort, which is the
 * numeric sort without a comparator and an order of magnitude faster than
 * `quantile`'s copy-and-comparator sort at 20000 draws.
 */
export function finiteQuantile(values, q) {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n += 1;
  if (!n) return NaN;
  const kept = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) kept[k++] = values[i];
  kept.sort();
  return ss.quantileSorted(kept, q);
}

const finiteMean = (values) => {
  const kept = values.filter((v) => Number.isFinite(v));
  return kept.length ? statsMean(kept) : NaN;
};

function sliceCurves(curves, i0, i1) {
  const seg = {};
  for (const [key, arr] of Object.entries(curves)) if (arr) seg[key] = arr.slice(i0, i1 + 1);
  return seg;
}

/**
 * Run the probabilistic interpretation.
 *
 * @param {Object} curves {DEPT, GR?, RHOB?, NPHI?, DT?, RT?}
 * @param {Object} params the interpretation's base parameter set
 * @param {Array<{top, base, params}>} zoneParamList per-zone override patches (computeWellZoned's shape)
 * @param {Object<string, Object>} spec distributions per varying parameter
 * @param {Object} [opts]
 * @param {number} [opts.n=200] realisations
 * @param {number} [opts.seed=1]
 * @param {Array} [opts.correlations] [{a, b, rho}] between varying keys
 * @param {Array<{id?, name, top_md_m, base_md_m}>} [opts.zones] zones to summarise
 * @param {number[]} [opts.quantiles] default [0.1, 0.5, 0.9]
 * @param {number} [opts.chunk=2000] samples per depth chunk (memory bound; the result is chunk-invariant)
 * @param {(p: {phase: string, done: number, total: number}) => void} [opts.onProgress]
 * @returns {{curves: Object<string, Float64Array>, zones: Array, draws: Object, quantiles: number[]}}
 */
export function runProbabilistic(curves, params, zoneParamList = [], spec = {}, opts = {}) {
  const {
    n = 200, seed = 1, correlations = [], zones = [], quantiles = DEFAULT_QUANTILES, chunk = 2000, onProgress = null,
  } = opts;
  const base = { ...DEFAULT_PARAMS, ...params };
  const { patches, varKeys } = drawRealisations(spec, n, seed, correlations);
  const R = patches.length;
  const N = curves.DEPT.length;
  const paramsOf = (r) => (varKeys.length ? { ...base, ...patches[r] } : base);
  const zoneList = [...(zoneParamList || [])].sort((a, b) => a.top - b.top);

  // ---- loop 1: per-sample percentile curves, in depth chunks ---------------
  const out = {};
  const ensure = (key) => { if (!out[key]) out[key] = new Float64Array(N).fill(NaN); return out[key]; };
  const step = Math.max(1, Math.floor(chunk) || 2000);
  const buf = new Float64Array(R);
  for (let i0 = 0; i0 < N; i0 += step) {
    const i1 = Math.min(N - 1, i0 + step - 1);
    const seg = sliceCurves(curves, i0, i1);
    const per = []; // per realisation: outputs of this chunk
    for (let r = 0; r < R; r++) per.push(computeWellZoned(seg, paramsOf(r), zoneList).outputs);
    const keys = QUANTILE_CURVES.filter((k) => per.some((o) => o[k]));
    const len = i1 - i0 + 1;
    for (const key of keys) {
      const targets = quantiles.map((q) => ({ q, arr: ensure(`${key}_${quantileSuffix(q)}`) }));
      for (let j = 0; j < len; j++) {
        for (let r = 0; r < R; r++) buf[r] = per[r][key] ? per[r][key][j] : NaN;
        for (const t of targets) t.arr[i0 + j] = finiteQuantile(buf, t.q);
      }
    }
    if (per.some((o) => o.PAY)) {
      const prob = ensure('PAY_PROB');
      for (let j = 0; j < len; j++) {
        let pay = 0;
        let seen = 0;
        for (let r = 0; r < R; r++) {
          const v = per[r].PAY ? per[r].PAY[j] : NaN;
          if (!Number.isFinite(v)) continue;
          seen += 1;
          if (v === 1) pay += 1;
        }
        prob[i0 + j] = seen ? pay / seen : NaN;
      }
    }
    if (onProgress) onProgress({ phase: 'curves', done: i1 + 1, total: N });
  }

  // ---- loop 2: per zone, every realisation through the canonical summary --
  const zoneResults = [];
  const depth = curves.DEPT;
  (zones || []).forEach((zone, zi) => {
    const top = Number(zone.top_md_m ?? zone.top);
    const base_ = Number(zone.base_md_m ?? zone.base);
    let a = 0;
    while (a < N && depth[a] < top) a += 1;
    let b = N - 1;
    while (b >= 0 && depth[b] > base_) b -= 1;
    // one sample of margin each side keeps the midpoint thicknesses of the
    // edge samples identical to the whole-well summary
    const i0 = Math.max(0, a - 1);
    const i1 = Math.min(N - 1, b + 1);
    const seg = sliceCurves(curves, i0, i1);
    const series = {};
    for (const f of [...OUTCOME_FIELDS, ...PARAMETER_FIELDS, 'gross_m']) series[f] = new Float64Array(R).fill(NaN);
    const window = { top_md_m: top, base_md_m: base_ };
    for (let r = 0; r < R; r++) {
      const pr = paramsOf(r);
      const { outputs } = computeWellZoned(seg, pr, zoneList);
      const s = zoneSummary(seg, outputs, pr, window);
      if (!s) continue;
      for (const f of Object.keys(series)) series[f][r] = s[f] == null ? NaN : s[f];
    }
    const outcomes = {};
    for (const f of OUTCOME_FIELDS) {
      outcomes[f] = { p90: finiteQuantile(series[f], 0.1), p50: finiteQuantile(series[f], 0.5), p10: finiteQuantile(series[f], 0.9), mean: finiteMean(Array.from(series[f])) };
    }
    const parameters = {};
    for (const f of PARAMETER_FIELDS) {
      parameters[f] = { q10: finiteQuantile(series[f], 0.1), q50: finiteQuantile(series[f], 0.5), q90: finiteQuantile(series[f], 0.9), mean: finiteMean(Array.from(series[f])), n: Array.from(series[f]).filter(Number.isFinite).length };
    }
    // sensitivity of net pay to the drawn parameters
    let rank = [];
    let tornado = [];
    if (varKeys.length && R >= 2) {
      const inputsByKey = {};
      for (const k of varKeys) inputsByKey[k] = patches.map((p) => p[k]);
      const nets = Array.from(series.net_m, (v) => (Number.isFinite(v) ? v : 0));
      rank = rankCorrelationSensitivity(inputsByKey, nets);
      tornado = tornadoSwings(patches.map((p, r) => ({ targetVol: nets[r], inputs: p })));
    }
    zoneResults.push({
      id: zone.id ?? null, name: zone.name ?? `zone ${zi + 1}`, top_md_m: top, base_md_m: base_,
      n: R, gross_m: finiteQuantile(series.gross_m, 0.5),
      outcomes, parameters, sensitivity: { rank, tornado },
    });
    if (onProgress) onProgress({ phase: 'zones', done: zi + 1, total: zones.length });
  });

  return {
    curves: out,
    zones: zoneResults,
    draws: { n: R, seed, varKeys, patches },
    quantiles: [...quantiles],
    spec: { ...spec },
    correlations: [...correlations],
  };
}

/** The Suite-wide sentence recorded with every published probabilistic outcome. */
export const EXCEEDANCE_DEFINITION = 'P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.';
