// Crop before upload (owner-approved 2026-10-14): keep an inline and
// crossline area (a rectangle, a polygon, optional decimation) and a sample
// window of a SEG-Y WHILE READING IT, so only the kept traces and samples are
// ever uploaded or stored. A client's 80 GB angle stack at 1 MB/s is a day of
// upload; the QI study needs a tenth of it.
//
// Everything here works through the ByteReader interface (reader.js): the
// source is never loaded whole, and memory is bounded by one read chunk plus
// the bytes a caller asks for.
//
//   normalizeCrop        a crop definition snapped to a volume's grid
//   planRegularCrop      the kept traces of a regular inline-sorted grid, by
//                        arithmetic, with every kept header verified on read
//   planCropFromHeaders  the kept traces found from the trace headers (an
//                        irregular outline, a crossline-sorted file, gathers);
//                        an inline-sorted file is read only over the kept
//                        inlines
//   croppedSegyReader    the cropped file itself, presented as a reader: a
//                        valid SEG-Y with the source's textual header (crop
//                        cards 34 to 39 added), binary header (sample count,
//                        and rev 2 trace count, updated) and trace headers
//                        (byte 115 sample count and byte 109 delay updated;
//                        every other byte as in the source); the kept sample
//                        bytes are byte-identical to the source's
//   padTopReader         a classic-layout reader with nulls put back above a
//                        window, so a cropped volume keeps the 0 ms origin
//                        Seismolord reads every volume with
//   parseCropCard        the crop a cropped file carries, read back from its
//                        textual header
//   detectGatherLayout   prestack gathers (several traces per cell) or not
//
// Pure apart from the readers.

import { TEXT_HEADER_BYTES, BIN_HEADER_BYTES, TRACE_HEADER_BYTES } from './segyDecode.js';
import { textualHeader } from './segyWrite.js';

const HEAD = TEXT_HEADER_BYTES + BIN_HEADER_BYTES;
const MiB = 1024 * 1024;
export const CROP_SCHEMA = 1;
export const CROP_CARD_FIRST = 34; // cards 34..39 carry the crop; card 40 is left as it is
export const DEFAULT_CROP_CHUNK_BYTES = 16 * MiB;

/** Named error: a kept trace's header is not where the preview grid put it. */
export class CropGridMismatch extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CropGridMismatch';
    this.detail = detail;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Ray casting in (il, xl); points on an edge count as inside. */
export function pointInPolygon(il, xl, poly) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [ai, ax] = poly[a];
    const [bi, bx] = poly[b];
    // on the segment: collinear and within the box
    const cross = (bi - ai) * (xl - ax) - (bx - ax) * (il - ai);
    if (Math.abs(cross) < 1e-9 && il >= Math.min(ai, bi) - 1e-9 && il <= Math.max(ai, bi) + 1e-9
      && xl >= Math.min(ax, bx) - 1e-9 && xl <= Math.max(ax, bx) + 1e-9) return true;
    if ((ax > xl) !== (bx > xl)) {
      const t = ai + ((xl - ax) * (bi - ai)) / (bx - ax);
      if (il < t) inside = !inside;
    }
  }
  return inside;
}

function snapRange(req, axis, dec, label) {
  const { min, max, step } = axis;
  const s = step * dec;
  let from = isNum(req?.from) ? req.from : min;
  let to = isNum(req?.to) ? req.to : max;
  if (from > to) [from, to] = [to, from];
  // the first grid line at or after from, the last at or before to
  const a = Math.max(min, min + Math.ceil((from - min) / step - 1e-9) * step);
  let b = Math.min(max, min + Math.floor((to - min) / step + 1e-9) * step);
  if (a > b) throw new Error(`The ${label} range ${from} to ${to} holds no ${label} of this volume (it has ${min} to ${max}, step ${step}).`);
  b = a + Math.floor((b - a) / s + 1e-9) * s; // whole decimated steps from the first kept line
  return { from: a, to: b, step: s, count: Math.round((b - a) / s) + 1 };
}

/** Smallest k >= 1 with (k * dtUs) a whole number of milliseconds. */
const msPeriod = (dtUs) => {
  for (let k = 1; k <= 1000; k++) if ((k * dtUs) % 1000 === 0) return k;
  return 1000;
};

