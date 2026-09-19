#!/usr/bin/env python3
"""Oracle for engines/downstream/productBlending.js (MD1-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. THE OPTIMUM. Every recipe is solved by exact rational vertex enumeration
    (oracle_lp.enumerate_optimum), never by a simplex. A least-cost recipe the
    engine returns is held to the cheapest feasible vertex that exists.
 2. THE ACHIEVED PROPERTIES are recomputed here from PHYSICAL INVENTORIES: the
    recipe's barrels become cubic metres and kilograms of each stream, sulfur
    becomes kilograms of sulfur, and the blend's sulfur is kilograms over
    kilograms. The engine forms the same ratios from fractions; this file never
    sees a fraction.
 3. THE VALUE OF RELIEF on each specification is found by RE-SOLVING the whole
    problem with the limit moved by a small exact step either way. The engine
    now derives the same number from its row dual by the envelope theorem;
    nothing of that derivation is used here. The two meet only in the answer.

 4. WHAT IS SHARED AND CANNOT BE VALIDATED BY COMPARISON: the linear form of a
    ratio constraint. {v : sum(w_i v_i) / sum(d_i v_i) <= L} IS the half-space
    sum((w_i - L d_i) v_i) <= 0 for positive denominators; there is no second
    way to write it as an LP row. And the held constants: the RVP index
    exponent 1.25 and the Refutas pair 14.534 / 10.975 are typed here and in
    the engine, so they are PINNED against literals in the jest gate, not
    validated by this file.

The component pools are ILLUSTRATIVE. The first case is the Suite's own
default gasoline pool (src/contexts/BlendOptimizerContext.jsx), because that
is what a user sees with nothing typed. The spec limits are the engine's own
SPEC_TEMPLATES, which the app labels as starting shapes, not regulation.

stdlib only. Writes test-data/downstream/goldens/productblending_cases.json
"""

import json
import math
import os
import sys
from fractions import Fraction as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle_lp import enumerate_optimum, BOX_SMALL  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'productblending_cases.json')

M3_PER_BBL = F('0.158987294928')      # exact by definition of the US barrel
WATER_KG_M3_60F = F('999.016')         # the reference for SG 60/60; cancels in every ratio
RVP_EXP = 1.25                         # held constant, pinned in the gate
REFUTAS_A, REFUTAS_B = 14.534, 10.975  # held constants, pinned in the gate
DELTA = F(1, 10 ** 7)


def rvp_index(v):
    return v ** RVP_EXP


def refutas(nu):
    return REFUTAS_A * math.log(math.log(nu + 0.8)) + REFUTAS_B


def refutas_inverse(i):
    # bisection, never the closed form the engine uses
    lo, hi = 0.2000001, 1e7
    for _ in range(300):
        mid = math.sqrt(lo * hi)
        if refutas(mid) < i:
            lo = mid
        else:
            hi = mid
    return math.sqrt(lo * hi)


# the templates, as data; the gate checks these limits against SPEC_TEMPLATES
TEMPLATES = {
    'gasoline_50ppm': [
        ('ron', 'volume', 91, None), ('mon', 'volume', 81, None), ('sulfurPpm', 'mass', None, 50),
        ('rvp', 'rvp', None, 9.0), ('density', 'volume', 0.720, 0.775)],
    'gasoline_10ppm': [
        ('ron', 'volume', 95, None), ('mon', 'volume', 85, None), ('sulfurPpm', 'mass', None, 10),
        ('rvp', 'rvp', None, 8.5), ('density', 'volume', 0.720, 0.775)],
    'diesel_50ppm': [
        ('cetane', 'volume', 48, None), ('sulfurPpm', 'mass', None, 50), ('density', 'volume', 0.820, 0.845),
        ('viscosityCSt', 'refutas', 2.0, 4.5), ('flashPointC', 'volume', 55, None)],
    'fuel_oil_380': [
        ('viscosityCSt', 'refutas', None, 380), ('sulfurPpm', 'mass', None, 35000),
        ('density', 'volume', None, 0.991), ('flashPointC', 'volume', 60, None)],
}


