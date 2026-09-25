#!/usr/bin/env python3
"""Independent oracle for engines/dataai/evaluate.js (Data & AI D5, applied AI evaluation).

STDLIB ONLY. Run with any python 3.10+:

    python3 tools/validation/dataai/oracle_evaluate.py

It writes test-data/dataai/goldens/evaluate_cases.json. Nothing here reads or
imports the JavaScript; every value is computed from the published
definitions by a road chosen to differ from the engine's:

  route            oracle road                                engine road
  ---------------  -----------------------------------------  ---------------------
  tokens           a character loop over code points          regex split
  BM25, TF-IDF     Decimal(50) with Decimal.ln and .sqrt,     float, postings lists
                   dense term-by-document loops
  ranking          exact Decimal scores; the 12-significant-   Number(toPrecision(12))
                   digit tie key by Decimal quantize
  metrics          Fractions (exact); log2 in Decimal         float
  SQuAD answers    character loops, word runs for articles    regex
  claims           a hand-written character scanner           regular expressions
  kappa            Fractions over a dict of pair counts       float matrix
  calibration      Fractions of the exact double values;      float
                   bins by exact comparison with the double
                   edges i / M; Murphy terms exact (the
                   identity closes to 0 exactly and is
                   asserted); log loss in Decimal
  bootstrap        32-bit integer mulberry32, index           float u, floor(u n)
                   (k n) >> 32; replicate means in
                   Fractions; the simple-statistics quantile
                   rule on exact values

AMBIGUITY GUARD. Where a float program could take a different branch from
the exact one (a score within 1e-13 relative of a 12-digit rounding boundary,
a bootstrap quantile index whose wholeness differs between float and exact
arithmetic, a probability within 1e-12 of a bin edge that it does not equal)
the oracle REFUSES TO WRITE the case (raises).

WHAT IT CANNOT CHECK: the conventions (tokeniser, idf variants, the tie
rule, the metric definitions, the claim grammar, bin edges, the bootstrap
draw order). Those are written in FINDINGS-evaluate.md and applied here the
same way; the oracle checks the arithmetic of those choices.

Sources (FINDINGS-evaluate.md has the full list):
  Robertson, S. and Zaragoza, H. (2009) The Probabilistic Relevance
    Framework: BM25 and Beyond. Foundations and Trends in IR 3(4):333-389.
  Apache Lucene BM25Similarity (idf = ln(1 + (N - df + 0.5) / (df + 0.5))).
  scikit-learn TfidfVectorizer / TfidfTransformer documentation (smooth idf).
  Manning, Raghavan and Schutze (2008) Introduction to Information
    Retrieval, ch. 8 (precision, recall, MAP, MRR).
  Jarvelin, K. and Kekalainen, J. (2002) Cumulated gain-based evaluation of
    IR techniques. ACM TOIS 20(4):422-446 (DCG, nDCG).
  Burges et al. (2005) Learning to rank using gradient descent (2^g - 1 gain).
  Rajpurkar et al. (2016, 2018) SQuAD; the SQuAD 2.0 evaluation script
    (normalize_answer, f1_score).
  Cohen, J. (1960) Educational and Psychological Measurement 20:37-46;
    Cohen, J. (1968) Psychological Bulletin 70(4):213-220 (weighted kappa).
  Brier, G. W. (1950) Monthly Weather Review 78(1):1-3; Murphy, A. H. (1973)
    J. Applied Meteorology 12:595-600; Stephenson, D. B., Coelho, C. A. S.
    and Jolliffe, I. T. (2008) Two extra components in the Brier score
    decomposition. Weather and Forecasting 23(4):752-757.
  Guo, C. et al. (2017) On calibration of modern neural networks, ICML (ECE).
  Efron, B. and Tibshirani, R. (1993) An Introduction to the Bootstrap
    (percentile interval); Koehn, P. (2004) Statistical significance tests
    for machine translation evaluation, EMNLP (paired bootstrap).
"""
import json
import math
import os
from collections import Counter
from decimal import Decimal as D, getcontext, ROUND_HALF_EVEN
from fractions import Fraction as F

getcontext().prec = 50

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'evaluate_cases.json')
FIX = os.path.join(ROOT, 'test-data', 'dataai', 'ekene-docs')

TOL = 1e-10


class Ambiguous(Exception):
    pass


# ------------------------------------------------------------------ number layout

def js_num(x):
    """ECMA-262 Number::toString (radix 10) from Python's shortest repr."""
    x = float(x)
    if x == math.inf:
        return 'infinity'
    if x == -math.inf:
        return 'minus infinity'
    if x == 0:
        return '0'
    sign = '-' if x < 0 else ''
    d = D(repr(abs(x))).normalize()
    t = d.as_tuple()
    digits = ''.join(str(v) for v in t.digits)
    k = len(digits)
    n = t.exponent + k
    if k <= n <= 21:
        body = digits + '0' * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        body = '0.' + '0' * (-n) + digits
    else:
        e = n - 1
        body = (digits if k == 1 else digits[0] + '.' + digits[1:]) + 'e' + ('+' if e >= 0 else '-') + str(abs(e))
    return sign + body


def fl(x):
    return None if x is None else float(x)


def dfrac(x):
    return D(x.numerator) / D(x.denominator)


# ------------------------------------------------------------------ stop list (typed from the scikit-learn 1.9.1 source)

STOP = frozenset("""
a about above across after afterwards again against all almost alone along already also although always am among amongst
amoungst amount an and another any anyhow anyone anything anyway anywhere are around as at back be became because become
becomes becoming been before beforehand behind being below beside besides between beyond bill both bottom but by call can
cannot cant co con could couldnt cry de describe detail do done down due during each eg eight either eleven else elsewhere
empty enough etc even ever every everyone everything everywhere except few fifteen fifty fill find fire first five for former
formerly forty found four from front full further get give go had has hasnt have he hence her here hereafter hereby herein
hereupon hers herself him himself his how however hundred i ie if in inc indeed interest into is it its itself keep last
latter latterly least less ltd made many may me meanwhile might mill mine more moreover most mostly move much must my myself
name namely neither never nevertheless next nine no nobody none noone nor not nothing now nowhere of off often on once one only
onto or other others otherwise our ours ourselves out over own part per perhaps please put rather re same see seem seemed
seeming seems serious several she should show side since sincere six sixty so some somehow someone something sometime
sometimes somewhere still such system take ten than that the their them themselves then thence there thereafter thereby
therefore therein thereupon these they thick thin third this those though three through throughout thru thus to together too
top toward towards twelve twenty two un under until up upon us very via was we well were what whatever when whence whenever
where whereafter whereas whereby wherein whereupon wherever whether which while whither who whoever whole whom whose why will
with within without would yet you your yours yourself yourselves
""".split())
assert len(STOP) == 318


# ------------------------------------------------------------------ tokens

def tokens(text, stop=False):
    out, cur = [], []
    for ch in text:
        o = ord(ch)
        if 65 <= o <= 90:
            ch = chr(o + 32)
            o += 32
        if 97 <= o <= 122 or 48 <= o <= 57:
            cur.append(ch)
        elif cur:
            out.append(''.join(cur))
            cur = []
    if cur:
        out.append(''.join(cur))
    if stop:
        out = [w for w in out if w not in STOP]
    return out


def distinct(ts):
    seen, out = set(), []
    for w in ts:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return out


def js_key(s):
    """UTF-16 code-unit order (JavaScript string <)."""
    return s.encode('utf-16-be')


# ------------------------------------------------------------------ BM25 and TF-IDF in Decimal

def bm25_scores(docs, query, k1, b, stop):
    toks = [tokens(d['text'], stop) for d in docs]
    N = len(docs)
    total = sum(len(t) for t in toks)
    if total == 0:
        return None
    avgdl = F(total, N)
    k1, b = F(k1), F(b)
    terms = distinct(tokens(query, stop))
    df = {w: sum(1 for t in toks if w in t) for w in terms}
    idf = {w: (D(1) + dfrac((N - df[w] + F(1, 2)) / (df[w] + F(1, 2)))).ln() for w in terms}
    scores, explain = [], []
    for t in toks:
        c = Counter(t)
        s = D(0)
        ex = []
        for w in terms:
            f = c[w]
            if f == 0:
                continue
            ratio = F(f) * (k1 + 1) / (f + k1 * (1 - b + b * F(len(t)) / avgdl))
            contrib = idf[w] * dfrac(ratio)
            s += contrib
            ex.append({'term': w, 'tf': f, 'df': df[w], 'idf': idf[w], 'contribution': contrib})
        scores.append(s)
        explain.append(ex)
    return {'scores': scores, 'explain': explain, 'avgdl': avgdl, 'N': N, 'terms': terms, 'df': df, 'idf': idf, 'lengths': [len(t) for t in toks]}


def tfidf_model(docs, stop, sublinear):
    toks = [tokens(d['text'], stop) for d in docs]
    N = len(docs)
    vocab = sorted({w for t in toks for w in t}, key=js_key)
    if not vocab:
        return None
    df = {w: 0 for w in vocab}
    for t in toks:
        for w in set(t):
            df[w] += 1
    idf = {w: dfrac(F(1 + N, 1 + df[w])).ln() + 1 for w in vocab}

    def tw(f):
        return (D(1) + D(f).ln()) if sublinear else D(f)
    vecs, norms = [], []
    for t in toks:
        c = Counter(t)
        raw = {w: tw(c[w]) * idf[w] for w in c}
        nrm = sum((v * v for v in raw.values()), D(0)).sqrt()
        norms.append(nrm)
        vecs.append({w: v / nrm for w, v in raw.items()} if nrm != 0 else {})
    return {'vocab': vocab, 'df': df, 'idf': idf, 'vecs': vecs, 'norms': norms, 'tw': tw, 'N': N, 'lengths': [len(t) for t in toks]}


def tfidf_query(m, query, stop):
    c = Counter(w for w in tokens(query, stop) if w in m['idf'])
    raw = {w: m['tw'](c[w]) * m['idf'][w] for w in c}
    nrm = sum((v * v for v in raw.values()), D(0)).sqrt()
    return {w: v / nrm for w, v in raw.items()} if raw else {}


def tfidf_scores(m, q):
    return [sum((q[w] * v[w] for w in q if w in v), D(0)) for v in m['vecs']]


def tie_key(s):
    """12 significant digits (the engine's Number(score.toPrecision(12))); returns (key, alternative).

    alternative is the other rounding when the exact score lies within 1e-14
    (relative) of a rounding boundary, where a double could round the other
    way; else None."""
    if s == 0:
        return D(0), None
    e = s.adjusted()
    unit = D(1).scaleb(e - 11)
    q = s.quantize(unit, rounding=ROUND_HALF_EVEN)
    scaled = s / unit
    frac = scaled - scaled.to_integral_value(rounding='ROUND_FLOOR')
    alt = None
    if abs(frac - D('0.5')) * unit < s * D('1e-14'):
        lo = scaled.to_integral_value(rounding='ROUND_FLOOR') * unit
        alt = lo + unit if q == lo else lo
    return q, alt


