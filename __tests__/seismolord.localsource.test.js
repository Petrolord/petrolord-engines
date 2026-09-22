/**
 * Large-survey Stream L: trace index from headers only, inline and
 * crossline slices straight from a local SEG-Y, and streaming brick
 * assembly.
 *
 * The contract under test is bit-identity: a slice read from the local
 * file must be the same float32 bits as the same slice assembled from the
 * transcoder's bricks (which the Suite's segyio goldens already pin), for
 * IBM and IEEE, inline- and crossline-sorted, and on irregular files with
 * dead, duplicated and shuffled traces.
 */
import { bufferReader } from '../engines/seismolord/reader';
import { scanGeometry } from '../engines/seismolord/segyScan';
import { transcodeToBricks } from '../engines/seismolord/brickTranscode';
import {
  assembleSlice, assembleSlices, bricksForSlice, sliceTraceRms, ASSEMBLY_ABORTED,
} from '../engines/seismolord/sliceAssembly';
import {
  buildTraceIndex, traceNumberAt, manifestFromTraceIndex, INDEX_ABORTED,
} from '../engines/seismolord/traceIndex';
import {
  readLocalSlice, readLocalTrace, readLocalBrick, planTraceReads,
  lineTraceNumbers, TimeSliceUnavailableError,
} from '../engines/seismolord/localSlice';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const bits = (f32) => Array.from(new Uint32Array(f32.buffer, f32.byteOffset, f32.length));

// ---- a hand-rolled SEG-Y writer ------------------------------------------

/** IEEE float -> IBM word; exact for the k/256 values used below. */
function toIbm(v) {
  if (v === 0) return 0;
  const sign = v < 0 ? 0x80000000 : 0;
  let a = Math.abs(v);
  let exp = 64;
  while (a >= 1) { a /= 16; exp += 1; }
  while (a < 1 / 16) { a *= 16; exp -= 1; }
  const frac = Math.round(a * 0x1000000);
  return (sign | (exp << 24) | frac) >>> 0;
}

/** Deterministic amplitude, exact in float32 and IBM. */
const amp = (il, xl, s) => ((((il * 31 + xl * 17 + s * 7) % 211) - 105) / 256) || 0.5;

/**
 * @param {Object} o
 * @param {number} o.nIl @param {number} o.nXl @param {number} o.ns
 * @param {number} [o.format] 1 IBM, 5 IEEE
 * @param {'inline'|'crossline'} [o.sort]
 * @param {number} [o.il0] @param {number} [o.xl0] @param {number} [o.ilStep] @param {number} [o.xlStep]
 * @param {boolean} [o.xlDescending] crosslines descending inside each inline
 * @param {(il:number, xl:number) => boolean} [o.drop] omit these traces
 * @param {(list: Array) => Array} [o.reorder] final trace order
 */
function writeSegy({
  nIl, nXl, ns, format = 5, sort = 'inline', il0 = 100, xl0 = 2000, ilStep = 1, xlStep = 1,
  xlDescending = false, drop = () => false, reorder = (l) => l,
}) {
  let list = [];
  const ils = Array.from({ length: nIl }, (_, i) => il0 + i * ilStep);
  let xls = Array.from({ length: nXl }, (_, j) => xl0 + j * xlStep);
  if (xlDescending) xls = xls.slice().reverse();
  if (sort === 'inline') {
    for (const il of ils) for (const xl of xls) list.push({ il, xl });
  } else {
    for (const xl of xls) for (const il of ils) list.push({ il, xl });
  }
  list = reorder(list.filter(({ il, xl }) => !drop(il, xl)));
  const traceBytes = 240 + ns * 4;
  const buf = new ArrayBuffer(3600 + list.length * traceBytes);
  const v = new DataView(buf);
  for (let i = 0; i < 3200; i++) v.setUint8(i, 0x40);
  v.setInt16(3200 + 16, 4000, false);
  v.setInt16(3200 + 20, ns, false);
  v.setInt16(3200 + 24, format, false);
  list.forEach(({ il, xl }, t) => {
    const off = 3600 + t * traceBytes;
    v.setInt32(off + 188, il, false);
    v.setInt32(off + 192, xl, false);
    v.setInt16(off + 70, -100, false);
    v.setInt32(off + 180, Math.round((500000 + (xl - xl0) * 25) * 100), false);
    v.setInt32(off + 184, Math.round((6000000 + (il - il0) * 25) * 100), false);
    for (let s = 0; s < ns; s++) {
      const a = amp(il, xl, s);
      if (format === 5) v.setFloat32(off + 240 + s * 4, a, false);
      else v.setUint32(off + 240 + s * 4, toIbm(a), false);
    }
  });
  return { buf, list, il0, xl0, ilStep, xlStep };
}

