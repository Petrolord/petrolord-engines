#!/usr/bin/env python3
"""Independent oracle for engines/facilities/separatorSizing.js.

Independent routes:
 - circular-segment areas by NUMERICAL INTEGRATION of the circle's
   chord over the liquid depth, rather than the closed-form
   (theta - sin theta) expression the module uses
 - Souders-Brown and the vessel balances re-derived in SI
 - Stokes settling from first principles (the 1.78e-6 field constant
   is a unit packaging of 2 g r^2 dRho / (9 mu); the oracle computes
   the SI Stokes law directly, so the constant is CHECKED)
 - slug-catcher volumes by SI geometry

stdlib only. Writes test-data/facilities/goldens/separator_cases.json
"""

import json
import math
import os

FT = 0.3048
IN = 0.0254
BBL = 0.158987294928
LBFT3 = 16.01846337396
CP = 1e-3
G = 9.80665


def segment_by_integration(d_ft, frac, n=400000):
    """Liquid area of a horizontal cylinder by integrating the chord.

    A = integral_0^h  2*sqrt(r^2 - (r-y)^2) dy, midpoint rule.
    """
    r = d_ft / 2.0
    h = frac * d_ft
    acc = 0.0
    dy = h / n
    for i in range(n):
        y = (i + 0.5) * dy
        acc += 2.0 * math.sqrt(max(0.0, r * r - (r - y) ** 2)) * dy
    return acc


def souders_brown(k, rho_l, rho_g):
    """SI re-derivation: v = k sqrt((rhoL - rhoG)/rhoG) is
    dimensionally a velocity with k in ft/s, so convert both ways."""
    rl = rho_l * LBFT3
    rg = rho_g * LBFT3
    return (k * FT) * math.sqrt((rl - rg) / rg) / FT


def stokes_si(d_micron, sg_heavy, sg_light, mu_cp):
    """Terminal velocity of a sphere in Stokes flow, SI first
    principles: v = g d^2 (rho_h - rho_l) / (18 mu). Converted to ft/s
    this must reproduce the field form v = 1.78e-6 dm^2 dSG / mu."""
    d = d_micron * 1e-6
    drho = (sg_heavy - sg_light) * 1000.0
    mu = mu_cp * CP
    v_si = G * d * d * drho / (18.0 * mu)
    return v_si / FT


def vertical_two_phase(q_gas_ft3s, v_term, q_liq_bpd, ret_min, allowance_ft):
    q = q_gas_ft3s * FT ** 3
    v = v_term * FT
    area = q / v
    d = math.sqrt(4 * area / math.pi)
    liq_vol = q_liq_bpd * BBL * (ret_min / 1440.0)
    h_liq = liq_vol / area
    return {
        "qGasActFt3S": q_gas_ft3s, "vTerminalFtS": v_term,
        "qLiquidBpd": q_liq_bpd, "retentionMin": ret_min,
        "allowanceFt": allowance_ft,
        "diameterFt": d / FT,
        "hLiquidFt": h_liq / FT,
        "heightFt": h_liq / FT + allowance_ft,
    }


def horizontal_two_phase(d_ft, q_gas_ft3s, v_term, q_liq_bpd, ret_min, frac):
    area_liq_ft2 = segment_by_integration(d_ft, frac, n=200000)
    area_tot_ft2 = math.pi * (d_ft / 2) ** 2
    area_gas_ft2 = area_tot_ft2 - area_liq_ft2
    gas_h_ft = d_ft * (1 - frac)
    v_gas = q_gas_ft3s / area_gas_ft2
    len_gas = v_gas * gas_h_ft / v_term
    liq_vol_ft3 = q_liq_bpd * BBL / FT ** 3 * (ret_min / 1440.0)
    len_liq = liq_vol_ft3 / area_liq_ft2
    return {
        "diameterFt": d_ft, "qGasActFt3S": q_gas_ft3s,
        "vTerminalFtS": v_term, "qLiquidBpd": q_liq_bpd,
        "retentionMin": ret_min, "liquidLevelFrac": frac,
        "areaLiquidFt2": area_liq_ft2,
        "areaGasFt2": area_gas_ft2,
        "lengthGasFt": len_gas,
        "lengthLiquidFt": len_liq,
        "lengthFt": max(len_gas, len_liq),
    }


def vessel_slug(slug_bbl, q_liq_bpd, hold_min, fill, ld):
    normal = q_liq_bpd * hold_min / 1440.0
    working = slug_bbl + normal
    vol_m3 = working * BBL / fill
    d_m = (4 * vol_m3 / (math.pi * ld)) ** (1.0 / 3.0)
    return {
        "slugBbl": slug_bbl, "qLiquidBpd": q_liq_bpd, "holdMin": hold_min,
        "fillFraction": fill, "ldRatio": ld,
        "normalBbl": normal,
        "totalVolumeFt3": vol_m3 / FT ** 3,
        "diameterFt": d_m / FT,
        "lengthFt": ld * d_m / FT,
    }


def finger_slug(slug_bbl, id_in, n_f, fill):
    vol_m3 = slug_bbl * BBL / fill
    area_m2 = math.pi * (id_in * IN) ** 2 / 4
    length_m = vol_m3 / (area_m2 * n_f)
    return {
        "slugBbl": slug_bbl, "fingerIdIn": id_in, "nFingers": n_f,
        "fillFraction": fill,
        "totalVolumeFt3": vol_m3 / FT ** 3,
        "fingerLengthFt": length_m / FT,
    }


def main():
    out = {}

    out["segments"] = []
    for d, frac in [(8.0, 0.5), (10.0, 0.3), (6.0, 0.75), (12.0, 0.5)]:
        out["segments"].append({
            "diameterFt": d, "liquidLevelFrac": frac,
            "areaLiquidFt2": segment_by_integration(d, frac),
        })

    out["soudersBrown"] = []
    for k, rl, rg in [(0.35, 52.0, 2.5), (0.45, 55.0, 5.0), (0.18, 62.4, 0.8)]:
        out["soudersBrown"].append({
            "k": k, "rhoLLbFt3": rl, "rhoGLbFt3": rg,
            "vFtS": souders_brown(k, rl, rg),
        })

    out["stokes"] = []
    for dm, sgh, sgl, mu in [(500, 1.05, 0.85, 2.0), (150, 1.02, 0.80, 5.0), (1000, 1.08, 0.9, 1.0)]:
        out["stokes"].append({
            "dropletMicron": dm, "sgHeavy": sgh, "sgLight": sgl, "muCp": mu,
            "vFtS": stokes_si(dm, sgh, sgl, mu),
        })

    out["vertical"] = [
        vertical_two_phase(12.0, 0.85, 3000, 3, 6),
        vertical_two_phase(30.0, 1.2, 8000, 2, 7),
    ]

    out["horizontal"] = [
        horizontal_two_phase(8.0, 12.0, 0.85, 3000, 3, 0.5),
        horizontal_two_phase(10.0, 30.0, 1.1, 12000, 5, 0.4),
    ]

    out["vesselSlug"] = [
        vessel_slug(200, 5000, 5, 0.6, 4),
        vessel_slug(1200, 20000, 10, 0.7, 5),
    ]

    out["fingerSlug"] = [
        finger_slug(1500, 24, 6, 0.8),
        finger_slug(500, 16, 4, 0.75),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "separator_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
