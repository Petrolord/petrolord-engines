#!/usr/bin/env python3
"""Independent oracle for engines/facilities/heatTransfer.js.

WHAT EACH ROUTE CHECKS, AND WHAT IT CANNOT. The honest answer is not
the same for all of them, so each route says so in its own docstring
and the table below is the summary. Three of the six routes this file
used to carry were TRANSCRIPTIONS of the engine written in SI, which is
a multiply followed by a divide on the same expression: the wall factor
2 could be moved to 2.2 in the engine AND here and the suite stayed 19
of 19 green, and so could the log mean becoming an arithmetic mean.

| route          | checks                                   | cannot check |
|----------------|------------------------------------------|--------------|
| lmtd           | the log mean, by INTEGRATING the driving | nothing      |
|                | force it is the closed form of           |              |
| eps counter    | the closed form, by an RK4 march of the  | nothing      |
|                | exchanger ODEs with a LINEAR shot        |              |
| eps parallel   | the closed form, by an RK4 initial-value | nothing      |
|                | march of the parallel ODEs               |              |
| eps 1-2 shell  | the closed form, by an RK4 march of the  | nothing      |
|                | THREE-STREAM shell/pass-A/pass-B system  |              |
|                | with the turn-around as a boundary       |              |
|                | condition                                |              |
| F correction   | Bowman, by NTU_counter / NTU_1-2 where   | nothing      |
|                | the 1-2 NTU is inverted from the ODE     |              |
| N-shell F      | the P -> P1 conversion, by MARCHING N    | nothing      |
|                | identical shells in series               |              |
| U              | the resistance stack, built on each      | nothing      |
|                | term's OWN area and referred to the      |              |
|                | outside only at the end, with the wall   |              |
|                | term by QUADRATURE rather than a log     |              |
| tube film      | Re by 4 mdot / (pi d mu), which forms no | the fitted   |
|                | area at all; Pr, and every unit          | constants    |
|                | conversion derived from the SI           | 0.023, 0.8,  |
|                | definitions rather than typed            | 0.4, 0.14    |
| tube count     | the bundle fit, by BISECTING on the      | the eight    |
|                | bundle diameter instead of raising       | BUNDLE_K     |
|                | (N/K) to a power                         | pairs        |
| air cooler     | the log mean by integration, the air     | cp = 0.24    |
|                | balance and the density in SI, and the   |              |
|                | fan power from a pressure rise in        |              |
|                | PASCALS, which MEASURES what water       |              |
|                | density the constant 6356 is written     |              |
|                | against                                  |              |
| hot day        | the rated duty, by solving the LMTD      | nothing      |
|                | equation at fixed UA -- the other        |              |
|                | classical method, not eps-NTU            |              |
| balances       | every unit packaging, by going through   | the balance  |
|                | kg, m, J and WATTS and coming back       | itself,      |
|                |                                          | which is a   |
|                |                                          | definition   |
|                |                                          | in any       |
|                |                                          | language     |

THE FITTED CONSTANTS CANNOT BE VALIDATED BY ANY ORACLE. 0.023, the
0.8 and 0.4 exponents, the Sieder-Tate 0.14, the laminar 3.66, the
transition band, the air cp and the eight bundle pairs are fits and
tables, not derivations. They are PINNED by literal in the jest gate,
which is a pin and not a validation and says so there. What the pin
buys is that moving one is a reviewed act: three of the defects that
used to leave the suite green were moves of numbers on that list.

EVERY GOLDEN ROW IS SYNTHETIC. None of the conditions below is taken
from a publication, because this repository carries no published heat
exchanger case to take one from, and inventing a citation is worse than
saying so. What replaces published data here is (a) route independence,
(b) the constant pins, and (c) a block of ANALYTIC LIMITS -- F -> 1 as
P -> 0, the parallel and 1-2 effectiveness ceilings, the Cr = 0 collapse
of all three arrangements onto one curve -- which are known truths that
need no citation and which discriminate.

stdlib only. Writes test-data/facilities/goldens/heattransfer_cases.json
"""

import json
import math
import os

# ------------------------------------------------------------------ #
# Unit definitions. These are DEFINITIONS, not fits: the international
# Btu, the international foot, the pound, standard gravity and the SI
# gas constant. Every conversion below is derived from them rather than
# typed, so the engine's rounded constants can be measured against a
# derivation instead of against a second copy of themselves.
# ------------------------------------------------------------------ #
BTU_IT_J = 1055.05585262
FT_M = 0.3048
IN_M = 0.0254
LB_KG = 0.45359237
G0 = 9.80665
R_SI = 8.31446261815324          # J/(mol.K)
HOUR_S = 3600.0
DELTA_F_PER_DELTA_K = 5.0 / 9.0