def fr(x):
    return F(x) if isinstance(x, (int, F)) else F(repr(float(x)))


def contribution(comp, pid, rule):
    """(numerator weight, denominator weight) per barrel, physically."""
    v = comp[pid]
    kg_per_bbl = fr(comp['sg']) * WATER_KG_M3_60F * M3_PER_BBL
    if rule == 'volume':
        return fr(v), F(1)
    if rule == 'mass':
        return kg_per_bbl * fr(v), kg_per_bbl
    if rule == 'rvp':
        return fr(rvp_index(v)), F(1)
    if rule == 'refutas':
        return kg_per_bbl * fr(refutas(v)), kg_per_bbl
    raise ValueError(rule)


def limit_in_row_units(rule, limit):
    if rule == 'rvp':
        return fr(rvp_index(limit))
    if rule == 'refutas':
        return fr(refutas(limit))
    return fr(limit)


def build(comps, specs, target, moved=None):
    """The LP, as oracle_lp's problem dict. `moved` = (spec index, bound, dL)."""
    n = len(comps)
    A, b, ops, meta = [[F(1)] * n], [fr(target)], ['='], [('volume', None)]
    for k, (pid, rule, mn, mx) in enumerate(specs):
        w = [contribution(c, pid, rule) for c in comps]
        for bound, lim in (('max', mx), ('min', mn)):
            if lim is None:
                continue
            limf = fr(lim)
            if moved and moved[0] == k and moved[1] == bound:
                limf += moved[2]
            L = limit_in_row_units(rule, limf) if rule in ('rvp', 'refutas') else limf
            A.append([num - L * den for num, den in w])
            b.append(F(0))
            ops.append('<=' if bound == 'max' else '>=')
            meta.append((pid, bound))
    lo = [fr(c.get('minVolume', 0)) for c in comps]
    hi = [None if c.get('maxVolume') is None else fr(c['maxVolume']) for c in comps]
    cost = [fr(c['cost']) for c in comps]
    return {'c': cost, 'cmin': cost, 'A': A, 'b': b, 'ops': ops, 'lo': lo, 'hi': hi, 'maximize': False}, meta


def solve(comps, specs, target, moved=None):
    prob, meta = build(comps, specs, target, moved)
    status, value, verts = enumerate_optimum(prob, BOX_SMALL)
    return status, value, verts, meta


def achieved(comps, v, pid, rule):
    """Blend property from physical inventories of the recipe."""
    m3 = [fr(x) * M3_PER_BBL for x in v]
    kg = [m * fr(c['sg']) * WATER_KG_M3_60F for m, c in zip(m3, comps)]
    if rule == 'volume':
        return float(sum(m * fr(c[pid]) for m, c in zip(m3, comps)) / sum(m3))
    if rule == 'mass':
        return float(sum(k * fr(c[pid]) for k, c in zip(kg, comps)) / sum(kg))
    if rule == 'rvp':
        idx = sum(float(m) * rvp_index(c[pid]) for m, c in zip(m3, comps)) / float(sum(m3))
        return idx ** (1 / RVP_EXP)
    if rule == 'refutas':
        idx = sum(float(k) * refutas(c[pid]) for k, c in zip(kg, comps)) / float(sum(kg))
        return refutas_inverse(idx)
    raise ValueError(rule)


