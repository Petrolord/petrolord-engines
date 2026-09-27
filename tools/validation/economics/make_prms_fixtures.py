#!/usr/bin/env python3
"""Writes the synthetic Ekene reserves and resources fixture (Economics EC11).

    python3 tools/validation/economics/make_prms_fixtures.py

Output: test-data/economics/ekene-prms/ekene-prms.json and README.md.
SYNTHETIC teaching data for the Ekene field (ours): no real company, field,
licence, price, cost, reserves figure or regulator decision. Every figure is
a stated input of the synthetic case; the royalty, tax, prices and costs are
synthetic stated figures, not the PIA 2021 or NTA 2025 rates.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
DIR = os.path.join(ROOT, 'test-data', 'economics', 'ekene-prms')

Y0 = 2027
YEARS = list(range(Y0, Y0 + 15))  # 2027 to 2041


def decline(q0, keep, n=15):
    """Whole barrels a year: q0 x keep^t, rounded half up, t = 0 .. n - 1."""
    out = []
    q = q0
    for _ in range(n):
        out.append(int(q + 0.5))
        q *= keep
    return out


def forecast(q0, keep, gor_mscf_per_bbl=0.8):
    oil = decline(q0, keep)
    return [{'year': y, 'oil': o, 'gas': int(o * gor_mscf_per_bbl + 0.5)} for y, o in zip(YEARS, oil)]


def full(**kw):
    return {'developmentPlan': True, 'financialAppropriations': True, 'timeFrame': {'startWithinYears': 0, 'longerJustified': False},
            'market': True, 'facilities': True, 'approvals': True, 'firmIntention': True, **kw}


PROJECTS = [
    {'id': 'EKN-1', 'args': {'name': 'Ekene Main waterflood (synthetic)', 'discovery': 'discovered', 'recoveryProject': 'established-technology',
                             'subClass': 'on-production', 'commerciality': full(), 'economicStatus': 'viable',
                             'projectStatus': {'finalInvestmentDecision': True, 'onProduction': True}, 'reservesStatus': 'developed-producing',
                             'nigeria': {'declaration': 'commercial-discovery', 'yearsSinceDeclaration': 12}}},
    {'id': 'EKN-2', 'args': {'name': 'Ekene infill wells (synthetic)', 'discovery': 'discovered', 'recoveryProject': 'established-technology',
                             'subClass': 'approved-for-development', 'commerciality': full(timeFrame={'startWithinYears': 1, 'longerJustified': False}),
                             'economicStatus': 'viable', 'projectStatus': {'finalInvestmentDecision': True, 'onProduction': False}, 'reservesStatus': 'undeveloped'}},
    {'id': 'EKN-3', 'args': {'name': 'Ekene East gas (synthetic)', 'discovery': 'discovered', 'recoveryProject': 'established-technology',
                             'subClass': 'development-on-hold',
                             'commerciality': full(financialAppropriations=False, timeFrame={'startWithinYears': 6, 'longerJustified': False}, market=False, facilities=False, firmIntention=False),
                             'economicStatus': 'undetermined', 'chances': {'developmentPct': 50},
                             'nigeria': {'declaration': 'significant-gas-discovery', 'yearsSinceDeclaration': 3}}},
    {'id': 'EKN-4', 'args': {'name': 'Ekene North appraisal (synthetic)', 'discovery': 'discovered', 'recoveryProject': 'established-technology',
                             'subClass': 'development-pending',
                             'commerciality': full(developmentPlan=False, financialAppropriations=False, timeFrame={'startWithinYears': 3, 'longerJustified': False}, approvals=False, firmIntention=False),
                             'economicStatus': 'viable', 'chances': {'developmentPct': 65}}},
    {'id': 'EKN-5', 'args': {'name': 'Ekene West tight sand (synthetic)', 'discovery': 'discovered', 'recoveryProject': 'technology-under-development',
                             'subClass': 'development-unclarified',
                             'commerciality': full(developmentPlan=False, financialAppropriations=False, firmIntention=False),
                             'economicStatus': 'not-viable', 'chances': {'developmentPct': 20}}},
    {'id': 'EKN-6', 'args': {'name': 'Ekene Deep prospect (synthetic)', 'discovery': 'undiscovered', 'recoveryProject': 'established-technology',
                             'subClass': 'prospect', 'chances': {'geologicDiscoveryPct': 25, 'developmentPct': 80}}},
    {'id': 'EKN-7', 'args': {'name': 'Ekene Shallow lead (synthetic)', 'discovery': 'undiscovered', 'recoveryProject': 'established-technology',
                             'subClass': 'lead', 'chances': {'geologicDiscoveryPct': 15, 'developmentPct': 70}}},
    {'id': 'EKN-8', 'args': {'name': 'Ekene Main residual oil (synthetic)', 'discovery': 'discovered', 'recoveryProject': 'none'}},
]

ECONOMIC_LIMIT = {
    'effectiveYear': Y0,
    'forecasts': {'low': forecast(2250000, 0.80), 'best': forecast(3000000, 0.85), 'high': forecast(3600000, 0.88)},
    'prices': [{'year': y, 'oil': 65, 'gas': 2.5} for y in YEARS],
    'costs': {'opex': [{'year': y, 'amount': 30000000} for y in YEARS], 'capex': [{'year': 2027, 'amount': 15000000}], 'abandonment': 40000000},
    'royalty': {'ratePct': 15, 'form': 'royalty-interest'},
    'tax': {'ratePct': 30, 'depreciationYears': 5, 'lossCarryforward': True},
    'workingInterestPct': 70,
    'licence': {'expiryYear': 2040, 'renewalExpected': False},
    'reportingBasis': 'net-entitlement',
    'discountRatePct': 10,
    'mscfPerBoe': 6,
}

AGG_RESERVES = {
    'resourceClass': 'reserves', 'level': 'field', 'unit': 'MMbbl', 'seed': 20271112, 'iterations': 20000,
    'projects': [
        # EKN-1: the economic-limit gross oil of the low, best and high cases in MMbbl, rounded to 0.01 (the gate checks this wiring)
        {'id': 'EKN-1', 'name': 'Ekene Main waterflood (synthetic)', 'distribution': {'type': 'triangular-fit'}, 'estimates': {'low': 8.89, 'best': 16.65, 'high': 24.99}},
        {'id': 'EKN-2', 'name': 'Ekene infill wells (synthetic)', 'distribution': {'type': 'lognormal', 'mean': 6, 'stdDev': 1.8}},
        {'id': 'EKN-U', 'name': 'Ekene Upper sand (synthetic)', 'distribution': {'type': 'normal', 'mean': 4, 'stdDev': 0.8}},
    ],
    'correlation': {'type': 'pairs', 'pairs': [{'a': 'EKN-1', 'b': 'EKN-2', 'rho': 0.5}, {'a': 'EKN-1', 'b': 'EKN-U', 'rho': 0.2}, {'a': 'EKN-2', 'b': 'EKN-U', 'rho': 0.2}]},
}

AGG_CONTINGENT = {
    'resourceClass': 'contingent', 'level': 'field', 'unit': 'MMboe', 'seed': 20271113, 'iterations': 20000,
    'projects': [
        {'id': 'EKN-3', 'name': 'Ekene East gas (synthetic)', 'distribution': {'type': 'lognormal', 'mean': 13, 'stdDev': 4}, 'chanceOfCommercialityPct': 50},
        {'id': 'EKN-4', 'name': 'Ekene North appraisal (synthetic)', 'distribution': {'type': 'triangular-fit'}, 'estimates': {'low': 3, 'best': 4.5, 'high': 6.5}, 'chanceOfCommercialityPct': 65},
        {'id': 'EKN-5', 'name': 'Ekene West tight sand (synthetic)', 'distribution': {'type': 'triangular', 'min': 1, 'mode': 2, 'max': 6}, 'chanceOfCommercialityPct': 20},
    ],
    'correlation': {'type': 'uniform', 'rho': 0.3},
}

RECONCILIATION = {
    'resourceClass': 'reserves', 'unit': 'MMbbl', 'periodYears': 1,
    'opening': {'low': 15.2, 'best': 21, 'high': 27.5},
    'movements': [
        {'type': 'production', 'quantity': 1.1, 'note': 'Ekene Main 2027 production (synthetic)'},
        {'type': 'revisions', 'low': 0.3, 'best': -0.2, 'high': -0.6, 'note': 'waterflood performance review (synthetic)'},
        {'type': 'transfers', 'low': 3.4, 'best': 5.1, 'high': 6.9, 'note': 'Ekene infill wells moved from Contingent Resources at the investment decision (synthetic)'},
        {'type': 'improved-recovery', 'low': 0.5, 'best': 0.8, 'high': 1.2, 'note': 'water injection pattern change (synthetic)'},
    ],
    'closing': {'low': 18.3, 'best': 25.6, 'high': 33.9},
    'tolerance': 0.001,
}

DOC = {
    'synthetic': 'SYNTHETIC teaching data for the Ekene field (ours). No real company, field, licence, price, cost, reserves figure or regulator decision. The royalty, tax, prices and costs are synthetic stated figures, not the PIA 2021 or NTA 2025 rates.',
    'generatedBy': 'tools/validation/economics/make_prms_fixtures.py',
    'field': 'Ekene field (synthetic) on the Ekene petroleum mining lease (synthetic)',
    'operator': {'id': 'EKO', 'name': 'Ekene Operator (synthetic)', 'workingInterestPct': 70},
    'currency': 'US$',
    'projects': PROJECTS,
    'economicLimit': ECONOMIC_LIMIT,
    'aggregation': {'reserves': AGG_RESERVES, 'contingent': AGG_CONTINGENT},
    'reconciliation': RECONCILIATION,
}

README = """# Ekene reserves and resources (synthetic)