# Btu/(hr.ft2.F) -> W/(m2.K)
U_BTU_TO_SI = BTU_IT_J / (HOUR_S * FT_M * FT_M * DELTA_F_PER_DELTA_K)
# Btu/(hr.ft.F) -> W/(m.K)
K_BTU_TO_SI = BTU_IT_J / (HOUR_S * FT_M * DELTA_F_PER_DELTA_K)
# Btu/(lb.F) -> J/(kg.K)
CP_BTU_TO_SI = BTU_IT_J / (LB_KG * DELTA_F_PER_DELTA_K)
# centipoise -> lb/(ft.hr).  1 cP = 1e-3 kg/(m.s)
CP_TO_LB_FT_HR = 1e-3 * HOUR_S * FT_M / LB_KG
# lbf/in2 -> Pa
PSI_PA = (LB_KG * G0) / (IN_M * IN_M)
# horsepower -> W  (550 ft.lbf/s)
HP_W = 550.0 * FT_M * LB_KG * G0
# ft3 -> m3
FT3_M3 = FT_M ** 3

# The water density the fan constant 6356 is written against, MEASURED
# rather than cited: 33000 ft.lbf/min per hp over 6356 over 12 in/ft.
FAN_CONSTANT = 6356.0
WATER_LB_FT3_IMPLIED_BY_6356 = 33000.0 / FAN_CONSTANT * 12.0

# Fitted constants, PINNED here so the oracle holds a second copy that
# the gate can compare against a third copy typed in the test. A pin is
# not a validation.
PIN = {
    "dittusBoelterA": 0.023,
    "dittusBoelterReExp": 0.8,
    "dittusBoelterPrExpHeating": 0.4,
    "siederTateExp": 0.14,
    "laminarNusselt": 3.66,
    "airCpBtuLbF": 0.24,
    "airMolecularWeight": 28.9625,
}
BUNDLE_K = {
    "30": {1: (0.319, 2.142), 2: (0.249, 2.207), 4: (0.175, 2.285), 6: (0.0743, 2.499)},
    "45": {1: (0.215, 2.207), 2: (0.156, 2.291), 4: (0.158, 2.263), 6: (0.0402, 2.617)},
    "90": {1: (0.215, 2.207), 2: (0.156, 2.291), 4: (0.158, 2.263), 6: (0.0402, 2.617)},
}


def f_to_k(t_f):
    return (t_f + 459.67) * DELTA_F_PER_DELTA_K


# ------------------------------------------------------------------ #
# 1. LMTD by integration of the driving force
# ------------------------------------------------------------------ #
def lmtd_by_integration(th_in, th_out, tc_in, tc_out, parallel=False, n=200000):
    """Integrate the exchanger to get the MEAN driving force.

    The log mean is the closed form OF this integral and nothing else,
    so integrating it is a genuinely different computation: it never
    evaluates a logarithm. Both streams are linear in the heat
    transferred, so dT(f) is linear in the duty fraction f and the mean
    driving force is Q divided by the integral of dQ/dT.

    In counter flow the cold stream runs the other way, so it is
    traversed from its OUTLET at f = 0; in parallel flow both streams
    are traversed from their inlets.
    """
    acc = 0.0
    for i in range(n):
        fm = (i + 0.5) / n
        th = th_in - (th_in - th_out) * fm
        if parallel:
            tc = tc_in + (tc_out - tc_in) * fm
        else:
            tc = tc_out - (tc_out - tc_in) * fm
        dt = th - tc
        acc += (1.0 / dt) * (1.0 / n)
    return 1.0 / acc


# ------------------------------------------------------------------ #
# 2. Effectiveness by RK4 marches of the exchanger ODEs
# ------------------------------------------------------------------ #
def _rk4(deriv, state, h, steps):
    s = list(state)
    for _ in range(steps):
        k1 = deriv(s)
        s2 = [s[i] + 0.5 * h * k1[i] for i in range(len(s))]
        k2 = deriv(s2)
        s3 = [s[i] + 0.5 * h * k2[i] for i in range(len(s))]
        k3 = deriv(s3)
        s4 = [s[i] + h * k3[i] for i in range(len(s))]
        k4 = deriv(s4)
        s = [s[i] + h * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6.0
             for i in range(len(s))]
    return s


def eps_counter_by_ode(ntu, cr, n=4000):
    """Counter flow, marched along the area coordinate.

    Non-dimensional on Cmin (the hot stream here): dTh/dz = -(Th - Tc),
    dTc/dz = -cr (Th - Tc) on z in [0, NTU], Th(0) = 1, and Tc(0) is
    unknown because the cold stream enters at the FAR end. The system is
    LINEAR, so the residual Tc(NTU) is affine in the guess Tc(0) and two
    marches locate the shot exactly; the shipped route bisected 200
    times for the same answer.
    """
    if ntu == 0:
        return 0.0

    def march(tc0):
        return _rk4(lambda s: (-(s[0] - s[1]), -cr * (s[0] - s[1])),
                    (1.0, tc0), ntu / n, n)

    a = march(0.0)
    b = march(1.0)
    # residual r(tc0) = Tc(NTU); solve r = 0
    tc0 = -a[1] / (b[1] - a[1])
    end = march(tc0)
    return 1.0 - end[0]


def eps_parallel_by_ode(ntu, cr, n=4000):
    """Parallel flow: both streams enter at z = 0, so it is a pure
    initial-value march with no shot at all."""
    if ntu == 0:
        return 0.0
    end = _rk4(lambda s: (-(s[0] - s[1]), cr * (s[0] - s[1])),
               (1.0, 0.0), ntu / n, n)
    return 1.0 - end[0]


