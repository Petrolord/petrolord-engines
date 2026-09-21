#!/usr/bin/env python3
"""Oracle for engines/facilities/corrosion.js.

HONEST STATEMENT OF WHAT THIS FILE CAN AND CANNOT DO, route by route.
The previous version of this file claimed independence it did not have:
`vm_direct`, `scale_factor` and `ph_factor` were the module's
expressions character for character, and `shear_darcy` formed
f_darcy = 4 f_fanning and then (f_darcy/8) rho U^2, which is
0.5 f_fanning rho U^2, which is the module's own line. Fifteen of
seventeen defects planted in the engine AND in this file together left
the gate green, and this file caught none of the seventeen.

A CONSTANT TYPED IN TWO FILES CANNOT BE VALIDATED BY COMPARING THE TWO
FILES. That is not a defect of this oracle, it is arithmetic. So the
work is split three ways and this file only does the first two:

 1. GENUINELY INDEPENDENT DERIVATIONS, where a second route exists:
    - the series combination, solved by BISECTION on 1/CR rather than
      formed as a reciprocal;
    - the inhibitor time-average, rebuilt as an explicit 8760 hour
      duty cycle;
    - the wall shear, reached through a MOMENTUM BALANCE on the pipe:
      Darcy-Weisbach gives a pressure drop over a stated length, and
      the force balance dP * (pi d^2/4) = tau * (pi d L) gives
      tau = dP d / (4 L). This file writes BOTH dP and tau, and the
      gate checks the force balance itself, so the 0.5 versus 0.25
      versus f_darcy/8 packaging is held by an identity rather than by
      a transcription;
    - the protective-film ONSET temperature, found by BISECTION on
      this file's own scale factor and cross-checked against the
      closed form 2400/(6.7 + 0.6 log10 f);
    - the remaining life, reached by MARCHING the wall loss forward in
      fixed time steps until the allowance is consumed, rather than by
      dividing;
    - the H2S to CO2 ratio, formed from MOLE FRACTIONS, which is
      independent of the total pressure entirely. This is what catches
      a `screen` that computes pH2S as the total pressure, or that
      feeds a FUGACITY where a partial pressure belongs.
 2. STRUCTURAL REWRITES, which check a functional form and NOT the
    constants in it, and say so:
    - fugacity as a_unit ** P, which checks that log a is proportional
      to P and cannot check 0.0031, 1.4 or the 250 bar cap;
    - the reaction rate as A * exp(-EaR/T) * f**0.58, a product of
      three separated factors against the module's single power of
      ten, which checks the multiplicative separation and cannot check
      4.93, 1119 or 0.58;
    - the mass-transfer term as a REFERENCE-POINT scaling
      Vm_ref * (U/U_ref)^0.8 * (d_ref/d)^0.2 * (f/f_ref), which checks
      the scaling structure and the linearity in fCO2 and cannot check
      2.45, 0.8 or 0.2;
    - the pH factor built as a GEOMETRIC SEQUENCE over whole pH units
      plus a fractional remainder, which checks the decade law and
      cannot check the -0.5 slope or the reference of 4. The
      dimensionless two-pH-unit ratio IS constant free and is written
      out for the gate.
 3. WHAT NEITHER FILE CAN DO is checked in
    __tests__/facilities.corrosion.test.js, which is a THIRD location:
    every held constant is PINNED against a literal there, and the
    constant-free invariants (a factor of exactly 1 at the reference,
    exactly one decade per two pH units, exact linearity in fCO2, the
    force balance, 1/CR - 1/Vr - 1/Vm = 0) are asserted there. Moving
    a constant in the engine and in this file together now fails the
    pin.

The golden this writes is SYNTHETIC. There is no published de
Waard-Milliams case, no MR0175 or ISO 15156 clause and no rate-band
table anywhere in this repository, and a number recalled from memory is
not a published datum. See FINDINGS-corrosion.md.

stdlib only. Writes test-data/facilities/goldens/corrosion_cases.json
"""

import json
import math
import os

LN10 = math.log(10.0)
BAR_TO_PSIA = 14.503773800721815
ABSOLUTE_ZERO_C = -273.15

# Held constants, typed here as the second of three locations. The gate
# pins each one against a literal of its own.
FUG_A = 0.0031
FUG_B = 1.4
FUG_CAP_BAR = 250.0
DWM_A = 4.93
DWM_B = 1119.0
DWM_N = 0.58
VM_C = 2.45
VM_U_EXP = 0.8
VM_D_EXP = 0.2
SCALE_A = 2400.0
SCALE_N = 0.6
SCALE_C = 6.7
PH_SLOPE = -0.5
PH_REF = 4.0
BLASIUS_C = 0.046
BLASIUS_N = -0.2
LAMINAR_C = 16.0
SWITCH_RE = 4000.0
FILM_STRIP_PA = 100.0
FILM_MODERATE_PA = 50.0
SOUR_THRESHOLD_BAR = 0.0035
REGIME_CARBONATE_MAX = 1.0 / 500.0
REGIME_MIXED_MAX = 1.0 / 20.0
CATEGORY_LOW = 0.1
CATEGORY_MODERATE = 0.5
CATEGORY_HIGH = 1.0
CONTROLLING_MARGIN = 0.1
INHIBITOR_SHORTFALL_PP = 0.1

