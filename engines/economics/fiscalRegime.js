/**
 * Fiscal regime sandbox: per-regime cash flow (sliding-scale royalty,
 * cost recovery with carryforward, R-factor profit splits, CIT / RRT with
 * uplift, minimum tax), year-end NPV, bisection IRR, the price and capex
 * sensitivity sweeps, the derived insights and `runFiscalComparison`
 * (Economics, extracted VERBATIM from the Suite's
 * src/utils/fiscalDesignerCalculations.js in the EC0 extraction wave,
 * 2026-09-08). The Suite file had no imports, so nothing was repointed and
 * no behaviour changed. `runFiscalComparison` stays async as published.
 * Regime templates live beside it in ./fiscalTemplates.js.
 *
 * CONVENTION: discounting here is YEAR-END (t = 1, 2, ...). The screening
 * engine in ./screening.js discounts MID-YEAR. Oracle:
 * tools/validation/economics/oracle_fiscal.py, goldens:
 * test-data/economics/goldens/fiscal_cases.json.
 */
// Client-side screening model for fiscal regime design: sliding-scale
// royalty, R-factor profit splits, cost recovery with carryforward, CIT/RRT.
//
// This is a regime SANDBOX, not a second fiscal truth. It exists to
// compare the shape of regimes against each other; full Nigerian fiscal
// math lives in the EPE engine
// (supabase/functions/_shared/epe-engine.ts), which stays the module's
// single source of truth. Where this model and the canonical engines
// overlap, they must agree, and that is now gated by tests.
//
// D1 (docs/scope/Economics-ROADMAP.md): IRR is a robust bisection solver
// (no artificial cap), the tax base is the contractor profit share (costs
// are compensated via cost recovery; the old opex/2 halving is gone), and
// the RRT capital uplift is a regime parameter (tax.rrtUpliftPct, default
// 20).
//
// E1 (2026-08-29) fixed two defects that survived D1, both found by
// checking the ledger's mass balance against the canonical PSC semantics
// in npvCalculations.js and epe-engine applyPSC:
//
//  1. COST OIL WAS NEVER PAID TO ANYONE. Recovered cost was subtracted
//     from profit oil, and then dropped. It was not credited to the
//     contractor and not counted to the government, so contractor take
//     plus government take came to less than revenue minus costs by
//     exactly the cost recovered. On a normal case that is hundreds of
//     millions of dollars a year evaporating out of the comparison the
//     whole app exists to make. Cost oil is now credited to the
//     contractor, which is what a production sharing contract does and
//     what both canonical engines already did.
//
//  2. OPEX WAS NEVER RECOVERABLE. The cost pool was seeded with capex
//     and nothing was ever added to it, so operating cost was charged
//     as cash but could never be recovered. Both canonical engines put
//     the full cost outflow into the recoverable pool. This one now
//     does too, with the unrecovered balance carried forward.
//
// CONVENTION: discounting here is YEAR-END (t = 1, 2, ...), matching the
// EPE engine. The screening engine in npvCalculations.js discounts
// MID-YEAR, so for identical cash flows its NPV is larger by a factor of
// (1 + r)^0.5. That relation is gated by a test rather than left as a
// surprise.

const PROJECT_LIFE = 25; // years

const generateProductionProfile = (initial, decline) => {
    const profile = [];
    let currentRate = initial;
    for (let year = 1; year <= PROJECT_LIFE; year++) {
        const annualProduction = currentRate * 365;
        profile.push({ year, production: annualProduction });
        currentRate *= (1 - decline / 100);
    }
    return profile;
};

const getPriceForYear = (year, prices) => {
    let applicablePrice = prices[0];
    for (const pricePoint of prices) {
        if (year >= pricePoint.year) {
            applicablePrice = pricePoint;
        } else {
            break;
        }
    }
    return applicablePrice;
};

const getSlidingScaleRoyalty = (oilPrice, royaltyInfo) => {
    if (royaltyInfo.type === 'flat') {
        return royaltyInfo.rate / 100;
    }
    let rate = royaltyInfo.tiers[0].rate;
    for (const tier of royaltyInfo.tiers) {
        if (oilPrice >= tier.threshold) {
            rate = tier.rate;
        }
    }
    return rate / 100;
};

const getTieredSplit = (rFactor, splitInfo) => {
    if (splitInfo.type === 'flat') {
        return splitInfo.split / 100;
    }
    let split = splitInfo.tiers[0].split;
    for (const tier of splitInfo.tiers) {
        if (rFactor >= tier.threshold) {
            split = tier.split;
        }
    }
    return split / 100;
};

