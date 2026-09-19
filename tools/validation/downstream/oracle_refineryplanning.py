#!/usr/bin/env python3
"""Oracle for engines/downstream/refineryPlanning.js and the variance in
streamModel.js (MD2-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. THE PLAN is solved by exact_simplex.py in rational arithmetic and
    accepted only with an exact duality certificate (primal rows and bounds
    hold exactly; every reduced cost has the optimal sign). exact_simplex is
    itself checked against oracle_lp.py's vertex enumeration on all 181 LP
    golden cases. The engine uses a floating-point tableau.
 2. THE RULES the plan is built on are the model's, and are restated here as
    the model defines them, because there is no second way to write "what is
    made less what is used is not negative": a stream balance per stream, and
    (MD2-0) every barrel of crude run through the feedless crude unit. What
    the oracle adds is the CLOSURE CHECK on its own answer, crude in against
    product out plus surplus, stream by stream.
 3. STREAM VALUES are one-sided derivatives of the optimal margin by exact
    RE-SOLVE with one barrel's worth (a tiny exact step) of the stream
    supplied from outside, never read off a dual.
 4. THE SCHEDULE's dates come from Python's calendar (datetime.date plus
    timedelta), which has no time zone to get wrong.
 5. THE VARIANCE is computed from explicit plan and actual ledgers, with
    each gap signed by what it does to margin.

The first case is the Suite page's default plan (src/contexts/
RefineryPlanningContext.jsx), labelled there as illustrative.

stdlib only. Writes test-data/downstream/goldens/refineryplanning_cases.json
"""

import datetime as dt
import json
import os
import sys
from fractions import Fraction as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exact_simplex import solve  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'refineryplanning_cases.json')
STEP = F(1, 10 ** 6)

DEFAULT = {
    'streams': ['naphtha', 'reformate', 'kero', 'gasoil', 'residue', 'offgas'],
    'crudes': [
        {'id': 'crude_a', 'name': 'Light sweet', 'cost': 82, 'available': 3000000,
         'yields': {'naphtha': 0.22, 'kero': 0.15, 'gasoil': 0.33, 'residue': 0.28, 'offgas': 0.02}},
        {'id': 'crude_b', 'name': 'Medium sour', 'cost': 74, 'available': 2000000,
         'yields': {'naphtha': 0.15, 'kero': 0.13, 'gasoil': 0.30, 'residue': 0.40, 'offgas': 0.02}},
    ],
    'units': [
        {'id': 'cdu', 'name': 'Crude distillation', 'capacity': 4000000, 'opex': 1.2, 'feed': '', 'yields': {}},
        {'id': 'reformer', 'name': 'Reformer', 'capacity': 500000, 'opex': 3.0, 'feed': 'naphtha',
         'yields': {'reformate': 0.85, 'offgas': 0.10}},
    ],
    'products': [
        {'id': 'gasoline', 'name': 'Gasoline', 'price': 112, 'minDemand': 0, 'maxDemand': 900000, 'recipe': {'reformate': 1}},
        {'id': 'jet', 'name': 'Jet', 'price': 106, 'minDemand': 0, 'maxDemand': 900000, 'recipe': {'kero': 1}},
        {'id': 'diesel', 'name': 'Diesel', 'price': 101, 'minDemand': 0, 'maxDemand': 2000000, 'recipe': {'gasoil': 1}},
        {'id': 'fuel_oil', 'name': 'Fuel oil', 'price': 62, 'minDemand': 0, 'maxDemand': 2000000, 'recipe': {'residue': 1}},
    ],
}


def fr(v):
    return F(repr(float(v))) if not isinstance(v, int) else F(v)


def build(p, supply=None):
    """The plan LP. `supply` = (stream, extra barrels arriving from outside)."""
    C, U, P = p['crudes'], p['units'], p['products']
    n = len(C) + len(U) + len(P)
    c = [-fr(x['cost']) for x in C] + [-fr(u['opex']) for u in U] + [fr(x['price']) for x in P]
    A, b, ops = [], [], []
    for s in p['streams']:
        row = [fr(x['yields'].get(s, 0)) for x in C]
        row += [fr(u['yields'].get(s, 0)) - (1 if u['feed'] == s else 0) for u in U]
        row += [-fr(x['recipe'].get(s, 0)) for x in P]
        A.append(row)
        b.append(-supply[1] if supply and supply[0] == s else F(0))
        ops.append('>=')
    feedless = [j for j, u in enumerate(U) if not u['feed']]
    if feedless:
        A.append([F(1)] * len(C) + [F(-1) if j in feedless else F(0) for j in range(len(U))] + [F(0)] * len(P))
        b.append(F(0))
        ops.append('=')
    lo = [F(0)] * (len(C) + len(U)) + [fr(x.get('minDemand', 0) or 0) for x in P]
    hi = ([None if x.get('available') is None else fr(x['available']) for x in C]
          + [None if u.get('capacity') is None else fr(u['capacity']) for u in U]
          + [None if x.get('maxDemand') is None else fr(x['maxDemand']) for x in P])
    return c, A, b, ops, lo, hi


