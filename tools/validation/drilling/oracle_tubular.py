#!/usr/bin/env python3
"""Independent oracle for the casing & tubing design engine (Drilling D6):
API 5C3 four-regime collapse + Barlow burst + body/joint yield, Lame/von
Mises triaxial, canonical load-case profiles, string evaluation, and the
Lubinski/Hammerlindl tubing-packer force system. Emits
test-data/drilling/goldens/tubular_cases.json.

Independence discipline: everything below is implemented directly from the
published forms (API Bull. 5C3 coefficient polynomials; Lame thick-wall
cylinder; Lubinski 1962 planning forms), NOT from the JS engine. Before
writing, closed forms are self-asserted:
  * Barlow algebra   P = tol*2*Yp*t/D
  * 5C3 regime-boundary CONTINUITY: adjacent formulas agree at each D/t
    boundary (yield/plastic, plastic/transition, transition/elastic)
  * VME identity at zero shear equals hand-built principal-stress form
  * thermal force  dF = -E*A*alpha*dT
  * combined-loading Ypa strictly decreasing in tension

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_tubular.py
"""
import math

from oracle_torquedrag import WELLS, rnd, write  # noqa: F401
from oracle_hydraulics import tvd_of

G = 9.80665
PSI = 6894.757293168
IN = 0.0254
LBFT = 1.4881639
KSI = 6.894757e6
E_PA = 206.8e9
ALPHA = 12e-6
STEEL = 7850.0


# ---------------------------------------------------------------- ratings

def barlow(od, wall, yp, tol=0.875):
    return tol * 2.0 * yp * wall / od


def area(od, id_):
    return math.pi / 4.0 * (od * od - id_ * id_)


def body_yield(od, id_, yp):
    return yp * area(od, id_)


def ypa(yp, sa):
    r = sa / yp
    if r >= 1:
        return 0.0
    s = 1 - 0.75 * r * r
    if s <= 0:
        return 0.0
    return max(0.0, yp * (math.sqrt(s) - 0.5 * r))


def collapse_5c3(od, wall, yp0, sa=0.0):
    yp_eff = ypa(yp0, sa) if sa > 0 else yp0
    if yp_eff <= 0:
        return 0.0, 'yield-exhausted'
    Yp = yp_eff / PSI
    dt = od / wall
    A = 2.8762 + 0.10679e-5 * Yp + 0.21301e-10 * Yp ** 2 - 0.53132e-16 * Yp ** 3
    B = 0.026233 + 0.50609e-6 * Yp
    C = -465.93 + 0.030867 * Yp - 0.10483e-7 * Yp ** 2 + 0.36989e-13 * Yp ** 3
    ba = B / A
    x = 3.0 * ba / (2.0 + ba)
    F = 46.95e6 * x ** 3 / (Yp * (x - ba) * (1 - x) ** 2)
    Gc = F * ba
    dt_yp = (math.sqrt((A - 2) ** 2 + 8 * (B + C / Yp)) + (A - 2)) / (2 * (B + C / Yp))
    dt_pt = Yp * (A - F) / (C + Yp * (B - Gc))
    dt_te = (2 + ba) / (3 * ba)
    if dt <= dt_yp:
        p, reg = 2 * Yp * (dt - 1) / dt ** 2, 'yield'
    elif dt <= dt_pt:
        p, reg = Yp * (A / dt - B) - C, 'plastic'
    elif dt <= dt_te:
        p, reg = Yp * (F / dt - Gc), 'transition'
    else:
        p, reg = 46.95e6 / (dt * (dt - 1) ** 2), 'elastic'
    return max(0.0, p) * PSI, reg


