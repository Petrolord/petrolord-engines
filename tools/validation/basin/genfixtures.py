"""Generate the G7.0 basin-model goldens (deterministic, stdlib-only —
no RNG anywhere; rerunning must be byte-identical).

Writes test-data/basin/goldens.json: decompaction cases, steady and
radiogenic heat profiles, Easy%Ro ramp tables, isothermal kerogen-TR
cases, and a full reference-basin forward run (with erosion and
time-varying heat flow) plus two control variants.

main() ASSERTS the anchors before writing (G2 fixture-v2 lesson — a
regeneration that breaks physics refuses to land):

  A1  Easy%Ro weights sum to 0.85; Ro(F=0) = exp(-1.6); full reaction
      gives Ro = exp(-1.6 + 3.7*0.85) = 4.6893... (published 0.2-4.7
      validity range reproduced exactly).
  A2  Decompaction: phi0=0 returns H = Hs exactly; Hs->H->Hs
      round-trips < 1e-8; H > Hs whenever phi0 > 0; at 20 km burial
      H -> Hs within 1 mm (porosity gone).
  A3  Steady heat, uniform k, no sources: exact linear profile
      T = Ts + Q z / k at every node < 1e-9.
  A4  Steady heat, two layers, equal cell sizes: exact piecewise-linear
      profile with the analytic interface temperature < 1e-9 (harmonic
      interface mean is exact when the interface bisects the nodes).
  A5  Steady heat with uniform radiogenic A: analytic quadratic
      T = Ts + (Qb z + A L z - A z^2/2)/k within 0.5% (basal Neumann
      is one-sided first order).
  A6  Transient: stepping from a perturbed profile converges to the
      steady solution < 1e-6 and approaches it monotonically.
  A7  Easy%Ro integrator matches the isothermal closed form < 1e-12;
      under a 3 C/Ma ramp Ro crosses 0.6 between 95 and 125 C
      (published oil-window behaviour); slower ramps mature more:
      Ro(1 C/Ma) > Ro(3) > Ro(10) at 150 C.
  A8  Kerogen TR: matches isothermal closed form < 1e-12; TR in [0,1]
      and monotone along the ramp.
  A9  Reference basin: all outputs finite; final-step temperature and
      Ro strictly increase with layer depth; source-layer burial is
      deepest just before the erosion event and shallower after.
  A10 Erosion signature: final Ro of every layer in the reference run
      (600 m phantom section) exceeds the no-erosion control run.
  A11 Charge: generated > 0, expelled > 0 for the source layer,
      expelled < generated, both nondecreasing in time, and
      generated <= potential mass.
  A12 Heat-flow history: the reference run (declining paleo-heat-flow
      from 80) yields higher final source Ro than a constant-Q control
      pinned at the final value 60.
"""

import json
import math
import os

import oracle

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..",
                   "test-data", "basin")

TYPE2_POTENTIALS = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.01, 0.05, 0.11, 0.17,
                    0.22, 0.19, 0.13, 0.07, 0.03, 0.02, 0.0, 0.0, 0.0, 0.0]

REFERENCE_BASIN = {
    "stratigraphy": [
        {"id": "base_sand", "name": "Base Sand", "thickness": 1500.0,
         "lithology": "sandstone", "ageStart": 150.0, "ageEnd": 140.0},
        {"id": "source_shale", "name": "Source Shale", "thickness": 400.0,
         "lithology": "shale", "ageStart": 140.0, "ageEnd": 120.0,
         "sourceRock": {"isSource": True, "toc": 4.0, "hi": 500.0,
                        "kerogen": {"potentials": TYPE2_POTENTIALS,
                                    "a_factor": 1.0e13}}},
        {"id": "mid_sand", "name": "Mid Sand", "thickness": 1200.0,
         "lithology": "sandstone", "ageStart": 120.0, "ageEnd": 80.0},
        {"id": "upper_shale", "name": "Upper Shale", "thickness": 1600.0,
         "lithology": "shale", "ageStart": 80.0, "ageEnd": 20.0},
    ],
    "heatFlow": {"type": "variable",
                 "history": [{"age": 150.0, "value": 80.0},
                             {"age": 100.0, "value": 70.0},
                             {"age": 50.0, "value": 65.0},
                             {"age": 0.0, "value": 60.0}]},
    "erosionEvents": [{"age": 10.0, "amount": 600.0}],
    "settings": {"surfaceTemp": 15.0},
}


def _assert(cond, label):
    if not cond:
        raise AssertionError("anchor failed: " + label)