def eps_shell12_by_ode(ntu, cr, n=4000):
    """One shell pass, two tube passes, marched as THREE streams.

    The shell fluid (Cmin, normalised to 1) runs from x = 0 to x = 1.
    The tube fluid (Cmax = 1/cr) makes pass A from 0 to 1 and pass B
    back from 1 to 0, each pass carrying half the UA. The turn-around
    is a BOUNDARY CONDITION, Tb(1) = Ta(1), which is what makes this a
    different problem from the counter-flow one and not a restatement of
    the 1-2 closed form.

        dTs/dx = -(NTU/2)(Ts - Ta) - (NTU/2)(Ts - Tb)
        dTa/dx = +(NTU/2) cr (Ts - Ta)
        dTb/dx = -(NTU/2) cr (Ts - Tb)

    Ts(0) = 1, Ta(0) = 0, Tb(0) unknown. Linear again, so two marches
    and one linear solve.
    """
    if ntu == 0:
        return 0.0
    half = ntu / 2.0

    def deriv(s):
        ts, ta, tb = s
        return (-half * (ts - ta) - half * (ts - tb),
                half * cr * (ts - ta),
                -half * cr * (ts - tb))

    def march(tb0):
        return _rk4(deriv, (1.0, 0.0, tb0), 1.0 / n, n)

    a = march(0.0)
    b = march(1.0)
    # residual r(tb0) = Tb(1) - Ta(1)
    ra = a[2] - a[1]
    rb = b[2] - b[1]
    tb0 = -ra / (rb - ra)
    end = march(tb0)
    return 1.0 - end[0]


def _invert_eps(eps_fn, eps, cr, hi=40.0, iters=120):
    """NTU from an effectiveness, by bisection on the ODE route.

    This is what makes the parallel and 1-2 effectiveness checks real.
    The shipped suite checked those two only against their OWN inverses,
    an identity that holds for any mutually inverse pair whether either
    one is right.
    """
    lo = 0.0
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        trial = eps_fn(mid, cr)
        # A shot that loses its conditioning at large NTU must NOT be
        # read as "not hot enough yet": that is how a bisection walks to
        # its own upper bound and reports it as an answer.
        if math.isfinite(trial) and trial < eps:
            lo = mid
        else:
            hi = mid
    ntu = 0.5 * (lo + hi)
    check = eps_fn(ntu, cr)
    if not math.isfinite(check) or abs(check - eps) > 1e-7:
        raise ValueError(
            f"the NTU inversion did not land: asked for eps={eps} at cr={cr}, "
            f"NTU={ntu} gives eps={check}. This route refuses rather than "
            f"returning the edge of its own search window.")
    return ntu


def ntu_counter_closed(eps, cr):
    if cr == 0:
        return -math.log(1 - eps)
    if abs(cr - 1) < 1e-12:
        return eps / (1 - eps)
    return (1 / (cr - 1)) * math.log((eps - 1) / (eps * cr - 1))


def f_by_epsntu_ode(p, r):
    """F by the effectiveness-NTU identity, with the 1-2 NTU taken from
    the THREE-STREAM ODE rather than from a closed form.

        F = NTU_counter / NTU_1-2   at the same P and R

    The counter-flow NTU is the published closed form, which shares no
    expression with Bowman; the 1-2 NTU is inverted from the march
    above. Neither half restates Bowman.
    """
    if r <= 1.0:
        eps, cr = p, r
    else:
        eps, cr = p * r, 1.0 / r
    if not (0.0 < eps < 1.0):
        raise ValueError(f"F route: effectiveness {eps} is outside (0, 1) at P={p} R={r}")
    ntu_shell = _invert_eps(lambda n, c: eps_shell12_by_ode(n, c, n=1500), eps, cr)
    return ntu_counter_closed(eps, cr) / ntu_shell


def n_shell_overall_p(p1, r, n):
    """March N identical 1-2 shells in SERIES COUNTER-CURRENT and report
    the P the WHOLE unit reaches, given the P1 each shell runs at.

    This is the check the P -> P1 conversion never had. The conversion
    is the one thing in this module the recon proved CORRECT and nobody
    checked, which is why inverting its exponent left the suite green.

    The hot stream enters shell 1 and leaves shell N; the cold stream
    enters shell N and leaves shell 1, which is what "in series" means
    and what the standard substitution is derived for. Shell i takes
    hot h[i-1] and cold c[i] and returns h[i] = h[i-1] - R P1 (h[i-1] -
    c[i]) and a cold outlet c[i-1] = c[i] + P1 (h[i-1] - c[i]). The
    cascade is linear in the one unknown c[1], so two marches and one
    linear solve place it exactly.
    """
    def march(c1):
        h = 1.0
        c = c1
        c_out = None
        for i in range(1, n + 1):
            rise = p1 * (h - c)
            if i == 1:
                c_out = c + rise            # the WHOLE unit's cold outlet
            h_next = h - r * rise
            if i < n:
                # cold entering the next shell, from that shell's balance
                c = (c - p1 * h_next) / (1.0 - p1)
            h = h_next
        return c_out, c     # c is now the cold entering shell N: must be 0

    a_out, a_res = march(0.0)
    b_out, b_res = march(1.0)
    c1 = -a_res / (b_res - a_res)
    out, _ = march(c1)
    return out


