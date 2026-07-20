import { fitArpsModel } from './arps';

// --- Normalization Utilities ---

/**
 * Normalize data by time (t = days since first production)
 */
export const normalizeByTime = (data) => {
  // Filter out invalid data
  const validData = data.filter(d => d.rate > 0 && d.date);
  if (validData.length === 0) return [];

  // Sort by date
  validData.sort((a, b) => new Date(a.date) - new Date(b.date));

  const startDate = new Date(validData[0].date).getTime();

  return validData.map(d => ({
    ...d,
    originalDate: d.date,
    t_normalized: (new Date(d.date).getTime() - startDate) / (1000 * 60 * 60 * 24), // Days
    rate_normalized: d.rate // No rate normalization yet
  }));
};

/**
 * Normalize data by rate (q = q / q_peak)
 */
export const normalizeByRate = (data) => {
  const maxRate = Math.max(...data.map(d => d.rate));
  if (maxRate <= 0) return data;

  return data.map(d => ({
    ...d,
    rate_normalized: d.rate / maxRate,
    peakRate: maxRate
  }));
};

/**
 * Normalize by both time and rate
 */
export const normalizeByTimeAndRate = (data) => {
  const timeNorm = normalizeByTime(data);
  return normalizeByRate(timeNorm);
};

// --- Fitting & Application ---

/**
 * Fits a single hyperbolic curve to an aggregated set of normalized data points
 */
export const fitTypeCurve = (normalizedData, modelType = 'Hyperbolic') => {
  // If multiple wells are present, normalizedData should be a flat array of
  // all their points. fitArpsModel works on {date, rate} rows with t in days
  // from the first row, so rebuild rows from the normalized coordinates.
  // (The pre-extraction version passed two bare x/y arrays to fitHyperbolic,
  // which takes data rows — it could never produce a fit; no consumer.)
  const epoch = Date.UTC(2000, 0, 1);
  const rows = (normalizedData || [])
    .filter(d => Number.isFinite(d?.t_normalized) && d?.rate_normalized > 0)
    .sort((a, b) => a.t_normalized - b.t_normalized)
    .map(d => ({
      date: new Date(epoch + d.t_normalized * 86_400_000).toISOString(),
      rate: d.rate_normalized,
    }));
  if (rows.length < 3) return null;

  const fit = fitArpsModel(rows, modelType, null, null);
  if (!fit || !fit.parameters) return null;

  return {
    ...fit.parameters, // qi (normalized; ~1 if rate-normalized), Di, b
    R2: fit.R2,
    type: modelType
  };
};

/**
 * Apply a type curve to a target well using fixed-b hyperbolic regression.
 *
 * Industry-standard: hold b from the type curve (more reliable than single-well b),
 * solve for qi and Di by linearizing q^(-b) = qi^(-b) + b*Di*qi^(-b)*t.
 *
 * @param {Object} typeCurveParams - {qi, Di, b, modelType} from a fitted type curve
 * @param {Array} targetWellData - [{date, rate}, ...] history of the target well
 * @returns {Object|null} - applied fit + forecast or null on failure
 */
export const applyTypeCurve = (typeCurveParams, targetWellData) => {
  if (!targetWellData || targetWellData.length < 5) return null;
  if (!typeCurveParams || !typeCurveParams.b) return null;

  const validData = targetWellData
    .filter(d => d.rate > 0 && d.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (validData.length < 5) return null;

  const t0 = new Date(validData[0].date);
  const t0ms = t0.getTime();
  const b = typeCurveParams.b;

  const xs = [];
  const ys = [];
  validData.forEach(d => {
    const tDays = (new Date(d.date).getTime() - t0ms) / 86400000;
    xs.push(tDays);
    ys.push(Math.pow(d.rate, -b));
  });

  const n = xs.length;
  const sumX = xs.reduce((a, x) => a + x, 0);
  const sumY = ys.reduce((a, y) => a + y, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - meanX) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  if (intercept <= 0 || slope <= 0) return null;

  const qi = Math.pow(intercept, -1/b);
  const Di = slope / (b * Math.pow(qi, -b));

  let ssRes = 0, ssTot = 0;
  const meanRate = validData.reduce((s, d) => s + d.rate, 0) / n;
  validData.forEach((d, i) => {
    const tDays = xs[i];
    const predicted = qi / Math.pow(1 + b * Di * tDays, 1/b);
    ssRes += (d.rate - predicted) ** 2;
    ssTot += (d.rate - meanRate) ** 2;
  });
  const R2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const RMSE = Math.sqrt(ssRes / n);

  const forecast = [];
  const lastTDays = xs[xs.length - 1];
  for (let dt = 30; dt <= 3650; dt += 30) {
    const tDays = lastTDays + dt;
    const rate = qi / Math.pow(1 + b * Di * tDays, 1/b);
    const date = new Date(t0ms + tDays * 86400000);
    forecast.push({ date: date.toISOString(), rate, time: tDays });
  }

  const history = validData.map((d, i) => {
    const tDays = xs[i];
    const fitted = qi / Math.pow(1 + b * Di * tDays, 1/b);
    return { date: d.date, rate: d.rate, fitted, time: tDays };
  });

  return {
    qi,
    Di,
    b,
    modelType: 'Hyperbolic',
    R2,
    RMSE,
    n,
    t0: t0.toISOString(),
    history,
    forecast,
    matchMethod: 'Fixed-b Hyperbolic Fit',
    quality: R2 >= 0.85 ? 'Good' : R2 >= 0.6 ? 'Fair' : 'Poor'
  };
};

export const calculateTypeCurveQuality = (R2, dataPoints) => {
  if (R2 > 0.85 && dataPoints > 20) return 'Good';
  if (R2 > 0.6) return 'Fair';
  return 'Poor';
};