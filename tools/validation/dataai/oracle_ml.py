#!/usr/bin/env python3
"""Independent oracle for engines/dataai/ml.js (Data & AI D2).

STDLIB ONLY. Run with any python 3.10+:

    python3 tools/validation/dataai/oracle_ml.py

It writes test-data/dataai/goldens/ml_cases.json. Nothing here reads or
imports the JavaScript; every value is computed from the stated equations
by a road chosen to differ from the engine's:

  route                 oracle road                         engine road
  --------------------  ----------------------------------  -------------------
  mulberry32, shuffles  32-bit integer arithmetic; the draw  float u = k / 2^32,
                        j = (k (i + 1)) >> 32 exactly       Math.floor(u (i + 1))
  scalers               Fraction means and variances,       float two-pass
                        Decimal(60) square roots
  OLS                   EXACT rational normal equations     Householder QR on the
                        (Gauss-Jordan in Fractions) on the  equilibrated design +
                        float inputs; SEs from the exact    one refinement step
                        inverse, Decimal(60) square roots
  condition numbers     Jacobi eigenvalues of X'X (and of   one-sided Jacobi SVD
                        its unit-diagonal scaling) in       of the float R
                        Decimal(60); cond = sqrt(ratio)
  ridge                 normal equations Z'Z + lambda I in  QR of [Z; sqrt(lambda) I]
                        Decimal(60) Gauss-Jordan
  logistic              Newton in Decimal(60), run to a     Newton in float,
                        gradient below 1e-40 for the MLE;   stopped at tol
                        the iteration count by the stated
                        rule on the Decimal iterates
  separation            an explicit certificate checked in  LP (lib/lp simplex)
                        exact Fractions (a separating beta;
                        for quasi-complete, a Gordan
                        certificate that no strict one
                        exists); overlap proven by the
                        Newton iterates reaching a finite
                        stationary point
  ROC AUC               Mann-Whitney pair count in          trapezoid over the
                        Fractions (ties count one half);    distinct-threshold
                        curve points by counting scores     sweep
                        >= each threshold
  metrics               Fractions; Decimal square roots and float sums
                        logarithms

WHAT IT CANNOT CHECK: the conventions (population SD for scaling, the
ceil test size with its 1e-9 whole-number rule, Fisher-Yates from the end,
the round robin deal, the maxCondition 1e8 refusal, F1 = 2TP/(2TP+FP+FN),
zeroDivision, the log-loss eps, the logistic stopping rule, class 1 above
0.5). Those are choices, written in FINDINGS-ml.md and applied the same way
here. The oracle checks the arithmetic of those choices.

Published values: the NIST StRD linear least squares certified values
(Norris, Pontius, NoInt1, NoInt2, Longley, Filip, Wampler1-5), read from
the .dat files committed under test-data/dataai/nist-strd/. Before any
golden is written the oracle solves every NIST problem EXACTLY on the
decimal data as printed and requires agreement with every certified figure
to 13 significant digits (the certified values carry 15); a failure stops
the oracle. The engine is then held to per-dataset digit floors recorded
with each published entry.
"""
import json
import math
import os
import random
import re
from decimal import Decimal as D, getcontext
from fractions import Fraction as F

getcontext().prec = 60

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'ml_cases.json')
NIST_DIR = os.path.join(ROOT, 'test-data', 'dataai', 'nist-strd')

TOL = 1e-10          # well-conditioned floating results against exact values
TOL_TIGHT = 1e-12    # rational arithmetic, float rounding only
NIST_READ = 'NIST/ITL StRD Linear Least Squares Regression datasets (itl.nist.gov/div898/strd/lls/lls.shtml), read 2026-09-24'

# ------------------------------------------------------------------ number layout


def js_num(x):
    """The engine's reason-string rule (ECMA-262 Number::toString, radix 10),
    rebuilt from Python's shortest round-trip repr digits. Same routine as
    oracle_quality.py (D1)."""
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


def check_js_num():
    for v, want in [(1e8, '100000000'), (0.3, '0.3'), (1e-7, '1e-7'), (2.5, '2.5'), (1e-15, '1e-15'), (5206821467.5, '5206821467.5')]:
        assert js_num(v) == want, ('js_num', v, js_num(v), want)


# ------------------------------------------------------------------ helpers

def dec(x):
    if isinstance(x, D):
        return x
    if isinstance(x, F):
        return D(x.numerator) / D(x.denominator)
    return D(x)  # float or int: exact binary value


def fl(x):
    if isinstance(x, F):
        return float(x)
    return float(x)


def dsqrt(x):
    x = dec(x)
    assert x >= 0, x
    return x.sqrt()


def gauss_jordan(A, B):
    """Solve A X = B (B a list of columns) exactly or in Decimal; returns the
    solution columns. Partial pivoting on the largest magnitude (exact
    arithmetic does not need it; Decimal does)."""
    n = len(A)
    M = [list(A[i]) + [B[k][i] for k in range(len(B))] for i in range(n)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        if M[piv][c] == 0:
            raise ZeroDivisionError('singular')
        M[c], M[piv] = M[piv], M[c]
        pv = M[c][c]
        M[c] = [v / pv for v in M[c]]
        for r in range(n):
            if r != c and M[r][c] != 0:
                f = M[r][c]
                M[r] = [a - f * b for a, b in zip(M[r], M[c])]
    return [[M[i][n + k] for i in range(n)] for k in range(len(B))]


def inverse(A):
    n = len(A)
    zero = A[0][0] * 0
    cols = gauss_jordan(A, [[zero + (1 if i == k else 0) for i in range(n)] for k in range(n)])
    return [[cols[k][i] for k in range(n)] for i in range(n)]


def jacobi_eigen(S):
    """Eigenvalues of a symmetric Decimal matrix by cyclic Jacobi rotations."""
    n = len(S)
    a = [[dec(v) for v in r] for r in S]
    tiny = D('1e-55')
    for _ in range(200):
        off = sum(a[i][j] * a[i][j] for i in range(n) for j in range(n) if i != j)
        scale = sum(a[i][i] * a[i][i] for i in range(n))
        if off <= tiny * tiny * scale:
            break
        for p in range(n - 1):
            for q in range(p + 1, n):
                if a[p][q] == 0:
                    continue
                theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
                sgn = 1 if theta >= 0 else -1
                t = sgn / (abs(theta) + (theta * theta + 1).sqrt())
                c = 1 / (t * t + 1).sqrt()
                s = t * c
                for k in range(n):
                    akp, akq = a[k][p], a[k][q]
                    a[k][p] = c * akp - s * akq
                    a[k][q] = s * akp + c * akq
                for k in range(n):
                    apk, aqk = a[p][k], a[q][k]
                    a[p][k] = c * apk - s * aqk
                    a[q][k] = s * apk + c * aqk
    return sorted((a[i][i] for i in range(n)), reverse=True)


# ------------------------------------------------------------------ mulberry32 and shuffles

M32 = 0xFFFFFFFF


def imul(a, b):
    return (a * b) & M32


class Mulberry32:
    """mulberry32 from its definition, in unsigned 32-bit integers. draw(m)
    returns floor(u m) for u = k / 2^32 exactly, as the integer (k m) >> 32."""

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


def shuffle(items, rng):
    a = list(items)
    for i in range(len(a) - 1, 0, -1):
        j = rng.draw(i + 1)
        a[i], a[j] = a[j], a[i]
    return a


def ceil_count(f, m):
    t = F(f) * m  # exact product of the float fraction and the count
    # the engine multiplies in float; a float product within 1e-9 of a whole number is that number
    tf = f * m
    if abs(tf - round(tf)) <= 1e-9:
        return int(round(tf))
    return math.ceil(t)


# ------------------------------------------------------------------ cases

class Cases:
    def __init__(self):
        self.cases = []

    def add(self, cid, fn, args, expected, tol=TOL, source='oracle', published=None, note=None, abs_floor=None):
        assert cid not in {c['id'] for c in self.cases}, cid
        c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected, 'tol': tol, 'source': source}
        if abs_floor is not None:
            c['abs'] = abs_floor
        if published is not None:
            c['published'] = published
        if note:
            c['note'] = note
        self.cases.append(c)

    def refuse(self, cid, fn, args, field, message=None, starts=None, ends=None, figure=None, note=None):
        e = {'error': True, 'field': field}
        if message is not None:
            e['message'] = message
        if starts is not None:
            e['messageStartsWith'] = starts
        if ends is not None:
            e['messageEndsWith'] = ends
        if figure is not None:
            e['messageFigure'] = figure
        self.add(cid, fn, args, e, note=note)


# ------------------------------------------------------------------ preprocessing

def o_scaler(X, idx=None, names=None, sd='population', kind='standard'):
    rows = X if idx is None else [X[i] for i in idx]
    p = len(X[0])
    names = names or [f'x{j + 1}' for j in range(p)]
    n = len(rows)
    centre, scale, mins, maxs = [], [], [], []
    for j in range(p):
        col = [F(r[j]) for r in rows]
        if all(v == col[0] for v in col):
            what = 'zero variance' if kind == 'standard' else 'zero range'
            verb = 'standardising' if kind == 'standard' else 'min-max scaling'
            return {'error': True, 'field': f'X.{names[j]}',
                    'message': f'X.{names[j]} has {what} on the {n} training rows (every value is {js_num(float(col[0]))}): {verb} would divide by zero, so drop the feature or fit on rows where it varies'}
        if kind == 'standard':
            m = sum(col) / n
            ss = sum((v - m) ** 2 for v in col)
            centre.append(fl(m))
            scale.append(fl(dsqrt(ss / (n - 1 if sd == 'sample' else n))))
        else:
            lo, hi = min(col), max(col)
            mins.append(fl(lo)); maxs.append(fl(hi)); centre.append(fl(lo)); scale.append(fl(hi - lo))
    out = {'kind': kind, 'names': names, 'nFit': n, 'fitIndices': list(idx) if idx is not None else None, 'centre': centre, 'scale': scale}
    if kind == 'minmax':
        out['min'] = mins
        out['max'] = maxs
    return out


def o_apply(scaler, X):
    return {'X': [[fl((F(v) - F(scaler['centre'][j])) / F(scaler['scale'][j])) for j, v in enumerate(r)] for r in X]}


# ------------------------------------------------------------------ splits

def sorted_ids(groups):
    return sorted(set(groups))


