"""Independent oracle for engines/qi/propertyCalibration.js (QI course gate E2-B, 2026-10-11).

The engine upscales well logs to seismic scale, fits porosity on impedance
(or a Bayesian facies model), checks the calibration by leaving each well
out, and widens the porosity band by the inversion's error seen at the
left-out wells (#987). This oracle rebuilds every number by its own route,
sharing no code with the engine or with any other oracle:

- the moving-average upscale from PREFIX SUMS of the finite samples and their
  counts (the engine loops over each window); half window round-half-UP of
  1000 / (f dt) / 2 (JavaScript Math.round; Python's round() is half-even
  and would turn the 2.5 of 50 Hz at 4 ms into 2);
- the least-squares line in EXACT RATIONALS (fractions.Fraction of the float
  inputs), its residual s and r2, converted to float only at the end;
- the Student t quantile of the 80 percent prediction interval from the
  CLOSED-FORM t distribution function for integer degrees of freedom
  (Abramowitz and Stegun 26.7.3 and 26.7.4, finite trigonometric sums),
  inverted by bisection (the engine bisects the regularised incomplete beta);
- the leave-one-out check: each well's own fit without it, prediction from
  the supplied inverted impedance, pooled RMS of the OTHER wells' residuals,
  sExtra = sqrt(rms^2 - s^2) when rms > s, coverage counted against
  t sqrt(s^2 (1 + 1/n + leverage) + sExtra^2), bias, RMS and the CENTRED
  Pearson correlation in rationals (the engine uses raw sums);
- facies: class means and n - 1 covariances, the Gaussian density written out
  for one and two attributes (explicit 2 x 2 inverse and determinant; the
  engine goes through a Cholesky factor), the Gaussian kernel density with
  Scott's factor n^(-1/(d + 4)) on the data covariance (scipy.stats.gaussian_kde,
  as the engine's header cites), Bayes with the wells' proportions or equal
  priors over the facies present; the tabulated posterior the volume run reads
  (4001 points, 6 standard deviations beyond the outer classes, linear; 201 x
  201 bilinear for two attributes) is rebuilt as the specification says, and
  checked against the exact posterior;
- the mode filter on facies codes by a counter over each window, ties to the
  centre code, otherwise to the code met first.

Self-asserting anchors in main(): the t quantile against printed table values,
the rational fit reproducing an exact line, the prefix-sum average against a
direct one, the KDE density integrating to one, posteriors summing to one.
Coverage counts and the most likely facies are asserted to sit away from their
edges (margins printed), so float noise cannot flip a golden count.
Standard library only; writes test-data/qi/goldens.propertyCalibration.json
byte-identically on every run.
"""
import json
import math
import os
from fractions import Fraction


# ---- data -------------------------------------------------------------------

class Lcg:
    def __init__(self, seed):
        self.s = seed

    def u(self):
        self.s = (self.s * 1103515245 + 12345) % 2147483648
        return self.s / 2147483648 - 0.5


def r10(v):
    return float('%.10g' % v)


def make_wells(seed, ns, with_gap=True):
    g = Lcg(seed)
    wells = []
    for k, (name, shift) in enumerate((('A', 0), ('B', 17), ('C', 41), ('D', 63))):
        ai = [7000 + 1200 * math.sin((i + shift) / 9) + 300 * math.sin((i + shift) / 2.3) + 60 * g.u() for i in range(ns)]
        phi = [0.40 - 3.5e-5 * v + 0.006 * g.u() for v in ai]
        vpvs = [1.55 + 6.0e-5 * (v - 6000) + 0.03 * g.u() for v in ai]
        fac = [1 if v < 6300 else (2 if v < 7400 else 3) for v in ai]
        ln_ai = [r10(math.log(v)) for v in ai]
        if with_gap and k == 1:
            for i in range(50, 54):
                ln_ai[i] = None
        target = [r10(v) for v in phi]
        if k == 2:
            target[5] = None
        wells.append({'name': name, 'il': k, 'xl': 0, 'ln_ai': ln_ai, 'target': target,
                      'vpvs': [r10(v) for v in vpvs], 'facies': fac})
    return wells


# ---- maths ------------------------------------------------------------------

def fin(v):
    return v is not None and isinstance(v, (int, float)) and math.isfinite(v)