/** Truth slice straight from amp(): same layout as assembleSlice. */
function truthSlice(f, nIl, nXl, ns, o, idx, dead = () => false) {
  const n = o === 'inline' ? nXl : nIl;
  const out = new Float32Array(n * ns);
  for (let p = 0; p < n; p++) {
    const il = f.il0 + (o === 'inline' ? idx : p) * f.ilStep;
    const xl = f.xl0 + (o === 'inline' ? p : idx) * f.xlStep;
    for (let s = 0; s < ns; s++) out[p * ns + s] = dead(il, xl) ? NULL_F32 : amp(il, xl, s);
  }
  return out;
}

/** Transcode a regular inline-sorted file to an in-memory brick map. */
async function brickStore(buf, brickSize = 8) {
  const reader = bufferReader(buf);
  const scan = await scanGeometry(reader);
  const bricks = new Map();
  const tr = await transcodeToBricks(reader, scan, {
    brickSize,
    onBrick: ({ i, j, k, data }) => { bricks.set(`${i}-${j}-${k}`, data); },
  });
  const geom = {
    nIl: scan.il.count, nXl: scan.xl.count, ns: scan.ns, brickSize,
    grid: [tr.brickGrid.ni, tr.brickGrid.nj, tr.brickGrid.nk],
  };
  return { bricks, geom, getBrick: (i, j, k) => Promise.resolve(bricks.get(`${i}-${j}-${k}`)) };
}

/** A reader that counts reads and bytes. */
const countingReader = (buf) => {
  const r = bufferReader(buf);
  const stats = { reads: 0, bytes: 0 };
  return {
    size: r.size,
    stats,
    read: (off, len) => { stats.reads += 1; stats.bytes += len; return r.read(off, len); },
  };
};

// ---- trace index ----------------------------------------------------------

