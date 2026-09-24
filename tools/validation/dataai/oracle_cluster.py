#!/usr/bin/env python3
"""Independent oracle for engines/dataai/cluster.js (Data & AI D3, electrofacies).

STDLIB ONLY. Run with any python 3.10+:

    python3 tools/validation/dataai/oracle_cluster.py

It writes test-data/dataai/goldens/cluster_cases.json. Nothing here reads or
imports the JavaScript; every value is computed from the published
definitions by a road chosen to differ from the engine's:

  route             oracle road                              engine road
  ----------------  ---------------------------------------  ----------------------
  scaling           Fraction means, Decimal(60) SDs          ml.js float scalers
  PCA eigen         bisection on the inertia (negative LDL'  cyclic Jacobi in float
                    pivot count, Sylvester) in Decimal(60),
                    eigenvectors by inverse iteration
  k-means++         32-bit integer mulberry32; the draw      float u, running
                    u x total compared exactly (Decimal)     float sum
  Lloyd             Decimal(60) distances and means          float
  silhouette        Decimal(60), the definition row by row   pair loop, float sums
  agglomerative     cluster distances from their DEFINITIONS Lance-Williams update
                    (max / mean over member pairs; Ward from on heights, nearest-
                    centroids, sqrt(2 na nb / (na + nb)       neighbour cache
                    |ca - cb|^2)), every pair every step
  kNN               full sort of Decimal distances           insertion buffer
  CART              Fractions; every candidate threshold     incremental counts,
                    re-counted from the rows                 exact BigInt ties
  ARI               pair counting over all C(n, 2) pairs     contingency formula
  matching          brute force over every injective map     Hungarian + greedy fix
                    in lexicographic order

AMBIGUITY GUARD. Where a float program could take a different branch from
the exact one (an assignment within 1e-9 of a tie, a k-means++ draw within
1e-9 of a boundary, a merge height between 1e-30 and 1e-9 of the smallest,
a kNN boundary distance, a sign-rule loading near the tie band) the oracle
REFUSES TO WRITE the case (raises). Exact ties are allowed only where the
float arithmetic is exact too (declared per case).

WHAT IT CANNOT CHECK: the conventions (tie rules, sign rule, empty cluster
rule, scaling choices, CART stopping rules, the row caps, the 1e-12 merge
tie band). Those are choices written in FINDINGS-cluster.md and applied here
the same way; the oracle checks the arithmetic of those choices.

Published: Fisher's iris data (Fisher 1936, Annals of Eugenics 7:179-188),
committed at test-data/dataai/iris/iris.csv (the scikit-learn copy, which
carries Fisher's values for samples 35 and 38 where the UCI copy is wrong).
Published figure: the covariance-PCA explained variance ratio of the first
two components, [0.92461872 0.05306648], printed in the scikit-learn
example "Comparison of LDA and PCA 2D projection of Iris dataset"
(scikit-learn.org/stable/auto_examples/decomposition/plot_pca_vs_lda.html,
read 2026-09-24). The oracle requires its own exact value to round to it.
"""
import itertools
import json
import math
import os
import random
from decimal import Decimal as D, getcontext
from fractions import Fraction as F

getcontext().prec = 60

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'cluster_cases.json')
IRIS = os.path.join(ROOT, 'test-data', 'dataai', 'iris', 'iris.csv')

TOL = 1e-10
TIGHT = 1e-12
AMBIG = D('1e-9')      # a float program may branch differently inside this band
EXACT = D('1e-30')     # a Decimal(60) difference below this is an exact tie
MERGE_TIE = D('1e-12')  # the engine's stated merge tie band
SIGN_TIE = D('1e-9')    # the engine's stated sign-rule band


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
    return float(x)


def dec(x):
    if isinstance(x, F):
        return D(x.numerator) / D(x.denominator)
    return D(x)


# ------------------------------------------------------------------ mulberry32

M32 = 0xFFFFFFFF


def imul(a, b):
    return (a * b) & M32


class Mulberry32:
    """mulberry32 from its definition in unsigned 32-bit integers; u = k / 2^32."""

    def __init__(self, seed):
        self.a = seed & M32

    def next_int(self):
        self.a = (self.a + 0x6D2B79F5) & M32
        t = self.a
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return (t ^ (t >> 14)) & M32

    def u(self):
        return F(self.next_int(), 2 ** 32)

    def draw(self, m):
        return (self.next_int() * m) >> 32


def shuffled_rows(n, seed):
    rng = Mulberry32(seed)
    a = list(range(n))
    for i in range(n - 1, 0, -1):
        j = rng.draw(i + 1)
        a[i], a[j] = a[j], a[i]
    return a


# ------------------------------------------------------------------ scaling

def o_scale(X, kind):
    """Returns (Z in Decimal, centre, scale) with the ml.js conventions:
    standard = population SD, minmax = range; none = as given."""
    n, p = len(X), len(X[0])
    if kind == 'none':
        return [[D(v) for v in r] for r in X], None, None
    centre, scale = [], []
    for j in range(p):
        col = [F(r[j]) for r in X]
        if kind == 'standard':
            m = sum(col) / n
            v = sum((c - m) ** 2 for c in col) / n
            centre.append(dec(m))
            scale.append(dec(v).sqrt())
        else:
            lo, hi = min(col), max(col)
            centre.append(dec(lo))
            scale.append(dec(hi - lo))
    Z = [[(D(r[j]) - centre[j]) / scale[j] for j in range(p)] for r in X]
    return Z, centre, scale


def sq(a, b):
    return sum((x - y) * (x - y) for x, y in zip(a, b))


# ------------------------------------------------------------------ PCA

def inertia_below(S, x):
    """Number of eigenvalues of symmetric S below x: negative pivots of the
    LDL' factorisation of S - xI (Sylvester's law of inertia)."""
    p = len(S)
    A = [[S[i][j] - (x if i == j else 0) for j in range(p)] for i in range(p)]
    neg = 0
    for k in range(p):
        d = A[k][k]
        if d == 0:
            d = D('1e-55')
        if d < 0:
            neg += 1
        for i in range(k + 1, p):
            f = A[i][k] / d
            for j in range(k + 1, p):
                A[i][j] -= f * A[k][j]
    return neg


