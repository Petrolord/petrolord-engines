/**
 * Modified hyperbolic (terminal decline Dmin), DCA U2-001.
 *
 * Gate 1, published: CED P03-004 pp. 17-19, "Hyperbolic to Exponential
 * Decline", worked through the engine's own functions with the document's
 * printed (rounded) inputs.
 * Gate 2, independent closed form: the switch is where the nominal decline
 * equals Dmin, the rate and its slope are continuous there, the closed-form
 * cumulative equals an independent Simpson integration of the rate, the
 * daily forecast sums to it, and a zero-spread Monte Carlo reproduces it.
 * Negative controls: the plain hyperbolic (no Dmin) misses the published
 * answer by far more than the tolerance; a forecast without Dmin is unchanged.
 */
import fs from 'fs';
import path from 'path';

import {
  calculateArpsHyperbolic,
  calculateEUR,
  calculateModifiedEUR,
  calculateModifiedHyperbolicCumulative,
  calculateModifiedHyperbolicRate,
  generateForecast,
  modifiedHyperbolicSwitch,
  terminalDeclineApplies,
  timeToRateModified,
} from '../engines/dca/arps';
import { runMonteCarloSimulation } from '../engines/dca/monteCarlo';

const fixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../test-data/dca/dca-terminal-ratecum-fixtures.json'), 'utf8'));
const ced = fixtures.cases.find((c) => c.id === 'ced-p03-004-hyp-to-exp');
const relErr = (a, t) => Math.abs(a - t) / Math.abs(t);

// Independent quadrature of any rate function (composite Simpson).
const simpson = (f, a, b, n = 8000) => {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
};

describe('CED P03-004 pp. 17-19: hyperbolic to exponential (published)', () => {
  const p = ced.printed;
  const qi = p.qi_bbl_per_month;
  const Di = p.di_monthly_nominal; // per month
  const b = ced.given.b;
  // The tail is exponential: its nominal decline is -ln(1 - dm), as the document uses.
  const Dmin = -Math.log(1 - p.dm_monthly_effective);
  const qLimit = p.q_final_bbl_per_month;

  test('the printed inputs reproduce from the given values', () => {
    expect(1 - Math.pow(1 - ced.given.initial_effective_decline_per_year, 1 / 12)).toBeCloseTo(p.de_monthly, 4);
    expect(-Math.log(1 - p.de_monthly)).toBeCloseTo(Di, 4);
    expect(1 - Math.pow(1 - ced.given.minimum_decline_effective_per_year, 1 / 12)).toBeCloseTo(p.dm_monthly_effective, 6);
    expect(Math.round(ced.given.qi_bbl_per_day * 365 / 12)).toBe(qi);
  });

  test('the switch falls in the printed month and the rate there is the printed rate', () => {
    const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
    expect(sw.fromStart).toBe(false);
    expect(Math.round(sw.tSwitch)).toBe(p.switch_month); // 109.2 months
    expect(Math.abs(sw.qSwitch - p.q_switch_bbl_per_month)).toBeLessThan(1.5); // 761.6 against 762
    // The document's own arithmetic at the rounded month, through the engine's rate.
    expect(Math.round(calculateArpsHyperbolic(qi, Di, b, p.switch_month))).toBe(p.q_switch_bbl_per_month);
  });

  test('hyperbolic volume to the switch month and exponential volume to the final rate', () => {
    // At the document's rounded month, the engine's closed form gives its printed volume.
    const npHyp109 = calculateModifiedHyperbolicCumulative(qi, Di, b, Dmin, p.switch_month);
    expect(relErr(npHyp109, p.np_hyperbolic_bbl)).toBeLessThan(2e-4);
    // Its tail from the rate at month 109 to the final rate, (q - qf) / Dmin.
    const q109 = calculateArpsHyperbolic(qi, Di, b, p.switch_month);
    expect(relErr((q109 - qLimit) / Dmin, p.np_exponential_bbl)).toBeLessThan(2e-3);
  });

  test('EUR of the modified hyperbolic equals the printed total within 0.1 percent', () => {
    const printedTotal = p.np_hyperbolic_bbl + p.np_exponential_bbl; // 259,672 bbl
    const eur = calculateModifiedEUR(qi, Di, b, Dmin, qLimit);
    expect(relErr(eur, printedTotal)).toBeLessThan(1e-3);
  });

  test('negative control: the plain hyperbolic misses the printed total by far more than the tolerance', () => {
    const printedTotal = p.np_hyperbolic_bbl + p.np_exponential_bbl;
    const plain = calculateEUR(qi, Di, b, qLimit, 'hyperbolic');
    expect(relErr(plain, printedTotal)).toBeGreaterThan(0.2);
    expect(relErr(calculateModifiedEUR(qi, Di, b, undefined, qLimit), printedTotal)).toBeGreaterThan(0.2);
  });

  test('the same well in daily units: the daily forecast stops near the printed total', () => {
    const daysPerMonth = 365 / 12;
    const qiDay = ced.given.qi_bbl_per_day;
    const DiDay = Di / daysPerMonth;
    const DminDay = Dmin / daysPerMonth;
    const eurDay = calculateModifiedEUR(qiDay, DiDay, b, DminDay, ced.given.final_rate_bbl_per_day);
    expect(relErr(eurDay, p.np_hyperbolic_bbl + p.np_exponential_bbl)).toBeLessThan(2e-3);
    const fc = generateForecast({ qi: qiDay, Di: DiDay, b, Dmin: DminDay, modelType: 'Hyperbolic' },
      { forecastDurationDays: 40000, economicLimit: 5, stopAtLimit: true }, '2020-01-01');
    // Right-endpoint daily sum: just under the closed form, by about half a day of rate.
    expect(fc.eur).toBeLessThan(eurDay);
    expect(relErr(fc.eur, eurDay)).toBeLessThan(1e-3);
    expect(fc.terminalDecline.tSwitch).toBeCloseTo(109.2 * daysPerMonth, -1);
  });
});

