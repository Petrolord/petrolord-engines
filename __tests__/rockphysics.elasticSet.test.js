/**
 * Elastic set and local shear regression gates (QI programme Q1, A2). Every
 * gate calls the shipped function. Expected values come from the stdlib oracle
 * (tools/validation/rockphysics/oracle_elastic.py, anchors E1-E7 including the
 * published t table); the regression goldens agree with numpy and scipy to
 * 1.5e-12 (crosscheck_elastic_scipy.py). Negative controls must fail.
 */
import fs from 'fs';
import path from 'path';
import {
  elasticPoint, elasticCurves, meanK, referenceValues, eeiPoint, eiPoint, eeiCurve, chiFromSlope,
  fitVsRegression, predictVs, predictVsCurve,
} from '../engines/rockphysics/elasticSet';
import { iterativeVs, shearForWell, gcSandShaleVs } from '../engines/rockphysics/vsEstimate';
import { substituteVels } from '../engines/rockphysics/gassmann';

const U2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/rockphysics/goldens.u2.json'), 'utf8'));

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/rockphysics/goldens.elastic.json'), 'utf8'));
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-30);
const refOf = (r) => ({ vp0: r.ref[0], vs0: r.ref[1], rho0: r.ref[2] });

describe('goldens', () => {
  test('the elastic set at three rocks', () => {
    for (const r of G.elastic) {
      const e = elasticPoint(r.vp, r.vs, r.rho);
      for (const k of ['ai', 'si', 'vpvs', 'pr', 'k', 'mu', 'lambda', 'lambdaRho', 'muRho']) expect(rel(e[k], r[k])).toBeLessThan(1e-12);
    }
  });
  test('EEI from -90 to 90 degrees', () => {
    for (const r of G.eei) expect(rel(eeiPoint(r.vp, r.vs, r.rho, r.chi, { K: r.K, ref: refOf(r) }), r.eei)).toBeLessThan(1e-12);
  });
  test('EI from 0 to 45 degrees', () => {
    for (const r of G.ei) expect(rel(eiPoint(r.vp, r.vs, r.rho, r.theta, { K: r.K, ref: refOf(r) }), r.ei)).toBeLessThan(1e-12);
  });
  test.each(['linear', 'quadratic'])('%s Vs regression: coefficients, error and prediction intervals', (form) => {
    const g = G.regression[form];
    const fit = fitVsRegression(G.regression.samples, { form });
    expect(fit.dof).toBe(g.dof);
    fit.coef.forEach((c, i) => expect(rel(c, g.coef[i])).toBeLessThan(1e-9));
    expect(rel(fit.s, g.s)).toBeLessThan(1e-9);
    for (const p of g.predictions) {
      const r = predictVs(fit, p.vp, { level: 0.9 });
      for (const k of ['vs', 'sigma', 'lo', 'hi']) expect(rel(r[k], p[k])).toBeLessThan(1e-6);
    }
  });
});

describe('identities', () => {
  test('lambda rho from the moduli equals AI^2 - 2 SI^2 (Goodway); mu rho = SI^2', () => {
    const e = elasticPoint(3200, 1700, 2350);
    expect(rel(e.lambda * 2350, e.lambdaRho)).toBeLessThan(1e-12);
    expect(rel(e.mu * 2350, e.muRho)).toBeLessThan(1e-12);
  });
  test('EEI(0) and EI(0) are the acoustic impedance', () => {
    const o = { K: 0.25, ref: { vp0: 3000, vs0: 1500, rho0: 2300 } };
    expect(rel(eeiPoint(3300, 1800, 2380, 0, o), 3300 * 2380)).toBeLessThan(1e-12);
    expect(rel(eiPoint(3300, 1800, 2380, 0, o), 3300 * 2380)).toBeLessThan(1e-12);
  });
  test('EEI log reflectivity is A cos chi + B sin chi exactly (two-term intercept and gradient)', () => {
    const K = 0.25;
    const o = { K, ref: { vp0: 3000, vs0: 1500, rho0: 2300 } };
    const up = [3000, 1500, 2300];
    const lo = [3300, 1800, 2380];
    const L = (i) => Math.log(lo[i] / up[i]);
    const A = 0.5 * (L(0) + L(2));
    const B = 0.5 * L(0) - 4 * K * L(1) - 2 * K * L(2);
    for (const chi of [-60, -30, 0, 19, 45, 90]) {
      const r = 0.5 * Math.log(eeiPoint(...lo, chi, o) / eeiPoint(...up, chi, o));
      const c = (chi * Math.PI) / 180;
      expect(Math.abs(r - (A * Math.cos(c) + B * Math.sin(c)))).toBeLessThan(1e-14);
    }
    expect(chiFromSlope(1)).toBeCloseTo(45, 12);
  });
  test('curves: NaN where a sample is missing or Vs is not below Vp; K and references from the data', () => {
    const logs = { vp: [3000, NaN, 3200, 2000], vs: [1500, 1600, 1700, 2100], rho: [2300, 2300, 2350, 2200] };
    const c = elasticCurves(logs);
    expect(Number.isNaN(c.ai[1])).toBe(true);
    expect(Number.isNaN(c.pr[3])).toBe(true);
    expect(c.ai[2]).toBe(3200 * 2350);
    expect(rel(meanK(logs), ((1500 / 3000) ** 2 + (1700 / 3200) ** 2) / 2)).toBeLessThan(1e-12);
    expect(referenceValues(logs)).toEqual({ vp0: 3100, vs0: 1600, rho0: 2325 });
    const e = eeiCurve(logs, 30, { K: 0.25, ref: { vp0: 3100, vs0: 1600, rho0: 2325 } });
    expect(e).toHaveLength(4);
    expect(Number.isNaN(e[1])).toBe(true);
  });
  test('the prediction interval is narrowest at the mean Vp and flags extrapolation', () => {
    const fit = fitVsRegression(G.regression.samples);
    const mvp = G.regression.samples.reduce((s, p) => s + p.vp, 0) / G.regression.samples.length;
    expect(predictVs(fit, mvp).sigma).toBeLessThan(predictVs(fit, mvp + 600).sigma);
    expect(predictVs(fit, 6000).extrapolated).toBe(true);
    expect(predictVs(fit, mvp).extrapolated).toBe(false);
    const c = predictVsCurve(fit, Float64Array.from([mvp, 6000, NaN]));
    expect(c.extrapolated).toBe(1);
    expect(Number.isNaN(c.vs[2])).toBe(true);
    // a wider level gives a wider interval
    expect(predictVs(fit, mvp, { level: 0.99 }).hi).toBeGreaterThan(predictVs(fit, mvp, { level: 0.9 }).hi);
  });
});

