#!/usr/bin/env python3
"""Independent oracle for the screening economics engine
(engines/economics/screening.js, the Suite's npvCalculations.js). Emits
committed goldens to test-data/economics/goldens/screening_cases.json.

INDEPENDENCE DISCIPLINE. Written from the METHOD STATEMENT the engine
documents in its header and function comments, not by transcribing the
JavaScript. The statement, in the engine's own words and units:

  profiles      an exponential decline profile is the initial daily rate
                times 365, declining by declineRate percent a year; a flat
                profile repeats one value. The oracle evaluates the
                decline in CLOSED FORM, q0 * 365 * (1 - d/100)^i, where the
                engine multiplies year on year.
  revenue       oil bbl times $/bbl plus gas mscf times $/mscf, in $MM.
  royalty       a flat percent of gross revenue.
  depreciation  straight line over capexDepreciationYears (rounded, at
                least 1) starting in the year the capex is spent; any
                portion scheduled past the horizon is never deducted.
                Cash capex is always in-year.
  TaxRoyalty    taxable = net revenue - opex - abex - depreciation; tax is
                taxRate percent of the positive part; contractor NCF is
                net revenue less all cash cost less tax; government take
                is royalty plus tax.
  PSC           cost oil is the lesser of the cost-recovery cap (a percent
                of net revenue) and the pool (carried unrecovered cost
                plus this year's cost); the remainder carries forward.
                Profit oil is net revenue less cost oil, split by
                profitSplitContractor; tax is taxRate percent of the
                contractor's profit share; contractor NCF is cost oil plus
                profit share less cash cost less tax; government take is
                royalty plus the government's profit share plus tax.
  NPV           MID-YEAR discounting, sum of NCF_i / (1 + r)^(i + 0.5).
  IRR           the rate at which the mid-year NPV is zero, in percent,
                reported as 0 when the cash flow never changes sign. The
                engine runs a clamped Newton-Raphson from 10 percent; the
                oracle SCANS NPV(r) on a fine grid over (-99, 20000]
                percent and BISECTS every sign change, so it also sees
                second roots and roots the clamp hides.
  payback       years from the start of the project: index i of the first
                non-negative cumulative NCF plus the fraction of period i
                needed to cover the shortfall carried in; 0 if the first
                period is already non-negative; the project life if the
                cumulative never turns non-negative.
  maxExposure   the minimum cumulative NCF.
  sensitivity   NPV at -30 and +30 percent of oil price, capex, FIXED
                opex and oil production, one at a time.
  scenarios     Low is -20 percent price and production with +20 percent
                capex and fixed opex; High is the mirror image.
  quick inputs  a 20 year case with capex split half and half over the
                first two years, gas at 3.5 $/mscf and zero volume, and
                variable opex at opexPerBbl dollars a barrel.
  portfolio     sums of NPV and capex, risked NPV as NPV times chance of
                success, capital efficiency as NPV over capex, and the
                plain average IRR.
  Monte Carlo   uniform draws of val * (1 +/- range) for every production,
                price and capex entry, in that order; P10, P50, P90 by the
                simple-statistics quantile rule; a 20 bin histogram; and a
                CDF downsampled to every floor(iterations/50)th point.
                THE ENGINE DRAWS FROM Math.random AND IS THEREFORE NOT
                REPRODUCIBLE (recorded in FINDINGS-fiscal.md). The gate
                substitutes a mulberry32 stream for Math.random and the
                oracle replicates mulberry32 BIT FOR BIT in uint32
                arithmetic, dividing by 4294967296.

Units: volumes bbl and mscf per year, prices $/bbl and $/mscf, every money
figure $MM, rates in percent (0 to 100), payback in years, IRR in percent.

Where the engine and the oracle disagree the golden carries BOTH numbers
under `engine` with a `disagreement` note; the engine's number was read
from the engine and is pinned so that a silent change is caught.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_screening.py
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'screening_cases.json')


# ---------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------

def decline_profile(q0, d_pct, years):
    """Annual volumes of an exponential decline, closed form."""
    return [q0 * 365.0 * (1.0 - d_pct / 100.0) ** i for i in range(years)]


def flat(v, n):
    return [v] * n


def js_round(x):
    """JavaScript Math.round: halves go toward +infinity."""
    return math.floor(x + 0.5)


# ---------------------------------------------------------------------
# The ledger
# ---------------------------------------------------------------------

def at(arr, i):
    """`arr[i] || 0` semantics: a missing entry is zero."""
    if arr is None or i >= len(arr) or arr[i] is None:
        return 0.0
    return float(arr[i])


def depreciation_schedule(capex, life, depr_years):
    n = max(1, js_round(depr_years))
    depr = [0.0] * life
    for i in range(life):
        portion = at(capex, i) / n
        for y in range(i, min(i + n, life)):
            depr[y] += portion
    return depr


def mid_year_npv(ncf, r):
    """r is a fraction. Mid-year: cash at t = i + 0.5."""
    return sum(cf / (1.0 + r) ** (i + 0.5) for i, cf in enumerate(ncf))


def irr_roots_pct(ncf):
    """Every rate in (-99, 20000] percent at which the mid-year NPV is
    zero, by a fine scan and bisection. Returns [] when there is none."""
    if not (any(c < 0 for c in ncf) and any(c > 0 for c in ncf)):
        return []
    f = lambda r: mid_year_npv(ncf, r)
    roots = []
    # Fine in the plausible band, coarser out to the clamp.
    grid = [-0.99 + k * 0.0005 for k in range(0, int(round(1.99 / 0.0005)) + 1)]
    grid += [1.0 + k * 0.01 for k in range(1, 901)]
    # Past the engine's 1000 percent clamp, so a root the clamp hides is
    # still reported as the true IRR.
    grid += [10.0 + k * 0.5 for k in range(1, 381)]
    prev_r, prev_f = grid[0], f(grid[0])
    for r in grid[1:]:
        fr = f(r)
        if prev_f == 0.0:
            roots.append(prev_r)
        elif (prev_f < 0) != (fr < 0):
            lo, hi, flo = prev_r, r, prev_f
            for _ in range(200):
                mid = 0.5 * (lo + hi)
                fm = f(mid)
                if (fm < 0) == (flo < 0):
                    lo, flo = mid, fm
                else:
                    hi = mid
            roots.append(0.5 * (lo + hi))
        prev_r, prev_f = r, fr
    return [100.0 * r for r in roots]


def payback_years(cum, ncf, life):
    first = next((i for i, c in enumerate(cum) if c >= 0), -1)
    if first > 0:
        prev = cum[first - 1]
        cur = ncf[first]
        return first + abs(prev) / cur if cur > 0 else float(first)
    if first == 0:
        return 0.0
    return float(life)


def run(inp):
    """The full screening result: cash flow rows and metrics."""
    life = int(inp.get('projectLife', 20))
    start = inp.get('startYear')
    r = inp.get('discountRate', 10) / 100.0
    fiscal = inp.get('fiscalType', 'TaxRoyalty')
    prod = inp.get('production', {}) or {}
    price = inp.get('price', {}) or {}
    oil, gas = prod.get('oil', []), prod.get('gas', [])
    poil, pgas = price.get('oil', []), price.get('gas', [])
    capex = inp.get('capex', [])
    opex_f = inp.get('opexFixed', [])
    opex_v = inp.get('opexVariable', [])
    abex = inp.get('abandonment', [])
    roy = inp.get('royaltyRate', 0) / 100.0
    tax_rate = inp.get('taxRate', 0) / 100.0
    crc = inp.get('costRecoveryCap', 100) / 100.0
    share = inp.get('profitSplitContractor', 100) / 100.0
    depr = depreciation_schedule(capex, life, inp.get('capexDepreciationYears', 1))

    rows = []
    cum = 0.0
    pool = 0.0
    tot = dict(rev=0.0, capex=0.0, opex=0.0, tax=0.0, roy=0.0, gov=0.0)
    for i in range(life):
        gross = (at(oil, i) * at(poil, i) + at(gas, i) * at(pgas, i)) / 1e6
        cpx = at(capex, i)
        opx = at(opex_f, i) + at(opex_v, i)
        abx = at(abex, i)
        cost = cpx + opx + abx
        royalty = gross * roy
        net = gross - royalty
        if fiscal == 'TaxRoyalty':
            taxable = net - opx - abx - depr[i]
            tax = taxable * tax_rate if taxable > 0 else 0.0
            ncf = net - cost - tax
            gov = royalty + tax
            carried = 0.0
        else:
            avail = pool + cost
            cap = net * crc
            recovered = min(cap, avail)
            pool = avail - recovered
            profit_oil = max(0.0, net - recovered)
            c_profit = profit_oil * share
            g_profit = profit_oil * (1.0 - share)
            tax = c_profit * tax_rate
            ncf = (recovered + c_profit) - cost - tax
            gov = royalty + g_profit + tax
            carried = pool
        cum += ncf
        tot['rev'] += gross
        tot['capex'] += cpx
        tot['opex'] += opx
        tot['tax'] += tax
        tot['roy'] += royalty
        tot['gov'] += gov
        rows.append({
            'year': (start + i) if start is not None else None,
            'grossRevenue': gross, 'royalty': royalty, 'capex': cpx, 'opex': opx,
            'abex': abx, 'tax': tax, 'depreciation': depr[i],
            'pscUnrecoveredCost': carried, 'ncf': ncf, 'cumulativeNCF': cum,
            'govTake': gov,
        })
    ncf = [row['ncf'] for row in rows]
    cum_arr = [row['cumulativeNCF'] for row in rows]
    roots = irr_roots_pct(ncf)
    metrics = {
        'npv': mid_year_npv(ncf, r),
        'irr': roots[0] if len(roots) == 1 else (0.0 if not roots else None),
        'irrRoots': roots,
        'payback': payback_years(cum_arr, ncf, life),
        'maxExposure': min(cum_arr) if cum_arr else None,
        'totalRevenue': tot['rev'], 'totalCapex': tot['capex'], 'totalOpex': tot['opex'],
        'totalTax': tot['tax'], 'totalRoyalty': tot['roy'], 'totalGovTake': tot['gov'],
    }
    return {'metrics': metrics, 'cashflow': rows}


# ---------------------------------------------------------------------
# Sensitivity, scenarios, quick inputs, portfolio
# ---------------------------------------------------------------------

def scaled(inp, **mult):
    """A deep copy with the named profile scaled."""
    out = json.loads(json.dumps(inp))
    for key, m in mult.items():
        if key == 'oilPrice':
            out['price']['oil'] = [v * m for v in out['price']['oil']]
        elif key == 'capex':
            out['capex'] = [v * m for v in out['capex']]
        elif key == 'opexFixed':
            out['opexFixed'] = [v * m for v in out['opexFixed']]
        elif key == 'oilProd':
            out['production']['oil'] = [v * m for v in out['production']['oil']]
    return out


def sensitivity(inp):
    base = run(inp)['metrics']['npv']
    out = []
    for name, key in (('Oil Price', 'oilPrice'), ('CAPEX', 'capex'), ('OPEX', 'opexFixed'), ('Production', 'oilProd')):
        lo = run(scaled(inp, **{key: 0.7}))['metrics']['npv']
        hi = run(scaled(inp, **{key: 1.3}))['metrics']['npv']
        out.append({'name': name, 'lowParamNPV': lo, 'highParamNPV': hi, 'baseNPV': base})
    return out


def scenarios(inp):
    low = scaled(inp, oilPrice=0.8, oilProd=0.8, capex=1.2, opexFixed=1.2)
    high = scaled(inp, oilPrice=1.2, oilProd=1.2, capex=0.8, opexFixed=0.8)
    return {'Base': run(inp), 'Low': run(low), 'High': run(high)}


def expand_quick(q):
    life = 20
    oil = decline_profile(q['initialRate'], q['declineRate'], life)
    capex = [0.0] * life
    capex[0] = q['capex'] * 0.5
    capex[1] = q['capex'] * 0.5
    return {
        'startYear': q['startYear'], 'projectLife': life, 'discountRate': q['discountRate'],
        'fiscalType': 'TaxRoyalty',
        'production': {'oil': oil, 'gas': [0.0] * life},
        'price': {'oil': flat(q['oilPrice'], life), 'gas': flat(3.5, life)},
        'capex': capex, 'opexFixed': flat(q['fixedOpex'], life),
        'opexVariable': [v * q['opexPerBbl'] / 1e6 for v in oil],
        'abandonment': [0.0] * life,
        'royaltyRate': q['royaltyRate'], 'taxRate': q['taxRate'],
    }


def portfolio(projects):
    npv = sum(p.get('npv', 0) or 0 for p in projects)
    capex = sum(p.get('capex', 0) or 0 for p in projects)
    risked = sum((p.get('npv', 0) or 0) * (1.0 if p.get('chanceOfSuccess') is None else p['chanceOfSuccess']) for p in projects)
    eff = npv / capex if capex > 0 else 0.0
    avg = sum(p.get('irr', 0) or 0 for p in projects) / (len(projects) or 1)
    return {'totalNPV': npv, 'totalCapex': capex, 'totalRiskedNPV': risked, 'capitalEfficiency': eff, 'avgIRR': avg}


# ---------------------------------------------------------------------
# Monte Carlo with a bit-for-bit mulberry32 in place of Math.random
# ---------------------------------------------------------------------

M32 = 0xFFFFFFFF


def imul(a, b):
    """Math.imul: low 32 bits of the product."""
    return (a * b) & M32


def mulberry32(seed):
    state = [seed & M32]

    def nxt():
        state[0] = (state[0] + 0x6D2B79F5) & M32
        t = state[0]
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ (t + imul(t ^ (t >> 7), t | 61))) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296.0
    return nxt


def ss_quantile_sorted(x, p):
    """simple-statistics 7.8.8 quantile rule on a sorted array."""
    n = len(x)
    idx = n * p
    if p == 1:
        return x[-1]
    if p == 0:
        return x[0]
    if idx % 1 != 0:
        return x[math.ceil(idx) - 1]
    idx = int(idx)
    if n % 2 == 0:
        return (x[idx - 1] + x[idx]) / 2.0
    return x[idx]


def monte_carlo(inp, settings, seed):
    rng = mulberry32(seed)
    iters = settings.get('iterations', 500) or 500
    unc = settings['uncertainties']

    def sample(v, rng_range):
        if not rng_range:
            return v
        lo, hi = v * (1 - rng_range), v * (1 + rng_range)
        return lo + (hi - lo) * rng()

    results = []
    for _ in range(iters):
        it = json.loads(json.dumps(inp))
        it['production'] = {
            'oil': [sample(v, unc.get('reserves')) for v in inp['production']['oil']],
            'gas': [sample(v, unc.get('reserves')) for v in inp['production']['gas']],
        }
        it['price'] = {
            'oil': [sample(v, unc.get('price')) for v in inp['price']['oil']],
            'gas': [sample(v, unc.get('price')) for v in inp['price']['gas']],
        }
        it['capex'] = [sample(v, unc.get('capex')) for v in inp['capex']]
        results.append(run(it)['metrics']['npv'])
    results.sort()
    mean = 0.0
    for v in results:
        mean += v
    mean /= iters
    lo, hi = results[0], results[-1]
    bins = 20
    size = (hi - lo) / bins
    hist = [{'binStart': lo + i * size, 'binEnd': lo + (i + 1) * size, 'count': 0} for i in range(bins)]
    degenerate = size == 0
    if not degenerate:
        for v in results:
            hist[min(int(math.floor((v - lo) / size)), bins - 1)]['count'] += 1
    step = math.floor(iters / 50)
    cdf = ([] if step == 0 else
           [{'value': v, 'probability': (i / iters) * 100} for i, v in enumerate(results) if i % step == 0])
    return {
        'p10': ss_quantile_sorted(results, 0.1), 'p50': ss_quantile_sorted(results, 0.5),
        'p90': ss_quantile_sorted(results, 0.9), 'emv': mean,
        'histogram': hist, 'cdf': cdf, 'allValues': results, 'degenerateHistogram': degenerate,
    }


# ---------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------

def base_oil(decline=12, life=10):
    """The sweep base profile: a development year, then 20000 bopd declining."""
    return [0.0] + decline_profile(20000, decline, life - 1)


def base_inputs(**over):
    """A 10 year TaxRoyalty screening case used by the sweeps: year one
    is the development year (capex 400, no production), production
    starts in year two at 20000 bopd, and the last year carries an
    abandonment cost."""
    life = 10
    oil = base_oil()
    inp = {
        'startYear': 2027, 'projectLife': life, 'discountRate': 10, 'fiscalType': 'TaxRoyalty',
        'production': {'oil': oil, 'gas': [0.0] * life},
        'price': {'oil': flat(75.0, life), 'gas': [0.0] * life},
        'capex': [400.0, 200.0] + [0.0] * (life - 2),
        'opexFixed': [0.0] + flat(40.0, life - 1),
        'opexVariable': [v * 6.0 / 1e6 for v in oil],
        'abandonment': [0.0] * (life - 1) + [50.0],
        'royaltyRate': 12.5, 'taxRate': 30,
    }
    inp.update(over)
    return inp


def two_year(**over):
    inp = {
        'startYear': 2030, 'projectLife': 2, 'discountRate': 10, 'fiscalType': 'TaxRoyalty',
        'production': {'oil': [1000000, 1000000], 'gas': [0, 0]},
        'price': {'oil': [100, 100], 'gas': [0, 0]},
        'capex': [50, 0], 'opexFixed': [10, 10], 'opexVariable': [0, 0], 'abandonment': [0, 0],
        'royaltyRate': 20, 'taxRate': 50,
    }
    inp.update(over)
    return inp


def psc_two_year(**over):
    inp = {
        'startYear': 2030, 'projectLife': 2, 'discountRate': 10, 'fiscalType': 'PSC',
        'production': {'oil': [1000000, 1000000], 'gas': [0, 0]},
        'price': {'oil': [100, 100], 'gas': [0, 0]},
        'capex': [80, 0], 'opexFixed': [10, 10], 'opexVariable': [0, 0], 'abandonment': [0, 0],
        'royaltyRate': 10, 'taxRate': 50, 'costRecoveryCap': 40, 'profitSplitContractor': 50,
    }
    inp.update(over)
    return inp


def ncf_case(cid, note, ncf, start=2030, **extra):
    """A case built so the engine's NCF is exactly the given vector:
    revenue in $MM is oil bbl times 1 $/bbl over 1e6, no fiscal terms,
    negatives are capex."""
    life = len(ncf)
    inp = {
        'startYear': start, 'projectLife': life, 'discountRate': 10, 'fiscalType': 'TaxRoyalty',
        'production': {'oil': [c * 1e6 if c > 0 else 0 for c in ncf], 'gas': [0] * life},
        'price': {'oil': [1.0] * life, 'gas': [0] * life},
        'capex': [-c if c < 0 else 0 for c in ncf], 'opexFixed': [0] * life,
        'opexVariable': [0] * life, 'abandonment': [0] * life, 'royaltyRate': 0, 'taxRate': 0,
    }
    inp.update(extra)
    return case(cid, note, inp)


def fdp_inputs(capex_mm, opex_mm, kbpd, prices, royalty=12.5, tax=30, disc=10, var_opex=5):
    """The Suite's runFdpCase mapping: year one carries the capex and no
    production; each producing year follows with kbpd * 1000 * 365 bbl."""
    n = len(kbpd)
    life = n + 1
    oil = [0.0] + [k * 1000 * 365 for k in kbpd]
    return {
        'startYear': 0, 'projectLife': life, 'discountRate': disc, 'fiscalType': 'TaxRoyalty',
        'production': {'oil': oil, 'gas': [0] * life},
        'price': {'oil': [0] + list(prices), 'gas': [0] * life},
        'capex': [capex_mm] + [0] * n,
        'opexFixed': [0] + [opex_mm] * n,
        'opexVariable': [0] + [(k * 1000 * 365 * var_opex) / 1e6 for k in kbpd],
        'abandonment': [0] * life, 'royaltyRate': royalty, 'taxRate': tax,
    }


def case(cid, note, inp, engine=None):
    res = run(inp)
    c = {'id': cid, 'note': note, 'inputs': inp, 'expected': res}
    if engine:
        c['engine'] = engine
    return c


def build():
    G = {'description': (
        'Screening economics goldens for engines/economics/screening.js (the Suite\'s '
        'npvCalculations.js). Independent stdlib oracle tools/validation/economics/'
        'oracle_screening.py written from the engine\'s method statement: closed-form '
        'decline profiles against the engine\'s year-on-year multiplication, the '
        'TaxRoyalty and PSC ledgers with straight-line depreciation over '
        'capexDepreciationYears (horizon rule) and PSC cost-recovery carryforward, '
        'MID-YEAR discounting at t + 0.5, IRR by a fine scan and bisection of every '
        'sign change (the engine runs clamped Newton from 10 percent; `irrRoots` lists '
        'every root the oracle found and `irr` is the single root or 0 when none), '
        'payback in years from project start, sensitivity at plus and minus 30 percent, '
        'the plus and minus 20 percent scenarios, expandQuickInputs, getPortfolioMetrics, '
        'and runMonteCarlo replayed with a bit-for-bit mulberry32 stream standing in for '
        'Math.random (draw order: oil volumes, gas volumes, oil prices, gas prices, capex; '
        'an entry with a falsy range consumes no draw). Units: volumes bbl and mscf per '
        'year, prices $/bbl and $/mscf, all money $MM, rates percent 0 to 100, payback '
        'years, IRR percent. Where the engine and the oracle disagree the case carries an '
        '`engine` object with the engine\'s pinned number and a `disagreement` note.'
    )}

    # ---- hand-derived TaxRoyalty (Suite npvCalculations.test.js) ----
    G['taxRoyalty'] = [
        case('tr_hand_2yr', 'Suite test: $100 oil, 1 MMbbl/yr, royalty 20, tax 50, capex 50 in year 1, opex 10; '
             'year 1 royalty 20, tax 10, ncf 10; year 2 tax 35, ncf 35; NPV = 10/1.1^0.5 + 35/1.1^1.5.',
             two_year()),
        case('tr_hand_2yr_depr2', 'Suite test: same with capexDepreciationYears 2; depreciation 25 a year, '
             'tax 22.5 both years, ncf -2.5 then 47.5, cash out unchanged at 70.',
             two_year(capexDepreciationYears=2)),
        case('tr_base_10yr', 'The 10 year base case behind the sweeps: a development year, then 20000 bopd declining 12 percent, '
             '$75 oil, capex 400 + 200, fixed opex 40, variable 6 $/bbl, abandonment 50 in the last year.',
             base_inputs()),
        case('tr_gas_and_oil', 'Oil and gas revenue together with a constant gas price.',
             base_inputs(production={'oil': base_oil(), 'gas': [0.0] + decline_profile(30000, 8, 9)},
                         price={'oil': flat(75.0, 10), 'gas': flat(3.5, 10)})),
        case('tr_missing_profiles', 'Profiles shorter than projectLife read as zero beyond their end '
             '(the engine\'s `|| 0`); gas and abandonment omitted entirely.',
             {'startYear': 2030, 'projectLife': 4, 'discountRate': 8, 'fiscalType': 'TaxRoyalty',
              'production': {'oil': [500000, 400000], 'gas': []}, 'price': {'oil': [60, 60, 60, 60], 'gas': []},
              'capex': [20], 'opexFixed': [5, 5, 5, 5], 'royaltyRate': 10, 'taxRate': 30}),
    ]

    # ---- FDP economics cases (Suite src/utils/fdp/__tests__/economics.test.js) ----
    profile = [10, 25, 45, 50, 48, 42, 35, 30, 25, 20]
    prices = [75] * len(profile)
    G['fdp'] = [
        case('fdp_800_default_fiscal', 'runFdpCase capex 800, opex 60, the ten year kbpd profile at $75, '
             'default fiscal (royalty 12.5, tax 30, variable opex 5 $/bbl), expanded to engine inputs.',
             fdp_inputs(800, 60, profile, prices)),
        case('fdp_800_no_fiscal', 'The same case with royalty and tax at zero; post-fiscal NPV must be below 0.75 of this.',
             fdp_inputs(800, 60, profile, prices, royalty=0, tax=0)),
        case('fdp_never_pays_back', 'capex 100000 on the same profile: never pays back, payback reports the project life.',
             fdp_inputs(100000, 60, profile, prices)),
    ]

    # ---- PSC (EPE oracle Case 3, hand-derived, all three client engines agree) ----
    psc4 = psc_two_year(projectLife=4, production={'oil': flat(1000000, 4), 'gas': flat(0, 4)},
                        price={'oil': flat(100, 4), 'gas': flat(0, 4)}, capex=[80, 0, 0, 0],
                        opexFixed=flat(10, 4), opexVariable=flat(0, 4), abandonment=flat(0, 4))
    fiscal_life = 25
    fiscal_oil = [30000 * 365 * (0.88 ** i) for i in range(fiscal_life)]
    fiscal_opex = [60 + (30000 * 365 * (0.88 ** i)) * 4 / 1e6 for i in range(fiscal_life)]
    G['psc'] = [
        case('psc_hand_2yr_carryforward', 'EPE oracle Case 3: royalty 10, cost oil cap 40, contractor share 50, tax 50, '
             '$100 oil, 1 MMbbl/yr, capex 80 year 1, opex 10. Year 1: royalty 10, cost oil 36 of a 90 pool (54 carried), '
             'profit oil 54, contractor 27, tax 13.5, ncf -40.5. Year 2: pool 38, cost oil 36 (2 carried), ncf 39.5.',
             psc_two_year()),
        case('psc_hand_4yr_pool_clears', 'Extended to four years: pool 28 -> year 3 recovers 36 of 38 (2 carried) -> year 4 clears.',
             psc4),
        case('psc_fiscal_parity_25yr', 'The Fiscal Designer parity case: 30000 bopd declining 12 percent for 25 years at $80, '
             'capex 1000 in year 1, opex 60 + 4 $/boe, royalty 12.5, full cost recovery, 100 percent split, tax 30. '
             'The fiscal engine\'s annual contractor NCF must equal this ncf and its year-end NPV times sqrt(1.1) must equal this NPV.',
             {'startYear': 1, 'projectLife': fiscal_life, 'discountRate': 10, 'fiscalType': 'PSC',
              'production': {'oil': fiscal_oil, 'gas': [0] * fiscal_life},
              'price': {'oil': [80] * fiscal_life, 'gas': [0] * fiscal_life},
              'capex': [1000] + [0] * (fiscal_life - 1), 'opexFixed': fiscal_opex,
              'opexVariable': [0] * fiscal_life, 'abandonment': [0] * fiscal_life,
              'royaltyRate': 12.5, 'taxRate': 30, 'costRecoveryCap': 100, 'profitSplitContractor': 100}),
        case('psc_tight_cap_never_recovers', 'Cost recovery capped at 5 percent: the pool grows every year and never clears.',
             psc_two_year(projectLife=6, costRecoveryCap=5, production={'oil': flat(1000000, 6), 'gas': flat(0, 6)},
                          price={'oil': flat(100, 6), 'gas': flat(0, 6)}, capex=[80, 0, 0, 0, 0, 0],
                          opexFixed=flat(10, 6), opexVariable=flat(0, 6), abandonment=flat(0, 6))),
        case('psc_zero_share_all_government', 'Contractor profit share 0: the contractor only ever receives cost oil.',
             psc_two_year(profitSplitContractor=0)),
        case('psc_full_share_no_royalty', 'Royalty 0, cap 100, share 100: PSC collapses to a plain tax on net revenue less cost.',
             psc_two_year(royaltyRate=0, costRecoveryCap=100, profitSplitContractor=100)),
    ]

    # ---- IRR (Suite tests plus roots the method statement must expose) ----
    G['irr'] = [
        case('irr_no_sign_change', 'Suite test: all-positive cash flow, IRR reported as 0.',
             {'startYear': 2030, 'projectLife': 2, 'discountRate': 10, 'fiscalType': 'TaxRoyalty',
              'production': {'oil': [1000000, 1000000], 'gas': [0, 0]}, 'price': {'oil': [100, 100], 'gas': [0, 0]},
              'capex': [0, 0], 'opexFixed': [10, 10], 'opexVariable': [0, 0], 'abandonment': [0, 0],
              'royaltyRate': 0, 'taxRate': 0}),
        case('irr_known_21pct', 'Suite test: ncf [-100, +121] with mid-year discounting solves (1 + r) = 1.21, IRR 21 percent.',
             {'startYear': 2030, 'projectLife': 2, 'discountRate': 10, 'fiscalType': 'TaxRoyalty',
              'production': {'oil': [0, 1210000], 'gas': [0, 0]}, 'price': {'oil': [0, 100], 'gas': [0, 0]},
              'capex': [100, 0], 'opexFixed': [0, 0], 'opexVariable': [0, 0], 'abandonment': [0, 0],
              'royaltyRate': 0, 'taxRate': 0}),
        ncf_case('irr_two_roots', 'ncf [-100, 230, -132]: NPV(r) has TWO roots, 10 and 20 percent (mid-year discounting '
                 'scales every term by the same (1 + r)^-0.5 so the year-end roots survive). The engine\'s Newton from '
                 '10 percent lands on one of them; the gate accepts either root and pins which.',
                 [-100, 230, -132]),
        ncf_case('irr_all_negative', 'Every period negative: no IRR, reported 0; payback is the project life.',
                 [-10, -5, -1]),
        ncf_case('irr_tiny_cash_flows_derivative_guard',
                 'ncf of order 1e-7 $MM: the true mid-year IRR is the same 21 percent as irr_known_21pct scaled down, but '
                 'the engine\'s ABSOLUTE derivative guard (|dNPV/dr| < 1e-5) fires on the first iteration and it returns '
                 'its 10 percent starting guess. DISAGREEMENT, recorded in FINDINGS-fiscal.md.',
                 [-1e-7, 1.21e-7]),
        ncf_case('irr_beyond_clamp', 'ncf [-1, 100]: the mid-year IRR is 9900 percent. The engine clamps Newton at '
                 '1000 percent and reports the clamp. DISAGREEMENT (bound), recorded in FINDINGS-fiscal.md.',
                 [-1, 100]),
    ]

    # ---- payback ----
    G['payback'] = [
        ncf_case('payback_spend_then_earn', 'The E1 correction: -100 then +150 pays back two thirds through the SECOND period, 1.667 years.',
                 [-100, 150]),
        ncf_case('payback_exact_recovery', '-100 then +100: cumulative reaches exactly zero at index 1, payback 1 + 100/100 = 2.0 years.',
                 [-100, 100]),
        ncf_case('payback_first_period_positive', 'Positive from the first period: payback 0.',
                 [5, 10, 10]),
        ncf_case('payback_never', 'Never recovers: payback is the project life (5).',
                 [-100, 10, 10, 10, 10]),
        ncf_case('payback_multi_year', 'Recovers in the fourth period: 3 + 10/40 = 3.25 years; maxExposure -130.',
                 [-100, -30, 60, 40, 40]),
        ncf_case('payback_zero_period_after_negative', 'A zero cash flow period right after the cumulative crosses: crossing period is the one used.',
                 [-50, 60, 0, 10]),
    ]

    # ---- depreciation and horizon ----
    G['depreciation'] = []
    for n in range(1, 6):
        G['depreciation'].append(case(
            f'depr_{n}yr_on_2yr_hand', f'capexDepreciationYears {n} on the two year hand case: deductions past year 2 are lost.',
            two_year(capexDepreciationYears=n)))
    for n in range(1, 6):
        G['depreciation'].append(case(
            f'depr_{n}yr_on_base_10yr', f'capexDepreciationYears {n} on the 10 year base case with capex in years 1 and 2.',
            base_inputs(capexDepreciationYears=n)))
    G['depreciation'] += [
        case('depr_rounding_2_5_to_3', 'capexDepreciationYears 2.5 rounds to 3 (JavaScript Math.round rounds halves up).',
             two_year(projectLife=3, production={'oil': [1000000] * 3, 'gas': [0] * 3}, price={'oil': [100] * 3, 'gas': [0] * 3},
                      capex=[60, 0, 0], opexFixed=[10] * 3, opexVariable=[0] * 3, abandonment=[0] * 3, capexDepreciationYears=2.5)),
        case('depr_zero_means_one', 'capexDepreciationYears 0 is floored at 1 (immediate expensing).',
             two_year(capexDepreciationYears=0)),
        case('depr_capex_in_last_year', 'Capex spent in the final year with 5 year depreciation: only one fifth is ever deducted.',
             two_year(projectLife=3, production={'oil': [1000000] * 3, 'gas': [0] * 3}, price={'oil': [100] * 3, 'gas': [0] * 3},
                      capex=[0, 0, 50], opexFixed=[10] * 3, opexVariable=[0] * 3, abandonment=[0] * 3, capexDepreciationYears=5)),
        case('depr_psc_ignores_depreciation', 'On a PSC the depreciation column is still filled but the tax base ignores it.',
             psc_two_year(capexDepreciationYears=3)),
    ]

    # ---- horizon edge cases ----
    G['horizon'] = [
        case('horizon_single_year_capex_only', 'A one year project that only spends: npv negative, irr 0, payback = life = 1, exposure = the spend.',
             two_year(projectLife=1, production={'oil': [0], 'gas': [0]}, price={'oil': [100], 'gas': [0]},
                      capex=[50], opexFixed=[10], opexVariable=[0], abandonment=[0])),
        case('horizon_single_year_profitable', 'A one year project in the black: payback 0, irr 0 (no sign change).',
             two_year(projectLife=1, production={'oil': [1000000], 'gas': [0]}, price={'oil': [100], 'gas': [0]},
                      capex=[10], opexFixed=[10], opexVariable=[0], abandonment=[0])),
        case('horizon_life_shorter_than_profiles', 'projectLife 3 with 10 year profiles: only the first three years count.',
             base_inputs(projectLife=3)),
        case('horizon_life_longer_than_profiles', 'projectLife 12 with 10 year profiles: two trailing years of zeros.',
             base_inputs(projectLife=12)),
        case('horizon_zero_production_everywhere', 'No production at all: pure cost, every metric on the floor.',
             base_inputs(production={'oil': [0] * 10, 'gas': [0] * 10})),
    ]

    # ---- sweeps ----
    G['sweeps'] = []
    for p in range(40, 121, 10):
        G['sweeps'].append(case(f'sweep_oil_price_{p}', f'Base 10 year case at ${p} oil.', base_inputs(price={'oil': flat(float(p), 10), 'gas': [0.0] * 10})))
    for d in (0, 5, 10, 15, 20, 30):
        oil = base_oil(d)
        G['sweeps'].append(case(f'sweep_decline_{d}', f'Base case with a {d} percent decline.',
                                base_inputs(production={'oil': oil, 'gas': [0.0] * 10}, opexVariable=[v * 6.0 / 1e6 for v in oil])))
    for r in (0, 5, 8, 10, 12, 15, 20):
        G['sweeps'].append(case(f'sweep_discount_{r}', f'Base case discounted at {r} percent.', base_inputs(discountRate=r)))
    for t in (0, 30, 50, 85):
        G['sweeps'].append(case(f'sweep_tax_{t}', f'Base case at a {t} percent tax rate.', base_inputs(taxRate=t)))
    for cap in (20, 40, 60, 80, 100):
        G['sweeps'].append(case(f'sweep_psc_cap_{cap}', f'PSC base case with a {cap} percent cost recovery cap and a 60 percent contractor share.',
                                base_inputs(fiscalType='PSC', costRecoveryCap=cap, profitSplitContractor=60)))

    # ---- sensitivity, scenarios ----
    G['sensitivity'] = [
        {'id': 'sens_base_10yr', 'note': 'runSensitivityAnalysis on the base 10 year case: NPV at -30 and +30 percent of oil price, capex, fixed opex and oil production.',
         'inputs': base_inputs(), 'expected': sensitivity(base_inputs())},
        {'id': 'sens_psc', 'note': 'The same sweep on the PSC variant.',
         'inputs': base_inputs(fiscalType='PSC', costRecoveryCap=60, profitSplitContractor=60),
         'expected': sensitivity(base_inputs(fiscalType='PSC', costRecoveryCap=60, profitSplitContractor=60))},
    ]
    G['scenarios'] = [
        {'id': 'scen_base_10yr', 'note': 'generateScenarios on the base case: Base, Low (-20 price and production, +20 capex and fixed opex), High (mirror).',
         'inputs': base_inputs(), 'expected': scenarios(base_inputs())},
    ]

    # ---- quick inputs ----
    quicks = [
        {'id': 'quick_default_like', 'note': 'expandQuickInputs: 5000 bopd declining 10 percent, $70 oil, capex 200 split over two years, fixed opex 8, 4 $/bbl, royalty 10, tax 30.',
         'quick': {'initialRate': 5000, 'declineRate': 10, 'oilPrice': 70, 'capex': 200, 'fixedOpex': 8, 'opexPerBbl': 4,
                   'startYear': 2028, 'discountRate': 10, 'royaltyRate': 10, 'taxRate': 30}},
        {'id': 'quick_no_decline', 'note': 'expandQuickInputs with a zero decline and zero variable opex.',
         'quick': {'initialRate': 1000, 'declineRate': 0, 'oilPrice': 50, 'capex': 30, 'fixedOpex': 2, 'opexPerBbl': 0,
                   'startYear': 2030, 'discountRate': 8, 'royaltyRate': 12.5, 'taxRate': 50}},
    ]
    G['quickInputs'] = []
    for q in quicks:
        exp = expand_quick(q['quick'])
        G['quickInputs'].append({'id': q['id'], 'note': q['note'], 'quick': q['quick'], 'expandedInputs': exp, 'expected': run(exp)})

    # ---- portfolio ----
    G['portfolio'] = [
        {'id': 'portfolio_three', 'note': 'Three projects with chances of success.',
         'projects': [{'npv': 120, 'capex': 300, 'irr': 18, 'chanceOfSuccess': 0.5}, {'npv': -20, 'capex': 100, 'irr': 4, 'chanceOfSuccess': 0.9},
                      {'npv': 400, 'capex': 900, 'irr': 25}]},
        {'id': 'portfolio_empty', 'note': 'No projects: everything 0, avgIRR divides by 1 not 0.', 'projects': []},
        {'id': 'portfolio_zero_capex', 'note': 'Zero total capex: capital efficiency 0 rather than a division by zero.',
         'projects': [{'npv': 10, 'irr': 12}, {'npv': 5, 'irr': 9}]},
        {'id': 'portfolio_zero_chance', 'note': 'A project with chanceOfSuccess 0: risked NPV must be 0. The engine\'s `|| 1.0` fallback reads a '
         'zero chance as certain and counts the full NPV. DISAGREEMENT, recorded in FINDINGS-fiscal.md.',
         'projects': [{'npv': 100, 'capex': 50, 'irr': 15, 'chanceOfSuccess': 0}, {'npv': 40, 'capex': 50, 'irr': 10, 'chanceOfSuccess': 0.5}]},
    ]
    for c in G['portfolio']:
        c['expected'] = portfolio(c['projects'])
    G['portfolio'][3]['engine'] = {'totalRiskedNPV': 120.0, 'disagreement': 'chanceOfSuccess 0 is read as 1.0 by `|| 1.0`'}

    # ---- Monte Carlo, seeded stand-in for Math.random ----
    mc_base = base_inputs(projectLife=5, production={'oil': base_oil(12, 5), 'gas': [0.0] + decline_profile(10000, 5, 4)},
                          price={'oil': flat(75.0, 5), 'gas': flat(3.0, 5)}, capex=[400.0, 200.0, 0, 0, 0],
                          opexFixed=[0.0] + flat(40.0, 4), opexVariable=[v * 6.0 / 1e6 for v in base_oil(12, 5)],
                          abandonment=[0, 0, 0, 0, 50.0])
    G['monteCarloSeeded'] = []
    for cid, seed, settings, note in (
        ('mc_seed42_100', 42, {'iterations': 100, 'uncertainties': {'reserves': 0.2, 'price': 0.15, 'capex': 0.1}},
         'runMonteCarlo with Math.random replaced by mulberry32(42), 100 iterations, all three uncertainties on.'),
        ('mc_seed7_500', 7, {'iterations': 500, 'uncertainties': {'reserves': 0.1, 'price': 0.25, 'capex': 0.3}},
         'mulberry32(7), 500 iterations (the engine default), P10/P50/P90 hit the even-length averaging branch of the quantile rule.'),
        ('mc_seed3_price_only', 3, {'iterations': 200, 'uncertainties': {'reserves': 0, 'price': 0.2, 'capex': 0}},
         'Only price uncertain: reserves and capex ranges are falsy and consume NO draws.'),
        ('mc_seed11_40_iters_cdf_empty', 11, {'iterations': 40, 'uncertainties': {'reserves': 0.2, 'price': 0.2, 'capex': 0.2}},
         'Fewer than 50 iterations: floor(iterations/50) is 0, i % 0 is NaN, and the engine returns an EMPTY cdf. The oracle records that as the engine behaviour (FINDINGS-fiscal.md).'),
    ):
        exp = monte_carlo(mc_base, settings, seed)
        G['monteCarloSeeded'].append({'id': cid, 'note': note, 'seed': seed, 'inputs': mc_base, 'settings': settings, 'expected': exp})
    degen = monte_carlo(mc_base, {'iterations': 30, 'uncertainties': {'reserves': 0, 'price': 0, 'capex': 0}}, 1)
    G['monteCarloSeeded'].append({
        'id': 'mc_zero_uncertainty_throws', 'seed': 1, 'inputs': mc_base,
        'settings': {'iterations': 30, 'uncertainties': {'reserves': 0, 'price': 0, 'capex': 0}},
        'note': 'Every range 0: every iteration is the base NPV, so P10 = P50 = P90 = EMV = base NPV and a histogram of zero width. '
                'The engine divides by a zero bin size, indexes the histogram with NaN and THROWS. DISAGREEMENT, recorded in FINDINGS-fiscal.md.',
        'expected': {'p10': degen['p10'], 'p50': degen['p50'], 'p90': degen['p90'], 'emv': degen['emv'], 'baseNPV': run(mc_base)['metrics']['npv']},
        'engine': {'throws': True, 'disagreement': 'zero bin width makes the histogram index NaN'},
    })
    return G


# Engine IRR numbers read from the engine where they disagree with the
# oracle. Every one is the clamped Newton-Raphson: either the true root
# lies past the 1000 percent clamp, or NPV(10 percent) is negative with a
# positive slope so the first Newton step lands on the clamp and stays
# there for 100 iterations, and the clamp is reported as the IRR. Both
# are recorded in FINDINGS-fiscal.md.
BEYOND_CLAMP = 'the true root lies beyond the 1000 percent Newton clamp and the clamp is reported'
WANDERS = ('NPV(10 percent) is negative with a positive slope, so Newton steps past the clamp and the '
           'clamp is reported; the only root is negative')
ENGINE_IRR_PINS = {
    'tr_hand_2yr_depr2': (1000.0, BEYOND_CLAMP + ' (the root is 1800 percent)'),
    'depr_2yr_on_2yr_hand': (1000.0, BEYOND_CLAMP + ' (the root is 1800 percent)'),
    'irr_beyond_clamp': (1000.0, BEYOND_CLAMP + ' (the root is 9900 percent)'),
    'irr_tiny_cash_flows_derivative_guard': (10.0, 'absolute derivative guard returns the Newton starting guess'),
    'fdp_never_pays_back': (1000.0, WANDERS),
    'depr_capex_in_last_year': (1000.0, WANDERS),
}


def apply_pins(G):
    for group, cases in G.items():
        if not isinstance(cases, list):
            continue
        for c in cases:
            if c.get('id') in ENGINE_IRR_PINS:
                irr_pin, why = ENGINE_IRR_PINS[c['id']]
                c['engine'] = {'irr': irr_pin, 'disagreement': why}


def main():
    G = build()
    apply_pins(G)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(G, f, indent=1, sort_keys=True)
        f.write('\n')
    n = sum(len(v) for k, v in G.items() if isinstance(v, list))
    print(f'wrote {OUT}: {n} cases')


if __name__ == '__main__':
    main()
