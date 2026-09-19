#!/usr/bin/env python3
"""Oracle for engines/downstream/terminalDepot.js (MD3-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. STRAPPING. A vertical cylinder's volume is pi D^2 h / 4, exactly linear in
    height, so a table built from it and interpolated linearly must return
    the GEOMETRY at every dip. That is a check against a physical tank, not
    against another interpolation. For a HORIZONTAL cylinder, whose volume is
    not linear in height, the oracle keeps its own interpolation (a search
    over entries, never the engine's loop) and also records the geometric
    truth so the interpolation error is visible.
 2. ERLANG C is computed from the FACTORIAL FORM in exact rational arithmetic:
    C = (A^c/c! * c/(c - A)) / (sum_{k<c} A^k/k! + A^c/c! * c/(c - A)).
    The engine builds it from the Erlang B recursion in floating point.
    Waiting time Wq = C / (c mu - lambda), queue length by LITTLE'S LAW,
    Lq = lambda Wq, which the engine does not use.
 3. THE RECONCILIATION is a day ledger: opening, each movement, expected
    close, dipped close.
 4. WHAT IS PINNED, NOT VALIDATED: the ASTM D1250 / API 11.1 FORM of the
    volume correction (exp(-a dT (1 + 0.8 a dT)), a = K0/rho^2 + K1/rho + K2,
    base 15 C). No published coefficient row is in this repository and none
    is quoted from memory; the cases use SYNTHETIC coefficients and the
    constant-free invariants (VCF = 1 exactly at 15 C, below 1 above it for a
    positive a) are what the gate asserts.

The first terminal is the Suite page's default tank T-01 (src/contexts/
TerminalDepotContext.jsx: 5,000 m3 over 12,000 mm in 21 entries, dip
7,200 mm, water 60 mm), labelled there as a sample.

stdlib only. Writes test-data/downstream/goldens/terminaldepot_cases.json
"""

import json
import math
import os
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'terminaldepot_cases.json')


def interp(table, h):
    """Own interpolation: find the bracketing pair by search, never by loop order."""
    pts = sorted(table, key=lambda p: p['heightMm'])
    if h < 0:
        return None
    if h < pts[0]['heightMm']:
        return 0.0 if pts[0]['volumeM3'] == 0 else None
    if h > pts[-1]['heightMm']:
        return None
    lo = max((p for p in pts if p['heightMm'] <= h), key=lambda p: p['heightMm'])
    hi = min((p for p in pts if p['heightMm'] >= h), key=lambda p: p['heightMm'])
    if hi['heightMm'] == lo['heightMm']:
        return lo['volumeM3']
    return lo['volumeM3'] + (h - lo['heightMm']) / (hi['heightMm'] - lo['heightMm']) * (hi['volumeM3'] - lo['volumeM3'])


def vertical_table(diameter_m, height_mm, step_mm):
    area = math.pi * diameter_m ** 2 / 4
    return [{'heightMm': h, 'volumeM3': area * h / 1000} for h in range(0, height_mm + 1, step_mm)], area


def horizontal_volume(diameter_m, length_m, h_mm):
    r = diameter_m / 2
    h = h_mm / 1000
    return length_m * (r * r * math.acos((r - h) / r) - (r - h) * math.sqrt(2 * r * h - h * h))


def erlang_exact(lam, mu, c):
    lam, mu = F(lam), F(mu)
    A = lam / mu
    if A >= c:
        return None
    term = lambda k: A ** k / math.factorial(k)  # noqa: E731
    top = term(c) * F(c) / (c - A)
    C = top / (sum(term(k) for k in range(c)) + top)
    Wq_h = C / (c * mu - lam)
    return {'offered': float(A), 'utilisation': float(A / c), 'probabilityOfWaiting': float(C),
            'averageWaitMinutes': float(Wq_h * 60), 'queueLength': float(lam * Wq_h)}


