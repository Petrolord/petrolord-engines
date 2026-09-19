#!/usr/bin/env python3
"""Oracle for engines/downstream/modularRefinery.js (MD2-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. THE ANNUAL ACCOUNTS are kept here as a refinery keeps them: barrels run
    in the year, dollars of product sold, dollars of crude bought, fixed and
    variable operating dollars, capital dollars, and a TAX LOSS LEDGER that
    records each year's loss as its own entry and consumes the entries
    oldest first. The engine and the screening module carry one running
    pool. For a flat tax rate the two must agree; they meet only in the
    answer.
 2. NPV is discounted here from those accounts with the mid-year convention
    the Suite's screening engine DECLARES (a flow in year t is discounted at
    t + 0.5). That convention is restated, not validated: it is a held
    convention of the canonical engine, and the gate pins it.
 3. THE SCALE CURVES are a power law, which has no second derivation; the
    oracle checks the CROSSOVER instead (at the reference size the two laws
    agree exactly, below it the 0.9 law is cheaper, above it dearer), which
    is a property of the exponents and not a transcription of the formula.

It also writes, for the record, the NPV the Suite page used to show, where
revenue went in as a negative operating cost and a construction-year loss was
thrown away. That number is what MD2-0 corrects; it is not a target.

The inputs are the Suite page's own defaults (src/contexts/
ModularRefineryContext.jsx) plus variations. Prices and costs there are
illustrative, as the page says.

stdlib only. Writes test-data/downstream/goldens/modularrefinery_cases.json
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'modularrefinery_cases.json')

CONFIG = {
    'topping': {'lpg': 0.02, 'naphtha': 0.18, 'kerosene': 0.14, 'diesel': 0.30, 'fuelOil': 0.34, 'loss': 0.02},
    'hydroskimming': {'lpg': 0.03, 'gasoline': 0.20, 'kerosene': 0.13, 'diesel': 0.32, 'fuelOil': 0.30, 'loss': 0.02},
    'conversion': {'lpg': 0.05, 'gasoline': 0.34, 'kerosene': 0.12, 'diesel': 0.33, 'fuelOil': 0.14, 'loss': 0.02},
}
SCENARIOS = {'firm': (0.92, 0), 'tight': (0.75, 3), 'disrupted': (0.50, 6)}
PRICES = {'lpg': 55, 'gasoline': 108, 'naphtha': 78, 'kerosene': 100, 'diesel': 104, 'fuelOil': 58}
DEFAULTS = dict(configurationId='hydroskimming', capacityBpd=10000, onstreamDays=340, scenarioId='firm',
                crudeCostPerBbl=80, baseCost=100e6, baseCapacity=10000, modularExponent=0.9,
                fixedOpexPerYear=12e6, variableOpexPerBbl=3.5, projectLife=20, constructionYears=2,
                discountRate=12, taxRate=30)


def slate_value(yields, prices):
    # product barrels per barrel of crude, times their price
    return sum(frac * prices[p] for p, frac in yields.items() if p != 'loss' and p in prices)


def accounts(inp):
    util, premium = SCENARIOS[inp['scenarioId']]
    capex = inp['baseCost'] * (inp['capacityBpd'] / inp['baseCapacity']) ** inp['modularExponent']
    bbl = inp['capacityBpd'] * inp['onstreamDays'] * util
    value = slate_value(CONFIG[inp['configurationId']], PRICES)
    crude = inp['crudeCostPerBbl'] + premium
    build = inp['constructionYears']
    rows = []
    for y in range(build + inp['projectLife']):
        running = y >= build
        b = bbl if running else 0.0
        spend = (capex / build if (build > 0 and not running) else (capex if build == 0 and y == 0 else 0.0))
        rows.append({
            'year': y, 'bbl': b, 'revenue': b * value, 'crude': b * crude,
            'fixed': inp['fixedOpexPerYear'] if running else 0.0,
            'variable': b * inp['variableOpexPerBbl'], 'capex': spend,
        })
    return rows, capex, value


def tax_with_ledger(rows, rate):
    """Tax year by year, losses kept as dated entries and used oldest first."""
    ledger = []  # [year, remaining loss]
    out = []
    for r in rows:
        income = r['revenue'] - r['crude'] - r['fixed'] - r['variable'] - r['capex']
        if income < 0:
            ledger.append([r['year'], -income])
            out.append(0.0)
            continue
        for entry in ledger:
            use = min(entry[1], income)
            entry[1] -= use
            income -= use
            if income == 0:
                break
        out.append(income * rate / 100.0)
    return out


def npv_mid_year(flows, rate):
    return sum(f / (1 + rate / 100.0) ** (t + 0.5) for t, f in enumerate(flows))


def case(name, why, **over):
    inp = dict(DEFAULTS, **over)
    rows, capex, value = accounts(inp)
    tax = tax_with_ledger(rows, inp['taxRate'])
    ncf = [r['revenue'] - r['crude'] - r['fixed'] - r['variable'] - r['capex'] - t for r, t in zip(rows, tax)]
    # the page's old reading: no carry-forward, so a loss year's deduction is gone
    tax_old = [max(0.0, r['revenue'] - r['crude'] - r['fixed'] - r['variable'] - r['capex']) * inp['taxRate'] / 100.0
               for r in rows]
    ncf_old = [r['revenue'] - r['crude'] - r['fixed'] - r['variable'] - r['capex'] - t for r, t in zip(rows, tax_old)]
    mm = 1e6
    return {
        'name': name, 'why': why, 'inputs': inp,
        'capex': capex, 'grossValuePerBbl': value, 'annualBbl': rows[-1]['bbl'],
        'years': [{**r, 'tax': t, 'ncf': f} for r, t, f in zip(rows, tax, ncf)],
        'npvMM': npv_mid_year([f / mm for f in ncf], inp['discountRate']),
        'totalTaxMM': sum(tax) / mm,
        'totalRevenueMM': sum(r['revenue'] for r in rows) / mm,
        'oldPageNpvMM': npv_mid_year([f / mm for f in ncf_old], inp['discountRate']),
    }


def scale_cases():
    out = []
    base, bq = 100e6, 10000
    for q in (2000, 5000, 10000, 20000, 50000):
        mod = base * (q / bq) ** 0.9
        stick = base * (q / bq) ** 0.6
        out.append({'capacity': q, 'modularCost': mod, 'stickBuiltCost': stick,
                    'modularCheaper': mod < stick, 'equal': q == bq})
    return out


def main():
    cases = [
        case('Suite defaults: hydroskimming, 10,000 bpd, firm supply', 'what the page shows with nothing typed'),
        case('defaults on crude at 74', 'a profitable hydroskimmer, where the construction-year loss carried forward is worth money',
             crudeCostPerBbl=74),
        case('tight supply', 'the page\'s middle scenario', scenarioId='tight'),
        case('disrupted supply', 'half the nameplate and a premium', scenarioId='disrupted'),
        case('topping plant', 'the simplest configuration', configurationId='topping'),
        case('conversion plant at 20,000 bpd', 'a larger plant on the 0.9 law', configurationId='conversion', capacityBpd=20000),
        case('no construction period', 'capital spent in year 0, where it used to vanish', constructionYears=0),
        case('three-year build at 20 percent', 'a long build and a high hurdle', constructionYears=3, discountRate=20),
    ]
    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_modularrefinery.py',
            'method': 'annual accounts; a dated tax-loss ledger used oldest first; mid-year NPV restated from the screening engine',
            'engine': 'engines/downstream/modularRefinery.js (feasibilityStreams, feasibilityEconomics) over engines/economics/screening.js',
            'published': 'none: the inputs are the Suite page defaults, labelled illustrative there',
            'heldConventions': {'midYearDiscounting': True, 'capexExpensedInYearSpent': True, 'royalty': 0},
        },
        'scale': scale_cases(),
        'cases': cases,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    for c in cases:
        print(f"{c['name'][:48]:48s} NPV {c['npvMM']:9.3f}  old page {c['oldPageNpvMM']:9.3f}  tax {c['totalTaxMM']:8.2f}")


if __name__ == '__main__':
    main()
