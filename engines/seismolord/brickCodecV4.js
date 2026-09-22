// Manifest v4 brick codecs (large-survey plan, docs/scope/Seismolord-
// LARGE-SURVEY-PLAN.md in the Suite, sections 3 and 4).
//
// Two copies of every volume:
//
//  - Display copy, codec 'u8'. Symmetric quantisation at a wide clip:
//      q = 128 + sign(a) * round(min(|a| / clip, 1) * 127)   (live sample)
//      q = 0                                                  (null)
//    so 1..255 carry amplitude, 128 is zero and 0 is reserved for null.
//    Rounding is half away from zero, which keeps the code table
//    symmetric (q(-a) = 256 - q(a)) so a polarity flip in the shader is
//    exact. Decode: a = (q - 128) / 127 * clip, 0 -> NULL_VALUE. The
//    user's percentile clip applies in the shader within the stored
//    range (playbook: display gain is shader only).
//
//  - Computation copy, codec 'f32-shuffle-deflate'. The float32 brick's
//    little-endian bytes are byte-shuffled (all byte 0s, then all byte
//    1s, ...), then compressed. Decode is exact: the float32 bits that
//    come back are the bits the v1 transcoder would have stored.
//
// Compression is 'deflate-raw' (RFC 1951, what CompressionStream
// ('deflate-raw') writes) or 'none'. The compressor is injected: the
// default is the platform CompressionStream when it supports
// 'deflate-raw' (Chrome 103+, Firefox 113+, Safari 16.4+, Node 21.2+);
// when it does not, the default is 'none' and the manifest records it,
// so a volume is always decodable by what wrote it. Node 18 (jest) has
// CompressionStream without 'deflate-raw'; tests inject node:zlib
// deflateRawSync/inflateRawSync, which produce and read the same format.

import { NULL_VALUE } from './manifest';

export const DISPLAY_CODEC = 'u8';
export const F32_CODEC = 'f32-shuffle-deflate';
export const DEFLATE_RAW = 'deflate-raw';
export const NO_COMPRESSION = 'none';
export const COMPRESSIONS = Object.freeze([DEFLATE_RAW, NO_COMPRESSION]);

/** u8 code reserved for null (dead trace, padding, 1.0E+30). */
export const U8_NULL = 0;
/** u8 code of amplitude zero. */
export const U8_ZERO = 128;
/** Codes either side of zero: 1..127 negative, 129..255 positive. */
export const U8_STEPS = 127;

const NULL_F32 = Math.fround(NULL_VALUE);

/** Display/statistics liveness: finite and below the null threshold.
 *  NaN, infinities and the 1.0E+30 null never enter a statistic or a
 *  display code (playbook: nulls never enter sums). */
export const isLiveAmplitude = (v) => Math.abs(v) < 1.0e29;

/**
 * A usable clip: the requested one when it is a positive finite number,
 * else 1 (an all-zero volume quantises to 128 everywhere either way).
 * @param {number} clip
 */
export function safeClip(clip) {
  return Number.isFinite(clip) && clip > 0 ? clip : 1;
}

/**
 * Quantise one amplitude to the display code.
 * @param {number} v amplitude (float32)
 * @param {number} clip amplitude that maps to +-127 (safeClip applied)
 * @returns {number} 0..255
 */
export function quantizeU8(v, clip) {
  if (!isLiveAmplitude(v)) return U8_NULL;
  const c = safeClip(clip);
  const r = v / c;
  if (r >= 0) return U8_ZERO + Math.floor((r > 1 ? 1 : r) * U8_STEPS + 0.5);
  return U8_ZERO - Math.floor((r < -1 ? 1 : -r) * U8_STEPS + 0.5);
}

/**
 * Amplitude a display code stands for (the centre of its bin).
 * @param {number} q 0..255
 * @param {number} clip
 * @returns {number} NULL_F32 for code 0
 */
export function dequantizeU8(q, clip) {
  if (q === U8_NULL) return NULL_F32;
  return ((q - U8_ZERO) / U8_STEPS) * safeClip(clip);
}

/** Lookup table code -> float32 amplitude (index 0 = the float32 null). */
export function u8DecodeTable(clip) {
  const t = new Float32Array(256);
  for (let q = 0; q < 256; q++) t[q] = dequantizeU8(q, clip);
  return t;
}

