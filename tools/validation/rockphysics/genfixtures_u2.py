"""Generate the Rock Physics Studio U2 goldens (deterministic,
stdlib-only). Writes test-data/rockphysics/goldens.u2.json and leaves the
G6.0 goldens.json untouched.

main() ASSERTS the anchors before writing:

  B1  Published AVO example, van der Baan and Smit (2006, Geophysics 71,
      C93), model 1 of their Table 1 with the lower P velocity at 3.0 km/s:
      "a polarity reversal occurs twice at incidence angles of 25 and 49
      degrees" and the critical angle is 53 degrees. The exact Zoeppritz
      coefficient must cross zero within half a degree of each, and
      nowhere else before critical.
  B2  Ostrander (1984) gas sand under shale (Vp 3048/2438 m/s, Poisson
      0.40/0.10, density 2.40/2.14): R(0) is the impedance contrast
      -0.1674 and the magnitude grows with angle to 40 degrees.
  B3  A single interface in the gather: the trace value at the interface
      sample equals the Zoeppritz coefficient at that angle (unit-peak
      zero-phase wavelet).
  B4  Constant phase: a 90 degree rotation of a Ricker is antisymmetric
      and a 180 degree rotation is its negative.
  B5  Intercept and gradient: the fit returns A and B exactly from
      two-term data; picked off the exact small-contrast gather to 15
      degrees it matches Shuey's A to 1e-5 and B to 5 percent (the exact
      curve carries the third term).
  B6  Fluid line: B = -A for Vp/Vs = 2 with Gardner's exponent 1/4
      (Castagna, Swan and Foster 1998); interfaces built on that
      background fit the slope.
  B7  Iterative Vs recovers the true gas-sand Vs of a rock whose brine
      state lies on the Greenberg-Castagna line; the direct regression on
      the gas Vp does not.
  B8  Critical-porosity line: the mineral point at zero porosity; the
      frame vanishes at phi_c, where Gassmann collapses to the Reuss
      (suspension) average.
  B9  Gardner: 10,000 ft/s <-> 2.30 g/cc. Faust: 1948 (Z R)^(1/6) ft/s
      equals 2.2888 (Z R)^(1/6) km/s with Z in km (Hacikoylu, Dvorkin and
      Mavko 2006) within 0.01 percent.
  B10 Voigt >= Wood for every mix, equal at the end members.
"""

import json
import math
import os

import oracle
import oracle_u2 as u2

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..",
                   "test-data", "rockphysics")

# van der Baan and Smit (2006) model 1, lower Vp 3.0 km/s (their Figure 2)
VDBS = (2400.0, 980.0, 2200.0, 3000.0, 1755.0, 2000.0)
# Ostrander (1984): shale over gas sand
OSTRANDER = (3048.0, 1244.0, 2400.0, 2438.0, 1625.0, 2140.0)

ANGLES = [0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0]
SHALE = (2900.0, 1330.0, 2290.0)
GAS = (2540.0, 1620.0, 2090.0)
QUARTZ = {"k": 36.6e9, "mu": 45.0e9, "rho": 2650.0}


def build_published():
    return {
        "vdbs": {"model": list(VDBS),
                 "zero_crossings_deg": u2.zero_crossings(VDBS, 0.0, 53.0),
                 "critical_deg": math.degrees(math.asin(VDBS[0] / VDBS[3])),
                 "curve": [{"theta": th,
                            "r": oracle.zoeppritz_rpp(*VDBS, th).real}
                           for th in range(0, 53, 2)]},
        "ostrander": {"model": list(OSTRANDER),
                      "curve": [{"theta": th,
                                 "r": oracle.zoeppritz_rpp(*OSTRANDER,
                                                           th).real}
                                for th in (0.0, 10.0, 20.0, 30.0, 40.0)]},
    }


