/**
 * Correction of a gauge pressure to the pressure datum (Well Test U2-004,
 * 2026-10-04), with a gradient the user states (owner default: no gradient,
 * no correction).
 *
 *   p_datum = p_gauge + g (z_datum - z_gauge)
 *
 * z is true vertical depth below the vertical datum (TVDSS, positive down),
 * g the static gradient of the fluid column between the two depths
 * (psi/ft). A datum below the gauge adds pressure. The gauge depth is
 * usually stated in TVD below the depth reference (KB, RT); its TVDSS is
 * TVD minus the reference elevation above the datum.
 *
 * A gradient is a single number over the whole interval: the user states
 * it (a fluid gradient from density, or a measured one from a static
 * survey) and its source. No gradient is guessed here.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {{gaugeTvd?: number, refElevation?: number, gaugeTvdss?: number, datumTvdss?: number, gradient?: number}} a
 *   depths in ft, gradient in psi/ft
 * @returns {{ok: boolean, reason?: string, gaugeTvdss?: number, dz?: number, correction?: number,
 *   apply?: (p: number) => number}}
 */
export const datumCorrection = ({ gaugeTvd, refElevation, gaugeTvdss, datumTvdss, gradient } = {}) => {
  if (!finite(gradient)) return { ok: false, reason: 'No gradient was stated, so no correction is applied: every pressure is at the gauge depth.' };
  if (!(gradient >= 0) || gradient > 1.2) return { ok: false, reason: 'The gradient must lie between 0 and 1.2 psi/ft (a static fluid column).' };
  if (!finite(datumTvdss)) return { ok: false, reason: 'The pressure datum (TVDSS) is not stated, so no correction is applied.' };
  let zGauge = gaugeTvdss;
  if (!finite(zGauge)) {
    if (!finite(gaugeTvd)) return { ok: false, reason: 'The gauge depth in TVD is not stated, so no correction is applied.' };
    if (!finite(refElevation)) return { ok: false, reason: 'The elevation of the depth reference above the vertical datum is not stated, so the gauge TVD cannot be put on the datum.' };
    zGauge = gaugeTvd - refElevation;
  }
  const dz = datumTvdss - zGauge;
  const correction = gradient * dz;
  return { ok: true, gaugeTvdss: zGauge, dz, correction, apply: (p) => (finite(p) ? p + correction : p) };
};
