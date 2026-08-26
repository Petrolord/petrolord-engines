#!/usr/bin/env python3
"""Independent oracle for the well control engine (Drilling D3): well
volumes/strokes, kill sheet, MAASP and kick tolerance. Emits
test-data/drilling/goldens/wellcontrol_cases.json.

Independence discipline: volumes come from this file's OWN span walk over
the string/geometry definitions (not the JS element builder), TVDs from the
planar minimum-curvature integral (oracle_hydraulics.tvd_of), and every
kill-sheet/kick-tolerance number from the formulas as published in the
IWCF/IADC kill-sheet convention. The file also contains a hand-constructed
IWCF-style vertical example with clean numbers whose closed-form identities
are ASSERTED here before anything is written (self-asserting fixture, the
ade_ch8 pattern).

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_wellcontrol.py
"""
import math

from oracle_torquedrag import WELLS, string_for, geometry_for, rnd, write  # noqa: F401
from oracle_hydraulics import tvd_of  # noqa: F401

G = 9.80665


# ---------------------------------------------------------------- volumes

def spans(string, bit_md):
    out = []
    dist = 0.0
    for c in string:
        bottom = bit_md - dist
        top = max(0.0, bottom - c['lengthM'])
        out.append((top, bottom, c))
        dist += c['lengthM']
        if top <= 0:
            break
    return list(reversed(out))


def volumes(stations, string, geometry):
    td = stations[-1][0]
    total = sum(c['lengthM'] for c in string)
    bit_md = min(total, td)
    string_vol = 0.0
    for top, bottom, c in spans(string, bit_md):
        string_vol += math.pi / 4 * c['idM'] ** 2 * (bottom - top)
    # annulus: split component spans at section boundaries
    ann_rows = []
    ann_vol = 0.0
    cuts = {0.0, bit_md}
    for top, bottom, _ in spans(string, bit_md):
        cuts.add(top)
        cuts.add(bottom)
    for g in geometry:
        if g['fromMd'] < bit_md:
            cuts.add(max(0.0, g['fromMd']))
        if g['toMd'] < bit_md:
            cuts.add(max(0.0, g['toMd']))
    edges = sorted(x for x in cuts if 0.0 <= x <= bit_md)
    for a, b in zip(edges, edges[1:]):
        if b - a < 1e-9:
            continue
        mid = (a + b) / 2
        comp = next((c for t, bo, c in spans(string, bit_md) if t <= mid <= bo), None)
        sec = next((g for g in geometry if g['fromMd'] - 1e-9 <= mid <= g['toMd'] + 1e-9), None)
        if comp is None or sec is None:
            continue
        cap = math.pi / 4 * (sec['holeIdM'] ** 2 - comp['odM'] ** 2)
        ann_vol += cap * (b - a)
        ann_rows.append({'fromMd': a, 'toMd': b, 'capM2': cap, 'volM3': cap * (b - a)})
    return {'bitMd': bit_md, 'stringVolumeM3': string_vol,
            'annulusVolumeM3': ann_vol, 'annulusRows': ann_rows}


def cap_at(rows, md):
    for r in rows:
        if r['fromMd'] - 1e-9 <= md <= r['toMd'] + 1e-9:
            return r['capM2']
    return rows[-1]['capM2']


# ---------------------------------------------------------------- kill sheet

def kill_sheet(tvd_bh, tvd_shoe, rho, sidpp, sicp, pit_gain, scr, output,
               v_string, v_ann, cap_bit, steps=10):
    pf = rho * G * tvd_bh + sidpp
    kmw = rho + sidpp / (G * tvd_bh)
    icp = scr + sidpp
    fcp = scr * kmw / rho
    stb = v_string / output
    bus = v_ann / output
    schedule = [{'strokes': i / steps * stb, 'pressurePa': icp + i / steps * (fcp - icp)}
                for i in range(steps + 1)]
    influx = None
    if sicp is not None and pit_gain > 0 and cap_bit > 0:
        h = pit_gain / cap_bit
        grad = rho - (sicp - sidpp) / (G * h)
        kind = 'gas' if grad < 480 else ('liquid' if grad > 960 else 'mixed')
        influx = {'heightM': h, 'densityKgM3': grad, 'kind': kind}
    return {'formationPressurePa': pf, 'killMudDensityKgM3': kmw,
            'icpPa': icp, 'fcpPa': fcp, 'strokesToBit': stb,
            'bottomsUpStrokes': bus, 'totalStrokes': stb + bus,
            'schedule': schedule, 'influx': influx}


def kick_tolerance(tvd_bh, tvd_shoe, rho, frac_emw, ki, rho_i, cap_shoe, cap_bit):
    pf = (rho + ki) * G * tvd_bh
    p_frac = frac_emw * G * tvd_shoe
    maasp = max(0.0, (frac_emw - rho) * G * tvd_shoe)
    headroom = p_frac - (pf - rho * G * (tvd_bh - tvd_shoe))
    d_rho = (rho - rho_i) * G
    h_max = max(0.0, headroom / d_rho)
    shut_in = h_max * cap_bit
    h_shoe = min(h_max, max(0.0, tvd_bh - tvd_shoe))
    v_shoe = h_shoe * cap_shoe
    p_shoe = pf - rho * G * (tvd_bh - tvd_shoe) + (rho - rho_i) * G * h_shoe
    at_shoe = p_shoe * v_shoe / pf if p_shoe > 0 else 0.0
    return {'maaspPa': maasp, 'formationPressurePa': pf, 'headroomPa': headroom,
            'cases': {'shutInM3': shut_in, 'atShoeM3': at_shoe},
            'kickToleranceM3': max(0.0, min(shut_in, at_shoe))}


