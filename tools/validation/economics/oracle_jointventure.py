#!/usr/bin/env python3
"""Independent stdlib oracle for engines/economics/jointVenture.js (Economics EC9).

    python3 tools/validation/economics/oracle_jointventure.py

Writes test-data/economics/goldens/jointventure_cases.json. Reads no
JavaScript and imports nothing from the engines. Every rule is coded here
from the stated clause arithmetic of the public texts (sources in
FINDINGS-jointVenture.md), by a different road:

  money          exact Fractions of the input doubles; a figure leaves the
                 oracle as the nearest double only at the end.
  interests      a cost-bearing table: for each party, the fraction of one unit
                 of joint cost it pays, built carry by carry.
  cash calls     CUMULATIVE: the adjustment due in month t is the sum of the
                 differences of every called month up to t - lag, less every
                 adjustment already applied (forecast share - call of each
                 earlier called month); balances are cumulative paid - actual.
  budget         exact comparisons on Fractions.
  overhead       the band that holds the base is found first; the charge is the
                 full charges of the lower bands plus the part in that band.
  default        python datetime for the dates, weekdays and months.
  recovery       CUMULATIVE for premiums and refunds with no uplift (the payout
                 year is the first year cumulative availability reaches the
                 amount owed); a year ledger with compound or multiple uplift.
  PSC            the cost pool, profit oil and tax straight from the stated
                 order of the World Bank and IMF texts; the limit on gross is
                 applied to gross (never converted); nothing from cashflow.ts.
  NPV            sum of c_t / (1 + r)^(t - base) as an exact Fraction.
Figures PRINTED inside a message are the double nearest the exact value
(js_num). The fixtures keep money in whole dollars and paying interests of
50, 31.25, 18.75 and 0 so that the engine's doubles are the exact values.
"""
import calendar
import datetime as dt
import json
import math
import os
import sys
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FIX = os.path.join(ROOT, 'test-data', 'economics', 'ekene-jv', 'ekene-jv.json')
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'jointventure_cases.json')
MISSING = object()
INF = float('inf')

PIA_MAX_PARTICIPATION = 60          # s.85(4)(a)
PIA_REFUNDABLE = ['development', 'production']  # s.85(4)(c)
COST_KINDS = ['exploration', 'development', 'production', 'bonus', 'penalty', 'interest', 'premium', 'markup']
CAPS = {'parties': 20, 'years': 100, 'months': 600, 'items': 200, 'bands': 20}
SUM_TOL = F(1, 10 ** 9)


# ------------------------------------------------------------------ formatting
def js_num(x):
    """JavaScript String(x) for a double: shortest round-trip digits."""
    x = float(x)
    if x == 0:
        return '0'
    if math.isinf(x):
        return 'Infinity' if x > 0 else '-Infinity'
    sign = '-' if x < 0 else ''
    r = repr(abs(x))
    if 'e' in r:
        mant, ex = r.split('e')
        ex = int(ex)
    else:
        mant, ex = r, 0
    ip, fp = (mant.split('.') + [''])[:2] if '.' in mant else (mant, '')
    digits = (ip + fp).lstrip('0')
    lead = len(ip + fp) - len((ip + fp).lstrip('0'))
    point = len(ip) + ex - lead
    digits = digits.rstrip('0') or '0'
    k, n = len(digits), point
    if k <= n <= 21:
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * (-n) + digits
    e = n - 1
    es = ('+' if e >= 0 else '-') + str(abs(e))
    return sign + digits + 'e' + es if k == 1 else sign + digits[0] + '.' + digits[1:] + 'e' + es


def js(v):
    return js_num(float(v))


def isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def show(v):
    if v is MISSING:
        return 'nothing'
    if isnum(v):
        return js(v)
    if isinstance(v, str):
        return '"' + v + '"'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    return json.dumps(v, separators=(',', ':'))


