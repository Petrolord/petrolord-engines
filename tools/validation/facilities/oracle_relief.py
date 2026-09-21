#!/usr/bin/env python3
"""Independent oracle for engines/facilities/relief.js.

Implements the PUBLISHED SI FORMS of API 520/521 (the metric constants
the standard prints beside the USC ones) and, where the USC constant is
a unit packaging of a derivation rather than a published measurement,
the DERIVATION ITSELF in absolute SI, then converts to the USC units
the JS module speaks. Agreement is two routes meeting.

WHAT EACH ROUTE CHECKS, AND WHAT IT CANNOT. This table is the point of
the file: a route that restates the engine validates nothing, and five
of the routes here used to do exactly that (FC5-0).

  route          checks                              cannot check
  -----------    ---------------------------------   --------------------
  gas critical   the USC 520: the isentropic         the compressibility
                 nozzle mass flux from R, M, T, P    convention (z as a
                 in absolute SI                      constant multiplier)
  gas subcrit    the USC 735 AND the F2 closed       --
                 form: the subcritical nozzle flux
                 is integrated from the isentropic
                 expansion, not from F2
  critical       the ratio as the ARGMAX of the      --
   ratio         flux over the throat ratio, by
                 golden-section search, not by the
                 closed form
  liquid area    the USC 38 against the SI 11.78     the Kv fit itself
  liquid Re      the USC 2800: Reynolds from         the water density
                 rho Q sqrt(4/pi) / (mu sqrt(A))     convention (999.0
                 in SI                               kg/m3 at 60 F)
  Kv             NOTHING. The published fit is       its four constants:
                 SHARED with the engine on           0.9935, 2.878,
                 purpose: no route in this           342.75, 1.5
                 package can derive it. The GOLDEN
                 discriminates its constants, by
                 carrying a row at Re below 200
                 where 342.75 is worth 23 percent
                 of the denominator.
  steam          the USC 51.5 against the SI 190.4   the KSH table
                 and the SI statement of Napier
  fire           the USC 21000/34500 against the     the 0.82 exponent's
                 SI 43.2/70.9 with the 0.82          provenance
                 exponent carried through the
                 unit conversion
  relief load    every unit packaging: Btu, hour,    the latent-heat
                 pound, through kW and kg/s          method itself
  wetted area    the arc and the lateral surface     the decision to
                 by POLYLINE SUMMATION over the      ignore the heads
                 real circle with Richardson
                 extrapolation, not by r theta L
  settling       the 4/3 in the terminal-velocity    the drag correlation
                 balance, by BISECTION on the        24/Re + 3/sqrt(Re)
                 force residual (drag against        + 0.34, SHARED on
                 buoyant weight) in SI               purpose and HELD
                                                     FOR LITERATURE
  KO drum        the circular-segment vapour area    the 25 percent
                 by SIMPSON QUADRATURE of the        default holdup
                 area integral, and the length as
                 a transit time against a fall
                 time, in SI
  radiation      the 4 pi: the sphere's area by      the radiated
                 QUADRATURE of R^2 sin(theta),       fraction and the
                 and the inverse by BISECTION on     transmissivity,
                 that same quadrature                which are inputs
  blowdown       the whole march: dm/dt = -B         z as a constant,
                 m^((k+1)/2) is separable and        and choked flow
                 solved IN CLOSED FORM in SI,        throughout
                 including the (k-1) isentropic
                 exponent and the absence of any
                 hidden discharge coefficient

NOT COVERED BY ANY ROUTE, and therefore not graded anywhere: the API
526 orifice table (a published table, checked as behaviour in the jest
suite), the RADIATION_LEVELS labels (held for literature), the chart
factors Kb, Kw and KSH (typed inputs by design), and the note strings.

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
IN = 0.0254
R_U = 8.314462618          # J/(mol.K)
G_SI = 9.80665             # m/s2
RHO_WATER_60F = 999.0      # kg/m3, the reference for specific gravity


# --------------------------------------------------------------------
# numerical helpers: quadrature, bisection, golden-section search
# --------------------------------------------------------------------

def simpson(f, a, b, n=2000):
    """Composite Simpson. n even."""
    h = (b - a) / n
    s = f(a) + f(b)
    for i in range(1, n):
        s += (4.0 if i % 2 else 2.0) * f(a + i * h)
    return s * h / 3.0


def bisect(f, lo, hi, iters=300):
    flo = f(lo)
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


def argmax_golden(f, lo, hi, iters=400):
    phi = (math.sqrt(5.0) - 1.0) / 2.0
    a, b = lo, hi
    c, d = b - phi * (b - a), a + phi * (b - a)
    for _ in range(iters):
        if f(c) > f(d):
            b, d = d, c
            c = b - phi * (b - a)
        else:
            a, c = c, d
            d = a + phi * (b - a)
    return 0.5 * (a + b)


def polyline_arc(r, half_angle, n=4000):
    """Arc length of a circle of radius r over +/- half_angle, by summing
    CHORDS of a polyline, Richardson-extrapolated in n. Nothing here is
    the engine's r*theta."""
    def chords(m):
        total = 0.0
        step = 2.0 * half_angle / m
        x0, y0 = r * math.sin(-half_angle), -r * math.cos(-half_angle)
        for i in range(1, m + 1):
            a = -half_angle + i * step
            x1, y1 = r * math.sin(a), -r * math.cos(a)
            total += math.hypot(x1 - x0, y1 - y0)
            x0, y0 = x1, y1
        return total
    s1, s2 = chords(n), chords(2 * n)
    return (4.0 * s2 - s1) / 3.0        # chord error is O(step^2)


