#!/usr/bin/env python3
"""Independent stdlib oracle for engines/supplychain/marineLogistics.js (SC4).

    python3 tools/validation/supplychain/oracle_marine.py

Writes test-data/supplychain/goldens/marine_cases.json. Reads no JavaScript
and imports nothing from the engines. Every rule is coded here from the
published text (sources in the FINDINGS text for marine), by a different
road from the engine:

  inputs         every stated figure is read as the decimal it was typed as
                 (0.1 is 1/10) and carried as an exact Fraction; a figure
                 leaves the oracle as the nearest double only at the end.
                 Capacity checks, counts rounded up and the binding
                 constraint are decided on the exact values.
  voyages        leg by leg: calm hours = distance / speed; weathered hours
                 per activity; fuel = hours x burn; cost = tonnes x price.
  fleet          voyages = ceiling of the exact largest ratio (or the minimum
                 visits), vessel-days as an exact sum, vessels by the rule.
  deck plan      the "one open bin at a time" description of first-fit
                 decreasing (fill voyage 1 from the whole list, then voyage 2
                 from what is left, ...), which gives the same packing as the
                 first-fit description the engine codes.
  M/M/c          the delay probability from Adan and Resing eq. (5.1) as an
                 exact Fraction sum (the engine uses the Erlang B recursion
                 (11.3) and remark 11.3.2), then (5.2) and (5.3).
  M/D/c          c = 1 by the Pollaczek-Khinchin mean value formula (Adan and
                 Resing eqs 7.14 to 7.16, E(R) = S / 2 for a constant service
                 time); c > 1 by the Cosmetatos formula with the square root
                 taken to 40 digits.
  Monte Carlo    mulberry32 in unsigned 32-bit integers; the triangular
                 inverse CDF from its definition; vessel-days per iteration
                 as exact Fractions of the drawn doubles; percentiles by
                 integer index floor(p10 n / 10); means by math.fsum. The
                 oracle stops (exit 2) if a rounding decision falls within
                 1e-9 of a whole number without being one, where the
                 engine's doubles could decide it the other way.
  messages       refusal and reason texts are written from the engine's
                 stated wording; figures printed in them follow the stated
                 print rule (money to the cent, computed figures to 6 dp,
                 both half away from zero; stated inputs as typed). The one
                 double-arithmetic replay is the steady-state bound of
                 shoreBase, whose printed figure is defined by the engine's
                 own double test.

Published worked examples carried: Adan and Resing (2015) Tables 5.1 and 5.2;
Iversen (ITU-D 2001) Example 12.3.1; Skoko et al. (2024) Tables 1, 4 and 7;
Wikipedia First-fit-decreasing bin packing (the Coffman, Garey and Johnson
1978 capacity 60 and 61 example, the Huang and Lu example, and Dosa's tight
example).
"""
import json
import math
import os
import sys
from decimal import Decimal, ROUND_HALF_UP, getcontext
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FIX = os.path.join(ROOT, 'test-data', 'supplychain', 'ekene-marine', 'marine.json')
OUT = os.path.join(ROOT, 'test-data', 'supplychain', 'goldens', 'marine_cases.json')

EXCEEDANCE = 'P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.'
ACTS = ['sailing', 'port', 'field']
CAPS = {'inst': 50, 'prod': 20, 'lines': 500, 'units': 2000, 'qty': 1000, 'deckv': 500, 'berths': 100, 'wmax': 10, 'iter': 200000, 'draws': 2000000}


class Tie(Exception):
    pass


# ------------------------------------------------------------------ formatting
def js_num(x):
    """JavaScript String(x) for a double: shortest round-trip digits, with
    the switch to exponent form below 1e-6 and at or above 1e21."""
    x = float(x)
    if x == 0:
        return '0'
    sign = '-' if x < 0 else ''
    r = repr(abs(x))
    if 'e' in r:
        mant, ex = r.split('e')
        ex = int(ex)
    else:
        mant, ex = r, 0
    ip, fp = (mant.split('.') + [''])[:2]
    allds = ip + fp
    lead = len(allds) - len(allds.lstrip('0'))
    digits = allds.lstrip('0').rstrip('0') or '0'
    n = len(ip) + ex - lead
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * (-n) + digits
    e = n - 1
    es = ('+' if e >= 0 else '-') + str(abs(e))
    return sign + digits[0] + ('.' + digits[1:] if k > 1 else '') + 'e' + es


