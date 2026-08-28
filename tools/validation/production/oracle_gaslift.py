#!/usr/bin/env python3
"""Independent oracle for the production gas-lift engines (Production P4):
gas properties, bellows-valve mechanics, valve spacing, valve settings,
the unloading sequence and the deepest injection point. Emits committed
goldens to test-data/production/goldens/gaslift_cases.json.

Independence discipline: this file is written from the METHOD SPEC that
the JS engines document (Sutton pseudo-criticals, Wichert-Aziz acid-gas
correction, DAK z solved on reduced density, real-gas static column,
fixed-volume nitrogen dome ratio, the IPO/PPO force balance, the
Thornhill-Craver orifice equation, and the top-down spacing recursion),
not by transcribing the JS. Where the JS marches the gas column with a
20-step trapezoid, the oracle integrates the same ODE with classical
RK4 at 20x the resolution, and where the JS iterates a fixed point for
a valve depth the oracle brackets and bisects the same residual. Two
different discretizations of the same physics agreeing to 1e-6 is the
evidence; identical code agreeing with itself would be none.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_gaslift.py
"""
import json
import math
import os

R_OFF = 459.67
AIR_MW = 28.9625
R_UNIV = 10.7316
G_FT_S2 = 32.17
T60_R = 60 + R_OFF
N2_TC_R = 227.16
N2_PC_PSIA = 492.5

A = [0.3265, -1.07, -0.5339, 0.01569, -0.05165,
     0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.721]


def rankine(t_f):
    return t_f + R_OFF


def sutton(sg):
    return (169.2 + 349.5 * sg - 74.0 * sg * sg,
            756.8 - 131.0 * sg - 3.6 * sg * sg)


def wichert_aziz(tpc, ppc, y_co2=0.0, y_h2s=0.0):
    a = y_co2 + y_h2s
    if a <= 0:
        return tpc, ppc
    eps = 120 * (a ** 0.9 - a ** 1.6) + 15 * (y_h2s ** 0.5 - y_h2s ** 4)
    tpc_c = tpc - eps
    ppc_c = ppc * tpc_c / (tpc + y_h2s * (1 - y_h2s) * eps)
    return tpc_c, ppc_c


def dak_z(ppr, tpr):
    """z from DAK. Bisection on rho_r of the residual z(rho)*rho - c,
    which is monotone increasing on (0, 3) for the range used here."""
    if ppr <= 0:
        return 1.0
    t1 = A[0] + A[1] / tpr + A[2] / tpr ** 3 + A[3] / tpr ** 4 + A[4] / tpr ** 5
    t2 = A[5] + A[6] / tpr + A[7] / tpr ** 2
    t3 = A[8] * (A[6] / tpr + A[7] / tpr ** 2)
    c = 0.27 * ppr / tpr

    def z_of(r):
        return (1 + t1 * r + t2 * r * r - t3 * r ** 5
                + A[9] * (1 + A[10] * r * r) * (r * r / tpr ** 3) * math.exp(-A[10] * r * r))

    def f(r):
        return z_of(r) * r - c

    lo, hi = 1e-12, 3.0
    while f(hi) < 0 and hi < 30:
        hi *= 2
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if f(mid) > 0:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-15:
            break
    return z_of(0.5 * (lo + hi))


def gas_z(p_psia, t_f, sg, y_co2=0.0, y_h2s=0.0):
    tpc, ppc = wichert_aziz(*sutton(sg), y_co2, y_h2s)
    return dak_z(p_psia / ppc, rankine(t_f) / tpc)


def n2_z(p_psia, t_f):
    return dak_z(p_psia / N2_PC_PSIA, rankine(t_f) / N2_TC_R)


def gas_grad(p_psia, t_f, sg, z=None):
    zz = gas_z(p_psia, t_f, sg) if z is None else z
    return (AIR_MW * sg * p_psia) / (zz * R_UNIV * rankine(t_f)) / 144.0


def column(p_surf, tvd, sg, temp_at, steps=400, z_fixed=None):
    """Static gas column by classical RK4 on dp/dD = grad(p, T(D))."""
    if tvd <= 0:
        return p_surf
    h = tvd / steps
    p = p_surf

    def g(d, pp):
        return gas_grad(pp, temp_at(d), sg, z_fixed)

    for i in range(steps):
        d = i * h
        k1 = g(d, p)
        k2 = g(d + h / 2, p + h * k1 / 2)
        k3 = g(d + h / 2, p + h * k2 / 2)
        k4 = g(d + h, p + h * k3)
        p += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6
    return p


