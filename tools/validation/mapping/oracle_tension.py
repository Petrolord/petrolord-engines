#!/usr/bin/env python3
"""Independent oracle for lib/gridding/tensionSpline.js (Mapping T1,
2026-09-26). Stdlib only; never from the JS.

Spline in tension (Wessel & Bercovici 1998; Mitasova & Mitas 1993):

  z(x) = a0 + (ax (x - cx) + ay (y - cy)) / L + sum_i w_i g(|x - x_i|)
  sum w_i = sum w_i (x_i - cx) = sum w_i (y_i - cy) = 0
  g(r) = K0(p r) + ln(p r),  p = (T / (1 - T)) / L,  g(0) = ln 2 - gamma
  smoothing s on the Green diagonal with sign -s (tension kernel) or +s
  (biharmonic kernel (r/L)^2 ln(r/L), used when T = 0 and s > 0)
  L = median nearest-neighbour spacing, (cx, cy) the centroid.

K0 is NOT taken from a polynomial fit here: for x >= 0.5 it is the
integral K0(x) = int_0^inf exp(-x cosh t) dt by composite Simpson on
[0, t_max] (x cosh t_max = 60, 4,000 panels); below 0.5, where K0 + ln x
cancels, g comes from the ascending series summed with math.fsum, and the
two are asserted to agree to 1e-12 on [0.5, 2]. (The JS switches at 2 and
uses a polynomial above it: different splits, different methods.) The (n+3) x (n+3) system is solved
by Gauss-Jordan elimination with partial pivoting.

Self-asserted anchors (fail loudly at generation):
  A1 K0 at x = 0.1, 1, 3, 10 matches Abramowitz & Stegun Table 9.8
     (K0(1) = 0.4210244382, K0(3) = 0.03473950439, K0(0.1) = 2.427069025,
     K0(10) = 1.778006232e-5) to 1e-9 relative.
  A2 plane: data on z = 100 - 0.02 x + 0.05 y come back exactly (1e-9)
     at off-data targets for T = 0.2, 0.5, 0.9 (the affine part carries
     it, every w_i = 0).
  A3 thin-plate limit: as T falls through 4e-3, 2e-3, 1e-3 the largest
     gap to the thin-plate spline (its own solve with kernel r^2 ln r and
     plain affine terms) at the targets shrinks, and is below 1 mm at 1e-3.
  A4 smoothing: the largest misfit at the data grows monotonically with
     s in (0, 0.001, 0.01, 0.1, 1) at T = 0.3.
  A5 tension: the overshoot above the highest datum near a pilot hole
     and its sidetrack (5 m apart, tops 3 m different) falls
     monotonically as T rises through 0.25, 0.5, 0.75, 0.95.

Run:  python3 tools/validation/mapping/oracle_tension.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "mapping", "goldens"))
GAMMA = 0.5772156649015329


def k0(x):
    tmax = math.acosh(max(1.0, 60.0 / x))
    n = 4000
    h = tmax / n
    s = math.exp(-x) + math.exp(-x * math.cosh(tmax))
    for i in range(1, n):
        s += (4 if i % 2 else 2) * math.exp(-x * math.cosh(i * h))
    return s * h / 3.0


def green_small(x):
    """K0(x) + ln x by the ascending series summed with math.fsum."""
    q = x * x / 4.0
    lg = math.log(x / 2.0) + GAMMA
    terms = [math.log(2.0) - GAMMA]
    fact2 = 1.0
    H = 0.0
    for k in range(1, 80):
        fact2 *= k * k
        H += 1.0 / k
        terms.append(q ** k / fact2 * (H - lg))
    return math.fsum(terms)


def green_tension(r, p):
    x = p * r
    if x <= 0:
        return math.log(2.0) - GAMMA
    if x < 0.5:
        return green_small(x)
    return k0(x) + math.log(x)


def median_spacing(pts):
    d = []
    for i, a in enumerate(pts):
        best = math.inf
        for j, b in enumerate(pts):
            if i != j:
                hh = math.hypot(a["x"] - b["x"], a["y"] - b["y"])
                if 0 < hh < best:
                    best = hh
        if math.isfinite(best):
            d.append(best)
    d.sort()
    return d[len(d) // 2]


def gauss_jordan(A, b):
    n = len(b)
    M = [A[i][:] + [b[i]] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[piv] = M[piv], M[col]
        p = M[col][col]
        M[col] = [v / p for v in M[col]]
        for r in range(n):
            if r != col and M[r][col] != 0.0:
                f = M[r][col]
                M[r] = [rv - f * cv for rv, cv in zip(M[r], M[col])]
    return [M[i][n] for i in range(n)]


def fit(pts, T, s):
    n = len(pts)
    L = median_spacing(pts)
    cx = sum(q["x"] for q in pts) / n
    cy = sum(q["y"] for q in pts) / n
    p = T / (1 - T) / L if T > 0 else 0.0
    if p > 0:
        g = lambda r: green_tension(r, p)
        sign = -1.0
    else:
        g = lambda r: (r / L) ** 2 * math.log(r / L) if r > 0 else 0.0
        sign = 1.0
    m = n + 3
    A = [[0.0] * m for _ in range(m)]
    b = [0.0] * m
    for i, a in enumerate(pts):
        for j, c in enumerate(pts):
            A[i][j] = g(math.hypot(a["x"] - c["x"], a["y"] - c["y"]))
        A[i][i] += sign * s
        A[i][n] = 1.0
        A[i][n + 1] = (a["x"] - cx) / L
        A[i][n + 2] = (a["y"] - cy) / L
        A[n][i] = 1.0
        A[n + 1][i] = (a["x"] - cx) / L
        A[n + 2][i] = (a["y"] - cy) / L
        b[i] = a["z"]
    sol = gauss_jordan(A, b)
    w = sol[:n]
    af = sol[n:]

    def ev(x, y):
        v = af[0] + (af[1] * (x - cx) + af[2] * (y - cy)) / L
        for wi, q in zip(w, pts):
            v += wi * g(math.hypot(x - q["x"], y - q["y"]))
        return v
    return ev, {"p": p, "L": L, "weights": w, "affine": af}


def tps(pts):
    n = len(pts)
    u = lambda r2: r2 * math.log(r2) if r2 > 0 else 0.0
    m = n + 3
    A = [[0.0] * m for _ in range(m)]
    b = [0.0] * m
    for i, a in enumerate(pts):
        for j, c in enumerate(pts):
            A[i][j] = u((a["x"] - c["x"]) ** 2 + (a["y"] - c["y"]) ** 2)
        A[i][n], A[i][n + 1], A[i][n + 2] = 1.0, a["x"], a["y"]
        A[n][i], A[n + 1][i], A[n + 2][i] = 1.0, a["x"], a["y"]
        b[i] = a["z"]
    sol = gauss_jordan(A, b)

    def ev(x, y):
        v = sol[n] + sol[n + 1] * x + sol[n + 2] * y
        for wi, q in zip(sol[:n], pts):
            v += wi * u((x - q["x"]) ** 2 + (y - q["y"]) ** 2)
        return v
    return ev


def cone(x, y):
    return -1800.0 - 0.1 * math.hypot(x, y)


def main():
    for x, ref in ((0.1, 2.427069025), (1.0, 0.4210244382), (3.0, 0.03473950439), (10.0, 1.778006232e-5)):
        assert abs(k0(x) / ref - 1) < 1e-9, (x, k0(x), ref)

    # the series and the integral agree where both are accurate
    for x in (0.5, 0.8, 1.2, 1.7, 2.0):
        assert abs(green_small(x) - (k0(x) + math.log(x))) < 1e-12, ("A1b", x)

    cases = []
    targets = [(-20.0, -10.0), (7.5, 22.0), (31.0, 41.0), (60.0, 5.0), (25.0, 25.0), (3.0, 7.0)]
    plane = lambda x, y: 100.0 - 0.02 * x + 0.05 * y
    pl = [{"x": x, "y": y, "z": plane(x, y)} for x, y in ((3, 7), (40, 12), (25, 33), (10, 45), (48, 48), (33, 5))]
    for T in (0.2, 0.5, 0.9):
        ev, meta = fit(pl, T, 0.0)
        vals = [ev(x, y) for x, y in targets]
        for (x, y), v in zip(targets, vals):
            assert abs(v - plane(x, y)) < 1e-9, ("A2", T, v - plane(x, y))
        cases.append({"name": "plane_T%s" % T, "points": pl, "tension": T, "smoothing": 0.0, "targets": targets,
                      "values": vals, "p": meta["p"], "spacing": meta["L"]})

    wells = [{"x": float(x), "y": float(y), "z": cone(x, y)} for x, y in ((0, 0), (400, 100), (-300, 350), (150, -450), (-700, -200), (800, 500), (-100, 850))]
    side = wells + [{"x": 5.0, "y": 0.0, "z": cone(0, 0) - 3.0}]
    t2 = [(-50.0, 20.0), (2.5, 1.0), (600.0, 0.0), (1400.0, 0.0), (-900.0, 900.0), (200.0, 200.0)]

    ev_tps = tps(side)
    lim = []
    for T in (4e-3, 2e-3, 1e-3):
        ev_lim, meta = fit(side, T, 0.0)
        lim.append(max(abs(ev_lim(x, y) - ev_tps(x, y)) for x, y in t2))
    assert lim[0] > lim[1] > lim[2] and lim[2] < 1e-3, ("A3", lim)

    prev = -1.0
    for s in (0.0, 0.001, 0.01, 0.1, 1.0):
        ev, meta = fit(side, 0.3, s)
        mis = max(abs(ev(q["x"], q["y"]) - q["z"]) for q in side)
        assert mis > prev or (s == 0.0 and mis < 1e-9), ("A4", s, mis, prev)
        prev = mis
        cases.append({"name": "sidetrack_T0.3_s%s" % s, "points": side, "tension": 0.3, "smoothing": s, "targets": t2,
                      "values": [ev(x, y) for x, y in t2], "p": meta["p"], "spacing": meta["L"], "maxMisfit": mis})

    grid = [(-100 + 4 * i, -100 + 4 * j) for i in range(51) for j in range(51)]
    top = max(q["z"] for q in side)
    prev = math.inf
    for T in (0.25, 0.5, 0.75, 0.95):
        ev, meta = fit(side, T, 0.0)
        over = max(ev(x, y) for x, y in grid) - top
        assert over < prev, ("A5", T, over, prev)
        prev = over
        cases.append({"name": "sidetrack_T%s" % T, "points": side, "tension": T, "smoothing": 0.0, "targets": t2,
                      "values": [ev(x, y) for x, y in t2], "p": meta["p"], "spacing": meta["L"], "overshoot": over})

    ev, meta = fit(side, 0.0, 0.01)
    cases.append({"name": "sidetrack_T0_s0.01", "points": side, "tension": 0.0, "smoothing": 0.01, "targets": t2,
                  "values": [ev(x, y) for x, y in t2], "p": 0.0, "spacing": meta["L"]})

    out = {"$comment": "Written by tools/validation/mapping/oracle_tension.py; never edit by hand.",
           "tolerance": 1e-6, "k0": [[x, k0(x)] for x in (0.05, 0.1, 0.5, 1.0, 1.9, 2.0, 2.1, 3.0, 7.0, 10.0, 25.0)],
           "cases": cases}
    os.makedirs(GOLD, exist_ok=True)
    with open(os.path.join(GOLD, "tension_cases.json"), "w") as f:
        json.dump(out, f, sort_keys=True, separators=(",", ":"))
    print("wrote", len(cases), "tension-spline cases")


if __name__ == "__main__":
    main()
