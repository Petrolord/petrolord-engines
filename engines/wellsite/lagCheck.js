// Wellsite Studio U2-004: the lag check and the washout correction.
//
// A calculated lag assumes a gauge hole. The mudlogger checks it with a
// tracer: calcium carbide (acetylene), rice or a paint marker goes into the
// drillpipe at a connection, travels DOWN the string to the bit and UP the
// annulus to the gas trap or the shakers, and the pump strokes from the drop
// to the detection are counted. The strokes the tracer spent going down are
// the inside volume of the string (plus any surface line between the drop
// point and the string) over the pump output; what is left is the measured
// lag:
//
//   measured lag strokes = total strokes - down strokes
//
// A measured lag longer than the calculated one means the annulus holds more
// mud than the gauge geometry says. The casing is steel, so the extra volume
// is in the open hole:
//
//   excess volume    = (measured - calculated) x pump output
//   washout (volume) = excess volume / gauge volume of the open hole
//
// where the gauge open hole volume is pi/4 D^2 L over the open hole between
// the shoe and the bit (the hole itself, not the annulus: the pipe displaces
// the same volume in a washed-out hole). The same enlargement expressed as a
// diameter is D x sqrt(1 + washout), and withWashout applies that to every
// open hole section so the lag engine (lag.js) carries the correction with
// no second code path. The closing identity, gated to 1e-9: the lag strokes
// calculated on the corrected geometry at the check depth equal the measured
// lag.
//
// On a floating rig the strokes are counted on the main pump, as lag.js
// counts them: the riser leg takes fewer main-pump strokes while the booster
// runs. The excess sits in the open hole, on the well leg, which only the
// main pump feeds, so the excess volume is still the stroke difference
// times the main pump output, provided the check and the calculation use
// the same booster ratio (pass the rates in force during the check).
//
// A measured lag SHORTER than the calculated one is not a washout: the pump
// puts out more per stroke than entered, the geometry is wrong, the tracer
// was missed, or the hole is under gauge (swelling clay, thick cake). The
// engine reports the equivalent diameter either way (equivalentHole), says
// which case it is, and applies a correction only for a washout.
//
// Published case (Baker Hughes INTEQ, Advanced Logging Procedures Workbook,
// 80269H Rev. C, December 1995, page 1-6): theoretical lag 5000 strokes,
// carbide lag 5980, pump 0.069 bbl/stk, 1350 ft of 12.25 in open hole
// (196.83 bbl): actual volume 264.45 bbl, effective diameter 14.20 in; a
// carbide lag of 4500 gives 162.33 bbl and 11.13 in. Page 1-3 of the same
// workbook gives the down strokes: 6350 ft of 5 in 19.5 lb/ft drillpipe
// and 1400 ft of 9 x 3.5 in collars hold 129.38 bbl, 968 strokes at
// 0.1337 bbl/stk, "subtracted from the total strokes". Both are gates.
//
// Inputs are SI (metres, cubic metres); see lag.js for the context shape.

import { annulusSections, engineGeometry, lagStrokesAt } from './lag.js';

/** Gauge open hole volume (the hole, not the annulus) from surface casing shoe to the bit, m3. */
export function openHoleGaugeVolumeM3(lagCtx, bitMdM) {
  let total = 0;
  for (const g of engineGeometry(lagCtx.geometry)) {
    if (g.cased) continue;
    const from = Math.max(0, g.fromMd);
    const to = Math.min(g.toMd, bitMdM);
    if (to > from) total += (Math.PI / 4) * g.holeIdM * g.holeIdM * (to - from);
  }
  return total;
}

/**
 * The open hole a lag difference implies. excessM3 may be negative (an
 * under-gauge hole); the fraction is of the gauge open hole volume and the
 * factor multiplies the gauge diameter.
 */
export function equivalentHole({ excessM3, gaugeM3 }) {
  if (!(gaugeM3 > 0)) throw new Error('The gauge open hole volume must be positive.');
  if (!Number.isFinite(excessM3)) throw new Error('The excess volume must be a number.');
  const fraction = excessM3 / gaugeM3;
  if (!(fraction > -1)) throw new Error('The lag difference removes more than the whole open hole volume; check the counts.');
  return { fraction, diameterFactor: Math.sqrt(1 + fraction), actualM3: gaugeM3 + excessM3 };
}

/** The excess annular volume a lag difference implies: (measured - calculated) x pump output. */
export function excessVolumeM3({ measuredLagStrokes, calculatedLagStrokes, m3PerStroke }) {
  if (!(m3PerStroke > 0)) throw new Error('Pump displacement must be positive.');
  return (measuredLagStrokes - calculatedLagStrokes) * m3PerStroke;
}

/** Strokes for the tracer to travel from the drop point to the bit: string capacity plus any surface line. */
export function downStrokesAt(lagCtx, bitMdM, { surfaceLineM3 = 0 } = {}) {
  if (!(lagCtx && lagCtx.m3PerStroke > 0)) throw new Error('Pump displacement must be positive.');
  if (!(surfaceLineM3 >= 0)) throw new Error('The surface line volume must be zero or more.');
  const a = annulusSections({ ...lagCtx, bitMdM });
  return { downStrokes: (a.stringVolumeM3 + surfaceLineM3) / lagCtx.m3PerStroke, stringVolumeM3: a.stringVolumeM3, surfaceLineM3 };
}

