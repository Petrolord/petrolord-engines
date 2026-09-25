/**
 * Applied AI evaluation (Data & AI D5): retrieval, extraction, groundedness,
 * agreement, calibration and bootstrap comparison, all deterministic.
 *
 * Pure functions, no I/O, no language model. Every function returns either
 * a result object carrying a `basis` (the method and its conventions, so a
 * course can print the working) or `{ error, field }`, where `field` names
 * the input refused and the message starts with that name and states the
 * exact condition that failed.
 *
 * Conventions, stated once (FINDINGS-evaluate.md has the sources):
 *   tokens      ASCII letters A-Z are lowercased (no other character is
 *               changed), then the text is split on every run of characters
 *               outside [a-z0-9], and empty pieces are dropped. So "1.25"
 *               gives "1" and "25", "Ekene-3" gives "ekene" and "3", and an
 *               accented letter is a separator. No stemming. The optional
 *               stop list is scikit-learn's ENGLISH_STOP_WORDS (318 words,
 *               BSD-3-Clause), OFF by default: it removes "well", "top",
 *               "bottom", "fire" and "system", which carry meaning here.
 *   TF-IDF      scikit-learn TfidfVectorizer defaults: raw counts (or
 *               1 + ln tf with sublinearTf), idf = ln((1 + N) / (1 + df)) + 1,
 *               every document vector scaled to unit Euclidean length; the
 *               query is weighted the same way on the corpus vocabulary
 *               (terms outside it are dropped) and the score is the cosine,
 *               the dot product of the two unit vectors.
 *   BM25        Okapi BM25 with the Lucene idf: for each DISTINCT query term t
 *               found in document d (a repeated query word counts once),
 *               idf(t) x tf (k1 + 1) / (tf + k1 (1 - b + b dl / avgdl)),
 *               idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5)); dl is the
 *               document's token count after the stop list, avgdl the mean
 *               over the corpus. k1 1.2 and b 0.75 by default. b = 0 removes
 *               length normalisation; k1 = 0 scores each matched term at its
 *               idf. Lucene 8 and later drop the (k1 + 1) factor, which
 *               scales every score by 1 / (k1 + 1) and leaves the order.
 *   ranking     only documents that match at least one query term (score
 *               above 0) are ranked. Score descending; two scores TIE when
 *               they agree to 12 significant digits (compared as
 *               Number(score.toPrecision(12))), and ties go to the document
 *               id ascending (UTF-16 code units, JavaScript's < on strings).
 *   metrics     at a cutoff k on one ranked list. Unjudged documents count as
 *               grade 0. Relevant means grade >= relevantGrade (default 1,
 *               the trec_eval default). P@k = relevant in the top k / k
 *               (k even when fewer are ranked). R@k = relevant in the top k
 *               / relevant judged. hit@k = 1 when any relevant is in the top
 *               k. RR = 1 / rank of the first relevant in the top k, else 0.
 *               AP@k = (1 / relevant judged) x sum of P@i at each relevant
 *               rank i <= k. nDCG@k = DCG / IDCG with DCG = sum over ranks
 *               i <= k of gain(grade) / log2(i + 1), gain linear (the grade)
 *               or exponential (2^grade - 1); IDCG is the DCG of all the
 *               query's judged grades sorted descending, top k. The gain uses
 *               every grade; relevantGrade does not apply to nDCG.
 *   no relevant a query with no judged document at grade >= relevantGrade
 *               has recall, AP and nDCG undefined; by default it is EXCLUDED
 *               from every mean and listed with its reason (trec_eval's
 *               default); noRelevant 'zero' keeps it with every undefined
 *               metric scored 0.
 *   answers     SQuAD normalisation: lowercase, drop ASCII punctuation, drop
 *               the words a, an, the, collapse whitespace. Exact match on the
 *               normalised strings; token F1 on their whitespace tokens by
 *               multiset overlap; when either side has no token, F1 is 1 if
 *               both are empty and 0 otherwise (SQuAD 2.0).
 *   extraction  per record and field: correct (match, or both empty),
 *               wrong (both filled, no match), missed (label filled,
 *               prediction empty), unsupported (label empty, prediction
 *               filled). Empty = null, absent or a blank string. Text fields
 *               match by normalised exact match; number fields when
 *               |prediction - label| <= max(absTol, relTol x |label|).
 *   claims      an answer's checkable claims, in text order: quoted spans
 *               (straight or curly double quotes), ISO dates YYYY-MM-DD, and
 *               numbers (digits with optional comma thousands groups and a
 *               decimal part; a leading minus is a sign only after a
 *               non-alphanumeric character; a percent sign is ignored).
 *               Quotes are taken out first, then dates, then numbers are
 *               read. A number directly after a letter, or after - _ or /
 *               that follows a letter or digit, belongs to an identifier
 *               (Ekene-3, EK1-P) and is not a claim. A claim is supported
 *               when it appears in a cited passage that was retrieved: a
 *               number as an equal value (within numericRelTol of the
 *               passage figure), a date as the same date, a quote as the
 *               same run of tokens.
 *   kappa       Cohen's kappa = 1 - sum w O / sum w E, O the observed counts,
 *               E = row total x column total / n, w 0 on the diagonal and 1
 *               off it (unweighted), |i - j| (linear) or (i - j)^2
 *               (quadratic) on the label positions.
 *   calibration equal-width bins on [0, 1]: edges e_i = i / M as computed in
 *               double precision; p is in bin i when e_i <= p < e_(i+1), the
 *               last bin closed at 1. Brier = mean (p - y)^2. ECE = sum over
 *               bins of n_k / N x |observed_k - mean p_k|; MCE the largest
 *               such gap; empty bins skipped. Murphy decomposition with the
 *               within-bin terms (Stephenson, Coelho and Jolliffe 2008):
 *               Brier = REL - RES + UNC + WBV - WBC exactly, their eq. (7)
 *               and the line after it. WBC is the fifth term of eq. (7) as
 *               the paper names it, so it carries the factor 2:
 *               WBC = 2 sum (y - observed_k)(p - mean p_k) / N, twice the
 *               pooled within-bin covariance. Log loss is
 *               engines/dataai/ml.js logLoss, imported.
 *   bootstrap   one mulberry32(seed) stream (lib/stats); replicate by
 *               replicate, each draws n indices floor(u x n) with
 *               replacement. Percentile interval by lib/stats quantile at
 *               (1 - level) / 2 and 1 - (1 - level) / 2; these are
 *               percentiles of a statistic, labelled as parameter
 *               percentiles (lib/conventions/percentile.js), never P-labels.
 *   reasons     figures in messages print as the shortest round-trip decimal.
 *
 * Validation: tools/validation/dataai/oracle_evaluate.py (stdlib python)
 * writes test-data/dataai/goldens/evaluate_cases.json; pin_evaluate.py pins
 * scikit-learn in test-data/dataai/pins/evaluate_pins.json;
 * FINDINGS-evaluate.md, negcontrol_evaluate.sh. Fixtures (synthetic Ekene
 * documents): test-data/dataai/ekene-docs/.
 */

import { mulberry32, quantile } from '../../lib/stats/stats.js';
import { parameterPercentileLabel } from '../../lib/conventions/percentile.js';
import { logLoss } from './ml.js';

export const DEFAULTS = Object.freeze({
  K1: 1.2,
  B: 0.75,
  K: 10,
  RELEVANT_GRADE: 1,
  MAX_GRADE: 10,
  TIE_DIGITS: 12,
  BINS: 10,
  MAX_BINS: 100,
  N_BOOT: 2000,
  MAX_BOOT: 100000,
  LEVEL: 0.95,
  LEVELS: Object.freeze([0.8, 0.9, 0.95, 0.99]),
  MAX_DOCS: 5000,
  MAX_CHARS: 20000,
  MAX_QUERIES: 1000,
  MAX_K: 1000,
  MAX_RECORDS: 5000,
  MAX_FIELDS: 50,
  MAX_ANSWERS: 5000,
  MAX_ROWS: 100000,
  MAX_LABELS: 50,
  MAX_VALUES: 10000,
});

