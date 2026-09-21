#!/usr/bin/env python3
"""Independent oracle for engines/facilities/gasProcessing.js.

WHAT CHANGED IN FC4-0, AND WHY IT HAD TO.

Three of this file's five routes used to be TRANSCRIPTIONS OF THE
ENGINE. The TEG and amine routes carried the engine's own constants and
the same expression shapes, and their claimed "SI re-derivation" was a
multiply by 0.45359237 followed by a divide by 0.45359237 on the same
expression, which is bit-identical by construction. The contactor route
was entirely in field units despite the docstring above it saying SI.
The Joule-Thomson chain had no route here at all.

The consequence was measured, not guessed. Eight defects were planted
in the engine and the suite was run against the goldens each route
regenerates. FIVE OF THE EIGHT CHANGED NOTHING: the CORRECT
Joule-Thomson formula, the contactor liquid density moved from 69.9 to
62.4 lb/ft3, the TEG water overhead moved from 1100 to 1400 Btu/lb, the
amine water density moved from 8.34 to 9.00 lb/gal, and `acidMolesDay`
multiplied by 1.5. A gate going green and a gate examining anything are
two separate claims.

SO EVERY ROUTE BELOW NOW SAYS WHAT IT CHECKS AND WHAT IT CANNOT, in its
own docstring, and the honest answer is not the same for all of them:

 * water saturation pressure: ANTOINE against the engine's MAGNUS. Two
   different published vapour-pressure fits meeting inside their shared
   band. FULLY INDEPENDENT; the negative control proves it discriminates.
 * Kremser: the stage cascade solved as a LINEAR SYSTEM by Gaussian
   elimination. FULLY INDEPENDENT arithmetic reaching the same answer.
 * Joule-Thomson: mu = (T (dV/dT)_P - V)/Cp with V built from an
   INDEPENDENTLY SOLVED z (bisection here, Newton in the engine) and
   differentiated NUMERICALLY with a five-point stencil, in SI, against
   the engine's analytic rearrangement in field units. Nothing but the
   published DAK correlation is shared. FULLY INDEPENDENT, and it is the
   route that would have caught the wrong formula.
 * the molar quantities (water content, BTEX, acid gas, the contactor's
   actual volume): the molar volume is DERIVED HERE from the SI gas
   constant and the standard base, not taken from the engine, so
   `LBMOL_SCF` is genuinely checked. A named 2.1349e-6 residual remains
   and is exactly the rounding in the package's own gas constant
   R_UNIVERSAL = 10.7316 against the SI derivation 10.731577088819062.
 * the TEG and amine BALANCES: re-expressed through kg, m3, J and W, so
   every UNIT PACKAGING in them (the gallon, the Btu, the hour, the
   Btu/lb.degF to J/kg.K chain) is checked against its SI definition.
   THE BALANCE ITSELF IS A DEFINITION AND NO ROUTE CAN CHECK IT: a lb of
   water per MMscf times MMscf per day is pounds per day whichever
   language says it. That is stated rather than dressed up.
 * the CUSTOMARY CONSTANTS in `DECLARED_SHARED` below cannot be checked
   by anything in this repository. They are held here as a SECOND COPY,
   so a change to the engine's value breaks the goldens, and the gate
   pins them by value as well. That is a pin, not a validation, and
   neither this file nor the course may present it as one.

stdlib only. Writes test-data/facilities/goldens/gasprocessing_cases.json
"""

import json
import math
import os

# ------------------------------------------------------------------ #
# SI, and only things that are exact by international agreement.
# ------------------------------------------------------------------ #
R_SI = 8.314462618           # J/(mol K), exact by the 2019 SI redefinition
LB = 0.45359237              # kg per lb, exact
INCH = 0.0254                # m, exact
FT = 12 * INCH               # m, exact
FT3 = FT ** 3
GAL_M3 = 231 * INCH ** 3     # a US gallon is exactly 231 cubic inches
PA_PER_PSI = 6894.757293168  # from the exact pound, foot and standard gravity
J_PER_BTU = 1055.05585262    # international-table Btu, exact by definition
MOL_PER_LBMOL = 1000.0 * LB  # a lbmol is the molecular weight in POUNDS
R_PER_K = 9.0 / 5.0          # degR per K, exact
R_OFFSET = 459.67            # degR = degF + 459.67, exact by definition
S_PER_DAY = 86400
S_PER_MIN = 60
LB_PER_SHORT_TON = 2000      # exact by definition
DAYS_PER_YEAR = 365          # a convention, shared with the engine

