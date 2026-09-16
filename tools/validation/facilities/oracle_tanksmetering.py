#!/usr/bin/env python3
"""Independent oracle for engines/facilities/storageTank.js and
engines/facilities/metering.js.

WHAT EACH ROUTE CHECKS, AND WHAT IT CANNOT. The honest answer is not
the same for all of them, so each group says its own:

 - `capacity`: the tank volume computed entirely in SI, in metres and
   cubic metres, and converted to barrels through 0.158987294928 m3.
   This checks the ASSEMBLY: the cross section, the height, and the cap
   on the fill. IT DOES NOT CHECK THE BARREL, and saying otherwise
   would be the kind of claim this wave exists to remove: the SI value
   of a barrel is 42 * 231 * 25.4^3 by definition, so it is the module's
   own packaging carried through exact conversions rather than a second
   opinion on it. That a barrel is 42 gallons and not 55 is pinned by a
   LITERAL in the suite, because the capacity test used to assert only
   that the module agreed with itself and 55 gallons was invisible.

 - `shell`: the API 650 one-foot method re-derived in SI (rho g H D
   over 2 S) so the 2.6 field constant is CHECKED rather than repeated.
   It cannot check the ONE FOOT itself: that offset is recovered from
   the engine numerically and pinned by a literal in the suite instead,
   because a two-foot method planted in this file and the module
   together used to leave the suite green.

 - `movement`: liquid movement venting through the same SI path, which
   checks the assembly and the high-volatility doubling. The barrel
   inside it is definitional, exactly as in `capacity`.

 - `thermal`: the proportional thermal rate and the governing-case
   predicate. A transcription of a stated engine choice, and it says
   so; the value of this route is the OVERLAP with `movement` in
   `normalVenting` and the governing-case label.

 - `fireDuty`: the wetted-area heat input bands evaluated in SI
   (square metres and watts) and converted back, plus the RATIO ACROSS
   EACH BAND EDGE. The band constants themselves have no source here,
   but four power laws that must join up at 200, 1000 and 2800 ft2
   cannot all be moved independently, so the continuity ratios pin all
   eight of them against each other. This oracle produces NO VENT
   CAPACITY: the module withholds it, because the API 2000 air
   equivalence relation is not in this repository.

 - `evaporative`: the standing and working losses computed entirely in
   SI, with the vapour density from the SI gas constant and the
   molar mass in kg/mol, and the saturation coefficient converted out
   of its field units. This CHECKS the 10.731 field gas constant, the
   barrel and the whole assembly. It cannot check the empirical 0.053
   or the shape of the expansion factor; literals in the suite pin
   those against silent change.

 - `orifice`: the orifice mass flow computed entirely in SI (kg/s from
   Pa and kg/m3) against the module's field-unit form, so the 32.174,
   144 and 0.0361273 packagings are checked. Genuinely independent.

 - `sizing`: the plate bore for a target flow found by bisection on
   the SI flow route, so the module's own bisection is checked against
   a different arithmetic rather than against itself.

 - `cd`: the Reader-Harris/Gallagher coefficient evaluated in
   ARBITRARY-PRECISION DECIMAL with the terms grouped differently.
   This checks the assembly and the floating-point arithmetic. IT DOES
   NOT CHECK THE PUBLISHED COEFFICIENTS: they have no source in this
   repository, and this file carries the same ones. The suite pins
   them by literal so that changing them here and in the module
   together still fails. Rows that agree bit for bit are a warning
   sign, not a result, so the suite asserts these DISAGREE in the last
   digits.

 - `permanent`: the permanent pressure loss in the published closed
   form, transcribed, and it says so. The real checks on it are the
   two limits (all of the differential lost at beta zero, none at beta
   one) and monotonicity, which are properties rather than values.

 - `transmitter`: the percentage of reading and the DIFFERENTIAL
   turndown against its square-root relation to the flow turndown.

 - `uncertainty`: the root-sum-square checked against a MONTE CARLO
   propagation of 200,000 perturbed samples. Two entirely different
   ways to propagate error. Genuinely independent, including the case
   where the differential term is fed by the transmitter.

stdlib only. Writes test-data/facilities/goldens/tanksmetering_cases.json
"""

import json
import math
import os
import random
from decimal import Decimal, getcontext

