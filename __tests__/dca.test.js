/**
 * dca domain anchors. The FULL oracle + literature acceptance suites run
 * in the Suite's CI against the vendored copy
 * (src/utils/declineCurve/__tests__/); this suite pins the extraction
 * standalone: closed-form self-consistency, headline literature cases from
 * the committed goldens (SPEE REP #6 Table 1 in full, CED P03-004,
 * Ahmed REH 16-1), the calculateEUR hyperbolic sign-bug regression, and
 * satellite-module round-trips (typeCurve, groupRollup, monteCarlo).
 */
import fs from 'fs';
import path from 'path';

import {
  calculateArpsExponential,
  calculateArpsHyperbolic,
  calculateEUR,
  fitArpsModel,
  generateForecast,
} from '../engines/dca/arps';
import { normalizeByTime, fitTypeCurve } from '../engines/dca/typeCurve';
import { latestScenarioByWell, rollupGroup } from '../engines/dca/groupRollup';
import { runMonteCarloSimulation, createEURHistogram } from '../engines/dca/monteCarlo';

const fixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../test-data/dca/dca-literature-fixtures.json'), 'utf8'));
const byId = (id) => fixtures.cases.find((c) => c.id === id);
const DAYS_PER_YEAR = 365;
const relErr = (actual, truth) => Math.abs(actual - truth) / Math.abs(truth);

// Clean daily {date, rate} series from an exact Arps model.
const makeSeries = (qi, Di, b, nDays) => {
  const start = new Date('2020-01-01').getTime();
  const rows = [];
  for (let d = 0; d < nDays; d++) {
    rows.push({
      date: new Date(start + d * 86_400_000).toISOString().slice(0, 10),
      rate: b === 0 ? qi * Math.exp(-Di * d) : qi / Math.pow(1 + b * Di * d, 1 / b),
    });
  }
  return rows;
};

describe('goldens are armed', () => {
  test('fixture file armed with the SC1/SC7b case set', () => {
    expect(fixtures.armed).toBe(true);
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(8);
  });
});

describe('closed-form self-consistency (Arps 1945)', () => {
  test('hand-checked forward-model points', () => {
    expect(calculateArpsExponential(1000, 1e-3, 500)).toBeCloseTo(606.530659, 5);
    expect(calculateArpsHyperbolic(1000, 1e-3, 0.5, 1000)).toBeCloseTo(444.444444, 5);
  });

  test('calculateEUR matches the closed forms on every b branch (sign-bug regression)', () => {
    // exponential: (qi - qL)/Di
    expect(relErr(calculateEUR(1000, 1e-3, 0, 10, 'exponential'), (1000 - 10) / 1e-3)).toBeLessThan(1e-12);
    // harmonic: (qi/Di)·ln(qi/qL)
    expect(relErr(calculateEUR(800, 2e-3, 1, 8, 'harmonic'), (800 / 2e-3) * Math.log(100))).toBeLessThan(1e-12);
    // hyperbolic b = 0.5: pre-SC1 the (1 - b) denominator sign error made this NEGATIVE
    const closed = (Math.pow(1200, 0.5) / ((1 - 0.5) * 1.5e-3)) * (Math.pow(1200, 0.5) - Math.pow(12, 0.5));
    const eur = calculateEUR(1200, 1.5e-3, 0.5, 12, 'hyperbolic');
    expect(eur).toBeGreaterThan(0);
    expect(relErr(eur, closed)).toBeLessThan(1e-12);
  });

  test('fitArpsModel recovers exact synthetic parameters for all three models', () => {
    const exp = fitArpsModel(makeSeries(1000, 1e-3, 0, 180), 'Exponential');
    expect(relErr(exp.parameters.qi, 1000)).toBeLessThan(1e-6);
    expect(relErr(exp.parameters.Di, 1e-3)).toBeLessThan(1e-6);

    const har = fitArpsModel(makeSeries(800, 2e-3, 1, 365), 'Harmonic');
    expect(relErr(har.parameters.qi, 800)).toBeLessThan(1e-6);
    expect(relErr(har.parameters.Di, 2e-3)).toBeLessThan(1e-6);

    const hyp = fitArpsModel(makeSeries(1200, 1.5e-3, 0.5, 365), 'Hyperbolic');
    expect(Math.abs(hyp.parameters.b - 0.5)).toBeLessThan(1e-9);
    expect(relErr(hyp.parameters.qi, 1200)).toBeLessThan(1e-6);
    expect(relErr(hyp.parameters.Di, 1.5e-3)).toBeLessThan(1e-6);
  });

  test('generateForecast: economic-limit stop and the documented <=1% cumulative undershoot', () => {
    const params = { qi: 1000, Di: 1e-3, b: 0, modelType: 'Exponential' };
    const config = { forecastDurationDays: 20000, economicLimit: 50, stopAtLimit: true };
    const fc = generateForecast(params, config, '2020-01-01');
    // analytic time to 50: ln(1000/50)/1e-3 ~ 2995.7 days
    expect(fc.timeToLimit).toBeGreaterThan(2990);
    expect(fc.timeToLimit).toBeLessThan(3001);
    const analytic = (1000 - 50) / 1e-3;
    expect(fc.eur).toBeLessThanOrEqual(analytic);
    expect(relErr(fc.eur, analytic)).toBeLessThan(0.01);
  });
});

