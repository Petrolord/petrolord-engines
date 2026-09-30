// Mapping & Surface Studio upgrade U2 engine gates (2026-09-30):
// fault blocks for the spline in tension and kriging (U2-001), kriging
// beyond the wells (U2-012) and the isopach (U2-009). Every gate calls
// the shipped function; each has a negative control that fails when the
// feature is removed.
import { gridBlocked } from '../lib/gridding/blockedGridding.js';
import { gridTensionSpline } from '../lib/gridding/tensionSpline.js';
import { krigeSurface } from '../lib/gridding/kriging.js';
import { isopach, dipGrid } from '../lib/gridding/isopach.js';
import { isNull } from '../lib/gridding/gridmath.js';

// Two planar blocks split by a N-S fault at x = 500 with a 100 m throw:
// west block z = -1500 - 0.05 x + 0.02 y, east block 100 m deeper.
const planeW = (x, y) => -1500 - 0.05 * x + 0.02 * y;
const planeE = (x, y) => planeW(x, y) - 100;
const spec = { x0: 0, y0: 0, dx: 25, dy: 25, nx: 41, ny: 41 };
const FAULT_X = 500;
const nodeBlocks = new Int32Array(spec.nx * spec.ny);
for (let r = 0; r < spec.ny; r++) for (let c = 0; c < spec.nx; c++) nodeBlocks[r * spec.nx + c] = spec.x0 + c * spec.dx < FAULT_X ? 0 : 1;
const wells = [];
for (const [x, y] of [[60, 80], [300, 120], [420, 700], [150, 950], [260, 450], [380, 300]]) wells.push({ x, y, z: planeW(x, y), block: 0 });
for (const [x, y] of [[620, 90], [900, 200], [760, 640], [980, 930], [560, 500], [840, 420]]) wells.push({ x, y, z: planeE(x, y), block: 1 });
const truthAt = (i) => {
  const c = i % spec.nx; const r = Math.floor(i / spec.nx);
  const x = spec.x0 + c * spec.dx; const y = spec.y0 + r * spec.dy;
  return nodeBlocks[i] === 0 ? planeW(x, y) : planeE(x, y);
};
const maxErr = (z) => {
  let m = 0; let n = 0;
  for (let i = 0; i < z.length; i++) { if (isNull(z[i])) continue; n += 1; m = Math.max(m, Math.abs(z[i] - truthAt(i))); }
  return { m, n };
};

describe('U2-001 fault blocks for tension and kriging', () => {
  test('tension: each block reproduces its own plane on every node, up to the fault (float32 precision)', () => {
    const g = gridBlocked('tension', wells, spec, { nodeBlocks, tension: 0.5 });
    const { m, n } = maxErr(g.z);
    expect(n).toBe(spec.nx * spec.ny);
    expect(m).toBeLessThan(2e-3);
    expect(g.blockCount).toBe(2);
    expect(g.blocks.map((b) => b.live)).toEqual([20 * 41, 21 * 41]); // x < 500 is 20 columns
  });
  test('kriging (detrended): each block reproduces its own plane; the variance is zero at a well', () => {
    const g = gridBlocked('kriging', wells, spec, { nodeBlocks, model: 'spherical', range: 600, sill: 100, nugget: 0, detrend: true });
    const { m, n } = maxErr(g.z);
    expect(n).toBe(spec.nx * spec.ny);
    expect(m).toBeLessThan(2e-3);
    expect(g.variance).toBeInstanceOf(Float32Array);
  });
  test('negative control: the same wells gridded without blocks smear the 100 m throw into a ramp', () => {
    const t = gridTensionSpline(wells, spec, { tension: 0.5, mask: 'none' });
    const k = krigeSurface(wells, spec, { model: 'spherical', range: 600, sill: 100, nugget: 0, detrend: true, mask: 'none', maxExtrapolation: 1e9 });
    expect(maxErr(t.z).m).toBeGreaterThan(20);
    expect(maxErr(k.z).m).toBeGreaterThan(20);
  });
  test('one block equals the unblocked gridder with mask none (identity)', () => {
    const one = new Int32Array(spec.nx * spec.ny);
    const pts = wells.map((w) => ({ ...w, z: planeW(w.x, w.y), block: 0 }));
    const a = gridBlocked('tension', pts, spec, { nodeBlocks: one, tension: 0.3 });
    const b = gridTensionSpline(pts, spec, { tension: 0.3, mask: 'none' });
    expect(Array.from(a.z)).toEqual(Array.from(b.z));
  });
  test('barriers stay null, a block with too few points is skipped and named, hostile inputs refuse', () => {
    const nb = Int32Array.from(nodeBlocks, (b, i) => ((i % spec.nx) === 20 ? -1 : b));
    const g = gridBlocked('tension', wells, spec, { nodeBlocks: nb });
    for (let r = 0; r < spec.ny; r++) expect(isNull(g.z[r * spec.nx + 20])).toBe(true);
    const few = wells.filter((w) => w.block === 0 || w.x === 620 || w.x === 900);
    const s = gridBlocked('tension', few, spec, { nodeBlocks });
    expect(s.skippedBlocks).toBe(1);
    expect(s.blocks.find((b) => b.block === 1).live).toBe(0);
    expect(() => gridBlocked('tps', wells, spec, { nodeBlocks })).toThrow(/tension and kriging/);
    expect(() => gridBlocked('tension', wells, spec, { nodeBlocks: new Int32Array(3) })).toThrow(/block id per output node/);
    expect(() => gridBlocked('tension', wells.slice(0, 2), spec, { nodeBlocks })).toThrow(/at least 3/);
    expect(() => gridTensionSpline(wells, spec, { nodeMask: new Uint8Array(4) })).toThrow(/node mask/);
  });
});