getcontext().prec = 60

PSI_TO_PA = 6894.757293168
FT_TO_M = 0.3048
IN_TO_M = 0.0254
LBFT3_TO_KGM3 = 16.01846337396
LB_TO_KG = 0.45359237
INH2O_TO_PA = 249.0889
# the barrel by its SI definition, not by 42 * 231 / 1728
BBL_TO_M3 = 0.158987294928
FT3_TO_M3 = 0.028316846592
# SI gas constant and the molar mass unit, used to re-derive 10.731
R_SI = 8.314462618       # J / (mol K)
BTU_TO_J = 1055.05585262
HR_TO_S = 3600.0


# ------------------------------------------------------------------ #
# capacity: the barrel through its SI definition
# ------------------------------------------------------------------ #

def capacity_si(d_ft, h_ft, fill_ft):
    d_m = d_ft * FT_TO_M
    h_m = h_ft * FT_TO_M
    fill_m = min(fill_ft, h_ft) * FT_TO_M
    area_m2 = math.pi * d_m * d_m / 4.0
    return {
        "diameterFt": d_ft, "heightFt": h_ft, "fillHeightFt": fill_ft,
        "crossSectionFt2": area_m2 / (FT_TO_M ** 2),
        "nominalFt3": area_m2 * h_m / FT3_TO_M3,
        "nominalBbl": area_m2 * h_m / BBL_TO_M3,
        "workingBbl": area_m2 * fill_m / BBL_TO_M3,
        "bblPerFt": area_m2 * FT_TO_M / BBL_TO_M3,
    }


# ------------------------------------------------------------------ #
# shell: the one-foot method re-derived in SI
# ------------------------------------------------------------------ #

def shell_course_si(d_ft, h_ft, sg, s_design_psi, s_test_psi, ca_in):
    """API 650 one-foot method re-derived in SI.

    t = rho g (H - 0.3048) D / (2 S)  with everything in SI, which is
    what the 2.6 constant packages in field units.
    """
    d_m = d_ft * FT_TO_M
    h_m = h_ft * FT_TO_M
    one_ft_m = FT_TO_M
    rho = 1000.0 * sg
    g = 9.80665
    s_d = s_design_psi * PSI_TO_PA
    s_t = s_test_psi * PSI_TO_PA
    head = max(h_m - one_ft_m, 0.0)
    t_d = rho * g * head * d_m / (2.0 * s_d)
    t_t = 1000.0 * g * head * d_m / (2.0 * s_t)
    return {
        "diameterFt": d_ft, "liquidLevelFt": h_ft, "sg": sg,
        "designStressPsi": s_design_psi, "testStressPsi": s_test_psi,
        "corrosionAllowanceIn": ca_in,
        "tDesignIn": t_d / IN_TO_M + ca_in,
        "tTestIn": t_t / IN_TO_M,
    }


# ------------------------------------------------------------------ #
# venting
# ------------------------------------------------------------------ #

def movement_si(fill_bbl_hr, draw_bbl_hr, high_volatility):
    """bbl/hr to scfh through the SI barrel and the SI cubic foot."""
    out_m3 = fill_bbl_hr * BBL_TO_M3 * (2.0 if high_volatility else 1.0)
    in_m3 = draw_bbl_hr * BBL_TO_M3
    return {
        "fillBblPerHr": fill_bbl_hr, "drawBblPerHr": draw_bbl_hr,
        "highVolatility": high_volatility,
        "outbreathingScfh": out_m3 / FT3_TO_M3,
        "inbreathingScfh": in_m3 / FT3_TO_M3,
    }


def normal_venting_si(nominal_bbl, fill_bbl_hr, draw_bbl_hr,
                      high_volatility, latitude_factor, insulated):
    """The whole normal vent, including which case governs."""
    scfh_per_bbl = 1.0
    low_vol_out = 0.6
    insulation_credit = 0.25
    in_thermal = (nominal_bbl * scfh_per_bbl * latitude_factor
                  * (insulation_credit if insulated else 1.0))
    out_thermal = in_thermal if high_volatility else low_vol_out * in_thermal
    m = movement_si(fill_bbl_hr, draw_bbl_hr, high_volatility)
    out = out_thermal + m["outbreathingScfh"]
    inn = in_thermal + m["inbreathingScfh"]
    return {
        "nominalBbl": nominal_bbl, "fillBblPerHr": fill_bbl_hr,
        "drawBblPerHr": draw_bbl_hr, "highVolatility": high_volatility,
        "latitudeFactor": latitude_factor, "insulated": insulated,
        "thermalInbreathingScfh": in_thermal,
        "outbreathingScfh": out,
        "inbreathingScfh": inn,
        "governing": "vacuum (inbreathing)" if inn >= out else "pressure (outbreathing)",
        "vacuumGoverns": inn >= out,
    }