/**
 * A carbide or tracer lag check.
 * @param {Object} p
 * @param {Object} p.lagCtx the lag context (lag.js)
 * @param {number} p.bitMdM bit depth at the drop, m MD
 * @param {number} p.totalStrokes main-pump strokes counted from the drop to the detection
 * @param {number} [p.surfaceLineM3] volume between the drop point and the top of the string
 * @param {number} [p.spm] main pump rate during the check (floaters: sets the booster ratio)
 * @param {number} [p.boosterSpm] booster rate during the check
 * @returns measured and calculated lag, their difference, the excess volume, the washout as a
 *   fraction of the gauge open hole volume, the diameter factor and the equivalent diameters
 */
export function carbideLagCheck({ lagCtx, bitMdM, totalStrokes, surfaceLineM3 = 0, spm = null, boosterSpm = 0 }) {
  if (!(totalStrokes > 0)) throw new Error('The strokes counted from the drop to the detection must be positive.');
  const down = downStrokesAt(lagCtx, bitMdM, { surfaceLineM3 });
  const calc = lagStrokesAt(lagCtx, bitMdM, { spm, boosterSpm });
  const measured = totalStrokes - down.downStrokes;
  const base = {
    bitMdM, totalStrokes, downStrokes: down.downStrokes, stringVolumeM3: down.stringVolumeM3, surfaceLineM3,
    measuredLagStrokes: measured, calculatedLagStrokes: calc.lagStrokes, m3PerStroke: lagCtx.m3PerStroke,
    differenceStrokes: null, differenceFraction: null, excessM3: null, openHoleGaugeM3: null,
    washoutFraction: null, diameterFactor: null, equivalentDiameters: [], applies: false, warnings: [...calc.warnings], note: '',
  };
  if (!(measured > 0)) {
    return { ...base, note: 'The strokes counted are fewer than the strokes to pump the tracer down the string, so no lag can be measured. Check the count and the string.' };
  }
  const diff = measured - calc.lagStrokes;
  const excessM3 = excessVolumeM3({ measuredLagStrokes: measured, calculatedLagStrokes: calc.lagStrokes, m3PerStroke: lagCtx.m3PerStroke });
  const gauge = openHoleGaugeVolumeM3(lagCtx, bitMdM);
  const out = { ...base, differenceStrokes: diff, differenceFraction: diff / calc.lagStrokes, excessM3, openHoleGaugeM3: gauge };
  if (!(gauge > 0)) {
    return { ...out, note: diff < 0
      ? 'The measured lag is shorter than the calculated lag and the bit is inside casing. Check the pump output per stroke and the casing and pipe sizes.'
      : 'The measured lag is longer than the calculated lag but there is no open hole above the bit to carry the difference. Check the casing sizes and the pump output.' };
  }
  let hole;
  try { hole = equivalentHole({ excessM3, gaugeM3: gauge }); } catch (e) { return { ...out, note: e.message }; }
  const equivalentDiameters = engineGeometry(lagCtx.geometry)
    .filter((g) => !g.cased && Math.min(g.toMd, bitMdM) > g.fromMd)
    .map((g) => ({ fromMd: g.fromMd, toMd: Math.min(g.toMd, bitMdM), gaugeIdM: g.holeIdM, equivalentIdM: g.holeIdM * hole.diameterFactor }));
  if (diff < 0) {
    return { ...out, diameterFactor: hole.diameterFactor, equivalentDiameters, note: 'The measured lag is shorter than the calculated lag. That is not a washout: check the pump output per stroke, the hole and pipe sizes, and whether the tracer was detected on its first arrival. If all three are right the hole is under gauge.' };
  }
  return { ...out, washoutFraction: hole.fraction, diameterFactor: hole.diameterFactor, equivalentDiameters, applies: true };
}

/**
 * The lag context with a washout applied: every open hole section is
 * enlarged to D x sqrt(1 + washoutFraction); cased sections and the riser
 * are untouched. A washout of zero returns an equivalent context.
 */
export function withWashout(lagCtx, washoutFraction) {
  if (!Number.isFinite(washoutFraction) || washoutFraction < 0) throw new Error('A washout is zero or more (a fraction of the gauge open hole volume).');
  const factor = Math.sqrt(1 + washoutFraction);
  const geometry = engineGeometry(lagCtx.geometry).map((g) => (g.cased ? g : { ...g, holeIdM: g.holeIdM * factor, gaugeIdM: g.holeIdM }));
  return { ...lagCtx, geometry, washoutFraction };
}

/** The washout fraction from a diameter read on a caliper against the bit size: (Dc/Db)^2 - 1. */
export function washoutFromDiameters(gaugeIdM, measuredIdM) {
  if (!(gaugeIdM > 0) || !(measuredIdM > 0)) throw new Error('Both diameters must be positive.');
  return (measuredIdM * measuredIdM) / (gaugeIdM * gaugeIdM) - 1;
}
