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
