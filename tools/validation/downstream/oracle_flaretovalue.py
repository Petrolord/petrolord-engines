#!/usr/bin/env python3
"""Oracle for engines/downstream/flareToValue.js (MD4-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. THE GAS is characterised in EXACT RATIONAL arithmetic, with masses
    carried in kilograms and liquid volumes in cubic metres (the engine works
    in pounds and gallons), and converted to gallons only at the end.
    Molar masses are rebuilt from IUPAC atomic weights and compared with the
    engine's table (agreement to 1e-3 lb/lbmol is required).
 2. THE STANDARD MOLAR VOLUME 379.49 scf/lbmol is DERIVED from the CODATA
    gas constant at 60 F and 14.696 psia; the engine's constant must agree
    to 5e-5. The goldens then use the engine's 379.49 so a case compares the
    method, not the fourth significant figure of a convention.
 3. THE FLARE follows 40 CFR 98.233(n) as reachable at
    law.cornell.edu/cfr/text/40/98.233 (read 2026-09-19): the variable
    definitions of equations W-19 and W-20 (eta_D destruction, eta_C
    combustion, X_CH4, X_CO2, Y_j, R_j, "1 for methane ... 5 for
    pentanes-plus") and paragraph (n)(1)(v)(D), destruction = combustion plus
    1.5. The EQUATIONS themselves are images on that page and are not in the
    text we reached, so their FORM is the one the definitions fix:
        CH4 = V X_CH4 (1 - eta_D),  CO2 = V X_CO2 + V eta_C sum(Y_j R_j)
    for a lit flare (Z_U = 0). The masses are computed by moles (exact
    rationals), and CROSS-CHECKED by the rule's own volumetric route,
    paragraph (v) equation W-36, with its published densities 0.0526 kg/ft3
    (CO2) and 0.0192 kg/ft3 (CH4) at 60 F and 14.7 psia. Those densities are
    printed to three figures, so the cross-check holds to 0.5 percent, and it
    is a check on the route, not on the golden.
 4. ROUTE ECONOMICS, CREDITS AND THE COMPARISON are ledgers; the credit
    breakeven is the closed form (hurdle - margin) / tonnes, which the engine
    now also uses, so the discriminating cases are the ones where the tested
    prices are unsorted or do not include the breakeven.
 5. PINNED, NOT VALIDATED: the component heating values and liquid
    densities (GPA 2145 is not in this repository and is not quoted from
    memory; the engine labels them typical and the cases pass them in), the
    methane GWP (a case input, never an engine constant), and the capex
    scaling exponent (validated with the modular refinery in MD2-0).

The first gas is the Suite page's default (src/contexts/FlareToValueContext.jsx).

stdlib only. Writes test-data/downstream/goldens/flaretovalue_cases.json
"""

import json
import os
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'flaretovalue_cases.json')

# The engine's labelled reference table, copied as data (the cases pass it in).
REF = {
    'C1': dict(c=1, mw='16.043', ghv=1010, rho=None, ngl=False, inert=False),
    'C2': dict(c=2, mw='30.070', ghv=1770, rho='2.971', ngl=True, inert=False),
    'C3': dict(c=3, mw='44.096', ghv=2516, rho='4.233', ngl=True, inert=False),
    'IC4': dict(c=4, mw='58.122', ghv=3252, rho='4.695', ngl=True, inert=False),
    'NC4': dict(c=4, mw='58.122', ghv=3263, rho='4.872', ngl=True, inert=False),
    'C5': dict(c=5, mw='72.150', ghv=4010, rho='5.253', ngl=True, inert=False),
    'N2': dict(c=0, mw='28.014', ghv=0, rho=None, ngl=False, inert=True),
    'CO2': dict(c=1, mw='44.010', ghv=0, rho=None, ngl=False, inert=True),
}
# IUPAC conventional atomic weights (2007 table as widely reprinted).
AW = {'C': F('12.0107'), 'H': F('1.00794'), 'N': F('14.0067'), 'O': F('15.9994')}
FORMULA = {'C1': {'C': 1, 'H': 4}, 'C2': {'C': 2, 'H': 6}, 'C3': {'C': 3, 'H': 8}, 'IC4': {'C': 4, 'H': 10},
           'NC4': {'C': 4, 'H': 10}, 'C5': {'C': 5, 'H': 12}, 'N2': {'N': 2}, 'CO2': {'C': 1, 'O': 2}}

