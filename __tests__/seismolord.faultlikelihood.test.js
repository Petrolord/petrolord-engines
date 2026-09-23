/**
 * Fault picking upgrade gates (Seismolord discoverability programme, step 3):
 *
 * 1. Noisy data. Signal to noise is the RMS of the clean field's reflective
 *    (non-zero) samples over the noise sigma. The detector reads the data's
 *    reflector coherence and lowers its thresholds for noisy data; at 3
 *    (white or band-limited noise) it finds the true fault, and the negative
 *    control at 'standard' sensitivity shows the scaling is what does it.
 *    Unfaulted noisy fields still propose nothing.
 * 2. The Fault likelihood attribute: computed a brick column at a time
 *    through runNeighborhoodJob, it equals the whole-volume likelihood
 *    exactly; a halo below the likelihood's reach does not (negative control).
 * 3. Other inputs: a Variance attribute volume, or the Fault likelihood
 *    volume itself, in place of the seismic.
 *
 * Every stick point is scored against the field's exact fault plane
 * (truth.faults[0].sideAt), never against the detector's own math.
 */

import { buildSyntheticField, ricker } from '../engines/seismolord/syntheticField';
import {
  detectFaults, faultLikelihoodVolume, thresholdScale, FAULT_DETECT_DEFAULTS,
} from '../engines/seismolord/faultDetect';
import {
  makeDiscontinuityJob, faultLikelihoodBlock, likelihoodHalo,
} from '../engines/seismolord/discontinuityJobs';
import { makeNeighborhoodCompute, DISCONTINUITY_DEFS } from '../engines/seismolord/discontinuity';
import { runNeighborhoodJob } from '../engines/seismolord/volumeJob';
import { NULL_VALUE } from '../engines/seismolord/manifest';

/** Depth (m) of sample s at (il, xl): bisection on the field's twtAtDepth. */
function depthAtSample(field, il, xl, s) {
  const t = s * field.dtMs;
  let lo = 0;
  let hi = 8000;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (field.twtAtDepth(il, xl, mid) < t) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}
const cellsFromPlane = (field, fault, p) => Math.abs(
  fault.sideAt(p.il, p.xl, depthAtSample(field, p.il, p.xl, p.s)),
) / field.spec.binM;

/** Fraction of all proposed stick points within 2 cells of the plane. */
function within2(field, faults) {
  const pts = faults.flatMap((f) => f.sticks.flatMap((st) => st.points));
  if (!pts.length) return 0;
  return pts.filter((p) => cellsFromPlane(field, field.truth.faults[0], p) <= 2).length / pts.length;
}

/** Deterministic xorshift + Box-Muller. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** RMS of the clean field's reflective samples (the signal level). */
async function signalRms(field) {
  let ss = 0;
  let n = 0;
  for (let il = 0; il < field.geom.nIl; il += 5) {
    for (let xl = 0; xl < field.geom.nXl; xl += 5) {
      for (const v of await field.getTrace(il, xl)) {
        if (v !== 0) { ss += v * v; n++; }
      }
    }
  }
  return Math.sqrt(ss / n);
}

/** getTrace with white or band-limited (30 Hz Ricker-shaped) noise of sigma. */
function noisy(field, sigma, band) {
  const { ns } = field.geom;
  const w = [];
  for (let k = -12; k <= 12; k++) w.push(ricker(k * field.dtMs, 30));
  const wn = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
  const cache = new Map();
  return async (il, xl) => {
    const tr = Float32Array.from(await field.getTrace(il, xl));
    const key = il * 1000 + xl;
    let nz = cache.get(key);
    if (!nz) {
      const r = rng(12345 + key * 7);
      const white = new Float32Array(ns);
      for (let s = 0; s < ns; s++) white[s] = gauss(r);
      nz = new Float32Array(ns);
      if (band) {
        for (let s = 0; s < ns; s++) {
          let a = 0;
          for (let k = 0; k < w.length; k++) {
            const j = s + k - 12;
            if (j >= 0 && j < ns) a += w[k] * white[j];
          }
          nz[s] = a / wn;
        }
      } else nz.set(white);
      cache.set(key, nz);
    }
    for (let s = 0; s < ns; s++) tr[s] += sigma * nz[s];
    return tr;
  };
}

