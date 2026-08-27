// Monte Carlo decline-unit gate.
// ============================================================================
// REGRESSION: generateForecastCurve used to evaluate the Arps rate at
// `time / 365` while stepping `time` in DAYS, which silently required a
// PER-YEAR decline constant. Every other member of the dca domain produces
// per-day: fitArpsModel builds t in days and returns Di per day, and
// generateForecast in arps.js steps day by day with no conversion. The Suite's
// DeclineCurveContext fed `fit.Di` straight into the sampler, so DCA Studio's
// probabilistic P10/P50/P90 came back about 25x high.
//
// The gate below is the cheapest thing that would have caught it: with the
// parameter spread set to zero, a Monte Carlo EUR must land on the closed-form
// EUR for the same parameters. The band here allows for the one stochastic
// ingredient left in a default run, the +-20 percent economic-limit draw,
// which moves where the curve stops by a couple of percent. With that draw
// switched off (economicLimitUncertainty: 0) the two agree to floating-point
// precision, which dca.montecarlo.quadrature.test.js pins instead; the 25x
// defect fails either by orders of magnitude.
//
// Originally this band was 10 percent, because the curve was also a 30-day
// LEFT-endpoint rectangular sum that ran about 1.8 percent high. That
// approximation is gone: volume is now integrated in closed form.

import { runMonteCarloSimulation } from '../engines/dca/monteCarlo.js';
import { calculateEUR } from '../engines/dca/arps.js';

const ZERO_SPREAD = { hasIntervals: true, qi: 0, Di: 0, b: 0 };
const CONFIG = { economicLimit: 10, durationDays: 20000, stopAtLimit: true };

// The three Arps families, using the committed Ekene producers' planted
// parameters. Di is PER DAY, exactly as fitArpsModel returns it.
const CASES = [
  { name: 'exponential (Ekene-1)', qi: 120, Di: 0.0012, b: 0, model: 'exponential' },
  { name: 'hyperbolic (Ekene-3)', qi: 150, Di: 0.002, b: 0.5, model: 'hyperbolic' },
  { name: 'harmonic (Ekene-5)', qi: 100, Di: 0.0015, b: 1, model: 'harmonic' },
];

describe('dca monteCarlo: the decline constant is per DAY', () => {
  for (const c of CASES) {
    it(`${c.name}: zero-spread EUR tracks the closed form`, async () => {
      const closed = calculateEUR(c.qi, c.Di, c.b, CONFIG.economicLimit, c.model);
      const r = await runMonteCarloSimulation(
        { qi: c.qi, Di: c.Di, b: c.b }, ZERO_SPREAD, CONFIG, 40,
      );
      const ratio = r.p50 / closed;
      expect(ratio).toBeGreaterThan(0.97);
      expect(ratio).toBeLessThan(1.03);
    });
  }

  it('does NOT reproduce the per-year misreading', async () => {
    // Feeding the sampler a per-YEAR Di is what the old code effectively did
    // with a per-day one. Prove the two are wildly different, so the gate above
    // is actually discriminating rather than passing on a wide band.
    const perDay = await runMonteCarloSimulation(
      { qi: 120, Di: 0.0012, b: 0 }, ZERO_SPREAD, CONFIG, 20,
    );
    const perYearMisreading = await runMonteCarloSimulation(
      { qi: 120, Di: 0.0012 / 365, b: 0 }, ZERO_SPREAD, CONFIG, 20,
    );
    expect(perYearMisreading.p50 / perDay.p50).toBeGreaterThan(10);
  });

  it('a faster decline books less oil, which the old units inverted', async () => {
    const slow = await runMonteCarloSimulation(
      { qi: 120, Di: 0.0006, b: 0 }, ZERO_SPREAD, CONFIG, 20,
    );
    const fast = await runMonteCarloSimulation(
      { qi: 120, Di: 0.0024, b: 0 }, ZERO_SPREAD, CONFIG, 20,
    );
    expect(fast.p50).toBeLessThan(slow.p50);
    // ...and both stay within reach of their closed forms.
    expect(slow.p50 / calculateEUR(120, 0.0006, 0, 10, 'exponential')).toBeLessThan(1.03);
    expect(fast.p50 / calculateEUR(120, 0.0024, 0, 10, 'exponential')).toBeLessThan(1.03);
  });
});
