#!/usr/bin/env python3
"""Independent oracle for the probabilistic breakeven engine
(engines/economics/breakeven.js, the Suite's breakevenCalculations.js).
Emits committed goldens to test-data/economics/goldens/breakeven_cases.json.

INDEPENDENCE DISCIPLINE. Written from the engine's method statement and
from the screening ledger in oracle_screening.py (the breakeven engine
builds a TaxRoyalty screening case: capex in the first year, opex flat,
production scaled by an efficiency, a flat oil price, no gas, immediate
expensing, MID-YEAR discounting), not by transcribing the JavaScript:

  price solve     the engine bisects NPV(price) 100 times on [0, 500]
                  $/bbl toward the target and returns null when NPV at
                  $500 is still below it. The oracle SOLVES THE PRICE IN
                  CLOSED FORM: with a flat price p, year i contributes
                  w_i [ (1 - roy) q_i p - c_i - t max(0, (1 - roy) q_i p
                  - o_i - d_i) ], so NPV(p) is piecewise LINEAR and
                  increasing with a kink where each year's taxable income
                  crosses zero, at p_i = (o_i + d_i) / ((1 - roy) q_i).
                  The oracle sorts the kinks, finds the segment on which
                  NPV crosses the target, and solves that segment's line
                  exactly. No iteration at all. The same null rule.
  distributions   each stated P10 / P50 / P90 is fitted to a triangular
                  whose CDF passes through all three (shape from the
                  median's position by bisection on the mode position,
                  then scale and origin in closed form, with the engine's
                  documented clamp when no triangular can pass).
  sampling        mulberry32(seed) replicated BIT FOR BIT (uint32
                  arithmetic, divide by 4294967296), three draws per
                  iteration in the order capex, opex, efficiency, each
                  through the triangular inverse CDF; the whole sorted
                  sample is emitted for the seeded cases.
  statistics      P10, P50, P90 as sorted[min(n - 1, floor(q n))], the
                  mean, the CDF y = (i + 1) / n.
  tornado         base case at the P50s; each variable swung P10 to P90
                  (efficiency P90 to P10, since a higher efficiency is a
                  lower breakeven); sorted by swing, largest first, ties
                  keeping input order; low and high sides measured from
                  the base breakeven.
  insights        the sentence with toFixed(2) rounding (round half up on
                  the exact binary value), the seed, the excluded count
                  and any fit notes.

Units: production bbl per year, capex $MM, opex $MM per year, efficiency
in percent for the variables and a fraction inside the solve, prices
$/bbl, NPV $MM, rates percent 0 to 100.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_breakeven.py
"""
import json
import math
import os
import sys
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from oracle_screening import run as screening_run, mulberry32  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'breakeven_cases.json')

DEFAULT_SEED = 20260829
PRICE_MAX = 500.0


def js_to_fixed(x, d):
    q = Decimal(1).scaleb(-d)
    return str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


# ---------------------------------------------------------------------
# Screening inputs for a trial price, and the closed-form solve
# ---------------------------------------------------------------------

def build_inputs(rows, price, capex_mm, opex_mm, efficiency, discount, royalty, tax):
    n = len(rows)
    capex = [0.0] * n
    capex[0] = capex_mm
    return {
        'startYear': rows[0]['year'], 'projectLife': n, 'discountRate': discount, 'fiscalType': 'TaxRoyalty',
        'production': {'oil': [(float(r.get('oil_production_bbl') or 0)) * efficiency for r in rows], 'gas': [0.0] * n},
        'price': {'oil': [price] * n, 'gas': [0.0] * n},
        'capex': capex, 'opexFixed': [opex_mm] * n, 'opexVariable': [0.0] * n, 'abandonment': [0.0] * n,
        'royaltyRate': royalty, 'taxRate': tax,
    }


def npv_at_price(a, price):
    return screening_run(build_inputs(a['rows'], price, a['capexMM'], a['opexMM'], a['efficiency'],
                                      a['discountRate'], a['royaltyRate'], a['taxRate']))['metrics']['npv']


