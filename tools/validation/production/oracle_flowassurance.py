#!/usr/bin/env python3
"""Independent oracle for the flow-assurance engines (Production P10):
flowline thermal resistances and profiles, cooldown, and hydrate
inhibitor depression.

Emits committed goldens to test-data/production/goldens/flowassurance_cases.json.

Independence discipline: written from the METHOD SPEC the JS documents,
not transcribed from it.

  * thermal. The engine works in field units throughout -- Btu, hours,
    feet, degF. The oracle works in SI -- watts, seconds, metres,
    kelvin -- and converts only at the boundary. Every resistance, the
    relaxation length and the cooldown time therefore cross a unit
    system before they can be compared.
  * the inhibitor constants. This is the sharpest check available on
    them. Hammerschmidt's constant is 1297 when the depression is in
    degC and 2335 when it is in degF; Nielsen-Bucklin's is 72 degC and
    129.6 degF. The oracle computes both relations in CELSIUS with the
    metric constants and converts the answer, so the field constants
    the engine carries have to fall out of the metric ones or the two
    disagree.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_flowassurance.py
"""
import json
import math
import os

# --- conversions, applied only at the boundary ---
M_PER_FT = 0.3048
M_PER_IN = 0.0254
# 1 Btu/(hr ft degF) = 1.730735 W/(m K)
W_MK_PER_BTU_HRFTF = 1.7307346
# 1 Btu/(hr ft2 degF) = 5.678263 W/(m2 K)
W_M2K_PER_BTU_HRFT2F = 5.6782633
# 1 Btu/(lb degF) = 4186.8 J/(kg K)
J_KGK_PER_BTU_LBF = 4186.8
KG_PER_LB = 0.45359237
SEC_PER_HR = 3600.0
DEGF_PER_DEGC = 1.8

# --- metric inhibitor constants, the whole point of this oracle ---
HAMMERSCHMIDT_K_C = 1297.0
NIELSEN_BUCKLIN_C = 72.0
MW_WATER = 18.015


def layer_resistance_si(id_in, od_in, k_btu):
    """R = ln(Do/Di) / (2 pi k), per metre, in SI."""
    k_si = k_btu * W_MK_PER_BTU_HRFTF
    return math.log(od_in / id_in) / (2.0 * math.pi * k_si)


def burial_resistance_si(od_in, burial_ft, k_soil_btu):
    d_m = od_in * M_PER_IN
    h_m = burial_ft * M_PER_FT
    k_si = k_soil_btu * W_MK_PER_BTU_HRFTF
    ratio = 2.0 * h_m / d_m
    if ratio < 1.0:
        return float('nan')
    return math.acosh(ratio) / (2.0 * math.pi * k_si)


def film_resistance_si(h_btu, d_in):
    h_si = h_btu * W_M2K_PER_BTU_HRFT2F
    return 1.0 / (h_si * math.pi * d_in * M_PER_IN)


def overall_u_btu(layers, inside_h, outside_h, burial_ft, k_soil, ref_id_in):
    """Series resistances in SI, converted back to a field U."""
    parts = []
    if inside_h:
        parts.append(film_resistance_si(inside_h, layers[0]['idIn']))
    for lyr in layers:
        parts.append(layer_resistance_si(lyr['idIn'], lyr['odIn'], lyr['k']))
    outer = layers[-1]['odIn']
    if burial_ft and k_soil:
        parts.append(burial_resistance_si(outer, burial_ft, k_soil))
    if outside_h:
        parts.append(film_resistance_si(outside_h, outer))
    total_si = sum(parts)                     # K m / W
    ref_area_si = math.pi * ref_id_in * M_PER_IN   # m2 per m
    u_si = 1.0 / (total_si * ref_area_si)     # W/(m2 K)
    return u_si / W_M2K_PER_BTU_HRFT2F, [p for p in parts], total_si


def relaxation_length_ft(mass_lb_hr, cp_btu, u_btu, id_in):
    """Lc = m_dot Cp / (U pi D), in SI, back to feet."""
    m_kg_s = mass_lb_hr * KG_PER_LB / SEC_PER_HR
    cp_si = cp_btu * J_KGK_PER_BTU_LBF
    u_si = u_btu * W_M2K_PER_BTU_HRFT2F
    d_m = id_in * M_PER_IN
    lc_m = m_kg_s * cp_si / (u_si * math.pi * d_m)
    return lc_m / M_PER_FT


