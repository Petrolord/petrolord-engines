/**
 * Screening economics: NPV, IRR, payback, sensitivity, scenarios and a
 * seeded Monte Carlo over a simple JV / PSC / royalty-tax cash flow
 * (Economics, extracted VERBATIM from the Suite's src/utils/npvCalculations.js
 * in the EC0 extraction wave, 2026-09-08). The only edit is the import: the
 * Suite file took `quantile` from simple-statistics; this copy takes the
 * bit-identical vendored one from ../../lib/stats/stats.js.
 *
 * This is the CLIENT-SIDE SCREENING engine. The full fiscal engine
 * (Nigerian PIA / NTA 2025, terrain royalties, HCT / CIT, allowances) is
 * ./cashflow.ts, the module's single fiscal source of truth.
 */
import { quantile } from '../../lib/stats/stats.js';
// Canonical CLIENT-SIDE SCREENING economics engine (docs/scope/
// ReservoirEngineering-Module.md §5). Full-fiscal Nigerian economics
// (PIA/NTA, terrain royalties, HCT/CIT) is NOT here; that is the EPE
// engine, supabase/functions/_shared/epe-engine.ts, the module's single
// fiscal source of truth (docs/scope/Economics-ROADMAP.md D1).
//
// CONVENTIONS (deliberate, documented D1):
// - Discounting is MID-YEAR (t + 0.5): screening convention, treats cash
//   as received evenly through the year. The EPE engine discounts
//   YEAR-END with a real-vs-nominal basis choice. The two engines will
//   not produce identical NPVs for the same case; that is a convention
//   difference, not a bug.
// - PSC cost recovery carries unrecovered costs forward across years
//   (same semantics as epe-engine applyPSC).
// - Taxable income deducts CAPEX via straight-line depreciation over
//   `capexDepreciationYears` (default 1 = immediate expensing, the
//   historical behavior). Cash outflow is always in-year regardless.
//   Depreciation scheduled beyond the project horizon is not deducted.

// --- Helper Functions ---

const generateExponentialDecline = (initialRate, declineRate, years) => {
  const profile = [];
  let currentRate = initialRate;
  for (let i = 0; i < years; i++) {
    profile.push(currentRate * 365); // Annual volume
    currentRate *= (1 - declineRate / 100);
  }
  return profile;
};

const generateFlatProfile = (value, years) => new Array(years).fill(value);

// --- Core Economic Engine ---

