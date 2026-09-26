#!/usr/bin/env python3
"""Write the synthetic Ekene tender fixtures for engines/supplychain/tender.js (SC2).

    python3 tools/validation/supplychain/make_tender_fixtures.py

SYNTHETIC teaching data, ours. No real company, person, tender or price list
appears: bidders are codes (WS1..WS6, MS1..MS5) with the word "synthetic" in
their names. Well names and depths follow test-data/ekene-dynamic/field.json
(Ekene-3 and Ekene-5, top of the Ekene Sand near 1,550 m TVD). The Nigerian
content targets named here are Schedule lines of the Nigerian Oil and Gas
Industry Content Development Act 2010; the engine holds the percentages.

Every figure is typed below by hand (no randomness), so re-running this
script reproduces the files byte for byte. It checks nothing about the
engine; the oracle (oracle_tender.py) computes every expected value.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'supplychain', 'ekene-tender')
SYN = ('SYNTHETIC teaching data for the Ekene field (Petrolord fictional teaching field, block EK-11). '
       'No real company, person, tender or price appears.')
GEN = 'tools/validation/supplychain/make_tender_fixtures.py'


def line(i, q, r, amount=None, **kw):
    d = {'id': i, 'quantity': q, 'unitRate': r, 'quotedAmount': q * r if amount is None else amount}
    d.update(kw)
    return d


def mh(n, t):
    return {'measure': 'man-hours', 'nigerian': n, 'total': t}


# ---------------------------------------------------------------- well services
WS_CRITERIA = [
    {'id': 'methodology', 'weight': 30, 'maxScore': 4, 'label': 'Method statement for the cleanout and the acid treatment'},
    {'id': 'personnel', 'weight': 25, 'maxScore': 4, 'label': 'Key personnel: CT supervisor, pumping engineer, HSE lead'},
    {'id': 'equipment', 'weight': 20, 'maxScore': 4, 'label': 'CT unit, pumps and N2 unit: age, certification, back-up'},
    {'id': 'hse', 'weight': 15, 'maxScore': 4, 'label': 'HSE plan for live-well intervention and acid handling'},
    {'id': 'schedule', 'weight': 10, 'maxScore': 4, 'label': 'Mobilisation and work programme'},
]
WS_ITEMS = [
    {'id': 'mob', 'unit': 'lump sum', 'label': 'Mobilisation to Ekene-3'},
    {'id': 'ct-spread', 'unit': 'day', 'label': 'Coiled tubing spread, 18 operating days'},
    {'id': 'pump-spread', 'unit': 'day', 'label': 'Pumping spread, 6 pumping days'},
    {'id': 'acid', 'unit': 'm3', 'label': '15% HCl treating fluid with additives, 60 m3'},
    {'id': 'nitrogen', 'unit': 'thousand scf', 'label': 'Nitrogen for lift and displacement, 120 thousand scf'},
    {'id': 'demob', 'unit': 'lump sum', 'label': 'Demobilisation from Ekene-5'},
]


def ws_bid(bid, name, received, scores, lines, weeks, nc, **kw):
    b = {'id': bid, 'name': name, 'receivedAt': received,
         'mandatory': [{'id': 'bid-security', 'met': True}, {'id': 'signed-bid-form', 'met': True}],
         'scores': dict(zip([c['id'] for c in WS_CRITERIA], scores)),
         'lines': lines, 'completionWeeks': weeks, 'nc': nc,
         'indigenous': False, 'capacity': True}
    b.update(kw)
    return b


WS_BIDS = [
    ws_bid('WS1', 'Bidder WS1 (synthetic)', '2027-02-10T09:12:00Z', [4, 3, 3, 3, 3], [
        line('mob', 1, 120000), line('ct-spread', 18, 28500), line('pump-spread', 6, 21000),
        line('acid', 60, 1450), line('nitrogen', 120, 310), line('demob', 1, 60000)], 6,
        {'coiled-tubing': mh(7800, 10000), 'pumping': mh(2850, 3000), 'stimulation': mh(3400, 4000)},
        discount=15000),
    ws_bid('WS2', 'Bidder WS2 (synthetic)', '2027-02-10T11:40:00Z', [3, 3, 3, 3, 3], [
        line('mob', 1, 95000), line('ct-spread', 18, 27000, amount=468000), line('pump-spread', 6, 19500),
        line('acid', 60, 1400), line('nitrogen', 120, 295), line('demob', 1, 50000)], 8,
        {'coiled-tubing': mh(7000, 10000), 'pumping': mh(2700, 3000), 'stimulation': mh(3500, 4000)},
        indigenous=True,
        deviations=[{'id': 'payment-terms', 'amount': 9500,
                     'reason': 'asks for payment in 30 days where the conditions give 60; priced at the interest on the earlier payment'}]),
    ws_bid('WS3', 'Bidder WS3 (synthetic)', '2027-02-11T08:05:00Z', [3, 4, 3, 4, 3], [
        line('mob', 1, 110000), line('ct-spread', 18, 29500), line('pump-spread', 6, 22000),
        line('acid', 60, 1500), line('demob', 1, 55000)], 7,
        {'coiled-tubing': mh(8200, 10000), 'pumping': mh(2910, 3000), 'stimulation': mh(3600, 4000)},
        omitted=['nitrogen']),
    ws_bid('WS4', 'Bidder WS4 (synthetic)', '2027-02-11T10:30:00Z', [2, 3, 3, 3, 2], [
        line('mob', 1, 80000), line('ct-spread', 18, 24000), line('pump-spread', 6, 17000),
        line('acid', 60, 1300), line('nitrogen', 120, 260), line('demob', 1, 40000)], 7,
        {'coiled-tubing': mh(6000, 10000), 'pumping': mh(2400, 3000), 'stimulation': mh(3000, 4000)}),
    ws_bid('WS5', 'Bidder WS5 (synthetic)', '2027-02-11T15:55:00Z', [3, 3, 2, 3, 3], [
        line('mob', 1, 100000), line('ct-spread', 18, 26000), line('pump-spread', 6, 20000),
        line('acid', 60, 13.8, amount=82800, decimalMisplaced=True), line('nitrogen', 120, 280), line('demob', 1, 45000)], 9,
        {'coiled-tubing': mh(6750, 9000), 'pumping': mh(2850, 3000), 'stimulation': mh(3000, 4000)},
        indigenous=True),
    ws_bid('WS6', 'Bidder WS6 (synthetic)', '2027-02-12T16:59:00Z', [4, 4, 4, 3, 4], [
        line('mob', 1, 130000), line('ct-spread', 18, 30000), line('pump-spread', 6, 23000),
        line('acid', 60, 1550), line('nitrogen', 120, 320), line('demob', 1, 65000)], 6,
        {'coiled-tubing': mh(8000, 10000), 'pumping': mh(2900, 3000), 'stimulation': mh(3500, 4000)},
        mandatory=[{'id': 'bid-security', 'met': True}, {'id': 'signed-bid-form', 'met': False}]),
]

WELL_SERVICES = {
    'synthetic': SYN,
    'generatedBy': GEN,
    'tender': 'EK-11/WS/2027-01',
    'title': 'Ekene-3 and Ekene-5 coiled tubing cleanout and matrix acid stimulation (synthetic)',
    'scope': ('Two producers, Ekene-3 and Ekene-5, top of the Ekene Sand near 1,550 m TVD: rig up coiled tubing, '
              'clean out fill to the perforations, pump a 15% HCl matrix treatment with nitrogen lift, flow back, '
              'move to the second well. Two-envelope process with Rated Criteria.'),
    'criteria': WS_CRITERIA,
    'passMark': 70,
    'items': WS_ITEMS,
    'schedule': {'minWeeks': 6, 'maxWeeks': 10, 'ratePerWeek': 0.005},
    'award': {'basis': 'combined', 'technicalWeight': 0.7, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'relative',
              'risk': 'high', 'estimatedCostUsd': 900000},
    'omissionRule': 'average',
    'nc': {'items': [
        {'id': 'coiled-tubing', 'scheduleLine': 'coiled-tubing-services'},
        {'id': 'pumping', 'scheduleLine': 'pumping-services'},
        {'id': 'stimulation', 'scheduleLine': 'well-overhauling-stimulation-services'},
    ]},
    'bids': WS_BIDS,
    'contracting': {
        'note': 'The same two-well scope under three contract types. Contractor cost = fixed cost + days x daily cost.',
        'duration': {'program': [
            {'id': 'e3-rigup', 'kind': 'flat', 'label': 'Mobilise and rig up on Ekene-3', 'durationHr': 48},
            {'id': 'e3-trip', 'kind': 'trip', 'label': 'Coiled tubing in and out, Ekene-3', 'mdM': 1600, 'tripSpeedMPerHr': 1200},
            {'id': 'e3-clean', 'kind': 'flat', 'label': 'Clean out fill, Ekene-3', 'durationHr': 30},
            {'id': 'e3-acid', 'kind': 'flat', 'label': 'Pump the acid treatment, Ekene-3', 'durationHr': 16},
            {'id': 'e3-flow', 'kind': 'flat', 'label': 'Nitrogen lift and flow back, Ekene-3', 'durationHr': 36},
            {'id': 'move', 'kind': 'flat', 'label': 'Rig down and move to Ekene-5', 'durationHr': 24},
            {'id': 'e5-trip', 'kind': 'trip', 'label': 'Coiled tubing in and out, Ekene-5', 'mdM': 1620, 'tripSpeedMPerHr': 1200},
            {'id': 'e5-clean', 'kind': 'flat', 'label': 'Clean out fill, Ekene-5', 'durationHr': 30},
            {'id': 'e5-acid', 'kind': 'flat', 'label': 'Pump the acid treatment, Ekene-5', 'durationHr': 16},
            {'id': 'e5-flow', 'kind': 'flat', 'label': 'Nitrogen lift and flow back, Ekene-5', 'durationHr': 36},
            {'id': 'demob', 'kind': 'flat', 'label': 'Rig down and demobilise', 'durationHr': 48},
        ], 'nptFrac': {'min': 0.05, 'mode': 0.15, 'max': 0.6}},
        'dailyCost': {'min': 38000, 'mode': 42000, 'max': 55000},
        'fixedCost': 140000,
        'lumpSum': {'price': 900000},
        'dayRate': {'rate': 50000, 'mobilisationFee': 160000},
        'reimbursable': {'feeFraction': 0.12},
        'iterations': 20000,
        'seed': 20270211,
    },
    'shouldCost': {
        'note': 'The company estimate for the same two-well programme, built with engines/drilling/wellCost.js.',
        'nptFrac': 0.15,
        'items': [
            {'id': 'ct-spread', 'label': 'Coiled tubing spread', 'basis': 'per-day', 'rate': 26500, 'category': 'intangible'},
            {'id': 'supervision', 'label': 'Company supervision', 'basis': 'per-day', 'rate': 3500, 'category': 'intangible'},
            {'id': 'pumping', 'label': 'Pumping services', 'basis': 'lump', 'value': 118000, 'category': 'intangible'},
            {'id': 'acid', 'label': 'Acid system', 'basis': 'lump', 'value': 84000, 'category': 'tangible'},
            {'id': 'nitrogen', 'label': 'Nitrogen', 'basis': 'lump', 'value': 36000, 'category': 'tangible'},
            {'id': 'mob-demob', 'label': 'Mobilisation and demobilisation', 'basis': 'lump', 'value': 160000, 'category': 'intangible'},
        ],
        'contingencyFrac': 0.1,
        'partners': [{'name': 'Partner EK-B (synthetic)', 'working_interest': 40}, {'name': 'Partner EK-C (synthetic)', 'working_interest': 15}],
        'band': {'low': 0.8, 'high': 1.25},
    },
}

# ---------------------------------------------------------------- materials
MS_CRITERIA = [
    {'id': 'specification', 'weight': 60, 'maxScore': 4, 'label': 'Compliance with API 5CT, API 6D and API 10A / 13A data sheets'},
    {'id': 'delivery', 'weight': 25, 'maxScore': 4, 'label': 'Delivery plan to the Onne supply base'},
    {'id': 'after-sales', 'weight': 15, 'maxScore': 4, 'label': 'Valve after-sales service and spares'},
]
MS_ITEMS = [
    {'id': 'casing', 'unit': 't', 'label': '9-5/8 in 47 ppf L80 casing, 180 t'},
    {'id': 'valves', 'unit': 'number', 'label': '3-1/16 in 5,000 psi gate valves, 24'},
    {'id': 'cement', 'unit': 't', 'label': 'Class G Portland cement, 150 t'},
    {'id': 'baryte', 'unit': 't', 'label': 'API baryte, 200 t'},
    {'id': 'inspection', 'unit': 'lump sum', 'label': 'Third-party inspection and certification'},
]


def tn(n, t):
    return {'measure': 'tonnage', 'nigerian': n, 'total': t}


def num(n, t):
    return {'measure': 'number', 'nigerian': n, 'total': t}


def ms_bid(bid, received, scores, rates, weeks, maint, nc, **kw):
    casing, valves, cement, baryte, insp = rates
    lines = [line('casing', 180, casing), line('valves', 24, valves), line('cement', 150, cement), line('baryte', 200, baryte)]
    if insp is not None:
        lines.append(line('inspection', 1, insp))
    b = {'id': bid, 'name': f'Bidder {bid} (synthetic)', 'receivedAt': received,
         'mandatory': [{'id': 'bid-security', 'met': True}, {'id': 'manufacturer-authorisation', 'met': True}],
         'scores': dict(zip([c['id'] for c in MS_CRITERIA], scores)),
         'lines': lines, 'completionWeeks': weeks, 'annualCosts': [maint] * 5, 'nc': nc,
         'indigenous': False, 'capacity': True}
    b.update(kw)
    return b


MS_BIDS = [
    ms_bid('MS1', '2027-03-02T10:00:00Z', [3, 3, 3], (1650, 4200, 310, 420, 12000), 10, 6000,
           {'casing': tn(99, 180), 'valves': num(12, 24), 'cement': tn(120, 150), 'baryte': tn(110, 200)}),
    ms_bid('MS2', '2027-03-02T13:25:00Z', [3, 3, 2], (1600, 4300, 300, 400, 9500), 9, 5500,
           {'casing': tn(108, 180), 'valves': num(14, 24), 'cement': tn(123, 150), 'baryte': tn(120, 200)}),
    ms_bid('MS3', '2027-03-03T09:45:00Z', [4, 3, 3], (1700, 4500, 320, 430, 14500), 8, 5000,
           {'casing': tn(180, 180), 'valves': num(15, 24), 'cement': tn(135, 150), 'baryte': tn(130, 200)},
           indigenous=True),
    ms_bid('MS4', '2027-03-03T14:10:00Z', [3, 2, 3], (1580, 3970, 295, 400, None), 11, 7000,
           {'casing': tn(99, 180), 'valves': num(12, 24), 'cement': tn(120, 150), 'baryte': tn(120, 200)},
           omitted=['inspection']),
    ms_bid('MS5', '2027-03-04T08:30:00Z', [2, 2, 2], (1500, 3800, 280, 380, 8000), 9, 6500,
           {'casing': tn(90, 180), 'valves': num(10, 24), 'cement': tn(100, 150), 'baryte': tn(100, 200)}),
]

MATERIALS = {
    'synthetic': SYN,
    'generatedBy': GEN,
    'tender': 'EK-11/MS/2027-02',
    'title': 'Casing, wellhead valves, cement and baryte for the Ekene infill wells (synthetic)',
    'scope': ('Materials supply for two infill wells, delivered to the supply base. Two-envelope process; the technical '
              'envelope is scored with a pass mark and the award is the lowest evaluated cost, with the valves '
              'maintained under a five-year service contract evaluated as a life-cycle cost.'),
    'criteria': MS_CRITERIA,
    'passMark': 60,
    'items': MS_ITEMS,
    'schedule': {'minWeeks': 8, 'maxWeeks': 14, 'ratePerWeek': 0.0025},
    'lifeCycle': {'years': 5, 'discountRate': 0.1},
    'award': {'basis': 'lowest-cost'},
    'omissionRule': 'average',
    'nc': {'items': [
        {'id': 'casing', 'scheduleLine': 'steel-pipes'},
        {'id': 'valves', 'scheduleLine': 'valves'},
        {'id': 'cement', 'scheduleLine': 'cement-portland'},
        {'id': 'baryte', 'scheduleLine': 'drilling-mud-baryte-bentonite'},
    ], 'weights': 'each bid weights its items by its own quoted amount for that item (the spend)'},
    'bids': MS_BIDS,
}

# ncPct per bid for the materials tender is the spend-weighted mean; the
# weights are written into each bid so the fixture is self-contained.
for b in MATERIALS['bids']:
    b['ncWeights'] = {l['id']: l['quotedAmount'] for l in b['lines'] if l['id'] in ('casing', 'valves', 'cement', 'baryte')}


def dump(name, obj):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump(obj, f, indent=1, ensure_ascii=True)
        f.write('\n')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    dump('well-services.json', WELL_SERVICES)
    dump('materials.json', MATERIALS)
    print('wrote', os.path.relpath(OUT, ROOT))
