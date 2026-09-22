/**
 * Manifest v4 brick store (large-survey plan, Stream C): codecs, the
 * memory plan, the streaming transcoder and its manifest.
 *
 * Oracles: the v1 transcoder (float32 bricks must come back bit-for-bit),
 * a brute-force dense reference for the display levels of detail and the
 * exact histogram, and node:zlib for deflate-raw (the format the
 * browser's CompressionStream('deflate-raw') writes).
 */
import zlib from 'node:zlib';
import { bufferReader } from '../engines/seismolord/reader';
import { decodeSamples } from '../engines/seismolord/segyDecode';
import { transcodeToBricks } from '../engines/seismolord/brickTranscode';
import {
  transcodeV4, planTranscodeV4, gridFromScan, sampleAmplitudeClip, levelDims,
  percentileFromHistogram, makeAbsHistogram, V4_DEFAULT_BUDGET_BYTES,
} from '../engines/seismolord/brickTranscodeV4';
import {
  quantizeU8, dequantizeU8, dequantizeBrick, shuffle4, unshuffle4, encodeF32Brick,
  decodeF32Brick, encodeU8Brick, decodeU8Brick, resolveCodec, hasNativeDeflateRaw,
  U8_NULL, U8_ZERO, DEFLATE_RAW, NO_COMPRESSION, v4BrickFetcher, v4BrickPrecision,
} from '../engines/seismolord/brickCodecV4';
import {
  NULL_VALUE, buildManifestV4, withV4Complete, assertManifestSupported, UnsupportedManifestError,
  buildDerivedManifest, displayBrickRelPath, f32BrickRelPath, isV4Manifest, MANIFEST_READ_MAX,
} from '../engines/seismolord/manifest';
import { makeSegy, scanOf, virtualSegyReader } from './seismolordSegyFixture';

const NULL_F32 = Math.fround(NULL_VALUE);
const ZLIB = {
  compression: DEFLATE_RAW,
  deflate: async (b) => new Uint8Array(zlib.deflateRawSync(b)),
  inflate: async (b) => new Uint8Array(zlib.inflateRawSync(b)),
};
const bits = (f) => new Uint32Array(f.buffer, f.byteOffset, f.length);

// ---------------------------------------------------------------------------
describe('u8 display quantisation', () => {
  const clip = 800;
  test('zero, the clip and beyond, and nulls', () => {
    expect(quantizeU8(0, clip)).toBe(U8_ZERO);
    expect(quantizeU8(-0, clip)).toBe(U8_ZERO);
    expect(quantizeU8(clip, clip)).toBe(255);
    expect(quantizeU8(-clip, clip)).toBe(1);
    expect(quantizeU8(5 * clip, clip)).toBe(255);
    expect(quantizeU8(-5 * clip, clip)).toBe(1);
    for (const n of [NULL_F32, NULL_VALUE, -NULL_VALUE, NaN, Infinity, -Infinity, 2e29]) {
      expect(quantizeU8(n, clip)).toBe(U8_NULL);
    }
    expect(dequantizeU8(U8_NULL, clip)).toBe(NULL_F32);
  });

  test('symmetric under polarity, and the round trip is within half a step', () => {
    let worst = 0;
    for (let n = 0; n <= 20000; n++) {
      const a = Math.fround(((n / 20000) * 2 - 1) * clip);
      const q = quantizeU8(a, clip);
      expect(q).toBeGreaterThanOrEqual(1);
      expect(quantizeU8(-a, clip)).toBe(256 - q);
      worst = Math.max(worst, Math.abs(dequantizeU8(q, clip) - a));
    }
    expect(worst).toBeLessThanOrEqual(clip / 254 + 1e-9);
  });

  test('a non-positive clip degrades to 1 instead of dividing by zero', () => {
    expect(quantizeU8(0, 0)).toBe(U8_ZERO);
    expect(quantizeU8(0.5, 0)).toBe(U8_ZERO + 64);
    expect(dequantizeBrick(new Uint8Array([0, 128, 255]), 2)).toEqual(
      new Float32Array([NULL_F32, 0, 2]));
  });
});

