/**
 * Production surveillance gates.
 *
 * The oracle (tools/validation/production/oracle_surveillance.py)
 * reaches every number by a different road: calendar dates where the
 * engine counts epoch days, every window taken as the CLOSED interval
 * the method states rather than the inequality the engine implements,
 * effective decline measured as 1 - q(365)/q(0) through the rate law
 * where the engine evaluates a closed form, and the decline fit gated
 * against a series synthesised from KNOWN parameters rather than
 * against a second fitter.
 *
 * ONE PLACE THE MODULE DISAGREES WITH ITSELF, AND IT IS A REAL RESULT.
 * `detectExceptions` reads a period water cut and GOR as the MEAN OF
 * THE DAILY RATIOS; `computeKpis` reads them VOLUMETRICALLY. On the
 * golden well the two differ by 19 per cent on GOR and 2.3 points on
 * water cut, and both differences are enough to change the SEVERITY the
 * exception is reported at. Gated below as it behaves, with the gap
 * measured, because correcting it would move a number a shipped studio
 * prints.
 */
import fs from 'fs';
import path from 'path';
import {
  derivePoint, buildWellSeries, buildFieldSeries, seriesCadenceDays,
  movingAverage, decimate, detectExceptions, summarizeDeferments,
  computeKpis, rateSeriesForFit, annualEffectiveDecline, fitWellDecline,
  DEFAULT_SURVEILLANCE_SETTINGS, EXCEPTION_TYPES, FIT_STREAMS,
  classifyWellType, INJECTOR_WELL_TYPES,
  EXCEPTION_POPULATION_FILTER, KPI_POPULATION_FILTER,
} from '../engines/production/surveillance';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'surveillance_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

/** The golden ledger with its well objects attached, which is the shape
 *  the series builder reads. */
const ROWS = G.ledger.map((r) => ({ ...r, well: G.wells[r.well_id] }));
const SERIES = buildWellSeries(ROWS);
const FIELD = buildFieldSeries(ROWS);
const pointsOf = (id) => SERIES.find((s) => s.well.id === id).points;

// ---------------------------------------------------------------------------

describe('the producing-day view of a ledger row', () => {
  test('derives water cut, gas-oil ratio and liquid in the ledger units', () => {
    G.derivePoint.rows.forEach((row, i) => {
      const p = derivePoint(row);
      const g = G.derivePoint.points[i];
      expect(p.date).toBe(g.date);
      expect(p.liquid).toBeCloseTo(g.liquid, 9);
      ['watercut', 'gor', 'oilPd', 'waterPd', 'gasPd', 'liquidPd'].forEach((k) => {
        if (g[k] === null) expect(p[k]).toBeNull();
        else expect(rel(p[k], g[k])).toBeLessThan(1e-12);
      });
    });
  });

  test('ZERO HOURS IS SHUT IN: the producing-day rate is null, never Infinity', () => {
    const p = derivePoint({ prod_date: '2025-01-03', oil_stb: 0, hours_on: 0 });
    expect(p.oilPd).toBeNull();
    expect(p.liquidPd).toBeNull();
    // and a non-zero volume on zero hours is still refused rather than
    // turned into an infinite rate
    const bad = derivePoint({ prod_date: '2025-01-03', oil_stb: 400, hours_on: 0 });
    expect(bad.oilPd).toBeNull();
  });

  test('hours never recorded means uptime unknown, so the calendar volume stands', () => {
    const p = derivePoint({ prod_date: '2025-01-04', oil_stb: 450 });
    expect(p.hoursOn).toBeNull();
    expect(p.oilPd).toBe(450);
  });

  test('a half day doubles the rate but leaves the ratios alone', () => {
    const full = derivePoint({ prod_date: '2025-01-01', oil_stb: 500, water_stb: 100, gas_mscf: 250, hours_on: 24 });
    const half = derivePoint({ prod_date: '2025-01-02', oil_stb: 250, water_stb: 50, gas_mscf: 125, hours_on: 12 });
    expect(half.oilPd).toBeCloseTo(full.oilPd, 12);
    expect(half.watercut).toBeCloseTo(full.watercut, 12);
    expect(half.gor).toBeCloseTo(full.gor, 12);
  });
});

describe('the series', () => {
  test('per-well series are name-sorted and date-ascending', () => {
    expect(SERIES.map((s) => s.well.name)).toEqual(G.wellSeries.map((s) => s.name));
    SERIES.forEach((s, i) => {
      expect(s.points).toHaveLength(G.wellSeries[i].n);
      const dates = s.points.map((p) => p.date);
      expect([...dates].sort()).toEqual(dates);
    });
  });

  test('the field series matches the oracle row for row', () => {
    expect(FIELD).toHaveLength(G.fieldSeries.length);
    FIELD.forEach((f, i) => {
      const g = G.fieldSeries[i];
      expect(f.date).toBe(g.date);
      ['oil', 'water', 'gas', 'winj', 'ginj', 'liquid'].forEach((k) => {
        expect(rel(f[k] || 1, g[k] || 1)).toBeLessThan(1e-12);
      });
      expect(f.wellsOn).toBe(g.wellsOn);
      if (g.watercut === null) expect(f.watercut).toBeNull();
      else expect(rel(f.watercut, g.watercut)).toBeLessThan(1e-12);
    });
  });

  test('the cadence is the median gap, so a monthly ledger is recognised as monthly', () => {
    SERIES.forEach((s, i) => {
      expect(seriesCadenceDays(s.points)).toBe(G.wellSeries[i].cadenceDays);
    });
    expect(seriesCadenceDays(pointsOf('w-p3'))).toBe(30);
    expect(seriesCadenceDays([{ date: '2025-01-01' }])).toBeNull();
  });
});

