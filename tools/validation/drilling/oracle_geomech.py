#!/usr/bin/env python3
"""Independent oracle for the geomechanics engine (Drilling D5): horizontal
stresses, UCS correlations, full-tensor Kirsch stability and mud windows
along the D1 golden trajectories. Emits
test-data/drilling/goldens/geomech_cases.json.

Independence discipline: rotation matrices are assembled with numpy from the
frame definitions, wall stresses and Mohr-Coulomb/tensile bisections are
implemented independently from the published forms (Peska & Zoback), and a
single-depth VERTICAL closed-form fixture is asserted before writing:
  collapse  Pw = (3·SHmax − Shmin − UCS + (q−1)·Pp) / (1+q)
  frac init Pw = 3·Shmin − SHmax − Pp + T0        (alpha = 1)

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_geomech.py
"""
import math

import numpy as np

from oracle_torquedrag import WELLS, rnd, write  # noqa: F401
from oracle_hydraulics import tvd_of  # noqa: F401
from oracle_cementing import inc_at  # noqa: F401

G = 9.80665
DEG = math.pi / 180.0


# ---------------------------------------------------------------- stresses

def q_ratio(phi_deg):
    s = math.sin(phi_deg * DEG)
    return (1 + s) / (1 - s)


def horizontal_stresses(sv, pp, nu, alpha, e_pa, eps_x, eps_y, phi_deg, regime):
    k0 = nu / (1 - nu)
    q = q_ratio(phi_deg)
    smin_strain = e_pa / (1 - nu * nu) * (eps_x + nu * eps_y) if e_pa else 0.0
    smax_strain = e_pa / (1 - nu * nu) * (eps_y + nu * eps_x) if e_pa else 0.0
    shmin, shmax, clamped = [], [], 0
    for s, p in zip(sv, pp):
        sev = s - alpha * p
        a = k0 * sev + alpha * p + smin_strain
        b = k0 * sev + alpha * p + smax_strain
        lo_v, hi_v = min(a, b), max(a, b)
        lower = sev / q + alpha * p
        upper = sev * q + alpha * p
        c_lo = min(max(lo_v, lower), upper)
        c_hi = min(max(hi_v, lower), upper)
        if c_lo != lo_v or c_hi != hi_v:
            clamped += 1
        lo_v, hi_v = c_lo, max(c_hi, c_lo)
        if regime == 'TF' and lo_v < s:
            lo_v = s
        if regime == 'SS' and hi_v < s:
            hi_v = s
        hi_v = max(hi_v, lo_v)
        shmin.append(lo_v)
        shmax.append(hi_v)
    return shmin, shmax, clamped


def ucs_horsrud(dt_us_per_m):
    out = []
    for dt in dt_us_per_m:
        vp_kms = 1e6 / dt / 1000.0
        out.append(0.77 * vp_kms ** 3.2 * 1e6)
    return out


# ---------------------------------------------------------------- stability

def borehole_frame(inc_deg, azi_deg):
    i, a = inc_deg * DEG, azi_deg * DEG
    zb = np.array([math.sin(i) * math.cos(a), math.sin(i) * math.sin(a), math.cos(i)])
    if inc_deg < 1e-9:
        xb = np.array([math.cos(a), math.sin(a), 0.0])
    else:
        xb = np.array([math.cos(i) * math.cos(a), math.cos(i) * math.sin(a), -math.sin(i)])
    yb = np.cross(zb, xb)
    return np.vstack([xb, yb, zb])


def far_field_b(sv, shmax, shmin, pp, alpha, shmax_azi, inc, azi):
    g = shmax_azi * DEG
    axes = np.array([
        [math.cos(g), math.sin(g), 0.0],
        [-math.sin(g), math.cos(g), 0.0],
        [0.0, 0.0, 1.0],
    ])
    mags = np.array([shmax - alpha * pp, shmin - alpha * pp, sv - alpha * pp])
    s_g = sum(m * np.outer(ax, ax) for m, ax in zip(mags, axes))
    R = borehole_frame(inc, azi)
    return R @ s_g @ R.T


