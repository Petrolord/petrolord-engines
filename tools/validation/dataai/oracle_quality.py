#!/usr/bin/env python3
"""Independent oracle for engines/dataai/quality.js (Data & AI D1).

STDLIB ONLY. Run with any python 3.10+:

    python3 tools/validation/dataai/oracle_quality.py

It writes test-data/dataai/goldens/quality_cases.json. Nothing here reads
or imports the JavaScript; every value is computed from the published
statement of the method, by a road chosen to differ from the engine's:

  route               oracle road                          engine road
  -----------------   ----------------------------------   -------------------
  mean, SD, median    fractions.Fraction exact sums;       lib/stats (Kahan
                      statistics.stdev/pstdev/median       sum, float)
  quantiles R6/R7/R8  NIST 7.2.6.2 text in exact           float interpolation
                      Fractions, cross-checked against
                      statistics.quantiles (exclusive =
                      R6, inclusive = R7) or the oracle
                      stops
  modified z, MAD     Fraction median of |x - median|      lib/stats median
  Hampel              exact Fraction window statistics     despikeHampel
                      and an exact comparison              (float)
  Mahalanobis         Fraction covariance and exact        float covariance,
                      Gauss-Jordan inverse                 partial-pivot solve
  chi-square cutoff   closed-form survival function        Wilson-Hilferty +
                      (even df: Poisson sum; odd df:       Halley on the
                      erfc + series), bisection            incomplete gamma
  Student t, Grubbs   A&S 26.7.3/26.7.4 closed-form t      continued-fraction
                      CDF for integer df, bisection on t   incomplete beta,
                                                           bisection on w
  incomplete beta     integer a, b: binomial sum in        continued fraction
                      Fractions; b = 1/2: the t closed
                      form; a or b = 1: closed forms
  control charts      Fraction recursions of the NIST      float loops
                      6.3.2.2 / 6.3.2.3 / 6.3.2.4 formulas
  Levenshtein         memoised recursion on the            two-row dynamic
                      definition                           programme
  normalisation       character loop, int() on digit      regular expressions
                      groups

WHAT IT CANNOT CHECK: which conventions to use (sample SD, 0.6745, R7 for
the fences, strict limits, EWMA_0 = target, no CUSUM reset, the digit rule
for near duplicates). Those are choices, written in FINDINGS-quality.md
and applied the same way here. The oracle checks the arithmetic of those
choices, not the choices.

Published values (NIST/SEMATECH e-Handbook worked examples) are carried as
`published` entries with their printed precision and section; the gate
checks the engine reproduces the printed figure. Everything else is
`"source": "oracle"`.
"""
import json
import math
import os
import random
import statistics
import unicodedata
from fractions import Fraction as F
from functools import lru_cache

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, '..', '..', '..', 'test-data', 'dataai', 'goldens', 'quality_cases.json')

TOL_EXACT = 1e-12     # rational arithmetic, float rounding only
TOL_SPECIAL = 1e-10   # special functions (t, beta, chi-square quantiles)

TRUNC = 'G is 2.468765; NIST prints 2.4687, truncated rather than rounded (2.4688). The check allows one unit in the last printed place.'
NIST = 'NIST/SEMATECH e-Handbook of Statistical Methods (itl.nist.gov/div898/handbook), read 2026-09-23'


def fl(x):
    return float(x)


class Cases:
    def __init__(self):
        self.cases = []

    def add(self, cid, fn, args, expected, tol=TOL_EXACT, source='oracle', published=None, note=None):
        assert cid not in {c['id'] for c in self.cases}, cid
        c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected, 'tol': tol, 'source': source}
        if published is not None:
            c['published'] = published
        if note:
            c['note'] = note
        self.cases.append(c)

    def refuse(self, cid, fn, args, field, note=None):
        self.add(cid, fn, args, {'error': True, 'field': field}, note=note)


def missing(v):
    return v is None


def present(values):
    return [(i, v) for i, v in enumerate(values) if not missing(v)]