def case(name, why, comps, template, target=1000, spec_override=None):
    specs = spec_override or TEMPLATES[template]
    status, value, verts, meta = solve(comps, specs, target)
    out = {'name': name, 'why': why, 'template': template, 'specOverride': spec_override is not None,
           'specs': [{'id': p, 'rule': r, 'min': mn, 'max': mx} for p, r, mn, mx in specs],
           'components': comps, 'targetVolume': target, 'status': status}
    if status != 'optimal':
        return out
    x = verts[0]
    out['totalCost'] = float(value)
    out['unique'] = len(verts) == 1
    out['volumes'] = [float(v) for v in x] if len(verts) == 1 else None
    out['achieved'] = {p: achieved(comps, x, p, r) for p, r, _, _ in specs}
    relief = []
    for k, (pid, rule, mn, mx) in enumerate(specs):
        for bound, lim in (('max', mx), ('min', mn)):
            if lim is None:
                continue
            # relief = raise a maximum, lower a minimum; value = cost saved per unit
            step = DELTA if bound == 'max' else -DELTA
            s_out, v_out, _, _ = solve(comps, specs, target, (k, bound, step))
            s_in, v_in, _, _ = solve(comps, specs, target, (k, bound, -step))
            relax = float((value - v_out) / DELTA) if s_out == 'optimal' else None
            tighten = float((v_in - value) / DELTA) if s_in == 'optimal' else None
            relief.append({'specId': pid, 'bound': bound, 'relaxSide': relax, 'tightenSide': tighten})
    out['relief'] = relief
    # the volume row: marginal cost of one more barrel, both sides
    up = solve(comps, specs, target + DELTA)[1]
    dn = solve(comps, specs, target - DELTA)[1]
    out['marginalBarrel'] = {'up': None if up is None else float((up - value) / DELTA),
                             'down': None if dn is None else float((value - dn) / DELTA)}
    return out


SUITE_DEFAULT_POOL = [
    {'id': 'reformate', 'name': 'Reformate', 'cost': 92, 'sg': 0.80, 'density': 0.800, 'ron': 100, 'mon': 89,
     'sulfurPpm': 2, 'rvp': 3.0, 'minVolume': 0, 'maxVolume': 600},
    {'id': 'fcc', 'name': 'FCC gasoline', 'cost': 84, 'sg': 0.75, 'density': 0.750, 'ron': 92, 'mon': 80,
     'sulfurPpm': 120, 'rvp': 6.0, 'minVolume': 0, 'maxVolume': 600},
    {'id': 'isomerate', 'name': 'Isomerate', 'cost': 89, 'sg': 0.66, 'density': 0.660, 'ron': 87, 'mon': 85,
     'sulfurPpm': 1, 'rvp': 13.0, 'minVolume': 0, 'maxVolume': 300},
    {'id': 'butane', 'name': 'Butane', 'cost': 55, 'sg': 0.58, 'density': 0.580, 'ron': 94, 'mon': 89,
     'sulfurPpm': 1, 'rvp': 52.0, 'minVolume': 0, 'maxVolume': 80},
]


def with_changes(pool, changes):
    return [dict(c, **changes.get(c['id'], {})) for c in pool]


DIESEL_POOL = [
    {'id': 'htgo', 'name': 'Hydrotreated gasoil', 'cost': 104, 'sg': 0.842, 'density': 0.842, 'cetane': 51,
     'sulfurPpm': 8, 'viscosityCSt': 3.4, 'flashPointC': 72, 'minVolume': 0, 'maxVolume': 700},
    {'id': 'kero', 'name': 'Kerosene', 'cost': 110, 'sg': 0.800, 'density': 0.800, 'cetane': 45,
     'sulfurPpm': 5, 'viscosityCSt': 1.4, 'flashPointC': 45, 'minVolume': 0, 'maxVolume': 300},
    {'id': 'lco', 'name': 'Hydrotreated LCO', 'cost': 88, 'sg': 0.925, 'density': 0.925, 'cetane': 28,
     'sulfurPpm': 30, 'viscosityCSt': 2.6, 'flashPointC': 68, 'minVolume': 0, 'maxVolume': 250},
    {'id': 'hvgo', 'name': 'Light vacuum gasoil', 'cost': 92, 'sg': 0.860, 'density': 0.860, 'cetane': 53,
     'sulfurPpm': 90, 'viscosityCSt': 6.5, 'flashPointC': 110, 'minVolume': 0, 'maxVolume': 300},
]