/** scikit-learn 1.9.1 sklearn/feature_extraction/_stop_words.py ENGLISH_STOP_WORDS (BSD-3-Clause; from the Glasgow Information Retrieval Group list), sorted. */
export const ENGLISH_STOP_WORDS = Object.freeze([
  'a', 'about', 'above', 'across', 'after', 'afterwards', 'again', 'against', 'all', 'almost', 'alone', 'along', 'already', 'also',
  'although', 'always', 'am', 'among', 'amongst', 'amoungst', 'amount', 'an', 'and', 'another', 'any', 'anyhow', 'anyone', 'anything',
  'anyway', 'anywhere', 'are', 'around', 'as', 'at', 'back', 'be', 'became', 'because', 'become', 'becomes', 'becoming', 'been', 'before',
  'beforehand', 'behind', 'being', 'below', 'beside', 'besides', 'between', 'beyond', 'bill', 'both', 'bottom', 'but', 'by', 'call', 'can',
  'cannot', 'cant', 'co', 'con', 'could', 'couldnt', 'cry', 'de', 'describe', 'detail', 'do', 'done', 'down', 'due', 'during', 'each', 'eg',
  'eight', 'either', 'eleven', 'else', 'elsewhere', 'empty', 'enough', 'etc', 'even', 'ever', 'every', 'everyone', 'everything',
  'everywhere', 'except', 'few', 'fifteen', 'fifty', 'fill', 'find', 'fire', 'first', 'five', 'for', 'former', 'formerly', 'forty', 'found',
  'four', 'from', 'front', 'full', 'further', 'get', 'give', 'go', 'had', 'has', 'hasnt', 'have', 'he', 'hence', 'her', 'here', 'hereafter',
  'hereby', 'herein', 'hereupon', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'however', 'hundred', 'i', 'ie', 'if', 'in', 'inc',
  'indeed', 'interest', 'into', 'is', 'it', 'its', 'itself', 'keep', 'last', 'latter', 'latterly', 'least', 'less', 'ltd', 'made', 'many',
  'may', 'me', 'meanwhile', 'might', 'mill', 'mine', 'more', 'moreover', 'most', 'mostly', 'move', 'much', 'must', 'my', 'myself', 'name',
  'namely', 'neither', 'never', 'nevertheless', 'next', 'nine', 'no', 'nobody', 'none', 'noone', 'nor', 'not', 'nothing', 'now', 'nowhere',
  'of', 'off', 'often', 'on', 'once', 'one', 'only', 'onto', 'or', 'other', 'others', 'otherwise', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'part', 'per', 'perhaps', 'please', 'put', 'rather', 're', 'same', 'see', 'seem', 'seemed', 'seeming', 'seems', 'serious',
  'several', 'she', 'should', 'show', 'side', 'since', 'sincere', 'six', 'sixty', 'so', 'some', 'somehow', 'someone', 'something',
  'sometime', 'sometimes', 'somewhere', 'still', 'such', 'system', 'take', 'ten', 'than', 'that', 'the', 'their', 'them', 'themselves',
  'then', 'thence', 'there', 'thereafter', 'thereby', 'therefore', 'therein', 'thereupon', 'these', 'they', 'thick', 'thin', 'third',
  'this', 'those', 'though', 'three', 'through', 'throughout', 'thru', 'thus', 'to', 'together', 'too', 'top', 'toward', 'towards',
  'twelve', 'twenty', 'two', 'un', 'under', 'until', 'up', 'upon', 'us', 'very', 'via', 'was', 'we', 'well', 'were', 'what', 'whatever',
  'when', 'whence', 'whenever', 'where', 'whereafter', 'whereas', 'whereby', 'wherein', 'whereupon', 'wherever', 'whether', 'which',
  'while', 'whither', 'who', 'whoever', 'whole', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'yet', 'you', 'your',
  'yours', 'yourself', 'yourselves',
]);
const STOP = new Set(ENGLISH_STOP_WORDS);

/* ------------------------------------------------------------------ */
/* Helpers. */

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => (x === Infinity ? 'infinity' : x === -Infinity ? 'minus infinity' : String(x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const mean = (xs) => { let s = 0; for (let i = 0; i < xs.length; i += 1) s += xs[i]; return s / xs.length; };

const checkBool = (name, v) => (typeof v === 'boolean' ? null : refuse(name, 'must be true or false'));
const checkSeed = (seed) => (isInt(seed) && seed >= 0 && seed <= 4294967295 ? null : refuse('seed', 'must be a whole number from 0 to 4294967295'));
const checkK = (k) => (isInt(k) && k >= 1 && k <= DEFAULTS.MAX_K ? null : refuse('k', `must be a whole number from 1 to ${DEFAULTS.MAX_K}`));
const checkText = (field, s) => {
  if (typeof s !== 'string') return refuse(field, 'must be a string');
  if (s.length > DEFAULTS.MAX_CHARS) return refuse(field, `has ${s.length} characters, above the ${DEFAULTS.MAX_CHARS} this engine accepts`);
  return null;
};

/* ------------------------------------------------------------------ */
/* Tokens. */

const lowerAscii = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const tokensOf = (s, stopWords) => {
  const t = lowerAscii(s).split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  return stopWords ? t.filter((w) => !STOP.has(w)) : t;
};

const TOKEN_BASIS = 'ASCII A-Z lowercased (nothing else changed), split on every run of characters outside [a-z0-9], empty pieces dropped; no stemming';
const stopBasis = (on) => (on ? "scikit-learn ENGLISH_STOP_WORDS (318 words, BSD-3-Clause) removed after tokenising; it removes 'well', 'top', 'bottom', 'fire' and 'system'" : 'no stop list');

/** The tokens of one text, as every ranking function sees them. */
export const tokenize = ({ text, stopWords = false } = {}) => {
  const bad = checkText('text', text) || checkBool('stopWords', stopWords);
  if (bad) return bad;
  const all = tokensOf(text, false);
  const tokens = stopWords ? all.filter((w) => !STOP.has(w)) : all;
  return { tokens, count: tokens.length, removed: all.length - tokens.length, basis: { tokens: TOKEN_BASIS, stopWords: stopBasis(stopWords) } };
};

/* ------------------------------------------------------------------ */
/* The corpus index. */

const checkDocuments = (documents) => {
  if (!Array.isArray(documents) || documents.length === 0) return refuse('documents', 'must be a non-empty array of { id, text }');
  if (documents.length > DEFAULTS.MAX_DOCS) return refuse('documents', `has ${documents.length} entries, above the ${DEFAULTS.MAX_DOCS} this engine accepts`);
  const seen = new Map();
  for (let i = 0; i < documents.length; i += 1) {
    const d = documents[i];
    if (!isObj(d)) return refuse(`documents[${i}]`, 'must be an object { id, text }');
    if (typeof d.id !== 'string' || d.id.length === 0) return refuse(`documents[${i}].id`, 'must be a non-empty string');
    if (seen.has(d.id)) return refuse(`documents[${i}].id`, `repeats ${d.id} (documents[${seen.get(d.id)}])`);
    seen.set(d.id, i);
    const b = checkText(`documents[${i}].text`, d.text);
    if (b) return b;
  }
  return null;
};

/** Token lists, counts, df and postings; refuses a corpus with no token. */
const buildIndex = (documents, stopWords) => {
  const ids = documents.map((d) => d.id);
  const toks = documents.map((d) => tokensOf(d.text, stopWords));
  const tf = toks.map((t) => { const m = new Map(); t.forEach((w) => m.set(w, (m.get(w) || 0) + 1)); return m; });
  const df = new Map();
  const postings = new Map();
  tf.forEach((m, i) => m.forEach((c, w) => {
    df.set(w, (df.get(w) || 0) + 1);
    if (!postings.has(w)) postings.set(w, []);
    postings.get(w).push(i);
  }));
  const lengths = toks.map((t) => t.length);
  const total = lengths.reduce((s, v) => s + v, 0);
  return { ids, tf, df, postings, lengths, total, N: ids.length };
};

const emptyCorpus = (stopWords, what) => refuse('documents', `has no token in any text${stopWords ? ' after the stop list' : ''}: ${what}`);

const queryTerms = (text, stopWords) => {
  const seen = new Set(); const out = [];
  tokensOf(text, stopWords).forEach((w) => { if (!seen.has(w)) { seen.add(w); out.push(w); } });
  return out;
};

/* ------------------------------------------------------------------ */
/* Ranking. */

const tieKey = (s) => Number(s.toPrecision(DEFAULTS.TIE_DIGITS));

/** Ranks the documents with score > 0; returns the top k and the tie record. */
const rankOf = (ids, scores, k) => {
  const idx = [];
  for (let i = 0; i < scores.length; i += 1) if (scores[i] > 0) idx.push(i);
  const key = new Map(idx.map((i) => [i, tieKey(scores[i])]));
  idx.sort((a, b) => (key.get(b) - key.get(a)) || cmpStr(ids[a], ids[b]));
  const top = idx.slice(0, k);
  const ties = [];
  let j = 0;
  while (j < top.length) {
    let e = j + 1;
    while (e < top.length && key.get(top[e]) === key.get(top[j])) e += 1;
    if (e - j > 1) ties.push(top.slice(j, e).map((i) => ids[i]));
    j = e;
  }
  const tieAtCutoff = idx.length > k && key.get(idx[k]) === key.get(idx[k - 1]);
  return { order: top, matched: idx.length, ties, tieAtCutoff };
};

const RANK_BASIS = 'documents with a score above 0 ranked by score descending; scores that agree to 12 significant digits tie, and ties go to the document id ascending';

/* ------------------------------------------------------------------ */
/* BM25. */

const bm25Setup = (index, k1, b) => {
  const avgdl = index.total / index.N;
  const idf = (w) => { const d = index.df.get(w) || 0; return Math.log(1 + (index.N - d + 0.5) / (d + 0.5)); };
  return { avgdl, idf };
};

const bm25Score = (index, setup, terms, k1, b) => {
  const scores = new Float64Array(index.N);
  terms.forEach((w) => {
    const post = index.postings.get(w);
    if (!post) return;
    const idf = setup.idf(w);
    post.forEach((i) => {
      const f = index.tf[i].get(w);
      scores[i] += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.lengths[i]) / setup.avgdl));
    });
  });
  return scores;
};

const bm25Explain = (index, setup, terms, k1, b, i) => terms.filter((w) => index.tf[i].has(w)).map((w) => {
  const f = index.tf[i].get(w);
  const idf = setup.idf(w);
  return { term: w, tf: f, df: index.df.get(w), idf, contribution: (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.lengths[i]) / setup.avgdl)) };
});

const checkBm25Params = (k1, b) => {
  if (!(isNum(k1) && k1 >= 0)) return refuse('k1', 'must be a finite number, 0 or more (0 scores each matched term at its idf)');
  if (!(isNum(b) && b >= 0 && b <= 1)) return refuse('b', 'must be a number from 0 to 1 (0 removes length normalisation)');
  return null;
};

const bm25Basis = (k1, b, N, avgdl, stopWords) => ({
  tokens: TOKEN_BASIS,
  stopWords: stopBasis(stopWords),
  score: `sum over the distinct query terms found in the document of idf x tf (k1 + 1) / (tf + k1 (1 - b + b dl / avgdl)), k1 = ${fmt(k1)}, b = ${fmt(b)}; a repeated query word counts once`,
  idf: `ln(1 + (N - df + 0.5) / (df + 0.5)) (Lucene), N = ${N}`,
  avgdl: `mean token count over the ${plural(N, 'document')} = ${fmt(avgdl)}`,
  ranking: RANK_BASIS,
});

