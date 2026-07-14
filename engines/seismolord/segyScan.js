// Streaming SEG-Y header scan: textual header, binary header, and a
// windowed pass over trace headers that MEASURES the geometry under a
// caller-supplied byte mapping. The textual header is display-only —
// domain rule: it lies; trust measured geometry.

import {
  TEXT_HEADER_BYTES,
  BIN_HEADER_BYTES,
  TRACE_HEADER_BYTES,
  readBinaryHeader,
  readHeaderInt32,
  readHeaderInt16,
  applyCoordScalar,
} from './segyDecode';
import { makeAffineFit, affineFitAdd, solveAffineFit, cellSpacing } from './surveyGeometry';

export const DEFAULT_MAPPING = Object.freeze({
  ilByte: 189,
  xlByte: 193,
  xByte: 181,
  yByte: 185,
  scalarByte: 71,
});

/** Common alternative header layouts offered by the mapping UI. */
export const MAPPING_PRESETS = [
  { label: 'SEG-Y rev1 standard (189/193)', ilByte: 189, xlByte: 193 },
  { label: 'FieldRecord / CDP (9/21)', ilByte: 9, xlByte: 21 },
  { label: 'Source point / CDP (17/21)', ilByte: 17, xlByte: 21 },
  { label: 'Petrel legacy (5/21)', ilByte: 5, xlByte: 21 },
];

// EBCDIC (cp037) -> ASCII for the printable subset; everything else '.'
const EBCDIC_MAP = (() => {
  const m = new Array(256).fill('.');
  const put = (code, chars) => {
    for (let i = 0; i < chars.length; i++) m[code + i] = chars[i];
  };
  m[0x40] = ' ';
  put(0x4b, '.<(+|');
  m[0x50] = '&';
  put(0x5a, '!$*);^');
  put(0x60, '-/');
  put(0x6b, ',%_>?');
  put(0x7a, ':#@\'="');
  put(0x81, 'abcdefghi');
  put(0x91, 'jklmnopqr');
  put(0xa2, 'stuvwxyz');
  put(0xc1, 'ABCDEFGHI');
  put(0xd1, 'JKLMNOPQR');
  put(0xe2, 'STUVWXYZ');
  put(0xf0, '0123456789');
  return m;
})();

/**
 * Read the 3200-byte textual header as 40 ASCII lines (EBCDIC assumed;
 * if the header is already ASCII the pass-through heuristic keeps it).
 * @param {import('./reader').ByteReader} reader
 * @returns {Promise<string[]>}
 */
const assertSegySized = (reader) => {
  if (reader.size < TEXT_HEADER_BYTES + BIN_HEADER_BYTES) {
    throw new Error(
      `File is too small to be a SEG-Y (${reader.size} bytes; the textual + binary `
      + 'headers alone are 3600 bytes).');
  }
};

export async function readTextualHeader(reader) {
  assertSegySized(reader);
  const bytes = new Uint8Array(await reader.read(0, TEXT_HEADER_BYTES));
  // EBCDIC headers are padded with 0x40 (EBCDIC space); ASCII headers with
  // 0x20. The dominant pad byte is the most reliable dialect signal.
  let ebcdicSpaces = 0;
  let asciiSpaces = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x40) ebcdicSpaces += 1;
    else if (bytes[i] === 0x20) asciiSpaces += 1;
  }
  const isEbcdic = ebcdicSpaces >= asciiSpaces;
  const chars = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    chars[i] = isEbcdic
      ? EBCDIC_MAP[bytes[i]]
      : bytes[i] >= 0x20 && bytes[i] < 0x7f ? String.fromCharCode(bytes[i]) : '.';
  }
  const text = chars.join('');
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(text.slice(i * 80, i * 80 + 80).trimEnd());
  return lines;
}

const BYTES_PER_SAMPLE = { 1: 4, 5: 4 };

/**
 * Read the binary header and derive trace layout.
 * @param {import('./reader').ByteReader} reader
 */
