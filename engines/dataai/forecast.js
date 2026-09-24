/**
 * Data-driven production forecasting (Data & AI D4).
 *
 * Pure functions, no I/O. A series y is an array of finite numbers, one per
 * time step (a month of production, say), oldest first. Every function
 * returns either a result object carrying a `basis` (the method and its
 * conventions, so a course can print the working) or `{ error, field }`,
 * where `field` names the input refused and the message starts with that
 * name and states the exact condition that failed.
 *
 * Conventions, stated once (FINDINGS-forecast.md has the sources):
 *   methods     'ses' simple exponential smoothing, 'holt' Holt's linear
 *               trend, 'damped' Gardner-McKenzie damped trend, in the
 *               component form of Hyndman and Athanasopoulos (FPP3 8.1-8.2):
 *                 forecast  f_t = l_{t-1} + phi b_{t-1}   (ses: l_{t-1})
 *                 level     l_t = alpha y_t + (1 - alpha) f_t
 *                 trend     b_t = beta (l_t - l_{t-1}) + (1 - beta) phi b_{t-1}
 *               holt is phi = 1; beta is FPP3's beta* (statsmodels
 *               smoothing_trend). h steps ahead from the last state:
 *               ses l_n; holt l_n + h b_n; damped l_n + (phi + ... + phi^h) b_n.
 *   initial     anchored at the FIRST observation (NIST/SEMATECH 6.4.3.1 and
 *               6.4.3.3): l_1 = y_1 (or initialLevel), b_1 = y_2 - y_1 (or
 *               initialTrend). The first forecast is f_2 = l_1 + phi b_1.
 *               With the default trend b_1 = y_2 - y_1, f_2 equals y_2 by
 *               construction (holt; damped differs only by (1 - phi) b_1),
 *               so y_2 is spent on the initialisation and is NOT scored:
 *               scoring starts at t = 3. ses, and holt/damped with an
 *               initialTrend given, score from t = 2. `scoredFrom` is the
 *               0-based index of the first scored value.
 *   fit         minimises the one-step-ahead SSE over the scored errors.
 *               Bounds: alpha and beta in [0, 1], phi in [0.8, 0.98]
 *               (FPP3 8.2 restricts phi to that range when estimated),
 *               all inclusive. A parameter given is held fixed (a fixed
 *               phi may be any value above 0 and at most 1). Stage 1, a
 *               grid: alpha and beta at 0, 0.1, ..., 1, phi at 0.8, 0.85,
 *               0.9, 0.95, 0.98, alpha outermost, then beta, then phi; the
 *               lowest SSE wins, a later point replacing the best only
 *               when its SSE is below best x (1 - 1e-12), so ties keep the
 *               earlier point. Stage 2, compass (pattern) search from
 *               that point: the step starts at 0.05 x each parameter's
 *               range (half the grid spacing); a sweep tries +step then
 *               -step on alpha, beta, phi in turn (clipped to the box, a
 *               trial the clip leaves in place skipped) and moves to the
 *               trial with the lowest SSE if it is strictly below the
 *               current SSE (ties keep the earlier trial); a sweep with no
 *               improvement halves the step. Stops when a sweep at a step
 *               of at most 2^-30 of the range improves nothing (converged),
 *               or after 200,000 SSE evaluations (converged false, with a
 *               warning).
 *   backtest    rolling origin, expanding window: origin o trains on
 *               y[0..o-1] and forecasts y[o..o+H-1]; origins firstOrigin,
 *               firstOrigin + step, ... while o + H <= n, so every origin
 *               has H actuals. refit true re-estimates the free parameters
 *               at every origin; refit false estimates them once on the
 *               first window and holds them.
 *   errors      e = actual - forecast. MAE mean |e|; RMSE sqrt(mean e^2);
 *               ME mean e (bias); MAPE 100 mean |e / y| in percent, reported
 *               as null (with the reason) when any actual is 0; sMAPE
 *               100 mean (2 |e| / (|y| + |f|)), percent on the 0 to 200
 *               scale (Hyndman and Koehler 2006 with absolute values in the
 *               denominator), a term with y = f = 0 scoring 0; MASE mean
 *               |e| / Q with Q the in-sample MAE of the lag-m naive forecast
 *               on the training series, Q = mean |y_t - y_{t-m}|
 *               (Hyndman and Koehler 2006; m = 1 by default), null with the
 *               reason when Q = 0. Pooled backtest metrics average over
 *               every origin and step (MASE: each error scaled by its own
 *               origin's Q).
 *   intervals   residual bootstrap (FPP3 5.5): nSims future paths; at each
 *               step the one-step forecast plus a residual drawn with
 *               replacement from the scored in-sample residuals, index
 *               floor(u x m), u from one mulberry32(seed) stream (lib/stats)
 *               drawn path by path, step by step; the simulated value
 *               updates the state. Per step the 10th, 50th and 90th
 *               percentiles by lib/stats quantile (simple-statistics 7.8.8
 *               rule on the n sorted values, idx = n p: idx not whole gives
 *               the ceil(idx)-th smallest; idx whole and n even the mean of
 *               the idx-th and (idx+1)-th smallest; idx whole and n odd the
 *               (idx+1)-th smallest). Labels follow
 *               lib/conventions/percentile.js: production is an outcome
 *               where more is better, so P90 (low) is the 10th percentile
 *               and P10 (high) the 90th. nonNegative (default true)
 *               reports a negative percentile as 0 and counts it.
 *   Arps        imported from engines/dca/arps.js (fitArpsModel,
 *               calculateArpsHyperbolic); never re-implemented. Step k is
 *               passed as day k, so qi is per step and Di per step.
 *               fitArpsModel drops non-positive rates; its t = 0 is the
 *               first positive value.
 *   ties        compareWithArps ranks by the chosen metric, lowest first;
 *               values within 1e-12 (relative) keep the listed order
 *               (methods as given, arps last).
 *   reasons     figures in messages print as the shortest round-trip decimal.
 *
 * Validation: tools/validation/dataai/oracle_forecast.py (stdlib python)
 * writes test-data/dataai/goldens/forecast_cases.json with the NIST/SEMATECH
 * e-Handbook 6.4.3 examples as published anchors; pin_forecast.py pins
 * statsmodels in test-data/dataai/pins/forecast_pins.json;
 * FINDINGS-forecast.md, negcontrol_forecast.sh.
 */