export const calculateEconomics = (inputs) => {
  const {
    startYear = new Date().getFullYear(),
    projectLife = 20,
    discountRate = 10,
    fiscalType = 'TaxRoyalty', // 'TaxRoyalty' or 'PSC'
    
    // Profiles (Arrays of length projectLife)
    production = { oil: [], gas: [] }, // Annual units (bbl, mscf)
    price = { oil: [], gas: [] }, // $/unit
    
    // Costs (Arrays of length projectLife)
    capex = [], 
    opexFixed = [], 
    opexVariable = [], 
    abandonment = [],

    // Fiscal Terms
    royaltyRate = 0, // %
    taxRate = 0, // %
    costRecoveryCap = 100,
    profitSplitContractor = 100,
    capexDepreciationYears = 1, // 1 = immediate expensing (tax only; cash is always in-year)
  } = inputs;

  // Straight-line depreciation schedule for the tax calculation.
  const deprYears = Math.max(1, Math.round(capexDepreciationYears));
  const depreciation = new Array(projectLife).fill(0);
  for (let i = 0; i < projectLife; i++) {
    const annualPortion = (capex[i] || 0) / deprYears;
    for (let y = i; y < Math.min(i + deprYears, projectLife); y++) {
      depreciation[y] += annualPortion;
    }
  }

  const cashflow = [];
  let cumulativeNCF = 0;
  let totalCapex = 0;
  let totalRevenue = 0;
  let totalOpex = 0;
  let totalTax = 0;
  let totalRoyalty = 0;
  let totalGovTake = 0;
  let pscUnrecoveredPool = 0;

  for (let i = 0; i < projectLife; i++) {
    const year = startYear + i;
    
    // 1. Revenue
    const oilProd = production.oil[i] || 0;
    const gasProd = production.gas[i] || 0;
    const oilPrice = price.oil[i] || 0;
    const gasPrice = price.gas[i] || 0;

    const oilRev = (oilProd * oilPrice) / 1e6; // $MM
    const gasRev = (gasProd * gasPrice) / 1e6; // $MM
    const grossRevenue = oilRev + gasRev;

    // 2. Costs
    const annualCapex = capex[i] || 0;
    const annualOpex = (opexFixed[i] || 0) + (opexVariable[i] || 0);
    const annualAbex = abandonment[i] || 0;
    const totalCostOutflow = annualCapex + annualOpex + annualAbex;

    let royalty = 0;
    let tax = 0;
    let contractorNCF = 0;
    let governmentShare = 0;

    if (fiscalType === 'TaxRoyalty') {
        royalty = grossRevenue * (royaltyRate / 100);
        const netRevenue = grossRevenue - royalty;

        // Taxable income deducts depreciation, not cash CAPEX; with the
        // default capexDepreciationYears = 1 the two are identical.
        const taxableIncome = netRevenue - annualOpex - annualAbex - depreciation[i];
        tax = taxableIncome > 0 ? taxableIncome * (taxRate / 100) : 0;

        contractorNCF = netRevenue - totalCostOutflow - tax;
        governmentShare = royalty + tax;

    } else {
        // PSC Model
        royalty = grossRevenue * (royaltyRate / 100);
        const netRevenue = grossRevenue - royalty;

        // Cost recovery against the cost-oil cap, with unrecovered costs
        // carried forward (same semantics as epe-engine applyPSC; the pool
        // is never silently dropped).
        const recoverablePool = pscUnrecoveredPool + totalCostOutflow;
        const costOilCap = netRevenue * (costRecoveryCap / 100);
        const recoverableCost = Math.min(costOilCap, recoverablePool);
        pscUnrecoveredPool = recoverablePool - recoverableCost;

        // Profit Oil
        const profitOil = Math.max(0, netRevenue - recoverableCost);
        const contractorProfit = profitOil * (profitSplitContractor / 100);
        const govProfit = profitOil * (1 - profitSplitContractor / 100);

        // Tax on Contractor Profit
        tax = contractorProfit * (taxRate / 100);

        contractorNCF = (recoverableCost + contractorProfit) - totalCostOutflow - tax;
        governmentShare = royalty + govProfit + tax;
    }

    cumulativeNCF += contractorNCF;
    totalCapex += annualCapex;
    totalOpex += annualOpex;
    totalRevenue += grossRevenue;
    totalTax += tax;
    totalRoyalty += royalty;
    totalGovTake += governmentShare;

    cashflow.push({
      year,
      grossRevenue,
      royalty,
      capex: annualCapex,
      opex: annualOpex,
      abex: annualAbex,
      tax,
      depreciation: depreciation[i],
      pscUnrecoveredCost: fiscalType === 'TaxRoyalty' ? 0 : pscUnrecoveredPool,
      ncf: contractorNCF,
      cumulativeNCF,
      govTake: governmentShare
    });
  }

  // --- Metrics ---
  let npv = 0;
  cashflow.forEach((cf, i) => {
      npv += cf.ncf / Math.pow(1 + discountRate / 100, i + 0.5);
  });

  // IRR (mid-year convention, matching the NPV above). Guard: an IRR only
  // exists if the cash flow changes sign; without that, report 0 rather
  // than letting Newton-Raphson wander.
  let irr = 0;
  const hasNeg = cashflow.some(c => c.ncf < 0);
  const hasPos = cashflow.some(c => c.ncf > 0);
  if (hasNeg && hasPos) {
    let guess = 0.1;
    for(let iter=0; iter<100; iter++){
        let npvIter = 0;
        let dNpv = 0;
        for(let t=0; t<cashflow.length; t++){
            const df = Math.pow(1+guess, t+0.5);
            npvIter += cashflow[t].ncf / df;
            dNpv -= (t+0.5) * cashflow[t].ncf / (df * (1+guess));
        }
        if(Math.abs(dNpv) < 1e-5) break;
        const newGuess = guess - npvIter/dNpv;
        if(!isFinite(newGuess)) break;
        if(Math.abs(newGuess - guess) < 1e-7) { guess = newGuess; break; }
        guess = Math.max(-0.99, Math.min(newGuess, 10));
    }
    irr = isFinite(guess) ? guess * 100 : 0;
  }

  // Payback, in years from the start of the project.
  //
  // Index i covers the period from t = i to t = i + 1 (which is why the
  // discount exponent is i + 0.5). So a project still negative at the end
  // of period i - 1 and positive at the end of period i pays back part way
  // THROUGH period i, at t = i + (shortfall carried in) / (that period's
  // cash flow).
  //
  // E1 correction: this used to start the count at (firstPositiveIndex - 1)
  // and so reported payback exactly ONE YEAR EARLY in every case. A project
  // spending 100 in the first period and earning 150 in the second was
  // reported as paying back in 0.67 years when it pays back in 1.67.
  let payback = 0;
  const firstPositiveIndex = cashflow.findIndex(c => c.cumulativeNCF >= 0);
  if (firstPositiveIndex > 0) {
      const prev = cashflow[firstPositiveIndex - 1];
      const curr = cashflow[firstPositiveIndex];
      payback = curr.ncf > 0
        ? firstPositiveIndex + Math.abs(prev.cumulativeNCF) / curr.ncf
        : firstPositiveIndex;
  } else if (firstPositiveIndex === 0) {
      payback = 0;
  } else {
      payback = projectLife;
  }

  // Peak Exposure
  const maxExposure = Math.min(...cashflow.map(c => c.cumulativeNCF));

  return {
    metrics: {
      npv,
      irr,
      payback,
      maxExposure,
      totalRevenue,
      totalCapex,
      totalOpex,
      totalTax,
      totalRoyalty,
      totalGovTake
    },
    cashflow
  };
};

