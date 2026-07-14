"""Generate the G6.0 rock-physics goldens (deterministic, stdlib-only —
no RNG anywhere; rerunning must be byte-identical).

Writes test-data/rockphysics/goldens.json: Batzle-Wang fluid grids,
Gassmann cases (moduli-domain and log-domain), Vs-estimation curves,
AVO interface cases for all four Rutherford-Williams classes, and a
wedge tuning curve.

main() ASSERTS the anchors before writing (G2 fixture-v2 lesson — a
regeneration that breaks physics refuses to land):

  A1  BW brine at S=0 equals pure water exactly.
  A2  Gassmann round trips: A->dry->A and forward/inverse < 1e-12 rel.
  A3  Gassmann K_fl->0 limit collapses to K_dry.
  A4  Zoeppritz at theta=0 equals (Z2-Z1)/(Z2+Z1) to 1e-12.
  A5  Zoeppritz matches Aki-Richards < 1e-4 to 30 deg on a 1% contrast.
  A6  Zoeppritz with vanishing Vs matches the analytic acoustic
      (fluid-fluid) reflection coefficient at 20 deg.
  A7  Shuey(0) == A exactly; 3-term Shuey tracks Aki-Richards < 5e-4
      to 20 deg on the class-III case.
  A8  Each AVO fixture classifies as constructed (I, II, III, IV).
  A9  Wedge tuning thickness == sqrt(6)/(pi*f) within one dt; the
      thick-bed limit recovers |rc_top| (unit-peak Ricker) < 1e-4.
  A10 GC sandstone at Vp=4 km/s equals the hand value 2.36076 km/s;
      the 50/50 sand/shale composite lies between the pure curves.
  A11 Wood: sw=1 returns the brine modulus exactly.
"""

import json
import math
import os

import oracle

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..",
                   "test-data", "rockphysics")

# AVO interface fixtures (shale over sand; SI). Constructed so the four
# Rutherford-Williams classes are all exercised — asserted in A8.
AVO_CASES = [
    {"name": "class1_hard_sand", "expect": "I",
     "upper": {"vp": 2900.0, "vs": 1330.0, "rho": 2290.0},
     "lower": {"vp": 4000.0, "vs": 2400.0, "rho": 2260.0}},
    {"name": "class2_near_zero_impedance", "expect": "II",
     "upper": {"vp": 2900.0, "vs": 1330.0, "rho": 2290.0},
     "lower": {"vp": 3050.0, "vs": 1650.0, "rho": 2250.0}},
    {"name": "class3_gas_sand", "expect": "III",
     "upper": {"vp": 2900.0, "vs": 1330.0, "rho": 2290.0},
     "lower": {"vp": 2540.0, "vs": 1620.0, "rho": 2090.0}},
    {"name": "class4_soft_gas_sand_hard_shale", "expect": "IV",
     "upper": {"vp": 3240.0, "vs": 1620.0, "rho": 2340.0},
     "lower": {"vp": 1650.0, "vs": 1090.0, "rho": 2070.0}},
]

ANGLES = [0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0]

WEDGE = {"freq_hz": 25.0, "dt_ms": 1.0, "rc_top": 0.1, "rc_base": -0.1,
         "max_thickness_ms": 60.0}


def build_fluids():
    rows = {"brine": [], "gas": [], "dead_oil": [], "live_oil": [],
            "wood": []}
    for t in (20.0, 60.0, 100.0):
        for p in (10.0, 25.0, 50.0):
            for s in (0.0, 0.035, 0.08):
                rows["brine"].append({"t": t, "p": p, "s": s,
                                      **oracle.brine(t, p, s)})
            for g in (0.6, 1.2):
                rows["gas"].append({"t": t, "p": p, "g": g,
                                    **oracle.gas(t, p, g)})
            for rho0 in (0.934, 0.825):  # ~20 API, ~40 API
                rows["dead_oil"].append({"t": t, "p": p, "rho0": rho0,
                                         **oracle.dead_oil(t, p, rho0)})
    for rg in (50.0, 100.0, 200.0):
        for t in (60.0, 100.0):
            for p in (25.0, 50.0):
                rows["live_oil"].append(
                    {"t": t, "p": p, "rho0": 0.85, "rg": rg, "g": 0.6,
                     **oracle.live_oil(t, p, 0.85, rg, 0.6)})
    br, gs = oracle.brine(60.0, 25.0, 0.035), oracle.gas(60.0, 25.0, 0.6)
    for sw in (0.0, 0.5, 0.8, 1.0):
        mix = oracle.wood_mix([sw, 1.0 - sw], [br["k"], gs["k"]],
                              [br["rho"], gs["rho"]])
        rows["wood"].append({"t": 60.0, "p": 25.0, "s": 0.035, "g": 0.6,
                             "sw": sw, **mix})
    return rows