def fixed(q, places):
    """String(Number(x.toFixed(places))) of the double nearest q."""
    d = Decimal(float(q)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    return js_num(float(d))


def dec6(q):
    return fixed(q, 6)


def pct(q):
    return dec6(100 * F(float(q)) if not isinstance(q, F) else 100 * q) + '%'


def unit_of(printed, one):
    return f'{printed} {one if float(printed) == 1 else one + "s"}'


def isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def isint(x):
    return isnum(x) and float(x).is_integer()


def js_json(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isnum(v):
        return js_num(v)
    if isinstance(v, str):
        return json.dumps(v)
    if isinstance(v, list):
        return '[' + ','.join(js_json(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k) + ':' + js_json(x) for k, x in v.items()) + '}'
    raise ValueError(v)


def show(v):
    if v is MISSING:
        return 'nothing'
    if isnum(v):
        return js_num(v)
    if isinstance(v, str):
        return f'"{v}"'
    return js_json(v)


class _Missing:
    pass


MISSING = _Missing()


def get(o, k):
    return o[k] if isinstance(o, dict) and k in o and o[k] is not None else MISSING


def refuse(field, msg):
    return {'error': True, 'field': field, 'message': f'{field} {msg}'}


def must(field, cond, v):
    return refuse(field, f'must be {cond}; got {show(v)}')


def D(x):
    """a stated figure read as the decimal it was typed as."""
    return F(repr(float(x))) if isinstance(x, float) else F(x)


def fl(q):
    return float(q)


def first(*checks):
    for c in checks:
        if c:
            return c
    return None


# ------------------------------------------------------------------ checks
def nonneg(f, v):
    return None if isnum(v) and v >= 0 else must(f, 'a finite number at or above 0', v)


def positive(f, v):
    return None if isnum(v) and v > 0 else must(f, 'a finite number above 0', v)


def fraction(f, v):
    return None if isnum(v) and 0 < v <= 1 else must(f, 'a number above 0 and at most 1', v)


def int_in(f, v, lo, hi):
    return None if isint(v) and lo <= v <= hi else must(f, f'a whole number from {lo} to {hi}', v)


def one_of(f, v, opts):
    return None if isinstance(v, str) and v in opts else must(f, 'one of ' + ', '.join(f'"{o}"' for o in opts), v)


def text(f, v):
    return None if isinstance(v, str) and v != '' else must(f, 'a non-empty string', v)


def opt_text(f, v):
    return None if v is MISSING else text(f, v)


def check_list(lst, f, cap):
    if not isinstance(lst, list) or len(lst) < 1:
        return must(f, 'an array of at least 1 entry', lst)
    if len(lst) > cap:
        return refuse(f, f'has {len(lst)} entries; the cap is {cap}')
    seen = set()
    for i, x in enumerate(lst):
        if not isinstance(x, dict):
            return must(f'{f}[{i}]', 'an object', x)
        e = text(f'{f}[{i}].id', get(x, 'id'))
        if e:
            return e
        if x['id'] in seen:
            return refuse(f'{f}[{i}].id', f'repeats the id "{x["id"]}"')
        seen.add(x['id'])
    return None


# accepted keys, written out from the documented inputs of each function
TRI = ('obj', ['min', 'mode', 'max'], {})
VESSEL = ('obj', ['name', 'speedKnots', 'deckAreaM2', 'deckUsableFraction', 'deckLoadT', 'deadweightT', 'tanks', 'fuelTPerHour'],
          {'fuelTPerHour': ('obj', ACTS, {})})
PRODUCT = ('obj', ['id', 'name', 'kind', 'densityTPerM3'], {})
CARGO = ('obj', ['deckAreaM2', 'deckWeightT', 'bulk'], {})
ROUTE = ('obj', ['mode', 'stops', 'legsNm'], {})
FLEETK = ['vessel', 'products', 'installations', 'route', 'portHours', 'weather', 'fuelPricePerT', 'periodDays',
          'vesselAvailableDays', 'voyageRounding', 'vesselRounding']
FINST = ('obj', ['id', 'name', 'distanceFromBaseNm', 'fieldHours', 'minVisits', 'demand'], {'demand': CARGO})
SHAPES = {
    'voyagePlan': ('obj', ['vessel', 'products', 'installations', 'route', 'portHours', 'weather', 'fuelPricePerT'], {
        'vessel': VESSEL, 'products': ('list', PRODUCT),
        'installations': ('list', ('obj', ['id', 'name', 'distanceFromBaseNm', 'fieldHours', 'cargo'], {'cargo': CARGO})),
        'route': ROUTE, 'weather': ('obj', ['factor', 'appliesTo'], {})}),
    'fleetSize': ('obj', FLEETK, {'vessel': VESSEL, 'products': ('list', PRODUCT), 'installations': ('list', FINST), 'route': ROUTE,
                                  'weather': ('obj', ['factor', 'appliesTo'], {})}),
    'fleetVariability': ('obj', FLEETK + ['demandFactor', 'plannedVessels', 'iterations', 'seed'], {
        'vessel': VESSEL, 'products': ('list', PRODUCT), 'installations': ('list', FINST), 'route': ROUTE,
        'weather': ('obj', ['factor', 'appliesTo'], {'factor': 'TRI'}), 'demandFactor': 'TRI'}),
    'deckPlan': ('obj', ['deck', 'items', 'voyages', 'rule'], {'deck': ('obj', ['name', 'areaM2', 'usableFraction', 'loadT'], {}),
                                                               'items': ('list', ('obj', ['id', 'name', 'lengthM', 'widthM', 'weightT', 'quantity'], {}))}),
    'shoreBase': ('obj', ['berths', 'arrivalsPerDay', 'workingHoursPerDay', 'service', 'model', 'targetMeanWaitHours'],
                  {'service': ('obj', ['fixedHours', 'lifts', 'liftsPerHour', 'bulkM3', 'bulkM3PerHour', 'concurrent'], {})}),
}


def check_keys(v, shape, path):
    if shape == 'TRI':
        return check_keys(v, TRI, path) if isinstance(v, dict) else None
    if shape[0] == 'list':
        if not isinstance(v, list):
            return None
        for i, x in enumerate(v):
            e = check_keys(x, shape[1], f'{path}[{i}]')
            if e:
                return e
        return None
    if not isinstance(v, dict):
        return None
    _, keys, children = shape
    for k in v:
        if v[k] is not None and k not in keys:
            where = f'of {path}' if path else 'at the top level'
            return refuse(f'{path}.{k}' if path else k, f'is not an accepted key; the accepted keys {where} are ' + ', '.join(keys))
    for k in keys:
        if k in children and k in v and v[k] is not None:
            e = check_keys(v[k], children[k], f'{path}.{k}' if path else k)
            if e:
                return e
    return None


def product_keys(obj, ids, path):
    for k in obj:
        if obj[k] is not None and k not in ids:
            return refuse(f'{path}.{k}', f'is not a product id; the accepted keys of {path} are the product ids ' + ', '.join(ids))
    return None


def check_products(products):
    e = check_list(products, 'products', CAPS['prod'])
    if e:
        return e
    for i, p in enumerate(products):
        f = f'products[{i}]'
        e = first(opt_text(f + '.name', get(p, 'name')), one_of(f + '.kind', get(p, 'kind'), ['liquid', 'dry']),
                  positive(f + '.densityTPerM3', get(p, 'densityTPerM3')))
        if e:
            return e
    return None


def check_vessel(v, ids):
    if not isinstance(v, dict):
        return must('vessel', 'an object', v)
    e = first(opt_text('vessel.name', get(v, 'name')), positive('vessel.speedKnots', get(v, 'speedKnots')),
              positive('vessel.deckAreaM2', get(v, 'deckAreaM2')), fraction('vessel.deckUsableFraction', get(v, 'deckUsableFraction')),
              positive('vessel.deckLoadT', get(v, 'deckLoadT')), positive('vessel.deadweightT', get(v, 'deadweightT')))
    if e:
        return e
    tanks = get(v, 'tanks')
    if not isinstance(tanks, dict):
        return must('vessel.tanks', 'an object of tank capacities in m3 keyed by product id', tanks)
    e = product_keys(tanks, ids, 'vessel.tanks')
    if e:
        return e
    for pid in ids:
        if get(tanks, pid) is MISSING:
            return refuse(f'vessel.tanks.{pid}', 'must be stated for every product (0 when the vessel has no tank for it); got nothing')
        e = nonneg(f'vessel.tanks.{pid}', tanks[pid])
        if e:
            return e
    fuel = get(v, 'fuelTPerHour')
    if not isinstance(fuel, dict):
        return must('vessel.fuelTPerHour', 'an object { sailing, port, field } of fuel burn in tonnes an hour', fuel)
    for a in ACTS:
        e = nonneg(f'vessel.fuelTPerHour.{a}', get(fuel, a))
        if e:
            return e
    return None


def check_cargo(c, f, ids):
    if not isinstance(c, dict):
        return must(f, 'an object { deckAreaM2, deckWeightT, bulk }', c)
    e = first(nonneg(f + '.deckAreaM2', get(c, 'deckAreaM2')), nonneg(f + '.deckWeightT', get(c, 'deckWeightT')))
    if e:
        return e
    b = get(c, 'bulk')
    if b is MISSING:
        return None
    if not isinstance(b, dict):
        return must(f + '.bulk', 'an object of m3 keyed by product id when given', b)
    e = product_keys(b, ids, f + '.bulk')
    if e:
        return e
    for k in b:
        e = nonneg(f'{f}.bulk.{k}', b[k])
        if e:
            return e
    return None


def check_wfactor(f, v):
    return None if isnum(v) and 1 <= v <= CAPS['wmax'] else must(f, f'a finite number from 1 to {CAPS["wmax"]}', v)


def check_applies(a):
    if not isinstance(a, list) or len(a) < 1:
        return must('weather.appliesTo', 'an array naming at least one of "sailing", "port", "field"', a)
    for i, x in enumerate(a):
        e = one_of(f'weather.appliesTo[{i}]', x, ACTS)
        if e:
            return e
        if a.index(x) != i:
            return refuse(f'weather.appliesTo[{i}]', f'repeats "{x}"')
    return None


def check_route(route, insts):
    if not isinstance(route, dict):
        return must('route', 'an object { mode, stops, legsNm }', route)
    e = one_of('route.mode', get(route, 'mode'), ['milk-run', 'dedicated'])
    if e:
        return e
    if route['mode'] == 'dedicated':
        if get(route, 'stops') is not MISSING:
            return refuse('route.stops', 'is read only when route.mode is "milk-run"; a dedicated voyage sails from the base to one installation and back')
        if get(route, 'legsNm') is not MISSING:
            return refuse('route.legsNm', "is read only when route.mode is \"milk-run\"; a dedicated voyage uses each installation's distanceFromBaseNm out and back")
        for i, x in enumerate(insts):
            e = nonneg(f'installations[{i}].distanceFromBaseNm', get(x, 'distanceFromBaseNm'))
            if e:
                return e
        return None
    for i, x in enumerate(insts):
        if get(x, 'distanceFromBaseNm') is not MISSING:
            return refuse(f'installations[{i}].distanceFromBaseNm', 'is read only when route.mode is "dedicated"; a milk run takes its distances from route.legsNm')
    ids = [x['id'] for x in insts]
    stops = get(route, 'stops')
    n_inst = len(ids)
    if not isinstance(stops, list) or len(stops) != n_inst:
        return must('route.stops', f'an array naming each of the {n_inst} installation{"" if n_inst == 1 else "s"} once, in the order sailed', stops)
    for i, s in enumerate(stops):
        if s not in ids:
            return must(f'route.stops[{i}]', f'an installation id ({", ".join(ids)})', s)
        if stops.index(s) != i:
            return refuse(f'route.stops[{i}]', f'repeats "{s}"; a milk run visits each installation once')
    n = len(stops) + 1
    legs = get(route, 'legsNm')
    if not isinstance(legs, list) or len(legs) != n:
        return must('route.legsNm', f'an array of {n} leg distances in nautical miles (base to the first stop, stop to stop, the last stop back to the base)', legs)
    for i in range(n):
        e = nonneg(f'route.legsNm[{i}]', legs[i])
        if e:
            return e
    return None


# ------------------------------------------------------------------ voyages
def voyages_of(route, insts):
    by = {x['id']: x for x in insts}
    if route['mode'] == 'milk-run':
        names = ['base'] + route['stops'] + ['base']
        legs = [(names[i], names[i + 1], nm) for i, nm in enumerate(route['legsNm'])]
        return [{'id': 'milk-run', 'stops': list(route['stops']), 'legs': legs, 'members': [by[s] for s in route['stops']]}]
    return [{'id': x['id'], 'stops': [x['id']], 'legs': [('base', x['id'], x['distanceFromBaseNm']), (x['id'], 'base', x['distanceFromBaseNm'])],
             'members': [x]} for x in insts]


def calm(v, vessel, port):
    nm = sum((D(l[2]) for l in v['legs']), F(0))
    return {'nm': nm, 'sailing': nm / D(vessel['speedKnots']), 'port': D(port), 'field': sum((D(m['fieldHours']) for m in v['members']), F(0))}


def weathered(c, w, applies):
    h = {a: (c[a] * w if a in applies else c[a]) for a in ACTS}
    h['total'] = h['sailing'] + h['port'] + h['field']
    return h


def fuel(h, vessel):
    f = {a: h[a] * D(vessel['fuelTPerHour'][a]) for a in ACTS}
    f['total'] = f['sailing'] + f['port'] + f['field']
    return f


def cons_of(vessel, products):
    out = [('deck area', 'm2', D(vessel['deckAreaM2']) * D(vessel['deckUsableFraction']), None),
           ('deck load', 't', D(vessel['deckLoadT']), None),
           ('deadweight', 't', D(vessel['deadweightT']), None)]
    for p in products:
        out.append((f'tank {p["id"]}', 'm3', D(vessel['tanks'][p['id']]), p['id']))
    return out


def load_of(cargos, products):
    bulk = {}
    for p in products:
        bulk[p['id']] = sum((D(c['bulk'][p['id']]) for c in cargos if isinstance(c.get('bulk'), dict) and c['bulk'].get(p['id']) is not None), F(0))
    dw = sum((D(c['deckWeightT']) for c in cargos), F(0))
    return {'deckAreaM2': sum((D(c['deckAreaM2']) for c in cargos), F(0)), 'deckWeightT': dw, 'bulkM3': bulk,
            'deadweightT': dw + sum((bulk[p['id']] * D(p['densityTPerM3']) for p in products), F(0))}


def cons_load(c, load):
    name = c[0]
    if name == 'deck area':
        return load['deckAreaM2']
    if name == 'deck load':
        return load['deckWeightT']
    if name == 'deadweight':
        return load['deadweightT']
    return load['bulkM3'][c[3]]


def zero_cap(cons, load, where):
    for c in cons:
        if c[2] == 0 and cons_load(c, load) > 0:
            return refuse(f'vessel.tanks.{c[3]}', f'must be above 0 to carry {c[3]}: {where} for {dec6(cons_load(c, load))} m3 of it; got 0')
    return None


def where_of(v):
    return 'the installations on the milk run ask' if v['id'] == 'milk-run' else f'installation {v["id"]} asks'


def voyage_plan(a):
    products, vessel, insts = get(a, 'products'), get(a, 'vessel'), get(a, 'installations')
    e = check_products(products)
    if e:
        return e
    ids = [p['id'] for p in products]
    e = check_vessel(vessel, ids) or check_list(insts, 'installations', CAPS['inst'])
    if e:
        return e
    for i, x in enumerate(insts):
        e = first(opt_text(f'installations[{i}].name', get(x, 'name')), nonneg(f'installations[{i}].fieldHours', get(x, 'fieldHours')),
                  check_cargo(get(x, 'cargo'), f'installations[{i}].cargo', ids))
        if e:
            return e
    route, weather = get(a, 'route'), get(a, 'weather')
    e = first(check_route(route, insts), nonneg('portHours', get(a, 'portHours')),
              (must('weather', 'an object { factor, appliesTo }', weather) if not isinstance(weather, dict) else
               first(check_wfactor('weather.factor', get(weather, 'factor')), check_applies(get(weather, 'appliesTo')))),
              nonneg('fuelPricePerT', get(a, 'fuelPricePerT')))
    if e:
        return e
    cons = cons_of(vessel, products)
    w = D(weather['factor'])
    price = D(a['fuelPricePerT'])
    out = []
    for v in voyages_of(route, insts):
        load = load_of([m['cargo'] for m in v['members']], products)
        e = zero_cap(cons, load, where_of(v))
        if e:
            return e
        c = calm(v, vessel, a['portHours'])
        h = weathered(c, w, weather['appliesTo'])
        fu = fuel(h, vessel)
        rows = []
        for cn in cons:
            ld = cons_load(cn, load)
            rows.append({'constraint': cn[0], 'unit': cn[1], 'load': ld, 'capacity': cn[2], 'utilisation': F(0) if cn[2] == 0 else ld / cn[2]})
        best = rows[0]
        for r in rows:
            if r['utilisation'] > best['utilisation']:
                best = r
        over = [r for r in rows if r['load'] > r['capacity']]
        reasons = [f'the binding constraint is {best["constraint"]}: {dec6(best["load"])} {best["unit"]} of {dec6(best["capacity"])} {best["unit"]} ({pct(best["utilisation"])})']
        reasons += [f'overloaded: {r["constraint"]} needs {dec6(r["load"])} {r["unit"]} against a capacity of {dec6(r["capacity"])} {r["unit"]}' for r in over]
        out.append({
            'id': v['id'], 'stops': v['stops'],
            'legs': [{'from': l[0], 'to': l[1], 'nm': l[2], 'calmHours': fl(D(l[2]) / D(vessel['speedKnots']))} for l in v['legs']],
            'nm': fl(c['nm']),
            'hours': {k: fl(h[k]) for k in ['sailing', 'port', 'field', 'total']},
            'days': fl(h['total'] / 24),
            'fuelT': {k: fl(fu[k]) for k in ['sailing', 'port', 'field', 'total']},
            'fuelCost': fl(fu['total'] * price),
            'load': {'deckAreaM2': fl(load['deckAreaM2']), 'deckWeightT': fl(load['deckWeightT']),
                     'bulkM3': {k: fl(x) for k, x in load['bulkM3'].items()}, 'deadweightT': fl(load['deadweightT'])},
            'constraints': [{'constraint': r['constraint'], 'unit': r['unit'], 'load': fl(r['load']), 'capacity': fl(r['capacity']),
                             'utilisation': fl(r['utilisation'])} for r in rows],
            'binding': {'constraint': best['constraint'], 'utilisation': fl(best['utilisation'])},
            'feasible': len(over) == 0,
            'overloaded': [r['constraint'] for r in over],
            'reasons': reasons,
            '_h': h['total'], '_fu': fu['total'] * price, '_ft': fu['total'],
        })
    tot = {'hours': fl(sum((v['_h'] for v in out), F(0))), 'days': fl(sum((v['_h'] / 24 for v in out), F(0))),
           'fuelT': fl(sum((v['_ft'] for v in out), F(0))), 'fuelCost': fl(sum((v['_fu'] for v in out), F(0)))}
    for v in out:
        del v['_h'], v['_fu'], v['_ft']
    return {'voyages': out, 'totals': tot}


# ------------------------------------------------------------------ fleet
def guard_int(q):
    """stop when q is within 1e-9 (relative) of a whole number without being one."""
    n = round(q)
    if q != n and abs(q - n) <= F(1, 10 ** 9) * max(1, abs(q)):
        raise Tie(f'rounding decision within 1e-9 of {n}: {float(q)!r}')


def ceil_exact(q):
    guard_int(q)
    return math.ceil(q)


def round_vessels(q, rule):
    if rule == 'up':
        return F(ceil_exact(q))
    if rule == 'nearest':
        guard_int(q + F(1, 2))
        return F(math.floor(q + F(1, 2)))
    return q


def check_tri_factor(d, f, lo, hi=None):
    rng = f'at or above {lo}' if hi is None else f'from {lo} to {hi}'
    if isnum(d):
        return None if d >= lo and (hi is None or d <= hi) else must(f, f'a number {rng} or a triangular distribution {{ min, mode, max }}', d)
    if not isinstance(d, dict) or not all(isnum(get(d, k)) for k in ('min', 'mode', 'max')):
        return must(f, f'a number {rng} or a triangular distribution {{ min, mode, max }} of finite numbers', d)
    if d['min'] < lo:
        return must(f + '.min', f'at or above {lo}', d['min'])
    if hi is not None and d['max'] > hi:
        return must(f + '.max', f'at most {hi}', d['max'])
    if not (d['min'] <= d['mode'] <= d['max']):
        return refuse(f, f'must have min <= mode <= max; got min {js_num(d["min"])}, mode {js_num(d["mode"])}, max {js_num(d["max"])}')
    return None


def check_fleet(a, variable):
    products, vessel, insts = get(a, 'products'), get(a, 'vessel'), get(a, 'installations')
    e = check_products(products)
    if e:
        return e
    ids = [p['id'] for p in products]
    e = check_vessel(vessel, ids) or check_list(insts, 'installations', CAPS['inst'])
    if e:
        return e
    for i, x in enumerate(insts):
        e = first(opt_text(f'installations[{i}].name', get(x, 'name')), nonneg(f'installations[{i}].fieldHours', get(x, 'fieldHours')),
                  int_in(f'installations[{i}].minVisits', get(x, 'minVisits'), 0, 1000),
                  check_cargo(get(x, 'demand'), f'installations[{i}].demand', ids))
        if e:
            return e
    e = first(check_route(get(a, 'route'), insts), nonneg('portHours', get(a, 'portHours')))
    if e:
        return e
    w = get(a, 'weather')
    if not isinstance(w, dict):
        return must('weather', 'an object { factor, appliesTo }', w)
    e = check_tri_factor(get(w, 'factor'), 'weather.factor', 1, CAPS['wmax']) if variable else check_wfactor('weather.factor', get(w, 'factor'))
    if e:
        return e
    e = first(check_applies(get(w, 'appliesTo')), nonneg('fuelPricePerT', get(a, 'fuelPricePerT')), positive('periodDays', get(a, 'periodDays')),
              positive('vesselAvailableDays', get(a, 'vesselAvailableDays')))
    if e:
        return e
    if a['vesselAvailableDays'] > a['periodDays']:
        return refuse('vesselAvailableDays', f'must be at most periodDays ({js_num(a["periodDays"])}); got {js_num(a["vesselAvailableDays"])}')
    return first(one_of('voyageRounding', get(a, 'voyageRounding'), ['up', 'none']), one_of('vesselRounding', get(a, 'vesselRounding'), ['up', 'nearest', 'none']))


def prepare(a):
    vessel, products, insts = a['vessel'], a['products'], a['installations']
    cons = cons_of(vessel, products)
    sets = []
    for v in voyages_of(a['route'], insts):
        dem = load_of([m['demand'] for m in v['members']], products)
        e = zero_cap(cons, dem, where_of(v))
        if e:
            return e, None
        ratios = [F(0) if c[2] == 0 else cons_load(c, dem) / c[2] for c in cons]
        mx, drv = ratios[0], cons[0][0]
        for i in range(1, len(ratios)):
            if ratios[i] > mx:
                mx, drv = ratios[i], cons[i][0]
        sets.append({'v': v, 'dem': dem, 'ratios': ratios, 'max': mx, 'driver': drv, 'minVisits': max(m['minVisits'] for m in v['members']),
                     'calm': calm(v, vessel, a['portHours'])})
    return None, (cons, sets)


def voyages_for(s, f, rule):
    r = f * s['max']
    if r > 0:
        guard_int(r)  # r against the minimum visits (a whole number)
    by_demand = r > 0 and r >= s['minVisits']
    ex = r if by_demand else F(s['minVisits'])
    vv = F(ceil_exact(ex)) if rule == 'up' else ex
    return ex, vv, (s['driver'] if by_demand else ('minimum visits' if s['minVisits'] > 0 else 'no demand'))


def fleet_core(a, prep, w, f):
    cons, sets = prep
    avail = D(a['vesselAvailableDays'])
    out, reasons, vds, fts = [], [], [], []
    for s in sets:
        ex, vv, drv = voyages_for(s, f, a['voyageRounding'])
        h = weathered(s['calm'], w, a['weather']['appliesTo'])
        days = h['total'] / 24
        fu = fuel(h, a['vessel'])
        util = [{'constraint': c[0], 'demand': fl(f * cons_load(c, s['dem'])), 'capacity': fl(c[2]),
                 'averageUtilisation': fl(f * s['ratios'][i] / vv) if vv > 0 else 0.0} for i, c in enumerate(cons)]
        vds.append(vv * days)
        fts.append(vv * fu['total'])
        out.append({'id': s['v']['id'], 'stops': s['v']['stops'], 'nm': fl(s['calm']['nm']), 'voyagesExact': fl(ex), 'voyages': fl(vv),
                    'drivenBy': drv, 'hours': {k: fl(h[k]) for k in ['sailing', 'port', 'field', 'total']}, 'voyageDays': fl(days),
                    'vesselDays': fl(vv * days), 'fuelT': fl(vv * fu['total']), 'constraints': util})
        if days > avail:
            reasons.append(f'voyage {s["v"]["id"]} takes {unit_of(dec6(days), "day")}, longer than the {unit_of(js_num(a["vesselAvailableDays"]), "day")} a vessel is available in the period')
    vd = sum(vds, F(0))
    vex = vd / avail
    vs = round_vessels(vex, a['vesselRounding'])
    cap = vs * avail
    short = vd - cap if vd > cap else F(0)
    if short > 0:
        reasons.append(f'{js_num(vs)} {"vessel gives" if vs == 1 else "vessels give"} {dec6(cap)} vessel-days against {dec6(vd)} needed: short by {dec6(short)} vessel-days')
    ft = sum(fts, F(0))
    return {'voyageSets': out, 'vesselDays': fl(vd), 'vesselsExact': fl(vex), 'vessels': fl(vs), 'capacityDays': fl(cap),
            'spareVesselDays': 0.0 if short > 0 else fl(cap - vd), 'shortVesselDays': fl(short),
            'fleetUtilisation': fl(vd / cap) if cap > 0 else None, 'fuelT': fl(ft), 'fuelCost': fl(ft * D(a['fuelPricePerT'])), 'reasons': reasons}


def fleet_size(a):
    e = check_fleet(a, False)
    if e:
        return e
    e, prep = prepare(a)
    if e:
        return e
    return fleet_core(a, prep, D(a['weather']['factor']), F(1))


# ------------------------------------------------------------------ Monte Carlo
M32 = 0xFFFFFFFF


def imul(x, y):
    return ((x & M32) * (y & M32)) & M32


class Mulberry32:
    def __init__(self, seed):
        self.a = seed & M32

    def __call__(self):
        self.a = (self.a + 0x6D2B79F5) & M32
        t = self.a
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296


def tri_inv(u, a, c, b):
    """inverse of the triangular CDF: (x-a)^2/((b-a)(c-a)) on [a, c], 1-(b-x)^2/((b-a)(b-c)) on [c, b]."""
    if a == b:
        return a
    if u <= (c - a) / (b - a):
        return a + math.sqrt(u * (b - a) * (c - a))
    return b - math.sqrt((1 - u) * (b - a) * (b - c))


def tri(d):
    return {'min': d, 'mode': d, 'max': d} if isnum(d) else d


def draw(d, rng):
    return tri_inv(rng(), d['min'], d['mode'], d['max']) if d['max'] > d['min'] else d['mode']


def summary(vals):
    s = sorted(vals)
    n = len(s)

    def at(p10):
        return s[min((p10 * n) // 10, n - 1)]
    return {'mean': fl(sum(s, F(0)) / n), 'p90': fl(at(1)), 'p50': fl(at(5)), 'p10': fl(at(9)), 'min': fl(s[0]), 'max': fl(s[-1])}


def vessel_days(a, prep, w, f):
    _, sets = prep
    vd = F(0)
    for s in sets:
        _, vv, _ = voyages_for(s, f, a['voyageRounding'])
        vd += vv * weathered(s['calm'], w, a['weather']['appliesTo'])['total'] / 24
    return vd


def fleet_variability(a):
    e = check_fleet(a, True)
    if e:
        return e
    e = first(check_tri_factor(get(a, 'demandFactor'), 'demandFactor', 0), int_in('plannedVessels', get(a, 'plannedVessels'), 0, 1000),
              int_in('iterations', get(a, 'iterations'), 1, CAPS['iter']))
    if e:
        return e
    seed = get(a, 'seed')
    if not (isint(seed) and 0 <= seed <= 4294967295):
        return must('seed', 'a whole number from 0 to 4294967295 (there is no default, so every run can be reproduced)', seed)
    e, prep = prepare(a)
    if e:
        return e
    n_sets = len(prep[1])
    if a['iterations'] * n_sets > CAPS['draws']:
        return refuse('iterations', f'must be at most {CAPS["draws"] // n_sets} with {n_sets} voyage set{"" if n_sets == 1 else "s"} '
                      f'(iterations x voyage sets is capped at {CAPS["draws"]}); got {js_num(a["iterations"])}')
    wt, ft = tri(a['weather']['factor']), tri(a['demandFactor'])
    rng = Mulberry32(int(seed))
    n = int(a['iterations'])
    avail = D(a['vesselAvailableDays'])
    cap = a['plannedVessels'] * avail
    vds, vss, sf, counts, short = [], [], [], {}, 0
    for _ in range(n):
        w = draw(wt, rng)
        f = draw(ft, rng)
        vd = vessel_days(a, prep, D(w) if isinstance(w, int) else F(w), D(f) if isinstance(f, int) else F(f))
        vs = round_vessels(vd / avail, a['vesselRounding'])
        vds.append(vd)
        vss.append(vs)
        if cap > 0 and vd != cap and abs(vd / cap - 1) <= F(1, 10 ** 9):
            raise Tie(f'vessel-days within 1e-9 of the planned capacity: {float(vd)!r}')
        is_short = vd > cap
        short += 1 if is_short else 0
        sf.append(vd - cap if is_short else F(0))
        counts[vs] = counts.get(vs, 0) + 1
    pw, pf = D(wt['mode']), D(ft['mode'])
    pd = vessel_days(a, prep, pw, pf)
    return {
        'plan': {'weatherFactor': fl(pw), 'demandFactor': fl(pf), 'vesselDays': fl(pd), 'vessels': fl(round_vessels(pd / avail, a['vesselRounding']))},
        'vesselDays': summary(vds), 'vesselsRequired': summary(vss),
        'vesselsDistribution': None if a['vesselRounding'] == 'none' else [{'vessels': fl(k), 'probability': counts[k] / n} for k in sorted(counts)],
        'plannedVessels': a['plannedVessels'], 'capacityDays': fl(cap), 'probabilityShort': short / n,
        'expectedShortVesselDays': fl(sum(sf, F(0)) / n), 'percentileDefinition': EXCEEDANCE,
    }


# ------------------------------------------------------------------ deck plan
def deck_plan(a):
    deck = get(a, 'deck')
    if not isinstance(deck, dict):
        return must('deck', 'an object { areaM2, usableFraction, loadT }', deck)
    e = first(opt_text('deck.name', get(deck, 'name')), positive('deck.areaM2', get(deck, 'areaM2')), fraction('deck.usableFraction', get(deck, 'usableFraction')),
              positive('deck.loadT', get(deck, 'loadT')))
    if e:
        return e
    items = get(a, 'items')
    e = check_list(items, 'items', CAPS['lines'])
    if e:
        return e
    units = 0
    for i, x in enumerate(items):
        f = f'items[{i}]'
        e = first(opt_text(f + '.name', get(x, 'name')), positive(f + '.lengthM', get(x, 'lengthM')), positive(f + '.widthM', get(x, 'widthM')),
                  nonneg(f + '.weightT', get(x, 'weightT')), int_in(f + '.quantity', get(x, 'quantity'), 1, CAPS['qty']))
        if e:
            return e
        units += int(x['quantity'])
    if units > CAPS['units']:
        return refuse('items', f'hold {units} units in all; the cap is {CAPS["units"]}')
    e = first(int_in('voyages', get(a, 'voyages'), 1, CAPS['deckv']), one_of('rule', get(a, 'rule'), ['first-fit-decreasing-area', 'first-fit']))
    if e:
        return e
    usable = D(deck['areaM2']) * D(deck['usableFraction'])
    load = D(deck['loadT'])
    lst = []
    for x in items:
        q = int(x['quantity'])
        for k in range(1, q + 1):
            lst.append({'unit': x['id'] if q == 1 else f'{x["id"]}#{k}', 'item': x['id'], 'k': k,
                        'area': D(x['lengthM']) * D(x['widthM']), 'w': D(x['weightT'])})
    if a['rule'] == 'first-fit-decreasing-area':
        # stable sorts, least significant key first
        lst.sort(key=lambda u: u['k'])
        lst.sort(key=lambda u: u['item'])
        lst.sort(key=lambda u: u['w'], reverse=True)
        lst.sort(key=lambda u: u['area'], reverse=True)
    left = list(lst)
    bins = []
    for b in range(int(a['voyages'])):  # one open voyage at a time
        area, wt, got, rest = F(0), F(0), [], []
        for u in left:
            if area + u['area'] <= usable and wt + u['w'] <= load:
                area += u['area']
                wt += u['w']
                got.append(u['unit'])
            else:
                rest.append(u)
        left = rest
        bins.append({'voyage': b + 1, 'units': got, 'areaM2': area, 'weightT': wt})
    # the room each voyage had at a unit's turn: the units placed on it that
    # come earlier in the packing order (first fit places every earlier unit
    # before it looks at this one)
    pos = {u['unit']: i for i, u in enumerate(lst)}
    by_name = {u['unit']: u for u in lst}
    overflow = []
    for u in left:
        if u['area'] > usable:
            r = f'its footprint {dec6(u["area"])} m2 is larger than the usable deck area {dec6(usable)} m2'
        elif u['w'] > load:
            r = f'its weight {js_num(u["w"])} t is above the deck load {js_num(load)} t'
        else:
            room = []
            for b in bins:
                before = [by_name[n] for n in b['units'] if pos[n] < pos[u['unit']]]
                room.append((usable - sum((x['area'] for x in before), F(0)), load - sum((x['w'] for x in before), F(0))))
            area_enough = any(u['area'] <= ra for ra, _ in room)
            load_enough = any(u['w'] <= rw for _, rw in room)
            if not area_enough and not load_enough:
                tail = 'usable area and deck load both stop it'
            elif not area_enough:
                tail = 'usable area stops it'
            elif not load_enough:
                tail = 'deck load stops it'
            else:
                tail = 'no one voyage had both, so usable area and deck load together stop it'
            word = {True: 'enough', False: 'short'}
            r = (f'it needs {dec6(u["area"])} m2 of usable area and {js_num(u["w"])} t of deck load; at its turn the most left on any voyage was '
                 f'{dec6(max(ra for ra, _ in room))} m2 ({word[area_enough]}) and {dec6(max(rw for _, rw in room))} t ({word[load_enough]}); {tail}')
        overflow.append({'unit': u['unit'], 'itemId': u['item'], 'areaM2': fl(u['area']), 'weightT': fl(u['w']), 'reason': f'{u["unit"]} is overflow: {r}'})
    ta = sum((u['area'] for u in lst), F(0))
    tw = sum((u['w'] for u in lst), F(0))
    # the lower bound is over the units an empty voyage can carry; the rest
    # are listed as never fitting
    fit = [u for u in lst if u['area'] <= usable and u['w'] <= load]
    never = [u['unit'] for u in lst if not (u['area'] <= usable and u['w'] <= load)]
    return {
        'packingOrder': [u['unit'] for u in lst], 'usableAreaM2': fl(usable),
        'voyages': [{'voyage': b['voyage'], 'units': b['units'], 'areaM2': fl(b['areaM2']), 'weightT': fl(b['weightT']),
                     'areaUtilisation': fl(b['areaM2'] / usable), 'loadUtilisation': fl(b['weightT'] / load)} for b in bins],
        'voyagesUsed': sum(1 for b in bins if b['units']), 'overflow': overflow, 'totalAreaM2': fl(ta), 'totalWeightT': fl(tw),
        'lowerBound': max(ceil_exact(sum((u['area'] for u in fit), F(0)) / usable), ceil_exact(sum((u['w'] for u in fit), F(0)) / load)),
        'neverFit': never,
    }


# ------------------------------------------------------------------ shore base
def erlang_c(c, a):
    """Adan and Resing eq. (5.1), exact."""
    rho = a / c
    s = sum((a ** n / math.factorial(n) for n in range(c)), F(0))
    t = a ** c / math.factorial(c)
    return t / ((1 - rho) * s + t)


def sqrt40(n):
    getcontext().prec = 50
    return F(Decimal(n).sqrt())


def wait(c, a, S, lam, model):
    rho = a / c
    if model == 'M/M/c':
        pw = erlang_c(c, a)
        return pw, pw * S / (c * (1 - rho))
    if c == 1:  # Pollaczek-Khinchin: E(W) = rho E(R) / (1 - rho), E(R) = E(B^2) / (2 E(B)) = S / 2
        return None, rho * (S / 2) / (1 - rho)
    wm = erlang_c(c, a) * S / (c * (1 - rho))
    return None, wm / 2 * (1 + (1 - rho) * (c - 1) * (sqrt40(4 + 5 * c) - 2) / (16 * rho * c))


def bound_max(x, ok):
    """the engine's stated bound rule, in doubles: the 6-decimal figure nearest
    x on the accepted side, checked with the rule `ok`."""
    k = math.floor(x * 1e6)
    while ok((k + 1) / 1e6):
        k += 1
    while not ok(k / 1e6):
        k -= 1
    v = k / 1e6
    return js_num(v) if v == x else f'{js_num(v)} (rounded down at the sixth decimal so that it is accepted)'


def shore_base(a):
    e = first(int_in('berths', get(a, 'berths'), 1, CAPS['berths']), positive('arrivalsPerDay', get(a, 'arrivalsPerDay')))
    if e:
        return e
    W = get(a, 'workingHoursPerDay')
    if not (isnum(W) and 0 < W <= 24):
        return must('workingHoursPerDay', 'a number above 0 and at most 24', W)
    s = get(a, 'service')
    if not isinstance(s, dict):
        return must('service', 'an object { fixedHours, lifts, liftsPerHour, bulkM3, bulkM3PerHour, concurrent }', s)
    e = first(nonneg('service.fixedHours', get(s, 'fixedHours')), nonneg('service.lifts', get(s, 'lifts')), positive('service.liftsPerHour', get(s, 'liftsPerHour')),
              nonneg('service.bulkM3', get(s, 'bulkM3')), positive('service.bulkM3PerHour', get(s, 'bulkM3PerHour')))
    if e:
        return e
    if not isinstance(get(s, 'concurrent'), bool):
        return must('service.concurrent', 'true (lifts and bulk at the same time) or false (one after the other); there is no default', get(s, 'concurrent'))
    model = get(a, 'model')
    e = one_of('model', model, ['M/M/c', 'M/D/c'])
    if e:
        return e
    tgt = get(a, 'targetMeanWaitHours')
    if tgt is not MISSING:
        e = nonneg('targetMeanWaitHours', tgt)
        if e:
            return e
    lh = D(s['lifts']) / D(s['liftsPerHour'])
    bh = D(s['bulkM3']) / D(s['bulkM3PerHour'])
    S = D(s['fixedHours']) + (max(lh, bh) if s['concurrent'] else lh + bh)
    if S == 0:
        return refuse('service', 'must give a service time above 0 hours (fixed hours, lifts or bulk); got 0')
    c = int(a['berths'])
    lam = D(a['arrivalsPerDay']) / D(W)
    A = lam * S
    rho = A / c
    if rho >= 1:
        # the printed figures of this refusal replay the engine's doubles
        lhf = s['lifts'] / s['liftsPerHour']
        bhf = s['bulkM3'] / s['bulkM3PerHour']
        Sf = s['fixedHours'] + (max(lhf, bhf) if s['concurrent'] else lhf + bhf)
        limit = (c * W) / Sf
        rhof = ((a['arrivalsPerDay'] / W) * Sf) / c
        b = bound_max(limit, lambda v: ((v / W) * Sf) / c < 1)
        berths_txt = f'{c} berth' + ('' if c == 1 else 's')
        return refuse('arrivalsPerDay', f'must be at most {b} for a steady state with {berths_txt}: the berth utilisation must stay below 1, so arrivals a day must stay below berths x working hours a day / service hours = {fixed(limit, 6)}; got {js_num(a["arrivalsPerDay"])}, a berth utilisation of {fixed(rhof, 6)}')
    pw, wq = wait(c, A, S, lam, model)
    lq = lam * wq
    out = {'model': model, 'serviceHours': fl(S), 'liftHours': fl(lh), 'bulkHours': fl(bh), 'arrivalsPerHour': fl(lam), 'offeredLoad': fl(A),
           'berthUtilisation': fl(rho), 'probabilityWait': None if pw is None else fl(pw), 'meanQueue': fl(lq), 'meanWaitHours': fl(wq),
           'meanWaitWorkingDays': fl(wq / D(W)), 'meanTimeAtBaseHours': fl(wq + S), 'meanInSystem': fl(lq + A)}
    if tgt is not MISSING:
        T = D(tgt)
        found = None
        for cc in range(math.floor(A) + 1, CAPS['berths'] + 1):
            if A / cc < 1:
                _, wqc = wait(cc, A, S, lam, model)
                if wqc <= T:
                    found = (cc, wqc)
                    break
        if found:
            reason = (f'{found[0]} berth{"" if found[0] == 1 else "s"} {"is" if found[0] == 1 else "are"} the fewest with a mean wait at or below '
                      f'{unit_of(js_num(tgt), "hour")} ({unit_of(dec6(found[1]), "hour")})')
        else:
            reason = f'no berth count up to {CAPS["berths"]} gives a mean wait at or below {unit_of(js_num(tgt), "hour")}'
        out['target'] = {'targetMeanWaitHours': tgt, 'berths': found[0] if found else None, 'meanWaitHours': fl(found[1]) if found else None, 'reason': reason}
    return out


# ------------------------------------------------------------------ cases
FNS = {'voyagePlan': voyage_plan, 'fleetSize': fleet_size, 'fleetVariability': fleet_variability, 'deckPlan': deck_plan, 'shoreBase': shore_base}
CASES = []


def call(fn, args):
    a = json.loads(json.dumps(args))
    if not isinstance(a, dict):
        return refuse('options', 'must be an object of named inputs')
    e = check_keys(a, SHAPES[fn], '')
    if e:
        return e
    return FNS[fn](a)


def case(cid, fn, args, tol=1e-12, published=None):
    exp = call(fn, args)
    c = {'id': cid, 'fn': fn, 'args': args, 'expected': exp, 'tol': tol}
    if published:
        c['published'] = published
    CASES.append(c)
    return exp


def build():
    fx = json.load(open(FIX))
    P, psv, ahts = fx['products'], fx['vessels']['psv'], fx['vessels']['ahts']
    WX = {'factor': fx['weather']['factor'], 'appliesTo': fx['weather']['appliesTo']}
    vinst = [{'id': x['id'], 'name': x['name'], 'fieldHours': x['fieldHours'], 'cargo': x['voyageCargo']} for x in fx['installations']]
    vinst_d = [{'id': x['id'], 'name': x['name'], 'distanceFromBaseNm': x['distanceFromBaseNm'], 'fieldHours': x['fieldHours'], 'cargo': x['voyageCargo']} for x in fx['installations']]
    finst = [{'id': x['id'], 'name': x['name'], 'fieldHours': x['fieldHours'], 'minVisits': x['minVisits'], 'demand': x['demand']} for x in fx['installations']]
    finst_d = [dict(x, distanceFromBaseNm=y['distanceFromBaseNm']) for x, y in zip(finst, fx['installations'])]
    per = fx['period']
    base_v = {'vessel': psv, 'products': P, 'installations': vinst, 'route': fx['milkRun'], 'portHours': fx['portHours'], 'weather': WX, 'fuelPricePerT': fx['fuelPricePerT']}
    base_f = {'vessel': psv, 'products': P, 'installations': finst, 'route': fx['milkRun'], 'portHours': fx['portHours'], 'weather': WX,
              'fuelPricePerT': fx['fuelPricePerT'], 'periodDays': per['periodDays'], 'vesselAvailableDays': per['vesselAvailableDays'],
              'voyageRounding': 'up', 'vesselRounding': 'up'}

    # ---- published: Skoko et al. (2024)
    one_p = [{'id': 'd', 'kind': 'liquid', 'densityTPerM3': 1}]
    skoko_psv = {'speedKnots': 10, 'deckAreaM2': 700, 'deckUsableFraction': 1, 'deckLoadT': 1360, 'deadweightT': 1360, 'tanks': {'d': 1},
                 'fuelTPerHour': {'sailing': 0.5, 'port': 0.03, 'field': 0.5}}
    case('skoko-2024-table1-psv-daily-fuel', 'voyagePlan', {
        'vessel': skoko_psv, 'products': one_p,
        'installations': [{'id': 'field', 'distanceFromBaseNm': 120, 'fieldHours': 0, 'cargo': {'deckAreaM2': 0, 'deckWeightT': 0}}],
        'route': {'mode': 'dedicated'}, 'portHours': 24, 'weather': {'factor': 1, 'appliesTo': ['sailing']}, 'fuelPricePerT': 870},
        published={'source': 'Skoko et al. (2024) Tables 1 and 4: 10 knots is 240 NM a day; 0.5 t/h is 12 t a day, USD 10,440 at USD 870/t; 0.03 t/h is 0.72 t a day, USD 626.4',
                   'sailingHours': 24, 'sailingFuelCost': 10440, 'portFuelCost': 626.4, 'printedTolerance': 0})
    skoko_ahts = dict(skoko_psv, speedKnots=11, deadweightT=680, deckLoadT=680)
    case('skoko-2024-table7-ahts-optimal-fuel', 'voyagePlan', {
        'vessel': skoko_ahts, 'products': one_p,
        'installations': [{'id': 'field', 'distanceFromBaseNm': 79.2, 'fieldHours': 168, 'cargo': {'deckAreaM2': 0, 'deckWeightT': 0}}],
        'route': {'mode': 'dedicated'}, 'portHours': 57.6, 'weather': {'factor': 1, 'appliesTo': ['sailing']}, 'fuelPricePerT': 870},
        published={'source': 'Skoko et al. (2024) Tables 5 and 7: AHTS optimum 7.00 days maritime activities and 0.60 days navigation at 0.5 t/h, 2.40 days standby in port at 0.03 t/h, USD 870/t; printed optimal fuel USD 80,847.36',
                   'fuelCost': 80847.36, 'printedTolerance': 0.005,
                   'note': 'the maritime activities are the field activity here; 0.60 days at 11 knots is 158.4 NM, 79.2 each way'})

    # ---- published: Adan and Resing (2015) Tables 5.1 and 5.2; Iversen (2001) Example 12.3.1
    unit_service = {'fixedHours': 1, 'lifts': 0, 'liftsPerHour': 1, 'bulkM3': 0, 'bulkM3PerHour': 1, 'concurrent': False}
    t51 = {1: (0.90, 9.00), 2: (0.85, 4.26), 5: (0.76, 1.53), 10: (0.67, 0.67), 20: (0.55, 0.28)}
    for c, (pw, ew) in t51.items():
        pub = {'source': 'Adan and Resing (2015) Table 5.1: M/M/c, mu = 1, rho = 0.9', 'probabilityWait': pw, 'meanWaitHours': ew, 'printedTolerance': 0.005}
        if c == 5:
            pub.update(meanWaitTolerance=0.0051, note='printed E(W) 1.53; the exact 1.524986 rounds to 1.52 at two decimals, so the printed figure sits 0.005014 away')
        case(f'adan-resing-table-5-1-c{c}', 'shoreBase', {'berths': c, 'arrivalsPerDay': 9 * c, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/M/c'},
             published=pub)
    t52 = {1: (9, 9.00, 9), 2: (19, 9.26, 19), 5: (49, 9.50, 51), 10: (99, 9.64, 105), 20: (199, 9.74, 214)}
    for c, (arr, ew, el) in t52.items():
        case(f'adan-resing-table-5-2-c{c}', 'shoreBase', {'berths': c, 'arrivalsPerDay': arr, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/M/c'},
             published={'source': 'Adan and Resing (2015) Table 5.2: M/M/c, mu = 1, surplus capacity 0.1 server', 'meanWaitHours': ew, 'meanInSystem': el,
                        'printedTolerance': 0.005, 'meanInSystemTolerance': 0.5})
    case('iversen-2001-example-12-3-1-system-1', 'shoreBase', {'berths': 32, 'arrivalsPerDay': 2, 'workingHoursPerDay': 10,
                                                               'service': dict(unit_service, fixedHours=100), 'model': 'M/M/c'},
         published={'source': 'Iversen, Teletraffic Engineering Handbook (ITU-D 2001) Example 12.3.1: M/M/n, mean service 100 s, 20 erlang, 32 channels, W1 = 0.075 s (the hour here stands for the second)',
                    'meanWaitHours': 0.075, 'printedTolerance': 0.0005})
    case('iversen-2001-example-12-3-1-system-2', 'shoreBase', {'berths': 5, 'arrivalsPerDay': 2, 'workingHoursPerDay': 10,
                                                               'service': dict(unit_service, fixedHours=10), 'model': 'M/M/c'},
         published={'source': 'Iversen (ITU-D 2001) Example 12.3.1: mean service 10 s, 2 erlang, 5 channels, W2 = 0.199 s',
                    'meanWaitHours': 0.199, 'printedTolerance': 0.0005})

    # ---- published: first-fit decreasing (Wikipedia; Coffman, Garey and Johnson 1978; Huang and Lu 2021; Dosa 2007)
    def sized(sizes):
        return [{'id': f's{i + 1:02d}', 'lengthM': s, 'widthM': 1, 'weightT': 0, 'quantity': 1} for i, s in enumerate(sizes)]
    cgj = [44, 24, 24, 22, 21, 17, 8, 8, 6, 6]
    case('ffd-wikipedia-cgj-capacity-60', 'deckPlan', {'deck': {'areaM2': 60, 'usableFraction': 1, 'loadT': 1}, 'items': sized(cgj), 'voyages': 10,
                                                       'rule': 'first-fit-decreasing-area'},
         published={'source': 'Wikipedia, First-fit-decreasing bin packing, Monotonicity properties example (Coffman, Garey and Johnson 1978)',
                    'bins': [[44, 8, 8], [24, 24, 6, 6], [22, 21, 17]], 'sizes': cgj})
    case('ffd-wikipedia-cgj-capacity-61', 'deckPlan', {'deck': {'areaM2': 61, 'usableFraction': 1, 'loadT': 1}, 'items': sized(cgj), 'voyages': 10,
                                                       'rule': 'first-fit-decreasing-area'},
         published={'source': 'Wikipedia, First-fit-decreasing bin packing: with capacity 61 FFD packs 4 bins', 'bins': [[44, 17], [24, 24, 8], [22, 21, 8, 6], [6]], 'sizes': cgj})
    hl = [51, 28, 28, 28, 27, 25, 12, 12, 10, 10, 10, 10, 10, 10, 10, 10]
    case('ffd-wikipedia-huang-lu-capacity-75', 'deckPlan', {'deck': {'areaM2': 75, 'usableFraction': 1, 'loadT': 1}, 'items': sized(hl), 'voyages': 10,
                                                            'rule': 'first-fit-decreasing-area'},
         published={'source': 'Wikipedia, First-fit-decreasing bin packing (Huang and Lu 2021, Ex. 5.1): capacity 75, 4 bins',
                    'bins': [[51, 12, 12], [28, 28, 10], [28, 27, 10, 10], [25, 10, 10, 10, 10, 10]], 'sizes': hl})
    # Dosa (2007) tight example scaled: capacity 400, epsilon 4 (1/2+e = 204, 1/4+e = 104, 1/4-2e = 92, 1/4+2e = 108)
    dosa = [204] * 4 + [104] * 4 + [92] * 4 + [108] * 4 + [92] * 4
    case('ffd-wikipedia-dosa-tight-example', 'deckPlan', {'deck': {'areaM2': 400, 'usableFraction': 1, 'loadT': 1}, 'items': sized(dosa), 'voyages': 10,
                                                          'rule': 'first-fit-decreasing-area'},
         published={'source': 'Wikipedia, First-fit-decreasing bin packing, worst-case example (Dosa 2007): 4 copies of B1 and 2 of B2 need 6 bins; FFD uses 8 = 11/9 x 6 + 6/9',
                    'binsUsed': 8, 'optimum': 6, 'sizes': dosa,
                    'binSizes': [[204, 108], [204, 108], [204, 108], [204, 108], [104, 104, 104], [104, 92, 92, 92], [92, 92, 92, 92], [92]]})

    # ---- voyage planning: the Ekene cluster
    case('ekene-voyage-milk-run-psv', 'voyagePlan', base_v)
    case('ekene-voyage-milk-run-ahts', 'voyagePlan', dict(base_v, vessel=ahts))
    case('ekene-voyage-dedicated-psv', 'voyagePlan', dict(base_v, installations=vinst_d, route={'mode': 'dedicated'}))
    case('ekene-voyage-calm', 'voyagePlan', dict(base_v, weather={'factor': 1, 'appliesTo': ['sailing', 'port', 'field']}))
    case('ekene-voyage-weather-on-all-activities', 'voyagePlan', dict(base_v, weather={'factor': 1.2, 'appliesTo': ['field', 'port', 'sailing']}))
    heavy = [dict(x, cargo=dict(x['cargo'], deckAreaM2=x['cargo']['deckAreaM2'] * 2)) for x in vinst]
    case('ekene-voyage-deck-overloaded', 'voyagePlan', dict(base_v, installations=heavy))
    # boundary: the load exactly at a capacity is feasible, one tonne over is overloaded
    tiny_v = {'speedKnots': 10, 'deckAreaM2': 100, 'deckUsableFraction': 0.5, 'deckLoadT': 80, 'deadweightT': 200, 'tanks': {'d': 50},
              'fuelTPerHour': {'sailing': 1, 'port': 0, 'field': 0.5}}
    def one(cargo, **kw):
        a = {'vessel': tiny_v, 'products': one_p, 'installations': [{'id': 'X', 'distanceFromBaseNm': 50, 'fieldHours': 2, 'cargo': cargo}],
             'route': {'mode': 'dedicated'}, 'portHours': 4, 'weather': {'factor': 1, 'appliesTo': ['sailing']}, 'fuelPricePerT': 1000}
        a.update(kw)
        return a
    case('voyage-at-capacity-feasible', 'voyagePlan', one({'deckAreaM2': 50, 'deckWeightT': 80, 'bulk': {'d': 50}}))
    case('voyage-one-over-deck-load', 'voyagePlan', one({'deckAreaM2': 50, 'deckWeightT': 81, 'bulk': {'d': 50}}))
    case('voyage-binding-tie-goes-to-deck-area', 'voyagePlan', one({'deckAreaM2': 25, 'deckWeightT': 40, 'bulk': {'d': 10}}))
    case('voyage-binding-tank', 'voyagePlan', one({'deckAreaM2': 5, 'deckWeightT': 4, 'bulk': {'d': 45}}))
    case('voyage-deadweight-from-density', 'voyagePlan', dict(one({'deckAreaM2': 5, 'deckWeightT': 60, 'bulk': {'d': 50}}),
                                                          products=[{'id': 'd', 'kind': 'dry', 'densityTPerM3': 2.9}]))
    case('voyage-decimal-sum-at-capacity', 'voyagePlan', dict(one({'deckAreaM2': 0.3, 'deckWeightT': 0, 'bulk': {}}), vessel=dict(tiny_v, deckAreaM2=0.3, deckUsableFraction=1),
                                                              installations=[{'id': 'X', 'fieldHours': 2, 'cargo': {'deckAreaM2': 0.1, 'deckWeightT': 0}},
                                                                             {'id': 'Y', 'fieldHours': 2, 'cargo': {'deckAreaM2': 0.2, 'deckWeightT': 0}}],
                                                              route={'mode': 'milk-run', 'stops': ['X', 'Y'], 'legsNm': [50, 0.5, 50]}))
    case('voyage-zero-distance-leg', 'voyagePlan', dict(one({'deckAreaM2': 1, 'deckWeightT': 1}), installations=[
        {'id': 'X', 'fieldHours': 2, 'cargo': {'deckAreaM2': 1, 'deckWeightT': 1}}, {'id': 'Y', 'fieldHours': 0, 'cargo': {'deckAreaM2': 0, 'deckWeightT': 0}}],
        route={'mode': 'milk-run', 'stops': ['Y', 'X'], 'legsNm': [30, 0, 30]}))
    case('voyage-tank-zero-capacity-empty-ok', 'voyagePlan', dict(one({'deckAreaM2': 1, 'deckWeightT': 1}), vessel=dict(tiny_v, tanks={'d': 0})))

    # voyagePlan refusals
    case('voyage-refuse-tank-zero-capacity', 'voyagePlan', dict(one({'deckAreaM2': 1, 'deckWeightT': 1, 'bulk': {'d': 3}}), vessel=dict(tiny_v, tanks={'d': 0})))
    case('voyage-refuse-milk-run-tank-zero', 'voyagePlan', dict(base_v, vessel=dict(psv, tanks=dict(psv['tanks'], brine=0))))
    case('voyage-refuse-unknown-key', 'voyagePlan', dict(base_v, fuelPrice=870))
    case('voyage-refuse-unknown-vessel-key', 'voyagePlan', dict(base_v, vessel=dict(psv, deckArea=800)))
    case('voyage-refuse-unknown-fuel-key', 'voyagePlan', dict(base_v, vessel=dict(psv, fuelTPerHour=dict(psv['fuelTPerHour'], standby=0.1))))
    case('voyage-refuse-unknown-cargo-key', 'voyagePlan', dict(base_v, installations=[dict(vinst[0], cargo=dict(vinst[0]['cargo'], deckAreaM2s=1))] + vinst[1:]))
    case('voyage-refuse-unknown-bulk-product', 'voyagePlan', dict(base_v, installations=[dict(vinst[0], cargo=dict(vinst[0]['cargo'], bulk={'methanol': 5}))] + vinst[1:]))
    case('voyage-refuse-unknown-tank-product', 'voyagePlan', dict(base_v, vessel=dict(psv, tanks=dict(psv['tanks'], methanol=100))))
    case('voyage-refuse-tank-missing', 'voyagePlan', dict(base_v, vessel=dict(psv, tanks={k: v for k, v in psv['tanks'].items() if k != 'mud'})))
    case('voyage-refuse-usable-fraction-zero', 'voyagePlan', dict(base_v, vessel=dict(psv, deckUsableFraction=0)))
    case('voyage-refuse-usable-fraction-above-one', 'voyagePlan', dict(base_v, vessel=dict(psv, deckUsableFraction=1.1)))
    case('voyage-refuse-speed-missing', 'voyagePlan', dict(base_v, vessel={k: v for k, v in psv.items() if k != 'speedKnots'}))
    case('voyage-refuse-weather-below-one', 'voyagePlan', dict(base_v, weather={'factor': 0.9, 'appliesTo': ['sailing']}))
    case('voyage-refuse-weather-above-cap', 'voyagePlan', dict(base_v, weather={'factor': 10.5, 'appliesTo': ['sailing']}))
    case('voyage-refuse-weather-activity', 'voyagePlan', dict(base_v, weather={'factor': 1.2, 'appliesTo': ['sailing', 'standby']}))
    case('voyage-refuse-weather-repeat', 'voyagePlan', dict(base_v, weather={'factor': 1.2, 'appliesTo': ['sailing', 'sailing']}))
    case('voyage-refuse-weather-empty', 'voyagePlan', dict(base_v, weather={'factor': 1.2, 'appliesTo': []}))
    case('voyage-refuse-route-mode', 'voyagePlan', dict(base_v, route={'mode': 'round-robin'}))
    case('voyage-refuse-stops-missing-one', 'voyagePlan', dict(base_v, route={'mode': 'milk-run', 'stops': ['EKA', 'EKJ', 'EKB'], 'legsNm': [62, 9, 12, 95]}))
    case('voyage-refuse-stops-unknown', 'voyagePlan', dict(base_v, route={'mode': 'milk-run', 'stops': ['EKA', 'EKJ', 'EKB', 'EKX'], 'legsNm': [62, 9, 12, 28, 95]}))
    case('voyage-refuse-stops-repeat', 'voyagePlan', dict(base_v, route={'mode': 'milk-run', 'stops': ['EKA', 'EKJ', 'EKA', 'EKF'], 'legsNm': [62, 9, 12, 28, 95]}))
    case('voyage-refuse-legs-count', 'voyagePlan', dict(base_v, route={'mode': 'milk-run', 'stops': ['EKA', 'EKJ', 'EKB', 'EKF'], 'legsNm': [62, 9, 12, 28]}))
    case('voyage-refuse-leg-negative', 'voyagePlan', dict(base_v, route={'mode': 'milk-run', 'stops': ['EKA', 'EKJ', 'EKB', 'EKF'], 'legsNm': [62, 9, -12, 28, 95]}))
    case('voyage-refuse-distance-on-milk-run', 'voyagePlan', dict(base_v, installations=vinst_d))
    case('voyage-refuse-legs-on-dedicated', 'voyagePlan', dict(base_v, installations=vinst_d, route={'mode': 'dedicated', 'legsNm': [1]}))
    case('voyage-refuse-stops-on-dedicated', 'voyagePlan', dict(base_v, installations=vinst_d, route={'mode': 'dedicated', 'stops': ['EKA']}))
    case('voyage-refuse-dedicated-distance-missing', 'voyagePlan', dict(base_v, route={'mode': 'dedicated'}))
    case('voyage-refuse-product-kind', 'voyagePlan', dict(base_v, products=[dict(P[0], kind='gas')] + P[1:]))
    case('voyage-refuse-product-density', 'voyagePlan', dict(base_v, products=[dict(P[0], densityTPerM3=0)] + P[1:]))
    case('voyage-refuse-product-repeat', 'voyagePlan', dict(base_v, products=P + [P[0]]))
    case('voyage-refuse-no-products', 'voyagePlan', dict(base_v, products=[]))
    case('voyage-refuse-cargo-negative', 'voyagePlan', dict(base_v, installations=[dict(vinst[0], cargo=dict(vinst[0]['cargo'], deckWeightT=-1))] + vinst[1:]))
    case('voyage-refuse-port-hours', 'voyagePlan', dict(base_v, portHours='12'))
    case('voyage-refuse-fuel-price', 'voyagePlan', {k: v for k, v in base_v.items() if k != 'fuelPricePerT'})
    case('voyage-refuse-options', 'voyagePlan', [1])

    # ---- fleet sizing: the Ekene cluster
    ek_f = case('ekene-fleet-psv-milk-run', 'fleetSize', base_f)
    case('ekene-fleet-ahts-milk-run', 'fleetSize', dict(base_f, vessel=ahts))
    case('ekene-fleet-psv-dedicated', 'fleetSize', dict(base_f, installations=finst_d, route={'mode': 'dedicated'}))
    case('ekene-fleet-ahts-dedicated', 'fleetSize', dict(base_f, vessel=ahts, installations=finst_d, route={'mode': 'dedicated'}))
    case('ekene-fleet-fractional', 'fleetSize', dict(base_f, voyageRounding='none', vesselRounding='none'))
    case('ekene-fleet-nearest-vessels', 'fleetSize', dict(base_f, vesselRounding='nearest'))
    case('ekene-fleet-calm', 'fleetSize', dict(base_f, weather={'factor': 1, 'appliesTo': ['sailing']}))
    # boundaries of the counts
    fl_v = {'speedKnots': 12, 'deckAreaM2': 100, 'deckUsableFraction': 1, 'deckLoadT': 1000, 'deadweightT': 1000, 'tanks': {'d': 100},
            'fuelTPerHour': {'sailing': 1, 'port': 0.1, 'field': 0.5}}
    def fone(demand, minVisits=0, **kw):
        a = {'vessel': fl_v, 'products': one_p, 'installations': [{'id': 'X', 'distanceFromBaseNm': 60, 'fieldHours': 12, 'minVisits': minVisits, 'demand': demand}],
             'route': {'mode': 'dedicated'}, 'portHours': 12, 'weather': {'factor': 1, 'appliesTo': ['sailing']}, 'fuelPricePerT': 800,
             'periodDays': 7, 'vesselAvailableDays': 7, 'voyageRounding': 'up', 'vesselRounding': 'up'}
        a.update(kw)
        return a
    # a voyage: 120 nm / 12 kn = 10 h + 12 + 12 = 34 h
    case('fleet-demand-exactly-three-voyages', 'fleetSize', fone({'deckAreaM2': 300, 'deckWeightT': 0}))
    case('fleet-demand-just-over-three-voyages', 'fleetSize', fone({'deckAreaM2': 300.001, 'deckWeightT': 0}))
    case('fleet-decimal-ratio-exactly-three', 'fleetSize', fone({'deckAreaM2': 0.3, 'deckWeightT': 0}, vessel=dict(fl_v, deckAreaM2=0.1)))
    case('fleet-decimal-ratio-2-1-over-0-7-is-three', 'fleetSize', fone({'deckAreaM2': 2.1, 'deckWeightT': 0}, vessel=dict(fl_v, deckAreaM2=0.7)))
    case('fleet-min-visits-equal-demand-names-demand', 'fleetSize', fone({'deckAreaM2': 300, 'deckWeightT': 0}, minVisits=3))
    case('fleet-min-visits-drive', 'fleetSize', fone({'deckAreaM2': 250, 'deckWeightT': 0}, minVisits=3))
    case('fleet-no-demand-no-visits', 'fleetSize', fone({'deckAreaM2': 0, 'deckWeightT': 0}))
    case('fleet-tank-drives', 'fleetSize', fone({'deckAreaM2': 10, 'deckWeightT': 0, 'bulk': {'d': 410}}))
    # vessels: 34 h voyages; 7 voyages = 238 h = 9.916667 days; available 7 -> 1.416667
    case('fleet-vessels-up', 'fleetSize', fone({'deckAreaM2': 700, 'deckWeightT': 0}))
    case('fleet-vessels-nearest-short', 'fleetSize', fone({'deckAreaM2': 700, 'deckWeightT': 0}, vesselRounding='nearest'))
    case('fleet-vessels-none', 'fleetSize', fone({'deckAreaM2': 700, 'deckWeightT': 0}, vesselRounding='none'))
    # exactly 2 vessels: 84 h voyages x 4 = 14 days over 7 available
    case('fleet-vessel-days-exactly-two-vessels', 'fleetSize', fone({'deckAreaM2': 400, 'deckWeightT': 0}, portHours=62))
    # nearest: exactly 1.5 vessels rounds up (halves up): 6 voyages x 42 h = 10.5 days over 7
    case('fleet-vessels-nearest-half-rounds-up', 'fleetSize', fone({'deckAreaM2': 600, 'deckWeightT': 0}, portHours=20, vesselRounding='nearest'))
    case('fleet-voyage-longer-than-available', 'fleetSize', fone({'deckAreaM2': 100, 'deckWeightT': 0}, portHours=200, vesselAvailableDays=6.5))
    case('fleet-available-equals-period', 'fleetSize', fone({'deckAreaM2': 100, 'deckWeightT': 0}, vesselAvailableDays=7))
    # refusals
    case('fleet-refuse-available-above-period', 'fleetSize', fone({'deckAreaM2': 1, 'deckWeightT': 0}, vesselAvailableDays=7.5))
    case('fleet-refuse-voyage-rounding', 'fleetSize', fone({'deckAreaM2': 1, 'deckWeightT': 0}, voyageRounding='nearest'))
    case('fleet-refuse-vessel-rounding-missing', 'fleetSize', {k: v for k, v in fone({'deckAreaM2': 1, 'deckWeightT': 0}).items() if k != 'vesselRounding'})
    case('fleet-refuse-min-visits-fraction', 'fleetSize', fone({'deckAreaM2': 1, 'deckWeightT': 0}, minVisits=1.5))
    case('fleet-refuse-min-visits-missing', 'fleetSize', dict(base_f, installations=[{k: v for k, v in finst[0].items() if k != 'minVisits'}] + finst[1:]))
    case('fleet-refuse-tank-zero', 'fleetSize', fone({'deckAreaM2': 1, 'deckWeightT': 0, 'bulk': {'d': 5}}, vessel=dict(fl_v, tanks={'d': 0})))
    case('fleet-refuse-weather-triangle', 'fleetSize', dict(base_f, weather={'factor': {'min': 1, 'mode': 1.2, 'max': 1.5}, 'appliesTo': ['sailing']}))
    case('fleet-refuse-unknown-key', 'fleetSize', dict(base_f, iterations=10))
    case('fleet-refuse-unknown-installation-key', 'fleetSize', dict(base_f, installations=[dict(finst[0], cargo=finst[0]['demand'])] + finst[1:]))
    case('fleet-refuse-period-zero', 'fleetSize', dict(base_f, periodDays=0))
    case('fleet-refuse-demand-missing', 'fleetSize', dict(base_f, installations=[{k: v for k, v in finst[0].items() if k != 'demand'}] + finst[1:]))

    # ---- fleet variability
    var = fx['variability']
    base_mc = dict(base_f, weather={'factor': var['weatherFactor'], 'appliesTo': WX['appliesTo']}, demandFactor=var['demandFactor'],
                   plannedVessels=var['plannedVessels'], iterations=var['iterations'], seed=var['seed'])
    case('ekene-variability-psv-milk-run', 'fleetVariability', base_mc, tol=1e-9)
    case('ekene-variability-ahts-dedicated', 'fleetVariability', dict(base_mc, vessel=ahts, installations=finst_d, route={'mode': 'dedicated'}, iterations=5000, seed=11), tol=1e-9)
    case('variability-fixed-factors-equal-fleet-size', 'fleetVariability', dict(base_mc, weather=WX, demandFactor=1, iterations=50, seed=1), tol=1e-9)
    case('variability-weather-only', 'fleetVariability', dict(base_mc, demandFactor=1, iterations=3000, seed=3), tol=1e-9)
    case('variability-demand-only-fractional', 'fleetVariability', dict(base_mc, weather=WX, voyageRounding='none', vesselRounding='none', iterations=3000, seed=5), tol=1e-9)
    case('variability-planned-zero', 'fleetVariability', dict(base_mc, plannedVessels=0, iterations=500, seed=9), tol=1e-9)
    case('variability-one-iteration', 'fleetVariability', dict(base_mc, iterations=1, seed=0), tol=1e-9)
    at_cap = dict(fone({'deckAreaM2': 400, 'deckWeightT': 0}, portHours=62), demandFactor=1, plannedVessels=2, iterations=20, seed=4)
    case('variability-at-capacity-is-not-short', 'fleetVariability', at_cap, tol=1e-9)
    case('variability-one-vessel-short-always', 'fleetVariability', dict(at_cap, plannedVessels=1), tol=1e-9)
    eleven = [dict(finst_d[i % 4], id=f'I{i + 1:02d}') for i in range(11)]
    case('variability-refuse-draws-cap', 'fleetVariability', dict(base_mc, installations=eleven, route={'mode': 'dedicated'}, iterations=181819))
    case('variability-refuse-seed-missing', 'fleetVariability', {k: v for k, v in base_mc.items() if k != 'seed'})
    case('variability-refuse-seed-negative', 'fleetVariability', dict(base_mc, seed=-1))
    case('variability-refuse-iterations-cap', 'fleetVariability', dict(base_mc, iterations=200001))
    case('variability-refuse-weather-min-below-one', 'fleetVariability', dict(base_mc, weather={'factor': {'min': 0.9, 'mode': 1.2, 'max': 1.5}, 'appliesTo': ['sailing']}))
    case('variability-refuse-weather-max-above-cap', 'fleetVariability', dict(base_mc, weather={'factor': {'min': 1, 'mode': 1.2, 'max': 11}, 'appliesTo': ['sailing']}))
    case('variability-refuse-triangle-order', 'fleetVariability', dict(base_mc, demandFactor={'min': 1, 'mode': 0.9, 'max': 1.3}))
    case('variability-refuse-triangle-shape', 'fleetVariability', dict(base_mc, demandFactor={'min': 1, 'max': 1.3}))
    case('variability-refuse-unknown-triangle-key', 'fleetVariability', dict(base_mc, demandFactor={'min': 1, 'mode': 1.1, 'max': 1.3, 'mean': 1.1}))
    case('variability-refuse-demand-negative', 'fleetVariability', dict(base_mc, demandFactor=-0.1))
    case('variability-refuse-planned-fraction', 'fleetVariability', dict(base_mc, plannedVessels=1.5))

    # ---- deck planning: the Ekene PSV deck
    deck, items = fx['deck'], fx['deckItems']
    case('ekene-deck-one-voyage-ffd', 'deckPlan', {'deck': deck, 'items': items, 'voyages': 1, 'rule': 'first-fit-decreasing-area'})
    case('ekene-deck-one-voyage-first-fit', 'deckPlan', {'deck': deck, 'items': items, 'voyages': 1, 'rule': 'first-fit'})
    case('ekene-deck-two-voyages-ffd', 'deckPlan', {'deck': deck, 'items': items, 'voyages': 2, 'rule': 'first-fit-decreasing-area'})
    case('ekene-deck-light-load-limit', 'deckPlan', {'deck': dict(deck, loadT=300), 'items': items, 'voyages': 2, 'rule': 'first-fit-decreasing-area'})
    case('ffd-wikipedia-cgj-first-fit-order', 'deckPlan', {'deck': {'areaM2': 60, 'usableFraction': 1, 'loadT': 1}, 'items': sized(cgj), 'voyages': 10, 'rule': 'first-fit'})
    case('deck-item-larger-than-deck', 'deckPlan', {'deck': {'areaM2': 20, 'usableFraction': 0.5, 'loadT': 50},
                                                    'items': [{'id': 'big', 'lengthM': 5, 'widthM': 2.5, 'weightT': 5, 'quantity': 1},
                                                              {'id': 'ok', 'lengthM': 2, 'widthM': 2, 'weightT': 1, 'quantity': 2}], 'voyages': 3, 'rule': 'first-fit-decreasing-area'})
    case('deck-item-heavier-than-deck-load', 'deckPlan', {'deck': {'areaM2': 20, 'usableFraction': 1, 'loadT': 10},
                                                          'items': [{'id': 'heavy', 'lengthM': 1, 'widthM': 1, 'weightT': 10.5, 'quantity': 1}], 'voyages': 1, 'rule': 'first-fit'})
    # overflow reasons name the limit that stops the unit (one golden per wording)
    sq = lambda i, l, w, t: {'id': i, 'lengthM': l, 'widthM': w, 'weightT': t, 'quantity': 1}
    d10 = {'areaM2': 10, 'usableFraction': 1, 'loadT': 10}
    case('deck-overflow-area-stops-it', 'deckPlan', {'deck': dict(d10, loadT=100), 'items': [sq('a', 3, 3, 1), sq('b', 2, 1, 1)], 'voyages': 1, 'rule': 'first-fit-decreasing-area'})
    case('deck-overflow-deck-load-stops-it', 'deckPlan', {'deck': d10, 'items': [sq('a', 1, 1, 9), sq('b', 1, 1, 2)], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-overflow-both-stop-it', 'deckPlan', {'deck': d10, 'items': [sq('a', 3, 3, 9), sq('b', 2, 1, 2)], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-overflow-no-one-voyage-has-both', 'deckPlan', {'deck': d10, 'items': [sq('a', 4, 2, 1), sq('b', 1, 1, 9.5), sq('c', 3, 1, 1)], 'voyages': 2, 'rule': 'first-fit'})
    case('deck-overflow-at-exact-remaining-room', 'deckPlan', {'deck': d10, 'items': [sq('a', 3, 3, 9), sq('b', 1, 1, 1), sq('c', 1, 1, 1)], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-exact-fit-inclusive', 'deckPlan', {'deck': {'areaM2': 10, 'usableFraction': 0.5, 'loadT': 3},
                                                  'items': [{'id': 'a', 'lengthM': 2.5, 'widthM': 1, 'weightT': 1.5, 'quantity': 2}], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-decimal-footprints-fill-exactly', 'deckPlan', {'deck': {'areaM2': 0.3, 'usableFraction': 1, 'loadT': 1},
                                                              'items': [{'id': 'a', 'lengthM': 0.1, 'widthM': 1, 'weightT': 0, 'quantity': 1},
                                                                        {'id': 'b', 'lengthM': 0.2, 'widthM': 1, 'weightT': 0, 'quantity': 1}], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-ties-heavier-first-then-id', 'deckPlan', {'deck': {'areaM2': 12, 'usableFraction': 1, 'loadT': 100},
                                                         'items': [{'id': 'b', 'lengthM': 2, 'widthM': 3, 'weightT': 1, 'quantity': 2},
                                                                   {'id': 'a', 'lengthM': 3, 'widthM': 2, 'weightT': 1, 'quantity': 1},
                                                                   {'id': 'c', 'lengthM': 6, 'widthM': 1, 'weightT': 4, 'quantity': 1}], 'voyages': 2, 'rule': 'first-fit-decreasing-area'})
    case('deck-refuse-rule', 'deckPlan', {'deck': deck, 'items': items, 'voyages': 1, 'rule': 'best-fit'})
    case('deck-refuse-voyages-zero', 'deckPlan', {'deck': deck, 'items': items, 'voyages': 0, 'rule': 'first-fit'})
    case('deck-refuse-quantity-fraction', 'deckPlan', {'deck': deck, 'items': [dict(items[0], quantity=1.5)], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-refuse-width-zero', 'deckPlan', {'deck': deck, 'items': [dict(items[0], widthM=0)], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-refuse-usable-missing', 'deckPlan', {'deck': {'areaM2': 800, 'loadT': 2000}, 'items': items, 'voyages': 1, 'rule': 'first-fit'})
    case('deck-refuse-units-cap', 'deckPlan', {'deck': deck, 'items': [dict(items[0], quantity=1000), dict(items[1], quantity=1000), dict(items[2], quantity=1)],
                                               'voyages': 1, 'rule': 'first-fit'})
    case('deck-refuse-unknown-item-key', 'deckPlan', {'deck': deck, 'items': [dict(items[0], heightM=2)], 'voyages': 1, 'rule': 'first-fit'})
    case('deck-refuse-unknown-deck-key', 'deckPlan', {'deck': dict(deck, stowageFactor=0.8), 'items': items, 'voyages': 1, 'rule': 'first-fit'})
    case('deck-refuse-item-repeat', 'deckPlan', {'deck': deck, 'items': [items[0], items[0]], 'voyages': 1, 'rule': 'first-fit'})

    # ---- shore base: the Ekene supply base
    sb = {k: v for k, v in fx['shoreBase'].items() if k != 'name'}
    case('ekene-base-mmc', 'shoreBase', dict(sb, model='M/M/c'))
    case('ekene-base-mdc', 'shoreBase', dict(sb, model='M/D/c'))
    case('ekene-base-mmc-target-one-hour', 'shoreBase', dict(sb, model='M/M/c', targetMeanWaitHours=1))
    case('ekene-base-mdc-target-one-hour', 'shoreBase', dict(sb, model='M/D/c', targetMeanWaitHours=1))
    case('ekene-base-sequential-service', 'shoreBase', dict(sb, model='M/M/c', service=dict(sb['service'], concurrent=False)))
    case('ekene-base-twelve-hour-day', 'shoreBase', dict(sb, model='M/M/c', workingHoursPerDay=12, berths=3))
    case('base-md1-pollaczek-khinchin', 'shoreBase', {'berths': 1, 'arrivalsPerDay': 9, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/D/c'})
    case('base-mdc-three-berths', 'shoreBase', {'berths': 3, 'arrivalsPerDay': 24, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/D/c'})
    case('base-target-met-exactly-by-current', 'shoreBase', {'berths': 1, 'arrivalsPerDay': 9, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/M/c',
                                                             'targetMeanWaitHours': 9})
    case('base-target-zero-unreachable', 'shoreBase', {'berths': 1, 'arrivalsPerDay': 9, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/M/c',
                                                       'targetMeanWaitHours': 0})
    case('base-just-below-saturation', 'shoreBase', {'berths': 2, 'arrivalsPerDay': 19.99, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/M/c'})
    case('base-refuse-saturated-exactly', 'shoreBase', {'berths': 2, 'arrivalsPerDay': 20, 'workingHoursPerDay': 10, 'service': unit_service, 'model': 'M/M/c'})
    case('base-refuse-saturated-thirds', 'shoreBase', {'berths': 2, 'arrivalsPerDay': 30, 'workingHoursPerDay': 10, 'service': dict(unit_service, fixedHours=0.75),
                                                       'model': 'M/D/c'})
    case('base-refuse-ekene-one-berth-overloaded', 'shoreBase', dict(sb, berths=1, model='M/M/c'))
    case('base-refuse-service-zero', 'shoreBase', {'berths': 2, 'arrivalsPerDay': 2, 'workingHoursPerDay': 10, 'service': dict(unit_service, fixedHours=0), 'model': 'M/M/c'})
    case('base-refuse-model', 'shoreBase', dict(sb, model='M/G/c'))
    case('base-refuse-concurrent-missing', 'shoreBase', dict(sb, service={k: v for k, v in sb['service'].items() if k != 'concurrent'}, model='M/M/c'))
    case('base-refuse-working-hours', 'shoreBase', dict(sb, workingHoursPerDay=25, model='M/M/c'))
    case('base-refuse-berths-zero', 'shoreBase', dict(sb, berths=0, model='M/M/c'))
    case('base-refuse-berths-cap', 'shoreBase', dict(sb, berths=101, model='M/M/c'))
    case('base-refuse-lift-rate-zero', 'shoreBase', dict(sb, service=dict(sb['service'], liftsPerHour=0), model='M/M/c'))
    case('base-refuse-target-negative', 'shoreBase', dict(sb, model='M/M/c', targetMeanWaitHours=-1))
    case('base-refuse-unknown-key', 'shoreBase', dict(sb, model='M/M/c', servers=2))
    case('base-refuse-unknown-service-key', 'shoreBase', dict(sb, model='M/M/c', service=dict(sb['service'], craneRate=12)))
    return ek_f


def main():
    try:
        build()
    except Tie as t:
        sys.stderr.write(f'STOP: {t}\n')
        sys.exit(2)
    ids = [c['id'] for c in CASES]
    if len(set(ids)) != len(ids):
        sys.exit('duplicate case ids')
    doc = {
        'module': 'marineLogistics',
        'generatedBy': 'tools/validation/supplychain/oracle_marine.py',
        'engine': 'engines/supplychain/marineLogistics.js',
        'tolerance': {'absoluteFloor': 1e-9, 'note': 'relative tol per case (1e-12, Monte Carlo 1e-9); absolute floor 1e-9'},
        'cases': CASES,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(doc, f, indent=1, ensure_ascii=True, allow_nan=False)
        f.write('\n')
    n_err = sum(1 for c in CASES if isinstance(c['expected'], dict) and c['expected'].get('error') is True)
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {len(CASES)} cases, {n_err} refusals')


if __name__ == '__main__':
    main()
