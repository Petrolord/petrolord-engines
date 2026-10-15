/**
 * Low-frequency model options (QI upgrade P2.8). Every gate calls the
 * shipped functions: kriging weights against a numpy oracle
 * (tools/validation/qi/oracle_lfm_models.py), Dix against layer velocities
 * in closed form, the default options against qi/lfm.js lfmTrace exactly,
 * faults that stop a model averaging across them, and a velocity trend that
 * recovers Gardner's exponent and beats inverse distance away from the wells
 * in a field with a lateral velocity gradient (known truth). Negative
 * controls: inverse-distance weights are not the kriging weights; without
 * the fault the trace mixes both blocks; a shuffled velocity volume loses
 * the trend's advantage.
 */
import fs from 'fs';
import path from 'path';
import {
  okWeights, lfmWeights, lfmTraceModel, segmentsCross, blockedBy, intervalFromRms, fitVelocityTrend, velocityTrendLnAi,
} from '../engines/qi/lfmModels';
import { lfmTrace, blindWellScore } from '../engines/qi/lfm';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/qi/goldens.lfmModels.json'), 'utf8'));
const grid = { t0Ms: 0, dtMs: 4, ns: 120 };

describe('kriging weights', () => {
  test.each(G.kriging.map((c, i) => [i, c]))('case %i against numpy', (i, c) => {
    const w = okWeights(c.pts.map(([x, y]) => ({ x, y })), { x: c.at[0], y: c.at[1] }, c.variogram);
    c.weights.forEach((v, k) => expect(w[k]).toBeCloseTo(v, 10));
    expect(w.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 12);
  });
  test('symmetric wells share the weight; a well at the target takes it all; negative control: IDW is not kriging', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
    Array.from(okWeights(pts, { x: 50, y: 50 }, { model: 'spherical', range: 400, sill: 1 })).forEach((v) => expect(v).toBeCloseTo(0.25, 12));
    expect(Array.from(okWeights(pts, { x: 100, y: 0 }, { model: 'spherical', range: 400, sill: 1 }))).toEqual([0, 1, 0, 0]);
    const c = G.kriging[4];
    const wells = c.pts.map(([x, y], i) => ({ name: `W${i}`, x, y }));
    const raw = lfmWeights(wells, { x: c.at[0], y: c.at[1] }).weights;
    const idw = raw.map((v) => v / raw.reduce((a, b) => a + b, 0));
    expect(Math.max(...c.weights.map((v, k) => Math.abs(v - idw[k])))).toBeGreaterThan(0.01);
  });
});

const flat = (name, x, y, v, extra = {}) => ({ name, x, y, t0Ms: 0, dtMs: 4, values: Float64Array.from({ length: 120 }, (_, k) => v + 0.001 * k), ...extra });

test('the default options equal lfm.js lfmTrace exactly (with horizons and a left-out well)', () => {
  const wells = [flat('A', 0, 0, 8.5, { horizons: [100, 300] }), flat('B', 900, 200, 8.7, { horizons: [120, 340] }), flat('C', 300, 800, 8.6, { horizons: [90, 280] })];
  const at = { x: 400, y: 300, horizons: [110, 320] };
  expect(Array.from(lfmTraceModel(wells, at, grid))).toEqual(Array.from(lfmTrace(wells, at, grid)));
  expect(Array.from(lfmTraceModel(wells, at, grid, { exclude: 'B' }))).toEqual(Array.from(lfmTrace(wells, at, grid, { exclude: 'B' })));
});

describe('faults in the framework', () => {
  const fault = [[{ x: 500, y: -1000 }, { x: 500, y: 2000 }]];
  const wells = [flat('West', 0, 0, 8.4), flat('East', 1000, 0, 8.9)];
  test('a trace west of the fault takes only the western well; negative control: without it both mix', () => {
    const t = lfmTraceModel(wells, { x: 400, y: 0 }, grid, { barriers: fault });
    expect(t[10]).toBeCloseTo(8.4 + 0.01, 12);
    const mixed = lfmTraceModel(wells, { x: 400, y: 0 }, grid);
    expect(mixed[10]).toBeGreaterThan(8.45);
    expect(lfmWeights(wells, { x: 400, y: 0 }, { barriers: fault }).blocked).toEqual(['East']);
  });
  test('every well blocked falls back to all of them and says so; the crossing test', () => {
    const box = [[{ x: 350, y: -50 }, { x: 450, y: -50 }, { x: 450, y: 50 }, { x: 350, y: 50 }, { x: 350, y: -50 }]];
    expect(lfmWeights(wells, { x: 400, y: 0 }, { barriers: box }).fallback).toBe(true);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 5, y: 0 }, { x: 9, y: 0 })).toBe(false);
    expect(blockedBy(fault, { x: 0, y: 0 }, { x: 400, y: 0 })).toBe(false);
  });
});