def o_group_split(groups, seed, test_fraction=None, n_test=None):
    ids = sorted_ids(groups)
    G = len(ids)
    nt = n_test if n_test is not None else ceil_count(test_fraction, G)
    order = shuffle(ids, Mulberry32(seed))
    test = set(order[:nt])
    return {'trainIndices': [i for i, g in enumerate(groups) if g not in test],
            'testIndices': [i for i, g in enumerate(groups) if g in test],
            'trainGroups': [g for g in ids if g not in test], 'testGroups': [g for g in ids if g in test],
            'sharedGroups': [], 'order': order, 'nGroups': G, 'nTestGroups': nt, 'seed': seed}


def o_group_kfold(groups, k, seed):
    ids = sorted_ids(groups)
    order = shuffle(ids, Mulberry32(seed))
    fold_of = {g: q % k for q, g in enumerate(order)}
    folds = []
    for f in range(k):
        folds.append({'fold': f, 'trainIndices': [i for i, g in enumerate(groups) if fold_of[g] != f],
                      'testIndices': [i for i, g in enumerate(groups) if fold_of[g] == f],
                      'trainGroups': [g for g in ids if fold_of[g] != f], 'testGroups': [g for g in ids if fold_of[g] == f],
                      'sharedGroups': []})
    return {'k': k, 'nGroups': len(ids), 'order': order, 'seed': seed, 'folds': folds}


def o_random_rows(m, test_fraction, seed, groups=None):
    nt = ceil_count(test_fraction, m)
    order = shuffle(range(m), Mulberry32(seed))
    test = set(order[:nt])
    out = {'trainIndices': [i for i in range(m) if i not in test], 'testIndices': [i for i in range(m) if i in test], 'nTest': nt, 'seed': seed}
    if groups is not None:
        ids = sorted_ids(groups)
        tr = {groups[i] for i in out['trainIndices']}
        te = {groups[i] for i in out['testIndices']}
        out['trainGroups'] = [g for g in ids if g in tr]
        out['testGroups'] = [g for g in ids if g in te]
        out['sharedGroups'] = [g for g in ids if g in tr and g in te]
    return out


# ------------------------------------------------------------------ OLS (exact)

def gram(A):
    p = len(A[0])
    return [[sum(r[j] * r[k] for r in A) for k in range(p)] for j in range(p)]


def cond_numbers(G):
    """2-norm condition numbers of the design from its Gram matrix: raw, and
    with unit-length columns (Gram scaled to unit diagonal)."""
    p = len(G)
    ev = jacobi_eigen([[dec(v) for v in r] for r in G])
    raw = (ev[0] / ev[-1]).sqrt()
    dg = [dsqrt(G[j][j]) for j in range(p)]
    Gs = [[dec(G[j][k]) / (dg[j] * dg[k]) for k in range(p)] for j in range(p)]
    evs = jacobi_eigen(Gs)
    scaled = (evs[0] / evs[-1]).sqrt()
    return raw, scaled


def o_ols_exact(X, y, intercept=True, exact_inputs=False):
    """Exact least squares on rational data. With exact_inputs the values are
    already Fractions (NIST decimal data); otherwise each float is taken at
    its exact binary value."""
    conv = (lambda v: v) if exact_inputs else F
    A = [([F(1)] if intercept else []) + [conv(v) for v in r] for r in X]
    yv = [conv(v) for v in y]
    n, p = len(A), len(A[0])
    G = gram(A)
    b = [sum(A[i][j] * yv[i] for i in range(n)) for j in range(p)]
    Ginv = inverse(G)
    beta = [sum(Ginv[j][k] * b[k] for k in range(p)) for j in range(p)]
    fitted = [sum(A[i][j] * beta[j] for j in range(p)) for i in range(n)]
    res = [yv[i] - fitted[i] for i in range(n)]
    rss = sum(r * r for r in res)
    ybar = sum(yv) / n
    tss = sum((v - ybar) ** 2 for v in yv) if intercept else sum(v * v for v in yv)
    s2 = rss / (n - p)
    se = [dsqrt(s2 * Ginv[j][j]) for j in range(p)]
    r2 = 1 - rss / tss
    c = 1 if intercept else 0
    return {'A': A, 'G': G, 'beta': beta, 'se': se, 'rss': rss, 'tss': tss, 's': dsqrt(s2), 'r2': r2,
            'adj': 1 - (1 - r2) * F(n - c, n - p), 'fitted': fitted, 'res': res, 'n': n, 'p': p}


COND_TAIL = ", so some coefficients could carry no reliable digits; drop or combine collinear features, centre or rescale them, or raise maxCondition knowingly"


def o_ols(X, y, names=None, intercept=True, max_condition=1e8):
    p0 = len(X[0])
    names = names or [f'x{j + 1}' for j in range(p0)]
    alln = (['intercept'] if intercept else []) + names
    n = len(X)
    p = p0 + (1 if intercept else 0)
    if n <= p:
        return {'error': True, 'field': 'X', 'message': f"X must have more rows than coefficients ({n} rows for {p} coefficients{', the intercept included' if intercept else ''}): the residual degrees of freedom n - p must be at least 1"}
    A = [([1.0] if intercept else []) + list(r) for r in X]
    for j in range(p):
        if all(r[j] == 0 for r in A):
            return {'error': True, 'field': f'X.{alln[j]}', 'message': f'X.{alln[j]} is zero in every row, so its coefficient is not identifiable'}
    yv = [F(v) for v in y]
    ybar = sum(yv) / n
    tss = sum((v - ybar) ** 2 for v in yv) if intercept else sum(v * v for v in yv)
    if tss == 0:
        return {'error': True, 'field': 'y', 'message': 'y has zero variance about its mean (every value is equal), so R-squared is undefined' if intercept else 'y is zero in every row, so the uncentred R-squared is undefined'}
    G = gram([[F(v) for v in r] for r in A])
    try:
        raw, scaled = cond_numbers(G)
        singular = False
    except (ZeroDivisionError, Exception):
        singular = True
    if singular or scaled > dec(max_condition):
        return {'error': True, 'field': 'X', 'kappa': None if singular else scaled,
                'starts': 'X is too ill-conditioned for a float64 least squares fit: the scaled condition number ',
                'ends': f' is above maxCondition {js_num(max_condition)}' + COND_TAIL}
    r = o_ols_exact(X, y, intercept)
    return {'kind': 'ols', 'intercept': intercept, 'names': alln, 'n': n, 'p': p, 'dfResidual': n - p,
            'coefficients': [fl(v) for v in r['beta']], 'standardErrors': [fl(v) for v in r['se']],
            **({} if r['rss'] <= F(1, 10 ** 24) * r['tss'] else {'tValues': [fl(dec(b) / s) for b, s in zip(r['beta'], r['se'])]}),
            'residualSE': fl(r['s']), 'rss': fl(r['rss']), 'tss': fl(r['tss']), 'rSquared': fl(r['r2']),
            'adjustedRSquared': fl(r['adj']), 'conditionNumber': fl(raw), 'scaledConditionNumber': fl(scaled),
            'fitted': [fl(v) for v in r['fitted']], 'residuals': [fl(v) for v in r['res']], '_exact': r}


def strip(r):
    return {k: v for k, v in r.items() if not k.startswith('_')}


def ols_expected(r):
    if r.get('error') and 'starts' in r:
        return None
    return strip(r)


# ------------------------------------------------------------------ ridge (Decimal)

def o_ridge(X, y, lam, names=None):
    n, p = len(X), len(X[0])
    names = names or [f'x{j + 1}' for j in range(p)]
    sc = o_scaler(X, names=names)
    if sc.get('error'):
        return sc
    cols = [[F(r[j]) for r in X] for j in range(p)]
    mean = [sum(c) / n for c in cols]
    sd = [dsqrt(sum((v - mean[j]) ** 2 for v in cols[j]) / n) for j in range(p)]
    Z = [[(dec(X[i][j]) - dec(mean[j])) / sd[j] for j in range(p)] for i in range(n)]
    yv = [F(v) for v in y]
    ybar = sum(yv) / n
    yc = [dec(v - ybar) for v in yv]
    ZtZ = [[sum(Z[i][j] * Z[i][k] for i in range(n)) for k in range(p)] for j in range(p)]
    lamd = dec(lam)
    Hm = [[ZtZ[j][k] + (lamd if j == k else 0) for k in range(p)] for j in range(p)]
    rhs = [sum(Z[i][j] * yc[i] for i in range(n)) for j in range(p)]
    bs = gauss_jordan(Hm, [rhs])[0]
    Hinv = inverse(Hm)
    edf = sum(sum(Hinv[j][k] * ZtZ[k][j] for k in range(p)) for j in range(p))
    coef = [bs[j] / sd[j] for j in range(p)]
    b0 = dec(ybar) - sum(coef[j] * dec(mean[j]) for j in range(p))
    fitted = [dec(ybar) + sum(Z[i][j] * bs[j] for j in range(p)) for i in range(n)]
    rss = sum((dec(yv[i]) - fitted[i]) ** 2 for i in range(n))
    tss = sum(v * v for v in yc)
    # scaled condition number of [Z; sqrt(lambda) I]: Gram = Z'Z + lambda I
    _, scaled = cond_numbers(Hm)
    return {'kind': 'ridge', 'intercept': True, 'lambda': lam, 'names': ['intercept'] + names, 'n': n,
            'coefficients': [fl(b0)] + [fl(v) for v in coef], 'standardizedCoefficients': [fl(ybar)] + [fl(v) for v in bs],
            'scaler': {'centre': [fl(m) for m in mean], 'scale': [fl(s) for s in sd]},
            'effectiveDegreesOfFreedom': fl(edf), 'rss': fl(rss), 'rSquared': fl(1 - rss / tss),
            'scaledConditionNumber': fl(scaled), 'fitted': [fl(v) for v in fitted]}


# ------------------------------------------------------------------ logistic (Decimal Newton)

def dsig(t):
    if t >= 0:
        return 1 / (1 + (-t).exp())
    e = t.exp()
    return e / (1 + e)


def dsoftplus(t):
    if t > 0:
        return t + (1 + (-t).exp()).ln()
    return (1 + t.exp()).ln()


