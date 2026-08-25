#!/usr/bin/env python3
"""Analytic oracle for the drilling survey engine (Well Design Studio WD0).

Emits committed goldens to test-data/drilling/goldens/ that the JS
engine (engines/drilling/) must match. Everything is deterministic
(fixed seed, no timestamps) so reruns are byte-identical.

Independence discipline: the reference math here is written from the
geometry itself (vector rotations, closed-form circles, dense-sampled
root finding), NOT ported from the JS implementation, so agreement is
meaningful.

Cases:
  arc_vertical_plane.json   build arc from vertical: minimum curvature is
                            EXACT on circular arcs; closed-form circle
                            positions at several arc angles + azimuths
  toolface_sphere.json      attitude propagation along great-circle arcs
                            with a toolface, via explicit 3D vector
                            rotation (checks the spherical-triangle form)
  tvd_crossings.json        S-well TVD-plane crossings by dense sampling
                            + bisection on an independent arc
                            interpolation
  survey_table.json         full survey listing (m and ft modes) from an
                            independent numpy minimum-curvature
                            implementation; the ft case encodes the
                            regression class of the legacy app's
                            ft/m rate bug (3 deg/100ft over 1000 ft
                            must be exactly 30 deg)
  compile_buildhold.json    closed-form build-hold geometry end points
                            in both unit systems

Regenerate:  tools/validation/drilling/.venv/bin/python \
                 tools/validation/drilling/oracle.py
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
                     math.cos(i)])  # (e, n, v-down)


def attitude(t):
    inc = math.degrees(math.acos(max(-1.0, min(1.0, t[2]))))
    h = math.hypot(t[0], t[1])
    azi = 0.0 if h < 1e-12 else math.degrees(math.atan2(t[0], t[1])) % 360.0
    return inc, azi


def min_curvature(stations, surface=(0.0, 0.0), kb=0.0):
    """Independent minimum-curvature integration (balanced tangential
    with ratio factor), written from the textbook formula."""
    out = [{'md': stations[0][0], 'x': surface[0], 'y': surface[1],
            'tvd': 0.0, 'tvdss': -kb}]
    e = n = v = 0.0
    for k in range(1, len(stations)):
        md1, i1, a1 = stations[k - 1]
        md2, i2, a2 = stations[k]
        dmd = md2 - md1
        t1, t2 = tangent(i1, a1), tangent(i2, a2)
        cosb = max(-1.0, min(1.0, float(np.dot(t1, t2))))
        beta = math.acos(cosb)
        rf = 1.0 if beta < 1e-9 else (2.0 / beta) * math.tan(beta / 2.0)
        de, dn, dv = (dmd / 2.0) * (t1 + t2) * rf
        e, n, v = e + de, n + dn, v + dv
        out.append({'md': md2, 'x': surface[0] + e, 'y': surface[1] + n,
                    'tvd': v, 'tvdss': v - kb})
    return out


def arc_interp(stations, path, md):
    """Independent exact interpolation on the containing arc: rotate the
    start tangent toward the end tangent in their common plane and
    integrate the closed-form circle."""
    k = 1
    while k < len(stations) - 1 and stations[k][0] < md:
        k += 1
    md1, i1, a1 = stations[k - 1]
    md2, i2, a2 = stations[k]
    p1 = path[k - 1]
    dmd = md2 - md1
    f = (md - md1) / dmd
    t1, t2 = tangent(i1, a1), tangent(i2, a2)
    cosb = max(-1.0, min(1.0, float(np.dot(t1, t2))))
    beta = math.acos(cosb)
    if beta < 1e-9:
        d = f * dmd * t1
    else:
        r = dmd / beta
        w = (t2 - t1 * cosb) / math.sin(beta)   # unit, perp to t1, in-plane
        th = f * beta
        d = r * (math.sin(th) * t1 + (1.0 - math.cos(th)) * w)
    return {'md': md, 'x': p1['x'] + d[0], 'y': p1['y'] + d[1],
            'tvd': p1['tvd'] + d[2]}


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


# --- 1. Vertical-plane build arcs: closed-form circle ------------------
def case_arc_vertical_plane():
    cases = []
    for azi, dls30, total_len in [(45.0, 3.0, 900.0), (200.0, 2.5, 600.0),
                                  (120.0, 6.0, 450.0)]:
        R = 30.0 / (dls30 * DEG)          # radius from deg/30m
        n_st = 10
        stations = []
        expected = []
        for k in range(n_st + 1):
            s = total_len * k / n_st       # arc length from KOP
            th = s / R
            stations.append([s, math.degrees(th), azi])
            H = R * (1.0 - math.cos(th))   # horizontal offset in the plane
            V = R * math.sin(th)
            expected.append({'md': s,
                             'e': H * math.sin(azi * DEG),
                             'n': H * math.cos(azi * DEG),
                             'tvd': V})
        cases.append({'aziDeg': azi, 'dls30m': dls30, 'radius_m': R,
                      'stations': stations, 'expected': expected})
    write('arc_vertical_plane.json', {'cases': cases})


# --- 2. Toolface arcs: explicit vector rotation ------------------------
def case_toolface_sphere():
    rng = np.random.default_rng(20260825)
    cases = []
    for _ in range(40):
        i1 = float(rng.uniform(1.0, 175.0))
        a1 = float(rng.uniform(0.0, 360.0))
        beta = float(rng.uniform(0.001, 60.0)) * DEG
        tau = float(rng.uniform(0.0, 360.0))
        t = tangent(i1, a1)
        up = np.array([0.0, 0.0, -1.0])
        h = up - float(np.dot(up, t)) * t
        h = h / np.linalg.norm(h)          # highside
        r = np.cross(h, t)                 # right lateral (checked: E for N-horizontal)
        d = math.cos(tau * DEG) * h + math.sin(tau * DEG) * r
        t2 = math.cos(beta) * t + math.sin(beta) * d   # great circle
        i2, a2 = attitude(t2)
        cases.append({'inc1': i1, 'azi1': a1, 'betaDeg': beta / DEG,
                      'toolfaceDeg': tau, 'inc2': i2, 'azi2': a2})
    # kick-off-from-vertical convention: toolface measured from north
    for tau in (0.0, 90.0, 210.0):
        beta = 12.0 * DEG
        t = np.array([0.0, 0.0, 1.0])
        h = np.array([0.0, 1.0, 0.0])      # north
        r = np.cross(h, t)                 # east
        d = math.cos(tau * DEG) * h + math.sin(tau * DEG) * r
        t2 = math.cos(beta) * t + math.sin(beta) * d
        i2, a2 = attitude(t2)
        cases.append({'inc1': 0.0, 'azi1': 0.0, 'betaDeg': 12.0,
                      'toolfaceDeg': tau, 'inc2': i2, 'azi2': a2})
    write('toolface_sphere.json', {'cases': cases})


# --- 3. S-well TVD crossings by dense sampling + bisection -------------
def s_well_stations():
    """Vertical 500 m; build 3 deg/30m to 60 deg; hold 400 m;
    drop 2 deg/30m to 15 deg; hold 200 m. Azi 120. Stations every 10 m
    of the curved sections (same station list the JS test compiles)."""
    st = [[0.0, 0.0, 120.0], [500.0, 0.0, 120.0]]
    md = 500.0
    inc = 0.0
    L1 = 60.0 / (3.0 / 30.0)
    n1 = int(L1 / 10)
    for k in range(1, n1 + 1):
        st.append([md + L1 * k / n1, (3.0 / 30.0) * (L1 * k / n1), 120.0])
    md += L1
    inc = 60.0
    md += 400.0
    st.append([md, inc, 120.0])
    L2 = (60.0 - 15.0) / (2.0 / 30.0)
    n2 = int(L2 / 10)
    for k in range(1, n2 + 1):
        st.append([md + L2 * k / n2, 60.0 - (2.0 / 30.0) * (L2 * k / n2), 120.0])
    md += L2
    md += 200.0
    st.append([md, 15.0, 120.0])
    return st


def case_tvd_crossings():
    st = s_well_stations()
    path = min_curvature(st)
    tvds = [300.0, 700.0, 1000.0, 1200.0, path[-1]['tvd'] - 1.0]
    results = []
    md_lo, md_hi = st[0][0], st[-1][0]
    grid = np.linspace(md_lo, md_hi, 200001)
    tvd_grid = np.array([arc_interp(st, path, float(m))['tvd'] for m in grid])
    for tvd in tvds:
        f = tvd_grid - tvd
        mds = []
        for k in range(len(grid) - 1):
            if f[k] == 0.0:
                mds.append(float(grid[k]))
            elif f[k] * f[k + 1] < 0:
                lo, hi = float(grid[k]), float(grid[k + 1])
                for _ in range(80):
                    mid = 0.5 * (lo + hi)
                    fm = arc_interp(st, path, mid)['tvd'] - tvd
                    if fm == 0.0:
                        lo = hi = mid
                        break
                    if (arc_interp(st, path, lo)['tvd'] - tvd) * fm < 0:
                        hi = mid
                    else:
                        lo = mid
                mds.append(0.5 * (lo + hi))
        results.append({'tvd': tvd, 'mds': mds})
    write('tvd_crossings.json', {'stations': st, 'cases': results})


# --- 4. Survey table in m and ft (the ft regression class) -------------
def survey_table(stations, md_unit, vs_azi):
    path = min_curvature(stations)
    interval = 100.0 if md_unit == 'ft' else 30.0
    rows = []
    for k, p in enumerate(path):
        md, inc, azi = stations[k]
        if k == 0:
            dls = 0.0
        else:
            t1 = tangent(*stations[k - 1][1:])
            t2 = tangent(inc, azi)
            beta = math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(t1, t2))))))
            dls = beta * interval / (md - stations[k - 1][0])
        if md_unit == 'ft':
            dls100ft, dls30m = dls, dls * 30.0 / 30.48
        else:
            dls30m, dls100ft = dls, dls * 30.48 / 30.0
        vs = p['y'] * math.cos(vs_azi * DEG) + p['x'] * math.sin(vs_azi * DEG)
        clo_d = math.hypot(p['x'], p['y'])
        clo_a = 0.0 if clo_d < 1e-12 else math.degrees(math.atan2(p['x'], p['y'])) % 360.0
        rows.append({'md': md, 'inc': inc, 'azi': azi % 360.0,
                     'tvd': p['tvd'], 'n': p['y'], 'e': p['x'],
                     'dls30m': dls30m, 'dls100ft': dls100ft, 'vs': vs,
                     'closureDist': clo_d, 'closureAzi': clo_a})
    return rows


def case_survey_table():
    # metric: KOP 400 m, build 3 deg/30m to 45 deg, hold to 2600 m MD
    m_st = [[0.0, 0.0, 200.0], [400.0, 0.0, 200.0]]
    L = 45.0 / (3.0 / 30.0)
    for k in range(1, 16):
        m_st.append([400.0 + L * k / 15.0, 3.0 * (L * k / 15.0) / 30.0, 200.0])
    m_st.append([2600.0, 45.0, 200.0])
    # feet: KOP 1000 ft, build 3 deg/100ft over 1000 ft -> EXACTLY 30 deg
    f_st = [[0.0, 0.0, 75.0], [1000.0, 0.0, 75.0]]
    for k in range(1, 11):
        f_st.append([1000.0 + 100.0 * k, 3.0 * k, 75.0])
    f_st.append([4000.0, 30.0, 75.0])
    write('survey_table.json', {
        'metric': {'stations': m_st, 'mdUnit': 'm', 'vsAzimuthDeg': 200.0,
                   'rows': survey_table(m_st, 'm', 200.0)},
        'feet': {'stations': f_st, 'mdUnit': 'ft', 'vsAzimuthDeg': 75.0,
                 'rows': survey_table(f_st, 'ft', 75.0)},
    })


# --- 5. Build-hold closed-form endpoints (both unit systems) -----------
def case_compile_buildhold():
    cases = []
    for md_unit, interval, kop, rate, target_inc, hold_len, azi in [
            ('m', 30.0, 500.0, 3.0, 40.0, 800.0, 150.0),
            ('ft', 100.0, 1000.0, 3.0, 30.0, 2000.0, 60.0)]:
        R = interval / (rate * DEG)
        build_len = target_inc / rate * interval
        th = target_inc * DEG
        H_arc = R * (1.0 - math.cos(th))
        V_arc = R * math.sin(th)
        H = H_arc + hold_len * math.sin(th)
        V = kop + V_arc + hold_len * math.cos(th)
        cases.append({'mdUnit': md_unit, 'kop': kop, 'rate': rate,
                      'targetInc': target_inc, 'holdLen': hold_len,
                      'aziDeg': azi, 'buildLen': build_len,
                      'endMd': kop + build_len + hold_len,
                      'endInc': target_inc,
                      'endTvd': V,
                      'endN': H * math.cos(azi * DEG),
                      'endE': H * math.sin(azi * DEG)})
    write('compile_buildhold.json', {'cases': cases})


if __name__ == '__main__':
    case_arc_vertical_plane()
    case_toolface_sphere()
    case_tvd_crossings()
    case_survey_table()
    case_compile_buildhold()
