// Rock-physics template lines for the acoustic impedance against Vp/Vs
// crossplot (Rock Physics Studio U2-001, 2026-10-01).
//
// Two published trends, each a line a practitioner can check by hand:
//
// 1. Sand line, critical-porosity model (Nur et al. 1991, 1998; Rock
//    Physics Handbook 7.9): the dry frame weakens linearly from the mineral
//    at zero porosity to nothing at the critical porosity phi_c (about 0.40
//    for sandstones):
//      K_dry = K_min (1 - phi/phi_c),  mu_dry = mu_min (1 - phi/phi_c)
//    then Gassmann (./gassmann) puts the pore fluid in. One line per pore
//    fluid (brine, the hydrocarbon case), marked at porosity steps.
//
// 2. Mudrock line (Castagna et al. 1985: Vs = 0.8621 Vp - 1172.4 m/s, the
//    brine-filled clastic trend, ./vsEstimate) with Gardner's density
//    (./pseudoSonic), the wet background a shale or wet sand should follow.
//
// The soft-sand, stiff-sand and Xu-White models are not here (a later
// item); these two lines need nothing beyond the validated Gassmann,
// mineral, fluid and Vs engines. SI throughout. Pure math, no I/O.

import { ksat } from './gassmann';
import { mudrockVs } from './vsEstimate';
import { gardnerRho } from './pseudoSonic';

export const CRITICAL_POROSITY_SANDSTONE = 0.4;

/** Dry-frame moduli of the critical-porosity model (Pa). */
export function criticalPorosityDry(kmin, mumin, phi, phic = CRITICAL_POROSITY_SANDSTONE) {
  if (!(kmin > 0) || !(mumin > 0)) throw new Error('Mineral moduli must be positive.');
  if (!(phic > 0 && phic < 1)) throw new Error('The critical porosity must be between 0 and 1.');
  if (!(phi >= 0 && phi < phic)) throw new Error('Porosity must be from 0 up to (not including) the critical porosity.');
  const f = 1 - phi / phic;
  return { k: kmin * f, mu: mumin * f };
}

const elastic = (k, mu, rho) => {
  const vp = Math.sqrt((k + (4 * mu) / 3) / rho);
  const vs = Math.sqrt(mu / rho);
  return { vp, vs, rho, ai: vp * rho, vpvs: vp / vs, k, mu };
};

/**
 * One fluid-saturated point of the critical-porosity sand line.
 * @param {{k: number, mu: number, rho: number}} mineral
 * @param {{k: number, rho: number}} fluid
 * @returns {{phi, vp, vs, rho, ai, vpvs, k, mu}}
 */
export function sandPoint(mineral, fluid, phi, phic = CRITICAL_POROSITY_SANDSTONE) {
  if (!(fluid?.k > 0) || !(fluid?.rho > 0)) throw new Error('The pore fluid needs a positive modulus and density.');
  if (phi === 0) return { phi, ...elastic(mineral.k, mineral.mu, mineral.rho) };
  const dry = criticalPorosityDry(mineral.k, mineral.mu, phi, phic);
  const k = ksat(dry.k, mineral.k, fluid.k, phi);
  return { phi, ...elastic(k, dry.mu, (1 - phi) * mineral.rho + phi * fluid.rho) };
}

/** The sand line for one fluid at the given porosities (those at or above phi_c are left out). */
export function sandLine(mineral, fluid, phis, phic = CRITICAL_POROSITY_SANDSTONE) {
  return phis.filter((phi) => phi >= 0 && phi < phic).map((phi) => sandPoint(mineral, fluid, phi, phic));
}

/**
 * The mudrock line with Gardner density between two P velocities.
 * Points where the line gives no positive Vs are left out.
 * @returns {Array<{vp, vs, rho, ai, vpvs}>}
 */
export function mudrockLine(vpFrom, vpTo, steps = 20) {
  if (!(vpFrom > 0) || !(vpTo > vpFrom) || !(steps >= 1)) throw new Error('The mudrock line needs an increasing velocity range.');
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const vp = vpFrom + ((vpTo - vpFrom) * i) / steps;
    const vs = mudrockVs(vp);
    if (!(vs > 0)) continue;
    const rho = gardnerRho(vp);
    out.push({ vp, vs, rho, ai: vp * rho, vpvs: vp / vs });
  }
  return out;
}
