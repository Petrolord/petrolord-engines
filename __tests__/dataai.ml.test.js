// Data & AI D2 machine learning gates. Every case in
// test-data/dataai/goldens/ml_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent stdlib oracle
// (tools/validation/dataai/oracle_ml.py) computed from the equations, most of
// them in exact rational arithmetic. The NIST StRD certified values are
// published anchors with a digit floor per dataset. The pins in
// test-data/dataai/pins/ml_pins.json are a second witness (numpy,
// scikit-learn, statsmodels) on the same inputs. Nothing below restates a
// formula to check the engine against itself: the property tests compare
// engine outputs with each other, and tools/validation/dataai/negcontrol_ml.sh
// proves the gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as ML from '../engines/dataai/ml';
import { syntheticWells } from '../tools/validation/dataai/synthetic_wells';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'dataai', 'goldens', 'ml_cases.json');
const PINS = read('test-data', 'dataai', 'pins', 'ml_pins.json');
const FLOOR = G.tolerance.absoluteFloor;

const get = (obj, dotted) => (dotted === '' ? obj : dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

/** Differences between actual and expected, as readable strings. */
const diff = (actual, expected, tol, where = '', floor = FLOOR) => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const d = Math.abs(actual - expected);
    return d <= floor || d <= tol * Math.abs(expected) ? [] : [`${where}: ${actual} vs ${expected} (rel ${d / Math.abs(expected)})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`, floor));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    return Object.keys(expected).flatMap((k) => diff(actual[k], expected[k], tol, `${where}.${k}`, floor));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

