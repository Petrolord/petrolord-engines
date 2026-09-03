#!/usr/bin/env python3
"""Closed-form oracle for engines/welldata/checkshots.js (Petrophysics PT0).

Writes test-data/wells/goldens/checkshots_cases.json from ANALYTIC
trajectories, never from the JS kernel:

  vertical           TVD = MD, TVDSS = MD - KB
  build-and-hold     KOP k, build rate B deg per 30 m, hold angle T:
                     R = 30 / radians(B); in the build (theta = (md-k)/R)
                     TVD = k + R sin(theta); after end of build
                     TVD = k + R sin(T) + (md - md_eob) cos(T); inverses
                     by asin in the build and linear in the hold.

Minimum curvature is exact on a planar constant-curvature arc, so the JS
values must agree to 1e-6 m. Stations are emitted every 30 m through the
build (`rate` degrees apart; the hold angle is a whole number of steps) so the
arc between stations is a true circular arc.

Deterministic: sorted keys, repr-precision floats. Run:
  tools/validation/wells/.venv/bin/python tools/validation/wells/oracle_checkshots.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "wells", "goldens"))
M_PER_FT = 0.3048


class BuildHold:
    def __init__(self, kop, build_deg_per_30m, hold_deg, td, azi=135.0):
        self.kop = float(kop)
        self.rate = float(build_deg_per_30m)
        self.hold = float(hold_deg)
        self.td = float(td)
        self.azi = float(azi)
        n = self.hold / self.rate
        assert abs(n - round(n)) < 1e-9, "hold angle must be a whole number of 30 m build steps so the last build station sits exactly at the hold angle"
        self.R = 30.0 / math.radians(self.rate)
        self.md_eob = self.kop + self.R * math.radians(self.hold)
        self.tvd_eob = self.kop + self.R * math.sin(math.radians(self.hold))
        self.cos_hold = math.cos(math.radians(self.hold))

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
        return self.tvd_eob + (md - self.md_eob) * self.cos_hold  # also the tangent extrapolation past TD

    def mds_at_tvd(self, tvd):
        """All MDs where the path reaches tvd (ascending)."""
        out = []
        if tvd <= self.kop:
            return [tvd]
        top = self.kop + self.R  # tvd at theta = 90 deg
        if tvd <= top + 1e-12:
            s = (tvd - self.kop) / self.R
            s = max(-1.0, min(1.0, s))
            th1 = math.asin(s)
            th2 = math.pi - th1
            for th in (th1, th2):
                if th <= math.radians(self.hold) + 1e-12:
                    out.append(self.kop + self.R * th)
        if abs(self.cos_hold) > 1e-12:
            md = self.md_eob + (tvd - self.tvd_eob) / self.cos_hold
            if md >= self.md_eob - 1e-9:
                out.append(md)
        out = sorted(out)
        dedup = []
        for md in out:
            if not dedup or md - dedup[-1] > 1e-7:
                dedup.append(md)
        return dedup


def rows_from_md(traj, kb, rows_in, unit, time_kind):
    rows = []
    for depth, t in rows_in:
        md_m = depth * M_PER_FT if unit == "ft" else depth
        tvd = traj.tvd(md_m) if traj else md_m
        rows.append({"tvdss_m": tvd - kb, "twt_ms": 2 * t if time_kind == "owt" else t, "md_m": md_m})
    return rows


def rows_from_vertical_ref(traj, kb, rows_in, unit, time_kind, ref):
    rows = []
    for depth, t in rows_in:
        d_m = depth * M_PER_FT if unit == "ft" else depth
        tvdss = d_m - kb if ref == "tvd" else d_m
        tvd = tvdss + kb
        hits = traj.mds_at_tvd(tvd) if traj else [tvd]
        row = {"tvdss_m": tvdss, "twt_ms": 2 * t if time_kind == "owt" else t}
        if len(hits) == 1:
            row["md_m"] = hits[0]
        rows.append(row)
    return rows


def case(name, kind, kb, traj, conv, rows_in, **extra):
    c = {"name": name, "kind": kind, "kb_m": kb, "stations": traj.stations() if traj else None,
         "convention": {"depthRef": conv[0], "time": conv[1], "depthUnit": conv[2]},
         "rows_in": [{"depth": d, "time": t} for d, t in rows_in]}
    c.update(extra)
    return c


def main():
    os.makedirs(GOLD, exist_ok=True)
    bh = BuildHold(kop=500.0, build_deg_per_30m=4.0, hold_deg=40.0, td=3000.0)
    steep = BuildHold(kop=500.0, build_deg_per_30m=5.0, hold_deg=40.0, td=3000.0)
    uphill = BuildHold(kop=1000.0, build_deg_per_30m=5.0, hold_deg=95.0, td=2500.0)
    flat = BuildHold(kop=1000.0, build_deg_per_30m=3.0, hold_deg=90.0, td=2600.0)
    kb = 30.0
    md_owt = [(250.0, 120.0), (610.0, 262.0), (745.0, 305.0), (1200.0, 425.0), (2500.0, 810.0)]
    md_owt_ft = [(820.0, 120.0), (2001.0, 262.0), (2444.0, 305.0), (3937.0, 425.0), (8202.0, 810.0)]
    cases = []

    # 1-2 vertical wells
    cases.append(case("vertical_md_owt_m", "convert", kb, None, ("md", "owt", "m"), md_owt,
                      expected={"rows": rows_from_md(None, kb, md_owt, "m", "owt"), "warnings_contains": []}))
    cases.append(case("vertical_md_owt_ft", "convert", kb, None, ("md", "owt", "ft"), md_owt_ft,
                      expected={"rows": rows_from_md(None, kb, md_owt_ft, "ft", "owt"), "warnings_contains": []}))
    # 3 build-and-hold, MD/OWT, off-station MDs
    cases.append(case("buildhold_md_owt", "convert", kb, bh, ("md", "owt", "m"), md_owt,
                      expected={"rows": rows_from_md(bh, kb, md_owt, "m", "owt"), "warnings_contains": []}))
    # 4 TVD entered (TWT): expected tvdss shift and md via the analytic inverse
    tvd_twt = [(250.0, 240.0), (600.0, 520.0), (700.0, 600.0), (1100.0, 850.0), (2000.0, 1600.0)]
    cases.append(case("buildhold_tvd_twt", "convert", kb, bh, ("tvd", "twt", "m"), tvd_twt,
                      expected={"rows": rows_from_vertical_ref(bh, kb, tvd_twt, "m", "twt", "tvd"), "warnings_contains": []}))
    # 5 TVDSS in feet, TWT
    tvdss_ft = [(700.0, 240.0), (1900.0, 520.0), (2300.0, 600.0), (3500.0, 850.0), (6500.0, 1600.0)]
    cases.append(case("buildhold_tvdss_twt_ft", "convert", kb, bh, ("tvdss", "twt", "ft"), tvdss_ft,
                      expected={"rows": rows_from_vertical_ref(bh, kb, tvdss_ft, "ft", "twt", "tvdss"), "warnings_contains": []}))
    # 6 extrapolate 200 m past TD along the hold tangent
    extrap = [(2500.0, 810.0), (2900.0, 900.0), (3200.0, 980.0)]
    cases.append(case("extrapolate_below_td", "convert", kb, bh, ("md", "owt", "m"), extrap,
                      expected={"rows": rows_from_md(bh, kb, extrap, "m", "owt"), "warnings_contains": ["Row 3: MD 3200 m is below the last survey station"]}))
    # 7 uphill: a TVD revisited on the way back up -> shallowest MD, ambiguous, no md_m
    tvd_amb = uphill.kop + uphill.R * math.sin(math.radians(80.0))
    tvdss_amb = tvd_amb - kb
    amb_rows = [(500.0 - kb, 240.0), (tvdss_amb, 900.0)]
    exp_amb = rows_from_vertical_ref(uphill, kb, amb_rows, "m", "twt", "tvdss")
    assert len(uphill.mds_at_tvd(tvd_amb)) == 2 and "md_m" not in exp_amb[1]
    cases.append(case("uphill_ambiguous", "convert", kb, uphill, ("tvdss", "twt", "m"), amb_rows,
                      expected={"rows": exp_amb, "warnings_contains": ["Row 2: TVDSS", "more than one MD"],
                                "all_mds_row2": uphill.mds_at_tvd(tvd_amb)}))
    # 8 flat lateral: MD rows in the horizontal hold must be refused
    lateral = [(500.0, 200.0), (1200.0, 400.0), (2200.0, 600.0), (2500.0, 650.0)]
    cases.append(case("flat_lateral_error", "error", kb, flat, ("md", "owt", "m"), lateral,
                      expected_error_contains="does not increase"))
    # 9 non-monotonic MD/TWT table
    cases.append(case("non_monotonic_error", "error", kb, None, ("md", "twt", "m"), [(0.0, 0.0), (50.0, 55.0), (40.0, 60.0)],
                      expected_error_contains="strictly increase"))
    # 10 KB rebase per reference (30 -> 45)
    base_md = rows_from_md(bh, kb, md_owt, "m", "owt")
    cases.append(case("rebase_kb_md", "rebase", kb, bh, ("md", "owt", "m"), md_owt,
                      stored=base_md, provenance={"units_in": {"depth_ref": "md", "time": "owt", "depth_unit": "m"}, "kb_m_used": kb},
                      new_kb_m=45.0, new_stations=None,
                      expected_rows=[{"tvdss_m": r["tvdss_m"] - 15.0, "twt_ms": r["twt_ms"], "md_m": r["md_m"]} for r in base_md]))
    base_tvd = rows_from_vertical_ref(bh, kb, tvd_twt, "m", "twt", "tvd")
    cases.append(case("rebase_kb_tvd", "rebase", kb, bh, ("tvd", "twt", "m"), tvd_twt,
                      stored=base_tvd, provenance={"units_in": {"depth_ref": "tvd", "time": "twt", "depth_unit": "m"}, "kb_m_used": kb},
                      new_kb_m=45.0, new_stations=None,
                      expected_rows=rows_from_vertical_ref(bh, 45.0, tvd_twt, "m", "twt", "tvd")))
    base_tvdss = rows_from_vertical_ref(bh, kb, tvdss_ft, "ft", "twt", "tvdss")
    cases.append(case("rebase_kb_tvdss", "rebase", kb, bh, ("tvdss", "twt", "ft"), tvdss_ft,
                      stored=base_tvdss, provenance={"units_in": {"depth_ref": "tvdss", "time": "twt", "depth_unit": "ft"}, "kb_m_used": kb},
                      new_kb_m=45.0, new_stations=None,
                      expected_rows=rows_from_vertical_ref(bh, 45.0, tvdss_ft, "ft", "twt", "tvdss")))
    # 11 survey rebase: MD-referenced rows, steeper build
    cases.append(case("rebase_survey_md", "rebase", kb, bh, ("md", "owt", "m"), md_owt,
                      stored=base_md, provenance={"units_in": {"depth_ref": "md", "time": "owt", "depth_unit": "m"}, "kb_m_used": kb},
                      new_kb_m=kb, new_stations=steep.stations(),
                      expected_rows=rows_from_md(steep, kb, md_owt, "m", "owt")))

    out = {"oracle": "oracle_checkshots.py closed-form trajectories (vertical, build-and-hold); never the JS kernel",
           "tolerance_m": 1e-6, "cases": cases}
    path = os.path.join(GOLD, "checkshots_cases.json")
    with open(path, "w", newline="\n") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"golden {os.path.relpath(path)} ({len(cases)} cases)")


if __name__ == "__main__":
    main()
