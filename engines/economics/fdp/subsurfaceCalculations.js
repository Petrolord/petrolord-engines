/**
 * EC6-0. Vendored from the Suite in the EC0 extraction wave; `aggregateReserves`
 * repaired here.
 *
 * It used to reduce every row of the reserves table into one set of totals,
 * whatever fluid each row held. The example plan's 85 MMbbl of oil and 30 Bcf
 * of gas came out as "Total (P50) 115", and the summary card called that 115
 * MMbbl of oil. It also added the P90 column and the P10 column the same way,
 * and a sum of P90s is not the P90 of the sum: adding low cases treats every
 * reservoir as failing together, which is the one thing a portfolio of
 * reservoirs does not do.
 *
 * Totals are now per fluid, in that fluid's own unit, and the percentile
 * columns come back labelled as the sums they are.
 */
import { FdpInputError } from './inputError.js';

/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => (typeof key === 'string' || typeof key === 'number') && Object.prototype.hasOwnProperty.call(table, key);

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

/** The fluids the reserves table offers, with the unit each is entered in. */
export const RESERVES_UNITS = { Oil: 'MMbbl', Gas: 'Bcf', Condensate: 'MMbbl' };

const emptyFluidTotal = (fluid) => ({
  fluid,
  units: RESERVES_UNITS[fluid],
  count: 0,
  p90Sum: 0,
  p50Sum: 0,
  p10Sum: 0,
  recoverableSum: 0,
});

/**
 * Total the reserves table, one total per fluid.
 *
 * @param {object[]} reservoirs rows carrying `fluid` and the p90/p50/p10 columns
 * @returns {{byFluid: object, fluids: string[], percentileNote: string}}
 */
export const aggregateReserves = (reservoirs) => {
  const byFluid = {};
  (reservoirs || []).forEach((res, i) => {
    const fluid = res?.fluid;
    if (!ownPreset(RESERVES_UNITS, fluid)) {
      const name = res?.name || `row ${i + 1}`;
      throw new FdpInputError(
        `${name}: fluid type is missing or unknown (${String(fluid)}); `
        + `expected one of ${Object.keys(RESERVES_UNITS).join(', ')}`,
      );
    }
    if (!byFluid[fluid]) byFluid[fluid] = emptyFluidTotal(fluid);
    const t = byFluid[fluid];
    t.count += 1;
    t.p90Sum += parseFloat(res.p90) || 0;
    t.p50Sum += parseFloat(res.p50) || 0;
    t.p10Sum += parseFloat(res.p10) || 0;
    t.recoverableSum += parseFloat(res.recoverable) || 0;
  });

  const fluids = Object.keys(RESERVES_UNITS).filter((f) => byFluid[f]);
  return {
    byFluid,
    fluids,
    percentileNote: fluids.length
      ? 'Each column is the arithmetic sum of that column within one fluid. '
        + 'A sum of P90s is not the P90 of the sum: add low cases only if every '
        + 'reservoir disappoints together. Aggregate the distributions to get a '
        + 'portfolio P90.'
      : 'No reservoirs entered.',
  };
};

/**
 * The plan's headline P50 for one fluid, or 0 when that fluid is absent.
 * The completeness check and the volumetric cards read this rather than
 * reaching into the totals object.
 *
 * @param {object} aggregate an aggregateReserves result
 * @param {string} [fluid]
 * @returns {number}
 */
export const reservesP50 = (aggregate, fluid = 'Oil') => aggregate?.byFluid?.[fluid]?.p50Sum || 0;