def money(x):
    """Money in a reason: rounded to the cent, half away from zero, trailing
    zeros dropped (the engine's stated print rule). A value within 1e-6 of a
    half-cent tie is refused: the double the engine holds could fall either
    side, so such a fixture must be changed."""
    from decimal import Decimal, ROUND_HALF_UP
    x = F(x)
    frac = (abs(x) * 100) % 1
    if abs(frac - F(1, 2)) < F(1, 10 ** 6):
        sys.exit(f'money figure {float(x)} is within 1e-6 of a half-cent tie: change the fixture')
    d = (Decimal(x.numerator) / Decimal(x.denominator)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return js_num(float(d))


def unit(x, one, many=None):
    return f'{js(x)} {one if x == 1 else (many or one + "s")}'


class Refusal(Exception):
    def __init__(self, field, message):
        super().__init__(field)
        self.field = field
        self.message = f'{field} {message}'


def refuse(field, message):
    raise Refusal(field, message)


def must(field, cond, v):
    refuse(field, f'must be {cond}; got {show(v)}')


def g(d, k):
    return d[k] if isinstance(d, dict) and k in d and d[k] is not None else MISSING


def isint(x):
    return isnum(x) and float(x).is_integer()


def isobj(x):
    return isinstance(x, dict)


def fl(x):
    return float(x)


# ----------------------------------------------------------------- checkers
def non_neg(f, v):
    if not (isnum(v) and v >= 0):
        must(f, 'a finite number at or above 0', v)


def positive(f, v):
    if not (isnum(v) and v > 0):
        must(f, 'a finite number above 0', v)


def pct(f, v):
    if not (isnum(v) and 0 <= v <= 100):
        must(f, 'a number from 0 to 100', v)


def pct_pos(f, v):
    if not (isnum(v) and 0 < v <= 100):
        must(f, 'a number above 0 and at most 100', v)


def int_at_least(f, v, lo):
    if not (isint(v) and v >= lo):
        must(f, f'an integer at or above {lo}', v)


def one_of(f, v, opts):
    if v not in opts or not isinstance(v, str):
        must(f, 'one of ' + ', '.join(f'"{o}"' for o in opts), v)


def text(f, v):
    if not (isinstance(v, str) and v.strip() != ''):
        must(f, 'a non-empty string', v)


def list_of(f, v, cap):
    if not isinstance(v, list) or len(v) < 1:
        must(f, 'an array of at least 1 entry', v)
    if len(v) > cap:
        refuse(f, f'must have at most {cap} entries; got {len(v)}')
    for i, x in enumerate(v):
        if not isobj(x):
            must(f'{f}[{i}]', 'an object', x)


def parse_day(s):
    try:
        if not (isinstance(s, str) and len(s) == 10 and s[4] == '-' and s[7] == '-'):
            return None
        return dt.date(int(s[:4]), int(s[5:7]), int(s[8:]))
    except ValueError:
        return None


def real_date(f, v):
    if parse_day(v) is None:
        must(f, "a real date 'YYYY-MM-DD'", v)


def is_month(s):
    return isinstance(s, str) and len(s) == 7 and s[4] == '-' and s[:4].isdigit() and s[5:].isdigit() and 1 <= int(s[5:]) <= 12


# -------------------------------------------------------------- accepted keys
def OBJ(keys, **ch):
    return ('obj', keys, ch)


def LST(of):
    return ('list', of)


FREE = ('free',)
PARTY = OBJ(['id', 'name', 'participatingPct'])
CARRY = OBJ(['carried', 'carriedPct', 'carriers'])
CONSEQ = OBJ(['after', 'unit', 'from'])
SHAPES = {
    'participatingInterests': OBJ(['parties', 'carries'], parties=LST(PARTY), carries=LST(CARRY)),
    'cashCalls': OBJ(['parties', 'carries', 'months', 'reconciliationLagMonths', 'negativeCall', 'noCallBelow'],
                     parties=LST(PARTY), carries=LST(CARRY), months=LST(OBJ(['month', 'forecast', 'actual']))),
    'budgetControl': OBJ(['items', 'itemTolerancePct', 'budgetTolerance', 'unbudgetedAllowance'],
                         items=LST(OBJ(['item', 'approved', 'actual'])), budgetTolerance=OBJ(['pct', 'amount'])),
    'overhead': OBJ(['costs', 'excluded', 'scale'], costs=FREE, excluded=FREE, scale=FREE),
    'defaultCover': OBJ(['parties', 'carries', 'callTotal', 'dueDate', 'asOf', 'defaulters', 'interest', 'suspension', 'forfeiture', 'holidays'],
                        parties=LST(PARTY), carries=LST(CARRY), defaulters=LST(OBJ(['id', 'paid', 'curedOn'])),
                        interest=OBJ(['annualRatePct', 'dayBasis', 'interestMethod', 'graceHours']), suspension=CONSEQ, forfeiture=CONSEQ),
    'carryRecovery': OBJ(['parties', 'carries', 'carried', 'years', 'uplift', 'recoverFromPct', 'cap', 'basis', 'discountRate', 'baseYear'],
                         parties=LST(PARTY), carries=LST(CARRY), years=LST(OBJ(['year', 'cost', 'entitlement'])),
                         uplift=OBJ(['type', 'ratePctPerYear', 'multiplePct'])),
    'backIn': OBJ(['parties', 'backInParty', 'targetPct', 'costs', 'basis', 'refundableKinds', 'refundForm', 'recoverFromPct', 'years'],
                  parties=LST(PARTY), costs=LST(OBJ(['item', 'amount', 'kind'])), years=LST(OBJ(['year', 'entitlement']))),
    'nonConsent': OBJ(['parties', 'consenting', 'operation', 'premiumMultiplePct', 'mode', 'years'],
                      parties=LST(PARTY), operation=OBJ(['name', 'cost']), years=LST(OBJ(['year', 'grossValue', 'deductions']))),
    'pscCostRecovery': OBJ(['years', 'royaltyPct', 'costOilLimitPct', 'costOilLimitBase', 'contractorProfitSharePct', 'taxRatePct', 'openingCostPool', 'parties', 'discountRate', 'baseYear'],
                           years=LST(OBJ(['year', 'grossRevenue', 'capex', 'opex', 'contractorProfitSharePct'])), parties=LST(PARTY)),
}


def unknown_key(path, key, keys):
    where = f'of {path}' if path else 'at the top level'
    refuse(f'{path}.{key}' if path else key, f'is not an accepted key; the accepted keys {where} are ' + ', '.join(keys))


def check_keys(v, shape, path):
    if shape[0] == 'free':
        return
    if shape[0] == 'list':
        if isinstance(v, list):
            for i, x in enumerate(v):
                check_keys(x, shape[1], f'{path}[{i}]')
        return
    if not isobj(v):
        return
    _, keys, ch = shape
    for k in v:
        if v[k] is not None and k not in keys:
            unknown_key(path, k, keys)
    for k in keys:
        if k in ch and k in v and v[k] is not None:
            check_keys(v[k], ch[k], f'{path}.{k}' if path else k)


# ------------------------------------------------------------------- parties
def check_parties(parties, pre='parties'):
    list_of(pre, parties, CAPS['parties'])
    seen = set()
    for i, p in enumerate(parties):
        text(f'{pre}[{i}].id', g(p, 'id'))
        if 'name' in p and p['name'] is not None:
            text(f'{pre}[{i}].name', p['name'])
        pct_pos(f'{pre}[{i}].participatingPct', g(p, 'participatingPct'))
        if p['id'] in seen:
            must(f'{pre}[{i}].id', 'an id no other party has', p['id'])
        seen.add(p['id'])
    tot = sum(F(p['participatingPct']) for p in parties)
    if abs(tot - 100) > SUM_TOL:
        refuse(pre, f'must have participatingPct summing to 100; got a sum of {js(sum(p["participatingPct"] for p in parties))}')


def check_carries(carries, parties):
    if carries is MISSING:
        return
    if not isinstance(carries, list):
        must('carries', 'an array of carries when given', carries)
    if len(carries) > CAPS['parties']:
        refuse('carries', f'must have at most {CAPS["parties"]} entries; got {len(carries)}')
    pid = [p['id'] for p in parties]
    carried = []
    for i, c in enumerate(carries):
        f = f'carries[{i}]'
        if not isobj(c):
            must(f, 'an object', c)
        if g(c, 'carried') not in pid:
            must(f'{f}.carried', 'the id of a party (' + ', '.join(pid) + ')', g(c, 'carried'))
        if c['carried'] in carried:
            must(f'{f}.carried', 'a party no other carry names', c['carried'])
        carried.append(c['carried'])
        pct_pos(f'{f}.carriedPct', g(c, 'carriedPct'))
    for i, c in enumerate(carries):
        f = f'carries[{i}].carriers'
        cr = g(c, 'carriers')
        if cr == 'pro-rata':
            continue
        if not isobj(cr) or not [k for k in cr if cr[k] is not None]:
            must(f, '"pro-rata" or an object of carrier shares in per cent (no default)', cr)
        names = [k for k in cr if cr[k] is not None]
        for k in names:
            if k not in pid:
                refuse(f'{f}.{k}', 'is not a party; the parties are ' + ', '.join(pid))
            if k in carried:
                refuse(f'{f}.{k}', 'is a carried party and cannot carry another')
            pct_pos(f'{f}.{k}', cr[k])
        tot = sum(F(cr[k]) for k in names)
        if abs(tot - 100) > SUM_TOL:
            refuse(f, f'must sum to 100; got a sum of {js(sum(cr[k] for k in names))}')
    if len(carried) == len(parties):
        must('carries', 'leaving at least one party that is not carried', [c['carried'] for c in carries])


def cost_table(parties, carries):
    """For each party the Fraction of one unit of joint cost it pays, with the
    carriers of each carry and their weights (as exact Fractions)."""
    carries = carries if isinstance(carries, list) else []
    carried = {c['carried'] for c in carries}
    payers = [p for p in parties if p['id'] not in carried]
    ptot = sum(F(p['participatingPct']) for p in payers)
    pay = {p['id']: F(p['participatingPct']) / 100 for p in parties}
    info = []
    for c in carries:
        cp = F(next(p['participatingPct'] for p in parties if p['id'] == c['carried']))
        moved = cp * F(c['carriedPct']) / 100 / 100            # a fraction of one unit of cost
        pay[c['carried']] -= moved
        if c['carriers'] == 'pro-rata':
            w = [(p['id'], F(p['participatingPct']) / ptot) for p in payers]
        else:
            w = [(k, F(c['carriers'][k]) / 100) for k in c['carriers'] if c['carriers'][k] is not None]
        for k, share in w:
            pay[k] += moved * share
        info.append({'carried': c['carried'], 'carriedPct': c['carriedPct'], 'moved': moved * 100, 'weights': w,
                     'rule': 'pro-rata' if c['carriers'] == 'pro-rata' else 'stated'})
    return {k: v * 100 for k, v in pay.items()}, info


def interests(a):
    parties, carries = g(a, 'parties'), g(a, 'carries')
    check_parties(parties)
    check_carries(carries, parties)
    pay, info = cost_table(parties, carries)
    shares_of = {p['id']: [] for p in parties}
    carried_pct = {p['id']: 0 for p in parties}
    carries_out = []
    for c in info:
        carried_pct[c['carried']] = c['carriedPct']
        alloc = [{'id': k, 'sharePct': fl(w * 100), 'pct': fl(c['moved'] * w)} for k, w in c['weights']]
        for x in alloc:
            shares_of[x['id']].append({'carried': c['carried'], 'sharePct': x['sharePct'], 'pct': x['pct']})
        carries_out.append({'carried': c['carried'], 'carriedPct': c['carriedPct'], 'carriedInterestPct': fl(c['moved']), 'rule': c['rule'], 'carriers': alloc})
    rows = [{'id': p['id'], 'name': p.get('name'), 'beneficialPct': p['participatingPct'], 'payingPct': fl(pay[p['id']]),
             'carriedPct': carried_pct[p['id']], 'carryShares': shares_of[p['id']]} for p in parties]
    reasons = []
    bpct = {p['id']: p['participatingPct'] for p in parties}
    for c in carries_out:
        paid = ', '.join(f'{x["id"]} {js(x["pct"])}' for x in c['carriers'])
        how = 'pro rata to their participating interests' if c['rule'] == 'pro-rata' else 'in the stated shares'
        reasons.append(f'{c["carried"]}: {js(c["carriedPct"])}% of its {js(bpct[c["carried"]])}% cost share is carried ({js(c["carriedInterestPct"])} points), paid by {paid} ({how}); its share of production stays {js(bpct[c["carried"]])}%')
    return {'parties': rows, 'carries': carries_out,
            'totals': {'beneficialPct': fl(sum(F(p['participatingPct']) for p in parties)), 'payingPct': fl(sum(pay.values()))},
            'reasons': reasons}


def split(amount, pctmap):
    """The share of an amount by per cent: amount x pct / 100, exact."""
    return {k: F(amount) * F(v) / 100 for k, v in pctmap.items()}


# ----------------------------------------------------------------- cash calls
def next_month(m):
    y, mo = int(m[:4]), int(m[5:])
    return f'{y + 1}-01' if mo == 12 else f'{y}-{mo + 1:02d}'


def cash_calls(a):
    parties, carries = g(a, 'parties'), g(a, 'carries')
    check_parties(parties)
    check_carries(carries, parties)
    months = g(a, 'months')
    list_of('months', months, CAPS['months'])
    lag = g(a, 'reconciliationLagMonths')
    int_at_least('reconciliationLagMonths', lag, 1)
    neg = g(a, 'negativeCall')
    one_of('negativeCall', neg, ['refund', 'carry'])
    thr = g(a, 'noCallBelow')
    if thr is not MISSING:
        non_neg('noCallBelow', thr)
    for i, m in enumerate(months):
        f = f'months[{i}]'
        if not is_month(g(m, 'month')):
            must(f'{f}.month', "a month 'YYYY-MM'", g(m, 'month'))
        if i > 0:
            nx = next_month(months[i - 1]['month'])
            if m['month'] != nx:
                must(f'{f}.month', f'{nx}, the month after {months[i - 1]["month"]} (the months are consecutive)', m['month'])
        non_neg(f'{f}.forecast', g(m, 'forecast'))
        non_neg(f'{f}.actual', g(m, 'actual'))
    pay, _ = cost_table(parties, carries)
    pid = [p['id'] for p in parties]
    called = [thr is MISSING or m['forecast'] >= thr for m in months]
    fshare = [split(m['forecast'], pay) for m in months]
    ashare = [split(m['actual'], pay) for m in months]
    # the difference of each month (0 for a month without a call)
    diff = [{k: (fshare[t][k] - ashare[t][k]) if called[t] else F(0) for k in pid} for t in range(len(months))]
    applied = []         # per month: forecast share - call (called months), else 0
    calls = []
    carried_hist = []
    out = []
    for t, m in enumerate(months):
        rows = []
        carried_prev = carried_hist[-1] if carried_hist else {k: F(0) for k in pid}
        call_t, carried_t, pend_t = {}, {}, {}
        for k in pid:
            # cumulative road: everything due by now, less everything applied so far
            due_sum = sum((diff[s][k] for s in range(0, t - lag + 1)), F(0))
            app_sum = sum((applied[s][k] for s in range(t)), F(0))
            pending = due_sum - app_sum
            pend_t[k] = pending
            if called[t]:
                raw = fshare[t][k] - pending
                if raw >= 0 or neg == 'refund':
                    call_t[k], carried_t[k] = raw, F(0)
                else:
                    call_t[k], carried_t[k] = F(0), -raw
            else:
                call_t[k], carried_t[k] = F(0), pending
        applied.append({k: (fshare[t][k] - call_t[k]) if called[t] else F(0) for k in pid})
        calls.append(call_t)
        carried_hist.append(carried_t)
        arrears_bill = {k: (ashare[t - 1][k] if t > 0 and not called[t - 1] else F(0)) for k in pid}
        for k in pid:
            paid_cum = sum((calls[s][k] + (ashare[s - 1][k] if s > 0 and not called[s - 1] else 0) for s in range(t + 1)), F(0))
            act_cum = sum((ashare[s][k] for s in range(t + 1)), F(0))
            rows.append({'id': k, 'payingPct': fl(pay[k]), 'forecastShare': fl(fshare[t][k]), 'adjustment': fl(pend_t[k]), 'call': fl(call_t[k]),
                         'arrearsBilling': fl(arrears_bill[k]), 'paid': fl(call_t[k] + arrears_bill[k]), 'actualShare': fl(ashare[t][k]),
                         'difference': fl(diff[t][k]), 'carried': fl(carried_t[k]), 'balance': fl(paid_cum - act_cum)})
        reasons = []
        if t > 0 and not called[t - 1]:
            reasons.append(f'{m["month"]}: the actual of {months[t - 1]["month"]}, {money(months[t - 1]["actual"])}, made without a cash call, is billed in arrears')
        if not called[t]:
            reasons.append(f'{m["month"]}: no cash call: the forecast {money(m["forecast"])} is below the stated threshold {money(thr)}; the actual is billed in arrears in the next month')
        where = 'this cash call' if called[t] else 'the next cash call (none is made this month)'
        if t - lag >= 0 and called[t - lag]:
            d = months[t - lag]
            net = F(d['forecast']) - F(d['actual'])
            if net > 0:
                reasons.append(f'{m["month"]}: the over-call of {money(net)} in {d["month"]} (forecast {money(d["forecast"])}, actual {money(d["actual"])}) is credited against {where}, {unit(lag, "month")} later')
            elif net < 0:
                reasons.append(f'{m["month"]}: the under-call of {money(-net)} in {d["month"]} (forecast {money(d["forecast"])}, actual {money(d["actual"])}) is added to {where}, {unit(lag, "month")} later')
            else:
                reasons.append(f'{m["month"]}: {d["month"]} was called exactly (forecast = actual = {money(d["actual"])}); no adjustment')
        cin = sum(carried_prev.values(), F(0))
        if cin > 0:
            reasons.append(f'{m["month"]}: a credit of {money(cin)} held from {months[t - 1]["month"]} is applied to {where}')
        elif cin < 0:
            reasons.append(f'{m["month"]}: {money(-cin)} owed from {months[t - 1]["month"]} is added to {where}')
        if called[t] and m['forecast'] == 0:
            reasons.append(f'{m["month"]}: a forecast of 0: the cash call is the adjustment alone')
        negs = [k for k in pid if call_t[k] < 0]
        if negs:
            reasons.append(f'{m["month"]}: the adjustment exceeds the forecast share of {", ".join(negs)}: the excess is refunded (a negative call)')
        held = [k for k in pid if called[t] and carried_t[k] > 0]
        if held:
            reasons.append(f'{m["month"]}: the adjustment exceeds the forecast share of {", ".join(held)}: the call is 0 and the rest of the credit is carried to the next cash call')
        tot = lambda key: fl(sum(F(r[key]) for r in rows))
        out.append({'month': m['month'], 'forecast': m['forecast'], 'actual': m['actual'], 'called': called[t], 'parties': rows,
                    'totals': {'call': tot('call'), 'arrearsBilling': tot('arrearsBilling'), 'paid': tot('paid'), 'actualShare': tot('actualShare'), 'difference': tot('difference')},
                    'reasons': reasons})
    n = len(months)
    last_uncalled = not called[-1]
    closing = []
    for i, k in enumerate(pid):
        unadj = sum((diff[t][k] for t in range(max(0, n - lag), n)), F(0))
        closing.append({'id': k, 'balance': out[-1]['parties'][i]['balance'], 'unadjustedDifferences': fl(unadj),
                        'carried': fl(carried_hist[-1][k]), 'arrearsDue': fl(ashare[-1][k]) if last_uncalled else 0})
    return {'months': out, 'closing': closing,
            'totals': {'called': fl(sum((sum(c.values(), F(0)) for c in calls), F(0))),
                       'arrearsBilled': fl(sum((sum(ashare[t - 1].values(), F(0)) for t in range(1, n) if not called[t - 1]), F(0))),
                       'actual': fl(sum(F(m['actual']) for m in months))}}


# ------------------------------------------------------------------- budget
def budget(a):
    items = g(a, 'items')
    list_of('items', items, CAPS['items'])
    tol = g(a, 'itemTolerancePct')
    non_neg('itemTolerancePct', tol)
    bt = g(a, 'budgetTolerance')
    if not isobj(bt):
        must('budgetTolerance', 'an object { pct, amount } (amount optional; no default)', bt)
    non_neg('budgetTolerance.pct', g(bt, 'pct'))
    amt = g(bt, 'amount')
    if amt is not MISSING:
        non_neg('budgetTolerance.amount', amt)
    allow = g(a, 'unbudgetedAllowance')
    if allow is not MISSING:
        non_neg('unbudgetedAllowance', allow)
    seen = set()
    for i, it in enumerate(items):
        text(f'items[{i}].item', g(it, 'item'))
        non_neg(f'items[{i}].approved', g(it, 'approved'))
        non_neg(f'items[{i}].actual', g(it, 'actual'))
        if it['item'] in seen:
            must(f'items[{i}].item', 'a name no other item has', it['item'])
        seen.add(it['item'])
    reasons = []
    unb_total = sum((F(it['actual']) for it in items if it['approved'] == 0 and it['actual'] > 0), F(0))
    unb_inside = allow is not MISSING and unb_total <= F(allow)
    rows = []
    for it in items:
        ap, ac = F(it['approved']), F(it['actual'])
        limit = ap + ap * F(tol) / 100
        over = ac - ap
        if ap == 0:
            within = ac == 0 or unb_inside
            if ac > 0:
                if allow is MISSING:
                    tail = ': outside the approved budget'
                elif unb_inside:
                    tail = f', inside the unbudgeted allowance {money(allow)} with the other unbudgeted items ({money(unb_total)} in all)'
                else:
                    tail = f': the unbudgeted items total {money(unb_total)}, above the allowance {money(allow)}'
                reasons.append(f'{it["item"]}: {money(ac)} spent with no approved budget{tail}')
        else:
            within = ac <= limit
            if over > 0:
                reasons.append(f'{it["item"]}: {money(ac)} against {money(ap)} approved is an overrun of {money(over)}, {"inside" if within else "beyond"} the item tolerance of {js(tol)}% (limit {money(limit)})')
        rows.append({'item': it['item'], 'approved': it['approved'], 'actual': it['actual'], 'overrun': fl(over),
                     'overrunPct': fl(over * 100 / ap) if ap > 0 else None, 'limit': fl(limit) if ap > 0 else None, 'withinItemTolerance': within})
    ap = sum(F(it['approved']) for it in items)
    ac = sum(F(it['actual']) for it in items)
    by_pct = ap * F(bt['pct']) / 100
    allowed = by_pct if amt is MISSING else min(by_pct, F(amt))
    over = ac - ap
    inside = over <= allowed
    held = 'pct' if amt is MISSING or by_pct <= F(amt) else 'amount'
    state = f'an overrun of {money(over)}' if over > 0 else (f'an underrun of {money(-over)}' if over < 0 else 'on budget')
    rule = f'{js(bt["pct"])}% of the approved total, {money(allowed)}' if amt is MISSING else f'the lower of {js(bt["pct"])}% of the approved total ({money(by_pct)}) and {money(amt)}: {money(allowed)}'
    reasons.append(f'the budget: {money(ac)} against {money(ap)} approved, {state}; the allowed overrun is {rule}; {"inside" if inside else "beyond"} the budget tolerance')
    return {'items': rows,
            'total': {'approved': fl(ap), 'actual': fl(ac), 'overrun': fl(over), 'allowedOverrun': fl(allowed), 'heldBy': held, 'withinBudgetTolerance': inside},
            'unbudgeted': {'total': fl(unb_total), 'allowance': None if allow is MISSING else allow, 'withinAllowance': None if allow is MISSING else unb_inside},
            'itemsOutsideTolerance': [r['item'] for r in rows if not r['withinItemTolerance']],
            'reasons': reasons}


# ----------------------------------------------------------------- overhead
def overhead(a):
    costs = g(a, 'costs')
    if not isobj(costs) or not costs:
        must('costs', 'an object of annual costs by category, at least one', costs)
    cats = [k for k in costs if costs[k] is not None]
    if len(cats) > CAPS['items']:
        refuse('costs', f'must have at most {CAPS["items"]} categories; got {len(cats)}')
    for k in cats:
        non_neg(f'costs.{k}', costs[k])
    ex = g(a, 'excluded')
    ex = {} if ex is MISSING else ex
    if not isobj(ex):
        must('excluded', 'an object of excluded amounts by category when given', ex)
    for k in ex:
        if ex[k] is None:
            continue
        if k not in cats:
            refuse(f'excluded.{k}', 'is not a cost category; the categories are ' + ', '.join(cats))
        non_neg(f'excluded.{k}', ex[k])
        if ex[k] > costs[k]:
            must(f'excluded.{k}', f'at or below the cost of the category {js(costs[k])}', ex[k])
    sc = g(a, 'scale')
    if not isobj(sc):
        must('scale', 'an object with a scale { bands, abovePct } for every cost category (no default rate)', sc)
    for k in sc:
        if sc[k] is not None and k not in cats:
            refuse(f'scale.{k}', 'is not a cost category; the categories are ' + ', '.join(cats))
    for k in cats:
        s = g(sc, k)
        f = f'scale.{k}'
        if not isobj(s):
            must(f, 'an object { bands, abovePct } (no default rate)', s)
        for key in s:
            if s[key] is not None and key not in ('bands', 'abovePct'):
                unknown_key(f, key, ['bands', 'abovePct'])
        bands = g(s, 'bands')
        if not isinstance(bands, list):
            must(f'{f}.bands', 'an array of { upTo, pct } (empty for a flat percentage)', bands)
        if len(bands) > CAPS['bands']:
            refuse(f'{f}.bands', f'must have at most {CAPS["bands"]} entries; got {len(bands)}')
        prev = 0
        for i, b in enumerate(bands):
            bf = f'{f}.bands[{i}]'
            if not isobj(b):
                must(bf, 'an object', b)
            for key in b:
                if b[key] is not None and key not in ('upTo', 'pct'):
                    unknown_key(bf, key, ['upTo', 'pct'])
            positive(f'{bf}.upTo', g(b, 'upTo'))
            pct(f'{bf}.pct', g(b, 'pct'))
            if not b['upTo'] > prev:
                must(f'{bf}.upTo', f"above the previous band's upTo {js(prev)}", b['upTo'])
            prev = b['upTo']
        pct(f'{f}.abovePct', g(s, 'abovePct'))
    rows, reasons = [], []
    for k in cats:
        e = F(ex.get(k) or 0)
        base = F(costs[k]) - e
        bands = sc[k]['bands']
        edges = [F(0)] + [F(b['upTo']) for b in bands]
        # which band holds the base: index j with edges[j] < base <= edges[j+1]; len(bands) for above
        j = next((i for i in range(len(bands)) if base <= edges[i + 1]), len(bands))
        out_b = []
        for i, b in enumerate(bands):
            lo, hi = edges[i], edges[i + 1]
            if i < j:
                amt_ = hi - lo
            elif i == j:
                amt_ = max(F(0), base - lo)
            else:
                amt_ = F(0)
            out_b.append({'from': fl(lo), 'upTo': b['upTo'], 'pct': b['pct'], 'amount': fl(amt_), 'charge': fl(amt_ * F(b['pct']) / 100)})
        above_amt = base - edges[-1] if j == len(bands) else F(0)
        above_amt = max(F(0), above_amt)
        ap_ = F(sc[k]['abovePct'])
        charge = sum((F(b['amount']) * F(b['pct']) / 100 for b in out_b), F(0)) + above_amt * ap_ / 100
        parts = [f'{js(b["pct"])}% of {money(b["amount"])}' for b in out_b if b['amount'] > 0]
        if above_amt > 0:
            parts.append(f'{js(ap_)}% of {money(above_amt)}' + (f' above {money(edges[-1])}' if bands else ''))
        excl = f' (cost {money(costs[k])} less exclusions {money(e)})' if e > 0 else ''
        reasons.append(f'{k}: base {money(base)}{excl}; {" + ".join(parts) if parts else "nothing to charge"} = {money(charge)}')
        rows.append({'category': k, 'cost': costs[k], 'excluded': fl(e), 'base': fl(base), 'bands': out_b,
                     'above': {'from': fl(edges[-1]), 'amount': fl(above_amt), 'pct': sc[k]['abovePct'], 'charge': fl(above_amt * ap_ / 100)},
                     'charge': fl(charge), '_c': charge})
    total = sum((r.pop('_c') for r in rows), F(0))
    return {'categories': rows, 'total': fl(total), 'reasons': reasons}


# ----------------------------------------------------------------- default
UNIT_WORD = {'calendar-days': 'calendar day', 'working-days': 'working day', 'months': 'month'}


def trigger(c, hol):
    d0 = parse_day(c['from'])
    n = c['after']
    if c['unit'] == 'calendar-days':
        return d0 + dt.timedelta(days=n)
    if c['unit'] == 'working-days':
        d = d0
        while n > 0:
            d += dt.timedelta(days=1)
            if d.weekday() < 5 and d.isoformat() not in hol:
                n -= 1
        return d
    y, m = divmod(d0.year * 12 + d0.month - 1 + n, 12)
    m += 1
    return dt.date(y, m, min(d0.day, calendar.monthrange(y, m)[1]))


def default_cover(a):
    parties, carries = g(a, 'parties'), g(a, 'carries')
    check_parties(parties)
    check_carries(carries, parties)
    call = g(a, 'callTotal')
    positive('callTotal', call)
    real_date('dueDate', g(a, 'dueDate'))
    real_date('asOf', g(a, 'asOf'))
    defs = g(a, 'defaulters')
    list_of('defaulters', defs, CAPS['parties'])
    due, asof = a['dueDate'], a['asOf']
    if not asof >= due:
        must('asOf', f'on or after the due date {due}', asof)
    it = g(a, 'interest')
    if not isobj(it):
        must('interest', 'an object { annualRatePct, dayBasis, interestMethod, graceHours } (no default rate or method)', it)
    non_neg('interest.annualRatePct', g(it, 'annualRatePct'))
    if g(it, 'dayBasis') not in (365, 360) or isinstance(g(it, 'dayBasis'), bool):
        must('interest.dayBasis', '365 or 360', g(it, 'dayBasis'))
    one_of('interest.interestMethod', g(it, 'interestMethod'), ['simple', 'monthly-compound'])
    gh = g(it, 'graceHours')
    if not (isnum(gh) and gh >= 0):
        must('interest.graceHours', 'a finite number of hours at or above 0, stated (0 when the contract gives no grace; the engine holds no default)', gh)
    hol = g(a, 'holidays')
    hol = [] if hol is MISSING else hol
    if not isinstance(hol, list):
        must('holidays', "an array of dates 'YYYY-MM-DD' when given", hol)
    for i, h in enumerate(hol):
        real_date(f'holidays[{i}]', h)
    cons = {}
    for name in ('suspension', 'forfeiture'):
        c = g(a, name)
        if c is MISSING:
            cons[name] = None
            continue
        if not isobj(c):
            must(name, 'an object { after, unit, from } when given', c)
        int_at_least(f'{name}.after', g(c, 'after'), 1)
        one_of(f'{name}.unit', g(c, 'unit'), ['calendar-days', 'working-days', 'months'])
        real_date(f'{name}.from', g(c, 'from'))
        cons[name] = c
    pay, _ = cost_table(parties, carries)
    pid = [p['id'] for p in parties]
    share = split(call, pay)
    seen = []
    for i, d in enumerate(defs):
        f = f'defaulters[{i}]'
        if g(d, 'id') not in pid:
            must(f'{f}.id', 'the id of a party (' + ', '.join(pid) + ')', g(d, 'id'))
        if d['id'] in seen:
            must(f'{f}.id', 'a party no other defaulter entry names', d['id'])
        seen.append(d['id'])
        non_neg(f'{f}.paid', g(d, 'paid'))
        if not F(d['paid']) < share[d['id']]:
            must(f'{f}.paid', f"below the party's share of the call {js(share[d['id']])} (a party that paid its share is not in default)", d['paid'])
        if g(d, 'curedOn') is not MISSING:
            real_date(f'{f}.curedOn', d['curedOn'])
            if not (due <= d['curedOn'] <= asof):
                must(f'{f}.curedOn', f'a date from the due date {due} to asOf {asof}', d['curedOn'])
    cov = [k for k in pid if k not in seen and pay[k] > 0]
    ctot = sum((pay[k] for k in cov), F(0))
    if not cov or ctot == 0:
        must('defaulters', 'leaving at least one non-defaulting party with a paying interest above 0', [d['id'] for d in defs])
    holset = set(hol)
    reasons, drows = [], []
    for d in defs:
        unpaid = share[d['id']] - F(d['paid'])
        cured = g(d, 'curedOn')
        end = parse_day(asof if cured is MISSING else cured)
        days = (end - parse_day(due)).days
        within = days * 24 <= it['graceHours']
        whole = rem = None
        if it['interestMethod'] == 'simple':
            interest = F(0) if within else unpaid * F(it['annualRatePct']) / 100 * days / it['dayBasis']
        else:
            # step month anniversaries forward with datetime; compound each whole month
            d0 = parse_day(due)
            whole, bal = 0, unpaid
            while True:
                y, m = divmod(d0.year * 12 + d0.month - 1 + whole + 1, 12)
                nxt = dt.date(y, m + 1, min(d0.day, calendar.monthrange(y, m + 1)[1]))
                if nxt > end:
                    break
                whole += 1
                bal = bal * (1 + F(it['annualRatePct']) / 1200)
            y, m = divmod(d0.year * 12 + d0.month - 1 + whole, 12)
            anchor = dt.date(y, m + 1, min(d0.day, calendar.monthrange(y, m + 1)[1]))
            rem = (end - anchor).days
            bal = bal * (1 + F(it['annualRatePct']) * rem / 100 / it['dayBasis'])
            interest = F(0) if within else bal - unpaid
        conseq = {}
        for name in ('suspension', 'forfeiture'):
            c = cons[name]
            if c is None:
                conseq[name] = None
                continue
            on = trigger(c, holset).isoformat()
            applies = (cured > on) if cured is not MISSING else (asof > on)
            conseq[name] = {'triggerDate': on, 'applies': applies}
        till = f'the cure on {cured}' if cured is not MISSING else f'asOf {asof}, the default still open'
        span = f'from {due} to {till}, the last date excluded'
        head = f'{d["id"]}: share of the call {money(share[d["id"]])}, paid {money(d["paid"])}, unpaid {money(unpaid)}; '
        if within and it['graceHours'] > 0:
            reasons.append(f'{head}no interest: {unit(days, "day")} ({js(days * 24)} hours, {span}) are within the stated grace of {js(it["graceHours"])} hours')
        else:
            note = f'; the stated grace of {js(it["graceHours"])} hours is exceeded, so interest runs from the due date' if it['graceHours'] > 0 else ''
            r_ = js(it['annualRatePct'])
            calc = (f'{money(unpaid)} x {r_}% x {unit(days, "day")} / {it["dayBasis"]}' if it['interestMethod'] == 'simple'
                    else f'{money(unpaid)} x ((1 + {r_}% / 12)^{whole} x (1 + {r_}% x {unit(rem, "day")} / {it["dayBasis"]}) - 1), {unit(whole, "whole month")} and {unit(rem, "day")}')
            reasons.append(f'{head}interest {calc} = {money(interest)} ({span}){note}')
        for name in ('suspension', 'forfeiture'):
            q = conseq[name]
            if q is None:
                continue
            c = cons[name]
            what = 'the suspension of its rights (as the contract states) starts' if name == 'suspension' else 'the right to demand the assignment of its interest (forfeiture, as the contract states) arises'
            if q['applies']:
                tail = f'triggered, the default being open after {q["triggerDate"]}'
            else:
                tail = 'not triggered, the default ' + (f'being cured on {cured}' if cured is not MISSING else f'being open only to asOf {asof}')
            reasons.append(f'{d["id"]}: {what} after {unit(c["after"], UNIT_WORD[c["unit"]])} from {c["from"]}, that is after {q["triggerDate"]}: {tail}')
        drows.append({'id': d['id'], 'share': fl(share[d['id']]), 'paid': d['paid'], 'unpaid': fl(unpaid), 'curedOn': None if cured is MISSING else cured,
                      'days': days, 'withinGrace': within, 'wholeMonths': whole, 'remainingDays': rem, 'interest': fl(interest), 'suspension': conseq['suspension'], 'forfeiture': conseq['forfeiture'], '_u': unpaid, '_i': interest})
    ut = sum((r['_u'] for r in drows), F(0))
    itot = sum((r['_i'] for r in drows), F(0))
    for r in drows:
        del r['_u'], r['_i']
    crow = [{'id': k, 'payingPct': fl(pay[k]), 'coverPct': fl(pay[k] * 100 / ctot), 'cover': fl(ut * pay[k] / ctot), 'interestReceived': fl(itot * pay[k] / ctot)} for k in cov]
    reasons.insert(0, f'the unpaid {money(ut)} is advanced by ' + ', '.join(f'{c["id"]} {money(c["cover"])}' for c in crow) + ', in proportion to their paying interests among the non-defaulting parties')
    after = None
    forf = [r['id'] for r in drows if r['forfeiture'] and r['forfeiture']['applies']]
    if forf:
        keep = [p for p in parties if p['id'] not in forf]
        kt = sum(F(p['participatingPct']) for p in keep)
        after = [{'id': p['id'], 'participatingPct': fl(F(p['participatingPct']) * 100 / kt)} for p in keep]
        reasons.append(f'if the assignment of {", ".join(forf)} is demanded, the interest is apportioned pro rata: ' + ', '.join(f'{p["id"]} {js(p["participatingPct"])}%' for p in after) + '; the compensation (at most the book value less unpaid contributions) is not computed')
    return {'callTotal': call, 'dueDate': due, 'asOf': asof, 'shares': [{'id': k, 'share': fl(share[k])} for k in pid],
            'defaulters': drows, 'cover': crow, 'unpaidTotal': fl(ut), 'interestTotal': fl(itot), 'interestsAfterForfeiture': after, 'reasons': reasons}


# ----------------------------------------------------------- recovery ledger
def check_years(years, keys, pre='years'):
    list_of(pre, years, CAPS['years'])
    for i, y in enumerate(years):
        f = f'{pre}[{i}]'
        int_at_least(f'{f}.year', g(y, 'year'), 1)
        if i > 0 and y['year'] != years[i - 1]['year'] + 1:
            must(f'{f}.year', f'{years[i - 1]["year"] + 1}, the year after {years[i - 1]["year"]} (years are consecutive)', y['year'])
        for k in keys:
            non_neg(f'{f}.{k}', g(y, k))


def ledger(years, owed, share_pct, from_pct, uplift, cap, label, debtor):
    """Year by year: the balance owed, its uplift, what the debtor's share
    makes available, what is recovered. Exact Fractions."""
    bal, got = F(0), F(0)
    rows = []
    for i, y in enumerate(years):
        rs = []
        opening = bal
        add = F(owed[i])
        if uplift['type'] == 'compound':
            up = opening * F(uplift['ratePctPerYear']) / 100
        elif uplift['type'] == 'multiple':
            up = add * (F(uplift['multiplePct']) - 100) / 100
        else:
            up = F(0)
        due = opening + up + add
        share = F(y['entitlement']) * F(share_pct) / 100
        avail = share * F(from_pct) / 100
        rec = min(avail, due) if cap is None else min(avail, due, F(cap) - got)
        got += rec
        closing = due - rec
        wo = F(0)
        if up > 0:
            rs.append(f'{y["year"]}: {js(uplift["ratePctPerYear"])}% a year on the opening balance {money(opening)} adds {money(up)}' if uplift['type'] == 'compound'
                      else f'{y["year"]}: the {js(uplift["multiplePct"])}% multiple on the {label} of {money(add)} adds {money(up)}')
        if cap is not None and got >= F(cap) and closing > 0:
            wo, closing = closing, F(0)
            rs.append(f'{y["year"]}: the stated cap {money(cap)} is reached with {money(rec)} recovered this year; the rest, {money(wo)}, is written off')
        elif due > 0 and closing == 0:
            how = ' exactly by' if rec == avail else f' with {money(rec)} of'
            rs.append(f'{y["year"]}: the balance {money(due)} is recovered{how} the {money(avail)} available; the {debtor} receives {money(share - rec)} of its share {money(share)}')
        elif due > 0:
            rs.append(f'{y["year"]}: {money(rec)} recovered of {money(due)} due; {money(closing)} carried to {y["year"] + 1}')
        bal = closing
        rows.append({'year': y['year'], 'opening': opening, 'uplift': up, 'added': add, 'due': due, 'share': share, 'available': avail,
                     'recovered': rec, 'closing': closing, 'writtenOff': wo, 'debtorReceives': share - rec, 'reasons': rs})
    owed_rows = [r for r in rows if r['due'] > 0]
    payout = None
    if owed_rows and owed_rows[-1]['closing'] == 0 and all(r['writtenOff'] == 0 for r in rows):
        payout = owed_rows[-1]['year']
    return rows, got, bal, payout


def payout_cumulative(years, amount, share_pct):
    """A second road for a single amount owed from the first year with no
    uplift and nothing else added: the payout year is the first year in
    which the cumulative share reaches the amount."""
    cum = F(0)
    for y in years:
        cum += F(y['entitlement']) * F(share_pct) / 100
        if amount > 0 and cum >= amount:
            return y['year']
    return None


def fl_row(r, keys):
    return {k: fl(r[k]) if isinstance(r[k], F) else r[k] for k in keys}


def npv_exact(flows, rate, base, first):
    r = F(rate)
    return sum((F(c) / (1 + r) ** (first + i - base) for i, c in enumerate(flows)), F(0))


def check_uplift(u):
    if not isobj(u):
        must('uplift', 'an object { type } with type "none", "compound" or "multiple" (no default)', u)
    one_of('uplift.type', g(u, 'type'), ['none', 'compound', 'multiple'])
    t = u['type']
    if t == 'compound':
        non_neg('uplift.ratePctPerYear', g(u, 'ratePctPerYear'))
        if g(u, 'multiplePct') is not MISSING:
            must('uplift.multiplePct', 'left out when type is "compound"', u['multiplePct'])
    elif t == 'multiple':
        mp = g(u, 'multiplePct')
        if not (isnum(mp) and mp >= 100):
            must('uplift.multiplePct', 'a number at or above 100 (100 recovers the cost alone)', mp)
        if g(u, 'ratePctPerYear') is not MISSING:
            must('uplift.ratePctPerYear', 'left out when type is "multiple"', u['ratePctPerYear'])
    else:
        if g(u, 'ratePctPerYear') is not MISSING:
            must('uplift.ratePctPerYear', 'left out when type is "none"', u['ratePctPerYear'])
        if g(u, 'multiplePct') is not MISSING:
            must('uplift.multiplePct', 'left out when type is "none"', u['multiplePct'])


def check_npv(rate, base):
    if rate is MISSING and base is MISSING:
        return False
    if not (isnum(rate) and rate > -1):
        must('discountRate', 'a finite number above -1 (stated with baseYear)', rate)
    int_at_least('baseYear', base, 1)
    return True


def carry(a):
    parties, carries = g(a, 'parties'), g(a, 'carries')
    check_parties(parties)
    check_carries(carries, parties)
    if not isinstance(carries, list) or not carries:
        must('carries', 'an array with the carry to recover', carries)
    cid = g(a, 'carried')
    c = next((x for x in carries if x['carried'] == cid), None)
    if c is None:
        must('carried', 'the carried party of one of the carries (' + ', '.join(x['carried'] for x in carries) + ')', cid)
    years = g(a, 'years')
    check_years(years, ['cost', 'entitlement'])
    up = g(a, 'uplift')
    check_uplift(up)
    rf = g(a, 'recoverFromPct')
    pct_pos('recoverFromPct', rf)
    cap = g(a, 'cap')
    if cap is not MISSING:
        positive('cap', cap)
    basis = g(a, 'basis')
    one_of('basis', basis, ['pia-s85-4', 'contract'])
    want_npv = check_npv(g(a, 'discountRate'), g(a, 'baseYear'))
    if basis == 'pia-s85-4' and up['type'] != 'none':
        must('uplift.type', '"none" under basis "pia-s85-4": the refund excludes interest, premium or markups on cost (PIA s.85(4)(c))', up['type'])
    pay, info = cost_table(parties, carries)
    ci = next(x for x in info if x['carried'] == cid)
    bp = {p['id']: F(p['participatingPct']) for p in parties}
    owed = [F(y['cost']) * bp[cid] * F(c['carriedPct']) / 10000 for y in years]
    rows, got, out_bal, payout = ledger(years, owed, bp[cid], rf, up, None if cap is MISSING else cap, 'carried cost', 'carried party')
    pid = [p['id'] for p in parties]
    w = dict(ci['weights'])
    flows = {k: [] for k in pid}
    prow = []
    for i, y in enumerate(years):
        r = rows[i]
        cs, es = split(y['cost'], pay), split(y['entitlement'], bp)
        ps = []
        for k in pid:
            rec = (-r['recovered'] if k == cid else F(0)) + (r['recovered'] * w[k] if k in w else F(0))
            net = es[k] + rec - cs[k]
            flows[k].append(net)
            ps.append({'id': k, 'costPaid': fl(cs[k]), 'entitlementShare': fl(es[k]), 'recovery': fl(rec), 'net': fl(net)})
        prow.append({'year': y['year'], 'cost': y['cost'], 'entitlement': y['entitlement'], 'carriedCost': fl(owed[i]), 'parties': ps})
    reasons = [t for r in rows for t in r['reasons']]
    if out_bal > 0:
        reasons.append(f'{years[-1]["year"]}: {money(out_bal)} of the carry is not recovered by the last year')
    keys = ['year', 'opening', 'uplift', 'added', 'due', 'share', 'available', 'recovered', 'closing', 'writtenOff', 'debtorReceives']
    nv = [{'id': k, 'npv': fl(npv_exact(flows[k], a['discountRate'], a['baseYear'], years[0]['year']))} for k in pid] if want_npv else None
    return {'carried': cid, 'carriedPct': c['carriedPct'], 'carriedInterestPct': fl(ci['moved']),
            'carriers': [{'id': k, 'sharePct': fl(s * 100)} for k, s in ci['weights']],
            'ledger': [fl_row(r, keys) for r in rows], 'parties': prow,
            'totals': {'carriedCost': fl(sum(owed, F(0))), 'uplift': fl(sum((r['uplift'] for r in rows), F(0))), 'recovered': fl(got),
                       'writtenOff': fl(sum((r['writtenOff'] for r in rows), F(0))), 'outstanding': fl(out_bal)},
            'recoveredInYear': payout, 'npv': nv, 'reasons': reasons}


def back_in(a):
    parties = g(a, 'parties')
    check_parties(parties)
    pid = [p['id'] for p in parties]
    bip = g(a, 'backInParty')
    one_of('backInParty', bip, pid)
    basis = g(a, 'basis')
    one_of('basis', basis, ['pia-s85-4', 'contract'])
    costs = g(a, 'costs')
    list_of('costs', costs, CAPS['items'])
    cur = next(p['participatingPct'] for p in parties if p['id'] == bip)
    tgt = g(a, 'targetPct')
    pct_pos('targetPct', tgt)
    if not tgt > cur:
        must('targetPct', f"above the back-in party's current interest {js(cur)}", tgt)
    if not tgt < 100:
        must('targetPct', 'below 100 (the other parties keep an interest)', tgt)
    if basis == 'pia-s85-4' and tgt > PIA_MAX_PARTICIPATION:
        must('targetPct', 'at most 60 under basis "pia-s85-4" (the right to participate up to 60%, PIA s.85(4)(a))', tgt)
    rk = g(a, 'refundableKinds')
    if basis == 'pia-s85-4':
        if rk is not MISSING:
            must('refundableKinds', 'left out under basis "pia-s85-4" (development and production, s.85(4)(c))', rk)
        kinds = PIA_REFUNDABLE
    else:
        if not isinstance(rk, list) or not rk:
            must('refundableKinds', 'an array of cost kinds stated under basis "contract" (' + ', '.join(COST_KINDS) + '; no default)', rk)
        for i, k in enumerate(rk):
            one_of(f'refundableKinds[{i}]', k, COST_KINDS)
        kinds = rk
    for i, c in enumerate(costs):
        text(f'costs[{i}].item', g(c, 'item'))
        non_neg(f'costs[{i}].amount', g(c, 'amount'))
        one_of(f'costs[{i}].kind', g(c, 'kind'), COST_KINDS)
    form = g(a, 'refundForm')
    one_of('refundForm', form, ['upfront', 'from-future-entitlement'])
    if basis == 'pia-s85-4' and form == 'upfront':
        must('refundForm', '"from-future-entitlement" under basis "pia-s85-4": no upfront payment by the Government (s.85(4)(d)); the refund is in cash or in kind from future production or entitlements (s.85(4)(f))', form)
    rf, years = g(a, 'recoverFromPct'), g(a, 'years')
    if form == 'from-future-entitlement':
        pct_pos('recoverFromPct', rf)
        check_years(years, ['entitlement'])
    else:
        if rf is not MISSING:
            must('recoverFromPct', 'left out when refundForm is "upfront"', rf)
        if years is not MISSING:
            must('years', 'left out when refundForm is "upfront"', years)
    lines = [{'item': c['item'], 'amount': c['amount'], 'kind': c['kind'], 'refundable': c['kind'] in kinds} for c in costs]
    refundable = sum((F(l['amount']) for l in lines if l['refundable']), F(0))
    excl = sum((F(l['amount']) for l in lines if not l['refundable']), F(0))
    reasons = []
    for l in lines:
        if not l['refundable'] and l['amount'] > 0:
            why = ' (PIA s.85(4)(c): development and production costs only, no bonuses, penalties, interest, premium or markups)' if basis == 'pia-s85-4' else ' (not a stated refundable kind)'
            reasons.append(f'{l["item"]}: {money(l["amount"])} ({l["kind"]}) is not refundable{why}')
    step, rest = F(tgt) - F(cur), 100 - F(cur)
    refund = step * refundable / 100
    rows = []
    for p in parties:
        me = p['id'] == bip
        pp = F(p['participatingPct'])
        rows.append({'id': p['id'], 'before': p['participatingPct'], 'after': tgt if me else fl(pp * (100 - F(tgt)) / rest),
                     'ceded': 0 if me else fl(pp * step / rest), 'refundReceived': 0 if me else fl(refund * pp / rest), 'refundPaid': fl(refund) if me else 0})
    head = f'{bip} backs in from {js(cur)}% to {js(tgt)}%: the others keep {js(100 - F(tgt))} / {js(100 - F(cur))} of their interests; refund {js(step)}% x refundable costs {money(refundable)} = {money(refund)}'
    if excl > 0:
        head += f' ({money(excl)} excluded)'
    reasons.insert(0, head)
    rec = None
    if form == 'from-future-entitlement':
        owed = [refund if i == 0 else F(0) for i in range(len(years))]
        lr, got, bal, payout = ledger(years, owed, tgt, rf, {'type': 'none'}, None, 'refund', 'back-in party')
        second = payout_cumulative(years, refund, F(tgt) * F(rf) / 100)
        if second != payout:
            sys.exit(f'back-in payout roads disagree: {second} vs {payout}')
        keys = ['year', 'opening', 'uplift', 'added', 'due', 'share', 'available', 'recovered', 'closing', 'writtenOff', 'debtorReceives']
        rec = {'ledger': [fl_row(r, keys) for r in lr], 'recovered': fl(got), 'outstanding': fl(bal), 'recoveredInYear': payout,
               'toParties': [{'year': r['year'], 'parties': [{'id': p['id'], 'amount': fl(r['recovered'] * F(p['participatingPct']) / rest)} for p in parties if p['id'] != bip]} for r in lr]}
        reasons += [t for r in lr for t in r['reasons']]
        if bal > 0:
            reasons.append(f'{years[-1]["year"]}: {money(bal)} of the refund is not recovered by the last year')
    return {'backInParty': bip, 'currentPct': cur, 'targetPct': tgt, 'parties': rows, 'costs': lines, 'refundable': fl(refundable), 'excluded': fl(excl),
            'refund': fl(refund), 'refundForm': form, 'recovery': rec, 'reasons': reasons}


def non_consent(a):
    parties = g(a, 'parties')
    check_parties(parties)
    pid = [p['id'] for p in parties]
    cons = g(a, 'consenting')
    if not isinstance(cons, list) or not cons:
        must('consenting', 'an array of the ids of the consenting parties, at least one', cons)
    for i, k in enumerate(cons):
        if k not in pid:
            must(f'consenting[{i}]', 'the id of a party (' + ', '.join(pid) + ')', k)
        if cons.index(k) != i:
            must(f'consenting[{i}]', 'an id not already listed', k)
    if len(cons) == len(pid):
        must('consenting', 'leaving at least one non-consenting party (every party consents: a joint operation)', cons)
    op = g(a, 'operation')
    if not isobj(op):
        must('operation', 'an object { name, cost }', op)
    text('operation.name', g(op, 'name'))
    positive('operation.cost', g(op, 'cost'))
    mult = g(a, 'premiumMultiplePct')
    if not (isnum(mult) and mult >= 100):
        must('premiumMultiplePct', 'a number at or above 100 (a stated contract figure; 100 recovers the cost alone)', mult)
    mode = g(a, 'mode')
    one_of('mode', mode, ['recover-from-production', 'buy-in'])
    years = g(a, 'years')
    if mode == 'recover-from-production':
        check_years(years, ['grossValue', 'deductions'])
    elif years is not MISSING:
        must('years', 'left out when mode is "buy-in"', years)
    cp = [p for p in parties if p['id'] in cons]
    ncp = [p for p in parties if p['id'] not in cons]
    ct = sum(F(p['participatingPct']) for p in cp)
    cost = F(op['cost'])
    shares = [{'id': p['id'], 'participatingPct': p['participatingPct'], 'projectPct': fl(F(p['participatingPct']) * 100 / ct), 'cost': fl(cost * F(p['participatingPct']) / ct)} for p in cp]
    reasons = [f'{op["name"]}: cost {money(cost)} paid by the consenting parties ' + ', '.join(f'{s["id"]} {js(s["projectPct"])}%' for s in shares) + ' (in proportion to their participating interests)']
    ncr = []
    for p in ncp:
        own_share = cost * F(p['participatingPct']) / 100
        ncr.append({'id': p['id'], 'participatingPct': p['participatingPct'], 'costShare': fl(own_share), 'premium': fl(own_share * F(mult) / 100), '_p': own_share * F(mult) / 100, '_s': own_share})
    res = {'operation': {'name': op['name'], 'cost': op['cost']}, 'mode': mode, 'premiumMultiplePct': mult, 'consenting': shares}
    if mode == 'buy-in':
        pay = []
        for r in ncr:
            pay.append({'id': r['id'], 'payment': fl(r['_p']), 'toParties': [{'id': p['id'], 'amount': fl(r['_p'] * F(p['participatingPct']) / ct)} for p in cp]})
            reasons.append(f'{r["id"]}: to enter it pays {js(mult)}% of its share {money(r["_s"])} = {money(r["_p"])}, apportioned to the consenting parties in their shares')
        for r in ncr:
            del r['_p'], r['_s']
        res.update({'nonConsenting': ncr, 'buyIn': pay, 'recovery': None, 'reasons': reasons})
        return res
    net = [{'year': y['year'], 'entitlement': max(F(0), F(y['grossValue']) - F(y['deductions']))} for y in years]
    recs = []
    for r in ncr:
        owed = [r['_p'] if i == 0 else F(0) for i in range(len(years))]
        lr, got, bal, payout = ledger(net, owed, r['participatingPct'], 100, {'type': 'none'}, None, 'premium', 'non-consenting party')
        second = payout_cumulative(net, r['_p'], r['participatingPct'])
        if second != payout:
            sys.exit(f'non-consent payout roads disagree: {second} vs {payout}')
        for row in lr:
            for t in row['reasons']:
                reasons.append(f'{r["id"]} {t}')
        if bal > 0:
            reasons.append(f'{r["id"]} {years[-1]["year"]}: {money(bal)} of the premium is not recovered by the last year')
        recs.append({'id': r['id'], 'premium': fl(r['_p']),
                     'ledger': [{'year': x['year'], 'opening': fl(x['opening']), 'due': fl(x['due']), 'share': fl(x['share']), 'recovered': fl(x['recovered']),
                                 'closing': fl(x['closing']), 'nonConsentingReceives': fl(x['debtorReceives'])} for x in lr],
                     'recovered': fl(got), 'outstanding': fl(bal), 'revertsInYear': payout,
                     'toParties': [{'year': x['year'], 'parties': [{'id': p['id'], 'amount': fl(x['recovered'] * F(p['participatingPct']) / ct)} for p in cp]} for x in lr]})
    for y in years:
        if y['grossValue'] < y['deductions']:
            reasons.append(f'{y["year"]}: deductions {money(y["deductions"])} exceed the gross value {money(y["grossValue"])}: no net value, nothing recovered')
    for r in ncr:
        del r['_p'], r['_s']
    res.update({'nonConsenting': ncr, 'buyIn': None, 'recovery': recs, 'reasons': reasons})
    return res


# --------------------------------------------------------------------- PSC
def psc(a):
    years = g(a, 'years')
    check_years(years, ['grossRevenue', 'capex', 'opex'])
    roy = g(a, 'royaltyPct')
    if not (isnum(roy) and 0 <= roy < 100):
        must('royaltyPct', 'a number from 0 up to, but excluding, 100', roy)
    lim = g(a, 'costOilLimitPct')
    pct('costOilLimitPct', lim)
    base = g(a, 'costOilLimitBase')
    one_of('costOilLimitBase', base, ['after-royalty', 'gross'])
    share = g(a, 'contractorProfitSharePct')
    pct('contractorProfitSharePct', share)
    tax = g(a, 'taxRatePct')
    pct('taxRatePct', tax)
    pool0 = g(a, 'openingCostPool')
    non_neg('openingCostPool', pool0)
    parties = g(a, 'parties')
    if parties is not MISSING:
        check_parties(parties)
    want_npv = check_npv(g(a, 'discountRate'), g(a, 'baseYear'))
    for i, y in enumerate(years):
        if g(y, 'contractorProfitSharePct') is not MISSING:
            pct(f'years[{i}].contractorProfitSharePct', y['contractorProfitSharePct'])
    if base == 'gross' and lim > 100 - roy:
        must('costOilLimitPct', f'at or below the revenue left after royalty, {js(100 - F(roy))}% of gross, when costOilLimitBase is "gross"', lim)
    pool = F(pool0)
    rows, reasons = [], []
    T = {}
    for y in years:
        sh = y.get('contractorProfitSharePct', share)
        sh = share if sh is None else sh
        gross = F(y['grossRevenue'])
        royalty = gross * F(roy) / 100
        net = gross - royalty
        limit = gross * F(lim) / 100 if base == 'gross' else net * F(lim) / 100
        recoverable = pool + F(y['capex']) + F(y['opex'])
        cost_oil = min(recoverable, limit)
        pool_out = recoverable - cost_oil
        profit = net - cost_oil
        c_profit = profit * F(sh) / 100
        g_profit = profit - c_profit
        t = max(F(0), c_profit * F(tax) / 100)
        ent = cost_oil + c_profit - t
        if recoverable > limit:
            reasons.append(f'{y["year"]}: recoverable {money(recoverable)} is above the cost oil limit {money(limit)}; {money(pool_out)} carried to {y["year"] + 1}')
        row = {'year': y['year'], 'contractorProfitSharePct': sh, 'grossRevenue': y['grossRevenue'], 'royalty': royalty, 'revenueAfterRoyalty': net, 'poolIn': pool,
               'capex': y['capex'], 'opex': y['opex'], 'costOilLimit': limit, 'costRecovered': cost_oil, 'poolOut': pool_out, 'profitOil': profit,
               'contractorProfitOil': c_profit, 'governmentProfitOil': g_profit, 'tax': t, 'contractorEntitlement': ent,
               'contractorNet': ent - F(y['capex']) - F(y['opex']), 'governmentTake': royalty + g_profit + t}
        for k in ('grossRevenue', 'royalty', 'costRecovered', 'profitOil', 'contractorProfitOil', 'governmentProfitOil', 'tax', 'contractorEntitlement', 'contractorNet', 'governmentTake'):
            T[k] = T.get(k, F(0)) + F(row[k])
        rows.append(row)
        pool = pool_out
    prow, nv = None, None
    if parties is not MISSING:
        pp = {p['id']: F(p['participatingPct']) for p in parties}
        flows = {k: [] for k in pp}
        prow = []
        for r in rows:
            e = split(r['contractorEntitlement'], pp)
            c = split(F(r['capex']) + F(r['opex']), pp)
            ps = []
            for k in pp:
                flows[k].append(e[k] - c[k])
                ps.append({'id': k, 'entitlement': fl(e[k]), 'cost': fl(c[k]), 'net': fl(e[k] - c[k])})
            prow.append({'year': r['year'], 'parties': ps})
        if want_npv:
            nv = [{'id': k, 'npv': fl(npv_exact(flows[k], a['discountRate'], a['baseYear'], years[0]['year']))} for k in pp]
    out_rows = [{k: fl(v) if isinstance(v, F) else v for k, v in r.items()} for r in rows]
    return {'years': out_rows, 'totals': {k: fl(v) for k, v in T.items()}, 'unrecoveredAtEnd': fl(pool), 'parties': prow, 'npv': nv, 'reasons': reasons}


FNS = {
    'participatingInterests': interests, 'cashCalls': cash_calls, 'budgetControl': budget, 'overhead': overhead,
    'defaultCover': default_cover, 'carryRecovery': carry, 'backIn': back_in, 'nonConsent': non_consent, 'pscCostRecovery': psc,
}


def run(fn, args):
    try:
        if not isobj(args):
            must('options', 'an object of named inputs', args)
        check_keys(args, SHAPES[fn], '')
        return FNS[fn](args)
    except Refusal as r:
        return {'error': True, 'field': r.field, 'message': r.message}


CASES = []


def case(cid, fn, args, tol=1e-12, **extra):
    args = json.loads(json.dumps(args))
    exp = run(fn, json.loads(json.dumps(args)))
    c = {'id': cid, 'fn': fn, 'args': args, 'tol': tol, 'expected': exp}
    c.update(extra)
    CASES.append(c)
    return exp


def refused(cid, fn, args, field):
    exp = case(cid, fn, args)
    if not (isinstance(exp, dict) and exp.get('error') is True):
        sys.exit(f'{cid}: expected a refusal on {field}, got a result')
    if exp['field'] != field:
        sys.exit(f'{cid}: refused on {exp["field"]}, expected {field}: {exp["message"]}')


# ------------------------------------------------------------------- cases
def build():
    fx = json.load(open(FIX))
    P, C = fx['parties'], fx['carries']
    P2 = [{'id': 'A', 'participatingPct': 50}, {'id': 'B', 'participatingPct': 30}, {'id': 'C', 'participatingPct': 20}]

    # interests
    case('int-ekene', 'participatingInterests', {'parties': P, 'carries': C})
    case('int-ekene-no-carry', 'participatingInterests', {'parties': P})
    case('int-half-carry-stated', 'participatingInterests', {'parties': P, 'carries': [{'carried': 'NOC', 'carriedPct': 50, 'carriers': {'EKO': 75, 'PA': 25}}]})
    case('int-two-carries', 'participatingInterests', {'parties': P, 'carries': [{'carried': 'NOC', 'carriedPct': 100, 'carriers': 'pro-rata'}, {'carried': 'PB', 'carriedPct': 100, 'carriers': {'EKO': 50, 'PA': 50}}]})
    refused('int-refuse-sum', 'participatingInterests', {'parties': [{'id': 'A', 'participatingPct': 60}, {'id': 'B', 'participatingPct': 30}]}, 'parties')
    refused('int-refuse-dup-id', 'participatingInterests', {'parties': [{'id': 'A', 'participatingPct': 50}, {'id': 'A', 'participatingPct': 50}]}, 'parties[1].id')
    refused('int-refuse-zero-pct', 'participatingInterests', {'parties': [{'id': 'A', 'participatingPct': 0}, {'id': 'B', 'participatingPct': 100}]}, 'parties[0].participatingPct')
    refused('int-refuse-carried-unknown', 'participatingInterests', {'parties': P, 'carries': [{'carried': 'XYZ', 'carriedPct': 100, 'carriers': 'pro-rata'}]}, 'carries[0].carried')
    refused('int-refuse-carriers-missing', 'participatingInterests', {'parties': P, 'carries': [{'carried': 'NOC', 'carriedPct': 100}]}, 'carries[0].carriers')
    refused('int-refuse-carriers-sum', 'participatingInterests', {'parties': P, 'carries': [{'carried': 'NOC', 'carriedPct': 100, 'carriers': {'EKO': 60, 'PA': 30}}]}, 'carries[0].carriers')
    refused('int-refuse-carrier-carried', 'participatingInterests', {'parties': P, 'carries': [{'carried': 'NOC', 'carriedPct': 100, 'carriers': 'pro-rata'}, {'carried': 'PB', 'carriedPct': 100, 'carriers': {'NOC': 100}}]}, 'carries[1].carriers.NOC')
    refused('int-refuse-carried-pct', 'participatingInterests', {'parties': P, 'carries': [{'carried': 'NOC', 'carriedPct': 0, 'carriers': 'pro-rata'}]}, 'carries[0].carriedPct')
    refused('int-refuse-all-carried', 'participatingInterests', {'parties': P2[:1] + [{'id': 'B', 'participatingPct': 50}], 'carries': [{'carried': 'A', 'carriedPct': 100, 'carriers': 'pro-rata'}, {'carried': 'B', 'carriedPct': 100, 'carriers': 'pro-rata'}]}, 'carries')
    refused('int-refuse-unknown-key', 'participatingInterests', {'parties': P, 'carry': C}, 'carry')
    refused('int-refuse-unknown-party-key', 'participatingInterests', {'parties': [{'id': 'A', 'participatingPct': 100, 'wi': 1}]}, 'parties[0].wi')

    # cash calls
    cc = fx['cashCalls']
    base = {'parties': P, 'carries': C, 'months': cc['months'], 'reconciliationLagMonths': cc['reconciliationLagMonths'], 'negativeCall': cc['negativeCall'], 'noCallBelow': cc['noCallBelow']}
    case('cc-ekene-2027', 'cashCalls', base)
    case('cc-ekene-2027-refund', 'cashCalls', dict(base, negativeCall='refund'))
    case('cc-ekene-2027-lag1', 'cashCalls', dict(base, reconciliationLagMonths=1))
    b2 = {k: v for k, v in base.items() if k != 'noCallBelow'}
    case('cc-ekene-2027-every-month', 'cashCalls', b2)
    m3 = [{'month': '2027-01', 'forecast': 1000, 'actual': 800}, {'month': '2027-02', 'forecast': 0, 'actual': 0}, {'month': '2027-03', 'forecast': 400, 'actual': 400}]
    case('cc-zero-call-month', 'cashCalls', {'parties': P2, 'months': m3, 'reconciliationLagMonths': 1, 'negativeCall': 'carry'})
    case('cc-zero-call-month-refund', 'cashCalls', {'parties': P2, 'months': m3, 'reconciliationLagMonths': 1, 'negativeCall': 'refund'})
    case('cc-threshold-exactly', 'cashCalls', {'parties': P2, 'months': [{'month': '2027-01', 'forecast': 500, 'actual': 500}, {'month': '2027-02', 'forecast': 499, 'actual': 499}], 'reconciliationLagMonths': 1, 'negativeCall': 'carry', 'noCallBelow': 500})
    case('cc-last-month-uncalled', 'cashCalls', {'parties': P2, 'months': [{'month': '2027-11', 'forecast': 1000, 'actual': 1100}, {'month': '2027-12', 'forecast': 100, 'actual': 120}], 'reconciliationLagMonths': 2, 'negativeCall': 'carry', 'noCallBelow': 500})
    case('cc-year-boundary', 'cashCalls', {'parties': P2, 'months': [{'month': '2026-12', 'forecast': 1000, 'actual': 900}, {'month': '2027-01', 'forecast': 1000, 'actual': 1000}], 'reconciliationLagMonths': 1, 'negativeCall': 'carry'})
    refused('cc-refuse-gap', 'cashCalls', {'parties': P2, 'months': [{'month': '2027-01', 'forecast': 1, 'actual': 1}, {'month': '2027-03', 'forecast': 1, 'actual': 1}], 'reconciliationLagMonths': 1, 'negativeCall': 'carry'}, 'months[1].month')
    refused('cc-refuse-lag0', 'cashCalls', dict(base, reconciliationLagMonths=0), 'reconciliationLagMonths')
    refused('cc-refuse-no-lag', 'cashCalls', {k: v for k, v in base.items() if k != 'reconciliationLagMonths'}, 'reconciliationLagMonths')
    refused('cc-refuse-negative-call', 'cashCalls', dict(base, negativeCall='net'), 'negativeCall')
    refused('cc-refuse-negative-actual', 'cashCalls', {'parties': P2, 'months': [{'month': '2027-01', 'forecast': 1, 'actual': -1}], 'reconciliationLagMonths': 1, 'negativeCall': 'carry'}, 'months[0].actual')
    refused('cc-refuse-month-format', 'cashCalls', {'parties': P2, 'months': [{'month': '2027-1', 'forecast': 1, 'actual': 1}], 'reconciliationLagMonths': 1, 'negativeCall': 'carry'}, 'months[0].month')
    refused('cc-refuse-unknown-key', 'cashCalls', dict(base, lag=2), 'lag')
    refused('cc-refuse-unknown-month-key', 'cashCalls', {'parties': P2, 'months': [{'month': '2027-01', 'forecast': 1, 'actual': 1, 'budget': 2}], 'reconciliationLagMonths': 1, 'negativeCall': 'carry'}, 'months[0].budget')

    # budget
    bu = fx['budget']
    bb = {'items': bu['items'], 'itemTolerancePct': bu['itemTolerancePct'], 'budgetTolerance': bu['budgetTolerance'], 'unbudgetedAllowance': bu['unbudgetedAllowance']}
    case('budget-ekene-2027', 'budgetControl', bb)
    case('budget-ekene-no-allowance', 'budgetControl', {k: v for k, v in bb.items() if k != 'unbudgetedAllowance'})
    case('budget-ekene-allowance-short', 'budgetControl', dict(bb, unbudgetedAllowance=249_999))
    case('budget-item-at-tolerance', 'budgetControl', {'items': [{'item': 'x', 'approved': 50, 'actual': 55}], 'itemTolerancePct': 10, 'budgetTolerance': {'pct': 10}})
    case('budget-item-one-over', 'budgetControl', {'items': [{'item': 'x', 'approved': 50, 'actual': 55.5}], 'itemTolerancePct': 10, 'budgetTolerance': {'pct': 10}})
    case('budget-norway-lower-of', 'budgetControl', {'items': [{'item': 'investment budget', 'approved': 2000, 'actual': 2080}], 'itemTolerancePct': 10, 'budgetTolerance': {'pct': 5, 'amount': 75}},
         note='Norway JOA Art. 12.5 in NOK million: the lower of 5% of 2,000 (100) and 75 is 75; an overrun of 80 is beyond')
    case('budget-norway-pct-holds', 'budgetControl', {'items': [{'item': 'exploration budget', 'approved': 1000, 'actual': 1050}], 'itemTolerancePct': 10, 'budgetTolerance': {'pct': 5, 'amount': 75}},
         note='Norway JOA Art. 12.5 in NOK million: the lower of 5% of 1,000 (50) and 75 is 50; an overrun of exactly 50 is inside')
    case('budget-underrun', 'budgetControl', {'items': [{'item': 'x', 'approved': 100, 'actual': 90}], 'itemTolerancePct': 10, 'budgetTolerance': {'pct': 5}})
    refused('budget-refuse-no-tolerance', 'budgetControl', {'items': bu['items'], 'itemTolerancePct': 10}, 'budgetTolerance')
    refused('budget-refuse-dup-item', 'budgetControl', {'items': [{'item': 'x', 'approved': 1, 'actual': 1}, {'item': 'x', 'approved': 1, 'actual': 1}], 'itemTolerancePct': 10, 'budgetTolerance': {'pct': 5}}, 'items[1].item')
    refused('budget-refuse-item-tol', 'budgetControl', {'items': bu['items'], 'budgetTolerance': {'pct': 5}}, 'itemTolerancePct')
    refused('budget-refuse-unknown-key', 'budgetControl', dict(bb, budgetTolerance={'pct': 5, 'amt': 3}), 'budgetTolerance.amt')

    # overhead
    oh = fx['overhead']
    case('overhead-ekene-2031', 'overhead', {'costs': oh['costs'], 'excluded': oh['excluded'], 'scale': oh['scale']})
    tot = sum(oh['costs'].values())
    case('overhead-ekene-2031-corporate', 'overhead', {'costs': {'exploration, operating and development': tot}, 'scale': {'exploration, operating and development': {'bands': [], 'abovePct': oh['corporatePct']}}})
    nos = {'bands': [{'upTo': 1000, 'pct': 2.7}, {'upTo': 2500, 'pct': 1}], 'abovePct': 0}
    nds = {'bands': [{'upTo': 1000, 'pct': 2.5}, {'upTo': 2000, 'pct': 1}, {'upTo': 3500, 'pct': 0.5}], 'abovePct': 0}
    nes = {'bands': [{'upTo': 300, 'pct': 2.5}], 'abovePct': 0}
    note = 'Norway Accounting Agreement Art. 2.2.2 scale in NOK million (the printed bands and rates; nothing is printed above the last band, stated here as 0)'
    case('overhead-norway-operating-1800', 'overhead', {'costs': {'operating': 1800}, 'scale': {'operating': nos}}, note=note)
    case('overhead-norway-development-3000', 'overhead', {'costs': {'development': 3000}, 'scale': {'development': nds}}, note=note)
    case('overhead-norway-development-4000', 'overhead', {'costs': {'development': 4000}, 'scale': {'development': nds}}, note=note)
    case('overhead-norway-exploration-250', 'overhead', {'costs': {'exploration': 250}, 'scale': {'exploration': nes}}, note=note)
    case('overhead-norway-all-with-exclusion', 'overhead', {'costs': {'exploration': 400, 'operating': 1000, 'development': 2000}, 'excluded': {'operating': 150}, 'scale': {'exploration': nes, 'operating': nos, 'development': nds}}, note=note + '; 150 of area fees and CO2 duty excluded from the operating base')
    case('overhead-norway-corporate-065', 'overhead', {'costs': {'exploration, operation and development': 3400}, 'scale': {'exploration, operation and development': {'bands': [], 'abovePct': 0.65}}},
         note='Norway Accounting Agreement Art. 2.2.3: 0.65 % of the annual costs for exploration, operation and development')
    case('overhead-band-edge-exact', 'overhead', {'costs': {'operating': 1000}, 'scale': {'operating': nos}})
    case('overhead-zero-cost', 'overhead', {'costs': {'operating': 0}, 'scale': {'operating': nos}})
    refused('overhead-refuse-no-scale', 'overhead', {'costs': {'operating': 1}, 'scale': {}}, 'scale.operating')
    refused('overhead-refuse-band-order', 'overhead', {'costs': {'operating': 1}, 'scale': {'operating': {'bands': [{'upTo': 100, 'pct': 1}, {'upTo': 100, 'pct': 1}], 'abovePct': 0}}}, 'scale.operating.bands[1].upTo')
    refused('overhead-refuse-exclusion', 'overhead', {'costs': {'operating': 10}, 'excluded': {'operating': 11}, 'scale': {'operating': nos}}, 'excluded.operating')
    refused('overhead-refuse-exclusion-category', 'overhead', {'costs': {'operating': 10}, 'excluded': {'drilling': 1}, 'scale': {'operating': nos}}, 'excluded.drilling')
    refused('overhead-refuse-scale-category', 'overhead', {'costs': {'operating': 10}, 'scale': {'operating': nos, 'drilling': nos}}, 'scale.drilling')
    refused('overhead-refuse-above', 'overhead', {'costs': {'operating': 10}, 'scale': {'operating': {'bands': []}}}, 'scale.operating.abovePct')
    refused('overhead-refuse-scale-key', 'overhead', {'costs': {'operating': 10}, 'scale': {'operating': {'bands': [], 'abovePct': 1, 'flat': 1}}}, 'scale.operating.flat')
    refused('overhead-refuse-band-key', 'overhead', {'costs': {'operating': 10}, 'scale': {'operating': {'bands': [{'upTo': 5, 'rate': 1}], 'abovePct': 1}}}, 'scale.operating.bands[0].rate')
    refused('overhead-refuse-unknown-key', 'overhead', {'costs': {'operating': 10}, 'scale': {'operating': nos}, 'rate': 2}, 'rate')

    # default
    d = fx['default']
    dbase = {'parties': P, 'carries': C, 'callTotal': d['callTotal'], 'dueDate': d['dueDate'], 'asOf': d['asOf'], 'defaulters': d['defaulters'], 'interest': d['interest'], 'suspension': d['suspension'], 'forfeiture': d['forfeiture']}
    case('default-ekene-march', 'defaultCover', dbase)
    case('default-ekene-uncured', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 250_000}], asOf='2027-07-01'))
    case('default-cured-on-trigger-day', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-03-08'}]))
    case('default-cured-day-after-trigger', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-03-09'}]))
    case('default-cured-on-due-date', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-03-01'}]))
    case('default-forfeiture-last-day', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 250_000}], asOf='2027-06-10'))
    case('default-forfeiture-day-after', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 250_000}], asOf='2027-06-11'))
    case('default-two-defaulters', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 0, 'curedOn': '2027-03-31'}, {'id': 'PA', 'paid': 750_000, 'curedOn': '2027-04-30'}]))
    case('default-no-carry-365', 'defaultCover', {'parties': P2, 'callTotal': 1_000_000, 'dueDate': '2027-01-15', 'asOf': '2027-03-01', 'defaulters': [{'id': 'C', 'paid': 0}], 'interest': {'annualRatePct': 7.3, 'dayBasis': 365, 'interestMethod': 'simple', 'graceHours': 0}})
    case('default-working-days-holiday', 'defaultCover', {'parties': P2, 'callTotal': 1_000_000, 'dueDate': '2027-12-22', 'asOf': '2028-01-05', 'defaulters': [{'id': 'C', 'paid': 0}], 'interest': {'annualRatePct': 0, 'dayBasis': 365, 'interestMethod': 'simple', 'graceHours': 0},
                                                          'suspension': {'after': 5, 'unit': 'working-days', 'from': '2027-12-22'}, 'holidays': ['2027-12-24', '2027-12-27', '2027-12-28', '2028-01-01']})
    case('default-months-end-of-month', 'defaultCover', {'parties': P2, 'callTotal': 1_000_000, 'dueDate': '2027-01-31', 'asOf': '2027-05-01', 'defaulters': [{'id': 'C', 'paid': 0}], 'interest': {'annualRatePct': 0, 'dayBasis': 365, 'interestMethod': 'simple', 'graceHours': 0},
                                                         'forfeiture': {'after': 3, 'unit': 'months', 'from': '2027-01-31'}})
    case('default-calendar-days', 'defaultCover', {'parties': P2, 'callTotal': 1_000_000, 'dueDate': '2027-01-01', 'asOf': '2027-04-01', 'defaulters': [{'id': 'C', 'paid': 0}], 'interest': {'annualRatePct': 0, 'dayBasis': 365, 'interestMethod': 'simple', 'graceHours': 0},
                                                   'forfeiture': {'after': 90, 'unit': 'calendar-days', 'from': '2027-01-01'}})
    KI = {'annualRatePct': 8.25, 'dayBasis': 360, 'interestMethod': 'monthly-compound', 'graceHours': 72}
    case('default-ekene-monthly-compound-kenya', 'defaultCover', dict(dbase, interest=KI),
         note='Kenya Model PSC 2015 Participation Agreement Art. 6.7: compounded monthly from the due date; a payment not received within seventy-two (72) hours accrues interest from the due date (rate and grace stated here)')
    case('default-monthly-compound-uncured', 'defaultCover', dict(dbase, interest=KI, defaulters=[{'id': 'PB', 'paid': 250_000}], asOf='2027-07-01'))
    case('default-monthly-compound-whole-months', 'defaultCover', dict(dbase, interest=dict(KI, graceHours=0), defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-05-01'}]))
    case('default-monthly-compound-month-end', 'defaultCover', {'parties': P2, 'callTotal': 1_000_000, 'dueDate': '2027-01-31', 'asOf': '2027-04-15', 'defaulters': [{'id': 'C', 'paid': 0}],
                                                               'interest': {'annualRatePct': 12, 'dayBasis': 365, 'interestMethod': 'monthly-compound', 'graceHours': 0}})
    case('default-grace-last-hour', 'defaultCover', dict(dbase, interest=dict(KI, interestMethod='simple'), defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-03-04'}]),
         note='72 hours after the due date (3 days): within the grace, no interest')
    case('default-grace-exceeded', 'defaultCover', dict(dbase, interest=dict(KI, interestMethod='simple'), defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-03-05'}]),
         note='96 hours: the grace is exceeded and interest runs from the due date (4 days)')
    case('default-grace-compound-exceeded', 'defaultCover', dict(dbase, interest=KI, defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-03-05'}]))
    case('default-grace-fractional-hours', 'defaultCover', dict(dbase, interest=dict(KI, interestMethod='simple', graceHours=71.5), defaulters=[{'id': 'PB', 'paid': 250_000, 'curedOn': '2027-03-04'}]))
    refused('default-refuse-no-method', 'defaultCover', dict(dbase, interest={'annualRatePct': 8, 'dayBasis': 360, 'graceHours': 0}), 'interest.interestMethod')
    refused('default-refuse-method', 'defaultCover', dict(dbase, interest={'annualRatePct': 8, 'dayBasis': 360, 'interestMethod': 'compound', 'graceHours': 0}), 'interest.interestMethod')
    refused('default-refuse-no-grace', 'defaultCover', dict(dbase, interest={'annualRatePct': 8, 'dayBasis': 360, 'interestMethod': 'simple'}), 'interest.graceHours')
    refused('default-refuse-negative-grace', 'defaultCover', dict(dbase, interest={'annualRatePct': 8, 'dayBasis': 360, 'interestMethod': 'simple', 'graceHours': -1}), 'interest.graceHours')
    refused('default-refuse-paid-in-full', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 2_250_000}]), 'defaulters[0].paid')
    refused('default-refuse-no-rate', 'defaultCover', dict(dbase, interest={'dayBasis': 360, 'interestMethod': 'simple', 'graceHours': 0}), 'interest.annualRatePct')
    refused('default-refuse-day-basis', 'defaultCover', dict(dbase, interest={'annualRatePct': 8, 'dayBasis': 366, 'interestMethod': 'simple', 'graceHours': 0}), 'interest.dayBasis')
    refused('default-refuse-no-interest', 'defaultCover', {k: v for k, v in dbase.items() if k != 'interest'}, 'interest')
    refused('default-refuse-cure-before-due', 'defaultCover', dict(dbase, defaulters=[{'id': 'PB', 'paid': 0, 'curedOn': '2027-02-28'}]), 'defaulters[0].curedOn')
    refused('default-refuse-asof-before-due', 'defaultCover', dict(dbase, asOf='2027-02-01'), 'asOf')
    refused('default-refuse-bad-date', 'defaultCover', dict(dbase, dueDate='2027-02-30'), 'dueDate')
    refused('default-refuse-all-default', 'defaultCover', dict(dbase, defaulters=[{'id': 'EKO', 'paid': 0}, {'id': 'PA', 'paid': 0}, {'id': 'PB', 'paid': 0}]), 'defaulters')
    refused('default-refuse-unit', 'defaultCover', dict(dbase, suspension={'after': 5, 'unit': 'business-days', 'from': '2027-03-01'}), 'suspension.unit')
    refused('default-refuse-unknown-key', 'defaultCover', dict(dbase, interest={'annualRatePct': 8, 'dayBasis': 360, 'interestMethod': 'simple', 'graceHours': 0, 'compounding': 'monthly'}), 'interest.compounding')

    # carry
    cy = fx['carry']
    cbase = {'parties': P, 'carries': C, 'carried': 'NOC', 'years': cy['years'], 'uplift': cy['uplift'], 'recoverFromPct': cy['recoverFromPct'], 'basis': 'contract', 'discountRate': cy['discountRate'], 'baseYear': cy['baseYear']}
    case('carry-ekene-compound', 'carryRecovery', cbase)
    case('carry-ekene-pia', 'carryRecovery', dict(cbase, uplift={'type': 'none'}, recoverFromPct=100, basis='pia-s85-4'))
    case('carry-ekene-multiple', 'carryRecovery', dict(cbase, uplift={'type': 'multiple', 'multiplePct': 150}))
    case('carry-ekene-capped', 'carryRecovery', dict(cbase, cap=25_000_000))
    case('carry-ekene-short-horizon', 'carryRecovery', dict(cbase, years=cy['years'][:5]))
    cyrs = [{'year': 2027, 'cost': 1000, 'entitlement': 0}, {'year': 2028, 'cost': 0, 'entitlement': 1000}, {'year': 2029, 'cost': 0, 'entitlement': 1000}]
    P3 = [{'id': 'A', 'participatingPct': 60}, {'id': 'B', 'participatingPct': 20}, {'id': 'N', 'participatingPct': 20}]
    C3 = [{'carried': 'N', 'carriedPct': 100, 'carriers': 'pro-rata'}]
    case('carry-recovered-exactly', 'carryRecovery', {'parties': P3, 'carries': C3, 'carried': 'N', 'years': cyrs, 'uplift': {'type': 'none'}, 'recoverFromPct': 100, 'basis': 'contract'})
    case('carry-one-short', 'carryRecovery', {'parties': P3, 'carries': C3, 'carried': 'N', 'years': [cyrs[0], {'year': 2028, 'cost': 0, 'entitlement': 999}, cyrs[2]], 'uplift': {'type': 'none'}, 'recoverFromPct': 100, 'basis': 'contract'})
    case('carry-cap-exactly-cost', 'carryRecovery', {'parties': P3, 'carries': C3, 'carried': 'N', 'years': cyrs, 'uplift': {'type': 'compound', 'ratePctPerYear': 10}, 'recoverFromPct': 100, 'basis': 'contract', 'cap': 200})
    case('carry-partial-stated', 'carryRecovery', {'parties': P3, 'carries': [{'carried': 'N', 'carriedPct': 50, 'carriers': {'A': 50, 'B': 50}}], 'carried': 'N', 'years': cyrs, 'uplift': {'type': 'compound', 'ratePctPerYear': 12.5}, 'recoverFromPct': 50, 'basis': 'contract'})
    case('carry-cost-while-recovering', 'carryRecovery', {'parties': P3, 'carries': C3, 'carried': 'N', 'years': [{'year': 2027, 'cost': 500, 'entitlement': 0}, {'year': 2028, 'cost': 500, 'entitlement': 250}, {'year': 2029, 'cost': 250, 'entitlement': 1000}], 'uplift': {'type': 'compound', 'ratePctPerYear': 25}, 'recoverFromPct': 100, 'basis': 'contract'})
    refused('carry-refuse-pia-uplift', 'carryRecovery', dict(cbase, basis='pia-s85-4'), 'uplift.type')
    refused('carry-refuse-no-uplift', 'carryRecovery', {k: v for k, v in cbase.items() if k != 'uplift'}, 'uplift')
    refused('carry-refuse-uplift-extra', 'carryRecovery', dict(cbase, uplift={'type': 'none', 'ratePctPerYear': 5}), 'uplift.ratePctPerYear')
    refused('carry-refuse-multiple-below', 'carryRecovery', dict(cbase, uplift={'type': 'multiple', 'multiplePct': 90}), 'uplift.multiplePct')
    refused('carry-refuse-not-carried', 'carryRecovery', dict(cbase, carried='PA'), 'carried')
    refused('carry-refuse-no-carries', 'carryRecovery', {k: v for k, v in cbase.items() if k != 'carries'}, 'carries')
    refused('carry-refuse-recover-from', 'carryRecovery', dict(cbase, recoverFromPct=0), 'recoverFromPct')
    refused('carry-refuse-basis', 'carryRecovery', {k: v for k, v in cbase.items() if k != 'basis'}, 'basis')
    refused('carry-refuse-npv-half', 'carryRecovery', {k: v for k, v in cbase.items() if k != 'baseYear'}, 'baseYear')
    refused('carry-refuse-year-gap', 'carryRecovery', dict(cbase, years=[cy['years'][0], cy['years'][2]]), 'years[1].year')
    refused('carry-refuse-unknown-key', 'carryRecovery', dict(cbase, uplift={'type': 'compound', 'rate': 8}), 'uplift.rate')

    # back-in
    bi = fx['backIn']
    bbase = {'parties': P, 'backInParty': 'NOC', 'targetPct': bi['targetPct'], 'costs': bi['costs'], 'basis': 'pia-s85-4', 'refundForm': 'from-future-entitlement', 'recoverFromPct': bi['recoverFromPct'], 'years': bi['years']}
    case('backin-ekene-pia', 'backIn', bbase)
    case('backin-ekene-contract-upfront', 'backIn', {'parties': P, 'backInParty': 'NOC', 'targetPct': bi['targetPct'], 'costs': bi['costs'], 'basis': 'contract', 'refundableKinds': ['exploration', 'development'], 'refundForm': 'upfront'})
    case('backin-pia-at-60', 'backIn', dict(bbase, targetPct=60))
    case('backin-recovered-on-last-year', 'backIn', {'parties': P3, 'backInParty': 'N', 'targetPct': 40, 'costs': [{'item': 'development', 'amount': 1000, 'kind': 'development'}], 'basis': 'pia-s85-4', 'refundForm': 'from-future-entitlement', 'recoverFromPct': 50,
                                                     'years': [{'year': 2030, 'entitlement': 500}, {'year': 2031, 'entitlement': 500}]})
    refused('backin-refuse-pia-61', 'backIn', dict(bbase, targetPct=61), 'targetPct')
    refused('backin-refuse-pia-upfront', 'backIn', {k: v for k, v in dict(bbase, refundForm='upfront').items() if k not in ('recoverFromPct', 'years')}, 'refundForm')
    refused('backin-refuse-pia-kinds', 'backIn', dict(bbase, refundableKinds=['exploration']), 'refundableKinds')
    refused('backin-refuse-contract-no-kinds', 'backIn', dict(bbase, basis='contract'), 'refundableKinds')
    refused('backin-refuse-target-below', 'backIn', dict(bbase, targetPct=20), 'targetPct')
    refused('backin-refuse-kind', 'backIn', dict(bbase, costs=[{'item': 'x', 'amount': 1, 'kind': 'appraisal'}]), 'costs[0].kind')
    refused('backin-refuse-upfront-years', 'backIn', {'parties': P, 'backInParty': 'NOC', 'targetPct': 40, 'costs': bi['costs'], 'basis': 'contract', 'refundableKinds': ['development'], 'refundForm': 'upfront', 'years': bi['years']}, 'years')
    refused('backin-refuse-unknown-key', 'backIn', dict(bbase, refund='kind'), 'refund')

    # non-consent
    nc = fx['nonConsent']
    nbase = {'parties': P, 'consenting': nc['consenting'], 'operation': nc['operation'], 'premiumMultiplePct': nc['premiumMultiplePct'], 'mode': 'recover-from-production', 'years': nc['years']}
    case('nc-ekene-sidetrack', 'nonConsent', nbase)
    case('nc-ekene-buy-in-norway-1000', 'nonConsent', {'parties': P, 'consenting': nc['consenting'], 'operation': nc['operation'], 'premiumMultiplePct': 1000, 'mode': 'buy-in'},
         note='Norway JOA Art. 18.12: one thousand (1000) % of the proportionate share of the costs, apportioned to the initial participants by their interest in the project')
    case('nc-premium-last-barrel', 'nonConsent', {'parties': P2, 'consenting': ['A', 'B'], 'operation': {'name': 'well', 'cost': 1000}, 'premiumMultiplePct': 300, 'mode': 'recover-from-production',
                                                  'years': [{'year': 2030, 'grossValue': 1000, 'deductions': 0}, {'year': 2031, 'grossValue': 2000, 'deductions': 0}, {'year': 2032, 'grossValue': 1000, 'deductions': 0}]})
    case('nc-premium-reverts-mid-year', 'nonConsent', {'parties': P2, 'consenting': ['A', 'B'], 'operation': {'name': 'well', 'cost': 1000}, 'premiumMultiplePct': 300, 'mode': 'recover-from-production',
                                                       'years': [{'year': 2030, 'grossValue': 1000, 'deductions': 0}, {'year': 2031, 'grossValue': 3000, 'deductions': 0}, {'year': 2032, 'grossValue': 1000, 'deductions': 0}]})
    case('nc-two-nonconsenting-deductions-exceed', 'nonConsent', {'parties': P2, 'consenting': ['A'], 'operation': {'name': 'well', 'cost': 1000}, 'premiumMultiplePct': 100, 'mode': 'recover-from-production',
                                                                  'years': [{'year': 2030, 'grossValue': 100, 'deductions': 150}, {'year': 2031, 'grossValue': 5000, 'deductions': 1000}]})
    refused('nc-refuse-all-consent', 'nonConsent', dict(nbase, consenting=['EKO', 'PA', 'PB', 'NOC']), 'consenting')
    refused('nc-refuse-multiple', 'nonConsent', dict(nbase, premiumMultiplePct=50), 'premiumMultiplePct')
    refused('nc-refuse-no-multiple', 'nonConsent', {k: v for k, v in nbase.items() if k != 'premiumMultiplePct'}, 'premiumMultiplePct')
    refused('nc-refuse-dup', 'nonConsent', dict(nbase, consenting=['EKO', 'EKO']), 'consenting[1]')
    refused('nc-refuse-buyin-years', 'nonConsent', dict(nbase, mode='buy-in'), 'years')
    refused('nc-refuse-mode', 'nonConsent', dict(nbase, mode='penalty'), 'mode')
    refused('nc-refuse-unknown-key', 'nonConsent', dict(nbase, operation={'name': 'x', 'cost': 1, 'date': '2031-01-01'}), 'operation.date')

    # PSC
    ps = fx['psc']
    pbase = {'years': ps['years'], 'royaltyPct': ps['royaltyPct'], 'costOilLimitPct': ps['costOilLimitPct'], 'costOilLimitBase': ps['costOilLimitBase'], 'contractorProfitSharePct': ps['contractorProfitSharePct'],
             'taxRatePct': ps['taxRatePct'], 'openingCostPool': ps['openingCostPool'], 'parties': P, 'discountRate': ps['discountRate'], 'baseYear': ps['baseYear']}
    case('psc-ekene', 'pscCostRecovery', pbase)
    case('psc-ekene-after-royalty', 'pscCostRecovery', dict(pbase, costOilLimitBase='after-royalty'))
    case('psc-wb-bn8-2007', 'pscCostRecovery', {'years': [{'year': 2007, 'grossRevenue': 100, 'capex': 25, 'opex': 0}], 'royaltyPct': 10, 'costOilLimitPct': 60, 'costOilLimitBase': 'gross',
                                                 'contractorProfitSharePct': 40, 'taxRatePct': 30, 'openingCostPool': 0},
         note='World Bank Petroleum Sector Briefing Note No. 8 (November 2007), the two-barrel illustration and Figure 2: royalty 10, cost oil 25 (limit 60% of gross = 60), profit oil 65 split 26 / 39, tax 7.8; contractor 43.2, government 56.8')
    case('psc-fari-figure-5', 'pscCostRecovery', {'years': [{'year': 2016, 'grossRevenue': 100, 'capex': 50, 'opex': 0}], 'royaltyPct': 0, 'costOilLimitPct': 50, 'costOilLimitBase': 'after-royalty',
                                                  'contractorProfitSharePct': 40, 'taxRatePct': 30, 'openingCostPool': 0},
         note='IMF TNM/16/01 (FARI, February 2016) Figure 5, one USD100 barrel under a PSC: cost oil 50, profit oil 30 government / 20 contractor, income tax 6; government 36')
    fari_years = [
        (1, 0, 250, 0), (2, 0, 0, 0), (3, 213, 105, 114), (4, 542, 108, 291), (5, 1659, 112, 889), (6, 1354, 115, 725),
        (7, 1105, 118, 592 + 68), (8, 902, 13, 483 + 56), (9, 736, 10, 394 + 47), (10, 600, 7, 322 + 40), (11, 490, 3, 262 + 37)]
    gov_share = {3: 40, 4: 44, 5: 58, 6: 54, 7: 51, 8: 48, 9: 45, 10: 44, 11: 42}
    fy = []
    for yr, rev, capx, opx in fari_years:
        row = {'year': 2000 + yr, 'grossRevenue': rev, 'capex': capx, 'opex': opx}
        if yr in gov_share:
            row['contractorProfitSharePct'] = 100 - gov_share[yr]
        fy.append(row)
    case('psc-fari-table-12', 'pscCostRecovery', {'years': fy, 'royaltyPct': 0, 'costOilLimitPct': 80, 'costOilLimitBase': 'after-royalty', 'contractorProfitSharePct': 60, 'taxRatePct': 0, 'openingCostPool': 0,
                                                  'parties': [{'id': 'contractor', 'participatingPct': 90}, {'id': 'SOC', 'participatingPct': 10}]},
         note='IMF TNM/16/01 (FARI, February 2016) Table 12 (PSC/DROP, USD million, years 1 to 11 as printed; exploration expensed and development depreciation as capex, operating and decommissioning as opex, net revenue with royalty 0, ceiling 80%) and Table 13 (the printed government share per year); SOC 10% from development. Printed figures are whole numbers of an unrounded model: the gate compares at the printed precision')
    refused('psc-refuse-gross-limit', 'pscCostRecovery', dict(pbase, costOilLimitPct=90), 'costOilLimitPct')
    refused('psc-refuse-royalty-100', 'pscCostRecovery', dict(pbase, royaltyPct=100), 'royaltyPct')
    refused('psc-refuse-base', 'pscCostRecovery', dict(pbase, costOilLimitBase='net'), 'costOilLimitBase')
    refused('psc-refuse-no-pool', 'pscCostRecovery', {k: v for k, v in pbase.items() if k != 'openingCostPool'}, 'openingCostPool')
    refused('psc-refuse-year-share', 'pscCostRecovery', dict(pbase, years=[dict(ps['years'][0], contractorProfitSharePct=120)]), 'years[0].contractorProfitSharePct')
    refused('psc-refuse-unknown-key', 'pscCostRecovery', dict(pbase, costRecoveryLimitPct=60), 'costRecoveryLimitPct')



def main():
    build()
    ids = [c['id'] for c in CASES]
    if len(set(ids)) != len(ids):
        sys.exit('duplicate case ids')
    doc = {
        'module': 'jointVenture',
        'generatedBy': 'tools/validation/economics/oracle_jointventure.py',
        'engine': 'engines/economics/jointVenture.js',
        'tolerance': {'absoluteFloor': 1e-9, 'note': 'relative tol per case (1e-12); absolute floor 1e-9 in the money unit'},
        'cases': CASES,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(doc, f, indent=1, ensure_ascii=True, allow_nan=False)
        f.write('\n')
    n_err = sum(1 for c in CASES if isinstance(c['expected'], dict) and c['expected'].get('error') is True)
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {len(CASES)} cases, {n_err} refusals')


if __name__ == '__main__':
    main()