# The module's one standard base, restated here from its documentation
# rather than imported; the point of the route is that the molar volume
# is DERIVED from it and from the SI gas constant.
STD_P_PSIA = 14.696
STD_T_R = 519.67

# ------------------------------------------------------------------ #
# DECLARED SHARED: customary or measured values with no publication in
# this repository to check them against. Held here as a second copy so
# a change to the engine's value breaks the goldens. NOT a validation.
# ------------------------------------------------------------------ #
DECLARED_SHARED = {
    "MW_WATER": 18.01528,          # lb/lbmol, g/mol
    "AIR_MW": 28.9625,             # dry air; 28.9647 is also published
    "WATER_LB_PER_GAL": 8.34,      # customary; water at 60 F is 8.337193
    "TEG_LB_PER_GAL": 9.3,         # the module's one glycol density
    "WATER_OVERHEAD_BTU_PER_LB": 1100,   # latent plus sensible, folded
    # DAK (1975), the published 11-coefficient fit to Standing-Katz.
    "DAK": (0.3265, -1.07, -0.5339, 0.01569, -0.05165,
            0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.721),
    # Sutton (1985) pseudo-criticals from gas gravity.
    "SUTTON_T": (169.2, 349.5, -74.0),
    "SUTTON_P": (756.8, -131.0, -3.6),
}

MW_WATER = DECLARED_SHARED["MW_WATER"]
AIR_MW = DECLARED_SHARED["AIR_MW"]
WATER_LB_PER_GAL = DECLARED_SHARED["WATER_LB_PER_GAL"]
TEG_LB_PER_GAL = DECLARED_SHARED["TEG_LB_PER_GAL"]
WATER_OVERHEAD = DECLARED_SHARED["WATER_OVERHEAD_BTU_PER_LB"]

GAL_PER_FT3 = FT3 / GAL_M3            # exact, 7.48051948051948
TEG_LB_PER_FT3 = TEG_LB_PER_GAL * GAL_PER_FT3


def si_lbmol_scf():
    """scf per lbmol at the module's standard base, from the SI gas law.

    CHECKS `LBMOL_SCF` in the engine, which derives the same quantity
    from the package's field gas constant R_UNIVERSAL = 10.7316. The two
    differ by 2.1349e-6, which is exactly that constant's rounding above
    the SI derivation 10.731577088819062, and by nothing else. Anything
    larger is a base that moved: the 14.65 psia the engine's comment
    used to name is 3.12e-3 away.
    """
    t_k = (STD_T_R / R_PER_K)
    p_pa = STD_P_PSIA * PA_PER_PSI
    v_m3_per_mol = R_SI * t_k / p_pa
    return v_m3_per_mol * MOL_PER_LBMOL / FT3


LBMOL_SCF_SI = si_lbmol_scf()


def lbmol_from_scf(scf):
    """Pound moles in a standard volume, by the SI route above."""
    return scf / LBMOL_SCF_SI


# ------------------------------------------------------------------ #
# Water saturation: Antoine, against the engine's Magnus.
# ------------------------------------------------------------------ #

def antoine_water_psia(t_f):
    """Antoine, log10(P mmHg) = 8.07131 - 1730.63/(233.426 + T_C), 1..100 C.

    FULLY INDEPENDENT of the engine's Magnus fit. At 100 C it puts water
    at 14.697619 psia against the defining 14.695949, a ratio of
    1.000114; Magnus at the same point reads 1.027157 of it, which is
    why the engine's fit is now refused above 60 C.
    """
    t_c = (t_f - 32.0) / 1.8
    if not (1.0 <= t_c <= 100.0):
        raise ValueError(
            "the Antoine coefficients used here are published over 1 to 100 C; "
            f"{t_f} F is {t_c:.2f} C, outside the band this route stands behind")
    p_mmhg = 10.0 ** (8.07131 - 1730.63 / (233.426 + t_c))
    return p_mmhg * 0.0193367747  # mmHg -> psia


