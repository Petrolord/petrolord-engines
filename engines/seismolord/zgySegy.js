// A ZGY volume presented as a SEG-Y (owner request 2026-10-16). Every
// Seismolord import door (the browser conversion, the upload to the server,
// the Local Workspace, crop before upload) reads SEG-Y through the
// ByteReader interface, so a ZGY joins all of them as a virtual file: a
// valid SEG-Y rev 1, inline-sorted, IEEE float samples (format 5),
// big-endian, inline and crossline at bytes 189 and 193, CDP X and Y at 181
// and 185 with the byte-71 scalar (segyWrite.js, the reader's default
// mapping). Nothing is written to disk and the ZGY is read once on a
// sequential sweep; a sparse read (a preview, the clip pre-pass) reads only
// the traces asked for.
//
// The vertical axis: Seismolord volumes start at 0 (traceDelay.js). A ZGY
// that starts lower is padded with null samples above its first sample, the
// same top padding a SEG-Y trace delay gets; samples above 0 are dropped.
// Petrel rarely records the vertical unit in a ZGY: the textual header says
// what the file holds and the import asks for the domain as it does for
// any SEG-Y.
//
//   zgySegyLayout      the file the ZGY becomes (sizes, sample axis, notes)
//   zgySegyReader      that file as a ByteReader
//   zgyAmplitudeClip   the display clip from whole bricks, for compressed
//                      volumes (the trace-spread pre-pass would decode
//                      bricks again and again)
//
// Pure apart from the reader.

import { TEXT_HEADER_BYTES, BIN_HEADER_BYTES, TRACE_HEADER_BYTES } from './segyDecode.js';
import { textualHeader, binaryHeader, traceHeader } from './segyWrite.js';
import { zgyInlineSource, ZgyRefusal } from './zgy.js';
import { DEFAULT_CLIP_PERCENTILE, REPORTED_PERCENTILES } from './brickTranscodeV4.js';

const HEAD = TEXT_HEADER_BYTES + BIN_HEADER_BYTES;
const MAX_NS = 32767;
const NULL_VALUE = 1.0e30;
export const ZGY_SEGY_SCHEMA = 1;

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * The SEG-Y a ZGY becomes.
 * @param {Object} meta openZgy().meta
 * @param {{padTop?: boolean}} [opts]
 */