def collapse_boundaries(yp_pa):
    Yp = yp_pa / PSI
    A = 2.8762 + 0.10679e-5 * Yp + 0.21301e-10 * Yp ** 2 - 0.53132e-16 * Yp ** 3
    B = 0.026233 + 0.50609e-6 * Yp
    C = -465.93 + 0.030867 * Yp - 0.10483e-7 * Yp ** 2 + 0.36989e-13 * Yp ** 3
    ba = B / A
    x = 3.0 * ba / (2.0 + ba)
    F = 46.95e6 * x ** 3 / (Yp * (x - ba) * (1 - x) ** 2)
    Gc = F * ba
    dt_yp = (math.sqrt((A - 2) ** 2 + 8 * (B + C / Yp)) + (A - 2)) / (2 * (B + C / Yp))
    dt_pt = Yp * (A - F) / (C + Yp * (B - Gc))
    dt_te = (2 + ba) / (3 * ba)
    forms = {
        'yield': lambda dt: 2 * Yp * (dt - 1) / dt ** 2,
        'plastic': lambda dt: Yp * (A / dt - B) - C,
        'transition': lambda dt: Yp * (F / dt - Gc),
        'elastic': lambda dt: 46.95e6 / (dt * (dt - 1) ** 2),
    }
    return dt_yp, dt_pt, dt_te, forms


def triaxial_sf(od, id_, yp, pi, po, fa, dls=0.0):
    ro, ri = od / 2.0, id_ / 2.0
    a = area(od, id_)
    s_ax = fa / a
    kappa = dls * math.pi / 180.0 / 30.0
    s_bend = E_PA * ro * kappa
    denom = ro * ro - ri * ri
    worst = 0.0
    for r in (ri, ro):
        st = (pi * ri * ri - po * ro * ro + (pi - po) * ri * ri * ro * ro / (r * r)) / denom
        sr = (pi * ri * ri - po * ro * ro - (pi - po) * ri * ri * ro * ro / (r * r)) / denom
        for sb in (s_bend, -s_bend):
            sa = s_ax + sb
            vme = math.sqrt(0.5 * ((st - sr) ** 2 + (sr - sa) ** 2 + (sa - st) ** 2))
            worst = max(worst, vme)
    return (yp / worst if worst > 0 else float('inf')), worst


# ---------------------------------------------------------------- profiles

def profiles(kind, shoe, env, string):
    mud = env.get('mudKgM3', 1440.0)
    cement = env.get('cementKgM3', 1900.0)
    gas_grad = env.get('gasGradPaPerM', 2300.0)
    frac_emw = env.get('fracEmwAtShoeKgM3')
    res_p = env.get('reservoirPressurePa')
    test_p = env.get('testPressurePa', 35e6)
    evac = env.get('evacuationFraction', 1.0)
    sea = env.get('seawaterKgM3', 1030.0)
    overpull = env.get('overpullN', 0.0)
    packer_fluid = env.get('packerFluidKgM3')
    w_kgm = string.get('weightKgM', 70.0)

    n = 50
    tvd = [i / n * shoe for i in range(n + 1)]
    w_n = w_kgm * G
    bf = 1 - mud / STEEL
    op = overpull if kind == 'runningAxial' else 0.0
    fa = [w_n * bf * (shoe - z) + op for z in tvd]
    mud_p = lambda z: mud * G * z  # noqa: E731

    if kind == 'gasKickBurst':
        if res_p is not None:
            p_shoe = res_p
        elif frac_emw is not None:
            p_shoe = frac_emw * G * shoe
        else:
            p_shoe = 1.2 * mud * G * shoe
        pi = [max(0.0, p_shoe - gas_grad * (shoe - z)) for z in tvd]
        po = [sea * G * z for z in tvd]
    elif kind == 'pressureTestBurst':
        pi = [test_p + mud_p(z) for z in tvd]
        po = [sea * G * z for z in tvd]
    elif kind == 'fullEvacuationCollapse':
        pi = [0.0 for _ in tvd]
        po = [mud_p(z) for z in tvd]
    elif kind == 'partialEvacuationCollapse':
        level = (1 - evac) * shoe
        fluid = packer_fluid if packer_fluid is not None else mud
        pi = [0.0 if z <= level else fluid * G * (z - level) for z in tvd]
        po = [mud_p(z) for z in tvd]
    elif kind == 'cementingCollapse':
        pi = [sea * G * z for z in tvd]
        po = [cement * G * z for z in tvd]
    elif kind == 'runningAxial':
        pi = [mud_p(z) for z in tvd]
        po = [mud_p(z) for z in tvd]
    elif kind == 'customGradient':
        i_rho = env.get('internalKgM3', mud)
        o_rho = env.get('externalKgM3', mud)
        surf = env.get('surfacePressurePa', 0.0)
        pi = [surf + i_rho * G * z for z in tvd]
        po = [o_rho * G * z for z in tvd]
    else:
        raise ValueError(kind)
    return tvd, pi, po, fa


