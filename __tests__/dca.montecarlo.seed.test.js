// Monte Carlo reproducibility gate.
// ============================================================================
// REGRESSION: every draw in monteCarlo.js came from a bare Math.random, with
// no way to inject a generator. Two identical runs of DCA Studio therefore
// returned different P10/P50/P90, so a booked EUR could not be re-derived by
// the reviewer holding the same fit, the same config and the same iteration
// count. The economic-limit draw made this true even with a perfect fit: with
// every parameter spread set to zero the sampler still moved the limit +-20
// percent, so the EUR wandered on inputs that carry no uncertainty at all.
//
// The gate: a seeded run must be bit-identical on repeat, a different seed
// must move the answer, and an unseeded run must still wander (which is what
// keeps the first assertion from passing on a sampler that stopped sampling).

import {
  runMonteCarloSimulation,
  createSeededRng,
} from '../engines/dca/monteCarlo.js';

// Ekene-1's planted exponential parameters. Di is PER DAY.
const BASE = { qi: 120, Di: 0.0012, b: 0 };
const SPREAD = { hasIntervals: true, qi: 12, Di: 0.0002, b: 0.1 };
const ZERO_SPREAD = { hasIntervals: true, qi: 0, Di: 0, b: 0 };
const CONFIG = { economicLimit: 10, durationDays: 20000, stopAtLimit: true };

const N = 120;

describe('dca monteCarlo: a seeded run is reproducible', () => {
  it('the same seed returns the same distribution, not merely the same summary', async () => {
    const a = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N, null, 42);
    const b = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N, null, 42);

    expect(b.p10).toBe(a.p10);
    expect(b.p50).toBe(a.p50);
    expect(b.p90).toBe(a.p90);
    expect(b.mean).toBe(a.mean);
    expect(b.distribution).toEqual(a.distribution);
  });

  it('a numeric seed and the generator it names are the same run', async () => {
    const a = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N, null, 7);
    const b = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N, null, createSeededRng(7));
    expect(b.distribution).toEqual(a.distribution);
  });

  it('a different seed is a different realization', async () => {
    const a = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N, null, 42);
    const b = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N, null, 43);
    expect(b.distribution).not.toEqual(a.distribution);
    // Same population though, so the summaries stay in the same neighbourhood.
    expect(b.p50 / a.p50).toBeGreaterThan(0.8);
    expect(b.p50 / a.p50).toBeLessThan(1.25);
  });

  it('the seed used is reported back, and is null when there was none', async () => {
    const seeded = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, 60, null, 99);
    const unseeded = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, 60);
    expect(seeded.seed).toBe(99);
    expect(unseeded.seed).toBeNull();
  });

  it('without a seed the run still wanders, which is what the seed fixes', async () => {
    const a = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N);
    const b = await runMonteCarloSimulation(BASE, SPREAD, CONFIG, N);
    expect(b.distribution).not.toEqual(a.distribution);
  });

  it('the economic-limit draw alone made a zero-uncertainty fit non-reproducible', async () => {
    // No parameter spread: the only remaining draw is the +-20 percent
    // economic limit. Unseeded, that alone spreads the EUR.
    const a = await runMonteCarloSimulation(BASE, ZERO_SPREAD, CONFIG, N);
    const b = await runMonteCarloSimulation(BASE, ZERO_SPREAD, CONFIG, N);
    expect(new Set(a.distribution).size).toBeGreaterThan(1);
    expect(b.distribution).not.toEqual(a.distribution);

    // Seeded, the same zero-uncertainty fit repeats exactly.
    const c = await runMonteCarloSimulation(BASE, ZERO_SPREAD, CONFIG, N, null, 5);
    const d = await runMonteCarloSimulation(BASE, ZERO_SPREAD, CONFIG, N, null, 5);
    expect(d.distribution).toEqual(c.distribution);
  });
});

describe('dca monteCarlo: sample curves are reproducible too', () => {
  it('config.startDate anchors the curve dates instead of "now"', async () => {
    const startDate = '2020-01-01T00:00:00.000Z';
    const cfg = { ...CONFIG, startDate };
    const a = await runMonteCarloSimulation(BASE, SPREAD, cfg, N, null, 3);
    const b = await runMonteCarloSimulation(BASE, SPREAD, cfg, N, null, 3);

    expect(a.sampleCurves.length).toBeGreaterThan(0);
    expect(a.sampleCurves[0][0].date.toISOString()).toBe(startDate);
    // 30-day steps off that anchor.
    const step = a.sampleCurves[0][1].date - a.sampleCurves[0][0].date;
    expect(step).toBe(30 * 24 * 60 * 60 * 1000);

    const dates = (r) => r.sampleCurves.map((c) => c.map((p) => p.date.getTime()));
    expect(dates(b)).toEqual(dates(a));
    expect(b.sampleCurves.map((c) => c.map((p) => p.rate)))
      .toEqual(a.sampleCurves.map((c) => c.map((p) => p.rate)));
  });

  it('an unparseable or absent startDate falls back to now, without NaN dates', async () => {
    const r = await runMonteCarloSimulation(
      BASE, SPREAD, { ...CONFIG, startDate: 'not a date' }, 60, null, 1,
    );
    const first = r.sampleCurves[0][0].date.getTime();
    expect(Number.isFinite(first)).toBe(true);
  });
});

describe('createSeededRng', () => {
  it('is a well-behaved uniform source, and each seed is its own stream', () => {
    const rng = createSeededRng(2026);
    const draws = Array.from({ length: 20000 }, rng);

    for (const x of draws) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const mean = draws.reduce((s, x) => s + x, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);

    // Each of the ten deciles gets roughly a tenth of the draws.
    const deciles = Array(10).fill(0);
    draws.forEach((x) => { deciles[Math.floor(x * 10)]++; });
    for (const count of deciles) {
      expect(count).toBeGreaterThan(draws.length * 0.08);
      expect(count).toBeLessThan(draws.length * 0.12);
    }

    expect(Array.from({ length: 50 }, createSeededRng(1)))
      .not.toEqual(Array.from({ length: 50 }, createSeededRng(2)));
    expect(Array.from({ length: 50 }, createSeededRng(1)))
      .toEqual(Array.from({ length: 50 }, createSeededRng(1)));
  });
});