def build_gather():
    """Shale / gas sand / shale in time, 2 ms, 25 Hz Ricker."""
    dt, n, top, base = 2.0, 151, 60, 80
    vp = [SHALE[0]] * n
    vs = [SHALE[1]] * n
    rho = [SHALE[2]] * n
    for k in range(top, base):
        vp[k], vs[k], rho[k] = GAS
    w = oracle.ricker(25.0, dt, 60.0)
    traces = u2.angle_gather_time(vp, vs, rho, ANGLES, w)
    w40 = u2.rotate_phase(w, 40.0)
    rotated = u2.angle_gather_time(vp, vs, rho, [0.0, 30.0], w40)
    picks = [tr[top] for tr in traces]
    # thick-bed pick (one interface only) for the intercept/gradient anchor
    one_vp = [3000.0] * 60 + [3030.0] * 61
    one_vs = [1500.0] * 60 + [1515.0] * 61
    one_rho = [2300.0] * 60 + [2323.0] * 61
    one = u2.angle_gather_time(one_vp, one_vs, one_rho, ANGLES, w)
    one_picks = [tr[60] for tr in one]
    a, b = u2.fit_intercept_gradient(ANGLES, one_picks)
    a15, b15 = u2.fit_intercept_gradient(ANGLES, one_picks, 15.0)
    return {"dt_ms": dt, "n": n, "top": top, "base": base,
            "freq_hz": 25.0, "angles": ANGLES,
            "shale": list(SHALE), "gas": list(GAS),
            "traces": traces, "picks_top": picks,
            "wavelet_40deg": w40, "rotated_traces": rotated,
            "small_contrast": {"upper": [3000.0, 1500.0, 2300.0],
                               "lower": [3030.0, 1515.0, 2323.0],
                               "picks": one_picks, "a": a, "b": b,
                               "a15": a15, "b15": b15}}


def build_depth_gather():
    """The same three layers in depth at 0.5 m, through depth-to-time."""
    depth, vp, vs, rho = [], [], [], []
    z = 2000.0
    while z <= 2200.0 + 1e-9:
        layer = GAS if 2090.0 <= z < 2130.0 else SHALE
        depth.append(z)
        vp.append(layer[0])
        vs.append(layer[1])
        rho.append(layer[2])
        z += 0.5
    tm = u2.logs_to_time(depth, vp, vs, rho, 2.0)
    w = oracle.ricker(25.0, 2.0, 60.0)
    angles = [0.0, 15.0, 30.0]
    return {"depth_from": 2000.0, "depth_to": 2200.0, "step": 0.5,
            "gas_top": 2090.0, "gas_base": 2130.0, "dt_ms": 2.0,
            "angles": angles, "t_end_ms": tm["t"][-1], "nt": len(tm["t"]),
            "vp_time": tm["vp"], "depth_time": tm["depth"],
            "traces": u2.angle_gather_time(tm["vp"], tm["vs"], tm["rho"],
                                           angles, w)}


def background_points():
    """Interfaces on a Gardner, Vp/Vs = 2 background (small contrasts)."""
    pts = []
    vps = [2600.0 + 37.0 * ((i * 7) % 11) for i in range(40)]
    for i in range(1, len(vps)):
        v1, v2 = vps[i - 1], vps[i]
        if v1 == v2:
            continue
        a, b, _, _ = oracle.shuey(v1, v1 / 2.0, u2.gardner_rho(v1),
                                  v2, v2 / 2.0, u2.gardner_rho(v2), 0.0)
        pts.append((a, b))
    return vps, pts


def build_trend():
    vps, pts = background_points()
    slope = u2.fit_fluid_line(pts)
    ga, gb, _, _ = oracle.shuey(*SHALE, *GAS, 0.0)
    return {"slopes": [{"vs_over_vp": k, "g": 0.25,
                        "slope": u2.background_slope(k)}
                       for k in (0.4, 0.45, 0.5, 0.55, 0.6)],
            "background_vp": vps, "points": [list(p) for p in pts],
            "fit_slope": slope,
            "gas": {"a": ga, "b": gb,
                    "distance": u2.distance_from_line(ga, gb, slope)}}