describe('literature anchors (full suites live in the Suite CI)', () => {
  test('CED P03-004 exponential oil: q(3 yr) and Np', () => {
    const c = byId('ced-p03-004-exponential-oil');
    const DiDay = -Math.log(1 - c.given.effective_decline_per_year) / DAYS_PER_YEAR;
    const qEnd = calculateArpsExponential(c.given.qi_bbl_d, DiDay, c.published.t_years * DAYS_PER_YEAR);
    expect(Math.abs(qEnd - c.published.q_end_bbl_d)).toBeLessThanOrEqual(c.tolerances.rate_abs);
    const np = calculateEUR(c.given.qi_bbl_d, DiDay, 0, qEnd, 'exponential');
    expect(relErr(np, c.published.np_bbl)).toBeLessThan(c.tolerances.np_rel);
  });

  test('CED P03-004 shale-gas hyperbolic (b = 1.2, the sign-bug branch)', () => {
    const c = byId('ced-p03-004-shale-gas-hyperbolic');
    const DiDay = -Math.log(1 - c.given.effective_decline_per_year) / DAYS_PER_YEAR;
    const qEnd = calculateArpsHyperbolic(c.given.qi_mscf_d, DiDay, c.given.b, c.published.t_years * DAYS_PER_YEAR);
    expect(Math.abs(qEnd - c.published.q_end_mscf_d)).toBeLessThanOrEqual(c.tolerances.rate_abs);
    const np = calculateEUR(c.given.qi_mscf_d, DiDay, c.given.b, qEnd, 'hyperbolic');
    expect(np).toBeGreaterThan(0);
    expect(relErr(np, c.published.np_mscf_time_form)).toBeLessThan(c.tolerances.np_rel);
  });

  test('SPEE REP #6 Table 1: all 37 rows, tangent and secant columns', () => {
    const c = byId('spee-rep6-table1-effective-nominal');
    expect(c.published_table.length).toBe(37);
    for (const row of c.published_table) {
      const D = row.nominal_pct / 100;
      const de = 1 - calculateArpsExponential(1, D, 1);
      expect(Math.abs(de - Number(row.tangent_effective_pct) / 100))
        .toBeLessThanOrEqual(c.tolerances.tangent_frac_abs);
      for (const [bStr, printed] of Object.entries(row.secant_effective_pct)) {
        const b = Number(bStr);
        const q1 = b === 0
          ? calculateArpsExponential(1, D, 1)
          : calculateArpsHyperbolic(1, D, b, 1);
        expect(Math.abs(1 - q1 - Number(printed) / 100))
          .toBeLessThanOrEqual(c.tolerances.secant_frac_abs);
      }
    }
  });

  test('Ahmed REH Example 16-1 (dry gas, rate-cumulative)', () => {
    const c = byId('ahmed-reh-16-1-exponential-rate-cum');
    const { qi_mmscf_d: qi, di_lsq_per_day: diLsq, di_graph_per_day: diGraph } = c.given;
    expect(Math.abs(calculateArpsExponential(qi, diLsq, c.published.t_to_econ_days) - c.published.q_econ_mmscf_d))
      .toBeLessThanOrEqual(c.tolerances.rate_abs);
    const gp = calculateEUR(qi, diGraph, 0, c.published.q_econ_mmscf_d, 'exponential');
    expect(relErr(gp, c.published.gp_at_econ_mmscf)).toBeLessThan(c.tolerances.gp_rel);
  });
});

describe('satellite modules', () => {
  test('typeCurve: normalizeByTime + fitTypeCurve round-trip on exact hyperbolic data', () => {
    const data = makeSeries(1000, 1.5e-3, 0.5, 365);
    const normalized = normalizeByTime(data);
    expect(normalized.length).toBe(365);
    const fit = fitTypeCurve(normalized, 'Hyperbolic');
    expect(relErr(fit.qi, 1000)).toBeLessThan(0.05);
    expect(fit.R2).toBeGreaterThan(0.99);
  });

  test('groupRollup: sums latest-scenario EURs and reports missing wells', () => {
    const scenarios = [
      { wellId: 'w1', stream: 'oil', name: 'old', createdAt: '2026-01-01', forecastResults: { eur: 100, rates: [] } },
      { wellId: 'w1', stream: 'oil', name: 'new', createdAt: '2026-02-01', forecastResults: { eur: 150, rates: [{ date: '2026-03-01', rate: 10 }] } },
      { wellId: 'w2', stream: 'oil', name: 'only', createdAt: '2026-01-15', forecastResults: { eur: 50, rates: [{ date: '2026-03-10', rate: 5 }] } },
    ];
    expect(latestScenarioByWell(scenarios, 'oil').w1.name).toBe('new');
    const rollup = rollupGroup(
      { id: 'g', name: 'G', wellIds: ['w1', 'w2', 'w3'] },
      { w1: { name: 'Well 1' }, w2: { name: 'Well 2' }, w3: { name: 'Well 3' } },
      scenarios, 'oil');
    expect(rollup.totalEur).toBe(200);
    expect(rollup.perWell.length).toBe(2);
    expect(rollup.missingWells).toEqual([{ wellId: 'w3', wellName: 'Well 3' }]);
    expect(rollup.combinedRates.find((r) => r.month === '2026-03').rate).toBe(15);
  });

  test('monteCarlo: EUR percentiles ordered P10 >= P50 >= P90, histogram conserves count', async () => {
    // Confidence intervals are numeric half-widths interpreted as +/- 2 sigma.
    const results = await runMonteCarloSimulation(
      { qi: 1000, Di: 0.4, b: 0.5 },
      { qi: 100, Di: 0.08, b: 0.1 },
      { durationDays: 3650, economicLimit: 50, stopAtLimit: true },
      400);
    expect(results.iterations).toBe(400);
    expect(results.p10).toBeGreaterThanOrEqual(results.p50);
    expect(results.p50).toBeGreaterThanOrEqual(results.p90);
    expect(results.distribution.length).toBe(400);
    const hist = createEURHistogram(results.distribution, 20);
    expect(hist.reduce((s, bin) => s + bin.count, 0)).toBe(400);
  });
});
