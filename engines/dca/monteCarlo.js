// Monte Carlo simulation utilities for probabilistic decline curve analysis

// Deterministic uniform generator (mulberry32). Every draw this module makes
// goes through an injected `rng`, so a run is reproducible when the caller
// supplies a seed: the same seed, parameters and config must return the same
// P10/P50/P90. Without one the module falls back to Math.random and each run
// is a fresh realization, which is fine for exploration but cannot be quoted
// in a report or re-derived by a reviewer.
export function createSeededRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Default half-width of the economic-limit draw, as a fraction of the limit the
// user set. Overridable per run through config.economicLimitUncertainty; 0
// turns the draw off, which is what makes a zero-uncertainty fit deterministic.
export const DEFAULT_ECONOMIC_LIMIT_UNCERTAINTY = 0.2;

function resolveEconLimitSpread(value) {
  if (!Number.isFinite(value)) return DEFAULT_ECONOMIC_LIMIT_UNCERTAINTY;
  return Math.min(Math.max(value, 0), 1);
}

// Callers may pass a function (any uniform [0,1) source) or a numeric seed.
function resolveRng(rng) {
  if (typeof rng === 'function') return rng;
  if (typeof rng === 'number' && Number.isFinite(rng)) return createSeededRng(rng);
  return Math.random;
}

// Box-Muller transform for generating normal random variables
function generateNormalRandom(mean = 0, stdDev = 1, rng = Math.random) {
  let u = 0, v = 0;
  while(u === 0) u = rng(); // Converting [0,1) to (0,1)
  while(v === 0) v = rng();

  const z0 = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z0 * stdDev + mean;
}

// Generate uniform random number in range
function generateUniformRandom(min, max, rng = Math.random) {
  return min + rng() * (max - min);
}

// Sample Arps parameters from confidence intervals
function sampleArpsParameters(baseParameters, confidenceIntervals, rng = Math.random) {
  const { qi, Di, b } = baseParameters;
  const { qi: qiCI, Di: DiCI, b: bCI } = confidenceIntervals;
  
  // Sample from normal distributions using confidence intervals as ±2σ
  const sampledQi = qiCI ? generateNormalRandom(qi, qiCI / 2, rng) : qi;
  const sampledDi = DiCI ? generateNormalRandom(Di, DiCI / 2, rng) : Di;
  const sampledB = bCI ? generateNormalRandom(b, bCI / 2, rng) : b;
  
  return {
    qi: Math.max(sampledQi, 0), // Ensure positive
    Di: Math.max(sampledDi, 0), // Ensure positive
    b: Math.max(Math.min(sampledB, 2), 0) // Clamp b between 0 and 2
  };
}

// Arps decline equation
function calculateArpsRate(qi, Di, b, time) {
  if (b === 0) {
    // Exponential decline
    return qi * Math.exp(-Di * time);
  } else {
    // Hyperbolic decline
    return qi / Math.pow(1 + b * Di * time, 1/b);
  }
}

// Volume produced between two times, integrated in closed form.
//
// This used to be a 30-day LEFT-endpoint rectangle, rate(t) * 30, which
// overstates a falling rate: about 1.8 percent on a typical fit, and more the
// steeper the decline. The Arps rate has an elementary integral, so there is
// no reason to approximate it. Integrating also lets the last step stop
// exactly at the economic limit or the duration cap rather than overshooting
// or discarding a whole 30-day block.
//
// These are the same rate-cumulative relations calculateEUR in arps.js
// evaluates between t = 0 and the limit rate; a zero-spread Monte Carlo run
// now reproduces it to floating-point precision rather than to a couple of
// percent.
function arpsCumulative(qi, Di, b, t1, t2) {
  if (!(t2 > t1) || !(qi > 0)) return 0;
  if (!(Di > 0)) return qi * (t2 - t1); // no decline: flat rate
  if (b <= 0) {
    // Exponential: Np = qi/Di * (exp(-Di t1) - exp(-Di t2))
    return (qi / Di) * (Math.exp(-Di * t1) - Math.exp(-Di * t2));
  }
  if (Math.abs(b - 1) < 1e-9) {
    // Harmonic: Np = qi/Di * ln((1 + Di t2) / (1 + Di t1))
    return (qi / Di) * Math.log((1 + Di * t2) / (1 + Di * t1));
  }
  // Hyperbolic: Np = qi / (Di (b - 1)) * [(1 + b Di t)^((b-1)/b)] evaluated t1 to t2
  const exponent = (b - 1) / b;
  return (qi / (Di * (b - 1)))
    * (Math.pow(1 + b * Di * t2, exponent) - Math.pow(1 + b * Di * t1, exponent));
}

