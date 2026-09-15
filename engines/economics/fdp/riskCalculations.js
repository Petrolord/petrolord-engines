/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/riskCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). The only edit is the import: '@/data/fdp/RiskManagementModel' became './riskModel.js' (that data file copied whole beside this one).
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * Risk Calculations Utility
 * Metrics, scoring, and aggregation for risk management.
 */

import { getRiskLevel, riskScore } from './riskModel.js';

/**
 * EC6-1: the sum of the scored risks. This used to multiply the factors
 * without coercion, so one risk missing a probability made the whole
 * register's score NaN (FINDINGS-fdp.md section 10).
 */
export const calculateConsolidatedRiskScore = (risks = []) => {
    if (!risks.length) return 0;
    return risks.reduce((sum, risk) => sum + (riskScore(risk) ?? 0), 0);
};

/** How many risks in the register have not been scored. */
export const countUnscoredRisks = (risks = []) => risks.filter((r) => riskScore(r) === null).length;

export const calculateRiskExposure = (risks = []) => {
    // Expected Monetary Value (EMV) approximation
    // Using simple probability factors based on 1-5 scale
    const probFactors = { 1: 0.05, 2: 0.20, 3: 0.40, 4: 0.60, 5: 0.85 };
    
    return risks.reduce((total, risk) => {
        const prob = probFactors[risk.probability] || 0;
        const cost = parseFloat(risk.costImpact) || 0;
        return total + (prob * cost);
    }, 0);
};

export const aggregateRisksBySource = (risks = []) => {
    return risks.reduce((acc, risk) => {
        const source = risk.source || 'Other';
        acc[source] = (acc[source] || 0) + 1;
        return acc;
    }, {});
};

export const aggregateRisksByLevel = (risks = []) => {
    const levels = { Critical: 0, High: 0, Medium: 0, Low: 0, Unscored: 0 };
    risks.forEach(risk => {
        const score = riskScore(risk);
        if (score === null) {
            levels.Unscored++;
            return;
        }
        const { level } = getRiskLevel(score);
        if (levels[level] !== undefined) levels[level]++;
    });
    return levels;
};

/**
 * A health score over the SCORED risks. An unscored risk cannot improve it:
 * before EC6-1 it counted as Low and did exactly that.
 */
export const calculatePortfolioHealth = (risks = []) => {
    const levels = aggregateRisksByLevel(risks);
    const total = risks.length - levels.Unscored;
    if (total <= 0) return 100;

    // Weighted penalty for high risks
    const penalty = (levels.Critical * 10) + (levels.High * 5) + (levels.Medium * 2);
    const health = Math.max(0, 100 - (penalty / total) * 10); 
    return Math.round(health);
};