KG_PER_LB = F('0.45359237')
M3_PER_FT3 = F('0.028316846592')
M3_PER_GAL = F('0.003785411784')
SCF_PER_LBMOL = F('379.49')
MW_CO2 = F('44.009')
MW_CH4 = F('16.043')
# The richness words' lower edges, gal of C3+ per Mscf (the engine's stated
# screening bands; exported by the engine as RICHNESS_GPM since MD45-1).
RICHNESS_GPM = {'rich': F('2.5'), 'moderate': F(1)}
BTU_J = F('1055.05585262')


def derived_scf_per_lbmol():
    R = F('8.314462618')
    T = (F(60) - 32) * F(5, 9) + F('273.15')
    P = F(101325)            # 14.696 psia is 101.325 kPa to 5 figures
    m3_per_mol = R * T / P
    return m3_per_mol * 1000 * KG_PER_LB / M3_PER_FT3  # mol per lbmol = 453.59237


def component(code, y, **over):
    r = REF[code]
    row = {'code': code, 'moleFraction': y, 'c': r['c'], 'molarMassLbLbmol': float(r['mw']),
           'ghvBtuScf': r['ghv'], 'liquidDensityLbGal': float(r['rho']) if r['rho'] else None,
           'recoverableAsNgl': r['ngl'], 'inert': r['inert']}
    row.update(over)
    return row


def characterise(comps):
    # a missing carbon number is read off the chemical FORMULA, not the table
    comps = [dict(c, c=c['c'] if c['c'] is not None else FORMULA[c['code']].get('C', 0)) for c in comps]
    ys = [F(str(c['moleFraction'])) for c in comps]
    tot = sum(ys)
    y = [v / tot for v in ys]
    lbmol_per_mscf = 1000 / SCF_PER_LBMOL
    out = {}
    ghv_known = all(c['ghvBtuScf'] is not None for c in comps)
    out['ghvBtuScf'] = float(sum(yi * F(str(c['ghvBtuScf'])) for yi, c in zip(y, comps))) if ghv_known else None
    out['inertMoleFraction'] = float(sum(yi for yi, c in zip(y, comps) if c['inert']))
    out['co2MoleFraction'] = float(sum(yi for yi, c in zip(y, comps) if c['code'] == 'CO2'))
    out['methaneMoleFraction'] = float(sum(yi for yi, c in zip(y, comps) if c['code'] == 'C1'))
    out['carbonPerMol'] = float(sum(yi * c['c'] for yi, c in zip(y, comps)))
    out['hydrocarbonCarbonPerMol'] = float(sum(yi * c['c'] for yi, c in zip(y, comps)
                                               if not c['inert'] and c['code'] != 'CO2'))
    mw = [F(str(c['molarMassLbLbmol'])) for c in comps]
    out['molarMassLbLbmol'] = float(sum(yi * m for yi, m in zip(y, mw)))
    # kilograms per Mscf, by kilograms: lbmol x MW gives lb, x 0.45359237 gives kg
    kg = [lbmol_per_mscf * yi * m * KG_PER_LB for yi, m in zip(y, mw)]
    out['kgPerMscf'] = float(sum(kg))
    out['c3PlusKgPerMscf'] = float(sum(k for k, c in zip(kg, comps) if c['code'] in ('C3', 'IC4', 'NC4', 'C5')))

    def gpm(codes):
        rows = [(k, c) for k, c in zip(kg, comps) if c['recoverableAsNgl'] and c['code'] in codes]
        if any(c['liquidDensityLbGal'] is None for _, c in rows):
            return None
        # liquid density lb/gal -> kg/m3, volume in m3, then gallons
        return float(sum(k / (F(str(c['liquidDensityLbGal'])) * KG_PER_LB / M3_PER_GAL) / M3_PER_GAL
                         for k, c in rows))
    out['gpmC2Plus'] = gpm(('C2', 'C3', 'IC4', 'NC4', 'C5'))
    out['gpmC3Plus'] = gpm(('C3', 'IC4', 'NC4', 'C5'))
    g = out['gpmC3Plus']
    out['richness'] = None if g is None else ('rich' if g >= RICHNESS_GPM['rich'] else 'moderate' if g >= RICHNESS_GPM['moderate'] else 'lean')
    out['rawMoleFractionSum'] = float(tot)
    return out


