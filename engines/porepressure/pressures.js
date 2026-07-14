// Hydrostatic + overburden (Pore Pressure Studio P1) — validated
// against the porepressure oracle goldens. SI throughout (Pa, m,
// kg/m3). Unphysical inputs THROW — never a silent NaN.

import { G_ACCEL } from './constants';

/**
 * Pore-fluid hydrostatic pressure [Pa] at zBml metres below mudline:
 * seawater column above the mudline, pore fluid below (so P_h at the
 * mudline equals the overburden there exactly).
 */
export function hydrostatic(zBml, waterDepth, rhoFluid, rhoSeawater) {
  if (!(zBml >= 0)) throw new Error('Depth below mudline must be >= 0.');
  if (!(waterDepth >= 0)) throw new Error('Water depth must be >= 0.');
  if (!(rhoFluid > 0) || !(rhoSeawater > 0)) {
    throw new Error('Fluid densities must be positive.');
  }
  return G_ACCEL * (rhoSeawater * waterDepth + rhoFluid * zBml);
}

/**
 * Overburden stress S [Pa] at each sample of a density profile.
 * zs: non-decreasing depths below mudline [m] (zs[0] may be > 0 —
 * the first density value extends to the mudline). rhos: bulk density
 * [kg/m3]. Trapezoidal integration, matching the oracle's operation
 * order sample-for-sample.
 */
export function overburden(zs, rhos, waterDepth, rhoSeawater) {
  if (!zs || !rhos || zs.length !== rhos.length || zs.length === 0) {
    throw new Error('Depth and density arrays must be non-empty and equal length.');
  }
  if (!(waterDepth >= 0) || !(rhoSeawater > 0)) {
    throw new Error('Water depth must be >= 0 and seawater density positive.');
  }
  const out = new Array(zs.length);
  let s = rhoSeawater * G_ACCEL * waterDepth;
  let prevZ = 0.0;
  let prevRho = rhos[0];
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i];
    const rho = rhos[i];
    if (!Number.isFinite(z) || !Number.isFinite(rho) || !(rho > 0)) {
      throw new Error(`Bad density sample at index ${i} (z=${z}, rho=${rho}).`);
    }
    if (z < prevZ) throw new Error('Depths must be non-decreasing.');
    s += 0.5 * (rho + prevRho) * G_ACCEL * (z - prevZ);
    out[i] = s;
    prevZ = z;
    prevRho = rho;
  }
  return out;
}