def solve_price(a, target=0.0):
    """Closed form on the piecewise-linear NPV(price)."""
    rows = a['rows']
    n = len(rows)
    r = a['discountRate'] / 100.0
    roy = 1.0 - a['royaltyRate'] / 100.0
    t = a['taxRate'] / 100.0
    q = [(float(row.get('oil_production_bbl') or 0)) * a['efficiency'] / 1e6 for row in rows]  # MMbbl
    cost = [a['opexMM'] + (a['capexMM'] if i == 0 else 0.0) for i in range(n)]
    deduct = [a['opexMM'] + (a['capexMM'] if i == 0 else 0.0) for i in range(n)]  # opex + depreciation (immediate)
    w = [1.0 / (1.0 + r) ** (i + 0.5) for i in range(n)]

    def npv(p):
        tot = 0.0
        for i in range(n):
            net = roy * q[i] * p
            taxable = net - deduct[i]
            tot += w[i] * (net - cost[i] - (t * taxable if taxable > 0 else 0.0))
        return tot

    if npv(PRICE_MAX) < target:
        return None
    kinks = sorted(set(deduct[i] / (roy * q[i]) for i in range(n) if roy * q[i] > 0 and 0.0 < deduct[i] / (roy * q[i]) < PRICE_MAX))
    pts = [0.0] + kinks + [PRICE_MAX]
    for lo, hi in zip(pts, pts[1:]):
        flo, fhi = npv(lo), npv(hi)
        if flo <= target <= fhi and fhi > flo:
            # Linear on the segment: interpolate exactly.
            return lo + (target - flo) * (hi - lo) / (fhi - flo)
    return pts[0] if npv(0.0) >= target else None


# ---------------------------------------------------------------------
# Triangular fit and inverse CDF
# ---------------------------------------------------------------------

def g(u, m):
    return math.sqrt(u * m) if u <= m else 1.0 - math.sqrt((1.0 - u) * (1.0 - m))


def ratio_at(m):
    return (g(0.5, m) - g(0.1, m)) / (g(0.9, m) - g(0.1, m))


LEFT_NOTE = ('the stated median sits too near the P10 for any triangular to pass through all three points; '
             'the fit uses the most left-skewed triangular there is (mode at the minimum)')
RIGHT_NOTE = ('the stated median sits too near the P90 for any triangular to pass through all three points; '
              'the fit uses the most right-skewed triangular there is (mode at the maximum)')


def fit_triangular(p10, p50, p90):
    lo, mid, hi = float(p10), float(p50), float(p90)
    if not hi > lo:
        return {'min': lo, 'mode': mid, 'max': hi, 'exact': True, 'note': None}
    target = (mid - lo) / (hi - lo)
    r_min, r_max = ratio_at(0.0), ratio_at(1.0)
    exact, note, clamped = True, None, target
    if target <= r_min:
        clamped, exact, note = r_min, False, LEFT_NOTE
    elif target >= r_max:
        clamped, exact, note = r_max, False, RIGHT_NOTE
    a, b = 0.0, 1.0
    for _ in range(200):
        m = 0.5 * (a + b)
        if ratio_at(m) < clamped:
            a = m
        else:
            b = m
    m = 0.5 * (a + b)
    rng = (hi - lo) / (g(0.9, m) - g(0.1, m))
    mn = lo - rng * g(0.1, m)
    return {'min': mn, 'mode': mn + m * rng, 'max': mn + rng, 'exact': exact, 'note': note}


def tri_inv(u, a, c, b):
    if a == b:
        return a
    if u <= (c - a) / (b - a):
        return a + math.sqrt(u * (b - a) * (c - a))
    return b - math.sqrt((1.0 - u) * (b - a) * (b - c))


# ---------------------------------------------------------------------
# The probabilistic run
# ---------------------------------------------------------------------

def find_var(variables, needle):
    return next((v for v in variables if needle.upper() in str(v['name']).upper()), None)


