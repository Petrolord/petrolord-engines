// ZGY reader (Petrel's bricked seismic volume format, owner request
// 2026-10-16: a client's legacy seismic is .zgy). Reads ZGY versions 1 to 4:
// uncompressed int8, int16 and float32 volumes from every Petrel and
// OpenZGY release, and the ZFP-compressed float32 volumes OpenZGY and
// Petrel 2022.1 onwards write. Legacy Petrel compressed files (magic
// "VCS\0", the closed pre-2022 codec) cannot be read by any open library;
// they are refused with the re-export advice.
//
// Written from the OpenZGY format description and its Apache-2.0 reference
// sources (Copyright 2017-2021 Schlumberger;
// https://community.opengroup.org/osdu/platform/domain-data-mgmt-services/seismic/open-zgy,
// python/openzgy/impl/{meta,bulk,transform}.py at v0.17.0), and validated
// against files OpenZGY wrote and read back (test-data/seismolord/zgy).
//
//   openZgy             headers, geometry and brick access over a ByteReader
//   zgyInlineSource     one inline (or one trace) at a time, bounded memory:
//                       the access a virtual SEG-Y needs (zgySegy.js)
//
// Layout facts the reader relies on:
//   - everything little-endian; v1 stores each 64-bit integer as two
//     uint32 halves, HIGH half first
//   - a brick is 64^3 samples in C order [inline][crossline][sample]
//     (sample fastest), except v1, which tiles each brick in 8 x 8 trace
//     groups: for ii, jj in steps of 8, for si in ii..ii+7, sj in jj..jj+7,
//     k in 0..63. So one inline of a v2+ brick is one contiguous run, and
//     eight inlines of a v1 brick are one contiguous run
//   - the brick lookup table lists the coarsest level of detail first;
//     within a level the index is i + ni*j + ni*nj*k (inline fastest)
//   - entry top byte: 0 with value 0 missing, value 1 constant 0, 0x80
//     constant (value in the low bytes, storage type), 0xC0 ZFP brick
//     (size: up to the next brick start), any other top-bit value an error,
//     else a plain brick at that offset
//   - storage to float: slope = (range1 - range0) / (hi - lo),
//     float = storage * slope + range0 - slope * lo (int types only)
//
// Pure apart from the reader. ZFP decoding is injected (zfpDecode:
// Uint8Array -> Float32Array in brick order) so the engines keep no runtime
// dependency; the Suite passes a WebAssembly build of LLNL zfp.

const TWO32 = 4294967296;

/** Named refusal with a user-facing message and a stable code. */
export class ZgyRefusal extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZgyRefusal';
    this.code = code;
  }
}

export const ZGY_DATATYPES = Object.freeze({
  0: { name: 'int8', bytes: 1, range: [-128, 127], Array: Int8Array },
  1: { name: 'uint8', bytes: 1, range: [0, 255], Array: Uint8Array },
  2: { name: 'int16', bytes: 2, range: [-32768, 32767], Array: Int16Array },
  3: { name: 'uint16', bytes: 2, range: [0, 65535], Array: Uint16Array },
  4: { name: 'int32', bytes: 4, range: [-2147483648, 2147483647], Array: Int32Array },
  5: { name: 'uint32', bytes: 4, range: [0, 4294967295], Array: Uint32Array },
  6: { name: 'float32', bytes: 4, range: null, Array: Float32Array },
});

/** The vertical domain code at InfoHeader byte 324 (the spec's prose has TWT and depth swapped; the code is right). */
export const ZGY_VDIM = Object.freeze({ 0: 'unknown', 1: 'depth', 2: 'time', 3: 'time' });

const LEGACY_ADVICE = 'This ZGY was written with the old Petrel compression, which only Petrel itself can read. '
  + 'In Petrel, export the volume as SEG-Y (or save it again as ZGY in Petrel 2022.1 or later) and import that file.';

