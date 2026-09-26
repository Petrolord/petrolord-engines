#!/usr/bin/env python3
"""Independent stdlib oracle for engines/economics/gasContract.js (Economics EC8).

    python3 tools/validation/economics/oracle_gascontract.py

Writes test-data/economics/goldens/gascontract_cases.json. Reads no
JavaScript. Every rule is coded here from the stated clause arithmetic of the
public texts (sources in FINDINGS-gasContract.md), by a different road:

  quantities     exact Fractions of the input doubles; a figure leaves the
                 oracle as the nearest double only at the end.
  daily balance  a per-day decision table (properly nominated, the gap, the
                 excuse, the seller's Shortfall Quantity, the buyer's).
  take or pay    a ledger of dated entries (deficiency year, last year,
                 quantity) walked year by year: make-up and carry-forward drawn
                 oldest first, expiry at the end of an entry's last year; the
                 Model GSA formulas (AdjACQ, TOPQ, BADQ, BDP, BASQ, MUA, CFA)
                 evaluated as written, with the stated readings.
  prices         window means as exact Fractions; the S-curve as three
                 straight lines through the kinks; the basket as the Article
                 15.1 sum; the 4-decimal rule on Decimal digits.
  Nigeria        PIA s.110, s.167, s.168 and the Fourth Schedule as exact
                 Fractions; the gas royalty rate re-derived from the Seventh
                 Schedule para 10(6) (5%, 2.5% in-country) without importing it.
  NPV            sum of c_t / (1 + r)^(t - base) as an exact Fraction.
Figures PRINTED inside a message are the double nearest the exact value
(js_num); the fixtures keep quantities whole, so the engine's doubles print
alike. The published figures (ECS Figure 51 and the 0.172 slope, HMRC OT05402,
the PIA Fourth Schedule and s.167 arithmetic, the reported 2025 and 2026
domestic prices) are carried beside the exact ones.
"""
import json
import math
import os
import sys
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FIX = os.path.join(ROOT, 'test-data', 'economics', 'ekene-gsa')
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'gascontract_cases.json')
MISSING = object()


# ------------------------------------------------------------------ formatting
def js_num(x):
    """JavaScript String(x) for a double: shortest round-trip digits, with
    JavaScript's switch to exponent form below 1e-6 and at or above 1e21."""
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
    if '.' in mant:
        ip, fp = mant.split('.')
    else:
        ip, fp = mant, ''
    digits = (ip + fp).lstrip('0')
    lead_zeros = len(ip + fp) - len((ip + fp).lstrip('0'))
    point = len(ip) + ex - lead_zeros
    digits = digits.rstrip('0') or '0'
    k = len(digits)
    n = point
    if k <= n <= 21:
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * (-n) + digits
    e = n - 1
    es = ('+' if e >= 0 else '-') + str(abs(e))
    if k == 1:
        return sign + digits + 'e' + es
    return sign + digits[0] + '.' + digits[1:] + 'e' + es


def js(v):
    return js_num(float(v))


def show(v):
    if v is MISSING:
        return 'nothing'
    if isnum(v):
        return js(v)
    if isinstance(v, str):
        return '"' + v + '"'
    return json.dumps(v, separators=(',', ':'))


def unit(x, one, many=None):
    many = many or one + 's'
    return f'{js(x)} {one if x == 1 else many}'


class Refusal(Exception):
    def __init__(self, field, message):
        super().__init__(field)
        self.field = field
        self.message = f'{field} {message}'


def refuse(field, message):
    raise Refusal(field, message)


def must(field, cond, v):
    refuse(field, f'must be {cond}; got {show(v)}')


def isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def isint(x):
    return isnum(x) and float(x).is_integer()


def isobj(x):
    return isinstance(x, dict)


def g(d, k):
    return d[k] if isobj(d) and k in d else MISSING


def fl(x):
    return float(x)


# ----------------------------------------------------------------- checkers
def non_neg(field, v):
    if not (isnum(v) and v >= 0):
        must(field, 'a finite number at or above 0', v)


def positive(field, v):
    if not (isnum(v) and v > 0):
        must(field, 'a finite number above 0', v)


def pct(field, v):
    if not (isnum(v) and 0 <= v <= 100):
        must(field, 'a number from 0 to 100', v)


def int_at_least(field, v, lo):
    if not (isint(v) and v >= lo):
        must(field, f'an integer at or above {lo}', v)


def one_of(field, v, opts):
    if v not in opts or not isinstance(v, str):
        must(field, 'one of ' + ', '.join(f'"{o}"' for o in opts), v)


def text(field, v):
    if not (isinstance(v, str) and v.strip() != ''):
        must(field, 'a non-empty string', v)


def list_of(field, v, cap):
    if not isinstance(v, list) or len(v) < 1:
        must(field, 'an array of at least 1 entry', v)
    if len(v) > cap:
        refuse(field, f'must have at most {cap} entries; got {len(v)}')
    for i, x in enumerate(v):
        if not isobj(x):
            must(f'{field}[{i}]', 'an object', x)


def is_month(s):
    return isinstance(s, str) and len(s) == 7 and s[4] == '-' and s[:4].isdigit() and s[5:].isdigit() and 1 <= int(s[5:]) <= 12


def is_day(s):
    if not (isinstance(s, str) and len(s) == 10 and s[4] == '-' and s[7] == '-' and s[:4].isdigit() and s[5:7].isdigit() and s[8:].isdigit()):
        return False
    return 1 <= int(s[5:7]) <= 12 and 1 <= int(s[8:]) <= 31


def mi(m):
    return int(m[:4]) * 12 + int(m[5:]) - 1


def mname(i):
    return f'{i // 12:04d}-{i % 12 + 1:02d}'


def leap(y):
    return (y % 4 == 0 and y % 100 != 0) or y % 400 == 0


# ---------------------------------------------------------- accepted keys
def OBJ(keys, **children):
    return ('obj', keys, children)


def LST(of):
    return ('list', of)


FORMULAS = {
    'fixed': OBJ(['type', 'price']),
    'escalated': OBJ(['type', 'basePrice', 'baseMonth', 'ratePctPerYear']),
    'oil-indexed': OBJ(['type', 'index', 'slope', 'constant', 'sCurve', 'floor', 'ceiling'], sCurve=OBJ(['lowKink', 'highKink', 'lowSlope', 'highSlope'])),
    'hub-indexed': OBJ(['type', 'index', 'multiplier', 'adder', 'floor', 'ceiling']),
    'basket': OBJ(['type', 'basePrice', 'weights', 'baseValues', 'indexFloors', 'indexCeilings']),
}
YEAR = OBJ(['year', 'acq', 'maintenance', 'forceMajeure', 'sellerShortfall', 'permittedReduction', 'taken', 'contractPrice', 'topPrice', 'makeUpPrice', 'shortfallPrice'])
TOPA = OBJ(['years', 'topPct', 'makeUp', 'carryForward'], years=LST(YEAR), makeUp=OBJ(['periodYears', 'order', 'endOfTerm']), carryForward=OBJ(['periodYears', 'base', 'capPct']))
SHAPES = {
    'toEnergy': OBJ(['quantity', 'quantityUnit', 'heatingValue', 'heatingValueUnit', 'heatingValueBasis', 'referenceConditions']),
    'contractQuantities': OBJ(['dcq', 'days', 'year', 'period', 'maxDcqPct', 'topPct'], period=OBJ(['start', 'end'])),
    'dailyBalance': OBJ(['dcq', 'maxDcqPct', 'deliveryTolerance', 'days'], days=LST(OBJ(['date', 'nominated', 'available', 'taken', 'forceMajeure', 'maintenance', 'buyerCaused']))),
    'takeOrPay': TOPA,
    'priceSeries': OBJ(['months', 'formula', 'from', 'to', 'averagingMonths', 'lagMonths', 'resetMonths', 'rounding', 'reopeners'], months=LST(OBJ(['month', 'values'])), formula=('formula',)),
    'energyParitySlope': OBJ(['mmbtuPerBarrel']),
    'domesticPrice': OBJ(['sector', 'domesticBasePrice', 'negotiatedPrice', 'product', 'cmpp', 'transportTariff', 'schedule'], schedule=OBJ(['nrp', 'prp', 'source'])),
    'domesticGasObligation': OBJ(['obligation', 'delivered', 'voluntaryContracts', 'excused', 'agreementPenaltyRate', 'penaltyRate'],
                                 excused=OBJ(['forceMajeure', 'purchaserCannotAccept', 'transportUnavailable', 'purchaserNonPayment']), penaltyRate=OBJ(['value', 'source'])),
    'gsaCashFlows': OBJ(['contract', 'royalty', 'discountRate', 'baseYear'], contract=TOPA, royalty=OBJ(['terrain', 'inCountrySharePct'])),
}


def check_keys(v, shape, path):
    kind = shape[0]
    if kind == 'formula':
        if not isobj(v) or v.get('type') not in FORMULAS:
            return
        return check_keys(v, FORMULAS[v['type']], path)
    if kind == 'list':
        if isinstance(v, list):
            for i, x in enumerate(v):
                check_keys(x, shape[1], f'{path}[{i}]')
        return
    _, keys, children = shape
    if not isobj(v):
        return
    for k in v:
        if k not in keys:
            where = f'of {path}' if path else 'at the top level'
            refuse(f'{path}.{k}' if path else k, f'is not an accepted key; the accepted keys {where} are ' + ', '.join(keys))
    for k in keys:
        if k in children and k in v:
            check_keys(v[k], children[k], f'{path}.{k}' if path else k)


# ------------------------------------------------------------ toEnergy
VOL = {'scf': ('ft3', 1), 'Mscf': ('ft3', 1000), 'MMscf': ('ft3', 10 ** 6), 'Sm3': ('m3', 1), 'MSm3': ('m3', 1000), 'MMSm3': ('m3', 10 ** 6)}
BTU_J = F('1055.05585262')
M3FT3 = F('0.3048') ** 3


def to_energy(a):
    non_neg('quantity', g(a, 'quantity'))
    one_of('quantityUnit', g(a, 'quantityUnit'), list(VOL))
    positive('heatingValue', g(a, 'heatingValue'))
    one_of('heatingValueUnit', g(a, 'heatingValueUnit'), ['Btu/scf', 'MJ/Sm3'])
    one_of('heatingValueBasis', g(a, 'heatingValueBasis'), ['gross', 'net'])
    text('referenceConditions', g(a, 'referenceConditions'))
    q, hv = F(a['quantity']), F(a['heatingValue'])
    sysu, mult = VOL[a['quantityUnit']]
    ft3 = q * mult if sysu == 'ft3' else q * mult / M3FT3
    m3 = q * mult if sysu == 'm3' else q * mult * M3FT3
    # energy in joules by whichever pair is native, then MMBtu
    if a['heatingValueUnit'] == 'Btu/scf':
        mmbtu = ft3 * hv / 10 ** 6
    else:
        mmbtu = m3 * hv * 10 ** 6 / (BTU_J * 10 ** 6)
    return {k: a[k] for k in ('quantity', 'quantityUnit', 'heatingValue', 'heatingValueUnit', 'heatingValueBasis', 'referenceConditions')} | {
        'mmbtu': fl(mmbtu), 'gj': fl(mmbtu * BTU_J / 1000)}