SYNTHETIC teaching data for the Ekene field (ours), written by
`tools/validation/economics/make_prms_fixtures.py`. No real company, field,
licence, price, cost, reserves figure or regulator decision. Used by the EC11
engine `engines/economics/prms.js`, its gate `__tests__/economics.prms.test.js`
and the NextGen course "Reserves & Resources under SPE-PRMS 2018".

Every figure is a stated input of the synthetic case: the engine holds no
default for any classification fact, chance, correlation, seed, price, cost,
royalty or tax rate. The royalty (15%), tax (30%), prices and costs are
synthetic figures chosen for teaching, not the PIA 2021 or NTA 2025 rates.

## Projects on the Ekene lease (operator Ekene Operator (synthetic), 70%)

| id | project | class the engine gives | sub-class | what decides it |
|---|---|---|---|---|
| EKN-1 | Ekene Main waterflood | Reserves | on-production | every commerciality criterion met; producing; developed producing |
| EKN-2 | Ekene infill wells | Reserves | approved-for-development | investment decision taken; undeveloped |
| EKN-3 | Ekene East gas | Contingent Resources | development-on-hold | no market, no facilities, no appropriations, starts in 6 years; a significant gas discovery under PIA 2021 s.78(8)(b), 3 years retained; Pd 50% |
| EKN-4 | Ekene North appraisal | Contingent Resources | development-pending | no mature plan, no appropriations, no approvals yet; Pd 65% |
| EKN-5 | Ekene West tight sand | Contingent Resources | development-unclarified | recovery needs technology under development; economically not viable; Pd 20% |
| EKN-6 | Ekene Deep prospect | Prospective Resources | prospect | Pg 25% (the EC10 farm-out prospect), Pd 80%: Pc 20% |
| EKN-7 | Ekene Shallow lead | Prospective Resources | lead | Pg 15%, Pd 70%: Pc 10.5% |
| EKN-8 | Ekene Main residual oil | Discovered Unrecoverable | none | no recovery project applies |

