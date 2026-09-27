#!/usr/bin/env python3
"""Independent stdlib oracle for engines/supplychain/inventory.js (Supply Chain SC3).

    python3 tools/validation/supplychain/oracle_inventory.py

Writes test-data/supplychain/goldens/inventory_cases.json. Reads no JavaScript
and imports nothing from the engines. Every rule is coded here from the
published text (sources in FINDINGS-inventory.md), by a different road:

  exact          every stated input is read as the exact rational value of
                 the double it is (fractions.Fraction); sums, products and
                 shares stay exact; a figure leaves the oracle as the nearest
                 double only at the end.
  roots          square roots in decimal.Decimal at 60 digits.
  normal         Phi from the Maclaurin series of erf in Decimal at 90 digits
                 (no rational approximation, no incomplete gamma); Phi^-1 and
                 the fill-rate k by bisection in Decimal to 1e-40; the unit
                 normal loss G(k) = phi(k) - k (1 - Phi(k)) in Decimal.
  Poisson        each probability as exp(-m) m^x / x! in Decimal; the loss
                 E[(X - s)+] as m - s + sum_{x<s} (s - x) p(x) (the direct
                 partial expectation, where the engine recurses).
  discounts      every candidate costed from the lot-cost definition on exact
                 Fractions; the band of a quantity found by search.
  Monte Carlo    mulberry32 in unsigned 32-bit integers; the triangular
                 inverse CDF from its definition; basicStats' floor-index
                 percentiles by integer arithmetic; means by math.fsum.
  printing       JavaScript String(x) (js_num); money to 2 and figures to 6
                 decimals, half away from zero, from the exact value; the
                 oracle stops when an exact value lies within 1e-9 of a
                 rounding tie (it could then disagree with the engine's double).

It also carries the worked examples the sources publish (Harris 1913; Caplice,
MIT ESD.260J lectures 8, 11, 12, 13; MIL-HDBK-338B 5.3.8.1) with the printed
figures beside the exact ones.
"""
import json
import math
import os
import sys
from decimal import Decimal, getcontext, ROUND_HALF_UP, ROUND_FLOOR, ROUND_CEILING
from fractions import Fraction as F

getcontext().prec = 90
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FIX = os.path.join(ROOT, 'test-data', 'supplychain', 'ekene-materials', 'register.json')
OUT = os.path.join(ROOT, 'test-data', 'supplychain', 'goldens', 'inventory_cases.json')

EXCEEDANCE = 'P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.'
PI = Decimal('3.14159265358979323846264338327950288419716939937510582097494459230781640628620899862803482534211706798214808651')
CAPS = {'MAX_ITEMS': 5000, 'MAX_CRITERIA': 20, 'MAX_CLASSES': 10, 'MAX_BREAKS': 20, 'MAX_BANDS': 10, 'MAX_DECIMALS': 6,
        'MAX_ITERATIONS': 200000, 'MAX_POISSON_MEAN': 500, 'MAX_SPARES': 1000}


class OracleStop(Exception):
    pass


# ------------------------------------------------------------------ formatting
def js_num(x):
    """JavaScript String(x) for a double."""
    if isinstance(x, bool) or x is None:
        raise OracleStop(f'js_num of {x!r}')
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
    ip, fp = (mant.split('.') + [''])[:2]
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
    return sign + digits[0] + ('.' + digits[1:] if k > 1 else '') + 'e' + es


def D(x):
    if isinstance(x, Decimal):
        return x
    if isinstance(x, F):
        return Decimal(x.numerator) / Decimal(x.denominator)
    return Decimal(x)


def rounded(x, places):
    """Number(x.toFixed(places)): half away from zero on the value. A float
    is a double the engine holds bit for bit, rounded as it is; an exact
    value (Fraction or Decimal) stops the oracle when it lies within 1e-9 of
    a rounding tie, where the engine's double could round either way."""
    q = Decimal(1).scaleb(-places)
    d = Decimal(x) if isinstance(x, (float, int)) else D(x)
    if not isinstance(x, (float, int)):
        scaled = abs(d) / q
        frac = scaled - scaled.to_integral_value(rounding=ROUND_FLOOR)
        if abs(frac - Decimal('0.5')) < Decimal('1e-9'):
            raise OracleStop(f'value {d} is within 1e-9 of a rounding tie at {places} decimals')
    return float(d.quantize(q, rounding=ROUND_HALF_UP))


def money(x):
    return js_num(rounded(x, 2))


def dec(x):
    return js_num(rounded(x, 6))


def fmt(x):
    return js_num(x)


def plural(n, one, many=None):
    return f'{n} {one if n == 1 else (many or one + "s")}'


def unit(text, x, one):
    return f'{text} {one if float(x) == 1 else one + "s"}'


def key12(x):
    """Number(x.toPrecision(12)) of the value x (exact or double)."""
    d = D(x)
    if d == 0:
        return 0.0
    e = d.adjusted()
    q = Decimal(1).scaleb(e - 11)
    return float(d.quantize(q, rounding=ROUND_HALF_UP))


def fl(x):
    return float(x)


class _Missing:
    pass


MISSING = _Missing()


def arg(o, k):
    return o[k] if isinstance(o, dict) and k in o else MISSING


def refuse(field, msg):
    return {'error': True, 'field': field, 'message': f'{field} {msg}'}


def isnum(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def isint(v):
    return isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, float) and v.is_integer())


def isobj(v):
    return isinstance(v, dict)


def Fx(v):
    return F(v)


def sqrtF(x):
    return D(x).sqrt()


# ------------------------------------------------------------------ keys
TRIANGLE = (['min', 'mode', 'max'], {})
ROUNDING_K = (['rule', 'multiple'], {})
SHAPES = {
    'criticality': (['criteria', 'scoreMax', 'items', 'classes', 'topClassOnMaxScore'],
                    {'criteria': ('list', (['id', 'label', 'weight'], {})), 'items': ('list', (['id', 'name', 'scores'], {})),
                     'classes': ('list', (['label', 'minScore'], {}))}),
    'abcClassification': (['items', 'cutoffs', 'boundaryRule'], {'items': ('list', (['id', 'name', 'annualUsage', 'unitCost'], {})), 'cutoffs': (['aPct', 'bPct'], {})}),
    'eoq': (['annualDemand', 'orderCost', 'holdingCostPerUnitYear', 'unitCost', 'holdingRate', 'rounding'], {'rounding': ROUNDING_K}),
    'quantityDiscount': (['annualDemand', 'orderCost', 'holdingRate', 'breaks', 'discountType', 'rounding'],
                         {'breaks': ('list', (['minQuantity', 'unitPrice'], {})), 'rounding': ROUNDING_K}),
    'safetyStock': (['demandMean', 'demandSd', 'leadTime', 'leadTimeSd', 'reviewPeriod', 'serviceMeasure', 'serviceLevel', 'orderQuantity',
                     'safetyFactorRounding', 'minimumSafetyFactor', 'rounding'], {'safetyFactorRounding': (['rule', 'decimals'], {}), 'rounding': ROUNDING_K}),
    'poissonStock': (['demandRate', 'leadTime', 'reviewPeriod', 'serviceMeasure', 'serviceLevel', 'orderQuantity'], {}),
    'insuranceSpares': (['failuresPerYear', 'leadTimeDays', 'daysPerYear', 'unitCost', 'holdingRate', 'downtimeCostPerDay', 'maxSpares'], {}),
    'leadTimeRisk': (['demandPerDay', 'leadTimeDays', 'reorderPoint', 'serviceLevel', 'iterations', 'seed'], {'demandPerDay': 'TRI', 'leadTimeDays': 'TRI'}),
    'slowMoving': (['items', 'bands', 'excessCoverMonths'], {'items': ('list', (['id', 'name', 'onHand', 'unitCost', 'monthsSinceLastIssue', 'monthlyUsage'], {})),
                                                            'bands': ('list', (['label', 'minMonths', 'writeDownPct'], {}))}),
}


def check_keys(v, shape, path):
    if shape == 'TRI':
        return check_keys(v, TRIANGLE, path) if isobj(v) else None
    if shape[0] == 'list':
        if not isinstance(v, list):
            return None
        for i, x in enumerate(v):
            e = check_keys(x, shape[1], f'{path}[{i}]')
            if e:
                return e
        return None
    keys, children = shape
    if not isobj(v):
        return None
    for k in v:
        if v[k] is not None or True:
            if k not in keys:
                where = f'of {path}' if path else 'at the top level'
                return refuse(f'{path}.{k}' if path else k, f'is not an accepted key; the accepted keys {where} are {", ".join(keys)}')
    for k in keys:
        if k in children and k in v:
            e = check_keys(v[k], children[k], f'{path}.{k}' if path else k)
            if e:
                return e
    return None


# ------------------------------------------------------------------ checks
def show(v):
    if v is MISSING:
        return 'undefined'
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return js_num(v)
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return '[object Object]'
    if isinstance(v, list):
        return ','.join(show(x) for x in v)
    return str(v)


def non_neg(field, v):
    return None if isnum(v) and v >= 0 else refuse(field, f'must be a finite number at or above 0; got {show(v)}')


def positive(field, v):
    return None if isnum(v) and v > 0 else refuse(field, f'must be a finite number above 0; got {show(v)}')


def frac01(field, v):
    return None if isnum(v) and 0 < v < 1 else refuse(field, f'must be a number strictly between 0 and 1; got {show(v)}')


def first(*checks):
    for c in checks:
        if c:
            return c
    return None


def check_list(lst, field, cap):
    if not isinstance(lst, list) or len(lst) < 1:
        return refuse(field, 'must be an array of at least 1 entry')
    if len(lst) > cap:
        return refuse(field, f'has {len(lst)} entries; the cap is {cap}')
    seen = set()
    for i, x in enumerate(lst):
        if not isobj(x):
            return refuse(f'{field}[{i}]', 'must be an object')
        if not isinstance(arg(x, 'id'), str) or arg(x, 'id') == '':
            return refuse(f'{field}[{i}].id', 'must be a non-empty string')
        if x['id'] in seen:
            return refuse(f'{field}[{i}].id', f"repeats the id '{x['id']}'")
        seen.add(x['id'])
    return None


def check_rounding(r, field):
    if not isobj(r) or arg(r, 'rule') not in ('none', 'up', 'down', 'nearest'):
        return refuse(field, "must be a stated rounding rule { rule: 'none' } or { rule: 'up' | 'down' | 'nearest', multiple }")
    if r['rule'] == 'none':
        return None if 'multiple' not in r else refuse(f'{field}.multiple', "must be left out when the rule is 'none'")
    return positive(f'{field}.multiple', arg(r, 'multiple'))


def round_to(x, r):
    """the stated rule: quotient at 12 significant digits, then up, down or
    nearest (halves upward), times the multiple (a double product)."""
    if r['rule'] == 'none':
        return x
    m = r['multiple']
    q = F(key12(F(x) / F(m) if not isinstance(x, Decimal) else D(x) / D(m)))
    if r['rule'] == 'up':
        n = math.ceil(q)
    elif r['rule'] == 'down':
        n = math.floor(q)
    else:
        n = math.floor(q + F(1, 2))
    return float(n) * float(m)


def rounding_text(r):
    if r['rule'] == 'none':
        return 'no rounding'
    if r['rule'] == 'nearest':
        return f"the nearest multiple of {fmt(r['multiple'])} (halves upward)"
    return f"{r['rule']} to a multiple of {fmt(r['multiple'])}"


# ------------------------------------------------------------------ normal (Decimal)
def phi_pdf(x):
    x = D(x)
    return (-(x * x) / 2).exp() / (2 * PI).sqrt()


def Phi(x):
    """0.5 (1 + erf(x / sqrt 2)), erf by its Maclaurin series."""
    x = D(x)
    if x > 12:
        return Decimal(1) - upper(x)
    if x < -12:
        return upper(-x)
    z = x / Decimal(2).sqrt()
    term = z
    s = z
    n = 0
    z2 = z * z
    while True:
        n += 1
        term = -term * z2 / n
        add = term / (2 * n + 1)
        s += add
        if abs(add) < Decimal('1e-80'):
            break
    erf = 2 / PI.sqrt() * s
    return (1 + erf) / 2


