// Wellsite Studio U2-002: light hydrocarbon gas ratios from the
// chromatograph (C1 methane, C2 ethane, C3 propane, C4 butanes iso plus
// normal, C5 pentanes iso plus normal).
//
// Haworth, Sellens and Whittaker (1985), "Interpretation of hydrocarbon
// shows using light (C1 to C5) hydrocarbon gases from mud-log data", AAPG
// Bulletin 69 (8), 1305 to 1310:
//
//   wetness   Wh = 100 x (C2 + C3 + C4 + C5) / (C1 + C2 + C3 + C4 + C5)
//   balance   Bh = (C1 + C2) / (C3 + C4 + C5)
//   character Ch = (C4 + C5) / C3
//
// Read together: Wh under 0.5 with Bh over 100 is very dry gas; Wh 0.5 to
// 17.5 is gas while Bh stays above Wh, and gas with oil or condensate once
// Bh falls below Wh (Ch then separates wet gas or condensate, under 0.5,
// from gas associated with oil, over 0.5); Wh 17.5 to 40 with Bh below Wh
// is oil; Wh over 40 is residual oil.
//
// Pixler (1969), "Formation evaluation by analysis of hydrocarbon ratios",
// Journal of Petroleum Technology 21 (6), 665 to 670: the ratios C1/C2,
// C1/C3, C1/C4 and C1/C5. C1/C2 under 2 is non-productive residual oil, 2
// to 15 oil (2 to 4 low gravity, 4 to 8 medium, 8 to 15 high gravity), 15
// to 65 gas, over 65 non-productive dry gas; a ratio lower than the one
// before it (C1/C4 under C1/C3, say) points to a water-bearing or
// non-productive zone. Only the C1/C2 limits are carried here: the chart
// bands of the other three ratios were not read on a source page and are
// left out rather than quoted from memory.
//
// Read on the page: the Haworth formulas and limits in Baker Hughes INTEQ,
// Advanced Logging Procedures Workbook (80269H Rev. C, 1995), pages 6-6 to
// 6-8; the Pixler limits under 2 and over 65 and the oil gravity bands in
// Diversified Well Logging, "Gas Ratios, Short Overview" (2020). The 15
// boundary between oil and gas is the commonly quoted one.
//
// Every ratio is of like quantities, so the components may be in ppm, in
// percent or in chromatograph units as long as all five share the unit and
// are corrected for background the same way. A ratio whose denominator is
// zero is not computed and says why; nothing is ever divided by a floor.
// These are indications to be read with the cuttings, the shows and the
// drilling data, never a determination of the fluid.

export const HAWORTH_LIMITS = Object.freeze({ wetnessDry: 0.5, wetnessOil: 17.5, wetnessResidual: 40, balanceDry: 100, character: 0.5 });
export const PIXLER_LIMITS = Object.freeze({ residual: 2, oilGas: 15, dryGas: 65 });
/** Pixler oil gravity bands on C1/C2: 2 to 4 low gravity, 4 to 8 medium, 8 to 15 high gravity. */
export const PIXLER_OIL_BANDS = Object.freeze([{ from: 2, to: 4, text: 'low gravity oil' }, { from: 4, to: 8, text: 'medium gravity oil' }, { from: 8, to: 15, text: 'high gravity oil' }]);
export const PPM_PER_PERCENT = 10000;

const num = (v) => (Number.isFinite(v) ? v : 0);

/** Components with the butane and pentane isomers summed. Negative readings are refused. */
export function normaliseComponents(g) {
  const src = g || {};
  const c = {
    c1: src.c1,
    c2: src.c2,
    c3: src.c3,
    c4: Number.isFinite(src.c4) ? src.c4 : (Number.isFinite(src.ic4) || Number.isFinite(src.nc4) ? num(src.ic4) + num(src.nc4) : undefined),
    c5: Number.isFinite(src.c5) ? src.c5 : (Number.isFinite(src.ic5) || Number.isFinite(src.nc5) ? num(src.ic5) + num(src.nc5) : undefined),
  };
  const errors = [];
  for (const k of ['c1', 'c2', 'c3', 'c4', 'c5']) {
    if (c[k] == null) { c[k] = 0; continue; }
    if (!Number.isFinite(c[k])) errors.push(`${k.toUpperCase()} is not a number.`);
    else if (c[k] < 0) errors.push(`${k.toUpperCase()} is negative; a reading corrected for background cannot be below zero.`);
  }
  if (!Number.isFinite(src.c1)) errors.push('C1 (methane) is needed for every ratio.');
  return { ok: errors.length === 0, errors, ...c };
}

/** Haworth wetness (percent), balance and character. A ratio that cannot be formed is null with its reason. */
export function haworthRatios(g) {
  const c = normaliseComponents(g);
  if (!c.ok) return { ok: false, errors: c.errors, wh: null, bh: null, ch: null, notes: [] };
  const heavy = c.c3 + c.c4 + c.c5;
  const total = c.c1 + c.c2 + heavy;
  const notes = [];
  let wh = null; let bh = null; let ch = null;
  if (total > 0) wh = (100 * (c.c2 + heavy)) / total; else notes.push('No gas was read, so no ratio can be formed.');
  if (heavy > 0) bh = (c.c1 + c.c2) / heavy; else if (total > 0) notes.push('No C3, C4 or C5 was read, so the balance ratio has no denominator: the gas is methane and ethane only.');
  if (c.c3 > 0) ch = (c.c4 + c.c5) / c.c3; else if (total > 0) notes.push('No C3 was read, so the character ratio has no denominator.');
  return { ok: true, errors: [], wh, bh, ch, total, heavy, notes };
}

