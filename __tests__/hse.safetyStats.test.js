// HSE H1 safety statistics gates. Every case in
// test-data/hse/goldens/safetyStats_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent oracle
// (tools/validation/hse/oracle_safetystats.py, scipy and mpmath) computed.
// Nothing below restates a formula to check the engine against itself: the
// behavioural tests compare engine outputs with each other or with golden
// numbers, and the negative control in
// tools/validation/hse/negcontrol_safetystats.sh proves the gate goes red
// when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as S from '../engines/hse/safetyStats';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'hse', 'goldens', 'safetyStats_cases.json'),
  'utf8',
));

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Differences between actual and expected, as readable strings. */
const diff = (actual, expected, tol, where = '') => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const ok = expected === 0 ? Math.abs(actual) <= 1e-14 : Math.abs(actual - expected) <= tol * Math.abs(expected);
    return ok ? [] : [`${where}: ${actual} vs ${expected} (rel ${Math.abs(actual - expected) / Math.abs(expected)})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    return Object.keys(expected).flatMap((k) => diff(get(actual, k), expected[k], tol, `${where}.${k}`));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

const call = (c) => (Array.isArray(c.args) ? S[c.fn](...c.args) : S[c.fn](c.args));

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('safetyStats');
    expect(G.cases.length).toBeGreaterThan(300);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden', () => {
    const fns = Object.keys(S).filter((k) => typeof S[k] === 'function');
    const used = new Set(G.cases.map((c) => c.fn));
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
  });

  test.each(G.cases.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c);
    if (c.expected && c.expected.error === true) {
      expect(typeof r.error).toBe('string');
      expect(r.field).toBe(c.expected.field);
      // refused BY NAME: the message starts with the field it refuses
      expect(r.error.startsWith(c.expected.field.replace(/\[.*$/, ''))).toBe(true);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(r, c.expected, c.tol, c.fn)).toEqual([]);
  });
});

describe('published values: the engine reproduces the printed figure', () => {
  const pub = G.cases.filter((c) => c.source === 'published');

  test('there are published anchors (BLS and IOGP)', () => {
    expect(pub.length).toBeGreaterThanOrEqual(6);
  });

  test.each(pub.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c);
    const v = get(r, c.published.field);
    expect(Number(v.toFixed(c.published.decimals))).toBe(c.published.value);
  });
});

describe('pooling: sum then divide, never the mean of the rates', () => {
  test('the IOGP five-year FAR is the pooled rate, and the mean of annual FARs is a different number', () => {
    const c = G.cases.find((x) => x.id === 'iogp-far-five-year-2020-2024');
    const r = S.pooledRate(c.args);
    expect(r.rate).toBeCloseTo(c.expected.rate, 12);
    expect(Math.abs(r.meanOfPeriodRates - r.rate) / r.rate).toBeGreaterThan(0.005);
    // a five-period rolling window over five periods IS the pooled rate
    const w = S.rollingRate({ ...c.args, windowPeriods: 5 }).windows;
    expect(w).toHaveLength(1);
    expect(w[0].rate).toBe(r.rate);
  });

  test('a month with no hours leaves the pooled rate alone and has no rate of its own', () => {
    const c = G.cases.find((x) => x.id === 'pooled-12-months');
    const r = S.pooledRate(c.args);
    expect(r.periodsWithoutHours).toBe(1);
    expect(r.periodRates[5]).toBeNull();
    const dropped = S.pooledRate({
      counts: c.args.counts.filter((_, i) => i !== 5),
      exposureHours: c.args.exposureHours.filter((_, i) => i !== 5),
      base: c.args.base,
    });
    expect(dropped.rate).toBe(r.rate);
    expect(dropped.meanOfPeriodRates).toBe(r.meanOfPeriodRates);
  });

  test('a window with no hours reports null, not zero', () => {
    const c = G.cases.find((x) => x.id === 'rolling-window-without-hours');
    const w = S.rollingRate(c.args).windows;
    expect(w[0].rate).toBeNull();
    expect(w[0].meanOfPeriodRates).toBeNull();
    expect(w[0].reason).toMatch(/no hours/);
  });
});

describe('basis travels with every result', () => {
  test.each([
    ['incidenceRate', { count: 1, exposureHours: 1000, base: 200000 }],
    ['severityRate', { daysLost: 1, exposureHours: 1000, base: 1000000 }],
    ['pseRate', { tier: 1, pseCount: 1, exposureHours: 1000, base: 200000 }],
    ['fatalAccidentRate', { fatalities: 1, exposureHours: 1e6 }],
    ['rateConfidenceInterval', { count: 1, exposureHours: 1000, base: 200000, confidence: 0.95 }],
    ['uChart', { counts: [1, 2], exposureHours: [1000, 2000], base: 200000 }],
  ])('%s', (fn, args) => {
    const r = S[fn](args);
    expect(r.basis).toBeDefined();
    expect(r.basis.base).toBe(args.base ?? 100000000);
  });

  test('the same count and hours on the two TRIR bases differ by exactly five', () => {
    const osha = S.incidenceRate({ count: 13, exposureHours: 777000, base: S.RATE_BASES.OSHA_200K });
    const iogp = S.incidenceRate({ count: 13, exposureHours: 777000, base: S.RATE_BASES.IOGP_1M });
    expect(iogp.rate / osha.rate).toBeCloseTo(5, 12);
    expect(osha.basis.baseLabel).not.toBe(iogp.basis.baseLabel);
  });
});

describe('interval and test agree with each other', () => {
  test('a zero count has lower limit 0 and the Garwood upper limit', () => {
    const r = S.rateConfidenceInterval({ count: 0, exposureHours: 1, base: 1, confidence: 0.95 });
    expect(r.lower).toBe(0);
    // chi2(0.975, 2) / 2 = -ln(0.025), the one closed form in the family
    expect(r.upper).toBeCloseTo(-Math.log(0.025), 12);
  });

  test('central p-value below alpha exactly when the ratio interval excludes 1, on every golden', () => {
    G.cases.filter((c) => c.fn === 'compareRates' && !c.expected.error).forEach((c) => {
      const r = S.compareRates(c.args);
      const alpha = 1 - c.args.confidence;
      const excludes = r.rateRatioLower > 1 || (r.rateRatioUpper !== null && r.rateRatioUpper < 1);
      expect([c.id, r.pValue < alpha]).toEqual([c.id, excludes]);
    });
  });

  test('swapping the groups inverts the ratio and keeps the p-value', () => {
    const a = S.compareRates({ count1: 10, exposureHours1: 1e5, count2: 3, exposureHours2: 1.2e5, confidence: 0.95 });
    const b = S.compareRates({ count1: 3, exposureHours1: 1.2e5, count2: 10, exposureHours2: 1e5, confidence: 0.95 });
    expect(b.pValue).toBeCloseTo(a.pValue, 12);
    expect(b.rateRatio).toBeCloseTo(1 / a.rateRatio, 12);
    expect(b.rateRatioLower).toBeCloseTo(1 / a.rateRatioUpper, 9);
  });

  test('the second group with no events leaves the ratio unbounded, stated rather than infinite', () => {
    const r = S.compareRates({ count1: 4, exposureHours1: 90000, count2: 0, exposureHours2: 150000, confidence: 0.95 });
    expect(r.rateRatio).toBeNull();
    expect(r.rateRatioUpper).toBeNull();
    expect(r.upperUnbounded).toBe(true);
    expect(r.reason).toMatch(/unbounded/);
  });
});

describe('tiny upper tails: why the upper limit is solved on the upper tail', () => {
  const tiny = G.cases.filter((c) => c.id.startsWith('chi2-isf-tiny-'));

  test('the golden carries tiny-q upper quantiles down to 1e-30', () => {
    expect(tiny.length).toBeGreaterThanOrEqual(16);
    expect(Math.min(...tiny.map((c) => c.args[0]))).toBeLessThanOrEqual(1e-30);
  });

  test('the upper-tail route stays finite and matches the oracle at every tiny q', () => {
    tiny.forEach((c) => {
      const [q, df] = c.args;
      const x = S.chiSquareQuantileUpper(q, df);
      expect([c.id, Number.isFinite(x)]).toEqual([c.id, true]);
      expect([c.id, Math.abs(x - c.expected) <= 1e-10 * c.expected]).toEqual([c.id, true]);
    });
  });

  test('the lower-tail route at p = 1 - q does not: off at 1e-16, NaN from 1e-17', () => {
    tiny.forEach((c) => {
      const [q, df] = c.args;
      const x = S.chiSquareQuantile(1 - q, df);
      if (q <= 1e-17) {
        // 1 - q rounds to exactly 1, which the lower-tail quantile refuses
        expect([c.id, 1 - q, Number.isNaN(x)]).toEqual([c.id, 1, true]);
      } else {
        // 1 - 1e-16 rounds to 1 - 1.11e-16: the digits of q are gone, and the
        // result misses the oracle by 0.1 to 0.3 percent, far outside its 1e-10 gate
        expect([c.id, Math.abs(x - c.expected) > 5e-4 * c.expected]).toEqual([c.id, true]);
      }
    });
  });

  test('the rationale is not 0.975 rounding: 1 - 0.025 is exactly 0.975 in doubles', () => {
    expect(1 - 0.025).toBe(0.975);
  });
});

describe('u-chart', () => {
  test('lower limits are floored at zero and flagged', () => {
    const c = G.cases.find((x) => x.id === 'uchart-one-high-month');
    const r = S.uChart(c.args);
    expect(r.outOfControl).toEqual([5]);
    r.points.forEach((p) => {
      expect(p.lcl).toBeGreaterThanOrEqual(0);
      expect(p.lclFloored).toBe(true);
    });
  });

  test('a point exactly on its limit does not signal (strictly outside only)', () => {
    const c = G.cases.find((x) => x.id === 'uchart-points-on-the-limits');
    const r = S.uChart(c.args);
    expect(r.points[0].u).toBe(r.points[0].ucl);
    expect(r.points[1].u).toBe(r.points[1].lcl);
    expect(r.outOfControl).toEqual([]);
  });

  test('a large exposure gives a positive lower limit and a low point signals below', () => {
    const c = G.cases.find((x) => x.id === 'uchart-positive-lcl-with-a-low-point');
    const r = S.uChart(c.args);
    expect(r.points[3].signal).toBe('below');
    expect(r.points[3].lcl).toBeGreaterThan(0);
  });
});

describe('refusals are by name, never silent defaults', () => {
  test.each([
    [{ count: 1, exposureHours: 1000 }, 'base'],
    [{ count: 1, exposureHours: 0, base: 200000 }, 'exposureHours'],
    [{ count: NaN, exposureHours: 1000, base: 200000 }, 'count'],
    [{ exposureHours: 1000, base: 200000 }, 'count'],
    [undefined, 'count'],
  ])('incidenceRate %j refuses %s', (args, field) => {
    const r = S.incidenceRate(args);
    expect(r.field).toBe(field);
    expect(r.rate).toBeUndefined();
  });

  test('pseRate without a base names only the bases it accepts', () => {
    const r = S.pseRate({ tier: 1, pseCount: 1, exposureHours: 1000 });
    expect(r.field).toBe('base');
    expect(r.error).toMatch(/^base /);
    expect(r.error).toMatch(/200,000/);
    expect(r.error).toMatch(/1,000,000/);
    expect(r.error).not.toMatch(/100,000,000|FAR/);
    // and the base it does not suggest is indeed refused
    expect(S.pseRate({ tier: 1, pseCount: 1, exposureHours: 1000, base: 1e8 }).field).toBe('base');
  });

  test('the other rates without a base still offer all three named bases', () => {
    const r = S.incidenceRate({ count: 1, exposureHours: 1000 });
    expect(r.field).toBe('base');
    expect(r.error).toMatch(/100,000,000 for FAR/);
  });

  test('the error text obeys the copy rule (no dashes as punctuation)', () => {
    const r = S.pseRate({ tier: 1, pseCount: 1, exposureHours: 1000, base: 3 });
    expect(r.error).not.toMatch(/[–—]|--/);
  });
});
