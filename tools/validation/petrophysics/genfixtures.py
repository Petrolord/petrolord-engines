"""Generate the G2.0 petrophysics fixtures + goldens (deterministic,
stdlib-only — no RNG anywhere; rerunning must be byte-identical).

Writes to test-data/petrophysics/:
  typewell.json       input curves + the construction profiles
  goldens.json        oracle outputs for the documented parameter set
  analytic_cases.json hand-derivable scalar cases (see README)

The type well is built ANALYTICALLY so every value is explainable:
a shale-fraction profile s(z) with cosine ramps drives GR; true
porosity follows a compaction trend phi = (PHI_SAND - PHI_GRAD*(z -
2000))*(1-s) — the trend exists so the water leg spans a porosity
RANGE and a Pickett water-line fit is well-posed (fixture v2; v1 had
constant per-zone porosity and non-zero sand baselines, which made
the clean-rock checks vacuous and the water line a single point).
RHOB is constructed by INVERTING the density-porosity equation from a
defined apparent-porosity profile, so the oracle's phi_density
round-trips it exactly; DT likewise via Wyllie; RT is the exact
Archie inversion of a target Sw profile in clean rock (s < 0.01 —
sands are genuinely clean, baseline s = 0), a conductivity-style
blend in the ramps/shales. Fixed null indices exercise None paths.

main() ASSERTS the anchors before writing: clean samples exist, the
clean-zone Archie round trip holds to f64 noise (< 1e-12), and the water-leg Pickett fit
recovers (m, a*Rw) — a regeneration that breaks them refuses to land.
"""

import json
import math
import os

import oracle

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..", "test-data", "petrophysics")

# ---- documented parameter set (goldens are meaningless without it) --------
PARAMS = {
    "gr_clean": 20.0, "gr_clay": 120.0,
    "rho_ma": 2.65, "rho_fl": 1.0, "rho_sh": 2.55,
    "dt_ma": 182.0, "dt_fl": 656.0,          # us/m (sandstone, water)
    "a": 1.0, "m": 2.0, "n": 2.0,
    "rw": 0.05, "rsh": 2.0,
    "phi_sand": 0.25, "phi_grad_per_m": 0.002,   # compaction trend from z=2000
    "water_leg": [2075.0, 2078.0],               # clean Sw=1 window (Pickett anchor)
    "cut_phi": 0.08, "cut_vsh": 0.5, "cut_sw": 0.6,
    "zones": {"SAND_A": [2010.0, 2030.0], "SAND_B": [2050.0, 2080.0]},
}

NULL_IDX = {"GR": [90], "RHOB": [25], "NPHI": [25], "DT": [60], "RT": [150]}

RAMP = 2.0  # m, cosine transition half-width


def shale_fraction(z):
    """Piecewise shale fraction with cosine ramps at each boundary."""
    def ramp(z, z0, lo, hi):
        # cosine transition centred at z0, width 2*RAMP
        if z <= z0 - RAMP:
            return lo
        if z >= z0 + RAMP:
            return hi
        t = (z - (z0 - RAMP)) / (2.0 * RAMP)
        return lo + (hi - lo) * (1.0 - math.cos(math.pi * t)) / 2.0

    # sands are genuinely CLEAN (baseline 0) so s < 0.01 holds through
    # their interiors — the exact-Archie anchors depend on it
    if z < 2010.0:
        return ramp(z, 2010.0, 1.0, 0.0)
    if z < 2030.0:
        s = ramp(z, 2010.0, 1.0, 0.0)
        return max(s, ramp(z, 2030.0, 0.0, 1.0)) if z > 2030.0 - RAMP else s
    if z < 2050.0:
        s = ramp(z, 2030.0, 0.0, 1.0)
        return min(s, ramp(z, 2050.0, 1.0, 0.0)) if z > 2050.0 - RAMP else s
    if z < 2080.0:
        s = ramp(z, 2050.0, 1.0, 0.0)
        return max(s, ramp(z, 2080.0, 0.0, 1.0)) if z > 2080.0 - RAMP else s
    return ramp(z, 2080.0, 0.0, 1.0)


def sw_target(z, s):
    """Target Sw: gas sand A at 0.35; sand B ramps 0.45 (oil) -> 1.0
    (water) linearly 2050->2075, water below; shale 1.0."""
    if s >= 0.99:
        return 1.0
    if z < 2040.0:                     # sand A
        sw = 0.35
    else:                              # sand B
        sw = 0.45 + (1.0 - 0.45) * min(1.0, max(0.0, (z - 2050.0) / 25.0))
    # transitions blend toward shale water
    return sw * (1.0 - s) + 1.0 * s


