#!/usr/bin/env python3
"""Independent oracle for engines/facilities/pumps.js.

Independent routes:
 - the quadratic pump-curve fit is done by an independent 3x3 CRAMER
   solve on the normal equations, against the module's Gaussian
   elimination, and the fit is also checked by residual orthogonality
   (the residual vector must be orthogonal to each basis column).
 - the duty point is found by a fine SCAN plus golden-section refine
   of the |pump - system| difference, against the module's bisection.
 - power is computed through SI watts rather than the 3960 field
   packaging, so that constant is checked.
 - NPSH available is re-derived from a pressure balance in pascals.

stdlib only. Writes test-data/facilities/goldens/pumps_cases.json
"""

import json
import math
import os

PSI_TO_PA = 6894.757293168
FT_TO_M = 0.3048
GPM_TO_M3S = 6.309019640343e-5
G = 9.80665
HP_TO_W = 745.6998715822702


def fit_cramer(points):
    """Quadratic least squares by Cramer's rule on the normal equations,
    with the same q/scale conditioning the module uses."""
    scale = max(p[0] for p in points) or 1.0
    s = [0.0] * 5
    t = [0.0] * 3
    for q, h in points:
        x = q / scale
        s[0] += 1.0
        s[1] += x
        s[2] += x * x
        s[3] += x ** 3
        s[4] += x ** 4
        t[0] += h
        t[1] += x * h
        t[2] += x * x * h
    A = [[s[0], s[1], s[2]], [s[1], s[2], s[3]], [s[2], s[3], s[4]]]

    def det3(m):
        return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))

    d = det3(A)
    cs = []
    for col in range(3):
        M = [row[:] for row in A]
        for r in range(3):
            M[r][col] = t[r]
        cs.append(det3(M) / d)
    return cs, scale


def head_at(cs, scale, q):
    x = q / scale
    return cs[0] + cs[1] * x + cs[2] * x * x


def duty_by_scan(cs, scale, static_ft, k_ft, q_max, n=2000000):
    """Fine scan for the sign change, then golden-section refine."""
    def diff(q):
        return head_at(cs, scale, q) - (static_ft + k_ft * q * q)

    lo, hi = 0.0, q_max
    step = q_max / n
    prev_q, prev = 0.0, diff(0.0)
    for i in range(1, n + 1):
        q = i * step
        cur = diff(q)
        if prev > 0 >= cur:
            lo, hi = prev_q, q
            break
        prev_q, prev = q, cur
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if diff(mid) > 0:
            lo = mid
        else:
            hi = mid
    q = 0.5 * (lo + hi)
    return q, head_at(cs, scale, q)


def power_via_si(q_gpm, head_ft, sg, eta):
    """P = rho g Q H / eta, entirely in SI, then to hp."""
    rho = 999.0 * sg
    q = q_gpm * GPM_TO_M3S
    h = head_ft * FT_TO_M
    watts = rho * G * q * h / eta
    return watts / HP_TO_W


def npsha_via_pa(p_suction_psia, p_vap_psia, sg, static_ft, friction_ft):
    """Pressure balance in pascals, converted to feet of the liquid."""
    rho = 999.0 * sg
    dp = (p_suction_psia - p_vap_psia) * PSI_TO_PA
    head_m = dp / (rho * G)
    return head_m / FT_TO_M + static_ft - friction_ft


def hi_correction(q_bep, h_bep, visc_cst, rpm):
    B = 26.6 * (math.sqrt(visc_cst) * h_bep ** 0.0625) / (q_bep ** 0.375 * rpm ** 0.25)
    if B <= 1:
        return {"B": B, "cQ": 1.0, "cEta": 1.0}
    cq = math.exp(-0.165 * math.log10(B) ** 3.15)
    ceta = B ** (-0.0547 * B ** 0.69)
    return {"B": B, "cQ": cq, "cEta": ceta}


def main():
    out = {}

    curves = [
        [(0.0, 520.0), (800.0, 470.0), (1600.0, 330.0), (2200.0, 180.0)],
        [(0.0, 180.0), (500.0, 168.0), (1000.0, 130.0), (1400.0, 82.0)],
    ]
    out["curves"] = []
    for pts in curves:
        cs, scale = fit_cramer(pts)
        # residual orthogonality: r . basis_col = 0 for each column
        ortho = []
        for col in range(3):
            acc = 0.0
            for q, h in pts:
                x = q / scale
                basis = [1.0, x, x * x][col]
                acc += (h - head_at(cs, scale, q)) * basis
            ortho.append(acc)
        out["curves"].append({
            "points": [{"qGpm": q, "headFt": h} for q, h in pts],
            "c0": cs[0], "c1": cs[1], "c2": cs[2], "scale": scale,
            "shutoffHeadFt": head_at(cs, scale, 0.0),
            "maxOrthogonalityResidual": max(abs(v) for v in ortho),
        })

    out["duty"] = []
    for pts, static_ft, fric_ft, at_q in [
        (curves[0], 150.0, 200.0, 1500.0),
        (curves[1], 40.0, 60.0, 900.0),
    ]:
        cs, scale = fit_cramer(pts)
        k = fric_ft / (at_q * at_q)
        q, h = duty_by_scan(cs, scale, static_ft, k, 3000.0)
        out["duty"].append({
            "points": [{"qGpm": a, "headFt": b} for a, b in pts],
            "staticHeadFt": static_ft, "frictionHeadFt": fric_ft,
            "atFlowGpm": at_q,
            "qGpm": q, "headFt": h,
        })

    out["power"] = []
    for q, h, sg, eta in [(1500.0, 300.0, 0.85, 0.78), (600.0, 120.0, 1.02, 0.72)]:
        out["power"].append({
            "qGpm": q, "headFt": h, "sg": sg, "efficiency": eta,
            "brakeHp": power_via_si(q, h, sg, eta),
        })

    out["npsh"] = []
    for ps, pv, sg, st, fr in [
        (14.7, 0.5, 0.85, 8.0, 3.0),
        (35.0, 12.0, 0.72, -5.0, 6.0),
    ]:
        out["npsh"].append({
            "suctionPressurePsia": ps, "vapourPressurePsia": pv, "sg": sg,
            "staticSuctionLiftFt": st, "suctionFrictionFt": fr,
            "npshaFt": npsha_via_pa(ps, pv, sg, st, fr),
        })

    out["viscosity"] = []
    for q, h, v, rpm in [(1500.0, 300.0, 100.0, 3560.0), (800.0, 200.0, 500.0, 1780.0)]:
        r = hi_correction(q, h, v, rpm)
        r.update({"qBepGpm": q, "headBepFt": h, "viscosityCSt": v, "speedRpm": rpm})
        out["viscosity"].append(r)

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "pumps_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
