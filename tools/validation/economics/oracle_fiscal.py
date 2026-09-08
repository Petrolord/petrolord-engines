#!/usr/bin/env python3
"""Independent oracle for the fiscal regime sandbox
(engines/economics/fiscalRegime.js, the Suite's
fiscalDesignerCalculations.js) and its templates
(engines/economics/fiscalTemplates.js). Emits committed goldens to
test-data/economics/goldens/fiscal_cases.json.

INDEPENDENCE DISCIPLINE. Written from the METHOD STATEMENT in the engine's
header and comments and from the published shape of the regimes it
models (concession royalty and tax, PSC cost recovery with a cap and
carryforward, sliding-scale royalty, R-factor tranches, resource rent tax
with an uplift), not by transcribing the JavaScript:

  profiles       25 year exponential declines, closed form q0 * 365 *
                 (1 - d/100)^(year - 1), for oil, gas and NGL.
  price deck     the latest deck point at or before the year, falling
                 back to the first point; the price multiplier scales
                 OIL only.
  boe            oil + ngl + gas * 1000 / 6000, for the variable opex.
  capex          the sum of drilling, facilities and subsea, times the
                 multiplier, all in year 1.
  royalty        flat, or the rate of the highest sliding-scale tier
                 whose threshold the oil price reaches (the first tier
                 below every threshold).
  cost recovery  cost oil is the lesser of the pool (carried plus this
                 year's capex and opex) and costRecoveryLimit percent of
                 revenue after royalty; the rest carries forward.
  R-factor       cumulative gross revenue over cumulative capex plus
                 opex, both through the current year, before the split.
  profit split   flat, or the split of the highest R-factor tier reached.
  tax            CIT on the contractor profit share; RRT on that share
                 less an annual uplift of rrtUpliftPct percent of total
                 capex (default 20, zero respected); the larger of CIT
                 plus RRT and minTax percent of gross revenue.
  ledger         contractor NCF = cost oil + profit share - tax - opex -
                 capex; government take = royalty + government profit
                 share + tax; the two sum to revenue less costs.
  NPV            YEAR-END discounting, sum of NCF_y / (1 + r)^y.
  IRR            0 when the cash flow never changes sign or NPV(0) <= 0;
                 otherwise the rate where the year-end NPV is zero. The
                 engine brackets by doubling from 100 percent and bisects
                 80 times; the oracle brackets by TRIPLING from 50 percent
                 and solves with the Illinois (modified regula falsi)
                 method. Past the engine's 102400 percent bracket the
                 engine reports the bracket; the oracle records that.
  summary        payback is the first year the cumulative NCF exceeds
                 zero, R-factor payout the first year R exceeds 1, and
                 the effective tax rate is government take over
                 government take plus contractor take with capex added
                 back (the summary) or NOT added back (the price sweep;
                 two definitions, recorded in FINDINGS-fiscal.md).
  sweeps         effective tax rate at $40 to $120 in $10 steps, and NPV
                 at capex multipliers 0.8 to 1.5 in 0.1 steps. The engine
                 accumulates 0.1 in floating point and STOPS AT 1.4; the
                 oracle evaluates the documented grid and the golden
                 records both.
  insights       the five verdict sentences, rebuilt from the numbers
                 with JavaScript toFixed semantics (round half up on the
                 exact binary value).

Units: initial rates bbl/d, mscf/d and bbl/d; prices $/bbl, $/mscf,
$/bbl; capex and fixed opex $MM; variable opex $/boe; every money output
$MM; rates percent 0 to 100; years 1 based.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_fiscal.py
"""
import json
import math
import os
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'fiscal_cases.json')

LIFE = 25


def js_to_fixed(x, d=1):
    """JavaScript Number.prototype.toFixed: halves on the exact binary
    value round away from zero; non-finite prints n/a as deriveInsights does."""
    if x is None or not math.isfinite(x):
        return 'n/a'
    q = Decimal(1).scaleb(-d)
    s = str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))
    if s.startswith('-') and Decimal(s) == 0:
        s = s[1:]
    return s


# ---------------------------------------------------------------------
# Regime pieces
# ---------------------------------------------------------------------

def profile(initial, decline):
    return [initial * 365.0 * (1.0 - decline / 100.0) ** (y - 1) for y in range(1, LIFE + 1)]


def deck_price(year, deck):
    applicable = deck[0]
    for p in sorted(deck, key=lambda d: d['year']):
        if p['year'] <= year:
            applicable = p
    return applicable


def tier_rate(x, tiers, field):
    """Highest-threshold tier reached, else the first tier."""
    chosen = tiers[0]
    best = None
    for t in tiers:
        if x >= t['threshold'] and (best is None or t['threshold'] >= best):
            best = t['threshold']
            chosen = t
    return chosen[field]