def plan(p):
    c, A, b, ops, lo, hi = build(p)
    r = solve(c, A, b, ops, lo, hi, maximize=True)
    out = {'status': r['status']}
    if r['status'] != 'optimal':
        return out
    x = r['x']
    C, U, P = p['crudes'], p['units'], p['products']
    xc, xu, xp = x[:len(C)], x[len(C):len(C) + len(U)], x[len(C) + len(U):]
    # closure: stream by stream, made = consumed + placed + surplus >= 0
    balance = []
    for s in p['streams']:
        made = sum(v * fr(cr['yields'].get(s, 0)) for v, cr in zip(xc, C)) + sum(v * fr(u['yields'].get(s, 0)) for v, u in zip(xu, U))
        consumed = sum(v for v, u in zip(xu, U) if u['feed'] == s)
        placed = sum(v * fr(pr['recipe'].get(s, 0)) for v, pr in zip(xp, P))
        assert made - consumed - placed >= 0
        up = solve(*build(p, (s, STEP)), maximize=True)
        value = (up['objective'] - r['objective']) / STEP if up['status'] == 'optimal' else None
        balance.append({'id': s, 'made': float(made), 'consumed': float(consumed), 'placed': float(placed),
                        'surplus': float(made - consumed - placed), 'marginalValue': None if value is None else float(value)})
    return {
        'status': 'optimal', 'margin': float(r['objective']),
        'crudeRuns': [float(v) for v in xc], 'unitRuns': [float(v) for v in xu], 'productMakes': [float(v) for v in xp],
        'streamBalance': balance,
        'crudeThroughCrudeUnits': float(sum(xc)),
    }


def variant(**changes):
    p = json.loads(json.dumps(DEFAULT))
    for path, value in changes.items():
        kind, ident, field = path.split('.')
        for item in p[kind]:
            if item['id'] == ident:
                item[field] = value
    return p


def schedule_dates(start, period_days, n_cargoes, weeks):
    d0 = dt.date.fromisoformat(start)
    spacing = max(1, period_days // n_cargoes)
    cargo = [(d0 + dt.timedelta(days=min(period_days - 1, k * spacing))).isoformat() for k in range(n_cargoes)]
    runs = [(d0 + dt.timedelta(days=min(period_days - 1, w * 7))).isoformat() for w in range(weeks)]
    lifts = [(d0 + dt.timedelta(days=min(period_days - 1, w * 7 + 6))).isoformat() for w in range(weeks)]
    return cargo, runs, lifts


def variance_case():
    # plan and actual ledgers, one line each for a crude receipt, a unit run and a product lift
    plan_ledger = {('crude_a', 'receipt'): (1000, 80000), ('cdu', 'unit_run'): (1000, 1200), ('jet', 'delivery'): (300, 31800)}
    actual = {('crude_a', 'receipt'): (1100, 93500), ('cdu', 'unit_run'): (1100, 1265), ('jet', 'delivery'): (320, 33280)}
    lines = []
    for k, (pq, pc) in plan_ledger.items():
        aq, ac = actual[k]
        pu, au = pc / pq, ac / aq
        direction = 'revenue' if k[1] == 'delivery' else 'cost'
        sign = 1 if direction == 'revenue' else -1
        lines.append({'materialId': k[0], 'type': k[1], 'plan': [pq, pc], 'actual': [aq, ac],
                      'volumeVariance': (aq - pq) * pu, 'priceVariance': (au - pu) * aq, 'totalVariance': ac - pc,
                      'direction': direction, 'marginEffect': sign * (ac - pc)})
    return {'lines': lines, 'marginEffect': sum(l['marginEffect'] for l in lines),
            'costTotal': sum(l['totalVariance'] for l in lines if l['direction'] == 'cost'),
            'revenueTotal': sum(l['totalVariance'] for l in lines if l['direction'] == 'revenue')}


def main():
    cases = [
        ('Suite default plan', 'the page with nothing typed; the crude unit now carries every barrel', DEFAULT),
        ('reformer shut (capacity typed 0)', 'a typed zero is zero; it used to be an unlimited reformer',
         variant(**{'units.reformer.capacity': 0})),
        ('crude unit at 2,000,000', 'a crude unit capacity that binds', variant(**{'units.cdu.capacity': 2000000})),
        ('light sweet unavailable (typed 0)', 'a crude typed as unavailable', variant(**{'crudes.crude_a.available': 0})),
        ('demand floors on jet and fuel oil', 'floors that force unprofitable barrels',
         variant(**{'products.jet.minDemand': 500000, 'products.fuel_oil.minDemand': 900000})),
        ('jet floor beyond reach', 'infeasible: no plan makes 2 million barrels of jet',
         variant(**{'products.jet.minDemand': 2000000, 'products.jet.maxDemand': 2500000})),
    ]
    out = []
    for name, why, p in cases:
        res = plan(p)
        out.append({'name': name, 'why': why, 'input': p, **res})
    import math
    cargo_size = 400000
    crude_a = out[0]['crudeRuns'][0]
    cargo, runs, lifts = schedule_dates('2026-03-01', 30, max(1, math.ceil(crude_a / cargo_size)), math.ceil(30 / 7))
    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_refineryplanning.py',
            'method': 'exact rational simplex with a duality certificate; stream values by exact re-solve; dates by datetime.date',
            'engine': 'engines/downstream/refineryPlanning.js, engines/downstream/streamModel.js',
            'published': 'none: the default plan is the Suite page default, labelled illustrative there',
        },
        'cases': out,
        'schedule': {'periodStart': '2026-03-01', 'periodDays': 30, 'cargoSize': cargo_size,
                     'why': 'a period that crosses the North American spring daylight-saving change (8 March 2026), where local calendar arithmetic printed in UTC slipped a day',
                     'cargoDates': cargo, 'runDates': runs, 'liftDates': lifts},
        'variance': variance_case(),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    for c in out:
        print(c['name'], c['status'], c.get('margin'), c.get('unitRuns'))


if __name__ == '__main__':
    main()