# ------------------------------------------------------------------ #
# 3. The overall coefficient, from a resistance stack in SI
# ------------------------------------------------------------------ #
def _wall_resistance_by_quadrature(ri, ro, k_si, n=20000):
    """Radial conduction resistance per unit length, K/W, by SIMPSON
    quadrature of dr / (2 pi k r).

    The closed form is ln(ro/ri)/(2 pi k) and this route never evaluates
    a logarithm, which is the point: the engine's wall term carries a
    factor 2 that could be moved to 2.2 in the engine and in the old
    oracle together without a single test noticing.
    """
    if n % 2:
        n += 1
    h = (ro - ri) / n
    total = 0.0
    for i in range(n + 1):
        r = ri + i * h
        w = 1 if i in (0, n) else (4 if i % 2 else 2)
        total += w * (1.0 / (2 * math.pi * k_si * r))
    return total * h / 3.0


def overall_u(ho, hi, do_in, di_in, kw, rfo, rfi):
    """U referred to the outside area, assembled as ABSOLUTE resistances
    per unit tube length and referred to the outside surface only at the
    very end.

    Each term is built on ITS OWN area -- the outside film and fouling
    on pi.do, the inside film and fouling on pi.di -- so the do/di ratio
    the engine pre-multiplies never appears here as a ratio. Dropping it
    from both files used to leave the suite green.
    """
    ro = do_in * IN_M / 2.0
    ri = di_in * IN_M / 2.0
    ho_si = ho * U_BTU_TO_SI
    hi_si = hi * U_BTU_TO_SI
    kw_si = kw * K_BTU_TO_SI
    rfo_si = rfo / U_BTU_TO_SI
    rfi_si = rfi / U_BTU_TO_SI
    a_out = 2 * math.pi * ro           # m2 per m of tube
    a_in = 2 * math.pi * ri
    r_out_film = 1.0 / (ho_si * a_out)
    r_out_foul = rfo_si / a_out
    r_wall = _wall_resistance_by_quadrature(ri, ro, kw_si)
    r_in_foul = rfi_si / a_in
    r_in_film = 1.0 / (hi_si * a_in)
    r_total = r_out_film + r_out_foul + r_wall + r_in_foul + r_in_film
    r_clean = r_out_film + r_wall + r_in_film
    return {
        "hoBtuHrFt2F": ho, "hiBtuHrFt2F": hi, "doIn": do_in, "diIn": di_in,
        "kWallBtuHrFtF": kw, "foulingOut": rfo, "foulingIn": rfi,
        "uDirtyBtuHrFt2F": (1.0 / (r_total * a_out)) / U_BTU_TO_SI,
        "uCleanBtuHrFt2F": (1.0 / (r_clean * a_out)) / U_BTU_TO_SI,
        # the five resistances the engine returns, referred to the
        # outside area so they are directly comparable
        "resistances": {
            "outsideFilm": r_out_film * a_out * U_BTU_TO_SI,
            "outsideFouling": r_out_foul * a_out * U_BTU_TO_SI,
            "wall": r_wall * a_out * U_BTU_TO_SI,
            "insideFouling": r_in_foul * a_out * U_BTU_TO_SI,
            "insideFilm": r_in_film * a_out * U_BTU_TO_SI,
        },
    }


# ------------------------------------------------------------------ #
# 4. Tube-side film
# ------------------------------------------------------------------ #
def tube_film(m_lbhr, di_in, mu_cp, k_btu, cp_btu, n_tubes, passes, mu_wall_cp=None):
    """Dittus-Boelter with the Reynolds number formed WITHOUT an area.

    Re = 4 mdot / (pi d mu) per tube is the same Reynolds number the
    engine builds from a mass velocity over a flow area, by a route that
    never forms the area and therefore catches a dropped pi or a wrong
    tubes-per-pass. Every conversion is derived from the SI definitions
    at the top of this file rather than typed, so the engine's rounded
    2.4191 is measured against a derivation and not against a copy of
    itself. The FIT ITSELF (0.023, 0.8, 0.4, 0.14) cannot be checked by
    any oracle and is pinned, not validated.
    """
    tubes_per_pass = n_tubes / passes
    m_per_tube = (m_lbhr * LB_KG / HOUR_S) / tubes_per_pass     # kg/s
    d = di_in * IN_M
    mu = mu_cp * 1e-3                                           # Pa.s
    k = k_btu * K_BTU_TO_SI
    cp = cp_btu * CP_BTU_TO_SI
    re = 4.0 * m_per_tube / (math.pi * d * mu)
    pr = cp * mu / k
    out = {
        "mLbHr": m_lbhr, "diIn": di_in, "muCp": mu_cp, "kBtuHrFtF": k_btu,
        "cpBtuLbF": cp_btu, "nTubes": n_tubes, "passes": passes,
        "re": re, "pr": pr,
    }
    if re < 2300:
        out["regime"] = "laminar"
        out["hBtuHrFt2F"] = PIN["laminarNusselt"] * k / d / U_BTU_TO_SI
        return out
    nu = PIN["dittusBoelterA"] * re ** PIN["dittusBoelterReExp"] \
        * pr ** PIN["dittusBoelterPrExpHeating"]
    phi = 1.0
    if mu_wall_cp:
        out["muWallCp"] = mu_wall_cp
        phi = (mu_cp / mu_wall_cp) ** PIN["siederTateExp"]
        out["siederTateFactor"] = phi
    out["regime"] = "turbulent"
    out["hBtuHrFt2F"] = nu * phi * k / d / U_BTU_TO_SI
    return out