// --- Scenario & Sensitivity ---

export const runSensitivityAnalysis = (baseInputs) => {
    // Variables to perturb: Oil Price, CAPEX, OPEX, Production
    const sensitivities = [
        { name: 'Oil Price', param: 'price.oil', range: 0.3 },
        { name: 'CAPEX', param: 'capex', range: 0.3 },
        { name: 'OPEX', param: 'opex', range: 0.3 },
        { name: 'Production', param: 'production', range: 0.3 }
    ];

    const results = sensitivities.map(sens => {
        // Low Case (-30%)
        let lowInputs = JSON.parse(JSON.stringify(baseInputs));
        if (sens.name === 'Oil Price') lowInputs.price.oil = lowInputs.price.oil.map(v => v * (1 - sens.range));
        if (sens.name === 'CAPEX') lowInputs.capex = lowInputs.capex.map(v => v * (1 - sens.range)); // Lower Cost is better? Usually tornado shows impact of variable value
        if (sens.name === 'OPEX') lowInputs.opexFixed = lowInputs.opexFixed.map(v => v * (1 - sens.range));
        if (sens.name === 'Production') lowInputs.production.oil = lowInputs.production.oil.map(v => v * (1 - sens.range));

        // High Case (+30%)
        let highInputs = JSON.parse(JSON.stringify(baseInputs));
        if (sens.name === 'Oil Price') highInputs.price.oil = highInputs.price.oil.map(v => v * (1 + sens.range));
        if (sens.name === 'CAPEX') highInputs.capex = highInputs.capex.map(v => v * (1 + sens.range));
        if (sens.name === 'OPEX') highInputs.opexFixed = highInputs.opexFixed.map(v => v * (1 + sens.range));
        if (sens.name === 'Production') highInputs.production.oil = highInputs.production.oil.map(v => v * (1 + sens.range));

        const lowRes = calculateEconomics(lowInputs);
        const highRes = calculateEconomics(highInputs);
        const baseRes = calculateEconomics(baseInputs);

        // For costs, Low value usually means High NPV. We align charts by parameter value direction.
        // Tornado logic: shows NPV at Low Param vs High Param.
        return {
            name: sens.name,
            lowParamNPV: lowRes.metrics.npv,
            highParamNPV: highRes.metrics.npv,
            baseNPV: baseRes.metrics.npv
        };
    });
    
    return results;
};

export const generateScenarios = (baseInputs) => {
    // Low Case: -20% Price/Prod, +20% Cost
    let lowInputs = JSON.parse(JSON.stringify(baseInputs));
    lowInputs.price.oil = lowInputs.price.oil.map(v => v * 0.8);
    lowInputs.production.oil = lowInputs.production.oil.map(v => v * 0.8);
    lowInputs.capex = lowInputs.capex.map(v => v * 1.2);
    lowInputs.opexFixed = lowInputs.opexFixed.map(v => v * 1.2);
    
    // High Case: +20% Price/Prod, -20% Cost
    let highInputs = JSON.parse(JSON.stringify(baseInputs));
    highInputs.price.oil = highInputs.price.oil.map(v => v * 1.2);
    highInputs.production.oil = highInputs.production.oil.map(v => v * 1.2);
    highInputs.capex = highInputs.capex.map(v => v * 0.8);
    highInputs.opexFixed = highInputs.opexFixed.map(v => v * 0.8);

    return {
        Base: calculateEconomics(baseInputs),
        Low: calculateEconomics(lowInputs),
        High: calculateEconomics(highInputs)
    };
};


