// SEG-Y trace delay (byte 109) honoured on import (QI benchmark F-5). Known
// truth: a file whose every trace carries a spike at a known TIME, written
// with its first sample at a delay, so the spike sits at sample
// (T - delay) / dt of the file. After the shift the spike must be at sample
// T / dt of the volume's axis (0 ms origin). Negative control: the file read
// as it is (the delay ignored, the behaviour before F-5) misplaces it.
import { bufferReader } from '../engines/seismolord/reader';
import { readFileHeaders, scanGeometry } from '../engines/seismolord/segyScan';
import { decodeSamples, ibm32ToNumber } from '../engines/seismolord/segyDecode';
import {
  surveyTraceDelays, delayAlignment, alignTopReader, timeScalarUnit, traceTimes,
} from '../engines/seismolord/traceDelay';
import {
  normalizeCrop, planRegularCrop, croppedSegyReader, cropCards,
} from '../engines/seismolord/segyCrop';
import { makeSegy, scanOf } from './seismolordSegyFixture';

const HEAD = 3600;
const TH = 240;
const DT = 4; // ms (the fixture writes 4000 us)
const T_EVENT = 400; // ms, the true time of the spike

/** A file whose first sample is at delayMs (byte 109 = stored, byte 215 = scalar). */
function delayed({ delayMs, stored = delayMs, scalar = 0, ns = 200, format = 5, perTrace = null, nIl = 5, nXl = 6 }) {
  const at = (d) => Math.round((T_EVENT - d) / DT);
  const f = makeSegy({ nIl, nXl, ns, format, amp: (i, x, s) => (s === at(perTrace ? perTrace(i, x) : delayMs) ? 100 + i : 0) });
  const v = new DataView(f.buffer);
  for (let t = 0; t < f.traces; t++) {
    const off = HEAD + t * f.traceBytes;
    const i = Math.floor(t / nXl); const x = t % nXl;
    v.setInt16(off + 108, perTrace ? perTrace(i, x) : stored, false);
    v.setInt16(off + 214, scalar, false);
    v.setInt16(off + 114, ns, false);
    v.setInt16(off + 116, DT * 1000, false);
  }
  return f;
}

async function spikeSamples(reader, format = 5) {
  const h = await readFileHeaders(reader);
  const buf = await reader.read(HEAD, h.totalTraces * h.traceBytes);
  const out = [];
  for (let t = 0; t < h.totalTraces; t++) {
    const s = decodeSamples(new DataView(buf), t * h.traceBytes + TH, h.ns, format);
    let best = -1; let bv = 0;
    for (let k = 0; k < h.ns; k++) if (s[k] < 1e29 && Math.abs(s[k]) > bv) { bv = Math.abs(s[k]); best = k; }
    out.push(best);
  }
  return { at: out, ns: h.ns, totalTraces: h.totalTraces };
}

describe('trace delay survey', () => {
  test('byte 109 and the byte 215 time scalar', async () => {
    expect(timeScalarUnit(0)).toBe(1);
    expect(timeScalarUnit(10)).toBe(10);
    expect(timeScalarUnit(-10)).toBe(0.1);
    expect(timeScalarUnit(7)).toBe(1); // not a power of ten: read as written
    const f = delayed({ delayMs: 40, stored: 4, scalar: 10 });
    const s = await surveyTraceDelays(bufferReader(f.buffer));
    expect(s).toMatchObject({ delayMs: 40, uniform: true, min: 40, max: 40, ns: 200, dtUs: 4000, totalTraces: 30 });
    expect(s.sampled).toBeGreaterThan(8);
    const dv = new DataView(f.buffer, HEAD);
    expect(traceTimes(dv, 0).delayMs).toBe(40);
  });

  test('delays that differ between traces are reported and not applied', async () => {
    const f = delayed({ delayMs: 40, perTrace: (i) => (i === 4 ? 48 : 40) });
    const s = await surveyTraceDelays(bufferReader(f.buffer));
    expect(s.uniform).toBe(false);
    const a = delayAlignment(s);
    expect(a.applied).toBe(false);
    expect(a.shift_samples).toBe(0);
    expect(a.range_ms).toEqual([40, 48]);
    expect(a.note).toMatch(/differ between traces, 40 to 48 ms/);
  });

  test('depth volumes and a zero delay are left alone', async () => {
    const s = await surveyTraceDelays(bufferReader(delayed({ delayMs: 40 }).buffer));
    expect(delayAlignment(s, { domain: 'depth' })).toMatchObject({ applied: false, shift_samples: 0 });
    const z = await surveyTraceDelays(bufferReader(delayed({ delayMs: 0 }).buffer));
    expect(delayAlignment(z)).toMatchObject({ applied: false, shift_samples: 0, note: null });
  });
});