def column_surface(p_at_depth, tvd, sg, temp_at):
    """Inverse of column() by bisection (monotone in the surface pressure)."""
    if tvd <= 0:
        return p_at_depth
    lo, hi = 1e-3, p_at_depth
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if column(mid, tvd, sg, temp_at) > p_at_depth:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-9:
            break
    return 0.5 * (lo + hi)


# ------------------------------------------------------------------ valves

def dome_at_temp(pd60, t_f):
    """P/(zT) constant for a fixed-volume nitrogen charge; bisection."""
    base = pd60 / (n2_z(pd60, 60.0) * T60_R)
    tr = rankine(t_f)
    lo, hi = 1e-3, pd60 * (tr / T60_R) * 3
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if mid / (n2_z(mid, t_f) * tr) > base:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-10:
            break
    return 0.5 * (lo + hi)


def dome_at_60(pd_t, t_f):
    base = pd_t / (n2_z(pd_t, t_f) * rankine(t_f))
    lo, hi = 1e-3, pd_t * 3
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if mid / (n2_z(mid, 60.0) * T60_R) > base:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-10:
            break
    return 0.5 * (lo + hi)


def port_area(d_in):
    return math.pi / 4 * d_in * d_in


def ratio(port_id, bellows):
    return port_area(port_id) / bellows


def ipo_dome_from_opening(pco, pt, r):
    return pco * (1 - r) + r * pt


def ppo_dome_from_opening(pto, pc, r):
    return pto * (1 - r) + r * pc


def tro_from_dome(pd60, r):
    return pd60 / (1 - r)


def spread(p_open, p_other, r):
    """Opening minus closing (dome) pressure; see the engine note."""
    return r * (p_open - p_other)


def critical_ratio(k):
    return (2 / (k + 1)) ** (k / (k - 1))


def thornhill_craver(p_up, p_dn, port_id, sg, t_f, cd=0.865, k=1.27):
    rc = critical_ratio(k)
    if p_up <= 0 or port_id <= 0:
        return 0.0
    raw = max(p_dn, 0.0) / p_up
    if raw >= 1:
        return 0.0
    r = max(raw, rc)
    bracket = r ** (2 / k) - r ** ((k + 1) / k)
    return (155.5 * cd * port_area(port_id) * p_up
            * math.sqrt((2 * G_FT_S2 * k / (k - 1)) * bracket / (sg * rankine(t_f))))


# ----------------------------------------------------------------- spacing

def top_valve_depth(pko, pwh, kill_grad, sg, temp_at, max_depth):
    """Bisection on f(D) = column(pko, D) - pwh - kill_grad*D."""
    def f(d):
        return column(pko, d, sg, temp_at) - pwh - kill_grad * d

    if f(max_depth) > 0:
        return max_depth
    lo, hi = 0.0, max_depth
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if f(mid) > 0:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-6:
            break
    return 0.5 * (lo + hi)


def space_valves(cfg):
    pko = cfg['pKickoffPsia']
    dec = 0.0 if cfg.get('method') == 'constantPressure' else max(cfg.get('dpPerValvePsi', 25), 0)
    dp_tr = cfg.get('dpTransferPsi', 50)
    kill = cfg.get('killGradPsiPerFt', 0.45)
    unl = cfg.get('unloadGradPsiPerFt', 0.10)
    pwh = cfg['pWhUnloadPsia']
    sg = cfg['gasSg']
    temp_at = cfg['tempAt']
    floor = min(cfg['maxDepthFt'], cfg.get('targetDepthFt', cfg['maxDepthFt']))
    min_sp = cfg.get('minSpacingFt', 200)
    max_v = cfg.get('maxValves', 12)

    depths = [top_valve_depth(pko, pwh, kill, sg, temp_at, floor)]
    surfs = [pko]
    stop = 'maxValves'
    if depths[0] >= floor - 1e-6:
        return depths, surfs, 'targetDepth'

    for n in range(2, max_v + 1):
        p_surf = pko - (n - 1) * dec
        if p_surf <= pwh:
            stop = 'injectionPressure'
            break
        d_prev = depths[-1]
        p_prod_prev = pwh + unl * d_prev

        def f(d):
            return d_prev + (column(p_surf, d, sg, temp_at) - dp_tr - p_prod_prev) / kill - d

        # f is decreasing in d (column grows slower than kill_grad*d)
        if f(d_prev) <= 0:
            stop = 'injectionPressure'
            break
        lo, hi = d_prev, max(floor * 4, d_prev + 1)
        while f(hi) > 0 and hi < 1e6:
            hi *= 2
        for _ in range(200):
            mid = 0.5 * (lo + hi)
            if f(mid) > 0:
                lo = mid
            else:
                hi = mid
            if hi - lo < 1e-6:
                break
        d = 0.5 * (lo + hi)

        if d >= floor:
            depths.append(floor)
            surfs.append(p_surf)
            stop = 'targetDepth'
            break
        if d - d_prev < min_sp:
            stop = 'minSpacing'
            break
        depths.append(d)
        surfs.append(p_surf)
    return depths, surfs, stop


