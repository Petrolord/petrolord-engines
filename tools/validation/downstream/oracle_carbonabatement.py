#!/usr/bin/env python3
"""Oracle for engines/downstream/carbonAbatement.js (MD5-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. COMBUSTION CO2 is computed by MASS, in exact rationals: the kilograms of
    carbon in the fuel, times the mass ratio CO2/C for the share destroyed
    and CH4/C for the share that escapes. The engine works in kilomoles of
    carbon. Molar masses are BUILT here from the IUPAC conventional atomic
    weights (C 12.011, O 15.999, H 1.008; CIAAW 2024 table), never copied
    from the engine.
 2. THE INVENTORY is a ledger: every line written out with its gas, its
    potential and its tonnes, then summed by scope. Reportable is decided
    here from the rules stated in the engine's doc comments (a declared set,
    sourced factors, nothing blocked, errored and off-scope lines blocked).
 3. THE ABATEMENT COST is a LEVELISED cost from a year-by-year present-value
    ledger: PV(capital + running costs - savings) / PV(tonnes), end-of-year
    flows, in exact rationals. The engine uses a capital recovery factor; the
    two agree only if the annuity algebra is right. No NPV is computed by the
    engine or its callers here; the PV ledger lives in this file only.
 4. THE CURVE is ordered by an explicit rank (cost per tonne, then input
    order; no-cost measures last) and its claims are checked source by source.
 5. THE PATH is a year ledger.

WHAT IS PUBLISHED, AND WHERE IT WAS CHECKED:
  - GWP100 values used as INPUTS (the engine ships none): IPCC AR5 CH4
    non-fossil 28, fossil 30, N2O 265; AR6 CH4 non-fossil 27.0, fossil 29.8,
    N2O 273. Source reached: GHG Protocol, "IPCC Global Warming Potential
    Values", v2.0, 7 August 2024 (adapted from AR6 WG1 ch.7 s.7.6.1.1 and
    AR5 WG1 ch.8), copy at /root/md5-wip/ghgp-gwp-2024-08.pdf.
  - Every other rate, cost and factor in these cases is SYNTHETIC and says so.

The first cases are the Suite page defaults (src/contexts/
CarbonAbatementContext.jsx), as the page opens and then with the required
boxes filled.

stdlib only. Writes test-data/downstream/goldens/carbonabatement_cases.json
"""

import json
import os
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'carbonabatement_cases.json')

C, O, H = F('12.011'), F('15.999'), F('1.008')
M_CO2 = C + 2 * O   # 44.009
M_CH4 = C + 4 * H   # 16.043

GWP = {
    'AR5': {'CH4_nonfossil': 28, 'CH4_fossil': 30, 'N2O': 265},
    'AR6': {'CH4_nonfossil': F('27.0'), 'CH4_fossil': F('29.8'), 'N2O': 273},
}
GWP_SOURCE = 'GHG Protocol, IPCC Global Warming Potential Values v2.0 (2024-08-07), from IPCC AR6 WG1 ch.7 7.6.1.1 and AR5 WG1 ch.8; 100-year horizon'


def fl(x):
    return float(x) if x is not None else None


def combustion(kmol, c, eta):
    """Mass route: kg of carbon, then the mass ratios."""
    kmol, c, eta = F(str(kmol)), F(str(c)), F(str(eta))
    carbon_kg = kmol * c * C
    co2_t = carbon_kg * eta * (M_CO2 / C) / 1000
    ch4_t = carbon_kg * (1 - eta) * (M_CH4 / C) / 1000
    return {'fuelKmolPerYear': fl(kmol), 'carbonPerKmolFuel': fl(c), 'destructionEfficiencyFraction': fl(eta),
            'carbonKmolPerYear': fl(kmol * c), 'co2Tonnes': fl(co2_t), 'ch4Tonnes': fl(ch4_t)}