def wall_principals(sB, nu, theta_deg, dP):
    t2 = 2 * theta_deg * DEG
    th = theta_deg * DEG
    s11, s22, s33 = sB[0, 0], sB[1, 1], sB[2, 2]
    s12, s13, s23 = sB[0, 1], sB[0, 2], sB[1, 2]
    sthth = s11 + s22 - 2 * (s11 - s22) * math.cos(t2) - 4 * s12 * math.sin(t2) - dP
    szz = s33 - nu * (2 * (s11 - s22) * math.cos(t2) + 4 * s12 * math.sin(t2))
    tthz = 2 * (s23 * math.cos(th) - s13 * math.sin(th))
    mean = (sthth + szz) / 2
    half = math.hypot((sthth - szz) / 2, tthz)
    return mean + half, mean - half, dP


def stability(sv, shmax, shmin, pp, ucs, shmax_azi, inc, azi, phi_deg, nu, t0, alpha):
    q = q_ratio(phi_deg)
    sB = far_field_b(sv, shmax, shmin, pp, alpha, shmax_azi, inc, azi)
    thetas = list(range(0, 180, 1))

    def mc_worst(pw):
        dP = pw - pp
        worst, worst_t = -1e30, 0
        for t in thetas:
            a, b, c = wall_principals(sB, nu, t, dP)
            p = sorted([a, b, c], reverse=True)
            m = p[0] - q * p[2] - ucs
            if m > worst:
                worst, worst_t = m, t
        return worst, worst_t

    def min_wall(pw):
        # Hoop-tension criterion only (tangential-plane minimum).
        dP = pw - pp
        mn = 1e30
        for t in thetas:
            a, b, c = wall_principals(sB, nu, t, dP)
            mn = min(mn, b)
        return mn

    pw_max = 2 * max(sv, shmax) + 10e6
    w0, t0w = mc_worst(0.0)
    if w0 <= 0:
        collapse, brk = 0.0, t0w
    else:
        N = 400
        k = -1
        for i in range(1, N + 1):
            if mc_worst(i / N * pw_max)[0] <= 0:
                k = i
                break
        if k < 0:
            collapse, brk = pw_max, t0w
        else:
            lo, hi = (k - 1) / N * pw_max, k / N * pw_max
            for _ in range(60):
                mid = (lo + hi) / 2
                if mc_worst(mid)[0] > 0:
                    lo = mid
                else:
                    hi = mid
            collapse = hi
            brk = mc_worst(max(0.0, collapse - 1))[1]
    if min_wall(0.0) < -t0:
        frac = 0.0
    elif min_wall(pw_max) >= -t0:
        frac = pw_max
    else:
        lo, hi = 0.0, pw_max
        for _ in range(80):
            mid = (lo + hi) / 2
            if min_wall(mid) >= -t0:
                lo = mid
            else:
                hi = mid
        frac = lo
    return collapse, frac, brk


# ---------------------------------------------------------------- fixture

def vertical_fixture():
    sv, shmax, shmin, pp = 55e6, 60e6, 45e6, 20e6
    ucs, phi, nu, t0 = 40e6, 30.0, 0.25, 0.0
    q = q_ratio(phi)
    collapse, frac, brk = stability(sv, shmax, shmin, pp, ucs, 0.0, 0.0, 0.0, phi, nu, t0, 1.0)
    closed_collapse = (3 * shmax - shmin - ucs + (q - 1) * pp) / (1 + q)
    closed_frac = 3 * shmin - shmax - pp + t0
    assert abs(collapse - closed_collapse) < 200.0, (collapse, closed_collapse)
    assert abs(frac - closed_frac) < 200.0, (frac, closed_frac)
    # Breakout at the Shmin direction: theta = 90 from the SHmax-aligned x axis.
    assert abs(brk - 90) <= 1
    return {
        'inputs': {'svPa': sv, 'shmaxPa': shmax, 'shminPa': shmin, 'ppPa': pp,
                   'ucsPa': ucs, 'frictionAngleDeg': phi, 'nu': nu,
                   'tensileStrengthPa': t0, 'shmaxAzimuthDeg': 0.0,
                   'incDeg': 0.0, 'aziDeg': 0.0, 'alphaBiot': 1.0},
        'expected': {'collapsePa': collapse, 'fracInitPa': frac,
                     'closedFormCollapsePa': closed_collapse,
                     'closedFormFracPa': closed_frac,
                     'breakoutThetaDeg': brk},
    }