describe('float32 byte shuffle and brick codecs', () => {
  const tricky = () => {
    const f = new Float32Array(4096);
    for (let i = 0; i < f.length; i++) f[i] = Math.sin(i) * 1e3;
    f[0] = -0; f[1] = NaN; f[2] = Infinity; f[3] = NULL_F32; f[4] = 1e-42; f[5] = -3.4e38;
    bits(f)[6] = 0x7fc12345;                 // a NaN payload survives
    return f;
  };

  test('shuffle then unshuffle is the identity', () => {
    const src = new Uint8Array(4096);
    for (let i = 0; i < src.length; i++) src[i] = (i * 37 + 11) & 255;
    const sh = shuffle4(src);
    expect(sh[0]).toBe(src[0]);
    expect(sh[1]).toBe(src[4]);
    expect(sh[1024]).toBe(src[1]);
    expect(unshuffle4(sh)).toEqual(src);
  });

  test.each([['deflate-raw', ZLIB], ['none', { compression: NO_COMPRESSION }]])(
    'f32 %s round trip is bit-exact', async (_, codec) => {
      const f = tricky();
      const enc = await encodeF32Brick(f, codec);
      const dec = await decodeF32Brick(enc, codec);
      expect(bits(dec)).toEqual(bits(f));
    });

  test('u8 round trip, compressed and stored', async () => {
    const codes = new Uint8Array(4096).map((_, i) => (i * 7) & 255);
    for (const codec of [ZLIB, { compression: NO_COMPRESSION }]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await decodeU8Brick(await encodeU8Brick(codes, codec), codec)).toEqual(codes);
    }
  });

  test('the default codec is the platform deflate-raw when it exists, else none', () => {
    expect(resolveCodec().compression).toBe(hasNativeDeflateRaw() ? DEFLATE_RAW : NO_COMPRESSION);
    if (!hasNativeDeflateRaw()) {
      expect(() => resolveCodec({ compression: DEFLATE_RAW })).toThrow(/cannot compress deflate-raw/);
    }
    expect(resolveCodec({ compression: NO_COMPRESSION }).compression).toBe(NO_COMPRESSION);
    expect(resolveCodec(ZLIB).compression).toBe(DEFLATE_RAW);
  });
});

