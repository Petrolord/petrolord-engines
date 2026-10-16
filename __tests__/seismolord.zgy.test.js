// ZGY reader and its SEG-Y view (owner request 2026-10-16). The oracle is
// OpenZGY itself: the fixtures in test-data/seismolord/zgy were written by
// the OpenZGY pure-Python reference (v0.17.0) and read back by it, and the
// SHA-256 of its full level-0 and level-1 reads is in each .json. The four
// Empty/Fancy files are OpenZGY's own test data (Apache-2.0), including a
// version 1 file with its 8 x 8 trace tiling. Values are also checked
// against the formulas the fixtures were written from (gen_fixtures notes
// in the README), so a reader that only matched itself would fail.
// Negative controls: a mis-tiled v1 read, a wrong brick axis order and a
// legacy compressed signature all fail.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { bufferReader } from '../engines/seismolord/reader';
import { openZgy, zgyInlineSource, ZgyRefusal } from '../engines/seismolord/zgy';
import { zgySegyReader, zgySegyLayout, zgyAmplitudeClip } from '../engines/seismolord/zgySegy';
import { scanGeometry, readTextualHeader } from '../engines/seismolord/segyScan';
import { decodeSamples, readHeaderInt32, readHeaderInt16, applyCoordScalar } from '../engines/seismolord/segyDecode';

const Zfp = require('wasm-zfp');

