#!/usr/bin/env python3
"""Independent oracle for engines/facilities/storageTank.js and
engines/facilities/metering.js.

Independent routes:
 - the API 650 one-foot method re-derived in SI (stress in MPa, head
   in metres) so the 2.6 field constant is CHECKED rather than repeated
 - the orifice mass flow computed entirely in SI (kg/s from Pa and
   kg/m3) against the module's field-unit form, so the 32.174 and 144
   packagings are checked
 - the Reader-Harris/Gallagher Cd computed independently from the
   published equation with the terms grouped differently
 - the uncertainty root-sum-square checked against a MONTE CARLO
   propagation: perturb each input by its uncertainty and measure the
   spread of the resulting flow. Two entirely different ways to
   propagate error.

stdlib only. Writes test-data/facilities/goldens/tanksmetering_cases.json
"""

import json
import math
import os
import random

PSI_TO_PA = 6894.757293168
FT_TO_M = 0.3048
IN_TO_M = 0.0254
LBFT3_TO_KGM3 = 16.01846337396
LB_TO_KG = 0.45359237
INH2O_TO_PA = 249.0889


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


def rg_cd(beta, re, d_in):
    """Reader-Harris/Gallagher, grouped differently from the module."""
    d_mm = d_in * 25.4
    l1 = 25.4 / d_mm
    l2p = 25.4 / d_mm
    a = (19000.0 * beta / re) ** 0.8
    m2p = 2.0 * l2p / (1.0 - beta)
    t1 = 0.5961
    t2 = 0.0261 * beta ** 2
    t3 = -0.216 * beta ** 8
    t4 = 0.000521 * (1e6 * beta / re) ** 0.7
    t5 = (0.0188 + 0.0063 * a) * beta ** 3.5 * (1e6 / re) ** 0.3
    t6 = ((0.043 + 0.080 * math.exp(-10.0 * l1) - 0.123 * math.exp(-7.0 * l1))
          * (1.0 - 0.11 * a) * (beta ** 4 / (1.0 - beta ** 4)))
    t7 = -0.031 * (m2p - 0.8 * m2p ** 1.1) * beta ** 1.3
    cd = t1 + t2 + t3 + t4 + t5 + t6 + t7
    if d_mm < 71.12:
        cd += 0.011 * (0.75 - beta) * (2.8 - d_in)
    return cd


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


def uncertainty_monte_carlo(beta, uncs, n=200000, seed=99):
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
        "beta": beta, "uncertainties": uncs,
        "monteCarloPct": math.sqrt(var) / base * 100.0,
    }


def main():
    out = {}

    out["shell"] = [
        shell_course_si(120.0, 40.0, 0.85, 23200.0, 24900.0, 0.0625),
        shell_course_si(60.0, 32.0, 0.70, 23200.0, 24900.0, 0.0),
        shell_course_si(150.0, 48.0, 1.00, 23200.0, 24900.0, 0.125),
    ]

    out["orifice"] = [
        orifice_si(6.065, 3.0, 100.0, 500.0, 2.5, 0.012, 1.3),
        orifice_si(10.02, 5.0, 50.0, 900.0, 4.0, 0.013, 1.28),
        orifice_si(4.026, 1.5, 200.0, 300.0, 1.8, 0.011, 1.3),
    ]

    out["cd"] = []
    for beta, re, d in [(0.3, 1e5, 6.065), (0.5, 5e5, 10.02), (0.65, 2e6, 10.02),
                        (0.4, 1e4, 4.026)]:
        out["cd"].append({"beta": beta, "reynolds": re, "pipeIdIn": d,
                          "cd": rg_cd(beta, re, d)})

    out["uncertainty"] = [
        uncertainty_monte_carlo(0.5, {
            "cd": 0.5, "eps": 0.2, "bore": 0.05, "pipe": 0.1, "dp": 0.5, "rho": 0.3,
        }),
        uncertainty_monte_carlo(0.65, {
            "cd": 0.5, "eps": 0.2, "bore": 0.05, "pipe": 0.1, "dp": 2.0, "rho": 0.3,
        }),
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
