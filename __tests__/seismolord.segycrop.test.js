// Crop before upload (2026-10-14). The cropped file is checked against the
// SOURCE bytes, never against a restatement of the crop arithmetic:
//  - every kept trace's sample bytes are the source's window bytes, and its
//    header is the source's except bytes 109 (delay) and 115 (samples);
//  - the kept set equals a brute-force filter of the source's own headers;
//  - the cropped file reads back through this repository's scan and decode.
// Negative controls: an off-by-one window, a dropped kept trace and an
// irregular file under the regular plan all fail.
import { bufferReader } from '../engines/seismolord/reader';
import { scanGeometry, readFileHeaders, readTextualHeader } from '../engines/seismolord/segyScan';
import { decodeSamples } from '../engines/seismolord/segyDecode';
import { TRACE_HEADER_FIELDS } from '../engines/seismolord/segyTranscode';
import {
  normalizeCrop, planRegularCrop, planCropFromHeaders, croppedSegyReader, padTopReader,
  parseCropCard, detectGatherLayout, cropKeeps, croppedFileBytes, CropGridMismatch, pointInPolygon,
  cropIsWhole, cropProvenance,
} from '../engines/seismolord/segyCrop';
import { makeSegy, scanOf, virtualSegyReader } from './seismolordSegyFixture';

const HEAD = 3600;
const TH = 240;
const GEOM = { nIl: 23, nXl: 31, ns: 120, il0: 1000, xl0: 2000, ilStep: 2, xlStep: 1 };

const layoutOf = (scan, extra = {}) => ({ dataStart: HEAD, sampleBytes: 4, ns: scan.ns, dtUs: 4000, traceBytes: scan.traceBytes, totalTraces: scan.totalTraces, littleEndian: false, ...extra });
const readAll = async (r) => new Uint8Array(await r.read(0, r.size));

/** The check every crop must pass: compare the cropped file to the source, trace by trace. */
function assertCropExact(srcBuf, out, keptSrcTraces, { ns, first, count, bps = 4, le = false, delayAddMs }) {
  const src = new Uint8Array(srcBuf);
  const srcTrace = TH + ns * bps;
  const outTrace = TH + count * bps;
  if (out.length !== HEAD + keptSrcTraces.length * outTrace) throw new Error(`size ${out.length}`);
  const sv = new DataView(src.buffer);
  const ov = new DataView(out.buffer);
  keptSrcTraces.forEach((t, v) => {
    const so = HEAD + t * srcTrace;
    const oo = HEAD + v * outTrace;
    for (let b = 0; b < TH; b++) {
      if (b === 108 || b === 109 || b === 114 || b === 115) continue;
      if (src[so + b] !== out[oo + b]) throw new Error(`trace ${v} header byte ${b + 1} differs`);
    }
    if (ov.getInt16(oo + 114, le) !== count) throw new Error(`trace ${v} ns`);
    if (ov.getInt16(oo + 108, le) !== sv.getInt16(so + 108, le) + delayAddMs) throw new Error(`trace ${v} delay`);
    for (let b = 0; b < count * bps; b++) {
      if (src[so + TH + first * bps + b] !== out[oo + TH + b]) throw new Error(`trace ${v} sample byte ${b} differs`);
    }
  });
}

/** Brute force: source traces whose own headers the crop keeps. */
function bruteKept(buf, ns, crop, le = false) {
  const dv = new DataView(buf);
  const traceBytes = TH + ns * 4;
  const n = (buf.byteLength - HEAD) / traceBytes;
  const out = [];
  for (let t = 0; t < n; t++) {
    const o = HEAD + t * traceBytes;
    if (cropKeeps(crop, dv.getInt32(o + 188, le), dv.getInt32(o + 192, le))) out.push(t);
  }
  return out;
}

const planTraces = (plan) => {
  const out = [];
  for (let r = 0; r < plan.runs; r++) for (let k = 0; k < plan.counts[r]; k++) out.push(plan.starts[r] + k);
  return out;
};

