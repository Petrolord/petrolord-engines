#!/usr/bin/env python3
"""Write the synthetic Ekene materials register for engines/supplychain/inventory.js (SC3).

    python3 tools/validation/supplychain/make_inventory_fixtures.py

SYNTHETIC teaching data, ours. No real company, person, supplier or price
list appears. Wells follow test-data/ekene-dynamic/field.json. Every figure is
typed below by hand (no randomness), so re-running this script reproduces the
files byte for byte. It checks nothing about the engine; the oracle
(oracle_inventory.py) computes every expected value.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'supplychain', 'ekene-materials')
SYN = ('SYNTHETIC teaching data for the Ekene field (Petrolord fictional teaching field, block EK-11). '
       'No real company, person, supplier or price appears.')
GEN = 'tools/validation/supplychain/make_inventory_fixtures.py'


def item(i, name, usage, cost, scores, on_hand, months, monthly):
    s = dict(zip(['safety', 'production', 'leadTime', 'redundancy'], scores))
    return {'id': i, 'name': name, 'annualUsage': usage, 'unitCost': cost, 'scores': s,
            'onHand': on_hand, 'monthsSinceLastIssue': months, 'monthlyUsage': monthly}


# id, name, annual usage (units), unit cost (US$), criticality scores 1..5
# (safety, production, lead time, redundancy), on hand, months since the last
# issue, monthly usage
ITEMS = [
    item('ESP-MTR', 'ESP motor, 228 kW, for Ekene-2 and Ekene-4', 2, 185000, [3, 5, 5, 4], 1, 7, 0.1667),
    item('ESP-PMP', 'ESP pump section, 60 stages', 3, 96000, [2, 5, 5, 4], 2, 5, 0.25),
    item('WH-MV', 'Wellhead master valve, 3-1/16 in 5,000 psi', 2, 42000, [5, 4, 4, 3], 3, 14, 0.1667),
    item('PSV-KIT', 'Pressure safety valve repair kit, separator V-101', 6, 3800, [5, 2, 3, 2], 4, 3, 0.5),
    item('SSV-ACT', 'Surface safety valve actuator', 1, 27500, [4, 4, 4, 3], 1, 26, 0.0833),
    item('CHK-BEAN', 'Choke bean set, tungsten carbide', 40, 1150, [2, 4, 2, 3], 18, 1, 3.3333),
    item('GL-VALVE', 'Gas lift valve, 1-1/2 in', 12, 6400, [2, 4, 3, 3], 9, 2, 1),
    item('COMP-RP', 'Compressor rod packing set, K-201', 8, 5200, [3, 4, 3, 3], 6, 4, 0.6667),
    item('MECH-SEAL', 'Mechanical seal, export pump P-301', 6, 8900, [3, 5, 3, 2], 2, 6, 0.5),
    item('PT-XMTR', 'Pressure transmitter, 0 to 5,000 psi', 10, 2100, [3, 3, 2, 2], 14, 9, 0.8333),
    item('CSG-958', 'Casing 9-5/8 in 47 lb/ft L-80, joint', 240, 1450, [2, 2, 3, 1], 60, 13, 20),
    item('CEM-G', 'Class G cement, tonne', 180, 420, [2, 2, 2, 1], 35, 12, 15),
    item('BARYTE', 'Baryte, tonne', 300, 260, [1, 2, 2, 1], 80, 2, 25),
    item('FILTER-C', 'Fuel gas filter cartridge', 96, 180, [1, 3, 1, 1], 70, 1, 8),
    item('ORING-KIT', 'O-ring kit, assorted Viton', 60, 95, [2, 2, 1, 1], 400, 20, 5),
    item('LUBE-OIL', 'Compressor lube oil, 208 L drum', 36, 640, [1, 3, 1, 1], 12, 1, 3),
    item('HEAT-TRC', 'Heat tracing controller (obsolete model)', 0, 3100, [1, 1, 2, 1], 5, 40, 0),
    item('GASKET-RJ', 'Ring joint gasket, R-24, alloy 825', 50, 38, [2, 2, 3, 2], 120, 24, 4),
]

POLICY = {
    'criticality': {
        'criteria': [
            {'id': 'safety', 'label': 'Consequence of failure for people and the environment', 'weight': 40},
            {'id': 'production', 'label': 'Consequence of failure for production', 'weight': 30},
            {'id': 'leadTime', 'label': 'Replacement lead time', 'weight': 20},
            {'id': 'redundancy', 'label': 'Lack of installed redundancy', 'weight': 10},
        ],
        'scoreMax': 5,
        'classes': [{'label': 'V', 'minScore': 70}, {'label': 'E', 'minScore': 44}, {'label': 'D', 'minScore': 0}],
        'topClassOnMaxScore': ['safety'],
    },
    'abc': {'cutoffs': {'aPct': 80, 'bPct': 95}, 'boundaryRule': 'at-or-below'},
    'slowMoving': {
        'bands': [
            {'label': 'active', 'minMonths': 0, 'writeDownPct': 0},
            {'label': 'slow', 'minMonths': 12, 'writeDownPct': 25},
            {'label': 'very slow', 'minMonths': 24, 'writeDownPct': 50},
            {'label': 'obsolete', 'minMonths': 36, 'writeDownPct': 100},
        ],
        'excessCoverMonths': 24,
    },
}

CASES = {
    'eoq': {'item': 'BARYTE', 'annualDemand': 300, 'orderCost': 1800, 'unitCost': 260, 'holdingRate': 0.22,
            'rounding': {'rule': 'up', 'multiple': 10},
            'note': 'order cost covers the purchase order, the marine freight booking and receiving at the Ekene shore base'},
    'quantityDiscount': {'item': 'CSG-958', 'annualDemand': 240, 'orderCost': 3500, 'holdingRate': 0.2,
                         'breaks': [{'minQuantity': 0, 'unitPrice': 1450}, {'minQuantity': 60, 'unitPrice': 1400},
                                    {'minQuantity': 120, 'unitPrice': 1360}],
                         'discountType': 'all-units', 'rounding': {'rule': 'nearest', 'multiple': 1}},
    'safetyStock': {'item': 'CHK-BEAN', 'demandMean': 3.3333, 'demandSd': 1.6, 'leadTime': 2.5, 'leadTimeSd': 0.5,
                    'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.95,
                    'safetyFactorRounding': {'rule': 'none'}, 'minimumSafetyFactor': 0,
                    'rounding': {'rule': 'up', 'multiple': 1}, 'orderQuantity': 12,
                    'note': 'periods are months; lead time 2.5 months with a standard deviation of 0.5 months'},
    'poissonStock': {'item': 'PSV-KIT', 'demandRate': 0.5, 'leadTime': 4, 'reviewPeriod': 0,
                     'serviceMeasure': 'cycle-service', 'serviceLevel': 0.95,
                     'note': 'periods are months; demand 6 kits a year'},
    'insuranceSpares': {'item': 'ESP-MTR', 'failuresPerYear': 2, 'leadTimeDays': 150, 'daysPerYear': 365,
                        'unitCost': 185000, 'holdingRate': 0.2, 'downtimeCostPerDay': 18000, 'maxSpares': 6,
                        'note': 'downtime cost per day: one well off production (synthetic figure)'},
    'leadTimeRisk': {'item': 'MECH-SEAL', 'demandPerDay': {'min': 0.01, 'mode': 0.016, 'max': 0.03},
                     'leadTimeDays': {'min': 70, 'mode': 90, 'max': 160}, 'reorderPoint': 3, 'serviceLevel': 0.95,
                     'iterations': 20000, 'seed': 20270301},
}


def main():
    os.makedirs(OUT, exist_ok=True)
    reg = {'synthetic': SYN, 'generatedBy': GEN, 'title': 'EK-11 materials and spares register, Ekene field (synthetic)',
           'currency': 'US$', 'items': ITEMS, 'policy': POLICY, 'cases': CASES}
    with open(os.path.join(OUT, 'register.json'), 'w') as f:
        json.dump(reg, f, indent=2)
        f.write('\n')
    readme = """# Ekene materials register (synthetic)

