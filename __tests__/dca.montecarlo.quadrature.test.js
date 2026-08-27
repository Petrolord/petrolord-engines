// Monte Carlo volume + uncertainty gates.
// ============================================================================
// Three defects fixed together, all found while gating the decline-unit fix:
//
//   1. EUR was a 30-day LEFT-endpoint rectangle sum over a falling rate, which
//      runs about 1.8 percent high, and the loop dropped the last partial step
//      at the economic limit while allowing a full step past the duration cap.
//   2. The economic limit was sampled +-20 percent on every realisation from a
//      hardcoded constant, so a fit carrying no parameter uncertainty still
//      produced a scattered EUR from a number the user never chose.
//   3. generateProbabilisticCurves DREW its "P10" and "P90" curves instead of
//      offsetting the fit by 1.28 sigma, so they were random realizations with
//      an inflated spread, they moved on every call, and the direction flips
//      were inert (a normal with a negative sigma is the same distribution).
//
// The volume gate is exactness against calculateEUR rather than a band: the
// Arps rate has an elementary integral, so with the limit draw switched off a
// zero-spread run has no excuse to differ from the closed form at all.

import {
  runMonteCarloSimulation,
  generateProbabilisticCurves,
  DEFAULT_ECONOMIC_LIMIT_UNCERTAINTY,
} from '../engines/dca/monteCarlo.js';
import { calculateEUR } from '../engines/dca/arps.js';

const ZERO_SPREAD = { hasIntervals: true, qi: 0, Di: 0, b: 0 };
// economicLimitUncertainty: 0 leaves nothing stochastic, so one realisation is
// the whole answer and 4 iterations are as informative as 4000.
const EXACT_CONFIG = {
  economicLimit: 10,
  durationDays: 20000,
  stopAtLimit: true,
  economicLimitUncertainty: 0,
};

// The three Arps families, on the committed Ekene producers' parameters.
// Di is PER DAY, as fitArpsModel returns it.
const CASES = [
  { name: 'exponential (Ekene-1)', qi: 120, Di: 0.0012, b: 0, model: 'exponential' },
  { name: 'hyperbolic (Ekene-3)', qi: 150, Di: 0.002, b: 0.5, model: 'hyperbolic' },
  { name: 'harmonic (Ekene-5)', qi: 100, Di: 0.0015, b: 1, model: 'harmonic' },
];

const rate = (qi, Di, b, t) => (b <= 0
  ? qi * Math.exp(-Di * t)
  : qi / Math.pow(1 + b * Di * t, 1 / b));

// Independent numeric integral of the produced rate, Simpson on a fine grid.
// Deliberately not the engine's closed form: it is the check on it.
const simpson = (f, a, bEnd, n = 20000) => {
  const h = (bEnd - a) / n;
  let sum = f(a) + f(bEnd);
  for (let i = 1; i < n; i++) sum += f(a + i * h) * (i % 2 ? 4 : 2);
  return (sum * h) / 3;
};

describe('dca monteCarlo: EUR is integrated, not rectangle-summed', () => {
  for (const c of CASES) {
    it(`${c.name}: a zero-uncertainty run IS the closed form`, async () => {
      const closed = calculateEUR(c.qi, c.Di, c.b, EXACT_CONFIG.economicLimit, c.model);
      const r = await runMonteCarloSimulation(
        { qi: c.qi, Di: c.Di, b: c.b }, ZERO_SPREAD, EXACT_CONFIG, 4, null, 1,
      );
      // The old rectangle sum landed 1 to 3 percent high here.
      expect(r.p50 / closed).toBeCloseTo(1, 6);
      // Nothing stochastic is left, so every realisation agrees.
      expect(new Set(r.distribution).size).toBe(1);
    });
  }

  it('a duration cap truncates the volume at the cap, not a step past it', async () => {
    // 900 days is well inside Ekene-1's ~2071 day limit time, and is not a
    // multiple of the 30-day step, so an off-by-one-step error shows up.
    const cfg = { ...EXACT_CONFIG, durationDays: 905 };
    const r = await runMonteCarloSimulation({ qi: 120, Di: 0.0012, b: 0 }, ZERO_SPREAD, cfg, 4, null, 1);
    const exact = simpson((t) => rate(120, 0.0012, 0, t), 0, 905);
    expect(r.p50 / exact).toBeCloseTo(1, 6);
  });

  it('a facility cap is integrated as a plateau plus a decline', async () => {
    // qi 300 against a 200 stb/d facility: the well is choked for the first
    // stretch, and the split between plateau and decline falls mid-step.
    const facilityLimit = 200;
    const cfg = { ...EXACT_CONFIG, facilityLimit };
    const r = await runMonteCarloSimulation({ qi: 300, Di: 0.0012, b: 0 }, ZERO_SPREAD, cfg, 4, null, 1);

    const tLimit = Math.log(300 / cfg.economicLimit) / 0.0012;
    const exact = simpson(
      (t) => Math.min(facilityLimit, rate(300, 0.0012, 0, t)), 0, tLimit,
    );
    expect(r.p50 / exact).toBeCloseTo(1, 5);
    // And the plateau must actually bind: uncapped would book more.
    const uncapped = await runMonteCarloSimulation(
      { qi: 300, Di: 0.0012, b: 0 }, ZERO_SPREAD, EXACT_CONFIG, 4, null, 1,
    );
    expect(r.p50).toBeLessThan(uncapped.p50);
  });
});