/** Okapi BM25 ranking of the documents for one query, with each term's contribution. */
export const rankBm25 = ({ documents, query, k = DEFAULTS.K, k1 = DEFAULTS.K1, b = DEFAULTS.B, stopWords = false } = {}) => {
  const bad = checkDocuments(documents) || checkText('query', query) || checkK(k) || checkBm25Params(k1, b) || checkBool('stopWords', stopWords);
  if (bad) return bad;
  const index = buildIndex(documents, stopWords);
  if (index.total === 0) return emptyCorpus(stopWords, 'BM25 needs an average document length above 0');
  const setup = bm25Setup(index, k1, b);
  const terms = queryTerms(query, stopWords);
  const scores = bm25Score(index, setup, terms, k1, b);
  const r = rankOf(index.ids, scores, k);
  const out = {
    method: 'bm25', k, k1, b, stopWords, N: index.N, avgdl: setup.avgdl,
    queryTerms: terms.map((w) => ({ term: w, df: index.df.get(w) || 0, idf: setup.idf(w) })),
    ranking: r.order.map((i, j) => ({ rank: j + 1, id: index.ids[i], score: scores[i], length: index.lengths[i], terms: bm25Explain(index, setup, terms, k1, b, i) })),
    matched: r.matched, ties: r.ties, tieAtCutoff: r.tieAtCutoff,
    basis: bm25Basis(k1, b, index.N, setup.avgdl, stopWords),
  };
  if (!terms.length) out.note = `the query has no token${stopWords ? ' after the stop list' : ''}, so no document is ranked`;
  else if (!r.matched) out.note = 'no document contains a query term, so no document is ranked';
  return out;
};

/* ------------------------------------------------------------------ */
/* TF-IDF. */

const tfidfSetup = (index, sublinearTf) => {
  const vocabulary = [...index.df.keys()].sort(cmpStr);
  const idf = new Map(vocabulary.map((w) => [w, Math.log((1 + index.N) / (1 + index.df.get(w))) + 1]));
  const tw = (f) => (sublinearTf ? 1 + Math.log(f) : f);
  const vectors = index.tf.map((m) => {
    const terms = [...m.keys()].sort(cmpStr);
    let ss = 0;
    const raw = terms.map((w) => { const v = tw(m.get(w)) * idf.get(w); ss += v * v; return v; });
    const norm = Math.sqrt(ss);
    const weights = new Map();
    terms.forEach((w, j) => weights.set(w, raw[j] / norm));
    return { weights, norm };
  });
  return { vocabulary, idf, vectors, tw };
};

const tfidfQuery = (setup, text, stopWords) => {
  const counts = new Map();
  tokensOf(text, stopWords).forEach((w) => { if (setup.idf.has(w)) counts.set(w, (counts.get(w) || 0) + 1); });
  const terms = [...counts.keys()].sort(cmpStr);
  let ss = 0;
  const raw = terms.map((w) => { const v = setup.tw(counts.get(w)) * setup.idf.get(w); ss += v * v; return v; });
  const norm = Math.sqrt(ss);
  return { terms, weights: new Map(terms.map((w, j) => [w, raw[j] / norm])), counts };
};

const tfidfScore = (index, setup, q) => {
  const scores = new Float64Array(index.N);
  q.terms.forEach((w) => {
    const qw = q.weights.get(w);
    index.postings.get(w).forEach((i) => { scores[i] += qw * setup.vectors[i].weights.get(w); });
  });
  return scores;
};

const tfidfBasis = (N, sublinearTf, stopWords) => ({
  tokens: TOKEN_BASIS,
  stopWords: stopBasis(stopWords),
  tf: sublinearTf ? '1 + ln(tf) (sublinear)' : 'raw count',
  idf: `ln((1 + N) / (1 + df)) + 1, N = ${N} (scikit-learn smooth_idf)`,
  norm: 'each vector scaled to unit Euclidean length (l2)',
  score: 'cosine: the dot product of the unit query and document vectors; query terms outside the corpus vocabulary are dropped',
  ranking: RANK_BASIS,
});

const checkCorpusArgs = (documents, stopWords, sublinearTf) => checkDocuments(documents) || checkBool('stopWords', stopWords) || checkBool('sublinearTf', sublinearTf);

/** The TF-IDF document vectors (scikit-learn TfidfVectorizer defaults). */
export const tfidfVectors = ({ documents, stopWords = false, sublinearTf = false } = {}) => {
  const bad = checkCorpusArgs(documents, stopWords, sublinearTf);
  if (bad) return bad;
  const index = buildIndex(documents, stopWords);
  if (index.total === 0) return emptyCorpus(stopWords, 'the vocabulary is empty');
  const s = tfidfSetup(index, sublinearTf);
  return {
    N: index.N,
    vocabulary: s.vocabulary,
    df: s.vocabulary.map((w) => index.df.get(w)),
    idf: s.vocabulary.map((w) => s.idf.get(w)),
    vectors: index.ids.map((id, i) => ({ id, length: index.lengths[i], norm: s.vectors[i].norm, weights: Object.fromEntries(s.vectors[i].weights) })),
    basis: tfidfBasis(index.N, sublinearTf, stopWords),
  };
};

/** TF-IDF cosine ranking of the documents for one query. */
export const rankTfidf = ({ documents, query, k = DEFAULTS.K, stopWords = false, sublinearTf = false } = {}) => {
  const bad = checkCorpusArgs(documents, stopWords, sublinearTf) || checkText('query', query) || checkK(k);
  if (bad) return bad;
  const index = buildIndex(documents, stopWords);
  if (index.total === 0) return emptyCorpus(stopWords, 'the vocabulary is empty');
  const s = tfidfSetup(index, sublinearTf);
  const q = tfidfQuery(s, query, stopWords);
  const scores = tfidfScore(index, s, q);
  const r = rankOf(index.ids, scores, k);
  const all = queryTerms(query, stopWords);
  const out = {
    method: 'tfidf', k, stopWords, sublinearTf, N: index.N,
    queryVector: Object.fromEntries(q.weights),
    droppedTerms: all.filter((w) => !s.idf.has(w)),
    ranking: r.order.map((i, j) => ({ rank: j + 1, id: index.ids[i], score: scores[i], terms: q.terms.filter((w) => s.vectors[i].weights.has(w)).map((w) => ({ term: w, query: q.weights.get(w), document: s.vectors[i].weights.get(w) })) })),
    matched: r.matched, ties: r.ties, tieAtCutoff: r.tieAtCutoff,
    basis: tfidfBasis(index.N, sublinearTf, stopWords),
  };
  if (!all.length) out.note = `the query has no token${stopWords ? ' after the stop list' : ''}, so no document is ranked`;
  else if (!q.terms.length) out.note = 'no query term is in the corpus vocabulary, so no document is ranked';
  return out;
};

const METHODS = ['bm25', 'tfidf'];

/** Ranks every query against one index; `runs` maps query id to the ranked ids. */
export const retrieve = ({ documents, queries, method, k = DEFAULTS.K, k1: k1In, b: bIn, stopWords = false, sublinearTf } = {}) => {
  if (!METHODS.includes(method)) return refuse('method', "must be 'bm25' or 'tfidf'");
  let bad = checkDocuments(documents) || checkK(k) || checkBool('stopWords', stopWords);
  if (bad) return bad;
  const k1 = k1In === undefined ? DEFAULTS.K1 : k1In;
  const b = bIn === undefined ? DEFAULTS.B : bIn;
  if (method === 'bm25') bad = checkBm25Params(k1, b) || (sublinearTf !== undefined ? refuse('sublinearTf', "applies to 'tfidf' only") : null);
  else bad = (k1In !== undefined ? refuse('k1', "applies to 'bm25' only") : bIn !== undefined ? refuse('b', "applies to 'bm25' only") : null) || (sublinearTf === undefined ? null : checkBool('sublinearTf', sublinearTf));
  if (bad) return bad;
  if (!Array.isArray(queries) || queries.length === 0) return refuse('queries', 'must be a non-empty array of { id, text }');
  if (queries.length > DEFAULTS.MAX_QUERIES) return refuse('queries', `has ${queries.length} entries, above the ${DEFAULTS.MAX_QUERIES} this engine accepts`);
  const seen = new Map();
  for (let i = 0; i < queries.length; i += 1) {
    const q = queries[i];
    if (!isObj(q)) return refuse(`queries[${i}]`, 'must be an object { id, text }');
    if (typeof q.id !== 'string' || q.id.length === 0) return refuse(`queries[${i}].id`, 'must be a non-empty string');
    if (seen.has(q.id)) return refuse(`queries[${i}].id`, `repeats ${q.id} (queries[${seen.get(q.id)}])`);
    seen.set(q.id, i);
    const bt = checkText(`queries[${i}].text`, q.text);
    if (bt) return bt;
  }
  const index = buildIndex(documents, stopWords);
  if (index.total === 0) return emptyCorpus(stopWords, method === 'bm25' ? 'BM25 needs an average document length above 0' : 'the vocabulary is empty');
  let scoreOf;
  let basis;
  if (method === 'bm25') {
    const setup = bm25Setup(index, k1, b);
    scoreOf = (text) => bm25Score(index, setup, queryTerms(text, stopWords), k1, b);
    basis = bm25Basis(k1, b, index.N, setup.avgdl, stopWords);
  } else {
    const s = tfidfSetup(index, sublinearTf === true);
    scoreOf = (text) => tfidfScore(index, s, tfidfQuery(s, text, stopWords));
    basis = tfidfBasis(index.N, sublinearTf === true, stopWords);
  }
  const perQuery = queries.map((q) => {
    const scores = scoreOf(q.text);
    const r = rankOf(index.ids, scores, k);
    return { id: q.id, ranking: r.order.map((i, j) => ({ rank: j + 1, id: index.ids[i], score: scores[i] })), matched: r.matched, ties: r.ties, tieAtCutoff: r.tieAtCutoff };
  });
  const out = { method, k, stopWords, runs: Object.fromEntries(perQuery.map((p) => [p.id, p.ranking.map((x) => x.id)])), perQuery, basis };
  if (method === 'bm25') { out.k1 = k1; out.b = b; } else out.sublinearTf = sublinearTf === true;
  return out;
};

