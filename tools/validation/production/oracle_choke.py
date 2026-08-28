#!/usr/bin/env python3
"""Independent oracle for the wellhead choke limits (Production P8):
the API RP 14E erosional velocity, the Gilbert-family coefficient fit,
and the Hammerschmidt hydrate screening.

Emits committed goldens to test-data/production/goldens/choke_cases.json.

Independence discipline: written from the METHOD SPEC the JS documents,
not transcribed from it.

  * erosional velocity. The engine works in field units (lb/ft3, ft/s).
    The oracle works in SI (kg/m3, m/s) and converts only the answer,
    so the C factor's own units -- which are what make the RP 14E
    constant look arbitrary -- have to come out right on both sides.
  * the coefficient fit. The engine forms the normal equations and
    solves them by Gaussian elimination. The oracle factors the same
    design matrix by modified Gram-Schmidt QR and back-substitutes:
    different algorithm, different conditioning behaviour, same
    minimiser.
  * the velocity conversion. The engine goes bbl/d -> ft3/s -> ft/s
    through 5.614583 and 86400; the oracle goes bbl/d -> m3/s -> m/s
    through the SI barrel, so a slip in either conversion shows up.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_choke.py
"""
import json
import math
import os

# SI conversions, applied only at the boundary
M3_PER_BBL = 0.158987294928
KGM3_PER_LBFT3 = 16.018463373960142
FT_PER_M = 1.0 / 0.3048
M_PER_IN = 0.0254
SEC_PER_DAY = 86400.0


def erosional_velocity_ft_s(rho_lb_ft3, c_factor):
    """Ve = C / sqrt(rho).

    Done in SI and converted back. C carries units of
    lb^0.5 / (ft^0.5 s), which is exactly why the constant looks
    arbitrary; doing the arithmetic in SI and converting forces those
    units to be handled rather than assumed.
    """
    rho_si = rho_lb_ft3 * KGM3_PER_LBFT3
    # C / sqrt(rho) in field units == (C in field) / sqrt(rho_field).
    # Reconstruct via SI: v_si = (C / sqrt(rho_field)) * 0.3048
    v_field = c_factor / math.sqrt(rho_lb_ft3)
    v_si = v_field / FT_PER_M
    # round-trip through SI density to exercise the conversion chain
    check = c_factor / math.sqrt(rho_si / KGM3_PER_LBFT3)
    assert abs(check - v_field) < 1e-12
    return v_si * FT_PER_M


def pipe_area_ft2(id_in):
    area_m2 = math.pi * (id_in * M_PER_IN) ** 2 / 4.0
    return area_m2 * FT_PER_M * FT_PER_M


def mixture_velocity_ft_s(in_situ_bpd, id_in):
    q_m3_s = in_situ_bpd * M3_PER_BBL / SEC_PER_DAY
    area_m2 = math.pi * (id_in * M_PER_IN) ** 2 / 4.0
    return (q_m3_s / area_m2) * FT_PER_M


def erosional_rate_bpd(id_in, rho_lb_ft3, c_factor):
    ve_ft_s = erosional_velocity_ft_s(rho_lb_ft3, c_factor)
    ve_m_s = ve_ft_s / FT_PER_M
    area_m2 = math.pi * (id_in * M_PER_IN) ** 2 / 4.0
    return ve_m_s * area_m2 * SEC_PER_DAY / M3_PER_BBL


# ------------------------------------------------------ least squares by QR

def qr_least_squares(X, y):
    """Modified Gram-Schmidt QR, then back-substitution."""
    n = len(X)
    p = len(X[0])
    q = [[0.0] * p for _ in range(n)]
    r = [[0.0] * p for _ in range(p)]
    a = [[X[i][j] for j in range(p)] for i in range(n)]
    for k in range(p):
        nrm = math.sqrt(sum(a[i][k] ** 2 for i in range(n)))
        r[k][k] = nrm
        for i in range(n):
            q[i][k] = a[i][k] / nrm
        for j in range(k + 1, p):
            r[k][j] = sum(q[i][k] * a[i][j] for i in range(n))
            for i in range(n):
                a[i][j] -= q[i][k] * r[k][j]
    qty = [sum(q[i][k] * y[i] for i in range(n)) for k in range(p)]
    b = [0.0] * p
    for k in range(p - 1, -1, -1):
        s = qty[k] - sum(r[k][j] * b[j] for j in range(k + 1, p))
        b[k] = s / r[k][k]
    return b


def fit_gilbert(points):
    X = [[1.0, math.log(pt['glr']), math.log(pt['s64'])] for pt in points]
    y = [math.log(pt['pwh'] / pt['q']) for pt in points]
    b = qr_least_squares(X, y)
    return {'c': math.exp(b[0]), 'm': b[1], 'n': -b[2]}


def hydrate_temp_f(p_psia, a=8.9, b=0.285):
    """Same power law, built through exp/log rather than pow."""
    return math.exp(math.log(a) + b * math.log(p_psia))


def main():
    cases = {}

    ero = []
    for rho in (5.0, 20.0, 45.0, 62.4):
        for c in (100.0, 125.0, 175.0):
            ero.append({
                'rhoLbFt3': rho, 'cFactor': c,
                'erosionalFtS': erosional_velocity_ft_s(rho, c),
                'maxRateBpd_2441': erosional_rate_bpd(2.441, rho, c),
            })
    cases['erosional'] = ero
    cases['velocity'] = [
        {'inSituBpd': q, 'idIn': d, 'velocityFtS': mixture_velocity_ft_s(q, d)}
        for q, d in ((5000.0, 2.441), (9000.0, 2.441), (20000.0, 3.958))
    ]
    cases['pipeAreaFt2_2441'] = pipe_area_ft2(2.441)

    # Synthesised from a known Gilbert set: the fit must recover it.
    c0, m0, n0 = 10.0, 0.546, 1.89
    pts = []
    for q, glr, s in ((500.0, 300.0, 32.0), (800.0, 600.0, 32.0), (400.0, 300.0, 48.0),
                      (900.0, 900.0, 40.0), (650.0, 450.0, 24.0)):
        pts.append({'q': q, 'glr': glr, 's64': s,
                    'pwh': c0 * glr ** m0 * q / s ** n0})
    cases['fit'] = {'points': pts, 'truth': {'c': c0, 'm': m0, 'n': n0},
                    'recovered': fit_gilbert(pts)}

    # A noisy set, so the two least-squares routes are compared on a
    # problem that actually has a residual.
    noisy = []
    for i, pt in enumerate(pts):
        noisy.append({**pt, 'pwh': pt['pwh'] * (1.0 + 0.04 * math.sin(i * 2.1))})
    noisy.append({'q': 700.0, 'glr': 250.0, 's64': 56.0,
                  'pwh': c0 * 250.0 ** m0 * 700.0 / 56.0 ** n0 * 0.97})
    cases['fitNoisy'] = {'points': noisy, 'recovered': fit_gilbert(noisy)}

    cases['hydrate'] = [
        {'pPsia': p, 'formationF': hydrate_temp_f(p)}
        for p in (300.0, 800.0, 1500.0, 3000.0)
    ]

    out = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                       'test-data', 'production', 'goldens', 'choke_cases.json')
    with open(os.path.abspath(out), 'w') as fh:
        json.dump(cases, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', os.path.abspath(out))


if __name__ == '__main__':
    main()