# ------------------------------------------------------------------ #
# fire duty in SI, and the band edges
# ------------------------------------------------------------------ #

FT2_TO_M2 = FT_TO_M ** 2


def fire_duty_si(wetted_ft2, environment_factor=1.0):
    """The wetted-area heat input evaluated in SI and converted back.

    Q = k A^n in field units becomes Q_W = k' A_m2^n with
    k' = k * BTU_TO_J / HR_TO_S / FT2_TO_M2**n, which is the same
    relation carried through a different unit system.
    """
    a_m2 = wetted_ft2 * FT2_TO_M2
    if wetted_ft2 < 200:
        k, n = 20000.0, 1.0
    elif wetted_ft2 < 1000:
        k, n = 199300.0, 0.566
    elif wetted_ft2 < 2800:
        k, n = 963400.0, 0.338
    else:
        k, n = 21000.0, 0.82
    k_si = k * BTU_TO_J / HR_TO_S / (FT2_TO_M2 ** n)
    q_w = k_si * (a_m2 ** n) * environment_factor
    return {
        "wettedFt2": wetted_ft2, "environmentFactor": environment_factor,
        "qBtuHr": q_w * HR_TO_S / BTU_TO_J,
    }


def fire_band_edges():
    """The ratio of the two relations that meet at each band edge.

    Four power laws that have to join up cannot be moved one at a time.
    A ratio here is the join, measured, and the suite requires it to
    stay within a few percent of one.
    """
    rows = []
    for edge in (200.0, 1000.0, 2800.0):
        below = fire_duty_si(edge * (1 - 1e-9))["qBtuHr"]
        above = fire_duty_si(edge * (1 + 1e-9))["qBtuHr"]
        rows.append({"areaFt2": edge, "ratioAcrossEdge": above / below})
    return rows


# ------------------------------------------------------------------ #
# evaporative losses, entirely in SI
# ------------------------------------------------------------------ #

def evaporative_si(d_ft, vapour_space_ft, pva_psia, throughput_bbl,
                   mw=65.0, temp_swing_f=20.0, avg_temp_r=530.0,
                   vent_setting_psi=0.03, atm_psia=14.7,
                   working_turnover=1.0, product_factor=1.0,
                   days_per_year=365):
    """Standing and working loss in SI.

    The vapour density comes from the SI gas constant and a molar mass
    in kg/mol, which is where the module's 10.731 psia ft3 / (lbmol R)
    comes from. The saturation coefficient 0.053, quoted per psia per
    foot, is converted into per pascal per metre rather than reused.
    """
    d_m = d_ft * FT_TO_M
    h_m = vapour_space_ft * FT_TO_M
    v_m3 = math.pi * d_m * d_m / 4.0 * h_m
    p_pa = pva_psia * PSI_TO_PA
    t_k = avg_temp_r / 1.8
    rho_kgm3 = p_pa * (mw / 1000.0) / (R_SI * t_k)
    # expansion factor: dimensionless, and the vent setting and the
    # atmospheric pressure are both pressures, so this is unit-free
    dt_over_t = temp_swing_f / avg_temp_r
    ke = dt_over_t + max(0.0, pva_psia * dt_over_t - vent_setting_psi) / (atm_psia - pva_psia)
    # 0.053 per (psia ft) expressed per (Pa m)
    ks_coeff_si = 0.053 / (PSI_TO_PA * FT_TO_M)
    ks = 1.0 / (1.0 + ks_coeff_si * p_pa * h_m)
    standing_kg = days_per_year * v_m3 * rho_kgm3 * ke * ks
    working_kg = (throughput_bbl * BBL_TO_M3 * rho_kgm3
                  * working_turnover * product_factor) if throughput_bbl > 0 else 0.0
    return {
        "diameterFt": d_ft, "vapourSpaceHeightFt": vapour_space_ft,
        "vapourPressurePsia": pva_psia, "throughputBbl": throughput_bbl,
        "molecularWeight": mw, "tempSwingF": temp_swing_f,
        "vapourSpaceFt3": v_m3 / FT3_TO_M3,
        "vapourDensityLbFt3": rho_kgm3 / LBFT3_TO_KGM3,
        "expansionFactorKe": ke,
        "saturationFactorKs": ks,
        "standingLossLbYr": standing_kg / LB_TO_KG,
        "workingLossLbYr": working_kg / LB_TO_KG,
        "totalLossLbYr": (standing_kg + working_kg) / LB_TO_KG,
    }


