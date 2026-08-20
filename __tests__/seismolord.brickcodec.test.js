/**
 * W4.4 int16 brick codec oracles: round-trip error bounded by scale/2,
 * exact null sentinels, per-brick scaling, header layout pinned, quota
 * math for padded grids, the manifest gate's dtype acceptance, and the
 * BrickCache decode + concurrency-cap behaviour.
 */

import {
  encodeBrickInt16, decodeBrickInt16, decodeBrickPayload,
  INT16_DTYPE, INT16_HEADER_BYTES, INT16_NULL, bytesPerVoxel, brickGridBytes,
} from '../engines/seismolord/brickCodec';
import { assertManifestSupported, NULL_VALUE } from '../engines/seismolord/manifest';
import { BrickCache, ABORTED } from '../engines/seismolord/brickCache';

const NULL_F32 = Math.fround(NULL_VALUE);

/** Deterministic pseudo-random brick (LCG). */
function randomBrick(n, seed = 7, amp = 1000) {
  const out = new Float32Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (1664525 * x + 1013904223) >>> 0;
    out[i] = ((x / 0xffffffff) - 0.5) * 2 * amp;
  }
  return out;
}

describe('encode/decode round trip', () => {
  test('error bounded by scale/2; nulls exact', () => {
    const brick = randomBrick(64 * 64, 3);
    brick[10] = NULL_F32;
    brick[999] = NULL_F32;
    const buf = encodeBrickInt16(brick);
    expect(buf.byteLength).toBe(INT16_HEADER_BYTES + brick.length * 2);
    const scale = new DataView(buf).getFloat32(0, true);
    const back = decodeBrickInt16(buf);
    let maxErr = 0;
    for (let i = 0; i < brick.length; i++) {
      if (brick[i] === NULL_F32) {
        expect(back[i]).toBe(NULL_F32);
        continue;
      }
      maxErr = Math.max(maxErr, Math.abs(back[i] - brick[i]));
    }
    // scale/2 quantization + one half-ulp of float32 output rounding
    expect(maxErr).toBeLessThanOrEqual(scale / 2 + 1000 * 2 ** -23);
    expect(scale).toBeGreaterThan(0);
    // 16-bit quantization of a ±1000 brick: error under ~0.02
    expect(maxErr).toBeLessThan(2000 / 65534);
  });

  test('per-brick scaling: a quiet brick keeps fine resolution', () => {
    const loud = randomBrick(4096, 5, 10000);
    const quiet = randomBrick(4096, 9, 1);
    const sLoud = new DataView(encodeBrickInt16(loud)).getFloat32(0, true);
    const sQuiet = new DataView(encodeBrickInt16(quiet)).getFloat32(0, true);
    expect(sQuiet).toBeLessThan(sLoud / 1000);
  });

  test('flat and all-null bricks decode exactly', () => {
    const flat = new Float32Array(512).fill(42.5);
    const backFlat = decodeBrickInt16(encodeBrickInt16(flat));
    for (const v of backFlat) expect(v).toBeCloseTo(42.5, 6);
    const nulls = new Float32Array(512).fill(NULL_F32);
    const backNulls = decodeBrickInt16(encodeBrickInt16(nulls));
    for (const v of backNulls) expect(v).toBe(NULL_F32);
  });

  test('header layout pinned: scale then offset, little-endian; sentinel -32768', () => {
    const brick = Float32Array.from([0, 10]);
    brick[0] = NULL_F32;
    const buf = encodeBrickInt16(brick);
    const dv = new DataView(buf);
    const scale = dv.getFloat32(0, true);
    const offset = dv.getFloat32(4, true);
    expect(offset).toBeCloseTo(10, 6);       // single live value
    expect(scale).toBe(0);                   // flat
    const counts = new Int16Array(buf, INT16_HEADER_BYTES);
    expect(counts[0]).toBe(INT16_NULL);
    expect(counts[1]).toBe(0);
  });
});

describe('decodeBrickPayload dispatch + gate', () => {
  test('float32le passes through; int16 decodes; unknown throws', () => {
    const f32 = Float32Array.from([1, 2, 3]);
    expect(Array.from(decodeBrickPayload(f32.buffer.slice(0), 'float32le')))
      .toEqual([1, 2, 3]);
    const viaInt16 = decodeBrickPayload(encodeBrickInt16(f32), INT16_DTYPE);
    expect(viaInt16[2]).toBeCloseTo(3, 3);
    expect(() => decodeBrickPayload(new ArrayBuffer(8), 'float16le')).toThrow(/dtype/);
  });

  test('the manifest gate accepts int16le-scaled and still rejects others', () => {
    expect(() => assertManifestSupported({ manifest_version: 1, brick: { dtype: 'int16le-scaled' } }))
      .not.toThrow();
    expect(() => assertManifestSupported({ manifest_version: 1, brick: { dtype: 'float32le' } }))
      .not.toThrow();
    expect(() => assertManifestSupported({ manifest_version: 1, brick: { dtype: 'int8le' } }))
      .toThrow(/dtype/);
  });

  test('quota math: padded grid, per-dtype bytes, int16 headers counted', () => {
    const grid = { ni: 2, nj: 3, nk: 4, brickSize: 64 };
    expect(bytesPerVoxel()).toBe(4);
    expect(bytesPerVoxel(INT16_DTYPE)).toBe(2);
    expect(brickGridBytes(grid)).toBe(24 * 64 ** 3 * 4);
    expect(brickGridBytes(grid, INT16_DTYPE)).toBe(24 * (64 ** 3 * 2 + INT16_HEADER_BYTES));
  });
});

describe('BrickCache with the codec + concurrency cap', () => {
  test('int16 volumes decode inside the cache — callers stay codec-blind', async () => {
    const brick = randomBrick(64, 11);
    const payload = encodeBrickInt16(brick);
    const cache = new BrickCache(async () => payload.slice(0), { dtype: INT16_DTYPE });
    const data = await cache.get('a/bricks/0-0-0.f32');
    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(64);
    expect(Math.abs(data[7] - brick[7])).toBeLessThan(0.1);
  });

  test('maxConcurrent caps simultaneous fetches; queued fetches run after', async () => {
    let active = 0;
    let peak = 0;
    const resolvers = [];
    const fetcher = () => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      resolvers.push(() => {
        active -= 1;
        resolve(new Float32Array([active]).buffer.slice(0));
      });
    });
    const cache = new BrickCache(fetcher, { maxConcurrent: 2 });
    const jobs = ['a', 'b', 'c', 'd'].map((p) => cache.get(p));
    await new Promise((r) => { setTimeout(r, 0); });
    expect(peak).toBe(2);                     // c and d wait for slots
    resolvers.shift()();                      // finish one -> c starts
    await new Promise((r) => { setTimeout(r, 0); });
    expect(peak).toBe(2);
    while (resolvers.length) resolvers.shift()();
    await new Promise((r) => { setTimeout(r, 0); });
    while (resolvers.length) resolvers.shift()();
    await Promise.all(jobs);
    expect(active).toBe(0);
  });

  test('a queued fetch cancelled before its slot rejects ABORTED', async () => {
    const resolvers = [];
    const fetcher = () => new Promise((resolve) => {
      resolvers.push(() => resolve(new Float32Array([1]).buffer.slice(0)));
    });
    const cache = new BrickCache(fetcher, { maxConcurrent: 1 });
    const first = cache.get('a');
    const queued = cache.get('b');
    cache.cancelPendingExcept(new Set(['a']));  // aborts b while queued
    await expect(queued).rejects.toThrow(ABORTED);
    resolvers.shift()();
    await first;
  });
});