import { mulberry32, quantile } from '../../lib/stats/stats.js';
import { EXCEEDANCE_DEFINITION, OUTCOME_LABELS } from '../../lib/conventions/percentile.js';
import { fitArpsModel, calculateArpsHyperbolic } from '../dca/arps.js';

export const DEFAULTS = Object.freeze({
  PHI_MIN: 0.8,
  PHI_MAX: 0.98,
  GRID_ALPHA: Object.freeze([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]),
  GRID_PHI: Object.freeze([0.8, 0.85, 0.9, 0.95, 0.98]),
  GRID_TIE_REL: 1e-12,
  PS_STEP: 0.05, // first compass step, as a fraction of each parameter's range (half the grid spacing)
  PS_MIN_STEP: 2 ** -30, // stop once a step of this fraction of the range improves nothing
  PS_MAX_EVALS: 200000,
  MAX_H: 10000,
  MAX_POINTS: 100000,
  N_SIMS: 1000,
  MAX_SIMS: 100000,
  MAX_ORIGINS: 5000,
  RANK_TIE_REL: 1e-12,
});

const METHODS = ['ses', 'holt', 'damped'];
const ARPS_MODELS = ['Auto-Select', 'Exponential', 'Harmonic', 'Hyperbolic'];
const METRIC_KEYS = ['mae', 'rmse', 'mape', 'smape', 'mase'];
const DAY_MS = 86400000;
const ARPS_EPOCH = Date.UTC(2000, 0, 1);