describe('buildTraceIndex', () => {
  const nIl = 13; const nXl = 11; const ns = 20;

  test('regular inline-sorted file: predicted from headers only, few reads', async () => {
    const f = writeSegy({ nIl, nXl, ns });
    const reader = countingReader(f.buf);
    const idx = await buildTraceIndex(reader);
    expect(idx.mode).toBe('predicted');
    expect(idx.sort).toBe('inline');
    expect(idx.il).toEqual({ min: 100, max: 112, step: 1, count: nIl });
    expect(idx.xl).toEqual({ min: 2000, max: 2010, step: 1, count: nXl });
    expect(idx.lattice).toBeNull();
    expect(idx.deadTraces).toBe(0);
    // header-sized reads only (plus the binary header): 3 per line + search
    expect(reader.stats.reads).toBeLessThanOrEqual(3 * nIl + 2 * Math.log2(nXl) + 6);
    for (const call of [reader.stats]) expect(call.bytes).toBeLessThan(400 + reader.stats.reads * 240);
    for (let i = 0; i < nIl; i++) {
      for (let j = 0; j < nXl; j++) expect(traceNumberAt(idx, i, j)).toBe(i * nXl + j);
    }
    expect(idx.affine.ilVec.y).toBeCloseTo(25, 6);
    expect(idx.affine.xlVec.x).toBeCloseTo(25, 6);
  });

  test('crossline-sorted and descending-crossline files are predicted too', async () => {
    const cs = await buildTraceIndex(bufferReader(writeSegy({ nIl, nXl, ns, sort: 'crossline' }).buf));
    expect(cs.mode).toBe('predicted');
    expect(cs.sort).toBe('crossline');
    expect(traceNumberAt(cs, 3, 4)).toBe(4 * nIl + 3);
    const desc = await buildTraceIndex(bufferReader(writeSegy({ nIl, nXl, ns, xlDescending: true }).buf));
    expect(desc.mode).toBe('predicted');
    expect(desc.xl.min).toBe(2000);
    expect(traceNumberAt(desc, 0, 0)).toBe(nXl - 1);
  });

  test('steps other than 1 are measured', async () => {
    const idx = await buildTraceIndex(bufferReader(writeSegy({
      nIl, nXl, ns, ilStep: 2, xlStep: 4,
    }).buf));
    expect(idx.il).toEqual({ min: 100, max: 124, step: 2, count: nIl });
    expect(idx.xl).toEqual({ min: 2000, max: 2040, step: 4, count: nXl });
  });

  test('dead traces fall back to the lattice with -1 cells', async () => {
    const drop = (il, xl) => (il === 103 && xl >= 2004 && xl <= 2006) || (il === 110 && xl === 2000);
    const idx = await buildTraceIndex(bufferReader(writeSegy({ nIl, nXl, ns, drop }).buf));
    expect(idx.mode).toBe('lattice');
    expect(idx.deadTraces).toBe(4);
    expect(idx.lattice).toBeInstanceOf(Int32Array);
    expect(traceNumberAt(idx, 3, 5)).toBe(-1);
    expect(traceNumberAt(idx, 10, 0)).toBe(-1);
    expect(idx.warnings.join(' ')).toMatch(/4 of 143 grid positions have no trace/);
  });

  test('a line shuffled inside (ends intact) fails verification and uses the lattice', async () => {
    const reorder = (list) => {
      const out = [];
      for (let i = 0; i < nIl; i++) {
        const line = list.slice(i * 12, i * 12 + 12);
        out.push(line[0], ...line.slice(1, 11).reverse(), line[11]);
      }
      return out;
    };
    const f = writeSegy({ nIl, nXl: 12, ns, reorder });
    const idx = await buildTraceIndex(bufferReader(f.buf));
    expect(idx.mode).toBe('lattice');
    expect(idx.sort).toBe('unsorted');
    const s = await readLocalSlice(bufferReader(f.buf), idx, 'inline', 4);
    expect(bits(s.data)).toEqual(bits(truthSlice(f, nIl, 12, ns, 'inline', 4)));
  });

  test('duplicates keep the first trace and say so', async () => {
    const reorder = (list) => [...list, { ...list[5] }];
    const idx = await buildTraceIndex(bufferReader(writeSegy({ nIl, nXl, ns, reorder }).buf));
    expect(idx.mode).toBe('lattice');
    expect(idx.duplicateTraces).toBe(1);
    expect(traceNumberAt(idx, 0, 5)).toBe(5);
    expect(idx.warnings.join(' ')).toMatch(/repeat an inline and crossline/);
  });

  test('a mapping that implies an absurd grid is refused in plain words', async () => {
    const f = writeSegy({ nIl: 2, nXl: 2, ns: 4 });
    const v = new DataView(f.buf);
    v.setInt32(3600 + 188, 1e9, false);            // one wild inline number
    v.setInt32(3600 + 192, -1e9, false);
    await expect(buildTraceIndex(bufferReader(f.buf))).rejects.toThrow(/byte positions/);
  });

  test('abort stops the build', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(buildTraceIndex(bufferReader(writeSegy({ nIl, nXl, ns }).buf), {}, { signal: ac.signal }))
      .rejects.toThrow(INDEX_ABORTED);
  });

  test('manifestFromTraceIndex gives the viewer a v1 geometry block', async () => {
    const idx = await buildTraceIndex(bufferReader(writeSegy({ nIl, nXl, ns }).buf));
    const m = manifestFromTraceIndex(idx, { name: 'x.sgy', fileSize: 1 });
    expect(m.local).toBe(true);
    expect(m.geometry.il.count).toBe(nIl);
    expect(m.geometry.ns).toBe(ns);
    expect(m.geometry.dt_us).toBe(4000);
    expect(m.geometry.affine.il_vec.y).toBeCloseTo(25, 6);
  });
});

// ---- local slices vs bricks ---------------------------------------------------