def cooldown_hours(mcp_btu_ft_f, u_btu, id_in, t0_f, t_amb_f, t_target_f):
    """t = (M Cp) / (U A) ln(...), computed in SI seconds."""
    mcp_si = mcp_btu_ft_f * J_KGK_PER_BTU_LBF * KG_PER_LB / M_PER_FT  # J/(K m)
    u_si = u_btu * W_M2K_PER_BTU_HRFT2F
    ua_si = u_si * math.pi * id_in * M_PER_IN                          # W/(K m)
    tau_s = mcp_si / ua_si
    # A temperature DIFFERENCE in degF is 1/1.8 of the same in K, and
    # the ratio of two differences is unitless, so the log is the same.
    seconds = tau_s * math.log((t0_f - t_amb_f) / (t_target_f - t_amb_f))
    return seconds / SEC_PER_HR, tau_s / SEC_PER_HR


def hammerschmidt_f(weight_pct, mw):
    """Computed in CELSIUS with the metric constant, then converted."""
    dt_c = HAMMERSCHMIDT_K_C * weight_pct / (mw * (100.0 - weight_pct))
    return dt_c * DEGF_PER_DEGC


def nielsen_bucklin_f(weight_pct, mw):
    """Also in CELSIUS with the metric constant."""
    n_inhib = weight_pct / mw
    n_water = (100.0 - weight_pct) / MW_WATER
    x_inhib = n_inhib / (n_inhib + n_water)
    dt_c = -NIELSEN_BUCKLIN_C * math.log(1.0 - x_inhib)
    return dt_c * DEGF_PER_DEGC


def weight_pct_for_depression_hammerschmidt(depression_f, mw, k=2335.0):
    return 100.0 * depression_f * mw / (k + depression_f * mw)


def weight_pct_for_depression_nielsen_bucklin(depression_f, mw):
    """The inverse of the Nielsen-Bucklin relation, found by BISECTION on
    the forward relation rather than by algebra.

    The engine inverts it in closed form. Bisecting the forward function
    is a different route to the same root, so agreement is evidence
    rather than the same expression written twice.
    """
    lo, hi = 1e-12, 99.999999
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if nielsen_bucklin_f(mid, mw) < depression_f:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-12:
            break
    return 0.5 * (lo + hi)


def profile_with_jt_rk4(t_in_f, t_amb_f, lc_ft, length_ft, jt_f_per_psi, dp_psi,
                        steps=200000):
    """Arrival temperature with Joule-Thomson cooling, by RK4 on

        dT/dx = -(T - Ta)/Lc - jt (dp/L)

    The engine solves the same equation in closed form and reports the
    damping factor (1 - exp(-NTU))/NTU that falls out of it. Integrating
    it numerically is the independent route: if the engine had kept the
    undamped linear term this march would disagree with it by half the
    JT drop on a line of this length.
    """
    grad = jt_f_per_psi * dp_psi / length_ft
    h = length_ft / steps
    t = t_in_f

    def f(temp):
        return -(temp - t_amb_f) / lc_ft - grad

    for _ in range(steps):
        k1 = f(t)
        k2 = f(t + h * k1 / 2.0)
        k3 = f(t + h * k2 / 2.0)
        k4 = f(t + h * k3)
        t += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6.0
    return t