def rank(ids, scores, k):
    idx = [i for i in range(len(ids)) if scores[i] > 0]
    kk = {i: tie_key(scores[i]) for i in idx}
    keys = {i: kk[i][0] for i in idx}
    for i in idx:
        alt = kk[i][1]
        if alt is not None and any(keys[j] in (keys[i], alt) for j in idx if j != i):
            raise Ambiguous(f'score {scores[i]} is within 1e-14 of a 12-digit rounding boundary next to another score')
    idx.sort(key=lambda i: (-keys[i], js_key(ids[i])))
    top = idx[:k]
    ties, j = [], 0
    while j < len(top):
        e = j + 1
        while e < len(top) and keys[top[e]] == keys[top[j]]:
            e += 1
        if e - j > 1:
            ties.append([ids[i] for i in top[j:e]])
        j = e
    at_cut = len(idx) > k and keys[idx[k]] == keys[idx[k - 1]]
    return top, len(idx), ties, at_cut


# ------------------------------------------------------------------ retrieval metrics (exact)

def log2d(i):
    return D(i).ln() / D(2).ln()


def metrics(ranking, judg, k, t, gain):
    G = (lambda g: g) if gain == 'linear' else (lambda g: 2 ** g - 1)
    grades = list(judg.values())
    n_rel = sum(1 for g in grades if g >= t)
    top = ranking[:k]
    hits, ap, first, unj = 0, F(0), None, 0
    dcg = D(0)
    for j, did in enumerate(top):
        i = j + 1
        if did not in judg:
            unj += 1
        g = judg.get(did, 0)
        if g >= t:
            hits += 1
            ap += F(hits, i)
            if first is None:
                first = i
        dcg += D(G(g)) / log2d(i + 1)
    ideal = sorted(grades, reverse=True)[:k]
    idcg = sum((D(G(g)) / log2d(j + 2) for j, g in enumerate(ideal)), D(0))
    notes = {}
    if n_rel == 0:
        why = f'no judged document has grade {t} or more'
        notes['recall'] = f'recall is undefined: {why}'
        notes['averagePrecision'] = f'average precision is undefined: {why}'
    if idcg == 0:
        notes['ndcg'] = 'nDCG is undefined: every judged grade is 0, so the ideal DCG is 0'
    return {
        'k': k, 'nJudged': len(grades), 'nRelevant': n_rel, 'retrieved': len(top), 'relevantRetrieved': hits,
        'unjudgedRetrieved': unj,
        'precision': F(hits, k), 'recall': F(hits, n_rel) if n_rel else None, 'hit': 1 if hits else 0,
        'firstRelevantRank': first, 'reciprocalRank': F(1, first) if first else F(0),
        'averagePrecision': ap / n_rel if n_rel else None,
        'dcg': dcg, 'idcg': idcg, 'ndcg': dcg / idcg if idcg != 0 else None, 'notes': notes,
    }


# ------------------------------------------------------------------ SQuAD answers

PUNCT = set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')
JS_SPACE = set('\t\n\v\f\r       　﻿') | {chr(c) for c in range(0x2000, 0x200b)}


def is_word(ch):
    o = ord(ch)
    return 48 <= o <= 57 or 65 <= o <= 90 or 97 <= o <= 122 or ch == '_'


def squad_normalize(s):
    s = s.lower()  # the SQuAD script's lower(); agrees with JavaScript on the fixture text (ASCII)
    s = ''.join(ch for ch in s if ch not in PUNCT)
    # articles: whole ASCII word runs a / an / the become a space
    out, i = [], 0
    while i < len(s):
        if is_word(s[i]):
            j = i
            while j < len(s) and is_word(s[j]):
                j += 1
            w = s[i:j]
            out.append(' ' if w in ('a', 'an', 'the') else w)
            i = j
        else:
            out.append(s[i])
            i += 1
    s = ''.join(out)
    words, cur = [], []
    for ch in s:
        if ch in JS_SPACE:
            if cur:
                words.append(''.join(cur))
                cur = []
        else:
            cur.append(ch)
    if cur:
        words.append(''.join(cur))
    return ' '.join(words)


def squad_f1(pred_tokens, truth_tokens):
    if not pred_tokens or not truth_tokens:
        return {'f1': F(int(len(pred_tokens) == len(truth_tokens))), 'precision': None, 'recall': None, 'common': 0}
    common = sum((Counter(pred_tokens) & Counter(truth_tokens)).values())
    if common == 0:
        return {'f1': F(0), 'precision': F(0), 'recall': F(0), 'common': 0}
    p = F(common, len(pred_tokens))
    r = F(common, len(truth_tokens))
    return {'f1': 2 * p * r / (p + r), 'precision': p, 'recall': r, 'common': common}


def ntok(s):
    return s.split(' ') if s else []


# ------------------------------------------------------------------ claims (hand scanner)

def alnum(c):
    return c is not None and (c.isascii() and c.isalnum())


def alpha(c):
    return c is not None and (c.isascii() and c.isalpha())


def at(s, i):
    return s[i] if 0 <= i < len(s) else None


def isdig(c):
    return c is not None and '0' <= c <= '9'


def scan_figures(text):
    s = list(text)
    out = []
    # dates: dddd-dd-dd not touching an alphanumeric
    i = 0
    n = len(text)
    while i + 10 <= n:
        w = text[i:i + 10]
        if all(isdig(w[j]) for j in (0, 1, 2, 3, 5, 6, 8, 9)) and w[4] == '-' and w[7] == '-':
            if not alnum(at(text, i - 1)) and not alnum(at(text, i + 10)):
                out.append({'kind': 'date', 'text': w, 'value': w, 'start': i})
                for j in range(i, i + 10):
                    s[j] = ' '
                i += 10
                continue
            # a date-shaped run that touches an alphanumeric is left for the number scan;
            # the JS regex resumes after the whole match, so skip it the same way
            i += 10
            continue
        i += 1
    s = ''.join(s)
    i = 0
    while i < n:
        if not isdig(s[i]):
            i += 1
            continue
        a = i
        j = i
        while j < n and isdig(s[j]):
            j += 1
        # comma groups of exactly three digits not followed by a digit
        while j + 3 < n + 1 and at(s, j) == ',' and all(isdig(at(s, j + q)) for q in (1, 2, 3)) and not isdig(at(s, j + 4)):
            j += 4
        if at(s, j) == '.' and isdig(at(s, j + 1)):
            j += 1
            while j < n and isdig(s[j]):
                j += 1
        body = s[a:j]
        i = j
        p = at(s, a - 1)
        if alpha(p):
            continue
        if p in ('-', '_', '/') and alnum(at(s, a - 2)):
            continue
        neg = p == '-' and not alnum(at(s, a - 2))
        v = F(body.replace(',', ''))
        out.append({'kind': 'number', 'text': ('-' + body) if neg else body, 'value': -v if neg else v, 'start': a - 1 if neg else a})
    return out


def claims_of(text):
    s = list(text)
    out = []
    opens = ('"', '“')
    closes = ('"', '”')
    i = 0
    while i < len(text):
        if text[i] in opens:
            j = i + 1
            while j < len(text) and text[j] not in ('"', '“', '”'):
                j += 1
            if j < len(text) and text[j] in closes:
                inner = text[i + 1:j]
                tk = tokens(inner)
                if tk:
                    out.append({'kind': 'quote', 'text': inner, 'value': ' '.join(tk), 'start': i})
                for q in range(i, j + 1):
                    s[q] = ' '
                i = j + 1
                continue
            # no closing quote here: the JS regex retries from the next character
        i += 1
    out += scan_figures(''.join(s))
    return sorted(out, key=lambda c: c['start'])


def passage_facts(text):
    figs = scan_figures(text)
    return {'numbers': [f['value'] for f in figs if f['kind'] == 'number'],
            'dates': {f['value'] for f in figs if f['kind'] == 'date'},
            'tokens': tokens(text)}


def in_passage(c, facts, rel):
    if c['kind'] == 'date':
        return c['value'] in facts['dates']
    if c['kind'] == 'quote':
        nd = c['value'].split(' ')
        h = facts['tokens']
        return any(h[i:i + len(nd)] == nd for i in range(len(h) - len(nd) + 1))
    return any(abs(c['value'] - v) <= F(rel) * abs(v) for v in facts['numbers'])


def list_ids(ids):
    return ids[0] if len(ids) == 1 else ', '.join(ids[:-1]) + ' and ' + ids[-1]


def describe(c):
    if c['kind'] == 'quote':
        return f'the quote "{c["text"]}"'
    if c['kind'] == 'date':
        return f'the date {c["text"]}'
    plain = c['text'].lstrip('-').replace(',', '')
    shown = js_num(abs(c['value']))
    return f'the number {c["text"]}' + (f' ({js_num(c["value"])})' if plain != shown else '')


def ground(text, citations, facts, retrieved, rel):
    cites = distinct(citations)
    status = [{'id': c, 'status': 'unknown' if c not in facts else ('notRetrieved' if retrieved is not None and c not in retrieved else 'ok')} for c in cites]
    eligible = [s['id'] for s in status if s['status'] == 'ok']
    cnr_all = [s['id'] for s in status if s['status'] == 'notRetrieved']
    claims = []
    for c in claims_of(text):
        found = [i for i in eligible if in_passage(c, facts[i], rel)]
        row = {'kind': c['kind'], 'text': c['text'], 'value': c['value'], 'supported': bool(found), 'foundIn': found}
        if not found:
            if not cites:
                reason = f'{describe(c)} is unsupported: the answer cites no passage'
            elif not eligible:
                reason = f'{describe(c)} is unsupported: no cited passage is ' + ('a retrieved passage of the corpus' if retrieved is not None else 'in the corpus')
            else:
                reason = f'{describe(c)} is not in the cited passage{"" if len(eligible) == 1 else "s"} {list_ids(eligible)}'
            cnr = [i for i in cnr_all if in_passage(c, facts[i], rel)]
            elsewhere = sorted([i for i in facts if i not in cites and in_passage(c, facts[i], rel)], key=js_key)
            inret = [i for i in elsewhere if retrieved is not None and i in retrieved]
            if cnr:
                reason += f'; it appears in {list_ids(cnr)}, cited but not retrieved'
            if inret:
                reason += f'; it appears in retrieved {"passage" if len(inret) == 1 else "passages"} {list_ids(inret)}, which the answer does not cite'
            if not cnr and not inret:
                where = f'{"passage" if len(elsewhere) == 1 else "passages"} {list_ids(elsewhere)}' if elsewhere else ''
                if not elsewhere:
                    reason += '; it appears in no passage of the corpus'
                elif retrieved is not None:
                    reason += f'; it appears only in {where}, neither cited nor retrieved'
                else:
                    reason += f'; it appears in {where}, which the answer does not cite'
            row['reason'] = reason
        claims.append(row)
    ns = sum(1 for c in claims if c['supported'])
    flags = [f'citation {s["id"]} is not a passage of the corpus' if s['status'] == 'unknown' else f'citation {s["id"]} was not retrieved for this query'
             for s in status if s['status'] != 'ok']
    r = {'claims': claims, 'nClaims': len(claims), 'nSupported': ns, 'supportedFraction': F(ns, len(claims)) if claims else None,
         'citations': status, 'flags': flags}
    if not claims:
        r['note'] = 'the answer has no checkable claim (no quote, date or number), so the supported fraction is undefined'
    return r


# ------------------------------------------------------------------ kappa (exact)

