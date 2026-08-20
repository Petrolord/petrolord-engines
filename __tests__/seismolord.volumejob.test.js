/**
 * W2.1 derived-volume pipeline oracles: bit-exact end-to-end over a
 * synthetic brick store (identity compute reproduces the parent bricks
 * exactly, padding included), per-trace scatter/gather correctness
 * against the attribute engine applied directly, stats over stored
 * float32, cancellation, and the manifest v2 contract (geometry/brick
 * copied verbatim; the W0.1 gate accepts v2 and still refuses v3 and
 * non-float32 payloads).
 */

import { runVolumeJob, VolumeJobCancelledError } from '../engines/seismolord/volumeJob';
import { envelopeTrace, makeTraceCompute } from '../engines/seismolord/attributes';
import {
  NULL_VALUE, buildDerivedManifest, assertManifestSupported, MANIFEST_READ_MAX,
} from '../engines/seismolord/manifest';
import { geomFromManifest, assembleTrace } from '../engines/seismolord/sliceAssembly';

const NULL_F32 = Math.fround(NULL_VALUE);

// Small survey that exercises partial bricks on every axis:
// 5 inlines x 6 crosslines x 10 samples at brickSize 4 -> 2 x 2 x 3 bricks.
const NIL = 5;
const NXL = 6;
const NS = 10;
const B = 4;
const GRID = [2, 2, 3];

const sampleValue = (il, xl, k) => Math.fround(Math.sin(il * 0.7 + xl * 0.3 + k * 0.5) * (1 + il));

/** Build the parent brick store exactly as transcodeToBricks lays it out. */
function buildParentBricks({ deadTrace = null } = {}) {
  const bricks = new Map();
  const [ni, nj, nk] = GRID;
  for (let i = 0; i < ni; i++) {
    for (let j = 0; j < nj; j++) {
      for (let k = 0; k < nk; k++) {
        bricks.set(`${i}-${j}-${k}`, new Float32Array(B * B * B).fill(NULL_VALUE));
      }
    }
  }
  for (let il = 0; il < NIL; il++) {
    for (let xl = 0; xl < NXL; xl++) {
      if (deadTrace && deadTrace[0] === il && deadTrace[1] === xl) continue;
      for (let k = 0; k < NS; k++) {
        const bi = Math.floor(il / B);
        const bj = Math.floor(xl / B);
        const bk = Math.floor(k / B);
        const brick = bricks.get(`${bi}-${bj}-${bk}`);
        brick[((il % B) * B + (xl % B)) * B + (k % B)] = sampleValue(il, xl, k);
      }
    }
  }
  return bricks;
}

const geom = { nIl: NIL, nXl: NXL, ns: NS, brickSize: B, grid: GRID };

function makeJobHarness(parentBricks) {
  const outBricks = new Map();
  return {
    outBricks,
    fetchBrick: async (i, j, k) => parentBricks.get(`${i}-${j}-${k}`),
    onBrick: ({ i, j, k, data }) => {
      outBricks.set(`${i}-${j}-${k}`, data);
    },
  };
}

const identity = (trace, out) => out.set(trace);

