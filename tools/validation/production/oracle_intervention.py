#!/usr/bin/env python3
"""
Independent oracle for the intervention diagnostics (Production P12).

DIFFERENT ROUTES, ON PURPOSE.

The log-log slope: the engine fits it by ORDINARY LEAST SQUARES -- sums
of squares, a mean, a covariance. This oracle uses THEIL-SEN, the
median of every pairwise slope. No means, no squares, no covariance,
and it is robust where least squares is not. On an exact power law both
must return the exponent exactly, and they do it by computations that
have nothing in common.

The skin/productivity ratio: the engine takes a ratio of two
dimensionless groups. This oracle builds the whole Darcy radial-flow
rate in SI -- permeability in square metres, viscosity in pascal
seconds, pressures in pascals -- computes an actual flow rate for each
skin, and divides those. A longer route through real units that has to
land on the same dimensionless number.

The Chan cases are synthesised with derivatives computed ANALYTICALLY
from the closed forms, which isolates the classifier from any
derivative implementation at all: if the classification is wrong here,
it is the classification that is wrong.

Stdlib only. Emits goldens to
test-data/production/goldens/intervention_cases.json.
"""

import json
import math
import os
from statistics import median


# ---------------------------------------------------------------------------
# Theil-Sen slope: no least squares anywhere
# ---------------------------------------------------------------------------

def theil_sen_loglog(points):
    """Median of all pairwise slopes of ln y against ln x."""
    pts = [(math.log(x), math.log(y)) for x, y in points if x > 0 and y > 0]
    slopes = []
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            dx = pts[j][0] - pts[i][0]
            if abs(dx) > 1e-15:
                slopes.append((pts[j][1] - pts[i][1]) / dx)
    if not slopes:
        return None
    m = median(slopes)
    # Intercept as the median of y - m x, which is the Theil-Sen companion.
    b = median(y - m * x for x, y in pts)
    return {'slope': m, 'intercept': b, 'n': len(pts)}


# ---------------------------------------------------------------------------
# Skin and productivity, the long way round through SI
# ---------------------------------------------------------------------------

MD_TO_M2 = 9.869233e-16
FT_TO_M = 0.3048
PSI_TO_PA = 6894.757
CP_TO_PAS = 1e-3


def darcy_rate_si(k_md, h_ft, dp_psi, mu_cp, bo, re_ft, rw_ft, skin):
    """
    Pseudo-steady-state radial oil rate, in cubic metres per second,
    built from scratch in SI:

        q = 2 pi k h dp / (mu B (ln(re/rw) - 3/4 + S))
    """
    k = k_md * MD_TO_M2
    h = h_ft * FT_TO_M
    dp = dp_psi * PSI_TO_PA
    mu = mu_cp * CP_TO_PAS
    denom = math.log(re_ft / rw_ft) - 0.75 + skin
    if denom <= 0:
        return None
    return (2.0 * math.pi * k * h * dp) / (mu * bo * denom)


def pi_multiplier_si(re_ft, rw_ft, skin_before, skin_after):
    """The uplift, as a ratio of two real flow rates rather than of two groups."""
    args = dict(k_md=45.0, h_ft=62.0, dp_psi=400.0, mu_cp=1.4, bo=1.23,
                re_ft=re_ft, rw_ft=rw_ft)
    q_before = darcy_rate_si(skin=skin_before, **args)
    q_after = darcy_rate_si(skin=skin_after, **args)
    if q_before is None or q_after is None:
        return None
    return q_after / q_before


# ---------------------------------------------------------------------------
# Synthetic water histories with ANALYTIC derivatives
# ---------------------------------------------------------------------------

def channelling_history(n=40, t0=10.0, t1=3000.0, a=0.02, m=1.6):
    """
    WOR = a t^m with m > 1.

    d(WOR)/d(ln t) = m a t^m, which is itself a power law in t with the
    SAME exponent m. So the derivative climbs on log-log with slope m,
    and m > 0 is the channelling signature. Both the ratio and its
    derivative are exact here; nothing is differenced.
    """
    out = []
    for i in range(n):
        t = t0 * (t1 / t0) ** (i / (n - 1))
        wor = a * t ** m
        out.append({'t': t, 'ratio': wor, 'derivative': m * wor})
    return out, {'form': 'a t^m', 'a': a, 'm': m, 'expectedDerivativeSlope': m}