def solve(A, b):
    n = len(A)
    M = [list(A[i]) + [b[i]] for i in range(n)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        pv = M[c][c]
        if pv == 0:
            pv = D('1e-55')
        for r in range(c + 1, n):
            f = M[r][c] / pv
            for k in range(c, n + 1):
                M[r][k] -= f * M[c][k]
    x = [D(0)] * n
    for i in range(n - 1, -1, -1):
        s = M[i][n] - sum(M[i][k] * x[k] for k in range(i + 1, n))
        x[i] = s / (M[i][i] if M[i][i] != 0 else D('1e-55'))
    return x


def eigen_bisect(S):
    p = len(S)
    r = sum(abs(v) for row in S for v in row) + 1
    vals = []
    for k in range(p):  # k-th smallest: the x with exactly k eigenvalues below it
        lo, hi = -r, r
        for _ in range(230):
            mid = (lo + hi) / 2
            if inertia_below(S, mid) <= k:
                lo = mid
            else:
                hi = mid
        vals.append((lo + hi) / 2)
    vals.sort(reverse=True)
    vecs = []
    for lam in vals:
        shift = lam + D('1e-40')
        A = [[S[i][j] - (shift if i == j else 0) for j in range(p)] for i in range(p)]
        v = [D(1) / D(p).sqrt() + D(i) / 1000 for i in range(p)]
        for _ in range(4):
            v = solve(A, v)
            nrm = sum(t * t for t in v).sqrt()
            v = [t / nrm for t in v]
        vecs.append(v)
    return vals, vecs


def o_pca(X, names=None, matrix='correlation', q=None):
    n, p = len(X), len(X[0])
    q = p if q is None else q
    cols = [[F(r[j]) for r in X] for j in range(p)]
    centre = [sum(c) / n for c in cols]
    if matrix == 'correlation':
        scale = [dec(sum((v - centre[j]) ** 2 for v in cols[j]) / (n - 1)).sqrt() for j in range(p)]
    else:
        scale = [D(1)] * p
    Z = [[(D(r[j]) - dec(centre[j])) / scale[j] for j in range(p)] for r in X]
    S = [[sum(Z[i][a] * Z[i][b] for i in range(n)) / (n - 1) for b in range(p)] for a in range(p)]
    vals, vecs = eigen_bisect(S)
    vals = [v if v > 0 else D(0) for v in vals]
    for k in range(p - 1):
        if vals[k] > 0 and abs(vals[k] - vals[k + 1]) < D('1e-6') * vals[0]:
            raise Ambiguous('pca: close eigenvalues, directions ill-determined')
    comps = []
    for v in vecs:
        mx = max(abs(t) for t in v)
        lead = next(j for j in range(p) if abs(v[j]) >= mx * (1 - SIGN_TIE))
        for j in range(p):
            g = abs(abs(v[j]) - mx * (1 - SIGN_TIE)) / mx
            if g < D('1e-7') and abs(abs(v[j]) - mx) > EXACT:
                raise Ambiguous('pca: sign rule band')
        comps.append([-t for t in v] if v[lead] < 0 else v)
    total = sum(vals)
    ratio = [v / total for v in vals]
    cum, c = [], D(0)
    for r in ratio:
        c += r
        cum.append(c)
    scores = [[sum(z[j] * comps[k][j] for j in range(p)) for k in range(q)] for z in Z]
    return {
        'matrix': matrix, 'n': n, 'p': p, 'nComponents': q,
        'names': names or [f'x{j + 1}' for j in range(p)],
        'centre': [fl(c) for c in centre], 'scale': [fl(s) for s in scale],
        'covarianceMatrix': [[fl(v) for v in r] for r in S],
        'eigenvalues': [fl(v) for v in vals],
        'explainedVariance': [fl(v) for v in vals[:q]],
        'explainedVarianceRatio': [fl(v) for v in ratio[:q]],
        'cumulativeRatio': [fl(v) for v in cum[:q]],
        'totalVariance': fl(total),
        'components': [[fl(t) for t in v] for v in comps[:q]],
        'loadings': [[fl(t * vals[k].sqrt()) for t in comps[k]] for k in range(q)],
        'scores': [[fl(s) for s in r] for r in scores],
        'converged': True,
        'repeatedEigenvalues': [],
    }, (centre, scale, comps[:q], matrix)


def o_pca_transform(model, Xnew):
    centre, scale, comps, _ = model
    p = len(centre)
    return {'scores': [[fl(sum((D(r[j]) - dec(centre[j])) / scale[j] * c[j] for j in range(p))) for c in comps] for r in Xnew]}


# ------------------------------------------------------------------ k-means

BAND_IN = D('1e-13')   # surely inside the engine's 1e-12 tie band


def band_pick(ds, cands):
    """The engine's banded minimum: among cands, those within 1e-12 of the
    smallest are tied and the lowest index wins. Refuses (Ambiguous) when a
    candidate sits between 1e-13 and 1e-9 of the smallest, where float
    rounding could move it across the band edge."""
    m = min(ds[c] for c in cands)
    tied = []
    for c in cands:
        g = ds[c] - m
        if g <= BAND_IN * m:
            tied.append(c)
        elif g < AMBIG * m:
            raise Ambiguous('a distance near the edge of the 1e-12 tie band')
    return min(tied)


def nearest(z, C, allow_ties=True):
    ds = [sq(z, c) for c in C]
    b = band_pick(ds, range(len(C)))
    return b, ds[b]


def o_kmeanspp(Z, k, rng):
    n = len(Z)
    picks = [rng.draw(n)]
    D2 = [sq(z, Z[picks[0]]) for z in Z]
    for _ in range(1, k):
        total = sum(D2)
        target = dec(rng.u()) * total
        cum = D(0)
        pick = None
        for i in range(n):
            cum += D2[i]
            if abs(cum - target) < AMBIG * total and D2[i] > 0:
                raise Ambiguous('kmeans++: draw near a boundary')
            if pick is None and cum > target:
                pick = i
        picks.append(pick)
        D2 = [min(D2[i], sq(Z[i], Z[pick])) for i in range(n)]
    return picks


def o_lloyd(Z, C, max_iter, allow_ties):
    n, k, p = len(Z), len(C), len(Z[0])
    prev = None
    it = 0
    trace = []
    relocations = 0
    while it < max_iter:
        it += 1
        res = [nearest(z, C, allow_ties) for z in Z]
        labels = [r[0] for r in res]
        d2 = [r[1] for r in res]
        changed = n if prev is None else sum(1 for a, b in zip(labels, prev) if a != b)
        trace.append({'pass': it, 'inertia': sum(d2), 'changed': changed})
        if prev is not None and changed == 0:
            return C, labels, d2, it, True, trace, relocations
        members = [[i for i in range(n) if labels[i] == c] for c in range(k)]
        empties = [c for c in range(k) if not members[c]]
        if empties:
            order = sorted(range(n), key=lambda i: (-d2[i], i))
            q = 0
            for e in empties:
                while q < n and len(members[labels[order[q]]]) < 2:
                    q += 1
                r = order[q]
                q += 1
                members[labels[r]].remove(r)
                members[e] = [r]
                relocations += 1
        C = [[sum(Z[i][j] for i in members[c]) / len(members[c]) for j in range(p)] if members[c] else C[c] for c in range(k)]
        prev = labels
    res = [nearest(z, C, allow_ties) for z in Z]
    return C, [r[0] for r in res], [r[1] for r in res], it, False, trace, relocations


def o_kmeans(X, k, seed=None, n_init=10, max_iter=300, init=None, scale='standard', names=None, allow_ties=False):
    Z, centre, sc = o_scale(X, scale)
    p = len(X[0])
    starts = []
    if init is not None:
        starts.append(([[(D(v) - centre[j]) / sc[j] for j, v in enumerate(r)] if centre else [D(v) for v in r] for r in init], None))
    else:
        rng = Mulberry32(seed)
        for _ in range(n_init):
            picks = o_kmeanspp(Z, k, rng)
            starts.append(([list(Z[i]) for i in picks], picks))
    runs, best, best_run = [], None, -1
    for r, (C0, picks) in enumerate(starts):
        C, labels, d2, it, conv, trace, rel = o_lloyd(Z, C0, max_iter, allow_ties)
        inertia = sum(d2)
        runs.append({'run': r, 'inertia': fl(inertia), 'iterations': it, 'converged': conv, 'initialRows': picks})
        if best is not None and BAND_IN * best[0] < abs(inertia - best[0]) < AMBIG * best[0]:
            raise Ambiguous('kmeans: two runs near the edge of the 1e-12 inertia band')
        if best is None or inertia < best[0] - BAND_IN * best[0]:
            best = (inertia, C, labels, it, conv, trace, rel, C0, picks)
            best_run = r
    inertia, C, labels, it, conv, trace, rel, C0, picks = best
    out = {
        'k': k, 'n': len(X), 'p': p, 'labels': labels, 'sizes': [labels.count(c) for c in range(k)],
        'centres': [[fl(v) for v in c] for c in C],
        'centresOriginal': [[fl(v * sc[j] + centre[j]) if centre else fl(v) for j, v in enumerate(c)] for c in C],
        'inertia': fl(inertia), 'iterations': it, 'converged': conv, 'emptyClusterRelocations': rel,
        'trace': [{'pass': t['pass'], 'inertia': fl(t['inertia']), 'changed': t['changed']} for t in trace],
        'initialCentres': [[fl(v) for v in c] for c in C0], 'initialRows': picks, 'bestRun': best_run, 'runs': runs,
        'scale': scale,
    }
    if names:
        out['names'] = names
    if centre:
        out['scaler'] = {'centre': [fl(c) for c in centre], 'scale': [fl(s) for s in sc]}
    return out, (C, centre, sc)


def o_assign(model, Xnew):
    C, centre, sc = model
    Z = [[(D(v) - centre[j]) / sc[j] for j, v in enumerate(r)] if centre else [D(v) for v in r] for r in Xnew]
    res = [nearest(z, C, False) for z in Z]
    return {'labels': [r[0] for r in res], 'distances': [fl(r[1].sqrt()) for r in res]}


# ------------------------------------------------------------------ silhouette

def label_sort(v):
    return sorted(set(v))


def o_silhouette(X, labels, scale='standard', sample=None, seed=None):
    Z, _, _ = o_scale(X, scale)
    rows = None
    if sample is not None:
        rows = sorted(shuffled_rows(len(X), seed)[:sample])
        Z = [Z[i] for i in rows]
        labels = [labels[i] for i in rows]
    n = len(Z)
    cls = label_sort(labels)
    dist = [[sq(Z[i], Z[j]).sqrt() for j in range(n)] for i in range(n)]
    s = []
    for i in range(n):
        own = [j for j in range(n) if labels[j] == labels[i] and j != i]
        if not own:
            s.append(D(0))
            continue
        a = sum(dist[i][j] for j in own) / len(own)
        b = min(sum(dist[i][j] for j in range(n) if labels[j] == c) / labels.count(c) for c in cls if c != labels[i])
        m = max(a, b)
        s.append(D(0) if m == 0 else (b - a) / m)
    return {
        'mean': fl(sum(s) / n), 'values': [fl(v) for v in s], 'labels': cls, 'rows': rows, 'n': n,
        'perCluster': [{'label': c, 'size': labels.count(c), 'mean': fl(sum(s[i] for i in range(n) if labels[i] == c) / labels.count(c))} for c in cls],
    }


# ------------------------------------------------------------------ agglomerative

def o_agglomerative(X, linkage, k=None, scale='standard', allow_ties=False):
    Z, _, _ = o_scale(X, scale)
    n = len(Z)
    pd2 = [[sq(Z[i], Z[j]) for j in range(n)] for i in range(n)]
    pdist = [[v.sqrt() for v in row] for row in pd2]
    clusters = {i: [i] for i in range(n)}
    cent = {i: Z[i] for i in range(n)}

    def height(a, b):
        A, B = clusters[a], clusters[b]
        if linkage == 'complete':
            return max(pd2[i][j] for i in A for j in B).sqrt()
        if linkage == 'average':
            return sum(pdist[i][j] for i in A for j in B) / (len(A) * len(B))
        na, nb = len(A), len(B)
        return (2 * D(na * nb) / D(na + nb) * sq(cent[a], cent[b])).sqrt()

    H = {}
    ids = list(range(n))
    for a, b in itertools.combinations(ids, 2):
        H[(a, b)] = height(a, b)
    Zl = []
    tied_steps = 0
    for step in range(n - 1):
        m = min(H.values())
        tied = []
        for pair, h in H.items():
            g = h - m
            # the engine ties heights within 1e-12 (relative) of the smallest;
            # float heights carry about 1e-15 relative error, so a gap at or
            # below 1e-13 is surely inside that band, above 1e-9 surely outside
            if g <= D('1e-13') * m or (m == 0 and h == 0):
                tied.append(pair)
            elif g < AMBIG * m:
                raise Ambiguous('agglomerative: a merge height near the edge of the tie band')
        if len(tied) > 1:
            tied_steps += 1
            if not allow_ties:
                raise Ambiguous('agglomerative: tied merges (not declared)')
        a, b = min(tied)
        new = n + step
        A, B = clusters.pop(a), clusters.pop(b)
        ca, cb = cent.pop(a), cent.pop(b)
        clusters[new] = A + B
        cent[new] = [(len(A) * x + len(B) * y) / (len(A) + len(B)) for x, y in zip(ca, cb)]
        Zl.append([a, b, H[(a, b)], len(A) + len(B)])
        H = {pr: h for pr, h in H.items() if a not in pr and b not in pr}
        for t in clusters:
            if t != new:
                H[(t, new)] = height(t, new)
    out = {'linkage': linkage, 'n': n, 'scale': scale,
           'linkageMatrix': [[r[0], r[1], fl(r[2]), r[3]] for r in Zl], 'heights': [fl(r[2]) for r in Zl],
           'tiedSteps': tied_steps}
    if k is not None:
        out['k'] = k
        out['labels'] = o_cut(Zl, n, k)
        out['cutHeights'] = {'below': fl(Zl[n - k - 1][2]) if k < n else 0, 'above': fl(Zl[n - k][2]) if k > 1 else None}
    return out, Zl


def o_cut(Zl, n, k):
    member = {i: {i} for i in range(n)}
    for s in range(n - k):
        a, b = Zl[s][0], Zl[s][1]
        member[n + s] = member.pop(a) | member.pop(b)
    first = sorted(member.values(), key=min)
    lab = [0] * n
    for c, m in enumerate(first):
        for i in m:
            lab[i] = c
    return lab


# ------------------------------------------------------------------ kNN

def o_knn(X, y, Xnew, k, scale='standard'):
    Z, centre, sc = o_scale(X, scale)
    Zn = [[(D(v) - centre[j]) / sc[j] for j, v in enumerate(r)] if centre else [D(v) for v in r] for r in Xnew]
    cls = label_sort(y)
    preds, neigh, dists, votes, tied = [], [], [], [], 0
    for z in Zn:
        dd = [sq(z, Z[i]) for i in range(len(Z))]
        remaining = list(range(len(Z)))
        top = []
        for _ in range(k):
            pick = band_pick(dd, remaining)
            remaining.remove(pick)
            top.append((dd[pick], pick))
        cnt, first = {}, {}
        for q, (_, i) in enumerate(top):
            cnt[y[i]] = cnt.get(y[i], 0) + 1
            first.setdefault(y[i], q)
        mx = max(cnt.values())
        win = min((lab for lab in cnt if cnt[lab] == mx), key=lambda lab: first[lab])
        if sum(1 for lab in cnt if cnt[lab] == mx) > 1:
            tied += 1
        preds.append(win)
        neigh.append([i for _, i in top])
        dists.append([fl(d.sqrt()) for d, _ in top])
        votes.append([{'label': c, 'count': cnt[c]} for c in cls if c in cnt])
    return {'k': k, 'predictions': preds, 'neighbours': neigh, 'distances': dists, 'votes': votes, 'tiedVotes': tied, 'classes': cls}


# ------------------------------------------------------------------ CART

def gini(counts, n):
    return 1 - sum(F(c * c, n * n) for c in counts)


def o_cart(X, y, names=None, max_depth=5, msl=1, mss=2):
    n, p = len(X), len(X[0])
    names = names or [f'x{j + 1}' for j in range(p)]
    cls = label_sort(y)
    nodes = []
    imp = [F(0)] * p

    def counts_of(rows):
        return [sum(1 for i in rows if y[i] == c) for c in cls]

    def build(rows, depth):
        m = len(rows)
        cnt = counts_of(rows)
        mx = max(cnt)
        node = {'id': len(nodes), 'depth': depth, 'n': m, 'counts': cnt, 'gini': gini(cnt, m),
                'prediction': cls[cnt.index(mx)], 'leaf': True}
        nodes.append(node)
        if sum(1 for c in cnt if c) == 1 or depth >= max_depth or m < mss or m < 2 * msl:
            return node['id']
        best = None
        for f in range(p):
            vals = sorted(set(X[i][f] for i in rows))
            for a, b in zip(vals, vals[1:]):
                left = [i for i in rows if X[i][f] <= a]
                right = [i for i in rows if X[i][f] > a]
                if len(left) < msl or len(right) < msl:
                    continue
                w = F(len(left), m) * gini(counts_of(left), len(left)) + F(len(right), m) * gini(counts_of(right), len(right))
                if best is None or w < best[0]:
                    t = a / 2 + b / 2
                    if t == b or math.isinf(t):
                        t = a
                    best = (w, f, t, left, right)
        if best is None or not (best[0] < node['gini']):
            return node['id']
        w, f, t, left, right = best
        node.update({'leaf': False, 'featureIndex': f, 'feature': names[f], 'threshold': t})
        node['left'] = build(left, depth + 1)
        node['right'] = build(right, depth + 1)
        L, R = nodes[node['left']], nodes[node['right']]
        dec_ = m * node['gini'] - L['n'] * L['gini'] - R['n'] * R['gini']
        node['impurityDecrease'] = dec_ / n
        imp[f] += dec_
        return node['id']

    build(list(range(n)), 0)
    tot = sum(imp)
    out_nodes = []
    for nd in nodes:
        o = {k: (fl(v) if isinstance(v, F) else v) for k, v in nd.items()}
        out_nodes.append(o)

    def pred(r):
        nd = nodes[0]
        while not nd['leaf']:
            nd = nodes[nd['left'] if r[nd['featureIndex']] <= nd['threshold'] else nd['right']]
        return nd

    train = [pred(r)['prediction'] for r in X]
    lines = []

    def show(i, level):
        nd = nodes[i]
        pre = '|   ' * level + '|--- '
        if nd['leaf']:
            lines.append(f"{pre}class: {nd['prediction']} (n = {nd['n']}, counts {'/'.join(str(c) for c in nd['counts'])})")
            return
        lines.append(f"{pre}{nd['feature']} <= {js_num(nd['threshold'])}")
        show(nd['left'], level + 1)
        lines.append(f"{pre}{nd['feature']} >  {js_num(nd['threshold'])}")
        show(nd['right'], level + 1)

    show(0, 0)
    res = {'classes': cls, 'names': names, 'p': p, 'nodes': out_nodes, 'nNodes': len(nodes),
           'nLeaves': sum(1 for d in nodes if d['leaf']), 'depth': max(d['depth'] for d in nodes),
           'featureImportances': [fl(v / tot) if tot > 0 else 0.0 for v in imp],
           'trainingPredictions': train, 'trainingAccuracy': fl(F(sum(1 for a, b in zip(train, y) if a == b), n)),
           'printed': '\n'.join(lines)}
    return res, pred


# ------------------------------------------------------------------ ARI and matching

def o_ari(a, b):
    n = len(a)
    same_both = same_a = same_b = 0
    for i in range(n):
        for j in range(i + 1, n):
            sa, sb = a[i] == a[j], b[i] == b[j]
            same_a += sa
            same_b += sb
            same_both += sa and sb
    N = F(n * (n - 1), 2)
    expected = F(same_a * same_b) / N
    mx = F(same_a + same_b, 2)
    if mx == expected:
        return F(1)
    return (same_both - expected) / (mx - expected)


def o_contingency(a, b):
    ra, rb = label_sort(a), label_sort(b)
    return ra, rb, [[sum(1 for x, y in zip(a, b) if x == r and y == c) for c in rb] for r in ra]


def o_report(yt, yp, labels, zd=0):
    per, undefined = [], []
    for c in labels:
        tp = sum(1 for a, b in zip(yt, yp) if a == c and b == c)
        fp = sum(1 for a, b in zip(yt, yp) if a != c and b == c)
        fn = sum(1 for a, b in zip(yt, yp) if a == c and b != c)

        def ratio(num, den, what):
            if den == 0:
                undefined.append({'label': c, 'metric': what})
                return F(zd)
            return F(num, den)
        per.append({'label': c, 'tp': tp, 'fp': fp, 'fn': fn, 'support': tp + fn,
                    'precision': ratio(tp, tp + fp, 'precision'), 'recall': ratio(tp, tp + fn, 'recall'),
                    'f1': ratio(2 * tp, 2 * tp + fp + fn, 'f1')})

    def avg(key, w):
        ws = sum(w(r) for r in per)
        return F(zd) if ws == 0 else sum(w(r) * r[key] for r in per) / ws
    return {'labels': labels, 'accuracy': fl(F(sum(1 for a, b in zip(yt, yp) if a == b), len(yt))),
            'matrix': [[sum(1 for a, b in zip(yt, yp) if a == r and b == c) for c in labels] for r in labels],
            'perClass': [{k: (fl(v) if isinstance(v, F) else v) for k, v in r.items()} for r in per],
            'macro': {k: fl(avg(k, lambda r: 1)) for k in ('precision', 'recall', 'f1')},
            'weighted': {k: fl(avg(k, lambda r: r['support'])) for k in ('precision', 'recall', 'f1')},
            'undefinedRatios': undefined}


def o_match(yt, cl, mode='one-to-one', zd=0):
    rc, rf, M = o_contingency(cl, yt)
    nc, nf = len(rc), len(rf)
    if mode == 'one-to-one':
        best, arg = -1, None
        for perm in itertools.permutations(range(nf), nc):  # lexicographic
            s = sum(M[c][perm[c]] for c in range(nc))
            if s > best:
                best, arg = s, perm
        mapping, matched = list(arg), best
    else:
        mapping = [max(range(nf), key=lambda f: (M[c][f], -f)) for c in range(nc)]
        matched = sum(M[c][mapping[c]] for c in range(nc))
    mp = {rc[i]: rf[mapping[i]] for i in range(nc)}
    yp = [mp[c] for c in cl]
    return {'mode': mode,
            'mapping': [{'cluster': rc[i], 'facies': rf[mapping[i]], 'rows': M[i][mapping[i]], 'clusterSize': sum(M[i])} for i in range(nc)],
            'matchedRows': matched, 'contingency': M, 'clusterLabels': rc, 'faciesLabels': rf, 'yPred': yp,
            'report': o_report(yt, yp, rf, zd), 'ari': fl(o_ari(cl, yt))}


# ------------------------------------------------------------------ data

def read_iris():
    rows = open(IRIS).read().strip().split('\n')
    head = rows[0].split(',')
    species = head[2:5]
    X, y = [], []
    for r in rows[1:]:
        v = r.split(',')
        X.append([float(t) for t in v[:4]])
        y.append(species[int(v[4])])
    assert len(X) == 150 and species == ['setosa', 'versicolor', 'virginica']
    # Fisher's values for samples 35 and 38 (the UCI copy differs)
    assert X[34] == [4.9, 3.1, 1.5, 0.2] and X[37] == [4.9, 3.6, 1.4, 0.1]
    return X, y


IRIS_NAMES = ['sepal_length', 'sepal_width', 'petal_length', 'petal_width']
LOG_NAMES = ['GR', 'RHOB', 'NPHI', 'PEF']
FACIES = {
    # facies: (GR mean, sd), (RHOB), (NPHI), (PEF)
    'sandstone': ((45, 9), (2.33, 0.04), (0.20, 0.025), (1.9, 0.2)),
    'shaly_sand': ((78, 10), (2.42, 0.04), (0.25, 0.03), (2.6, 0.25)),
    'shale': ((118, 12), (2.52, 0.04), (0.33, 0.03), (3.2, 0.25)),
    'limestone': ((28, 7), (2.64, 0.035), (0.07, 0.02), (4.9, 0.3)),
}
WELLS = [f'EKENE-{k}' for k in range(1, 7)]


def ekene_facies(seed=3303, per_well=30):
    """Ekene synthetic facies logs: a blocky facies sequence per well (a
    Markov chain that stays with probability 0.8) and four logs drawn from
    per-facies normal distributions, rounded as logged."""
    rng = random.Random(seed)
    names = list(FACIES)
    X, y, g = [], [], []
    for w in WELLS:
        f = rng.choice(names)
        for _ in range(per_well):
            if rng.random() > 0.8:
                f = rng.choice(names)
            (gm, gs), (rm, rs), (nm, ns), (pm, ps) = FACIES[f]
            X.append([round(rng.gauss(gm, gs), 1), round(rng.gauss(rm, rs), 3), round(rng.gauss(nm, ns), 3), round(rng.gauss(pm, ps), 2)])
            y.append(f)
            g.append(w)
    return X, y, g


# ------------------------------------------------------------------ cases

class Cases:
    def __init__(self):
        self.cases = []

    def add(self, cid, fn, args, expected, tol=TOL, note=None, abs_floor=None, source='oracle', published=None):
        assert cid not in {c['id'] for c in self.cases}, cid
        c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected, 'tol': tol, 'source': source}
        if abs_floor is not None:
            c['abs'] = abs_floor
        if note:
            c['note'] = note
        if published:
            c['published'] = published
        self.cases.append(c)

    def refuse(self, cid, fn, args, field, message, note=None):
        self.add(cid, fn, args, {'error': True, 'field': field, 'message': message}, note=note)


