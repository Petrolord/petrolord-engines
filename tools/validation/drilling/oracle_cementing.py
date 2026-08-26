#!/usr/bin/env python3
"""Independent oracle for the cementing engine (Drilling D4): job volumes,
plug-flow placement (U-tube / free-fall / ECD) and API 10D standoff. Emits
test-data/drilling/goldens/cementing_cases.json.

Independence discipline: the volume-interval bookkeeping, hydrostatic
integrals (exact minimum-curvature TVD via oracle_hydraulics.tvd_of),
friction (oracle_hydraulics.element_loss, the shared D2 method spec) and
beam/spring algebra below are written in independent numpy/python code from
the shared spec. A hand-built VERTICAL fixture with no rheology asserts the
closed forms (cylinder volumes, achieved TOC, U-tube differential equal to
the density-difference integral) BEFORE anything is written.

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_cementing.py
"""
import math

from oracle_torquedrag import WELLS, rnd, write  # noqa: F401
from oracle_hydraulics import tvd_of, element_loss, fit_models  # noqa: F401

G = 9.80665
IN = 0.0254
E_STEEL = 206.8e9


# ---------------------------------------------------------------- geometry

def annulus_rows(hole_sections, casing, excess_pct=0.0):
    rows = []
    cuts = {0.0, casing['shoeMd']}
    for s in hole_sections:
        if s['from_md_m'] < casing['shoeMd']:
            cuts.add(max(0.0, s['from_md_m']))
        if s['to_md_m'] < casing['shoeMd']:
            cuts.add(max(0.0, s['to_md_m']))
    edges = sorted(cuts)
    for a, b in zip(edges, edges[1:]):
        if b - a < 1e-9:
            continue
        mid = (a + b) / 2
        sec = next(s for s in hole_sections if s['from_md_m'] - 1e-9 <= mid <= s['to_md_m'] + 1e-9)
        bore = sec['casing_id_m'] if sec['cased'] else sec['hole_id_m']
        cap = math.pi / 4 * (bore ** 2 - casing['odM'] ** 2)
        open_hole = not sec['cased']
        if open_hole and excess_pct > 0:
            cap *= 1 + excess_pct / 100
        bore_eff = math.sqrt(cap * 4 / math.pi + casing['odM'] ** 2)
        rows.append({'fromMd': a, 'toMd': b, 'capM2': cap, 'boreIdEffM': bore_eff,
                     'openHole': open_hole})
    return rows


def vol_between(rows, a, b):
    return sum(max(0.0, min(b, r['toMd']) - max(a, r['fromMd'])) * r['capM2'] for r in rows)


def job_volumes(stations, hole_sections, casing, toc, excess_pct, spacer_v,
                yield_per_sack, split_md, rate):
    ann = annulus_rows(hole_sections, casing, excess_pct)
    cap_in = math.pi / 4 * casing['idM'] ** 2
    fc = casing['floatCollarMd']
    ann_slurry = vol_between(ann, toc, casing['shoeMd'])
    shoe_track = cap_in * (casing['shoeMd'] - fc)
    slurry = ann_slurry + shoe_track
    lead = vol_between(ann, toc, split_md) if split_md is not None else 0.0
    tail = slurry - lead
    disp = cap_in * fc
    out = {'annularSlurryM3': ann_slurry, 'shoeTrackM3': shoe_track, 'slurryM3': slurry,
           'leadM3': lead, 'tailM3': tail, 'spacerVolM3': spacer_v,
           'displacementM3': disp, 'totalPumpedM3': spacer_v + slurry + disp,
           'tvdShoeM': tvd_of(stations, casing['shoeMd']),
           'tvdTocM': tvd_of(stations, toc)}
    if yield_per_sack:
        out['sacks'] = slurry / yield_per_sack
    if rate:
        out['jobTimeS'] = out['totalPumpedM3'] / rate
    return out, ann, cap_in


# ---------------------------------------------------------------- placement