def o_logistic_newton(A, y, l2, pen, tol, max_iter, extra=60, check_margin=True):
    n, p = len(A), len(A[0])
    Ad = [[dec(v) for v in r] for r in A]
    l2d = dec(l2)

    def pll(beta):
        ll = D(0)
        for i in range(n):
            eta = sum(Ad[i][j] * beta[j] for j in range(p))
            ll += y[i] * eta - dsoftplus(eta)
        q = sum(beta[j] * beta[j] for j in range(p) if pen[j])
        return ll, ll - l2d * q / 2

    def newton_step(beta):
        g = [D(0)] * p
        H = [[D(0)] * p for _ in range(p)]
        for i in range(n):
            eta = sum(Ad[i][j] * beta[j] for j in range(p))
            mu = dsig(eta)
            w = mu * (1 - mu)
            for j in range(p):
                g[j] += Ad[i][j] * (y[i] - mu)
                for k in range(p):
                    H[j][k] += w * Ad[i][j] * Ad[i][k]
        for j in range(p):
            if pen[j]:
                g[j] -= l2d * beta[j]
                H[j][j] += l2d
        return gauss_jordan(H, [g])[0], H, g

    beta = [D(0)] * p
    cur = pll(beta)
    it = 0
    converged = False
    changes = []
    halv = 0
    beta_at_stop = None
    while True:
        delta, H, g = newton_step(beta)
        step = D(1)
        nxt = [b + d for b, d in zip(beta, delta)]
        nv = pll(nxt)
        h = 0
        floor = cur[1] - D('1e-12') * (1 + abs(cur[1]))
        while nv[1] < floor and h < 30:
            step /= 2
            h += 1
            nxt = [b + step * d for b, d in zip(beta, delta)]
            nv = pll(nxt)
        change = max(abs(d) for d in delta)  # the full Newton step
        beta, cur = nxt, nv
        if beta_at_stop is None:
            it += 1
            halv += h
            changes.append(change)
            if change <= dec(tol):
                converged = True
                beta_at_stop = list(beta)
                ll_stop = cur[0]
            elif it >= max_iter:
                beta_at_stop = list(beta)
                ll_stop = cur[0]
        if beta_at_stop is not None and (change < D('1e-45') or extra <= 0):
            break
        if beta_at_stop is not None:
            extra -= 1
    # decision margin: no recorded change may sit within a factor 100 of tol
    for c in (changes if check_margin else []):
        assert not (dec(tol) / 100 < c < dec(tol) * 100), ('iteration count too close to tol to be stable', c)
    return {'beta_mle': beta, 'beta_stop': beta_at_stop, 'iterations': it, 'converged': converged, 'halvings': halv, 'll_stop': ll_stop, 'changes': changes}


def o_logistic(X, y, l2=0, intercept=True, names=None, tol=1e-10, max_iter=100, check_margin=True):
    p0 = len(X[0])
    names = names or [f'x{j + 1}' for j in range(p0)]
    alln = (['intercept'] if intercept else []) + names
    A = [([1.0] if intercept else []) + list(r) for r in X]
    pen = [nm != 'intercept' for nm in alln]
    r = o_logistic_newton(A, y, l2, pen, tol, max_iter, check_margin=check_margin)
    n, p = len(A), len(A[0])
    # the engine reports the iterate at which it stopped; when converged that
    # differs from the MLE by far less than the gate tolerance, so the MLE is used
    beta = r['beta_mle'] if r['converged'] else r['beta_stop']
    Ad = [[dec(v) for v in row] for row in A]
    probs = [dsig(sum(Ad[i][j] * beta[j] for j in range(p))) for i in range(n)]
    I = [[sum(probs[i] * (1 - probs[i]) * Ad[i][j] * Ad[i][k] for i in range(n)) + (dec(l2) if (j == k and pen[j]) else 0) for k in range(p)] for j in range(p)]
    Iinv = inverse(I)
    ll = sum(y[i] * sum(Ad[i][j] * beta[j] for j in range(p)) - dsoftplus(sum(Ad[i][j] * beta[j] for j in range(p))) for i in range(n))
    ybar = D(sum(y)) / n
    null_ll = sum(y[i] * ybar.ln() + (1 - y[i]) * (1 - ybar).ln() for i in range(n))
    out = {'kind': 'logistic', 'intercept': intercept, 'l2': l2, 'names': alln, 'n': n,
           'coefficients': [fl(b) for b in beta], 'standardErrors': [fl(Iinv[j][j].sqrt()) for j in range(p)],
           'logLikelihood': fl(ll), 'deviance': fl(-2 * ll), 'nullDeviance': fl(-2 * null_ll) if intercept else None,
           'iterations': r['iterations'], 'converged': r['converged'], 'stepHalvings': r['halvings'],
           'probabilities': [fl(v) for v in probs], 'separation': {'detected': False, 'type': 'none'}}
    return out, r


def certify_separation(A, y, beta_cert=None, gordan=None):
    """Exact certificates. beta_cert: s_i x_i'beta >= 0 all (and > 0 somewhere);
    returns 'complete' when all are strict. gordan: non-negative weights, not
    all zero, with sum w_i s_i x_i = 0, proving no strictly separating beta."""
    S = [[F(1 if y[i] == 1 else -1) * F(v) for v in A[i]] for i in range(len(A))]
    m = [sum(S[i][j] * F(beta_cert[j]) for j in range(len(beta_cert))) for i in range(len(S))]
    assert all(v >= 0 for v in m) and any(v > 0 for v in m), 'certificate does not separate'
    if all(v > 0 for v in m):
        assert gordan is None
        return 'complete'
    assert gordan is not None and all(w >= 0 for w in gordan) and any(w > 0 for w in gordan)
    for j in range(len(A[0])):
        assert sum(F(gordan[i]) * S[i][j] for i in range(len(S))) == 0, 'Gordan certificate fails'
    return 'quasi-complete'


def sep_message(kind):
    if kind == 'complete':
        return 'y is completely separated by a linear combination of the features (every row lies strictly on its own class side of a hyperplane), so the maximum likelihood coefficients are infinite: add an L2 penalty (l2 > 0) or remove the separating feature'
    return 'y is quasi-completely separated by a linear combination of the features (every row lies on or on its own class side of a hyperplane, some exactly on it), so the maximum likelihood coefficients are infinite: add an L2 penalty (l2 > 0) or remove the separating feature'


# ------------------------------------------------------------------ prediction and metrics

def o_predict_values(model, X):
    c = [F(v) for v in model['coefficients']]
    off = 1 if model['intercept'] else 0
    eta = [(c[0] if off else 0) + sum(F(v) * c[j + off] for j, v in enumerate(r)) for r in X]
    if model['kind'] != 'logistic':
        return eta, None
    pr = [dsig(dec(e)) for e in eta]
    return pr, [1 if v > D('0.5') else 0 for v in pr]


def o_regression_metrics(yt, yp, ref=None):
    n = len(yt)
    yt = [F(v) for v in yt]
    yp = [F(v) for v in yp]
    m = sum(yt) / n if ref is None else F(ref)
    sse = sum((a - b) ** 2 for a, b in zip(yt, yp))
    sae = sum(abs(a - b) for a, b in zip(yt, yp))
    sst = sum((a - m) ** 2 for a in yt)
    return {'n': n, 'rmse': fl(dsqrt(sse / n)), 'mae': fl(sae / n), 'r2': fl(1 - sse / sst), 'sse': fl(sse), 'sst': fl(sst), 'referenceMean': fl(m)}


def label_sort(labels):
    return sorted(set(labels))


def o_confusion(yt, yp, labels=None):
    L = labels if labels is not None else label_sort(list(yt) + list(yp))
    M = [[sum(1 for a, b in zip(yt, yp) if a == r and b == c) for c in L] for r in L]
    return {'labels': L, 'matrix': M, 'n': len(yt)}


def o_report(yt, yp, labels=None, zd=0):
    cm = o_confusion(yt, yp, labels)
    L = cm['labels']
    per = []
    undefined = []
    for c in L:
        tp = sum(1 for a, b in zip(yt, yp) if a == c and b == c)
        fp = sum(1 for a, b in zip(yt, yp) if a != c and b == c)
        fn = sum(1 for a, b in zip(yt, yp) if a == c and b != c)

        def ratio(num, den, what):
            if den == 0:
                undefined.append({'label': c, 'metric': what})
                return F(zd)
            return F(num, den)
        prec = ratio(tp, tp + fp, 'precision')
        rec = ratio(tp, tp + fn, 'recall')
        # F1 from its harmonic-mean definition where both ratios are defined and
        # not both zero; 2TP/(2TP+FP+FN) otherwise (the equivalent count form)
        if tp + fp > 0 and tp + fn > 0 and prec + rec > 0:
            f1 = 2 * prec * rec / (prec + rec)
            assert f1 == F(2 * tp, 2 * tp + fp + fn)
        else:
            f1 = ratio(2 * tp, 2 * tp + fp + fn, 'f1')
        per.append({'label': c, 'tp': tp, 'fp': fp, 'fn': fn, 'support': tp + fn, 'precision': prec, 'recall': rec, 'f1': f1})

    def avg(key, w):
        ws = sum(w(r) for r in per)
        return F(zd) if ws == 0 else sum(w(r) * r[key] for r in per) / ws
    out = {'labels': L, 'matrix': cm['matrix'], 'n': len(yt), 'accuracy': fl(F(sum(1 for a, b in zip(yt, yp) if a == b), len(yt))),
           'perClass': [{k: (fl(v) if isinstance(v, F) else v) for k, v in r.items()} for r in per],
           'macro': {k: fl(avg(k, lambda r: 1)) for k in ('precision', 'recall', 'f1')},
           'weighted': {k: fl(avg(k, lambda r: r['support'])) for k in ('precision', 'recall', 'f1')},
           'zeroDivision': zd, 'undefinedRatios': undefined}
    return out


def o_roc(yt, sc):
    P = sum(1 for v in yt if v == 1)
    N = len(yt) - P
    th = sorted(set(sc), reverse=True)
    fpr, tpr = [0.0], [0.0]
    for t in th:
        fpr.append(fl(F(sum(1 for a, s in zip(yt, sc) if a == 0 and s >= t), N)))
        tpr.append(fl(F(sum(1 for a, s in zip(yt, sc) if a == 1 and s >= t), P)))
    # AUC by Mann-Whitney: P(score_pos > score_neg) + 1/2 P(equal)
    pos = [F(s) for a, s in zip(yt, sc) if a == 1]
    neg = [F(s) for a, s in zip(yt, sc) if a == 0]
    wins = sum((1 if p > q else F(1, 2) if p == q else 0) for p in pos for q in neg)
    return {'fpr': fpr, 'tpr': tpr, 'thresholds': [None] + th, 'auc': fl(wins / (P * N)), 'positives': P, 'negatives': N}