# ---------------------------------------------------- contractQuantities
def contract_quantities(a):
    positive('dcq', g(a, 'dcq'))
    days, year, period = g(a, 'days'), g(a, 'year'), g(a, 'period')
    given = [k for k, v in (('days', days), ('year', year), ('period', period)) if v is not MISSING]
    if not given:
        refuse('days', 'must be stated, or replaced by year or by period; got nothing')
    if len(given) > 1:
        refuse('days', 'must be the only day count stated; got ' + ' and '.join(given))
    if days is not MISSING:
        int_at_least('days', days, 1)
        n = int(days)
    elif year is not MISSING:
        int_at_least('year', year, 1)
        n = 366 if leap(int(year)) else 365
    else:
        if not isobj(period):
            must('period', 'an object { start, end }', period)
        import datetime
        ds = {}
        for k in ('start', 'end'):
            s = period.get(k, MISSING) if isobj(period) else MISSING
            ok = False
            if isinstance(s, str) and is_day(s):
                try:
                    ds[k] = datetime.date(int(s[:4]), int(s[5:7]), int(s[8:]))
                    ok = True
                except ValueError:
                    ok = False
            if not ok:
                must(f'period.{k}', "a real date 'YYYY-MM-DD'", s)
        n = (ds['end'] - ds['start']).days
        if n < 1:
            must('period.end', f"a date after period.start {period['start']}", period['end'])
    mx, tp = g(a, 'maxDcqPct'), g(a, 'topPct')
    if mx is not MISSING and not (isnum(mx) and mx >= 100):
        must('maxDcqPct', 'a number at or above 100 when given', mx)
    if tp is not MISSING:
        pct('topPct', tp)
    if tp == 0 and mx is not MISSING:
        must('topPct', 'above 0 when maxDcqPct is stated (the effective swing divides by it)', tp)
    dcq = F(a['dcq'])
    acq = dcq * n
    out = {'dcq': a['dcq'], 'days': n, 'acq': fl(acq), 'maxDcq': None, 'swingFactor': None, 'topQuantity': None, 'effectiveSwing': None}
    if mx is not MISSING:
        out['maxDcq'] = fl(dcq * F(mx) / 100)
        out['swingFactor'] = fl(F(mx) / 100)
    if tp is not MISSING:
        out['topQuantity'] = fl(acq * F(tp) / 100)
    if tp is not MISSING and mx is not MISSING:
        out['effectiveSwing'] = fl(F(mx) / F(tp))
    return out


# ---------------------------------------------------------- dailyBalance
def daily_balance(a):
    dcq, mx, tol, days = g(a, 'dcq'), g(a, 'maxDcqPct'), g(a, 'deliveryTolerance'), g(a, 'days')
    tol = 0 if tol is MISSING else tol
    positive('dcq', dcq)
    if mx is not MISSING and not (isnum(mx) and mx >= 100):
        must('maxDcqPct', 'a number at or above 100 when given', mx)
    non_neg('deliveryTolerance', tol)
    list_of('days', days, 400)
    D = F(dcq)
    maxd = None if mx is MISSING else D * F(mx) / 100
    prev = None
    for i, d in enumerate(days):
        f = f'days[{i}]'
        if not is_day(d.get('date')):
            must(f'{f}.date', "a date 'YYYY-MM-DD'", g(d, 'date'))
        if prev is not None and not d['date'] > prev:
            must(f'{f}.date', f'after the previous day {prev}', d['date'])
        prev = d['date']
        for k in ('nominated', 'available', 'taken'):
            non_neg(f'{f}.{k}', g(d, k))
        for k in ('forceMajeure', 'maintenance'):
            if g(d, k) is not MISSING:
                non_neg(f'{f}.{k}', d[k])
        if g(d, 'buyerCaused') is not MISSING and not isinstance(d['buyerCaused'], bool):
            must(f'{f}.buyerCaused', 'true or false when given', d['buyerCaused'])
        if d['taken'] > d['available']:
            must(f'{f}.taken', f"at or below the quantity made available {js(d['available'])}", d['taken'])
        fm = F(d.get('forceMajeure') or 0)
        sm = F(d.get('maintenance') or 0)
        if fm + sm > D:
            must(f'{f}.forceMajeure', f'a quantity that with maintenance {js(sm)} is at or below the DCQ {js(D)}', d.get('forceMajeure') or 0)
    rows = []
    T = F(tol)
    for d in days:
        date = d['date']
        nom, av, tk = F(d['nominated']), F(d['available']), F(d['taken'])
        fm = F(d.get('forceMajeure') or 0)
        sm = F(d.get('maintenance') or 0)
        why = []
        if maxd is not None and nom > maxd:
            pnq = maxd
            why.append(f'{date}: nominated {js(nom)} is above the MaxDCQ {js(maxd)}; {js(nom - maxd)} is not properly nominated')
        else:
            pnq = nom
        gap = pnq - T - av
        sfq = F(0)
        if gap > 0:
            if d.get('buyerCaused') is True:
                why.append(f"{date}: {js(gap)} of the properly nominated quantity was not made available for a cause on the buyer's side, so it is not a seller shortfall")
            else:
                exc = min(gap, fm + sm)
                sfq = gap - exc
                if exc > 0:
                    why.append(f'{date}: {js(exc)} not made available is excused by the force majeure and maintenance quantities stated for the day')
                if sfq > 0:
                    tol_txt = f' less the tolerance {js(T)}' if T > 0 else ''
                    why.append(f'{date}: the seller made {js(av)} available against a properly nominated {js(pnq)}{tol_txt}: seller shortfall {js(sfq)}')
        adj = D - fm - sm - sfq
        bs = max(F(0), adj - tk)
        ot = max(F(0), tk - adj)
        if nom == 0 and adj > 0:
            why.append(f'{date}: zero nomination; the whole adjusted DCQ {js(adj)} is a buyer shortfall for the day')
        elif bs > 0:
            why.append(f'{date}: taken {js(tk)} is below the adjusted DCQ {js(adj)}: buyer shortfall {js(bs)}')
        if fm + sm >= D:
            why.append(f'{date}: force majeure and maintenance cover the whole DCQ; no quantity is owed either way for the day')
        rows.append({'date': date, 'nominated': d['nominated'], 'properlyNominated': fl(pnq), 'available': d['available'], 'taken': d['taken'],
                     'forceMajeure': fl(fm), 'maintenance': fl(sm), 'sellerShortfall': fl(sfq), 'adjustedDcq': fl(adj),
                     'buyerShortfall': fl(bs), 'overTake': fl(ot), 'reasons': why,
                     '_x': (fm, sm, sfq, tk, bs, ot)})
    fmT = sum(r['_x'][0] for r in rows)
    smT = sum(r['_x'][1] for r in rows)
    sfT = sum(r['_x'][2] for r in rows)
    tkT = sum(r['_x'][3] for r in rows)
    acq = D * len(rows)
    annual = {'days': len(rows), 'acq': fl(acq), 'maintenance': fl(smT), 'forceMajeure': fl(fmT), 'sellerShortfall': fl(sfT), 'taken': fl(tkT),
              'buyerShortfall': fl(sum(r['_x'][4] for r in rows)), 'overTake': fl(sum(r['_x'][5] for r in rows)),
              'adjustedAcq': fl(acq - smT - fmT - sfT)}
    for r in rows:
        del r['_x']
    return {'dcq': dcq, 'maxDcq': None if maxd is None else fl(maxd), 'deliveryTolerance': tol, 'days': rows, 'annual': annual}


# ------------------------------------------------------------- takeOrPay
ORDER_TEXT = {
    'after-adjusted-acq': 'make-up only after the Adjusted ACQ of the year is taken',
    'after-top-quantity': 'make-up only after the take-or-pay quantity of the year is taken',
    'first': "make-up taken in priority, before the year's own quantity",
}


def check_top(a, pre=''):
    years, top, mu, cf = g(a, 'years'), g(a, 'topPct'), g(a, 'makeUp'), g(a, 'carryForward')
    list_of(f'{pre}years', years, 100)
    pct(f'{pre}topPct', top)
    if not isobj(mu):
        must(f'{pre}makeUp', 'an object { periodYears, order, endOfTerm } (no default)', mu)
    int_at_least(f'{pre}makeUp.periodYears', g(mu, 'periodYears'), 0)
    one_of(f'{pre}makeUp.order', g(mu, 'order'), list(ORDER_TEXT))
    one_of(f'{pre}makeUp.endOfTerm', g(mu, 'endOfTerm'), ['forfeit', 'refund'])
    if cf is not MISSING:
        if not isobj(cf):
            must(f'{pre}carryForward', 'an object { periodYears, base, capPct } when given', cf)
        int_at_least(f'{pre}carryForward.periodYears', g(cf, 'periodYears'), 1)
        one_of(f'{pre}carryForward.base', g(cf, 'base'), ['adjusted-acq', 'top-quantity'])
        pct(f'{pre}carryForward.capPct', g(cf, 'capPct'))
    for i, y in enumerate(years):
        f = f'{pre}years[{i}]'
        int_at_least(f'{f}.year', g(y, 'year'), 1)
        if i > 0 and y['year'] != years[i - 1]['year'] + 1:
            p = int(years[i - 1]['year'])
            must(f'{f}.year', f'{p + 1}, the year after {p} (contract years are consecutive)', y['year'])
        non_neg(f'{f}.acq', g(y, 'acq'))
        non_neg(f'{f}.taken', g(y, 'taken'))
        for k in ('maintenance', 'forceMajeure', 'sellerShortfall', 'permittedReduction'):
            if g(y, k) is not MISSING:
                non_neg(f'{f}.{k}', y[k])
        for k in ('contractPrice', 'topPrice', 'makeUpPrice'):
            non_neg(f'{f}.{k}', g(y, k))
        if g(y, 'shortfallPrice') is not MISSING:
            non_neg(f'{f}.shortfallPrice', y['shortfallPrice'])
        if (y.get('sellerShortfall') or 0) > 0 and g(y, 'shortfallPrice') is MISSING:
            must(f'{f}.shortfallPrice', f"stated when sellerShortfall is above 0 ({js(y['sellerShortfall'])}); the engine holds no default rate", MISSING)
        red = sum(F(y.get(k) or 0) for k in ('maintenance', 'forceMajeure', 'sellerShortfall', 'permittedReduction'))
        if red > F(y['acq']):
            must(f'{f}.acq', f'at or above the reductions it carries (maintenance + force majeure + seller shortfall + permitted reduction = {js(red)})', y['acq'])


def fifo(ledger, want):
    got = []
    for e in ledger:
        if want <= 0:
            break
        if e['left'] <= 0:
            continue
        q = min(e['left'], want)
        e['left'] -= q
        want -= q
        got.append((e['from'], q))
    return got


def fifo_list(xs):
    return ', '.join(f'{js(q)} from {y}' for y, q in xs)


