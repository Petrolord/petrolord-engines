#!/usr/bin/env python3
"""Independent oracle for engines/earthmodeling/adjust.js (Earth
Modeling EM1, 2026-09-06): well adjustment by a Franke-Little compact-
support inverse-distance correction field. Stdlib only, written from
Franke (1982), never from the JS.

    c(x) = sum_i w_i r_i / (w_0 + sum_i w_i),
    w_i = ((R - d_i)+ / (R d_i))^2,  w_0 = 1 / R^2
    c(x) = r_i exactly at a tie, r_i / 2 at R / 2 from a lone tie,
    0 at and beyond R from every tie. (The plain normalised form was
    tried first: a lone tie then corrects its whole disc by r_i and
    steps to zero at R.)

Anchors, asserted at generation:
  A1 one tie on a grid node in a plane: the corrected surface equals the
     plane plus the residual at that node, exactly half the residual at
     R / 2, the plane at nodes farther than R, and strictly between in
     the ring.
  A2 two ties with opposite residuals: the correction is exactly each
     residual at its own node and antisymmetric on the midline (the
     weights are symmetric), so the midpoint node corrects to zero.
  A3 a tie OFF the lattice: the bilinear sample of the corrected surface
     at the tie is within 5% of the residual of the pick (the field is
     exact at the point, the lattice interpolates around it), and the
     residual after adjustment is smaller than before in magnitude.
  A4 a node with no tie within R keeps its value bit for bit.
Run: python3 tools/validation/earthmodel/oracle_adjust.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "earthmodel"))


def node_xy(spec, r, c):
    return spec["x0"] + c * spec["dx"], spec["y0"] + r * spec["dy"]


def correction(ties, spec, radius):
    nx, ny = spec["nx"], spec["ny"]
    out = [0.0] * (nx * ny)
    for r in range(ny):
        for c in range(nx):
            x, y = node_xy(spec, r, c)
            num = den = 0.0
            w0 = 1.0 / (radius * radius)
            exact = None
            for t in ties:
                d = math.hypot(t["x"] - x, t["y"] - y)
                if d >= radius:
                    continue
                if d < 1e-9:
                    exact = t["residualM"]
                    break
                w = ((radius - d) / (radius * d)) ** 2
                num += w * t["residualM"]
                den += w
            out[r * nx + c] = exact if exact is not None else (num / (w0 + den) if den > 0 else 0.0)
    return out


def bilinear(z, spec, x, y):
    fx = (x - spec["x0"]) / spec["dx"]
    fy = (y - spec["y0"]) / spec["dy"]
    c0, r0 = int(math.floor(fx)), int(math.floor(fy))
    tx, ty = fx - c0, fy - r0
    c1 = c0 + 1 if tx > 0 else c0
    r1 = r0 + 1 if ty > 0 else r0
    nx = spec["nx"]
    v00, v01, v10, v11 = z[r0 * nx + c0], z[r0 * nx + c1], z[r1 * nx + c0], z[r1 * nx + c1]
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty


def main():
    spec = {"x0": 0.0, "y0": 0.0, "dx": 100.0, "dy": 100.0, "nx": 21, "ny": 21}
    plane = lambda x, y: 1500.0 + 0.02 * x - 0.01 * y  # noqa: E731 (positive down)
    z = [plane(*node_xy(spec, r, c)) for r in range(spec["ny"]) for c in range(spec["nx"])]
    R = 400.0
    cases = []

    # A1 one tie on node (10, 10)
    t1 = [{"well": "W1", "top": "T", "x": 1000.0, "y": 1000.0, "residualM": 12.5}]
    c1 = correction(t1, spec, R)
    i_c = 10 * spec["nx"] + 10
    assert abs(c1[i_c] - 12.5) < 1e-12
    i_far = 10 * spec["nx"] + 15  # 500 m east, beyond R
    assert c1[i_far] == 0.0
    i_ring = 10 * spec["nx"] + 12  # 200 m east = R / 2: exactly half
    assert abs(c1[i_ring] - 6.25) < 1e-12, c1[i_ring]
    i_near = 10 * spec["nx"] + 11  # 100 m east: between
    assert 6.25 < c1[i_near] < 12.5
    cases.append({"name": "one_tie_on_node", "spec": spec, "z": z, "radius": R, "ties": t1,
                  "expected_field": c1, "probes": {"centre": [10, 10], "far": [10, 15], "half": [10, 12], "near": [10, 11]}})

    # A2 two ties, opposite residuals, symmetric about node (10, 10)
    t2 = [{"well": "A", "top": "T", "x": 800.0, "y": 1000.0, "residualM": 10.0},
          {"well": "B", "top": "T", "x": 1200.0, "y": 1000.0, "residualM": -10.0}]
    c2 = correction(t2, spec, R)
    assert abs(c2[10 * spec["nx"] + 8] - 10.0) < 1e-12 and abs(c2[10 * spec["nx"] + 12] + 10.0) < 1e-12
    assert abs(c2[i_c]) < 1e-12, c2[i_c]
    cases.append({"name": "two_ties_antisymmetric", "spec": spec, "z": z, "radius": R, "ties": t2, "expected_field": c2})

    # A3 a tie off the lattice
    t3 = [{"well": "W3", "top": "T", "x": 1030.0, "y": 1070.0, "residualM": 8.0}]
    c3 = correction(t3, spec, R)
    z3 = [zi + ci for zi, ci in zip(z, c3)]
    after = (plane(1030.0, 1070.0) + 8.0) - bilinear(z3, spec, 1030.0, 1070.0)
    assert abs(after) < 0.05 * 8.0, after
    assert abs(after) < 8.0
    cases.append({"name": "tie_off_lattice", "spec": spec, "z": z, "radius": R, "ties": t3,
                  "expected_field": c3, "expected_after": after, "pick_tvdss": plane(1030.0, 1070.0) + 8.0})

    # A4 untouched far node keeps its value (bitwise)
    z1 = [zi + ci for zi, ci in zip(z, c1)]
    assert z1[i_far] == z[i_far]

    out = {"generated_by": "tools/validation/earthmodel/oracle_adjust.py", "tolerance": 1e-9, "cases": cases}
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "adjust_cases.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    main()
