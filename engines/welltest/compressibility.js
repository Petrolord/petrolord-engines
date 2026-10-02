/**
 * Total system compressibility from its components, the ct every pressure
 * transient formula carries (diffusivity, skin, radius of investigation,
 * pore volume):
 *
 *   ct = cf + So co + Sw cw + Sg cg
 *
 * cf is the formation (pore volume) compressibility; So, Sw, Sg are the
 * fluid saturations as fractions of pore volume; co, cw, cg the fluid
 * compressibilities. Any consistent reciprocal-pressure unit (1/psi in the
 * well test engines).
 *
 * A phase whose saturation is zero or blank contributes nothing and needs
 * no compressibility. A phase that is present needs one: a saturation with
 * no compressibility beside it is refused rather than counted as zero.
 * Saturations that do not sum to one are refused too, because the sum is
 * the only check this arithmetic has.
 */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** How far the saturations may miss 1 before the sum is refused. */
export const SATURATION_SUM_TOLERANCE = 0.01;

export const TOTAL_COMPRESSIBILITY_FORMULA = 'ct = cf + So co + Sw cw + Sg cg';

const PHASES = [
  { key: 'oil', label: 'So co', sat: 'so', c: 'co', name: 'oil' },
  { key: 'water', label: 'Sw cw', sat: 'sw', c: 'cw', name: 'water' },
  { key: 'gas', label: 'Sg cg', sat: 'sg', c: 'cg', name: 'gas' },
];

/**
 * @param {{cf: number, so?: number, co?: number, sw?: number, cw?: number,
 *   sg?: number, cg?: number}} a
 * @returns {{ok: true, ct: number, terms: Array<{key: string, label: string,
 *   saturation: ?number, compressibility: number, product: number}>,
 *   saturationSum: number, formula: string}
 *   | {ok: false, code: string, reason: string}}
 */
export const totalCompressibility = (a = {}) => {
  const refuse = (code, reason) => ({ ok: false, code, reason });
  if (!fin(a.cf) || a.cf < 0) return refuse('no-formation-compressibility', 'Formation compressibility cf is missing or negative.');
  const terms = [{ key: 'formation', label: 'cf', saturation: null, compressibility: a.cf, product: a.cf }];
  let saturationSum = 0;
  for (const ph of PHASES) {
    const s = a[ph.sat];
    const c = a[ph.c];
    const present = fin(s) && s !== 0;
    if (s != null && !Number.isNaN(s) && (!fin(s) || s < 0 || s > 1)) {
      return refuse('bad-saturation', `The ${ph.name} saturation must be a fraction between 0 and 1.`);
    }
    if (!present) continue;
    if (!fin(c) || !(c > 0)) {
      return refuse('no-phase-compressibility', `The ${ph.name} saturation is ${s} but its compressibility is missing or not positive.`);
    }
    saturationSum += s;
    terms.push({ key: ph.key, label: ph.label, saturation: s, compressibility: c, product: s * c });
  }
  if (terms.length === 1) return refuse('no-saturations', 'Enter at least one fluid saturation with its compressibility.');
  if (Math.abs(saturationSum - 1) > SATURATION_SUM_TOLERANCE) {
    return refuse('saturations-do-not-sum', `The saturations sum to ${Number(saturationSum.toFixed(4))}; they must sum to 1.`);
  }
  const ct = terms.reduce((sum, t) => sum + t.product, 0);
  return { ok: true, ct, terms, saturationSum, formula: TOTAL_COMPRESSIBILITY_FORMULA };
};