def royalty_rate(oil_price, roy):
    if roy['type'] == 'flat':
        return roy['rate'] / 100.0
    return tier_rate(oil_price, roy['tiers'], 'rate') / 100.0


def split_rate(r_factor, split):
    if split['type'] == 'flat':
        return split['split'] / 100.0
    return tier_rate(r_factor, split['tiers'], 'split') / 100.0


def cash_flow(regime, project, capex_mult=1.0, price_mult=1.0):
    oil = profile(project['production']['oil']['initial'], project['production']['oil']['decline'])
    gas = profile(project['production']['gas']['initial'], project['production']['gas']['decline'])
    ngl = profile(project['production']['ngl']['initial'], project['production']['ngl']['decline'])
    cx = project['costs']['capex']
    total_capex = (cx['drilling'] + cx['facilities'] + cx['subsea']) * capex_mult
    uplift = regime['tax'].get('rrtUpliftPct')
    if uplift is None:
        uplift = 20
    pool = 0.0
    cum_rev = cum_cost = cum_ncf = 0.0
    rows = []
    for y in range(1, LIFE + 1):
        deck = deck_price(y, project['prices'])
        p_oil = deck['oil'] * price_mult
        gross = (oil[y - 1] * p_oil + gas[y - 1] * deck['gas'] + ngl[y - 1] * deck['ngl']) / 1e6
        cum_rev += gross
        boe = oil[y - 1] + ngl[y - 1] + gas[y - 1] * 1000.0 / 6000.0
        opex = project['costs']['opex']['fixed'] + boe * project['costs']['opex']['variable'] / 1e6
        capex = total_capex if y == 1 else 0.0
        cum_cost += capex + opex
        royalty = gross * royalty_rate(p_oil, regime['royalty'])
        after_roy = gross - royalty
        avail = pool + capex + opex
        allowed = after_roy * regime['costRecoveryLimit'] / 100.0
        recovered = min(avail, allowed)
        pool = avail - recovered
        profit_oil = max(0.0, after_roy - recovered)
        r_factor = cum_rev / cum_cost if cum_cost > 0 else 0.0
        split = split_rate(r_factor, regime['profitSplit'])
        c_share = profit_oil * split
        g_share = profit_oil * (1.0 - split)
        cit = c_share * regime['tax']['cit'] / 100.0 if c_share > 0 else 0.0
        rrt_base = c_share - total_capex * uplift / 100.0
        rrt = rrt_base * regime['tax']['rrt'] / 100.0 if rrt_base > 0 else 0.0
        tax = max(cit + rrt, gross * regime['tax']['minTax'] / 100.0)
        ncf = recovered + c_share - tax - opex - capex
        gov = royalty + g_share + tax
        cum_ncf += ncf
        rows.append({
            'year': y, 'grossRevenue': gross, 'royalty': royalty, 'costRecovered': recovered,
            'unrecoveredCostPool': pool, 'profitOil': profit_oil, 'tax': tax, 'opex': opex, 'capex': capex,
            'contractorNCF': ncf, 'governmentTake': gov, 'cumulativeNCF': cum_ncf, 'rFactor': r_factor,
            'contractorSplit': split, 'royaltyRate': royalty_rate(p_oil, regime['royalty']),
        })
    return rows


def npv(rows, rate_pct):
    r = rate_pct / 100.0
    return sum(cf['contractorNCF'] / (1.0 + r) ** cf['year'] for cf in rows)


ENGINE_IRR_BRACKET = 100.0 * 2 ** 10  # the engine's last doubled bracket, percent


def irr(rows):
    ncf = [cf['contractorNCF'] for cf in rows]
    if not (any(c < 0 for c in ncf) and any(c > 0 for c in ncf)):
        return 0.0
    f = lambda pct: npv(rows, pct)
    if f(0.0) <= 0:
        return 0.0
    hi = 50.0
    while f(hi) > 0 and hi < 1e7:
        hi *= 3
    if f(hi) > 0:
        return ENGINE_IRR_BRACKET
    if hi > ENGINE_IRR_BRACKET and f(ENGINE_IRR_BRACKET) > 0:
        return ENGINE_IRR_BRACKET  # the engine reports its bracket here
    lo, flo, fhi = 0.0, f(0.0), f(hi)
    side = 0
    for _ in range(500):
        mid = (lo * fhi - hi * flo) / (fhi - flo)
        fm = f(mid)
        if abs(fm) < 1e-13 or abs(hi - lo) < 1e-13:
            return mid
        if (fm < 0) == (fhi < 0):
            hi, fhi = mid, fm
            if side == -1:
                flo *= 0.5
            side = -1
        else:
            lo, flo = mid, fm
            if side == 1:
                fhi *= 0.5
            side = 1
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------------
# Comparison, sweeps, insights
# ---------------------------------------------------------------------

