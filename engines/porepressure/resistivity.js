// Resistivity Eaton (Pore Pressure Studio U2-001). Eaton (1975), "The
// equation for geopressure prediction from well logs", SPE 5544:
//   PP = S - (S - P_h) (R_obs / R_n)^n,  n = 1.2 for resistivity
// (3.0 for sonic, where the ratio is dt_n / dt). Shale resistivity rises
// with depth under normal compaction, so the normal trend is log-linear:
//   R_n(z) = R_0 exp(b z)
// and fitting it is exact least squares on ln R against z, as the sonic
// trend is (nct.js). Resistivity in ohm.m, depths in m below mudline.

import { eaton } from './eaton';

/** Eaton's published exponent for resistivity. */
export const EATON_N_RESISTIVITY = 1.2;
/** Eaton's published exponent for sonic transit time. */
export const EATON_N_SONIC = 3.0;

/** Normal-compaction shale resistivity [ohm.m] at z m below mudline. */
export function nctResistivity(z, r0OhmM, bPerM) {
  if (!(z >= 0)) throw new Error('Depth must be >= 0.');
  if (!(r0OhmM > 0)) throw new Error('Mudline resistivity must be positive.');
  if (!Number.isFinite(bPerM)) throw new Error('Resistivity trend slope must be finite.');
  return r0OhmM * Math.exp(bPerM * z);
}

/**
 * Fit (R_0, b) of the resistivity trend from shale picks: exact least
 * squares on ln R vs z.
 * @returns {{r0OhmM: number, bPerM: number}}
 */
export function fitResistivityNct(zs, rs) {
  if (!zs || !rs || zs.length !== rs.length || zs.length < 2) {
    throw new Error('Need at least two picks with matching depths.');
  }
  const n = zs.length;
  let sz = 0; let sy = 0; let szz = 0; let szy = 0;
  for (let i = 0; i < n; i++) {
    if (!(rs[i] > 0)) throw new Error(`Pick at index ${i} has no positive resistivity.`);
    const y = Math.log(rs[i]);
    sz += zs[i]; sy += y; szz += zs[i] * zs[i]; szy += zs[i] * y;
  }
  const denom = n * szz - sz * sz;
  if (denom === 0) throw new Error('Degenerate picks (single depth).');
  const slope = (n * szy - sz * sy) / denom;
  const intercept = (sy - slope * sz) / n;
  return { r0OhmM: Math.exp(intercept), bPerM: slope };
}

/** Eaton resistivity pore pressure [Pa]. */
export function eatonResistivity(S, Ph, rObsOhmM, rNormalOhmM, n = EATON_N_RESISTIVITY) {
  if (!(rObsOhmM > 0) || !(rNormalOhmM > 0)) throw new Error('Resistivities must be positive.');
  return eaton(S, Ph, rObsOhmM / rNormalOhmM, n);
}
