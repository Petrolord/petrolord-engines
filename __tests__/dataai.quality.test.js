// Data & AI D1 data quality gates. Every case in
// test-data/dataai/goldens/quality_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent stdlib oracle
// (tools/validation/dataai/oracle_quality.py) computed from the published
// equations. The pins in test-data/dataai/pins/quality_pins.json are a
// second witness (numpy, scipy, statsmodels, pandas) on the same inputs.
// Nothing below restates a formula to check the engine against itself: the
// property tests compare engine outputs with each other, and
// tools/validation/dataai/negcontrol_quality.sh proves the gates go red
// when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as Q from '../engines/dataai/quality';
import { despikeHampel } from '../engines/petrophysics/conditioning';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'dataai', 'goldens', 'quality_cases.json');
const PINS = read('test-data', 'dataai', 'pins', 'quality_pins.json');
const FLOOR = G.tolerance.absoluteFloor;

const get = (obj, dotted) => (dotted === '' ? obj : dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

/** Differences between actual and expected, as readable strings. */
const diff = (actual, expected, tol, where = '') => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const d = Math.abs(actual - expected);
    return d <= FLOOR || d <= tol * Math.abs(expected) ? [] : [`${where}: ${actual} vs ${expected} (rel ${d / Math.abs(expected)})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    return Object.keys(expected).flatMap((k) => diff(actual[k], expected[k], tol, `${where}.${k}`));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

const call = (c) => (Array.isArray(c.args) ? Q[c.fn](...c.args) : Q[c.fn](c.args));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from quality_cases.json`);
  return c;
};

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('quality');
    expect(G.cases.length).toBeGreaterThan(350);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden', () => {
    const fns = Object.keys(Q).filter((k) => typeof Q[k] === 'function');
    const used = new Set(G.cases.map((c) => c.fn));
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
  });

  test.each(G.cases.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c);
    if (c.expected && c.expected.error === true) {
      expect(typeof r.error).toBe('string');
      expect(r.field).toBe(c.expected.field);
      // refused BY NAME: the message starts with the field it refuses
      expect(r.error.startsWith(c.expected.field.replace(/[.[].*$/, ''))).toBe(true);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(r, c.expected, c.tol, c.fn)).toEqual([]);
  });
});

describe('published values: the engine reproduces the NIST/SEMATECH printed figures', () => {
  const pub = G.cases.filter((c) => c.source === 'published');
  const rows = pub.flatMap((c) => c.published.map((p, k) => [`${c.id} ${p.field || 'value'} #${k}`, c, p]));

  test('the anchors cover individuals, EWMA, CUSUM, Grubbs, z and all three quantile methods', () => {
    expect(new Set(pub.map((c) => c.fn))).toEqual(new Set(['individualsChart', 'ewmaChart', 'cusumChart', 'grubbsTest', 'zScores', 'sampleQuantile']));
    expect(rows.length).toBeGreaterThan(100);
  });

  test.each(rows)('%s', (_name, c, p) => {
    const v = get(call(c), p.field);
    if (typeof p.value === 'boolean') { expect(v).toBe(p.value); return; }
    const tol = p.tolerance ?? 0.5 * 10 ** -p.decimals + 1e-9;
    expect([p.field, Math.abs(v - p.value) <= tol]).toEqual([p.field, true]);
  });
});

describe('second witness: numpy / scipy / statsmodels / pandas pins', () => {
  test('the pin file names its generator and library versions', () => {
    expect(PINS.generatedBy).toBe('tools/validation/dataai/pin_quality.py');
    expect(Object.keys(PINS.versions).sort()).toEqual(['numpy', 'pandas', 'scipy', 'statsmodels']);
  });

  test.each(PINS.pins.map((p) => [p.id, p]))('%s', (_id, p) => {
    const c = byId(p.case);
    const r = call(c);
    const v = get(r, p.field);
    expect(diff(v, p.value, p.tol, `${p.case}.${p.field}`)).toEqual([]);
  });
});