def water_content(p_psia, t_f):
    """Saturated water content, lb/MMscf, by ideal VLE in SI mols.

    CHECKS: the vapour-pressure fit (independently, by Antoine) and the
    molar volume (independently, from the SI gas constant).
    CANNOT CHECK: the molecular weight of water, which is shared.
    """
    psat = antoine_water_psia(t_f)
    if not p_psia > psat:
        raise ValueError(
            f"total pressure {p_psia} psia does not exceed the water vapour "
            f"pressure {psat:.4f} psia at {t_f} F: the mole fraction would "
            "exceed one and the case is not a gas")
    y = psat / p_psia
    # one MMscf -> m3 -> mol, then the water mole fraction -> kg -> lb
    v_m3 = 1e6 * FT3
    n_mol = (STD_P_PSIA * PA_PER_PSI) * v_m3 / (R_SI * (STD_T_R / R_PER_K))
    water_kg = n_mol * y * MW_WATER / 1000.0
    return {
        "pPsia": p_psia, "tF": t_f,
        "psatPsia": psat,
        "yWater": y,
        "lbPerMMscf": water_kg / LB,
    }


# ------------------------------------------------------------------ #
# Kremser: the stage cascade as a linear system. FULLY INDEPENDENT.
# ------------------------------------------------------------------ #

def kremser_march(A, N):
    """Fraction absorbed in a countercurrent absorber of N stages at a
    constant absorption factor A, solved as a LINEAR SYSTEM.

    Unknowns y_1..y_n, the gas leaving each stage, stage n at the inlet
    end. With linear equilibrium x_j = y_j / K, constant flows, V = 1 and
    L = A K, the balance on stage j is

        V y_{j+1} + L x_{j-1} = V y_j + L x_j
        =>  y_{j+1} + A y_{j-1} = (1 + A) y_j

    with y_{n+1} = 1 (the inlet gas) and x_0 = 0 (lean solvent). The
    tridiagonal system is solved by Gaussian elimination with partial
    pivoting. No geometric series and no closed form is used anywhere in
    this function, which is the whole point of it: the engine's Kremser
    expression must REPRODUCE this, and a half-percent perturbation of
    the closed form breaks two of the five cases.
    """
    n = int(round(N))
    size = n
    M = [[0.0] * size for _ in range(size)]
    b = [0.0] * size
    for j in range(1, n + 1):
        row = j - 1
        M[row][row] = (1.0 + A)
        if j - 1 >= 1:
            M[row][j - 2] = -A
        if j + 1 <= n:
            M[row][j] = -1.0
        else:
            b[row] = 1.0  # y_{n+1} = 1 inlet
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
    return 1.0 - y[0]  # gas leaving stage 1, the top


# ------------------------------------------------------------------ #
# TEG: the balance re-expressed through kg, m3, J and W.
# ------------------------------------------------------------------ #