def generate(inputs):
    iters = inputs.get('iterations', 5000)
    variables = inputs.get('variables', [])
    rows = (inputs.get('productionData') or {}).get('data')
    seed = inputs.get('seed', DEFAULT_SEED)
    target = inputs.get('targetNpv', 0)
    cv, ov, ev = find_var(variables, 'CAPEX'), find_var(variables, 'OPEX'), find_var(variables, 'Production Efficiency')
    fits = {'capex': fit_triangular(cv['p10'], cv['p50'], cv['p90']),
            'opex': fit_triangular(ov['p10'], ov['p50'], ov['p90']),
            'efficiency': fit_triangular(ev['p10'], ev['p50'], ev['p90'])}
    fit_notes = [f'{k}: {f["note"]}' for k, f in fits.items() if not f['exact'] and f['note']]
    base = {'rows': rows, 'discountRate': inputs['discountRate'], 'royaltyRate': inputs['royaltyRate'], 'taxRate': inputs['taxRate']}
    rng = mulberry32(seed)
    results = []
    unreachable = 0
    for _ in range(iters):
        capex = tri_inv(rng(), fits['capex']['min'], fits['capex']['mode'], fits['capex']['max'])
        opex = tri_inv(rng(), fits['opex']['min'], fits['opex']['mode'], fits['opex']['max'])
        eff = tri_inv(rng(), fits['efficiency']['min'], fits['efficiency']['mode'], fits['efficiency']['max']) / 100.0
        p = solve_price(dict(base, capexMM=capex, opexMM=opex, efficiency=eff), target)
        if p is None:
            unreachable += 1
        else:
            results.append(p)
    results.sort()
    n = len(results)
    if n == 0:
        return {'throws': True, 'excludedIterations': unreachable, 'distributionFits': fits,
                'error': 'No iteration broke even below 500 dollars a barrel.'}
    pct = lambda qq: results[min(n - 1, math.floor(qq * n))]
    mean = sum(results) / n
    kpis = {'p10': pct(0.1), 'p50': pct(0.5), 'p90': pct(0.9), 'mean': mean}
    base_case = dict(base, capexMM=cv['p50'], opexMM=ov['p50'], efficiency=ev['p50'] / 100.0)
    base_be = solve_price(base_case, target)

    def swing(label, low_over, high_over):
        lo = solve_price(dict(base_case, **low_over), target)
        hi = solve_price(dict(base_case, **high_over), target)
        return {'name': label, 'low': lo, 'high': hi, 'swing': 0.0 if lo is None or hi is None else abs(hi - lo)}

    sens = [swing('Total CAPEX', {'capexMM': cv['p10']}, {'capexMM': cv['p90']}),
            swing('Annual OPEX', {'opexMM': ov['p10']}, {'opexMM': ov['p90']}),
            swing('Prod. Efficiency', {'efficiency': ev['p90'] / 100.0}, {'efficiency': ev['p10'] / 100.0})]
    sens = sorted(sens, key=lambda d: -d['swing'])
    tornado = {'y': [d['name'] for d in sens],
               'low': [0.0 if d['low'] is None else d['low'] - base_be for d in sens],
               'high': [0.0 if d['high'] is None else d['high'] - base_be for d in sens],
               'base': [base_be for _ in sens]}
    top = ' and '.join(d['name'] for d in sens[:2])
    parts = [f'The P50 breakeven oil price is {js_to_fixed(kpis["p50"], 2)} per barrel, with a 90 percent chance of being below {js_to_fixed(kpis["p90"], 2)}.',
             f'Breakeven is most sensitive to {top}.',
             f'Run seed {seed}: the same inputs and seed reproduce this result exactly.']
    if unreachable > 0:
        parts.append(f'{unreachable} of {iters} iterations did not break even below 500 dollars a barrel and are excluded from the statistics.')
    parts += fit_notes
    return {'kpis': kpis, 'sample': results, 'cdfY': [(i + 1) / n for i in range(n)], 'tornadoData': tornado,
            'sensitivity': sens, 'insights': ' '.join(parts), 'seed': seed, 'baseBreakeven': base_be,
            'excludedIterations': unreachable, 'distributionFits': fits}


