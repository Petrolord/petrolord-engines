#!/usr/bin/env python3
"""Write the synthetic Ekene offshore logistics fixtures for
engines/supplychain/marineLogistics.js (Supply Chain SC4).

    python3 tools/validation/supplychain/make_marine_fixtures.py

SYNTHETIC teaching data, ours. The Ekene field is Petrolord's fictional
teaching field; here it is given a fictional offshore cluster (a production
platform, a wellhead platform, a jack-up drilling unit and an FPSO) supplied
from a fictional supply base. No real company, vessel, port, installation or
contract appears; every name carries the word "synthetic". Vessel figures sit
inside the ranges the cited sources print (Aas, Halskau and Wallace 2009:
economical speed 11 to 13 knots, deck areas of 526 to 725 m2 and over 726 m2;
Skoko et al. 2024: sailing fuel 0.5 t/h, port 0.03 t/h, fuel USD 870 a tonne).

Every figure is typed below by hand (no randomness), so re-running this
script reproduces the file byte for byte. It checks nothing about the engine;
the oracle (oracle_marine.py) computes every expected value.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'supplychain', 'ekene-marine')
SYN = ('SYNTHETIC teaching data for the Ekene field (Petrolord fictional teaching field, block EK-11), '
       'given a fictional offshore cluster. No real company, vessel, port, installation or contract appears.')
GEN = 'tools/validation/supplychain/make_marine_fixtures.py'

PRODUCTS = [
    {'id': 'diesel', 'name': 'Marine gas oil for the installations', 'kind': 'liquid', 'densityTPerM3': 0.85},
    {'id': 'water', 'name': 'Potable and drill water', 'kind': 'liquid', 'densityTPerM3': 1},
    {'id': 'mud', 'name': 'Pre-mixed water-based mud', 'kind': 'liquid', 'densityTPerM3': 1.4},
    {'id': 'brine', 'name': 'Completion brine', 'kind': 'liquid', 'densityTPerM3': 1.2},
    {'id': 'cement', 'name': 'Oilwell cement (dry bulk)', 'kind': 'dry', 'densityTPerM3': 1.5},
    {'id': 'barite', 'name': 'Barite (dry bulk)', 'kind': 'dry', 'densityTPerM3': 2.1},
]

PSV = {
    'name': 'PSV Ekene Star (synthetic)', 'speedKnots': 11, 'deckAreaM2': 800, 'deckUsableFraction': 0.75,
    'deckLoadT': 2000, 'deadweightT': 3500,
    'tanks': {'diesel': 800, 'water': 1200, 'mud': 600, 'brine': 400, 'cement': 250, 'barite': 250},
    'fuelTPerHour': {'sailing': 0.5, 'port': 0.03, 'field': 0.3},
}
AHTS = {
    'name': 'AHTS Ekene Tide (synthetic)', 'speedKnots': 12, 'deckAreaM2': 550, 'deckUsableFraction': 0.75,
    'deckLoadT': 1200, 'deadweightT': 2200,
    'tanks': {'diesel': 700, 'water': 600, 'mud': 300, 'brine': 200, 'cement': 150, 'barite': 150},
    'fuelTPerHour': {'sailing': 0.6, 'port': 0.04, 'field': 0.4},
}


def bulk(**kw):
    return {k: v for k, v in kw.items()}


# weekly demand and the cargo of one planned voyage (a third of the week for
# the drilling unit, half for the platforms), typed by hand
INSTALLATIONS = [
    {'id': 'EKA', 'name': 'Ekene-A production platform (synthetic)', 'distanceFromBaseNm': 62, 'fieldHours': 6, 'minVisits': 2,
     'demand': {'deckAreaM2': 520, 'deckWeightT': 610, 'bulk': bulk(diesel=450, water=900)},
     'voyageCargo': {'deckAreaM2': 175, 'deckWeightT': 205, 'bulk': bulk(diesel=150, water=300)}},
    {'id': 'EKJ', 'name': 'Ekene jack-up drilling unit (synthetic)', 'distanceFromBaseNm': 68, 'fieldHours': 8, 'minVisits': 3,
     'demand': {'deckAreaM2': 900, 'deckWeightT': 1100, 'bulk': bulk(diesel=500, water=700, mud=600, brine=250, cement=180, barite=200)},
     'voyageCargo': {'deckAreaM2': 215, 'deckWeightT': 300, 'bulk': bulk(diesel=170, water=240, mud=200, brine=85, cement=60, barite=70)}},
    {'id': 'EKB', 'name': 'Ekene-B wellhead platform (synthetic)', 'distanceFromBaseNm': 74, 'fieldHours': 4, 'minVisits': 1,
     'demand': {'deckAreaM2': 180, 'deckWeightT': 150, 'bulk': bulk(diesel=120, water=200)},
     'voyageCargo': {'deckAreaM2': 60, 'deckWeightT': 50, 'bulk': bulk(diesel=40, water=70)}},
    {'id': 'EKF', 'name': 'Ekene FPSO (synthetic)', 'distanceFromBaseNm': 95, 'fieldHours': 5, 'minVisits': 2,
     'demand': {'deckAreaM2': 260, 'deckWeightT': 240, 'bulk': bulk(diesel=300, water=400)},
     'voyageCargo': {'deckAreaM2': 90, 'deckWeightT': 80, 'bulk': bulk(diesel=100, water=135)}},
]

MILK_RUN = {'mode': 'milk-run', 'stops': ['EKA', 'EKJ', 'EKB', 'EKF'], 'legsNm': [62, 9, 12, 28, 95]}

# deck cargo for one voyage of the PSV in the order it was booked (smallest
# first): chemical IBCs, skips, containers, baskets, mud tanks and casing
# bundles (footprints length x width in metres, weights in tonnes)
DECK_ITEMS = [
    {'id': 'chem-ibc', 'name': 'Chemical IBC in a frame (synthetic)', 'lengthM': 1.2, 'widthM': 1, 'weightT': 1.3, 'quantity': 12},
    {'id': 'skip', 'name': 'Waste skip (synthetic)', 'lengthM': 2.5, 'widthM': 1.8, 'weightT': 3, 'quantity': 6},
    {'id': 'cont-10', 'name': '10 ft offshore container (synthetic)', 'lengthM': 2.99, 'widthM': 2.44, 'weightT': 8, 'quantity': 12},
    {'id': 'basket-6m', 'name': '6 m cargo basket (synthetic)', 'lengthM': 6, 'widthM': 2.5, 'weightT': 6, 'quantity': 8},
    {'id': 'mud-tank', 'name': 'Portable mud tank (synthetic)', 'lengthM': 5, 'widthM': 2.4, 'weightT': 14, 'quantity': 5},
    {'id': 'cont-20', 'name': '20 ft offshore container (synthetic)', 'lengthM': 6.06, 'widthM': 2.44, 'weightT': 12, 'quantity': 16},
    {'id': 'pipe-bundle', 'name': 'Casing joints, 13-3/8 in, bundled (synthetic)', 'lengthM': 13.5, 'widthM': 2.6, 'weightT': 38, 'quantity': 2},
]

SHORE_BASE = {
    'name': 'Ekene supply base (synthetic)',
    'berths': 2, 'arrivalsPerDay': 3.2, 'workingHoursPerDay': 24,
    'service': {'fixedHours': 2, 'lifts': 60, 'liftsPerHour': 12, 'bulkM3': 900, 'bulkM3PerHour': 150, 'concurrent': True},
}


def main():
    os.makedirs(OUT, exist_ok=True)
    doc = {
        'synthetic': SYN,
        'generatedBy': GEN,
        'title': 'Ekene offshore cluster supply (synthetic): one PSV and one AHTS from the Ekene supply base',
        'products': PRODUCTS,
        'vessels': {'psv': PSV, 'ahts': AHTS},
        'installations': INSTALLATIONS,
        'milkRun': MILK_RUN,
        'portHours': 12,
        'weather': {'factor': 1.2, 'appliesTo': ['sailing', 'field'], 'note': 'rainy-season allowance, a stated planning factor'},
        'fuelPricePerT': 870,
        'period': {'periodDays': 7, 'vesselAvailableDays': 6.5, 'note': 'one week; half a day a week held for crew change and maintenance'},
        'variability': {'weatherFactor': {'min': 1, 'mode': 1.2, 'max': 1.6}, 'demandFactor': {'min': 0.85, 'mode': 1, 'max': 1.3},
                        'plannedVessels': 2, 'iterations': 20000, 'seed': 20260927},
        'deck': {'name': 'PSV Ekene Star clear deck (synthetic)', 'areaM2': 800, 'usableFraction': 0.75, 'loadT': 2000},
        'deckItems': DECK_ITEMS,
        'shoreBase': SHORE_BASE,
    }
    with open(os.path.join(OUT, 'marine.json'), 'w') as f:
        json.dump(doc, f, indent=1, ensure_ascii=True)
        f.write('\n')
    print('wrote', os.path.relpath(os.path.join(OUT, 'marine.json'), ROOT))


if __name__ == '__main__':
    main()
