#!/usr/bin/env python3
"""Oracle for engines/downstream/fuelPricing.js (MD3-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. THE LANDED COST is written as a CARGO INVOICE, line by line in dollars,
    from the cargo's tonnes, cubic metres, litres and barrels. The cost per
    litre SOLD is the invoice over the OUTTURN litres (bill-of-lading litres
    less the ocean loss), never the invoice per bill-of-lading litre grossed
    up.
 2. INSURANCE ON CIF is circular (the premium is part of the value it is
    levied on). The engine solves it in closed form; this file ITERATES the
    fixed point I = r (C&F + I) until it stops moving. The two meet only in
    the answer.
 3. THE PUMP PRICE is a waterfall walked here element by element; the
    exchange rate at which a cap stops covering it is found in CLOSED FORM
    (the price is linear in the rate), where the engine bisects.
 4. THE TRUCK LANE is a per-trip ledger; the FLEET is sized by INTEGER SEARCH
    (the smallest fleet whose trips cover demand), where the engine takes a
    ceiling.
 5. THE STATION queue is the exact factorial Erlang C of
    oracle_terminaldepot.erlang_exact, shared because it is the oracle, not
    the engine.

WHAT IS PINNED: nothing numeric beyond definitions (1000 litres a cubic
metre, 0.158987294928 cubic metres a barrel). Every rate here is SYNTHETIC
and labelled so: the engine ships no rates and neither does this file.

The first cases are the Suite page defaults (src/contexts/
FuelPricingContext.jsx): a 37,000 tonne PMS cargo at 745 kg/m3, FOB 700 a
tonne, 0.5 percent ocean loss, 1,550 to the dollar, and the page's truck lane
and station, with the page's rates left blank (a FLOOR) and then supplied.

stdlib only. Writes test-data/downstream/goldens/fuelpricing_cases.json
"""

import json
import math
import os
import sys
from fractions import Fraction as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle_terminaldepot import erlang_exact  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'fuelpricing_cases.json')
M3_PER_BBL = 0.158987294928

TEMPLATE = [  # id, basis, stage (the engine's IMPORT_TEMPLATE shape)
    ('freight', 'per_tonne', 'freight'), ('insurance', 'percent_of_cf', 'insurance'),
    ('duty', 'percent_of_cif', 'landed'), ('port', 'per_tonne', 'landed'),
    ('regulator', 'per_litre', 'landed'), ('jetty', 'per_m3', 'landed'),
    ('storage', 'per_m3', 'landed'), ('finance', 'percent_of_cif', 'landed'),
    ('demurrage', 'per_cargo', 'landed'),
]
RATES = {'freight': 28, 'insurance': 0.15, 'duty': 15, 'port': 3.2, 'regulator': 0.0021,
         'jetty': 1.1, 'storage': 2.4, 'finance': 1.5, 'demurrage': 60000}


def cargo(tonnes, rho):
    m3 = tonnes * 1000 / rho
    return {'tonnes': tonnes, 'm3': m3, 'litres': m3 * 1000, 'bbl': m3 / M3_PER_BBL}


def invoice(tonnes, rho, fob_per_t, rates, loss_pct, fx, insurance_on='percent_of_cf'):
    q = cargo(tonnes, rho)
    fob = fob_per_t * q['tonnes']
    freight = rates['freight'] * q['tonnes'] if rates.get('freight') is not None else None
    cf = fob + (freight or 0)
    if rates.get('insurance') is None:
        ins = None
    elif insurance_on == 'percent_of_cf':
        ins = rates['insurance'] / 100 * cf
    else:
        ins = 0.0
        for _ in range(200):  # fixed point I = r (CF + I)
            nxt = rates['insurance'] / 100 * (cf + ins)
            if abs(nxt - ins) < 1e-12:
                break
            ins = nxt
    cif = cf + (ins or 0)
    per = {'per_tonne': q['tonnes'], 'per_m3': q['m3'], 'per_litre': q['litres'], 'per_cargo': 1}
    lines = {'fob': fob, 'freight': freight, 'insurance': ins}
    for key, basis, stage in TEMPLATE:
        if stage != 'landed':
            continue
        r = rates.get(key)
        if r is None:
            lines[key] = None
        elif basis == 'percent_of_cif':
            lines[key] = r / 100 * cif
        else:
            lines[key] = r * per[basis]
    total = sum(v for v in lines.values() if v is not None)
    outturn_l = q['litres'] * (1 - loss_pct / 100)
    missing = [k for k, v in lines.items() if v is None]
    return {'quantities': q, 'lines': lines, 'cf': cf, 'cif': cif, 'totalUsd': total,
            'outturnLitres': outturn_l, 'perLitreUsd': total / outturn_l,
            'perLitreLocal': total / outturn_l * fx, 'complete': not missing, 'missing': missing}


def lane_ledger(L):
    rt = 2 * L['distanceKm']
    cycle = rt / L['averageSpeedKmh'] + L['loadHours'] + L['dischargeHours'] + L['queueHours']
    trips_day = L['workingHoursPerDay'] / cycle
    trips_year = trips_day * L['workingDaysPerYear']
    diesel_l = L['fuelConsumptionLPer100Km'] / 100 * rt
    items = {
        'Diesel': diesel_l * L['dieselPricePerLitre'],
        'Driver': L['driverCostPerTrip'],
        'Maintenance and tyres': (L['maintenancePerKm'] + L['tyresPerKm']) * rt,
        'Tolls and levies': L['tollsAndLeviesPerTrip'],
        'Overhead': L['overheadPerTrip'],
        'Truck depreciation': L['truckCapitalCost'] / (L['truckLifeYears'] * trips_year),
    }
    delivered = L['payloadLitres'] * (1 - L['transitLossPercent'] / 100)
    trip_cost = sum(items.values())
    return {'cycleHours': cycle, 'tripsPerDay': trips_day, 'tripsPerYear': trips_year, 'items': items,
            'costPerTrip': trip_cost, 'deliveredLitres': delivered, 'costPerLitreDelivered': trip_cost / delivered,
            'dieselLitres': diesel_l}