def fmedian(xs):
    """Exact median of a list of Fractions (or numbers)."""
    s = sorted(F(x) for x in xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def fmean(xs):
    return sum(F(x) for x in xs) / len(xs)


# ---------------------------------------------------------------- completeness

def o_completeness(values):
    n = len(values)
    runs = []
    i = 0
    while i < n:
        if missing(values[i]):
            j = i
            while j + 1 < n and missing(values[j + 1]):
                j += 1
            runs.append({'start': i, 'end': j, 'length': j - i + 1})
            i = j + 1
        else:
            i += 1
    m = sum(r['length'] for r in runs)
    return {
        'n': n, 'missing': m, 'present': n - m,
        'nullFraction': fl(F(m, n)), 'completeness': fl(F(n - m, n)),
        'gapRuns': runs, 'longestGap': max([r['length'] for r in runs], default=0),
        'flags': [{'index': r['start'], 'rule': 'missing-run', 'end': r['end'], 'length': r['length']} for r in runs],
    }


def o_coverage(index, values, start, end, max_step):
    pts = [F(index[i]) for i in range(len(index)) if not missing(values[i])]
    start, end, max_step = F(start), F(end), F(max_step)
    # mark covered sub-intervals, then merge touching ones
    segs = []
    for a, b in zip(pts, pts[1:]):
        if b - a <= max_step:
            lo, hi = max(a, start), min(b, end)
            if hi > lo:
                segs.append([lo, hi])
    merged = []
    for s in segs:
        if merged and merged[-1][1] == s[0]:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    holes = []
    cur = start
    for a, b in merged:
        if a > cur:
            holes.append((cur, a))
        cur = b
    if end > cur:
        holes.append((cur, end))
    cov = sum(b - a for a, b in merged)
    return {
        'coverage': fl(cov / (end - start)), 'coveredLength': fl(cov), 'intervalLength': fl(end - start),
        'covered': [{'from': fl(a), 'to': fl(b)} for a, b in merged],
        'uncovered': [{'from': fl(a), 'to': fl(b)} for a, b in holes],
        'flags': [{'index': None, 'rule': 'coverage-hole', 'from': fl(a), 'to': fl(b)} for a, b in holes],
    }


# ---------------------------------------------------------------- validity

def o_range(values, lo, hi, lo_excl=False, hi_excl=False):
    flags = []
    checked = 0
    for i, v in present(values):
        checked += 1
        below = v <= lo if lo_excl else v < lo
        above = v >= hi if hi_excl else v > hi
        if below:
            flags.append({'index': i, 'rule': 'below-minimum', 'value': v})
        elif above:
            flags.append({'index': i, 'rule': 'above-maximum', 'value': v})
    return {'checked': checked, 'failed': len(flags), 'flags': flags}


def o_index(index, direction='increasing', expected_step=None, step_tol=None):
    sign = 1 if direction == 'increasing' else -1
    flags = []
    first_seen = {}
    last = None
    steps = []
    for i, v in enumerate(index):
        if missing(v):
            flags.append({'index': i, 'rule': 'missing-index'})
            continue
        if v in first_seen:
            flags.append({'index': i, 'rule': 'duplicate-index', 'firstIndex': first_seen[v]})
        else:
            first_seen[v] = i
        if last is not None:
            steps.append((i, F(v) - F(index[last])))
        last = i
    fwd = [abs(s) for _, s in steps if sign * s > 0]
    exp = F(expected_step) if expected_step is not None else fmedian(fwd)
    # the engine's default tolerance is computed in floats: 1e-6 x expected
    tol = F(step_tol) if step_tol is not None else F(1e-6 * fl(exp))
    for i, s in steps:
        if sign * s < 0:
            flags.append({'index': i, 'rule': 'reversal'})
        elif s != 0 and abs(abs(s) - exp) > tol:
            flags.append({'index': i, 'rule': 'irregular-step'})
    flags.sort(key=lambda f: f['index'])  # stable: same-index flags keep order
    cnt = lambda r: sum(1 for f in flags if f['rule'] == r)
    return {
        'expectedStep': fl(exp), 'missing': cnt('missing-index'), 'duplicates': cnt('duplicate-index'),
        'reversals': cnt('reversal'), 'irregularSteps': cnt('irregular-step'),
        'monotonic': cnt('reversal') == 0 and cnt('duplicate-index') == 0,
        'flags': flags,
    }


def o_rate(rates, hours_on=None, status=None):
    flags = []
    checked = 0
    for i, q in present(rates):
        checked += 1
        shut = (status is not None and status[i] == 'shut-in') or (hours_on is not None and hours_on[i] == 0)
        if q < 0:
            flags.append({'index': i, 'rule': 'negative-rate'})
        elif shut and q > 0:
            flags.append({'index': i, 'rule': 'rate-while-shut-in'})
    return {'checked': checked, 'failed': len(flags), 'flags': flags}


# ---------------------------------------------------------------- consistency

def o_cumulative(cum, tol=0):
    flags = []
    prev = None
    for i, v in present(cum):
        if prev is not None and F(cum[prev]) - F(v) > F(tol):
            flags.append({'index': i, 'rule': 'cumulative-decrease', 'drop': fl(F(cum[prev]) - F(v)), 'previousIndex': prev})
        prev = i
    return {'failed': len(flags), 'flags': flags}


def o_watercut(wc=None, oil=None, water=None, tol=1e-6):
    n = len(wc) if wc is not None else len(oil)
    computed = []
    flags = []
    for i in range(n):
        calc = None
        if oil is not None and not missing(oil[i]) and not missing(water[i]) and oil[i] >= 0 and water[i] >= 0 and oil[i] + water[i] > 0:
            calc = F(water[i]) / (F(oil[i]) + F(water[i]))
        computed.append(None if calc is None else fl(calc))
        w = wc[i] if wc is not None else None
        if w is not None and (w < 0 or w > 1):
            flags.append({'index': i, 'rule': 'water-cut-out-of-range'})
        elif w is not None and calc is not None and abs(F(w) - calc) > F(tol):
            flags.append({'index': i, 'rule': 'water-cut-mismatch'})
    return {'computed': computed, 'failed': len(flags), 'flags': flags}


def o_phasesum(parts, total, rel=0.005, abs_=0):
    names = list(parts.keys())
    sums = []
    flags = []
    for i, t in enumerate(total):
        if missing(t) or any(missing(parts[k][i]) for k in names):
            sums.append(None)
            continue
        s = sum(F(parts[k][i]) for k in names)
        sums.append(fl(s))
        allowed = max(F(abs_), F(rel) * abs(F(t)))
        if abs(s - F(t)) > allowed:
            flags.append({'index': i, 'rule': 'phase-sum-mismatch'})
    return {'parts': names, 'sums': sums, 'failed': len(flags), 'flags': flags}


def o_frozen(values, min_run=5, tol=0):
    runs = []
    n = len(values)
    i = 0
    while i < n:
        if missing(values[i]):
            i += 1
            continue
        j = i
        while j + 1 < n and not missing(values[j + 1]) and abs(F(values[j + 1]) - F(values[i])) <= F(tol):
            j += 1
        if j - i + 1 >= min_run:
            runs.append({'start': i, 'end': j, 'length': j - i + 1, 'value': values[i]})
        i = j + 1
    return {'runs': runs, 'flags': [{'index': r['start'], 'rule': 'frozen-run', 'length': r['length']} for r in runs]}


# ---------------------------------------------------------------- uniqueness

def o_levenshtein(a, b):
    @lru_cache(maxsize=None)
    def d(i, j):
        if i == 0:
            return j
        if j == 0:
            return i
        return min(d(i - 1, j) + 1, d(i, j - 1) + 1, d(i - 1, j - 1) + (a[i - 1] != b[j - 1]))
    return d(len(a), len(b))


def o_normalise(s, strip_zeros=True):
    s = unicodedata.normalize('NFKD', s).strip().upper()
    kept = ''.join(ch for ch in s if 'A' <= ch <= 'Z' or '0' <= ch <= '9')
    if not strip_zeros:
        return kept
    out = []
    i = 0
    while i < len(kept):
        if '0' <= kept[i] <= '9':
            j = i
            while j < len(kept) and '0' <= kept[j] <= '9':
                j += 1
            out.append(str(int(kept[i:j])))
            i = j
        else:
            out.append(kept[i])
            i += 1
    return ''.join(out)


def o_duplicates(ids, max_d=1, digits_match=True, strip_zeros=True):
    norm = [o_normalise(s, strip_zeros) for s in ids]
    digits = [''.join(c for c in s if c.isdigit()) for s in norm]
    pairs = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            if ids[i] == ids[j]:
                pairs.append({'i': i, 'j': j, 'kind': 'exact', 'distance': 0})
            elif norm[i] == norm[j]:
                pairs.append({'i': i, 'j': j, 'kind': 'normalised', 'distance': 0})
            elif max_d > 0:
                d = o_levenshtein(norm[i], norm[j])
                if d <= max_d and (not digits_match or digits[i] == digits[j]):
                    pairs.append({'i': i, 'j': j, 'kind': 'near', 'distance': d})
    cnt = lambda k: sum(1 for p in pairs if p['kind'] == k)
    return {'normalised': norm, 'pairs': pairs, 'exact': cnt('exact'), 'normalisedDuplicates': cnt('normalised'), 'near': cnt('near'),
            'flags': [{'index': p['j'], 'rule': 'duplicate-' + p['kind'], 'other': p['i']} for p in pairs]}


# ---------------------------------------------------------------- quantiles

def o_quantile(values, p, method):
    """NIST/SEMATECH 7.2.6.2, exactly as written, in Fractions."""
    y = sorted(F(v) for v in values if not missing(v))
    n = len(y)
    p = F(p)
    if method == 'R6':
        h = p * (n + 1)
    elif method == 'R7':
        h = 1 + p * (n - 1)
    else:
        h = p * (n + F(1, 3)) + F(1, 3)
    k = math.floor(h)
    d = h - k
    if k < 1:
        return y[0]
    if k >= n:
        return y[-1]
    return y[k - 1] + d * (y[k] - y[k - 1])


def check_quartiles(values):
    """Second road for R6 and R7 quartiles: statistics.quantiles."""
    xs = [v for v in values if not missing(v)]
    if len(xs) < 2:
        return
    for method, name in (('exclusive', 'R6'), ('inclusive', 'R7')):
        q = statistics.quantiles([F(v) for v in xs], n=4, method=method)
        mine = [o_quantile(values, F(k, 4), name) for k in (1, 2, 3)]
        # statistics 'exclusive' extrapolates outside the data for tiny n; NIST clamps
        if method == 'exclusive' and (q[0] < min(xs) or q[2] > max(xs)):
            continue
        assert q == mine, ('quartile cross-check failed', name, q, mine)


# ---------------------------------------------------------------- outliers

def o_z(values, threshold=3, sd='sample'):
    pr = present(values)
    xs = [F(v) for _, v in pr]
    n = len(xs)
    m = sum(xs) / n
    ss = sum((x - m) ** 2 for x in xs)
    var = ss / (n - 1) if sd == 'sample' else ss / n
    s = math.sqrt(var)
    # statistics module as the second road for s
    s2 = statistics.stdev([fl(x) for x in xs]) if sd == 'sample' else statistics.pstdev([fl(x) for x in xs])
    assert abs(s - s2) <= 1e-13 * s, ('sd cross-check', s, s2)
    z = [None] * len(values)
    flags = []
    for i, v in pr:
        zi = fl(F(v) - m) / s
        z[i] = zi
        if abs(zi) > threshold:
            flags.append({'index': i, 'rule': 'z-score'})
    bound = (n - 1) / math.sqrt(n)
    return {'n': n, 'mean': fl(m), 'sd': s, 'z': z, 'maxAbsZ': max(abs(v) for v in z if v is not None),
            'maxPossibleAbsZ': bound, 'thresholdReachable': bound > threshold, 'flags': flags}


def o_modz(values, threshold=3.5):
    pr = present(values)
    xs = [F(v) for _, v in pr]
    med = fmedian(xs)
    mad = fmedian([abs(x - med) for x in xs])
    assert fl(med) == statistics.median([fl(x) for x in xs]) or abs(fl(med) - statistics.median([fl(x) for x in xs])) < 1e-12
    scores = [None] * len(values)
    flags = []
    for i, v in pr:
        mz = F('0.6745') * (F(v) - med) / mad
        scores[i] = fl(mz)
        if abs(mz) > F(threshold):
            flags.append({'index': i, 'rule': 'modified-z'})
    return {'n': len(xs), 'median': fl(med), 'mad': fl(mad), 'scores': scores, 'flags': flags}


def o_iqr(values, k=1.5, method='R7'):
    q1 = o_quantile(values, F(1, 4), method)
    q3 = o_quantile(values, F(3, 4), method)
    iqr = q3 - q1
    lo = q1 - F(k) * iqr
    hi = q3 + F(k) * iqr
    flags = []
    for i, v in present(values):
        if F(v) < lo:
            flags.append({'index': i, 'rule': 'below-lower-fence'})
        elif F(v) > hi:
            flags.append({'index': i, 'rule': 'above-upper-fence'})
    return {'q1': fl(q1), 'q3': fl(q3), 'iqr': fl(iqr), 'lower': fl(lo), 'upper': fl(hi), 'flags': flags}


def o_hampel(values, half, nsig=3):
    n = len(values)
    pts = []
    cleaned = list(values)
    flags = []
    for i in range(n):
        if missing(values[i]):
            pts.append({'median': None, 'mad': None, 'judged': False})
            continue
        w = [F(values[j]) for j in range(max(0, i - half), min(n, i + half + 1)) if not missing(values[j])]
        if len(w) < 3:
            pts.append({'median': None, 'mad': None, 'judged': False, 'windowCount': len(w)})
            continue
        med = fmedian(w)
        mad = fmedian([abs(x - med) for x in w])
        thr = F(nsig) * F('1.4826') * mad
        pts.append({'median': fl(med), 'mad': fl(mad), 'threshold': fl(thr), 'judged': True, 'windowCount': len(w)})
        if abs(F(values[i]) - med) > thr:
            cleaned[i] = fl(med)
            flags.append({'index': i, 'rule': 'hampel', 'replacement': fl(med)})
    return {'points': pts, 'cleaned': cleaned, 'flags': flags}


# ---- Student t (closed form for integer df), Grubbs, incomplete beta

def t_two_sided_inside(t, nu):
    """A(t | nu) = P(|T| < t), Abramowitz and Stegun 26.7.3 / 26.7.4, integer nu."""
    th = math.atan(t / math.sqrt(nu))
    c2 = math.cos(th) ** 2
    if nu % 2 == 1:
        if nu == 1:
            return 2 * th / math.pi
        term = math.cos(th)
        s = term
        for j in range(3, nu - 1, 2):   # cos^3 ... cos^(nu-2), coefficients 2/3, 2.4/3.5, ...
            term *= c2 * (j - 1) / j
            s += term
        return 2 / math.pi * (th + math.sin(th) * s)
    term = 1.0
    s = 1.0
    for j in range(2, nu - 1, 2):       # cos^2 ... cos^(nu-2), coefficients 1/2, 1.3/2.4, ...
        term *= c2 * (j - 1) / j
        s += term
    return math.sin(th) * s


def t_upper_tail(t, nu):
    return (1 - t_two_sided_inside(t, nu)) / 2


def t_upper_quantile(q, nu):
    lo, hi = 0.0, 1.0
    while t_upper_tail(hi, nu) > q:
        hi *= 2
    for _ in range(3000):
        mid = 0.5 * (lo + hi)
        if mid == lo or mid == hi:
            break
        if t_upper_tail(mid, nu) > q:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def beta_integer(x, a, b):
    """I_x(a, b) for integer a, b: P(Binomial(a + b - 1, x) >= a), exact."""
    x = F(x)
    m = a + b - 1
    return fl(sum(math.comb(m, j) * x ** j * (1 - x) ** (m - j) for j in range(a, m + 1)))


def o_grubbs(values, alpha=0.05, side='two-sided'):
    pr = present(values)
    xs = [F(v) for _, v in pr]
    n = len(xs)
    m = sum(xs) / n
    s = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))
    best, g = None, -math.inf
    for j, x in enumerate(xs):
        dev = abs(x - m) if side == 'two-sided' else (x - m if side == 'max' else m - x)
        gj = fl(dev) / s
        if gj > g:
            best, g = j, gj
    tail = alpha / (2 * n) if side == 'two-sided' else alpha / n
    t = t_upper_quantile(tail, n - 2)
    crit = (n - 1) / math.sqrt(n) * math.sqrt(t * t / (n - 2 + t * t))
    return {'n': n, 'mean': fl(m), 'sd': s, 'statistic': g, 'tCritical': t, 'critical': crit,
            'maxPossible': (n - 1) / math.sqrt(n), 'suspectIndex': pr[best][0], 'reject': g > crit,
            'flags': [{'index': pr[best][0], 'rule': 'grubbs'}] if g > crit else []}