describe('the delay applied (known truth)', () => {
  test.each([
    ['positive delay, IEEE', 40, 5],
    ['positive delay, IBM', 40, 1],
    ['negative delay', -20, 5],
  ])('%s: the spike lands at its true time', async (_n, delayMs, format) => {
    const f = delayed({ delayMs, format });
    const raw = bufferReader(f.buffer);
    const before = await spikeSamples(raw, format);
    // negative control: the file as read before F-5 places the spike at
    // (T - delay) / dt, wrong by the delay
    expect(before.at.every((k) => k === (T_EVENT - delayMs) / DT)).toBe(true);
    const a = delayAlignment(await surveyTraceDelays(raw));
    expect(a).toMatchObject({ applied: true, shift_samples: delayMs / DT, applied_ms: delayMs, residual_ms: 0 });
    const r = await alignTopReader(raw, a.shift_samples);
    const after = await spikeSamples(r, format);
    expect(after.ns).toBe(200 + delayMs / DT);
    expect(after.totalTraces).toBe(30);
    expect(after.at.every((k) => k === T_EVENT / DT)).toBe(true);
    // headers follow: sample count and a zero delay; other bytes as read
    const hv = new DataView(await r.read(HEAD, TH));
    expect(hv.getInt16(114, false)).toBe(200 + delayMs / DT);
    expect(hv.getInt16(108, false)).toBe(0);
    expect(hv.getInt32(188, false)).toBe(100);
    // the samples are the source's; nulls only above them
    const s0 = decodeSamples(new DataView(await r.read(HEAD, r.size - HEAD)), TH, after.ns, format);
    if (delayMs > 0) {
      for (let k = 0; k < delayMs / DT; k++) expect(s0[k]).toBeGreaterThan(9e29);
      expect(s0[delayMs / DT]).toBe(0);
    }
    // the scan reads the shifted file
    const scan = await scanGeometry(r, {}, {});
    expect(scan.ns).toBe(200 + delayMs / DT);
    expect(scan.il.count).toBe(5);
  });

  test('the IBM null word decodes as 1.0E+30', async () => {
    const f = delayed({ delayMs: 8, format: 1 });
    const r = await alignTopReader(bufferReader(f.buffer), 2);
    const w = new DataView(await r.read(HEAD + TH, 4)).getUint32(0, false);
    expect(ibm32ToNumber(w) / 1e30).toBeCloseTo(1, 5);
  });

  test('a delay that is not a whole number of samples moves to the nearest and says by how much', async () => {
    const s = await surveyTraceDelays(bufferReader(delayed({ delayMs: 6 }).buffer));
    const a = delayAlignment(s);
    expect(a).toMatchObject({ applied: true, shift_samples: 2, applied_ms: 8, residual_ms: -2 });
    expect(a.note).toMatch(/2 ms late/);
    const small = delayAlignment({ ...s, delayMs: 1, min: 1, max: 1 });
    expect(small).toMatchObject({ applied: false, residual_ms: 1 });
  });

  test('refusals: past the SEG-Y length, every sample before zero, unset interval', () => {
    const base = { uniform: true, min: 0, max: 0, lagAMs: 0, ns: 32760, dtUs: 4000, totalTraces: 1 };
    expect(delayAlignment({ ...base, delayMs: 400 }).applied).toBe(false);
    expect(delayAlignment({ ...base, ns: 50, delayMs: -400 }).applied).toBe(false);
    expect(delayAlignment({ ...base, ns: 50, dtUs: 0, delayMs: 40 }).applied).toBe(false);
  });
});

describe('crop and delay together', () => {
  test('a window in true times keeps the right samples, and the cropped file converts onto the true axis', async () => {
    const delayMs = 40;
    const f = delayed({ delayMs, ns: 200 });
    const raw = bufferReader(f.buffer);
    const geomScan = scanOf({ nIl: 5, nXl: 6, ns: 200 }, f.traces);
    const crop = normalizeCrop({ window: { from: 300, to: 500 } }, { il: geomScan.il, xl: geomScan.xl, ns: 200, dtUs: 4000, t0Ms: delayMs });
    // sample k of the file is at 40 + 4k ms: 300 ms is sample 65, 500 ms sample 115
    expect(crop.samples).toEqual({ first: 65, last: 115, count: 51 });
    expect(crop.window).toEqual({ from: 300, to: 500 });
    expect(crop.source.t0Ms).toBe(40);
    expect(cropCards(crop)[3]).toMatch(/WINDOW 300-500 OF 40-836/);
    // negative control: without the origin the same window keeps samples 75 to 125, 40 ms late
    const naive = normalizeCrop({ window: { from: 300, to: 500 } }, { il: geomScan.il, xl: geomScan.xl, ns: 200, dtUs: 4000 });
    expect(naive.samples.first).toBe(75);
    // an origin of 0 changes nothing in the crop record (earlier crops read the same)
    expect(normalizeCrop({ window: { from: 300, to: 500 } }, { il: geomScan.il, xl: geomScan.xl, ns: 200, dtUs: 4000, t0Ms: 0 })).toEqual(naive);

    const layout = { dataStart: HEAD, sampleBytes: 4, ns: 200, dtUs: 4000, traceBytes: f.traceBytes, totalTraces: f.traces, littleEndian: false };
    const plan = planRegularCrop({ ...geomScan, totalTraces: f.traces }, crop);
    const cropped = croppedSegyReader(raw, layout, plan, crop, { sourceName: 't.sgy', mapping: { ilByte: 189, xlByte: 193 } });
    const s = await surveyTraceDelays(cropped);
    expect(s.delayMs).toBe(300); // 40 + 65 x 4: the cropped file's first sample time
    const a = delayAlignment(s);
    expect(a.shift_samples).toBe(75);
    const view = await alignTopReader(cropped, a.shift_samples);
    const after = await spikeSamples(view);
    expect(after.at.every((k) => k === T_EVENT / DT)).toBe(true);
    expect(after.ns).toBe(75 + 51);
  });
});