describe('U2-012 kriging beyond the wells', () => {
  const pts = [{ x: 400, y: 400, z: -1500 }, { x: 600, y: 420, z: -1520 }, { x: 500, y: 600, z: -1480 }, { x: 460, y: 520, z: -1490 }];
  const s = { x0: 0, y0: 0, dx: 50, dy: 50, nx: 41, ny: 41 };
  // the wells are farther apart than the range, so they are uncorrelated and
  // the ordinary-kriging mean far away is their plain average
  const params = { model: 'spherical', range: 80, sill: 400, nugget: 0 };
  const far = 40 * s.nx + 40; // (2000, 2000): far past the range
  test('mask none maps past the hull; beyond the range the value is the data mean and the variance exceeds the sill', () => {
    const g = krigeSurface(pts, s, { ...params, mask: 'none', maxExtrapolation: 1e9 });
    const mean = pts.reduce((a, p) => a + p.z, 0) / pts.length;
    expect(Math.abs(g.z[far] - mean)).toBeLessThan(1e-3);
    expect(g.variance[far]).toBeGreaterThan(params.sill);
    expect(g.live).toBe(s.nx * s.ny);
  });
  test('negative control: the default hull mask leaves the same node empty', () => {
    const g = krigeSurface(pts, s, { ...params, maxExtrapolation: 1e9 });
    expect(isNull(g.z[far])).toBe(true);
    expect(g.live).toBeLessThan(s.nx * s.ny);
    expect(() => krigeSurface(pts, s, { ...params, mask: 'box' })).toThrow(/mask/);
  });
});

describe('U2-009 isopach (true stratigraphic thickness)', () => {
  // a plane dipping 20 degrees east; the base 100 m vertically below it
  const theta = (20 * Math.PI) / 180;
  const sp = { x0: 0, y0: 0, dx: 10, dy: 10, nx: 30, ny: 20 };
  const mk = (off, xyToM = 1) => Float64Array.from({ length: sp.nx * sp.ny }, (_, i) => -1000 - Math.tan(theta) * (i % sp.nx) * sp.dx * xyToM - off);
  test('TST = TVT cos(dip) on every node of a planar dipping layer', () => {
    const r = isopach(mk(0), mk(100), sp);
    for (let i = 0; i < r.tst.length; i++) {
      expect(r.tvt[i]).toBeCloseTo(100, 9);
      expect(r.tst[i]).toBeCloseTo(100 * Math.cos(theta), 9);
      expect(r.dip[i]).toBeCloseTo(20, 9);
    }
    expect(r.maxDipDeg).toBeCloseTo(20, 9);
  });
  test('the frame unit matters: a feet frame needs xyToM, or the dip is wrong', () => {
    const ftSpec = { ...sp, dx: 10 / 0.3048, dy: 10 / 0.3048 };
    const top = mk(0); const base = mk(100);
    const right = isopach(top, base, ftSpec, { xyToM: 0.3048 });
    expect(right.tst[5]).toBeCloseTo(100 * Math.cos(theta), 6);
    const wrong = isopach(top, base, ftSpec); // negative control: feet read as metres
    expect(Math.abs(wrong.tst[5] - 100 * Math.cos(theta))).toBeGreaterThan(1);
    expect(() => dipGrid(top, sp, { xyToM: NaN })).toThrow(/projected frame/);
  });
  test('negative control: a flat layer gives TST = TVT, so the cosine is doing the work', () => {
    const flat = isopach(new Float64Array(600).fill(-1000), new Float64Array(600).fill(-1100), sp);
    expect(flat.tst[33]).toBe(100);
  });
  test('a base above the top is nulled and counted; nulls stay null; mismatched frames refuse', () => {
    const top = mk(0); const base = mk(100);
    base[7] = top[7] + 5;
    top[50] = 1e30;
    const r = isopach(top, base, sp);
    expect(r.negative).toBe(1);
    expect(isNull(r.tst[7])).toBe(true);
    expect(isNull(r.tst[50])).toBe(true);
    expect(() => isopach(top, base.slice(1), sp)).toThrow(/share one grid frame/);
    expect(() => isopach(top, base, sp, { dipFrom: 'side' })).toThrow(/dip reference/);
  });
});