def main():
    cases = {}

    layers = [
        {'idIn': 6.065, 'odIn': 6.625, 'k': 26},
        {'idIn': 6.625, 'odIn': 8.625, 'k': 0.09},
    ]
    u_ins, parts_ins, total_ins = overall_u_btu(layers, 250, 200, 0, 0, 6.065)
    u_bare, _, _ = overall_u_btu(layers[:1], 250, 200, 0, 0, 6.065)
    u_buried, _, _ = overall_u_btu(layers, 250, 200, 4.0, 1.2, 6.065)
    cases['overallU'] = {
        'layers': layers,
        'insulated': u_ins,
        'bare': u_bare,
        'buried4ft': u_buried,
        'totalResistanceSI': total_ins,
    }
    # A pipe lying on the bottom: H = D/2, acosh(1) = 0, the ground adds
    # nothing. The right answer, and a check the shape factor is right.
    cases['burialAtHalfDiameter'] = burial_resistance_si(8.625, 8.625 / 24.0, 1.2)

    cases['relaxation'] = [
        {
            'massRateLbHr': m, 'cpBtuLbF': cp, 'uBtuHrFt2F': u_ins, 'idIn': 6.065,
            'lengthFt': relaxation_length_ft(m, cp, u_ins, 6.065),
        }
        for m, cp in ((60000.0, 0.5), (120000.0, 0.5), (120000.0, 0.6))
    ]

    prof = []
    lc = relaxation_length_ft(120000.0, 0.5, u_ins, 6.065)
    for length in (5280.0, 26400.0, 105600.0):
        arrival = 40.0 + (180.0 - 40.0) * math.exp(-length / lc)
        prof.append({'lengthFt': length, 'arrivalTempF': arrival, 'ntu': length / lc})
    cases['profile'] = {
        'inletTempF': 180.0, 'ambientTempF': 40.0, 'massRateLbHr': 120000.0,
        'cpBtuLbF': 0.5, 'uBtuHrFt2F': u_ins, 'idIn': 6.065,
        'relaxationLengthFt': lc, 'points': prof,
    }

    # Item 48. The same line with a Joule-Thomson term, integrated
    # rather than assumed. `undampedArrivalTempF` is what the engine
    # used to report: the whole jt x dp subtracted at the arrival end,
    # as though the line gave none of it back to ambient.
    jt_cases = []
    for length, jt, dp in ((5280.0, 0.02, 800.0), (26400.0, 0.02, 800.0),
                           (105600.0, 0.02, 800.0), (26400.0, 0.05, 1500.0)):
        ntu = length / lc
        jt_cases.append({
            'lengthFt': length, 'jtCoeffFPerPsi': jt, 'dpPsi': dp,
            'ntu': ntu,
            'dampingFactor': (1.0 - math.exp(-ntu)) / ntu,
            'arrivalTempF': profile_with_jt_rk4(180.0, 40.0, lc, length, jt, dp),
            'undampedArrivalTempF': 40.0 + 140.0 * math.exp(-ntu) - jt * dp,
        })
    cases['profileWithJt'] = {
        'inletTempF': 180.0, 'ambientTempF': 40.0, 'massRateLbHr': 120000.0,
        'cpBtuLbF': 0.5, 'uBtuHrFt2F': u_ins, 'idIn': 6.065,
        'relaxationLengthFt': lc, 'points': jt_cases,
    }

    hours, tau = cooldown_hours(
        # contents + shell, Btu/(ft degF)
        (math.pi / 4) * (6.065 / 12.0) ** 2 * 55.0 * 0.5
        + (math.pi / 4) * ((6.625 / 12.0) ** 2 - (6.065 / 12.0) ** 2) * 490.0 * 0.11,
        u_ins, 6.065, 150.0, 40.0, 70.0,
    )
    cases['cooldown'] = {'hours': hours, 'timeConstantHr': tau, 'uBtuHrFt2F': u_ins}

    inhib = []
    for name, mw in (('methanol', 32.04), ('meg', 62.07), ('deg', 106.12), ('teg', 150.17)):
        for w in (5.0, 10.0, 20.0, 30.0, 40.0, 50.0):
            inhib.append({
                'inhibitor': name, 'molecularWeight': mw, 'weightPct': w,
                'hammerschmidtF': hammerschmidt_f(w, mw),
                'nielsenBucklinF': nielsen_bucklin_f(w, mw),
            })
    cases['inhibition'] = inhib

    # Items 48, 53 and 59. The concentration a depression needs, through
    # BOTH relations. The larger is the one that delivers the depression
    # on the relation the design is judged by, and it is the number the
    # practical ceiling has to be applied to.
    required = []
    for name, mw in (('methanol', 32.04), ('meg', 62.07), ('deg', 106.12), ('teg', 150.17)):
        for need in (5.0, 10.0, 20.0, 30.0, 45.0):
            w_ham = weight_pct_for_depression_hammerschmidt(need, mw)
            w_nb = weight_pct_for_depression_nielsen_bucklin(need, mw)
            binding = max(w_ham, w_nb)
            required.append({
                'inhibitor': name, 'molecularWeight': mw, 'neededDepressionF': need,
                'weightPctByHammerschmidt': w_ham,
                'weightPctByNielsenBucklin': w_nb,
                'weightPct': binding,
                'weightPctBasis': 'nielsenBucklin' if w_nb > w_ham else 'hammerschmidt',
                # what the design is then judged on: the lower of the two
                # relations at that concentration, which is the number
                # item 59 makes the recommendation
                'recommendedFAtThatConcentration': min(
                    hammerschmidt_f(binding, mw), nielsen_bucklin_f(binding, mw)),
                # and what the old Hammerschmidt-only inversion would
                # have delivered, which is the shortfall item 53 refuses
                'recommendedFAtHammerschmidtConcentration': min(
                    hammerschmidt_f(w_ham, mw), nielsen_bucklin_f(w_ham, mw)),
            })
    cases['requiredConcentration'] = required
    cases['constants'] = {
        'hammerschmidtKfromMetric': HAMMERSCHMIDT_K_C * DEGF_PER_DEGC,
        'nielsenBucklinFfromMetric': NIELSEN_BUCKLIN_C * DEGF_PER_DEGC,
    }

    out = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                       'test-data', 'production', 'goldens', 'flowassurance_cases.json')
    with open(os.path.abspath(out), 'w') as fh:
        json.dump(cases, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', os.path.abspath(out))


if __name__ == '__main__':
    main()