# ---------------------------------------------------------------- cases

def make_profile():
    tvd = [50.0 * i for i in range(1, 53)]  # 50..2600 m
    sv = [2300.0 * G * z for z in tvd]
    pp = []
    for z in tvd:
        if z <= 1500.0:
            pp.append(1030.0 * G * z)
        else:
            pp.append(1030.0 * G * 1500.0 + 1400.0 * G * (z - 1500.0))
    dt = [max(150.0, 500.0 - 0.12 * z) for z in tvd]
    return tvd, sv, pp, dt


PARAMS = {'nu': 0.28, 'alphaBiot': 1.0, 'ePa': 25e9, 'epsX': 1e-4, 'epsY': 3e-4,
          'frictionAngleDeg': 32.0, 'regime': 'NF', 'shmaxAzimuthDeg': 60.0,
          'tensileStrengthPa': 1e6}


def main():
    fixture = vertical_fixture()
    tvd, sv, pp, dt = make_profile()
    shmin, shmax, clamped = horizontal_stresses(
        sv, pp, PARAMS['nu'], PARAMS['alphaBiot'], PARAMS['ePa'],
        PARAMS['epsX'], PARAMS['epsY'], PARAMS['frictionAngleDeg'], PARAMS['regime'])
    ucs = ucs_horsrud(dt)
    cases = []
    for wname in ['slant', 'horizontal']:
        stations, shoe, td = WELLS[wname]
        azi = {'slant': 45.0, 'horizontal': 270.0}[wname]
        rows = []
        md = 30.0
        while md <= td + 1e-9:
            inc = inc_at(stations, min(md, td))
            z = tvd_of(stations, min(md, td))
            if z < tvd[0]:
                md += 30.0
                continue
            at = {k: float(np.interp(z, tvd, arr)) for k, arr in
                  [('sv', sv), ('shmax', shmax), ('shmin', shmin), ('pp', pp), ('ucs', ucs)]}
            collapse, frac, brk = stability(
                at['sv'], at['shmax'], at['shmin'], at['pp'], at['ucs'],
                PARAMS['shmaxAzimuthDeg'], inc, azi, PARAMS['frictionAngleDeg'],
                PARAMS['nu'], PARAMS['tensileStrengthPa'], PARAMS['alphaBiot'])
            denom = G * z
            rows.append({'md': md, 'tvd': z, 'incDeg': inc,
                         'ppEmwKgM3': at['pp'] / denom,
                         'collapseEmwKgM3': collapse / denom,
                         'fracInitEmwKgM3': frac / denom,
                         'breakoutThetaDeg': brk})
            md += 30.0
        widths = [(r['fracInitEmwKgM3'] - max(r['ppEmwKgM3'], r['collapseEmwKgM3']), r['md'])
                  for r in rows]
        tightest = min(widths)
        cases.append({
            'well': wname,
            'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
            'expected': {
                'checkpoints': rows[::8],
                'nRows': len(rows),
                'tightestWidthKgM3': tightest[0],
                'tightestMd': tightest[1],
            },
        })
    write('geomech_cases.json', {
        'description': 'Geomech oracle: independent numpy rotation/Kirsch/'
                       'Mohr-Coulomb bisections, poroelastic horizontal '
                       'stresses with frictional bounds, Horsrud UCS. JS '
                       'engine must agree rtol 1e-6 (same theta grid and '
                       'bisection spec). verticalFixture closed forms are '
                       'self-asserted.',
        'verticalFixture': fixture,
        'profile': {'tvdM': tvd, 'svPa': sv, 'ppPa': pp, 'dtUsPerM': dt,
                    'shminPa': shmin, 'shmaxPa': shmax, 'ucsPa': ucs,
                    'clampedCount': clamped},
        'params': PARAMS,
        'cases': cases,
    })


if __name__ == '__main__':
    main()