# ---- chi-square quantile by closed-form survival functions

def chi2_sf(x, k):
    if x <= 0:
        return 1.0
    if k % 2 == 0:
        term = math.exp(-x / 2)
        s = term
        for j in range(1, k // 2):
            term *= (x / 2) / j
            s += term
        return s
    s = math.erfc(math.sqrt(x / 2))
    term = math.sqrt(2 * x / math.pi) * math.exp(-x / 2)
    for j in range(1, (k + 1) // 2):
        s += term
        term *= x / (2 * j + 1)
    return s


def chi2_ppf(p, k):
    q = 1 - p
    lo, hi = 0.0, 1.0
    while chi2_sf(hi, k) > q:
        hi *= 2
    for _ in range(3000):
        mid = 0.5 * (lo + hi)
        if mid == lo or mid == hi:
            break
        if chi2_sf(mid, k) > q:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def f_inverse(a):
    """Exact Gauss-Jordan inverse of a Fraction matrix."""
    n = len(a)
    m = [row[:] + [F(int(i == j)) for j in range(n)] for i, row in enumerate(a)]
    for c in range(n):
        piv = next(r for r in range(c, n) if m[r][c] != 0)
        m[c], m[piv] = m[piv], m[c]
        pv = m[c][c]
        m[c] = [v / pv for v in m[c]]
        for r in range(n):
            if r != c and m[r][c] != 0:
                f = m[r][c]
                m[r] = [vr - f * vc for vr, vc in zip(m[r], m[c])]
    return [row[n:] for row in m]


def o_mahalanobis(rows, alpha=0.025):
    p = len(rows[0])
    keep = [i for i, r in enumerate(rows) if not any(missing(v) for v in r)]
    skipped = [i for i in range(len(rows)) if i not in keep]
    n = len(keep)
    X = [[F(rows[i][c]) for c in range(p)] for i in keep]
    mu = [sum(r[c] for r in X) / n for c in range(p)]
    cov = [[sum((r[a] - mu[a]) * (r[b] - mu[b]) for r in X) / (n - 1) for b in range(p)] for a in range(p)]
    inv = f_inverse(cov)
    d2 = [None] * len(rows)
    for i, r in zip(keep, X):
        dev = [r[c] - mu[c] for c in range(p)]
        d2[i] = fl(sum(dev[a] * inv[a][b] * dev[b] for a in range(p) for b in range(p)))
    cut = chi2_ppf(1 - alpha, p)
    return {'n': n, 'p': p, 'centre': [fl(v) for v in mu], 'covariance': [[fl(v) for v in row] for row in cov],
            'd2': d2, 'cutoff': cut, 'skippedRows': skipped,
            'flags': [{'index': i, 'rule': 'mahalanobis'} for i in keep if d2[i] > cut]}


# ---------------------------------------------------------------- control charts

def o_individuals(values, centre=None, mr_bar=None):
    x = [F(v) for v in values]
    mr = [abs(x[i] - x[i - 1]) for i in range(1, len(x))]
    cl = sum(x) / len(x) if centre is None else F(centre)
    mrb = sum(mr) / len(mr) if mr_bar is None else F(mr_bar)
    sigma = mrb / F('1.128')
    ucl, lcl = cl + 3 * sigma, cl - 3 * sigma
    mr_ucl = F('3.267') * mrb
    flags = []
    for i, v in enumerate(x):
        if v > ucl:
            flags.append({'index': i, 'rule': 'individuals-above-ucl'})
        elif v < lcl:
            flags.append({'index': i, 'rule': 'individuals-below-lcl'})
        if i > 0 and mr[i - 1] > mr_ucl:
            flags.append({'index': i, 'rule': 'moving-range-above-ucl'})
    ooc = []
    for f in flags:
        if f['index'] not in ooc:
            ooc.append(f['index'])
    return {'centre': fl(cl), 'movingRanges': [None] + [fl(v) for v in mr], 'mrBar': fl(mrb), 'sigma': fl(sigma),
            'ucl': fl(ucl), 'lcl': fl(lcl), 'mrUcl': fl(mr_ucl), 'mrLcl': 0, 'flags': flags, 'outOfControl': ooc}


def o_ewma(values, lam, target, sigma, L=3, limits='asymptotic'):
    lam_f = F(lam)
    e = F(target)
    ew = []
    pts = []
    flags = []
    base = lam / (2 - lam)
    for i, v in enumerate(values):
        e = lam_f * F(v) + (1 - lam_f) * e
        ew.append(fl(e))
        t = i + 1
        var = base if limits == 'asymptotic' else base * (1 - (1 - lam) ** (2 * t))
        half = L * sigma * math.sqrt(var)
        ucl, lcl = target + half, target - half
        pts.append({'ewma': fl(e), 'ucl': ucl, 'lcl': lcl})
        if fl(e) > ucl:
            flags.append({'index': i, 'rule': 'ewma-above-ucl'})
        elif fl(e) < lcl:
            flags.append({'index': i, 'rule': 'ewma-below-lcl'})
    half = L * sigma * math.sqrt(base)
    return {'start': target, 'ewma': ew, 'sigmaEwma': sigma * math.sqrt(base), 'ucl': target + half, 'lcl': target - half,
            'points': pts, 'flags': flags}


def o_cusum(values, target, k, h, units, sigma=None):
    scale = F(sigma) if units == 'sigma' else F(1)
    kd, hd = F(k) * scale, F(h) * scale
    hi = lo = cum = F(0)
    pts = []
    flags = []
    for i, v in enumerate(values):
        v = F(v)
        hi = max(F(0), hi + v - F(target) - kd)
        lo = max(F(0), lo + F(target) - kd - v)
        cum += v - F(target)
        up, down = hi > hd, lo > hd
        pts.append({'deviation': fl(v - F(target)), 'sHigh': fl(hi), 'sLow': fl(lo), 'cusum': fl(cum), 'signalHigh': up, 'signalLow': down})
        if up:
            flags.append({'index': i, 'rule': 'cusum-high'})
        if down:
            flags.append({'index': i, 'rule': 'cusum-low'})
    fh = next((i for i, p in enumerate(pts) if p['signalHigh']), None)
    fl_ = next((i for i, p in enumerate(pts) if p['signalLow']), None)
    return {'kData': fl(kd), 'hData': fl(hd), 'points': pts, 'flags': flags, 'firstSignalHigh': fh, 'firstSignalLow': fl_}


def o_scorecard(dims, weights=None):
    rows = []
    for d in dims:
        s = F(d['score']) if 'score' in d else 1 - F(d['failed'], d['checked'])
        rows.append((d['name'], s))
    w = [F(1)] * len(rows) if weights is None else [F(weights[name]) for name, _ in rows]
    tot = sum(w)
    out = [{'name': name, 'score': fl(s), 'weight': fl(wi / tot), 'contribution': fl(wi / tot * s)} for (name, s), wi in zip(rows, w)]
    total = sum(wi / tot * s for (name, s), wi in zip(rows, w))
    lowest = min(s for _, s in rows)
    weakest = next(name for name, s in rows if s == lowest)
    return {'total': fl(total), 'dimensions': out, 'weakest': weakest}


# ---------------------------------------------------------------- data

def normal_series(seed, n, mu, sd, decimals=3):
    rng = random.Random(seed)
    out = []
    while len(out) < n:
        u1, u2 = rng.random(), rng.random()
        if u1 <= 0:
            continue
        z = math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)
        out.append(round(mu + sd * z, decimals))
    return out


FLOWRATE = [49.6, 47.6, 49.9, 51.3, 47.8, 51.2, 52.6, 52.4, 53.6, 52.1]          # NIST 6.3.2.2
EWMA_DATA = [52.0, 47.0, 53.0, 49.3, 50.1, 47.0, 51.0, 50.1, 51.2, 50.5,
             49.6, 47.6, 49.9, 51.3, 47.8, 51.2, 52.6, 52.4, 53.6, 52.1]          # NIST 6.3.2.4
EWMA_PRINTED = [50.60, 49.52, 50.56, 50.18, 50.16, 49.21, 49.75, 49.85, 50.26, 50.33,
                50.11, 49.36, 49.52, 50.05, 49.38, 49.92, 50.73, 51.23, 51.94, 51.99]
CUSUM_DATA = [324.925, 324.675, 324.725, 324.350, 325.350, 325.225, 324.125, 324.525,
              325.225, 324.600, 324.625, 325.150, 328.325, 327.250, 327.825, 328.500,
              326.675, 327.775, 326.875, 328.350]                                   # NIST 6.3.2.3
# NIST 6.3.2.3 tabular CUSUM, columns x - 325, S_hi, S_lo, cumulative sum (printed to 2 dp)
CUSUM_PRINTED = [
    (-0.07, 0.00, 0.00, -0.07), (-0.32, 0.00, 0.01, -0.40), (-0.27, 0.00, 0.00, -0.67), (-0.65, 0.00, 0.33, -1.32),
    (0.35, 0.03, 0.00, -0.97), (0.23, 0.00, 0.00, -0.75), (-0.88, 0.00, 0.56, -1.62), (-0.48, 0.00, 0.72, -2.10),
    (0.23, 0.00, 0.17, -1.87), (-0.40, 0.00, 0.25, -2.27), (-0.38, 0.00, 0.31, -2.65), (0.15, 0.00, 0.00, -2.50),
    (3.32, 3.01, 0.00, 0.83), (2.25, 4.94, 0.00, 3.08), (2.82, 7.45, 0.00, 5.90), (3.50, 10.63, 0.00, 9.40),
    (1.68, 11.99, 0.00, 11.08), (2.77, 14.44, 0.00, 13.85), (1.88, 16.00, 0.00, 15.73), (3.35, 19.04, 0.00, 19.08),
]
URANIUM = [199.31, 199.53, 200.19, 200.82, 201.92, 201.95, 202.18, 245.57]          # NIST 1.3.5.17.1
WAFERS = [95.1772, 95.1567, 95.1937, 95.1959, 95.1442, 95.0610, 95.1591, 95.1195,
          95.1065, 95.0925, 95.1990, 95.1682]                                       # NIST 7.2.6.2


def pub(field, value, decimals, ref, tolerance=None, note=None):
    p = {'field': field, 'value': value, 'decimals': decimals, 'ref': ref}
    if tolerance is not None:
        p['tolerance'] = tolerance
    if note:
        p['note'] = note
    return p


def build():
    c = Cases()

    # ======================= published anchors (NIST/SEMATECH) =======================
    r = o_individuals(FLOWRATE)
    ref = NIST + ', section 6.3.2.2 Individuals Control Charts, flow rate example (10 batches)'
    c.add('nist-6.3.2.2-individuals-flowrate', 'individualsChart', {'values': FLOWRATE}, r, source='published',
          published=[pub('centre', 50.81, 2, ref), pub('mrBar', 1.8778, 4, ref), pub('ucl', 55.8041, 4, ref), pub('lcl', 45.8159, 4, ref)]
          + [pub(f'movingRanges.{i}', v, 1, ref) for i, v in enumerate([2.0, 2.3, 1.4, 3.5, 3.4, 1.4, 0.2, 1.2, 1.5], start=1)],
          note='NIST: the process is in control, none of the points is outside the limits; the MR chart limit is D4 x MRbar = 3.267 x 1.8778 (6.3.2.1 table), oracle-derived')

    r = o_ewma(EWMA_DATA, 0.3, 50, 2.0539)
    ref = NIST + ', section 6.3.2.4 EWMA Control Charts, 20-point example, EWMA_0 = 50, s = 2.0539, lambda = 0.3'
    c.add('nist-6.3.2.4-ewma', 'ewmaChart', {'values': EWMA_DATA, 'lambda': 0.3, 'target': 50, 'sigma': 2.0539}, r, source='published',
          published=[pub('ucl', 52.5884, 4, ref),
                     pub('lcl', 47.4115, 4, ref, tolerance=1e-4,
                         note='NIST computes the limits with sqrt(lambda/(2 - lambda)) rounded to 0.4201; unrounded, the LCL is 47.41157, which prints as 47.4116. The check allows one unit in the last printed place.'),
                     pub('start', 50.0, 2, ref)]
          + [pub(f'ewma.{i}', v, 2, ref) for i, v in enumerate(EWMA_PRINTED)],
          note='NIST: every EWMA lies between the limits (no flags); an upward trend over the last five periods')

    r = o_cusum(CUSUM_DATA, 325, 0.3175, 4.1959, 'data')
    ref = NIST + ', section 6.3.2.3 CUSUM Control Charts, tabular form, target 325, h = 4.1959, k = 0.3175'
    pubs = []
    for i, (dev, shi, slo, cum) in enumerate(CUSUM_PRINTED):
        tol = 0.005 + 1e-9
        pubs += [pub(f'points.{i}.deviation', dev, 2, ref, tolerance=tol), pub(f'points.{i}.sHigh', shi, 2, ref, tolerance=tol),
                 pub(f'points.{i}.sLow', slo, 2, ref, tolerance=tol), pub(f'points.{i}.cusum', cum, 2, ref, tolerance=tol)]
    pubs.append(pub('firstSignalHigh', 13, 0, ref + ' (the first starred S_hi is group 14, index 13)'))
    c.add('nist-6.3.2.3-cusum-tabular', 'cusumChart',
          {'values': CUSUM_DATA, 'target': 325, 'k': 0.3175, 'h': 4.1959, 'units': 'data'}, r, source='published', published=pubs,
          note='NIST stars groups 14 to 20 on S_hi. Printed values are rounded half-way ties either way (14.445, 19.035), so the check allows half a unit in the last place. Two entries of the printed 325 - k - x column carry a sign typo (groups 9 and 12); that column is not an engine output.')
    sig = 0.635
    c.add('nist-6.3.2.3-cusum-in-sigma-units', 'cusumChart',
          {'values': CUSUM_DATA, 'target': 325, 'k': 0.5, 'h': 4.1959 / sig, 'units': 'sigma', 'sigma': sig},
          o_cusum(CUSUM_DATA, 325, 0.5, 4.1959 / sig, 'sigma', sig),
          note='the same chart with k = 0.5 sigma and h = 4.1959 / 0.635 sigma, sigma = 1.27 / sqrt(4) = 0.635 (NIST): identical signals')

    ref = NIST + ', section 1.3.5.17.1 Grubbs\' Test for Outliers, uranium isotope example (Tietjen and Moore)'
    c.add('nist-1.3.5.17.1-grubbs-max', 'grubbsTest', {'values': URANIUM, 'alpha': 0.05, 'side': 'max'},
          o_grubbs(URANIUM, 0.05, 'max'), tol=TOL_SPECIAL, source='published',
          published=[pub('statistic', 2.4687, 4, ref, tolerance=1e-4, note=TRUNC), pub('critical', 2.032, 3, ref), pub('reject', True, None, ref)])
    c.add('nist-1.3.5.17-zscore-uranium', 'zScores', {'values': URANIUM}, o_z(URANIUM), source='published',
          published=[pub('maxAbsZ', 2.4687, 4, ref + ': G is the largest |z| with the sample SD', tolerance=1e-4, note=TRUNC)],
          note='the maximum is 2.47 sample SDs out, yet |z| > 3 cannot fire at n = 8: (n - 1)/sqrt(n) = 2.4749')
    c.add('nist-1.3.5.17-modified-z-uranium', 'modifiedZScores', {'values': URANIUM}, o_modz(URANIUM),
          note='the same data by Iglewicz and Hoaglin: M = 29.96 for 245.57 against the 3.5 label (oracle-derived)')

    ref = NIST + ', section 7.2.6.2 Percentiles, silicon wafer resistivities, 90th percentile'
    for m, v in (('R6', 95.1981), ('R7', 95.1957), ('R8', 95.1972)):
        c.add(f'nist-7.2.6.2-p90-{m}', 'sampleQuantile', [WAFERS, 0.9, m], fl(o_quantile(WAFERS, F('0.9'), m)), source='published',
              published=[pub('', v, 4, ref + f' ({m})')])

    # ======================= completeness =======================
    for cid, vals in {
        'complete-none-missing': [1.0, 2.0, 3.0, 4.0],
        'complete-two-gaps': [1.0, None, None, 4.0, 5.0, None, 7.0, 8.0],
        'complete-leading-and-trailing': [None, None, 3.0, 4.0, None],
        'complete-all-missing': [None, None, None],
        'complete-single-missing': [None],
        'complete-long-log': [None if (i % 17 in (3, 4, 5) or 40 <= i < 52) else float(i) for i in range(100)],
    }.items():
        c.add(cid, 'completeness', {'values': vals}, o_completeness(vals))
    c.refuse('complete-empty', 'completeness', {'values': []}, 'values')
    c.refuse('complete-infinite', 'completeness', {'values': [1, 'x', 3]}, 'values[1]')

    idx = [0, 1, 2, 3, 4, 5, 10, 11]
    c.add('coverage-holes', 'coverage', {'index': idx, 'values': [1, 1, None, 1, 1, 1, 1, 1], 'start': 0, 'end': 12, 'maxStep': 1.5},
          o_coverage(idx, [1, 1, None, 1, 1, 1, 1, 1], 0, 12, 1.5),
          note='a missing sample at 2 opens a 2-unit step (a hole at maxStep 1.5); the jump from 5 to 10 is a hole; nothing covers 11 to 12')
    depth = [1000 + 0.5 * i for i in range(41)]
    vals = [None if 12 <= i <= 15 else 1.0 for i in range(41)]
    c.add('coverage-log-interval-clipped', 'coverage', {'index': depth, 'values': vals, 'start': 1002.0, 'end': 1025.0, 'maxStep': 0.5},
          o_coverage(depth, vals, 1002.0, 1025.0, 0.5))
    c.add('coverage-full', 'coverage', {'index': depth, 'values': [1.0] * 41, 'start': 1000.0, 'end': 1020.0, 'maxStep': 0.5},
          o_coverage(depth, [1.0] * 41, 1000.0, 1020.0, 0.5))
    c.add('coverage-step-exactly-max', 'coverage', {'index': [0, 2, 4], 'values': [1, 1, 1], 'start': 0, 'end': 4, 'maxStep': 2},
          o_coverage([0, 2, 4], [1, 1, 1], 0, 4, 2), note='a step equal to maxStep covers (at most, inclusive)')
    c.refuse('coverage-unsorted', 'coverage', {'index': [0, 2, 1], 'values': [1, 1, 1], 'start': 0, 'end': 2, 'maxStep': 1}, 'index[2]')
    c.refuse('coverage-no-maxstep', 'coverage', {'index': [0, 1], 'values': [1, 1], 'start': 0, 'end': 1}, 'maxStep')
    c.refuse('coverage-end-before-start', 'coverage', {'index': [0, 1], 'values': [1, 1], 'start': 1, 'end': 0, 'maxStep': 1}, 'end')

    # ======================= validity =======================
    wc = [0.1, 0.5, -0.02, 1.0, 1.3, None, 0.0]
    c.add('range-fraction-channel', 'rangeCheck', {'values': wc, 'channel': 'fraction', 'unit': 'v/v'}, o_range(wc, 0, 1))
    res = [2.1, 0.0, -1.0, 150.0]
    c.add('range-resistivity-positive', 'rangeCheck', {'values': res, 'channel': 'resistivity', 'unit': 'ohm.m'},
          o_range(res, 0, math.inf, lo_excl=True), note='0 ohm.m is refused as a value: resistivity is strictly positive')
    c.add('range-rate-any-unit', 'rangeCheck', {'values': [120.0, -3.0, 0.0], 'channel': 'rate'}, o_range([120.0, -3.0, 0.0], 0, math.inf))
    t = [-300.0, -273.15, 25.0]
    c.add('range-temperature-degC', 'rangeCheck', {'values': t, 'channel': 'temperature', 'unit': 'degC'}, o_range(t, -273.15, math.inf))
    c.add('range-temperature-degF', 'rangeCheck', {'values': t, 'channel': 'temperature', 'unit': 'degF'}, o_range(t, -459.67, math.inf),
          note='the same numbers in degF are all physical: units change the verdict, and they are never converted')
    gr = normal_series(11, 60, 75, 30, 1)
    gr[7], gr[33] = 320.0, 400.0
    c.add('range-caller-gr-plausibility', 'rangeCheck', {'values': gr, 'min': 0, 'max': 300}, o_range(gr, 0, 300))
    c.add('range-caller-exclusive', 'rangeCheck', {'values': [0.0, 0.5, 1.0], 'min': 0, 'max': 1, 'minExclusive': True, 'maxExclusive': True},
          o_range([0.0, 0.5, 1.0], 0, 1, True, True))
    c.refuse('range-wrong-unit', 'rangeCheck', {'values': [1.0], 'channel': 'sonic', 'unit': 'ms/ft'}, 'unit')
    c.refuse('range-unknown-channel', 'rangeCheck', {'values': [1.0], 'channel': 'porosityish'}, 'channel')
    c.refuse('range-no-limits', 'rangeCheck', {'values': [1.0]}, 'min')
    c.refuse('range-max-below-min', 'rangeCheck', {'values': [1.0], 'min': 2, 'max': 1}, 'max')

    d = [1000.0 + 0.1524 * i for i in range(30)]
    c.add('index-regular-depth', 'indexCheck', {'index': d}, o_index(d))
    d2 = list(d)
    d2[10] = d2[9]              # duplicate
    d2[20], d2[21] = d2[21], d2[20]  # swap: reversal
    d2[25] = None
    c.add('index-depth-defects', 'indexCheck', {'index': d2}, o_index(d2),
          note='a repeated depth, two swapped samples and a missing entry')
    days = [0, 1, 2, 3, 5, 6, 7, 7, 8, 30, 31]
    c.add('index-daily-gaps', 'indexCheck', {'index': days, 'expectedStep': 1}, o_index(days, expected_step=1),
          note='a skipped day, a duplicated day and a 22-day hole show as irregular steps')
    dec = [3000, 2999, 2998, 2998.5, 2996, 2995]
    c.add('index-decreasing', 'indexCheck', {'index': dec, 'direction': 'decreasing'}, o_index(dec, 'decreasing'))
    c.add('index-tolerance', 'indexCheck', {'index': [0, 1, 2.05, 3, 4], 'expectedStep': 1, 'stepTolerance': 0.1},
          o_index([0, 1, 2.05, 3, 4], expected_step=1, step_tol=0.1))
    c.add('index-nonadjacent-duplicate', 'indexCheck', {'index': [1, 2, 3, 2, 4]}, o_index([1, 2, 3, 2, 4]),
          note='the second 2 is both a duplicate and a reversal')
    c.refuse('index-too-short', 'indexCheck', {'index': [1]}, 'index')
    c.refuse('index-bad-direction', 'indexCheck', {'index': [1, 2], 'direction': 'up'}, 'direction')
    c.refuse('index-no-forward-step', 'indexCheck', {'index': [3, 2, 1]}, 'index')

    rates = [120.0, 118.0, -4.0, 0.0, 35.0, 110.0, None, 90.0]
    hours = [24, 24, 24, 0, 0, 24, 24, 12]
    c.add('rate-negative-and-shut-in-hours', 'rateCheck', {'rates': rates, 'hoursOn': hours}, o_rate(rates, hours_on=hours))
    status = ['producing', 'producing', 'shut-in', 'shut-in', 'producing', 'shut-in', 'producing', 'producing']
    c.add('rate-shut-in-status', 'rateCheck', {'rates': rates, 'status': status}, o_rate(rates, status=status))
    c.refuse('rate-hours-length', 'rateCheck', {'rates': [1.0, 2.0], 'hoursOn': [24]}, 'hoursOn')
    c.refuse('rate-hours-negative', 'rateCheck', {'rates': [1.0], 'hoursOn': [-1]}, 'hoursOn[0]')

    # ======================= consistency =======================
    cum = [0, 1200, 2400, 2350, 3600, None, 4700, 4700, 4699.5, 6000]
    c.add('cumulative-drops', 'cumulativeCheck', {'cumulative': cum}, o_cumulative(cum))
    c.add('cumulative-drops-with-tolerance', 'cumulativeCheck', {'cumulative': cum, 'tolerance': 1}, o_cumulative(cum, 1),
          note='a 0.5 drop is inside a 1-unit meter tolerance; the 50 drop is not')

    oil = [100.0, 80.0, 50.0, 0.0, 0.0, 20.0]
    water = [0.0, 20.0, 50.0, 30.0, 0.0, 180.0]
    wcut = [0.0, 0.2, 0.52, 1.0, 0.3, 1.1]
    c.add('watercut-consistency', 'waterCutCheck', {'waterCut': wcut, 'oil': oil, 'water': water, 'tolerance': 0.005},
          o_watercut(wcut, oil, water, 0.005), note='0.52 against 0.5 fails a 0.005 tolerance; no liquid means no check; 1.1 is out of range')
    c.add('watercut-range-only', 'waterCutCheck', {'waterCut': [0.5, -0.1, 1.0, None]}, o_watercut([0.5, -0.1, 1.0, None]))
    c.add('watercut-from-rates', 'waterCutCheck', {'oil': oil, 'water': water}, o_watercut(None, oil, water))
    c.refuse('watercut-nothing', 'waterCutCheck', {}, 'waterCut')
    c.refuse('watercut-length', 'waterCutCheck', {'waterCut': [0.1, 0.2], 'oil': [1.0], 'water': [1.0]}, 'oil')

    parts = {'oil': [100.0, 200.0, 150.0, None], 'water': [50.0, 20.0, 60.0, 10.0]}
    total = [150.0, 221.5, 200.0, 10.0]
    c.add('phasesum-default', 'phaseSumCheck', {'parts': parts, 'total': total}, o_phasesum(parts, total),
          note='221.5 against 220 is 0.68 percent, beyond 0.5 percent; 200 against 210 fails')
    c.add('phasesum-absolute', 'phaseSumCheck', {'parts': parts, 'total': total, 'relTolerance': 0, 'absTolerance': 2},
          o_phasesum(parts, total, 0, 2))
    alloc = {'A': [40.0, 41.0], 'B': [30.0, 30.0], 'C': [30.0, 29.2]}
    c.add('phasesum-allocation', 'phaseSumCheck', {'parts': alloc, 'total': [100.0, 100.0], 'relTolerance': 0.001},
          o_phasesum(alloc, [100.0, 100.0], 0.001))
    c.add('phasesum-tolerance-on-the-total', 'phaseSumCheck', {'parts': {'oil': [60.0, 60.0], 'water': [50.5, 49.5]}, 'total': [100.0, 100.0], 'relTolerance': 0.1},
          o_phasesum({'oil': [60.0, 60.0], 'water': [50.5, 49.5]}, [100.0, 100.0], 0.1),
          note='parts sum to 110.5 against 100: 10.5 is beyond 10 percent of the TOTAL (10) though inside 10 percent of the sum (11.05)')
    c.refuse('phasesum-no-parts', 'phaseSumCheck', {'parts': {}, 'total': [1.0]}, 'parts')
    c.refuse('phasesum-length', 'phaseSumCheck', {'parts': {'oil': [1.0]}, 'total': [1.0, 2.0]}, 'parts.oil')

    fr = [3.1, 3.2, 3.3, 3.3, 3.3, 3.3, 3.3, 3.3, 3.4, 3.5, 7.0, 7.0, 7.0, None, 7.0, 7.0, 7.0, 7.0, 7.0]
    c.add('frozen-default', 'frozenRuns', {'values': fr}, o_frozen(fr))
    c.add('frozen-min3', 'frozenRuns', {'values': fr, 'minRun': 3}, o_frozen(fr, 3))
    tp = [2500.0, 2500.2, 2499.9, 2500.1, 2500.0, 2512.0, 2530.0]
    c.add('frozen-tolerance', 'frozenRuns', {'values': tp, 'minRun': 4, 'tolerance': 0.25}, o_frozen(tp, 4, 0.25),
          note='a gauge wandering 0.2 psi around 2500 counts as stuck at a 0.25 tolerance')
    c.refuse('frozen-minrun-one', 'frozenRuns', {'values': [1.0], 'minRun': 1}, 'minRun')

    # ======================= uniqueness =======================
    for a, b in [('kitten', 'sitting'), ('', 'abc'), ('flaw', 'lawn'), ('WELL12', 'WELL21'), ('EKENE3', 'EKENE3'),
                 ('OKOLO-1ST1', 'OKOLO-1'), ('intention', 'execution'), ('a', ''), ('résumé', 'resume')]:
        c.add(f'levenshtein-{a or "empty"}-{b or "empty"}', 'levenshtein', [a, b], o_levenshtein(a, b))
    c.refuse('levenshtein-not-string', 'levenshtein', [1, 'a'], 'a')
    for s in ['Well-007', ' ekene 3 ', 'EKENE_03/ST1', 'okolo.1', 'Àbá-12', '00', 'A0B00', 'WELL 7A']:
        c.add(f'normalise-{s.strip() or "blank"}', 'normalizeIdentifier', [s], o_normalise(s))
    c.add('normalise-keep-zeros', 'normalizeIdentifier', ['Well-007', {'stripLeadingZeros': False}], o_normalise('Well-007', False))
    ids = ['EKENE-1', 'EKENE-2', 'Ekene 1', 'EKENE-01', 'EKNE-1', 'EKENE-1', 'OKOLO-3', 'OKOLO-3ST', 'EKENE-12', 'EKENE-21']
    c.add('duplicates-well-list', 'duplicateIdentifiers', {'ids': ids}, o_duplicates(ids),
          note='EKENE-1 and EKENE-2 are two real wells (digits differ, not near duplicates); EKNE-1 is a typo of EKENE-1; EKENE-12 and EKENE-21 differ in digits')
    c.add('duplicates-digits-free', 'duplicateIdentifiers', {'ids': ids, 'digitsMustMatch': False}, o_duplicates(ids, digits_match=False),
          note='without the digit rule EKENE-1 and EKENE-2 are called near duplicates: the false positive the rule exists for')
    c.add('duplicates-distance-2', 'duplicateIdentifiers', {'ids': ids, 'maxDistance': 2}, o_duplicates(ids, 2))
    c.add('duplicates-exact-only', 'duplicateIdentifiers', {'ids': ids, 'maxDistance': 0, 'stripLeadingZeros': False},
          o_duplicates(ids, 0, True, False))
    c.refuse('duplicates-empty', 'duplicateIdentifiers', {'ids': []}, 'ids')
    c.refuse('duplicates-non-string', 'duplicateIdentifiers', {'ids': ['A', 3]}, 'ids[1]')

    # ======================= quantiles =======================
    sets = {'wafers': WAFERS, 'uranium': URANIUM, 'five': [3.0, 1.0, 4.0, 1.0, 5.0], 'two': [10.0, 20.0],
            'gr60': normal_series(3, 60, 80, 25, 2), 'with-missing': [5.0, None, 1.0, 3.0, None, 2.0, 4.0]}
    for name, vals in sets.items():
        check_quartiles(vals)
        for m in ('R6', 'R7', 'R8'):
            for p in ('0', '0.05', '0.25', '0.5', '0.75', '0.9', '1'):
                c.add(f'quantile-{name}-{m}-{p}', 'sampleQuantile', [vals, float(p), m], fl(o_quantile(vals, F(p), m)))
    c.refuse('quantile-bad-method', 'sampleQuantile', [[1.0, 2.0], 0.5, 'R5'], 'method')
    c.refuse('quantile-bad-p', 'sampleQuantile', [[1.0, 2.0], 1.5, 'R7'], 'p')

    # ======================= univariate outliers =======================
    base = normal_series(21, 40, 2.45, 0.08, 3)   # a bulk density-like series
    spiked = list(base)
    spiked[5], spiked[27] = 2.95, 1.60
    spiked[12] = None
    c.add('z-rhob-two-spikes', 'zScores', {'values': spiked}, o_z(spiked))
    c.add('z-rhob-population-sd', 'zScores', {'values': spiked, 'sd': 'population'}, o_z(spiked, 3, 'population'))
    c.add('z-rhob-threshold-2', 'zScores', {'values': spiked, 'threshold': 2}, o_z(spiked, 2))
    ten = [1.0] * 9 + [100.0]
    c.add('z-unreachable-at-n10', 'zScores', {'values': ten}, o_z(ten),
          note='one wild value among ten: its z is exactly (n - 1)/sqrt(n) = 2.846 and |z| > 3 cannot fire')
    c.refuse('z-constant', 'zScores', {'values': [2.0, 2.0, 2.0]}, 'values')
    c.refuse('z-too-few', 'zScores', {'values': [1.0, None, 2.0]}, 'values')

    c.add('modz-rhob-two-spikes', 'modifiedZScores', {'values': spiked}, o_modz(spiked))
    c.add('modz-at-n10', 'modifiedZScores', {'values': [1.0, 1.1, 0.9, 1.05, 0.95, 1.0, 1.02, 0.98, 1.01, 100.0]},
          o_modz([1.0, 1.1, 0.9, 1.05, 0.95, 1.0, 1.02, 0.98, 1.01, 100.0]),
          note='the robust score finds the wild value the z-score cannot (compare z-unreachable-at-n10)')
    c.add('modz-threshold-3', 'modifiedZScores', {'values': spiked, 'threshold': 3}, o_modz(spiked, 3))
    c.refuse('modz-mad-zero', 'modifiedZScores', {'values': [5.0, 5.0, 5.0, 5.0, 9.0]}, 'values')

    for m in ('R6', 'R7', 'R8'):
        c.add(f'iqr-rhob-{m}', 'iqrFences', {'values': spiked, 'method': m}, o_iqr(spiked, 1.5, m))
    c.add('iqr-far-out', 'iqrFences', {'values': spiked, 'k': 3}, o_iqr(spiked, 3))
    onf = [1.0, 2.0, 3.0, 4.0, 5.0, 11.0, -5.0, 11.5]
    c.add('iqr-small-sample', 'iqrFences', {'values': onf}, o_iqr(onf))
    onf2 = [-4.0, 2.0, 2.0, 3.0, 4.0, 5.0, 6.0, 6.0, 12.0]
    c.add('iqr-exactly-on-both-fences', 'iqrFences', {'values': onf2}, o_iqr(onf2),
          note='n = 9 so R7 quartiles are the 3rd and 7th order statistics, 2 and 6; IQR 4; fences -4 and 12 are data values and are NOT flagged (strict)')
    onf3 = onf2 + [12.5]
    c.add('iqr-just-past-the-fence', 'iqrFences', {'values': onf3}, o_iqr(onf3))
    c.refuse('iqr-bad-k', 'iqrFences', {'values': [1.0, 2.0, 3.0], 'k': 0}, 'k')

    log = normal_series(31, 50, 60, 4, 2)
    log[9], log[10], log[30] = 140.0, 138.0, 5.0
    log[20] = None
    c.add('hampel-gr-hw3', 'hampel', {'values': log, 'halfWindow': 3}, o_hampel(log, 3))
    c.add('hampel-gr-hw5-n2', 'hampel', {'values': log, 'halfWindow': 5, 'nSigma': 2}, o_hampel(log, 5, 2))
    c.add('hampel-short-windows', 'hampel', {'values': [1.0, None, None, 9.0, None, 1.0], 'halfWindow': 1},
          o_hampel([1.0, None, None, 9.0, None, 1.0], 1), note='no window holds three present samples: nothing is judged')
    c.add('hampel-zero-mad', 'hampel', {'values': [2.0, 2.0, 2.0, 2.1, 2.0, 2.0, 2.0], 'halfWindow': 2},
          o_hampel([2.0, 2.0, 2.0, 2.1, 2.0, 2.0, 2.0], 2), note='MAD 0 in the window: any departure from the median is a spike (strict inequality)')
    on = [-1.0, 0.0, 1.4826, 1.0, 0.0]
    c.add('hampel-on-the-threshold', 'hampel', {'values': on, 'halfWindow': 2, 'nSigma': 1}, o_hampel(on, 2, 1),
          note='the centre point sits on its threshold: median 0, MAD 1, nSigma 1, so |x - median| = 1 x 1.4826 x 1; strict, NOT a spike')
    c.refuse('hampel-no-window', 'hampel', {'values': [1.0, 2.0]}, 'halfWindow')

    for side in ('two-sided', 'max', 'min'):
        for alpha in (0.05, 0.01):
            c.add(f'grubbs-uranium-{side}-{alpha}', 'grubbsTest', {'values': URANIUM, 'alpha': alpha, 'side': side},
                  o_grubbs(URANIUM, alpha, side), tol=TOL_SPECIAL)
    c.add('grubbs-rhob-two-spikes', 'grubbsTest', {'values': spiked}, o_grubbs(spiked), tol=TOL_SPECIAL,
          note='two spikes: Grubbs tests one, and the second one inflates s (masking)')
    for n in (3, 4, 7, 20, 51, 100):
        vals = normal_series(100 + n, n, 10, 1, 3)
        c.add(f'grubbs-normal-n{n}', 'grubbsTest', {'values': vals}, o_grubbs(vals), tol=TOL_SPECIAL)
    c.refuse('grubbs-bad-alpha', 'grubbsTest', {'values': URANIUM, 'alpha': 1.5}, 'alpha')
    c.refuse('grubbs-bad-side', 'grubbsTest', {'values': URANIUM, 'side': 'upper'}, 'side')

    for q in (0.25, 0.1, 0.05, 0.025, 0.01, 0.003125, 1e-3, 1e-4, 1e-6):
        for nu in (1, 2, 3, 5, 6, 10, 29, 98):
            c.add(f'tquantile-{q}-{nu}', 'studentTUpperQuantile', [q, nu], t_upper_quantile(q, nu), tol=TOL_SPECIAL)
    for x, a, b in [(0.3, 2, 3), (0.5, 1, 1), (0.9, 5, 2), (0.01, 3, 7), (0.75, 10, 10), (0.2, 1, 4), (0.6, 7, 1), (0.999, 4, 6)]:
        c.add(f'ibeta-int-{x}-{a}-{b}', 'regularizedBeta', [x, a, b], beta_integer(x, a, b), tol=TOL_SPECIAL)
    for nu in (1, 2, 3, 8, 25):
        for t in (0.5, 1.5, 3.0):
            w = nu / (nu + t * t)
            c.add(f'ibeta-half-{nu}-{t}', 'regularizedBeta', [w, nu / 2, 0.5], 2 * t_upper_tail(t, nu), tol=TOL_SPECIAL,
                  note='I_w(nu/2, 1/2) = 2 P(T > t), w = nu / (nu + t^2), by the closed-form t tail')

    # ======================= Mahalanobis =======================
    rng = random.Random(7)
    rows = []
    for i in range(40):
        phi = round(0.05 + 0.25 * rng.random(), 4)
        rhob = round(2.71 - 1.71 * phi + rng.gauss(0, 0.02), 4)
        rows.append([phi, rhob])
    rows[8] = [0.12, 2.62]       # off the trend, each coordinate unremarkable alone
    rows[22] = [0.28, None]
    c.add('mahal-phi-rhob-2d', 'mahalanobis', {'rows': rows}, o_mahalanobis(rows),
          note='row 8 is ordinary in porosity and in density but not in the pair; row 22 is skipped')
    c.add('mahal-phi-rhob-alpha-0.001', 'mahalanobis', {'rows': rows, 'alpha': 0.001}, o_mahalanobis(rows, 0.001))
    rows3 = [[r[0], r[1], round(60 + 100 * r[0] + rng.gauss(0, 5), 2)] for r in rows if r[1] is not None]
    rows3[30][2] = 20.0
    c.add('mahal-3d', 'mahalanobis', {'rows': rows3}, o_mahalanobis(rows3))
    rows1 = [[v] for v in URANIUM]
    c.add('mahal-1d-equals-z-squared', 'mahalanobis', {'rows': rows1}, o_mahalanobis(rows1),
          note='with one variable d^2 is z^2 on the sample SD')
    rows4 = [[round(rng.gauss(0, 1), 3) for _ in range(4)] for _ in range(25)]
    rows4[3] = [4.0, -4.0, 4.0, -4.0]
    c.add('mahal-4d', 'mahalanobis', {'rows': rows4, 'alpha': 0.01}, o_mahalanobis(rows4, 0.01))
    c.refuse('mahal-singular', 'mahalanobis', {'rows': [[1, 2], [2, 4], [3, 6], [4, 8]]}, 'rows')
    c.refuse('mahal-too-few', 'mahalanobis', {'rows': [[1, 2], [2, 3], [3, 5]]}, 'rows')
    c.refuse('mahal-ragged', 'mahalanobis', {'rows': [[1, 2], [2]]}, 'rows[1]')

    # ======================= control charts (oracle) =======================
    rate = normal_series(41, 30, 1500, 40, 1)
    rate[18] = 1300.0
    c.add('individuals-rate-drop', 'individualsChart', {'values': rate}, o_individuals(rate))
    c.add('individuals-with-target', 'individualsChart', {'values': FLOWRATE, 'centre': 50, 'mrBar': 1.5}, o_individuals(FLOWRATE, 50, 1.5))
    c.refuse('individuals-missing', 'individualsChart', {'values': [1.0, None, 2.0]}, 'values[1]')
    c.refuse('individuals-flat', 'individualsChart', {'values': [3.0, 3.0, 3.0]}, 'values')

    drift = [round(v + 0.06 * max(0, i - 20), 3) for i, v in enumerate(normal_series(51, 40, 10, 0.5, 3))]
    for lam in (0.2, 0.3, 1.0):
        c.add(f'ewma-drift-{lam}', 'ewmaChart', {'values': drift, 'lambda': lam, 'target': 10, 'sigma': 0.5}, o_ewma(drift, lam, 10, 0.5))
    c.add('ewma-drift-exact-limits', 'ewmaChart', {'values': drift, 'lambda': 0.2, 'target': 10, 'sigma': 0.5, 'limits': 'exact'},
          o_ewma(drift, 0.2, 10, 0.5, 3, 'exact'))
    c.add('ewma-nist-exact-limits', 'ewmaChart', {'values': EWMA_DATA, 'lambda': 0.3, 'target': 50, 'sigma': 2.0539, 'limits': 'exact', 'L': 2.7},
          o_ewma(EWMA_DATA, 0.3, 50, 2.0539, 2.7, 'exact'))
    c.refuse('ewma-no-target', 'ewmaChart', {'values': [1.0, 2.0], 'lambda': 0.2, 'sigma': 1}, 'target')
    c.refuse('ewma-bad-lambda', 'ewmaChart', {'values': [1.0, 2.0], 'lambda': 0, 'target': 1, 'sigma': 1}, 'lambda')
    c.refuse('ewma-bad-limits', 'ewmaChart', {'values': [1.0, 2.0], 'lambda': 0.2, 'target': 1, 'sigma': 1, 'limits': 'fancy'}, 'limits')

    c.add('cusum-drift-sigma', 'cusumChart', {'values': drift, 'target': 10, 'k': 0.5, 'h': 5, 'units': 'sigma', 'sigma': 0.5},
          o_cusum(drift, 10, 0.5, 5, 'sigma', 0.5))
    down = [10, 9, 9, 8, 9, 8, 8, 9, 8, 8]
    c.add('cusum-downward', 'cusumChart', {'values': down, 'target': 10, 'k': 0.5, 'h': 4, 'units': 'data'}, o_cusum(down, 10, 0.5, 4, 'data'))
    onh = [11.5, 11.5, 11.5, 11.5]
    c.add('cusum-exactly-on-h', 'cusumChart', {'values': onh, 'target': 10, 'k': 0.5, 'h': 4, 'units': 'data'}, o_cusum(onh, 10, 0.5, 4, 'data'),
          note='S_hi reaches exactly 4.0 = h at the fourth point and does NOT signal (exceeds, strict)')
    c.refuse('cusum-no-units', 'cusumChart', {'values': [1.0, 2.0], 'target': 1, 'k': 0.5, 'h': 4}, 'units')
    c.refuse('cusum-sigma-units-without-sigma', 'cusumChart', {'values': [1.0, 2.0], 'target': 1, 'k': 0.5, 'h': 4, 'units': 'sigma'}, 'sigma')

    # ======================= scorecard =======================
    dims = [{'name': 'completeness', 'checked': 1000, 'failed': 30}, {'name': 'validity', 'checked': 1000, 'failed': 12},
            {'name': 'consistency', 'checked': 400, 'failed': 9}, {'name': 'uniqueness', 'score': 0.98},
            {'name': 'plausibility', 'checked': 970, 'failed': 14}]
    c.add('scorecard-equal', 'scorecard', {'dimensions': dims}, o_scorecard(dims))
    wts = {'completeness': 3, 'validity': 3, 'consistency': 2, 'uniqueness': 1, 'plausibility': 1}
    c.add('scorecard-weighted', 'scorecard', {'dimensions': dims, 'weights': wts}, o_scorecard(dims, wts))
    tie = [{'name': 'validity', 'score': 0.9}, {'name': 'completeness', 'score': 0.9}, {'name': 'uniqueness', 'score': 1}]
    c.add('scorecard-tie', 'scorecard', {'dimensions': tie}, o_scorecard(tie), note='a tie on the lowest score goes to the dimension listed first')
    c.add('scorecard-zero-weight', 'scorecard', {'dimensions': tie, 'weights': {'validity': 0, 'completeness': 1, 'uniqueness': 1}},
          o_scorecard(tie, {'validity': 0, 'completeness': 1, 'uniqueness': 1}))
    c.refuse('scorecard-missing-weight', 'scorecard', {'dimensions': tie, 'weights': {'validity': 1}}, 'weights.completeness')
    c.refuse('scorecard-unknown-weight', 'scorecard', {'dimensions': tie, 'weights': {'accuracy': 1}}, 'weights.accuracy')
    c.refuse('scorecard-bad-failed', 'scorecard', {'dimensions': [{'name': 'x', 'checked': 5, 'failed': 6}]}, 'dimensions[0].failed')
    c.refuse('scorecard-duplicate-name', 'scorecard', {'dimensions': [{'name': 'x', 'score': 1}, {'name': 'x', 'score': 1}]}, 'dimensions[1].name')
    c.refuse('scorecard-all-zero-weights', 'scorecard', {'dimensions': [{'name': 'x', 'score': 1}], 'weights': {'x': 0}}, 'weights')

    return c


def main():
    c = build()
    out = {
        'module': 'quality',
        'generatedBy': 'tools/validation/dataai/oracle_quality.py',
        'tolerance': {'exact': TOL_EXACT, 'special': TOL_SPECIAL, 'absoluteFloor': 1e-12,
                      'note': 'relative tolerance per case in `tol`; a difference below absoluteFloor always passes (values near zero)'},
        'description': 'Oilfield data quality: completeness, validity, consistency, uniqueness, univariate and multivariate outliers, individuals/EWMA/CUSUM charts, scorecard. NIST/SEMATECH worked examples are published anchors; everything else is oracle-derived with the python standard library.',
        'cases': c.cases,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False, allow_nan=False)
        fh.write('\n')
    pub_n = sum(1 for x in c.cases if x['source'] == 'published')
    ref_n = sum(1 for x in c.cases if isinstance(x['expected'], dict) and x['expected'].get('error') is True)
    print('wrote', os.path.relpath(DEST), len(c.cases), 'cases,', pub_n, 'published,', ref_n, 'refusals')


if __name__ == '__main__':
    main()
