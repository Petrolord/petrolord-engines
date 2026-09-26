#!/usr/bin/env python3
"""Closed-form oracle for engines/mapping/wellTie.js (Mapping T1,
2026-09-26). Stdlib only; never from the JS.

A linear instantaneous velocity V(z) = v0 + k z (z metres below datum)
gives one-way time t(z) = ln(1 + k z / v0) / k and so a two-way time
TWT(z) = 2000 t(z) ms, and an average velocity Vavg(z) = z / t(z).

The case builds a depth structure Z(x, y) (a dome on a regional dip),
its TWT grid in closed form, wells AT nodes (so the bilinear sample of
the TWT grid is the node value exactly) and one well OFF node (its TWT
is the bilinear sample the oracle computes itself). Expected:

  averageVelocityTies  vavg = depthM / (TWT / 2000) at each well; at the
                       node wells this equals the analytic Vavg(Z).
  depthFromAverageVelocity  with the analytic Vavg(Z) at every node,
                       elevation = -Vavg * TWT / 2000 = -Z exactly.
  tieResiduals         of a map shifted by +3 m (shallower) the residual
                       at every well is -3 m (the well is deeper).

Self-asserted anchors: Vavg(Z) * t(Z) == Z to 1e-9 at every node; a
node well's vavg equals the analytic Vavg to 1e-9.

Run:  python3 tools/validation/mapping/oracle_welltie.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "mapping", "goldens"))

V0, K = 1800.0, 0.6


def t_one_way(z):
    return math.log(1.0 + K * z / V0) / K


def vavg(z):
    return z / t_one_way(z)


def depth(x, y):
    return 2200.0 + 0.02 * x - 0.01 * y - 150.0 * math.exp(-((x - 1000.0) ** 2 + (y - 800.0) ** 2) / (2 * 400.0 ** 2))


def bilinear(g, spec, x, y):
    nx, ny = spec["nx"], spec["ny"]
    fx = (x - spec["x0"]) / spec["dx"]
    fy = (y - spec["y0"]) / spec["dy"]
    c0 = min(nx - 2, int(math.floor(fx)))
    r0 = min(ny - 2, int(math.floor(fy)))
    u, v = fx - c0, fy - r0
    i = r0 * nx + c0
    return (1 - u) * (1 - v) * g[i] + u * (1 - v) * g[i + 1] + (1 - u) * v * g[i + nx] + u * v * g[i + nx + 1]


def main():
    spec = {"x0": 0.0, "y0": 0.0, "dx": 100.0, "dy": 100.0, "nx": 21, "ny": 17}
    Z, TWT, VA = [], [], []
    for r in range(spec["ny"]):
        for c in range(spec["nx"]):
            z = depth(c * 100.0, r * 100.0)
            t = t_one_way(z)
            assert abs(vavg(z) * t - z) < 1e-9
            Z.append(z)
            TWT.append(2000.0 * t)
            VA.append(vavg(z))
    node_wells = [("A-1", 1000.0, 800.0), ("A-2", 300.0, 200.0), ("A-3", 1700.0, 1400.0), ("A-4", 500.0, 1300.0)]
    wells = [{"well": n, "x": x, "y": y, "depthM": depth(x, y)} for n, x, y in node_wells]
    wells.append({"well": "B-1", "x": 1234.0, "y": 567.0, "depthM": depth(1234.0, 567.0)})
    ties = []
    for w in wells:
        t = bilinear(TWT, spec, w["x"], w["y"])
        v = w["depthM"] / (t / 2000.0)
        ties.append({"well": w["well"], "twtMs": t, "vavg": v})
        if w["well"].startswith("A"):
            assert abs(v - vavg(w["depthM"])) < 1e-9
    shifted = [-z + 3.0 for z in Z]
    resid = [{"well": w["well"], "residualM": (-w["depthM"]) - bilinear(shifted, spec, w["x"], w["y"])} for w in wells]
    out = {"$comment": "Written by tools/validation/mapping/oracle_welltie.py; never edit by hand.",
           "tolerance": 1e-6, "spec": spec, "twt": TWT, "vavgGrid": VA, "depthM": Z, "wells": wells,
           "expectedTies": ties, "shiftedMap": shifted, "expectedResiduals": resid}
    os.makedirs(GOLD, exist_ok=True)
    with open(os.path.join(GOLD, "welltie_cases.json"), "w") as f:
        json.dump(out, f, sort_keys=True, separators=(",", ":"))
    print("wrote well-tie case with", len(wells), "wells")


if __name__ == "__main__":
    main()