def kappa(a, b, labels, weights):
    n = len(a)
    L = labels
    pos = {v: i for i, v in enumerate(L)}
    pairs = Counter((pos[x], pos[y]) for x, y in zip(a, b))
    row = Counter(pos[x] for x in a)
    col = Counter(pos[y] for y in b)
    m = len(L)

    def w(i, j):
        if weights == 'none':
            return 0 if i == j else 1
        return abs(i - j) if weights == 'linear' else (i - j) ** 2
    num = sum(w(i, j) * c for (i, j), c in pairs.items())
    den = sum(F(w(i, j) * row[i] * col[j], n) for i in range(m) for j in range(m))
    agree = sum(pairs[(i, i)] for i in range(m))
    pe = sum(F(row[i] * col[i], n * n) for i in range(m))
    return {
        'n': n, 'labels': L, 'weights': weights,
        'confusion': [[pairs[(i, j)] for j in range(m)] for i in range(m)],
        'rowTotals': [row[i] for i in range(m)], 'columnTotals': [col[j] for j in range(m)],
        'observedAgreement': F(agree, n), 'expectedAgreement': pe,
        'observedDisagreement': F(num, n), 'expectedDisagreement': den / n,
        'kappa': None if den == 0 else 1 - F(num) / den,
    }


# ------------------------------------------------------------------ calibration (exact)

def bin_of(p, M):
    fp = F(p)
    for i in range(M - 1, -1, -1):
        e = F(i / M)
        if fp >= e:
            return i
    return 0


def edge_guard(p, M):
    for i in range(1, M):
        e = i / M
        if p != e and abs(p - e) < 1e-12:
            raise Ambiguous(f'probability {p} within 1e-12 of the edge {e}')


def log_loss_dec(y, p, eps):
    s = D(0)
    clipped = 0
    for yi, pi in zip(y, p):
        q = pi
        if q < eps:
            q = eps
            clipped += 1
        elif q > 1 - eps:
            q = 1 - eps
            clipped += 1
        s -= D(q).ln() if yi == 1 else D(1 - q).ln()
    return s / len(y), clipped


def calibration(y, p, M, eps=1e-15):
    N = len(y)
    for v in p:
        edge_guard(v, M)
    fr = [F(v) for v in p]
    groups = [[] for _ in range(M)]
    for j, v in enumerate(p):
        groups[bin_of(v, M)].append(j)
    brier = sum((fr[j] - y[j]) ** 2 for j in range(N)) / N
    obar = F(sum(y), N)
    rel = res = wbv = wbc = ece = F(0)
    mce = F(0)
    table = []
    for k, js in enumerate(groups):
        row = {'bin': k, 'lower': k / M, 'upper': (k + 1) / M, 'closedRight': k == M - 1, 'n': len(js)}
        if not js:
            row.update(meanPredicted=None, observedFrequency=None, gap=None)
            table.append(row)
            continue
        pk = sum(fr[j] for j in js) / len(js)
        ok = F(sum(y[j] for j in js), len(js))
        gap = abs(ok - pk)
        rel += len(js) * (pk - ok) ** 2
        res += len(js) * (ok - obar) ** 2
        for j in js:
            wbv += (fr[j] - pk) ** 2
            wbc += (y[j] - ok) * (fr[j] - pk)
        ece += F(len(js), N) * gap
        mce = max(mce, gap)
        row.update(meanPredicted=pk, observedFrequency=ok, gap=gap)
        table.append(row)
    R = rel / N
    S = res / N
    U = obar * (1 - obar)
    V = wbv / N
    C = 2 * wbc / N
    total = R - S + U + V - C
    assert total == brier, 'Murphy + within-bin identity must close exactly'
    ll, clipped = log_loss_dec(y, p, eps)
    return {
        'n': N, 'bins': M, 'baseRate': obar, 'brier': brier, 'logLoss': ll, 'logLossEps': eps, 'logLossClipped': clipped,
        'table': table, 'ece': ece, 'mce': mce,
        'murphy': {'reliability': R, 'resolution': S, 'uncertainty': U, 'withinBinVariance': V, 'withinBinCovariance': C,
                   'sum': total, 'closure': F(0)},
    }


# ------------------------------------------------------------------ mulberry32 and bootstrap (exact)

M32 = 0xFFFFFFFF


def imul(a, b):
    return (a * b) & M32


class Mulberry32:
    def __init__(self, seed):
        self.a = seed & M32

    def next_int(self):
        self.a = (self.a + 0x6D2B79F5) & M32
        t = self.a
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return (t ^ (t >> 14)) & M32

    def draw(self, m):
        return (self.next_int() * m) >> 32


LEVEL_TAILS = {0.8: F(1, 10), 0.9: F(1, 20), 0.95: F(1, 40), 0.99: F(1, 200)}


def ss_quantile_exact(sorted_vals, p_exact, p_float):
    """simple-statistics quantileSorted: idx = n p; not whole -> ceil(idx)-th; whole & even n -> mean of idx-th and idx+1-th; whole & odd -> idx+1-th."""
    n = len(sorted_vals)
    idx = n * p_exact
    whole = idx.denominator == 1
    fidx = n * p_float
    if (fidx == int(fidx)) != whole:
        raise Ambiguous(f'quantile index {fidx} vs exact {idx}')
    if p_exact == 1:
        return sorted_vals[-1]
    if p_exact == 0:
        return sorted_vals[0]
    if not whole:
        return sorted_vals[math.ceil(idx) - 1]
    i = int(idx)
    if n % 2 == 0:
        return (sorted_vals[i - 1] + sorted_vals[i]) / 2
    return sorted_vals[i]


def boot_interval(reps, level):
    lo = LEVEL_TAILS[level]
    hi = 1 - lo
    s = sorted(reps)
    lower = ss_quantile_exact(s, lo, float(lo))
    upper = ss_quantile_exact(s, hi, float(hi))
    B = len(reps)
    m = sum(reps) / B
    se = None if B == 1 else dfrac(sum((r - m) ** 2 for r in reps) / (B - 1)).sqrt()
    pct = lambda q: js_num(float(q * 100))
    return lower, upper, se, pct(lo), pct(hi)


def bootstrap_mean(values, n_boot, seed, level):
    n = len(values)
    fv = [F(v) for v in values]
    rng = Mulberry32(seed)
    reps = []
    for _ in range(n_boot):
        reps.append(sum(fv[rng.draw(n)] for _ in range(n)) / n)
    return reps


def paired_reps(a, b, n_boot, seed, paired):
    n = len(a)
    fa = [F(v) for v in a]
    fb = [F(v) for v in b]
    d = [F(float(x) - float(y)) for x, y in zip(a, b)]  # the engine forms a - b in double precision first
    rng = Mulberry32(seed)
    reps = []
    for _ in range(n_boot):
        if paired:
            reps.append(sum(d[rng.draw(n)] for _ in range(n)) / n)
        else:
            sa = sum(fa[rng.draw(n)] for _ in range(n))
            sb = sum(fb[rng.draw(n)] for _ in range(n))
            reps.append(sa / n - sb / n)
    return reps


def float_rep_sign(a, b, n_boot, seed, paired):
    """The replicates as the engine's doubles, used ONLY for the sign of a
    replicate whose exact value is within 1e-9 of 0 (the at-or-below-zero
    share counts the double; FINDINGS-evaluate.md)."""
    n = len(a)
    d = [x - y for x, y in zip(a, b)]
    rng = Mulberry32(seed)
    out = []
    for _ in range(n_boot):
        if paired:
            s = 0.0
            for _ in range(n):
                s += d[rng.draw(n)]
            out.append(s / n)
        else:
            sa = 0.0
            for _ in range(n):
                sa += a[rng.draw(n)]
            sb = 0.0
            for _ in range(n):
                sb += b[rng.draw(n)]
            out.append(sa / n - sb / n)
    return out


# ------------------------------------------------------------------ result builders (engine layout, no basis)

def num(x):
    if x is None:
        return None
    if isinstance(x, (F, D)):
        return float(x)
    return x


def deep(o):
    if isinstance(o, dict):
        return {k: deep(v) for k, v in o.items()}
    if isinstance(o, list):
        return [deep(v) for v in o]
    if isinstance(o, (F, D)):
        return float(o)
    return o


def plural(n, one, many=None):
    return f'{n} {one if n == 1 else (many or one + "s")}'


def o_tokenize(text, stop=False):
    allt = tokens(text)
    t = [w for w in allt if w not in STOP] if stop else allt
    return {'tokens': t, 'count': len(t), 'removed': len(allt) - len(t)}


def o_bm25(docs, query, k=10, k1=1.2, b=0.75, stop=False):
    r = bm25_scores(docs, query, k1, b, stop)
    ids = [d['id'] for d in docs]
    top, matched, ties, cut = rank(ids, r['scores'], k)
    out = {
        'method': 'bm25', 'k': k, 'k1': k1, 'b': b, 'stopWords': stop, 'N': r['N'], 'avgdl': r['avgdl'],
        'queryTerms': [{'term': w, 'df': r['df'][w], 'idf': r['idf'][w]} for w in r['terms']],
        'ranking': [{'rank': j + 1, 'id': ids[i], 'score': r['scores'][i], 'length': r['lengths'][i], 'terms': r['explain'][i]} for j, i in enumerate(top)],
        'matched': matched, 'ties': ties, 'tieAtCutoff': cut,
    }
    if not r['terms']:
        out['note'] = 'the query has no token' + (' after the stop list' if stop else '') + ', so no document is ranked'
    elif not matched:
        out['note'] = 'no document contains a query term, so no document is ranked'
    return deep(out)


def o_tfidf_vectors(docs, stop=False, sub=False):
    m = tfidf_model(docs, stop, sub)
    return deep({'N': m['N'], 'vocabulary': m['vocab'], 'df': [m['df'][w] for w in m['vocab']], 'idf': [m['idf'][w] for w in m['vocab']],
                 'vectors': [{'id': d['id'], 'length': m['lengths'][i], 'norm': m['norms'][i], 'weights': {w: m['vecs'][i][w] for w in sorted(m['vecs'][i], key=js_key)}} for i, d in enumerate(docs)]})


def o_tfidf(docs, query, k=10, stop=False, sub=False):
    m = tfidf_model(docs, stop, sub)
    q = tfidf_query(m, query, stop)
    sc = tfidf_scores(m, q)
    ids = [d['id'] for d in docs]
    top, matched, ties, cut = rank(ids, sc, k)
    allq = distinct(tokens(query, stop))
    qterms = sorted(q, key=js_key)
    out = {
        'method': 'tfidf', 'k': k, 'stopWords': stop, 'sublinearTf': sub, 'N': m['N'],
        'queryVector': {w: q[w] for w in qterms},
        'droppedTerms': [w for w in allq if w not in m['idf']],
        'ranking': [{'rank': j + 1, 'id': ids[i], 'score': sc[i], 'terms': [{'term': w, 'query': q[w], 'document': m['vecs'][i][w]} for w in qterms if w in m['vecs'][i]]} for j, i in enumerate(top)],
        'matched': matched, 'ties': ties, 'tieAtCutoff': cut,
    }
    if not allq:
        out['note'] = 'the query has no token' + (' after the stop list' if stop else '') + ', so no document is ranked'
    elif not q:
        out['note'] = 'no query term is in the corpus vocabulary, so no document is ranked'
    return deep(out)


def o_retrieve(docs, queries, method, k=10, k1=1.2, b=0.75, stop=False, sub=False):
    ids = [d['id'] for d in docs]
    per = []
    for q in queries:
        if method == 'bm25':
            sc = bm25_scores(docs, q['text'], k1, b, stop)['scores']
        else:
            m = tfidf_model(docs, stop, sub)
            sc = tfidf_scores(m, tfidf_query(m, q['text'], stop))
        top, matched, ties, cut = rank(ids, sc, k)
        per.append({'id': q['id'], 'ranking': [{'rank': j + 1, 'id': ids[i], 'score': sc[i]} for j, i in enumerate(top)], 'matched': matched, 'ties': ties, 'tieAtCutoff': cut})
    out = {'method': method, 'k': k, 'stopWords': stop, 'runs': {p['id']: [x['id'] for x in p['ranking']] for p in per}, 'perQuery': per}
    if method == 'bm25':
        out.update(k1=k1, b=b)
    else:
        out['sublinearTf'] = sub
    return deep(out)


