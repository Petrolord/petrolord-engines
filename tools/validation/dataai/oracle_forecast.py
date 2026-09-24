#!/usr/bin/env python3
"""Independent oracle for engines/dataai/forecast.js (Data & AI D4, forecasting).

STDLIB ONLY. Run with any python 3.10+:

    python3 tools/validation/dataai/oracle_forecast.py

It writes test-data/dataai/goldens/forecast_cases.json. Nothing here reads or
imports the JavaScript; every value is computed from the published
definitions by a road chosen to differ from the engine's:

  route             oracle road                              engine road
  ----------------  ---------------------------------------  ----------------------
  recursions        ERROR-CORRECTION form in Decimal(60):    component form in float
                    l_t = f_t + alpha e_t,                   (level as a weighted
                    b_t = phi b_{t-1} + alpha beta e_t        average)
  ses check         NIST 6.4.3.1 expanded sum
                    l_t = sum alpha (1-alpha)^i y_{t-i}
                          + (1-alpha)^(t-1) l_1 (asserted equal)
  damped forecast   closed form phi (1 - phi^h) / (1 - phi)   running sum of powers
  parameter fit     ZOOM GRID: the stated coarse grid, then    compass search
                    an 11-point lattice per axis around the
                    best, re-centred until the centre holds,
                    then spacing / 4, down to 1e-11; the
                    optimum is then checked (no SSE drop at
                    +-1e-7 along any free axis in the box)
  metrics           Fractions (exact), square root in         float
                    Decimal
  bootstrap         32-bit integer mulberry32, index          float u, floor(u m)
                    (k m) >> 32; Decimal paths; the
                    simple-statistics quantile rule on the
                    sorted Decimal values
  Arps baseline     fitArpsModel's published algorithm        engines/dca/arps.js
                    (log / reciprocal / q^-b regressions,      (imported)
                    the b grid as JS accumulates it) in
                    Decimal(60)

AMBIGUITY GUARD. Where a float program could take a different branch from
the exact one (two coarse-grid SSEs within 1e-9 relative but not equal, two
Arps candidates' RMSE within 1e-9, a published figure within 1e-9 of a
rounding boundary) the oracle REFUSES TO WRITE the case (raises).

WHAT IT CANNOT CHECK: the conventions (initialisation, bounds, the grid,
metric definitions, bootstrap draw order, percentile labels, the Arps time
mapping). Those are written in FINDINGS-forecast.md and applied here the same
way; the oracle checks the arithmetic of those choices.

Published anchors: NIST/SEMATECH e-Handbook of Statistical Methods,
section 6.4.3 (Single and Double Exponential Smoothing),
https://www.itl.nist.gov/div898/handbook/pmc/section4/pmc43.htm, read
2026-09-24: 6.4.3.1 example (12 observations, alpha 0.1: the smoothed
column and MSE 19.0), 6.4.3.2 (the next forecast 71.5; the alpha 0.3 fit
column of the trend data), 6.4.3.4 (double smoothing alpha 0.3623,
gamma 1.0, S_1 = 6.4, b_1 = 0.8: the smoothed and forecast columns and the
five forecasts 25.8 ... 37.6; the least-MSE single smoothing alpha 0.977
and its fit column). Figures that do NOT reproduce are listed in
FINDINGS-forecast.md (errata) and are not asserted.
"""
import json
import math
import os
import random
from decimal import Decimal as D, getcontext, InvalidOperation
from fractions import Fraction as F

getcontext().prec = 60

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'forecast_cases.json')

TOL = 1e-10
AMBIG = 1e-9

GRID_A = [F(k, 10) for k in range(11)]
GRID_PHI = [F(80, 100), F(85, 100), F(90, 100), F(95, 100), F(98, 100)]
PHI_LO, PHI_HI = 0.8, 0.98
MAX_H = 10000
MAX_POINTS = 100000
MAX_SIMS = 100000
MAX_ORIGINS = 5000


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
    if x is None:
        return None
    return float(x)


def dec(x):
    if isinstance(x, F):
        return D(x.numerator) / D(x.denominator)
    return D(x)


def frac(x):
    if isinstance(x, D):
        return F(x)
    return F(x)


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

    def draw(self, m):
        return (self.next_int() * m) >> 32


# ------------------------------------------------------------------ smoothing (error-correction form)

def layout(method, init_trend):
    if method == 'ses' or init_trend is not None:
        return 2, 1
    return 3, 2


def smooth(y, method, a, b, phi, l1, b1, scored_from):
    """Decimal error-correction recursions. Returns SSE, fitted (None at 0),
    level, trend (None for ses), last state."""
    a = dec(a)
    b = dec(b) if b is not None else D(0)
    ph = dec(phi) if method == 'damped' else D(1)
    trend_on = method != 'ses'
    l = dec(l1)
    tr = dec(b1) if trend_on else D(0)
    n = len(y)
    fitted = [None] * n
    level = [l] + [None] * (n - 1)
    trend = ([tr] + [None] * (n - 1)) if trend_on else None
    sse = D(0)
    for t in range(1, n):
        f = l + ph * tr if trend_on else l
        e = D(y[t]) - f
        if t >= scored_from:
            sse += e * e
        l_new = f + a * e
        if trend_on:
            tr = ph * tr + a * b * e
        l = l_new
        fitted[t] = f
        level[t] = l
        if trend_on:
            trend[t] = tr
    return sse, fitted, level, trend, l, tr


def pw(x, i):
    return D(1) if i == 0 else x ** i


def ses_expanded(y, a, l1, t):
    """NIST 6.4.3.1: the level after observation t (0-based) as a weighted sum."""
    a = dec(a)
    s = D(0)
    for i in range(t):
        s += a * pw(1 - a, i) * D(y[t - i])
    return s + pw(1 - a, t) * dec(l1)


def point_forecast(method, l, tr, phi, h):
    if method == 'ses':
        return [l] * h
    if method == 'holt':
        return [l + j * tr for j in range(1, h + 1)]
    ph = dec(phi)
    if ph == 1:
        return [l + j * tr for j in range(1, h + 1)]
    return [l + ph * (1 - ph ** j) / (1 - ph) * tr for j in range(1, h + 1)]


def sse_float(y, method, a, b, phi, l1, b1, scored_from):
    ph = phi if method == 'damped' else 1.0
    trend_on = method != 'ses'
    l = float(l1)
    tr = float(b1) if trend_on else 0.0
    s = 0.0
    for t in range(1, len(y)):
        f = l + ph * tr if trend_on else l
        e = y[t] - f
        if t >= scored_from:
            s += e * e
        l = f + a * e
        if trend_on:
            tr = ph * tr + a * b * e
    return s


def bounds(nm):
    return (PHI_LO, PHI_HI) if nm == 'phi' else (0.0, 1.0)


