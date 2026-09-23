/**
 * Gates for two Seismolord attribute upgrades.
 *
 * 1. azimuth_north (Dip azimuth, grid north): the down-dip direction on the
 *    map through the survey affine. Known truth is a reflector plane built
 *    in WORLD coordinates with a chosen dip direction, sampled on a rotated
 *    survey with unequal bins. Negative control: the naive conversion
 *    (lattice angle plus the grid rotation) is several degrees wrong on the
 *    same survey, so the gate discriminates. Refusals: no affine, the legacy
 *    two-corner fallback, a degenerate affine.
 *
 * 2. spectralTrace fast path (prefix sums for interior windows) against
 *    horizonAmplitude.isofrequencyAt, the kernel it replaces, on random
 *    traces with nulls over a range of windows and frequencies, and its
 *    speed-up at a long window.
 */
import {
  structureVolume, mapGradientTransform, northAzimuth, AZIMUTH_MIN_DIP,
} from '../engines/seismolord/structureAttributes';
import { makeDiscontinuityJob } from '../engines/seismolord/discontinuityJobs';
import { DISCONTINUITY_DEFS } from '../engines/seismolord/discontinuity';
import { spectralTrace } from '../engines/seismolord/attributes';
import { isofrequencyAt } from '../engines/seismolord/horizonAmplitude';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const isNull = (v) => Math.abs(v) > 1e29;
const RAD = Math.PI / 180;

/** rotated 30 degrees, 25 m inline step, 12.5 m crossline step */
const ROT = {
  origin: { x: 500000, y: 6000000 },
  ilVec: { x: 25 * Math.cos(30 * RAD), y: 25 * Math.sin(30 * RAD) },
  xlVec: { x: -12.5 * Math.sin(30 * RAD), y: 12.5 * Math.cos(30 * RAD) },
};
/** inline axis to north, crossline axis to east, equal 20 m bins */
const NORTH_EAST = { origin: { x: 0, y: 0 }, ilVec: { x: 0, y: 20 }, xlVec: { x: 20, y: 0 } };

/** A plane dipping towards `azDeg` (clockwise from north) at `samplesPerM`, as a cube. */
function worldPlane(aff, azDeg, samplesPerM, n = 15, ns = 64) {
  const ux = Math.sin(azDeg * RAD);
  const uy = Math.cos(azDeg * RAD);
  const traces = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * aff.ilVec.x + j * aff.xlVec.x;
      const y = i * aff.ilVec.y + j * aff.xlVec.y;
      const shift = samplesPerM * (x * ux + y * uy);
      traces.push(Float32Array.from({ length: ns }, (_, t) => Math.cos((2 * Math.PI * (t - shift)) / 40)));
    }
  }
  return {
    nIl: n, nXl: n, ns, getTrace: (i, j) => (i < 0 || j < 0 || i >= n || j >= n ? null : traces[i * n + j]),
  };
}

const angErr = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function innerMaxErr(src, vol, truth, m = 3, mt = 8) {
  let e = 0;
  for (let i = m; i < src.nIl - m; i++) {
    for (let j = m; j < src.nXl - m; j++) {
      for (let t = mt; t < src.ns - mt; t++) e = Math.max(e, angErr(vol[(i * src.nXl + j) * src.ns + t], truth));
    }
  }
  return e;
}

const vol = (src, name, affine) => structureVolume({
  name, getTrace: src.getTrace, nIl: src.nIl, nXl: src.nXl, ns: src.ns, dtMs: 4, affine,
});