PRICE_GRID = list(range(40, 121, 10))
CAPEX_GRID = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5]
ENGINE_CAPEX_POINTS = 7  # the engine's accumulated loop stops at 1.4


def sweeps(regimes, project):
    price = {'labels': PRICE_GRID, 'data': []}
    for reg in regimes:
        vals = []
        for p in PRICE_GRID:
            rows = cash_flow(reg, project, 1.0, p / project['prices'][0]['oil'])
            gov = sum(cf['governmentTake'] for cf in rows)
            con = sum(cf['contractorNCF'] for cf in rows)
            tot = gov + con
            vals.append(gov / tot * 100.0 if tot > 0 else 0.0)
        price['data'].append({'regimeId': reg['id'], 'values': vals})
    capex = {'labels': [js_to_fixed(m, 1) for m in CAPEX_GRID], 'data': []}
    for reg in regimes:
        capex['data'].append({'regimeId': reg['id'],
                              'values': [npv(cash_flow(reg, project, m, 1.0), project['discountRate']) for m in CAPEX_GRID]})
    return {'price': price, 'capex': capex}


def summary_row(reg, project):
    rows = cash_flow(reg, project)
    cx = project['costs']['capex']
    total_capex = cx['drilling'] + cx['facilities'] + cx['subsea']
    gov = sum(cf['governmentTake'] for cf in rows)
    con = sum(cf['contractorNCF'] for cf in rows) + total_capex
    tot = gov + con
    pay = next((cf['year'] for cf in rows if cf['cumulativeNCF'] > 0), None)
    rpay = next((cf['year'] for cf in rows if cf['rFactor'] > 1.0), None)
    return rows, {
        'id': reg['id'], 'name': reg['name'], 'npv': npv(rows, project['discountRate']), 'irr': irr(rows),
        'paybackPeriod': pay, 'rFactorPayoutYear': rpay, 'govTake': gov,
        'effectiveTaxRate': gov / tot * 100.0 if tot > 0 else 0.0,
    }


def insights(summary, sens, capex_points=None):
    """The verdict sentences. capex_points limits the capex sweep to the
    first n points (the engine's truncated loop) when given."""
    out = []
    if not summary:
        return out
    f = js_to_fixed
    best = summary[0]
    out.append({'key': 'npv', 'label': 'Best for the contractor',
                'text': f'"{best["name"]}" delivers the highest contractor NPV at ${f(best["npv"])}MM, with an IRR of {f(best["irr"])}%.'})
    paying = [r for r in summary if r['paybackPeriod'] is not None and math.isfinite(r['paybackPeriod'])]
    if paying:
        fastest = paying[0]
        for r in paying[1:]:
            if r['paybackPeriod'] < fastest['paybackPeriod']:
                fastest = r
        rest = [r for r in paying if r['id'] != fastest['id']]
        slowest = None
        if rest:
            slowest = rest[0]
            for r in rest[1:]:
                if r['paybackPeriod'] > slowest['paybackPeriod']:
                    slowest = r
        text = (f'"{fastest["name"]}" pays back in year {fastest["paybackPeriod"]}, against year {slowest["paybackPeriod"]} for "{slowest["name"]}".'
                if slowest else f'"{fastest["name"]}" pays back in year {fastest["paybackPeriod"]}. No other regime pays back within the project life.')
        out.append({'key': 'payback', 'label': 'Fastest capital recovery', 'text': text})
    else:
        out.append({'key': 'payback', 'label': 'Capital recovery', 'text': 'No regime pays back within the project life on these inputs.'})
    top = summary[0]
    for r in summary[1:]:
        if r['govTake'] > top['govTake']:
            top = r
    others = [r for r in summary if r['id'] != top['id']]
    nxt = None
    if others:
        nxt = others[0]
        for r in others[1:]:
            if r['govTake'] > nxt['govTake']:
                nxt = r
    out.append({'key': 'government', 'label': 'Best for the government',
                'text': (f'"{top["name"]}" collects the most, ${f(top["govTake"])}MM against ${f(nxt["govTake"])}MM for the next highest, "{nxt["name"]}".'
                         if nxt else f'"{top["name"]}" collects ${f(top["govTake"])}MM in total government take.')})
    by_id = {r['id']: r for r in summary}
    losses = []
    for d in (sens or {}).get('capex', {}).get('data', []):
        v = d.get('values') or []
        if capex_points:
            v = v[:capex_points]
        if len(v) < 2 or d['regimeId'] not in by_id:
            continue
        losses.append({'name': by_id[d['regimeId']]['name'], 'loss': v[0] - v[-1]})
    if len(losses) >= 2:
        toughest = losses[0]
        weakest = losses[0]
        for l in losses[1:]:
            if l['loss'] < toughest['loss']:
                toughest = l
            if l['loss'] > weakest['loss']:
                weakest = l
        out.append({'key': 'capex', 'label': 'Resilience to cost overrun',
                    'text': f'Over the swept capex range, "{toughest["name"]}" gives up the least contractor NPV (${f(toughest["loss"])}MM) and "{weakest["name"]}" the most (${f(weakest["loss"])}MM).'})
    climbs = []
    for d in (sens or {}).get('price', {}).get('data', []):
        v = d.get('values') or []
        if len(v) < 2 or d['regimeId'] not in by_id:
            continue
        climbs.append({'name': by_id[d['regimeId']]['name'], 'climb': v[-1] - v[0]})
    if len(climbs) >= 2:
        steepest = climbs[0]
        for c in climbs[1:]:
            if c['climb'] > steepest['climb']:
                steepest = c
        out.append({'key': 'price', 'label': 'Response to higher prices',
                    'text': f'"{steepest["name"]}" is the most progressive: its government share rises {f(steepest["climb"])} percentage points across the swept price range, so it captures upside fastest.'})
    return out