describe('normalizeCrop', () => {
  const scan = scanOf(GEOM);
  test('ranges snap inside to the grid and decimation keeps whole steps', () => {
    const c = normalizeCrop({ il: { from: 1003, to: 1030 }, xl: { from: 2004.5, to: 2020 }, window: { from: 101, to: 299 }, decimate: { il: 2, xl: 3 } }, { ...scan, dtUs: 4000 });
    expect(c.il).toEqual({ from: 1004, to: 1028, step: 4, count: 7 });
    expect(c.xl).toEqual({ from: 2005, to: 2020, step: 3, count: 6 });
    expect(c.samples).toEqual({ first: 25, last: 75, count: 51 });
    expect(c.window).toEqual({ from: 100, to: 300 });
  });
  test('a velocity preset starts at the first sample; an empty range is refused', () => {
    const c = normalizeCrop({ window: { from: 200, to: 300 }, startAtZero: true }, { ...scan, dtUs: 4000 });
    expect(c.samples.first).toBe(0);
    expect(c.samples.last).toBe(75);
    expect(() => normalizeCrop({ il: { from: 5000, to: 6000 } }, { ...scan, dtUs: 4000 })).toThrow(/holds no inline/);
    expect(cropIsWhole(normalizeCrop({}, { ...scan, dtUs: 4000 }))).toBe(true);
  });
  test('a 0.5 ms interval keeps the delay on a whole millisecond', () => {
    const c = normalizeCrop({ window: { from: 10.5, to: 20 } }, { ...scan, dtUs: 500 });
    expect((c.samples.first * 500) % 1000).toBe(0);
    expect(c.samples.first).toBe(20);
    expect(c.notes.join(' ')).toMatch(/one sample earlier/);
  });
  test('polygon test counts edges as inside', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInPolygon(5, 5, sq)).toBe(true);
    expect(pointInPolygon(10, 5, sq)).toBe(true);
    expect(pointInPolygon(11, 5, sq)).toBe(false);
  });
});