# ------------------------------------------------------------------ #
# Reader-Harris/Gallagher in arbitrary-precision decimal
# ------------------------------------------------------------------ #

def _dpow(base, exponent):
    """Decimal power with a fractional exponent, through ln and exp."""
    if base == 0:
        return Decimal(0)
    return (Decimal(exponent) * Decimal(base).ln()).exp()


def rg_cd(beta, re, d_in):
    """Reader-Harris/Gallagher in 60-digit decimal, grouped differently.

    This checks the ASSEMBLY, not the coefficients. The coefficients
    below are the same ones the module carries and neither file has a
    source for them; the suite pins them by literal.
    """
    b = Decimal(repr(beta))
    r = Decimal(repr(re))
    d_mm = Decimal(repr(d_in)) * Decimal("25.4")
    l1 = Decimal("25.4") / d_mm
    m2p = 2 * l1 / (1 - b)
    a = _dpow(Decimal(19000) * b / r, "0.8")
    # grouped as (constant terms) + (Reynolds terms) + (tap terms)
    const_terms = (Decimal("0.5961")
                   + Decimal("0.0261") * b * b
                   - Decimal("0.216") * _dpow(b, 8))
    re_terms = (Decimal("0.000521") * _dpow(Decimal(1000000) * b / r, "0.7")
                + (Decimal("0.0188") + Decimal("0.0063") * a)
                * _dpow(b, "3.5") * _dpow(Decimal(1000000) / r, "0.3"))
    tap_k = (Decimal("0.043")
             + Decimal("0.080") * (Decimal(-10) * l1).exp()
             - Decimal("0.123") * (Decimal(-7) * l1).exp())
    b4 = _dpow(b, 4)
    tap_terms = (tap_k * (1 - Decimal("0.11") * a) * (b4 / (1 - b4))
                 - Decimal("0.031") * (m2p - Decimal("0.8") * _dpow(m2p, "1.1"))
                 * _dpow(b, "1.3"))
    cd = const_terms + re_terms + tap_terms
    if d_mm < Decimal("71.12"):
        cd += Decimal("0.011") * (Decimal("0.75") - b) * (Decimal("2.8") - d_mm / Decimal("25.4"))
    return float(cd)


def expansibility(beta, dp_psi, p1_psia, k):
    tau = (p1_psia - dp_psi) / p1_psia
    return 1.0 - (0.351 + 0.256 * beta ** 4 + 0.93 * beta ** 8) * (1.0 - tau ** (1.0 / k))


def orifice_si(pipe_in, orif_in, dp_inh2o, p1_psia, rho_lbft3, mu_cp, k):
    """Entirely SI: qm = C/sqrt(1-b^4) * eps * A * sqrt(2 dP rho)."""
    beta = orif_in / pipe_in
    d_m = orif_in * IN_TO_M
    dpipe_m = pipe_in * IN_TO_M
    area = math.pi * d_m * d_m / 4.0
    dp_pa = dp_inh2o * INH2O_TO_PA
    rho = rho_lbft3 * LBFT3_TO_KGM3
    mu = mu_cp * 1e-3
    eps = expansibility(beta, dp_inh2o * 0.0361273, p1_psia, k)
    cd = 0.61
    m_kgs = 0.0
    re = 1e5
    for _ in range(80):
        m_kgs = (cd / math.sqrt(1.0 - beta ** 4)) * eps * area * math.sqrt(2.0 * dp_pa * rho)
        v = m_kgs / (rho * math.pi * dpipe_m * dpipe_m / 4.0)
        re = rho * v * dpipe_m / mu
        cn = rg_cd(beta, max(re, 1.0), pipe_in)
        if abs(cn - cd) < 1e-14:
            cd = cn
            break
        cd = cn
    return {
        "pipeIdIn": pipe_in, "orificeIdIn": orif_in, "dpInH2O": dp_inh2o,
        "p1Psia": p1_psia, "densityLbFt3": rho_lbft3, "viscosityCp": mu_cp,
        "k": k,
        "beta": beta, "cd": cd, "expansibility": eps, "reynolds": re,
        "massLbHr": m_kgs * 3600.0 / LB_TO_KG,
    }


