import { bourdetDerivative, logDecimate, trimSpikes, detectFlowRegimes } from '../engines/welltest/derivative.js';

const logspace = (a, b, n) =>
  Array.from({ length: n }, (_, i) => Math.pow(10, a + ((b - a) * i) / (n - 1)));

describe('bourdetDerivative', () => {
  test('derivative of y = 3 ln x is 3 everywhere', () => {
    const series = logspace(-2, 2, 60).map((x) => ({ x, y: 3 * Math.log(x) }));
    const deriv = bourdetDerivative(series, { L: 0.1 });
    for (const p of deriv) {
      expect(p.derivative).toBeCloseTo(3, 9);
    }
  });

  test('derivative of y = x^2 is 2 x^2 (interior points)', () => {
    const series = logspace(0, 2, 200).map((x) => ({ x, y: x * x }));
    const deriv = bourdetDerivative(series, { L: 0.02 });
    const interior = deriv.slice(10, deriv.length - 10);
    for (const p of interior) {
      expect(Math.abs(p.derivative - 2 * p.x * p.x) / (2 * p.x * p.x)).toBeLessThan(0.02);
    }
  });

  test('smoothing window suppresses gauge noise', () => {
    // deterministic pseudo-noise on y = ln x
    const series = logspace(-1, 2, 150).map((x, i) => ({
      x,
      y: Math.log(x) + 0.01 * Math.sin(78.233 * (i + 1)),
    }));
    const rough = bourdetDerivative(series, { L: 0 });
    const smooth = bourdetDerivative(series, { L: 0.2 });
    const spread = (pts) => {
      const vals = pts.slice(10, -10).map((p) => p.derivative);
      return Math.max(...vals) - Math.min(...vals);
    };
    expect(spread(smooth)).toBeLessThan(spread(rough) / 2);
    const mid = smooth.slice(20, -20);
    for (const p of mid) expect(Math.abs(p.derivative - 1)).toBeLessThan(0.1);
  });

  test('handles unsorted input and drops non-finite / non-positive x', () => {
    const series = [
      { x: 10, y: Math.log(10) },
      { x: 1, y: 0 },
      { x: -5, y: 99 },
      { x: 100, y: Math.log(100) },
      { x: 31.6, y: Math.log(31.6) },
      { x: NaN, y: 1 },
      { x: 3.16, y: Math.log(3.16) },
    ];
    const deriv = bourdetDerivative(series, { L: 0.1 });
    expect(deriv).toHaveLength(5);
    expect(deriv[0].x).toBe(1);
    expect(deriv[2].derivative).toBeCloseTo(1, 3);
  });

  test('returns empty array when fewer than 3 valid points', () => {
    expect(bourdetDerivative([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toEqual([]);
  });
});

describe('logDecimate', () => {
  test('reduces a dense series to ~pointsPerDecade per decade, keeping ends', () => {
    const series = logspace(-3, 2, 5000).map((x) => ({ x, y: x }));
    const out = logDecimate(series, { pointsPerDecade: 10 });
    expect(out.length).toBeLessThan(60); // 5 decades * 10 + ends
    expect(out.length).toBeGreaterThan(45);
    expect(out[0].x).toBe(series[0].x);
    expect(out[out.length - 1].x).toBe(series[series.length - 1].x);
  });

  test('leaves short series untouched', () => {
    const series = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(logDecimate(series)).toEqual(series);
  });
});

describe('trimSpikes', () => {
  test('removes an injected gauge spike and keeps the trend', () => {
    const series = Array.from({ length: 60 }, (_, i) => ({ x: i + 1, y: 1000 + i * 0.5 }));
    series[30] = { x: 31, y: 1500 }; // spike
    const { kept, removed } = trimSpikes(series, { window: 7, threshold: 6 });
    expect(removed).toHaveLength(1);
    expect(removed[0].y).toBe(1500);
    expect(kept).toHaveLength(59);
  });

  test('does not remove points from a smooth series', () => {
    const series = Array.from({ length: 40 }, (_, i) => ({ x: i + 1, y: Math.sqrt(i + 1) }));
    const { removed } = trimSpikes(series);
    expect(removed).toHaveLength(0);
  });
});

describe('detectFlowRegimes', () => {
  test('flags early wellbore storage and radial stabilization', () => {
    // piecewise synthetic derivative: unit slope for 2 decades, then flat
    const early = logspace(-3, -1, 40).map((x) => ({ x, derivative: 1000 * x }));
    const late = logspace(0, 2, 40).map((x) => ({ x, derivative: 10 }));
    const regimes = detectFlowRegimes([...early, ...late]);
    const kinds = regimes.map((r) => r.regime);
    expect(kinds).toContain('wellbore-storage');
    expect(kinds).toContain('radial');
    const radial = regimes.find((r) => r.regime === 'radial');
    expect(radial.spanDecades).toBeGreaterThan(1);
  });

  test('flags half-slope linear flow', () => {
    const series = logspace(-1, 2, 60).map((x) => ({ x, derivative: 5 * Math.sqrt(x) }));
    const regimes = detectFlowRegimes(series);
    expect(regimes.some((r) => r.regime === 'linear')).toBe(true);
  });

  test('returns empty for sparse or invalid series', () => {
    expect(detectFlowRegimes([])).toEqual([]);
    expect(detectFlowRegimes([{ x: 1, derivative: -1 }])).toEqual([]);
  });
});