def teg(gas, win, wout, ratio, lean, t_abs, t_reb, reflux, cp, lb_gal,
        overhead, btex_ppmv, btex_frac, btex_mw):
    """TEG package, assembled from MASS FLOWS AND WATTS.

    CHECKS: every unit packaging in the duty. The glycol density goes
    lb/gal -> kg/m3, the heat capacity Btu/(lb.degF) -> J/(kg.K), the
    overhead Btu/lb -> J/kg, the duty comes out in WATTS from mass flows
    and only then becomes Btu per gallon and MMBtu per hour. The engine
    computes a duty PER GALLON and multiplies by a daily volume; this
    route computes a TOTAL POWER and divides by a volumetric flow, which
    is the other order.
    CANNOT CHECK: the balance itself. `waterLbDay` is lb/MMscf times
    MMscf/day, which is a definition in any language, and the 1100 Btu
    per lb of overhead is a customary figure passed in as a case input.
    """
    removed = win - wout
    water_kg_s = removed * gas * LB / S_PER_DAY
    water_lb_s = water_kg_s / LB

    # circulation: gallons of glycol per pound of water, in m3/s
    circ_m3_s = water_lb_s * ratio * GAL_M3
    gal_s = circ_m3_s / GAL_M3
    rho_teg_kg_m3 = lb_gal * LB / GAL_M3
    glycol_kg_s = circ_m3_s * rho_teg_kg_m3

    # Btu/(lb.degF) -> J/(kg.K). A KELVIN interval is 1.8 degF intervals,
    # so this MULTIPLIES by 9/5 while the temperature difference below
    # divides by it; 1 Btu/(lb.degF) is 4186.8 J/(kg.K) exactly.
    cp_si = cp * J_PER_BTU / LB * R_PER_K
    dt_k = (t_reb - t_abs) / R_PER_K
    q_sens_w = glycol_kg_s * cp_si * dt_k

    overhead_j_kg = overhead * J_PER_BTU / LB
    q_vap_w = water_kg_s * overhead_j_kg * (1.0 + reflux)

    q_total_w = q_sens_w + q_vap_w
    to_btu_per_gal = lambda w: (w / gal_s) / J_PER_BTU

    btex_lbmol_s = lbmol_from_scf(gas * 1e6 * btex_ppmv / 1e6) / S_PER_DAY
    btex_lb_day = btex_lbmol_s * btex_frac * btex_mw * S_PER_DAY

    # the loop water balance the lean strength buys
    lean_water_lb_gal = lb_gal * (1.0 - lean / 100.0)
    glycol_lb_gal = lb_gal - lean_water_lb_gal
    rich_lb_gal = lb_gal + 1.0 / ratio
    return {
        "gasMMscfd": gas, "inletLbMMscf": win, "outletLbMMscf": wout,
        "circulationGalPerLb": ratio, "leanTegWtPct": lean,
        "absorberTF": t_abs, "reboilerTF": t_reb, "refluxRatio": reflux,
        "cpTegBtuLbF": cp, "tegLbPerGal": lb_gal,
        "waterOverheadBtuPerLb": overhead,
        "btexInletPpmv": btex_ppmv, "btexAbsorbedFrac": btex_frac,
        "btexMw": btex_mw,
        "waterLbDay": water_lb_s * S_PER_DAY,
        "circGpm": gal_s * S_PER_MIN,
        "circGpd": gal_s * S_PER_DAY,
        "sensiblePerGal": to_btu_per_gal(q_sens_w),
        "vaporPerGal": to_btu_per_gal(q_vap_w),
        "dutyBtuPerGal": to_btu_per_gal(q_total_w),
        "reboilerMMBtuHr": q_total_w * 3600.0 / (J_PER_BTU * 1e6),
        "btexLbDay": btex_lb_day,
        "btexTonsYear": btex_lb_day * DAYS_PER_YEAR / LB_PER_SHORT_TON,
        "leanWaterLbPerGal": lean_water_lb_gal,
        "richTegWtPct": glycol_lb_gal / rich_lb_gal * 100.0,
    }


# ------------------------------------------------------------------ #
# Amine: the acid-gas mole balance through the SI molar volume.
# ------------------------------------------------------------------ #

def amine(gas, co2, h2s, co2s, h2ss, mw, wtpct, lean, rich, duty, sg):
    """Amine package from the acid-gas mole balance.

    CHECKS: `acidMolesDay` against the SI molar volume, which is the one
    quantity in this balance with a physical constant in it, and the
    gallon and Btu packagings on the way to gpm and MMBtu/hr.
    CANNOT CHECK: the amine molecular weight, the solution gravity or
    the 8.34 lb/gal of water, all of which are shared table values.
    """
    removed_pct = (co2 - co2s) + (h2s - h2ss)
    acid_lbmol_day = lbmol_from_scf(gas * 1e6 * removed_pct / 100.0)
    amine_lbmol_day = acid_lbmol_day / (rich - lean)
    amine_kg_day = amine_lbmol_day * mw * LB
    soln_kg_day = amine_kg_day / (wtpct / 100.0)
    rho_soln_kg_m3 = sg * WATER_LB_PER_GAL * LB / GAL_M3
    soln_m3_day = soln_kg_day / rho_soln_kg_m3
    soln_gpd = soln_m3_day / GAL_M3
    circ_gpm = soln_gpd * S_PER_MIN / S_PER_DAY
    # duty is Btu per gallon circulated: go through joules and watts
    q_w = (soln_m3_day / GAL_M3) * duty * J_PER_BTU / S_PER_DAY
    return {
        "gasMMscfd": gas, "co2MolPct": co2, "h2sMolPct": h2s,
        "co2SpecMolPct": co2s, "h2sSpecMolPct": h2ss,
        "amineWtPct": wtpct, "leanLoading": lean, "richLoading": rich,
        "dutyBtuPerGal": duty,
        "acidMolesDay": acid_lbmol_day,
        "solutionGpd": soln_gpd,
        "circGpm": circ_gpm,
        "solutionLbPerFt3": rho_soln_kg_m3 / LB * FT3,
        "reboilerMMBtuHr": q_w * 3600.0 / (J_PER_BTU * 1e6),
    }