def top_core(a):
    years, top, mu_c, cf_c = a['years'], F(a['topPct']), a['makeUp'], a.get('carryForward')
    P = int(mu_c['periodYears'])
    last = years[-1]['year']
    MU, CF, rows = [], [], []
    for y in years:
        Y = int(y['year'])
        why = []
        m, fm, sf, pr = (F(y.get(k) or 0) for k in ('maintenance', 'forceMajeure', 'sellerShortfall', 'permittedReduction'))
        adj = F(y['acq']) - m - fm - sf - pr                       # AdjACQ, Model GSA Alternative 2 with OFC
        topq = top * adj / 100                                       # TOPQ
        tk = F(y['taken'])
        mua = sum((e['left'] for e in MU), F(0))                     # MUA from prior years
        thr = {'after-adjusted-acq': adj, 'after-top-quantity': topq, 'first': F(0)}[mu_c['order']]
        muq = min(mua, max(F(0), tk - thr))
        drawn = fifo(MU, muq) if muq > 0 else []
        if muq > 0:
            why.append(f"{Y}: make-up of {js(muq)} taken from the make-up aggregate {js(mua)} ({ORDER_TEXT[mu_c['order']]}), first in first out: {fifo_list(drawn)}")
        elif mua > 0:
            name = {'after-adjusted-acq': f'the Adjusted ACQ {js(adj)}', 'after-top-quantity': f'the take-or-pay quantity {js(topq)}', 'first': '0'}[mu_c['order']]
            why.append(f'{Y}: make-up aggregate {js(mua)} available and none taken, because taken {js(tk)} does not exceed {name}')
        counted = tk - muq
        badq = max(F(0), topq - counted)                             # BADQ = TOPQ - AAQ (make-up excluded)
        cfa = sum((e['left'] for e in CF), F(0)) if cf_c else F(0)
        cfcq, cfd = F(0), []
        if cf_c and badq > 0 and cfa > 0:
            cfcq = min(cfa, F(cf_c['capPct']) * badq / 100)
            if cfcq > 0:
                cfd = fifo(CF, cfcq)
        paid = badq - cfcq
        bdp = paid * F(y['topPrice'])                                # BDP = (BADQ - CFCQ) x TOPP
        if badq > 0:
            r = f'{Y}: {js(counted)} counted against the take-or-pay quantity {js(topq)} leaves a deficiency of {js(badq)}'
            if cfcq > 0:
                r += f"; a carry-forward credit of {js(cfcq)} (at most {js(cf_c['capPct'])}% of the deficiency, first in first out: {fifo_list(cfd)}) leaves {js(paid)}"
            r += f"; the deficiency payment is {js(paid)} x {js(y['topPrice'])} = {js(bdp)}"
            if paid > 0 and Y == last:
                r += '; the delivery period ends with this year, so no make-up right arises'
            elif paid > 0:
                r += (f"; the buyer may make up {js(paid)} in the {unit(P, 'contract year')} after {Y}, to the end of {Y + P}" if P > 0
                      else '; the make-up period is 0 years, so no make-up right arises')
            why.append(r)
        if paid > 0 and P > 0 and Y != last:
            MU.append({'from': Y, 'last': Y + P, 'left': paid})
        basq = F(0)
        if cf_c:
            base = adj if cf_c['base'] == 'adjusted-acq' else topq
            basq = max(F(0), counted - base)                         # BASQ
            if basq > 0:
                CF.append({'from': Y, 'last': Y + int(cf_c['periodYears']), 'left': basq})
                bn = 'Adjusted ACQ' if cf_c['base'] == 'adjusted-acq' else 'take-or-pay quantity'
                why.append(f"{Y}: {js(counted)} counted exceeds the {bn} {js(base)} by {js(basq)}, carried forward to the end of {Y + int(cf_c['periodYears'])}")
        mexp = []
        for e in MU:
            if e['last'] == Y and e['left'] > 0:
                mexp.append((e['from'], e['left']))
                e['left'] = F(0)
        for fy, q in mexp:
            why.append(f'{Y}: make-up of {js(q)} from {fy} expired unrecovered at the end of {Y}, the last year of its make-up period')
        cexp = []
        for e in CF:
            if e['last'] == Y and e['left'] > 0:
                cexp.append((e['from'], e['left']))
                e['left'] = F(0)
        for fy, q in cexp:
            why.append(f'{Y}: carry-forward of {js(q)} from {fy} expired unused at the end of {Y}')
        eot, refund = None, F(0)
        if Y == last:
            rem = [(e['from'], e['left']) for e in MU if e['left'] > 0]
            q = sum((x[1] for x in rem), F(0))
            if mu_c['endOfTerm'] == 'refund':
                refund = q * F(y['topPrice'])
            eot = {'rule': mu_c['endOfTerm'], 'quantity': fl(q), 'entries': [{'fromYear': fy, 'quantity': fl(v)} for fy, v in rem], 'refund': fl(refund)}
            if q > 0:
                why.append(f"{Y}: the delivery period ends with make-up of {js(q)} unrecovered; the seller refunds {js(q)} x {js(y['topPrice'])} = {js(refund)}"
                           if mu_c['endOfTerm'] == 'refund' else f'{Y}: the delivery period ends with make-up of {js(q)} unrecovered; the buyer forfeits it')
            for e in MU:
                e['left'] = F(0)
        ld = sf * F(y['shortfallPrice']) if sf > 0 else F(0)
        if sf > 0:
            why.append(f"{Y}: seller shortfall {js(sf)} reduces the Adjusted ACQ and is paid to the buyer at {js(y['shortfallPrice'])}: {js(ld)}")
        reg = counted * F(y['contractPrice'])
        mur = muq * F(y['makeUpPrice'])
        rows.append({
            'year': Y, 'acq': y['acq'], 'maintenance': fl(m), 'forceMajeure': fl(fm), 'sellerShortfall': fl(sf), 'permittedReduction': fl(pr),
            'adjustedAcq': fl(adj), 'topQuantity': fl(topq), 'taken': y['taken'],
            'makeUpAvailable': fl(mua), 'makeUpTaken': fl(muq), 'makeUpDrawn': [{'fromYear': fy, 'quantity': fl(q)} for fy, q in drawn],
            'counted': fl(counted), 'deficiency': fl(badq),
            'carryForwardAvailable': fl(cfa), 'carryForwardApplied': fl(cfcq), 'carryForwardDrawn': [{'fromYear': fy, 'quantity': fl(q)} for fy, q in cfd],
            'deficiencyPaid': fl(paid), 'deficiencyPayment': fl(bdp), 'surplus': fl(basq),
            'makeUpExpired': [{'fromYear': fy, 'quantity': fl(q)} for fy, q in mexp],
            'carryForwardExpired': [{'fromYear': fy, 'quantity': fl(q)} for fy, q in cexp],
            'makeUpOutstanding': fl(sum((e['left'] for e in MU), F(0))), 'carryForwardOutstanding': fl(sum((e['left'] for e in CF), F(0))),
            'endOfTerm': eot,
            'regularRevenue': fl(reg), 'makeUpRevenue': fl(mur), 'shortfallPayment': fl(ld), 'refund': fl(refund),
            'netToSeller': fl(reg + mur + bdp - ld - refund),
            'reasons': why,
            '_x': (tk, muq, paid, bdp, sum((q for _, q in mexp), F(0)), reg, mur, ld, refund, reg + mur + bdp - ld - refund),
        })
    X = [r.pop('_x') for r in rows]
    tot = lambda i: fl(sum((x[i] for x in X), F(0)))  # noqa: E731
    return {'years': rows, 'totals': {
        'taken': tot(0), 'makeUpTaken': tot(1), 'deficiencyPaid': tot(2), 'deficiencyPayment': tot(3), 'makeUpExpired': tot(4),
        'endOfTermQuantity': rows[-1]['endOfTerm']['quantity'],
        'regularRevenue': tot(5), 'makeUpRevenue': tot(6), 'shortfallPayment': tot(7), 'refund': tot(8), 'netToSeller': tot(9)}}, X


def take_or_pay(a):
    check_top(a)
    return top_core(a)[0]


# ------------------------------------------------------------ priceSeries
def dec12(x):
    """A positive Fraction to 12 significant digits, half up (JavaScript toPrecision)."""
    if x == 0:
        return Decimal(0)
    e = math.floor(math.log10(abs(float(x))))
    # guard the log10 estimate
    while F(10) ** e > abs(x):
        e -= 1
    while F(10) ** (e + 1) <= abs(x):
        e += 1
    q = e - 11  # exponent of the last kept digit
    scaled = x / (F(10) ** q)
    n = scaled.numerator // scaled.denominator
    rem = scaled - n
    if rem >= F(1, 2):
        n += 1
    return Decimal(n).scaleb(q)


def round_model(x):
    d = dec12(x)
    s = format(d, 'f')
    ip, _, fp = s.partition('.')
    fp = (fp + '0' * 12)[:12]
    four = Decimal(ip + '.' + fp[:4])
    if int(fp[4]) >= 5:
        four += Decimal('0.0001')
    return F(str(four))


def check_formula(f, indices):
    if not isobj(f):
        must('formula', 'an object with a type', f)
    one_of('formula.type', g(f, 'type'), list(FORMULAS))
    t = f['type']

    def idx(k):
        v = g(f, k)
        if not (isinstance(v, str) and v in indices):
            must(f'formula.{k}', f"the name of an index in months[].values ({', '.join(indices) or 'none given'})", v)

    def band():
        for k in ('floor', 'ceiling'):
            if g(f, k) is not MISSING:
                non_neg(f'formula.{k}', f[k])
        if g(f, 'floor') is not MISSING and g(f, 'ceiling') is not MISSING and f['floor'] > f['ceiling']:
            must('formula.ceiling', f"at or above formula.floor {js(f['floor'])}", f['ceiling'])

    def finite(k):
        if not isnum(g(f, k)):
            must(f'formula.{k}', 'a finite number', g(f, k))

    if t == 'fixed':
        non_neg('formula.price', g(f, 'price'))
        return
    if t == 'escalated':
        non_neg('formula.basePrice', g(f, 'basePrice'))
        if not is_month(g(f, 'baseMonth')):
            must('formula.baseMonth', "a month 'YYYY-MM'", g(f, 'baseMonth'))
        r = g(f, 'ratePctPerYear')
        if not (isnum(r) and r > -100):
            must('formula.ratePctPerYear', 'a finite number above -100', r)
        return
    if t == 'oil-indexed':
        idx('index')
        finite('slope')
        finite('constant')
        band()
        s = g(f, 'sCurve')
        if s is not MISSING:
            if not isobj(s):
                must('formula.sCurve', 'an object { lowKink, highKink, lowSlope, highSlope } when given', s)
            non_neg('formula.sCurve.lowKink', g(s, 'lowKink'))
            non_neg('formula.sCurve.highKink', g(s, 'highKink'))
            for k in ('lowSlope', 'highSlope'):
                if not isnum(g(s, k)):
                    must(f'formula.sCurve.{k}', 'a finite number', g(s, k))
            if not s['highKink'] > s['lowKink']:
                must('formula.sCurve.highKink', f"above formula.sCurve.lowKink {js(s['lowKink'])}", s['highKink'])
        return
    if t == 'hub-indexed':
        idx('index')
        finite('multiplier')
        finite('adder')
        band()
        return
    non_neg('formula.basePrice', g(f, 'basePrice'))
    w = g(f, 'weights')
    if not isobj(w) or len(w) == 0:
        must('formula.weights', 'an object of index weights, at least one', w)
    names = list(w)
    if len(names) > 10:
        refuse('formula.weights', f'must have at most 10 indices; got {len(names)}')
    for k in names:
        if k not in indices:
            refuse(f'formula.weights.{k}', f"is not an index in months[].values; the indices are {', '.join(indices) or 'none'}")
        non_neg(f'formula.weights.{k}', w[k])
    ws = 0.0
    for k in names:
        ws += w[k]  # the engine sums doubles left to right; the message prints that double
    if abs(ws - 1) > 1e-9:
        refuse('formula.weights', f'must sum to 1 (weights stated as decimals, CW GSA Article 15.1); got a sum of {js_num(ws)}')
    bv = g(f, 'baseValues')
    if not isobj(bv):
        must('formula.baseValues', 'an object with a base value for each weighted index', bv)
    for k in bv:
        if k not in names:
            refuse(f'formula.baseValues.{k}', f"is not a weighted index; the accepted keys of formula.baseValues are {', '.join(names)}")
    for k in names:
        positive(f'formula.baseValues.{k}', g(bv, k))
    for side in ('indexFloors', 'indexCeilings'):
        sd = g(f, side)
        if sd is MISSING:
            continue
        if not isobj(sd):
            must(f'formula.{side}', 'an object keyed by weighted index when given', sd)
        for k in sd:
            if k not in names:
                refuse(f'formula.{side}.{k}', f"is not a weighted index; the accepted keys of formula.{side} are {', '.join(names)}")
            non_neg(f'formula.{side}.{k}', sd[k])
    for k in names:
        lo, hi = g(g(f, 'indexFloors'), k), g(g(f, 'indexCeilings'), k)
        if lo is not MISSING and hi is not MISSING and lo > hi:
            must(f'formula.indexCeilings.{k}', f'at or above formula.indexFloors.{k} {js(lo)}', hi)