# ---------------------------------------------------------------- IWCF-style fixture

def iwcf_fixture():
    """Hand-constructed vertical example with clean numbers; identities
    asserted before writing (self-asserting, the ade_ch8 pattern)."""
    tvd = 3000.0
    shoe = 2000.0
    rho = 1200.0
    sidpp = 3.0e6
    sicp = 3.6e6
    scr = 5.0e6
    output = 0.01                  # m3/stroke
    v_string = 40.0
    v_ann = 120.0
    cap_bit = 0.02                 # m2
    ks = kill_sheet(tvd, shoe, rho, sidpp, sicp, 4.0, scr, output,
                    v_string, v_ann, cap_bit)
    # Closed-form identities:
    assert abs(ks['killMudDensityKgM3'] - (1200.0 + 3.0e6 / (G * 3000.0))) < 1e-9
    assert abs(ks['icpPa'] - 8.0e6) < 1e-9
    assert abs(ks['fcpPa'] - scr * ks['killMudDensityKgM3'] / rho) < 1e-6
    assert abs(ks['strokesToBit'] - 4000.0) < 1e-9
    assert abs(ks['bottomsUpStrokes'] - 12000.0) < 1e-9
    # influx: h = 4/0.02 = 200 m; grad = 1200 - 0.6e6/(9.80665*200) = 894.1... mixed
    assert ks['influx']['kind'] == 'mixed'
    frac_emw = 1700.0
    kt = kick_tolerance(tvd, shoe, rho, frac_emw, 60.0, 240.0, 0.025, 0.02)
    assert abs(kt['maaspPa'] - (frac_emw - rho) * G * shoe) < 1e-6
    assert kt['kickToleranceM3'] > 0
    return {
        'inputs': {'tvdBhM': tvd, 'tvdShoeM': shoe, 'mudDensityKgM3': rho,
                   'sidppPa': sidpp, 'sicpPa': sicp, 'pitGainM3': 4.0,
                   'scrPressurePa': scr, 'pumpOutputM3PerStroke': output,
                   'stringVolumeM3': v_string, 'annulusVolumeM3': v_ann,
                   'annulusCapNearBitM2': cap_bit,
                   'fracEmwKgM3': frac_emw, 'kickIntensityKgM3': 60.0,
                   'influxDensityKgM3': 240.0, 'annulusCapAtShoeM2': 0.025,
                   'annulusCapAtBitM2': 0.02},
        'killSheet': ks,
        'kickTolerance': kt,
    }


# ---------------------------------------------------------------- cases

KICKS = [
    {'name': 'moderate_gas', 'sidppPa': 2.0e6, 'sicpPa': 2.9e6, 'pitGainM3': 3.0},
    {'name': 'small_liquid', 'sidppPa': 0.8e6, 'sicpPa': 0.9e6, 'pitGainM3': 1.5},
]


def main():
    cases = []
    for wname in ['slant', 'horizontal']:
        stations, shoe_md, td = WELLS[wname]
        string = string_for(td)
        geometry = geometry_for(shoe_md, td)
        vol = volumes(stations, string, geometry)
        tvd_bh = tvd_of(stations, vol['bitMd'])
        tvd_shoe = tvd_of(stations, shoe_md)
        cap_bit = cap_at(vol['annulusRows'], vol['bitMd'] - 1.0)
        cap_shoe = cap_at(vol['annulusRows'], shoe_md - 1.0)
        rho = 1440.0
        kicks = {}
        for k in KICKS:
            kicks[k['name']] = kill_sheet(
                tvd_bh, tvd_shoe, rho, k['sidppPa'], k['sicpPa'], k['pitGainM3'],
                4.5e6, 0.012, vol['stringVolumeM3'], vol['annulusVolumeM3'], cap_bit)
        kt = kick_tolerance(tvd_bh, tvd_shoe, rho, 1750.0, 60.0, 240.0, cap_shoe, cap_bit)
        sweep = [{'mudDensityKgM3': r,
                  'kickToleranceM3': kick_tolerance(tvd_bh, tvd_shoe, r, 1750.0, 60.0,
                                                    240.0, cap_shoe, cap_bit)['kickToleranceM3']}
                 for r in [1200.0, 1320.0, 1440.0, 1560.0, 1680.0]]
        cases.append({
            'well': wname,
            'shoeMd': shoe_md,
            'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
            'string': string,
            'geometry': geometry,
            'mudDensityKgM3': rho,
            'pump': {'outputM3PerStroke': 0.012, 'scrPressurePa': 4.5e6},
            'fracEmwKgM3': 1750.0,
            'expected': {
                'volumes': {'bitMd': vol['bitMd'],
                            'stringVolumeM3': vol['stringVolumeM3'],
                            'annulusVolumeM3': vol['annulusVolumeM3'],
                            'tvdBhM': tvd_bh, 'tvdShoeM': tvd_shoe,
                            'capBitM2': cap_bit, 'capShoeM2': cap_shoe},
                'killSheets': kicks,
                'kickTolerance': kt,
                'ktSweep': sweep,
            },
        })
    write('wellcontrol_cases.json', {
        'description': 'Well control oracle: independent span-walk volumes, '
                       'IWCF-convention kill sheet, MAASP and single-bubble '
                       'kick tolerance. JS engine must agree rtol 1e-6. '
                       'iwcfStyleExample is hand-constructed with clean '
                       'numbers and self-asserted closed forms.',
        'iwcfStyleExample': iwcf_fixture(),
        'cases': cases,
    })


if __name__ == '__main__':
    main()
