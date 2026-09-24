// Data & AI D3 electrofacies gates. Every case in
// test-data/dataai/goldens/cluster_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent stdlib oracle
// (tools/validation/dataai/oracle_cluster.py) computed from the definitions
// (Decimal and Fraction arithmetic, different roads: bisection eigenvalues,
// linkage heights from their definitions, brute-force matching, pair-count
// ARI). Fisher's iris data carries a published PCA figure. The pins in
// test-data/dataai/pins/cluster_pins.json are a second witness
// (scikit-learn, scipy). Property tests compare engine outputs with each
// other, never with a restated formula; tools/validation/dataai/
// negcontrol_cluster.sh proves the gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as CL from '../engines/dataai/cluster';
import { syntheticFacies } from '../tools/validation/dataai/synthetic_wells';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'dataai', 'goldens', 'cluster_cases.json');
const PINS = read('test-data', 'dataai', 'pins', 'cluster_pins.json');
const FLOOR = G.tolerance.absoluteFloor;

const get = (obj, dotted) => (dotted === '' ? obj : dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

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

/** Arguments with any `{ __fit__: fn, args }` model replaced by the engine's fit. */
const resolve = (a) => {
  const out = { ...a };
  if (out.model && out.model.__fit__) out.model = CL[out.model.__fit__](out.model.args);
  return out;
};
const call = (c) => CL[c.fn](resolve(JSON.parse(JSON.stringify(c.args))));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from cluster_cases.json`);
  return c;
};
const args = (id) => JSON.parse(JSON.stringify(byId(id).args));

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('cluster');
    expect(G.generatedBy).toBe('tools/validation/dataai/oracle_cluster.py');
    expect(G.cases.length).toBeGreaterThan(100);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden, and refused at least once', () => {
    const fns = Object.keys(CL).filter((k) => typeof CL[k] === 'function');
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
      expect(r.error.startsWith(e.field.replace(/[.[].*$/, ''))).toBe(true);
      expect(r.error).toBe(e.message);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(r, e, c.tol, c.fn, c.abs ?? FLOOR)).toEqual([]);
  });
});

describe('published values: Fisher iris', () => {
  const pub = G.cases.filter((c) => c.source === 'published');
  test.each(pub.flatMap((c) => c.published.map((p) => [`${c.id} ${p.field}`, c, p])))('%s', (_n, c, p) => {
    const v = get(call(c), p.field);
    expect(Math.round(v * 10 ** p.digits) / 10 ** p.digits).toBe(p.value);
  });

  test('the iris file is Fisher 1936 as committed (samples 35 and 38 carry Fisher values, not the UCI errata)', () => {
    const X = args('pca-iris-covariance').X;
    expect(X.length).toBe(150);
    expect(X[34]).toEqual([4.9, 3.1, 1.5, 0.2]);
    expect(X[37]).toEqual([4.9, 3.6, 1.4, 0.1]);
  });
});

describe('second witness: scikit-learn / scipy pins', () => {
  test('the pin file names its generator and library versions', () => {
    expect(PINS.generatedBy).toBe('tools/validation/dataai/pin_cluster.py');
    expect(Object.keys(PINS.versions).sort()).toEqual(['numpy', 'scikit-learn', 'scipy']);
    expect(PINS.pins.length).toBeGreaterThan(40);
  });

  test.each(PINS.pins.map((p) => [p.id, p]))('%s', (_id, p) => {
    const r = call(byId(p.case));
    let v = get(r, p.field);
    if (p.transform === 'canonical') v = (() => { const m = new Map(); return v.map((x) => { if (!m.has(x)) m.set(x, m.size); return m.get(x); }); })();
    if (p.transform === 'splitThresholds') v = v.filter((nd) => !nd.leaf).map((nd) => nd.threshold);
    if (p.transform === 'sortedHeights') v = [...v].sort((a, b) => a - b);
    expect(diff(v, p.value, p.tol, `${p.case}.${p.field}`, p.abs ?? FLOOR)).toEqual([]);
  });
});

describe('PCA: properties', () => {
  const r = call(byId('pca-ekene-correlation-3'));
  test('components are orthonormal and the correlation eigenvalues sum to the number of features', () => {
    for (let a = 0; a < 3; a += 1) {
      for (let b = 0; b < 3; b += 1) {
        const dot = r.components[a].reduce((s, v, j) => s + v * r.components[b][j], 0);
        expect(Math.abs(dot - (a === b ? 1 : 0))).toBeLessThan(1e-12);
      }
    }
    expect(r.eigenvalues.reduce((s, v) => s + v, 0)).toBeCloseTo(4, 12);
  });
  test('each score column has sample variance equal to its eigenvalue', () => {
    for (let k = 0; k < 3; k += 1) {
      const col = r.scores.map((s) => s[k]);
      const m = col.reduce((s, v) => s + v, 0) / col.length;
      expect(Math.abs(m)).toBeLessThan(1e-12);
      expect(col.reduce((s, v) => s + (v - m) ** 2, 0) / (col.length - 1)).toBeCloseTo(r.eigenvalues[k], 10);
    }
  });
  test('the sign convention holds: the largest absolute loading of each component is positive', () => {
    r.components.forEach((v) => { const j = v.reduce((b, x, i) => (Math.abs(x) > Math.abs(v[b]) ? i : b), 0); expect(v[j]).toBeGreaterThan(0); });
  });
  test('rescaling a feature leaves the correlation PCA unchanged; the covariance PCA changes', () => {
    const a = args('pca-ekene-correlation-3');
    const s = CL.pca({ ...a, X: a.X.map((row) => [row[0] * 1000, ...row.slice(1)]) });
    expect(diff(s.eigenvalues, r.eigenvalues, 1e-10)).toEqual([]);
    const c1 = CL.pca({ X: a.X, matrix: 'covariance' });
    const c2 = CL.pca({ X: a.X.map((row) => [row[0] * 1000, ...row.slice(1)]), matrix: 'covariance' });
    expect(c2.explainedVarianceRatio[0]).toBeGreaterThan(c1.explainedVarianceRatio[0]);
  });
  test('pcaTransform of the training rows reproduces the scores', () => {
    const a = args('pca-ekene-correlation-3');
    expect(diff(CL.pcaTransform({ model: r, X: a.X }).scores, r.scores, 1e-10, '', 1e-12)).toEqual([]);
  });
});

describe('k-means: properties', () => {
  test('the same seed gives the same result; the engine draws only from mulberry32', () => {
    const a = args('kmeans-ekene-k4');
    expect(CL.kmeans(a)).toEqual(CL.kmeans(a));
    const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'dataai', 'cluster.js'), 'utf8');
    expect(src.includes('Math.random')).toBe(false);
  });
  test('inertia never rises across Lloyd passes, and the best run has the lowest inertia', () => {
    const r = call(byId('kmeans-ekene-k5'));
    for (let i = 1; i < r.trace.length; i += 1) expect(r.trace[i].inertia).toBeLessThanOrEqual(r.trace[i - 1].inertia * (1 + 1e-12));
    r.runs.forEach((run) => expect(r.inertia).toBeLessThanOrEqual(run.inertia));
  });
  test('an elbow row equals the single kmeans call with the same k and seed', () => {
    const e = call(byId('elbow-ekene-1-6'));
    const k4 = call(byId('kmeans-ekene-k4'));
    expect(e.table.find((t) => t.k === 4).inertia).toBe(k4.inertia);
  });
  test('assignClusters on the training rows returns the fitted labels', () => {
    const a = args('kmeans-ekene-k4');
    const m = CL.kmeans(a);
    expect(CL.assignClusters({ model: m, X: a.X }).labels).toEqual(m.labels);
  });
  test('explicit init equal to the chosen k-means++ start reproduces the run', () => {
    const a = args('kmeans-iris-k4-ninit1');
    const m = CL.kmeans(a);
    const again = CL.kmeans({ X: a.X, k: 4, init: m.initialCentres, scale: 'none' });
    expect(again.labels).toEqual(m.labels);
    expect(again.inertia).toBe(m.inertia);
  });
});

describe('agglomerative, silhouette, kNN, CART, matching: properties', () => {
  test('merge heights never fall (Ward, complete and average are monotone)', () => {
    ['ward', 'complete', 'average'].forEach((lk) => {
      const r = call(byId(`agglomerative-ekene90-${lk}-k4`));
      for (let i = 1; i < r.heights.length; i += 1) expect(r.heights[i]).toBeGreaterThanOrEqual(r.heights[i - 1] * (1 - 1e-12));
    });
  });
  test('cutTree of the returned linkage matrix gives the same labels as agglomerative with k', () => {
    const r = call(byId('agglomerative-ekene90-ward-k4'));
    expect(CL.cutTree({ linkageMatrix: r.linkageMatrix, k: 4 }).labels).toEqual(r.labels);
  });
  test('the row order of equal points does not change the partition of a tie-free tree', () => {
    const a = args('agglomerative-ekene90-average-k4');
    const r = CL.agglomerative(a);
    const rev = CL.agglomerative({ ...a, X: [...a.X].reverse() });
    const back = [...rev.labels].reverse();
    expect(CL.adjustedRandIndex({ a: r.labels, b: back }).ari).toBe(1);
  });
  test('silhouette values lie in [-1, 1] and their mean is the reported mean', () => {
    const r = call(byId('silhouette-ekene-k4'));
    r.values.forEach((v) => { expect(v).toBeGreaterThanOrEqual(-1); expect(v).toBeLessThanOrEqual(1); });
    expect(r.values.reduce((s, v) => s + v, 0) / r.values.length).toBeCloseTo(r.mean, 14);
  });
  test('1-NN classifies its own training rows perfectly when rows are distinct', () => {
    const a = args('knn-ekene-wells-k1');
    const r = CL.knnClassify({ X: a.X, y: a.y, Xnew: a.X, k: 1 });
    expect(r.predictions).toEqual(a.y);
  });
  test('a CART tree predicts its own training rows as trainingPredictions; deeper trees fit at least as well', () => {
    const a = args('cart-ekene-depth4-leaf3');
    const t = CL.cartFit(a);
    expect(CL.cartPredict({ model: t, X: a.X }).predictions).toEqual(t.trainingPredictions);
    const d2 = CL.cartFit({ ...a, maxDepth: 2 });
    expect(t.trainingAccuracy).toBeGreaterThanOrEqual(d2.trainingAccuracy);
    expect(t.featureImportances.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
  });
  test('CART is invariant to a monotone rescaling of a feature (same partition)', () => {
    const a = args('cart-ekene-depth4-leaf3');
    const t = CL.cartFit(a);
    const s = CL.cartFit({ ...a, X: a.X.map((r) => [Math.exp(r[0] / 50), ...r.slice(1)]) });
    expect(s.trainingPredictions).toEqual(t.trainingPredictions);
  });
  test('ARI is symmetric and label-name free; matching accuracy equals matched rows over n', () => {
    const a = args('ari-ekene-k4');
    const r1 = CL.adjustedRandIndex(a);
    expect(CL.adjustedRandIndex({ a: a.b, b: a.a }).ari).toBeCloseTo(r1.ari, 14);
    expect(CL.adjustedRandIndex({ a: a.a, b: a.b.map((v) => `c${v}`) }).ari).toBe(r1.ari);
    const m = call(byId('match-ekene-k4-one-to-one'));
    expect(m.report.accuracy).toBe(m.matchedRows / m.yPred.length);
  });
  test('majority matching never matches fewer rows than one-to-one', () => {
    const a = args('match-ekene-k4-one-to-one');
    expect(CL.matchClusters({ ...a, mode: 'majority' }).matchedRows).toBeGreaterThanOrEqual(CL.matchClusters(a).matchedRows);
  });
});

describe('row caps and boundaries', () => {
  const syn = syntheticFacies(3001, 4);
  test('agglomerative: 3,000 rows are clustered, 3,001 refused', () => {
    expect(CL.agglomerative({ X: syn.X.slice(0, 3000), k: 4 }).labels.length).toBe(3000);
    const r = CL.agglomerative({ X: syn.X, k: 4 });
    expect(r.error).toBe('X has 3001 rows, above the 3000 agglomerative clustering accepts (it holds every pairwise distance, n(n - 1)/2 of them): cluster a sample or use kmeans');
  });
  test('silhouette: 10,000 rows in full, 10,001 refused without sampleSize, accepted with it', () => {
    const big = syntheticFacies(10001, 4);
    const lab = big.facies;
    expect(CL.silhouette({ X: big.X.slice(0, 10000), labels: lab.slice(0, 10000) }).n).toBe(10000);
    expect(CL.silhouette({ X: big.X, labels: lab }).error).toBe('X has 10001 rows, above the 10000 the silhouette computes in full (every pair of rows): give sampleSize and seed to score a seeded sample');
    expect(CL.silhouette({ X: big.X, labels: lab, sampleSize: 2000, seed: 1 }).n).toBe(2000);
  });
  test('kNN: 10,000 x 10,000 pairs (the cap, 1e8) are classified, 10,001 x 10,000 refused', () => {
    expect(CL.DEFAULTS.KNN_MAX_PAIRS).toBe(100000000);
    const X = Array.from({ length: 10000 }, (_, i) => [i]);
    const y = X.map((r) => (r[0] % 2 ? 'odd' : 'even'));
    expect(CL.knnClassify({ X, y, Xnew: X, k: 1 }).predictions).toEqual(y);
    expect(CL.knnClassify({ X, y, Xnew: [...X, [0.5]], k: 1 }).error).toBe('Xnew has 10001 rows against 10000 training rows, 100010000 distance pairs, above the 100000000 kNN computes: classify fewer rows at a time or thin the training rows');
  });
});

describe('scale: app-sized inputs (tools/validation/dataai/timing_cluster.mjs has the timing table)', () => {
  // Complexity guards with generous budgets (about 10x a Node 18 run).
  const big = syntheticFacies(50000, 4);
  test('k-means (k = 5, nInit 10) and CART (depth 6) at 50,000 rows', () => {
    const t0 = Date.now();
    const k = CL.kmeans({ X: big.X, k: 5, seed: 1 });
    const t = CL.cartFit({ X: big.X, y: big.facies, maxDepth: 6 });
    expect([k.error, t.error]).toEqual([undefined, undefined]);
    expect(Date.now() - t0).toBeLessThan(30000);
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
    outputs.forEach(([id, r]) => { if (r && !r.error) expect([id, typeof r.basis]).toEqual([id, 'object']); });
  });
  test('bad input returns a structured refusal, never NaN or a throw', () => {
    Object.keys(CL).filter((k) => typeof CL[k] === 'function').forEach((fn) => {
      [undefined, {}, { X: null }, { X: [[NaN]] }, { X: [[1, 'a']] }].forEach((a) => {
        const r = CL[fn](a);
        expect([fn, typeof r.error, typeof r.field]).toEqual([fn, 'string', 'string']);
      });
    });
  });
});
