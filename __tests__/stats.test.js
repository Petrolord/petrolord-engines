// lib/stats anti-drift gate (economics extraction EC0, 2026-09-08).
//
// lib/stats/stats.js is the Suite's src/lib/monteCarlo.js with its one
// runtime dependency (simple-statistics 7.8.8) vendored in. The pins in
// test-data/stats/simple_statistics_pins.json were computed in the Suite by
// the REAL simple-statistics and the REAL monteCarlo.js, so this file proves
// the vendored copy is bit-identical: same Kahan sum, same POPULATION
// standard deviation, same quantile rule, same seeded sample streams through
// the correlated sampler, same tornado and sensitivity summaries. Any
// difference here means the two runtimes have drifted, which is exactly the
// section 5 rule (one Monte Carlo implementation) failing.

import fs from 'fs';
import path from 'path';
import * as st from '../lib/stats/stats.js';

const pins = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/stats/simple_statistics_pins.json'), 'utf8'));

describe('vendored simple-statistics subset is bit-identical', () => {
  for (const [name, x] of Object.entries(pins.arrays)) {
    const e = pins.expected[name];
    it(`${name}: sum, mean, variance, stdDev, median, quantiles`, () => {
      expect(st.ss.sum(x)).toBe(e.sum);
      expect(st.ss.mean(x)).toBe(e.mean);
      expect(st.ss.variance(x)).toBe(e.variance);
      expect(st.ss.standardDeviation(x)).toBe(e.standardDeviation);
      expect(st.ss.median(x)).toBe(e.median);
      // Pinned from SCALAR calls. simple-statistics 7.8.8's ARRAY form,
      // quantile(x, [p...]), returns different numbers on the 1001-point
      // array (its multi-quickselect leaves the partition inconsistent);
      // no Suite caller uses the array form, and a full sort matches the
      // scalar path exactly.
      expect([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((p) => st.ss.quantile(x, p))).toEqual(e.quantiles);
      expect(st.ss.quantile(x, [0, 0.5, 1])).toEqual([0, 0.5, 1].map((p) => st.ss.quantile(x, p)));
      if (x.length > 1) {
        expect(st.ss.sampleVariance(x)).toBe(e.sampleVariance);
        expect(st.ss.sampleStandardDeviation(x)).toBe(e.sampleStandardDeviation);
      }
    });
  }
  it('sample covariance and correlation', () => {
    const { x, y, sampleCovariance, sampleCorrelation } = pins.expected.corr;
    expect(st.ss.sampleCovariance(x, y)).toBe(sampleCovariance);
    expect(st.ss.sampleCorrelation(x, y)).toBe(sampleCorrelation);
  });
  it('population, not sample, standard deviation (the documented gotcha)', () => {
    expect(st.ss.standardDeviation([1, 2, 3, 4])).toBe(Math.sqrt(1.25));
    expect(st.ss.sampleStandardDeviation([1, 2, 3, 4])).toBe(Math.sqrt(5 / 3));
  });
});

describe('Monte Carlo primitives reproduce the Suite stream by stream', () => {
  const e = pins.expected.mc;
  const inputs = { a: { type: 'triangular', min: 1, mode: 2, max: 5 }, b: { type: 'lognormal', mean: 100, stdDev: 30 }, c: { type: 'normal', mean: 0, stdDev: 1 }, d: { type: 'uniform', min: -1, max: 1 }, k: { type: 'constant', value: 3 } };
  const s = st.createCorrelatedSampler({ inputs, paramOrder: ['a', 'b', 'c', 'd', 'k'], correlations: [{ a: 'a', b: 'b', rho: 0.6 }], rng: st.mulberry32(7) });
  const samples = Array.from({ length: 200 }, () => s.sample().values);
  const targets = samples.map((v) => v.a * 10 + v.b * 0.1 - v.c + v.d);
  const rows = samples.map((v, i) => ({ targetVol: targets[i], inputs: v }));

  it('mulberry32 draws', () => {
    const rng = st.mulberry32(20260908);
    expect(Array.from({ length: 5 }, () => rng())).toEqual(e.draws);
  });
  it('varKeys drop the constant and the first three realisations match', () => {
    expect(s.varKeys).toEqual(e.varKeys);
    expect(samples.slice(0, 3)).toEqual(e.firstSamples);
  });
  it('basicStats percentiles, mean, stdDev and the first CDF points', () => {
    const b = st.basicStats(targets);
    const { cdf, ...rest } = e.basicStats;
    for (const [k, v] of Object.entries(rest)) expect(b[k]).toBe(v);
    expect(b.cdf.slice(0, 5)).toEqual(cdf);
  });
  it('spearman, variance decomposition, tornado swings and rank sensitivity', () => {
    expect(st.spearman(samples.map((v) => v.a), targets)).toBe(e.spearman);
    expect(st.varianceDecomposition(rows)).toEqual(e.varianceDecomposition);
    expect(st.tornadoSwings(rows)).toEqual(e.tornado);
    expect(st.rankCorrelationSensitivity({ a: samples.map((v) => v.a), b: samples.map((v) => v.b), c: samples.map((v) => v.c), d: samples.map((v) => v.d) }, targets)).toEqual(e.rankSens);
  });
  it('closed-form helpers: triangular fit, normalCDF, triangular inverse CDF', () => {
    expect(st.fitTriangularToPercentiles(10, 20, 45)).toEqual(e.fitTri);
    expect([-2, -0.5, 0, 0.5, 2].map(st.normalCDF)).toEqual(e.normalCDF);
    expect([0.05, 0.5, 0.95].map((u) => st.triInvCDF(u, 1, 2, 5))).toEqual(e.triInv);
  });
});