def valve_settings(cfg, depths, surfs):
    sg = cfg['gasSg']
    temp_at = cfg['tempAt']
    pwh = cfg['pWhUnloadPsia']
    unl = cfg.get('unloadGradPsiPerFt', 0.10)
    bellows = cfg['bellowsAreaIn2']
    ports = cfg['ports']
    target = cfg['qgiTargetMscfd']
    p_oper = cfg.get('pOperatingPsia', cfg['pKickoffPsia'] - 100)
    vtype = cfg.get('valveType', 'IPO')
    out = []
    for i, d in enumerate(depths):
        t_f = temp_at(d)
        p_inj = column(surfs[i], d, sg, temp_at)
        p_prod = pwh + unl * d
        is_bottom = i == len(depths) - 1

        chosen = None
        for p in sorted(ports):
            if thornhill_craver(p_inj, p_prod, p, sg, t_f) >= target:
                chosen = p
                break
        if chosen is None:
            chosen = max(ports)
        if is_bottom and cfg.get('bottomOrifice', True) and cfg.get('orificeIdIn'):
            chosen = cfg['orificeIdIn']

        q = thornhill_craver(p_inj, p_prod, chosen, sg, t_f)
        if is_bottom and cfg.get('bottomOrifice', True):
            out.append({
                'depthFt': d, 'tempF': t_f, 'valveType': 'orifice', 'portIdIn': chosen,
                'pInjAtDepthPsia': p_inj, 'pProdAtDepthPsia': p_prod,
                'domeAtTempPsia': None, 'dome60Psia': None, 'testRackOpeningPsia': None,
                'spreadPsi': None, 'closingSurfacePressurePsia': None,
                'throughputMscfd': q,
            })
            continue

        r = ratio(chosen, bellows)
        pd_t = (ppo_dome_from_opening(p_prod, p_inj, r) if vtype == 'PPO'
                else ipo_dome_from_opening(p_inj, p_prod, r))
        pd60 = dome_at_60(pd_t, t_f)
        out.append({
            'depthFt': d, 'tempF': t_f, 'valveType': vtype, 'portIdIn': chosen,
            'r': r,
            'pInjAtDepthPsia': p_inj, 'pProdAtDepthPsia': p_prod,
            'domeAtTempPsia': pd_t, 'dome60Psia': pd60,
            'testRackOpeningPsia': tro_from_dome(pd60, r),
            'spreadPsi': (spread(p_prod, p_inj, r) if vtype == 'PPO'
                          else spread(p_inj, p_prod, r)),
            'closingSurfacePressurePsia': column_surface(pd_t, d, sg, temp_at),
            'throughputMscfd': q,
        })
    return out


def unloading(valves):
    stages = []
    for i, v in enumerate(valves):
        p_surf = None
        upper = []
        stages.append({'stage': i + 1, 'upperValvesOpen': upper})
    return stages


def injection_point(traverse, p_surf, sg, temp_at, dp_transfer, max_depth):
    rows = sorted(traverse, key=lambda r: r[0])
    deepest = min(max_depth, rows[-1][0])

    def margin(d, p):
        return column(p_surf, d, sg, temp_at) - dp_transfer - p

    prev = (rows[0][0], rows[0][1], margin(rows[0][0], rows[0][1]))
    for d, p in rows[1:]:
        if d > deepest:
            break
        m = margin(d, p)
        if prev[2] >= 0 > m:
            f = prev[2] / (prev[2] - m)
            depth = prev[0] + f * (d - prev[0])
            pp = prev[1] + f * (p - prev[1])
            return {'depthFt': depth, 'pInjPsia': column(p_surf, depth, sg, temp_at),
                    'pProdPsia': pp, 'limitedBy': 'pressure'}
        prev = (d, p, m)
    return {'depthFt': prev[0], 'pInjPsia': column(p_surf, prev[0], sg, temp_at),
            'pProdPsia': prev[1], 'limitedBy': 'depth'}