describe('the trailing moving average', () => {
  test('averages over real TIME, not over a point count', () => {
    const got = movingAverage(pointsOf('w-p1'), 'oil', 7);
    expect(got).toHaveLength(G.movingAverage.values.length);
    got.forEach((v, i) => {
      const g = G.movingAverage.values[i];
      if (g === null) expect(v).toBeNull();
      else expect(rel(v, g)).toBeLessThan(1e-12);
    });
  });

  test('skips the gaps rather than smearing across them, and passes nulls through', () => {
    const got = movingAverage(pointsOf('w-p1'), 'watercut', 14);
    got.forEach((v, i) => {
      const g = G.movingAverageWatercut.values[i];
      if (g === null) expect(v).toBeNull();
      else expect(rel(v, g)).toBeLessThan(1e-12);
    });
  });

  test('the window is closed at both ends, so a 1-day window is the point itself', () => {
    const pts = pointsOf('w-p1');
    const one = movingAverage(pts, 'oil', 1);
    one.forEach((v, i) => expect(v).toBeCloseTo(pts[i].oil, 12));
  });
});

describe('decimation for charting', () => {
  test('strides, and ALWAYS keeps the last point', () => {
    const pts = Array.from({ length: G.decimate.n }, (_, i) => i);
    const out = decimate(pts, G.decimate.maxPoints);
    expect(out).toHaveLength(G.decimate.outLength);
    expect(out.slice(0, 5)).toEqual(G.decimate.firstIndices);
    expect(out[out.length - 1]).toBe(G.decimate.lastIndex);
  });

  test('under the cap the input comes back untouched', () => {
    const pts = pointsOf('w-p1');
    expect(decimate(pts, 1500)).toBe(pts);
    expect(decimate(null, 10)).toEqual([]);
  });
});