def o_logloss(yt, pr, eps=1e-15):
    lo, hi = eps, 1.0 - eps  # the float clip bounds, as the engine forms them
    s = D(0)
    clipped = 0
    for a, q in zip(yt, pr):
        if q < lo:
            q = lo
            clipped += 1
        elif q > hi:
            q = hi
            clipped += 1
        s -= dec(q).ln() if a == 1 else (1 - dec(q)).ln()
    return {'logLoss': fl(s / len(yt)), 'n': len(yt), 'eps': eps, 'clipped': clipped}


HIGHER = {'r2': True, 'accuracy': True, 'auc': True, 'rmse': False, 'mae': False, 'logLoss': False}


def o_score_exact(model, X, y, metric):
    """Returns the score as a Fraction or Decimal (exact where it can be)."""
    vals, classes = o_predict_values(model, X)
    if metric == 'accuracy':
        return F(sum(1 for c, t in zip(classes, y) if c == t), len(y))
    if metric == 'auc':
        pos = [v for v, t in zip(vals, y) if t == 1]
        neg = [v for v, t in zip(vals, y) if t == 0]
        wins = sum((1 if p > q else F(1, 2) if p == q else 0) for p in pos for q in neg)
        return F(wins) / (len(pos) * len(neg))
    if metric == 'logLoss':
        s = D(0)
        for t, q in zip(y, vals):
            q = min(max(q, dec(1e-15)), dec(1.0 - 1e-15))
            s -= q.ln() if t == 1 else (1 - q).ln()
        return s / len(y)
    yt = [F(v) for v in y]
    n = len(yt)
    sse = sum((a - b) ** 2 for a, b in zip(yt, vals))
    if metric == 'rmse':
        return dsqrt(sse / n)
    if metric == 'mae':
        return sum(abs(a - b) for a, b in zip(yt, vals)) / n
    m = sum(yt) / n
    return 1 - sse / sum((a - m) ** 2 for a in yt)


def o_perm_importance(model, X, y, metric, n_rep, seed):
    base = o_score_exact(model, X, y, metric)
    rng = Mulberry32(seed)
    hib = HIGHER[metric]
    names = [nm for j, nm in enumerate(model['names']) if not (model['intercept'] and j == 0)]
    imps = []
    for j in range(len(X[0])):
        drops = []
        for _ in range(n_rep):
            perm = shuffle(range(len(X)), rng)
            Xp = [list(r) for r in X]
            for i in range(len(X)):
                Xp[i][j] = X[perm[i]][j]
            s = o_score_exact(model, Xp, y, metric)
            drops.append(dec(base) - dec(s) if hib else dec(s) - dec(base))
        mu = sum(drops) / n_rep
        sd = dsqrt(sum((d - mu) ** 2 for d in drops) / n_rep)
        imps.append({'feature': names[j], 'mean': fl(mu), 'sd': fl(sd), 'drops': [fl(d) for d in drops], '_mean': mu})
    ranking = [imps[j]['feature'] for j in sorted(range(len(imps)), key=lambda j: (-imps[j]['_mean'], j))]
    for r in imps:
        del r['_mean']
    return {'metric': metric, 'baseline': fl(base), 'nRepeats': n_rep, 'seed': seed, 'importances': imps, 'ranking': ranking}


def o_fit(spec, X, y):
    if spec['kind'] == 'ols':
        r = o_ols(X, y)
        return {'kind': 'ols', 'intercept': True, 'names': r['names'], 'coefficients_exact': r['_exact']['beta'], 'coefficients': r['coefficients']}
    if spec['kind'] == 'ridge':
        r = o_ridge(X, y, spec['lambda'])
        return {'kind': 'ridge', 'intercept': True, 'names': r['names'], 'coefficients': r['coefficients']}
    # only the coefficients are used here (the iteration count is not compared)
    r, _ = o_logistic(X, y, spec.get('l2', 0), check_margin=False)
    return {'kind': 'logistic', 'intercept': True, 'names': r['names'], 'coefficients': r['coefficients']}


def o_learning_curve(X, y, groups, spec, counts, seed, metric, test_fraction=None, n_test=None):
    sp = o_group_split(groups, seed, test_fraction, n_test)
    test = set(sp['testGroups'])
    order = [g for g in sp['order'] if g not in test]
    Xte = [X[i] for i in sp['testIndices']]
    yte = [y[i] for i in sp['testIndices']]
    pts = []
    for c in counts:
        use = set(order[:c])
        idx = [i for i, g in enumerate(groups) if g in use]
        Xtr = [X[i] for i in idx]
        ytr = [y[i] for i in idx]
        m = o_fit(spec, Xtr, ytr)
        pts.append({'nGroups': c, 'nRows': len(idx), 'groups': order[:c],
                    'trainScore': fl(o_score_exact(m, Xtr, ytr, metric)), 'testScore': fl(o_score_exact(m, Xte, yte, metric))})
    return {'metric': metric, 'testGroups': sp['testGroups'], 'testIndices': sp['testIndices'], 'trainOrder': order, 'points': pts}


def o_leakage(X, y, groups, spec, tf, seed, metric):
    rs = o_random_rows(len(groups), tf, seed, groups)
    gs = o_group_split(groups, seed, tf)

    def run(sp):
        Xtr = [X[i] for i in sp['trainIndices']]
        ytr = [y[i] for i in sp['trainIndices']]
        Xte = [X[i] for i in sp['testIndices']]
        yte = [y[i] for i in sp['testIndices']]
        m = o_fit(spec, Xtr, ytr)
        return {'trainIndices': sp['trainIndices'], 'testIndices': sp['testIndices'], 'trainGroups': sp['trainGroups'],
                'testGroups': sp['testGroups'], 'sharedGroups': sp['sharedGroups'], 'nTrain': len(Xtr), 'nTest': len(Xte),
                'trainScore': o_score_exact(m, Xtr, ytr, metric), 'testScore': o_score_exact(m, Xte, yte, metric), 'coefficients': m['coefficients']}
    a, b = run(rs), run(gs)
    opt = (dec(a['testScore']) - dec(b['testScore'])) if HIGHER[metric] else (dec(b['testScore']) - dec(a['testScore']))
    for r in (a, b):
        r['trainScore'] = fl(r['trainScore'])
        r['testScore'] = fl(r['testScore'])
    return {'metric': metric, 'randomRow': a, 'group': b, 'optimism': fl(opt)}


# ------------------------------------------------------------------ NIST StRD

NIST_SPEC = {  # name: (polynomial degree or None for the multi-predictor file, intercept)
    'Norris': (1, True), 'Pontius': (2, True), 'NoInt1': (1, False), 'NoInt2': (1, False),
    'Filip': (10, True), 'Longley': (None, True),
    'Wampler1': (5, True), 'Wampler2': (5, True), 'Wampler3': (5, True), 'Wampler4': (5, True), 'Wampler5': (5, True),
}

# Digit floors the ENGINE must reach against the certified values (log relative
# error, NIST's LRE; absolute error where the certified value is 0). Set at the
# floor of what the engine achieved on 2026-09-24 (FINDINGS-ml.md has the
# table), so a numerical regression goes red. They are a guard, not a claim
# the oracle can make.
NIST_DIGITS = {
    'Norris': {'coef': 14, 'se': 13, 'rsd': 14, 'r2': 15},
    'Pontius': {'coef': 13, 'se': 13, 'rsd': 13, 'r2': 15},
    'NoInt1': {'coef': 14, 'se': 15, 'rsd': 15, 'r2': 15},
    'NoInt2': {'coef': 15, 'se': 14, 'rsd': 15, 'r2': 15},
    'Longley': {'coef': 14, 'se': 12, 'rsd': 15, 'r2': 15},
    'Wampler1': {'coef': 15, 'se': 15, 'rsd': 15, 'r2': 15},
    'Wampler2': {'coef': 13, 'se': 14, 'rsd': 14, 'r2': 15},
    'Wampler3': {'coef': 15, 'se': 13, 'rsd': 14, 'r2': 15},
    'Wampler4': {'coef': 15, 'se': 13, 'rsd': 14, 'r2': 15},
    'Wampler5': {'coef': 15, 'se': 13, 'rsd': 14, 'r2': 13},
    'Filip': {'coef': 7, 'se': 7, 'rsd': 8, 'r2': 10},
}


def parse_nist(name):
    txt = open(os.path.join(NIST_DIR, name + '.dat')).read()
    lines = txt.splitlines()
    head = '\n'.join(lines[:12])
    cv = re.search(r'Certified Values\s+\(lines\s+(\d+)\s+to\s+(\d+)\)', head)
    dv = re.search(r'Data\s+\(lines\s+(\d+)\s+to\s+(\d+)\)', head)
    cert = lines[int(cv.group(1)) - 1:int(cv.group(2))]
    data = lines[int(dv.group(1)) - 1:int(dv.group(2))]
    B, rsd, r2 = [], None, None
    for ln in cert:
        t = ln.split()
        if t and re.fullmatch(r'B\d+', t[0]):
            B.append((t[1], t[2]))
        elif len(t) >= 3 and t[0] == 'Standard' and t[1] == 'Deviation':
            rsd = t[2]
        elif t and t[0] == 'R-Squared':
            r2 = t[1]
    rows = [ln.split() for ln in data if ln.strip()]
    return {'B': B, 'rsd': rsd, 'r2': r2, 'rows': rows}


def nist_design(name, rows, exact):
    deg, _ = NIST_SPEC[name]
    conv = (lambda s: F(s)) if exact else (lambda s: float(s))
    y = [conv(r[0]) for r in rows]
    if deg is None:
        X = [[conv(v) for v in r[1:]] for r in rows]
    elif exact:
        X = [[F(r[1]) ** k for k in range(1, deg + 1)] for r in rows]
    else:
        # powers correctly rounded from the exact decimal x (the float design any float64 program sees)
        X = [[float(F(r[1]) ** k) for k in range(1, deg + 1)] for r in rows]
    return X, y


def lre(est, cert):
    est, cert = dec(est), D(cert)
    if cert == 0:
        e = abs(est)
    else:
        e = abs(est - cert) / abs(cert)
    return 16.0 if e == 0 else min(16.0, -math.log10(float(e)))


def nist_self_check():
    """The oracle's exact solve on the decimal data as printed must reproduce
    every certified figure to 13 significant digits; else stop."""
    worst = {}
    for name, (_, icpt) in NIST_SPEC.items():
        d = parse_nist(name)
        X, y = nist_design(name, d['rows'], exact=True)
        r = o_ols_exact(X, y, icpt, exact_inputs=True)
        vals = [lre(r['beta'][j], b) for j, (b, _) in enumerate(d['B'])] + [lre(r['se'][j], s) for j, (_, s) in enumerate(d['B'])]
        vals += [lre(r['s'], d['rsd']), lre(r['r2'], d['r2'])]
        worst[name] = min(vals)
        assert worst[name] >= 13, ('oracle does not reproduce NIST', name, worst[name])
    return worst


