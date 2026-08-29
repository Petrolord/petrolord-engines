#!/usr/bin/env python3
"""Independent oracle for engines/facilities/relief.js.

Implements the PUBLISHED SI FORMS of API 520/521 (the metric constants
the standard prints beside the USC ones), plus first-principles
settling and blowdown in SI, then converts to the USC units the JS
module speaks. Agreement is two published routes meeting:

  gas critical   USC A = W sqrt(TZ/M) / (C520 Kd P1 Kb Kc)
                 SI  A = 13160 W sqrt(TZ/M) / (Csi Kd P1 Kb Kc),
                 A mm2, W kg/h, T K, P kPa(a),
                 Csi = 0.03948 sqrt(k (2/(k+1))^((k+1)/(k-1)))
  gas subcrit    USC 735 F2 ...  <-> SI 17.9 F2 ... (same F2 closed form)
  liquid         USC Q sqrt(G)/(38 Kd Kw Kc Kv sqrt(dP))
                 SI  11.78 Q sqrt(G)/(Kd Kw Kc Kv sqrt(dP)), Q L/min, dP kPa
  steam          USC W/(51.5 P1 ...) <-> SI 190.4 W/(P1 ...) with the
                 same KN closed form in its SI statement
  fire           USC 21000 F A^0.82 <-> SI C=43.2 F A^0.82 (kW, m2)

stdlib only. Writes test-data/facilities/goldens/relief_cases.json
"""

import json
import math
import os

LB = 0.45359237
KG_H_PER_LB_H = LB
IN2_TO_MM2 = 645.16
PSI_TO_KPA = 6.894757293168
GPM_TO_LMIN = 3.785411784
FT2_TO_M2 = 0.09290304
BTU_HR_TO_KW = 0.29307107e-3
FT = 0.3048


def c_si(k):
    return 0.03948 * math.sqrt(k * (2.0 / (k + 1.0)) ** ((k + 1.0) / (k - 1.0)))


def f2(k, r):
    return math.sqrt((k / (k - 1.0)) * r ** (2.0 / k)
                     * (1.0 - r ** ((k - 1.0) / k)) / (1.0 - r))


def gas_case(w_lbhr, p1_psia, p2_psia, t_r, mw, z, k, kd=0.975, kb=1.0, kc=1.0):
    """First-principles isentropic-nozzle route in absolute SI.

    The USC constants 520 (critical C) and 735 (subcritical) are unit
    packagings of the ideal-nozzle mass flux; computing that flux from
    R, M, T and P directly is a genuinely independent derivation, so
    agreement checks the published constants rather than repeating
    them.
      critical:    G = sqrt(k (2/(k+1))^((k+1)/(k-1))) P1 sqrt(M/(ZRT))
      subcritical: G = F2 sqrt(2 rho1 (P1 - P2)),  rho1 = P1 M/(ZRT)
    """
    w = w_lbhr * KG_H_PER_LB_H
    p1 = p1_psia * PSI_TO_KPA * 1000.0   # Pa
    p2 = p2_psia * PSI_TO_KPA * 1000.0
    t_k = t_r / 1.8
    r_gas = 8.314462618
    m_kg = mw / 1000.0
    r_crit = (2.0 / (k + 1.0)) ** (k / (k - 1.0))
    critical = p2 <= r_crit * p1
    if critical:
        c_true = math.sqrt(k * (2.0 / (k + 1.0)) ** ((k + 1.0) / (k - 1.0)))
        g_flux = c_true * p1 * math.sqrt(m_kg / (z * r_gas * t_k))   # kg/(s.m2)
        a_m2 = (w / 3600.0) / (kd * kb * kc * g_flux)
    else:
        rho1 = p1 * m_kg / (z * r_gas * t_k)
        g_flux = f2(k, p2 / p1) * math.sqrt(2.0 * rho1 * (p1 - p2))
        a_m2 = (w / 3600.0) / (kd * kc * g_flux)
    a_mm2 = a_m2 * 1e6
    return {
        "wLbHr": w_lbhr, "p1Psia": p1_psia, "p2Psia": p2_psia, "tR": t_r,
        "mw": mw, "z": z, "k": k, "kd": kd, "kb": kb, "kc": kc,
        "critical": critical, "areaIn2": a_mm2 / IN2_TO_MM2,
    }


def kv(reynolds):
    return 1.0 / (0.9935 + 2.878 / math.sqrt(reynolds) + 342.75 / reynolds ** 1.5)


def liquid_case(q_gpm, p1_psig, p2_psig, sg, mu_cp, kd=0.65, kw=1.0, kc=1.0):
    q = q_gpm * GPM_TO_LMIN
    dp = (p1_psig - p2_psig) * PSI_TO_KPA
    def area_mm2(kv_):
        return 11.78 * q * math.sqrt(sg) / (kd * kw * kc * kv_ * math.sqrt(dp))
    kv_ = 1.0
    a = area_mm2(kv_)
    reynolds = None
    if mu_cp > 0:
        for _ in range(60):
            a_in2 = a / IN2_TO_MM2
            reynolds = q_gpm * 2800.0 * sg / (mu_cp * math.sqrt(a_in2))
            nv = kv(reynolds)
            if abs(nv - kv_) < 1e-12:
                kv_ = nv
                break
            kv_ = nv
            a = area_mm2(kv_)
        a = area_mm2(kv_)
    return {
        "qGpm": q_gpm, "p1Psig": p1_psig, "p2Psig": p2_psig, "sg": sg,
        "muCp": mu_cp, "kd": kd, "kw": kw, "kc": kc,
        "areaIn2": a / IN2_TO_MM2, "kv": kv_,
    }


