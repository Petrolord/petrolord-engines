#!/usr/bin/env python3
"""Write the synthetic Ekene farm-out fixtures (Economics EC10).

    python3 tools/validation/economics/make_farmout_fixtures.py

Writes test-data/economics/ekene-farmout/ekene-farmout.json. Every figure is
OURS and synthetic: the Ekene Deep exploration prospect (synthetic), on a
petroleum prospecting licence held by two synthetic partners, farmed out to a
synthetic farminee. No real company, deal, prospect, price or regulator
decision. Every deal term (share paid, interest earned, cap, overrun rule,
bonus, reimbursement, uplift, likelihood, correlation, seed) is stated in the
fixture as the synthetic deal's term; the engine holds no default for any of
them. The consent fee rates are the gazetted ones (AOI Regulations 2024 reg.
19(2)); the transaction value is a synthetic stated amount.

Money is US$ in whole dollars; interests and shares are chosen so that the
splits are exact in binary where a reason prints them.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'ekene-farmout')
GEN = 'tools/validation/economics/make_farmout_fixtures.py'
SYN = ('SYNTHETIC teaching data for the Ekene field (ours). No real company, deal, prospect, price or regulator decision. '
       'The Ekene Deep prospect and every party below are synthetic.')

PARTIES = [
    {'id': 'EKO', 'name': 'Ekene Operator (synthetic)', 'participatingPct': 70},
    {'id': 'PA', 'name': 'Partner A (synthetic)', 'participatingPct': 30},
]
FARMINEE = {'id': 'FIN', 'name': 'Farminee Energy (synthetic)'}

# The success case at 100%: the development after a discovery, net cash flow
# after royalty and tax (a stated input, as an EPE run would give it), US$.
DEV = {2029: -240000000, 2030: -360000000, 2031: -120000000}
PLATEAU = 250000000
DECLINE_PCT = 12  # a year after the plateau, synthetic


def success_flows():
    rows = [{'year': y, 'net': v} for y, v in sorted(DEV.items())]
    v = PLATEAU
    for y in range(2032, 2046):
        rows.append({'year': y, 'net': int(v)})
        if y >= 2033:
            v = v * (100 - DECLINE_PCT) // 100
    return rows


def main():
    flows = success_flows()
    project = {
        'chanceOfSuccessPct': 25,
        'wellCost': {'success': 46000000, 'dry': 40000000},
        'successValue': {'cashFlows': flows, 'discountRate': 0.1, 'baseYear': 2027},
    }
    past = {'amount': 12000000, 'reimbursedPct': 30}
    consent = {'licence': 'PPL', 'transactionValue': 5600000, 'valueSource': 'contract-amount', 'intraGroup': False, 'basis': 'nuprc-2024-r19',
               'payment': {'notifiedOn': '2027-05-03', 'paidOn': '2027-07-30'}}
    deal = {'farmineePaysPct': 40, 'earnedPct': 30, 'cap': {'on': 'gross-cost', 'amount': 44000000, 'overrunRule': 'post-deal-interests'},
            'cashBonus': 2000000, 'pastCosts': past, 'assignorFees': 392000}
    doc = {
        'synthetic': SYN,
        'generatedBy': GEN,
        'currency': 'US$',
        'prospect': 'Ekene Deep (synthetic), an exploration prospect on the Ekene petroleum prospecting licence (synthetic)',
        'parties': PARTIES,
        'farmor': 'EKO',
        'farminee': FARMINEE,
        'project': project,
        'deal': deal,
        'earning': {
            'singleWell': {
                'events': [{'name': 'Ekene Deep-1 exploration well', 'grossCost': 46000000, 'farmineePaysPct': 40, 'earnedPct': 30,
                            'cap': {'on': 'gross-cost', 'amount': 44000000, 'overrunRule': 'post-deal-interests'}}],
                'vesting': 'per-event', 'eventsCompleted': 1, 'cashBonus': 2000000, 'pastCosts': past,
            },
            'drillToEarn': {
                'events': [
                    {'name': 'Ekene Deep-1 exploration well', 'grossCost': 40000000, 'farmineePaysPct': 40, 'earnedPct': 20, 'cap': {'on': 'none'}},
                    {'name': 'Ekene Deep-2 appraisal well', 'grossCost': 30000000, 'farmineePaysPct': 45, 'earnedPct': 15, 'cap': {'on': 'carry-amount', 'amount': 3000000}},
                ],
                'vesting': 'all-events', 'eventsCompleted': 1, 'cashBonus': 0, 'pastCosts': {'amount': 0, 'reimbursedPct': 0},
            },
        },
        'consent': consent,
        'information': {'cost': 1500000, 'signals': [{'label': 'bright amplitude', 'likelihoodsPct': [75, 25]}, {'label': 'dim amplitude', 'likelihoodsPct': [25, 75]}]},
        'developmentCarry': {
            'earnedPct': 30, 'carriedPct': 50,
            'years': [{'year': r['year'], 'cost': -r['net'] if r['net'] < 0 else 0, 'entitlement': r['net'] if r['net'] > 0 else 0} for r in flows],
            'uplift': {'type': 'compound', 'ratePctPerYear': 8}, 'recoverFromPct': 50, 'discountRate': 0.1, 'baseYear': 2027,
        },
        'backIn': {
            'earnedPct': 30,
            'backIn': {'party': 'EKO', 'targetPct': 45, 'costs': [{'item': 'Ekene Deep development wells', 'amount': 480000000, 'kind': 'development'},
                                                               {'item': 'Ekene Deep-1 exploration well', 'amount': 46000000, 'kind': 'exploration'}],
                       'basis': 'contract', 'refundableKinds': ['development'], 'refundForm': 'upfront'},
        },
        # the positions are built from dealValue's payoffs (the gate checks the wiring)
        'risk': {'correlation': 0, 'seed': 20271111, 'iterations': 20000},
        'interestPrice': {'interestPct': 30, 'valueBasis': 'risked',
                          'transaction': {'price': 16000000, 'volumeUnit': 'MMboe', 'reserves': [{'category': '2C (contingent, best estimate)', 'grossVolume': 120}]}},
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'ekene-farmout.json'), 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print('wrote test-data/economics/ekene-farmout/ekene-farmout.json')


if __name__ == '__main__':
    main()
