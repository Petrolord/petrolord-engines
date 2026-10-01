// Full 1D prognosis pipeline (Pore Pressure Studio P1): density
// (log or per-sample Gardner fallback, provenance recorded) →
// overburden + hydrostatic → Eaton or Bowers pore pressure →
// coefficient-form fracture pressure. Pure and jest-tested against
// the oracle's forward-inverse-consistent synthetic well: an Eaton
// run over the golden dt log must recover the imposed PP profile.
// SI in/out; transit time in us/m (V [m/s] = 1e6 / dt).

import { hydrostatic, overburden } from './pressures';
import { gardnerRho } from './gardner';
import { nctDtSegmented, checkSegments } from './nct';
import { eaton } from './eaton';
import { bowersSigmaLoading, bowersSigmaUnloading } from './bowers';
import { fracPressure, fracCoefficient } from './fracgrad';
import { nctResistivity, EATON_N_RESISTIVITY } from './resistivity';

/**
 * @param {{
 *   zBmlM: number[], dtUsPerM: number[],
 *   rhoKgM3?: (number|null)[],
 *   resOhmM?: number[],
 *   params: {
 *     waterDepthM: number, rhoSeawaterKgM3: number, rhoFluidKgM3: number,
 *     nct: {dtMlUsPerM: number, dtMaUsPerM: number, cPerM: number},
 *     nctSegments?: {zTopM: number, dtMlUsPerM: number, cPerM: number}[],
 *     method: 'eaton'|'eaton-resistivity'|'bowers',
 *     eatonN?: number,
 *     resNct?: {r0OhmM: number, bPerM: number}, eatonNRes?: number,
 *     fracMethod?: 'eaton'|'matthews-kelly'|'daines', k0?: number, beta?: number,
 *     bowers?: {A: number, B: number, U?: number, sigmaMaxPa?: number,
 *               vMlFts?: number},
 *     gardner?: {a?: number, b?: number},
 *     nu?: number, K?: number,
 *   },
 * }} input
 */
// U2-001: 'eaton-resistivity' reads resOhmM against a log-linear shale
// resistivity trend (resistivity.js); transit time is then optional per
// sample (null) where a density log gives the overburden. U2-005: the
// sonic trend may carry segments. U2-012: the fracture coefficient comes
// from the chosen method (Eaton, Matthews and Kelly, Daines).
export function computeProfile({ zBmlM, dtUsPerM, rhoKgM3, resOhmM = null, params }) {
  const p = params || {};
  if (p.method !== 'eaton' && p.method !== 'bowers' && p.method !== 'eaton-resistivity') {
    throw new Error("method must be 'eaton', 'eaton-resistivity' or 'bowers'.");
  }
  const byRes = p.method === 'eaton-resistivity';
  if (!zBmlM || zBmlM.length === 0 || !dtUsPerM || zBmlM.length !== dtUsPerM.length) {
    throw new Error('Depth and transit-time arrays must be non-empty and equal length.');
  }
  if (rhoKgM3 && rhoKgM3.length !== zBmlM.length) {
    throw new Error('Density array length must match the depth array.');
  }
  if (byRes && (!resOhmM || resOhmM.length !== zBmlM.length)) {
    throw new Error('Resistivity Eaton needs a resistivity array matching the depth array.');
  }
  const { dtMlUsPerM, dtMaUsPerM, cPerM } = p.nct || {};
  const segments = checkSegments(p.nctSegments);
  const base = { dtMlUsPerM, dtMaUsPerM, cPerM };
  const K = fracCoefficient(p);
  const rn = p.resNct || {};
  const ga = p.gardner?.a ?? 0.31;
  const gb = p.gardner?.b ?? 0.25;

  const n = zBmlM.length;
  const vMs = new Array(n);
  const rhoUsed = new Array(n);
  const rhoSource = new Array(n);
  for (let i = 0; i < n; i++) {
    const dt = dtUsPerM[i];
    const dtOk = dt != null && dt > 0;
    if (!dtOk && (!byRes || dt != null)) throw new Error(`Bad transit time at index ${i} (dt=${dt}).`);
    vMs[i] = dtOk ? 1e6 / dt : null;
    const logRho = rhoKgM3 ? rhoKgM3[i] : null;
    if (logRho != null) {
      if (!(logRho > 0)) throw new Error(`Bad density at index ${i} (rho=${logRho}).`);
      rhoUsed[i] = logRho;
      rhoSource[i] = 'log';
    } else {
      if (!dtOk) throw new Error(`No density and no transit time at index ${i}: the overburden needs one of them.`);
      rhoUsed[i] = gardnerRho(vMs[i], ga, gb);
      rhoSource[i] = 'gardner';
    }
  }

  const S = overburden(zBmlM, rhoUsed, p.waterDepthM, p.rhoSeawaterKgM3);
  const Ph = new Array(n);
  const dtN = new Array(n);
  const PP = new Array(n);
  const FP = new Array(n);
  const resN = byRes ? new Array(n) : null;
  for (let i = 0; i < n; i++) {
    Ph[i] = hydrostatic(zBmlM[i], p.waterDepthM, p.rhoFluidKgM3, p.rhoSeawaterKgM3);
    dtN[i] = nctDtSegmented(zBmlM[i], base, segments);
    if (byRes) {
      const r = resOhmM[i];
      if (!(r > 0)) throw new Error(`Bad resistivity at index ${i} (R=${r}).`);
      resN[i] = nctResistivity(zBmlM[i], rn.r0OhmM, rn.bPerM);
      PP[i] = eaton(S[i], Ph[i], r / resN[i], p.eatonNRes ?? EATON_N_RESISTIVITY);
    } else if (p.method === 'eaton') {
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
    resNormalOhmM: resN,
    porePressurePa: PP,
    fracPressurePa: FP,
    vMs,
    rhoUsedKgM3: rhoUsed,
    rhoSource,
  };
}