def build_typewell():
    p = PARAMS
    depth, s_prof, phi_prof, swt_prof = [], [], [], []
    gr, rhob, nphi, dt, rt = [], [], [], [], []
    phi_dsh = (p["rho_ma"] - p["rho_sh"]) / (p["rho_ma"] - p["rho_fl"])  # shale apparent phiD

    for i in range(201):
        z = 2000.0 + 0.5 * i
        s = shale_fraction(z)
        phi = (p["phi_sand"] - p["phi_grad_per_m"] * (z - 2000.0)) * (1.0 - s)
        swt = sw_target(z, s)
        gas = 1.0 if (2010.0 + RAMP) <= z <= (2030.0 - RAMP) else 0.0

        phid_app = phi + s * phi_dsh                       # defined apparent density porosity
        v_rhob = p["rho_ma"] - phid_app * (p["rho_ma"] - p["rho_fl"])
        v_nphi = phi + s * 0.30 - gas * 0.08               # shale raises, gas lowers
        phis_app = phi + s * 0.12
        v_dt = p["dt_ma"] + phis_app * (p["dt_fl"] - p["dt_ma"])
        if s < 0.01:                                       # clean: exact Archie inversion
            v_rt = p["a"] * p["rw"] / (phi ** p["m"] * swt ** p["n"])
        else:                                              # conductivity blend toward Rsh
            c_sand = (phi ** p["m"] * swt ** p["n"]) / (p["a"] * p["rw"]) if phi > 0 else 0.0
            v_rt = 1.0 / ((1.0 - s) * c_sand + s / p["rsh"])
        v_gr = p["gr_clean"] + (p["gr_clay"] - p["gr_clean"]) * s

        depth.append(z)
        s_prof.append(s)
        phi_prof.append(phi)
        swt_prof.append(swt)
        gr.append(None if i in NULL_IDX["GR"] else v_gr)
        rhob.append(None if i in NULL_IDX["RHOB"] else v_rhob)
        nphi.append(None if i in NULL_IDX["NPHI"] else v_nphi)
        dt.append(None if i in NULL_IDX["DT"] else v_dt)
        rt.append(None if i in NULL_IDX["RT"] else v_rt)

    return {
        "params": PARAMS, "null_indices": NULL_IDX,
        "curves": {"DEPT": depth, "GR": gr, "RHOB": rhob, "NPHI": nphi, "DT": dt, "RT": rt},
        "construction": {"shale_fraction": s_prof, "phi_true": phi_prof, "sw_target": swt_prof},
    }


def run_oracle(tw):
    p = PARAMS
    c = tw["curves"]
    depth, gr, rhob, nphi, dt, rt = (c[k] for k in ("DEPT", "GR", "RHOB", "NPHI", "DT", "RT"))

    i_gr = [oracle.igr(g, p["gr_clean"], p["gr_clay"]) for g in gr]
    out = {
        "IGR": i_gr,
        "VSH_LINEAR": i_gr,
        "VSH_LARIONOV_TERTIARY": [oracle.vsh_larionov_tertiary(i) for i in i_gr],
        "VSH_LARIONOV_OLDER": [oracle.vsh_larionov_older(i) for i in i_gr],
        "VSH_CLAVIER": [oracle.vsh_clavier(i) for i in i_gr],
        "VSH_STEIBER": [oracle.vsh_steiber(i) for i in i_gr],
        "PHID": [oracle.phi_density(r, p["rho_ma"], p["rho_fl"]) for r in rhob],
        "PHIS_WYLLIE": [oracle.phi_sonic_wyllie(d, p["dt_ma"], p["dt_fl"]) for d in dt],
        "PHIS_RHG": [oracle.phi_sonic_rhg(d, p["dt_ma"]) for d in dt],
    }
    out["PHIND_AVG"] = [oracle.phi_nd(d, n_, "avg") for d, n_ in zip(out["PHID"], nphi)]
    out["PHIND_RMS"] = [oracle.phi_nd(d, n_, "rms") for d, n_ in zip(out["PHID"], nphi)]

    vsh = out["VSH_LARIONOV_TERTIARY"]
    phi = out["PHID"]
    out["SW_ARCHIE"] = [oracle.sw_archie(r, f, p["rw"], p["a"], p["m"], p["n"]) for r, f in zip(rt, phi)]
    out["SW_SIMANDOUX"] = [oracle.sw_simandoux(r, f, p["rw"], v, p["rsh"], p["a"], p["m"])
                           for r, f, v in zip(rt, phi, vsh)]
    out["SW_INDONESIA"] = [oracle.sw_indonesia(r, f, p["rw"], v, p["rsh"], p["a"], p["m"], p["n"])
                           for r, f, v in zip(rt, phi, vsh)]

    # clamp for the cutoff pass exactly as the engine will: display copy
    sw_c = [None if s is None else min(1.0, max(0.0, s)) for s in out["SW_ARCHIE"]]
    zones = {}
    for name, (top, base) in p["zones"].items():
        flags, summary = oracle.net_pay(depth, phi, vsh, sw_c,
                                        p["cut_phi"], p["cut_vsh"], p["cut_sw"], top, base)
        zones[name] = {"flags": flags, "summary": summary}
    out["ZONES"] = zones

    # Pickett: exact synthetic water line, must recover m and a*Rw exactly
    pts = [(f, p["a"] * p["rw"] / f ** p["m"]) for f in (0.05, 0.08, 0.12, 0.18, 0.25, 0.30)]
    m_fit, arw_fit = oracle.pickett_fit(pts)
    out["PICKETT"] = {"points": pts, "m": m_fit, "a_rw": arw_fit}
    return out