describe('runVolumeJob', () => {
  test('identity compute reproduces the parent store bit-exactly, padding included', async () => {
    const parent = buildParentBricks();
    const h = makeJobHarness(parent);
    const progress = [];
    const result = await runVolumeJob({
      geom,
      compute: identity,
      fetchBrick: h.fetchBrick,
      onBrick: h.onBrick,
      onProgress: (done, total, phase) => progress.push([done, total, phase]),
    });

    expect(h.outBricks.size).toBe(GRID[0] * GRID[1] * GRID[2]);
    for (const [key, brick] of parent) {
      expect(Array.from(h.outBricks.get(key))).toEqual(Array.from(brick));
    }
    expect(result.traceCount).toBe(NIL * NXL);
    expect(result.brickGrid).toEqual({ ni: 2, nj: 2, nk: 3, brickSize: B });
    expect(progress.length).toBe(12);
    expect(progress[progress.length - 1]).toEqual([12, 12, 'compute']);

    // stats over the stored float32 payload
    let min = Infinity; let max = -Infinity; let sum = 0; let sumSq = 0; let n = 0;
    for (let il = 0; il < NIL; il++) {
      for (let xl = 0; xl < NXL; xl++) {
        for (let k = 0; k < NS; k++) {
          const v = sampleValue(il, xl, k);
          min = Math.min(min, v); max = Math.max(max, v);
          sum += v; sumSq += v * v; n += 1;
        }
      }
    }
    expect(result.stats.live_samples).toBe(n);
    expect(result.stats.min).toBeCloseTo(min, 10);
    expect(result.stats.max).toBeCloseTo(max, 10);
    expect(result.stats.mean).toBeCloseTo(sum / n, 10);
    expect(result.stats.rms).toBeCloseTo(Math.sqrt(sumSq / n), 10);
  });

  test('attribute compute equals the per-trace engine applied to assembled traces', async () => {
    const parent = buildParentBricks();
    const h = makeJobHarness(parent);
    await runVolumeJob({
      geom,
      compute: makeTraceCompute('envelope', {}, { dtUs: 4000 }),
      fetchBrick: h.fetchBrick,
      onBrick: h.onBrick,
    });

    const getOut = async (i, j, k) => h.outBricks.get(`${i}-${j}-${k}`);
    const getParent = async (i, j, k) => parent.get(`${i}-${j}-${k}`);
    for (let il = 0; il < NIL; il++) {
      for (let xl = 0; xl < NXL; xl++) {
        const parentTrace = await assembleTrace(getParent, geom, il, xl);
        const expected = new Float32Array(NS);
        envelopeTrace(parentTrace, expected);
        const got = await assembleTrace(getOut, geom, il, xl);
        expect(Array.from(got)).toEqual(Array.from(expected));
      }
    }
  });

  test('dead traces stay null and are excluded from traceCount', async () => {
    const parent = buildParentBricks({ deadTrace: [2, 3] });
    const h = makeJobHarness(parent);
    const result = await runVolumeJob({
      geom, compute: identity, fetchBrick: h.fetchBrick, onBrick: h.onBrick,
    });
    expect(result.traceCount).toBe(NIL * NXL - 1);
    const got = await assembleTrace(
      async (i, j, k) => h.outBricks.get(`${i}-${j}-${k}`), geom, 2, 3,
    );
    for (const v of got) expect(v).toBe(NULL_F32);
  });

  test('cancellation throws the named error before finishing', async () => {
    const parent = buildParentBricks();
    const h = makeJobHarness(parent);
    let columns = 0;
    await expect(runVolumeJob({
      geom,
      compute: identity,
      fetchBrick: h.fetchBrick,
      onBrick: h.onBrick,
      shouldCancel: () => columns++ >= 1,
    })).rejects.toThrow(VolumeJobCancelledError);
    expect(h.outBricks.size).toBeLessThan(12);
  });
});

