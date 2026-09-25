// Timing of engines/dataai/evaluate.js at app sizes (Data & AI D5).
//
//   node tools/validation/dataai/timing_evaluate.mjs
//
// Synthetic corpora built by copying the Ekene passages with a seeded
// word shuffle (mulberry32), so vocabulary and lengths look like the
// fixture. Milliseconds per call, one run; machine dependent.
// FINDINGS-evaluate.md records a run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mulberry32 } from '../../../lib/stats/stats.js';
import * as EV from '../../../engines/dataai/evaluate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '..', 'test-data', 'dataai', 'ekene-docs', f), 'utf8'));
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return [ms, r]; };
const f0 = (v) => v.toFixed(0);

const corpusOf = (n, words = 1) => {
  const base = FIX('corpus.json').passages;
  const rng = mulberry32(20260925);
  return Array.from({ length: n }, (_, i) => {
    const w = base[i % base.length].text.split(' ');
    let t = [];
    for (let r = 0; r < words; r += 1) t = t.concat(w);
    for (let j = t.length - 1; j > 0; j -= 1) { const k = Math.floor(rng() * (j + 1)); [t[j], t[k]] = [t[k], t[j]]; }
    return { id: `D${String(i).padStart(5, '0')}`, text: t.join(' ') };
  });
};

const main = () => {
  console.log(`node ${process.version}`);
  const queries = FIX('queries.json').queries.map((q) => ({ id: q.id, text: q.text }));
  const many = Array.from({ length: 1000 }, (_, i) => ({ id: `q${i}`, text: queries[i % 24].text }));
  console.log(['documents', 'words/doc', 'retrieve bm25 24 q', 'retrieve tfidf 24 q', 'retrieve bm25 1000 q', 'tfidfVectors', 'rankBm25 1 q'].join(' | '));
  [[60, 1], [1000, 1], [5000, 1], [5000, 20]].forEach(([n, rep]) => {
    const docs = corpusOf(n, rep);
    const words = Math.round(docs.reduce((s, d) => s + d.text.split(' ').length, 0) / n);
    const [tb] = time(() => EV.retrieve({ documents: docs, queries, method: 'bm25', k: 10 }));
    const [tt] = time(() => EV.retrieve({ documents: docs, queries, method: 'tfidf', k: 10 }));
    const [tm] = time(() => EV.retrieve({ documents: docs, queries: many, method: 'bm25', k: 10 }));
    const [tv] = time(() => EV.tfidfVectors({ documents: docs }));
    const [t1] = time(() => EV.rankBm25({ documents: docs, query: queries[0].text, k: 10 }));
    console.log([n, words, f0(tb), f0(tt), f0(tm), f0(tv), f0(t1)].join(' | '));
  });
  const docs = corpusOf(5000);
  const S = FIX('systems.json').systems[1];
  const answers = Array.from({ length: 1000 }, (_, i) => ({ ...S.answers[i % 24], query: `q${i}`, citations: [docs[i % 5000].id, docs[(i + 7) % 5000].id] }));
  const runs = Object.fromEntries(answers.map((a) => [a.query, a.citations]));
  const [tg] = time(() => EV.checkAnswers({ answers, documents: docs, runs }));
  console.log(`checkAnswers: 1000 answers over 5000 documents ${f0(tg)} ms`);
  const rng = mulberry32(1);
  const N = 100000;
  const y = Array.from({ length: N }, () => (rng() < 0.3 ? 1 : 0));
  const p = Array.from({ length: N }, () => Math.round(rng() * 100) / 100);
  const [tc] = time(() => EV.calibration({ yTrue: y, probabilities: p, bins: 100 }));
  const a = Array.from({ length: N }, () => Math.floor(rng() * 4));
  const b = a.map((v) => (rng() < 0.7 ? v : Math.floor(rng() * 4)));
  const [tk] = time(() => EV.cohenKappa({ a, b, weights: 'quadratic' }));
  console.log(`calibration 100,000 rows x 100 bins ${f0(tc)} ms; cohenKappa 100,000 pairs ${f0(tk)} ms`);
  const v = Array.from({ length: 10000 }, () => rng());
  [[1000, 2000], [10000, 2000], [10000, 10000]].forEach(([n, B]) => {
    const [t] = time(() => EV.bootstrapMean({ values: v.slice(0, n), nBoot: B, seed: 1 }));
    const [tp] = time(() => EV.pairedBootstrap({ a: v.slice(0, n), b: v.slice(0, n).reverse(), nBoot: B, seed: 1 }));
    console.log(`bootstrap ${n} values x ${B} replicates: mean ${f0(t)} ms, paired ${f0(tp)} ms`);
  });
  const lab = FIX('extraction.json');
  const big = Array.from({ length: 5000 }, (_, i) => ({ ...lab.labels[i % 30], id: `r${i}` }));
  const [te] = time(() => EV.scoreExtraction({ labels: big, predictions: big, fields: lab.fields }));
  console.log(`scoreExtraction 5000 records x 6 fields ${f0(te)} ms`);
};

main();