def steam_case(w_lbhr, p1_psia, ksh=1.0, kd=0.975, kb=1.0, kc=1.0):
    w = w_lbhr * KG_H_PER_LB_H
    p1 = p1_psia * PSI_TO_KPA
    if p1_psia <= 1500.0:
        kn = 1.0
    else:
        # SI statement of the Napier correction (API 520):
        # KN = (0.02764 P1 - 1000) / (0.03324 P1 - 1061), P1 kPa(a)
        kn = (0.02764 * p1 - 1000.0) / (0.03324 * p1 - 1061.0)
    a_mm2 = 190.4 * w / (p1 * kd * kb * kc * kn * ksh)
    return {
        "wLbHr": w_lbhr, "p1Psia": p1_psia, "ksh": ksh,
        "kd": kd, "kb": kb, "kc": kc,
        "areaIn2": a_mm2 / IN2_TO_MM2, "kn": kn,
    }


def fire_case(wetted_ft2, adequate, env):
    a_m2 = wetted_ft2 * FT2_TO_M2
    c = 43.2 if adequate else 70.9
    q_kw = c * env * a_m2 ** 0.82
    return {
        "wettedFt2": wetted_ft2, "adequateDrainage": adequate, "envFactor": env,
        "qBtuHr": q_kw / BTU_HR_TO_KW,
    }


def wetted_horizontal(d_ft, l_ft, h_ft):
    r = d_ft / 2.0 * FT
    h = h_ft * FT
    theta = 2.0 * math.acos((r - h) / r)
    return {
        "orientation": "horizontal", "diameterFt": d_ft, "lengthFt": l_ft,
        "liquidLevelFt": h_ft,
        "areaFt2": (r * theta * (l_ft * FT)) / FT2_TO_M2,
    }


def dropout(d_micron, rho_l, rho_v, mu_cp):
    d = d_micron * 1e-6
    rl = rho_l * 16.01846337396
    rv = rho_v * 16.01846337396
    mu = mu_cp * 1e-3
    g = 9.80665
    c = 1.0
    ud = 0.0
    for _ in range(200):
        ud = 1.15 * math.sqrt(g * d * (rl - rv) / (rv * c))
        re = rv * ud * d / mu
        cn = 240.0 if re < 0.1 else 24.0 / re + 3.0 / math.sqrt(re) + 0.34
        if abs(cn - c) < 1e-12:
            c = cn
            break
        c = cn
    return {
        "dropletMicron": d_micron, "rhoLLbFt3": rho_l, "rhoVLbFt3": rho_v,
        "muVCp": mu_cp, "udFtS": ud / FT,
    }


def radiation(q_kw, dist_m, f, tau):
    return {
        "qKw": q_kw, "distanceM": dist_m, "fractionRadiated": f,
        "transmissivity": tau,
        "kWm2": tau * f * q_kw / (4.0 * math.pi * dist_m ** 2),
    }


def main():
    out = {}
    out["gas"] = [
        gas_case(50000, 314.7, 14.7, 610, 19.0, 0.9, 1.25),
        gas_case(12000, 114.7, 14.7, 560, 44.0, 0.95, 1.18),
        gas_case(80000, 514.7, 300.0, 640, 22.0, 0.88, 1.3),   # subcritical
        gas_case(80000, 514.7, 400.0, 640, 22.0, 0.88, 1.3),   # deeper subcritical
    ]
    out["liquid"] = [
        liquid_case(500, 250, 50, 0.9, 0.0),
        liquid_case(500, 250, 50, 0.9, 400.0),  # viscous, Kv iterates
        liquid_case(1200, 180, 0, 1.05, 30.0),
    ]
    out["steam"] = [
        steam_case(60000, 314.7),
        steam_case(60000, 314.7, ksh=0.83),
        steam_case(150000, 2014.7),  # Napier active
    ]
    out["wetted"] = [
        wetted_horizontal(10, 40, 5),   # half full
        wetted_horizontal(10, 40, 2.5),
        wetted_horizontal(8, 24, 7.9),
    ]
    out["fire"] = [
        fire_case(628.3, True, 1.0),
        fire_case(628.3, False, 1.0),
        fire_case(300.0, True, 0.3),
    ]
    out["dropout"] = [
        dropout(300, 31.2, 0.5, 0.012),
        dropout(600, 43.7, 1.2, 0.010),
        dropout(150, 50.0, 0.3, 0.015),
    ]
    out["radiation"] = [
        radiation(50000, 100, 0.3, 1.0),
        radiation(50000, 100, 0.2, 0.8),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "relief_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
