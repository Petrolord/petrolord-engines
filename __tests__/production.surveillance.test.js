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
    expect(p2.map((e) => e.type)).toEqual(['shut_in']);
    expect(p2[0].severity).toBe('high');
  });

  test('a stale well is reported stale and NOT compared against empty windows', () => {
    const p4 = got.exceptions.filter((e) => e.wellId === 'w-p4');
    expect(p4.map((e) => e.type)).toEqual(['stale_data']);
    expect(p4[0].value).toBe(20);
  });

  test('a well can carry more than one exception, and does', () => {
    const p5 = got.exceptions.filter((e) => e.wellId === 'w-p5').map((e) => e.type).sort();
    expect(p5).toEqual(['downtime', 'rate_drop']);
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
    expect(detectExceptions([])).toEqual({ asOf: null, exceptions: [] });
    expect(detectExceptions([{ well: G.wells['w-p1'], points: [] }]))
      .toEqual({ asOf: null, exceptions: [] });
  });
});

describe('THE RATIO SEAM: the module disagrees with itself about what a period ratio is', () => {
  const got = detectExceptions(SERIES);
  const seam = G.ratioSeam;

  test('detectExceptions reads a period ratio as the MEAN OF THE DAILY RATIOS', () => {
    const wc = got.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'watercut_rise');
    const gor = got.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'gor_rise');
    expect(rel(wc.value, seam.watercut.recentMeanOfRatios)).toBeLessThan(1e-12);
    expect(rel(wc.baseline, seam.watercut.baselineMeanOfRatios)).toBeLessThan(1e-12);
    expect(rel(gor.value, seam.gor.recentMeanOfRatios)).toBeLessThan(1e-12);
    expect(rel(gor.baseline, seam.gor.baselineMeanOfRatios)).toBeLessThan(1e-12);
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
    // The engine ships the mean-of-ratios reading, and that is what is
    // gated here. Recording the gap is the finding; changing it would
    // move a displayed number and belongs to an owner decision.
    const got2 = detectExceptions(SERIES);
    expect(got2.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'gor_rise').severity)
      .toBe(seam.gor.severityByMeanOfRatios);
    expect(got2.exceptions.find((e) => e.wellId === 'w-p1' && e.type === 'watercut_rise').severity)
      .toBe(seam.watercut.severityByMeanOfRatios);
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