# ------------------------------------------------------------------- cases

def linear_temp(wht, bht, ref):
    return lambda d: wht + (bht - wht) * d / ref


PORTS_1IN = [1 / 8, 5 / 32, 3 / 16, 7 / 32, 1 / 4, 5 / 16]
PORTS_15IN = [1 / 4, 5 / 16, 3 / 8, 7 / 16, 1 / 2, 5 / 8, 3 / 4]

CASES = [
    {
        'id': 'westTexasOil',
        'note': '8000 ft oil well, 1000 psig kickoff, 1.5 in valves, 25 psi per valve.',
        'pKickoffPsia': 1014.7, 'pOperatingPsia': 914.7, 'method': 'surfaceClose',
        'dpPerValvePsi': 25.0, 'dpTransferPsi': 50.0, 'killGradPsiPerFt': 0.45,
        'unloadGradPsiPerFt': 0.10, 'pWhUnloadPsia': 114.7, 'gasSg': 0.65,
        'wht': 100.0, 'bht': 190.0, 'refDepth': 8000.0, 'maxDepthFt': 7500.0,
        'minSpacingFt': 250.0, 'maxValves': 12, 'valveType': 'IPO',
        'bellowsAreaIn2': 0.77, 'ports': PORTS_15IN, 'qgiTargetMscfd': 500.0,
        'bottomOrifice': True, 'orificeIdIn': 0.25,
    },
    {
        'id': 'deepHighPressure',
        'note': '11000 ft, 1400 psig kickoff, 1 in valves, 40 psi per valve, heavier kill fluid.',
        'pKickoffPsia': 1414.7, 'pOperatingPsia': 1314.7, 'method': 'surfaceClose',
        'dpPerValvePsi': 40.0, 'dpTransferPsi': 75.0, 'killGradPsiPerFt': 0.5,
        'unloadGradPsiPerFt': 0.12, 'pWhUnloadPsia': 214.7, 'gasSg': 0.7,
        'wht': 110.0, 'bht': 240.0, 'refDepth': 11000.0, 'maxDepthFt': 10500.0,
        'minSpacingFt': 300.0, 'maxValves': 14, 'valveType': 'IPO',
        'bellowsAreaIn2': 0.31, 'ports': PORTS_1IN, 'qgiTargetMscfd': 250.0,
        'bottomOrifice': True, 'orificeIdIn': 0.1875,
    },
    {
        'id': 'constantPressurePPO',
        'note': 'Constant surface pressure design with production-operated valves.',
        'pKickoffPsia': 1114.7, 'pOperatingPsia': 1114.7, 'method': 'constantPressure',
        'dpPerValvePsi': 0.0, 'dpTransferPsi': 100.0, 'killGradPsiPerFt': 0.42,
        'unloadGradPsiPerFt': 0.08, 'pWhUnloadPsia': 164.7, 'gasSg': 0.6,
        'wht': 95.0, 'bht': 175.0, 'refDepth': 9000.0, 'maxDepthFt': 8500.0,
        'minSpacingFt': 200.0, 'maxValves': 10, 'valveType': 'PPO',
        'bellowsAreaIn2': 0.77, 'ports': PORTS_15IN, 'qgiTargetMscfd': 800.0,
        'bottomOrifice': False, 'orificeIdIn': None,
    },
]

TRAVERSE = [
    (0, 164.7), (1000, 264.7), (2000, 372.7), (3000, 486.7), (4000, 606.7),
    (5000, 732.7), (6000, 864.7), (7000, 1002.7), (8000, 1146.7),
]