describe.each([
  ['IEEE', 5],
  ['IBM', 1],
])('local slices are bit-identical to brick-assembled slices (%s)', (_, format) => {
  const nIl = 19; const nXl = 23; const ns = 21;   // ragged against 8^3 bricks
  let f; let store; let idx;
  beforeAll(async () => {
    f = writeSegy({ nIl, nXl, ns, format });
    store = await brickStore(f.buf, 8);
    idx = await buildTraceIndex(bufferReader(f.buf));
  });

  test('every inline and every crossline', async () => {
    const reader = bufferReader(f.buf);
    for (const [o, n] of [['inline', nIl], ['xline', nXl]]) {
      for (let i = 0; i < n; i++) {
        // eslint-disable-next-line no-await-in-loop
        const local = await readLocalSlice(reader, idx, o, i);
        // eslint-disable-next-line no-await-in-loop
        const fromBricks = await assembleSlice(store.getBrick, store.geom, o, i);
        expect(local.width).toBe(fromBricks.width);
        expect(local.height).toBe(fromBricks.height);
        expect(bits(local.data)).toEqual(bits(fromBricks.data));
        expect(bits(local.traceRms)).toEqual(bits(fromBricks.traceRms));
        expect(local.level).toBe(0);
      }
    }
  });

  test('the crossline-sorted copy of the survey gives the same bits', async () => {
    const cs = writeSegy({ nIl, nXl, ns, format, sort: 'crossline' });
    const csIdx = await buildTraceIndex(bufferReader(cs.buf));
    for (const [o, i] of [['inline', 7], ['xline', 12], ['crossline', 0]]) {
      // eslint-disable-next-line no-await-in-loop
      const local = await readLocalSlice(bufferReader(cs.buf), csIdx, o, i);
      // eslint-disable-next-line no-await-in-loop
      const fromBricks = await assembleSlice(store.getBrick, store.geom, o, i);
      expect(bits(local.data)).toEqual(bits(fromBricks.data));
    }
  });

  test('every brick read locally equals the transcoded brick', async () => {
    const reader = bufferReader(f.buf);
    const [ni, nj, nk] = store.geom.grid;
    for (let i = 0; i < ni; i++) {
      for (let j = 0; j < nj; j++) {
        for (let k = 0; k < nk; k++) {
          // eslint-disable-next-line no-await-in-loop
          const b = await readLocalBrick(reader, idx, 8, i, j, k);
          expect(bits(b)).toEqual(bits(store.bricks.get(`${i}-${j}-${k}`)));
        }
      }
    }
  });

  test('single traces', async () => {
    const t = await readLocalTrace(bufferReader(f.buf), idx, 5, 9);
    const ref = truthSlice(f, nIl, nXl, ns, 'inline', 5).subarray(9 * ns, 10 * ns);
    expect(bits(t)).toEqual(bits(ref));
  });
});