describe('exception surveillance', () => {
  const got = detectExceptions(SERIES);

  test('anchors on the FIELD data, never the wall clock', () => {
    expect(got.asOf).toBe(G.exceptions.asOf);
    expect(got.asOf).toBe('2025-06-30');
  });

  test('raises exactly the oracle exceptions, in the same order and severity', () => {
    expect(got.exceptions).toHaveLength(G.exceptions.exceptions.length);
    got.exceptions.forEach((e, i) => {
      const g = G.exceptions.exceptions[i];
      expect(e.wellName).toBe(g.wellName);
      expect(e.type).toBe(g.type);
      expect(e.severity).toBe(g.severity);
      expect(rel(e.value || 1, g.value || 1)).toBeLessThan(1e-12);
      expect(rel(e.baseline || 1, g.baseline || 1)).toBeLessThan(1e-12);
      expect(EXCEPTION_TYPES[e.type]).toBeDefined();
    });
  });

  test('an observation well is never surveilled, because it has no rates of its own', () => {
    expect(SERIES.some((s) => s.well.id === 'w-o1')).toBe(true);
    expect(got.exceptions.some((e) => e.wellId === 'w-o1')).toBe(false);
  });

  test('an injector is judged on injection, and only on injection', () => {
    const inj = got.exceptions.filter((e) => e.wellId === 'w-i1');
    expect(inj.map((e) => e.type)).toEqual(['injection_drop']);
  });

  test('a stopped well is SHUT IN, not a hundred per cent rate drop', () => {
    const p2 = got.exceptions.filter((e) => e.wellId === 'w-p2');
    // shut in AND down, which is the same well said twice on purpose:
    // the well stopped, and the hours say so too. Item 79 dropped the
    // clause that used to suppress the second one at exactly zero hours.
    expect(p2.map((e) => e.type).sort()).toEqual(['downtime', 'shut_in']);
    expect(p2[0].severity).toBe('high');
  });

  test('a stale well is reported stale and NOT compared against empty windows', () => {
    const p4 = got.exceptions.filter((e) => e.wellId === 'w-p4');
    expect(p4.map((e) => e.type)).toEqual(['stale_data']);
    expect(p4[0].value).toBe(20);
  });

  test('a well can carry more than one exception, and does', () => {
    const p2 = got.exceptions.filter((e) => e.wellId === 'w-p2').map((e) => e.type).sort();
    expect(p2).toEqual(['downtime', 'shut_in']);
  });

  // Item 73, on the golden field. P-5 runs 8 hours a day against a
  // baseline of 24, so its CALENDAR volume fell 67 percent while its
  // producing day rate did not move at all: 300 stb/d against 300. The
  // old detector read the calendar column and reported a HIGH severity
  // rate drop on a well whose rate was unchanged. What is true about
  // P-5 is that it is down on hours, and the downtime exception says
  // exactly that.
  test('a well cut back on hours is reported as downtime, not as a rate drop', () => {
    const p5 = got.exceptions.filter((e) => e.wellId === 'w-p5').map((e) => e.type).sort();
    expect(p5).toEqual(['downtime']);
    const points = pointsOf('w-p5');
    const recent = points.slice(-7);
    // the two bases, on the same rows: calendar down by two thirds,
    // producing day rate flat
    const calendarMean = recent.reduce((a, p) => a + p.oil, 0) / recent.length;
    const pdMean = recent.reduce((a, p) => a + p.oilPd, 0) / recent.length;
    expect(calendarMean).toBeCloseTo(100, 6);
    expect(pdMean).toBeCloseTo(300, 6);
  });

  test('A MONTHLY LEDGER WIDENS ITS WINDOWS instead of comparing single months', () => {
    // P-3's cadence is 30 days, so the recent window becomes 45 days and
    // the baseline 120. Without the widening the recent window would
    // hold one point and the baseline none, and the well would fall
    // silently out of surveillance.
    const p3 = got.exceptions.filter((e) => e.wellId === 'w-p3');
    expect(p3.map((e) => e.type)).toEqual(['rate_drop']);
    expect(p3[0].baseline).toBeCloseTo(15000, 9);
    expect(p3[0].value).toBeCloseTo(12000, 9);
    // and it is not reported stale, even though its last point is a
    // month old by daily standards
    expect(got.exceptions.some((e) => e.wellId === 'w-p3' && e.type === 'stale_data')).toBe(false);
  });

  test('the triggers are the stated settings, and raising one silences the exception', () => {
    expect(DEFAULT_SURVEILLANCE_SETTINGS.rateDropPct).toBe(20);
    const strict = detectExceptions(SERIES, { rateDropPct: 40 });
    expect(strict.exceptions.map((e) => `${e.wellName}:${e.type}`))
      .toEqual(G.exceptionsStrictDrop.exceptions.map((e) => `${e.wellName}:${e.type}`));
    // P-1 fell 38 per cent: flagged at a 20 per cent trigger, silent at 40.
    expect(got.exceptions.some((e) => e.wellId === 'w-p1' && e.type === 'rate_drop')).toBe(true);
    expect(strict.exceptions.some((e) => e.wellId === 'w-p1' && e.type === 'rate_drop')).toBe(false);
  });

  test('an empty field is an empty answer, not a crash', () => {
    // The population and its filter are returned even when the
    // population is empty, so a reader is never left guessing which
    // wells produced a count of zero (owner item 77).
    const empty = detectExceptions([]);
    expect(empty.asOf).toBeNull();
    expect(empty.exceptions).toEqual([]);
    expect(empty.population).toEqual([]);
    expect(empty.dataExceptions).toEqual([]);
    const noPoints = detectExceptions([{ well: G.wells['w-p1'], points: [] }]);
    expect(noPoints.asOf).toBeNull();
    expect(noPoints.exceptions).toEqual([]);
    expect(noPoints.population).toEqual([]);
  });
});

describe('THE RATIO SEAM: the module disagrees with itself about what a period ratio is', () => {
  const got = detectExceptions(SERIES);
  const seam = G.ratioSeam;

  // Item 18. Both halves read a period ratio the same way now: total
  // over total. The seam block stays in the golden because the gap it
  // measures is the reason the change was made.
  test('detectExceptions reads a period ratio VOLUMETRICALLY, as computeKpis does', () => {
    const wc = got.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'watercut_rise');
    const gor = got.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'gor_rise');
    expect(rel(wc.value, seam.watercut.recentVolumetric)).toBeLessThan(1e-12);
    expect(rel(wc.baseline, seam.watercut.baselineVolumetric)).toBeLessThan(1e-12);
    expect(rel(gor.value, seam.gor.recentVolumetric)).toBeLessThan(1e-12);
    expect(rel(gor.baseline, seam.gor.baselineVolumetric)).toBeLessThan(1e-12);
    // and not the mean of the daily ratios, which is the quantity it
    // used to report
    expect(rel(wc.value, seam.watercut.recentMeanOfRatios)).toBeGreaterThan(1e-3);
    expect(rel(gor.value, seam.gor.recentMeanOfRatios)).toBeGreaterThan(1e-3);
  });

  test('computeKpis reads the SAME KIND OF RATIO volumetrically', () => {
    const k = computeKpis(SERIES, FIELD, { windowDays: 7 });
    expect(rel(k.watercut, k.water / (k.oil + k.water))).toBeLessThan(1e-12);
    expect(rel(k.gor, (k.gas * 1000) / k.oil)).toBeLessThan(1e-12);
  });

  test('and on this well the gap is large: 19 per cent on GOR, 2.3 points on water cut', () => {
    expect(seam.gor.overstatementPct).toBeGreaterThan(19);
    expect(seam.gor.recentMeanOfRatios).toBeCloseTo(1360.2678571428573, 6);
    expect(seam.gor.recentVolumetric).toBeCloseTo(1141.9023136246788, 6);
    expect(seam.watercut.recentMeanOfRatios - seam.watercut.recentVolumetric)
      .toBeCloseTo(0.0233519742, 8);
  });

  test('BIG ENOUGH TO CHANGE THE SEVERITY A STUDIO PRINTS, on both ratios', () => {
    expect(seam.gor.severityByMeanOfRatios).toBe('high');
    expect(seam.gor.severityByVolumetric).toBe('medium');
    expect(seam.watercut.severityByMeanOfRatios).toBe('high');
    expect(seam.watercut.severityByVolumetric).toBe('medium');
    // The engine ships the VOLUMETRIC reading since item 18, so the
    // studio prints MEDIUM on both where it used to print HIGH.
    const got2 = detectExceptions(SERIES);
    expect(got2.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'gor_rise').severity)
      .toBe(seam.gor.severityByVolumetric);
    expect(got2.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'watercut_rise').severity)
      .toBe(seam.watercut.severityByVolumetric);
    expect(got2.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'gor_rise').severity)
      .toBe('medium');
  });

  test('the cause is one near shut-in day whose own ratios are enormous', () => {
    const p1 = pointsOf('w-p1');
    const odd = p1.find((p) => p.date === '2025-06-27');
    expect(odd.oil).toBe(50);
    expect(odd.gor).toBeCloseTo(2800, 9);
    // It carries 1/78 of the window's oil and 1/7 of the mean of ratios.
    expect(odd.gor / seam.gor.recentMeanOfRatios).toBeGreaterThan(2);
  });
});