def zoom_fit(y, method, fixed, l1, b1, scored_from):
    """Returns (free names, optimum dict, grid start dict)."""
    wanted = ['alpha'] if method == 'ses' else ['alpha', 'beta'] if method == 'holt' else ['alpha', 'beta', 'phi']
    free = [nm for nm in wanted if fixed.get(nm) is None]

    def full(vals):
        p = dict(fixed)
        for nm, v in zip(free, vals):
            p[nm] = v
        return p

    def sse_d(vals):
        p = full(vals)
        return smooth(y, method, p['alpha'], p.get('beta'), p.get('phi'), l1, b1, scored_from)[0]

    def sse_f(vals):
        p = full([float(v) for v in vals])
        return sse_float(y, method, float(p['alpha']), float(p['beta']) if p.get('beta') is not None else 0.0,
                         float(p['phi']) if p.get('phi') is not None else 1.0, l1, b1, scored_from)

    if not free:
        return free, full([]), None
    # coarse grid, exact
    grids = [GRID_PHI if nm == 'phi' else GRID_A for nm in free]
    pts = [[]]
    for g in grids:
        pts = [p + [v] for p in pts for v in g]
    vals = [(sse_d(p), i, p) for i, p in enumerate(pts)]
    best = min(vals, key=lambda v: (v[0], v[1]))
    for s, i, p in vals:
        if i != best[1] and s != best[0] and abs(s - best[0]) <= D(AMBIG) * abs(best[0]):
            raise Ambiguous(f'grid: points {i} and {best[1]} have SSEs within 1e-9')
    start = [float(v) for v in best[2]]
    grid_start = dict(zip(free, start))
    # zoom
    c = start[:]
    fc = sse_f(c)
    spacing = [0.05 * (bounds(nm)[1] - bounds(nm)[0]) for nm in free]
    while max(spacing) > 1e-11:
        axes = []
        for i, nm in enumerate(free):
            lo, hi = bounds(nm)
            axes.append(sorted({min(hi, max(lo, c[i] + k * spacing[i])) for k in range(-5, 6)}))
        cand = [[]]
        for ax in axes:
            cand = [p + [v] for p in cand for v in ax]
        moved = False
        for p in cand:
            f = sse_f(p)
            if f < fc:
                c, fc, moved = p, f, True
        if not moved:  # re-centre at the same spacing until the centre holds, then zoom in
            spacing = [s / 4 for s in spacing]
    # optimality check in Decimal: no drop along any free axis
    f0 = sse_d([F(v) for v in c])
    for i, nm in enumerate(free):
        lo, hi = bounds(nm)
        for sgn in (1, -1):
            q = c[:]
            q[i] = min(hi, max(lo, c[i] + sgn * 1e-7))
            if q[i] == c[i]:
                continue
            if sse_d([F(v) for v in q]) < f0 * (1 - D('1e-12')):
                raise Ambiguous(f'zoom optimum is not a minimum along {nm}')
    return free, full(c), grid_start


def o_fit(y, method, alpha=None, beta=None, phi=None, initial_level=None, initial_trend=None, h=0):
    min_len, scored_from = layout(method, initial_trend)
    l1 = initial_level if initial_level is not None else y[0]
    b1 = 0 if method == 'ses' else (initial_trend if initial_trend is not None else F(y[1]) - F(y[0]))
    fixed = {'alpha': alpha}
    if method != 'ses':
        fixed['beta'] = beta
    if method == 'damped':
        fixed['phi'] = phi
    free, p, grid_start = zoom_fit(y, method, fixed, l1, b1, scored_from)
    sse, fitted, level, trend, l, tr = smooth(y, method, p['alpha'], p.get('beta'), p.get('phi'), l1, b1, scored_from)
    if method == 'ses':
        for t in (1, len(y) - 1):
            assert abs(ses_expanded(y, p['alpha'], l1, t) - level[t]) < D('1e-40'), 'ses expanded sum'
    fc = point_forecast(method, l, tr, p.get('phi'), h)
    n = len(y)
    wanted = [k for k in ['alpha', 'beta', 'phi'] if k in fixed]
    rule = ('l_1 = initialLevel' if initial_level is not None else 'l_1 = y_1')
    if method != 'ses':
        rule += ', b_1 = initialTrend' if initial_trend is not None else ', b_1 = y_2 - y_1'
    out = {
        'method': method,
        'params': {k: fl(p[k]) for k in wanted},
        'fixed': [k for k in wanted if k not in free],
        'free': free,
        'initial': {'level': fl(l1), 'trend': None if method == 'ses' else fl(b1), 'rule': rule},
        'n': n,
        'scoredFrom': scored_from,
        'nScored': n - scored_from,
        'sse': fl(sse),
        'mse': fl(sse / (n - scored_from)),
        'fitted': [fl(v) for v in fitted],
        'residuals': [None if t < scored_from else fl(D(y[t]) - fitted[t]) for t in range(n)],
        'level': [fl(v) for v in level],
        'trend': None if trend is None else [fl(v) for v in trend],
        'forecast': [fl(v) for v in fc],
    }
    if free:
        out['optimiser'] = {'gridStart': grid_start, 'converged': True, 'free': free}
    else:
        out['optimiser'] = None
    state = {'p': p, 'l': l, 'tr': tr, 'fitted': fitted, 'scored_from': scored_from}
    return out, state


# ------------------------------------------------------------------ metrics (Fractions)

def dsqrt(fr):
    return fl(dec(fr).sqrt())


def o_metrics(actual, forecast, qs, q_reason, where):
    n = len(actual)
    sa = se = s2 = sp = ss = sm = F(0)
    mape_reason = None
    for i in range(n):
        y = frac(actual[i])
        f = frac(forecast[i])
        e = y - f
        sa += abs(e)
        s2 += e * e
        se += e
        if y == 0:
            if mape_reason is None:
                mape_reason = f'MAPE is undefined: {where(i)} is 0 and MAPE divides by each actual'
        else:
            sp += abs(e / y)
        den = abs(y) + abs(f)
        ss += 0 if den == 0 else 2 * abs(e) / den
        if qs is not None:
            sm += abs(e) / qs[i]
    notes = {}
    if mape_reason:
        notes['mape'] = mape_reason
    if q_reason:
        notes['mase'] = q_reason
    out = {
        'n': n, 'me': fl(dec(se / n)), 'mae': fl(dec(sa / n)), 'rmse': dsqrt(s2 / n),
        'mape': None if mape_reason else fl(dec(100 * sp / n)),
        'smape': fl(dec(100 * ss / n)),
        'mase': None if q_reason else fl(dec(sm / n)),
    }
    return out, notes


def naive_scale(train, m, label):
    if len(train) <= m:
        return None, f'MASE is undefined: {label} has {len(train)} value{"" if len(train) == 1 else "s"}, so the lag-{m} naive forecast has no in-sample error (it needs more than {m})'
    s = sum(abs(F(train[t]) - F(train[t - m])) for t in range(m, len(train)))
    if s == 0:
        return None, f'MASE is undefined: the lag-{m} naive forecast has zero in-sample error on the {len(train)} values of {label} (every y[t] - y[t - {m}] is 0), so the scale is 0'
    return s / (len(train) - m), None


def o_accuracy(actual, forecast, insample=None, m=1):
    qs = None
    q_reason = None
    scale = None
    if insample is None:
        q_reason = 'MASE needs insample (the training series) to scale by its in-sample naive error'
    else:
        q, q_reason = naive_scale(insample, m, 'insample')
        if q is not None:
            scale = q
            qs = [q] * len(actual)
    out, notes = o_metrics(actual, forecast, qs, q_reason, lambda i: f'actual[{i}]')
    out['maseScale'] = fl(dec(scale)) if scale is not None else None
    out['m'] = m
    if notes:
        out['notes'] = notes
    return out


# ------------------------------------------------------------------ bootstrap

def ss_quantile_sorted(x, p):
    """simple-statistics 7.8.8 quantileSorted (lib/stats), p a Fraction."""
    n = len(x)
    idx = n * p
    if p == 1:
        return x[-1]
    if p == 0:
        return x[0]
    if idx.denominator != 1:
        return x[math.ceil(idx) - 1]
    idx = int(idx)
    if n % 2 == 0:
        return (x[idx - 1] + x[idx]) / 2
    return x[idx]


def o_intervals(y, method, h, seed, n_sims=1000, non_negative=True, **kw):
    fit, st = o_fit(y, method, h=h, **kw)
    p = st['p']
    pool = [D(y[t]) - st['fitted'][t] for t in range(st['scored_from'], len(y))]
    m = len(pool)
    a = dec(p['alpha'])
    b = dec(p['beta']) if p.get('beta') is not None else D(0)
    ph = dec(p['phi']) if method == 'damped' else D(1)
    trend_on = method != 'ses'
    rng = Mulberry32(seed)
    paths = [[] for _ in range(h)]
    for _ in range(n_sims):
        l, tr = st['l'], st['tr']
        for j in range(h):
            f = l + ph * tr if trend_on else l
            e = pool[rng.draw(m)]
            ys = f + e
            paths[j].append(ys)
            # error-correction update with the drawn residual as the error
            l_new = f + a * e
            if trend_on:
                tr = ph * tr + a * b * e
            l = l_new
    lo, mid, hi = [], [], []
    clipped = 0

    def keep(v):
        nonlocal clipped
        if non_negative and v < 0:
            clipped += 1
            return D(0)
        return v
    for j in range(h):
        xs = sorted(paths[j])
        lo.append(keep(ss_quantile_sorted(xs, F(1, 10))))
        mid.append(keep(ss_quantile_sorted(xs, F(1, 2))))
        hi.append(keep(ss_quantile_sorted(xs, F(9, 10))))
    return {
        'method': method,
        'params': fit['params'],
        'forecast': fit['forecast'],
        'P90': [fl(v) for v in lo],
        'P50': [fl(v) for v in mid],
        'P10': [fl(v) for v in hi],
        'nSims': n_sims, 'seed': seed, 'poolSize': m, 'clippedToZero': clipped,
        'definition': 'P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.',
    }