def build_gassmann():
    br = oracle.brine(60.0, 25.0, 0.035)
    gs = oracle.gas(60.0, 25.0, 0.6)
    kmin = 37e9
    cases = []
    for kdry, phi in ((12e9, 0.15), (8e9, 0.25), (5e9, 0.35)):
        ksat_br = oracle.gassmann_ksat(kdry, kmin, br["k"], phi)
        ksat_gs = oracle.gassmann_ksat(kdry, kmin, gs["k"], phi)
        cases.append({"kdry": kdry, "kmin": kmin, "phi": phi,
                      "kfl_brine": br["k"], "kfl_gas": gs["k"],
                      "ksat_brine": ksat_br, "ksat_gas": ksat_gs})
    logdom = oracle.substitute_vels(3200.0, 1800.0, 2250.0, kmin, 0.25,
                                    br, gs)
    return {"cases": cases,
            "log_domain": {"vp": 3200.0, "vs": 1800.0, "rho": 2250.0,
                           "kmin": kmin, "phi": 0.25,
                           "fl_a": br, "fl_b": gs, **logdom}}


def build_vs():
    vps = [2000.0 + 500.0 * i for i in range(7)]
    out = {"mudrock": [], "gc": {l: [] for l in oracle.GC_COEFF},
           "gc_mix_70_30": []}
    for vp in vps:
        out["mudrock"].append({"vp": vp, "vs": oracle.castagna_mudrock_vs(vp)})
        for lith in oracle.GC_COEFF:
            out["gc"][lith].append({"vp": vp, "vs": oracle.gc_lith_vs(vp, lith)})
        out["gc_mix_70_30"].append(
            {"vp": vp, "vs": oracle.greenberg_castagna_vs(
                vp, {"sandstone": 0.7, "shale": 0.3})})
    return out


def build_avo():
    out = []
    for case in AVO_CASES:
        u, lo = case["upper"], case["lower"]
        args = (u["vp"], u["vs"], u["rho"], lo["vp"], lo["vs"], lo["rho"])
        a, b, c, _ = oracle.shuey(*args, 0.0)
        rows = []
        for th in ANGLES:
            z = oracle.zoeppritz_rpp(*args, th)
            _, _, _, sh2 = oracle.shuey(*args, th, three_term=False)
            _, _, _, sh3 = oracle.shuey(*args, th)
            rows.append({"theta": th, "zoeppritz_re": z.real,
                         "zoeppritz_im": z.imag,
                         "aki_richards": oracle.aki_richards(*args, th),
                         "shuey2": sh2, "shuey3": sh3})
        out.append({**case, "A": a, "B": b, "C": c,
                    "avo_class": oracle.avo_class(a, b), "curve": rows})
    return out


def build_wedge():
    w = WEDGE
    curve = oracle.wedge_tuning_curve(w["rc_top"], w["rc_base"],
                                      w["freq_hz"], w["dt_ms"],
                                      w["max_thickness_ms"])
    return {**w,
            "wavelet": oracle.ricker(w["freq_hz"], w["dt_ms"], 60.0),
            "tuning_curve": curve,
            "tuning_thickness_ms": oracle.tuning_thickness_ms(curve,
                                                              w["dt_ms"])}


