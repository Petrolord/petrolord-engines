/**
 * Structure and trace attribute gates (Seismolord new attributes programme,
 * engines first with oracles).
 *
 * 1. GOLDEN. Every attribute (edge, dip, azimuth, chaos, most positive and
 *    most negative curvature, at radius 1 and 2, spectral decomposition and
 *    relative acoustic impedance) against the independent vectorised numpy
 *    oracle test-data/seismolord/structure/gen_structure.py, which
 *    self-asserts physical truths before it writes structure_golden.json.
 *    Tolerance: 1e-6 of each attribute's largest |golden| value. The engine
 *    stores float32 (a relative rounding of up to 6e-8); the rest covers
 *    summation order and Jacobi against LAPACK eigh. Measured errors sit at
 *    the float32 rounding level. Negative controls show the golden rejects
 *    no vertical tensor smoothing, a wider lateral box and a flipped
 *    curvature sign.
 * 2. KNOWN TRUTH, independent of the golden: planar dips in all four
 *    quadrants, dome / syncline / saddle curvature, chaos on planar data and
 *    white noise, edge on a vertical step, spectral on a 30 Hz cosine (and
 *    equal to isofrequencyAt), rai of a single spike.
 * 3. COLUMN == WHOLE VOLUME exactly for every regional attribute, as an
 *    interior block and end to end through runNeighborhoodJob over an
 *    in-memory brick store; a halo one smaller differs (negative control).
 * 4. Registry gates.
 */

import fs from 'fs';
import path from 'path';

import {
  structureVolume, structureBlock, structureHalo, structureParams, eigSym3,
  STRUCTURE_KEYS, DIP_CAP,
} from '../engines/seismolord/structureAttributes';
import { DISCONTINUITY_DEFS, makeNeighborhoodCompute } from '../engines/seismolord/discontinuity';
import { makeDiscontinuityJob } from '../engines/seismolord/discontinuityJobs';
import {
  ATTRIBUTE_DEFS, makeTraceCompute, spectralTrace, raiTrace,
} from '../engines/seismolord/attributes';
import { isofrequencyAt } from '../engines/seismolord/horizonAmplitude';
import { runNeighborhoodJob } from '../engines/seismolord/volumeJob';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const GOLDEN = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'seismolord', 'structure', 'structure_golden.json'),
  'utf8',
));

const NULL_LIM = 1.0e29;
const isNull = (v) => Math.abs(v) > NULL_LIM;
const REGIONAL = STRUCTURE_KEYS;
const TOL_REL = 1e-6;

/** A dense cube (il, xl, t) as a getTrace over the survey. */
function cubeSource(nIl, nXl, ns, fill) {
  const traces = [];
  for (let i = 0; i < nIl; i++) {
    for (let j = 0; j < nXl; j++) {
      const tr = new Float32Array(ns);
      for (let t = 0; t < ns; t++) tr[t] = fill(i, j, t);
      traces.push(tr);
    }
  }
  const getTrace = (i, j) => (i < 0 || j < 0 || i >= nIl || j >= nXl ? null : traces[i * nXl + j]);
  return { nIl, nXl, ns, getTrace, traces };
}

const G = (() => {
  const [nIl, nXl, ns] = GOLDEN.shape;
  return cubeSource(nIl, nXl, ns, (i, j, t) => GOLDEN.cube[i][j][t]);
})();
const DT_MS = GOLDEN.dt_us / 1000;

/** A rotated survey with unequal bins (25 m inline step, 12.5 m
 *  crossline step, 30 degrees): azimuth_north needs one, the others
 *  ignore it. */
const TEST_AFFINE = {
  origin: { x: 500000, y: 6000000 },
  ilVec: { x: 25 * Math.cos(Math.PI / 6), y: 25 * Math.sin(Math.PI / 6) },
  xlVec: { x: -12.5 * Math.sin(Math.PI / 6), y: 12.5 * Math.cos(Math.PI / 6) },
};

const volumeOf = (src, name, params, dtMs = 4) => structureVolume({
  name, getTrace: src.getTrace, nIl: src.nIl, nXl: src.nXl, ns: src.ns, dtMs, params, affine: TEST_AFFINE,
});