# ------------------------------------------------------------------ backtest

def origins_of(n, first, horizon, step):
    out = []
    k = first
    while k + horizon <= n:
        out.append(k)
        k += step
    return out


def o_pool(rows, horizon, m):
    A, Fc, Q, where = [], [], [], []
    q_reason = None
    byh = [{'A': [], 'F': [], 'Q': [], 'w': []} for _ in range(horizon)]
    for r in rows:
        if r['q'] is None and q_reason is None:
            q_reason = f"MASE is undefined: at origin {r['origin']} " + r['qnote'][len('MASE is undefined: '):]
        for j, v in enumerate(r['actual']):
            w = f"the actual at index {r['origin'] + j} (origin {r['origin']}, step {j + 1})"
            A.append(v); Fc.append(r['fc'][j]); Q.append(r['q']); where.append(w)
            byh[j]['A'].append(v); byh[j]['F'].append(r['fc'][j]); byh[j]['Q'].append(r['q']); byh[j]['w'].append(w)

    def tidy(res):
        out, notes = res
        if notes:
            out['notes'] = notes
        return out
    overall = tidy(o_metrics(A, Fc, None if q_reason else Q, q_reason, lambda i: where[i]))
    by_h = []
    for j, g in enumerate(byh):
        row = {'step': j + 1}
        row.update(tidy(o_metrics(g['A'], g['F'], None if q_reason else g['Q'], q_reason, lambda i, g=g: g['w'][i])))
        by_h.append(row)
    return overall, by_h


def o_backtest_rows(y, method, first, horizon, step, refit, m, fixed):
    rows = []
    held = None
    for idx, o in enumerate(origins_of(len(y), first, horizon, step)):
        train = y[:o]
        kw = dict(fixed)
        if not refit and idx > 0:
            kw.update({k: v for k, v in held.items()})
        fit, st = o_fit(train, method, h=horizon, **kw)
        if not refit and idx == 0:
            held = {k: st['p'][k] for k in ['alpha', 'beta', 'phi'] if k in fit['params']}
        fc = point_forecast(method, st['l'], st['tr'], st['p'].get('phi'), horizon)
        actual = y[o:o + horizon]
        q, qnote = naive_scale(train, m, f'the {o} training values')
        rows.append({'origin': o, 'trainN': o, 'params': fit['params'], 'fc': fc, 'actual': actual, 'q': q, 'qnote': qnote})
    return rows


def rows_out(rows):
    return [{
        'origin': r['origin'], 'trainN': r['trainN'], 'params': r['params'],
        'forecast': [fl(v) for v in r['fc']], 'actual': r['actual'],
        'errors': [fl(D(a) - f) for a, f in zip(r['actual'], r['fc'])],
        'maseScale': fl(dec(r['q'])) if r['q'] is not None else None,
    } for r in rows]


def o_backtest(y, method, first, horizon, step=1, refit=True, m=1, **fixed):
    rows = o_backtest_rows(y, method, first, horizon, step, refit, m, fixed)
    overall, by_h = o_pool(rows, horizon, m)
    return {
        'method': method, 'firstOrigin': first, 'horizon': horizon, 'step': step, 'refit': refit,
        'origins': [r['origin'] for r in rows],
        'perOrigin': rows_out(rows),
        'overall': overall, 'byHorizon': by_h, 'm': m,
    }


# ------------------------------------------------------------------ Arps (fitArpsModel's algorithm)

def js_b_grid():
    out = []
    b = 0.05
    while b <= 2:
        if not abs(b - 1) < 0.001:
            out.append(b)
        b += 0.05
    return out


def regress(xs, ys):
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    return slope, my - slope * mx


def arps_rate(qi, Di, b, t):
    if qi <= 0 or Di < 0 or t < 0:
        return D(0)
    if b <= 0:
        return qi * (-Di * t).exp()
    return qi / (1 + b * Di * t) ** (1 / b)


def rmse_r2(ts, qs, qi, Di, b):
    pred = [arps_rate(qi, Di, b, t) for t in ts]
    n = len(qs)
    ss_res = sum((q - p) ** 2 for q, p in zip(qs, pred))
    mean = sum(qs) / n
    ss_tot = sum((q - mean) ** 2 for q in qs)
    r2 = max(D(0), 1 - ss_res / ss_tot) if ss_tot > 0 else D(0)
    return (ss_res / n).sqrt(), r2


def o_arps_fit(y, model):
    pos = [(k, v) for k, v in enumerate(y) if v > 0]
    if len(pos) < 3:
        return None, len(pos)
    k0 = pos[0][0]
    ts = [D(k - k0) for k, _ in pos]
    qs = [D(v) for _, v in pos]
    cands = []
    if model in ('Exponential', 'Auto-Select'):
        s, i = regress(ts, [q.ln() for q in qs])
        qi, Di = i.exp(), -s
        if qi > 0 and Di > 0:
            r, r2 = rmse_r2(ts, qs, qi, Di, D(0))
            cands.append({'modelType': 'Exponential', 'qi': qi, 'Di': Di, 'b': D(0), 'RMSE': r, 'R2': r2})
    if model in ('Harmonic', 'Auto-Select'):
        s, i = regress(ts, [1 / q for q in qs])
        if i != 0:
            qi = 1 / i
            Di = s * qi
            if qi > 0 and Di > 0:
                r, r2 = rmse_r2(ts, qs, qi, Di, D(1))
                cands.append({'modelType': 'Harmonic', 'qi': qi, 'Di': Di, 'b': D(1), 'RMSE': r, 'R2': r2})
    if model in ('Hyperbolic', 'Auto-Select'):
        best = None
        trail = []
        for bf in js_b_grid():
            b = D(bf)
            try:
                s, i = regress(ts, [q ** (-b) for q in qs])
                if i <= 0:
                    continue
                qi = i ** (-1 / b)
                Di = s / (b * qi ** (-b))
            except (InvalidOperation, ZeroDivisionError):
                continue
            if not (qi > 0 and Di > 0):
                continue
            r, r2 = rmse_r2(ts, qs, qi, Di, b)
            trail.append(r)
            if best is None or r < best['RMSE']:
                best = {'modelType': 'Hyperbolic', 'qi': qi, 'Di': Di, 'b': b, 'RMSE': r, 'R2': r2}
        if best is not None:
            for r in trail:
                if r != best['RMSE'] and abs(r - best['RMSE']) <= D(AMBIG) * best['RMSE']:
                    raise Ambiguous('arps: two b values give RMSE within 1e-9')
            cands.append(best)
    if not cands:
        return 'none', len(pos)
    if model == 'Auto-Select':
        for c1 in cands:
            for c2 in cands:
                if c1 is not c2 and c1['RMSE'] != c2['RMSE'] and abs(c1['RMSE'] - c2['RMSE']) <= D(AMBIG) * c1['RMSE']:
                    raise Ambiguous('arps: candidates tie within 1e-9')
        best = min(enumerate(cands), key=lambda t: (t[1]['RMSE'], t[0]))[1]
    else:
        best = cands[0]
    best['t0'] = k0
    best['nPos'] = len(pos)
    return best, len(pos)


def arps_reason(y, model, subject, plural):
    res, npos = o_arps_fit(y, model)
    if res is None:
        return None, f"{subject} {'have' if plural else 'has'} {npos} positive value{'' if npos == 1 else 's'}: fitArpsModel needs at least 3 (it drops zero and negative rates)"
    if res == 'none':
        kind = 'exponential, harmonic or hyperbolic' if model == 'Auto-Select' else model.lower()
        return None, f"{subject} {'give' if plural else 'gives'} no Arps fit: fitArpsModel found no {kind} fit with qi > 0 and Di > 0 on the {npos} positive values (a series that does not decline cannot be fitted)"
    return res, None


