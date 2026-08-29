#!/usr/bin/env python3
"""Independent oracle for engines/facilities/lineHydraulics.js.

Everything here is computed in SI, from the PUBLISHED SI FORMS of the
same physics (Menon, "Gas Pipeline Hydraulics" for the transmission
equations; first principles for friction, liquid lines, Barlow and the
pigging geometry), then converted to the field units the JS module
speaks. Agreement is therefore two published routes meeting -- the
field-unit constants (433.5, 435.87, 737, 77.54, 0.0375) checked
against the SI constants (3.7435e-3, 4.5965e-3, 1.002e-2, 1.1494e-3,
0.0684) -- not code echoing itself.

stdlib only. Writes test-data/facilities/goldens/linehydraulics_cases.json
"""

import json
import math
import os

FT = 0.3048
IN = 0.0254
MILE = 1609.344
PSI = 6894.757293168
LBFT3 = 16.01846337396
CP = 1e-3            # Pa.s
BBL = 0.158987294928
CUFT = 0.028316846592
R_GAS = 8.314462618
M_AIR = 28.9647e-3   # kg/mol

TB_R = 520.0
PB_PSIA = 14.65
TB_K = TB_R / 1.8
PB_KPA = PB_PSIA * PSI / 1000.0


def colebrook(re, rel_rough):
    """Darcy f by bisection on the Colebrook-White equation."""
    if re < 2100:
        return 64.0 / re

    def g(f):
        return 1.0 / math.sqrt(f) + 2.0 * math.log10(
            rel_rough / 3.7 + 2.51 / (re * math.sqrt(f)))

    lo, hi = 1e-5, 0.5
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if g(lo) * g(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def liquid_case(q_bpd, id_in, length_ft, elev_ft, rho_lbft3, mu_cp,
                rough_in, sum_k):
    """Darcy-Weisbach entirely in SI."""
    d = id_in * IN
    area = math.pi * d * d / 4.0
    q = q_bpd * BBL / 86400.0
    v = q / area
    rho = rho_lbft3 * LBFT3
    mu = mu_cp * CP
    re = rho * v * d / mu
    f = colebrook(re, rough_in / id_in)
    vh = rho * v * v / 2.0                      # Pa
    dp_fric = f * (length_ft * FT / d) * vh
    dp_fit = sum_k * vh
    dp_elev = rho * 9.80665 * 0  # gravity handled in field-psi form below
    # The JS module's elevation term is the exact hydrostatic column
    # rho*g*h; do the same here.
    dp_elev = rho * 9.80665 * (elev_ft * FT)
    # NOTE the JS uses rho*h/144 psi, i.e. g == gc exactly; mirror that
    # convention (standard field practice) rather than 9.80665:
    dp_elev = (rho_lbft3 * elev_ft / 144.0) * PSI
    return {
        "qBpd": q_bpd, "idIn": id_in, "lengthFt": length_ft,
        "elevChangeFt": elev_ft, "rhoLbFt3": rho_lbft3, "muCp": mu_cp,
        "roughnessIn": rough_in, "sumK": sum_k,
        "vFtS": v / FT, "re": re, "f": f,
        "dpFrictionPsi": dp_fric / PSI,
        "dpFittingsPsi": dp_fit / PSI,
        "dpElevationPsi": dp_elev / PSI,
        "dpTotalPsi": (dp_fric + dp_fit) / PSI + rho_lbft3 * elev_ft / 144.0,
    }


def elevation_s(sg, dz_ft, t_r, z):
    """SI form: s = 0.0684 G dz_m / (T_K Z)."""
    return 0.0684 * sg * (dz_ft * FT) / ((t_r / 1.8) * z)


def gas_case(eq, p1, p2, d_in, l_mi, sg, t_r, z, e, dz_ft, mu_cp=0.011,
             rough_in=0.0007):
    """Menon SI forms; Q in m3/day at (TB_K, PB_KPA) -> scfd."""
    p1k = p1 * PSI / 1000.0
    p2k = p2 * PSI / 1000.0
    d_mm = d_in * 25.4
    l_km = l_mi * MILE / 1000.0
    t_k = t_r / 1.8
    s = elevation_s(sg, dz_ft, t_r, z)
    if abs(s) < 1e-12:
        es, le_km = 1.0, l_km
    else:
        es = math.exp(s)
        le_km = l_km * (es - 1.0) / s
    driving = p1k * p1k - es * p2k * p2k
    if driving <= 0:
        return None
    if eq == "weymouth":
        q = 3.7435e-3 * e * (TB_K / PB_KPA) * math.sqrt(
            driving / (sg * t_k * le_km * z)) * d_mm ** 2.667
    elif eq == "panhandleA":
        q = 4.5965e-3 * e * (TB_K / PB_KPA) ** 1.0788 * (
            driving / (sg ** 0.8539 * t_k * le_km * z)) ** 0.5394 \
            * d_mm ** 2.6182
    elif eq == "panhandleB":
        q = 1.002e-2 * e * (TB_K / PB_KPA) ** 1.02 * (
            driving / (sg ** 0.961 * t_k * le_km * z)) ** 0.51 \
            * d_mm ** 2.53
    elif eq == "general":
        # Iterate f with Re from first principles: Re = 4 mdot/(pi D mu)
        rho_base = (PB_KPA * 1000.0) * (M_AIR * sg) / (R_GAS * TB_K)
        f = 0.015
        q = 0.0
        for _ in range(80):
            q = 1.1494e-3 * e * (TB_K / PB_KPA) * math.sqrt(
                driving / (sg * t_k * le_km * z * f)) * d_mm ** 2.5
            mdot = rho_base * q / 86400.0
            re = 4.0 * mdot / (math.pi * (d_in * IN) * (mu_cp * CP))
            fn = colebrook(re, rough_in / d_in)
            if abs(fn - f) < 1e-14:
                f = fn
                break
            f = fn
    else:
        raise ValueError(eq)
    q_scfd = q / CUFT   # identical base conditions: pure volume conversion
    row = {"equation": eq, "p1Psia": p1, "p2Psia": p2, "idIn": d_in,
           "lengthMi": l_mi, "sg": sg, "tAvgR": t_r, "zAvg": z,
           "efficiency": e, "elevChangeFt": dz_ft, "qScfd": q_scfd}
    if eq == "general":
        row["muCp"] = mu_cp
        row["roughnessIn"] = rough_in
    return row


def barlow_case(design_psig, od_in, smys_psi, code, loc, joint, temp, ca_in):
    f = 0.72 if code == "B31.4" else {1: 0.72, 2: 0.60, 3: 0.50, 4: 0.40}[loc]
    p = design_psig * PSI
    od = od_in * IN
    s = smys_psi * PSI
    t = p * od / (2.0 * s * f * joint * temp)
    return {
        "designPsig": design_psig, "odIn": od_in, "smysPsi": smys_psi,
        "code": code, "locationClass": loc, "jointFactor": joint,
        "tempDerate": temp, "corrosionAllowanceIn": ca_in,
        "designFactor": f,
        "tRequiredIn": t / IN + ca_in,
        # MAOP of exactly that gross wall must round-trip
        "maopOfRequiredPsig": design_psig,
    }


def pigging_cases():
    rows = []
    for id_in, length_ft, holdup in [(6.065, 30000.0, 0.12),
                                     (10.02, 52800.0, 0.05),
                                     (2.067, 8000.0, 0.35)]:
        area = math.pi * (id_in * IN) ** 2 / 4.0
        vol_bbl = area * (length_ft * FT) / BBL
        rows.append({
            "idIn": id_in, "lengthFt": length_ft, "holdupFrac": holdup,
            "lineVolumeBbl": vol_bbl,
            "sweptBbl": vol_bbl * holdup,
            "runHoursAt5FtS": (length_ft / 5.0) / 3600.0,
        })
    return rows


def main():
    out = {}

    out["friction"] = []
    for re, rr in [(1500, 0.0), (5e3, 1e-4), (5e4, 3e-4), (1e6, 1e-3),
                   (1e7, 5e-5), (3000, 2e-3)]:
        out["friction"].append({"re": re, "relRough": rr,
                                "f": colebrook(re, rr)})

    out["liquid"] = [
        liquid_case(5000, 6.065, 15000, 0, 53.0, 3.0, 0.0018, 0.0),
        liquid_case(20000, 10.02, 52800, 250, 56.0, 8.0, 0.0018, 4.5),
        liquid_case(800, 2.067, 3000, -60, 62.4, 1.0, 0.0018, 2.0),
        liquid_case(150, 2.067, 5000, 0, 58.0, 400.0, 0.0018, 0.0),  # laminar
    ]

    out["gas"] = []
    cases = [
        (900, 500, 12.0, 50.0, 0.65, 530.0, 0.88, 1.0, 0.0),
        (1200, 900, 6.065, 10.0, 0.70, 545.0, 0.85, 0.95, 0.0),
        (700, 650, 16.0, 80.0, 0.60, 520.0, 0.90, 0.92, 0.0),
        (1000, 600, 8.0, 25.0, 0.65, 540.0, 0.87, 1.0, 800.0),
        (1000, 600, 8.0, 25.0, 0.65, 540.0, 0.87, 1.0, -800.0),
    ]
    for eq in ["weymouth", "panhandleA", "panhandleB", "general"]:
        for c in cases:
            row = gas_case(eq, *c)
            if row:
                out["gas"].append(row)

    out["barlow"] = [
        barlow_case(1440, 12.75, 52000, "B31.4", 1, 1.0, 1.0, 0.0),
        barlow_case(1000, 8.625, 42000, "B31.8", 1, 1.0, 1.0, 0.0625),
        barlow_case(1000, 8.625, 42000, "B31.8", 3, 1.0, 1.0, 0.0),
        barlow_case(720, 6.625, 35000, "B31.8", 4, 1.0, 0.967, 0.05),
    ]

    out["pigging"] = pigging_cases()

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "linehydraulics_cases.json"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest,
          "| gas rows:", len(out["gas"]),
          "| liquid rows:", len(out["liquid"]))


if __name__ == "__main__":
    main()