describe('azimuth_north: the down-dip direction from grid north', () => {
  test.each([20, 135, 200, 310])('a plane dipping towards %p degrees on a rotated, unequal-bin survey reads within 1 degree', (az) => {
    const src = worldPlane(ROT, az, 0.03);
    const err = innerMaxErr(src, vol(src, 'azimuth_north', ROT), az);
    console.log(`azimuth_north truth ${az}: max error ${err.toFixed(4)} deg`);
    expect(err).toBeLessThan(1);
  });

  test('negative control: the lattice angle plus the grid rotation is several degrees wrong on the same survey', () => {
    const az = 20;
    const src = worldPlane(ROT, az, 0.03);
    const lat = vol(src, 'azimuth', ROT);
    // naive: the lattice angle turned by the inline axis bearing
    const ilBearing = Math.atan2(ROT.ilVec.x, ROT.ilVec.y) / RAD;
    const naive = lat.map((v) => (isNull(v) ? v : (((ilBearing + v) % 360) + 360) % 360));
    const err = innerMaxErr(src, naive, az);
    console.log(`naive lattice + rotation: max error ${err.toFixed(2)} deg`);
    expect(err).toBeGreaterThan(5);
  });

  test('inline axis to north and crossline to east with equal bins: identical to the lattice azimuth', () => {
    const src = worldPlane(NORTH_EAST, 250, 0.04);
    const a = vol(src, 'azimuth', NORTH_EAST);
    const b = vol(src, 'azimuth_north', NORTH_EAST);
    let d = 0;
    for (let k = 0; k < a.length; k++) {
      expect(isNull(a[k])).toBe(isNull(b[k]));
      if (!isNull(a[k])) d = Math.max(d, angErr(a[k], b[k]));
    }
    expect(d).toBeLessThan(1e-3);
  });

  test('northAzimuth: flat is null, the four map directions land on their bearings', () => {
    const T = mapGradientTransform(NORTH_EAST);
    expect(northAzimuth(0, 0, T)).toBe(NULL_VALUE);
    expect(northAzimuth(AZIMUTH_MIN_DIP / 2, 0, T)).toBe(NULL_VALUE);
    expect(northAzimuth(1, 0, T)).toBeCloseTo(0, 9);      // time grows with inline = north
    expect(northAzimuth(0, 1, T)).toBeCloseTo(90, 9);     // with crossline = east
    expect(northAzimuth(-1, 0, T)).toBeCloseTo(180, 9);
    expect(northAzimuth(0, -1, T)).toBeCloseTo(270, 9);
  });

  test('refuses without a measured, non-degenerate affine, with the reason', () => {
    const src = worldPlane(ROT, 20, 0.03, 6, 16);
    expect(() => vol(src, 'azimuth_north', null)).toThrow(/survey orientation/);
    expect(() => vol(src, 'azimuth_north', { ...NORTH_EAST, legacyAxisAligned: true })).toThrow(/Re-import/);
    expect(() => vol(src, 'azimuth_north', { origin: { x: 0, y: 0 }, ilVec: { x: 1, y: 1 }, xlVec: { x: 2, y: 2 } }))
      .toThrow(/degenerate/);
    expect(() => makeDiscontinuityJob('azimuth_north', {}, { dtUs: 4000, nIl: 6, nXl: 6, ns: 16 })).toThrow(/survey orientation/);
    expect(makeDiscontinuityJob('azimuth_north', {}, {
      dtUs: 4000, nIl: 6, nXl: 6, ns: 16, affine: ROT,
    }).radius).toBeGreaterThanOrEqual(1);
    // the lattice azimuth needs no affine
    expect(() => vol(src, 'azimuth', null)).not.toThrow();
  });

  test('registry: own property, regional, flagged as needing the affine', () => {
    expect(Object.prototype.hasOwnProperty.call(DISCONTINUITY_DEFS, 'azimuth_north')).toBe(true);
    expect(DISCONTINUITY_DEFS.azimuth_north).toMatchObject({ regional: true, needsAffine: true, unit: 'deg' });
    expect(DISCONTINUITY_DEFS.azimuth_north.label).toBe('Dip azimuth (grid north)');
  });
});

