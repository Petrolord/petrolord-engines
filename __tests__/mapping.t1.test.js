// Mapping & Surface Studio T1 engine gates (2026-09-26): closure and spill
// analysis, splines in tension, control-point merging, the open grid mask
// and depth conversion tied to wells. Every expected value comes from an
// independent stdlib-Python oracle in tools/validation/mapping/
// (oracle_closure.py, oracle_tension.py, oracle_welltie.py), never from
// this code; tools/validation/mapping/negcontrol_t1.sh proves each gate
// goes red when the engine is wrong.
import fs from 'fs';
import path from 'path';
import { closuresAtContact, spillAnalysis, closureAt, closureCurve, crestIndex } from '../lib/gridding/closure.js';
import { fitTensionSpline, gridTensionSpline, besselK0, tensionGreen } from '../lib/gridding/tensionSpline.js';
import { gridSurface, mergeCloseControls } from '../lib/gridding/gridding.js';
import { isNull } from '../lib/gridding/gridmath.js';
import {
  averageVelocityTies, depthFromAverageVelocity, tieResiduals, residualStats,
} from '../engines/mapping/wellTie.js';

const gold = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'mapping', 'goldens', f), 'utf8'));
const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('closure analysis against oracle_closure.py', () => {
  const G = gold('closure_cases.json');
  describe.each(G.cases.map((c) => [c.name, c]))('%s', (_n, c) => {
    const z = Float64Array.from(c.z);
    const relTol = (v) => G.tolerance * Math.max(1, Math.abs(v));

    test('closures at the contact: count, crest, nodes, area, GRV and open flag', () => {
      const r = closuresAtContact(z, c.spec, { contact: c.contact });
      expect(r.closures).toHaveLength(c.closures.length);
      r.closures.forEach((k, i) => {
        const e = c.closures[i];
        expect(k.nodes).toBe(e.nodes);
        expect(k.open).toBe(e.open);
        expect(k.crest.index).toBe(e.crestIndex);
        near(k.areaM2, e.areaM2, relTol(e.areaM2));
        near(k.grvM3, e.grvM3, relTol(e.grvM3));
      });
    });

    test('spill elevation, spill node, edge limit and merges', () => {
      const s = spillAnalysis(z, c.spec, c.seed != null ? { seed: c.seed } : {});
      expect(s.crest.index).toBe(c.spill.crestIndex);
      near(s.spillZ, c.spill.spillZ, 1e-9);
      expect(s.limitedByEdge).toBe(c.spill.limitedByEdge);
      expect(s.merges).toHaveLength(c.spill.merges.length);
      s.merges.forEach((m, i) => {
        near(m.saddleZ, c.spill.merges[i].saddleZ, 1e-9);
        expect(m.saddle.index).toBe(c.spill.merges[i].saddleIndex);
        near(m.culminationZ, c.spill.merges[i].culminationZ, 1e-9);
      });
      if (!c.spill.limitedByEdge) expect(s.spill.index).toBe(c.spill.spillIndex);
    });

    test('closure at each level equals a fresh search from the crest', () => {
      const s = spillAnalysis(z, c.spec, c.seed != null ? { seed: c.seed } : {});
      c.levels.forEach((L, i) => {
        const a = closureAt(s, c.spec, L);
        const e = c.curve[i];
        expect(a.nodes).toBe(e.nodes);
        near(a.grvM3, e.grvM3, relTol(e.grvM3));
      });
    });
  });

  test('the curve is monotone: area and GRV grow as the contact deepens, closed down to the spill', () => {
    const c = G.cases.find((k) => k.name === 'cone');
    const z = Float64Array.from(c.z);
    const s = spillAnalysis(z, c.spec);
    const curve = closureCurve(s, c.spec, { levels: 25 });
    expect(curve).toHaveLength(25);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].contact).toBeLessThan(curve[i - 1].contact);
      expect(curve[i].areaM2).toBeGreaterThanOrEqual(curve[i - 1].areaM2);
      expect(curve[i].grvM3).toBeGreaterThanOrEqual(curve[i - 1].grvM3);
    }
    expect(curve.every((p) => p.closed)).toBe(true);
    expect(closureAt(s, c.spec, s.spillZ - 1).closed).toBe(false);
  });

  test('minRelief hides merges with neighbours lower than the threshold above the saddle', () => {
    const c = G.cases.find((k) => k.name === 'two_domes');
    const z = Float64Array.from(c.z);
    const m = c.spill.merges[0];
    const relief = m.culminationZ - m.saddleZ; // 150 m from the oracle
    expect(spillAnalysis(z, c.spec, { seed: c.seed, minRelief: relief - 50 }).merges).toHaveLength(1);
    expect(spillAnalysis(z, c.spec, { seed: c.seed, minRelief: relief + 50 }).merges).toHaveLength(0);
    near(spillAnalysis(z, c.spec, { seed: c.seed }).merges[0].relief, relief, 1e-9);
  });

  test('refusals: no contact, empty grid, frame mismatch', () => {
    const spec = { x0: 0, y0: 0, dx: 1, dy: 1, nx: 3, ny: 3 };
    expect(() => closuresAtContact(new Float64Array(9), spec, {})).toThrow(/contact/);
    expect(() => closuresAtContact(new Float64Array(8), spec, { contact: 0 })).toThrow(/frame/);
    expect(crestIndex(new Float64Array(9).fill(1e30))).toBe(-1);
    expect(() => spillAnalysis(new Float64Array(9).fill(1e30), spec)).toThrow(/crest/);
  });
});

