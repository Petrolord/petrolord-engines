// Shale volume from gamma ray (Petrophysics Studio G2.1). Ported from
// the proven core of src/utils/petrophysicsCalculations.js and
// hardened; validated against the INDEPENDENT oracle goldens
// (tools/validation/petrophysics/, 1e-12 rel — the dual-implementation
// contract in test-data/petrophysics/README.md).
//
// Conventions (all G2 engines): plain functions, float64, worker-safe,
// no I/O. Invalid/missing input -> NaN (never a silent default — the
// legacy library returned Sw=1/clamped values on bad input; resolved
// in the oracle's favor per the plan). Cores are UNCLAMPED: an
// out-of-range value is information the UI flags, not hides.

/** Gamma-ray index, clamped [0,1] (the clamp IS the linear model's
 *  definition — GR beyond the picked clean/clay lines reads as 0/1).
 *  @param {number} gr @param {number} grClean @param {number} grClay */
export function igr(gr, grClean, grClay) {
  if (!(grClay > grClean)) throw new Error('GR clay line must exceed the clean line.');
  if (!Number.isFinite(gr)) return NaN;
  const x = (gr - grClean) / (grClay - grClean);
  return Math.min(1, Math.max(0, x));
}

/** Larionov (1969) tertiary/unconsolidated: 0.083*(2^(3.7*IGR)-1). */
export const vshLarionovTertiary = (i) => (Number.isFinite(i) ? 0.083 * (2 ** (3.7 * i) - 1) : NaN);

/** Larionov (1969) older/consolidated: 0.33*(2^(2*IGR)-1). */
export const vshLarionovOlder = (i) => (Number.isFinite(i) ? 0.33 * (2 ** (2 * i) - 1) : NaN);

/** Clavier, Hoyle & Meunier (1971): 1.7 - sqrt(3.38-(IGR+0.7)^2).
 *  Anchored to 0 at IGR=0 and 1 at IGR=1 by construction. */
export const vshClavier = (i) => (Number.isFinite(i) ? 1.7 - Math.sqrt(3.38 - (i + 0.7) ** 2) : NaN);

/** Steiber (1970): IGR/(3-2*IGR). */
export const vshSteiber = (i) => (Number.isFinite(i) ? i / (3 - 2 * i) : NaN);

export const VSH_METHODS = {
  linear: (i) => i,
  'larionov-tertiary': vshLarionovTertiary,
  'larionov-older': vshLarionovOlder,
  clavier: vshClavier,
  steiber: vshSteiber,
};

/**
 * GR curve -> Vsh curve.
 * @param {ArrayLike<number>} gr
 * @param {{grClean: number, grClay: number, method?: keyof typeof VSH_METHODS}} p
 * @returns {Float64Array}
 */
export function vshFromGr(gr, { grClean, grClay, method = 'linear' }) {
  const f = VSH_METHODS[method];
  if (!f) throw new Error(`Unknown Vsh method "${method}".`);
  const out = new Float64Array(gr.length);
  for (let k = 0; k < gr.length; k++) out[k] = f(igr(gr[k], grClean, grClay));
  return out;
}
