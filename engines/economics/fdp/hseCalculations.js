/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/hseCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). No edit at all beyond this header: the module has no imports.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * HSE Calculations Utility
 */

export const calculateRiskMatrix = (risks) => {
    const matrix = {
        low: 0,
        medium: 0,
        high: 0,
        total: risks.length
    };

    risks.forEach(risk => {
        const score = (risk.probability || 0) * (risk.impact || 0);
        if (score >= 15) matrix.high++;
        else if (score >= 8) matrix.medium++;
        else matrix.low++;
    });

    return matrix;
};

export const calculateTotalRiskScore = (risks) => {
    return risks.reduce((sum, risk) => sum + ((risk.probability || 0) * (risk.impact || 0)), 0);
};

export const aggregateRisksByType = (risks) => {
    const types = {};
    risks.forEach(risk => {
        const type = risk.type || 'Other';
        if (!types[type]) types[type] = 0;
        types[type]++;
    });
    return types;
};

export const calculateComplianceScore = (checklist) => {
    if (!checklist || checklist.length === 0) return 0;
    const completed = checklist.filter(item => item.status === 'Compliant').length;
    return Math.round((completed / checklist.length) * 100);
};