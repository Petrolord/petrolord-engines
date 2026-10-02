/**
 * Partial penetration (limited entry) pseudo-skin for a vertical well that
 * is open over part of the net pay, and the split of a tested total skin
 * into that geometric component and the remaining mechanical (damage) skin.
 * Consistent length units throughout (ft or m); every result is
 * dimensionless.
 *
 * Papatzacos (1987), "Approximate Partial-Penetration Pseudoskin for
 * Infinite-Conductivity Wells", SPE Reservoir Engineering 2 (2), 227-234,
 * SPE-13956-PA:
 *
 *   s_pp = (1/hpD - 1) ln( pi / (2 rD) )
 *        + (1/hpD) ln[ hpD / (2 + hpD) * sqrt( (A - 1) / (B - 1) ) ]
 *
 *   hpD = hp / h                   open (perforated) fraction of the pay
 *   rD  = (rw / h) sqrt(kv / kh)   anisotropy-scaled wellbore radius
 *   h1D = h1 / h                   top of pay to top of the open interval
 *   A   = 1 / (h1D + hpD / 4)
 *   B   = 1 / (h1D + 3 hpD / 4)
 *
 * Two properties of the formula that the gates assert to machine precision:
 * a fully open pay (hpD = 1, h1D = 0) gives exactly zero, and an interval
 * measured from the top gives the same value as its mirror image measured
 * from the base.
 *
 * Brons and Marting (1961), "The Effect of Restricted Fluid Entry on Well
 * Productivity", JPT 13 (2), 172-174, in the polynomial form of their chart
 * that the SPE texts carry:
 *
 *   s_pp = (1/b - 1) [ ln(hD) - G(b) ]
 *   G(b) = 2.948 - 7.363 b + 11.45 b^2 - 4.675 b^3
 *   b    = hp / h,   hD = (hs / rw) sqrt(kh / kv)
 *
 * with hs the thickness of one symmetry element: the whole pay for an
 * interval at the top or the base, half of it for an interval centred in
 * the pay. It is here as a second published estimate, not as the reported
 * value, and it only covers those two positions.
 *
 * Total, geometric and mechanical skin (Saidikowski 1979, SPE 8204; the
 * form the well test texts use):
 *
 *   s = (h / hp) s_d + s_pp     so     s_d = (hp / h) (s - s_pp)
 *
 * The damage skin acts over the open interval only, which is why a test
 * sees it magnified by h / hp.
 *
 * Nothing here guesses. A missing or impossible input returns
 * { ok: false, code, reason } and no number.
 */

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Relative slack for "the interval is the whole pay" and "it fits in the pay". */
export const FULL_PENETRATION_TOLERANCE = 0.005;

export const PAPATZACOS_REFERENCE = 'Papatzacos (1987), SPE Reservoir Engineering 2 (2), 227-234, SPE-13956-PA';
export const BRONS_MARTING_REFERENCE = 'Brons and Marting (1961), JPT 13 (2), 172-174';
export const SKIN_SPLIT_REFERENCE = 'Saidikowski (1979), SPE 8204';
export const PAPATZACOS_FORMULA = 's_pp = (1/hpD - 1) ln(pi/(2 rD)) + (1/hpD) ln[hpD/(2 + hpD) sqrt((A - 1)/(B - 1))]';
export const SKIN_SPLIT_FORMULA = 's_d = (hp/h) (s - s_pp)';

const refuse = (code, reason) => ({ ok: false, code, reason });

/**
 * Shared input checks. Returns { ok: true, hp, h1, fullyOpen } with hp and
 * h1 snapped inside the pay when they overshoot by less than the tolerance.
 */
const checkGeometry = ({ h, hp, h1 = 0, rw, kvkh }) => {
  if (!fin(h) || !(h > 0)) return refuse('no-net-pay', 'Net pay h is missing or not positive.');
  if (!fin(hp) || !(hp > 0)) return refuse('no-open-interval', 'The perforated length is missing or not positive.');
  if (!fin(rw) || !(rw > 0)) return refuse('no-wellbore-radius', 'Wellbore radius rw is missing or not positive.');
  if (!fin(kvkh) || !(kvkh > 0)) return refuse('no-anisotropy', 'kv/kh is missing or not positive; with no vertical permeability the pseudo-skin is unbounded.');
  if (!fin(h1) || h1 < 0) return refuse('bad-offset', 'The distance from the top of the pay to the top of the perforations is negative.');
  const slack = FULL_PENETRATION_TOLERANCE * h;
  if (hp > h + slack) return refuse('interval-longer-than-pay', 'The perforated length is greater than net pay h.');
  if (h1 + hp > h + slack) return refuse('interval-outside-pay', 'The perforated interval runs below the base of the net pay.');
  const hpIn = Math.min(hp, h);
  const h1In = Math.min(h1, h - hpIn);
  return { ok: true, hp: hpIn, h1: h1In, fullyOpen: hpIn >= h - slack };
};