def comparison(regimes, project):
    summary = []
    annual = []
    for reg in regimes:
        rows, s = summary_row(reg, project)
        annual.append({'regimeId': reg['id'], 'data': rows})
        summary.append(s)
    sens = sweeps(regimes, project)
    summary = sorted(summary, key=lambda s: -s['npv'])  # stable, as Array.prototype.sort
    names = {r['id']: r['name'] for r in regimes}
    return {
        'summary': summary, 'annualCashFlows': annual, 'sensitivityData': sens,
        'insights': insights(summary, sens),
        'insightsAsEngine': insights(summary, sens, ENGINE_CAPEX_POINTS),
        'engineCapexPoints': ENGINE_CAPEX_POINTS,
        # The quantities the capex and price verdicts rank, so a gate can
        # recognise a TIE (equal losses decided by rounding noise) instead
        # of pretending the winner of a tie is a result.
        'capexLossesAsEngine': [{'name': names[d['regimeId']], 'loss': d['values'][0] - d['values'][ENGINE_CAPEX_POINTS - 1]}
                                for d in sens['capex']['data']],
        'priceClimbs': [{'name': names[d['regimeId']], 'climb': d['values'][-1] - d['values'][0]} for d in sens['price']['data']],
    }


# ---------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------

TEMPLATES = [
    {'name': 'Nigeria - PIA (2021)', 'regime': {
        'royalty': {'type': 'sliding_price', 'tiers': [{'threshold': 0, 'rate': 7.5}, {'threshold': 50, 'rate': 10}]},
        'tax': {'cit': 30, 'rrt': 0, 'minTax': 0}, 'costRecoveryLimit': 80,
        'profitSplit': {'type': 'tiered_r_factor', 'tiers': [{'threshold': 1.0, 'split': 60}, {'threshold': 1.6, 'split': 40}, {'threshold': 2.5, 'split': 30}]}}},
    {'name': 'Ghana - Deepwater', 'regime': {
        'royalty': {'type': 'flat', 'rate': 5}, 'tax': {'cit': 35, 'rrt': 0, 'minTax': 0}, 'costRecoveryLimit': 90,
        'profitSplit': {'type': 'tiered_r_factor', 'tiers': [{'threshold': 1.0, 'split': 70}, {'threshold': 1.25, 'split': 50}, {'threshold': 2.0, 'split': 35}]}}},
    {'name': 'Brazil - Concession', 'regime': {
        'royalty': {'type': 'flat', 'rate': 10}, 'tax': {'cit': 34, 'rrt': 40, 'minTax': 0}, 'costRecoveryLimit': 100,
        'profitSplit': {'type': 'flat', 'split': 100}}},
    {'name': 'USA - Gulf of Mexico', 'regime': {
        'royalty': {'type': 'flat', 'rate': 18.75}, 'tax': {'cit': 21, 'rrt': 0, 'minTax': 0}, 'costRecoveryLimit': 100,
        'profitSplit': {'type': 'flat', 'split': 100}}},
    {'name': 'Angola - Deepwater PSC', 'regime': {
        'royalty': {'type': 'flat', 'rate': 0}, 'tax': {'cit': 25, 'rrt': 50, 'minTax': 0}, 'costRecoveryLimit': 50,
        'profitSplit': {'type': 'tiered_r_factor', 'tiers': [{'threshold': 1.0, 'split': 70}, {'threshold': 1.5, 'split': 50}, {'threshold': 2.0, 'split': 30}]}}},
    {'name': 'Generic Royalty/Tax', 'regime': {
        'royalty': {'type': 'flat', 'rate': 12.5}, 'tax': {'cit': 30, 'rrt': 0, 'minTax': 0}, 'costRecoveryLimit': 100,
        'profitSplit': {'type': 'flat', 'split': 100}}},
]


