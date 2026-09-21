#!/usr/bin/env python3
"""Independent oracle for lib/gridding/kriging.js (Mapping & Surface
Studio MS5, 2026-09-06). Stdlib only; written from the textbook
ordinary-kriging equations, never from the JS kernel.

Ordinary kriging at x0 with covariance C(h) = sill - gamma(h):
    [C_ij  1] [w ]   [C_i0]
    [1^T   0] [mu] = [ 1  ]
    z*(x0) = sum w_i z_i,  var(x0) = C(0) - sum w_i C_i0 - mu

Variograms (practical range a):
    spherical    gamma = n + (s-n) (1.5 u - 0.5 u^3), u = h/a, = s past a
    exponential  gamma = n + (s-n) (1 - exp(-3 h / a))
    gaussian     gamma = n + (s-n) (1 - exp(-3 h^2 / a^2))

Self-asserted anchors (fail loudly at generation):
  A1 exactness: with nugget 0 every model returns the datum at a data
     point with zero variance.
  A2 unbiasedness: the weights sum to one at every target.
  A3 plane: ordinary kriging reproduces a CONSTANT exactly (weights sum
     to one) but not a dipping plane; with the least-squares plane
     removed first (`detrend`) six points on z = 100 - 0.02 x + 0.05 y
     come back as the plane at every target to 1e-9, and the plain OK
     value is recorded as a golden without an exactness claim.
  A4 variance grows with distance from the data.
  A5 experimental variogram on a 5x5 unit lattice: bin pair counts are
     combinatorial (lag 1: 40, sqrt2 in the lag-1 bin too when lag=1
     with 0.5 rounding, so lag 1.0 gives 40 axial + 32 diagonal = 72,
     the case records the count the definition implies) and gamma of
     the plane z = x + 2y on that lattice is analytic per pair.

Run:  python3 tools/validation/mapping/oracle_kriging.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "mapping", "goldens"))


def gamma(h, model, a, s, n):
    if h <= 0:
        return 0.0
    if model == "spherical":
        if h >= a:
            return s
        u = h / a
        return n + (s - n) * (1.5 * u - 0.5 * u ** 3)
    if model == "exponential":
        return n + (s - n) * (1.0 - math.exp(-3.0 * h / a))
    if model == "gaussian":
        return n + (s - n) * (1.0 - math.exp(-3.0 * h * h / (a * a)))
    raise ValueError(model)


def cov(h, model, a, s, n):
    return s - gamma(h, model, a, s, n)


def solve(A, b):
    """Gauss-Jordan with partial pivoting, plain lists."""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-14:
            raise ValueError("singular")
        M[col], M[piv] = M[piv], M[col]
        p = M[col][col]
        M[col] = [v / p for v in M[col]]
        for r in range(n):
            if r != col and M[r][col] != 0.0:
                f = M[r][col]
                M[r] = [rv - f * cv for rv, cv in zip(M[r], M[col])]
    return [M[i][n] for i in range(n)]


def ok(points, target, model, a, s, n):
    m = len(points)
    A = [[cov(math.hypot(p["x"] - q["x"], p["y"] - q["y"]), model, a, s, n) for q in points] + [1.0] for p in points]
    A.append([1.0] * m + [0.0])
    c0 = [cov(math.hypot(p["x"] - target[0], p["y"] - target[1]), model, a, s, n) for p in points]
    sol = solve(A, c0 + [1.0])
    w, mu = sol[:m], sol[m]
    value = sum(wi * p["z"] for wi, p in zip(w, points))
    var = cov(0.0, model, a, s, n) - sum(wi * ci for wi, ci in zip(w, c0)) - mu
    return value, max(0.0, var), w


def fit_plane(points):
    n = len(points)
    sx = sum(p["x"] for p in points); sy = sum(p["y"] for p in points)
    sxx = sum(p["x"] ** 2 for p in points); syy = sum(p["y"] ** 2 for p in points)
    sxy = sum(p["x"] * p["y"] for p in points)
    sz = sum(p["z"] for p in points); sxz = sum(p["x"] * p["z"] for p in points); syz = sum(p["y"] * p["z"] for p in points)
    return solve([[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], [sz, sxz, syz])


def experimental(points, lag, n_lags):
    bins = {}
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            p, q = points[i], points[j]
            h = math.hypot(p["x"] - q["x"], p["y"] - q["y"])
            if h <= 0 or h >= (n_lags + 0.5) * lag:
                continue
            k = int(math.floor(h / lag + 0.5))
            if k < 1 or k > n_lags:
                continue
            d = p["z"] - q["z"]
            b = bins.setdefault(k, {"sq": 0.0, "h": 0.0, "n": 0})
            b["sq"] += d * d
            b["h"] += h
            b["n"] += 1
    return [{"lagCentre": k * lag, "h": b["h"] / b["n"], "gamma": b["sq"] / (2 * b["n"]), "pairs": b["n"]}
            for k, b in sorted(bins.items())]


def main():
    cases = []

    # --- A1/A2/A4: five points, every model -------------------------
    five = [{"x": 0.0, "y": 0.0, "z": 1.0}, {"x": 10.0, "y": 0.0, "z": 2.0},
            {"x": 0.0, "y": 10.0, "z": 3.0}, {"x": 10.0, "y": 10.0, "z": 4.0},
            {"x": 5.0, "y": 5.0, "z": 2.5}]
    targets = [[0.0, 0.0], [5.0, 5.0], [2.0, 3.0], [7.5, 1.0], [12.0, 12.0], [20.0, 20.0]]
    for model in ("spherical", "exponential", "gaussian"):
        for nugget in (0.0, 0.2):
            a, s = 20.0, 1.0
            vals, vars_, weights = [], [], []
            for t in targets:
                v, var, w = ok(five, t, model, a, s, nugget)
                assert abs(sum(w) - 1.0) < 1e-10, "A2 weights sum to one"
                vals.append(v)
                vars_.append(var)
                weights.append(w)
            if nugget == 0.0:
                assert abs(vals[0] - 1.0) < 1e-10 and vars_[0] < 1e-10, "A1 exact at datum"
                assert abs(vals[1] - 2.5) < 1e-10, "A1 exact at centre datum"
            assert vars_[4] < vars_[5], "A4 variance grows away from the data"
            cases.append({
                "name": f"five_{model}_n{nugget:g}", "kind": "points",
                "points": five, "targets": targets,
                "params": {"model": model, "range": a, "sill": s, "nugget": nugget},
                "expected": {"values": vals, "variances": vars_, "weights": weights},
            })

    # --- A3: plane -------------------------------------------------------
    plane = lambda x, y: 100.0 - 0.02 * x + 0.05 * y  # noqa: E731
    pxy = [(0, 0), (1000, 0), (0, 1000), (1000, 1000), (500, 500), (250, 750)]
    ppts = [{"x": float(x), "y": float(y), "z": plane(x, y)} for x, y in pxy]
    ptargets = [[400.0, 300.0], [600.0, 700.0], [300.0, 500.0], [500.0, 250.0]]
    pvals = []
    for t in ptargets:
        v, var, w = ok(ppts, t, "gaussian", 5000.0, 10.0, 0.0)
        pvals.append(v)
    cases.append({
        "name": "plane_gaussian_ok", "kind": "points", "points": ppts, "targets": ptargets,
        "params": {"model": "gaussian", "range": 5000.0, "sill": 10.0, "nugget": 0.0},
        "expected": {"values": pvals},
    })
    # detrended: residuals are identically zero, so OK returns the plane
    lsq = fit_plane(ppts)
    assert all(abs(p["z"] - (lsq[0] + lsq[1] * p["x"] + lsq[2] * p["y"])) < 1e-9 for p in ppts)
    cases.append({
        "name": "plane_gaussian_detrend", "kind": "points", "points": ppts, "targets": ptargets,
        "params": {"model": "gaussian", "range": 5000.0, "sill": 10.0, "nugget": 0.0, "detrend": True},
        "expected": {"values": [plane(*t) for t in ptargets], "plane": {"a": lsq[0], "b": lsq[1], "c": lsq[2]}},
    })
    # constant field: plain OK is exact
    cpts = [{"x": p["x"], "y": p["y"], "z": 42.0} for p in ppts]
    for t in ptargets:
        v, var, w = ok(cpts, t, "spherical", 800.0, 4.0, 1.0)
        assert abs(v - 42.0) < 1e-9, "constant reproduced"
    cases.append({
        "name": "constant_ok", "kind": "points", "points": cpts, "targets": ptargets,
        "params": {"model": "spherical", "range": 800.0, "sill": 4.0, "nugget": 1.0},
        "expected": {"values": [42.0] * len(ptargets)},
    })

    # --- A5: experimental variogram on a 5x5 lattice --------------------
    lat = [{"x": float(i), "y": float(j), "z": float(i + 2 * j)} for j in range(5) for i in range(5)]
    ev = experimental(lat, 1.0, 5)
    # lag-1 bin (0.5 <= h < 1.5): 40 axial pairs at h=1 and 32 diagonal at
    # h=sqrt2 -> 72 pairs; gamma is the analytic pair mean of (dx+2dy)^2/2
    assert ev[0]["pairs"] == 72, ev[0]
    axial = 20 * (1.0 ** 2) + 20 * (2.0 ** 2)          # 20 pairs dx=1, 20 pairs dy=1
    diag = 16 * (1.0 + 2.0) ** 2 + 16 * (1.0 - 2.0) ** 2  # 16 pairs each diagonal
    assert abs(ev[0]["gamma"] - (axial + diag) / (2 * 72)) < 1e-12, ev[0]
    cases.append({"name": "lattice_variogram", "kind": "variogram", "points": lat,
                  "lag": 1.0, "nLags": 5, "expected": ev})

    out = {"generated_by": "tools/validation/mapping/oracle_kriging.py",
           "tolerance": 1e-9, "cases": cases}
    os.makedirs(GOLD, exist_ok=True)
    path = os.path.join(GOLD, "kriging_cases.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    main()
