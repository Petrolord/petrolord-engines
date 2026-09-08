/**
 * VENDORED VERBATIM from the Suite's src/data/fdp/RiskManagementModel.js in the EC0 Economics
 * extraction wave (2026-09-08). Copied whole (75 lines) because riskCalculations imports getRiskLevel from it. No edit beyond this header. createRisk carries Date.now and Math.random and is not part of any gate.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * Risk Management Data Model
 * Standardized structure for risks across the FDP lifecycle.
 */

export const RiskTypes = {
    TECHNICAL: 'Technical',
    SUBSURFACE: 'Subsurface',
    DRILLING: 'Drilling',
    FACILITIES: 'Facilities',
    SCHEDULE: 'Schedule',
    COST: 'Cost',
    HSE: 'HSE',
    COMMERCIAL: 'Commercial',
    POLITICAL: 'Political'
};

export const RiskCategories = {
    HAZARD: 'Hazard',
    UNCERTAINTY: 'Uncertainty',
    OPPORTUNITY: 'Opportunity', // Positive risk
    CONSTRAINT: 'Constraint'
};

export const RiskStatus = {
    IDENTIFIED: 'Identified',
    ASSESSED: 'Assessed',
    MITIGATED: 'Mitigated',
    ACTIVE: 'Active',
    CLOSED: 'Closed',
    ESCALATED: 'Escalated'
};

export const RiskImpact = {
    1: 'Negligible',
    2: 'Minor',
    3: 'Moderate',
    4: 'Major',
    5: 'Catastrophic'
};

export const RiskProbability = {
    1: 'Rare (<10%)',
    2: 'Unlikely (10-30%)',
    3: 'Possible (30-50%)',
    4: 'Likely (50-70%)',
    5: 'Almost Certain (>70%)'
};

export const createRisk = (data = {}) => ({
    id: data.id || `risk-${Date.now()}-${Math.floor(Math.random()*1000)}`,
    name: data.name || '',
    description: data.description || '',
    type: data.type || RiskTypes.TECHNICAL,
    category: data.category || RiskCategories.HAZARD,
    probability: data.probability || 3, // 1-5
    impact: data.impact || 3, // 1-5
    score: (data.probability || 3) * (data.impact || 3),
    mitigationStrategy: data.mitigationStrategy || '',
    contingencyPlan: data.contingencyPlan || '',
    owner: data.owner || 'Project Manager',
    status: data.status || RiskStatus.IDENTIFIED,
    source: data.source || 'Manual', // e.g., 'Drilling Module', 'HSE Module'
    sourceId: data.sourceId || null, // Link back to original item
    costImpact: data.costImpact || 0, // Estimated $MM
    scheduleImpact: data.scheduleImpact || 0, // Estimated days
    createdDate: data.createdDate || new Date().toISOString(),
    modifiedDate: new Date().toISOString()
});

export const getRiskLevel = (score) => {
    if (score >= 20) return { level: 'Critical', color: 'bg-red-600', text: 'text-red-600' };
    if (score >= 12) return { level: 'High', color: 'bg-orange-500', text: 'text-orange-500' };
    if (score >= 6) return { level: 'Medium', color: 'bg-yellow-500', text: 'text-yellow-500' };
    return { level: 'Low', color: 'bg-green-500', text: 'text-green-500' };
};