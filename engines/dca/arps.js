// Arps decline-curve engine: forward models, OLS fitting with standard
// errors, EUR, forecast generation. Extracted verbatim from the Suite's
// src/utils/declineCurve/dcaEngine.js (browser export helpers stayed behind).


// --- Helpers ---
function linearRegressionWithSE(xs, ys) {
  // Linear regression that ALSO returns standard errors of slope and intercept.
  // These are needed for confidence interval propagation.
  if (xs.length !== ys.length || xs.length < 3) {
    return { slope: 0, intercept: 0, r2: 0, seSlope: 0, seIntercept: 0, n: xs.length };
  }
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - meanX) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  if (sxx === 0) return { slope: 0, intercept: meanY, r2: 0, seSlope: Infinity, seIntercept: Infinity, n };
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  // Residual variance (MSE), with n-2 denominator
  let sse = 0;
  for (let i = 0; i < n; i++) {
    sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  }
  const mse = n > 2 ? sse / (n - 2) : sse;
  const seSlope = Math.sqrt(mse / sxx);
  const seIntercept = Math.sqrt(mse * (1/n + (meanX ** 2) / sxx));
  // R² on the regression scale
  let sst = 0;
  for (let i = 0; i < n; i++) sst += (ys[i] - meanY) ** 2;
  const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
  return { slope, intercept, r2, seSlope, seIntercept, n, mse };
}

function linearRegression(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) {
    return { slope: 0, intercept: 0, r2: 0 };
  }
  
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
  const sumXX = xs.reduce((sum, x) => sum + x * x, 0);
  const sumYY = ys.reduce((sum, y) => sum + y * y, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  // Calculate R-squared
  const meanY = sumY / n;
  const ssRes = ys.reduce((sum, y, i) => sum + Math.pow(y - (intercept + slope * xs[i]), 2), 0);
  const ssTot = ys.reduce((sum, y) => sum + Math.pow(y - meanY, 2), 0);
  const r2 = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;
  
  return { slope, intercept, r2 };
}

// --- Forward Models (PRESERVED EXACTLY AS-IS) ---

/**
 * Arps Hyperbolic Decline Rate Equation
 * q(t) = qi / (1 + b * Di * t)^(1/b)
 * @param {number} qi - Initial rate [units/time]
 * @param {number} Di - Initial decline rate [1/time]
 * @param {number} b - Decline exponent [dimensionless] 
 * @param {number} t - Time [same units as Di]
 * @returns {number} Rate at time t
 */
export const calculateArpsHyperbolic = (qi, Di, b, t) => {
  if (qi <= 0 || Di < 0 || t < 0) return 0;
  if (b <= 0) return qi * Math.exp(-Di * t); // Exponential case
  return qi / Math.pow(1 + b * Di * t, 1/b);
};

/**
 * Arps Exponential Decline Rate Equation  
 * q(t) = qi * exp(-Di * t)
 * @param {number} qi - Initial rate [units/time]
 * @param {number} Di - Decline rate [1/time]
 * @param {number} t - Time [same units as Di]
 * @returns {number} Rate at time t
 */
export const calculateArpsExponential = (qi, Di, t) => {
  if (qi <= 0 || Di < 0 || t < 0) return 0;
  return qi * Math.exp(-Di * t);
};

/**
 * Calculate EUR using Arps decline equations
 * @param {number} qi - Initial rate [units/time]
 * @param {number} Di - Initial decline rate [1/time] 
 * @param {number} b - Decline exponent [dimensionless]
 * @param {number} qLimit - Economic limit rate [units/time]
 * @param {string} modelType - 'exponential', 'hyperbolic', or 'harmonic'
 * @returns {number} Estimated Ultimate Recovery [units]
 */