# ------------------------------------------------------------------ #
# DAK, implemented here and solved by BISECTION. The engine uses a
# Newton iteration on the same published residual; this is a different
# solver on the same published equation, in a different language.
# ------------------------------------------------------------------ #

def sutton(sg):
    a, b, c = DECLARED_SHARED["SUTTON_T"]
    d, e, f = DECLARED_SHARED["SUTTON_P"]
    return (a + b * sg + c * sg * sg, d + e * sg + f * sg * sg)


def dak_z(ppr, tpr):
    a = DECLARED_SHARED["DAK"]
    t1 = a[0] + a[1] / tpr + a[2] / tpr ** 3 + a[3] / tpr ** 4 + a[4] / tpr ** 5
    t2 = a[5] + a[6] / tpr + a[7] / tpr ** 2
    t3 = a[8] * (a[6] / tpr + a[7] / tpr ** 2)
    c = 0.27 * ppr / tpr

    def z_of(r):
        return (1.0 + t1 * r + t2 * r * r - t3 * r ** 5
                + a[9] * (1.0 + a[10] * r * r) * (r * r / tpr ** 3)
                * math.exp(-a[10] * r * r))

    def f(r):
        return z_of(r) * r - c

    lo, hi = 1e-14, 5.0
    if f(lo) > 0 or f(hi) < 0:
        raise ValueError(f"no bracket for Ppr {ppr} Tpr {tpr}")
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if f(mid) < 0:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-16 * max(1.0, hi):
            break
    return z_of(0.5 * (lo + hi))


def z_at(p_psia, t_f, sg):
    tpc, ppc = sutton(sg)
    return dak_z(p_psia / ppc, (t_f + R_OFFSET) / tpc)


# ------------------------------------------------------------------ #
# Contactor: Souders-Brown through the SI gas law. NOT the engine's
# standard-to-actual shortcut.
# ------------------------------------------------------------------ #

def contactor(gas, p, t_f, sg, ks, z=None, rho_l_lb_ft3=None):
    """Contactor diameter, assembled from a MOLAR flow.

    The engine converts standard to actual volume with the shortcut
    (Pstd/P)(T/Tstd) z. This route instead turns the standard volume
    into MOLES through the SI molar volume, and the moles back into an
    actual volume through the SI gas law at operating conditions. That
    is what makes the two standard bases the module used to carry
    visible: a base that appears once in the shortcut and twice here
    cannot cancel out.

    Gas density comes from the molar mass over the actual molar volume,
    not from the engine's grouped constant.

    CHECKS: the molar volume, the standard-to-actual conversion, the gas
    density, and the liquid density default when the case omits it.
    CANNOT CHECK: the molecular weight of air, the DAK coefficients or
    the Sutton coefficients, all shared and all published.
    """
    if rho_l_lb_ft3 is None:
        rho_l_lb_ft3 = TEG_LB_PER_FT3
    if z is None:
        z = z_at(p, t_f, sg)
    t_k = (t_f + R_OFFSET) / R_PER_K
    p_pa = p * PA_PER_PSI

    n_mol_s = (gas * 1e6 * FT3 / S_PER_DAY) * (STD_P_PSIA * PA_PER_PSI) \
        / (R_SI * (STD_T_R / R_PER_K))
    v_molar_act = z * R_SI * t_k / p_pa            # m3/mol at operating state
    q_act_m3_s = n_mol_s * v_molar_act
    rho_g_kg_m3 = (AIR_MW * sg / 1000.0) / v_molar_act
    rho_l_kg_m3 = rho_l_lb_ft3 * LB / FT3

    v_allow_m_s = (ks * FT) * math.sqrt((rho_l_kg_m3 - rho_g_kg_m3) / rho_g_kg_m3)
    area_m2 = q_act_m3_s / v_allow_m_s
    row = {
        "gasMMscfd": gas, "pPsia": p, "tF": t_f, "gasSg": sg,
        "ksFtS": ks,
        "z": z,
        "rhoG": rho_g_kg_m3 / LB * FT3,
        "qActFt3S": q_act_m3_s / FT3,
        "vAllowFtS": v_allow_m_s / FT,
        "diameterFt": math.sqrt(4.0 * area_m2 / math.pi) / FT,
    }
    return row


# ------------------------------------------------------------------ #
# Joule-Thomson. THE ROUTE THAT WOULD HAVE CAUGHT F-E1.
# ------------------------------------------------------------------ #

