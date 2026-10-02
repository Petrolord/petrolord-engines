/**
 * U2-004 lag check and washout (engines/wellsite/lagCheck.js) against
 * test-data/wellsite/lagcheck-goldens.json, written by the stdlib oracle
 * tools/validation/wellsite/oracle_lagcheck.py in field units (bbl/ft =
 * D^2/1029.4), independently of the SI engine.
 *
 * PUBLISHED: Baker Hughes INTEQ, Advanced Logging Procedures Workbook
 * (80269H Rev. C, December 1995), page 1-3 (down strokes, 968) and page 1-6
 * (effective hole diameter from a carbide lag: 14.20 in enlarged, 11.13 in
 * under gauge). The book rounds capacities to four figures (d^2 x 0.000971),
 * so the published numbers are held to the book's printed precision.
 *
 * L1: carbide check in a hole 20 percent over gauge by volume.
 * L2: a count shorter than the gauge lag (not a washout).
 * Identity: the lag engine on the corrected geometry returns the measured lag.
 * Negative controls: the two classic mistakes (down strokes not subtracted;
 * the excess over the annulus instead of the hole) and a linear diameter
 * scale all land away from the golden, so the gate can tell them apart.
 */
import g from '../test-data/wellsite/lagcheck-goldens.json';
import { carbideLagCheck, downStrokesAt, openHoleGaugeVolumeM3, withWashout, washoutFromDiameters, equivalentHole, excessVolumeM3 } from '../engines/wellsite/lagCheck';
import { lagStrokesAt, engineGeometry } from '../engines/wellsite/lag';

const FT = 0.3048;
const IN = 0.0254;
const BBL = 0.158987294928;
const w = g.well;
const lagCtx = {
  geometry: [
    { from_md_m: 0, to_md_m: w.shoeFt * FT, cased: true, casing_id_m: w.casingIdIn * IN, hole_id_m: 12.25 * IN },
    { from_md_m: w.shoeFt * FT, to_md_m: 12000 * FT, cased: false, hole_id_m: w.holeIn * IN },
  ],
  bha: [{ lengthM: w.dcLenFt * FT, odM: w.dcOdIn * IN, idM: w.dcIdIn * IN }],
  drillpipe: { odM: w.dpOdIn * IN, idM: w.dpIdIn * IN },
  stations: null,
  m3PerStroke: g.pump.m3PerStroke,
};
const bit = w.bitFt * FT;
const rel = (a, b, tol = 1e-9) => expect(Math.abs(a - b) / Math.abs(b)).toBeLessThan(tol);

describe('published: INTEQ Advanced Logging Procedures Workbook', () => {
  const HOLE = 12.25 * IN;
  const ohOnly = { geometry: [{ from_md_m: 0, to_md_m: 1350 * FT, cased: false, hole_id_m: HOLE }] };
  test('page 1-6: 5000 theoretical, 5980 carbide, 0.069 bbl/stk, 1350 ft of 12.25 in hole gives 264.45 bbl and 14.20 in', () => {
    const gaugeM3 = openHoleGaugeVolumeM3(ohOnly, 1350 * FT);
    expect(gaugeM3 / BBL).toBeCloseTo(196.83, 0); // the book's 196.83 uses 0.1458 bbl/ft; pi/4 d^2 gives 196.80
    const excessM3 = excessVolumeM3({ measuredLagStrokes: 5980, calculatedLagStrokes: 5000, m3PerStroke: 0.069 * BBL });
    expect(excessM3 / BBL).toBeCloseTo(67.62, 2);
    const h = equivalentHole({ excessM3, gaugeM3 });
    expect(h.actualM3 / BBL).toBeCloseTo(264.45, 0);
    expect((HOLE * h.diameterFactor) / IN).toBeCloseTo(14.20, 2);
  });
  test('page 1-6: a carbide lag of 4500 gives 162.33 bbl and 11.13 in (under gauge)', () => {
    const gaugeM3 = openHoleGaugeVolumeM3(ohOnly, 1350 * FT);
    const h = equivalentHole({ excessM3: excessVolumeM3({ measuredLagStrokes: 4500, calculatedLagStrokes: 5000, m3PerStroke: 0.069 * BBL }), gaugeM3 });
    expect(h.actualM3 / BBL).toBeCloseTo(162.33, 0);
    // the book's 0.000971 capacity constant is rounded (exact 0.00097144), worth 0.004 in here
    expect(Math.abs((HOLE * h.diameterFactor) / IN - 11.13)).toBeLessThan(0.01);
    expect(h.fraction).toBeLessThan(0);
  });
  test('page 1-3: 6350 ft of 5 in 19.5 lb/ft pipe and 1400 ft of 9 x 3.5 in collars are 968 strokes down at 0.1337 bbl/stk', () => {
    const ctx = {
      geometry: [{ from_md_m: 0, to_md_m: 3000, cased: false, hole_id_m: HOLE }],
      bha: [{ lengthM: 1400 * FT, odM: 9 * IN, idM: 3.5 * IN }], drillpipe: { odM: 5 * IN, idM: 4.276 * IN }, stations: null, m3PerStroke: 0.1337 * BBL,
    };
    const d = downStrokesAt(ctx, 7750 * FT);
    expect(d.stringVolumeM3 / BBL).toBeCloseTo(112.73 + 16.65, 0);
    expect(Math.round(d.downStrokes)).toBe(968);
  });
  test('negative controls on the published case', () => {
    const gaugeM3 = openHoleGaugeVolumeM3(ohOnly, 1350 * FT);
    const excessM3 = excessVolumeM3({ measuredLagStrokes: 5980, calculatedLagStrokes: 5000, m3PerStroke: 0.069 * BBL });
    // a diameter scaled with the volume ratio itself (no square root) reads 16.46 in, not 14.20
    expect(12.25 * (1 + excessM3 / gaugeM3)).toBeGreaterThan(16);
    // the carbide count taken whole, with the 968 down strokes left in, reads 15.5 in
    const withDown = equivalentHole({ excessM3: excessVolumeM3({ measuredLagStrokes: 5980 + 968, calculatedLagStrokes: 5000, m3PerStroke: 0.069 * BBL }), gaugeM3 });
    expect(12.25 * withDown.diameterFactor).toBeGreaterThan(15.4);
    expect(() => equivalentHole({ excessM3: -2 * gaugeM3, gaugeM3 })).toThrow('more than the whole open hole');
    expect(() => equivalentHole({ excessM3: 1, gaugeM3: 0 })).toThrow('must be positive');
  });
});