export function zgySegyLayout(meta, { padTop = true } = {}) {
  const [ni, nj, nk] = meta.size;
  const notes = [];
  // inline and crossline numbers: whole numbers in SEG-Y
  const ilOf = (i) => meta.orig[0] + meta.inc[0] * i;
  const xlOf = (j) => meta.orig[1] + meta.inc[1] * j;
  const whole = [ilOf(0), ilOf(ni - 1), xlOf(0), xlOf(nj - 1), meta.inc[0], meta.inc[1]].every((v) => near(v, Math.round(v), 1e-3));
  if (!whole) notes.push('The ZGY inline or crossline numbers are not whole numbers; they are rounded in the SEG-Y headers.');
  if (!(meta.inc[0] !== 0 && meta.inc[1] !== 0)) throw new ZgyRefusal('The ZGY inline or crossline increment is zero, so the traces cannot be numbered.', 'geometry');

  // the vertical axis in the file's unit (ms for time, as Petrel writes it)
  let unit = meta.vunitname || '';
  let scale = 1;
  if (meta.vertical === 'time') {
    if (meta.vunitfactor > 0 && near(meta.vunitfactor, 1, 1e-9) && /^s/i.test(unit)) { scale = 1000; unit = 'ms'; } // seconds -> ms
    if (!unit) unit = 'ms';
  }
  const inc = meta.inc[2] * scale;
  const z0 = meta.orig[2] * scale;
  if (!(inc > 0)) throw new ZgyRefusal('The ZGY sample interval is zero or negative.', 'geometry');
  let dtUs = Math.round(inc * 1000);
  if (!near(inc * 1000, dtUs, 1e-3)) notes.push(`The sample interval ${inc} is not a whole number of thousandths; it is taken as ${dtUs / 1000}.`);
  if (dtUs < 1 || dtUs > 65535) throw new ZgyRefusal(`The ZGY sample interval (${inc}) is outside what a SEG-Y header can hold.`, 'geometry');

  let pad = 0;
  let drop = 0;
  if (padTop && z0 !== 0) {
    const shift = Math.round(z0 / (dtUs / 1000));
    const residual = z0 - shift * (dtUs / 1000);
    if (shift > 0) pad = shift;
    else if (shift < 0) drop = Math.min(-shift, nk - 1);
    if (pad) notes.push(`The first sample is at ${z0}${unit ? ` ${unit}` : ''}; the ${pad} samples above it are kept as nulls so the volume reads from 0.`);
    if (drop) notes.push(`The first sample is at ${z0}${unit ? ` ${unit}` : ''}; the ${drop} samples above 0 are dropped.`);
    if (residual && Math.abs(residual) > 1e-6) notes.push(`The first sample is not a whole number of samples from 0: it moves by ${Math.abs(residual)}${unit ? ` ${unit}` : ''}.`);
  }
  const ns = nk + pad - drop;
  if (ns > MAX_NS) throw new ZgyRefusal(`The traces would be ${ns} samples long with the samples above the first one kept, more than SEG-Y holds (${MAX_NS}).`, 'geometry');
  if (meta.corners == null) notes.push('The ZGY holds no usable world coordinates; the traces carry zero coordinates.');
  if (meta.dtype !== 'float32') notes.push(`The ZGY stores ${meta.dtype} samples; they are scaled to amplitudes with the file's coding range (${meta.codingRange.map((v) => +v.toPrecision(6)).join(' to ')}).`);

  // coordinates: centimetres while they fit
  let coordScalar = -100;
  if (meta.corners) {
    const maxAbs = Math.max(...meta.corners.flat().map(Math.abs));
    if (maxAbs * 100 > 2147483647) coordScalar = maxAbs * 10 > 2147483647 ? 1 : -10;
  }
  const traceBytes = TRACE_HEADER_BYTES + 4 * ns;
  return {
    schema: ZGY_SEGY_SCHEMA,
    ni, nj, nk, ns, pad, drop, dtUs, unit, z0,
    vertical: meta.vertical,
    traceBytes,
    traces: ni * nj,
    size: HEAD + ni * nj * traceBytes,
    il: { first: Math.round(ilOf(0)), step: Math.round(meta.inc[0]) },
    xl: { first: Math.round(xlOf(0)), step: Math.round(meta.inc[1]) },
    ilOf: (i) => Math.round(ilOf(i)),
    xlOf: (j) => Math.round(xlOf(j)),
    coordScalar,
    measurementSystem: /^f/i.test(meta.hunitname || '') ? 2 : 1,
    notes,
  };
}