export const calculateNPV = (cashFlows, discountRate) => {
    return cashFlows.reduce((npv, cf) => {
        return npv + cf.contractorNCF / Math.pow(1 + discountRate / 100, cf.year);
    }, 0);
};

// Robust IRR by bisection on the NPV(r) sign change. Returns 0 when the
// cash flow never changes sign (no IRR exists) or when NPV(0) < 0 and no
// positive root exists in the searched range. No artificial rate cap.
export const calculateIRR = (cashFlows) => {
    const hasNeg = cashFlows.some(cf => cf.contractorNCF < 0);
    const hasPos = cashFlows.some(cf => cf.contractorNCF > 0);
    if (!hasNeg || !hasPos) return 0;

    const npvAt = (ratePct) => calculateNPV(cashFlows, ratePct);
    if (npvAt(0) <= 0) return 0;

    // Bracket the root: NPV(0) > 0, find an upper rate where NPV < 0.
    let lo = 0;
    let hi = 100; // 100%
    for (let i = 0; i < 10 && npvAt(hi) > 0; i++) hi *= 2;
    if (npvAt(hi) > 0) return hi; // beyond search range; report the bound

    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (npvAt(mid) > 0) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
};


export const calculateCashFlowForRegime = (regime, project, capexMultiplier = 1, priceMultiplier = 1) => {
    const oilProd = generateProductionProfile(project.production.oil.initial, project.production.oil.decline);
    const gasProd = generateProductionProfile(project.production.gas.initial, project.production.gas.decline);
    const nglProd = generateProductionProfile(project.production.ngl.initial, project.production.ngl.decline);

    const totalCapex = (project.costs.capex.drilling + project.costs.capex.facilities + project.costs.capex.subsea) * capexMultiplier;
    // Unrecovered cost carried forward. Costs enter the pool in the year
    // they are incurred (capex AND opex), matching applyPSC.
    let cumulativeCostPool = 0;
    let cumulativeRevenue = 0;
    let cumulativeCosts = 0;
    let cumulativeNCF = 0;
    const annualCashFlows = [];

    for (let year = 1; year <= PROJECT_LIFE; year++) {
        const basePrice = getPriceForYear(year, project.prices);
        const price = { ...basePrice, oil: basePrice.oil * priceMultiplier };
        
        const oilVol = oilProd.find(p => p.year === year)?.production || 0;
        const gasVol = gasProd.find(p => p.year === year)?.production || 0;
        const nglVol = nglProd.find(p => p.year === year)?.production || 0;
        
        const oilRev = (oilVol * price.oil) / 1e6;
        const gasRev = (gasVol * price.gas) / 1e6;
        const nglRev = (nglVol * price.ngl) / 1e6;
        
        const grossRevenue = oilRev + gasRev + nglRev;
        cumulativeRevenue += grossRevenue;
        
        const totalBoe = (oilVol + nglVol) + (gasVol * 1000 / 6000);
        const variableOpex = (totalBoe * project.costs.opex.variable) / 1e6;
        const opex = project.costs.opex.fixed + variableOpex;
        
        const capex = (year === 1) ? totalCapex : 0;
        cumulativeCosts += capex + opex;

        const royaltyRate = getSlidingScaleRoyalty(price.oil, regime.royalty);
        const royalty = grossRevenue * royaltyRate;
        
        const revenueAfterRoyalty = grossRevenue - royalty;
        
        const recoverablePool = cumulativeCostPool + capex + opex;
        const costRecoveryAllowed = revenueAfterRoyalty * (regime.costRecoveryLimit / 100);
        const costRecovered = Math.min(recoverablePool, costRecoveryAllowed);
        cumulativeCostPool = recoverablePool - costRecovered;

        const profitOil = Math.max(0, revenueAfterRoyalty - costRecovered);
        
        const rFactor = cumulativeCosts > 0 ? cumulativeRevenue / cumulativeCosts : 0;
        const contractorProfitSplit = getTieredSplit(rFactor, regime.profitSplit);
        
        const contractorProfitShare = profitOil * contractorProfitSplit;
        const governmentProfitShare = profitOil * (1 - contractorProfitSplit);
        
        // Tax base is the contractor's profit share. Costs are already
        // compensated through cost recovery, so no further opex deduction
        // here (the old `- opex / 2` was an invented halving, removed D1).
        const taxableIncome = contractorProfitShare;
        const cit = taxableIncome > 0 ? taxableIncome * (regime.tax.cit / 100) : 0;
        // RRT base allows an annual capital uplift (screening approximation
        // of an uplifted cost pool); rate is a regime parameter, default 20%.
        const rrtUpliftPct = regime.tax.rrtUpliftPct ?? 20;
        const rrtBase = taxableIncome - (totalCapex * rrtUpliftPct / 100);
        const rrt = rrtBase > 0 ? rrtBase * (regime.tax.rrt / 100) : 0;
        const minTax = grossRevenue * (regime.tax.minTax / 100);
        const tax = Math.max(cit + rrt, minTax);

        // The contractor receives cost oil AND its profit share, and pays
        // the costs and the tax. Dropping the cost-oil term (as this did
        // before E1) makes revenue disappear from the ledger entirely.
        const contractorNCF = costRecovered + contractorProfitShare - tax - opex - capex;
        const governmentTake = royalty + governmentProfitShare + tax;
        
        cumulativeNCF += contractorNCF;

        annualCashFlows.push({
            year,
            grossRevenue,
            royalty,
            costRecovered,
            unrecoveredCostPool: cumulativeCostPool,
            profitOil,
            tax,
            opex,
            capex,
            contractorNCF,
            governmentTake,
            cumulativeNCF,
            rFactor,
        });
    }
    return annualCashFlows;
};