def o_metrics(ranking, judg, k=10, t=1, gain='linear'):
    r = metrics(ranking, judg, k, t, gain)
    if not r['notes']:
        del r['notes']
    r.update(relevantGrade=t, gain=gain)
    return deep(r)


def o_evaluate(runs, judg, k=10, t=1, gain='linear', no_rel='exclude'):
    qids = sorted(judg, key=js_key)
    per = []
    for q in qids:
        r = metrics(runs[q], judg[q], k, t, gain)
        if not r['notes']:
            del r['notes']
        per.append({'query': q, **r})
    excl = [{'query': r['query'], 'reason': f'no judged document has grade {t} or more'} for r in per if r['nRelevant'] == 0]
    used = [r for r in per if r['nRelevant'] > 0 or no_rel == 'zero']
    z = lambda v: F(0) if v is None else v
    keys = [('precision', 'precision'), ('recall', 'recall'), ('hitRate', 'hit'), ('mrr', 'reciprocalRank'), ('map', 'averagePrecision'), ('ndcg', 'ndcg')]
    mean_ = {}
    for name, key in keys:
        if not used:
            mean_[name] = None
            continue
        vals = [z(r[key]) for r in used]
        mean_[name] = sum((dfrac(v) if isinstance(v, F) else D(v) if not isinstance(v, D) else v) for v in vals) / len(vals)
    out = {'k': k, 'relevantGrade': t, 'gain': gain, 'noRelevant': no_rel, 'nQueries': len(qids), 'nIncluded': len(used),
           'perQuery': per, 'mean': mean_, 'excluded': excl if no_rel == 'exclude' else [], 'zeroed': excl if no_rel == 'zero' else []}
    if not used:
        out['note'] = f'no query has a judged document at grade {t} or more, so every mean is null'
    return deep(out)


def o_normalize(text):
    n = squad_normalize(text)
    return {'normalized': n, 'tokens': ntok(n)}


def o_answer(pred, truth):
    a, b = squad_normalize(pred), squad_normalize(truth)
    f = squad_f1(ntok(a), ntok(b))
    return deep({'exactMatch': a == b, 'f1': f['f1'], 'precision': f['precision'], 'recall': f['recall'], 'commonTokens': f['common'],
                 'normalizedPrediction': a, 'normalizedTruth': b})


def empty(v):
    return v is None or (isinstance(v, str) and v.strip() == '')


def is_number_string(s):
    s = s.strip()
    if s.startswith('-'):
        s = s[1:]
    if '.' in s:
        whole, _, fr = s.partition('.')
        if not fr or not fr.isdigit() or not fr.isascii():
            return False
    else:
        whole = s
    groups = whole.split(',')
    if not groups[0] or not groups[0].isdigit() or not groups[0].isascii():
        return False
    return all(len(g) == 3 and g.isdigit() and g.isascii() for g in groups[1:])


def score_cell(f, label, pred):
    le, pe = empty(label), empty(pred)
    cell = {'label': None if le else label, 'prediction': None if pe else pred}
    text = f['type'] == 'text'
    if le and pe:
        return {**cell, 'outcome': 'correct', 'empty': True, **({'f1': F(1)} if text else {})}
    if pe:
        return {**cell, 'outcome': 'missed', 'reason': 'the label has a value and the prediction is empty', **({'f1': F(0)} if text else {})}
    if le:
        return {**cell, 'outcome': 'unsupported', 'reason': 'the label is empty and the prediction has a value', **({'f1': F(0)} if text else {})}
    if text:
        a, b = squad_normalize(pred), squad_normalize(label)
        f1 = squad_f1(ntok(a), ntok(b))['f1']
        if a == b:
            return {**cell, 'outcome': 'correct', 'f1': f1}
        return {**cell, 'outcome': 'wrong', 'f1': f1, 'reason': f'normalised "{a}" differs from "{b}"'}
    if isinstance(pred, str):
        if not is_number_string(pred):
            return {**cell, 'outcome': 'wrong', 'reason': f'"{pred}" is not a plain number (digits with optional comma thousands groups and a decimal part)'}
        x = float(pred.strip().replace(',', ''))
    else:
        x = pred
    tol = max(F(f.get('absTol', 0)), F(f.get('relTol', 0)) * abs(F(label)))
    d = abs(F(x) - F(label))
    dd = abs(x - label)  # the engine's printed difference is the double difference
    if d <= tol:
        return {**cell, 'outcome': 'correct', 'difference': dd}
    return {**cell, 'outcome': 'wrong', 'difference': dd, 'reason': f'{js_num(x)} differs from {js_num(label)} by {js_num(dd)}, above the tolerance {js_num(float(tol))}'}


def o_extraction(labels, preds, fields):
    pm = {p['id']: p['fields'] for p in preds}
    cells, per = [], []
    for l in labels:
        pf = pm.get(l['id'], {})
        row = {'id': l['id'], 'predicted': l['id'] in pm, 'fields': {}}
        for f in fields:
            c = score_cell(f, l['fields'].get(f['name']), pf.get(f['name']))
            row['fields'][f['name']] = c
            cells.append({'field': f['name'], **c})
        per.append(row)

    def tally(cs):
        t = {o: sum(1 for c in cs if c['outcome'] == o) for o in ('correct', 'wrong', 'missed', 'unsupported')}
        cf = sum(1 for c in cs if c['outcome'] == 'correct' and not c.get('empty'))
        pf_ = cf + t['wrong'] + t['unsupported']
        lf = cf + t['wrong'] + t['missed']
        return {'n': len(cs), **t, 'correctEmpty': t['correct'] - cf, 'accuracy': F(t['correct'], len(cs)),
                'precision': F(cf, pf_) if pf_ else None, 'recall': F(cf, lf) if lf else None}
    pfield = []
    for f in fields:
        cs = [c for c in cells if c['field'] == f['name']]
        o = {'field': f['name'], 'type': f['type'], **tally(cs)}
        if f['type'] == 'text':
            o['meanF1'] = sum(c['f1'] for c in cs) / len(cs)
        else:
            o['absTol'] = f.get('absTol', 0)
            o['relTol'] = f.get('relTol', 0)
        pfield.append(o)
    ov = tally(cells)
    ov['microAccuracy'] = ov['accuracy']
    ov['macroAccuracy'] = sum(f['accuracy'] for f in pfield) / len(pfield)
    return deep({'nRecords': len(labels), 'nPredicted': len(preds), 'perRecord': per, 'perField': pfield, 'overall': ov})


def claim_out(c):
    o = dict(c)
    if o['kind'] == 'number':
        o['value'] = float(o['value'])
    return o


def o_ground(answer, citations, docs, retrieved=None, rel=0):
    facts = {d['id']: passage_facts(d['text']) for d in docs}
    r = ground(answer, citations, facts, None if retrieved is None else set(retrieved), rel)
    r['claims'] = [claim_out(c) for c in r['claims']]
    r['numericRelTol'] = rel
    return deep(r)


def o_answers(answers, docs, runs=None, rel=0):
    facts = {d['id']: passage_facts(d['text']) for d in docs}
    per = []
    for a in answers:
        g = ground(a['text'], a['citations'], facts, None if runs is None else set(runs[a['query']]), rel)
        g['claims'] = [claim_out(c) for c in g['claims']]
        per.append({'query': a['query'], **g})
    nc = sum(p['nClaims'] for p in per)
    ns = sum(p['nSupported'] for p in per)
    wc = [p for p in per if p['nClaims']]
    by = {kd: {'claims': sum(1 for p in per for c in p['claims'] if c['kind'] == kd),
               'supported': sum(1 for p in per for c in p['claims'] if c['kind'] == kd and c['supported'])} for kd in ('number', 'date', 'quote')}
    out = {
        'nAnswers': len(answers), 'nClaims': nc, 'nSupported': ns, 'supportedFraction': F(ns, nc) if nc else None,
        'meanAnswerSupportedFraction': sum(p['supportedFraction'] for p in wc) / len(wc) if wc else None,
        'fullySupportedAnswers': sum(1 for p in wc if p['nSupported'] == p['nClaims']), 'answersWithClaims': len(wc),
        'unknownCitations': sum(1 for p in per for c in p['citations'] if c['status'] == 'unknown'),
        'notRetrievedCitations': sum(1 for p in per for c in p['citations'] if c['status'] == 'notRetrieved'),
        'byKind': by, 'perAnswer': per, 'numericRelTol': rel,
    }
    if not nc:
        out['note'] = 'no answer has a checkable claim, so the supported fractions are undefined'
    return deep(out)


def o_kappa(a, b, labels=None, weights='none'):
    if labels is None:
        vals = set(a) | set(b)
        labels = sorted(vals) if isinstance(a[0], (int, float)) else sorted(vals, key=js_key)
    r = kappa(a, b, labels, weights)
    if r['kappa'] is None:
        first = next(i for i, v in enumerate(r['rowTotals']) if v > 0)
        r['note'] = f'kappa is undefined: both raters gave every item the same label ({labels[first]}), so the expected disagreement is 0'
    return deep(r)


def o_calibration(y, p, M=10, eps=None):
    r = calibration(y, p, M, 1e-15 if eps is None else eps)
    return deep(r)


def o_boot(values, n_boot, seed, level):
    reps = bootstrap_mean(values, n_boot, seed, level)
    lo, hi, se, plo, phi = boot_interval(reps, level)
    out = {'n': len(values), 'mean': sum(F(v) for v in values) / len(values), 'nBoot': n_boot, 'seed': seed, 'level': level,
           'lower': lo, 'upper': hi, 'standardError': se,
           'labels': {'lower': f'{plo}th percentile of the bootstrap mean', 'upper': f'{phi}th percentile of the bootstrap mean'}}
    if n_boot == 1:
        out['note'] = 'one replicate: the standard error is undefined'
    return deep(out)


def share_at_or_below(reps, a, b, n_boot, seed, paired):
    near = [i for i, r in enumerate(reps) if abs(r) < F(1, 10 ** 9)]
    fr = float_rep_sign(a, b, n_boot, seed, paired) if near else None
    cnt = 0
    for i, r in enumerate(reps):
        cnt += 1 if (fr[i] <= 0 if i in near else r <= 0) else 0
    return cnt


def o_paired(a, b, n_boot, seed, level, paired=True):
    reps = paired_reps(a, b, n_boot, seed, paired)
    lo, hi, se, plo, phi = boot_interval(reps, level)
    d = [F(float(x) - float(y)) for x, y in zip(a, b)]
    out = {'n': len(a), 'meanA': sum(F(v) for v in a) / len(a), 'meanB': sum(F(v) for v in b) / len(b), 'difference': sum(d) / len(d),
           'paired': paired, 'nBoot': n_boot, 'seed': seed, 'level': level, 'lower': lo, 'upper': hi, 'standardError': se,
           'labels': {'lower': f'{plo}th percentile of the bootstrap difference', 'upper': f'{phi}th percentile of the bootstrap difference'},
           'shareAtOrBelowZero': F(share_at_or_below(reps, a, b, n_boot, seed, paired), n_boot)}
    if n_boot == 1:
        out['note'] = 'one replicate: the standard error is undefined'
    return deep(out)


