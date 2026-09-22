// Test fixtures for the v4 transcoder: an in-memory SEG-Y writer (IEEE or
// IBM, inline- or crossline-sorted, optional missing traces) and a
// virtual reader that synthesises a tester-shaped file on demand without
// holding it (the soak).

const TEXT = 3200;
const BIN = 400;
const TH = 240;

// IBM encode from float32 bits, truncating like most writers.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toIbm(v) {
  f32[0] = v;
  const bits = u32[0];
  const e = (bits >>> 23) & 0xff;
  if (e === 0) return 0;
  const sign = bits & 0x80000000;
  const frac = (bits & 0x7fffff) | 0x800000;
  const exp2 = e - 126;
  const e16 = Math.ceil(exp2 / 4);
  const r = 4 * e16 - exp2;
  return (sign | ((e16 + 64) << 24) | (frac >>> r)) >>> 0;
}

/** Deterministic amplitude field with structure, zeros and a few nulls. */
export function defaultAmplitude(il, xl, s) {
  if (s < 3) return 0;                                        // mute
  const v = 1000 * Math.sin(0.21 * s + 0.05 * il) * Math.cos(0.13 * xl + 0.02 * s)
    + 37 * Math.sin(il * 1.7 + xl * 0.9 + s * 2.3);
  return v;
}

/**
 * Write a SEG-Y into an ArrayBuffer.
 * @param {Object} p
 * @param {number} p.nIl @param {number} p.nXl @param {number} p.ns
 * @param {number} [p.format] 5 IEEE (default) or 1 IBM
 * @param {'inline'|'crossline'} [p.sort]
 * @param {(il:number, xl:number)=>boolean} [p.skip] cells with no trace
 * @param {(il:number, xl:number, s:number)=>number} [p.amp]
 * @param {number} [p.il0] @param {number} [p.xl0] @param {number} [p.ilStep] @param {number} [p.xlStep]
 */
export function makeSegy({
  nIl, nXl, ns, format = 5, sort = 'inline', skip = () => false, amp = defaultAmplitude,
  il0 = 100, xl0 = 200, ilStep = 1, xlStep = 1,
}) {
  const cells = [];
  if (sort === 'inline') {
    for (let i = 0; i < nIl; i++) for (let x = 0; x < nXl; x++) if (!skip(i, x)) cells.push([i, x]);
  } else {
    for (let x = 0; x < nXl; x++) for (let i = 0; i < nIl; i++) if (!skip(i, x)) cells.push([i, x]);
  }
  const traceBytes = TH + ns * 4;
  const buf = new ArrayBuffer(TEXT + BIN + cells.length * traceBytes);
  const v = new DataView(buf);
  v.setInt16(TEXT + 16, 4000, false);
  v.setInt16(TEXT + 20, ns, false);
  v.setInt16(TEXT + 24, format, false);
  const lattice = new Int32Array(nIl * nXl).fill(-1);
  cells.forEach(([i, x], t) => {
    lattice[i * nXl + x] = t;
    const off = TEXT + BIN + t * traceBytes;
    v.setInt32(off + 188, il0 + i * ilStep, false);
    v.setInt32(off + 192, xl0 + x * xlStep, false);
    v.setInt16(off + 70, -100, false);
    v.setInt32(off + 180, (500000 + x * 25) * 100, false);
    v.setInt32(off + 184, (6000000 + i * 25) * 100, false);
    for (let s = 0; s < ns; s++) {
      const a = amp(i, x, s);
      if (format === 1) v.setUint32(off + TH + s * 4, toIbm(a), false);
      else v.setFloat32(off + TH + s * 4, a, false);
    }
  });
  return { buffer: buf, lattice, traces: cells.length, traceBytes };
}

/** A scan-shaped description of a makeSegy file (what scanGeometry
 *  would measure for a regular file). */
export function scanOf({ nIl, nXl, ns, format = 5, il0 = 100, xl0 = 200, ilStep = 1, xlStep = 1 }, traces) {
  return {
    ns,
    traceBytes: TH + ns * 4,
    formatCode: format,
    totalTraces: traces ?? nIl * nXl,
    mapping: { ilByte: 189, xlByte: 193 },
    il: { min: il0, max: il0 + (nIl - 1) * ilStep, step: ilStep, count: nIl },
    xl: { min: xl0, max: xl0 + (nXl - 1) * xlStep, step: xlStep, count: nXl },
    inlineSorted: true,
  };
}

/**
 * Virtual IEEE SEG-Y reader: bytes synthesised per read, nothing held
 * beyond the requested window. Samples vary per trace (so compression
 * and quantisation see real work) through a cheap shifted template.
 */
export function virtualSegyReader({ nIl, nXl, ns, il0 = 42, xl0 = 14, onRead }) {
  const traceBytes = TH + ns * 4;
  const size = TEXT + BIN + nIl * nXl * traceBytes;
  const template = new Uint8Array((ns + 256) * 4);
  {
    const dv = new DataView(template.buffer);
    for (let s = 0; s < ns + 256; s++) {
      dv.setFloat32(s * 4, 1500 * Math.sin(s * 0.37) * Math.cos(s * 0.011) + (s % 17) - 8, false);
    }
  }
  const header = new Uint8Array(TEXT + BIN);
  {
    const dv = new DataView(header.buffer);
    dv.setInt16(TEXT + 16, 4000, false);
    dv.setInt16(TEXT + 20, ns, false);
    dv.setInt16(TEXT + 24, 5, false);
  }
  const trace = new Uint8Array(traceBytes);
  const tdv = new DataView(trace.buffer);
  return {
    size,
    traceBytes,
    async read(offset, length) {
      if (offset < 0 || offset + length > size) throw new Error(`Read out of range: ${offset}+${length} of ${size}`);
      const out = new Uint8Array(length);
      let pos = offset;
      while (pos < offset + length) {
        if (pos < TEXT + BIN) {
          const n = Math.min(TEXT + BIN - pos, offset + length - pos);
          out.set(header.subarray(pos, pos + n), pos - offset);
          pos += n;
          continue;
        }
        const t = Math.floor((pos - TEXT - BIN) / traceBytes);
        const within = pos - (TEXT + BIN + t * traceBytes);
        const n = Math.min(traceBytes - within, offset + length - pos);
        tdv.setInt32(188, il0 + Math.floor(t / nXl), false);
        tdv.setInt32(192, xl0 + (t % nXl), false);
        const shift = (t * 7) % 256;
        trace.set(template.subarray(shift * 4, shift * 4 + ns * 4), TH);
        out.set(trace.subarray(within, within + n), pos - offset);
        pos += n;
      }
      if (onRead) onRead(length);
      return out.buffer;
    },
  };
}
