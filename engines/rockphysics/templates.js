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
// 3. Rock-model lines (2026-10-06, end of file): soft sand, stiff sand,
//    constant cement (./granular) and Xu-White (./inclusion) through the
//    same Gassmann step. SI throughout. Pure math, no I/O.

import { ksat } from './gassmann';
import { mudrockVs } from './vsEstimate';
import { gardnerRho } from './pseudoSonic';
import { softSand, stiffSand, constantCement } from './granular';
import { differentialEffectiveMedium, differentialEffectiveMediumPath } from './inclusion';

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

// ---------------------------------------------------------------------------
// Rock-model template lines (QI programme Q2, 2026-10-06): the same
// fluid-saturated line for the granular and inclusion models in
// ./granular and ./inclusion, so a practitioner can lay soft sand, stiff
// sand, constant cement or Xu-White over the data and see which one the
// wells follow. Every point is the model's dry frame, then Gassmann.

export const ROCK_MODELS = Object.freeze([
  { key: 'critical', label: 'Critical porosity (Nur)' },
  { key: 'soft', label: 'Soft sand (friable)' },
  { key: 'stiff', label: 'Stiff sand' },
  { key: 'constantCement', label: 'Constant cement' },
  { key: 'xuWhite', label: 'Xu-White (clay pores)' },
]);

/** Defaults a practitioner starts from (RPH 5.4; Avseth et al. 2005; Xu and White 1995). */
export const ROCK_MODEL_DEFAULTS = Object.freeze({
  phiC: 0.36, n: 9, pMPa: 20, f: 1, phiB: 0.33, clayShare: 0.2, alphaSand: 0.12, alphaClay: 0.03,
});

/** The largest porosity a model can draw at the given parameters. */
export function rockModelMaxPhi(model, p = {}) {
  const q = { ...ROCK_MODEL_DEFAULTS, ...p };
  if (model === 'critical') return q.phic ?? CRITICAL_POROSITY_SANDSTONE;
  if (model === 'constantCement') return q.phiB;
  if (model === 'xuWhite') return 0.4;
  return q.phiC;
}

const xuWhiteInclusions = (q) => [
  { K: 0, G: 0, alpha: q.alphaSand, w: 1 - q.clayShare },
  { K: 0, G: 0, alpha: q.alphaClay, w: q.clayShare },
];

function dryFrame(model, mineral, phi, q) {
  const K = mineral.k;
  const G = mineral.mu;
  switch (model) {
    case 'critical': {
      const d = criticalPorosityDry(K, G, phi, q.phic ?? CRITICAL_POROSITY_SANDSTONE);
      return { K: d.k, G: d.mu };
    }
    case 'soft': return softSand({ K, G, phi, phiC: q.phiC, n: q.n, P: q.pMPa * 1e6, f: q.f });
    case 'stiff': return stiffSand({ K, G, phi, phiC: q.phiC, n: q.n, P: q.pMPa * 1e6, f: q.f });
    case 'constantCement':
      // quartz-cemented quartz sand unless a cement is given
      return constantCement({ K, G, Kc: q.cement?.k ?? K, Gc: q.cement?.mu ?? G, phi, phiB: q.phiB, phi0: q.phiC, n: q.n });
    case 'xuWhite':
      return differentialEffectiveMedium({
        Km: K,
        Gm: G,
        y: phi,
        steps: 200,
        inclusions: xuWhiteInclusions(q),
      });
    default: throw new Error(`Unknown rock model: ${model}.`);
  }
}

/**
 * One fluid-saturated point of a rock model.
 * @param {'critical'|'soft'|'stiff'|'constantCement'|'xuWhite'} model
 * @param {{k:number, mu:number, rho:number}} mineral
 * @param {{k:number, rho:number}} fluid
 * @param {number} phi
 * @param {Object} [params] see ROCK_MODEL_DEFAULTS; pMPa is effective pressure in MPa
 */
export function rockModelPoint(model, mineral, fluid, phi, params = {}) {
  if (!(fluid?.k > 0) || !(fluid?.rho > 0)) throw new Error('The pore fluid needs a positive modulus and density.');
  const q = { ...ROCK_MODEL_DEFAULTS, ...params };
  if (phi === 0) return { phi, ...elastic(mineral.k, mineral.mu, mineral.rho) };
  const dry = dryFrame(model, mineral, phi, q);
  const k = ksat(dry.K, mineral.k, fluid.k, phi);
  return { phi, ...elastic(k, dry.G, (1 - phi) * mineral.rho + phi * fluid.rho), kdry: dry.K, mudry: dry.G };
}

/** A rock model's line for one fluid; porosities beyond the model's reach are left out. */
export function rockModelLine(model, mineral, fluid, phis, params = {}) {
  const top = rockModelMaxPhi(model, params);
  const inside = model === 'critical' ? (phi) => phi >= 0 && phi < top : (phi) => phi >= 0 && phi <= top;
  const kept = phis.filter(inside);
  if (model !== 'xuWhite') return kept.map((phi) => rockModelPoint(model, mineral, fluid, phi, params));
  // Xu-White: one DEM pass along porosity rather than one per point
  if (!(fluid?.k > 0) || !(fluid?.rho > 0)) throw new Error('The pore fluid needs a positive modulus and density.');
  const q = { ...ROCK_MODEL_DEFAULTS, ...params };
  const path = differentialEffectiveMediumPath({ Km: mineral.k, Gm: mineral.mu, inclusions: xuWhiteInclusions(q), ys: kept });
  return kept.map((phi, i) => {
    if (phi === 0) return { phi, ...elastic(mineral.k, mineral.mu, mineral.rho) };
    const k = ksat(path[i].K, mineral.k, fluid.k, phi);
    return { phi, ...elastic(k, path[i].G, (1 - phi) * mineral.rho + phi * fluid.rho), kdry: path[i].K, mudry: path[i].G };
  });
}