SYNTHETIC teaching data for the Ekene field, Petrolord's fictional teaching
field (block EK-11). No real company, person, supplier or price appears. Used
by `engines/supplychain/inventory.js` (Supply Chain SC3), its jest gate and
the NextGen `materials` course, which all read this same file.

Written by `tools/validation/supplychain/make_inventory_fixtures.py` (stdlib
python, every figure typed by hand); re-running it reproduces the file byte
for byte. Wells follow `test-data/ekene-dynamic/field.json`.

| key | contents |
|---|---|
| `items` | 18 stock items: annual usage, unit cost, criticality scores 1 to 5 on four criteria, stock on hand, months since the last issue, monthly usage. |
| `policy` | the stated criticality weights and classes (V from 70, E from 44, D from 0; a safety score of 5 places an item in V), ABC cut-offs 80% and 95% (at or below), slow-moving bands (12, 24 and 36 months at 25%, 50% and 100%) and a 24-month excess cover limit. |
| `cases` | one stated case for each of eoq, quantityDiscount, safetyStock, poissonStock, insuranceSpares and leadTimeRisk. |

Planted situations (what the course teaches from):

- PSV-KIT scores the maximum 5 on safety, so it is class V whatever its
  weighted score (68, class E by score alone).
- MECH-SEAL scores exactly 70, the V minimum (at or above, so V); GASKET-RJ
  scores exactly 44, the E minimum.
- ABC at 80% and 95%: CEM-G is the item that crosses 80% (cumulative 83.5%),
  so it is B under the 'at-or-below' rule and A under 'include-crossing'.
- CEM-G has gone exactly 12 months without an issue (band slow, at the edge);
  GASKET-RJ exactly 24 (very slow); HEAT-TRC 40 months and no usage
  (obsolete, all stock excess).
- ORING-KIT holds 80 months of cover (excess well above 24 months).
- The ESP motor is the insurance spare: two failures a year across the pumped
  wells, a 150-day lead time, and one well off production while waiting.
"""
    with open(os.path.join(OUT, 'README.md'), 'w') as f:
        f.write(readme)


if __name__ == '__main__':
    main()