def price_value(f, avg):
    """(raw, segment, clamped, price, held) for one pricing point, exact."""
    t = f['type']
    if t == 'oil-indexed':
        x = avg[f['index']]
        a, b = F(f['constant']), F(f['slope'])
        s = f.get('sCurve')
        seg = None
        if s is None:
            raw = a + b * x
        else:
            lo, hi = F(s['lowKink']), F(s['highKink'])
            p_lo, p_hi = a + b * lo, a + b * hi       # the two kink prices
            if x < lo:
                raw, seg = p_lo + F(s['lowSlope']) * (x - lo), 'low'
            elif x > hi:
                raw, seg = p_hi + F(s['highSlope']) * (x - hi), 'high'
            else:
                raw, seg = a + b * x, 'mid'
    else:
        raw = F(f['multiplier']) * avg[f['index']] + F(f['adder'])
        seg = None
    price, cl = raw, None
    if f.get('floor') is not None and raw < F(f['floor']):
        price, cl = F(f['floor']), 'floor'
    elif f.get('ceiling') is not None and raw > F(f['ceiling']):
        price, cl = F(f['ceiling']), 'ceiling'
    return raw, seg, cl, price


def price_double(f, series, names, ws_, we, avgm):
    av = {}
    for nm in names:
        t = 0.0
        for k in range(ws_, we + 1):
            t += float(series[k][nm])
        av[nm] = t / avgm
    if f['type'] == 'oil-indexed':
        x = av[f['index']]
        s = f.get('sCurve')
        if s is None or s['lowKink'] <= x <= s['highKink']:
            return f['constant'] + f['slope'] * x
        if x < s['lowKink']:
            return f['constant'] + f['slope'] * s['lowKink'] + s['lowSlope'] * (x - s['lowKink'])
        return f['constant'] + f['slope'] * s['highKink'] + s['highSlope'] * (x - s['highKink'])
    if f['type'] == 'hub-indexed':
        return f['multiplier'] * av[f['index']] + f['adder']
    t = 0.0
    for nm in names:
        t += (f['weights'][nm] * av[nm]) / f['baseValues'][nm]
    return f['basePrice'] * t