export const calculateEUR = (qi, Di, b, qLimit, modelType = 'hyperbolic') => {
  if (qi <= qLimit || Di <= 0) return 0;
  
  try {
    if (modelType === 'exponential' || b === 0) {
      // EUR = (qi - qLimit) / Di
      return (qi - qLimit) / Di;
    } else if (modelType === 'harmonic' || Math.abs(b - 1) < 0.001) {
      // EUR = (qi / Di) * ln(qi / qLimit)
      return (qi / Di) * Math.log(qi / qLimit);
    } else {
      // Hyperbolic: EUR = (qi^b / (Di * (1 - b))) * (qi^(1-b) - qLimit^(1-b))
      // (Arps 1945 rate-cumulative relation. SC1 oracle fix 2026-07-18: this
      // divided by (b - 1), returning a NEGATIVE EUR for every b != 1 — pinned
      // by dcaEngine.oracle.test.js against the closed form, an independent
      // Simpson quadrature, and a hand-arithmetic case.)
      if (Math.abs(b - 1) < 0.001) return calculateEUR(qi, Di, 1, qLimit, 'harmonic');
      const term1 = Math.pow(qi, b) / (Di * (1 - b));
      const term2 = Math.pow(qi, 1 - b) - Math.pow(qLimit, 1 - b);
      return term1 * term2;
    }
  } catch (e) {
    console.error('EUR calculation error:', e);
    return 0;
  }
};

// --- Modified hyperbolic: a terminal (minimum) decline Dmin ---
//
// A hyperbolic decline's nominal decline falls with time,
// D(t) = Di / (1 + b Di t), and for b near or above 1 it falls so far that
// the curve never reaches a sensible economic limit. Practice (CED P03-004,
// "Hyperbolic to Exponential Decline"; the modified hyperbolic of ARIES,
// PHDwin, Harmony and whitson+) switches to an exponential decline at a
// chosen minimum decline Dmin: the curve is hyperbolic until D(t) = Dmin and
// exponential at Dmin after, so the rate and its slope are continuous at the
// switch.
//
// Dmin is NOMINAL, in the same time unit as Di (per day in this domain). A
// minimum decline stated as an effective annual decline De converts to the
// exponential's nominal through Dmin = -ln(1 - De) / (days in a year); the
// caller does that and states the basis.
//
// It applies to curves with b > 0 (hyperbolic and harmonic). An exponential
// curve already declines at a constant rate and is left unchanged. When the
// curve's initial decline is already at or below Dmin, the decline never
// rises to meet it: the curve is exponential at Dmin from the start
// (fromStart), so the decline is never below the stated minimum.

export const terminalDeclineApplies = (b, Dmin) =>
  Number.isFinite(b) && b > 0 && Number.isFinite(Dmin) && Dmin > 0;

// Cumulative of the plain hyperbolic or harmonic curve from 0 to t.
function hyperbolicCumulative(qi, Di, b, t) {
  if (!(t > 0) || !(qi > 0)) return 0;
  if (!(Di > 0)) return qi * t;
  if (Math.abs(b - 1) < 1e-9) return (qi / Di) * Math.log(1 + Di * t);
  return (qi / ((1 - b) * Di)) * (1 - Math.pow(1 + b * Di * t, (b - 1) / b));
}

/**
 * Where a modified hyperbolic switches to its exponential tail.
 * @returns {null | {tSwitch, qSwitch, npSwitch, Dmin, fromStart}} null when
 *   the terminal decline does not apply (b = 0, or no Dmin).
 */
export const modifiedHyperbolicSwitch = (qi, Di, b, Dmin) => {
  if (!terminalDeclineApplies(b, Dmin) || !(qi > 0) || !(Di >= 0)) return null;
  if (Di <= Dmin) return { tSwitch: 0, qSwitch: qi, npSwitch: 0, Dmin, fromStart: true };
  // D(t) = Di / (1 + b Di t) = Dmin
  const tSwitch = (Di / Dmin - 1) / (b * Di);
  // q = qi (1 + b Di t)^(-1/b) with 1 + b Di t = Di / Dmin
  const qSwitch = qi * Math.pow(Dmin / Di, 1 / b);
  return { tSwitch, qSwitch, npSwitch: hyperbolicCumulative(qi, Di, b, tSwitch), Dmin, fromStart: false };
};