# ------------------------------------------------------------------ cases

class Cases:
    def __init__(self):
        self.cases = []

    def add(self, cid, fn, args, expected, tol=TOL, note=None, abs_floor=None):
        assert cid not in {c['id'] for c in self.cases}, cid
        c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected, 'tol': tol}
        if abs_floor is not None:
            c['abs'] = abs_floor
        if note:
            c['note'] = note
        self.cases.append(c)

    def refuse(self, cid, fn, args, field, message, note=None):
        self.add(cid, fn, args, {'error': True, 'field': field, 'message': message}, note=note)


def load(name):
    return json.load(open(os.path.join(FIX, name)))


SMALL = [
    {'id': 'd1', 'text': 'Oil rate 120 bopd at Ekene-1. Oil rate fell.'},
    {'id': 'd2', 'text': 'Water injection at Ekene-2 started on 2023-01-01.'},
    {'id': 'd3', 'text': 'Oil and water rates were tested; the oil rate was 150 bopd.'},
    {'id': 'd4', 'text': 'Pressure survey: 2,096 psia.'},
    {'id': 'd5', 'text': ''},
]


def build():
    c = Cases()
    corpus = [{'id': p['id'], 'text': p['text']} for p in load('corpus.json')['passages']]
    Qs = load('queries.json')['queries']
    qlist = [{'id': q['id'], 'text': q['text']} for q in Qs]
    judg = {q['id']: q['judgments'] for q in Qs}
    qtext = {q['id']: q['text'] for q in Qs}
    systems = {s['id']: s for s in load('systems.json')['systems']}
    X = load('extraction.json')
    cal = load('calibration.json')['rows']

    # ---------------- tokenize
    T = lambda cid, text, stop=False, note=None: c.add(cid, 'tokenize', {'text': text, 'stopWords': stop}, o_tokenize(text, stop), note=note)
    T('tok-basic', 'Ekene-3 flowed 1.25 MMscf/d; Top WELL at 1548 m TVD.', note='"1.25" gives 1 and 25; "Ekene-3" gives ekene and 3')
    T('tok-stop', 'Ekene-3 flowed 1.25 MMscf/d; Top WELL at 1548 m TVD.', True, note="the stop list removes 'top' and 'well'")
    T('tok-accents', 'Café déjà-vu ÉKENE — Ekene²', note='only ASCII A-Z is lowercased; every other character outside [a-z0-9] separates')
    T('tok-empty', '')
    T('tok-only-stop', 'the well is on top of the', True)
    T('tok-underscore', 'EK1_P and EK1-P / x2', note='the underscore separates too')
    Rt = lambda cid, args, field, msg: c.refuse(cid, 'tokenize', args, field, msg)
    Rt('tok-text-number', {'text': 42}, 'text', 'text must be a string')
    Rt('tok-text-long', {'text': 'a' * 20001}, 'text', 'text has 20001 characters, above the 20000 this engine accepts')
    Rt('tok-stop-string', {'text': 'x', 'stopWords': 'yes'}, 'stopWords', 'stopWords must be true or false')

    # ---------------- BM25
    B = lambda cid, docs, query, note=None, **kw: c.add(cid, 'rankBm25', {'documents': docs, 'query': query, **kw},
                                                      o_bm25(docs, query, kw.get('k', 10), kw.get('k1', 1.2), kw.get('b', 0.75), kw.get('stopWords', False)), note=note, abs_floor=1e-12)
    B('bm25-small', SMALL, 'oil rate')
    B('bm25-small-b0', SMALL, 'oil rate', b=0, note='b = 0: no length normalisation')
    B('bm25-small-k1-0', SMALL, 'oil rate water', k1=0, note='k1 = 0: each matched term scores its idf')
    B('bm25-small-repeated-query', SMALL, 'oil oil OIL rate', note='a repeated query word counts once')
    B('bm25-small-no-token', SMALL, '!!! --', note='no token: nothing ranked, with the reason')
    B('bm25-small-no-match', SMALL, 'helicopter', note='no document contains a query term')
    B('bm25-small-k1', SMALL, 'oil rate', k=1)
    for qid in ('Q01', 'Q02', 'Q05', 'Q10', 'Q14', 'Q24'):
        B(f'bm25-ekene-{qid}', corpus, qtext[qid], k=10)
    B('bm25-ekene-Q10-k1-tie-at-cutoff', corpus, qtext['Q10'], k=1, note='EKD-046 and EKD-058 are the same text: they tie, id ascending, and k = 1 cuts the tie')
    B('bm25-ekene-Q11-stop', corpus, qtext['Q11'], k=10, stopWords=True)
    B('bm25-ekene-Q06-b0', corpus, qtext['Q06'], k=10, b=0)
    B('bm25-ekene-Q06-b1', corpus, qtext['Q06'], k=10, b=1)
    B('bm25-ekene-Q13-k1-2', corpus, qtext['Q13'], k=10, k1=2.0)
    B('bm25-ekene-Q12-k1-0', corpus, qtext['Q12'], k=10, k1=0)
    Rb = lambda cid, args, field, msg: c.refuse(cid, 'rankBm25', args, field, msg)
    Rb('bm25-docs-missing', {'query': 'x'}, 'documents', 'documents must be a non-empty array of { id, text }')
    Rb('bm25-docs-empty', {'documents': [], 'query': 'x'}, 'documents', 'documents must be a non-empty array of { id, text }')
    Rb('bm25-doc-not-object', {'documents': [SMALL[0], 'text'], 'query': 'x'}, 'documents[1]', 'documents[1] must be an object { id, text }')
    Rb('bm25-doc-id-empty', {'documents': [{'id': '', 'text': 'x'}], 'query': 'x'}, 'documents[0].id', 'documents[0].id must be a non-empty string')
    Rb('bm25-doc-id-number', {'documents': [{'id': 7, 'text': 'x'}], 'query': 'x'}, 'documents[0].id', 'documents[0].id must be a non-empty string')
    Rb('bm25-doc-id-repeat', {'documents': [SMALL[0], SMALL[1], {'id': 'd1', 'text': 'y'}], 'query': 'x'}, 'documents[2].id', 'documents[2].id repeats d1 (documents[0])')
    Rb('bm25-doc-text-null', {'documents': [{'id': 'a', 'text': None}], 'query': 'x'}, 'documents[0].text', 'documents[0].text must be a string')
    Rb('bm25-doc-text-long', {'documents': [{'id': 'a', 'text': 'b' * 20001}], 'query': 'x'}, 'documents[0].text', 'documents[0].text has 20001 characters, above the 20000 this engine accepts')
    Rb('bm25-docs-too-many', {'documents': [{'id': f'x{i}', 'text': 'a'} for i in range(5001)], 'query': 'a'}, 'documents', 'documents has 5001 entries, above the 5000 this engine accepts')
    Rb('bm25-query-missing', {'documents': SMALL}, 'query', 'query must be a string')
    Rb('bm25-k-0', {'documents': SMALL, 'query': 'x', 'k': 0}, 'k', 'k must be a whole number from 1 to 1000')
    Rb('bm25-k-1001', {'documents': SMALL, 'query': 'x', 'k': 1001}, 'k', 'k must be a whole number from 1 to 1000')
    Rb('bm25-k1-negative', {'documents': SMALL, 'query': 'x', 'k1': -0.1}, 'k1', 'k1 must be a finite number, 0 or more (0 scores each matched term at its idf)')
    Rb('bm25-b-above-1', {'documents': SMALL, 'query': 'x', 'b': 1.5}, 'b', 'b must be a number from 0 to 1 (0 removes length normalisation)')
    Rb('bm25-stop-string', {'documents': SMALL, 'query': 'x', 'stopWords': 1}, 'stopWords', 'stopWords must be true or false')
    Rb('bm25-corpus-no-token', {'documents': [{'id': 'a', 'text': '!!'}, {'id': 'b', 'text': ''}], 'query': 'x'}, 'documents', 'documents has no token in any text: BM25 needs an average document length above 0')
    Rb('bm25-corpus-only-stop', {'documents': [{'id': 'a', 'text': 'the well'}], 'query': 'x', 'stopWords': True}, 'documents', 'documents has no token in any text after the stop list: BM25 needs an average document length above 0')

    # ---------------- TF-IDF
    TV = lambda cid, docs, note=None, **kw: c.add(cid, 'tfidfVectors', {'documents': docs, **kw}, o_tfidf_vectors(docs, kw.get('stopWords', False), kw.get('sublinearTf', False)), note=note, abs_floor=1e-12)
    TV('tfidf-vectors-small', SMALL, note='d5 has no token: a zero vector with norm 0')
    TV('tfidf-vectors-small-sublinear', SMALL, sublinearTf=True)
    TV('tfidf-vectors-ekene-first-12', corpus[:12])
    c.refuse('tfidf-vectors-empty-vocab', 'tfidfVectors', {'documents': [{'id': 'a', 'text': '...'}]}, 'documents', 'documents has no token in any text: the vocabulary is empty')
    c.refuse('tfidf-vectors-sublinear-string', 'tfidfVectors', {'documents': SMALL, 'sublinearTf': 'no'}, 'sublinearTf', 'sublinearTf must be true or false')
    TF = lambda cid, docs, query, note=None, **kw: c.add(cid, 'rankTfidf', {'documents': docs, 'query': query, **kw},
                                                        o_tfidf(docs, query, kw.get('k', 10), kw.get('stopWords', False), kw.get('sublinearTf', False)), note=note, abs_floor=1e-12)
    TF('tfidf-small', SMALL, 'oil rate')
    TF('tfidf-small-dropped', SMALL, 'oil rate helicopter', note='helicopter is outside the vocabulary and dropped')
    TF('tfidf-small-no-vocab', SMALL, 'helicopter', note='no query term in the vocabulary')
    TF('tfidf-small-no-token', SMALL, '  ')
    for qid in ('Q01', 'Q02', 'Q05', 'Q10', 'Q14', 'Q24'):
        TF(f'tfidf-ekene-{qid}', corpus, qtext[qid], k=10)
    TF('tfidf-ekene-Q13-sublinear', corpus, qtext['Q13'], k=10, sublinearTf=True)
    TF('tfidf-ekene-Q11-stop', corpus, qtext['Q11'], k=10, stopWords=True)
    Rf = lambda cid, args, field, msg: c.refuse(cid, 'rankTfidf', args, field, msg)
    Rf('tfidf-k-fraction', {'documents': SMALL, 'query': 'oil', 'k': 2.5}, 'k', 'k must be a whole number from 1 to 1000')
    Rf('tfidf-query-null', {'documents': SMALL, 'query': None}, 'query', 'query must be a string')
    Rf('tfidf-corpus-no-token', {'documents': [{'id': 'a', 'text': '--'}], 'query': 'x'}, 'documents', 'documents has no token in any text: the vocabulary is empty')

    # ---------------- retrieve
    R = lambda cid, method, note=None, **kw: c.add(cid, 'retrieve', {'documents': corpus, 'queries': qlist, 'method': method, **kw},
                                                  o_retrieve(corpus, qlist, method, kw.get('k', 10), kw.get('k1', 1.2), kw.get('b', 0.75), kw.get('stopWords', False), kw.get('sublinearTf', False)), note=note, abs_floor=1e-12)
    R('retrieve-bm25-k5', 'bm25', k=5, note="system A's retriever")
    R('retrieve-tfidf-k5', 'tfidf', k=5, note="system B's retriever")
    R('retrieve-bm25-k10', 'bm25', k=10)
    R('retrieve-tfidf-k10', 'tfidf', k=10)
    R('retrieve-bm25-b04-stop', 'bm25', k=10, b=0.4, stopWords=True)
    R('retrieve-tfidf-sublinear', 'tfidf', k=10, sublinearTf=True)
    Rr = lambda cid, args, field, msg: c.refuse(cid, 'retrieve', args, field, msg)
    Rr('retrieve-method-bad', {'documents': corpus[:3], 'queries': qlist[:1], 'method': 'dense'}, 'method', "method must be 'bm25' or 'tfidf'")
    Rr('retrieve-queries-empty', {'documents': corpus[:3], 'queries': [], 'method': 'bm25'}, 'queries', 'queries must be a non-empty array of { id, text }')
    Rr('retrieve-query-id-repeat', {'documents': corpus[:3], 'queries': [qlist[0], qlist[1], qlist[0]], 'method': 'bm25'}, 'queries[2].id', 'queries[2].id repeats Q01 (queries[0])')
    Rr('retrieve-query-text-number', {'documents': corpus[:3], 'queries': [{'id': 'q', 'text': 3}], 'method': 'tfidf'}, 'queries[0].text', 'queries[0].text must be a string')
    Rr('retrieve-query-not-object', {'documents': corpus[:3], 'queries': ['oil'], 'method': 'tfidf'}, 'queries[0]', 'queries[0] must be an object { id, text }')
    Rr('retrieve-k1-on-tfidf', {'documents': corpus[:3], 'queries': qlist[:1], 'method': 'tfidf', 'k1': 1.5}, 'k1', "k1 applies to 'bm25' only")
    Rr('retrieve-b-on-tfidf', {'documents': corpus[:3], 'queries': qlist[:1], 'method': 'tfidf', 'b': 0.5}, 'b', "b applies to 'bm25' only")
    Rr('retrieve-sublinear-on-bm25', {'documents': corpus[:3], 'queries': qlist[:1], 'method': 'bm25', 'sublinearTf': False}, 'sublinearTf', "sublinearTf applies to 'tfidf' only")
    Rr('retrieve-too-many-queries', {'documents': corpus[:3], 'queries': [{'id': f'q{i}', 'text': 'x'} for i in range(1001)], 'method': 'bm25'}, 'queries', 'queries has 1001 entries, above the 1000 this engine accepts')

    # ---------------- retrieval metrics
    J = {'a': 3, 'b': 2, 'c': 0, 'd': 1, 'e': 2}
    M_ = lambda cid, ranking, judgments, note=None, **kw: c.add(cid, 'retrievalMetrics', {'ranking': ranking, 'judgments': judgments, **kw},
                                                               o_metrics(ranking, judgments, kw.get('k', 10), kw.get('relevantGrade', 1), kw.get('gain', 'linear')), note=note, abs_floor=1e-12)
    M_('met-basic-k5', ['c', 'a', 'x', 'b', 'd'], J, k=5, note='x is unjudged (grade 0)')
    M_('met-ideal', ['a', 'b', 'e', 'd', 'c'], J, k=5, note='the ideal order: nDCG 1')
    M_('met-reversed', ['c', 'd', 'e', 'b', 'a'], J, k=5)
    M_('met-short-ranking', ['b'], J, k=5, note='P@5 divides by 5 although one document is ranked')
    M_('met-empty-ranking', [], J, k=3)
    M_('met-grade2', ['c', 'a', 'x', 'b', 'd'], J, k=5, relevantGrade=2)
    M_('met-exponential', ['c', 'a', 'x', 'b', 'd'], J, k=5, gain='exponential')
    M_('met-k-cut', ['c', 'x', 'y', 'a', 'b'], J, k=3, note='the relevant documents sit below the cutoff: RR 0')
    M_('met-no-relevant', ['a', 'b'], {'a': 0, 'b': 0}, k=2, note='every judged grade is 0: recall, AP and nDCG undefined')
    M_('met-grade1-only-t2', ['a', 'b'], {'a': 1, 'b': 0}, k=2, relevantGrade=2, note='no grade 2 or more, but a grade 1 gives nDCG a value')
    M_('met-empty-judgments', ['a'], {}, k=1)
    Rm = lambda cid, args, field, msg: c.refuse(cid, 'retrievalMetrics', args, field, msg)
    Rm('met-ranking-dup', {'ranking': ['a', 'b', 'a'], 'judgments': J}, 'ranking[2]', 'ranking[2] repeats a (ranking[0]): a document is ranked once')
    Rm('met-ranking-not-array', {'ranking': 'a', 'judgments': J}, 'ranking', 'ranking must be an array of document ids, best first')
    Rm('met-ranking-empty-id', {'ranking': ['a', ''], 'judgments': J}, 'ranking[1]', 'ranking[1] must be a non-empty string')
    Rm('met-judgments-array', {'ranking': ['a'], 'judgments': [3]}, 'judgments', 'judgments must be an object mapping document id to grade')
    Rm('met-grade-fraction', {'ranking': ['a'], 'judgments': {'a': 1.5}}, 'judgments.a', 'judgments.a must be a whole-number grade from 0 to 10')
    Rm('met-grade-11', {'ranking': ['a'], 'judgments': {'a': 11}}, 'judgments.a', 'judgments.a must be a whole-number grade from 0 to 10')
    Rm('met-grade-negative', {'ranking': ['a'], 'judgments': {'a': -1}}, 'judgments.a', 'judgments.a must be a whole-number grade from 0 to 10')
    Rm('met-relevant-0', {'ranking': ['a'], 'judgments': J, 'relevantGrade': 0}, 'relevantGrade', 'relevantGrade must be a whole number from 1 to 10')
    Rm('met-gain-bad', {'ranking': ['a'], 'judgments': J, 'gain': 'log'}, 'gain', "gain must be 'linear' or 'exponential'")
    Rm('met-k-string', {'ranking': ['a'], 'judgments': J, 'k': '5'}, 'k', 'k must be a whole number from 1 to 1000')

    runsA = {a['query']: a['retrieved'] for a in systems['A']['answers']}
    runsB = {a['query']: a['retrieved'] for a in systems['B']['answers']}
    EV = lambda cid, runs, judgments, note=None, **kw: c.add(cid, 'evaluateRetrieval', {'runs': runs, 'judgments': judgments, **kw},
                                                            o_evaluate(runs, judgments, kw.get('k', 10), kw.get('relevantGrade', 1), kw.get('gain', 'linear'), kw.get('noRelevant', 'exclude')), note=note, abs_floor=1e-12)
    EV('eval-A-k5', runsA, judg, k=5, note='system A; Q24 has no relevant passage and is excluded')
    EV('eval-B-k5', runsB, judg, k=5)
    EV('eval-A-k5-zero', runsA, judg, k=5, noRelevant='zero', note="Q24 kept with each undefined metric scored 0")
    EV('eval-B-k3-grade2', runsB, judg, k=3, relevantGrade=2)
    EV('eval-A-k5-exponential', runsA, judg, k=5, gain='exponential')
    EV('eval-all-no-relevant', {'q1': ['a'], 'q2': []}, {'q2': {'a': 0}, 'q1': {'b': 0}}, k=2, note='no included query: every mean null; queries in id order')
    Re = lambda cid, args, field, msg: c.refuse(cid, 'evaluateRetrieval', args, field, msg)
    Re('eval-run-missing', {'runs': {'q1': ['a']}, 'judgments': {'q1': {'a': 1}, 'q2': {'a': 1}}}, 'runs', 'runs has no ranking for query q2 (every judged query needs one; an empty array is a ranking that retrieved nothing)')
    Re('eval-run-extra', {'runs': {'q1': ['a'], 'q9': ['b']}, 'judgments': {'q1': {'a': 1}}}, 'runs.q9', 'runs.q9 has no judgments: every ranked query needs judgments')
    Re('eval-run-dup', {'runs': {'q1': ['a', 'a']}, 'judgments': {'q1': {'a': 1}}}, 'runs.q1[1]', 'runs.q1[1] repeats a (runs.q1[0]): a document is ranked once')
    Re('eval-judgments-empty', {'runs': {}, 'judgments': {}}, 'judgments', 'judgments must be a non-empty object mapping query id to { document id: grade }')
    Re('eval-runs-array', {'runs': [], 'judgments': {'q1': {'a': 1}}}, 'runs', 'runs must be an object mapping query id to an array of document ids')
    Re('eval-grade-bad', {'runs': {'q1': ['a']}, 'judgments': {'q1': {'a': 'high'}}}, 'judgments.q1.a', 'judgments.q1.a must be a whole-number grade from 0 to 10')
    Re('eval-no-relevant-bad', {'runs': {'q1': ['a']}, 'judgments': {'q1': {'a': 1}}, 'noRelevant': 'skip'}, 'noRelevant', "noRelevant must be 'exclude' or 'zero'")

    # ---------------- answers
    for text in ('The Ekene-3 well!', '  A  well   test, the 12.4 ppg mud. ', 'An anticline', '45.0 percent', 'the', ''):
        c.add(f'norm-{len(c.cases)}', 'normalizeAnswer', {'text': text}, o_normalize(text))
    c.refuse('norm-text-null', 'normalizeAnswer', {'text': None}, 'text', 'text must be a string')
    refs = {q['id']: q['reference'] for q in Qs}
    for sid in ('A', 'B'):
        for a in systems[sid]['answers']:
            c.add(f'match-{sid}-{a["query"]}', 'answerMatch', {'prediction': a['short'], 'truth': refs[a['query']]}, o_answer(a['short'], refs[a['query']]))
    c.add('match-repeated-tokens', 'answerMatch', {'prediction': 'oil oil oil water', 'truth': 'oil water water'}, o_answer('oil oil oil water', 'oil water water'), note='multiset overlap: common = 2')
    c.add('match-article-only', 'answerMatch', {'prediction': 'the', 'truth': ''}, o_answer('the', ''), note='"the" normalises to empty: both empty, F1 1')
    c.refuse('match-truth-number', 'answerMatch', {'prediction': 'x', 'truth': 5}, 'truth', 'truth must be a string')

    # ---------------- extraction
    EX = lambda cid, labels, preds, fields, note=None: c.add(cid, 'scoreExtraction', {'labels': labels, 'predictions': preds, 'fields': fields}, o_extraction(labels, preds, fields), note=note, abs_floor=1e-12)
    EX('ext-A', X['labels'], X['predictions']['A'], X['fields'], note='system A')
    EX('ext-B', X['labels'], X['predictions']['B'], X['fields'], note='system B (two records not returned)')
    EX('ext-none-predicted', X['labels'], [], X['fields'], note='no prediction at all: every filled label missed')
    F2 = [{'name': 'q', 'type': 'number', 'relTol': 0.01}, {'name': 'p', 'type': 'number', 'absTol': 2, 'relTol': 0.001}, {'name': 'w', 'type': 'text'}]
    L2 = [{'id': 'r1', 'fields': {'q': 100, 'p': 3000, 'w': 'Ekene-1'}}, {'id': 'r2', 'fields': {'q': 50, 'p': 1000, 'w': ''}}, {'id': 'r3', 'fields': {'q': -4}}]
    P2 = [{'id': 'r1', 'fields': {'q': '101', 'p': '3,003', 'w': ' ekene-1 '}}, {'id': 'r2', 'fields': {'q': 50.6, 'p': 1002.5, 'w': '   '}}, {'id': 'r3', 'fields': {'q': '-4.00', 'p': '1,00', 'w': 'The'}}]
    EX('ext-tolerances', L2, P2, F2, note='relTol 1 percent of 100 is 1: 101 matches; max(2, 0.001 x 3000 = 3) = 3: 3,003 matches; 1002.5 is beyond max(2, 1); "1,00" is not a plain number; "The" normalises to empty but is not blank, so it is a value')
    Rx = lambda cid, args, field, msg: c.refuse(cid, 'scoreExtraction', args, field, msg)
    L1 = [{'id': 'r1', 'fields': {'q': 1}}]
    FQ = [{'name': 'q', 'type': 'number'}]
    Rx('ext-fields-empty', {'labels': L1, 'predictions': [], 'fields': []}, 'fields', 'fields must be a non-empty array of { name, type }')
    Rx('ext-field-dup', {'labels': L1, 'predictions': [], 'fields': FQ + FQ}, 'fields[1].name', 'fields[1].name repeats q (fields[0])')
    Rx('ext-field-type', {'labels': L1, 'predictions': [], 'fields': [{'name': 'q', 'type': 'date'}]}, 'fields[0].type', "fields[0].type must be 'text' or 'number'")
    Rx('ext-abstol-text', {'labels': L1, 'predictions': [], 'fields': [{'name': 'q', 'type': 'text', 'absTol': 1}]}, 'fields[0].absTol', "fields[0].absTol applies to 'number' fields only")
    Rx('ext-reltol-negative', {'labels': L1, 'predictions': [], 'fields': [{'name': 'q', 'type': 'number', 'relTol': -0.1}]}, 'fields[0].relTol', 'fields[0].relTol must be a finite number, 0 or more')
    Rx('ext-labels-empty', {'labels': [], 'predictions': [], 'fields': FQ}, 'labels', 'labels must hold at least 1 labelled record')
    Rx('ext-labels-not-array', {'labels': {}, 'predictions': [], 'fields': FQ}, 'labels', 'labels must be an array of { id, fields }')
    Rx('ext-label-number-string', {'labels': [{'id': 'r1', 'fields': {'q': '12'}}], 'predictions': [], 'fields': FQ}, 'labels[0].fields.q', 'labels[0].fields.q must be a finite number or empty')
    Rx('ext-label-text-number', {'labels': [{'id': 'r1', 'fields': {'w': 12}}], 'predictions': [], 'fields': [{'name': 'w', 'type': 'text'}]}, 'labels[0].fields.w', 'labels[0].fields.w must be a string or empty')
    Rx('ext-label-dup', {'labels': L1 + L1, 'predictions': [], 'fields': FQ}, 'labels[1].id', 'labels[1].id repeats r1 (labels[0])')
    Rx('ext-label-unknown-field', {'labels': [{'id': 'r1', 'fields': {'z': 1}}], 'predictions': [], 'fields': FQ}, 'labels[0].fields.z', 'labels[0].fields.z is not one of the fields')
    Rx('ext-pred-unknown-id', {'labels': L1, 'predictions': [{'id': 'r9', 'fields': {}}], 'fields': FQ}, 'predictions[0].id', 'predictions[0].id is r9, which is not a labelled record')
    Rx('ext-pred-bool', {'labels': L1, 'predictions': [{'id': 'r1', 'fields': {'q': True}}], 'fields': FQ}, 'predictions[0].fields.q', 'predictions[0].fields.q must be a number, a string or empty')
    Rx('ext-pred-fields-missing', {'labels': L1, 'predictions': [{'id': 'r1'}], 'fields': FQ}, 'predictions[0].fields', 'predictions[0].fields must be an object mapping field name to value')

    # ---------------- groundedness
    G = lambda cid, answer, citations, docs, note=None, **kw: c.add(cid, 'checkGroundedness', {'answer': answer, 'citations': citations, 'documents': docs, **kw},
                                                                   o_ground(answer, citations, docs, kw.get('retrieved'), kw.get('numericRelTol', 0)), note=note)
    G('ground-small-mixed', 'Ekene-1 made 120 bopd; the survey read 2,096 psia on 2023-01-01, a "water injection" start, and 45% water, -2 skin.', ['d1', 'd4'], SMALL, retrieved=['d1', 'd2', 'd4'],
      note='120 and 2,096 supported; the date and the quote are in d2, retrieved but not cited; 45 and -2 appear nowhere')
    G('ground-small-no-retrieved', 'The oil rate was 150 bopd on 2023-01-01.', ['d3'], SMALL, note='no retrieved list: every cited passage of the corpus counts')
    G('ground-small-cited-not-retrieved', 'The oil rate was 150 bopd.', ['d3', 'd9'], SMALL, retrieved=['d1'], note='d3 cited but not retrieved; d9 unknown')
    G('ground-small-no-citation', 'It made 120 bopd.', [], SMALL, retrieved=['d1'])
    G('ground-small-no-claim', 'The well flows naturally.', ['d1'], SMALL, retrieved=['d1'])
    G('ground-small-identifiers', 'EK1-P, Ekene-4, P01 and x/2 are identifiers; 2023-01-01x is not a date; 120.', ['d1'], SMALL, retrieved=['d1'],
      note='numbers glued to letters or joined by - _ / to an alphanumeric are identifiers; a date touching a letter is read as numbers')
    G('ground-small-curly-quote', 'The note says “oil rate fell” and "Oil Rate 120".', ['d1'], SMALL, retrieved=['d1'], note='quotes match by tokens: case and punctuation do not matter')
    G('ground-small-unbalanced-quote', 'He wrote "oil rate and 120 bopd.', ['d1'], SMALL, retrieved=['d1'], note='an unclosed quote is plain text')
    G('ground-small-thousands', '12,1234 and 1,234,567.5 and 0.50', ['d1'], SMALL, retrieved=['d1'], note='a comma group needs exactly three digits: 12,1234 reads as 12 and 1234; 0.50 prints its value 0.5')
    G('ground-small-reltol', 'About 2,100 psia.', ['d4'], SMALL, retrieved=['d4'], numericRelTol=0.002, note='|2100 - 2096| = 4 <= 0.002 x 2096 = 4.192')
    G('ground-small-reltol-tight', 'About 2,100 psia.', ['d4'], SMALL, retrieved=['d4'], numericRelTol=0.001)
    G('ground-small-duplicate-citation', 'It made 120 bopd.', ['d1', 'd1'], SMALL, retrieved=['d1'], note='a repeated citation counts once')
    Rg = lambda cid, args, field, msg: c.refuse(cid, 'checkGroundedness', args, field, msg)
    Rg('ground-answer-null', {'answer': None, 'citations': [], 'documents': SMALL}, 'answer', 'answer must be a string')
    Rg('ground-citations-string', {'answer': 'x', 'citations': 'd1', 'documents': SMALL}, 'citations', 'citations must be an array of passage ids')
    Rg('ground-citation-empty', {'answer': 'x', 'citations': ['d1', ''], 'documents': SMALL}, 'citations[1]', 'citations[1] must be a non-empty string')
    Rg('ground-retrieved-dup', {'answer': 'x', 'citations': [], 'documents': SMALL, 'retrieved': ['d1', 'd1']}, 'retrieved[1]', 'retrieved[1] repeats d1 (retrieved[0]): a document is ranked once')
    Rg('ground-reltol-1', {'answer': 'x', 'citations': [], 'documents': SMALL, 'numericRelTol': 1}, 'numericRelTol', 'numericRelTol must be a number from 0 (inclusive) to 1 (exclusive)')
    Rg('ground-docs-empty', {'answer': 'x', 'citations': [], 'documents': []}, 'documents', 'documents must be a non-empty array of { id, text }')

    ansA = [{'query': a['query'], 'text': a['text'], 'citations': a['citations']} for a in systems['A']['answers']]
    ansB = [{'query': a['query'], 'text': a['text'], 'citations': a['citations']} for a in systems['B']['answers']]
    GA = lambda cid, answers, runs, note=None, rel=0: c.add(cid, 'checkAnswers', {'answers': answers, 'documents': corpus, **({'runs': runs} if runs is not None else {}), **({'numericRelTol': rel} if rel else {})},
                                                          o_answers(answers, corpus, runs, rel), note=note)
    GA('answers-A', ansA, runsA, note='system A')
    GA('answers-B', ansB, runsB, note='system B')
    GA('answers-B-reltol', ansB, runsB, rel=0.002, note='system B with numbers matched within 0.2 percent: 2,100 psia is now supported')
    GA('answers-B-no-runs', ansB, None, note='without the retrieved lists every cited passage counts')
    GA('answers-no-claims', [{'query': 'q', 'text': 'Nothing to check.', 'citations': []}], None)
    Ra = lambda cid, args, field, msg: c.refuse(cid, 'checkAnswers', args, field, msg)
    Ra('answers-empty', {'answers': [], 'documents': SMALL}, 'answers', 'answers must be a non-empty array of { query, text, citations }')
    Ra('answers-dup-query', {'answers': [{'query': 'q', 'text': 'x', 'citations': []}] * 2, 'documents': SMALL}, 'answers[1].query', 'answers[1].query repeats q (answers[0]): one answer per query')
    Ra('answers-run-missing', {'answers': [{'query': 'q', 'text': 'x', 'citations': []}], 'documents': SMALL, 'runs': {}}, 'runs', 'runs has no retrieved list for query q (answers[0])')
    Ra('answers-text-missing', {'answers': [{'query': 'q', 'citations': []}], 'documents': SMALL}, 'answers[0].text', 'answers[0].text must be a string')
    Ra('answers-query-empty', {'answers': [{'query': '', 'text': 'x', 'citations': []}], 'documents': SMALL}, 'answers[0].query', 'answers[0].query must be a non-empty string')
    Ra('answers-runs-array', {'answers': [{'query': 'q', 'text': 'x', 'citations': []}], 'documents': SMALL, 'runs': []}, 'runs', 'runs must be an object mapping query id to an array of document ids')

    # ---------------- kappa
    ra, rb = [], []
    for q in Qs:
        for d in sorted(q['judgments'], key=js_key):
            ra.append(q['judgments'][d])
            rb.append(q['secondAnnotator'][d])
    K = lambda cid, a, b, note=None, **kw: c.add(cid, 'cohenKappa', {'a': a, 'b': b, **kw}, o_kappa(a, b, kw.get('labels'), kw.get('weights', 'none')), note=note)
    K('kappa-ekene-none', ra, rb, labels=[0, 1, 2, 3], note='the two annotators on every judged pair')
    K('kappa-ekene-linear', ra, rb, labels=[0, 1, 2, 3], weights='linear')
    K('kappa-ekene-quadratic', ra, rb, labels=[0, 1, 2, 3], weights='quadratic')
    K('kappa-ekene-quadratic-no-labels', ra, rb, weights='quadratic', note='labels from the ratings: 0, 1, 2, 3 all occur')
    K('kappa-strings', ['rel', 'rel', 'non', 'non', 'rel', 'non', 'rel', 'rel'], ['rel', 'non', 'non', 'non', 'rel', 'rel', 'rel', 'rel'])
    K('kappa-strings-ordered-linear', ['low', 'mid', 'high', 'mid', 'low'], ['mid', 'mid', 'high', 'low', 'low'], labels=['low', 'mid', 'high'], weights='linear')
    K('kappa-perfect', [0, 1, 2, 2, 1], [0, 1, 2, 2, 1], note='identical ratings: kappa 1')
    K('kappa-undefined', [2, 2, 2], [2, 2, 2], note='one shared label: expected disagreement 0')
    K('kappa-unused-label', [0, 1, 1, 0], [0, 1, 0, 0], labels=[0, 1, 2], weights='quadratic', note='a label nobody used still sets the weight positions')
    K('kappa-negative', [0, 1, 0, 1], [1, 0, 1, 0], note='systematic disagreement: kappa -1')
    Rk = lambda cid, args, field, msg: c.refuse(cid, 'cohenKappa', args, field, msg)
    Rk('kappa-a-empty', {'a': [], 'b': []}, 'a', 'a must be a non-empty array of ratings')
    Rk('kappa-b-length', {'a': [1, 2], 'b': [1]}, 'b', 'b must be an array of 2 ratings, one per item of a')
    Rk('kappa-b-length-one', {'a': [1], 'b': [1, 2]}, 'b', 'b must be an array of 1 rating, one per item of a')
    Rk('kappa-weights-bad', {'a': [1], 'b': [1], 'weights': 'cubic'}, 'weights', "weights must be 'none', 'linear' or 'quadratic'")
    Rk('kappa-mixed', {'a': [1, 'x'], 'b': [1, 1]}, 'a[1]', 'a[1] must be a finite number, like a[0]')
    Rk('kappa-b-mixed', {'a': ['x', 'y'], 'b': ['x', 2]}, 'b[1]', 'b[1] must be a non-empty string, like a[0]')
    Rk('kappa-a0-null', {'a': [None], 'b': [1]}, 'a[0]', 'a[0] must be a finite number or a non-empty string')
    Rk('kappa-strings-weighted-no-labels', {'a': ['x', 'y'], 'b': ['y', 'y'], 'weights': 'linear'}, 'labels', 'labels must be given in order for linear weights on string ratings (the weights use the label positions)')
    Rk('kappa-label-missing', {'a': [0, 1, 3], 'b': [0, 1, 1], 'labels': [0, 1, 2]}, 'a[2]', 'a[2] is 3, which is not one of labels')
    Rk('kappa-label-dup', {'a': [0], 'b': [0], 'labels': [0, 1, 0]}, 'labels[2]', 'labels[2] repeats 0')

    # ---------------- calibration
    yv = [r['relevant'] for r in cal]
    pv = [r['probability'] for r in cal]
    CB = lambda cid, y, p, note=None, **kw: c.add(cid, 'calibration', {'yTrue': y, 'probabilities': p, **kw}, o_calibration(y, p, kw.get('bins', 10), kw.get('eps')), note=note, abs_floor=1e-12)
    CB('cal-ekene-10', yv, pv, note='the relevance classifier, 10 bins; probabilities on the edges (0.3, 0.5, ...) go to the upper bin')
    CB('cal-ekene-5', yv, pv, bins=5)
    CB('cal-ekene-15', yv, pv, bins=15)
    CB('cal-ekene-1', yv, pv, bins=1, note='one bin: REL is (mean p - base rate)^2 and RES is 0')
    CB('cal-edges', [0, 1, 0, 1, 1, 0, 1], [0.0, 0.1, 0.2, 0.3, 0.7, 0.9, 1.0], bins=10, note='each probability sits on an edge: it opens its bin; 1.0 closes the last')
    CB('cal-perfect', [0, 0, 1, 1], [0.0, 0.0, 1.0, 1.0], note='perfect and sharp: Brier 0, both log-loss terms clipped')
    CB('cal-eps', [0, 1, 1], [0.2, 0.9999, 1.0], eps=0.001, note='eps passed to ml.js logLoss')
    CB('cal-within-bin', [1, 0, 1, 0, 1, 1], [0.61, 0.62, 0.64, 0.66, 0.68, 0.69], bins=10, note='one bin with spread: the within-bin terms are non-zero')
    Rc = lambda cid, args, field, msg: c.refuse(cid, 'calibration', args, field, msg)
    Rc('cal-y-empty', {'yTrue': [], 'probabilities': []}, 'yTrue', 'yTrue must be a non-empty array of 0 and 1 outcomes')
    Rc('cal-y-2', {'yTrue': [0, 2], 'probabilities': [0.1, 0.2]}, 'yTrue[1]', 'yTrue[1] must be 0 or 1')
    Rc('cal-y-bool', {'yTrue': [True], 'probabilities': [0.1]}, 'yTrue[0]', 'yTrue[0] must be 0 or 1')
    Rc('cal-p-length', {'yTrue': [0, 1], 'probabilities': [0.1]}, 'probabilities', 'probabilities must be an array of 2 numbers, one per outcome')
    Rc('cal-p-length-one', {'yTrue': [0], 'probabilities': []}, 'probabilities', 'probabilities must be an array of 1 number, one per outcome')
    Rc('cal-p-above-1', {'yTrue': [0, 1], 'probabilities': [0.1, 1.2]}, 'probabilities[1]', 'probabilities[1] must be a number from 0 to 1')
    Rc('cal-bins-0', {'yTrue': [0], 'probabilities': [0.1], 'bins': 0}, 'bins', 'bins must be a whole number from 1 to 100')
    Rc('cal-bins-101', {'yTrue': [0], 'probabilities': [0.1], 'bins': 101}, 'bins', 'bins must be a whole number from 1 to 100')
    Rc('cal-eps-bad', {'yTrue': [0], 'probabilities': [0.1], 'eps': 0.5}, 'eps', 'eps must be a number above 0 and below 0.5')

    # ---------------- bootstrap
    evA = o_evaluate(runsA, judg, 5)
    evB = o_evaluate(runsB, judg, 5)
    inc = [r['query'] for r in evA['perQuery'] if r['nRelevant'] > 0]
    nA = [r['ndcg'] for r in evA['perQuery'] if r['query'] in inc]
    nB = [r['ndcg'] for r in evB['perQuery'] if r['query'] in inc]
    aA = [r['averagePrecision'] for r in evA['perQuery'] if r['query'] in inc]
    aB = [r['averagePrecision'] for r in evB['perQuery'] if r['query'] in inc]
    BM = lambda cid, values, nb, seed, level=0.95, note=None: c.add(cid, 'bootstrapMean', {'values': values, 'nBoot': nb, 'seed': seed, 'level': level}, o_boot(values, nb, seed, level), note=note, abs_floor=1e-12)
    BM('boot-A-ndcg5', nA, 2000, 20260925, note='system A per-query nDCG@5 on the 23 included queries')
    BM('boot-B-ndcg5', nB, 2000, 20260925)
    BM('boot-A-ndcg5-level-0.8', nA, 2000, 1, 0.8)
    BM('boot-A-ndcg5-level-0.9-odd', nA, 1999, 1, 0.9, note='nBoot odd')
    BM('boot-A-ndcg5-level-0.99', nA, 1000, 5, 0.99)
    BM('boot-small', [0.2, 0.5, 0.9, 0.4], 1000, 1)
    BM('boot-one-replicate', [0.2, 0.5, 0.9], 1, 3, note='one replicate: both ends are that replicate; standard error undefined')
    BM('boot-constant', [0.5, 0.5, 0.5], 500, 1, note='constant values: every replicate equals the mean')
    PB = lambda cid, a, b, nb, seed, level=0.95, paired=True, note=None: c.add(cid, 'pairedBootstrap', {'a': a, 'b': b, 'nBoot': nb, 'seed': seed, 'level': level, 'paired': paired}, o_paired(a, b, nb, seed, level, paired), note=note, abs_floor=1e-12)
    PB('paired-ndcg5-A-B', nA, nB, 2000, 20260925, note='system A minus system B, nDCG@5, paired by query')
    PB('unpaired-ndcg5-A-B', nA, nB, 2000, 20260925, paired=False, note='the same data resampled independently: a wider interval')
    PB('paired-ap5-A-B', aA, aB, 2000, 11)
    PB('paired-identical', nA, nA, 500, 2, note='a system against itself: every replicate 0, share at or below zero 1')
    PB('paired-small', [0.2, 0.5, 0.9, 0.4], [0.1, 0.5, 0.7, 0.5], 1000, 1)
    Rbt = lambda cid, fn, args, field, msg: c.refuse(cid, fn, args, field, msg)
    Rbt('boot-values-one', 'bootstrapMean', {'values': [1], 'seed': 1}, 'values', 'values has 1 value: the bootstrap resamples at least 2')
    Rbt('boot-values-nan', 'bootstrapMean', {'values': [1, None], 'seed': 1}, 'values[1]', 'values[1] must be a finite number')
    Rbt('boot-values-not-array', 'bootstrapMean', {'values': 3, 'seed': 1}, 'values', 'values must be an array of numbers')
    Rbt('boot-values-too-many', 'bootstrapMean', {'values': [0.5] * 10001, 'seed': 1}, 'values', 'values has 10001 values, above the 10000 this engine accepts')
    Rbt('boot-nboot-0', 'bootstrapMean', {'values': [1, 2], 'seed': 1, 'nBoot': 0}, 'nBoot', 'nBoot must be a whole number from 1 to 100000')
    Rbt('boot-nboot-big', 'bootstrapMean', {'values': [1, 2], 'seed': 1, 'nBoot': 100001}, 'nBoot', 'nBoot must be a whole number from 1 to 100000')
    Rbt('boot-seed-missing', 'bootstrapMean', {'values': [1, 2]}, 'seed', 'seed must be a whole number from 0 to 4294967295')
    Rbt('boot-seed-negative', 'bootstrapMean', {'values': [1, 2], 'seed': -1}, 'seed', 'seed must be a whole number from 0 to 4294967295')
    Rbt('boot-level-bad', 'bootstrapMean', {'values': [1, 2], 'seed': 1, 'level': 0.975}, 'level', 'level must be 0.8, 0.9, 0.95 or 0.99')
    Rbt('paired-b-length', 'pairedBootstrap', {'a': [1, 2, 3], 'b': [1, 2], 'seed': 1}, 'b', 'b must have 3 values, one per value of a (the same queries in the same order)')
    Rbt('paired-a-short', 'pairedBootstrap', {'a': [1], 'b': [1], 'seed': 1}, 'a', 'a has 1 value: the bootstrap resamples at least 2')
    Rbt('paired-paired-string', 'pairedBootstrap', {'a': [1, 2], 'b': [1, 2], 'seed': 1, 'paired': 'yes'}, 'paired', 'paired must be true or false')
    return c


def main():
    c = build()
    out = {
        'module': 'evaluate',
        'generatedBy': 'tools/validation/dataai/oracle_evaluate.py',
        'tolerance': {'absoluteFloor': 1e-12, 'note': 'relative tolerance per case in `tol`; `abs` per case overrides the absolute floor; labels, counts, ids, messages and booleans exactly'},
        'description': 'Applied AI evaluation: tokens, BM25, TF-IDF, rankings with the stated tie rule, P@k, R@k, hit, RR, AP, nDCG, SQuAD answer match, extraction scoring, claim groundedness, Cohen kappa, calibration with the Murphy decomposition, bootstrap intervals. The Ekene documents are synthetic (test-data/dataai/ekene-docs).',
        'cases': c.cases,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False, allow_nan=False)
        fh.write('\n')
    ref = sum(1 for x in c.cases if isinstance(x['expected'], dict) and x['expected'].get('error') is True)
    print('wrote', os.path.relpath(DEST), len(c.cases), 'cases,', ref, 'refusals')


if __name__ == '__main__':
    main()