def fluid_intervals(V, fluids, mud, v_path):
    fronts = []
    before = 0.0
    for f in fluids:
        fronts.append(min(max(V - before, 0.0), v_path))
        before += f['volumeM3']
    out = []
    if fronts[0] < v_path:
        out.append((fronts[0], v_path, mud))
    for i, f in enumerate(fluids):
        hi = fronts[i]
        lo = fronts[i + 1] if i + 1 < len(fronts) else 0.0
        if hi - lo > 1e-12:
            out.append((lo, hi, f))
    return out


def segments_for_leg(intervals, leg, cap_in, v_inside, ann_down, shoe_md):
    segs = []
    if leg == 'inside':
        for v0, v1, fl in intervals:
            a = max(v0, 0.0)
            b = min(v1, v_inside)
            if b - a > 1e-12:
                segs.append({'fromMd': a / cap_in, 'toMd': b / cap_in, 'fluid': fl,
                             'capM2': cap_in, 'boreIdEffM': None})
        return sorted(segs, key=lambda s: s['fromMd'])
    acc = v_inside
    for r in ann_down:
        rv = r['capM2'] * (r['toMd'] - r['fromMd'])
        r0, r1 = acc, acc + rv
        for v0, v1, fl in intervals:
            a = max(v0, r0)
            b = min(v1, r1)
            if b - a > 1e-12:
                md_hi = r['toMd'] - (a - r0) / r['capM2']
                md_lo = r['toMd'] - (b - r0) / r['capM2']
                segs.append({'fromMd': md_lo, 'toMd': md_hi, 'fluid': fl,
                             'capM2': r['capM2'], 'boreIdEffM': r['boreIdEffM']})
        acc = r1
    return sorted(segs, key=lambda s: s['fromMd'])


def simulate(stations, hole_sections, casing, mud, fluids, rate, toc,
             excess_pct, steps=60):
    ann = annulus_rows(hole_sections, casing, excess_pct)
    ann_down = sorted(ann, key=lambda r: -r['toMd'])
    cap_in = math.pi / 4 * casing['idM'] ** 2
    v_inside = cap_in * casing['shoeMd']
    v_ann = sum(r['capM2'] * (r['toMd'] - r['fromMd']) for r in ann)
    v_path = v_inside + v_ann
    v_total = sum(f['volumeM3'] for f in fluids)
    cased = [s for s in hole_sections if s['cased'] and s['to_md_m'] <= casing['shoeMd'] + 1e-9]
    prev_shoe = max(s['to_md_m'] for s in cased) if cased else None
    tvd_shoe = tvd_of(stations, casing['shoeMd'])
    tvd_prev = tvd_of(stations, prev_shoe) if prev_shoe else None

    def head(segs):
        return sum(s['fluid']['densityKgM3'] * G
                   * (tvd_of(stations, s['toMd']) - tvd_of(stations, s['fromMd']))
                   for s in segs)

    def fric(segs, leg):
        tot = 0.0
        for s in segs:
            model = s['fluid'].get('rheology')
            if not model:
                continue
            if leg == 'inside':
                v = rate / cap_in
                tot += element_loss(model, s['fluid']['densityKgM3'], v,
                                    casing['idM'], 'pipe', s['toMd'] - s['fromMd'])
            else:
                v = rate / s['capM2']
                tot += element_loss(model, s['fluid']['densityKgM3'], v,
                                    s['boreIdEffM'] - casing['odM'], 'annulus',
                                    s['toMd'] - s['fromMd'])
        return tot

    series = []
    free_any = False
    max_ecd = 0.0
    for k in range(steps + 1):
        V = k / steps * v_total
        iv = fluid_intervals(V, fluids, mud, v_path)
        inside = segments_for_leg(iv, 'inside', cap_in, v_inside, ann_down, casing['shoeMd'])
        annulus = segments_for_leg(iv, 'annulus', cap_in, v_inside, ann_down, casing['shoeMd'])
        raw = head(annulus) + fric(inside, 'inside') + fric(annulus, 'annulus') - head(inside)
        free = raw < -1.0  # 1 Pa deadband (float residue is not free fall)
        free_any = free_any or free
        ecd_prev = None
        if prev_shoe and tvd_prev and tvd_prev > 0:
            above = [dict(s, toMd=min(s['toMd'], prev_shoe)) for s in annulus
                     if min(s['toMd'], prev_shoe) > s['fromMd']]
            ecd_prev = (head(above) + fric(above, 'annulus')) / (G * tvd_prev)
            max_ecd = max(max_ecd, ecd_prev)
        ecd_td = (head(annulus) + fric(annulus, 'annulus')) / (G * tvd_shoe) if tvd_shoe > 0 else None
        series.append({'pumpedM3': V, 'pumpPressurePa': max(0.0, raw), 'uTubePa': raw,
                       'freeFall': free, 'ecdPrevShoeKgM3': ecd_prev,
                       'ecdAtShoeKgM3': ecd_td})
    iv = fluid_intervals(v_total, fluids, mud, v_path)
    end_ann = segments_for_leg(iv, 'annulus', cap_in, v_inside, ann_down, casing['shoeMd'])
    end_in = segments_for_leg(iv, 'inside', cap_in, v_inside, ann_down, casing['shoeMd'])
    tops = [s['fromMd'] for s in end_ann if s['fluid'].get('kind') in ('lead', 'tail')]
    toc_achieved = min(tops) if tops else None
    float_diff = head(end_ann) - head(end_in)
    return {'series': series, 'endPumpPressurePa': series[-1]['pumpPressurePa'],
            'maxEcdPrevShoeKgM3': max_ecd or None, 'achievedTocMd': toc_achieved,
            'floatDiffPa': float_diff, 'freeFall': free_any}


