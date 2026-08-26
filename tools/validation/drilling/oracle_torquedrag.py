#!/usr/bin/env python3
"""Independent oracle for the soft-string torque & drag engine (Drilling D1).

Emits committed goldens to test-data/drilling/goldens/ that
engines/drilling/torqueDrag.js and casingWear.js must match. Everything is
deterministic (no timestamps, fixed inputs) so reruns are byte-identical.

Independence discipline: this integrates the soft-string ODE
    dT/ds = w cos(theta) + fa * mu * n(s, T)
    dM/ds = ft * mu * n(s, T) * r
    n = sqrt[(T * sin(theta) * phi')^2 + (T * theta' + w sin(theta))^2]
with classic RK4 on a 0.25 m grid, attitude from an independent vector-slerp
minimum-curvature interpolation with central-difference derivatives. The JS
engine uses a station-marching midpoint recursion; agreement (rtol 1e-4 on
summaries) is meaningful because the discretisations differ.

Model definition shared with the JS engine (spec, not implementation):
  * velocity partition fa = va/|v| (up +), ft = vt/|v|, vt = 2*pi*r_tj*rpm/60
  * buoyed weight w = w_air * (1 - rho_mud/7850) * 9.80665
  * boundary at bit: T = -WOB, M = bit torque for on-bottom modes, else 0
  * friction factor per hole section; torque radius = tool-joint radius

Cases (torquedrag_cases.json): five synthetic wells (vertical, slant,
build-hold, horizontal, 3D toolface S-well) x operations, one shared
drillstring recipe. Station lists are emitted in the golden (they are the
input contract); the 3D well's stations come from explicit Rodrigues
rotation of the tangent vector, not from the JS compiler.

casingwear_cases.json: wear volumes/depths on the horizontal well's
rotate-on-bottom side-force profile, crescent groove geometry inverted by
bisection.

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_torquedrag.py
"""
import json
import math
import os

import numpy as np

DEG = math.pi / 180.0
G = 9.80665
STEEL = 7850.0
OUT = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                   'test-data', 'drilling', 'goldens')
IN = 0.0254
LBFT = 1.4881639


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


# ---------------------------------------------------------------- geometry

def tangent(inc, azi):
    th, ph = inc * DEG, azi * DEG
    return np.array([math.sin(th) * math.cos(ph),   # N
                     math.sin(th) * math.sin(ph),   # E
                     math.cos(th)])                 # down


def attitude_of(t):
    inc = math.degrees(math.acos(max(-1.0, min(1.0, t[2]))))
    azi = math.degrees(math.atan2(t[1], t[0])) % 360.0 if abs(t[2]) < 1 - 1e-12 else 0.0
    return inc, azi


def slerp_attitude(stations, md):
    """Minimum-curvature (great-circle) attitude at md, vector slerp."""
    if md <= stations[0][0]:
        return stations[0][1], stations[0][2]
    for i in range(1, len(stations)):
        if md <= stations[i][0] + 1e-12:
            m1, i1, a1 = stations[i - 1]
            m2, i2, a2 = stations[i]
            f = (md - m1) / (m2 - m1)
            t1, t2 = tangent(i1, a1), tangent(i2, a2)
            cosb = max(-1.0, min(1.0, float(np.dot(t1, t2))))
            beta = math.acos(cosb)
            if beta < 1e-10:
                return i1, a1
            t = (math.sin((1 - f) * beta) * t1 + math.sin(f * beta) * t2) / math.sin(beta)
            return attitude_of(t / np.linalg.norm(t))
    return stations[-1][1], stations[-1][2]


def make_planar_stations(segments, azi, step=30.0):
    """Planar well from [(kind,...)] segments: ('v', length) vertical,
    ('b', rate_deg_per30, length) build/drop, ('h', length, inc) hold."""
    out = [(0.0, 0.0, azi)]
    md, inc = 0.0, 0.0
    for seg in segments:
        if seg[0] == 'v':
            end = md + seg[1]
            while md < end - 1e-9:
                md = min(md + step, end)
                out.append((md, inc, azi))
        elif seg[0] == 'b':
            rate, length = seg[1], seg[2]
            end = md + length
            while md < end - 1e-9:
                nxt = min(md + step, end)
                inc = inc + rate * (nxt - md) / 30.0
                md = nxt
                out.append((md, inc, azi))
        elif seg[0] == 'h':
            end = md + seg[1]
            inc = seg[2]
            while md < end - 1e-9:
                md = min(md + step, end)
                out.append((md, inc, azi))
    return out


