// Waterflood Design Studio upgrade, Step 1 (WF-U1, Suite
// docs/upgrade/WaterfloodDesignStudio-UPGRADE.md). Every gate calls the
// engine; each block carries its negative control.
//
//   1. The mobility ratio of the five-spot areal sweep correlation. Craig
//      (1955; SPE Monograph 3, 1971, ch. 5) correlated the areal sweep at
//      breakthrough with M taken with krw at the AVERAGE water saturation
//      behind the front at breakthrough (Welge), kro at Swc. The engine fed
//      the endpoint M (krw at Sor). 'craig' is opt-in; the default stays
//      'endpoint' because course fixtures recorded it.
//   2. The recovery of the pattern split ER = ED x EA x EV, closing on Np
//      over the pattern OOIP.
//   3. Surveillance volumes on a calendar basis (time_weighting 'calendar'):
//      a daily history is unchanged; a monthly history gives volumes, and the
//      Ekene monthly file comes back to its ledger VRR.
//   4. Hall plot windows: the two fitted lines, their intercepts and the 95
//      percent interval of each slope.
//   5. Chan labels carry no em dash (house copy rule).
import * as fs from 'fs';
import * as path from 'path';
import { analyzeDisplacement, sampleFractionalFlowData, coreyKr } from '../engines/scal/fractionalFlow.js';
import {
  forecastPattern, samplePatternData, arealSweepAtBreakthrough, arealSweepMobilityRatio, displacementStateAtQi,
} from '../engines/waterflood/patternForecast.js';
import { analyzeWaterflood, classifyChan, rowDayWeights, olsLine, t95 } from '../engines/waterflood/waterflood.js';

const S = sampleFractionalFlowData();
const spec = { krSpec: { type: 'corey', ...S.params }, muW: S.muW, muO: S.muO };
const P = samplePatternData().pattern;

describe('1. the mobility ratio of the areal sweep correlation', () => {
  it('Craig M is krw at the Welge average saturation behind the front, by hand on the sample', () => {
    const d = analyzeDisplacement(spec);
    const m = arealSweepMobilityRatio(spec, d, 'craig');
    // SwAvgBt from the engine's Welge tangent; krw by Corey at it, by hand
    const swn = (d.bl.SwAvgBt - 0.2) / (1 - 0.2 - 0.2);
    const krwHand = 0.4 * swn ** 2;
    expect(m.krwAtSwAvgBt).toBeCloseTo(krwHand, 12);
    expect(m.krwAtSwAvgBt).toBeCloseTo(coreyKr(d.bl.SwAvgBt, S.params).krw, 12);
    expect(m.M_craig).toBeCloseTo((krwHand / 0.5) / (1.0 / 5.0), 12);
    expect(m.M_craig).toBeCloseTo(1.527864, 5);
    expect(m.M_endpoint).toBeCloseTo(4, 12);
    expect(m.M).toBe(m.M_craig);
  });

  it('the forecast enters the correlation with Craig M when asked, endpoint by default (negative control)', () => {
    const craig = forecastPattern({ displacementSpec: spec, pattern: { ...P, mobilityBasis: 'craig' } });
    const endpoint = forecastPattern({ displacementSpec: spec, pattern: P });
    expect(craig.summary.mobilityBasis).toBe('craig');
    expect(craig.summary.EAbt).toBeCloseTo(arealSweepAtBreakthrough(craig.summary.M_craig), 12);
    expect(craig.summary.M_craig).toBeCloseTo(1.5278640450, 5);
    expect(craig.summary.EAbt).toBeCloseTo(0.62457, 4);
    expect(endpoint.summary.mobilityBasis).toBe('endpoint');
    expect(endpoint.summary.EAbt).toBeCloseTo(arealSweepAtBreakthrough(4), 12);
    expect(Math.abs(craig.summary.EAbt - endpoint.summary.EAbt)).toBeGreaterThan(0.05);
    // later pattern breakthrough with the larger sweep
    expect(craig.summary.breakthrough_days).toBeGreaterThan(endpoint.summary.breakthrough_days);
  });

  it('Craig M never exceeds the endpoint M (krw rises with Sw)', () => {
    for (const nw of [1, 2, 3, 4]) for (const muO of [0.5, 2, 20]) {
      const sp = { krSpec: { type: 'corey', ...S.params, nw }, muW: 0.5, muO };
      const m = arealSweepMobilityRatio(sp, null, 'craig');
      expect(m.M_craig).toBeLessThanOrEqual(m.M_endpoint + 1e-12);
    }
  });
});

describe('2. the recovery split', () => {
  for (const EV of [1, 0.6]) {
    it(`ER = ED x EA x EV closes on Np over the pattern OOIP (EV ${EV})`, () => {
      const f = forecastPattern({ displacementSpec: spec, pattern: { ...P, EV, mobilityBasis: 'craig' } });
      const r = f.summary.recoverySplit;
      const pv = 7758 * P.area_acres * P.h_ft * P.phi;
      const ooip = (pv * (1 - 0.2)) / P.Bo;
      expect(f.summary.pattern_ooip_stb).toBeCloseTo(ooip, 6);
      expect(r.ER).toBeCloseTo(f.summary.Np_stb / ooip, 12);
      expect(r.product).toBeCloseTo(r.ER, 12);
      expect(r.EV).toBe(EV);
      // ED is the Welge state inside the swept region at the last step
      const last = f.series[f.series.length - 1];
      const qi = Math.max(0, last.Wi_bbl) / (pv * EV * last.EA);
      const state = displacementStateAtQi(f.displacement, qi);
      expect(r.ED).toBeCloseTo(state.ED, 9);
    });
  }
});