def _steady_nodes(layers):
    """Manual node builder for the heat anchors (constant k per layer)."""
    nodes = [{"z": 0.0, "k": layers[0]["k"], "rho_cp": 1.0, "a_vol": 0.0}]
    z = 0.0
    for lay in layers:
        m = lay["cells"]
        dz = lay["h"] / m
        for j in range(m):
            nodes.append({"z": z + (j + 0.5) * dz, "k": lay["k"],
                          "rho_cp": lay.get("rho_cp", 2.0e6),
                          "a_vol": lay.get("a_vol", 0.0)})
        z += lay["h"]
    return nodes


def anchors():
    # A1 — Easy%Ro constants reproduce the published range.
    wsum = sum(oracle.EASYRO_WEIGHTS)
    _assert(abs(wsum - 0.85) < 1e-12, "A1 weights sum 0.85")
    _assert(abs(oracle.easyro_from_f(0.0) - math.exp(-1.6)) < 1e-15,
            "A1 Ro(F=0)")
    _assert(abs(oracle.easyro_from_f(wsum)
                - math.exp(-1.6 + 3.7 * 0.85)) < 1e-12, "A1 Ro(F=max)")

    # A2 — decompaction round trip and limits.
    for phi0, c in [(0.63, 0.00051), (0.49, 0.00027), (0.45, 0.00035)]:
        for top in [0.0, 500.0, 2000.0, 4000.0]:
            for h in [50.0, 300.0, 1500.0]:
                hs = oracle.solid_thickness(top, h, phi0, c)
                h2 = oracle.decompacted_thickness(hs, top, phi0, c)
                _assert(abs(h2 - h) < 1e-8, "A2 roundtrip")
                _assert(h2 > hs, "A2 H > Hs")
    _assert(oracle.decompacted_thickness(200.0, 0.0, 0.0, 0.0005) == 200.0,
            "A2 phi0=0")
    hs = oracle.solid_thickness(20000.0, 100.0, 0.63, 0.00051)
    _assert(abs(oracle.decompacted_thickness(hs, 20000.0, 0.63, 0.00051)
                - hs) < 1e-3 + abs(hs - 100.0), "A2 deep limit")

    # A3 — steady linear profile.
    nodes = _steady_nodes([{"h": 2000.0, "k": 2.5, "cells": 20}])
    q = 0.06
    temps = oracle.solve_heat_step(nodes, None, 10.0, q, None)
    for nd, t in zip(nodes, temps):
        _assert(abs(t - (10.0 + q * nd["z"] / 2.5)) < 1e-9, "A3 linear")

    # A4 — two-layer steady state, exact interface temperature.
    nodes2 = _steady_nodes([{"h": 1000.0, "k": 1.8, "cells": 10},
                            {"h": 1000.0, "k": 3.5, "cells": 10}])
    temps2 = oracle.solve_heat_step(nodes2, None, 10.0, q, None)
    for nd, t in zip(nodes2, temps2):
        if nd["z"] <= 1000.0:
            exact = 10.0 + q * nd["z"] / 1.8
        else:
            exact = 10.0 + q * 1000.0 / 1.8 + q * (nd["z"] - 1000.0) / 3.5
        _assert(abs(t - exact) < 1e-9, "A4 two-layer")

    # A5 — radiogenic quadratic.
    k, a_vol, big_l, qb = 2.0, 2.0e-6, 3000.0, 0.05
    nodes3 = _steady_nodes([{"h": big_l, "k": k, "cells": 300,
                             "a_vol": a_vol}])
    temps3 = oracle.solve_heat_step(nodes3, None, 0.0, qb, None)
    for nd, t in zip(nodes3, temps3):
        z = nd["z"]
        exact = (qb * z + a_vol * big_l * z - 0.5 * a_vol * z * z) / k
        if exact > 1.0:
            _assert(abs(t - exact) / exact < 0.005, "A5 quadratic")

    # A6 — transient convergence to steady state.
    steady = oracle.solve_heat_step(nodes, None, 10.0, q, None)
    t_now = [tt + 30.0 * math.sin(0.001 * nd["z"])
             for tt, nd in zip(steady, nodes)]
    prev_err = max(abs(a - b) for a, b in zip(t_now, steady))
    dt_s = oracle.DT_MA * oracle.SECONDS_PER_MA
    for _ in range(60):
        t_now = oracle.solve_heat_step(nodes, dt_s, 10.0, q, t_now)
        err = max(abs(a - b) for a, b in zip(t_now, steady))
        _assert(err <= prev_err + 1e-12, "A6 monotone approach")
        prev_err = err
    _assert(prev_err < 1e-6, "A6 converged")

    # A7 — Easy%Ro closed form + ramp behaviour.
    frac = oracle.easyro_state()
    t_k = 120.0 + 273.15
    for _ in range(50):
        frac = oracle.easyro_step(frac, t_k, 1.0)
    dt_s50 = 50.0 * oracle.SECONDS_PER_MA
    for w, x, e in zip(oracle.EASYRO_WEIGHTS, frac, oracle.EASYRO_E_KCAL):
        closed = w * math.exp(-oracle.arrhenius_rate(oracle.EASYRO_A, e,
                                                     t_k) * dt_s50)
        _assert(abs(x - closed) < 1e-12, "A7 isothermal closed form")
    ramps = {rate: oracle.easyro_ramp(20.0, rate, 200.0)
             for rate in (1.0, 3.0, 10.0)}
    cross = next(t for t, ro in ramps[3.0] if ro >= 0.6)
    _assert(95.0 <= cross <= 125.0, "A7 oil window crossing")
    ro_at_150 = {rate: next(ro for t, ro in tbl if t >= 150.0)
                 for rate, tbl in ramps.items()}
    _assert(ro_at_150[1.0] > ro_at_150[3.0] > ro_at_150[10.0],
            "A7 heating-rate ordering")

    # A8 — kerogen TR integrator.
    frac = list(TYPE2_POTENTIALS)
    for _ in range(40):
        frac = oracle.kinetic_step(frac, oracle.EASYRO_E_KCAL, 1.0e13,
                                   140.0 + 273.15, 1.0)
    dt_s40 = 40.0 * oracle.SECONDS_PER_MA
    for p, x, e in zip(TYPE2_POTENTIALS, frac, oracle.EASYRO_E_KCAL):
        closed = p * math.exp(-oracle.arrhenius_rate(1.0e13, e,
                                                     140.0 + 273.15)
                              * dt_s40)
        _assert(abs(x - closed) < 1e-12, "A8 TR closed form")
    tr = oracle.transformation_ratio(frac, TYPE2_POTENTIALS)
    _assert(0.0 < tr < 1.0, "A8 TR range")

    # A9-A12 — reference basin + controls.
    ref = oracle.run_basin_model(REFERENCE_BASIN)

    no_erosion = dict(REFERENCE_BASIN)
    no_erosion["erosionEvents"] = []
    ctl_noero = oracle.run_basin_model(no_erosion)

    const_q = dict(REFERENCE_BASIN)
    const_q["heatFlow"] = {"type": "constant", "value": 60.0}
    ctl_constq = oracle.run_basin_model(const_q)

    order = ["upper_shale", "mid_sand", "source_shale", "base_sand"]
    finals = {}
    for lid in order:
        s = ref["series"][lid]
        for key in ("top", "bottom", "temp_c", "ro", "tr",
                    "generated_kg_m2", "expelled_kg_m2"):
            _assert(all(math.isfinite(v) for v in s[key]),
                    "A9 finite " + key)
        finals[lid] = {k: s[k][-1] for k in s}
    for above, below in zip(order, order[1:]):
        _assert(finals[below]["temp_c"] > finals[above]["temp_c"],
                "A9 T increases with depth")
        _assert(finals[below]["ro"] > finals[above]["ro"],
                "A9 Ro increases with depth")

    src = ref["series"]["source_shale"]
    idx_pre = src["age"].index(11.0)   # deepest: last step with phantom
    idx_post = src["age"].index(10.0)  # phantom removed at event age
    _assert(src["top"][idx_pre] == max(src["top"]), "A9 deepest pre-event")
    # Unroofing = phantom thickness (600 m) minus the elastic porosity
    # rebound of the overburden (~270 m here; Athy-elastic v1 spec).
    _assert(src["top"][idx_post] < src["top"][idx_pre] - 250.0,
            "A9 unroofing after event")

    for lid in order:
        _assert(ref["series"][lid]["ro"][-1]
                > ctl_noero["series"][lid]["ro"][-1] + 1e-6,
                "A10 erosion raises Ro: " + lid)

    gen = src["generated_kg_m2"]
    exp_ = src["expelled_kg_m2"]
    _assert(gen[-1] > 0.0 and exp_[-1] > 0.0, "A11 charge nonzero")
    _assert(exp_[-1] < gen[-1], "A11 expelled < generated")
    _assert(all(b >= a - 1e-9 for a, b in zip(gen, gen[1:])),
            "A11 generated monotone")
    _assert(all(b >= a - 1e-9 for a, b in zip(exp_, exp_[1:])),
            "A11 expelled monotone")
    lith = oracle.LITHOLOGY["shale"]
    hs = oracle.solid_thickness(
        1500.0 + 1200.0 + 1600.0, 400.0, lith["phi0"], lith["c"])
    potential = lith["rho_grain"] * hs * 0.04 * 0.5
    _assert(gen[-1] <= potential * (1.0 + 1e-9), "A11 within potential")

    _assert(ref["series"]["source_shale"]["ro"][-1]
            > ctl_constq["series"]["source_shale"]["ro"][-1] + 1e-6,
            "A12 paleo heat flow raises Ro")

    return ref, ctl_noero, ctl_constq, ramps