/**
 * Snap a crop definition to a volume's grid and sample axis.
 *
 * @param {Object} def {name?, il?: {from, to}, xl?: {from, to},
 *   polygon?: [[il, xl], ...], window?: {from, to} in axis units (ms for
 *   time), startAtZero?: boolean (keep from the first sample: velocity
 *   volumes), decimate?: {il, xl}}
 * @param {{il: {min, max, step}, xl: {min, max, step}, ns: number, dtUs: number, t0Ms?: number}} geom
 *   the source volume (the import scan); t0Ms is the time of its first
 *   sample when the import honours the trace delay (0 otherwise)
 * @returns {Object} the normalised crop: il and xl {from, to, step, count},
 *   polygon or null, samples {first, last, count}, window {from, to} on the
 *   axis, the source geometry, and notes on what was snapped
 */
export function normalizeCrop(def = {}, geom) {
  if (!geom?.il || !geom?.xl || !(geom.ns > 0) || !(geom.dtUs > 0)) throw new Error('The crop needs the volume geometry from the scan.');
  const ilStep = Math.max(1, Math.abs(geom.il.step || 1));
  const xlStep = Math.max(1, Math.abs(geom.xl.step || 1));
  const ilAxis = { min: geom.il.min, max: geom.il.max ?? geom.il.min + (geom.il.count - 1) * ilStep, step: ilStep };
  const xlAxis = { min: geom.xl.min, max: geom.xl.max ?? geom.xl.min + (geom.xl.count - 1) * xlStep, step: xlStep };
  const decIl = Math.max(1, Math.floor(def.decimate?.il || 1));
  const decXl = Math.max(1, Math.floor(def.decimate?.xl || 1));
  const notes = [];

  let polygon = null;
  let ilReq = def.il;
  let xlReq = def.xl;
  if (Array.isArray(def.polygon) && def.polygon.length) {
    polygon = def.polygon.map((p) => [Number(p[0]), Number(p[1])]);
    if (polygon.length < 3 || polygon.some((p) => !isNum(p[0]) || !isNum(p[1]))) {
      throw new Error('A crop polygon needs at least three corners, each an inline and a crossline number.');
    }
    // the polygon's box, cut to any rectangle given with it
    const pil = polygon.map((p) => p[0]);
    const pxl = polygon.map((p) => p[1]);
    ilReq = { from: Math.max(Math.min(...pil), ilReq?.from ?? -Infinity), to: Math.min(Math.max(...pil), ilReq?.to ?? Infinity) };
    xlReq = { from: Math.max(Math.min(...pxl), xlReq?.from ?? -Infinity), to: Math.min(Math.max(...pxl), xlReq?.to ?? Infinity) };
  }
  const il = snapRange(ilReq, ilAxis, decIl, 'inline');
  const xl = snapRange(xlReq, xlAxis, decXl, 'crossline');
  if (isNum(def.il?.from) && def.il.from !== il.from && !polygon) notes.push(`Inlines start at ${il.from}, the first inline of the volume in the range.`);
  if (isNum(def.xl?.from) && def.xl.from !== xl.from && !polygon) notes.push(`Crosslines start at ${xl.from}, the first crossline of the volume in the range.`);

  const dtMs = geom.dtUs / 1000;
  const lastSample = geom.ns - 1;
  // the time of the file's first sample (its trace delay, byte 109, when the
  // import honours it): window times are on the volume's axis, so sample k
  // of the file sits at t0 + k x dt
  const t0 = isNum(geom.t0Ms) ? geom.t0Ms : 0;
  let first = 0;
  let last = lastSample;
  if (def.window && (isNum(def.window.from) || isNum(def.window.to))) {
    let from = isNum(def.window.from) ? def.window.from : t0;
    let to = isNum(def.window.to) ? def.window.to : t0 + lastSample * dtMs;
    if (from > to) [from, to] = [to, from];
    first = Math.max(0, Math.floor((from - t0) / dtMs + 1e-9));
    last = Math.min(lastSample, Math.ceil((to - t0) / dtMs - 1e-9));
    if (first > lastSample || last < 0 || first > last) {
      throw new Error(`The window ${from} to ${to} is outside the volume's ${t0} to ${t0 + lastSample * dtMs} on the sample axis.`);
    }
  }
  if (def.startAtZero) first = 0;
  // the cropped file's delay (byte 109) is a whole number of milliseconds,
  // so the first kept sample sits on a whole millisecond
  const period = msPeriod(geom.dtUs);
  if (first % period) {
    first -= first % period;
    notes.push(`The window starts one sample earlier, at ${t0 + first * dtMs} ms, so the trace delay stays a whole number of milliseconds.`);
  }
  return {
    schema: CROP_SCHEMA,
    name: typeof def.name === 'string' ? def.name.trim().slice(0, 120) : '',
    il,
    xl,
    polygon,
    decimate: { il: decIl, xl: decXl },
    samples: { first, last, count: last - first + 1 },
    window: { from: t0 + first * dtMs, to: t0 + last * dtMs },
    startAtZero: Boolean(def.startAtZero),
    source: {
      il: { min: ilAxis.min, max: ilAxis.max, step: ilStep, count: geom.il.count ?? Math.round((ilAxis.max - ilAxis.min) / ilStep) + 1 },
      xl: { min: xlAxis.min, max: xlAxis.max, step: xlStep, count: geom.xl.count ?? Math.round((xlAxis.max - xlAxis.min) / xlStep) + 1 },
      ns: geom.ns,
      dtUs: geom.dtUs,
      ...(t0 ? { t0Ms: t0 } : {}),
    },
    notes,
  };
}

