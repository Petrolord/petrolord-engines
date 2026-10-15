// The time of a SEG-Y's first sample (QI benchmark F-5, 2026-10-15). SEG-Y
// puts the time of each trace's first sample in its header: byte 109, the
// delay recording time in milliseconds, scaled by the time scalar at byte
// 215 (rev 1 and 2; 0 or 1 means as written). Seismolord volumes keep sample
// k at k x dt from 0 ms, and every reader of a volume (viewer, horizons,
// QI sampling, ties, attributes, exports) works on that axis. So the import
// honours the delay by moving the samples on that axis: a positive delay is
// put back as null samples above the trace (the same top padding a cropped
// window uses), a negative delay drops the samples recorded before 0 ms.
//
//   surveyTraceDelays  the delays of a spread of traces (first, a run at the
//                      start, a spread through the file, the last), and
//                      whether they agree
//   delayAlignment     what the import does with them: the samples to add
//                      (or drop), the remainder a sample shift cannot hold,
//                      and why nothing is done when it is not safe
//   alignTopReader     the file with that shift applied, as a reader
//
// Lag time A (byte 105) is reported only: it is the recorded time of the
// shot and does not move the samples (the standard's convention). Readers
// here work on the classic layout the SEG-Y door presents (big-endian
// headers, 4-byte IBM or IEEE samples). Pure apart from the readers.

import { TEXT_HEADER_BYTES, BIN_HEADER_BYTES, TRACE_HEADER_BYTES } from './segyDecode.js';

const HEAD = TEXT_HEADER_BYTES + BIN_HEADER_BYTES;
const MAX_NS = 32767;

/** The byte-215 time scalar as a multiplier to milliseconds (1 when unset or unusable). */
export function timeScalarUnit(scalar) {
  if (scalar === 0 || scalar === 1) return 1;
  const a = Math.abs(scalar);
  if (![10, 100, 1000, 10000].includes(a)) return 1;
  return scalar > 0 ? a : 1 / a;
}

/** One trace header's times (ms) from a DataView at `at` (big-endian). */
export function traceTimes(dv, at = 0) {
  const unit = timeScalarUnit(dv.getInt16(at + 214, false));
  return { delayMs: dv.getInt16(at + 108, false) * unit, lagAMs: dv.getInt16(at + 104, false) * unit };
}

/**
 * The delays of a spread of traces.
 * @param {import('./reader').ByteReader} reader classic layout (door output)
 * @param {{head?: number, spread?: number}} [opts] traces read at the start, and spread through the file
 * @returns {Promise<{delayMs: number, lagAMs: number, uniform: boolean, min: number, max: number, sampled: number, ns: number, dtUs: number, totalTraces: number}>}
 */
export async function surveyTraceDelays(reader, { head = 8, spread = 24 } = {}) {
  const bin = new DataView(await reader.read(TEXT_HEADER_BYTES, BIN_HEADER_BYTES));
  const dtUs = bin.getInt16(16, false);
  const ns = bin.getInt16(20, false);
  const fmt = bin.getInt16(24, false);
  const bps = fmt === 3 ? 2 : fmt === 8 ? 1 : 4;
  const traceBytes = TRACE_HEADER_BYTES + ns * bps;
  const totalTraces = Math.max(0, Math.floor((reader.size - HEAD) / traceBytes));
  if (!totalTraces) return { delayMs: 0, lagAMs: 0, uniform: true, min: 0, max: 0, sampled: 0, ns, dtUs, totalTraces };
  const idx = new Set();
  for (let i = 0; i < Math.min(head, totalTraces); i++) idx.add(i);
  for (let k = 0; k < spread; k++) idx.add(Math.min(totalTraces - 1, Math.floor(((k + 0.5) * totalTraces) / spread)));
  idx.add(totalTraces - 1);
  const sorted = [...idx].sort((a, b) => a - b);
  const delays = [];
  let lagA = null;
  // the run at the start in one read; the rest one header each
  const nHead = Math.min(head, totalTraces);
  const first = new Uint8Array(await reader.read(HEAD, (nHead - 1) * traceBytes + TRACE_HEADER_BYTES));
  const fdv = new DataView(first.buffer);
  for (let i = 0; i < nHead; i++) {
    const t = traceTimes(fdv, i * traceBytes);
    delays.push(t.delayMs);
    if (lagA === null) lagA = t.lagAMs;
  }
  for (const i of sorted) {
    if (i < nHead) continue;
    const t = traceTimes(new DataView(await reader.read(HEAD + i * traceBytes, TRACE_HEADER_BYTES)), 0);
    delays.push(t.delayMs);
  }
  const min = Math.min(...delays);
  const max = Math.max(...delays);
  return { delayMs: delays[0], lagAMs: lagA || 0, uniform: min === max, min, max, sampled: delays.length, ns, dtUs, totalTraces };
}

/**
 * What the import does with the delays.
 * @param {Awaited<ReturnType<typeof surveyTraceDelays>>} survey
 * @param {{domain?: 'time'|'depth'}} [opts]
 * @returns {{delay_ms, lag_a_ms, applied: boolean, shift_samples: number, applied_ms: number, residual_ms: number, uniform: boolean, range_ms: [number, number], note: string|null}}
 */