# The momentum-balance route's stated pipe length. Any length works: it
# cancels. Stating it makes the force balance checkable.
SHEAR_LENGTH_M = 100.0


# --------------------------------------------------------------------
# 2. Structural rewrites (form checked, constants not)
# --------------------------------------------------------------------

def fugacity_coefficient(t_c, p_bar):
    """a = a_unit ** P, exploiting that log a is PROPORTIONAL to P.

    Checks: that the pressure enters linearly in the exponent.
    Cannot check: 0.0031, 1.4, or the 250 bar cap value.
    """
    t_k = t_c + 273.15
    p = min(max(p_bar, 0.0), FUG_CAP_BAR)
    a_unit = 10.0 ** (FUG_A - FUG_B / t_k)   # the coefficient at 1 bar
    return a_unit ** p


def fugacity(t_c, p_bar, y_co2):
    a = fugacity_coefficient(t_c, p_bar)
    pco2 = p_bar * y_co2
    return a, pco2, a * pco2


def vr_arrhenius(t_c, fco2):
    """Vr as a PRODUCT of three separated factors:
        Vr = A * exp(-EaR/T) * f**n,  A = 10^4.93,  EaR = 1119 ln10
    against the module's single 10 ** (sum of three terms).

    Checks: the multiplicative separation, the natural-exponential
    Arrhenius form, and that fCO2 enters as a real power rather than
    inside a logarithm.
    Cannot check: 4.93, 1119, 0.58.
    """
    t_k = t_c + 273.15
    pre = 10.0 ** DWM_A
    arr = math.exp(-DWM_B * LN10 / t_k)
    return pre * arr * (fco2 ** DWM_N)


def vm_reference_scaling(u, d, fco2):
    """Reference-point scaling from Vm(1 m/s, 1 m, 1 bar) = 2.45.

    Checks: the scaling structure, the sign of the diameter exponent,
    and exact linearity in fCO2.
    Cannot check: 2.45, 0.8, 0.2.
    """
    u_ref, d_ref, f_ref = 1.0, 1.0, 1.0
    vm_ref = VM_C
    return vm_ref * (u / u_ref) ** VM_U_EXP * (d_ref / d) ** VM_D_EXP * (fco2 / f_ref)


def scale_factor(t_c, fco2):
    """The factor as a QUOTIENT of separated factors:
        F = 10^(2400/T) / (f^0.6 * 10^6.7)
    against the module's 10 ** (2400/T - 0.6 log10 f - 6.7).

    Checks: the grouping and the sign of the fCO2 term.
    Cannot check: 2400, 0.6, 6.7, nor whether the factor belongs on the
    reaction term or on the combined rate. The module puts it on the
    COMBINED rate; that choice is held for literature.
    """
    if not fco2 > 0:
        return 1.0
    t_k = t_c + 273.15
    f = (10.0 ** (SCALE_A / t_k)) / ((fco2 ** SCALE_N) * (10.0 ** SCALE_C))
    return f if f < 1.0 else 1.0


def scale_onset_bisect(fco2):
    """The protective-film onset temperature, found by BISECTION on the
    UNCLAMPED scale expression rather than by rearranging it.

    Genuinely independent of the closed form, and cross-checked against
    it below.
    """
    def unclamped(t_c):
        t_k = t_c + 273.15
        return (10.0 ** (SCALE_A / t_k)) / ((fco2 ** SCALE_N) * (10.0 ** SCALE_C))
    lo, hi = -200.0, 2000.0
    if not (unclamped(lo) > 1.0 > unclamped(hi)):
        return None
    for _ in range(400):
        mid = 0.5 * (lo + hi)
        if unclamped(mid) > 1.0:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def scale_onset_closed(fco2):
    denom = SCALE_C + SCALE_N * math.log10(fco2)
    if not denom > 0:
        return None
    return SCALE_A / denom - 273.15


def ph_factor(ph, ref=PH_REF):
    """Built as a GEOMETRIC SEQUENCE: one whole pH unit at a time by
    repeated multiplication, then a fractional remainder.

    Checks: the decade law, and that the factor is exactly 1 at the
    reference.
    Cannot check: -0.5, or the reference value of 4.
    Returns None BELOW the reference, which is what the module now does
    instead of returning 1.
    """
    if ph < ref:
        return None
    step = 10.0 ** PH_SLOPE          # one whole pH unit
    whole = int(math.floor(ph - ref))
    frac = (ph - ref) - whole
    out = 1.0
    for _ in range(whole):
        out *= step
    out *= step ** frac
    return out