def inventory(lines, gwp_label, gwp_values):
    """lines: dicts with label, scope, gas, activity, factor, sourced, error."""
    declared = bool(gwp_label) and len(gwp_values) > 0
    ledger, blocked, unsourced = [], [], []
    s1 = s2 = F(0)
    for ln in lines:
        if ln.get('error'):
            blocked.append({'label': ln['label'], 'reason': 'error'})
            continue
        if ln['scope'] not in (1, 2):
            blocked.append({'label': ln['label'], 'reason': 'scope'})
            continue
        gwp = F(1) if ln['gas'] == 'CO2' else (F(str(gwp_values[ln['gas']])) if ln['gas'] in gwp_values else None)
        if ln['activity'] is None:
            blocked.append({'label': ln['label'], 'reason': 'no activity data'}); continue
        if ln['activity'] < 0:
            blocked.append({'label': ln['label'], 'reason': 'a negative activity'}); continue
        if ln['factor'] is None:
            blocked.append({'label': ln['label'], 'reason': 'no factor value'}); continue
        if ln['factor'] < 0:
            blocked.append({'label': ln['label'], 'reason': 'a negative factor'}); continue
        if gwp is None:
            blocked.append({'label': ln['label'], 'reason': 'gwp'}); continue
        t = F(str(ln['activity'])) * F(str(ln['factor'])) * gwp
        ledger.append({'label': ln['label'], 'tCo2e': fl(t)})
        if not ln['sourced']:
            unsourced.append(ln['label'])
        if ln['scope'] == 1:
            s1 += t
        else:
            s2 += t
    reportable = declared and not unsourced and not blocked
    return {'ledger': ledger, 'scope1Tonnes': fl(s1), 'scope2Tonnes': fl(s2), 'totalTonnes': fl(s1 + s2),
            'blocked': blocked, 'unsourced': unsourced, 'reportable': reportable, 'gwpDeclared': declared}


def levelised(m, r):
    """PV ledger, end-of-year flows over an integer life."""
    capex = F(str(m['capitalCost']))
    net_run = F(str(m.get('annualCost', 0))) - F(str(m.get('annualSavings', 0)))
    t = F(str(m['tonnesAbatedPerYear']))
    life = m['lifeYears']
    r = F(str(r))
    pv_cost, pv_t = capex, F(0)
    for y in range(1, life + 1):
        d = (1 + r) ** y
        pv_cost += net_run / d
        pv_t += t / d
    cost_per_t = pv_cost / pv_t if t else None
    # the equivalent annual net cost, by dividing the PV by the annuity sum
    annuity = sum(F(1) / (1 + r) ** y for y in range(1, life + 1))
    return {'label': m['label'], 'tonnesAbatedPerYear': fl(t), 'costPerTonne': fl(cost_per_t),
            'netAnnualCost': fl(pv_cost / annuity), 'annualisedCapital': fl(capex / annuity),
            'capitalRecoveryFactor': fl(1 / annuity), 'paysForItself': bool(t) and pv_cost < 0,
            'actsOn': m.get('actsOn', [])}


