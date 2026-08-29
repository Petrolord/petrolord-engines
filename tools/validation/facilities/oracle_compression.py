#!/usr/bin/env python3
"""Independent oracle for engines/facilities/compression.js.

Independent routes:
 - polytropic head by NUMERICAL INTEGRATION of the reversible work
   integral, int(v dp) along the polytropic path p v^n = const, rather
   than the closed form the module evaluates. Same physics, different
   mathematics.
 - discharge temperature by marching the path in small pressure steps
   against the closed exponential.
 - stage count found by brute-force search over stage numbers.
 - power converted through SI (watts) rather than the 33000
   ft.lbf/min horsepower packaging, so that constant is checked.

Z is passed in from the JS side's own correlation for the head cases
(it is validated in its own domain and re-deriving DAK here would be
copying, not checking).

stdlib only. Writes test-data/facilities/goldens/compression_cases.json
"""

import json
import math
import os

R_UNIVERSAL = 1545.349
MW_AIR = 28.9625
LBMOL_SCF = 379.49
FT_LBF_TO_J = 1.35581794833
LBM_TO_KG = 0.45359237
HP_TO_W = 745.6998715822702


def poly_head_by_integration(z_avg, mw, t1_r, ratio, n_exp, steps=200000):
    """Head = int_1^r v dp along p v^n = const, per unit mass.

    With v = Z R T / (MW p) and T = T1 (p/p1)^((n-1)/n), substitute
    x = p/p1 so the integral is over x from 1 to r:
        H = (Z R T1 / MW) * int_1^r x^((n-1)/n) / x dx
    Evaluate that integral by Simpson's rule rather than in closed
    form.
    """
    e = (n_exp - 1.0) / n_exp
    a = 1.0
    b = ratio
    h = (b - a) / steps

    def f(x):
        return x ** e / x

    total = f(a) + f(b)
    for i in range(1, steps):
        total += (4 if i % 2 else 2) * f(a + i * h)
    integral = total * h / 3.0
    return (z_avg * R_UNIVERSAL / mw) * t1_r * integral


def discharge_temp_by_marching(t1_r, ratio, e, steps=100000):
    """March T along the path: dT/T = e dp/p."""
    t = t1_r
    ln_step = math.log(ratio) / steps
    for _ in range(steps):
        t *= math.exp(e * ln_step)
    return t


def stage_count_brute(p1, p2, t1_f, k, eta, max_ratio, max_t_f):
    overall = p2 / p1
    t1_r = t1_f + 459.67
    e = (k - 1.0) / (k * eta)
    best = None
    for n in range(1, 13):
        r = overall ** (1.0 / n)
        t_out = t1_r * r ** e - 459.67
        if r <= max_ratio and t_out <= max_t_f:
            best = n
            break
    return {
        "pSuctionPsia": p1, "pDischargePsia": p2, "tSuctionF": t1_f,
        "k": k, "polytropicEfficiency": eta,
        "maxRatioPerStage": max_ratio, "maxDischargeF": max_t_f,
        "overallRatio": overall,
        "stages": best,
    }


def power_via_si(mass_lb_hr, head_ft_lbf_lbm, eta):
    """Power through SI watts, so the 33000 packaging is checked."""
    mass_kg_s = mass_lb_hr * LBM_TO_KG / 3600.0
    head_j_kg = head_ft_lbf_lbm * FT_LBF_TO_J / LBM_TO_KG
    watts = mass_kg_s * head_j_kg / eta
    return watts / HP_TO_W


def stage_case(q, p1, t1_f, ratio, sg, k, eta, z_avg):
    mw = MW_AIR * sg
    t1_r = t1_f + 459.67
    e = (k - 1.0) / (k * eta)
    n_exp = 1.0 / (1.0 - e)
    head = poly_head_by_integration(z_avg, mw, t1_r, ratio, n_exp)
    t2_r = discharge_temp_by_marching(t1_r, ratio, e)
    lbmol_hr = q * 1e6 / LBMOL_SCF / 24.0
    mass = lbmol_hr * mw
    hp = power_via_si(mass, head, eta)
    return {
        "qMMscfd": q, "pSuctionPsia": p1, "tSuctionF": t1_f,
        "ratio": ratio, "gasSg": sg, "k": k,
        "polytropicEfficiency": eta, "zAvg": z_avg,
        "massLbHr": mass,
        "headPolyFtLbfLbm": head,
        "tDischargeF": t2_r - 459.67,
        "gasHp": hp,
    }


def main():
    out = {}

    out["staging"] = [
        stage_count_brute(100.0, 1000.0, 100.0, 1.28, 0.75, 4.0, 300.0),
        stage_count_brute(50.0, 1200.0, 90.0, 1.30, 0.72, 4.0, 250.0),
        stage_count_brute(200.0, 600.0, 110.0, 1.25, 0.78, 4.0, 300.0),
    ]

    # z_avg comes from the module's own DAK correlation, which is
    # validated in its own domain: re-deriving it here would be copying
    # rather than checking. What IS checked here is the head integral,
    # the temperature march and the horsepower packaging.
    out["stages"] = [
        stage_case(20.0, 100.0, 100.0, 3.16, 0.65, 1.28, 0.75, 0.9868689785338047),
        stage_case(50.0, 300.0, 110.0, 2.50, 0.70, 1.26, 0.78, 0.9569861441882238),
        stage_case(5.0, 60.0, 90.0, 4.00, 0.60, 1.30, 0.72, 0.9934266964619575),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "compression_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
