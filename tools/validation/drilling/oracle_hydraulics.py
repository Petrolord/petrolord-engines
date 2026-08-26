#!/usr/bin/env python3
"""Independent oracle for the drilling hydraulics engines (Drilling D2):
rheology fits, RP 13D-style circulating losses + ECD, surge/swab, and
cuttings slip / transport. Emits committed goldens to
test-data/drilling/goldens/hydraulics_cases.json.

Independence discipline: the reference implementation below is written
from the METHOD SPEC (shared with the JS engines: local n'/K'
linearization, generalized Reynolds number, 16/Re-24/Re laminar,
a/Re^b turbulent with the Bourgoyne coefficients, blend over
[Rec, Rec+800], Burkhardt clinging constant 0.45, Schiller-Naumann drag
with damped fixed point) in independent numpy code. Because the method is
element-wise algebra (no discretization freedom), agreement is asserted
tightly (rtol 1e-6).

Wells/strings/geometry reuse the D1 oracle's constructors
(oracle_torquedrag.py) so the hydraulics goldens ride the same synthetic
trajectories the T&D goldens use.

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_hydraulics.py
"""
import math

from oracle_torquedrag import WELLS, string_for, geometry_for, rnd, write  # noqa: F401

G = 9.80665
TAU_PER_DEG = 1.066 * 0.47880259
GAMMA_PER_RPM = 1.70233
R600 = 600 * GAMMA_PER_RPM
R300 = 300 * GAMMA_PER_RPM


# ---------------------------------------------------------------- rheology

def fit_models(th600, th300, th6=None, th3=None):
    t600, t300 = TAU_PER_DEG * th600, TAU_PER_DEG * th300
    pv = (t600 - t300) / (R600 - R300)
    yp = max(0.0, t300 - pv * R300)
    n_pl = math.log(t600 / t300) / math.log(2.0)
    k_pl = t300 / R300 ** n_pl
    if th3 is not None and th6 is not None:
        ty = max(0.0, TAU_PER_DEG * (2 * th3 - th6))
    elif th3 is not None:
        ty = max(0.0, TAU_PER_DEG * th3)
    else:
        ty = 0.0
    ty = min(ty, 0.99 * t300)
    n_hb = math.log((t600 - ty) / (t300 - ty)) / math.log(2.0)
    k_hb = (t300 - ty) / R300 ** n_hb
    return {
        'bingham': {'type': 'bingham', 'pvPaS': pv, 'ypPa': yp},
        'powerLaw': {'type': 'powerLaw', 'n': n_pl, 'kPaSn': k_pl},
        'herschelBulkley': {'type': 'herschelBulkley', 'tauYPa': ty, 'n': n_hb, 'kPaSn': k_hb},
    }


def stress(model, gd):
    t = model['type']
    if t == 'bingham':
        return model['ypPa'] + model['pvPaS'] * gd
    if t == 'powerLaw':
        return model['kPaSn'] * gd ** model['n']
    return model['tauYPa'] + model['kPaSn'] * gd ** model['n']


def local_pl(model, gd):
    gd = max(gd, 1e-6)
    tau = stress(model, gd)
    t = model['type']
    if t == 'bingham':
        slope = model['pvPaS'] * gd / tau
    elif t == 'powerLaw':
        slope = model['n']
    else:
        slope = model['n'] * model['kPaSn'] * gd ** model['n'] / tau
    npr = min(max(slope, 0.05), 1.0)
    return npr, tau


# ---------------------------------------------------------------- elements

def component_spans(string, bit_md):
    spans = []
    dist = 0.0
    for c in string:
        bottom = bit_md - dist
        top = max(0.0, bottom - c['lengthM'])
        spans.append((top, bottom, c))
        dist += c['lengthM']
        if top <= 0:
            break
    return list(reversed(spans))


def flow_elements(stations, string, geometry):
    td = stations[-1][0]
    total = sum(c['lengthM'] for c in string)
    bit_md = min(total, td)
    spans = component_spans(string, bit_md)
    cuts = {0.0, bit_md}
    for top, bottom, _ in spans:
        cuts.add(top)
        cuts.add(bottom)
    for g in geometry:
        if g['fromMd'] < bit_md:
            cuts.add(max(0.0, g['fromMd']))
        if g['toMd'] < bit_md:
            cuts.add(max(0.0, g['toMd']))
    edges = sorted(x for x in cuts if 0.0 <= x <= bit_md)
    pipe, ann = [], []
    for a, b in zip(edges, edges[1:]):
        if b - a < 1e-9:
            continue
        mid = (a + b) / 2
        span = next(((t, bo, c) for t, bo, c in spans if t <= mid <= bo), None)
        if span is None:
            continue
        comp = span[2]
        sec = next((g for g in geometry if g['fromMd'] - 1e-9 <= mid <= g['toMd'] + 1e-9), None)
        pipe.append({'fromMd': a, 'toMd': b, 'L': b - a, 'd': comp['idM'], 'comp': comp})
        ann.append({'fromMd': a, 'toMd': b, 'L': b - a,
                    'dh': sec['holeIdM'] if sec else None, 'do': comp['odM'], 'comp': comp})
    return pipe, ann, bit_md


