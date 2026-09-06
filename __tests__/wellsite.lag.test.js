/**
 * WS3 lag engine against test-data/wellsite/lag-goldens.json (stdlib
 * oracle tools/validation/wellsite/oracle_lag.py, hand numbers in the
 * README): G1 constant rate, G2 rate change during the lag, G3 connection
 * then restart, G4 casing shoe and BHA geometry.
 */
import g from '../test-data/wellsite/lag-goldens.json';
import {
  engineGeometry, stringAtBit, stationsToBit, annulusSections, lagStrokesAt, lagTimeMin, validatePumpLog, spmAt,
  strokesBetween, timeForStrokes, bitDepthAt, cutTimeOf, arrivalPrediction, laggedDepthNow, lagReadout,
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