// Time at which the decline falls to a given rate. Infinity when it never
// does (no decline), 0 when it already has.
function timeToRate(qi, Di, b, qTarget) {
  if (!(qTarget > 0) || qi <= qTarget) return 0;
  if (!(Di > 0)) return Infinity;
  if (b <= 0) return Math.log(qi / qTarget) / Di;
  if (Math.abs(b - 1) < 1e-9) return (qi / qTarget - 1) / Di;
  return (Math.pow(qi / qTarget, b) - 1) / (b * Di);
}

// Volume over one step, honouring a facility cap. While the well is choked
// back the rate is flat at the cap, so that part of the step is a rectangle
// and the rest is the decline integral. The split point is exact.
function segmentVolume(qi, Di, b, facilityLimit, t1, t2) {
  if (!(t2 > t1)) return 0;
  if (facilityLimit && facilityLimit > 0) {
    const tCap = timeToRate(qi, Di, b, facilityLimit);
    if (tCap > t1) {
      const flatEnd = Math.min(t2, tCap);
      return facilityLimit * (flatEnd - t1) + arpsCumulative(qi, Di, b, flatEnd, t2);
    }
  }
  return arpsCumulative(qi, Di, b, t1, t2);
}

// Generate single forecast curve
function generateForecastCurve(parameters, config, startTime = 0) {
  const { qi, Di, b } = parameters;
  const { economicLimit, durationDays, facilityLimit, stopAtLimit } = config;

  // config.startDate anchors the curve to the same t0 as the deterministic
  // forecast. Read once, outside the loop: Date.now() per point made two
  // otherwise identical runs differ in their date column, and left the
  // probabilistic curves starting at "now" while generateForecast in arps.js
  // started at the fit's t0.
  const parsedStart = config.startDate != null ? new Date(config.startDate).getTime() : NaN;
  const t0Ms = Number.isFinite(parsedStart) ? parsedStart : Date.now();

  const curve = [];
  const timeStep = 30; // 30-day steps
  let time = startTime;
  let cumulative = 0;

  // Where production actually ends: the economic limit if the curve reaches it
  // (solved exactly, not stepped onto), otherwise the duration cap. Volume is
  // integrated up to this instant, so neither a whole 30-day block is dropped
  // at the limit nor is one added past the cap.
  const tLimit = (stopAtLimit && economicLimit > 0)
    ? timeToRate(qi, Di, b, economicLimit)
    : Infinity;
  const tStop = Math.min(durationDays, tLimit);

  while (time <= durationDays) {
    // Di is PER DAY and `time` is in days, so no unit conversion belongs here.
    // This previously divided by 365, which silently required a per-year Di
    // while every other member of the dca domain produces per-day: fitArpsModel
    // builds t in days and returns Di per day, computeConfidenceIntervals
    // reports its half-widths in the same units, and generateForecast in
    // arps.js steps day by day with no conversion. The Suite fed fit.Di
    // straight in, so probabilistic EUR came back ~25x high.
    let rate = calculateArpsRate(qi, Di, b, time);
    
    // Apply facility limit if specified
    if (facilityLimit && rate > facilityLimit) {
      rate = facilityLimit;
    }
    
    // Check economic limit
    if (stopAtLimit && rate <= economicLimit) {
      break;
    }
    
    const production = segmentVolume(qi, Di, b, facilityLimit, time, Math.min(time + timeStep, tStop));
    cumulative += production;
    
    curve.push({
      time: time,
      date: new Date(t0Ms + time * 24 * 60 * 60 * 1000),
      rate: rate,
      cum: cumulative
    });
    
    time += timeStep;
  }
  
  return {
    data: curve,
    eur: cumulative
  };
}