describe('the pieces against the field-unit oracle', () => {
  test('down strokes are the string capacity over the pump output', () => {
    const d = downStrokesAt(lagCtx, bit);
    rel(d.stringVolumeM3 / BBL, g.stringBbl);
    rel(d.downStrokes, g.downStrokes);
  });
  test('a surface line between the drop point and the string adds its volume', () => {
    const d = downStrokesAt(lagCtx, bit, { surfaceLineM3: 2 * BBL });
    rel(d.downStrokes, g.downStrokes + 2 / g.pump.bblPerStroke);
    expect(() => downStrokesAt(lagCtx, bit, { surfaceLineM3: -1 })).toThrow('zero or more');
  });
  test('the gauge open hole volume is the hole between the shoe and the bit, not the annulus', () => {
    rel(openHoleGaugeVolumeM3(lagCtx, bit) / BBL, g.gaugeOpenHoleBbl);
    rel(lagStrokesAt(lagCtx, bit).lagStrokes, g.calculatedLagStrokes);
  });
});

describe('L1: a carbide check in a washed-out hole', () => {
  const r = carbideLagCheck({ lagCtx, bitMdM: bit, totalStrokes: g.L1.totalStrokes });
  test('measured lag, excess volume, washout and equivalent diameter', () => {
    expect(r.applies).toBe(true);
    rel(r.measuredLagStrokes, g.L1.measuredLagStrokes);
    rel(r.calculatedLagStrokes, g.calculatedLagStrokes);
    rel(r.excessM3 / BBL, g.L1.excessBbl, 1e-8);
    rel(r.washoutFraction, g.L1.washoutFraction, 1e-8);
    rel(r.diameterFactor, g.L1.diameterFactor, 1e-8);
    expect(r.equivalentDiameters).toHaveLength(1);
    rel(r.equivalentDiameters[0].equivalentIdM / IN, g.L1.equivalentDiameterIn, 1e-8);
    expect(r.note).toBe('');
  });
  test('identity: the lag engine on the corrected geometry returns the measured lag', () => {
    const corrected = withWashout(lagCtx, r.washoutFraction);
    expect(Math.abs(lagStrokesAt(corrected, bit).lagStrokes - r.measuredLagStrokes)).toBeLessThan(1e-7);
    // casing untouched, open hole enlarged, the gauge size kept beside it
    expect(corrected.geometry[0].holeIdM).toBe(w.casingIdIn * IN);
    rel(corrected.geometry[1].holeIdM / IN, g.L1.equivalentDiameterIn, 1e-8);
    rel(corrected.geometry[1].gaugeIdM / IN, w.holeIn);
  });
  test('negative controls: the classic mistakes do not reproduce the golden', () => {
    // down strokes not subtracted: the whole count taken as lag
    const noDown = ((g.L1.totalStrokes - r.calculatedLagStrokes) * lagCtx.m3PerStroke) / openHoleGaugeVolumeM3(lagCtx, bit);
    rel(noDown, g.L1.wrongNoDownStrokes, 1e-8);
    expect(Math.abs(noDown - r.washoutFraction)).toBeGreaterThan(0.5);
    // the excess over the open hole ANNULUS instead of the hole
    const annOh = lagStrokesAt(lagCtx, bit).rows.filter((x) => x.cased === false).reduce((a, x) => a + x.volM3, 0);
    rel(r.excessM3 / annOh, g.L1.wrongAnnulusBase, 1e-8);
    expect(Math.abs(r.excessM3 / annOh - r.washoutFraction)).toBeGreaterThan(0.1);
    // a diameter scaled by (1 + washout) instead of its square root overshoots the measured lag
    const linear = { ...lagCtx, geometry: engineGeometry(lagCtx.geometry).map((x) => (x.cased ? x : { ...x, holeIdM: x.holeIdM * (1 + r.washoutFraction) })) };
    expect(lagStrokesAt(linear, bit).lagStrokes - r.measuredLagStrokes).toBeGreaterThan(100);
  });
  test('a zero washout leaves the lag where it was; a negative one is refused', () => {
    expect(lagStrokesAt(withWashout(lagCtx, 0), bit).lagStrokes).toBeCloseTo(g.calculatedLagStrokes, 9);
    expect(() => withWashout(lagCtx, -0.1)).toThrow('zero or more');
  });
});

