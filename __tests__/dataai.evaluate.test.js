// Data & AI D5 applied AI evaluation gates. Every case in
// test-data/dataai/goldens/evaluate_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent stdlib oracle
// (tools/validation/dataai/oracle_evaluate.py) computed from the published
// definitions by different roads (Decimal BM25 and TF-IDF, exact Fraction
// metrics, a hand-written claim scanner, exact calibration sums, integer
// mulberry32). The pins in test-data/dataai/pins/evaluate_pins.json are a
// second witness (scikit-learn, numpy). Property tests compare engine
// outputs with each other, never with a restated formula;
// tools/validation/dataai/negcontrol_evaluate.sh proves the gates go red
// when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as EV from '../engines/dataai/evaluate';
import { logLoss } from '../engines/dataai/ml';
import { findPLabels } from '../lib/conventions/percentile';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'dataai', 'goldens', 'evaluate_cases.json');
const PINS = read('test-data', 'dataai', 'pins', 'evaluate_pins.json');
const FIX = (f) => read('test-data', 'dataai', 'ekene-docs', f);
const CORPUS = FIX('corpus.json');
const QUERIES = FIX('queries.json');
const SYSTEMS = FIX('systems.json');
const EXTRACTION = FIX('extraction.json');
const CAL = FIX('calibration.json');
const FLOOR = G.tolerance.absoluteFloor;

const docs = CORPUS.passages.map((p) => ({ id: p.id, text: p.text }));
const queries = QUERIES.queries.map((q) => ({ id: q.id, text: q.text }));
const judgments = Object.fromEntries(QUERIES.queries.map((q) => [q.id, q.judgments]));
const sys = (id) => SYSTEMS.systems.find((s) => s.id === id);
const runsOf = (id) => Object.fromEntries(sys(id).answers.map((a) => [a.query, a.retrieved]));

const get = (obj, dotted) => (dotted === '' ? obj : dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

const diff = (actual, expected, tol, where = '', floor = FLOOR) => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const d = Math.abs(actual - expected);
    return d <= floor || d <= tol * Math.abs(expected) ? [] : [`${where}: ${actual} vs ${expected} (abs ${d}, rel ${d / Math.abs(expected)})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`, floor));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    const extra = Object.keys(actual).filter((k) => !(k in expected) && k !== 'basis');
    const missing = Object.keys(expected).filter((k) => !(k in actual));
    const keyErr = extra.length || missing.length ? [`${where}: keys differ (engine only: ${extra.join(', ')}; oracle only: ${missing.join(', ')})`] : [];
    return keyErr.concat(Object.keys(expected).flatMap((k) => diff(actual[k], expected[k], tol, `${where}.${k}`, floor)));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