const runSensitivityAnalysis = (regimes, projectInputs) => {
    const priceSens = { labels: [], data: regimes.map(r => ({ regimeId: r.id, values: [] })) };
    for (let price = 40; price <= 120; price += 10) {
        priceSens.labels.push(price);
        regimes.forEach(regime => {
            const cashflows = calculateCashFlowForRegime(regime, projectInputs, 1, price / projectInputs.prices[0].oil);
            const totalGovTake = cashflows.reduce((sum, cf) => sum + cf.governmentTake, 0);
            const totalContractorTake = cashflows.reduce((sum, cf) => sum + cf.contractorNCF, 0);
            const totalProfit = totalGovTake + totalContractorTake;
            const effectiveTaxRate = totalProfit > 0 ? (totalGovTake / totalProfit) * 100 : 0;
            priceSens.data.find(d => d.regimeId === regime.id).values.push(effectiveTaxRate);
        });
    }

    const capexSens = { labels: [], data: regimes.map(r => ({ regimeId: r.id, values: [] })) };
    for (let multiplier = 0.8; multiplier <= 1.5; multiplier += 0.1) {
        capexSens.labels.push(multiplier.toFixed(1));
        regimes.forEach(regime => {
            const cashflows = calculateCashFlowForRegime(regime, projectInputs, multiplier, 1);
            const npv = calculateNPV(cashflows, projectInputs.discountRate);
            capexSens.data.find(d => d.regimeId === regime.id).values.push(npv);
        });
    }

    return { price: priceSens, capex: capexSens };
};

/**
 * Derive the comparison's conclusions FROM the comparison (Economics E2).
 *
 * The Insights tab used to state four conclusions of which three were never
 * computed. Because the summary is sorted by contractor NPV, it declared the
 * top-NPV regime to also have the fastest payback, the SECOND-ranked regime
 * to maximize government revenue "significantly higher than other options",
 * and asserted a capex-resilience and a price-response ranking that nothing
 * in the app had worked out. All four now come from the numbers, and any
 * claim that cannot be supported is omitted rather than guessed.
 *
 * @param {object[]} summary per-regime results, sorted by NPV descending
 * @param {object} sensitivityData the price and capex sweeps
 * @returns {{key: string, label: string, text: string}[]}
 */