def drop(d, *keys):
    return {k: v for k, v in d.items() if k not in keys}


def build():
    c = Cases()
    IX, Iy = read_iris()
    EX, Ey, Eg = ekene_facies()

    # ---------------- PCA
    cov, _ = o_pca(IX, IRIS_NAMES, 'covariance')
    pub = [round(v, 8) for v in cov['explainedVarianceRatio'][:2]]
    assert pub == [0.92461872, 0.05306648], pub
    c.add('pca-iris-covariance', 'pca', {'X': IX, 'names': IRIS_NAMES, 'matrix': 'covariance'}, drop(cov, 'scores'), source='published',
          published=[{'field': 'explainedVarianceRatio.0', 'value': 0.92461872, 'digits': 8}, {'field': 'explainedVarianceRatio.1', 'value': 0.05306648, 'digits': 8}],
          note='scikit-learn example plot_pca_vs_lda prints explained variance ratio (first two components): [0.92461872 0.05306648]')
    c.add('pca-iris-covariance-scores', 'pca', {'X': IX, 'names': IRIS_NAMES, 'matrix': 'covariance', 'nComponents': 2},
          {'scores': cov['scores'][:0] or [r[:2] for r in cov['scores']], 'nComponents': 2, 'explainedVarianceRatio': cov['explainedVarianceRatio'][:2]}, abs_floor=1e-11)
    cor, cor_model = o_pca(IX, IRIS_NAMES, 'correlation')
    c.add('pca-iris-correlation', 'pca', {'X': IX, 'names': IRIS_NAMES}, cor, abs_floor=1e-11)
    ecor, ecor_model = o_pca(EX, LOG_NAMES, 'correlation', 3)
    c.add('pca-ekene-correlation-3', 'pca', {'X': EX, 'names': LOG_NAMES, 'nComponents': 3}, ecor, abs_floor=1e-11)
    ecov, _ = o_pca(EX, LOG_NAMES, 'covariance')
    c.add('pca-ekene-covariance', 'pca', {'X': EX, 'names': LOG_NAMES, 'matrix': 'covariance'}, drop(ecov, 'scores'), abs_floor=1e-11,
          note='covariance PCA on raw logs: GR (API units) takes almost all the variance, the reason the default is correlation')
    two = [[1.0, 2.0], [2.0, 3.5], [3.0, 3.0], [4.0, 6.5], [5.0, 5.0]]
    t2, _ = o_pca(two, None, 'correlation')
    c.add('pca-two-features-sign-tie', 'pca', {'X': two}, t2, abs_floor=1e-12,
          note='two standardised features: the loadings of each component tie in absolute value (1/sqrt 2), so the first is made positive')
    c.add('pca-transform-ekene', 'pcaTransform', {'model': {'__fit__': 'pca', 'args': {'X': EX, 'names': LOG_NAMES, 'nComponents': 3}}, 'X': EX[:5]},
          o_pca_transform(ecor_model, EX[:5]), abs_floor=1e-11)
    c.refuse('pca-one-row', 'pca', {'X': [[1, 2]]}, 'X', 'X must be an array of at least 2 rows')
    c.refuse('pca-ncomp-5-of-4', 'pca', {'X': IX, 'nComponents': 5}, 'nComponents', 'nComponents must be a whole number from 1 to 4 (the number of features)')
    c.refuse('pca-ncomp-0', 'pca', {'X': IX, 'nComponents': 0}, 'nComponents', 'nComponents must be a whole number from 1 to 4 (the number of features)')
    c.refuse('pca-matrix-bad', 'pca', {'X': IX, 'matrix': 'kernel'}, 'matrix', "matrix must be 'correlation' or 'covariance'")
    c.refuse('pca-constant-feature-correlation', 'pca', {'X': [[1, 5], [2, 5], [3, 5]], 'names': ['GR', 'CAL']}, 'X.CAL',
             'X.CAL has zero variance on the 3 training rows (every value is 5): standardising would divide by zero, so drop the feature or fit on rows where it varies')
    c.refuse('pca-all-constant-covariance', 'pca', {'X': [[1, 5], [1, 5], [1, 5]], 'matrix': 'covariance'}, 'X',
             'X has zero total variance (every column is constant), so there are no principal components')
    c.refuse('pca-missing-value', 'pca', {'X': [[1, 2], [None, 3], [2, 2]]}, 'X[1][0]', 'X[1][0] must be a finite number: fill or drop missing values first')
    c.refuse('pca-names-repeat', 'pca', {'X': [[1, 2], [2, 1], [3, 3]], 'matrix': 'covariance', 'names': ['GR', 'GR']}, 'names[1]', 'names[1] repeats the name GR')
    c.refuse('pca-transform-bad-model', 'pcaTransform', {'model': {'kind': 'kmeans'}, 'X': [[1]]}, 'model', 'model must be the result of pca')
    c.refuse('pca-transform-columns', 'pcaTransform', {'model': {'__fit__': 'pca', 'args': {'X': EX, 'names': LOG_NAMES}}, 'X': [[1, 2, 3]]}, 'X', 'X must have 4 columns, as the PCA was fitted on')

    # ---------------- k-means
    ki, kmodel = o_kmeans(IX, 3, seed=3, n_init=10, scale='none')
    c.add('kmeans-iris-k3-none-seed3', 'kmeans', {'X': IX, 'k': 3, 'seed': 3, 'scale': 'none'}, ki, note='raw iris (cm): the classic inertia 78.851')
    for seed in (7, 2026):
        r, _ = o_kmeans(IX, 3, seed=seed, n_init=10, scale='standard', names=IRIS_NAMES)
        c.add(f'kmeans-iris-k3-standard-seed{seed}', 'kmeans', {'X': IX, 'k': 3, 'seed': seed, 'names': IRIS_NAMES}, r)
    r, _ = o_kmeans(IX, 4, seed=3, n_init=1, scale='none')
    c.add('kmeans-iris-k4-ninit1', 'kmeans', {'X': IX, 'k': 4, 'seed': 3, 'nInit': 1, 'scale': 'none'}, r)
    ek = {}
    for k in (2, 3, 4, 5):
        r, m = o_kmeans(EX, k, seed=11, n_init=10, scale='standard', names=LOG_NAMES)
        ek[k] = (r, m)
        c.add(f'kmeans-ekene-k{k}', 'kmeans', {'X': EX, 'k': k, 'seed': 11, 'names': LOG_NAMES}, r)
    r, _ = o_kmeans(EX, 4, seed=11, n_init=10, scale='minmax', names=LOG_NAMES)
    c.add('kmeans-ekene-k4-minmax', 'kmeans', {'X': EX, 'k': 4, 'seed': 11, 'names': LOG_NAMES, 'scale': 'minmax'}, r)
    r, _ = o_kmeans(EX, 1, seed=5, n_init=2, scale='standard')
    c.add('kmeans-ekene-k1', 'kmeans', {'X': EX, 'k': 1, 'seed': 5, 'nInit': 2}, r, note='k = 1: the centre is the mean, inertia is n x p for standardised features')
    # a designed empty cluster: the third starting centre is far from every row
    E = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [10.0, 10.0], [11.0, 10.0], [10.0, 11.0], [30.0, 0.0]]
    r, _ = o_kmeans(E, 3, init=[[0.0, 0.0], [10.0, 10.0], [100.0, 100.0]], scale='none')
    assert r['emptyClusterRelocations'] == 1, r
    c.add('kmeans-empty-cluster-relocated', 'kmeans', {'X': E, 'k': 3, 'init': [[0.0, 0.0], [10.0, 10.0], [100.0, 100.0]], 'scale': 'none'}, r,
          note='centre 3 starts far from every row and is empty after the first pass; it takes the row farthest from its centre, (30, 0)')
    # a designed exact tie: row (5, 0) is equidistant from centres (0, 0) and (10, 0)
    T = [[0.0, 0.0], [0.0, 1.0], [10.0, 0.0], [10.0, 1.0], [5.0, 0.0]]
    r, _ = o_kmeans(T, 2, init=[[0.0, 0.0], [10.0, 0.0]], scale='none', max_iter=1, allow_ties=True)
    c.add('kmeans-assignment-tie-lower-centre', 'kmeans', {'X': T, 'k': 2, 'init': [[0.0, 0.0], [10.0, 0.0]], 'scale': 'none', 'maxIter': 1}, r,
          note='row 4 at (5, 0) is exactly equidistant from both starting centres and goes to centre 0 on the first pass')
    r, _ = o_kmeans(EX, 5, seed=11, n_init=1, max_iter=2, scale='standard')
    assert not r['converged']
    c.add('kmeans-maxiter-2', 'kmeans', {'X': EX, 'k': 5, 'seed': 11, 'nInit': 1, 'maxIter': 2}, r)
    c.add('assign-ekene-k4', 'assignClusters', {'model': {'__fit__': 'kmeans', 'args': {'X': EX, 'k': 4, 'seed': 11, 'names': LOG_NAMES}}, 'X': EX[::20]},
          o_assign(ek[4][1], EX[::20]))
    c.refuse('kmeans-k0', 'kmeans', {'X': EX, 'k': 0, 'seed': 1}, 'k', 'k must be a whole number from 1 to 180 (the number of rows)')
    c.refuse('kmeans-k-above-n', 'kmeans', {'X': [[1], [2]], 'k': 3, 'seed': 1}, 'k', 'k must be a whole number from 1 to 2 (the number of rows)')
    c.refuse('kmeans-few-distinct', 'kmeans', {'X': [[1, 1], [1, 1], [2, 2], [2, 2]], 'k': 3, 'seed': 1, 'scale': 'none'}, 'X',
             'X has 2 distinct rows, fewer than k = 3: k-means++ cannot place 3 distinct centres')
    c.refuse('kmeans-few-distinct-scaled', 'kmeans', {'X': [[1, 1], [1, 1], [2, 2], [2, 2]], 'k': 3, 'seed': 1}, 'X',
             'X has 2 distinct rows after scaling, fewer than k = 3: k-means++ cannot place 3 distinct centres')
    c.add('kmeans-distinct-equals-k', 'kmeans', {'X': [[1, 1], [1, 1], [2, 2], [2, 2]], 'k': 2, 'seed': 1, 'scale': 'none'},
          o_kmeans([[1, 1], [1, 1], [2, 2], [2, 2]], 2, seed=1, scale='none')[0], note='boundary: distinct rows = k is fitted')
    c.refuse('kmeans-no-seed', 'kmeans', {'X': EX, 'k': 3}, 'seed', 'seed must be a whole number from 0 to 4294967295')
    c.refuse('kmeans-ninit-with-init', 'kmeans', {'X': T, 'k': 2, 'init': [[0, 0], [10, 0]], 'nInit': 3}, 'nInit', 'nInit must be 1 (or left out) when init gives the starting centres')
    c.refuse('kmeans-init-shape', 'kmeans', {'X': T, 'k': 3, 'init': [[0, 0], [10, 0]], 'scale': 'none'}, 'init', 'init must hold 3 centres of 2 numbers (k rows, one per cluster)')
    c.refuse('kmeans-scale-bad', 'kmeans', {'X': T, 'k': 2, 'seed': 1, 'scale': 'log'}, 'scale', "scale must be 'standard', 'minmax' or 'none'")
    c.refuse('kmeans-ninit-0', 'kmeans', {'X': T, 'k': 2, 'seed': 1, 'nInit': 0}, 'nInit', 'nInit must be a whole number, 1 or more')
    c.refuse('kmeans-maxiter-0', 'kmeans', {'X': T, 'k': 2, 'seed': 1, 'maxIter': 0}, 'maxIter', 'maxIter must be a whole number, 1 or more')
    c.refuse('kmeans-constant-log', 'kmeans', {'X': [[1, 2.3], [2, 2.3], [3, 2.3]], 'k': 2, 'seed': 1, 'names': ['GR', 'RHOB']}, 'X.RHOB',
             'X.RHOB has zero variance on the 3 training rows (every value is 2.3): standardising would divide by zero, so drop the feature or fit on rows where it varies')
    c.refuse('assign-bad-model', 'assignClusters', {'model': {'kind': 'pca'}, 'X': [[1]]}, 'model', 'model must be the result of kmeans')
    c.refuse('assign-columns', 'assignClusters', {'model': {'__fit__': 'kmeans', 'args': {'X': EX, 'k': 2, 'seed': 1}}, 'X': [[1, 2]]}, 'X', 'X must have 4 columns, as the model was fitted on')

    # ---------------- silhouette
    c.add('silhouette-iris-kmeans-none', 'silhouette', {'X': IX, 'labels': ki['labels'], 'scale': 'none'}, o_silhouette(IX, ki['labels'], 'none'))
    c.add('silhouette-iris-species', 'silhouette', {'X': IX, 'labels': Iy}, o_silhouette(IX, Iy, 'standard'))
    c.add('silhouette-ekene-k4', 'silhouette', {'X': EX, 'labels': ek[4][0]['labels']}, o_silhouette(EX, ek[4][0]['labels'], 'standard'))
    c.add('silhouette-ekene-facies', 'silhouette', {'X': EX, 'labels': Ey}, o_silhouette(EX, Ey, 'standard'))
    c.add('silhouette-ekene-sample-60', 'silhouette', {'X': EX, 'labels': Ey, 'sampleSize': 60, 'seed': 9}, o_silhouette(EX, Ey, 'standard', 60, 9))
    S1 = [[0.0], [1.0], [1.5], [9.0]]
    c.add('silhouette-singleton-zero', 'silhouette', {'X': S1, 'labels': [0, 0, 0, 1], 'scale': 'none'}, o_silhouette(S1, [0, 0, 0, 1], 'none'),
          note='row 3 is alone in its cluster and scores 0 (scikit-learn convention)')
    S2 = [[1.0], [1.0], [1.0], [1.0]]
    c.add('silhouette-a-b-zero', 'silhouette', {'X': S2, 'labels': ['a', 'a', 'b', 'b'], 'scale': 'none'}, o_silhouette(S2, ['a', 'a', 'b', 'b'], 'none'),
          note='every row is the same point: a = b = 0 and every row scores 0 (scikit-learn)')
    c.add('silhouette-n-minus-1-clusters', 'silhouette', {'X': S1, 'labels': [0, 1, 2, 2], 'scale': 'none'}, o_silhouette(S1, [0, 1, 2, 2], 'none'), note='boundary: n - 1 clusters is scored')
    c.refuse('silhouette-one-cluster', 'silhouette', {'X': S1, 'labels': [0, 0, 0, 0], 'scale': 'none'}, 'labels',
             'labels must hold from 2 to 3 distinct clusters (found 1): the silhouette compares each row with the next nearest cluster')
    c.refuse('silhouette-n-clusters', 'silhouette', {'X': S1, 'labels': [0, 1, 2, 3], 'scale': 'none'}, 'labels',
             'labels must hold from 2 to 3 distinct clusters (found 4): the silhouette compares each row with the next nearest cluster')
    c.refuse('silhouette-labels-length', 'silhouette', {'X': S1, 'labels': [0, 1]}, 'labels', 'labels must be an array of 4 labels, one per row')
    c.refuse('silhouette-mixed-labels', 'silhouette', {'X': S1, 'labels': [0, 1, 'a', 1]}, 'labels[2]', 'labels[2] must be the same type as labels[0]: all strings or all numbers')
    c.refuse('silhouette-sample-too-big', 'silhouette', {'X': S1, 'labels': [0, 0, 1, 1], 'sampleSize': 5, 'seed': 1}, 'sampleSize', 'sampleSize must be a whole number from 2 to 4')
    c.refuse('silhouette-sample-no-seed', 'silhouette', {'X': S1, 'labels': [0, 0, 1, 1], 'sampleSize': 3}, 'seed', 'seed must be a whole number from 0 to 4294967295')

    # ---------------- elbow
    rows = []
    prev = None
    for k in range(1, 7):
        r = ek[k][0] if k in ek else o_kmeans(EX, k, seed=11, n_init=10, scale='standard')[0]
        row = {'k': k, 'inertia': r['inertia'], 'iterations': r['iterations'], 'converged': r['converged'],
               'drop': None if prev is None else prev - r['inertia'], 'dropFraction': None if prev is None else (prev - r['inertia']) / prev,
               'silhouette': None if k < 2 else o_silhouette(EX, r['labels'], 'standard')['mean']}
        rows.append(row)
        prev = r['inertia']
    best_k = max((r for r in rows if r['silhouette'] is not None), key=lambda r: (r['silhouette'], -r['k']))['k']
    c.add('elbow-ekene-1-6', 'elbow', {'X': EX, 'kMax': 6, 'seed': 11, 'withSilhouette': True}, {'table': rows, 'bestSilhouetteK': best_k, 'inertiaRises': []}, tol=1e-9)
    rows = []
    prev = None
    for k in range(2, 6):
        r = o_kmeans(IX, k, seed=4, n_init=1, scale='none')[0]
        rows.append({'k': k, 'inertia': r['inertia'], 'drop': None if prev is None else prev - r['inertia']})
        prev = r['inertia']
    c.add('elbow-iris-2-5-ninit1', 'elbow', {'X': IX, 'kMin': 2, 'kMax': 5, 'seed': 4, 'nInit': 1, 'scale': 'none'}, {'table': rows, 'bestSilhouetteK': None}, tol=1e-9)
    c.refuse('elbow-kmax-below-kmin', 'elbow', {'X': EX, 'kMin': 4, 'kMax': 3, 'seed': 1}, 'kMax', 'kMax must be a whole number from kMin (4) to 180 (the number of rows)')
    c.refuse('elbow-kmin-0', 'elbow', {'X': EX, 'kMin': 0, 'seed': 1}, 'kMin', 'kMin must be a whole number, 1 or more')
    c.refuse('elbow-silhouette-flag', 'elbow', {'X': EX, 'seed': 1, 'withSilhouette': 'yes'}, 'withSilhouette', 'withSilhouette must be true or false')

    # ---------------- agglomerative
    sub = EX[:90]
    for lk in ('ward', 'complete', 'average'):
        r, Zl = o_agglomerative(sub, lk, 4)
        c.add(f'agglomerative-ekene90-{lk}-k4', 'agglomerative', {'X': sub, 'linkage': lk, 'k': 4}, r, tol=1e-9)
    r, Zl_iris_c = o_agglomerative(IX, 'complete', 3, 'standard', allow_ties=True)
    c.add('agglomerative-iris-complete-k3', 'agglomerative', {'X': IX, 'linkage': 'complete', 'k': 3}, drop(r, 'tiedSteps'), tol=1e-9,
          note='standardised iris; exact duplicate rows give zero-height merges, tied and resolved by the lowest ids')
    r, Zl_iris_w = o_agglomerative(IX, 'ward', 3, 'none', allow_ties=True)
    c.add('agglomerative-iris-ward-none-k3', 'agglomerative', {'X': IX, 'linkage': 'ward', 'k': 3, 'scale': 'none'}, r, tol=1e-9)
    G = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0], [5.0, 0.0], [6.0, 0.0]]
    for lk in ('complete', 'ward', 'average'):
        try:
            r, _ = o_agglomerative(G, lk, 2, 'none', allow_ties=True)
        except Ambiguous:
            continue
        c.add(f'agglomerative-grid-ties-{lk}', 'agglomerative', {'X': G, 'linkage': lk, 'k': 2, 'scale': 'none'}, r, tol=1e-12,
              note='integer grid: several unit-length merges tie at height 1; the lowest ids merge first')
    r, Zg = o_agglomerative(G, 'complete', None, 'none', allow_ties=True)
    for k in (1, 3, 6):
        c.add(f'cut-tree-grid-k{k}', 'cutTree', {'linkageMatrix': r['linkageMatrix'], 'k': k}, {'k': k, 'labels': o_cut(Zg, 6, k)})
    c.refuse('agglomerative-linkage-bad', 'agglomerative', {'X': G, 'linkage': 'single'}, 'linkage', "linkage must be 'ward', 'complete' or 'average'")
    c.refuse('agglomerative-k-above-n', 'agglomerative', {'X': G, 'k': 7}, 'k', 'k must be a whole number from 1 to 6 (the number of rows)')
    c.refuse('agglomerative-one-row', 'agglomerative', {'X': [[1, 2]]}, 'X', 'X must be an array of at least 2 rows')
    c.refuse('cut-tree-k0', 'cutTree', {'linkageMatrix': r['linkageMatrix'], 'k': 0}, 'k', 'k must be a whole number from 1 to 6 (the number of rows)')
    c.refuse('cut-tree-bad-row', 'cutTree', {'linkageMatrix': [[0, 1, 1, 2], [2, 9, 1, 3]], 'k': 1}, 'linkageMatrix[1]',
             'linkageMatrix[1] must be [id1, id2, height, size] with whole ids 0 <= id1 < id2 < 4')
    c.refuse('cut-tree-empty', 'cutTree', {'linkageMatrix': [], 'k': 1}, 'linkageMatrix', 'linkageMatrix must be the non-empty linkageMatrix of agglomerative')

    # ---------------- kNN (train on four wells, classify the other two)
    tr = [i for i, w in enumerate(Eg) if w not in ('EKENE-5', 'EKENE-6')]
    te = [i for i, w in enumerate(Eg) if w in ('EKENE-5', 'EKENE-6')]
    Xtr, ytr, Xte = [EX[i] for i in tr], [Ey[i] for i in tr], [EX[i] for i in te]
    for k in (1, 5, 15):
        c.add(f'knn-ekene-wells-k{k}', 'knnClassify', {'X': Xtr, 'y': ytr, 'Xnew': Xte, 'k': k, 'names': LOG_NAMES}, o_knn(Xtr, ytr, Xte, k))
    itr = [i for i in range(150) if i % 5 != 0]
    ite = [i for i in range(150) if i % 5 == 0]
    c.add('knn-iris-k7', 'knnClassify', {'X': [IX[i] for i in itr], 'y': [Iy[i] for i in itr], 'Xnew': [IX[i] for i in ite], 'k': 7},
          o_knn([IX[i] for i in itr], [Iy[i] for i in itr], [IX[i] for i in ite], 7))
    K = [[0.0], [1.0], [3.0], [4.0], [10.0]]
    Ky = ['b', 'a', 'a', 'b', 'c']
    c.add('knn-vote-tie-nearest-wins', 'knnClassify', {'X': K, 'y': Ky, 'Xnew': [[1.9]], 'k': 4, 'scale': 'none'}, o_knn(K, Ky, [[1.9]], 4, 'none'),
          note='two a and two b among the 4 nearest; the nearest member (row 1, a) decides: a (scikit-learn would pick a too, as it sorts first)')
    c.add('knn-vote-tie-nearest-b', 'knnClassify', {'X': K, 'y': Ky, 'Xnew': [[0.2]], 'k': 4, 'scale': 'none'}, o_knn(K, Ky, [[0.2]], 4, 'none'),
          note='tie 2 to 2 again; the nearest member is row 0 (b), so b wins where scikit-learn picks a')
    Kd = [[0.0], [2.0], [2.0], [5.0]]
    c.add('knn-equidistant-lower-row', 'knnClassify', {'X': [[0.0], [2.0], [4.0], [9.0]], 'y': ['a', 'b', 'c', 'c'], 'Xnew': [[2.0]], 'k': 2, 'scale': 'none'},
          {'predictions': ['b'], 'neighbours': [[1, 0]], 'distances': [[0, 2]], 'tiedVotes': 1},
          note='rows 0 and 2 are both 2 from the new row; the lower row (0) is the second neighbour; the 1 to 1 vote goes to b (nearest)')
    del Kd
    c.refuse('knn-k-above-n', 'knnClassify', {'X': K, 'y': Ky, 'Xnew': [[1]], 'k': 6}, 'k', 'k must be a whole number from 1 to 5 (the training rows)')
    c.refuse('knn-columns', 'knnClassify', {'X': K, 'y': Ky, 'Xnew': [[1, 2]]}, 'Xnew', 'Xnew must have 1 column, like X')
    c.refuse('knn-y-length', 'knnClassify', {'X': K, 'y': ['a'], 'Xnew': [[1]]}, 'y', 'y must be an array of 5 labels, one per row')
    c.refuse('knn-y-null', 'knnClassify', {'X': K, 'y': ['a', None, 'a', 'b', 'c'], 'Xnew': [[1]]}, 'y[1]', 'y[1] must be a string or a finite number')

    # ---------------- CART
    t, pred = o_cart(IX, Iy, IRIS_NAMES, 3)
    c.add('cart-iris-depth3', 'cartFit', {'X': IX, 'y': Iy, 'names': IRIS_NAMES, 'maxDepth': 3}, t, tol=1e-12,
          note='root: petal_length <= 2.45 and petal_width <= 0.8 both isolate setosa exactly (equal decrease); the lower feature index, petal_length, wins')
    t, _ = o_cart(IX, Iy, IRIS_NAMES, 5, msl=5)
    c.add('cart-iris-depth5-leaf5', 'cartFit', {'X': IX, 'y': Iy, 'names': IRIS_NAMES, 'maxDepth': 5, 'minSamplesLeaf': 5}, t, tol=1e-12)
    t, _ = o_cart(IX, Iy, IRIS_NAMES, 0)
    c.add('cart-iris-depth0', 'cartFit', {'X': IX, 'y': Iy, 'names': IRIS_NAMES, 'maxDepth': 0}, t, tol=1e-12, note='maxDepth 0: a single leaf; the three-way tie goes to setosa, which sorts first')
    Xtr_t = [EX[i] for i in tr]
    t, epred = o_cart(Xtr_t, ytr, LOG_NAMES, 4, msl=3)
    c.add('cart-ekene-depth4-leaf3', 'cartFit', {'X': Xtr_t, 'y': ytr, 'names': LOG_NAMES, 'maxDepth': 4, 'minSamplesLeaf': 3}, t, tol=1e-12)
    c.add('cart-predict-ekene-test-wells', 'cartPredict', {'model': {'__fit__': 'cartFit', 'args': {'X': Xtr_t, 'y': ytr, 'names': LOG_NAMES, 'maxDepth': 4, 'minSamplesLeaf': 3}}, 'X': Xte},
          {'predictions': [epred(r)['prediction'] for r in Xte], 'leaves': [epred(r)['id'] for r in Xte]})
    X2 = [r[:2] for r in Xtr_t]
    t, _ = o_cart(X2, ytr, LOG_NAMES[:2], 3, msl=2)
    c.add('cart-ekene-gr-rhob-depth3', 'cartFit', {'X': X2, 'y': ytr, 'names': LOG_NAMES[:2], 'maxDepth': 3, 'minSamplesLeaf': 2}, t, tol=1e-12,
          note='GR and RHOB only: no two splits tie, so scikit-learn grows the same tree')
    t, _ = o_cart(Xtr_t, ytr, LOG_NAMES, 6, mss=40)
    c.add('cart-ekene-min-split-40', 'cartFit', {'X': Xtr_t, 'y': ytr, 'names': LOG_NAMES, 'maxDepth': 6, 'minSamplesSplit': 40}, t, tol=1e-12)
    XOR = [[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0]]
    t, _ = o_cart(XOR, [0, 1, 1, 0], None, 3)
    c.add('cart-xor-no-split', 'cartFit', {'X': XOR, 'y': [0, 1, 1, 0], 'maxDepth': 3}, t, tol=1e-12,
          note='XOR: every single split leaves both children at Gini 0.5, a zero decrease, so the root stays a leaf (scikit-learn splits anyway)')
    c.refuse('cart-maxdepth-negative', 'cartFit', {'X': XOR, 'y': [0, 1, 1, 0], 'maxDepth': -1}, 'maxDepth', 'maxDepth must be a whole number, 0 or more (0 is a single leaf)')
    c.refuse('cart-min-leaf-0', 'cartFit', {'X': XOR, 'y': [0, 1, 1, 0], 'minSamplesLeaf': 0}, 'minSamplesLeaf', 'minSamplesLeaf must be a whole number, 1 or more')
    c.refuse('cart-min-split-1', 'cartFit', {'X': XOR, 'y': [0, 1, 1, 0], 'minSamplesSplit': 1}, 'minSamplesSplit', 'minSamplesSplit must be a whole number, 2 or more')
    c.refuse('cart-y-mixed', 'cartFit', {'X': XOR, 'y': [0, 1, 'a', 0]}, 'y[2]', 'y[2] must be the same type as y[0]: all strings or all numbers')
    c.refuse('cart-names', 'cartFit', {'X': XOR, 'y': [0, 1, 1, 0], 'names': ['a']}, 'names', 'names must be an array of 2 feature names, one per column')
    c.refuse('cart-predict-bad-model', 'cartPredict', {'model': {'kind': 'kmeans'}, 'X': [[1]]}, 'model', 'model must be the result of cartFit')
    c.refuse('cart-predict-columns', 'cartPredict', {'model': {'__fit__': 'cartFit', 'args': {'X': XOR, 'y': [0, 1, 1, 0]}}, 'X': [[1]]}, 'X', 'X must have 2 columns, as the tree was fitted on')

    # ---------------- ARI and matching
    c.add('ari-iris-kmeans', 'adjustedRandIndex', {'a': Iy, 'b': ki['labels']}, {'ari': fl(o_ari(Iy, ki['labels']))}, tol=1e-12)
    c.add('ari-ekene-k4', 'adjustedRandIndex', {'a': Ey, 'b': ek[4][0]['labels']}, {'ari': fl(o_ari(Ey, ek[4][0]['labels']))}, tol=1e-12)
    c.add('ari-identical-relabelled', 'adjustedRandIndex', {'a': [0, 0, 1, 1, 2], 'b': ['x', 'x', 'y', 'y', 'z']}, {'ari': 1.0})
    c.add('ari-both-one-cluster', 'adjustedRandIndex', {'a': [1, 1, 1], 'b': [2, 2, 2]}, {'ari': fl(o_ari([1, 1, 1], [2, 2, 2]))}, note='denominator zero: 1 by convention')
    c.add('ari-both-singletons', 'adjustedRandIndex', {'a': [1, 2, 3], 'b': [3, 2, 1]}, {'ari': fl(o_ari([1, 2, 3], [3, 2, 1]))}, note='denominator zero: 1 by convention')
    c.add('ari-negative', 'adjustedRandIndex', {'a': [0, 0, 1, 1], 'b': [0, 1, 0, 1]}, {'ari': fl(o_ari([0, 0, 1, 1], [0, 1, 0, 1]))}, tol=1e-12, note='worse than chance: negative')
    c.refuse('ari-one-row', 'adjustedRandIndex', {'a': [1], 'b': [1]}, 'a', 'a must be an array of at least 2 labels')
    c.refuse('ari-length', 'adjustedRandIndex', {'a': [1, 2], 'b': [1]}, 'b', 'b must be an array of 2 labels, one per row')
    c.add('match-iris-one-to-one', 'matchClusters', {'yTrue': Iy, 'clusters': ki['labels']}, o_match(Iy, ki['labels']))
    c.add('match-ekene-k4-one-to-one', 'matchClusters', {'yTrue': Ey, 'clusters': ek[4][0]['labels']}, o_match(Ey, ek[4][0]['labels']))
    c.add('match-ekene-k5-majority', 'matchClusters', {'yTrue': Ey, 'clusters': ek[5][0]['labels'], 'mode': 'majority'}, o_match(Ey, ek[5][0]['labels'], 'majority'))
    c.add('match-ekene-k3-one-to-one', 'matchClusters', {'yTrue': Ey, 'clusters': ek[3][0]['labels']}, o_match(Ey, ek[3][0]['labels']),
          note='three clusters for four facies: one facies is never predicted (precision 0 by zeroDivision)')
    yt = ['sand', 'sand', 'shale', 'shale', 'lime', 'lime']
    cl = [0, 0, 1, 1, 2, 2]
    c.add('match-tie-first-mapping', 'matchClusters', {'yTrue': ['a', 'b', 'a', 'b'], 'clusters': [0, 0, 1, 1]}, o_match(['a', 'b', 'a', 'b'], [0, 0, 1, 1]),
          note='both one-to-one mappings match 2 rows; cluster 0 takes the first facies, a')
    c.add('match-tie-majority', 'matchClusters', {'yTrue': ['b', 'a', 'a', 'b'], 'clusters': [0, 0, 0, 0], 'mode': 'majority'},
          o_match(['b', 'a', 'a', 'b'], [0, 0, 0, 0], 'majority'), note='cluster 0 holds two a and two b; the tie goes to a, which sorts first')
    c.add('match-perfect', 'matchClusters', {'yTrue': yt, 'clusters': cl}, o_match(yt, cl))
    c.refuse('match-more-clusters-than-facies', 'matchClusters', {'yTrue': ['a', 'a', 'b', 'b'], 'clusters': [0, 1, 2, 2]}, 'clusters',
             "clusters has 3 clusters, more than the 2 core facies: one-to-one matching would leave clusters unmatched; use mode 'majority' or fewer clusters")
    c.add('match-more-clusters-majority', 'matchClusters', {'yTrue': ['a', 'a', 'b', 'b'], 'clusters': [0, 1, 2, 2], 'mode': 'majority'},
          o_match(['a', 'a', 'b', 'b'], [0, 1, 2, 2], 'majority'))
    c.refuse('match-mode-bad', 'matchClusters', {'yTrue': yt, 'clusters': cl, 'mode': 'best'}, 'mode', "mode must be 'one-to-one' or 'majority'")
    c.refuse('match-length', 'matchClusters', {'yTrue': yt, 'clusters': [0, 1]}, 'clusters', 'clusters must be an array of 6 labels, one per row')
    return c


def main():
    c = build()
    out = {
        'module': 'cluster',
        'generatedBy': 'tools/validation/dataai/oracle_cluster.py',
        'tolerance': {'absoluteFloor': 1e-12, 'note': 'relative tolerance per case in `tol`; `abs` per case overrides the absolute floor'},
        'description': 'Electrofacies: PCA, k-means++ and Lloyd, silhouette, elbow, agglomerative Ward/complete/average with a scipy linkage matrix, kNN, CART (Gini), cluster to facies matching and the adjusted Rand index. Fisher iris is the published anchor; the Ekene synthetic facies logs are ours.',
        'sources': {
            'iris': 'Fisher, R. A. (1936) The use of multiple measurements in taxonomic problems. Annals of Eugenics 7(2):179-188; test-data/dataai/iris/iris.csv is the scikit-learn copy (Fisher values for samples 35 and 38)',
            'pcaPublished': 'scikit-learn example plot_pca_vs_lda: explained variance ratio (first two components): [0.92461872 0.05306648], read 2026-09-24',
        },
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