def build_iterative():
    br = oracle.brine(60.0, 25.0, 0.035)
    gas = oracle.gas(60.0, 25.0, 0.6)
    rows = []
    for vp_b, phi, vsh, sw in ((3200.0, 0.25, 0.0, 0.0),
                               (3600.0, 0.18, 0.2, 0.3),
                               (2800.0, 0.30, 0.1, 0.2)):
        kmin = 37.0e9
        vs_b = u2.gc_sand_shale(vp_b, vsh)
        rho_b = (1.0 - phi) * 2650.0 + phi * br["rho"]
        if sw > 0.0:
            fl = oracle.wood_mix([sw, 1.0 - sw], [br["k"], gas["k"]],
                                 [br["rho"], gas["rho"]])
        else:
            fl = {"k": gas["k"], "rho": gas["rho"]}
        hc = oracle.substitute_vels(vp_b, vs_b, rho_b, kmin, phi, br, fl)
        vs_it, vp_wet, its = u2.iterative_vs(hc["vp"], hc["rho"], phi, kmin,
                                             fl, br, vsh)
        rows.append({"phi": phi, "vsh": vsh, "sw": sw, "kmin": kmin,
                     "brine": {"k": br["k"], "rho": br["rho"]},
                     "fluid": {"k": fl["k"], "rho": fl["rho"]},
                     "vp_brine": vp_b, "vs_brine": vs_b, "rho_brine": rho_b,
                     "vp": hc["vp"], "vs_true": hc["vs"], "rho": hc["rho"],
                     "vs_iterative": vs_it, "vp_brine_recovered": vp_wet,
                     "iterations": its,
                     "vs_direct": u2.gc_sand_shale(hc["vp"], vsh)})
    return rows


def build_templates():
    br = oracle.brine(60.0, 25.0, 0.035)
    gas = oracle.gas(60.0, 25.0, 0.6)
    phis = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]
    q = QUARTZ
    return {"mineral": q, "phic": 0.4,
            "brine": {"k": br["k"], "rho": br["rho"]},
            "gas": {"k": gas["k"], "rho": gas["rho"]},
            "brine_line": [u2.sand_point(q["k"], q["mu"], q["rho"], br["k"],
                                         br["rho"], p) for p in phis],
            "gas_line": [u2.sand_point(q["k"], q["mu"], q["rho"], gas["k"],
                                       gas["rho"], p) for p in phis],
            "mudrock": [u2.mudrock_point(v)
                        for v in (2000.0, 2500.0, 3000.0, 3500.0, 4000.0)]}


def build_pseudo():
    return {"gardner": [{"rho": r, "vp": u2.gardner_vp(r)}
                        for r in (2000.0, 2200.0, 2300.0, 2450.0, 2600.0)],
            "faust": [{"depth_m": z, "rt": r, "vp": u2.faust_vp(z, r)}
                      for z in (500.0, 1000.0, 2500.0, 4000.0)
                      for r in (0.5, 1.0, 5.0, 50.0)]}


def build_voigt():
    br = oracle.brine(60.0, 25.0, 0.035)
    gas = oracle.gas(60.0, 25.0, 0.6)
    rows = []
    for sw in (0.0, 0.1, 0.5, 0.9, 1.0):
        v = u2.voigt_mix([sw, 1.0 - sw], [br["k"], gas["k"]],
                         [br["rho"], gas["rho"]])
        rows.append({"sw": sw, "brine": {"k": br["k"], "rho": br["rho"]},
                     "gas": {"k": gas["k"], "rho": gas["rho"]},
                     "voigt": v})
    return rows


