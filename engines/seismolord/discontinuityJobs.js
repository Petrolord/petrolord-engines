// Discontinuity attribute jobs for runNeighborhoodJob: the per-trace
// variance compute (discontinuity.js) and the regional fault likelihood,
// computed a brick column at a time from faultDetect's stage 1 over the
// column plus a halo wide enough that every output cell sees exactly what
// it would in a whole-volume run (gate: seismolord.faultlikelihood test).
//
// Kept apart from discontinuity.js so faultDetect (which imports
// varianceTrace from it) and discontinuity never import each other.
//
// Pure math, worker-safe, no I/O.

import { DISCONTINUITY_DEFS, makeNeighborhoodCompute } from './discontinuity';
import { faultLikelihoodVolume, FAULT_DETECT_DEFAULTS } from './faultDetect';

const ownPreset = (table, key) => (typeof key === 'string' || typeof key === 'number')
  && Object.prototype.hasOwnProperty.call(table, key);

/**
 * Lateral reach (cells) of faultLikelihoodVolume: the semblance radius,
 * then the background box, then the wider of the structure tensor (its
 * gradient reaches one cell further) and the strike line (bilinear, one
 * cell further), plus one cell of margin.
 */
export function likelihoodHalo(p = {}) {
  const P = { ...FAULT_DETECT_DEFAULTS, ...p };
  const r = Math.max(1, Math.floor(P.radius));
  return r + Math.max(1, P.backgroundRadius)
    + Math.max(Math.max(1, P.tensorRadius) + 1, Math.max(0, Math.floor(P.strikeHalfLength)) + 1) + 1;
}

/**
 * The fault likelihood of the cells il0..il1 x xl0..xl1 (all samples),
 * computed over that block plus `halo` cells each side (clipped to the
 * survey), in (row-major il, then xl)*ns order.
 */
export async function faultLikelihoodBlock({
  getTrace, nIl, nXl, ns, il0, il1, xl0, xl1, params = {}, halo = likelihoodHalo(params), shouldCancel,
}) {
  const ri0 = Math.max(0, il0 - halo);
  const ri1 = Math.min(nIl - 1, il1 + halo);
  const rj0 = Math.max(0, xl0 - halo);
  const rj1 = Math.min(nXl - 1, xl1 + halo);
  const sub = { nIl: ri1 - ri0 + 1, nXl: rj1 - rj0 + 1, ns };
  const lik = await faultLikelihoodVolume({
    getTrace: (i, j) => getTrace(i + ri0, j + rj0),
    geom: sub,
    ...FAULT_DETECT_DEFAULTS,
    ...params,
    shouldCancel,
  });
  const nI = il1 - il0 + 1;
  const nJ = xl1 - xl0 + 1;
  const out = new Float32Array(nI * nJ * ns);
  for (let i = 0; i < nI; i++) {
    for (let j = 0; j < nJ; j++) {
      const src = ((i + il0 - ri0) * sub.nXl + (j + xl0 - rj0)) * ns;
      out.set(lik.subarray(src, src + ns), (i * nJ + j) * ns);
    }
  }
  return out;
}

/**
 * The runNeighborhoodJob pieces for any discontinuity attribute:
 * {radius, compute} for variance, {radius, computeColumn} for the regional
 * fault likelihood.
 *
 * @param {string} name DISCONTINUITY_DEFS key
 * @param {Object} params the attribute's params (windowMs, radius)
 * @param {{dtUs: number, nIl: number, nXl: number, ns: number}} volume
 */
export function makeDiscontinuityJob(name, params, volume) {
  const def = ownPreset(DISCONTINUITY_DEFS, name) ? DISCONTINUITY_DEFS[name] : undefined;
  if (!def) throw new Error(`Unknown discontinuity attribute "${name}".`);
  if (!def.regional) return makeNeighborhoodCompute(name, params, volume);
  const { dtUs, nIl, nXl, ns } = volume;
  if (!(dtUs > 0)) throw new Error(`Fault likelihood needs a positive dt, got ${dtUs}.`);
  if (!(nIl > 0 && nXl > 0 && ns > 0)) throw new Error('Fault likelihood needs the survey size (nIl, nXl, ns).');
  const windowMs = params?.windowMs ?? def.params.windowMs.default;
  const halfWindow = Math.max(1, Math.round(windowMs / 2 / (dtUs / 1000)));
  const P = { halfWindow };
  const halo = likelihoodHalo(P);
  return {
    radius: halo,
    computeColumn: ({
      getTrace, il0, il1, xl0, xl1, shouldCancel,
    }) => faultLikelihoodBlock({
      getTrace, nIl, nXl, ns, il0, il1, xl0, xl1, params: P, halo, shouldCancel,
    }),
  };
}