def analytic_cases():
    """Hand-derivable scalar cases — derivations in the README."""
    return {
        "archie_basic": {"in": {"rt": 10.0, "phi": 0.2, "rw": 0.04, "a": 1.0, "m": 2.0, "n": 2.0},
                         "out": oracle.sw_archie(10.0, 0.2, 0.04)},
        "larionov_tertiary_igr1": {"in": {"igr": 1.0}, "out": oracle.vsh_larionov_tertiary(1.0)},
        "larionov_older_igr1": {"in": {"igr": 1.0}, "out": oracle.vsh_larionov_older(1.0)},
        "steiber_igr_half": {"in": {"igr": 0.5}, "out": oracle.vsh_steiber(0.5)},
        "clavier_igr0": {"in": {"igr": 0.0}, "out": oracle.vsh_clavier(0.0)},
        "clavier_igr1": {"in": {"igr": 1.0}, "out": oracle.vsh_clavier(1.0)},
        "phid_matrix": {"in": {"rhob": 2.65, "rho_ma": 2.65, "rho_fl": 1.0}, "out": oracle.phi_density(2.65, 2.65, 1.0)},
        "phid_fluid": {"in": {"rhob": 1.0, "rho_ma": 2.65, "rho_fl": 1.0}, "out": oracle.phi_density(1.0, 2.65, 1.0)},
        "wyllie_matrix": {"in": {"dt": 182.0, "dt_ma": 182.0, "dt_fl": 656.0}, "out": oracle.phi_sonic_wyllie(182.0, 182.0, 656.0)},
        "wyllie_fluid": {"in": {"dt": 656.0, "dt_ma": 182.0, "dt_fl": 656.0}, "out": oracle.phi_sonic_wyllie(656.0, 182.0, 656.0)},
        "rhg_matrix": {"in": {"dt": 182.0, "dt_ma": 182.0}, "out": oracle.phi_sonic_rhg(182.0, 182.0)},
        "arps_75_to_150": {"in": {"rw1": 0.1, "t1_f": 75.0, "t2_f": 150.0}, "out": oracle.rw_arps(0.1, 75.0, 150.0)},
        "sp_quicklook": {"in": {"ssp_mv": -100.0, "rmfe": 0.5, "temp_f": 150.0}, "out": oracle.rwe_from_ssp(-100.0, 0.5, 150.0)},
        "simandoux_vsh0_equals_archie": {
            "in": {"rt": 8.0, "phi": 0.18, "rw": 0.05},
            "simandoux": oracle.sw_simandoux(8.0, 0.18, 0.05, 0.0, 2.0),
            "archie_n2": oracle.sw_archie(8.0, 0.18, 0.05, 1.0, 2.0, 2.0)},
        "indonesia_vsh0_equals_archie": {
            "in": {"rt": 8.0, "phi": 0.18, "rw": 0.05},
            "indonesia": oracle.sw_indonesia(8.0, 0.18, 0.05, 0.0, 2.0),
            "archie": oracle.sw_archie(8.0, 0.18, 0.05)},
    }


def assert_anchors(tw, goldens):
    """Refuse to write fixtures whose analytic anchors don't hold."""
    p = PARAMS
    con = tw["construction"]
    c = tw["curves"]
    clean = [i for i, s in enumerate(con["shale_fraction"]) if s < 0.01]
    assert len(clean) > 40, f"too few clean (s<0.01) samples: {len(clean)}"
    worst = max(abs(goldens["SW_ARCHIE"][i] - con["sw_target"][i])
                for i in clean if goldens["SW_ARCHIE"][i] is not None)
    assert worst < 1e-12, f"clean-zone Archie round-trip error {worst}"
    lo, hi = p["water_leg"]
    pts = [(goldens["PHID"][i], c["RT"][i]) for i, z in enumerate(c["DEPT"])
           if lo <= z <= hi and goldens["PHID"][i] is not None and c["RT"][i] is not None]
    assert len(pts) >= 5, f"water leg has only {len(pts)} valid points"
    m_fit, arw_fit = oracle.pickett_fit(pts)
    assert abs(m_fit - p["m"]) < 1e-9, f"water-leg fit m = {m_fit}"
    assert abs(arw_fit - p["a"] * p["rw"]) < 1e-9, f"water-leg fit a*Rw = {arw_fit}"
    print(f"anchors: {len(clean)} clean samples, round-trip exact, "
          f"water-leg fit m={m_fit:.12f} aRw={arw_fit:.12f}")


def main():
    os.makedirs(OUT, exist_ok=True)
    tw = build_typewell()
    goldens = run_oracle(tw)
    assert_anchors(tw, goldens)
    for name, obj in (("typewell.json", tw), ("goldens.json", goldens),
                      ("analytic_cases.json", analytic_cases())):
        path = os.path.join(OUT, name)
        with open(path, "w") as f:
            json.dump(obj, f, indent=1, sort_keys=True)
            f.write("\n")
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