/** Rate of the modified hyperbolic at time t (same time unit as Di and Dmin). */
export const calculateModifiedHyperbolicRate = (qi, Di, b, Dmin, t) => {
  const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
  if (!sw) return b > 0 ? calculateArpsHyperbolic(qi, Di, b, t) : calculateArpsExponential(qi, Di, t);
  if (qi <= 0 || t < 0) return 0;
  if (t <= sw.tSwitch) return calculateArpsHyperbolic(qi, Di, b, t);
  return sw.qSwitch * Math.exp(-Dmin * (t - sw.tSwitch));
};

/** Cumulative of the modified hyperbolic from 0 to t, in closed form. */
export const calculateModifiedHyperbolicCumulative = (qi, Di, b, Dmin, t) => {
  if (!(t > 0) || !(qi > 0)) return 0;
  const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
  if (!sw) {
    if (b > 0) return hyperbolicCumulative(qi, Di, b, t);
    return Di > 0 ? (qi / Di) * (1 - Math.exp(-Di * t)) : qi * t;
  }
  if (t <= sw.tSwitch) return hyperbolicCumulative(qi, Di, b, t);
  return sw.npSwitch + (sw.qSwitch / Dmin) * (1 - Math.exp(-Dmin * (t - sw.tSwitch)));
};

/**
 * EUR of the modified hyperbolic to an economic limit rate, in closed form:
 * the hyperbolic volume to the switch, then (qSwitch - qLimit) / Dmin.
 * Without a terminal decline it is calculateEUR.
 */
export const calculateModifiedEUR = (qi, Di, b, Dmin, qLimit) => {
  const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
  const modelType = !(b > 0) ? 'exponential' : (Math.abs(b - 1) < 0.001 ? 'harmonic' : 'hyperbolic');
  if (!sw) return calculateEUR(qi, Di, b, qLimit, modelType);
  if (!(qLimit > 0) || qi <= qLimit) return 0;
  if (qLimit >= sw.qSwitch) return calculateEUR(qi, Di, b, qLimit, modelType);
  return sw.npSwitch + (sw.qSwitch - qLimit) / Dmin;
};

/** Time at which the modified hyperbolic falls to qTarget (Infinity if never). */
export const timeToRateModified = (qi, Di, b, Dmin, qTarget) => {
  if (!(qTarget > 0) || qi <= qTarget) return 0;
  const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
  if (!sw) {
    if (!(Di > 0)) return Infinity;
    if (!(b > 0)) return Math.log(qi / qTarget) / Di;
    return (Math.pow(qi / qTarget, b) - 1) / (b * Di);
  }
  if (qTarget >= sw.qSwitch) return (Math.pow(qi / qTarget, b) - 1) / (b * Di);
  return sw.tSwitch + Math.log(sw.qSwitch / qTarget) / Dmin;
};

// --- Confidence Interval Computation ---

/**
 * Compute 95% confidence intervals for Arps parameters.
 * Uses regression standard errors propagated through the parameter transforms (delta method).
 * Returns object with hasIntervals flag and per-parameter half-widths in same units as the param.
 */