# ---------------------------------------------------------------- standoff

def inc_at(stations, md):
    for (m1, i1, _), (m2, i2, _) in zip(stations, stations[1:]):
        if md <= m2:
            if md <= m1:
                return i1
            return i1 + (i2 - i1) * (md - m1) / (m2 - m1)
    return stations[-1][1]


def standoff_profile(stations, hole_sections, casing, rho_mud, cent, interval=30.0):
    ann = annulus_rows(hole_sections, casing, 0.0)
    bf = 1 - rho_mud / 7850.0
    w_air = casing.get('weightKgM') or math.pi / 4 * (casing['odM'] ** 2 - casing['idM'] ** 2) * 7850
    w_buoy = w_air * G * bf
    inertia = math.pi / 64 * (casing['odM'] ** 4 - casing['idM'] ** 4)
    ei = E_STEEL * inertia
    rows = []
    min_so = 1.0
    for r in ann:
        top = r['fromMd']
        while top < r['toMd'] - 1e-9:
            bottom = min(top + interval, r['toMd'])
            mid = (top + bottom) / 2
            inc = inc_at(stations, min(mid, stations[-1][0]))
            sin_i = math.sin(math.radians(inc))
            clr = (r['boreIdEffM'] - casing['odM']) / 2
            if cent.get('type', 'bow') == 'rigid':
                blade = cent.get('bladeOdM') or r['boreIdEffM'] - 0.01
                at_cent = min(1.0, max(0.0, (blade - casing['odM']) / (r['boreIdEffM'] - casing['odM'])))
            else:
                k = cent['restoringForceN'] / ((1 - cent.get('standoffAtRestoringForce', 0.67)) * clr)
                W = w_buoy * cent['spacingM'] * sin_i
                defl = min(clr, W / k)
                at_cent = (clr - defl) / clr
            sag = min(clr, w_buoy * sin_i * cent['spacingM'] ** 4 / (384 * ei))
            at_cent_defl = clr * (1 - at_cent)
            mid_so = max(0.0, (clr - at_cent_defl - sag) / clr)
            so = min(at_cent, mid_so)
            rows.append({'fromMd': top, 'toMd': bottom, 'incDeg': inc, 'standoff': so})
            min_so = min(min_so, so)
            top = bottom
    return {'rows': rows, 'minStandoff': min_so}


