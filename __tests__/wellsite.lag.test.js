/**
 * WS3 lag engine against test-data/wellsite/lag-goldens.json (stdlib
 * oracle tools/validation/wellsite/oracle_lag.py, hand numbers in the
 * README): G1 constant rate, G2 rate change during the lag, G3 connection
 * then restart, G4 casing shoe and BHA geometry, G5 a floater with a marine
 * riser and a booster pump (two legs), G6 the booster switched on during
 * the riser leg.
 */
import g from '../test-data/wellsite/lag-goldens.json';
import {
  engineGeometry, stringAtBit, stationsToBit, annulusSections, lagStrokesAt, lagTimeMin, validatePumpLog, spmAt,
  strokesBetween, timeForStrokes, bitDepthAt, cutTimeOf, arrivalPrediction, laggedDepthNow, lagReadout,
  geometryWithRiser, lagLegsAt, ratesAt, volumeBetween, timeForVolume, legArrival,
} from '../engines/wellsite/lag';

const FT = 0.3048;
const IN = 0.0254;
const MIN = 60000;
const T0 = Date.parse('2026-09-07T06:00:00Z');
const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThan(tol);

const openHole = [{ from_md_m: 0, to_md_m: 4000, cased: false, hole_id_m: 12.25 * IN }];
const dp = { odM: 5 * IN, idM: 4.276 * IN };
const ctx = { geometry: openHole, bha: [], drillpipe: dp, stations: null, m3PerStroke: g.m3PerStroke };
const bit = 10000 * FT;

describe('geometry and volumes', () => {
  test('stored hole sections map to the engine shape with the casing ID where cased', () => {
    const geom = engineGeometry([{ from_md_m: 0, to_md_m: 100, cased: true, casing_id_m: 0.3, hole_id_m: 0.4 }, { from_md_m: 100, to_md_m: 200, cased: false, hole_id_m: 0.31 }]);
    expect(geom).toEqual([{ fromMd: 0, toMd: 100, holeIdM: 0.3, cased: true }, { fromMd: 100, toMd: 200, holeIdM: 0.31, cased: false }]);
  });
  test('the string reaches the bit: BHA then drillpipe; the survey extends to the bit', () => {
    const s = stringAtBit({ bha: [{ lengthM: 100, odM: 0.2, idM: 0.07 }], drillpipe: dp, bitMdM: 1000 });
    expect(s.map((c) => c.lengthM)).toEqual([100, 900]);
    expect(stringAtBit({ bha: [{ lengthM: 100, odM: 0.2, idM: 0.07 }], drillpipe: dp, bitMdM: 50 })).toEqual([{ lengthM: 50, odM: 0.2, idM: 0.07, label: 'BHA' }]);
    const st = stationsToBit([{ md: 0, inc: 0, azi: 0 }, { md: 500, inc: 30, azi: 90 }], 800);
    expect(st[2]).toEqual({ md: 800, inc: 30, azi: 90 });
    expect(stationsToBit(null, 800)[1].md).toBe(800);
    expect(() => stringAtBit({ drillpipe: dp, bitMdM: 0 })).toThrow('Bit depth must be positive.');
  });
  test('12.25 in hole with 5 in drillpipe to 10,000 ft: capacity, volume, lag strokes', () => {
    const a = annulusSections({ ...ctx, bitMdM: bit });
    near(a.rows[0].capM2, g.annulusCapM2PerM, 1e-9);
    near(a.annulusVolumeM3, g.annulusVolumeM3_10000ft, 1e-6);
    const l = lagStrokesAt(ctx, bit);
    near(l.lagStrokes, g.lagStrokes_10000ft, 1e-6);
    near(lagTimeMin({ lagStrokes: l.lagStrokes, spm: 60 }), g.G1.lagTimeMin, 1e-6);
    expect(lagTimeMin({ lagStrokes: l.lagStrokes, spm: 0 })).toBeNull();
    expect(l.warnings).toEqual([]);
  });
  test('G4: the casing shoe, the open hole and the collars each carry their own capacity', () => {
    const geometry = [
      { from_md_m: 0, to_md_m: 3000 * FT, cased: true, casing_id_m: 12.347 * IN, hole_id_m: 17.5 * IN },
      { from_md_m: 3000 * FT, to_md_m: 4000, cased: false, hole_id_m: 12.25 * IN },
    ];
    const bha = [{ lengthM: 600 * FT, odM: 8 * IN, idM: 2.8125 * IN }];
    const a = annulusSections({ geometry, bha, drillpipe: dp, stations: null, bitMdM: bit });
    const cased = a.rows.filter((r) => r.cased);
    const collars = a.rows.filter((r) => r.toMd > bit - 1e-6);
    near(cased[0].capM2, g.G4.capCasedM2PerM, 1e-9);
    near(cased.reduce((s, r) => s + r.volM3, 0), g.G4.volCasedM3, 1e-6);
    near(collars[0].capM2, g.G4.capCollarsM2PerM, 1e-9);
    near(a.annulusVolumeM3, g.G4.annulusVolumeM3, 1e-6);
    near(lagStrokesAt({ geometry, bha, drillpipe: dp, stations: null, m3PerStroke: g.m3PerStroke }, bit).lagStrokes, g.G4.lagStrokes, 1e-6);
  });
  test('a hole section list that stops short of the bit is reported', () => {
    const a = annulusSections({ ...ctx, geometry: [{ from_md_m: 0, to_md_m: 1000, cased: false, hole_id_m: 12.25 * IN }], bitMdM: bit });
    expect(a.warnings[0]).toMatch(/cover 1000 m of the 3048 m to the bit/);
  });
});

