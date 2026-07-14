// Full 1D prognosis pipeline (Pore Pressure Studio P1): density
// (log or per-sample Gardner fallback, provenance recorded) →
// overburden + hydrostatic → Eaton or Bowers pore pressure →
// coefficient-form fracture pressure. Pure and jest-tested against
// the oracle's forward-inverse-consistent synthetic well: an Eaton
// run over the golden dt log must recover the imposed PP profile.
// SI in/out; transit time in us/m (V [m/s] = 1e6 / dt).

import { hydrostatic, overburden } from './pressures';
import { gardnerRho } from './gardner';
import { nctDt } from './nct';
import { eaton } from './eaton';
import { bowersSigmaLoading, bowersSigmaUnloading } from './bowers';
import { fracPressure, eatonK } from './fracgrad';

/**
 * @param {{
 *   zBmlM: number[], dtUsPerM: number[],
 *   rhoKgM3?: (number|null)[],
 *   params: {
 *     waterDepthM: number, rhoSeawaterKgM3: number, rhoFluidKgM3: number,
 *     nct: {dtMlUsPerM: number, dtMaUsPerM: number, cPerM: number},
 *     method: 'eaton'|'bowers',
 *     eatonN?: number,
 *     bowers?: {A: number, B: number, U?: number, sigmaMaxPa?: number,
 *               vMlFts?: number},
 *     gardner?: {a?: number, b?: number},
 *     nu?: number, K?: number,
 *   },
 * }} input
 */
export function computeProfile({ zBmlM, dtUsPerM, rhoKgM3, params }) {
  if (!zBmlM || !dtUsPerM || zBmlM.length !== dtUsPerM.length || zBmlM.length === 0) {
    throw new Error('Depth and transit-time arrays must be non-empty and equal length.');
  }
  if (rhoKgM3 && rhoKgM3.length !== zBmlM.length) {
    throw new Error('Density array length must match the depth array.');
  }
  const p = params || {};
  if (p.method !== 'eaton' && p.method !== 'bowers') {
    throw new Error("method must be 'eaton' or 'bowers'.");
  }
  const { dtMlUsPerM, dtMaUsPerM, cPerM } = p.nct || {};
  const K = p.K != null ? p.K : eatonK(p.nu != null ? p.nu : 0.4);
  const ga = p.gardner?.a ?? 0.31;
  const gb = p.gardner?.b ?? 0.25;

  const n = zBmlM.length;
  const vMs = new Array(n);
  const rhoUsed = new Array(n);
  const rhoSource = new Array(n);
  for (let i = 0; i < n; i++) {
    const dt = dtUsPerM[i];
    if (!(dt > 0)) throw new Error(`Bad transit time at index ${i} (dt=${dt}).`);
    vMs[i] = 1e6 / dt;
    const logRho = rhoKgM3 ? rhoKgM3[i] : null;
    if (logRho != null) {
      if (!(logRho > 0)) throw new Error(`Bad density at index ${i} (rho=${logRho}).`);
      rhoUsed[i] = logRho;
      rhoSource[i] = 'log';
    } else {
      rhoUsed[i] = gardnerRho(vMs[i], ga, gb);
      rhoSource[i] = 'gardner';
    }
  }

  const S = overburden(zBmlM, rhoUsed, p.waterDepthM, p.rhoSeawaterKgM3);
  const Ph = new Array(n);
  const dtN = new Array(n);
  const PP = new Array(n);
  const FP = new Array(n);
  for (let i = 0; i < n; i++) {
    Ph[i] = hydrostatic(zBmlM[i], p.waterDepthM, p.rhoFluidKgM3, p.rhoSeawaterKgM3);
    dtN[i] = nctDt(zBmlM[i], dtMlUsPerM, dtMaUsPerM, cPerM);
    if (p.method === 'eaton') {
      PP[i] = eaton(S[i], Ph[i], dtN[i] / dtUsPerM[i], p.eatonN ?? 3.0);
    } else {
      const b = p.bowers || {};
      const sigma = (b.U != null && b.sigmaMaxPa != null)
        ? bowersSigmaUnloading(vMs[i], b.sigmaMaxPa, b.A, b.B, b.U, b.vMlFts ?? 5000.0)
        : bowersSigmaLoading(vMs[i], b.A, b.B, b.vMlFts ?? 5000.0);
      PP[i] = S[i] - sigma;
    }
    FP[i] = fracPressure(S[i], PP[i], K);
  }

  return {
    overburdenPa: S,
    hydrostaticPa: Ph,
    dtNormalUsPerM: dtN,
    porePressurePa: PP,
    fracPressurePa: FP,
    vMs,
    rhoUsedKgM3: rhoUsed,
    rhoSource,
  };
}