# --------------------------------------------------------------------
# 1. Genuinely independent derivations
# --------------------------------------------------------------------

def combine_by_bisection(vr, vm):
    """Solve 1/CR = 1/Vr + 1/Vm for CR by bisection instead of forming
    the reciprocal directly. Genuinely independent."""
    target = 1.0 / vr + 1.0 / vm
    lo, hi = 1e-12, max(vr, vm) * 2.0
    for _ in range(400):
        mid = 0.5 * (lo + hi)
        if 1.0 / mid > target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def shear_momentum_balance(u, d, rho, mu, length_m=SHEAR_LENGTH_M):
    """Wall shear through a MOMENTUM BALANCE rather than a packaging of
    the friction factor.

    Darcy-Weisbach:  dP = f_D (L/d) (rho U^2 / 2)
    Force balance:   dP (pi d^2 / 4) = tau (pi d L)  =>  tau = dP d/(4 L)

    Both numbers are written out, so the gate can check the FORCE
    BALANCE itself as an identity instead of trusting either packaging.
    Genuinely independent of the module's 0.5 f_fanning rho U^2.
    Cannot check: 0.046, -0.2, 16, or the Reynolds 4000 switch.
    """
    re = rho * u * d / mu
    f_fanning = BLASIUS_C * re ** BLASIUS_N if re > SWITCH_RE else LAMINAR_C / re
    f_darcy = 4.0 * f_fanning
    dp_pa = f_darcy * (length_m / d) * 0.5 * rho * u * u
    tau = dp_pa * d / (4.0 * length_m)
    return {
        "reynolds": re,
        "flowRegime": "turbulent" if re > SWITCH_RE else "laminar",
        "fanningFriction": f_fanning,
        "darcyFriction": f_darcy,
        "pressureDropPa": dp_pa,
        "lengthM": length_m,
        "tauPa": tau,
        "filmRisk": "high" if tau > FILM_STRIP_PA else ("moderate" if tau > FILM_MODERATE_PA else "low"),
    }


def inhibitor_duty_cycle(uninhibited, eff_pct, avail_pct, hours=8760):
    """Explicit hour-by-hour duty-cycle average over a year. Genuinely
    independent of the algebraic time-average."""
    eff = min(max(eff_pct, 0.0), 100.0) / 100.0
    avail = min(max(avail_pct, 0.0), 100.0) / 100.0
    on_hours = int(round(hours * avail))
    total = on_hours * uninhibited * (1 - eff) + (hours - on_hours) * uninhibited
    return total / hours


def life_by_marching(remaining_mm, rate_mm_yr, dt_yr=1e-3, max_yr=5000.0):
    """Remaining life by MARCHING the wall loss forward at a fixed time
    step until the allowance is consumed, rather than dividing.

    Returns the marched life and the step, so the gate can state the
    tolerance it is holding the division to.
    """
    if not rate_mm_yr > 0:
        return None
    t = 0.0
    loss = 0.0
    steps = 0
    limit = int(max_yr / dt_yr)
    while loss < remaining_mm and steps < limit:
        loss += rate_mm_yr * dt_yr
        t += dt_yr
        steps += 1
    if steps >= limit:
        return None
    return t


def regime_from_mole_fractions(y_h2s, y_co2):
    """The H2S to CO2 ratio from MOLE FRACTIONS, which needs no
    pressure at all, against the module's ratio of partial pressures.

    Genuinely independent: P y1 / (P y2) = y1 / y2 whatever P is, so a
    `screen` that drops a mole fraction, or that substitutes a FUGACITY
    for a partial pressure, disagrees with this route and cannot
    disagree with a transcription of itself.
    Cannot check: 1/500 or 1/20.
    """
    if not y_co2 > 0:
        return {"regime": "unknown", "ratio": None, "rateApplies": None}
    ratio = y_h2s / y_co2
    if ratio < REGIME_CARBONATE_MAX:
        return {"regime": "carbonate", "ratio": ratio, "rateApplies": True}
    if ratio < REGIME_MIXED_MAX:
        return {"regime": "mixed", "ratio": ratio, "rateApplies": True}
    return {"regime": "sulphide", "ratio": ratio, "rateApplies": False}


def sour_screen_in_psia(p_bar, y_h2s):
    """The sour comparison done entirely in PSIA, a different unit path
    from the module's comparison in bar.

    Cannot check: 0.0035 bar, which is held. Note it is 0.050763 psia
    and NOT the 0.05 psia the module's comment used to claim.
    """
    ph2s_psia = p_bar * y_h2s * BAR_TO_PSIA
    threshold_psia = SOUR_THRESHOLD_BAR * BAR_TO_PSIA
    return {
        "ph2sBar": p_bar * y_h2s,
        "ph2sPsia": ph2s_psia,
        "thresholdPsia": threshold_psia,
        "sour": ph2s_psia >= threshold_psia,
        "decadesAboveThreshold": (math.log10(ph2s_psia / threshold_psia)
                                  if ph2s_psia > 0 else None),
    }