## Economic limit (EKN-1)

Effective 1 January 2027; low, best and high technical forecasts 2027 to 2041
(whole barrels a year: 2,250,000 x 0.80^t, 3,000,000 x 0.85^t and
3,600,000 x 0.88^t; gas 0.8 Mscf a barrel). Oil 65 and gas 2.5 US$ a unit
flat; opex 30,000,000 a year; a 15,000,000 workover campaign in 2027;
abandonment 40,000,000 at the economic limit; royalty 15% (a royalty
interest); tax 30% with five-year straight-line allowances and loss carry
forward; working interest 70%; the lease expires in 2040 with no renewal
expected; net entitlement basis; 10% discount rate; 6 Mscf a BOE.

## Aggregation

Reserves at the field level: EKN-1 (triangular through 8.89, 16.65 and 24.99
MMbbl, its economic-limit gross oil for the low, best and high cases),
EKN-2 (lognormal, mean 6, standard deviation 1.8) and the Ekene Upper sand
(normal, mean 4, standard deviation 0.8), with stated pairwise correlations
0.5, 0.2 and 0.2; seed 20271112, 20,000 iterations. Contingent Resources
(MMboe, risked by the stated chance of commerciality): EKN-3, EKN-4 and EKN-5,
uniform correlation 0.3; seed 20271113.

## Reconciliation

Ekene field Reserves from 1 January 2027 to 1 January 2028 (MMbbl): opening
15.2 / 21 / 27.5; production 1.1; revisions +0.3 / -0.2 / -0.6; EKN-2
transferred from Contingent Resources 3.4 / 5.1 / 6.9; improved recovery
0.5 / 0.8 / 1.2; stated closing 18.3 / 25.6 / 33.9 (tolerance 0.001).
"""


def main():
    os.makedirs(DIR, exist_ok=True)
    with open(os.path.join(DIR, 'ekene-prms.json'), 'w') as f:
        json.dump(DOC, f, indent=1, ensure_ascii=True)
        f.write('\n')
    with open(os.path.join(DIR, 'README.md'), 'w') as f:
        f.write(README)
    print('wrote test-data/economics/ekene-prms/ekene-prms.json and README.md')


if __name__ == '__main__':
    main()