# ------------------------------------------------------------------ #
# 5. Bundle geometry, by bisection rather than by a power
# ------------------------------------------------------------------ #
def tube_count(area_ft2, do_in, length_ft, layout_deg=30, passes=2, clearance_in=2.5):
    """Tube count and bundle diameter.

    The bundle fit is D_b = do (N/K)^(1/n1). This route BISECTS on D_b
    for the diameter that satisfies (D_b/do)^n1 = N/K instead of raising
    (N/K) to the reciprocal power, which is what catches an inverted
    exponent: the shipped suite checked only that a bigger area gives a
    bigger bundle, and an inverted exponent still does that.
    """
    per_tube = math.pi * (do_in / 12.0) * length_ft
    n_cover = math.ceil(area_ft2 / per_tube - 1e-12)
    # a multi-pass bundle divides its tubes equally between the passes
    n = -(-n_cover // passes) * passes
    k, n1 = BUNDLE_K[str(layout_deg)][passes]
    target = n / k
    lo, hi = 1.0, 1e6
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if (mid / do_in) ** n1 < target:
            lo = mid
        else:
            hi = mid
    bundle = 0.5 * (lo + hi)
    return {
        "areaFt2": area_ft2, "doIn": do_in, "tubeLengthFt": length_ft,
        "layoutDeg": layout_deg, "passes": passes,
        "bundleClearanceIn": clearance_in,
        "nTubes": n, "tubesPerPass": n // passes, "areaPerTubeFt2": per_tube,
        "actualAreaFt2": n * per_tube,
        "bundleDiameterIn": bundle,
        "shellDiameterIn": bundle + clearance_in,
    }


# ------------------------------------------------------------------ #
# 6. The air cooler, and its hot day
# ------------------------------------------------------------------ #
def air_density_lb_ft3(t_f, psia):
    """Ideal-gas air density from the SI gas constant, so the engine's
    rounded 10.7316 psia.ft3/(lbmol.R) is measured against a derivation
    rather than against a second copy of itself."""
    p_pa = psia * PSI_PA
    t_k = f_to_k(t_f)
    m_kg_mol = PIN["airMolecularWeight"] * 1e-3
    rho_si = p_pa * m_kg_mol / (R_SI * t_k)        # kg/m3
    return rho_si / LB_KG * FT3_M3


def fan_bhp_si(acfm, static_in_h2o, fan_eff):
    """Fan shaft power through PASCALS and WATTS.

    dp = h * rho_water * g, P = Q dp / eta. The only unknown is the
    density of water the customary constant 6356 is written against, and
    that is MEASURED at the top of this file rather than cited:
    33000/(6356 x 12) = 62.3033 lb/ft3, water at roughly 80 F. Moving
    6356 in the engine and in this file together still fails, because
    this route does not contain 6356.
    """
    q_m3s = acfm * FT3_M3 / 60.0
    rho_water_si = WATER_LB_FT3_IMPLIED_BY_6356 * LB_KG / FT3_M3
    dp_pa = static_in_h2o * IN_M * rho_water_si * G0
    return q_m3s * dp_pa / fan_eff / HP_W


def air_cooler(q, t_in, t_out, amb, rise, u, sp, fan_eff, motor_eff,
               draft="forced", psia=14.7):
    air_out = amb + rise
    lm = lmtd_by_integration(t_in, t_out, amb, air_out)
    area = q / (u * lm)
    # air mass by an energy balance carried out in WATTS and kg/s
    q_w = q * BTU_IT_J / HOUR_S
    cp_si = PIN["airCpBtuLbF"] * CP_BTU_TO_SI
    d_t_k = rise * DELTA_F_PER_DELTA_K
    m_kg_s = q_w / (cp_si * d_t_k)
    m_lb_hr = m_kg_s / LB_KG * HOUR_S
    fan_inlet = amb if draft == "forced" else air_out
    rho = air_density_lb_ft3(fan_inlet, psia)
    acfm = m_lb_hr / rho / 60.0
    bhp = fan_bhp_si(acfm, sp, fan_eff)
    return {
        "qBtuHr": q, "processInF": t_in, "processOutF": t_out,
        "ambientF": amb, "airRiseF": rise, "uBtuHrFt2F": u,
        "staticPressureInH2O": sp, "fanEfficiency": fan_eff,
        "motorEfficiency": motor_eff, "draftType": draft,
        "barometricPsia": psia,
        "airOutF": air_out, "fanInletF": fan_inlet,
        "lmtdF": lm, "areaFt2": area, "airLbHr": m_lb_hr, "acfm": acfm,
        "airDensityLbFt3": rho, "fanBhp": bhp, "motorHp": bhp / motor_eff,
    }


def hot_day_by_lmtd(q, t_in, t_out, amb, rise, check_amb):
    """The hot-day duty by the OTHER classical method.

    Hold the surface and the air mass, then solve

        q2 = UA * LMTD(t_in, t_in - q2/Cproc, check_amb, check_amb + q2/Cair)

    for q2 by bisection, with UA taken from the design point and every
    log mean coming from the integration route above. The engine holds
    the effectiveness instead. Two classical methods, one answer; the
    shipped engine's answer -- scaling the duty by the ratio of two log
    means while HOLDING the process outlet fixed -- satisfies neither.
    """
    ua = q / lmtd_by_integration(t_in, t_out, amb, amb + rise)
    c_proc = q / (t_in - t_out)
    c_air = q / rise
    c_min = min(c_proc, c_air)
    lo, hi = 1e-9, c_min * (t_in - check_amb) * (1 - 1e-12)
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        th_out = t_in - mid / c_proc
        tc_out = check_amb + mid / c_air
        if th_out <= check_amb or tc_out >= t_in:
            hi = mid
            continue
        lm = lmtd_by_integration(t_in, th_out, check_amb, tc_out, n=20000)
        if ua * lm > mid:
            lo = mid
        else:
            hi = mid
    q2 = 0.5 * (lo + hi)
    return {
        "qBtuHr": q, "processInF": t_in, "processOutF": t_out,
        "ambientF": amb, "airRiseF": rise, "checkAmbientF": check_amb,
        "uaBtuHrF": ua,
        "hotQBtuHr": q2,
        "dutyFraction": q2 / q,
        "hotProcessOutF": t_in - q2 / c_proc,
        "hotAirRiseF": q2 / c_air,
    }


# ------------------------------------------------------------------ #
# 7. The definitional balances, checked for their unit packaging
# ------------------------------------------------------------------ #
def capacity_rate_si(m_lbhr, cp_btu):
    """C = m cp, computed in kg/s and J/(kg.K) and brought back.

    This checks the PACKAGING -- the pound, the hour, the Btu and the
    degree -- and not the balance, which is a definition in any
    language. Saying so is the point: an oracle that claims more than it
    does is how six golden rows ended up checking nothing.
    """
    w_per_k = (m_lbhr * LB_KG / HOUR_S) * (cp_btu * CP_BTU_TO_SI)
    return w_per_k * HOUR_S / BTU_IT_J * DELTA_F_PER_DELTA_K


def energy_balance_si(c_hot, c_cold, th_in, tc_in, q):
    """The two outlet temperatures, solved in KELVIN through watts."""
    q_w = q * BTU_IT_J / HOUR_S
    c_hot_si = c_hot * BTU_IT_J / HOUR_S / DELTA_F_PER_DELTA_K
    c_cold_si = c_cold * BTU_IT_J / HOUR_S / DELTA_F_PER_DELTA_K
    th_out_k = f_to_k(th_in) - q_w / c_hot_si
    tc_out_k = f_to_k(tc_in) + q_w / c_cold_si
    return {
        "cHot": c_hot, "cCold": c_cold, "thIn": th_in, "tcIn": tc_in,
        "qBtuHr": q,
        "thOut": th_out_k / DELTA_F_PER_DELTA_K - 459.67,
        "tcOut": tc_out_k / DELTA_F_PER_DELTA_K - 459.67,
    }


def area_required_si(q, u, lm, f):
    """A = Q / (U F dTlm), in m2 through watts, and back to ft2."""
    q_w = q * BTU_IT_J / HOUR_S
    u_si = u * U_BTU_TO_SI
    lm_k = lm * DELTA_F_PER_DELTA_K
    a_m2 = q_w / (u_si * f * lm_k)
    return a_m2 / (FT_M * FT_M)


# ------------------------------------------------------------------ #
def main():
    out = {}

    # --- constants that are DERIVED here and rounded in the engine ---
    out["derivedConstants"] = {
        "uBtuToSi": U_BTU_TO_SI,
        "kBtuToSi": K_BTU_TO_SI,
        "cpBtuToSi": CP_BTU_TO_SI,
        "cpToLbFtHrDerived": CP_TO_LB_FT_HR,
        "cpToLbFtHrEngine": 2.4191,
        "psiPa": PSI_PA,
        "hpW": HP_W,
        "waterLbFt3ImpliedBy6356": WATER_LB_FT3_IMPLIED_BY_6356,
        "gasConstantPsiaFt3LbmolRDerived":
            R_SI / (PSI_PA * FT3_M3) * (LB_KG * 1000.0) * DELTA_F_PER_DELTA_K,
    }

    # --- LMTD: counter, including a row with UNEQUAL ends at both a
    # --- large and a small ratio, and a PARALLEL row.
    out["lmtd"] = []
    for th_in, th_out, tc_in, tc_out in [
        (300, 200, 100, 180), (250, 150, 80, 140), (400, 380, 100, 120),
        (420, 260, 90, 150), (300, 180, 100, 240),
        # an end-approach ratio of 30, so the logarithm is doing real
        # work rather than sitting next to two nearly equal numbers
        (500, 110, 100, 200),
    ]:
        dt1, dt2 = th_in - tc_out, th_out - tc_in
        out["lmtd"].append({
            "thIn": th_in, "thOut": th_out, "tcIn": tc_in, "tcOut": tc_out,
            "dt1": dt1, "dt2": dt2,
            "equalEnds": abs(dt1 - dt2) < 1e-9,
            "lmtdF": lmtd_by_integration(th_in, th_out, tc_in, tc_out),
        })

    out["lmtdParallel"] = []
    for th_in, th_out, tc_in, tc_out in [
        (300, 200, 100, 180), (250, 150, 80, 140),
    ]:
        out["lmtdParallel"].append({
            "thIn": th_in, "thOut": th_out, "tcIn": tc_in, "tcOut": tc_out,
            "lmtdF": lmtd_by_integration(th_in, th_out, tc_in, tc_out, parallel=True),
        })

    out["lmtdGroups"] = []
    for th_in, th_out, tc_in, tc_out in [
        (300, 200, 100, 180), (420, 260, 90, 150),
    ]:
        out["lmtdGroups"].append({
            "thIn": th_in, "thOut": th_out, "tcIn": tc_in, "tcOut": tc_out,
            "p": (tc_out - tc_in) / (th_in - tc_in),
            "r": (th_in - th_out) / (tc_out - tc_in),
        })

    # --- F correction, one shell and several ---
    out["fCorrection"] = []
    for p, r in [(0.4, 0.8), (0.3, 1.5), (0.5, 1.0), (0.25, 2.5), (0.6, 0.5)]:
        out["fCorrection"].append({"p": p, "r": r, "shellPasses": 1,
                                   "f": f_by_epsntu_ode(p, r)})

    # N > 1. The engine converts the whole-unit P into the P1 one shell
    # runs at; this golden carries the P1 that MARCHING N shells in
    # series reproduces the stated P with, and the F at that P1.
    out["fMultiShell"] = []
    for p, r, n in [(0.6, 1.0, 2), (0.75, 1.0, 3), (0.7, 0.5, 2),
                    (0.45, 1.5, 2), (0.8, 0.6, 3), (0.3, 2.5, 2),
                    (0.55, 0.8, 4)]:
        # invert the march for P1
        lo, hi = 1e-12, 0.999999999
        for _ in range(200):
            mid = 0.5 * (lo + hi)
            if n_shell_overall_p(mid, r, n) < p:
                lo = mid
            else:
                hi = mid
        p1 = 0.5 * (lo + hi)
        out["fMultiShell"].append({
            "p": p, "r": r, "shellPasses": n, "p1": p1,
            "f": f_by_epsntu_ode(p1, r),
        })

    # --- effectiveness-NTU, all three arrangements, by ODE ---
    out["epsNtu"] = []
    for ntu, cr, arrangement in [
        (1.0, 0.5, "counter"), (2.0, 0.8, "counter"), (3.0, 1.0, "counter"),
        (0.5, 0.25, "counter"),
        (1.0, 0.5, "parallel"), (2.0, 0.7, "parallel"), (0.5, 1.0, "parallel"),
        (1.0, 0.5, "shell1"), (2.0, 0.7, "shell1"), (3.0, 0.9, "shell1"),
        (1.5, 0.0, "counter"), (1.5, 0.0, "parallel"), (1.5, 0.0, "shell1"),
    ]:
        if cr == 0.0:
            eps = 1 - math.exp(-ntu)
            route = "the Cr = 0 limit, where all three arrangements collapse onto one curve"
        elif arrangement == "counter":
            eps = eps_counter_by_ode(ntu, cr)
            route = "RK4 counter-flow march with a linear shot"
        elif arrangement == "parallel":
            eps = eps_parallel_by_ode(ntu, cr)
            route = "RK4 parallel-flow initial-value march"
        else:
            eps = eps_shell12_by_ode(ntu, cr)
            route = "RK4 three-stream 1-2 shell march with the turn-around as a boundary condition"
        out["epsNtu"].append({
            "ntu": ntu, "cr": cr, "arrangement": arrangement,
            "epsOde": eps, "route": route,
        })

    # --- NTU from effectiveness, inverted from the ODE (NOT from the
    # --- engine's own inverse, which is an identity) ---
    out["ntuFromEps"] = []
    for eps, cr, arrangement in [
        (0.6, 0.5, "counter"), (0.5, 0.5, "parallel"), (0.55, 0.5, "shell1"),
        (0.45, 0.9, "shell1"), (0.35, 0.8, "parallel"),
    ]:
        fn = {"counter": eps_counter_by_ode,
              "parallel": eps_parallel_by_ode,
              "shell1": eps_shell12_by_ode}[arrangement]
        out["ntuFromEps"].append({
            "effectiveness": eps, "cr": cr, "arrangement": arrangement,
            "ntu": _invert_eps(lambda n, c, f=fn: f(n, c, n=1500), eps, cr),
        })

    # --- ceilings, which are analytic limits and need no citation ---
    out["ceilings"] = []
    for cr in [0.25, 0.5, 0.8, 1.0]:
        out["ceilings"].append({
            "cr": cr,
            "parallel": 1.0 / (1.0 + cr),
            "shell1": 2.0 / (1.0 + cr + math.sqrt(1.0 + cr * cr)),
            "parallelAtHighNtu": eps_parallel_by_ode(60.0, cr),
            "shell1AtHighNtu": eps_shell12_by_ode(60.0, cr, n=4000),
        })

    # --- capacity rate, energy balance, area ---
    out["capacityRate"] = [
        {"mLbHr": 50000, "cpBtuLbF": 0.55, "cBtuHrF": capacity_rate_si(50000, 0.55)},
        {"mLbHr": 80000, "cpBtuLbF": 1.0, "cBtuHrF": capacity_rate_si(80000, 1.0)},
        {"mLbHr": 137000, "cpBtuLbF": 0.62, "cBtuHrF": capacity_rate_si(137000, 0.62)},
    ]
    out["energyBalance"] = [
        energy_balance_si(27500, 80000, 300, 100, 2.75e6),
        energy_balance_si(85000, 62000, 410, 120, 9.4e6),
    ]
    out["areaRequired"] = [
        {"qBtuHr": 5e6, "uBtuHrFt2F": 120, "lmtdF": 80, "f": 0.9,
         "areaFt2": area_required_si(5e6, 120, 80, 0.9)},
        {"qBtuHr": 2.75e6, "uBtuHrFt2F": 73.85, "lmtdF": 130.06, "f": 1.0,
         "areaFt2": area_required_si(2.75e6, 73.85, 130.06, 1.0)},
    ]

    # --- U. The third row states NO defaults, so that moving a default
    # --- moves a golden number.
    out["u"] = [
        overall_u(200, 800, 0.75, 0.62, 26, 0.001, 0.002),
        overall_u(1200, 300, 1.0, 0.834, 26, 0.0005, 0.001),
        overall_u(340, 1450, 0.875, 0.732, 26, 0.0, 0.0),
    ]
    out["uDefaults"] = {
        "hoBtuHrFt2F": 250, "hiBtuHrFt2F": 900, "doIn": 0.75, "diIn": 0.652,
        "note": "states neither kWallBtuHrFtF nor either fouling factor, so the engine's defaults are what this row measures",
        **{k: v for k, v in overall_u(250, 900, 0.75, 0.652, 26, 0.0, 0.0).items()
           if k in ("uDirtyBtuHrFt2F", "uCleanBtuHrFt2F", "resistances")},
    }

    # --- tube film: turbulent, laminar, and Sieder-Tate ---
    out["tubeFilm"] = [
        tube_film(150000, 0.62, 0.5, 0.08, 0.5, 200, 2),
        tube_film(400000, 0.834, 1.2, 0.35, 1.0, 300, 4),
        tube_film(150000, 0.62, 0.5, 0.08, 0.5, 200, 2, mu_wall_cp=0.3),
        tube_film(2000, 0.62, 50, 0.08, 0.5, 100, 1),
    ]

    # --- bundle geometry ---
    out["tubeCount"] = [
        tube_count(500, 0.75, 16),
        tube_count(2000, 0.75, 16),
        tube_count(1200, 1.0, 20, layout_deg=30, passes=4, clearance_in=3.0),
        tube_count(860, 0.75, 16, layout_deg=45, passes=2),
        tube_count(860, 0.75, 16, layout_deg=90, passes=2),
    ]

    # --- air coolers, including one that states NO defaults and a
    # --- forced/induced pair at the same duty ---
    out["airCooler"] = [
        air_cooler(20e6, 250, 150, 95, 30, 4.5, 0.6, 0.65, 0.92),
        air_cooler(8e6, 180, 120, 90, 25, 5.0, 0.5, 0.7, 0.9),
        air_cooler(20e6, 250, 150, 95, 30, 4.5, 0.6, 0.65, 0.92, draft="induced"),
        air_cooler(14e6, 300, 190, 100, 28, 4.0, 0.75, 0.62, 0.94, psia=12.2),
    ]
    out["airCoolerDefaults"] = {
        "note": "states no static pressure, no fan efficiency and no motor efficiency, so the engine's defaults are what this row measures",
        **air_cooler(11e6, 220, 140, 88, 26, 4.2, 0.6, 0.65, 0.92),
    }

    out["hotDay"] = [
        hot_day_by_lmtd(20e6, 250, 150, 95, 30, 110),
        hot_day_by_lmtd(20e6, 250, 150, 95, 30, 120),
        hot_day_by_lmtd(20e6, 250, 150, 95, 30, 130),
        hot_day_by_lmtd(8e6, 180, 120, 90, 25, 105),
        hot_day_by_lmtd(14e6, 300, 190, 100, 28, 118),
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