def curve(costed, source_emissions, target, refused=()):
    """refused: (label, reason) pairs for measures the cost function refused;
    they are named and carry no tonnes (MD45-1)."""
    idx = list(range(len(costed)))
    rank = sorted(idx, key=lambda i: (costed[i]['costPerTonne'] is None,
                                       costed[i]['costPerTonne'] if costed[i]['costPerTonne'] is not None else 0, i))
    cum = F(0)
    steps = []
    for i in rank:
        m = costed[i]
        start = cum
        cum += F(str(m['tonnesAbatedPerYear']))
        steps.append({'label': m['label'], 'start': fl(start), 'end': fl(cum)})
    by = {}
    for m in costed:
        for s in m['actsOn']:
            by.setdefault(s, []).append(m)
    interactions = sorted(s for s, ms in by.items() if len(ms) > 1)
    over = []
    for s, ms in by.items():
        claimed = sum(F(str(m['tonnesAbatedPerYear'])) for m in ms)
        if s in source_emissions and source_emissions[s] is not None and claimed > F(str(source_emissions[s])):
            over.append({'sourceId': s, 'claimedTonnes': fl(claimed), 'emittedTonnes': float(source_emissions[s])})
    # MD45-1: a claim is checkable only against a source whose emission is
    # given AND a number of zero or more. A measure naming no source is
    # unchecked too. Any unchecked claim leaves the verdict unassessed.
    def checkable(s):
        v = source_emissions.get(s)
        return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v >= 0
    unchecked = []
    for m in costed:
        if not m['actsOn']:
            unchecked.append((m['label'], None))
        for s in m['actsOn']:
            if not checkable(s):
                unchecked.append((m['label'], s))
    unchecked_sources = []
    for _, s in unchecked:
        if s is not None and s not in unchecked_sources:
            unchecked_sources.append(s)
    net_all = sum(F(str(m['netAnnualCost'])) for m in costed)
    meets = None if target is None or over or unchecked else cum >= F(str(target))
    return {'order': [costed[i]['label'] for i in rank], 'steps': steps, 'totalAbatementTonnes': fl(cum),
            'paysForItselfMeasures': [costed[i]['label'] for i in rank if costed[i]['paysForItself']],
            'weightedAverageCostPerTonne': fl(net_all / cum) if cum else None,
            'interactions': interactions, 'overClaims': over, 'additive': not interactions,
            'meetsTarget': meets, 'targetTonnes': fl(F(str(target))) if target is not None else None,
            'uncheckedSources': unchecked_sources,
            'unsourcedMeasures': [lab for lab, s in unchecked if s is None],
            'refusedMeasures': [{'label': lab, 'reasonContains': why} for lab, why in refused]}


def path(base, measures, y0, y1, pct):
    base = F(str(base))
    rows = []
    for y in range(y0, y1 + 1):
        f = F(y - y0, y1 - y0) if y1 != y0 else F(1)
        target = base * (1 - F(str(pct)) / 100 * f)
        abated = sum((F(str(m['tonnesAbatedPerYear'])) for m in measures
                      if m.get('startYear') is not None and m.get('tonnesAbatedPerYear') is not None and m['startYear'] <= y), F(0))
        em = base - abated
        if em < 0:
            return {'refused': True, 'overAbatedYear': y}
        rows.append({'year': y, 'abatedTonnes': fl(abated), 'emissionsTonnes': fl(em), 'targetTonnes': fl(target),
                     'unabatedGapTonnes': fl(max(F(0), em - target))})
    short = [r['year'] for r in rows if r['unabatedGapTonnes'] > 1e-9]
    unsched = [m['label'] for m in measures if m.get('startYear') is None or m.get('tonnesAbatedPerYear') is None]
    return {'rows': rows, 'firstShortfallYear': short[0] if short else None, 'unscheduled': unsched}


# The page defaults (CarbonAbatementContext.defaultInputs)
PAGE_MEASURES = [
    {'label': 'Tune the fired heaters', 'capitalCost': 20000, 'annualSavings': 150000, 'annualCost': 0, 'tonnesAbatedPerYear': 900, 'lifeYears': 5, 'actsOn': ['heaters'], 'startYear': 2027},
    {'label': 'Repair failed steam traps', 'capitalCost': 60000, 'annualSavings': 240000, 'annualCost': 0, 'tonnesAbatedPerYear': 1400, 'lifeYears': 3, 'actsOn': ['steam'], 'startYear': 2027},
    {'label': 'Heat integration project', 'capitalCost': 3200000, 'annualSavings': 480000, 'annualCost': 0, 'tonnesAbatedPerYear': 4000, 'lifeYears': 15, 'actsOn': ['heaters'], 'startYear': 2029},
    {'label': 'Flare gas recovery', 'capitalCost': 5500000, 'annualSavings': 300000, 'annualCost': 120000, 'tonnesAbatedPerYear': 9000, 'lifeYears': 15, 'actsOn': ['flare'], 'startYear': 2030},
]
SYNTH_GRID = 0.43  # tCO2e/MWh, SYNTHETIC