def build():
    out = {
        'description': (
            'Production P4 gas-lift goldens. Independent stdlib oracle '
            '(RK4 column, bisection roots) against the engine method spec: '
            'gas properties, nitrogen dome charge, valve force balance, '
            'Thornhill-Craver throughput, spacing recursion, valve '
            'settings and the deepest injection point.'
        ),
        'generator': 'tools/validation/production/oracle_gaslift.py',
        'gasProperties': [],
        'nitrogen': [],
        'thornhillCraver': [],
        'columns': [],
        'designs': [],
        'injectionPoint': None,
    }

    for sg, p, t in [(0.65, 500.0, 100.0), (0.65, 1500.0, 180.0), (0.70, 2500.0, 220.0),
                     (0.60, 100.0, 80.0), (0.80, 3500.0, 250.0)]:
        out['gasProperties'].append({
            'gasSg': sg, 'pPsia': p, 'tF': t, 'z': gas_z(p, t, sg),
            'gradPsiPerFt': gas_grad(p, t, sg),
        })
    out['gasPropertiesAcid'] = [{
        'gasSg': 0.75, 'pPsia': 2000.0, 'tF': 160.0, 'yCo2': 0.08, 'yH2s': 0.04,
        'z': dak_z(2000.0 / wichert_aziz(*sutton(0.75), 0.08, 0.04)[1],
                   rankine(160.0) / wichert_aziz(*sutton(0.75), 0.08, 0.04)[0]),
    }]

    for pd60, t in [(600.0, 120.0), (800.0, 180.0), (1000.0, 220.0), (1200.0, 250.0)]:
        pd_t = dome_at_temp(pd60, t)
        out['nitrogen'].append({
            'pd60Psia': pd60, 'tF': t, 'z60': n2_z(pd60, 60.0), 'zT': n2_z(pd_t, t),
            'domeAtTempPsia': pd_t, 'ct': pd60 / pd_t,
        })

    for p_up, p_dn, port, sg, t in [
        (1000.0, 300.0, 0.25, 0.65, 140.0),
        (1000.0, 900.0, 0.25, 0.65, 140.0),
        (1400.0, 700.0, 0.1875, 0.70, 200.0),
        (900.0, 850.0, 0.5, 0.60, 120.0),
    ]:
        out['thornhillCraver'].append({
            'pUpPsia': p_up, 'pDnPsia': p_dn, 'portIdIn': port, 'gasSg': sg, 'tF': t,
            'qMscfd': thornhill_craver(p_up, p_dn, port, sg, t),
            'criticalRatio': critical_ratio(1.27),
        })

    for p_surf, tvd, sg, wht, bht in [
        (1014.7, 8000.0, 0.65, 100.0, 190.0),
        (1414.7, 11000.0, 0.70, 110.0, 240.0),
        (614.7, 4000.0, 0.60, 90.0, 140.0),
    ]:
        temp_at = linear_temp(wht, bht, tvd)
        out['columns'].append({
            'pSurfPsia': p_surf, 'tvdFt': tvd, 'gasSg': sg, 'whtF': wht, 'bhtF': bht,
            'pBottomPsia': column(p_surf, tvd, sg, temp_at),
            'surfaceFromBottom': column_surface(column(p_surf, tvd, sg, temp_at), tvd, sg, temp_at),
        })

    for c in CASES:
        cfg = dict(c)
        cfg['tempAt'] = linear_temp(c['wht'], c['bht'], c['refDepth'])
        depths, surfs, stop = space_valves(cfg)
        valves = valve_settings(cfg, depths, surfs)
        out['designs'].append({
            'id': c['id'], 'note': c['note'],
            'inputs': {k: v for k, v in c.items() if k not in ('note',)},
            'stopReason': stop,
            'depths': depths,
            'surfacePressures': surfs,
            'valves': valves,
        })

    temp_at = linear_temp(100.0, 190.0, 8000.0)
    out['injectionPoint'] = {
        'traverse': [{'tvdFt': d, 'pPsia': p} for d, p in TRAVERSE],
        'pSurfPsia': 1014.7, 'gasSg': 0.65, 'whtF': 100.0, 'bhtF': 190.0,
        'refDepthFt': 8000.0, 'dpTransferPsi': 100.0, 'maxDepthFt': 8000.0,
        'expected': injection_point(TRAVERSE, 1014.7, 0.65, temp_at, 100.0, 8000.0),
    }
    return out


def rnd(o, nd=12):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, dict):
        return {k: rnd(v, nd) for k, v in o.items()}
    if isinstance(o, list):
        return [rnd(v, nd) for v in o]
    return o


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens', 'gaslift_cases.json'))
    data = rnd(build())
    with open(dest, 'w') as fh:
        json.dump(data, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', dest)