function computeConfidenceIntervals(modelType, regResult, qi, Di, b) {
  const { seSlope, seIntercept, n } = regResult;
  if (!isFinite(seSlope) || !isFinite(seIntercept) || n < 5) {
    return { hasIntervals: false };
  }
  const tValue = 1.96; // 95% normal approximation; n is typically large enough

  let qiHalfWidth = 0, DiHalfWidth = 0, bHalfWidth = 0;

  if (modelType === 'Exponential') {
    // log(q) = log(qi) - Di*t  →  intercept = log(qi), slope = -Di
    // qi = exp(intercept) → SE(qi) = qi * SE(intercept) (delta method)
    qiHalfWidth = qi * seIntercept * tValue;
    DiHalfWidth = seSlope * tValue;
    bHalfWidth = 0; // b fixed at 0 in exponential model
  } else if (modelType === 'Harmonic') {
    // 1/q = 1/qi + (Di/qi)*t → intercept = 1/qi, slope = Di/qi
    // qi = 1/intercept → SE(qi) = qi^2 * SE(intercept)
    // Di = slope*qi → SE(Di) ≈ |slope|*SE(qi) + qi*SE(slope)
    qiHalfWidth = qi * qi * seIntercept * tValue;
    DiHalfWidth = (Math.abs(regResult.slope) * qi * qi * seIntercept + qi * seSlope) * tValue;
    bHalfWidth = 0; // b fixed at 1 in harmonic model
  } else if (modelType === 'Hyperbolic') {
    // q^(-b) = qi^(-b) + b*Di*qi^(-b)*t → intercept = qi^(-b), slope = b*Di*qi^(-b)
    // Approximations under the assumption b is determined by grid search and treated as known
    // qi = intercept^(-1/b) → SE(qi) = (1/b) * qi^(b+1) * SE(intercept)
    qiHalfWidth = (qi ** (b + 1)) / b * seIntercept * tValue;
    // Di = slope / (b * qi^(-b)) → propagate through both slope and qi
    const qPowMinusB = Math.pow(qi, -b);
    DiHalfWidth = (seSlope / (b * qPowMinusB) + Math.abs(regResult.slope) / (b * qPowMinusB) * (b * qiHalfWidth / qi)) * tValue;
    // b is from grid search; we cannot give a CI from regression directly. Use a conservative estimate.
    bHalfWidth = b * 0.10; // ±10% of b as a placeholder for grid-search uncertainty
  }

  // Reasonableness check: if a half-width exceeds the parameter, the fit is bad — flag no intervals
  const reasonable = qiHalfWidth < qi * 2 && DiHalfWidth < Di * 5;
  if (!reasonable) return { hasIntervals: false };

  return {
    hasIntervals: true,
    qi: qiHalfWidth,
    Di: DiHalfWidth,
    b: bHalfWidth,
    confidenceLevel: 0.95
  };
}

// --- Curve Fitting Functions (NEWLY IMPLEMENTED) ---

/**
 * Fit Arps decline model to production data
 * @param {Array} data - Array of {date: string ISO, rate: number} objects
 * @param {string} modelType - 'Auto-Select', 'Exponential', 'Hyperbolic', 'Harmonic'
 * @param {Object} window - {startDate: string, endDate: string} or null
 * @param {Object} constraints - {minB: number, maxB: number} or null
 * @returns {Object} Fit results with R2, RMSE, parameters, and t0
 */
