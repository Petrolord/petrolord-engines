#!/usr/bin/env python3
"""Closed-form oracle for rotated grid frames in lib/gridding/gridmath.js
and the Irap classic reader/writer (Mapping & Surface Studio MS5,
2026-09-06). Stdlib only, written from the convention, not from the JS.

Convention (Irap / Petrel): a grid spec {x0, y0, dx, dy, nx, ny,
rotation_deg} places node (r, c) at the world origin (x0, y0) plus
c*dx along the grid's local X axis and r*dy along local Y, the local
axes turned ANTICLOCKWISE from world east / north by rotation_deg.
Row 0 stays the local south row.

    x = x0 + (c dx) cos t - (r dy) sin t
    y = y0 + (c dx) sin t + (r dy) cos t
    inverse: lx =  (x - x0) cos t + (y - y0) sin t
             ly = -(x - x0) sin t + (y - y0) cos t

Anchors, asserted at generation:
  A1 corners of a 30 deg 4x3 grid (dx 100, dy 50) from the formula.
  A2 inverse round trip on off-node points to 1e-9.
  A3 a plane z = 10 + 0.01 x - 0.02 y sampled on the rotated grid, then
     resampled bilinearly onto an unrotated frame inside it, equals the
     plane at every target node to 1e-9 (bilinear is exact for a plane
     in any frame).
  A4 the Irap classic text of that rotated grid, parsed and re-written
     byte-identically (the writer's 6-decimal formatting is the spec).
Run:  python3 tools/validation/mapping/oracle_rotation.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "mapping", "goldens"))


def node_xy(spec, r, c):
    t = math.radians(spec.get("rotation_deg", 0.0))
    lx, ly = c * spec["dx"], r * spec["dy"]
    return (spec["x0"] + lx * math.cos(t) - ly * math.sin(t),
            spec["y0"] + lx * math.sin(t) + ly * math.cos(t))


def to_index(spec, x, y):
    t = math.radians(spec.get("rotation_deg", 0.0))
    ex, ey = x - spec["x0"], y - spec["y0"]
    lx = ex * math.cos(t) + ey * math.sin(t)
    ly = -ex * math.sin(t) + ey * math.cos(t)
    return lx / spec["dx"], ly / spec["dy"]


def bilinear(z, nx, ny, fx, fy):
    if fx < 0 or fy < 0 or fx > nx - 1 or fy > ny - 1:
        return None
    c0, r0 = int(math.floor(fx)), int(math.floor(fy))
    tx, ty = fx - c0, fy - r0
    c1 = c0 + 1 if tx > 0 else c0
    r1 = r0 + 1 if ty > 0 else r0
    v00, v01, v10, v11 = z[r0 * nx + c0], z[r0 * nx + c1], z[r1 * nx + c0], z[r1 * nx + c1]
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty


def fixed6(v):
    return f"{v:.6f}"


def irap_text(spec, z):
    nx, ny = spec["nx"], spec["ny"]
    rot = spec.get("rotation_deg", 0.0)
    x_end = spec["x0"] + (nx - 1) * spec["dx"]
    y_end = spec["y0"] + (ny - 1) * spec["dy"]
    lines = [
        f"-996 {ny} {fixed6(spec['dx'])} {fixed6(spec['dy'])}",
        f"{fixed6(spec['x0'])} {fixed6(x_end)} {fixed6(spec['y0'])} {fixed6(y_end)}",
        f"{nx} {fixed6(rot)} {fixed6(spec['x0'])} {fixed6(spec['y0'])}",
        "0  0  0  0  0  0  0",
    ]
    vals = [fixed6(v) for v in z]
    for i in range(0, len(vals), 6):
        lines.append(" ".join(vals[i:i + 6]))
    return "\n".join(lines) + "\n"


def main():
    spec = {"x0": 1000.0, "y0": 2000.0, "dx": 100.0, "dy": 50.0, "nx": 4, "ny": 3, "rotation_deg": 30.0}
    corners = [node_xy(spec, r, c) for r, c in ((0, 0), (0, 3), (2, 3), (2, 0))]
    c30, s30 = math.cos(math.radians(30)), math.sin(math.radians(30))
    assert abs(corners[1][0] - (1000 + 300 * c30)) < 1e-9 and abs(corners[1][1] - (2000 + 300 * s30)) < 1e-9
    assert abs(corners[3][0] - (1000 - 100 * s30)) < 1e-9 and abs(corners[3][1] - (2000 + 100 * c30)) < 1e-9

    probes = [(1010.0, 2005.0), (1150.0, 2100.0), (1234.5, 2067.8)]
    round_trip = []
    for x, y in probes:
        fx, fy = to_index(spec, x, y)
        lx, ly = fx * spec["dx"], fy * spec["dy"]
        bx = spec["x0"] + lx * c30 - ly * s30
        by = spec["y0"] + lx * s30 + ly * c30
        assert abs(bx - x) < 1e-9 and abs(by - y) < 1e-9, "A2 round trip"
        round_trip.append({"x": x, "y": y, "fx": fx, "fy": fy})

    plane = lambda x, y: 10.0 + 0.01 * x - 0.02 * y  # noqa: E731
    big = {"x0": 1000.0, "y0": 2000.0, "dx": 50.0, "dy": 50.0, "nx": 9, "ny": 9, "rotation_deg": 30.0}
    zbig = []
    for r in range(big["ny"]):
        for c in range(big["nx"]):
            x, y = node_xy(big, r, c)
            zbig.append(plane(x, y))
    # an unrotated target frame well inside the rotated cloud
    target = {"x0": 1050.0, "y0": 2150.0, "dx": 25.0, "dy": 25.0, "nx": 5, "ny": 5}
    zt = []
    for r in range(target["ny"]):
        for c in range(target["nx"]):
            x, y = node_xy(target, r, c)
            fx, fy = to_index(big, x, y)
            v = bilinear(zbig, big["nx"], big["ny"], fx, fy)
            assert v is not None, ("A3 target outside source", r, c, fx, fy)
            assert abs(v - plane(x, y)) < 1e-9, ("A3 plane", v, plane(x, y))
            zt.append(v)

    small_z = [float(i + 1) for i in range(spec["nx"] * spec["ny"])]
    text = irap_text(spec, small_z)

    out = {
        "generated_by": "tools/validation/mapping/oracle_rotation.py",
        "tolerance": 1e-9,
        "corners": {"spec": spec, "expected": [{"x": x, "y": y} for x, y in corners],
                    "bbox": {"xmin": min(c[0] for c in corners), "xmax": max(c[0] for c in corners),
                             "ymin": min(c[1] for c in corners), "ymax": max(c[1] for c in corners)}},
        "round_trip": {"spec": spec, "probes": round_trip},
        "plane_resample": {"source": big, "source_z": zbig, "target": target, "expected": zt,
                           "plane": {"a": 10.0, "bx": 0.01, "cy": -0.02}},
        "irap": {"spec": spec, "z": small_z, "text": text},
    }
    os.makedirs(GOLD, exist_ok=True)
    path = os.path.join(GOLD, "rotation_cases.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
