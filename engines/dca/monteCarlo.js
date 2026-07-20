// Monte Carlo simulation utilities for probabilistic decline curve analysis

// Box-Muller transform for generating normal random variables
function generateNormalRandom(mean = 0, stdDev = 1) {
  let u = 0, v = 0;
  while(u === 0) u = Math.random(); // Converting [0,1) to (0,1)
  while(v === 0) v = Math.random();
  
  const z0 = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z0 * stdDev + mean;
}

// Generate uniform random number in range
function generateUniformRandom(min, max) {
  return min + Math.random() * (max - min);
}

// Sample Arps parameters from confidence intervals
function sampleArpsParameters(baseParameters, confidenceIntervals) {
  const { qi, Di, b } = baseParameters;
  const { qi: qiCI, Di: DiCI, b: bCI } = confidenceIntervals;
  
  // Sample from normal distributions using confidence intervals as ±2σ
  const sampledQi = qiCI ? generateNormalRandom(qi, qiCI / 2) : qi;
  const sampledDi = DiCI ? generateNormalRandom(Di, DiCI / 2) : Di;
  const sampledB = bCI ? generateNormalRandom(b, bCI / 2) : b;
  
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
  
  const curve = [];
  const timeStep = 30; // 30-day steps
  let time = startTime;
  let cumulative = 0;
  
  while (time <= durationDays) {
    let rate = calculateArpsRate(qi, Di, b, time / 365); // Convert days to years for Arps equation
    
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
      date: new Date(Date.now() + time * 24 * 60 * 60 * 1000),
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

// Run Monte Carlo simulation
export function runMonteCarloSimulation(baseParameters, confidenceIntervals, config, iterations = 1000, onProgress = null) {
  return new Promise((resolve) => {
    const eurResults = [];
    const allCurves = [];
    let completed = 0;
    
    const runBatch = () => {
      const batchSize = 50;
      const endIndex = Math.min(completed + batchSize, iterations);
      
      for (let i = completed; i < endIndex; i++) {
        // Sample parameters
        const sampledParams = sampleArpsParameters(baseParameters, confidenceIntervals);
        
        // Sample economic limit ±20%
        const baseEconLimit = config.economicLimit || 1;
        const sampledEconLimit = generateUniformRandom(baseEconLimit * 0.8, baseEconLimit * 1.2);
        
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
          iterations: iterations
        };
        
        resolve(results);
      }
    };
    
    setTimeout(runBatch, 10); // Start async
  });
}

// Generate P10/P50/P90 forecast curves from Monte Carlo results
export function generateProbabilisticCurves(baseParameters, confidenceIntervals, config, mcResults) {
  // Generate representative curves at P10, P50, P90 levels
  const p10Params = sampleArpsParameters(baseParameters, {
    qi: confidenceIntervals.qi * 1.28, // ~90th percentile
    Di: confidenceIntervals.Di * -1.28, // Lower decline = higher EUR
    b: confidenceIntervals.b * -0.5
  });
  
  const p50Params = baseParameters; // Use base parameters for P50
  
  const p90Params = sampleArpsParameters(baseParameters, {
    qi: confidenceIntervals.qi * -1.28, // ~10th percentile
    Di: confidenceIntervals.Di * 1.28, // Higher decline = lower EUR
    b: confidenceIntervals.b * 0.5
  });
  
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