def flare(gas, vol, days, eta_d, eta_c, gwp, rec):
    lbmol = F(str(vol)) * 10 ** 6 * F(str(days)) / SCF_PER_LBMOL
    t = lambda n, mw: n * mw * KG_PER_LB / 1000  # noqa: E731  lb -> t
    ed = F(str(eta_d))
    ec = F(str(eta_c)) if eta_c is not None else ed
    co2 = t(lbmol * (ec * F(str(gas['hydrocarbonCarbonPerMol'])) + F(str(gas['co2MoleFraction']))), MW_CO2)
    ch4 = t(lbmol * F(str(gas['methaneMoleFraction'])) * (1 - ed), MW_CH4)
    co2e = co2 + ch4 * F(str(gwp))
    # the rule's own volumetric route, W-36 densities (3 figures)
    v_scf = F(str(vol)) * 10 ** 6 * F(str(days))
    co2_w = (v_scf * F(str(gas['co2MoleFraction'])) + v_scf * ec * F(str(gas['hydrocarbonCarbonPerMol']))) * F('0.0526') / 1000
    ch4_w = v_scf * F(str(gas['methaneMoleFraction'])) * (1 - ed) * F('0.0192') / 1000
    assert abs(co2_w / co2 - 1) < F('0.005'), float(co2_w / co2)
    assert abs(ch4_w / ch4 - 1) < F('0.005'), float(ch4_w / ch4)
    out = {'flareCo2Tonnes': float(co2), 'flareCh4Tonnes': float(ch4), 'flareCo2eTonnes': float(co2e),
           'methaneShareOfFlareCo2e': float(ch4 * F(str(gwp)) / co2e),
           'subpartWCo2Tonnes': float(co2_w), 'subpartWCh4Tonnes': float(ch4_w)}
    out['avoidedFlareCo2eTonnes'] = float(co2e * F(str(rec))) if rec is not None else None
    return out, co2e


def ceiling(basis, gas):
    unit, what = basis
    if what == 'gas mass':
        return gas['kgPerMscf'] * (1 if unit == 'kg' else 1e-3)
    if what == 'propane and heavier':
        return gas['c3PlusKgPerMscf'] * (1 if unit == 'kg' else 1e-3)
    if what == 'heating value':
        return float(F(str(gas['ghvBtuScf'])) * 1000 / (F('3.6e9') / BTU_J))
    return None


BASES = {'cng': ('kg', 'gas mass'), 'mini_lng': ('t', 'gas mass'),
         'lpg_extraction': ('t', 'propane and heavier'), 'gas_to_power': ('MWh', 'heating value')}


def economics(case, gas):
    v, days = F(str(case['volumeMMscfd'])), F(str(case['onstreamDays']))
    mscf = v * 1000 * days
    prod = mscf * F(str(case['productUnitPerMscf'])) * F(str(case['recoveryFraction']))
    rev = prod * F(str(case['pricePerProductUnit']))
    opex = F(str(case['fixedOpexPerYear'])) + mscf * F(str(case['variableOpexPerMscf']))
    capex = F(str(case['referenceCapitalCost'])) * (float(v / F(str(case['referenceCapacityMMscfd']))) ** 0.9)
    return {'mscfPerYear': float(mscf), 'productPerYear': float(prod), 'revenuePerYear': float(rev),
            'operatingCostPerYear': float(opex), 'grossMarginPerYear': float(rev - opex),
            'valuePerMscf': float((rev - opex) / mscf), 'capitalCost': float(capex),
            'yieldCeilingPerMscf': ceiling(BASES[case['routeId']], gas)}


