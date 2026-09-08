/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/facilitiesCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). No edit at all beyond this header: the module has no imports.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
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
    
    return {
        capex: capex * Math.pow(sizeMultiplier, 0.7), // Economy of scale
        opex: opex * Math.pow(sizeMultiplier, 0.6),
        decommissioning: capex * 0.15
    };
};

export const calculateFlowAssuranceRisk = (facility, fluidProperties) => {
    // Simple risk scoring based on fluid props and facility type
    let riskScore = 0;
    const risks = [];

    if (facility.type === 'Subsea Tie-back') {
        riskScore += 3;
        risks.push({ type: 'Hydrates', severity: 'High', mitigation: 'MEG Injection' });
        risks.push({ type: 'Wax', severity: 'Medium', mitigation: 'Insulation' });
    }

    if (fluidProperties?.api < 25) {
        riskScore += 2;
        risks.push({ type: 'Viscosity', severity: 'Medium', mitigation: 'Heating' });
    }

    if ((fluidProperties?.h2s || 0) > 0) {
        riskScore += 4;
        risks.push({ type: 'Corrosion', severity: 'High', mitigation: 'CRA Materials' });
    }

    return {
        score: riskScore,
        level: riskScore > 5 ? 'High' : riskScore > 2 ? 'Medium' : 'Low',
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