describe('negative controls', () => {
  test('AI^2 - SI^2 is not lambda rho', () => {
    const e = elasticPoint(3200, 1700, 2350);
    expect(rel(e.ai ** 2 - e.si ** 2, e.lambdaRho)).toBeGreaterThan(0.1);
  });
  test('using tan^2 in EEI (an EI mix-up) breaks the reflectivity identity', () => {
    const K = 0.25; const chi = 30; const c = (chi * Math.PI) / 180;
    const up = [3000, 1500, 2300]; const lo = [3300, 1800, 2380];
    const L = (i) => Math.log(lo[i] / up[i]);
    const A = 0.5 * (L(0) + L(2));
    const B = 0.5 * L(0) - 4 * K * L(1) - 2 * K * L(2);
    const wrongP = Math.cos(c) + Math.tan(c) ** 2;
    const wrong = 0.5 * (wrongP * L(0) - 8 * K * Math.sin(c) * L(1) + (Math.cos(c) - 4 * K * Math.sin(c)) * L(2));
    expect(Math.abs(wrong - (A * Math.cos(c) + B * Math.sin(c)))).toBeGreaterThan(1e-4);
  });
  test('a normal quantile in place of Student t gives a narrower, wrong interval on few samples', () => {
    const few = G.regression.samples.slice(0, 6);
    const fit = fitVsRegression(few);
    const r = predictVs(fit, 3000, { level: 0.9 });
    const zHalf = 1.6448536269514722 * r.sigma;
    expect((r.hi - r.vs) / zHalf).toBeGreaterThan(1.2);
  });
});

describe('guards', () => {
  test.each([
    ['too few samples', () => fitVsRegression(G.regression.samples.slice(0, 4))],
    ['an unknown form', () => fitVsRegression(G.regression.samples, { form: 'cubic' })],
    ['no Vp spread', () => fitVsRegression(Array.from({ length: 8 }, (_, i) => ({ vp: 3000, vs: 1500 + i })))],
    ['chi outside -90..90', () => eeiPoint(3000, 1500, 2300, 120, { K: 0.25, ref: { vp0: 3000, vs0: 1500, rho0: 2300 } })],
    ['K out of range', () => eeiPoint(3000, 1500, 2300, 30, { K: 1.5, ref: { vp0: 3000, vs0: 1500, rho0: 2300 } })],
    ['a bad interval level', () => predictVs(fitVsRegression(G.regression.samples), 3000, { level: 1.5 })],
  ])('throws on %s', (_n, fn) => expect(fn).toThrow());
});

describe('a local shear trend drives the hydrocarbon iteration (brineVs)', () => {
  const row = U2.iterative_vs[0];
  const local = (vp) => 0.75 * vp - 650; // a locally calibrated brine trend, different from Greenberg-Castagna
  test('the default is exactly the Greenberg-Castagna procedure', () => {
    const a = iterativeVs({ vp: row.vp, rho: row.rho, phi: row.phi, kmin: row.kmin, fluidInSitu: row.fluid, fluidBrine: row.brine, vsh: row.vsh });
    const b = iterativeVs({ vp: row.vp, rho: row.rho, phi: row.phi, kmin: row.kmin, fluidInSitu: row.fluid, fluidBrine: row.brine, vsh: row.vsh, brineVs: gcSandShaleVs });
    expect(b.vs).toBe(a.vs);
  });
  test('with a local trend the brine state lies on that trend (the fixed point), and not on Greenberg-Castagna', () => {
    const out = iterativeVs({ vp: row.vp, rho: row.rho, phi: row.phi, kmin: row.kmin, fluidInSitu: row.fluid, fluidBrine: row.brine, vsh: row.vsh, brineVs: local });
    expect(out.converged).toBe(true);
    const wet = substituteVels(row.vp, out.vs, row.rho, row.kmin, row.phi, row.fluid, row.brine);
    expect(rel(wet.vs, local(wet.vp))).toBeLessThan(1e-7);
    expect(rel(wet.vs, gcSandShaleVs(wet.vp, row.vsh))).toBeGreaterThan(1e-3);
  });
  test('shearForWell uses the trend when there is no shear log, and the log when there is', () => {
    expect(shearForWell({ vpCurve: [3000], brineVs: local }).vs[0]).toBe(local(3000));
    expect(shearForWell({ vpCurve: [3000], dtsVsCurve: [1234], brineVs: local }).vs[0]).toBe(1234);
  });
});