def upper(x):
    x = D(x)
    if x > 12:  # continued fraction for the far tail (never reached by the goldens' k)
        raise OracleStop('upper tail beyond 12 is outside the oracle range')
    return 1 - Phi(x)


def G(k):
    k = D(k)
    return phi_pdf(k) - k * (1 - Phi(k))


def inv_Phi(p):
    p = D(p)
    lo, hi = Decimal(-12), Decimal(12)
    while hi - lo > Decimal('1e-40'):
        mid = (lo + hi) / 2
        if Phi(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def solve_G(t):
    t = D(t)
    lo, hi = Decimal(-12), Decimal(12)
    if not (G(lo) > t > G(hi)):
        raise OracleStop(f'fill-rate target {t} lies outside G on [-12, 12]')
    while hi - lo > Decimal('1e-40'):
        mid = (lo + hi) / 2
        if G(mid) > t:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


# ------------------------------------------------------------------ Poisson (Decimal)
def pois_p(m, x):
    m = D(m)
    return (-m).exp() * m ** x / math.factorial(x)


def pois_F(m, s):
    return sum((pois_p(m, x) for x in range(s + 1)), Decimal(0))


def pois_L(m, s):
    m = D(m)
    return m - s + sum(((s - x) * pois_p(m, x) for x in range(s)), Decimal(0))


# ------------------------------------------------------------------ criticality
def criticality(a):
    criteria, score_max, items, classes, top_list = (arg(a, k) for k in ['criteria', 'scoreMax', 'items', 'classes', 'topClassOnMaxScore'])
    e = check_list(criteria, 'criteria', CAPS['MAX_CRITERIA'])
    if e:
        return e
    for i, c in enumerate(criteria):
        w = arg(c, 'weight')
        if not isnum(w) or w <= 0 or w > 100:
            return refuse(f'criteria[{i}].weight', f'must be a number above 0 and at most 100; got {show(w)}')
    wsum_d = 0.0
    for c in criteria:
        wsum_d = wsum_d + c['weight']      # the double the message prints, summed left to right
    if abs(sum((F(c['weight']) for c in criteria), F(0)) - 100) > F(1e-9):
        return refuse('criteria', f'weights must add to 100; they add to {fmt(wsum_d)}')
    e = positive('scoreMax', score_max)
    if e:
        return e
    if not isinstance(classes, list) or len(classes) < 2:
        return refuse('classes', 'must be an array of at least 2 classes, highest first')
    if len(classes) > CAPS['MAX_CLASSES']:
        return refuse('classes', f'has {len(classes)} entries; the cap is {CAPS["MAX_CLASSES"]}')
    labels = set()
    for i, c in enumerate(classes):
        if not isobj(c) or not isinstance(arg(c, 'label'), str) or arg(c, 'label') == '':
            return refuse(f'classes[{i}].label', 'must be a non-empty string')
        if c['label'] in labels:
            return refuse(f'classes[{i}].label', f"repeats the label '{c['label']}'")
        labels.add(c['label'])
        ms = arg(c, 'minScore')
        if not isnum(ms) or ms < 0 or ms > 100:
            return refuse(f'classes[{i}].minScore', f'must be a number from 0 to 100; got {show(ms)}')
        if i > 0 and not (ms < classes[i - 1]['minScore']):
            return refuse(f'classes[{i}].minScore', f'must be below the class above it ({fmt(classes[i - 1]["minScore"])}); got {fmt(ms)}')
    if classes[-1]['minScore'] != 0:
        return refuse(f'classes[{len(classes) - 1}].minScore', f'must be 0 so that every item takes a class; got {fmt(classes[-1]["minScore"])}')
    ids = [c['id'] for c in criteria]
    if not isinstance(top_list, list):
        return refuse('topClassOnMaxScore', 'must be an array of criterion ids (empty for none)')
    for i, t in enumerate(top_list):
        if t not in ids:
            return refuse(f'topClassOnMaxScore[{i}]', f'must be a criterion id ({", ".join(ids)}); got {show(t)}')
    e = check_list(items, 'items', CAPS['MAX_ITEMS'])
    if e:
        return e
    for i, it in enumerate(items):
        s = arg(it, 'scores')
        if not isobj(s):
            return refuse(f'items[{i}].scores', 'must be an object keyed by criterion id')
        for k in s:
            if k not in ids:
                return refuse(f'items[{i}].scores.{k}', f'is not a criterion; the criteria are {", ".join(ids)}')
        for c in criteria:
            v = arg(s, c['id'])
            if not isnum(v) or v < 0 or v > score_max:
                return refuse(f"items[{i}].scores.{c['id']}", f'must be a number from 0 to scoreMax {fmt(score_max)}; got {show(v)}')
    top = classes[0]['label']
    out = []
    for it in items:
        contrib = {c['id']: F(c['weight']) * F(it['scores'][c['id']]) / F(score_max) for c in criteria}
        score = sum(contrib.values(), F(0))
        forcing = [t for t in top_list if it['scores'][t] == score_max]
        by_score = next(c for c in classes if key12(score) >= key12(c['minScore']))
        cls = by_score['label']
        if forcing and by_score['label'] != top:
            cls = top
            reason = (f"{it['id']}: scores the maximum {fmt(score_max)} on {' and '.join(forcing)}, which places an item in class {top} "
                      f"whatever its weighted score ({dec(score)}, class {by_score['label']} by score alone)")
            forced = forcing
        else:
            reason = f"{it['id']}: weighted score {dec(score)} is at or above {fmt(by_score['minScore'])}, the minimum for class {by_score['label']}"
            i = classes.index(by_score)
            if i > 0:
                reason += f", and below {fmt(classes[i - 1]['minScore'])} for class {classes[i - 1]['label']}"
            forced = []
        out.append({'id': it['id'], 'weightedScore': fl(score), 'contributions': {k: fl(v) for k, v in contrib.items()},
                    'class': cls, 'forcedBy': forced, 'reason': reason})
    counts = {c['label']: sum(1 for r in out if r['class'] == c['label']) for c in classes}
    return {'items': out, 'counts': counts}


# ------------------------------------------------------------------ ABC
def abc(a):
    items, cut, rule = arg(a, 'items'), arg(a, 'cutoffs'), arg(a, 'boundaryRule')
    e = check_list(items, 'items', CAPS['MAX_ITEMS'])
    if e:
        return e
    for i, it in enumerate(items):
        e = first(non_neg(f'items[{i}].annualUsage', arg(it, 'annualUsage')), non_neg(f'items[{i}].unitCost', arg(it, 'unitCost')))
        if e:
            return e
    if not isobj(cut):
        return refuse('cutoffs', 'must be { aPct, bPct }, the cumulative value shares that close classes A and B')
    ap, bp = arg(cut, 'aPct'), arg(cut, 'bPct')
    if not isnum(ap) or ap <= 0 or ap >= 100:
        return refuse('cutoffs.aPct', f'must be a number above 0 and below 100; got {show(ap)}')
    if not isnum(bp) or bp <= ap or bp >= 100:
        return refuse('cutoffs.bPct', f'must be a number above aPct {fmt(ap)} and below 100; got {show(bp)}')
    if rule not in ('at-or-below', 'include-crossing'):
        return refuse('boundaryRule', "must be 'at-or-below' (the cumulative share including the item decides) or 'include-crossing' (the share before the item decides, so the item crossing a cut-off joins the higher class)")
    rows = [(it['id'], F(it['annualUsage']) * F(it['unitCost'])) for it in items]
    total = sum((v for _, v in rows), F(0))
    if not total > 0:
        return refuse('items', 'must carry some annual usage value; every annualUsage x unitCost is 0')
    # rank: an insertion into a list kept in order, highest value first, ties
    # (12 significant digits) by id
    ranked = []
    for rid, v in rows:
        pos = 0
        while pos < len(ranked):
            rv = ranked[pos][1]
            if key12(rv) != key12(v):
                if rv < v:
                    break
            elif ranked[pos][0] > rid:
                break
            pos += 1
        ranked.insert(pos, (rid, v))
    out = []
    cum = F(0)
    for i, (rid, v) in enumerate(ranked):
        before = 100 * cum / total
        cum += v
        after = 100 * cum / total
        if rule == 'at-or-below':
            cls = 'A' if key12(after) <= key12(ap) else 'B' if key12(after) <= key12(bp) else 'C'
            if cls == 'C':
                reason = f'{rid}: cumulative share {dec(after)}% is above {fmt(bp)}%'
            else:
                reason = f"{rid}: cumulative share {dec(after)}% is at or below {fmt(ap if cls == 'A' else bp)}%" + (f' and above {fmt(ap)}%' if cls == 'B' else '')
        else:
            cls = 'A' if key12(before) < key12(ap) else 'B' if key12(before) < key12(bp) else 'C'
            if cls == 'C':
                reason = f'{rid}: cumulative share before it {dec(before)}% is at or above {fmt(bp)}%'
            else:
                reason = f"{rid}: cumulative share before it {dec(before)}% is below {fmt(ap if cls == 'A' else bp)}%" + (f' and at or above {fmt(ap)}%' if cls == 'B' else '')
        out.append({'id': rid, 'rank': i + 1, 'annualValue': fl(v), 'sharePct': fl(100 * v / total), 'cumulativePct': fl(after), 'class': cls, 'reason': reason})
    summary = {}
    for c in 'ABC':
        vals = [F(r_v) for (rid, r_v), r in zip(ranked, out) if r['class'] == c]
        v = sum(vals, F(0))
        summary[c] = {'count': len(vals), 'itemSharePct': fl(F(100 * len(vals), len(out))), 'annualValue': fl(v), 'valueSharePct': fl(100 * v / total)}
    return {'items': out, 'totalAnnualValue': fl(total), 'summary': summary}


# ------------------------------------------------------------------ EOQ
def eoq(a):
    Dm, A, hpu, uc, hr, rnd = (arg(a, k) for k in ['annualDemand', 'orderCost', 'holdingCostPerUnitYear', 'unitCost', 'holdingRate', 'rounding'])
    e = first(positive('annualDemand', Dm), positive('orderCost', A))
    if e:
        return e
    if ('holdingCostPerUnitYear' in a) == ('holdingRate' in a):
        return refuse('holdingCostPerUnitYear', 'or holdingRate: state exactly one (holdingRate goes with unitCost)')
    if 'holdingRate' in a:
        e = first(positive('holdingRate', hr), refuse('unitCost', 'is required with holdingRate (the holding cost is holdingRate x unitCost)') if 'unitCost' not in a else positive('unitCost', uc))
        if e:
            return e
        h = F(hr) * F(uc)
        h_double = hr * uc   # the engine carries this double forward
    else:
        e = first(positive('holdingCostPerUnitYear', hpu), None if 'unitCost' not in a else non_neg('unitCost', uc))
        if e:
            return e
        h = F(hpu)
        h_double = hpu
    e = check_rounding(rnd, 'rounding')
    if e:
        return e
    hx = F(h_double)
    q = sqrtF(2 * F(A) * F(Dm) / hx)
    qr = round_to(q, rnd)
    if not qr > 0:
        return refuse('rounding', f'gives an order quantity of 0 from the EOQ {dec(q)}; state a smaller multiple or another rule')
    Q = F(qr) if rnd['rule'] != 'none' else None
    if Q is None:
        ordering = D(A) * D(Dm) / q
        holding = D(hx) * q / 2
    else:
        ordering = D(F(A) * F(Dm) / Q)
        holding = D(hx * Q / 2)
    relevant = ordering + holding
    opt = sqrtF(2 * F(A) * F(Dm) * hx)
    qq = q if Q is None else D(Q)
    return {
        'eoq': fl(q), 'quantity': fl(qq), 'holdingCostPerUnitYear': h_double,
        'ordersPerYear': fl(D(Dm) / qq), 'cycleYears': fl(qq / D(Dm)),
        'orderingCost': fl(ordering), 'holdingCost': fl(holding), 'relevantCost': fl(relevant), 'relevantCostAtEoq': fl(opt),
        'roundingPenaltyPct': fl(100 * (relevant - opt) / opt), 'purchaseCost': None if 'unitCost' not in a else fl(F(Dm) * F(uc)),
        'reason': (f'EOQ = sqrt(2 x {fmt(A)} x {fmt(Dm)} / {dec(hx)}) = {dec(q)}; ordered as {dec(qq)} ({rounding_text(rnd)}), '
                   f'a relevant cost of {money(relevant)} a year against {money(opt)} at the EOQ'),
    }


# ------------------------------------------------------------------ quantity discounts
def quantity_discount(a):
    Dm, A, r, breaks, dtype, rnd = (arg(a, k) for k in ['annualDemand', 'orderCost', 'holdingRate', 'breaks', 'discountType', 'rounding'])
    e = first(positive('annualDemand', Dm), positive('orderCost', A), positive('holdingRate', r))
    if e:
        return e
    if not isinstance(breaks, list) or len(breaks) < 1:
        return refuse('breaks', 'must be an array of at least 1 price band { minQuantity, unitPrice }')
    if len(breaks) > CAPS['MAX_BREAKS']:
        return refuse('breaks', f'has {len(breaks)} entries; the cap is {CAPS["MAX_BREAKS"]}')
    for i, b in enumerate(breaks):
        if not isobj(b):
            return refuse(f'breaks[{i}]', 'must be an object { minQuantity, unitPrice }')
        e = first(non_neg(f'breaks[{i}].minQuantity', arg(b, 'minQuantity')), positive(f'breaks[{i}].unitPrice', arg(b, 'unitPrice')))
        if e:
            return e
        if i == 0 and b['minQuantity'] != 0:
            return refuse('breaks[0].minQuantity', f"must be 0 so that every quantity has a price; got {fmt(b['minQuantity'])}")
        if i > 0 and not b['minQuantity'] > breaks[i - 1]['minQuantity']:
            return refuse(f'breaks[{i}].minQuantity', f"must be above the band before it ({fmt(breaks[i - 1]['minQuantity'])}); got {fmt(b['minQuantity'])}")
        if i > 0 and not b['unitPrice'] < breaks[i - 1]['unitPrice']:
            return refuse(f'breaks[{i}].unitPrice', f"must be below the band before it ({fmt(breaks[i - 1]['unitPrice'])}); got {fmt(b['unitPrice'])}")
    if dtype not in ('all-units', 'incremental'):
        return refuse('discountType', "must be 'all-units' (the band's price applies to the whole lot) or 'incremental' (each unit is priced by its own band)")
    e = check_rounding(rnd, 'rounding')
    if e:
        return e
    if rnd['rule'] != 'none':
        for i in range(1, len(breaks)):
            q = key12(F(breaks[i]['minQuantity']) / F(rnd['multiple']))
            if q != round(q):
                return refuse(f'breaks[{i}].minQuantity', f"must be a multiple of rounding.multiple {fmt(rnd['multiple'])}, so that ordering at the break keeps its price; got {fmt(breaks[i]['minQuantity'])}")
    A_, D_, r_ = F(A), F(Dm), F(r)
    v = [F(b['unitPrice']) for b in breaks]
    Qb = [F(b['minQuantity']) for b in breaks]
    Fi = [F(0)]
    for i in range(1, len(breaks)):
        Fi.append(Fi[-1] + (v[i - 1] - v[i]) * Qb[i])

    def band_of(Q):
        found = 0
        for i in range(len(breaks)):
            if key12(Q) >= key12(Qb[i]):
                found = i
        return found

    def cost_at(Q):
        Q = F(Q)
        i = band_of(Q)
        lot = v[i] * Q if dtype == 'all-units' else Fi[i] + v[i] * Q
        return i, lot / Q, D_ * lot / Q, A_ * D_ / Q, r_ * lot / 2

    cands = []
    for i, b in enumerate(breaks):
        lo = Qb[i]
        hi = Qb[i + 1] if i + 1 < len(breaks) else None
        q = sqrtF(2 * D_ * (A_ + (0 if dtype == 'all-units' else Fi[i])) / (r_ * v[i]))
        in_band = key12(q) >= key12(lo) and (hi is None or key12(q) < key12(hi))
        qty = None
        pv = fmt(b['unitPrice'])
        if in_band:
            qty = float(q) if rnd['rule'] == 'none' else round_to(q, rnd)
            if not qty > 0:
                return refuse('rounding', f'gives an order quantity of 0 from the band {i} EOQ {dec(q)}; state a smaller multiple or another rule')
            reason = f"band {i} at {pv}: EOQ {dec(q)} lies in the band from {fmt(b['minQuantity'])}{' upward' if hi is None else ' to below ' + fmt(breaks[i + 1]['minQuantity'])}; candidate {dec(qty)}"
        elif dtype == 'all-units' and key12(q) < key12(lo):
            qty = b['minQuantity']
            reason = f"band {i} at {pv}: EOQ {dec(q)} lies below the break {fmt(b['minQuantity'])}, so the break quantity is the candidate"
        else:
            where = f"below the band's first quantity {fmt(b['minQuantity'])}" if key12(q) < key12(lo) else f"at or above the next break {fmt(breaks[i + 1]['minQuantity'])}"
            reason = f'band {i} at {pv}: EOQ {dec(q)} lies {where}, so the band gives no candidate'
        row = {'band': i, 'unitPrice': b['unitPrice'], 'fixedCost': fl(Fi[i]), 'eoq': fl(q), 'feasible': qty is not None, 'quantity': qty, 'totalCost': None, 'reason': reason}
        if qty is not None:
            QQ = F(qty)
            cb, eff, pur, ordc, hold = cost_at(QQ)
            tot = pur + ordc + hold
            row.update({'costedBand': cb, 'effectiveUnitPrice': fl(eff), 'purchaseCost': fl(pur), 'orderingCost': fl(ordc), 'holdingCost': fl(hold), 'totalCost': fl(tot)})
            row['_tot'] = tot
            row['reason'] += f', total cost {money(tot)} a year'
        cands.append(row)
    live = [c for c in cands if c['feasible']]
    if not live:
        return refuse('breaks', 'give no band whose EOQ lies inside it; check the schedule')
    best = None
    for c in live:   # the lowest cost; a tie (12 digits) goes to the smaller quantity
        if best is None or key12(c['_tot']) < key12(best['_tot']) or (key12(c['_tot']) == key12(best['_tot']) and c['quantity'] < best['quantity']):
            best = c
    others = [c for c in live if c is not best]
    tied = any(key12(c['_tot']) == key12(best['_tot']) for c in others)
    base_cost = D(D_ * v[0]) + sqrtF(2 * A_ * D_ * r_ * v[0])
    best_tot = best['_tot']
    for c in cands:
        c.pop('_tot', None)
    return {
        'discountType': dtype, 'candidates': cands, 'quantity': best['quantity'], 'band': best['costedBand'], 'totalCost': best['totalCost'],
        'savingsAgainstNoDiscount': fl(base_cost - D(best_tot)),
        'reason': f"order {dec(best['quantity'])} at a total cost of {money(best_tot)} a year (band {best['costedBand']}), the lowest of {plural(len(live), 'candidate')}" + ('; tied on cost, the smaller quantity is taken' if tied else ''),
    }


# ------------------------------------------------------------------ safety stock (normal)
def safety_stock(a):
    g = lambda k: arg(a, k)
    e = first(non_neg('demandMean', g('demandMean')), non_neg('demandSd', g('demandSd')), non_neg('leadTime', g('leadTime')),
              non_neg('leadTimeSd', g('leadTimeSd')), non_neg('reviewPeriod', g('reviewPeriod')))
    if e:
        return e
    d, sd, L, sL, R = (F(g(k)) for k in ['demandMean', 'demandSd', 'leadTime', 'leadTimeSd', 'reviewPeriod'])
    if not (L + R > 0):
        return refuse('leadTime', 'and reviewPeriod add to 0; the protection period must be above 0')
    meas, lvl, Qo = g('serviceMeasure'), g('serviceLevel'), g('orderQuantity')
    if meas not in ('cycle-service', 'fill-rate'):
        return refuse('serviceMeasure', "must be 'cycle-service' (probability of no stockout in a replenishment cycle) or 'fill-rate' (fraction of demand met from stock)")
    e = frac01('serviceLevel', lvl)
    if e:
        return e
    if 'orderQuantity' not in a and meas == 'fill-rate':
        return refuse('orderQuantity', 'is required for a fill rate (units short are measured against the quantity each cycle brings)')
    if 'orderQuantity' in a:
        e = positive('orderQuantity', Qo)
        if e:
            return e
    kr = g('safetyFactorRounding')
    if not isobj(kr) or arg(kr, 'rule') not in ('none', 'nearest'):
        return refuse('safetyFactorRounding', "must be { rule: 'none' } or { rule: 'nearest', decimals } (a table read to that many decimals)")
    if kr['rule'] == 'none' and 'decimals' in kr:
        return refuse('safetyFactorRounding.decimals', "must be left out when the rule is 'none'")
    if kr['rule'] == 'nearest':
        dd = arg(kr, 'decimals')
        if not (isinstance(dd, int) and not isinstance(dd, bool) and 0 <= dd <= CAPS['MAX_DECIMALS']):
            return refuse('safetyFactorRounding.decimals', f"must be a whole number from 0 to {CAPS['MAX_DECIMALS']}; got {show(dd)}")
    mk = g('minimumSafetyFactor')
    if mk is not None and not isnum(mk):
        return refuse('minimumSafetyFactor', f"must be a stated number or null for no floor; got {show(mk)}")
    rnd = g('rounding')
    e = check_rounding(rnd, 'rounding')
    if e:
        return e
    P = L + R
    mu = d * P
    var = P * sd * sd + d * d * sL * sL
    sigma = D(var).sqrt()
    if not sigma > 0 and meas == 'fill-rate':
        return refuse('demandSd', 'and leadTimeSd are both 0, so demand over the protection period is certain and a fill rate sets no safety factor')
    if meas == 'cycle-service':
        k_exact = inv_Phi(F(lvl))
        target = f'a cycle service level of {fmt(lvl)} gives k = Phi^-1({fmt(lvl)}) = {dec(k_exact)}'
    else:
        t = D(F(Qo) * (1 - F(lvl))) / sigma
        k_exact = solve_G(t)
        target = f'a fill rate of {fmt(lvl)} needs G(k) at or below {fmt(Qo)} x (1 - {fmt(lvl)}) / {dec(sigma)} = {dec(t)}, so k = {dec(k_exact)}'
    if kr['rule'] == 'nearest':
        k_r = rounded(k_exact, kr['decimals'])
        k_r_D = D(k_r)
    else:
        k_r = None
        k_r_D = k_exact
    floored = mk is not None and k_r_D < D(mk)
    k = D(mk) if floored else k_r_D
    safety = k * sigma
    level = D(mu) + safety
    level_r = round_to(level, rnd)
    level_rD = D(level_r) if rnd['rule'] != 'none' else level
    if sigma > 0:
        k_ach = (level_rD - D(mu)) / sigma
        short = sigma * G(k_ach)
        csl = Phi(k_ach)
    else:
        short = max(Decimal(0), D(mu) - level_rD)
        csl = Decimal(1) if level_rD >= D(mu) else Decimal(0)
    name = 'order-up-to level S' if R > 0 else 'reorder point s'
    reason = target + (f', read as {fmt(k_r)}' if kr['rule'] == 'nearest' else '')
    if floored:
        reason += f'; below the stated minimum {fmt(mk)}, so k = {fmt(mk)}'
    reason += (f'; safety stock {dec(safety)} over a demand of {dec(mu)} with sigma {dec(sigma)} gives the {name} {dec(level)}, '
               f'held as {dec(level_rD)} ({rounding_text(rnd)})')
    return {
        'policy': 'periodic (R, S)' if R > 0 else 'continuous (s, Q)', 'protectionPeriod': fl(P), 'demandOverProtection': fl(mu), 'sigma': fl(sigma),
        'safetyFactorExact': fl(k_exact), 'safetyFactor': fl(k), 'safetyStock': fl(safety), 'level': fl(level), 'levelRounded': fl(level_rD),
        'achievedCycleService': fl(csl), 'expectedShortPerCycle': fl(short),
        'achievedFillRate': None if 'orderQuantity' not in a else fl(1 - short / D(Qo)), 'reason': reason,
    }


# ------------------------------------------------------------------ Poisson stock
def bound_max(x, ok):
    """the largest 6-decimal figure at or below the exact bound that the
    refusal's rule accepts (the figure printed in the message)."""
    k = math.floor(x * 1000000)
    while ok((k + 1) / 1e6):
        k += 1
    while not ok(k / 1e6):
        k -= 1
    v = k / 1e6
    return fmt(v) if v == x else f'{fmt(v)} (rounded down at the sixth decimal so that it is accepted)'


def pois_rows(m, until):
    """rows 0, 1, ... until `until` holds: each probability by its own
    formula, F a running sum, L by the direct partial expectation."""
    rows, ps = [], []
    Fs = Decimal(0)
    s = 0
    while True:
        ps.append(pois_p(m, s))
        Fs += ps[-1]
        Ls = D(m) - s + sum(((s - x) * ps[x] for x in range(s)), Decimal(0))
        rows.append({'s': s, 'probability': ps[-1], 'cumulative': min(Fs, Decimal(1)), 'expectedShort': Ls})
        if until(rows[-1]):
            return rows
        s += 1


def rows_out(rows):
    return [{'s': r['s'], 'probability': fl(r['probability']), 'cumulative': fl(r['cumulative']), 'expectedShort': fl(r['expectedShort'])} for r in rows]


def poisson_stock(a):
    g = lambda k: arg(a, k)
    e = first(positive('demandRate', g('demandRate')), non_neg('leadTime', g('leadTime')), non_neg('reviewPeriod', g('reviewPeriod')))
    if e:
        return e
    lam, L, R = g('demandRate'), g('leadTime'), g('reviewPeriod')
    if not (F(L) + F(R) > 0):
        return refuse('leadTime', 'and reviewPeriod add to 0; the protection period must be above 0')
    Pd = L + R   # the double the engine carries
    if lam * Pd > CAPS['MAX_POISSON_MEAN']:
        what = '(leadTime + reviewPeriod)' if R > 0 else 'leadTime'
        b = bound_max(CAPS['MAX_POISSON_MEAN'] / lam - R, lambda v: lam * (v + R) <= CAPS['MAX_POISSON_MEAN'])
        return refuse('leadTime', f"must be at most {b} so that the mean demand demandRate x {what} is at most {CAPS['MAX_POISSON_MEAN']}; above that the normal safetyStock serves; got {fmt(L)}")
    meas, lvl, Qo = g('serviceMeasure'), g('serviceLevel'), g('orderQuantity')
    if meas not in ('cycle-service', 'fill-rate'):
        return refuse('serviceMeasure', "must be 'cycle-service' (probability of no stockout over the protection period) or 'fill-rate' (fraction of demand met from stock)")
    e = frac01('serviceLevel', lvl)
    if e:
        return e
    if 'orderQuantity' not in a and meas == 'fill-rate':
        return refuse('orderQuantity', 'is required for a fill rate (units short are measured against the quantity each cycle brings)')
    if 'orderQuantity' in a:
        e = positive('orderQuantity', Qo)
        if e:
            return e
    m = lam * Pd   # the engine's mean is this double
    limit = None if meas != 'fill-rate' else F(Qo) * (1 - F(lvl))
    if meas == 'cycle-service':
        met = lambda row: key12(row['cumulative']) >= key12(lvl)
    else:
        met = lambda row: key12(row['expectedShort']) <= key12(Qo * (1 - lvl))
    rows = pois_rows(m, met)
    ch = rows[-1]
    s = ch['s']
    prev = rows[s - 1] if s > 0 else None
    if meas == 'cycle-service':
        reason = f"level {s}: P(X <= {s}) = {dec(ch['cumulative'])} is at or above {fmt(lvl)}" + (f"; at {s - 1} it is {dec(prev['cumulative'])}" if prev else '') + f' (Poisson mean {dec(m)})'
    else:
        reason = (f"level {s}: expected units short {dec(ch['expectedShort'])} is at or below {fmt(Qo)} x (1 - {fmt(lvl)}) = {dec(Qo * (1 - lvl))}"
                  + (f"; at {s - 1} it is {dec(prev['expectedShort'])}" if prev else '') + f' (Poisson mean {dec(m)})')
    return {
        'mean': m, 'level': s, 'safetyStock': fl(s - D(m)), 'rows': rows_out(rows), 'achievedCycleService': fl(ch['cumulative']),
        'expectedShortPerCycle': fl(ch['expectedShort']), 'achievedFillRate': None if 'orderQuantity' not in a else fl(1 - ch['expectedShort'] / D(Qo)),
        'reason': reason,
    }


# ------------------------------------------------------------------ insurance spares
def insurance_spares(a):
    g = lambda k: arg(a, k)
    e = first(positive('failuresPerYear', g('failuresPerYear')), positive('leadTimeDays', g('leadTimeDays')), positive('daysPerYear', g('daysPerYear')),
              non_neg('unitCost', g('unitCost')), non_neg('holdingRate', g('holdingRate')), non_neg('downtimeCostPerDay', g('downtimeCostPerDay')))
    if e:
        return e
    ms = g('maxSpares')
    if not (isinstance(ms, (int, float)) and not isinstance(ms, bool) and float(ms).is_integer() and 0 <= ms <= CAPS['MAX_SPARES']):
        return refuse('maxSpares', f"must be a whole number from 0 to {CAPS['MAX_SPARES']}; got {show(ms)}")
    ms = int(ms)
    lam, lt, dpy = g('failuresPerYear'), g('leadTimeDays'), g('daysPerYear')
    m = (lam * lt) / dpy     # the engine's double
    if m > CAPS['MAX_POISSON_MEAN']:
        b = bound_max((CAPS['MAX_POISSON_MEAN'] * dpy) / lam, lambda v: (lam * v) / dpy <= CAPS['MAX_POISSON_MEAN'])
        return refuse('leadTimeDays', f"must be at most {b} so that the mean number of orders outstanding is at most {CAPS['MAX_POISSON_MEAN']}; got {fmt(lt)}")
    rows = pois_rows(m, lambda row: row['s'] >= ms)
    hp = F(g('unitCost')) * F(g('holdingRate'))
    hp_double = g('unitCost') * g('holdingRate')
    opts = []
    for r in rows:
        hold = F(r['s']) * F(hp_double)
        down = r['expectedShort'] * D(dpy) * D(g('downtimeCostPerDay'))
        opts.append({'spares': r['s'], 'probabilityNoShortage': r['cumulative'], 'fillRate': Decimal(0) if r['s'] == 0 else rows[r['s'] - 1]['cumulative'],
                     'expectedUnitsDown': r['expectedShort'], 'holdingCost': D(hold), 'downtimeCost': down, 'totalCost': D(hold) + down})
    best = opts[0]
    for o in opts:
        if key12(o['totalCost']) < key12(best['totalCost']):
            best = o
    nxt = opts[best['spares'] + 1] if best['spares'] + 1 < len(opts) else None
    reason = (f"{plural(best['spares'], 'spare')}: holding {money(best['holdingCost'])} a year against expected downtime {money(best['downtimeCost'])}, "
              f"total {money(best['totalCost'])}, the lowest for 0 to {ms}")
    if nxt:
        reason += f"; one more spare adds {money(F(hp_double))} of holding and saves {money(best['downtimeCost'] - nxt['downtimeCost'])} of downtime"
    at_limit = best['spares'] == ms and ms > 0
    if at_limit:
        reason += f'; the search stopped at maxSpares {ms}, so a larger stock may cost less'
    return {
        'meanOutstanding': m, 'spares': best['spares'], 'totalCost': fl(best['totalCost']), 'atSearchLimit': at_limit,
        'options': [{k: (fl(v) if isinstance(v, (Decimal, F)) else v) for k, v in o.items()} for o in opts], 'reason': reason,
    }


# ------------------------------------------------------------------ lead-time risk (Monte Carlo)
M32 = 0xFFFFFFFF


def imul(x, y):
    return (x * y) & M32


class Mulberry32:
    def __init__(self, seed):
        self.a = seed & M32

    def __call__(self):
        self.a = (self.a + 0x6D2B79F5) & M32
        t = self.a
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & M32)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296