const detect = (field, getTrace, params = {}) => detectFaults({
  getTrace, geom: field.geom, dtMs: field.dtMs, params,
});

describe('thresholdScale', () => {
  test('1 at coherence 0.95 and above, 0.5 at 0.80 and below, linear between; sensitivity overrides', () => {
    expect(thresholdScale(0.99)).toBe(1);
    expect(thresholdScale(0.95)).toBe(1);
    expect(thresholdScale(0.875)).toBeCloseTo(0.75, 10);
    expect(thresholdScale(0.8)).toBe(0.5);
    expect(thresholdScale(0.3)).toBe(0.5);
    expect(thresholdScale(null)).toBe(1);
    expect(thresholdScale(0.3, 'standard')).toBe(1);
    expect(thresholdScale(0.99, 'high')).toBe(0.5);
  });
});

describe('noisy data: thresholds follow the reflector coherence', () => {
  let field;
  let unfaulted;
  let rms;
  beforeAll(async () => {
    field = buildSyntheticField();
    unfaulted = buildSyntheticField({ faults: [] });
    rms = await signalRms(field);
  });

  test('clean data keeps the default thresholds and still finds the fault on its plane', async () => {
    const res = await detect(field, field.getTrace);
    expect(res.quality.coherence).toBeGreaterThanOrEqual(0.95);
    expect(res.quality.thresholdScale).toBe(1);
    expect(res.params.high).toBe(FAULT_DETECT_DEFAULTS.high);
    expect(res.faults).toHaveLength(1);
    expect(within2(field, res.faults)).toBeGreaterThanOrEqual(0.95);
  }, 120000);

  test('signal to noise 3 (white): coherence below 0.8, halved thresholds, the fault on its plane', async () => {
    const res = await detect(field, noisy(field, rms / 3, false));
    console.log(`S/N 3 white: coherence ${res.quality.coherence.toFixed(3)}, faults ${res.faults.length}, `
      + `confidence ${res.faults.map((f) => f.confidence.toFixed(2)).join('/')}, within 2 cells ${within2(field, res.faults).toFixed(3)}`);
    expect(res.quality.coherence).toBeLessThan(0.8);
    expect(res.quality.thresholdScale).toBe(0.5);
    expect(res.faults).toHaveLength(1);
    expect(within2(field, res.faults)).toBeGreaterThanOrEqual(0.9);
  }, 120000);

  test('negative control: the same data at standard sensitivity proposes nothing', async () => {
    const res = await detect(field, noisy(field, rms / 3, false), { sensitivity: 'standard' });
    expect(res.quality.thresholdScale).toBe(1);
    expect(res.faults).toHaveLength(0);
  }, 120000);

  test('signal to noise 3 (band-limited noise that looks like seismic): the fault on its plane', async () => {
    const res = await detect(field, noisy(field, rms / 3, true));
    console.log(`S/N 3 band: coherence ${res.quality.coherence.toFixed(3)}, scale ${res.quality.thresholdScale.toFixed(2)}, `
      + `faults ${res.faults.length}, within 2 cells ${within2(field, res.faults).toFixed(3)}`);
    expect(res.faults).toHaveLength(1);
    expect(within2(field, res.faults)).toBeGreaterThanOrEqual(0.85);
  }, 120000);

  test('coherence ranks data quality: clean > S/N 6 > S/N 3', async () => {
    const q = async (g) => {
      const out = {};
      await faultLikelihoodVolume({ getTrace: g, geom: field.geom, qualityOut: out });
      return out.coherence;
    };
    const c0 = await q(field.getTrace);
    const c6 = await q(noisy(field, rms / 6, false));
    const c3 = await q(noisy(field, rms / 3, false));
    expect(c0).toBeGreaterThan(c6);
    expect(c6).toBeGreaterThan(c3);
  }, 180000);

  test('unfaulted noisy fields propose no fault (white S/N 2, band-limited S/N 3)', async () => {
    const urms = await signalRms(unfaulted);
    for (const [snr, band] of [[2, false], [3, true]]) {
      const res = await detect(unfaulted, noisy(unfaulted, urms / snr, band));
      expect(res.quality.thresholdScale).toBeLessThan(0.7);   // read as noisy
      expect(res.faults).toHaveLength(0);
    }
  }, 240000);
});