describe('readLocalSlice behaviour', () => {
  const nIl = 16; const nXl = 12; const ns = 10;

  test('an inline of an inline-sorted file is one contiguous read', async () => {
    const f = writeSegy({ nIl, nXl, ns });
    const idx = await buildTraceIndex(bufferReader(f.buf));
    const reader = countingReader(f.buf);
    await readLocalSlice(reader, idx, 'inline', 6);
    expect(reader.stats.reads).toBe(1);
    expect(reader.stats.bytes).toBe(nXl * (240 + ns * 4));
  });

  test('a crossline reads only its own traces, coalescing small gaps', async () => {
    const f = writeSegy({ nIl, nXl, ns });
    const idx = await buildTraceIndex(bufferReader(f.buf));
    const traceBytes = 240 + ns * 4;
    const far = countingReader(f.buf);
    await readLocalSlice(far, idx, 'xline', 3, { maxGapBytes: 0 });
    expect(far.stats.reads).toBe(nIl);
    expect(far.stats.bytes).toBe(nIl * traceBytes);
    const near = countingReader(f.buf);
    await readLocalSlice(near, idx, 'xline', 3, { maxGapBytes: nXl * traceBytes });
    expect(near.stats.reads).toBe(1);
  });

  test('dead cells read as the playbook null', async () => {
    const drop = (il, xl) => il === 104 && xl === 2003;
    const f = writeSegy({ nIl, nXl, ns, drop });
    const idx = await buildTraceIndex(bufferReader(f.buf));
    const s = await readLocalSlice(bufferReader(f.buf), idx, 'inline', 4);
    expect(bits(s.data)).toEqual(bits(truthSlice(f, nIl, nXl, ns, 'inline', 4, drop)));
    expect(s.traceRms[3]).toBe(0);
    const x = await readLocalSlice(bufferReader(f.buf), idx, 'xline', 3);
    expect(x.data[4 * ns]).toBe(NULL_F32);
  });

  test('a coarse level reads every 2^level-th trace at full shape', async () => {
    const f = writeSegy({ nIl, nXl, ns });
    const idx = await buildTraceIndex(bufferReader(f.buf));
    const reader = countingReader(f.buf);
    const s = await readLocalSlice(reader, idx, 'xline', 5, { level: 2, maxGapBytes: 0 });
    expect(reader.stats.reads).toBe(nIl / 4);
    expect(s.level).toBe(2);
    expect(s.height).toBe(nIl);
    const exact = truthSlice(f, nIl, nXl, ns, 'xline', 5);
    for (let p = 0; p < nIl; p++) {
      const src = p - (p % 4);
      expect(bits(s.data.subarray(p * ns, p * ns + ns)))
        .toEqual(bits(exact.subarray(src * ns, src * ns + ns)));
    }
  });

  test('time slices are refused by name', async () => {
    const f = writeSegy({ nIl, nXl, ns });
    const idx = await buildTraceIndex(bufferReader(f.buf));
    const e = await readLocalSlice(bufferReader(f.buf), idx, 'time', 3).catch((x) => x);
    expect(e).toBeInstanceOf(TimeSliceUnavailableError);
    expect(e.name).toBe('TIME_SLICE_NEEDS_CONVERSION');
    expect(e.message).toMatch(/after conversion/);
    expect(e.message).not.toMatch(/—/);
  });

  test('out-of-range lines and aborts are refused', async () => {
    const f = writeSegy({ nIl, nXl, ns });
    const idx = await buildTraceIndex(bufferReader(f.buf));
    await expect(readLocalSlice(bufferReader(f.buf), idx, 'inline', nIl)).rejects.toThrow(/outside/);
    const ac = new AbortController();
    ac.abort();
    await expect(readLocalSlice(bufferReader(f.buf), idx, 'inline', 1, { signal: ac.signal }))
      .rejects.toThrow('LOCAL_SLICE_ABORTED');
  });

  test('lineTraceNumbers and planTraceReads', () => {
    const idx = {
      il: { count: 3 }, xl: { count: 4 }, lattice: null,
      predict: { fast: 'xl', fastRev: false, slowRev: false, nFast: 4 },
    };
    expect(Array.from(lineTraceNumbers(idx, 'crossline', 1))).toEqual([1, 5, 9]);
    expect(planTraceReads([9, 1, 4, -1, 4], 100, { maxGapBytes: 250 }))
      .toEqual([{ first: 1, last: 4 }, { first: 9, last: 9 }]);
    expect(planTraceReads([1, 2, 3, 4], 100, { maxReadBytes: 200 }))
      .toEqual([{ first: 1, last: 2 }, { first: 3, last: 4 }]);
  });
});

// ---- streaming assembly --------------------------------------------------------