/* ------------------------------------------------------------------ */
/* Retrieval metrics. */

const GAINS = ['linear', 'exponential'];
const gainOf = (gain) => (gain === 'linear' ? (g) => g : (g) => 2 ** g - 1);

const checkGrades = (field, j) => {
  if (!isObj(j)) return refuse(field, 'must be an object mapping document id to grade');
  const keys = Object.keys(j);
  for (let i = 0; i < keys.length; i += 1) {
    const g = j[keys[i]];
    if (!(isInt(g) && g >= 0 && g <= DEFAULTS.MAX_GRADE)) return refuse(`${field}.${keys[i]}`, `must be a whole-number grade from 0 to ${DEFAULTS.MAX_GRADE}`);
  }
  return null;
};

const checkRanking = (field, r) => {
  if (!Array.isArray(r)) return refuse(field, 'must be an array of document ids, best first');
  const seen = new Map();
  for (let i = 0; i < r.length; i += 1) {
    if (typeof r[i] !== 'string' || r[i].length === 0) return refuse(`${field}[${i}]`, 'must be a non-empty string');
    if (seen.has(r[i])) return refuse(`${field}[${i}]`, `repeats ${r[i]} (${field}[${seen.get(r[i])}]): a document is ranked once`);
    seen.set(r[i], i);
  }
  return null;
};

const checkMetricArgs = (k, relevantGrade, gain) => {
  const bk = checkK(k);
  if (bk) return bk;
  if (!(isInt(relevantGrade) && relevantGrade >= 1 && relevantGrade <= DEFAULTS.MAX_GRADE)) return refuse('relevantGrade', `must be a whole number from 1 to ${DEFAULTS.MAX_GRADE}`);
  if (!GAINS.includes(gain)) return refuse('gain', "must be 'linear' or 'exponential'");
  return null;
};

const metricsCore = (ranking, judgments, k, t, gain) => {
  const G = gainOf(gain);
  const grades = Object.values(judgments);
  const nJudged = grades.length;
  const nRel = grades.filter((g) => g >= t).length;
  const top = ranking.slice(0, k);
  let hits = 0; let apSum = 0; let first = null; let dcg = 0; let unjudged = 0;
  top.forEach((id, j) => {
    const i = j + 1;
    const judged = own(judgments, id);
    if (!judged) unjudged += 1;
    const g = judged ? judgments[id] : 0;
    if (g >= t) { hits += 1; apSum += hits / i; if (first === null) first = i; }
    dcg += G(g) / Math.log2(i + 1);
  });
  const ideal = grades.slice().sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((g, j) => { idcg += G(g) / Math.log2(j + 2); });
  const notes = {};
  if (nRel === 0) {
    const why = `no judged document has grade ${t} or more`;
    notes.recall = `recall is undefined: ${why}`;
    notes.averagePrecision = `average precision is undefined: ${why}`;
  }
  if (idcg === 0) {
    notes.ndcg = nJudged === 0
      ? 'nDCG is undefined: the query has no judged documents, so the ideal DCG is 0'
      : `nDCG is undefined: ${nJudged === 1 ? 'the 1 judged document has' : `the ${nJudged} judged documents all have`} grade 0, so the ideal DCG is 0`;
  }
  return {
    k, nJudged, nRelevant: nRel, retrieved: top.length, relevantRetrieved: hits, unjudgedRetrieved: unjudged,
    precision: hits / k,
    recall: nRel ? hits / nRel : null,
    hit: hits > 0 ? 1 : 0,
    firstRelevantRank: first,
    reciprocalRank: first === null ? 0 : 1 / first,
    averagePrecision: nRel ? apSum / nRel : null,
    dcg, idcg,
    ndcg: idcg > 0 ? dcg / idcg : null,
    notes,
  };
};

const metricsBasis = (k, t, gain) => ({
  relevant: `grade >= ${t}; unjudged documents count as grade 0`,
  precision: `relevant in the top ${k} / ${k} (${k} even when fewer are ranked)`,
  recall: `relevant in the top ${k} / relevant judged`,
  hit: `1 when a relevant document is in the top ${k}, else 0`,
  reciprocalRank: `1 / rank of the first relevant document in the top ${k}, 0 when there is none`,
  averagePrecision: `(1 / relevant judged) x sum of precision at each relevant rank up to ${k}`,
  ndcg: `DCG / ideal DCG at ${k}; DCG = sum of gain / log2(rank + 1), gain ${gain === 'linear' ? 'the grade (linear)' : '2^grade - 1 (exponential)'}; the ideal ranks every judged grade descending; the gain uses every grade`,
});

/** Precision, recall, hit, RR, AP and nDCG at k for one ranked list. */
export const retrievalMetrics = ({ ranking, judgments, k = DEFAULTS.K, relevantGrade = DEFAULTS.RELEVANT_GRADE, gain = 'linear' } = {}) => {
  const bad = checkRanking('ranking', ranking) || checkGrades('judgments', judgments) || checkMetricArgs(k, relevantGrade, gain);
  if (bad) return bad;
  const r = metricsCore(ranking, judgments, k, relevantGrade, gain);
  if (!Object.keys(r.notes).length) delete r.notes;
  return { ...r, relevantGrade, gain, basis: metricsBasis(k, relevantGrade, gain) };
};

const MEAN_KEYS = [['precision', 'precision'], ['recall', 'recall'], ['hitRate', 'hit'], ['mrr', 'reciprocalRank'], ['map', 'averagePrecision'], ['ndcg', 'ndcg']];

/**
 * Per-query metrics and their means over queries. `judgments` maps query id
 * to { document id: grade }; `runs` maps query id to its ranked ids.
 */
export const evaluateRetrieval = ({ runs, judgments, k = DEFAULTS.K, relevantGrade = DEFAULTS.RELEVANT_GRADE, gain = 'linear', noRelevant = 'exclude' } = {}) => {
  if (!isObj(judgments) || Object.keys(judgments).length === 0) return refuse('judgments', 'must be a non-empty object mapping query id to { document id: grade }');
  if (!isObj(runs)) return refuse('runs', 'must be an object mapping query id to an array of document ids');
  const qids = Object.keys(judgments).sort(cmpStr);
  if (qids.length > DEFAULTS.MAX_QUERIES) return refuse('judgments', `has ${qids.length} queries, above the ${DEFAULTS.MAX_QUERIES} this engine accepts`);
  let bad = checkMetricArgs(k, relevantGrade, gain);
  if (bad) return bad;
  if (noRelevant !== 'exclude' && noRelevant !== 'zero') return refuse('noRelevant', "must be 'exclude' or 'zero'");
  for (let i = 0; i < qids.length; i += 1) {
    bad = checkGrades(`judgments.${qids[i]}`, judgments[qids[i]]);
    if (bad) return bad;
    if (!own(runs, qids[i])) return refuse('runs', `has no ranking for query ${qids[i]} (every judged query needs one; an empty array is a ranking that retrieved nothing)`);
    bad = checkRanking(`runs.${qids[i]}`, runs[qids[i]]);
    if (bad) return bad;
  }
  const extra = Object.keys(runs).sort(cmpStr).find((q) => !own(judgments, q));
  if (extra !== undefined) return refuse(`runs.${extra}`, 'has no judgments: every ranked query needs judgments');
  const perQuery = qids.map((q) => {
    const r = metricsCore(runs[q], judgments[q], k, relevantGrade, gain);
    if (!Object.keys(r.notes).length) delete r.notes;
    return { query: q, ...r };
  });
  const excluded = [];
  const used = [];
  perQuery.forEach((r) => {
    if (r.nRelevant === 0) {
      excluded.push({ query: r.query, reason: `no judged document has grade ${relevantGrade} or more` });
      if (noRelevant === 'zero') used.push(r);
    } else used.push(r);
  });
  const zeroed = (v) => (v === null ? 0 : v);
  const means = {};
  MEAN_KEYS.forEach(([name, key]) => { means[name] = used.length ? mean(used.map((r) => zeroed(r[key]))) : null; });
  const out = {
    k, relevantGrade, gain, noRelevant,
    nQueries: qids.length,
    nIncluded: used.length,
    perQuery,
    mean: means,
    excluded: noRelevant === 'exclude' ? excluded : [],
    zeroed: noRelevant === 'zero' ? excluded : [],
    basis: {
      ...metricsBasis(k, relevantGrade, gain),
      order: 'queries in id order (UTF-16 code units)',
      mean: `arithmetic mean over the ${noRelevant === 'exclude' ? 'included queries' : 'queries'}: mrr is the mean reciprocal rank, map the mean average precision, hitRate the mean hit`,
      noRelevant: noRelevant === 'exclude'
        ? `a query with no judged document at grade ${relevantGrade} or more is excluded from every mean and listed in excluded`
        : `a query with no judged document at grade ${relevantGrade} or more stays in every mean with each undefined metric scored 0, and is listed in zeroed`,
    },
  };
  if (!used.length) out.note = `no query has a judged document at grade ${relevantGrade} or more, so every mean is null`;
  return out;
};

/* ------------------------------------------------------------------ */
/* Answers and extraction. */

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const normalizeCore = (s) => {
  let t = s.toLowerCase();
  let o = '';
  for (let i = 0; i < t.length; i += 1) if (!PUNCT.has(t[i])) o += t[i];
  t = o.replace(/\b(a|an|the)\b/g, ' ');
  return t.split(/\s+/).filter((w) => w.length > 0).join(' ');
};
const ntokens = (s) => (s === '' ? [] : s.split(' '));