export const fitArpsModel = (data, modelType, window = null, constraints = null) => {
  // Default constraints
  const { minB = 0, maxB = 2 } = constraints || {};
  
  // Filter and validate data
  let filteredData = data.filter(d => d.rate > 0 && !isNaN(d.rate) && d.date);
  
  // Apply time window if specified
  if (window && window.startDate && window.endDate) {
    const startTime = new Date(window.startDate).getTime();
    const endTime = new Date(window.endDate).getTime();
    filteredData = filteredData.filter(d => {
      const time = new Date(d.date).getTime();
      return time >= startTime && time <= endTime;
    });
  }
  
  // Check minimum data points
  if (filteredData.length < 3) {
    return {
      R2: 0,
      RMSE: Infinity,
      parameters: { qi: 0, Di: 0, b: 0, modelType: 'None' },
      t0: new Date().toISOString()
    };
  }
  
  // Sort by date and convert to time series
  filteredData.sort((a, b) => new Date(a.date) - new Date(b.date));
  const t0Date = filteredData[0].date;
  const t0Time = new Date(t0Date).getTime();
  
  const timeSeries = filteredData.map(d => ({
    t: (new Date(d.date).getTime() - t0Time) / (1000 * 60 * 60 * 24), // Convert to days
    rate: d.rate
  }));
  
  const candidates = [];
  
  // Try Exponential model
  if (modelType === 'Exponential' || modelType === 'Auto-Select' || modelType === 'Auto') {
    try {
      const logRates = timeSeries.map(p => Math.log(p.rate));
      const times = timeSeries.map(p => p.t);
      const regResult = linearRegressionWithSE(times, logRates);
      const { slope, intercept } = regResult;
      const qi = Math.exp(intercept);
      const Di = -slope;
      
      if (qi > 0 && Di > 0 && isFinite(qi) && isFinite(Di)) {
        // Calculate RMSE on original scale
        const predicted = timeSeries.map(p => qi * Math.exp(-Di * p.t));
        const actual = timeSeries.map(p => p.rate);
        const rmse = Math.sqrt(predicted.reduce((sum, pred, i) => sum + Math.pow(actual[i] - pred, 2), 0) / predicted.length);
        
        // Calculate R2 on original scale
        const meanActual = actual.reduce((a, b) => a + b, 0) / actual.length;
        const ssTot = actual.reduce((sum, val) => sum + Math.pow(val - meanActual, 2), 0);
        const ssRes = predicted.reduce((sum, pred, i) => sum + Math.pow(actual[i] - pred, 2), 0);
        const r2 = ssTot > 0 ? Math.max(0, 1 - (ssRes / ssTot)) : 0;
        
        candidates.push({
          R2: r2, RMSE: rmse, qi, Di, b: 0, modelType: 'Exponential',
          parameters: { qi, Di, b: 0, modelType: 'Exponential' },
          confidenceIntervals: computeConfidenceIntervals('Exponential', regResult, qi, Di, 0),
          t0: t0Date
        });
      }
    } catch (e) {
      console.warn('Exponential fit failed:', e);
    }
  }
  
  // Try Harmonic model (b = 1)
  if (modelType === 'Harmonic' || modelType === 'Auto-Select' || modelType === 'Auto') {
    try {
      const invRates = timeSeries.map(p => 1 / p.rate);
      const times = timeSeries.map(p => p.t);
      const regResult = linearRegressionWithSE(times, invRates);
      const { slope, intercept } = regResult;
      const qi = 1 / intercept;
      const Di = slope * qi;
      
      if (qi > 0 && Di > 0 && isFinite(qi) && isFinite(Di)) {
        const predicted = timeSeries.map(p => qi / (1 + Di * p.t));
        const actual = timeSeries.map(p => p.rate);
        const rmse = Math.sqrt(predicted.reduce((sum, pred, i) => sum + Math.pow(actual[i] - pred, 2), 0) / predicted.length);
        
        const meanActual = actual.reduce((a, b) => a + b, 0) / actual.length;
        const ssTot = actual.reduce((sum, val) => sum + Math.pow(val - meanActual, 2), 0);
        const ssRes = predicted.reduce((sum, pred, i) => sum + Math.pow(actual[i] - pred, 2), 0);
        const r2 = ssTot > 0 ? Math.max(0, 1 - (ssRes / ssTot)) : 0;
        
        candidates.push({
          R2: r2, RMSE: rmse, qi, Di, b: 1, modelType: 'Harmonic',
          parameters: { qi, Di, b: 1, modelType: 'Harmonic' },
          confidenceIntervals: computeConfidenceIntervals('Harmonic', regResult, qi, Di, 1),
          t0: t0Date
        });
      }
    } catch (e) {
      console.warn('Harmonic fit failed:', e);
    }
  }
  
  // Try Hyperbolic models (grid search)
  if (modelType === 'Hyperbolic' || modelType === 'Auto-Select' || modelType === 'Auto') {
    const bStep = 0.05;
    let bestHyperbolic = null;
    
    for (let b = Math.max(minB, bStep); b <= maxB; b += bStep) {
      if (Math.abs(b - 1) < 0.001) continue; // Skip harmonic (handled above)
      
      try {
        // Linearization: q^(-b) = qi^(-b) + b*Di*qi^(-b)*t
        const transformedRates = timeSeries.map(p => Math.pow(p.rate, -b));
        const times = timeSeries.map(p => p.t);
        const regResult = linearRegressionWithSE(times, transformedRates);
        const { slope, intercept } = regResult;
        const qi = Math.pow(intercept, -1/b);
        const Di = slope / (b * Math.pow(qi, -b));
        
        if (qi > 0 && Di > 0 && isFinite(qi) && isFinite(Di)) {
          const predicted = timeSeries.map(p => calculateArpsHyperbolic(qi, Di, b, p.t));
          const actual = timeSeries.map(p => p.rate);
          const rmse = Math.sqrt(predicted.reduce((sum, pred, i) => sum + Math.pow(actual[i] - pred, 2), 0) / predicted.length);
          
          if (!bestHyperbolic || rmse < bestHyperbolic.RMSE) {
            const meanActual = actual.reduce((a, b) => a + b, 0) / actual.length;
            const ssTot = actual.reduce((sum, val) => sum + Math.pow(val - meanActual, 2), 0);
            const ssRes = predicted.reduce((sum, pred, i) => sum + Math.pow(actual[i] - pred, 2), 0);
            const r2 = ssTot > 0 ? Math.max(0, 1 - (ssRes / ssTot)) : 0;
            
            bestHyperbolic = {
              R2: r2, RMSE: rmse, qi, Di, b, modelType: 'Hyperbolic',
              parameters: { qi, Di, b, modelType: 'Hyperbolic' },
              confidenceIntervals: computeConfidenceIntervals('Hyperbolic', regResult, qi, Di, b),
              t0: t0Date
            };
          }
        }
      } catch (e) {
        // Skip this b value
      }
    }
    
    if (bestHyperbolic) {
      candidates.push(bestHyperbolic);
    }
  }
  
  // Select best model
  if (candidates.length === 0) {
    return { R2: 0, RMSE: Infinity, qi: 0, Di: 0, b: 0, modelType: 'None', parameters: { qi: 0, Di: 0, b: 0, modelType: 'None' }, t0: t0Date };
  }
  
  if (modelType === 'Auto-Select' || modelType === 'Auto') {
    // Return the model with lowest RMSE
    candidates.sort((a, b) => a.RMSE - b.RMSE);
    return candidates[0];
  } else {
    // Return the specific model requested
    const targetType = modelType;
    const match = candidates.find(c => c.parameters.modelType === targetType);
    return match || candidates[0];
  }
};

