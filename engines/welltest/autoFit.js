/**
 * Automatic model matching: Levenberg-Marquardt regression of a catalog
 * model onto observed test data, fitting pressure change and Bourdet
 * derivative simultaneously in log space (the standard PTA practice; log
 * residuals weight early- and late-time data evenly across the decades of a
 * log-log plot).
 *
 * Parameters flagged logScale in the catalog metadata are fitted as log10
 * values, which enforces positivity and makes their confidence intervals
 * multiplicative, the natural form for k and C.
 */

import { levenbergMarquardt } from './lmFit.js';
import { bourdetDerivative } from './derivative.js';
import { evaluateModelTest } from './models/modelCatalog.js';
import { agarwalEquivalentTime } from './superposition.js';

const PENALTY = 5; // log-space residual charged where a model value is invalid

const encodeParams = (model, params) =>
  model.parameters.map((meta) => {
    const v = params[meta.key] ?? meta.default;
    return meta.logScale ? Math.log10(Math.max(v, meta.min)) : v;
  });

const decodeParams = (model, theta) =>
  Object.fromEntries(
    model.parameters.map((meta, i) => [
      meta.key,
      meta.logScale ? Math.pow(10, theta[i]) : theta[i],
    ])
  );

const encodedBounds = (model) =>
  model.parameters.map((meta) =>
    meta.logScale ? [Math.log10(meta.min), Math.log10(meta.max)] : [meta.min, meta.max]
  );

const logResidual = (modelValue, dataValue) => {
  if (!(modelValue > 0) || !(dataValue > 0)) return PENALTY;
  const r = Math.log(modelValue / dataValue);
  return Number.isFinite(r) ? r : PENALTY;
};

/**
 * Fit a catalog model to observed data.
 *
 * @param {object} args
 * @param {object} args.model catalog entry (getModel(...))
 * @param {'drawdown'|'buildup'} [args.testType='drawdown']
 * @param {Array<{t?:number, dt?:number, dp:number}>} args.data observed
 *   pressure change vs elapsed (drawdown) or shut-in (buildup) time, hours
 * @param {object} args.reservoir { phi, mu, ct, rw, h, B, q, pi }
 * @param {number} [args.tp] producing time, required for buildup
 * @param {object} [args.initialParams] starting values (defaults from catalog)
 * @param {number} [args.derivativeWeight=1] relative weight of derivative
 *   residuals vs pressure residuals
 * @param {number} [args.smoothingL=0.1] Bourdet window, log10 cycles
 * @param {(iter:number, ssr:number)=>void} [args.onIteration]
 * @returns {{ params, confidence95, ssr, iterations, converged, fitSeries }}
 */
export const autoFitModel = ({
  model,
  testType = 'drawdown',
  data,
  reservoir,
  tp,
  initialParams = {},
  derivativeWeight = 1,
  smoothingL = 0.1,
  onIteration,
}) => {
  const isBuildup = testType === 'buildup';
  const observed = (data || [])
    .map((p) => ({ time: Number(isBuildup ? p.dt : p.t), dp: Number(p.dp) }))
    .filter((p) => p.time > 0 && Number.isFinite(p.dp))
    .sort((a, b) => a.time - b.time);
  if (observed.length < 5) return null;

  const times = observed.map((p) => p.time);
  // derivative abscissa: elapsed time for drawdown, Agarwal equivalent time
  // for buildup (identical transform applied to data and model)
  const abscissa = isBuildup
    ? times.map((dt) => agarwalEquivalentTime(tp, dt))
    : times;

  const derivativeOf = (dps) =>
    bourdetDerivative(
      dps.map((dp, i) => ({ x: abscissa[i], y: dp })),
      { L: smoothingL }
    ).map((p) => p.derivative);

  const observedDeriv = derivativeOf(observed.map((p) => p.dp));

  const residualsFor = (theta) => {
    const params = decodeParams(model, theta);
    const series = evaluateModelTest({
      testType,
      model,
      params,
      reservoir,
      tp,
      times,
      dts: times,
    });
    const modelDp = series.map((p) => p.dp);
    const modelDeriv = derivativeOf(modelDp);
    const residuals = [];
    for (let i = 0; i < observed.length; i += 1) {
      residuals.push(logResidual(modelDp[i], observed[i].dp));
    }
    if (derivativeWeight > 0) {
      for (let i = 0; i < observed.length; i += 1) {
        if (Number.isFinite(observedDeriv[i]) && observedDeriv[i] > 0) {
          residuals.push(derivativeWeight * logResidual(modelDeriv[i], observedDeriv[i]));
        }
      }
    }
    return residuals;
  };

  const theta0 = encodeParams(model, { ...Object.fromEntries(model.parameters.map((m) => [m.key, m.default])), ...initialParams });
  const fit = levenbergMarquardt(residualsFor, theta0, {
    bounds: encodedBounds(model),
    onIteration,
  });

  const params = decodeParams(model, fit.theta);
  const confidence95 = Object.fromEntries(
    model.parameters.map((meta, i) => {
      const [lo, hi] = fit.confidence95[i];
      return [
        meta.key,
        meta.logScale ? [Math.pow(10, lo), Math.pow(10, hi)] : [lo, hi],
      ];
    })
  );
  const fitSeries = evaluateModelTest({
    testType,
    model,
    params,
    reservoir,
    tp,
    times,
    dts: times,
  });

  return {
    params,
    confidence95,
    ssr: fit.ssr,
    iterations: fit.iterations,
    converged: fit.converged,
    fitSeries,
  };
};
