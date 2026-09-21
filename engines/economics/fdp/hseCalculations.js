/**
 * EC6-1. This module used to band risk on 15 and 8 while the risk register
 * banded the same score on 20, 12 and 6 and the matrix cells coloured on 15,
 * 8 and 4, so one risk scored 12 read High on the register, Medium on the
 * HSE tab and orange in the matrix. There is one scale now, `getRiskLevel`
 * in riskModel.js, and every count in the module comes from it.
 */
import { getRiskLevel, riskScore } from './riskModel.js';
/**
 * HSE Calculations Utility
 */

/**
 * Count the register by band, on the one scale.
 *
 * `unscored` counts the risks that carry no probability or no impact. They
 * used to be scored as zero and counted as Low, which made a register look
 * safer the less of it had been filled in.
 *
 * @param {object[]} risks
 * @returns {{low: number, medium: number, high: number, critical: number,
 *   unscored: number, total: number}}
 */
export const calculateRiskMatrix = (risks) => {
    const matrix = {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
        unscored: 0,
        total: risks.length
    };

    risks.forEach(risk => {
        const score = riskScore(risk);
        if (score === null) {
            matrix.unscored++;
            return;
        }
        matrix[getRiskLevel(score).level.toLowerCase()]++;
    });

    return matrix;
};

/** The sum of the scored risks' scores. An unscored risk adds nothing. */
export const calculateTotalRiskScore = (risks) => {
    return risks.reduce((sum, risk) => sum + (riskScore(risk) ?? 0), 0);
};

/** Own-property access. `obj[key]` walks the prototype chain, so a caller
 *  name of 'constructor', 'toString', 'valueOf', 'hasOwnProperty' or
 *  '__proto__' reads an inherited member, and writing '__proto__' replaces
 *  the prototype instead of storing a row. */
const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);
const ownValue = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);
const setOwn = (obj, key, value) => Object.defineProperty(obj, key, {
  value, writable: true, enumerable: true, configurable: true,
});

export const aggregateRisksByType = (risks) => {
    const types = {};
    risks.forEach(risk => {
        const type = risk.type || 'Other';
        setOwn(types, type, (ownValue(types, type) || 0) + 1);
    });
    return types;
};

export const calculateComplianceScore = (checklist) => {
    if (!checklist || checklist.length === 0) return 0;
    const completed = checklist.filter(item => item.status === 'Compliant').length;
    return Math.round((completed / checklist.length) * 100);
};