describe('deferments', () => {
  const got = summarizeDeferments(G.deferments.events, G.deferments.asOf);
  const g = G.deferments.summary;

  test('roll up per category, worst by oil first', () => {
    expect(got.byCategory.map((c) => c.category)).toEqual(g.byCategory.map((c) => c.category));
    got.byCategory.forEach((c, i) => {
      expect(c.events).toBe(g.byCategory[i].events);
      expect(c.days).toBe(g.byCategory[i].days);
      expect(rel(c.oil, g.byCategory[i].oil)).toBeLessThan(1e-12);
    });
    expect(got.totals.days).toBe(g.totals.days);
    expect(got.totals.events).toBe(g.totals.events);
  });

  test('an open event accrues to the field frontier, and is counted as open', () => {
    expect(got.openCount).toBe(g.openCount);
    expect(got.openCount).toBe(1);
  });

  test('a same-day event is ONE day, not zero', () => {
    const one = summarizeDeferments(
      [{ category: 'X', start_date: '2025-06-15', end_date: '2025-06-15' }], '2025-06-30',
    );
    expect(one.byCategory[0].days).toBe(1);
  });
});

describe('field KPIs', () => {
  test('match the oracle over both windows', () => {
    [[7, 'kpis'], [30, 'kpis30']].forEach(([w, key]) => {
      const k = computeKpis(SERIES, FIELD, { windowDays: w });
      const g = G[key];
      expect(k.asOf).toBe(g.asOf);
      ['oil', 'water', 'gas', 'winj', 'liquid', 'watercut', 'gor', 'uptimePct'].forEach((f) => {
        expect(rel(k[f], g[f])).toBeLessThan(1e-12);
      });
      expect(k.wellCount).toBe(g.wellCount);
      expect(k.producerCount).toBe(g.producerCount);
    });
  });

  test('uptime is over the wells that REPORTED hours, and injectors are out of it', () => {
    const k = computeKpis(SERIES, FIELD, { windowDays: 7 });
    // Of the producers in the last seven days, P-1/P-2/P-5 report hours
    // (24, 0, 8) and P-3/O-1 report none. The injector is excluded even
    // though it reports 24.
    expect(k.uptimePct).toBeCloseTo(G.kpis.uptimePct, 9);
    expect(k.uptimePct).toBeLessThan(100);
  });

  test('an observation well is counted as a producer here, and is NOT in the exceptions', () => {
    // A recorded inconsistency rather than an assertion of correctness:
    // computeKpis splits on "not an injector" while detectExceptions
    // splits on "not an observation well". Gated as it behaves.
    const k = computeKpis(SERIES, FIELD, { windowDays: 7 });
    expect(k.wellCount).toBe(7);
    expect(k.producerCount).toBe(6);
    expect(SERIES.filter((s) => s.well.well_type === 'producer')).toHaveLength(5);
  });

  test('no field series is null, not a page of NaN', () => {
    expect(computeKpis(SERIES, [])).toBeNull();
    expect(computeKpis(SERIES, null)).toBeNull();
  });
});