describe('outliers: the lessons the numbers carry', () => {
  test('z cannot pass 3 at n = 10, the modified z finds the same wild value', () => {
    const z = Q.zScores(byId('z-unreachable-at-n10').args);
    expect(z.flags).toEqual([]);
    expect(z.thresholdReachable).toBe(false);
    expect(z.maxAbsZ).toBeCloseTo(z.maxPossibleAbsZ, 12);
    const m = Q.modifiedZScores(byId('modz-at-n10').args);
    expect(m.flags.map((f) => f.index)).toEqual([9]);
  });

  test('two spikes mask each other for the z-score but not for the modified z', () => {
    const args = byId('z-rhob-two-spikes').args;
    const z = Q.zScores(args).flags.map((f) => f.index);
    const m = Q.modifiedZScores(args).flags.map((f) => f.index);
    expect(m).toEqual(expect.arrayContaining([5, 27]));
    expect(z).not.toContain(5);
  });

  test('scores are invariant to a shift and a positive scale of the data', () => {
    const v = byId('z-rhob-two-spikes').args.values;
    const w = v.map((x) => (x === null ? null : 1000 * x - 7));
    const [a, b] = [Q.zScores({ values: v }), Q.zScores({ values: w })];
    a.z.forEach((zi, i) => (zi === null ? expect(b.z[i]).toBeNull() : expect(b.z[i]).toBeCloseTo(zi, 9)));
    const [c, d] = [Q.modifiedZScores({ values: v }), Q.modifiedZScores({ values: w })];
    c.scores.forEach((s, i) => (s === null ? expect(d.scores[i]).toBeNull() : expect(d.scores[i]).toBeCloseTo(s, 9)));
  });

  test('flags point at the ORIGINAL index when values are missing', () => {
    const r = Q.modifiedZScores({ values: [null, 1, 1.1, 0.9, 1.05, null, 50, 1] });
    expect(r.flags.map((f) => f.index)).toEqual([6]);
    expect(r.scores[0]).toBeNull();
  });

  test('quantiles never decrease in p, and R6/R7/R8 agree at the median', () => {
    const v = byId('quantile-gr60-R7-0.5').args[0];
    ['R6', 'R7', 'R8'].forEach((m) => {
      let last = -Infinity;
      for (let p = 0; p <= 1.00001; p += 0.01) {
        const q = Q.sampleQuantile(v, Math.min(p, 1), m);
        expect(q).toBeGreaterThanOrEqual(last);
        last = q;
      }
    });
    const odd = v.slice(0, 59);
    const meds = ['R6', 'R7', 'R8'].map((m) => Q.sampleQuantile(odd, 0.5, m));
    expect(meds[0]).toBe(meds[1]);
    expect(meds[2]).toBe(meds[1]);
  });

  test('Hampel decisions are exactly the petrophysics despikeHampel decisions', () => {
    ['hampel-gr-hw3', 'hampel-gr-hw5-n2', 'hampel-zero-mad'].forEach((id) => {
      const { values, halfWindow, nSigma = 3 } = byId(id).args;
      const x = values.map((v) => (v === null ? NaN : v));
      const ref = despikeHampel(x, halfWindow, nSigma);
      const changed = x.map((v, i) => (Number.isNaN(v) ? -1 : ref[i] !== v ? i : -1)).filter((i) => i >= 0);
      expect([id, Q.hampel(byId(id).args).flags.map((f) => f.index)]).toEqual([id, changed]);
    });
  });

  test('Grubbs statistic equals the largest |z| (sample SD), and G never passes (n - 1)/sqrt(n)', () => {
    G.cases.filter((c) => c.fn === 'grubbsTest' && !c.expected.error && c.args.side === undefined).forEach((c) => {
      const g = Q.grubbsTest(c.args);
      expect(g.statistic).toBeCloseTo(Q.zScores({ values: c.args.values }).maxAbsZ, 12);
      expect(g.statistic).toBeLessThanOrEqual(g.maxPossible + 1e-12);
      expect(g.critical).toBeLessThan(g.maxPossible);
    });
  });

  test('Student t quantile reproduces its own tail through the incomplete beta', () => {
    [[0.05, 6], [0.001, 3], [0.2, 40]].forEach(([q, df]) => {
      const t = Q.studentTUpperQuantile(q, df);
      expect(Q.regularizedBeta(df / (df + t * t), df / 2, 0.5) / 2).toBeCloseTo(q, 13);
    });
  });
});