const f1Of = (pt, tt) => {
  if (pt.length === 0 || tt.length === 0) return { f1: pt.length === tt.length ? 1 : 0, precision: null, recall: null, common: 0 };
  const c = new Map();
  tt.forEach((w) => c.set(w, (c.get(w) || 0) + 1));
  let common = 0;
  pt.forEach((w) => { const n = c.get(w) || 0; if (n > 0) { common += 1; c.set(w, n - 1); } });
  if (common === 0) return { f1: 0, precision: 0, recall: 0, common };
  const p = common / pt.length; const r = common / tt.length;
  return { f1: (2 * p * r) / (p + r), precision: p, recall: r, common };
};

const ANSWER_BASIS = {
  normalize: 'SQuAD: lowercase, drop ASCII punctuation, replace the words a, an, the by a space, collapse whitespace',
  exactMatch: 'the normalised strings are equal',
  f1: 'token F1 on the normalised whitespace tokens by multiset overlap: precision = common / prediction tokens, recall = common / truth tokens; when either side has no token, 1 if both are empty and 0 otherwise (SQuAD 2.0)',
};

/** The SQuAD normalisation of one string. */
export const normalizeAnswer = ({ text } = {}) => {
  const bad = checkText('text', text);
  if (bad) return bad;
  const normalized = normalizeCore(text);
  return { normalized, tokens: ntokens(normalized), basis: { normalize: ANSWER_BASIS.normalize } };
};

/** SQuAD exact match and token F1 of one predicted answer against the truth. */
export const answerMatch = ({ prediction, truth } = {}) => {
  const bad = checkText('prediction', prediction) || checkText('truth', truth);
  if (bad) return bad;
  const np = normalizeCore(prediction); const nt = normalizeCore(truth);
  const f = f1Of(ntokens(np), ntokens(nt));
  return { exactMatch: np === nt, f1: f.f1, precision: f.precision, recall: f.recall, commonTokens: f.common, normalizedPrediction: np, normalizedTruth: nt, basis: ANSWER_BASIS };
};

const NUMBER_STRING = /^-?\d+(?:,\d{3})*(?:\.\d+)?$/;
const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const FIELD_TYPES = ['text', 'number'];

const checkFields = (fields) => {
  if (!Array.isArray(fields) || fields.length === 0) return refuse('fields', 'must be a non-empty array of { name, type }');
  if (fields.length > DEFAULTS.MAX_FIELDS) return refuse('fields', `has ${fields.length} entries, above the ${DEFAULTS.MAX_FIELDS} this engine accepts`);
  const seen = new Map();
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (!isObj(f)) return refuse(`fields[${i}]`, 'must be an object { name, type }');
    if (typeof f.name !== 'string' || f.name.length === 0) return refuse(`fields[${i}].name`, 'must be a non-empty string');
    if (seen.has(f.name)) return refuse(`fields[${i}].name`, `repeats ${f.name} (fields[${seen.get(f.name)}])`);
    seen.set(f.name, i);
    if (!FIELD_TYPES.includes(f.type)) return refuse(`fields[${i}].type`, "must be 'text' or 'number'");
    for (const t of ['absTol', 'relTol']) {
      if (f[t] === undefined) continue;
      if (f.type !== 'number') return refuse(`fields[${i}].${t}`, "applies to 'number' fields only");
      if (!(isNum(f[t]) && f[t] >= 0)) return refuse(`fields[${i}].${t}`, 'must be a finite number, 0 or more');
    }
  }
  return null;
};

const checkRecords = (name, recs, fields, labelled) => {
  if (!Array.isArray(recs)) return refuse(name, 'must be an array of { id, fields }');
  if (recs.length > DEFAULTS.MAX_RECORDS) return refuse(name, `has ${recs.length} records, above the ${DEFAULTS.MAX_RECORDS} this engine accepts`);
  const seen = new Map();
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i];
    if (!isObj(r)) return refuse(`${name}[${i}]`, 'must be an object { id, fields }');
    if (typeof r.id !== 'string' || r.id.length === 0) return refuse(`${name}[${i}].id`, 'must be a non-empty string');
    if (seen.has(r.id)) return refuse(`${name}[${i}].id`, `repeats ${r.id} (${name}[${seen.get(r.id)}])`);
    seen.set(r.id, i);
    if (labelled && !labelled.has(r.id)) return refuse(`${name}[${i}].id`, `is ${r.id}, which is not a labelled record`);
    if (!isObj(r.fields)) return refuse(`${name}[${i}].fields`, 'must be an object mapping field name to value');
    const names = Object.keys(r.fields);
    for (let j = 0; j < names.length; j += 1) {
      const f = fields.find((x) => x.name === names[j]);
      if (!f) return refuse(`${name}[${i}].fields.${names[j]}`, 'is not one of the fields');
      const v = r.fields[names[j]];
      if (isEmpty(v)) continue;
      if (f.type === 'text' && typeof v !== 'string') return refuse(`${name}[${i}].fields.${names[j]}`, 'must be a string or empty');
      if (f.type === 'number') {
        if (!labelled && !isNum(v)) return refuse(`${name}[${i}].fields.${names[j]}`, 'must be a finite number or empty');
        if (labelled && !isNum(v) && typeof v !== 'string') return refuse(`${name}[${i}].fields.${names[j]}`, 'must be a number, a string or empty');
      }
    }
  }
  return null;
};

const numberFrom = (v) => (typeof v === 'number' ? v : NUMBER_STRING.test(v.trim()) ? Number(v.trim().replace(/,/g, '')) : null);

const scoreCell = (f, label, pred) => {
  const le = isEmpty(label); const pe = isEmpty(pred);
  const cell = { label: le ? null : label, prediction: pe ? null : pred };
  if (le && pe) return { ...cell, outcome: 'correct', empty: true, ...(f.type === 'text' ? { f1: 1 } : {}) };
  if (pe) return { ...cell, outcome: 'missed', reason: 'the label has a value and the prediction is empty', ...(f.type === 'text' ? { f1: 0 } : {}) };
  if (le) return { ...cell, outcome: 'unsupported', reason: 'the label is empty and the prediction has a value', ...(f.type === 'text' ? { f1: 0 } : {}) };
  if (f.type === 'text') {
    const np = normalizeCore(pred); const nl = normalizeCore(label);
    const fm = f1Of(ntokens(np), ntokens(nl));
    if (np === nl) return { ...cell, outcome: 'correct', f1: fm.f1 };
    return { ...cell, outcome: 'wrong', f1: fm.f1, reason: `normalised "${np}" differs from "${nl}"` };
  }
  const x = numberFrom(pred);
  if (x === null) return { ...cell, outcome: 'wrong', reason: `"${pred}" is not a plain number (digits with optional comma thousands groups and a decimal part)` };
  const tol = Math.max(f.absTol || 0, (f.relTol || 0) * Math.abs(label));
  const d = Math.abs(x - label);
  if (d <= tol) return { ...cell, outcome: 'correct', difference: d };
  return { ...cell, outcome: 'wrong', difference: d, reason: `${fmt(x)} differs from ${fmt(label)} by ${fmt(d)}, above the tolerance ${fmt(tol)}` };
};

const OUTCOMES = ['correct', 'wrong', 'missed', 'unsupported'];
const f1PR = (p, r) => {
  if (p === null && r === null) return null;
  const pp = p === null ? 0 : p; const rr = r === null ? 0 : r;
  return pp + rr === 0 ? 0 : (2 * pp * rr) / (pp + rr);
};
const macroOf = (xs) => { const v = xs.filter((x) => x !== null); return v.length ? mean(v) : null; };

/**
 * Scores extracted field values against labels. `fields` lists
 * { name, type: 'text' | 'number', absTol?, relTol? }; `labels` and
 * `predictions` are [{ id, fields: { name: value } }]. A labelled record
 * with no prediction is scored as all empty.
 */
export const scoreExtraction = ({ labels, predictions, fields } = {}) => {
  let bad = checkFields(fields);
  if (bad) return bad;
  bad = checkRecords('labels', labels, fields, null);
  if (bad) return bad;
  if (labels.length === 0) return refuse('labels', 'must hold at least 1 labelled record');
  bad = checkRecords('predictions', predictions, fields, new Set(labels.map((r) => r.id)));
  if (bad) return bad;
  const pmap = new Map(predictions.map((p) => [p.id, p.fields]));
  const cells = [];
  const perRecord = labels.map((l) => {
    const pf = pmap.get(l.id) || {};
    const row = { id: l.id, predicted: pmap.has(l.id), fields: {} };
    fields.forEach((f) => {
      const c = scoreCell(f, l.fields[f.name], pf[f.name]);
      row.fields[f.name] = c;
      cells.push({ field: f.name, ...c });
    });
    return row;
  });
  const tally = (cs) => {
    const t = Object.fromEntries(OUTCOMES.map((o) => [o, cs.filter((c) => c.outcome === o).length]));
    const correctFilled = cs.filter((c) => c.outcome === 'correct' && !c.empty).length;
    const predFilled = correctFilled + t.wrong + t.unsupported;
    const labFilled = correctFilled + t.wrong + t.missed;
    const precision = predFilled ? correctFilled / predFilled : null;
    const recall = labFilled ? correctFilled / labFilled : null;
    return {
      n: cs.length, ...t, correctEmpty: t.correct - correctFilled,
      accuracy: t.correct / cs.length,
      precision, recall, f1: f1PR(precision, recall),
    };
  };
  const perField = fields.map((f) => {
    const cs = cells.filter((c) => c.field === f.name);
    const out = { field: f.name, type: f.type, ...tally(cs) };
    if (f.type === 'text') out.meanF1 = mean(cs.map((c) => c.f1));
    if (f.type === 'number') { out.absTol = f.absTol || 0; out.relTol = f.relTol || 0; }
    return out;
  });
  const overall = tally(cells);
  return {
    nRecords: labels.length,
    nPredicted: predictions.length,
    perRecord,
    perField,
    overall: { ...overall, microAccuracy: overall.accuracy, macroAccuracy: mean(perField.map((f) => f.accuracy)), microF1: overall.f1, macroF1: macroOf(perField.map((f) => f.f1)) },
    basis: {
      outcomes: 'correct: the values match, or both are empty; wrong: both have a value and they do not match; missed: the label has a value and the prediction is empty; unsupported: the label is empty and the prediction has a value. Empty is null, absent or a blank string',
      text: `${ANSWER_BASIS.normalize}; a match is exact equality of the normalised strings; f1 is SQuAD token F1`,
      number: 'the prediction is a number or a string of digits with optional comma thousands groups and a decimal part; it matches when |prediction - label| <= max(absTol, relTol x |label|)',
      accuracy: 'correct / cells; microAccuracy pools every cell, macroAccuracy is the mean of the per-field accuracies (every labelled record is scored on every field, so the two are equal)',
      f1: 'f1 = 2 precision recall / (precision + recall) on filled cells, a missing precision or recall counting as 0, and 0 when both are 0; null when no cell of that field is filled on either side; microF1 pools every cell, macroF1 is the mean of the per-field f1 that are not null',
      precision: 'correct filled cells / cells with a predicted value (wrong, unsupported and correct filled)',
      recall: 'correct filled cells / cells with a label value (wrong, missed and correct filled)',
    },
  };
};