describe('spline in tension against oracle_tension.py', () => {
  const G = gold('tension_cases.json');
  const scaleOf = (c) => Math.max(1, ...c.points.map((q) => Math.abs(q.z)));

  test('K0 matches the numerically integrated / series oracle', () => {
    for (const [x, v] of G.k0) near(besselK0(x), v, 2e-7 * Math.max(v, 1e-3));
  });

  test.each(G.cases.map((c) => [c.name, c]))('%s: p, spacing and values at the targets', (_n, c) => {
    const f = fitTensionSpline(c.points, { tension: c.tension, smoothing: c.smoothing });
    if (c.tension > 0) near(f.p, c.p, 1e-12 * Math.max(1, c.p));
    c.targets.forEach(([x, y], i) => near(f.evaluate(x, y), c.values[i], G.tolerance * scaleOf(c)));
  });

  test('the gridded surface (table lookup) equals the direct evaluation at every node', () => {
    const c = G.cases.find((k) => k.name === 'sidetrack_T0.5');
    const spec = { x0: -1000, y0: -700, dx: 40, dy: 50, nx: 51, ny: 37 };
    const g = gridTensionSpline(c.points, spec, { tension: 0.5, mask: 'none' });
    const f = fitTensionSpline(c.points, { tension: 0.5 });
    expect(g.live).toBe(spec.nx * spec.ny);
    for (let r = 0; r < spec.ny; r += 3) {
      for (let k = 0; k < spec.nx; k += 3) {
        near(g.z[r * spec.nx + k], f.evaluate(spec.x0 + k * spec.dx, spec.y0 + r * spec.dy), 5e-3); // f32 storage
      }
    }
  });

  test('tension 0 without smoothing is the thin-plate spline itself', () => {
    const c = G.cases.find((k) => k.name === 'sidetrack_T0.25');
    const spec = { x0: -800, y0: -500, dx: 50, dy: 50, nx: 33, ny: 29 };
    const a = gridTensionSpline(c.points, spec, { tension: 0, mask: 'none' });
    const b = gridSurface(c.points, spec, { mask: 'none', maxExtrapolation: 1e9 });
    a.z.forEach((v, i) => expect(v).toBe(b.z[i]));
  });

  test('overshoot falls as tension rises; misfit grows with smoothing (the oracle anchors, re-read)', () => {
    const over = G.cases.filter((k) => k.overshoot != null).map((k) => k.overshoot);
    for (let i = 1; i < over.length; i++) expect(over[i]).toBeLessThan(over[i - 1]);
    const mis = G.cases.filter((k) => k.maxMisfit != null).map((k) => k.maxMisfit);
    for (let i = 1; i < mis.length; i++) expect(mis[i]).toBeGreaterThan(mis[i - 1]);
  });

  test('hull mask by default; refusals are plain', () => {
    const c = G.cases.find((k) => k.name === 'plane_T0.5');
    const spec = { x0: -20, y0: -20, dx: 5, dy: 5, nx: 21, ny: 21 };
    const hull = gridTensionSpline(c.points, spec, { tension: 0.5 });
    expect(hull.live).toBeLessThan(21 * 21);
    expect(isNull(hull.z[0])).toBe(true);
    expect(() => fitTensionSpline(c.points.slice(0, 2), { tension: 0.5 })).toThrow(/3 control points/);
    expect(() => fitTensionSpline(c.points, { tension: 1 })).toThrow(/Tension/);
    expect(() => fitTensionSpline(c.points, { smoothing: -1 })).toThrow(/Smoothing/);
    expect(() => gridTensionSpline(c.points, spec, { mask: 'box' })).toThrow(/mask/);
    expect(() => besselK0(0)).toThrow(/positive/);
    expect(tensionGreen(0, 1)).toBeCloseTo(Math.log(2) - 0.5772156649015329, 15);
  });
});