def slug(name):
    return ''.join(ch if ch.isalnum() else '_' for ch in name.lower()).strip('_')


def template_regimes():
    return [dict(t['regime'], id=slug(t['name']), name=t['name']) for t in TEMPLATES]


# The Fiscal Regime Designer's default project (src/pages/apps/FiscalRegimeDesigner.jsx).
DEFAULT_PROJECT = {
    'production': {'oil': {'initial': 10000, 'decline': 10}, 'gas': {'initial': 50, 'decline': 8}, 'ngl': {'initial': 1500, 'decline': 12}},
    'costs': {'capex': {'drilling': 300, 'facilities': 150, 'subsea': 50}, 'opex': {'fixed': 10, 'variable': 5}},
    'prices': [{'year': 1, 'oil': 70, 'gas': 3.5, 'ngl': 30}, {'year': 5, 'oil': 75, 'gas': 4.0, 'ngl': 35}, {'year': 10, 'oil': 80, 'gas': 4.5, 'ngl': 40}],
    'discountRate': 10,
}
DEFAULT_REGIMES = [
    {'id': 1, 'name': 'Nigerian PIA (PSC)',
     'royalty': {'type': 'sliding_price', 'tiers': [{'threshold': 60, 'rate': 12.5}, {'threshold': 80, 'rate': 15}]},
     'tax': {'cit': 30, 'rrt': 20, 'minTax': 2}, 'costRecoveryLimit': 70,
     'profitSplit': {'type': 'tiered_r_factor', 'tiers': [{'threshold': 1.0, 'split': 60}, {'threshold': 1.5, 'split': 50}]}},
    {'id': 2, 'name': 'Concessionary (Royalty/Tax)', 'royalty': {'type': 'flat', 'rate': 12.5},
     'tax': {'cit': 50, 'rrt': 0, 'minTax': 0}, 'costRecoveryLimit': 100, 'profitSplit': {'type': 'flat', 'split': 100}},
]
# The Suite test project (src/utils/__tests__/fiscalDesignerCalculations.test.js).
TEST_PROJECT = {
    'production': {'oil': {'initial': 30000, 'decline': 12}, 'gas': {'initial': 0, 'decline': 0}, 'ngl': {'initial': 0, 'decline': 0}},
    'prices': [{'year': 1, 'oil': 80, 'gas': 3, 'ngl': 45}],
    'costs': {'capex': {'drilling': 400, 'facilities': 500, 'subsea': 100}, 'opex': {'fixed': 60, 'variable': 4}},
    'discountRate': 10,
}


def flat_regime(**over):
    r = {'id': 'flat', 'name': 'Flat', 'royalty': {'type': 'flat', 'rate': 12.5}, 'costRecoveryLimit': 100,
         'profitSplit': {'type': 'flat', 'split': 100}, 'tax': {'cit': 30, 'rrt': 0, 'minTax': 0, 'rrtUpliftPct': 0}}
    r.update(over)
    return r


COMPLEX_REGIME = flat_regime(
    id='complex', name='Complex',
    royalty={'type': 'sliding', 'tiers': [{'threshold': 0, 'rate': 5}, {'threshold': 60, 'rate': 12.5}, {'threshold': 100, 'rate': 20}]},
    costRecoveryLimit=70,
    profitSplit={'type': 'tiered', 'tiers': [{'threshold': 0, 'split': 80}, {'threshold': 1.5, 'split': 55}, {'threshold': 3, 'split': 35}]},
    tax={'cit': 30, 'rrt': 20, 'minTax': 2, 'rrtUpliftPct': 20})


def cf_case(cid, note, regime, project, capex_mult=1.0, price_mult=1.0):
    rows = cash_flow(regime, project, capex_mult, price_mult)
    return {'id': cid, 'note': note, 'regime': regime, 'project': project, 'capexMultiplier': capex_mult,
            'priceMultiplier': price_mult,
            'expected': {'cashflow': rows, 'npv': npv(rows, project['discountRate']), 'irr': irr(rows),
                         'totalGovTake': sum(cf['governmentTake'] for cf in rows),
                         'totalContractorNCF': sum(cf['contractorNCF'] for cf in rows),
                         'finalUnrecoveredPool': rows[-1]['unrecoveredCostPool'],
                         'paybackYear': next((cf['year'] for cf in rows if cf['cumulativeNCF'] > 0), None),
                         'rFactorPayoutYear': next((cf['year'] for cf in rows if cf['rFactor'] > 1.0), None)}}