describe('regular crop', () => {
  const { buffer } = makeSegy({ ...GEOM, format: 1 });
  const src = bufferReader(buffer);
  const scan = scanOf({ ...GEOM, format: 1 });
  const crop = normalizeCrop({ name: 'Area A', il: { from: 1010, to: 1030 }, xl: { from: 2005, to: 2017 }, window: { from: 120, to: 300 } }, { ...scan, dtUs: 4000 });
  const plan = planRegularCrop(scan, crop);
  const cropped = croppedSegyReader(src, layoutOf(scan), plan, crop, { sourceName: 'stack_near.sgy', mapping: { ilByte: 189, xlByte: 193 } });

  test('kept traces equal a brute-force filter of the source headers', () => {
    expect(planTraces(plan)).toEqual(bruteKept(buffer, GEOM.ns, crop));
    expect(plan.keptTraces).toBe(11 * 13);
    expect(cropped.size).toBe(croppedFileBytes(143, crop.samples.count, 4));
  });

  test('kept traces are byte-identical to the source, window exact, headers updated', async () => {
    const out = await readAll(cropped);
    assertCropExact(buffer, out, planTraces(plan), { ns: GEOM.ns, first: crop.samples.first, count: crop.samples.count, delayAddMs: 120 });
    // negative controls: the same check rejects an off-by-one window and a dropped trace
    expect(() => assertCropExact(buffer, out, planTraces(plan), { ns: GEOM.ns, first: crop.samples.first + 1, count: crop.samples.count, delayAddMs: 120 })).toThrow(/sample byte/);
    expect(() => assertCropExact(buffer, out, planTraces(plan).slice(1).concat([0]), { ns: GEOM.ns, first: crop.samples.first, count: crop.samples.count, delayAddMs: 120 })).toThrow();
  });

  test('the cropped file reads back through the scan and the decoder', async () => {
    const h = await readFileHeaders(cropped);
    expect(h.ns).toBe(crop.samples.count);
    expect(h.formatCode).toBe(1);
    expect(h.totalTraces).toBe(143);
    expect(h.trailingBytes).toBe(0);
    const s = await scanGeometry(cropped, { ilByte: 189, xlByte: 193 });
    expect(s.regular).toBe(true);
    expect(s.il).toEqual({ min: 1010, max: 1030, step: 2, count: 11 });
    expect(s.xl).toEqual({ min: 2005, max: 2017, step: 1, count: 13 });
    // samples decode to the source's window
    const all = await readAll(cropped);
    const srcV = new DataView(buffer);
    const outV = new DataView(all.buffer);
    const a = new Float32Array(GEOM.ns); const b = new Float32Array(crop.samples.count);
    const t = planTraces(plan)[77];
    decodeSamples(srcV, HEAD + t * (TH + GEOM.ns * 4) + TH, GEOM.ns, 1, a);
    decodeSamples(outV, HEAD + 77 * (TH + crop.samples.count * 4) + TH, crop.samples.count, 1, b);
    expect(Array.from(b)).toEqual(Array.from(a.subarray(30, 30 + crop.samples.count)));
  });

  test('the textual header carries the crop, and the card reads back', async () => {
    const lines = await readTextualHeader(cropped);
    expect(lines[33]).toMatch(/^C34 CROPPED BY PETROLORD FROM STACK_NEAR.SGY/);
    expect(parseCropCard(lines)).toEqual({ first: 30, count: 46, ns: 120, dtUs: 4000 });
    expect(lines[35]).toMatch(/^C36 CROP AREA A: IL 1010-1030\/2 XL 2005-2017\/1/);
  });

  test('reads at any offset agree with the whole file, and source reads stay chunk-bounded', async () => {
    const whole = await readAll(cropped);
    let biggest = 0;
    const counting = { size: src.size, read: async (o, l) => { biggest = Math.max(biggest, l); return src.read(o, l); } };
    const small = croppedSegyReader(counting, layoutOf(scan), plan, crop, { chunkBytes: 4096 });
    for (const [o, l] of [[0, 10], [3590, 400], [5000, 12345], [whole.length - 77, 77], [HEAD + 3, 1]]) {
      expect(new Uint8Array(await small.read(o, l))).toEqual(whole.subarray(o, o + l));
    }
    expect(biggest).toBeLessThanOrEqual(4096 + TH + GEOM.ns * 4);
  });

  test('negative control: an irregular file under the regular plan stops at the first wrong trace', async () => {
    const irregular = makeSegy({ ...GEOM, skip: (i, x) => i === 7 && x === 3 });
    // pretend it is regular (a sampled preview can miss one dead cell)
    const sc = { ...scanOf(GEOM), totalTraces: GEOM.nIl * GEOM.nXl };
    const p = planRegularCrop(sc, crop);
    const r = croppedSegyReader(bufferReader(irregular.buffer.slice(0, irregular.buffer.byteLength)), layoutOf(sc), p, crop);
    // the reader may only stop, never deliver shifted traces
    await expect(readAll({ size: r.size, read: (o, l) => r.read(o, Math.min(l, r.size - o)) })).rejects.toThrow(CropGridMismatch);
  });

  test('polygon keeps exactly the cells inside, found from arithmetic and from headers alike', async () => {
    const poly = normalizeCrop({ polygon: [[1004, 2002], [1036, 2006], [1030, 2028], [1008, 2020]], window: { from: 0, to: 200 } }, { ...scan, dtUs: 4000 });
    const p1 = planRegularCrop(scan, poly);
    const p2 = await planCropFromHeaders(src, layoutOf(scan), { ilByte: 189, xlByte: 193 }, poly, { inlineSorted: true });
    const brute = bruteKept(buffer, GEOM.ns, poly);
    expect(planTraces(p1)).toEqual(brute);
    expect(planTraces(p2)).toEqual(brute);
    expect(brute.length).toBeGreaterThan(50);
    expect(brute.length).toBeLessThan(scan.totalTraces / 2);
    assertCropExact(buffer, await readAll(croppedSegyReader(src, layoutOf(scan), p1, poly)), brute, { ns: GEOM.ns, first: 0, count: poly.samples.count, delayAddMs: 0 });
  });
});