def evaluate(sections, prof, dfs, dls=0.0):
    tvd, pi, po, fa = prof
    df = {'burst': dfs.get('burst', 1.1), 'collapse': dfs.get('collapse', 1.0),
          'tension': dfs.get('tension', 1.6), 'triaxial': dfs.get('triaxial', 1.25)}
    out = []
    for sec in sections:
        id_ = sec['odM'] - 2 * sec['wallM']
        b_rate = barlow(sec['odM'], sec['wallM'], sec['yieldPa'])
        by = body_yield(sec['odM'], id_, sec['yieldPa']) * sec.get('connectionEfficiency', 1.0)
        a = area(sec['odM'], id_)
        w = {'burstSF': float('inf'), 'collapseSF': float('inf'),
             'tensionSF': float('inf'), 'triaxSF': float('inf'),
             'burstAtTvdM': None, 'collapseAtTvdM': None, 'collapseRegime': None}
        for i, z in enumerate(tvd):
            if z < sec['topTvdM'] - 1e-9 or z > sec['bottomTvdM'] + 1e-9:
                continue
            d_pb = pi[i] - po[i]
            if d_pb > 0:
                sf = b_rate / d_pb
                if sf < w['burstSF']:
                    w['burstSF'], w['burstAtTvdM'] = sf, z
            d_pc = po[i] - pi[i]
            if d_pc > 0:
                s_a = max(0.0, fa[i]) / a
                col, reg = collapse_5c3(sec['odM'], sec['wallM'], sec['yieldPa'], s_a)
                sf = col / d_pc
                if sf < w['collapseSF']:
                    w['collapseSF'], w['collapseAtTvdM'], w['collapseRegime'] = sf, z, reg
            if fa[i] > 0:
                sf = by / fa[i]
                if sf < w['tensionSF']:
                    w['tensionSF'] = sf
            tri, _ = triaxial_sf(sec['odM'], id_, sec['yieldPa'], pi[i], po[i], fa[i], dls)
            if tri < w['triaxSF']:
                w['triaxSF'] = tri
        if (w['burstSF'] < df['burst'] or w['collapseSF'] < df['collapse']
                or w['tensionSF'] < df['tension'] or w['triaxSF'] < df['triaxial']):
            status = 'FAIL'
        elif (w['burstSF'] < df['burst'] * 1.1 or w['collapseSF'] < df['collapse'] * 1.1
                or w['triaxSF'] < df['triaxial'] * 1.1):
            status = 'WARNING'
        else:
            status = 'PASS'
        row = {'burstRatingPa': b_rate, 'bodyYieldN': by, 'status': status}
        row.update(w)
        # Unbounded SFs (no load of that sign anywhere in the section) are
        # emitted as null: Infinity is not valid JSON.
        out.append({k: (None if isinstance(v, float) and math.isinf(v) else v)
                    for k, v in row.items()})
    return out


# ---------------------------------------------------------------- tubing