def fleet_search(demand, payload, trips_per_truck):
    needed = demand / payload
    n = 1
    while n * trips_per_truck < needed:
        n += 1
    return {'tripsNeededPerDay': needed, 'trucksRequired': n, 'utilisation': needed / (n * trips_per_truck)}


def pump(landed_local, elements):
    running = landed_local
    rows = [('landed', 'Product (landed)', landed_local)]
    for key, recipient, basis, amt in elements:
        a = amt / 100 * running if basis == 'percent_of_running' else amt
        running += a
        rows.append((key, recipient, a))
    by = {}
    for key, rec, a in rows:
        by[rec] = by.get(rec, 0) + a
    return {'price': running, 'rows': rows, 'byRecipient': by}


LANE = dict(distanceKm=400, payloadLitres=45000, averageSpeedKmh=40, loadHours=2, dischargeHours=1.5,
            queueHours=1, fuelConsumptionLPer100Km=38, dieselPricePerLitre=1150, driverCostPerTrip=60000,
            maintenancePerKm=45, tyresPerKm=25, overheadPerTrip=40000, tollsAndLeviesPerTrip=25000,
            truckCapitalCost=90000000, truckLifeYears=8, workingHoursPerDay=12, workingDaysPerYear=300,
            transitLossPercent=0.2)


def main():
    floor = invoice(37000, 745, 700, {}, 0.5, 1550)
    full = invoice(37000, 745, 700, RATES, 0.5, 1550)
    on_cif = invoice(37000, 745, 700, RATES, 0.5, 1550, insurance_on='percent_of_cif')
    lane = lane_ledger(LANE)
    fleet = fleet_search(180000, 45000, lane['tripsPerDay'])
    elements = [('depot', 'Terminal', 'per_litre', 25), ('bridging', 'Chain', 'per_litre', 30),
                ('transport', 'Transporter', 'per_litre', round(lane['costPerLitreDelivered'], 4)),
                ('marketer', 'Marketer', 'per_litre', 20), ('dealer', 'Dealer', 'per_litre', 35),
                ('levies', 'Government', 'per_litre', 10), ('vat', 'Government', 'percent_of_running', 7.5)]
    pp = pump(full['perLitreLocal'], elements)
    # breakeven exchange rate in closed form: price(fx) = (usd * fx + fixed) * (1 + vat)
    fixed = sum(a for _, _, b, a in elements if b == 'per_litre')
    vat = next(a for _, _, b, a in elements if b == 'percent_of_running') / 100
    cap = 1400.0
    fx_break = (cap / (1 + vat) - fixed) / full['perLitreUsd']
    # station: the page defaults
    per_txn, rate, over, nozzles = 30, 40, 1.5, 6
    peak = 60000 / per_txn * 0.12
    service = F(per_txn) / F(rate) + F(3, 2)
    q = erlang_exact(F(peak).limit_denominator(), F(60) / service, nozzles)
    usable = 45000 - 3000
    reorder = 3000 + usable * 0.25
    # at the page defaults the peak (240 an hour against 6 nozzles serving 160)
    # is beyond the forecourt: the queue has no steady state and that is the answer
    q = q if q is not None else {'stable': False, 'offered': float(F(peak).limit_denominator() / (F(60) / service))}
    station = {'peakTransactionsPerHour': peak, 'serviceMinutes': float(service), **q,
               'usableTankLitres': usable, 'reorderLevelLitres': reorder, 'ullageAtReorderLitres': 45000 - reorder,
               'payloadFitsUllage': 45000 <= 45000 - reorder}
    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_fuelpricing.py',
            'method': 'a cargo invoice over outturn litres; insurance on CIF by fixed-point iteration; closed-form FX breakeven; integer fleet search; exact Erlang C',
            'engine': 'engines/downstream/fuelPricing.js',
            'published': 'none: every rate is synthetic; the engine ships none and neither does this file',
        },
        'rates': RATES,
        'landed': {'floor': floor, 'full': full, 'insuranceOnCif': on_cif},
        'lane': {'inputs': LANE, **lane},
        'fleet': {'demandLitresPerDay': 180000, **fleet},
        'pump': {'elements': elements, 'price': pp['price'], 'byRecipient': pp['byRecipient'],
                 'cap': cap, 'breakevenFx': fx_break},
        'station': station,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('landed per litre local', round(full['perLitreLocal'], 4), 'floor', round(floor['perLitreLocal'], 4))
    print('insurance on CF', round(full['lines']['insurance'], 2), 'on CIF', round(on_cif['lines']['insurance'], 2))
    print('lane cost/L', round(lane['costPerLitreDelivered'], 4), 'trips/day', round(lane['tripsPerDay'], 6), 'fleet', fleet)
    print('pump price', round(pp['price'], 4), 'breakeven fx', round(fx_break, 4))
    print('station', station)


if __name__ == '__main__':
    main()