describe('crop from the headers', () => {
  test('a crossline-sorted file: kept set equals brute force, file reads back', async () => {
    const { buffer } = makeSegy({ ...GEOM, sort: 'crossline' });
    const src = bufferReader(buffer);
    const scan = { ...scanOf(GEOM), inlineSorted: false };
    const crop = normalizeCrop({ il: { from: 1006, to: 1020 }, xl: { from: 2010, to: 2025 }, window: { from: 40, to: 400 } }, { ...scan, dtUs: 4000 });
    const plan = await planCropFromHeaders(src, layoutOf(scan), { ilByte: 189, xlByte: 193 }, crop, { chunkBytes: 5000 });
    const brute = bruteKept(buffer, GEOM.ns, crop);
    expect(planTraces(plan)).toEqual(brute);
    const out = await readAll(croppedSegyReader(src, layoutOf(scan), plan, crop));
    assertCropExact(buffer, out, brute, { ns: GEOM.ns, first: 10, count: crop.samples.count, delayAddMs: 40 });
  });

  test('an inline-sorted file is read only over the kept inlines', async () => {
    const { buffer } = makeSegy(GEOM);
    let bytes = 0;
    const src = bufferReader(buffer);
    const counting = { size: src.size, read: async (o, l) => { bytes += l; return src.read(o, l); } };
    const scan = scanOf(GEOM);
    const crop = normalizeCrop({ il: { from: 1010, to: 1014 } }, { ...scan, dtUs: 4000 });
    const plan = await planCropFromHeaders(counting, layoutOf(scan), { ilByte: 189, xlByte: 193 }, crop, { inlineSorted: true, chunkBytes: 3 * scan.traceBytes });
    expect(planTraces(plan)).toEqual(bruteKept(buffer, GEOM.ns, crop));
    expect(bytes).toBeLessThan(buffer.byteLength / 4);
  });

  test('prestack gathers: detected, every trace of a kept cell kept, fold varies', async () => {
    // inline-sorted gathers, fold 3 to 6 by cell, offset at byte 37
    const ns = 50;
    const traceBytes = TH + ns * 4;
    const rows = [];
    for (let i = 0; i < 9; i++) for (let x = 0; x < 11; x++) for (let f = 0; f < 3 + ((i + x) % 4); f++) rows.push([500 + i, 700 + x, 100 * (f + 1)]);
    const buf = new ArrayBuffer(HEAD + rows.length * traceBytes);
    const dv = new DataView(buf);
    dv.setInt16(3200 + 16, 2000, false); dv.setInt16(3200 + 20, ns, false); dv.setInt16(3200 + 24, 5, false);
    rows.forEach(([il, xl, off], t) => {
      const o = HEAD + t * traceBytes;
      dv.setInt32(o + 188, il, false); dv.setInt32(o + 192, xl, false); dv.setInt32(o + 36, off, false);
      for (let s = 0; s < ns; s++) dv.setFloat32(o + TH + 4 * s, Math.sin(t + s * 0.3) * 100, false);
    });
    const src = bufferReader(buf);
    const layout = { dataStart: HEAD, sampleBytes: 4, ns, dtUs: 2000, traceBytes, totalTraces: rows.length };
    const g = await detectGatherLayout(src, layout, { ilByte: 189, xlByte: 193 });
    expect(g.gathers).toBe(true);
    expect(g.fold).toBeGreaterThan(3);
    const geom = { il: { min: 500, max: 508, step: 1, count: 9 }, xl: { min: 700, max: 710, step: 1, count: 11 }, ns, dtUs: 2000 };
    const crop = normalizeCrop({ il: { from: 502, to: 505 }, xl: { from: 703, to: 708 }, window: { from: 20, to: 60 } }, geom);
    const plan = await planCropFromHeaders(src, layout, { ilByte: 189, xlByte: 193 }, crop, { inlineSorted: true });
    const brute = bruteKept(buf, ns, crop);
    expect(planTraces(plan)).toEqual(brute);
    const out = await readAll(croppedSegyReader(src, layout, plan, crop));
    assertCropExact(buf, out, brute, { ns, first: 10, count: 21, delayAddMs: 20 });
    // offsets survive (byte 37 is part of the identical header bytes)
    const ov = new DataView(out.buffer);
    expect(ov.getInt32(HEAD + 36, false)).toBe(new DataView(buf).getInt32(HEAD + brute[0] * traceBytes + 36, false));
    // a post-stack file is not taken for gathers
    const post = makeSegy(GEOM);
    expect((await detectGatherLayout(bufferReader(post.buffer), layoutOf(scanOf(GEOM)), { ilByte: 189, xlByte: 193 })).gathers).toBe(false);
  });
});