def tubing_loads(tub, packer, case, temp, casing_id):
    od, id_, L, wkgm = tub['odM'], tub['idM'], tub['lengthM'], tub['weightKgM']
    seal = packer.get('sealBoreM', od)
    rating = packer.get('ratingN', 4.45e5)
    stroke = packer.get('strokeM', 0.0)
    Ai = math.pi / 4 * id_ * id_
    Ao = math.pi / 4 * od * od
    Ap = math.pi / 4 * seal * seal
    A = Ao - Ai
    inertia = math.pi / 64 * (od ** 4 - id_ ** 4)
    ei = E_PA * inertia
    d_pi = case.get('dPiPa', 0.0)
    d_po = case.get('dPoPa', 0.0)
    ext = case.get('externalKgM3', 1440.0)
    d_t = temp.get('deltaOpC')
    if d_t is None:
        d_t = temp.get('gradCPerM', 0.03) * L / 2.0
    piston = (Ap - Ai) * d_pi - (Ap - Ao) * d_po
    balloon = 0.6 * (d_pi * Ai - d_po * Ao)
    thermal = -E_PA * A * ALPHA * d_t
    total = piston + balloon + thermal
    bf_ext = 1 - ext / STEEL
    wc = max(wkgm * G * bf_ext, 1.0)
    clr = max((casing_id - od) / 2.0 if casing_id else 0.02, 1e-3)
    base = math.sqrt(ei * wc / clr)
    sin_n, hel_n = 2 * base, 2 * (2 * math.sqrt(2) - 1) * base
    comp = max(0.0, -total)
    buck = 'helical' if comp > hel_n else ('sinusoidal' if comp > sin_n else 'none')
    dl1 = -piston * L / (E_PA * A)
    dl2 = (-2 * 0.3 * L / E_PA) * ((d_pi * Ai - d_po * Ao) / A)
    dl4 = ALPHA * L * d_t
    total_dl = dl1 + dl2 + dl4
    sf = rating / max(1.0, abs(total)) if rating > 0 else None
    return {'forces': {'pistonN': piston, 'ballooningN': balloon, 'thermalN': thermal,
                       'totalN': total},
            'lengthChanges': {'pistonM': dl1, 'ballooningM': dl2, 'thermalM': dl4,
                              'totalM': total_dl},
            'buckling': {'state': buck, 'sinusoidalN': sin_n, 'helicalN': hel_n,
                         'compressionN': comp},
            'packer': {'sf': sf, 'ratingN': rating,
                       'strokeOk': None if stroke <= 0 else abs(total_dl) <= stroke},
            'meta': {'dTC': d_t}}


def erosional(rho, c=100.0):
    return c / math.sqrt(rho / 16.018463) * 0.3048


# ---------------------------------------------------------------- catalog

CASING_GRADES = {'H-40': 40, 'J-55': 55, 'K-55': 55, 'M-65': 65, 'L-80': 80,
                 'N-80': 80, 'C-90': 90, 'T-95': 95, 'P-110': 110, 'Q-125': 125}

CASING_ROWS = [
    (20, 94, 0.438, 19.124), (20, 106.5, 0.500, 19.000), (20, 133, 0.635, 18.730),
    (13.375, 54.5, 0.380, 12.615), (13.375, 61, 0.430, 12.515),
    (13.375, 68, 0.480, 12.415), (13.375, 72, 0.514, 12.347),
    (9.625, 36, 0.352, 8.921), (9.625, 40, 0.395, 8.835),
    (9.625, 43.5, 0.435, 8.755), (9.625, 47, 0.472, 8.681),
    (9.625, 53.5, 0.545, 8.535),
    (7, 23, 0.317, 6.366), (7, 26, 0.362, 6.276), (7, 29, 0.408, 6.184),
    (7, 32, 0.453, 6.094), (7, 35, 0.498, 6.004),
    (5.5, 17, 0.304, 4.892), (5.5, 20, 0.361, 4.778), (5.5, 23, 0.415, 4.670),
    (4.5, 11.6, 0.250, 4.000), (4.5, 13.5, 0.290, 3.920),
]

TUBING_ROWS = [
    (2.375, 4.7, 0.190, 1.995), (2.875, 6.5, 0.217, 2.441),
    (3.5, 9.3, 0.254, 2.992), (3.5, 12.95, 0.375, 2.750),
    (4, 11, 0.262, 3.476), (4.5, 12.75, 0.271, 3.958),
]

RATING_GRADES = ['K-55', 'L-80', 'P-110']


# ---------------------------------------------------------------- asserts