def o_arps_forecast(y, h=0, model='Auto-Select'):
    res, reason = arps_reason(y, model, 'y', False)
    if reason:
        return None, reason
    k0 = res['t0']
    return {
        'modelType': res['modelType'], 'requested': model,
        'qi': fl(res['qi']), 'Di': fl(res['Di']), 'b': fl(res['b']),
        'R2': fl(res['R2']), 'RMSE': fl(res['RMSE']),
        't0Index': k0, 'nUsed': res['nPos'], 'dropped': len(y) - res['nPos'],
        'fitted': [None if k < k0 else fl(arps_rate(res['qi'], res['Di'], res['b'], D(k - k0))) for k in range(len(y))],
        'forecast': [fl(arps_rate(res['qi'], res['Di'], res['b'], D(len(y) + j - k0))) for j in range(h)],
    }, None


def o_compare(y, first, horizon, step=1, methods=('ses', 'holt', 'damped'), refit=True, arps_model='Auto-Select', rank_by='mase', m=1):
    rows = []
    for mt in methods:
        rs = o_backtest_rows(y, mt, first, horizon, step, refit, m, {})
        overall, _ = o_pool(rs, horizon, m)
        row = {'method': mt, 'origins': [r['origin'] for r in rs], 'perOrigin': rows_out(rs)}
        row.update(overall)
        rows.append(row)
    origins = origins_of(len(y), first, horizon, step)
    arows = []
    err = None
    for o in origins:
        train = y[:o]
        res, reason = arps_reason(train, arps_model, f'at origin {o} the {o} training values', True)
        if reason:
            err = reason
            break
        fc = [arps_rate(res['qi'], res['Di'], res['b'], D(o + j - res['t0'])) for j in range(horizon)]
        q, qnote = naive_scale(train, m, f'the {o} training values')
        arows.append({'origin': o, 'trainN': o,
                      'params': {'qi': fl(res['qi']), 'Di': fl(res['Di']), 'b': fl(res['b']), 'modelType': res['modelType']},
                      'fc': fc, 'actual': y[o:o + horizon], 'q': q, 'qnote': qnote})
    if err:
        arow = {'method': 'arps', 'error': err, 'mae': None, 'rmse': None, 'mape': None, 'smape': None, 'mase': None}
    else:
        overall, _ = o_pool(arows, horizon, m)
        arow = {'method': 'arps', 'origins': origins, 'perOrigin': rows_out(arows)}
        arow.update(overall)
    allr = rows + [arow]
    vals = [(r[rank_by], i) for i, r in enumerate(allr) if r.get(rank_by) is not None]
    # ranking: lowest first, a later value must be below by more than 1e-12 relative
    order = []
    left = vals[:]
    while left:
        bi = 0
        for k in range(1, len(left)):
            a, b = left[k][0], left[bi][0]
            if a < b - abs(b) * 1e-12:
                bi = k
        for k in range(len(left)):
            a, b = left[k][0], left[bi][0]
            if k != bi and a != b and abs(a - b) <= AMBIG * abs(b) and abs(a - b) > 1e-13 * abs(b):
                raise Ambiguous('compare: ranking values within 1e-9')
        order.append(left[bi][1])
        left.pop(bi)
    ranking = [allr[i]['method'] for i in order]
    return {
        'firstOrigin': first, 'horizon': horizon, 'step': step, 'refit': refit, 'arpsModel': arps_model, 'rankBy': rank_by,
        'origins': origins, 'rows': allr, 'ranking': ranking, 'best': ranking[0] if ranking else None,
        'unranked': [r['method'] for r in allr if r.get(rank_by) is None],
    }


# ------------------------------------------------------------------ data

NIST_12 = [71, 70, 69, 68, 64, 65, 72, 78, 75, 75, 75, 70]
NIST_TREND = [6.4, 5.6, 7.8, 8.8, 11, 11.6, 16.7, 15.3, 21.6, 22.4]


def ekene_production(n_wells=3, n_months=60, seed=4404):
    """Ekene synthetic monthly production (ours): hyperbolic decline, 6%
    multiplicative noise, a shut-in, a 25% workover uplift; bbl/d to 0.1."""
    r = random.Random(seed)
    wells = []
    for w in range(n_wells):
        qi = 600 + 900 * r.random()
        Di = 0.04 + 0.06 * r.random()
        b = 0.2 + 0.7 * r.random()
        s0 = 24 + r.randrange(20)
        ln = 2 + r.randrange(3)
        rate = []
        for t in range(n_months):
            noise = 1 + 0.06 * r.gauss(0, 1)
            if s0 <= t < s0 + ln:
                rate.append(0.0)
                continue
            lift = 1.25 if t >= s0 + ln else 1
            q = qi / (1 + b * Di * t) ** (1 / b)
            rate.append(round(max(0.0, q * lift * noise), 1))
        wells.append({'well': f'EKENE-P{w + 1:02d}', 'rate': rate, 'shutIn': [s0, s0 + ln - 1]})
    return wells


def clean_decline(n=36, qi=1200.0, Di=0.06, b=0.6, seed=77, noise=0.02):
    r = random.Random(seed)
    return [round(qi / (1 + b * Di * t) ** (1 / b) * (1 + noise * r.gauss(0, 1)), 1) for t in range(n)]


# ------------------------------------------------------------------ published helpers

def check_round(v, digits, published, what):
    v = float(v)
    scaled = v * 10 ** digits
    frac_part = abs(scaled - math.floor(scaled) - 0.5)
    if frac_part < 1e-6:
        raise Ambiguous(f'{what}: {v} sits on a rounding boundary')
    got = round(v, digits)
    if got != published:
        raise AssertionError(f'{what}: {v} rounds to {got}, published {published}')


# ------------------------------------------------------------------ cases

class Cases:
    def __init__(self):
        self.cases = []

    def add(self, cid, fn, args, expected, tol=TOL, note=None, abs_floor=None, source='oracle', published=None, field_tol=None):
        assert cid not in {c['id'] for c in self.cases}, cid
        c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected, 'tol': tol, 'source': source}
        if abs_floor is not None:
            c['abs'] = abs_floor
        if field_tol:
            c['fieldTol'] = field_tol
        if note:
            c['note'] = note
        if published:
            c['published'] = published
        self.cases.append(c)

    def refuse(self, cid, fn, args, field, message, note=None):
        self.add(cid, fn, args, {'error': True, 'field': field, 'message': message}, note=note)


OPT_TOL = {'params': {'abs': 1e-6}, 'sse': {'rel': 1e-9}, 'mse': {'rel': 1e-9},
           'fitted': {'rel': 1e-5, 'abs': 1e-5}, 'residuals': {'rel': 1e-5, 'abs': 1e-5},
           'level': {'rel': 1e-5, 'abs': 1e-5}, 'trend': {'rel': 1e-4, 'abs': 1e-5},
           'forecast': {'rel': 1e-5, 'abs': 1e-5}}
# Estimated parameters agree to about 1e-6 between the two searches; a
# trend forecast six steps out on a series of hundreds of bbl/d then moves by
# up to about 2e-4 bbl/d, so per-origin figures carry an absolute 1e-3.
BT_TOL = {'perOrigin': {'rel': 1e-5, 'abs': 1e-3}, 'overall': {'rel': 1e-5, 'abs': 1e-7},
          'byHorizon': {'rel': 1e-5, 'abs': 1e-7}, 'rows': {'rel': 1e-5, 'abs': 1e-3}}


def fit_case(c, cid, y, method, published=None, note=None, source='oracle', **kw):
    args = {'y': y, 'method': method}
    for k, v in kw.items():
        if v is not None:
            args[k] = v
    ow = {'alpha': 'alpha', 'beta': 'beta', 'phi': 'phi', 'initialLevel': 'initial_level', 'initialTrend': 'initial_trend', 'h': 'h'}
    out, st = o_fit(y, method, **{ow[k]: v for k, v in kw.items() if v is not None})
    optimised = bool(out['free'])
    c.add(cid, 'fitSmoothing', args, out, abs_floor=1e-9, published=published, note=note, source=source,
          field_tol=OPT_TOL if optimised else None)
    return out, st


