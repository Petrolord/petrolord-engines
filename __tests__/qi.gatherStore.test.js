import {
  blockLayout, blockBuilder, readGather, gatherManifest, cdpSlot, gatherBlockKey, foldBlockKey, GATHER_NULL,
} from '../engines/qi/gatherStore';

const cb = 4; const nBins = 6; const ns = 10;

describe('gather store', () => {
  test('layout and keys', () => {
    const l = blockLayout({ cb, nBins, ns });
    expect(l.gatherFloats).toBe(60);
    expect(l.blockFloats).toBe(960);
    expect(l.cdpOffset(1, 2)).toBe(6 * 60);
    expect(gatherBlockKey(2, 3)).toBe('gathers/2-3.f32');
    expect(foldBlockKey(2, 3)).toBe('gathers/2-3.fold.u16');
    expect(cdpSlot(9, 6, 4)).toEqual({ bi: 2, bj: 1, li: 1, lj: 2 });
    expect(() => blockLayout({ cb: 0, nBins, ns })).toThrow();
  });
  test('a gather goes in and comes out, two traces in one bin are their mean, an empty bin is null', () => {
    const b = blockBuilder({ cb, nBins, ns });
    const tr = (v) => Float32Array.from({ length: ns }, (_, s) => v + s);
    expect(b.add(1, 2, 0, tr(1))).toBe(true);
    b.add(1, 2, 3, tr(10)); b.add(1, 2, 3, tr(20));
    expect(b.add(4, 0, 0, tr(1))).toBe(false); // outside the block
    const { data, fold } = b.finish();
    const g = readGather(data, fold, { cb, nBins, ns }, 1, 2);
    expect(Array.from(g.traces[0])).toEqual(Array.from(tr(1)));
    expect(Array.from(g.traces[3])).toEqual(Array.from(tr(15)));
    expect(g.fold).toEqual([1, 0, 0, 2, 0, 0]);
    expect(g.traces[1][0]).toBe(Math.fround(GATHER_NULL));
    // negative control: the neighbouring CDP holds nothing
    const h = readGather(data, fold, { cb, nBins, ns }, 1, 3);
    expect(h.fold.every((f) => f === 0)).toBe(true);
  });
  test('the manifest', () => {
    const m = gatherManifest({ name: 'G', il: { min: 1, step: 1, count: 10 }, xl: { min: 1, step: 1, count: 9 }, ns, dtUs: 4000, cb, bins: { kind: 'offset', width: 100, centres: [50, 150] } });
    expect(m.kind).toBe('gathers_offset');
    expect(m.blocks.grid).toEqual([3, 3]);
    expect(() => gatherManifest({ bins: { kind: 'x' } })).toThrow(/offset or angle/);
  });
});