def build():
    G = {'description': (
        'Fiscal regime sandbox goldens for engines/economics/fiscalRegime.js and fiscalTemplates.js. '
        'Independent stdlib oracle tools/validation/economics/oracle_fiscal.py written from the method '
        'statement: 25 year closed-form declines, the price deck lookup, sliding-scale royalty by tier '
        'threshold, PSC cost recovery with a cap and carryforward, R-factor tranche splits, CIT and RRT '
        'with an annual capital uplift against a minimum tax, YEAR-END discounting NCF/(1+r)^year, IRR by '
        'tripling bracket and the Illinois method (engine: doubling bracket and 80 bisections), the price '
        'and capex sweeps, the per-regime summary and the five insight sentences rebuilt with JavaScript '
        'toFixed rounding. `cashflow` rows carry every engine column plus the oracle\'s `contractorSplit` '
        'and `royaltyRate` chosen that year. The capex sweep is evaluated on the DOCUMENTED grid 0.8 to '
        '1.5 (8 points); the engine\'s accumulated loop stops at 1.4 (7 points, `engineCapexPoints`), so '
        '`insightsAsEngine` rebuilds the capex verdict over the 7 points the engine actually sees; both are '
        'pinned. Units: rates bbl/d and mscf/d, prices $/bbl and $/mscf, every money output $MM, percents '
        '0 to 100, years 1 based.'
    )}

    G['cashflow'] = [
        cf_case('flat_test_project', 'Suite test: the flat regime (royalty 12.5, full recovery, 100 split, CIT 30, no uplift) on the 30000 bopd test project. '
                'Its contractorNCF equals the screening engine\'s PSC ncf (psc_fiscal_parity_25yr) and its NPV times sqrt(1.1) equals that mid-year NPV.',
                flat_regime(), TEST_PROJECT),
        cf_case('complex_test_project', 'Suite test: sliding royalty, 70 percent recovery, tiered split, RRT 20 with 20 percent uplift, minimum tax 2.',
                COMPLEX_REGIME, TEST_PROJECT),
        cf_case('capped_5pct_never_recovers', 'Suite test: recovery capped at 5 percent, the pool grows past the 1000 capex and never clears; no payback, IRR 0.',
                flat_regime(id='capped5', name='Capped 5', costRecoveryLimit=5), TEST_PROJECT),
        cf_case('capped_40pct', 'Suite test: recovery capped at 40 percent of revenue after royalty.',
                flat_regime(id='capped40', name='Capped 40', costRecoveryLimit=40), TEST_PROJECT),
        cf_case('harsh_split_40_royalty_20', 'Suite test: a 40 percent split and 20 percent royalty leave the contractor less and the government more than the flat regime.',
                flat_regime(id='harsh', name='Harsh', profitSplit={'type': 'flat', 'split': 40}, royalty={'type': 'flat', 'rate': 20}), TEST_PROJECT),
        cf_case('rfactor_tranche_crossing', 'The Nigeria PIA tranches on a 10000 bopd project (capex 350, opex 20 + 1 $/boe) at $80: the R-factor walks '
                'through 1.0 in year 3 and 2.5 in year 6, so `contractorSplit` steps 60 -> 40 -> 30 at exactly those years.',
                dict(template_regimes()[0], id='pia_walk', name='PIA tranche walk'),
                dict(TEST_PROJECT, production={'oil': {'initial': 10000, 'decline': 12}, 'gas': {'initial': 0, 'decline': 0}, 'ngl': {'initial': 0, 'decline': 0}},
                     costs={'capex': {'drilling': 350, 'facilities': 0, 'subsea': 0}, 'opex': {'fixed': 20, 'variable': 1}})),
        cf_case('rfactor_falls_back', 'The same regime with capex 320 and opex 25: the R-factor peaks just above 2.5 and then FALLS as revenue declines '
                'while opex keeps accruing, so the split steps back up from 30 to 40 in year 23. The R-factor is a ratio of cumulatives and is not monotone.',
                dict(template_regimes()[0], id='pia_fallback', name='PIA fall back'),
                dict(TEST_PROJECT, production={'oil': {'initial': 10000, 'decline': 12}, 'gas': {'initial': 0, 'decline': 0}, 'ngl': {'initial': 0, 'decline': 0}},
                     costs={'capex': {'drilling': 320, 'facilities': 0, 'subsea': 0}, 'opex': {'fixed': 25, 'variable': 1}})),
        cf_case('sliding_royalty_price_deck_crossing', 'The default project\'s three-point deck ($70, $75 from year 5, $80 from year 10) walks the Designer\'s default '
                'PIA sliding royalty through its $60 and $80 thresholds: 12.5 percent until year 9, 15 percent from year 10.',
                DEFAULT_REGIMES[0], DEFAULT_PROJECT),
        cf_case('price_below_every_threshold', 'Price multiplier 0.5 puts $35 oil below every sliding tier: the FIRST tier applies.',
                DEFAULT_REGIMES[0], DEFAULT_PROJECT, 1.0, 0.5),
        cf_case('rrt_uplift_default_20', 'rrtUpliftPct omitted: the default 20 percent uplift applies to the Brazil RRT.',
                dict(template_regimes()[2], id='brazil', name='Brazil'), TEST_PROJECT),
        cf_case('rrt_uplift_zero_respected', 'rrtUpliptPct 0 is respected (not replaced by the default).',
                dict(template_regimes()[2], id='brazil0', name='Brazil no uplift', tax={'cit': 34, 'rrt': 40, 'minTax': 0, 'rrtUpliftPct': 0}), TEST_PROJECT),
        cf_case('minimum_tax_binds', 'A 10 percent minimum tax on gross revenue with a 0 CIT: the minimum binds every year.',
                flat_regime(id='mintax', name='Min tax', tax={'cit': 0, 'rrt': 0, 'minTax': 10, 'rrtUpliftPct': 0}), TEST_PROJECT),
        cf_case('capex_multiplier_1_3', 'Capex multiplier 1.3 on the flat regime.', flat_regime(), TEST_PROJECT, 1.3, 1.0),
        cf_case('capex_multiplier_0_7', 'Capex multiplier 0.7 on the flat regime.', flat_regime(), TEST_PROJECT, 0.7, 1.0),
        cf_case('never_recovers_huge_capex', 'Capex 20000 on the test project: NPV(0) is negative so the engine reports IRR 0, the pool never clears, no payback.',
                flat_regime(), dict(TEST_PROJECT, costs={'capex': {'drilling': 10000, 'facilities': 10000, 'subsea': 0}, 'opex': {'fixed': 60, 'variable': 4}})),
        cf_case('gas_and_ngl_streams', 'Gas and NGL streams contribute revenue and boe on the default project under the Generic template.',
                dict(template_regimes()[5], id='generic', name='Generic'), DEFAULT_PROJECT),
    ]
    for t, reg in zip(TEMPLATES, template_regimes()):
        G['cashflow'].append(cf_case(f'template_{reg["id"]}_default_project', f'Template "{t["name"]}" on the Designer\'s default project.', reg, DEFAULT_PROJECT))
        G['cashflow'].append(cf_case(f'template_{reg["id"]}_test_project', f'Template "{t["name"]}" on the Suite test project.', reg, TEST_PROJECT))

    G['priceSweep'] = []
    for p in range(40, 121, 10):
        G['priceSweep'].append(cf_case(f'price_{p}_pia_default', f'Default PIA regime on the default project with oil scaled to ${p}.',
                                       DEFAULT_REGIMES[0], DEFAULT_PROJECT, 1.0, p / 70.0))
    G['capexSweep'] = []
    for m in (0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3):
        G['capexSweep'].append(cf_case(f'capex_{js_to_fixed(m, 1)}_pia_default', f'Default PIA regime on the default project at capex multiplier {m}.',
                                       DEFAULT_REGIMES[0], DEFAULT_PROJECT, m, 1.0))

    G['irr'] = [
        {'id': 'irr_all_positive', 'note': 'Suite test: no sign change, IRR 0.', 'cashFlows': [{'year': 1, 'contractorNCF': 10}, {'year': 2, 'contractorNCF': 20}], 'expected': 0.0},
        {'id': 'irr_known_21pct_year_end', 'note': '-100 then 121 at year-end discounting: (1 + r) = 1.21, IRR 21 percent.',
         'cashFlows': [{'year': 1, 'contractorNCF': -100}, {'year': 2, 'contractorNCF': 121}], 'expected': 21.0},
        {'id': 'irr_npv0_negative', 'note': 'NPV at 0 percent is negative: the engine reports 0 rather than a negative rate.',
         'cashFlows': [{'year': 1, 'contractorNCF': -100}, {'year': 2, 'contractorNCF': 90}], 'expected': 0.0},
        {'id': 'irr_beyond_bracket', 'note': '-1 then 2000: the rate is 199900 percent, past the engine\'s 102400 percent bracket, so the engine reports the bracket. Both numbers pinned.',
         'cashFlows': [{'year': 1, 'contractorNCF': -1}, {'year': 2, 'contractorNCF': 2000}], 'expected': ENGINE_IRR_BRACKET,
         'trueIrr': 199900.0, 'engine': {'irr': ENGINE_IRR_BRACKET, 'disagreement': 'bracket reported as the IRR'}},
        {'id': 'irr_three_period', 'note': '-1000, 600, 600: the year-end IRR solves 1000 x^2 = 600 x + 600, x = 1/(1+r).',
         'cashFlows': [{'year': 1, 'contractorNCF': -1000}, {'year': 2, 'contractorNCF': 600}, {'year': 3, 'contractorNCF': 600}],
         'expected': 100.0 * (1.0 / ((-600 + math.sqrt(600 ** 2 + 4 * 600 * 1000)) / 1200) - 1.0)},
    ]
    for c in G['irr']:
        c['npvAt10'] = npv(c['cashFlows'], 10)

    # deriveInsights unit cases from the Suite test.
    sens = {'price': {'labels': [40, 120], 'data': [{'regimeId': 'a', 'values': [30, 40]}, {'regimeId': 'b', 'values': [35, 60]}]},
            'capex': {'labels': ['0.8', '1.5'], 'data': [{'regimeId': 'a', 'values': [200, 100]}, {'regimeId': 'b', 'values': [180, 150]}]}}
    summ = [{'id': 'a', 'name': 'Alpha', 'npv': 150, 'irr': 22, 'paybackPeriod': 6, 'govTake': 400, 'effectiveTaxRate': 55},
            {'id': 'b', 'name': 'Beta', 'npv': 120, 'irr': 18, 'paybackPeriod': 4, 'govTake': 900, 'effectiveTaxRate': 70}]
    flipped = [dict(summ[1], npv=300), dict(summ[0])]
    never = [dict(r, paybackPeriod=None) for r in summ]
    one_sens = {'price': {'labels': [40, 120], 'data': [sens['price']['data'][0]]}, 'capex': {'labels': ['0.8', '1.5'], 'data': [sens['capex']['data'][0]]}}
    ties = [dict(summ[0], govTake=900, paybackPeriod=4), dict(summ[1])]
    G['insights'] = [
        {'id': 'insights_suite', 'note': 'Suite test summary: Beta pays back fastest and collects most; Beta resilient; Beta progressive.', 'summary': summ, 'sensitivityData': sens},
        {'id': 'insights_flipped', 'note': 'Beta ranked first by NPV: government verdict still follows the take.', 'summary': flipped, 'sensitivityData': sens},
        {'id': 'insights_never_pays_back', 'note': 'Every paybackPeriod null.', 'summary': never, 'sensitivityData': sens},
        {'id': 'insights_single_regime', 'note': 'One regime: no sweep verdicts, government sentence in its single form.', 'summary': [summ[0]], 'sensitivityData': one_sens},
        {'id': 'insights_ties', 'note': 'Ties on payback and government take: strict comparisons keep the FIRST of tied regimes.', 'summary': ties, 'sensitivityData': sens},
        {'id': 'insights_rounding', 'note': 'toFixed rounding pins: 0.25 is exact in binary and JavaScript rounds the tie up to 0.3 (Python would give 0.2); 2.45 is stored just above the tie so 2.5; 0.35 is stored just below so 0.3; 1.05 is stored just above so 1.1; -0.05 is stored just above the tie in magnitude so -0.1.',
         'summary': [dict(summ[0], npv=0.25, irr=0.35, govTake=2.45), dict(summ[1], npv=-0.05, irr=1.05, govTake=1.15)], 'sensitivityData': sens},
        {'id': 'insights_empty', 'note': 'No regimes: an empty list.', 'summary': [], 'sensitivityData': sens},
    ]
    for c in G['insights']:
        c['expected'] = insights(c['summary'], c['sensitivityData'])

    G['comparisons'] = [
        {'id': 'cmp_designer_defaults', 'note': 'runFiscalComparison on the Designer\'s two default regimes and default project.',
         'regimes': DEFAULT_REGIMES, 'project': DEFAULT_PROJECT},
        {'id': 'cmp_all_templates_default_project', 'note': 'All six templates on the default project.',
         'regimes': template_regimes(), 'project': DEFAULT_PROJECT},
        {'id': 'cmp_all_templates_test_project', 'note': 'All six templates on the Suite test project.',
         'regimes': template_regimes(), 'project': TEST_PROJECT},
        {'id': 'cmp_flat_vs_complex', 'note': 'The two Suite test regimes side by side.',
         'regimes': [flat_regime(), COMPLEX_REGIME], 'project': TEST_PROJECT},
        {'id': 'cmp_never_recovers', 'note': 'Templates on a project with capex 20000: nothing pays back, every IRR 0, the payback insight says so.',
         'regimes': template_regimes(),
         'project': dict(TEST_PROJECT, costs={'capex': {'drilling': 10000, 'facilities': 10000, 'subsea': 0}, 'opex': {'fixed': 60, 'variable': 4}})},
    ]
    for c in G['comparisons']:
        c['expected'] = comparison(c['regimes'], c['project'])
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