def make_toolface_stations(pre_vertical, dls_per30, toolface, arc_len,
                           hold_len, step=30.0):
    """3D well: vertical, then a constant-curvature arc with fixed toolface
    (tangent rotated by Rodrigues about a fixed axis), then a hold."""
    out = [(0.0, 0.0, 0.0)]
    md = 0.0
    while md < pre_vertical - 1e-9:
        md = min(md + step, pre_vertical)
        out.append((md, 0.0, 0.0))
    # Initial tangent vertical; toolface measured from the high side is
    # degenerate at inc 0, so define the arc plane by toolface from north.
    t = np.array([0.0, 0.0, 1.0])
    tf = toolface * DEG
    u = np.array([math.cos(tf), math.sin(tf), 0.0])   # rotation moves t toward u
    axis = np.cross(t, u)
    axis /= np.linalg.norm(axis)
    kappa = dls_per30 * DEG / 30.0
    end = md + arc_len
    while md < end - 1e-9:
        nxt = min(md + step, end)
        ang = kappa * (nxt - md)
        # Rodrigues rotation of the tangent about the fixed arc axis.
        t = (t * math.cos(ang) + np.cross(axis, t) * math.sin(ang)
             + axis * float(np.dot(axis, t)) * (1 - math.cos(ang)))
        t /= np.linalg.norm(t)
        md = nxt
        inc, azi = attitude_of(t)
        out.append((md, inc, azi))
    inc, azi = attitude_of(t)
    end = md + hold_len
    while md < end - 1e-9:
        md = min(md + step, end)
        out.append((md, inc, azi))
    return out


# ---------------------------------------------------------------- physics

def component_at(string, dist_from_bit):
    acc = 0.0
    for c in string:
        acc += c['lengthM']
        if dist_from_bit < acc + 1e-9:
            return c
    return string[-1]


def section_at(geometry, md):
    for g in geometry:
        if g['fromMd'] - 1e-9 <= md <= g['toMd'] + 1e-9:
            return g
    return None


def integrate(stations, string, geometry, mud, operation, params):
    trip = params.get('tripSpeedMs', 0.3)
    rpm_p = params.get('rpm', 120.0)
    wob = params.get('wobN', 0.0)
    bit_tq = params.get('bitTorqueNm', 0.0)
    ops = {
        'trip_out': (trip, 0.0, False),
        'trip_in': (-trip, 0.0, False),
        'rotate_off_bottom': (0.0, rpm_p, False),
        'rotate_on_bottom': (0.0, rpm_p, True),
        'slide_drill': (-trip, 0.0, True),
        'backream': (trip, rpm_p, False),
    }
    va, rpm, on_bottom = ops[operation]
    bf = 1.0 - mud / STEEL
    total_len = sum(c['lengthM'] for c in string)
    bit_md = min(total_len, stations[-1][0])

    h_diff = 0.01

    def theta_psi(md):
        """theta (rad), theta' (rad/m), sin(theta)*phi' (rad/m)."""
        lo = max(stations[0][0], md - h_diff)
        hi = min(bit_md, md + h_diff)
        i0, a0 = slerp_attitude(stations, lo)
        i1, a1 = slerp_attitude(stations, hi)
        im, _ = slerp_attitude(stations, md)
        th = im * DEG
        dth = (i1 - i0) * DEG / (hi - lo)
        da = ((a1 - a0 + 180.0) % 360.0 - 180.0) * DEG / (hi - lo)
        return th, dth, math.sin(th) * da if math.sin(th) > 1e-9 else 0.0

    def rhs(md, T):
        th, dth, spsi = theta_psi(md)
        dist = bit_md - md
        comp = component_at(string, dist)
        sec = section_at(geometry, md)
        mu = sec['frictionFactor'] if sec else 0.0
        w = comp['weightKgM'] * G * bf
        # Perpendicular force balance (vector derivation): the curvature term
        # T*theta' points to the HIGH side in a build while gravity presses
        # the LOW side, so with dth measured toward increasing md the two
        # terms oppose: n = |w sin(theta) - T*theta'| (plus the azimuth turn
        # component in quadrature). Johancsik integrates bit-up, where the
        # same expression appears as T*dtheta_up + w sin(theta).
        n = math.hypot(T * spsi, w * math.sin(th) - T * dth)
        r = comp.get('tooljointOdM', comp['odM']) / 2.0
        vt = 2 * math.pi * r * rpm / 60.0
        vres = math.hypot(va, vt)
        fa = va / vres if vres > 0 else 0.0
        ft = vt / vres if vres > 0 else 0.0
        dT = w * math.cos(th) + fa * mu * n
        dM = ft * mu * n * r
        return dT, dM, n

    T = -wob if on_bottom else 0.0
    M = bit_tq if on_bottom else 0.0
    step = 0.25
    md = bit_md
    max_t, min_t = T, T
    checkpoints = {}
    side = []  # (md, n per metre) for casing wear
    while md > stations[0][0] + 1e-9:
        h = min(step, md - stations[0][0])
        # RK4 on T (torque follows by quadrature with the same samples).
        k1, q1, n1 = rhs(md, T)
        k2, q2, _ = rhs(md - h / 2, T + h / 2 * k1)
        k3, q3, _ = rhs(md - h / 2, T + h / 2 * k2)
        k4, q4, _ = rhs(md - h, T + h * k3)
        T += h / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
        M += h / 6 * (q1 + 2 * q2 + 2 * q3 + q4)
        md -= h
        max_t, min_t = max(max_t, T), min(min_t, T)
        side.append((md, n1))
        key = round(md / 500) * 500
        if abs(md - key) < step / 2 and key > 0 and key not in checkpoints:
            checkpoints[key] = (T, M)
    return {
        'bitMd': bit_md,
        'hookloadN': T,
        'surfaceTorqueNm': M,
        'maxTensionN': max_t,
        'minTensionN': min_t,
        'checkpoints': [
            {'md': float(k), 'tensionN': v[0], 'torqueNm': v[1]}
            for k, v in sorted(checkpoints.items())
        ],
    }, side


