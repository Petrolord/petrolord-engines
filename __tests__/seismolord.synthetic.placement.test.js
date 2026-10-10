/**
 * Where an interface lands in the synthetic (2026-10-10). A single
 * impedance step at a known TWT T, logged every 0.1524 m at a constant
 * 2000 m/s, through buildSynthetic with a zero-phase 30 Hz Ricker at a
 * 4 ms sample rate: the synthetic's peak (sub-sample, by a parabola
 * through the top three samples) must sit within half a sample of T, and
 * the error over T spread across a sample must average out near zero.
 *
 * Negative control: the former recipe, impedance point-sampled on the
 * grid with adjacent samples differenced (reflectivity(resampleToDt(...))),
 * puts the interface on sample ceil(T / dt). It fails the same gates:
 * errors up to a whole sample late, half a sample late on average. Ties
 * made with it absorbed that lag as a bulk shift in the time-depth curve.
 */

import {
  buildSynthetic, resampleToDt, reflectivity, centredReflectivity, mdSeriesToTwt,
  rickerWavelet, convolveSame,
} from '../engines/seismolord/synthetics';

const DT = 4;
const NS = 600;
const V = 2000;
const STEP_M = 0.1524;
const W = rickerWavelet(30, DT);

// a log across one interface at TWT T (TVDSS = T * V / 2000 m)
const logAcross = (T) => {
  const zT = (T * V) / 2000;
  const md = []; const dt = []; const rho = [];
  for (let z = zT - 60; z <= zT + 60; z += STEP_M) { md.push(z); dt.push(1e6 / V); rho.push(z < zT ? 2.2 : 2.5); }
  return { md, dt, rho };
};
const mdToTvdss = (m) => m;
const tvdssToTwt = (z) => (2000 * z) / V;

const peakMs = (trace) => {
  let bi = -1;
  for (let i = 1; i < trace.length - 1; i++) if (Number.isFinite(trace[i]) && (bi < 0 || trace[i] > trace[bi])) bi = i;
  const a = trace[bi - 1]; const b = trace[bi]; const c = trace[bi + 1];
  const den = a - 2 * b + c;
  return (bi + (den < 0 ? (0.5 * (a - c)) / den : 0)) * DT;
};

// T across one sample, on and off the grid
const TIMES = Array.from({ length: 16 }, (_, k) => 1288 + (k * DT) / 16);

const errorsOf = (synth) => TIMES.map((T) => peakMs(synth(T)) - T);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('buildSynthetic puts an interface within half a sample of its time, unbiased on average', () => {
  const errs = errorsOf((T) => {
    const { md, dt, rho } = logAcross(T);
    return buildSynthetic({ dtCurve: dt, rhobCurve: rho, mdArray: md, mdToTvdss, tvdssToTwt, dtMs: DT, ns: NS, wavelet: W }).synthetic;
  });
  for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(DT / 2 + 1e-6);
  expect(Math.abs(mean(errs))).toBeLessThan(DT / 8);
  // the reflection coefficient itself is the hand value at the nearest sample
  const T = 1289;
  const { md, dt, rho } = logAcross(T);
  const rc = centredReflectivity(mdSeriesToTwt(md, mdToTvdss, tvdssToTwt), dt.map((s, i) => (1e6 / s) * rho[i]), DT, NS);
  const k = Math.round(T / DT);
  expect(rc[k]).toBeCloseTo((2.5 - 2.2) / (2.5 + 2.2), 6);
  expect(rc[k + 1]).toBeCloseTo(0, 12);
  expect(rc[k - 1]).toBeCloseTo(0, 12);
});

test('negative control: the grid-sampled recipe is up to a sample late and half a sample late on average', () => {
  const errs = errorsOf((T) => {
    const { md, dt, rho } = logAcross(T);
    const twt = mdSeriesToTwt(md, mdToTvdss, tvdssToTwt);
    const imp = dt.map((s, i) => (1e6 / s) * rho[i]);
    return convolveSame(reflectivity(resampleToDt(twt, imp, DT, NS)), W).data;
  });
  expect(Math.max(...errs)).toBeGreaterThan(DT / 2 + 1);
  expect(mean(errs)).toBeGreaterThan(DT / 4);
});

test('resampleToDt with an offset samples at t0 + i dt', () => {
  const twt = [0, 10]; const v = [0, 100];
  const out = resampleToDt(twt, v, 2, 4, 1);
  expect(Array.from(out)).toEqual([10, 30, 50, 70]);
  // the default grid is unchanged
  expect(Array.from(resampleToDt(twt, v, 2, 3))).toEqual([0, 20, 40]);
});
