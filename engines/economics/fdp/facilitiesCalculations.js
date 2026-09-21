/**
 * Vendored from the Suite's src/utils/fdp/facilitiesCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08), repaired since in EC6-1 (decommissioning), EC6-2 (the
 * flow assurance score) and EC6-3 (the corrosion screen on H2S partial pressure). The gates in __tests__/economics.fdp.test.js and the independent
 * oracle tools/validation/economics/oracle_fdp.py cover it.
 */
import { FdpInputError, isBlank, requireNonNegative, requireNumber } from './inputError.js';
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
 * EC6-3 (owner decision 2026-09-15). The sour service threshold of NACE
 * MR0175 / ISO 15156: an H2S partial pressure of 0.05 psia (the standard
 * states it as 0.3 kPa in SI). At or above it, materials in contact with
 * the fluid must be qualified for sour service.
 */
export const SOUR_SERVICE_THRESHOLD_PSIA = 0.05;
export const SOUR_SERVICE_THRESHOLD_KPA = 0.3;
export const SOUR_SERVICE_STANDARD = 'NACE MR0175 / ISO 15156';
/** kPa in one psi: 0.45359237 kg x 9.80665 m/s2 over (0.0254 m)^2, in kPa. */
export const KPA_PER_PSI = 6.894757293168361;

/** The statuses the corrosion screen reports. */
export const CORROSION_STATUSES = [
    'not-measured', 'sour-severity-needs-pressure', 'below-sour-threshold', 'sour-service',
];

const fmt4 = (n) => n.toFixed(4);

/**
 * The corrosion screen: is the fluid in sour service?
 *
 * Units. `h2s` is the H2S concentration in ppm by mole (ppmv in the gas).
 * `operatingPressurePsia` is the total operating pressure in psia. The
 * mole fraction is ppm / 1,000,000 and the partial pressure is the mole
 * fraction times the total pressure, in psia; kPa is psia x 6.894757.
 *
 *   h2s blank or absent               'not-measured' (no severity, no points)
 *   h2s measured, pressure blank      'sour-severity-needs-pressure' (no
 *                                     points yet). A measured 0 ppm needs no
 *                                     pressure: its partial pressure is 0 at
 *                                     any pressure, so it is below the threshold.
 *   partial pressure below 0.05 psia  'below-sour-threshold'
 *   partial pressure 0.05 psia or up  'sour-service' (the corrosion trigger)
 *
 * A negative or unreadable H2S figure, or a pressure that is unreadable or
 * not above zero, is refused by name.
 *
 * @param {object} [fluidProperties]
 * @returns {{status: string, h2sPpm: number|null, operatingPressurePsia: number|null,
 *   h2sPartialPressurePsia: number|null, h2sPartialPressureKpa: number|null,
 *   thresholdPsia: number, thresholdKpa: number, standard: string, message: string}}
 */