/** Brick counts per level: level 0 is ceil(size/brick), each next level halves (rounding up) until all three are 1. */
export function zgyLodSizes(size, brick) {
  let s = [0, 1, 2].map((d) => Math.ceil(size[d] / brick[d]));
  const out = [s];
  while (Math.max(...s) > 1) {
    s = s.map((n) => (n + 1) >> 1);
    out.push(s);
  }
  return out;
}

/** Table start of each level (coarsest level first), the total last. */
function lutStarts(lods, alpha) {
  const res = new Array(lods.length + 1);
  let pos = 0;
  for (let l = lods.length - 1; l >= 0; l--) {
    res[l] = pos;
    const e = lods[l];
    pos += e[0] * e[1] * (alpha ? 1 : e[2]);
  }
  res[lods.length] = pos;
  return res;
}

/**
 * Index-to-world geometry from the three control points (OpenZGY
 * transform.py generalTransform: only the first three annotation/world
 * pairs are trusted). Returns the four ordered corners (first il first xl,
 * last il first xl, first il last xl, last il last xl) and the affine
 * index -> world, or null corners when the points are degenerate.
 */
export function zgyGeometry({ orig, inc, size, gpiline, gpxline, gpx, gpy }) {
  const last = [orig[0] + inc[0] * (size[0] - 1), orig[1] + inc[1] * (size[1] - 1)];
  const annot = [[orig[0], orig[1]], [last[0], orig[1]], [orig[0], last[1]], [last[0], last[1]]];
  const noWorld = gpx[0] === gpx[1] && gpy[0] === gpy[1] && gpx[0] === gpx[2] && gpy[0] === gpy[2];
  const noAnnot = gpiline[0] === gpiline[1] && gpxline[0] === gpxline[1] && gpiline[0] === gpiline[2] && gpxline[0] === gpxline[2];
  let corners = null;
  if (noWorld) {
    corners = null;
  } else if (noAnnot) {
    corners = [0, 1, 2, 3].map((n) => [gpx[n], gpy[n]]);   // world points given as the corners themselves
  } else {
    const ax1 = gpiline[1] - gpiline[0]; const ay1 = gpxline[1] - gpxline[0];
    const ax2 = gpiline[2] - gpiline[0]; const ay2 = gpxline[2] - gpxline[0];
    const det = ax1 * ay2 - ax2 * ay1;
    if (Math.abs(det) >= 1e-6) {
      const toWorld = (a, b) => {
        const xq = a - gpiline[0]; const yq = b - gpxline[0];
        const s = (xq * ay2 - ax2 * yq) / det;
        const t = (ax1 * yq - xq * ay1) / det;
        return [gpx[0] + s * (gpx[1] - gpx[0]) + t * (gpx[2] - gpx[0]), gpy[0] + s * (gpy[1] - gpy[0]) + t * (gpy[2] - gpy[0])];
      };
      corners = annot.map(([a, b]) => toWorld(a, b));
    }
  }
  let indexToWorld = null;
  if (corners) {
    const ni = Math.max(1, size[0] - 1); const nj = Math.max(1, size[1] - 1);
    const di = [(corners[1][0] - corners[0][0]) / ni, (corners[1][1] - corners[0][1]) / ni];
    const dj = [(corners[2][0] - corners[0][0]) / nj, (corners[2][1] - corners[0][1]) / nj];
    const [x0, y0] = corners[0];
    indexToWorld = (i, j) => [x0 + i * di[0] + j * dj[0], y0 + i * di[1] + j * dj[1]];
  }
  return { annotCorners: annot, corners, indexToWorld };
}

const u8 = async (reader, offset, length) => new Uint8Array(await reader.read(offset, length));
const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Open a ZGY file: headers, geometry, scaling and the brick lookup table
 * (8 bytes per brick, one read). Nothing else is read until asked for.
 * @param {import('./reader').ByteReader} reader
 * @param {{zfpDecode?: (bytes: Uint8Array) => Float32Array}} [opts]
 */
