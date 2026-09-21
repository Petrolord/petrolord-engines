// Formation temperature (Petrophysics Studio PS5). Linear geothermal
// profile from surface temperature and a BHT station, and the Rw(T)
// chain through the existing Arps conversion. Shared engine
// conventions (see vsh.js): pure, float64, NaN-propagating, no I/O.
//
// Units: degC in and out (the app is SI); the Arps and SP formulas are
// DEFINED in degF, so the conversion happens here, inside the
// temperature module, never in the UI (the documented rw.js boundary).

import { rwArps } from './rw';

/** Linear profile T(z) = Ts + (BHT - Ts) * z / z_bht (degC). Depths
 *  below the BHT station extrapolate on the same gradient. */
export function tempAtDepth(zM, { surfaceTempC, bhtC, bhtDepthM }) {
  if (!Number.isFinite(zM)) return NaN;
  return surfaceTempC + (bhtC - surfaceTempC) * (zM / bhtDepthM);
}

/** degC -> degF. */
export const cToF = (tC) => (tC * 9) / 5 + 32;

/** Rw at formation temperature via Arps (degC in, degF inside). */
export function rwAtTemp(rwRef, refC, tC) {
  if (!Number.isFinite(tC)) return NaN;
  return rwArps(rwRef, cToF(refC), cToF(tC));
}

/** TEMP curve over a depth array. */
export function tempCurve(depth, opts) {
  return Float64Array.from(depth, (z) => tempAtDepth(z, opts));
}
