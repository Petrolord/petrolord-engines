"""Independent oracle for engines/rockphysics/elasticSet.js (QI programme Q1, A2).

From the published definitions: Goodway, Chen and Downton (1997) LMR;
Connolly (1999) EI, normalised as in Whitcombe (2002); Whitcombe, Connolly,
Reagan and Redshaw (2002) EEI; ordinary least squares with the textbook
prediction interval (e.g. Montgomery, Peck and Vining, Introduction to Linear
Regression Analysis, 3.5). Standard library only. The Student t quantile is
computed by bisection on a series form of the t CDF, and checked against the
published table values (A6) before goldens are written.

main() asserts anchors E1..E7, then writes goldens.elastic.json.
"""
import json
import math
import os
import random


def elastic(vp, vs, rho):
    ai, si = vp * rho, vs * rho
    mu = rho * vs * vs
    k = rho * (vp * vp - 4.0 / 3.0 * vs * vs)
    return dict(ai=ai, si=si, vpvs=vp / vs, pr=(vp * vp - 2 * vs * vs) / (2 * (vp * vp - vs * vs)),
                k=k, mu=mu, lam=k - 2.0 / 3.0 * mu, lambdaRho=ai * ai - 2 * si * si, muRho=si * si)


def eei(vp, vs, rho, chi, K, ref):
    c, s = math.cos(math.radians(chi)), math.sin(math.radians(chi))
    return ref[0] * ref[2] * (vp / ref[0]) ** (c + s) * (vs / ref[1]) ** (-8 * K * s) * (rho / ref[2]) ** (c - 4 * K * s)


def ei(vp, vs, rho, th, K, ref):
    s2, t2 = math.sin(math.radians(th)) ** 2, math.tan(math.radians(th)) ** 2
    return ref[0] * ref[2] * (vp / ref[0]) ** (1 + t2) * (vs / ref[1]) ** (-8 * K * s2) * (rho / ref[2]) ** (1 - 4 * K * s2)


# --- Student t: CDF by numerical integration of the density (Simpson), quantile by bisection
def t_pdf(x, df):
    return math.exp(math.lgamma((df + 1) / 2) - math.lgamma(df / 2)) / math.sqrt(df * math.pi) * (1 + x * x / df) ** (-(df + 1) / 2)


def t_cdf_upper(t, df, n=20000):
    # P(T > t) = 0.5 - integral_0^t pdf
    h = t / n
    s = t_pdf(0, df) + t_pdf(t, df)
    for i in range(1, n):
        s += (4 if i % 2 else 2) * t_pdf(i * h, df)
    return 0.5 - s * h / 3


def t_upper_quantile(q, df):
    lo, hi = 0.0, 50.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if t_cdf_upper(mid, df) > q:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                for j in range(c, n + 1):
                    M[r][j] -= f * M[c][j]
    return [M[i][n] / M[i][i] for i in range(n)]


def ols(pts, form):
    X = [[1, vp / 1000] + ([(vp / 1000) ** 2] if form == 'quadratic' else []) for vp, _ in pts]
    y = [vs for _, vs in pts]
    p = len(X[0])
    XtX = [[sum(r[i] * r[j] for r in X) for j in range(p)] for i in range(p)]
    Xty = [sum(r[i] * yy for r, yy in zip(X, y)) for i in range(p)]
    coef = solve(XtX, Xty)
    res = [yy - sum(c * v for c, v in zip(coef, r)) for r, yy in zip(X, y)]
    dof = len(pts) - p
    s = math.sqrt(sum(e * e for e in res) / dof)
    return coef, s, dof, XtX


def predict(coef, s, dof, XtX, vp, form, level):
    x = [1, vp / 1000] + ([(vp / 1000) ** 2] if form == 'quadratic' else [])
    f = sum(c * v for c, v in zip(coef, x))
    # leverage x' (X'X)^-1 x through a solve, no explicit inverse
    z = solve(XtX, x)
    lev = sum(a * b for a, b in zip(x, z))
    sig = s * math.sqrt(1 + lev)
    t = t_upper_quantile((1 - level) / 2, dof)
    return f, f - t * sig, f + t * sig, sig


def close(a, b, rel=1e-9):
    return abs(a - b) <= rel * max(abs(a), abs(b))


def dataset():
    rnd = random.Random(20261006)
    pts = []
    for _ in range(40):
        vp = rnd.uniform(2400, 4200)
        vs = 0.8042 * vp - 855.9 + rnd.gauss(0, 60)  # GC sandstone line plus scatter
        pts.append((round(vp, 3), round(vs, 3)))
    return pts