describe('streaming assembly', () => {
  const nIl = 40; const nXl = 36; const ns = 30;
  let f; let store;
  beforeAll(async () => {
    f = writeSegy({ nIl, nXl, ns });
    store = await brickStore(f.buf, 8);
  });

  /** getBrick that resolves on a later tick and tracks bricks handed out
   *  but not yet consumed by the assembler (the pinned set). */
  const trackingGetBrick = () => {
    const t = { inFlight: 0, peak: 0, calls: 0 };
    t.getBrick = (i, j, k) => {
      t.calls += 1;
      t.inFlight += 1;
      t.peak = Math.max(t.peak, t.inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          t.inFlight -= 1;
          resolve(store.bricks.get(`${i}-${j}-${k}`));
        }, 0);
      });
    };
    return t;
  };

  test('peak pinned bricks is the concurrency, not the slice brick count', async () => {
    const t = trackingGetBrick();
    const brickBytes = 8 ** 3 * 4;
    const s = await assembleSlice(t.getBrick, store.geom, 'inline', 17, { concurrency: 3 });
    const needed = bricksForSlice(store.geom, 'inline', 17).length;
    expect(needed).toBe(5 * 4);
    expect(t.calls).toBe(needed);
    expect(t.peak).toBe(3);
    expect(t.peak * brickBytes).toBeLessThan(needed * brickBytes);
    expect(bits(s.data)).toEqual(bits(truthSlice(f, nIl, nXl, ns, 'inline', 17)));
  });

  test('time slices assemble bit-exact with no trace RMS', async () => {
    const t = trackingGetBrick();
    const s = await assembleSlice(t.getBrick, store.geom, 'time', 11, { concurrency: 2 });
    expect(t.peak).toBe(2);
    expect(s.traceRms).toBeNull();
    for (let i = 0; i < nIl; i++) {
      for (let x = 0; x < nXl; x++) {
        expect(s.data[i * nXl + x]).toBe(Math.fround(amp(100 + i, 2000 + x, 11)));
      }
    }
  });

  test('neighbouring slices in one brick row cost one fetch set', async () => {
    const t = trackingGetBrick();
    const many = await assembleSlices(t.getBrick, store.geom, 'xline', [16, 17, 18, 23]);
    expect(t.calls).toBe(bricksForSlice(store.geom, 'xline', 16).length);
    for (const idx of [16, 17, 18, 23]) {
      // eslint-disable-next-line no-await-in-loop
      const one = await assembleSlice(store.getBrick, store.geom, 'xline', idx);
      expect(bits(many.get(idx).data)).toEqual(bits(one.data));
      expect(bits(many.get(idx).data)).toEqual(bits(truthSlice(f, nIl, nXl, ns, 'xline', idx)));
    }
  });

  test('sliceTraceRms matches the per-trace RMS the renderer balances by', () => {
    const d = new Float32Array([3, 4, NULL_F32, 0, 0, 0]);
    const r = sliceTraceRms(d, 3, 2);
    expect(r[0]).toBeCloseTo(Math.sqrt(12.5), 6);
    expect(r[1]).toBe(0);
  });

  test('an aborted assembly stops fetching and rejects', async () => {
    const t = trackingGetBrick();
    const ac = new AbortController();
    const p = assembleSlice(t.getBrick, store.geom, 'inline', 3, {
      concurrency: 2,
      signal: ac.signal,
      onProgress: (done) => { if (done === 2) ac.abort(); },
    });
    await expect(p).rejects.toThrow(ASSEMBLY_ABORTED);
    expect(t.calls).toBeLessThan(bricksForSlice(store.geom, 'inline', 3).length);
  });

  test('a failing brick fails the slice', async () => {
    const getBrick = (i, j, k) => (k === 2
      ? Promise.reject(new Error('Brick fetch failed (500)'))
      : Promise.resolve(store.bricks.get(`${i}-${j}-${k}`)));
    await expect(assembleSlice(getBrick, store.geom, 'inline', 3)).rejects.toThrow(/500/);
  });
});

// ---- percentile sample (moves the clip sort off the UI thread) --------------

describe('absAmplitudeSample + percentileOfSorted', () => {
  // eslint-disable-next-line global-require
  const { amplitudePercentile, absAmplitudeSample, percentileOfSorted } = require('../engines/seismolord/displayEnhance');
  test('equals amplitudePercentile bit for bit, capped and uncapped', () => {
    const n = 50001;
    const d = new Float32Array(n);
    let st = 7;
    for (let i = 0; i < n; i++) {
      st = (Math.imul(st, 1103515245) + 12345) >>> 0;
      d[i] = ((st / 4294967296) - 0.5) * 3000;
    }
    d[17] = NULL_F32;
    for (const cap of [1 << 20, 4096, 1000]) {
      const sorted = absAmplitudeSample(d, { cap });
      for (const p of [0, 1, 50, 90, 98, 99.5, 100]) {
        expect(percentileOfSorted(sorted, p)).toBe(amplitudePercentile(d, p, { cap }));
      }
    }
    expect(percentileOfSorted(new Float32Array(0), 50)).toBe(0);
    expect(() => percentileOfSorted(new Float32Array(1), 101)).toThrow(/out of range/);
  });
});
