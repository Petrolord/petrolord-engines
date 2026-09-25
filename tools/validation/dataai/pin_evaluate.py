#!/usr/bin/env python3
"""Second-witness pins for engines/dataai/evaluate.js (Data & AI D5).

Needs numpy and scikit-learn (the library witness, NOT the stdlib oracle):

    /root/daienv/bin/python tools/validation/dataai/pin_evaluate.py

It reads the INPUTS of the golden cases and writes
test-data/dataai/pins/evaluate_pins.json. A library result is pinned only
where it agrees with the oracle (numbers to 1e-6 relative); every
disagreement is listed in `skipped` with its reason, and
FINDINGS-evaluate.md explains each convention difference. Each pin's
tolerance is max(1e-10, 10 x the library's own disagreement with the
oracle), rounded up to a power of ten.

Mappings stated once:
  tokens     TfidfVectorizer / CountVectorizer with lowercase=False, a
             preprocessor that lowercases ASCII A-Z only, token_pattern
             [a-z0-9]+ (single-character tokens kept), stop_words 'english'
             when the case turns the stop list on (the same 318 words).
  TF-IDF     TfidfVectorizer(norm='l2', use_idf=True, smooth_idf=True,
             sublinear_tf as the case): idf_, the document rows, and the
             cosine X q^T for the ranked documents.
  BM25       no scikit-learn implementation: CountVectorizer counts with the
             stated Okapi / Lucene formula in numpy (a check of the
             tokenisation and counts, second to the oracle for the formula).
  nDCG       sklearn.metrics.ndcg_score(ignore_ties=True, k) on one row: the
             ranked documents scored n, n - 1, ..., the other judged
             documents below them; pinned only when the ranking has at least
             k documents (otherwise scikit-learn fills the list with unranked
             judged documents). Exponential gain: y_true = 2^grade - 1.
  AP         sklearn.metrics.average_precision_score on the same row with
             y_true = grade >= relevantGrade; pinned only when every relevant
             judged document is inside the top k (scikit-learn has no cutoff).
  kappa      sklearn.metrics.cohen_kappa_score(a, b, labels, weights).
  Brier      sklearn.metrics.brier_score_loss.
  log loss   sklearn.metrics.log_loss, pinned only where no probability is
             clipped (scikit-learn clips at float64 machine epsilon, ml.js at
             eps = 1e-15).
  bins       numpy.histogram with the explicit edges i / M (the engine's
             rule: [e_i, e_{i+1}), last closed) for the counts;
             sklearn.calibration.calibration_curve(strategy='uniform') for the
             non-empty bins' means ONLY where no probability sits on an
             interior edge (scikit-learn 1.9.1 builds edges with linspace and
             assigns by searchsorted side='left', so an edge value goes to the
             LOWER bin).
"""
import json
import math
import os
import re
import warnings

import numpy as np
import sklearn
from sklearn.calibration import calibration_curve
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer
from sklearn.metrics import average_precision_score, brier_score_loss, cohen_kappa_score, log_loss, ndcg_score

warnings.simplefilter('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
GOLD = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'evaluate_cases.json')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'pins', 'evaluate_pins.json')
AGREE = 1e-6


def ascii_lower(s):
    return re.sub('[A-Z]+', lambda m: m.group(0).lower(), s)


def vec_kwargs(stop):
    return dict(lowercase=False, preprocessor=ascii_lower, token_pattern=r'[a-z0-9]+', stop_words='english' if stop else None)


def up10(x):
    return 10.0 ** math.ceil(math.log10(x)) if x > 0 else 0.0


def get(obj, dotted):
    for k in dotted.split('.'):
        obj = obj[int(k)] if isinstance(obj, list) else obj[k]
    return obj