describe('Mahalanobis', () => {
  test('the squared distances sum to (n - 1) p with the sample covariance', () => {
    ['mahal-phi-rhob-2d', 'mahal-3d', 'mahal-4d'].forEach((id) => {
      const r = Q.mahalanobis(byId(id).args);
      const s = r.d2.filter((v) => v !== null).reduce((a, b) => a + b, 0);
      expect(s).toBeCloseTo((r.n - 1) * r.p, 8);
    });
  });

  test('distances are unchanged by an invertible linear map of the variables', () => {
    const rows = byId('mahal-phi-rhob-2d').args.rows;
    const mapped = rows.map((r) => (r[1] === null ? [r[0], null] : [2 * r[0] + r[1], r[0] - 3 * r[1] + 5]));
    const a = Q.mahalanobis({ rows });
    const b = Q.mahalanobis({ rows: mapped });
    a.d2.forEach((v, i) => (v === null ? expect(b.d2[i]).toBeNull() : expect(b.d2[i]).toBeCloseTo(v, 8)));
  });

  test('with one variable d^2 is z^2', () => {
    const rows = byId('mahal-1d-equals-z-squared').args.rows;
    const z = Q.zScores({ values: rows.map((r) => r[0]) }).z;
    Q.mahalanobis({ rows }).d2.forEach((v, i) => expect(v).toBeCloseTo(z[i] ** 2, 10));
  });
});

describe('control charts', () => {
  test('EWMA with lambda = 1 is the data itself (the Shewhart limit case)', () => {
    const c = byId('ewma-drift-1.0');
    const r = Q.ewmaChart(c.args);
    expect(r.ewma).toEqual(c.args.values);
  });

  test('exact EWMA limits start narrow and approach the asymptotic ones from inside', () => {
    const r = Q.ewmaChart(byId('ewma-drift-exact-limits').args);
    const widths = r.points.map((p) => p.ucl - p.lcl);
    for (let i = 1; i < widths.length; i += 1) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    expect(widths[widths.length - 1]).toBeLessThanOrEqual(r.ucl - r.lcl);
    expect(widths[widths.length - 1]).toBeCloseTo(r.ucl - r.lcl, 6);
  });

  test('CUSUM in sigma units is the data-unit chart with k and h scaled', () => {
    const a = Q.cusumChart(byId('nist-6.3.2.3-cusum-tabular').args);
    const b = Q.cusumChart(byId('nist-6.3.2.3-cusum-in-sigma-units').args);
    expect(b.firstSignalHigh).toBe(a.firstSignalHigh);
    expect(b.flags.map((f) => f.index)).toEqual(a.flags.map((f) => f.index));
  });

  test('a CUSUM that reaches h exactly does not signal; one step more does', () => {
    const c = byId('cusum-exactly-on-h');
    const r = Q.cusumChart(c.args);
    expect(r.points[3].sHigh).toBe(4);
    expect(r.flags).toEqual([]);
    expect(Q.cusumChart({ ...c.args, values: [...c.args.values, 11.5] }).firstSignalHigh).toBe(4);
  });

  test('mirroring the data about the target swaps the two CUSUM sides', () => {
    const c = byId('cusum-drift-sigma');
    const mirrored = c.args.values.map((v) => 2 * c.args.target - v);
    const a = Q.cusumChart(c.args);
    const b = Q.cusumChart({ ...c.args, values: mirrored });
    a.points.forEach((p, i) => {
      expect(b.points[i].sLow).toBeCloseTo(p.sHigh, 10);
      expect(b.points[i].sHigh).toBeCloseTo(p.sLow, 10);
    });
  });

  test('the individuals limits are symmetric about the centre', () => {
    const r = Q.individualsChart(byId('individuals-rate-drop').args);
    expect(r.ucl - r.centre).toBeCloseTo(r.centre - r.lcl, 9);
  });
});

