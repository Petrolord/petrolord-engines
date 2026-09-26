#!/usr/bin/env python3
"""Independent oracle for lib/gridding/closure.js (Mapping T1, 2026-09-26).

Stdlib only; written from the definitions, never from the JS kernel, and
with DIFFERENT algorithms from it:

  closures at a contact   breadth-first search over 4-neighbour nodes with
                          z > contact; a closure is OPEN when any of its
                          nodes is on the grid edge or has a null
                          4-neighbour. GRV = sum (z - contact) * |dx dy|.
  spill elevation         Kruskal-style: add live nodes in DESCENDING z to
                          a union-find (joining 4-neighbours already added);
                          the spill elevation is the z of the node whose
                          addition first puts the crest in the same set as
                          a boundary node (the bottleneck between crest and
                          map boundary). The JS uses a priority flood.
                          limitedByEdge: that node is itself a boundary node.
  closure at a contact    BFS from the crest over z > contact, recomputed
                          per level (the JS reads a flood prefix).

Self-asserted anchors (fail loudly at generation):
  A1 analytic cone z = -1800 - 0.1 r on a 25 m grid: GRV above -1900 is
     within 0.5 % of pi 1000^2 100 / 3 and the area within 1 % of pi 1000^2.
  A2 two identical domes: two closures of equal GRV, each within 0.5 % of
     the cone value; the spill of the first is the saddle -1950 at x = 1500
     and is not limited by the edge (edges are deeper).
  A3 a plane dipping off the map: every closure is open and the spill is
     limited by the edge.
  A4 a null hole inside a closure makes it open.
  A5 a spill into a lower neighbour cut by the map edge: the spill is the
     saddle (not edge-limited) and the climb at the spill level is not
     reported as a merge.

Run:  python3 tools/validation/mapping/oracle_closure.py
"""

import json
import math
import os
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "mapping", "goldens"))
NULL = 1.0e30


def is_null(v):
    return (not math.isfinite(v)) or abs(v) >= 1e29


def nbrs(i, nx, ny):
    r, c = divmod(i, nx)
    out = []
    if c > 0:
        out.append(i - 1)
    if c < nx - 1:
        out.append(i + 1)
    if r > 0:
        out.append(i - nx)
    if r < ny - 1:
        out.append(i + nx)
    return out


def boundary(z, nx, ny, i):
    r, c = divmod(i, nx)
    if r in (0, ny - 1) or c in (0, nx - 1):
        return True
    return any(is_null(z[j]) for j in nbrs(i, nx, ny))


def closures(z, spec, contact):
    nx, ny = spec["nx"], spec["ny"]
    area = abs(spec["dx"] * spec["dy"])
    seen = [False] * (nx * ny)
    out = []
    for s in range(nx * ny):
        if seen[s] or is_null(z[s]) or not z[s] > contact:
            continue
        q = deque([s])
        seen[s] = True
        nodes = 0
        tot = 0.0
        op = False
        top = s
        while q:
            i = q.popleft()
            nodes += 1
            tot += z[i] - contact
            if z[i] > z[top]:
                top = i
            if boundary(z, nx, ny, i):
                op = True
            for j in nbrs(i, nx, ny):
                if not seen[j] and not is_null(z[j]) and z[j] > contact:
                    seen[j] = True
                    q.append(j)
        out.append({"crestZ": z[top], "crestIndex": top, "nodes": nodes, "areaM2": nodes * area,
                    "grvM3": tot * area, "open": op})
    out.sort(key=lambda k: -k["crestZ"])
    return out


def crest(z):
    best, bz = -1, -math.inf
    for i, v in enumerate(z):
        if not is_null(v) and v > bz:
            best, bz = i, v
    return best


