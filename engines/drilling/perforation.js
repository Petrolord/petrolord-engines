// Perforation design engine (Drilling D8 — Perforation & Sand Control
// Designer): Karakas-Tariq perforation skin, radial-flow productivity
// ratio, and underbalance guideline bands.
//
// Published bases:
//   * Karakas & Tariq, SPE 18247 (1991), "Semianalytical Productivity
//     Models for Perforated Completions" — the phasing constant tables
//     (alpha, a1, a2, b1, b2, c1, c2) reproduced in Economides et al.,
//     Petroleum Production Systems. Skin components:
//       s_h  = ln(rw / rw'(θ)),  rw'(0°) = lp/4,
//                                rw'(θ)  = α_θ (rw + lp) otherwise
//       s_v  = 10^a · hD^(b−1) · rpD^b
//              hD = (h/lp)·√(kH/kV),  rpD = (rp/2h)·(1+√(kV/kH))
//              a  = a1·log10(rpD) + a2,  b = b1·rpD + b2
//       s_wb = c1·e^(c2·rwD),  rwD = rw/(lp + rw)
//       s_cz = (h/lp)·ln(rc/rp)·(k/kc − 1)   (crushed zone, McLeod form
//              as adopted by the paper)
//   * Productivity ratio: steady-state radial flow,
//       PR = ln(re/rw) / (ln(re/rw) + s)  — the standard skin identity.
//   * Underbalance: PLANNING-LEVEL guideline bands by permeability class
//     (the King 1986-family field guidance). Returned as labeled RANGES
//     with provenance, never a point value; the exact published
//     correlations activate when the owner supplies the papers (L15/L16).
//
// UNITS: STRICT SI at the API (metres, Pa). Shot density enters as
// shots-per-metre; the perf spacing h = 1/spf. Display conversions
// (spf-per-foot, psi) live app-side.
//
// Validation: independent numpy oracle (oracle_perfsand.py) with
// self-asserted closed forms + goldens; jest gates in
// __tests__/drilling.perfsand.test.js; runner gates A26-A27.

// SPE 18247 phasing constants. Key = phasing angle in degrees as used in
// the paper's Table 3 (0° means single-plane / in-line shots).
export const KT_PHASING_TABLE = {
  0: { alpha: 0.250, a1: -2.091, a2: 0.0453, b1: 5.1313, b2: 1.8672, c1: 1.6e-1, c2: 2.675 },
  45: { alpha: 0.860, a1: -1.788, a2: 0.2398, b1: 1.1915, b2: 1.6392, c1: 4.6e-5, c2: 8.791 },
  60: { alpha: 0.813, a1: -1.898, a2: 0.1023, b1: 1.3654, b2: 1.6490, c1: 3.0e-4, c2: 7.509 },
  90: { alpha: 0.726, a1: -1.905, a2: 0.1038, b1: 1.5674, b2: 1.6935, c1: 1.9e-3, c2: 6.155 },
  120: { alpha: 0.648, a1: -2.018, a2: 0.0634, b1: 1.6136, b2: 1.7770, c1: 6.6e-3, c2: 5.320 },
  180: { alpha: 0.500, a1: -2.025, a2: 0.0943, b1: 3.0373, b2: 1.8115, c1: 2.6e-2, c2: 4.532 },
};

export const KT_PHASINGS_DEG = Object.keys(KT_PHASING_TABLE).map(Number).sort((x, y) => x - y);

// The paper's stated development ranges for the s_v correlation. Outside
// them the number is still returned but flagged — never silently.
export const KT_RPD_RANGE = [0.01, 0.18];
export const KT_HD_MAX = 10;

/**
 * Karakas-Tariq perforation skin. All lengths metres.
 *  lpM        perforation tunnel length (beyond the cement sheath)
 *  rpM        perforation tunnel radius
 *  spfPerM    shot density, shots per metre (h = 1/spfPerM)
 *  phasingDeg one of KT_PHASINGS_DEG
 *  rwM        wellbore radius
 *  khOverKv   horizontal/vertical permeability ratio (>= 1 typical)
 *  rcM, kOverKc  crushed-zone radius and permeability damage ratio
 *                (both optional; s_cz = 0 without them)
 */