describe('the Fault likelihood attribute, a brick column at a time', () => {
  const SMALL = { nIl: 50, nXl: 44, ns: 360 };
  let field;
  let whole;
  let traces;
  beforeAll(async () => {
    field = buildSyntheticField(SMALL);
    whole = await faultLikelihoodVolume({ getTrace: field.getTrace, geom: field.geom });
    traces = new Map();
    for (let il = 0; il < SMALL.nIl; il++) {
      for (let xl = 0; xl < SMALL.nXl; xl++) traces.set(il * SMALL.nXl + xl, await field.getTrace(il, xl));
    }
  }, 120000);
  const syncTrace = (il, xl) => (il < 0 || xl < 0 || il >= SMALL.nIl || xl >= SMALL.nXl
    ? null : traces.get(il * SMALL.nXl + xl));

  test('the halo covers the likelihood\'s lateral reach', () => {
    expect(likelihoodHalo()).toBe(1 + 5 + 6 + 1);
    expect(likelihoodHalo({ strikeHalfLength: 8, radius: 2 })).toBe(2 + 5 + 9 + 1);
  });

  test('an interior block with the halo equals the whole-volume likelihood exactly', async () => {
    const blk = { il0: 16, il1: 31, xl0: 14, xl1: 29 };
    const out = await faultLikelihoodBlock({ getTrace: syncTrace, ...SMALL, ...blk });
    let maxDiff = 0;
    let signal = 0;
    for (let il = blk.il0; il <= blk.il1; il++) {
      for (let xl = blk.xl0; xl <= blk.xl1; xl++) {
        for (let s = 0; s < SMALL.ns; s++) {
          const a = out[((il - blk.il0) * (blk.xl1 - blk.xl0 + 1) + (xl - blk.xl0)) * SMALL.ns + s];
          const b = whole[(il * SMALL.nXl + xl) * SMALL.ns + s];
          maxDiff = Math.max(maxDiff, Math.abs(a - b));
          signal = Math.max(signal, b);
        }
      }
    }
    expect(signal).toBeGreaterThan(0.2);         // the block holds the fault
    expect(maxDiff).toBeLessThan(1e-6);
  }, 60000);

  test('negative control: a 3-cell halo is too narrow and changes the result', async () => {
    const blk = { il0: 16, il1: 31, xl0: 14, xl1: 29 };
    const out = await faultLikelihoodBlock({ getTrace: syncTrace, ...SMALL, ...blk, halo: 3 });
    let maxDiff = 0;
    for (let il = blk.il0; il <= blk.il1; il++) {
      for (let xl = blk.xl0; xl <= blk.xl1; xl++) {
        for (let s = 0; s < SMALL.ns; s++) {
          const a = out[((il - blk.il0) * (blk.xl1 - blk.xl0 + 1) + (xl - blk.xl0)) * SMALL.ns + s];
          maxDiff = Math.max(maxDiff, Math.abs(a - whole[(il * SMALL.nXl + xl) * SMALL.ns + s]));
        }
      }
    }
    expect(maxDiff).toBeGreaterThan(0.01);
  }, 60000);

  test('end to end through runNeighborhoodJob over a brick store: equal to the whole volume', async () => {
    const B = 32;
    const grid = [Math.ceil(SMALL.nIl / B), Math.ceil(SMALL.nXl / B), Math.ceil(SMALL.ns / B)];
    const bricks = new Map();
    for (let i = 0; i < grid[0]; i++) {
      for (let j = 0; j < grid[1]; j++) {
        for (let k = 0; k < grid[2]; k++) bricks.set(`${i}-${j}-${k}`, new Float32Array(B ** 3).fill(NULL_VALUE));
      }
    }
    for (let il = 0; il < SMALL.nIl; il++) {
      for (let xl = 0; xl < SMALL.nXl; xl++) {
        const tr = syncTrace(il, xl);
        for (let s = 0; s < SMALL.ns; s++) {
          bricks.get(`${Math.floor(il / B)}-${Math.floor(xl / B)}-${Math.floor(s / B)}`)[((il % B) * B + (xl % B)) * B + (s % B)] = tr[s];
        }
      }
    }
    expect(DISCONTINUITY_DEFS.fault_likelihood.regional).toBe(true);
    expect(() => makeNeighborhoodCompute('fault_likelihood', {}, { dtUs: 4000 })).toThrow(/makeDiscontinuityJob/);
    const job = makeDiscontinuityJob('fault_likelihood', {}, { dtUs: field.dtMs * 1000, ...SMALL });
    expect(job.radius).toBe(likelihoodHalo());
    const outBricks = new Map();
    await runNeighborhoodJob({
      geom: { ...SMALL, brickSize: B, grid },
      ...job,
      fetchBrick: async (i, j, k) => bricks.get(`${i}-${j}-${k}`),
      onBrick: async ({ i, j, k, data }) => { outBricks.set(`${i}-${j}-${k}`, data); },
    });
    let maxDiff = 0;
    for (let il = 0; il < SMALL.nIl; il++) {
      for (let xl = 0; xl < SMALL.nXl; xl++) {
        for (let s = 0; s < SMALL.ns; s++) {
          const v = outBricks.get(`${Math.floor(il / B)}-${Math.floor(xl / B)}-${Math.floor(s / B)}`)[((il % B) * B + (xl % B)) * B + (s % B)];
          maxDiff = Math.max(maxDiff, Math.abs(v - whole[(il * SMALL.nXl + xl) * SMALL.ns + s]));
        }
      }
    }
    expect(maxDiff).toBeLessThan(1e-6);
    // variance still runs through the same door, per trace
    expect(typeof makeDiscontinuityJob('variance', {}, { dtUs: 4000 }).compute).toBe('function');
  }, 120000);
});