// ---------------------------------------------------------------------------
describe('memory plan', () => {
  const tester = { nIl: 710, nXl: 876, ns: 1750, traceBytes: 7240 };

  test('the tester survey: 64^3 bricks 12 x 14 x 28, two even k-groups inside 320 MiB', () => {
    const p = planTranscodeV4(tester);
    expect(p.grid).toEqual([12, 14, 28]);
    expect(p.levels.map((l) => [l.dims, l.grid])).toEqual([
      [[710, 876, 1750], [12, 14, 28]],
      [[355, 438, 875], [6, 7, 14]],
      [[178, 219, 438], [3, 4, 7]],
      [[89, 110, 219], [2, 2, 4]],
    ]);
    // the plan's arithmetic: at level 2 an inline touches 4 x 7 = 28 bricks
    expect(p.levels[2].grid[1] * p.levels[2].grid[2]).toBe(28);
    expect(p.passesPerBand).toBe(2);
    expect(p.kGroup).toBe(14);
    expect(p.estimatedPeakBytes).toBeLessThanOrEqual(V4_DEFAULT_BUDGET_BYTES);
    expect(p.estimatedPeakBytes).toBeGreaterThan(250 * 1024 * 1024);
    // the whole-band alternative the plan rules out
    expect(64 * 876 * 1750 * 4).toBe(392448000);
  });

  test('a bigger budget reads the file once; a tiny one is refused with the need named', () => {
    expect(planTranscodeV4(tester, { memoryBudgetBytes: 1024 ** 3 }).passesPerBand).toBe(1);
    expect(planTranscodeV4(tester, { memoryBudgetBytes: 200 * 1024 ** 2 }).passesPerBand).toBe(4);
    expect(() => planTranscodeV4(tester, { memoryBudgetBytes: 32 * 1024 ** 2 }))
      .toThrow(/too small to convert this survey: one brick layer needs \d+ MiB/);
    expect(() => planTranscodeV4(tester, { brickSize: 12 })).toThrow(/not divisible/);
  });

  test('level dims halve with ceil', () => {
    expect(levelDims([7, 1, 9], 1)).toEqual([4, 1, 5]);
    expect(levelDims([7, 1, 9], 3)).toEqual([1, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Dense reference: the whole volume in memory (small fixtures only).
function denseFromSegy(fix, shape) {
  // decodeSamples is golden-validated against segyio (Suite goldens test)
  const { nIl, nXl, ns } = shape;
  const out = new Float32Array(nIl * nXl * ns).fill(NULL_F32);
  const v = new DataView(fix.buffer);
  const fmt = v.getInt16(3224, false);
  for (let c = 0; c < nIl * nXl; c++) {
    const t = fix.lattice[c];
    if (t < 0) continue;
    decodeSamples(v, 3600 + t * fix.traceBytes + 240, ns, fmt, out.subarray(c * ns, c * ns + ns));
  }
  return out;
}

/** Reference level L+1 from level L: mean of live 2x2x2 children, in the
 *  same summation order, stored float32 (NaN null). */
function refDown(src, [a, b, c]) {
  const A = Math.ceil(a / 2); const Bn = Math.ceil(b / 2); const C = Math.ceil(c / 2);
  const out = new Float32Array(A * Bn * C);
  const live = (v) => Math.abs(v) < 1e29;
  for (let i = 0; i < A; i++) {
    for (let j = 0; j < Bn; j++) {
      for (let k = 0; k < C; k++) {
        let s = 0; let n = 0;
        const is = [2 * i, 2 * i + 1].filter((q) => q < a);
        const js = [2 * j, 2 * j + 1].filter((q) => q < b);
        for (const ii of is) {
          for (const jj of js) {
            for (const kk of [2 * k, 2 * k + 1]) {
              if (kk >= c) continue;
              const v = src[(ii * b + jj) * c + kk];
              if (live(v)) { s += v; n += 1; }
            }
          }
        }
        out[(i * Bn + j) * C + k] = n ? s / n : NaN;
      }
    }
  }
  return { data: out, dims: [A, Bn, C] };
}

async function runV4(fix, scan, opts = {}) {
  const grid = gridFromScan(scan, opts.lattice ? { lattice: opts.lattice } : {});
  const store = new Map();
  const result = await transcodeV4(bufferReader(fix.buffer), grid, {
    codec: ZLIB,
    ...opts,
    onBrick: async (b) => {
      const key = b.kind === 'f32' ? f32BrickRelPath(b.i, b.j, b.k) : displayBrickRelPath(b.level, b.i, b.j, b.k);
      expect(store.has(key)).toBe(false);                 // every brick exactly once
      store.set(key, b.bytes);
    },
  });
  return { result, store };
}

async function runV1(fix, scan, brickSize) {
  const bricks = new Map();
  await transcodeToBricks(bufferReader(fix.buffer), { ...scan, sampled: false, regular: true, inlineSorted: true }, {
    brickSize,
    onBrick: ({ i, j, k, data }) => { bricks.set(`${i}-${j}-${k}`, data); },
  });
  return bricks;
}

/** Decimation by picking the first child (NOT a mean): the negative
 *  control's wrong reference. */
function refPick(src, [a, b, c]) {
  const A = Math.ceil(a / 2); const Bn = Math.ceil(b / 2); const C = Math.ceil(c / 2);
  const out = new Float32Array(A * Bn * C);
  for (let i = 0; i < A; i++) {
    for (let j = 0; j < Bn; j++) {
      for (let k = 0; k < C; k++) {
        const v = src[((2 * i) * b + 2 * j) * c + 2 * k];
        out[(i * Bn + j) * C + k] = Math.abs(v) < 1e29 ? v : NaN;
      }
    }
  }
  return { data: out, dims: [A, Bn, C] };
}

/** Compare every stored display brick with the reference; returns the
 *  mismatching voxel count per level (the gates expect all zeros). */
function checkDisplayLevels(store, dense, shape, result, B, { down = refDown } = {}) {
  let ref = { data: dense, dims: [shape.nIl, shape.nXl, shape.ns] };
  const clip = result.display.clip;
  const perLevel = [];
  return (async () => {
    for (const lvl of result.display.levels) {
      if (lvl.level > 0) ref = down(ref.data, ref.dims);
      expect(ref.dims).toEqual(lvl.dims);
      const [a, b, c] = lvl.dims;
      for (let i = 0; i < lvl.grid[0]; i++) {
        for (let j = 0; j < lvl.grid[1]; j++) {
          for (let k = 0; k < lvl.grid[2]; k++) {
            const payload = store.get(displayBrickRelPath(lvl.level, i, j, k));
            expect(payload).toBeDefined();
            // eslint-disable-next-line no-await-in-loop
            const codes = await decodeU8Brick(payload, ZLIB);
            let mismatches = 0;
            for (let li = 0; li < B; li++) {
              for (let lj = 0; lj < B; lj++) {
                for (let lk = 0; lk < B; lk++) {
                  const gi = i * B + li; const gj = j * B + lj; const gk = k * B + lk;
                  let want = 0;
                  if (gi < a && gj < b && gk < c) {
                    const v = ref.data[(gi * b + gj) * c + gk];
                    want = v === v ? quantizeU8(v, clip) : 0;
                  }
                  if (codes[(li * B + lj) * B + lk] !== want) mismatches += 1;
                }
              }
            }
            perLevel[lvl.level] = (perLevel[lvl.level] || 0) + mismatches;
          }
        }
      }
    }
    return perLevel;
  })();
}

describe.each([
  ['IEEE, ragged, forced into 3 k-groups', { nIl: 70, nXl: 45, ns: 150, format: 5 }, { memoryBudgetBytes: 375 * 1024, readChunkBytes: 4096 }],
  ['IBM, one k-group', { nIl: 37, nXl: 20, ns: 70, format: 1 }, {}],
])('transcodeV4 against v1 and the dense reference: %s', (_, shape, extra) => {
  const B = 16;
  const amp = (il, xl, s) => {
    if (il === 3 && xl === 4) return NaN;                   // a poisoned trace
    if (il === 5 && s > 40) return NULL_VALUE;              // explicit nulls
    if (s < 3) return 0;
    return 900 * Math.sin(0.21 * s + 0.05 * il) * Math.cos(0.13 * xl + 0.02 * s)
      + 37 * Math.sin(il * 1.7 + xl * 0.9 + s * 2.3) + (il === 9 && xl === 9 && s === 30 ? 50000 : 0);
  };
  const fix = makeSegy({ ...shape, amp });
  const scan = scanOf(shape);
  let v4;
  let v1;
  beforeAll(async () => {
    v4 = await runV4(fix, scan, { brickSize: B, levels: 3, ...extra });
    v1 = await runV1(fix, scan, B);
  });

  test('the k-group split is exercised as intended', () => {
    if (extra.memoryBudgetBytes) expect(v4.result.passesPerBand).toBeGreaterThanOrEqual(3);
    else expect(v4.result.passesPerBand).toBe(1);
  });

  test('every float32 brick decodes bit-identical to the v1 brick', async () => {
    expect(v1.size).toBe(v4.result.brickGrid.ni * v4.result.brickGrid.nj * v4.result.brickGrid.nk);
    for (const [key, data] of v1) {
      const [i, j, k] = key.split('-').map(Number);
      // eslint-disable-next-line no-await-in-loop
      const dec = await decodeF32Brick(v4.store.get(f32BrickRelPath(i, j, k)), ZLIB);
      expect(bits(dec)).toEqual(bits(data));
    }
  });

  test('display level 0 and levels 1..3 match the brute-force means, quantised', async () => {
    const dense = denseFromSegy(fix, shape);
    expect(await checkDisplayLevels(v4.store, dense, shape, v4.result, B)).toEqual([0, 0, 0, 0]);
    expect(v4.result.bricks.display.bricks)
      .toBe(v4.result.display.levels.reduce((s, l) => s + l.grid[0] * l.grid[1] * l.grid[2], 0));
  });

  test('the exact histogram counts every live sample; percentiles land within a bin', () => {
    const dense = denseFromSegy(fix, shape);
    const abs = [];
    for (const v of dense) if (Math.abs(v) < 1e29) abs.push(Math.abs(v));
    abs.sort((a, b) => a - b);
    const h = v4.result.display.histogram;
    expect(h.live).toBe(abs.length);
    expect(h.counts.reduce((s, c) => s + c, 0) + h.overflow).toBe(abs.length);
    expect(h.max_abs).toBe(abs[abs.length - 1]);
    const width = h.max / h.bins;
    for (const [p, got] of Object.entries(v4.result.display.percentiles)) {
      const exact = abs[Math.max(0, Math.ceil((Number(p) / 100) * abs.length) - 1)];
      expect(Math.abs(got - exact)).toBeLessThanOrEqual(width + 1e-6);
    }
    expect(v4.result.stats.live_samples).toBe(abs.length);
    let refMax = -Infinity;
    for (const v of dense) if (Math.abs(v) < 1e29 && v > refMax) refMax = v;
    expect(v4.result.stats.max).toBe(refMax);
  });

  test('the clip is the sampled nearest-rank P99.9 and is deterministic', async () => {
    const grid = gridFromScan(scan);
    const a = await sampleAmplitudeClip(bufferReader(fix.buffer), grid);
    const b = await sampleAmplitudeClip(bufferReader(fix.buffer), grid);
    expect(a).toEqual(b);
    expect(v4.result.display.clip).toBe(a.clip);
    expect(v4.result.display.clipPercentile).toBe(99.9);
    expect(a.traces).toBe(shape.nIl * shape.nXl);         // small file: every trace
  });

  test('negative controls: the gates above can fail', async () => {
    const dense = denseFromSegy(fix, shape);
    // 1. a picked (not averaged) reference disagrees on every coarse level
    const picked = await checkDisplayLevels(v4.store, dense, shape, v4.result, B, { down: refPick });
    expect(picked[0]).toBe(0);
    for (let L = 1; L <= 3; L++) expect(picked[L]).toBeGreaterThan(0);
    // 2. one wrong display code in one stored brick is caught, exactly once
    const key = displayBrickRelPath(1, 0, 0, 0);
    const good = v4.store.get(key);
    const codes = await decodeU8Brick(good, ZLIB);
    codes[5] = codes[5] === 200 ? 201 : 200;
    v4.store.set(key, await encodeU8Brick(codes, ZLIB));
    try {
      expect(await checkDisplayLevels(v4.store, dense, shape, v4.result, B)).toEqual([0, 1, 0, 0]);
    } finally {
      v4.store.set(key, good);
    }
    // 3. one flipped mantissa bit in a float32 brick fails the bit compare
    const f = await decodeF32Brick(v4.store.get(f32BrickRelPath(0, 0, 0)), ZLIB);
    const flipped = bits(f).slice();
    flipped[100] ^= 1;
    expect(flipped).not.toEqual(bits(v1.get('0-0-0')));
    expect(bits(f)).toEqual(bits(v1.get('0-0-0')));
  });
});

describe('lattice addressing (dead cells, crossline-sorted files)', () => {
  const shape = { nIl: 20, nXl: 18, ns: 40, format: 5 };
  const skip = (i, x) => (i + 2 * x) % 7 === 0;

  test('a crossline-sorted file with holes converts through its lattice; holes are null', async () => {
    const full = makeSegy(shape);
    const holey = makeSegy({ ...shape, sort: 'crossline', skip });
    const { result, store } = await runV4(holey, scanOf(shape, holey.traces), {
      brickSize: 8, levels: 3, lattice: holey.lattice, clip: 500,
    });
    expect(result.traceCount).toBe(holey.traces);
    expect(result.deadTraces).toBe(shape.nIl * shape.nXl - holey.traces);
    const ref = denseFromSegy(full, shape);
    for (let i = 0; i < shape.nIl; i++) {
      for (let x = 0; x < shape.nXl; x++) {
        if (skip(i, x)) for (let s = 0; s < shape.ns; s++) ref[(i * shape.nXl + x) * shape.ns + s] = NULL_F32;
      }
    }
    for (let bi = 0; bi < 3; bi++) {
      for (let bj = 0; bj < 3; bj++) {
        for (let bk = 0; bk < 5; bk++) {
          // eslint-disable-next-line no-await-in-loop
          const f = await decodeF32Brick(store.get(f32BrickRelPath(bi, bj, bk)), ZLIB);
          for (let li = 0; li < 8; li++) {
            for (let lj = 0; lj < 8; lj++) {
              for (let lk = 0; lk < 8; lk++) {
                const gi = bi * 8 + li; const gj = bj * 8 + lj; const gk = bk * 8 + lk;
                const want = gi < shape.nIl && gj < shape.nXl && gk < shape.ns
                  ? ref[(gi * shape.nXl + gj) * shape.ns + gk] : NULL_F32;
                if (!Object.is(f[(li * 8 + lj) * 8 + lk], want)) {
                  throw new Error(`mismatch at ${gi},${gj},${gk}`);
                }
              }
            }
          }
        }
      }
    }
    expect(await checkDisplayLevels(store, ref, shape, result, 8)).toEqual([0, 0, 0, 0]);
  });

  test('a header that disagrees with the grid stops the conversion with both positions named', async () => {
    const fix = makeSegy({ ...shape, amp: () => 1 });
    new DataView(fix.buffer).setInt32(3600 + 25 * fix.traceBytes + 192, 999, false);
    await expect(runV4(fix, scanOf(shape), { brickSize: 8, levels: 3, clip: 1 }))
      .rejects.toThrow(/Trace 25 has \(il 101, xl 999\) where the survey grid predicted \(il 101, xl 207\)/);
  });

  test('irregular files without a lattice are refused up front', () => {
    expect(() => gridFromScan(scanOf(shape, 300))).toThrow(/not regular/);
    expect(() => gridFromScan({ ...scanOf(shape), inlineSorted: false })).toThrow(/trace index/);
  });
});

describe('failure and control', () => {
  const shape = { nIl: 20, nXl: 10, ns: 40 };
  const fix = makeSegy(shape);

  test('cancellation stops the pass', async () => {
    await expect(runV4(fix, scanOf(shape), { brickSize: 8, isCancelled: () => true }))
      .rejects.toThrow('Conversion cancelled.');
  });

  test('a failing sink fails the conversion', async () => {
    const grid = gridFromScan(scanOf(shape));
    await expect(transcodeV4(bufferReader(fix.buffer), grid, {
      brickSize: 8,
      codec: ZLIB,
      encodeConcurrency: 3,
      onBrick: async () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
  });

  test('an all-zero volume quantises to 128 with clip 1', async () => {
    const zero = makeSegy({ ...shape, amp: () => 0 });
    const { result, store } = await runV4(zero, scanOf(shape), { brickSize: 8, levels: 1 });
    expect(result.display.clip).toBe(1);
    const codes = await decodeU8Brick(store.get(displayBrickRelPath(0, 0, 0, 0)), ZLIB);
    expect(codes[0]).toBe(U8_ZERO);
    expect(percentileFromHistogram(makeAbsHistogram(1), 50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('manifest v4', () => {
  const shape = { nIl: 20, nXl: 10, ns: 40 };
  let manifest;
  beforeAll(async () => {
    const fix = makeSegy(shape);
    const scan = { ...scanOf(shape), dtUs: 4000, coordScalar: -100, corners: { first: null, last: null }, affine: null };
    const { result } = await runV4(fix, scan, { brickSize: 8 });
    manifest = buildManifestV4({
      volumeId: 'vol', name: 'Test', scan, transcode: result, sourceFileName: 'a.sgy', sourceFileSize: fix.buffer.byteLength,
    });
  });

  test('is additive over v1 and names both copies', () => {
    expect(isV4Manifest(manifest)).toBe(true);
    expect(manifest.manifest_version).toBe(4);
    expect(MANIFEST_READ_MAX).toBe(4);
    expect(manifest.brick).toMatchObject({ size: 8, grid: [3, 2, 5], dtype: 'float32le', path_pattern: 'v4/f/{i}-{j}-{k}.f32z' });
    expect(manifest.display).toMatchObject({
      codec: 'u8', compression: 'deflate-raw', complete: false, clip_percentile: 99.9,
      quantisation: { zero: 128, steps: 127, null: 0 },
    });
    expect(manifest.display.levels[0]).toEqual({
      level: 0, dims: [20, 10, 40], bricks: [3, 2, 5], count: 30, path_pattern: 'v4/d0/{i}-{j}-{k}.u8z',
    });
    expect(manifest.display.histogram.counts).toHaveLength(1024);
    expect(Object.keys(manifest.display.percentiles)).toContain('99.9');
    expect(manifest.f32).toEqual({
      codec: 'f32-shuffle-deflate', compression: 'deflate-raw', path_pattern: 'v4/f/{i}-{j}-{k}.f32z', complete: false,
    });
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);   // plain JSON
    const done = withV4Complete(manifest, { display: true });
    expect(done.display.complete).toBe(true);
    expect(done.f32.complete).toBe(false);
    expect(manifest.display.complete).toBe(false);
  });

  test('passes the gate; an unknown v4 codec is refused by name', () => {
    expect(() => assertManifestSupported(manifest)).not.toThrow();
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.f32.codec = 'f32-zstd';
    expect(() => assertManifestSupported(bad)).toThrow(UnsupportedManifestError);
    const bad2 = JSON.parse(JSON.stringify(manifest));
    bad2.display.compression = 'brotli';
    expect(() => assertManifestSupported(bad2)).toThrow(/display copy/);
    expect(() => assertManifestSupported({ ...manifest, manifest_version: 5 })).toThrow(/version 5/);
  });

  test('a derived volume from a v4 parent writes raw float32 under bricks/', () => {
    const d = buildDerivedManifest({
      volumeId: 'd', name: 'rms', parentManifest: manifest, attribute: { name: 'rms' },
      job: { brickGrid: { ni: 3, nj: 2, nk: 5, brickSize: 8 }, stats: {}, traceCount: 200 },
    });
    expect(d.manifest_version).toBe(2);
    expect(d.brick.path_pattern).toBe('bricks/{i}-{j}-{k}.f32');
    expect(d.display).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('v4 stores read through the v1 brick names (compat fetcher)', () => {
  const shape = { nIl: 20, nXl: 12, ns: 40 };
  const B = 8;
  const amp = (il, xl, s) => {
    if (il === 2 && xl === 3) return NULL_VALUE;                 // a dead trace
    return 700 * Math.sin(0.3 * s + 0.1 * il) + (s === 7 && il === 4 && xl === 5 ? 9000 : 0);
  };
  let fix; let v4; let v1; let manifest;
  beforeAll(async () => {
    fix = makeSegy({ ...shape, amp });
    const scan = { ...scanOf(shape), dtUs: 4000, coordScalar: -100, corners: {}, affine: null };
    v4 = await runV4(fix, scan, { brickSize: B, levels: 2 });
    v1 = await runV1(fix, scan, B);
    manifest = buildManifestV4({
      volumeId: 'vol', name: 'T', scan, transcode: v4.result, sourceFileName: 'a.sgy', sourceFileSize: 1,
    });
  });
  const requested = [];
  const storeFetcher = (store) => async (path) => {
    requested.push(path);
    const rel = path.replace(/^u\/vol\//, '');
    const bytes = store.get(rel);
    if (!bytes) throw new Error(`missing ${path}`);
    return bytes.slice().buffer;
  };

  test('non-v4 manifests get the fetcher back untouched', () => {
    const f = async () => new ArrayBuffer(0);
    expect(v4BrickFetcher(f, { manifest_version: 1 })).toBe(f);
    expect(v4BrickPrecision({ manifest_version: 2 })).toBeNull();
  });

  test('f32 complete: every brick decodes bit-identical to the v1 brick', async () => {
    const done = withV4Complete(manifest, { display: true, f32: true });
    expect(v4BrickPrecision(done)).toBe('f32');
    const fetch = v4BrickFetcher(storeFetcher(v4.store), done, { inflate: ZLIB.inflate });
    for (const [key, data] of v1) {
      // eslint-disable-next-line no-await-in-loop
      const buf = await fetch(`u/vol/bricks/${key}.f32`);
      expect(bits(new Float32Array(buf))).toEqual(bits(data));
    }
    expect(requested.at(-1)).toMatch(/^u\/vol\/v4\/f\/\d+-\d+-\d+\.f32z$/);
  });

  test('display only: level 0 dequantised within half a code step, nulls kept, clip clamps', async () => {
    const shown = withV4Complete(manifest, { display: true });
    expect(v4BrickPrecision(shown)).toBe('display');
    const fetch = v4BrickFetcher(storeFetcher(v4.store), shown, { inflate: ZLIB.inflate });
    const { clip } = manifest.display;
    let worst = 0; let nulls = 0; let clamped = 0;
    for (const [key, data] of v1) {
      // eslint-disable-next-line no-await-in-loop
      const got = new Float32Array(await fetch(`u/vol/bricks/${key}.f32`));
      for (let n = 0; n < data.length; n++) {
        const want = data[n];
        if (!(Math.abs(want) < 1e29)) { expect(got[n]).toBe(NULL_F32); nulls += 1; continue; }
        if (Math.abs(want) > clip) { expect(Math.abs(got[n])).toBeCloseTo(clip, 3); clamped += 1; continue; }
        worst = Math.max(worst, Math.abs(got[n] - want));
      }
    }
    expect(requested.at(-1)).toMatch(/\/v4\/d0\/\d+-\d+-\d+\.u8z$/);
    expect(worst).toBeLessThanOrEqual(clip / 254 + 1e-3);
    expect(worst).toBeGreaterThan(0);               // it IS quantised
    expect(nulls).toBeGreaterThan(0);
    expect(clamped).toBeGreaterThan(0);
  });

  test('other paths pass through; a store without deflate support refuses by name', async () => {
    const fetch = v4BrickFetcher(async (p) => { requested.push(p); return new ArrayBuffer(4); }, manifest,
      { inflate: ZLIB.inflate });
    await fetch('u/vol/manifest.json');
    expect(requested.at(-1)).toBe('u/vol/manifest.json');
    if (!hasNativeDeflateRaw()) {
      const noInflate = v4BrickFetcher(async () => new ArrayBuffer(4), manifest);
      await expect(noInflate('u/vol/bricks/0-0-0.f32')).rejects.toThrow(/cannot read compressed seismic bricks/);
    }
  });
});

// ---------------------------------------------------------------------------
// Soak: the engine streams the file and holds to its memory plan. Every
// read is synthesised and nothing is held but the engine's own buffers;
// encoding is stubbed so the test times the pass. Two tiers, like the
// Suite's ingest soak: an always-on reduced shape (two bands, the second
// ragged, a budget that forces two k-groups) that gates what the engine
// reads, and the tester's shape (876 crosslines x 1,750 samples, 320 MiB)
// with SEISMOLORD_SOAK=1, which measures memory. The tester tier takes
// about 15 s under plain Node and 150 to 190 s under jest's module
// sandbox, which is why it is opt-in.
async function soak(shape, memoryBudgetBytes) {
  let peak = 0;
  const sample = () => {
    const m = process.memoryUsage().arrayBuffers;
    if (m > peak) peak = m;
  };
  if (global.gc) global.gc();
  const base = process.memoryUsage().arrayBuffers;
  const reads = { bytes: 0, maxLength: 0, count: 0 };
  const reader = virtualSegyReader({
    ...shape,
    onRead: (length) => {
      reads.bytes += length;
      reads.count += 1;
      if (length > reads.maxLength) reads.maxLength = length;
      sample();
    },
  });
  const scan = {
    ns: shape.ns, traceBytes: reader.traceBytes, formatCode: 5, totalTraces: shape.nIl * shape.nXl,
    mapping: { ilByte: 189, xlByte: 193 },
    il: { min: 42, step: 1, count: shape.nIl }, xl: { min: 14, step: 1, count: shape.nXl },
  };
  const counts = { f32: 0, display: 0 };
  const t0 = Date.now();
  const result = await transcodeV4(reader, gridFromScan(scan), {
    codec: { compression: NO_COMPRESSION },
    clip: 1500,
    memoryBudgetBytes,
    onBrick: (b) => { counts[b.kind] += 1; sample(); },
    onProgress: sample,
  });
  return { result, counts, reads, traceBytes: reader.traceBytes, peak: peak - base, seconds: (Date.now() - t0) / 1000 };
}

const expectedDisplayBricks = (plan) => plan.levels.reduce((s, l) => s + l.bricks, 0);

describe('soak: a band streams inside the memory budget', () => {
  jest.setTimeout(240000);

  test('always on: 72 x 300 x 448 streams in 4 MiB windows, the file read exactly twice', async () => {
    // Deterministic: what the engine asks the reader for. Memory is
    // measured only in the tester tier below, where the volume (4.4 GB)
    // dwarfs the budget and the measurement means something; here the
    // whole volume is smaller than the budget, and process-wide
    // arrayBuffers under a parallel jest run is not a stable signal.
    const shape = { nIl: 72, nXl: 300, ns: 448 };
    const budget = 44 * 1024 ** 2;
    const { result, counts, reads, traceBytes } = await soak(shape, budget);
    expect(result.passesPerBand).toBe(2);
    expect(counts.f32).toBe(2 * 5 * 7);
    expect(counts.display).toBe(expectedDisplayBricks(result.plan));
    expect(result.plan.estimatedPeakBytes).toBeLessThanOrEqual(budget);
    expect(reads.maxLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    // the clip is given, so every read is the transcode: two passes of
    // every trace, nothing more
    expect(reads.bytes).toBe(2 * shape.nIl * shape.nXl * traceBytes);
  });

  (process.env.SEISMOLORD_SOAK ? test : test.skip)(
    'SEISMOLORD_SOAK=1: the tester shape (72 x 876 x 1,750) inside 320 MiB, two even k-groups', async () => {
      const { result, counts, peak, seconds } = await soak({ nIl: 72, nXl: 876, ns: 1750 }, V4_DEFAULT_BUDGET_BYTES);
      expect(result.passesPerBand).toBe(2);
      expect(counts.f32).toBe(2 * 14 * 28);
      expect(counts.display).toBe(2 * 14 * 28 + 1 * 7 * 14 + 1 * 4 * 7 + 1 * 2 * 4);
      // eslint-disable-next-line no-console
      console.log(`v4 soak (tester): ${seconds.toFixed(1)} s, peak arrayBuffers +${(peak / 1024 ** 2).toFixed(0)} MiB, `
        + `plan ${(result.plan.estimatedPeakBytes / 1024 ** 2).toFixed(0)} MiB`);
      expect(peak).toBeLessThanOrEqual(1.35 * V4_DEFAULT_BUDGET_BYTES);
      expect(result.plan.estimatedPeakBytes).toBeLessThanOrEqual(V4_DEFAULT_BUDGET_BYTES);
    });
});