export function karakasTariq({
  lpM, rpM, spfPerM, phasingDeg, rwM,
  khOverKv = 1, rcM = null, kOverKc = null,
}) {
  if (!(lpM > 0)) throw new Error('Perforation length must be positive.');
  if (!(rpM > 0)) throw new Error('Perforation radius must be positive.');
  if (!(spfPerM > 0)) throw new Error('Shot density must be positive.');
  if (!(rwM > 0)) throw new Error('Wellbore radius must be positive.');
  if (!(khOverKv > 0)) throw new Error('kH/kV must be positive.');
  const tbl = KT_PHASING_TABLE[phasingDeg];
  if (!tbl) throw new Error(`Phasing ${phasingDeg} deg is not in the SPE 18247 tables (${KT_PHASINGS_DEG.join(', ')}).`);

  const warnings = [];
  const hM = 1 / spfPerM; // perf spacing

  // Plane-flow (horizontal) skin via the effective wellbore radius.
  const rwPrimeM = phasingDeg === 0 ? lpM / 4 : tbl.alpha * (rwM + lpM);
  const sH = Math.log(rwM / rwPrimeM);

  // Vertical (converging-flow) skin.
  const hD = (hM / lpM) * Math.sqrt(khOverKv);
  const rpD = (rpM / (2 * hM)) * (1 + Math.sqrt(1 / khOverKv));
  const a = tbl.a1 * Math.log10(rpD) + tbl.a2;
  const b = tbl.b1 * rpD + tbl.b2;
  const sV = 10 ** a * hD ** (b - 1) * rpD ** b;
  if (hD > KT_HD_MAX) warnings.push(`hD ${hD.toFixed(2)} above the correlation development range (<= ${KT_HD_MAX}).`);
  if (rpD < KT_RPD_RANGE[0] || rpD > KT_RPD_RANGE[1]) {
    warnings.push(`rpD ${rpD.toFixed(4)} outside the correlation development range [${KT_RPD_RANGE.join(', ')}].`);
  }

  // Wellbore-blockage skin.
  const rwD = rwM / (lpM + rwM);
  const sWb = tbl.c1 * Math.exp(tbl.c2 * rwD);

  // Crushed zone.
  let sCz = 0;
  if (rcM != null || kOverKc != null) {
    if (!(rcM > rpM)) throw new Error('Crushed-zone radius must exceed the perforation radius.');
    if (!(kOverKc >= 1)) throw new Error('k/kc must be >= 1 (kc is the damaged permeability).');
    sCz = (hM / lpM) * Math.log(rcM / rpM) * (kOverKc - 1);
  }

  const total = sH + sV + sWb + sCz;
  return { sH, sV, sWb, sCz, total, rwPrimeM, hM, hD, rpD, a, b, rwD, warnings };
}

/** Steady-state radial-flow productivity ratio vs the zero-skin ideal. */
export function productivityRatio({ reM, rwM, sTotal }) {
  if (!(reM > rwM) || !(rwM > 0)) throw new Error('Need re > rw > 0.');
  const lnReRw = Math.log(reM / rwM);
  if (sTotal <= -lnReRw) throw new Error('Skin at or below -ln(re/rw): radial-flow PR undefined.');
  const ratio = lnReRw / (lnReRw + sTotal);
  return { ratio, lnReRw };
}

const PSI = 6894.757293168;

// Guideline underbalance bands by permeability class (planning level, the
// King 1986-family field guidance; approx by construction). Pa internally.
export const UNDERBALANCE_BANDS = [
  {
    minKMd: 100, label: 'high permeability (k >= 100 mD)',
    oilPsi: [200, 500], gasPsi: [1000, 2000],
  },
  {
    minKMd: 10, label: 'moderate permeability (10 <= k < 100 mD)',
    oilPsi: [500, 1000], gasPsi: [2000, 5000],
  },
  {
    minKMd: 0, label: 'low permeability (k < 10 mD)',
    oilPsi: [1000, 2000], gasPsi: [5000, 10000],
  },
];

/**
 * Guideline minimum-underbalance band for perforating clean.
 * Returns a RANGE with provenance, never a point value. The advisory cap
 * against sanding (CDP) is composed app-side where the rock data lives.
 */
export function underbalanceAdvice({ kMd, fluid = 'oil' }) {
  if (!(kMd > 0)) throw new Error('Permeability must be positive.');
  if (fluid !== 'oil' && fluid !== 'gas') throw new Error(`Unknown fluid "${fluid}".`);
  const band = UNDERBALANCE_BANDS.find((b) => kMd >= b.minKMd);
  const [loPsi, hiPsi] = fluid === 'oil' ? band.oilPsi : band.gasPsi;
  return {
    minPa: loPsi * PSI,
    maxPa: hiPsi * PSI,
    minPsi: loPsi,
    maxPsi: hiPsi,
    classLabel: band.label,
    fluid,
    approx: true,
    provenance: 'Planning-level field guideline band; the published point '
      + 'correlations (King 1986; Behrmann) activate on the L15/L16 literature gates.',
  };
}