export const screenSourService = (fluidProperties) => {
    const base = {
        thresholdPsia: SOUR_SERVICE_THRESHOLD_PSIA,
        thresholdKpa: SOUR_SERVICE_THRESHOLD_KPA,
        standard: SOUR_SERVICE_STANDARD,
    };
    const rawPressure = fluidProperties?.operatingPressurePsia;
    let pressure = null;
    if (!isBlank(rawPressure)) {
        pressure = requireNumber(rawPressure, 'the operating pressure (psia)');
        if (!(pressure > 0)) {
            throw new FdpInputError(`the operating pressure (psia) must be above zero: ${pressure}`);
        }
    }
    if (isBlank(fluidProperties?.h2s)) {
        return {
            status: 'not-measured',
            h2sPpm: null,
            operatingPressurePsia: pressure,
            h2sPartialPressurePsia: null,
            h2sPartialPressureKpa: null,
            ...base,
            message: 'H2S is not measured, so the corrosion screen has not run. '
                + 'Enter the H2S concentration in ppm and the operating pressure in psia.',
        };
    }
    const h2sPpm = requireNonNegative(fluidProperties.h2s, 'the H2S concentration (ppm)');
    if (pressure === null && h2sPpm > 0) {
        return {
            status: 'sour-severity-needs-pressure',
            h2sPpm,
            operatingPressurePsia: null,
            h2sPartialPressurePsia: null,
            h2sPartialPressureKpa: null,
            ...base,
            message: `H2S is measured at ${h2sPpm} ppm. Sour service depends on the H2S partial pressure, `
                + 'so enter the operating pressure in psia to screen it.',
        };
    }
    const psia = pressure === null ? 0 : (h2sPpm / 1e6) * pressure;
    const kpa = psia * KPA_PER_PSI;
    const sour = psia >= SOUR_SERVICE_THRESHOLD_PSIA;
    const at = pressure === null ? `${h2sPpm} ppm` : `${h2sPpm} ppm and ${pressure} psia`;
    return {
        status: sour ? 'sour-service' : 'below-sour-threshold',
        h2sPpm,
        operatingPressurePsia: pressure,
        h2sPartialPressurePsia: psia,
        h2sPartialPressureKpa: kpa,
        ...base,
        message: `H2S partial pressure is ${fmt4(psia)} psia (${fmt4(kpa)} kPa) at ${at}, `
            + (sour
                ? `at or above the ${SOUR_SERVICE_STANDARD} sour service threshold of 0.05 psia (0.3 kPa). `
                  + 'Materials in contact with the fluid must be qualified for sour service.'
                : `below the ${SOUR_SERVICE_STANDARD} sour service threshold of 0.05 psia (0.3 kPa).`),
    };
};

/**
 * Flow assurance screening: a hazard score and the hazards that produced it.
 *
 * Three triggers add to the score. A subsea tie-back adds 3 (hydrates and
 * wax), oil below 25 API adds 2 (viscosity), and a fluid in sour service
 * adds 4 (corrosion). Each entry in `contributions` names its trigger, its
 * points and its hazards, and the points sum to `score`. `corrosion` is the
 * sour service screen behind the third trigger (screenSourService).
 *
 * EC6-2 (FINDINGS-fdp.md). The result used to carry a `level` of Low,
 * Medium or High, banded at score > 2 and score > 5. Those are the words
 * of the risk register's scale (riskModel.js getRiskLevel: 20 Critical,
 * 12 High, 6 Medium), where they band probability x impact, a different
 * quantity. A tie-back scored 3 read Medium here and Low on the register.
 * The key is retired and absent: the score and its named hazards are the
 * answer, and nothing on this screen borrows the register's vocabulary.
 *
 * EC6-3 (FINDINGS-fdp.md). The corrosion trigger was 'H2S present': any H2S
 * above zero added 4 points and a High corrosion risk, and a blank H2S read
 * as 0, so an unmeasured fluid read as sweet and 1 ppm at 100 psia read as
 * severe as 5 percent at 5000 psia. That trigger label is retired. The
 * trigger is now 'H2S partial pressure at or above 0.05 psia' and fires only
 * on status 'sour-service'; every other status adds no points and says why
 * in `corrosion.message`.
 *
 * @param {object} facility
 * @param {object} [fluidProperties] api, h2s (ppm), operatingPressurePsia
 * @returns {{score: number, hazards: string[], contributions: object[], risks: object[], corrosion: object}}
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

    const corrosion = screenSourService(fluidProperties);
    if (corrosion.status === 'sour-service') {
        riskScore += 4;
        risks.push({ type: 'Corrosion', severity: 'High', mitigation: 'CRA Materials' });
        contributions.push({
            trigger: 'H2S partial pressure at or above 0.05 psia', points: 4, hazards: ['Corrosion'],
        });
    }

    return {
        score: riskScore,
        hazards: risks.map((r) => r.type),
        contributions,
        risks,
        corrosion
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