describe('pump log', () => {
  const log = [{ utcMs: T0, spm: 60 }, { utcMs: T0 + 60 * MIN, spm: 40 }, { utcMs: T0 + 120 * MIN, spm: 0 }, { utcMs: T0 + 130 * MIN, spm: 60 }];
  test('validation, rate lookup and piecewise integration', () => {
    expect(validatePumpLog(log)).toEqual([]);
    expect(validatePumpLog([{ utcMs: T0, spm: -1 }, { utcMs: T0 - 1, spm: 1 }])).toEqual(['Pump event 1 needs a rate of zero or more strokes per minute.', 'Pump event 2 is out of time order.']);
    expect(spmAt(log, T0 - 1)).toBe(0);
    expect(spmAt(log, T0 + 61 * MIN)).toBe(40);
    near(strokesBetween(log, T0, T0 + 30 * MIN), 1800, 1e-9);
    near(strokesBetween(log, T0 + 30 * MIN, T0 + 90 * MIN), 1800 + 1200, 1e-9);
    near(strokesBetween(log, T0 + 100 * MIN, T0 + 140 * MIN), 800 + 0 + 600, 1e-9);
    expect(strokesBetween(log, T0 + 10 * MIN, T0)).toBe(0);
  });
  test('time for strokes walks the log, extrapolates a steady rate, and says when the pumps are off', () => {
    near(timeForStrokes(log, T0, 3600).utcMs, T0 + 60 * MIN, 1);
    near(timeForStrokes(log, T0, 3600 + 800).utcMs, T0 + 80 * MIN, 1);
    const off = timeForStrokes([{ utcMs: T0, spm: 60 }, { utcMs: T0 + 30 * MIN, spm: 0 }], T0, 5000);
    expect(off).toMatchObject({ reached: false, strokesRemaining: 3200 });
    const ext = timeForStrokes([{ utcMs: T0, spm: 60 }], T0, 6000);
    expect(ext.extrapolated).toBe(true);
    near(ext.utcMs, T0 + 100 * MIN, 1);
  });
});

describe('bit depth history', () => {
  const hist = [{ utcMs: T0, mdM: 3000 }, { utcMs: T0 + 60 * MIN, mdM: 3030 }];
  test('linear between points, flat outside, and the first crossing time', () => {
    expect(bitDepthAt(hist, T0 - MIN)).toBe(3000);
    near(bitDepthAt(hist, T0 + 30 * MIN), 3015, 1e-9);
    expect(bitDepthAt(hist, T0 + 90 * MIN)).toBe(3030);
    near(cutTimeOf(hist, 3015), T0 + 30 * MIN, 1);
    expect(cutTimeOf(hist, 3031)).toBeNull();
    expect(cutTimeOf(hist, 2990)).toBe(T0);
    expect(bitDepthAt([], T0)).toBeNull();
  });
});