def jt_mu_f_per_psi(p_psia, t_f, sg, cp_btu_lbmol_f):
    """mu_JT by the DEFINING relation, in SI, with dV/dT NUMERICAL.

        mu = (1/Cp) [ T (dV/dT)_P - V ],   V = z R T / P

    NOTHING here uses the engine's rearrangement mu = (R T^2/(Cp P))
    (dz/dT), and nothing here divides by z. The engine divided by z
    until FC4-0 and its docstring said so too, so the error was
    documented rather than typed; the only way to see it was to form the
    molar volume and differentiate it.

    The derivative is a FIVE-POINT stencil at a relative step of 1e-3,
    against the engine's central two-point at 1e-4, so the truncation
    errors are of different orders as well as different sizes. z comes
    from the bisection solver above.

    Returns degF per psi, and dz/dT per degR to match the engine's door.
    """
    tpc, ppc = sutton(sg)
    ppr = p_psia / ppc
    t_r = t_f + R_OFFSET

    def v_m3_per_mol(tr):
        z = dak_z(ppr, tr / tpc)
        return z * R_SI * (tr / R_PER_K) / (p_psia * PA_PER_PSI)

    h = t_r * 1e-3
    # dV/dT in m3/(mol.degR): five-point central stencil
    dv_dtr = (v_m3_per_mol(t_r - 2 * h) - 8 * v_m3_per_mol(t_r - h)
              + 8 * v_m3_per_mol(t_r + h) - v_m3_per_mol(t_r + 2 * h)) / (12 * h)
    v = v_m3_per_mol(t_r)
    # Cp: Btu/(lbmol.degF) -> J/(mol.degR). A degF interval and a degR
    # interval are the SAME SIZE, so there is no 9/5 in this conversion
    # and putting one in makes mu exactly 1.8 times too large.
    cp_j_per_mol_r = cp_btu_lbmol_f * J_PER_BTU / MOL_PER_LBMOL
    # mu = (T dV/dT - V)/Cp, in m3.degR/(J) ... times Pa gives degR
    mu_r_per_pa = (t_r * dv_dtr - v) / cp_j_per_mol_r
    mu_f_per_psi = mu_r_per_pa * PA_PER_PSI

    def z_of_tr(tr):
        return dak_z(ppr, tr / tpc)
    dz_dtr = (z_of_tr(t_r - 2 * h) - 8 * z_of_tr(t_r - h)
              + 8 * z_of_tr(t_r + h) - z_of_tr(t_r + 2 * h)) / (12 * h)
    return {
        "pPsia": p_psia, "tF": t_f, "gasSg": sg,
        "cpBtuLbmolF": cp_btu_lbmol_f,
        "z": dak_z(ppr, t_r / tpc),
        "dzdT": dz_dtr,
        "muFPerPsi": mu_f_per_psi,
    }


def jt_drop(p1, p2, t_f, sg, cp, steps=20):
    """The engine's stated march, run with THIS FILE's coefficient.

    Midpoint Runge-Kutta on dT/dP = mu(P, T) from p1 down to p2, two
    coefficient evaluations per interval. The METHOD is the engine's
    declared numerical scheme and is deliberately shared, because a
    stated method is part of the answer; what is NOT shared is the
    coefficient, which is the thing being checked.

    A second march at 2000 steps is emitted beside it so the gate can
    hold the 20-step default to the discretisation error it actually
    has instead of assuming it has none. Before FC4-0 the march was
    midpoint in P and Euler in T, and that gate would have failed: it
    understated the cooling by 3119 to 6775 ppm across these cases.
    """
    def march(n):
        t = t_f
        dp = (p1 - p2) / n
        for i in range(n):
            p = p1 - dp * i
            k1 = jt_mu_f_per_psi(p, t, sg, cp)["muFPerPsi"]
            t_half = t - k1 * (dp / 2.0)
            k2 = jt_mu_f_per_psi(p - dp / 2.0, t_half, sg, cp)["muFPerPsi"]
            t -= k2 * dp
        return t
    t2 = march(steps)
    t2_fine = march(2000)
    return {
        "p1Psia": p1, "p2Psia": p2, "tF": t_f, "gasSg": sg,
        "cpBtuLbmolF": cp, "steps": steps,
        "t2F": t2, "dropF": t_f - t2,
        "t2FConverged": t2_fine, "dropFConverged": t_f - t2_fine,
    }