def spill(z, spec, seed=None, min_relief=0.0):
    nx, ny = spec["nx"], spec["ny"]
    start = crest(z) if seed is None else seed
    parent = {}
    top = {}  # root -> highest z in the set
    merges = []

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    bnd_root = "B"
    parent[bnd_root] = bnd_root
    order = sorted((i for i in range(nx * ny) if not is_null(z[i])), key=lambda i: -z[i])
    top[bnd_root] = -math.inf
    for i in order:
        parent[i] = i
        top[i] = z[i]
        crest_joined = []
        for j in nbrs(i, nx, ny):
            if j in parent:
                a, b = find(i), find(j)
                if a != b:
                    if start in parent and find(start) in (a, b):
                        other = b if find(start) == a else a
                        if other != find(bnd_root):
                            crest_joined.append(top[other])
                    parent[a] = b
                    top[b] = max(top[a], top[b])
        reached = start in parent and (find(start) == find(bnd_root) or boundary(z, nx, ny, i) and find(i) == find(start))
        if reached:
            return {"spillZ": z[i], "spillIndex": i, "limitedByEdge": boundary(z, nx, ny, i), "crestIndex": start,
                    "merges": merges}
        for t in crest_joined:
            if t > z[i] and t - z[i] >= min_relief:
                merges.append({"saddleZ": z[i], "saddleIndex": i, "culminationZ": t, "relief": t - z[i]})
        if boundary(z, nx, ny, i):
            a, b = find(i), find(bnd_root)
            if a != b:
                parent[a] = b
    raise RuntimeError("never reached the boundary")


def closure_at(z, spec, seed, contact):
    nx, ny = spec["nx"], spec["ny"]
    area = abs(spec["dx"] * spec["dy"])
    if not z[seed] > contact:
        return {"contact": contact, "nodes": 0, "areaM2": 0.0, "grvM3": 0.0}
    seen = {seed}
    q = deque([seed])
    tot = 0.0
    while q:
        i = q.popleft()
        tot += z[i] - contact
        for j in nbrs(i, nx, ny):
            if j not in seen and not is_null(z[j]) and z[j] > contact:
                seen.add(j)
                q.append(j)
    return {"contact": contact, "nodes": len(seen), "areaM2": len(seen) * area, "grvM3": tot * area}


def grid_of(fn, spec):
    return [fn(spec["x0"] + c * spec["dx"], spec["y0"] + r * spec["dy"]) for r in range(spec["ny"]) for c in range(spec["nx"])]


def cone(x, y, cx=0.0):
    return -1800.0 - 0.1 * math.hypot(x - cx, y)