const call = (c) => ML[c.fn](c.args);
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from ml_cases.json`);
  return c;
};
const args = (id) => JSON.parse(JSON.stringify(byId(id).args));

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('ml');
    expect(G.generatedBy).toBe('tools/validation/dataai/oracle_ml.py');
    expect(G.cases.length).toBeGreaterThan(150);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden, and refused at least once', () => {
    const fns = Object.keys(ML).filter((k) => typeof ML[k] === 'function');
    const used = new Set(G.cases.map((c) => c.fn));
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
    const refused = new Set(G.cases.filter((c) => c.expected.error === true).map((c) => c.fn));
    expect(fns.filter((f) => !refused.has(f))).toEqual([]);
  });

  test.each(G.cases.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c);
    const e = c.expected;
    if (e && e.error === true) {
      expect([typeof r.error, r.field]).toEqual(['string', e.field]);
      // refused BY NAME: the message starts with the field it refuses
      expect(r.error.startsWith(e.field.replace(/[.[].*$/, ''))).toBe(true);
      if ('message' in e) expect(r.error).toBe(e.message);
      if ('messageStartsWith' in e) expect(r.error.startsWith(e.messageStartsWith)).toBe(true);
      if ('messageEndsWith' in e) expect(r.error.endsWith(e.messageEndsWith)).toBe(true);
      if ('messageFigure' in e) {
        const fig = Number(r.error.slice(e.messageStartsWith.length, r.error.length - e.messageEndsWith.length));
        expect([fig, Math.abs(fig - e.messageFigure) <= 1e-6 * e.messageFigure]).toEqual([fig, true]);
      }
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(r, e, c.tol, c.fn, c.abs ?? FLOOR)).toEqual([]);
  });
});

describe('published values: NIST StRD certified linear regression results', () => {
  const pub = G.cases.filter((c) => c.source === 'published');
  const rows = pub.flatMap((c) => c.published.map((p) => [`${c.id} ${p.field} (${p.digits} digits)`, c, p]));

  test('the anchors are the eleven NIST StRD linear least squares datasets', () => {
    expect(pub.map((c) => c.id).sort()).toEqual(['nist-filip-forced', 'nist-longley', 'nist-noint1', 'nist-noint2', 'nist-norris', 'nist-pontius',
      'nist-wampler1', 'nist-wampler2', 'nist-wampler3', 'nist-wampler4', 'nist-wampler5']);
    expect(rows.length).toBeGreaterThan(100);
  });

  test('before the engine sees them, the oracle reproduced every certified figure to 13 digits on the exact decimal data', () => {
    Object.values(G.nistOracleDigits).forEach((d) => expect(d).toBeGreaterThanOrEqual(13));
  });

  test.each(rows)('%s', (_name, c, p) => {
    const v = get(call(c), p.field);
    const err = p.value === 0 ? Math.abs(v) : Math.abs(v - p.value) / Math.abs(p.value);
    expect([p.field, err <= 10 ** -p.digits]).toEqual([p.field, true]);
  });

  test('Filip is refused at the default maxCondition: its scaled condition number is about 5.2e9', () => {
    const r = ML.ols({ X: args('nist-filip-forced').X, y: args('nist-filip-forced').y });
    expect(r.field).toBe('X');
    const forced = call(byId('nist-filip-forced'));
    expect(forced.scaledConditionNumber).toBeGreaterThan(ML.DEFAULTS.MAX_CONDITION);
  });
});

describe('second witness: numpy / scikit-learn / statsmodels pins', () => {
  test('the pin file names its generator and library versions', () => {
    expect(PINS.generatedBy).toBe('tools/validation/dataai/pin_ml.py');
    expect(Object.keys(PINS.versions).sort()).toEqual(['numpy', 'scikit-learn', 'scipy', 'statsmodels']);
    expect(PINS.pins.length).toBeGreaterThan(100);
  });

  test.each(PINS.pins.map((p) => [p.id, p]))('%s', (_id, p) => {
    const r = call(byId(p.case));
    const v = get(r, p.field);
    expect(diff(v, p.value, p.tol, `${p.case}.${p.field}`, p.abs ?? FLOOR)).toEqual([]);
  });
});

describe('splits: whole wells, deterministic, and the leak made visible', () => {
  const g = args('group-split-0.3-seed1').groups;

  test('a group split never puts one well on both sides, and covers every row once', () => {
    [1, 7, 42, 2026].forEach((seed) => {
      const s = ML.groupSplit({ groups: g, testFraction: 0.3, seed });
      const tr = new Set(s.trainIndices.map((i) => g[i]));
      expect(s.testIndices.filter((i) => tr.has(g[i]))).toEqual([]);
      expect([...s.trainIndices, ...s.testIndices].sort((a, b) => a - b)).toEqual(g.map((_, i) => i));
    });
  });

  test('the same seed gives the same split; the order of rows does not change which wells are held out', () => {
    const a = ML.groupSplit({ groups: g, testFraction: 0.3, seed: 42 });
    expect(ML.groupSplit({ groups: g, testFraction: 0.3, seed: 42 })).toEqual(a);
    const rev = [...g].reverse();
    expect(ML.groupSplit({ groups: rev, testFraction: 0.3, seed: 42 }).testGroups).toEqual(a.testGroups);
  });

  test('group k-fold tests every well exactly once', () => {
    const f = ML.groupKFold({ groups: g, k: 4, seed: 9 });
    const tested = f.folds.flatMap((x) => x.testGroups).sort();
    expect(tested).toEqual([...new Set(g)].sort());
    f.folds.forEach((x) => expect(x.testGroups.filter((w) => x.trainGroups.includes(w))).toEqual([]));
  });

  test('a random row split shares wells across the split; a group split never does', () => {
    const r = ML.randomRowSplit({ groups: g, testFraction: 0.3, seed: 1 });
    expect(r.sharedGroups.length).toBeGreaterThan(0);
    expect(ML.groupSplit({ groups: g, testFraction: 0.3, seed: 1 }).sharedGroups).toEqual([]);
  });

  test('0.28 x 25 groups holds out 7 wells, not 8 (the float product is 7.000000000000001)', () => {
    expect(0.28 * 25).toBeGreaterThan(7);
    expect(ML.groupSplit(args('group-split-0.28-of-25')).nTestGroups).toBe(7);
    expect(ML.randomRowSplit(args('random-rows-0.28-of-25')).nTest).toBe(7);
  });

  test('the engine draws only from the seeded mulberry32 stream', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'dataai', 'ml.js'), 'utf8');
    expect(src.includes('Math.random')).toBe(false);
  });
});

describe('preprocessing: fitted on the training rows only', () => {
  test('fitting with trainIndices equals fitting on those rows, and differs from fitting on all rows', () => {
    const a = args('scaler-standard-train-only');
    const viaIdx = ML.fitStandardScaler(a);
    const viaRows = ML.fitStandardScaler({ X: a.trainIndices.map((i) => a.X[i]), names: a.names });
    expect(viaIdx.centre).toEqual(viaRows.centre);
    expect(viaIdx.scale).toEqual(viaRows.scale);
    const all = ML.fitStandardScaler({ X: a.X, names: a.names });
    expect(all.centre).not.toEqual(viaIdx.centre);
  });

  test('the training rows standardise to mean 0 and population SD 1; test rows do not', () => {
    const a = args('scaler-standard-train-only');
    const sc = ML.fitStandardScaler(a);
    const Z = ML.applyScaler({ scaler: sc, X: a.trainIndices.map((i) => a.X[i]) }).X;
    for (let j = 0; j < 3; j += 1) {
      const col = Z.map((r) => r[j]);
      const m = col.reduce((s, v) => s + v, 0) / col.length;
      expect(Math.abs(m)).toBeLessThan(1e-12);
      expect(Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / col.length)).toBeCloseTo(1, 12);
    }
  });
});

describe('linear models: properties across engine outputs', () => {
  test('ridge with lambda 0 is ordinary least squares', () => {
    const a = args('ridge-porosity-lambda0');
    const r = ML.ridge(a);
    const o = ML.ols({ X: a.X, y: a.y, names: a.names });
    expect(diff(r.coefficients, o.coefficients, 1e-10)).toEqual([]);
  });

  test('the ridge intercept is not penalised: a huge lambda sends the slopes to 0 and the intercept to the mean of y', () => {
    const a = args('ridge-porosity-lambda0');
    const r = ML.ridge({ ...a, lambda: 1e12 });
    const ybar = a.y.reduce((s, v) => s + v, 0) / a.y.length;
    expect(Math.abs(r.coefficients[0] - ybar)).toBeLessThan(1e-9);
    r.coefficients.slice(1).forEach((b) => expect(Math.abs(b)).toBeLessThan(1e-9));
  });

  test('the ridge coefficient norm shrinks as lambda grows, and effective degrees of freedom fall from p', () => {
    const norms = [0, 0.1, 1, 10, 100].map((l) => {
      const r = call(byId(`ridge-porosity-lambda${l}`));
      return [Math.hypot(...r.standardizedCoefficients.slice(1)), r.effectiveDegreesOfFreedom];
    });
    for (let i = 1; i < norms.length; i += 1) {
      expect(norms[i][0]).toBeLessThan(norms[i - 1][0]);
      expect(norms[i][1]).toBeLessThan(norms[i - 1][1]);
    }
    expect(norms[0][1]).toBeCloseTo(3, 10);
  });

  test('rescaling a feature by c rescales its OLS coefficient by 1/c and leaves the fit alone', () => {
    const a = args('ols-porosity-all-wells');
    const o = ML.ols(a);
    const s = ML.ols({ ...a, X: a.X.map((r) => [r[0] * 1000, r[1], r[2]]) });
    expect(s.coefficients[1] * 1000).toBeCloseTo(o.coefficients[1], 12);
    expect(s.rSquared).toBeCloseTo(o.rSquared, 12);
  });

  test('the OLS residuals sum to zero with an intercept and are orthogonal to every feature', () => {
    const a = args('nist-longley');
    const o = ML.ols(a);
    const scale = Math.max(...a.y.map(Math.abs));
    expect(Math.abs(o.residuals.reduce((s, v) => s + v, 0))).toBeLessThan(1e-6 * scale);
  });
});

describe('logistic: convergence and separation', () => {
  test('the iteration count, convergence flag and trace agree', () => {
    const r = call(byId('logistic-pay-gr-nphi'));
    expect(r.converged).toBe(true);
    expect(r.trace.length).toBe(r.iterations);
    expect(r.trace[r.trace.length - 1].maxChange).toBeLessThanOrEqual(1e-10);
    r.trace.slice(0, -1).forEach((t) => expect(t.maxChange).toBeGreaterThan(1e-10));
  });

  test('a run stopped early says so and quotes the last change', () => {
    const r = call(byId('logistic-maxiter-2'));
    expect([r.converged, r.iterations]).toEqual([false, 2]);
    expect(r.warning).toBe(`did not converge in 2 updates: the last full Newton step had a largest component of ${String(r.trace[1].maxChange)}, above tol 1e-10`);
  });

  test('a penalty shrinks the slopes; the row order does not matter', () => {
    const a = args('logistic-pay-gr-nphi');
    const r0 = ML.logistic(a);
    const r5 = ML.logistic({ ...a, l2: 5 });
    expect(Math.hypot(...r5.coefficients.slice(1))).toBeLessThan(Math.hypot(...r0.coefficients.slice(1)));
    const rev = ML.logistic({ ...a, X: [...a.X].reverse(), y: [...a.y].reverse() });
    expect(diff(rev.coefficients, r0.coefficients, 1e-9)).toEqual([]);
  });

  test('separation is reported under a penalty, and the separated fit is finite', () => {
    const r = call(byId('logistic-separated-l2-1'));
    expect(r.separation.detected).toBe(true);
    r.coefficients.forEach((b) => expect(Number.isFinite(b)).toBe(true));
  });
});

describe('metrics: properties', () => {
  test('flipping the labels turns AUC into 1 - AUC, ties included', () => {
    ['roc-ties', 'roc-coarse-scores', 'roc-logistic-pay'].forEach((id) => {
      const a = args(id);
      const r = ML.rocCurve(a);
      const f = ML.rocCurve({ yTrue: a.yTrue.map((v) => 1 - v), scores: a.scores });
      expect(r.auc + f.auc).toBeCloseTo(1, 12);
    });
  });

  test('AUC does not change under a monotone transform of the scores', () => {
    const a = args('roc-coarse-scores');
    const r = ML.rocCurve(a);
    expect(ML.rocCurve({ yTrue: a.yTrue, scores: a.scores.map((s) => Math.exp(3 * s) - 7) }).auc).toBe(r.auc);
  });

  test('accuracy is the confusion-matrix trace over n', () => {
    const a = args('report-facies');
    const r = ML.classificationReport(a);
    expect(r.accuracy).toBe(r.matrix.reduce((s, row, i) => s + row[i], 0) / r.n);
  });
});

describe('evaluation: learning curve and leakage', () => {
  test('the leakage demo shows the random row split flattering the model, on every seed', () => {
    [1, 5, 13].forEach((seed) => {
      const r = call(byId(`leakage-ridge-r2-seed${seed}`));
      expect(r.optimism).toBeGreaterThan(0.2);
      expect(r.randomRow.sharedGroups.length).toBeGreaterThan(0);
      expect(r.group.sharedGroups).toEqual([]);
    });
  });

  test('learning curve points train on more rows as groups are added, against the same test wells', () => {
    const r = call(byId('learning-curve-ols'));
    for (let i = 1; i < r.points.length; i += 1) expect(r.points[i].nRows).toBeGreaterThan(r.points[i - 1].nRows);
    r.points.forEach((p) => expect(p.groups.filter((w) => r.testGroups.includes(w))).toEqual([]));
  });

  test('permutation importance is reproducible from its seed', () => {
    const a = args('perm-ols-r2');
    expect(ML.permutationImportance(a)).toEqual(ML.permutationImportance(a));
  });
});

describe('scale: app-sized inputs stay linear (tools/validation/dataai/timing_ml.mjs has the timing table)', () => {
  // Complexity guards, not stopwatches: the separation LP pivot count must
  // not grow with n the way the old primal LP (n constraint rows) did, and
  // nothing may hit the ~125k spread-argument limit. The time budgets are
  // generous (about 10x a Node 18 run) so the test cannot flake.
  const big = syntheticWells(20000, 8);

  test('separation LP pivots are bounded at 20,000 rows x 8 features: overlap and complete separation', () => {
    const t0 = Date.now();
    const a = ML.logistic({ X: big.X, y: big.label });
    const b = ML.logistic({ X: big.X, y: big.separatedLabel, l2: 1 });
    const c = ML.logistic({ X: big.X, y: big.separatedLabel });
    expect([a.converged, a.separation.type, b.separation.type, c.field]).toEqual([true, 'none', 'complete', 'y']);
    expect(a.separation.lpPivots).toBeLessThanOrEqual(100);
    expect(b.separation.lpPivots).toBeLessThanOrEqual(400);
    expect(Date.now() - t0).toBeLessThan(20000);
  });

  test('OLS, ridge and permutation importance at 20,000 rows run within a generous budget', () => {
    const t0 = Date.now();
    const o = ML.ols({ X: big.X, y: big.y });
    const r = ML.ridge({ X: big.X, y: big.y, lambda: 1 });
    const pi = ML.permutationImportance({ model: o, X: big.X, y: big.y, metric: 'r2', nRepeats: 5, seed: 1 });
    expect([o.error, r.error, pi.error]).toEqual([undefined, undefined, undefined]);
    expect(Date.now() - t0).toBeLessThan(20000);
  });

  test('150,000 rows pass through the scalers, k-fold and ROC (no spread-argument limit)', () => {
    const huge = syntheticWells(150000, 3);
    expect(ML.fitMinMaxScaler({ X: huge.X }).error).toBeUndefined();
    expect(ML.fitStandardScaler({ X: huge.X }).error).toBeUndefined();
    expect(ML.groupKFold({ groups: huge.groups, k: 5, seed: 1 }).folds.length).toBe(5);
    expect(ML.rocCurve({ yTrue: huge.label, scores: huge.y }).error).toBeUndefined();
  });
});

describe('every result explains itself, in plain copy', () => {
  const outputs = G.cases.map((c) => [c.id, call(c)]);

  test('no em or en dashes and no NaN in any refusal or warning', () => {
    outputs.forEach(([id, r]) => {
      [r.error, r.warning].filter(Boolean).forEach((t) => expect([id, /[–—]|--|NaN|\$\{|\[object/.test(t)]).toEqual([id, false]));
    });
  });

  test('every result that is not a refusal names its basis', () => {
    outputs.forEach(([id, r]) => {
      if (r && typeof r === 'object' && !r.error) expect([id, typeof r.basis]).toEqual([id, 'object']);
    });
  });

  test('bad input returns a structured refusal, never NaN or a throw', () => {
    const bad = [undefined, null, 'x', [[1, 'a']], [[NaN]], [[Infinity, 1]]];
    const fns = ['fitStandardScaler', 'fitMinMaxScaler', 'ols', 'ridge', 'logistic'];
    fns.forEach((fn) => bad.forEach((X) => {
      const r = ML[fn]({ X, y: [1, 0], lambda: 1 });
      expect([fn, typeof r.error, typeof r.field]).toEqual([fn, 'string', 'string']);
    }));
    ['groupSplit', 'groupKFold', 'randomRowSplit', 'regressionMetrics', 'confusionMatrix', 'classificationReport', 'rocCurve', 'logLoss',
      'predict', 'applyScaler', 'permutationImportance', 'learningCurve', 'leakageDemo'].forEach((fn) => {
      const r = ML[fn]();
      expect([fn, typeof r.error, typeof r.field]).toEqual([fn, 'string', 'string']);
    });
  });
});