def rate_category(mm_yr):
    if mm_yr is None or not math.isfinite(mm_yr):
        return None
    if not mm_yr > 0:
        return "negligible"
    if mm_yr < CATEGORY_LOW:
        return "low"
    if mm_yr < CATEGORY_MODERATE:
        return "moderate"
    if mm_yr < CATEGORY_HIGH:
        return "high"
    return "severe"


# --------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------

def rate_case(t_c, p_bar, y_co2, u, d, ph, rho, mu, eff, avail,
              regime="waterWet", water_cut=1.0, film_intact=True):
    a, pco2, fco2 = fugacity(t_c, p_bar, y_co2)
    vr = vr_arrhenius(t_c, fco2)
    vm = vm_reference_scaling(u, d, fco2)
    combined = combine_by_bisection(vr, vm)
    fs = scale_factor(t_c, fco2)
    fp = ph_factor(ph)
    f_water = 0.0 if regime == "oilWet" else (water_cut if regime == "intermittent" else 1.0)
    uninhib = combined * fs * fp * f_water
    eff_used = eff if film_intact else 0.0
    rate = inhibitor_duty_cycle(uninhib, eff_used, avail)
    margin = abs(vm - vr) / max(min(vm, vr), 1e-12)
    if margin < CONTROLLING_MARGIN:
        controlling = "comparable"
    else:
        controlling = "mass transfer" if vm < vr else "reaction kinetics"
    retained = rate / uninhib if uninhib > 0 else None
    return {
        "tC": t_c, "pTotalBar": p_bar, "co2MolFrac": y_co2,
        "velocityMS": u, "diameterM": d, "ph": ph,
        "densityKgM3": rho, "viscosityPaS": mu,
        "flowRegime": regime, "waterCutFrac": water_cut,
        "inhibitorEfficiencyPct": eff, "inhibitorAvailabilityPct": avail,
        "inhibitorFilmIntact": film_intact,
        "fugacityCoefficient": a, "pco2Bar": pco2, "fco2Bar": fco2,
        "pressureCapApplied": p_bar > FUG_CAP_BAR,
        "reactionMmYr": vr, "massTransferMmYr": vm,
        "combinedMmYr": combined,
        "controlling": controlling, "controllingMargin": margin,
        "scaleFactor": fs, "scaleOnsetTC": scale_onset_bisect(fco2),
        "scaleOnsetClosedTC": scale_onset_closed(fco2),
        "phFactor": fp, "phTwoUnitRatio": (ph_factor(ph + 2.0) / fp) if fp else None,
        "waterWettingFactor": f_water,
        "uninhibitedMmYr": uninhib,
        "rateMmYr": rate,
        "effectiveInhibitionPct": (1.0 - retained) * 100.0 if retained is not None else None,
        "rateCategory": rate_category(rate),
        "shear": shear_momentum_balance(u, d, rho, mu),
    }


def screen_case(name, t_c, p_bar, y_co2, y_h2s, u, d, ph, rho, mu,
                eff, avail, allowance_mm, consumed_mm, design_life_yr,
                regime="waterWet", water_cut=1.0):
    """A second implementation of the module's whole assembly, in the
    module's own order: shear first, then the film verdict, then the
    rate with the credit the verdict allows, then the regime from mole
    fractions, then the life by marching, then the binding constraint
    from its own ordered rules."""
    sh = shear_momentum_balance(u, d, rho, mu)
    stripped = sh["filmRisk"] == "high"
    r = rate_case(t_c, p_bar, y_co2, u, d, ph, rho, mu, eff, avail,
                  regime, water_cut, film_intact=not stripped)
    r_credited = rate_case(t_c, p_bar, y_co2, u, d, ph, rho, mu, eff, avail,
                           regime, water_cut, film_intact=True)
    reg = regime_from_mole_fractions(y_h2s, y_co2)
    sour = sour_screen_in_psia(p_bar, y_h2s)

    withheld = None
    if reg["rateApplies"] is False:
        withheld = "sulphide regime"
    elif not y_co2 > 0:
        withheld = "no CO2"
    elif r["waterWettingFactor"] == 0:
        withheld = "oil wet"

    category = None if withheld else rate_category(r["rateMmYr"])

    life_years = None
    remaining_mm = allowance_mm - consumed_mm
    if withheld is None and allowance_mm > 0 and remaining_mm > 0:
        life_years = life_by_marching(remaining_mm, r["rateMmYr"])

    if withheld:
        binding = "the model does not apply"
    elif stripped:
        binding = "wall shear on the inhibitor film"
    elif (life_years is not None and design_life_yr > 0
          and life_years < design_life_yr):
        binding = "the corrosion allowance against the design life"
    elif r["controlling"] == "comparable":
        binding = "neither resistance alone"
    elif r["controlling"] == "mass transfer":
        binding = "mass transfer to the wall"
    else:
        binding = "reaction kinetics"

    return {
        "name": name,
        "tC": t_c, "pTotalBar": p_bar, "co2MolFrac": y_co2, "h2sMolFrac": y_h2s,
        "velocityMS": u, "diameterM": d, "ph": ph,
        "densityKgM3": rho, "viscosityPaS": mu,
        "flowRegime": regime, "waterCutFrac": water_cut,
        "inhibitorEfficiencyPct": eff, "inhibitorAvailabilityPct": avail,
        "corrosionAllowanceMm": allowance_mm, "consumedMm": consumed_mm,
        "designLifeYears": design_life_yr,
        "tauPa": sh["tauPa"], "reynolds": sh["reynolds"],
        "shearFlowRegime": sh["flowRegime"],
        "pressureDropPa": sh["pressureDropPa"], "shearLengthM": sh["lengthM"],
        "filmRisk": sh["filmRisk"], "filmStripped": stripped,
        "rateMmYr": r["rateMmYr"],
        "rateWithFilmCreditMmYr": r_credited["rateMmYr"],
        "uninhibitedMmYr": r["uninhibitedMmYr"],
        "effectiveInhibitionPct": r["effectiveInhibitionPct"],
        "controlling": r["controlling"],
        "category": category,
        "withheld": withheld,
        "binding": binding,
        "ph2sBar": sour["ph2sBar"], "ph2sPsia": sour["ph2sPsia"],
        "sour": sour["sour"],
        "decadesAboveThreshold": sour["decadesAboveThreshold"],
        "regime": reg["regime"], "regimeRatio": reg["ratio"],
        "remainingYears": life_years,
        "lifeStepYr": 1e-3,
    }