describe('independent closed form', () => {
  const qi = 1000; const Di = 0.004; const b = 1.4; const Dmin = 0.08 / 365.25; // per day

  test('the switch is where the nominal decline equals Dmin; rate and slope continuous', () => {
    const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
    const Dt = Di / (1 + b * Di * sw.tSwitch);
    expect(relErr(Dt, Dmin)).toBeLessThan(1e-12);
    const eps = 1e-3;
    const left = calculateModifiedHyperbolicRate(qi, Di, b, Dmin, sw.tSwitch - eps);
    const right = calculateModifiedHyperbolicRate(qi, Di, b, Dmin, sw.tSwitch + eps);
    const at = calculateModifiedHyperbolicRate(qi, Di, b, Dmin, sw.tSwitch);
    expect(relErr(at, sw.qSwitch)).toBeLessThan(1e-12);
    // slope continuity: -dq/dt / q on each side equals Dmin
    expect(relErr((left - at) / eps / at, Dmin)).toBeLessThan(1e-3);
    expect(relErr((at - right) / eps / at, Dmin)).toBeLessThan(1e-3);
    // after the switch the decline is exactly Dmin
    const q1 = calculateModifiedHyperbolicRate(qi, Di, b, Dmin, sw.tSwitch + 1000);
    expect(relErr(q1, sw.qSwitch * Math.exp(-Dmin * 1000))).toBeLessThan(1e-12);
  });

  test('closed-form cumulative equals Simpson integration of the rate, either side of the switch', () => {
    const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
    for (const T of [sw.tSwitch * 0.5, sw.tSwitch, sw.tSwitch * 1.7, sw.tSwitch + 20000]) {
      const rate = (t) => calculateModifiedHyperbolicRate(qi, Di, b, Dmin, t);
      // integrate the two pieces separately so the kink does not cost Simpson accuracy
      const a = Math.min(T, sw.tSwitch);
      const num = simpson(rate, 0, a) + (T > a ? simpson(rate, a, T) : 0);
      expect(relErr(calculateModifiedHyperbolicCumulative(qi, Di, b, Dmin, T), num)).toBeLessThan(1e-9);
    }
  });

  test('EUR and time to the limit agree with each other and with the cumulative', () => {
    for (const qLimit of [5, 50, 400]) {
      const t = timeToRateModified(qi, Di, b, Dmin, qLimit);
      expect(relErr(calculateModifiedHyperbolicRate(qi, Di, b, Dmin, t), qLimit)).toBeLessThan(1e-9);
      expect(relErr(calculateModifiedEUR(qi, Di, b, Dmin, qLimit),
        calculateModifiedHyperbolicCumulative(qi, Di, b, Dmin, t))).toBeLessThan(1e-9);
    }
  });

  test('a limit above the switch rate gives the plain hyperbolic EUR', () => {
    const sw = modifiedHyperbolicSwitch(qi, Di, b, Dmin);
    const qLimit = sw.qSwitch * 1.5;
    expect(calculateModifiedEUR(qi, Di, b, Dmin, qLimit)).toBe(calculateEUR(qi, Di, b, qLimit, 'hyperbolic'));
  });

  test('harmonic (b = 1) switches too; exponential (b = 0) is unchanged', () => {
    const sw = modifiedHyperbolicSwitch(500, 0.002, 1, Dmin);
    expect(relErr(0.002 / (1 + 0.002 * sw.tSwitch), Dmin)).toBeLessThan(1e-12);
    expect(terminalDeclineApplies(0, Dmin)).toBe(false);
    expect(modifiedHyperbolicSwitch(500, 0.002, 0, Dmin)).toBeNull();
    expect(calculateModifiedEUR(500, 0.002, 0, Dmin, 10)).toBe(calculateEUR(500, 0.002, 0, 10, 'exponential'));
  });

  test('an initial decline already below Dmin is exponential at Dmin from the start', () => {
    const sw = modifiedHyperbolicSwitch(500, Dmin / 2, 0.9, Dmin);
    expect(sw).toEqual({ tSwitch: 0, qSwitch: 500, npSwitch: 0, Dmin, fromStart: true });
    expect(relErr(calculateModifiedEUR(500, Dmin / 2, 0.9, Dmin, 10), (500 - 10) / Dmin)).toBeLessThan(1e-12);
  });

  test('generateForecast without Dmin returns exactly what it always did (no terminalDecline key)', () => {
    const cfg = { forecastDurationDays: 12000, economicLimit: 10, stopAtLimit: true };
    const base = generateForecast({ qi, Di, b, modelType: 'Hyperbolic' }, cfg, '2020-01-01');
    const zero = generateForecast({ qi, Di, b, Dmin: 0, modelType: 'Hyperbolic' }, cfg, '2020-01-01');
    expect(zero).toEqual(base);
    expect('terminalDecline' in base).toBe(false);
    const mod = generateForecast({ qi, Di, b, Dmin, modelType: 'Hyperbolic' }, cfg, '2020-01-01');
    // the switch is at day 3,082; after it the tail declines faster than the hyperbolic would
    expect(mod.terminalDecline.tSwitch).toBeGreaterThan(3000);
    expect(mod.rates.slice(0, 3000)).toEqual(base.rates.slice(0, 3000));
    expect(mod.eur).toBeLessThan(base.eur);
  });

  test('a zero-spread Monte Carlo reproduces the modified EUR (Dmin travels with every draw)', async () => {
    const config = { economicLimit: 10, durationDays: 200000, stopAtLimit: true, economicLimitUncertainty: 0 };
    const mc = await runMonteCarloSimulation({ qi, Di, b, Dmin }, { qi: 0, Di: 0, b: 0 }, config, 20, null, 7);
    expect(relErr(mc.p50, calculateModifiedEUR(qi, Di, b, Dmin, 10))).toBeLessThan(1e-9);
    const plain = await runMonteCarloSimulation({ qi, Di, b }, { qi: 0, Di: 0, b: 0 }, config, 20, null, 7);
    expect(relErr(plain.p50, calculateEUR(qi, Di, b, 10, 'hyperbolic'))).toBeLessThan(1e-9);
    expect(plain.p50).toBeGreaterThan(mc.p50 * 1.1);
  }, 120000);
});