/* ------------------------------------------------------------------ */
/* Groundedness. */

const QUOTE_RE = /["“]([^"“”]*)["”]/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const NUM_RE = /\d+(?:,\d{3}(?!\d))*(?:\.\d+)?/g;
const isAlnum = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);
const isAlpha = (c) => c !== undefined && /[A-Za-z]/.test(c);

const blank = (s, a, e) => s.slice(0, a) + ' '.repeat(e - a) + s.slice(e);

/** Dates and numbers of a text (quotes already blanked where wanted). */
const scanFigures = (text) => {
  let s = text;
  const out = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text)) !== null) {
    const a = m.index; const e = a + m[0].length;
    if (isAlnum(text[a - 1]) || isAlnum(text[e])) continue;
    out.push({ kind: 'date', text: m[0], value: m[0], start: a });
    s = blank(s, a, e);
  }
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(s)) !== null) {
    const a = m.index;
    const p = s[a - 1];
    if (isAlpha(p)) continue;
    if ((p === '-' || p === '_' || p === '/') && isAlnum(s[a - 2])) continue;
    const neg = p === '-' && !isAlnum(s[a - 2]);
    const v = Number(m[0].replace(/,/g, ''));
    out.push({ kind: 'number', text: neg ? `-${m[0]}` : m[0], value: neg ? -v : v, start: neg ? a - 1 : a });
  }
  return out;
};

const claimsOf = (text) => {
  let s = text;
  const out = [];
  let m;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(text)) !== null) {
    const toks = tokensOf(m[1], false);
    if (toks.length) out.push({ kind: 'quote', text: m[1], value: toks.join(' '), start: m.index });
    s = blank(s, m.index, m.index + m[0].length);
  }
  return out.concat(scanFigures(s)).sort((x, y) => x.start - y.start);
};

const passageFacts = (text) => {
  const figs = scanFigures(text);
  return { numbers: figs.filter((f) => f.kind === 'number').map((f) => f.value), dates: new Set(figs.filter((f) => f.kind === 'date').map((f) => f.value)), tokens: tokensOf(text, false) };
};

const hasRun = (hay, needle) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

const inPassage = (claim, facts, relTol) => {
  if (claim.kind === 'date') return facts.dates.has(claim.value);
  if (claim.kind === 'quote') return hasRun(facts.tokens, claim.value.split(' '));
  return facts.numbers.some((v) => Math.abs(claim.value - v) <= relTol * Math.abs(v));
};