function textCards(meta, lay, sourceName) {
  const vert = lay.vertical === 'depth' ? `DEPTH (${(lay.unit || 'unit not recorded').toUpperCase()})`
    : lay.vertical === 'time' ? `TWO-WAY TIME (${lay.unit.toUpperCase()})` : 'NOT RECORDED IN THE ZGY';
  const name = String(sourceName || meta.srcname || 'volume.zgy').replace(/[^\x20-\x7e]/g, '?');
  const lines = [
    'PETROLORD SEISMOLORD: SEG-Y VIEW OF A ZGY VOLUME (READ IN PLACE)',
    `PETROLORD ZGY V${ZGY_SEGY_SCHEMA} SOURCE=${name}`.slice(0, 76),
    `ZGY VERSION ${meta.version}  STORED AS ${meta.dtype.toUpperCase()}${meta.compressedBricks ? '  ZFP COMPRESSED' : ''}`,
    `SURVEY ${lay.ni} INLINES X ${lay.nj} CROSSLINES X ${lay.nk} SAMPLES`,
    `INLINES ${lay.ilOf(0)} TO ${lay.ilOf(lay.ni - 1)} STEP ${lay.il.step}  CROSSLINES ${lay.xlOf(0)} TO ${lay.xlOf(lay.nj - 1)} STEP ${lay.xl.step}`,
    `VERTICAL AXIS: ${vert}`,
    `FIRST SAMPLE IN THE ZGY ${lay.z0}  SAMPLE INTERVAL ${lay.dtUs / 1000}${lay.pad ? `  ${lay.pad} NULL SAMPLES ADDED ABOVE` : ''}${lay.drop ? `  ${lay.drop} SAMPLES ABOVE 0 DROPPED` : ''}`,
    'INLINE BYTE 189  CROSSLINE BYTE 193  CDP X BYTE 181  CDP Y BYTE 185  SCALAR BYTE 71',
    'IEEE FLOAT SAMPLES (FORMAT 5)  NULL 1.0E+30',
  ];
  if (meta.hprjsys) lines.push(`ZGY PROJECTION: ${meta.hprjsys}`.slice(0, 76));
  if (meta.hunitname) lines.push(`ZGY HORIZONTAL UNIT: ${meta.hunitname.toUpperCase()}`);
  lines.push('READ WITH A READER WRITTEN FROM THE OPENZGY FORMAT (APACHE-2.0)');
  return lines;
}

/**
 * A ZGY as a SEG-Y ByteReader.
 * @param {Awaited<ReturnType<typeof import('./zgy.js').openZgy>>} zgy
 * @param {{sourceName?: string, padTop?: boolean, cacheBytes?: number}} [opts]
 */
export function zgySegyReader(zgy, { sourceName = '', padTop = true, cacheBytes } = {}) {
  const meta = zgy.meta;
  const lay = zgySegyLayout(meta, { padTop });
  const src = zgyInlineSource(zgy, cacheBytes ? { cacheBytes } : {});
  const head = new Uint8Array(HEAD);
  head.set(textualHeader(textCards(meta, lay, sourceName)), 0);
  head.set(binaryHeader({ dtUs: lay.dtUs, ns: lay.ns, measurementSystem: lay.measurementSystem }), TEXT_HEADER_BYTES);
  const { nj, nk, ns, pad, drop, traceBytes } = lay;
  const world = meta.indexToWorld;

  let lastInline = -1;
  let inlineBuf = null;
  const traceBuf = new Float32Array(nk);

  const headerOf = (t) => {
    const i = Math.floor(t / nj); const j = t - i * nj;
    const [x, y] = world ? world(i, j) : [0, 0];
    return traceHeader({ seq: t + 1, il: lay.ilOf(i), xl: lay.xlOf(j), x, y, ns, dtUs: lay.dtUs, coordScalar: lay.coordScalar });
  };
  /** The big-endian sample bytes of trace t (from samples, nk of them at s0). */
  const writeSamples = (dv, at, samples, s0) => {
    let p = at;
    for (let s = 0; s < pad; s++, p += 4) dv.setFloat32(p, NULL_VALUE, false);
    for (let k = drop; k < nk; k++, p += 4) {
      const v = samples[s0 + k];
      dv.setFloat32(p, Number.isFinite(v) ? v : NULL_VALUE, false);
    }
  };

  return {
    size: lay.size,
    zgy: { layout: lay, meta },
    stats: src.stats,
    async read(offset, length) {
      if (offset < 0 || offset + length > lay.size) throw new Error(`Read out of range: ${offset}+${length} of ${lay.size}`);
      const out = new Uint8Array(length);
      let filled = 0;
      if (offset < HEAD) {
        const k = Math.min(HEAD - offset, length);
        out.set(head.subarray(offset, offset + k), 0);
        filled = k;
      }
      if (filled === length) return out.buffer;
      const start = offset + filled - HEAD;
      const t0 = Math.floor(start / traceBytes);
      const t1 = Math.floor((offset + length - 1 - HEAD) / traceBytes);
      // traces per inline in this read: a run of them reads whole inlines,
      // a scattered few read single traces
      const block = new Uint8Array(traceBytes);
      const bv = new DataView(block.buffer);
      for (let t = t0; t <= t1; t++) {
        const tStart = t * traceBytes;
        const a = Math.max(start, tStart) - tStart; // bytes of this trace wanted
        const b = Math.min(start + (length - filled), tStart + traceBytes) - tStart;
        if (a < TRACE_HEADER_BYTES) block.set(headerOf(t), 0);
        if (b > TRACE_HEADER_BYTES) {
          const i = Math.floor(t / nj); const j = t - i * nj;
          const inRead = Math.min(t1, (i + 1) * nj - 1) - Math.max(t0, i * nj) + 1;
          if (i === lastInline || inRead >= Math.max(8, nj / 4)) {
            if (i !== lastInline) { inlineBuf = await src.inline(i, inlineBuf || undefined); lastInline = i; }
            writeSamples(bv, TRACE_HEADER_BYTES, inlineBuf, j * nk);
          } else {
            await src.trace(i, j, traceBuf);
            writeSamples(bv, TRACE_HEADER_BYTES, traceBuf, 0);
          }
        }
        out.set(block.subarray(a, b), HEAD + tStart + a - offset);
      }
      return out.buffer;
    },
  };
}