describe('reference cases', () => {
  test('G1 constant 60 spm: arrival after the lag time; lagged depth while drilling ahead at 50 ft/hr', () => {
    const log = [{ utcMs: T0 - 600 * MIN, spm: 60 }];
    const p = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit, lagCtx: ctx, pumpLog: log, nowUtcMs: T0 });
    near(p.arrivalUtcMs, T0 + g.G1.lagTimeMin * MIN, 100);
    expect(p.reached).toBe(false);
    near(p.lagTimeAtCurrentSpmMin, g.G1.lagTimeMin, 1e-6);
    const hist = [{ utcMs: T0 - 600 * MIN, mdM: bit - 500 * FT }, { utcMs: T0, mdM: bit }, { utcMs: T0 + 240 * MIN, mdM: bit + 200 * FT }];
    const l = laggedDepthNow({ nowUtcMs: T0 + 240 * MIN, bitDepthHistory: hist, pumpLog: log, lagCtx: ctx });
    expect(l.converged).toBe(true);
    near(l.laggedMdM / FT, g.G1.laggedDepthFt, 0.05);
    near((T0 + 240 * MIN - l.cutUtcMs) / MIN, 240 - g.G1.cutMinutesBeforeNow, 0.01);
    const r = lagReadout({ nowUtcMs: T0 + 240 * MIN, bitMdM: bit + 200 * FT, bitDepthHistory: hist, pumpLog: log, lagCtx: ctx });
    expect(r.spmNow).toBe(60);
    near(r.laggedMdM / FT, g.G1.laggedDepthFt, 0.05);
    near(r.lagStrokes, g.lagStrokesPerFt * 10200, 1e-3);
  });
  test('G2 rate change during the lag: the arrival moves and the readout at 40 spm differs from it', () => {
    const log = [{ utcMs: T0, spm: 60 }, { utcMs: T0 + 60 * MIN, spm: 40 }];
    const p = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit, lagCtx: ctx, pumpLog: log, nowUtcMs: T0 + 90 * MIN });
    near((p.arrivalUtcMs - T0) / MIN, g.G2.arrivalMin, 1e-6);
    near(lagTimeMin({ lagStrokes: p.lagStrokes, spm: 40 }), g.G2.lagTimeAt40Min, 1e-6);
    expect(Math.abs(g.G2.arrivalMin - g.G2.lagTimeAt40Min)).toBeGreaterThan(1);
    near(p.strokesDone, 3600 + 30 * 40, 1e-6);
  });
  test('G3 connection then restart: pumps off for 10 minutes; lag time is undefined while off', () => {
    const log = [{ utcMs: T0, spm: 60 }, { utcMs: T0 + 30 * MIN, spm: 0 }, { utcMs: T0 + 40 * MIN, spm: 60 }];
    const p = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit, lagCtx: ctx, pumpLog: log, nowUtcMs: T0 + 50 * MIN });
    near((p.arrivalUtcMs - T0) / MIN, g.G3.arrivalMin, 1e-6);
    const during = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit, lagCtx: ctx, pumpLog: log.slice(0, 2), nowUtcMs: T0 + 35 * MIN });
    near(during.strokesRemaining, g.G3.strokesRemainingAt35, 1e-6);
    expect(during.lagTimeAtCurrentSpmMin).toBeNull();
    expect(during.arrivalUtcMs).toBeNull();
    expect(during.note).toBe('Pumps are off, lag time is undefined until circulation restarts.');
  });
  test('before enough strokes have been pumped the lagged depth is honestly unknown', () => {
    const hist = [{ utcMs: T0, mdM: bit }];
    const l = laggedDepthNow({ nowUtcMs: T0 + 10 * MIN, bitDepthHistory: hist, pumpLog: [{ utcMs: T0, spm: 60 }], lagCtx: ctx });
    expect(l.converged).toBe(false);
    expect(l.laggedMdM).toBeNull();
    expect(l.note).toMatch(/not reached surface yet/);
  });
});