def nist_cases(c):
    report = {}
    for name, (deg, icpt) in NIST_SPEC.items():
        d = parse_nist(name)
        X, y = nist_design(name, d['rows'], exact=False)
        args = {'X': X, 'y': y}
        if not icpt:
            args['intercept'] = False
        dg = NIST_DIGITS[name]
        pub = []
        for j, (b, s) in enumerate(d['B']):
            pub.append({'field': f'coefficients.{j}', 'certified': b, 'value': float(b), 'digits': dg['coef']})
            pub.append({'field': f'standardErrors.{j}', 'certified': s, 'value': float(s), 'digits': dg['se']})
        pub.append({'field': 'residualSE', 'certified': d['rsd'], 'value': float(d['rsd']), 'digits': dg['rsd']})
        pub.append({'field': 'rSquared', 'certified': d['r2'], 'value': float(d['r2']), 'digits': dg['r2']})
        # the oracle's own exact solve on the FLOAT design: how many certified digits float inputs allow
        r_float = o_ols_exact(X, y, icpt)
        report[name] = min([lre(r_float['beta'][j], b) for j, (b, _) in enumerate(d['B'])])
        src = f'{NIST_READ}; {name}.dat'
        if name == 'Filip':
            r = o_ols(X, y, intercept=icpt)
            c.refuse('nist-filip-refused', 'ols', args, 'X', starts=r['starts'], ends=r['ends'], figure=fl(r['kappa']),
                     note='scaled condition number about 5.2e9 is above the default maxCondition 1e8: refused')
            args2 = dict(args, maxCondition=1e10)
            r2 = o_ols(X, y, intercept=icpt, max_condition=1e10)
            exp = ols_expected(r2)
            c.add('nist-filip-forced', 'ols', args2, exp, tol=1e-5, source='published', published=pub,
                  note=src + '. Fitted only with maxCondition raised to 1e10; tolerance against the exact solve on the float design 1e-5 (kappa_s^2 eps is about 3e3)')
            continue
        r = o_ols(X, y, intercept=icpt)
        exp = ols_expected(r)
        tol = {'Norris': 1e-11, 'Pontius': 1e-9, 'NoInt1': 1e-12, 'NoInt2': 1e-12, 'Longley': 1e-9,
               'Wampler1': 1e-8, 'Wampler2': 1e-10, 'Wampler3': 1e-8, 'Wampler4': 1e-6, 'Wampler5': 1e-4}[name]
        c.add(f'nist-{name.lower()}', 'ols', args, exp, tol=tol, source='published', published=pub,
              note=src + ('; an exact fit (residual SD certified 0): t values are ratios of rounding noise and are not compared' if name in ('Wampler1', 'Wampler2') else ''))
    return report


# ------------------------------------------------------------------ synthetic well data

WELLS = [f'EKENE-{k}' for k in range(1, 11)]


def gauss(rng, mu, sd):
    return mu + sd * rng.gauss(0, 1)


def well_logs(seed=2601, n_per=12, offset_sd=0.02):
    """Porosity from density and neutron with a per-well offset (a well
    effect the logs do not explain)."""
    rng = random.Random(seed)
    X, y, g, pay = [], [], [], []
    for w in WELLS:
        off = gauss(rng, 0, offset_sd)
        for _ in range(n_per):
            rhob = round(gauss(rng, 2.40, 0.08), 3)
            nphi = round(gauss(rng, 0.22, 0.04), 3)
            gr = round(gauss(rng, 70, 18), 1)
            phi = (2.65 - rhob) / (2.65 - 1.0) * 0.6 + 0.4 * nphi - 0.0004 * (gr - 70) + off + gauss(rng, 0, 0.01)
            X.append([gr, rhob, nphi])
            y.append(round(phi, 4))
            g.append(w)
            z = -0.08 * (gr - 70) + 25 * (nphi - 0.22) + gauss(rng, 0, 1.2)
            pay.append(1 if z > 0 else 0)
    return X, y, g, pay


def leak_data(seed=77):
    """Target driven by a large random well offset; five well-level
    attributes (constant within a well) let a linear model memorise the
    offsets of wells it has seen, which a new well does not share."""
    rng = random.Random(seed)
    X, y, g = [], [], []
    for w in WELLS:
        attrs = [round(gauss(rng, 0, 1), 3) for _ in range(5)]
        off = gauss(rng, 0, 0.05)
        for _ in range(12):
            rhob = round(gauss(rng, 2.40, 0.06), 3)
            phi = (2.65 - rhob) / 1.65 * 0.6 + off + gauss(rng, 0, 0.005)
            X.append([rhob] + attrs)
            y.append(round(phi, 4))
            g.append(w)
    return X, y, g


# ------------------------------------------------------------------ build