def anchors():
    vp, vs, rho = 3200.0, 1700.0, 2350.0
    e = elastic(vp, vs, rho)
    # E1 lambda rho from moduli equals AI^2 - 2 SI^2; mu rho = SI^2
    assert close(e['lam'] * rho, e['lambdaRho']) and close(e['mu'] * rho, e['muRho']), 'E1'
    ref = (3000.0, 1500.0, 2300.0)
    K = 0.25
    # E2 EEI(0) and EI(0) are AI
    assert close(eei(vp, vs, rho, 0, K, ref), vp * rho) and close(ei(vp, vs, rho, 0, K, ref), vp * rho), 'E2'
    # E3 log reflectivity of EEI is A cos chi + B sin chi exactly (two-term, same K)
    up, lo = (3000.0, 1500.0, 2300.0), (3300.0, 1800.0, 2380.0)
    A = 0.5 * (math.log(lo[0] / up[0]) + math.log(lo[2] / up[2]))
    B = 0.5 * math.log(lo[0] / up[0]) - 4 * K * math.log(lo[1] / up[1]) - 2 * K * math.log(lo[2] / up[2])
    for chi in (-60, -30, 0, 19, 45, 90):
        r = 0.5 * math.log(eei(*lo, chi, K, ref) / eei(*up, chi, K, ref))
        assert close(r, A * math.cos(math.radians(chi)) + B * math.sin(math.radians(chi)), 1e-12), 'E3'
    # E4 EI log reflectivity is A + B' with tan^2 in place of sin^2 for the Vp term
    th = 30
    r = 0.5 * math.log(ei(*lo, th, K, ref) / ei(*up, th, K, ref))
    s2, t2 = math.sin(math.radians(th)) ** 2, math.tan(math.radians(th)) ** 2
    expect = 0.5 * (1 + t2) * math.log(lo[0] / up[0]) - 4 * K * s2 * math.log(lo[1] / up[1]) + 0.5 * (1 - 4 * K * s2) * math.log(lo[2] / up[2])
    assert close(r, expect, 1e-12), 'E4'
    # E5 OLS on exact-line data recovers the line with zero residual
    pts = [(v, 0.8 * v - 800) for v in (2500, 2800, 3100, 3600, 4000, 4300)]
    coef, s, dof, _ = ols(pts, 'linear')
    assert close(coef[1], 800, 1e-9) and abs(coef[0] + 800) < 1e-6 and s < 1e-6, 'E5'
    # E6 the t quantile reproduces the published table (two-sided 90 percent, upper 0.05)
    for df, tab in ((5, 2.015), (10, 1.812), (20, 1.725), (30, 1.697)):
        assert abs(t_upper_quantile(0.05, df) - tab) < 5e-4, ('E6', df)
    # E7 the prediction interval is narrowest at the mean Vp and widens away from it
    pts = dataset()
    coef, s, dof, XtX = ols(pts, 'linear')
    mvp = sum(v for v, _ in pts) / len(pts)
    w = lambda v: predict(coef, s, dof, XtX, v, 'linear', 0.9)[3]
    assert w(mvp) < w(mvp + 500) and w(mvp) < w(mvp - 500), 'E7'


def goldens():
    out = {'elastic': [], 'eei': [], 'ei': [], 'regression': {}}
    for vp, vs, rho in ((2500.0, 1100.0, 2200.0), (3200.0, 1700.0, 2350.0), (4500.0, 2600.0, 2550.0)):
        e = elastic(vp, vs, rho)
        out['elastic'].append(dict(vp=vp, vs=vs, rho=rho, **{('lambda' if k == 'lam' else k): v for k, v in e.items()}))
    ref, K = (3000.0, 1500.0, 2300.0), 0.25
    for chi in (-90, -45, -20, 0, 12.5, 30, 60, 90):
        out['eei'].append(dict(vp=3300.0, vs=1800.0, rho=2380.0, chi=chi, K=K, ref=ref, eei=eei(3300.0, 1800.0, 2380.0, chi, K, ref)))
    for th in (0, 10, 20, 30, 45):
        out['ei'].append(dict(vp=3300.0, vs=1800.0, rho=2380.0, theta=th, K=K, ref=ref, ei=ei(3300.0, 1800.0, 2380.0, th, K, ref)))
    pts = dataset()
    for form in ('linear', 'quadratic'):
        coef, s, dof, XtX = ols(pts, form)
        preds = []
        for v in (2300.0, 3000.0, 3600.0, 4500.0):
            f, lo, hi, sig = predict(coef, s, dof, XtX, v, form, 0.9)
            preds.append(dict(vp=v, vs=f, lo=lo, hi=hi, sigma=sig))
        out['regression'][form] = dict(coef=coef, s=s, dof=dof, predictions=preds)
    out['regression']['samples'] = [dict(vp=a, vs=b) for a, b in pts]
    return out


def main():
    anchors()
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'rockphysics', 'goldens.elastic.json')
    with open(dest, 'w') as fh:
        json.dump(goldens(), fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors E1-E7 ok; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