describe('uniqueness', () => {
  test('Levenshtein is a metric on a sample of identifiers', () => {
    const ids = byId('duplicates-well-list').args.ids;
    ids.forEach((a) => ids.forEach((b) => {
      expect(Q.levenshtein(a, b)).toBe(Q.levenshtein(b, a));
      expect(Q.levenshtein(a, b) === 0).toBe(a === b);
      ids.forEach((c) => expect(Q.levenshtein(a, c)).toBeLessThanOrEqual(Q.levenshtein(a, b) + Q.levenshtein(b, c)));
    }));
  });

  test('normalisation is idempotent', () => {
    G.cases.filter((c) => c.fn === 'normalizeIdentifier').forEach((c) => {
      const once = Q.normalizeIdentifier(...c.args);
      expect(Q.normalizeIdentifier(once, c.args[1])).toBe(once);
    });
  });

  test('the digit rule is what keeps two real wells apart', () => {
    const strict = Q.duplicateIdentifiers(byId('duplicates-well-list').args).pairs;
    const loose = Q.duplicateIdentifiers(byId('duplicates-digits-free').args).pairs;
    const has = (ps, i, j) => ps.some((p) => p.i === i && p.j === j);
    expect(has(strict, 0, 1)).toBe(false);
    expect(has(loose, 0, 1)).toBe(true);
  });
});

describe('scorecard', () => {
  test('weights are normalised: scaling every weight changes nothing', () => {
    const c = byId('scorecard-weighted');
    const w10 = Object.fromEntries(Object.entries(c.args.weights).map(([k, v]) => [k, 10 * v]));
    expect(Q.scorecard({ ...c.args, weights: w10 }).total).toBeCloseTo(Q.scorecard(c.args).total, 14);
  });

  test('the total lies between the weakest and strongest dimension', () => {
    const r = Q.scorecard(byId('scorecard-equal').args);
    const s = r.dimensions.map((d) => d.score);
    expect(r.total).toBeGreaterThanOrEqual(Math.min(...s));
    expect(r.total).toBeLessThanOrEqual(Math.max(...s));
  });
});

describe('every flag and refusal explains itself, in plain copy', () => {
  const outputs = G.cases.map((c) => [c.id, call(c)]);

  test('every flag carries a rule and a reason sentence', () => {
    outputs.forEach(([id, r]) => {
      (r.flags || []).forEach((f) => {
        expect([id, typeof f.rule, typeof f.reason, f.reason.length > 10]).toEqual([id, 'string', 'string', true]);
      });
    });
  });

  test('no em or en dashes and no NaN in any reason or refusal', () => {
    outputs.forEach(([id, r]) => {
      const texts = [r.error, ...(r.flags || []).map((f) => f.reason), ...(r.pairs || []).map((p) => p.reason)].filter(Boolean);
      texts.forEach((t) => expect([id, /[–—]|--|NaN/.test(t)]).toEqual([id, false]));
    });
  });

  test('every result that is not a refusal names its basis', () => {
    outputs.forEach(([id, r]) => {
      if (r && typeof r === 'object' && !r.error) expect([id, typeof r.basis]).toEqual([id, 'object']);
    });
  });

  test('bad input returns a structured refusal, never NaN or a throw', () => {
    const bad = [undefined, null, 'x', [1, 'a'], [NaN, Infinity]];
    ['completeness', 'zScores', 'modifiedZScores', 'iqrFences', 'hampel', 'grubbsTest', 'individualsChart', 'ewmaChart', 'cusumChart', 'rangeCheck', 'frozenRuns', 'cumulativeCheck', 'rateCheck']
      .forEach((fn) => bad.forEach((values) => {
        const r = Q[fn]({ values, rates: values, cumulative: values, halfWindow: 1, lambda: 0.2, target: 0, sigma: 1, k: 0.5, h: 4, units: 'sigma', min: 0, max: 1 });
        expect([fn, typeof r.error, typeof r.field]).toEqual([fn, 'string', 'string']);
      }));
    expect(Q.mahalanobis().field).toBe('rows');
    expect(Q.scorecard().field).toBe('dimensions');
  });
});