// --- Rate against cumulative fitting ---
//
// The Arps relations have a time-free form, rate against cumulative volume
// (Arps 1945; CED P03-004 "Rate Cumulative Curves"; Ahmed, Reservoir
// Engineering Handbook ch. 16), which is the classic cross-check on a
// rate-time fit and the one that survives curtailment and shut-ins, because
// time does not appear:
//   exponential   q = qi - Di Np
//   harmonic      ln q = ln qi - (Di / qi) Np
//   hyperbolic    q^(1-b) = qi^(1-b) - (1 - b) Di qi^(-b) Np
// Each is a straight line for a given b, so the fit is ordinary least squares
// in that space, with the same 0.05 grid over b as the rate-time fit. qi and
// Di are referenced to zero cumulative (the start of the cumulative the
// caller supplies, normally first production), so EUR to a limit rate is
// calculateEUR (or calculateModifiedEUR) on these parameters directly, the
// whole volume from zero cumulative. R2 and RMSE are on the rate.

function rateAtCumulative(qi, Di, b, np) {
  if (!(b > 0)) return Math.max(0, qi - Di * np);
  if (Math.abs(b - 1) < 1e-9) return qi * Math.exp(-(Di / qi) * np);
  const base = Math.pow(qi, 1 - b) - (1 - b) * Di * Math.pow(qi, -b) * np;
  if (!(base > 0)) return 0;
  return Math.pow(base, 1 / (1 - b));
}

/** Rate of the plain Arps curve at cumulative np (same units as the fit). */
export const calculateArpsRateAtCumulative = (qi, Di, b, np) => rateAtCumulative(qi, Di, b, np);