def build():
    c = Cases()

    # ---------------- NIST published anchors
    out, _ = o_fit(NIST_12, 'ses', alpha=F(1, 10), h=1)
    pub_s = [71.0, 70.9, 70.71, 70.44, 69.80, 69.32, 69.58, 70.43, 70.88, 71.29, 71.67]
    for t, v in enumerate(pub_s, start=1):
        check_round(out['fitted'][t], 2, v, f'NIST 6.4.3.1 S_{t + 1}')
    check_round(out['mse'], 1, 19.0, 'NIST 6.4.3.1 MSE')
    check_round(out['forecast'][0], 2, 71.5, 'NIST 6.4.3.2 next forecast')
    fit_case(c, 'nist-6431-ses-alpha-0.1', NIST_12, 'ses', alpha=0.1, h=1, source='published',
             published=[{'field': f'fitted.{t}', 'digits': 2, 'value': v} for t, v in enumerate(pub_s, start=1)]
             + [{'field': 'mse', 'digits': 1, 'value': 19.0}, {'field': 'forecast.0', 'digits': 2, 'value': 71.5}],
             note='NIST/SEMATECH 6.4.3.1 (S column, MSE = SSE/11 = 19.0) and 6.4.3.2 (next forecast 71.5)')
    fit_case(c, 'nist-6431-ses-alpha-0.5', NIST_12, 'ses', alpha=0.5, h=1,
             note='NIST prints MSE 16.29 for alpha 0.5; the recursion gives 16.4965 (erratum, FINDINGS)')
    pub_t = [6.4, 6.2, 6.7, 7.3, 8.4, 9.4, 11.6, 12.7, 15.4]
    out, _ = o_fit(NIST_TREND, 'ses', alpha=F(3, 10))
    for t, v in enumerate(pub_t, start=1):
        check_round(out['fitted'][t], 1, v, f'NIST 6.4.3.2 fit {t}')
    fit_case(c, 'nist-6432-ses-trend-alpha-0.3', NIST_TREND, 'ses', alpha=0.3, source='published',
             published=[{'field': f'fitted.{t}', 'digits': 1, 'value': v} for t, v in enumerate(pub_t, start=1)],
             note='NIST/SEMATECH 6.4.3.2: single smoothing of the trend data, alpha 0.3, the Fit column')
    # double smoothing 6.4.3.4
    out, _ = o_fit(NIST_TREND, 'holt', alpha=F(3623, 10000), beta=1, initial_trend=F(8, 10), h=5)
    pub_f = [7.2, 6.8, 7.8, 9.1, 11.4, 13.2, 17.4, 18.9, 23.1]
    pub_l = [6.4, 6.6, 7.2, 8.1, 9.8, 11.5, 14.5, 16.7, 19.9, 22.8]
    pub_h = [25.8, 28.7, 31.7, 34.6, 37.6]
    for t, v in enumerate(pub_f, start=1):
        check_round(out['fitted'][t], 1, v, f'NIST 6.4.3.4 forecast {t}')
    for t, v in enumerate(pub_l):
        check_round(out['level'][t], 1, v, f'NIST 6.4.3.4 double {t}')
    for j, v in enumerate(pub_h):
        check_round(out['forecast'][j], 1, v, f'NIST 6.4.3.4 period {11 + j}')
    fit_case(c, 'nist-6434-holt-fixed', NIST_TREND, 'holt', alpha=0.3623, beta=1, initialTrend=0.8, h=5, source='published',
             published=[{'field': f'fitted.{t}', 'digits': 1, 'value': v} for t, v in enumerate(pub_f, start=1)]
             + [{'field': f'level.{t}', 'digits': 1, 'value': v} for t, v in enumerate(pub_l)]
             + [{'field': f'forecast.{j}', 'digits': 1, 'value': v} for j, v in enumerate(pub_h)],
             note='NIST/SEMATECH 6.4.3.4: alpha 0.3623, gamma 1.0, S_1 = 6.4, b_1 = 0.8 (mean of the first three differences). NIST prints MSE 3.7024; the recursion gives 3.674309 (erratum, FINDINGS)')
    out, _ = o_fit(NIST_TREND, 'holt', initial_trend=F(8, 10), h=5)
    check_round(out['params']['alpha'], 4, 0.3623, 'NIST 6.4.3.4 alpha')
    assert out['params']['beta'] == 1.0
    fit_case(c, 'nist-6434-holt-fit', NIST_TREND, 'holt', initialTrend=0.8, h=5, source='published',
             published=[{'field': 'params.alpha', 'digits': 4, 'value': 0.3623}, {'field': 'params.beta', 'digits': 4, 'value': 1.0}],
             note='NIST/SEMATECH 6.4.3.4: the least-MSE double smoothing is alpha 0.3623, gamma 1.0 (gamma at its bound)')
    out, _ = o_fit(NIST_TREND, 'ses', h=5)
    check_round(out['params']['alpha'], 3, 0.977, 'NIST 6.4.3.4 single alpha')
    pub_1 = [6.4, 5.6, 7.8, 8.8, 10.9, 11.6, 16.6, 15.3, 21.5]
    for t, v in enumerate(pub_1, start=1):
        check_round(out['fitted'][t], 1, v, f'NIST 6.4.3.4 single {t}')
    pub_5 = [22.4] * 5
    for j, v in enumerate(pub_5):
        check_round(out['forecast'][j], 1, v, f'NIST 6.4.3.4 single period {11 + j}')
    fit_case(c, 'nist-6434-ses-fit', NIST_TREND, 'ses', h=5, source='published',
             published=[{'field': 'params.alpha', 'digits': 3, 'value': 0.977}]
             + [{'field': f'fitted.{t}', 'digits': 1, 'value': v} for t, v in enumerate(pub_1, start=1)]
             + [{'field': f'forecast.{j}', 'digits': 1, 'value': v} for j, v in enumerate(pub_5)],
             note='NIST/SEMATECH 6.4.3.4: least-MSE single smoothing alpha 0.977, its Single column and five forecasts of 22.4. The coarse grid best is alpha 1 (SSE 79.98); the search finds the interior minimum 0.97728 (SSE 79.8913). At alpha 0.977 exactly S_4 is 7.7498, which prints 7.7: NIST used the unrounded optimum')
    out, _ = o_fit(NIST_TREND, 'ses', alpha=1)
    check_round(out['mse'], 4, 8.8867, 'NIST 6.4.3.4 single MSE (alpha 1)')
    fit_case(c, 'nist-6434-ses-alpha-1', NIST_TREND, 'ses', alpha=1, source='published',
             published=[{'field': 'mse', 'digits': 4, 'value': 8.8867}],
             note='NIST prints MSE 8.8867 next to alpha 0.977; that figure is the MSE at alpha = 1 exactly (alpha 0.977 gives 8.8768). Asserted here at alpha 1; erratum in FINDINGS')

    # ---------------- Ekene fixed-parameter recursions
    E = ekene_production()
    w1, w2, w3 = (w['rate'] for w in E)
    fit_case(c, 'ses-ekene1-fixed', w1, 'ses', alpha=0.35, h=6)
    fit_case(c, 'holt-ekene1-fixed', w1, 'holt', alpha=0.4, beta=0.15, h=12)
    fit_case(c, 'damped-ekene1-fixed', w1, 'damped', alpha=0.4, beta=0.15, phi=0.9, h=24)
    fit_case(c, 'damped-ekene2-phi-1', w2, 'damped', alpha=0.5, beta=0.2, phi=1, h=6, note='phi = 1 is Holt (property test compares)')
    fit_case(c, 'damped-ekene2-phi-0.8', w2, 'damped', alpha=0.5, beta=0.2, phi=0.8, h=6)
    fit_case(c, 'ses-alpha-0', w2, 'ses', alpha=0, h=3, note='alpha 0: the level never moves from y_1')
    fit_case(c, 'ses-alpha-1', w2, 'ses', alpha=1, h=3, note='alpha 1: the naive forecast')
    fit_case(c, 'holt-beta-0', w3, 'holt', alpha=0.3, beta=0, h=4, note='beta 0: the trend stays y_2 - y_1')
    fit_case(c, 'holt-initial-level-and-trend', w3, 'holt', alpha=0.3, beta=0.1, initialLevel=1500, initialTrend=-25, h=4)
    fit_case(c, 'ses-initial-level', w3, 'ses', alpha=0.2, initialLevel=1000, h=2)
    fit_case(c, 'holt-three-points', [100, 90, 85], 'holt', alpha=0.5, beta=0.5, h=2, note='the minimum length: one scored error')
    fit_case(c, 'ses-two-points', [100, 90], 'ses', alpha=0.5, h=2, note='the minimum length: one scored error')
    fit_case(c, 'damped-negative-values', [5.0, 3.5, -1.25, 2.0, -4.5, 0.0, 1.75], 'damped', alpha=0.6, beta=0.3, phi=0.85, h=3)

    # ---------------- Ekene optimised fits
    for i, w in enumerate((w1, w2, w3), start=1):
        for mt in ('ses', 'holt', 'damped'):
            fit_case(c, f'{mt}-ekene{i}-fit', w, mt, h=12)
    fit_case(c, 'damped-ekene1-fit-alpha-fixed', w1, 'damped', alpha=0.3, h=6, note='alpha fixed, beta and phi estimated')
    fit_case(c, 'damped-ekene2-fit-phi-fixed', w2, 'damped', phi=0.9, h=6, note='phi fixed, alpha and beta estimated')
    fit_case(c, 'holt-linear-exact', [10, 12, 14, 16, 18, 20, 22, 24], 'holt', h=3,
             note='an exact line: every (alpha, beta) gives SSE 0, so the grid tie keeps its first point (0, 0) and no step improves')

    # ---------------- fitSmoothing refusals
    R = lambda cid, args, field, msg, note=None: c.refuse(cid, 'fitSmoothing', args, field, msg, note)
    R('fit-method-bad', {'y': w1, 'method': 'arima'}, 'method', "method must be 'ses', 'holt' or 'damped'")
    R('fit-y-not-array', {'y': 5, 'method': 'ses'}, 'y', 'y must be an array of numbers')
    R('fit-y-nan', {'y': [1, 2, None, 4], 'method': 'ses'}, 'y[2]', 'y[2] must be a finite number: fill or drop missing values first')
    R('fit-ses-one-value', {'y': [5], 'method': 'ses'}, 'y', "y has 1 value: 'ses' needs at least 2 (the first sets the level, the second is the first scored forecast)")
    R('fit-holt-two-values', {'y': [5, 4], 'method': 'holt'}, 'y', "y has 2 values: 'holt' needs at least 3 (the first two set the initial level and trend, the third is the first scored forecast)")
    R('fit-damped-trend-one-value', {'y': [5], 'method': 'damped', 'initialTrend': -1}, 'y', "y has 1 value: 'damped' with an initialTrend needs at least 2 (the first sets the level, the second is the first scored forecast)")
    R('fit-alpha-above-1', {'y': w1, 'method': 'ses', 'alpha': 1.0000001}, 'alpha', 'alpha must be a number from 0 to 1 (inclusive)')
    R('fit-alpha-negative', {'y': w1, 'method': 'ses', 'alpha': -0.1}, 'alpha', 'alpha must be a number from 0 to 1 (inclusive)')
    R('fit-beta-string', {'y': w1, 'method': 'holt', 'beta': '0.2'}, 'beta', 'beta must be a number from 0 to 1 (inclusive)')
    R('fit-beta-ses', {'y': w1, 'method': 'ses', 'beta': 0.2}, 'beta', "beta applies to 'holt' and 'damped' only: 'ses' has no trend")
    R('fit-trend-ses', {'y': w1, 'method': 'ses', 'initialTrend': 1}, 'initialTrend', "initialTrend applies to 'holt' and 'damped' only: 'ses' has no trend")
    R('fit-phi-holt', {'y': w1, 'method': 'holt', 'phi': 0.9}, 'phi', "phi applies to 'damped' only: 'holt' is the damped method with phi = 1")
    R('fit-phi-0', {'y': w1, 'method': 'damped', 'phi': 0}, 'phi', 'phi must be a number above 0 and at most 1 when given (when fitted it is searched from 0.8 to 0.98)')
    R('fit-phi-above-1', {'y': w1, 'method': 'damped', 'phi': 1.01}, 'phi', 'phi must be a number above 0 and at most 1 when given (when fitted it is searched from 0.8 to 0.98)')
    R('fit-initial-level-nan', {'y': w1, 'method': 'ses', 'initialLevel': 'x'}, 'initialLevel', 'initialLevel must be a finite number when given')
    R('fit-initial-trend-nan', {'y': w1, 'method': 'holt', 'initialTrend': None}, 'initialTrend', 'initialTrend must be a finite number when given')
    R('fit-h-negative', {'y': w1, 'method': 'ses', 'h': -1}, 'h', 'h must be a whole number from 0 to 10000')
    R('fit-h-fraction', {'y': w1, 'method': 'ses', 'h': 1.5}, 'h', 'h must be a whole number from 0 to 10000')
    R('fit-h-above-max', {'y': w1, 'method': 'ses', 'h': 10001}, 'h', 'h must be a whole number from 0 to 10000')

    # ---------------- accuracy
    A = lambda cid, args, note=None: c.add(cid, 'accuracy', args, o_accuracy(args['actual'], args['forecast'], args.get('insample'), args.get('m', 1)), note=note, abs_floor=1e-12)
    A('acc-basic', {'actual': [100, 110, 95, 105], 'forecast': [98, 115, 99, 101], 'insample': [90, 100, 96, 104, 99]})
    A('acc-zero-actual', {'actual': [10, 0, 5], 'forecast': [8, 1, 5], 'insample': [12, 11, 10, 9]}, note='MAPE null (actual[1] is 0)')
    A('acc-smape-zero-zero', {'actual': [0, 4, 0], 'forecast': [0, 5, 2], 'insample': [3, 1]}, note='sMAPE: the term with actual = forecast = 0 scores 0; the actual 0 with forecast 2 scores 200')
    A('acc-no-insample', {'actual': [1.5, 2.5], 'forecast': [1, 3]}, note='MASE null without insample')
    A('acc-constant-insample', {'actual': [5, 6], 'forecast': [5, 5], 'insample': [7, 7, 7]}, note='MASE null: Q = 0')
    A('acc-insample-too-short', {'actual': [5], 'forecast': [4], 'insample': [7, 8, 9], 'm': 3}, note='MASE null: 3 values at lag 3 have no naive error')
    A('acc-seasonal-m4', {'actual': [20, 24, 30, 22], 'forecast': [21, 23, 28, 25], 'insample': [10, 14, 19, 12, 12, 16, 22, 13, 15, 18, 26, 17], 'm': 4})
    A('acc-negative-values', {'actual': [-2, 3, -1.5], 'forecast': [-1, 2.5, 0.5], 'insample': [1, -1, 2, -2]})
    A('acc-perfect', {'actual': [3, 4, 5], 'forecast': [3, 4, 5], 'insample': [1, 2]})
    Ra = lambda cid, args, field, msg: c.refuse(cid, 'accuracy', args, field, msg)
    Ra('acc-actual-empty', {'actual': [], 'forecast': []}, 'actual', 'actual has 0 values: at least 1 actual is needed')
    Ra('acc-forecast-length', {'actual': [1, 2, 3], 'forecast': [1, 2]}, 'forecast', 'forecast must have 3 values, one per actual (it has 2)')
    Ra('acc-forecast-nan', {'actual': [1, 2], 'forecast': [1, 'x']}, 'forecast[1]', 'forecast[1] must be a finite number: fill or drop missing values first')
    Ra('acc-m-zero', {'actual': [1], 'forecast': [1], 'm': 0}, 'm', 'm must be a whole number, 1 or more (1 is the non-seasonal naive; 12 is a monthly seasonal naive)')
    Ra('acc-insample-empty', {'actual': [1], 'forecast': [1], 'insample': []}, 'insample', 'insample has 0 values: at least 1 value is needed')

    # ---------------- bootstrap intervals
    def I(cid, y, method, h, seed, note=None, tol=TOL, field_tol=None, **kw):
        args = {'y': y, 'method': method, 'h': h, 'seed': seed}
        ow = {'alpha': 'alpha', 'beta': 'beta', 'phi': 'phi', 'nSims': 'n_sims', 'nonNegative': 'non_negative', 'initialTrend': 'initial_trend'}
        for k, v in kw.items():
            args[k] = v
        exp = o_intervals(y, method, h, seed, **{ow[k]: v for k, v in kw.items()})
        c.add(cid, 'forecastIntervals', args, exp, note=note, tol=tol, abs_floor=1e-9, field_tol=field_tol)
    I('pi-ses-ekene1', w1, 'ses', 6, 11, alpha=0.35)
    I('pi-holt-ekene1', w1, 'holt', 12, 12, alpha=0.4, beta=0.15)
    I('pi-damped-ekene2', w2, 'damped', 12, 13, alpha=0.5, beta=0.2, phi=0.9, nSims=500)
    I('pi-ses-nsims-1', w3, 'ses', 3, 5, alpha=0.2, nSims=1, note='one path: every percentile is that path')
    I('pi-ses-nsims-7-odd', w3, 'ses', 2, 5, alpha=0.2, nSims=7, note='odd count: 7 x 0.1 is not whole, so the 10th percentile is the 1st sorted value')
    tail = [120.0, 100.0, 70.0, 45.0, 30.0, 18.0, 9.0, 6.0, 2.0]
    I('pi-holt-clipped', tail, 'holt', 6, 3, alpha=0.5, beta=0.5, note='a steep decline: negative percentiles are reported as 0 and counted')
    I('pi-holt-unclipped', tail, 'holt', 6, 3, alpha=0.5, beta=0.5, nonNegative=False, note='the same paths, negatives kept')
    I('pi-ses-fit', w2, 'ses', 4, 99, field_tol={'params': {'abs': 1e-6}, 'forecast': {'rel': 1e-5}, 'P90': {'rel': 1e-5}, 'P50': {'rel': 1e-5}, 'P10': {'rel': 1e-5}},
      note='alpha estimated, then the bootstrap')
    Ri = lambda cid, args, field, msg: c.refuse(cid, 'forecastIntervals', args, field, msg)
    Ri('pi-h-0', {'y': w1, 'method': 'ses', 'h': 0, 'seed': 1}, 'h', 'h must be a whole number from 1 to 10000')
    Ri('pi-seed-missing', {'y': w1, 'method': 'ses', 'h': 3}, 'seed', 'seed must be a whole number from 0 to 4294967295')
    Ri('pi-seed-negative', {'y': w1, 'method': 'ses', 'h': 3, 'seed': -1}, 'seed', 'seed must be a whole number from 0 to 4294967295')
    Ri('pi-nsims-0', {'y': w1, 'method': 'ses', 'h': 3, 'seed': 1, 'nSims': 0}, 'nSims', 'nSims must be a whole number from 1 to 100000')
    Ri('pi-nsims-above', {'y': w1, 'method': 'ses', 'h': 3, 'seed': 1, 'nSims': 100001}, 'nSims', 'nSims must be a whole number from 1 to 100000')
    Ri('pi-nonnegative-string', {'y': w1, 'method': 'ses', 'h': 3, 'seed': 1, 'nonNegative': 'yes'}, 'nonNegative', 'nonNegative must be true or false')
    Ri('pi-pool-too-small', {'y': [10, 9, 8], 'method': 'holt', 'h': 3, 'seed': 1}, 'y', "y has 3 values, which leave 1 scored residual: the bootstrap resamples at least 2, so 'holt' needs at least 4 values here")
    Ri('pi-method-bad', {'y': w1, 'method': 'arps', 'h': 3, 'seed': 1}, 'method', "method must be 'ses', 'holt' or 'damped'")

    # ---------------- backtests
    def B(cid, y, method, first, horizon, step=1, refit=True, m=1, note=None, **fixed):
        args = {'y': y, 'method': method, 'firstOrigin': first, 'horizon': horizon, 'step': step, 'refit': refit, 'm': m}
        args.update(fixed)
        exp = o_backtest(y, method, first, horizon, step, refit, m, **fixed)
        free = any(k not in fixed for k in (['alpha'] if method == 'ses' else ['alpha', 'beta'] if method == 'holt' else ['alpha', 'beta', 'phi']))
        c.add(cid, 'backtest', args, exp, note=note, abs_floor=1e-9, field_tol=BT_TOL if free else None)
    B('bt-ses-fixed', w1, 'ses', 24, 6, step=6, alpha=0.35)
    B('bt-holt-fixed', w1, 'holt', 30, 3, step=3, alpha=0.4, beta=0.15)
    B('bt-damped-fixed', w2, 'damped', 40, 6, step=4, alpha=0.5, beta=0.2, phi=0.9)
    B('bt-ses-fixed-step1-h1', NIST_12, 'ses', 6, 1, alpha=0.1, note='every origin, one step ahead: the errors are the one-step residuals from index 6')
    B('bt-ses-last-origin-exact', NIST_12, 'ses', 9, 3, alpha=0.5, note='firstOrigin = n - horizon: exactly one origin')
    B('bt-ses-seasonal-m12', w3, 'ses', 36, 6, step=6, m=12, alpha=0.3)
    B('bt-ses-refit', w1, 'ses', 36, 6, step=6)
    B('bt-holt-refit', w2, 'holt', 36, 6, step=8)
    B('bt-damped-refit', w3, 'damped', 40, 6, step=7)
    B('bt-holt-refit-false', w2, 'holt', 36, 6, step=8, refit=False, note='parameters estimated on the first window and held')
    shut = [500.0, 480.0, 455.0, 430.0, 0.0, 0.0, 420.0, 400.0, 385.0, 370.0]
    B('bt-ses-shutin-actuals', shut, 'ses', 3, 2, alpha=0.5, note='zero actuals: MAPE null naming the first zero actual')
    flat = [7.0, 7.0, 7.0, 7.0, 7.0, 8.0, 9.0]
    B('bt-ses-flat-training', flat, 'ses', 3, 2, alpha=0.5, note='the first window is constant: MASE null naming the origin')
    Rb = lambda cid, args, field, msg: c.refuse(cid, 'backtest', args, field, msg)
    Rb('bt-horizon-0', {'y': w1, 'method': 'ses', 'firstOrigin': 10, 'horizon': 0}, 'horizon', 'horizon must be a whole number, 1 or more')
    Rb('bt-step-0', {'y': w1, 'method': 'ses', 'firstOrigin': 10, 'horizon': 3, 'step': 0}, 'step', 'step must be a whole number, 1 or more')
    Rb('bt-first-too-small', {'y': w1, 'method': 'holt', 'firstOrigin': 2, 'horizon': 3}, 'firstOrigin', "firstOrigin must be a whole number from 3 to 57 ('holt' needs 3 training values; an origin above 57 leaves fewer than 3 actuals)")
    Rb('bt-first-too-large', {'y': w1, 'method': 'ses', 'firstOrigin': 58, 'horizon': 3}, 'firstOrigin', "firstOrigin must be a whole number from 2 to 57 ('ses' needs 2 training values; an origin above 57 leaves fewer than 3 actuals)")
    Rb('bt-series-too-short', {'y': [1, 2, 3, 4], 'method': 'holt', 'firstOrigin': 3, 'horizon': 2}, 'y', "y has 4 values: a backtest with horizon 2 needs at least 5 ('holt' needs 3 training values, then 2 actuals)")
    Rb('bt-refit-string', {'y': w1, 'method': 'ses', 'firstOrigin': 10, 'horizon': 3, 'refit': 'no'}, 'refit', 'refit must be true or false')
    Rb('bt-m-fraction', {'y': w1, 'method': 'ses', 'firstOrigin': 10, 'horizon': 3, 'm': 1.5}, 'm', 'm must be a whole number, 1 or more (1 is the non-seasonal naive; 12 is a monthly seasonal naive)')
    Rb('bt-too-many-origins', {'y': [float(v % 7) for v in range(5010)], 'method': 'ses', 'firstOrigin': 2, 'horizon': 1, 'alpha': 0.5}, 'step',
       'step gives 5008 origins, above the 5000 a backtest accepts: raise step or firstOrigin')
    Rb('bt-beta-ses', {'y': w1, 'method': 'ses', 'firstOrigin': 10, 'horizon': 3, 'beta': 0.1}, 'beta', "beta applies to 'holt' and 'damped' only: 'ses' has no trend")

    # ---------------- Arps baseline
    def AR(cid, y, h=0, model='Auto-Select', note=None):
        args = {'y': y, 'h': h, 'modelType': model}
        exp, reason = o_arps_forecast(y, h, model)
        if reason:
            c.refuse(cid, 'arpsForecast', args, 'y', reason, note)
        else:
            c.add(cid, 'arpsForecast', args, exp, note=note, tol=1e-9, abs_floor=1e-9)
    dec_clean = clean_decline()
    AR('arps-clean-auto', dec_clean, 12)
    AR('arps-clean-exponential', dec_clean, 6, 'Exponential')
    AR('arps-clean-harmonic', dec_clean, 6, 'Harmonic')
    AR('arps-clean-hyperbolic', dec_clean, 6, 'Hyperbolic')
    AR('arps-ekene1-shutin', w1, 12, note='the shut-in zeros are dropped by fitArpsModel; the workover uplift stays in')
    lead = [0.0, 0.0] + clean_decline(20, 900.0, 0.08, 0.4, 5)
    AR('arps-leading-zeros', lead, 3, note='t = 0 at the first positive value (index 2)')
    AR('arps-rising-refused', [100.0, 110.0, 125.0, 130.0, 150.0], 2, note='no decline: every model has Di <= 0')
    AR('arps-two-positive-refused', [0.0, 50.0, 0.0, 40.0], 2)
    AR('arps-rising-exponential-refused', [100.0, 110.0, 125.0, 130.0, 150.0], 2, 'Exponential')
    Rr = lambda cid, args, field, msg: c.refuse(cid, 'arpsForecast', args, field, msg)
    Rr('arps-model-bad', {'y': dec_clean, 'modelType': 'Duong'}, 'modelType', "modelType must be 'Auto-Select', 'Exponential', 'Harmonic' or 'Hyperbolic'")
    Rr('arps-y-short', {'y': [10, 9]}, 'y', 'y has 2 values: fitArpsModel needs at least 3 positive values')
    Rr('arps-h-bad', {'y': dec_clean, 'h': -2}, 'h', 'h must be a whole number from 0 to 10000')

    # ---------------- comparison
    def CMP(cid, y, first, horizon, note=None, **kw):
        args = {'y': y, 'firstOrigin': first, 'horizon': horizon}
        ow = {'step': 'step', 'methods': 'methods', 'refit': 'refit', 'arpsModel': 'arps_model', 'rankBy': 'rank_by', 'm': 'm'}
        args.update(kw)
        exp = o_compare(y, first, horizon, **{ow[k]: (tuple(v) if k == 'methods' else v) for k, v in kw.items()})
        fixed_all = kw.get('refit') is False and False
        c.add(cid, 'compareWithArps', args, exp, note=note, abs_floor=1e-9, field_tol=BT_TOL if not fixed_all else None)
    CMP('cmp-clean-decline', dec_clean, 18, 6, step=6)
    CMP('cmp-ekene1', w1, 36, 6, step=8, note='the shut-in and workover sit inside the backtest')
    CMP('cmp-ekene2-rmse-refit-false', w2, 30, 6, step=10, rankBy='rmse', refit=False)
    CMP('cmp-rising-arps-fails', [100.0, 104.0, 111.0, 115.0, 122.0, 128.0, 131.0, 140.0, 146.0], 5, 2, step=2, methods=['holt', 'ses'],
        note='Arps cannot fit a rising series: its row carries the refusal and is unranked')
    CMP('cmp-constant-ties', [50.0] * 10, 5, 2, methods=['damped', 'ses', 'holt'], rankBy='mae',
        note='every method forecasts the constant exactly: MAE 0 for all three ties, so the listed order stands; Arps cannot fit a flat series')
    Rc = lambda cid, args, field, msg: c.refuse(cid, 'compareWithArps', args, field, msg)
    Rc('cmp-methods-empty', {'y': w1, 'firstOrigin': 20, 'horizon': 3, 'methods': []}, 'methods', "methods must be a non-empty array of 'ses', 'holt' and 'damped'")
    Rc('cmp-methods-bad', {'y': w1, 'firstOrigin': 20, 'horizon': 3, 'methods': ['ses', 'naive']}, 'methods[1]', "methods[1] must be 'ses', 'holt' or 'damped'")
    Rc('cmp-methods-repeat', {'y': w1, 'firstOrigin': 20, 'horizon': 3, 'methods': ['ses', 'holt', 'ses']}, 'methods[2]', 'methods[2] repeats ses')
    Rc('cmp-rankby-bad', {'y': w1, 'firstOrigin': 20, 'horizon': 3, 'rankBy': 'r2'}, 'rankBy', "rankBy must be 'mae', 'rmse', 'mape', 'smape' or 'mase'")
    Rc('cmp-arps-model-bad', {'y': w1, 'firstOrigin': 20, 'horizon': 3, 'arpsModel': 'Duong'}, 'arpsModel', "arpsModel must be 'Auto-Select', 'Exponential', 'Harmonic' or 'Hyperbolic'")
    Rc('cmp-first-too-small', {'y': w1, 'firstOrigin': 2, 'horizon': 3, 'methods': ['ses']}, 'firstOrigin',
       'firstOrigin must be a whole number from 3 to 57 (the comparison needs 3 training values; an origin above 57 leaves fewer than 3 actuals)')
    Rc('cmp-refit-string', {'y': w1, 'firstOrigin': 20, 'horizon': 3, 'refit': 1}, 'refit', 'refit must be true or false')
    Rc('cmp-y-nan', {'y': [1, 2, 'x'], 'firstOrigin': 20, 'horizon': 3}, 'y[2]', 'y[2] must be a finite number: fill or drop missing values first')
    return c, E


