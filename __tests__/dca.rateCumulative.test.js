/**
 * Rate against cumulative fitting, DCA U2-002.
 *
 * Gate 1, published: CED P03-004 pp. 21-22, the harmonic rate-cumulative
 * table (monthly). Fitting the printed table in rate-cumulative space returns
 * the document's qi and nominal decline.
 * Gate 2, closed form: exact (Np, q) pairs from the Arps relations for the
 * exponential, harmonic and hyperbolic (b below and above 1) are recovered
 * to round-off, and EUR from the fitted parameters equals calculateEUR.
 * Negative control: the same table with the cumulative counted from a later
 * start (a cumulative that does not begin at first production) is caught by
 * the gate: qi and EUR move by the missing volume.
 */
import fs from 'fs';
import path from 'path';

import {
  calculateArpsRateAtCumulative,
  calculateEUR,
  calculateModifiedEUR,
  fitArpsModel,
  fitArpsRateCumulative,
} from '../engines/dca/arps';

const fixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../test-data/dca/dca-terminal-ratecum-fixtures.json'), 'utf8'));
const ced = fixtures.cases.find((c) => c.id === 'ced-p03-004-harmonic-rate-cum');
const relErr = (a, t) => Math.abs(a - t) / Math.abs(t);

const arpsQ = (qi, Di, b, t) => (b === 0 ? qi * Math.exp(-Di * t) : qi / Math.pow(1 + b * Di * t, 1 / b));
const arpsNp = (qi, Di, b, t) => {
  if (b === 0) return (qi / Di) * (1 - Math.exp(-Di * t));
  if (b === 1) return (qi / Di) * Math.log(1 + Di * t);
  return (qi / ((1 - b) * Di)) * (1 - Math.pow(1 + b * Di * t, (b - 1) / b));
};
const exactPoints = (qi, Di, b, n, step) => Array.from({ length: n }, (_, i) => {
  const t = i * step;
  return { cum: arpsNp(qi, Di, b, t), rate: arpsQ(qi, Di, b, t) };
});

describe('CED P03-004 pp. 21-22: harmonic rate-cumulative table (published)', () => {
  const p = ced.printed;
  const pts = p.table_monthly.map(([, q, np]) => ({ cum: np, rate: q }));

  test('the harmonic fit returns the printed qi and monthly nominal decline', () => {
    const fit = fitArpsRateCumulative(pts, 'Harmonic');
    expect(fit.modelType).toBe('Harmonic');
    expect(fit.basis).toBe('rate-cumulative');
    expect(fit.n).toBe(11);
    expect(relErr(fit.qi, p.qi_bbl_per_month)).toBeLessThan(5e-4);
    expect(relErr(fit.Di, p.di_monthly_nominal)).toBeLessThan(2e-3); // 0.0359 printed to 3 figures
    expect(relErr(fit.Di * 12, p.di_yearly_nominal)).toBeLessThan(2e-3);
    expect(fit.R2).toBeGreaterThan(0.9999);
  });

  test('Auto picks the harmonic (or a b within one grid step of 1) on the printed table', () => {
    const fit = fitArpsRateCumulative(pts, 'Auto');
    expect(Math.abs(fit.b - 1)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  test('cross-check: the rate-time fit of the same table agrees with the rate-cumulative fit', () => {
    const t0 = Date.UTC(2020, 0, 1);
    const day = 86400000;
    const rows = p.table_monthly.map(([m, q]) => ({ date: new Date(t0 + m * (365 / 12) * day).toISOString(), rate: q / (365 / 12) }));
    const rt = fitArpsModel(rows, 'Harmonic');
    const rc = fitArpsRateCumulative(pts, 'Harmonic');
    const eurRt = calculateEUR(rt.qi * 365 / 12, rt.Di * 365 / 12, 1, 304, 'harmonic');
    const eurRc = calculateEUR(rc.qi, rc.Di, 1, 304, 'harmonic');
    expect(relErr(eurRc, eurRt)).toBeLessThan(2e-3);
  });

  test('negative control: a cumulative counted from month 12 moves qi and EUR by the missing volume', () => {
    const shifted = pts.filter((x) => x.cum >= 36422).map((x) => ({ cum: x.cum - 36422, rate: x.rate }));
    const good = fitArpsRateCumulative(pts, 'Harmonic');
    const bad = fitArpsRateCumulative(shifted, 'Harmonic');
    expect(relErr(bad.qi, p.qi_bbl_per_month)).toBeGreaterThan(0.2);
    const eurGood = calculateEUR(good.qi, good.Di, 1, 304, 'harmonic');
    const eurBad = calculateEUR(bad.qi, bad.Di, 1, 304, 'harmonic');
    expect(Math.abs(eurGood - eurBad - 36422) / 36422).toBeLessThan(0.02);
  });
});

describe('closed form: exact Arps rate-cumulative pairs', () => {
  test.each([
    ['Exponential', 1000, 0.001, 0],
    ['Harmonic', 800, 0.002, 1],
    ['Hyperbolic', 1200, 0.0015, 0.5],
    ['Hyperbolic', 600, 0.004, 1.3],
  ])('%s qi %d Di %d b %d is recovered and EUR equals calculateEUR', (model, qi, Di, b) => {
    const pts = exactPoints(qi, Di, b, 60, 15);
    const fit = fitArpsRateCumulative(pts, model);
    expect(Math.abs(fit.b - b)).toBeLessThan(1e-9);
    expect(relErr(fit.qi, qi)).toBeLessThan(1e-6);
    expect(relErr(fit.Di, Di)).toBeLessThan(1e-6);
    const type = b === 0 ? 'exponential' : b === 1 ? 'harmonic' : 'hyperbolic';
    expect(relErr(calculateEUR(fit.qi, fit.Di, fit.b, 10, type), calculateEUR(qi, Di, b, 10, type))).toBeLessThan(1e-6);
    for (const x of pts) expect(relErr(calculateArpsRateAtCumulative(fit.qi, fit.Di, fit.b, x.cum), x.rate)).toBeLessThan(1e-6);
  });

  test('a cumulative window fits only the points inside it', () => {
    const early = exactPoints(1000, 0.003, 0, 20, 10);
    const late = exactPoints(1000, 0.003, 0, 80, 10).slice(20).map((x) => ({ ...x, rate: x.rate * 0.7 }));
    const all = [...early, ...late];
    const cumStart = late[0].cum;
    const fit = fitArpsRateCumulative(all, 'Exponential', { cumStart });
    expect(fit.n).toBe(late.length);
    expect(fit.window).toEqual({ cumStart, cumEnd: null });
    const whole = fitArpsRateCumulative(all, 'Exponential');
    expect(whole.n).toBe(all.length);
    expect(fit.R2).toBeGreaterThan(whole.R2);
  });

  test('the modified EUR applies to rate-cumulative parameters (time-free switch)', () => {
    const pts = exactPoints(600, 0.004, 1.3, 60, 15);
    const fit = fitArpsRateCumulative(pts, 'Hyperbolic');
    const Dmin = 0.06 / 365.25;
    expect(relErr(calculateModifiedEUR(fit.qi, fit.Di, fit.b, Dmin, 5),
      calculateModifiedEUR(600, 0.004, 1.3, Dmin, 5))).toBeLessThan(1e-6);
  });

  test('fewer than three points in the window: no fit', () => {
    const fit = fitArpsRateCumulative([{ cum: 0, rate: 10 }, { cum: 5, rate: 9 }], 'Auto');
    expect(fit.modelType).toBe('None');
  });
});