def tri_inv(u, a, c, b):
    """inverse of the triangular CDF F(x) = (x-a)^2 / ((b-a)(c-a)) on [a, c],
    1 - (b-x)^2 / ((b-a)(b-c)) on [c, b]."""
    if a == b:
        return a
    if u <= (c - a) / (b - a):
        return a + math.sqrt(u * (b - a) * (c - a))
    return b - math.sqrt((1 - u) * (b - a) * (b - c))


def summary(vals):
    s = sorted(vals)
    n = len(s)

    def at(p10):
        return s[min((p10 * n) // 10, n - 1)]
    return {'mean': math.fsum(s) / n, 'p90': at(1), 'p50': at(5), 'p10': at(9), 'min': s[0], 'max': s[-1]}


def check_tri(d, field):
    if isnum(d):
        return None if d >= 0 else refuse(field, f'must be at or above 0; got {fmt(d)}')
    if not isobj(d) or not all(isnum(arg(d, k)) for k in ('min', 'mode', 'max')):
        return refuse(field, 'must be a number or a triangular distribution { min, mode, max } of finite numbers')
    if d['min'] < 0:
        return refuse(f'{field}.min', f"must be at or above 0; got {fmt(d['min'])}")
    if not (d['min'] <= d['mode'] <= d['max']):
        return refuse(field, f"must have min <= mode <= max; got min {fmt(d['min'])}, mode {fmt(d['mode'])}, max {fmt(d['max'])}")
    return None


def lead_time_risk(a):
    g = lambda k: arg(a, k)
    it, seed = g('iterations'), g('seed')
    if not (isinstance(it, int) and not isinstance(it, bool) and 1 <= it <= CAPS['MAX_ITERATIONS']):
        return refuse('iterations', f"must be a whole number from 1 to {CAPS['MAX_ITERATIONS']}; got {show(it)}")
    if not (isinstance(seed, int) and not isinstance(seed, bool) and 0 <= seed <= 4294967295):
        return refuse('seed', 'must be a whole number from 0 to 4294967295; it is required so that every run can be reproduced')
    e = first(check_tri(g('leadTimeDays'), 'leadTimeDays'), check_tri(g('demandPerDay'), 'demandPerDay'), non_neg('reorderPoint', g('reorderPoint')))
    if e:
        return e
    if 'serviceLevel' in a:
        e = frac01('serviceLevel', g('serviceLevel'))
        if e:
            return e
    tri = lambda d: {'min': d, 'mode': d, 'max': d} if isnum(d) else d
    lt, dd, rop = tri(g('leadTimeDays')), tri(g('demandPerDay')), g('reorderPoint')
    rng = Mulberry32(seed)

    def draw(d):
        return tri_inv(rng(), d['min'], d['mode'], d['max']) if d['max'] > d['min'] else d['mode']
    days, ltd, short = [], [], []
    outs = 0
    for _ in range(it):
        t = draw(lt)
        rate = draw(dd)
        x = rate * t
        days.append(t)
        ltd.append(x)
        short.append(x - rop if x > rop else 0.0)
        outs += 1 if x > rop else 0
    p = F(outs, it)
    rps = None
    if 'serviceLevel' in a:
        idx = max(0, math.ceil(key12(g('serviceLevel') * it)) - 1)
        rps = sorted(ltd)[idx]
    return {
        'leadTime': summary(days), 'leadTimeDemand': summary(ltd), 'probabilityOfStockout': fl(p), 'cycleServiceLevel': fl(1 - p),
        'expectedShortPerCycle': math.fsum(short) / it, 'reorderPointForService': rps, 'percentileDefinition': EXCEEDANCE,
        'reason': f"{outs} of {plural(it, 'draw')} have a lead-time demand above the reorder point {fmt(rop)}: a stockout probability of {dec(p)} a cycle",
    }


# ------------------------------------------------------------------ slow-moving
def slow_moving(a):
    items, bands, ecm = arg(a, 'items'), arg(a, 'bands'), arg(a, 'excessCoverMonths')
    if not isinstance(bands, list) or len(bands) < 1:
        return refuse('bands', 'must be an array of at least 1 band { label, minMonths, writeDownPct }')
    if len(bands) > CAPS['MAX_BANDS']:
        return refuse('bands', f"has {len(bands)} entries; the cap is {CAPS['MAX_BANDS']}")
    labels = set()
    for i, b in enumerate(bands):
        if not isobj(b) or not isinstance(arg(b, 'label'), str) or arg(b, 'label') == '':
            return refuse(f'bands[{i}].label', 'must be a non-empty string')
        if b['label'] in labels:
            return refuse(f'bands[{i}].label', f"repeats the label '{b['label']}'")
        labels.add(b['label'])
        e = non_neg(f'bands[{i}].minMonths', arg(b, 'minMonths'))
        if e:
            return e
        if i == 0 and b['minMonths'] != 0:
            return refuse('bands[0].minMonths', f"must be 0 so that every item takes a band; got {fmt(b['minMonths'])}")
        if i > 0 and not b['minMonths'] > bands[i - 1]['minMonths']:
            return refuse(f'bands[{i}].minMonths', f"must be above the band before it ({fmt(bands[i - 1]['minMonths'])}); got {fmt(b['minMonths'])}")
        w = arg(b, 'writeDownPct')
        if not isnum(w) or w < 0 or w > 100:
            return refuse(f'bands[{i}].writeDownPct', f'must be a number from 0 to 100; got {show(w)}')
    e = positive('excessCoverMonths', ecm)
    if e:
        return e
    e = check_list(items, 'items', CAPS['MAX_ITEMS'])
    if e:
        return e
    for i, it in enumerate(items):
        e = first(*(non_neg(f'items[{i}].{k}', arg(it, k)) for k in ['onHand', 'unitCost', 'monthsSinceLastIssue', 'monthlyUsage']))
        if e:
            return e
    out = []
    for it in items:
        # the band: the highest minimum the item has reached, found by a search from the top
        bi = next(i for i in range(len(bands) - 1, -1, -1) if key12(it['monthsSinceLastIssue']) >= key12(bands[i]['minMonths']))
        b = bands[bi]
        value = F(it['onHand']) * F(it['unitCost'])
        wd = value * F(b['writeDownPct']) / 100
        usage = F(it['monthlyUsage'])
        cover = F(it['onHand']) / usage if usage > 0 else None
        excess = (it['onHand'] > 0) if cover is None else key12(cover) > key12(ecm)
        exq = max(F(0), F(it['onHand']) - F(ecm) * usage) if usage > 0 else F(it['onHand'])
        mo = it['monthsSinceLastIssue']
        reason = (f"{it['id']}: {unit(fmt(mo), mo, 'month')} since the last issue is at or above {fmt(b['minMonths'])}, band {b['label']}"
                  + (f" (below {fmt(bands[bi + 1]['minMonths'])})" if bi + 1 < len(bands) else '')
                  + f", written down {fmt(b['writeDownPct'])}% of {money(value)} = {money(wd)}")
        if cover is None:
            reason += '; no usage, so all stock on hand is excess' if it['onHand'] > 0 else '; no usage and no stock'
        else:
            cv = dec(cover)
            reason += f"; cover {unit(cv, float(cv), 'month')} " + (f"is above {fmt(ecm)}, excess {unit(dec(exq), float(dec(exq)), 'unit')}" if excess else f'is at or below {fmt(ecm)}')
        out.append({'id': it['id'], 'band': b['label'], 'stockValue': fl(value), 'writeDownPct': b['writeDownPct'], 'writeDown': fl(wd),
                    'coverMonths': None if cover is None else fl(cover), 'excess': excess, 'excessQuantity': fl(exq), 'reason': reason,
                    '_v': value, '_w': wd})
    by_band = {b['label']: {'count': sum(1 for r in out if r['band'] == b['label']),
                            'stockValue': fl(sum((r['_v'] for r in out if r['band'] == b['label']), F(0))),
                            'writeDown': fl(sum((r['_w'] for r in out if r['band'] == b['label']), F(0)))} for b in bands}
    tv = sum((r['_v'] for r in out), F(0))
    tw = sum((r['_w'] for r in out), F(0))
    for r in out:
        r.pop('_v')
        r.pop('_w')
    return {'items': out, 'byBand': by_band, 'totalStockValue': fl(tv), 'totalWriteDown': fl(tw), 'excessCount': sum(1 for r in out if r['excess'])}


FNS = {'criticality': criticality, 'abcClassification': abc, 'eoq': eoq, 'quantityDiscount': quantity_discount, 'safetyStock': safety_stock,
       'poissonStock': poisson_stock, 'insuranceSpares': insurance_spares, 'leadTimeRisk': lead_time_risk, 'slowMoving': slow_moving}


def evaluate(fn, args):
    if not isobj(args):
        return refuse('options', 'must be an object of named inputs')
    e = check_keys(args, SHAPES[fn], '')
    return e or FNS[fn](args)


# ================================================================== cases
def build_cases():
    reg = json.load(open(FIX))
    pol = reg['policy']
    C = []

    def case(cid, fn, args, tol=1e-12, published=None, note=None):
        c = {'id': cid, 'fn': fn, 'args': args, 'tol': tol}
        if published:
            c['published'] = published
        if note:
            c['note'] = note
        C.append(c)

    def pub(source, fields=(), discrepancies=()):
        return {'source': source, 'fields': [dict(zip(['path', 'printed', 'tolerance'], f)) for f in fields],
                'discrepancies': [dict(zip(['path', 'printed', 'note'], d)) for d in discrepancies]}

    # ---------------------------------------------------------- criticality
    crit_policy = {k: pol['criticality'][k] for k in ['criteria', 'scoreMax', 'classes', 'topClassOnMaxScore']}
    crit_items = [{'id': i['id'], 'name': i['name'], 'scores': i['scores']} for i in reg['items']]
    case('crit-ekene', 'criticality', dict(crit_policy, items=crit_items), note='the Ekene register: PSV-KIT forced to V by safety 5; MECH-SEAL exactly 70; GASKET-RJ exactly 44')
    base = {'criteria': [{'id': 's', 'weight': 50}, {'id': 'p', 'weight': 50}], 'scoreMax': 10,
            'classes': [{'label': 'V', 'minScore': 70}, {'label': 'E', 'minScore': 40}, {'label': 'D', 'minScore': 0}], 'topClassOnMaxScore': []}
    case('crit-at-cutoff-is-in', 'criticality', dict(base, items=[{'id': 'X', 'scores': {'s': 7, 'p': 7}}, {'id': 'Y', 'scores': {'s': 4, 'p': 4}}]))
    case('crit-just-below-cutoff', 'criticality', dict(base, items=[{'id': 'X', 'scores': {'s': 7, 'p': 6.99}}, {'id': 'Z', 'scores': {'s': 0, 'p': 0}}]))
    case('crit-override-forces-top', 'criticality', dict(base, topClassOnMaxScore=['s'], items=[{'id': 'X', 'scores': {'s': 10, 'p': 0}}]))
    case('crit-override-already-top', 'criticality', dict(base, topClassOnMaxScore=['s', 'p'], items=[{'id': 'X', 'scores': {'s': 10, 'p': 10}}]))
    case('crit-override-two-criteria', 'criticality', dict(base, topClassOnMaxScore=['s', 'p'], items=[{'id': 'X', 'scores': {'s': 10, 'p': 0}}, {'id': 'W', 'scores': {'s': 0, 'p': 10}}]))
    case('crit-override-one-below-max', 'criticality', dict(base, topClassOnMaxScore=['s'], items=[{'id': 'X', 'scores': {'s': 9, 'p': 0}}]),
         note='9 of 10 on the override criterion is below the maximum: the class comes from the score alone (45, E)')
    thirds = {'criteria': [{'id': 'a', 'weight': 33.3}, {'id': 'b', 'weight': 33.3}, {'id': 'c', 'weight': 33.4}], 'scoreMax': 10,
              'classes': [{'label': 'V', 'minScore': 70}, {'label': 'D', 'minScore': 0}], 'topClassOnMaxScore': []}
    case('crit-12-digit-key', 'criticality', dict(thirds, items=[{'id': 'T', 'scores': {'a': 7, 'b': 7, 'c': 7}}]),
         note='33.3 x 0.7 + 33.3 x 0.7 + 33.4 x 0.7 is 69.99999999999999 in doubles; at 12 significant digits it is 70, so class V')
    r = dict(base, items=[{'id': 'X', 'scores': {'s': 7, 'p': 7}}])
    case('crit-refuse-weights-sum', 'criticality', dict(r, criteria=[{'id': 's', 'weight': 50}, {'id': 'p', 'weight': 49}]))
    case('crit-refuse-weight-zero', 'criticality', dict(r, criteria=[{'id': 's', 'weight': 0}, {'id': 'p', 'weight': 100}]))
    case('crit-refuse-scoremax', 'criticality', dict(r, scoreMax=0))
    case('crit-refuse-one-class', 'criticality', dict(r, classes=[{'label': 'V', 'minScore': 0}]))
    case('crit-refuse-classes-order', 'criticality', dict(r, classes=[{'label': 'V', 'minScore': 40}, {'label': 'E', 'minScore': 70}, {'label': 'D', 'minScore': 0}]))
    case('crit-refuse-last-class-not-zero', 'criticality', dict(r, classes=[{'label': 'V', 'minScore': 70}, {'label': 'E', 'minScore': 40}]))
    case('crit-refuse-class-label-repeat', 'criticality', dict(r, classes=[{'label': 'V', 'minScore': 70}, {'label': 'V', 'minScore': 0}]))
    case('crit-refuse-override-unknown', 'criticality', dict(r, topClassOnMaxScore=['safety']))
    case('crit-refuse-override-missing', 'criticality', {k: v for k, v in r.items() if k != 'topClassOnMaxScore'})
    case('crit-refuse-score-above-max', 'criticality', dict(r, items=[{'id': 'X', 'scores': {'s': 11, 'p': 7}}]))
    case('crit-refuse-score-missing', 'criticality', dict(r, items=[{'id': 'X', 'scores': {'s': 7}}]))
    case('crit-refuse-score-unknown-key', 'criticality', dict(r, items=[{'id': 'X', 'scores': {'s': 7, 'p': 7, 'q': 1}}]))
    case('crit-refuse-item-id-repeat', 'criticality', dict(r, items=[{'id': 'X', 'scores': {'s': 7, 'p': 7}}, {'id': 'X', 'scores': {'s': 1, 'p': 1}}]))
    case('crit-refuse-nested-unknown-key', 'criticality', dict(r, criteria=[{'id': 's', 'wieght': 50}, {'id': 'p', 'weight': 50}]))

    # ---------------------------------------------------------- ABC
    abc_items = [{'id': i['id'], 'name': i['name'], 'annualUsage': i['annualUsage'], 'unitCost': i['unitCost']} for i in reg['items']]
    case('abc-ekene-at-or-below', 'abcClassification', {'items': abc_items, **pol['abc']}, note='CEM-G crosses 80%: class B under at-or-below')
    case('abc-ekene-include-crossing', 'abcClassification', {'items': abc_items, 'cutoffs': pol['abc']['cutoffs'], 'boundaryRule': 'include-crossing'},
         note='CEM-G crosses 80%: class A under include-crossing')
    exact = [{'id': 'P', 'annualUsage': 8, 'unitCost': 10}, {'id': 'Q', 'annualUsage': 1, 'unitCost': 15}, {'id': 'R', 'annualUsage': 1, 'unitCost': 5}]
    case('abc-cutoff-exact-at-or-below', 'abcClassification', {'items': exact, 'cutoffs': {'aPct': 80, 'bPct': 95}, 'boundaryRule': 'at-or-below'},
         note='P is exactly 80% (A); P+Q exactly 95% (Q is B)')
    case('abc-cutoff-exact-include-crossing', 'abcClassification', {'items': exact, 'cutoffs': {'aPct': 80, 'bPct': 95}, 'boundaryRule': 'include-crossing'},
         note='Q starts exactly at 80% (B); R starts exactly at 95% (C)')
    case('abc-ties-by-id', 'abcClassification', {'items': [{'id': 'b', 'annualUsage': 2, 'unitCost': 5}, {'id': 'a', 'annualUsage': 5, 'unitCost': 2},
                                                           {'id': 'c', 'annualUsage': 1, 'unitCost': 1}, {'id': 'z', 'annualUsage': 0, 'unitCost': 9}],
                                                 'cutoffs': {'aPct': 50, 'bPct': 90}, 'boundaryRule': 'at-or-below'})
    ra = {'items': exact, 'cutoffs': {'aPct': 80, 'bPct': 95}, 'boundaryRule': 'at-or-below'}
    case('abc-refuse-apct-zero', 'abcClassification', dict(ra, cutoffs={'aPct': 0, 'bPct': 95}))
    case('abc-refuse-bpct-not-above', 'abcClassification', dict(ra, cutoffs={'aPct': 80, 'bPct': 80}))
    case('abc-refuse-bpct-100', 'abcClassification', dict(ra, cutoffs={'aPct': 80, 'bPct': 100}))
    case('abc-refuse-cutoffs-missing', 'abcClassification', {'items': exact, 'boundaryRule': 'at-or-below'})
    case('abc-refuse-boundary-rule', 'abcClassification', dict(ra, boundaryRule='cumulative'))
    case('abc-refuse-no-value', 'abcClassification', dict(ra, items=[{'id': 'P', 'annualUsage': 0, 'unitCost': 10}]))
    case('abc-refuse-negative-usage', 'abcClassification', dict(ra, items=[{'id': 'P', 'annualUsage': -1, 'unitCost': 10}]))
    case('abc-refuse-unknown-key', 'abcClassification', dict(ra, cutoff={'aPct': 80}))

    # ---------------------------------------------------------- EOQ
    none = {'rule': 'none'}
    harris = 'Harris (1913) p. 136 (Operations Research 38(6) 1990 reprint p. 948): M 1,000 a month, S $2, C $0.10, 10% interest and depreciation; X = sqrt(240 M S / C)'
    case('harris-1913-example', 'eoq', {'annualDemand': 12000, 'orderCost': 2, 'unitCost': 0.1, 'holdingRate': 0.1, 'rounding': none},
         published=pub(harris, [('eoq', 2190, 1)]), note='Harris prints the lot as 2,190 (2190.89 truncated) and the Figure I caption as 2,200')
    case('harris-1913-connector', 'eoq', {'annualDemand': 14760, 'orderCost': 2.15, 'unitCost': 0.0135, 'holdingRate': 0.1, 'rounding': none},
         published=pub('Harris (1913) Figure II (reprint p. 949): M 1,230, C $0.0135, S $2.15', [('eoq', 6850, 10)]),
         note='Harris prints 6,850; the formula gives 6856.6')
    case('harris-1913-stud', 'eoq', {'annualDemand': 360, 'orderCost': 1.85, 'unitCost': 5.65, 'holdingRate': 0.1, 'rounding': none},
         published=pub('Harris (1913) Figure III (reprint p. 949): M 30, C $5.65, S $1.85', [('eoq', 48.5, 0.1)]),
         note='Harris prints 48.5, "or, say, 49"; the formula gives 48.55')
    case('harris-1913-stud-say-49', 'eoq', {'annualDemand': 360, 'orderCost': 1.85, 'unitCost': 5.65, 'holdingRate': 0.1, 'rounding': {'rule': 'nearest', 'multiple': 1}},
         published=pub('Harris (1913) p. 949: "The correct quantity is 48.5 or, say, 49"', [('quantity', 49, 0)]))
    caplice8 = 'Caplice, MIT ESD.260J lecture 8 slide 9: A $500, D 2,000 a year, r 0.25, v $50'
    case('caplice-l8-eoq', 'eoq', {'annualDemand': 2000, 'orderCost': 500, 'unitCost': 50, 'holdingRate': 0.25, 'rounding': {'rule': 'nearest', 'multiple': 1}},
         published=pub(caplice8, [('quantity', 400, 0), ('orderingCost', 2500, 0), ('holdingCost', 2500, 0), ('relevantCost', 5000, 0)]))
    e = reg['cases']['eoq']
    case('eoq-ekene-baryte', 'eoq', {k: e[k] for k in ['annualDemand', 'orderCost', 'unitCost', 'holdingRate', 'rounding']})
    case('eoq-holding-direct', 'eoq', {'annualDemand': 1200, 'orderCost': 75, 'holdingCostPerUnitYear': 4.5, 'rounding': {'rule': 'down', 'multiple': 25}})
    case('eoq-holding-direct-with-price', 'eoq', {'annualDemand': 1200, 'orderCost': 75, 'holdingCostPerUnitYear': 4.5, 'unitCost': 30, 'rounding': none})
    case('eoq-exact-multiple-kept', 'eoq', {'annualDemand': 125, 'orderCost': 8, 'holdingCostPerUnitYear': 5, 'rounding': {'rule': 'up', 'multiple': 4}},
         note='EOQ = sqrt(400) = 20 = 5 x 4 exactly: rounding up keeps it')
    case('eoq-nearest-rounds-up', 'eoq', {'annualDemand': 1250, 'orderCost': 2, 'holdingCostPerUnitYear': 20, 'rounding': {'rule': 'nearest', 'multiple': 10}},
         note='EOQ = sqrt(250) = 15.811; 1.5811 multiples of 10 is nearest 2, so 20')
    case('eoq-q-exactly-half-of-multiple', 'eoq', {'annualDemand': 50, 'orderCost': 25, 'holdingCostPerUnitYear': 1, 'rounding': {'rule': 'nearest', 'multiple': 100}},
         note='EOQ = sqrt(2500) = 50, exactly half of 100: halves go upward, so 100')
    case('eoq-up-rounding-penalty', 'eoq', {'annualDemand': 2000, 'orderCost': 500, 'unitCost': 50, 'holdingRate': 0.25, 'rounding': {'rule': 'up', 'multiple': 250}})
    re_ = {'annualDemand': 2000, 'orderCost': 500, 'unitCost': 50, 'holdingRate': 0.25, 'rounding': none}
    case('eoq-refuse-demand-zero', 'eoq', dict(re_, annualDemand=0))
    case('eoq-refuse-order-cost-negative', 'eoq', dict(re_, orderCost=-5))
    case('eoq-refuse-both-holding', 'eoq', dict(re_, holdingCostPerUnitYear=12.5))
    case('eoq-refuse-no-holding', 'eoq', {k: v for k, v in re_.items() if k not in ('holdingRate',)})
    case('eoq-refuse-rate-without-price', 'eoq', {k: v for k, v in re_.items() if k != 'unitCost'})
    case('eoq-refuse-rounding-missing', 'eoq', {k: v for k, v in re_.items() if k != 'rounding'})
    case('eoq-refuse-rounding-rule', 'eoq', dict(re_, rounding={'rule': 'ceiling', 'multiple': 1}))
    case('eoq-refuse-rounding-multiple-zero', 'eoq', dict(re_, rounding={'rule': 'up', 'multiple': 0}))
    case('eoq-refuse-none-with-multiple', 'eoq', dict(re_, rounding={'rule': 'none', 'multiple': 10}))
    case('eoq-refuse-rounds-to-zero', 'eoq', dict(re_, rounding={'rule': 'down', 'multiple': 1000}))
    case('eoq-refuse-unknown-key', 'eoq', dict(re_, holdingrate=0.25))

    # ---------------------------------------------------------- quantity discounts
    inc = 'Caplice, MIT ESD.260J lecture 8 slide 15: D 2,000, r 0.25, A $500, v0 $50; 10% off 500 to below 1,000, 20% off 1,000 or more (incremental)'
    sched = [{'minQuantity': 0, 'unitPrice': 50}, {'minQuantity': 500, 'unitPrice': 45}, {'minQuantity': 1000, 'unitPrice': 40}]
    case('caplice-l8-incremental', 'quantityDiscount', {'annualDemand': 2000, 'orderCost': 500, 'holdingRate': 0.25, 'breaks': sched, 'discountType': 'incremental',
                                                        'rounding': {'rule': 'nearest', 'multiple': 1}},
         published=pub(inc, [('candidates[2].fixedCost', 7500, 0), ('candidates[1].fixedCost', 2500, 0), ('candidates[2].eoq', 1789, 0.5), ('candidates[1].eoq', 1033, 0.5),
                             ('candidates[0].eoq', 400, 0), ('candidates[2].effectiveUnitPrice', 44.19, 0.005), ('candidates[2].purchaseCost', 88384, 1),
                             ('candidates[2].orderingCost', 559, 0.5), ('candidates[2].holdingCost', 9882, 1), ('candidates[2].totalCost', 98825, 1.5),
                             ('candidates[0].totalCost', 105000, 0), ('quantity', 1789, 0)]),
         note='the slide rounds each line; its 98,825 is 1.04 below the engine total at 1,789 because it sums the rounded 44.19')
    case('caplice-l8-incremental-unrounded', 'quantityDiscount', {'annualDemand': 2000, 'orderCost': 500, 'holdingRate': 0.25, 'breaks': sched, 'discountType': 'incremental', 'rounding': none})
    case('caplice-l8-all-units-2pct', 'quantityDiscount', {'annualDemand': 2000, 'orderCost': 500, 'holdingRate': 0.25,
                                                           'breaks': [{'minQuantity': 0, 'unitPrice': 50}, {'minQuantity': 500, 'unitPrice': 49}], 'discountType': 'all-units',
                                                           'rounding': {'rule': 'nearest', 'multiple': 1}},
         note='Caplice lecture 8 slide 12 states the data (2% off at 500) without printing an answer: the oracle computes 500 at 103,062.50 against 400 at 105,000')
    case('caplice-l8-schedule-all-units', 'quantityDiscount', {'annualDemand': 2000, 'orderCost': 500, 'holdingRate': 0.25, 'breaks': sched, 'discountType': 'all-units',
                                                               'rounding': {'rule': 'nearest', 'multiple': 1}},
         note='the same schedule read as all-units: 1,000 at 40 wins')
    qd = reg['cases']['quantityDiscount']
    case('qd-ekene-casing', 'quantityDiscount', {k: qd[k] for k in ['annualDemand', 'orderCost', 'holdingRate', 'breaks', 'discountType', 'rounding']})
    case('qd-ekene-casing-incremental', 'quantityDiscount', dict({k: qd[k] for k in ['annualDemand', 'orderCost', 'holdingRate', 'breaks', 'rounding']}, discountType='incremental'))
    case('qd-eoq-in-top-band', 'quantityDiscount', {'annualDemand': 50000, 'orderCost': 400, 'holdingRate': 0.2,
                                                    'breaks': [{'minQuantity': 0, 'unitPrice': 10}, {'minQuantity': 1000, 'unitPrice': 9.5}], 'discountType': 'all-units',
                                                    'rounding': {'rule': 'up', 'multiple': 100}})
    case('qd-single-band', 'quantityDiscount', {'annualDemand': 2000, 'orderCost': 500, 'holdingRate': 0.25, 'breaks': [{'minQuantity': 0, 'unitPrice': 50}],
                                                'discountType': 'all-units', 'rounding': none})
    case('qd-tie-takes-smaller', 'quantityDiscount', {'annualDemand': 100, 'orderCost': 50, 'holdingRate': 1,
                                                      'breaks': [{'minQuantity': 0, 'unitPrice': 1}, {'minQuantity': 200, 'unitPrice': 0.75}], 'discountType': 'all-units',
                                                      'rounding': none},
         note='band 0: EOQ 100 at 100 + 50 + 50 = 200; band 1: the break 200 at 75 + 25 + 75 = 175, so no tie; see qd-tie-exact')
    case('qd-tie-exact', 'quantityDiscount', {'annualDemand': 100, 'orderCost': 50, 'holdingRate': 1,
                                              'breaks': [{'minQuantity': 0, 'unitPrice': 1}, {'minQuantity': 200, 'unitPrice': 0.875}], 'discountType': 'all-units',
                                              'rounding': none},
         note='band 0 costs 200; band 1 at the break 200 costs 87.5 + 25 + 87.5 = 200: tied, so the smaller quantity (100) is taken')
    rq = {'annualDemand': 2000, 'orderCost': 500, 'holdingRate': 0.25, 'breaks': sched, 'discountType': 'all-units', 'rounding': {'rule': 'nearest', 'multiple': 1}}
    case('qd-refuse-first-break', 'quantityDiscount', dict(rq, breaks=[{'minQuantity': 10, 'unitPrice': 50}]))
    case('qd-refuse-break-order', 'quantityDiscount', dict(rq, breaks=[{'minQuantity': 0, 'unitPrice': 50}, {'minQuantity': 500, 'unitPrice': 45}, {'minQuantity': 500, 'unitPrice': 40}]))
    case('qd-refuse-price-rises', 'quantityDiscount', dict(rq, breaks=[{'minQuantity': 0, 'unitPrice': 50}, {'minQuantity': 500, 'unitPrice': 50}]))
    case('qd-refuse-type', 'quantityDiscount', dict(rq, discountType='volume'))
    case('qd-refuse-break-not-multiple', 'quantityDiscount', dict(rq, rounding={'rule': 'up', 'multiple': 300}))
    case('qd-refuse-breaks-empty', 'quantityDiscount', dict(rq, breaks=[]))
    case('qd-refuse-holding-rate', 'quantityDiscount', dict(rq, holdingRate=0))
    case('qd-refuse-unknown-key', 'quantityDiscount', dict(rq, breaks=[{'minQuantity': 0, 'price': 50}]))

    # ---------------------------------------------------------- safety stock
    c11 = 'Caplice, MIT ESD.260J lecture 11 slides 18 to 24: D 13,000 a year ~ Normal, L 2 weeks, RMSE 1,316 a year, EOQ 228; slide 24 prints the safety stocks'
    wk = {'demandMean': 13000 / 52, 'demandSd': 1316 / math.sqrt(52), 'leadTime': 2, 'leadTimeSd': 0, 'reviewPeriod': 0}
    for lvl, ss in [(0.99, 601), (0.95, 423), (0.9, 330), (0.8, 217)]:
        case(f'caplice-l11-csl-{int(round(lvl * 100))}', 'safetyStock',
             dict(wk, serviceMeasure='cycle-service', serviceLevel=lvl, orderQuantity=228, safetyFactorRounding={'rule': 'nearest', 'decimals': 2},
                  minimumSafetyFactor=None, rounding={'rule': 'nearest', 'multiple': 1}),
             published=pub(c11 + ' (CSL column; k read from the table to 2 decimals)', [('levelRounded', 500 + ss, 0), ('sigma', 258, 0.5), ('demandOverProtection', 500, 1e-9)]))
        case(f'caplice-l11-csl-{int(round(lvl * 100))}-exact', 'safetyStock',
             dict(wk, serviceMeasure='cycle-service', serviceLevel=lvl, orderQuantity=228, safetyFactorRounding={'rule': 'none'}, minimumSafetyFactor=None, rounding=none), tol=1e-11)
    for lvl, ss, ok in [(0.99, 513, True), (0.95, 348, False), (0.9, 252, True), (0.8, 148, True)]:
        p = pub(c11 + ' (IFR column)', [('safetyStock', ss, 2)] if ok else [],
                [] if ok else [('safetyStock', ss, 'the slide prints 348; the fill-rate rule gives 339.18 (k 1.3142); the other three IFR figures agree within 2 units')])
        case(f'caplice-l11-ifr-{int(round(lvl * 100))}', 'safetyStock',
             dict(wk, serviceMeasure='fill-rate', serviceLevel=lvl, orderQuantity=228, safetyFactorRounding={'rule': 'none'}, minimumSafetyFactor=None, rounding=none),
             tol=1e-10, published=p)
    case('caplice-l12-periodic-rs', 'safetyStock',
         {'demandMean': 13000 / 52, 'demandSd': 1316 / math.sqrt(52), 'leadTime': 2, 'leadTimeSd': 0, 'reviewPeriod': 8, 'serviceMeasure': 'fill-rate',
          'serviceLevel': 0.95, 'orderQuantity': 2000, 'safetyFactorRounding': {'rule': 'nearest', 'decimals': 2}, 'minimumSafetyFactor': None,
          'rounding': {'rule': 'nearest', 'multiple': 1}}, tol=1e-10,
         published=pub('Caplice, MIT ESD.260J lecture 12 slide 6: (R, S) with R 8 weeks, IFR 0.95; Q = D R = 2,000, xR+L 2,500, sigmaR+L 577, G(k) 0.1733, k 0.58, S 2,835',
                       [('sigma', 577, 0.5), ('demandOverProtection', 2500, 1e-9), ('safetyFactor', 0.58, 0), ('levelRounded', 2835, 0)]))
    ss = reg['cases']['safetyStock']
    case('ss-ekene-choke-beans', 'safetyStock', {k: ss[k] for k in ['demandMean', 'demandSd', 'leadTime', 'leadTimeSd', 'reviewPeriod', 'serviceMeasure', 'serviceLevel',
                                                                     'orderQuantity', 'safetyFactorRounding', 'minimumSafetyFactor', 'rounding']}, tol=1e-11)
    case('ss-ekene-choke-beans-fill', 'safetyStock', dict({k: ss[k] for k in ['demandMean', 'demandSd', 'leadTime', 'leadTimeSd', 'reviewPeriod', 'orderQuantity',
                                                                              'safetyFactorRounding', 'minimumSafetyFactor', 'rounding']},
                                                          serviceMeasure='fill-rate', serviceLevel=0.98), tol=1e-10)
    case('ss-floor-at-zero', 'safetyStock', dict(wk, serviceMeasure='cycle-service', serviceLevel=0.4, safetyFactorRounding={'rule': 'none'}, minimumSafetyFactor=0,
                                                 rounding={'rule': 'up', 'multiple': 1}), tol=1e-11,
         note='CSL 0.4 gives k = -0.2533; the stated floor 0 holds k at 0')
    case('ss-negative-k-without-floor', 'safetyStock', dict(wk, serviceMeasure='cycle-service', serviceLevel=0.4, safetyFactorRounding={'rule': 'none'},
                                                            minimumSafetyFactor=None, rounding=none), tol=1e-11)
    case('ss-certain-demand', 'safetyStock', {'demandMean': 10, 'demandSd': 0, 'leadTime': 3, 'leadTimeSd': 0, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service',
                                              'serviceLevel': 0.95, 'safetyFactorRounding': {'rule': 'none'}, 'minimumSafetyFactor': None, 'rounding': none})
    case('ss-lead-time-variance-only', 'safetyStock', {'demandMean': 20, 'demandSd': 0, 'leadTime': 5, 'leadTimeSd': 1.5, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service',
                                                       'serviceLevel': 0.9, 'safetyFactorRounding': {'rule': 'nearest', 'decimals': 0}, 'minimumSafetyFactor': None,
                                                       'rounding': {'rule': 'up', 'multiple': 5}}, tol=1e-11,
         note='sigma = 20 x 1.5 = 30; k 1.2816 read to 0 decimals is 1')
    rs = dict(wk, serviceMeasure='cycle-service', serviceLevel=0.95, safetyFactorRounding={'rule': 'none'}, minimumSafetyFactor=None, rounding=none)
    case('ss-refuse-level-one', 'safetyStock', dict(rs, serviceLevel=1))
    case('ss-refuse-level-zero', 'safetyStock', dict(rs, serviceLevel=0))
    case('ss-refuse-measure', 'safetyStock', dict(rs, serviceMeasure='service'))
    case('ss-refuse-fill-without-q', 'safetyStock', dict(rs, serviceMeasure='fill-rate'))
    case('ss-refuse-fill-certain-demand', 'safetyStock', dict(rs, demandSd=0, serviceMeasure='fill-rate', orderQuantity=100))
    case('ss-refuse-factor-rounding', 'safetyStock', dict(rs, safetyFactorRounding={'rule': 'up', 'decimals': 2}))
    case('ss-refuse-decimals-7', 'safetyStock', dict(rs, safetyFactorRounding={'rule': 'nearest', 'decimals': 7}))
    case('ss-refuse-none-with-decimals', 'safetyStock', dict(rs, safetyFactorRounding={'rule': 'none', 'decimals': 2}))
    case('ss-refuse-minimum-missing', 'safetyStock', {k: v for k, v in rs.items() if k != 'minimumSafetyFactor'})
    case('ss-refuse-protection-zero', 'safetyStock', dict(rs, leadTime=0))
    case('ss-refuse-negative-sd', 'safetyStock', dict(rs, demandSd=-1))
    case('ss-refuse-q-zero', 'safetyStock', dict(rs, orderQuantity=0))
    case('ss-refuse-unknown-key', 'safetyStock', dict(rs, zFactor=1.65))

    # ---------------------------------------------------------- Poisson stock
    mil = 'MIL-HDBK-338B (1 Oct 1998) section 5.3.8.1, p. 5-27: lamp failure rate 0.001 an hour, 500 hours, two spares: R(500) = 0.986'
    case('mil-hdbk-338b-lamps', 'poissonStock', {'demandRate': 0.001, 'leadTime': 500, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.98},
         tol=1e-11, published=pub(mil, [('rows[2].cumulative', 0.986, 0.0005), ('level', 2, 0), ('mean', 0.5, 1e-15)]))
    c13 = 'Caplice, MIT ESD.260J lecture 13 slides 11 and 12: demand ~ Poisson(0.8) a week, (R, S) with R 1 week, IFR 0.90; E[US] 0.08; S = 2'
    case('caplice-l13-poisson-fill', 'poissonStock', {'demandRate': 0.8, 'leadTime': 0, 'reviewPeriod': 1, 'serviceMeasure': 'fill-rate', 'serviceLevel': 0.9, 'orderQuantity': 0.8},
         tol=1e-11, published=pub(c13, [('level', 2, 0), ('rows[0].probability', 0.449, 0.0005), ('rows[1].probability', 0.359, 0.0005), ('rows[2].probability', 0.144, 0.0005),
                                          ('rows[1].cumulative', 0.809, 0.0005), ('rows[2].cumulative', 0.953, 0.0005),
                                          ('rows[0].expectedShort', 0.80, 0.005), ('rows[1].expectedShort', 0.25, 0.005), ('rows[2].expectedShort', 0.06, 0.005)]))
    case('caplice-l13-poisson-table', 'poissonStock', {'demandRate': 0.8, 'leadTime': 0, 'reviewPeriod': 1, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.995},
         tol=1e-11, published=pub(c13 + ' (the loss table to x = 4)', [('rows[3].cumulative', 0.991, 0.0005), ('rows[4].cumulative', 0.999, 0.0005), ('rows[3].expectedShort', 0.01, 0.005)],
                                  [('rows[4].expectedShort', 0.009, 'the slide prints L(4) = 0.009 (and 0.0088, 0.00878 below it); the recursion it states gives 0.0017, so the printed tail is a slip')]))
    pc = reg['cases']['poissonStock']
    case('ps-ekene-psv-kits', 'poissonStock', {k: pc[k] for k in ['demandRate', 'leadTime', 'reviewPeriod', 'serviceMeasure', 'serviceLevel']}, tol=1e-11)
    f1 = float(2 * Decimal(-1).exp())   # P(X <= 1) for mean 1, as the nearest double
    case('ps-level-exactly-met', 'poissonStock', {'demandRate': 1, 'leadTime': 1, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': f1}, tol=1e-11,
         note='the service level is P(X <= 1) itself: at or above, so level 1')
    case('ps-level-just-above', 'poissonStock', {'demandRate': 1, 'leadTime': 1, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.7358}, tol=1e-11)
    case('ps-level-zero', 'poissonStock', {'demandRate': 0.05, 'leadTime': 1, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.9}, tol=1e-11)
    case('ps-fill-with-review', 'poissonStock', {'demandRate': 1.5, 'leadTime': 2, 'reviewPeriod': 1, 'serviceMeasure': 'fill-rate', 'serviceLevel': 0.95, 'orderQuantity': 1.5}, tol=1e-10)
    case('ps-mean-at-cap', 'poissonStock', {'demandRate': 5, 'leadTime': 100, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.5}, tol=1e-9,
         note='mean exactly 500, the cap: accepted')
    case('ps-refuse-mean-above-cap', 'poissonStock', {'demandRate': 5, 'leadTime': 100.5, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.5})
    case('ps-refuse-mean-inexact-bound', 'poissonStock', {'demandRate': 3, 'leadTime': 170, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.5},
         note='500 / 3 = 166.666...: the printed bound is rounded down to 166.666666 so that it is accepted')
    case('ps-printed-bound-accepted', 'poissonStock', {'demandRate': 3, 'leadTime': 166.666666, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.5}, tol=1e-9)
    case('ps-refuse-mean-with-review', 'poissonStock', {'demandRate': 2, 'leadTime': 240, 'reviewPeriod': 20.5, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.5})
    rp = {'demandRate': 0.5, 'leadTime': 4, 'reviewPeriod': 0, 'serviceMeasure': 'cycle-service', 'serviceLevel': 0.95}
    case('ps-refuse-rate-zero', 'poissonStock', dict(rp, demandRate=0))
    case('ps-refuse-protection-zero', 'poissonStock', dict(rp, leadTime=0))
    case('ps-refuse-measure', 'poissonStock', dict(rp, serviceMeasure='availability'))
    case('ps-refuse-level', 'poissonStock', dict(rp, serviceLevel=1.2))
    case('ps-refuse-fill-without-q', 'poissonStock', dict(rp, serviceMeasure='fill-rate'))
    case('ps-refuse-unknown-key', 'poissonStock', dict(rp, lambda_=0.5))

    # ---------------------------------------------------------- insurance spares
    ins = reg['cases']['insuranceSpares']
    ia = {k: ins[k] for k in ['failuresPerYear', 'leadTimeDays', 'daysPerYear', 'unitCost', 'holdingRate', 'downtimeCostPerDay', 'maxSpares']}
    case('ins-ekene-esp-motor', 'insuranceSpares', ia, tol=1e-9)
    case('ins-mil-hdbk-mean', 'insuranceSpares', {'failuresPerYear': 0.365, 'leadTimeDays': 500, 'daysPerYear': 365, 'unitCost': 40, 'holdingRate': 0.25,
                                                  'downtimeCostPerDay': 2, 'maxSpares': 3}, tol=1e-9,
         published=pub(mil + ' (the same Poisson mean 0.5 as orders outstanding)', [('options[2].probabilityNoShortage', 0.986, 0.0005)]))
    case('ins-cheap-downtime-holds-none', 'insuranceSpares', dict(ia, downtimeCostPerDay=100), tol=1e-9)
    case('ins-search-limit', 'insuranceSpares', dict(ia, maxSpares=1), tol=1e-9)
    case('ins-max-zero', 'insuranceSpares', dict(ia, maxSpares=0), tol=1e-9)
    case('ins-free-holding', 'insuranceSpares', dict(ia, holdingRate=0, maxSpares=3), tol=1e-9,
         note='no holding cost: every spare lowers the cost, so the search limit is reached')
    tie_cost = float((1 - Decimal(-1).exp()) * 365000)
    case('ins-tie-takes-fewer', 'insuranceSpares', {'failuresPerYear': 365, 'leadTimeDays': 1, 'daysPerYear': 365, 'unitCost': tie_cost, 'holdingRate': 1,
                                                    'downtimeCostPerDay': 1000, 'maxSpares': 2}, tol=1e-9,
         note='mean 1: the first spare costs (1 - exp(-1)) x 365,000 a year, exactly the downtime it saves; tied at 12 digits, so the fewer spares (0)')
    case('ins-refuse-failures-zero', 'insuranceSpares', dict(ia, failuresPerYear=0))
    case('ins-refuse-lead-time-zero', 'insuranceSpares', dict(ia, leadTimeDays=0))
    case('ins-refuse-days-missing', 'insuranceSpares', {k: v for k, v in ia.items() if k != 'daysPerYear'})
    case('ins-refuse-max-fraction', 'insuranceSpares', dict(ia, maxSpares=1.5))
    case('ins-refuse-max-cap', 'insuranceSpares', dict(ia, maxSpares=1001))
    case('ins-refuse-negative-downtime', 'insuranceSpares', dict(ia, downtimeCostPerDay=-1))
    case('ins-refuse-mean-cap', 'insuranceSpares', dict(ia, failuresPerYear=700, leadTimeDays=365))
    case('ins-refuse-unknown-key', 'insuranceSpares', dict(ia, holdingCost=1))

    # ---------------------------------------------------------- lead-time risk
    lr = reg['cases']['leadTimeRisk']
    la = {k: lr[k] for k in ['demandPerDay', 'leadTimeDays', 'reorderPoint', 'serviceLevel', 'iterations', 'seed']}
    case('ltr-ekene-mech-seal', 'leadTimeRisk', la, tol=1e-9)
    case('ltr-no-service-level', 'leadTimeRisk', {k: v for k, v in la.items() if k != 'serviceLevel'}, tol=1e-9)
    case('ltr-constant-demand-equal-to-stock', 'leadTimeRisk', {'demandPerDay': 2, 'leadTimeDays': 10, 'reorderPoint': 20, 'iterations': 50, 'seed': 1},
         note='demand equal to the stock is met: no stockout')
    case('ltr-constant-demand-above-stock', 'leadTimeRisk', {'demandPerDay': 2, 'leadTimeDays': 10, 'reorderPoint': 19.5, 'iterations': 50, 'seed': 1})
    case('ltr-lead-time-only', 'leadTimeRisk', {'demandPerDay': 1.5, 'leadTimeDays': {'min': 20, 'mode': 30, 'max': 50}, 'reorderPoint': 50, 'serviceLevel': 0.9,
                                                'iterations': 5000, 'seed': 42}, tol=1e-9)
    case('ltr-one-iteration', 'leadTimeRisk', {'demandPerDay': {'min': 1, 'mode': 2, 'max': 4}, 'leadTimeDays': {'min': 5, 'mode': 10, 'max': 20}, 'reorderPoint': 20,
                                               'serviceLevel': 0.5, 'iterations': 1, 'seed': 0}, tol=1e-9)
    case('ltr-other-seed', 'leadTimeRisk', dict(la, seed=lr['seed'] + 1, iterations=2000), tol=1e-9)
    case('ltr-refuse-iterations-zero', 'leadTimeRisk', dict(la, iterations=0))
    case('ltr-refuse-iterations-cap', 'leadTimeRisk', dict(la, iterations=200001))
    case('ltr-refuse-seed-missing', 'leadTimeRisk', {k: v for k, v in la.items() if k != 'seed'})
    case('ltr-refuse-seed-negative', 'leadTimeRisk', dict(la, seed=-1))
    case('ltr-refuse-tri-order', 'leadTimeRisk', dict(la, leadTimeDays={'min': 90, 'mode': 70, 'max': 160}))
    case('ltr-refuse-tri-negative', 'leadTimeRisk', dict(la, demandPerDay={'min': -0.01, 'mode': 0.016, 'max': 0.03}))
    case('ltr-refuse-reorder-negative', 'leadTimeRisk', dict(la, reorderPoint=-1))
    case('ltr-refuse-service-level', 'leadTimeRisk', dict(la, serviceLevel=1))
    case('ltr-refuse-tri-unknown-key', 'leadTimeRisk', dict(la, leadTimeDays={'min': 70, 'mod': 90, 'max': 160}))

    # ---------------------------------------------------------- slow-moving
    sm_items = [{k: i[k] for k in ['id', 'name', 'onHand', 'unitCost', 'monthsSinceLastIssue', 'monthlyUsage']} for i in reg['items']]
    case('sm-ekene', 'slowMoving', {'items': sm_items, **pol['slowMoving']})
    bands = pol['slowMoving']['bands']
    case('sm-boundaries', 'slowMoving', {'items': [
        {'id': 'AT12', 'onHand': 10, 'unitCost': 100, 'monthsSinceLastIssue': 12, 'monthlyUsage': 1},
        {'id': 'BELOW12', 'onHand': 10, 'unitCost': 100, 'monthsSinceLastIssue': 11.99, 'monthlyUsage': 0.5},
        {'id': 'COVER24', 'onHand': 24, 'unitCost': 10, 'monthsSinceLastIssue': 1, 'monthlyUsage': 1},
        {'id': 'COVER25', 'onHand': 25, 'unitCost': 10, 'monthsSinceLastIssue': 0, 'monthlyUsage': 1},
        {'id': 'EMPTY', 'onHand': 0, 'unitCost': 10, 'monthsSinceLastIssue': 50, 'monthlyUsage': 0},
        {'id': 'ONEUNIT', 'onHand': 13, 'unitCost': 7.5, 'monthsSinceLastIssue': 36, 'monthlyUsage': 0.5},
    ], 'bands': bands, 'excessCoverMonths': 24},
        note='12 months is band slow (at or above); cover exactly 24 is inside the limit; 25 is one unit excess and one month of cover over')
    rsm = {'items': [{'id': 'A', 'onHand': 1, 'unitCost': 1, 'monthsSinceLastIssue': 1, 'monthlyUsage': 1}], 'bands': bands, 'excessCoverMonths': 24}
    case('sm-refuse-bands-empty', 'slowMoving', dict(rsm, bands=[]))
    case('sm-refuse-first-band', 'slowMoving', dict(rsm, bands=[{'label': 'slow', 'minMonths': 6, 'writeDownPct': 10}]))
    case('sm-refuse-band-order', 'slowMoving', dict(rsm, bands=[{'label': 'a', 'minMonths': 0, 'writeDownPct': 0}, {'label': 'b', 'minMonths': 24, 'writeDownPct': 50},
                                                                {'label': 'c', 'minMonths': 12, 'writeDownPct': 25}]))
    case('sm-refuse-write-down', 'slowMoving', dict(rsm, bands=[{'label': 'a', 'minMonths': 0, 'writeDownPct': 101}]))
    case('sm-refuse-label-repeat', 'slowMoving', dict(rsm, bands=[{'label': 'a', 'minMonths': 0, 'writeDownPct': 0}, {'label': 'a', 'minMonths': 12, 'writeDownPct': 10}]))
    case('sm-refuse-cover-zero', 'slowMoving', dict(rsm, excessCoverMonths=0))
    case('sm-refuse-negative-stock', 'slowMoving', dict(rsm, items=[{'id': 'A', 'onHand': -1, 'unitCost': 1, 'monthsSinceLastIssue': 1, 'monthlyUsage': 1}]))
    case('sm-refuse-months-missing', 'slowMoving', dict(rsm, items=[{'id': 'A', 'onHand': 1, 'unitCost': 1, 'monthlyUsage': 1}]))
    case('sm-refuse-unknown-key', 'slowMoving', dict(rsm, items=[{'id': 'A', 'onHand': 1, 'unitCost': 1, 'monthsSinceLastIssue': 1, 'monthlyUsage': 1, 'lastIssue': '2026-01-01'}]))
    return C


def main():
    cases = build_cases()
    out = []
    for c in cases:
        try:
            exp = evaluate(c['fn'], c['args'])
        except OracleStop as ex:
            sys.stderr.write(f"STOP {c['id']}: {ex}\n")
            sys.exit(2)
        c = dict(c)
        c['expected'] = exp
        out.append(c)
    ids = [c['id'] for c in out]
    if len(set(ids)) != len(ids):
        sys.stderr.write('STOP duplicate case ids\n')
        sys.exit(2)
    doc = {'module': 'inventory', 'generatedBy': 'tools/validation/supplychain/oracle_inventory.py', 'engine': 'engines/supplychain/inventory.js',
           'tolerance': {'absoluteFloor': 1e-9, 'note': 'relative tol per case (1e-12 exact rules; 1e-11 to 1e-9 where the engine goes through its normal, Poisson or Monte Carlo numerics); absolute floor 1e-9'},
           'cases': out}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    n_ref = sum(1 for c in out if c['expected'].get('error') is True)
    print(f'{len(out)} cases ({n_ref} refusals) -> {os.path.relpath(OUT, ROOT)}')


if __name__ == '__main__':
    main()