/** Max error against a golden volume; throws on a null-mask mismatch. */
function goldenError(out, gold, { angle = false } = {}) {
  const [nIl, nXl, ns] = GOLDEN.shape;
  let maxErr = 0;
  let scale = 0;
  let live = 0;
  for (let i = 0; i < nIl; i++) {
    for (let j = 0; j < nXl; j++) {
      for (let t = 0; t < ns; t++) {
        const g = gold[i][j][t];
        const o = out[(i * nXl + j) * ns + t];
        if (isNull(g) !== isNull(o)) throw new Error(`null mask mismatch at (${i},${j},${t}): golden ${g}, engine ${o}`);
        if (isNull(g)) continue;
        live += 1;
        scale = Math.max(scale, Math.abs(g));
        const e = angle ? Math.abs(((o - g + 540) % 360) - 180) : Math.abs(o - g);
        maxErr = Math.max(maxErr, e);
      }
    }
  }
  return { maxErr, scale, live };
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

/** Brick store laid out as transcodeToBricks writes it, and its readback. */
function brickStore(src, B) {
  const grid = [Math.ceil(src.nIl / B), Math.ceil(src.nXl / B), Math.ceil(src.ns / B)];
  const bricks = new Map();
  for (let i = 0; i < grid[0]; i++) {
    for (let j = 0; j < grid[1]; j++) {
      for (let k = 0; k < grid[2]; k++) bricks.set(`${i}-${j}-${k}`, new Float32Array(B ** 3).fill(NULL_VALUE));
    }
  }
  for (let il = 0; il < src.nIl; il++) {
    for (let xl = 0; xl < src.nXl; xl++) {
      const tr = src.getTrace(il, xl);
      for (let s = 0; s < src.ns; s++) {
        bricks.get(`${Math.floor(il / B)}-${Math.floor(xl / B)}-${Math.floor(s / B)}`)[((il % B) * B + (xl % B)) * B + (s % B)] = tr[s];
      }
    }
  }
  return { grid, bricks };
}

async function runJob(src, name, params, B, dtMs = 4) {
  const { grid, bricks } = brickStore(src, B);
  const job = makeDiscontinuityJob(name, params, {
    dtUs: dtMs * 1000, nIl: src.nIl, nXl: src.nXl, ns: src.ns, affine: TEST_AFFINE,
  });
  const outBricks = new Map();
  await runNeighborhoodJob({
    geom: { nIl: src.nIl, nXl: src.nXl, ns: src.ns, brickSize: B, grid },
    ...job,
    fetchBrick: async (i, j, k) => bricks.get(`${i}-${j}-${k}`),
    onBrick: async ({ i, j, k, data }) => { outBricks.set(`${i}-${j}-${k}`, data); },
  });
  const out = new Float32Array(src.nIl * src.nXl * src.ns);
  for (let il = 0; il < src.nIl; il++) {
    for (let xl = 0; xl < src.nXl; xl++) {
      for (let s = 0; s < src.ns; s++) {
        out[(il * src.nXl + xl) * src.ns + s] = outBricks.get(
          `${Math.floor(il / B)}-${Math.floor(xl / B)}-${Math.floor(s / B)}`,
        )[((il % B) * B + (xl % B)) * B + (s % B)];
      }
    }
  }
  return { out, job };
}

/** Max |a - b| over samples, nulls required to agree. */
function maxDiff(a, b) {
  let d = 0;
  for (let k = 0; k < a.length; k++) {
    if (isNull(a[k]) !== isNull(b[k])) return Infinity;
    if (!isNull(a[k])) d = Math.max(d, Math.abs(a[k] - b[k]));
  }
  return d;
}

// ------------------------------------------------------------------ golden

describe('numpy golden (gen_structure.py)', () => {
  const regionalCases = Object.keys(GOLDEN.golden).filter((k) => !['spectral', 'rai'].includes(k));

  test.each(regionalCases)('%s matches the independent implementation', (key) => {
    const name = key.replace('_r2', '');
    const out = volumeOf(G, name, GOLDEN.params[key], DT_MS);
    const { maxErr, scale, live } = goldenError(out, GOLDEN.golden[key], { angle: name === 'azimuth' });
    console.log(`golden ${key}: max error ${maxErr.toExponential(2)} on scale ${scale.toPrecision(4)} (tolerance ${(TOL_REL * scale).toExponential(2)}), ${live} live samples`);
    // azimuth is undefined (null) over the silent top, where the tensor is zero
    expect(live).toBeGreaterThan(G.nIl * G.nXl * G.ns * (name === 'azimuth' ? 0.75 : 0.9));
    expect(maxErr).toBeLessThanOrEqual(TOL_REL * scale);
  });

  test.each(['spectral', 'rai'])('%s matches the independent implementation, every trace', (name) => {
    const compute = makeTraceCompute(name, GOLDEN.params[name], { dtUs: GOLDEN.dt_us });
    const out = new Float32Array(G.nIl * G.nXl * G.ns).fill(NULL_VALUE);
    const o = new Float32Array(G.ns);
    for (let i = 0; i < G.nIl; i++) {
      for (let j = 0; j < G.nXl; j++) {
        const tr = G.getTrace(i, j);
        if (tr.every(isNull)) continue;           // the volume job skips dead traces
        compute(tr, o);
        out.set(o, (i * G.nXl + j) * G.ns);
      }
    }
    const { maxErr, scale } = goldenError(out, GOLDEN.golden[name]);
    console.log(`golden ${name}: max error ${maxErr.toExponential(2)} on scale ${scale.toPrecision(4)}`);
    expect(maxErr).toBeLessThanOrEqual(TOL_REL * scale);
  });

  test('end to end through runNeighborhoodJob (brick size 8): equal to the whole volume and the golden', async () => {
    for (const key of regionalCases) {
      const name = key.replace('_r2', '');
      const { out, job } = await runJob(G, name, GOLDEN.params[key], 8, DT_MS);
      expect(job.radius).toBe(structureHalo(name, GOLDEN.params[key]));
      expect(maxDiff(out, volumeOf(G, name, GOLDEN.params[key], DT_MS))).toBe(0);
      const { maxErr, scale } = goldenError(out, GOLDEN.golden[key], { angle: name === 'azimuth' });
      expect(maxErr).toBeLessThanOrEqual(TOL_REL * scale);
    }
  });

  test('negative controls: the golden rejects wrong recipes', () => {
    const fails = (out, key) => {
      const { maxErr, scale } = goldenError(out, GOLDEN.golden[key], { angle: key === 'azimuth' });
      return maxErr / scale;
    };
    // no vertical tensor smoothing
    const noSmooth = fails(volumeOf(G, 'dip', { windowMs: 0, radius: 1 }, DT_MS), 'dip');
    // a wider lateral box read against the radius 1 golden
    const wide = fails(volumeOf(G, 'chaos', { windowMs: 24, radius: 2 }, DT_MS), 'chaos');
    // curvature with the sign convention flipped: -kNeg in place of kPos
    const neg = volumeOf(G, 'curvature_neg', GOLDEN.params.curvature_pos, DT_MS).map((v) => (isNull(v) ? v : -v));
    const flipped = fails(neg, 'curvature_pos');
    // edge with no vertical window
    const edge0 = fails(volumeOf(G, 'edge', { windowMs: 0 }, DT_MS), 'edge');
    console.log(`negative controls (max error / scale): no smoothing ${noSmooth.toFixed(3)}, radius 2 ${wide.toFixed(3)}, `
      + `flipped curvature ${flipped.toFixed(3)}, edge without window ${edge0.toFixed(3)}`);
    for (const r of [noSmooth, wide, flipped, edge0]) expect(r).toBeGreaterThan(1000 * TOL_REL);
  });
});

// ------------------------------------------------------------- known truth

describe('known truth on analytic synthetics', () => {
  // a cosine of period 40 samples: the central-difference bias
  // (omega / sin omega) stays under 0.5 percent
  const planeWave = (p, q) => cubeSource(15, 15, 64,
    (i, j, t) => Math.cos((2 * Math.PI * (t - p * i - q * j)) / 40));
  const inner = (src, fn, m = 3, mt = 8) => {
    const vals = [];
    for (let i = m; i < src.nIl - m; i++) {
      for (let j = m; j < src.nXl - m; j++) {
        for (let t = mt; t < src.ns - mt; t++) vals.push(fn(i, j, t, (i * src.nXl + j) * src.ns + t));
      }
    }
    return vals;
  };

  test.each([[1.0, 0.6], [-0.8, 0.9], [-1.2, -0.5], [0.7, -1.1]])(
    'planar reflectors p=%p q=%p: dip within 2 percent, azimuth within 1 degree, chaos below 0.1',
    (p, q) => {
      const src = planeWave(p, q);
      const dip = volumeOf(src, 'dip', {});
      const az = volumeOf(src, 'azimuth', {});
      const chaos = volumeOf(src, 'chaos', {});
      const trueDip = Math.hypot(p, q) * 4;
      let trueAz = (Math.atan2(q, p) * 180) / Math.PI;
      if (trueAz < 0) trueAz += 360;
      const dErr = Math.max(...inner(src, (i, j, t, k) => Math.abs(dip[k] / trueDip - 1)));
      const aErr = Math.max(...inner(src, (i, j, t, k) => Math.abs(((az[k] - trueAz + 540) % 360) - 180)));
      const cMax = Math.max(...inner(src, (i, j, t, k) => chaos[k]));
      console.log(`plane (${p}, ${q}): dip error ${(100 * dErr).toFixed(3)} percent, azimuth error ${aErr.toFixed(4)} deg `
        + `(truth ${trueAz.toFixed(2)}), chaos max ${cMax.toExponential(2)}`);
      expect(dErr).toBeLessThan(0.02);
      expect(aErr).toBeLessThan(1);
      expect(cMax).toBeLessThan(0.1);
    },
  );

  // t = t0 + A (il^2 + xl^2): kPos = kNeg = 2 A dtMs = 0.4 ms/trace^2 at
  // A = 0.05, dt 4 ms. The vertical window spans one period of the
  // 40-sample cosine (160 ms), otherwise the phase weights the box and the
  // curvature ripples a few percent about the truth.
  const A = 0.05;
  const EXPECT = 2 * A * 4;
  const surface = (fn) => cubeSource(15, 15, 96, (i, j, t) => Math.cos((2 * Math.PI * (t - 48 - fn(i - 7, j - 7))) / 40));
  test.each([
    ['dome (anticline in time)', (i, j) => A * (i * i + j * j), EXPECT, EXPECT],
    ['syncline', (i, j) => -A * (i * i + j * j), -EXPECT, -EXPECT],
    ['saddle', (i, j) => A * (i * i - j * j), EXPECT, -EXPECT],
  ])('%s: curvature within 2 percent of 2A dtMs', (label, fn, wantPos, wantNeg) => {
    const src = surface(fn);
    const P = { windowMs: 160, radius: 1 };
    const kp = volumeOf(src, 'curvature_pos', P);
    const kn = volumeOf(src, 'curvature_neg', P);
    const ep = inner(src, (i, j, t, k) => kp[k], 4, 24);
    const en = inner(src, (i, j, t, k) => kn[k], 4, 24);
    const errP = Math.max(...ep.map((v) => Math.abs(v / wantPos - 1)));
    const errN = Math.max(...en.map((v) => Math.abs(v / wantNeg - 1)));
    console.log(`${label}: kPos ${Math.min(...ep).toFixed(4)}..${Math.max(...ep).toFixed(4)} (want ${wantPos}), `
      + `kNeg ${Math.min(...en).toFixed(4)}..${Math.max(...en).toFixed(4)} (want ${wantNeg})`);
    expect(errP).toBeLessThan(0.02);
    expect(errN).toBeLessThan(0.02);
    if (wantPos > 0 && wantNeg < 0) {
      for (let k = 0; k < ep.length; k++) expect(ep[k] > 0 && en[k] < 0).toBe(true);
    }
  });

  test('chaos on white noise averages above 0.5', () => {
    const r = rng(99);
    const src = cubeSource(12, 12, 64, () => gauss(r));
    const c = volumeOf(src, 'chaos', {});
    const mean = c.reduce((a, b) => a + b, 0) / c.length;
    console.log(`white-noise chaos: mean ${mean.toFixed(3)}`);
    expect(mean).toBeGreaterThan(0.5);
  });

  test('edge peaks on the two columns either side of a vertical step and is 0 away from it', () => {
    const K = 6;
    const layered = (t) => Math.cos((2 * Math.PI * t) / 12);
    const src = cubeSource(10, 12, 48, (i, j, t) => layered(t + (j >= K ? 3 : 0)));
    const e = volumeOf(src, 'edge', {});
    const colMax = [];
    for (let j = 0; j < src.nXl; j++) {
      let m = 0;
      for (let t = 0; t < src.ns; t++) m = Math.max(m, e[(5 * src.nXl + j) * src.ns + t]);
      colMax.push(m);
    }
    console.log(`edge column maxima: ${colMax.map((v) => v.toFixed(3)).join(' ')}`);
    expect(colMax[K - 1]).toBeGreaterThan(0.1);
    expect(colMax[K]).toBeGreaterThan(0.1);
    colMax.forEach((v, j) => { if (j < K - 1 || j > K) expect(v).toBe(0); });
  });

  test('spectral: a 30 Hz cosine reads stronger at 30 than at 60 Hz, and equals isofrequencyAt exactly', () => {
    const ns = 64;
    const tr = Float32Array.from({ length: ns }, (_, t) => Math.cos(2 * Math.PI * 30 * t * 0.004));
    const s30 = new Float32Array(ns);
    const s60 = new Float32Array(ns);
    makeTraceCompute('spectral', { freqHz: 30, windowMs: 40 }, { dtUs: 4000 })(tr, s30);
    makeTraceCompute('spectral', { freqHz: 60, windowMs: 40 }, { dtUs: 4000 })(tr, s60);
    let minRatio = Infinity;
    for (let z = 8; z < ns - 8; z++) minRatio = Math.min(minRatio, s30[z] / s60[z]);
    console.log(`spectral 30 Hz / 60 Hz on a 30 Hz cosine: min ratio ${minRatio.toFixed(3)}`);
    expect(minRatio).toBeGreaterThan(2);
    for (let z = 0; z < ns; z++) {
      expect(s30[z]).toBe(Math.fround(isofrequencyAt((s) => tr[s], ns, z, { freqHz: 30, hw: 5, dtS: 0.004 })));
    }
    // nulls stay null
    const withNull = Float32Array.from(tr);
    withNull[10] = NULL_VALUE;
    const o = new Float32Array(ns);
    spectralTrace(withNull, 30, 5, 4000, o);
    expect(isNull(o[10])).toBe(true);
    expect(isNull(o[11])).toBe(false);
  });

  test('rai: a single spike becomes a step inside the trend window', () => {
    const ns = 96;
    const k0 = 48;
    const hw = 8;                                  // lowCutMs 64 at 4 ms
    const spike = new Float32Array(ns);
    spike[k0] = 1;
    const out = new Float32Array(ns);
    makeTraceCompute('rai', { lowCutMs: 64 }, { dtUs: 4000 })(spike, out);
    const w = 2 * hw + 1;
    const jump = out[k0] - out[k0 - 1];
    console.log(`rai spike: jump ${jump.toFixed(6)} (want ${(1 - 1 / w).toFixed(6)})`);
    expect(Math.abs(jump - (1 - 1 / w))).toBeLessThan(1e-6);
    for (let k = k0 - hw + 1; k <= k0 + hw; k++) {
      if (k === k0) continue;
      expect(Math.abs(out[k] - out[k - 1] + 1 / w)).toBeLessThan(1e-6);   // the trend ramp
    }
    for (let k = 0; k < ns; k++) {
      if (k < k0 - hw || k >= k0 + hw) expect(Math.abs(out[k])).toBeLessThan(1e-6);
    }
    const n2 = new Float32Array(ns);
    const withNull = Float32Array.from(spike);
    withNull[3] = NULL_VALUE;
    raiTrace(withNull, hw, n2);
    expect(isNull(n2[3])).toBe(true);
  });

  test('eigSym3 sorts descending and satisfies T v = lambda v', () => {
    const m = [4, 1, 0.5, 3, 0.2, 1];
    const { l, v } = eigSym3(m);
    expect(l[0]).toBeGreaterThanOrEqual(l[1]);
    expect(l[1]).toBeGreaterThanOrEqual(l[2]);
    const M = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
    for (let k = 0; k < 3; k++) {
      for (let r = 0; r < 3; r++) {
        const tv = M[r][0] * v[k][0] + M[r][1] * v[k][1] + M[r][2] * v[k][2];
        expect(Math.abs(tv - l[k] * v[k][r])).toBeLessThan(1e-12);
      }
    }
  });

  test('a steep event is capped at DIP_CAP samples per trace; a silent volume has dip 0 and no azimuth', () => {
    const src = cubeSource(9, 9, 32, (i) => (i >= 4 ? 1 : 0));    // a vertical wall: normal horizontal
    const dip = volumeOf(src, 'dip', {});
    expect(Math.max(...dip)).toBeCloseTo(DIP_CAP * 4, 4);
    const silent = cubeSource(5, 5, 16, () => 0);
    expect(volumeOf(silent, 'dip', {}).every((v) => v === 0)).toBe(true);
    expect(volumeOf(silent, 'azimuth', {}).every(isNull)).toBe(true);
    expect(volumeOf(silent, 'chaos', {}).every((v) => v === 0)).toBe(true);
  });
});

// ------------------------------------------------- column == whole volume

describe('a brick column at a time equals the whole volume', () => {
  // 26 x 22 x 40: a dipping, domed, faulted field with noise, nulls and a
  // dead trace, so every block edge carries real structure
  const r = rng(4242);
  const noise = Array.from({ length: 26 * 22 * 40 }, () => gauss(r));
  const SRC = cubeSource(26, 22, 40, (i, j, t) => {
    if (i === 12 && j === 9) return NULL_VALUE;                 // dead trace
    if (i === 15 && j === 16 && t >= 10 && t < 14) return NULL_VALUE;
    const tau = 12 + 0.4 * i - 0.25 * j + 0.03 * ((i - 13) ** 2 + (j - 11) ** 2) + (j >= 14 ? 2 : 0);
    return Math.cos((2 * Math.PI * (t - tau)) / 9) + 0.2 * noise[(i * 22 + j) * 40 + t];
  });
  const cases = [
    ...REGIONAL.map((name) => [name, {}]),
    ['dip', { radius: 2 }],
    ['curvature_pos', { radius: 2, windowMs: 40 }],
    ['curvature_neg', { radius: 2, windowMs: 8 }],
  ];
  const whole = new Map();
  const wholeOf = (name, params) => {
    const key = `${name}${JSON.stringify(params)}`;
    if (!whole.has(key)) whole.set(key, volumeOf(SRC, name, params));
    return whole.get(key);
  };
  const blk = { il0: 8, il1: 15, xl0: 8, xl1: 15 };
  const blockDiff = (name, params, halo) => {
    const out = structureBlock({
      name, getTrace: SRC.getTrace, nIl: SRC.nIl, nXl: SRC.nXl, ns: SRC.ns, dtMs: 4, ...blk, params, halo, affine: TEST_AFFINE,
    });
    const w = wholeOf(name, params);
    const nJ = blk.xl1 - blk.xl0 + 1;
    let d = 0;
    for (let il = blk.il0; il <= blk.il1; il++) {
      for (let xl = blk.xl0; xl <= blk.xl1; xl++) {
        for (let s = 0; s < SRC.ns; s++) {
          const a = out[((il - blk.il0) * nJ + (xl - blk.xl0)) * SRC.ns + s];
          const b = w[(il * SRC.nXl + xl) * SRC.ns + s];
          if (isNull(a) !== isNull(b)) return Infinity;
          if (!isNull(a)) d = Math.max(d, name === 'azimuth' ? Math.abs(((a - b + 540) % 360) - 180) : Math.abs(a - b));
        }
      }
    }
    return d;
  };

  test('the halo is the reach: edge 1, tensor r+1, curvature r+2', () => {
    expect(structureHalo('edge')).toBe(1);
    expect(structureHalo('dip')).toBe(2);
    expect(structureHalo('chaos', { radius: 2 })).toBe(3);
    expect(structureHalo('curvature_pos')).toBe(3);
    expect(structureHalo('curvature_neg', { radius: 2 })).toBe(4);
  });

  test.each(cases)('%s %j: an interior block with the halo equals the whole volume exactly; one cell less differs', (name, params) => {
    const halo = structureHalo(name, params);
    const exact = blockDiff(name, params, halo);
    const short = blockDiff(name, params, halo - 1);
    console.log(`${name} ${JSON.stringify(params)}: halo ${halo} diff ${exact}, halo ${halo - 1} diff ${short.toExponential(2)}`);
    expect(exact).toBe(0);
    expect(short).toBeGreaterThan(1e-4);
  });

  test.each(cases)('%s %j: end to end through runNeighborhoodJob (brick size 8) equals the whole volume exactly', async (name, params) => {
    const { out } = await runJob(SRC, name, params, 8);
    expect(maxDiff(out, wholeOf(name, params))).toBe(0);
  });
});

// ---------------------------------------------------------------- registry

describe('registry', () => {
  const badCopy = (s) => /[—–]|--|,\s*not\s/i.test(s);

  test('structure defs are own-property, regional neighborhood entries with usable copy', () => {
    for (const key of REGIONAL) {
      expect(Object.prototype.hasOwnProperty.call(DISCONTINUITY_DEFS, key)).toBe(true);
      const def = DISCONTINUITY_DEFS[key];
      expect(def.key).toBe(key);
      expect(def.neighborhood).toBe(true);
      expect(def.regional).toBe(true);
      expect(badCopy(def.label)).toBe(false);
      for (const p of Object.values(def.params)) {
        expect(badCopy(p.label)).toBe(false);
        expect(p.min).toBeLessThanOrEqual(p.default);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
      // the registry defaults are the engine defaults
      const defaults = Object.fromEntries(Object.entries(def.params).map(([k, p]) => [k, p.default]));
      expect(structureParams(key, defaults, 4)).toEqual(structureParams(key, {}, 4));
      expect(() => makeNeighborhoodCompute(key, {}, { dtUs: 4000 })).toThrow(/makeDiscontinuityJob/);
    }
    expect(DISCONTINUITY_DEFS.azimuth.label).toMatch(/lattice/i);
    for (const key of ['spectral', 'rai']) {
      expect(Object.prototype.hasOwnProperty.call(ATTRIBUTE_DEFS, key)).toBe(true);
      expect(badCopy(ATTRIBUTE_DEFS[key].label)).toBe(false);
      for (const p of Object.values(ATTRIBUTE_DEFS[key].params)) expect(badCopy(p.label)).toBe(false);
    }
  });

  test('prototype keys and bad inputs are refused', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => makeDiscontinuityJob(k, {}, { dtUs: 4000, nIl: 4, nXl: 4, ns: 8 })).toThrow(/Unknown/);
      expect(() => makeTraceCompute(k, {}, { dtUs: 4000 })).toThrow(/Unknown/);
      expect(() => structureHalo(k)).toThrow(/Unknown/);
    }
    expect(() => makeDiscontinuityJob('dip', {}, { dtUs: 0, nIl: 4, nXl: 4, ns: 8 })).toThrow(/positive dt/);
    expect(() => makeDiscontinuityJob('dip', {}, { dtUs: 4000 })).toThrow(/survey size/);
    expect(() => makeDiscontinuityJob('dip', { windowMs: -4 }, { dtUs: 4000, nIl: 4, nXl: 4, ns: 8 })).toThrow(/not usable/);
    expect(() => makeTraceCompute('spectral', { freqHz: 200 }, { dtUs: 4000 })).toThrow(/usable range/);
    const job = makeDiscontinuityJob('curvature_pos', { radius: 2 }, { dtUs: 4000, nIl: 4, nXl: 4, ns: 8 });
    expect(job.radius).toBe(4);
    expect(typeof job.computeColumn).toBe('function');
  });
});