# ------------------------------------------------------------------ #

def main():
    out = {}
    out["derived"] = {
        "lbmolScfSi": LBMOL_SCF_SI,
        "rFieldSi": R_SI * MOL_PER_LBMOL / R_PER_K / (PA_PER_PSI * FT3),
        "galPerFt3": GAL_PER_FT3,
        "tegLbPerFt3": TEG_LB_PER_FT3,
        "psiaFt3PerBtu": J_PER_BTU / (PA_PER_PSI * FT3),
        "waterLbPerGalAt60F": 999.016 / LB * GAL_M3,
        "stdPressurePsia": STD_P_PSIA,
        "stdTemperatureR": STD_T_R,
    }
    out["water"] = [water_content(p, t) for p, t in
                    [(500, 100), (1000, 120), (200, 60), (65, 40)]]
    out["kremser"] = []
    for A, N in [(1.4, 6), (2.0, 3), (0.8, 8), (1.0, 5), (3.0, 2)]:
        out["kremser"].append({
            "absorptionFactor": A, "stages": N,
            "fractionRemoved": kremser_march(A, N),
        })
    # The first two cases are the ones this module has always published,
    # with the overhead they have always implicitly used stated out loud,
    # so that nothing in them moves for a reason other than the standard
    # base. The third is NEW and states a non-default overhead, so the
    # input is exercised somewhere other than at its default.
    out["teg"] = [
        teg(50, 60, 7, 3.0, 99.0, 100, 380, 0.25, 0.55, 9.3, 1100, 100, 0.15, 92),
        teg(120, 90, 4, 4.0, 99.5, 110, 390, 0.3, 0.55, 9.3, 1100, 250, 0.2, 92),
        teg(65, 82, 3, 2.5, 98.0, 115, 400, 0.35, 0.58, 9.25, 1250, 140, 0.18, 106),
    ]
    # A third case states NOTHING the module has a default for, so the
    # DEFAULTS are what the golden exercises: the glycol density, the
    # water overhead and the BTEX molecular weight.
    out["tegDefaults"] = [
        teg(80, 75, 6, 3.5, 98.5, 105, 375, 0.25, 0.55,
            TEG_LB_PER_GAL, WATER_OVERHEAD, 180, 0.15, 92),
    ]
    out["amine"] = [
        amine(100, 4.0, 1.0, 2.0, 0.0004, 119.16, 45, 0.05, 0.5, 800, 1.04),
        amine(30, 2.5, 0.0, 0.5, 0.0, 105.14, 28, 0.06, 0.4, 950, 1.02),
        amine(60, 1.8, 0.35, 0.4, 0.0001, 61.08, 18, 0.04, 0.35, 1100, 1.01),
    ]
    # The first two are the cases this module has always published, at the
    # 69.9 lb/ft3 the contactor used to type, so that nothing in them moves
    # for a reason other than the standard base. The third states an AMINE
    # solution density, which is the input the sweetening column needed and
    # never got. The last two supply NEITHER a z NOR a liquid density: that
    # is the branch the live Suite actually runs, and no published case
    # exercised it before FC4-0.
    out["contactor"] = [
        contactor(50, 1000, 100, 0.65, 0.3, z=0.85, rho_l_lb_ft3=69.9),
        contactor(120, 1200, 110, 0.7, 0.35, z=0.82, rho_l_lb_ft3=69.9),
        contactor(90, 950, 105, 0.68, 0.3, z=0.83,
                  rho_l_lb_ft3=1.04 * WATER_LB_PER_GAL * GAL_PER_FT3),
        contactor(50, 1000, 100, 0.65, 0.3),
        contactor(95, 850, 118, 0.72, 0.27),
    ]
    out["jt"] = [
        jt_mu_f_per_psi(20, 100, 0.65, 9.5),
        jt_mu_f_per_psi(600, 100, 0.65, 9.5),
        jt_mu_f_per_psi(1000, 100, 0.65, 9.5),
        jt_mu_f_per_psi(1000, 60, 0.65, 9.5),
        jt_mu_f_per_psi(2500, 100, 0.65, 9.5),
        jt_mu_f_per_psi(980, 91, 0.69, 10.4),
    ]
    out["jtDrop"] = [
        jt_drop(1000, 600, 100, 0.65, 9.5),
        jt_drop(1000, 400, 100, 0.65, 9.5),
        jt_drop(850, 300, 75, 0.72, 10.1),
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