def element_loss(model, rho, v, d, kind, L):
    if v == 0:
        return 0.0
    base = (8 * v / d) if kind == 'pipe' else (12 * v / d)
    gd = base
    npr = 1.0
    for _ in range(6):
        npr, _ = local_pl(model, gd)
        gd = base * ((3 * npr + 1) / (4 * npr)) if kind == 'pipe' else base * ((2 * npr + 1) / (3 * npr))
    _, tau = local_pl(model, gd)
    # Metzner-Reed generalized viscosity (wall stress over the UNCORRECTED
    # Newtonian rate): laminar 16/Re and 24/Re then reproduce the exact
    # Newtonian/power-law laminar solutions (dP = 4*tau_w*L/d).
    mue = tau / base
    re = rho * v * d / mue
    flam_c = 16.0 if kind == 'pipe' else 24.0
    a = (math.log10(npr) + 3.93) / 50.0
    b = (1.75 - math.log10(npr)) / 7.0
    rec1 = 3470 - 1370 * npr
    rec2 = rec1 + 800
    if re <= rec1:
        f = flam_c / re
    elif re >= rec2:
        f = a / re ** b
    else:
        f1 = flam_c / rec1
        f2 = a / rec2 ** b
        f = f1 + (re - rec1) / (rec2 - rec1) * (f2 - f1)
    return 2 * f * rho * v * v * L / d


def tvd_of(stations, md):
    # Minimum-curvature TVD (the published formula: trapezoid times the
    # ratio factor RF = (2/beta)*tan(beta/2)). The hydraulics wells are
    # PLANAR (slant, horizontal), where inclination is linear in MD along
    # each arc and beta = |dtheta| exactly, so this is exact and matches
    # the JS survey engine to float precision.
    tvd = 0.0
    for (m1, i1, _), (m2, i2, _) in zip(stations, stations[1:]):
        if md <= m1:
            break
        seg_end = min(md, m2)
        th1 = math.radians(i1)
        i_end = i2 if md >= m2 else i1 + (i2 - i1) * (seg_end - m1) / (m2 - m1)
        th2 = math.radians(i_end)
        beta = abs(th2 - th1)
        rf = 1.0 if beta < 1e-12 else (2.0 / beta) * math.tan(beta / 2.0)
        tvd += (seg_end - m1) / 2.0 * (math.cos(th1) + math.cos(th2)) * rf
        if md <= m2:
            break
    return tvd