/** Is the cell (il, xl) kept by a normalised crop? */
export function cropKeeps(crop, il, xl) {
  if (il < crop.il.from || il > crop.il.to || xl < crop.xl.from || xl > crop.xl.to) return false;
  if ((il - crop.il.from) % crop.il.step !== 0 || (xl - crop.xl.from) % crop.xl.step !== 0) return false;
  return !crop.polygon || pointInPolygon(il, xl, crop.polygon);
}

/** Does the crop keep everything (nothing to cut)? */
export const cropIsWhole = (crop) => !crop.polygon
  && crop.il.from === crop.source.il.min && crop.il.to === crop.source.il.max && crop.il.step === crop.source.il.step
  && crop.xl.from === crop.source.xl.min && crop.xl.to === crop.source.xl.max && crop.xl.step === crop.source.xl.step
  && crop.samples.first === 0 && crop.samples.count === crop.source.ns;

// A plan: kept source traces as runs of consecutive traces.
function runBuilder() {
  let starts = new Float64Array(256);
  let counts = new Int32Array(256);
  let ils = new Int32Array(256);
  let xls = new Int32Array(256);
  let n = 0;
  let kept = 0;
  const grow = () => {
    const g = (A, B) => { const x = new B(A.length * 2); x.set(A); return x; };
    starts = g(starts, Float64Array); counts = g(counts, Int32Array); ils = g(ils, Int32Array); xls = g(xls, Int32Array);
  };
  return {
    add(src, il, xl, contiguous) {
      if (contiguous && n > 0 && starts[n - 1] + counts[n - 1] === src) {
        counts[n - 1] += 1;
      } else {
        if (n === starts.length) grow();
        starts[n] = src; counts[n] = 1; ils[n] = il; xls[n] = xl;
        n += 1;
      }
      kept += 1;
    },
    done(extra) {
      const cum = new Float64Array(n + 1);
      for (let r = 0; r < n; r++) cum[r + 1] = cum[r] + counts[r];
      return {
        runs: n, starts: starts.slice(0, n), counts: counts.slice(0, n), ils: ils.slice(0, n), xls: xls.slice(0, n), cum, keptTraces: kept, ...extra,
      };
    },
  };
}

/**
 * The kept traces of a regular, inline-sorted grid (nIl x nXl traces, every
 * cell present), by arithmetic. The plan says what every kept header must
 * hold; croppedSegyReader checks it on read and stops at the first trace
 * that disagrees (CropGridMismatch), because a sampled preview cannot prove
 * a file regular.
 *
 * @param {{il: {min, step, count}, xl: {min, step, count}, totalTraces: number}} scan
 * @param {Object} crop normalizeCrop()
 */
