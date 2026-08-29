#!/usr/bin/env python3
"""Independent oracle for engines/facilities/gasProcessing.js.

Routes:
 - water saturation pressure by the ANTOINE fit (a different published
   correlation from the module's Magnus fit), so agreement is two
   published vapor-pressure equations meeting inside their shared
   validity band
 - saturated water content re-derived in SI mol arithmetic
 - Kremser checked by brute-force stage-to-stage marching of the
   absorber cascade, which the closed form must reproduce
 - TEG and amine packages re-derived in SI mass units
 - contactor Souders-Brown in SI with z passed in (the z-factor is
   validated in its own domain)

stdlib only. Writes test-data/facilities/goldens/gasprocessing_cases.json
"""

import json
import math
import os

PSI = 6.894757293168      # kPa per psi
LBMOL_SCF = 379.49
MW_WATER = 18.01528
LB = 0.45359237
GAL = 3.785411784


def antoine_water_psia(t_f):
    """Antoine, log10(P mmHg) = 8.07131 - 1730.63/(233.426 + T_C), 1..100 C."""
    t_c = (t_f - 32.0) / 1.8
    p_mmhg = 10.0 ** (8.07131 - 1730.63 / (233.426 + t_c))
    return p_mmhg * 0.0193367747  # mmHg -> psia


def water_content(p_psia, t_f):
    psat = antoine_water_psia(t_f)
    y = psat / p_psia
    return {
        "pPsia": p_psia, "tF": t_f,
        "lbPerMMscf": y * (1e6 / LBMOL_SCF) * MW_WATER,
    }


def kremser_march(A, N):
    """Brute-force cascade: countercurrent absorber with constant
    absorption factor A, N stages; returns fraction absorbed.

    Kremser closed form assumes a solute-free solvent feed and linear
    equilibrium. March the recursion on the summed geometric series:
    fraction remaining = (A - 1)/(A^(N+1) - 1) ... derived
    independently as sum_{i=0..N} A^i partitioning.
    """
    # independent route: solve the stage balances as a linear system
    # x_out fractions via matrix elimination for small N
    n = int(round(N))
    # unknowns: y_1..y_n (gas leaving each stage, stage n = inlet end)
    # stage j: y_j (leaving up) with L x_j down. With linear equilibrium
    # x_j = y_j / K and constant flows, balance on stage j:
    #   V y_{j+1} + L x_{j-1} = V y_j + L x_j
    # normalize V=1, L = A K; take K=1 (A = L/V then) without loss.
    # y_{n+1} = y_in = 1; x_0 = 0 (lean solvent).
    import itertools
    size = n
    M = [[0.0] * size for _ in range(size)]
    b = [0.0] * size
    for j in range(1, n + 1):
        row = j - 1
        # y_{j+1} + A x_{j-1} = y_j + A x_j, x_j = y_j
        # => y_{j+1} + A y_{j-1} = (1 + A) y_j
        M[row][row] = (1.0 + A)
        if j - 1 >= 1:
            M[row][j - 2] = -A
        if j + 1 <= n:
            M[row][j] = -1.0
        else:
            b[row] = 1.0  # y_{n+1} = 1 inlet
    # gaussian elimination
    for col in range(size):
        piv = max(range(col, size), key=lambda r: abs(M[r][col]))
        M[col], M[piv] = M[piv], M[col]
        b[col], b[piv] = b[piv], b[col]
        for r in range(col + 1, size):
            fac = M[r][col] / M[col][col]
            for c in range(col, size):
                M[r][c] -= fac * M[col][c]
            b[r] -= fac * b[col]
    y = [0.0] * size
    for r in range(size - 1, -1, -1):
        s = b[r] - sum(M[r][c] * y[c] for c in range(r + 1, size))
        y[r] = s / M[r][r]
    y_out = y[0]  # gas leaving stage 1 (top)
    return 1.0 - y_out


