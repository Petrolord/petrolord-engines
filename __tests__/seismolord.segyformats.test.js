/**
 * Seismolord U2-009: integer sample formats and little-endian SEG-Y,
 * validated against segyio 1.9 (the development-time oracle). The files
 * in test-data/seismolord/segy_formats were written by segyio
 * (tools/validation/seismolord/gen_segy_formats.py) and goldens.json holds
 * what segyio reads back from each. The shipped decodeSamples and
 * transcodeTraces are called, never a restated formula.
 */
import fs from 'fs';
import path from 'path';
import {
  decodeSamples, readBinaryHeader, readHeaderInt32, readHeaderInt16, bytesPerSample,
  TEXT_HEADER_BYTES, BIN_HEADER_BYTES, TRACE_HEADER_BYTES,
} from '../engines/seismolord/segyDecode';
import {
  detectByteOrder, binaryHeaderToIeeeBe, transcodeTraces, traceSizes,
} from '../engines/seismolord/segyTranscode';

const DIR = path.join(__dirname, '..', 'test-data', 'seismolord', 'segy_formats');
const G = JSON.parse(fs.readFileSync(path.join(DIR, 'goldens.json'), 'utf8'));
const HEAD = TEXT_HEADER_BYTES + BIN_HEADER_BYTES;
const load = (c) => {
  const b = fs.readFileSync(path.join(DIR, c.file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe.each(G.cases.map((c) => [c.file, c]))('%s', (_, c) => {
  const buf = load(c);
  const le = c.endian === 'little';
  const bin = new DataView(buf, TEXT_HEADER_BYTES, BIN_HEADER_BYTES);

  test('byte order and binary header', () => {
    expect(detectByteOrder(bin)).toBe(c.endian);
    const h = readBinaryHeader(bin, le);
    expect(h).toMatchObject({ formatCode: c.format, ns: c.ns, dtUs: c.dt_us });
    expect(buf.byteLength).toBe(HEAD + c.n_il * c.n_xl * (TRACE_HEADER_BYTES + c.ns * bytesPerSample(c.format)));
  });

  test('decodeSamples equals segyio on every sample of every trace', () => {
    const view = new DataView(buf);
    const tb = TRACE_HEADER_BYTES + c.ns * bytesPerSample(c.format);
    c.traces.forEach((golden, t) => {
      const got = decodeSamples(view, HEAD + t * tb + TRACE_HEADER_BYTES, c.ns, c.format, undefined, le);
      expect(Array.from(got)).toEqual(golden.map((v) => Math.fround(v)));
    });
  });

  test('transcoded to big-endian IEEE: same samples, same headers', () => {
    const { src, dst } = traceSizes(c.ns, c.format);
    const out = transcodeTraces(buf.slice(HEAD), { ns: c.ns, formatCode: c.format, littleEndian: le });
    expect(out.byteLength).toBe(c.traces.length * dst);
    expect(src).toBe(TRACE_HEADER_BYTES + c.ns * bytesPerSample(c.format));
    const v = new DataView(out);
    c.traces.forEach((golden, t) => {
      const got = decodeSamples(v, t * dst + TRACE_HEADER_BYTES, c.ns, 5);
      expect(Array.from(got)).toEqual(golden.map((x) => Math.fround(x)));
      const hv = new DataView(out, t * dst, TRACE_HEADER_BYTES);
      const i = Math.floor(t / c.n_xl);
      const j = t % c.n_xl;
      expect(readHeaderInt32(hv, 189)).toBe(c.ilines[i]);
      expect(readHeaderInt32(hv, 193)).toBe(c.xlines[j]);
      expect(readHeaderInt32(hv, 181)).toBe(500000 + j * 25);
      expect(readHeaderInt32(hv, 185)).toBe(6000000 + i * 25);
      expect(readHeaderInt16(hv, 115)).toBe(c.ns);
      expect(readHeaderInt16(hv, 117)).toBe(c.dt_us);
      expect(readHeaderInt16(hv, 71)).toBe(1);
    });
    const bh = readBinaryHeader(new DataView(binaryHeaderToIeeeBe(buf.slice(TEXT_HEADER_BYTES, HEAD), le)));
    expect(bh).toMatchObject({ formatCode: 5, ns: c.ns, dtUs: c.dt_us });
  });
});

describe('negative controls', () => {
  test('a little-endian file read as big-endian is garbage (the swap is doing the work)', () => {
    const c = G.cases.find((x) => x.file === 'fmt3_int16_le.sgy');
    const buf = load(c);
    const got = decodeSamples(new DataView(buf), HEAD + TRACE_HEADER_BYTES, c.ns, 3, undefined, false);
    expect(Array.from(got)).not.toEqual(c.traces[0].map((v) => Math.fround(v)));
    expect(readBinaryHeader(new DataView(buf, TEXT_HEADER_BYTES, BIN_HEADER_BYTES)).formatCode).toBe(768);
  });

  test('an int16 file read as 4-byte samples is garbage (the width is doing the work)', () => {
    const c = G.cases.find((x) => x.file === 'fmt3_int16_be.sgy');
    const got = decodeSamples(new DataView(load(c)), HEAD + TRACE_HEADER_BYTES, c.ns, 2);
    expect(Array.from(got)).not.toEqual(c.traces[0].map((v) => Math.fround(v)));
  });

  test('formats not decoded are refused by name', () => {
    const dv = new DataView(new ArrayBuffer(64));
    for (const f of [4, 7, 9, 12, 15]) expect(() => decodeSamples(dv, 0, 2, f)).toThrow(`Unsupported SEG-Y sample format code: ${f}`);
    expect(bytesPerSample(4)).toBeNull();
    expect(() => transcodeTraces(new ArrayBuffer(10), { ns: 2, formatCode: 3, littleEndian: false })).toThrow(/whole traces/);
  });

  test('the byte-order word wins over the format guess', () => {
    const b = new DataView(new ArrayBuffer(400));
    b.setInt16(24, 3, false);
    b.setUint32(96, 0x04030201, false);
    expect(detectByteOrder(b)).toBe('little');
  });
});