def hydraulics(stations, string, geometry, rho, model, q, tfa):
    pipe, ann, bit_md = flow_elements(stations, string, geometry)
    pipe_dp = 0.0
    for el in pipe:
        v = q / (math.pi / 4 * el['d'] ** 2)
        pipe_dp += element_loss(model, rho, v, el['d'], 'pipe', el['L'])
    ann_dp = 0.0
    min_v = float('inf')
    ecd_rows = []
    cum = 0.0
    for el in sorted((e for e in ann if e['dh']), key=lambda e: e['fromMd']):
        area = math.pi / 4 * (el['dh'] ** 2 - el['do'] ** 2)
        v = q / area
        dp = element_loss(model, rho, v, el['dh'] - el['do'], 'annulus', el['L'])
        cum += dp
        min_v = min(min_v, v)
        tvd = tvd_of(stations, el['toMd'])
        ecd_rows.append({'md': el['toMd'], 'tvd': tvd,
                         'ecdKgM3': rho + cum / (G * tvd) if tvd > 0 else rho})
    bit_dp = rho * q * q / (2 * 0.95 ** 2 * tfa ** 2) if tfa > 0 else 0.0
    return {
        'pumpPressurePa': pipe_dp + bit_dp + cum,
        'pipeDpPa': pipe_dp,
        'annulusDpPa': cum,
        'bitDpPa': bit_dp,
        'ecdAtTdKgM3': ecd_rows[-1]['ecdKgM3'] if ecd_rows else rho,
        'minAnnularVelocityMs': min_v,
        'ecdCheckpoints': ecd_rows[:: max(1, len(ecd_rows) // 6)],
    }


def surge_swab(stations, string, geometry, rho, model, vp, mode):
    pipe, ann, bit_md = flow_elements(stations, string, geometry)
    cum = 0.0
    for el in sorted((e for e in ann if e['dh']), key=lambda e: e['fromMd']):
        area = math.pi / 4 * (el['dh'] ** 2 - el['do'] ** 2)
        if mode == 'closed':
            disp = math.pi / 4 * el['do'] ** 2
        else:
            disp = math.pi / 4 * (el['do'] ** 2 - el['comp'].get('idM', 0.0) ** 2)
        v_eff = vp * disp / area + 0.45 * vp
        cum += element_loss(model, rho, v_eff, el['dh'] - el['do'], 'annulus', el['L'])
    tvd = tvd_of(stations, bit_md)
    d_emw = cum / (G * tvd) if tvd > 0 else 0.0
    return {'dpPa': cum, 'surgeEmwKgM3': rho + d_emw, 'swabEmwKgM3': rho - d_emw}


def drag_coefficient(re):
    if re <= 1:
        return 24 / re
    if re < 1000:
        return 24 / re * (1 + 0.15 * re ** 0.687)
    return 0.44


def slip_velocity(model, rho_f, rho_s, dp, gd):
    _, tau = local_pl(model, max(gd, 1e-6))
    mua = tau / max(gd, 1e-6)
    vs = G * dp * dp * (rho_s - rho_f) / (18 * mua)
    for _ in range(80):
        re = rho_f * vs * dp / mua
        cd = drag_coefficient(max(re, 1e-12))
        nxt = math.sqrt(4 * G * dp * (rho_s - rho_f) / (3 * cd * rho_f))
        vs = 0.5 * vs + 0.5 * nxt
    return vs, mua


def hole_cleaning(stations, string, geometry, rho, model, q, rop, dp_part, rho_s):
    pipe, ann, bit_md = flow_elements(stations, string, geometry)
    usable = [e for e in ann if e['dh']]
    d_bit = usable[-1]['dh']
    feed = rop * math.pi / 4 * d_bit ** 2
    rows = []
    min_tr = float('inf')
    for el in usable:
        area = math.pi / 4 * (el['dh'] ** 2 - el['do'] ** 2)
        va = q / area
        dhyd = el['dh'] - el['do']
        gd = 12 * va / dhyd
        for _ in range(4):
            npr, _ = local_pl(model, gd)
            gd = (12 * va / dhyd) * ((2 * npr + 1) / (3 * npr))
        vs, mua = slip_velocity(model, rho, rho_s, dp_part, gd)
        tr = 1 - vs / va
        min_tr = min(min_tr, tr)
        rows.append({'fromMd': el['fromMd'], 'toMd': el['toMd'],
                     'annularVelocityMs': va, 'slipMs': vs, 'transportRatio': tr,
                     'cuttingsConcPct': 100 * feed / (q * tr) if tr > 0 else None})
    return {'rows': rows, 'minTransportRatio': min_tr, 'feedM3s': feed}


# ---------------------------------------------------------------- cases

MUDS = {
    'kcl_polymer': {'densityKgM3': 1440.0, 'fann': {'theta600': 64, 'theta300': 38, 'theta6': 7, 'theta3': 6}},
    'light_wbm': {'densityKgM3': 1200.0, 'fann': {'theta600': 45, 'theta300': 28, 'theta6': 5, 'theta3': 4}},
}
RATES = [0.015, 0.025, 0.035]     # m3/s (~240..550 gpm)
TFA = 3 * math.pi / 4 * 0.014 ** 2   # 3 x 14 mm nozzles
WELL_NAMES = ['slant', 'horizontal']


def main():
    cases = []
    for wname in WELL_NAMES:
        stations, shoe, td = WELLS[wname]
        string = string_for(td)
        geometry = geometry_for(shoe, td)
        for mname, mud in MUDS.items():
            f = mud['fann']
            fits = fit_models(f['theta600'], f['theta300'], f.get('theta6'), f.get('theta3'))
            model = fits['herschelBulkley']
            hyd = {f'q_{q}': hydraulics(stations, string, geometry, mud['densityKgM3'], model, q, TFA)
                   for q in RATES}
            ss = {f'v_{v}': surge_swab(stations, string, geometry, mud['densityKgM3'], model, v, 'closed')
                  for v in [0.2, 0.5, 1.0]}
            ss['open_v_0.5'] = surge_swab(stations, string, geometry, mud['densityKgM3'], model, 0.5, 'open')
            hc = hole_cleaning(stations, string, geometry, mud['densityKgM3'], model,
                               0.025, 0.005, 0.006, 2600.0)
            cases.append({
                'well': wname,
                'mudName': mname,
                'mud': mud,
                'fits': fits,
                'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
                'string': string,
                'geometry': geometry,
                'nozzleTfaM2': TFA,
                'flowRates': RATES,
                'expected': {'hydraulics': hyd, 'surgeSwab': ss, 'holeCleaning': hc},
            })
    write('hydraulics_cases.json', {
        'description': 'Drilling hydraulics oracle: independent numpy implementation '
                       'of the shared method spec (local n\'/K\', generalized Re, '
                       '16/24-Re laminar, Bourgoyne a/Re^b turbulent, blend over '
                       '[Rec,Rec+800], Burkhardt Kc=0.45, Schiller-Naumann slip). '
                       'JS engines must agree rtol 1e-6.',
        'cases': cases,
    })


if __name__ == '__main__':
    main()
