/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/subsurfaceCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). No edit at all beyond this header: the module has no imports.
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * Subsurface Calculations Utility
 * Standard formulas for reservoir engineering calculations.
 */

export const calculateRecoveryFactor = (ooip, recoverable) => {
    if (!ooip || ooip === 0) return 0;
    return (recoverable / ooip);
};

export const calculateOOIP = (area, thickness, porosity, saturation, formationVolumeFactor = 1.2) => {
    // OOIP (STB) = 7758 * A * h * phi * (1-Sw) / Boi
    // Area in acres, thickness in ft
    if (!formationVolumeFactor || formationVolumeFactor === 0) return 0;
    return (7758 * area * thickness * porosity * (1 - saturation)) / formationVolumeFactor;
};

export const calculateRecoverableReserves = (ooip, recoveryFactor) => {
    return ooip * recoveryFactor;
};

export const calculatePressureGradient = (pressure1, depth1, pressure2, depth2) => {
    // Returns psi/ft
    if (depth2 === depth1) return 0;
    return (pressure2 - pressure1) / (depth2 - depth1);
};

export const calculateTemperatureGradient = (temp1, depth1, temp2, depth2) => {
    // Returns degF/100ft usually, but let's do deg/unit depth
    if (depth2 === depth1) return 0;
    return (temp2 - temp1) / (depth2 - depth1);
};

export const calculateRiskScore = (probability, impact) => {
    // Standard Risk Score Matrix 1-25
    return probability * impact;
};

export const aggregateReserves = (reservoirs) => {
    return reservoirs.reduce((acc, res) => ({
        p10: acc.p10 + (parseFloat(res.p10) || 0),
        p50: acc.p50 + (parseFloat(res.p50) || 0),
        p90: acc.p90 + (parseFloat(res.p90) || 0),
        recoverable: acc.recoverable + (parseFloat(res.recoverable) || 0)
    }), { p10: 0, p50: 0, p90: 0, recoverable: 0 });
};