def main():
    suite = [{'heightMm': round(i / 20 * 12000), 'volumeM3': round(i / 20 * 5000)} for i in range(21)]
    vt, area = vertical_table(20.0, 15000, 250)
    horiz = [{'heightMm': h, 'volumeM3': horizontal_volume(3.0, 12.0, h)} for h in range(0, 3001, 250)]

    dips = [
        {'name': 'Suite default T-01 at 7,200 mm with 60 mm of water', 'table': suite, 'dip': 7200, 'water': 60,
         'gross': interp(suite, 7200) - interp(suite, 60)},
        {'name': 'vertical cylinder, 20 m, dip between entries', 'table': vt, 'dip': 6137, 'water': 0,
         'gross': area * 6.137, 'geometry': area * 6.137},
        {'name': 'vertical cylinder, water between entries', 'table': vt, 'dip': 9421, 'water': 187,
         'gross': area * (9.421 - 0.187), 'geometry': area * (9.421 - 0.187)},
        {'name': 'horizontal cylinder, 3 m by 12 m, dip 1,730 mm', 'table': horiz, 'dip': 1730, 'water': 0,
         'gross': interp(horiz, 1730), 'geometry': horizontal_volume(3.0, 12.0, 1730)},
    ]
    refusals = [
        {'name': 'dip below a table that starts above the floor',
         'table': [{'heightMm': 100, 'volumeM3': 10}, {'heightMm': 1000, 'volumeM3': 100}], 'dip': 50, 'water': 0},
        {'name': 'water above the product dip', 'table': suite, 'dip': 500, 'water': 800},
        {'name': 'a negative dip', 'table': suite, 'dip': -5, 'water': 0},
        {'name': 'a water cut the table cannot convert (below a table that starts above the floor)',
         'table': [{'heightMm': 100, 'volumeM3': 10}, {'heightMm': 1000, 'volumeM3': 100}], 'dip': 500, 'water': 50},
    ]

    queues = []
    for name, lam, load, bays in [('Suite default rack: 5 trucks an hour, 22 minutes, 2 bays', 5, 22, 2),
                                  ('busy rack: 11 an hour, 25 minutes, 5 bays', 11, 25, 5),
                                  ('one bay at 80 percent', 4, 12, 1),
                                  ('forecourt peak: 150 an hour, 2.25 minutes, 6 nozzles', 150, F(9, 4), 6)]:
        mu = F(60) / F(load)
        queues.append({'name': name, 'arrivalsPerHour': lam, 'loadMinutes': float(load), 'bays': bays,
                       **erlang_exact(lam, mu, bays)})

    # day ledger: opening stock from yesterday's close, movements, the dip
    days = []
    for name, opening, rec, dlv, known, dipped, tol in [
        ('a loss beyond tolerance', 3450.0, 800.0, 640.0, 2.0, 3600.0, 0.5),
        ('a gain inside tolerance', 3450.0, 800.0, 640.0, 2.0, 3611.0, 0.5),
        ('no movement, a small gain, so zero tolerance', 3450.0, 0.0, 0.0, 0.0, 3450.5, 0.5),
    ]:
        expected = opening + rec - dlv - known
        gap = dipped - expected
        through = rec + dlv
        days.append({'name': name, 'openingM3': opening, 'receiptsM3': rec, 'deliveriesM3': dlv,
                     'knownLossM3': known, 'closingDippedM3': dipped, 'tolerancePercentOfThroughput': tol,
                     'expectedClosingM3': expected, 'unaccountedM3': gap,
                     'withinTolerance': abs(gap) <= through * tol / 100,
                     'direction': 'balanced' if abs(gap) <= 1e-9 else ('gain' if gap > 0 else 'loss')})

    farm_tanks = [{'capacityM3': 5000, 'heelM3': 120, 'stockM3': 90},
                  {'capacityM3': 3000, 'heelM3': 80, 'stockM3': 1200}]
    farm = {'tanks': farm_tanks, 'dailyThroughputM3': 1440,
            'pumpableStockM3': sum(max(0, t['stockM3'] - t['heelM3']) for t in farm_tanks),
            'ullageM3': sum(max(0, t['capacityM3'] - t['stockM3']) for t in farm_tanks)}
    farm['daysOfCover'] = farm['pumpableStockM3'] / farm['dailyThroughputM3']

    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_terminaldepot.py',
            'method': 'strapping from tank geometry; Erlang C by the exact factorial form and Little\'s law; a day ledger',
            'engine': 'engines/downstream/terminalDepot.js',
            'published': 'none: no coefficient table is shipped; tanks are geometric or the Suite sample',
        },
        'dips': dips, 'refusals': refusals, 'queues': queues, 'days': days, 'farm': farm,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    for q in queues:
        print(q['name'], round(q['probabilityOfWaiting'], 6), round(q['averageWaitMinutes'], 4))
    for d in dips:
        print(d['name'], round(d['gross'], 4), d.get('geometry') and round(d['geometry'], 4))


if __name__ == '__main__':
    main()