/**
 * Papatzacos (1987) pseudo-skin.
 * @param {{h: number, hp: number, h1?: number, rw: number, kvkh: number}} a
 *   h net pay, hp perforated length, h1 top of pay to top of perforations
 *   (0 when the interval starts at the top of the pay), rw wellbore radius,
 *   kvkh vertical over horizontal permeability
 * @returns {{ok: true, spp: number, hpD: number, h1D: number, rD: number,
 *   A: number, B: number, fullyOpen: boolean, method: string, formula: string,
 *   reference: string} | {ok: false, code: string, reason: string}}
 */
export const papatzacosPseudoSkin = ({ h, hp, h1 = 0, rw, kvkh }) => {
  const g = checkGeometry({ h, hp, h1, rw, kvkh });
  if (!g.ok) return g;
  const hpD = g.hp / h;
  const h1D = g.h1 / h;
  const rD = (rw / h) * Math.sqrt(kvkh);
  const A = 1 / (h1D + hpD / 4);
  const B = 1 / (h1D + (3 * hpD) / 4);
  const meta = {
    hpD, h1D, rD, A, B, fullyOpen: g.fullyOpen,
    method: 'Papatzacos (1987)', formula: PAPATZACOS_FORMULA, reference: PAPATZACOS_REFERENCE,
  };
  // the whole pay is open: no convergence, and the formula's own value is 0
  if (g.fullyOpen) return { ok: true, spp: 0, ...meta };
  const spp = (1 / hpD - 1) * Math.log(Math.PI / (2 * rD))
    + (1 / hpD) * Math.log((hpD / (2 + hpD)) * Math.sqrt((A - 1) / (B - 1)));
  if (!fin(spp)) return refuse('not-computable', 'The pseudo-skin could not be evaluated for this geometry.');
  return { ok: true, spp, ...meta };
};

/** Brons and Marting G(b), the polynomial form of their chart. */
export const bronsMartingG = (b) => 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;

/**
 * Brons and Marting (1961) pseudo-skin for an interval at the top or the
 * base of the pay ('edge') or centred in it ('centre').
 * @returns {{ok: true, spp: number, b: number, hD: number, G: number,
 *   method: string, reference: string} | {ok: false, code, reason}}
 */
export const bronsMartingPseudoSkin = ({ h, hp, rw, kvkh, position = 'edge' }) => {
  const g = checkGeometry({ h, hp, h1: 0, rw, kvkh });
  if (!g.ok) return g;
  if (position !== 'edge' && position !== 'centre') {
    return refuse('bad-position', 'Brons and Marting cover an interval at the top or base of the pay, or centred in it.');
  }
  const b = g.hp / h;
  const hs = position === 'centre' ? h / 2 : h;
  const hD = (hs / rw) * Math.sqrt(1 / kvkh);
  const G = bronsMartingG(b);
  const meta = { b, hD, G, method: 'Brons and Marting (1961)', reference: BRONS_MARTING_REFERENCE };
  if (g.fullyOpen) return { ok: true, spp: 0, ...meta };
  return { ok: true, spp: (1 / b - 1) * (Math.log(hD) - G), ...meta };
};

/**
 * Split a tested total skin into the partial-penetration pseudo-skin and
 * the mechanical (damage) skin of the open interval.
 * @param {{totalSkin: number, h: number, hp: number, spp: number}} a
 * @returns {{ok: true, totalSkin: number, spp: number, mechanicalSkin: number,
 *   openFraction: number, formula: string, reference: string}
 *   | {ok: false, code, reason}}
 */
export const decomposeSkin = ({ totalSkin, h, hp, spp }) => {
  if (!fin(totalSkin)) return refuse('no-total-skin', 'There is no total skin to split.');
  if (!fin(spp)) return refuse('no-pseudo-skin', 'There is no partial-penetration pseudo-skin to remove.');
  if (!fin(h) || !(h > 0) || !fin(hp) || !(hp > 0)) return refuse('no-geometry', 'Net pay and perforated length are needed to split the skin.');
  if (hp > h * (1 + FULL_PENETRATION_TOLERANCE)) return refuse('interval-longer-than-pay', 'The perforated length is greater than net pay h.');
  const openFraction = Math.min(hp / h, 1);
  return {
    ok: true,
    totalSkin,
    spp,
    mechanicalSkin: openFraction * (totalSkin - spp),
    openFraction,
    formula: SKIN_SPLIT_FORMULA,
    reference: SKIN_SPLIT_REFERENCE,
  };
};

/**
 * One call for a report: the Papatzacos pseudo-skin and, when a total skin
 * is given, the mechanical skin left after removing it.
 * @returns the papatzacosPseudoSkin result, plus `split` (decomposeSkin's
 *   result, or null when no total skin was passed)
 */
export const partialPenetrationSkin = ({ totalSkin, h, hp, h1 = 0, rw, kvkh }) => {
  const pp = papatzacosPseudoSkin({ h, hp, h1, rw, kvkh });
  if (!pp.ok) return pp;
  const hpUsed = pp.hpD * h;
  return {
    ...pp,
    split: fin(totalSkin) ? decomposeSkin({ totalSkin, h, hp: hpUsed, spp: pp.spp }) : null,
  };
};