describe('dca monteCarlo: the economic-limit spread is the caller\'s choice', () => {
  const BASE = { qi: 120, Di: 0.0012, b: 0 };

  it('defaults to the documented ±20 percent when nothing is passed', async () => {
    expect(DEFAULT_ECONOMIC_LIMIT_UNCERTAINTY).toBe(0.2);
    const cfg = { economicLimit: 10, durationDays: 20000, stopAtLimit: true };
    const r = await runMonteCarloSimulation(BASE, ZERO_SPREAD, cfg, 200, null, 11);
    // A zero-spread fit still scatters, because the limit is still drawn.
    expect(new Set(r.distribution).size).toBeGreaterThan(1);
    const spread = (Math.max(...r.distribution) - Math.min(...r.distribution)) / r.p50;
    expect(spread).toBeGreaterThan(0.001);
    expect(spread).toBeLessThan(0.05);
  });

  it('zero makes a zero-uncertainty fit fully deterministic', async () => {
    const r = await runMonteCarloSimulation(BASE, ZERO_SPREAD, EXACT_CONFIG, 200, null, 11);
    expect(new Set(r.distribution).size).toBe(1);
    expect(r.p10).toBe(r.p90);
  });

  it('a wider setting produces a wider EUR spread', async () => {
    const at = (economicLimitUncertainty) => runMonteCarloSimulation(
      BASE, ZERO_SPREAD,
      { economicLimit: 10, durationDays: 20000, stopAtLimit: true, economicLimitUncertainty },
      300, null, 11,
    );
    const widthOf = (r) => Math.max(...r.distribution) - Math.min(...r.distribution);
    const narrow = widthOf(await at(0.05));
    const wide = widthOf(await at(0.5));
    expect(wide).toBeGreaterThan(narrow * 2);
  });

  it('is clamped to a sane fraction rather than trusted blindly', async () => {
    // 5 (i.e. ±500%) would otherwise drive the sampled limit negative, so the
    // curve would never stop and EUR would run to the duration cap.
    const cfg = { economicLimit: 10, durationDays: 20000, stopAtLimit: true, economicLimitUncertainty: 5 };
    const r = await runMonteCarloSimulation(BASE, ZERO_SPREAD, cfg, 60, null, 11);
    const uncapped = await runMonteCarloSimulation(
      BASE, ZERO_SPREAD, { ...cfg, economicLimitUncertainty: 1 }, 60, null, 11,
    );
    expect(r.distribution).toEqual(uncapped.distribution);
    // Negative sampled limits are excluded by the clamp: nothing runs to the cap.
    const closed = calculateEUR(120, 0.0012, 0, 10, 'exponential');
    expect(Math.max(...r.distribution) / closed).toBeLessThan(1.5);
  });
});

describe('dca monteCarlo: the P10/P90 curves are offsets, not draws', () => {
  const BASE = { qi: 120, Di: 0.0012, b: 0.3 };
  const CI = { hasIntervals: true, qi: 12, Di: 0.0002, b: 0.1 };
  const CFG = { economicLimit: 10, durationDays: 20000, stopAtLimit: true };
  const eurOf = (curve) => curve[curve.length - 1].cum;

  it('returns the same curves every call', () => {
    const a = generateProbabilisticCurves(BASE, CI, CFG);
    const b = generateProbabilisticCurves(BASE, CI, CFG);
    expect(b.p10.map((p) => p.rate)).toEqual(a.p10.map((p) => p.rate));
    expect(b.p90.map((p) => p.rate)).toEqual(a.p90.map((p) => p.rate));
    expect(b.p50.map((p) => p.rate)).toEqual(a.p50.map((p) => p.rate));
  });

  it('orders the band the way the petroleum convention reads it', () => {
    const { p10, p50, p90 } = generateProbabilisticCurves(BASE, CI, CFG);
    expect(eurOf(p10)).toBeGreaterThan(eurOf(p50));
    expect(eurOf(p50)).toBeGreaterThan(eurOf(p90));
    // The high case starts higher and outlives the low case.
    expect(p10[0].rate).toBeGreaterThan(p90[0].rate);
    expect(p10.length).toBeGreaterThan(p90.length);
  });

  it('offsets each parameter by exactly 1.28 sigma, sigma being CI/2', () => {
    const { p10, p90 } = generateProbabilisticCurves(BASE, CI, CFG);
    // t = 0 isolates qi from the decline parameters.
    expect(p10[0].rate).toBeCloseTo(120 + 1.2816 * (12 / 2), 6);
    expect(p90[0].rate).toBeCloseTo(120 - 1.2816 * (12 / 2), 6);
  });

  it('is the fit itself in the middle', () => {
    const { p50 } = generateProbabilisticCurves(BASE, CI, CFG);
    expect(p50[0].rate).toBeCloseTo(120, 9);
  });

  it('holds up when the fit carries no confidence intervals', () => {
    const flat = generateProbabilisticCurves(BASE, { hasIntervals: false }, CFG);
    expect(eurOf(flat.p10)).toBeCloseTo(eurOf(flat.p50), 6);
    expect(eurOf(flat.p90)).toBeCloseTo(eurOf(flat.p50), 6);
  });
});