export function planRegularCrop(scan, crop) {
  const nXl = scan.xl.count;
  if (scan.il.count * nXl !== scan.totalTraces) {
    throw new Error('This file is not a full inline-sorted grid, so its kept traces are found from the trace headers.');
  }
  const ilStep = scan.il.step || 1;
  const xlStep = scan.xl.step || 1;
  const rb = runBuilder();
  for (let il = crop.il.from; il <= crop.il.to; il += crop.il.step) {
    const i = Math.round((il - scan.il.min) / ilStep);
    let prev = -2;
    for (let xl = crop.xl.from; xl <= crop.xl.to; xl += crop.xl.step) {
      if (crop.polygon && !pointInPolygon(il, xl, crop.polygon)) { prev = -2; continue; }
      const j = Math.round((xl - scan.xl.min) / xlStep);
      const src = i * nXl + j;
      rb.add(src, il, xl, prev === src - 1);
      prev = src;
    }
  }
  const plan = rb.done({ kind: 'regular', verify: true, xlStepSrc: xlStep, totalTraces: scan.totalTraces });
  if (plan.keptTraces === 0) throw new Error('The crop keeps no trace of this volume.');
  return plan;
}

// header readers honouring byte order (positions are 1-based SEG-Y bytes)
const rd32 = (dv, at, pos, le) => dv.getInt32(at + pos - 1, le);
const rd16 = (dv, at, pos, le) => dv.getInt16(at + pos - 1, le);

/**
 * The kept traces found from the trace headers: any sort order, irregular
 * outlines, prestack gathers (every trace of a kept cell is kept). An
 * inline-sorted file is searched for its first kept inline and read only up
 * to the last; any other file is read through once. Memory: one chunk.
 *
 * @param {import('./reader').ByteReader} reader the SOURCE file
 * @param {{dataStart: number, traceBytes: number, totalTraces: number, littleEndian?: boolean}} layout
 * @param {{ilByte: number, xlByte: number}} mapping
 * @param {Object} crop normalizeCrop()
 * @param {{inlineSorted?: boolean, chunkBytes?: number, onProgress?: Function, isCancelled?: Function}} [opts]
 */
export async function planCropFromHeaders(reader, layout, mapping, crop, opts = {}) {
  const { dataStart, traceBytes, totalTraces } = layout;
  const le = Boolean(layout.littleEndian);
  const { inlineSorted = false, chunkBytes = 32 * MiB, onProgress, isCancelled = () => false } = opts;
  const ilAt = async (t) => rd32(new DataView(await reader.read(dataStart + t * traceBytes, TRACE_HEADER_BYTES)), 0, mapping.ilByte, le);
  let t0 = 0;
  if (inlineSorted && totalTraces > 0) {
    // first trace with il >= crop.il.from (inline numbers rise through the file)
    let lo = 0; let hi = totalTraces;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await ilAt(mid)) < crop.il.from) lo = mid + 1; else hi = mid;
    }
    t0 = lo;
  }
  const rb = runBuilder();
  const per = Math.max(1, Math.floor(chunkBytes / traceBytes));
  let stop = false;
  for (let k0 = t0; k0 < totalTraces && !stop; k0 += per) {
    if (isCancelled()) throw new Error('Cancelled.');
    const n = Math.min(per, totalTraces - k0);
    const dv = new DataView(await reader.read(dataStart + k0 * traceBytes, n * traceBytes));
    for (let k = 0; k < n; k++) {
      const at = k * traceBytes;
      const il = rd32(dv, at, mapping.ilByte, le);
      if (inlineSorted && il > crop.il.to) { stop = true; break; }
      const xl = rd32(dv, at, mapping.xlByte, le);
      if (cropKeeps(crop, il, xl)) rb.add(k0 + k, il, xl, true);
    }
    if (onProgress) onProgress(Math.min(totalTraces, k0 + n), totalTraces);
  }
  const plan = rb.done({ kind: 'headers', verify: false, totalTraces });
  if (plan.keptTraces === 0) throw new Error('The crop keeps no trace of this file.');
  return plan;
}

/**
 * Prestack gathers or post-stack, from the first traces: gathers repeat an
 * (inline, crossline) cell over consecutive traces.
 */