// Run Monte Carlo simulation.
// `rngOrSeed` accepts a numeric seed or any uniform [0,1) function; omit it to
// draw from Math.random and get a fresh realization each call.
export function runMonteCarloSimulation(baseParameters, confidenceIntervals, config, iterations = 1000, onProgress = null, rngOrSeed = undefined) {
  return new Promise((resolve) => {
    const rng = resolveRng(rngOrSeed);
    const seed = typeof rngOrSeed === 'number' && Number.isFinite(rngOrSeed) ? rngOrSeed : null;
    const econLimitSpread = resolveEconLimitSpread(config.economicLimitUncertainty);
    const eurResults = [];
    const allCurves = [];
    let completed = 0;
    
    const runBatch = () => {
      const batchSize = 50;
      const endIndex = Math.min(completed + batchSize, iterations);
      
      for (let i = completed; i < endIndex; i++) {
        // Sample parameters
        const sampledParams = sampleArpsParameters(baseParameters, confidenceIntervals, rng);

        // Sample the economic limit. The spread used to be a hardcoded ±20%
        // applied unconditionally, which meant a fit carrying no parameter
        // uncertainty still produced a scattered EUR, from a number the user
        // never chose and could not see. It is now config.economicLimitUncertainty,
        // a fraction, and 0 turns the draw off entirely.
        const baseEconLimit = config.economicLimit || 1;
        const sampledEconLimit = econLimitSpread > 0
          ? generateUniformRandom(
              baseEconLimit * (1 - econLimitSpread),
              baseEconLimit * (1 + econLimitSpread),
              rng,
            )
          : baseEconLimit;

        const sampledConfig = {
          ...config,
          economicLimit: sampledEconLimit
        };
        
        // Generate forecast
        const forecast = generateForecastCurve(sampledParams, sampledConfig);
        eurResults.push(forecast.eur);
        
        // Store selected curves for visualization (every 50th to save memory)
        if (i % 50 === 0) {
          allCurves.push(forecast.data);
        }
      }
      
      completed = endIndex;
      
      if (onProgress) {
        onProgress(completed / iterations);
      }
      
      if (completed < iterations) {
        setTimeout(runBatch, 10); // Small delay to prevent blocking
      } else {
        // Calculate statistics
        const sortedEUR = eurResults.slice().sort((a, b) => a - b);
        const p10Index = Math.floor(iterations * 0.1);
        const p50Index = Math.floor(iterations * 0.5);
        const p90Index = Math.floor(iterations * 0.9);
        
        const results = {
          p10: sortedEUR[p90Index], // P10 is higher value (optimistic)
          p50: sortedEUR[p50Index],
          p90: sortedEUR[p10Index], // P90 is lower value (conservative)
          mean: eurResults.reduce((sum, val) => sum + val, 0) / iterations,
          distribution: eurResults,
          sampleCurves: allCurves,
          iterations: iterations,
          // Null when the caller let the run draw from Math.random, which is
          // the signal that this result cannot be reproduced.
          seed: seed
        };
        
        resolve(results);
      }
    };
    
    setTimeout(runBatch, 10); // Start async
  });
}

// Standard normal deviate at the 10th/90th percentile. The parameter band
// below is the analytic 1.28 sigma envelope, the same one the Suite's chart
// already draws from the fit's confidence intervals.
const Z_P10 = 1.2816;

// Offset one parameter by 1.28 sigma. confidenceIntervals holds HALF-WIDTHS of
// the 95% interval, which sampleArpsParameters reads as ±2σ, so sigma is CI/2.
function offsetParameter(value, confidenceInterval, direction) {
  const sigma = Math.abs(confidenceInterval || 0) / 2;
  return value + direction * Z_P10 * sigma;
}

/**
 * Representative low/mid/high forecast curves from the fit and its confidence
 * intervals.
 *
 * These used to be DRAWN: each "percentile" curve called sampleArpsParameters
 * with the confidence interval scaled by ±1.28 and then sampled a normal from
 * it, so the returned curves were random realizations with an inflated spread
 * rather than percentiles, they moved on every call, and the sign flips meant
 * to steer the direction did nothing (a normal with a negative sigma is the
 * same distribution). They are now deterministic 1.28 sigma parameter offsets:
 * high case is a higher qi with a slower decline and a flatter b, low case the
 * reverse, mid case the fit itself.
 *
 * Note these are parameter-offset curves, not the percentiles of the simulated
 * EUR distribution: the EUR of the p10 curve is close to, but not equal to,
 * runMonteCarloSimulation's p10. Use the simulation for the EUR numbers and
 * these for the envelope drawn around the forecast.
 */
export function generateProbabilisticCurves(baseParameters, confidenceIntervals, config) {
  const { qi, Di, b } = baseParameters;
  const { qi: qiCI = 0, Di: DiCI = 0, b: bCI = 0 } = confidenceIntervals || {};

  // Same clamps the sampler applies, so an offset case can never hand the
  // curve generator a negative rate or an out-of-range b.
  const buildParams = (direction) => ({
    qi: Math.max(offsetParameter(qi, qiCI, direction), 0),
    // A lower decline is the optimistic side, so Di moves against direction.
    Di: Math.max(offsetParameter(Di, DiCI, -direction), 0),
    // A higher b is a flatter, longer-lived curve, so b moves with direction.
    b: Math.max(Math.min(offsetParameter(b, bCI, direction), 2), 0),
  });

  const p10Curve = generateForecastCurve(buildParams(1), config);   // optimistic
  const p50Curve = generateForecastCurve(baseParameters, config);   // the fit
  const p90Curve = generateForecastCurve(buildParams(-1), config);  // conservative

  return {
    p10: p10Curve.data,
    p50: p50Curve.data,
    p90: p90Curve.data
  };
}

// Create histogram data from EUR distribution
export function createEURHistogram(distribution, bins = 20) {
  if (!distribution || distribution.length === 0) return [];
  
  const min = Math.min(...distribution);
  const max = Math.max(...distribution);
  const binWidth = (max - min) / bins;
  
  const histogram = Array(bins).fill(0);
  
  distribution.forEach(value => {
    const binIndex = Math.min(Math.floor((value - min) / binWidth), bins - 1);
    histogram[binIndex]++;
  });
  
  return histogram.map((count, i) => ({
    bin: min + (i + 0.5) * binWidth,
    count: count,
    frequency: count / distribution.length
  }));
}
