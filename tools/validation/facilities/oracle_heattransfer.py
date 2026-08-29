#!/usr/bin/env python3
"""Independent oracle for engines/facilities/heatTransfer.js.

Independent routes, not restatements:

 - LMTD correction F: the module uses Bowman's closed form. The oracle
   gets F by NUMERICAL INTEGRATION of the 1-2 exchanger's differential
   equations is impractical in stdlib, so instead it uses the
   EFFECTIVENESS-NTU identity, which is a different published route to
   the same quantity: for a 1-2 shell exchanger,
       F = NTU_counter / NTU_shell   evaluated at the same P and R,
   with NTU_counter from the counter-flow eps-NTU closed form and
   NTU_shell from the 1-2 eps-NTU closed form. The two formulations
   are derived independently in the literature and must agree.
 - eps-NTU: brute-force numerical integration of the counter-flow
   exchanger ODEs along the area coordinate (a genuinely different
   route from the closed form).
 - LMTD itself: numerical integration of dQ = U dA dT over the
   exchanger, which is what the log-mean is the closed form OF.
 - U, tube-side film, tube count, air cooler: SI re-derivation.

stdlib only. Writes test-data/facilities/goldens/heattransfer_cases.json
"""

import json
import math
import os


def lmtd_by_integration(th_in, th_out, tc_in, tc_out, n=200000):
    """Integrate the counter-flow exchanger to get the MEAN driving force.

    Along the exchanger, dTh/dx = -q'/Ch and dTc/dx = -q'/Cc (counter),
    both linear in x when U is constant, so dT(x) is linear in the heat
    transferred. The mean driving force is Q / integral(dA), i.e. the
    harmonic-style average that the log-mean expresses in closed form.
    Integrate 1/dT over the duty and invert.
    """
    q_total = 1.0
    acc = 0.0
    for i in range(n):
        f0 = i / n
        f1 = (i + 1) / n
        fm = 0.5 * (f0 + f1)
        th = th_in - (th_in - th_out) * fm
        tc = tc_out - (tc_out - tc_in) * fm
        dt = th - tc
        acc += (1.0 / dt) * (q_total / n)
    return 1.0 / acc


def eps_counter_by_ode(ntu, cr, n=200000):
    """March the counter-flow exchanger along NTU with RK4.

    Non-dimensional: d(th)/dz = -(th - tc), d(tc)/dz = -cr (th - tc)
    on z in [0, NTU] with th(0) = 1, and tc(0) unknown for counter
    flow -- shoot on tc(0) so that tc(NTU) = 0 (cold inlet at the far
    end). Effectiveness = 1 - th(NTU) for cr <= 1 with Cmin = hot.
    """
    def march(tc0):
        th, tc = 1.0, tc0
        h = ntu / n
        for _ in range(n):
            def d(th_, tc_):
                return (-(th_ - tc_), -cr * (th_ - tc_))
            k1 = d(th, tc)
            k2 = d(th + 0.5 * h * k1[0], tc + 0.5 * h * k1[1])
            k3 = d(th + 0.5 * h * k2[0], tc + 0.5 * h * k2[1])
            k4 = d(th + h * k3[0], tc + h * k3[1])
            th += h * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6.0
            tc += h * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6.0
        return th, tc

    lo, hi = 0.0, 1.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        _, tc_end = march(mid)
        if tc_end > 0:
            hi = mid
        else:
            lo = mid
    th_end, _ = march(0.5 * (lo + hi))
    return 1.0 - th_end


def eps_counter_closed(ntu, cr):
    if cr == 0:
        return 1 - math.exp(-ntu)
    if abs(cr - 1) < 1e-12:
        return ntu / (1 + ntu)
    e = math.exp(-ntu * (1 - cr))
    return (1 - e) / (1 - cr * e)


def ntu_counter_closed(eps, cr):
    if cr == 0:
        return -math.log(1 - eps)
    if abs(cr - 1) < 1e-12:
        return eps / (1 - eps)
    return (1 / (cr - 1)) * math.log((eps - 1) / (eps * cr - 1))


def ntu_shell12_closed(eps, cr):
    root = math.sqrt(1 + cr * cr)
    e = (2 / eps - (1 + cr)) / root
    return (1 / root) * math.log((e + 1) / (e - 1))


def f_by_epsntu(p, r):
    """F via the eps-NTU identity: F = NTU_counter / NTU_1-2 at the same
    P and R. With Cmin on the cold side, eps = P and cr = R."""
    if r <= 1.0:
        eps, cr = p, r
    else:
        # swap so Cmin is the reference stream
        eps, cr = p * r, 1.0 / r
    return ntu_counter_closed(eps, cr) / ntu_shell12_closed(eps, cr)