describe('L2 and the refusals', () => {
  test('a measured lag shorter than calculated is reported and corrects nothing', () => {
    const r = carbideLagCheck({ lagCtx, bitMdM: bit, totalStrokes: g.L2.totalStrokes });
    expect(r.applies).toBe(false);
    expect(r.washoutFraction).toBeNull();
    expect(r.differenceStrokes).toBeCloseTo(g.L2.differenceStrokes, 6);
    rel(r.excessM3 / BBL, g.L2.excessBbl, 1e-8);
    expect(r.note).toMatch(/shorter than the calculated lag/);
    // the under-gauge diameter is reported, never applied
    expect(r.diameterFactor).toBeLessThan(1);
    expect(r.equivalentDiameters[0].equivalentIdM).toBeLessThan(w.holeIn * IN);
  });
  test('a count below the down strokes measures nothing', () => {
    const r = carbideLagCheck({ lagCtx, bitMdM: bit, totalStrokes: 1000 });
    expect(r.applies).toBe(false);
    expect(r.differenceStrokes).toBeNull();
    expect(r.note).toMatch(/fewer than the strokes to pump the tracer down/);
    expect(() => carbideLagCheck({ lagCtx, bitMdM: bit, totalStrokes: 0 })).toThrow('must be positive');
  });
  test('bit inside casing: a long lag has no open hole to carry it', () => {
    const r = carbideLagCheck({ lagCtx, bitMdM: 5000 * FT, totalStrokes: 5000 });
    expect(r.applies).toBe(false);
    expect(r.differenceStrokes).toBeGreaterThan(0);
    expect(r.note).toMatch(/no open hole above the bit/);
    const short = carbideLagCheck({ lagCtx, bitMdM: 5000 * FT, totalStrokes: 2600 });
    expect(short.differenceStrokes).toBeLessThan(0);
    expect(short.note).toMatch(/bit is inside casing/);
  });
});

describe('floating rig: the check closes with the booster running', () => {
  const floater = {
    ...lagCtx,
    geometry: [
      { from_md_m: 1500, to_md_m: 2500, cased: true, casing_id_m: 12.347 * IN, hole_id_m: 17.5 * IN },
      { from_md_m: 2500, to_md_m: 4000, cased: false, hole_id_m: 12.25 * IN },
    ],
    riser: { toMd: 1500, idM: 19.5 * IN },
    boosterM3PerStroke: 0.012,
  };
  test('a washout put into the geometry is recovered from the strokes at the same booster ratio', () => {
    const rates = { spm: 80, boosterSpm: 60 };
    const washed = withWashout(floater, 0.15);
    const total = lagStrokesAt(washed, 3500, rates).lagStrokes + downStrokesAt(floater, 3500).downStrokes;
    const r = carbideLagCheck({ lagCtx: floater, bitMdM: 3500, totalStrokes: total, ...rates });
    expect(r.washoutFraction).toBeCloseTo(0.15, 9);
    // negative control: the same count read with the booster off understates the washout
    const off = carbideLagCheck({ lagCtx: floater, bitMdM: 3500, totalStrokes: total });
    expect(off.applies ? off.washoutFraction : -1).toBeLessThan(0.15 - 0.05);
  });
});

test('caliper: 9.311 in on an 8.5 in bit is 20 percent by volume', () => {
  expect(washoutFromDiameters(8.5 * IN, g.L1.equivalentDiameterIn * IN)).toBeCloseTo(0.2, 9);
  expect(() => washoutFromDiameters(0, 1)).toThrow('positive');
});