export async function openZgy(reader, { zfpDecode = null } = {}) {
  if (reader.size < 16) throw new ZgyRefusal('The file is too small to be a ZGY volume.', 'not-zgy');
  const fh = await u8(reader, 0, 8);
  const magic = String.fromCharCode(fh[0], fh[1], fh[2]);
  if (fh[3] === 0 && magic === 'VCS') throw new ZgyRefusal(LEGACY_ADVICE, 'legacy-compressed');
  if (fh[3] !== 0 || magic !== 'VBS') throw new ZgyRefusal('This is not a ZGY volume (the file does not start with the ZGY signature).', 'not-zgy');
  const version = dvOf(fh).getUint32(4, true);
  if (version < 1 || version > 4) {
    throw new ZgyRefusal(`This ZGY is version ${version}; Seismolord reads versions 1 to 4. Export the volume as SEG-Y and import that.`, 'version');
  }
  const m = { version };
  let brickLutAt;
  let alphaLutAt;
  if (version === 1) {
    const d = dvOf(await u8(reader, 8, 32));
    const q = (n) => d.getUint32(n, true) * TWO32 + d.getUint32(n + 4, true); // high half first
    const at = { info: q(0), alpha: q(8), brick: q(16), hist: q(24) };
    const id = dvOf(await u8(reader, at.info, 146));
    const i32 = (o, n) => Array.from({ length: n }, (_, x) => id.getInt32(o + 4 * x, true));
    const f64 = (o, n) => Array.from({ length: n }, (_, x) => id.getFloat64(o + 8 * x, true));
    Object.assign(m, {
      size: i32(0, 3), orig: i32(12, 3), inc: i32(24, 3), gpiline: i32(48, 4), gpxline: i32(64, 4),
      gpx: f64(80, 4), gpy: f64(112, 4), datatype: id.getUint8(144), bricksize: [64, 64, 64],
    });
    const coordtype = id.getUint8(145);
    const hu = { 1: ['m', 1], 2: ['ft', 0.3048], 3: ['arcsec', 1], 4: ['deg', 1] }[coordtype] || ['', 1];
    Object.assign(m, { hdim: coordtype === 3 || coordtype === 4 ? 2 : coordtype ? 1 : 0, hunitname: hu[0], hunitfactor: hu[1], vdim: 0, vunitname: '', vunitfactor: 1 });
    const hd = dvOf(await u8(reader, at.hist, 8));
    m.codingRange = [hd.getFloat32(4, true), hd.getFloat32(0, true)]; // v1 histogram: "max" first, then "min"
    Object.assign(m, { srcname: '', srcdesc: '', hprjsys: '' });
    brickLutAt = at.brick;
    alphaLutAt = at.alpha;
  } else {
    const d = dvOf(await u8(reader, 9, 337));
    const i32 = (o, n) => Array.from({ length: n }, (_, x) => d.getInt32(o + 4 * x, true));
    const f32 = (o, n) => Array.from({ length: n }, (_, x) => d.getFloat32(o + 4 * x, true));
    const f64 = (o, n) => Array.from({ length: n }, (_, x) => d.getFloat64(o + 8 * x, true));
    Object.assign(m, {
      bricksize: i32(0, 3), datatype: d.getUint8(12), codingRange: f32(13, 2),
      orig: f32(70, 3), inc: f32(82, 3), size: i32(94, 3),
      smin: d.getFloat32(154, true), smax: d.getFloat32(158, true),
      gpiline: f32(219, 4), gpxline: f32(235, 4), gpx: f64(251, 4), gpy: f64(283, 4),
      hdim: d.getUint8(315), hunitfactor: d.getFloat64(316, true),
      vdim: d.getUint8(324), vunitfactor: d.getFloat64(325, true),
    });
    const slbufsize = d.getUint32(333, true);
    const sl = slbufsize ? await u8(reader, 346, slbufsize) : new Uint8Array(0);
    const strs = Array.from(sl, (c) => String.fromCharCode(c)).join('').split('\0');
    [m.srcname, m.srcdesc, m.hprjsys, m.hunitname, m.vunitname] = [0, 1, 2, 3, 4].map((n) => strs[n] || '');
    alphaLutAt = 346 + slbufsize + 2064; // after the 2064-byte histogram
  }
  const dt = ZGY_DATATYPES[m.datatype];
  if (!dt) throw new ZgyRefusal(`The ZGY sample type (code ${m.datatype}) is not one Seismolord reads (int8, int16 or float32).`, 'datatype');
  m.dtype = dt.name;
  if (!m.size.every((n) => Number.isInteger(n) && n > 0) || !m.bricksize.every((n) => Number.isInteger(n) && n > 0 && n <= 1024)) {
    throw new ZgyRefusal('The ZGY header is damaged (the survey or brick size is not valid).', 'header');
  }
  const bs = m.bricksize;
  m.lodsizes = zgyLodSizes(m.size, bs);
  m.nlods = m.lodsizes.length;
  const brickStarts = lutStarts(m.lodsizes, false);
  if (version !== 1) brickLutAt = alphaLutAt + 8 * lutStarts(m.lodsizes, true)[m.nlods];

  // storage -> float
  if (dt.range) {
    const [lo, hi] = dt.range;
    let r = m.codingRange;
    if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[1] <= r[0]) r = [lo, hi];
    m.slope = (r[1] - r[0]) / (hi - lo);
    m.intercept = r[0] - m.slope * lo;
    let s = -m.intercept / m.slope;
    s = s <= lo ? lo : s >= hi ? hi : s < 0 ? Math.trunc(s - 0.5) : Math.trunc(s + 0.5);
    m.defaultStorage = s;
  } else {
    m.slope = 1; m.intercept = 0; m.defaultStorage = 0;
  }
  m.defaultValue = m.defaultStorage * m.slope + m.intercept;
  Object.assign(m, zgyGeometry(m));
  m.vertical = ZGY_VDIM[m.vdim] || 'unknown';

  // brick lookup table as two uint32 halves (no BigInt in the hot path)
  const nb = brickStarts[m.nlods];
  if (brickLutAt + 8 * nb > reader.size) throw new ZgyRefusal('The ZGY file is cut short (its brick table runs past the end of the file).', 'truncated');
  const ld = dvOf(await u8(reader, brickLutAt, 8 * nb));
  const hiA = new Uint32Array(nb);
  const loA = new Uint32Array(nb);
  for (let n = 0; n < nb; n++) {
    const a = ld.getUint32(8 * n, true);
    const b = ld.getUint32(8 * n + 4, true);
    if (version === 1) { hiA[n] = a; loA[n] = b; } else { loA[n] = a; hiA[n] = b; }
  }
  // a compressed brick ends where the next stored brick starts (or at EOF)
  const starts = [];
  let compressed = 0;
  for (let n = 0; n < nb; n++) {
    const t = hiA[n] >>> 24;
    if (t === 0x80 || (hiA[n] === 0 && loA[n] < 2)) continue;
    if (t === 0xc0) compressed++;
    starts.push((hiA[n] & 0xffffff) * TWO32 + loA[n]);
  }
  starts.sort((a, b) => a - b);
  m.compressedBricks = compressed;
  const brickSamples = bs[0] * bs[1] * bs[2];
  const brickBytes = brickSamples * dt.bytes;
  const endOf = (beg) => {
    let lo = 0; let hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= beg) lo = mid + 1; else hi = mid; }
    const e = lo < starts.length ? starts[lo] : reader.size;
    return Math.max(beg, Math.min(e, reader.size, beg + brickBytes));
  };
  const constView = new DataView(new ArrayBuffer(8));

  /** A brick's entry: {status: missing|constant|compressed|normal, value?, offset?, size?}. */
  function entry(i, j, k, lod = 0) {
    const s = m.lodsizes[lod];
    const ix = brickStarts[lod] + i + s[0] * j + s[0] * s[1] * k;
    const hi = hiA[ix]; const lo = loA[ix]; const t = hi >>> 24;
    if (hi === 0 && lo === 0) return { status: 'missing', value: m.defaultValue };
    if (hi === 0 && lo === 1) return { status: 'constant', value: m.intercept };
    if (t === 0x80) {
      constView.setUint32(0, lo, true); constView.setUint32(4, hi, true);
      let raw;
      switch (dt.name) {
        case 'int8': raw = constView.getInt8(0); break;
        case 'uint8': raw = constView.getUint8(0); break;
        case 'int16': raw = constView.getInt16(0, true); break;
        case 'uint16': raw = constView.getUint16(0, true); break;
        case 'int32': raw = constView.getInt32(0, true); break;
        case 'uint32': raw = constView.getUint32(0, true); break;
        default: raw = constView.getFloat32(0, true);
      }
      return { status: 'constant', value: raw * m.slope + m.intercept };
    }
    if (t === 0xc0) {
      const beg = (hi & 0xffffff) * TWO32 + lo;
      return { status: 'compressed', offset: beg, size: endOf(beg) - beg };
    }
    if (t & 0x80) throw new ZgyRefusal(`The ZGY brick table is damaged (unknown brick type 0x${t.toString(16)}).`, 'brick-type');
    const offset = hi * TWO32 + lo;
    if (offset + brickBytes > reader.size) throw new ZgyRefusal('The ZGY file is cut short (a brick lies past the end of the file).', 'truncated');
    return { status: 'normal', offset, size: brickBytes };
  }

  let v1map = null;
  const v1Unscramble = (a) => {
    if (!v1map) {
      v1map = new Int32Array(brickSamples);
      let p = 0;
      for (let ii = 0; ii < 64; ii += 8) for (let jj = 0; jj < 64; jj += 8) {
        for (let si = ii; si < ii + 8; si++) for (let sj = jj; sj < jj + 8; sj++) for (let sk = 0; sk < 64; sk++) v1map[p++] = si * 4096 + sj * 64 + sk;
      }
    }
    const out = new a.constructor(a.length);
    for (let p = 0; p < a.length; p++) out[v1map[p]] = a[p];
    return out;
  };

  // Bulk scaling in single precision with the factors rounded to float32,
  // exactly as OpenZGY does it (bulk.py _scaleToFloat: data.astype(float32)
  // *= a; += b), so integer volumes read bit for bit as OpenZGY reads them.
  const fSlope = Math.fround(m.slope);
  const fIntercept = Math.fround(m.intercept);
  /** Storage values (a typed array over a fresh buffer) -> float32. */
  const toFloat = (stored, out = new Float32Array(stored.length)) => {
    if (dt.name === 'float32') { out.set(stored); return out; }
    for (let p = 0; p < stored.length; p++) out[p] = Math.fround(stored[p] * fSlope) + fIntercept;
    return out;
  };
  const typed = (bytes) => new dt.Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / dt.bytes);

  /** Decode a compressed brick to float (ZFP briks are float32 only). */
  const decodeZfp = (bytes) => {
    if (!zfpDecode) throw new ZgyRefusal('This ZGY is compressed (ZFP) and no ZFP decoder is available here.', 'no-zfp');
    const f = zfpDecode(bytes);
    if (!f || f.length < brickSamples) throw new ZgyRefusal('A compressed ZGY brick did not decode to a full brick.', 'zfp');
    return f.length === brickSamples ? f : f.subarray(0, brickSamples);
  };

  /**
   * One whole brick as float32 (brick order: inline slowest, sample fastest).
   * @returns {Promise<{status: string, data: Float32Array}>}
   */
  async function readBrick(i, j, k, lod = 0) {
    const e = entry(i, j, k, lod);
    if (e.status === 'missing' || e.status === 'constant') return { status: e.status, data: new Float32Array(brickSamples).fill(e.value) };
    const bytes = await u8(reader, e.offset, e.size);
    if (e.status === 'compressed') return { status: e.status, data: Float32Array.from(decodeZfp(bytes)) };
    let a = typed(bytes);
    if (version === 1) a = v1Unscramble(a);
    return { status: e.status, data: toFloat(a) };
  }

  /**
   * A sub-volume as float32 in C order (inline slowest, sample fastest).
   * Brick by brick; for tests and small reads (memory = the sub-volume).
   */
  async function read(start, count, lod = 0) {
    const out = new Float32Array(count[0] * count[1] * count[2]);
    const b0 = [0, 1, 2].map((d) => Math.floor(start[d] / bs[d]));
    const b1 = [0, 1, 2].map((d) => Math.floor((start[d] + count[d] - 1) / bs[d]));
    for (let bi = b0[0]; bi <= b1[0]; bi++) for (let bj = b0[1]; bj <= b1[1]; bj++) for (let bk = b0[2]; bk <= b1[2]; bk++) {
      const { data } = await readBrick(bi, bj, bk, lod);
      const o = [bi * bs[0], bj * bs[1], bk * bs[2]];
      const lo = [0, 1, 2].map((d) => Math.max(start[d], o[d]));
      const hi = [0, 1, 2].map((d) => Math.min(start[d] + count[d], o[d] + bs[d]));
      for (let x = lo[0]; x < hi[0]; x++) for (let y = lo[1]; y < hi[1]; y++) {
        const src = ((x - o[0]) * bs[1] + (y - o[1])) * bs[2] - o[2];
        const dst = ((x - start[0]) * count[1] + (y - start[1])) * count[2] - start[2];
        for (let z = lo[2]; z < hi[2]; z++) out[dst + z] = data[src + z];
      }
    }
    return out;
  }

  /**
   * Inlines li0..li0+n-1 (local to the brick, all crosslines and samples
   * of the brick) of a level-0 brick as float32, read as one contiguous run
   * for plain v2+ bricks; null for a compressed brick (decode the whole brick).
   * v1 needs n = 8 and li0 a multiple of 8 (its 8 x 8 tiling).
   */
  async function readBrickInlines(i, j, k, li0, n) {
    const e = entry(i, j, k, 0);
    const per = bs[1] * bs[2];
    if (e.status === 'missing' || e.status === 'constant') return new Float32Array(n * per).fill(e.value);
    if (e.status === 'compressed') return null;
    if (version === 1) {
      if (n !== 8 || li0 % 8) throw new Error('A v1 brick is read in aligned groups of 8 inlines.');
      const bytes = await u8(reader, e.offset + li0 * per * dt.bytes, 8 * per * dt.bytes);
      const a = typed(bytes);
      // the run is the 8 inlines tiled by 8 crosslines: for jj, for si, for sj, for k
      const out = new Float32Array(8 * per);
      let p = 0;
      for (let jj = 0; jj < bs[1]; jj += 8) for (let si = 0; si < 8; si++) for (let sj = jj; sj < jj + 8; sj++) {
        const d = (si * bs[1] + sj) * bs[2];
        for (let z = 0; z < bs[2]; z++) out[d + z] = a[p++];
      }
      return toFloat(out, out);
    }
    const bytes = await u8(reader, e.offset + li0 * per * dt.bytes, n * per * dt.bytes);
    return toFloat(typed(bytes));
  }

  /** One trace's 64-sample run of a plain v2+ brick (local inline li, crossline lj), as float32; null if the brick needs a whole read. */
  async function readBrickTrace(i, j, k, li, lj) {
    const e = entry(i, j, k, 0);
    if (e.status === 'missing' || e.status === 'constant') return new Float32Array(bs[2]).fill(e.value);
    if (e.status === 'compressed' || version === 1) return null;
    const bytes = await u8(reader, e.offset + (li * bs[1] + lj) * bs[2] * dt.bytes, bs[2] * dt.bytes);
    return toFloat(typed(bytes));
  }

  return {
    meta: m,
    entry,
    readBrick,
    read,
    readBrickInlines,
    readBrickTrace,
    brickSamples,
    storedBrickBytes: brickBytes,
  };
}

