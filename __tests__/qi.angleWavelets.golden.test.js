/**
 * Angle-dependent wavelets and the well wavelet against the independent
 * oracle (QI course gate E2): tools/validation/qi/oracle_qi_angle_wavelets.py
 * codes Fatti et al. (1994) from the paper, solves the damped Wiener normal
 * equations by Cholesky, aligns by a zero-padded DFT cross-correlation and
 * scores the synthetics by a two-pass Pearson correlation. Every assertion
 * calls the shipped engine. The wavelets are stored as Float32, so values
 * downstream of that rounding are compared to 1e-6 of their scale.
 */
import G from '../test-data/qi/goldens.angleWavelets.json';
import { angleReflectivity, extractAngleWavelets } from '../engines/qi/angleWavelets';
import { extractWellWavelet } from '../engines/seismolord/wellWavelet';

const nanify = (a) => a.map((v) => (v === null ? NaN : v));
const wells = G.wells.map((w) => ({ name: w.name, ln_ai: nanify(w.ln_ai), ln_si: nanify(w.ln_si), ln_rho: nanify(w.ln_rho) }));
const same = (a, b, tol, scale = 1) => {
  if (b === null) { expect(Number.isFinite(a) ? a : null).toBeNull(); return; }
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(scale, Math.abs(b)));
};
const peak = (a) => Math.max(...a.map(Math.abs));

test('angle reflectivity is the Fatti three-term form, missing beside a log gap', () => {
  const r = angleReflectivity(wells[3], G.reflectivity.theta, G.K);
  expect(r).toHaveLength(G.reflectivity.expect.length);
  r.forEach((v, i) => same(v, G.reflectivity.expect[i], 1e-12, 1e-3));
});

test('the well wavelet: Cholesky against the engine elimination, Float32 peak-normalised', () => {
  const e = G.wellWavelet.expect;
  const rc = angleReflectivity(wells[3], G.wellWavelet.theta, G.K);
  const r = extractWellWavelet(rc, nanify(G.traces[3][1]), { halfLength: G.wellWavelet.half, damping: G.wellWavelet.damping });
  expect(r.used).toBe(e.used);
  same(r.fitCorr, e.fitCorr, 1e-11);
  Array.from(r.wavelet).forEach((v, i) => same(v, e.wavelet[i], 2e-7));
});

test('the well wavelet refuses a log too short for its length', () => {
  const rc = angleReflectivity(wells[0], 22, G.K).slice(0, G.short.n);
  expect(() => extractWellWavelet(rc, nanify(G.traces[0][1]).slice(0, G.short.n), { halfLength: G.short.half })).toThrow(new RegExp(`covers ${G.short.rows} usable samples at the well; a 31-sample wavelet needs at least ${G.short.need}`));
  expect(G.short.rows).toBeGreaterThanOrEqual(31); // between one and two wavelet lengths, so the floor is what refuses
});

const check = (out, gold) => {
  expect(out).toHaveLength(gold.length);
  out.forEach((o, k) => {
    const g = gold[k];
    expect(o.angle).toBe(g.angle);
    if (g.samples === null) {
      expect(o.samples).toBeNull();
      expect(o.wells.map((w) => w.name)).toEqual(g.wells.map((w) => w.name));
      o.wells.forEach((w) => { expect(w.fitCorr).toBeNaN(); expect(w.synthCorr).toBeNaN(); });
      expect(o.misfit).toEqual([]);
      return;
    }
    const sc = peak(g.samples);
    Array.from(o.samples).forEach((v, i) => same(v, g.samples[i], 1e-6, sc));
    expect(o.wells.map((w) => w.name)).toEqual(g.wells.map((w) => w.name));
    o.wells.forEach((w, j) => { same(w.fitCorr, g.wells[j].fitCorr, 1e-10); same(w.synthCorr, g.wells[j].synthCorr, 1e-6); });
    expect(o.misfit.map((m) => m.name)).toEqual(g.misfit.map((m) => m.name));
    o.misfit.forEach((m, j) => same(m.corrToAverage, g.misfit[j].corrToAverage, 1e-6));
  });
};

test('three angles over four wells: the flat well refused, the shifted well aligned, one wavelet per angle', () => {
  expect(G.multi.length).toBe(3);
  check(extractAngleWavelets({ wells, tracesByWell: G.traces, thetaDeg: G.thetas, vsVp: G.K, halfLength: G.half }), G.multi);
});

test('one well is its own wavelet', () => {
  check(extractAngleWavelets({ wells: wells.slice(0, 1), tracesByWell: G.traces.slice(0, 1).map((t) => t.slice(1, 2)), thetaDeg: [22], vsVp: G.K, halfLength: 10 }), G.one);
});

test('no usable well gives no wavelet and says so per well', () => {
  check(extractAngleWavelets({ wells: wells.slice(2, 3), tracesByWell: G.traces.slice(2, 3), thetaDeg: G.thetas, vsVp: G.K, halfLength: G.half }), G.none);
});