const DIR = path.join(__dirname, '../test-data/seismolord/zgy');
const load = (name) => {
  const b = zlib.gunzipSync(fs.readFileSync(path.join(DIR, `${name}.zgy.gz`)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const jsonOf = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const sha = (f32) => crypto.createHash('sha256').update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest('hex');

let zfpDecode;
beforeAll(async () => {
  await Zfp.isLoaded;
  const buf = Zfp.createBuffer();
  zfpDecode = (bytes) => Float32Array.from(Zfp.decompress(buf, bytes).data);
});
const open = (name, opts = {}) => openZgy(bufferReader(load(name)), { zfpDecode, ...opts });

const SIZE = [66, 70, 70];
const FORMULA = {
  'gen-float32': (i, j, k) => (i < 64 && j >= 64 && k < 64 ? 42.5 : Math.fround(i * 10000 + j * 10 + k * 0.0625)),
  'gen-int16': (i, j, k) => (((i * 7 + j * 3 + k) % 2000) - 1000) * 0.01,
  'gen-int8': (i, j, k) => (((i + 2 * j + 3 * k) % 256) - 128) * 0.1,
  'gen-depth-ft': (i, j, k) => (((i + 2 * j + 3 * k) % 256) - 128) * 0.1,
};
const GEN = ['gen-float32', 'gen-int16', 'gen-int8', 'gen-zfp-snr30', 'gen-depth-ft'];

describe('openZgy against OpenZGY', () => {
  test.each(GEN)('%s: header, geometry and both levels bit for bit', async (name) => {
    const ref = jsonOf(name);
    const z = await open(name);
    const m = z.meta;
    expect(m.size).toEqual(ref.size);
    expect(m.nlods).toBe(ref.nlods);
    expect(m.orig.slice(0, 2)).toEqual(ref.annotstart);
    expect(m.inc.slice(0, 2)).toEqual(ref.annotinc);
    expect([m.orig[2], m.inc[2]]).toEqual([ref.zstart, ref.zinc]);
    expect(m.vunitname).toBe(ref.zunitname);
    expect(m.vertical).toBe(ref.zunitdim === 'length' ? 'depth' : 'time');
    expect(m.hunitname).toBe(ref.hunitname);
    m.corners.forEach((c, n) => {
      expect(c[0]).toBeCloseTo(ref.corners[n][0], 2);
      expect(c[1]).toBeCloseTo(ref.corners[n][1], 2);
    });
    expect(sha(await z.read([0, 0, 0], m.size, 0))).toBe(ref.lod0_sha256);
    expect(sha(await z.read([0, 0, 0], ref.lod1_shape, 1))).toBe(ref.lod1_sha256);
  });

  test.each(Object.keys(FORMULA))('%s: values are the ones written', async (name) => {
    const z = await open(name);
    const all = await z.read([0, 0, 0], SIZE, 0);
    const f = FORMULA[name];
    let worst = 0;
    for (let i = 0; i < SIZE[0]; i++) for (let j = 0; j < SIZE[1]; j++) for (let k = 0; k < SIZE[2]; k++) {
      worst = Math.max(worst, Math.abs(all[(i * SIZE[1] + j) * SIZE[2] + k] - f(i, j, k)));
    }
    expect(worst).toBeLessThan(name === 'gen-float32' ? 1e-9 : 1e-4);
  });

  test('a constant brick is a constant brick; ZFP bricks are compressed and close to what was written', async () => {
    const f = await open('gen-float32');
    expect(f.entry(0, 1, 0)).toEqual({ status: 'constant', value: 42.5 });
    const z = await open('gen-zfp-snr30');
    expect(z.meta.version).toBe(4);
    expect(z.meta.compressedBricks).toBeGreaterThan(0);
    const all = await z.read([0, 0, 0], SIZE, 0);
    let worst = 0;
    for (let i = 0; i < SIZE[0]; i++) for (let j = 0; j < SIZE[1]; j++) for (let k = 0; k < SIZE[2]; k++) {
      const want = Math.sin(i / 7) * Math.cos(j / 11) * Math.sin(k / 5) * 1000;
      worst = Math.max(worst, Math.abs(all[(i * SIZE[1] + j) * SIZE[2] + k] - want));
    }
    expect(worst).toBeLessThan(40); // snr 30 dB on a +-1000 signal
    expect(worst).toBeGreaterThan(0); // and it is lossy, so the decoder really ran
  });

  test('version 1 (8 x 8 tiling, high-first offsets) reads as its version 3 copy, with the known corners', async () => {
    const v1 = await open('Empty-v1');
    const v3 = await open('Empty-v3');
    expect(v1.meta.version).toBe(1);
    expect(v3.meta.version).toBe(3);
    expect(v1.meta.size).toEqual([181, 241, 169]);
    expect(v1.meta.codingRange[0]).toBeCloseTo(-10038.5, 1);
    expect(v1.meta.codingRange[1]).toBeCloseTo(9761.62, 1);
    // corners from OpenZGY's C++ tests
    const want = [[564344.97, 5917369.23], [568209.86, 5915035.21], [567457.07, 5922522.52], [571321.95, 5920188.49]];
    for (const z of [v1, v3]) z.meta.corners.forEach((c, n) => { expect(c[0]).toBeCloseTo(want[n][0], 1); expect(c[1]).toBeCloseTo(want[n][1], 1); });
    const a = await v1.read([0, 0, 0], v1.meta.size, 0);
    const b = await v3.read([0, 0, 0], v3.meta.size, 0);
    expect(sha(a)).toBe(sha(b));
    // the first brick carries a pattern that tells the tilings apart
    const brick = (await v1.readBrick(0, 0, 0)).data;
    const st = (v) => Math.round((v - v1.meta.intercept) / v1.meta.slope);
    expect(new Set([0, 1, 8 * 64, 64 * 64].map((p) => st(brick[p]))).size).toBeGreaterThan(1);
    expect(brick[0]).toBeCloseTo(b[0], 6);
  });

  test('negative control: reading a v1 brick without untiling disagrees with its v3 copy', async () => {
    const r = bufferReader(load('Empty-v1'));
    const z = await openZgy(r);
    const e = z.entry(0, 0, 0);
    const raw = new Int8Array(await r.read(e.offset, e.size));
    const v3 = (await (await open('Empty-v3')).readBrick(0, 0, 0)).data;
    let diff = 0;
    for (let p = 0; p < raw.length; p++) if (Math.abs(raw[p] * z.meta.slope + z.meta.intercept - v3[p]) > 1e-3) diff++;
    expect(diff).toBeGreaterThan(0);
  });

  test('Fancy-int8 mixes plain, constant and missing bricks; an all-missing file reads its default', async () => {
    const z = await open('Fancy-int8');
    const seen = new Set();
    const [a, b, c] = z.meta.lodsizes[0];
    for (let k = 0; k < c; k++) for (let j = 0; j < b; j++) for (let i = 0; i < a; i++) seen.add(z.entry(i, j, k).status);
    expect([...seen].sort()).toEqual(['constant', 'missing', 'normal']);
    const e = await open('EmptyOldFile');
    expect(e.meta.dtype).toBe('int16');
    expect(e.entry(3, 2, 1).status).toBe('missing');
    const brick = (await e.readBrick(3, 2, 1)).data;
    expect(brick.every((v) => v === e.meta.defaultValue)).toBe(true);
  });

  test('refusals: legacy Petrel compression, not a ZGY, no ZFP decoder', async () => {
    const legacy = new Uint8Array(load('gen-int8').slice(0));
    legacy.set([0x56, 0x43, 0x53, 0], 0); // "VCS\0"
    await expect(openZgy(bufferReader(legacy.buffer))).rejects.toMatchObject({ name: 'ZgyRefusal', code: 'legacy-compressed' });
    await expect(openZgy(bufferReader(new Uint8Array(4096).buffer))).rejects.toMatchObject({ code: 'not-zgy' });
    const noZfp = await openZgy(bufferReader(load('gen-zfp-snr30')));
    const k = noZfp.meta.lodsizes[0];
    let compressedAt = null;
    for (let i = 0; i < k[0] && !compressedAt; i++) for (let j = 0; j < k[1] && !compressedAt; j++) for (let kk = 0; kk < k[2] && !compressedAt; kk++) {
      if (noZfp.entry(i, j, kk).status === 'compressed') compressedAt = [i, j, kk];
    }
    await expect(noZfp.readBrick(...compressedAt)).rejects.toBeInstanceOf(ZgyRefusal);
  });
});

describe('zgyInlineSource', () => {
  test.each(['gen-float32', 'gen-int16', 'gen-zfp-snr30', 'Empty-v1', 'Fancy-int8'])('%s: every inline and a spread of traces equal the full read', async (name) => {
    const z = await open(name);
    const [ni, nj, nk] = z.meta.size;
    const all = await z.read([0, 0, 0], z.meta.size, 0);
    // a small budget: one-inline groups and no room for compressed bricks
    for (const cacheBytes of [undefined, 1]) {
      const src = zgyInlineSource(z, cacheBytes ? { cacheBytes } : {});
      for (let i = 0; i < ni; i++) {
        const line = await src.inline(i);
        expect(sha(line)).toBe(sha(all.subarray(i * nj * nk, (i + 1) * nj * nk)));
      }
      for (const [i, j] of [[0, 0], [ni - 1, nj - 1], [Math.floor(ni / 2), 3], [5, nj - 2]]) {
        const t = await src.trace(i, j);
        expect(sha(t)).toBe(sha(all.subarray((i * nj + j) * nk, (i * nj + j + 1) * nk)));
      }
    }
  });

  test('a sweep reads each plain brick group once', async () => {
    const z = await open('gen-int16');
    const src = zgyInlineSource(z);
    for (let i = 0; i < z.meta.size[0]; i++) await src.inline(i);
    const [a, b, c] = z.meta.lodsizes[0];
    expect(src.group).toBe(64);
    expect(src.stats.groupReads).toBe(a * b * c);
  });
});

describe('zgySegyReader', () => {
  const HEAD = 3600;
  async function checkSegy(name, { z0Pad }) {
    const z = await open(name);
    const m = z.meta;
    const [ni, nj, nk] = m.size;
    const r = zgySegyReader(z, { sourceName: `${name}.zgy` });
    const lay = r.zgy.layout;
    expect(lay.pad).toBe(z0Pad);
    expect(lay.ns).toBe(nk + z0Pad);
    const bytes = new Uint8Array(await r.read(0, r.size));
    const dv = new DataView(bytes.buffer);
    expect(dv.getInt16(HEAD - 400 + 24, false)).toBe(5);
    expect(dv.getInt16(HEAD - 400 + 20, false)).toBe(lay.ns);
    expect(dv.getInt16(HEAD - 400 + 16, false)).toBe(Math.round(m.inc[2] * 1000));
    const all = await z.read([0, 0, 0], m.size, 0);
    const samples = new Float32Array(lay.ns);
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
      const t = i * nj + j;
      const at = HEAD + t * lay.traceBytes;
      const th = new DataView(bytes.buffer, at, 240);
      expect(readHeaderInt32(th, 189)).toBe(m.orig[0] + m.inc[0] * i);
      expect(readHeaderInt32(th, 193)).toBe(m.orig[1] + m.inc[1] * j);
      expect(readHeaderInt16(th, 115)).toBe(lay.ns);
      const sc = readHeaderInt16(th, 71);
      const [wx, wy] = m.indexToWorld(i, j);
      expect(applyCoordScalar(readHeaderInt32(th, 181), sc)).toBeCloseTo(wx, 1);
      expect(applyCoordScalar(readHeaderInt32(th, 185), sc)).toBeCloseTo(wy, 1);
      decodeSamples(dv, at + 240, lay.ns, 5, samples);
      for (let s = 0; s < z0Pad; s++) if (samples[s] !== Math.fround(1e30)) throw new Error(`trace ${t} pad sample ${s} = ${samples[s]}`);
      for (let k = 0; k < nk; k++) {
        if (samples[z0Pad + k] !== all[t * nk + k]) throw new Error(`trace ${t} sample ${k}: ${samples[z0Pad + k]} vs ${all[t * nk + k]}`);
      }
    }
    // odd-sized reads anywhere (the sparse path) give the same bytes as the sweep
    const r2 = zgySegyReader(z, { sourceName: `${name}.zgy` });
    for (const [o, l] of [[0, 3601], [3599, 900], [HEAD + 17 * lay.traceBytes + 100, 77], [HEAD + 5 * lay.traceBytes - 3, lay.traceBytes * 3 + 9], [r.size - 500, 500]]) {
      const part = new Uint8Array(await r2.read(o, l));
      const want = bytes.subarray(o, o + l);
      for (let p = 0; p < l; p++) if (part[p] !== want[p]) throw new Error(`read ${o}+${l} differs at ${p}`);
    }
    return { r, bytes, lay };
  }

  test('time, float32: exact samples, numbering, coordinates; 500 ms start padded with 125 nulls', async () => {
    await checkSegy('gen-float32', { z0Pad: 125 });
  });
  test('ZFP compressed: the decoded samples', async () => {
    await checkSegy('gen-zfp-snr30', { z0Pad: 125 });
  });
  test('depth in feet from 1,000 ft: 200 null samples above, the textual header says depth', async () => {
    const { r } = await checkSegy('gen-depth-ft', { z0Pad: 200 });
    const text = (await readTextualHeader(r)).join('\n');
    expect(text).toMatch(/VERTICAL AXIS: DEPTH \(FT\)/);
    expect(text).toMatch(/PETROLORD ZGY V1 SOURCE=gen-depth-ft\.zgy/);
  });
  test('version 1 int8 without world points beyond the three', async () => {
    const z = await open('Empty-v1');
    const lay = zgySegyLayout(z.meta);
    expect(lay.pad).toBe(108); // 648 ms at 6 ms
    expect(lay.il).toEqual({ first: 640, step: 2 });
  });

  test('the repository SEG-Y scan reads the view as the regular grid the ZGY is', async () => {
    const z = await open('gen-int16');
    const r = zgySegyReader(z);
    const scan = await scanGeometry(r);
    expect(scan.totalTraces).toBe(66 * 70);
    expect([scan.il.min, scan.il.max, scan.il.step]).toEqual([1000, 1130, 2]);
    expect([scan.xl.min, scan.xl.max, scan.xl.step]).toEqual([2000, 2276, 4]);
    expect(scan.ns).toBe(70 + 125);
    expect(scan.dtUs).toBe(4000);
  });

  test('negative control: a view that put crosslines slowest would fail the sample check', async () => {
    const z = await open('gen-float32');
    const all = await z.read([0, 0, 0], z.meta.size, 0);
    const [, nj, nk] = z.meta.size;
    // trace (i=1, j=0) in C order vs the swapped-axis position
    expect(all[(1 * nj + 0) * nk]).not.toBe(all[(0 * nj + 1) * nk]);
  });

  test('reads in flight together give the bytes a sweep gives', async () => {
    const z = await open('gen-zfp-snr30');
    const whole = new Uint8Array(await zgySegyReader(z).read(0, zgySegyReader(z).size));
    const r = zgySegyReader(z);
    const tb = r.zgy.layout.traceBytes;
    const parts = [[3600, tb * 70], [3600 + tb * 70 * 9, tb * 140], [3600 + tb * 3, 17], [3600 + tb * 70 * 30 + 5, tb * 2]];
    const got = await Promise.all(parts.map(([o, l]) => r.read(o, l)));
    got.forEach((g, n) => {
      const [o, l] = parts[n];
      expect(Buffer.compare(Buffer.from(g), Buffer.from(whole.subarray(o, o + l)))).toBe(0);
    });
  });

  test('padTop off keeps the samples as stored', async () => {
    const z = await open('gen-int8');
    expect(zgySegyLayout(z.meta, { padTop: false })).toMatchObject({ pad: 0, ns: 70 });
  });
});

describe('zgyAmplitudeClip', () => {
  test('percentiles from whole bricks bracket the signal', async () => {
    const z = await open('gen-zfp-snr30');
    const c = await zgyAmplitudeClip(z);
    expect(c.bricks).toBe(8);
    expect(c.maxAbs).toBeGreaterThan(900);
    expect(c.maxAbs).toBeLessThan(1050);
    expect(c.clip).toBeGreaterThan(c.percentiles['50']);
    expect(c.clip).toBeLessThanOrEqual(c.maxAbs);
  });
});