export async function detectGatherLayout(reader, layout, mapping, n = 600) {
  const { dataStart, traceBytes, totalTraces } = layout;
  const le = Boolean(layout.littleEndian);
  const m = Math.min(n, totalTraces);
  if (m < 2) return { gathers: false, fold: 1 };
  const dv = new DataView(await reader.read(dataStart, m * traceBytes));
  let repeats = 0;
  const cells = new Set();
  let pIl = null; let pXl = null;
  for (let k = 0; k < m; k++) {
    const il = rd32(dv, k * traceBytes, mapping.ilByte, le);
    const xl = rd32(dv, k * traceBytes, mapping.xlByte, le);
    if (il === pIl && xl === pXl) repeats += 1;
    cells.add(`${il}/${xl}`);
    pIl = il; pXl = xl;
  }
  const gathers = repeats / (m - 1) > 0.3;
  return { gathers, fold: gathers ? m / cells.size : 1, inspected: m };
}

/** Bytes of a cropped file. */
export const croppedFileBytes = (keptTraces, samples, sampleBytes) => HEAD + keptTraces * (TRACE_HEADER_BYTES + samples * sampleBytes);

/** The textual-header cards (34 to 39) a cropped file carries. Card 35 is machine-read (parseCropCard). */
export function cropCards(crop, { sourceName = '', keptTraces = 0, sourceTraces = 0 } = {}) {
  const up = (s) => String(s).toUpperCase().replace(/[^A-Z0-9 .,:/()=_+\-#@]/g, ' ');
  const s = crop.source;
  return [
    up(`CROPPED BY PETROLORD FROM ${sourceName}`).slice(0, 76),
    `PETROLORD CROP V1 FIRST=${crop.samples.first} COUNT=${crop.samples.count} NS=${s.ns} DT=${s.dtUs}`,
    up(`CROP ${crop.name || 'CUSTOM'}: IL ${crop.il.from}-${crop.il.to}/${crop.il.step} XL ${crop.xl.from}-${crop.xl.to}/${crop.xl.step}${crop.polygon ? ' POLYGON' : ''}`).slice(0, 76),
    up(`WINDOW ${crop.window.from}-${crop.window.to} OF ${s.t0Ms || 0}-${(s.t0Ms || 0) + (s.ns - 1) * (s.dtUs / 1000)} (DELAY BYTE 109 ADDED)`).slice(0, 76),
    up(`SOURCE IL ${s.il.min}-${s.il.max}/${s.il.step} XL ${s.xl.min}-${s.xl.max}/${s.xl.step} TRACES ${sourceTraces}`).slice(0, 76),
    up(`KEPT ${keptTraces} TRACES; SAMPLE BYTES AND OTHER HEADER BYTES AS IN SOURCE`).slice(0, 76),
  ];
}

/** The crop a cropped file carries in its textual header, or null. */
export function parseCropCard(textLines) {
  for (const line of textLines || []) {
    const m = /PETROLORD CROP V1 FIRST=(\d+) COUNT=(\d+) NS=(\d+) DT=(\d+)/.exec(line);
    if (m) return { first: Number(m[1]), count: Number(m[2]), ns: Number(m[3]), dtUs: Number(m[4]) };
  }
  return null;
}

function writeCards(text, cards) {
  // the source's dialect: EBCDIC headers are padded with 0x40, ASCII with 0x20
  let e = 0; let a = 0;
  for (let i = 0; i < text.length; i++) { if (text[i] === 0x40) e += 1; else if (text[i] === 0x20) a += 1; }
  const ebcdic = e >= a;
  const lines = new Array(40).fill('');
  cards.forEach((c, k) => { lines[CROP_CARD_FIRST - 1 + k] = c; });
  const enc = textualHeader(lines);
  for (let k = 0; k < cards.length; k++) {
    const off = (CROP_CARD_FIRST - 1 + k) * 80;
    if (ebcdic) {
      text.set(enc.subarray(off, off + 80), off);
    } else {
      const card = `C${String(CROP_CARD_FIRST + k).padStart(2, ' ')} ${cards[k]}`.slice(0, 80).padEnd(80, ' ');
      for (let i = 0; i < 80; i++) text[off + i] = card.charCodeAt(i) & 0x7f;
    }
  }
}

const setBin = (dv, off, width, value, le) => {
  if (width === 2) dv.setInt16(off, value, le);
  else if (width === 4) dv.setInt32(off, value, le);
  else if (width === 8) dv.setBigUint64(off, BigInt(value), le);
};
const getBin = (dv, off, width, le) => (width === 2 ? dv.getInt16(off, le) : width === 4 ? dv.getInt32(off, le) : Number(dv.getBigUint64(off, le)));

/**
 * The cropped file as a ByteReader. Reads assemble the asked-for bytes from
 * the kept runs in source order, a chunk at a time.
 *
 * @param {import('./reader').ByteReader} source the SOURCE file as it is on disk
 * @param {{dataStart: number, sampleBytes: number, ns: number, dtUs: number, littleEndian?: boolean}} layout
 *   where the traces start (after any extended textual headers), the sample
 *   width and the source's sample count and interval (the SEG-Y door's)
 * @param {Object} plan planRegularCrop() or planCropFromHeaders()
 * @param {Object} crop normalizeCrop()
 * @param {{sourceName?: string, mapping?: {ilByte, xlByte}, chunkBytes?: number}} [opts]
 * @returns {import('./reader').ByteReader & {keptTraces: number, traceBytes: number}}
 */
export function croppedSegyReader(source, layout, plan, crop, opts = {}) {
  const le = Boolean(layout.littleEndian);
  const bps = layout.sampleBytes;
  const srcTrace = TRACE_HEADER_BYTES + layout.ns * bps;
  const { first, count } = crop.samples;
  if (first + count > layout.ns) throw new Error('The crop window runs past the end of the trace.');
  const outTrace = TRACE_HEADER_BYTES + count * bps;
  const size = croppedFileBytes(plan.keptTraces, count, bps);
  const chunkBytes = opts.chunkBytes || DEFAULT_CROP_CHUNK_BYTES;
  const mapping = opts.mapping || { ilByte: 189, xlByte: 193 };
  const addMs = (first * layout.dtUs) / 1000;
  if (!Number.isInteger(addMs)) throw new Error('The window must start on a whole millisecond.');

  let headPromise = null;
  const head = () => {
    if (!headPromise) {
      headPromise = Promise.all([source.read(0, TEXT_HEADER_BYTES), source.read(TEXT_HEADER_BYTES, BIN_HEADER_BYTES)]).then(([t, b]) => {
        const out = new Uint8Array(HEAD);
        const text = new Uint8Array(t.slice(0));
        writeCards(text, cropCards(crop, { sourceName: opts.sourceName || '', keptTraces: plan.keptTraces, sourceTraces: plan.totalTraces }));
        out.set(text, 0);
        out.set(new Uint8Array(b), TEXT_HEADER_BYTES);
        const dv = new DataView(out.buffer, TEXT_HEADER_BYTES, BIN_HEADER_BYTES);
        if (getBin(dv, 16, 2, le) <= 0) setBin(dv, 16, 2, layout.dtUs, le);   // interval taken from the trace headers
        setBin(dv, 20, 2, count, le);                                         // samples per trace
        if (getBin(dv, 68, 4, le) > 0) setBin(dv, 68, 4, count, le);          // rev 2 extended samples per trace
        setBin(dv, 304, 2, 0, le);                                            // no extended textual headers
        if (getBin(dv, 312, 8, le) > 0) setBin(dv, 312, 8, plan.keptTraces, le); // rev 2 traces in file
        if (getBin(dv, 320, 8, le) > 0) setBin(dv, 320, 8, HEAD, le);           // rev 2 offset of the first trace
        return out.buffer;
      });
    }
    return headPromise;
  };

  // run holding virtual trace v
  const runOf = (v) => {
    let lo = 0; let hi = plan.runs - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (plan.cum[mid] <= v) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  const writeTrace = (src, sat, dst, dat, r, k) => {
    // header: copied, then samples per trace (115) and delay (109) updated
    dst.set(src.subarray(sat, sat + TRACE_HEADER_BYTES), dat);
    const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const dv = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
    if (plan.verify) {
      const il = rd32(sv, sat, mapping.ilByte, le);
      const xl = rd32(sv, sat, mapping.xlByte, le);
      const eIl = plan.ils[r];
      const eXl = plan.xls[r] + k * plan.xlStepSrc;
      if (il !== eIl || xl !== eXl) {
        const at = plan.starts[r] + k;
        throw new CropGridMismatch(
          `Trace ${at + 1} has inline ${il}, crossline ${xl}; the preview grid puts inline ${eIl}, crossline ${eXl} there. `
          + 'The file is not the full regular grid the preview measured, so the kept traces must be found from the headers.',
          { trace: at, il, xl, expected: { il: eIl, xl: eXl } });
      }
    }
    dv.setInt16(dat + 114, count, le);
    if (addMs) {
      const scalar = rd16(sv, sat, 215, le);
      const unit = scalar > 1 ? scalar : scalar < 0 ? 1 / -scalar : 1; // stored value x unit = ms
      const add = addMs / unit;
      if (!Number.isInteger(add)) throw new Error(`Trace ${plan.starts[r] + k + 1}: its time scalar ${scalar} cannot hold a ${addMs} ms delay change.`);
      const delay = rd16(sv, sat, 109, le) + add;
      if (delay > 32767) throw new Error('The new trace delay does not fit byte 109.');
      dv.setInt16(dat + 108, delay, le);
    }
    // samples: the window's bytes, unchanged
    const s0 = sat + TRACE_HEADER_BYTES + first * bps;
    dst.set(src.subarray(s0, s0 + count * bps), dat + TRACE_HEADER_BYTES);
  };

  return {
    size,
    keptTraces: plan.keptTraces,
    traceBytes: outTrace,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error(`Read out of range: ${offset}+${length} of ${size}`);
      const out = new Uint8Array(length);
      let filled = 0;
      if (offset < HEAD) {
        const h = new Uint8Array(await head());
        const n = Math.min(HEAD - offset, length);
        out.set(h.subarray(offset, offset + n), 0);
        filled = n;
      }
      if (filled < length) {
        const start = offset + filled - HEAD;
        const v0 = Math.floor(start / outTrace);
        const v1 = Math.floor((offset + length - 1 - HEAD) / outTrace);
        const block = new Uint8Array((v1 - v0 + 1) * outTrace);
        let v = v0;
        let r = runOf(v0);
        while (v <= v1) {
          const k = v - plan.cum[r];               // position within run r
          const inRun = plan.counts[r] - k;
          const want = Math.min(inRun, v1 - v + 1, Math.max(1, Math.floor(chunkBytes / srcTrace)));
          const src = new Uint8Array(await source.read(layout.dataStart + (plan.starts[r] + k) * srcTrace, want * srcTrace));
          for (let q = 0; q < want; q++) writeTrace(src, q * srcTrace, block, (v - v0 + q) * outTrace, r, k + q);
          v += want;
          if (want === inRun) r += 1;
        }
        const from = start - v0 * outTrace;
        out.set(block.subarray(from, from + (length - filled)), filled);
      }
      return out.buffer;
    },
  };
}

// IBM System/360 encoding of a number (sign, base-16 exponent, 24-bit fraction)
function ibmWord(v) {
  if (v === 0) return 0;
  const sign = v < 0 ? 0x80000000 : 0;
  let a = Math.abs(v);
  let e = 64;
  while (a >= 1) { a /= 16; e += 1; }
  while (a < 1 / 16) { a *= 16; e -= 1; }
  return (sign | (e << 24) | Math.floor(a * 0x1000000)) >>> 0;
}
const NULL_IEEE_BE = (() => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, 1.0e30, false); return b.getUint32(0, false); })();
const NULL_IBM = ibmWord(1.0e30);

