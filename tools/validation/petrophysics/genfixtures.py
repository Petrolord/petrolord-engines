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

    # ---- zoned compute golden (PS3): per-zone parameter overrides ---------
    # The golden records ENGINE-spelled patches so the JS test consumes
    # them verbatim; the oracle applies their snake equivalents per depth
    # window. SAND_A overrides the water leg (rw, m), SAND_B loosens the
    # Sw cutoff; everything outside both zones uses the base set. No new
    # physics — the zoned driver composes the already-validated scalars.
    zoned_patches = {"SAND_A": {"rw": 0.03, "m": 1.9}, "SAND_B": {"cutSw": 0.7}}
    zone_windows = [(name, p["zones"][name]) for name in ("SAND_A", "SAND_B")]

    def zone_of(z):
        for name, (top, base) in zone_windows:
            if top <= z <= base:
                return name
        return None

    rw_of = {"SAND_A": 0.03, "SAND_B": p["rw"], None: p["rw"]}
    m_of = {"SAND_A": 1.9, "SAND_B": p["m"], None: p["m"]}
    cutsw_of = {"SAND_A": p["cut_sw"], "SAND_B": 0.7, None: p["cut_sw"]}

    sw_zoned = [oracle.sw_archie(r, f, rw_of[zone_of(z)], p["a"], m_of[zone_of(z)], p["n"])
                for z, r, f in zip(depth, rt, phi)]
    sw_zc = [None if s is None else min(1.0, max(0.0, s)) for s in sw_zoned]
    pay_zoned = []
    # net_pay semantics: a sample with any missing input is NOT pay
    # (flag 0), never null — null is reserved for outside-the-window
    for z, f, v, s in zip(depth, phi, vsh, sw_zc):
        if f is None or v is None or s is None:
            pay_zoned.append(0)
        else:
            pay_zoned.append(1 if (f >= p["cut_phi"] and v <= p["cut_vsh"]
                                   and s <= cutsw_of[zone_of(z)]) else 0)
    zoned_zones = {}
    for name, (top, base) in zone_windows:
        _, summary = oracle.net_pay(depth, phi, vsh, sw_zc,
                                    p["cut_phi"], p["cut_vsh"], cutsw_of[name], top, base)
        zoned_zones[name] = {"summary": summary}
    out["ZONED"] = {"zone_params": zoned_patches, "SW": sw_zoned,
                    "PAY": pay_zoned, "zones": zoned_zones}

    # ---- shaly-sand + temperature goldens (PS5) ---------------------------
    # Documented clay parameter set (b fixed manually so the clay golden
    # decouples from the temperature model; the TEMP golden covers the
    # coupled path with Archie).
    clay = {"qv": 0.1, "b": 3.0, "mStar": 2.0, "nStar": 2.0,
            "rwb": 0.02, "swb": 0.25}
    out["CLAY"] = {
        "params": clay,
        "SW_WS": [oracle.sw_waxman_smits(r, f, p["rw"], clay["qv"], clay["b"],
                                         p["a"], clay["mStar"], clay["nStar"])
                  for r, f in zip(rt, phi)],
        "SW_DW": [oracle.sw_dual_water(r, f, p["rw"], clay["rwb"], clay["swb"],
                                       p["a"], p["m"], p["n"])
                  for r, f in zip(rt, phi)],
        "SW_MS": [oracle.sw_mod_simandoux(r, f, p["rw"], v, p["rsh"],
                                          p["a"], p["m"], p["n"])
                  for r, f, v in zip(rt, phi, vsh)],
    }
    tp = {"surfaceTempC": 25.0, "bhtC": 90.0, "bhtDepthM": 2100.0,
          "rwRefTempC": 25.0}
    temp_c = [oracle.temp_at_depth(z, tp["surfaceTempC"], tp["bhtC"],
                                   tp["bhtDepthM"]) for z in depth]
    rw_t = [oracle.rw_at_temp(p["rw"], tp["rwRefTempC"], t) for t in temp_c]
    out["TEMP"] = {
        "params": tp,
        "TEMP": temp_c,
        "RW_T": rw_t,
        "B_JUHASZ": [oracle.b_juhasz(t) for t in temp_c],
        "SW_ARCHIE_T": [oracle.sw_archie(r, f, w, p["a"], p["m"], p["n"])
                        for r, f, w in zip(rt, phi, rw_t)],
    }

    # ---- permeability + BVW goldens (PS6) ---------------------------------
    # Swirr from the Buckles constant (clamped to 1), the four cited k
    # correlations, BVW on the display-clamped Archie Sw, and the
    # thickness-weighted geometric-mean k per zone over the base pay
    # flags. phi = PHID throughout (the pipeline's default phiSource).
    pp = {"bucklesConst": 0.04, "wrC": 79.0, "wrQ": 3.0}
    swirr = [oracle.swirr_from_buckles(f, pp["bucklesConst"]) for f in phi]
    th = oracle.sample_thickness(depth)
    perm = {
        "params": pp,
        "SWIRR": swirr,
        "K_TIMUR": [oracle.k_timur(f, si) for f, si in zip(phi, swirr)],
        "K_TIXIER": [oracle.k_tixier(f, si) for f, si in zip(phi, swirr)],
        "K_COATES": [oracle.k_coates(f, si) for f, si in zip(phi, swirr)],
        "K_WR_GAS": [oracle.k_wyllie_rose(f, si, pp["wrC"], pp["wrQ"])
                     for f, si in zip(phi, swirr)],
        "BVW": [oracle.bvw(f, s_) for f, s_ in zip(phi, sw_c)],
        "zones": {},
    }
    for name, (top, base) in p["zones"].items():
        flags, _ = oracle.net_pay(depth, phi, vsh, sw_c,
                                  p["cut_phi"], p["cut_vsh"], p["cut_sw"], top, base)
        perm["zones"][name] = {
            "k_gm_timur": oracle.k_geom_mean(perm["K_TIMUR"], flags, th),
        }
    out["PERM"] = perm

    # ---- normalization golden (PS7) ---------------------------------------
    # The target is an exact affine distortion of GR (1.1*GR + 5), so
    # both fits must recover it and applying the fit must give GR back
    # (asserted in assert_anchors before writing).
    gr_target = [None if g is None else 1.1 * g + 5.0 for g in gr]
    tp_shift, tp_scale = oracle.fit_normalization_two_point(gr, gr_target)
    ms_shift, ms_scale = oracle.fit_normalization_meanstd(gr, gr_target)
    out["NORM"] = {
        "target_transform": {"a": 1.1, "b": 5.0},
        "GR_TARGET": gr_target,
        "two_point": {"shift": tp_shift, "scale": tp_scale,
                      "refP": [oracle.percentile(gr, 5.0), oracle.percentile(gr, 95.0)],
                      "targetP": [oracle.percentile(gr_target, 5.0), oracle.percentile(gr_target, 95.0)]},
        "mean_std": {"shift": ms_shift, "scale": ms_scale},
        "GR_RESTORED": oracle.apply_normalization(gr_target, tp_shift, tp_scale),
    }

    # ---- conditioning goldens (PS8) ---------------------------------------
    # Inputs are DERIVED deterministically here and stored in the golden
    # (the typewell itself never changes): fixed spikes on GR, a
    # synthetic DRHO with one washout window, a +1.5 m block shift.
    spikes = {30: 220.0, 75: -80.0, 140: 300.0}
    gr_spiked = [(spikes[i] if i in spikes else g) for i, g in enumerate(gr)]
    drho_syn = [0.3 if 2040.0 <= z <= 2044.0 else 0.02 for z in depth]
    cali_syn = [12.5 if 2060.0 <= z <= 2062.0 else 8.6 for z in depth]
    cnd = {"halfWindow": 5, "nSigma": 3.0, "shiftM": 1.5,
           "bitSize": 8.5, "washoutOver": 2.0, "drhoMax": 0.15,
           "maxGapSamples": 6}
    flags = oracle.bad_hole_flag(cali_syn, cnd["bitSize"], drho_syn,
                                 cnd["washoutOver"], cnd["drhoMax"])
    out["COND"] = {
        "params": cnd,
        "GR_SPIKED": gr_spiked,
        "GR_DESPIKED": oracle.despike_hampel(gr_spiked, cnd["halfWindow"], cnd["nSigma"]),
        "GR_SMOOTH_MEAN": oracle.smooth_mean(gr, 2),
        "GR_SMOOTH_MEDIAN": oracle.smooth_median(gr, 2),
        "GR_SHIFTED": oracle.depth_shift_block(depth, gr, cnd["shiftM"]),
        "DRHO_SYN": drho_syn,
        "CALI_SYN": cali_syn,
        "BADHOLE": flags,
        "RHOB_NULLED": oracle.apply_bad_hole(rhob, flags, "null", cnd["maxGapSamples"]),
        "RHOB_INTERP": oracle.apply_bad_hole(rhob, flags, "interp", cnd["maxGapSamples"]),
    }

    # ---- matrix ID + Hingle goldens (PS10) --------------------------------
    ts_p = {"phiSand": 0.28, "phiSh": 0.1}
    hingle_rw, hingle_slope, hingle_n = oracle.hingle_fit(
        depth, phi, rt, p["water_leg"][0], p["water_leg"][1], p["a"], p["m"])
    out["MATRIX"] = {
        "params": ts_p,
        "RHOMAA": [oracle.rho_maa(r, f, p["rho_fl"]) for r, f in zip(rhob, out["PHIND_AVG"])],
        "TS_NEAREST": [None if (t := oracle.thomas_stieber(f, v, ts_p["phiSand"], ts_p["phiSh"])) is None
                       else t["nearest"]
                       for f, v in zip(out["PHIND_AVG"], vsh)],
        "HINGLE_Y": [oracle.hingle_y(r, p["m"]) for r in rt],
        "hingle_fit": {"rw": hingle_rw, "slope": hingle_slope, "n": hingle_n},
    }
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
        "two_mineral_ss_dol": {
            "in": {"rhob": 2.71, "nphi": 0.0, "m1": [2.65, -0.02], "m2": [2.87, 0.02],
                   "fluid": [1.0, 1.0]},
            "out": oracle.two_mineral_solve(2.71, 0.0, 2.65, -0.02, 2.87, 0.02, 1.0, 1.0)},
        "thomas_stieber_clean": {
            "in": {"phit": 0.28, "vsh": 0.0, "phi_sand": 0.28, "phi_sh": 0.1},
            "out": oracle.thomas_stieber(0.28, 0.0, 0.28, 0.1)},
        "u_maa_quartz": {"in": {"pef": 1.81, "rhob": 2.65, "phi": 0.0},
                         "out": oracle.u_maa(1.81, 2.65, 0.0)},
        "timur_02_02": {"in": {"phi": 0.2, "swirr": 0.2},
                        "out": oracle.k_timur(0.2, 0.2)},
        "tixier_02_02": {"in": {"phi": 0.2, "swirr": 0.2},
                         "out": oracle.k_tixier(0.2, 0.2)},
        "coates_02_02": {"in": {"phi": 0.2, "swirr": 0.2},
                         "out": oracle.k_coates(0.2, 0.2)},
        "wyllie_rose_gas_02_02": {"in": {"phi": 0.2, "swirr": 0.2, "c": 79.0, "q": 3.0},
                                  "out": oracle.k_wyllie_rose(0.2, 0.2, 79.0, 3.0)},
        "swirr_buckles_clamp": {"in": {"phi": 0.03, "const": 0.04},
                                "out": oracle.swirr_from_buckles(0.03, 0.04)},
        "waxman_smits_basic": {
            "in": {"rt": 8.0, "phi": 0.18, "rw": 0.05, "qv": 0.1, "b": 3.0},
            "out": oracle.sw_waxman_smits(8.0, 0.18, 0.05, 0.1, 3.0)},
        "dual_water_basic": {
            "in": {"rt": 8.0, "phit": 0.18, "rwf": 0.05, "rwb": 0.02, "swb": 0.25},
            "out": oracle.sw_dual_water(8.0, 0.18, 0.05, 0.02, 0.25)},
        "mod_simandoux_basic": {
            "in": {"rt": 8.0, "phi": 0.18, "rw": 0.05, "vsh": 0.3, "rsh": 2.0},
            "out": oracle.sw_mod_simandoux(8.0, 0.18, 0.05, 0.3, 2.0)},
        "b_juhasz_80c": {"in": {"t_c": 80.0}, "out": oracle.b_juhasz(80.0)},
        "qv_from_cec": {"in": {"cec": 10.0, "phit": 0.2, "rho_grain": 2.65},
                        "out": oracle.qv_from_cec(10.0, 0.2, 2.65)},
        "temp_linear": {"in": {"z": 2050.0, "surface_c": 25.0, "bht_c": 90.0, "bht_depth_m": 2100.0},
                        "out": oracle.temp_at_depth(2050.0, 25.0, 90.0, 2100.0)},
        "rw_at_temp_25_to_88": {"in": {"rw_ref": 0.05, "ref_c": 25.0, "t_c": 88.452380952380952},
                                "out": oracle.rw_at_temp(0.05, 25.0, 88.452380952380952)},
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
    # Hingle on the exact water leg must recover the construction Rw,
    # and rho_maa with the DENSITY porosity must return the matrix
    # density exactly (the typewell inverts that equation)
    h_rw, _, _ = oracle.hingle_fit(tw["curves"]["DEPT"],
                                   [oracle.phi_density(r, p["rho_ma"], p["rho_fl"]) for r in tw["curves"]["RHOB"]],
                                   tw["curves"]["RT"], p["water_leg"][0], p["water_leg"][1], p["a"], p["m"])
    assert abs(h_rw - p["rw"]) < 1e-9, f"Hingle water-leg fit rw = {h_rw}"
    for r in tw["curves"]["RHOB"][:50]:
        f = oracle.phi_density(r, p["rho_ma"], p["rho_fl"])
        if r is None:
            continue
        rm = oracle.rho_maa(r, f, p["rho_fl"])
        assert abs(rm - p["rho_ma"]) < 1e-9, f"rho_maa round-trip {rm}"
    spikes_a = {30: 220.0, 75: -80.0, 140: 300.0}
    gr_base = tw["curves"]["GR"]
    gr_sp = [(spikes_a[i] if i in spikes_a else g) for i, g in enumerate(gr_base)]
    desp = oracle.despike_hampel(gr_sp, 5, 3.0)
    for i in spikes_a:
        assert abs(desp[i] - gr_sp[i]) > 10.0, f"spike at {i} survived despiking"
    shifted = oracle.depth_shift_block(tw["curves"]["DEPT"], gr_base, 1.5)
    i_chk = 100  # grid step 0.5 -> exactly 3 samples of shift
    assert abs(shifted[i_chk] - gr_base[i_chk - 3]) < 1e-12, "block shift misaligned"
    gr_c = tw["curves"]["GR"]
    gt = [None if g is None else 1.1 * g + 5.0 for g in gr_c]
    for shift, scale in (oracle.fit_normalization_two_point(gr_c, gt),
                         oracle.fit_normalization_meanstd(gr_c, gt)):
        back = oracle.apply_normalization(gt, shift, scale)
        worst_n = max(abs(b - g) for b, g in zip(back, gr_c) if b is not None)
        assert worst_n < 1e-9, f"normalization round-trip error {worst_n}"
    a0 = oracle.sw_archie(8.0, 0.18, 0.05)
    assert abs(oracle.sw_waxman_smits(8.0, 0.18, 0.05, 0.0, 3.0) - a0) < 1e-12, "WS(qv=0) != Archie"
    assert abs(oracle.sw_dual_water(8.0, 0.18, 0.05, 0.02, 0.0) - a0) < 1e-12, "DW(swb=0) != Archie"
    assert abs(oracle.sw_mod_simandoux(8.0, 0.18, 0.05, 0.0, 2.0) - a0) < 1e-12, "MS(vsh=0) != Archie"
    print(f"anchors: {len(clean)} clean samples, round-trip exact, "
          f"water-leg fit m={m_fit:.12f} aRw={arw_fit:.12f}; clay reductions exact")


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