def main():
    out = {}

    # ----------------------------------------------------------------
    # Rate cases. Conditions are deliberately NOT round numbers, so a
    # capstone written later against realistic round conditions cannot
    # collide with a golden row. Every pH is at or above the pH
    # correction's reference of 4, because the module now refuses below
    # it; the row that used to run at pH 3.8 has moved to 4.2 and the
    # row at pH 4.0 sits exactly ON the reference, where the factor is
    # 1 by definition rather than by a clamp.
    # ----------------------------------------------------------------
    out["cases"] = [
        # the five original conditions, pH 3.8 -> 4.2
        rate_case(60, 50, 0.03, 3.0, 0.15, 4.5, 900.0, 1e-3, 0, 100),
        rate_case(80, 100, 0.02, 5.0, 0.25, 5.0, 850.0, 8e-4, 90, 95),
        rate_case(40, 20, 0.05, 1.5, 0.10, 4.0, 950.0, 2e-3, 0, 100),
        rate_case(120, 200, 0.01, 8.0, 0.30, 5.5, 800.0, 5e-4, 95, 80),
        rate_case(25, 10, 0.10, 0.5, 0.05, 4.2, 1000.0, 1e-3, 0, 100),
        # the protective film ON, at two different fugacities so the
        # onset temperature is not one number
        rate_case(103.7, 62.4, 0.028, 2.7, 0.2032, 4.6, 880.0, 9e-4, 0, 100),
        rate_case(88.3, 118.6, 0.045, 4.1, 0.1016, 5.2, 865.0, 7e-4, 85, 92),
        # LAMINAR, which no row reached before
        rate_case(46.2, 33.7, 0.021, 0.28, 0.0508, 4.35, 930.0, 1.2e-2, 0, 100),
        # straddling the Reynolds 4000 switch, 3960 and 4040
        rate_case(46.2, 33.7, 0.021, 1.00584, 0.0508, 4.35, 930.0, 1.2e-2, 0, 100),
        rate_case(46.2, 33.7, 0.021, 1.02616, 0.0508, 4.35, 930.0, 1.2e-2, 0, 100),
        # REACTION KINETICS controlling, which no row reached before
        rate_case(27.4, 19.8, 0.10, 9.3, 0.0508, 4.3, 1010.0, 1.1e-3, 0, 100),
        # the two resistances within 1 percent of each other, where the
        # module reports "comparable" rather than naming one
        rate_case(27.4, 19.8, 0.10, 3.6, 0.0508, 4.3, 1010.0, 1.1e-3, 0, 100),
        # OIL WET and INTERMITTENT, which no row reached before
        rate_case(103.7, 62.4, 0.028, 2.7, 0.2032, 4.6, 880.0, 9e-4, 90, 95,
                  regime="oilWet"),
        rate_case(103.7, 62.4, 0.028, 2.7, 0.2032, 4.6, 880.0, 9e-4, 90, 95,
                  regime="intermittent", water_cut=0.35),
        # ABOVE the 250 bar fugacity cap, which no row reached before
        rate_case(71.2, 312.5, 0.015, 5.6, 0.254, 4.9, 790.0, 6e-4, 0, 100),
        # the two ends of a fCO2 range now spanning three orders of
        # magnitude rather than a factor of two
        rate_case(71.2, 240.0, 0.35, 5.6, 0.254, 4.9, 790.0, 6e-4, 0, 100),
        rate_case(38.6, 4.2, 0.004, 1.9, 0.0762, 4.1, 970.0, 1.4e-3, 0, 100),
    ]

    # The inhibitor arithmetic, which is the point people get wrong.
    # 100 percent is now allowed through rather than silently clamped
    # to 99.9, and two out-of-range values are carried so the gate can
    # check that the clamp is REPORTED.
    out["inhibitor"] = []
    for eff, avail in [(95, 100), (95, 80), (95, 50), (99, 90), (70, 100),
                       (100, 95), (90, 95), (90, 50), (0, 100)]:
        out["inhibitor"].append({
            "uninhibitedMmYr": 2.0,
            "inhibitorEfficiencyPct": eff,
            "inhibitorAvailabilityPct": avail,
            "rateMmYr": inhibitor_duty_cycle(2.0, eff, avail),
            "effectiveInhibitionPct": (1.0 - inhibitor_duty_cycle(2.0, eff, avail) / 2.0) * 100.0,
            "shortfallPp": eff - (1.0 - inhibitor_duty_cycle(2.0, eff, avail) / 2.0) * 100.0,
            "warns": (eff - (1.0 - inhibitor_duty_cycle(2.0, eff, avail) / 2.0) * 100.0) > INHIBITOR_SHORTFALL_PP,
        })
    out["inhibitorClamps"] = [
        {"inhibitorEfficiencyPct": 105, "inhibitorAvailabilityPct": 95,
         "clampedEfficiencyPct": 100.0, "clampsExpected": 1},
        {"inhibitorEfficiencyPct": -50, "inhibitorAvailabilityPct": 95,
         "clampedEfficiencyPct": 0.0, "clampsExpected": 1},
        {"inhibitorEfficiencyPct": 90, "inhibitorAvailabilityPct": 140,
         "clampedEfficiencyPct": 90.0, "clampsExpected": 1},
    ]

    # The pH route, at and above the reference. Below it the module
    # refuses, and `factor` is null here to say so.
    out["phRows"] = []
    for ph in [3.0, 3.9, 4.0, 4.25, 4.5, 5.0, 6.0, 6.5, 7.4, 9.0]:
        f = ph_factor(ph)
        out["phRows"].append({
            "ph": ph, "phReference": PH_REF, "factor": f,
            "refusesBelowReference": f is None,
            "twoUnitRatio": (ph_factor(ph + 2.0) / f) if f else None,
        })

    # The protective-film onset, bisected and in closed form, over a
    # fugacity range where it moves by more than 30 C.
    out["scaleOnset"] = []
    for fco2 in [0.02, 0.2, 1.0, 1.3442, 5.0, 20.0, 49.3]:
        out["scaleOnset"].append({
            "fco2Bar": fco2,
            "onsetBisectedTC": scale_onset_bisect(fco2),
            "onsetClosedTC": scale_onset_closed(fco2),
        })

    # The H2S to CO2 ratio from mole fractions, straddling both
    # boundaries. `pTotalBar` varies so a route that leans on pressure
    # cannot agree.
    out["regimeRows"] = []
    for p_bar, y_h2s, y_co2 in [
        (51.0004, 0.0001, 0.03), (51.0004, 0.001, 0.03), (51.0004, 0.01, 0.03),
        (7.3, 0.001, 0.03), (240.0, 0.001, 0.03),
        (51.0004, 0.03 / 500.0, 0.03), (51.0004, 0.03 / 20.0, 0.03),
        (51.0004, 0.0, 0.03), (51.0004, 0.002, 0.0),
    ]:
        r = regime_from_mole_fractions(y_h2s, y_co2)
        out["regimeRows"].append({
            "pTotalBar": p_bar, "h2sMolFrac": y_h2s, "co2MolFrac": y_co2,
            "ph2sBar": p_bar * y_h2s, "pco2Bar": p_bar * y_co2,
            "ratio": r["ratio"], "regime": r["regime"],
            "rateApplies": r["rateApplies"],
        })

    # The sour comparison, done in psia.
    out["sourRows"] = []
    for p_bar, y_h2s in [(51.0004, 0.0), (51.0004, 1e-6), (1.0, SOUR_THRESHOLD_BAR),
                         (51.0004, 0.0035 / 51.0004), (51.0004, 0.001),
                         (51.0004, 0.01), (240.0, 0.05)]:
        out["sourRows"].append({
            "pTotalBar": p_bar, "h2sMolFrac": y_h2s,
            **sour_screen_in_psia(p_bar, y_h2s),
        })
    out["sourThreshold"] = {
        "bar": SOUR_THRESHOLD_BAR,
        "psia": SOUR_THRESHOLD_BAR * BAR_TO_PSIA,
        "psiaClaimedByTheOldComment": 0.05,
        "barThatWouldBeExactly0p05Psia": 0.05 / BAR_TO_PSIA,
    }

    # Remaining life, marched rather than divided.
    out["lifeRows"] = []
    for rate, allowance, consumed, design in [
        (0.1, 3.0, 0.0, 20.0), (0.3, 3.0, 0.0, 20.0), (0.7545236542623222, 3.175, 0.0, 20.0),
        (2.4, 6.35, 1.2, 25.0), (0.0331, 3.175, 0.5, 20.0),
    ]:
        remaining = allowance - consumed
        out["lifeRows"].append({
            "rateMmYr": rate, "corrosionAllowanceMm": allowance,
            "consumedMm": consumed, "designLifeYears": design,
            "remainingMm": remaining,
            "marchedYears": life_by_marching(remaining, rate),
            "stepYr": 1e-3,
            "requiredAllowanceMm": rate * design,
            "meetsDesignLife": life_by_marching(remaining, rate) >= design,
            # the allowance the design life is short by, formed here as a
            # DEFICIT of years times rate rather than as a subtraction of
            # two allowances
            "shortfallMm": max(0.0, (design - life_by_marching(remaining, rate)) * rate),
        })
    out["lifeZeroRate"] = {
        "rateMmYr": 0.0, "corrosionAllowanceMm": 3.175, "designLifeYears": 20.0,
        "remainingYears": None, "unbounded": True, "meetsDesignLife": None,
    }

    # The rate bands, at and either side of every boundary.
    out["categoryRows"] = []
    for mm in [0.0, 1e-9, 0.0999, 0.1, 0.1001, 0.4999, 0.5, 0.5001,
               0.9999, 1.0, 1.0001, 12.3]:
        out["categoryRows"].append({"rateMmYr": mm, "category": rate_category(mm)})
    out["categoryBands"] = {"low": CATEGORY_LOW, "moderate": CATEGORY_MODERATE,
                            "high": CATEGORY_HIGH}

    # The whole screen, reassembled independently.
    out["screenRows"] = [
        screen_case("app defaults", 60.0, 51.00042745349288, 0.03, 0.001,
                    3.048, 0.1524, 4.5, 897.036, 1e-3, 90, 95,
                    3.175, 0.0, 20.0),
        screen_case("film stripped at 60 ft/s", 60.0, 51.00042745349288, 0.03, 0.001,
                    18.288, 0.1524, 4.5, 897.036, 1e-3, 90, 95,
                    3.175, 0.0, 20.0),
        screen_case("sulphide regime, rate withheld", 60.0, 51.00042745349288, 0.03, 0.01,
                    3.048, 0.1524, 4.5, 897.036, 1e-3, 90, 95,
                    3.175, 0.0, 20.0),
        screen_case("oil wet, rate withheld", 60.0, 51.00042745349288, 0.03, 0.001,
                    3.048, 0.1524, 4.5, 897.036, 1e-3, 90, 95,
                    3.175, 0.0, 20.0, regime="oilWet"),
        screen_case("intermittent at 35 percent water cut", 60.0, 51.00042745349288, 0.03, 0.001,
                    3.048, 0.1524, 4.5, 897.036, 1e-3, 90, 95,
                    3.175, 0.0, 20.0, regime="intermittent", water_cut=0.35),
        screen_case("not sour, carbonate", 46.2, 33.7, 0.021, 2e-6,
                    1.00584, 0.0508, 4.35, 930.0, 1.2e-2, 0, 100,
                    3.175, 0.4, 15.0),
        screen_case("above the fugacity cap", 71.2, 312.5, 0.015, 0.0002,
                    5.6, 0.254, 4.9, 790.0, 6e-4, 80, 90,
                    6.35, 0.0, 25.0),
        screen_case("reaction kinetics controlling", 27.4, 19.8, 0.10, 0.00015,
                    9.3, 0.0508, 4.3, 1010.0, 1.1e-3, 0, 100,
                    3.175, 0.0, 20.0),
        screen_case("protective film on", 103.7, 62.4, 0.028, 0.00004,
                    2.7, 0.2032, 4.6, 880.0, 9e-4, 0, 100,
                    3.175, 0.0, 20.0),
    ]

    # Input sets the module must REFUSE. The gate asserts each one
    # returns an error and that the message names the input.
    out["refusals"] = [
        {"why": "a blank temperature must not take the no-CO2 branch",
         "call": "screen", "override": {"tC": None}, "expect": "temperature"},
        {"why": "a temperature at or below absolute zero",
         "call": "screen", "override": {"tC": -295.6}, "expect": "absolute zero"},
        {"why": "a blank velocity is not an unlimited mass-transfer capacity",
         "call": "screen", "override": {"velocityMS": None}, "expect": "velocity"},
        {"why": "a blank diameter",
         "call": "screen", "override": {"diameterM": None}, "expect": "diameter"},
        {"why": "a blank density must not leave the shear check silently undone",
         "call": "screen", "override": {"densityKgM3": None}, "expect": "screening incomplete"},
        {"why": "a blank viscosity must not leave the shear check silently undone",
         "call": "screen", "override": {"viscosityPaS": None}, "expect": "screening incomplete"},
        {"why": "a CO2 mole fraction above 1",
         "call": "screen", "override": {"co2MolFrac": 3.0}, "expect": "exceed the total pressure"},
        {"why": "a CO2 mole fraction above 1 with no H2S",
         "call": "corrosionRate", "override": {"co2MolFrac": 3.0}, "expect": "between 0 and 1"},
        {"why": "an H2S mole fraction above 1",
         "call": "screen", "override": {"h2sMolFrac": 1.5}, "expect": "between 0 and 1"},
        {"why": "CO2 and H2S summing above the total",
         "call": "screen", "override": {"co2MolFrac": 0.7, "h2sMolFrac": 0.4},
         "expect": "exceed the total pressure"},
        {"why": "a water cut fraction above 1",
         "call": "screen", "override": {"flowRegime": "intermittent", "waterCutFrac": 5.0},
         "expect": "between 0 and 1"},
        {"why": "an unrecognised wetting regime",
         "call": "screen", "override": {"flowRegime": "oil-wet-ish"}, "expect": "not recognised"},
        {"why": "a blank pH",
         "call": "screen", "override": {"ph": None}, "expect": "in-situ pH"},
        {"why": "a pH below the correction's reference",
         "call": "screen", "override": {"ph": 3.0}, "expect": "reference pH"},
        {"why": "a pH outside 0 to 14",
         "call": "screen", "override": {"ph": 21.0}, "expect": "between 0 and 14"},
        {"why": "a zero total pressure",
         "call": "screen", "override": {"pTotalBar": 0.0}, "expect": "total pressure"},
    ]
    out["refusalBase"] = {
        "tC": 60.0, "pTotalBar": 51.00042745349288, "co2MolFrac": 0.03,
        "h2sMolFrac": 0.001, "ph": 4.5, "velocityMS": 3.048, "diameterM": 0.1524,
        "densityKgM3": 897.036, "viscosityPaS": 1e-3, "flowRegime": "waterWet",
        "waterCutFrac": 1.0, "inhibitorEfficiencyPct": 90,
        "inhibitorAvailabilityPct": 95, "corrosionAllowanceMm": 3.175,
        "consumedMm": 0.0, "designLifeYears": 20.0,
    }

    # Held constants, written out so the gate can pin them without
    # reading the engine. Each value appears in THREE files: the
    # engine, this oracle and the gate's own literal.
    out["heldConstants"] = {
        "fugacityA": FUG_A, "fugacityB": FUG_B, "fugacityCapBar": FUG_CAP_BAR,
        "dwmA": DWM_A, "dwmB": DWM_B, "dwmN": DWM_N,
        "vmC": VM_C, "vmUExp": VM_U_EXP, "vmDExp": VM_D_EXP,
        "scaleA": SCALE_A, "scaleN": SCALE_N, "scaleC": SCALE_C,
        "phSlope": PH_SLOPE, "phReference": PH_REF,
        "blasiusC": BLASIUS_C, "blasiusN": BLASIUS_N, "laminarC": LAMINAR_C,
        "switchRe": SWITCH_RE,
        "filmStripPa": FILM_STRIP_PA, "filmModeratePa": FILM_MODERATE_PA,
        "sourThresholdBar": SOUR_THRESHOLD_BAR,
        "regimeCarbonateMax": REGIME_CARBONATE_MAX,
        "regimeMixedMax": REGIME_MIXED_MAX,
        "categoryLow": CATEGORY_LOW, "categoryModerate": CATEGORY_MODERATE,
        "categoryHigh": CATEGORY_HIGH,
        "controllingMargin": CONTROLLING_MARGIN,
        "barToPsia": BAR_TO_PSIA,
    }

    out["provenance"] = {
        "published": False,
        "why": ("No published de Waard-Milliams case, no MR0175 or ISO 15156 "
                "clause and no corrosion rate-band table exists anywhere in "
                "this repository, so every row here is SYNTHETIC. Route "
                "independence and the gate's pins carry the load instead. A "
                "number recalled from memory is not a published datum and none "
                "is typed here."),
        "withdrawn": ("The sour-service severity region and its material "
                      "guidance were withdrawn from the engine rather than "
                      "retuned, so no golden row covers them and none should."),
    }

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "corrosion_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    counts = {k: (len(v) if isinstance(v, list) else 1) for k, v in out.items()}
    print("wrote", dest)
    print("rows per block:", counts)
    print("total rows:", sum(counts.values()))


if __name__ == "__main__":
    main()
