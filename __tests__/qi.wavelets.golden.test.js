/**
 * E1b gate for engines/qi/wavelets.js: every assertion calls the shipped
 * function and compares it with tools/validation/qi/oracle_qi_wavelets.py
 * (exact-rational resampling, DFT cross-correlation). Negative controls:
 * tools/validation/qi/negcontrol_e1b.sh.
 */
import G from '../test-data/qi/goldens.qiWavelets.json';
import { resampleWavelet, alignWavelet, compareWavelets } from '../engines/qi/wavelets';

const close = (got, want, tol) => {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    if (!(Math.abs(got[i] - want[i]) <= tol)) throw new Error(`sample ${i}: got ${got[i]}, want ${want[i]} (tol ${tol})`);
  }
};

describe('resampleWavelet against exact rational interpolation', () => {
  test.each(G.resample.map((c) => [c.name, c]))('%s', (_, c) => {
    close(resampleWavelet(c.w, c.dtIn, c.dtOut), c.out, 1e-14);
  });
});

describe('alignWavelet against DFT cross-correlation', () => {
  test.each(G.align.map((c) => [c.name, c]))('%s', (_, c) => {
    const r = alignWavelet(c.a, c.b, { maxLag: c.maxLag });
    expect(r.lag + 0).toBe(c.lag); // + 0: maxLag 0 yields -0 (lag = -maxLag), equal to 0
    expect(Math.abs(r.corr - c.corr)).toBeLessThan(1e-12);
    close(r.aligned, c.aligned, 0);
  });
});

describe('compareWavelets against the oracle', () => {
  test.each(G.compare.map((c) => [c.name, c]))('%s: lags, aligned samples, average, similarity, misfit', (_, c) => {
    const r = compareWavelets(c.wavelets, { maxLag: c.maxLag });
    expect(r.aligned.map((a) => a.lag)).toEqual(c.lags);
    r.aligned.forEach((a, k) => close(a.samples, c.aligned[k], 1e-13));
    close(r.average, c.average, 1e-13);
    r.similarity.forEach((row, i) => close(row, c.similarity[i], 1e-12));
    r.misfit.forEach((m, i) => {
      expect(m.name).toBe(c.misfit[i].name);
      expect(Math.abs(m.corrToAverage - c.misfit[i].corrToAverage)).toBeLessThan(1e-12);
    });
  });
});

describe('the documented tie-break', () => {
  test('an exact tie (integer samples, so no rounding) goes to the most negative lag', () => {
    const a = [0, 0, 0, 1, 0, 0, 0];
    const b = [0, 0, 1, 0, 1, 0, 0];
    const r = alignWavelet(a, b, { maxLag: 3 });
    expect(r.lag).toBe(-1);
    expect(Array.from(r.aligned)).toEqual([0, 1, 0, 1, 0, 0, 0]);
  });
});