describe('3. surveillance volumes on a calendar basis', () => {
  const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'ekene-dynamic', 'waterflood.json'), 'utf8'));
  const cfg = { bo: FIX.fvf.Bo, bw: FIX.fvf.Bw, bg: FIX.fvf.Bg, rs: FIX.fvf.Rs };

  it('weights: days to the next row, the last row its gap before; rows mode is all ones', () => {
    expect(rowDayWeights(['2024-01-01', '2024-02-01', '2024-03-01'], 'calendar')).toEqual([31, 29, 29]);
    expect(rowDayWeights(['2024-01-01', '2024-02-01', '2024-03-01'])).toEqual([1, 1, 1]);
  });

  it('a daily history gives the same answer in both modes', () => {
    const rows = [];
    for (let i = 0; i < 40; i += 1) {
      const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
      rows.push({ date, well: 'P', oil_bbl: 300 - i, water_bbl: 20 + i, gas_mcf: 100 });
      rows.push({ date, well: 'I', inj_bbl: 350 + (i % 5) });
    }
    const a = analyzeWaterflood(rows, { bo: 1.2, bw: 1.0 });
    const b = analyzeWaterflood(rows, { bo: 1.2, bw: 1.0, time_weighting: 'calendar' });
    expect(b.kpis.vrr_avg).toBeCloseTo(a.kpis.vrr_avg, 12);
    expect(b.kpis.total_oil_bbl).toBeCloseTo(a.kpis.total_oil_bbl, 9);
    expect(b.vrr_series.vrr_rolling).toEqual(a.vrr_series.vrr_rolling);
  });

  it('a monthly file of daily rates gives volumes: 31 days of 100 STB/d is 3,100 STB (rows mode: 100)', () => {
    const rows = [
      { date: '2024-01-01', well: 'P', oil_bbl: 100 }, { date: '2024-02-01', well: 'P', oil_bbl: 100 },
      { date: '2024-01-01', well: 'I', inj_bbl: 120 }, { date: '2024-02-01', well: 'I', inj_bbl: 120 },
    ];
    const cal = analyzeWaterflood(rows, { bo: 1, bw: 1, time_weighting: 'calendar' });
    expect(cal.kpis.total_oil_bbl).toBe(100 * 31 + 100 * 31);
    expect(cal.kpis.days_covered).toBe(62);
    const old = analyzeWaterflood(rows, { bo: 1, bw: 1 });
    expect(old.kpis.total_oil_bbl).toBe(200); // the defect the option removes
  });

  it('the Ekene monthly history comes back to its ledger VRR (volumes), rows mode does not', () => {
    const cal = analyzeWaterflood(FIX.surveillance_rows, { ...cfg, time_weighting: 'calendar' });
    const rows = analyzeWaterflood(FIX.surveillance_rows, cfg);
    const ledger = FIX.expected.cumulative_vrr;
    const relCal = Math.abs(cal.kpis.vrr_avg - ledger) / ledger;
    const relRows = Math.abs(rows.kpis.vrr_avg - ledger) / ledger;
    // the residual is the last month: 30 days (the gap before it) for a 31-day December
    expect(relCal).toBeLessThan(2e-5);
    expect(relRows).toBeGreaterThan(10 * relCal);
    expect(rows.kpis.vrr_avg).toBe(FIX.expected.surveillance.cumulative_vrr_rows_as_days);
  });
});

describe('4. Hall plot windows', () => {
  // Hall (1963) known case: 1,000 bbl/d at 2,000 psi for 15 days, then 3,000 psi
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    rows.push({ date, well: 'INJ', inj_bbl: 1000, whp_psi: i < 15 ? 2000 : 3000 });
    rows.push({ date, well: 'PROD', oil_bbl: 500, water_bbl: 400 });
  }
  const h = analyzeWaterflood(rows, { bo: 1, bw: 1 }).hall_plots[0];

  it('the windows are the first and last thirds with exact lines on a straight segment', () => {
    const { baseline, recent } = h.windows;
    expect([baseline.lo, baseline.hi, recent.lo, recent.hi]).toEqual([0, 10, 20, 30]);
    expect(baseline.slope).toBeCloseTo(2, 12);
    expect(recent.slope).toBeCloseTo(3, 12);
    expect(baseline.slope).toBeCloseTo(h.slope_baseline, 12);
    expect(recent.slope).toBeCloseTo(h.slope_last, 12);
    // the fitted line passes through every point of its window
    for (let i = recent.lo; i < recent.hi; i += 1) {
      expect(recent.intercept + recent.slope * h.cum_injection[i]).toBeCloseTo(h.hall_integral[i], 6);
    }
    expect(recent.se_slope).toBeCloseTo(0, 9);
    expect(recent.r2).toBeCloseTo(1, 12);
    expect(h.dates).toHaveLength(30);
  });

  it('a noisy window has a 95 percent interval that holds its slope (negative control: no noise, no width)', () => {
    const xs = []; const ys = [];
    for (let i = 0; i < 12; i += 1) { xs.push(i); ys.push(5 + 2 * i + (i % 2 ? 0.5 : -0.5)); }
    const l = olsLine(xs, ys, 0, 12);
    expect(l.ci95[0]).toBeLessThan(l.slope);
    expect(l.ci95[1]).toBeGreaterThan(l.slope);
    expect(l.ci95[1] - l.ci95[0]).toBeCloseTo(2 * t95(10) * l.se_slope, 12);
    expect(t95(10)).toBe(2.228);
    const exact = olsLine(xs, xs.map((x) => 5 + 2 * x), 0, 12);
    expect(exact.ci95[1] - exact.ci95[0]).toBeCloseTo(0, 9);
  });
});

describe('5. house copy', () => {
  it('Chan labels carry no em dash', () => {
    for (const s of [null, -0.2, 0.2, 0.8]) expect(classifyChan(s).label).not.toMatch(/—/);
  });
});