def half_window(hz, dt):
    x = 1000 / (hz * dt) / 2
    return max(1, int(math.floor(x + 0.5)))


def moving_average(values, half):
    n = len(values)
    ps = [0.0] * (n + 1)
    pc = [0] * (n + 1)
    for i, v in enumerate(values):
        ps[i + 1] = ps[i] + (v if fin(v) else 0.0)
        pc[i + 1] = pc[i] + (1 if fin(v) else 0)
    out = []
    for i, v in enumerate(values):
        if not fin(v):
            out.append(None)
            continue
        lo, hi = max(0, i - half), min(n - 1, i + half)
        c = pc[hi + 1] - pc[lo]
        out.append((ps[hi + 1] - ps[lo]) / c)
    return out


def mode_filter(codes, half):
    n = len(codes)
    out = []
    for i in range(n):
        seen = []
        counts = {}
        for j in range(max(0, i - half), min(n - 1, i + half) + 1):
            c = codes[j]
            if fin(c) and c > 0:
                if c not in counts:
                    seen.append(c)
                    counts[c] = 0
                counts[c] += 1
        if not counts:
            out.append(None)
            continue
        c0 = codes[i]
        top = max(counts.values())
        if fin(c0) and c0 > 0 and counts.get(c0, 0) == top:
            out.append(c0)
        else:
            out.append(next(c for c in seen if counts[c] == top))
    return out