export function delayAlignment(survey, { domain = 'time' } = {}) {
  const dtMs = survey.dtUs / 1000;
  const base = {
    delay_ms: survey.delayMs, lag_a_ms: survey.lagAMs, applied: false, shift_samples: 0, applied_ms: 0, residual_ms: 0,
    uniform: survey.uniform, range_ms: [survey.min, survey.max], note: null,
  };
  if (!survey.uniform) {
    return { ...base, note: `The trace delays (byte 109) differ between traces, ${survey.min} to ${survey.max} ms, so they are not applied: the first sample of every trace is placed at 0 ms.` };
  }
  if (!survey.delayMs) return base;
  if (domain === 'depth') {
    return { ...base, note: `Byte 109 holds ${survey.delayMs}, which is a time delay; a depth volume keeps its first sample at 0, so it is not applied.` };
  }
  if (!(dtMs > 0)) return { ...base, note: 'The sample interval is unset, so the trace delay is not applied.' };
  const shift = Math.round(survey.delayMs / dtMs);
  const residual = survey.delayMs - shift * dtMs;
  if (shift === 0) {
    return { ...base, residual_ms: residual, note: `The trace delay of ${survey.delayMs} ms is under half a sample, so the first sample stays at 0 ms.` };
  }
  if (shift > 0 && survey.ns + shift > MAX_NS) {
    return { ...base, note: `The trace delay of ${survey.delayMs} ms would make the traces longer than SEG-Y allows (${MAX_NS} samples), so it is not applied.` };
  }
  if (shift < 0 && -shift >= survey.ns) {
    return { ...base, note: `The trace delay of ${survey.delayMs} ms puts every sample before 0 ms, so it is not applied.` };
  }
  const parts = [];
  if (shift > 0) parts.push(`The first sample is at ${survey.delayMs} ms (trace delay, byte 109); the ${shift} samples above it are kept as nulls so the volume reads from 0 ms.`);
  else parts.push(`The first sample is at ${survey.delayMs} ms (trace delay, byte 109); the ${-shift} samples recorded before 0 ms are dropped.`);
  if (residual) parts.push(`The delay is not a whole number of samples: the samples move by ${shift * dtMs} ms, ${Math.abs(residual)} ms ${residual > 0 ? 'early' : 'late'}.`);
  return { ...base, applied: true, shift_samples: shift, applied_ms: shift * dtMs, residual_ms: residual, note: parts.join(' ') };
}

const NULL_IEEE_BE = (() => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, 1.0e30, false); return b.getUint32(0, false); })();
// 1.0E+30 as an IBM float word (the word segyCrop.padTopReader writes)
const NULL_IBM = (() => {
  let a = 1.0e30; let e = 64;
  while (a >= 1) { a /= 16; e += 1; }
  while (a < 1 / 16) { a *= 16; e -= 1; }
  return ((e << 24) | Math.floor(a * 0x1000000)) >>> 0;
})();

/**
 * The file with its samples moved by `shift` samples on the time axis:
 * shift > 0 puts that many nulls above every trace, shift < 0 drops that
 * many from the top. Every trace header's sample count (byte 115) follows,
 * and its delay (byte 109) becomes `delayTo` (0: the samples now start at
 * 0 ms); the binary sample count follows too. Everything else is as read.
 * @param {import('./reader').ByteReader} reader classic layout, 4-byte samples
 * @param {number} shift
 * @param {{delayTo?: number}} [opts]
 */
export async function alignTopReader(reader, shift, { delayTo = 0 } = {}) {
  if (!shift) return reader;
  const headBuf = new Uint8Array((await reader.read(0, HEAD)).slice(0));
  const hv = new DataView(headBuf.buffer);
  const ns = hv.getInt16(TEXT_HEADER_BYTES + 20, false);
  const format = hv.getInt16(TEXT_HEADER_BYTES + 24, false);
  if (format !== 1 && format !== 5) throw new Error('Moving the samples needs IBM or IEEE float samples in big-endian order.');
  const nsOut = ns + shift;
  if (nsOut < 1 || nsOut > MAX_NS) throw new Error('The shifted trace would be empty or longer than a SEG-Y trace can be.');
  hv.setInt16(TEXT_HEADER_BYTES + 20, nsOut, false);
  const src = TRACE_HEADER_BYTES + ns * 4;
  const dst = TRACE_HEADER_BYTES + nsOut * 4;
  const n = Math.floor((reader.size - HEAD) / src);
  const size = HEAD + n * dst;
  const nullWord = format === 1 ? NULL_IBM : NULL_IEEE_BE;
  const pad = Math.max(0, shift);
  const drop = Math.max(0, -shift);
  return {
    size,
    shifted: shift,
    async read(offset, length) {
      if (offset < 0 || offset + length > size) throw new Error(`Read out of range: ${offset}+${length} of ${size}`);
      const out = new Uint8Array(length);
      let filled = 0;
      if (offset < HEAD) {
        const k = Math.min(HEAD - offset, length);
        out.set(headBuf.subarray(offset, offset + k), 0);
        filled = k;
      }
      if (filled < length) {
        const start = offset + filled - HEAD;
        const t0 = Math.floor(start / dst);
        const t1 = Math.floor((offset + length - 1 - HEAD) / dst);
        const sb = new Uint8Array(await reader.read(HEAD + t0 * src, (t1 - t0 + 1) * src));
        const block = new Uint8Array((t1 - t0 + 1) * dst);
        const bv = new DataView(block.buffer);
        for (let t = 0; t <= t1 - t0; t++) {
          const so = t * src;
          const d = t * dst;
          block.set(sb.subarray(so, so + TRACE_HEADER_BYTES), d);
          bv.setInt16(d + 114, nsOut, false);
          bv.setInt16(d + 108, delayTo, false);
          for (let k = 0; k < pad; k++) bv.setUint32(d + TRACE_HEADER_BYTES + 4 * k, nullWord, false);
          block.set(sb.subarray(so + TRACE_HEADER_BYTES + 4 * drop, so + src), d + TRACE_HEADER_BYTES + 4 * pad);
        }
        const from = start - t0 * dst;
        out.set(block.subarray(from, from + (length - filled)), filled);
      }
      return out.buffer;
    },
  };
}