def build():
    c = Cases()
    nist_worst = nist_self_check()
    float_digits = nist_cases(c)

    X, y, g, pay = well_logs()
    names = ['GR', 'RHOB', 'NPHI']

    # ---------------- scalers
    c.add('scaler-standard-all', 'fitStandardScaler', {'X': X, 'names': names}, o_scaler(X, names=names))
    c.add('scaler-standard-sample', 'fitStandardScaler', {'X': X, 'names': names, 'sd': 'sample'}, o_scaler(X, names=names, sd='sample'))
    sp = o_group_split(g, 7, 0.3)
    c.add('scaler-standard-train-only', 'fitStandardScaler', {'X': X, 'names': names, 'trainIndices': sp['trainIndices']},
          o_scaler(X, sp['trainIndices'], names), note='fitted on the training wells of groupSplit(seed 7, 0.3) only')
    c.add('scaler-minmax-train-only', 'fitMinMaxScaler', {'X': X, 'names': names, 'trainIndices': sp['trainIndices']},
          o_scaler(X, sp['trainIndices'], names, kind='minmax'))
    c.add('scaler-minmax-all', 'fitMinMaxScaler', {'X': X}, o_scaler(X, kind='minmax'))
    small = [[1.0, 10.0], [2.0, 10.0], [4.0, 10.0]]
    r = o_scaler(small, names=['GR', 'BS'])
    c.refuse('scaler-zero-variance', 'fitStandardScaler', {'X': small, 'names': ['GR', 'BS']}, r['field'], r['message'])
    r = o_scaler(small, names=['GR', 'BS'], kind='minmax')
    c.refuse('scaler-minmax-zero-range', 'fitMinMaxScaler', {'X': small, 'names': ['GR', 'BS']}, r['field'], r['message'])
    varies = [[1.0, 10.0], [2.0, 10.0], [4.0, 11.0]]
    r = o_scaler(varies, [0, 1], names=['GR', 'BS'])
    c.refuse('scaler-zero-variance-on-train-rows', 'fitStandardScaler', {'X': varies, 'names': ['GR', 'BS'], 'trainIndices': [0, 1]}, r['field'], r['message'],
             note='BS varies over all rows but not over the training rows: refused, the fit sees the training rows only')
    c.refuse('scaler-bad-sd', 'fitStandardScaler', {'X': small, 'sd': 'n-1'}, 'sd')
    c.refuse('scaler-bad-train-index', 'fitStandardScaler', {'X': small, 'trainIndices': [0, 3]}, 'trainIndices[1]')
    c.refuse('scaler-repeat-train-index', 'fitStandardScaler', {'X': small, 'trainIndices': [0, 0]}, 'trainIndices[1]')
    c.refuse('scaler-ragged', 'fitStandardScaler', {'X': [[1.0, 2.0], [3.0]]}, 'X[1]')
    c.refuse('scaler-missing-value', 'fitStandardScaler', {'X': [[1.0, 2.0], [3.0, None]]}, 'X[1][1]')
    c.refuse('scaler-sample-one-row', 'fitStandardScaler', {'X': [[1.0]], 'sd': 'sample'}, 'X')
    sc = o_scaler(X, sp['trainIndices'], names)
    new = [[40.0, 2.2, 0.3], [150.0, 2.7, 0.05]]
    c.add('apply-standard', 'applyScaler', {'scaler': sc, 'X': new}, o_apply(sc, new))
    mm = o_scaler(X, sp['trainIndices'], names, kind='minmax')
    c.add('apply-minmax-outside-range', 'applyScaler', {'scaler': mm, 'X': new}, o_apply(mm, new),
          note='a new row outside the training range maps outside [0, 1]: no clipping')
    c.refuse('apply-wrong-columns', 'applyScaler', {'scaler': sc, 'X': [[1.0, 2.0]]}, 'X')
    c.refuse('apply-not-a-scaler', 'applyScaler', {'scaler': {'kind': 'other'}, 'X': [[1.0]]}, 'scaler')

    # ---------------- splits
    for seed in (1, 7, 42, 2026, 4294967295):
        c.add(f'group-split-0.3-seed{seed}', 'groupSplit', {'groups': g, 'testFraction': 0.3, 'seed': seed}, o_group_split(g, seed, 0.3), tol=0)
    g25 = [f'W{k:02d}' for k in range(1, 26) for _ in range(2)]
    assert 0.28 * 25 != 7 and ceil_count(0.28, 25) == 7
    c.add('group-split-0.28-of-25', 'groupSplit', {'groups': g25, 'testFraction': 0.28, 'seed': 8}, o_group_split(g25, 8, 0.28), tol=0,
          note='0.28 x 25 is 7.000000000000001 in float; the 1e-9 whole-number rule gives 7 test groups, not 8')
    c.add('random-rows-0.28-of-25', 'randomRowSplit', {'n': 25, 'testFraction': 0.28, 'seed': 8}, o_random_rows(25, 0.28, 8), tol=0,
          note='0.28 x 25 rows: 7 test rows, not 8')
    c.add('group-split-0.25', 'groupSplit', {'groups': g, 'testFraction': 0.25, 'seed': 3}, o_group_split(g, 3, 0.25), tol=0,
          note='ceil(0.25 x 10) = ceil(2.5) = 3')
    c.add('group-split-n2', 'groupSplit', {'groups': g, 'nTestGroups': 2, 'seed': 11}, o_group_split(g, 11, n_test=2), tol=0)
    num_groups = [101, 101, 205, 205, 205, 17, 17, 9, 9, 9]
    c.add('group-split-numeric-ids', 'groupSplit', {'groups': num_groups, 'testFraction': 0.5, 'seed': 5}, o_group_split(num_groups, 5, 0.5), tol=0,
          note='numeric ids sort ascending (9, 17, 101, 205) before the shuffle')
    c.refuse('group-split-one-group', 'groupSplit', {'groups': ['A', 'A'], 'testFraction': 0.5, 'seed': 1}, 'groups',
             'groups must hold at least 2 distinct groups to hold one out (found 1)')
    c.refuse('group-split-all-test', 'groupSplit', {'groups': ['A', 'B', 'C'], 'testFraction': 0.9, 'seed': 1}, 'testFraction',
             'testFraction puts all 3 groups in the test set (ceil(0.9 x 3) = 3): lower it so at least one group trains')
    c.refuse('group-split-both-sizes', 'groupSplit', {'groups': ['A', 'B'], 'testFraction': 0.5, 'nTestGroups': 1, 'seed': 1}, 'nTestGroups')
    c.refuse('group-split-mixed-ids', 'groupSplit', {'groups': ['A', 1], 'testFraction': 0.5, 'seed': 1}, 'groups[1]')
    c.refuse('group-split-bad-seed', 'groupSplit', {'groups': ['A', 'B'], 'testFraction': 0.5, 'seed': -1}, 'seed')
    c.refuse('group-split-fraction-one', 'groupSplit', {'groups': ['A', 'B'], 'testFraction': 1, 'seed': 1}, 'testFraction')
    for k, seed in ((3, 1), (5, 42), (10, 9), (4, 2026)):
        c.add(f'group-kfold-k{k}-seed{seed}', 'groupKFold', {'groups': g, 'k': k, 'seed': seed}, o_group_kfold(g, k, seed), tol=0)
    c.refuse('group-kfold-k-too-big', 'groupKFold', {'groups': ['A', 'B', 'C'], 'k': 4, 'seed': 1}, 'k',
             'k must be a whole number from 2 to 3 (the number of distinct groups)')
    c.refuse('group-kfold-k1', 'groupKFold', {'groups': ['A', 'B', 'C'], 'k': 1, 'seed': 1}, 'k')
    for seed in (1, 42, 99):
        c.add(f'random-rows-seed{seed}', 'randomRowSplit', {'groups': g, 'testFraction': 0.3, 'seed': seed}, o_random_rows(len(g), 0.3, seed, g), tol=0,
              note='rows of one well land on both sides: sharedGroups lists them')
    c.add('random-rows-n-only', 'randomRowSplit', {'n': 10, 'testFraction': 0.3, 'seed': 5}, o_random_rows(10, 0.3, 5), tol=0)
    c.refuse('random-rows-n-mismatch', 'randomRowSplit', {'n': 3, 'groups': ['A', 'B'], 'testFraction': 0.5, 'seed': 1}, 'n')
    c.refuse('random-rows-all-test', 'randomRowSplit', {'n': 2, 'testFraction': 0.6, 'seed': 1}, 'testFraction',
             'testFraction puts all 2 rows in the test set (ceil(0.6 x 2) = 2): lower it so at least one row trains')

    # ---------------- OLS on well data
    r = o_ols(X, y, names)
    c.add('ols-porosity-all-wells', 'ols', {'X': X, 'y': y, 'names': names}, strip(r))
    trX = [X[i] for i in sp['trainIndices']]
    trY = [y[i] for i in sp['trainIndices']]
    c.add('ols-porosity-train-wells', 'ols', {'X': trX, 'y': trY, 'names': names}, strip(o_ols(trX, trY, names)))
    c.add('ols-porosity-no-intercept', 'ols', {'X': X, 'y': y, 'names': names, 'intercept': False}, strip(o_ols(X, y, names, intercept=False)))
    c.add('ols-one-feature', 'ols', {'X': [[r_[1]] for r_ in X], 'y': y, 'names': ['RHOB']}, strip(o_ols([[r_[1]] for r_ in X], y, ['RHOB'])))
    tiny = [[1.0], [2.0], [4.0]]
    c.add('ols-three-points', 'ols', {'X': tiny, 'y': [1.0, 3.0, 4.0]}, strip(o_ols(tiny, [1.0, 3.0, 4.0])), tol=TOL_TIGHT)
    c.refuse('ols-too-few-rows', 'ols', {'X': [[1.0], [2.0]], 'y': [1.0, 2.0]}, 'X',
             'X must have more rows than coefficients (2 rows for 2 coefficients, the intercept included): the residual degrees of freedom n - p must be at least 1')
    c.refuse('ols-zero-column', 'ols', {'X': [[0.0, 1.0], [0.0, 2.0], [0.0, 3.0], [0.0, 5.0]], 'y': [1.0, 2.0, 3.0, 4.0], 'names': ['SP', 'GR']}, 'X.SP',
             'X.SP is zero in every row, so its coefficient is not identifiable')
    c.refuse('ols-constant-y', 'ols', {'X': tiny, 'y': [2.0, 2.0, 2.0]}, 'y', 'y has zero variance about its mean (every value is equal), so R-squared is undefined')
    c.refuse('ols-zero-y-no-intercept', 'ols', {'X': tiny, 'y': [0.0, 0.0, 0.0], 'intercept': False}, 'y', 'y is zero in every row, so the uncentred R-squared is undefined')
    coll = [[1.0, 2.0], [2.0, 4.0], [3.0, 6.0], [4.0, 8.0], [5.0, 10.0]]
    c.refuse('ols-collinear', 'ols', {'X': coll, 'y': [1.0, 2.0, 2.0, 4.0, 5.0]}, 'X',
             starts='X is too ill-conditioned for a float64 least squares fit: the scaled condition number ',
             ends=' is above maxCondition 100000000' + COND_TAIL, note='x2 = 2 x1 exactly: the scaled condition number is infinite or astronomically large in float')
    c.refuse('ols-constant-feature', 'ols', {'X': [[1.0, 7.0], [2.0, 7.0], [3.0, 7.0], [5.0, 7.0]], 'y': [1.0, 2.0, 2.0, 4.0]}, 'X',
             starts='X is too ill-conditioned for a float64 least squares fit: the scaled condition number ',
             ends=' is above maxCondition 100000000' + COND_TAIL, note='a constant feature is collinear with the intercept')
    c.refuse('ols-bad-maxcondition', 'ols', {'X': tiny, 'y': [1.0, 3.0, 4.0], 'maxCondition': 0.5}, 'maxCondition')
    c.refuse('ols-y-length', 'ols', {'X': tiny, 'y': [1.0, 3.0]}, 'y')
    c.refuse('ols-duplicate-names', 'ols', {'X': coll, 'y': [1.0, 2.0, 2.0, 4.0, 5.0], 'names': ['GR', 'GR']}, 'names[1]')
    c.refuse('ols-intercept-name', 'ols', {'X': tiny, 'y': [1.0, 3.0, 4.0], 'names': ['intercept']}, 'names[0]')
    # maxCondition boundary: exactly-at-the-limit fits; just below the kappa refuses
    lg = parse_nist('Longley')
    LX, Ly = nist_design('Longley', lg['rows'], exact=False)
    rl = o_ols(LX, Ly)
    kap = rl['scaledConditionNumber']
    c.refuse('ols-longley-below-limit', 'ols', {'X': LX, 'y': Ly, 'maxCondition': 43000}, 'X',
             starts='X is too ill-conditioned for a float64 least squares fit: the scaled condition number ',
             ends=' is above maxCondition 43000' + COND_TAIL, figure=kap,
             note=f'Longley scaled condition number {kap:.6g} is above a limit of 43000')
    c.add('ols-longley-limit-44000', 'ols', {'X': LX, 'y': Ly, 'maxCondition': 44000}, strip(rl), tol=1e-9)

    # ---------------- ridge
    for lam in (0, 0.1, 1, 10, 100):
        c.add(f'ridge-porosity-lambda{lam}', 'ridge', {'X': X, 'y': y, 'lambda': lam, 'names': names}, o_ridge(X, y, lam, names))
    c.add('ridge-longley-lambda1', 'ridge', {'X': LX, 'y': Ly, 'lambda': 1}, o_ridge(LX, Ly, 1), tol=1e-8)
    c.add('ridge-longley-lambda0', 'ridge', {'X': LX, 'y': Ly, 'lambda': 0}, o_ridge(LX, Ly, 0), tol=1e-8,
          note='lambda 0 on standardised Longley: the OLS fit; the standardised design has the same scaled condition number regime')
    wide = [[1.0, 2.0, 0.5, 3.0], [2.0, 1.0, 0.1, 2.0], [3.0, 5.0, 0.4, 1.0], [4.0, 3.0, 0.9, 0.0]]
    c.add('ridge-more-features-than-rows', 'ridge', {'X': wide, 'y': [1.0, 2.0, 2.5, 4.0], 'lambda': 0.5}, o_ridge(wide, [1.0, 2.0, 2.5, 4.0], 0.5),
          note='4 rows, 4 features: OLS is impossible, ridge with lambda > 0 is well posed')
    c.refuse('ridge-negative-lambda', 'ridge', {'X': X, 'y': y, 'lambda': -1}, 'lambda')
    r = o_scaler(small, names=['GR', 'BS'])
    c.refuse('ridge-constant-feature', 'ridge', {'X': small, 'y': [1.0, 2.0, 3.0], 'lambda': 1, 'names': ['GR', 'BS']}, r['field'], r['message'])
    c.refuse('ridge-lambda0-collinear', 'ridge', {'X': coll, 'y': [1.0, 2.0, 2.0, 4.0, 5.0], 'lambda': 0}, 'X',
             starts='X is too ill-conditioned for a float64 ridge fit: the scaled condition number ', ends=' is above maxCondition 100000000' + COND_TAIL)
    c.add('ridge-lambda1-collinear', 'ridge', {'X': coll, 'y': [1.0, 2.0, 2.0, 4.0, 5.0], 'lambda': 1}, o_ridge(coll, [1.0, 2.0, 2.0, 4.0, 5.0], 1),
          note='the same collinear pair is well posed under a penalty: the two standardised coefficients come out equal')

    # ---------------- logistic
    lx = [[r_[0], r_[2]] for r_ in X]
    out, _ = o_logistic(lx, pay, names=['GR', 'NPHI'])
    c.add('logistic-pay-gr-nphi', 'logistic', {'X': lx, 'y': pay, 'names': ['GR', 'NPHI']}, out, tol=1e-9)
    for l2 in (0.5, 5):
        out, _ = o_logistic(lx, pay, l2=l2, names=['GR', 'NPHI'])
        c.add(f'logistic-pay-l2-{l2}', 'logistic', {'X': lx, 'y': pay, 'names': ['GR', 'NPHI'], 'l2': l2}, out, tol=1e-9)
    x8 = [[1.0], [2.0], [3.0], [4.0], [5.0], [6.0], [7.0], [8.0]]
    y8 = [0, 0, 1, 0, 1, 0, 1, 1]
    out, _ = o_logistic(x8, y8)
    c.add('logistic-small-overlap', 'logistic', {'X': x8, 'y': y8}, out, tol=1e-9)
    out, _ = o_logistic(x8, y8, intercept=False, tol=1e-12)
    c.add('logistic-no-intercept', 'logistic', {'X': x8, 'y': y8, 'intercept': False, 'tol': 1e-12}, out, tol=1e-9,
          note='tol 1e-12: at the default 1e-10 one Newton change (1.7e-10) sits within a factor 100 of tol, too close for a stable iteration count')
    out, rr = o_logistic(x8, y8, max_iter=2)
    c.add('logistic-maxiter-2', 'logistic', {'X': x8, 'y': y8, 'maxIter': 2}, out, tol=1e-9, note='stops after 2 updates, converged false, coefficients are the second Newton iterate')
    # separation: certificates checked exactly
    ysep = [0, 0, 0, 0, 1, 1, 1, 1]
    A8 = [[1.0] + r_ for r_ in x8]
    kind = certify_separation(A8, ysep, beta_cert=[-4.5, 1])
    c.refuse('logistic-complete-separation', 'logistic', {'X': x8, 'y': ysep}, 'y', sep_message(kind),
             note='certificate beta = (-4.5, 1): every s_i x_i\'beta > 0')
    xq = [[1.0], [2.0], [3.0], [3.0], [4.0], [5.0]]
    yq = [0, 0, 0, 1, 1, 1]
    Aq = [[1.0] + r_ for r_ in xq]
    kind = certify_separation(Aq, yq, beta_cert=[-3, 1], gordan=[0, 0, 1, 1, 0, 0])
    c.refuse('logistic-quasi-separation', 'logistic', {'X': xq, 'y': yq}, 'y', sep_message(kind),
             note='certificate beta = (-3, 1) touches the two rows at x = 3; the Gordan weights on those two rows sum to zero, so no strict separator exists')
    xs2 = [[70.0, 0.1], [80.0, 0.12], [60.0, 0.2], [40.0, 0.25], [30.0, 0.28], [45.0, 0.3]]
    ys2 = [0, 0, 0, 1, 1, 1]
    kind = certify_separation([[1.0] + r_ for r_ in xs2], ys2, beta_cert=[5, -0.1, 0])
    c.refuse('logistic-separated-by-gr', 'logistic', {'X': xs2, 'y': ys2, 'names': ['GR', 'NPHI']}, 'y', sep_message(kind),
             note='GR alone separates: every pay row has GR below 50, every non-pay row above')
    for l2 in (1, 0.1):
        out, _ = o_logistic(x8, ysep, l2=l2)
        out['separation'] = {'detected': True, 'type': 'complete'}
        c.add(f'logistic-separated-l2-{l2}', 'logistic', {'X': x8, 'y': ysep, 'l2': l2}, out, tol=1e-9,
              note='separated, but the L2 penalty makes the penalised MLE finite: fitted and reported')
    out, _ = o_logistic(x8, y8)
    c.refuse('logistic-labels', 'logistic', {'X': x8, 'y': [0, 0, 1, 0, 2, 0, 1, 1]}, 'y[4]', 'y[4] must be 0 or 1')
    c.refuse('logistic-one-class', 'logistic', {'X': x8, 'y': [1] * 8}, 'y', 'y must contain both classes, 0 and 1')
    c.refuse('logistic-collinear', 'logistic', {'X': [[1.0, 2.0], [2.0, 4.0], [3.0, 6.0], [4.0, 8.0], [5.0, 10.0]], 'y': [0, 1, 0, 1, 1]}, 'X',
             starts='X is rank deficient or too ill-conditioned for an unpenalised fit: the scaled condition number ')
    c.refuse('logistic-bad-l2', 'logistic', {'X': x8, 'y': y8, 'l2': -1}, 'l2')
    c.refuse('logistic-bad-tol', 'logistic', {'X': x8, 'y': y8, 'tol': 0}, 'tol')
    c.refuse('logistic-bad-maxiter', 'logistic', {'X': x8, 'y': y8, 'maxIter': 0}, 'maxIter')

    # ---------------- predict
    olsm = o_ols(trX, trY, names)
    model_ols = {'kind': 'ols', 'intercept': True, 'names': olsm['names'], 'coefficients': olsm['coefficients']}
    teX = [X[i] for i in sp['testIndices']]
    teY = [y[i] for i in sp['testIndices']]
    vals, _ = o_predict_values(model_ols, teX)
    c.add('predict-ols', 'predict', {'model': model_ols, 'X': teX}, {'values': [fl(v) for v in vals]}, tol=TOL_TIGHT)
    lm, _ = o_logistic(lx, pay, names=['GR', 'NPHI'])
    model_log = {'kind': 'logistic', 'intercept': True, 'names': lm['names'], 'coefficients': lm['coefficients']}
    vals, cls = o_predict_values(model_log, lx[:30])
    c.add('predict-logistic', 'predict', {'model': model_log, 'X': lx[:30]}, {'values': [fl(v) for v in vals], 'classes': cls}, tol=TOL_TIGHT)
    half = {'kind': 'logistic', 'intercept': True, 'names': ['intercept', 'x1'], 'coefficients': [0.0, 1.0]}
    vals, cls = o_predict_values(half, [[0.0], [1e-9], [-1e-9]])
    c.add('predict-logistic-half', 'predict', {'model': half, 'X': [[0.0], [1e-9], [-1e-9]]}, {'values': [fl(v) for v in vals], 'classes': cls}, tol=TOL_TIGHT,
          note='probability exactly 0.5 is class 0; just above is class 1')
    c.refuse('predict-not-a-model', 'predict', {'model': {'kind': 'tree', 'coefficients': []}, 'X': [[1.0]]}, 'model')
    c.refuse('predict-wrong-columns', 'predict', {'model': model_ols, 'X': [[1.0]]}, 'X', 'X must have 3 columns, as the model was fitted on')

    # ---------------- regression metrics
    pv, _ = o_predict_values(model_ols, teX)
    pvf = [fl(v) for v in pv]
    c.add('metrics-ols-test-wells', 'regressionMetrics', {'yTrue': teY, 'yPred': pvf}, o_regression_metrics(teY, pvf))
    c.add('metrics-reference-train-mean', 'regressionMetrics', {'yTrue': teY, 'yPred': pvf, 'referenceMean': fl(sum(F(v) for v in trY) / len(trY))},
          o_regression_metrics(teY, pvf, fl(sum(F(v) for v in trY) / len(trY))), note='R-squared about the TRAINING mean (out-of-sample convention) differs from r2_score')
    c.add('metrics-worse-than-mean', 'regressionMetrics', {'yTrue': [1.0, 2.0, 3.0], 'yPred': [3.0, 2.0, 1.0]}, o_regression_metrics([1.0, 2.0, 3.0], [3.0, 2.0, 1.0]),
          tol=TOL_TIGHT, note='R-squared -3: worse than predicting the mean')
    c.add('metrics-perfect', 'regressionMetrics', {'yTrue': [0.1, 0.2, 0.3], 'yPred': [0.1, 0.2, 0.3]}, o_regression_metrics([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]), tol=TOL_TIGHT)
    c.refuse('metrics-constant-truth', 'regressionMetrics', {'yTrue': [2.0, 2.0], 'yPred': [1.0, 3.0]}, 'yTrue',
             'yTrue has zero variance (every value is equal), so R-squared about its mean is undefined')
    c.refuse('metrics-length', 'regressionMetrics', {'yTrue': [1.0, 2.0], 'yPred': [1.0]}, 'yPred')

    # ---------------- classification metrics
    rng = random.Random(9)
    facies = ['sand', 'shale', 'silt', 'lime']
    ft = [rng.choice(facies) for _ in range(60)]
    fp_ = [t if rng.random() < 0.7 else rng.choice(facies) for t in ft]
    c.add('confusion-facies', 'confusionMatrix', {'yTrue': ft, 'yPred': fp_}, o_confusion(ft, fp_), tol=0)
    c.add('confusion-facies-labels', 'confusionMatrix', {'yTrue': ft, 'yPred': fp_, 'labels': ['shale', 'silt', 'sand', 'lime']},
          o_confusion(ft, fp_, ['shale', 'silt', 'sand', 'lime']), tol=0)
    c.add('report-facies', 'classificationReport', {'yTrue': ft, 'yPred': fp_}, o_report(ft, fp_), tol=TOL_TIGHT)
    yt4 = ['sand', 'shale', 'sand', 'lime']
    yp4 = ['sand', 'sand', 'sand', 'sand']
    c.add('report-never-predicted-zd0', 'classificationReport', {'yTrue': yt4, 'yPred': yp4}, o_report(yt4, yp4, zd=0), tol=TOL_TIGHT,
          note='lime and shale are never predicted: their precision is undefined and scores 0')
    c.add('report-never-predicted-zd1', 'classificationReport', {'yTrue': yt4, 'yPred': yp4, 'zeroDivision': 1}, o_report(yt4, yp4, zd=1), tol=TOL_TIGHT)
    labs = ['coal', 'lime', 'sand', 'shale']
    c.add('report-absent-label-zd0', 'classificationReport', {'yTrue': yt4, 'yPred': yp4, 'labels': labs}, o_report(yt4, yp4, labs, 0), tol=TOL_TIGHT,
          note='coal is neither true nor predicted: precision, recall and F1 all undefined; it still counts in the macro mean')
    c.add('report-absent-label-zd1', 'classificationReport', {'yTrue': yt4, 'yPred': yp4, 'labels': labs, 'zeroDivision': 1}, o_report(yt4, yp4, labs, 1), tol=TOL_TIGHT)
    bt = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1]
    bp = [1, 0, 0, 1, 0, 1, 1, 0, 1, 0]
    c.add('report-binary', 'classificationReport', {'yTrue': bt, 'yPred': bp}, o_report(bt, bp), tol=TOL_TIGHT)
    c.refuse('report-bad-zd', 'classificationReport', {'yTrue': bt, 'yPred': bp, 'zeroDivision': 0.5}, 'zeroDivision')
    c.refuse('report-label-not-listed', 'classificationReport', {'yTrue': yt4, 'yPred': yp4, 'labels': ['sand', 'shale']}, 'yTrue[3]',
             'yTrue[3] is "lime", which is not in labels')
    c.refuse('confusion-mixed-types', 'confusionMatrix', {'yTrue': ['a', 1], 'yPred': ['a', 'a']}, 'yTrue')
    c.refuse('confusion-repeated-labels', 'confusionMatrix', {'yTrue': ['a'], 'yPred': ['a'], 'labels': ['a', 'a']}, 'labels')

    # ---------------- ROC and log loss
    ry = [0, 1, 0, 1, 1, 0]
    rs_ = [0.1, 0.4, 0.4, 0.8, 0.8, 0.2]
    c.add('roc-ties', 'rocCurve', {'yTrue': ry, 'scores': rs_}, o_roc(ry, rs_), tol=TOL_TIGHT,
          note='score 0.4 is shared by one positive and one negative: one diagonal step, counted one half')
    allties = [0, 1, 0, 1]
    c.add('roc-all-tied', 'rocCurve', {'yTrue': allties, 'scores': [0.5] * 4}, o_roc(allties, [0.5] * 4), tol=TOL_TIGHT, note='every score equal: AUC 0.5 exactly')
    c.add('roc-perfect', 'rocCurve', {'yTrue': [0, 0, 1, 1], 'scores': [0.1, 0.2, 0.8, 0.9]}, o_roc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), tol=TOL_TIGHT)
    c.add('roc-inverted', 'rocCurve', {'yTrue': [1, 1, 0, 0], 'scores': [0.1, 0.2, 0.8, 0.9]}, o_roc([1, 1, 0, 0], [0.1, 0.2, 0.8, 0.9]), tol=TOL_TIGHT)
    probs = [fl(v) for v in o_predict_values(model_log, lx)[0]]
    c.add('roc-logistic-pay', 'rocCurve', {'yTrue': pay, 'scores': probs}, o_roc(pay, probs), tol=TOL_TIGHT)
    rng = random.Random(31)
    coarse = [round(rng.random(), 1) for _ in range(80)]
    cy = [1 if rng.random() < 0.3 + 0.5 * s else 0 for s in coarse]
    c.add('roc-coarse-scores', 'rocCurve', {'yTrue': cy, 'scores': coarse}, o_roc(cy, coarse), tol=TOL_TIGHT,
          note='scores rounded to one decimal: many ties across the classes')
    c.refuse('roc-one-class', 'rocCurve', {'yTrue': [1, 1], 'scores': [0.2, 0.3]}, 'yTrue',
             'yTrue must contain both classes (found 2 positive and 0 negative), or the ROC curve is undefined')
    c.refuse('roc-bad-label', 'rocCurve', {'yTrue': [1, 2], 'scores': [0.2, 0.3]}, 'yTrue[1]')
    c.add('logloss-logistic-pay', 'logLoss', {'yTrue': pay, 'probabilities': probs}, o_logloss(pay, probs), tol=1e-12)
    c.add('logloss-clipped', 'logLoss', {'yTrue': [1, 0, 1, 0], 'probabilities': [1.0, 0.0, 0.0, 0.3]}, o_logloss([1, 0, 1, 0], [1.0, 0.0, 0.0, 0.3]), tol=1e-12,
          note='p = 1 and p = 0 are clipped to eps; a confident wrong 0 for a positive costs -ln(1e-15) = 34.54')
    c.add('logloss-eps-1e-7', 'logLoss', {'yTrue': [1, 0, 1, 0], 'probabilities': [1.0, 0.0, 0.0, 0.3], 'eps': 1e-7},
          o_logloss([1, 0, 1, 0], [1.0, 0.0, 0.0, 0.3], 1e-7), tol=1e-12)
    c.add('logloss-half', 'logLoss', {'yTrue': [1, 0], 'probabilities': [0.5, 0.5]}, o_logloss([1, 0], [0.5, 0.5]), tol=1e-14, note='ln 2')
    c.refuse('logloss-bad-probability', 'logLoss', {'yTrue': [1, 0], 'probabilities': [1.2, 0.5]}, 'probabilities[0]', 'probabilities[0] must be a number from 0 to 1')
    c.refuse('logloss-bad-eps', 'logLoss', {'yTrue': [1, 0], 'probabilities': [0.2, 0.5], 'eps': 0.5}, 'eps')

    # ---------------- permutation importance
    for metric, seed in (('r2', 1), ('rmse', 2), ('mae', 3)):
        c.add(f'perm-ols-{metric}', 'permutationImportance', {'model': model_ols, 'X': teX, 'y': teY, 'metric': metric, 'nRepeats': 5, 'seed': seed},
              o_perm_importance(model_ols, teX, teY, metric, 5, seed), tol=1e-9)
    for metric, seed in (('auc', 4), ('accuracy', 5), ('logLoss', 6)):
        c.add(f'perm-logistic-{metric}', 'permutationImportance', {'model': model_log, 'X': lx, 'y': pay, 'metric': metric, 'nRepeats': 4, 'seed': seed},
              o_perm_importance(model_log, lx, pay, metric, 4, seed), tol=1e-9)
    c.refuse('perm-wrong-metric', 'permutationImportance', {'model': model_ols, 'X': teX, 'y': teY, 'metric': 'auc', 'seed': 1}, 'metric',
             'metric auc is a classification metric and the model is ols')
    c.refuse('perm-bad-repeats', 'permutationImportance', {'model': model_ols, 'X': teX, 'y': teY, 'nRepeats': 0, 'seed': 1}, 'nRepeats')

    # ---------------- learning curve
    c.add('learning-curve-ols', 'learningCurve', {'X': X, 'y': y, 'groups': g, 'model': {'kind': 'ols'}, 'trainGroupCounts': [1, 2, 4, 7], 'testFraction': 0.3, 'seed': 7, 'metric': 'r2'},
          o_learning_curve(X, y, g, {'kind': 'ols'}, [1, 2, 4, 7], 7, 'r2', 0.3), tol=1e-9)
    c.add('learning-curve-ridge-rmse', 'learningCurve', {'X': X, 'y': y, 'groups': g, 'model': {'kind': 'ridge', 'lambda': 1}, 'trainGroupCounts': [1, 3, 5, 8], 'nTestGroups': 2, 'seed': 3, 'metric': 'rmse'},
          o_learning_curve(X, y, g, {'kind': 'ridge', 'lambda': 1}, [1, 3, 5, 8], 3, 'rmse', n_test=2), tol=1e-9)
    c.add('learning-curve-logistic-auc', 'learningCurve', {'X': lx, 'y': pay, 'groups': g, 'model': {'kind': 'logistic', 'l2': 1}, 'trainGroupCounts': [2, 4, 7], 'testFraction': 0.3, 'seed': 42},
          o_learning_curve(lx, pay, g, {'kind': 'logistic', 'l2': 1}, [2, 4, 7], 42, 'auc', 0.3), tol=1e-9)
    c.refuse('learning-curve-too-many', 'learningCurve', {'X': X, 'y': y, 'groups': g, 'model': {'kind': 'ols'}, 'trainGroupCounts': [1, 8], 'testFraction': 0.3, 'seed': 7}, 'trainGroupCounts[1]',
             'trainGroupCounts[1] must be a whole number from 1 to 7 (the training groups)')
    c.refuse('learning-curve-not-increasing', 'learningCurve', {'X': X, 'y': y, 'groups': g, 'model': {'kind': 'ols'}, 'trainGroupCounts': [3, 3], 'testFraction': 0.3, 'seed': 7}, 'trainGroupCounts[1]')
    c.refuse('learning-curve-bad-kind', 'learningCurve', {'X': X, 'y': y, 'groups': g, 'model': {'kind': 'svm'}, 'trainGroupCounts': [1], 'testFraction': 0.3, 'seed': 7}, 'model.kind')

    # ---------------- leakage demo
    LXd, Lyd, Lg = leak_data()
    for seed in (1, 5, 13):
        c.add(f'leakage-ridge-r2-seed{seed}', 'leakageDemo', {'X': LXd, 'y': Lyd, 'groups': Lg, 'model': {'kind': 'ridge', 'lambda': 0.1}, 'testFraction': 0.3, 'seed': seed, 'metric': 'r2'},
              o_leakage(LXd, Lyd, Lg, {'kind': 'ridge', 'lambda': 0.1}, 0.3, seed, 'r2'), tol=1e-9,
              note='five well-level attributes let the model memorise the offsets of wells it trained on')
    c.add('leakage-ols-rmse-logs', 'leakageDemo', {'X': X, 'y': y, 'groups': g, 'model': {'kind': 'ols'}, 'testFraction': 0.3, 'seed': 2, 'metric': 'rmse'},
          o_leakage(X, y, g, {'kind': 'ols'}, 0.3, 2, 'rmse'), tol=1e-9)
    c.refuse('leakage-no-groups', 'leakageDemo', {'X': X, 'y': y, 'model': {'kind': 'ols'}, 'testFraction': 0.3, 'seed': 2}, 'groups')

    return c, nist_worst, float_digits