export const deriveInsights = (summary, sensitivityData) => {
    const out = [];
    if (!summary?.length) return out;

    const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

    const best = summary[0];
    out.push({
        key: 'npv',
        label: 'Best for the contractor',
        text: `"${best.name}" delivers the highest contractor NPV at $${fmt(best.npv)}MM, with an IRR of ${fmt(best.irr)}%.`,
    });

    // Fastest payback, over the regimes that pay back at all.
    const paying = summary.filter((r) => Number.isFinite(r.paybackPeriod));
    if (paying.length > 0) {
        const fastest = paying.reduce((a, b) => (b.paybackPeriod < a.paybackPeriod ? b : a));
        const rest = paying.filter((r) => r.id !== fastest.id);
        const slowest = rest.length
            ? rest.reduce((a, b) => (b.paybackPeriod > a.paybackPeriod ? b : a))
            : null;
        out.push({
            key: 'payback',
            label: 'Fastest capital recovery',
            text: slowest
                ? `"${fastest.name}" pays back in year ${fastest.paybackPeriod}, against year ${slowest.paybackPeriod} for "${slowest.name}".`
                : `"${fastest.name}" pays back in year ${fastest.paybackPeriod}. No other regime pays back within the project life.`,
        });
    } else {
        out.push({
            key: 'payback',
            label: 'Capital recovery',
            text: 'No regime pays back within the project life on these inputs.',
        });
    }

    // Highest total government take.
    const topGov = summary.reduce((a, b) => (b.govTake > a.govTake ? b : a));
    const others = summary.filter((r) => r.id !== topGov.id);
    const nextGov = others.length
        ? others.reduce((a, b) => (b.govTake > a.govTake ? b : a))
        : null;
    out.push({
        key: 'government',
        label: 'Best for the government',
        text: nextGov
            ? `"${topGov.name}" collects the most, $${fmt(topGov.govTake)}MM against $${fmt(nextGov.govTake)}MM for the next highest, "${nextGov.name}".`
            : `"${topGov.name}" collects $${fmt(topGov.govTake)}MM in total government take.`,
    });

    // Capex resilience: how much NPV is lost across the swept multiplier range.
    const capexSeries = sensitivityData?.capex?.data || [];
    const losses = capexSeries
        .map((d) => {
            const v = d.values || [];
            if (v.length < 2) return null;
            const regime = summary.find((r) => r.id === d.regimeId);
            return regime ? { name: regime.name, loss: v[0] - v[v.length - 1] } : null;
        })
        .filter(Boolean);
    if (losses.length >= 2) {
        const toughest = losses.reduce((a, b) => (b.loss < a.loss ? b : a));
        const weakest = losses.reduce((a, b) => (b.loss > a.loss ? b : a));
        out.push({
            key: 'capex',
            label: 'Resilience to cost overrun',
            text: `Over the swept capex range, "${toughest.name}" gives up the least contractor NPV ($${fmt(toughest.loss)}MM) and "${weakest.name}" the most ($${fmt(weakest.loss)}MM).`,
        });
    }

    // Price response: which regime's government share climbs fastest.
    const priceSeries = sensitivityData?.price?.data || [];
    const climbs = priceSeries
        .map((d) => {
            const v = d.values || [];
            if (v.length < 2) return null;
            const regime = summary.find((r) => r.id === d.regimeId);
            return regime ? { name: regime.name, climb: v[v.length - 1] - v[0] } : null;
        })
        .filter(Boolean);
    if (climbs.length >= 2) {
        const steepest = climbs.reduce((a, b) => (b.climb > a.climb ? b : a));
        out.push({
            key: 'price',
            label: 'Response to higher prices',
            text: `"${steepest.name}" is the most progressive: its government share rises ${fmt(steepest.climb)} percentage points across the swept price range, so it captures upside fastest.`,
        });
    }

    return out;
};

export const runFiscalComparison = async (inputs) => {
    const { projectInputs, regimes } = inputs;
    const summary = [];
    const annualCashFlows = [];

    regimes.forEach(regime => {
        const cashflows = calculateCashFlowForRegime(regime, projectInputs);
        annualCashFlows.push({ regimeId: regime.id, data: cashflows });

        const contractorNPV = calculateNPV(cashflows, projectInputs.discountRate);
        const irr = calculateIRR(cashflows);
        const payback = cashflows.find(cf => cf.cumulativeNCF > 0);
        const rFactorPayout = cashflows.find(cf => cf.rFactor > 1.0);

        const totalGovTake = cashflows.reduce((sum, cf) => sum + cf.governmentTake, 0);
        const totalCapex = (projectInputs.costs.capex.drilling + projectInputs.costs.capex.facilities + projectInputs.costs.capex.subsea);
        const totalContractorTake = cashflows.reduce((sum, cf) => sum + cf.contractorNCF, 0) + totalCapex;
        const totalProfit = totalGovTake + totalContractorTake;
        const effectiveTaxRate = totalProfit > 0 ? (totalGovTake / totalProfit) * 100 : 0;
        
        summary.push({
            id: regime.id,
            name: regime.name,
            npv: contractorNPV,
            irr: irr,
            paybackPeriod: payback ? payback.year : null,
            rFactorPayoutYear: rFactorPayout ? rFactorPayout.year : null,
            govTake: totalGovTake,
            effectiveTaxRate: effectiveTaxRate
        });
    });

    const sensitivityData = runSensitivityAnalysis(regimes, projectInputs);

    summary.sort((a,b) => b.npv - a.npv);

    return {
        summary,
        annualCashFlows,
        sensitivityData,
        insights: deriveInsights(summary, sensitivityData),
    };
};