describe('other inputs: a variance volume or the fault likelihood volume', () => {
  let field;
  beforeAll(() => { field = buildSyntheticField(); });

  const fromVariance = async (field, params) => {
    const { compute } = makeNeighborhoodCompute('variance', params, { dtUs: field.dtMs * 1000 });
    const { nIl, nXl, ns } = field.geom;
    const tr = new Map();
    for (let il = 0; il < nIl; il++) for (let xl = 0; xl < nXl; xl++) tr.set(il * nXl + xl, await field.getTrace(il, xl));
    const get = (il, xl) => (il < 0 || xl < 0 || il >= nIl || xl >= nXl ? null : tr.get(il * nXl + xl));
    const varTrace = (il, xl) => {
      const out = new Float32Array(ns);
      compute(get, il, xl, out);
      return out;
    };
    return detectFaults({ getVarianceTrace: varTrace, geom: field.geom, dtMs: field.dtMs });
  };
  const describe1 = (field, res) => res.faults.map((f) => `${f.name} ${f.confidence.toFixed(2)} ${within2(field, [f]).toFixed(2)}`).join(' | ');

  test('a plain Variance volume: the true fault is among the proposals, with dip artefacts beside it', async () => {
    const res = await fromVariance(field, { windowMs: 24, radius: 1 });
    console.log(`from plain variance: ${describe1(field, res)}`);
    expect(res.quality.coherence).toBeNull();
    expect(res.quality.thresholdScale).toBe(1);
    expect(Math.max(...res.faults.map((f) => within2(field, [f])))).toBeGreaterThanOrEqual(0.9);
    expect(res.faults.length).toBeGreaterThan(1);       // why dip steering exists (next test)
  }, 180000);

  test('a dip-steered Variance volume: exactly the true fault, on its plane', async () => {
    const res = await fromVariance(field, { windowMs: 24, radius: 1, dipSteerMs: 12 });
    console.log(`from dip-steered variance: ${describe1(field, res)}`);
    expect(res.faults).toHaveLength(1);
    expect(within2(field, res.faults)).toBeGreaterThanOrEqual(0.9);
  }, 180000);

  test('the Fault likelihood volume in place of the seismic gives the same faults as the seismic', async () => {
    const direct = await detectFaults({ getTrace: field.getTrace, geom: field.geom, dtMs: field.dtMs });
    const { nXl, ns } = field.geom;
    const lik = direct.likelihood.slice();
    const res = await detectFaults({
      getLikelihoodTrace: (il, xl) => lik.subarray((il * nXl + xl) * ns, (il * nXl + xl + 1) * ns),
      geom: field.geom,
      dtMs: field.dtMs,
    });
    expect(res.faults.map((f) => f.sticks)).toEqual(direct.faults.map((f) => f.sticks));
    expect(res.faults.map((f) => f.confidence)).toEqual(direct.faults.map((f) => f.confidence));
  }, 180000);
});