def price_series(a):
    months = g(a, 'months')
    list_of('months', months, 1200)
    series, indices = {}, None
    for i, m in enumerate(months):
        if not is_month(g(m, 'month')):
            must(f'months[{i}].month', "a month 'YYYY-MM'", g(m, 'month'))
        if i > 0 and mi(m['month']) != mi(months[i - 1]['month']) + 1:
            must(f'months[{i}].month', f"{mname(mi(months[i - 1]['month']) + 1)}, the month after {months[i - 1]['month']} (the series is consecutive)", m['month'])
        if not isobj(g(m, 'values')):
            must(f'months[{i}].values', 'an object of index values', g(m, 'values'))
        names = sorted(m['values'])
        if indices is None:
            indices = names
        elif names != indices:
            refuse(f'months[{i}].values', f"must carry the same indices as months[0] ({', '.join(indices)}); got {', '.join(names) or 'none'}")
        for k in names:
            non_neg(f'months[{i}].values.{k}', m['values'][k])
        series[mi(m['month'])] = m['values']
    f = g(a, 'formula')
    check_formula(f, indices)
    fr, to = g(a, 'from'), g(a, 'to')
    if not is_month(fr):
        must('from', "a month 'YYYY-MM'", fr)
    if not is_month(to):
        must('to', "a month 'YYYY-MM'", to)
    avgm = a.get('averagingMonths', 1)
    lag = a.get('lagMonths', 0)
    rst = a.get('resetMonths', 1)
    rnd = a.get('rounding', 'none')
    reo = a.get('reopeners', [])
    int_at_least('averagingMonths', avgm, 1)
    int_at_least('lagMonths', lag, 0)
    int_at_least('resetMonths', rst, 1)
    one_of('rounding', rnd, ['none', 'model-gsa-4dp'])
    if not isinstance(reo, list):
        must('reopeners', "an array of months 'YYYY-MM'", reo)
    for i, r in enumerate(reo):
        if not is_month(r):
            must(f'reopeners[{i}]', "a month 'YYYY-MM'", r)
    t0, t1 = mi(fr), mi(to)
    if t1 < t0:
        must('to', f'a month at or after from {fr}', to)
    if t1 - t0 + 1 > 1200:
        refuse('to', f'must give at most 1200 priced months; got {t1 - t0 + 1}')
    if f['type'] == 'escalated' and t0 < mi(f['baseMonth']):
        must('from', f"a month at or after formula.baseMonth {f['baseMonth']}", fr)
    avgm, lag, rst = int(avgm), int(lag), int(rst)
    uses = f['type'] not in ('fixed', 'escalated')
    names = list(f['weights']) if f['type'] == 'basket' else ([f['index']] if uses else [])
    rows = []
    blocks = {}
    for t in range(t0, t1 + 1):
        b0 = t0 + ((t - t0) // rst) * rst
        if b0 not in blocks:
            we, ws_ = b0 - lag, b0 - lag - avgm + 1
            avg, win = None, None
            if uses:
                miss = [mname(k) for k in range(ws_, we + 1) if k not in series]
                if miss:
                    refuse('months', f'must cover the averaging window {mname(ws_)} to {mname(we)} for the price of {mname(b0)}; got no value for {", ".join(miss)}')
                avg = {nm: sum(F(series[k][nm]) for k in range(ws_, we + 1)) / avgm for nm in names}
                win = [mname(ws_), mname(we)]
            raw, seg, cl, held = None, None, None, None
            if f['type'] == 'fixed':
                price = F(f['price'])
            elif f['type'] == 'escalated':
                k = (b0 - mi(f['baseMonth'])) // 12
                price = F(f['basePrice']) * (1 + F(f['ratePctPerYear']) / 100) ** k
            elif f['type'] in ('oil-indexed', 'hub-indexed'):
                raw, seg, cl, price = price_value(f, avg)
            else:
                held, s = {}, F(0)
                for nm in names:
                    x = avg[nm]
                    lo = (f.get('indexFloors') or {}).get(nm)
                    hi = (f.get('indexCeilings') or {}).get(nm)
                    if lo is not None and x < F(lo):
                        x = F(lo)
                    if hi is not None and x > F(hi):
                        x = F(hi)
                    held[nm] = x
                    s += F(f['weights'][nm]) * x / F(f['baseValues'][nm])
                price = F(f['basePrice']) * s
            if price < 0:
                # the message prints the double the engine holds: replayed in
                # doubles in the formula's stated order (window sum left to
                # right, then the formula left to right)
                refuse('formula', f'must give a price at or above 0 in every month; got {js_num(price_double(f, series, names, ws_, we, avgm))} for {mname(b0)}')
            unr = price
            if rnd == 'model-gsa-4dp':
                price = round_model(price)
            blocks[b0] = {'window': win, 'avg': avg, 'held': held, 'seg': seg, 'cl': cl, 'unr': unr, 'price': price}
        B = blocks[b0]
        rows.append({'month': mname(t), 'priceMonth': mname(b0), 'window': B['window'],
                     'indexAverages': None if B['avg'] is None else {k: fl(v) for k, v in B['avg'].items()},
                     'heldIndices': None if B['held'] is None else {k: fl(v) for k, v in B['held'].items()},
                     'segment': B['seg'], 'clamped': B['cl'], 'unroundedPrice': fl(B['unr']), 'price': fl(B['price']),
                     'reopener': mname(t) in reo, '_p': B['price']})
    years = {}
    for r in rows:
        years.setdefault(int(r['month'][:4]), []).append(r.pop('_p'))
    annual = [{'year': y, 'months': len(ps), 'averagePrice': fl(sum(ps) / len(ps)), 'lastMonthPrice': fl(ps[-1])} for y, ps in years.items()]
    return {'months': rows, 'annual': annual,
            'reopeners': [{'month': m, 'note': f'price reopener {m}: reported only; the engine does not model the outcome of a price review'} for m in reo]}


def parity(a):
    positive('mmbtuPerBarrel', g(a, 'mmbtuPerBarrel'))
    return {'mmbtuPerBarrel': a['mmbtuPerBarrel'], 'slope': fl(1 / F(a['mmbtuPerBarrel']))}


# ---------------------------------------------------------- Nigeria
GBI = {'ammonia': (1, 250), 'urea': (1, 250), 'methanol': (1, 250), 'polypropylene': (1, 250), 'low-sulphur-diesel-gtl': (1, 325)}
ADDER = F(1, 2)      # s.167(6) US$0.50
FLOOR = F(9, 10)     # s.168(2) US$0.90


def domestic_price(a):
    sector, dbp = g(a, 'sector'), g(a, 'domesticBasePrice')
    one_of('sector', sector, ['power', 'commercial', 'gas-distributor', 'gas-based-industry'])
    if dbp is MISSING:
        must('domesticBasePrice', 'stated in US$ per MMBtu: the Authority determines it each year (PIA s.167(1)) and the engine holds no default', MISSING)
    positive('domesticBasePrice', dbp)
    tt = g(a, 'transportTariff')
    if tt is not MISSING:
        non_neg('transportTariff', tt)
    neg = g(a, 'negotiatedPrice')
    if sector != 'gas-distributor' and neg is not MISSING:
        must('negotiatedPrice', "given only for sector 'gas-distributor'", neg)
    if sector != 'gas-based-industry':
        for k in ('product', 'cmpp', 'schedule'):
            if g(a, k) is not MISSING:
                must(k, "given only for sector 'gas-based-industry'", a[k])
    D = F(dbp)
    out = {'sector': sector, 'domesticBasePrice': dbp}
    if sector == 'power':
        out['price'] = dbp                                    # s.167(5)
        P = D
    elif sector == 'commercial':
        P = D + ADDER                                         # s.167(6)
        out['price'] = fl(P)
    elif sector == 'gas-distributor':
        if neg is MISSING:
            must('negotiatedPrice', 'stated for a gas distributor, which negotiates its price (PIA s.167(7))', MISSING)
        non_neg('negotiatedPrice', neg)
        ceil = D + ADDER
        out['ceiling'] = fl(ceil)
        out['price'] = neg
        out['withinCeiling'] = F(neg) <= ceil
        out['reason'] = (f'negotiated price {js(neg)} is at or below the commercial sector price {js(ceil)}' if out['withinCeiling']
                         else f'negotiated price {js(neg)} exceeds the commercial sector price {js(ceil)}, which s.167(7) sets as the ceiling for gas distributors')
        P = F(neg)
    else:
        one_of('product', g(a, 'product'), list(GBI))
        cm = g(a, 'cmpp')
        if cm is MISSING:
            must('cmpp', 'stated: the average current month end product price in US$ per tonne (Fourth Schedule)', MISSING)
        non_neg('cmpp', cm)
        nrp, prp = GBI[a['product']]
        sch = g(a, 'schedule')
        if sch is not MISSING:
            if not isobj(sch):
                must('schedule', 'an object { nrp, prp, source } when given', sch)
            positive('schedule.nrp', g(sch, 'nrp'))
            positive('schedule.prp', g(sch, 'prp'))
            text('schedule.source', g(sch, 'source'))
            nrp, prp = sch['nrp'], sch['prp']
        if D < FLOOR:
            must('domesticBasePrice', 'at or above the gas based industries floor US$0.90 per MMBtu (s.168(2)) for a gas based industry price, which is capped at the domestic base price (s.168(3))', dbp)
        epf = (F(cm) - F(prp)) / F(prp)                       # EPF = (CMPP - PRP) / PRP
        cp = F(nrp) * (1 + epf)                               # CP = NRP x (1 + EPF)
        held = None
        P = cp
        if P > D:
            P, held = D, 'ceiling'                            # <= EPP, s.168(3)
        if P < FLOOR:
            P, held = FLOOR, 'floor'                          # s.168(2)
        # the reason prints the double the engine holds for the formula price
        cp_double = float(nrp) * (1 + (float(cm) - float(prp)) / float(prp))
        out.update({'product': a['product'], 'cmpp': cm, 'nrp': nrp, 'prp': prp, 'epf': fl(epf), 'formulaPrice': fl(cp), 'price': fl(P), 'heldAt': held})
        out['reason'] = (f'the formula gives {js_num(cp_double)}, above the domestic base price {js(D)}, so the price is held at {js(D)} (s.168(3))' if held == 'ceiling'
                         else f'the formula gives {js_num(cp_double)}, below the floor US$0.90 per MMBtu, so the price is held at 0.9 (s.168(2))' if held == 'floor'
                         else f'the formula gives {js_num(cp_double)}, inside the floor 0.9 and the domestic base price {js(D)}')
    if tt is not MISSING:
        out['deliveredPrice'] = fl(F(out['price']) + F(tt))
    return out


EXC = [('forceMajeure', 'force majeure (s.110(10)(a))'),
       ('purchaserCannotAccept', 'the purchaser could not accept the allocated volumes (s.110(10)(b))'),
       ('transportUnavailable', "the allocated gas could not be transported for reasons beyond the lessee's control (s.110(10)(c))"),
       ('purchaserNonPayment', 'the purchaser failed to pay for the allocated volumes (s.110(10)(d))')]
DGDO_RATE = F(7, 2)  # US$3.50, s.110(8), r.6(1)


def dgdo(a):
    ob, de = g(a, 'obligation'), g(a, 'delivered')
    vc = a.get('voluntaryContracts', 0)
    ex = a.get('excused', {})
    non_neg('obligation', ob)
    non_neg('delivered', de)
    non_neg('voluntaryContracts', vc)
    if not isobj(ex):
        must('excused', 'an object of excused quantities when given', ex)
    for k, _ in EXC:
        if g(ex, k) is not MISSING:
            non_neg(f'excused.{k}', ex[k])
    ag, pr = g(a, 'agreementPenaltyRate'), g(a, 'penaltyRate')
    if ag is not MISSING and pr is not MISSING:
        must('penaltyRate', 'left out when agreementPenaltyRate is stated (state one rate basis)', pr)
    if ag is not MISSING:
        non_neg('agreementPenaltyRate', ag)
    if pr is not MISSING:
        if not isobj(pr):
            must('penaltyRate', 'an object { value, source } when given', pr)
        non_neg('penaltyRate.value', g(pr, 'value'))
        text('penaltyRate.source', g(pr, 'source'))
    rate = DGDO_RATE
    if pr is not MISSING:
        rate = F(pr['value'])
    elif ag is not MISSING:
        rate = max(F(ag), DGDO_RATE)                          # s.110(8) proviso read with r.6(2)
    O, Dl, V = F(ob), F(de), F(vc)
    deemed = V >= O                                           # s.110(2)(a)
    und = max(F(0), O - Dl)
    left = F(0) if deemed else und
    rows = []
    for k, _ in EXC:
        q = F(ex.get(k) or 0)
        if q > 0:
            u = min(q, left)
            left -= u
            rows.append({'ground': k, 'stated': ex[k], 'applied': fl(u), '_u': u})
    appl = sum((r['_u'] for r in rows), F(0))
    pen_q = F(0) if deemed else und - appl
    pen = pen_q * rate
    why = []
    if deemed:
        why.append(f'voluntary contracts of {js(V)} are at or above the obligation {js(O)}: the lessee is deemed to have fulfilled its obligation (s.110(2)(a))')
    elif und == 0:
        why.append(f'delivered {js(Dl)} meets the obligation {js(O)}')
    else:
        why.append(f'delivered {js(Dl)} against the obligation {js(O)} leaves {js(und)} undelivered')
        for r in rows:
            if r['_u'] > 0:
                why.append(f"{js(r['_u'])} is excused: {dict(EXC)[r['ground']]}")
        if pen_q > 0:
            why.append(f'{js(pen_q)} is penalised at {js(rate)} per MMBtu: {js(pen)}; the lessee may not supply new midstream gas export operations (s.110(14)(a)) and export supply approvals require prior compliance (s.110(15))')
        else:
            why.append('the whole undelivered quantity is excused; no penalty')
    for r in rows:
        del r['_u']
    return {'obligation': ob, 'delivered': de, 'voluntaryContracts': vc, 'deemedFulfilled': deemed, 'undelivered': fl(und), 'excused': rows,
            'excusedApplied': fl(appl), 'penalised': fl(pen_q), 'rate': fl(rate), 'penalty': fl(pen), 'exportRestriction': pen_q > 0, 'reasons': why}


# ---------------------------------------------------------- cash flows
def cash_flows(a):
    c = g(a, 'contract')
    if not isobj(c):
        must('contract', 'an object of takeOrPay inputs', c)
    check_top(c, 'contract.')
    roy = g(a, 'royalty')
    if not isobj(roy):
        must('royalty', 'an object { terrain, inCountrySharePct } (no default terrain)', roy)
    one_of('royalty.terrain', g(roy, 'terrain'), ['onshore', 'shallow_water', 'deep_offshore', 'frontier'])
    if g(roy, 'inCountrySharePct') is not MISSING:
        pct('royalty.inCountrySharePct', roy['inCountrySharePct'])
    r = g(a, 'discountRate')
    if not (isnum(r) and r > -1):
        must('discountRate', 'a finite number above -1', r)
    int_at_least('baseYear', g(a, 'baseYear'), 1)
    s = F(roy.get('inCountrySharePct') or 0)
    # PIA Seventh Schedule para 10(6): 5% of the chargeable volume, 2.5% on gas utilised in-country
    rate = F(5, 100) * (1 - s / 100) + F(25, 1000) * (s / 100)
    top, X = top_core(c)
    rows = []
    for i, yr in enumerate(top['years']):
        net = X[i][9]
        dv = F(yr['taken']) * F(c['years'][i]['contractPrice'])
        ry = rate * dv
        rows.append({'year': yr['year'], 'sellerRevenue': fl(net), 'deliveredValue': fl(dv), 'royaltyRate': fl(rate), 'royalty': fl(ry), 'netAfterRoyalty': fl(net - ry),
                     'lines': {'regular': yr['regularRevenue'], 'makeUp': yr['makeUpRevenue'], 'deficiencyPayment': yr['deficiencyPayment'],
                               'shortfallPayment': -yr['shortfallPayment'], 'refund': -yr['refund']}, '_n': (net, net - ry)})
    R, base, first_year = F(r), int(a['baseYear']), rows[0]['year']
    npv = lambda j: sum((row['_n'][j] / (1 + R) ** (first_year + i - base) for i, row in enumerate(rows)), F(0))  # noqa: E731
    out = {'years': rows, 'royaltyRate': fl(rate), 'npvSellerRevenue': fl(npv(0)), 'npvNetAfterRoyalty': fl(npv(1)), 'takeOrPay': top}
    for row in rows:
        del row['_n']
    return out


FNS = {'toEnergy': to_energy, 'contractQuantities': contract_quantities, 'dailyBalance': daily_balance, 'takeOrPay': take_or_pay,
       'priceSeries': price_series, 'energyParitySlope': parity, 'domesticPrice': domestic_price, 'domesticGasObligation': dgdo, 'gsaCashFlows': cash_flows}


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
    c = {'id': cid, 'fn': fn, 'args': args, 'expected': exp, 'tol': tol}
    c.update(extra)
    CASES.append(c)
    return exp


def load(name):
    with open(os.path.join(FIX, name)) as f:
        return json.load(f)


# ================================================================== the cases
def export_contract(ex, prices):
    """The export feed GSA's take-or-pay inputs: the annual contract price and
    take-or-pay price are the annual averages of the monthly contract prices
    (CW GSA Article 15.2.6 Alternative 1); make-up gas at the stated per cent
    of the contract price (Article 15.2.7)."""
    avg = {r['year']: r['averagePrice'] for r in prices['annual']}
    yrs = []
    for y in ex['years']:
        cp = avg[y['year']]
        r = dict(y, contractPrice=cp, topPrice=cp, makeUpPrice=fl(F(cp) * ex['makeUpPricePct'] / 100))
        yrs.append(r)
    return {'years': yrs, 'topPct': ex['topPct'], 'makeUp': ex['makeUp'], 'carryForward': ex['carryForward']}


def power_contract(pw):
    return {'years': pw['years'], 'topPct': pw['topPct'], 'makeUp': pw['makeUp']}


def price_args(ex):
    p = ex['price']
    return {'months': ex['index'], 'formula': p['formula'], 'from': p['from'], 'to': p['to'], 'averagingMonths': p['averagingMonths'],
            'lagMonths': p['lagMonths'], 'resetMonths': p['resetMonths'], 'rounding': p['rounding'], 'reopeners': p['reopeners']}


def mseries(start, vals, name='oil'):
    t0 = mi(start)
    return [{'month': mname(t0 + i), 'values': {name: v} if not isinstance(v, dict) else v} for i, v in enumerate(vals)]


def Y(year, acq, taken, **kw):
    r = {'year': year, 'acq': acq, 'taken': taken, 'contractPrice': 3, 'topPrice': 3, 'makeUpPrice': 0}
    r.update(kw)
    return r


def build():
    pw = load('domestic-power.json')
    ex = load('export-feed.json')

    # ---- toEnergy
    e = pw['energy']
    case('energy-power-dcq', 'toEnergy', {'quantity': e['dcqMMscf'], 'quantityUnit': 'MMscf', 'heatingValue': e['heatingValue'], 'heatingValueUnit': e['heatingValueUnit'], 'heatingValueBasis': e['heatingValueBasis'], 'referenceConditions': e['referenceConditions']})
    e = ex['energy']
    case('energy-export-dcq', 'toEnergy', {'quantity': e['dcqMMscf'], 'quantityUnit': 'MMscf', 'heatingValue': e['heatingValue'], 'heatingValueUnit': e['heatingValueUnit'], 'heatingValueBasis': e['heatingValueBasis'], 'referenceConditions': e['referenceConditions']})
    base_e = {'quantity': 1, 'quantityUnit': 'MMSm3', 'heatingValue': 39, 'heatingValueUnit': 'MJ/Sm3', 'heatingValueBasis': 'gross', 'referenceConditions': '15 C and 101.325 kPa'}
    case('energy-metric', 'toEnergy', base_e)
    case('energy-metric-net', 'toEnergy', dict(base_e, heatingValue=35.1, heatingValueBasis='net'))
    case('energy-mixed-sm3-btu', 'toEnergy', dict(base_e, heatingValue=1050, heatingValueUnit='Btu/scf'))
    case('energy-mixed-scf-mj', 'toEnergy', dict(base_e, quantity=1000, quantityUnit='scf'))
    case('energy-zero-quantity', 'toEnergy', dict(base_e, quantity=0))
    case('energy-mscf', 'toEnergy', dict(base_e, quantity=1000, quantityUnit='Mscf', heatingValue=1000, heatingValueUnit='Btu/scf'))
    case('energy-refuse-unit', 'toEnergy', dict(base_e, quantityUnit='bcf'))
    case('energy-refuse-hv-zero', 'toEnergy', dict(base_e, heatingValue=0))
    case('energy-refuse-basis', 'toEnergy', dict(base_e, heatingValueBasis='higher'))
    case('energy-refuse-conditions-blank', 'toEnergy', dict(base_e, referenceConditions='  '))
    case('energy-refuse-unknown-key', 'toEnergy', dict(base_e, heatingvalue=39))
    case('energy-refuse-negative', 'toEnergy', dict(base_e, quantity=-1))

    # ---- contractQuantities
    case('cq-hmrc-ot05402-effective-swing', 'contractQuantities', {'dcq': 100, 'days': 365, 'maxDcqPct': 150, 'topPct': 90},
         published={'source': 'HMRC Oil Taxation Manual OT05402', 'printed': {'effectiveSwing': 1.66}, 'rule': 'printed truncated: 150/90 = 1.666...; the manual prints 1.66 and a factor of 6.6'})
    case('cq-power-2027', 'contractQuantities', {'dcq': pw['dcq'], 'year': 2027, 'maxDcqPct': pw['maxDcqPct'], 'topPct': pw['topPct']})
    case('cq-power-2028-leap', 'contractQuantities', {'dcq': pw['dcq'], 'year': 2028, 'maxDcqPct': pw['maxDcqPct'], 'topPct': pw['topPct']})
    case('cq-year-2100-not-leap', 'contractQuantities', {'dcq': 1000, 'year': 2100})
    case('cq-year-2000-leap', 'contractQuantities', {'dcq': 1000, 'year': 2000})
    case('cq-period-full-year', 'contractQuantities', {'dcq': ex['dcq'], 'period': {'start': '2027-01-01', 'end': '2028-01-01'}, 'topPct': ex['topPct']})
    case('cq-period-first-contract-year', 'contractQuantities', {'dcq': ex['dcq'], 'period': {'start': '2027-07-01', 'end': '2028-01-01'}, 'maxDcqPct': ex['maxDcqPct']})
    case('cq-days-stated', 'contractQuantities', {'dcq': 50000, 'days': 350, 'topPct': 85})
    case('cq-top-zero-without-swing', 'contractQuantities', {'dcq': 50000, 'days': 360, 'topPct': 0})
    case('cq-refuse-no-day-count', 'contractQuantities', {'dcq': 1000})
    case('cq-refuse-two-day-counts', 'contractQuantities', {'dcq': 1000, 'days': 365, 'year': 2027})
    case('cq-refuse-period-reversed', 'contractQuantities', {'dcq': 1000, 'period': {'start': '2028-01-01', 'end': '2027-01-01'}})
    case('cq-refuse-period-not-a-date', 'contractQuantities', {'dcq': 1000, 'period': {'start': '2027-02-30', 'end': '2028-01-01'}})
    case('cq-refuse-maxdcq-below-100', 'contractQuantities', {'dcq': 1000, 'days': 365, 'maxDcqPct': 90})
    case('cq-refuse-top-zero-with-swing', 'contractQuantities', {'dcq': 1000, 'days': 365, 'maxDcqPct': 110, 'topPct': 0})
    case('cq-refuse-dcq-zero', 'contractQuantities', {'dcq': 0, 'days': 365})
    case('cq-refuse-days-fraction', 'contractQuantities', {'dcq': 1000, 'days': 365.5})
    case('cq-refuse-unknown-period-key', 'contractQuantities', {'dcq': 1000, 'period': {'start': '2027-01-01', 'finish': '2028-01-01'}})

    # ---- dailyBalance
    jan = pw['january2027']
    case('daily-power-january-2027', 'dailyBalance', {'dcq': jan['dcq'], 'maxDcqPct': jan['maxDcqPct'], 'days': jan['days']})
    d0 = {'dcq': 100, 'maxDcqPct': 120}
    case('daily-tolerance-covers-the-gap', 'dailyBalance', dict(d0, deliveryTolerance=5, days=[{'date': '2027-03-01', 'nominated': 100, 'available': 95, 'taken': 95}]))
    case('daily-tolerance-one-short', 'dailyBalance', dict(d0, deliveryTolerance=5, days=[{'date': '2027-03-01', 'nominated': 100, 'available': 94, 'taken': 94}]))
    case('daily-over-nomination-failed', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 150, 'available': 0, 'taken': 0}]))
    case('daily-fm-part-day', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 100, 'available': 40, 'taken': 40, 'forceMajeure': 30, 'maintenance': 10}]))
    case('daily-fm-whole-day-with-nomination', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 100, 'available': 0, 'taken': 0, 'forceMajeure': 100}]))
    case('daily-available-not-taken', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 100, 'available': 100, 'taken': 60}]))
    case('daily-no-maxdcq', 'dailyBalance', {'dcq': 100, 'days': [{'date': '2027-03-01', 'nominated': 180, 'available': 180, 'taken': 180}]})
    case('daily-buyer-caused', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 100, 'available': 20, 'taken': 20, 'buyerCaused': True}]))
    case('daily-refuse-taken-above-available', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 100, 'available': 50, 'taken': 60}]))
    case('daily-refuse-dates-not-ascending', 'dailyBalance', dict(d0, days=[{'date': '2027-03-02', 'nominated': 1, 'available': 1, 'taken': 1}, {'date': '2027-03-02', 'nominated': 1, 'available': 1, 'taken': 1}]))
    case('daily-refuse-fm-over-dcq', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 0, 'available': 0, 'taken': 0, 'forceMajeure': 80, 'maintenance': 30}]))
    case('daily-refuse-buyer-caused-text', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 1, 'available': 1, 'taken': 1, 'buyerCaused': 'yes'}]))
    case('daily-refuse-unknown-day-key', 'dailyBalance', dict(d0, days=[{'date': '2027-03-01', 'nominated': 1, 'available': 1, 'taken': 1, 'forcemajeure': 1}]))
    case('daily-refuse-no-days', 'dailyBalance', dict(d0, days=[]))
    case('daily-refuse-bad-date', 'dailyBalance', dict(d0, days=[{'date': '2027-3-1', 'nominated': 1, 'available': 1, 'taken': 1}]))

    # ---- takeOrPay: the fixtures
    case('top-power', 'takeOrPay', power_contract(pw))
    prices = case('price-export', 'priceSeries', price_args(ex))
    case('top-export', 'takeOrPay', export_contract(ex, prices))
    # ---- takeOrPay: one rule at a time
    mu = {'periodYears': 2, 'order': 'after-adjusted-acq', 'endOfTerm': 'forfeit'}
    three = [Y(2027, 1000, 600), Y(2028, 1000, 1100), Y(2029, 1000, 1000)]
    case('top-order-after-adjusted-acq', 'takeOrPay', {'years': three, 'topPct': 80, 'makeUp': mu})
    case('top-order-after-top-quantity', 'takeOrPay', {'years': three, 'topPct': 80, 'makeUp': dict(mu, order='after-top-quantity')})
    case('top-order-first', 'takeOrPay', {'years': three, 'topPct': 80, 'makeUp': dict(mu, order='first')})
    case('top-order-first-creates-deficiency', 'takeOrPay', {'years': [Y(2027, 1000, 600), Y(2028, 1000, 800), Y(2029, 1000, 1000)], 'topPct': 80, 'makeUp': dict(mu, order='first')})
    case('top-exactly-met', 'takeOrPay', {'years': [Y(2027, 1000, 800), Y(2028, 1000, 800)], 'topPct': 80, 'makeUp': mu})
    case('top-one-unit-short', 'takeOrPay', {'years': [Y(2027, 1000, 799), Y(2028, 1000, 800)], 'topPct': 80, 'makeUp': mu})
    case('top-zero-take-year', 'takeOrPay', {'years': [Y(2027, 1000, 0), Y(2028, 1000, 1000)], 'topPct': 80, 'makeUp': mu})
    exp4 = [Y(2027, 1000, 600), Y(2028, 1000, 1000), Y(2029, 1000, 1100), Y(2030, 1000, 1000)]
    case('top-makeup-on-last-day-of-period', 'takeOrPay', {'years': exp4, 'topPct': 80, 'makeUp': mu})
    case('top-makeup-one-year-late', 'takeOrPay', {'years': [Y(2027, 1000, 600), Y(2028, 1000, 1000), Y(2029, 1000, 1000), Y(2030, 1000, 1100)], 'topPct': 80, 'makeUp': mu})
    case('top-makeup-period-zero', 'takeOrPay', {'years': [Y(2027, 1000, 600), Y(2028, 1000, 1100)], 'topPct': 80, 'makeUp': dict(mu, periodYears=0)})
    case('top-fifo-two-deficiencies', 'takeOrPay', {'years': [Y(2027, 1000, 700), Y(2028, 1000, 750), Y(2029, 1000, 1080), Y(2030, 1000, 1030), Y(2031, 1000, 1000)], 'topPct': 80, 'makeUp': dict(mu, periodYears=3)})
    case('top-force-majeure-and-shortfall', 'takeOrPay', {'years': [Y(2027, 1000, 600, forceMajeure=100, sellerShortfall=50, shortfallPrice=1.5, maintenance=20, permittedReduction=30), Y(2028, 1000, 800)], 'topPct': 80, 'makeUp': mu})
    case('top-fm-whole-year', 'takeOrPay', {'years': [Y(2027, 1000, 0, forceMajeure=1000), Y(2028, 1000, 800)], 'topPct': 80, 'makeUp': mu})
    case('top-end-of-term-refund', 'takeOrPay', {'years': [Y(2027, 1000, 600, topPrice=2.5), Y(2028, 1000, 1050, topPrice=3.25), Y(2029, 1000, 700, topPrice=4)], 'topPct': 80, 'makeUp': dict(mu, periodYears=5, endOfTerm='refund')})
    case('top-end-of-term-forfeit', 'takeOrPay', {'years': [Y(2027, 1000, 600, topPrice=2.5), Y(2028, 1000, 1050, topPrice=3.25), Y(2029, 1000, 700, topPrice=4)], 'topPct': 80, 'makeUp': dict(mu, periodYears=5)})
    case('top-single-year', 'takeOrPay', {'years': [Y(2027, 1000, 500)], 'topPct': 90, 'makeUp': mu})
    case('top-makeup-price', 'takeOrPay', {'years': [Y(2027, 1000, 600, contractPrice=4, topPrice=4), Y(2028, 1000, 1150, contractPrice=5, topPrice=5, makeUpPrice=0.5)], 'topPct': 80, 'makeUp': mu})
    cfy = [Y(2027, 1000, 1100), Y(2028, 1000, 1050), Y(2029, 1000, 700), Y(2030, 1000, 600), Y(2031, 1000, 1000)]
    cf = {'periodYears': 2, 'base': 'adjusted-acq', 'capPct': 100}
    case('top-carry-forward-adjusted-acq', 'takeOrPay', {'years': cfy, 'topPct': 80, 'makeUp': mu, 'carryForward': cf})
    case('top-carry-forward-top-quantity', 'takeOrPay', {'years': cfy, 'topPct': 80, 'makeUp': mu, 'carryForward': dict(cf, base='top-quantity')})
    case('top-carry-forward-capped', 'takeOrPay', {'years': cfy, 'topPct': 80, 'makeUp': mu, 'carryForward': dict(cf, capPct=50)})
    case('top-carry-forward-expires', 'takeOrPay', {'years': [Y(2027, 1000, 1100), Y(2028, 1000, 1000), Y(2029, 1000, 1000), Y(2030, 1000, 700)], 'topPct': 80, 'makeUp': mu, 'carryForward': dict(cf, periodYears=2)})
    case('top-carry-forward-off-by-default', 'takeOrPay', {'years': cfy, 'topPct': 80, 'makeUp': mu})
    # refusals
    tb = {'years': three, 'topPct': 80, 'makeUp': mu}
    case('top-refuse-no-makeup', 'takeOrPay', {'years': three, 'topPct': 80})
    case('top-refuse-order', 'takeOrPay', dict(tb, makeUp=dict(mu, order='fifo')))
    case('top-refuse-end-of-term', 'takeOrPay', dict(tb, makeUp=dict(mu, endOfTerm='extend')))
    case('top-refuse-years-gap', 'takeOrPay', dict(tb, years=[Y(2027, 1000, 800), Y(2029, 1000, 800)]))
    case('top-refuse-shortfall-without-price', 'takeOrPay', dict(tb, years=[Y(2027, 1000, 800, sellerShortfall=5)]))
    case('top-refuse-reductions-above-acq', 'takeOrPay', dict(tb, years=[Y(2027, 100, 80, forceMajeure=60, maintenance=50)]))
    case('top-refuse-cap-above-100', 'takeOrPay', dict(tb, carryForward=dict(cf, capPct=120)))
    case('top-refuse-cf-period-zero', 'takeOrPay', dict(tb, carryForward=dict(cf, periodYears=0)))
    case('top-refuse-toppct', 'takeOrPay', dict(tb, topPct=101))
    case('top-refuse-missing-top-price', 'takeOrPay', dict(tb, years=[{'year': 2027, 'acq': 1000, 'taken': 800, 'contractPrice': 3, 'makeUpPrice': 0}]))
    case('top-refuse-unknown-key-makeup', 'takeOrPay', {'years': three, 'topPct': 80, 'makeup': mu})
    case('top-refuse-unknown-year-key', 'takeOrPay', dict(tb, years=[dict(Y(2027, 1000, 800), fm=3)]))
    case('top-refuse-unknown-cf-key', 'takeOrPay', dict(tb, carryForward=dict(cf, cap=50)))
    case('top-refuse-period-fraction', 'takeOrPay', dict(tb, makeUp=dict(mu, periodYears=1.5)))

    # ---- priceSeries
    ecs = mseries('2026-01', [10, 15, 22.5, 30, 40], 'jcc')
    sc = {'type': 'oil-indexed', 'index': 'jcc', 'slope': 0.1485, 'constant': 0.8, 'sCurve': {'lowKink': 15, 'highKink': 30, 'lowSlope': 0, 'highSlope': 0}}
    case('price-ecs-figure-51', 'priceSeries', {'months': ecs, 'formula': sc, 'from': '2026-01', 'to': '2026-05'},
         published={'source': 'Energy Charter Secretariat (2007) Figure 51', 'printed': {'slope': 0.1485, 'constant': 0.8, 'floorAt': 15, 'capAt': 30, 'axis': [2.5, 5.5]},
                    'rule': 'LNG = 0.1485 x JCC + 0.80 between the floor at 15 and the cap at 30 $/bbl; flat outside; the plateau levels 3.0275 and 5.255 follow from the printed parameters and lie inside the printed axis 2.50 to 5.50'})
    case('price-ecs-plain-linear', 'priceSeries', {'months': ecs, 'formula': {'type': 'oil-indexed', 'index': 'jcc', 'slope': 0.1485, 'constant': 0.8}, 'from': '2026-01', 'to': '2026-05'})
    case('price-oil-floor-ceiling', 'priceSeries', {'months': ecs, 'formula': {'type': 'oil-indexed', 'index': 'jcc', 'slope': 0.1485, 'constant': 0.8, 'floor': 3.5, 'ceiling': 4.5}, 'from': '2026-01', 'to': '2026-05'})
    kinks = mseries('2026-01', [49.99, 50, 50.01, 89.99, 90, 90.01], 'oil')
    case('price-s-curve-kinks', 'priceSeries', {'months': kinks, 'formula': {'type': 'oil-indexed', 'index': 'oil', 'slope': 0.12, 'constant': 0.5, 'sCurve': {'lowKink': 50, 'highKink': 90, 'lowSlope': 0.06, 'highSlope': 0.03}}, 'from': '2026-01', 'to': '2026-06'})
    hh = mseries('2026-01', [2.5, 3.0, 3.5, 4.0], 'hh')
    case('price-oies-hub-csp', 'priceSeries', {'months': hh, 'formula': {'type': 'hub-indexed', 'index': 'hh', 'multiplier': 1.15, 'adder': 2.25}, 'from': '2026-01', 'to': '2026-04'},
         published={'source': 'OIES Paper NG 175 (2022) section 2.2', 'printed': {'multiplier': 1.15}, 'rule': 'CSP = 1.15 x HH + Xy; Xy is contract specific (2.25 here is ours)'})
    six = mseries('2025-01', [60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 86, 84, 82, 80], 'oil')
    lin = {'type': 'oil-indexed', 'index': 'oil', 'slope': 0.1, 'constant': 1}
    case('price-avg6-lag1-reset3', 'priceSeries', {'months': six, 'formula': lin, 'from': '2025-08', 'to': '2026-06', 'averagingMonths': 6, 'lagMonths': 1, 'resetMonths': 3})
    case('price-avg3-lag0-reset1', 'priceSeries', {'months': six, 'formula': lin, 'from': '2025-03', 'to': '2026-06', 'averagingMonths': 3, 'lagMonths': 0})
    case('price-avg1-lag3', 'priceSeries', {'months': six, 'formula': lin, 'from': '2025-04', 'to': '2025-12', 'lagMonths': 3})
    case('price-reset12-annual', 'priceSeries', {'months': six, 'formula': lin, 'from': '2025-07', 'to': '2026-06', 'averagingMonths': 6, 'lagMonths': 1, 'resetMonths': 12})
    bk = [{'month': mname(mi('2025-10') + i), 'values': {'fo': v1, 'cpi': v2}} for i, (v1, v2) in enumerate([(400, 100), (420, 101), (380, 102), (500, 103), (460, 104), (300, 105)])]
    basket = {'type': 'basket', 'basePrice': 5, 'weights': {'fo': 0.6, 'cpi': 0.4}, 'baseValues': {'fo': 400, 'cpi': 100}}
    case('price-cw-basket', 'priceSeries', {'months': bk, 'formula': basket, 'from': '2025-12', 'to': '2026-03', 'averagingMonths': 2, 'lagMonths': 1})
    case('price-cw-basket-index-floors', 'priceSeries', {'months': bk, 'formula': dict(basket, indexFloors={'fo': 410}, indexCeilings={'fo': 450, 'cpi': 102.5}), 'from': '2025-12', 'to': '2026-03', 'averagingMonths': 2, 'lagMonths': 1})
    case('price-escalated', 'priceSeries', {'months': mseries('2027-01', [0] * 30, 'none'), 'formula': {'type': 'escalated', 'basePrice': 2, 'baseMonth': '2027-04', 'ratePctPerYear': 2.5}, 'from': '2027-04', 'to': '2029-06'})
    case('price-fixed', 'priceSeries', {'months': mseries('2027-01', [1, 2], 'x'), 'formula': {'type': 'fixed', 'price': 2.18}, 'from': '2027-01', 'to': '2027-03', 'reopeners': ['2027-02']})
    # the 4-decimal rule: 1 + 0.1 x X at X chosen so the fifth decimal is exactly 5, 4, and 5 followed by 9s
    rnd_vals = [11.2345, 11.2344, 11.23459, 11.23449, 100.00005, 0.00005]
    case('price-round-model-4dp', 'priceSeries', {'months': mseries('2026-01', rnd_vals, 'x'), 'formula': {'type': 'oil-indexed', 'index': 'x', 'slope': 1, 'constant': 0}, 'from': '2026-01', 'to': '2026-06', 'rounding': 'model-gsa-4dp'})
    case('price-export-unrounded', 'priceSeries', dict(price_args(ex), rounding='none'))
    # refusals
    pb = {'months': six, 'formula': lin, 'from': '2025-08', 'to': '2026-06', 'averagingMonths': 6, 'lagMonths': 1, 'resetMonths': 3}
    case('price-refuse-window-missing', 'priceSeries', dict(pb, **{'from': '2025-03'}))
    case('price-refuse-weights-sum', 'priceSeries', {'months': bk, 'formula': dict(basket, weights={'fo': 0.6, 'cpi': 0.5}), 'from': '2025-12', 'to': '2026-03', 'averagingMonths': 2, 'lagMonths': 1})
    case('price-refuse-type', 'priceSeries', dict(pb, formula={'type': 'jcc-linked'}))
    case('price-refuse-unknown-scurve-key', 'priceSeries', dict(pb, formula=dict(lin, sCurve={'lowKink': 50, 'highkink': 90, 'lowSlope': 0, 'highSlope': 0})))
    case('price-refuse-unknown-formula-key', 'priceSeries', dict(pb, formula=dict(lin, cap=5)))
    case('price-refuse-to-before-from', 'priceSeries', dict(pb, to='2025-07'))
    case('price-refuse-months-gap', 'priceSeries', dict(pb, months=[six[0], six[2]]))
    case('price-refuse-index-name', 'priceSeries', dict(pb, formula=dict(lin, index='brent')))
    case('price-refuse-kinks-reversed', 'priceSeries', dict(pb, formula=dict(lin, sCurve={'lowKink': 90, 'highKink': 50, 'lowSlope': 0, 'highSlope': 0})))
    case('price-refuse-floor-above-ceiling', 'priceSeries', dict(pb, formula=dict(lin, floor=9, ceiling=8)))
    case('price-refuse-rounding', 'priceSeries', dict(pb, rounding='4dp'))
    case('price-refuse-negative-price', 'priceSeries', dict(pb, formula=dict(lin, constant=-20)))
    case('price-refuse-uneven-values', 'priceSeries', dict(pb, months=[six[0], {'month': '2025-02', 'values': {'oil': 1, 'hh': 2}}]))
    case('price-refuse-basket-base-key', 'priceSeries', {'months': bk, 'formula': dict(basket, baseValues={'fo': 400, 'cpi': 100, 'gdp': 1}), 'from': '2025-12', 'to': '2026-03', 'averagingMonths': 2, 'lagMonths': 1})
    case('price-refuse-escalated-before-base', 'priceSeries', {'months': mseries('2027-01', [0], 'x'), 'formula': {'type': 'escalated', 'basePrice': 2, 'baseMonth': '2027-04', 'ratePctPerYear': 2.5}, 'from': '2027-01', 'to': '2027-06'})
    case('price-refuse-reopener', 'priceSeries', dict(pb, reopeners=['2031']))
    case('price-refuse-lag-negative', 'priceSeries', dict(pb, lagMonths=-1))

    # ---- energyParitySlope
    case('parity-ecs-0172', 'energyParitySlope', {'mmbtuPerBarrel': 5.8},
         published={'source': 'Energy Charter Secretariat (2007) section 4.5.3.3', 'printed': {'slope': 0.172}, 'rule': 'the theoretical heat-equivalence slope printed as 0.172; 1 / 5.8 = 0.172413...; 5.8 MMBtu per barrel is the EIA crude oil heat content (Monthly Energy Review Table A2)'})
    case('parity-6', 'energyParitySlope', {'mmbtuPerBarrel': 6})
    case('parity-refuse-zero', 'energyParitySlope', {'mmbtuPerBarrel': 0})
    case('parity-refuse-unknown-key', 'energyParitySlope', {'mmbtu': 5.8})

    # ---- domesticPrice
    for yr, dbp in ((2026, 2.18), (2025, 2.13)):
        case(f'dp-power-{yr}', 'domesticPrice', {'sector': 'power', 'domesticBasePrice': dbp},
             published={'source': 'reported NMDPRA domestic base price', 'printed': {'price': dbp}})
        case(f'dp-commercial-{yr}', 'domesticPrice', {'sector': 'commercial', 'domesticBasePrice': dbp},
             published={'source': 'reported NMDPRA wholesale price for the commercial sector', 'printed': {'price': {2026: 2.68, 2025: 2.63}[yr]}, 'rule': 's.167(6): domestic base price + US$0.50 per MMBtu'})
    case('dp-distributor-within', 'domesticPrice', {'sector': 'gas-distributor', 'domesticBasePrice': 2.18, 'negotiatedPrice': 2.5})
    case('dp-distributor-at-ceiling', 'domesticPrice', {'sector': 'gas-distributor', 'domesticBasePrice': 2.18, 'negotiatedPrice': 2.68})
    case('dp-distributor-above', 'domesticPrice', {'sector': 'gas-distributor', 'domesticBasePrice': 2.18, 'negotiatedPrice': 2.9})
    for cm, tag in ((450, 'inside'), (200, 'floor'), (600, 'ceiling'), (250, 'at-prp'), (0, 'zero-cmpp')):
        case(f'dp-gbi-urea-{tag}', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2.18, 'product': 'urea', 'cmpp': cm})
    case('dp-gbi-gtl-diesel', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2.18, 'product': 'low-sulphur-diesel-gtl', 'cmpp': 520})
    case('dp-gbi-exactly-dbp', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2, 'product': 'ammonia', 'cmpp': 500})
    case('dp-gbi-exactly-floor', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2.18, 'product': 'methanol', 'cmpp': 225})
    case('dp-gbi-schedule-override', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2.18, 'product': 'ammonia', 'cmpp': 450, 'schedule': {'nrp': 1.2, 'prp': 300, 'source': 'illustrative regulation (synthetic)'}})
    case('dp-power-transport', 'domesticPrice', {'sector': 'power', 'domesticBasePrice': 2.18, 'transportTariff': 0.8})
    case('dp-refuse-no-dbp', 'domesticPrice', {'sector': 'power'})
    case('dp-refuse-sector', 'domesticPrice', {'sector': 'industrial', 'domesticBasePrice': 2.18})
    case('dp-refuse-dbp-below-floor', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 0.8, 'product': 'urea', 'cmpp': 300})
    case('dp-refuse-negotiated-for-power', 'domesticPrice', {'sector': 'power', 'domesticBasePrice': 2.18, 'negotiatedPrice': 2})
    case('dp-refuse-distributor-no-price', 'domesticPrice', {'sector': 'gas-distributor', 'domesticBasePrice': 2.18})
    case('dp-refuse-no-cmpp', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2.18, 'product': 'urea'})
    case('dp-refuse-product', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2.18, 'product': 'fertiliser', 'cmpp': 300})
    case('dp-refuse-product-for-power', 'domesticPrice', {'sector': 'commercial', 'domesticBasePrice': 2.18, 'product': 'urea'})
    case('dp-refuse-schedule-source', 'domesticPrice', {'sector': 'gas-based-industry', 'domesticBasePrice': 2.18, 'product': 'urea', 'cmpp': 300, 'schedule': {'nrp': 1, 'prp': 250, 'source': ''}})
    case('dp-refuse-unknown-key', 'domesticPrice', {'sector': 'power', 'domesticBasePrice': 2.18, 'dbp': 2})

    # ---- domesticGasObligation
    dg = pw['dgdo']
    case('dgdo-power-2028', 'domesticGasObligation', {'obligation': dg['obligation'], 'delivered': dg['delivered'], 'excused': dg['excused']})
    case('dgdo-deemed-by-contracts', 'domesticGasObligation', {'obligation': 1000, 'delivered': 200, 'voluntaryContracts': 1000})
    case('dgdo-contracts-one-short', 'domesticGasObligation', {'obligation': 1000, 'delivered': 200, 'voluntaryContracts': 999})
    case('dgdo-met', 'domesticGasObligation', {'obligation': 1000, 'delivered': 1000})
    case('dgdo-over-delivered', 'domesticGasObligation', {'obligation': 1000, 'delivered': 1200})
    case('dgdo-all-excused', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'excused': {'forceMajeure': 250, 'transportUnavailable': 300}})
    case('dgdo-excuses-in-order', 'domesticGasObligation', {'obligation': 1000, 'delivered': 500, 'excused': {'purchaserNonPayment': 100, 'forceMajeure': 150, 'purchaserCannotAccept': 50, 'transportUnavailable': 25}})
    case('dgdo-agreement-above', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'agreementPenaltyRate': 5})
    case('dgdo-agreement-below', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'agreementPenaltyRate': 2})
    case('dgdo-agreement-equal', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'agreementPenaltyRate': 3.5})
    case('dgdo-adjusted-rate', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'penaltyRate': {'value': 4.25, 'source': 'illustrative Commission regulation under s.110(9) (synthetic)'}})
    case('dgdo-refuse-two-rates', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'agreementPenaltyRate': 5, 'penaltyRate': {'value': 4, 'source': 'x'}})
    case('dgdo-refuse-rate-source', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'penaltyRate': {'value': 4}})
    case('dgdo-refuse-unknown-excuse', 'domesticGasObligation', {'obligation': 1000, 'delivered': 600, 'excused': {'pipelineOutage': 5}})
    case('dgdo-refuse-negative', 'domesticGasObligation', {'obligation': -1, 'delivered': 600})

    # ---- gsaCashFlows
    case('cf-power', 'gsaCashFlows', {'contract': power_contract(pw), 'royalty': pw['royalty'], 'discountRate': pw['discountRate'], 'baseYear': pw['baseYear']})
    case('cf-export', 'gsaCashFlows', {'contract': export_contract(ex, prices), 'royalty': ex['royalty'], 'discountRate': ex['discountRate'], 'baseYear': ex['baseYear']})
    case('cf-small-zero-rate', 'gsaCashFlows', {'contract': {'years': three, 'topPct': 80, 'makeUp': mu}, 'royalty': {'terrain': 'deep_offshore', 'inCountrySharePct': 40}, 'discountRate': 0, 'baseYear': 2027})
    case('cf-refuse-no-royalty', 'gsaCashFlows', {'contract': {'years': three, 'topPct': 80, 'makeUp': mu}, 'discountRate': 0.1, 'baseYear': 2026})
    case('cf-refuse-terrain', 'gsaCashFlows', {'contract': {'years': three, 'topPct': 80, 'makeUp': mu}, 'royalty': {'terrain': 'marginal_field'}, 'discountRate': 0.1, 'baseYear': 2026})
    case('cf-refuse-rate', 'gsaCashFlows', {'contract': {'years': three, 'topPct': 80, 'makeUp': mu}, 'royalty': {'terrain': 'onshore'}, 'discountRate': -1, 'baseYear': 2026})
    case('cf-refuse-contract-inner', 'gsaCashFlows', {'contract': {'years': three, 'topPct': 80, 'makeUp': dict(mu, order='lifo')}, 'royalty': {'terrain': 'onshore'}, 'discountRate': 0.1, 'baseYear': 2026})
    case('cf-refuse-unknown-contract-key', 'gsaCashFlows', {'contract': {'years': three, 'topPct': 80, 'makeUp': mu, 'extra': 1}, 'royalty': {'terrain': 'onshore'}, 'discountRate': 0.1, 'baseYear': 2026})

    # ---- one unknown top-level key for every function, and a non-object
    for fn in FNS:
        case(f'{fn}-refuse-unknown-top-key', fn, {'notAKey': 1})
    case('options-refuse-array', 'toEnergy', [1, 2])


def main():
    build()
    ids = [c['id'] for c in CASES]
    if len(set(ids)) != len(ids):
        sys.exit('duplicate case ids')
    doc = {
        'module': 'gasContract',
        'generatedBy': 'tools/validation/economics/oracle_gascontract.py',
        'engine': 'engines/economics/gasContract.js',
        'tolerance': {'absoluteFloor': 1e-9, 'note': 'relative tol per case (1e-12); absolute floor 1e-9 in the quantity or money unit'},
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