export async function readFileHeaders(reader) {
  assertSegySized(reader);
  const view = new DataView(await reader.read(TEXT_HEADER_BYTES, BIN_HEADER_BYTES));
  const bin = readBinaryHeader(view);
  const bytesPerSample = BYTES_PER_SAMPLE[bin.formatCode];
  if (!bytesPerSample) {
    throw new Error(
      `Unsupported SEG-Y sample format code ${bin.formatCode} — Seismolord `
      + 'currently ingests IBM float (1) and IEEE float (5).');
  }
  if (bin.ns <= 0) throw new Error(`Invalid samples-per-trace in binary header: ${bin.ns}`);
  const traceBytes = TRACE_HEADER_BYTES + bin.ns * bytesPerSample;
  const dataBytes = reader.size - TEXT_HEADER_BYTES - BIN_HEADER_BYTES;
  const totalTraces = Math.floor(dataBytes / traceBytes);
  const trailing = dataBytes - totalTraces * traceBytes;
  return { ...bin, bytesPerSample, traceBytes, totalTraces, trailingBytes: trailing };
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * Measure survey geometry from trace headers under a byte mapping.
 *
 * Full scan when totalTraces <= opts.maxTraces, otherwise a sampled
 * preview (contiguous head + strided tail) marked `sampled: true` — the
 * transcoder re-validates every trace anyway.
 *
 * @param {import('./reader').ByteReader} reader
 * @param {Partial<typeof DEFAULT_MAPPING>} [mapping]
 * @param {{maxTraces?: number, chunkBytes?: number,
 *          onProgress?: (done: number, total: number) => void}} [opts]
 */
export async function scanGeometry(reader, mapping = {}, opts = {}) {
  const map = { ...DEFAULT_MAPPING, ...mapping };
  const { maxTraces = Infinity, chunkBytes = 4 * 1024 * 1024, onProgress } = opts;
  const header = await readFileHeaders(reader);
  const { traceBytes, totalTraces } = header;
  if (totalTraces <= 0) throw new Error('No traces found in file.');

  const warnings = [];
  if (header.trailingBytes !== 0) {
    warnings.push(`${header.trailingBytes} trailing bytes do not form a whole trace.`);
  }

  const sampled = totalTraces > maxTraces;
  /** @type {number[]} indices to inspect, always includes first and last */
  let indices;
  if (!sampled) {
    indices = Array.from({ length: totalTraces }, (_, i) => i);
  } else {
    const head = Math.floor(maxTraces / 2);
    const strided = maxTraces - head;
    const stride = (totalTraces - head) / strided;
    const set = new Set();
    for (let i = 0; i < head; i++) set.add(i);
    for (let i = 0; i < strided; i++) {
      const idx = Math.min(totalTraces - 1, Math.floor(head + i * stride));
      // sample ADJACENT PAIRS: diffs between strided samples are all
      // multiples of the stride, so the gcd could stabilize on a multiple
      // of the true il/xl step (L3 — sampled-preview step overestimate);
      // a true neighbour diff at each stop pins the gcd to the real step
      set.add(idx);
      set.add(Math.min(totalTraces - 1, idx + 1));
    }
    set.add(totalTraces - 1);
    indices = [...set].sort((a, b) => a - b);
  }

  let ilMin = Infinity; let ilMax = -Infinity;
  let xlMin = Infinity; let xlMax = -Infinity;
  let ilStep = 0; let xlStep = 0;
  let inlineSorted = true;
  let prevIl = null; let prevXl = null;
  let ilChanges = 0;
  let firstCoords = null; let lastCoords = null; let scalar = null;
  const coordFit = makeAffineFit();

  const readHeaderAt = async (traceIndex) => {
    const off = TEXT_HEADER_BYTES + BIN_HEADER_BYTES + traceIndex * traceBytes;
    return new DataView(await reader.read(off, TRACE_HEADER_BYTES));
  };

  const inspect = (th, isFirst, isLast) => {
    const il = readHeaderInt32(th, map.ilByte);
    const xl = readHeaderInt32(th, map.xlByte);
    if (il < ilMin) ilMin = il;
    if (il > ilMax) ilMax = il;
    if (xl < xlMin) xlMin = xl;
    if (xl > xlMax) xlMax = xl;
    if (prevIl !== null) {
      if (il < prevIl) inlineSorted = false;
      if (il !== prevIl) {
        ilChanges += 1;
        ilStep = gcd(ilStep, Math.abs(il - prevIl));
      } else if (xl !== prevXl) {
        xlStep = gcd(xlStep, Math.abs(xl - prevXl));
      }
    }
    prevIl = il;
    prevXl = xl;
    const s = readHeaderInt16(th, map.scalarByte);
    const cx = applyCoordScalar(readHeaderInt32(th, map.xByte), s);
    const cy = applyCoordScalar(readHeaderInt32(th, map.yByte), s);
    affineFitAdd(coordFit, il, xl, cx, cy);
    if (isFirst) { firstCoords = { x: cx, y: cy }; scalar = s; }
    if (isLast) lastCoords = { x: cx, y: cy };
  };

  if (!sampled) {
    // windowed sequential pass, whole traces per chunk
    const tracesPerChunk = Math.max(1, Math.floor(chunkBytes / traceBytes));
    for (let start = 0; start < totalTraces; start += tracesPerChunk) {
      const count = Math.min(tracesPerChunk, totalTraces - start);
      const off = TEXT_HEADER_BYTES + BIN_HEADER_BYTES + start * traceBytes;
      const buf = await reader.read(off, count * traceBytes);
      for (let i = 0; i < count; i++) {
        const th = new DataView(buf, i * traceBytes, TRACE_HEADER_BYTES);
        const idx = start + i;
        inspect(th, idx === 0, idx === totalTraces - 1);
      }
      if (onProgress) onProgress(Math.min(start + count, totalTraces), totalTraces);
    }
  } else {
    for (let n = 0; n < indices.length; n++) {
      const idx = indices[n];
      inspect(await readHeaderAt(idx), idx === 0, idx === totalTraces - 1);
      if (onProgress && n % 200 === 0) onProgress(n, indices.length);
    }
  }

  if (ilStep === 0) ilStep = 1;
  if (xlStep === 0) xlStep = 1;
  const nIl = Math.floor((ilMax - ilMin) / ilStep) + 1;
  const nXl = Math.floor((xlMax - xlMin) / xlStep) + 1;
  const regular = !sampled && nIl * nXl === totalTraces && ilChanges === nIl - 1;
  if (!sampled && !regular) {
    warnings.push(
      `Grid is not regular under this mapping: ${nIl} x ${nXl} != ${totalTraces} traces. `
      + 'Check the inline/crossline byte positions.');
  }
  if (!inlineSorted) {
    warnings.push('Traces are not inline-sorted; Phase 1 ingestion requires inline-sorted input.');
  }
  if (nIl <= 1 && nXl <= 1 && totalTraces > 1) {
    warnings.push('Mapping yields a single (inline, crossline) pair for every trace — '
      + 'these byte positions are almost certainly wrong.');
  }

  // Measured survey affine (world = f(il, xl)); supports rotated surveys
  // and rectangular bins. Null when coordinates are missing or the il/xl
  // coverage is degenerate — consumers then fall back to the corner
  // assumption exactly as before.
  const affine = solveAffineFit(coordFit, { ilMin, ilStep, xlMin, xlStep });
  if (affine) {
    const spacing = cellSpacing(affine);
    const minSpacing = Math.min(spacing.il, spacing.xl);
    if (minSpacing > 0 && affine.fit.rmsM > 0.25 * minSpacing) {
      warnings.push(
        `Trace coordinates deviate from a regular grid (RMS ${affine.fit.rmsM.toFixed(1)} m `
        + `vs ~${minSpacing.toFixed(1)} m bins) — check the X/Y byte positions and scalar.`);
    }
  } else if (coordFit.n >= 3) {
    warnings.push('Trace coordinates do not determine the survey orientation; '
      + 'maps and exports will assume an unrotated survey.');
  }

  return {
    ...header,
    mapping: map,
    sampled,
    il: { min: ilMin, max: ilMax, step: ilStep, count: nIl },
    xl: { min: xlMin, max: xlMax, step: xlStep, count: nXl },
    regular,
    inlineSorted,
    coordScalar: scalar,
    corners: { first: firstCoords, last: lastCoords },
    affine,
    warnings,
  };
}

/**
 * Read a handful of trace headers for the mapping-preview table.
 * @param {import('./reader').ByteReader} reader
 * @param {Partial<typeof DEFAULT_MAPPING>} [mapping]
 * @param {number} [count]
 */
export async function previewTraceHeaders(reader, mapping = {}, count = 10) {
  const map = { ...DEFAULT_MAPPING, ...mapping };
  const { traceBytes, totalTraces } = await readFileHeaders(reader);
  const n = Math.min(count, totalTraces);
  const rows = [];
  for (let i = 0; i < n; i++) {
    // spread indices across the file so a wrong mapping is visible fast
    const idx = n <= 1 ? 0 : Math.floor((i * (totalTraces - 1)) / (n - 1));
    const off = TEXT_HEADER_BYTES + BIN_HEADER_BYTES + idx * traceBytes;
    const th = new DataView(await reader.read(off, TRACE_HEADER_BYTES));
    const s = readHeaderInt16(th, map.scalarByte);
    rows.push({
      trace: idx,
      il: readHeaderInt32(th, map.ilByte),
      xl: readHeaderInt32(th, map.xlByte),
      x: applyCoordScalar(readHeaderInt32(th, map.xByte), s),
      y: applyCoordScalar(readHeaderInt32(th, map.yByte), s),
      scalar: s,
    });
  }
  return rows;
}