describe('effective decline', () => {
  test('is what 1 - q(365)/q(0) gives, for every Arps family', () => {
    G.effectiveDecline.forEach((c) => {
      const got = annualEffectiveDecline(c.Di, c.b, c.modelType);
      expect(rel(got, c.effectivePct)).toBeLessThan(1e-12);
    });
  });

  test('exponential and harmonic really are the b -> 0 and b = 1 limits', () => {
    const b0 = annualEffectiveDecline(0.0015, 1e-9, 'Hyperbolic');
    expect(rel(b0, annualEffectiveDecline(0.0015, 0, 'Exponential'))).toBeLessThan(1e-6);
    const b1 = annualEffectiveDecline(0.0015, 1 - 1e-9, 'Hyperbolic');
    expect(rel(b1, annualEffectiveDecline(0.0015, 1, 'Harmonic'))).toBeLessThan(1e-6);
  });

  test('a non-declining or unusable Di is null, not a negative decline', () => {
    expect(annualEffectiveDecline(0, 0.5, 'Hyperbolic')).toBeNull();
    expect(annualEffectiveDecline(-0.001, 0.5, 'Hyperbolic')).toBeNull();
    expect(annualEffectiveDecline(NaN, 0.5, 'Hyperbolic')).toBeNull();
  });
});

describe('the decline overlay through the canonical Arps engine', () => {
  const rows = G.syntheticDecline.rows.map((r) => ({ ...r, well: { id: 'w-dec', name: 'DEC-1' } }));
  const points = buildWellSeries(rows)[0].points;

  test('the fit recovers the parameters the data was MADE from', () => {
    const out = fitWellDecline(points, { stream: 'oil', basis: 'producing' });
    expect(out.insufficient).toBeUndefined();
    expect(rel(out.fit.parameters.qi, G.syntheticDecline.truth.qi)).toBeLessThan(1e-6);
    expect(rel(out.fit.parameters.Di, G.syntheticDecline.truth.Di)).toBeLessThan(1e-6);
    expect(out.fit.R2).toBeGreaterThan(0.999999);
  });

  test('and its effective decline is the one the truth implies', () => {
    const out = fitWellDecline(points, { stream: 'oil' });
    const eff = annualEffectiveDecline(
      out.fit.parameters.Di, out.fit.parameters.b, out.fit.parameters.modelType,
    );
    expect(rel(eff, G.syntheticDecline.effectivePct)).toBeLessThan(1e-4);
  });

  test('the forecast continues the SAME law, day by day, from the fit', () => {
    const out = fitWellDecline(points, { stream: 'oil', forecastDays: 365 });
    expect(out.forecast.rates).toHaveLength(365);
    const { qi, Di } = out.fit.parameters;
    // Day 1 of the forecast is q(1) of the law that was fitted, and the
    // truth the data was made from says what that is.
    const truth = G.syntheticDecline.truth;
    expect(rel(out.forecast.rates[0].rate, truth.qi * Math.exp(-truth.Di * 1)))
      .toBeLessThan(1e-5);
    expect(rel(out.forecast.rates[364].rate, qi * Math.exp(-Di * 365))).toBeLessThan(1e-9);
  });

  test('an economic limit STOPS the forecast rather than running past it', () => {
    const truth = G.syntheticDecline.truth;
    // q(t) = 1200 exp(-0.0015 t) falls to 900 at t = ln(4/3)/0.0015 = 192 days.
    const limited = fitWellDecline(points, { stream: 'oil', forecastDays: 1825, economicLimit: 900 });
    const open = fitWellDecline(points, { stream: 'oil', forecastDays: 1825 });
    const expectedDay = Math.log(truth.qi / 900) / truth.Di;
    expect(limited.forecast.timeToLimit).toBeGreaterThan(expectedDay - 2);
    expect(limited.forecast.timeToLimit).toBeLessThan(expectedDay + 2);
    expect(limited.forecast.rates.length).toBeLessThan(open.forecast.rates.length);
    expect(limited.forecast.rates.every((r) => r.rate >= 900)).toBe(true);
  });

  test('UNDER THREE USABLE POINTS IS A REFUSAL, never a fake fit', () => {
    expect(fitWellDecline(points.slice(0, 2)).insufficient).toBe(true);
    expect(fitWellDecline([]).insufficient).toBe(true);
    expect(fitWellDecline(null).insufficient).toBe(true);
  });

  test('the fit series drops shut-in and zero days, because the fit is log-space', () => {
    const p2 = pointsOf('w-p2'); // shut in for the last seven days
    const producing = rateSeriesForFit(p2, 'oil', 'producing');
    const calendar = rateSeriesForFit(p2, 'oil', 'calendar');
    expect(producing.every((x) => x.rate > 0)).toBe(true);
    expect(calendar.every((x) => x.rate > 0)).toBe(true);
    expect(producing.length).toBe(40);
    expect(FIT_STREAMS.oil.key).toBe('oilPd');
    expect(FIT_STREAMS.gas.unit).toBe('Mscf/d');
  });
});

// ---------------------------------------------------------------------------
// Owner decisions of 4 September 2026, Wave 1. Every test below fails on the
// engine as it stood and none of them moves a golden number.
// ---------------------------------------------------------------------------