def size_orifice_si(pipe_in, target_lb_hr, dp_inh2o, p1_psia, rho_lbft3, mu_cp, k):
    """Bisect the SI flow route for the bore that passes a target."""
    lo, hi = 0.1, 0.75

    def flow(b):
        return orifice_si(pipe_in, b * pipe_in, dp_inh2o, p1_psia,
                          rho_lbft3, mu_cp, k)["massLbHr"]

    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if flow(mid) < target_lb_hr:
            lo = mid
        else:
            hi = mid
    beta = 0.5 * (lo + hi)
    return {
        "pipeIdIn": pipe_in, "targetMassLbHr": target_lb_hr,
        "dpInH2O": dp_inh2o, "p1Psia": p1_psia,
        "densityLbFt3": rho_lbft3, "viscosityCp": mu_cp, "k": k,
        "beta": beta, "orificeIdIn": beta * pipe_in,
    }


def permanent_loss(dp_inh2o, beta, cd):
    """The published closed form, transcribed. The real checks on this
    are its two limits and its monotonicity, in the suite."""
    root = math.sqrt(1.0 - beta ** 4 * (1.0 - cd * cd))
    r = (root - cd * beta * beta) / (root + cd * beta * beta)
    return {"dpInH2O": dp_inh2o, "beta": beta, "cd": cd,
            "lossFraction": r, "lossInH2O": r * dp_inh2o}


def transmitter(dp_inh2o, span_inh2o, accuracy_pct_of_span):
    dturn = span_inh2o / dp_inh2o
    return {
        "dpInH2O": dp_inh2o, "spanInH2O": span_inh2o,
        "accuracyPctOfSpan": accuracy_pct_of_span,
        "uncertaintyPctOfReading": accuracy_pct_of_span * span_inh2o / dp_inh2o,
        "differentialTurndown": dturn,
        "flowTurndown": math.sqrt(dturn),
    }


def uncertainty_monte_carlo(beta, uncs, n=200000, seed=99, label=None):
    """Propagate uncertainty by SAMPLING rather than by RSS.

    qm ~ Cd * eps * d^2 / sqrt(1-b^4) * sqrt(dP) * sqrt(rho), with the
    pipe bore entering through beta. Perturb each input by a normal of
    the stated relative sigma and measure the spread.
    """
    rng = random.Random(seed)
    base = None
    vals = []
    for i in range(n + 1):
        if i == 0:
            f = {kk: 1.0 for kk in uncs}
        else:
            f = {kk: 1.0 + rng.gauss(0.0, uncs[kk] / 100.0) for kk in uncs}
        b = beta * f["bore"] / f["pipe"]
        if b <= 0 or b >= 1:
            continue
        q = (f["cd"] * f["eps"] * (f["bore"] ** 2)
             / math.sqrt(1.0 - b ** 4)
             * math.sqrt(f["dp"]) * math.sqrt(f["rho"]))
        # normalise out the beta-independent part of the base
        q *= math.sqrt(1.0 - beta ** 4)
        if i == 0:
            base = q
        else:
            vals.append(q)
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
    return {
        "beta": beta, "uncertainties": uncs, "label": label,
        "monteCarloPct": math.sqrt(var) / base * 100.0,
    }