const listIds = (ids) => (ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`);
const describe = (c) => (c.kind === 'quote' ? `the quote "${c.text}"` : c.kind === 'date' ? `the date ${c.text}` : `the number ${c.text}${c.text.replace(/^-/, '').replace(/,/g, '') !== fmt(Math.abs(c.value)) ? ` (${fmt(c.value)})` : ''}`);

/** One answer's claims against its cited passages. */
const groundCore = (text, citations, factsById, retrievedSet, relTol) => {
  const cites = [];
  const seenCite = new Set();
  citations.forEach((id) => { if (!seenCite.has(id)) { seenCite.add(id); cites.push(id); } });
  const citationStatus = cites.map((id) => ({ id, status: !factsById.has(id) ? 'unknown' : retrievedSet && !retrievedSet.has(id) ? 'notRetrieved' : 'ok' }));
  const eligible = citationStatus.filter((c) => c.status === 'ok').map((c) => c.id);
  const citedNotRetrieved = citationStatus.filter((c) => c.status === 'notRetrieved').map((c) => c.id);
  const claims = claimsOf(text).map((c) => {
    const foundIn = eligible.filter((id) => inPassage(c, factsById.get(id), relTol));
    const out = { kind: c.kind, text: c.text, value: c.value, supported: foundIn.length > 0, foundIn };
    if (out.supported) return out;
    let reason;
    if (!cites.length) reason = `${describe(c)} is unsupported: the answer cites no passage`;
    else if (!eligible.length) reason = `${describe(c)} is unsupported: no cited passage is ${retrievedSet ? 'a retrieved passage of the corpus' : 'in the corpus'}`;
    else reason = `${describe(c)} is not in the cited passage${eligible.length === 1 ? '' : 's'} ${listIds(eligible)}`;
    const cnr = citedNotRetrieved.filter((id) => inPassage(c, factsById.get(id), relTol));
    const elsewhere = [...factsById.keys()].filter((id) => !seenCite.has(id) && inPassage(c, factsById.get(id), relTol)).sort(cmpStr);
    const inRetrieved = retrievedSet ? elsewhere.filter((id) => retrievedSet.has(id)) : [];
    if (cnr.length) reason += `; it appears in ${listIds(cnr)}, cited but not retrieved`;
    if (inRetrieved.length) reason += `; it appears in retrieved ${inRetrieved.length === 1 ? 'passage' : 'passages'} ${listIds(inRetrieved)}, which the answer does not cite`;
    if (!cnr.length && !inRetrieved.length) {
      const where = `${elsewhere.length === 1 ? 'passage' : 'passages'} ${listIds(elsewhere)}`;
      if (!elsewhere.length) reason += '; it appears in no passage of the corpus';
      else if (retrievedSet) reason += `; it appears only in ${where}, neither cited nor retrieved`;
      else reason += `; it appears in ${where}, which the answer does not cite`;
    }
    return { ...out, reason };
  });
  const nSupported = claims.filter((c) => c.supported).length;
  const flags = citationStatus.filter((c) => c.status !== 'ok').map((c) => (c.status === 'unknown' ? `citation ${c.id} is not a passage of the corpus` : `citation ${c.id} was not retrieved for this query`));
  const r = { claims, nClaims: claims.length, nSupported, supportedFraction: claims.length ? nSupported / claims.length : null, citations: citationStatus, flags };
  if (!claims.length) r.note = 'the answer has no checkable claim (no quote, date or number), so the supported fraction is undefined';
  return r;
};

const GROUND_BASIS = (relTol, withRetrieved) => ({
  claims: 'quoted spans (straight or curly double quotes) first, then ISO dates YYYY-MM-DD, then numbers: digits with optional comma thousands groups and a decimal part, a leading minus only after a non-alphanumeric character, a percent sign ignored; a number directly after a letter, or after - _ or / that follows a letter or digit, is part of an identifier and not a claim; every occurrence is a claim',
  support: `a claim is supported when it appears in a cited passage${withRetrieved ? ' that was retrieved' : ''}: a number as a value within ${fmt(relTol)} x |passage value| of a passage number${relTol === 0 ? ' (equal)' : ''}, a date as the same date, a quote as the same run of tokens (${TOKEN_BASIS})`,
  citations: withRetrieved ? 'a citation that is not a passage of the corpus is flagged unknown; one that was not retrieved for the query is flagged notRetrieved and supports nothing' : 'a citation that is not a passage of the corpus is flagged unknown; no retrieved list was given, so every cited passage of the corpus can support a claim',
  fraction: 'supported claims / claims; undefined for an answer with no claim',
});

const checkRelTol = (v) => (isNum(v) && v >= 0 && v < 1 ? null : refuse('numericRelTol', 'must be a number from 0 (inclusive) to 1 (exclusive)'));

const checkCitations = (field, c) => {
  if (!Array.isArray(c)) return refuse(field, 'must be an array of passage ids');
  for (let i = 0; i < c.length; i += 1) if (typeof c[i] !== 'string' || c[i].length === 0) return refuse(`${field}[${i}]`, 'must be a non-empty string');
  return null;
};

const factsOf = (documents) => new Map(documents.map((d) => [d.id, passageFacts(d.text)]));

/**
 * The deterministic hallucination check for one answer: its quotes, dates
 * and numbers against the passages it cites (retrieved ones only, when
 * `retrieved` is given).
 */
export const checkGroundedness = ({ answer, citations, documents, retrieved, numericRelTol = 0 } = {}) => {
  const bad = checkText('answer', answer) || checkCitations('citations', citations) || checkDocuments(documents) || (retrieved === undefined ? null : checkRanking('retrieved', retrieved)) || checkRelTol(numericRelTol);
  if (bad) return bad;
  const r = groundCore(answer, citations, factsOf(documents), retrieved === undefined ? null : new Set(retrieved), numericRelTol);
  return { ...r, numericRelTol, basis: GROUND_BASIS(numericRelTol, retrieved !== undefined) };
};

/**
 * Groundedness over a set of answers [{ query, text, citations }]; `runs`
 * (query id to retrieved ids) is optional, and when given every answer's
 * query must have one.
 */
export const checkAnswers = ({ answers, documents, runs, numericRelTol = 0 } = {}) => {
  let bad = checkDocuments(documents) || checkRelTol(numericRelTol);
  if (bad) return bad;
  if (!Array.isArray(answers) || answers.length === 0) return refuse('answers', 'must be a non-empty array of { query, text, citations }');
  if (answers.length > DEFAULTS.MAX_ANSWERS) return refuse('answers', `has ${answers.length} entries, above the ${DEFAULTS.MAX_ANSWERS} this engine accepts`);
  if (runs !== undefined && !isObj(runs)) return refuse('runs', 'must be an object mapping query id to an array of document ids');
  const seen = new Map();
  for (let i = 0; i < answers.length; i += 1) {
    const a = answers[i];
    if (!isObj(a)) return refuse(`answers[${i}]`, 'must be an object { query, text, citations }');
    if (typeof a.query !== 'string' || a.query.length === 0) return refuse(`answers[${i}].query`, 'must be a non-empty string');
    if (seen.has(a.query)) return refuse(`answers[${i}].query`, `repeats ${a.query} (answers[${seen.get(a.query)}]): one answer per query`);
    seen.set(a.query, i);
    bad = checkText(`answers[${i}].text`, a.text) || checkCitations(`answers[${i}].citations`, a.citations);
    if (bad) return bad;
    if (runs !== undefined) {
      if (!own(runs, a.query)) return refuse('runs', `has no retrieved list for query ${a.query} (answers[${i}])`);
      bad = checkRanking(`runs.${a.query}`, runs[a.query]);
      if (bad) return bad;
    }
  }
  const facts = factsOf(documents);
  const perAnswer = answers.map((a) => ({ query: a.query, ...groundCore(a.text, a.citations, facts, runs === undefined ? null : new Set(runs[a.query]), numericRelTol) }));
  const nClaims = perAnswer.reduce((s, r) => s + r.nClaims, 0);
  const nSupported = perAnswer.reduce((s, r) => s + r.nSupported, 0);
  const withClaims = perAnswer.filter((r) => r.nClaims > 0);
  const byKind = Object.fromEntries(['number', 'date', 'quote'].map((kd) => {
    const cs = perAnswer.flatMap((r) => r.claims.filter((c) => c.kind === kd));
    return [kd, { claims: cs.length, supported: cs.filter((c) => c.supported).length }];
  }));
  const out = {
    nAnswers: answers.length,
    nClaims,
    nSupported,
    supportedFraction: nClaims ? nSupported / nClaims : null,
    meanAnswerSupportedFraction: withClaims.length ? mean(withClaims.map((r) => r.supportedFraction)) : null,
    fullySupportedAnswers: withClaims.filter((r) => r.nSupported === r.nClaims).length,
    answersWithClaims: withClaims.length,
    unknownCitations: perAnswer.reduce((s, r) => s + r.citations.filter((c) => c.status === 'unknown').length, 0),
    notRetrievedCitations: perAnswer.reduce((s, r) => s + r.citations.filter((c) => c.status === 'notRetrieved').length, 0),
    byKind,
    perAnswer,
    numericRelTol,
    basis: {
      ...GROUND_BASIS(numericRelTol, runs !== undefined),
      pooled: 'supportedFraction pools every claim of every answer; meanAnswerSupportedFraction averages the answers that have at least one claim',
    },
  };
  if (!nClaims) out.note = 'no answer has a checkable claim, so the supported fractions are undefined';
  return out;
};

/* ------------------------------------------------------------------ */
/* Agreement. */

const WEIGHTS = ['none', 'linear', 'quadratic'];

/** Cohen's kappa of two raters, unweighted or linear / quadratic weighted. */
export const cohenKappa = ({ a, b, labels, weights = 'none' } = {}) => {
  if (!Array.isArray(a) || a.length === 0) return refuse('a', 'must be a non-empty array of ratings');
  if (a.length > DEFAULTS.MAX_ROWS) return refuse('a', `has ${a.length} ratings, above the ${DEFAULTS.MAX_ROWS} this engine accepts`);
  if (!Array.isArray(b) || b.length !== a.length) return refuse('b', `must be an array of ${plural(a.length, 'rating')}, one per item of a`);
  if (!WEIGHTS.includes(weights)) return refuse('weights', "must be 'none', 'linear' or 'quadratic'");
  const kind = typeof a[0];
  if (!((kind === 'number' && isNum(a[0])) || (kind === 'string' && a[0].length > 0))) return refuse('a[0]', 'must be a finite number or a non-empty string');
  const okRating = (v) => (kind === 'number' ? isNum(v) : typeof v === 'string' && v.length > 0);
  for (const [nm, arr] of [['a', a], ['b', b]]) {
    for (let i = 0; i < arr.length; i += 1) if (!okRating(arr[i])) return refuse(`${nm}[${i}]`, `must be a ${kind === 'number' ? 'finite number' : 'non-empty string'}, like a[0]`);
  }
  let L;
  if (labels === undefined) {
    if (kind === 'string' && weights !== 'none') return refuse('labels', `must be given in order for ${weights} weights on string ratings (the weights use the label positions)`);
    L = [...new Set([...a, ...b])].sort(kind === 'number' ? (x, y) => x - y : cmpStr);
    if (L.length > DEFAULTS.MAX_LABELS) return refuse('a', `and b use ${L.length} distinct labels, above the ${DEFAULTS.MAX_LABELS} this engine accepts`);
  } else {
    if (!Array.isArray(labels) || labels.length < 1) return refuse('labels', 'must be a non-empty array of the labels in order');
    if (labels.length > DEFAULTS.MAX_LABELS) return refuse('labels', `has ${labels.length} entries, above the ${DEFAULTS.MAX_LABELS} this engine accepts`);
    for (let i = 0; i < labels.length; i += 1) {
      if (!okRating(labels[i])) return refuse(`labels[${i}]`, `must be a ${kind === 'number' ? 'finite number' : 'non-empty string'}, like the ratings`);
      if (labels.indexOf(labels[i]) !== i) return refuse(`labels[${i}]`, `repeats ${labels[i]}`);
    }
    L = labels;
    for (const [nm, arr] of [['a', a], ['b', b]]) {
      const i = arr.findIndex((v) => !L.includes(v));
      if (i >= 0) return refuse(`${nm}[${i}]`, `is ${arr[i]}, which is not one of labels`);
    }
  }
  const m = L.length; const n = a.length;
  const pos = new Map(L.map((v, i) => [v, i]));
  const O = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i += 1) O[pos.get(a[i])][pos.get(b[i])] += 1;
  const row = O.map((r) => r.reduce((s, v) => s + v, 0));
  const col = L.map((_, j) => O.reduce((s, r) => s + r[j], 0));
  const w = (i, j) => (weights === 'none' ? (i === j ? 0 : 1) : weights === 'linear' ? Math.abs(i - j) : (i - j) ** 2);
  let num = 0; let den = 0; let agree = 0; let pe = 0;
  for (let i = 0; i < m; i += 1) {
    agree += O[i][i];
    pe += (row[i] * col[i]) / (n * n);
    for (let j = 0; j < m; j += 1) { num += w(i, j) * O[i][j]; den += (w(i, j) * row[i] * col[j]) / n; }
  }
  const out = {
    n, labels: L, weights, confusion: O, rowTotals: row, columnTotals: col,
    observedAgreement: agree / n,
    expectedAgreement: pe,
    observedDisagreement: num / n,
    expectedDisagreement: den / n,
    kappa: den === 0 ? null : 1 - num / den,
    basis: {
      kappa: '1 - sum w O / sum w E, O the observed counts (rows rater a, columns rater b), E = row total x column total / n',
      weights: weights === 'none' ? 'w = 0 on the diagonal and 1 off it (unweighted)' : weights === 'linear' ? 'w = |i - j| on the label positions (linear)' : 'w = (i - j)^2 on the label positions (quadratic)',
      labels: labels === undefined ? `the distinct ratings sorted ${kind === 'number' ? 'ascending' : 'by UTF-16 code units'}` : 'as given, in order',
      agreement: 'observedAgreement = diagonal / n and expectedAgreement = sum row x column / n^2, both unweighted',
    },
  };
  if (den === 0) out.note = `kappa is undefined: both raters gave every item the same label (${L[row.findIndex((v) => v > 0)]}), so the expected disagreement is 0`;
  return out;
};

/* ------------------------------------------------------------------ */
/* Calibration. */

const binOf = (p, M) => {
  let i = Math.min(M - 1, Math.floor(p * M));
  if (i > 0 && p < i / M) i -= 1;
  else if (i < M - 1 && p >= (i + 1) / M) i += 1;
  return i;
};

/**
 * Brier score, reliability table, ECE, MCE, the Murphy decomposition with
 * the within-bin terms, and log loss (engines/dataai/ml.js) for binary
 * outcomes and predicted probabilities.
 */
export const calibration = ({ yTrue, probabilities, bins = DEFAULTS.BINS, eps } = {}) => {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return refuse('yTrue', 'must be a non-empty array of 0 and 1 outcomes');
  if (yTrue.length > DEFAULTS.MAX_ROWS) return refuse('yTrue', `has ${yTrue.length} rows, above the ${DEFAULTS.MAX_ROWS} this engine accepts`);
  for (let i = 0; i < yTrue.length; i += 1) if (yTrue[i] !== 0 && yTrue[i] !== 1) return refuse(`yTrue[${i}]`, 'must be 0 or 1');
  if (!Array.isArray(probabilities) || probabilities.length !== yTrue.length) return refuse('probabilities', `must be an array of ${plural(yTrue.length, 'number')}, one per outcome`);
  for (let i = 0; i < probabilities.length; i += 1) {
    const v = probabilities[i];
    if (!(isNum(v) && v >= 0 && v <= 1)) return refuse(`probabilities[${i}]`, 'must be a number from 0 to 1');
  }
  if (!(isInt(bins) && bins >= 1 && bins <= DEFAULTS.MAX_BINS)) return refuse('bins', `must be a whole number from 1 to ${DEFAULTS.MAX_BINS}`);
  const ll = logLoss(eps === undefined ? { yTrue, probabilities } : { yTrue, probabilities, eps });
  if (ll.error) return ll;
  const N = yTrue.length; const M = bins;
  const idx = probabilities.map((p) => binOf(p, M));
  const members = Array.from({ length: M }, () => []);
  idx.forEach((k, j) => members[k].push(j));
  let brier = 0;
  for (let j = 0; j < N; j += 1) { const d = probabilities[j] - yTrue[j]; brier += d * d; }
  brier /= N;
  const obar = mean(yTrue);
  let rel = 0; let res = 0; let wbv = 0; let wbc = 0; let ece = 0; let mce = 0;
  const table = members.map((js, k) => {
    const lower = k / M; const upper = (k + 1) / M;
    const row = { bin: k, lower, upper, closedRight: k === M - 1, n: js.length };
    if (!js.length) return { ...row, meanPredicted: null, observedFrequency: null, gap: null };
    const pk = mean(js.map((j) => probabilities[j]));
    const ok = mean(js.map((j) => yTrue[j]));
    const gap = Math.abs(ok - pk);
    rel += js.length * (pk - ok) ** 2;
    res += js.length * (ok - obar) ** 2;
    js.forEach((j) => { wbv += (probabilities[j] - pk) ** 2; wbc += (yTrue[j] - ok) * (probabilities[j] - pk); });
    ece += (js.length / N) * gap;
    if (gap > mce) mce = gap;
    return { ...row, meanPredicted: pk, observedFrequency: ok, gap };
  });
  const reliability = rel / N; const resolution = res / N; const uncertainty = obar * (1 - obar);
  const withinBinVariance = wbv / N; const withinBinCovariance = (2 * wbc) / N;
  const sum = reliability - resolution + uncertainty + withinBinVariance - withinBinCovariance;
  return {
    n: N, bins: M, baseRate: obar, brier,
    logLoss: ll.logLoss, logLossEps: ll.eps, logLossClipped: ll.clipped,
    table, ece, mce,
    murphy: { reliability, resolution, uncertainty, withinBinVariance, withinBinCovariance, sum, closure: brier - sum },
    basis: {
      bins: `${M} equal-width bins: p is in bin i when i/${M} <= p < (i+1)/${M} (edges as computed in double precision), the last bin closed at 1; an empty bin has null means and is skipped`,
      brier: 'mean (p - y)^2',
      ece: 'sum over non-empty bins of n_k / N x |observed_k - mean p_k|',
      mce: 'the largest |observed_k - mean p_k| over non-empty bins',
      murphy: 'Brier = REL - RES + UNC + WBV - WBC (Stephenson, Coelho and Jolliffe 2008, eq. 7): REL = sum n_k (mean p_k - observed_k)^2 / N, RES = sum n_k (observed_k - base rate)^2 / N, UNC = base rate (1 - base rate), WBV = sum (p - mean p_k)^2 / N, WBC = 2 sum (y - observed_k)(p - mean p_k) / N (the fifth term of their eq. 7, so twice the pooled within-bin covariance); closure = Brier - that sum (0 up to rounding)',
      logLoss: `engines/dataai/ml.js logLoss: ${ll.basis.formula}; ${ll.basis.clipping}`,
    },
  };
};

/* ------------------------------------------------------------------ */
/* Bootstrap. */

const checkBoot = (nBoot, seed, level) => {
  if (!(isInt(nBoot) && nBoot >= 1 && nBoot <= DEFAULTS.MAX_BOOT)) return refuse('nBoot', `must be a whole number from 1 to ${DEFAULTS.MAX_BOOT}`);
  const bs = checkSeed(seed);
  if (bs) return bs;
  if (!DEFAULTS.LEVELS.includes(level)) return refuse('level', 'must be 0.8, 0.9, 0.95 or 0.99');
  return null;
};

const checkValues = (field, v, n) => {
  if (!Array.isArray(v)) return refuse(field, 'must be an array of numbers');
  if (v.length > DEFAULTS.MAX_VALUES) return refuse(field, `has ${v.length} values, above the ${DEFAULTS.MAX_VALUES} this engine accepts`);
  if (n !== undefined && v.length !== n) return refuse(field, `must have ${plural(n, 'value')}, one per value of a (the same queries in the same order)`);
  for (let i = 0; i < v.length; i += 1) if (!isNum(v[i])) return refuse(`${field}[${i}]`, 'must be a finite number');
  if (v.length < 2) return refuse(field, `has ${plural(v.length, 'value')}: the bootstrap resamples at least 2`);
  return null;
};

const tails = (level) => { const lo = Math.round(((1 - level) / 2) * 1e12) / 1e12; return [lo, Math.round((1 - lo) * 1e12) / 1e12]; };

const interval = (reps, level, what) => {
  const [lo, hi] = tails(level);
  const [lower, upper] = quantile(Array.from(reps), [lo, hi]);
  const B = reps.length;
  let s = 0; for (let i = 0; i < B; i += 1) s += reps[i];
  const m = s / B;
  let ss = 0; for (let i = 0; i < B; i += 1) ss += (reps[i] - m) ** 2;
  return {
    lower, upper,
    standardError: B > 1 ? Math.sqrt(ss / (B - 1)) : null,
    labels: { lower: parameterPercentileLabel(what, 100 * lo), upper: parameterPercentileLabel(what, 100 * hi) },
    tails: [lo, hi],
  };
};

const pctBasis = (nBoot, level) => {
  const [lo, hi] = tails(level);
  return `lib/stats quantile at ${fmt(lo)} and ${fmt(hi)} of the ${plural(nBoot, 'replicate')} (idx = nBoot x p on the sorted values: idx not whole takes the ceil(idx)-th smallest, idx whole with nBoot even the mean of the idx-th and (idx+1)-th, idx whole with nBoot odd the (idx+1)-th); a percentile interval of a statistic, labelled as parameter percentiles, never P-labels; standardError is the SD of the replicates with divisor nBoot - 1`;
};

/** Percentile bootstrap interval of the mean of `values` (per-query scores, say). */
export const bootstrapMean = ({ values, nBoot = DEFAULTS.N_BOOT, seed, level = DEFAULTS.LEVEL } = {}) => {
  const bad = checkValues('values', values) || checkBoot(nBoot, seed, level);
  if (bad) return bad;
  const n = values.length;
  const rng = mulberry32(seed);
  const reps = new Float64Array(nBoot);
  for (let r = 0; r < nBoot; r += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += values[Math.floor(rng() * n)];
    reps[r] = s / n;
  }
  const iv = interval(reps, level, 'the bootstrap mean');
  const out = {
    n, mean: mean(values), nBoot, seed, level,
    lower: iv.lower, upper: iv.upper, standardError: iv.standardError, labels: iv.labels,
    basis: {
      resampling: `${plural(nBoot, 'replicate')} of ${n} values drawn with replacement (index floor(u x ${n}), u from one mulberry32(${seed}) stream, replicate by replicate); each replicate's statistic is its mean`,
      interval: pctBasis(nBoot, level),
    },
  };
  if (nBoot === 1) out.note = 'one replicate: the standard error is undefined';
  return out;
};