describe('manifest v2', () => {
  const parentManifest = {
    manifest_version: 1,
    app: 'seismolord',
    volume_id: 'parent-id',
    name: 'Parent Volume',
    geometry: {
      il: { min: 100, max: 104, step: 1, count: NIL },
      xl: { min: 200, max: 205, step: 1, count: NXL },
      ns: NS,
      dt_us: 4000,
      corners: [[0, 0], [1, 0], [0, 1]],
      affine: { a: 1 },
    },
    brick: {
      size: B,
      grid: GRID,
      count: 12,
      dtype: 'float32le',
      layout: 'il-major,xl,sample-fastest',
      path_pattern: 'bricks/{i}-{j}-{k}.f32',
      null_value: NULL_VALUE,
    },
    stats: { min: -1, max: 1, mean: 0, rms: 0.5, live_samples: 300 },
    trace_count: 30,
  };
  const job = {
    brickGrid: { ni: 2, nj: 2, nk: 3, brickSize: B },
    stats: { min: 0, max: 2, mean: 1, rms: 1.1, live_samples: 300 },
    traceCount: 30,
  };

  test('geometry and brick blocks are copied verbatim (deep-equal, detached)', () => {
    const m = buildDerivedManifest({
      volumeId: 'child-id',
      name: 'Parent Volume [envelope]',
      parentManifest,
      attribute: { name: 'envelope', params: {} },
      job,
    });
    expect(m.manifest_version).toBe(2);
    expect(m.kind).toBe('attribute');
    expect(m.parent).toEqual({ volume_id: 'parent-id', name: 'Parent Volume' });
    expect(m.attribute).toEqual({ name: 'envelope', params: {} });
    expect(m.geometry).toEqual(parentManifest.geometry);
    expect(m.geometry).not.toBe(parentManifest.geometry);
    expect(m.brick).toEqual(parentManifest.brick);
    expect(m.stats).toBe(job.stats);
    expect(m.trace_count).toBe(30);

    // the reader accepts v2 through the choke point (ceiling is 3 since W5.1)
    expect(MANIFEST_READ_MAX).toBeGreaterThanOrEqual(2);
    expect(() => assertManifestSupported(m)).not.toThrow();
    expect(geomFromManifest(m)).toEqual({
      nIl: NIL, nXl: NXL, ns: NS, brickSize: B, grid: GRID,
    });
  });

  test('grid or dtype mismatch with the parent refuses loudly', () => {
    expect(() => buildDerivedManifest({
      volumeId: 'x',
      name: 'x',
      parentManifest: { ...parentManifest, brick: { ...parentManifest.brick, dtype: 'int16le-scaled' } },
      attribute: { name: 'envelope' },
      job,
    })).toThrow(/float32le parent/);
    expect(() => buildDerivedManifest({
      volumeId: 'x',
      name: 'x',
      parentManifest,
      attribute: { name: 'envelope' },
      job: { ...job, brickGrid: { ni: 3, nj: 2, nk: 3, brickSize: B } },
    })).toThrow(/must be identical/);
  });

  test('the gate still refuses newer versions and foreign dtypes (int16le-scaled accepted since W4.4)', () => {
    // v3 = 2D lines (W5.1); v4 is the next future version
    expect(() => assertManifestSupported({ manifest_version: 4, brick: { dtype: 'float32le' } }))
      .toThrow(expect.objectContaining({ name: 'UNSUPPORTED_MANIFEST' }));
    expect(() => assertManifestSupported({ manifest_version: 2, brick: { dtype: 'int16le-scaled' } }))
      .not.toThrow();
    expect(() => assertManifestSupported({ manifest_version: 2, brick: { dtype: 'int8le' } }))
      .toThrow(expect.objectContaining({ name: 'UNSUPPORTED_MANIFEST' }));
  });
});

describe('sameLattice (W2.4 co-render gate)', () => {
  const { sameLattice } = require('../engines/seismolord/surveyGeometry');
  const geom = {
    il: { min: 100, max: 104, step: 1, count: 5 },
    xl: { min: 200, max: 205, step: 1, count: 6 },
    ns: 10,
    dt_us: 4000,
  };
  const m = (g) => ({ geometry: g });

  test('a derived manifest (geometry verbatim) matches its parent', () => {
    expect(sameLattice(m(geom), m(JSON.parse(JSON.stringify(geom))))).toBe(true);
  });

  test('any axis/sampling difference refuses', () => {
    expect(sameLattice(m(geom), m({ ...geom, ns: 12 }))).toBe(false);
    expect(sameLattice(m(geom), m({ ...geom, dt_us: 2000 }))).toBe(false);
    expect(sameLattice(m(geom), m({ ...geom, il: { ...geom.il, min: 101 } }))).toBe(false);
    expect(sameLattice(m(geom), m({ ...geom, xl: { ...geom.xl, count: 7 } }))).toBe(false);
    expect(sameLattice(m(geom), null)).toBe(false);
  });

  test('world placement differences do NOT refuse (lattice only)', () => {
    expect(sameLattice(
      { geometry: { ...geom, affine: { a: 1 } } },
      { geometry: { ...geom, affine: { a: 2 }, crs: { project: 'EPSG:32631' } } },
    )).toBe(true);
  });
});