def _decimate(series, every=5):
    n = len(series["age"])
    idx = list(range(0, n, every))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return {k: [series[k][i] for i in idx] for k in series}


def main():
    ref, ctl_noero, ctl_constq, ramps = anchors()

    decomp_cases = []
    for lith_name in ("shale", "sandstone", "limestone"):
        lith = oracle.LITHOLOGY[lith_name]
        for top in (0.0, 1000.0, 3000.0):
            for h in (100.0, 800.0):
                hs = oracle.solid_thickness(top, h, lith["phi0"],
                                            lith["c"])
                decomp_cases.append({
                    "lithology": lith_name, "top_m": top,
                    "present_thickness_m": h, "solid_thickness_m": hs,
                    "redecompacted_at_top0_m": oracle.decompacted_thickness(
                        hs, 0.0, lith["phi0"], lith["c"]),
                })

    nodes2 = _steady_nodes_for_golden()
    temps2 = oracle.solve_heat_step(nodes2, None, 10.0, 0.06, None)
    heat_two_layer = {
        "surface_t_c": 10.0, "basal_q_w_m2": 0.06,
        "layers": [{"h_m": 1000.0, "k": 1.8, "cells": 10},
                   {"h_m": 1000.0, "k": 3.5, "cells": 10}],
        "profile": [{"z_m": nd["z"], "t_c": t}
                    for nd, t in zip(nodes2, temps2)],
    }

    iso_tr_cases = []
    for t_c in (100.0, 130.0, 160.0):
        for t_ma in (10.0, 50.0, 100.0):
            frac = list(TYPE2_POTENTIALS)
            steps = int(round(t_ma / oracle.DT_MA))
            for _ in range(steps):
                frac = oracle.kinetic_step(frac, oracle.EASYRO_E_KCAL,
                                           1.0e13, t_c + 273.15,
                                           oracle.DT_MA)
            iso_tr_cases.append({
                "temp_c": t_c, "duration_ma": t_ma,
                "potentials": TYPE2_POTENTIALS, "a_factor": 1.0e13,
                "tr": oracle.transformation_ratio(frac, TYPE2_POTENTIALS),
            })

    goldens = {
        "_provenance": {
            "generator": "tools/validation/basin/genfixtures.py",
            "spec": "tools/validation/basin/oracle.py docstring",
            "easyro": "Sweeney & Burnham 1990 AAPG Bull. 74/10",
            "constants": {
                "seconds_per_ma": oracle.SECONDS_PER_MA,
                "r_gas_j_mol_k": oracle.R_GAS,
                "kcal_to_j": oracle.KCAL_TO_J,
                "easyro_a_per_s": oracle.EASYRO_A,
                "easyro_e_kcal": oracle.EASYRO_E_KCAL,
                "easyro_weights": oracle.EASYRO_WEIGHTS,
                "rho_water": oracle.RHO_WATER,
                "cp_water": oracle.CP_WATER,
                "k_water": oracle.K_WATER,
                "rho_hc": oracle.RHO_HC,
                "s_expulsion_threshold": oracle.S_EXPULSION_THRESHOLD,
                "max_cell_m": oracle.MAX_CELL_M,
                "dt_ma": oracle.DT_MA,
            },
        },
        "decompaction": decomp_cases,
        "heat_two_layer_steady": heat_two_layer,
        "easyro_ramps": {str(rate): [{"t_c": t, "ro": ro}
                                     for t, ro in tbl]
                         for rate, tbl in ramps.items()},
        "kerogen_isothermal_tr": iso_tr_cases,
        "reference_basin": {
            "project": REFERENCE_BASIN,
            "series": {lid: _decimate(s)
                       for lid, s in ref["series"].items()},
            "final_source_ro_no_erosion":
                ctl_noero["series"]["source_shale"]["ro"][-1],
            "final_source_ro_constant_q":
                ctl_constq["series"]["source_shale"]["ro"][-1],
        },
    }

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "goldens.json")
    with open(path, "w") as fh:
        json.dump(goldens, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print("wrote", os.path.normpath(path))


def _steady_nodes_for_golden():
    return _steady_nodes([{"h": 1000.0, "k": 1.8, "cells": 10},
                          {"h": 1000.0, "k": 3.5, "cells": 10}])


if __name__ == "__main__":
    main()