def required_spacing(stations, hole_sections, casing, rho_mud, cent,
                     target=0.67, lo=3.0, hi=30.0):
    def min_at(s):
        c = dict(cent)
        c['spacingM'] = s
        return standoff_profile(stations, hole_sections, casing, rho_mud, c)['minStandoff']
    if min_at(hi) >= target:
        return hi
    if min_at(lo) < target:
        return None
    for _ in range(40):
        mid = (lo + hi) / 2
        if min_at(mid) >= target:
            lo = mid
        else:
            hi = mid
    return lo


# ---------------------------------------------------------------- fixture

def vertical_fixture():
    stations = [(0.0, 0.0, 0.0), (2000.0, 0.0, 0.0)]
    hole = [
        {'from_md_m': 0.0, 'to_md_m': 1000.0, 'cased': True, 'casing_id_m': 8.681 * IN,
         'hole_id_m': 12.25 * IN},
        {'from_md_m': 1000.0, 'to_md_m': 2000.0, 'cased': False, 'hole_id_m': 8.5 * IN},
    ]
    casing = {'odM': 7 * IN, 'idM': 6.184 * IN, 'shoeMd': 2000.0,
              'floatCollarMd': 1960.0, 'hangerMd': 0, 'weightKgM': 43.16}
    toc = 800.0
    vols, ann, cap_in = job_volumes(stations, hole, casing, toc, 0.0, 3.0, None, None, None)
    # Closed-form assertions (no rheology → friction 0; vertical → TVD = MD).
    assert abs(vols['displacementM3'] - cap_in * 1960.0) < 1e-12
    assert abs(vols['shoeTrackM3'] - cap_in * 40.0) < 1e-12
    exp_ann = (vol_between(ann, 800.0, 1000.0) + vol_between(ann, 1000.0, 2000.0))
    assert abs(vols['annularSlurryM3'] - exp_ann) < 1e-12
    mud = {'kind': 'mud', 'densityKgM3': 1440.0}
    fluids = [
        {'kind': 'spacer', 'densityKgM3': 1500.0, 'volumeM3': 3.0},
        {'kind': 'tail', 'densityKgM3': 1900.0, 'volumeM3': vols['slurryM3']},
        {'kind': 'displacement', 'densityKgM3': 1440.0, 'volumeM3': vols['displacementM3']},
    ]
    res = simulate(stations, hole, casing, mud, fluids, 0.02, toc, 0.0)
    # Achieved TOC hits the target exactly (volumes were built from it).
    assert abs(res['achievedTocMd'] - toc) < 1e-6
    # End U-tube differential closed form: annulus vs inside columns.
    spacer_h = 3.0 / ann[0]['capM2']  # spacer sits just above TOC (cased cap)
    ann_head = (1440.0 * (toc - spacer_h) + 1500.0 * spacer_h
                + 1900.0 * (2000.0 - toc)) * G
    in_head = (1440.0 * 1960.0 + 1900.0 * 40.0) * G
    assert abs(res['floatDiffPa'] - (ann_head - in_head)) < 1.0
    assert abs(res['endPumpPressurePa'] - max(0.0, ann_head - in_head)) < 1.0
    return {
        'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
        'holeSections': hole, 'casing': casing, 'tocMd': toc,
        'mudInHole': mud, 'fluids': fluids, 'pumpRateM3s': 0.02,
        'volumes': vols,
        'placement': {'achievedTocMd': res['achievedTocMd'],
                      'floatDiffPa': res['floatDiffPa'],
                      'endPumpPressurePa': res['endPumpPressurePa'],
                      'freeFall': res['freeFall']},
    }


# ---------------------------------------------------------------- cases

FANN_MUD = {'theta600': 64, 'theta300': 38, 'theta6': 7, 'theta3': 6}
FANN_SPACER = {'theta600': 40, 'theta300': 24, 'theta6': 4, 'theta3': 3}
FANN_LEAD = {'theta600': 80, 'theta300': 50, 'theta6': 10, 'theta3': 8}
FANN_TAIL = {'theta600': 110, 'theta300': 70, 'theta6': 15, 'theta3': 12}


def hb(fann):
    return fit_models(fann['theta600'], fann['theta300'], fann.get('theta6'),
                      fann.get('theta3'))['herschelBulkley']