def main():
    heaters = combustion(620000, '1.12', 1)
    flare_98 = combustion(45000, '1.4', '0.98')
    flare_100 = combustion(45000, '1.4', 1)  # what the page computed with the box blank
    methane_98 = combustion(1000, 1, '0.98')

    def page_lines(flare, gwp_label, gwp, grid_factor, sourced_vent):
        lines = [
            {'label': 'Fired heaters and boilers (CO2)', 'scope': 1, 'gas': 'CO2', 'activity': heaters['co2Tonnes'], 'factor': 1, 'sourced': True},
        ]
        if flare is not None:
            lines.append({'label': 'Flaring (CO2)', 'scope': 1, 'gas': 'CO2', 'activity': flare['co2Tonnes'], 'factor': 1, 'sourced': True})
            if flare['ch4Tonnes']:
                lines.append({'label': 'Flaring (unburned CH4)', 'scope': 1, 'gas': 'CH4', 'activity': flare['ch4Tonnes'], 'factor': 1, 'sourced': True})
        lines.append({'label': 'Vented and fugitive methane', 'scope': 1, 'gas': 'CH4', 'activity': 180, 'factor': 1, 'sourced': sourced_vent})
        lines.append({'label': 'Purchased electricity', 'scope': 2, 'gas': 'CO2', 'activity': 42000, 'factor': grid_factor, 'sourced': grid_factor is not None})
        return lines, inventory(lines, gwp_label, gwp)

    # As the page opens: no GWP set, the flare refused (blank destruction
    # efficiency), no grid factor, the vent line unsourced.
    open_lines, open_inv = page_lines(None, '', {}, None, False)
    ar6 = {'CH4': GWP['AR6']['CH4_fossil'], 'N2O': GWP['AR6']['N2O']}
    filled_lines, filled_inv = page_lines(flare_98, 'IPCC AR6 GWP100 (fossil CH4)', ar6, SYNTH_GRID, True)
    ar5 = {'CH4': GWP['AR5']['CH4_fossil'], 'N2O': GWP['AR5']['N2O']}
    _, filled_ar5 = page_lines(flare_98, 'IPCC AR5 GWP100 (fossil CH4)', ar5, SYNTH_GRID, True)

    costed = [levelised(m, '0.1') for m in PAGE_MEASURES]
    ch4_gwp = F(str(ar6['CH4']))
    # the corrected page: a source's emission in CO2e, including its methane
    src = {
        'heaters': fl(F(str(heaters['co2Tonnes'])) + F(str(heaters['ch4Tonnes'])) * ch4_gwp),
        'flare': fl(F(str(flare_98['co2Tonnes'])) + F(str(flare_98['ch4Tonnes'])) * ch4_gwp),
    }
    target = F(str(filled_inv['totalTonnes'])) * 30 / 100
    page_curve = curve(costed, src, fl(target))
    no_flare_measure = curve(costed[:3], src, fl(target))

    # MD45-1 F1. The page AS IT OPENS: the flare is refused (blank
    # destruction efficiency), so the page passes the heaters alone, and the
    # target is 30 percent of the partial inventory. Before MD45-1 the
    # engine said "met" here on the unchecked flare and steam claims.
    src_open = {'heaters': heaters['co2Tonnes']}
    target_open = F(str(open_inv['totalTonnes'])) * 30 / 100
    curve_open = curve(costed, src_open, fl(target_open))
    # Every source given (steam SYNTHETIC 25,000 t), no over-claim: a verdict
    # again, as an upper bound because two measures act on the heaters.
    src_all = dict(src, steam=25000)
    curve_checked = curve(costed[:3], src_all, fl(target))
    curve_checked_met = curve(costed[:3], src_all, 5000)
    # All four page measures with every source given: the flare claim is the
    # only thing between the curve and a verdict, so the over-claim alone
    # must keep the verdict unassessed.
    curve_over_all_given = curve(costed, src_all, 5000)
    # MD45-1 F8: every box filled but the flare's destruction efficiency.
    # The flare is refused; as a blocked line it keeps the inventory NOT
    # reportable. Dropped (as the page did), the rest read reportable.
    refused_lines = [ln for ln in filled_lines if not ln['label'].startswith('Flaring')] + [
        {'label': 'Flaring', 'error': 'A destruction efficiency is required'}]
    inv_refused = inventory(refused_lines, 'IPCC AR6 GWP100 (fossil CH4)', ar6)
    inv_dropped = inventory(refused_lines[:-1], 'IPCC AR6 GWP100 (fossil CH4)', ar6)
    # A source given with no computed emission, and a measure naming none.
    src_blank_steam = dict(src, steam=None)
    curve_blank_steam = curve(costed[:3], src_blank_steam, 5000)
    curve_negative_steam = curve(costed[:3], dict(src, steam=-5), 5000)
    unsourced = [dict(costed[0], actsOn=[])]
    curve_unsourced = curve(unsourced, src_all, 100)
    # MD45-1 F3: a refused measure is named with the engine's reason.
    curve_refused = curve(costed[:1], src_all, 5000,
                          refused=[('Repair failed steam traps', 'no capital cost')])
    page_path = path(filled_inv['totalTonnes'], PAGE_MEASURES, 2026, 2032, 30)
    unsched = PAGE_MEASURES[:3] + [dict(PAGE_MEASURES[3], startYear=None)]
    path_unsched = path(filled_inv['totalTonnes'], unsched, 2026, 2032, 30)

    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_carbonabatement.py',
            'method': 'combustion by mass in exact rationals; the inventory as a ledger; the abatement cost levelised from a year-by-year PV ledger; the curve by explicit rank; the path as a year ledger',
            'engine': 'engines/downstream/carbonAbatement.js',
            'published': 'GWP100 inputs only (the engine ships none): ' + GWP_SOURCE + '. Every other rate and factor is synthetic.',
            'atomicWeights': 'IUPAC conventional: C 12.011, O 15.999, H 1.008 (CIAAW 2024)',
        },
        'molarMasses': {'CO2': fl(M_CO2), 'CH4': fl(M_CH4), 'C': fl(C)},
        'gwp': {k: {kk: fl(F(str(vv))) for kk, vv in v.items()} for k, v in GWP.items()},
        'combustion': {'heaters': heaters, 'flare98': flare_98, 'flare100': flare_100, 'methane98': methane_98},
        'combustionRefusals': [
            {'name': 'blank destruction efficiency', 'args': {'fuelKmolPerYear': 45000, 'carbonPerKmolFuel': 1.4, 'destructionEfficiencyFraction': ''}},
            {'name': 'null destruction efficiency', 'args': {'fuelKmolPerYear': 45000, 'carbonPerKmolFuel': 1.4, 'destructionEfficiencyFraction': None}},
            {'name': 'zero destruction efficiency', 'args': {'fuelKmolPerYear': 45000, 'carbonPerKmolFuel': 1.4, 'destructionEfficiencyFraction': 0}},
            {'name': 'destruction efficiency above one', 'args': {'fuelKmolPerYear': 45000, 'carbonPerKmolFuel': 1.4, 'destructionEfficiencyFraction': 1.2}},
            {'name': 'negative fuel', 'args': {'fuelKmolPerYear': -1, 'carbonPerKmolFuel': 1.4, 'destructionEfficiencyFraction': 1}},
            {'name': 'blank fuel', 'args': {'fuelKmolPerYear': '', 'carbonPerKmolFuel': 1.4, 'destructionEfficiencyFraction': 1}},
        ],
        'inventoryAtOpen': {'lines': open_lines, **open_inv},
        'inventoryFilled': {'lines': filled_lines, 'gwpLabel': 'IPCC AR6 GWP100 (fossil CH4)', 'gwp': {k: fl(F(str(v))) for k, v in ar6.items()}, **filled_inv},
        'inventoryFilledAR5': {'gwp': {k: fl(F(str(v))) for k, v in ar5.items()}, **filled_ar5},
        'measures': PAGE_MEASURES,
        'discountRate': 0.1,
        'costed': costed,
        'sourceEmissions': src,
        'curve': page_curve,
        'curveWithoutFlareRecovery': no_flare_measure,
        'path': {'baselineTonnes': filled_inv['totalTonnes'], 'startYear': 2026, 'endYear': 2032, 'targetPercent': 30, **page_path},
        'pathUnscheduled': path_unsched,
        'md45': {
            'curveAtOpen': {'sourceEmissions': src_open, **curve_open},
            'curveAllSourcesChecked': {'sourceEmissions': src_all, **curve_checked},
            'curveAllSourcesCheckedMet': {'sourceEmissions': src_all, **curve_checked_met},
            'curveOverClaimAllGiven': {'sourceEmissions': src_all, **curve_over_all_given},
            'inventoryFlareRefused': {'refusedAsLine': inv_refused, 'refusedDropped': inv_dropped},
            'curveSourceNotComputed': {'sourceEmissions': src_blank_steam, **curve_blank_steam},
            'curveNegativeSource': {'sourceEmissions': dict(src, steam=-5), **curve_negative_steam},
            'curveUnsourcedMeasure': {'sourceEmissions': src_all, 'measures': unsourced, **curve_unsourced},
            'curveWithRefused': {'sourceEmissions': src_all, **curve_refused,
                                 'refusedArgs': {'label': 'Repair failed steam traps', 'capitalCost': '', 'annualSavings': 240000,
                                                 'tonnesAbatedPerYear': 1400, 'lifeYears': 3, 'discountRate': 0.1, 'actsOn': ['steam']}},
            'negativeLines': [
                {'name': 'a negative activity', 'line': {'label': 'neg activity', 'scope': 1, 'gas': 'CO2', 'activity': -100, 'factor': 2, 'sourced': True},
                 **inventory([{'label': 'neg activity', 'scope': 1, 'gas': 'CO2', 'activity': -100, 'factor': 2, 'sourced': True}], 'AR6', ar6)},
                {'name': 'a negative factor', 'line': {'label': 'neg factor', 'scope': 1, 'gas': 'CO2', 'activity': 100, 'factor': -2, 'sourced': True},
                 **inventory([{'label': 'neg factor', 'scope': 1, 'gas': 'CO2', 'activity': 100, 'factor': -2, 'sourced': True}], 'AR6', ar6)},
            ],
            'gwpRefusals': [
                {'name': 'a negative methane potential', 'label': 'x', 'values': {'CH4': -5, 'N2O': 273}},
                {'name': 'a zero methane potential', 'label': 'x', 'values': {'CH4': 0}},
            ],
            'pathOverAbated': {'baselineTonnes': 1000, 'startYear': 2026, 'endYear': 2027,
                               'measures': [{'label': 'x', 'tonnesAbatedPerYear': 1500, 'startYear': 2026}],
                               **path(1000, [{'label': 'x', 'tonnesAbatedPerYear': 1500, 'startYear': 2026}], 2026, 2027, 30)},
        },
        'abatementRefusals': [
            {'name': 'negative abatement', 'args': {'label': 'X', 'capitalCost': 0, 'tonnesAbatedPerYear': -10}},
            {'name': 'blank capital', 'args': {'label': 'X', 'capitalCost': '', 'tonnesAbatedPerYear': 10, 'lifeYears': 5, 'discountRate': 0.1}},
            {'name': 'capital with a blank rate', 'args': {'label': 'X', 'capitalCost': 1000, 'tonnesAbatedPerYear': 10, 'lifeYears': 5, 'discountRate': ''}},
            {'name': 'a rate typed as a percentage', 'args': {'label': 'X', 'capitalCost': 1000, 'tonnesAbatedPerYear': 10, 'lifeYears': 5, 'discountRate': 10}},
            {'name': 'capital with no life', 'args': {'label': 'X', 'capitalCost': 1000, 'tonnesAbatedPerYear': 10, 'discountRate': 0.1}},
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('flare at 0.98:', flare_98, '\nfilled total', filled_inv['totalTonnes'], 'AR5', filled_ar5['totalTonnes'])
    print('order', page_curve['order'], 'meets', page_curve['meetsTarget'], 'over', page_curve['overClaims'])
    print('costs', [(c['label'], round(c['costPerTonne'], 4)) for c in costed])


if __name__ == '__main__':
    main()