function rateCumStats(points, qi, Di, b) {
  const actual = points.map((p) => p.rate);
  const predicted = points.map((p) => rateAtCumulative(qi, Di, b, p.cum));
  const n = actual.length;
  const ssRes = predicted.reduce((sum, pred, i) => sum + (actual[i] - pred) ** 2, 0);
  const mean = actual.reduce((a, v) => a + v, 0) / n;
  const ssTot = actual.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return { RMSE: Math.sqrt(ssRes / n), R2: ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0 };
}

/**
 * Fit an Arps model in rate against cumulative space.
 * @param {Array} points [{cum, rate}] with cum measured from first production
 * @param {string} modelType 'Auto-Select' | 'Auto' | 'Exponential' | 'Hyperbolic' | 'Harmonic'
 * @param {Object|null} window {cumStart, cumEnd}: the cumulative range fitted (either may be omitted)
 * @param {Object|null} constraints {minB, maxB}
 * @returns {Object} {R2, RMSE, n, qi, Di, b, modelType, parameters, window, basis}
 */
export const fitArpsRateCumulative = (points, modelType, window = null, constraints = null) => {
  const { minB = 0, maxB = 2 } = constraints || {};
  let pts = (points || []).filter((p) => p && Number.isFinite(p.cum) && p.cum >= 0
    && Number.isFinite(p.rate) && p.rate > 0);
  const cumStart = window && Number.isFinite(window.cumStart) ? window.cumStart : null;
  const cumEnd = window && Number.isFinite(window.cumEnd) ? window.cumEnd : null;
  if (cumStart !== null) pts = pts.filter((p) => p.cum >= cumStart);
  if (cumEnd !== null) pts = pts.filter((p) => p.cum <= cumEnd);
  pts.sort((a, b) => a.cum - b.cum);
  const none = {
    R2: 0, RMSE: Infinity, n: pts.length, qi: 0, Di: 0, b: 0, modelType: 'None',
    parameters: { qi: 0, Di: 0, b: 0, modelType: 'None' },
    window: { cumStart, cumEnd }, basis: 'rate-cumulative',
  };
  if (pts.length < 3) return none;
  const cums = pts.map((p) => p.cum);
  const auto = modelType === 'Auto-Select' || modelType === 'Auto';
  const candidates = [];
  const push = (qi, Di, b, type) => {
    if (!(qi > 0 && Di > 0 && Number.isFinite(qi) && Number.isFinite(Di))) return null;
    const st = rateCumStats(pts, qi, Di, b);
    const c = {
      ...st, n: pts.length, qi, Di, b, modelType: type,
      parameters: { qi, Di, b, modelType: type },
      window: { cumStart, cumEnd }, basis: 'rate-cumulative',
    };
    candidates.push(c);
    return c;
  };

  if (modelType === 'Exponential' || auto) {
    const reg = linearRegressionWithSE(cums, pts.map((p) => p.rate));
    push(reg.intercept, -reg.slope, 0, 'Exponential');
  }
  if (modelType === 'Harmonic' || auto) {
    const reg = linearRegressionWithSE(cums, pts.map((p) => Math.log(p.rate)));
    const qi = Math.exp(reg.intercept);
    push(qi, -reg.slope * qi, 1, 'Harmonic');
  }
  if (modelType === 'Hyperbolic' || auto) {
    const bStep = 0.05;
    let best = null;
    for (let b = Math.max(minB, bStep); b <= maxB; b += bStep) {
      if (Math.abs(b - 1) < 0.001) continue;
      const reg = linearRegressionWithSE(cums, pts.map((p) => Math.pow(p.rate, 1 - b)));
      if (!(reg.intercept > 0)) continue;
      const qi = Math.pow(reg.intercept, 1 / (1 - b));
      const Di = -reg.slope * Math.pow(qi, b) / (1 - b);
      if (!(qi > 0 && Di > 0 && Number.isFinite(qi) && Number.isFinite(Di))) continue;
      const st = rateCumStats(pts, qi, Di, b);
      if (!best || st.RMSE < best.RMSE) best = { qi, Di, b, RMSE: st.RMSE };
    }
    if (best) push(best.qi, best.Di, best.b, 'Hyperbolic');
  }
  if (candidates.length === 0) return none;
  if (auto) {
    candidates.sort((a, b) => a.RMSE - b.RMSE);
    return candidates[0];
  }
  return candidates.find((c) => c.modelType === modelType) || candidates[0];
};