def main():
    cases = []

    # A1 cone
    s1 = {"x0": -1500.0, "y0": -1500.0, "dx": 25.0, "dy": 25.0, "nx": 121, "ny": 121}
    z1 = grid_of(cone, s1)
    cl = closures(z1, s1, -1900.0)
    exact_v = math.pi * 1000.0 ** 2 * 100.0 / 3.0
    assert len(cl) == 1 and not cl[0]["open"]
    assert abs(cl[0]["grvM3"] / exact_v - 1) < 0.005, cl[0]["grvM3"]
    assert abs(cl[0]["areaM2"] / (math.pi * 1e6) - 1) < 0.01
    sp1 = spill(z1, s1)
    levels = [-1820.0, -1850.0, -1900.0, -1940.0]
    cases.append({"name": "cone", "spec": s1, "z": z1, "contact": -1900.0, "closures": cl, "spill": sp1,
                  "curve": [closure_at(z1, s1, sp1["crestIndex"], L) for L in levels], "levels": levels})

    # A2 two domes, edges deeper than the saddle
    s2 = {"x0": -3000.0, "y0": -3000.0, "dx": 100.0, "dy": 100.0, "nx": 91, "ny": 61}
    z2 = grid_of(lambda x, y: max(cone(x, y), cone(x, y, 3000.0)), s2)
    cl2 = closures(z2, s2, -1900.0)
    assert len(cl2) == 2 and not cl2[0]["open"] and not cl2[1]["open"]
    assert abs(cl2[0]["grvM3"] - cl2[1]["grvM3"]) < 1e-6 * cl2[0]["grvM3"]
    assert abs(cl2[0]["grvM3"] / exact_v - 1) < 0.02, cl2[0]["grvM3"] / exact_v
    seed = [i for i in range(len(z2)) if abs(z2[i] - -1800.0) < 1e-9][0]
    sp2 = spill(z2, s2, seed)
    # the crest's closure spills off the map at the edges (-2100); on the
    # way it joins the second dome at the saddle -1950, x = 1500
    assert abs(sp2["spillZ"] - -2100.0) < 1e-9 and sp2["limitedByEdge"], sp2
    assert len(sp2["merges"]) == 1, sp2["merges"]
    mg = sp2["merges"][0]
    assert abs(mg["saddleZ"] - -1950.0) < 1e-9 and abs(mg["culminationZ"] - -1800.0) < 1e-9
    r, c = divmod(mg["saddleIndex"], s2["nx"])
    assert abs(s2["x0"] + c * s2["dx"] - 1500.0) < 1e-9
    levels2 = [-1900.0, -1949.0, -1951.0]
    cases.append({"name": "two_domes", "spec": s2, "z": z2, "contact": -1900.0, "closures": cl2, "spill": sp2, "seed": seed,
                  "curve": [closure_at(z2, s2, seed, L) for L in levels2], "levels": levels2})

    # A3 plane dipping off the map (crest on the north edge)
    s3 = {"x0": 0.0, "y0": 0.0, "dx": 50.0, "dy": 50.0, "nx": 21, "ny": 17}
    z3 = grid_of(lambda x, y: -2000.0 + 0.05 * y - 0.01 * x, s3)
    cl3 = closures(z3, s3, -1990.0)
    assert cl3 and all(k["open"] for k in cl3)
    sp3 = spill(z3, s3)
    assert sp3["limitedByEdge"]
    cases.append({"name": "plane_off_map", "spec": s3, "z": z3, "contact": -1990.0, "closures": cl3, "spill": sp3,
                  "curve": [], "levels": []})

    # A4 dome with a null hole inside the closure
    s4 = {"x0": -1000.0, "y0": -1000.0, "dx": 50.0, "dy": 50.0, "nx": 41, "ny": 41}
    z4 = grid_of(cone, s4)
    for r in range(18, 21):
        for c in range(25, 28):
            z4[r * 41 + c] = NULL
    cl4 = closures(z4, s4, -1850.0)
    assert len(cl4) == 1 and cl4[0]["open"]
    sp4 = spill(z4, s4)
    cases.append({"name": "null_hole", "spec": s4, "z": z4, "contact": -1850.0, "closures": cl4, "spill": sp4,
                  "curve": [], "levels": []})

    # A5 spill into a lower neighbour that the map edge cuts: dome 1 crest
    # -1800 at x = 0, dome 2 crest -1850 at x = 3000, map ends at x = 3200
    # (dome 2's flank there is -1870, above the saddle). The saddle at
    # x = 1750, z = -1975, is the true spill (not the edge), and the climb
    # into dome 2 happens AT the spill level, so it is not a merge inside
    # the closure.
    s5 = {"x0": -3000.0, "y0": -3000.0, "dx": 50.0, "dy": 50.0, "nx": 125, "ny": 121}
    z5 = grid_of(lambda x, y: max(cone(x, y), -1850.0 - 0.1 * math.hypot(x - 3000.0, y)), s5)
    sp5 = spill(z5, s5)
    assert abs(sp5["spillZ"] - -1975.0) < 1e-9 and not sp5["limitedByEdge"] and sp5["merges"] == [], sp5
    r, c = divmod(sp5["spillIndex"], s5["nx"])
    assert abs(s5["x0"] + c * s5["dx"] - 1750.0) < 1e-9
    cl5 = closures(z5, s5, -1960.0)
    assert len(cl5) == 2 and not cl5[0]["open"] and cl5[1]["open"]
    levels5 = [-1960.0, -1974.0]
    cases.append({"name": "spill_into_cut_dome", "spec": s5, "z": z5, "contact": -1960.0, "closures": cl5, "spill": sp5,
                  "curve": [closure_at(z5, s5, sp5["crestIndex"], L) for L in levels5], "levels": levels5})

    os.makedirs(GOLD, exist_ok=True)
    out = {"$comment": "Written by tools/validation/mapping/oracle_closure.py; never edit by hand.",
           "tolerance": 1e-6, "cases": cases}
    with open(os.path.join(GOLD, "closure_cases.json"), "w") as f:
        json.dump(out, f, sort_keys=True, separators=(",", ":"))
    print("wrote", len(cases), "closure cases")


if __name__ == "__main__":
    main()
