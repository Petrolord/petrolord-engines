// SEG-Y writer (QI programme Q11, SOW section 12): volumes, angle stacks and
// inversion products handed over as SEG-Y rev 1. Fixed trace length, IEEE
// float samples (format 5), big-endian, an EBCDIC (cp037) textual header,
// inline and crossline at bytes 189 and 193 and CDP X and Y at 181 and 185
// with the byte-71 scalar (the rev 1 standard, the reader's DEFAULT_MAPPING).
// SEG-Y has no null sample: nulls are written as 0, and the textual header
// says so. Validated by read-back with segyio
// (tools/validation/seismolord/oracle_segy_write.py) and with this
// repository's own reader. Pure.

import { TEXT_HEADER_BYTES, BIN_HEADER_BYTES, TRACE_HEADER_BYTES } from './segyDecode.js';

// ASCII -> EBCDIC (cp037) for the printable subset the reader maps back; anything else is a space
const TO_EBCDIC = (() => {
  const m = new Uint8Array(128).fill(0x40);
  const put = (code, chars) => { for (let i = 0; i < chars.length; i++) m[chars.charCodeAt(i)] = code + i; };
  put(0x4b, '.<(+|');
  m['&'.charCodeAt(0)] = 0x50;
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
  m[32] = 0x40;
  return m;
})();

/** The 3200-byte textual header: 40 card images of 80 characters, "C 1 " to "C40 ", in EBCDIC. */
export function textualHeader(lines = []) {
  const out = new Uint8Array(TEXT_HEADER_BYTES).fill(0x40);
  for (let k = 0; k < 40; k++) {
    const body = String(lines[k] ?? '');
    const card = `C${String(k + 1).padStart(2, ' ')} ${body}`.slice(0, 80).padEnd(80, ' ');
    for (let i = 0; i < 80; i++) {
      const c = card.charCodeAt(i);
      out[k * 80 + i] = c < 128 ? TO_EBCDIC[c] : 0x40;
    }
  }
  return out;
}

const i16 = (dv, pos1, v) => dv.setInt16(pos1 - 1, v, false);
const i32 = (dv, pos1, v) => dv.setInt32(pos1 - 1, v, false);
const u16 = (dv, pos1, v) => dv.setUint16(pos1 - 1, v, false);

/**
 * The 400-byte binary header (positions relative to its start, 1-based).
 * @param {{dtUs: number, ns: number, measurementSystem?: 1|2}} p
 */
export function binaryHeader({ dtUs, ns, measurementSystem = 1 }) {
  if (!Number.isInteger(dtUs) || dtUs <= 0 || dtUs > 65535) throw new Error('The sample interval must be a whole number of microseconds, 1 to 65535.');
  if (!Number.isInteger(ns) || ns <= 0 || ns > 32767) throw new Error('A SEG-Y rev 1 trace holds 1 to 32767 samples.');
  const b = new Uint8Array(BIN_HEADER_BYTES);
  const dv = new DataView(b.buffer);
  i32(dv, 1, 1); // job id
  i32(dv, 5, 1); // line number
  i32(dv, 9, 1); // reel number
  i16(dv, 13, 1); // traces per ensemble
  u16(dv, 17, dtUs); u16(dv, 19, dtUs);
  i16(dv, 21, ns); i16(dv, 23, ns);
  i16(dv, 25, 5); // IEEE float
  i16(dv, 27, 1); // ensemble fold
  i16(dv, 29, 4); // horizontally stacked
  i16(dv, 55, measurementSystem);
  u16(dv, 301, 0x0100); // SEG-Y revision 1.0
  i16(dv, 303, 1); // fixed trace length
  i16(dv, 305, 0); // no extended textual headers
  return b;
}

/**
 * One 240-byte trace header.
 * @param {{seq: number, il: number, xl: number, x: number, y: number, ns: number, dtUs: number, coordScalar?: number}} p
 *   coordScalar as stored at byte 71: negative divides (the default -100 keeps centimetres)
 */
export function traceHeader({ seq, il, xl, x, y, ns, dtUs, coordScalar = -100 }) {
  const h = new Uint8Array(TRACE_HEADER_BYTES);
  const dv = new DataView(h.buffer);
  const k = coordScalar < 0 ? -coordScalar : coordScalar > 1 ? 1 / coordScalar : 1;
  const sx = Math.round(x * k); const sy = Math.round(y * k);
  if (Math.abs(sx) > 2147483647 || Math.abs(sy) > 2147483647) throw new Error('A coordinate does not fit the trace header at this scalar; use a smaller one.');
  i32(dv, 1, seq); i32(dv, 5, seq);
  i32(dv, 9, il); // field record: the inline, for readers that look there
  i32(dv, 21, xl); // CDP ensemble: the crossline
  i16(dv, 29, 1); // seismic data
  i16(dv, 71, coordScalar);
  i32(dv, 73, sx); i32(dv, 77, sy);
  i16(dv, 89, 1); // coordinates are lengths
  u16(dv, 115, ns); u16(dv, 117, dtUs);
  i32(dv, 181, sx); i32(dv, 185, sy);
  i32(dv, 189, il); i32(dv, 193, xl);
  return h;
}

/** Samples as big-endian IEEE float; a null (non-finite or |v| >= 1e29) is written as 0. */
export function traceSamples(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    dv.setFloat32(i * 4, Number.isFinite(v) && Math.abs(v) < 1e29 ? v : 0, false);
  }
  return out;
}

/** The size in bytes of a file of nTraces traces of ns samples. */
export const segyFileBytes = (ns, nTraces) => TEXT_HEADER_BYTES + BIN_HEADER_BYTES + nTraces * (TRACE_HEADER_BYTES + 4 * ns);

/**
 * Write a whole small file in memory (tests and small exports; the worker
 * streams the same pieces).
 * @param {{lines?: string[], dtUs, ns, traces: Array<{il, xl, x, y, samples}>, coordScalar?}} p
 */
export function writeSegy({ lines = [], dtUs, ns, traces, coordScalar = -100, measurementSystem = 1 }) {
  const out = new Uint8Array(segyFileBytes(ns, traces.length));
  out.set(textualHeader(lines), 0);
  out.set(binaryHeader({ dtUs, ns, measurementSystem }), TEXT_HEADER_BYTES);
  let at = TEXT_HEADER_BYTES + BIN_HEADER_BYTES;
  traces.forEach((t, k) => {
    if (t.samples.length !== ns) throw new Error(`Trace ${k + 1} has ${t.samples.length} samples; the file has ${ns}.`);
    out.set(traceHeader({ seq: k + 1, il: t.il, xl: t.xl, x: t.x, y: t.y, ns, dtUs, coordScalar }), at);
    at += TRACE_HEADER_BYTES;
    out.set(traceSamples(t.samples), at);
    at += 4 * ns;
  });
  return out;
}