test('Dix from RMS gives back the layer velocities', () => {
  const v = intervalFromRms(G.dix.vrms, G.dix.dt_ms);
  G.dix.vint.forEach((x, i) => expect(v[i]).toBeCloseTo(x, 6));
  // negative control: the RMS itself is not the interval velocity below the first layer
  expect(Math.abs(G.dix.vrms[200] - G.dix.vint[200])).toBeGreaterThan(100);
});

describe('velocity trend', () => {
  // Gardner rho = 0.31 V^0.25, so AI = 0.31 V^1.25; velocity rises eastward and with time
  const vel = (x, k) => 2000 + 0.8 * x + 6 * k;
  const lnAiAt = (x, k) => Math.log(0.31) + 1.25 * Math.log(vel(x, k));
  const wellAt = (name, x) => {
    const v = Float64Array.from({ length: 120 }, (_, k) => vel(x, k));
    const values = Float64Array.from({ length: 120 }, (_, k) => lnAiAt(x, k));
    return { name, x, y: 0, t0Ms: 0, dtMs: 4, values, v };
  };
  const wells = [wellAt('A', 0), wellAt('B', 300)];
  test('the calibration recovers Gardner\'s exponent and constant', () => {
    const fit = fitVelocityTrend(wells.map((w) => ({ lnAi: w.values, v: w.v })));
    expect(fit.b).toBeCloseTo(1.25, 10);
    expect(fit.a).toBeCloseTo(Math.log(0.31), 9);
    expect(fit.r2).toBeCloseTo(1, 9);
  });
  test('far from the wells the trend model follows the truth and inverse distance does not; negative control: a shuffled volume', () => {
    const fit = fitVelocityTrend(wells.map((w) => ({ lnAi: w.values, v: w.v })));
    const withTrend = wells.map((w) => ({ ...w, trend: velocityTrendLnAi(w.v, fit) }));
    const x = 2000;
    const truth = Float64Array.from({ length: 120 }, (_, k) => lnAiAt(x, k));
    const atTrend = { x, y: 0, trend: velocityTrendLnAi(Float64Array.from({ length: 120 }, (_, k) => vel(x, k)), fit) };
    const tr = blindWellScore(lfmTraceModel(withTrend, atTrend, grid), truth);
    const idw = blindWellScore(lfmTraceModel(wells, { x, y: 0 }, grid), truth);
    expect(tr.rmsPct).toBeLessThan(0.01);
    expect(idw.rmsPct).toBeGreaterThan(20);
    // at a well the model is the well
    const atA = lfmTraceModel(withTrend, { x: 0, y: 0, trend: withTrend[0].trend }, grid);
    expect(Math.max(...Array.from(atA, (v, k) => Math.abs(v - wells[0].values[k])))).toBeLessThan(1e-12);
    const shuffled = Float64Array.from({ length: 120 }, (_, k) => vel(x, (k * 37) % 120));
    const bad = blindWellScore(lfmTraceModel(withTrend, { x, y: 0, trend: velocityTrendLnAi(shuffled, fit) }, grid), truth);
    expect(bad.rmsPct).toBeGreaterThan(5 * tr.rmsPct + 1);
  });
  test('refusals: too little overlap, no variation, no variogram, no trend at a well', () => {
    expect(() => fitVelocityTrend([{ lnAi: [1, 2], v: [1, 2] }])).toThrow(/fewer than 10/);
    expect(() => fitVelocityTrend([{ lnAi: new Array(20).fill(8), v: new Array(20).fill(2000) }])).toThrow(/does not vary/);
    expect(() => lfmWeights(wells, { x: 1, y: 1 }, { method: 'kriging' })).toThrow(/variogram/);
    expect(() => lfmTraceModel(wells, { x: 1, y: 1, trend: new Float64Array(120) }, grid)).toThrow(/trend at every well/);
  });
});
