// SEG-Y byte order and sample format adapter (Seismolord U2-009).
//
// The Seismolord readers (scan, ingest, v4 conversion, local view, 2D)
// read the classic layout: big-endian headers, 4-byte samples. Rather than
// teach every reader every format, a file in another byte order or sample
// format is PRESENTED to them in that layout: headers byte-swapped field
// by field (the SEG-Y rev 1 field widths), samples decoded by
// decodeSamples (validated against segyio) and written as big-endian IEEE
// float (format 5). The file on disk is never changed. Pure functions; the
// Suite's import door wraps a reader around them.

import {
  TEXT_HEADER_BYTES, BIN_HEADER_BYTES, TRACE_HEADER_BYTES, decodeSamples, bytesPerSample,
} from './segyDecode';

/**
 * Trace header fields as [first byte (1-based), width] per SEG-Y rev 1
 * (bytes 233-240 unassigned, swapped as 4-byte words, which is what rev 2
 * extension fields use there).
 */
export const TRACE_HEADER_FIELDS = Object.freeze([
  [1, 4], [5, 4], [9, 4], [13, 4], [17, 4], [21, 4], [25, 4],
  [29, 2], [31, 2], [33, 2], [35, 2],
  [37, 4], [41, 4], [45, 4], [49, 4], [53, 4], [57, 4], [61, 4], [65, 4],
  [69, 2], [71, 2],
  [73, 4], [77, 4], [81, 4], [85, 4],
  ...Array.from({ length: 46 }, (_, k) => [89 + 2 * k, 2]),
  [181, 4], [185, 4], [189, 4], [193, 4], [197, 4],
  [201, 2], [203, 2], [205, 4], [209, 2], [211, 2], [213, 2], [215, 2], [217, 2],
  [219, 4], [223, 2], [225, 2], [227, 2], [229, 2], [231, 2],
  [233, 4], [237, 4],
]);

/** Binary header fields as [first byte within the 400-byte header (1-based), width]. */
export const BINARY_HEADER_FIELDS = Object.freeze([
  [1, 4], [5, 4], [9, 4],
  ...Array.from({ length: 24 }, (_, k) => [13 + 2 * k, 2]),
  // rev 2 (bytes 3261-3300): extended trace, auxiliary and sample counts,
  // the sample interval as doubles, original sample count, ensemble fold,
  // the byte-order word
  [61, 4], [65, 4], [69, 4], [73, 8], [81, 8], [89, 4], [93, 4], [97, 4],
  // bytes 3501-3532: revision (two single bytes in rev 2), fixed length,
  // extended textual count, additional headers, time basis, trace count,
  // first trace offset, trailer count
  [301, 1], [302, 1], [303, 2], [305, 2], [307, 4], [311, 2], [313, 8], [321, 8], [329, 4],
]);

function swapFields(src, dst, fields) {
  for (const [pos, w] of fields) {
    const o = pos - 1;
    for (let b = 0; b < w; b++) dst[o + b] = src[o + w - 1 - b];
  }
}

/** Byte order of a file from its binary header (the 400 bytes). */
export function detectByteOrder(binView, knownFormats = null) {
  const valid = (c) => (knownFormats ? Boolean(knownFormats[c]) : (c >= 1 && c <= 16));
  const word = binView.getUint32(96, false);          // bytes 3297-3300 (rev 2)
  if (word === 0x01020304) return 'big';
  if (word === 0x04030201) return 'little';
  const be = binView.getInt16(24, false);
  const le = binView.getInt16(24, true);
  if (!valid(be) && valid(le)) return 'little';
  return 'big';
}

/**
 * The 400-byte binary header in big-endian with format 5 (IEEE float),
 * what the readers expect for a transcoded file.
 * @param {ArrayBuffer} bin 400 bytes
 * @param {boolean} littleEndian
 * @returns {ArrayBuffer}
 */
export function binaryHeaderToIeeeBe(bin, littleEndian) {
  const src = new Uint8Array(bin);
  const dst = littleEndian ? new Uint8Array(BIN_HEADER_BYTES) : Uint8Array.from(src);
  if (littleEndian) {
    dst.set(src);
    swapFields(src, dst, BINARY_HEADER_FIELDS);
  }
  const dv = new DataView(dst.buffer);
  dv.setInt16(24, 5, false);                // format: IEEE float
  dv.setUint32(96, 0x01020304, false);      // byte-order word: big-endian
  return dst.buffer;
}

/**
 * Transcode whole traces to the classic layout.
 * @param {ArrayBuffer} src consecutive source traces
 * @param {{ns: number, formatCode: number, littleEndian: boolean}} p
 * @returns {ArrayBuffer} the same traces as big-endian headers + IEEE float samples
 */
export function transcodeTraces(src, { ns, formatCode, littleEndian }) {
  const bps = bytesPerSample(formatCode);
  if (!bps) throw new Error(`Unsupported SEG-Y sample format code: ${formatCode}`);
  const srcTrace = TRACE_HEADER_BYTES + ns * bps;
  const dstTrace = TRACE_HEADER_BYTES + ns * 4;
  if (src.byteLength % srcTrace !== 0) throw new Error(`Transcode needs whole traces (${srcTrace} bytes each), got ${src.byteLength}.`);
  const n = src.byteLength / srcTrace;
  const out = new ArrayBuffer(n * dstTrace);
  const s8 = new Uint8Array(src);
  const d8 = new Uint8Array(out);
  const sv = new DataView(src);
  const dv = new DataView(out);
  const samples = new Float32Array(ns);
  for (let t = 0; t < n; t++) {
    const so = t * srcTrace;
    const doff = t * dstTrace;
    const hs = s8.subarray(so, so + TRACE_HEADER_BYTES);
    const hd = d8.subarray(doff, doff + TRACE_HEADER_BYTES);
    if (littleEndian) swapFields(hs, hd, TRACE_HEADER_FIELDS);
    else hd.set(hs);
    decodeSamples(sv, so + TRACE_HEADER_BYTES, ns, formatCode, samples, littleEndian);
    for (let i = 0; i < ns; i++) dv.setFloat32(doff + TRACE_HEADER_BYTES + i * 4, samples[i], false);
  }
  return out;
}

/** Bytes per trace before and after transcoding. */
export function traceSizes(ns, formatCode) {
  const bps = bytesPerSample(formatCode);
  return { src: TRACE_HEADER_BYTES + ns * (bps || 4), dst: TRACE_HEADER_BYTES + ns * 4 };
}

export const HEADER_BYTES = TEXT_HEADER_BYTES + BIN_HEADER_BYTES;