/* ------------------------------------------------------------------ */
/* Helpers. */

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => (x === Infinity ? 'infinity' : x === -Infinity ? 'minus infinity' : String(x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

const checkSeries = (field, y, minLen, why) => {
  if (!Array.isArray(y)) return refuse(field, 'must be an array of numbers');
  if (y.length > DEFAULTS.MAX_POINTS) return refuse(field, `has ${y.length} values, above the ${DEFAULTS.MAX_POINTS} this engine accepts`);
  for (let i = 0; i < y.length; i += 1) if (!isNum(y[i])) return refuse(`${field}[${i}]`, 'must be a finite number: fill or drop missing values first');
  if (y.length < minLen) return refuse(field, `has ${y.length} value${y.length === 1 ? '' : 's'}: ${why}`);
  return null;
};

const checkSeed = (seed) => (isInt(seed) && seed >= 0 && seed <= 4294967295 ? null : refuse('seed', 'must be a whole number from 0 to 4294967295'));

const unitParam = (name, v) => (v === undefined || (isNum(v) && v >= 0 && v <= 1) ? null : refuse(name, 'must be a number from 0 to 1 (inclusive)'));

/** Validates method and the fixed parameters; returns { spec } or { bad }. */
const checkSpec = ({ method, alpha, beta, phi, initialLevel, initialTrend }) => {
  if (!METHODS.includes(method)) return { bad: refuse('method', "must be 'ses', 'holt' or 'damped'") };
  const bad = unitParam('alpha', alpha) || unitParam('beta', beta);
  if (bad) return { bad };
  if (method === 'ses' && beta !== undefined) return { bad: refuse('beta', "applies to 'holt' and 'damped' only: 'ses' has no trend") };
  if (method === 'ses' && initialTrend !== undefined) return { bad: refuse('initialTrend', "applies to 'holt' and 'damped' only: 'ses' has no trend") };
  if (method === 'ses' && phi !== undefined) return { bad: refuse('phi', "applies to 'damped' only: 'ses' has no trend to damp") };
  if (method === 'holt' && phi !== undefined) return { bad: refuse('phi', "applies to 'damped' only: 'holt' is the damped method with phi = 1") };
  if (phi !== undefined && !(isNum(phi) && phi > 0 && phi <= 1)) return { bad: refuse('phi', 'must be a number above 0 and at most 1 when given (when fitted it is searched from 0.8 to 0.98)') };
  if (initialLevel !== undefined && !isNum(initialLevel)) return { bad: refuse('initialLevel', 'must be a finite number when given') };
  if (initialTrend !== undefined && !isNum(initialTrend)) return { bad: refuse('initialTrend', 'must be a finite number when given') };
  return { spec: { method, alpha, beta, phi, initialLevel, initialTrend } };
};

/** Minimum length and the first scored index for a spec. */
const layout = (spec) => {
  if (spec.method === 'ses') return { minLen: 2, scoredFrom: 1, why: "'ses' needs at least 2 (the first sets the level, the second is the first scored forecast)" };
  if (spec.initialTrend !== undefined) return { minLen: 2, scoredFrom: 1, why: `'${spec.method}' with an initialTrend needs at least 2 (the first sets the level, the second is the first scored forecast)` };
  return { minLen: 3, scoredFrom: 2, why: `'${spec.method}' needs at least 3 (the first two set the initial level and trend, the third is the first scored forecast)` };
};

/**
 * The recursions. Returns SSE over t >= scoredFrom and, when `full`, the
 * one-step forecasts and states. Index 0 of level/trend is the initial state.
 */
const run = (y, method, a, b, phi, l1, b1, scoredFrom, full) => {
  const n = y.length;
  const ph = method === 'damped' ? phi : 1;
  const trendOn = method !== 'ses';
  let l = l1;
  let tr = trendOn ? b1 : 0;
  let sse = 0;
  const fitted = full ? new Array(n).fill(null) : null;
  const level = full ? new Array(n) : null;
  const trend = full && trendOn ? new Array(n) : null;
  if (full) { level[0] = l; if (trendOn) trend[0] = tr; }
  for (let t = 1; t < n; t += 1) {
    const f = trendOn ? l + ph * tr : l;
    const e = y[t] - f;
    if (t >= scoredFrom) sse += e * e;
    const ln = a * y[t] + (1 - a) * f;
    if (trendOn) tr = b * (ln - l) + (1 - b) * ph * tr;
    l = ln;
    if (full) { fitted[t] = f; level[t] = l; if (trendOn) trend[t] = tr; }
  }
  return { sse, fitted, level, trend, l, tr };
};

const pointForecast = (method, l, tr, phi, h) => {
  const out = new Array(h);
  if (method === 'ses') { out.fill(l); return out; }
  if (method === 'holt') { for (let j = 1; j <= h; j += 1) out[j - 1] = l + j * tr; return out; }
  let s = 0; let p = 1;
  for (let j = 1; j <= h; j += 1) { p *= phi; s += p; out[j - 1] = l + s * tr; }
  return out;
};

const FREE_ORDER = ['alpha', 'beta', 'phi'];
const bounds = (name) => (name === 'phi' ? [DEFAULTS.PHI_MIN, DEFAULTS.PHI_MAX] : [0, 1]);
const gridOf = (name) => (name === 'phi' ? DEFAULTS.GRID_PHI : DEFAULTS.GRID_ALPHA);

const clip = (x, names) => x.map((v, i) => { const [lo, hi] = bounds(names[i]); return v < lo ? lo : v > hi ? hi : v; });

/**
 * Grid then compass search over the free parameters. `sseOf(values)` takes the
 * free values in FREE_ORDER order.
 */
const optimise = (free, sseOf) => {
  const d = free.length;
  // Stage 1: grid, alpha outermost.
  let best = null; let bestF = Infinity; let evaluations = 0;
  const idx = new Array(d).fill(0);
  for (;;) {
    const x = idx.map((k, i) => gridOf(free[i])[k]);
    const f = sseOf(x); evaluations += 1;
    if (best === null || f < bestF - bestF * DEFAULTS.GRID_TIE_REL) { best = x; bestF = f; }
    let i = d - 1;
    while (i >= 0) { idx[i] += 1; if (idx[i] < gridOf(free[i]).length) break; idx[i] = 0; i -= 1; }
    if (i < 0) break;
  }
  const gridStart = Object.fromEntries(free.map((nm, i) => [nm, best[i]]));
  const gridSse = bestF;
  // Stage 2: compass (pattern) search from the grid point.
  let x = best; let fx = bestF;
  const range = free.map((nm) => bounds(nm)[1] - bounds(nm)[0]);
  let frac = DEFAULTS.PS_STEP; // step as a fraction of each parameter's range
  let moves = 0; let halvings = 0; let converged = false;
  while (evaluations < DEFAULTS.PS_MAX_EVALS) {
    let bx = null; let bf = fx;
    for (let i = 0; i < d; i += 1) {
      for (const sign of [1, -1]) {
        const t = x.slice();
        t[i] = x[i] + sign * frac * range[i];
        const c = clip(t, free);
        if (c[i] === x[i]) continue;
        const f = sseOf(c); evaluations += 1;
        if (f < bf) { bx = c; bf = f; }
      }
    }
    if (bx) { x = bx; fx = bf; moves += 1; continue; }
    if (frac <= DEFAULTS.PS_MIN_STEP) { converged = true; break; }
    frac /= 2; halvings += 1;
  }
  return { x, f: fx, info: { gridStart, gridSse, moves, halvings, finalStep: frac, evaluations, converged } };
};

/** Fits (or evaluates) one spec on y; the spec has been checked. */
const fitCore = (y, spec, h) => {
  const { method } = spec;
  const { scoredFrom } = layout(spec);
  const l1 = spec.initialLevel !== undefined ? spec.initialLevel : y[0];
  const b1 = method === 'ses' ? 0 : (spec.initialTrend !== undefined ? spec.initialTrend : y[1] - y[0]);
  const wanted = method === 'ses' ? ['alpha'] : method === 'holt' ? ['alpha', 'beta'] : ['alpha', 'beta', 'phi'];
  const free = wanted.filter((nm) => spec[nm] === undefined);
  const fixed = wanted.filter((nm) => spec[nm] !== undefined);
  const val = (nm, x) => (spec[nm] !== undefined ? spec[nm] : x[free.indexOf(nm)]);
  const sseOf = (x) => run(y, method, val('alpha', x), val('beta', x), val('phi', x), l1, b1, scoredFrom, false).sse;
  let x = []; let optimiser = null; const warnings = [];
  if (free.length) {
    const o = optimise(free, sseOf);
    x = o.x;
    const atBounds = free.filter((nm, i) => x[i] === bounds(nm)[0] || x[i] === bounds(nm)[1])
      .map((nm) => `${nm} = ${fmt(x[free.indexOf(nm)])}`);
    optimiser = { ...o.info, free, atBounds };
    if (!o.info.converged) warnings.push(`the compass search stopped at ${DEFAULTS.PS_MAX_EVALS} SSE evaluations before its step fell to 2^-30 of the range: the parameters shown are the best point found`);
  }
  const params = Object.fromEntries(wanted.map((nm) => [nm, val(nm, x)]));
  const r = run(y, method, params.alpha, params.beta, params.phi, l1, b1, scoredFrom, true);
  const residuals = r.fitted.map((f, t) => (t >= scoredFrom ? y[t] - f : null));
  const nScored = y.length - scoredFrom;
  return {
    method,
    params,
    fixed,
    free,
    initial: {
      level: l1,
      trend: method === 'ses' ? null : b1,
      rule: `${spec.initialLevel !== undefined ? 'l_1 = initialLevel' : 'l_1 = y_1'}${method === 'ses' ? '' : spec.initialTrend !== undefined ? ', b_1 = initialTrend' : ', b_1 = y_2 - y_1'}`,
    },
    n: y.length,
    scoredFrom,
    nScored,
    sse: r.sse,
    mse: r.sse / nScored,
    fitted: r.fitted,
    residuals,
    level: r.level,
    trend: r.trend,
    forecast: pointForecast(method, r.l, r.tr, params.phi, h),
    optimiser,
    warnings,
    last: { level: r.l, trend: method === 'ses' ? null : r.tr },
  };
};

const methodBasis = (method) => ({
  ses: 'simple exponential smoothing: f_t = l_{t-1}, l_t = alpha y_t + (1 - alpha) f_t; forecast l_n at every step',
  holt: "Holt's linear trend: f_t = l_{t-1} + b_{t-1}, l_t = alpha y_t + (1 - alpha) f_t, b_t = beta (l_t - l_{t-1}) + (1 - beta) b_{t-1}; forecast l_n + h b_n",
  damped: 'damped trend (Gardner and McKenzie 1985): f_t = l_{t-1} + phi b_{t-1}, l_t = alpha y_t + (1 - alpha) f_t, b_t = beta (l_t - l_{t-1}) + (1 - beta) phi b_{t-1}; forecast l_n + (phi + ... + phi^h) b_n',
}[method]);

const FIT_BASIS = 'free parameters minimise the one-step SSE over the scored errors: grid (alpha, beta at 0 to 1 by 0.1; phi at 0.8, 0.85, 0.9, 0.95, 0.98; ties keep the earlier point), then compass search in the box alpha, beta in [0, 1] and phi in [0.8, 0.98] (step from 0.05 of the range, halved when no trial improves, stopping when a step of 2^-30 of the range improves nothing)';

const checkH = (h, min) => (isInt(h) && h >= min && h <= DEFAULTS.MAX_H ? null : refuse('h', `must be a whole number from ${min} to ${DEFAULTS.MAX_H}`));

/* ------------------------------------------------------------------ */
/* Fitting and forecasting. */

/**
 * Fits ses, holt or damped to y. Parameters given are held fixed; the rest
 * are estimated. Returns params, SSE, one-step fitted values, residuals,
 * states, h-step point forecasts and the optimiser's record.
 */
export const fitSmoothing = ({ y, method, alpha, beta, phi, initialLevel, initialTrend, h = 0 } = {}) => {
  const s = checkSpec({ method, alpha, beta, phi, initialLevel, initialTrend });
  if (s.bad) return s.bad;
  const lay = layout(s.spec);
  const bad = checkSeries('y', y, lay.minLen, lay.why) || checkH(h, 0);
  if (bad) return bad;
  const r = fitCore(y, s.spec, h);
  const out = {
    ...r,
    basis: {
      method: methodBasis(method),
      initial: `${r.initial.rule}; errors scored from index ${r.scoredFrom} (0-based), ${r.nScored} of them`,
      fit: r.free.length ? FIT_BASIS : 'all parameters given: no estimation',
      mse: 'SSE / number of scored errors',
    },
  };
  delete out.last;
  if (!out.warnings.length) delete out.warnings;
  return out;
};

/* ------------------------------------------------------------------ */
/* Accuracy. */

/** Metrics of one set of errors; q is the MASE scale (or null with a reason). */
const metricsOf = (actual, forecast, qs, qReason, where) => {
  const n = actual.length;
  let sa = 0; let s2 = 0; let se = 0; let sp = 0; let ss = 0; let sm = 0;
  let mapeReason = null;
  for (let i = 0; i < n; i += 1) {
    const e = actual[i] - forecast[i];
    sa += Math.abs(e); s2 += e * e; se += e;
    if (actual[i] === 0) { if (mapeReason === null) mapeReason = `MAPE is undefined: ${where(i)} is 0 and MAPE divides by each actual`; } else sp += Math.abs(e / actual[i]);
    const den = Math.abs(actual[i]) + Math.abs(forecast[i]);
    ss += den === 0 ? 0 : (2 * Math.abs(e)) / den;
    if (qs) sm += Math.abs(e) / qs[i];
  }
  const notes = {};
  if (mapeReason) notes.mape = mapeReason;
  if (qReason) notes.mase = qReason;
  return {
    n,
    me: se / n,
    mae: sa / n,
    rmse: Math.sqrt(s2 / n),
    mape: mapeReason ? null : (100 * sp) / n,
    smape: (100 * ss) / n,
    mase: qReason ? null : sm / n,
    notes,
  };
};

/** In-sample naive MAE at lag m on a training series; { q } or { reason }. */
const naiveScale = (train, m, label) => {
  if (train.length <= m) return { reason: `MASE is undefined: ${label} has ${train.length} value${train.length === 1 ? '' : 's'}, so the lag-${m} naive forecast has no in-sample error (it needs more than ${m})` };
  let s = 0;
  for (let t = m; t < train.length; t += 1) s += Math.abs(train[t] - train[t - m]);
  if (s === 0) return { reason: `MASE is undefined: the lag-${m} naive forecast has zero in-sample error on the ${train.length} values of ${label} (every y[t] - y[t - ${m}] is 0), so the scale is 0` };
  return { q: s / (train.length - m) };
};

const METRICS_BASIS = {
  errors: 'e = actual - forecast',
  me: 'mean e (bias; positive means the forecast is low)',
  mae: 'mean |e|',
  rmse: 'sqrt(mean e^2)',
  mape: '100 x mean |e / actual| (percent); null when any actual is 0',
  smape: '100 x mean 2|e| / (|actual| + |forecast|), percent on 0 to 200; a term with actual = forecast = 0 scores 0',
  mase: 'mean |e| / Q, Q = mean |y_t - y_{t-m}| over the in-sample (training) series (Hyndman and Koehler 2006); null when Q = 0',
};

/**
 * Accuracy of a forecast against actuals. `insample` (the training series)
 * scales MASE; without it MASE is null with the reason.
 */
export const accuracy = ({ actual, forecast, insample, m = 1 } = {}) => {
  const bad = checkSeries('actual', actual, 1, 'at least 1 actual is needed')
    || checkSeries('forecast', forecast, 1, 'at least 1 forecast is needed');
  if (bad) return bad;
  if (forecast.length !== actual.length) return refuse('forecast', `must have ${actual.length} values, one per actual (it has ${forecast.length})`);
  if (!isInt(m) || m < 1) return refuse('m', 'must be a whole number, 1 or more (1 is the non-seasonal naive; 12 is a monthly seasonal naive)');
  let qs = null; let qReason = null; let scale = null;
  if (insample === undefined) qReason = 'MASE needs insample (the training series) to scale by its in-sample naive error';
  else {
    const b2 = checkSeries('insample', insample, 1, 'at least 1 value is needed');
    if (b2) return b2;
    const r = naiveScale(insample, m, 'insample');
    if (r.reason) qReason = r.reason; else { scale = r.q; qs = new Array(actual.length).fill(r.q); }
  }
  const out = metricsOf(actual, forecast, qs, qReason, (i) => `actual[${i}]`);
  out.maseScale = scale;
  out.m = m;
  out.basis = METRICS_BASIS;
  if (!Object.keys(out.notes).length) delete out.notes;
  return out;
};

/* ------------------------------------------------------------------ */
/* Bootstrap intervals. */

/**
 * Point forecasts and residual-bootstrap percentiles h steps ahead. The
 * model is fitted on y as fitSmoothing (parameters given are fixed).
 */
export const forecastIntervals = ({ y, method, alpha, beta, phi, initialLevel, initialTrend, h, nSims = DEFAULTS.N_SIMS, seed, nonNegative = true } = {}) => {
  const s = checkSpec({ method, alpha, beta, phi, initialLevel, initialTrend });
  if (s.bad) return s.bad;
  const lay = layout(s.spec);
  const bad = checkSeries('y', y, lay.minLen, lay.why) || checkH(h, 1);
  if (bad) return bad;
  if (!isInt(nSims) || nSims < 1 || nSims > DEFAULTS.MAX_SIMS) return refuse('nSims', `must be a whole number from 1 to ${DEFAULTS.MAX_SIMS}`);
  const bs = checkSeed(seed);
  if (bs) return bs;
  if (typeof nonNegative !== 'boolean') return refuse('nonNegative', 'must be true or false');
  const r = fitCore(y, s.spec, h);
  const pool = r.residuals.slice(r.scoredFrom);
  if (pool.length < 2) return refuse('y', `has ${y.length} values, which leave ${pool.length} scored residual: the bootstrap resamples at least 2, so '${method}' needs at least ${r.scoredFrom + 2} values here`);
  const { alpha: a, beta: b, phi: ph0 } = r.params;
  const ph = method === 'damped' ? ph0 : 1;
  const trendOn = method !== 'ses';
  const rng = mulberry32(seed);
  const m = pool.length;
  const paths = Array.from({ length: h }, () => new Float64Array(nSims));
  for (let k = 0; k < nSims; k += 1) {
    let l = r.last.level; let tr = trendOn ? r.last.trend : 0;
    for (let j = 0; j < h; j += 1) {
      const f = trendOn ? l + ph * tr : l;
      const ys = f + pool[Math.floor(rng() * m)];
      paths[j][k] = ys;
      const ln = a * ys + (1 - a) * f;
      if (trendOn) tr = b * (ln - l) + (1 - b) * ph * tr;
      l = ln;
    }
  }
  const p90 = []; const p50 = []; const p10 = []; let clipped = 0;
  const keep = (v) => { if (nonNegative && v < 0) { clipped += 1; return 0; } return v; };
  for (let j = 0; j < h; j += 1) {
    const [q10, q50, q90] = quantile(Array.from(paths[j]), [0.1, 0.5, 0.9]);
    p90.push(keep(q10)); p50.push(keep(q50)); p10.push(keep(q90));
  }
  const out = {
    method,
    params: r.params,
    forecast: r.forecast,
    [OUTCOME_LABELS.p90]: p90,
    [OUTCOME_LABELS.p50]: p50,
    [OUTCOME_LABELS.p10]: p10,
    nSims,
    seed,
    poolSize: m,
    clippedToZero: clipped,
    definition: EXCEEDANCE_DEFINITION,
    basis: {
      method: methodBasis(method),
      fit: r.free.length ? FIT_BASIS : 'all parameters given: no estimation',
      bootstrap: `${nSims} paths; each step adds a residual drawn with replacement from the ${m} scored in-sample residuals (index floor(u x ${m}), u from mulberry32(${seed}), path by path, step by step) to the one-step forecast, and the simulated value updates the state`,
      percentiles: 'per step, lib/stats quantile at 0.1, 0.5, 0.9 of the simulated values (idx = nSims x p on the sorted values: idx not whole takes the ceil(idx)-th smallest, idx whole with nSims even the mean of the idx-th and (idx+1)-th, idx whole with nSims odd the (idx+1)-th); production is an outcome where more is better, so P90 (low) is the 10th percentile and P10 (high) the 90th',
      nonNegative: nonNegative ? 'a negative percentile is reported as 0 (clippedToZero counts them)' : 'percentiles reported as simulated, negatives included',
    },
  };
  if (r.warnings.length) out.warnings = r.warnings;
  return out;
};

/* ------------------------------------------------------------------ */
/* Backtests. */

const checkBacktest = (y, minTrain, firstOrigin, horizon, step, what) => {
  if (!isInt(horizon) || horizon < 1) return refuse('horizon', 'must be a whole number, 1 or more');
  if (!isInt(step) || step < 1) return refuse('step', 'must be a whole number, 1 or more');
  const hi = y.length - horizon;
  if (hi < minTrain) return refuse('y', `has ${y.length} values: a backtest with horizon ${horizon} needs at least ${minTrain + horizon} (${what} needs ${minTrain} training values, then ${horizon} actuals)`);
  if (!isInt(firstOrigin) || firstOrigin < minTrain || firstOrigin > hi) return refuse('firstOrigin', `must be a whole number from ${minTrain} to ${hi} (${what} needs ${minTrain} training values; an origin above ${hi} leaves fewer than ${horizon} actuals)`);
  const count = Math.floor((hi - firstOrigin) / step) + 1;
  if (count > DEFAULTS.MAX_ORIGINS) return refuse('step', `gives ${count} origins, above the ${DEFAULTS.MAX_ORIGINS} a backtest accepts: raise step or firstOrigin`);
  return null;
};

const originsOf = (n, firstOrigin, horizon, step) => {
  const o = [];
  for (let k = firstOrigin; k + horizon <= n; k += step) o.push(k);
  return o;
};

/** Pools per-origin forecasts into overall and by-horizon metrics. */
const pool = (rows, horizon, m) => {
  const A = []; const Fc = []; const Q = []; const where = []; let qReason = null;
  const byH = Array.from({ length: horizon }, () => ({ A: [], F: [], Q: [], where: [] }));
  rows.forEach((r) => {
    if (r.maseScale === null && qReason === null) qReason = `MASE is undefined: at origin ${r.origin} ${r.maseNote.replace(/^MASE is undefined: /, '')}`;
    r.actual.forEach((v, j) => {
      A.push(v); Fc.push(r.forecast[j]); Q.push(r.maseScale); where.push(`the actual at index ${r.origin + j} (origin ${r.origin}, step ${j + 1})`);
      byH[j].A.push(v); byH[j].F.push(r.forecast[j]); byH[j].Q.push(r.maseScale); byH[j].where.push(`the actual at index ${r.origin + j} (origin ${r.origin}, step ${j + 1})`);
    });
  });
  const tidy = (x) => { if (!Object.keys(x.notes).length) delete x.notes; return x; };
  const overall = tidy(metricsOf(A, Fc, qReason ? null : Q, qReason, (i) => where[i]));
  const byHorizon = byH.map((g, j) => ({ step: j + 1, ...tidy(metricsOf(g.A, g.F, qReason ? null : g.Q, qReason, (i) => g.where[i])) }));
  return { overall, byHorizon, m };
};

const backtestCore = (y, spec, firstOrigin, horizon, step, refit, m) => {
  const origins = originsOf(y.length, firstOrigin, horizon, step);
  let held = null;
  const rows = origins.map((o, idx) => {
    const train = y.slice(0, o);
    let sp = spec;
    if (!refit && idx > 0) sp = { ...spec, ...held };
    const r = fitCore(train, sp, horizon);
    if (!refit && idx === 0) held = r.params;
    const actual = y.slice(o, o + horizon);
    const sc = naiveScale(train, m, `the ${o} training values`);
    const errors = actual.map((v, j) => v - r.forecast[j]);
    return {
      origin: o, trainN: o, params: r.params, converged: r.optimiser ? r.optimiser.converged : null,
      forecast: r.forecast, actual, errors,
      maseScale: sc.reason ? null : sc.q, maseNote: sc.reason || null,
    };
  });
  return { origins, rows };
};

/**
 * Rolling-origin (expanding window) backtest of one smoothing method.
 * Parameters given are held fixed at every origin.
 */
export const backtest = ({ y, method, firstOrigin, horizon, step = 1, refit = true, alpha, beta, phi, m = 1 } = {}) => {
  const s = checkSpec({ method, alpha, beta, phi });
  if (s.bad) return s.bad;
  const lay = layout(s.spec);
  const b1 = checkSeries('y', y, 1, 'at least 1 value is needed');
  if (b1) return b1;
  if (typeof refit !== 'boolean') return refuse('refit', 'must be true or false');
  if (!isInt(m) || m < 1) return refuse('m', 'must be a whole number, 1 or more (1 is the non-seasonal naive; 12 is a monthly seasonal naive)');
  const bad = checkBacktest(y, lay.minLen, firstOrigin, horizon, step, `'${method}'`);
  if (bad) return bad;
  const { origins, rows } = backtestCore(y, s.spec, firstOrigin, horizon, step, refit, m);
  const warnings = rows.filter((r) => r.converged === false).map((r) => `origin ${r.origin}: the compass search stopped at ${DEFAULTS.PS_MAX_EVALS} SSE evaluations`);
  const out = {
    method, firstOrigin, horizon, step, refit, origins,
    perOrigin: rows.map(({ maseNote, converged, ...r }) => r),
    ...pool(rows, horizon, m),
    basis: {
      method: methodBasis(method),
      origins: `expanding window: origin o trains on y[0..o-1] and forecasts y[o..o+${horizon - 1}]; origins ${firstOrigin}, ${firstOrigin} + ${step}, ... while o + ${horizon} <= ${y.length}`,
      refit: refit ? 'free parameters re-estimated at every origin' : 'free parameters estimated on the first window and held at every later origin',
      metrics: METRICS_BASIS,
      pooling: `overall metrics average over every origin and step; MASE scales each error by its own origin's lag-${m} naive in-sample MAE`,
    },
  };
  if (warnings.length) out.warnings = warnings;
  return out;
};

/* ------------------------------------------------------------------ */
/* Arps baseline (engines/dca/arps.js). */

const arpsFit = (y, modelType, subject, plural) => {
  const data = y.map((rate, k) => ({ date: new Date(ARPS_EPOCH + k * DAY_MS).toISOString(), rate }));
  const firstPos = y.findIndex((v) => v > 0);
  const nPos = y.filter((v) => v > 0).length;
  if (nPos < 3) return { reason: `${subject} ${plural ? 'have' : 'has'} ${nPos} positive value${nPos === 1 ? '' : 's'}: fitArpsModel needs at least 3 (it drops zero and negative rates)` };
  const fit = fitArpsModel(data, modelType);
  const p = fit.parameters;
  if (!p || p.modelType === 'None') return { reason: `${subject} ${plural ? 'give' : 'gives'} no Arps fit: fitArpsModel found no ${modelType === 'Auto-Select' ? 'exponential, harmonic or hyperbolic' : modelType.toLowerCase()} fit with finite qi > 0 and Di > 0 on the ${nPos} positive values (a least-squares line through the rates on the log, reciprocal or q^-b scale that shows no decline gives Di <= 0)` };
  return { fit, p, t0: firstPos, nPos };
};

const arpsAt = (p, t0, k) => calculateArpsHyperbolic(p.qi, p.Di, p.b, k - t0);

/**
 * Arps decline baseline by engines/dca/arps.js fitArpsModel. Step k is day
 * k; non-positive values are dropped by fitArpsModel.
 */
export const arpsForecast = ({ y, h = 0, modelType = 'Auto-Select' } = {}) => {
  const bad = checkSeries('y', y, 3, 'fitArpsModel needs at least 3 positive values') || checkH(h, 0);
  if (bad) return bad;
  if (!ARPS_MODELS.includes(modelType)) return refuse('modelType', "must be 'Auto-Select', 'Exponential', 'Harmonic' or 'Hyperbolic'");
  const a = arpsFit(y, modelType, 'y', false);
  if (a.reason) return { error: a.reason, field: 'y' };
  const { p, t0, fit } = a;
  const out = {
    modelType: p.modelType,
    requested: modelType,
    qi: p.qi,
    Di: p.Di,
    b: p.b,
    R2: fit.R2,
    RMSE: fit.RMSE,
    t0Index: t0,
    nUsed: a.nPos,
    dropped: y.length - a.nPos,
    fitted: y.map((_, k) => (k >= t0 ? arpsAt(p, t0, k) : null)),
    forecast: Array.from({ length: h }, (_, j) => arpsAt(p, t0, y.length + j)),
    basis: {
      engine: 'engines/dca/arps.js fitArpsModel (exponential by log-linear regression, harmonic by 1/q regression, hyperbolic by a b grid from 0.05 by 0.05 to 2 on q^-b; Auto-Select takes the lowest RMSE) and calculateArpsHyperbolic',
      time: `step k is passed as day k, so qi is per step and Di per step; t = 0 at index ${t0}, the first positive value`,
      dropped: 'fitArpsModel drops zero and negative values (shut-in months) before fitting',
    },
  };
  return out;
};

/**
 * Backtests the smoothing methods and the Arps baseline on the same
 * origins with the same metrics, and ranks them.
 */
export const compareWithArps = ({ y, methods = ['ses', 'holt', 'damped'], firstOrigin, horizon, step = 1, refit = true, arpsModel = 'Auto-Select', rankBy = 'mase', m = 1 } = {}) => {
  const b1 = checkSeries('y', y, 1, 'at least 1 value is needed');
  if (b1) return b1;
  if (!Array.isArray(methods) || methods.length < 1) return refuse('methods', "must be a non-empty array of 'ses', 'holt' and 'damped'");
  for (let i = 0; i < methods.length; i += 1) {
    if (!METHODS.includes(methods[i])) return refuse(`methods[${i}]`, "must be 'ses', 'holt' or 'damped'");
    if (methods.indexOf(methods[i]) !== i) return refuse(`methods[${i}]`, `repeats ${methods[i]}`);
  }
  if (!ARPS_MODELS.includes(arpsModel)) return refuse('arpsModel', "must be 'Auto-Select', 'Exponential', 'Harmonic' or 'Hyperbolic'");
  if (!METRIC_KEYS.includes(rankBy)) return refuse('rankBy', "must be 'mae', 'rmse', 'mape', 'smape' or 'mase'");
  if (typeof refit !== 'boolean') return refuse('refit', 'must be true or false');
  if (!isInt(m) || m < 1) return refuse('m', 'must be a whole number, 1 or more (1 is the non-seasonal naive; 12 is a monthly seasonal naive)');
  const minTrain = Math.max(3, ...methods.map((mt) => layout({ method: mt }).minLen));
  const bad = checkBacktest(y, minTrain, firstOrigin, horizon, step, 'the comparison');
  if (bad) return bad;
  const rows = methods.map((mt) => {
    const bt = backtestCore(y, { method: mt }, firstOrigin, horizon, step, refit, m);
    return { method: mt, origins: bt.origins, perOrigin: bt.rows, ...pool(bt.rows, horizon, m).overall };
  });
  // Arps on the same origins (always refitted: the fit is a regression on the window).
  const origins = originsOf(y.length, firstOrigin, horizon, step);
  const arpsRows = []; let arpsError = null;
  for (let i = 0; i < origins.length && !arpsError; i += 1) {
    const o = origins[i];
    const train = y.slice(0, o);
    const a = arpsFit(train, arpsModel, `at origin ${o} the ${o} training values`, true);
    if (a.reason) { arpsError = a.reason; break; }
    const forecast = Array.from({ length: horizon }, (_, j) => arpsAt(a.p, a.t0, o + j));
    const actual = y.slice(o, o + horizon);
    const sc = naiveScale(train, m, `the ${o} training values`);
    arpsRows.push({ origin: o, trainN: o, params: { qi: a.p.qi, Di: a.p.Di, b: a.p.b, modelType: a.p.modelType }, forecast, actual, errors: actual.map((v, j) => v - forecast[j]), maseScale: sc.reason ? null : sc.q, maseNote: sc.reason || null });
  }
  const arpsRow = arpsError
    ? { method: 'arps', error: arpsError, mae: null, rmse: null, mape: null, smape: null, mase: null }
    : { method: 'arps', origins, perOrigin: arpsRows, ...pool(arpsRows, horizon, m).overall };
  const all = [...rows, arpsRow].map((r) => {
    const { perOrigin, ...rest } = r;
    return { ...rest, perOrigin: perOrigin ? perOrigin.map(({ maseNote, converged, ...q }) => q) : undefined };
  });
  all.forEach((r) => { if (r.perOrigin === undefined) delete r.perOrigin; if (r.notes && !Object.keys(r.notes).length) delete r.notes; });
  // Rank: lowest first; within 1e-12 relative keeps listed order; null metrics unranked.
  const ranked = all.map((r, i) => ({ i, v: r[rankBy] })).filter((x) => x.v !== null && x.v !== undefined);
  const ordered = [];
  const left = ranked.slice();
  while (left.length) {
    let bi = 0;
    for (let k = 1; k < left.length; k += 1) {
      const a = left[k].v; const b = left[bi].v;
      if (a < b - Math.abs(b) * DEFAULTS.RANK_TIE_REL) bi = k;
    }
    ordered.push(left[bi].i); left.splice(bi, 1);
  }
  const ranking = ordered.map((i) => all[i].method);
  return {
    firstOrigin, horizon, step, refit, arpsModel, rankBy, origins,
    rows: all,
    ranking,
    best: ranking.length ? ranking[0] : null,
    unranked: all.filter((r) => r[rankBy] === null).map((r) => r.method),
    basis: {
      origins: `the same expanding-window origins for every method: ${firstOrigin}, ${firstOrigin} + ${step}, ... while o + ${horizon} <= ${y.length}`,
      arps: 'engines/dca/arps.js fitArpsModel refitted on each training window (step k as day k; zero and negative values dropped by fitArpsModel), forecasts by calculateArpsHyperbolic',
      metrics: METRICS_BASIS,
      ranking: `lowest ${rankBy} first; values within 1e-12 (relative) keep the listed order (methods as given, arps last); a method whose ${rankBy} is null is left unranked`,
    },
  };
};
