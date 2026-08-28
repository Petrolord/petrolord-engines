/**
 * C7+ single-pseudo characterization — FS4.
 *
 * Turns a measured plus-fraction (MW, specific gravity) into a full PR78
 * component: Søreide (1989) normal boiling point, Kesler-Lee (1976)
 * Tc/Pc, Lee-Kesler acentric factor (Kesler-Lee Watson-K form above
 * Tbr 0.8; Edmister exported as an alternative), Jhaveri & Youngren
 * (SPE 13118) volume shift, the Lohrenz-Bray-Clark (1964) C7+ critical
 * volume, the Firoozabadi et al. (1988) parachor, and the Chueh &
 * Prausnitz (1967) C1-C7+ binary interaction parameter.
 *
 * Source note: the FS plan called this the "Whitson BIP"; the
 * specific-gravity BIP form could not be verified against an accessible
 * printed source, so FS4 ships the modified Chueh-Prausnitz correlation
 * instead — the same one whitsonPVT applies to C1-C7+ pairs (defaults
 * A = 1, B = 1 for PR). All correlation coefficients in this file were
 * cross-checked against published reproductions at build time (SPE
 * 109892 for LBC Vc; whitsonPVT manual for Jhaveri-Youngren and
 * Lee-Kesler; Kesler-Lee via two independent reproductions).
 *
 * Binding FS decisions: single pseudo only — gamma/Pedersen splitting is
 * out of scope. Units psia / °R / ft³ / lb-mol as everywhere in this
 * directory; specific gravity is 60/60 water = 1.
 */

import { COMPONENTS, PLUS_FRACTION_KEY, getBip } from './components.js';
import { mixtureFromKeys } from './pr78.js';

/**
 * Søreide (1989) normal boiling point from MW and specific gravity, °R.
 * Calibrated on C7+ cuts (MW ≳ 90); it runs ~5% high already at nC6.
 */
export function soreideTbR(mw, sg) {
  return 1928.3 - 1.695e5 * (mw ** -0.03522) * (sg ** 3.266)
    * Math.exp(-4.922e-3 * mw - 4.7685 * sg + 3.462e-3 * mw * sg);
}

/** Kesler-Lee (1976) critical temperature, °R (Tb in °R). */
export function keslerLeeTcR(tbR, sg) {
  return 341.7 + 811 * sg + (0.4244 + 0.1174 * sg) * tbR
    + ((0.4669 - 3.2623 * sg) * 1e5) / tbR;
}

/** Kesler-Lee (1976) critical pressure, psia (Tb in °R). */
export function keslerLeePcPsia(tbR, sg) {
  const lnPc = 8.3634 - 0.0566 / sg
    - (0.24244 + 2.2898 / sg + 0.11857 / (sg * sg)) * 1e-3 * tbR
    + (1.4685 + 3.648 / sg + 0.47227 / (sg * sg)) * 1e-7 * tbR * tbR
    - (0.42019 + 1.6977 / (sg * sg)) * 1e-10 * tbR * tbR * tbR;
  return Math.exp(lnPc);
}

/**
 * Lee-Kesler acentric factor. Below Tbr = 0.8 the vapor-pressure form
 * (Pc in psia, atmospheric 14.696); above it the Kesler-Lee heavy form
 * in the Watson characterization factor Kw = Tb^(1/3)/sg.
 */
export function leeKeslerOmega(tbR, tcR, pcPsia, sg) {
  const tbr = tbR / tcR;
  if (tbr > 0.8) {
    const kw = Math.cbrt(tbR) / sg;
    return -7.904 + 0.1352 * kw - 0.007465 * kw * kw + 8.359 * tbr
      + (1.408 - 0.01063 * kw) / tbr;
  }
  const lnPbr = Math.log(pcPsia / 14.696);
  const t6 = tbr ** 6;
  return (-lnPbr - 5.92714 + 6.09648 / tbr + 1.28862 * Math.log(tbr) - 0.169347 * t6)
    / (15.2518 - 15.6875 / tbr - 13.4721 * Math.log(tbr) + 0.43577 * t6);
}

/** Edmister (1958) acentric factor (alternative to Lee-Kesler). */
export function edmisterOmega(tbR, tcR, pcPsia) {
  return ((3 / 7) * Math.log10(pcPsia / 14.696)) / (tcR / tbR - 1) - 1;
}

/**
 * Jhaveri & Youngren (SPE 13118) volume-shift correlation s = 1 - A0/M^A1.
 * Families per their Table: paraffin (default for C7+), naphthene, aromatic.
 */
const JY_FAMILIES = {
  paraffin: { a0: 2.258, a1: 0.1823 },
  naphthene: { a0: 3.004, a1: 0.2324 },
  aromatic: { a0: 2.516, a1: 0.2008 },
};