/**
 * The Haworth reading of the three ratios.
 * @returns {{ code, text, basis }} code: none | very_dry_gas | gas | gas_condensate | gas_oil | oil | residual_oil
 */
export function haworthInterpretation({ wh, bh, ch }) {
  const L = HAWORTH_LIMITS;
  if (!Number.isFinite(wh)) return { code: 'none', text: 'No reading', basis: 'No wetness ratio.' };
  if (wh < L.wetnessDry) {
    const confirmed = bh == null || bh > L.balanceDry;
    return { code: 'very_dry_gas', text: 'Very dry gas', basis: confirmed ? 'Wetness under 0.5 and balance over 100 (or no heavier gas at all).' : 'Wetness under 0.5; balance is not over 100, so check the readings.' };
  }
  if (wh > L.wetnessResidual) return { code: 'residual_oil', text: 'Residual oil', basis: 'Wetness over 40.' };
  if (wh >= L.wetnessOil) {
    if (bh != null && bh < wh) return { code: 'oil', text: 'Oil', basis: 'Wetness 17.5 to 40 with balance below wetness.' };
    return { code: 'oil', text: 'Oil (balance not below wetness, check the readings)', basis: 'Wetness 17.5 to 40; balance is not below wetness.' };
  }
  // wetness 0.5 to 17.5: gas
  if (bh == null || bh > wh) return { code: 'gas', text: 'Gas', basis: 'Wetness 0.5 to 17.5 with balance above wetness.' };
  if (!Number.isFinite(ch)) return { code: 'gas_condensate', text: 'Gas with condensate or oil (no character ratio)', basis: 'Wetness 0.5 to 17.5 with balance below wetness; no C3 to form the character ratio.' };
  if (ch < L.character) return { code: 'gas_condensate', text: 'Wet gas or condensate', basis: 'Wetness 0.5 to 17.5, balance below wetness, character under 0.5.' };
  return { code: 'gas_oil', text: 'Gas associated with oil', basis: 'Wetness 0.5 to 17.5, balance below wetness, character 0.5 or more.' };
}

/** Pixler ratios; a ratio with no denominator is null. */
export function pixlerRatios(g) {
  const c = normaliseComponents(g);
  if (!c.ok) return { ok: false, errors: c.errors, c1c2: null, c1c3: null, c1c4: null, c1c5: null };
  const r = (d) => (d > 0 ? c.c1 / d : null);
  return { ok: true, errors: [], c1c2: r(c.c2), c1c3: r(c.c3), c1c4: r(c.c4), c1c5: r(c.c5) };
}

/**
 * The Pixler reading: the fluid from C1/C2, and whether the ratios rise
 * from C1/C2 to C1/C5 as a productive zone's do.
 * @returns {{ code, text, basis, slopeOk, falls }} code: none | residual_oil | oil | gas | dry_gas
 */
export function pixlerInterpretation(r) {
  const L = PIXLER_LIMITS;
  if (!r || !Number.isFinite(r.c1c2)) return { code: 'none', text: 'No reading', basis: 'No C1/C2 ratio (no C2 was read).', slopeOk: null, falls: [] };
  const seq = [['C1/C2', r.c1c2], ['C1/C3', r.c1c3], ['C1/C4', r.c1c4], ['C1/C5', r.c1c5]].filter(([, v]) => Number.isFinite(v));
  const falls = [];
  for (let i = 1; i < seq.length; i += 1) if (seq[i][1] < seq[i - 1][1]) falls.push(`${seq[i][0]} is below ${seq[i - 1][0]}`);
  const slopeOk = falls.length === 0;
  let code; let text; let basis;
  if (r.c1c2 < L.residual) { code = 'residual_oil'; text = 'Non-productive residual oil'; basis = 'C1/C2 under 2.'; }
  else if (r.c1c2 < L.oilGas) { code = 'oil'; text = 'Oil'; basis = 'C1/C2 from 2 to 15.'; }
  else if (r.c1c2 <= L.dryGas) { code = 'gas'; text = 'Gas'; basis = 'C1/C2 from 15 to 65.'; }
  else { code = 'dry_gas'; text = 'Non-productive dry gas'; basis = 'C1/C2 over 65.'; }
  if (!slopeOk) text = `${text}; possibly water-bearing or non-productive (${falls.join(', ')})`;
  return { code, text, basis, slopeOk, falls };
}

/** The oil gravity band of a C1/C2 ratio in the oil range, or null outside it. */
export function pixlerOilGravity(c1c2) {
  if (!Number.isFinite(c1c2)) return null;
  const b = PIXLER_OIL_BANDS.find((x) => c1c2 >= x.from && c1c2 < x.to);
  return b ? b.text : null;
}

/** Percent to ppm and back, for a door that takes either. */
export const percentToPpm = (pct) => pct * PPM_PER_PERCENT;
export const ppmToPercent = (ppm) => ppm / PPM_PER_PERCENT;