describe('byte order and padding', () => {
  test('a little-endian file crops in its own byte order', async () => {
    const be = new Uint8Array(makeSegy(GEOM).buffer);
    const le = new Uint8Array(be.length);
    le.set(be.subarray(0, 3200));
    // binary header fields used here, swapped
    for (const [pos, w] of [[17, 2], [21, 2], [25, 2]]) for (let b = 0; b < w; b++) le[3200 + pos - 1 + b] = be[3200 + pos - 1 + w - 1 - b];
    const traceBytes = TH + GEOM.ns * 4;
    const n = (be.length - HEAD) / traceBytes;
    for (let t = 0; t < n; t++) {
      const o = HEAD + t * traceBytes;
      for (const [pos, w] of TRACE_HEADER_FIELDS) for (let b = 0; b < w; b++) le[o + pos - 1 + b] = be[o + pos - 1 + w - 1 - b];
      for (let s = 0; s < GEOM.ns; s++) for (let b = 0; b < 4; b++) le[o + TH + 4 * s + b] = be[o + TH + 4 * s + 3 - b];
    }
    const scan = scanOf(GEOM);
    const crop = normalizeCrop({ il: { from: 1002, to: 1008 }, window: { from: 8, to: 100 } }, { ...scan, dtUs: 4000 });
    const plan = await planCropFromHeaders(bufferReader(le.buffer), layoutOf(scan, { littleEndian: true }), { ilByte: 189, xlByte: 193 }, crop, { inlineSorted: true });
    expect(planTraces(plan)).toEqual(bruteKept(le.buffer, GEOM.ns, crop, true));
    const out = await readAll(croppedSegyReader(bufferReader(le.buffer), layoutOf(scan, { littleEndian: true }), plan, crop));
    assertCropExact(le.buffer, out, planTraces(plan), { ns: GEOM.ns, first: 2, count: crop.samples.count, le: true, delayAddMs: 8 });
    expect(new DataView(out.buffer).getInt16(3200 + 20, true)).toBe(crop.samples.count);
  });

  test('padTopReader puts nulls back above the window: the samples sit where they were', async () => {
    const { buffer } = makeSegy(GEOM);
    const src = bufferReader(buffer);
    const scan = scanOf(GEOM);
    const crop = normalizeCrop({ window: { from: 200, to: 320 } }, { ...scan, dtUs: 4000 });
    const plan = planRegularCrop(scan, crop);
    const padded = await padTopReader(croppedSegyReader(src, layoutOf(scan), plan, crop), crop.samples.first);
    const h = await readFileHeaders(padded);
    expect(h.ns).toBe(crop.samples.last + 1);
    const dv = new DataView(await padded.read(0, padded.size));
    const sv = new DataView(buffer);
    const ns2 = crop.samples.last + 1;
    const t = 101;
    const o = HEAD + t * (TH + ns2 * 4);
    expect(dv.getInt16(o + 108, false)).toBe(0);
    for (let k = 0; k < ns2; k++) {
      const v = dv.getFloat32(o + TH + 4 * k, false);
      if (k < crop.samples.first) expect(v).toBeCloseTo(1e30, -25);
      else expect(v).toBe(sv.getFloat32(HEAD + t * (TH + GEOM.ns * 4) + TH + 4 * k, false));
    }
    // IBM nulls decode as nulls too
    const ibm = makeSegy({ ...GEOM, format: 1 });
    const pi = await padTopReader(croppedSegyReader(bufferReader(ibm.buffer), layoutOf(scan), plan, crop), crop.samples.first);
    const out = new Float32Array(ns2);
    decodeSamples(new DataView(await pi.read(HEAD, TH + ns2 * 4)), TH, ns2, 1, out);
    expect(out[0]).toBeGreaterThan(1e29);
    expect(await padTopReader(src, 0)).toBe(src);
  });
});

describe('scale', () => {
  test('a large virtual survey crops with memory bounded by the chunk', async () => {
    let biggest = 0; let total = 0;
    const big = virtualSegyReader({ nIl: 400, nXl: 500, ns: 1501, onRead: (l) => { biggest = Math.max(biggest, l); total += l; } });
    const scan = { ...scanOf({ nIl: 400, nXl: 500, ns: 1501, il0: 42, xl0: 14 }) };
    const crop = normalizeCrop({ il: { from: 142, to: 271 }, xl: { from: 100, to: 259 }, window: { from: 1500, to: 3000 } }, { ...scan, dtUs: 4000 });
    const plan = planRegularCrop(scan, crop);
    const r = croppedSegyReader(big, layoutOf(scan), plan, crop, { chunkBytes: 8 * 1024 * 1024 });
    for (let at = 0; at < r.size; at += 64 * 1024 * 1024) await r.read(at, Math.min(64 * 1024 * 1024, r.size - at));
    expect(biggest).toBeLessThanOrEqual(8 * 1024 * 1024 + scan.traceBytes);
    // only the kept inlines' kept crosslines are read (plus the headers)
    expect(total).toBeLessThan(plan.keptTraces * scan.traceBytes * 1.01 + 10000);
    expect(r.size / big.size).toBeLessThan(0.05);
    expect(cropProvenance(crop, { sourceName: 'big.sgy', keptTraces: plan.keptTraces }).kept_traces).toBe(130 * 160);
  });
});