def main():
    G = json.load(open(GOLD))
    pins, skipped, worst = [], [], {}

    def pin(case, field, lib, what, group):
        ev = get(case['expected'], field)
        lv = float(lib)
        d = abs(lv - ev)
        rel = d / abs(ev) if ev != 0 else d
        if rel > AGREE and d > 1e-12:
            skipped.append({'case': case['id'], 'field': field, 'library': what, 'value': lv, 'oracle': ev, 'reason': 'disagrees with the oracle beyond 1e-6'})
            return
        worst[group] = max(worst.get(group, 0.0), rel)
        pins.append({'id': f"{case['id']}:{field}", 'case': case['id'], 'field': field, 'value': lv, 'tol': max(1e-10, up10(10 * rel)), 'abs': 1e-12, 'library': what})

    def skip(case, what, reason):
        skipped.append({'case': case['id'], 'library': what, 'reason': reason})

    for c in G['cases']:
        e, a, fn = c['expected'], c['args'], c['fn']
        if isinstance(e, dict) and e.get('error'):
            continue
        if fn == 'tfidfVectors':
            v = TfidfVectorizer(**vec_kwargs(a.get('stopWords', False)), sublinear_tf=a.get('sublinearTf', False))
            X = v.fit_transform([d['text'] for d in a['documents']]).toarray()
            vocab = v.get_feature_names_out().tolist()
            if vocab != e['vocabulary']:
                skip(c, 'TfidfVectorizer', 'vocabulary differs')
                continue
            for j, w in enumerate(vocab):
                pin(c, f'idf.{j}', v.idf_[j], 'TfidfVectorizer.idf_', 'tfidf')
            for i, d in enumerate(e['vectors']):
                for w in d['weights']:
                    pin(c, f'vectors.{i}.weights.{w}', X[i, vocab.index(w)], 'TfidfVectorizer row', 'tfidf')
        elif fn in ('rankTfidf', 'rankBm25') or (fn == 'retrieve'):
            docs = a['documents']
            ids = [d['id'] for d in docs]
            stop = a.get('stopWords', False)
            items = [(f'ranking', a['query'], e['ranking'])] if fn != 'retrieve' else [(f'perQuery.{qi}.ranking', q['text'], e['perQuery'][qi]['ranking']) for qi, q in enumerate(a['queries'])]
            method = 'tfidf' if fn == 'rankTfidf' or (fn == 'retrieve' and a['method'] == 'tfidf') else 'bm25'
            if method == 'tfidf':
                v = TfidfVectorizer(**vec_kwargs(stop), sublinear_tf=a.get('sublinearTf', False))
                X = v.fit_transform([d['text'] for d in docs])
                for prefix, qtext, ranking in items:
                    s = (X @ v.transform([qtext]).T).toarray().ravel()
                    for r, row in enumerate(ranking):
                        pin(c, f'{prefix}.{r}.score', s[ids.index(row['id'])], 'TfidfVectorizer cosine', 'tfidf')
            else:
                cv = CountVectorizer(**vec_kwargs(stop))
                try:
                    C = cv.fit_transform([d['text'] for d in docs]).toarray().astype(float)
                except ValueError:
                    continue
                vocab = cv.get_feature_names_out().tolist()
                N = len(docs)
                dl = C.sum(axis=1)
                avgdl = dl.mean()
                df = (C > 0).sum(axis=0)
                idf = np.log(1 + (N - df + 0.5) / (df + 0.5))
                k1 = a.get('k1', 1.2)
                b = a.get('b', 0.75)
                an = cv.build_analyzer()
                for prefix, qtext, ranking in items:
                    terms = [t for t in dict.fromkeys(an(qtext)) if t in vocab]
                    s = np.zeros(N)
                    for t in terms:
                        j = vocab.index(t)
                        tf = C[:, j]
                        s += np.where(tf > 0, idf[j] * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl)), 0.0)
                    for r, row in enumerate(ranking):
                        pin(c, f'{prefix}.{r}.score', s[ids.index(row['id'])], 'CountVectorizer counts + numpy BM25', 'bm25')
                    if fn == 'rankBm25':
                        pin(c, 'avgdl', avgdl, 'CountVectorizer document lengths', 'bm25')
        elif fn in ('retrievalMetrics', 'evaluateRetrieval'):
            rows = [(None, a['ranking'], a['judgments'], e)] if fn == 'retrievalMetrics' else [(f'perQuery.{i}', a['runs'][r['query']], a['judgments'][r['query']], r) for i, r in enumerate(e['perQuery'])]
            k = a.get('k', 10)
            t = a.get('relevantGrade', 1)
            expo = a.get('gain', 'linear') == 'exponential'
            for prefix, ranking, judg, exp in rows:
                pre = f'{prefix}.' if prefix else ''
                docs = list(ranking[:k]) + [d for d in sorted(judg) if d not in ranking[:k]]
                g = np.array([judg.get(d, 0) for d in docs], dtype=float)
                score = np.array([len(docs) - i for i in range(len(docs))], dtype=float)
                if exp['ndcg'] is not None:
                    if len(ranking) >= k and len(docs) > 1:
                        yt = (2 ** g - 1) if expo else g
                        pin(c, f'{pre}ndcg', ndcg_score([yt], [score], k=k, ignore_ties=True), 'ndcg_score', 'ndcg')
                    else:
                        skip(c, 'ndcg_score', f'{pre or "the"} ranking has fewer than k = {k} documents (or one document): scikit-learn would fill the list with unranked judged documents')
                if exp['averagePrecision'] is not None and len(docs) > 1:
                    rel = [d for d in judg if judg[d] >= t]
                    if all(d in ranking[:k] for d in rel):
                        pin(c, f'{pre}averagePrecision', average_precision_score((g >= t).astype(int), score), 'average_precision_score', 'ap')
        elif fn == 'cohenKappa':
            k = cohen_kappa_score(a['a'], a['b'], labels=a.get('labels'), weights=None if a.get('weights', 'none') == 'none' else a['weights'])
            if e['kappa'] is None:
                skip(c, 'cohen_kappa_score', f'kappa undefined; scikit-learn returns {k}')
            else:
                pin(c, 'kappa', k, 'cohen_kappa_score', 'kappa')
        elif fn == 'calibration':
            y = np.array(a['yTrue'])
            p = np.array(a['probabilities'], dtype=float)
            M = a.get('bins', 10)
            pin(c, 'brier', brier_score_loss(y, p), 'brier_score_loss', 'brier')
            if e['logLossClipped'] == 0 and len(set(a['yTrue'])) == 2:
                pin(c, 'logLoss', log_loss(y, p), 'log_loss', 'logloss')
            elif e['logLossClipped']:
                skip(c, 'log_loss', f"{e['logLossClipped']} probabilities clipped: scikit-learn clips at machine epsilon, ml.js at 1e-15")
            edges = np.array([i / M for i in range(M + 1)])
            counts, _ = np.histogram(p, bins=edges)
            for k in range(M):
                pin(c, f'table.{k}.n', counts[k], 'numpy.histogram with edges i / M', 'bins')
            on_edge = [v for v in p.tolist() if any(v == i / M for i in range(1, M))]
            if M > 1 and on_edge:
                pt, pp = calibration_curve(y, p, n_bins=M, strategy='uniform')
                nonempty = [t for t in e['table'] if t['n']]
                same = len(pt) == len(nonempty) and all(abs(pp[i] - nonempty[i]['meanPredicted']) < 1e-9 for i in range(len(pt)))
                skip(c, 'calibration_curve', f'{len(on_edge)} probabilities sit on interior edges (for example {on_edge[0]}); scikit-learn puts an edge value in the lower bin (searchsorted side left, linspace edges); its bins {"agree anyway" if same else "differ"}')
            elif M > 1 and len(set(a['yTrue'])) == 2:
                pt, pp = calibration_curve(y, p, n_bins=M, strategy='uniform')
                nonempty = [i for i, t in enumerate(e['table']) if t['n']]
                if len(pt) != len(nonempty):
                    skip(c, 'calibration_curve', 'different number of non-empty bins')
                    continue
                for j, k in enumerate(nonempty):
                    pin(c, f'table.{k}.observedFrequency', pt[j], 'calibration_curve prob_true', 'curve')
                    pin(c, f'table.{k}.meanPredicted', pp[j], 'calibration_curve prob_pred', 'curve')
        elif fn in ('bootstrapMean',):
            pin(c, 'mean', np.mean(a['values']), 'numpy.mean', 'mean')
        elif fn == 'pairedBootstrap':
            pin(c, 'difference', np.mean(np.array(a['a']) - np.array(a['b'])), 'numpy.mean of a - b', 'mean')

    out = {
        'generatedBy': 'tools/validation/dataai/pin_evaluate.py',
        'versions': {'numpy': np.__version__, 'scikit-learn': sklearn.__version__},
        'agreement': 'a library value is pinned only where it agrees with the oracle to 1e-6 relative; tol = max(1e-10, 10 x that disagreement rounded up to a power of ten)',
        'worstRelativeDisagreement': {k: v for k, v in sorted(worst.items())},
        'pins': pins,
        'skipped': skipped,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, allow_nan=False)
        fh.write('\n')
    print('wrote', os.path.relpath(DEST), len(pins), 'pins,', len(skipped), 'skipped')
    for k, v in sorted(worst.items()):
        print(f'  worst {k}: {v:.2g}')
    for s in skipped:
        print('  skip', s['case'], s.get('field', ''), s['library'], s['reason'][:140])


if __name__ == '__main__':
    main()