def credits(t, prices, margin, hurdle):
    t = F(str(t))
    pts = []
    for p in prices:
        rev = t * F(str(p))
        tot = None if margin is None else F(str(margin)) + rev
        pts.append({'creditPrice': p, 'creditRevenuePerYear': float(rev),
                    'totalMarginPerYear': None if tot is None else float(tot),
                    'clearsHurdle': None if tot is None or hurdle is None else tot >= F(str(hurdle))})
    known = margin is not None and hurdle is not None
    stands = None if not known else F(str(margin)) >= F(str(hurdle))
    be = None if not known else (0.0 if stands else float((F(str(hurdle)) - F(str(margin))) / t))
    clearing = [p['creditPrice'] for p in pts if p['clearsHurdle']]
    return {'points': pts, 'standsAloneWithoutCredits': stands, 'breakevenCreditPrice': be,
            'lowestTestedClearingPrice': min(clearing) if clearing else None}


def net_abatement(avoided, product_combustion, displaced_fuel):
    """The net abatement ledger: the flare emission the recovered share
    avoids, less what burning the product emits, plus the fuel it displaces
    (tCO2e a year). None unless all three are declared, as the engine
    reports it only against a declared counterfactual. Exported in MD45-1
    (it lived inside main())."""
    if avoided is None or product_combustion is None or displaced_fuel is None:
        return None
    return avoided - product_combustion + displaced_fuel