def main():
    out = {}

    # Conditions here are deliberately OFF the three studios' shipped
    # defaults where a realistic case would otherwise land on them, so
    # that a later capstone can use the app's own defaults without
    # colliding with a golden row.
    out["capacity"] = [
        capacity_si(110.0, 36.0, 30.0),
        capacity_si(48.0, 24.0, 24.0),
        capacity_si(150.0, 48.0, 44.0),
    ]

    out["shell"] = [
        shell_course_si(120.0, 40.0, 0.85, 23200.0, 24900.0, 0.0625),
        shell_course_si(60.0, 32.0, 0.70, 23200.0, 24900.0, 0.0),
        shell_course_si(150.0, 48.0, 1.00, 23200.0, 24900.0, 0.125),
    ]

    out["movement"] = [
        movement_si(450.0, 700.0, False),
        movement_si(450.0, 700.0, True),
        movement_si(0.0, 1200.0, False),
    ]

    out["normalVent"] = [
        normal_venting_si(9000.0, 450.0, 700.0, False, 1.0, False),
        normal_venting_si(9000.0, 1500.0, 100.0, True, 1.0, False),
        normal_venting_si(9000.0, 450.0, 700.0, False, 1.0, True),
        # the tie: equal in both directions, which used to be labelled
        # vacuum with no warning at all
        normal_venting_si(10000.0, 0.0, 0.0, True, 1.0, False),
    ]

    out["fireDuty"] = [fire_duty_si(a) for a in
                       (150.0, 199.0, 201.0, 900.0, 1001.0, 2799.0, 2801.0, 5000.0)]
    out["fireDuty"].append(fire_duty_si(900.0, 0.3))
    out["fireBandEdges"] = fire_band_edges()

    out["evaporative"] = [
        evaporative_si(110.0, 10.0, 1.5, 450000.0),
        evaporative_si(110.0, 10.0, 4.0, 450000.0),
        evaporative_si(110.0, 20.0, 1.5, 450000.0),
        evaporative_si(48.0, 6.0, 0.8, 30000.0, mw=72.0, temp_swing_f=30.0),
    ]

    out["orifice"] = [
        orifice_si(6.065, 3.0, 100.0, 500.0, 2.5, 0.012, 1.3),
        orifice_si(10.02, 5.0, 50.0, 900.0, 4.0, 0.013, 1.28),
        orifice_si(4.026, 1.5, 200.0, 300.0, 1.8, 0.011, 1.3),
        # small bore, so the below-2.8-inch correction is reachable
        orifice_si(2.067, 1.0, 150.0, 400.0, 2.2, 0.011, 1.3),
    ]

    out["sizing"] = [
        size_orifice_si(6.065, 45000.0, 90.0, 500.0, 2.5, 0.012, 1.3),
        size_orifice_si(10.02, 200000.0, 120.0, 900.0, 4.0, 0.013, 1.28),
    ]

    out["cd"] = []
    for beta, re, d in [(0.3, 1e5, 6.065), (0.5, 5e5, 10.02), (0.65, 2e6, 10.02),
                        (0.4, 1e4, 4.026), (0.45, 3e5, 2.067)]:
        out["cd"].append({"beta": beta, "reynolds": re, "pipeIdIn": d,
                          "cd": rg_cd(beta, re, d)})

    out["permanent"] = [
        permanent_loss(100.0, 0.3, 0.6035),
        permanent_loss(100.0, 0.7, 0.6045),
        permanent_loss(250.0, 0.5, 0.6050),
    ]

    out["transmitter"] = [
        transmitter(100.0, 200.0, 0.075),
        transmitter(10.0, 100.0, 0.075),
        transmitter(80.0, 100.0, 0.1),
    ]

    out["uncertainty"] = [
        uncertainty_monte_carlo(0.5, {
            "cd": 0.5, "eps": 0.2, "bore": 0.05, "pipe": 0.1, "dp": 0.5, "rho": 0.3,
        }, label="typed differential"),
        uncertainty_monte_carlo(0.65, {
            "cd": 0.5, "eps": 0.2, "bore": 0.05, "pipe": 0.1, "dp": 2.0, "rho": 0.3,
        }, label="typed differential, loose"),
        # the transmitter-fed case: 0.075 percent of a 200 in H2O span
        # read at 40 in H2O is 0.375 percent of reading
        uncertainty_monte_carlo(0.5, {
            "cd": 0.5, "eps": 0.2, "bore": 0.05, "pipe": 0.1, "dp": 0.375, "rho": 0.3,
        }, label="transmitter fed, 40 of 200 in H2O"),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "tanksmetering_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