/**
 * The display clip (|amplitude| percentiles, the sampleAmplitudeClip
 * shape) from whole level-0 bricks spread evenly through the volume, every
 * `stride`-th sample: for compressed volumes, where the trace-spread
 * pre-pass would decode each brick many times. Deterministic.
 * @param {Awaited<ReturnType<typeof import('./zgy.js').openZgy>>} zgy
 * @param {{bricks?: number, stride?: number, percentile?: number}} [opts]
 */
export async function zgyAmplitudeClip(zgy, { bricks = 64, stride = 4, percentile = DEFAULT_CLIP_PERCENTILE } = {}) {
  const m = zgy.meta;
  const bs = m.bricksize;
  const [nbi, nbj, nbk] = m.lodsizes[0];
  const total = nbi * nbj * nbk;
  const want = Math.min(total, bricks);
  const picks = [];
  for (let n = 0; n < want; n++) picks.push(Math.min(total - 1, Math.floor(((n + 0.5) * total) / want)));
  const vals = [];
  let maxAbs = 0;
  for (const p of picks) {
    const bi = p % nbi; const bj = Math.floor(p / nbi) % nbj; const bk = Math.floor(p / (nbi * nbj));
    const { data } = await zgy.readBrick(bi, bj, bk, 0);
    const ni = Math.min(bs[0], m.size[0] - bi * bs[0]);
    const nj = Math.min(bs[1], m.size[1] - bj * bs[1]);
    const nk = Math.min(bs[2], m.size[2] - bk * bs[2]);
    let c = 0;
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) for (let k = 0; k < nk; k++) {
      if (c++ % stride) continue;
      const v = data[(i * bs[1] + j) * bs[2] + k];
      if (!(Math.abs(v) < 1.0e29)) continue;
      const a = Math.abs(v);
      vals.push(a);
      if (a > maxAbs) maxAbs = a;
    }
  }
  const sorted = Float32Array.from(vals).sort();
  const at = (q) => {
    if (!sorted.length) return 0;
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil((q / 100) * sorted.length)));
    return sorted[rank - 1];
  };
  const percentiles = {};
  for (const q of REPORTED_PERCENTILES) percentiles[String(q)] = at(q);
  let clip = at(percentile);
  if (!(clip > 0)) clip = maxAbs > 0 ? maxAbs : 1;
  return { clip, percentile, traces: 0, bricks: picks.length, samples: sorted.length, maxAbs, percentiles };
}
