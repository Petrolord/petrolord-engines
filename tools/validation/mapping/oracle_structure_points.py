#!/usr/bin/env python3
"""Closed-form oracle for engines/mapping/surface.js topsToControlPoints
and the gridmath helpers it feeds (Mapping & Surface Studio MS0).

Writes test-data/mapping/goldens/structure_points_cases.json from
ANALYTIC trajectories, never from the JS kernel:

  vertical           TVD = MD, TVDSS = MD - KB, no lateral offset
  build-and-hold     KOP k, build rate B deg per 30 m, hold angle T,
                     azimuth A (degrees clockwise from grid north):
                     R = 30 / radians(B); in the build (theta = (md-k)/R)
                     TVD = k + R sin(theta), h = R (1 - cos(theta));
                     after end of build TVD = tvd_eob + s cos(T),
                     h = h_eob + s sin(T) with s = md - md_eob (also the
                     tangent continuation past TD); east = h sin(A),
                     north = h cos(A).

Elevation convention (owner decision 2026-09-05): every depth surface in
geo_surfaces is negative below datum, so a TVDSS control value is
-(TVD - KB) and a TVD one is -TVD; the `md` reference stays positive.

The plane case proves placement and gridding together: wells whose tops
sit on a dipping plane z = a + b X + c Y (the deviated wells' top MDs are
solved in closed form in the hold section), gridded by TPS, must
reproduce the plane at every node well inside the convex hull (the TPS
affine term makes a plane exact) and stay null outside it.

Deterministic: sorted keys, repr-precision floats. Run:
  python3 tools/validation/mapping/oracle_structure_points.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "mapping", "goldens"))
M_PER_FT = 0.3048


class BuildHold:
    def __init__(self, kop, build_deg_per_30m, hold_deg, td, azi):
        self.kop = float(kop)
        self.rate = float(build_deg_per_30m)
        self.hold = float(hold_deg)
        self.td = float(td)
        self.azi = float(azi)
        n = self.hold / self.rate
        assert abs(n - round(n)) < 1e-9, "hold angle must be a whole number of 30 m build steps"
        self.R = 30.0 / math.radians(self.rate)
        self.md_eob = self.kop + self.R * math.radians(self.hold)
        self.tvd_eob = self.kop + self.R * math.sin(math.radians(self.hold))
        self.h_eob = self.R * (1.0 - math.cos(math.radians(self.hold)))
        self.cos_hold = math.cos(math.radians(self.hold))
        self.sin_hold = math.sin(math.radians(self.hold))
        assert self.md_eob < self.td, "the hold must start before TD"

    def stations(self):
        st = [{"md": 0.0, "inc": 0.0, "azi": self.azi}]
        if self.kop > 0:
            st.append({"md": self.kop, "inc": 0.0, "azi": self.azi})
        n = int(round(self.hold / self.rate))
        for i in range(1, n + 1):
            st.append({"md": self.kop + 30.0 * i, "inc": self.rate * i, "azi": self.azi})
        st.append({"md": self.td, "inc": self.hold, "azi": self.azi})
        return st

    def tvd(self, md):
        if md <= self.kop:
            return md
        if md <= self.md_eob:
            return self.kop + self.R * math.sin((md - self.kop) / self.R)
        return self.tvd_eob + (md - self.md_eob) * self.cos_hold

    def h(self, md):
        if md <= self.kop:
            return 0.0
        if md <= self.md_eob:
            return self.R * (1.0 - math.cos((md - self.kop) / self.R))
        return self.h_eob + (md - self.md_eob) * self.sin_hold

    def offset(self, md):
        h = self.h(md)
        return h * math.sin(math.radians(self.azi)), h * math.cos(math.radians(self.azi))

    def md_on_plane_in_hold(self, xs, ys, kb, plane):
        """MD in the hold where the elevation -(tvd - kb) meets the plane
        z = a + b x + c y along the borehole (closed form; linear in s)."""
        a, b, c = plane
        sa, ca = math.sin(math.radians(self.azi)), math.cos(math.radians(self.azi))
        g = b * sa + c * ca
        K = a + b * xs + c * ys
        s = -(K + g * self.h_eob + self.tvd_eob - kb) / (self.cos_hold + g * self.sin_hold)
        return self.md_eob + s


def well(name, x, y, kb, traj, tops, td=None):
    w = {"name": name, "surface_x": x, "surface_y": y, "kb_m": kb,
         "td_md_m": td if td is not None else (traj.td if traj else None),
         "deviation": traj.stations() if traj else [],
         "tops": [{"name": n, "md_m": md} for n, md in tops]}
    return w


def expected_point(w, traj, md, depth_ref, placement):
    kb = w["kb_m"]
    tvd = traj.tvd(md) if traj else md
    ex, ny_ = traj.offset(md) if traj else (0.0, 0.0)
    z = md if depth_ref == "md" else (-tvd if depth_ref == "tvd" else -(tvd - kb))
    x = w["surface_x"] + (ex if placement == "borehole" else 0.0)
    y = w["surface_y"] + (ny_ if placement == "borehole" else 0.0)
    extrap = bool(traj) and md > traj.td + 1e-9
    return {"well": w["name"], "x": x, "y": y, "z": z, "md": md, "extrapolated": extrap}


def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def convex_hull(pts):
    pts = sorted(set((p[0], p[1]) for p in pts))
    if len(pts) <= 2:
        return pts
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def signed_margin(hull, x, y):
    """Smallest signed distance to a hull edge (positive inside a CCW hull)."""
    m = math.inf
    for i in range(len(hull)):
        ax, ay = hull[i]
        bx, by = hull[(i + 1) % len(hull)]
        L = math.hypot(bx - ax, by - ay)
        d = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / L
        m = min(m, d)
    return m


def main():
    os.makedirs(GOLD, exist_ok=True)
    kb = 30.0
    bh = BuildHold(kop=500.0, build_deg_per_30m=4.0, hold_deg=40.0, td=3000.0, azi=135.0)
    cases = []
    refs = ["md", "tvd", "tvdss"]
    placements = ["borehole", "surface"]

    # 1 vertical wells, KB only
    vw = [well("V-1", 501000.0, 6700200.0, kb, None, [("Top A", 1500.0), ("Top B", 1660.0)], td=1800.0),
          well("V-2", 502200.0, 6700600.0, kb, None, [("Top A", 1560.0)], td=1800.0)]
    cases.append({"name": "vertical_kb_only", "kind": "points", "wells": vw, "top": "Top A",
                  "expected": {f"{r}/{p}": {"points": [expected_point(w, None, w["tops"][0]["md_m"], r, p) for w in vw],
                                            "skipped": [], "extrapolated": 0}
                               for r in refs for p in placements}})

    # 2 build-and-hold, top in the hold
    dw = [well("D-1", 500300.0, 6700700.0, kb, bh, [("Top A", 2000.0)])]
    cases.append({"name": "buildhold_in_survey", "kind": "points", "wells": dw, "top": "Top A",
                  "expected": {f"{r}/{p}": {"points": [expected_point(dw[0], bh, 2000.0, r, p)], "skipped": [], "extrapolated": 0}
                               for r in refs for p in placements}})

    # 3 build-and-hold, top past TD (tangent continuation, flagged)
    ew = [well("D-2", 500300.0, 6700700.0, kb, bh, [("Top A", 3200.0)])]
    cases.append({"name": "buildhold_extrapolated", "kind": "points", "wells": ew, "top": "Top A",
                  "expected": {f"{r}/{p}": {"points": [expected_point(ew[0], bh, 3200.0, r, p)], "skipped": [], "extrapolated": 1}
                               for r in refs for p in placements}})

    # 4 skipped rows, fixed reasons, input order
    sw = [well("S-none", 501000.0, 6700200.0, kb, None, [("Other", 1000.0)], td=1500.0),
          well("S-noloc", None, 6700200.0, kb, None, [("Top A", 1000.0)], td=1500.0),
          well("S-badmd", 501000.0, 6700200.0, kb, None, [], td=1500.0),
          well("S-above", 501000.0, 6700200.0, kb, bh, [("Top A", -5.0)]),
          well("S-ok", 501500.0, 6700100.0, kb, None, [("Top A", 1200.0)], td=1500.0)]
    sw[2]["tops"] = [{"name": "Top A", "md_m": "abc"}]
    cases.append({"name": "skipped_rows", "kind": "points", "wells": sw, "top": "Top A",
                  "expected": {"tvdss/borehole": {"points": [expected_point(sw[4], None, 1200.0, "tvdss", "borehole")],
                                                  "skipped": [{"well": "S-none", "reason": "no_top"},
                                                              {"well": "S-noloc", "reason": "no_location"},
                                                              {"well": "S-badmd", "reason": "bad_md"},
                                                              {"well": "S-above", "reason": "above_survey"}],
                                                  "extrapolated": 0}}})

    # 5 dipping plane: placement + gridding together
    plane = (-1500.0 + 0.02 * 501500.0 - 0.01 * 6700000.0, -0.02, 0.01)  # z = a + b x + c y, ~-1500 m at the centre
    a, b, c = plane
    zp = lambda x, y: a + b * x + c * y
    pw = []
    for name, x, y in (("P-1", 500200.0, 6699200.0), ("P-2", 502800.0, 6699300.0), ("P-3", 501500.0, 6700800.0)):
        pw.append(well(name, x, y, kb, None, [("Top A", kb - zp(x, y))], td=2000.0))
    d1 = BuildHold(kop=500.0, build_deg_per_30m=4.0, hold_deg=40.0, td=3000.0, azi=135.0)
    md1 = d1.md_on_plane_in_hold(500300.0, 6700700.0, kb, plane)
    assert d1.md_eob < md1 < d1.td, md1
    pw.append(well("P-4", 500300.0, 6700700.0, kb, d1, [("Top A", md1)]))
    d2 = BuildHold(kop=500.0, build_deg_per_30m=4.0, hold_deg=40.0, td=1500.0, azi=225.0)
    md2 = d2.md_on_plane_in_hold(502700.0, 6700700.0, kb, plane)
    assert md2 > d2.td, md2  # past TD: the tangent continuation must still land on the plane
    pw.append(well("P-5", 502700.0, 6700700.0, kb, d2, [("Top A", md2)]))
    pts = []
    for w in pw:
        traj = d1 if w["name"] == "P-4" else d2 if w["name"] == "P-5" else None
        p = expected_point(w, traj, w["tops"][0]["md_m"], "tvdss", "borehole")
        assert abs(p["z"] - zp(p["x"], p["y"])) < 1e-6, (w["name"], p["z"], zp(p["x"], p["y"]))
        pts.append(p)
    spec = {"x0": 500000.0, "y0": 6699000.0, "dx": 100.0, "dy": 100.0, "nx": 31, "ny": 21}
    hull = convex_hull([(p["x"], p["y"]) for p in pts])
    interior, exterior = [], []
    for r in range(spec["ny"]):
        for cidx in range(spec["nx"]):
            x = spec["x0"] + cidx * spec["dx"]
            y = spec["y0"] + r * spec["dy"]
            m = signed_margin(hull, x, y)
            if m >= 0.5 * spec["dx"]:
                interior.append([r, cidx, zp(x, y)])
            elif m < -0.5 * spec["dx"]:
                exterior.append([r, cidx])
    assert len(interior) > 50 and len(exterior) > 50
    cases.append({"name": "plane_grid", "kind": "plane", "wells": pw, "top": "Top A",
                  "plane": {"a": a, "b": b, "c": c}, "expected_points": pts, "spec": spec,
                  "interior_nodes": interior, "exterior_nodes": exterior})

    # 6 parallel planes: thickness from two elevation surfaces
    cases.append({"name": "parallel_planes", "kind": "thickness", "spec": spec,
                  "top": {"a": a, "b": b, "c": c}, "base": {"a": a - 50.0, "b": b, "c": c},
                  "expected_thickness_m": 50.0})

    # 7 unit round trip
    vals = [-1500.0, -1234.5678, 0.0, 12.0]
    cases.append({"name": "unit_roundtrip", "kind": "units", "values_m": vals,
                  "values_ft": [v / M_PER_FT for v in vals]})

    out = {"oracle": "oracle_structure_points.py closed-form trajectories and planes; never the JS kernel",
           "tolerance_m": 1e-6, "grid_tolerance_m": 1e-3, "cases": cases}
    path = os.path.join(GOLD, "structure_points_cases.json")
    with open(path, "w", newline="\n") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"golden {os.path.relpath(path)} ({len(cases)} cases)")


if __name__ == "__main__":
    main()