/**
 * Bounded-memory trace access over an open ZGY at level 0: whole inlines
 * for a sequential sweep, single traces for a sparse one.
 *
 * Plain bricks are read in contiguous groups of inlines (`group` of them,
 * 8 for v1), so a sweep reads every byte once; a compressed brick is
 * decoded whole and kept while its brick row is being swept, up to
 * `cacheBytes` (bricks past the budget are decoded again when needed).
 *
 * @param {Awaited<ReturnType<typeof openZgy>>} zgy
 * @param {{cacheBytes?: number}} [opts]
 */
export function zgyInlineSource(zgy, { cacheBytes = 512 * 1024 * 1024 } = {}) {
  const m = zgy.meta;
  const bs = m.bricksize;
  const [ni, nj, nk] = m.size;
  const nbj = Math.ceil(nj / bs[1]);
  const nbk = Math.ceil(nk / bs[2]);
  const per = bs[1] * bs[2]; // one inline of one brick
  // inlines per plain-brick group: a group row (all bj, bk) stays under the budget
  const rowInline = nbj * nbk * per * 4;
  const group = m.version === 1 ? 8 : Math.max(1, Math.min(bs[0], Math.floor(cacheBytes / 2 / rowInline)));
  let groupKey = -1;
  let groupData = new Map(); // (bj, bk) -> Float32Array of `group` inlines
  let rowKey = -1;
  let rowCache = new Map(); // (bj, bk) -> decoded compressed brick
  let rowBytes = 0;
  const stats = { groupReads: 0, traceReads: 0, decodes: 0 };

  async function compressedBrick(bi, bj, bk) {
    if (rowKey !== bi) { rowKey = bi; rowCache = new Map(); rowBytes = 0; }
    const key = bj * nbk + bk;
    const hit = rowCache.get(key);
    if (hit) return hit;
    const { data } = await zgy.readBrick(bi, bj, bk, 0);
    stats.decodes++;
    if (rowBytes + data.byteLength <= cacheBytes / 2) { rowCache.set(key, data); rowBytes += data.byteLength; }
    return data;
  }

  /** The float32 samples of inline index i (crossline-major, nk samples per trace), into out (nj * nk). */
  async function inline(i, out = new Float32Array(nj * nk)) {
    const bi = Math.floor(i / bs[0]);
    const li = i - bi * bs[0];
    const g0 = li - (li % group);
    const gk = bi * bs[0] + g0;
    if (gk !== groupKey) { groupKey = gk; groupData = new Map(); }
    const gn = Math.min(group, bs[0] - g0);
    for (let bj = 0; bj < nbj; bj++) {
      for (let bk = 0; bk < nbk; bk++) {
        const key = bj * nbk + bk;
        let src;
        let base;
        let block = groupData.get(key);
        if (block === undefined) {
          block = await zgy.readBrickInlines(bi, bj, bk, g0, m.version === 1 ? 8 : gn);
          stats.groupReads++;
          groupData.set(key, block); // null marks a compressed brick
        }
        if (block) { src = block; base = (li - g0) * per; } else { src = await compressedBrick(bi, bj, bk); base = li * per; }
        const j0 = bj * bs[1]; const k0 = bk * bs[2];
        const jn = Math.min(bs[1], nj - j0); const kn = Math.min(bs[2], nk - k0);
        for (let lj = 0; lj < jn; lj++) {
          const s = base + lj * bs[2];
          out.set(src.subarray(s, s + kn), (j0 + lj) * nk + k0);
        }
      }
    }
    return out;
  }

  /** One trace (inline index i, crossline index j) into out (nk). */
  async function trace(i, j, out = new Float32Array(nk)) {
    const bi = Math.floor(i / bs[0]); const li = i - bi * bs[0];
    const bj = Math.floor(j / bs[1]); const lj = j - bj * bs[1];
    for (let bk = 0; bk < nbk; bk++) {
      const k0 = bk * bs[2]; const kn = Math.min(bs[2], nk - k0);
      let run = await zgy.readBrickTrace(bi, bj, bk, li, lj);
      stats.traceReads++;
      let s = 0;
      if (!run) {
        if (zgy.entry(bi, bj, bk, 0).status === 'compressed') {
          run = await compressedBrick(bi, bj, bk);
          s = (li * bs[1] + lj) * bs[2];
        } else { // v1: the brick's 8-inline group
          const g0 = li - (li % 8);
          run = await zgy.readBrickInlines(bi, bj, bk, g0, 8);
          s = ((li - g0) * bs[1] + lj) * bs[2];
        }
      }
      out.set(run.subarray(s, s + kn), k0);
    }
    return out;
  }

  return { inline, trace, group, stats, size: m.size };
}