describe('74. a broken decline exponent is refused, not read as exponential', () => {
  // At Di = 0.0015 per day the exponential answer is 42.160601062199, which
  // is case 1 of the published golden. The old guard was `!b`, and `!NaN` is
  // true, so a hyperbolic fit with an unreadable b handed back that number.
  const EXPONENTIAL_ANSWER = G.effectiveDecline
    .find((c) => c.modelType === 'Exponential' && c.Di === 0.0015).effectivePct;

  test.each([[NaN], [null], [undefined]])(
    'a hyperbolic call with b = %p refuses instead of returning the exponential answer',
    (b) => {
      const got = annualEffectiveDecline(0.0015, b, 'Hyperbolic');
      expect(got.ok).toBe(false);
      expect(got.code).toBe('invalidDeclineExponent');
      expect(got).not.toBe(EXPONENTIAL_ANSWER);
      expect(typeof got).not.toBe('number');
    },
  );

  test('a negative b is refused rather than raised to a power', () => {
    // -0.3 used to raise a negative bracket to a power and return 31.9375.
    const got = annualEffectiveDecline(0.0015, -0.3, 'Hyperbolic');
    expect(got.ok).toBe(false);
    expect(got.code).toBe('invalidDeclineExponent');
    expect(got.error).toMatch(/finite b greater than zero/);
  });

  test('and the published families are unmoved: the family is chosen by modelType', () => {
    G.effectiveDecline.forEach((c) => {
      expect(rel(annualEffectiveDecline(c.Di, c.b, c.modelType), c.effectivePct))
        .toBeLessThan(1e-12);
    });
    // Exponential and harmonic never look at b at all now.
    expect(annualEffectiveDecline(0.0015, NaN, 'Exponential'))
      .toBeCloseTo(EXPONENTIAL_ANSWER, 12);
    expect(annualEffectiveDecline(0.0015, NaN, 'Harmonic'))
      .toBeCloseTo(annualEffectiveDecline(0.0015, 1, 'Harmonic'), 12);
  });
});

describe('75. decimate respects the cap its own argument names', () => {
  const run = (n, cap) => decimate(Array.from({ length: n }, (_, i) => i), cap);

  test('3000 points against a cap of 1500 returns 1500 or fewer, not 1501', () => {
    const out = run(3000, 1500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out[out.length - 1]).toBe(2999);
  });

  test('the cap holds across the sizes that used to overflow it by one', () => {
    [[1501, 750], [3000, 1500], [2999, 1499], [101, 50], [1000, 999]].forEach(([n, cap]) => {
      const out = run(n, cap);
      expect(out.length).toBeLessThanOrEqual(cap);
      expect(out[0]).toBe(0);
      expect(out[out.length - 1]).toBe(n - 1);
    });
  });

  test('a cap that is not a finite number is refused, not silently ignored', () => {
    const got = decimate([1, 2, 3], NaN);
    expect(got.ok).toBe(false);
    expect(got.code).toBe('invalidMaxPoints');
    expect(decimate([1, 2, 3], 0).code).toBe('invalidMaxPoints');
  });

  test('and the published decimation is unmoved', () => {
    const pts = Array.from({ length: G.decimate.n }, (_, i) => i);
    const out = decimate(pts, G.decimate.maxPoints);
    expect(out).toHaveLength(G.decimate.outLength);
    expect(out.slice(0, 5)).toEqual(G.decimate.firstIndices);
  });
});

describe('76. the deferment roll-up cannot read the wall clock', () => {
  const EVENTS = [{ category: 'X', start_date: '2025-06-01', oil_deferred_stb: 10 }];

  test('no asOf is a refusal, because an open event has no end date', () => {
    const got = summarizeDeferments(EVENTS);
    expect(got.ok).toBe(false);
    expect(got.code).toBe('missingAsOf');
    expect(got.error).toMatch(/asOf/);
    expect(got.byCategory).toBeUndefined();
    expect(summarizeDeferments(EVENTS, null).code).toBe('missingAsOf');
    expect(summarizeDeferments(EVENTS, '').code).toBe('missingAsOf');
  });

  test('an unreadable asOf is refused rather than turned into NaN days', () => {
    const got = summarizeDeferments(EVENTS, 'last Tuesday');
    expect(got.ok).toBe(false);
    expect(got.code).toBe('unreadableAsOf');
    expect(got.error).toMatch(/last Tuesday/);
  });

  test('the anchor comes back in the result, so the reader sees what open meant', () => {
    const got = summarizeDeferments(G.deferments.events, G.deferments.asOf);
    expect(got.asOf).toBe(G.deferments.asOf);
    expect(got.ok).toBeUndefined();
    // and the published roll-up is unmoved
    expect(got.totals.days).toBe(G.deferments.summary.totals.days);
    expect(got.openCount).toBe(G.deferments.summary.openCount);
  });
});