def self_asserts():
    # Barlow algebra: 9-5/8 47 L-80 hand value.
    b = barlow(9.625 * IN, 0.472 * IN, 80 * KSI)
    hand_psi = 0.875 * 2 * 80000 * 0.472 / 9.625
    assert abs(b / PSI - hand_psi) < 0.5, (b / PSI, hand_psi)

    # Regime-boundary continuity for every grade (adjacent formulas agree).
    for name, ksi in CASING_GRADES.items():
        dt_yp, dt_pt, dt_te, forms = collapse_boundaries(ksi * KSI)
        assert dt_yp < dt_pt < dt_te, (name, dt_yp, dt_pt, dt_te)
        for dt, (fa_, fb_) in [(dt_yp, ('yield', 'plastic')),
                               (dt_pt, ('plastic', 'transition')),
                               (dt_te, ('transition', 'elastic'))]:
            a, b2 = forms[fa_](dt), forms[fb_](dt)
            assert abs(a - b2) <= 1e-6 * max(abs(a), abs(b2)) + 1e-6, (name, fa_, fb_, a, b2)

    # VME identity at zero shear: pure axial tension -> vme == |sigma_a|.
    od, id_ = 9.625 * IN, 8.681 * IN
    fa = 1e6
    _, vme = triaxial_sf(od, id_, 80 * KSI, 0.0, 0.0, fa)
    assert abs(vme - fa / area(od, id_)) < 1.0, (vme, fa / area(od, id_))

    # Thermal force dF = -E*A*alpha*dT.
    r = tubing_loads({'odM': 3.5 * IN, 'idM': 2.992 * IN, 'lengthM': 2000.0,
                      'weightKgM': 9.3 * LBFT},
                     {'sealBoreM': 4.0 * IN}, {'dPiPa': 0.0, 'dPoPa': 0.0},
                     {'deltaOpC': 40.0}, 6.184 * IN)
    a = area(3.5 * IN, 2.992 * IN)
    assert abs(r['forces']['thermalN'] + E_PA * a * ALPHA * 40.0) < 1e-6

    # Ypa strictly decreasing in tension.
    yp = 80 * KSI
    prev = ypa(yp, 0.0)
    for sa in [0.1, 0.2, 0.4, 0.6, 0.8]:
        cur = ypa(yp, sa * yp)
        assert cur < prev, (sa, cur, prev)
        prev = cur
    print('self-asserts OK')


# ---------------------------------------------------------------- goldens