const call = (c) => EV[c.fn](JSON.parse(JSON.stringify(c.args)));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from evaluate_cases.json`);
  return c;
};
const args = (id) => JSON.parse(JSON.stringify(byId(id).args));

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('evaluate');
    expect(G.generatedBy).toBe('tools/validation/dataai/oracle_evaluate.py');
    expect(G.cases.length).toBeGreaterThan(250);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden, and refused at least once', () => {
    const fns = Object.keys(EV).filter((k) => typeof EV[k] === 'function');
    expect(fns.length).toBe(16);
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

describe('second witness: scikit-learn / numpy pins', () => {
  test('the pin file names its generator and library versions', () => {
    expect(PINS.generatedBy).toBe('tools/validation/dataai/pin_evaluate.py');
    expect(Object.keys(PINS.versions).sort()).toEqual(['numpy', 'scikit-learn']);
    expect(PINS.pins.length).toBeGreaterThan(100);
  });

  const memo = new Map();
  const once = (id) => { if (!memo.has(id)) memo.set(id, call(byId(id))); return memo.get(id); };
  test.each(PINS.pins.map((p) => [p.id, p]))('%s', (_id, p) => {
    const v = get(once(p.case), p.field);
    expect(diff(v, p.value, p.tol, `${p.case}.${p.field}`, p.abs ?? FLOOR)).toEqual([]);
  });
});

describe('fixtures: synthetic, consistent and wired to the engine', () => {
  test('every fixture file says it is synthetic and names its generator', () => {
    [CORPUS, QUERIES, SYSTEMS, EXTRACTION, CAL].forEach((f) => {
      expect(f.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
      expect(f.generatedBy).toBe('tools/validation/dataai/make_evaluate_fixtures.py');
    });
    expect(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'dataai', 'ekene-docs', 'README.md'), 'utf8')).toMatch(/SYNTHETIC/);
  });
  test('sizes: 60 passages, 24 queries, 30 labelled records, 200 calibration rows', () => {
    expect(CORPUS.passages.length).toBe(60);
    expect(QUERIES.queries.length).toBe(24);
    expect(EXTRACTION.labels.length).toBe(30);
    expect(CAL.rows.length).toBe(200);
  });
  test('no em or en dash in any fixture text', () => {
    ['corpus.json', 'queries.json', 'systems.json', 'extraction.json', 'calibration.json'].forEach((f) => {
      const s = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'dataai', 'ekene-docs', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
  test('figures shared with the Ekene dynamic package agree (pressure, STOIIP, first oil, water cut)', () => {
    const mbal = read('test-data', 'ekene-dynamic', 'mbal.json');
    const field = read('test-data', 'ekene-dynamic', 'field.json');
    const rates = read('test-data', 'ekene-dynamic', 'rates.json');
    const text = (id) => CORPUS.passages.find((p) => p.id === id).text;
    const pFlood = mbal.inputs.production_data.find((r) => r.observation_date === '2023-01-01').pressure_psia;
    expect(text('EKD-018')).toContain(`${Math.round(pFlood).toLocaleString('en-US')} psia`);
    expect(text('EKD-008')).toContain(`${Math.round(field.static.stoiip_stb).toLocaleString('en-US')} stb`);
    rates.wells.forEach((w) => {
      const pid = { 'Ekene-1': 'EKD-001', 'Ekene-3': 'EKD-003', 'Ekene-5': 'EKD-005', 'Ekene-6': 'EKD-006' }[w.name];
      expect(text(pid)).toContain(`came on stream on ${w.start_date} at ${w.planted.qi_bpd} bopd`);
    });
    field.wells.forEach((w, i) => expect(text(`EKD-00${i + 1}`)).toContain(`Top of the Ekene Sand at ${w.top_sand_m} m TVD`));
  });
  test("each system's retrieved lists are the engine's top 5 for its retriever", () => {
    ['A', 'B'].forEach((id) => {
      const s = sys(id);
      const { method, k, ...rest } = s.retriever;
      const r = EV.retrieve({ documents: docs, queries, method, k, ...rest });
      expect(runsOf(id)).toEqual(r.runs);
    });
  });
  test('the second annotator graded exactly the judged pairs', () => {
    QUERIES.queries.forEach((q) => expect(Object.keys(q.secondAnnotator).sort()).toEqual(Object.keys(q.judgments).sort()));
  });
  test('the calibration outcome is the judged grade 2 or more', () => {
    CAL.rows.forEach((r) => expect(r.relevant).toBe((judgments[r.query][r.passage] ?? 0) >= 2 ? 1 : 0));
  });
});

describe('ranking: properties', () => {
  const small = args('bm25-small').documents;
  test('BM25 k1 = 0 scores each document at the sum of the idf of its matched terms', () => {
    const r = EV.rankBm25({ documents: docs, query: 'water cut Ekene-6 injection', k: 20, k1: 0 });
    r.ranking.forEach((x) => {
      const idfs = x.terms.map((t) => r.queryTerms.find((q) => q.term === t.term).idf);
      expect(x.score).toBeCloseTo(idfs.reduce((s, v) => s + v, 0), 12);
    });
  });
  test('BM25 b = 0 ignores document length; b > 0 penalises a longer document', () => {
    const base = [{ id: 'a', text: 'oil rate' }, { id: 'b', text: 'water' }, { id: 'c', text: 'gas' }];
    const padded = [{ id: 'a', text: 'oil rate plus many other unrelated words here' }, base[1], base[2]];
    const s = (d, b) => EV.rankBm25({ documents: d, query: 'oil', b }).ranking[0].score;
    // avgdl changes with the padding; at b = 0 nothing depends on it
    expect(s(padded, 0)).toBe(s(base, 0));
    expect(s(padded, 0.75)).toBeLessThan(s(base, 0.75));
  });
  test('a repeated query word counts once', () => {
    const a = EV.rankBm25({ documents: small, query: 'oil rate' });
    const b = EV.rankBm25({ documents: small, query: 'oil OIL oil rate' });
    expect(b.ranking).toEqual(a.ranking);
  });
  test('ties (equal text) go to the id ascending, and k = 1 reports the tie it cuts', () => {
    const r = EV.rankBm25({ documents: docs, query: 'diesel spill', k: 1 });
    expect(r.ranking.map((x) => x.id)).toEqual(['EKD-046']);
    expect(r.tieAtCutoff).toBe(true);
    const swapped = docs.slice().reverse();
    expect(EV.rankBm25({ documents: swapped, query: 'diesel spill', k: 2 }).ranking.map((x) => x.id)).toEqual(['EKD-046', 'EKD-058']);
    expect(EV.rankTfidf({ documents: swapped, query: 'diesel spill', k: 2 }).ties).toEqual([['EKD-046', 'EKD-058']]);
  });
  test('TF-IDF: every document vector has unit length and the score is the dot product with the query vector', () => {
    const v = EV.tfidfVectors({ documents: docs });
    v.vectors.forEach((d) => expect(Object.values(d.weights).reduce((s, w) => s + w * w, 0)).toBeCloseTo(1, 12));
    const r = EV.rankTfidf({ documents: docs, query: 'reservoir pressure survey', k: 5 });
    r.ranking.forEach((x) => {
      const w = v.vectors.find((d) => d.id === x.id).weights;
      const dot = Object.entries(r.queryVector).reduce((s, [t, q]) => s + q * (w[t] || 0), 0);
      expect(x.score).toBeCloseTo(dot, 12);
    });
  });
  test('retrieve agrees with rankBm25 and rankTfidf query by query', () => {
    const b = EV.retrieve({ documents: docs, queries, method: 'bm25', k: 7 });
    const t = EV.retrieve({ documents: docs, queries, method: 'tfidf', k: 7, sublinearTf: true });
    queries.forEach((q) => {
      expect(b.runs[q.id]).toEqual(EV.rankBm25({ documents: docs, query: q.text, k: 7 }).ranking.map((x) => x.id));
      expect(t.runs[q.id]).toEqual(EV.rankTfidf({ documents: docs, query: q.text, k: 7, sublinearTf: true }).ranking.map((x) => x.id));
    });
  });
  test('the stop list is scikit-learn ENGLISH_STOP_WORDS: 318 words including well, top and fire', () => {
    expect(EV.ENGLISH_STOP_WORDS.length).toBe(318);
    ['well', 'top', 'bottom', 'fire', 'system', 'the'].forEach((w) => expect(EV.ENGLISH_STOP_WORDS).toContain(w));
    expect(EV.tokenize({ text: 'the well top', stopWords: true }).tokens).toEqual([]);
  });
});

describe('retrieval metrics: properties', () => {
  const J = args('met-basic-k5').judgments;
  test('nDCG is 1 on the ideal ranking and below 1 on any other order of the same documents', () => {
    const ideal = Object.keys(J).sort((a, b) => J[b] - J[a] || (a < b ? -1 : 1));
    expect(EV.retrievalMetrics({ ranking: ideal, judgments: J, k: 5 }).ndcg).toBeCloseTo(1, 15);
    expect(EV.retrievalMetrics({ ranking: ideal, judgments: J, k: 5, gain: 'exponential' }).ndcg).toBeCloseTo(1, 15);
    expect(EV.retrievalMetrics({ ranking: ideal.slice().reverse(), judgments: J, k: 5 }).ndcg).toBeLessThan(1);
  });
  test('recall at k reaches 1 once every relevant document is ranked; AP equals precision when all ranked are relevant', () => {
    const r = EV.retrievalMetrics({ ranking: ['a', 'b', 'e', 'd'], judgments: J, k: 4 });
    expect(r.recall).toBe(1);
    expect(r.averagePrecision).toBe(1);
  });
  test('evaluateRetrieval means equal the means of its own per-query values over the included queries', () => {
    const e = EV.evaluateRetrieval({ runs: runsOf('A'), judgments, k: 5 });
    const inc = e.perQuery.filter((r) => r.nRelevant > 0);
    expect(inc.length).toBe(e.nIncluded);
    expect(e.mean.map).toBeCloseTo(inc.reduce((s, r) => s + r.averagePrecision, 0) / inc.length, 14);
    expect(e.excluded).toEqual([{ query: 'Q24', reason: 'no judged document has grade 1 or more' }]);
  });
  test("'zero' keeps the no-relevant query and scores it 0, lowering every mean", () => {
    const ex = EV.evaluateRetrieval({ runs: runsOf('A'), judgments, k: 5 });
    const zr = EV.evaluateRetrieval({ runs: runsOf('A'), judgments, k: 5, noRelevant: 'zero' });
    expect(zr.nIncluded).toBe(ex.nIncluded + 1);
    expect(zr.mean.ndcg).toBeCloseTo((ex.mean.ndcg * ex.nIncluded) / zr.nIncluded, 14);
  });
});

describe('answers, extraction and groundedness: properties', () => {
  test('exact match implies F1 = 1', () => {
    SYSTEMS.systems.forEach((s) => s.answers.forEach((a) => {
      const ref = QUERIES.queries.find((q) => q.id === a.query).reference;
      const m = EV.answerMatch({ prediction: a.short, truth: ref });
      if (m.exactMatch) expect(m.f1).toBe(1);
    }));
  });
  test('extraction outcome counts add up, and precision and recall follow from them', () => {
    ['A', 'B'].forEach((id) => {
      const r = EV.scoreExtraction({ labels: EXTRACTION.labels, predictions: EXTRACTION.predictions[id], fields: EXTRACTION.fields });
      const o = r.overall;
      expect(o.correct + o.wrong + o.missed + o.unsupported).toBe(o.n);
      expect(o.n).toBe(30 * EXTRACTION.fields.length);
      const cf = o.correct - o.correctEmpty;
      expect(o.precision).toBeCloseTo(cf / (cf + o.wrong + o.unsupported), 15);
      expect(o.recall).toBeCloseTo(cf / (cf + o.wrong + o.missed), 15);
      expect(r.perField.reduce((s, f) => s + f.n, 0)).toBe(o.n);
    });
  });
  test('a prediction identical to the labels scores every cell correct', () => {
    const r = EV.scoreExtraction({ labels: EXTRACTION.labels, predictions: EXTRACTION.labels, fields: EXTRACTION.fields });
    expect(r.overall.accuracy).toBe(1);
    expect(r.overall.macroAccuracy).toBe(1);
  });
  test('every supported claim is found in a passage the answer cites and that was retrieved', () => {
    ['A', 'B'].forEach((id) => {
      const g = EV.checkAnswers({ answers: sys(id).answers, documents: docs, runs: runsOf(id) });
      g.perAnswer.forEach((a) => a.claims.filter((c) => c.supported).forEach((c) => {
        const ans = sys(id).answers.find((x) => x.query === a.query);
        c.foundIn.forEach((pid) => { expect(ans.citations).toContain(pid); expect(ans.retrieved).toContain(pid); });
      }));
      expect(g.byKind.number.claims + g.byKind.date.claims + g.byKind.quote.claims).toBe(g.nClaims);
    });
  });
  test('grounded is not correct: system B cites the wrong breakthrough date and the check still supports it', () => {
    const g = EV.checkAnswers({ answers: sys('B').answers, documents: docs, runs: runsOf('B') });
    const q5 = g.perAnswer.find((a) => a.query === 'Q05');
    expect(q5.supportedFraction).toBe(1);
    const ref = QUERIES.queries.find((q) => q.id === 'Q05').reference;
    expect(EV.answerMatch({ prediction: sys('B').answers.find((a) => a.query === 'Q05').short, truth: ref }).exactMatch).toBe(false);
  });
  test('a tolerance can only add support', () => {
    const a = EV.checkAnswers({ answers: sys('B').answers, documents: docs, runs: runsOf('B') });
    const b = EV.checkAnswers({ answers: sys('B').answers, documents: docs, runs: runsOf('B'), numericRelTol: 0.002 });
    expect(b.nSupported).toBeGreaterThan(a.nSupported);
  });
});

describe('agreement and calibration: properties', () => {
  test('kappa is 1 on identical ratings, symmetric in the raters, and weights agree on two labels', () => {
    const a = args('kappa-ekene-none').a; const b = args('kappa-ekene-none').b;
    ['none', 'linear', 'quadratic'].forEach((weights) => {
      expect(EV.cohenKappa({ a, b: a, weights }).kappa).toBe(1);
      expect(EV.cohenKappa({ a, b, weights }).kappa).toBeCloseTo(EV.cohenKappa({ a: b, b: a, weights }).kappa, 14);
    });
    const x = [0, 1, 1, 0, 1, 0, 0]; const y = [0, 1, 0, 0, 1, 1, 0];
    const k0 = EV.cohenKappa({ a: x, b: y }).kappa;
    expect(EV.cohenKappa({ a: x, b: y, weights: 'linear' }).kappa).toBeCloseTo(k0, 14);
    expect(EV.cohenKappa({ a: x, b: y, weights: 'quadratic' }).kappa).toBeCloseTo(k0, 14);
  });
  test('the Murphy decomposition with the within-bin terms closes on every calibration case', () => {
    G.cases.filter((c) => c.fn === 'calibration' && !c.expected.error).forEach((c) => {
      const r = call(c);
      const m = r.murphy;
      expect(Math.abs(r.brier - (m.reliability - m.resolution + m.uncertainty + m.withinBinVariance - m.withinBinCovariance))).toBeLessThan(1e-15);
      expect(Math.abs(m.closure)).toBeLessThan(1e-15);
      expect(r.table.reduce((s, t) => s + t.n, 0)).toBe(r.n);
    });
  });
  test('with one probability value per bin the within-bin terms vanish, and REL is the n-weighted mean of the squared gaps', () => {
    const r = EV.calibration({ yTrue: [0, 1, 1, 0, 1, 1], probabilities: [0.05, 0.3, 0.3, 0.55, 0.8, 0.8] });
    expect(r.murphy.withinBinVariance).toBe(0);
    expect(r.murphy.withinBinCovariance).toBe(0);
    const rel = r.table.filter((t) => t.n).reduce((s, t) => s + t.n * t.gap * t.gap, 0) / r.n;
    expect(r.murphy.reliability).toBeCloseTo(rel, 15);
  });
  test('log loss is ml.js logLoss, imported, and the engine has no second implementation', () => {
    const y = CAL.rows.map((r) => r.relevant); const p = CAL.rows.map((r) => r.probability);
    expect(EV.calibration({ yTrue: y, probabilities: p }).logLoss).toBe(logLoss({ yTrue: y, probabilities: p }).logLoss);
    const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'dataai', 'evaluate.js'), 'utf8');
    expect(src).toMatch(/import \{ logLoss \} from '\.\/ml\.js';/);
    expect(src.includes('Math.random')).toBe(false);
    expect(/Math\.log\(1 - /.test(src)).toBe(false);
    expect(src).toMatch(/import \{ mulberry32, quantile \} from '\.\.\/\.\.\/lib\/stats\/stats\.js';/);
  });
  test('a probability on an edge opens the upper bin: 0.3 is in [0.3, 0.4) and 1.0 in the closed last bin', () => {
    const r = EV.calibration({ yTrue: [0, 1], probabilities: [0.3, 1] });
    expect(r.table[3].n).toBe(1);
    expect(r.table[9].n).toBe(1);
    expect(r.table[9].closedRight).toBe(true);
  });
});

describe('bootstrap: properties', () => {
  const A = args('paired-ndcg5-A-B').a; const B = args('paired-ndcg5-A-B').b;
  test('the paired bootstrap is the bootstrap of the per-query differences with the same seed', () => {
    const p = EV.pairedBootstrap({ a: A, b: B, seed: 9, nBoot: 1500 });
    const d = EV.bootstrapMean({ values: A.map((v, i) => v - B[i]), seed: 9, nBoot: 1500 });
    expect([p.lower, p.upper, p.standardError]).toEqual([d.lower, d.upper, d.standardError]);
  });
  test('pairing narrows the interval on the Ekene systems', () => {
    const p = call(byId('paired-ndcg5-A-B')); const u = call(byId('unpaired-ndcg5-A-B'));
    expect(p.upper - p.lower).toBeLessThan(u.upper - u.lower);
    expect(p.difference).toBe(u.difference);
  });
  test('the same seed repeats; another seed differs; the interval brackets the replicates it came from', () => {
    const a = args('boot-A-ndcg5');
    expect(EV.bootstrapMean(a)).toEqual(EV.bootstrapMean(a));
    expect(EV.bootstrapMean({ ...a, seed: a.seed + 1 }).lower).not.toBe(EV.bootstrapMean(a).lower);
    const r = EV.bootstrapMean(a);
    expect(r.lower).toBeLessThanOrEqual(r.upper);
  });
  test('interval labels are parameter percentiles, never P-labels', () => {
    ['boot-A-ndcg5', 'boot-A-ndcg5-level-0.99', 'paired-ndcg5-A-B'].forEach((id) => {
      const r = call(byId(id));
      expect(findPLabels(Object.values(r.labels).concat(Object.values(r.basis)))).toEqual([]);
      expect(r.labels.lower).toMatch(/^\d+(\.\d+)?th percentile of the bootstrap (mean|difference)$/);
    });
  });
});

describe('basis text: conventions the goldens do not carry', () => {
  test('ranking and tie rule', () => {
    expect(call(byId('bm25-small')).basis.ranking).toBe('documents with a score above 0 ranked by score descending; scores that agree to 12 significant digits tie, and ties go to the document id ascending');
    expect(call(byId('bm25-small')).basis.idf).toBe('ln(1 + (N - df + 0.5) / (df + 0.5)) (Lucene), N = 5');
    expect(call(byId('tfidf-small')).basis.idf).toBe('ln((1 + N) / (1 + df)) + 1, N = 5 (scikit-learn smooth_idf)');
  });
  test('the stop list basis names the oilfield words it removes', () => {
    expect(call(byId('tok-stop')).basis.stopWords).toBe("scikit-learn ENGLISH_STOP_WORDS (318 words, BSD-3-Clause) removed after tokenising; it removes 'well', 'top', 'bottom', 'fire' and 'system'");
  });
  test('calibration bins state the edge rule', () => {
    expect(call(byId('cal-ekene-10')).basis.bins).toBe('10 equal-width bins: p is in bin i when i/10 <= p < (i+1)/10 (edges as computed in double precision), the last bin closed at 1; an empty bin has null means and is skipped');
  });
  test('the no-relevant rule is stated for both modes', () => {
    expect(call(byId('eval-A-k5')).basis.noRelevant).toBe('a query with no judged document at grade 1 or more is excluded from every mean and listed in excluded');
    expect(call(byId('eval-A-k5-zero')).basis.noRelevant).toBe('a query with no judged document at grade 1 or more stays in every mean with each undefined metric scored 0, and is listed in zeroed');
  });
  test('bootstrap basis counts replicates in the singular for one', () => {
    expect(call(byId('boot-one-replicate')).basis.resampling.startsWith('1 replicate of 3 values')).toBe(true);
  });
});

describe('scale: caps', () => {
  test('5,000 documents accepted, 5,001 refused', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, text: `well ${i % 97} oil rate ${i % 13}` }));
    const r = EV.rankBm25({ documents: many, query: 'oil rate 12', k: 10 });
    expect(r.error).toBeUndefined();
    expect(r.ranking.length).toBe(10);
    expect(EV.rankBm25({ documents: many.concat([{ id: 'x', text: 'y' }]), query: 'y' }).error).toBe('documents has 5001 entries, above the 5000 this engine accepts');
  });
});
