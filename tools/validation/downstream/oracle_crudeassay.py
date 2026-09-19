#!/usr/bin/env python3
"""Oracle for engines/downstream/crudeAssay.js (MD1-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. BLENDS ARE CARGOES. The engine works in fractions. This file loads a tank:
    each crude is a number of BARRELS, each barrel weighs SG x 350.16 lb, each
    pound of crude carries its weight percent of sulfur, and the blend's sulfur
    is pounds of sulfur over pounds of crude. The blend's gravity is its total
    pounds over the pounds the same barrels of water would weigh. Nothing here
    ever forms a mass fraction the way resolveFractions does.
 2. VISCOSITY is blended through the Refutas index and INVERTED BY BISECTION;
    the engine uses the closed-form double exponential.
 3. CUT YIELDS come from a SEGMENT-OVERLAP SUM: each measured segment of the
    TBP curve contributes its volume in proportion to how much of its
    temperature span falls inside the cut. The engine takes differences of an
    interpolated cumulative curve. The two agree only if both are right.
 4. THE BLENDED CURVE is formed from barrels distilled, crude by crude, and its
    50 percent point is found by BISECTION on that curve; the engine inverts
    its piecewise-linear curve directly.
 5. NETBACK is a whole-cargo account: 100,000 barrels of crude become product
    barrels, product dollars, dollars lost, dollars paid, and the netback is
    what is left per barrel of crude.

 6. WHAT CANNOT BE VALIDATED BY COMPARISON, and is PINNED in the jest gate:
    the API definition 141.5 / (API + 131.5), the Refutas pair 14.534 and
    10.975, the Watson form Tb^(1/3)/SG in degrees Rankine, and the CII bands
    0.7 and 0.9. They are definitions or held screening values, typed here and
    in the engine alike.

THE CURVE RULE THIS FILE HOLDS THE ENGINE TO. Outside the measured points a
distillation curve says nothing, except that below a first point at 0 percent
nothing has distilled and above a last point at 100 percent everything has. A
cut bound anywhere else outside the curve has NO yield; the engine used to
clamp the curve flat there, and gave that slice's barrels to its neighbour.

The crudes are ILLUSTRATIVE. The first blend is the Suite's own default pair
(src/contexts/CrudeAssayContext.jsx), labelled there as examples, because that
is what a user sees with nothing typed.

stdlib only. Writes test-data/downstream/goldens/crudeassay_cases.json
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'crudeassay_cases.json')

LB_PER_BBL_WATER_60F = 350.16   # cancels in every ratio; stated so the inventory is physical
REFUTAS_A, REFUTAS_B = 14.534, 10.975
CII_STABLE, CII_UNSTABLE = 0.7, 0.9


def sg_from_api(api):
    return 141.5 / (api + 131.5)


def api_from_sg(sg):
    return 141.5 / sg - 131.5


def refutas(nu):
    return REFUTAS_A * math.log(math.log(nu + 0.8)) + REFUTAS_B


def refutas_inverse(index):
    lo, hi = 0.2000001, 1e9
    for _ in range(400):
        mid = math.sqrt(lo * hi)
        if refutas(mid) < index:
            lo = mid
        else:
            hi = mid
    return math.sqrt(lo * hi)


# ---------------------------------------------------------------- blends ----

MASS_KEYS = ['sulfurWtPct', 'tanMgKohG', 'nitrogenWtPct', 'nickelPpm', 'vanadiumPpm']


def blend_cargo(crudes, barrels):
    lb = [b * sg_from_api(c['api']) * LB_PER_BBL_WATER_60F for c, b in zip(crudes, barrels)]
    total_lb = sum(lb)
    total_bbl = sum(barrels)
    sg = total_lb / (total_bbl * LB_PER_BBL_WATER_60F)
    props = {'sg': sg, 'api': api_from_sg(sg)}
    for k in MASS_KEYS:
        if all(k in c for c in crudes):
            # pounds of the property carrier over pounds of crude
            props[k] = sum(w * c[k] for w, c in zip(lb, crudes)) / total_lb
        else:
            props[k] = None
    if all('viscosityCSt' in c for c in crudes):
        idx = sum(w * refutas(c['viscosityCSt']) for w, c in zip(lb, crudes)) / total_lb
        props['viscosityCSt'] = refutas_inverse(idx)
    else:
        props['viscosityCSt'] = None
    out = {
        'properties': props,
        'volumeFractions': [b / total_bbl for b in barrels],
        'massFractions': [w / total_lb for w in lb],
    }
    if all('sara' in c for c in crudes):
        sara = {k: sum(w * c['sara'][k] for w, c in zip(lb, crudes)) / total_lb
                for k in ('saturates', 'aromatics', 'resins', 'asphaltenes')}
        cii = (sara['saturates'] + sara['asphaltenes']) / (sara['aromatics'] + sara['resins'])
        out['sara'] = sara
        out['cii'] = cii
        out['stable'] = True if cii < CII_STABLE else (None if cii < CII_UNSTABLE else False)
    return out


# ----------------------------------------------------------------- curves ---

def points(curve):
    return sorted((p['temperatureF'], p['volumePercent']) for p in curve)


def cumulative(curve, t):
    """Volume percent distilled at t, by summing segment overlaps; None if unknown."""
    pts = points(curve)
    (t0, v0), (tn, vn) = pts[0], pts[-1]
    if t < t0:
        return 0.0 if v0 == 0 else None
    if t > tn:
        return 100.0 if vn == 100 else None
    total = v0
    for (ta, va), (tb, vb) in zip(pts, pts[1:]):
        if t <= ta:
            break
        span = tb - ta
        covered = min(t, tb) - ta
        total += (vb - va) * (covered / span if span > 0 else 1.0)
    return total


def cut_yield(curve, lo, hi):
    """Barrels of the cut per 100 of crude; None when a bound is outside what the curve says."""
    if lo is not None and hi is not None and hi < lo:
        return None
    top = 100.0 if hi is None else cumulative(curve, hi)
    bottom = 0.0 if lo is None else cumulative(curve, lo)
    if top is None or bottom is None:
        return None
    return top - bottom


def blended_curve(crudes, barrels):
    temps = sorted({p['temperatureF'] for c in crudes for p in c['curve']})
    total = sum(barrels)
    out = []
    for t in temps:
        distilled = 0.0
        known = True
        for c, b in zip(crudes, barrels):
            if b <= 0:
                continue
            v = cumulative(c['curve'], t)
            if v is None:
                known = False
                break
            distilled += b * v / 100.0   # barrels of this crude boiled off by t
        if known:
            out.append({'temperatureF': t, 'volumePercent': 100.0 * distilled / total})
    return out


def t_at(curve_pts, target):
    """Temperature at a volume percent, by bisection on the piecewise curve."""
    curve = [{'temperatureF': p['temperatureF'], 'volumePercent': p['volumePercent']} for p in curve_pts]
    lo, hi = curve[0]['temperatureF'], curve[-1]['temperatureF']
    if not (curve[0]['volumePercent'] <= target <= curve[-1]['volumePercent']):
        return None
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if cumulative(curve, mid) < target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def watson_k(tb_f, sg):
    return (tb_f + 459.67) ** (1.0 / 3.0) / sg


# ---------------------------------------------------------------- netback --

def netback_cargo(yields, prices, processing, freight, loss_pct, cargo_bbl=100000.0):
    product_bbl = {k: cargo_bbl * y / 100.0 for k, y in yields.items() if y is not None}
    dollars = sum(product_bbl[k] * prices[k] for k in product_bbl if k in prices)
    lost = dollars * loss_pct / 100.0
    paid = cargo_bbl * (processing + freight)
    return {'grossValue': dollars / cargo_bbl, 'lossValue': lost / cargo_bbl,
            'netback': (dollars - lost - paid) / cargo_bbl}


# ------------------------------------------------------------------ cases --

LIGHT = {'name': 'Light sweet (example)', 'api': 35.4, 'sulfurWtPct': 0.15, 'tanMgKohG': 0.30,
         'nitrogenWtPct': 0.10, 'nickelPpm': 5, 'vanadiumPpm': 1, 'viscosityCSt': 5,
         'curve': [{'volumePercent': v, 'temperatureF': t} for v, t in
                   [(0, 80), (10, 210), (30, 400), (50, 560), (70, 760), (90, 1080), (100, 1400)]]}
SOUR = {'name': 'Medium sour (example)', 'api': 24.0, 'sulfurWtPct': 2.20, 'tanMgKohG': 0.45,
        'nitrogenWtPct': 0.22, 'nickelPpm': 22, 'vanadiumPpm': 60, 'viscosityCSt': 45,
        'curve': [{'volumePercent': v, 'temperatureF': t} for v, t in
                  [(0, 100), (10, 300), (30, 520), (50, 690), (70, 900), (90, 1250), (100, 1500)]]}
DEFAULT_CUTS = [
    {'id': 'lpg', 'name': 'LPG / Light ends', 'fromF': None, 'toF': 90},
    {'id': 'naphtha', 'name': 'Naphtha', 'fromF': 90, 'toF': 350},
    {'id': 'kerosene', 'name': 'Kerosene / Jet', 'fromF': 350, 'toF': 500},
    {'id': 'diesel', 'name': 'Diesel / Gasoil', 'fromF': 500, 'toF': 650},
    {'id': 'vgo', 'name': 'Vacuum gasoil', 'fromF': 650, 'toF': 1000},
    {'id': 'residue', 'name': 'Vacuum residue', 'fromF': 1000, 'toF': None},
]
DEFAULT_PRICES = {'lpg': 55, 'naphtha': 78, 'kerosene': 96, 'diesel': 101, 'vgo': 72, 'residue': 44}

TRUNCATED = {'name': 'Truncated assay', 'api': 30.0, 'sulfurWtPct': 0.9,
             'curve': [{'volumePercent': v, 'temperatureF': t} for v, t in
                       [(5, 120), (25, 380), (50, 600), (70, 780), (85, 900)]]}

HEAVY_SARA = {'name': 'Heavy asphaltenic', 'api': 16.0, 'sulfurWtPct': 3.1,
              'sara': {'saturates': 32, 'aromatics': 38, 'resins': 18, 'asphaltenes': 12}}
LIGHT_PARAFFINIC = {'name': 'Paraffinic condensate', 'api': 52.0, 'sulfurWtPct': 0.02,
                    'sara': {'saturates': 88, 'aromatics': 10, 'resins': 1.8, 'asphaltenes': 0.2}}
AROMATIC = {'name': 'Aromatic medium', 'api': 28.0, 'sulfurWtPct': 1.1,
            'sara': {'saturates': 31, 'aromatics': 46, 'resins': 21, 'asphaltenes': 2}}


def blend_case(name, why, crudes, barrels, basis='volume'):
    res = blend_cargo(crudes, barrels)
    comps = []
    for c, b, mf in zip(crudes, barrels, res['massFractions']):
        comp = {k: v for k, v in c.items() if k != 'curve'}
        if basis == 'volume':
            comp['volumeFraction'] = b
        else:
            comp['massFraction'] = mf * 100.0
        comps.append(comp)
    return {'name': name, 'why': why, 'components': comps, **res}


def curve_case(name, why, crude, cuts):
    rows = [{'id': c['id'], 'yieldVolPercent': cut_yield(crude['curve'], c['fromF'], c['toF'])} for c in cuts]
    known = [r['yieldVolPercent'] for r in rows if r['yieldVolPercent'] is not None]
    return {'name': name, 'why': why, 'curve': crude['curve'], 'cuts': cuts, 'rows': rows,
            'unknownCount': sum(1 for r in rows if r['yieldVolPercent'] is None),
            'totalVolPercent': sum(known),
            'probes': [{'t': t, 'v': cumulative(crude['curve'], t)} for t in (50, 80, 100, 115, 120, 450, 900, 950, 1400, 1600)]}


def main():
    blends = [
        blend_case('Suite default pair, 60/40 by volume', 'what the Crude Assay studio blends with nothing typed',
                   [LIGHT, SOUR], [60000, 40000]),
        blend_case('20 and 40 API, 50/50', 'API does not blend linearly: 29.38, not 30',
                   [{'name': 'Twenty', 'api': 20.0, 'sulfurWtPct': 2.0},
                    {'name': 'Forty', 'api': 40.0, 'sulfurWtPct': 0.1}], [50000, 50000]),
        blend_case('three crudes given by mass', 'the mass route through resolveFractions',
                   [LIGHT, SOUR, {'name': 'Heavy', 'api': 18.0, 'sulfurWtPct': 3.4, 'tanMgKohG': 1.8,
                                  'nitrogenWtPct': 0.4, 'nickelPpm': 60, 'vanadiumPpm': 180, 'viscosityCSt': 900}],
                   [30000, 50000, 20000], basis='mass'),
        blend_case('heavy asphaltenic with a paraffinic condensate', 'the CII lands in the unstable band',
                   [HEAVY_SARA, LIGHT_PARAFFINIC], [55000, 45000]),
        blend_case('heavy asphaltenic with an aromatic medium', 'the CII lands in the uncertain band',
                   [HEAVY_SARA, AROMATIC], [85000, 15000]),
        blend_case('aromatic medium with a little condensate', 'the CII lands in the stable band',
                   [AROMATIC, LIGHT_PARAFFINIC], [90000, 10000]),
    ]

    curves = [
        curve_case('Light sweet on the default cuts', 'the studio default', LIGHT, DEFAULT_CUTS),
        curve_case('Medium sour on the default cuts', 'the studio default', SOUR, DEFAULT_CUTS),
        curve_case('truncated assay on the default cuts',
                   'starts at 5 percent and stops at 85: the LPG cut, the 900-1000 slice and the residue have no yield',
                   TRUNCATED, DEFAULT_CUTS),
        curve_case('truncated assay on cuts inside the curve', 'every bound inside the measured range',
                   TRUNCATED, [{'id': 'a', 'name': 'A', 'fromF': 120, 'toF': 380},
                               {'id': 'b', 'name': 'B', 'fromF': 380, 'toF': 700},
                               {'id': 'c', 'name': 'C', 'fromF': 700, 'toF': 900}]),
    ]

    bc = blended_curve([LIGHT, SOUR], [60000, 40000])
    t50 = t_at(bc, 50.0)
    sg_blend = blends[0]['properties']['sg']
    blended = {
        'name': 'Suite default pair, blended curve',
        'why': 'the curve, T50 and Watson K the studio shows; its own copy took T50 as the first grid point past 50',
        'curve': bc,
        't50F': t50,
        'watsonKAtT50': watson_k(t50, sg_blend),
        'appGridT50F': next(p['temperatureF'] for p in bc if p['volumePercent'] >= 50),
        'sg': sg_blend,
        'yields': [{'id': c['id'], 'yieldVolPercent': cut_yield(bc, c['fromF'], c['toF'])} for c in DEFAULT_CUTS],
    }
    yields = {r['id']: r['yieldVolPercent'] for r in blended['yields']}
    blended['netback'] = netback_cargo(yields, DEFAULT_PRICES, 4.5, 2.0, 0.5)
    blended['netbackInputs'] = {'prices': DEFAULT_PRICES, 'processingCostPerBbl': 4.5, 'freightPerBbl': 2.0,
                                'lossPercent': 0.5}

    truncated_blend = blended_curve([LIGHT, TRUNCATED], [50000, 50000])

    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_crudeassay.py',
            'method': 'cargo inventories in barrels and pounds; Refutas by bisection; yields by segment overlap; T50 by bisection',
            'engine': 'engines/downstream/crudeAssay.js',
            'published': 'none: every crude here is illustrative and every number follows from stated definitions',
            'heldConstants': {'refutasA': REFUTAS_A, 'refutasB': REFUTAS_B, 'ciiStable': CII_STABLE,
                              'ciiUnstable': CII_UNSTABLE},
        },
        'blends': blends,
        'curves': curves,
        'blendedDefault': blended,
        'blendedWithTruncated': {'curve': truncated_blend,
                                 'why': 'a temperature where the truncated crude says nothing is left out of the blend'},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('T50', round(t50, 3), 'app grid T50', blended['appGridT50F'], 'Kw', round(blended['watsonKAtT50'], 4))
    for b in blends:
        print(b['name'], round(b['properties']['api'], 4), b.get('cii') and round(b['cii'], 4), b.get('stable', '-'))
    for c in curves:
        print(c['name'], [r['yieldVolPercent'] and round(r['yieldVolPercent'], 3) for r in c['rows']])
    print('netback', blended['netback'])


if __name__ == '__main__':
    main()
