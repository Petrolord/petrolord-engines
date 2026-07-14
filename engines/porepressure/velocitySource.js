// Pseudo-sonic profile from a Seismolord SINGLE-FUNCTION velocity
// model (P4): V(z) = v0 + k·z, instantaneous velocity linear in depth
// below the seismic datum (engine/velocityModel.js semantics; the
// model is persisted per volume in manifest.velocity, well-tie
// calibrated). Sampling it on a below-mudline grid gives a transit-
// time profile the prognosis engine consumes with Gardner densities —
// honestly TREND-GRADE: an analytic v0+k model carries no local
// overpressure anomaly, it constrains the regional trend (plan §2).
//
// Layer-cake models are NOT sampled in v1 (their layer boundaries are
// horizon times per seismic column — a P5 follow-on); callers should
// offer only single-function models.

/**
 * @param {{v0: number, k: number}} model - v0 m/s at the seismic
 *   datum, k 1/s (k = 0 is constant velocity).
 * @param {{datumToMudlineM: number, zMaxM: number, stepM: number}} grid -
 *   datumToMudlineM: depth of the mudline below the model datum
 *   (water depth when the datum is sea level); the profile is sampled
 *   at zBml = 0..zMaxM every stepM.
 * @returns {{zBmlM: number[], dtUsPerM: number[], rhoKgM3: null}}
 */
export function pseudoSonicFromLinearVelocity(model, { datumToMudlineM, zMaxM, stepM }) {
  const v0 = Number(model?.v0);
  const k = Number(model?.k ?? 0);
  if (!(v0 > 0) || !Number.isFinite(k)) {
    throw new Error('Velocity model needs v0 > 0 and finite k.');
  }
  if (!(datumToMudlineM >= 0)) throw new Error('Datum-to-mudline offset must be >= 0.');
  if (!(zMaxM > 0) || !(stepM > 0)) throw new Error('Grid needs zMax > 0 and step > 0.');

  const n = Math.floor(zMaxM / stepM) + 1;
  const zBmlM = new Array(n);
  const dtUsPerM = new Array(n);
  for (let i = 0; i < n; i++) {
    const z = i * stepM;
    const v = v0 + k * (datumToMudlineM + z);
    if (!(v > 0)) {
      throw new Error(`Velocity model goes non-positive at ${z} m below mudline (k < 0).`);
    }
    zBmlM[i] = z;
    dtUsPerM[i] = 1e6 / v;
  }
  return { zBmlM, dtUsPerM, rhoKgM3: null };
}

/** True when a persisted manifest.velocity is v1-samplable. */
export function isLinearVelocityModel(model) {
  if (!model) return false;
  if (model.type === 'layercake' || model.kind === 'layercake') return false;
  return Number(model.v0) > 0 && Number.isFinite(Number(model.k ?? 0));
}