/**
 * A classic-layout reader (big-endian, 4-byte IBM or IEEE samples: what the
 * SEG-Y door presents) with `pad` null samples (1.0E+30) put above every
 * trace, and the delay at byte 109 reduced by the same time. A volume
 * cropped to a window that starts below 0 ms is converted through this, so
 * its samples stay on the time axis every Seismolord volume uses.
 *
 * @param {import('./reader').ByteReader} reader
 * @param {number} pad samples to add above each trace
 * @returns {Promise<import('./reader').ByteReader>} (the reader itself when pad is 0)
 */
export async function padTopReader(reader, pad) {
  if (!(pad > 0)) return reader;
  let headPromise = null;
  let hdr = null;
  const head = async () => {
    if (!headPromise) {
      headPromise = reader.read(0, HEAD).then((buf) => {
        const out = new Uint8Array(buf.slice(0));
        const dv = new DataView(out.buffer);
        const ns = dv.getInt16(TEXT_HEADER_BYTES + 20, false);
        const dtUs = dv.getInt16(TEXT_HEADER_BYTES + 16, false);
        const format = dv.getInt16(TEXT_HEADER_BYTES + 24, false);
        if (format !== 1 && format !== 5) throw new Error('Padding needs IBM or IEEE float samples in big-endian order.');
        if (ns + pad > 32767) throw new Error('The padded trace is longer than a SEG-Y trace can be.');
        dv.setInt16(TEXT_HEADER_BYTES + 20, ns + pad, false);
        hdr = { ns, dtUs, nullWord: format === 1 ? NULL_IBM : NULL_IEEE_BE, src: TRACE_HEADER_BYTES + ns * 4, dst: TRACE_HEADER_BYTES + (ns + pad) * 4 };
        hdr.n = Math.floor((reader.size - HEAD) / hdr.src);
        return out.buffer;
      });
    }
    return headPromise;
  };
  await head();
  return {
    size: HEAD + hdr.n * hdr.dst,
    padded: pad,
    async read(offset, length) {
      const h = new Uint8Array(await head());
      const size = HEAD + hdr.n * hdr.dst;
      if (offset < 0 || offset + length > size) throw new Error(`Read out of range: ${offset}+${length} of ${size}`);
      const out = new Uint8Array(length);
      let filled = 0;
      if (offset < HEAD) {
        const n = Math.min(HEAD - offset, length);
        out.set(h.subarray(offset, offset + n), 0);
        filled = n;
      }
      if (filled < length) {
        const start = offset + filled - HEAD;
        const t0 = Math.floor(start / hdr.dst);
        const t1 = Math.floor((offset + length - 1 - HEAD) / hdr.dst);
        const src = new Uint8Array(await reader.read(HEAD + t0 * hdr.src, (t1 - t0 + 1) * hdr.src));
        const block = new Uint8Array((t1 - t0 + 1) * hdr.dst);
        const bv = new DataView(block.buffer);
        const sv = new DataView(src.buffer);
        const padMs = Math.floor((pad * hdr.dtUs) / 1000);
        for (let t = 0; t <= t1 - t0; t++) {
          const so = t * hdr.src;
          const d = t * hdr.dst;
          block.set(src.subarray(so, so + TRACE_HEADER_BYTES), d);
          bv.setInt16(d + 114, hdr.ns + pad, false);
          const delay = sv.getInt16(so + 108, false);
          bv.setInt16(d + 108, Math.max(0, delay - padMs), false);
          for (let k = 0; k < pad; k++) bv.setUint32(d + TRACE_HEADER_BYTES + 4 * k, hdr.nullWord, false);
          block.set(src.subarray(so + TRACE_HEADER_BYTES, so + hdr.src), d + TRACE_HEADER_BYTES + 4 * pad);
        }
        const from = start - t0 * hdr.dst;
        out.set(block.subarray(from, from + (length - filled)), filled);
      }
      return out.buffer;
    },
  };
}

/** The provenance record a cropped volume keeps (manifest source.crop, survey_meta.ingest.crop). */
export function cropProvenance(crop, { sourceName, sourceSize, keptTraces, sourceTraces, definitionId = null, mode = 'browser' } = {}) {
  return {
    schema: CROP_SCHEMA,
    name: crop.name || null,
    definition_id: definitionId,
    mode,
    il: crop.il,
    xl: crop.xl,
    polygon: crop.polygon,
    decimate: crop.decimate,
    samples: crop.samples,
    window: crop.window,
    start_at_zero: crop.startAtZero,
    kept_traces: keptTraces,
    source: {
      file_name: sourceName || null,
      file_size: sourceSize ?? null,
      traces: sourceTraces ?? null,
      il: crop.source.il,
      xl: crop.source.xl,
      ns: crop.source.ns,
      dt_us: crop.source.dtUs,
    },
  };
}