# ---------------------------------------------------------------- cases

STRING = [
    {'type': 'dc', 'lengthM': 150.0, 'odM': 6.75 * IN, 'idM': 2.25 * IN,
     'weightKgM': 108.1 * LBFT},
    {'type': 'hwdp', 'lengthM': 150.0, 'odM': 5.0 * IN, 'idM': 3.0 * IN,
     'weightKgM': 49.3 * LBFT, 'tooljointOdM': 6.5 * IN},
    # dp lengthM set per well to reach TD
    {'type': 'dp', 'lengthM': None, 'odM': 5.0 * IN, 'idM': 4.276 * IN,
     'weightKgM': 22.26 * LBFT, 'tooljointOdM': 6.625 * IN,
     'yieldPa': 135e3 * 6.894757e3},
]
MUD = 1440.0
PARAMS = {'wobN': 89000.0, 'bitTorqueNm': 2700.0, 'tripSpeedMs': 0.3,
          'rpm': 120.0}


def string_for(td):
    s = [dict(c) for c in STRING]
    s[2]['lengthM'] = td - s[0]['lengthM'] - s[1]['lengthM']
    return s


def geometry_for(shoe, td):
    return [
        {'fromMd': 0.0, 'toMd': shoe, 'frictionFactor': 0.25,
         'holeIdM': 8.681 * IN, 'cased': True},
        {'fromMd': shoe, 'toMd': td, 'frictionFactor': 0.35,
         'holeIdM': 8.5 * IN, 'cased': False},
    ]


WELLS = {
    'vertical': (make_planar_stations([('v', 2000.0)], 0.0), 1200.0, 2000.0),
    'slant': (make_planar_stations(
        [('v', 500.0), ('b', 2.0, 600.0), ('h', 1900.0, 40.0)], 45.0),
        1400.0, 3000.0),
    'buildhold': (make_planar_stations(
        [('v', 800.0), ('b', 3.0, 650.0), ('h', 2050.0, 65.0)], 120.0),
        1800.0, 3500.0),
    'horizontal': (make_planar_stations(
        [('v', 1000.0), ('b', 8.0, 337.5), ('h', 1462.5, 90.0)], 270.0),
        1200.0, 2800.0),
    'swell3d': (make_toolface_stations(400.0, 3.0, 60.0, 600.0, 800.0),
        900.0, 1800.0),
}
OPS = ['trip_out', 'trip_in', 'rotate_on_bottom', 'slide_drill']