def main():
    self_asserts()

    ratings = []
    for od_in, w, wall_in, id_in in CASING_ROWS + TUBING_ROWS:
        for gname in RATING_GRADES:
            yp = CASING_GRADES[gname] * KSI
            od, wall, id_ = od_in * IN, wall_in * IN, id_in * IN
            col, reg = collapse_5c3(od, wall, yp)
            col_t, reg_t = collapse_5c3(od, wall, yp, 0.4 * yp)
            ratings.append({
                'odIn': od_in, 'weightLbFt': w, 'grade': gname,
                'burstPa': barlow(od, wall, yp),
                'collapsePa': col, 'regime': reg,
                'collapseAt40pctTensionPa': col_t, 'regimeAt40pctTension': reg_t,
                'bodyYieldN': body_yield(od, id_, yp),
            })

    # Golden 9-5/8 design on the D1 slant well: shoe at TD 3000 m MD, section
    # break at 1650 m MD (the case-doc convention is MD; TVDs derive through
    # the exact minimum-curvature tvd_of, matching the suite ctRun mapping).
    # The axial-profile string weight is the MD-length-weighted mean of the
    # section weights — exactly what ctRun feeds loadCaseProfiles.
    stations, _, td = WELLS['slant']
    shoe_tvd = tvd_of(stations, td)
    break_md = 1650.0
    break_tvd = tvd_of(stations, break_md)
    env = {'mudKgM3': 1440.0, 'cementKgM3': 1900.0, 'gasGradPaPerM': 2300.0,
           'fracEmwAtShoeKgM3': 1800.0, 'testPressurePa': 35e6,
           'evacuationFraction': 0.4, 'packerFluidKgM3': 1150.0,
           'seawaterKgM3': 1030.0, 'overpullN': 4.45e5,
           'internalKgM3': 500.0, 'externalKgM3': 1600.0,
           'surfacePressurePa': 5e6}
    w_mean_lbft = (47.0 * break_md + 53.5 * (td - break_md)) / td
    string = {'weightKgM': w_mean_lbft * LBFT}
    sections_md = [
        {'topMdM': 0.0, 'bottomMdM': break_md, 'odIn': 9.625, 'weightLbFt': 47,
         'grade': 'P-110', 'connection': 'BTC'},
        {'topMdM': break_md, 'bottomMdM': td, 'odIn': 9.625, 'weightLbFt': 53.5,
         'grade': 'L-80', 'connection': 'LTC'},
    ]
    sections = [
        {'topTvdM': 0.0, 'bottomTvdM': break_tvd,
         'odM': 9.625 * IN, 'wallM': 0.472 * IN, 'yieldPa': 110 * KSI,
         'connectionEfficiency': 1.0},
        {'topTvdM': break_tvd, 'bottomTvdM': shoe_tvd,
         'odM': 9.625 * IN, 'wallM': 0.545 * IN, 'yieldPa': 80 * KSI,
         'connectionEfficiency': 0.85},
    ]
    dfs = {'burst': 1.1, 'collapse': 1.0, 'tension': 1.6, 'triaxial': 1.25}
    kinds = ['gasKickBurst', 'pressureTestBurst', 'fullEvacuationCollapse',
             'partialEvacuationCollapse', 'cementingCollapse', 'runningAxial',
             'customGradient']
    cases = []
    for kind in kinds:
        prof = profiles(kind, shoe_tvd, env, string)
        res = evaluate(sections, prof, dfs, dls=2.0)
        tvd, pi, po, fa = prof
        cases.append({'kind': kind,
                      'profileCheckpoints': [
                          {'tvdM': tvd[i], 'piPa': pi[i], 'poPa': po[i], 'faN': fa[i]}
                          for i in (0, 10, 25, 50)],
                      'sections': res})

    tubing_scenarios = []
    for name, case, temp in [
        ('production-heating',
         {'dPiPa': 10e6, 'dPoPa': 0.0, 'externalKgM3': 1150.0}, {'deltaOpC': 45.0}),
        ('injection-cooling',
         {'dPiPa': 20e6, 'dPoPa': 0.0, 'externalKgM3': 1150.0}, {'deltaOpC': -30.0}),
        ('stimulation',
         {'dPiPa': 45e6, 'dPoPa': 5e6, 'externalKgM3': 1150.0}, {'deltaOpC': -50.0}),
    ]:
        r = tubing_loads({'odM': 3.5 * IN, 'idM': 2.992 * IN, 'lengthM': 2500.0,
                          'weightKgM': 9.3 * LBFT},
                         {'sealBoreM': 4.0 * IN, 'ratingN': 6.7e5, 'strokeM': 1.5},
                         case, temp, 6.184 * IN)
        tubing_scenarios.append({'name': name, 'case': case, 'temp': temp, 'result': r})

    write('tubular_cases.json', {
        'description': 'Tubular design oracle: independent implementation of '
                       'API Bull 5C3 four-regime collapse (regime-boundary '
                       'continuity self-asserted per grade), Barlow burst, '
                       'Lame/VME triaxial, canonical load-case profiles on '
                       'the D1 slant well, string evaluation, and Lubinski '
                       'tubing-packer forces. JS engine must agree rtol 1e-6.',
        'shoeTvdM': shoe_tvd,
        'shoeMdM': td,
        'breakMdM': break_md,
        'breakTvdM': break_tvd,
        'bendingDlsDegPer30m': 2.0,
        'env': env,
        'string': string,
        'sectionsMd': sections_md,
        'sections': sections,
        'designFactors': dfs,
        'ratings': ratings,
        'cases': cases,
        'tubing': tubing_scenarios,
        'erosional': {'mixtureKgM3': 700.0, 'cFactor': 100.0,
                      'veMs': erosional(700.0, 100.0)},
    })


if __name__ == '__main__':
    main()