export const runMonteCarlo = async (baseInputs, settings) => {
    const iterations = settings.iterations || 500;
    const results = [];

    const sample = (val, range) => {
        if (!range) return val;
        const min = val * (1 - range);
        const max = val * (1 + range);
        const u = Math.random();
        return min + (max - min) * u; // Uniform for simplicity or use Box-Muller for Normal
    };

    for (let i = 0; i < iterations; i++) {
        const iterProd = {
            oil: baseInputs.production.oil.map(v => sample(v, settings.uncertainties.reserves)),
            gas: baseInputs.production.gas.map(v => sample(v, settings.uncertainties.reserves))
        };
        const iterPrice = {
            oil: baseInputs.price.oil.map(v => sample(v, settings.uncertainties.price)),
            gas: baseInputs.price.gas.map(v => sample(v, settings.uncertainties.price))
        };
        const iterCapex = baseInputs.capex.map(v => sample(v, settings.uncertainties.capex));
        
        const iterInputs = {
            ...baseInputs,
            production: iterProd,
            price: iterPrice,
            capex: iterCapex
        };

        const res = calculateEconomics(iterInputs);
        results.push(res.metrics.npv);
    }

    results.sort((a, b) => a - b);
    
    const p10 = quantile(results, 0.1);
    const p50 = quantile(results, 0.5);
    const p90 = quantile(results, 0.9);
    const mean = results.reduce((a,b) => a+b, 0) / iterations;
    const emv = mean; 

    // Histogram
    const min = results[0];
    const max = results[iterations - 1];
    const binCount = 20;
    const binSize = (max - min) / binCount;
    const histogram = new Array(binCount).fill(0).map((_, i) => ({ 
      binStart: min + i * binSize, 
      binEnd: min + (i+1) * binSize,
      count: 0 
    }));
    
    results.forEach(v => {
        const idx = Math.min(Math.floor((v - min) / binSize), binCount - 1);
        histogram[idx].count++;
    });

    // Cumulative Probability (S-Curve)
    // P(x < X)
    const cdf = results.map((val, i) => ({
        value: val,
        probability: (i / iterations) * 100
    })).filter((_, i) => i % Math.floor(iterations/50) === 0); // Downsample for chart

    return { p10, p50, p90, emv, histogram, cdf, allValues: results };
};

// Helper to expand Quick Inputs into Full Engine Inputs
export const expandQuickInputs = (quickData) => {
    const life = 20;
    const oilProfile = generateExponentialDecline(quickData.initialRate, quickData.declineRate, life);
    const gasProfile = new Array(life).fill(0);
    
    const oilPriceProfile = generateFlatProfile(quickData.oilPrice, life);
    const gasPriceProfile = generateFlatProfile(3.5, life); 

    const capexProfile = new Array(life).fill(0);
    capexProfile[0] = quickData.capex * 0.5;
    capexProfile[1] = quickData.capex * 0.5;

    const opexFixedProfile = generateFlatProfile(quickData.fixedOpex, life);
    const opexVarProfile = oilProfile.map(q => (q * quickData.opexPerBbl)/1e6); 

    return {
        startYear: quickData.startYear || new Date().getFullYear(),
        projectLife: life,
        discountRate: quickData.discountRate,
        fiscalType: 'TaxRoyalty', 
        production: { oil: oilProfile, gas: gasProfile },
        price: { oil: oilPriceProfile, gas: gasPriceProfile },
        capex: capexProfile,
        opexFixed: opexFixedProfile,
        opexVariable: opexVarProfile,
        abandonment: new Array(life).fill(0),
        royaltyRate: quickData.royaltyRate,
        taxRate: quickData.taxRate
    };
};

// --- Portfolio & Integration Helpers ---

export const getPortfolioMetrics = (projects) => {
    let totalNPV = 0;
    let totalCapex = 0;
    let totalRiskedNPV = 0;
    let weightedIRR = 0; // Weighted by CAPEX or NPV? Typically CAPEX for efficiency

    projects.forEach(p => {
        totalNPV += p.npv || 0;
        totalCapex += p.capex || 0;
        totalRiskedNPV += (p.npv || 0) * (p.chanceOfSuccess || 1.0);
        // Simple average for now, could be weighted
    });
    
    const capitalEfficiency = totalCapex > 0 ? totalNPV / totalCapex : 0;
    const avgIRR = projects.reduce((acc, p) => acc + (p.irr || 0), 0) / (projects.length || 1);

    return {
        totalNPV,
        totalCapex,
        totalRiskedNPV,
        capitalEfficiency,
        avgIRR
    };
};