def coning_history(n=40, t0=10.0, t1=3000.0, plateau=4.0, tau=200.0):
    """
    WOR = plateau * t / (t + tau): a ratio that rises and then flattens,
    which is what a cone does once it has reached the perforations.

    d(WOR)/d(ln t) = t dWOR/dt = plateau * tau * t / (t + tau)^2.

    At large t that goes as 1/t, so on log-log the derivative FALLS with
    a slope approaching -1. A falling derivative is the coning
    signature.
    """
    out = []
    for i in range(n):
        t = t0 * (t1 / t0) ** (i / (n - 1))
        wor = plateau * t / (t + tau)
        der = plateau * tau * t / (t + tau) ** 2
        out.append({'t': t, 'ratio': wor, 'derivative': der})
    return out, {'form': 'plateau t/(t+tau)', 'plateau': plateau, 'tau': tau,
                 'expectedDerivativeSlopeSign': -1}


def displacement_history(n=40, t0=10.0, t1=3000.0, a=0.05, m=1.0):
    """
    WOR = a t, so d(WOR)/d(ln t) = a t: the derivative rises with slope
    exactly 1 in log-log, in step with the ratio itself. That is the
    steady arrival of ordinary displacement rather than an accelerating
    one.

    NOTE this is the case that shows the classifier is a SCREENING and
    not an oracle: a slope of 1 is read as channelling by any
    threshold below 1, and separating "steadily" from "accelerating"
    genuinely needs the plot and a person. It is included precisely so
    the limitation is on the record rather than discovered later.
    """
    out = []
    for i in range(n):
        t = t0 * (t1 / t0) ** (i / (n - 1))
        wor = a * t ** m
        out.append({'t': t, 'ratio': wor, 'derivative': m * wor})
    return out, {'form': 'a t', 'a': a, 'm': m, 'expectedDerivativeSlope': m}


def flat_history(n=40, t0=10.0, t1=3000.0, level=1.2):
    """
    A ratio that is not moving at all: WOR constant, derivative zero.
    The derivative cannot be read on log-log, and the honest answer is
    that nothing is happening rather than a mechanism.
    """
    return ([{'t': t0 * (t1 / t0) ** (i / (n - 1)), 'ratio': level, 'derivative': 0.0}
             for i in range(n)],
            {'form': 'constant', 'level': level})


def main():
    cases = {}

    # --- the slope estimator, by Theil-Sen ---
    power_law = [(x, 3.7 * x ** 1.35)
                 for x in (1, 2, 3, 5, 8, 10, 20, 35, 50, 80, 100)]
    ts = theil_sen_loglog(power_law)
    cases['power_law'] = {
        'points': [{'x': x, 'y': y} for x, y in power_law],
        'theilSen': ts,
        'trueSlope': 1.35,
        'trueIntercept': math.log(3.7),
    }
    print(f"Theil-Sen slope {ts['slope']:.15f} against a true 1.35")
    print(f"Theil-Sen a     {math.exp(ts['intercept']):.12f} against a true 3.7")

    # --- skin uplift, the long way through SI ---
    skin_cases = []
    for (rb, ra) in ((8.0, 0.0), (5.0, -2.0), (2.0, 0.0), (0.0, 0.0), (12.0, -3.0)):
        mult = pi_multiplier_si(2000.0, 0.35, rb, ra)
        skin_cases.append({'reFt': 2000.0, 'rwFt': 0.35,
                           'skinBefore': rb, 'skinAfter': ra,
                           'multiplier': mult})
        print(f"  skin {rb:5.1f} -> {ra:5.1f}   PI x {mult:.12f}")
    cases['skin'] = skin_cases
    cases['minimumSkin'] = {'reFt': 2000.0, 'rwFt': 0.35,
                            'value': -(math.log(2000.0 / 0.35) - 0.75)}
    print(f"  the geometry's floor is a skin of "
          f"{cases['minimumSkin']['value']:.6f}, where the PI goes infinite")

    # --- Chan histories with analytic derivatives ---
    histories = {}
    for name, builder in (('channelling', channelling_history),
                          ('coning', coning_history),
                          ('displacement', displacement_history),
                          ('flat', flat_history)):
        series, meta = builder()
        late = series[len(series) // 2:]
        der = [(p['t'], p['derivative']) for p in late if p['derivative'] > 0]
        slope = theil_sen_loglog(der)['slope'] if len(der) > 2 else None
        histories[name] = {'series': series, 'meta': meta,
                           'lateDerivativeSlope': slope}
        shown = f'{slope:+.4f}' if slope is not None else 'not readable'
        print(f"  {name:14s} late derivative slope {shown}")
    cases['histories'] = histories

    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens',
        'intervention_cases.json'))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as fh:
        json.dump(cases, fh, indent=1, sort_keys=True)
    print(f'\nwrote {out}')


if __name__ == '__main__':
    main()