def main():
    c, E = build()
    out = {
        'module': 'forecast',
        'generatedBy': 'tools/validation/dataai/oracle_forecast.py',
        'tolerance': {'absoluteFloor': 1e-12, 'note': 'relative tolerance per case in `tol`; `abs` per case overrides the absolute floor; `fieldTol` sets {rel, abs} per top-level field (estimated parameters: the engine and the oracle find the same minimum by different searches)'},
        'description': 'Production forecasting: simple exponential smoothing, Holt linear trend, damped trend with the first-observation initialisation, the fitted parameters, h-step forecasts, rolling-origin backtests, MAE/RMSE/MAPE/sMAPE/MASE, residual bootstrap percentiles and the Arps baseline from engines/dca. NIST/SEMATECH 6.4.3 examples are the published anchors; the Ekene synthetic production is ours.',
        'sources': {
            'nist': 'NIST/SEMATECH e-Handbook of Statistical Methods, sections 6.4.3.1, 6.4.3.2, 6.4.3.4 (https://www.itl.nist.gov/div898/handbook/pmc/section4/pmc43.htm), read 2026-09-24',
            'fpp3': 'Hyndman, R. J. and Athanasopoulos, G. (2021) Forecasting: Principles and Practice, 3rd ed., OTexts, sections 5.5, 5.8, 8.1, 8.2',
            'damped': 'Gardner, E. S. and McKenzie, E. (1985) Forecasting trends in time series. Management Science 31(10):1237-1246',
            'mase': 'Hyndman, R. J. and Koehler, A. B. (2006) Another look at measures of forecast accuracy. International Journal of Forecasting 22(4):679-688',
        },
        'ekene': E,
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
