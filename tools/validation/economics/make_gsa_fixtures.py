#!/usr/bin/env python3
"""Write the synthetic Ekene gas sales agreement fixtures (Economics EC8).

    python3 tools/validation/economics/make_gsa_fixtures.py

Writes test-data/economics/ekene-gsa/domestic-power.json and export-feed.json.
Every figure is OURS and synthetic: the Ekene licence's gas (onshore, the
same terrain as the EC7 Ekene onshore cases) sold to a synthetic domestic
power plant and a synthetic export feed-gas buyer. No real company, plant,
contract or market series. The only regulatory figure carried is the
domestic base price US$2.18/MMBtu effective 1 April 2026, as REPORTED
(BusinessDay 31 March 2026; Advocaat Law Practice via Legal 500, 7 April
2026; the regulator's own circular was not retrieved): the fixture holds it
flat for every contract year as a stated planning assumption, because the
Authority re-determines it each year (PIA s.167(1)).

The index series is a deterministic synthetic curve (two sines, rounded to
cents); it is not market data.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'ekene-gsa')
GEN = 'tools/validation/economics/make_gsa_fixtures.py'
SYN = 'SYNTHETIC teaching data for the Ekene field (ours). No real company, plant, contract, price series or regulator allocation.'


def leap(y):
    return (y % 4 == 0 and y % 100 != 0) or y % 400 == 0


def days_in(y):
    return 366 if leap(y) else 365


def brent_like():
    """Monthly synthetic oil index, 2025-01 to 2036-12, US$/bbl, cents."""
    out = []
    for t in range(12 * 12):
        y, m = 2025 + t // 12, t % 12 + 1
        v = 72 + 16 * math.sin(2 * math.pi * t / 46) + 4 * math.sin(2 * math.pi * t / 7)
        out.append({'month': f'{y:04d}-{m:02d}', 'values': {'oil': round(v, 2)}})
    return out


def power():
    dcq = 21000
    dbp = 2.18
    years = list(range(2027, 2035))
    taken = {2027: 7245000, 2028: 5460000, 2029: 7875000, 2030: 7665000, 2031: 7933800, 2032: 6148800, 2033: 5775000, 2034: 7770000}
    fm = {2027: 42000}
    sfq = {2027: 6300}
    rows = []
    for y in years:
        r = {'year': y, 'acq': dcq * days_in(y), 'taken': taken[y], 'contractPrice': dbp, 'topPrice': dbp, 'makeUpPrice': 0}
        if y in fm:
            r['forceMajeure'] = fm[y]
        if y in sfq:
            r['sellerShortfall'] = sfq[y]
            r['shortfallPrice'] = 1.25
        rows.append(r)
    # January 2027, day by day
    base = [20790, 21110, 20950, 21420, 0, 21630, 20690, 21210, 20900, 21320,
            21000, 0, 0, 21530, 20840, 21160, 20580, 21260, 21050, 22050,
            20740, 21370, 20900, 21110, 24150, 21000, 20790, 10500, 21210, 21000, 20950]
    days = []
    for i, nom in enumerate(base):
        d = {'date': f'2027-01-{i + 1:02d}', 'nominated': nom, 'available': min(nom, 23100), 'taken': min(nom, 23100)}
        if i in (11, 12):  # 12 and 13 January: pipeline force majeure, whole DCQ
            d.update(forceMajeure=21000)
        if i == 19:  # 20 January: seller shortfall
            d.update(available=15750, taken=15750)
        if i == 27:  # 28 January: scheduled maintenance 10,000
            d.update(maintenance=10500)
        if i == 29:  # 30 January: buyer's facilities could not accept
            d.update(available=12600, taken=12600, buyerCaused=True)
        days.append(d)
    return {
        'synthetic': SYN,
        'generatedBy': GEN,
        'title': 'Ekene gas to the Ekene Power Plant (synthetic), a domestic power sector GSA 2027 to 2034',
        'seller': 'Ekene licence gas, onshore (synthetic)',
        'buyer': {'name': 'Ekene Power Plant (synthetic)', 'sector': 'power'},
        'units': {'quantity': 'MMBtu', 'price': 'US$ per MMBtu'},
        'energy': {'dcqMMscf': 20, 'heatingValue': 1050, 'heatingValueUnit': 'Btu/scf', 'heatingValueBasis': 'gross', 'referenceConditions': '60 F and 14.696 psia (synthetic statement)'},
        'dcq': dcq, 'maxDcqPct': 110, 'topPct': 80,
        'makeUp': {'periodYears': 3, 'order': 'after-adjusted-acq', 'endOfTerm': 'forfeit'},
        'domesticBasePrice': {'value': dbp, 'note': 'reported 2026 domestic base price (effective 1 April 2026) held flat as a planning assumption; the Authority re-determines it each year (PIA s.167(1))'},
        'shortfallPriceNote': 'seller shortfall liquidated damages at a stated 1.25 US$ per MMBtu not made available (synthetic contract term)',
        'years': rows,
        'january2027': {'dcq': dcq, 'maxDcqPct': 110, 'days': days},
        'dgdo': {'year': 2028, 'obligation': 6825000, 'delivered': 5460000, 'excused': {'purchaserCannotAccept': 688800}, 'note': 'synthetic allocation; the plant outage of 2028 is the purchaser\'s inability to accept (s.110(10)(b))'},
        'royalty': {'terrain': 'onshore', 'inCountrySharePct': 100},
        'discountRate': 0.1, 'baseYear': 2026,
    }


def export():
    dcq = 63000
    years = list(range(2027, 2037))
    taken_pct = {2027: 1.0, 2028: 0.97, 2029: 0.62, 2030: 0.93, 2031: 1.04, 2032: 0.85, 2033: 1.02, 2034: 0.99, 2035: 0.8, 2036: 0.93}
    fm = {2030: 1260000}
    rows = []
    for y in years:
        acq = dcq * days_in(y)
        r = {'year': y, 'acq': acq, 'taken': int(round(acq * taken_pct[y] / 1000.0)) * 1000}
        if y in fm:
            r['forceMajeure'] = fm[y]
        rows.append(r)
    return {
        'synthetic': SYN,
        'generatedBy': GEN,
        'title': 'Ekene gas to an export feed-gas buyer (synthetic), an oil-indexed GSA 2027 to 2036',
        'seller': 'Ekene licence gas, onshore (synthetic)',
        'buyer': {'name': 'Ekene Export Feed Buyer (synthetic)', 'sector': 'export'},
        'units': {'quantity': 'MMBtu', 'price': 'US$ per MMBtu', 'index': 'US$ per barrel'},
        'energy': {'dcqMMscf': 60, 'heatingValue': 1050, 'heatingValueUnit': 'Btu/scf', 'heatingValueBasis': 'gross', 'referenceConditions': '60 F and 14.696 psia (synthetic statement)'},
        'dcq': dcq, 'maxDcqPct': 105, 'topPct': 90,
        'makeUp': {'periodYears': 5, 'order': 'after-top-quantity', 'endOfTerm': 'refund'},
        'carryForward': {'periodYears': 3, 'base': 'top-quantity', 'capPct': 50},
        'makeUpPricePct': 10,
        'price': {
            'formula': {'type': 'oil-indexed', 'index': 'oil', 'slope': 0.12, 'constant': 0.5, 'sCurve': {'lowKink': 55, 'highKink': 90, 'lowSlope': 0.06, 'highSlope': 0.06}},
            'averagingMonths': 6, 'lagMonths': 1, 'resetMonths': 3, 'from': '2027-01', 'to': '2036-12', 'rounding': 'model-gsa-4dp',
            'reopeners': ['2031-01', '2035-01'],
            'topPriceRule': 'annual average of the monthly contract prices (CW GSA Article 15.2.6 Alternative 1)',
        },
        'index': brent_like(),
        'years': rows,
        'royalty': {'terrain': 'onshore', 'inCountrySharePct': 0},
        'discountRate': 0.1, 'baseYear': 2026,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, doc in (('domestic-power.json', power()), ('export-feed.json', export())):
        with open(os.path.join(OUT, name), 'w') as f:
            json.dump(doc, f, indent=1, ensure_ascii=True)
            f.write('\n')
        print('wrote', os.path.join('test-data', 'economics', 'ekene-gsa', name))


if __name__ == '__main__':
    main()
