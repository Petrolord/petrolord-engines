// The extrapolation gate of the gridders follows every control point, not the
// few hundred kept for the fit (found 2026-10-10: a fully picked seismic
// horizon gridded at the bin came back a third holes, so Prospects found no
// closure on it). A dense dome on a 128 x 128 lattice is the Seismolord case.
import { gridSurface, gridSurfaceBlocked, decimateControls, nearControl } from '../lib/gridding/gridding';
import { gridTensionSpline } from '../lib/gridding/tensionSpline';
import { krigeSurface } from '../lib/gridding/kriging';

const N = 128; const BIN = 25;
const dome = (x, y) => -1540 - 0.00004 * ((x - 1600) ** 2 + (y - 1600) ** 2);
const lattice = () => {
  const pts = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const x = j * BIN; const y = i * BIN; pts.push({ x, y, z: dome(x, y), block: 0 }); }
  return pts;
};
const spec = { x0: 0, y0: 0, dx: BIN, dy: BIN, nx: N, ny: N };
const liveShare = (z) => { let n = 0; for (const v of z) if (Math.abs(v) < 1e29) n += 1; return n / z.length; };
// the hull stays on the fitted (decimated) points, so a strip at the very edge
// may stay empty; inside it, no node may be lost
const interiorShare = (z, n = N, m = 16) => {
  let live = 0; let all = 0;
  for (let r = m; r < n - m; r++) for (let c = m; c < n - m; c++) { all += 1; if (Math.abs(z[r * n + c]) < 1e29) live += 1; }
  return live / all;
};

// the old gate, as it was: distance to the decimated points only
function oldGateShare(points, maxExtrapolation) {
  const { points: kept } = decimateControls(points, 700);
  const r2 = maxExtrapolation * maxExtrapolation; let live = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const x = c * BIN; const y = r * BIN;
    if (kept.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= r2)) live += 1;
  }
  return live / (N * N);
}

test('negative control: gating on the decimated points leaves nearly half of a fully picked horizon empty, inside as well', () => {
  expect(oldGateShare(lattice(), 2 * BIN)).toBeLessThan(0.6);
});

test('gridSurface keeps every node inside a fully picked horizon, and the dome crest', () => {
  const g = gridSurface(lattice(), spec, {});
  expect(g.controlCount).toBeLessThanOrEqual(729);   // a 27 x 27 decimation grid
  expect(interiorShare(g.z)).toBe(1);
  expect(liveShare(g.z)).toBeGreaterThan(0.9);
  let best = -Infinity; let at = -1;
  g.z.forEach((v, k) => { if (Math.abs(v) < 1e29 && v > best) { best = v; at = k; } });
  const r = Math.floor(at / N); const c = at % N;
  expect(Math.abs(c * BIN - 1600)).toBeLessThanOrEqual(2 * BIN);
  expect(Math.abs(r * BIN - 1600)).toBeLessThanOrEqual(2 * BIN);
});

test('the blocked, tension-spline and kriging gridders keep a fully picked horizon too', () => {
  const pts = lattice();
  const blocked = gridSurfaceBlocked(pts, spec, { nodeBlocks: new Int32Array(N * N) });
  expect(interiorShare(blocked.z)).toBe(1);
  const ts = gridTensionSpline(pts, spec, { maxExtrapolation: 2 * BIN, maxControl: 300 });
  expect(interiorShare(ts.z)).toBe(1);
  // kriging solves every live node, so a smaller lattice keeps the test quick
  const M = 48;
  const small = pts.filter((p) => p.x < M * BIN && p.y < M * BIN);
  const kr = krigeSurface(small, { ...spec, nx: M, ny: M }, { maxControl: 120, model: 'spherical', range: 1500, sill: 400, nugget: 0 });
  expect(interiorShare(kr.z, M, 8)).toBe(1);
});

test('the gate still nulls nodes far from every control point', () => {
  const pts = lattice().filter((p) => p.x < 1600);   // the west half only
  const g = gridSurface(pts, spec, { mask: 'none' });
  const z = (r, c) => g.z[r * N + c];
  expect(Math.abs(z(64, 100))).toBeGreaterThan(1e29);  // 900 m east of the last pick
  expect(Math.abs(z(64, 30))).toBeLessThan(1e29);
  const near = nearControl([{ x: 0, y: 0 }], 50);
  expect(near(30, 40)).toBe(true);
  expect(near(40, 40)).toBe(false);
  expect(nearControl([{ x: 0, y: 0 }], Infinity)(1e9, 1e9)).toBe(true);
});