def case_torquedrag():
    cases = []
    wear_side = None
    for name, (stations, shoe, td) in WELLS.items():
        string = string_for(td)
        geometry = geometry_for(shoe, td)
        ops = OPS + (['backream'] if name == 'swell3d' else [])
        expected = {}
        for op in ops:
            res, side = integrate(stations, string, geometry, MUD, op, PARAMS)
            expected[op] = res
            if name == 'horizontal' and op == 'rotate_on_bottom':
                wear_side = side
        cases.append({
            'name': name,
            'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
            'string': string,
            'geometry': geometry,
            'mudDensityKgM3': MUD,
            'params': PARAMS,
            'expected': expected,
        })
    write('torquedrag_cases.json', {
        'description': 'Soft-string T&D oracle: RK4 on the Johancsik/Sheppard '
                       'ODE, independent vector-slerp attitude. JS engine '
                       'must agree rtol 1e-4 on summaries and checkpoints.',
        'cases': cases,
    })
    return wear_side


def groove_area(R, r, d):
    """Area of the tool-joint disc (radius r) lying OUTSIDE the bore circle
    (radius R) when bitten depth d past tangency: the worn crescent."""
    c = R - r + d
    if c >= R + r:
        return math.pi * r * r      # disc fully outside the bore
    if c <= abs(R - r):
        return 0.0                  # disc fully inside the bore: no groove
    a1 = math.acos((c * c + R * R - r * r) / (2 * c * R))
    a2 = math.acos((c * c + r * r - R * R) / (2 * c * r))
    lens = (R * R * (a1 - math.sin(2 * a1) / 2)
            + r * r * (a2 - math.sin(2 * a2) / 2))
    return math.pi * r * r - lens


def depth_for_area(R, r, area):
    lo, hi = 0.0, 2 * r
    for _ in range(200):
        mid = (lo + hi) / 2
        if groove_area(R, r, mid) < area:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-13:
            break
    return (lo + hi) / 2


def case_casingwear(side):
    R = 8.681 * IN / 2          # 9-5/8 47 casing IR
    r = 6.625 * IN / 2          # NC50 tool joint radius
    wall = 0.472 * IN
    wf = 2.0                    # mm^3/(kN*m)
    schedule = [{'rpm': 120.0, 'hours': 50.0}]
    slide = sum(2 * math.pi * r * s['rpm'] * 60 * s['hours'] for s in schedule)
    interval = 30.0
    shoe = 1200.0
    side_sorted = sorted(side)
    mds = np.array([m for m, _ in side_sorted])
    ns = np.array([n for _, n in side_sorted])
    rows = []
    top = 0.0
    while top < shoe - 1e-9:
        bottom = min(top + interval, shoe)
        mid = (top + bottom) / 2
        n_mid = float(np.interp(mid, mds, ns))
        side_n = n_mid * (bottom - top)
        vol = wf * 1e-12 * side_n * slide
        depth = depth_for_area(R, r, vol / (bottom - top))
        rows.append({'fromMd': top, 'toMd': bottom, 'sideForceN': side_n,
                     'wearVolumeM3': vol, 'wearDepthM': depth,
                     'remainingWallM': max(0.0, wall - depth)})
        top = bottom
    # Pure-geometry anchors for grooveArea/grooveDepthForArea.
    geo = [{'depthM': d, 'areaM2': groove_area(R, r, d)}
           for d in (0.0, 0.001, 0.003, 0.006, 0.010)]
    write('casingwear_cases.json', {
        'description': 'Casing wear oracle on the horizontal well rotate-on-'
                       'bottom side forces: V = WF*N*L, crescent groove '
                       'inversion by bisection. JS must agree rtol 1e-3.',
        'casing': {'irM': R, 'wallM': wall, 'shoeMd': shoe},
        'tjRadiusM': r,
        'wearFactorMm3PerKNm': wf,
        'schedule': schedule,
        'totalSlidingDistanceM': slide,
        'intervalM': interval,
        'grooveGeometry': geo,
        'rows': rows,
        'summary': {
            'maxWearDepthM': max(r_['wearDepthM'] for r_ in rows),
            'minRemainingWallM': min(r_['remainingWallM'] for r_ in rows),
        },
    })


if __name__ == '__main__':
    wear_side = case_torquedrag()
    case_casingwear(wear_side)