export function jhaveriYoungrenShift(mw, family = 'paraffin') {
  const f = JY_FAMILIES[family];
  if (!f) throw new Error(`Unknown Jhaveri-Youngren family: ${family}`);
  return 1 - f.a0 / mw ** f.a1;
}

/** Lohrenz-Bray-Clark (1964) C7+ critical volume, ft³/lb-mol. */
export function lbcVcC7PlusFt3(mw, sg) {
  return 21.573 + 0.015122 * mw - 27.656 * sg + 0.070615 * mw * sg;
}

/** Firoozabadi et al. (1988) crude-cut parachor (dyn/cm basis). */
export function firoozabadiParachor(mw) {
  return -11.4 + 3.23 * mw - 0.0022 * mw * mw;
}

/**
 * Modified Chueh & Prausnitz (1967) BIP from critical volumes
 * (ft³/lb-mol on both sides; the ratio is dimensionless):
 *   kij = A·[1 - (2·(vci·vcj)^(1/6) / (vci^(1/3) + vcj^(1/3)))^B]
 * Defaults A = 1, B = 1 (the whitsonPVT PR defaults). The classic
 * Chueh-Prausnitz exponent n = 3 corresponds to A = 1, B = 3.
 */
export function chuehPrausnitzBip(vcI, vcJ, { A = 1, B = 1 } = {}) {
  const ci = Math.cbrt(vcI);
  const cj = Math.cbrt(vcJ);
  const ratio = (2 * Math.sqrt(ci * cj)) / (ci + cj);
  return A * (1 - ratio ** B);
}

/**
 * Characterize a plus fraction from { mw, sg, tbR? }.
 *
 * tbR is optional: measured boiling points win; otherwise Søreide.
 * Returns { comp, bip, meta }: `comp` is a full component object for
 * pr78.mixtureFromKeys `extra`, `bip` the extraBip row for the pseudo
 * (C1 from Chueh-Prausnitz; N2/CO2/H2S reuse the FS1 table's heaviest
 * column, nC6, as the heavy-paraffin convention; other HC pairs zero),
 * `meta` the intermediate quantities for display/audit.
 */
export function characterizePlusFraction(input, opts = {}) {
  const { mw, sg } = input;
  if (!(mw > 0) || !(sg > 0)) throw new Error('Plus fraction needs mw > 0 and sg > 0');
  const {
    family = 'paraffin',
    omegaMethod = 'lee-kesler',
    bipParams = {},
  } = opts;

  const tbR = input.tbR ?? soreideTbR(mw, sg);
  const tcR = keslerLeeTcR(tbR, sg);
  const pcPsia = keslerLeePcPsia(tbR, sg);
  if (!(tbR > 0) || !(tcR > tbR) || !(pcPsia > 0)) {
    throw new Error(`Plus-fraction characterization left the correlation range (mw=${mw}, sg=${sg})`);
  }
  const omega = omegaMethod === 'edmister'
    ? edmisterOmega(tbR, tcR, pcPsia)
    : leeKeslerOmega(tbR, tcR, pcPsia, sg);
  const vcFt3PerLbmol = lbcVcC7PlusFt3(mw, sg);

  const comp = {
    name: `Heptanes-plus (MW ${mw}, SG ${sg})`,
    mw,
    tcR,
    pcPsia,
    omega,
    vcFt3PerLbmol,
    parachor: firoozabadiParachor(mw),
    shift: jhaveriYoungrenShift(mw, family),
  };

  const bip = {
    C1: chuehPrausnitzBip(COMPONENTS.C1.vcFt3PerLbmol, vcFt3PerLbmol, bipParams),
    N2: getBip('N2', 'nC6'),
    CO2: getBip('CO2', 'nC6'),
    H2S: getBip('H2S', 'nC6'),
  };

  return {
    comp,
    bip,
    meta: {
      tbR,
      tbSource: input.tbR !== undefined ? 'measured' : 'soreide',
      tbr: tbR / tcR,
      watsonK: Math.cbrt(tbR) / sg,
      omegaMethod: omegaMethod === 'edmister' ? 'edmister' : 'lee-kesler',
      family,
    },
  };
}

/**
 * Assemble an EOS mixture whose last component is the characterized plus
 * fraction. `plus` is either { mw, sg, tbR? } or a previous
 * characterizePlusFraction result.
 */
export function mixtureWithPlusFraction(baseKeys, plus, opts = {}) {
  const ch = plus.comp ? plus : characterizePlusFraction(plus, opts);
  const keys = [...baseKeys, PLUS_FRACTION_KEY];
  return {
    ...mixtureFromKeys(keys, { [PLUS_FRACTION_KEY]: ch.comp }, { [PLUS_FRACTION_KEY]: ch.bip }),
    plus: ch,
  };
}