describe('77. two counts of the same field, and each one now names its seven', () => {
  const ex = detectExceptions(SERIES);
  const kpi = computeKpis(SERIES, FIELD, { windowDays: 7 });

  test('detectExceptions returns the wells it surveilled, and names its filter', () => {
    expect(ex.population).toEqual(expect.arrayContaining(['w-p1', 'w-i1']));
    expect(ex.population).not.toContain('w-o1');
    expect(ex.populationFilter).toBe(EXCEPTION_POPULATION_FILTER);
    expect(ex.populationFilter).toMatch(/Observation wells are excluded/);
  });

  test('computeKpis returns the wells it counted, and names its filter', () => {
    expect(kpi.population).toHaveLength(kpi.producerCount);
    expect(kpi.population).toContain('w-o1');
    expect(kpi.population).not.toContain('w-i1');
    expect(kpi.populationFilter).toBe(KPI_POPULATION_FILTER);
    expect(kpi.populationFilter).toMatch(/Injectors are excluded/);
  });

  test('THE SAME SIZE, A DIFFERENT SET: one keeps the injector, the other the observer', () => {
    expect(ex.population).toHaveLength(kpi.population.length);
    expect([...ex.population].sort()).not.toEqual([...kpi.population].sort());
    const onlyInExceptions = ex.population.filter((id) => !kpi.population.includes(id));
    const onlyInKpis = kpi.population.filter((id) => !ex.population.includes(id));
    expect(onlyInExceptions).toEqual(['w-i1']);
    expect(onlyInKpis).toEqual(['w-o1']);
    // the published counts are unmoved
    expect(kpi.producerCount).toBe(G.kpis.producerCount);
    expect(kpi.wellCount).toBe(G.kpis.wellCount);
  });
});

describe('78. stb/d after a mean of calendar volumes', () => {
  const ex = detectExceptions(SERIES);
  const message = (wellId, type) => ex.exceptions.find(
    (e) => e.wellId === wellId && e.type === type,
  ).message;

  test('the drop message quotes a PRODUCING DAY rate and says so', () => {
    // Since item 73 the TRIGGER is the producing day rate too, so P-5,
    // whose rate never moved, no longer raises this at all and the
    // message is read off a well that really did weaken.
    expect(ex.exceptions.some((e) => e.wellId === 'w-p5' && e.type === 'rate_drop')).toBe(false);
    const m = message('w-p1', 'rate_drop');
    expect(m).toMatch(/on producing day rates/);
    expect(m).toBe('Oil down 38% on producing day rates: 556 stb/d against a 900 stb/d baseline.');
  });

  test('the calendar basis is quoted only where the two bases disagree', () => {
    // P-1 ran full hours, so the two readings are the same number and
    // saying it twice would read as two findings
    expect(message('w-p1', 'rate_drop')).not.toMatch(/Calendar volumes fell/);
    // a well on half hours whose rate ALSO fell gets both bases, and the
    // sentence says which part is which. Built here rather than mutated
    // out of the golden field so the two windows are unambiguous: 30
    // days at 1,000 stb on 24 hours, then 7 days at 400 stb on 12 hours,
    // which is a 20 percent fall in rate and a 60 percent fall in volume.
    const day = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push({
        well_id: 'w-x', well: { id: 'w-x', name: 'X-1', well_type: 'producer' },
        prod_date: day(i), oil_stb: 1000, water_stb: 100, gas_mscf: 500,
        winj_stb: 0, ginj_mscf: 0, hours_on: 24,
      });
    }
    for (let i = 30; i < 37; i += 1) {
      rows.push({
        well_id: 'w-x', well: { id: 'w-x', name: 'X-1', well_type: 'producer' },
        prod_date: day(i), oil_stb: 400, water_stb: 40, gas_mscf: 200,
        winj_stb: 0, ginj_mscf: 0, hours_on: 12,
      });
    }
    const both = detectExceptions(buildWellSeries(rows)).exceptions.find(
      (e) => e.wellId === 'w-x' && e.type === 'rate_drop',
    );
    expect(both).toBeDefined();
    expect(both.message).toMatch(/down 20% on producing day rates/);
    expect(both.message).toMatch(/Calendar volumes fell 60%/);
    expect(both.message).toMatch(/part of this is hours and part is rate/);
  });

  test('an injector quotes its producing day injection rate too', () => {
    const m = message('w-i1', 'injection_drop');
    expect(m).toMatch(/producing day rate/);
    expect(m).toMatch(/stb\/d/);
  });

  test('the shut-in message quotes the baseline producing day rate', () => {
    const m = message('w-p2', 'shut_in');
    expect(m).toBe('Production stopped. Baseline producing day rate 400 stb/d of oil.');
  });

  test('no engine message carries a double hyphen or a dash character', () => {
    ex.exceptions.forEach((e) => {
      expect(e.message).not.toMatch(/--|–|—/);
    });
  });

  test('AND THE TRIGGER ITSELF IS UNTOUCHED: value and baseline stay calendar means', () => {
    ex.exceptions.forEach((e, i) => {
      const g = G.exceptions.exceptions[i];
      expect(rel(e.value || 1, g.value || 1)).toBeLessThan(1e-12);
      expect(rel(e.baseline || 1, g.baseline || 1)).toBeLessThan(1e-12);
    });
  });
});