def t_cdf_central(t, nu):
    """A(t | nu) = P(|T| < t), Abramowitz and Stegun 26.7.3 (odd nu) and 26.7.4 (even nu)."""
    th = math.atan(t / math.sqrt(nu))
    c2 = math.cos(th) ** 2
    s = math.sin(th)
    if nu % 2 == 0:
        term, tot = 1.0, 1.0
        for k in range(1, nu // 2):
            term *= c2 * (2 * k - 1) / (2 * k)
            tot += term
        return s * tot
    if nu == 1:
        return 2 * th / math.pi
    term, tot = 1.0, 1.0
    for k in range(1, (nu - 1) // 2):
        term *= c2 * (2 * k) / (2 * k + 1)
        tot += term
    return 2 / math.pi * (th + s * math.cos(th) * tot)


def t_quantile(level, nu):
    lo, hi = 0.0, 100.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if t_cdf_central(mid, nu) < level:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def ols(xs, ys):
    X = [Fraction(v) for v in xs]
    Y = [Fraction(v) for v in ys]
    n = len(X)
    assert n >= 3
    mx = sum(X) / n
    my = sum(Y) / n
    sxx = sum((x - mx) ** 2 for x in X)
    sxy = sum((x - mx) * (y - my) for x, y in zip(X, Y))
    syy = sum((y - my) ** 2 for y in Y)
    b = sxy / sxx
    a = my - b * mx
    sse = sum((y - a - b * x) ** 2 for x, y in zip(X, Y))
    return {'a': float(a), 'b': float(b), 'n': n, 'xMean': float(mx), 'sxx': float(sxx),
            's': math.sqrt(float(sse / (n - 2))), 'r2': float(1 - sse / syy)}


def predict(fit, ai, s_extra=0.0):
    t = t_quantile(0.8, fit['n'] - 2)
    out = []
    for x in ai:
        if not fin(x):
            out.append((None, None, None))
            continue
        y = fit['a'] + fit['b'] * x
        h = t * math.sqrt(fit['s'] ** 2 * (1 + 1 / fit['n'] + (x - fit['xMean']) ** 2 / fit['sxx']) + s_extra ** 2)
        out.append((y - h, y, y + h))
    return out


def in_window(k, dt, w):
    return w is None or (w[0] <= k * dt <= w[1])


def upscale(pr, dt):
    half = half_window(pr.get('upscaleHz', 50), dt)
    up = []
    for w in pr['wells']:
        ln = moving_average(w['ln_ai'], half)
        if pr['kind'] == 'facies':
            target = mode_filter(w['target'], half)
        else:
            target = moving_average(w['target'], half)
        vpvs = moving_average(w['vpvs'], half) if pr.get('attributes') == 'ai_vpvs' else None
        up.append({'name': w['name'], 'ai': [math.exp(v) if fin(v) else None for v in ln], 'target': target, 'vpvs': vpvs})
    return up


def samples(up, pr, dt, exclude=None):
    xs, ys, fac = [], [], []
    for w in up:
        if w['name'] == exclude:
            continue
        for k in range(len(w['ai'])):
            if not in_window(k, dt, pr.get('window_ms')) or not fin(w['ai'][k]) or not fin(w['target'][k]):
                continue
            if pr['kind'] == 'facies':
                name = pr['names'].get(str(int(w['target'][k])))
                if name is None:
                    continue
                if w['vpvs'] is not None:
                    if not fin(w['vpvs'][k]):
                        continue
                    fac.append((name, [w['ai'][k], w['vpvs'][k]]))
                else:
                    fac.append((name, [w['ai'][k]]))
            else:
                xs.append(w['ai'][k])
                ys.append(w['target'][k])
    return xs, ys, fac


def mean_cov(rows):
    n, d = len(rows), len(rows[0])
    m = [sum(r[j] for r in rows) / n for j in range(d)]
    cov = [[sum((r[i] - m[i]) * (r[j] - m[j]) for r in rows) / (n - 1) for j in range(d)] for i in range(d)]
    return m, cov


def log_gauss(x, m, cov):
    if len(x) == 1:
        v = cov[0][0]
        return -0.5 * (x[0] - m[0]) ** 2 / v - 0.5 * math.log(2 * math.pi * v)
    a, b, c, d = cov[0][0], cov[0][1], cov[1][0], cov[1][1]
    det = a * d - b * c
    dx, dy = x[0] - m[0], x[1] - m[1]
    q = (d * dx * dx - (b + c) * dx * dy + a * dy * dy) / det
    return -0.5 * q - 0.5 * math.log(det) - math.log(2 * math.pi)


def fit_facies(fac, kind, priors):
    order, groups = [], {}
    for name, x in fac:
        if name not in groups:
            order.append(name)
            groups[name] = []
        groups[name].append(x)
    total = len(fac)
    classes = []
    for name in order:
        rows = groups[name]
        m, cov = mean_cov(rows)
        c = {'name': name, 'n': len(rows), 'prior': len(rows) / total, 'mean': m, 'cov': cov}
        if kind == 'kde':
            f = len(rows) ** (-1 / (len(m) + 4))
            c['points'] = rows
            c['kcov'] = [[v * f * f for v in r] for r in cov]
        classes.append(c)
    if priors == 'equal':
        for c in classes:
            c['prior'] = 1 / len(classes)
    return {'kind': kind, 'dims': len(fac[0][1]), 'classes': classes}


def class_log_density(c, x, kind):
    if kind == 'kde':
        ls = [log_gauss(x, p, c['kcov']) for p in c['points']]
        mx = max(ls)
        return mx + math.log(sum(math.exp(v - mx) for v in ls)) - math.log(len(ls))
    return log_gauss(x, c['mean'], c['cov'])


def posterior(model, x):
    lp = [math.log(c['prior']) + class_log_density(c, x, model['kind']) for c in model['classes']]
    mx = max(lp)
    w = [math.exp(v - mx) for v in lp]
    s = sum(w)
    return [v / s for v in w]


def table_1d(model):
    lo = min(c['mean'][0] - 6 * math.sqrt(c['cov'][0][0]) for c in model['classes'])
    hi = max(c['mean'][0] + 6 * math.sqrt(c['cov'][0][0]) for c in model['classes'])
    N = 4001
    step = (hi - lo) / (N - 1)
    grid = [posterior(model, [lo + i * step]) for i in range(N)]

    def read(x):
        t = min(N - 1, max(0.0, (x - lo) / step))
        i = min(N - 2, int(math.floor(t)))
        f = t - i
        return [p + f * (grid[i + 1][j] - p) for j, p in enumerate(grid[i])]
    return read


def table_2d(model):
    N = 201
    lims = []
    for d in (0, 1):
        lo = min(c['mean'][d] - 6 * math.sqrt(c['cov'][d][d]) for c in model['classes'])
        hi = max(c['mean'][d] + 6 * math.sqrt(c['cov'][d][d]) for c in model['classes'])
        lims.append((lo, (hi - lo) / (N - 1)))
    grid = [[posterior(model, [lims[0][0] + i * lims[0][1], lims[1][0] + j * lims[1][1]]) for j in range(N)] for i in range(N)]

    def read(x, y):
        u = min(N - 1, max(0.0, (x - lims[0][0]) / lims[0][1]))
        v = min(N - 1, max(0.0, (y - lims[1][0]) / lims[1][1]))
        i = min(N - 2, int(math.floor(u)))
        j = min(N - 2, int(math.floor(v)))
        fu, fv = u - i, v - j
        return [(1 - fu) * (1 - fv) * grid[i][j][c] + fu * (1 - fv) * grid[i + 1][j][c]
                + (1 - fu) * fv * grid[i][j + 1][c] + fu * fv * grid[i + 1][j + 1][c] for c in range(len(model['classes']))]
    return read


MARGINS = {'coverage': math.inf, 'facies': math.inf}


def predict_facies(model, pr, ai, vpvs):
    code_of = {name: int(c) for c, name in pr['names'].items()}
    read = table_2d(model) if model['dims'] == 2 else table_1d(model)
    probs, best = [], []
    for k, x in enumerate(ai):
        if not fin(x) or (model['dims'] == 2 and not fin(vpvs[k])):
            probs.append(None)
            best.append(None)
            continue
        p = read(x, vpvs[k]) if model['dims'] == 2 else read(x)
        b = max(range(len(p)), key=lambda j: (p[j], -j))
        srt = sorted(p, reverse=True)
        MARGINS['facies'] = min(MARGINS['facies'], srt[0] - srt[1])
        probs.append(p)
        best.append(code_of[model['classes'][b]['name']])
    return probs, best


def pearson(a, b):
    A = [Fraction(v) for v in a]
    B = [Fraction(v) for v in b]
    n = len(A)
    ma, mb = sum(A) / n, sum(B) / n
    sab = sum((x - ma) * (y - mb) for x, y in zip(A, B))
    saa = sum((x - ma) ** 2 for x in A)
    sbb = sum((y - mb) ** 2 for y in B)
    if saa == 0 or sbb == 0:
        return None
    return float(sab) / math.sqrt(float(saa) * float(sbb))


def calibrate(pr, ai_traces, vpvs_traces, dt):
    up = upscale(pr, dt)
    if pr['kind'] == 'facies':
        _, _, fac = samples(up, pr, dt)
        allm = fit_facies(fac, pr.get('density', 'gaussian'), pr.get('priors'))
        rows = []
        for k, w in enumerate(up):
            _, _, f2 = samples(up, pr, dt, w['name'])
            m = fit_facies(f2, pr.get('density', 'gaussian'), pr.get('priors'))
            _, best = predict_facies(m, pr, ai_traces[k], vpvs_traces[k] if vpvs_traces else None)
            known = [i for i in range(len(w['target'])) if in_window(i, dt, pr.get('window_ms')) and fin(w['target'][i])
                     and best[i] is not None and str(int(w['target'][i])) in pr['names']]
            ok = sum(1 for i in known if best[i] == w['target'][i])
            rows.append({'name': w['name'], 'n': len(known), 'accuracy': ok / len(known) if known else None})
        classes = []
        for c in allm['classes']:
            e = {'name': c['name'], 'n': c['n'], 'prior': c['prior'], 'mean': c['mean'][0], 'sd': math.sqrt(c['cov'][0][0])}
            if allm['dims'] == 2:
                e['meanVpVs'] = c['mean'][1]
                e['sdVpVs'] = math.sqrt(c['cov'][1][1])
            classes.append(e)
        return {'summary': {'classes': classes, 'density': allm['kind'], 'attributes': 'ai_vpvs' if allm['dims'] == 2 else 'ai'}, 'rows': rows}
    xs, ys, _ = samples(up, pr, dt)
    allf = ols(xs, ys)
    left = []
    for k, w in enumerate(up):
        x2, y2, _ = samples(up, pr, dt, w['name'])
        f = ols(x2, y2)
        q = predict(f, ai_traces[k])
        idx = [i for i in range(len(w['target'])) if in_window(i, dt, pr.get('window_ms')) and fin(w['target'][i]) and q[i][2] is not None]
        left.append((w, k, f, idx, [q[i][1] - w['target'][i] for i in idx]))

    def pooled(skip):
        vals = [v for j, L in enumerate(left) if j != skip for v in L[4]]
        if len(vals) < 5:
            return None
        return math.sqrt(float(sum(Fraction(v) ** 2 for v in vals) / len(vals)))

    def extra(rms, s):
        return math.sqrt(rms * rms - s * s) if rms is not None and rms > s else 0.0

    rows = []
    for j, (w, k, f, idx, _) in enumerate(left):
        se = extra(pooled(j), f['s'])
        q = predict(f, ai_traces[k], se)
        ys2 = [w['target'][i] for i in idx]
        qs = [q[i][1] for i in idx]
        inside = 0
        for i in idx:
            y = w['target'][i]
            MARGINS['coverage'] = min(MARGINS['coverage'], abs(y - q[i][0]), abs(y - q[i][2]))
            if q[i][0] <= y <= q[i][2]:
                inside += 1
        n = len(idx)
        d = [Fraction(a) - Fraction(b) for a, b in zip(qs, ys2)]
        rows.append({'name': w['name'], 'n': n, 'rms': math.sqrt(float(sum(v * v for v in d) / n)), 'bias': float(sum(d) / n),
                     'corr': pearson(qs, ys2), 'coverage': inside / n})
    s_loo = pooled(-1)
    s_extra = extra(s_loo, allf['s'])
    summary = {'a': allf['a'], 'b': allf['b'], 'r2': allf['r2'], 'n': allf['n'], 's': allf['s'], 'sLoo': s_loo, 'sExtra': s_extra}
    return {'summary': summary, 'rows': rows, 'model': dict(allf, sExtra=s_extra)}


# ---- anchors ----------------------------------------------------------------

def anchors():
    # t quantiles of the 80 percent central interval (upper 10 percent points), printed tables
    for nu, t in ((1, 3.078), (2, 1.886), (5, 1.476), (10, 1.372), (30, 1.310), (120, 1.289)):
        assert abs(t_quantile(0.8, nu) - t) < 6e-4, (nu, t_quantile(0.8, nu))
    assert abs(t_quantile(0.8, 1) - math.tan(0.4 * math.pi)) < 1e-12  # Cauchy, exact
    assert abs(t_quantile(0.8, 2) - 0.8 / math.sqrt(0.18)) < 1e-12    # nu = 2: t = 2q' / sqrt(2 (1 - q'^2)) form
    z = 1.2815515655446004  # the normal point; Cornish-Fisher: t = z + (z^3 + z) / (4 nu) + O(nu^-2)
    assert abs(t_quantile(0.8, 4000) - (z + (z ** 3 + z) / 16000)) < 1e-6
    # rational OLS reproduces an exact line, with zero residual
    f = ols([1.0, 2.0, 3.0, 4.0], [0.5, 0.25, 0.0, -0.25])
    assert f['a'] == 0.75 and f['b'] == -0.25 and f['s'] == 0.0
    # prefix-sum average equals the direct one, gaps kept
    v = [1.0, 2.0, None, 4.0, 8.0, 16.0]
    ma = moving_average(v, 1)
    assert ma[2] is None and ma[0] == 1.5 and ma[1] == 1.5 and ma[3] == 6.0 and abs(ma[4] - 28 / 3) < 1e-15
    assert half_window(50, 4) == 3 and half_window(8, 4) == 16
    # mode filter: majority, centre wins a tie, code 0 is no facies
    assert mode_filter([1, 1, 2, 1, 1], 1) == [1, 1, 1, 1, 1]
    assert mode_filter([2, 1, 2, 1], 1) == [2, 2, 1, 1]
    assert mode_filter([0, 0, 0], 1) == [None, None, None]
    # a 1D KDE integrates to one
    c = {'points': [[0.0], [1.0], [3.0]], 'kcov': [[0.4]]}
    integ = sum(math.exp(class_log_density(c, [-10 + i * 0.001], 'kde')) for i in range(23001)) * 0.001
    assert abs(integ - 1) < 1e-9


# ---- cases ------------------------------------------------------------------

def plain(x):
    if isinstance(x, float) and not math.isfinite(x):
        return None
    if isinstance(x, dict):
        return {k: plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [plain(v) for v in x]
    return x


def main():
    anchors()
    dt, ns = 4, 160
    out = {'dtMs': dt, 'porosity': [], 'facies': [], 'modeFilter': [], 'upscale': None, 'tables': []}
    wells = make_wells(3, ns)
    pr0 = {'kind': 'porosity', 'wells': wells, 'upscaleHz': 50, 'window_ms': [40, 600]}
    up0 = upscale(pr0, dt)
    out['upscale'] = {'pr': pr0, 'wells': [{'name': w['name'], 'ai': w['ai'], 'target': w['target']} for w in up0]}
    g = Lcg(11)
    noisy = [[r10(v * (1 + 0.2 * g.u())) if fin(v) else None for v in w['ai']] for w in up0]
    clean = [[r10(v) if fin(v) else None for v in w['ai']] for w in up0]
    biased = [[r10(1.1 * v) if fin(v) else None for v in w['ai']] for w in up0]
    for name, traces in (('noisy inverted impedance (the band widens)', noisy),
                         ('true impedance at the wells (the band barely widens)', clean),
                         ('impedance 10 percent high (a shift)', biased)):
        res = calibrate(pr0, traces, None, dt)
        probe = [5600.0, 7000.0, 9100.0, None, 1e30]
        q = predict(res['model'], [v if v != 1e30 else None for v in probe], res['model']['sExtra'])
        out['porosity'].append({'name': name, 'pr': pr0, 'aiTraces': traces, 'summary': res['summary'], 'rows': res['rows'],
                                'probe': probe, 'probeQ': [list(v) for v in q]})
    assert len(out['porosity']) == 3
    names = {'1': 'gas sand', '2': 'brine sand', '3': 'shale'}
    fwells = [dict(w, target=w['facies']) for w in make_wells(5, ns, with_gap=False)]
    for w in fwells:  # a few unnamed and zero codes, and a gap
        w['target'] = list(w['target'])
        w['target'][7] = 0
        w['target'][9] = 9
        w['target'][11] = None
    fup = upscale({'kind': 'facies', 'wells': fwells, 'upscaleHz': 50}, dt)
    g2 = Lcg(23)
    fai = [[r10(v * (1 + 0.03 * g2.u())) if fin(v) else None for v in w['ai']] for w in fup]
    fv = [[r10(v * (1 + 0.01 * g2.u())) for v in moving_average(w['vpvs'], half_window(50, dt))] for w in fwells]
    for label, extra in (('gaussian, priors from the wells', {'density': 'gaussian', 'priors': 'wells'}),
                         ('kde, equal priors, a shorter window', {'density': 'kde', 'priors': 'equal', 'window_ms': [40, 240]}),
                         ('gaussian, AI and Vp/Vs', {'density': 'gaussian', 'priors': 'wells', 'attributes': 'ai_vpvs'})):
        pr = dict({'kind': 'facies', 'wells': fwells, 'names': names, 'upscaleHz': 50, 'window_ms': [40, 600]}, **extra)  # extra may narrow the window
        vt = fv if extra.get('attributes') else None
        res = calibrate(pr, fai, vt, dt)
        # the volume path on one trace with the full model
        up = upscale(pr, dt)
        _, _, fac = samples(up, pr, dt)
        m = fit_facies(fac, pr['density'], pr['priors'])
        probs, best = predict_facies(m, pr, fai[1], vt[1] if vt else None)
        exact = [posterior(m, [fai[1][k]] + ([vt[1][k]] if vt else [])) if probs[k] is not None else None for k in range(len(probs))]
        tol = max(abs(a - b) for p, e in zip(probs, exact) if p is not None for a, b in zip(p, e))
        out['facies'].append({'name': label, 'pr': pr, 'aiTraces': fai, 'vpvsTraces': vt, 'summary': res['summary'], 'rows': res['rows'],
                              'trace': {'k': 1, 'probs': probs, 'best': best}, 'tableVsExactMax': tol})
        assert tol < 5e-3, (label, tol)
    assert len(out['facies']) == 3
    for codes, half in (([1, 1, 2, 1, 1], 1), ([2, 1, 2, 1], 1), ([0, 0, 0], 1), ([3, None, 2, 2, 3, 0, 1, 1, 1, 3], 2), (fwells[0]['target'][:40], 3)):
        out['modeFilter'].append({'codes': codes, 'half': half, 'out': mode_filter(codes, half)})
    assert out['modeFilter']
    assert MARGINS['coverage'] > 1e-7, MARGINS
    assert MARGINS['facies'] > 1e-7, MARGINS
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'qi', 'goldens.propertyCalibration.json')
    with open(dest, 'w') as fh:
        json.dump(plain(out), fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok; margins', MARGINS, '; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