# ---------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------

ROWS = [{'year': 2026 + i, 'oil_production_bbl': 3000000 * (0.85 ** i)} for i in range(10)]
BASE = {'rows': ROWS, 'discountRate': 10, 'royaltyRate': 12.5, 'taxRate': 30, 'capexMM': 1000, 'opexMM': 60, 'efficiency': 0.9}
VARIABLES = [
    {'id': 1, 'name': 'Total CAPEX ($MM)', 'p10': 800, 'p50': 1000, 'p90': 1300},
    {'id': 2, 'name': 'Annual OPEX ($MM/year)', 'p10': 50, 'p50': 60, 'p90': 75},
    {'id': 3, 'name': 'Production Efficiency (%)', 'p10': 85, 'p50': 90, 'p90': 95},
]
INPUTS = {'iterations': 300, 'discountRate': 10, 'royaltyRate': 12.5, 'taxRate': 30, 'targetNpv': 0,
          'productionData': {'data': ROWS}, 'variables': VARIABLES}


def solve_case(cid, note, args, target=0.0):
    p = solve_price(args, target)
    return {'id': cid, 'note': note, 'args': args, 'targetNpv': target, 'expected': {
        'price': p, 'npvAtPrice': None if p is None else npv_at_price(args, p), 'npvAt500': npv_at_price(args, PRICE_MAX)}}