describe('spectralTrace fast path equals the isofrequency kernel', () => {
  // deterministic LCG
  const rng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };

  function reference(trace, freqHz, hw, dtUs) {
    const NULL_F32 = Math.fround(NULL_VALUE);
    const at = (s) => (isNull(trace[s]) ? NULL_F32 : trace[s]);
    return Float64Array.from({ length: trace.length }, (_, z) => {
      if (isNull(trace[z])) return NULL_VALUE;
      const v = isofrequencyAt(at, trace.length, z, { freqHz, hw, dtS: dtUs * 1e-6 });
      return v === NULL_F32 ? NULL_VALUE : v;
    });
  }

  test.each([
    [2, 30], [5, 30], [5, 125], [10, 12], [25, 60], [50, 30], [50, 3], [5, 0.5],
  ])('hw %p, %p Hz: within 1e-9 of the trace peak, nulls identical', (hw, freqHz) => {
    const r = rng(hw * 1000 + Math.round(freqHz * 10));
    const ns = 700;
    const tr = Float32Array.from({ length: ns }, () => r() * 2000);
    for (let k = 0; k < 12; k++) tr[Math.floor((r() + 0.5) * ns)] = NULL_VALUE;
    for (let k = 300; k < 310; k++) tr[k] = NULL_VALUE;          // a null gap
    const fast = new Float64Array(ns);
    spectralTrace(tr, freqHz, hw, 4000, fast);
    const ref = reference(tr, freqHz, hw, 4000);
    let peak = 0;
    let d = 0;
    for (let z = 0; z < ns; z++) {
      expect(isNull(fast[z])).toBe(isNull(ref[z]));
      if (isNull(ref[z])) continue;
      peak = Math.max(peak, ref[z]);
      d = Math.max(d, Math.abs(fast[z] - ref[z]));
    }
    expect(d).toBeLessThanOrEqual(1e-9 * peak);
  });

  test('a long trace (6000 samples, large DC offset): prefix sums keep the precision', () => {
    const r = rng(7);
    const ns = 6000;
    const tr = Float32Array.from({ length: ns }, (_, t) => 5000 + 800 * Math.cos(2 * Math.PI * 30 * t * 0.004) + r() * 50);
    const fast = new Float64Array(ns);
    spectralTrace(tr, 30, 50, 4000, fast);
    const ref = reference(tr, 30, 50, 4000);
    let peak = 0;
    let d = 0;
    for (let z = 0; z < ns; z++) { peak = Math.max(peak, ref[z]); d = Math.max(d, Math.abs(fast[z] - ref[z])); }
    console.log(`long trace: max diff ${d.toExponential(2)} of peak ${peak.toFixed(1)}`);
    expect(d).toBeLessThanOrEqual(1e-9 * peak);
  });

  test('a trace shorter than the window falls back to the kernel entirely', () => {
    const tr = Float32Array.from({ length: 30 }, (_, t) => Math.sin(t));
    const fast = new Float64Array(30);
    spectralTrace(tr, 30, 20, 4000, fast);
    expect(Array.from(fast)).toEqual(Array.from(reference(tr, 30, 20, 4000)));
  });

  test('speed: a 400 ms window at 4 ms is at least 10 times faster than one FFT per sample', () => {
    const r = rng(11);
    const ns = 1500;
    const traces = Array.from({ length: 20 }, () => Float32Array.from({ length: ns }, () => r()));
    const out = new Float32Array(ns);
    const t0 = performance.now();
    for (const tr of traces) spectralTrace(tr, 30, 50, 4000, out);
    const fastMs = performance.now() - t0;
    const t1 = performance.now();
    for (const tr of traces) reference(tr, 30, 50, 4000);
    const refMs = performance.now() - t1;
    console.log(`spectral 20 traces x ${ns}: fast ${fastMs.toFixed(0)} ms, per-sample FFT ${refMs.toFixed(0)} ms, ${(refMs / fastMs).toFixed(1)}x`);
    expect(refMs / fastMs).toBeGreaterThan(10);
  });
});