/**
 * Bootstrap of mean(a) - mean(b) for two systems scored on the same queries.
 * Paired (default): each replicate resamples query positions once and uses
 * them for both systems, so it is the bootstrap of the mean of a - b.
 * Unpaired: each replicate draws n positions for a, then n for b.
 */
export const pairedBootstrap = ({ a, b, nBoot = DEFAULTS.N_BOOT, seed, level = DEFAULTS.LEVEL, paired = true } = {}) => {
  const bad = checkValues('a', a) || checkValues('b', b, Array.isArray(a) ? a.length : undefined) || checkBoot(nBoot, seed, level) || checkBool('paired', paired);
  if (bad) return bad;
  const n = a.length;
  const d = a.map((v, i) => v - b[i]);
  const rng = mulberry32(seed);
  const reps = new Float64Array(nBoot);
  let atOrBelow = 0;
  for (let r = 0; r < nBoot; r += 1) {
    let v;
    if (paired) {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += d[Math.floor(rng() * n)];
      v = s / n;
    } else {
      let sa = 0; let sb = 0;
      for (let i = 0; i < n; i += 1) sa += a[Math.floor(rng() * n)];
      for (let i = 0; i < n; i += 1) sb += b[Math.floor(rng() * n)];
      v = sa / n - sb / n;
    }
    reps[r] = v;
    if (v <= 0) atOrBelow += 1;
  }
  const iv = interval(reps, level, 'the bootstrap difference');
  const out = {
    n, meanA: mean(a), meanB: mean(b), difference: mean(d), paired, nBoot, seed, level,
    lower: iv.lower, upper: iv.upper, standardError: iv.standardError, labels: iv.labels,
    shareAtOrBelowZero: atOrBelow / nBoot,
    basis: {
      difference: 'mean(a) - mean(b), computed as the mean of the per-query differences a - b',
      resampling: paired
        ? `${plural(nBoot, 'replicate')}; each draws ${n} query positions with replacement (index floor(u x ${n}), u from one mulberry32(${seed}) stream, replicate by replicate) and averages a - b at those positions, so both systems see the same queries`
        : `${plural(nBoot, 'replicate')}; each draws ${n} positions for a and then ${n} for b, independently (index floor(u x ${n}), one mulberry32(${seed}) stream), and takes mean a - mean b; this ignores that the systems answered the same queries`,
      interval: pctBasis(nBoot, level),
      share: 'the share of replicates with a difference at or below 0 (a does not beat b in that replicate)',
    },
  };
  if (nBoot === 1) out.note = 'one replicate: the standard error is undefined';
  return out;
};
