/**
 * Vendored from the Suite's src/utils/fdp/facilitiesCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08), repaired since in EC6-1 (decommissioning) and EC6-2 (the
 * flow assurance score). The gates in __tests__/economics.fdp.test.js and the independent
 * oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * Facilities Calculations Utility
 * Estimates for capacity, costs, and flow assurance risks.
 */

export const calculateFacilityCapacity = (facility, wells) => {
    // Mock calculation based on facility type and wells
    const baseCapacity = parseFloat(facility.nameplateCapacity) || 100000; // bbl/d
    const utilization = 0.85; // 85% efficiency
    
    return {
        oilCapacity: baseCapacity,
        gasCapacity: baseCapacity * 1.5, // scf/bbl approx
        waterHandling: baseCapacity * 0.8,
        effectiveCapacity: baseCapacity * utilization
    };
};

export const calculateFacilityCost = (facility) => {
    let capex = 0;
    let opex = 0;

    switch(facility.type) {
        case 'FPSO':
            capex = 1200; // MM$
            opex = 50; // MM$/yr
            break;
        case 'Platform':
            capex = 800;
            opex = 30;
            break;
        case 'Subsea Tie-back':
            capex = 300;
            opex = 15;
            break;
        default:
            capex = 500;
            opex = 25;
    }

    // Adjust for size
    const sizeMultiplier = (parseFloat(facility.nameplateCapacity) || 50000) / 50000;
    const sizedCapex = capex * Math.pow(sizeMultiplier, 0.7); // Economy of scale

    // EC6-1 (FINDINGS-fdp.md section 12): decommissioning was 15 percent of
    // the UNSCALED base, so a 150,000 bbl/d FPSO was decommissioned for the
    // same $180MM as a 50,000 bbl/d one. It is 15 percent of the capex this
    // facility actually carries.
    return {
        capex: sizedCapex,
        opex: opex * Math.pow(sizeMultiplier, 0.6),
        decommissioning: sizedCapex * 0.15
    };
};

/**
 * Flow assurance screening: a hazard score and the hazards that produced it.
 *
 * Three triggers add to the score. A subsea tie-back adds 3 (hydrates and
 * wax), oil below 25 API adds 2 (viscosity), any H2S adds 4 (corrosion).
 * Each entry in `contributions` names its trigger, its points and its
 * hazards, and the points sum to `score`.
 *
 * EC6-2 (FINDINGS-fdp.md). The result used to carry a `level` of Low,
 * Medium or High, banded at score > 2 and score > 5. Those are the words
 * of the risk register's scale (riskModel.js getRiskLevel: 20 Critical,
 * 12 High, 6 Medium), where they band probability x impact, a different
 * quantity. A tie-back scored 3 read Medium here and Low on the register.
 * The key is retired and absent: the score and its named hazards are the
 * answer, and nothing on this screen borrows the register's vocabulary.
 *
 * @param {object} facility
 * @param {object} [fluidProperties]
 * @returns {{score: number, hazards: string[], contributions: object[], risks: object[]}}
 */
export const calculateFlowAssuranceRisk = (facility, fluidProperties) => {
    let riskScore = 0;
    const risks = [];
    const contributions = [];

    if (facility.type === 'Subsea Tie-back') {
        riskScore += 3;
        risks.push({ type: 'Hydrates', severity: 'High', mitigation: 'MEG Injection' });
        risks.push({ type: 'Wax', severity: 'Medium', mitigation: 'Insulation' });
        contributions.push({ trigger: 'Subsea tie-back', points: 3, hazards: ['Hydrates', 'Wax'] });
    }

    if (fluidProperties?.api < 25) {
        riskScore += 2;
        risks.push({ type: 'Viscosity', severity: 'Medium', mitigation: 'Heating' });
        contributions.push({ trigger: 'Oil below 25 API', points: 2, hazards: ['Viscosity'] });
    }

    if ((fluidProperties?.h2s || 0) > 0) {
        riskScore += 4;
        risks.push({ type: 'Corrosion', severity: 'High', mitigation: 'CRA Materials' });
        contributions.push({ trigger: 'H2S present', points: 4, hazards: ['Corrosion'] });
    }

    return {
        score: riskScore,
        hazards: risks.map((r) => r.type),
        contributions,
        risks
    };
};

export const identifyBottlenecks = (facility, peakProduction) => {
    const capacity = calculateFacilityCapacity(facility);
    const bottlenecks = [];

    if (peakProduction.oil > capacity.oilCapacity) {
        bottlenecks.push('Oil Separation Capacity Exceeded');
    }
    if (peakProduction.gas > capacity.gasCapacity) {
        bottlenecks.push('Gas Compression Limits');
    }
    if (peakProduction.water > capacity.waterHandling) {
        bottlenecks.push('Produced Water Treatment Constraint');
    }

    return bottlenecks;
};