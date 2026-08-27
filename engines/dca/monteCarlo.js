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
    
    const production = rate * timeStep;
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
    const eurResults = [];
    const allCurves = [];
    let completed = 0;
    
    const runBatch = () => {
      const batchSize = 50;
      const endIndex = Math.min(completed + batchSize, iterations);
      
      for (let i = completed; i < endIndex; i++) {
        // Sample parameters
        const sampledParams = sampleArpsParameters(baseParameters, confidenceIntervals, rng);
        
        // Sample economic limit ±20%
        const baseEconLimit = config.economicLimit || 1;
        const sampledEconLimit = generateUniformRandom(baseEconLimit * 0.8, baseEconLimit * 1.2, rng);
        
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

// Generate P10/P50/P90 forecast curves from Monte Carlo results
export function generateProbabilisticCurves(baseParameters, confidenceIntervals, config, mcResults, rngOrSeed = undefined) {
  const rng = resolveRng(rngOrSeed);

  // Generate representative curves at P10, P50, P90 levels
  const p10Params = sampleArpsParameters(baseParameters, {
    qi: confidenceIntervals.qi * 1.28, // ~90th percentile
    Di: confidenceIntervals.Di * -1.28, // Lower decline = higher EUR
    b: confidenceIntervals.b * -0.5
  }, rng);
  
  const p50Params = baseParameters; // Use base parameters for P50
  
  const p90Params = sampleArpsParameters(baseParameters, {
    qi: confidenceIntervals.qi * -1.28, // ~10th percentile
    Di: confidenceIntervals.Di * 1.28, // Higher decline = lower EUR
    b: confidenceIntervals.b * 0.5
  }, rng);
  
  const p10Curve = generateForecastCurve(p10Params, config);
  const p50Curve = generateForecastCurve(p50Params, config);
  const p90Curve = generateForecastCurve(p90Params, config);
  
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
