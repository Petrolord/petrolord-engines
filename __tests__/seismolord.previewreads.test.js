// Sampled preview scan cost (QI programme Q0): a large file must preview in
// a few hundred reads, because each read has a fixed cost in a browser
// (about 45 ms per Blob read in Chromium on the QI test VPS; a 1,000,000
// trace file took 30,000 reads and over 20 minutes before this change). The
// reader here synthesizes a 1,000,000-trace SEG-Y on demand, so the test
// holds no 10 GB buffer, and counts every read. The answers are checked
// against the known geometry, including steps above 1 (the L3 rule).
import { scanGeometry, MAX_PREVIEW_STOPS } from '../engines/seismolord/segyScan';

function virtualSegy({ nIl, nXl, ns = 2500, il0 = 1, ilStep = 1, xl0 = 1, xlStep = 1 }) {
  const traceBytes = 240 + ns * 4;
  const total = nIl * nXl;
  const size = 3600 + total * traceBytes;
  const reads = { count: 0, bytes: 0 };
  const header = (t) => {
    const il = il0 + Math.floor(t / nXl) * ilStep;
    const xl = xl0 + (t % nXl) * xlStep;
    return { il, xl, x: 50000000 + 2500 * (t % nXl), y: 670000000 + 2500 * Math.floor(t / nXl) };
  };
  const reader = {
    size,
    async read(off, len) {
      if (off < 0 || off + len > size) throw new Error(`Read out of range: ${off}+${len}`);
      reads.count += 1;
      reads.bytes += len;
      const out = new ArrayBuffer(len);
      const v = new DataView(out);
      const put32 = (abs, val) => { const r = abs - off; if (r >= 0 && r + 4 <= len) v.setInt32(r, val, false); };
      const put16 = (abs, val) => { const r = abs - off; if (r >= 0 && r + 2 <= len) v.setInt16(r, val, false); };
      put16(3216, 4000); put16(3220, ns); put16(3224, 5);
      const first = Math.max(0, Math.floor((off - 3600) / traceBytes));
      const last = Math.min(total - 1, Math.floor((off + len - 3600) / traceBytes));
      for (let t = first; t <= last; t++) {
        const base = 3600 + t * traceBytes;
        const h = header(t);
        put16(base + 70, -100);
        put32(base + 180, h.x); put32(base + 184, h.y);
        put32(base + 188, h.il); put32(base + 192, h.xl);
      }
      return out;
    },
  };
  return { reader, reads, total };
}

describe('sampled preview read count', () => {
  test('a 1,000,000-trace file previews in a few hundred reads with the right geometry', async () => {
    const { reader, reads } = virtualSegy({ nIl: 1000, nXl: 1000 });
    const scan = await scanGeometry(reader, {}, { maxTraces: 20000 });
    expect(scan.sampled).toBe(true);
    expect(scan.il).toEqual({ min: 1, max: 1000, step: 1, count: 1000 });
    expect(scan.xl).toEqual({ min: 1, max: 1000, step: 1, count: 1000 });
    expect(scan.inlineSorted).toBe(true);
    expect(reads.count).toBeLessThan(400);
    // the head plus the blocks are read as whole traces: about 3 % of the
    // file, the price of a few hundred reads instead of 30,000 tiny ones
    const { total } = virtualSegy({ nIl: 1000, nXl: 1000 });
    expect(reads.bytes).toBeLessThan(0.05 * total * 10240);
  });

  test('steps above 1 are still measured exactly at scale (L3)', async () => {
    const { reader } = virtualSegy({ nIl: 500, nXl: 2000, il0: 1000, ilStep: 4, xl0: 10, xlStep: 3 });
    const scan = await scanGeometry(reader, {}, { maxTraces: 20000 });
    expect(scan.il).toEqual({ min: 1000, max: 1000 + 499 * 4, step: 4, count: 500 });
    expect(scan.xl).toEqual({ min: 10, max: 10 + 1999 * 3, step: 3, count: 2000 });
  });

  test('negative control: a preview with every stop isolated would need one read per stop', async () => {
    // maxTraces 20000 with blocks of 2 traces placed 1 MiB apart: at least the
    // stop count in reads. The coalesced scan stays under MAX_PREVIEW_STOPS + head chunks.
    const { reader, reads } = virtualSegy({ nIl: 1000, nXl: 1000 });
    await scanGeometry(reader, {}, { maxTraces: 20000, chunkBytes: 10240 });
    // chunkBytes of one trace forces a read per trace: the old cost
    expect(reads.count).toBeGreaterThan(19000);
  });

  test('small previews keep the exact pair sampling (no change below the stop cap)', async () => {
    expect(MAX_PREVIEW_STOPS).toBe(200);
    const { reader, reads } = virtualSegy({ nIl: 40, nXl: 100, ns: 4 });
    const scan = await scanGeometry(reader, {}, { maxTraces: 64 });
    expect(scan.sampled).toBe(true);
    expect(scan.il.count).toBe(40);
    expect(scan.xl.count).toBe(100);
    expect(reads.count).toBeLessThan(40);
  });
});