describe('floater: marine riser and booster pump (G5, G6)', () => {
  const bit15 = 15000 * FT;
  const riser = { toMd: 5000 * FT, idM: 19.5 * IN };
  const geometry = [
    { from_md_m: 5000 * FT, to_md_m: 8000 * FT, cased: true, casing_id_m: 12.347 * IN, hole_id_m: 17.5 * IN },
    { from_md_m: 8000 * FT, to_md_m: 5000, cased: false, hole_id_m: 12.25 * IN },
  ];
  const fctx = { geometry, bha: [], drillpipe: dp, stations: null, riser, m3PerStroke: g.m3PerStroke, boosterM3PerStroke: g.G5.boosterM3PerStroke };

  test('the riser sits above the hole sections; sections inside or across the BOP are clipped and reported', () => {
    const gw = geometryWithRiser(geometry, riser);
    expect(gw.rows[0]).toMatchObject({ fromMd: 0, toMd: 5000 * FT, holeIdM: 19.5 * IN, cased: true, riser: true });
    expect(gw.warnings).toEqual([]);
    const bad = geometryWithRiser([{ from_md_m: 0, to_md_m: 3000 * FT, cased: true, casing_id_m: 0.3, hole_id_m: 0.4 }, { from_md_m: 3000 * FT, to_md_m: 9000 * FT, cased: false, hole_id_m: 0.31 }], riser);
    expect(bad.rows).toHaveLength(2);
    expect(bad.rows[1].fromMd).toBeCloseTo(5000 * FT, 9);
    expect(bad.warnings[0]).toMatch(/inside the riser and is ignored/);
    expect(bad.warnings[1]).toMatch(/overlaps the riser; clipped/);
    expect(geometryWithRiser(geometry, null).rows).toHaveLength(2);
  });

  test('G5 volumes: the riser leg and the well leg are summed separately', () => {
    const a = annulusSections({ ...fctx, bitMdM: bit15 });
    expect(a.rows.filter((r) => r.riser)).toHaveLength(1);
    near(a.rows[0].capM2, g.G5.capRiserM2PerM, 1e-9);
    near(a.riserVolumeM3, g.G5.volRiserM3, 1e-6);
    near(a.wellVolumeM3, g.G5.volWellM3, 1e-6);
    const legs = lagLegsAt(fctx, bit15);
    near(legs.wellStrokes + legs.riserStrokesNoBooster, g.G5.lagStrokesNoBooster, 1e-6);
    expect(legs.warnings).toEqual([]);
  });

  test('G5 steady state: main 60 spm and booster 40 spm; the riser leg runs on both pumps', () => {
    const log = [{ utcMs: T0 - 600 * MIN, spm: 60, boosterSpm: 40 }];
    expect(ratesAt(log, T0)).toEqual({ spm: 60, boosterSpm: 40 });
    const p = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit15, lagCtx: fctx, pumpLog: log, nowUtcMs: T0 });
    near((p.arrivalUtcMs - T0) / MIN, g.G5.arrivalMin, 1e-6);
    near(p.lagTimeAtCurrentSpmMin, g.G5.arrivalMin, 1e-6);
    near(p.lagStrokes, g.G5.lagStrokesAtRatio, 1e-6);
    expect(p.boosterSpmNow).toBe(40);
    near(p.legs.riserStartUtcMs - T0, g.G5.wellLegMin * MIN, 100);
    // the booster shortens the lag against the same main-pump rate alone
    const noBooster = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit15, lagCtx: fctx, pumpLog: [{ utcMs: T0 - 600 * MIN, spm: 60 }], nowUtcMs: T0 });
    near((noBooster.arrivalUtcMs - T0) / MIN, g.G5.arrivalMinNoBooster, 1e-6);
    near(noBooster.lagStrokes, g.G5.lagStrokesNoBooster, 1e-6);
    expect(g.G5.arrivalMinNoBooster - g.G5.arrivalMin).toBeGreaterThan(30);
    // the readout carries both rates and the split
    const r = lagReadout({ nowUtcMs: T0, bitMdM: bit15, bitDepthHistory: [{ utcMs: T0 - 600 * MIN, mdM: bit15 }], pumpLog: log, lagCtx: fctx });
    expect(r.boosterSpmNow).toBe(40);
    near(r.lagTimeMin, g.G5.arrivalMin, 1e-6);
    near(r.riserM3, g.G5.volRiserM3, 1e-6);
    near((r.bottomsUpUtcMs - T0) / MIN, g.G5.arrivalMin, 1e-6);
  });

  test('G6 the booster switched on at 250 min, during the riser leg', () => {
    const log = [{ utcMs: T0, spm: 60 }, { utcMs: T0 + 250 * MIN, spm: 60, boosterSpm: 40 }];
    const p = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit15, lagCtx: fctx, pumpLog: log, nowUtcMs: T0 + 260 * MIN });
    near((p.arrivalUtcMs - T0) / MIN, g.G6.arrivalMin, 1e-6);
    expect(p.legs.wellDoneM3).toBeCloseTo(g.G5.volWellM3, 6);
    // riser progress by 260: main alone from the end of the well leg to 250, then both for 10 min
    const both = 60 * g.m3PerStroke + 40 * g.G5.boosterM3PerStroke;
    near(p.legs.riserDoneM3, g.G6.riserDoneByBoosterOnM3 + 10 * both, 1e-6);
    // the two-leg walk agrees with the generic volume integrator
    const legs = lagLegsAt(fctx, bit15);
    const t1 = timeForVolume(log, fctx, T0, legs.wellM3, 'well');
    near(volumeBetween(log, fctx, t1.utcMs, T0 + 260 * MIN, 'riser'), p.legs.riserDoneM3, 1e-6);
    const la = legArrival({ cutUtcMs: T0, legs, lagCtx: fctx, pumpLog: log, nowUtcMs: T0 + 260 * MIN });
    near((la.arrivalUtcMs - T0) / MIN, g.G6.arrivalMin, 1e-6);
  });

  test('lagged depth now on a floater: the bisection uses the two-leg arrival', () => {
    const log = [{ utcMs: T0 - 900 * MIN, spm: 60, boosterSpm: 40 }];
    const hist = [{ utcMs: T0 - 900 * MIN, mdM: bit15 - 300 * FT }, { utcMs: T0, mdM: bit15 }];
    const now = T0 + g.G5.arrivalMin * MIN;
    const l = laggedDepthNow({ nowUtcMs: now, bitDepthHistory: hist, pumpLog: log, lagCtx: fctx });
    expect(l.converged).toBe(true);
    // the sample cut at T0 (15,000 ft) arrives exactly now, so the lagged depth is the bit depth at T0
    near(l.laggedMdM, bit15, 0.02);
    near(l.cutUtcMs, T0, 200);
  });

  test('with the booster running but the main pump off, lag time is undefined', () => {
    const log = [{ utcMs: T0, spm: 0, boosterSpm: 40 }];
    const p = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit15, lagCtx: fctx, pumpLog: log, nowUtcMs: T0 + 10 * MIN });
    expect(p.lagTimeAtCurrentSpmMin).toBeNull();
    expect(p.arrivalUtcMs).toBeNull();
    expect(p.note).toMatch(/Pumps are off/);
    expect(validatePumpLog([{ utcMs: T0, spm: 60, boosterSpm: -1 }])).toEqual(['Pump event 1 needs a booster rate of zero or more strokes per minute.']);
  });

  test('a land rig is the floater with no riser and no booster: G1 numbers unchanged through the new integrator', () => {
    const log = [{ utcMs: T0 - 600 * MIN, spm: 60 }];
    const legs = lagLegsAt(ctx, bit);
    expect(legs.riserM3).toBe(0);
    near(legs.wellStrokes, g.lagStrokes_10000ft, 1e-6);
    const p = arrivalPrediction({ cutUtcMs: T0, cutMdM: bit, lagCtx: ctx, pumpLog: log, nowUtcMs: T0 });
    near((p.arrivalUtcMs - T0) / MIN, g.G1.lagTimeMin, 1e-6);
    expect(p.boosterSpmNow).toBe(0);
    expect(p.legs.riserM3).toBe(0);
  });
});