def build():
    G = {'description': (
        'Probabilistic breakeven goldens for engines/economics/breakeven.js. Independent stdlib oracle '
        'tools/validation/economics/oracle_breakeven.py: the breakeven price is solved in CLOSED FORM on '
        'the piecewise-linear mid-year NPV(price) of the screening ledger (kinks where each year\'s '
        'taxable income crosses zero) where the engine bisects 100 times on [0, 500]; the seeded run '
        'replays mulberry32 bit for bit (draw order capex, opex, efficiency per iteration) through an '
        'independently fitted triangular; percentiles by the engine\'s stated sorted[min(n - 1, floor(q n))] '
        'rule; the tornado, its ordering and the insight sentence rebuilt from the numbers with JavaScript '
        'toFixed rounding. `sample` is the whole sorted breakeven sample. Units: production bbl per year, '
        'capex $MM, opex $MM per year, efficiency fraction in `args` and percent in `variables`, prices $/bbl, '
        'NPV $MM, rates percent 0 to 100.'
    )}
    G['solve'] = [
        solve_case('solve_base_npv0', 'Suite test: the base case (capex 1000, opex 60, efficiency 0.9) to NPV 0.', BASE),
        solve_case('solve_base_target_250', 'Suite test: the same case to a target NPV of 250 $MM; a higher hurdle needs a higher price.', BASE, 250.0),
        solve_case('solve_capex_1300', 'Suite test: capex 1300 raises the breakeven.', dict(BASE, capexMM=1300)),
        solve_case('solve_opex_75', 'Suite test: opex 75 raises the breakeven.', dict(BASE, opexMM=75)),
        solve_case('solve_efficiency_95', 'Suite test: efficiency 0.95 lowers the breakeven.', dict(BASE, efficiency=0.95)),
        solve_case('solve_unreachable', 'Suite test: a 500000 $MM target is unreachable below $500; null.', BASE, 5e5),
        solve_case('solve_no_fiscal', 'Royalty and tax at zero: a single linear segment, breakeven = discounted cost over discounted net barrels.',
                   dict(BASE, royaltyRate=0, taxRate=0)),
        solve_case('solve_negative_target', 'A negative target NPV (-200) needs a lower price than breakeven.', BASE, -200.0),
        solve_case('solve_tax_kink_inside_bracket', 'A heavy tax (85 percent) with the kinks well inside the bracket: the crossing sits on a taxed segment.',
                   dict(BASE, taxRate=85)),
        solve_case('solve_single_year', 'A one year profile: capex, opex and production all in one period.',
                   dict(BASE, rows=[ROWS[0]], capexMM=100, opexMM=20)),
        solve_case('solve_zero_production_null', 'No production at all: NPV is flat and negative at every price, so null.',
                   dict(BASE, rows=[{'year': 2026, 'oil_production_bbl': 0}, {'year': 2027, 'oil_production_bbl': 0}])),
        solve_case('solve_free_project_zero', 'No capex and no opex: NPV is non-negative at $0 so the breakeven is 0.',
                   dict(BASE, capexMM=0, opexMM=0)),
    ]
    G['monteCarlo'] = []
    for cid, over, note in (
        ('mc_default_seed_300', {}, 'Suite test inputs (300 iterations) at DEFAULT_SEED 20260829; the whole sorted sample is emitted.'),
        ('mc_seed_12345', {'seed': 12345}, 'Suite test seed 12345.'),
        ('mc_seed_7', {'seed': 7}, 'Suite test seed 7: percentiles bracket the base case, fits extend past the stated percentiles, tornado two-sided.'),
        ('mc_seed_1', {'seed': 1}, 'Suite test seed 1.'),
        ('mc_seed_2', {'seed': 2}, 'Suite test seed 2: a different sample from seed 1, a median within 5 percent.'),
        ('mc_target_250_seed_7', {'seed': 7, 'targetNpv': 250}, 'A 250 $MM target at seed 7.'),
        ('mc_inexact_fit_note', {'seed': 7, 'variables': [
            {'id': 1, 'name': 'Total CAPEX ($MM)', 'p10': 800, 'p50': 820, 'p90': 1300},
            {'id': 2, 'name': 'Annual OPEX ($MM/year)', 'p10': 50, 'p50': 74, 'p90': 75},
            {'id': 3, 'name': 'Production Efficiency (%)', 'p10': 85, 'p50': 90, 'p90': 95}]},
         'Medians too near the P10 (capex) and the P90 (opex): both fits clamp and the insight carries both notes.'),
        ('mc_all_unreachable_throws', {'seed': 5, 'iterations': 20, 'variables': [
            {'id': 1, 'name': 'Total CAPEX ($MM)', 'p10': 40000, 'p50': 50000, 'p90': 60000},
            {'id': 2, 'name': 'Annual OPEX ($MM/year)', 'p10': 50, 'p50': 60, 'p90': 75},
            {'id': 3, 'name': 'Production Efficiency (%)', 'p10': 85, 'p50': 90, 'p90': 95}]},
         'Capex so large that NO iteration breaks even below $500: the engine throws, and the oracle records the empty sample as `throws`.'),
        ('mc_with_unreachable', {'seed': 5, 'iterations': 120, 'variables': [
            {'id': 1, 'name': 'Total CAPEX ($MM)', 'p10': 2800, 'p50': 3400, 'p90': 4200},
            {'id': 2, 'name': 'Annual OPEX ($MM/year)', 'p10': 50, 'p50': 60, 'p90': 75},
            {'id': 3, 'name': 'Production Efficiency (%)', 'p10': 85, 'p50': 90, 'p90': 95}]},
         'Capex so large that part of the sample cannot break even below $500: those iterations are excluded and counted.'),
        ('mc_default_seed_2000', {'iterations': 2000}, '2000 iterations at the default seed; the sample is emitted in full.'),
    ):
        inp = dict(INPUTS, **over)
        G['monteCarlo'].append({'id': cid, 'note': note, 'inputs': inp, 'expected': generate(inp)})
    return G


def main():
    G = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(G, f, indent=1, sort_keys=True)
        f.write('\n')
    n = sum(len(v) for k, v in G.items() if isinstance(v, list))
    print(f'wrote {OUT}: {n} cases')


if __name__ == '__main__':
    main()