# --------------------------------------------------------------------
# API 520 sizing
# --------------------------------------------------------------------

def critical_ratio_by_search(k):
    """The critical pressure ratio as the ARGMAX of the isentropic nozzle
    mass flux over the throat pressure ratio. The closed form
    (2/(k+1))^(k/(k-1)) is never written here."""
    def flux(r):
        if r <= 0.0 or r >= 1.0:
            return 0.0
        return math.sqrt(max(r ** (2.0 / k) - r ** ((k + 1.0) / k), 0.0))
    return argmax_golden(flux, 1e-9, 1.0 - 1e-9)


def gas_case(w_lbhr, p1_psia, p2_psia, t_r, mw, z, k, kd=0.975, kb=1.0, kc=1.0):
    """First-principles isentropic-nozzle route in absolute SI.

    The USC constants 520 (critical C) and 735 (subcritical) are unit
    packagings of the ideal-nozzle mass flux; computing that flux from
    R, M, T and P directly is a genuinely independent derivation, so
    agreement checks the published constants rather than repeating
    them.
      critical:    G = sqrt(k (2/(k+1))^((k+1)/(k-1))) P1 sqrt(M/(ZRT))
      subcritical: G = sqrt(2 (k/(k-1)) P1 rho1 (r^(2/k) - r^((k+1)/k)))
                   which is the isentropic expansion integrated, NOT
                   the F2 closed form. F2 is what the engine uses, so
                   this route checks F2 rather than restating it.
    """
    w = w_lbhr * KG_H_PER_LB_H
    p1 = p1_psia * PSI_TO_KPA * 1000.0   # Pa
    p2 = p2_psia * PSI_TO_KPA * 1000.0
    t_k = t_r / 1.8
    m_kg = mw / 1000.0
    r_crit = critical_ratio_by_search(k)
    critical = p2 <= r_crit * p1
    rho1 = p1 * m_kg / (z * R_U * t_k)
    if critical:
        c_true = math.sqrt(k * (2.0 / (k + 1.0)) ** ((k + 1.0) / (k - 1.0)))
        g_flux = c_true * p1 * math.sqrt(m_kg / (z * R_U * t_k))   # kg/(s.m2)
        a_m2 = (w / 3600.0) / (kd * kb * kc * g_flux)
    else:
        r = p2 / p1
        g_flux = math.sqrt(2.0 * (k / (k - 1.0)) * p1 * rho1
                           * (r ** (2.0 / k) - r ** ((k + 1.0) / k)))
        a_m2 = (w / 3600.0) / (kd * kc * g_flux)
    a_mm2 = a_m2 * 1e6
    return {
        "wLbHr": w_lbhr, "p1Psia": p1_psia, "p2Psia": p2_psia, "tR": t_r,
        "mw": mw, "z": z, "k": k, "kd": kd, "kb": kb, "kc": kc,
        "critical": critical, "areaIn2": a_mm2 / IN2_TO_MM2,
        "criticalRatio": r_crit,
    }