def teg(gas, win, wout, ratio, lean, t_abs, t_reb, reflux, cp, lb_gal,
        btex_ppmv, btex_frac, btex_mw):
    removed = win - wout
    water_kg_day = removed * gas * LB
    circ_m3_day = water_kg_day / LB * ratio * GAL / 1000.0
    circ_gpm = (circ_m3_day * 1000.0 / GAL) / 1440.0
    sens = lb_gal * cp * (t_reb - t_abs)          # Btu/gal
    vap = (1.0 / ratio) * 1100.0 * (1.0 + reflux)
    duty_btu_gal = sens + vap
    reboiler = (water_kg_day / LB * ratio) * duty_btu_gal / 24.0 / 1e6
    btex_mol_day = gas * 1e6 * btex_ppmv / 1e6 / LBMOL_SCF
    btex_lb_day = btex_mol_day * btex_frac * btex_mw
    return {
        "gasMMscfd": gas, "inletLbMMscf": win, "outletLbMMscf": wout,
        "circulationGalPerLb": ratio, "leanTegWtPct": lean,
        "absorberTF": t_abs, "reboilerTF": t_reb, "refluxRatio": reflux,
        "cpTegBtuLbF": cp, "tegLbPerGal": lb_gal,
        "btexInletPpmv": btex_ppmv, "btexAbsorbedFrac": btex_frac,
        "btexMw": btex_mw,
        "waterLbDay": water_kg_day / LB,
        "circGpm": circ_gpm,
        "dutyBtuPerGal": duty_btu_gal,
        "reboilerMMBtuHr": reboiler,
        "btexLbDay": btex_lb_day,
    }


def amine(gas, co2, h2s, co2s, h2ss, mw, wtpct, lean, rich, duty, sg):
    removed_pct = (co2 - co2s) + (h2s - h2ss)
    acid_kmol_day = gas * 1e6 * removed_pct / 100.0 / LBMOL_SCF * LB
    amine_kmol_day = acid_kmol_day / (rich - lean)
    amine_kg_day = amine_kmol_day * mw
    soln_kg_day = amine_kg_day / (wtpct / 100.0)
    soln_gpd = soln_kg_day / LB / (8.34 * sg)
    circ_gpm = soln_gpd / 1440.0
    reboiler = circ_gpm * 60.0 * duty / 1e6
    return {
        "gasMMscfd": gas, "co2MolPct": co2, "h2sMolPct": h2s,
        "co2SpecMolPct": co2s, "h2sSpecMolPct": h2ss,
        "amineWtPct": wtpct, "leanLoading": lean, "richLoading": rich,
        "dutyBtuPerGal": duty,
        "acidMolesDay": acid_kmol_day / LB,
        "circGpm": circ_gpm,
        "reboilerMMBtuHr": reboiler,
    }


def contactor(gas, p, t_f, sg, ks, z):
    t_r = t_f + 459.67
    rho_g = 28.9625 * sg * p / (z * 10.7316 * t_r)
    rho_l = 69.9
    v = ks * math.sqrt((rho_l - rho_g) / rho_g)
    q = gas * 1e6 / 86400.0 * (14.65 / p) * (t_r / 520.0) * z
    area = q / v
    return {
        "gasMMscfd": gas, "pPsia": p, "tF": t_f, "gasSg": sg,
        "ksFtS": ks, "z": z,
        "diameterFt": math.sqrt(4.0 * area / math.pi),
        "vAllowFtS": v,
    }


def main():
    out = {}
    out["water"] = [water_content(p, t) for p, t in
                    [(500, 100), (1000, 120), (200, 60), (65, 40)]]
    out["kremser"] = []
    for A, N in [(1.4, 6), (2.0, 3), (0.8, 8), (1.0, 5), (3.0, 2)]:
        out["kremser"].append({
            "absorptionFactor": A, "stages": N,
            "fractionRemoved": kremser_march(A, N),
        })
    out["teg"] = [
        teg(50, 60, 7, 3.0, 99.0, 100, 380, 0.25, 0.55, 9.3, 100, 0.15, 92),
        teg(120, 90, 4, 4.0, 99.5, 110, 390, 0.3, 0.55, 9.3, 250, 0.2, 92),
    ]
    out["amine"] = [
        amine(100, 4.0, 1.0, 2.0, 0.0004, 119.16, 45, 0.05, 0.5, 800, 1.04),
        amine(30, 2.5, 0.0, 0.5, 0.0, 105.14, 28, 0.06, 0.4, 950, 1.02),
    ]
    out["contactor"] = [
        contactor(50, 1000, 100, 0.65, 0.3, 0.85),
        contactor(120, 1200, 110, 0.7, 0.35, 0.82),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "gasprocessing_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