describe('79. volumes recorded against no well on stream', () => {
  const P = { id: 'w1', name: 'P-1', well_type: 'producer' };
  const rows = [
    { well: P, well_id: 'w1', prod_date: '2025-03-01', oil_stb: 500, water_stb: 0, gas_mscf: 0, hours_on: 0 },
  ];
  const series = buildWellSeries(rows);
  const field = buildFieldSeries(rows);

  test('the field row reports NO per-well rate rather than dividing by zero', () => {
    expect(field[0].wellsOn).toBe(0);
    expect(field[0].oil).toBe(500);
    expect(field[0].oilPerWell).toBeNull();
    expect(Number.isFinite(field[0].oilPerWell)).toBe(false);
  });

  test('and the KPIs raise volumesWithoutHours instead of an infinite rate', () => {
    const k = computeKpis(series, field, { windowDays: 1 });
    expect(k.oilPerWell).toBeNull();
    expect(k.dataExceptions.map((d) => d.code)).toContain('volumesWithoutHours');
    expect(k.dataExceptions.find((d) => d.code === 'volumesWithoutHours').message)
      .toMatch(/no well counted on stream/);
  });

  test('a clean field reports the per-well rate and no data exception', () => {
    const k = computeKpis(SERIES, FIELD, { windowDays: 7 });
    expect(k.dataExceptions).toEqual([]);
    expect(k.oilPerWell).toBeCloseTo(k.oil / k.wellsOn, 12);
    expect(k.oilPerWell).toBeGreaterThan(0);
  });
});

describe('80. only the exact string injector is an injector', () => {
  test('the type is normalised once, at the door', () => {
    expect(INJECTOR_WELL_TYPES).toEqual(
      ['injector', 'water_injector', 'gas_injector', 'wag_injector'],
    );
    INJECTOR_WELL_TYPES.forEach((t) => {
      expect(classifyWellType(t).role).toBe('injector');
      expect(classifyWellType(`  ${t.toUpperCase()}  `).role).toBe('injector');
    });
    expect(classifyWellType(' Producer ').role).toBe('producer');
    expect(classifyWellType('OBSERVATION').role).toBe('observation');
  });

  test('an unknown or absent type is NOT a producer', () => {
    ['other', 'water source', 'disposal', ''].forEach((t) => {
      expect(classifyWellType(t).role).toBeNull();
    });
    expect(classifyWellType(undefined).role).toBeNull();
    expect(classifyWellType(null).role).toBeNull();
    expect(classifyWellType(7).role).toBeNull();
  });

  test('a water injector is surveilled on injection, not read as a producer', () => {
    const WI = { id: 'w-wi', name: 'WI-1', well_type: 'WATER_INJECTOR' };
    const rows = [];
    for (let d = 1; d <= 40; d += 1) {
      const date = `2025-05-${String(d).padStart(2, '0')}`;
      if (d > 31) continue;
      rows.push({
        well: WI, well_id: 'w-wi', prod_date: date,
        oil_stb: 0, water_stb: 0, gas_mscf: 0, hours_on: 24,
        winj_stb: d > 24 ? 1000 : 3000,
      });
    }
    const got = detectExceptions(buildWellSeries(rows));
    expect(got.population).toEqual(['w-wi']);
    expect(got.exceptions.map((e) => e.type)).toEqual(['injection_drop']);
    expect(got.dataExceptions).toEqual([]);
  });

  test('an unrecognised type raises a data exception rather than joining the population', () => {
    const ODD = { id: 'w-x', name: 'X-1', well_type: 'other' };
    const rows = [
      { well: ODD, well_id: 'w-x', prod_date: '2025-05-01', oil_stb: 900, hours_on: 24 },
      { well: ODD, well_id: 'w-x', prod_date: '2025-05-02', oil_stb: 100, hours_on: 24 },
    ];
    const series = buildWellSeries(rows);
    const got = detectExceptions(series);
    expect(got.population).toEqual([]);
    expect(got.exceptions).toEqual([]);
    expect(got.dataExceptions).toHaveLength(1);
    expect(got.dataExceptions[0].code).toBe('unknownWellType');
    expect(got.dataExceptions[0].wellName).toBe('X-1');
    expect(got.dataExceptions[0].value).toBe('other');
    expect(got.dataExceptions[0].message).toMatch(/not a recognised producer, injector or observation type/);

    const k = computeKpis(series, buildFieldSeries(rows), { windowDays: 7 });
    expect(k.producerCount).toBe(0);
    expect(k.population).toEqual([]);
    expect(k.dataExceptions[0].code).toBe('unknownWellType');
  });

  test('a well with no type at all is named in the data exception', () => {
    const NO = { id: 'w-n', name: 'N-1' };
    const rows = [{ well: NO, well_id: 'w-n', prod_date: '2025-05-01', oil_stb: 900, hours_on: 24 }];
    const got = detectExceptions(buildWellSeries(rows));
    expect(got.dataExceptions[0].code).toBe('unknownWellType');
    expect(got.dataExceptions[0].value).toBeNull();
    expect(got.dataExceptions[0].message).toMatch(/no well type recorded/);
  });

  test('and the published field is unmoved: its types are all recognised', () => {
    const got = detectExceptions(SERIES);
    expect(got.dataExceptions).toEqual([]);
    expect(got.exceptions).toHaveLength(G.exceptions.exceptions.length);
  });
});
