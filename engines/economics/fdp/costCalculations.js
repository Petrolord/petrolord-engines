/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/costCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). The only edit is the import: '@/utils/fdp/economics' became './economics.js'.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * FDP cost aggregation and economics.
 *
 * Economics E1: the economics here are computed by the sanctioned
 * screening engine through `runFdpCase`, not by a private NPV. See
 * src/utils/fdp/economics.js for what changed and why.
 */

import { runFdpCase, DEFAULT_FISCAL } from './economics.js';

export const calculateTotalCAPEX = (costItems) => {
    if (!costItems) return 0;
    return costItems
        .filter(item => item.type === 'CAPEX')
        .reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
};

export const calculateTotalOPEX = (costItems) => {
    if (!costItems) return 0;
    return costItems
        .filter(item => item.type === 'OPEX')
        .reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
};

export const calculateCostByPhase = (costItems) => {
    const phases = {};
    costItems.forEach(item => {
        const phase = item.phase || 'Unassigned';
        if (!phases[phase]) phases[phase] = 0;
        phases[phase] += (parseFloat(item.amount) || 0);
    });
    return phases;
};

/**
 * Build an FDP cash flow.
 *
 * Economics E1: this used to compute revenue minus operating cost and
 * call the result a cash flow. There was no royalty and no tax in it at
 * all, so the NPV card above it was a pre-fiscal number roughly forty
 * percent too high on ordinary Nigerian terms. It now runs through
 * `runFdpCase` and the sanctioned screening engine.
 *
 * @param {number} capex total development capex, $MM
 * @param {number} annualOpex fixed operating cost, $MM per year
 * @param {number[]} productionProfile daily rate per producing year, kbpd
 * @param {object[]} priceDeck rows carrying `oil_price_usd`
 * @param {object} [fiscal] overrides for DEFAULT_FISCAL
 * @returns {object[]} rows shaped for the economics charts
 */
export const calculateCashFlows = (capex, annualOpex, productionProfile, priceDeck, fiscal = {}) => {
    const prices = productionProfile.map((_, i) => priceDeck[i]?.oil_price_usd ?? 70);
    const result = runFdpCase({
        capexMM: capex,
        annualOpexMM: annualOpex,
        productionKbpd: productionProfile,
        pricesUsd: prices,
        fiscal,
    });
    const rate = (fiscal.discountRate ?? DEFAULT_FISCAL.discountRate) / 100;
    return result.cashflow.map((cf, i) => ({
        year: i,
        revenue: cf.grossRevenue,
        royalty: cf.royalty,
        tax: cf.tax,
        capex: cf.capex,
        opex: cf.opex,
        netCashFlow: cf.ncf,
        cumulativeCashFlow: cf.cumulativeNCF,
        // Mid-year, matching the engine that produced the cash flow.
        discountedCashFlow: cf.ncf / (1 + rate) ** (i + 0.5),
    }));
};

/** NPV in $MM, post royalty and tax. */
export const calculateNPV = (cashFlows) =>
    cashFlows.reduce((sum, cf) => sum + cf.discountedCashFlow, 0);

/**
 * IRR in percent.
 *
 * The Newton-Raphson loop this replaces had no bracket and no guard: on a
 * cash flow that never changes sign it walked off to whatever the
 * derivative sent it to and returned that as an IRR. Bisection on the
 * sign change cannot do that, and an IRR that does not exist is reported
 * as null rather than invented.
 */
export const calculateIRR = (cashFlows) => {
    const flows = cashFlows.map((cf) => cf.netCashFlow);
    const npvAt = (r) => flows.reduce((sum, f, t) => sum + f / (1 + r) ** (t + 0.5), 0);
    if (!flows.some((f) => f < 0) || !flows.some((f) => f > 0)) return null;
    if (npvAt(0) <= 0) return null;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20 && npvAt(hi) > 0; i += 1) hi *= 2;
    if (npvAt(hi) > 0) return hi * 100;
    for (let i = 0; i < 100; i += 1) {
        const mid = (lo + hi) / 2;
        if (npvAt(mid) > 0) lo = mid; else hi = mid;
    }
    return ((lo + hi) / 2) * 100;
};

/** Years to payback, or null when it never pays back. */
export const calculatePaybackPeriod = (cashFlows) => {
    for (let i = 0; i < cashFlows.length; i += 1) {
        if (cashFlows[i].cumulativeCashFlow >= 0) {
            if (i === 0) return 0;
            const prev = cashFlows[i - 1].cumulativeCashFlow;
            const curr = cashFlows[i].netCashFlow;
            // Part way THROUGH period i, so the count starts at i.
            return curr > 0 ? i + Math.abs(prev) / curr : i;
        }
    }
    return null;
};