def kv_fit(reynolds):
    """The PUBLISHED Kv fit, SHARED with the engine on purpose: no route
    in this package derives it. What discriminates its constants is the
    golden's low-Reynolds row, not this function."""
    raw = 1.0 / (0.9935 + 2.878 / math.sqrt(reynolds) + 342.75 / reynolds ** 1.5)
    return min(raw, 1.0)    # a viscosity correction cannot add capacity


def reynolds_si(q_gpm, sg, mu_cp, area_in2):
    """R = rho u D / mu at the orifice, in SI, with D = sqrt(4A/pi) and
    u = Q/A. This derives the USC 2800 rather than repeating it."""
    q_m3s = q_gpm * GPM_TO_LMIN * 1e-3 / 60.0
    a_m2 = area_in2 * IN2_TO_MM2 * 1e-6
    d_m = math.sqrt(4.0 * a_m2 / math.pi)
    u = q_m3s / a_m2
    rho = sg * RHO_WATER_60F
    mu = mu_cp * 1e-3
    return rho * u * d_m / mu


def liquid_case(q_gpm, p1_psig, p2_psig, sg, mu_cp, kd=0.65, kw=1.0, kc=1.0):
    q = q_gpm * GPM_TO_LMIN
    dp = (p1_psig - p2_psig) * PSI_TO_KPA

    def area_mm2(kv_):
        return 11.78 * q * math.sqrt(sg) / (kd * kw * kc * kv_ * math.sqrt(dp))

    kv_ = 1.0
    a = area_mm2(kv_)
    reynolds = None
    if mu_cp > 0:
        for _ in range(200):
            reynolds = reynolds_si(q_gpm, sg, mu_cp, a / IN2_TO_MM2)
            nv = kv_fit(reynolds)
            done = abs(nv - kv_) < 1e-14
            kv_ = nv
            a = area_mm2(kv_)
            if done:
                break
        reynolds = reynolds_si(q_gpm, sg, mu_cp, a / IN2_TO_MM2)
    return {
        "qGpm": q_gpm, "p1Psig": p1_psig, "p2Psig": p2_psig, "sg": sg,
        "muCp": mu_cp, "kd": kd, "kw": kw, "kc": kc,
        "areaIn2": a / IN2_TO_MM2, "kv": kv_, "reynolds": reynolds,
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


# --------------------------------------------------------------------
# API 521 fire case
# --------------------------------------------------------------------

def fire_case(wetted_ft2, adequate, env):
    a_m2 = wetted_ft2 * FT2_TO_M2
    c = 43.2 if adequate else 70.9
    q_kw = c * env * a_m2 ** 0.82
    return {
        "wettedFt2": wetted_ft2, "adequateDrainage": adequate, "envFactor": env,
        "qBtuHr": q_kw / BTU_HR_TO_KW,
    }


def relief_load(q_btuhr, latent_btulb):
    """W = Q / latent heat, taken through kW and kJ/kg so every unit
    packaging in the USC statement is exercised."""
    q_kw = q_btuhr * BTU_HR_TO_KW
    latent_kjkg = latent_btulb * 1055.05585262 / LB / 1000.0
    w_kgs = q_kw / latent_kjkg
    return {
        "qBtuHr": q_btuhr, "latentBtuLb": latent_btulb,
        "wLbHr": w_kgs * 3600.0 / LB,
    }


def wetted_horizontal(d_ft, l_ft, h_ft):
    """Wetted arc by POLYLINE SUMMATION over the real circle, in SI."""
    r = d_ft / 2.0 * FT
    h = min(max(h_ft, 0.0), d_ft) * FT
    half_angle = math.acos((r - h) / r)
    arc = polyline_arc(r, half_angle)
    return {
        "orientation": "horizontal", "diameterFt": d_ft, "lengthFt": l_ft,
        "liquidLevelFt": h_ft,
        "areaFt2": (arc * (l_ft * FT)) / FT2_TO_M2,
    }


def wetted_vertical(d_ft, l_ft, h_ft):
    """Lateral wetted surface of a vertical cylinder: the same polyline
    summation right round the circle, times the wetted height."""
    r = d_ft / 2.0 * FT
    perimeter = polyline_arc(r, math.pi)
    height = min(h_ft, l_ft) * FT
    return {
        "orientation": "vertical", "diameterFt": d_ft, "lengthFt": l_ft,
        "liquidLevelFt": h_ft,
        "areaFt2": (perimeter * height) / FT2_TO_M2,
    }


# --------------------------------------------------------------------
# flare knockout drum
# --------------------------------------------------------------------

def drag_c(re):
    """SHARED empirical correlation, held for literature (see header)."""
    return 240.0 if re < 0.1 else 24.0 / re + 3.0 / math.sqrt(re) + 0.34


def dropout(d_micron, rho_l, rho_v, mu_cp):
    """Terminal velocity by BISECTION on the force residual: form drag on
    a sphere against its buoyant weight. The 4/3 (which API 521 prints
    rounded to 1.15) falls out of the balance and is never typed."""
    d = d_micron * 1e-6
    rl = rho_l * 16.018463373960138
    rv = rho_v * 16.018463373960138
    mu = mu_cp * 1e-3
    weight = (math.pi * d ** 3 / 6.0) * G_SI * (rl - rv)

    def residual(u):
        re = rv * u * d / mu
        drag = 0.5 * drag_c(re) * rv * u * u * (math.pi * d * d / 4.0)
        return drag - weight

    ud = bisect(residual, 1e-9, 100.0)
    return {
        "dropletMicron": d_micron, "rhoLLbFt3": rho_l, "rhoVLbFt3": rho_v,
        "muVCp": mu_cp, "udFtS": ud / FT,
    }


def ko_drum(q_acfs, ud_fts, d_ft, f):
    """Required length as a transit time against a fall time, with the
    vapour cross-section from SIMPSON QUADRATURE of the area integral
    over the circle above the liquid level, in SI.

    f is the liquid level as a fraction of the diameter. The area
    integral in the angle substitution y = r(1 - cos u) is
    A_liquid = 2 r^2 integral sin^2 u du, which is smooth; nothing here
    is (theta - sin theta) / 2 pi.
    """
    q = q_acfs * FT ** 3
    ud = ud_fts * FT
    d = d_ft * FT
    r = d / 2.0
    u_h = math.acos(1.0 - 2.0 * f)
    a_liquid = simpson(lambda u: 2.0 * r * r * math.sin(u) ** 2, 0.0, u_h)
    a_total = math.pi * r * r
    a_vapor = a_total - a_liquid
    v_vapor = q / a_vapor
    fall = d - f * d
    fall_time = fall / ud
    length = v_vapor * fall_time
    return {
        "qVaporAcfs": q_acfs, "udFtS": ud_fts, "diameterFt": d_ft,
        "liquidFraction": f,
        "vVaporFtS": v_vapor / FT,
        "requiredLengthFt": length / FT,
        "ld": length / d,
        "liquidAreaFraction": a_liquid / a_total,
    }


# --------------------------------------------------------------------
# flare radiation
# --------------------------------------------------------------------

def sphere_area(r):
    """The area of a sphere by QUADRATURE of R^2 sin(theta) over the
    solid angle. 4 pi R^2 is never written."""
    return 2.0 * math.pi * r * r * simpson(math.sin, 0.0, math.pi, 4000)


def radiation(q_kw, dist_m, f, tau):
    return {
        "qKw": q_kw, "distanceM": dist_m, "fractionRadiated": f,
        "transmissivity": tau,
        "kWm2": tau * f * q_kw / sphere_area(dist_m),
    }


def radiation_distance(q_kw, allowable, f, tau):
    """The setback by BISECTION on the quadrature intensity, not by
    inverting a closed form."""
    d = bisect(lambda r: tau * f * q_kw / sphere_area(r) - allowable, 1e-3, 1e7)
    return {
        "qKw": q_kw, "allowableKwM2": allowable, "fractionRadiated": f,
        "transmissivity": tau, "distanceM": d,
    }


# --------------------------------------------------------------------
# adiabatic blowdown, in closed form
# --------------------------------------------------------------------

def blowdown_case(volume_ft3, p0_psia, t0_r, p_end_psia, mw, k, z,
                  orifice_d_in, cd):
    """The march has a closed-form solution, so the oracle does not march.

    In the vessel the expansion is isentropic at constant volume, so
    T = T0 (m/m0)^(k-1) and p = m z Rs T / V, hence p is proportional to
    m^k. Choked discharge is mdot = A p sqrt(k M/(z Ru T)) phi with
    phi = (2/(k+1))^((k+1)/(2(k-1))), so

        dm/dt = -B m^((k+1)/2),
        B = A phi sqrt(k z Rs T0) / (V m0^((k-1)/2))

    which is separable:

        t = 2 (m^((1-k)/2) - m0^((1-k)/2)) / (B (k-1)),
        m_end = m0 (p_end/p0)^(1/k),
        T_end = T0 (p_end/p0)^((k-1)/k).

    Every constant is SI: the USC 520 packaging, the (k-1) exponent in
    the engine's temperature march, and the absence of any hidden
    discharge coefficient are all checked by the agreement.
    """
    v = volume_ft3 * FT ** 3
    p0 = p0_psia * PSI_TO_KPA * 1000.0
    p_end = p_end_psia * PSI_TO_KPA * 1000.0
    t0 = t0_r / 1.8
    m_kg = mw / 1000.0
    rs = R_U / m_kg
    a = cd * math.pi / 4.0 * (orifice_d_in * IN) ** 2
    m0 = p0 * v / (z * rs * t0)
    phi = (2.0 / (k + 1.0)) ** ((k + 1.0) / (2.0 * (k - 1.0)))
    b = a * phi * math.sqrt(k * z * rs * t0) / (v * m0 ** ((k - 1.0) / 2.0))
    m_end = m0 * (p_end / p0) ** (1.0 / k)
    t_seconds = 2.0 * (m_end ** ((1.0 - k) / 2.0) - m0 ** ((1.0 - k) / 2.0)) / (b * (k - 1.0))
    t_end_k = t0 * (p_end / p0) ** ((k - 1.0) / k)
    return {
        "volumeFt3": volume_ft3, "p0Psia": p0_psia, "t0R": t0_r,
        "pEndPsia": p_end_psia, "mw": mw, "k": k, "z": z,
        "orificeDIn": orifice_d_in, "cd": cd,
        "timeS": t_seconds, "finalTR": t_end_k * 1.8,
        "initialMassLb": m0 / LB, "massRemainingLb": m_end / LB,
    }


def main():
    out = {}
    out["gas"] = [
        gas_case(50000, 314.7, 14.7, 610, 19.0, 0.9, 1.25),
        gas_case(12000, 114.7, 14.7, 560, 44.0, 0.95, 1.18),
        gas_case(80000, 514.7, 300.0, 640, 22.0, 0.88, 1.3),   # subcritical
        gas_case(80000, 514.7, 400.0, 640, 22.0, 0.88, 1.3),   # deeper subcritical
        # every coefficient off its default, so a dropped one shows
        gas_case(25000, 214.7, 30.0, 580, 28.0, 0.92, 1.35,
                 kd=0.9, kb=0.88, kc=0.9),
    ]
    out["liquid"] = [
        liquid_case(500, 250, 50, 0.9, 0.0),
        liquid_case(500, 250, 50, 0.9, 400.0),  # viscous, Kv iterates
        liquid_case(1200, 180, 0, 1.05, 30.0),
        # Re below 200, where 342.75 is worth 23 percent of the Kv
        # denominator: the only band that can discriminate that constant
        liquid_case(200, 150, 50, 0.95, 5000.0),
        # Re above 2e5, where the raw fit exceeds 1 and the clamp bites
        liquid_case(800, 300, 100, 1.0, 0.5),
    ]
    out["steam"] = [
        steam_case(60000, 314.7),
        steam_case(60000, 314.7, ksh=0.83),
        steam_case(150000, 2014.7),  # Napier active
        # the top of the published Napier range, where the fit's slopes
        # are worth enough to discriminate
        steam_case(150000, 3100.0),
        # inside 1500 to 1580.3, where the correction makes the valve BIGGER
        steam_case(120000, 1550.0),
    ]
    out["wetted"] = [
        wetted_horizontal(10, 40, 5),   # half full
        wetted_horizontal(10, 40, 2.5),
        wetted_horizontal(8, 24, 7.9),
        wetted_horizontal(12, 30, 1.2),
        wetted_vertical(10, 40, 12),
        wetted_vertical(6, 25, 25),
        wetted_vertical(8, 30, 0.0),
    ]
    out["fire"] = [
        fire_case(628.3, True, 1.0),
        fire_case(628.3, False, 1.0),
        fire_case(300.0, True, 0.3),
        fire_case(1250.0, False, 0.85),
    ]
    out["load"] = [
        relief_load(4138017.515498443, 150.0),
        relief_load(1.0e7, 100.0),
        relief_load(6791329.672426842, 87.5),
    ]
    out["dropout"] = [
        dropout(300, 31.2, 0.5, 0.012),
        dropout(600, 43.7, 1.2, 0.010),
        dropout(150, 50.0, 0.3, 0.015),
        dropout(450, 38.0, 0.75, 0.011),
    ]
    out["drum"] = [
        ko_drum(120.0, 1.73, 8.0, 0.0),
        ko_drum(120.0, 1.73, 8.0, 0.10),
        ko_drum(120.0, 1.73, 8.0, 0.25),
        ko_drum(120.0, 1.73, 8.0, 0.50),
        ko_drum(120.0, 1.73, 8.0, 0.75),
        ko_drum(45.0, 2.4, 5.0, 0.30),
    ]
    out["radiation"] = [
        radiation(50000, 100, 0.3, 1.0),
        radiation(50000, 100, 0.2, 0.8),
        radiation(12000, 35, 0.25, 0.9),
    ]
    out["setback"] = [
        radiation_distance(12000, 6.31, 0.25, 0.9),
        radiation_distance(50000, 1.58, 0.3, 1.0),
    ]
    out["blowdown"] = [
        blowdown_case(500, 1014.7, 560, 114.7, 19.0, 1.3, 0.9, 1.0, 0.85),
        blowdown_case(500, 1014.7, 560, 114.7, 19.0, 1.3, 0.9, 2.0, 0.85),
        blowdown_case(2000, 1514.7, 600, 214.7, 22.0, 1.25, 0.88, 1.5, 0.80),
        # a step that would empty the vessel in one dtS: the march used
        # to break and report a depressuring time of ZERO
        blowdown_case(5, 1014.7, 560, 114.7, 19.0, 1.3, 0.9, 4.0, 0.85),
        blowdown_case(500, 1014.7, 560, 114.7, 19.0, 1.3, 0.9, 38.0, 0.85),
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