/**
 * Generate forecast using fitted model parameters
 * @param {Object} params - {qi, Di, b, modelType}
 * @param {Object} config - {forecastDurationDays, economicLimit, stopAtLimit}
 * @param {Date|string} t0 - Zero time reference
 * @returns {Array} Array of {date, rate, cumulative} objects
 */
export const generateForecast = (params, config, t0) => {
  const { qi, Di, b, modelType, Dmin } = params;
  const { forecastDurationDays, durationDays, economicLimit, stopAtLimit, facilityLimit } = config;
  // Terminal decline (modified hyperbolic): only for b > 0 and a positive Dmin.
  const bCurve = modelType === 'Exponential' ? 0 : (modelType === 'Harmonic' ? 1 : b);
  const terminal = modifiedHyperbolicSwitch(qi, Di, bCurve, Dmin);
  const totalDays = forecastDurationDays || durationDays || 3650;
  
  if (!qi || !Di || !totalDays) return { rates: [], eur: 0, timeToLimit: null, chartData: [] };
  
  const startDate = new Date(t0);
  const forecast = [];
  let cumulativeProduction = 0;
  
  let timeToLimitDays = null;
  for (let day = 1; day <= totalDays; day++) {
    let rate;
    
    if (terminal) {
      rate = calculateModifiedHyperbolicRate(qi, Di, bCurve, Dmin, day);
    } else if (modelType === 'Exponential' || b === 0) {
      rate = calculateArpsExponential(qi, Di, day);
    } else if (modelType === 'Harmonic' || b === 1) {
      rate = qi / (1 + Di * day);
    } else {
      rate = calculateArpsHyperbolic(qi, Di, b, day);
    }
    
    // Check economic limit
    if (stopAtLimit && economicLimit && rate < economicLimit) { timeToLimitDays = day; break; }
    
    cumulativeProduction += rate;
    
    const forecastDate = new Date(startDate);
    forecastDate.setDate(forecastDate.getDate() + day);
    
    forecast.push({
      date: forecastDate.toISOString(),
      rate: Math.max(0, rate),
      cumulative: cumulativeProduction
    });
  }
  
  return {
    rates: forecast,
    eur: cumulativeProduction,
    timeToLimit: timeToLimitDays !== null ? timeToLimitDays : totalDays,
    chartData: forecast,
    // The switch to the terminal exponential decline, in days from t0; null
    // when no terminal decline applies. Only present-key when it applies, so
    // a forecast without Dmin returns exactly what it always did.
    ...(terminal ? { terminalDecline: terminal } : {})
  };
};

/**
 * Legacy function - wrapper for backward compatibility
 * @param {Array} data - Production data
 * @returns {Object} Hyperbolic fit parameters
 */
export const fitHyperbolic = (data) => {
  const result = fitArpsModel(data, 'Hyperbolic', null, null);
  return result.parameters;
};

// --- Quality Assessment ---
export const getFitQuality = (r2, rmse, pointCount) => {
  const r2Num = typeof r2 === "number" && isFinite(r2) ? r2 : 0;
  const rmseNum = typeof rmse === "number" && isFinite(rmse) ? rmse : Infinity;
  const n = typeof pointCount === "number" ? pointCount : 0;

  let tier = "Poor";
  if (r2Num >= 0.95) tier = "Excellent";
  else if (r2Num >= 0.90) tier = "Good";
  else if (r2Num >= 0.80) tier = "Fair";

  return { tier, r2: r2Num, rmse: rmseNum, n };
};

