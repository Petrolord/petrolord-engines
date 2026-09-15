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
import { quantile, mulberry32 } from '../../lib/stats/stats.js';
import { solveIrrInBand } from './irrContract.js';
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

  // IRR (mid-year convention, matching the NPV above).
  //
  // EC6-1 (FINDINGS-fdp.md section 1). Newton runs from 10 percent between
  // a lower clamp of -99 percent and an upper clamp of 1000 percent. The
  // clamps were written as a guard against a wandering search, and the
  // number Newton stopped at was then reported as the answer: a project
  // whose net present value is negative at every rate from -99 percent to
  // 1e14 percent showed an IRR of 1000.0 percent, and on a scenario card
  // that 1000 was coloured green because it cleared the 15 percent hurdle.
  //
  // An answer is now only an answer if it is one: the search must land
  // strictly inside the clamps AND the net present value there must be
  // zero to within a tolerance scaled by the size of the cash flow. When
  // it does not, `irr` is null and `irrStatus` says which of the four
  // things happened, so a caller can print "not defined" or "above 1000
  // percent" instead of a number that means neither.
  //
  //   'ok'              a root, reported
  //   'no-sign-change'  every period has the same sign, no IRR exists
  //   'above-clamp'     still positive at 1000 percent: the IRR is higher
  //                     than the band the engine searches
  //   'multiple-roots'  the flow changes sign more than once; every rate
  //                     that zeroes it is listed in `irrRoots`
  //   'no-root'         no rate in the band zeroes the net present value
  // The contract (statuses, band, tolerance, the sweep when Newton fails)
  // lives in ./irrContract.js since EC2-5, shared with the fiscal regime
  // sandbox. Mid-year: the flow in period t is discounted at t + 0.5.
  const { irr, irrStatus, irrRoots } = solveIrrInBand(
    cashflow.map((cf) => cf.ncf),
    cashflow.map((_, t) => t + 0.5),
  );

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
  //
  // EC3-1 and EC3-2 (owner decision 2026-09-15). `payback` stays the FIRST
  // crossing, the definition cashflow.ts and fdp/costCalculations.js use, so
  // the module keeps one meaning for the word. What changed is that the
  // number now says what happened around it, in `paybackStatus`:
  //
  //   'ok'             the cumulative crosses once and stays non-negative
  //   'recrossed'      it turned non-negative and later went back below
  //                    zero (a first year in the black and a second year
  //                    carrying the rest of the capex read payback 0 beside
  //                    a negative peak exposure); `paybackLast` is where it
  //                    turns non-negative for good, or null if it never does
  //   'no-investment'  the cumulative is never negative: nothing was at
  //                    risk, payback 0
  //   'not-recovered'  the cumulative never turns non-negative: payback is
  //                    null. It used to be the project life, which cannot be
  //                    told apart from paying back on the last day.
  const crossingAt = (i) => {
    if (i === 0) return 0;
    const prev = cashflow[i - 1];
    const curr = cashflow[i];
    return curr.ncf > 0 ? i + Math.abs(prev.cumulativeNCF) / curr.ncf : i;
  };
  let payback = null;
  let paybackLast = null;
  let paybackStatus = 'not-recovered';
  const firstPositiveIndex = cashflow.findIndex(c => c.cumulativeNCF >= 0);
  let lastNegativeIndex = -1;
  cashflow.forEach((c, i) => { if (c.cumulativeNCF < 0) lastNegativeIndex = i; });
  if (firstPositiveIndex === -1) {
      paybackStatus = 'not-recovered';
  } else if (lastNegativeIndex === -1) {
      payback = 0;
      paybackLast = 0;
      paybackStatus = 'no-investment';
  } else {
      payback = crossingAt(firstPositiveIndex);
      if (lastNegativeIndex < firstPositiveIndex) {
          paybackLast = payback;
          paybackStatus = 'ok';
      } else {
          paybackStatus = 'recrossed';
          paybackLast = lastNegativeIndex === cashflow.length - 1
            ? null
            : crossingAt(lastNegativeIndex + 1);
      }
  }

  // Peak Exposure
  const maxExposure = Math.min(...cashflow.map(c => c.cumulativeNCF));

  return {
    metrics: {
      npv,
      irr,
      irrStatus,
      irrRoots,
      payback,
      paybackLast,
      paybackStatus,
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
        if (sens.name === 'Production') {
            // EC6-1: production carries the variable operating cost with it.
            // Sweeping the volume alone credited a 30 percent cut in
            // production with the operating cost of the full profile, which
            // overstates how much the NPV moves with volume.
            lowInputs.production.oil = lowInputs.production.oil.map(v => v * (1 - sens.range));
            lowInputs.opexVariable = (lowInputs.opexVariable || []).map(v => v * (1 - sens.range));
        }

        // High Case (+30%)
        let highInputs = JSON.parse(JSON.stringify(baseInputs));
        if (sens.name === 'Oil Price') highInputs.price.oil = highInputs.price.oil.map(v => v * (1 + sens.range));
        if (sens.name === 'CAPEX') highInputs.capex = highInputs.capex.map(v => v * (1 + sens.range));
        if (sens.name === 'OPEX') highInputs.opexFixed = highInputs.opexFixed.map(v => v * (1 + sens.range));
        if (sens.name === 'Production') {
            highInputs.production.oil = highInputs.production.oil.map(v => v * (1 + sens.range));
            highInputs.opexVariable = (highInputs.opexVariable || []).map(v => v * (1 + sens.range));
        }

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
    // EC3-3 (owner decision 2026-09-15): a scenario's production carries its
    // variable operating cost with it, as the sensitivity sweep's does since
    // EC6-1. The Low case used to produce 0.8 times the oil at the full
    // profile's variable opex, so every barrel it did not produce still cost
    // money and every extra barrel in the High case cost nothing.

    // Low Case: -20% Price/Prod, +20% Cost
    let lowInputs = JSON.parse(JSON.stringify(baseInputs));
    lowInputs.price.oil = lowInputs.price.oil.map(v => v * 0.8);
    lowInputs.production.oil = lowInputs.production.oil.map(v => v * 0.8);
    lowInputs.opexVariable = (lowInputs.opexVariable || []).map(v => v * 0.8);
    lowInputs.capex = lowInputs.capex.map(v => v * 1.2);
    lowInputs.opexFixed = lowInputs.opexFixed.map(v => v * 1.2);

    // High Case: +20% Price/Prod, -20% Cost
    let highInputs = JSON.parse(JSON.stringify(baseInputs));
    highInputs.price.oil = highInputs.price.oil.map(v => v * 1.2);
    highInputs.production.oil = highInputs.production.oil.map(v => v * 1.2);
    highInputs.opexVariable = (highInputs.opexVariable || []).map(v => v * 1.2);
    highInputs.capex = highInputs.capex.map(v => v * 0.8);
    highInputs.opexFixed = highInputs.opexFixed.map(v => v * 0.8);

    return {
        Base: calculateEconomics(baseInputs),
        Low: calculateEconomics(lowInputs),
        High: calculateEconomics(highInputs)
    };
};


/**
 * Default Monte Carlo seed, the same value as breakeven.js DEFAULT_SEED, so an
 * unconfigured run of either app is reproducible (EC3-0, owner decision
 * 2026-09-14).
 */
export const DEFAULT_MC_SEED = 20260829;

/**
 * Monte Carlo over the screening case (EC3-0 repair, owner decision
 * 2026-09-14).
 *
 * SEEDED. Every draw comes from mulberry32(settings.seed), defaulting to
 * DEFAULT_MC_SEED, and the seed travels with the result. It used to call a
 * bare Math.random, so the same inputs gave a different answer every run
 * (FINDINGS S3). The stream is consumed in exactly the order the old gates
 * substituted for Math.random, so every previously published seeded value is
 * unchanged.
 *
 * THE KEYS ARE PLAIN PERCENTILES OF NPV. `p10` is the 10th percentile, the
 * LOW NPV; `p90` is the 90th, the HIGH NPV. Under the Suite's exceedance
 * convention (src/lib/percentileConventions.js) the low case is labelled P90
 * and reads `p10`. The keys are kept for existing callers; every screen must
 * map them through the convention rather than printing the key as a label.
 *
 * Also repaired: every uncertainty at zero makes all NPVs equal, which used
 * to divide by a zero bin width and throw (S4); now every iteration lands in
 * the first bin. Fewer than 50 iterations used to leave the S-curve empty
 * because the downsample step was zero (S5).
 *
 * EC3-7 (owner decision 2026-09-15): ONE factor per uncertain variable per
 * iteration, applied to every year. `reserves` scales oil and gas volume in
 * every year AND the variable operating cost that volume carries; `price`
 * scales oil and gas price in every year; `capex` scales every capex entry.
 * Each factor is uniform on 1 plus or minus its range, drawn in the order
 * reserves, price, capex, and a falsy range draws nothing. The run used to
 * draw every year separately, so "reserves 20 percent low" was twenty
 * independent draws that averaged each other out and the NPV spread came out
 * far narrower than the belief it was meant to describe; and variable opex
 * never moved. A range outside 0 to 1 is refused by name.
 *
 * EC3-6: the S-curve is 51 points at probability 0, 2, ..., 100 percent,
 * each read with the same quantile rule as the cards, so it starts at the
 * smallest NPV, ends at the largest, and its 10 / 50 / 90 heights are the
 * card values. It used to keep every floor(n / 50)th sorted value, which
 * never plotted the top of the sample and read single values where the
 * cards averaged.
 */
export const runMonteCarlo = async (baseInputs, settings) => {
    const iterations = settings.iterations || 500;
    const seed = settings.seed ?? DEFAULT_MC_SEED;
    const uncertainties = settings.uncertainties || {};
    ['reserves', 'price', 'capex'].forEach((key) => {
        const r = uncertainties[key];
        if (r && !(r >= 0 && r <= 1)) {
            throw new Error(`The ${key} uncertainty must be a fraction between 0 and 1.`);
        }
    });
    const rng = mulberry32(seed);
    const results = [];

    // One draw for the whole iteration: uniform on 1 plus or minus the range.
    const factor = (range) => {
        if (!range) return 1;
        const min = 1 - range;
        const max = 1 + range;
        const u = rng();
        return min + (max - min) * u;
    };

    for (let i = 0; i < iterations; i++) {
        const fReserves = factor(uncertainties.reserves);
        const fPrice = factor(uncertainties.price);
        const fCapex = factor(uncertainties.capex);

        const iterInputs = {
            ...baseInputs,
            production: {
                oil: baseInputs.production.oil.map(v => v * fReserves),
                gas: baseInputs.production.gas.map(v => v * fReserves)
            },
            opexVariable: (baseInputs.opexVariable || []).map(v => v * fReserves),
            price: {
                oil: baseInputs.price.oil.map(v => v * fPrice),
                gas: baseInputs.price.gas.map(v => v * fPrice)
            },
            capex: baseInputs.capex.map(v => v * fCapex)
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
        // A zero-width range (every NPV equal) puts every value in bin 0.
        const idx = binSize > 0 ? Math.min(Math.floor((v - min) / binSize), binCount - 1) : 0;
        histogram[idx].count++;
    });

    // Cumulative Probability (S-Curve), EC3-6: 51 points at 0, 2, ..., 100
    // percent, each read with the cards' quantile rule, so the curve reaches
    // both ends of the sample and passes through the card values.
    const CDF_STEPS = 50;
    const cdf = Array.from({ length: CDF_STEPS + 1 }, (_, k) => ({
        value: quantile(results, k / CDF_STEPS),
        probability: (k * 100) / CDF_STEPS
    }));

    return { p10, p50, p90, emv, histogram, cdf, allValues: results, seed, iterations };
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

    // EC1-10 (owner decision 2026-09-15). The chance of success used to be
    // read as `chanceOfSuccess || 1.0`, so a project the user had written off
    // at a chance of 0 was counted at its full NPV. A missing or null chance
    // still means certainty; a chance that is present must be a finite number
    // from 0 to 1, and anything else is refused by project.
    projects.forEach((p, i) => {
        const chance = p.chanceOfSuccess ?? 1;
        if (typeof chance !== 'number' || !Number.isFinite(chance) || chance < 0 || chance > 1) {
            const who = p.name ? `project "${p.name}" (index ${i})` : `project at index ${i}`;
            throw new RangeError(
                `getPortfolioMetrics: ${who} has chanceOfSuccess ${typeof p.chanceOfSuccess === 'string' ? JSON.stringify(p.chanceOfSuccess) : String(p.chanceOfSuccess)}; `
                + 'a chance of success must be a number from 0 to 1.',
            );
        }
        totalNPV += p.npv || 0;
        totalCapex += p.capex || 0;
        totalRiskedNPV += (p.npv || 0) * chance;
    });
    
    const capitalEfficiency = totalCapex > 0 ? totalNPV / totalCapex : 0;
    // EC6-1: a project with no internal rate of return used to be averaged
    // in as a zero, which pulls the portfolio average towards nothing for
    // exactly the projects that have no return at all. Only the projects
    // that have one are averaged, and the count is reported beside it.
    const withIRR = projects.filter((p) => typeof p.irr === 'number' && Number.isFinite(p.irr));
    const avgIRR = withIRR.length
        ? withIRR.reduce((acc, p) => acc + p.irr, 0) / withIRR.length
        : null;

    return {
        totalNPV,
        totalCapex,
        totalRiskedNPV,
        capitalEfficiency,
        irrProjectCount: withIRR.length,
        avgIRR
    };
};