/**
 * Display codes back to float32 amplitudes (nulls to 1.0E+30).
 * @param {Uint8Array} codes @param {number} clip
 * @returns {Float32Array}
 */
export function dequantizeBrick(codes, clip) {
  const t = u8DecodeTable(clip);
  const out = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i++) out[i] = t[codes[i]];
  return out;
}

/**
 * Byte-shuffle 4-byte words: out[b * n + i] = in[i * 4 + b].
 * @param {Uint8Array} src length multiple of 4
 * @param {Uint8Array} [dst]
 */
export function shuffle4(src, dst = new Uint8Array(src.length)) {
  const n = src.length >>> 2;
  const n2 = n * 2;
  const n3 = n * 3;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    dst[i] = src[p];
    dst[n + i] = src[p + 1];
    dst[n2 + i] = src[p + 2];
    dst[n3 + i] = src[p + 3];
  }
  return dst;
}

/** Inverse of shuffle4. */
export function unshuffle4(src, dst = new Uint8Array(src.length)) {
  const n = src.length >>> 2;
  const n2 = n * 2;
  const n3 = n * 3;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    dst[p] = src[i];
    dst[p + 1] = src[n + i];
    dst[p + 2] = src[n2 + i];
    dst[p + 3] = src[n3 + i];
  }
  return dst;
}

let nativeSupport = null;

/** True when the platform CompressionStream and DecompressionStream
 *  accept 'deflate-raw'. Probed once. */
export function hasNativeDeflateRaw() {
  if (nativeSupport !== null) return nativeSupport;
  try {
    // eslint-disable-next-line no-new
    new CompressionStream(DEFLATE_RAW);
    // eslint-disable-next-line no-new
    new DecompressionStream(DEFLATE_RAW);
    nativeSupport = typeof Response === 'function' && typeof Blob === 'function';
  } catch {
    nativeSupport = false;
  }
  return nativeSupport;
}

