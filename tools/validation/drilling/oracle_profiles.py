#!/usr/bin/env python3
"""Profile-design oracle (Well Design Studio WD2).

Constructs S-profile and curve-hold-curve geometries FORWARD from
chosen parameters using independent numpy circle geometry, and commits
the resulting end points as goldens. The JS solvers must recover the
construction parameters from the end points (inverse problem), so
agreement proves the closed forms, not the implementation.

Deterministic; regenerate with
  tools/validation/drilling/.venv/bin/python \
      tools/validation/drilling/oracle_profiles.py
"""
import json
import math
import os

import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                   'test-data', 'drilling', 'goldens')
DEG = math.pi / 180.0


def tangent(inc_deg, azi_deg):
    i, a = inc_deg * DEG, azi_deg * DEG
    return np.array([math.sin(i) * math.sin(a),
                     math.sin(i) * math.cos(a),
                     math.cos(i)])  # (e, n, v)


def rnd(x, nd=9):
    if isinstance(x, dict):
        return {k: rnd(v, nd) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [rnd(v, nd) for v in x]
    if isinstance(x, float):
        return round(x, nd)
    return x


def write(name, obj):
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name)
    with open(p, 'w') as f:
        json.dump(rnd(obj), f, indent=1, sort_keys=True)
        f.write('\n')
    print('wrote', p)


def sprofile_cases():
    """Forward construction: vertical, build to theta (R1), hold L,
    drop to theta_f (R2). End point = end of drop."""
    cases = []
    for md_unit, interval, kop, rate1, rate2, theta_deg, theta_f, hold, azi in [
            ('m', 30.0, 400.0, 2.5, 2.0, 48.0, 0.0, 700.0, 140.0),
            ('m', 30.0, 600.0, 3.0, 1.5, 62.0, 15.0, 450.0, 20.0),
            ('ft', 100.0, 1500.0, 2.0, 2.5, 40.0, 5.0, 2000.0, 250.0)]:
        R1 = interval / (rate1 * DEG)
        R2 = interval / (rate2 * DEG)
        th = theta_deg * DEG
        tf = theta_f * DEG
        H = R1 * (1.0 - math.cos(th)) + hold * math.sin(th) \
            + R2 * (math.cos(tf) - math.cos(th))
        V = kop + R1 * math.sin(th) + hold * math.cos(th) \
            + R2 * (math.sin(th) - math.sin(tf))
        cases.append({
            'mdUnit': md_unit, 'kopLen': kop, 'buildRate': rate1,
            'dropRate': rate2, 'finalIncDeg': theta_f, 'aziDeg': azi,
            'target': {'dN': H * math.cos(azi * DEG),
                       'dE': H * math.sin(azi * DEG), 'dTvd': V},
            'expected': {'holdIncDeg': theta_deg, 'holdLen': hold,
                         'buildLen': R1 * th, 'dropLen': R2 * (th - tf)},
        })
    write('sprofile_cases.json', {'cases': cases})


def chc_cases():
    """Forward construction: arc1 (t1 -> u, radius r1), hold L, arc2
    (u -> t4, radius r2), via the minimum-curvature kite identity
    chord = R tan(beta/2) (t_start + t_end)."""
    cases = []
    specs = [
        # (t1 inc/azi), (hold inc/azi), (land inc/azi), rate1, rate2, hold, unit
        ((0.0, 0.0), (35.0, 60.0), (90.0, 75.0), 2.5, 3.5, 900.0, 'm'),
        ((20.0, 300.0), (55.0, 320.0), (90.0, 310.0), 3.0, 4.0, 500.0, 'm'),
        ((10.0, 120.0), (48.0, 100.0), (88.0, 95.0), 2.0, 3.0, 2500.0, 'ft'),
    ]
    for (i1, a1), (iu, au), (i4, a4), rate1, rate2, hold, md_unit in specs:
        interval = 100.0 if md_unit == 'ft' else 30.0
        r1 = interval / (rate1 * DEG)
        r2 = interval / (rate2 * DEG)
        t1, u, t4 = tangent(i1, a1), tangent(iu, au), tangent(i4, a4)
        b1 = math.acos(max(-1.0, min(1.0, float(np.dot(t1, u)))))
        b2 = math.acos(max(-1.0, min(1.0, float(np.dot(u, t4)))))
        P2 = r1 * math.tan(b1 / 2.0) * (t1 + u)
        P3 = P2 + hold * u
        P4 = P3 + r2 * math.tan(b2 / 2.0) * (u + t4)
        cases.append({
            'mdUnit': md_unit, 'rate1': rate1, 'rate2': rate2,
            'tieOn': {'inc': i1, 'azi': a1},
            'landing': {'dE': float(P4[0]), 'dN': float(P4[1]),
                        'dTvd': float(P4[2]), 'incDeg': i4, 'aziDeg': a4},
            'expected': {'arc1Len': r1 * b1, 'holdLen': hold,
                         'arc2Len': r2 * b2, 'holdInc': iu, 'holdAzi': au,
                         'arc1DoglegDeg': b1 / DEG, 'arc2DoglegDeg': b2 / DEG},
        })
    write('chc_cases.json', {'cases': cases})


if __name__ == '__main__':
    sprofile_cases()
    chc_cases()
