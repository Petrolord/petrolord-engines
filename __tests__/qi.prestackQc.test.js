import { nmoStretch, stretchMuteOffset, residualMoveout, foldSummary } from '../engines/qi/prestackQc';

describe('NMO stretch', () => {
  test('the analytic stretch, and the mute offset inverts it', () => {
    // t0 = 1 s, v = 2000 m/s, x = 2000 m: t = sqrt(2) s, stretch sqrt(2) - 1
    expect(nmoStretch(2000, 1, 2000)).toBeCloseTo(Math.SQRT2 - 1, 12);
    const x = stretchMuteOffset(1.2, 2500, 0.3);
    expect(nmoStretch(x, 1.2, 2500)).toBeCloseTo(0.3, 12);
    expect(nmoStretch(0, 1, 2000)).toBe(0);
    expect(nmoStretch(100, 0, 2000)).toBeNaN();
  });
});

describe('residual moveout', () => {
  const dtMs = 2; const ns = 400; const offsets = Array.from({ length: 24 }, (_, k) => 100 + 150 * k);
  const ricker = (t) => { const a = (Math.PI * 30 * t / 1000) ** 2; return (1 - 2 * a) * Math.exp(-a); };
  const gather = (curv) => offsets.map((x) => Float64Array.from({ length: ns }, (_, i) => ricker(i * dtMs - (400 + curv * x * x))));
  test('a known parabolic residual is recovered: 8 ms at the far offset', () => {
    const far = offsets[offsets.length - 1];
    const a = 8 / (far * far);
    const r = residualMoveout({ traces: gather(a), offsets, dtMs, centreMs: 400 });
    expect(r.rmoFarMs).toBeCloseTo(8, 0);
    expect(Math.abs(r.curvature - a) / a).toBeLessThan(0.03);
    expect(r.used).toBe(24);
  });
  test('negative control: a flat gather measures no residual', () => {
    const r = residualMoveout({ traces: gather(0), offsets, dtMs, centreMs: 400 });
    expect(Math.abs(r.rmoFarMs)).toBeLessThan(0.3);
  });
  test('too few live traces give no measure', () => {
    const r = residualMoveout({ traces: [new Float64Array(10), new Float64Array(10)], offsets: [100, 200], dtMs, centreMs: 10 });
    expect(r.rmoFarMs).toBeNaN();
  });
});

test('fold summary', () => {
  expect(foldSummary([3, 2, 0, 1], [50, 150, 250, 350], 1)).toEqual({ total: 6, farOffset: 350, liveBins: 3 });
  expect(foldSummary([3, 2, 0, 1], [50, 150, 250, 350], 2).farOffset).toBe(150);
});