FUEL_OIL_POOL = [
    {'id': 'vr', 'name': 'Vacuum residue', 'cost': 58, 'sg': 1.010, 'density': 1.010, 'viscosityCSt': 18000,
     'sulfurPpm': 42000, 'flashPointC': 250, 'minVolume': 0, 'maxVolume': 800},
    {'id': 'lsr', 'name': 'Low-sulfur residue', 'cost': 66, 'sg': 0.955, 'density': 0.955, 'viscosityCSt': 900,
     'sulfurPpm': 6000, 'flashPointC': 200, 'minVolume': 0, 'maxVolume': 500},
    {'id': 'lco', 'name': 'LCO cutter', 'cost': 80, 'sg': 0.930, 'density': 0.930, 'viscosityCSt': 3.0,
     'sulfurPpm': 3000, 'flashPointC': 70, 'minVolume': 0, 'maxVolume': 400},
    {'id': 'go', 'name': 'Gasoil cutter', 'cost': 95, 'sg': 0.850, 'density': 0.850, 'viscosityCSt': 4.0,
     'sulfurPpm': 1000, 'flashPointC': 70, 'minVolume': 0, 'maxVolume': 400},
]


def main():
    cases = [
        case('Suite default gasoline pool, 50 ppm template',
             'what the Product Blending Optimizer solves with nothing typed; sulfur and RVP bind',
             SUITE_DEFAULT_POOL, 'gasoline_50ppm'),
        case('Suite default pool with component floors',
             'floors shift every spec row off zero, which is where the LP dual sign went wrong',
             with_changes(SUITE_DEFAULT_POOL, {'fcc': {'minVolume': 300}, 'isomerate': {'minVolume': 120}}),
             'gasoline_50ppm'),
        case('Suite default pool, butane tank empty',
             'a typed maximum of zero is none; the engine used to read it as unlimited',
             with_changes(SUITE_DEFAULT_POOL, {'butane': {'maxVolume': 0}}), 'gasoline_50ppm'),
        case('Suite default pool, 10 ppm template',
             'the tighter template; the FCC stream has to leave',
             SUITE_DEFAULT_POOL, 'gasoline_10ppm'),
        case('Suite default pool, octane minimum 96.8',
             'an octane minimum that binds, so a >= row is priced',
             SUITE_DEFAULT_POOL, 'gasoline_50ppm',
             spec_override=[('ron', 'volume', 96.8, None), ('mon', 'volume', 81, None),
                            ('sulfurPpm', 'mass', None, 50), ('rvp', 'rvp', None, 9.0),
                            ('density', 'volume', 0.720, 0.775)]),
        case('diesel pool, 50 ppm template',
             'viscosity through the Refutas index on MASS, cetane and flash linear on volume',
             DIESEL_POOL, 'diesel_50ppm'),
        case('diesel pool with a kerosene floor',
             'a binding floor on kerosene moves the optimum and shifts every spec row off zero',
             with_changes(DIESEL_POOL, {'kero': {'minVolume': 260}}), 'diesel_50ppm'),
        case('fuel oil pool, 380 cSt template',
             'a 35,000 ppm sulfur limit, where an absolute binding tolerance means nothing',
             FUEL_OIL_POOL, 'fuel_oil_380'),
        case('Suite default pool, infeasible octane',
             'no recipe from these streams reaches 101 RON',
             SUITE_DEFAULT_POOL, 'gasoline_50ppm',
             spec_override=[('ron', 'volume', 101, None), ('sulfurPpm', 'mass', None, 50)]),
    ]
    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_productblending.py',
            'method': 'exact vertex enumeration on physically built rows; properties from physical inventories; relief by exact re-solve',
            'engine': 'engines/downstream/productBlending.js',
            'published': 'none: an optimum and its sensitivities are facts of the stated problem; pools are illustrative',
            'heldConstants': {'rvpIndexExponent': RVP_EXP, 'refutasA': REFUTAS_A, 'refutasB': REFUTAS_B},
        },
        'cases': cases,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    for c in cases:
        print(c['name'], '|', c['status'], c.get('totalCost'),
              [(r['specId'], r['bound'], r['relaxSide'] and round(r['relaxSide'], 4)) for r in c.get('relief', [])
               if r['relaxSide']])


if __name__ == '__main__':
    main()
