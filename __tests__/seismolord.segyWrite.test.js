// SEG-Y writer (QI Q11): the bytes are the ones segyio read back
// (tools/validation/seismolord/oracle_segy_write.py), and this repository's
// own reader reads the geometry, the coordinates and the samples back.
// Negative control: little-endian samples (a common writer bug) change the
// bytes and read back as garbage.
import { createHash } from 'node:crypto';
import G from '../test-data/seismolord/goldens.segyWrite.json';
import SPEC from '../test-data/seismolord/segyWrite.sample.json';
import { writeSegy, segyFileBytes, binaryHeader, traceHeader, textualHeader } from '../engines/seismolord/segyWrite';
import { readFileHeaders, readTextualHeader, scanGeometry } from '../engines/seismolord/segyScan';
import { decodeSamples, readHeaderInt32, readHeaderInt16, applyCoordScalar } from '../engines/seismolord/segyDecode';

const spec = SPEC;
const bytes = writeSegy(spec);
const reader = { size: bytes.length, read: async (off, len) => bytes.slice(off, off + len).buffer };

describe('SEG-Y writer', () => {
  test('the file is the one segyio read back', () => {
    expect(bytes.length).toBe(G.bytes);
    expect(bytes.length).toBe(segyFileBytes(50, 20));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(G.sha256);
    expect(G.segyio.format).toBe(5);
    expect(G.segyio.revision).toBe(1);
  });
  test('our reader reads the headers, the geometry, the coordinates and the samples', async () => {
    const h = await readFileHeaders(reader);
    expect(h.totalTraces).toBe(20);
    expect(h.ns).toBe(50);
    expect(h.dtUs).toBe(2000);
    expect(h.formatCode).toBe(5);
    expect(h.trailingBytes).toBe(0);
    const text = await readTextualHeader(reader);
    expect(text.join('\n')).toMatch(/Petrolord QI Studio export/);
    const g = await scanGeometry(reader);
    expect([g.il.min, g.il.max, g.il.step]).toEqual([1001, 1004, 1]);
    expect([g.xl.min, g.xl.max, g.xl.step]).toEqual([2001, 2009, 2]);
    const traceBytes = 240 + 200;
    for (const k of [0, 13, 19]) {
      const at = 3600 + k * traceBytes;
      const dv = new DataView(bytes.buffer, at, traceBytes);
      const t = spec.traces[k];
      expect(readHeaderInt32(dv, 189)).toBe(t.il);
      expect(readHeaderInt32(dv, 193)).toBe(t.xl);
      expect(applyCoordScalar(readHeaderInt32(dv, 181), readHeaderInt16(dv, 71))).toBeCloseTo(t.x, 2);
      expect(applyCoordScalar(readHeaderInt32(dv, 185), readHeaderInt16(dv, 71))).toBeCloseTo(t.y, 2);
      const s = decodeSamples(new DataView(bytes.buffer, at + 240, 200), 0, 50, 5);
      for (let i = 0; i < 50; i++) expect(s[i]).toBe(t.samples[i] >= 1e29 ? 0 : t.samples[i]);
    }
  });
  test('negative control: little-endian samples change the bytes and read back wrong', () => {
    const wrong = Uint8Array.from(bytes);
    const at = 3600 + 240;
    const dv = new DataView(wrong.buffer);
    for (let i = 0; i < 50; i++) dv.setFloat32(at + 4 * i, spec.traces[0].samples[i], true);
    expect(createHash('sha256').update(wrong).digest('hex')).not.toBe(G.sha256);
    const s = decodeSamples(new DataView(wrong.buffer, at, 200), 0, 50, 5);
    let off = 0;
    for (let i = 0; i < 50; i++) if (Math.abs(s[i] - spec.traces[0].samples[i]) > 1e-3) off += 1;
    expect(off).toBeGreaterThan(40);
  });
  test('a prestack trace carries its offset at byte 37; a stack trace leaves it zero', () => {
    const one = writeSegy({ dtUs: 2000, ns: 2, traces: [{ il: 1, xl: 1, x: 0, y: 0, offset: 1250.4, samples: [1, 2] }, { il: 1, xl: 1, x: 0, y: 0, samples: [1, 2] }] });
    const dv = new DataView(one.buffer);
    expect(readHeaderInt32(new DataView(one.buffer, 3600, 240), 37)).toBe(1250);
    expect(readHeaderInt32(new DataView(one.buffer, 3600 + 248, 240), 37)).toBe(0);
    expect(dv.byteLength).toBe(segyFileBytes(2, 2));
  });
  test('refusals and limits', () => {
    expect(() => binaryHeader({ dtUs: 0, ns: 10 })).toThrow(/microseconds/);
    expect(() => binaryHeader({ dtUs: 2000, ns: 40000 })).toThrow(/32767/);
    expect(() => traceHeader({ seq: 1, il: 1, xl: 1, x: 3e7, y: 0, ns: 1, dtUs: 1, coordScalar: -100 })).toThrow(/scalar/);
    expect(textualHeader(['x'.repeat(200)]).length).toBe(3200);
    expect(() => writeSegy({ dtUs: 2000, ns: 5, traces: [{ il: 1, xl: 1, x: 0, y: 0, samples: [1, 2] }] })).toThrow(/2 samples/);
  });
});