def main():
    s = derived_scf_per_lbmol()
    assert abs(s / SCF_PER_LBMOL - 1) < F('5e-5'), float(s)
    for code, f in FORMULA.items():
        mw = sum(AW[a] * n for a, n in f.items())
        assert abs(mw - F(REF[code]['mw'])) < F('0.002'), (code, float(mw))

    page = [('C1', 0.78), ('C2', 0.09), ('C3', 0.05), ('IC4', 0.01), ('NC4', 0.02), ('C5', 0.01), ('N2', 0.02), ('CO2', 0.02)]
    gases = [
        {'name': 'Suite default gas (1.30 carbon per mole, 2 percent CO2)', 'components': [component(c, y) for c, y in page]},
        {'name': 'lean gas', 'components': [component(c, y) for c, y in [('C1', 0.94), ('C2', 0.02), ('C3', 0.01), ('N2', 0.02), ('CO2', 0.01)]]},
        {'name': 'an analysis summing to 0.95, scaled to one', 'components': [component(c, y) for c, y in [('C1', 0.75), ('C2', 0.1), ('C3', 0.05), ('CO2', 0.05)]]},
        {'name': 'propane with no liquid density: liquids missing, not partial',
         'components': [component('C1', 0.9), component('C3', 0.05, liquidDensityLbGal=None), component('NC4', 0.05)]},
        {'name': 'a hydrocarbon typed without a carbon number takes it from the reference',
         'components': [component('C1', 0.9), component('C3', 0.1, c=None)]},
    ]
    for g in gases:
        g.update(characterise(g['components']))
    gas_refusals = [
        {'name': 'a negative mole fraction', 'components': [component('C1', 1.1), component('C2', -0.1)]},
        {'name': 'an unknown component with no carbon number', 'components': [component('C1', 0.9), {**component('C2', 0.1), 'code': 'XX', 'c': None}]},
        {'name': 'a blank mole fraction', 'components': [component('C1', '')]},
    ]

    default_gas = gases[0]
    flares = []
    for name, ed, ec, gwp, rec in [('Suite gas, 98 percent destruction, GWP 29.8, 90 percent recovered', 0.98, None, 29.8, 0.9),
                                    ('Subpart W tier 1 pair: 98 destruction, 96.5 combustion', 0.98, 0.965, 29.8, 0.9),
                                    ('tier 3 pair: 92 destruction, 90.5 combustion, GWP 28', 0.92, 0.905, 28, 0.85)]:
        out, _ = flare(default_gas, 10, 350, ed, ec, gwp, rec)
        flares.append({'name': name, 'volumeMMscfd': 10, 'onstreamDays': 350, 'flareDestructionEfficiency': ed,
                       'flareCombustionEfficiency': ec, 'gwpMethane': gwp, 'recoveryFraction': rec, **out})
    # the counterfactual, applied to the recovered share
    cf = dict(flares[0])
    cf.update({'name': 'counterfactual declared: CNG displacing diesel', 'counterfactualLabel': 'CNG displacing diesel',
               'productCombustionTonnesCo2ePerYear': 150000, 'displacedFuelTonnesCo2ePerYear': 180000})
    cf['netAbatementTonnesCo2ePerYear'] = net_abatement(cf['avoidedFlareCo2eTonnes'], 150000, 180000)
    # what main's engine said for the same inputs: every unburned carbon as
    # methane, the gas's CO2 burned, the whole flare credited
    old_ch4 = float(10 * 10 ** 6 * 350 / SCF_PER_LBMOL * F('1.30') * F('0.02') * MW_CH4 * KG_PER_LB / 1000)
    before = {'flareCh4Tonnes': old_ch4}

    routes = []
    page_routes = [
        ('cng', 20, 0.9, 0.6, 30000000, 8, 2500000, 0.4),
        ('mini_lng', 0.019, 0.88, 480, 90000000, 20, 6000000, 0.7),
        ('lpg_extraction', 0.0045, 0.85, 500, 45000000, 12, 3000000, 0.3),
        ('gas_to_power', 0.09, 0.95, 65, 55000000, 15, 4000000, 0.5),
    ]
    for rid, yld, rec, price, capex, capq, fix, var in page_routes:
        case = {'routeId': rid, 'volumeMMscfd': 10, 'onstreamDays': 350, 'productUnitPerMscf': yld,
                'recoveryFraction': rec, 'pricePerProductUnit': price, 'referenceCapitalCost': capex,
                'referenceCapacityMMscfd': capq, 'fixedOpexPerYear': fix, 'variableOpexPerMscf': var}
        case.update(economics(case, default_gas))
        routes.append(case)
    over = {'routeId': 'lpg_extraction', 'productUnitPerMscf': 0.02,
            'yieldCeilingPerMscf': ceiling(BASES['lpg_extraction'], default_gas),
            'note': 'the page default before MD4-0: 3.6 times the propane-plus in the gas'}

    credit_cases = [
        {'name': 'a bet: the breakeven lies between tested prices', 't': 60000, 'prices': [60, 5, 15, 45, 30],
         'margin': 1500000, 'hurdle': 4000000},
        {'name': 'stands alone', 't': 60000, 'prices': [5, 15], 'margin': 5000000, 'hurdle': 4000000},
        {'name': 'no tested price clears', 't': 60000, 'prices': [1, 2], 'margin': 0, 'hurdle': 10000000},
        {'name': 'no margin: no verdict', 't': 60000, 'prices': [5, 15], 'margin': None, 'hurdle': 4000000},
    ]
    for c in credit_cases:
        c.update(credits(c['t'], c['prices'], c['margin'], c['hurdle']))

    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_flaretovalue.py',
            'method': 'exact rationals in kg and m3; 40 CFR 98.233(n) by moles, cross-checked by the rule\'s W-36 densities; ledgers',
            'engine': 'engines/downstream/flareToValue.js',
            'published': '40 CFR 98.233(n) and (v) as read at law.cornell.edu 2026-09-19; heating values and liquid densities are the engine\'s labelled typical table, pinned not validated',
            'derivedScfPerLbmol': float(s),
        },
        'gases': gases, 'gasRefusals': gas_refusals, 'flares': flares, 'counterfactual': cf,
        'constants': {'flareMolarMass': {'CO2': float(MW_CO2), 'CH4': float(MW_CH4)},
                      'flareMolarMassFromIupac2024': {'CO2': float(F('12.011') + 2 * F('15.999')), 'CH4': float(F('12.011') + 4 * F('1.008'))},
                      'richnessGpm': {k: float(v) for k, v in RICHNESS_GPM.items()}},
        'mainBefore': before, 'routes': routes, 'yieldAboveCeiling': over, 'credits': credit_cases,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('derived scf/lbmol', float(s))
    for f in flares:
        print(f['name'], round(f['flareCo2Tonnes'], 3), round(f['flareCh4Tonnes'], 3), round(f['flareCo2eTonnes'], 3))
    print('main CH4', round(old_ch4, 3), 'ceiling LPG t/Mscf', over['yieldCeilingPerMscf'])
    for r in routes:
        print(r['routeId'], round(r['valuePerMscf'], 6), r['yieldCeilingPerMscf'])


if __name__ == '__main__':
    main()