def overall_u(ho, hi, do_in, di_in, kw, rfo, rfi):
    do = do_in * 0.0254
    di = di_in * 0.0254
    ratio = do / di
    # SI: convert Btu/hr.ft2.F -> W/m2.K (5.678263), Btu/hr.ft.F -> W/m.K (1.730735)
    ho_si = ho * 5.678263
    hi_si = hi * 5.678263
    kw_si = kw * 1.730735
    rfo_si = rfo / 5.678263
    rfi_si = rfi / 5.678263
    r_tot = (1 / ho_si + rfo_si + do * math.log(ratio) / (2 * kw_si)
             + ratio * rfi_si + ratio / hi_si)
    r_clean = 1 / ho_si + do * math.log(ratio) / (2 * kw_si) + ratio / hi_si
    return {
        "hoBtuHrFt2F": ho, "hiBtuHrFt2F": hi, "doIn": do_in, "diIn": di_in,
        "kWallBtuHrFtF": kw, "foulingOut": rfo, "foulingIn": rfi,
        "uDirtyBtuHrFt2F": (1 / r_tot) / 5.678263,
        "uCleanBtuHrFt2F": (1 / r_clean) / 5.678263,
    }


def tube_film(m_lbhr, di_in, mu_cp, k_btu, cp_btu, n_tubes, passes):
    # SI re-derivation of Dittus-Boelter
    m = m_lbhr * 0.45359237 / 3600.0          # kg/s
    d = di_in * 0.0254
    mu = mu_cp * 1e-3
    k = k_btu * 1.730735
    cp = cp_btu * 4186.8
    per_pass = n_tubes / passes
    area = math.pi * d * d / 4 * per_pass
    g = m / area                               # kg/(s.m2)
    re = g * d / mu
    pr = cp * mu / k
    nu = 0.023 * re ** 0.8 * pr ** 0.4
    return {
        "mLbHr": m_lbhr, "diIn": di_in, "muCp": mu_cp, "kBtuHrFtF": k_btu,
        "cpBtuLbF": cp_btu, "nTubes": n_tubes, "passes": passes,
        "re": re, "pr": pr,
        "hBtuHrFt2F": nu * k / d / 5.678263,
    }


def air_cooler(q, t_in, t_out, amb, rise, u, sp, fan_eff):
    air_out = amb + rise
    dt1 = t_in - air_out
    dt2 = t_out - amb
    lm = (dt1 - dt2) / math.log(dt1 / dt2)
    area = q / (u * lm)
    cp_air = 0.24
    m_air = q / (cp_air * rise)
    t_mean_f = (amb + air_out) / 2
    rho = 14.7 * 28.9625 / (10.7316 * (t_mean_f + 459.67))
    acfm = m_air / rho / 60
    bhp = acfm * sp / (6356 * fan_eff)
    return {
        "qBtuHr": q, "processInF": t_in, "processOutF": t_out,
        "ambientF": amb, "airRiseF": rise, "uBtuHrFt2F": u,
        "staticPressureInH2O": sp, "fanEfficiency": fan_eff,
        "lmtdF": lm, "areaFt2": area, "acfm": acfm, "fanBhp": bhp,
        "airDensityLbFt3": rho,
    }


def main():
    out = {}

    out["lmtd"] = []
    for th_in, th_out, tc_in, tc_out in [
        (300, 200, 100, 180), (250, 150, 80, 140), (400, 380, 100, 120),
    ]:
        out["lmtd"].append({
            "thIn": th_in, "thOut": th_out, "tcIn": tc_in, "tcOut": tc_out,
            "lmtdF": lmtd_by_integration(th_in, th_out, tc_in, tc_out),
        })

    out["fCorrection"] = []
    for p, r in [(0.4, 0.8), (0.3, 1.5), (0.5, 1.0), (0.25, 2.5), (0.6, 0.5)]:
        out["fCorrection"].append({"p": p, "r": r, "f": f_by_epsntu(p, r)})

    out["epsNtu"] = []
    for ntu, cr in [(1.0, 0.5), (2.0, 0.8), (3.0, 1.0), (0.5, 0.25)]:
        out["epsNtu"].append({
            "ntu": ntu, "cr": cr,
            "epsOde": eps_counter_by_ode(ntu, cr, n=20000),
            "epsClosed": eps_counter_closed(ntu, cr),
        })

    out["u"] = [
        overall_u(200, 800, 0.75, 0.62, 26, 0.001, 0.002),
        overall_u(1200, 300, 1.0, 0.834, 26, 0.0005, 0.001),
    ]

    out["tubeFilm"] = [
        tube_film(150000, 0.62, 0.5, 0.08, 0.5, 200, 2),
        tube_film(400000, 0.834, 1.2, 0.35, 1.0, 300, 4),
    ]

    out["airCooler"] = [
        air_cooler(20e6, 250, 150, 95, 30, 4.5, 0.6, 0.65),
        air_cooler(8e6, 180, 120, 90, 25, 5.0, 0.5, 0.7),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "heattransfer_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
