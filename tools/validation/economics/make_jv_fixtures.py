#!/usr/bin/env python3
"""Write the synthetic Ekene joint venture fixtures (Economics EC9).

    python3 tools/validation/economics/make_jv_fixtures.py

Writes test-data/economics/ekene-jv/ekene-jv.json. Every figure is OURS and
synthetic: the Ekene shallow water licence (the terrain of the EC7 Ekene
Alpha case, about 8,000 bopd at 75 US$/bbl) held by four synthetic partners.
No real company, contract, budget or regulator decision. Contract rates,
tolerances, scales, multiples and shares are stated in the fixture as the
synthetic contract's terms; the engine holds no default for any of them.

Money is US$, in whole dollars chosen so that every split in the fixture is
exact in binary (paying interests 50, 31.25, 18.75 and 0): printed figures
are then the same in the engine and in the oracle.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'ekene-jv')
GEN = 'tools/validation/economics/make_jv_fixtures.py'
SYN = 'SYNTHETIC teaching data for the Ekene field (ours). No real company, contract, budget, price or regulator decision.'

PARTIES = [
    {'id': 'EKO', 'name': 'Ekene Operator (synthetic)', 'participatingPct': 40},
    {'id': 'PA', 'name': 'Partner A (synthetic)', 'participatingPct': 25},
    {'id': 'PB', 'name': 'Partner B (synthetic)', 'participatingPct': 15},
    {'id': 'NOC', 'name': 'State participant (synthetic)', 'participatingPct': 20},
]
CARRY = [{'carried': 'NOC', 'carriedPct': 100, 'carriers': 'pro-rata'}]


def months():
    fa = [
        ('2027-01', 4_000_000, 3_600_000),   # over-call 400,000
        ('2027-02', 6_000_000, 6_500_000),   # under-call 500,000
        ('2027-03', 12_000_000, 11_200_000),  # PB defaults on this call (defaultCover)
        ('2027-04', 0, 0),                   # rig move: a zero month, below the threshold, no call
        ('2027-05', 400_000, 448_000),       # below the threshold: billed in arrears in June
        ('2027-06', 9_000_000, 9_000_000),   # called exactly
        ('2027-07', 15_000_000, 13_800_000),  # over-call 1,200,000
        ('2027-08', 3_000_000, 3_104_000),
        ('2027-09', 1_000_000, 1_000_000),   # the July credit exceeds the forecast shares: call 0, credit carried
        ('2027-10', 8_000_000, 8_400_000),
        ('2027-11', 7_000_000, 6_896_000),
        ('2027-12', 5_000_000, 5_200_000),
    ]
    return [{'month': m, 'forecast': f, 'actual': a} for m, f, a in fa]


def build():
    return {
        'title': 'Ekene shallow water licence joint venture (synthetic)',
        'synthetic': SYN,
        'generatedBy': GEN,
        'currency': 'US$',
        'parties': PARTIES,
        'carries': CARRY,
        'cashCalls': {
            'year': 2027, 'reconciliationLagMonths': 2, 'negativeCall': 'carry', 'noCallBelow': 500_000,
            'months': months(),
        },
        'budget': {
            'year': 2027, 'itemTolerancePct': 10, 'budgetTolerance': {'pct': 5, 'amount': 3_000_000}, 'unbudgetedAllowance': 500_000,
            'items': [
                {'item': 'geology and geophysics', 'approved': 6_000_000, 'actual': 6_600_000},
                {'item': 'exploration drilling', 'approved': 48_000_000, 'actual': 53_500_000},
                {'item': 'facilities engineering', 'approved': 10_000_000, 'actual': 9_200_000},
                {'item': 'operations support', 'approved': 8_000_000, 'actual': 8_300_000},
                {'item': 'general and administration', 'approved': 4_000_000, 'actual': 4_100_000},
                {'item': 'environmental baseline survey', 'approved': 0, 'actual': 250_000},
            ],
        },
        'overhead': {
            'year': 2031,
            'costs': {'exploration': 5_000_000, 'operating': 60_000_000, 'development': 150_000_000},
            'excluded': {'operating': 2_000_000},
            'scale': {
                'exploration': {'bands': [{'upTo': 30_000_000, 'pct': 2.5}], 'abovePct': 0},
                'operating': {'bands': [{'upTo': 50_000_000, 'pct': 2.75}, {'upTo': 125_000_000, 'pct': 1}], 'abovePct': 0},
                'development': {'bands': [{'upTo': 50_000_000, 'pct': 2.5}, {'upTo': 100_000_000, 'pct': 1}, {'upTo': 175_000_000, 'pct': 0.5}], 'abovePct': 0},
            },
            'corporatePct': 0.625,
        },
        'default': {
            'callTotal': 12_000_000, 'dueDate': '2027-03-01', 'asOf': '2027-05-31',
            'defaulters': [{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-04-15'}],
            'interest': {'annualRatePct': 8.25, 'dayBasis': 360, 'interestMethod': 'simple', 'graceHours': 0},
            'suspension': {'after': 5, 'unit': 'working-days', 'from': '2027-03-01'},
            'forfeiture': {'after': 3, 'unit': 'months', 'from': '2027-03-10'},
        },
        'carry': {
            'carried': 'NOC', 'recoverFromPct': 50,
            'uplift': {'type': 'compound', 'ratePctPerYear': 8},
            'years': [
                {'year': 2027, 'cost': 82_000_000, 'entitlement': 0},
                {'year': 2028, 'cost': 60_000_000, 'entitlement': 0},
                {'year': 2029, 'cost': 0, 'entitlement': 0},
                {'year': 2030, 'cost': 0, 'entitlement': 96_000_000},
                {'year': 2031, 'cost': 0, 'entitlement': 112_000_000},
                {'year': 2032, 'cost': 0, 'entitlement': 104_000_000},
                {'year': 2033, 'cost': 0, 'entitlement': 94_000_000},
                {'year': 2034, 'cost': 0, 'entitlement': 86_000_000},
                {'year': 2035, 'cost': 0, 'entitlement': 78_000_000},
                {'year': 2036, 'cost': 0, 'entitlement': 70_000_000},
            ],
            'discountRate': 0.1, 'baseYear': 2027,
        },
        'backIn': {
            'backInParty': 'NOC', 'targetPct': 40, 'recoverFromPct': 50,
            'costs': [
                {'item': 'exploration wells Ekene-1 and Ekene-2', 'amount': 136_000_000, 'kind': 'exploration'},
                {'item': 'front end engineering design', 'amount': 40_000_000, 'kind': 'development'},
                {'item': 'development wells and facilities to date', 'amount': 450_000_000, 'kind': 'development'},
                {'item': 'signature bonus', 'amount': 10_000_000, 'kind': 'bonus'},
                {'item': 'interest on partner loans', 'amount': 8_000_000, 'kind': 'interest'},
                {'item': 'operator markup on shared services', 'amount': 2_000_000, 'kind': 'markup'},
            ],
            'years': [
                {'year': 2030, 'entitlement': 96_000_000},
                {'year': 2031, 'entitlement': 112_000_000},
                {'year': 2032, 'entitlement': 104_000_000},
                {'year': 2033, 'entitlement': 94_000_000},
                {'year': 2034, 'entitlement': 86_000_000},
                {'year': 2035, 'entitlement': 78_000_000},
                {'year': 2036, 'entitlement': 70_000_000},
            ],
        },
        'nonConsent': {
            'consenting': ['EKO', 'PA', 'NOC'],
            'operation': {'name': 'Ekene-4 sidetrack', 'cost': 18_000_000},
            'premiumMultiplePct': 400,
            'years': [
                {'year': 2031, 'grossValue': 30_000_000, 'deductions': 10_000_000},
                {'year': 2032, 'grossValue': 26_000_000, 'deductions': 9_000_000},
                {'year': 2033, 'grossValue': 22_000_000, 'deductions': 8_000_000},
                {'year': 2034, 'grossValue': 19_000_000, 'deductions': 7_000_000},
                {'year': 2035, 'grossValue': 16_000_000, 'deductions': 6_000_000},
                {'year': 2036, 'grossValue': 14_000_000, 'deductions': 6_000_000},
            ],
        },
        'psc': {
            'royaltyPct': 12.5, 'costOilLimitPct': 60, 'costOilLimitBase': 'gross',
            'contractorProfitSharePct': 60, 'taxRatePct': 30, 'openingCostPool': 142_000_000,
            'years': [
                {'year': 2029, 'grossRevenue': 0, 'capex': 280_000_000, 'opex': 0},
                {'year': 2030, 'grossRevenue': 219_000_000, 'capex': 90_000_000, 'opex': 20_000_000},
                {'year': 2031, 'grossRevenue': 197_100_000, 'capex': 10_000_000, 'opex': 21_000_000},
                {'year': 2032, 'grossRevenue': 177_390_000, 'capex': 0, 'opex': 22_000_000},
                {'year': 2033, 'grossRevenue': 159_651_000, 'capex': 0, 'opex': 23_000_000},
                {'year': 2034, 'grossRevenue': 143_686_000, 'capex': 0, 'opex': 24_000_000},
                {'year': 2035, 'grossRevenue': 129_317_000, 'capex': 0, 'opex': 25_000_000},
                {'year': 2036, 'grossRevenue': 116_386_000, 'capex': 0, 'opex': 26_000_000},
                {'year': 2037, 'grossRevenue': 104_747_000, 'capex': 0, 'opex': 27_000_000},
                {'year': 2038, 'grossRevenue': 94_272_000, 'capex': 0, 'opex': 28_000_000},
            ],
            'discountRate': 0.1, 'baseYear': 2029,
        },
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'ekene-jv.json'), 'w') as f:
        json.dump(build(), f, indent=1)
        f.write('\n')
    print('wrote test-data/economics/ekene-jv/ekene-jv.json')


if __name__ == '__main__':
    main()