def main():
    fixture = vertical_fixture()
    cases = []
    for wname in ['slant', 'horizontal']:
        stations, shoe_prev, td = WELLS[wname]
        hole = [
            {'from_md_m': 0.0, 'to_md_m': shoe_prev, 'cased': True,
             'casing_id_m': 8.681 * IN, 'hole_id_m': 12.25 * IN},
            {'from_md_m': shoe_prev, 'to_md_m': td, 'cased': False, 'hole_id_m': 8.5 * IN},
        ]
        casing = {'odM': 7 * IN, 'idM': 6.184 * IN, 'shoeMd': td,
                  'floatCollarMd': td - 40.0, 'hangerMd': 0, 'weightKgM': 43.16}
        toc = shoe_prev - 200.0
        excess = 15.0
        vols, ann, cap_in = job_volumes(stations, hole, casing, toc, excess, 4.0,
                                        0.0382, shoe_prev, 0.02)
        mud = {'kind': 'mud', 'densityKgM3': 1440.0, 'rheology': hb(FANN_MUD)}
        programs = {
            'lead_tail': [
                {'kind': 'spacer', 'densityKgM3': 1500.0, 'volumeM3': 4.0, 'rheology': hb(FANN_SPACER)},
                {'kind': 'lead', 'densityKgM3': 1560.0, 'volumeM3': vols['leadM3'], 'rheology': hb(FANN_LEAD)},
                {'kind': 'tail', 'densityKgM3': 1900.0, 'volumeM3': vols['tailM3'], 'rheology': hb(FANN_TAIL)},
                {'kind': 'displacement', 'densityKgM3': 1440.0, 'volumeM3': vols['displacementM3'], 'rheology': hb(FANN_MUD)},
            ],
            'neat': [
                {'kind': 'tail', 'densityKgM3': 1900.0, 'volumeM3': vols['slurryM3'], 'rheology': hb(FANN_TAIL)},
                {'kind': 'displacement', 'densityKgM3': 1440.0, 'volumeM3': vols['displacementM3'], 'rheology': hb(FANN_MUD)},
            ],
        }
        expected_programs = {}
        for name, fluids in programs.items():
            res = simulate(stations, hole, casing, mud, fluids, 0.02, toc, excess)
            expected_programs[name] = {
                'checkpoints': [res['series'][i] for i in range(0, 61, 10)],
                'endPumpPressurePa': res['endPumpPressurePa'],
                'maxEcdPrevShoeKgM3': res['maxEcdPrevShoeKgM3'],
                'achievedTocMd': res['achievedTocMd'],
                'floatDiffPa': res['floatDiffPa'],
                'freeFall': res['freeFall'],
            }
        cent = {'type': 'bow', 'spacingM': 12.0, 'restoringForceN': 8900.0,
                'standoffAtRestoringForce': 0.67}
        so = standoff_profile(stations, hole, casing, 1440.0, cent)
        req = required_spacing(stations, hole, casing, 1440.0, cent)
        cases.append({
            'well': wname,
            'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
            'holeSections': hole,
            'casing': casing,
            'tocMd': toc,
            'excessOpenHolePct': excess,
            'leadTailSplitMd': shoe_prev,
            'pumpRateM3s': 0.02,
            'slurryYieldM3PerSack': 0.0382,
            'mudFann': FANN_MUD,
            'spacerFann': FANN_SPACER,
            'leadFann': FANN_LEAD,
            'tailFann': FANN_TAIL,
            'centralizer': cent,
            'expected': {
                'volumes': vols,
                'programs': expected_programs,
                'standoff': {'minStandoff': so['minStandoff'],
                             'rows10': so['rows'][::10]},
                'requiredSpacingM': req,
            },
        })
    write('cementing_cases.json', {
        'description': 'Cementing oracle: independent plug-flow volume-interval '
                       'bookkeeping, exact-TVD hydrostatics, D2 loss kernel '
                       'friction, API 10D standoff. JS engine must agree rtol '
                       '1e-6. verticalFixture closed forms are self-asserted.',
        'verticalFixture': fixture,
        'cases': cases,
    })


if __name__ == '__main__':
    main()
