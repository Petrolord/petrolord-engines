#!/usr/bin/env python3
"""Independent oracle for engines/facilities/corrosion.js.

Independent routes:
 - the de Waard-Milliams resistance-in-series combination is checked
   against a NUMERICAL solve of 1/CR = 1/Vr + 1/Vm (bisection on CR),
   rather than the algebraic reciprocal the module forms
 - the fugacity, reaction and mass-transfer terms are recomputed from
   the published constants in natural logs (the module works in log10),
   so a transcription slip in either base shows up
 - wall shear stress is re-derived from the Darcy form
   tau = (f_darcy/8) rho U^2 against the module's Fanning form
   tau = (f_fanning/2) rho U^2, with f_darcy = 4 f_fanning
 - inhibitor time-averaging is recomputed as an explicit duty-cycle
   average over a year of hours

stdlib only. Writes test-data/facilities/goldens/corrosion_cases.json
"""

import json
import math
import os


def fugacity(t_c, p_bar, y_co2):
    t_k = t_c + 273.15
    p = min(max(p_bar, 0.0), 250.0)
    # natural-log route: log10(a) = (0.0031 - 1.4/T)P  =>
    # ln(a) = ln(10) * (0.0031 - 1.4/T) * P
    a = math.exp(math.log(10.0) * (0.0031 - 1.4 / t_k) * p)
    pco2 = p_bar * y_co2
    return a, pco2, a * pco2


def vr_natural(t_c, fco2):
    """log10 Vr = 4.93 - 1119/T + 0.58 log10 f, done in natural logs."""
    t_k = t_c + 273.15
    ln_v = math.log(10.0) * (4.93 - 1119.0 / t_k) + 0.58 * math.log(fco2)
    return math.exp(ln_v)


def vm_direct(u, d, fco2):
    return 2.45 * (u ** 0.8 / d ** 0.2) * fco2


def combine_by_bisection(vr, vm):
    """Solve 1/CR = 1/Vr + 1/Vm for CR by bisection instead of
    forming the reciprocal directly."""
    target = 1.0 / vr + 1.0 / vm
    lo, hi = 1e-9, max(vr, vm) * 2.0
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if 1.0 / mid > target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def scale_factor(t_c, fco2):
    t_k = t_c + 273.15
    log_f = 2400.0 / t_k - 0.6 * math.log10(fco2) - 6.7
    f = 10.0 ** log_f
    return f if f < 1.0 else 1.0


def ph_factor(ph, ref=4.0):
    return 10.0 ** (-0.5 * (ph - ref)) if ph > ref else 1.0


def shear_darcy(u, d, rho, mu):
    """Darcy route: tau = (f_D/8) rho U^2 with f_D = 4 f_Fanning."""
    re = rho * u * d / mu
    f_fanning = 0.046 * re ** -0.2 if re > 4000 else 16.0 / max(re, 1.0)
    f_darcy = 4.0 * f_fanning
    return re, (f_darcy / 8.0) * rho * u * u


def inhibitor_duty_cycle(uninhibited, eff_pct, avail_pct, hours=8760):
    """Explicit hour-by-hour duty-cycle average over a year."""
    eff = min(max(eff_pct, 0.0), 99.9) / 100.0
    avail = min(max(avail_pct, 0.0), 100.0) / 100.0
    on_hours = int(round(hours * avail))
    total = on_hours * uninhibited * (1 - eff) + (hours - on_hours) * uninhibited
    return total / hours


def case(t_c, p_bar, y_co2, u, d, ph, rho, mu, eff, avail):
    a, pco2, fco2 = fugacity(t_c, p_bar, y_co2)
    vr = vr_natural(t_c, fco2)
    vm = vm_direct(u, d, fco2)
    combined = combine_by_bisection(vr, vm)
    fs = scale_factor(t_c, fco2)
    fp = ph_factor(ph)
    uninhib = combined * fs * fp
    rate = inhibitor_duty_cycle(uninhib, eff, avail)
    re, tau = shear_darcy(u, d, rho, mu)
    return {
        "tC": t_c, "pTotalBar": p_bar, "co2MolFrac": y_co2,
        "velocityMS": u, "diameterM": d, "ph": ph,
        "densityKgM3": rho, "viscosityPaS": mu,
        "inhibitorEfficiencyPct": eff, "inhibitorAvailabilityPct": avail,
        "fugacityCoefficient": a, "pco2Bar": pco2, "fco2Bar": fco2,
        "reactionMmYr": vr, "massTransferMmYr": vm,
        "combinedMmYr": combined,
        "scaleFactor": fs, "phFactor": fp,
        "uninhibitedMmYr": uninhib,
        "rateMmYr": rate,
        "reynolds": re, "tauPa": tau,
    }


def main():
    out = {"cases": [
        case(60, 50, 0.03, 3.0, 0.15, 4.5, 900.0, 1e-3, 0, 100),
        case(80, 100, 0.02, 5.0, 0.25, 5.0, 850.0, 8e-4, 90, 95),
        case(40, 20, 0.05, 1.5, 0.10, 4.0, 950.0, 2e-3, 0, 100),
        case(120, 200, 0.01, 8.0, 0.30, 5.5, 800.0, 5e-4, 95, 80),
        case(25, 10, 0.10, 0.5, 0.05, 3.8, 1000.0, 1e-3, 0, 100),
    ]}

    # A dedicated set for the inhibitor arithmetic, which is the point
    # people get wrong.
    out["inhibitor"] = []
    for eff, avail in [(95, 100), (95, 80), (95, 50), (99, 90), (70, 100)]:
        out["inhibitor"].append({
            "uninhibitedMmYr": 2.0,
            "inhibitorEfficiencyPct": eff,
            "inhibitorAvailabilityPct": avail,
            "rateMmYr": inhibitor_duty_cycle(2.0, eff, avail),
        })

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "corrosion_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