def main():
    check_js_num()
    c, nist_worst, float_digits = build()
    out = {
        'module': 'ml',
        'generatedBy': 'tools/validation/dataai/oracle_ml.py',
        'tolerance': {'absoluteFloor': 1e-12, 'note': 'relative tolerance per case in `tol`; `abs` per case overrides the absolute floor; a difference below the floor always passes'},
        'description': 'Machine learning on well data: train-only scalers, seeded group splits and k-fold, OLS (QR), ridge, logistic (Newton) with separation, regression and classification metrics, ROC with ties, log loss, permutation importance, learning curve, leakage demo. NIST StRD certified values are published anchors; everything else is oracle-derived with the python standard library.',
        'nistOracleDigits': {k: round(v, 2) for k, v in nist_worst.items()},
        'nistFloatDesignDigits': {k: round(v, 2) for k, v in float_digits.items()},
        'cases': c.cases,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False, allow_nan=False)
        fh.write('\n')
    pub_n = sum(1 for x in c.cases if x['source'] == 'published')
    ref_n = sum(1 for x in c.cases if isinstance(x['expected'], dict) and x['expected'].get('error') is True)
    print('wrote', os.path.relpath(DEST), len(c.cases), 'cases,', pub_n, 'published,', ref_n, 'refusals')
    print('oracle exact solve vs NIST certified (min LRE):', {k: round(v, 1) for k, v in nist_worst.items()})
    print('exact solve on the FLOAT design vs certified coefficients (min LRE):', {k: round(v, 1) for k, v in float_digits.items()})


if __name__ == '__main__':
    main()