async function pipeThrough(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Native deflate-raw (CompressionStream). */
export const nativeDeflateRaw = (bytes) => pipeThrough(bytes, new CompressionStream(DEFLATE_RAW));
/** Native inflate-raw (DecompressionStream). */
export const nativeInflateRaw = (bytes) => pipeThrough(bytes, new DecompressionStream(DEFLATE_RAW));

/**
 * Pick the compression a writer uses and the functions that implement
 * it. An injected deflate wins (tests, a compression worker pool);
 * otherwise the platform stream when it supports deflate-raw; else none.
 *
 * @param {{compression?: string, deflate?: Function, inflate?: Function}} [opts]
 * @returns {{compression: string, deflate: ?Function, inflate: ?Function}}
 */
export function resolveCodec(opts = {}) {
  const { compression, deflate, inflate } = opts;
  if (compression === NO_COMPRESSION) return { compression: NO_COMPRESSION, deflate: null, inflate: null };
  if (deflate || inflate) {
    return { compression: DEFLATE_RAW, deflate: deflate || null, inflate: inflate || null };
  }
  if (hasNativeDeflateRaw()) {
    return { compression: DEFLATE_RAW, deflate: nativeDeflateRaw, inflate: nativeInflateRaw };
  }
  if (compression === DEFLATE_RAW) {
    throw new Error('This browser cannot compress deflate-raw; update the browser to convert or open this volume.');
  }
  return { compression: NO_COMPRESSION, deflate: null, inflate: null };
}

const asBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

/**
 * Encode one float32 brick (f32-shuffle-deflate).
 * @param {Float32Array} data
 * @param {{compression: string, deflate?: Function}} codec from resolveCodec
 * @param {Uint8Array} [scratch] reusable shuffle buffer (data.byteLength)
 * @returns {Promise<Uint8Array>} a fresh buffer the caller owns
 */
export async function encodeF32Brick(data, codec, scratch) {
  const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (codec.compression === NO_COMPRESSION) return shuffle4(src);
  const shuffled = shuffle4(src, scratch && scratch.length === src.length ? scratch : undefined);
  return asBytes(await codec.deflate(shuffled));
}

/**
 * Decode one f32-shuffle-deflate payload back to float32 (exact).
 * @param {ArrayBuffer|Uint8Array} payload
 * @param {{compression: string, inflate?: Function}} codec
 * @returns {Promise<Float32Array>}
 */
export async function decodeF32Brick(payload, codec) {
  const bytes = codec.compression === NO_COMPRESSION
    ? asBytes(payload) : asBytes(await codec.inflate(asBytes(payload)));
  if (bytes.length % 4 !== 0) throw new Error(`A float32 brick decoded to ${bytes.length} bytes, which is not whole samples.`);
  const out = new Uint8Array(bytes.length);
  unshuffle4(bytes, out);
  return new Float32Array(out.buffer);
}

/**
 * Encode one u8 display brick.
 * @param {Uint8Array} codes
 * @param {{compression: string, deflate?: Function}} codec
 * @returns {Promise<Uint8Array>}
 */
export async function encodeU8Brick(codes, codec) {
  if (codec.compression === NO_COMPRESSION) return codes.slice();
  return asBytes(await codec.deflate(codes));
}

/**
 * Decode one u8 display brick to its codes.
 * @param {ArrayBuffer|Uint8Array} payload
 * @param {{compression: string, inflate?: Function}} codec
 * @returns {Promise<Uint8Array>}
 */
export async function decodeU8Brick(payload, codec) {
  if (codec.compression === NO_COMPRESSION) return asBytes(payload).slice();
  return asBytes(await codec.inflate(asBytes(payload)));
}

// ---------------------------------------------------------------------------
// v4 stores read through the v1 path names (the compat fetcher).
//
// Every float32 consumer (slice assembly, BrickCache, horizon tracking,
// attribute jobs) addresses bricks as `{volume}/bricks/{i}-{j}-{k}.f32`
// and expects raw float32 bytes back. For a v4 store this wrapper maps
// that name to the v4 object and decodes it, so those consumers read a
// v4 volume unchanged:
//   - f32.complete: `v4/f/{i}-{j}-{k}.f32z`, decoded exactly (the same
//     bits the v1 transcoder would have stored);
//   - otherwise (display copy only, status 'display_ready'): display
//     level 0, `v4/d0/{i}-{j}-{k}.u8z`, dequantised to the centre of each
//     code's bin (error at most clip / 254 inside the clip; code 0 is the
//     1.0E+30 null). v4BrickPrecision says which one a volume serves.
// Non-v4 manifests get the fetcher back untouched.

const V1_BRICK_NAME = /^(.*)\/bricks\/(\d+)-(\d+)-(\d+)\.f32$/;

/** Which copy a v4 volume's float32 reads come from: 'f32' (exact),
 *  'display' (8-bit display copy, dequantised) or null for non-v4. */
export function v4BrickPrecision(manifest) {
  if ((manifest?.manifest_version ?? 1) !== 4) return null;
  return manifest?.f32?.complete ? 'f32' : 'display';
}

/**
 * @param {(path: string, signal?: AbortSignal) => Promise<ArrayBuffer>} fetcher
 * @param {Object} manifest the volume's manifest
 * @param {{inflate?: Function}} [opts] injected inflate (tests, Node);
 *   default is the platform DecompressionStream('deflate-raw')
 * @returns {(path: string, signal?: AbortSignal) => Promise<ArrayBuffer>}
 */
export function v4BrickFetcher(fetcher, manifest, opts = {}) {
  const precision = v4BrickPrecision(manifest);
  if (!precision) return fetcher;
  const copy = precision === 'f32' ? manifest.f32 : manifest.display;
  let codec = null;
  const codecOf = () => {
    if (codec) return codec;
    if (copy.compression === NO_COMPRESSION) codec = { compression: NO_COMPRESSION };
    else if (opts.inflate) codec = { compression: DEFLATE_RAW, inflate: opts.inflate };
    else if (hasNativeDeflateRaw()) codec = { compression: DEFLATE_RAW, inflate: nativeInflateRaw };
    else throw new Error('This browser cannot read compressed seismic bricks; update the browser to open this volume.');
    return codec;
  };
  const clip = manifest.display?.clip;
  return async (path, signal) => {
    const m = V1_BRICK_NAME.exec(path);
    if (!m) return fetcher(path, signal);
    const [, base, i, j, k] = m;
    if (precision === 'f32') {
      const payload = await fetcher(`${base}/v4/f/${i}-${j}-${k}.f32z`, signal);
      const f = await decodeF32Brick(payload, codecOf());
      return f.buffer;
    }
    const payload = await fetcher(`${base}/v4/d0/${i}-${j}-${k}.u8z`, signal);
    const codes = await decodeU8Brick(payload, codecOf());
    return dequantizeBrick(codes, clip).buffer;
  };
}