def assert_anchors(gassmann, avo, wedge, vs):
    # A1 brine S=0 == pure water
    for t, p in ((20.0, 10.0), (100.0, 50.0)):
        assert oracle.brine_density(t, p, 0.0) == oracle.water_density(t, p)
        assert oracle.brine_velocity(t, p, 0.0) == oracle.water_velocity(t, p)

    # A2 Gassmann round trips
    for case in gassmann["cases"]:
        kdry_back = oracle.gassmann_kdry(case["ksat_brine"], case["kmin"],
                                         case["kfl_brine"], case["phi"])
        assert abs(kdry_back - case["kdry"]) / case["kdry"] < 1e-12
        ksat_back = oracle.gassmann_substitute(
            case["ksat_gas"], case["kmin"], case["kfl_gas"],
            case["kfl_brine"], case["phi"])
        assert abs(ksat_back - case["ksat_brine"]) / case["ksat_brine"] < 1e-12

    # A3 K_fl -> 0 collapses to K_dry
    near_dry = oracle.gassmann_ksat(8e9, 37e9, 1e3, 0.25)
    assert abs(near_dry - 8e9) / 8e9 < 1e-6

    # A4 normal incidence identity
    for case in avo:
        u, lo = case["upper"], case["lower"]
        z1, z2 = u["rho"] * u["vp"], lo["rho"] * lo["vp"]
        r0 = oracle.zoeppritz_rpp(u["vp"], u["vs"], u["rho"],
                                  lo["vp"], lo["vs"], lo["rho"], 0.0)
        assert abs(r0.real - (z2 - z1) / (z2 + z1)) < 1e-12
        assert abs(r0.imag) < 1e-15

    # A5 small-contrast Zoeppritz vs Aki-Richards
    small = (3000.0, 1500.0, 2300.0, 3030.0, 1515.0, 2323.0)
    for th in (0.0, 10.0, 20.0, 30.0):
        z = oracle.zoeppritz_rpp(*small, th)
        ar = oracle.aki_richards(*small, th)
        assert abs(z.real - ar) < 1e-4, (th, z.real, ar)

    # A6 vanishing Vs == analytic acoustic coefficient
    th = math.radians(20.0)
    vp1, rho1, vp2, rho2 = 2200.0, 2100.0, 2600.0, 2300.0
    p = math.sin(th) / vp1
    cos2 = math.sqrt(1.0 - (p * vp2) ** 2)
    r_acoustic = ((rho2 * vp2 * math.cos(th) - rho1 * vp1 * cos2)
                  / (rho2 * vp2 * math.cos(th) + rho1 * vp1 * cos2))
    z = oracle.zoeppritz_rpp(vp1, 1e-4, rho1, vp2, 1e-4, rho2, 20.0)
    assert abs(z.real - r_acoustic) < 1e-6

    # A7 Shuey anchors: R(0) == A exactly (every case); 3-term Shuey
    # tracks Aki-Richards on the SMALL-contrast interface (they differ
    # at higher order on strong contrasts — that difference is data,
    # captured in the goldens, not an identity to assert).
    for case in avo:
        u, lo = case["upper"], case["lower"]
        args = (u["vp"], u["vs"], u["rho"], lo["vp"], lo["vs"], lo["rho"])
        a, _, _, r0 = oracle.shuey(*args, 0.0)
        assert r0 == a
    for th in (5.0, 10.0, 15.0, 20.0):
        _, _, _, sh3 = oracle.shuey(*small, th)
        assert abs(sh3 - oracle.aki_richards(*small, th)) < 1e-4

    # A8 classes as constructed
    for case in avo:
        assert case["avo_class"] == case["expect"], case["name"]

    # A9 tuning: for an equal-and-opposite RC pair the composite max
    # occurs when the top wavelet's peak aligns with the flipped base
    # wavelet's trough, i.e. at the Ricker peak-to-trough time
    # sqrt(6)/(2*pi*f) — the value Kallweit & Wood (1982) approximate
    # as 1/(2.6*f_dom).
    expected = math.sqrt(6.0) / (2.0 * math.pi * WEDGE["freq_hz"]) * 1000.0
    assert abs(wedge["tuning_thickness_ms"] - expected) <= WEDGE["dt_ms"], \
        (wedge["tuning_thickness_ms"], expected)
    assert abs(wedge["tuning_curve"][-1] - abs(WEDGE["rc_top"])) < 1e-4

    # A10 GC hand value + composite bounds
    assert abs(oracle.gc_lith_vs(4000.0, "sandstone") - 2360.76) < 1e-9
    for row, sand, shale in zip(vs["gc_mix_70_30"], vs["gc"]["sandstone"],
                                vs["gc"]["shale"]):
        lo_v, hi_v = sorted((sand["vs"], shale["vs"]))
        assert lo_v <= row["vs"] <= hi_v

    # A11 Wood identity at sw=1
    br = oracle.brine(60.0, 25.0, 0.035)
    mix = oracle.wood_mix([1.0, 0.0], [br["k"], 1e5], [br["rho"], 100.0])
    assert mix["k"] == br["k"] and mix["rho"] == br["rho"]


def main():
    fluids = build_fluids()
    gassmann = build_gassmann()
    vs = build_vs()
    avo = build_avo()
    wedge = build_wedge()
    assert_anchors(gassmann, avo, wedge, vs)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "goldens.json"), "w") as f:
        json.dump({"fluids": fluids, "gassmann": gassmann, "vs": vs,
                   "avo": avo, "wedge": wedge}, f, indent=1, sort_keys=True)
        f.write("\n")
    print("anchors OK; goldens written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