def assert_anchors(pub, gather, dgather, trend, iterative, templates, pseudo,
                   voigt):
    # B1 published reversals and critical angle
    zc = pub["vdbs"]["zero_crossings_deg"]
    assert len(zc) == 2, zc
    assert abs(zc[0] - 25.0) < 0.5 and abs(zc[1] - 49.0) < 0.5, zc
    assert abs(pub["vdbs"]["critical_deg"] - 53.0) < 0.5
    # the Aki-Richards linearisation misses the first reversal by degrees
    ar = [oracle.aki_richards(*VDBS, th) for th in (20.0, 21.0, 22.0)]
    assert ar[0] > 0 > ar[2]

    # B2 Ostrander gas sand
    rs = [row["r"] for row in pub["ostrander"]["curve"]]
    z1, z2 = OSTRANDER[0] * OSTRANDER[2], OSTRANDER[3] * OSTRANDER[5]
    assert abs(rs[0] - (z2 - z1) / (z2 + z1)) < 1e-12
    assert abs(rs[0] + 0.1674) < 5e-4
    assert all(rs[i + 1] < rs[i] < 0 for i in range(len(rs) - 1))

    # B3 isolated interface == the coefficient (small-contrast case has
    # one interface only)
    sc = gather["small_contrast"]
    for th, pick in zip(ANGLES, sc["picks"]):
        r = oracle.zoeppritz_rpp(*sc["upper"], *sc["lower"], th).real
        assert abs(pick - r) < 1e-12, (th, pick, r)

    # B4 constant phase
    w = oracle.ricker(25.0, 2.0, 60.0)
    w90 = u2.rotate_phase(w, 90.0)
    n = len(w)
    assert all(abs(w90[i] + w90[n - 1 - i]) < 1e-9 for i in range(n))
    w180 = u2.rotate_phase(w, 180.0)
    assert all(abs(a + b) < 1e-9 for a, b in zip(w, w180))

    # B5 intercept and gradient off the gather vs Shuey
    a, b, _, _ = oracle.shuey(*sc["upper"], *sc["lower"], 0.0)
    two_term = [a + b * math.sin(math.radians(th)) ** 2 for th in ANGLES]
    fa, fb = u2.fit_intercept_gradient(ANGLES, two_term)
    assert abs(fa - a) < 1e-12 and abs(fb - b) < 1e-12
    # the exact curve carries Shuey's third term, so a two-term fit of it
    # drifts with the angle range: to 15 degrees A agrees to 1e-5 and B to
    # 5 percent
    assert abs(sc["a15"] - a) < 1e-5 and abs(sc["b15"] - b) < 0.05 * abs(b), \
        (sc["a15"], a, sc["b15"], b)

    # B6 fluid line
    assert abs(u2.background_slope(0.5) + 1.0) < 1e-15
    assert abs(trend["fit_slope"] + 1.0) < 0.02, trend["fit_slope"]
    assert trend["gas"]["distance"] < -0.05

    # B7 iterative Vs
    for row in iterative:
        assert abs(row["vs_iterative"] - row["vs_true"]) / row["vs_true"] \
            < 1e-9, row
        assert abs(row["vs_direct"] - row["vs_true"]) / row["vs_true"] \
            > 0.02, row

    # B8 critical porosity
    p0 = templates["brine_line"][0]
    q = QUARTZ
    assert abs(p0["vp"] - math.sqrt((q["k"] + 4 * q["mu"] / 3) / q["rho"])) \
        < 1e-9
    br = templates["brine"]
    near = u2.sand_point(q["k"], q["mu"], q["rho"], br["k"], br["rho"],
                         0.4 * (1.0 - 1e-9))
    reuss = 1.0 / (0.4 / br["k"] + 0.6 / q["k"])
    assert abs(near["k"] - reuss) / reuss < 1e-6
    ais = [p["ai"] for p in templates["brine_line"]]
    assert all(ais[i + 1] < ais[i] for i in range(len(ais) - 1))
    for pb, pg in zip(templates["brine_line"][1:], templates["gas_line"][1:]):
        assert pg["ai"] < pb["ai"] and pg["vpvs"] < pb["vpvs"]

    # B9 Gardner and Faust published forms
    assert abs(u2.gardner_vp(2300.0) / M_PER_FT - 10000.0) < 1e-6
    assert abs(u2.gardner_rho(10000.0 * M_PER_FT) - 2300.0) < 1e-9
    for z_km, r in ((1.0, 1.0), (2.5, 4.0)):
        hdm = 2288.8 * (z_km * r) ** (1.0 / 6.0)
        assert abs(u2.faust_vp(z_km * 1000.0, r) - hdm) / hdm < 1e-4

    # B10 Voigt against Wood
    for row in voigt:
        sw = row["sw"]
        wood = oracle.wood_mix([sw, 1.0 - sw],
                               [row["brine"]["k"], row["gas"]["k"]],
                               [row["brine"]["rho"], row["gas"]["rho"]])
        assert row["voigt"]["k"] >= wood["k"] * (1.0 - 1e-12)
        if sw in (0.0, 1.0):
            assert abs(row["voigt"]["k"] - wood["k"]) / wood["k"] < 1e-12
        assert abs(row["voigt"]["rho"] - wood["rho"]) < 1e-9


M_PER_FT = u2.M_PER_FT


def main():
    pub = build_published()
    gather = build_gather()
    dgather = build_depth_gather()
    trend = build_trend()
    iterative = build_iterative()
    templates = build_templates()
    pseudo = build_pseudo()
    voigt = build_voigt()
    assert_anchors(pub, gather, dgather, trend, iterative, templates, pseudo,
                   voigt)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "goldens.u2.json"), "w") as f:
        json.dump({"published": pub, "gather": gather,
                   "depth_gather": dgather, "trend": trend,
                   "iterative_vs": iterative, "templates": templates,
                   "pseudo_sonic": pseudo, "voigt": voigt},
                  f, indent=1, sort_keys=True)
        f.write("\n")
    print("U2 anchors OK; goldens written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