describe('control-point merging (sidetracks)', () => {
  const W = [
    { x: 0, y: 0, z: -1800, well: 'KETA-1' },
    { x: 0, y: 0, z: -1805, well: 'KETA-1 ST1' },
    { x: 400, y: 100, z: -1841, well: 'KETA-2' },
    { x: -300, y: 350, z: -1846, well: 'KETA-3' },
    { x: 150, y: -450, z: -1847, well: 'KETA-4' },
  ];
  test('an exact duplicate location makes TPS singular until merged', () => {
    const spec = { x0: -400, y0: -500, dx: 50, dy: 50, nx: 18, ny: 19 };
    expect(() => gridSurface(W, spec, { maxExtrapolation: 1e9 })).toThrow(/singular/);
    const m = mergeCloseControls(W, 0);
    expect(m.points).toHaveLength(4);
    expect(m.merged).toEqual([{ wells: ['KETA-1', 'KETA-1 ST1'], n: 2, x: 0, y: 0, z: -1802.5, spreadZ: 5 }]);
    expect(m.points[0].well).toBe('KETA-1 + KETA-1 ST1');
    expect(() => gridSurface(m.points, spec, { maxExtrapolation: 1e9 })).not.toThrow();
  });
  test('single linkage chains points within tolerance; distant points stay', () => {
    const P = [{ x: 0, y: 0, z: 1 }, { x: 8, y: 0, z: 2 }, { x: 16, y: 0, z: 3 }, { x: 40, y: 0, z: 4 }];
    const m = mergeCloseControls(P, 10);
    expect(m.points).toHaveLength(2);
    expect(m.merged[0].n).toBe(3);
    near(m.merged[0].x, 8, 1e-12);
    near(m.merged[0].z, 2, 1e-12);
    expect(m.merged[0].wells).toEqual(['#0', '#1', '#2']);
    expect(mergeCloseControls(P, 7.9).merged).toHaveLength(0);
    expect(() => mergeCloseControls(P, -1)).toThrow(/merge distance/);
  });
});

describe('open grid mask', () => {
  test("mask 'none' maps beyond the outermost wells; 'hull' stays the default", () => {
    const pts = [{ x: 0, y: 0, z: 1 }, { x: 100, y: 0, z: 2 }, { x: 0, y: 100, z: 3 }];
    const spec = { x0: -50, y0: -50, dx: 25, dy: 25, nx: 9, ny: 9 };
    const hull = gridSurface(pts, spec, { maxExtrapolation: 1e9 });
    const open = gridSurface(pts, spec, { maxExtrapolation: 1e9, mask: 'none' });
    expect(open.live).toBe(81);
    expect(hull.live).toBeLessThan(40);
    expect(() => gridSurface(pts, spec, { mask: 'box' })).toThrow(/mask/);
  });
});

describe('depth conversion tied to wells against oracle_welltie.py', () => {
  const G = gold('welltie_cases.json');
  const tol = G.tolerance;
  test('average velocity at each well from its top depth and the TWT at the well', () => {
    const { ties, skipped } = averageVelocityTies(G.wells, Float64Array.from(G.twt), G.spec);
    expect(skipped).toHaveLength(0);
    ties.forEach((t, i) => {
      expect(t.well).toBe(G.expectedTies[i].well);
      near(t.twtMs, G.expectedTies[i].twtMs, tol);
      near(t.vavg, G.expectedTies[i].vavg, tol);
    });
  });
  test('depth from an average-velocity grid is the closed-form depth at every node', () => {
    const z = depthFromAverageVelocity(Float64Array.from(G.twt), Float64Array.from(G.vavgGrid));
    z.forEach((v, i) => near(v, -G.depthM[i], tol));
  });
  test('tie residuals of a map shifted 3 m shallow are -3 m, and their statistics', () => {
    const rows = tieResiduals(G.wells, Float64Array.from(G.shiftedMap), G.spec);
    rows.forEach((r, i) => near(r.residualM, G.expectedResiduals[i].residualM, tol));
    const s = residualStats(rows);
    const e = G.expectedResiduals.map((r) => r.residualM);
    expect(s.count).toBe(5);
    near(s.mean, e.reduce((a, b) => a + b, 0) / e.length, 1e-9);
    near(s.rms, Math.sqrt(e.reduce((a, b) => a + b * b, 0) / e.length), 1e-9);
    near(s.maxAbs, Math.max(...e.map(Math.abs)), 1e-9);
    // the four node wells see exactly the 3 m shift
    e.slice(0, 4).forEach((v) => near(v, -3, 1e-9));
  });
  test('skips name their reason: no TWT at the well, bad depth, non-positive TWT', () => {
    const spec = { x0: 0, y0: 0, dx: 1, dy: 1, nx: 2, ny: 2 };
    const twt = Float64Array.from([1e30, 1e30, 1e30, 1e30]);
    const r = averageVelocityTies([{ well: 'A', x: 0.5, y: 0.5, depthM: 1000 }, { well: 'B', x: 0.5, y: 0.5, depthM: -3 }], twt, spec);
    expect(r.skipped).toEqual([{ well: 'A', reason: 'no_twt' }, { well: 'B', reason: 'bad_depth' }]);
    const r2 = averageVelocityTies([{ well: 'C', x: 0.5, y: 0.5, depthM: 1000 }], Float64Array.from([0, 0, 0, 0]), spec);
    expect(r2.skipped).toEqual([{ well: 'C', reason: 'bad_twt' }]);
    expect(isNull(depthFromAverageVelocity([1000], [-5])[0])).toBe(true);
  });
});
